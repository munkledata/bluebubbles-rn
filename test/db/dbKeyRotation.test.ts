import { InMemoryVault } from '@core/secure';
import { resolveDbKey, rotateDbKey } from '@db/key';
import { withDbWriteLock } from '@db/transaction';

const mockOpen = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

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

    const deferred = (): { promise: Promise<void>; release: () => void } => {
      let resolve!: () => void;
      let released = false;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return {
        promise,
        release: () => {
          if (released) return;
          released = true;
          resolve();
        },
      };
    };
    const nextEventLoopTurn = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });
    const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
      for (let turn = 0; turn < 20 && !condition(); turn += 1) {
        await nextEventLoopTurn();
      }
      if (!condition()) throw new Error(`${label} did not start within 20 event-loop turns`);
    };
    type Outcome<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown };
    const normalize = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
      promise.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

    const holderGate = deferred();
    const executeGate = deferred();
    const executeFinished = deferred();
    let holderDidStart = false;
    let executeDidStart = false;
    let rotationSettled = false;
    let successorDidStart = false;
    let successorSettled = false;
    const holderOutcome = normalize(
      withDbWriteLock(async () => {
        holderDidStart = true;
        await holderGate.promise;
      }),
    );
    let rotationOutcome: Promise<Outcome<void>> | undefined;
    let successorOutcome: Promise<Outcome<void>> | undefined;

    try {
      await waitFor(() => holderDidStart, 'predecessor write-lock holder');
      rotationOutcome = normalize(
        rotateDbKey(vault, {
          execute: async (statement) => {
            sql.push(statement);
            if (!/^PRAGMA rekey = '[0-9a-f]{64}'$/i.test(statement)) return;
            executeDidStart = true;
            try {
              await executeGate.promise;
            } finally {
              executeFinished.release();
            }
          },
        }),
      ).finally(() => {
        rotationSettled = true;
      });

      let stagedKey = await vault.get('dbEncryptionKeyPending');
      for (let turn = 0; turn < 20 && stagedKey === null; turn += 1) {
        await nextEventLoopTurn();
        stagedKey = await vault.get('dbEncryptionKeyPending');
      }
      if (stagedKey === null) {
        throw new Error('database key was not staged within 20 event-loop turns');
      }

      // Staging is vault-only and recoverable, but the shared native connection remains untouched
      // until the predecessor releases its write-lock slot.
      expect(stagedKey).toMatch(/^[0-9a-f]{64}$/);
      expect(executeDidStart).toBe(false);
      expect(sql).toEqual([]);
      expect(await vault.get('dbEncryptionKey')).toBe('OLD');
      expect(rotationSettled).toBe(false);

      holderGate.release();
      expect(await holderOutcome).toEqual({ kind: 'resolved', value: undefined });
      await waitFor(() => executeDidStart, 'exact SQLCipher rekey');

      successorOutcome = normalize(
        withDbWriteLock(async () => {
          successorDidStart = true;
        }),
      ).finally(() => {
        successorSettled = true;
      });
      await nextEventLoopTurn();

      // The native rekey promise owns the write-lock lifetime. Neither the vault promotion nor a
      // synchronously queued successor may outrun it.
      expect(sql).toEqual([`PRAGMA rekey = '${stagedKey}'`]);
      expect(await vault.get('dbEncryptionKey')).toBe('OLD');
      expect(await vault.get('dbEncryptionKeyPending')).toBe(stagedKey);
      expect(rotationSettled).toBe(false);
      expect(successorDidStart).toBe(false);
      expect(successorSettled).toBe(false);

      executeGate.release();
      await executeFinished.promise;
      await waitFor(() => successorDidStart, 'successor write-lock holder');
      expect(await rotationOutcome).toEqual({ kind: 'resolved', value: undefined });
      expect(await successorOutcome).toEqual({ kind: 'resolved', value: undefined });
      expect(await vault.get('dbEncryptionKey')).toBe(stagedKey);
      expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
    } finally {
      holderGate.release();
      executeGate.release();
      const drains: Promise<unknown>[] = [holderOutcome];
      if (rotationOutcome) drains.push(rotationOutcome);
      if (successorOutcome) drains.push(successorOutcome);
      if (executeDidStart) drains.push(executeFinished.promise);
      await Promise.allSettled(drains);
    }
  });
});

function selfTestHandle(
  label: string,
  events: string[],
  executeImpl: (sql: string) => Promise<{ rows: Array<{ v?: string }> }> = async () => ({
    rows: [],
  }),
) {
  return {
    execute: jest.fn(async (sql: string) => {
      events.push(`${label}:execute:${sql}`);
      return executeImpl(sql);
    }),
    close: jest.fn(() => {
      events.push(`${label}:close`);
    }),
    delete: jest.fn(() => {
      events.push(`${label}:delete`);
    }),
  };
}

describe('resolveDbKey (boot recovery)', () => {
  beforeEach(() => {
    mockOpen.mockReset();
  });

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
    const probed: string[] = [];
    expect(
      await resolveDbKey(vault, async (key) => {
        probed.push(key);
        return key === 'NEW';
      }),
    ).toBe('NEW');
    expect(probed).toEqual(['OLD', 'NEW']);
    expect(await vault.get('dbEncryptionKey')).toBe('NEW');
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });

  it('preserves both recovery candidates when neither key can be proven', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');

    await expect(resolveDbKey(vault, async () => false)).rejects.toThrow(
      'Neither stored encryption key could open the database',
    );

    expect(await vault.get('dbEncryptionKey')).toBe('OLD');
    expect(await vault.get('dbEncryptionKeyPending')).toBe('NEW');
  });

  it('the default probe closes a readable primary-key handle before returning it', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    const handle = selfTestHandle('primary-probe', []);
    mockOpen.mockReturnValueOnce(handle);

    await expect(resolveDbKey(vault)).resolves.toBe('OLD');

    expect(mockOpen).toHaveBeenCalledWith({ name: 'gator.db', encryptionKey: 'OLD' });
    expect(handle.execute).toHaveBeenCalledWith('SELECT count(*) FROM sqlite_master');
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });

  it('the default probe closes a wrong-key handle before promoting the staged key', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    const primaryHandle = selfTestHandle('wrong-key-probe', [], async () => {
      throw new Error('file is encrypted or is not a database');
    });
    const pendingHandle = selfTestHandle('pending-key-probe', []);
    mockOpen.mockReturnValueOnce(primaryHandle).mockReturnValueOnce(pendingHandle);

    await expect(resolveDbKey(vault)).resolves.toBe('NEW');

    expect(mockOpen).toHaveBeenNthCalledWith(1, { name: 'gator.db', encryptionKey: 'OLD' });
    expect(mockOpen).toHaveBeenNthCalledWith(2, { name: 'gator.db', encryptionKey: 'NEW' });
    expect(primaryHandle.close).toHaveBeenCalledTimes(1);
    expect(pendingHandle.close).toHaveBeenCalledTimes(1);
    expect(await vault.get('dbEncryptionKey')).toBe('NEW');
    expect(await vault.get('dbEncryptionKeyPending')).toBeNull();
  });

  it('the default probe preserves both keys when neither native read is conclusive', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    const primaryHandle = selfTestHandle('primary-probe', [], async () => {
      throw new Error('database is locked');
    });
    const pendingHandle = selfTestHandle('pending-probe', [], async () => {
      throw new Error('file is encrypted or is not a database');
    });
    mockOpen.mockReturnValueOnce(primaryHandle).mockReturnValueOnce(pendingHandle);

    await expect(resolveDbKey(vault)).rejects.toThrow(
      'Neither stored encryption key could open the database',
    );

    expect(primaryHandle.close).toHaveBeenCalledTimes(1);
    expect(pendingHandle.close).toHaveBeenCalledTimes(1);
    expect(await vault.get('dbEncryptionKey')).toBe('OLD');
    expect(await vault.get('dbEncryptionKeyPending')).toBe('NEW');
  });

  it('does not promote the staged key when the wrong-key handle cannot be closed', async () => {
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');
    await vault.set('dbEncryptionKeyPending', 'NEW');
    const handle = selfTestHandle('unclosable-probe', [], async () => {
      throw new Error('file is encrypted or is not a database');
    });
    handle.close.mockImplementation(() => {
      throw new Error('close failed');
    });
    mockOpen.mockReturnValueOnce(handle);

    await expect(resolveDbKey(vault)).rejects.toThrow('close failed');

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await vault.get('dbEncryptionKey')).toBe('OLD');
    expect(await vault.get('dbEncryptionKeyPending')).toBe('NEW');
  });
});
