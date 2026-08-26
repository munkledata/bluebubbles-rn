/**
 * `ensureDatabase()` must open the encrypted DB exactly once, even when several callers race the
 * FIRST open.
 *
 * The race is real on Android: a killed-app wake with two back-to-back FCM pushes (each handler
 * calls `ensureDatabase()`), or boot racing the first push. `resolveDbKey` is a genuine suspension
 * point (two native Keystore reads), and `initDatabase`'s own `if (dbInstance)` guard is only set
 * AFTER `await runMigrations` — so without a single-flight memo BOTH callers get past every guard,
 * open a second connection to the same file, and run migrations concurrently. Migrations issue
 * their own raw BEGIN/COMMIT (outside the withDbTransaction queue), so on a release that adds one
 * they collide; and the loser's connection is leaked while consumers that memoized the handle keep
 * using it.
 *
 * The DB/key/vault layers are mocked at the module boundary — this pins the concurrency contract,
 * not SQLite.
 */
const mockGetDatabase = jest.fn();
const mockGetRawDatabase = jest.fn();
const mockInitDatabase = jest.fn();
const mockResolveDbKey = jest.fn();
const mockRotateDbKey = jest.fn();

jest.mock('@db/database', () => ({
  getDatabase: (...a: unknown[]) => mockGetDatabase(...a) as unknown,
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a) as unknown,
  initDatabase: (...a: unknown[]) => mockInitDatabase(...a) as unknown,
}));
jest.mock('@db/key', () => ({
  resolveDbKey: (...a: unknown[]) => mockResolveDbKey(...a) as unknown,
  rotateDbKey: (...a: unknown[]) => mockRotateDbKey(...a) as unknown,
}));
jest.mock('@/services/clients', () => ({ vault: { __vault: true } }));

const HANDLE = { __handle: 'db' };
const RAW_HANDLE = { __handle: 'raw-db' };

/** Fresh module instance per test — the single-flight memo is module state. */
async function loadEnsureDatabase(): Promise<() => Promise<unknown>> {
  jest.resetModules();
  const mod = await import('@/services/databaseControl');
  return mod.ensureDatabase as unknown as () => Promise<unknown>;
}

/** Fresh module instance per test — key-rotation failure state is also deliberately module state. */
async function loadRotateDatabaseKey(): Promise<() => Promise<void>> {
  jest.resetModules();
  const mod = await import('@/services/databaseControl');
  return mod.rotateDatabaseKey;
}

/** getDatabase() throws until the DB is open — that throw is ensureDatabase's first-open signal. */
function closedThenOpen(): { markOpen: () => void } {
  let open = false;
  mockGetDatabase.mockImplementation(() => {
    if (!open) throw new Error('Database not initialized — call initDatabase() first.');
    return HANDLE;
  });
  return {
    markOpen: () => {
      open = true;
    },
  };
}

describe('ensureDatabase single-flight', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetRawDatabase.mockReset();
    mockInitDatabase.mockReset();
    mockResolveDbKey.mockReset();
    mockRotateDbKey.mockReset();
  });

  it('two concurrent first-open callers share ONE key resolve and ONE initDatabase', async () => {
    const ensureDatabase = await loadEnsureDatabase();
    const { markOpen } = closedThenOpen();
    // A real suspension between the two awaits — this is the window the second caller used to
    // slip through.
    mockResolveDbKey.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return 'deadbeef';
    });
    mockInitDatabase.mockImplementation(async () => {
      markOpen();
      return HANDLE;
    });

    const [a, b] = await Promise.all([ensureDatabase(), ensureDatabase()]);

    expect(a).toBe(HANDLE);
    expect(b).toBe(HANDLE); // the same connection, not a second one
    expect(mockResolveDbKey).toHaveBeenCalledTimes(1);
    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
  });

  it('once open, later calls take the getDatabase() fast path and never touch the vault', async () => {
    const ensureDatabase = await loadEnsureDatabase();
    const { markOpen } = closedThenOpen();
    mockResolveDbKey.mockResolvedValue('deadbeef');
    mockInitDatabase.mockImplementation(async () => {
      markOpen();
      return HANDLE;
    });

    await ensureDatabase();
    mockResolveDbKey.mockClear();
    mockInitDatabase.mockClear();

    // ensureDatabase runs on EVERY FCM event; re-resolving the key would be two wasted Keystore
    // reads per push.
    expect(await ensureDatabase()).toBe(HANDLE);
    expect(mockResolveDbKey).not.toHaveBeenCalled();
    expect(mockInitDatabase).not.toHaveBeenCalled();
  });

  it('a FAILED open is retried by the next caller (the memo does not latch the rejection)', async () => {
    const ensureDatabase = await loadEnsureDatabase();
    closedThenOpen(); // stays closed: the first attempt never opens it
    mockResolveDbKey
      .mockRejectedValueOnce(new Error('keystore unavailable'))
      .mockResolvedValue('deadbeef');
    mockInitDatabase.mockResolvedValue(HANDLE);

    await expect(ensureDatabase()).rejects.toThrow('keystore unavailable');
    // A permanently-rejected memo would fail every later call for the life of the process — the
    // app could never open its DB again without a restart.
    await expect(ensureDatabase()).resolves.toBe(HANDLE);
    expect(mockResolveDbKey).toHaveBeenCalledTimes(2);
  });

  it('coalesces a failed init for every waiter, then starts one fresh retry', async () => {
    const ensureDatabase = await loadEnsureDatabase();
    const { markOpen } = closedThenOpen();
    const firstFailure = new Error('migration failed');
    mockResolveDbKey.mockResolvedValue('deadbeef');
    mockInitDatabase.mockRejectedValueOnce(firstFailure).mockImplementationOnce(async () => {
      markOpen();
      return HANDLE;
    });

    const first = ensureDatabase();
    const second = ensureDatabase();
    await expect(first).rejects.toBe(firstFailure);
    await expect(second).rejects.toBe(firstFailure);
    expect(mockResolveDbKey).toHaveBeenCalledTimes(1);
    expect(mockInitDatabase).toHaveBeenCalledTimes(1);

    await expect(ensureDatabase()).resolves.toBe(HANDLE);
    expect(mockResolveDbKey).toHaveBeenCalledTimes(2);
    expect(mockInitDatabase).toHaveBeenCalledTimes(2);
  });
});

describe('rotateDatabaseKey single-flight', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetRawDatabase.mockReset();
    mockInitDatabase.mockReset();
    mockResolveDbKey.mockReset();
    mockRotateDbKey.mockReset();
    mockGetRawDatabase.mockReturnValue(RAW_HANDLE);
  });

  it('coalesces concurrent rotations and permits a new rotation only after complete success', async () => {
    const rotateDatabaseKey = await loadRotateDatabaseKey();
    let finishFirst!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    mockRotateDbKey.mockReturnValueOnce(firstAttempt).mockResolvedValueOnce(undefined);

    const first = rotateDatabaseKey();
    let secondSettled = false;
    const second = rotateDatabaseKey().finally(() => {
      secondSettled = true;
    });

    expect(mockGetRawDatabase).toHaveBeenCalledTimes(1);
    expect(mockRotateDbKey).toHaveBeenCalledTimes(1);
    expect(mockRotateDbKey).toHaveBeenCalledWith({ __vault: true }, RAW_HANDLE);
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishFirst();
    await Promise.all([first, second]);

    await expect(rotateDatabaseKey()).resolves.toBeUndefined();
    expect(mockGetRawDatabase).toHaveBeenCalledTimes(2);
    expect(mockRotateDbKey).toHaveBeenCalledTimes(2);
  });

  it('latches a failed rotation until restart so the staged recovery key cannot be overwritten', async () => {
    const rotateDatabaseKey = await loadRotateDatabaseKey();
    const failure = new Error('key promotion failed');
    mockRotateDbKey.mockRejectedValueOnce(failure);

    const first = rotateDatabaseKey();
    const second = rotateDatabaseKey();

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(rotateDatabaseKey()).rejects.toBe(failure);

    expect(mockGetRawDatabase).toHaveBeenCalledTimes(1);
    expect(mockRotateDbKey).toHaveBeenCalledTimes(1);
  });
});
