/**
 * Unit tests for the Notifee presentation layer (`src/services/notifications/notifeeService.ts`).
 *
 * These functions build the exact Notifee payloads posted to the OS. The invariants pinned:
 *   - Ordinary unlocked message notices keep their detail; native reminder alarms are always
 *     generic because Android persists them outside SQLCipher.
 *   - The MESSAGING-style `person.icon` is spread CONDITIONALLY — never `icon: undefined`
 *     (AGENTS.md: passing undefined throws at displayNotification on device). No avatar means
 *     the `person` object has NO `icon` key at all.
 *   - Each notification targets the right channel, id, and press/actions.
 *   - Channel promises don't memoize a rejection (a failed createChannel can be retried).
 *
 * notifee is a native module — mocked here with jest.fn spies so we can inspect the payloads
 * (the shared runtime stub in test/__mocks__/notifee.ts isn't spyable and lacks AlarmType). This
 * is a pure `node`-project test.
 */
import notifee from 'react-native-notify-kit';
import type { EventDeliveryContext, NotificationIntent } from '@core/realtime';
import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { claimActiveChat, resetActiveChat } from '@/services/notifications/activeChat';
import {
  listFutureReminderTriggerRoutes,
  listMessageNotificationTruth,
} from '@/services/notifications/notificationRouting';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  ACTION_LOVE,
  ACTION_MARK_READ,
  ACTION_REPLY,
  CHANNEL_NEW_MESSAGE,
  CHANNEL_REMINDERS,
  PRESS_OPEN,
  PRESS_REMINDER,
  beginAppLockNotificationPrivacy,
  commitAppLockNotificationPrivacy,
  cancelAllNotifications,
  cancelForChat,
  cancelReminderNotification,
  chatChannelId,
  clearChatNotification,
  getNotificationPermissionState,
  openChatNotificationSettings,
  openNotificationPermissionSettings,
  postLockedNotification,
  postNotification,
  prepareNotificationPresentationState,
  reconcileMessageNotificationGroup,
  reconcileMessageNotificationGroupAfterRemoval,
  requestNotificationPermission,
  scheduleReminderNotification,
} from '@/services/notifications/notifeeService';
import {
  MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES,
  MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
  MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS,
  MAX_MESSAGE_NOTIFICATION_TEXT_BYTES,
  MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS,
} from '@/services/notifications/messageHistory';

const notificationTextEncoder = new TextEncoder();

jest.mock('@/services/clients', () => ({ vault: { get: jest.fn(async () => 'true') } }));
const { vault: mockVault } = jest.requireMock('@/services/clients') as {
  vault: { get: jest.Mock };
};

const ALARM_IDLE = 3;
const LEGACY_FACETIME_CHANNEL_ID = 'com.bluegreengatorapps.messages.facetime';
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AndroidGroupAlertBehavior: { ALL: 0, SUMMARY: 1, CHILDREN: 2 },
  AndroidStyle: { BIGPICTURE: 0, BIGTEXT: 1, INBOX: 2, MESSAGING: 3 },
  AlarmType: { SET_AND_ALLOW_WHILE_IDLE: 3 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
  default: {
    createChannel: jest.fn(async (c: { id: string }) => c.id),
    requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
    getNotificationSettings: jest.fn(async () => ({ authorizationStatus: -1 })),
    displayNotification: jest.fn(async () => undefined),
    createTriggerNotification: jest.fn(async () => undefined),
    getDisplayedNotifications: jest.fn(async () => []),
    getTriggerNotifications: jest.fn(async () => []),
    cancelNotification: jest.fn(async () => undefined),
    cancelAllNotifications: jest.fn(async () => undefined),
    cancelDisplayedNotification: jest.fn(async () => undefined),
    cancelDisplayedNotifications: jest.fn(async () => undefined),
    cancelTriggerNotification: jest.fn(async () => undefined),
    cancelTriggerNotifications: jest.fn(async () => undefined),
    // Default: no per-chat channel exists → notifications route to the shared channel.
    getChannel: jest.fn(async () => null),
    getChannels: jest.fn(async () => []),
    deleteChannel: jest.fn(async () => undefined),
    openNotificationSettings: jest.fn(async () => undefined),
  },
}));

jest.mock('@/services/notifications/notificationRouting', () => {
  const chatIds: Record<string, number> = {
    'chat-1': 1,
    c1: 1,
    'chat-3': 3,
    'chat-4': 4,
    'opaque-chat-guid': 10,
    'opaque-reminder-chat': 11,
    'new-after-opt-out': 12,
    'after-enable': 13,
    'after-disable': 14,
    'queue-recovered': 15,
    'chat-retry': 16,
  };
  const messageIds: Record<string, number> = {
    'msg-1': 101,
    m1: 101,
    'msg-3-new': 303,
    'opaque-message-guid': 110,
    'opaque-reminder-message': 111,
    'm-retry': 116,
  };
  const chatGuids = Object.fromEntries(Object.entries(chatIds).map(([guid, id]) => [id, guid]));
  const messageGuids = Object.fromEntries(
    Object.entries(messageIds).map(([guid, id]) => [id, guid]),
  );
  const marker = (kind: string) => ({
    gatorOwner: 'gator',
    gatorSchema: '2',
    gatorKind: kind,
  });
  return {
    NOTIFICATION_DATA_OWNER: 'gator',
    NOTIFICATION_DATA_SCHEMA: '2',
    MAX_MESSAGE_NOTIFICATION_TRUTH_IDS: 512,
    chatChannelIdForLocalId: (id: number) =>
      `com.bluegreengatorapps.messages.new_messages.chat.route_${id}`,
    chatNotificationId: (id: number) => `gator-message-${id}`,
    sendFailureNotificationId: (id: number) => `gator-send-failure-${id}`,
    faceTimeNotificationId: (token: string) => `gator-facetime-${token}`,
    reminderNotificationId: (key: string | number, time: number) => `gator-reminder-${key}-${time}`,
    isSafeReminderNotificationId: (id?: string) =>
      /^gator-reminder-(?:message|row)-\d+-\d+$/.test(id ?? '') ||
      /^gator-reminder-random-[0-9a-f-]+-\d+$/.test(id ?? ''),
    localRouteForGuids: jest.fn(async (chatGuid: string, messageGuid?: string) => ({
      chatId: chatIds[chatGuid] ?? 99,
      ...(messageGuid ? { messageId: messageIds[messageGuid] ?? 199 } : {}),
    })),
    localRouteForMessageGuid: jest.fn(async (messageGuid: string) => ({
      chatId: messageGuid === 'msg-other' ? 3 : 1,
      messageId: messageIds[messageGuid] ?? 199,
    })),
    localFailedMessageRoute: jest.fn(async (messageGuid: string) => {
      const chatGuid = messageGuid === 'msg-other' ? 'chat-3' : 'chat-1';
      return {
        chatGuid,
        messageGuid,
        route: {
          chatId: chatIds[chatGuid] ?? 99,
          messageId: messageIds[messageGuid] ?? 199,
        },
      };
    }),
    nativeRouteData: (
      kind: string,
      route: { chatId: number; messageId?: number },
      date?: unknown,
    ) => ({
      ...marker(kind),
      chatId: String(route.chatId),
      ...(route.messageId == null ? {} : { messageId: String(route.messageId) }),
      ...(date == null ? {} : { messageDate: String(date) }),
    }),
    nativeStatusData: (kind: string) => marker(kind),
    findFaceTimeRoute: jest.fn(async () => '7f000000-0000-4000-8000-000000000001'),
    deleteFaceTimeRoute: jest.fn(async () => undefined),
    clearNotificationRoutes: jest.fn(async () => undefined),
    listFutureReminderTriggerRoutes: jest.fn(async () => []),
    listMessageNotificationTruth: jest.fn(async () => []),
    replacementReminderNotificationId: jest.fn(
      async (oldId: string, _messageGuid: string, time?: number) =>
        `gator-reminder-message-111-${time ?? Number(oldId.match(/(\d+)$/)?.[1] ?? 5000)}`,
    ),
    migrateReminderNotificationId: jest.fn(
      async (_oldId: string, _newId: string, commitGuard?: () => boolean) =>
        commitGuard?.() !== false,
    ),
    resolveNotificationData: jest.fn(async (data?: Record<string, unknown>) => {
      if (!data) return null;
      if (data.gatorOwner !== 'gator') return data;
      if (data.gatorSchema !== '2') return null;
      if (data.gatorKind === 'facetime') return { faceTimeUuid: 'opaque-call-uuid' };
      if (data.gatorKind === 'message-summary') return { inbox: '1' };
      if (
        data.gatorKind !== 'message' &&
        data.gatorKind !== 'send-failure' &&
        data.gatorKind !== 'reminder'
      )
        return null;
      return {
        chatGuid: chatGuids[Number(data.chatId)],
        ...(data.messageId == null ? {} : { messageGuid: messageGuids[Number(data.messageId)] }),
        ...(data.messageDate == null ? {} : { messageDate: String(data.messageDate) }),
        ...(data.gatorKind === 'reminder' ? { reminder: '1' } : {}),
      };
    }),
  };
});

const mockDisplay = notifee.displayNotification as jest.Mock;
const mockCreateChannel = notifee.createChannel as jest.Mock;
const mockCreateTrigger = notifee.createTriggerNotification as jest.Mock;
const mockGetDisplayed = notifee.getDisplayedNotifications as jest.Mock;
const mockGetTriggers = notifee.getTriggerNotifications as jest.Mock;
const mockCancel = notifee.cancelNotification as jest.Mock;
const mockCancelAll = notifee.cancelAllNotifications as jest.Mock;
const mockCancelDisplayedAll = notifee.cancelDisplayedNotifications as jest.Mock;
const mockCancelTrigger = notifee.cancelTriggerNotification as jest.Mock;
const mockCancelTriggersAll = notifee.cancelTriggerNotifications as jest.Mock;
const mockRequestPermission = notifee.requestPermission as jest.Mock;
const mockGetNotificationSettings = notifee.getNotificationSettings as jest.Mock;
const mockGetChannel = notifee.getChannel as jest.Mock;
const mockGetChannels = notifee.getChannels as jest.Mock;
const mockDeleteChannel = notifee.deleteChannel as jest.Mock;
const mockOpenSettings = notifee.openNotificationSettings as jest.Mock;
const mockListFutureReminderTriggerRoutes = listFutureReminderTriggerRoutes as jest.Mock;
const mockListMessageNotificationTruth = listMessageNotificationTruth as jest.Mock;
const {
  clearNotificationRoutes: mockClearNotificationRoutes,
  deleteFaceTimeRoute: mockDeleteFaceTimeRoute,
  localFailedMessageRoute: mockLocalFailedMessageRoute,
  localRouteForGuids: mockLocalRouteForGuids,
  migrateReminderNotificationId: mockMigrateReminderNotificationId,
} = jest.requireMock('@/services/notifications/notificationRouting') as {
  clearNotificationRoutes: jest.Mock;
  deleteFaceTimeRoute: jest.Mock;
  localFailedMessageRoute: jest.Mock;
  localRouteForGuids: jest.Mock;
  migrateReminderNotificationId: jest.Mock;
};

/** Load inside `isolateModulesAsync` so each channel-promise test gets fresh module state. */
function loadFreshService(): typeof import('@/services/notifications/notifeeService') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime load is the isolation seam under test
  return require('@/services/notifications/notifeeService') as typeof import('@/services/notifications/notifeeService');
}

/** The android block of the last displayNotification() call. */
function lastNotif() {
  const call = mockDisplay.mock.calls.at(-1);
  return call?.[0] as {
    id?: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    android?: Record<string, any>;
  };
}

const messageIntent = (over: Partial<Extract<NotificationIntent, { kind: 'message' }>> = {}) =>
  ({
    kind: 'message',
    chatGuid: 'chat-1',
    chatTitle: 'Alice',
    senderName: 'Alice',
    senderHandle: 'alice@x.com',
    body: 'secret plans',
    messageGuid: 'msg-1',
    timestamp: 1700000000000,
    isGroup: false,
    ...over,
  }) as Extract<NotificationIntent, { kind: 'message' }>;

function installStatefulTray(initial: Record<string, any>[] = []): {
  tray: Map<string, Record<string, any>>;
  restore(): void;
} {
  const tray = new Map(
    initial.flatMap((notification) =>
      typeof notification.id === 'string' ? [[notification.id, notification] as const] : [],
    ),
  );
  mockGetDisplayed.mockImplementation(async () =>
    [...tray].map(([id, notification]) => ({ id, notification })),
  );
  mockDisplay.mockImplementation(async (notification: Record<string, any>) => {
    if (typeof notification.id === 'string') tray.set(notification.id, notification);
  });
  mockCancel.mockImplementation(async (id: string) => {
    const cancelled = tray.get(id);
    tray.delete(id);
    // Match Android NotificationManager: cancelling a group summary also cancels every child in
    // that group. This caught a device-only data-loss bug that a one-key Map delete hid.
    if (cancelled?.android?.groupSummary === true) {
      const groupId = cancelled.android.groupId;
      for (const [childId, child] of tray) {
        if (groupId && child.android?.groupId === groupId && child.android.groupSummary !== true) {
          tray.delete(childId);
        }
      }
    }
  });
  mockCancelAll.mockImplementation(async () => {
    tray.clear();
  });
  mockCancelDisplayedAll.mockImplementation(async () => {
    tray.clear();
  });
  return {
    tray,
    restore: () => {
      mockGetDisplayed.mockImplementation(async () => []);
      mockDisplay.mockImplementation(async () => undefined);
      mockCancel.mockImplementation(async () => undefined);
      mockCancelAll.mockImplementation(async () => undefined);
      mockCancelDisplayedAll.mockImplementation(async () => undefined);
    },
  };
}

function displayedMessageChild(chatId: number, messageId: number): Record<string, any> {
  return {
    id: `gator-message-${chatId}`,
    title: `Chat ${chatId}`,
    body: `Message ${messageId}`,
    data: {
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'message',
      chatId: String(chatId),
      messageId: String(messageId),
      messageDate: String(1700000000000 + messageId),
      messageHistoryIds: String(messageId),
    },
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: 3,
        person: { name: 'You', id: 'self' },
        group: false,
        messages: [
          {
            text: `Message ${messageId}`,
            timestamp: 1700000000000 + messageId,
            person: { name: `Contact ${chatId}`, id: 'contact' },
          },
        ],
      },
      actions: [],
    },
  };
}

function messageTruth(
  messageId: number,
  chatId: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messageId,
    chatId,
    notificationEligible: 1,
    retractionState: 'intact',
    dateRetracted: null,
    messagePartTopology: null,
    text: `Message ${messageId}`,
    subject: null,
    hasAttachments: 0,
    hasVisibleAttachments: 0,
    attachmentDescription: null,
    balloonBundleId: null,
    ...over,
  };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockVault.get.mockReset().mockResolvedValue('true');
  useSessionStore.setState({
    serverInfo: { version: 'test', private_api: true, rcs: true } as any,
  });
  resetActiveChat();
  mockGetNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  useLockStore.setState({
    enabled: false,
    locked: false,
    hydrated: true,
    lastBackgrounded: null,
    timeoutMs: 30_000,
  });
  commitAppLockNotificationPrivacy();
  mockListMessageNotificationTruth.mockImplementation(async (messageIds: number[]) =>
    messageIds.map((messageId) =>
      messageTruth(
        messageId,
        messageId === 110
          ? 10
          : messageId === 111
            ? 11
            : messageId === 303
              ? 3
              : messageId === 199
                ? 3
                : messageId === 909
                  ? 9
                  : 1,
      ),
    ),
  );
});

afterEach(() => {
  resumeRealtimeDeliveries();
  resetActiveChat();
  jest.restoreAllMocks();
});

describe('App Lock notification privacy transition', () => {
  it.each([true, false])(
    'keeps message and alias notices generic with enabled App Lock and locked=%s',
    async (locked) => {
      useLockStore.setState({ enabled: true, locked, lastBackgrounded: Date.now() });
      await postNotification(messageIntent());
      await postNotification({ kind: 'alias-removed', aliases: ['PRIVATE_ALIAS'] });
      for (const [notification] of mockDisplay.mock.calls) {
        expect(notification).toMatchObject({
          id: 'bb-locked-messages',
          title: 'Gator',
          body: 'You have new messages',
        });
        expect(JSON.stringify(notification)).not.toMatch(
          /PRIVATE_ALIAS|Alice|secret plans|chatId|messageId/,
        );
      }
      expect(mockLocalRouteForGuids).not.toHaveBeenCalled();
    },
  );

  it('drops old queued detail and blocks new detail synchronously before the scrub finishes', async () => {
    let finish!: () => void;
    mockCancelDisplayedAll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const oldPost = postNotification(messageIntent());
    const scrub = beginAppLockNotificationPrivacy();
    const newPost = postNotification(messageIntent());
    for (let i = 0; i < 25 && !finish; i += 1) await Promise.resolve();
    expect(mockDisplay).not.toHaveBeenCalled();
    finish();
    await Promise.all([oldPost, scrub, newPost]);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
    expect(lastNotif()).toMatchObject({ id: 'bb-locked-messages' });
  });

  it.each(['message', 'alias'] as const)(
    'cancels a %s native post that commits after privacy admission',
    async (kind) => {
      const state = installStatefulTray();
      let finish!: () => void;
      mockDisplay.mockImplementationOnce(
        (notification: Record<string, any>) =>
          new Promise<void>((resolve) => {
            finish = () => {
              state.tray.set(notification.id, notification);
              resolve();
            };
          }),
      );
      try {
        const post = postNotification(
          kind === 'message'
            ? messageIntent()
            : { kind: 'alias-removed', aliases: ['PRIVATE_ALIAS'] },
        );
        for (let i = 0; i < 40 && !finish; i += 1) await Promise.resolve();
        expect(finish).toBeDefined();
        const scrub = beginAppLockNotificationPrivacy();
        finish();
        await Promise.all([post, scrub]);
        expect(mockCancel).toHaveBeenCalledWith(
          kind === 'message' ? 'gator-message-1' : 'bb-aliases-removed',
        );
        expect(state.tray.size).toBe(0);
      } finally {
        state.restore();
      }
    },
  );

  it('rejects an old presentation epoch even after OFF -> ON -> OFF', async () => {
    let finish!: () => void;
    mockGetChannel.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const oldPost = postNotification(messageIntent());
    for (let i = 0; i < 40 && !finish; i += 1) await Promise.resolve();
    const scrub = beginAppLockNotificationPrivacy();
    commitAppLockNotificationPrivacy();
    finish();
    await Promise.all([oldPost, scrub]);
    expect(mockDisplay).not.toHaveBeenCalled();
    await postNotification(messageIntent());
    expect(lastNotif().body).toBe('secret plans');
  });

  it('preserves a current generic alarm, retires a private alarm, and sweeps displayed state last without DB reads', async () => {
    const generic = {
      id: 'gator-reminder-message-101-1700000000000',
      title: 'Reminder',
      body: 'Reminder',
      data: {
        gatorOwner: 'gator',
        gatorSchema: '2',
        gatorKind: 'reminder',
        chatId: '1',
        messageId: '101',
        messageDate: '1700000000000',
      },
      android: {
        channelId: CHANNEL_REMINDERS,
        smallIcon: 'ic_stat_gator',
        onlyAlertOnce: true,
        pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
      },
    };
    mockGetTriggers.mockResolvedValueOnce([
      { notification: generic, trigger: { type: 0, timestamp: 1700000000000 } },
      {
        notification: { ...generic, id: 'legacy-alarm', body: 'PRIVATE_BODY' },
        trigger: { type: 0, timestamp: 1700000000001 },
      },
    ]);
    mockGetChannels.mockResolvedValueOnce([
      { id: chatChannelId(1), name: 'PRIVATE_CHAT', importance: 4 },
    ]);
    useLockStore.setState({ enabled: false, locked: false, hydrated: false });
    await beginAppLockNotificationPrivacy();
    expect(mockCancelTrigger).toHaveBeenCalledTimes(1);
    expect(mockCancelTrigger).toHaveBeenCalledWith('legacy-alarm');
    expect(mockCancelTriggersAll).not.toHaveBeenCalled();
    expect(mockCancelAll).not.toHaveBeenCalled();
    expect(mockCreateTrigger).not.toHaveBeenCalled();
    expect(mockCreateChannel).toHaveBeenCalledWith({
      id: chatChannelId(1),
      name: 'Conversation',
      importance: 4,
    });
    expect(mockCancelTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelDisplayedAll.mock.invocationCallOrder[0]!,
    );
    expect(mockLocalRouteForGuids).not.toHaveBeenCalled();
    expect(mockListMessageNotificationTruth).not.toHaveBeenCalled();
    expect(mockClearNotificationRoutes).not.toHaveBeenCalled();
  });

  it.each(['triggers', 'channels', 'displayed'])(
    'reports %s cleanup failure and retains generic-only presentation',
    async (stage) => {
      const error = new Error('PRIVATE_NATIVE_ERROR');
      if (stage === 'triggers') mockGetTriggers.mockRejectedValueOnce(error);
      if (stage === 'channels') mockGetChannels.mockRejectedValueOnce(error);
      if (stage === 'displayed') mockCancelDisplayedAll.mockRejectedValueOnce(error);
      await expect(beginAppLockNotificationPrivacy()).rejects.toThrow(
        'App Lock notification cleanup failed',
      );
      expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
      await postNotification(messageIntent());
      expect(lastNotif()).toMatchObject({ id: 'bb-locked-messages' });
      if (stage === 'triggers') expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    },
  );

  it('contains a contextless native post after its captured account retires', async () => {
    let finish!: () => void;
    mockDisplay.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const post = postNotification(messageIntent());
    for (let i = 0; i < 40 && !finish; i += 1) await Promise.resolve();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    finish();
    await post;
    expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
  });

  it('contains a retired native post even when the bridge rejects after committing it', async () => {
    const state = installStatefulTray();
    let finish!: () => void;
    mockDisplay.mockImplementationOnce(
      (notification: Record<string, any>) =>
        new Promise<void>((_resolve, reject) => {
          finish = () => {
            state.tray.set(notification.id, notification);
            reject(new Error('uncertain native result'));
          };
        }),
    );
    try {
      const post = postNotification(messageIntent());
      const rejected = expect(post).rejects.toThrow('uncertain native result');
      for (let i = 0; i < 40 && !finish; i += 1) await Promise.resolve();
      const scrub = beginAppLockNotificationPrivacy();
      finish();
      await rejected;
      await scrub;
      expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
      expect(state.tray.size).toBe(0);
    } finally {
      state.restore();
    }
  });

  it.each(['style', 'largeIcon', 'inputHistory', 'ticker', 'sound'] as const)(
    'retires an otherwise generic alarm with private %s presentation',
    async (field) => {
      await scheduleReminderNotification({
        notificationId: 'gator-reminder-message-101-1700000000000',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
        scheduledFor: 1700000000000,
      });
      const [notification, trigger] = mockCreateTrigger.mock.calls[0]!;
      mockGetTriggers.mockResolvedValueOnce([
        {
          notification: {
            ...notification,
            android: {
              ...notification.android,
              [field]: field === 'inputHistory' ? ['PRIVATE'] : 'PRIVATE',
            },
          },
          trigger,
        },
      ]);
      await beginAppLockNotificationPrivacy();
      expect(mockCancelTrigger).toHaveBeenCalledWith(notification.id);
      expect(mockCancelTriggersAll).not.toHaveBeenCalled();
    },
  );

  it('genericizes conversation settings even after a warm unlock while enabled', async () => {
    useLockStore.setState({ enabled: true, locked: false });
    await openChatNotificationSettings('chat-1', 'PRIVATE_TITLE');
    expect(mockCreateChannel).toHaveBeenCalledWith({
      id: chatChannelId(1),
      name: 'Conversation',
      importance: 4,
    });
    expect(mockOpenSettings).toHaveBeenCalledWith(chatChannelId(1));
  });

  it('preserves the current reminder generator with native defaults and rejects extra press metadata', async () => {
    await scheduleReminderNotification({
      notificationId: 'gator-reminder-message-101-1700000000000',
      chatGuid: 'chat-1',
      messageGuid: 'msg-1',
      scheduledFor: 1700000000000,
    });
    const [notification, trigger] = mockCreateTrigger.mock.calls[0]!;
    // Installed validateAndroidNotification adds these non-content defaults; getTriggerNotifications
    // returns the persisted bundle without adding new sound or pressAction metadata.
    const normalized = {
      ...notification,
      android: {
        autoCancel: true,
        asForegroundService: false,
        badgeIconType: 2,
        defaults: [-1],
        groupAlertBehavior: 0,
        groupSummary: false,
        localOnly: false,
        importance: 3,
        showTimestamp: false,
        showChronometer: false,
        visibility: 0,
        ...notification.android,
      },
    };
    mockGetTriggers.mockResolvedValueOnce([
      { notification: normalized, trigger },
      {
        notification: {
          ...normalized,
          id: 'gator-reminder-message-101-1700000000001',
          android: {
            ...normalized.android,
            pressAction: { ...normalized.android.pressAction, mainComponent: 'PRIVATE_COMPONENT' },
          },
        },
        trigger,
      },
    ]);
    await beginAppLockNotificationPrivacy();
    expect(mockCancelTrigger).toHaveBeenCalledTimes(1);
    expect(mockCancelTrigger).toHaveBeenCalledWith('gator-reminder-message-101-1700000000001');
    expect(mockCancelTriggersAll).not.toHaveBeenCalled();
  });

  it('still repairs missing generic alarms on connected startup after App Lock unlock', async () => {
    useLockStore.setState({ enabled: true, locked: false });
    mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([
      {
        oldId: 'reminder-old-5000',
        newId: 'gator-reminder-message-111-5000',
        scheduledFor: 5000,
        route: { chatId: 11, messageId: 111 },
        messageDate: 1690000000000,
      },
    ]);
    await prepareNotificationPresentationState();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    expect(mockCreateTrigger.mock.calls[0]![0]).toMatchObject({
      id: 'gator-reminder-message-111-5000',
      title: 'Reminder',
      body: 'Reminder',
    });
  });
});

describe('requestNotificationPermission', () => {
  it('returns true when the OS grants AUTHORIZED', async () => {
    mockRequestPermission.mockResolvedValueOnce({ authorizationStatus: 1 });
    expect(await requestNotificationPermission()).toBe(true);
  });

  it('returns true for PROVISIONAL (>= AUTHORIZED) and false for DENIED', async () => {
    mockRequestPermission.mockResolvedValueOnce({ authorizationStatus: 2 });
    expect(await requestNotificationPermission()).toBe(true);
    mockRequestPermission.mockResolvedValueOnce({ authorizationStatus: 0 });
    expect(await requestNotificationPermission()).toBe(false);
  });

  it('reads status without prompting and opens app-wide recovery settings', async () => {
    mockGetNotificationSettings.mockResolvedValueOnce({ authorizationStatus: -1 });
    expect(await getNotificationPermissionState()).toBe('not-determined');
    expect(mockRequestPermission).not.toHaveBeenCalled();

    mockGetNotificationSettings.mockResolvedValueOnce({ authorizationStatus: 0 });
    expect(await getNotificationPermissionState()).toBe('denied');
    mockGetNotificationSettings.mockResolvedValueOnce({ authorizationStatus: 1 });
    expect(await getNotificationPermissionState()).toBe('granted');

    await openNotificationPermissionSettings();
    expect(mockOpenSettings).toHaveBeenCalledWith();
  });
});

describe('postNotification permission boundary', () => {
  const presentationIntents: NotificationIntent[] = [
    messageIntent(),
    { kind: 'send-failure', chatGuid: 'chat-1', messageGuid: 'msg-1' },
    { kind: 'alias-removed', aliases: ['me@example.test'] },
    { kind: 'rcs-bridge-down', title: 'ignored', body: 'ignored' },
    { kind: 'test-notification', title: 'ignored', body: 'ignored' },
  ];

  it.each(['denied', 'not-determined'] as const)(
    'completes every presentation intent without native mutation when access is %s',
    async (permission) => {
      mockGetNotificationSettings.mockResolvedValue({
        authorizationStatus: permission === 'denied' ? 0 : -1,
      });

      for (const intent of presentationIntents) await postNotification(intent);

      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCreateChannel).not.toHaveBeenCalled();
      expect(mockGetDisplayed).not.toHaveBeenCalled();
    },
  );

  it('still runs cancellation cleanup while presentation permission is denied', async () => {
    mockGetNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });

    await postNotification({ kind: 'cancel', chatGuid: 'chat-1' });

    expect(mockGetNotificationSettings).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
  });

  it('propagates a permission-read failure so a durable owner can retry', async () => {
    const failure = new Error('permission bridge unavailable');
    mockGetNotificationSettings.mockRejectedValueOnce(failure);

    await expect(postNotification(messageIntent())).rejects.toBe(failure);

    expect(mockDisplay).not.toHaveBeenCalled();
  });

  it('bounds a hung permission read so queued account cleanup can still run', async () => {
    jest.useFakeTimers();
    try {
      let resolvePermission!: (settings: { authorizationStatus: number }) => void;
      mockGetNotificationSettings.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      );
      const postResult = postNotification(messageIntent()).then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.resolve();
      const teardown = cancelAllNotifications();
      await Promise.resolve();

      expect(mockCancelAll).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2_000);

      await expect(postResult).resolves.toMatchObject({
        name: 'NotificationPermissionReadTimeoutError',
        message: 'notification permission read timed out',
      });
      await expect(teardown).resolves.toBeUndefined();
      expect(mockCancelAll).toHaveBeenCalledTimes(1);

      resolvePermission({ authorizationStatus: 1 });
      await Promise.resolve();
      expect(mockDisplay).not.toHaveBeenCalled();

      mockGetNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
      await expect(postNotification(messageIntent())).resolves.toBeUndefined();
      expect(mockDisplay).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('contains the exact native denial at the display boundary without replaying it later', async () => {
    const revoked = Object.assign(
      new Error(
        'java.lang.SecurityException: POST_NOTIFICATIONS permission is not granted. Notification was not displayed.',
      ),
      { name: 'java.lang.Exception' },
    );
    mockGetNotificationSettings.mockResolvedValueOnce({ authorizationStatus: 1 });
    mockDisplay.mockRejectedValueOnce(revoked);

    await expect(postNotification(messageIntent())).resolves.toBeUndefined();

    expect(mockGetNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('preserves retry for every other native EUNSPECIFIED failure', async () => {
    const nativeFailure = Object.assign(new Error('notification manager unavailable'), {
      code: 'EUNSPECIFIED',
    });
    mockDisplay.mockRejectedValueOnce(nativeFailure);

    await expect(postNotification(messageIntent())).rejects.toBe(nativeFailure);
    expect(mockGetNotificationSettings).toHaveBeenCalledTimes(1);
  });
});

describe('per-chat notification channel', () => {
  it('chatChannelId derives a safe, stable id from a local integer', () => {
    expect(chatChannelId(7)).toBe(`${CHANNEL_NEW_MESSAGE}.chat.route_7`);
    expect(chatChannelId(123)).not.toMatch(/[+@;]/);
  });

  it('openChatNotificationSettings bounds the channel name and opens its OS settings', async () => {
    const guid = 'iMessage;-;+15551234567';
    await openChatNotificationSettings(
      guid,
      '😀'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1),
    );
    const id = chatChannelId(99);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        name: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS),
      }),
    );
    expect(mockOpenSettings).toHaveBeenCalledWith(id);
  });

  it('does not open settings from a queued callback whose account was retired', async () => {
    let current = true;
    const lease = { generation: 11, isCurrent: () => current };
    const opening = openChatNotificationSettings('chat-1', 'Old account title', lease);
    current = false;

    await opening;

    expect(mockCreateChannel).not.toHaveBeenCalled();
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it('routes a message notification to the per-chat channel when one exists', async () => {
    const id = chatChannelId(1);
    mockGetChannel.mockResolvedValueOnce({ id }); // a customized channel exists for this chat
    await postNotification(messageIntent());
    expect(lastNotif().android?.channelId).toBe(id);
  });

  it('falls back to the shared channel when no per-chat channel exists', async () => {
    mockGetChannel.mockResolvedValueOnce(null);
    await postNotification(messageIntent());
    expect(lastNotif().android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
  });
});

describe('postNotification — detailed message', () => {
  it('groups distinct chats under one silent private summary and removes it after read or swipe', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      const first = state.tray.get('gator-message-1');
      expect(first?.android).toEqual(
        expect.objectContaining({ groupId: 'gator-message-group', groupAlertBehavior: 2 }),
      );
      expect(state.tray.has('gator-message-summary')).toBe(false);

      // A second line in the same MessagingStyle notice is still one conversation.
      await postNotification(
        messageIntent({ messageGuid: 'msg-2', body: 'same chat', timestamp: 1700000000001 }),
      );
      expect(state.tray.get('gator-message-1')?.android?.style.messages).toHaveLength(2);
      expect(state.tray.has('gator-message-summary')).toBe(false);

      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
          timestamp: 1700000000002,
        }),
      );
      const second = state.tray.get('gator-message-3');
      const summary = state.tray.get('gator-message-summary');
      expect(second?.android).toEqual(
        expect.objectContaining({ groupId: 'gator-message-group', groupAlertBehavior: 2 }),
      );
      expect(summary).toEqual(
        expect.objectContaining({
          id: 'gator-message-summary',
          title: 'Gator',
          body: 'New messages',
          data: {
            gatorOwner: 'gator',
            gatorSchema: '2',
            gatorKind: 'message-summary',
          },
          android: expect.objectContaining({
            groupId: 'gator-message-group',
            groupSummary: true,
            groupAlertBehavior: 2,
            onlyAlertOnce: true,
            autoCancel: false,
            pressAction: { id: 'open-inbox', launchActivity: 'default' },
          }),
        }),
      );
      expect(summary?.android).not.toHaveProperty('actions');
      expect(summary?.android).not.toHaveProperty('style');
      expect(JSON.stringify({ id: summary?.id, data: summary?.data })).not.toMatch(
        /Alice|Bob|chat-1|chat-3|msg-|secret|another/,
      );

      // A delayed dismissal for an older version of this stable chat id must not hide a newer child.
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-3-new',
          body: 'newer replacement',
          timestamp: 1700000000003,
        }),
      );
      await reconcileMessageNotificationGroupAfterRemoval(second);
      expect(state.tray.has('gator-message-3')).toBe(true);
      expect(state.tray.has('gator-message-summary')).toBe(true);

      const currentSecond = state.tray.get('gator-message-3');
      state.tray.delete('gator-message-3');
      await reconcileMessageNotificationGroupAfterRemoval(currentSecond);
      // Android summary cancellation cascades to every grouped child. Keep the silent scaffold
      // through the 2 -> 1 tail rather than losing the surviving conversation notification.
      expect(state.tray.has('gator-message-summary')).toBe(true);
      expect(state.tray.has('gator-message-1')).toBe(true);

      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'again',
        }),
      );
      expect(state.tray.has('gator-message-summary')).toBe(true);
      await cancelForChat('chat-3');
      expect(state.tray.has('gator-message-3')).toBe(false);
      expect(state.tray.has('gator-message-summary')).toBe(true);
      expect(state.tray.has('gator-message-1')).toBe(true);

      await cancelForChat('chat-1');
      expect(state.tray.has('gator-message-1')).toBe(false);
      expect(state.tray.has('gator-message-summary')).toBe(false);
    } finally {
      state.restore();
    }
  });

  it('does not rewrite pre-feature children at startup and counts only current grouped children', async () => {
    const first = displayedMessageChild(1, 101);
    const second = displayedMessageChild(3, 199);
    const foreign = {
      ...displayedMessageChild(9, 909),
      id: 'another-app-message-9',
      data: { ...displayedMessageChild(9, 909).data, gatorOwner: 'another-app' },
    };
    const state = installStatefulTray([
      first,
      foreign,
      {
        id: 'bb-locked-messages',
        data: { gatorOwner: 'gator', gatorSchema: '2', gatorKind: 'locked' },
      },
    ]);
    try {
      await prepareNotificationPresentationState();
      expect(state.tray.get('gator-message-1')).toBe(first);
      expect(state.tray.has('gator-message-summary')).toBe(false);

      state.tray.set('gator-message-3', second);
      await prepareNotificationPresentationState();
      expect(state.tray.get('gator-message-1')).toBe(first);
      expect(state.tray.get('gator-message-3')).toBe(second);
      expect(state.tray.has('gator-message-summary')).toBe(false);

      state.tray.set('gator-message-1', {
        ...first,
        android: {
          ...first.android,
          groupId: 'gator-message-group',
          groupAlertBehavior: 2,
        },
      });
      state.tray.set('gator-message-3', {
        ...second,
        android: {
          ...second.android,
          groupId: 'gator-message-group',
          groupAlertBehavior: 2,
        },
      });
      await prepareNotificationPresentationState();
      expect(state.tray.has('gator-message-summary')).toBe(true);

      const cleanSummary = state.tray.get('gator-message-summary');
      state.tray.set('gator-message-summary', {
        ...cleanSummary,
        subtitle: 'PRIVATE_SUBTITLE',
        data: { ...cleanSummary?.data, privatePreview: 'PRIVATE_DATA' },
        android: {
          ...cleanSummary?.android,
          ticker: 'PRIVATE_TICKER',
          style: { type: 1, text: 'PRIVATE_STYLE' },
        },
      });
      await prepareNotificationPresentationState();
      const repairedSummary = state.tray.get('gator-message-summary');
      expect(repairedSummary?.data).toEqual({
        gatorOwner: 'gator',
        gatorSchema: '2',
        gatorKind: 'message-summary',
      });
      expect(repairedSummary).not.toHaveProperty('subtitle');
      expect(repairedSummary?.android).not.toHaveProperty('ticker');
      expect(repairedSummary?.android).not.toHaveProperty('style');
      expect(JSON.stringify(repairedSummary)).not.toContain('PRIVATE_');
    } finally {
      state.restore();
    }
  });

  it('does not cancel a summary while an unrecognized native group member remains', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const first = state.tray.get('gator-message-1');
      const removed = state.tray.get('gator-message-3');
      state.tray.delete('gator-message-3');
      state.tray.set('gator-message-1', {
        ...first,
        data: { ...first?.data, gatorOwner: 'unrecognized-owner' },
      });
      const summary = state.tray.get('gator-message-summary');
      state.tray.set('gator-message-summary', {
        ...summary,
        subtitle: 'PRIVATE_SUBTITLE',
        data: { ...summary?.data, privatePreview: 'PRIVATE_DATA' },
        android: {
          ...summary?.android,
          ticker: 'PRIVATE_TICKER',
          style: { type: 1, text: 'PRIVATE_STYLE' },
        },
      });
      mockCancel.mockClear();

      await reconcileMessageNotificationGroupAfterRemoval(removed);

      expect(state.tray.has('gator-message-1')).toBe(true);
      expect(state.tray.has('gator-message-summary')).toBe(true);
      expect(JSON.stringify(state.tray.get('gator-message-summary'))).not.toContain('PRIVATE_');
      expect(mockCancel).not.toHaveBeenCalledWith('gator-message-summary');
    } finally {
      state.restore();
    }
  });

  it('repairs a stale private summary in place while one grouped child remains', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const survivingChild = state.tray.get('gator-message-1');
      const summary = state.tray.get('gator-message-summary');
      state.tray.delete('gator-message-3');
      state.tray.set('gator-message-summary', {
        ...summary,
        body: 'New messages from multiple conversations',
        subtitle: 'PRIVATE_SUBTITLE',
        data: { ...summary?.data, privatePreview: 'PRIVATE_DATA' },
        android: {
          ...summary?.android,
          ticker: 'PRIVATE_TICKER',
          style: { type: 1, text: 'PRIVATE_STYLE' },
        },
      });
      mockDisplay.mockClear();
      mockCancel.mockClear();

      await prepareNotificationPresentationState();

      expect(state.tray.get('gator-message-1')).toBe(survivingChild);
      expect(state.tray.has('gator-message-3')).toBe(false);
      const repairedSummary = state.tray.get('gator-message-summary');
      expect(repairedSummary).toEqual(
        expect.objectContaining({
          id: 'gator-message-summary',
          title: 'Gator',
          body: 'New messages',
          data: {
            gatorOwner: 'gator',
            gatorSchema: '2',
            gatorKind: 'message-summary',
          },
        }),
      );
      expect(JSON.stringify(repairedSummary)).not.toContain('PRIVATE_');
      expect(mockDisplay).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'gator-message-summary', body: 'New messages' }),
      );
      expect(mockCancel).not.toHaveBeenCalledWith('gator-message-summary');
    } finally {
      state.restore();
    }
  });

  it('contains a malformed MessagingStyle member and leaves delivery reusable', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const malformed = state.tray.get('gator-message-1');
      state.tray.set('gator-message-1', {
        ...malformed,
        android: {
          ...malformed?.android,
          style: { type: 3 },
        },
      });
      state.tray.delete('gator-message-3');
      const summary = state.tray.get('gator-message-summary');
      state.tray.set('gator-message-summary', {
        ...summary,
        subtitle: 'PRIVATE_SUBTITLE',
        data: { ...summary?.data, privatePreview: 'PRIVATE_DATA' },
        android: { ...summary?.android, ticker: 'PRIVATE_TICKER' },
      });

      await expect(
        postNotification(
          messageIntent({
            chatGuid: 'chat-3',
            chatTitle: 'Bob',
            senderName: 'Bob',
            messageGuid: 'msg-retry',
            body: 'retry line',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(state.tray.has('gator-message-1')).toBe(true);
      expect(state.tray.has('gator-message-3')).toBe(true);
      expect(JSON.stringify(state.tray.get('gator-message-summary'))).not.toContain('PRIVATE_');
      await expect(reconcileMessageNotificationGroup()).resolves.toBeUndefined();
    } finally {
      state.restore();
    }
  });

  it('does not resurrect a child swiped after the message-history snapshot was captured', async () => {
    const stale = displayedMessageChild(3, 199);
    const state = installStatefulTray([stale]);
    try {
      mockGetDisplayed.mockImplementationOnce(async () => {
        const snapshot = [{ id: stale.id, notification: stale }];
        // Model Android delivering a swipe while this post is still using its history snapshot.
        state.tray.delete('gator-message-3');
        return snapshot;
      });

      await postNotification(messageIntent());

      expect(state.tray.has('gator-message-1')).toBe(true);
      expect(state.tray.has('gator-message-3')).toBe(false);
      expect(state.tray.has('gator-message-summary')).toBe(false);
    } finally {
      state.restore();
    }
  });

  it('clears existing groups during App Lock startup and does not reconstruct them after warm unlock', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const summary = state.tray.get('gator-message-summary');
      expect(summary).toBeDefined();

      useLockStore.setState({ enabled: true, locked: true });
      await prepareNotificationPresentationState();

      expect(state.tray.size).toBe(0);

      const second = state.tray.get('gator-message-3');
      state.tray.delete('gator-message-3');
      await reconcileMessageNotificationGroupAfterRemoval(second);
      expect(state.tray.size).toBe(0);

      useLockStore.setState({ locked: false });
      await reconcileMessageNotificationGroup();
      expect(state.tray.size).toBe(0);
    } finally {
      state.restore();
    }
  });

  it('does not inspect or rebuild native children when headless App Lock requires protection', async () => {
    const first = displayedMessageChild(1, 101);
    const state = installStatefulTray([first, displayedMessageChild(3, 199)]);
    try {
      useLockStore.setState({ hydrated: false });

      await reconcileMessageNotificationGroupAfterRemoval(first);

      expect(mockGetDisplayed).not.toHaveBeenCalled();
      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(state.tray.has('gator-message-summary')).toBe(false);
    } finally {
      state.restore();
    }
  });

  it.each([null, 'false'])(
    'repairs only the generic summary for headless App Lock OFF (%s)',
    async (stored) => {
      const state = installStatefulTray();
      try {
        useLockStore.setState({ hydrated: false });
        const lockSnapshot = useLockStore.getState();
        mockVault.get.mockResolvedValue(stored);

        await postNotification(messageIntent());
        expect(state.tray.has('gator-message-summary')).toBe(false);
        await postNotification(messageIntent({ chatGuid: 'chat-3', messageGuid: 'msg-other' }));

        const summary = state.tray.get('gator-message-summary');
        const survivor = state.tray.get('gator-message-3');
        expect(summary).toEqual(
          expect.objectContaining({
            title: 'Gator',
            body: 'New messages',
            data: { gatorOwner: 'gator', gatorSchema: '2', gatorKind: 'message-summary' },
            android: expect.objectContaining({
              groupSummary: true,
              groupAlertBehavior: 2,
              onlyAlertOnce: true,
            }),
          }),
        );
        expect(useLockStore.getState()).toBe(lockSnapshot);
        expect(mockVault.get).toHaveBeenCalledWith('appLockEnabled');
        expect(mockDisplay).toHaveBeenCalledTimes(3);

        state.tray.delete('gator-message-1');
        await reconcileMessageNotificationGroup();
        expect(state.tray.get('gator-message-3')).toBe(survivor);
        expect(state.tray.get('gator-message-summary')).toBe(summary);
        state.tray.delete('gator-message-3');
        await reconcileMessageNotificationGroup();
        expect(state.tray.size).toBe(0);
        expect(mockDisplay).toHaveBeenCalledTimes(3);
      } finally {
        state.restore();
      }
    },
  );

  it.each(['invalid', 'unavailable'])(
    'leaves a headless group untouched for %s persisted lock state',
    async (failure) => {
      const first = {
        ...displayedMessageChild(1, 101),
        android: {
          ...displayedMessageChild(1, 101).android,
          groupId: 'gator-message-group',
          groupAlertBehavior: 2,
        },
      };
      const second = {
        ...displayedMessageChild(3, 199),
        android: {
          ...displayedMessageChild(3, 199).android,
          groupId: 'gator-message-group',
          groupAlertBehavior: 2,
        },
      };
      const state = installStatefulTray([first, second]);
      try {
        useLockStore.setState({ hydrated: false });
        if (failure === 'unavailable')
          mockVault.get.mockRejectedValue(new Error('vault unavailable'));
        else mockVault.get.mockResolvedValue('invalid');

        await reconcileMessageNotificationGroup();

        expect(mockGetDisplayed).not.toHaveBeenCalled();
        expect(mockDisplay).not.toHaveBeenCalled();
        expect(mockCancel).not.toHaveBeenCalled();
        expect([...state.tray.values()]).toEqual([first, second]);
      } finally {
        state.restore();
      }
    },
  );

  it.each(['lock-change', 'account-retirement'])(
    'rejects a headless OFF read after %s',
    async (change) => {
      let finishRead!: (value: string) => void;
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      useLockStore.setState({ hydrated: false });
      mockVault.get.mockImplementation(() => {
        readStarted();
        return new Promise<string>((resolve) => {
          finishRead = resolve;
        });
      });
      const pending = reconcileMessageNotificationGroup();
      await started;
      if (change === 'account-retirement') pauseRealtimeDeliveries();
      else {
        useLockStore.getState().setEnabled(true);
        useLockStore.getState().setEnabled(false);
      }
      finishRead('false');
      await pending;
      expect(mockGetDisplayed).not.toHaveBeenCalled();
      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    },
  );

  it('rechecks the headless policy after native enumeration without reposting its children', async () => {
    const first = displayedMessageChild(1, 101);
    const second = displayedMessageChild(3, 199);
    first.android.groupId = second.android.groupId = 'gator-message-group';
    first.android.groupAlertBehavior = second.android.groupAlertBehavior = 2;
    const state = installStatefulTray([first, second]);
    try {
      useLockStore.setState({ hydrated: false });
      mockVault.get.mockResolvedValue('false');
      mockGetDisplayed.mockImplementationOnce(async () => {
        useLockStore.getState().setEnabled(true);
        return [...state.tray].map(([id, notification]) => ({ id, notification }));
      });
      await reconcileMessageNotificationGroup();
      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect([...state.tray.values()]).toEqual([first, second]);
    } finally {
      state.restore();
    }
  });

  it('contains a headless summary if its implicit account lease retires during native posting', async () => {
    const state = installStatefulTray();
    try {
      useLockStore.setState({ hydrated: false });
      mockVault.get.mockResolvedValue('false');
      await postNotification(messageIntent());
      mockDisplay.mockImplementation(async (notification: Record<string, any>) => {
        state.tray.set(notification.id, notification);
        if (notification.id === 'gator-message-summary') pauseRealtimeDeliveries();
      });

      await postNotification(messageIntent({ chatGuid: 'chat-3', messageGuid: 'msg-other' }));

      expect(mockCancel).toHaveBeenCalledWith('gator-message-summary');
      expect(state.tray.size).toBe(0);
    } finally {
      state.restore();
    }
  });

  it('bounds a hung headless lock read and ignores its late result', async () => {
    jest.useFakeTimers();
    let finishRead!: (value: string) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    try {
      useLockStore.setState({ hydrated: false });
      mockVault.get.mockImplementationOnce(() => {
        readStarted();
        return new Promise<string>((resolve) => {
          finishRead = resolve;
        });
      });
      const pending = reconcileMessageNotificationGroup();
      await started;
      await jest.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(mockGetDisplayed).not.toHaveBeenCalled();
      useLockStore.setState({ hydrated: true });
      await reconcileMessageNotificationGroup();
      expect(mockGetDisplayed).toHaveBeenCalledTimes(1);
      const displayCount = mockDisplay.mock.calls.length;
      const cancelCount = mockCancel.mock.calls.length;
      finishRead('false');
      await Promise.resolve();
      expect(mockDisplay).toHaveBeenCalledTimes(displayCount);
      expect(mockCancel).toHaveBeenCalledTimes(cancelCount);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves existing history and leaves the queue reusable when tray enumeration fails', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const existing = state.tray.get('gator-message-1');
      const other = state.tray.get('gator-message-3');
      expect(state.tray.has('gator-message-summary')).toBe(true);
      mockCancel.mockClear();
      mockGetDisplayed.mockRejectedValueOnce(new Error('tray unavailable'));

      await expect(
        postNotification(
          messageIntent({
            messageGuid: 'msg-2',
            body: 'new line',
            timestamp: 1700000000200,
          }),
        ),
      ).rejects.toThrow('tray unavailable');

      expect(state.tray.get('gator-message-1')).toBe(existing);
      expect(state.tray.get('gator-message-3')).toBe(other);
      expect(state.tray.has('gator-message-summary')).toBe(true);
      expect(mockCancel).not.toHaveBeenCalledWith('gator-message-summary');

      // The queue recovers and a retry merges rather than overwrites the retained line.
      await expect(
        postNotification(
          messageIntent({
            messageGuid: 'msg-2',
            body: 'new line',
            timestamp: 1700000000200,
          }),
        ),
      ).resolves.toBeUndefined();
      const repaired = state.tray.get('gator-message-1');
      expect(repaired?.android?.groupId).toBe('gator-message-group');
      expect(repaired?.android?.style.messages.map((line: { text: string }) => line.text)).toEqual([
        'secret plans',
        'new line',
      ]);
    } finally {
      state.restore();
    }
  });

  it('preserves an existing group when maintenance enumeration fails', async () => {
    const state = installStatefulTray();
    try {
      await postNotification(messageIntent());
      await postNotification(
        messageIntent({
          chatGuid: 'chat-3',
          chatTitle: 'Bob',
          senderName: 'Bob',
          messageGuid: 'msg-other',
          body: 'another chat',
        }),
      );
      const before = [...state.tray];
      mockCancel.mockClear();
      mockGetDisplayed.mockRejectedValueOnce(new Error('tray unavailable'));

      await expect(reconcileMessageNotificationGroup()).resolves.toBeUndefined();

      expect([...state.tray]).toEqual(before);
      expect(mockCancel).not.toHaveBeenCalled();
      await expect(reconcileMessageNotificationGroup()).resolves.toBeUndefined();
      expect([...state.tray]).toEqual(before);
    } finally {
      state.restore();
    }
  });

  it.each([
    [
      'message',
      messageIntent({
        chatTitle: 'LOCKED_MESSAGE_TITLE_CANARY',
        senderName: 'LOCKED_MESSAGE_SENDER_CANARY',
        body: 'LOCKED_MESSAGE_BODY_CANARY',
      }),
    ],
    [
      'failed send',
      {
        kind: 'send-failure',
        chatGuid: 'LOCKED_FAILURE_CHAT_CANARY',
        messageGuid: 'LOCKED_FAILURE_MESSAGE_CANARY',
      } as NotificationIntent,
    ],
    [
      'alias removal',
      {
        kind: 'alias-removed',
        aliases: ['LOCKED_ALIAS_CANARY@example.com'],
      } as NotificationIntent,
    ],
  ])('posts only the generic locked notice for a queued %s intent', async (_label, intent) => {
    useLockStore.setState({
      enabled: true,
      locked: false,
      lastBackgrounded: 1,
      timeoutMs: 30_000,
    });
    jest.spyOn(Date, 'now').mockReturnValue(31_001);

    await postNotification(intent);

    const n = lastNotif();
    expect(n.id).toBe('bb-locked-messages');
    expect(n.title).toBe('Gator');
    expect(n.body).toBe('You have new messages');
    expect(JSON.stringify(n)).not.toMatch(/LOCKED_|chat-1|msg-1/);
    expect(mockLocalRouteForGuids).not.toHaveBeenCalled();
  });

  it('rechecks App Lock after a deferred message channel lookup', async () => {
    let releaseChannel!: () => void;
    mockGetChannel.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseChannel = () => resolve(null);
        }),
    );
    const pending = postNotification(
      messageIntent({
        chatTitle: 'LATE_LOCK_MESSAGE_TITLE_CANARY',
        senderName: 'LATE_LOCK_MESSAGE_SENDER_CANARY',
        body: 'LATE_LOCK_MESSAGE_BODY_CANARY',
      }),
    );
    for (let i = 0; i < 20 && mockGetChannel.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    useLockStore.setState({ enabled: true, locked: true });
    releaseChannel();
    await pending;

    const notification = lastNotif();
    expect(notification).toEqual(
      expect.objectContaining({
        id: 'bb-locked-messages',
        title: 'Gator',
        body: 'You have new messages',
      }),
    );
    expect(JSON.stringify(notification)).not.toMatch(/LATE_LOCK_MESSAGE_/);
  });

  it('posts one notification per chat with a local-key id and the real title/body/sender', async () => {
    await postNotification(messageIntent({ avatarUri: 'file:///a.png' }));
    const n = lastNotif();
    expect(n.id).toBe('gator-message-1');
    expect(n.title).toBe('Alice');
    expect(n.body).toBe('secret plans');
    // messageDate (stringified timestamp) is carried so a notification tap can deep-link with
    // ?focusDate and scroll the chat to the message.
    expect(n.data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'message',
      chatId: '1',
      messageId: '101',
      messageDate: '1700000000000',
      messageHistoryIds: '101',
    });
    expect(JSON.stringify({ id: n.id, data: n.data })).not.toMatch(/chat-1|msg-1|alice@x\.com/);
    expect(n.android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
    expect(n.android?.pressAction).toEqual({ id: PRESS_OPEN, launchActivity: 'default' });
  });

  it('uses the MESSAGING style and INCLUDES person.icon when an avatar is present', async () => {
    await postNotification(messageIntent({ avatarUri: 'file:///a.png' }));
    const style = lastNotif().android?.style;
    expect(style.type).toBe(3); // AndroidStyle.MESSAGING
    const sender = style.messages[0].person;
    expect(sender.name).toBe('Alice');
    expect(sender.id).toBe('contact');
    expect(sender.icon).toBe('file:///a.png');
  });

  it('bounds incoming and adopted message history before every native post', async () => {
    const existing = displayedMessageChild(1, 101);
    existing.title = '😀'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1);
    existing.android.style.messages[0] = {
      text: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS + 1),
      timestamp: 1700000000000,
      person: {
        name: `  ${'e\u0301'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1)}  `,
        id: 'contact',
        icon: `file:///${'a'.repeat(MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES)}`,
      },
    };
    const state = installStatefulTray([existing]);
    mockGetChannel.mockResolvedValueOnce({ importance: 4 });

    try {
      await postNotification(
        messageIntent({
          messageGuid: 'msg-2',
          body: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS + 1),
          senderName: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1),
          chatTitle: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1),
          avatarUri: `file:///${'b'.repeat(MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES)}`,
          timestamp: 1700000000001,
        }),
      );

      const posted = state.tray.get('gator-message-1')!;
      expect(posted.data?.messageHistoryIds).toBe('101,199');
      expect([...posted.title]).toHaveLength(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS);
      expect(notificationTextEncoder.encode(posted.title).byteLength).toBeLessThanOrEqual(
        MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
      );
      expect(mockCreateChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'com.bluegreengatorapps.messages.new_messages.chat.route_1',
          name: posted.title,
        }),
      );

      const lines = posted.android.style.messages as {
        text: string;
        person: { name: string; icon?: string };
      }[];
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect([...line.text].length).toBeLessThanOrEqual(
          MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS,
        );
        expect(notificationTextEncoder.encode(line.text).byteLength).toBeLessThanOrEqual(
          MAX_MESSAGE_NOTIFICATION_TEXT_BYTES,
        );
        expect([...line.person.name].length).toBeLessThanOrEqual(
          MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS,
        );
        expect(notificationTextEncoder.encode(line.person.name).byteLength).toBeLessThanOrEqual(
          MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
        );
        expect(line.person).not.toHaveProperty('icon');
      }
      expect(lines[0]?.person.name).toBe(lines[0]?.person.name.normalize('NFC').trim());

      mockListMessageNotificationTruth.mockResolvedValueOnce([messageTruth(199, 1)]);
      await postNotification({
        kind: 'message-withdraw',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
      });
      const afterWithdrawal = state.tray.get('gator-message-1')!;
      expect(afterWithdrawal.data?.messageHistoryIds).toBe('199');
      expect(afterWithdrawal.android?.style.messages).toHaveLength(1);
      expect(afterWithdrawal.android?.style.messages[0]).toEqual(lines[1]);
    } finally {
      state.restore();
    }
  });

  describe('headless withdrawal', () => {
    const withdrawal: NotificationIntent = {
      kind: 'message-withdraw',
      chatGuid: 'chat-1',
      messageGuid: 'history-4',
    };

    function coldHistory() {
      const ids = [102, 103, 104, 105, 106, 107];
      const child = displayedMessageChild(1, 107);
      child.body = 'History line 7';
      child.data.messageHistoryIds = ids.join(',');
      child.android.style.messages = ids.map((id) => ({
        ...displayedMessageChild(1, id).android.style.messages[0],
        text: `History line ${id - 100}`,
      }));
      const other = displayedMessageChild(3, 303);
      const state = installStatefulTray([child, other]);
      useLockStore.setState({ hydrated: false });
      mockVault.get.mockResolvedValue('false');
      mockListMessageNotificationTruth.mockImplementation(async (messageIds: number[]) =>
        messageIds.map((id) =>
          messageTruth(
            id,
            id === 303 ? 3 : 1,
            id === 104
              ? { notificationEligible: 0, retractionState: 'full', dateRetracted: 1700000001000 }
              : {},
          ),
        ),
      );
      return { ...state, child, other };
    }

    it.each([null, 'false'])(
      'keeps five surviving cold-process history lines with persisted App Lock OFF (%s)',
      async (stored) => {
        const state = coldHistory();
        const lockSnapshot = useLockStore.getState();
        mockVault.get.mockResolvedValue(stored);
        try {
          await postNotification(withdrawal);

          const survivor = state.tray.get('gator-message-1');
          expect(survivor?.data.messageHistoryIds).toBe('102,103,105,106,107');
          expect(
            survivor?.android.style.messages.map((line: { text: string }) => line.text),
          ).toEqual([
            'History line 2',
            'History line 3',
            'History line 5',
            'History line 6',
            'History line 7',
          ]);
          expect(survivor?.android.onlyAlertOnce).toBe(true);
          expect(survivor?.body).toBe('History line 7');
          expect(state.tray.get('gator-message-3')).toBe(state.other);
          expect(mockCancel).not.toHaveBeenCalledWith('gator-message-1');
          expect(mockDisplay.mock.calls.some(([value]) => value.id === 'gator-message-3')).toBe(
            false,
          );
          expect(mockVault.get).toHaveBeenCalledWith('appLockEnabled');
          expect(useLockStore.getState()).toBe(lockSnapshot);
        } finally {
          state.restore();
        }
      },
    );

    it.each(['true', 'invalid', undefined, 'unavailable'])(
      'contains the changed child without reposting for persisted policy %s',
      async (stored) => {
        const state = coldHistory();
        if (stored === 'unavailable')
          mockVault.get.mockRejectedValue(new Error('vault unavailable'));
        else mockVault.get.mockResolvedValue(stored);
        try {
          await postNotification(withdrawal);

          expect(state.tray.has('gator-message-1')).toBe(false);
          expect(state.tray.get('gator-message-3')).toBe(state.other);
          expect(mockDisplay).not.toHaveBeenCalled();
          expect(useLockStore.getState().hydrated).toBe(false);
        } finally {
          state.restore();
        }
      },
    );

    it('keeps a hydrated locked policy authoritative over persisted OFF', async () => {
      const state = coldHistory();
      useLockStore.setState({ hydrated: true, enabled: true, locked: true });
      try {
        await postNotification(withdrawal);

        expect(state.tray.has('gator-message-1')).toBe(false);
        expect(mockDisplay).not.toHaveBeenCalled();
        expect(mockVault.get).not.toHaveBeenCalled();
      } finally {
        state.restore();
      }
    });

    it.each(['lock-change', 'account-retirement'])(
      'rejects a pending headless OFF result after %s',
      async (change) => {
        const state = coldHistory();
        let finishRead!: (value: string) => void;
        let readStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        mockVault.get.mockImplementationOnce(() => {
          readStarted();
          return new Promise<string>((resolve) => {
            finishRead = resolve;
          });
        });
        try {
          const pending = postNotification(withdrawal);
          await started;
          if (change === 'account-retirement') pauseRealtimeDeliveries();
          else {
            useLockStore.getState().setEnabled(true);
            useLockStore.getState().setEnabled(false);
          }
          finishRead('false');
          await pending;

          expect(mockDisplay).not.toHaveBeenCalled();
          expect(state.tray.get('gator-message-3')).toBe(state.other);
          expect(state.tray.has('gator-message-1')).toBe(change === 'account-retirement');
          if (change === 'account-retirement')
            expect(mockCancel).not.toHaveBeenCalledWith('gator-message-1');
        } finally {
          state.restore();
        }
      },
    );

    it('bounds an unavailable OFF read and ignores a late completion', async () => {
      jest.useFakeTimers();
      const state = coldHistory();
      let finishRead!: (value: string) => void;
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      mockVault.get.mockImplementationOnce(() => {
        readStarted();
        return new Promise<string>((resolve) => {
          finishRead = resolve;
        });
      });
      try {
        const pending = postNotification(withdrawal);
        await started;
        await jest.advanceTimersByTimeAsync(2_000);
        await pending;

        expect(state.tray.has('gator-message-1')).toBe(false);
        expect(mockDisplay).not.toHaveBeenCalled();
        const cancelCount = mockCancel.mock.calls.length;
        finishRead('false');
        await Promise.resolve();
        expect(mockDisplay).not.toHaveBeenCalled();
        expect(mockCancel).toHaveBeenCalledTimes(cancelCount);
      } finally {
        state.restore();
        jest.useRealTimers();
      }
    });

    it('does not resurrect a cold-process child swiped during its DB truth read', async () => {
      const state = coldHistory();
      const truth = mockListMessageNotificationTruth.getMockImplementation()!;
      mockListMessageNotificationTruth.mockImplementationOnce(async (ids: number[]) => {
        const rows = await truth(ids);
        state.tray.delete('gator-message-1');
        return rows;
      });
      try {
        await postNotification(withdrawal);

        expect(state.tray.has('gator-message-1')).toBe(false);
        expect(mockDisplay).not.toHaveBeenCalled();
        expect(state.tray.get('gator-message-3')).toBe(state.other);
      } finally {
        state.restore();
      }
    });

    it.each(['lock-change', 'account-retirement'])(
      'compensates an in-flight cold-history replacement after %s',
      async (change) => {
        const state = coldHistory();
        mockDisplay.mockImplementation(async (notification: Record<string, any>) => {
          state.tray.set(notification.id, notification);
          if (change === 'account-retirement') pauseRealtimeDeliveries();
          else useLockStore.getState().setEnabled(true);
        });
        try {
          await postNotification(withdrawal);

          expect(mockDisplay).toHaveBeenCalledWith(
            expect.objectContaining({
              id: 'gator-message-1',
              data: expect.objectContaining({ messageHistoryIds: '102,103,105,106,107' }),
            }),
          );
          expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
          expect(state.tray.has('gator-message-1')).toBe(false);
          expect(state.tray.get('gator-message-3')).toBe(state.other);
        } finally {
          state.restore();
        }
      },
    );
  });

  it('cancels adopted history whose channel belongs to another chat', async () => {
    const foreignChannelHistory = displayedMessageChild(1, 101);
    foreignChannelHistory.data.messageId = '199';
    foreignChannelHistory.data.messageHistoryIds = '101,199';
    foreignChannelHistory.android.channelId = chatChannelId(3);
    foreignChannelHistory.android.style.messages.push({
      text: 'Another line',
      timestamp: 1700000000199,
      person: { name: 'Contact 1', id: 'contact' },
    });
    const state = installStatefulTray([foreignChannelHistory]);

    try {
      await expect(
        postNotification({
          kind: 'message-withdraw',
          chatGuid: 'chat-1',
          messageGuid: 'msg-1',
        }),
      ).rejects.toThrow('malformed displayed message history was cancelled');

      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
      expect(state.tray.has('gator-message-1')).toBe(false);
    } finally {
      state.restore();
    }
  });

  it('silently replaces an exact partial retraction from current DB truth', async () => {
    const state = installStatefulTray([displayedMessageChild(1, 101)]);
    mockListMessageNotificationTruth.mockResolvedValueOnce([
      messageTruth(101, 1, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: JSON.stringify({
          complete: true,
          originalPartIndexes: [0, 1],
          currentParts: [{ index: 1, kind: 'text' }],
          attachmentOwnership: [],
        }),
        text: 'surviving part only',
      }),
    ]);

    try {
      await postNotification({
        kind: 'message-withdraw',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
      });

      const replacement = state.tray.get('gator-message-1')!;
      expect(replacement.body).toBe('surviving part only');
      expect(replacement.android.style.messages[0].text).toBe('surviving part only');
      expect(replacement.android.onlyAlertOnce).toBe(true);
      expect(mockCancel).not.toHaveBeenCalledWith('gator-message-1');
      expect(mockCancel).toHaveBeenCalledWith('chat-1');
    } finally {
      state.restore();
    }
  });

  it.each([
    [
      'fully retracted',
      messageTruth(101, 1, { notificationEligible: 0, retractionState: 'fully-retracted' }),
    ],
    ['unknown', messageTruth(101, 1, { notificationEligible: 0, retractionState: 'unknown' })],
    ['read, deleted, or muted', messageTruth(101, 1, { notificationEligible: 0 })],
    [
      'malformed partial topology',
      messageTruth(101, 1, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: '{malformed',
      }),
    ],
  ])('removes a %s history line instead of retaining plaintext', async (_label, truth) => {
    const state = installStatefulTray([displayedMessageChild(1, 101)]);
    mockListMessageNotificationTruth.mockResolvedValueOnce([truth]);

    try {
      await postNotification({
        kind: 'message-withdraw',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
      });

      expect(state.tray.has('gator-message-1')).toBe(false);
      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
    } finally {
      state.restore();
    }
  });

  it('does not resurrect a child swiped while DB truth is loading', async () => {
    const child = displayedMessageChild(1, 101);
    mockGetDisplayed
      .mockResolvedValueOnce([{ id: child.id, notification: child }])
      .mockResolvedValueOnce([]);
    mockListMessageNotificationTruth.mockResolvedValueOnce([
      messageTruth(101, 1, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: JSON.stringify({
          complete: true,
          originalPartIndexes: [0, 1],
          currentParts: [{ index: 1, kind: 'text' }],
          attachmentOwnership: [],
        }),
        text: 'surviving part only',
      }),
    ]);

    await postNotification({
      kind: 'message-withdraw',
      chatGuid: 'chat-1',
      messageGuid: 'msg-1',
    });

    expect(mockDisplay).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalledWith('gator-message-1');
    expect(mockCancel).toHaveBeenCalledWith('chat-1');
  });

  it('revalidates each child after an earlier sibling replacement awaits native work', async () => {
    const first = displayedMessageChild(1, 101);
    const second = displayedMessageChild(3, 199);
    const state = installStatefulTray([first, second]);
    const topology = JSON.stringify({
      complete: true,
      originalPartIndexes: [0, 1],
      currentParts: [{ index: 1, kind: 'text' }],
      attachmentOwnership: [],
    });
    mockListMessageNotificationTruth.mockResolvedValueOnce([
      messageTruth(101, 1, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: topology,
        text: 'first survivor',
      }),
      messageTruth(199, 3, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: topology,
        text: 'second survivor',
      }),
    ]);
    mockDisplay.mockImplementation(async (notification: Record<string, any>) => {
      if (typeof notification.id === 'string') state.tray.set(notification.id, notification);
      if (notification.id === first.id) state.tray.delete(second.id);
    });

    try {
      await postNotification({
        kind: 'message-withdraw',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
      });

      expect(state.tray.get(first.id)?.body).toBe('first survivor');
      expect(state.tray.has(second.id)).toBe(false);
      expect(mockDisplay.mock.calls.map((call) => call[0].id)).toEqual([first.id]);
    } finally {
      state.restore();
    }
  });

  it('cancels a partial replacement committed as its account lease is revoked', async () => {
    const child = displayedMessageChild(1, 101);
    const state = installStatefulTray([child]);
    let current = true;
    const lease = { generation: 41, isCurrent: () => current };
    mockListMessageNotificationTruth.mockResolvedValueOnce([
      messageTruth(101, 1, {
        retractionState: 'partial',
        dateRetracted: 1700000001000,
        messagePartTopology: JSON.stringify({
          complete: true,
          originalPartIndexes: [0, 1],
          currentParts: [{ index: 1, kind: 'text' }],
          attachmentOwnership: [],
        }),
        text: 'late survivor',
      }),
    ]);
    mockDisplay.mockImplementationOnce(async (notification: Record<string, any>) => {
      if (typeof notification.id === 'string') state.tray.set(notification.id, notification);
      current = false;
    });

    try {
      await postNotification(
        { kind: 'message-withdraw', chatGuid: 'chat-1', messageGuid: 'msg-1' },
        lease,
      );

      expect(mockDisplay).toHaveBeenCalledWith(
        expect.objectContaining({ id: child.id, body: 'late survivor' }),
      );
      expect(mockCancel).toHaveBeenCalledWith(child.id);
      expect(state.tray.has(child.id)).toBe(false);
    } finally {
      state.restore();
    }
  });

  it('OMITS the person.icon key entirely when there is no avatar (never icon:undefined)', async () => {
    await postNotification(messageIntent({ avatarUri: undefined }));
    const sender = lastNotif().android?.style.messages[0].person;
    expect(sender).not.toHaveProperty('icon'); // the AGENTS.md conditional-spread rule
  });

  it('keeps iMessage actions to Reply and Mark Read even under injected private_api:true', async () => {
    await postNotification(messageIntent());
    const actions = lastNotif().android?.actions as any[];
    expect(actions.map((a) => a.pressAction.id)).toEqual([ACTION_REPLY, ACTION_MARK_READ]);
    expect(actions[0].input.allowFreeFormInput).toBe(true);
  });

  it('exposes Love only for a canonical RCS chat with live RCS capability', async () => {
    await postNotification(
      messageIntent({ chatGuid: 'RCS;-;thread-1', messageGuid: 'rcs-message-1' }),
    );

    const actions = lastNotif().android?.actions as any[];
    expect(actions.map((action) => action.pressAction.id)).toEqual([
      ACTION_REPLY,
      ACTION_MARK_READ,
      ACTION_LOVE,
    ]);
  });

  it('hides Love when an RCS chat notification has a noncanonical message target', async () => {
    await postNotification(
      messageIntent({ chatGuid: 'RCS;-;thread-1', messageGuid: 'legacy-message' }),
    );

    const actions = lastNotif().android?.actions as any[];
    expect(actions.map((action) => action.pressAction.id)).toEqual([
      ACTION_REPLY,
      ACTION_MARK_READ,
    ]);
  });

  it('shows Love for a canonical RCS notification in a cold process without session cache', async () => {
    useSessionStore.setState({ serverInfo: null });
    await postNotification(
      messageIntent({ chatGuid: 'RCS;-;thread-1', messageGuid: 'rcs-message-1' }),
    );

    const actions = lastNotif().android?.actions as any[];
    expect(actions.map((action) => action.pressAction.id)).toEqual([
      ACTION_REPLY,
      ACTION_MARK_READ,
      ACTION_LOVE,
    ]);
  });

  it('marks the MESSAGING style as a group for a group chat', async () => {
    await postNotification(messageIntent({ isGroup: true }));
    expect(lastNotif().android?.style.group).toBe(true);
  });

  it('serializes concurrent chat updates and withdraws only the matching history line', async () => {
    let displayed: ReturnType<typeof lastNotif> | undefined;
    mockGetDisplayed.mockImplementation(async () =>
      displayed ? [{ id: displayed.id, notification: displayed }] : [],
    );
    mockDisplay.mockImplementation(async (notification) => {
      displayed = notification;
    });

    try {
      await Promise.all([
        postNotification(messageIntent()),
        postNotification(
          messageIntent({
            messageGuid: 'msg-2',
            body: 'second line',
            senderName: 'Bob',
            timestamp: 1700000000001,
          }),
        ),
      ]);

      expect(displayed?.data?.messageHistoryIds).toBe('101,199');
      expect(displayed?.android?.style.messages.map((line: { text: string }) => line.text)).toEqual(
        ['secret plans', 'second line'],
      );

      mockListMessageNotificationTruth.mockResolvedValueOnce([messageTruth(199, 1)]);
      await postNotification({
        kind: 'message-withdraw',
        chatGuid: 'chat-1',
        messageGuid: 'msg-1',
      });

      expect(displayed?.data).toEqual(
        expect.objectContaining({ messageId: '199', messageHistoryIds: '199' }),
      );
      expect(displayed?.android?.style.messages).toHaveLength(1);
      expect(displayed?.android?.style.messages[0].text).toBe('second line');
      expect(displayed?.android?.onlyAlertOnce).toBe(true);
      expect(mockCancel).not.toHaveBeenCalledWith('gator-message-1');
      expect(mockCancel).toHaveBeenCalledWith('chat-1');

      // If Android cannot replace the tray notice after a withdrawal, privacy wins: remove the
      // original notice rather than leave the withdrawn line visible, even if account ownership
      // changes during the failed native replacement.
      await postNotification(messageIntent());
      let current = true;
      const lease = { generation: 27, isCurrent: () => current };
      mockListMessageNotificationTruth.mockResolvedValueOnce([messageTruth(199, 1)]);
      mockDisplay.mockImplementationOnce(async () => {
        current = false;
        throw new Error('native replacement failed');
      });
      await expect(
        postNotification(
          {
            kind: 'message-withdraw',
            chatGuid: 'chat-1',
            messageGuid: 'msg-1',
          },
          lease,
        ),
      ).rejects.toThrow('message notification reconciliation failed');
      expect(mockCancel).toHaveBeenCalledWith('gator-message-1');
    } finally {
      mockGetDisplayed.mockImplementation(async () => []);
      mockDisplay.mockImplementation(async () => undefined);
    }
  });

  it('suppresses only the exact visible chat at the native presentation boundary', async () => {
    const active = claimActiveChat('chat-1');
    active.setVisible(true);

    await postNotification(messageIntent());
    expect(mockDisplay).not.toHaveBeenCalled();

    await postNotification(
      messageIntent({ chatGuid: 'chat-3', messageGuid: 'msg-other', body: 'another chat' }),
    );
    expect(mockDisplay).toHaveBeenCalledTimes(1);

    active.setVisible(false);
    await postNotification(messageIntent());
    expect(mockDisplay).toHaveBeenCalledTimes(2);
  });

  it('rechecks visibility when the chat becomes active during native channel lookup', async () => {
    let releaseChannel!: () => void;
    mockGetChannel.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseChannel = () => resolve(null);
        }),
    );
    const pending = postNotification(messageIntent());
    for (let i = 0; i < 20 && mockGetChannel.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    const active = claimActiveChat('chat-1');
    active.setVisible(true);
    releaseChannel();
    await pending;

    expect(mockDisplay).not.toHaveBeenCalled();
  });
});

describe('postNotification — failed send', () => {
  const failureIntent: Extract<NotificationIntent, { kind: 'send-failure' }> = {
    kind: 'send-failure',
    chatGuid: 'chat-1',
    messageGuid: 'msg-1',
  };

  it('uses fixed generic copy, an opaque stable id, and no inline actions', async () => {
    await postNotification(failureIntent);

    const n = lastNotif();
    expect(n).toEqual(
      expect.objectContaining({
        id: 'gator-send-failure-101',
        title: 'Message status needs review',
        body: 'Open Gator to review.',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'send-failure',
          chatId: '1',
          messageId: '101',
        },
      }),
    );
    expect(n.android).toEqual(
      expect.objectContaining({
        channelId: CHANNEL_NEW_MESSAGE,
        onlyAlertOnce: true,
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      }),
    );
    expect(n.android).not.toHaveProperty('actions');
    expect(n.android).not.toHaveProperty('style');
    expect(JSON.stringify(n)).not.toMatch(/chat-1|msg-1|server detail|recipient|secret plans/);
  });

  it('suppresses the exact visible chat but posts after it is no longer visible', async () => {
    const active = claimActiveChat('chat-1');
    active.setVisible(true);

    await postNotification(failureIntent);
    expect(mockDisplay).not.toHaveBeenCalled();

    active.setVisible(false);
    await postNotification(failureIntent);
    expect(lastNotif().id).toBe('gator-send-failure-101');
  });

  it('cancels the exact stable failed-send notice after success', async () => {
    mockLocalFailedMessageRoute.mockResolvedValueOnce(null);
    await postNotification({
      kind: 'send-failure-cancel',
      chatGuid: 'chat-1',
      messageGuid: 'msg-1',
    });

    expect(mockCancel).toHaveBeenCalledWith('gator-send-failure-101');
    expect(mockDisplay).not.toHaveBeenCalled();
  });

  it('does not cancel when a late acknowledgement leaves the DB failure sticky', async () => {
    await postNotification({
      kind: 'send-failure-cancel',
      chatGuid: 'chat-1',
      messageGuid: 'msg-1',
    });

    expect(mockLocalFailedMessageRoute).toHaveBeenCalledWith('msg-1', undefined);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('postNotification — cancel / facetime-cancel', () => {
  it('kind:cancel clears the chat notification by guid', async () => {
    await postNotification({ kind: 'cancel', chatGuid: 'chat-9' });
    expect(mockCancel).toHaveBeenCalledWith('gator-message-99');
    expect(mockCancel).toHaveBeenCalledWith('chat-9');
    expect(mockDisplay).not.toHaveBeenCalled();
  });

  it('kind:facetime-cancel clears the ringing notification (ft-<uuid>)', async () => {
    await postNotification({ kind: 'facetime-cancel', uuid: 'u1' });
    expect(mockCancel).toHaveBeenCalledWith('gator-facetime-7f000000-0000-4000-8000-000000000001');
    expect(mockDeleteFaceTimeRoute).toHaveBeenCalledWith(
      '7f000000-0000-4000-8000-000000000001',
      undefined,
    );
    expect(mockCancel).toHaveBeenCalledWith('ft-u1'); // legacy cleanup only
    expect(mockDisplay).not.toHaveBeenCalled();
  });
});

describe('postNotification — alias-removed', () => {
  it('names the single deregistered alias exactly', async () => {
    await postNotification({ kind: 'alias-removed', aliases: ['me@icloud.com'] });
    const n = lastNotif();
    expect(n.id).toBe('bb-aliases-removed');
    expect(n.title).toBe('iMessage');
    expect(n.body).toBe('me@icloud.com has been deregistered.');
  });

  it('lists multiple aliases exactly', async () => {
    await postNotification({
      kind: 'alias-removed',
      aliases: ['me@icloud.com', '+15551234567'],
    });
    expect(lastNotif().body).toBe('Aliases deregistered: me@icloud.com, +15551234567');
  });
});

describe('postNotification — rcs-bridge-down (generic local status)', () => {
  it('does not trust server-supplied title/body as OS presentation', async () => {
    await postNotification({
      kind: 'rcs-bridge-down',
      title: 'RCS bridge down',
      body: 'Re-authenticate on the server.',
    });
    const n = lastNotif();
    expect(n.id).toBe('bb-rcs-bridge-down');
    expect(n.title).toBe('Gator');
    expect(n.body).toBe('RCS service needs attention.');
  });
});

describe('postLockedNotification', () => {
  it('posts a single content-less "you have messages" notification (no sender/content)', async () => {
    await postLockedNotification();
    const n = lastNotif();
    expect(n.id).toBe('bb-locked-messages');
    expect(n.title).toBe('Gator');
    expect(n.body).toBe('You have new messages');
    expect(n.data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'locked',
    });
    expect(n.android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
    expect(n.android?.onlyAlertOnce).toBe(true);
  });

  it('drops a locked-status post whose FCM account lease was revoked in the queue', async () => {
    const displaysBefore = mockDisplay.mock.calls.length;
    await postLockedNotification({ generation: 3, isCurrent: () => false });
    expect(mockDisplay).toHaveBeenCalledTimes(displaysBefore);
  });
});

describe('scheduleReminderNotification', () => {
  const args = {
    notificationId: 'gator-reminder-message-101-5000',
    chatGuid: 'c1',
    messageGuid: 'm1',
    scheduledFor: 5000,
  };

  it('creates an inexact trigger with generic native presentation', async () => {
    await scheduleReminderNotification(args);
    const [payload, trigger] = mockCreateTrigger.mock.calls.at(-1)!;
    expect(payload.id).toBe('gator-reminder-message-101-5000');
    expect(payload.title).toBe('Reminder');
    expect(payload.body).toBe('Reminder');
    expect(payload.data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'reminder',
      chatId: '1',
      messageId: '101',
    });
    expect(payload.android.channelId).toBe(CHANNEL_REMINDERS);
    expect(payload.android.onlyAlertOnce).toBe(true);
    expect(payload.android.pressAction).toEqual({ id: PRESS_REMINDER, launchActivity: 'default' });
    expect(trigger.type).toBe(0); // TriggerType.TIMESTAMP
    expect(trigger.timestamp).toBe(5000);
    expect(trigger.alarmManager).toEqual({ type: ALARM_IDLE }); // SET_AND_ALLOW_WHILE_IDLE — no exact-alarm perm
    expect(JSON.stringify(payload)).not.toMatch(/Alice|call the dentist/);
  });

  it('carries the message date (stringified) in data so a tap deep-links with ?focusDate', async () => {
    await scheduleReminderNotification({ ...args, messageDate: 1700000000000 });
    expect(mockCreateTrigger.mock.calls.at(-1)![0].data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'reminder',
      chatId: '1',
      messageId: '101',
      messageDate: '1700000000000',
    });
  });

  it('rejects a raw legacy notification id before channel, route, or native trigger work', async () => {
    const unsafeId = 'reminder-iMessage;-;+15551234567-PRIVATE_MESSAGE_GUID_CANARY';
    let rejection: unknown;

    try {
      await scheduleReminderNotification({ ...args, notificationId: unsafeId });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(expect.any(Error));
    expect((rejection as Error).message).toBe(
      'refusing to persist a reminder notification with a legacy identifier',
    );
    expect((rejection as Error).message).not.toContain(unsafeId);
    expect(mockCreateChannel).not.toHaveBeenCalled();
    expect(mockLocalRouteForGuids).not.toHaveBeenCalled();
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  it('rethrows when createTriggerNotification fails (surfaces the scheduling error)', async () => {
    const failure = new Error('trigger.timestamp must be in the future');
    mockCreateTrigger.mockRejectedValueOnce(failure);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(scheduleReminderNotification(args)).rejects.toThrow('must be in the future');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[reminder] createTriggerNotification failed', failure);
  });
});

describe('prepareNotificationPresentationState — startup maintenance', () => {
  const privateMessage = () => ({
    id: 'chat-existing',
    notification: {
      id: 'chat-existing',
      title: 'Alice',
      subtitle: 'ALICE_SUBTITLE_SECRET',
      body: 'secret plans',
      data: {
        chatGuid: 'opaque-chat-guid',
        messageGuid: 'opaque-message-guid',
        messageDate: '1700000000000',
        privatePreview: 'PRIVATE_DATA_SECRET',
      },
      android: {
        channelId: `${CHANNEL_NEW_MESSAGE}.chat.Alice`,
        smallIcon: 'ic_stat_gator',
        largeIcon: 'AVATAR_SECRET',
        ticker: 'TICKER_SECRET',
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
        style: {
          type: 3,
          person: { name: 'You', id: 'self' },
          group: true,
          messages: [
            {
              text: 'secret plans',
              timestamp: 1700000000000,
              person: { name: 'Alice', id: 'alice@example.com', icon: 'AVATAR_SECRET' },
            },
          ],
        },
        actions: [
          {
            title: 'Reply to Alice',
            pressAction: { id: ACTION_REPLY },
            input: { allowFreeFormInput: true, placeholder: 'Message Alice' },
          },
        ],
      },
    },
  });

  const privateReminder = () => ({
    notification: {
      id: 'reminder-old-5000',
      title: 'Alice',
      body: 'call the dentist',
      data: {
        chatGuid: 'opaque-reminder-chat',
        messageGuid: 'opaque-reminder-message',
        messageDate: '1690000000000',
        reminder: '1',
        privatePreview: 'REMINDER_DATA_SECRET',
      },
      android: {
        channelId: CHANNEL_REMINDERS,
        smallIcon: 'ic_stat_gator',
        ticker: 'REMINDER_TICKER_SECRET',
        pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
      },
    },
    trigger: {
      type: 0,
      timestamp: 5000,
      alarmManager: { type: ALARM_IDLE },
    },
  });

  describe('ordinary startup maintenance', () => {
    it('rewrites a current displayed reminder generically after sanitizing triggers', async () => {
      const current = {
        id: 'gator-reminder-message-111-5000',
        title: 'PRIVATE_CURRENT_TITLE',
        body: 'PRIVATE_CURRENT_PREVIEW',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'reminder',
          chatId: '11',
          messageId: '111',
          messageDate: '1690000000000',
        },
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_stat_gator',
          pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
        },
      };
      const state = installStatefulTray([current]);

      try {
        await prepareNotificationPresentationState();

        const rewritten = state.tray.get(current.id)!;
        expect(rewritten).toEqual(
          expect.objectContaining({ id: current.id, title: 'Reminder', body: 'Reminder' }),
        );
        expect(rewritten.android.onlyAlertOnce).toBe(true);
        expect(JSON.stringify(rewritten)).not.toMatch(/PRIVATE_CURRENT/);
        expect(mockCancelTriggersAll.mock.invocationCallOrder[0]).toBeLessThan(
          mockDisplay.mock.invocationCallOrder[0]!,
        );
      } finally {
        state.restore();
      }
    });

    it('leaves current detailed payloads and safe channel names untouched', async () => {
      const current = displayedMessageChild(10, 110);
      current.title = 'Alice Current Detail';
      current.body = 'CURRENT_DETAILED_BODY';
      current.android.style.messages[0].text = 'CURRENT_DETAILED_BODY';
      const state = installStatefulTray([current]);
      const safeChannel = `${CHANNEL_NEW_MESSAGE}.chat.route_10`;
      mockGetTriggers.mockResolvedValueOnce([]);
      mockGetChannels.mockResolvedValueOnce([
        { id: safeChannel, name: 'Alice Current Detail', importance: 4 },
      ]);

      try {
        await prepareNotificationPresentationState();

        expect(state.tray.get(current.id)).toBe(current);
        expect(mockDisplay).not.toHaveBeenCalled();
        expect(mockCancelDisplayedAll).not.toHaveBeenCalled();
        expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
        expect(mockDeleteChannel).toHaveBeenCalledWith(LEGACY_FACETIME_CHANNEL_ID);
        expect(mockClearNotificationRoutes).toHaveBeenCalledWith(expect.any(Function));
        expect(mockCreateChannel).not.toHaveBeenCalled();
      } finally {
        state.restore();
      }
    });

    it('removes stale message plaintext at startup without waiting for network sync', async () => {
      const stale = displayedMessageChild(1, 101);
      stale.body = 'RETRACTED_STARTUP_PLAINTEXT';
      stale.android.style.messages[0].text = 'RETRACTED_STARTUP_PLAINTEXT';
      const state = installStatefulTray([stale]);
      mockListMessageNotificationTruth.mockResolvedValueOnce([
        messageTruth(101, 1, {
          notificationEligible: 0,
          retractionState: 'fully-retracted',
          dateRetracted: 1700000001000,
        }),
      ]);

      try {
        await prepareNotificationPresentationState();

        expect(state.tray.has(stale.id)).toBe(false);
        expect(mockCancel).toHaveBeenCalledWith(stale.id);
        expect(mockCancelTriggersAll.mock.invocationCallOrder[0]).toBeLessThan(
          mockCancel.mock.invocationCallOrder[0]!,
        );
      } finally {
        state.restore();
      }
    });

    it('captures admission before queueing so a paused-account call cannot attach to the resumed account', async () => {
      await pauseRealtimeDeliveries();

      const staleMaintenance = prepareNotificationPresentationState();
      resumeRealtimeDeliveries();
      await staleMaintenance;

      expect(mockGetDisplayed).not.toHaveBeenCalled();
      expect(mockGetTriggers).not.toHaveBeenCalled();
      expect(mockGetChannels).not.toHaveBeenCalled();
      expect(mockListFutureReminderTriggerRoutes).not.toHaveBeenCalled();
      expect(mockClearNotificationRoutes).not.toHaveBeenCalled();
      expect(mockDeleteChannel).not.toHaveBeenCalled();

      mockGetDisplayed.mockResolvedValueOnce([]);
      mockGetTriggers.mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([
        {
          oldId: 'fresh-account-old-reminder',
          newId: 'gator-reminder-message-111-7100',
          scheduledFor: 7100,
          route: { chatId: 11, messageId: 111 },
          messageDate: 1690000000000,
        },
      ]);
      mockGetChannels.mockResolvedValueOnce([]);

      await prepareNotificationPresentationState();

      expect(mockGetDisplayed).toHaveBeenCalledTimes(4);
      expect(mockGetTriggers).toHaveBeenCalledTimes(2);
      expect(mockGetChannels).toHaveBeenCalledTimes(1);
      expect(mockClearNotificationRoutes).toHaveBeenCalledWith(expect.any(Function));
      expect(mockDeleteChannel).toHaveBeenCalledWith(LEGACY_FACETIME_CHANNEL_ID);
      expect(mockCreateTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'gator-reminder-message-111-7100' }),
        expect.objectContaining({ timestamp: 7100 }),
      );
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
        'fresh-account-old-reminder',
        'gator-reminder-message-111-7100',
        expect.any(Function),
      );
    });

    it('serializes a detailed post behind the complete maintenance pass', async () => {
      let releaseDisplayed!: (value: unknown[]) => void;
      mockGetDisplayed.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDisplayed = resolve;
          }),
      );
      mockGetTriggers.mockResolvedValueOnce([]);

      const maintenance = prepareNotificationPresentationState();
      for (let i = 0; i < 20 && releaseDisplayed == null; i += 1) await Promise.resolve();
      const post = postNotification(
        messageIntent({ chatGuid: 'queue-recovered', body: 'CURRENT_ACCOUNT_DETAIL' }),
      );
      await Promise.resolve();

      expect(mockDisplay).not.toHaveBeenCalled();
      releaseDisplayed([]);
      await Promise.all([maintenance, post]);

      expect(lastNotif()).toEqual(
        expect.objectContaining({ id: 'gator-message-15', body: 'CURRENT_ACCOUNT_DETAIL' }),
      );
      expect(mockGetChannels.mock.invocationCallOrder[0]).toBeLessThan(
        mockDisplay.mock.invocationCallOrder[0]!,
      );
    });

    it('drains an admitted repair before queued account cleanup and disowns its stale result', async () => {
      let releaseDurableRows!: (value: unknown[]) => void;
      let pauseFinished = false;
      const accountAChannel = `${CHANNEL_NEW_MESSAGE}.chat.route_10`;
      mockGetDisplayed.mockResolvedValueOnce([]);
      mockGetTriggers.mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDurableRows = resolve;
          }),
      );
      mockGetChannels.mockResolvedValueOnce([
        { id: accountAChannel, name: 'ACCOUNT_A_CHANNEL_NAME', importance: 4 },
      ]);

      const maintenanceA = prepareNotificationPresentationState();
      for (let i = 0; i < 20 && releaseDurableRows == null; i += 1) await Promise.resolve();
      expect(releaseDurableRows).toEqual(expect.any(Function));

      const pause = pauseRealtimeDeliveries().then(() => {
        pauseFinished = true;
      });
      const teardown = cancelAllNotifications();
      await Promise.resolve();
      expect(pauseFinished).toBe(false);
      expect(mockCancelAll).not.toHaveBeenCalled();

      releaseDurableRows([
        {
          oldId: 'account-a-old-reminder',
          newId: 'gator-reminder-message-111-5000',
          scheduledFor: 5000,
          route: { chatId: 11, messageId: 111 },
          messageDate: 1690000000000,
        },
      ]);
      await Promise.all([maintenanceA, pause, teardown]);

      expect(mockCreateTrigger).not.toHaveBeenCalled();
      expect(mockMigrateReminderNotificationId).not.toHaveBeenCalled();
      expect(mockCancelAll).toHaveBeenCalledTimes(1);
      expect(mockCreateChannel).toHaveBeenCalledWith({
        id: accountAChannel,
        name: 'Conversation',
        importance: 4,
      });
      expect(mockListFutureReminderTriggerRoutes.mock.invocationCallOrder[0]).toBeLessThan(
        mockCancelAll.mock.invocationCallOrder[0]!,
      );
      expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateChannel.mock.invocationCallOrder[0]!,
      );

      resumeRealtimeDeliveries();
      mockGetDisplayed.mockResolvedValueOnce([]);
      mockGetTriggers.mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([
        {
          oldId: 'account-b-old-reminder',
          newId: 'gator-reminder-message-111-6000',
          scheduledFor: 6000,
          route: { chatId: 11, messageId: 111 },
          messageDate: 1690000000000,
        },
      ]);
      mockGetChannels.mockResolvedValueOnce([]);

      await prepareNotificationPresentationState();

      expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
      expect(mockCreateTrigger.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ id: 'gator-reminder-message-111-6000' }),
      );
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
        'account-b-old-reminder',
        'gator-reminder-message-111-6000',
        expect.any(Function),
      );
    });

    it('passes the admitted account guard through a reminder handoff and retires a refused native alarm', async () => {
      const durable = {
        oldId: 'account-a-old-reminder',
        newId: 'gator-reminder-message-111-7200',
        scheduledFor: 7200,
        route: { chatId: 11, messageId: 111 },
        messageDate: 1690000000000,
      };
      let capturedGuard: (() => boolean) | undefined;
      let releaseMigration!: () => void;
      mockGetDisplayed.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes
        .mockResolvedValueOnce([durable])
        .mockResolvedValueOnce([durable]);
      mockGetChannels.mockResolvedValueOnce([]);
      mockMigrateReminderNotificationId.mockImplementationOnce(
        async (_oldId: string, _newId: string, commitGuard?: () => boolean) => {
          capturedGuard = commitGuard;
          await new Promise<void>((resolve) => {
            releaseMigration = resolve;
          });
          return commitGuard?.() !== false;
        },
      );

      const maintenanceA = prepareNotificationPresentationState();
      for (let i = 0; i < 20 && capturedGuard == null; i += 1) await Promise.resolve();

      expect(capturedGuard).toEqual(expect.any(Function));
      expect(capturedGuard?.()).toBe(true);
      const pause = pauseRealtimeDeliveries();
      expect(capturedGuard?.()).toBe(false);

      releaseMigration();
      await expect(Promise.all([maintenanceA, pause])).resolves.toEqual([undefined, undefined]);

      expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
      expect(mockCancelTrigger).toHaveBeenCalledWith(durable.newId);
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
        durable.oldId,
        durable.newId,
        capturedGuard,
      );

      resumeRealtimeDeliveries();
      await prepareNotificationPresentationState();

      expect(mockCreateTrigger).toHaveBeenCalledTimes(2);
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledTimes(2);
      expect(mockMigrateReminderNotificationId.mock.calls[1]).toEqual([
        durable.oldId,
        durable.newId,
        expect.any(Function),
      ]);
    });

    it('passes the original account guard through displayed-reminder migration and allows a fresh repair', async () => {
      const legacy = privateReminder();
      const displayed = { id: legacy.notification.id, notification: legacy.notification };
      let capturedGuard: (() => boolean) | undefined;
      let releaseMigration!: () => void;
      mockGetDisplayed
        .mockResolvedValueOnce([displayed])
        .mockResolvedValueOnce([displayed])
        .mockResolvedValueOnce([displayed])
        .mockResolvedValueOnce([displayed]);
      mockGetTriggers
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockGetChannels.mockResolvedValueOnce([]);
      mockMigrateReminderNotificationId.mockImplementationOnce(
        async (_oldId: string, _newId: string, commitGuard?: () => boolean) => {
          capturedGuard = commitGuard;
          await new Promise<void>((resolve) => {
            releaseMigration = resolve;
          });
          return commitGuard?.() !== false;
        },
      );

      const maintenanceA = prepareNotificationPresentationState();
      for (let i = 0; i < 20 && capturedGuard == null; i += 1) await Promise.resolve();

      expect(capturedGuard).toEqual(expect.any(Function));
      expect(capturedGuard?.()).toBe(true);
      const pause = pauseRealtimeDeliveries();
      expect(capturedGuard?.()).toBe(false);
      releaseMigration();
      await expect(Promise.all([maintenanceA, pause])).resolves.toEqual([undefined, undefined]);

      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancelDisplayedAll).not.toHaveBeenCalled();
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
        legacy.notification.id,
        'gator-reminder-message-111-5000',
        capturedGuard,
      );

      resumeRealtimeDeliveries();
      await prepareNotificationPresentationState();

      expect(lastNotif()).toEqual(
        expect.objectContaining({
          id: 'gator-reminder-message-111-5000',
          title: 'Reminder',
          body: 'Reminder',
        }),
      );
      expect(mockMigrateReminderNotificationId.mock.calls[1]).toEqual([
        legacy.notification.id,
        'gator-reminder-message-111-5000',
        expect.any(Function),
      ]);
    });

    it('removes a schema-2 FaceTime notice, route rows, and persistent channel on upgrade', async () => {
      const retiredFaceTime = {
        id: 'gator-facetime-7f000000-0000-4000-8000-000000000001',
        notification: {
          id: 'gator-facetime-7f000000-0000-4000-8000-000000000001',
          title: 'Incoming FaceTime',
          body: 'ACCOUNT_A_CALLER_NAME',
          data: {
            gatorOwner: 'gator',
            gatorSchema: '2',
            gatorKind: 'facetime',
            routeToken: '7f000000-0000-4000-8000-000000000001',
          },
          android: {
            channelId: LEGACY_FACETIME_CHANNEL_ID,
            ongoing: true,
            actions: [
              { title: 'Decline', pressAction: { id: 'decline-facetime' } },
              { title: 'Answer', pressAction: { id: 'answer-facetime' } },
            ],
          },
        },
      };
      mockGetDisplayed
        .mockResolvedValueOnce([retiredFaceTime])
        .mockResolvedValueOnce([retiredFaceTime]);
      mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([]);

      await prepareNotificationPresentationState();

      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
      expect(mockClearNotificationRoutes).toHaveBeenCalledWith(expect.any(Function));
      expect(mockDeleteChannel).toHaveBeenCalledWith(LEGACY_FACETIME_CHANNEL_ID);
      expect(mockDeleteFaceTimeRoute).not.toHaveBeenCalled();
    });

    it('reports a failed legacy FaceTime channel deletion after completing other maintenance', async () => {
      mockDeleteChannel.mockRejectedValueOnce(new Error('legacy FaceTime channel delete failed'));

      await expect(prepareNotificationPresentationState()).rejects.toThrow(
        'notification presentation maintenance completed with failures',
      );

      expect(mockDeleteChannel).toHaveBeenCalledWith(LEGACY_FACETIME_CHANNEL_ID);
      expect(mockClearNotificationRoutes).toHaveBeenCalledWith(expect.any(Function));
      expect(mockGetChannels).toHaveBeenCalledTimes(1);
    });

    it('retains FaceTime routes when Android cannot contain the stale displayed notice', async () => {
      const retainedFaceTime = {
        id: 'gator-facetime-7f000000-0000-4000-8000-000000000002',
        notification: {
          id: 'gator-facetime-7f000000-0000-4000-8000-000000000002',
          data: {
            gatorOwner: 'gator',
            gatorSchema: '2',
            gatorKind: 'facetime',
            routeToken: '7f000000-0000-4000-8000-000000000002',
          },
        },
      };
      mockGetDisplayed
        .mockResolvedValueOnce([retainedFaceTime])
        .mockResolvedValueOnce([retainedFaceTime]);
      mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockCancelDisplayedAll.mockRejectedValueOnce(new Error('displayed cancellation failed'));

      await expect(prepareNotificationPresentationState()).rejects.toThrow(
        'notification presentation maintenance completed with failures',
      );

      expect(mockClearNotificationRoutes).not.toHaveBeenCalled();
      expect(mockDeleteChannel).toHaveBeenCalledWith(LEGACY_FACETIME_CHANNEL_ID);
      expect(mockDeleteFaceTimeRoute).not.toHaveBeenCalled();
    });

    it('finishes missing-reminder repair before aggregating an independent channel failure', async () => {
      mockGetDisplayed.mockResolvedValueOnce([]);
      mockGetTriggers.mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([
        {
          oldId: 'missing-native-reminder',
          newId: 'gator-reminder-message-111-7000',
          scheduledFor: 7000,
          route: { chatId: 11, messageId: 111 },
          messageDate: 1690000000000,
        },
      ]);
      mockGetChannels.mockRejectedValueOnce(new Error('channel enumeration failed'));

      await expect(prepareNotificationPresentationState()).rejects.toThrow(
        'notification presentation maintenance completed with failures',
      );

      expect(mockCreateTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'gator-reminder-message-111-7000' }),
        expect.objectContaining({ timestamp: 7000 }),
      );
      expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
        'missing-native-reminder',
        'gator-reminder-message-111-7000',
        expect.any(Function),
      );
    });
  });

  it('migrates legacy displayed/scheduled payloads to opaque generic routes with intact actions', async () => {
    const displayed = [
      privateMessage(),
      {
        id: 'ft-u-private',
        notification: {
          id: 'ft-u-private',
          title: 'Incoming FaceTime',
          body: 'Bob Jones',
          subtitle: 'CALLER_SUBTITLE_SECRET',
          data: { faceTimeUuid: 'opaque-call-uuid', caller: 'Bob Jones' },
          android: { largeIcon: 'CALLER_AVATAR_SECRET', ticker: 'Bob Jones is calling' },
        },
      },
      {
        id: 'bb-aliases-removed',
        notification: {
          id: 'bb-aliases-removed',
          title: 'iMessage',
          body: 'me@icloud.com has been deregistered.',
        },
      },
      {
        id: 'reminder-fired-6000',
        notification: {
          ...privateReminder().notification,
          id: 'reminder-fired-6000',
          title: 'Bob',
          body: 'another private reminder',
        },
      },
      {
        id: 'bb-locked-messages',
        notification: {
          id: 'bb-locked-messages',
          title: 'Gator',
          body: 'You have new messages',
        },
      },
      {
        id: 'bb-rcs-bridge-down',
        notification: {
          id: 'bb-rcs-bridge-down',
          title: 'RCS bridge down',
          body: 'Re-authenticate on the server.',
        },
      },
      {
        id: 'bb-test-notification',
        notification: {
          id: 'bb-test-notification',
          title: 'Gator',
          body: 'Test push passed',
        },
      },
    ];
    mockGetDisplayed.mockResolvedValueOnce(displayed).mockResolvedValueOnce(displayed);
    const scheduled = privateReminder();
    mockGetTriggers.mockResolvedValueOnce([scheduled]).mockResolvedValueOnce([scheduled]);

    await prepareNotificationPresentationState();

    const reposted = mockDisplay.mock.calls.map((call) => call[0]);
    const message = reposted.find((notification) => notification.id === 'gator-message-10');
    expect(message).toEqual(
      expect.objectContaining({
        title: 'Contact',
        body: 'New message',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'message',
          chatId: '10',
          messageId: '110',
          messageDate: '1700000000000',
          messageHistoryIds: '110',
        },
      }),
    );
    expect(message.android.channelId).toBe(CHANNEL_NEW_MESSAGE);
    expect(message.android.style).toEqual(
      expect.objectContaining({
        person: { name: 'You', id: 'self' },
        group: true,
        messages: [
          expect.objectContaining({
            text: 'New message',
            person: { name: 'Contact', id: 'contact' },
          }),
        ],
      }),
    );
    expect(message.android.actions.map((action: any) => action.pressAction.id)).toEqual([
      ACTION_REPLY,
      ACTION_MARK_READ,
    ]);
    // These cover every place Android can visibly/accessibly announce the old identity/content,
    // plus arbitrary extra data. Only the opaque action/deep-link ids above survive.
    const serializedMessage = JSON.stringify(message);
    for (const privateString of [
      'Alice',
      'alice@example.com',
      'secret plans',
      'AVATAR_SECRET',
      'TICKER_SECRET',
      'PRIVATE_DATA_SECRET',
      'ALICE_SUBTITLE_SECRET',
      'Message Alice',
    ]) {
      expect(serializedMessage).not.toContain(privateString);
    }

    expect(reposted.some((notification) => notification.id.startsWith('gator-facetime-'))).toBe(
      false,
    );
    expect(JSON.stringify(reposted)).not.toMatch(
      /Bob Jones|CALLER_SUBTITLE_SECRET|CALLER_AVATAR_SECRET/,
    );

    expect(reposted.find((notification) => notification.id === 'bb-aliases-removed')).toEqual(
      expect.objectContaining({ title: 'iMessage', body: 'An iMessage alias was deregistered.' }),
    );
    expect(
      reposted.find((notification) => notification.id === 'gator-reminder-message-111-6000'),
    ).toEqual(expect.objectContaining({ title: 'Reminder', body: 'Reminder' }));
    // Content-less/system self-test notices are preserved, not silently removed by the scrub.
    expect(reposted.find((notification) => notification.id === 'bb-locked-messages')).toEqual(
      expect.objectContaining({ title: 'Gator', body: 'You have new messages' }),
    );
    expect(reposted.find((notification) => notification.id === 'bb-rcs-bridge-down')).toEqual(
      expect.objectContaining({ title: 'Gator', body: 'RCS service needs attention.' }),
    );
    expect(reposted.find((notification) => notification.id === 'bb-test-notification')).toEqual(
      expect.objectContaining({ title: 'Gator', body: 'Test notification received.' }),
    );

    const [scheduledPayload, scheduledTrigger] = mockCreateTrigger.mock.calls.at(-1)!;
    expect(scheduledPayload).toEqual(
      expect.objectContaining({
        id: 'gator-reminder-message-111-5000',
        title: 'Reminder',
        body: 'Reminder',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'reminder',
          chatId: '11',
          messageId: '111',
          messageDate: '1690000000000',
        },
      }),
    );
    expect(scheduledPayload.android.pressAction).toEqual({
      id: PRESS_REMINDER,
      launchActivity: 'default',
    });
    expect(scheduledTrigger).toEqual(scheduled.trigger);
    expect(JSON.stringify(scheduledPayload)).not.toMatch(
      /Alice|call the dentist|REMINDER_DATA_SECRET|REMINDER_TICKER_SECRET/,
    );
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
  });

  it('unconditionally migrates legacy raw native routes and channel ids at startup', async () => {
    const legacy = privateMessage();
    const legacyChannel = `${CHANNEL_NEW_MESSAGE}.chat.iMessage____15551234567`;
    const safeChannel = `${CHANNEL_NEW_MESSAGE}.chat.route_7`;
    // First pair = migration detection; second pair = the store-wide whitelist rebuild.
    mockGetDisplayed.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([legacy]);
    mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetChannels.mockResolvedValueOnce([
      { id: legacyChannel, name: 'Alice', importance: 4 },
      { id: safeChannel, name: 'Bob Current Detail', importance: 3 },
    ]);

    await prepareNotificationPresentationState();

    const replacement = lastNotif();
    expect(replacement).toEqual(
      expect.objectContaining({
        id: 'gator-message-10',
        title: 'Contact',
        body: 'New message',
        data: expect.objectContaining({
          gatorOwner: 'gator',
          gatorSchema: '2',
          chatId: '10',
          messageId: '110',
        }),
      }),
    );
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replacement)).not.toMatch(
      /opaque-chat-guid|opaque-message-guid|Alice|secret plans/,
    );
    expect(mockDeleteChannel).toHaveBeenCalledWith(legacyChannel);
    expect(mockCreateChannel).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: safeChannel }),
    );
  });

  it('contains both native stores when startup displayed inspection fails', async () => {
    const legacyChannel = `${CHANNEL_NEW_MESSAGE}.chat.iMessage____15550001111`;
    mockGetDisplayed.mockRejectedValueOnce(new Error('tray query failed'));
    mockGetTriggers.mockResolvedValueOnce([]);
    mockGetChannels.mockResolvedValueOnce([
      { id: legacyChannel, name: 'Legacy private channel', importance: 4 },
    ]);

    await expect(prepareNotificationPresentationState()).rejects.toThrow(
      'notification presentation maintenance completed with failures',
    );

    expect(mockGetDisplayed).toHaveBeenCalledTimes(4);
    expect(mockGetTriggers).toHaveBeenCalledTimes(1);
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
    expect(mockCancelTriggersAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelDisplayedAll.mock.invocationCallOrder[0]!,
    );
    expect(mockDeleteChannel).toHaveBeenCalledWith(legacyChannel);
  });

  it('contains both native stores when startup trigger inspection fails', async () => {
    mockGetDisplayed.mockResolvedValueOnce([]);
    mockGetTriggers.mockRejectedValueOnce(new Error('trigger query failed'));

    await expect(prepareNotificationPresentationState()).rejects.toThrow(
      'notification presentation maintenance completed with failures',
    );

    expect(mockGetDisplayed).toHaveBeenCalledTimes(4);
    expect(mockGetTriggers).toHaveBeenCalledTimes(1);
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
  });

  it.each(['displayed', 'trigger'] as const)(
    'contains both native stores when legacy-positive second %s enumeration fails',
    async (failingStore) => {
      const legacy = privateMessage();
      if (failingStore === 'displayed') {
        mockGetDisplayed
          .mockResolvedValueOnce([legacy])
          .mockRejectedValueOnce(new Error('second displayed enumeration failed'));
        mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      } else {
        mockGetDisplayed.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([legacy]);
        mockGetTriggers
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error('second trigger enumeration failed'));
      }
      mockGetChannels.mockResolvedValueOnce([]);

      await expect(prepareNotificationPresentationState()).rejects.toThrow(
        'notification presentation maintenance completed with failures',
      );

      expect(mockGetDisplayed).toHaveBeenCalledTimes(5);
      expect(mockGetTriggers).toHaveBeenCalledTimes(2);
      expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
      expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
      expect(mockGetChannels).toHaveBeenCalledTimes(1);
    },
  );

  it('drops a queued realtime post when Disconnect revokes its account before native mutation', async () => {
    let releaseDisplayed!: (value: unknown[]) => void;
    mockGetDisplayed.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDisplayed = resolve;
        }),
    );
    mockGetTriggers.mockResolvedValueOnce([]);
    let current = true;
    const context: EventDeliveryContext = { generation: 4, isCurrent: () => current };

    const maintenance = prepareNotificationPresentationState();
    for (let i = 0; i < 10 && releaseDisplayed == null; i += 1) await Promise.resolve();
    const stalePost = postNotification(
      messageIntent({ chatGuid: 'after-enable', body: 'old account body' }),
      context,
    );
    current = false;

    releaseDisplayed([]);
    await Promise.all([maintenance, stalePost]);
    expect(mockDisplay).not.toHaveBeenCalled();
  });

  it('rechecks the account after a deferred channel lookup before displaying content', async () => {
    let releaseChannelLookup!: (value: null) => void;
    mockGetChannel.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseChannelLookup = resolve;
        }),
    );
    let current = true;
    const context: EventDeliveryContext = { generation: 8, isCurrent: () => current };
    const displaysBefore = mockDisplay.mock.calls.length;

    const stalePost = postNotification(
      messageIntent({ chatGuid: 'after-enable', body: 'account A private body' }),
      context,
    );
    for (let i = 0; i < 20 && releaseChannelLookup == null; i += 1) await Promise.resolve();
    expect(mockGetChannel).toHaveBeenCalled();

    current = false;
    releaseChannelLookup(null);
    await stalePost;

    expect(mockDisplay).toHaveBeenCalledTimes(displaysBefore);
  });

  it('serializes per-chat channel creation behind startup maintenance', async () => {
    let releaseChannels!: (value: unknown[]) => void;
    mockGetChannels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseChannels = resolve;
        }),
    );
    mockGetTriggers.mockResolvedValueOnce([]);
    mockGetDisplayed.mockResolvedValueOnce([]);

    const maintenance = prepareNotificationPresentationState();
    for (let i = 0; i < 100 && releaseChannels == null; i += 1) await Promise.resolve();
    const open = openChatNotificationSettings('chat-created-during-transition', 'Alice');
    await Promise.resolve();

    expect(mockOpenSettings).not.toHaveBeenCalled();
    releaseChannels([]);
    await Promise.all([maintenance, open]);

    const id = chatChannelId(99);
    expect(mockCreateChannel).toHaveBeenCalledWith(expect.objectContaining({ id, name: 'Alice' }));
    expect(mockOpenSettings).toHaveBeenCalledWith(id);
  });

  it('deletes legacy GUID-derived channels on standalone startup maintenance too', async () => {
    const legacy = `${CHANNEL_NEW_MESSAGE}.chat.iMessage____15551234567`;
    const deceptiveLegacy = `${CHANNEL_NEW_MESSAGE}.chat.route_alice_example_com`;
    const safe = `${CHANNEL_NEW_MESSAGE}.chat.route_7`;
    mockGetChannels.mockResolvedValueOnce([
      { id: legacy, name: 'Alice', importance: 4 },
      { id: deceptiveLegacy, name: 'Alice', importance: 4 },
      { id: safe, name: 'Bob', importance: 4 },
    ]);

    await prepareNotificationPresentationState();

    expect(mockDeleteChannel).toHaveBeenCalledWith(legacy);
    expect(mockDeleteChannel).toHaveBeenCalledWith(deceptiveLegacy);
    expect(mockCreateChannel).not.toHaveBeenCalled();
    expect(mockGetDisplayed).toHaveBeenCalledTimes(4);
    expect(mockGetTriggers).toHaveBeenCalledTimes(2);
  });

  it('contains enumeration failure, rejects precisely, and leaves the queue usable', async () => {
    mockGetDisplayed.mockRejectedValueOnce(new Error('tray query failed'));
    mockGetTriggers.mockResolvedValueOnce([]);

    await expect(prepareNotificationPresentationState()).rejects.toThrow(
      'notification presentation maintenance completed with failures',
    );
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
    expect(mockGetTriggers).toHaveBeenCalledTimes(1); // one store failing does not skip the other

    await prepareNotificationPresentationState();
    await postNotification(messageIntent({ chatGuid: 'queue-recovered', body: 'visible again' }));
    expect(lastNotif()).toEqual(
      expect.objectContaining({ id: 'gator-message-15', body: 'visible again' }),
    );
  });

  it('leaves the tray contained if a safe displayed replacement fails to post', async () => {
    const displayed = [privateMessage()];
    mockGetDisplayed.mockResolvedValueOnce(displayed).mockResolvedValueOnce(displayed);
    mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDisplay.mockRejectedValueOnce(new Error('repost failed'));

    await expect(prepareNotificationPresentationState()).rejects.toThrow(
      'notification presentation maintenance completed with failures',
    );
    expect(mockCancelDisplayedAll).toHaveBeenCalledTimes(1);
    expect(mockGetTriggers).toHaveBeenCalledTimes(2);
  });

  it('retries only a transiently failed reminder after a partial safe re-arm', async () => {
    const first = privateReminder();
    const second = privateReminder();
    second.notification.id = 'reminder-old-6000';
    second.trigger.timestamp = 6000;
    mockGetDisplayed.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetTriggers.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([first, second]);
    mockCreateTrigger
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient reschedule failure'));

    await expect(prepareNotificationPresentationState()).resolves.toBeUndefined();
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    expect(mockCreateTrigger.mock.calls.map((call) => call[0].id)).toEqual([
      'gator-reminder-message-111-5000',
      'gator-reminder-message-111-6000',
      'gator-reminder-message-111-6000',
    ]);
    expect(mockCancelTrigger).toHaveBeenCalledWith('gator-reminder-message-111-6000');
    for (const [notification] of mockCreateTrigger.mock.calls) {
      expect(notification).toEqual(
        expect.objectContaining({ title: 'Reminder', body: 'Reminder' }),
      );
      expect(JSON.stringify(notification)).not.toMatch(
        /Alice|call the dentist|REMINDER_DATA_SECRET/,
      );
    }
  });

  it('repairs a reminder from its durable row on the next pass after persistent re-arm failure', async () => {
    const scheduled = privateReminder();
    mockGetDisplayed.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetTriggers
      .mockResolvedValueOnce([scheduled])
      .mockResolvedValueOnce([scheduled])
      .mockResolvedValueOnce([]);
    mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        oldId: 'reminder-old-5000',
        newId: 'gator-reminder-message-111-5000',
        scheduledFor: 5000,
        route: { chatId: 11, messageId: 111 },
        messageDate: 1690000000000,
      },
    ]);
    mockCreateTrigger
      .mockRejectedValueOnce(new Error('persistent failure, attempt one'))
      .mockRejectedValueOnce(new Error('persistent failure, attempt two'));

    await expect(prepareNotificationPresentationState()).rejects.toThrow(
      'notification presentation maintenance completed with failures',
    );
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    expect(mockCancelTrigger).toHaveBeenCalledTimes(2);

    mockCreateTrigger.mockClear();
    mockCancelTrigger.mockClear();
    await expect(prepareNotificationPresentationState()).resolves.toBeUndefined();

    expect(mockGetTriggers).toHaveBeenCalledTimes(4);
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(2);
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    const [restored, trigger] = mockCreateTrigger.mock.calls[0]!;
    expect(restored).toEqual(
      expect.objectContaining({
        id: 'gator-reminder-message-111-5000',
        title: 'Reminder',
        body: 'Reminder',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'reminder',
          chatId: '11',
          messageId: '111',
          messageDate: '1690000000000',
        },
      }),
    );
    expect(trigger).toEqual({
      type: 0,
      timestamp: 5000,
      alarmManager: { type: ALARM_IDLE },
    });
    expect(JSON.stringify(restored)).not.toMatch(/Alice|call the dentist|reminder-old/);
  });

  it('on ordinary startup sanitizes existing and missing durable reminders', async () => {
    const legacyShape = privateReminder();
    const existing = {
      notification: {
        ...legacyShape.notification,
        id: 'reminder-old-5000',
        title: 'Alice',
        body: 'full preview stays untouched',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'reminder',
          chatId: '11',
          messageId: '111',
          messageDate: '1690000000000',
        },
      },
      trigger: legacyShape.trigger,
    };
    mockGetDisplayed.mockResolvedValueOnce([]);
    mockGetTriggers.mockResolvedValueOnce([existing]);
    mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([
      {
        oldId: 'reminder-old-5000',
        newId: 'gator-reminder-message-111-5000',
        scheduledFor: 5000,
        route: { chatId: 11, messageId: 111 },
        messageDate: 1690000000000,
      },
      {
        oldId: 'reminder-old-6000',
        newId: 'gator-reminder-message-111-6000',
        scheduledFor: 6000,
        route: { chatId: 11, messageId: 111 },
        messageDate: 1690000000000,
      },
    ]);

    await expect(prepareNotificationPresentationState()).resolves.toBeUndefined();

    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
    expect(mockCancelTrigger).not.toHaveBeenCalled();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(2);
    expect(mockCreateTrigger.mock.calls.map((call) => call[0].id)).toEqual([
      'gator-reminder-message-111-5000',
      'gator-reminder-message-111-6000',
    ]);
    for (const [notification] of mockCreateTrigger.mock.calls) {
      expect(notification).toEqual(
        expect.objectContaining({ title: 'Reminder', body: 'Reminder' }),
      );
      expect(JSON.stringify(notification)).not.toMatch(/Alice|full preview stays untouched/);
    }
    expect(mockMigrateReminderNotificationId).toHaveBeenCalledTimes(2);
  });
});

describe('channel promises do not memoize a rejection', () => {
  it('reminder channel: a failed createChannel is retried on the next call', async () => {
    // Fresh module instance so the reminder-channel memo starts null regardless of test order.
    await jest.isolateModulesAsync(async () => {
      const svc = loadFreshService();
      const reminder = {
        notificationId: 'gator-reminder-message-1-9999',
        chatGuid: 'c',
        messageGuid: 'm',
        scheduledFor: 9999,
      };
      // First attempt: createChannel rejects → schedule rejects, cache cleared (not poisoned).
      mockCreateChannel.mockRejectedValueOnce(new Error('channel boom'));
      await expect(svc.scheduleReminderNotification(reminder)).rejects.toThrow('channel boom');
      // Second attempt: createChannel now succeeds → the reminder actually schedules.
      await svc.scheduleReminderNotification({
        ...reminder,
        notificationId: 'gator-reminder-message-2-9999',
      });
      expect(mockCreateTrigger.mock.calls.at(-1)![0].id).toBe('gator-reminder-message-2-9999');
    });
  });

  // REGRESSION: the main "New Messages" channel was the ONLY one missing this guard — it
  // memoized the rejected createChannel promise forever, so a single transient failure meant
  // every later message notification awaited that rejection and threw. Message notifications
  // then stopped for the rest of the JS context with nothing but an unhandled rejection to
  // show for it. The reminder case above always had the reset; this one did not.
  it('new-messages channel: a failed createChannel is retried on the next call', async () => {
    await jest.isolateModulesAsync(async () => {
      const svc = loadFreshService();
      const msg: NotificationIntent = {
        kind: 'message',
        chatGuid: 'chat-retry',
        chatTitle: 'Alice',
        senderName: 'Alice',
        senderHandle: '+15551234567',
        body: 'hi',
        messageGuid: 'm-retry',
        timestamp: 1000,
        isGroup: false,
      };
      mockCreateChannel.mockRejectedValueOnce(new Error('msg channel boom'));
      await expect(svc.postNotification(msg)).rejects.toThrow('msg channel boom');
      // Cache cleared, not poisoned — the retry actually posts.
      await svc.postNotification(msg);
      expect(mockDisplay.mock.calls.at(-1)![0].id).toBe('gator-message-16');
    });
  });
});

describe('postNotification — test-notification (the server push self-test)', () => {
  it('shows a generic local result under a fixed id', async () => {
    await postNotification({
      kind: 'test-notification',
      title: 'Gator',
      body: 'Test notification from your Gator server 🐊',
    });
    const n = lastNotif();
    expect(n.id).toBe('bb-test-notification');
    expect(n.title).toBe('Gator');
    expect(n.body).toBe('Test notification received.');
    expect(n.android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
  });
});

describe('cancel helpers', () => {
  it('keeps maintenance, reminder scheduling, and partially failing teardown in FIFO order', async () => {
    let releaseDisplayed!: (value: unknown[]) => void;
    mockGetDisplayed.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDisplayed = resolve;
        }),
    );
    mockGetTriggers.mockResolvedValueOnce([]);
    const legacyChannel = `${CHANNEL_NEW_MESSAGE}.chat.iMessage____15551234567`;
    const safeChannel = `${CHANNEL_NEW_MESSAGE}.chat.route_7`;
    mockGetChannels.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: legacyChannel, name: 'ACCOUNT_A_CHANNEL', importance: 4 },
      { id: safeChannel, name: 'ACCOUNT_A_SAFE_CHANNEL', importance: 3 },
    ]);
    mockCancelAll.mockRejectedValueOnce(new Error('NATIVE_CANCEL_FAILURE_CANARY'));

    const maintenance = prepareNotificationPresentationState();
    for (let i = 0; i < 20 && releaseDisplayed == null; i += 1) await Promise.resolve();
    const scheduling = scheduleReminderNotification({
      notificationId: 'gator-reminder-message-101-7300',
      chatGuid: 'c1',
      messageGuid: 'm1',
      scheduledFor: 7300,
    });
    const teardownResult = cancelAllNotifications().then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    expect(mockCreateTrigger).not.toHaveBeenCalled();
    expect(mockCancelAll).not.toHaveBeenCalled();

    releaseDisplayed([]);
    await maintenance;
    await scheduling;
    const teardownError = await teardownResult;

    expect(teardownError).toEqual(expect.any(Error));
    expect((teardownError as Error).message).toContain('could not fully clear notification state');
    expect(mockCreateTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gator-reminder-message-101-7300',
        title: 'Reminder',
        body: 'Reminder',
      }),
      expect.objectContaining({ timestamp: 7300 }),
    );
    expect(mockDeleteChannel).toHaveBeenCalledWith(legacyChannel);
    expect(mockCreateChannel).toHaveBeenCalledWith({
      id: safeChannel,
      name: 'Conversation',
      importance: 3,
    });
    expect(mockClearNotificationRoutes).toHaveBeenCalledTimes(2);
    expect(mockCreateTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelAll.mock.invocationCallOrder[0]!,
    );
    const legacyChannelCall = mockDeleteChannel.mock.calls.findIndex(
      ([channelId]) => channelId === legacyChannel,
    );
    expect(legacyChannelCall).toBeGreaterThanOrEqual(0);
    expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteChannel.mock.invocationCallOrder[legacyChannelCall]!,
    );
    expect(mockClearNotificationRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateTrigger.mock.invocationCallOrder[0]!,
    );
    expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearNotificationRoutes.mock.invocationCallOrder[1]!,
    );
  });

  it('sanitizes a per-chat channel whose creation was already in flight at teardown', async () => {
    const safe = chatChannelId(99);
    let releaseCreate!: (id: string) => void;
    mockCreateChannel.mockImplementationOnce(
      ({ id: _id }: { id: string }) =>
        new Promise<string>((resolve) => {
          releaseCreate = resolve;
        }),
    );

    const open = openChatNotificationSettings('late-account-a-chat', 'Alice');
    for (let i = 0; i < 10 && releaseCreate == null; i += 1) await Promise.resolve();
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: safe, name: 'Alice' }),
    );

    mockGetChannels.mockResolvedValueOnce([{ id: safe, name: 'Alice', importance: 4 }]);
    const teardown = cancelAllNotifications();
    await Promise.resolve();
    expect(mockCancelAll).not.toHaveBeenCalled();

    releaseCreate(safe);
    await Promise.all([open, teardown]);

    expect(mockCancelAll).toHaveBeenCalledTimes(1);
    expect(mockCreateChannel).toHaveBeenLastCalledWith({
      id: safe,
      name: 'Conversation',
      importance: 4,
    });
    expect(mockCreateChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelAll.mock.invocationCallOrder[0]!,
    );
    expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateChannel.mock.invocationCallOrder[1]!,
    );
  });

  it('teardown sanitizes persistent per-chat channel names without touching shared channels', async () => {
    const legacy = `${CHANNEL_NEW_MESSAGE}.chat.iMessage____15551234567`;
    const safe = `${CHANNEL_NEW_MESSAGE}.chat.route_7`;
    mockGetChannels.mockResolvedValueOnce([
      { id: CHANNEL_NEW_MESSAGE, name: 'New Messages', importance: 4 },
      { id: CHANNEL_REMINDERS, name: 'Reminders', importance: 4 },
      { id: legacy, name: 'Alice', importance: 4 },
      { id: safe, name: 'Bob', importance: 3 },
    ]);

    await cancelAllNotifications();

    expect(mockCancelAll).toHaveBeenCalledTimes(1);
    expect(mockDeleteChannel).toHaveBeenCalledWith(legacy);
    expect(mockCreateChannel).toHaveBeenCalledWith({
      id: safe,
      name: 'Conversation',
      importance: 3,
    });
    expect(mockDeleteChannel).not.toHaveBeenCalledWith(CHANNEL_NEW_MESSAGE);
    expect(mockDeleteChannel).not.toHaveBeenCalledWith(CHANNEL_REMINDERS);
  });

  it('cancelForChat cancels by chatGuid', async () => {
    await cancelForChat('chat-3');
    expect(mockCancel).toHaveBeenCalledWith('gator-message-3');
    expect(mockCancel).toHaveBeenCalledWith('chat-3');
  });

  it('cancelReminderNotification cancels either a future trigger or an already displayed reminder', async () => {
    await cancelReminderNotification('reminder-abc');
    expect(mockCancel).toHaveBeenCalledWith('reminder-abc');
    expect(mockCancelTrigger).not.toHaveBeenCalled();
  });

  it('clearChatNotification queues a fire-and-forget cancel by chatGuid', async () => {
    clearChatNotification('chat-4');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockCancel).toHaveBeenCalledWith('gator-message-4');
    expect(mockCancel).toHaveBeenCalledWith('chat-4');
  });

  it('drops a queued chat cancel after its account lease is retired', async () => {
    let current = true;
    const lease = { generation: 7, isCurrent: () => current };
    clearChatNotification('chat-4', lease);
    current = false;

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('clearChatNotification catches and logs a rejected fire-and-forget cancel', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockCancel.mockRejectedValue(new Error('native cancel failed'));
    clearChatNotification('chat-4');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(
      '[notif] clear chat notification failed',
      expect.objectContaining({ message: 'native cancel failed' }),
    );
  });
});
