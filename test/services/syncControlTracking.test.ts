/**
 * The sync coalescing slot must also hold OUT-OF-BAND runs.
 *
 * The background WorkManager catch-up pages its own incremental sync instead of calling
 * `startSync` (which owns the first-sync branch and the trailing contacts sync — neither belongs
 * on a 15-minute timer). Before `runTrackedSync` existed that run was invisible: `forget()` drains
 * the slot via `awaitSyncIdle()` before wiping the DB, and an unpublished run means the drain
 * returns instantly, the wipe lands, and the task's next page then re-creates the previous
 * account's chats/handles/messages plus a non-null sync marker over the reset.
 *
 * Everything below the coalescing wrapper is mocked (DB handle, sync engine, HTTP client,
 * contacts sync) — only the slot bookkeeping is under test.
 */
const incrementalSync = jest.fn();
const fullSync = jest.fn();
const syncAllChats = jest.fn();
const syncChatMessages = jest.fn();
const getSyncMarker = jest.fn();
const setSyncMarkerWithinTransaction = jest.fn();
const kvSetWithinTransaction = jest.fn();
const captureFullRepairPruneExposure = jest.fn();
const reconcileFullRepairPruneExposure = jest.fn();
const sameFullSyncServerView = jest.fn();
const syncContacts = jest.fn();
const serverVersion = jest.fn();
const fetchServerInfo = jest.fn();
const beginRepairSnapshot = jest.fn();
const finishRepairSnapshot = jest.fn();
const cancelRepairSnapshot = jest.fn();
const bindRepairSnapshot = jest.fn();
const syncDeletedMessages = jest.fn<Promise<number>, [unknown, unknown, unknown]>(async () => 0);
const isDeletionSnapshotInitialized = jest.fn<Promise<boolean>, [unknown, unknown]>(
  async () => false,
);
const pinnedHttp = { bindRepairSnapshot };
const pinTransport = jest.fn(() => pinnedHttp);
const mockSyncDb = {
  testId: 'sync-control-db',
  run: jest.fn<Promise<void>, [unknown]>(async () => undefined),
};
let mockAccountLeaseCurrent = true;
const mockAccountLease = {
  generation: 731,
  isCurrent: jest.fn(() => mockAccountLeaseCurrent),
};
const mockAttachmentCacheScope = { testId: 'sync-attachment-cache-scope' };
const mockEnsureDatabase = jest.fn<Promise<typeof mockSyncDb>, []>(async () => mockSyncDb);
const mockCreateAttachmentCacheAccountScope = jest.fn<
  typeof mockAttachmentCacheScope,
  [unknown, typeof mockAccountLease]
>(() => mockAttachmentCacheScope);
const mockCaptureRealtimeDeliveryLease = jest.fn<typeof mockAccountLease, []>(
  () => mockAccountLease,
);
const mockReleaseInvalidation = jest.fn();
const mockSubscribeRealtimeGenerationInvalidation = jest.fn(
  (_generation: number, _listener: () => void) => mockReleaseInvalidation,
);
const mockRetireInactiveEntries = jest.fn<Promise<void>, [unknown, { scope: unknown }]>(
  async () => undefined,
);
const mockDrainDueRetirements = jest.fn<Promise<void>, [unknown, { scope: unknown }]>(
  async () => undefined,
);
const mockReconcileMessageNotifications = jest.fn<Promise<void>, [unknown, unknown]>(
  async () => undefined,
);

jest.mock('@/services/clients', () => ({ http: { pinTransport } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: mockEnsureDatabase }));
jest.mock('@/services/contacts/contactsService', () => ({ syncContacts }));
jest.mock('@/services/download/attachmentCacheAccountScope', () => ({
  createAttachmentCacheAccountScope: mockCreateAttachmentCacheAccountScope,
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {
    retireInactiveEntries: mockRetireInactiveEntries,
    drainDueRetirements: mockDrainDueRetirements,
  },
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  reconcileMessageNotificationsWithDatabase: mockReconcileMessageNotifications,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: mockCaptureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation: mockSubscribeRealtimeGenerationInvalidation,
}));
jest.mock('@/services/sync', () => ({
  DELETION_SNAPSHOT_INITIALIZED_KEY: 'sync.deletionSnapshotInitialized',
  DELETION_SNAPSHOT_INITIALIZED_VALUE: '{"v":1}',
  fullSync,
  httpSyncApi: (transport: unknown) => ({
    transport,
    serverInfo: fetchServerInfo,
    serverVersion,
    beginRepairSnapshot,
    finishRepairSnapshot,
    cancelRepairSnapshot,
  }),
  incrementalSync,
  isDeletionSnapshotInitialized,
  sameFullSyncServerView,
  syncAllChats,
  syncChatMessages,
  syncDeletedMessages,
}));
// The stores syncControl pulls in reach `@db/database`, which loads op-sqlite's native binding.
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@db/repositories', () => ({
  captureFullRepairPruneExposure,
  getSyncMarker,
  kvSetWithinTransaction,
  reconcileFullRepairPruneExposure,
  setSyncMarkerWithinTransaction,
}));

import type { ServerInfo } from '@core/models';
import { currentRcsProviderEpoch } from '@core/rcs/providerIdentity';
import { RepairSnapshotRcsActiveError } from '@core/api/endpoints/repairSnapshot';
import { useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import {
  awaitSyncIdle,
  cancelFullRepair,
  ensureChatSynced,
  runTrackedSync,
  startFullRepair,
  startSync,
} from '@/services/syncControl';

/** Let every pending microtask AND timer callback run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SERVER_INFO: ServerInfo = { server_version: '1.9.0' };
const SNAPSHOT_SERVER_INFO: ServerInfo = {
  server_version: '2.0.15',
  supports_message_deleted: true,
  supports_repair_snapshot: true,
};

/** Drive the session through the SAME transitions the app does — that is what mints an epoch. */
const connectSession = (origin: string, serverInfo: ServerInfo = SERVER_INFO): void =>
  useSessionStore.getState().connected(origin, 'hunter2', serverInfo);
const disconnectSession = (): void => useSessionStore.getState().reset();

/** A promise plus the trigger that resolves it — a run we can hold open for as long as we like. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

beforeEach(() => {
  mockAccountLeaseCurrent = true;
  // Non-null marker → runSync takes the incremental branch (no full sync).
  getSyncMarker.mockResolvedValue({ lastSyncedRowId: 10, lastSyncedTimestamp: 1000 });
  syncAllChats.mockResolvedValue([]);
  incrementalSync.mockResolvedValue({ chats: 0, messages: 0 });
  fullSync.mockResolvedValue({ chats: 0, messages: 0 });
  captureFullRepairPruneExposure.mockResolvedValue({
    capturedAt: 0,
    attachmentIdHighWater: 0,
    chats: [],
    messages: [],
    attachments: [],
  });
  reconcileFullRepairPruneExposure.mockResolvedValue({
    messagesRemoved: 0,
    attachmentsRemoved: 0,
    chatsRemoved: 0,
    chatShellsRetired: 0,
    chatsPreservedForLocalWork: 0,
  });
  sameFullSyncServerView.mockReturnValue(true);
  syncChatMessages.mockResolvedValue(0);
  syncContacts.mockResolvedValue({ contacts: 0, matched: 0 });
  serverVersion.mockResolvedValue('1.9.0');
  fetchServerInfo.mockResolvedValue(SERVER_INFO);
  beginRepairSnapshot.mockResolvedValue({
    token: '00000000-0000-4000-8000-000000000001',
    expiresAt: 1_900_000_000_000,
  });
  finishRepairSnapshot.mockResolvedValue(undefined);
  cancelRepairSnapshot.mockResolvedValue(undefined);
  bindRepairSnapshot.mockReturnValue({});
  isDeletionSnapshotInitialized.mockResolvedValue(false);
  mockReconcileMessageNotifications.mockResolvedValue(undefined);
  useSyncStore.getState().reset();
  // The slot is keyed by the session INSTANCE it belongs to, so start each test from a fresh one
  // (`reset` mints a new epoch, so nothing a previous test parked in the slot is shareable here).
  disconnectSession();
});

describe('ensureChatSynced — on-demand work participates in account teardown', () => {
  it('keeps the idle barrier closed and aborts an account-A backfill after Disconnect', async () => {
    const request = gate();
    let shouldAbort: (() => boolean) | undefined;
    syncChatMessages.mockImplementation(
      async (_db: unknown, _api: unknown, _guid: string, opts: { shouldAbort?: () => boolean }) => {
        shouldAbort = opts.shouldAbort;
        await request.promise;
        return shouldAbort?.() ? 0 : 7;
      },
    );

    connectSession('https://old.example');
    const backfill = ensureChatSynced('chat-a');
    await settle();
    expect(syncChatMessages).toHaveBeenCalledTimes(1);
    expect(shouldAbort?.()).toBe(false);

    let idle = false;
    const waiting = awaitSyncIdle().then(() => {
      idle = true;
    });
    disconnectSession();
    expect(shouldAbort?.()).toBe(true);
    await settle();
    expect(idle).toBe(false);

    request.open();
    await expect(backfill).resolves.toBe(0);
    await waiting;
    expect(idle).toBe(true);
  });
});

describe('runTrackedSync — the background task participates in the coalescing slot', () => {
  it('keeps awaitSyncIdle waiting for the whole of an out-of-band run', async () => {
    const run = gate();
    const tracked = runTrackedSync(() => run.promise);

    let idle = false;
    const waiting = awaitSyncIdle().then(() => {
      idle = true;
    });

    await settle();
    expect(idle).toBe(false); // the wipe must NOT be allowed to start here

    run.open();
    await tracked;
    await waiting;
    expect(idle).toBe(true);
  });

  it('waits for a run CHAINED into the slot after the drain already started', async () => {
    const first = gate();
    const trackedFirst = runTrackedSync(() => first.promise);

    let idle = false;
    const waiting = awaitSyncIdle().then(() => {
      idle = true;
    });

    // A second out-of-band run publishes itself while the drain is parked on the first.
    const second = gate();
    const trackedSecond = runTrackedSync(() => second.promise);

    first.open();
    await trackedFirst;
    await settle();
    expect(idle).toBe(false); // the successor is still paging

    second.open();
    await trackedSecond;
    await waiting;
    expect(idle).toBe(true);
  });

  it('serializes behind a run already in the slot instead of paging alongside it', async () => {
    const first = gate();
    let secondStarted = false;
    runTrackedSync(() => first.promise);
    const trackedSecond = runTrackedSync(async () => {
      secondStarted = true;
    });

    await settle();
    expect(secondStarted).toBe(false);

    first.open();
    await trackedSecond;
    expect(secondStarted).toBe(true);
  });

  it('a failed predecessor still hands the slot on (a run that stopped writing is idle)', async () => {
    runTrackedSync(async () => {
      throw new Error('page fetch failed');
    });
    await expect(runTrackedSync(async () => undefined)).resolves.toBeUndefined();
    await expect(awaitSyncIdle()).resolves.toBeUndefined();
  });

  it('a finishing startSync does not clear a slot a tracked run has taken over', async () => {
    // startSync publishes its own run; the background task then chains behind it. When the
    // foreground run finishes it must NOT null the slot out from under the successor — that is
    // exactly what would leave forget() blind again.
    const foreground = gate();
    incrementalSync.mockImplementation(async () => {
      await foreground.promise;
      return { chats: 0, messages: 0 };
    });
    const started = startSync();

    const background = gate();
    const tracked = runTrackedSync(() => background.promise);

    let idle = false;
    const waiting = awaitSyncIdle().then(() => {
      idle = true;
    });

    foreground.open();
    await started;
    await settle();
    expect(idle).toBe(false); // the background page is still in flight

    background.open();
    await tracked;
    await waiting;
    expect(idle).toBe(true);
  });
});

describe('first sync — stable snapshot completion', () => {
  it('waits for capabilities when boot has not published server info yet', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    let resolveServerInfo!: (info: ServerInfo) => void;
    fetchServerInfo.mockImplementationOnce(
      () =>
        new Promise<ServerInfo>((resolve) => {
          resolveServerInfo = resolve;
        }),
    );
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      return { chats: 3, messages: 7 };
    });

    connectSession('https://boot-race.example', SNAPSHOT_SERVER_INFO);
    useSessionStore.setState({ serverInfo: null });
    const running = startSync();
    await settle();

    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
    expect(fullSync).not.toHaveBeenCalled();

    resolveServerInfo(SNAPSHOT_SERVER_INFO);
    await running;
    expect(beginRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({ exhaustive: true });
    expect(setSyncMarkerWithinTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps the additive bounded path when the server omits the snapshot capability', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });

    connectSession('https://legacy.example');
    await startSync();

    expect(pinTransport).not.toHaveBeenCalled();
    expect(beginRepairSnapshot).not.toHaveBeenCalled();
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(fullSync.mock.calls[0]?.[2]).toMatchObject({
      commitMarker: true,
      failOnChatError: false,
    });
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).not.toHaveProperty('exhaustive');
    expect(isDeletionSnapshotInitialized).not.toHaveBeenCalled();
    expect(kvSetWithinTransaction).not.toHaveBeenCalled();
    expect(useSyncStore.getState().status).toBe('done');
  });

  it('runs one stable initialization when an upgraded account has a marker but no proof flag', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: 10, lastSyncedTimestamp: 1_000 });
    isDeletionSnapshotInitialized.mockResolvedValueOnce(false);
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      return { chats: 3, messages: 7 };
    });

    connectSession('https://upgraded.example', SNAPSHOT_SERVER_INFO);
    await startSync();

    expect(isDeletionSnapshotInitialized).toHaveBeenCalledTimes(1);
    expect(incrementalSync).not.toHaveBeenCalled();
    expect(beginRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(fullSync.mock.calls[0]?.[2]).toMatchObject({ commitMarker: false });
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({ exhaustive: true });
    expect(finishRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(setSyncMarkerWithinTransaction).toHaveBeenCalledTimes(1);
    expect(kvSetWithinTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'sync.deletionSnapshotInitialized',
      '{"v":1}',
    );
    expect(useSyncStore.getState()).toMatchObject({ status: 'done', chats: 3, messages: 7 });
  });

  it('finishes exhaustive deletions and the server lease before installing the marker', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      return { chats: 3, messages: 7 };
    });

    connectSession('https://snapshot.example', SNAPSHOT_SERVER_INFO);
    await startSync();

    expect(pinTransport).toHaveBeenCalledTimes(1);
    expect(beginRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(bindRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(fullSync.mock.calls[0]?.[2]).toMatchObject({
      commitMarker: false,
      failOnChatError: true,
    });
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[1]).toBe(fullSync.mock.calls[0]?.[1]);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({ exhaustive: true });
    expect(finishRepairSnapshot).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      undefined,
    );
    expect(setSyncMarkerWithinTransaction).toHaveBeenCalledTimes(1);
    expect(setSyncMarkerWithinTransaction.mock.calls[0]?.[1]).toEqual({
      lastSyncedRowId: 42,
      lastSyncedTimestamp: 4_200,
    });
    expect(kvSetWithinTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'sync.deletionSnapshotInitialized',
      '{"v":1}',
    );
    expect(beginRepairSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      fullSync.mock.invocationCallOrder[0]!,
    );
    expect(fullSync.mock.invocationCallOrder[0]).toBeLessThan(
      syncDeletedMessages.mock.invocationCallOrder[0]!,
    );
    expect(syncDeletedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      finishRepairSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(finishRepairSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      setSyncMarkerWithinTransaction.mock.invocationCallOrder[0]!,
    );
    expect(cancelRepairSnapshot).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({
      status: 'done',
      chats: 3,
      messages: 7,
      error: null,
    });
  });

  it('reads the retained v2 ledger even when live deletion discovery is unavailable', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      return { chats: 3, messages: 7 };
    });

    connectSession('https://snapshot.example', {
      ...SNAPSHOT_SERVER_INFO,
      supports_message_deleted: false,
    });
    await startSync();

    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({
      exhaustive: true,
      supported: true,
    });
    expect(kvSetWithinTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'sync.deletionSnapshotInitialized',
      '{"v":1}',
    );
  });

  it('keeps additive sync usable while RCS prevents a stable server snapshot', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    beginRepairSnapshot.mockRejectedValueOnce(new RepairSnapshotRcsActiveError());

    connectSession('https://rcs.example', { ...SNAPSHOT_SERVER_INFO, rcs: true });
    await startSync();

    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(fullSync.mock.calls[0]?.[2]).toMatchObject({
      commitMarker: true,
      failOnChatError: false,
    });
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).not.toHaveProperty('exhaustive');
    expect(finishRepairSnapshot).not.toHaveBeenCalled();
    expect(kvSetWithinTransaction).not.toHaveBeenCalled();
    expect(useSyncStore.getState().status).toBe('done');
  });

  it('cancels a lease whose finish fails and leaves the first-sync marker empty', async () => {
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      return { chats: 3, messages: 7 };
    });
    finishRepairSnapshot.mockRejectedValueOnce(new Error('snapshot finish failed'));

    connectSession('https://snapshot.example', SNAPSHOT_SERVER_INFO);
    await startSync();

    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({ exhaustive: true });
    expect(finishRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(setSyncMarkerWithinTransaction).not.toHaveBeenCalled();
    expect(kvSetWithinTransaction).not.toHaveBeenCalled();
    expect(cancelRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(useSyncStore.getState()).toMatchObject({
      status: 'error',
      error: 'snapshot finish failed',
    });
  });
});

describe('full repair — cancellation ownership', () => {
  it('binds one crawl, verifies it, then reconciles and installs the rebuilt marker', async () => {
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      options.onServerView?.({
        chats: new Map([['chat-a', 7]]),
        messages: new Map(),
        attachmentsByMessage: new Map(),
      });
      return { chats: 1, messages: 0 };
    });

    connectSession('https://repair.example', SNAPSHOT_SERVER_INFO);
    await startFullRepair();

    expect(beginRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(bindRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(finishRepairSnapshot).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages).toHaveBeenCalledTimes(1);
    expect(syncDeletedMessages.mock.calls[0]?.[1]).toBe(fullSync.mock.calls[0]?.[1]);
    expect(syncDeletedMessages.mock.calls[0]?.[2]).toMatchObject({ exhaustive: true });
    expect(reconcileFullRepairPruneExposure).toHaveBeenCalledTimes(1);
    expect(setSyncMarkerWithinTransaction).toHaveBeenCalledTimes(1);
    expect(kvSetWithinTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'sync.deletionSnapshotInitialized',
      '{"v":1}',
    );
    expect(mockReconcileMessageNotifications).toHaveBeenCalledWith(mockSyncDb, mockAccountLease);
    expect(beginRepairSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      fullSync.mock.invocationCallOrder[0]!,
    );
    expect(fullSync.mock.invocationCallOrder[0]).toBeLessThan(
      finishRepairSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(finishRepairSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileFullRepairPruneExposure.mock.invocationCallOrder[0]!,
    );
    expect(reconcileFullRepairPruneExposure.mock.invocationCallOrder[0]).toBeLessThan(
      setSyncMarkerWithinTransaction.mock.invocationCallOrder[0]!,
    );
    expect(useSyncStore.getState()).toMatchObject({
      repairStatus: 'done',
      repairPhase: 'Repair complete',
    });
  });

  it('keeps old-server refresh additive and reports its limited completion truthfully', async () => {
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      options.onServerView?.({
        chats: new Map([['chat-a', 7]]),
        messages: new Map(),
        attachmentsByMessage: new Map(),
      });
      return { chats: 1, messages: 0 };
    });

    connectSession('https://old-repair.example');
    await startFullRepair();

    expect(beginRepairSnapshot).not.toHaveBeenCalled();
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(captureFullRepairPruneExposure).not.toHaveBeenCalled();
    expect(bindRepairSnapshot).not.toHaveBeenCalled();
    expect(finishRepairSnapshot).not.toHaveBeenCalled();
    expect(reconcileFullRepairPruneExposure).not.toHaveBeenCalled();
    expect(setSyncMarkerWithinTransaction).not.toHaveBeenCalled();
    expect(kvSetWithinTransaction).not.toHaveBeenCalled();
    expect(cancelRepairSnapshot).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({
      repairStatus: 'done',
      repairPhase: 'Refresh complete (limited)',
    });
  });

  it('aborts the active request and leaves the previous marker untouched', async () => {
    let repairOptions:
      | {
          maxMessagesPerChat?: number;
          failOnChatError?: boolean;
          commitMarker?: boolean;
          signal?: AbortSignal;
        }
      | undefined;
    fullSync.mockImplementation(
      async (_db: unknown, _api: unknown, options: typeof repairOptions) => {
        repairOptions = options;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('repair request aborted'), { name: 'AbortError' }));
          });
        });
        return { chats: 0, messages: 0 };
      },
    );

    connectSession('https://repair.example', SNAPSHOT_SERVER_INFO);
    const running = startFullRepair();
    await settle();

    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(repairOptions).toMatchObject({
      maxMessagesPerChat: 0,
      failOnChatError: true,
      commitMarker: false,
    });
    expect(repairOptions?.signal?.aborted).toBe(false);
    expect(useSyncStore.getState().repairStatus).toBe('running');

    expect(cancelFullRepair()).toBe(true);
    expect(repairOptions?.signal?.aborted).toBe(true);
    await expect(running).resolves.toBeUndefined();

    expect(setSyncMarkerWithinTransaction).not.toHaveBeenCalled();
    expect(cancelRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(useSyncStore.getState()).toMatchObject({
      status: 'idle',
      repairStatus: 'cancelled',
      repairPhase: 'Repair stopped',
    });
    expect(mockReleaseInvalidation).toHaveBeenCalledTimes(1);
  });

  it('abandons a repair when the RCS provider epoch rotates during its crawl', async () => {
    const crawl = gate();
    let shouldAbort: (() => boolean) | undefined;
    fullSync.mockImplementation(async (_db, _api, options) => {
      shouldAbort = options.shouldAbort;
      await crawl.promise;
      return { chats: 0, messages: 0 };
    });
    const providerEpochA = `gpe1_${'A'.repeat(43)}`;
    const providerEpochB = `gpe1_${'E'.repeat(43)}`;
    const serverInfoA: ServerInfo = {
      ...SNAPSHOT_SERVER_INFO,
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: providerEpochA,
    };
    const serverInfoB: ServerInfo = {
      ...serverInfoA,
      rcs_provider_epoch: providerEpochB,
    };
    const origin = 'https://provider-rotation.example';

    expect(currentRcsProviderEpoch(serverInfoA)).toBe(providerEpochA);
    expect(currentRcsProviderEpoch(serverInfoB)).toBe(providerEpochB);
    expect(providerEpochB).not.toBe(providerEpochA);

    connectSession(origin, serverInfoA);
    const running = startFullRepair();
    await settle();

    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(shouldAbort?.()).toBe(false);
    const { transportRevision } = useSessionStore.getState();
    expect(
      useSessionStore.getState().setServerInfoForTransport(origin, transportRevision, serverInfoB),
    ).toBe(true);
    expect(shouldAbort?.()).toBe(true);

    crawl.open();
    await expect(running).resolves.toBeUndefined();

    expect(cancelRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(syncDeletedMessages).not.toHaveBeenCalled();
    expect(finishRepairSnapshot).not.toHaveBeenCalled();
    expect(reconcileFullRepairPruneExposure).not.toHaveBeenCalled();
    expect(setSyncMarkerWithinTransaction).not.toHaveBeenCalled();
    expect(kvSetWithinTransaction).not.toHaveBeenCalled();
    expect(mockReconcileMessageNotifications).not.toHaveBeenCalled();
    expect(syncContacts).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({
      repairStatus: 'cancelled',
      repairPhase: 'Repair stopped',
      repairLog: expect.arrayContaining([
        'Repair stopped because the connection changed. Restart it to continue.',
      ]),
    });
  });

  it('releases the server lease when snapshot finish fails', async () => {
    fullSync.mockImplementation(async (_db, _api, options) => {
      options.onServerMarker?.({ lastSyncedRowId: 42, lastSyncedTimestamp: 4_200 });
      options.onServerView?.({
        chats: new Map([['chat-a', 7]]),
        messages: new Map(),
        attachmentsByMessage: new Map(),
      });
      return { chats: 1, messages: 0 };
    });
    finishRepairSnapshot.mockRejectedValueOnce(new Error('snapshot finish failed'));

    connectSession('https://repair.example', SNAPSHOT_SERVER_INFO);
    await startFullRepair();

    expect(cancelRepairSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(reconcileFullRepairPruneExposure).not.toHaveBeenCalled();
    expect(setSyncMarkerWithinTransaction).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({
      repairStatus: 'error',
      repairPhase: 'Repair failed',
    });
  });
});

/**
 * The tracked slot must never SUBSTITUTE for a foreground sync.
 *
 * The background task pages an incremental catch-up and nothing else — no chat-list refresh, no
 * deletion catch-up, no contacts sync, no first-sync branch, no begin/progress/done for the sync
 * banner. Handing that run back to a boot / pull-to-refresh / resume (which is what one shared
 * slot did) means the whole pipeline is silently skipped: the refresh spinner tracks work the
 * user did not ask for and clears having done none of the work they did.
 */
describe('startSync vs. the tracked slot', () => {
  it('passes the session ownership check into incremental commits', async () => {
    const request = gate();
    let shouldAbort: (() => boolean) | undefined;
    incrementalSync.mockImplementation(
      async (_db: unknown, _api: unknown, opts: { shouldAbort?: () => boolean }) => {
        shouldAbort = opts.shouldAbort;
        await request.promise;
        return { chats: 0, messages: 0 };
      },
    );

    connectSession('https://guarded.example');
    const running = startSync();
    await settle();
    expect(shouldAbort?.()).toBe(false);

    disconnectSession();
    expect(shouldAbort?.()).toBe(true);

    request.open();
    await running;
  });

  it('cannot overwrite a replacement account banner or launch its contacts sync after retiring', async () => {
    const request = gate();
    incrementalSync.mockImplementation(async () => {
      await request.promise;
      return { chats: 7, messages: 70 };
    });

    connectSession('https://old.example');
    const oldRun = startSync();
    await settle();
    expect(useSyncStore.getState().status).toBe('syncing');

    disconnectSession();
    connectSession('https://new.example');
    // Represent the replacement account's own pending banner while A unwinds behind the scenes.
    useSyncStore.getState().reset();
    useSyncStore.getState().begin();

    request.open();
    await oldRun;

    expect(useSyncStore.getState()).toMatchObject({
      status: 'syncing',
      chats: 0,
      messages: 0,
      error: null,
    });
    expect(syncContacts).not.toHaveBeenCalled();
  });

  it('does not publish an old account error after its session is retired', async () => {
    const request = gate();
    incrementalSync.mockImplementation(async () => {
      await request.promise;
      throw new Error('old account failed late');
    });

    connectSession('https://old.example');
    const oldRun = startSync();
    await settle();
    disconnectSession();
    connectSession('https://new.example');
    useSyncStore.getState().reset();

    request.open();
    await oldRun;

    expect(useSyncStore.getState()).toMatchObject({ status: 'idle', error: null });
    expect(syncContacts).not.toHaveBeenCalled();
  });

  it('abandons a server-capability response that returns after Disconnect', async () => {
    const request = gate();
    fetchServerInfo.mockImplementation(async () => {
      await request.promise;
      return SERVER_INFO;
    });

    connectSession('https://old.example');
    // Force the fallback request instead of using the already-cached connected server info.
    useSessionStore.setState({ serverInfo: null });
    const oldRun = startSync();
    await settle();
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);

    disconnectSession();
    request.open();
    await oldRun;

    expect(incrementalSync).not.toHaveBeenCalled();
    expect(syncContacts).not.toHaveBeenCalled();
  });

  it('still runs the WHOLE pipeline when a tracked run holds the slot', async () => {
    connectSession('https://tracked-slot.example');
    const background = gate();
    const tracked = runTrackedSync(() => background.promise);

    const foreground = startSync(); // the user opens the app / pulls to refresh mid-task
    expect(foreground).not.toBe(tracked);

    // Serialized, not concurrent: both walk the same cursor, so the foreground run waits.
    await settle();
    expect(syncAllChats).not.toHaveBeenCalled();

    background.open();
    await tracked;
    await foreground;

    // The steps the tracked run does NOT perform, and which used to be skipped entirely.
    expect(syncAllChats).toHaveBeenCalledTimes(1);
    expect(incrementalSync).toHaveBeenCalledTimes(1);
    expect(syncContacts).toHaveBeenCalledTimes(1);
  });

  /**
   * …but only within ONE session.
   *
   * `forget()` gives a dying sync 20 seconds and then wipes regardless, so on a large account the
   * previous server's run is routinely still in the slot when the user connects to the next one.
   * Coalescing on "a promise is present" handed `connect()` that doomed run as if it were the new
   * server's initial sync, so the new server never got one — and silently, because the old run
   * resolves normally and reports done over an empty inbox.
   */
  it('never hands a NEW session the run belonging to the previous account', async () => {
    const oldRun = gate();
    incrementalSync.mockImplementation(async () => {
      await oldRun.promise;
      return { chats: 0, messages: 0 };
    });

    connectSession('https://old.example');
    const forServerA = startSync();
    await settle();
    expect(syncAllChats).toHaveBeenCalledTimes(1); // A's run is genuinely under way

    // Disconnect + connect to a different server while A's run is still unwinding.
    disconnectSession();
    connectSession('https://new.example');
    const forServerB = startSync();
    expect(forServerB).not.toBe(forServerA);

    // Chained, not concurrent — both walk the same cursor, and both must stay visible to the drain.
    await settle();
    expect(syncAllChats).toHaveBeenCalledTimes(1);

    oldRun.open();
    await forServerA;
    await forServerB;
    // The new server got its OWN full pipeline run, which is what used to be skipped entirely.
    expect(syncAllChats).toHaveBeenCalledTimes(2);
  });

  /**
   * …and "one session" means one session INSTANCE, not one URL.
   *
   * Reconnecting to the SAME server is the ordinary reason people tap Disconnect — a changed
   * password, a rotated tunnel URL, an accidental tap — and `sanitizeServerAddress` is
   * deterministic, so the restored origin string is byte-identical. Keying on the origin therefore
   * matched the DEAD run twice over: `connect()` was handed it (so the new session never synced at
   * all — no first-sync branch, no chat-list refresh, no deletion catch-up, no contacts sync, no
   * spinner) AND the dead run's own abort check went false again, so its closing phases put the
   * pre-wipe chat snapshot back into the just-emptied DB and committed a marker over the wipe's
   * reset — an inbox of unnamed, message-less chats and a permanent history hole.
   */
  it('never hands a RE-CREATED session the previous run, even on the very same server', async () => {
    const SAME = 'https://gator.example';
    // A post-wipe reconnect finds a reset marker, so this is the FULL-sync branch — the one whose
    // closing phases write from memory and are gated on the abort check.
    getSyncMarker.mockResolvedValue({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    const doomedRun = gate();
    let deadRunShouldAbort: (() => boolean) | undefined;
    fullSync.mockImplementation(
      async (_db: unknown, _api: unknown, opts: { shouldAbort?: () => boolean }) => {
        deadRunShouldAbort ??= opts.shouldAbort;
        await doomedRun.promise;
        return { chats: 0, messages: 0 };
      },
    );

    connectSession(SAME);
    const doomed = startSync();
    await settle();
    expect(fullSync).toHaveBeenCalledTimes(1); // genuinely paging
    expect(deadRunShouldAbort?.()).toBe(false); // …under a live session

    disconnectSession(); // Disconnect: the wipe follows, the run keeps unwinding
    expect(deadRunShouldAbort?.()).toBe(true);

    connectSession(SAME); // …and back to the same server, identical origin string
    const fresh = startSync();
    expect(fresh).not.toBe(doomed);
    // The run belonging to the destroyed session must STAY disowned.
    expect(deadRunShouldAbort?.()).toBe(true);

    // Chained, not concurrent — both stay visible to the drain and neither pages alongside the other.
    await settle();
    expect(fullSync).toHaveBeenCalledTimes(1);

    doomedRun.open();
    await doomed;
    await fresh;
    // The reconnected session got its own full pipeline run.
    expect(fullSync).toHaveBeenCalledTimes(2);
    // The retired run must not launch contact work under the replacement account.
    expect(syncContacts).toHaveBeenCalledTimes(1);
  });

  it('a foreground run in flight is still shared by other foreground callers', async () => {
    connectSession('https://foreground-coalesce.example');
    const foregroundGate = gate();
    incrementalSync.mockImplementation(async () => {
      await foregroundGate.promise;
      return { chats: 0, messages: 0 };
    });

    const first = startSync();
    const second = startSync();
    expect(second).toBe(first); // coalesced — one run, not two syncs hammering the server

    foregroundGate.open();
    await first;
    expect(syncAllChats).toHaveBeenCalledTimes(1);
  });

  it('uses one pre-open account scope for both attachment-cache retirement phases', async () => {
    connectSession('https://cache-scope.example');
    const callOrder: string[] = [];
    mockEnsureDatabase.mockImplementationOnce(async () => {
      // The account lease must be captured before the first await can cross a Disconnect boundary.
      expect(mockCaptureRealtimeDeliveryLease).toHaveBeenCalledTimes(1);
      return mockSyncDb;
    });
    mockRetireInactiveEntries
      .mockImplementationOnce(async () => {
        callOrder.push('retire');
      })
      .mockImplementationOnce(async () => {
        callOrder.push('retire');
      });
    mockDrainDueRetirements
      .mockImplementationOnce(async () => {
        callOrder.push('drain');
      })
      .mockImplementationOnce(async () => {
        callOrder.push('drain');
      });

    await startSync();

    expect(mockCaptureRealtimeDeliveryLease).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentCacheAccountScope).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentCacheAccountScope).toHaveBeenCalledWith(mockAccountLease);
    expect(mockRetireInactiveEntries).toHaveBeenCalledTimes(2);
    expect(mockRetireInactiveEntries).toHaveBeenNthCalledWith(1, mockSyncDb, {
      scope: mockAttachmentCacheScope,
    });
    expect(mockRetireInactiveEntries).toHaveBeenNthCalledWith(2, mockSyncDb, {
      scope: mockAttachmentCacheScope,
    });
    expect(mockDrainDueRetirements).toHaveBeenCalledTimes(2);
    expect(mockDrainDueRetirements).toHaveBeenNthCalledWith(1, mockSyncDb, {
      scope: mockAttachmentCacheScope,
    });
    expect(mockDrainDueRetirements).toHaveBeenNthCalledWith(2, mockSyncDb, {
      scope: mockAttachmentCacheScope,
    });
    expect(callOrder).toEqual(['retire', 'drain', 'retire', 'drain']);
  });

  it('stops after account ownership expires without a session-epoch change', async () => {
    const request = gate();
    incrementalSync.mockImplementation(async () => {
      await request.promise;
      return { chats: 7, messages: 70 };
    });

    connectSession('https://lease-guarded.example');
    const running = startSync();
    await settle();
    expect(incrementalSync).toHaveBeenCalledTimes(1);
    expect(mockRetireInactiveEntries).toHaveBeenCalledTimes(1);
    expect(mockDrainDueRetirements).toHaveBeenCalledTimes(1);

    // Revoke only the realtime account lease: the session epoch deliberately stays unchanged.
    mockAccountLeaseCurrent = false;
    useSyncStore.getState().reset();
    useSyncStore.getState().begin();
    request.open();
    await running;

    expect(mockRetireInactiveEntries).toHaveBeenCalledTimes(1);
    expect(mockDrainDueRetirements).toHaveBeenCalledTimes(1);
    expect(syncContacts).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({
      status: 'syncing',
      chats: 0,
      messages: 0,
      error: null,
    });
  });
});
