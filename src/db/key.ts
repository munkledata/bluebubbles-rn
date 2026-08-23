import * as Crypto from 'expo-crypto';
import type { SecureVault } from '@core/secure';
import { withDbWriteLock } from './transaction';

const KEY_BYTES = 32;
// MUST match database.ts DB_NAME (kept here so this module never imports the op-sqlite
// top-level handle — it would break the pure-Node test path).
const DB_NAME = 'gator.db';

/** Minimal raw-DB surface the rotation needs (the open op-sqlite handle). */
interface RawExec {
  execute(sql: string): Promise<unknown>;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Get the SQLCipher key from the secure vault, generating a fresh 256-bit random
 * key on first run. The key never leaves the Keystore-backed vault; losing it
 * means the encrypted DB is unrecoverable (a full re-sync repopulates it).
 */
export async function getOrCreateDbKey(vault: SecureVault): Promise<string> {
  const existing = await vault.get('dbEncryptionKey');
  if (existing) return existing;
  const key = toHex(Crypto.getRandomBytes(KEY_BYTES));
  await vault.set('dbEncryptionKey', key);
  return key;
}

/** True if `key` actually opens the encrypted DB (SQLCipher rejects a wrong key on read). */
async function keyOpensDb(key: string): Promise<boolean> {
  const { open } = await import('@op-engineering/op-sqlite');
  let db: ReturnType<typeof open>;
  try {
    db = open({ name: DB_NAME, encryptionKey: key });
  } catch {
    return false;
  }
  try {
    await db.execute('SELECT count(*) FROM sqlite_master'); // throws on the wrong key
    return true;
  } catch {
    return false;
  } finally {
    // SQLCipher validates the key on the first read, not necessarily on open(). Close both the
    // readable and wrong-key handles before resolveDbKey can open the selected key for real.
    db.close();
  }
}

/**
 * Resolve the DB key, FINISHING an interrupted key rotation if one was staged (the only
 * time `dbEncryptionKeyPending` exists). A crash mid-rotation leaves the DB encrypted
 * with EITHER the old key (rekey hadn't run) or the staged key (rekey ran, promote
 * didn't); we probe to find out, complete the swap, and return the key that opens it.
 * `probe` is injected for testing (default opens the real DB).
 */
export async function resolveDbKey(
  vault: SecureVault,
  probe: (key: string) => Promise<boolean> = keyOpensDb,
): Promise<string> {
  const pending = await vault.get('dbEncryptionKeyPending');
  if (!pending) return getOrCreateDbKey(vault);

  const primary = await vault.get('dbEncryptionKey');
  if (primary && (await probe(primary))) {
    // Rekey never completed — the DB is still on the primary key. Discard the staged key.
    await vault.delete('dbEncryptionKeyPending');
    return primary;
  }
  if (await probe(pending)) {
    // The DB was rekeyed to the staged key but the promote was interrupted. Promote it now.
    await vault.set('dbEncryptionKey', pending);
    await vault.delete('dbEncryptionKeyPending');
    return pending;
  }
  // A probe can fail for reasons other than a wrong key (for example, a native I/O or lock error).
  // Keep both recovery candidates intact until a later boot can prove which key owns the file.
  throw new Error('Neither stored encryption key could open the database');
}

/**
 * CRASH-SAFE SQLCipher key rotation on the OPEN connection: stage a fresh key, rekey the
 * DB, promote the staged key, then clear staging. A crash at any step is recoverable by
 * `resolveDbKey` on the next boot (the DB is never left with no matching stored key).
 * The open `dbInstance` keeps working — rekey updates the running connection.
 *
 * Step 2 runs under the SAME write lock every `withDbTransaction` caller queues on, because the
 * rotation is offered from Settings while the app is live: a sync slice, a live socket/FCM message
 * or an optimistic send can have a transaction open on this one shared connection at that instant.
 * SQLCipher rekeys inside its own implicit transaction, so an uncoordinated PRAGMA either fails
 * outright (the user just sees "Couldn't rotate the key", intermittently and unexplainably) or —
 * the outcome that actually destroys data — commits as a bystander inside the neighbour's
 * transaction and is undone by ITS rollback, while steps 3 and 4 below still promote the new key
 * and delete the staged one. `resolveDbKey` would then have no key that opens the file.
 */
export async function rotateDbKey(vault: SecureVault, rawDb: RawExec): Promise<void> {
  const newKey = toHex(Crypto.getRandomBytes(KEY_BYTES));
  await vault.set('dbEncryptionKeyPending', newKey); // 1. stage (recoverable)
  // 2. re-encrypt the open DB, serialized against every transacting writer (see above).
  await withDbWriteLock(() => rawDb.execute(`PRAGMA rekey = '${newKey}'`));
  await vault.set('dbEncryptionKey', newKey); // 3. promote
  await vault.delete('dbEncryptionKeyPending'); // 4. done
}
