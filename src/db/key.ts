import * as Crypto from 'expo-crypto';
import type { SecureVault } from '@core/secure';

const KEY_BYTES = 32;
// MUST match database.ts DB_NAME (kept here so this module never imports the op-sqlite
// top-level handle — it would break the pure-Node test path).
const DB_NAME = 'bluebubbles.db';

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
  try {
    const db = open({ name: DB_NAME, encryptionKey: key });
    await db.execute('SELECT count(*) FROM sqlite_master'); // throws on the wrong key
    db.close();
    return true;
  } catch {
    return false;
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
  // The DB was rekeyed to the staged key but the promote was interrupted. Promote it now.
  await vault.set('dbEncryptionKey', pending);
  await vault.delete('dbEncryptionKeyPending');
  return pending;
}

/**
 * CRASH-SAFE SQLCipher key rotation on the OPEN connection: stage a fresh key, rekey the
 * DB, promote the staged key, then clear staging. A crash at any step is recoverable by
 * `resolveDbKey` on the next boot (the DB is never left with no matching stored key).
 * The open `dbInstance` keeps working — rekey updates the running connection.
 */
export async function rotateDbKey(vault: SecureVault, rawDb: RawExec): Promise<void> {
  const newKey = toHex(Crypto.getRandomBytes(KEY_BYTES));
  await vault.set('dbEncryptionKeyPending', newKey); // 1. stage (recoverable)
  await rawDb.execute(`PRAGMA rekey = '${newKey}'`); // 2. re-encrypt the open DB
  await vault.set('dbEncryptionKey', newKey); // 3. promote
  await vault.delete('dbEncryptionKeyPending'); // 4. done
}

function firstValue(res: unknown): string | undefined {
  const rows = (res as { rows?: unknown }).rows;
  const arr = Array.isArray(rows)
    ? (rows as Array<{ v?: string }>)
    : ((rows as { _array?: Array<{ v?: string }> } | undefined)?._array ?? []);
  return arr[0]?.v;
}

/**
 * DEV/device de-risking spike for key rotation: prove op-sqlite's SQLCipher `PRAGMA
 * rekey` actually re-encrypts the DB on THIS device — on a THROWAWAY db, never the real
 * one. (Jest's better-sqlite3 has no SQLCipher codec, so this can only run on device;
 * the crypto self-test already showed jest-green ≠ device-correct.) Returns ok only if
 * rekey succeeds, the row survives a reopen with the NEW key, and a reopen with the OLD
 * key is rejected. This must pass before any crash-safe rotation is built on top.
 */
export async function runDbRekeySelfTest(): Promise<{ ok: boolean; detail: string }> {
  const { open } = await import('@op-engineering/op-sqlite');
  const name = 'rekey-selftest.db';
  const keyA = toHex(Crypto.getRandomBytes(KEY_BYTES));
  const keyB = toHex(Crypto.getRandomBytes(KEY_BYTES));
  const wipe = (): void => {
    try {
      open({ name }).delete(); // remove any leftover (it's keyed to a prior run's keyB)
    } catch {
      /* nothing to wipe */
    }
  };
  try {
    wipe();
    let db = open({ name, encryptionKey: keyA });
    await db.execute('CREATE TABLE t (v TEXT)');
    await db.execute("INSERT INTO t (v) VALUES ('hello')");
    await db.execute(`PRAGMA rekey = '${keyB}'`);
    db.close();

    db = open({ name, encryptionKey: keyB });
    const got = firstValue(await db.execute('SELECT v FROM t'));
    db.close();

    let oldRejected = false;
    try {
      const stale = open({ name, encryptionKey: keyA });
      await stale.execute('SELECT v FROM t'); // SQLCipher rejects the wrong key on first read
      stale.close();
    } catch {
      oldRejected = true;
    }

    const ok = got === 'hello' && oldRejected;
    return {
      ok,
      detail: ok ? 'rekey + reopen(new) + reject(old) OK' : `got=${got} oldRejected=${oldRejected}`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'rekey self-test threw' };
  } finally {
    wipe();
  }
}
