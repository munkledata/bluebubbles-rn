/**
 * FP-006 restored message actions in `useMessageActions`: group tapbacks, emoji tapbacks, and
 * tapbacks/replies on the one remaining part above part 0. With the restored switches off the hook
 * must behave exactly as before (part 0 only, classic only).
 */
import { useState } from 'react';
import { ApiError } from '@core/api/errors';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const mockIsDevServer = jest.fn(() => false);
let mockRcsEnabled = false;
const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_CHAT_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.dGhyZWFkLTE`;
const RCS_MESSAGE_GUID = `rcs-g1.${RCS_PROVIDER_EPOCH}.bWVzc2FnZS1h`;

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/media', () => ({
  saveAttachmentsToPhotos: jest.fn(),
  shareAttachment: jest.fn(),
}));
jest.mock('@/services/notifications/remindersService', () => ({
  scheduleMessageReminder: jest.fn(),
}));
jest.mock('@features/conversations/devSeed', () => ({
  devSendFakeReaction: jest.fn(),
  devUnsendFake: jest.fn(),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));
jest.mock('@state/sessionStore', () => ({
  useRcsEnabled: () => mockRcsEnabled,
  useRcsMutationEnabled: () => mockRcsEnabled,
}));
jest.mock('@ui/conversations/pickReminderTime', () => ({ pickReminderTime: jest.fn() }));
jest.mock('@/services/send', () => ({
  checkUnsend: jest.fn(),
  discardMessage: jest.fn(async () => {}),
  react: jest.fn().mockResolvedValue(null),
  unsend: jest.fn(),
}));
jest.mock('@/services/remoteMessageDeleteUiService', () => ({
  deleteMessageFromMac: jest.fn(),
}));

interface DialogButton {
  text: string;
  style?: string;
  onPress?: () => void;
}
const dialogs: Array<{ title: string; body: string | undefined; buttons: DialogButton[] }> = [];
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: jest.fn((title: string, body?: string, buttons?: DialogButton[]) => {
    dialogs.push({ title, body, buttons: buttons ?? [] });
  }),
}));

// eslint-disable-next-line import/first
import { useMessageActions } from '@features/conversations/useMessageActions';
// eslint-disable-next-line import/first
import { checkUnsend, discardMessage, react, unsend } from '@/services/send';
// eslint-disable-next-line import/first
import { deleteMessageFromMac } from '@/services/remoteMessageDeleteUiService';
// eslint-disable-next-line import/first
import { devSendFakeReaction } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { scheduleMessageReminder } from '@/services/notifications/remindersService';
// eslint-disable-next-line import/first
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
// eslint-disable-next-line import/first
import { ReminderUnavailableError } from '@/services/notifications/reminderErrors';

const GROUP = 'any;+;chat-1234';
const rect = { x: 0, y: 0, width: 10, height: 10 };

const partMessage = (index: number): EnrichedMessage =>
  ({
    id: 1,
    guid: 'server-guid-1',
    text: 'caption',
    isFromMe: 0,
    sendState: null,
    error: 0,
    dateCreated: 1000,
    dateDelivered: null,
    dateRead: null,
    dateEdited: null,
    dateRetracted: null,
    senderName: 'Ann',
    senderService: 'iMessage',
    messageSummaryInfo: null,
    threadOriginatorGuid: null,
    hasAttachments: 0,
    attachments: [],
    reactions: [],
    messagePartTopology: JSON.stringify({
      complete: true,
      originalPartIndexes: [0, 1],
      currentParts: [{ index, kind: 'text' }],
      attachmentOwnership: [],
    }),
  }) as unknown as EnrichedMessage;

interface Flags {
  reactions?: boolean;
  emoji?: boolean;
  partReactions?: boolean;
  replies?: boolean;
  partReplies?: boolean;
}

async function mount(messages: EnrichedMessage[], flags: Flags) {
  const setReplyTo = jest.fn();
  const hook = await renderHook(() => {
    const [liveMessages] = useState(messages);
    return useMessageActions({
      guid: GROUP,
      messages: liveMessages,
      imessageReactionsAvailable: flags.reactions,
      imessageEmojiReactionsAvailable: flags.emoji,
      imessagePartReactionsAvailable: flags.partReactions,
      imessageRepliesAvailable: flags.replies,
      imessagePartRepliesAvailable: flags.partReplies,
      setReplyTo,
    });
  });
  return { ...hook, setReplyTo };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevServer.mockReturnValue(false);
  mockRcsEnabled = false;
  dialogs.length = 0;
});

describe('useMessageActions FP-006 restored actions', () => {
  it('keeps part-0-only classic tapbacks and replies while the part and emoji flags are off', async () => {
    const target = partMessage(1);
    const { result, setReplyTo } = await mount([target], { reactions: true, replies: true });

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.canReact).toBe(false);
    expect(result.current.selected?.canUseEmojiReactions).toBe(false);
    expect(result.current.selected?.replyPartIndex).toBeUndefined();
    await act(async () => result.current.onReact('love'));
    await act(async () => result.current.onSwipeReply?.(target));
    expect(react).not.toHaveBeenCalled();
    expect(setReplyTo).not.toHaveBeenCalled();
  });

  it('targets the remaining part 1 for a tapback and a reply when the part flags are on', async () => {
    const target = partMessage(1);
    const { result, setReplyTo } = await mount([target], {
      reactions: true,
      partReactions: true,
      replies: true,
      partReplies: true,
    });

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.canReact).toBe(true);
    expect(result.current.selected?.replyPartIndex).toBe(1);
    await act(async () => result.current.onReact('like'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: GROUP,
        targetGuid: 'server-guid-1',
        reaction: 'like',
        partIndex: 1,
      }),
      expect.anything(),
      expect.anything(),
    );
    await act(async () => result.current.onReplyToSelected?.());
    expect(setReplyTo).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'server-guid-1', targetPartIndex: 1 }),
    );
  });

  it('sends an emoji tapback only while the emoji flag is on', async () => {
    const target = partMessage(0);
    const off = await mount([target], { reactions: true });
    await act(async () => off.result.current.onLongPressMessage(target, rect));
    expect(off.result.current.selected?.canUseEmojiReactions).toBe(false);
    await act(async () => off.result.current.onReact('emoji', '🎉'));
    expect(react).not.toHaveBeenCalled();

    const on = await mount([target], { reactions: true, emoji: true });
    await act(async () => on.result.current.onLongPressMessage(target, rect));
    expect(on.result.current.selected?.canUseEmojiReactions).toBe(true);
    await act(async () => on.result.current.onReact('emoji', '🎉'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: 'emoji', emoji: '🎉', partIndex: 0 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    [
      'a restored invalid target',
      400,
      'imessage_restored_send_invalid_target',
      'Reaction not sent',
    ],
    ['a reviewed invalid target', 400, 'imessage_reaction_invalid_target', 'Reaction not sent'],
    [
      'a helper outcome unknown',
      409,
      'imessage_restored_send_outcome_unknown',
      'Reaction not confirmed',
    ],
    [
      'a retry-ledger outcome unknown',
      500,
      'idempotency_outcome_unknown',
      'Reaction not confirmed',
    ],
  ])(
    'a group tapback answered with %s says so and is not sent again',
    async (_label, status, type, title) => {
      (react as jest.Mock).mockRejectedValueOnce(
        ApiError.fromStatus(status, 'tapback failed', undefined, type),
      );
      const target = partMessage(0);
      const hook = await mount([target], { reactions: true });
      await act(async () => hook.result.current.onLongPressMessage(target, rect));
      await act(async () => hook.result.current.onReact('love'));

      await waitFor(() => expect(dialogs).toHaveLength(1));
      expect(dialogs[0]?.title).toBe(title);
      expect(dialogs[0]?.body).toBe(
        title === 'Reaction not sent'
          ? 'The server refused this reaction. It was not sent.'
          : 'It may have sent. Check the conversation before trying again.',
      );
      expect(react).toHaveBeenCalledTimes(1);
    },
  );
});
