/* Optional native setup must report degradation without rejecting realtime startup. */
const mockGetNotificationPermissionState = jest.fn<
  Promise<'not-determined' | 'denied' | 'granted'>,
  []
>();
const mockRegisterFcmToken = jest.fn<Promise<'registered' | 'skipped' | 'failed'>, []>();
const mockWarn = jest.fn();
type MockFeatureHydrationOptions = {
  shouldCommit?: () => boolean;
  onError?: (error: unknown) => void;
};
const mockFeatureHydrate = jest.fn<Promise<void>, [MockFeatureHydrationOptions?]>(
  async () => undefined,
);
let mockFeatureState = {
  hydrated: true,
  messageNotifications: true,
  filterUnknownSenders: false,
  hydrate: mockFeatureHydrate,
};
type MockDeliveryContext = {
  generation: number;
  isCurrent: () => boolean;
  isProviderCurrent?: () => boolean;
  durableEvent?: object;
  signal?: AbortSignal;
};
type MockAttachmentCacheRetirement = (context?: MockDeliveryContext) => Promise<void> | void;
type MockMessageStored = (
  messageId: number,
  source: 'socket' | 'fcm' | 'dev',
  context?: MockDeliveryContext,
) => Promise<void> | void;
type MockNotificationIntent = {
  kind: string;
  chatGuid?: string;
  [key: string]: unknown;
};
type MockNotifyIntent = (
  intent: MockNotificationIntent,
  context?: MockDeliveryContext,
) => void | Promise<void>;
type MockGroupBackgroundRefetch = (
  chatGuid: string,
  accountGeneration?: number,
) => void | Promise<void>;
let mockNotifyIntent: MockNotifyIntent | undefined;
let mockGroupBackgroundRefetch: MockGroupBackgroundRefetch | undefined;
let mockAttachmentCacheRetirement: MockAttachmentCacheRetirement | undefined;
let mockMessageStored: MockMessageStored | undefined;
const mockPostNotification = jest.fn<Promise<void>, [MockNotificationIntent, MockDeliveryContext?]>(
  async () => undefined,
);
const mockChatHasKnownSender = jest.fn<Promise<boolean>, [unknown, string]>(async () => true);
const mockEnsureSyncedBackgroundForRealtimeEvent = jest.fn<
  Promise<void>,
  [unknown, string, number?]
>(async () => undefined);
const mockAutoDownloadForRealtimeEvent = jest.fn(async () => ({
  savedImages: 0,
  destination: null,
}));
const mockAdoptRealtimeHeadlessEffect = jest.fn();
const mockSocketConnect = jest.fn();
const mockSocketDisconnect = jest.fn();
const mockSocketRetryConnection = jest.fn(() => true);
const mockStopSocketLifecycleObservation = jest.fn();
type MockSocketLifecycleEvent = {
  phase: 'connecting' | 'connected' | 'reconnecting' | 'error';
  recovered?: boolean;
};
let mockSocketLifecycleHandler: ((event: MockSocketLifecycleEvent) => void) | undefined;
let mockReachabilityCallbacks:
  | {
      onStateChange: (state: 'reachable' | 'unreachable' | 'error') => void;
      onRecovered: () => void;
    }
  | undefined;
let mockNetworkStateHandler: ((state: 'unknown' | 'online' | 'offline') => void) | undefined;
const mockStartReachabilityWatch = jest.fn(
  (
    _probe: (signal: AbortSignal) => Promise<unknown>,
    callbacks: NonNullable<typeof mockReachabilityCallbacks>,
  ) => {
    mockReachabilityCallbacks = callbacks;
  },
);
const mockStopReachabilityWatch = jest.fn();
const mockProbeReachabilityNow = jest.fn();
const mockStartDeviceNetworkWatch = jest.fn(
  (handler: NonNullable<typeof mockNetworkStateHandler>) => {
    mockNetworkStateHandler = handler;
  },
);
const mockStopDeviceNetworkWatch = jest.fn();
let mockTransportGeneration = 0;
let mockTransportNetwork: 'unknown' | 'online' | 'offline' = 'unknown';
let mockTransportActive = false;
const mockBeginTransportLifecycle = jest.fn(() => {
  mockTransportGeneration += 1;
  mockTransportNetwork = 'unknown';
  mockTransportActive = true;
  return mockTransportGeneration;
});
const mockSetTransportSocket = jest.fn<void, [number, string]>();
const mockSetTransportServer = jest.fn<void, [number, string]>();
const mockSetTransportNetwork = jest.fn<void, [number, 'unknown' | 'online' | 'offline']>(
  (_generation, state) => {
    mockTransportNetwork = state;
  },
);
const mockPauseTransport = jest.fn(() => {
  mockTransportGeneration += 1;
  mockTransportNetwork = 'unknown';
  mockTransportActive = false;
});
const mockRetryTransport = jest.fn<void, [number]>();
type MockSocketEventHandler = (
  eventName: string,
  rawData: unknown,
  source: string,
  context?: MockDeliveryContext,
  occurrence?: { transportOccurrenceId?: string },
) => Promise<unknown>;
let mockSocketEventHandler: MockSocketEventHandler | undefined;
const mockEnsureDatabase = jest.fn(async () => ({}));
const mockDurableHandle = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockDurableResume = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockDurablePersistWithoutDrain = jest.fn<Promise<unknown>, unknown[]>(async (...args) => ({
  event: { type: 'new-message' },
  queueId: 41,
  claim: { id: 41, source: 'dev', attempts: 1, leaseToken: args[5] },
}));
const mockDurableDispose = jest.fn();
const mockDurableConstruct = jest.fn();
const mockQueueHealth = jest.fn(async () => ({
  pending: 0,
  due: 0,
  leased: 0,
  dbAppliedPending: 0,
  completed: 4,
  poisoned: 0,
}));
const mockMaybeResumeSync = jest.fn();
const mockResumeScopedCredentialUpgrade = jest.fn(async () => ({ kind: 'idle' as const }));
const mockRecoverRealtimePrerequisite = jest.fn<
  Promise<'recovered' | 'unavailable' | 'stale' | 'timed-out'>,
  [unknown, { kind: string; chatGuid?: string }, number, unknown]
>(async () => 'recovered');
const mockAttachmentCacheScope = { testId: 'realtime-attachment-cache-scope' };
const mockCreateAttachmentCacheAccountScope = jest.fn<
  typeof mockAttachmentCacheScope,
  [unknown, MockDeliveryContext]
>(() => mockAttachmentCacheScope);
const mockRetireInactiveEntries = jest.fn<Promise<void>, [unknown, { scope: unknown }]>(
  async () => undefined,
);
const mockDrainDueRetirements = jest.fn<Promise<void>, [unknown, { scope: unknown }]>(
  async () => undefined,
);
let mockDispatcherOptions: { allowDevPersistWithoutDrain?: boolean } | undefined;
let mockDrainOptions:
  { onDependencyDeferred?: (context?: MockDeliveryContext) => void } | undefined;
let mockSession = {
  status: 'connected',
  origin: 'https://server.example',
  password: 'secret',
};
// A connected session always holds server info; killed-process FCM tests clear it explicitly.
const mockConnectedServerInfo = { rcs: false };
let mockSessionServerInfo: unknown = mockConnectedServerInfo;
const mockServerInfo = jest.fn<Promise<unknown>, [unknown, AbortSignal?]>();
const mockResolveAuthorizedRealtimeTransport = jest.fn<
  Promise<{ http: unknown; lease: { generation: number; isCurrent(): boolean } } | undefined>,
  [number?]
>(async () => undefined);
let mockEdgeProviderInfo: (() => unknown) | undefined;
let mockDbProviderInfo: (() => unknown) | undefined;
let mockRecoveryRequest:
  | ((
      chatGuid: string | null,
      context?: { generation: number; signal?: AbortSignal; isCurrent(): boolean },
    ) => Promise<void> | void)
  | undefined;
jest.mock('@core/api', () => ({
  serverApi: { ping: jest.fn(async () => undefined), serverInfo: mockServerInfo },
}));
jest.mock('@core/config', () => ({ strictServerOrigin: jest.fn((value) => value) }));
jest.mock('@core/secure', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));
jest.mock('@core/realtime', () => ({
  FCM_ENABLED: true,
  captureIncomingEvent: (eventName: string, rawData: unknown) => ({
    eventName,
    rawData: JSON.parse(JSON.stringify(rawData)),
  }),
  snapshotIncomingEvent: (eventName: string, rawData: unknown) =>
    eventName === 'new-server'
      ? {
          type: 'new-server',
          url:
            typeof rawData === 'string'
              ? rawData
              : ((rawData as { url?: string } | null)?.url ?? ''),
        }
      : eventName === 'new-message'
        ? { type: eventName, message: rawData }
        : { type: eventName },
  EventRouter: class {
    async handle(): Promise<void> {}
  },
}));
jest.mock('@db/repositories', () => ({
  chatHasKnownSender: mockChatHasKnownSender,
  getIncomingEventQueueHealth: mockQueueHealth,
  INCOMING_EVENT_DEPENDENCY_RETRY_MS: 5_000,
}));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => mockFeatureState,
  },
}));
jest.mock('@state/rcsHealthStore', () => ({
  useRcsHealthStore: { getState: () => ({ setAlert: jest.fn() }) },
}));
jest.mock('@state/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      ...mockSession,
      setServerUrl: jest.fn(),
    }),
  },
  sessionAccessors: { getServerInfo: () => mockSessionServerInfo },
}));
jest.mock('@state/transportHealthStore', () => ({
  useTransportHealthStore: {
    getState: () => ({
      generation: mockTransportGeneration,
      active: mockTransportActive,
      network: mockTransportNetwork,
      beginLifecycle: mockBeginTransportLifecycle,
      setSocketState: mockSetTransportSocket,
      setServerState: mockSetTransportServer,
      setNetworkState: mockSetTransportNetwork,
      retry: mockRetryTransport,
      pause: mockPauseTransport,
    }),
  },
}));
jest.mock('@state/typingStore', () => ({
  useTypingStore: { getState: () => ({ setTyping: jest.fn() }) },
}));
jest.mock('@/services/clients', () => ({
  http: {
    snapshotTransport: () => ({
      origin: 'https://server.example',
      password: 'secret',
      headers: {},
    }),
  },
}));
jest.mock('@/services/credentialUpgrade', () => ({
  resumeScopedCredentialUpgrade: mockResumeScopedCredentialUpgrade,
}));
jest.mock('@/services/backgrounds/realtimeSyncedBackground', () => ({
  ensureSyncedBackgroundForRealtimeEvent: mockEnsureSyncedBackgroundForRealtimeEvent,
}));
jest.mock('@/services/background/realtimePrerequisiteRecovery', () => ({
  recoverRealtimePrerequisite: mockRecoverRealtimePrerequisite,
}));
jest.mock('@/services/background/authorizedRealtimeTransport', () => ({
  resolveAuthorizedRealtimeTransport: mockResolveAuthorizedRealtimeTransport,
  resolveAuthorizedLockedFcmV3Transport: jest.fn(async () => undefined),
}));
jest.mock('@/services/background/realtimeHeadlessEffects', () => ({
  adoptRealtimeHeadlessEffect: mockAdoptRealtimeHeadlessEffect,
}));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: mockEnsureDatabase }));
jest.mock('@/services/syncControl', () => ({
  maybeResumeSync: mockMaybeResumeSync,
}));
jest.mock('@/services/download/autoDownloadAttachments', () => ({
  autoDownloadMessageAttachmentsForRealtimeEvent: mockAutoDownloadForRealtimeEvent,
}));
jest.mock('@/services/download/attachmentCacheAccountScope', () => ({
  createAttachmentCacheAccountScope: mockCreateAttachmentCacheAccountScope,
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {
    retireInactiveEntries: mockRetireInactiveEntries,
    drainDueRetirements: mockDrainDueRetirements,
  },
}));
jest.mock('@/services/reachability', () => ({
  startReachabilityWatch: mockStartReachabilityWatch,
  stopReachabilityWatch: mockStopReachabilityWatch,
  probeReachabilityNow: mockProbeReachabilityNow,
}));
jest.mock('@/services/networkReachability', () => ({
  startDeviceNetworkWatch: mockStartDeviceNetworkWatch,
  stopDeviceNetworkWatch: mockStopDeviceNetworkWatch,
}));
jest.mock('@/services/notifications/intents', () => ({ buildMessageIntents: jest.fn() }));
jest.mock('@/services/notifications/notifeeService', () => ({
  postNotification: mockPostNotification,
  getNotificationPermissionState: mockGetNotificationPermissionState,
}));
jest.mock('@/services/notifications/fcmMessaging', () => ({
  registerFcmToken: mockRegisterFcmToken,
}));

jest.mock('@/services/realtime/dbEventSink', () => ({
  DbEventSink: class {
    constructor(
      _db: unknown,
      onMessageStored?: MockMessageStored,
      onAttachmentCacheRetirement?: MockAttachmentCacheRetirement,
      onRecoveryNeeded?: typeof mockRecoveryRequest,
      getRcsProviderInfo?: () => unknown,
    ) {
      mockMessageStored = onMessageStored;
      mockAttachmentCacheRetirement = onAttachmentCacheRetirement;
      mockRecoveryRequest = onRecoveryNeeded;
      mockDbProviderInfo = getRcsProviderInfo;
    }
  },
}));

jest.mock('@/services/realtime/rcsProviderEpochEventSink', () => ({
  RcsProviderEpochEventSink: class {
    constructor(_inner: unknown, getServerInfo: () => unknown) {
      mockEdgeProviderInfo = getServerInfo;
    }
  },
}));

jest.mock('@/services/realtime/notifyingEventSink', () => ({
  NotifyingEventSink: class {
    constructor(_inner: unknown, _db: unknown, _buildIntents: unknown, notify: unknown) {
      mockNotifyIntent = notify as MockNotifyIntent;
    }
  },
}));

jest.mock('@/services/realtime/groupEventSideEffectSink', () => ({
  GroupEventSideEffectSink: class {
    constructor(_inner: unknown, refetchBackground: MockGroupBackgroundRefetch) {
      mockGroupBackgroundRefetch = refetchBackground;
    }
  },
}));

for (const moduleName of [
  '@/services/realtime/typingEventSink',
  '@/services/realtime/faceTimeEventSink',
  '@/services/realtime/serverUrlEventSink',
  '@/services/realtime/rcsAlertEventSink',
]) {
  jest.mock(moduleName, () => ({
    DbEventSink: class {},
    GroupEventSideEffectSink: class {},
    NotifyingEventSink: class {},
    TypingEventSink: class {},
    FaceTimeEventSink: class {},
    ServerUrlEventSink: class {},
    RcsAlertEventSink: class {},
  }));
}

jest.mock('@/services/realtime/incomingEventDrain', () => ({
  IncomingEventDrain: class {
    constructor(_db: unknown, _handler: unknown, _digest: unknown, options: unknown) {
      mockDrainOptions = options as typeof mockDrainOptions;
    }
  },
}));
jest.mock('@/services/realtime/incomingEventDispatcher', () => ({
  DurableRealtimeDispatcher: class {
    constructor(_db: unknown, _digest: unknown, _drain: unknown, options: unknown) {
      mockDurableConstruct();
      mockDispatcherOptions = options as { allowDevPersistWithoutDrain?: boolean };
    }
    handle(...args: unknown[]): Promise<void> {
      return mockDurableHandle(...args);
    }
    persistWithoutDrainForDev(...args: unknown[]): Promise<unknown> {
      return mockDurablePersistWithoutDrain(...args);
    }
    resume(...args: unknown[]): Promise<void> {
      return mockDurableResume(...args);
    }
    dispose(): void {
      mockDurableDispose();
    }
  },
}));
jest.mock('@/services/realtime/socketService', () => ({
  SocketService: class {
    connected = true;
    connect = mockSocketConnect;
    disconnect = mockSocketDisconnect;
    retryConnection = mockSocketRetryConnection;
    constructor(handler: MockSocketEventHandler) {
      mockSocketEventHandler = handler;
    }
    observeLifecycle(handler: (event: MockSocketLifecycleEvent) => void): () => void {
      mockSocketLifecycleHandler = handler;
      return mockStopSocketLifecycleObservation;
    }
  },
}));

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startFreshRealtime(): Promise<jest.Mock> {
  jest.resetModules();
  const reportIssue = jest.fn();
  const { startRealtime } = await import('@/services/realtimeControl');
  await expect(startRealtime({ reportIssue })).resolves.toBeUndefined();
  await settle();
  return reportIssue;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSocketEventHandler = undefined;
  mockSocketLifecycleHandler = undefined;
  mockReachabilityCallbacks = undefined;
  mockNetworkStateHandler = undefined;
  mockTransportGeneration = 0;
  mockTransportNetwork = 'unknown';
  mockTransportActive = false;
  mockBeginTransportLifecycle.mockClear();
  mockSetTransportSocket.mockClear();
  mockSetTransportServer.mockClear();
  mockSetTransportNetwork.mockClear();
  mockPauseTransport.mockClear();
  mockRetryTransport.mockClear();
  mockStartReachabilityWatch.mockClear();
  mockStopReachabilityWatch.mockClear();
  mockProbeReachabilityNow.mockClear();
  mockStartDeviceNetworkWatch.mockClear();
  mockStopDeviceNetworkWatch.mockClear();
  mockSocketDisconnect.mockClear();
  mockSocketRetryConnection.mockReset().mockReturnValue(true);
  mockStopSocketLifecycleObservation.mockClear();
  mockRecoveryRequest = undefined;
  mockSessionServerInfo = mockConnectedServerInfo;
  mockServerInfo.mockReset();
  mockResolveAuthorizedRealtimeTransport.mockReset().mockResolvedValue(undefined);
  mockEdgeProviderInfo = undefined;
  mockDbProviderInfo = undefined;
  mockDispatcherOptions = undefined;
  mockDrainOptions = undefined;
  mockNotifyIntent = undefined;
  mockGroupBackgroundRefetch = undefined;
  mockAttachmentCacheRetirement = undefined;
  mockMessageStored = undefined;
  mockFeatureHydrate.mockReset().mockResolvedValue(undefined);
  mockFeatureState = {
    hydrated: true,
    messageNotifications: true,
    filterUnknownSenders: false,
    hydrate: mockFeatureHydrate,
  };
  mockPostNotification.mockReset().mockResolvedValue(undefined);
  mockChatHasKnownSender.mockReset().mockResolvedValue(true);
  mockResumeScopedCredentialUpgrade.mockReset().mockResolvedValue({ kind: 'idle' });
  mockEnsureSyncedBackgroundForRealtimeEvent.mockReset().mockResolvedValue(undefined);
  mockRecoverRealtimePrerequisite.mockReset().mockResolvedValue('recovered');
  mockAutoDownloadForRealtimeEvent.mockReset().mockResolvedValue({
    savedImages: 0,
    destination: null,
  });
  mockAdoptRealtimeHeadlessEffect.mockReset().mockReturnValue({ status: 'absent' });
  mockSession = {
    status: 'connected',
    origin: 'https://server.example',
    password: 'secret',
  };
  mockEnsureDatabase.mockReset().mockResolvedValue({});
  mockDurableHandle.mockReset().mockResolvedValue(undefined);
  mockDurableResume.mockReset().mockResolvedValue(undefined);
  mockQueueHealth.mockResolvedValue({
    pending: 0,
    due: 0,
    leased: 0,
    dbAppliedPending: 0,
    completed: 4,
    poisoned: 0,
  });
  mockDurablePersistWithoutDrain.mockImplementation(async (...args: unknown[]) => ({
    event: { type: 'new-message' },
    queueId: 41,
    claim: { id: 41, source: 'dev', attempts: 1, leaseToken: args[5] },
  }));
  mockGetNotificationPermissionState.mockResolvedValue('granted');
  mockRegisterFcmToken.mockResolvedValue('registered');
});

const MESSAGE_INTENT: MockNotificationIntent = {
  kind: 'message',
  chatGuid: 'iMessage;-;notify-private-chat-71f3',
  title: 'notify-private-title-82a4',
  body: 'notify-private-body-93b5',
  sender: 'notify-private-sender-a4c6',
};

async function startAndCaptureNotifier(): Promise<MockNotifyIntent> {
  await startFreshRealtime();
  if (!mockNotifyIntent) throw new Error('NotifyingEventSink did not capture its notifier');
  return mockNotifyIntent;
}

async function startAndCaptureAttachmentCacheRetirement(): Promise<MockAttachmentCacheRetirement> {
  await startFreshRealtime();
  if (!mockAttachmentCacheRetirement) {
    throw new Error('DbEventSink did not capture its attachment-cache retirement callback');
  }
  return mockAttachmentCacheRetirement;
}

async function startAndCaptureMessageStored(): Promise<MockMessageStored> {
  await startFreshRealtime();
  if (!mockMessageStored)
    throw new Error('DbEventSink did not capture its message-stored callback');
  return mockMessageStored;
}

async function startAndCaptureGroupBackgroundRefetch(): Promise<MockGroupBackgroundRefetch> {
  await startFreshRealtime();
  if (!mockGroupBackgroundRefetch) {
    throw new Error('GroupEventSideEffectSink did not capture its background-refetch callback');
  }
  return mockGroupBackgroundRefetch;
}

function deliveryContext(durable = true): {
  context: MockDeliveryContext;
  retire: () => void;
} {
  let current = true;
  const context: MockDeliveryContext = {
    generation: 73,
    isCurrent: () => current,
  };
  if (durable) context.durableEvent = { queueId: 417 };
  return {
    context,
    retire: () => {
      current = false;
    },
  };
}

describe('realtime detached side-effect ownership', () => {
  it('keeps socket auto-download bound to the originating provider-aware event context', async () => {
    const onMessageStored = await startAndCaptureMessageStored();
    let providerCurrent = true;
    const context: MockDeliveryContext = {
      generation: 0,
      isCurrent: () => true,
      isProviderCurrent: () => providerCurrent,
    };
    mockAutoDownloadForRealtimeEvent.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { isEffectCurrent?: () => boolean } | undefined;
      const effectIsCurrent = options?.isEffectCurrent;
      expect(effectIsCurrent?.()).toBe(true);
      providerCurrent = false;
      expect(effectIsCurrent?.()).toBe(false);
      providerCurrent = true;
      expect(effectIsCurrent?.()).toBe(false);
      return { savedImages: 0, destination: null };
    });

    await onMessageStored(416, 'socket', context);

    expect(mockAutoDownloadForRealtimeEvent).toHaveBeenCalledWith(
      expect.any(Object),
      416,
      expect.any(Number),
      expect.objectContaining({ isEffectCurrent: expect.any(Function) }),
    );
  });

  it('adopts background-FCM auto-download into its bounded callback lifetime', async () => {
    const onMessageStored = await startAndCaptureMessageStored();
    const delivered = deliveryContext();
    let providerCurrent = true;
    const context = {
      ...delivered.context,
      generation: 0,
      isProviderCurrent: () => providerCurrent,
    };
    mockAdoptRealtimeHeadlessEffect.mockImplementationOnce(
      (
        _generation: number,
        _key: string,
        effect: (lifetime: MockDeliveryContext) => Promise<unknown>,
      ) => ({
        status: 'adopted',
        task: effect({ generation: context.generation, isCurrent: () => true }),
      }),
    );
    mockAutoDownloadForRealtimeEvent.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { isEffectCurrent?: () => boolean } | undefined;
      const effectIsCurrent = options?.isEffectCurrent;
      expect(effectIsCurrent?.()).toBe(true);
      providerCurrent = false;
      expect(effectIsCurrent?.()).toBe(false);
      providerCurrent = true;
      expect(effectIsCurrent?.()).toBe(false);
      return { savedImages: 0, destination: null };
    });

    await onMessageStored(417, 'fcm', context);

    expect(mockAdoptRealtimeHeadlessEffect).toHaveBeenCalledWith(
      context.generation,
      'auto-download:417',
      expect.any(Function),
    );
    expect(mockAutoDownloadForRealtimeEvent).toHaveBeenCalledWith(
      expect.any(Object),
      417,
      expect.any(Number),
      expect.objectContaining({
        isEffectCurrent: expect.any(Function),
        allowExternalMediaSave: false,
      }),
    );
  });

  it('does not escape an expired background callback into a fresh detached download', async () => {
    const onMessageStored = await startAndCaptureMessageStored();
    const delivered = deliveryContext();
    const context = { ...delivered.context, generation: 0 };
    mockAdoptRealtimeHeadlessEffect.mockReturnValueOnce({ status: 'rejected' });

    await onMessageStored(418, 'fcm', context);

    expect(mockAdoptRealtimeHeadlessEffect).toHaveBeenCalledWith(
      context.generation,
      'auto-download:418',
      expect.any(Function),
    );
    expect(mockAutoDownloadForRealtimeEvent).not.toHaveBeenCalled();
  });

  it('does not use the detached fallback after an expired callback collection is gone', async () => {
    const onMessageStored = await startAndCaptureMessageStored();
    const delivered = deliveryContext();
    const context = { ...delivered.context, generation: 0 };
    mockAdoptRealtimeHeadlessEffect.mockReturnValueOnce({ status: 'absent' });
    delivered.retire();

    await onMessageStored(419, 'fcm', context);

    expect(mockAdoptRealtimeHeadlessEffect).toHaveBeenCalledWith(
      context.generation,
      'auto-download:419',
      expect.any(Function),
    );
    expect(mockAutoDownloadForRealtimeEvent).not.toHaveBeenCalled();
  });

  it('starts wallpaper refresh with a fresh account lease, not the retiring attempt context', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    mockEnsureSyncedBackgroundForRealtimeEvent.mockImplementationOnce(async () => {
      started.resolve(undefined);
      await finish.promise;
    });
    const refetchBackground = await startAndCaptureGroupBackgroundRefetch();
    const { context, retire } = deliveryContext();

    const run = Promise.resolve(refetchBackground('chat-background-lease', context.generation));
    await started.promise;
    retire();
    finish.resolve(undefined);
    await expect(run).resolves.toBeUndefined();

    expect(context.isCurrent()).toBe(false);
    expect(mockEnsureSyncedBackgroundForRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(mockEnsureSyncedBackgroundForRealtimeEvent.mock.calls[0]).toHaveLength(3);
    expect(mockEnsureSyncedBackgroundForRealtimeEvent.mock.calls[0]?.[1]).toBe(
      'chat-background-lease',
    );
    expect(mockEnsureSyncedBackgroundForRealtimeEvent.mock.calls[0]?.[2]).toBe(73);
  });
});

describe('realtime notification callback ownership', () => {
  it('forwards an ordinary message intent exactly', async () => {
    const notify = await startAndCaptureNotifier();
    const { context } = deliveryContext();

    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).resolves.toBeUndefined();

    expect(mockPostNotification).toHaveBeenCalledTimes(1);
    expect(mockPostNotification).toHaveBeenCalledWith(MESSAGE_INTENT, context);
  });

  it('rejects a durable message while feature settings remain unavailable, then retries exactly', async () => {
    mockFeatureState.hydrated = false;
    const notify = await startAndCaptureNotifier();
    const { context } = deliveryContext();

    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).rejects.toMatchObject({
      name: 'RealtimeNotificationSettingsUnavailableError',
      message: 'notification settings are not hydrated yet',
    });
    expect(mockFeatureHydrate).toHaveBeenCalledTimes(1);
    expect(mockPostNotification).not.toHaveBeenCalled();

    mockFeatureState.hydrated = true;
    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).resolves.toBeUndefined();
    expect(mockPostNotification).toHaveBeenCalledTimes(1);
    expect(mockPostNotification).toHaveBeenCalledWith(MESSAGE_INTENT, context);
  });

  it('hydrates current feature settings before posting the exact durable message', async () => {
    mockFeatureState.hydrated = false;
    mockFeatureHydrate.mockImplementationOnce(async () => {
      mockFeatureState.hydrated = true;
    });
    const notify = await startAndCaptureNotifier();
    const { context } = deliveryContext();

    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).resolves.toBeUndefined();

    expect(mockFeatureHydrate).toHaveBeenCalledTimes(1);
    const options = mockFeatureHydrate.mock.calls[0]?.[0];
    expect(options?.shouldCommit?.()).toBe(true);
    expect(mockPostNotification).toHaveBeenCalledWith(MESSAGE_INTENT, context);
  });

  it('suppresses a message when the hydrated notification toggle is off', async () => {
    mockFeatureState.messageNotifications = false;
    const notify = await startAndCaptureNotifier();

    await expect(Promise.resolve(notify(MESSAGE_INTENT))).resolves.toBeUndefined();

    expect(mockFeatureHydrate).not.toHaveBeenCalled();
    expect(mockPostNotification).not.toHaveBeenCalled();
  });

  it('suppresses a message whose sender is not known', async () => {
    mockFeatureState.filterUnknownSenders = true;
    mockChatHasKnownSender.mockResolvedValueOnce(false);
    const notify = await startAndCaptureNotifier();

    await expect(Promise.resolve(notify(MESSAGE_INTENT))).resolves.toBeUndefined();

    expect(mockChatHasKnownSender).toHaveBeenCalledWith(expect.anything(), MESSAGE_INTENT.chatGuid);
    expect(mockPostNotification).not.toHaveBeenCalled();
  });

  it('fails open when the known-sender lookup rejects', async () => {
    const failure = new Error('notify-private-known-sender-read-d7f9');
    mockFeatureState.filterUnknownSenders = true;
    mockChatHasKnownSender.mockRejectedValueOnce(failure);
    const notify = await startAndCaptureNotifier();
    const { context } = deliveryContext();

    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      '[notify] known-sender check failed — notifying anyway',
      failure,
    );
    expect(mockPostNotification).toHaveBeenCalledWith(MESSAGE_INTENT, context);
  });

  it('propagates one durable native failure after a successful known-sender lookup', async () => {
    const failure = new Error('notify-private-native-post-e8a0');
    mockFeatureState.filterUnknownSenders = true;
    mockChatHasKnownSender.mockResolvedValueOnce(true);
    mockPostNotification.mockRejectedValueOnce(failure);
    const notify = await startAndCaptureNotifier();
    const { context } = deliveryContext();

    await expect(Promise.resolve(notify(MESSAGE_INTENT, context))).rejects.toBe(failure);

    expect(mockChatHasKnownSender).toHaveBeenCalledTimes(1);
    expect(mockPostNotification).toHaveBeenCalledTimes(1);
    expect(mockPostNotification).toHaveBeenCalledWith(MESSAGE_INTENT, context);
    expect(mockWarn).toHaveBeenCalledWith('[notify] failed to post notification', {
      kind: 'message',
      error: failure,
    });
  });

  it.each(['feature hydration', 'known-sender lookup'] as const)(
    'suppresses a stale message after deferred %s',
    async (deferredStep) => {
      let releasePending!: () => void;
      if (deferredStep === 'feature hydration') {
        const hydration = deferred<void>();
        mockFeatureState.hydrated = false;
        mockFeatureHydrate.mockReturnValueOnce(hydration.promise);
        releasePending = () => hydration.resolve(undefined);
      } else {
        const lookup = deferred<boolean>();
        mockFeatureState.filterUnknownSenders = true;
        mockChatHasKnownSender.mockReturnValueOnce(lookup.promise);
        releasePending = () => lookup.resolve(true);
      }
      const notify = await startAndCaptureNotifier();
      const { context, retire } = deliveryContext();

      const run = Promise.resolve(notify(MESSAGE_INTENT, context));
      await settle();
      if (deferredStep === 'feature hydration') {
        expect(mockFeatureHydrate).toHaveBeenCalledTimes(1);
      } else {
        expect(mockChatHasKnownSender).toHaveBeenCalledTimes(1);
      }
      retire();
      releasePending();
      await expect(run).resolves.toBeUndefined();

      expect(mockPostNotification).not.toHaveBeenCalled();
    },
  );
});

describe('startRealtime optional setup containment', () => {
  it('runs the durable recovery trigger during real startup', async () => {
    await startFreshRealtime();

    expect(mockDurableResume).toHaveBeenCalledWith(
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
  });

  it('uses the exact durable context and one scope for realtime cache retirement', async () => {
    const db = { testId: 'realtime-cache-db' };
    const callOrder: string[] = [];
    mockEnsureDatabase.mockResolvedValueOnce(db);
    mockRetireInactiveEntries.mockImplementationOnce(async () => {
      callOrder.push('retire');
    });
    mockDrainDueRetirements.mockImplementationOnce(async () => {
      callOrder.push('drain');
    });
    const retireAttachmentCache = await startAndCaptureAttachmentCacheRetirement();
    const { context } = deliveryContext();

    await expect(Promise.resolve(retireAttachmentCache(context))).resolves.toBeUndefined();

    expect(mockCreateAttachmentCacheAccountScope).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentCacheAccountScope).toHaveBeenCalledWith(context);
    expect(mockRetireInactiveEntries).toHaveBeenCalledTimes(1);
    expect(mockRetireInactiveEntries).toHaveBeenCalledWith(db, {
      scope: mockAttachmentCacheScope,
    });
    expect(mockDrainDueRetirements).toHaveBeenCalledTimes(1);
    expect(mockDrainDueRetirements).toHaveBeenCalledWith(db, {
      scope: mockAttachmentCacheScope,
    });
    expect(callOrder).toEqual(['retire', 'drain']);
  });

  it('does no cache cleanup without a current realtime delivery context', async () => {
    const retireAttachmentCache = await startAndCaptureAttachmentCacheRetirement();
    const { context, retire } = deliveryContext();
    retire();

    await expect(Promise.resolve(retireAttachmentCache())).resolves.toBeUndefined();
    await expect(Promise.resolve(retireAttachmentCache(context))).resolves.toBeUndefined();

    expect(mockCreateAttachmentCacheAccountScope).not.toHaveBeenCalled();
    expect(mockRetireInactiveEntries).not.toHaveBeenCalled();
    expect(mockDrainDueRetirements).not.toHaveBeenCalled();
  });

  it('uses task-local account recovery without changing reconnect throttling', async () => {
    jest.resetModules();
    const { resumeRealtime, startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    await settle();
    if (!mockRecoveryRequest) throw new Error('DB sink did not register its recovery callback');
    const callback = new AbortController();
    let callbackCurrent = true;
    const context = {
      generation: 0,
      signal: callback.signal,
      isCurrent: () => callbackCurrent,
    };

    await mockRecoveryRequest(null, context);
    await settle();

    expect(mockRecoverRealtimePrerequisite).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'sync-account' },
      0,
      expect.objectContaining({
        isAllowed: expect.any(Function),
        subscribeInvalidation: expect.any(Function),
      }),
    );
    expect(mockMaybeResumeSync).not.toHaveBeenCalled();

    const recoveryOptions = mockRecoverRealtimePrerequisite.mock.calls[0]?.[3] as
      | {
          isAllowed(): boolean;
          subscribeInvalidation(invalidate: () => void): () => void;
        }
      | undefined;
    expect(recoveryOptions?.isAllowed()).toBe(true);
    callbackCurrent = false;
    expect(recoveryOptions?.isAllowed()).toBe(false);
    const invalidate = jest.fn();
    const release = recoveryOptions?.subscribeInvalidation(invalidate);
    callback.abort();
    expect(invalidate).toHaveBeenCalledTimes(1);
    release?.();

    await resumeRealtime();
    expect(mockMaybeResumeSync).toHaveBeenCalledTimes(1);
  });

  it.each(['delay-first', 'recovery-first'] as const)(
    'keeps FCM alive until both recovery and its due delay complete (%s)',
    async (order) => {
      jest.useFakeTimers();
      try {
        const recovery = deferred<'recovered'>();
        mockRecoverRealtimePrerequisite.mockReturnValueOnce(recovery.promise);
        mockDurableHandle.mockImplementationOnce(async (...args: unknown[]) => {
          if (!mockRecoveryRequest)
            throw new Error('DB sink did not register its recovery callback');
          await mockRecoveryRequest('cHeadlessRecovery', args[3] as MockDeliveryContext);
          mockDrainOptions?.onDependencyDeferred?.(args[3] as MockDeliveryContext);
        });
        jest.resetModules();
        const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');

        let settled = false;
        const dispatch = dispatchRealtimeEvent(
          'new-message',
          { guid: 'headless-recovery' },
          'fcm',
        ).then(() => {
          settled = true;
        });
        await settle();

        expect(mockRecoverRealtimePrerequisite).toHaveBeenCalledWith(
          expect.anything(),
          { kind: 'sync-chat', chatGuid: 'cHeadlessRecovery' },
          0,
          expect.objectContaining({
            isAllowed: expect.any(Function),
            subscribeInvalidation: expect.any(Function),
          }),
        );
        expect(settled).toBe(false);
        expect(mockDurableResume).not.toHaveBeenCalled();

        if (order === 'delay-first') {
          jest.advanceTimersByTime(5_000);
          await settle();
          expect(mockDurableResume).not.toHaveBeenCalled();
          recovery.resolve('recovered');
        } else {
          recovery.resolve('recovered');
          await settle();
          jest.advanceTimersByTime(4_999);
          await settle();
          expect(mockDurableResume).not.toHaveBeenCalled();
          jest.advanceTimersByTime(1);
        }
        await expect(dispatch).resolves.toBeUndefined();
        expect(mockDurableResume).toHaveBeenCalledWith(
          expect.objectContaining({ generation: 0, isCurrent: expect.any(Function) }),
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('cancels an FCM dependency delay when the account generation retires', async () => {
    jest.useFakeTimers();
    try {
      mockDurableHandle.mockImplementationOnce(async (...args: unknown[]) => {
        if (!mockRecoveryRequest) throw new Error('DB sink did not register its recovery callback');
        await mockRecoveryRequest('cRetiredRecovery', args[3] as MockDeliveryContext);
        mockDrainOptions?.onDependencyDeferred?.(args[3] as MockDeliveryContext);
      });
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const { pauseRealtimeDeliveries, resumeRealtimeDeliveries } =
        await import('@/services/realtime/deliveryCoordinator');
      const dispatch = dispatchRealtimeEvent('new-message', { guid: 'retired-recovery' }, 'fcm');
      await settle();

      const retirement = pauseRealtimeDeliveries();
      await expect(dispatch).resolves.toBeUndefined();
      await expect(retirement).resolves.toBeUndefined();
      expect(mockDurableResume).not.toHaveBeenCalled();
      resumeRealtimeDeliveries();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a wait-only FCM dependency without starting network recovery', async () => {
    jest.useFakeTimers();
    try {
      mockDurableHandle.mockImplementationOnce(async (...args: unknown[]) => {
        mockDrainOptions?.onDependencyDeferred?.(args[3] as MockDeliveryContext);
      });
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const dispatch = dispatchRealtimeEvent(
        'message-send-error',
        { guid: 'wait-only-dependency' },
        'fcm',
      );
      await settle();

      expect(mockRecoverRealtimePrerequisite).not.toHaveBeenCalled();
      expect(mockDurableResume).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5_000);

      await expect(dispatch).resolves.toBeUndefined();
      expect(mockDurableResume).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not connect a stale startup after realtime pauses while the database opens', async () => {
    const databaseOpen = deferred<object>();
    mockEnsureDatabase.mockReturnValueOnce(databaseOpen.promise);
    jest.resetModules();
    const { pauseRealtime, startRealtime } = await import('@/services/realtimeControl');

    const startup = startRealtime();
    await settle();
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
    pauseRealtime();
    databaseOpen.resolve({});

    await expect(startup).resolves.toBeUndefined();
    expect(mockSocketConnect).not.toHaveBeenCalled();
  });

  it('does not open the database after a foreground pause wins during credential recovery', async () => {
    const credentialRecovery = deferred<{ kind: 'idle' }>();
    mockResumeScopedCredentialUpgrade.mockReturnValueOnce(credentialRecovery.promise);
    jest.resetModules();
    const { pauseRealtime, startRealtime } = await import('@/services/realtimeControl');

    const startup = startRealtime();
    await settle();
    expect(mockResumeScopedCredentialUpgrade).toHaveBeenCalledWith({ restartRealtime: false });
    expect(mockEnsureDatabase).not.toHaveBeenCalled();

    pauseRealtime();
    credentialRecovery.resolve({ kind: 'idle' });

    await expect(startup).resolves.toBeUndefined();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockSocketConnect).not.toHaveBeenCalled();
  });

  it('does not let an older startup continue under a later foreground resume intent', async () => {
    const sharedCredentialRecovery = deferred<{ kind: 'idle' }>();
    mockResumeScopedCredentialUpgrade.mockReturnValue(sharedCredentialRecovery.promise);
    jest.resetModules();
    const realtime = await import('@/services/realtimeControl');

    const firstStartup = realtime.startRealtime();
    await settle();
    expect(mockResumeScopedCredentialUpgrade).toHaveBeenCalledTimes(1);
    expect(mockEnsureDatabase).not.toHaveBeenCalled();

    realtime.pauseRealtime();
    const currentResume = realtime.resumeRealtime();
    await settle();
    expect(mockResumeScopedCredentialUpgrade).toHaveBeenCalledTimes(2);
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockSocketConnect).not.toHaveBeenCalled();

    sharedCredentialRecovery.resolve({ kind: 'idle' });
    await expect(Promise.all([firstStartup, currentResume])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(mockResumeScopedCredentialUpgrade).toHaveBeenCalledTimes(2);
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(2);
    expect(mockSocketConnect).toHaveBeenCalledTimes(1);
  });

  it('reopens a foreground startup after credential recovery pauses only its old transport', async () => {
    jest.resetModules();
    const realtime = await import('@/services/realtimeControl');
    mockResumeScopedCredentialUpgrade.mockImplementationOnce(async () => {
      realtime.pauseRealtimeForCredentialUpgrade();
      return { kind: 'idle' };
    });

    await expect(realtime.startRealtime()).resolves.toBeUndefined();

    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
    expect(mockSocketConnect).toHaveBeenCalledTimes(1);
  });

  it('does not let credential recovery claim a new foreground intent after a real pause', async () => {
    jest.resetModules();
    const realtime = await import('@/services/realtimeControl');

    realtime.pauseRealtime();
    await expect(realtime.resumeRealtimeAfterCredentialUpgrade()).resolves.toBeUndefined();

    expect(mockResumeScopedCredentialUpgrade).not.toHaveBeenCalled();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockSocketConnect).not.toHaveBeenCalled();
  });

  it('restarts a credential-paused foreground transport without recursively recovering credentials', async () => {
    jest.resetModules();
    const realtime = await import('@/services/realtimeControl');
    await realtime.startRealtime();
    realtime.pauseRealtimeForCredentialUpgrade();
    jest.clearAllMocks();

    await expect(realtime.resumeRealtimeAfterCredentialUpgrade()).resolves.toBeUndefined();

    expect(mockResumeScopedCredentialUpgrade).not.toHaveBeenCalled();
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(2);
    expect(mockSocketConnect).toHaveBeenCalledTimes(1);
  });

  it('retires the certified socket open when a transport observer pauses startup re-entrantly', async () => {
    jest.resetModules();
    const realtime = await import('@/services/realtimeControl');
    mockBeginTransportLifecycle.mockImplementationOnce(() => {
      mockTransportGeneration += 1;
      realtime.pauseRealtime();
      return mockTransportGeneration;
    });

    await expect(realtime.startRealtime()).resolves.toBeUndefined();

    expect(mockSocketConnect).toHaveBeenCalledTimes(1);
    expect(mockSocketDisconnect).toHaveBeenCalledTimes(1);
    expect(mockStopReachabilityWatch).toHaveBeenCalled();
    expect(mockStopDeviceNetworkWatch).toHaveBeenCalled();
  });

  it('publishes socket, server, and device-network signals under one transport generation', async () => {
    jest.resetModules();
    const { startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    await settle();
    expect(mockSocketConnect).toHaveBeenCalledWith('https://server.example', 'secret', {
      headers: {},
    });
    if (!mockSocketLifecycleHandler)
      throw new Error('socket lifecycle observer was not registered');
    if (!mockReachabilityCallbacks) throw new Error('reachability observer was not registered');
    if (!mockNetworkStateHandler) throw new Error('network observer was not registered');

    expect(mockBeginTransportLifecycle).toHaveBeenCalledTimes(1);
    expect(mockStartReachabilityWatch).toHaveBeenCalledTimes(1);
    expect(mockStartDeviceNetworkWatch).toHaveBeenCalledTimes(1);

    mockSocketLifecycleHandler({ phase: 'connecting' });
    mockReachabilityCallbacks.onStateChange('unreachable');
    mockNetworkStateHandler('offline');
    mockSocketLifecycleHandler({ phase: 'connected', recovered: true });

    expect(mockSetTransportSocket.mock.calls).toEqual([
      [1, 'connecting'],
      [1, 'connected'],
    ]);
    expect(mockSetTransportServer).toHaveBeenCalledWith(1, 'unreachable');
    expect(mockSetTransportNetwork).toHaveBeenCalledWith(1, 'offline');
    expect(mockMaybeResumeSync).toHaveBeenCalledTimes(1);
  });

  it('immediately re-probes the server when the native network recovers', async () => {
    jest.resetModules();
    const { startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    if (!mockNetworkStateHandler) throw new Error('network observer was not registered');

    mockNetworkStateHandler('offline');
    mockNetworkStateHandler('online');

    expect(mockProbeReachabilityNow).toHaveBeenCalledTimes(1);
  });

  it('manually retries only the current foreground transport and re-probes immediately', async () => {
    jest.resetModules();
    const { pauseRealtime, retryRealtimeConnection, startRealtime } =
      await import('@/services/realtimeControl');
    await startRealtime();
    await settle();
    mockEnsureDatabase.mockClear();
    mockSocketRetryConnection.mockClear();
    mockRetryTransport.mockClear();
    mockProbeReachabilityNow.mockClear();

    expect(retryRealtimeConnection()).toBe(true);
    expect(mockSocketRetryConnection).toHaveBeenCalledTimes(1);
    expect(mockRetryTransport).toHaveBeenCalledWith(1);
    expect(mockProbeReachabilityNow).toHaveBeenCalledTimes(1);
    expect(mockEnsureDatabase).not.toHaveBeenCalled();

    pauseRealtime();
    mockSocketRetryConnection.mockClear();
    expect(retryRealtimeConnection()).toBe(false);
    expect(mockSocketRetryConnection).not.toHaveBeenCalled();
    expect(mockProbeReachabilityNow).toHaveBeenCalledTimes(1);
  });

  it('does not clear health or probe when the socket cannot accept a manual retry', async () => {
    jest.resetModules();
    const { retryRealtimeConnection, startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    mockSocketRetryConnection.mockReturnValueOnce(false);
    mockRetryTransport.mockClear();
    mockProbeReachabilityNow.mockClear();

    expect(retryRealtimeConnection()).toBe(false);
    expect(mockRetryTransport).not.toHaveBeenCalled();
    expect(mockProbeReachabilityNow).not.toHaveBeenCalled();
  });

  it('keeps healthy transport observers current across a redundant foreground resume', async () => {
    jest.resetModules();
    const { resumeRealtime, startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    if (!mockSocketLifecycleHandler)
      throw new Error('socket lifecycle observer was not registered');
    if (!mockReachabilityCallbacks) throw new Error('reachability observer was not registered');
    if (!mockNetworkStateHandler) throw new Error('network observer was not registered');
    const retainedSocketObserver = mockSocketLifecycleHandler;
    const retainedReachabilityObserver = mockReachabilityCallbacks.onStateChange;
    const retainedNetworkObserver = mockNetworkStateHandler;
    mockSetTransportSocket.mockClear();
    mockSetTransportServer.mockClear();
    mockSetTransportNetwork.mockClear();

    await resumeRealtime();
    retainedSocketObserver({ phase: 'reconnecting' });
    retainedReachabilityObserver('unreachable');
    retainedNetworkObserver('offline');

    expect(mockBeginTransportLifecycle).toHaveBeenCalledTimes(1);
    expect(mockSetTransportSocket).toHaveBeenCalledWith(1, 'reconnecting');
    expect(mockSetTransportServer).toHaveBeenCalledWith(1, 'unreachable');
    expect(mockSetTransportNetwork).toHaveBeenCalledWith(1, 'offline');
  });

  it('pauses health, stops both monitors, and rejects retained lifecycle callbacks', async () => {
    jest.resetModules();
    const { pauseRealtime, startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    if (!mockSocketLifecycleHandler)
      throw new Error('socket lifecycle observer was not registered');
    const retainedSocketObserver = mockSocketLifecycleHandler;
    mockPauseTransport.mockClear();
    mockStopReachabilityWatch.mockClear();
    mockStopDeviceNetworkWatch.mockClear();
    mockSocketDisconnect.mockClear();
    mockSetTransportSocket.mockClear();

    pauseRealtime();
    retainedSocketObserver({ phase: 'error' });

    expect(mockPauseTransport).toHaveBeenCalledTimes(1);
    expect(mockStopReachabilityWatch).toHaveBeenCalledTimes(1);
    expect(mockStopDeviceNetworkWatch).toHaveBeenCalledTimes(1);
    expect(mockSocketDisconnect).toHaveBeenCalledTimes(1);
    expect(mockPauseTransport.mock.invocationCallOrder[0]!).toBeLessThan(
      mockStopReachabilityWatch.mock.invocationCallOrder[0]!,
    );
    expect(mockStopReachabilityWatch.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSocketDisconnect.mock.invocationCallOrder[0]!,
    );
    expect(mockStopDeviceNetworkWatch.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSocketDisconnect.mock.invocationCallOrder[0]!,
    );
    expect(mockStopSocketLifecycleObservation).toHaveBeenCalledTimes(1);
    expect(mockSetTransportSocket).not.toHaveBeenCalled();
  });

  it('finishes a foreground pause when native socket disconnect throws', async () => {
    jest.resetModules();
    const { pauseRealtime, startRealtime } = await import('@/services/realtimeControl');
    await startRealtime();
    mockSocketDisconnect.mockImplementationOnce(() => {
      throw new Error('native disconnect sentinel');
    });

    expect(() => pauseRealtime()).not.toThrow();

    expect(mockPauseTransport).toHaveBeenCalled();
    expect(mockStopReachabilityWatch).toHaveBeenCalled();
    expect(mockStopDeviceNetworkWatch).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('[socket] foreground retirement failed', {
      errorName: 'Error',
    });
  });

  it('contains a native permission-status rejection and reports safe degraded copy', async () => {
    const failure = new Error('native permission bridge failed');
    mockGetNotificationPermissionState.mockRejectedValueOnce(failure);

    const reportIssue = await startFreshRealtime();

    expect(mockWarn).toHaveBeenCalledWith('[notify] notification permission check failed', failure);
    expect(reportIssue).toHaveBeenCalledWith({
      stage: 'notifications',
      level: 'degraded',
      code: 'notification-permission-unavailable',
      userMessage: 'Notifications are unavailable; open Gator to see new messages.',
    });
  });

  it('reports a denied permission without rejecting socket startup', async () => {
    mockGetNotificationPermissionState.mockResolvedValueOnce('denied');

    const reportIssue = await startFreshRealtime();

    expect(reportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'notifications',
        code: 'notification-permission-denied',
      }),
    );
  });

  it('reports an unrequested permission without launching a native prompt', async () => {
    mockGetNotificationPermissionState.mockResolvedValueOnce('not-determined');

    const reportIssue = await startFreshRealtime();

    expect(reportIssue).toHaveBeenCalledWith({
      stage: 'notifications',
      level: 'degraded',
      code: 'notification-permission-not-requested',
      userMessage: 'Notifications are off. Enable them during setup or in Settings.',
    });
  });

  it('reports failed FCM token registration as degraded socket-only operation', async () => {
    mockRegisterFcmToken.mockResolvedValueOnce('failed');

    const reportIssue = await startFreshRealtime();

    expect(reportIssue).toHaveBeenCalledWith({
      stage: 'fcm',
      level: 'degraded',
      code: 'fcm-token-registration-failed',
      userMessage: 'Push updates are unavailable. Check Live Updates in Settings.',
    });
  });

  it('forwards dev account and occurrence metadata into durable dispatch', async () => {
    const { devPush } = await import('@/services/realtimeControl');
    const context = { generation: 0, isCurrent: () => true };
    const occurrence = { transportOccurrenceId: 'dev:message-1' };
    const payload = { guid: 'message-1' };

    await devPush.inject('new-message', payload, context, occurrence);

    expect(mockDurableHandle).toHaveBeenCalledWith(
      'new-message',
      payload,
      'dev',
      context,
      occurrence,
      expect.any(Number),
    );
  });

  it('passes socket events through the explicit public durable-dispatch callback', async () => {
    await startFreshRealtime();
    if (!mockSocketEventHandler) throw new Error('socket did not receive its dispatch callback');
    const context = { generation: 0, isCurrent: () => true };
    const occurrence = { transportOccurrenceId: 'socket:explicit-handoff:1' };
    const payload = { guid: 'socket-explicit-handoff' };

    await mockSocketEventHandler('new-message', payload, 'socket', context, occurrence);

    expect(mockDurableHandle).toHaveBeenCalledWith(
      'new-message',
      payload,
      'socket',
      context,
      occurrence,
      expect.any(Number),
    );
  });

  it('snapshots a public callback payload before waiting for the database', async () => {
    const databaseOpen = deferred<object>();
    mockEnsureDatabase.mockReturnValueOnce(databaseOpen.promise);
    jest.resetModules();
    const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
    const payload = {
      guid: 'public-snapshot',
      text: 'before mutation',
      dateCreated: 1,
      chats: [{ guid: 'snapshot-chat' }],
    };
    const occurrence = {
      serverEventId: 'server-before-mutation',
      transportOccurrenceId: 'dev:before-mutation',
      receivedAt: 1_234,
    };
    const dispatch = dispatchRealtimeEvent('new-message', payload, 'dev', undefined, occurrence);

    payload.text = 'after mutation';
    payload.chats[0]!.guid = 'mutated-chat';
    occurrence.serverEventId = 'server-after-mutation';
    occurrence.transportOccurrenceId = 'dev:after-mutation';
    occurrence.receivedAt = 9_999;
    databaseOpen.resolve({});
    await expect(dispatch).resolves.toBeUndefined();

    expect(mockDurableHandle).toHaveBeenCalledWith(
      'new-message',
      expect.objectContaining({
        guid: 'public-snapshot',
        text: 'before mutation',
        chats: [expect.objectContaining({ guid: 'snapshot-chat' })],
      }),
      'dev',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      {
        serverEventId: 'server-before-mutation',
        transportOccurrenceId: 'dev:before-mutation',
      },
      1_234,
    );
  });

  it('adopts a supplied context into the teardown drain before durable dispatch', async () => {
    const durableWrite = deferred<void>();
    mockDurableHandle.mockReturnValueOnce(durableWrite.promise);
    jest.resetModules();
    const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
    const { captureRealtimeDeliveryLease, pauseRealtimeDeliveries, resumeRealtimeDeliveries } =
      await import('@/services/realtime/deliveryCoordinator');
    const context = captureRealtimeDeliveryLease();
    const dispatch = dispatchRealtimeEvent(
      'new-message',
      { guid: 'tracked-supplied-context' },
      'dev',
      context,
      { transportOccurrenceId: 'dev:tracked-supplied-context' },
    );
    await settle();
    expect(mockDurableHandle).toHaveBeenCalledTimes(1);

    let teardownSettled = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownSettled = true;
    });
    await settle();
    expect(teardownSettled).toBe(false);

    durableWrite.resolve(undefined);
    await expect(dispatch).resolves.toBeUndefined();
    await expect(teardown).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
  });

  it('disposes a retired runtime and builds a fresh dispatcher for the next generation', async () => {
    jest.resetModules();
    const { resumeRealtime, startRealtime } = await import('@/services/realtimeControl');
    const { pauseRealtimeDeliveries, resumeRealtimeDeliveries } =
      await import('@/services/realtime/deliveryCoordinator');

    await startRealtime();
    await settle();
    expect(mockDurableConstruct).toHaveBeenCalledTimes(1);
    expect(mockDurableDispose).not.toHaveBeenCalled();

    await pauseRealtimeDeliveries();
    expect(mockDurableDispose).toHaveBeenCalledTimes(1);

    resumeRealtimeDeliveries();
    await resumeRealtime();
    await settle();
    expect(mockDurableConstruct).toHaveBeenCalledTimes(2);
    expect(mockDurableDispose).toHaveBeenCalledTimes(1);
  });

  describe('DEV process-death proof containment', () => {
    const devGlobal = globalThis as unknown as { __DEV__?: boolean };

    afterEach(() => {
      delete devGlobal.__DEV__;
    });

    it('returns before opening the DB when the React Native DEV global is absent', async () => {
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'dev' };
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain } = await import('@/services/realtimeControl');

      await expect(
        devPersistRealtimeEventWithoutDrain(
          'new-message',
          { guid: 'proof-release-closed' },
          { generation: 7, isCurrent: () => true },
          { transportOccurrenceId: 'dev-proof:release-closed' },
        ),
      ).resolves.toBeNull();

      expect(mockEnsureDatabase).not.toHaveBeenCalled();
    });

    it('requires the exact connected fixture identity even in a DEV runtime', async () => {
      devGlobal.__DEV__ = true;
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'wrong' };
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain } = await import('@/services/realtimeControl');

      await expect(
        devPersistRealtimeEventWithoutDrain(
          'new-message',
          { guid: 'proof-wrong-fixture' },
          { generation: 8, isCurrent: () => true },
          { transportOccurrenceId: 'dev-proof:wrong-fixture' },
        ),
      ).resolves.toBeNull();

      expect(mockEnsureDatabase).not.toHaveBeenCalled();
    });

    it('refuses a nonempty queue before invoking persist-without-drain', async () => {
      devGlobal.__DEV__ = true;
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'dev' };
      mockQueueHealth.mockResolvedValueOnce({
        pending: 1,
        due: 1,
        leased: 0,
        dbAppliedPending: 0,
        completed: 4,
        poisoned: 0,
      });
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain } = await import('@/services/realtimeControl');

      await expect(
        devPersistRealtimeEventWithoutDrain(
          'new-message',
          { guid: 'proof-nonempty' },
          { generation: 9, isCurrent: () => true },
          { transportOccurrenceId: 'dev-proof:nonempty' },
        ),
      ).resolves.toBeNull();

      expect(mockDurablePersistWithoutDrain).not.toHaveBeenCalled();
    });

    it('returns aggregate health and resumes through the durable dispatcher', async () => {
      devGlobal.__DEV__ = true;
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'dev' };
      mockQueueHealth
        .mockResolvedValueOnce({
          pending: 0,
          due: 0,
          leased: 0,
          dbAppliedPending: 0,
          completed: 4,
          poisoned: 0,
        })
        .mockResolvedValue({
          pending: 1,
          due: 0,
          leased: 1,
          dbAppliedPending: 0,
          completed: 4,
          poisoned: 0,
        });
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain, devResumePersistedRealtimeEvents } =
        await import('@/services/realtimeControl');
      const { captureRealtimeDeliveryLease } =
        await import('@/services/realtime/deliveryCoordinator');
      const context = captureRealtimeDeliveryLease();

      await expect(
        devPersistRealtimeEventWithoutDrain('new-message', { guid: 'proof-happy' }, context, {
          transportOccurrenceId: 'dev-proof:happy',
        }),
      ).resolves.toEqual({
        pending: 1,
        due: 0,
        leased: 1,
        dbAppliedPending: 0,
        completed: 4,
        poisoned: 0,
      });
      await expect(devResumePersistedRealtimeEvents(context)).resolves.toEqual({
        pending: 1,
        due: 0,
        leased: 1,
        dbAppliedPending: 0,
        completed: 4,
        poisoned: 0,
      });

      expect(mockDispatcherOptions?.allowDevPersistWithoutDrain).toBe(true);
      expect(mockDurablePersistWithoutDrain).toHaveBeenCalledWith(
        'new-message',
        { guid: 'proof-happy' },
        'dev',
        expect.objectContaining({
          generation: context.generation,
          isCurrent: expect.any(Function),
        }),
        { transportOccurrenceId: 'dev-proof:happy' },
        expect.stringMatching(/^dev-proof:/),
        expect.any(Number),
      );
      expect(mockDurableResume).toHaveBeenCalledWith(
        expect.objectContaining({
          generation: context.generation,
          isCurrent: expect.any(Function),
        }),
      );
      expect(Object.keys((await devResumePersistedRealtimeEvents(context)) ?? {}).sort()).toEqual([
        'completed',
        'dbAppliedPending',
        'due',
        'leased',
        'pending',
        'poisoned',
      ]);
    });

    it('fails explicitly if the dispatcher returns a mismatched exact claim', async () => {
      devGlobal.__DEV__ = true;
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'dev' };
      mockDurablePersistWithoutDrain.mockImplementationOnce(async (...args: unknown[]) => ({
        event: { type: 'new-message' },
        queueId: 41,
        claim: { id: 99, source: 'dev', attempts: 1, leaseToken: args[5] },
      }));
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain } = await import('@/services/realtimeControl');
      const { captureRealtimeDeliveryLease } =
        await import('@/services/realtime/deliveryCoordinator');

      await expect(
        devPersistRealtimeEventWithoutDrain(
          'new-message',
          { guid: 'proof-claim-mismatch' },
          captureRealtimeDeliveryLease(),
          { transportOccurrenceId: 'dev-proof:claim-mismatch' },
        ),
      ).rejects.toThrow('DEV process-death proof claimed an unexpected queue row');
    });

    it('revokes a proof if the fixture identity changes while the DB opens', async () => {
      devGlobal.__DEV__ = true;
      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'dev' };
      const databaseOpen = deferred<object>();
      mockEnsureDatabase.mockReturnValueOnce(databaseOpen.promise);
      jest.resetModules();
      const { devPersistRealtimeEventWithoutDrain } = await import('@/services/realtimeControl');
      const proof = devPersistRealtimeEventWithoutDrain(
        'new-message',
        { guid: 'proof-revoked' },
        { generation: 11, isCurrent: () => true },
        { transportOccurrenceId: 'dev-proof:revoked' },
      );

      mockSession = { status: 'connected', origin: 'https://dev.local', password: 'changed' };
      databaseOpen.resolve({});

      await expect(proof).resolves.toBeNull();
      expect(mockQueueHealth).not.toHaveBeenCalled();
      expect(mockDurablePersistWithoutDrain).not.toHaveBeenCalled();
    });
  });
});

describe('killed-process RCS provider authority', () => {
  const EPOCH = `gpe1_${'K'.repeat(42)}A`;
  const PROVIDER_INFO = {
    rcs: true,
    supports_rcs_epoch_qualified_ids: true,
    rcs_provider_epoch: EPOCH,
  };
  const RCS_MESSAGE = { guid: `rcs-g1.${EPOCH}.bWVzc2FnZQ`, chatGuid: `RCS;-;g1.${EPOCH}.Y2hhdA` };
  const durableTransport = { testId: 'killed-process-durable-transport' };
  let transportCurrent = true;

  beforeEach(() => {
    // A killed-process FCM wake never runs the foreground bootstrap, so no server info is held.
    mockSessionServerInfo = null;
    transportCurrent = true;
    mockResolveAuthorizedRealtimeTransport.mockResolvedValue({
      http: durableTransport,
      lease: { generation: 0, isCurrent: () => transportCurrent },
    });
    mockServerInfo.mockResolvedValue(PROVIDER_INFO);
  });

  async function dispatchFcm(eventName: string, payload: unknown): Promise<void> {
    jest.resetModules();
    const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
    await dispatchRealtimeEvent(eventName, payload, 'fcm');
  }

  it('lends the server-confirmed RCS pairing to the whole sink chain for one push', async () => {
    const seen: unknown[] = [];
    mockDurableHandle.mockImplementationOnce(async () => {
      seen.push(mockEdgeProviderInfo?.(), mockDbProviderInfo?.());
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(mockResolveAuthorizedRealtimeTransport).toHaveBeenCalledWith(0);
    expect(mockServerInfo).toHaveBeenCalledTimes(1);
    expect(mockServerInfo).toHaveBeenCalledWith(durableTransport, expect.any(AbortSignal));
    expect(seen).toEqual([PROVIDER_INFO, PROVIDER_INFO]);
    // The loan ends with its callback; a later push must confirm the pairing again.
    expect(mockEdgeProviderInfo?.()).toBeNull();
    expect(mockDbProviderInfo?.()).toBeNull();
  });

  it('lets the adopted photo download keep the pairing its push was admitted under', async () => {
    const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
    const photo = `rcs-media-g1.${EPOCH}.${encoded('message')}.${encoded('photo')}`;
    let adoptedEffect: ((lifetime: MockDeliveryContext) => Promise<unknown>) | undefined;
    mockAdoptRealtimeHeadlessEffect.mockImplementationOnce(
      (
        _generation: number,
        _key: string,
        effect: (lifetime: MockDeliveryContext) => Promise<unknown>,
      ) => {
        adoptedEffect = effect;
        return { status: 'adopted', task: Promise.resolve() };
      },
    );
    let lentWhileStored: unknown;
    mockDurableHandle.mockImplementationOnce(async () => {
      lentWhileStored = mockEdgeProviderInfo?.();
      await mockMessageStored?.(420, 'fcm', {
        generation: 0,
        isCurrent: () => true,
        // Like the real provider sink: current only while live info shows the admitted pairing,
        // so an unknown pairing is never a current one.
        isProviderCurrent: () =>
          (mockEdgeProviderInfo?.() as { rcs_provider_epoch?: unknown } | null | undefined)
            ?.rcs_provider_epoch === EPOCH,
      });
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    // The message was stored under the loan, which ended with the push, before the download.
    expect(lentWhileStored).toEqual(PROVIDER_INFO);
    expect(mockEdgeProviderInfo?.()).toBeNull();
    type DownloadOptions = {
      isEffectCurrent?: () => boolean;
      downloadOwner?: {
        acceptsRcsAttachment?: (attachmentGuid: string) => boolean;
        quietFailure?: boolean;
      };
    };
    let options: DownloadOptions | undefined;
    mockAutoDownloadForRealtimeEvent.mockImplementationOnce(async (...args: unknown[]) => {
      options = args[3] as DownloadOptions;
      return { savedImages: 0, destination: null };
    });
    await adoptedEffect?.({ generation: 0, isCurrent: () => true });

    expect(options?.isEffectCurrent?.()).toBe(true);
    expect(options?.downloadOwner?.quietFailure).toBe(true);
    expect(options?.downloadOwner?.acceptsRcsAttachment?.(photo)).toBe(true);
    // A foreground launch that reports a different pairing ends the download for good.
    mockSessionServerInfo = { ...PROVIDER_INFO, rcs_provider_epoch: `gpe1_${'F'.repeat(42)}A` };
    expect(options?.downloadOwner?.acceptsRcsAttachment?.(photo)).toBe(false);
    expect(options?.isEffectCurrent?.()).toBe(false);
    mockSessionServerInfo = PROVIDER_INFO;
    expect(options?.isEffectCurrent?.()).toBe(false);
  });

  it('fetches nothing for an Apple push or when the foreground already holds the pairing', async () => {
    await dispatchFcm('new-message', {
      guid: 'apple-message',
      chatGuid: 'iMessage;-;apple@example.com',
    });
    mockSessionServerInfo = PROVIDER_INFO;
    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(mockDurableHandle).toHaveBeenCalledTimes(2);
    expect(mockResolveAuthorizedRealtimeTransport).not.toHaveBeenCalled();
    expect(mockServerInfo).not.toHaveBeenCalled();
  });

  it('still queues the push when the pairing cannot be fetched', async () => {
    mockServerInfo.mockRejectedValueOnce(new Error('server unreachable'));
    let seen: unknown = 'not-called';
    mockDurableHandle.mockImplementationOnce(async () => {
      seen = mockEdgeProviderInfo?.();
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(mockDurableHandle).toHaveBeenCalledTimes(1);
    expect(seen).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      '[incomingEvents] RCS pairing unavailable for a background push',
      { errorName: 'Error' },
    );
  });

  it('stops waiting for a stalled pairing fetch after five seconds and still queues the push', async () => {
    jest.useFakeTimers();
    try {
      mockServerInfo.mockImplementationOnce(
        (_http, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const dispatch = dispatchRealtimeEvent('new-message', RCS_MESSAGE, 'fcm');
      await settle();
      jest.advanceTimersByTime(4_999);
      await settle();
      expect(mockDurableHandle).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await expect(dispatch).resolves.toBeUndefined();
      expect(mockDurableHandle).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('prefers a pairing the foreground publishes mid-push over the loan', async () => {
    const foregroundInfo = { ...PROVIDER_INFO, rcs_provider_epoch: `gpe1_${'F'.repeat(42)}A` };
    let seen: unknown = 'not-called';
    mockDurableHandle.mockImplementationOnce(async () => {
      mockSessionServerInfo = foregroundInfo;
      seen = mockEdgeProviderInfo?.();
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(seen).toBe(foregroundInfo);
  });

  it('keeps the loan when the foreground launches mid-push and replaces the transport', async () => {
    let seenAfterLaunch: unknown = 'not-called';
    mockDurableHandle.mockImplementationOnce(async () => {
      // Foreground boot bumps the transport revision while server info is still empty.
      transportCurrent = false;
      seenAfterLaunch = mockDbProviderInfo?.();
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(seenAfterLaunch).toEqual(PROVIDER_INFO);
  });

  it('ends the loan with the push callback that borrowed it', async () => {
    let callbackCurrent = true;
    let seenAfterCallbackEnded: unknown = 'not-called';
    mockDurableHandle.mockImplementationOnce(async () => {
      callbackCurrent = false;
      seenAfterCallbackEnded = mockDbProviderInfo?.();
    });
    jest.resetModules();
    const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');

    await dispatchRealtimeEvent('new-message', RCS_MESSAGE, 'fcm', {
      generation: 0,
      isCurrent: () => callbackCurrent,
    });

    expect(seenAfterCallbackEnded).toBeNull();
  });

  it('never lends a server answer that names no current RCS pairing', async () => {
    // The server reports no pairing while it re-establishes its RCS link. Lending that would make
    // every RCS event look stale and drop it instead of letting it wait.
    mockServerInfo.mockResolvedValueOnce({ ...PROVIDER_INFO, rcs_provider_epoch: null });
    let seen: unknown = 'not-called';
    mockDurableHandle.mockImplementationOnce(async () => {
      seen = mockEdgeProviderInfo?.();
    });

    await dispatchFcm('new-message', RCS_MESSAGE);

    expect(mockDurableHandle).toHaveBeenCalledTimes(1);
    expect(seen).toBeNull();
  });

  it('keeps the loan through the dependency retry of the same push', async () => {
    jest.useFakeTimers();
    try {
      let seenByRetry: unknown = 'not-called';
      mockDurableHandle.mockImplementationOnce(async (...args: unknown[]) => {
        mockDrainOptions?.onDependencyDeferred?.(args[3] as MockDeliveryContext);
      });
      mockDurableResume.mockImplementationOnce(async () => {
        seenByRetry = mockDbProviderInfo?.();
      });
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const dispatch = dispatchRealtimeEvent('new-message', RCS_MESSAGE, 'fcm');
      await settle();
      jest.advanceTimersByTime(5_000);

      await expect(dispatch).resolves.toBeUndefined();
      expect(mockDurableResume).toHaveBeenCalledTimes(1);
      expect(seenByRetry).toEqual(PROVIDER_INFO);
      expect(mockDbProviderInfo?.()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the loan when queueing the push fails', async () => {
    mockDurableHandle.mockRejectedValueOnce(new Error('queue write failed'));

    await expect(dispatchFcm('new-message', RCS_MESSAGE)).rejects.toThrow('queue write failed');

    expect(mockEdgeProviderInfo?.()).toBeNull();
  });

  it('stops a pending pairing fetch at once when the push callback is cancelled', async () => {
    jest.useFakeTimers();
    try {
      mockServerInfo.mockImplementationOnce(
        (_http, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      const callback = new AbortController();
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const dispatch = dispatchRealtimeEvent('new-message', RCS_MESSAGE, 'fcm', {
        generation: 0,
        signal: callback.signal,
        isCurrent: () => true,
      });
      await settle();
      expect(mockDurableHandle).not.toHaveBeenCalled();

      callback.abort();

      // No timer advanced: only the callback's own cancellation ended the wait.
      await expect(dispatch).resolves.toBeUndefined();
      expect(mockDurableHandle).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops a pending pairing fetch at once on Disconnect without queueing the push', async () => {
    jest.useFakeTimers();
    try {
      mockServerInfo.mockImplementationOnce(
        (_http, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      jest.resetModules();
      const { dispatchRealtimeEvent } = await import('@/services/realtimeControl');
      const { pauseRealtimeDeliveries, resumeRealtimeDeliveries } =
        await import('@/services/realtime/deliveryCoordinator');
      const dispatch = dispatchRealtimeEvent('new-message', RCS_MESSAGE, 'fcm');
      await settle();

      // No timer advanced: retiring the account aborts the fetch instead of waiting five seconds.
      const retirement = pauseRealtimeDeliveries();
      await expect(dispatch).resolves.toBeUndefined();
      await expect(retirement).resolves.toBeUndefined();
      expect(mockDurableHandle).not.toHaveBeenCalled();
      resumeRealtimeDeliveries();
    } finally {
      jest.useRealTimers();
    }
  });
});
