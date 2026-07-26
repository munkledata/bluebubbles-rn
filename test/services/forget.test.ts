/**
 * `forget()` — the Disconnect wipe. The user is told, in the confirmation dialog, that everything
 * this device holds for the server is destroyed, so the two properties under test here are the two
 * that make that promise true even when something below goes wrong.
 *
 * Nothing in `test/` exercised this function before, which is how both of the defects it now pins
 * survived: they are single un-guarded awaits in a function nothing could fail against.
 *
 * Everything around the wipe is mocked — `runForget` is orchestration, and its dependencies are the
 * Keystore, op-sqlite, the socket and the filesystem.
 */
const clearLocalCache = jest.fn(async () => undefined);
const localCacheDirty = jest.fn(async () => false);
const listReminders = jest.fn(async () => [] as unknown[]);
const clearShareShortcuts = jest.fn();
const vaultDelete = jest.fn(async (_key: string) => undefined);
const awaitSyncIdle = jest.fn(async () => undefined);
const cancelAllNotifications = jest.fn(async () => undefined);
const ensureDatabase = jest.fn(async (): Promise<unknown> => ({}));

// `@core/api` pulls `ky`, which ships ESM only and is not in the node project's transform set.
jest.mock('@core/api', () => ({ serverApi: { serverInfo: jest.fn() } }));
jest.mock('@db/repositories', () => ({ clearLocalCache, localCacheDirty, listReminders }));
jest.mock('@db/key', () => ({ runDbRekeySelfTest: jest.fn() }));
// The stores bootstrap pulls in reach `@db/database`, which loads op-sqlite's native binding.
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@/services/clients', () => ({
  vault: { get: jest.fn(async () => null), set: jest.fn(), delete: vaultDelete },
  http: {},
  candidateClient: jest.fn(),
  runCryptoSelfTest: jest.fn(),
}));
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase,
  runSearchTextBackfillOnce: jest.fn(),
}));
jest.mock('@/services/realtimeControl', () => ({
  getSocket: () => null,
  setSocket: jest.fn(),
  startRealtime: jest.fn(),
}));
jest.mock('@/services/reachability', () => ({ stopReachabilityWatch: jest.fn() }));
jest.mock('@/services/syncControl', () => ({ awaitSyncIdle, startSync: jest.fn() }));
jest.mock('@/services/errors', () => ({ initErrorReporting: jest.fn() }));
jest.mock('@/services/logging/fileLogSink', () => ({ initPersistentLogs: jest.fn() }));
jest.mock('@/services/certPins', () => ({ applyStoredCertPins: jest.fn() }));
jest.mock('@/services/connection', () => ({ connectToServer: jest.fn() }));
jest.mock('@/services/lock', () => ({ hydrateLock: jest.fn() }));
jest.mock('@native/deviceIntegrity', () => ({ checkDeviceIntegrity: jest.fn() }));
jest.mock('@state/hydrateStores', () => ({ hydrateAllStores: jest.fn() }));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({ clearShareShortcuts }));
// The shared stub for this native module has no spy on it, and the tray cancel is the behaviour
// under test here — so give this file its own.
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: { cancelAllNotifications },
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  Directory: class {
    exists = false;
    delete(): void {}
  },
}));

import { useSessionStore } from '@state/sessionStore';
import { forget } from '@/services/bootstrap';

beforeEach(() => {
  clearLocalCache.mockResolvedValue(undefined);
  localCacheDirty.mockResolvedValue(false);
  listReminders.mockResolvedValue([]);
  vaultDelete.mockResolvedValue(undefined);
  awaitSyncIdle.mockResolvedValue(undefined);
  cancelAllNotifications.mockResolvedValue(undefined);
  ensureDatabase.mockResolvedValue({});
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://old.example',
    password: 'hunter2',
  });
});

describe('forget() — a vault failure must not abort the Disconnect', () => {
  /**
   * `Promise.all` over the two credential deletes used to be the only un-guarded await in the whole
   * function. One Android Keystore rejection (a key-invalidation event, say) therefore skipped
   * EVERYTHING below it: the session was never reset — the app still believed it was connected,
   * with its socket already torn down — the DB was never wiped, the cached media stayed on disk and
   * the previous account's names and photos stayed in the system share sheet. The next launch then
   * routed to setup on the missing credential, so the user could not even retry.
   */
  it('resets the session and completes the wipe when a credential delete rejects', async () => {
    vaultDelete.mockImplementation(async (key: string) => {
      if (key === 'serverPassword') throw new Error('keystore unavailable');
    });

    await expect(forget()).resolves.toBeUndefined();

    expect(vaultDelete).toHaveBeenCalledWith('serverAddress');
    expect(vaultDelete).toHaveBeenCalledWith('serverPassword');
    // The in-memory reset closes the authorization window even though the on-disk delete did not.
    expect(useSessionStore.getState().origin).toBeNull();
    expect(useSessionStore.getState().password).toBeNull();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('still does all of it on the ordinary path', async () => {
    await forget();

    expect(useSessionStore.getState().origin).toBeNull();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });
});

/**
 * A displayed notification is system state that outlives every row the wipe deletes, and a message
 * notification carries the sender's name, avatar and body. Leaving them up meant the previous
 * account's content stayed on the lock screen of whoever used the device next — through the
 * Disconnect and through connecting to a different server — while the confirmation dialog promised
 * conversations and messages were deleted from the device.
 */
describe('forget() — the tray is cleared with the rest of the account', () => {
  it('cancels the displayed notifications', async () => {
    await forget();

    expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
  });

  it('still cancels them when the DB cannot be opened at all', async () => {
    // The tray cancel must not sit behind `ensureDatabase()`. Enumerating which notifications to
    // cancel is precisely the work that would need the DB — which is why nothing is enumerated,
    // and why this runs ahead of the block that opens it.
    ensureDatabase.mockRejectedValue(new Error('database not initialized'));

    await expect(forget()).resolves.toBeUndefined();

    expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('completes the wipe even when the notification bridge is unreachable', async () => {
    cancelAllNotifications.mockRejectedValue(new Error('notifee module not linked'));

    await expect(forget()).resolves.toBeUndefined();

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wipe is a dozen independent statements — it cannot be one transaction without holding the
 * process-wide write lock for the seconds it takes to delete every message on the device. So a
 * partial wipe is reachable and silent (a statement swept into a neighbour's rolled-back
 * transaction throws nothing; an FK error from a concurrent sync slice is caught and logged at
 * `warn`), and the residue is the previous account's conversations.
 */
describe('forget() — the wipe is confirmed, not trusted', () => {
  it('runs the wipe again when rows survived the first pass', async () => {
    localCacheDirty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await forget();

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
  });

  it('re-runs after a wipe that THREW, instead of leaving the rows behind', async () => {
    clearLocalCache.mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'));
    localCacheDirty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(forget()).resolves.toBeUndefined();

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
  });

  it('gives up (rather than looping) when the cache stays dirty, so Disconnect still finishes', async () => {
    localCacheDirty.mockResolvedValue(true);

    await expect(forget()).resolves.toBeUndefined();

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
    // The steps after the wipe must still run — the credentials are already destroyed.
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });
});
