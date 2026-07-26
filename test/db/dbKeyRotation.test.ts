import { InMemoryVault } from '@core/secure';
import { resolveDbKey, rotateDbKey } from '@db/key';
import { withDbWriteLock } from '@db/transaction';

// key.ts imports expo-crypto at top level; mock the CSPRNG (varies per call).
jest.mock('expo-crypto', () => {
  let n = 0;
  return { getRandomBytes: (len: number) => new Uint8Array(len).fill((n++ % 254) + 1) };
});

describe('rotateDbKey (crash-safe staging)', () => {
  it('stages → rekeys → promotes → clears, ending on a new key', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'deadbeef');
    const sql: string[] = [];
    await rotateDbKey(vault, { execute: async (s) => void sql.push(s) });

    expect(sql.some((s) => /pragma rekey/i.test(s))).toBe(true);
    const primary = await vault.get('dbEncryptionKey');
    expect(primary).toBeTruthy();
    expect(primary).not.toBe('deadbeef');
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });

  it('a crash during rekey leaves it recoverable (staged set, primary unchanged)', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await expect(
      rotateDbKey(vault, {
        execute: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow();
    expect(await vault.get('dbEncryptionKey')).toBe('OLD'); // NOT promoted
    expect(await vault.get('dbEncryptionKeyPending')).toBeTruthy(); // staged → recoverable
  });

  /**
   * The rotation is offered from Settings on a LIVE app, and there is exactly one connection: a
   * sync slice, a live socket/FCM message or an optimistic send can hold a transaction open at the
   * instant the user taps it. SQLCipher rekeys inside its own implicit transaction, so an
   * uncoordinated PRAGMA either fails outright — an intermittent, unexplainable "Couldn't rotate
   * the key" — or commits as a bystander inside that neighbour's transaction and is undone by ITS
   * rollback, while steps 3 and 4 still promote the new key and delete the staged one. The DB is
   * then encrypted with a key nothing has. So the PRAGMA takes the same write lock.
   */
  it('does not submit the PRAGMA while another writer holds the write lock', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    const sql: string[] = [];

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withDbWriteLock(() => held);

    const rotating = rotateDbKey(vault, { execute: async (s) => void sql.push(s) });
    await new Promise((r) => setTimeout(r, 0));

    // Staged (that step is vault-only and recoverable), but the re-encryption has NOT been
    // submitted onto the shared connection.
    expect(await vault.get('dbEncryptionKeyPending')).toBeTruthy();
    expect(sql).toEqual([]);
    expect(await vault.get('dbEncryptionKey')).toBe('OLD'); // and nothing was promoted

    release();
    await holder;
    await rotating;

    expect(sql.some((s) => /pragma rekey/i.test(s))).toBe(true);
    expect(await vault.get('dbEncryptionKey')).not.toBe('OLD');
  });
});

describe('resolveDbKey (boot recovery)', () => {
  it('returns the primary when no rotation is staged', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'K');
    expect(await resolveDbKey(vault, async () => true)).toBe('K');
  });

  it('rolls back a staged rotation whose rekey never ran (primary still opens)', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    expect(await resolveDbKey(vault, async (k) => k === 'OLD')).toBe('OLD');
    expect(await vault.get('dbEncryptionKey')).toBe('OLD');
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });

  it('promotes the staged key when the DB was already rekeyed (primary no longer opens)', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    expect(await resolveDbKey(vault, async (k) => k === 'NEW')).toBe('NEW');
    expect(await vault.get('dbEncryptionKey')).toBe('NEW');
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });
});
