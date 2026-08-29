/**
 * Unit tests for the notification-action handler (`src/services/notifications/actions.ts`).
 *
 * This is the code that runs when a user taps an inline notification button (Reply,
 * Mark as read, ♥ Love) or a FaceTime Answer/Decline — possibly HEADLESS (killed app,
 * no React tree, DB never opened by boot). The invariants pinned here:
 *   - each action performs the right DB write / service call and clears the chat notif;
 *   - unknown / missing actions are ignored (no side effects);
 *   - the headless-safety rule (AGENTS.md): background handlers open the DB via the LAZY
 *     `ensureDatabase()`, never `getDatabase()` (which throws if boot never ran).
 *
 * Everything the handler talks to is mocked at the module boundary so this stays a pure
 * Node (`node` project) unit test. The ACTION and PRESS constants come from the REAL
 * `./notifeeService` module (a relative import, not mocked).
 */
import type { EventDetail } from 'react-native-notify-kit';
import notifee from 'react-native-notify-kit';
import { Linking } from 'react-native';
import { faceTimeApi } from '@core/api';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { deleteReminderByNotificationId, getMessageActionPartLayoutByGuid } from '@db/repositories';
import { isDevServer } from '@utils/isDev';
import { ensureDatabase } from '@/services/databaseControl';
import { markRead } from '@/services/chatActions';
import { sendTextMessage } from '@/services/send/sendService';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import { devSendFake, devSendFakeReaction } from '@features/conversations/devSeed';
import {
  ACTION_ANSWER_FACETIME,
  ACTION_DECLINE_FACETIME,
  ACTION_LOVE,
  ACTION_MARK_READ,
  ACTION_REPLY,
  PRESS_OPEN,
  PRESS_REMINDER,
} from '@/services/notifications/notifeeService';
import {
  handleNotificationAction,
  handleNotificationPress,
} from '@/services/notifications/actions';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

// notifee: the shared stub isn't a jest.fn, so mock it here to spy on cancelNotification.
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: { cancelNotification: jest.fn(async () => undefined) },
}));
// A sentinel DB handle so we can prove ensureDatabase()'s value is threaded to the writes.
// Must be `mock`-prefixed — jest.mock factories are hoisted and may only reference such vars.
const mockDb = { __db: true, all: jest.fn(async (_query: unknown): Promise<unknown[]> => []) };
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase: jest.fn(async () => mockDb),
}));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/chatActions', () => ({
  markRead: jest.fn(async () => undefined),
}));
// The EAGER getDatabase() (from @db/database) throws if boot never opened the DB — a headless
// action handler must never call it (AGENTS.md: use the lazy ensureDatabase()). Mock it to throw
// so any accidental eager use would blow up, then assert it's never invoked.
jest.mock('@db/database', () => ({
  getDatabase: jest.fn(() => {
    throw new Error('Database not initialized — getDatabase must not run in a headless handler');
  }),
}));
// The real `sendTextMessage` awaits its `onQueued` callback the instant the optimistic row + queue
// row are committed — the signal the action handler uses to decide the typed reply is safe to
// throw away. The mock must honour that or it tests a contract the code doesn't have.
jest.mock('@/services/send/sendService', () => ({
  sendTextMessage: jest.fn(
    async (
      _db: unknown,
      _http: unknown,
      _args: unknown,
      _now?: number,
      onQueued?: () => void | Promise<void>,
    ) => {
      await onQueued?.();
    },
  ),
}));
jest.mock('@/services/send/sendReactionService', () => ({
  sendReactionMessage: jest.fn(async () => undefined),
}));
jest.mock('@db/repositories', () => ({
  deleteReminderByNotificationId: jest.fn(async () => undefined),
  getMessageActionPartLayoutByGuid: jest.fn(async () => null),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: jest.fn(() => false) }));
jest.mock('@core/api', () => ({
  faceTimeApi: {
    answerFaceTime: jest.fn(async () => true),
    createFaceTimeLink: jest.fn(async () => 'https://facetime.apple.com/join#v=1&p=x&k=y'),
  },
}));
jest.mock('react-native', () => ({ Linking: { openURL: jest.fn(async () => undefined) } }));
jest.mock('@features/conversations/devSeed', () => ({
  devSendFake: jest.fn(async () => undefined),
  devSendFakeReaction: jest.fn(async () => undefined),
}));

const mockNotifeeCancel = notifee.cancelNotification as jest.Mock;
const mockEnsureDatabase = ensureDatabase as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockMarkRead = markRead as jest.Mock;
const mockSendText = sendTextMessage as jest.Mock;
const mockSendReaction = sendReactionMessage as jest.Mock;
const mockDeleteReminder = deleteReminderByNotificationId as jest.Mock;
const mockGetMessageActionPartLayout = getMessageActionPartLayoutByGuid as jest.Mock;
const mockIsDevServer = isDevServer as jest.Mock;
const mockLinkingOpen = Linking.openURL as jest.Mock;
const mockAnswerFaceTime = faceTimeApi.answerFaceTime as jest.Mock;
const mockCreateFaceTimeLink = faceTimeApi.createFaceTimeLink as jest.Mock;
const mockDevSendFake = devSendFake as jest.Mock;
const mockDevSendFakeReaction = devSendFakeReaction as jest.Mock;

/** Build an EventDetail with a chat-message notification carrying `data` + an action id. */
function chatDetail(
  pressActionId: string | undefined,
  data: Record<string, unknown>,
  extra: { input?: string; id?: string } = {},
): EventDetail {
  return {
    pressAction: pressActionId ? { id: pressActionId } : undefined,
    input: extra.input,
    notification: { id: extra.id, data },
  } as unknown as EventDetail;
}

const SAFE_ROUTE_TOKEN = '12345678-1234-4123-8123-123456789abc';

/** Build the schema-2 shape production writes, while seeding its encrypted local-id lookup. */
function safeChatDetail(
  pressActionId: string | undefined,
  route: { chatGuid: string; messageGuid?: string; reminder?: true; sendFailure?: true },
  extra: { input?: string; id?: string } = {},
): EventDetail {
  mockDb.all.mockResolvedValueOnce([
    { chatGuid: route.chatGuid, messageGuid: route.messageGuid ?? null },
  ]);
  const kind = route.reminder ? 'reminder' : route.sendFailure ? 'send-failure' : 'message';
  const defaultId = route.reminder
    ? 'gator-reminder-message-11-5000'
    : route.sendFailure
      ? 'gator-send-failure-11'
      : 'gator-message-7';
  return chatDetail(
    pressActionId,
    {
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: kind,
      chatId: '7',
      ...(route.messageGuid ? { messageId: '11' } : {}),
      ...(route.reminder ? { messageDate: '4000' } : {}),
    },
    { ...extra, id: extra.id ?? defaultId },
  );
}

/** Build a schema-2 call payload and seed its random-token lookup. */
function safeFaceTimeDetail(actionId: string, uuid: string): EventDetail {
  mockDb.all.mockResolvedValueOnce([{ value: uuid }]);
  return chatDetail(
    actionId,
    {
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'facetime',
      routeToken: SAFE_ROUTE_TOKEN,
    },
    { id: `gator-facetime-${SAFE_ROUTE_TOKEN}` },
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForCalls(mock: jest.Mock, count: number): Promise<void> {
  for (let turn = 0; turn < 30 && mock.mock.calls.length < count; turn += 1) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalledTimes(count);
}

afterEach(() => {
  // Race tests close admission synchronously. Always reopen it, even if an assertion fails, so the
  // next independent example cannot inherit a deliberately paused coordinator.
  resumeRealtimeDeliveries();
});

describe('handleNotificationAction — reply', () => {
  it('sends the trimmed inline reply through the outgoing send + clears the chat notif', async () => {
    await handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: '  hi there  ' }),
    );
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      { chatGuid: 'c1', text: 'hi there' },
      expect.any(Number),
      expect.any(Function), // the queue handover — see the mock
      undefined,
      expect.any(Function),
    );
    const commitGuard = mockSendText.mock.calls[0]?.[6] as (() => boolean) | undefined;
    expect(commitGuard?.()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(commitGuard?.()).toBe(false);
    resumeRealtimeDeliveries();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('does NOT send for an empty / whitespace-only reply, but still clears the notif', async () => {
    await handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: '   ' }),
    );
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('does NOT send when there is no input at all', async () => {
    await handleNotificationAction(safeChatDetail(ACTION_REPLY, { chatGuid: 'c1' }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('opens the DB via the LAZY ensureDatabase(), never getDatabase() (headless safety)', async () => {
    await handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: 'yo' }),
    );
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(2);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('DEV: routes the reply through devSendFake, not the real send path', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: 'yo' }),
    );
    expect(mockDevSendFake).toHaveBeenCalledWith(
      'c1',
      'yo',
      undefined,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockSendText).not.toHaveBeenCalled();
    // Schema-2 route resolution opens the DB; the dev send path itself does not open it again.
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
  });

  it('keeps a later notification reaction behind an unsettled inline reply', async () => {
    const replyResult = deferred<void>();
    mockSendText.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[4] as (() => void | Promise<void>) | undefined)?.();
      await replyResult.promise;
    });

    const replyAction = handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'ordered-chat' }, { input: 'first' }),
    );
    await waitForCalls(mockSendText, 1);
    const loveAction = handleNotificationAction(
      safeChatDetail(ACTION_LOVE, {
        chatGuid: 'ordered-chat',
        messageGuid: 'ordered-message',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendReaction).not.toHaveBeenCalled();

    replyResult.resolve(undefined);
    await replyAction;
    await waitForCalls(mockSendReaction, 1);
    await loveAction;
  });
});

describe('handleNotificationAction — mark-read', () => {
  it('advances the read marker and clears the chat notif', async () => {
    await handleNotificationAction(safeChatDetail(ACTION_MARK_READ, { chatGuid: 'c9' }));
    expect(mockMarkRead).toHaveBeenCalledWith(
      'c9',
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });
});

describe('handleNotificationAction — love (tapback)', () => {
  it('sends a love reaction for the notification message, then clears the notif', async () => {
    mockGetMessageActionPartLayout.mockResolvedValueOnce({
      text: 'caption',
      attributedBody: null,
      partCount: 3,
      visibleAttachmentCount: 2,
    });
    await handleNotificationAction(
      safeChatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }),
    );
    expect(mockSendReaction).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      {
        chatGuid: 'c2',
        targetGuid: 'm2',
        reaction: 'love',
        partIndex: 2,
      },
      expect.any(Number),
      expect.any(Function),
    );
    const commitGuard = mockSendReaction.mock.calls[0]?.[4] as (() => boolean) | undefined;
    expect(commitGuard?.()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(commitGuard?.()).toBe(false);
    resumeRealtimeDeliveries();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('does nothing to react when the intent carried no messageGuid, but still clears', async () => {
    await handleNotificationAction(safeChatDetail(ACTION_LOVE, { chatGuid: 'c2' }));
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('DEV: routes the reaction through devSendFakeReaction', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(
      safeChatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }),
    );
    expect(mockDevSendFakeReaction).toHaveBeenCalledWith(
      'c2',
      'm2',
      'love',
      undefined,
      0,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('love uses ensureDatabase(), never getDatabase()', async () => {
    await handleNotificationAction(
      safeChatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }),
    );
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(2);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});

describe('handleNotificationPress — reminder body tap (EventType.PRESS)', () => {
  // A reminder's main pressAction fires EventType.PRESS (a body tap), not ACTION_PRESS — so the
  // cleanup lives in handleNotificationPress, invoked from the foreground/background PRESS paths
  // + the cold-start getInitialNotification. handleNotificationAction (ACTION_PRESS only) does NOT.
  it('deletes the reminder row by notification id, opening the DB via ensureDatabase()', async () => {
    await handleNotificationPress(
      safeChatDetail(PRESS_REMINDER, { chatGuid: 'c3', messageGuid: 'm3', reminder: true }),
    );
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(2);
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockDeleteReminder).toHaveBeenCalledWith(
      mockDb,
      'gator-reminder-message-11-5000',
      expect.any(Function),
    );
    // A reminder tap doesn't cancel a chat notification (navigation is done separately).
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('does nothing when the reminder notification has no id', async () => {
    const detail = safeChatDetail(PRESS_REMINDER, {
      chatGuid: 'c3',
      messageGuid: 'm3',
      reminder: true,
    });
    if (detail.notification) detail.notification.id = undefined;
    await handleNotificationPress(detail);
    expect(mockDeleteReminder).not.toHaveBeenCalled();
  });

  it('ignores a non-reminder press (open-chat body tap) — no reminder delete', async () => {
    await handleNotificationPress(chatDetail(PRESS_OPEN, { chatGuid: 'c3' }, { id: 'c3' }));
    expect(mockDeleteReminder).not.toHaveBeenCalled();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
  });

  it('handleNotificationAction (ACTION_PRESS path) does NOT handle a reminder press', async () => {
    await handleNotificationAction(
      chatDetail(PRESS_REMINDER, { chatGuid: 'c3' }, { id: 'reminder-m3-5000' }),
    );
    expect(mockDeleteReminder).not.toHaveBeenCalled();
  });
});

describe('handleNotificationAction — ignored / no-op cases', () => {
  it('does nothing for an open-chat body press (navigation is handled by the PRESS path)', async () => {
    await handleNotificationAction(chatDetail(PRESS_OPEN, { chatGuid: 'c4' }));
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockDeleteReminder).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('ignores an unknown action id', async () => {
    await handleNotificationAction(chatDetail('some-unknown-action', { chatGuid: 'c4' }));
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('keeps a failed-send notice body-only even if Android reports an inline action id', async () => {
    await handleNotificationAction(
      chatDetail(
        ACTION_REPLY,
        {
          gatorOwner: 'gator',
          gatorSchema: '2',
          gatorKind: 'send-failure',
          chatId: '7',
          messageId: '11',
        },
        { id: 'gator-send-failure-11', input: 'PRIVATE_INLINE_REPLY_CANARY' },
      ),
    );

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('does nothing when the notification carries no chatGuid and no faceTimeUuid', async () => {
    await handleNotificationAction(chatDetail(ACTION_MARK_READ, {}));
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('contains a safe-route DB-open failure and leaves the notification for retry', async () => {
    const failure = new Error('encrypted DB unavailable');
    mockEnsureDatabase.mockRejectedValueOnce(failure);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      handleNotificationAction(
        chatDetail(
          ACTION_MARK_READ,
          { gatorOwner: 'gator', gatorSchema: '2', gatorKind: 'message', chatId: '7' },
          { id: 'gator-message-7' },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[notif] action route could not be resolved', failure);
  });
});

describe('handleNotificationAction — a failing action still clears the tray', () => {
  // Headlessly there is no other feedback: if a throw escapes, the notification just sits there
  // and the button reads as completely dead (the killed-app "Mark as read" symptom). The work is
  // wrapped so the cancel always runs and the failure is at least logged.
  it('swallows a throwing mark-read and cancels the notification anyway', async () => {
    mockMarkRead.mockRejectedValueOnce(new Error('Database not initialized'));
    await expect(
      handleNotificationAction(safeChatDetail(ACTION_MARK_READ, { chatGuid: 'c7' })),
    ).resolves.toBeUndefined();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  // …with ONE exception. A reply carries text the user AUTHORED and that exists nowhere else —
  // Android's RemoteInput does not re-populate the field — so the tray may only be cleared once
  // the outgoing queue owns delivery. The handover callback is the signal.
  it('KEEPS the notification when a reply throws before it was ever enqueued', async () => {
    // Nothing durable was written (a failed first DB open on a headless wake, an unknown chat
    // guid), so nothing will ever retry. Clearing the tray here destroys the typed message.
    mockSendText.mockRejectedValueOnce(new Error('Database not initialized'));
    await expect(
      handleNotificationAction(safeChatDetail(ACTION_REPLY, { chatGuid: 'c8' }, { input: 'yo' })),
    ).resolves.toBeUndefined();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('clears the notification when a reply throws AFTER the queue took it', async () => {
    // The reply is on its way; leaving the notification up would invite sending it twice.
    mockSendText.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[4] as () => Promise<void> | void)?.();
      throw new Error('boom after enqueue');
    });
    await expect(
      handleNotificationAction(safeChatDetail(ACTION_REPLY, { chatGuid: 'c8b' }, { input: 'yo' })),
    ).resolves.toBeUndefined();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });

  it('swallows a throwing love reaction and cancels the notification anyway', async () => {
    mockSendReaction.mockRejectedValueOnce(new Error('boom'));
    await expect(
      handleNotificationAction(safeChatDetail(ACTION_LOVE, { chatGuid: 'c9', messageGuid: 'm9' })),
    ).resolves.toBeUndefined();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });
});

describe('handleNotificationAction — FaceTime answer/decline', () => {
  it('decline just clears the ringing notification (ft-<uuid>), no server call', async () => {
    await handleNotificationAction(safeFaceTimeDetail(ACTION_DECLINE_FACETIME, 'u1'));
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u1');
    expect(mockAnswerFaceTime).not.toHaveBeenCalled();
    expect(mockLinkingOpen).not.toHaveBeenCalled();
  });

  it('answer asks the server to answer, mints a link, opens it, and clears the notif', async () => {
    mockCreateFaceTimeLink.mockResolvedValueOnce('https://facetime.apple.com/join#k=abc');
    await handleNotificationAction(safeFaceTimeDetail(ACTION_ANSWER_FACETIME, 'u2'));
    expect(mockAnswerFaceTime).toHaveBeenCalledWith(expect.anything(), 'u2');
    expect(mockCreateFaceTimeLink).toHaveBeenCalled();
    expect(mockLinkingOpen).toHaveBeenCalledWith('https://facetime.apple.com/join#k=abc');
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u2');
  });

  it('answer REJECTS a non-FaceTime link from a compromised server (never openURL), still clears', async () => {
    // A malicious/compromised server returns an arbitrary scheme — must NOT be opened.
    mockCreateFaceTimeLink.mockResolvedValueOnce('intent://evil#Intent;end');
    await handleNotificationAction(safeFaceTimeDetail(ACTION_ANSWER_FACETIME, 'u3'));
    expect(mockLinkingOpen).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u3'); // finally-dismiss still runs
  });

  it('answer swallows a server error and still clears the ringing notif', async () => {
    mockAnswerFaceTime.mockRejectedValueOnce(new Error('server down'));
    await expect(
      handleNotificationAction(safeFaceTimeDetail(ACTION_ANSWER_FACETIME, 'u4')),
    ).resolves.toBeUndefined();
    expect(mockLinkingOpen).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u4');
  });

  it('DEV: answer skips the server and opens a stub FaceTime link', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(safeFaceTimeDetail(ACTION_ANSWER_FACETIME, 'uDev'));
    expect(mockAnswerFaceTime).not.toHaveBeenCalled();
    expect(mockLinkingOpen).toHaveBeenCalledTimes(1);
    expect(mockLinkingOpen.mock.calls[0]![0]).toContain('facetime.apple.com');
    expect(mockLinkingOpen.mock.calls[0]![0]).toContain('uDev');
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-uDev');
  });

  it('an unknown FaceTime action id is a no-op (no dismiss, no server call)', async () => {
    await handleNotificationAction(chatDetail('facetime-unknown', { faceTimeUuid: 'u5' }));
    expect(mockAnswerFaceTime).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
    // FaceTime branch returns early — a chat action never runs even if chatGuid were present.
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});

describe('notification actions — account-switch containment', () => {
  it('keeps legacy raw payloads navigation-compatible but action-inert', async () => {
    // `notificationOpen.ts` still resolves this old format for a best-effort body-tap deep link.
    // It has no account owner, though, so this action boundary must never trust it for mutations.
    await handleNotificationAction(
      chatDetail(ACTION_REPLY, { chatGuid: 'legacy-chat' }, { input: 'do not send' }),
    );
    await handleNotificationAction(chatDetail(ACTION_MARK_READ, { chatGuid: 'legacy-chat' }));
    await handleNotificationAction(
      chatDetail(ACTION_LOVE, { chatGuid: 'legacy-chat', messageGuid: 'legacy-message' }),
    );
    await handleNotificationAction(
      chatDetail(ACTION_ANSWER_FACETIME, { faceTimeUuid: 'legacy-call' }),
    );
    await handleNotificationPress(
      chatDetail(
        PRESS_REMINDER,
        { chatGuid: 'legacy-chat', reminder: '1' },
        { id: 'reminder-legacy-message-5000' },
      ),
    );

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockAnswerFaceTime).not.toHaveBeenCalled();
    expect(mockDeleteReminder).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('stashes only a schema-2 body press that resolves in the current encrypted DB', async () => {
    const stash = jest.fn();
    const safe = safeChatDetail(PRESS_OPEN, { chatGuid: 'current-chat' });

    await handleNotificationPress(safe, stash);
    await handleNotificationPress(
      chatDetail(PRESS_OPEN, { chatGuid: 'ambiguous-legacy-chat' }),
      stash,
    );

    expect(stash).toHaveBeenCalledTimes(1);
    expect(stash).toHaveBeenCalledWith(safe.notification?.data);
  });

  it('admits a schema-2 failed-send body tap using only its opaque local route', async () => {
    const stash = jest.fn();
    const safe = safeChatDetail(
      PRESS_OPEN,
      {
        chatGuid: 'private-server-chat-guid',
        messageGuid: 'private-server-message-guid',
        sendFailure: true,
      },
      { id: 'gator-send-failure-11' },
    );

    await handleNotificationPress(safe, stash);

    expect(stash).toHaveBeenCalledTimes(1);
    expect(stash).toHaveBeenCalledWith(safe.notification?.data);
    expect(JSON.stringify(safe.notification?.data)).not.toMatch(
      /private-server-chat-guid|private-server-message-guid/,
    );
    expect(mockDeleteReminder).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('does not send an inline reply through B when A is retired during the DB open', async () => {
    const database = deferred<typeof mockDb>();
    mockEnsureDatabase.mockResolvedValueOnce(mockDb).mockReturnValueOnce(database.promise);
    const action = handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'account-a-chat' }, { input: 'hello from A' }),
    );
    await waitForCalls(mockEnsureDatabase, 2);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    database.resolve(mockDb);
    await Promise.all([action, drain]);
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('does not send a reaction through B when A is retired during the DB open', async () => {
    const database = deferred<typeof mockDb>();
    mockEnsureDatabase.mockResolvedValueOnce(mockDb).mockReturnValueOnce(database.promise);
    const action = handleNotificationAction(
      safeChatDetail(ACTION_LOVE, {
        chatGuid: 'account-a-chat',
        messageGuid: 'account-a-message',
      }),
    );
    await waitForCalls(mockEnsureDatabase, 2);

    const drain = pauseRealtimeDeliveries();
    database.resolve(mockDb);
    await Promise.all([action, drain]);

    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it("drains a started mark-read and never lets its late completion clear B's tray", async () => {
    const marking = deferred<void>();
    mockMarkRead.mockReturnValueOnce(marking.promise);
    const action = handleNotificationAction(
      safeChatDetail(ACTION_MARK_READ, { chatGuid: 'account-a-chat' }),
    );
    await waitForCalls(mockMarkRead, 1);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    marking.resolve(undefined);
    await Promise.all([action, drain]);
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it("does not mint/open a FaceTime link or dismiss B's call after A is retired", async () => {
    const answering = deferred<unknown>();
    mockAnswerFaceTime.mockReturnValueOnce(answering.promise);
    const action = handleNotificationAction(
      safeFaceTimeDetail(ACTION_ANSWER_FACETIME, 'account-a-call'),
    );
    await waitForCalls(mockAnswerFaceTime, 1);

    const drain = pauseRealtimeDeliveries();
    answering.resolve(true);
    await Promise.all([action, drain]);

    expect(mockCreateFaceTimeLink).not.toHaveBeenCalled();
    expect(mockLinkingOpen).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('does not delete a reminder from B when A is retired during the headless DB open', async () => {
    const database = deferred<typeof mockDb>();
    mockEnsureDatabase.mockResolvedValueOnce(mockDb).mockReturnValueOnce(database.promise);
    const press = handleNotificationPress(
      safeChatDetail(PRESS_REMINDER, {
        chatGuid: 'account-a-chat',
        messageGuid: 'account-a-message',
        reminder: true,
      }),
    );
    await waitForCalls(mockEnsureDatabase, 2);

    const drain = pauseRealtimeDeliveries();
    database.resolve(mockDb);
    await Promise.all([press, drain]);
    expect(mockDeleteReminder).not.toHaveBeenCalled();
  });

  it('passes the original account guard into an admitted reminder delete', async () => {
    const deleting = deferred<void>();
    let capturedGuard: (() => boolean) | undefined;
    mockDeleteReminder.mockImplementationOnce(
      async (_db: unknown, _notificationId: string, commitGuard?: () => boolean) => {
        capturedGuard = commitGuard;
        await deleting.promise;
        if (commitGuard?.() === false) throw new Error('stale reminder delete rejected');
      },
    );
    const press = handleNotificationPress(
      safeChatDetail(PRESS_REMINDER, {
        chatGuid: 'account-a-chat',
        messageGuid: 'account-a-message',
        reminder: true,
      }),
    );
    await waitForCalls(mockDeleteReminder, 1);
    const currentBeforePause = capturedGuard?.();

    const drain = pauseRealtimeDeliveries();
    const currentAfterPause = capturedGuard?.();
    deleting.resolve(undefined);

    await Promise.all([press, drain]);
    expect(currentBeforePause).toBe(true);
    expect(currentAfterPause).toBe(false);
  });

  it('does not stash a late A body press after its route lookup crosses Disconnect', async () => {
    const database = deferred<typeof mockDb>();
    mockEnsureDatabase.mockReturnValueOnce(database.promise);
    const stash = jest.fn();
    const press = handleNotificationPress(
      safeChatDetail(PRESS_OPEN, { chatGuid: 'account-a-chat' }),
      stash,
    );
    await waitForCalls(mockEnsureDatabase, 1);

    const drain = pauseRealtimeDeliveries();
    database.resolve(mockDb);
    await Promise.all([press, drain]);
    expect(stash).not.toHaveBeenCalled();
  });

  it('keeps teardown blocked until an already-started tray cancellation settles', async () => {
    const cancellation = deferred<void>();
    mockNotifeeCancel.mockReturnValueOnce(cancellation.promise);
    const action = handleNotificationAction(
      safeChatDetail(ACTION_REPLY, { chatGuid: 'account-a-chat' }, { input: '   ' }),
    );
    await waitForCalls(mockNotifeeCancel, 1);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    cancellation.resolve(undefined);
    await Promise.all([action, drain]);
    expect(drained).toBe(true);
    expect(mockNotifeeCancel).toHaveBeenCalledWith('gator-message-7');
  });
});
