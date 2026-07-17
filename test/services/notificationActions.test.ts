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
import { getDatabase } from '@db/database';
import { deleteReminderByNotificationId } from '@db/repositories';
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
import { handleNotificationAction, handleNotificationPress } from '@/services/notifications/actions';

// notifee: the shared stub isn't a jest.fn, so mock it here to spy on cancelNotification.
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: { cancelNotification: jest.fn(async () => undefined) },
}));
// A sentinel DB handle so we can prove ensureDatabase()'s value is threaded to the writes.
// Must be `mock`-prefixed — jest.mock factories are hoisted and may only reference such vars.
const mockDb = { __db: true };
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
jest.mock('@/services/send/sendService', () => ({
  sendTextMessage: jest.fn(async () => undefined),
}));
jest.mock('@/services/send/sendReactionService', () => ({
  sendReactionMessage: jest.fn(async () => undefined),
}));
jest.mock('@db/repositories', () => ({
  deleteReminderByNotificationId: jest.fn(async () => undefined),
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

describe('handleNotificationAction — reply', () => {
  it('sends the trimmed inline reply through the outgoing send + clears the chat notif', async () => {
    await handleNotificationAction(
      chatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: '  hi there  ' }),
    );
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith(mockDb, expect.anything(), {
      chatGuid: 'c1',
      text: 'hi there',
    });
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c1');
  });

  it('does NOT send for an empty / whitespace-only reply, but still clears the notif', async () => {
    await handleNotificationAction(chatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: '   ' }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c1');
  });

  it('does NOT send when there is no input at all', async () => {
    await handleNotificationAction(chatDetail(ACTION_REPLY, { chatGuid: 'c1' }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c1');
  });

  it('opens the DB via the LAZY ensureDatabase(), never getDatabase() (headless safety)', async () => {
    await handleNotificationAction(chatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: 'yo' }));
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('DEV: routes the reply through devSendFake, not the real send path', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(chatDetail(ACTION_REPLY, { chatGuid: 'c1' }, { input: 'yo' }));
    expect(mockDevSendFake).toHaveBeenCalledWith('c1', 'yo');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockEnsureDatabase).not.toHaveBeenCalled(); // dev short-circuits before the DB open
  });
});

describe('handleNotificationAction — mark-read', () => {
  it('advances the read marker and clears the chat notif', async () => {
    await handleNotificationAction(chatDetail(ACTION_MARK_READ, { chatGuid: 'c9' }));
    expect(mockMarkRead).toHaveBeenCalledWith('c9');
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c9');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });
});

describe('handleNotificationAction — love (tapback)', () => {
  it('sends a love reaction for the notification message, then clears the notif', async () => {
    await handleNotificationAction(chatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }));
    expect(mockSendReaction).toHaveBeenCalledWith(mockDb, expect.anything(), {
      chatGuid: 'c2',
      targetGuid: 'm2',
      reaction: 'love',
    });
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c2');
  });

  it('does nothing to react when the intent carried no messageGuid, but still clears', async () => {
    await handleNotificationAction(chatDetail(ACTION_LOVE, { chatGuid: 'c2' }));
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('c2');
  });

  it('DEV: routes the reaction through devSendFakeReaction', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(chatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }));
    expect(mockDevSendFakeReaction).toHaveBeenCalledWith('c2', 'm2', 'love');
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('love uses ensureDatabase(), never getDatabase()', async () => {
    await handleNotificationAction(chatDetail(ACTION_LOVE, { chatGuid: 'c2', messageGuid: 'm2' }));
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});

describe('handleNotificationPress — reminder body tap (EventType.PRESS)', () => {
  // A reminder's main pressAction fires EventType.PRESS (a body tap), not ACTION_PRESS — so the
  // cleanup lives in handleNotificationPress, invoked from the foreground/background PRESS paths
  // + the cold-start getInitialNotification. handleNotificationAction (ACTION_PRESS only) does NOT.
  it('deletes the reminder row by notification id, opening the DB via ensureDatabase()', async () => {
    await handleNotificationPress(
      chatDetail(PRESS_REMINDER, { chatGuid: 'c3' }, { id: 'reminder-m3-5000' }),
    );
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockDeleteReminder).toHaveBeenCalledWith(mockDb, 'reminder-m3-5000');
    // A reminder tap doesn't cancel a chat notification (navigation is done separately).
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });

  it('does nothing when the reminder notification has no id', async () => {
    await handleNotificationPress(chatDetail(PRESS_REMINDER, { chatGuid: 'c3' }));
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

  it('does nothing when the notification carries no chatGuid and no faceTimeUuid', async () => {
    await handleNotificationAction(chatDetail(ACTION_MARK_READ, {}));
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).not.toHaveBeenCalled();
  });
});

describe('handleNotificationAction — FaceTime answer/decline', () => {
  it('decline just clears the ringing notification (ft-<uuid>), no server call', async () => {
    await handleNotificationAction(chatDetail(ACTION_DECLINE_FACETIME, { faceTimeUuid: 'u1' }));
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u1');
    expect(mockAnswerFaceTime).not.toHaveBeenCalled();
    expect(mockLinkingOpen).not.toHaveBeenCalled();
  });

  it('answer asks the server to answer, mints a link, opens it, and clears the notif', async () => {
    mockCreateFaceTimeLink.mockResolvedValueOnce('https://facetime.apple.com/join#k=abc');
    await handleNotificationAction(chatDetail(ACTION_ANSWER_FACETIME, { faceTimeUuid: 'u2' }));
    expect(mockAnswerFaceTime).toHaveBeenCalledWith(expect.anything(), 'u2');
    expect(mockCreateFaceTimeLink).toHaveBeenCalled();
    expect(mockLinkingOpen).toHaveBeenCalledWith('https://facetime.apple.com/join#k=abc');
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u2');
  });

  it('answer REJECTS a non-FaceTime link from a compromised server (never openURL), still clears', async () => {
    // A malicious/compromised server returns an arbitrary scheme — must NOT be opened.
    mockCreateFaceTimeLink.mockResolvedValueOnce('intent://evil#Intent;end');
    await handleNotificationAction(chatDetail(ACTION_ANSWER_FACETIME, { faceTimeUuid: 'u3' }));
    expect(mockLinkingOpen).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u3'); // finally-dismiss still runs
  });

  it('answer swallows a server error and still clears the ringing notif', async () => {
    mockAnswerFaceTime.mockRejectedValueOnce(new Error('server down'));
    await expect(
      handleNotificationAction(chatDetail(ACTION_ANSWER_FACETIME, { faceTimeUuid: 'u4' })),
    ).resolves.toBeUndefined();
    expect(mockLinkingOpen).not.toHaveBeenCalled();
    expect(mockNotifeeCancel).toHaveBeenCalledWith('ft-u4');
  });

  it('DEV: answer skips the server and opens a stub FaceTime link', async () => {
    mockIsDevServer.mockReturnValueOnce(true);
    await handleNotificationAction(chatDetail(ACTION_ANSWER_FACETIME, { faceTimeUuid: 'uDev' }));
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
