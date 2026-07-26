/**
 * The WorkManager catch-up task, and the window `forget()`'s drain cannot see.
 *
 * The drain (`awaitSyncIdle`) only ever inspects what is in the two slots at the instant it looks,
 * and it exits immediately when both are null. So anything the task resolves BEFORE it publishes
 * itself is time in which a Disconnect drains nothing, wipes, and then watches this run page into
 * the emptied DB. That window used to be `ensureDatabase()` (a Keystore read plus, after a schema
 * bump, the whole migration pass) and a retryable `serverVersion()` GET — seconds on a cold
 * headless wake.
 *
 * Everything under the task is mocked; only the ORDER of its own steps is under test.
 */
const runTrackedSync = jest.fn(async (run: () => Promise<void>) => {
  await run();
});
const ensureDatabase = jest.fn(async () => ({}) as unknown);
const incrementalSync = jest.fn(async () => ({ chats: 0, messages: 0 }));
const serverVersion = jest.fn(async () => '1.9.0');
const runOutgoingQueue = jest.fn(async () => undefined);

/** The task registers itself at module load; capture it so the test can invoke it. */
let task: (() => Promise<unknown>) | undefined;

jest.mock('expo-task-manager', () => ({
  defineTask: (_name: string, fn: () => Promise<unknown>) => {
    task = fn;
  },
  isTaskRegisteredAsync: jest.fn(async () => true),
}));
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 'success', Failed: 'failed' },
  BackgroundTaskStatus: { Available: 'available' },
  getStatusAsync: jest.fn(async () => 'available'),
  registerTaskAsync: jest.fn(),
}));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase }));
jest.mock('@/services/errors', () => ({ flushErrorReports: jest.fn(async () => undefined) }));
jest.mock('@/services/send', () => ({ outgoingQueueIO: {}, runOutgoingQueue }));
jest.mock('@/services/sync', () => ({
  httpSyncApi: () => ({ serverVersion }),
  incrementalSync,
}));
jest.mock('@/services/syncControl', () => ({ runTrackedSync }));
// The session store reaches `@db/database`, which loads op-sqlite's native binding.
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));

import { useSessionStore } from '@state/sessionStore';
import '@/services/background/backgroundSync';

beforeEach(() => {
  runTrackedSync.mockImplementation(async (run) => {
    await run();
  });
  ensureDatabase.mockResolvedValue({});
  incrementalSync.mockResolvedValue({ chats: 0, messages: 0 });
  serverVersion.mockResolvedValue('1.9.0');
  runOutgoingQueue.mockResolvedValue(undefined);
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://server.example',
    password: 'hunter2',
    serverInfo: null,
  });
});

describe('the background catch-up task', () => {
  it('publishes itself into the tracked slot BEFORE resolving anything it needs', async () => {
    let dbOpensAtPublish = -1;
    let versionFetchesAtPublish = -1;
    runTrackedSync.mockImplementation(async (run) => {
      dbOpensAtPublish = ensureDatabase.mock.calls.length;
      versionFetchesAtPublish = serverVersion.mock.calls.length;
      await run();
    });

    await task?.();

    // Nothing slow had happened yet — so there is no interval in which a drain sees both slots
    // null while this run is already committed to paging.
    expect(dbOpensAtPublish).toBe(0);
    expect(versionFetchesAtPublish).toBe(0);
    expect(incrementalSync).toHaveBeenCalledTimes(1);
  });

  it('aborts itself when the session disappeared while it was queued', async () => {
    // The wipe clears the credentials FIRST, so an empty session inside the slot means the
    // Disconnect has already happened — and the run must not page into the emptied DB.
    runTrackedSync.mockImplementation(async (run) => {
      useSessionStore.getState().reset();
      await run();
    });

    await task?.();

    expect(incrementalSync).not.toHaveBeenCalled();
    expect(serverVersion).not.toHaveBeenCalled(); // it never got as far as talking to the server
    // The one DB open left is the outgoing-queue drain below, which is deliberately outside the
    // slot and has nothing to resurrect once the wipe has run.
    expect(ensureDatabase).toHaveBeenCalledTimes(1);
  });

  it('still drains the outgoing queue, which is deliberately outside the tracked slot', async () => {
    await task?.();
    expect(runOutgoingQueue).toHaveBeenCalledTimes(1);
  });
});
