/**
 * Unit tests for the Notifee presentation layer (`src/services/notifications/notifeeService.ts`).
 *
 * These functions build the exact Notifee payloads posted to the OS. The invariants pinned:
 *   - PRIVACY (AGENTS.md "Every notification body must honor the hidePreview toggle"): with
 *     redacted mode ON, the body/title/sender name are masked and the avatar is dropped on
 *     EVERY path (message, FaceTime caller, reminder, alias-removed).
 *   - The MESSAGING-style `person.icon` is spread CONDITIONALLY — never `icon: undefined`
 *     (AGENTS.md: passing undefined throws at displayNotification on device). No avatar (or
 *     redacted) ⇒ the `person` object has NO `icon` key at all.
 *   - Each notification targets the right channel, id, and press/actions.
 *   - Channel promises don't memoize a rejection (a failed createChannel can be retried).
 *
 * notifee is a native module — mocked here with jest.fn spies so we can inspect the payloads
 * (the shared runtime stub in test/__mocks__/notifee.ts isn't spyable and lacks AndroidCategory
 * / AlarmType). This is a pure `node`-project test.
 */
import notifee from 'react-native-notify-kit';
import type { NotificationIntent } from '@core/realtime';
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
  cancelForChat,
  cancelReminderNotification,
  chatChannelId,
  clearChatNotification,
  openChatNotificationSettings,
  postLockedNotification,
  postNotification,
  requestNotificationPermission,
  scheduleReminderNotification,
  setHideNotificationPreview,
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
    displayNotification: jest.fn(async () => undefined),
    createTriggerNotification: jest.fn(async () => undefined),
    cancelNotification: jest.fn(async () => undefined),
    cancelTriggerNotification: jest.fn(async () => undefined),
    // Default: no per-chat channel exists → notifications route to the shared channel.
    getChannel: jest.fn(async () => null),
    openNotificationSettings: jest.fn(async () => undefined),
  },
}));

const mockDisplay = notifee.displayNotification as jest.Mock;
const mockCreateChannel = notifee.createChannel as jest.Mock;
const mockCreateTrigger = notifee.createTriggerNotification as jest.Mock;
const mockCancel = notifee.cancelNotification as jest.Mock;
const mockCancelTrigger = notifee.cancelTriggerNotification as jest.Mock;
const mockRequestPermission = notifee.requestPermission as jest.Mock;
const mockGetChannel = notifee.getChannel as jest.Mock;
const mockOpenSettings = notifee.openNotificationSettings as jest.Mock;

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
  // Module-level hidePreview leaks between tests — reset to the default (OFF).
  setHideNotificationPreview(false);
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
});

describe('per-chat notification channel', () => {
  it('chatChannelId derives a safe, stable id from the guid', () => {
    expect(chatChannelId('a;b')).toBe(`${CHANNEL_NEW_MESSAGE}.chat.a_b`);
    // No unsafe characters survive (Android channel ids need a restricted charset).
    expect(chatChannelId('iMessage;-;+15551234567')).toMatch(/^[\w.]+$/);
  });

  it('openChatNotificationSettings creates the per-chat channel and opens its OS settings', async () => {
    const guid = 'iMessage;-;+15551234567';
    await openChatNotificationSettings(guid, 'Alice');
    const id = chatChannelId(guid);
    expect(mockCreateChannel).toHaveBeenCalledWith(expect.objectContaining({ id, name: 'Alice' }));
    expect(mockOpenSettings).toHaveBeenCalledWith(id);
  });

  it('routes a message notification to the per-chat channel when one exists', async () => {
    const id = chatChannelId('chat-1');
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

describe('postNotification — message (default, not redacted)', () => {
  it('posts one notification per chat (id=chatGuid) with the real title/body/sender', async () => {
    await postNotification(messageIntent({ avatarUri: 'file:///a.png' }));
    const n = lastNotif();
    expect(n.id).toBe('chat-1');
    expect(n.title).toBe('Alice');
    expect(n.body).toBe('secret plans');
    // messageDate (stringified timestamp) is carried so a notification tap can deep-link with
    // ?focusDate and scroll the chat to the message.
    expect(n.data).toEqual({
      chatGuid: 'chat-1',
      messageGuid: 'msg-1',
      messageDate: '1700000000000',
    });
    expect(n.android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
    expect(n.android?.pressAction).toEqual({ id: PRESS_OPEN, launchActivity: 'default' });
  });

  it('uses the MESSAGING style and INCLUDES person.icon when an avatar is present', async () => {
    await postNotification(messageIntent({ avatarUri: 'file:///a.png' }));
    const style = lastNotif().android?.style;
    expect(style.type).toBe(3); // AndroidStyle.MESSAGING
    const sender = style.messages[0].person;
    expect(sender.name).toBe('Alice');
    expect(sender.id).toBe('alice@x.com');
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
});

describe('postNotification — message (REDACTED / hidePreview ON) — privacy pin', () => {
  it('masks body, title and sender name, and DROPS the avatar', async () => {
    setHideNotificationPreview(true);
    await postNotification(messageIntent({ avatarUri: 'file:///a.png' }));
    const n = lastNotif();
    expect(n.body).toBe('New message'); // generic, not "secret plans"
    expect(n.title).toBe('Contact'); // redactTitle placeholder, not "Alice"
    const sender = n.android?.style.messages[0].person;
    expect(sender.name).toBe('Contact');
    // Avatar must NOT leak the contact in redacted mode — icon key absent even though avatarUri set.
    expect(sender).not.toHaveProperty('icon');
    // The style message text is also the redacted body.
    expect(n.android?.style.messages[0].text).toBe('New message');
  });

  it('masks a Genmoji-description body to "New message" too — the description is message content', async () => {
    // buildMessageIntents may put a Genmoji's natural-language description in the body (see
    // notificationIntent.test); under hidePreview it must STILL be redacted, never leaked.
    setHideNotificationPreview(true);
    await postNotification(messageIntent({ body: 'a smiling cat wearing a top hat' }));
    const n = lastNotif();
    expect(n.body).toBe('New message');
    expect(n.android?.style.messages[0].text).toBe('New message');
  });
});

describe('postNotification — cancel / facetime-cancel', () => {
  it('kind:cancel clears the chat notification by guid', async () => {
    await postNotification({ kind: 'cancel', chatGuid: 'chat-9' });
    expect(mockCancel).toHaveBeenCalledWith('chat-9');
    expect(mockDisplay).not.toHaveBeenCalled();
  });

  it('kind:facetime-cancel clears the ringing notification (ft-<uuid>)', async () => {
    await postNotification({ kind: 'facetime-cancel', uuid: 'u1' });
    expect(mockCancel).toHaveBeenCalledWith('ft-u1');
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
    expect(n.id).toBe('ft-u2');
    expect(n.title).toBe('Incoming FaceTime');
    expect(n.body).toBe('Bob Jones');
    expect(n.data).toEqual({ faceTimeUuid: 'u2' });
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

  it('titles an audio call "Incoming FaceTime Audio"', async () => {
    await postNotification({ ...call, isAudio: true });
    expect(lastNotif().title).toBe('Incoming FaceTime Audio');
  });

  it('REDACTS the caller name to "Incoming call" under hidePreview (privacy pin)', async () => {
    setHideNotificationPreview(true);
    await postNotification(call);
    expect(lastNotif().body).toBe('Incoming call');
  });
});

describe('postNotification — alias-removed', () => {
  it('names the single deregistered alias when not redacted', async () => {
    await postNotification({ kind: 'alias-removed', aliases: ['me@icloud.com'] });
    const n = lastNotif();
    expect(n.id).toBe('bb-aliases-removed');
    expect(n.title).toBe('iMessage');
    expect(n.body).toBe('me@icloud.com has been deregistered.');
  });

  it('lists multiple aliases when not redacted', async () => {
    await postNotification({
      kind: 'alias-removed',
      aliases: ['me@icloud.com', '+15551234567'],
    });
    expect(lastNotif().body).toBe('Aliases deregistered: me@icloud.com, +15551234567');
  });

  it('REDACTS the alias body under hidePreview (privacy pin — the alias is the user address)', async () => {
    setHideNotificationPreview(true);
    await postNotification({ kind: 'alias-removed', aliases: ['me@icloud.com'] });
    expect(lastNotif().body).toBe('An iMessage alias was deregistered.');
  });
});

describe('postNotification — rcs-bridge-down (verbatim server status, no redaction)', () => {
  it('shows the server-supplied title/body verbatim under a fixed id', async () => {
    setHideNotificationPreview(true); // even redacted: this carries no private content
    await postNotification({
      kind: 'rcs-bridge-down',
      title: 'RCS bridge down',
      body: 'Re-authenticate on the server.',
    });
    const n = lastNotif();
    expect(n.id).toBe('bb-rcs-bridge-down');
    expect(n.title).toBe('RCS bridge down');
    expect(n.body).toBe('Re-authenticate on the server.');
  });
});

describe('postLockedNotification', () => {
  it('posts a single content-less "you have messages" notification (no sender/content)', async () => {
    await postLockedNotification();
    const n = lastNotif();
    expect(n.id).toBe('bb-locked-messages');
    expect(n.title).toBe('Gator');
    expect(n.body).toBe('You have new messages');
    expect(n.data).toBeUndefined(); // no chatGuid/messageGuid leaked
    expect(n.android?.channelId).toBe(CHANNEL_NEW_MESSAGE);
  });
});

describe('scheduleReminderNotification', () => {
  const args = {
    notificationId: 'reminder-m1-5000',
    chatGuid: 'c1',
    messageGuid: 'm1',
    title: 'Reminder',
    body: 'call the dentist',
    scheduledFor: 5000,
  };

  it('creates an INEXACT (doze-friendly) timestamp trigger honoring the body', async () => {
    await scheduleReminderNotification(args);
    const [payload, trigger] = mockCreateTrigger.mock.calls.at(-1)!;
    expect(payload.id).toBe('reminder-m1-5000');
    expect(payload.body).toBe('call the dentist');
    expect(payload.data).toEqual({ chatGuid: 'c1', messageGuid: 'm1', reminder: '1' });
    expect(payload.android.channelId).toBe(CHANNEL_REMINDERS);
    expect(payload.android.pressAction).toEqual({ id: PRESS_REMINDER, launchActivity: 'default' });
    expect(trigger.type).toBe(0); // TriggerType.TIMESTAMP
    expect(trigger.timestamp).toBe(5000);
    expect(trigger.alarmManager).toEqual({ type: ALARM_IDLE }); // SET_AND_ALLOW_WHILE_IDLE — no exact-alarm perm
  });

  it('carries the message date (stringified) in data so a tap deep-links with ?focusDate', async () => {
    await scheduleReminderNotification({ ...args, messageDate: 1700000000000 });
    expect(mockCreateTrigger.mock.calls.at(-1)![0].data).toEqual({
      chatGuid: 'c1',
      messageGuid: 'm1',
      reminder: '1',
      messageDate: '1700000000000',
    });
  });

  it('REDACTS the reminder body to "Reminder" under hidePreview (privacy pin)', async () => {
    setHideNotificationPreview(true);
    await scheduleReminderNotification(args);
    expect(mockCreateTrigger.mock.calls.at(-1)![0].body).toBe('Reminder');
  });

  it('rethrows when createTriggerNotification fails (surfaces the scheduling error)', async () => {
    mockCreateTrigger.mockRejectedValueOnce(new Error('trigger.timestamp must be in the future'));
    await expect(scheduleReminderNotification(args)).rejects.toThrow('must be in the future');
  });
});

describe('channel promises do not memoize a rejection', () => {
  it('reminder channel: a failed createChannel is retried on the next call', async () => {
    // Fresh module instance so the reminder-channel memo starts null regardless of test order.
    await jest.isolateModulesAsync(async () => {
      const svc =
        require('@/services/notifications/notifeeService') as typeof import('@/services/notifications/notifeeService');
      const reminder = {
        notificationId: 'r-x',
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
      await svc.scheduleReminderNotification({ ...reminder, notificationId: 'r-y' });
      expect(mockCreateTrigger.mock.calls.at(-1)![0].id).toBe('r-y');
    });
  });

  it('facetime channel: a failed createChannel is retried on the next call', async () => {
    await jest.isolateModulesAsync(async () => {
      const svc =
        require('@/services/notifications/notifeeService') as typeof import('@/services/notifications/notifeeService');
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
      expect(mockDisplay.mock.calls.at(-1)![0].id).toBe('ft-ft-retry');
    });
  });
});

describe('cancel helpers', () => {
  it('cancelForChat cancels by chatGuid', async () => {
    await cancelForChat('chat-3');
    expect(mockCancel).toHaveBeenCalledWith('chat-3');
  });

  it('cancelReminderNotification cancels the trigger by id', async () => {
    await cancelReminderNotification('reminder-abc');
    expect(mockCancelTrigger).toHaveBeenCalledWith('reminder-abc');
  });

  it('clearChatNotification fires a (fire-and-forget) cancel by chatGuid', () => {
    clearChatNotification('chat-4');
    expect(mockCancel).toHaveBeenCalledWith('chat-4');
  });
});
