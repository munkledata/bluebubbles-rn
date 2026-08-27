/**
 * Unit tests for the Notifee presentation layer (`src/services/notifications/notifeeService.ts`).
 *
 * These functions build the exact Notifee payloads posted to the OS. The invariants pinned:
 *   - Ordinary unlocked notifications keep exact message, caller, alias, and reminder detail;
 *     App Lock alone uses the fixed content-less delivery path.
 *   - The MESSAGING-style `person.icon` is spread CONDITIONALLY — never `icon: undefined`
 *     (AGENTS.md: passing undefined throws at displayNotification on device). No avatar means
 *     the `person` object has NO `icon` key at all.
 *   - Each notification targets the right channel, id, and press/actions.
 *   - Channel promises don't memoize a rejection (a failed createChannel can be retried).
 *
 * notifee is a native module — mocked here with jest.fn spies so we can inspect the payloads
 * (the shared runtime stub in test/__mocks__/notifee.ts isn't spyable and lacks AndroidCategory
 * / AlarmType). This is a pure `node`-project test.
 */
import notifee from 'react-native-notify-kit';
import type { EventDeliveryContext, NotificationIntent } from '@core/realtime';
import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { claimActiveChat, resetActiveChat } from '@/services/notifications/activeChat';
import {
  getOrCreateFaceTimeRoute,
  listFutureReminderTriggerRoutes,
} from '@/services/notifications/notificationRouting';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  ACTION_DECLINE_FACETIME,
  ACTION_LOVE,
  ACTION_MARK_READ,
  ACTION_REPLY,
  CHANNEL_FACETIME,
  CHANNEL_NEW_MESSAGE,
  CHANNEL_REMINDERS,
  PRESS_OPEN,
  PRESS_REMINDER,
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
  requestNotificationPermission,
  scheduleReminderNotification,
} from '@/services/notifications/notifeeService';

const ALARM_IDLE = 3;
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AndroidStyle: { BIGPICTURE: 0, BIGTEXT: 1, INBOX: 2, MESSAGING: 3 },
  AndroidCategory: { CALL: 'call' },
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
    nativeFaceTimeData: (token: string) => ({ ...marker('facetime'), routeToken: token }),
    getOrCreateFaceTimeRoute: jest.fn(async () => '7f000000-0000-4000-8000-000000000001'),
    findFaceTimeRoute: jest.fn(async () => '7f000000-0000-4000-8000-000000000001'),
    deleteFaceTimeRoute: jest.fn(async () => undefined),
    clearNotificationRoutes: jest.fn(async () => undefined),
    listFutureReminderTriggerRoutes: jest.fn(async () => []),
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
const mockGetOrCreateFaceTimeRoute = getOrCreateFaceTimeRoute as jest.Mock;
const mockListFutureReminderTriggerRoutes = listFutureReminderTriggerRoutes as jest.Mock;
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

beforeEach(() => {
  resumeRealtimeDeliveries();
  resetActiveChat();
  useLockStore.setState({
    enabled: false,
    locked: false,
    hydrated: true,
    lastBackgrounded: null,
    timeoutMs: 30_000,
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
  resetActiveChat();
  jest.restoreAllMocks();
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

describe('per-chat notification channel', () => {
  it('chatChannelId derives a safe, stable id from a local integer', () => {
    expect(chatChannelId(7)).toBe(`${CHANNEL_NEW_MESSAGE}.chat.route_7`);
    expect(chatChannelId(123)).not.toMatch(/[+@;]/);
  });

  it('openChatNotificationSettings creates the per-chat channel and opens its OS settings', async () => {
    const guid = 'iMessage;-;+15551234567';
    await openChatNotificationSettings(guid, 'Alice');
    const id = chatChannelId(99);
    expect(mockCreateChannel).toHaveBeenCalledWith(expect.objectContaining({ id, name: 'Alice' }));
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
      'FaceTime',
      {
        kind: 'facetime-call',
        uuid: 'LOCKED_FACETIME_UUID_CANARY',
        callerName: 'LOCKED_FACETIME_CALLER_CANARY',
        isAudio: false,
      } as NotificationIntent,
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
    expect(mockGetOrCreateFaceTimeRoute).not.toHaveBeenCalled();
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

  it('rechecks App Lock after a deferred FaceTime route handoff', async () => {
    let releaseRoute!: () => void;
    mockGetOrCreateFaceTimeRoute.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseRoute = () => resolve('7f000000-0000-4000-8000-0000000000cc');
        }),
    );
    const pending = postNotification({
      kind: 'facetime-call',
      uuid: 'LATE_LOCK_FACETIME_UUID_CANARY',
      callerName: 'LATE_LOCK_FACETIME_CALLER_CANARY',
      isAudio: false,
    });
    for (let i = 0; i < 20 && mockGetOrCreateFaceTimeRoute.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    useLockStore.setState({ enabled: true, locked: true });
    releaseRoute();
    await pending;

    const notification = lastNotif();
    expect(notification).toEqual(
      expect.objectContaining({
        id: 'bb-locked-messages',
        title: 'Gator',
        body: 'You have new messages',
      }),
    );
    expect(JSON.stringify(notification)).not.toMatch(/LATE_LOCK_FACETIME_/);
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

  it('OMITS the person.icon key entirely when there is no avatar (never icon:undefined)', async () => {
    await postNotification(messageIntent({ avatarUri: undefined }));
    const sender = lastNotif().android?.style.messages[0].person;
    expect(sender).not.toHaveProperty('icon'); // the AGENTS.md conditional-spread rule
  });

  it('exposes the three inline actions: Reply (free-form), Mark as read, ♥ Love', async () => {
    await postNotification(messageIntent());
    const actions = lastNotif().android?.actions as Array<any>;
    expect(actions.map((a) => a.pressAction.id)).toEqual([
      ACTION_REPLY,
      ACTION_MARK_READ,
      ACTION_LOVE,
    ]);
    expect(actions[0].input.allowFreeFormInput).toBe(true);
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
      ).rejects.toThrow('the old notification was cancelled');
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
        title: 'Message not sent',
        body: 'Open Gator to review and retry.',
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

describe('postNotification — facetime-call', () => {
  const call: NotificationIntent = {
    kind: 'facetime-call',
    uuid: 'u2',
    callerName: 'Bob Jones',
    isAudio: false,
  };

  it('rings with the caller name, CALL category, ongoing + full-screen + Answer/Decline', async () => {
    await postNotification(call);
    const n = lastNotif();
    expect(n.id).toBe('gator-facetime-7f000000-0000-4000-8000-000000000001');
    expect(n.title).toBe('Incoming FaceTime');
    expect(n.body).toBe('Bob Jones');
    expect(n.data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'facetime',
      routeToken: '7f000000-0000-4000-8000-000000000001',
    });
    expect(JSON.stringify({ id: n.id, data: n.data })).not.toContain('u2');
    expect(n.android?.channelId).toBe(CHANNEL_FACETIME);
    expect(n.android?.category).toBe('call');
    expect(n.android?.ongoing).toBe(true);
    expect(n.android?.autoCancel).toBe(false);
    expect(n.android?.fullScreenAction).toEqual({ id: 'default', launchActivity: 'default' });
    const actions = n.android?.actions as Array<any>;
    expect(actions.map((a) => a.pressAction.id)).toEqual([
      ACTION_DECLINE_FACETIME,
      'answer-facetime',
    ]);
  });

  it('passes the original account guard to FaceTime route creation and allows a fresh account call', async () => {
    let capturedGuard: (() => boolean) | undefined;
    let releaseRoute!: () => void;
    mockGetOrCreateFaceTimeRoute.mockImplementationOnce(
      async (_uuid: string, commitGuard?: () => boolean) => {
        capturedGuard = commitGuard;
        await new Promise<void>((resolve) => {
          releaseRoute = resolve;
        });
        if (commitGuard?.() === false) throw new Error('stale FaceTime route commit rejected');
        return '7f000000-0000-4000-8000-0000000000aa';
      },
    );
    const accountA = captureRealtimeDeliveryLease();
    const staleResult = postNotification(
      { ...call, uuid: 'ACCOUNT_A_CALL_UUID', callerName: 'ACCOUNT_A_CALLER' },
      accountA,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    for (let i = 0; i < 20 && capturedGuard == null; i += 1) await Promise.resolve();

    expect(capturedGuard).toEqual(expect.any(Function));
    expect(capturedGuard?.()).toBe(true);
    const pause = pauseRealtimeDeliveries();
    expect(capturedGuard?.()).toBe(false);
    releaseRoute();

    await expect(staleResult).resolves.toEqual(new Error('stale FaceTime route commit rejected'));
    await pause;
    expect(mockDisplay).not.toHaveBeenCalled();

    resumeRealtimeDeliveries();
    mockGetOrCreateFaceTimeRoute.mockResolvedValueOnce('7f000000-0000-4000-8000-0000000000bb');
    await postNotification(
      { ...call, uuid: 'ACCOUNT_B_CALL_UUID', callerName: 'ACCOUNT_B_CALLER' },
      captureRealtimeDeliveryLease(),
    );

    expect(lastNotif()).toEqual(
      expect.objectContaining({
        id: 'gator-facetime-7f000000-0000-4000-8000-0000000000bb',
        body: 'ACCOUNT_B_CALLER',
      }),
    );
    expect(mockGetOrCreateFaceTimeRoute).toHaveBeenLastCalledWith(
      'ACCOUNT_B_CALL_UUID',
      expect.any(Function),
    );
  });

  it('titles an audio call "Incoming FaceTime Audio"', async () => {
    await postNotification({ ...call, isAudio: true });
    expect(lastNotif().title).toBe('Incoming FaceTime Audio');
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
    title: 'Alice',
    body: 'call the dentist',
    scheduledFor: 5000,
  };

  it('creates an INEXACT (doze-friendly) timestamp trigger honoring the body', async () => {
    await scheduleReminderNotification(args);
    const [payload, trigger] = mockCreateTrigger.mock.calls.at(-1)!;
    expect(payload.id).toBe('gator-reminder-message-101-5000');
    expect(payload.title).toBe('Alice');
    expect(payload.body).toBe('call the dentist');
    expect(payload.data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'reminder',
      chatId: '1',
      messageId: '101',
    });
    expect(payload.android.channelId).toBe(CHANNEL_REMINDERS);
    expect(payload.android.pressAction).toEqual({ id: PRESS_REMINDER, launchActivity: 'default' });
    expect(trigger.type).toBe(0); // TriggerType.TIMESTAMP
    expect(trigger.timestamp).toBe(5000);
    expect(trigger.alarmManager).toEqual({ type: ALARM_IDLE }); // SET_AND_ALLOW_WHILE_IDLE — no exact-alarm perm
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
    it('leaves current detailed payloads and safe channel names untouched', async () => {
      const current = {
        id: 'gator-message-10',
        notification: {
          id: 'gator-message-10',
          title: 'Alice Current Detail',
          body: 'CURRENT_DETAILED_BODY',
          data: {
            gatorOwner: 'gator',
            gatorSchema: '2',
            gatorKind: 'message',
            chatId: '10',
            messageId: '110',
            messageDate: '1700000000000',
          },
        },
      };
      const safeChannel = `${CHANNEL_NEW_MESSAGE}.chat.route_10`;
      mockGetDisplayed.mockResolvedValueOnce([current]);
      mockGetTriggers.mockResolvedValueOnce([]);
      mockGetChannels.mockResolvedValueOnce([
        { id: safeChannel, name: 'Alice Current Detail', importance: 4 },
      ]);

      await prepareNotificationPresentationState();

      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancelDisplayedAll).not.toHaveBeenCalled();
      expect(mockCancelTriggersAll).not.toHaveBeenCalled();
      expect(mockDeleteChannel).not.toHaveBeenCalled();
      expect(mockCreateChannel).not.toHaveBeenCalled();
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

      expect(mockGetDisplayed).toHaveBeenCalledTimes(1);
      expect(mockGetTriggers).toHaveBeenCalledTimes(1);
      expect(mockGetChannels).toHaveBeenCalledTimes(1);
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

    it('guards a legacy FaceTime route migration with the admitted account lease', async () => {
      const legacyFaceTime = {
        id: 'legacy-account-a-facetime',
        notification: {
          id: 'legacy-account-a-facetime',
          title: 'Incoming FaceTime',
          body: 'ACCOUNT_A_CALLER_NAME',
          data: {
            faceTimeUuid: 'ACCOUNT_A_PRIVATE_CALL_UUID',
            caller: 'ACCOUNT_A_CALLER_NAME',
          },
        },
      };
      let releaseRoute!: () => void;
      let capturedGuard: (() => boolean) | undefined;
      let routeCommitted = false;
      mockGetDisplayed
        .mockResolvedValueOnce([legacyFaceTime])
        .mockResolvedValueOnce([legacyFaceTime]);
      mockGetTriggers.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockListFutureReminderTriggerRoutes.mockResolvedValueOnce([]);
      mockGetOrCreateFaceTimeRoute.mockImplementationOnce(
        async (uuid: string, commitGuard?: () => boolean) => {
          expect(uuid).toBe('ACCOUNT_A_PRIVATE_CALL_UUID');
          capturedGuard = commitGuard;
          await new Promise<void>((resolve) => {
            releaseRoute = resolve;
          });
          if (commitGuard?.() === false) throw new Error('stale FaceTime route commit rejected');
          routeCommitted = true;
          return '7f000000-0000-4000-8000-0000000000aa';
        },
      );

      const maintenance = prepareNotificationPresentationState();
      for (let i = 0; i < 20 && capturedGuard == null; i += 1) await Promise.resolve();

      expect(capturedGuard).toEqual(expect.any(Function));
      expect(capturedGuard?.()).toBe(true);
      const pause = pauseRealtimeDeliveries();
      expect(capturedGuard?.()).toBe(false);

      releaseRoute();
      await expect(Promise.all([maintenance, pause])).resolves.toEqual([undefined, undefined]);

      expect(routeCommitted).toBe(false);
      expect(mockGetOrCreateFaceTimeRoute).toHaveBeenCalledWith(
        'ACCOUNT_A_PRIVATE_CALL_UUID',
        capturedGuard,
      );
      expect(mockDisplay).not.toHaveBeenCalled();
      expect(mockCancelDisplayedAll).not.toHaveBeenCalled();
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
      ACTION_LOVE,
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

    const faceTime = reposted.find((notification) => notification.id.startsWith('gator-facetime-'));
    expect(faceTime).toEqual(
      expect.objectContaining({
        title: 'Incoming FaceTime',
        body: 'Incoming call',
        data: {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'facetime',
          routeToken: '7f000000-0000-4000-8000-000000000001',
        },
      }),
    );
    expect(faceTime.android.actions.map((action: any) => action.title)).toEqual([
      'Decline',
      'Answer',
    ]);
    expect(JSON.stringify(faceTime)).not.toMatch(
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

    expect(mockGetDisplayed).toHaveBeenCalledTimes(1);
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

    expect(mockGetDisplayed).toHaveBeenCalledTimes(1);
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

      expect(mockGetDisplayed).toHaveBeenCalledTimes(2);
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
    for (let i = 0; i < 10 && releaseChannels == null; i += 1) await Promise.resolve();
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
    expect(mockGetDisplayed).toHaveBeenCalledTimes(1);
    expect(mockGetTriggers).toHaveBeenCalledTimes(1);
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

    expect(mockGetTriggers).toHaveBeenCalledTimes(3);
    expect(mockCancelTriggersAll).toHaveBeenCalledTimes(1);
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

  it('on ordinary startup creates only missing durable reminders with a guarded id handoff', async () => {
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

    expect(mockCancelTriggersAll).not.toHaveBeenCalled();
    expect(mockCancelTrigger).not.toHaveBeenCalled();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    expect(mockCreateTrigger.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'gator-reminder-message-111-6000',
        title: 'Reminder',
        body: 'Reminder',
      }),
    );
    expect(mockCreateTrigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gator-reminder-message-111-5000' }),
      expect.anything(),
    );
    expect(mockMigrateReminderNotificationId).toHaveBeenCalledWith(
      'reminder-old-6000',
      'gator-reminder-message-111-6000',
      expect.any(Function),
    );
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
        title: 't',
        body: 'b',
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

  it('facetime channel: a failed createChannel is retried on the next call', async () => {
    await jest.isolateModulesAsync(async () => {
      const svc = loadFreshService();
      const call = {
        kind: 'facetime-call' as const,
        uuid: 'ft-retry',
        callerName: 'Bob',
        isAudio: false,
      };
      mockCreateChannel.mockRejectedValueOnce(new Error('ft channel boom'));
      await expect(svc.postNotification(call)).rejects.toThrow('ft channel boom');
      // Cache wasn't poisoned — the next post creates the channel and rings.
      await svc.postNotification(call);
      expect(mockDisplay.mock.calls.at(-1)![0].id).toBe(
        'gator-facetime-7f000000-0000-4000-8000-000000000001',
      );
    });
  });

  // REGRESSION: the main "New Messages" channel was the ONLY one missing this guard — it
  // memoized the rejected createChannel promise forever, so a single transient failure meant
  // every later message notification awaited that rejection and threw. Message notifications
  // then stopped for the rest of the JS context with nothing but an unhandled rejection to
  // show for it. The reminder/facetime cases above always had the reset; this one did not.
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
      title: 'CURRENT_REMINDER_TITLE',
      body: 'CURRENT_REMINDER_BODY',
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
        title: 'CURRENT_REMINDER_TITLE',
        body: 'CURRENT_REMINDER_BODY',
      }),
      expect.objectContaining({ timestamp: 7300 }),
    );
    expect(mockDeleteChannel).toHaveBeenCalledWith(legacyChannel);
    expect(mockCreateChannel).toHaveBeenCalledWith({
      id: safeChannel,
      name: 'Conversation',
      importance: 3,
    });
    expect(mockClearNotificationRoutes).toHaveBeenCalledTimes(1);
    expect(mockCreateTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelAll.mock.invocationCallOrder[0]!,
    );
    expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteChannel.mock.invocationCallOrder[0]!,
    );
    expect(mockCancelAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearNotificationRoutes.mock.invocationCallOrder[0]!,
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

  it('cancelReminderNotification cancels the trigger by id', async () => {
    await cancelReminderNotification('reminder-abc');
    expect(mockCancelTrigger).toHaveBeenCalledWith('reminder-abc');
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
