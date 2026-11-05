/**
 * Tapbacks and replies on the exact part a long-press landed on (a photo or its caption) in
 * `useMessageActions`. A part above 0 still needs the restored part switches; with no pressed part
 * the whole-message rules stay exactly as before.
 */
import { useState } from 'react';
import { renderHook, act } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import type { MessagePressTarget } from '@features/conversations/messageActionEligibility';

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
jest.mock('@utils/isDev', () => ({ isDevServer: () => false }));
jest.mock('@state/sessionStore', () => ({
  useRcsEnabled: () => false,
  useRcsMutationEnabled: () => false,
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
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

// eslint-disable-next-line import/first
import { useMessageActions } from '@features/conversations/useMessageActions';
// eslint-disable-next-line import/first
import { react } from '@/services/send';

const CHAT = 'iMessage;-;+15550001111';
const PHOTO = 'att-photo';
const rect = { x: 0, y: 0, width: 10, height: 10 };
const PHOTO_PRESS: MessagePressTarget = { kind: 'attachment', attachmentGuid: PHOTO };
const CAPTION_PRESS: MessagePressTarget = { kind: 'body' };

/** A received photo (part 0) with its caption (part 1). */
function photoWithCaption(reactions: EnrichedMessage['reactions'] = []): EnrichedMessage {
  return {
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
    hasAttachments: 1,
    attachments: [{ guid: PHOTO, mimeType: 'image/jpeg', localPath: null }],
    reactions,
    messagePartTopology: JSON.stringify({
      complete: true,
      originalPartIndexes: [0, 1],
      currentParts: [
        { index: 0, kind: 'attachment', attachmentGuids: [PHOTO] },
        { index: 1, kind: 'text' },
      ],
      attachmentOwnership: [{ attachmentGuid: PHOTO, partIndex: 0 }],
    }),
  } as unknown as EnrichedMessage;
}

interface Flags {
  partReactions?: boolean;
  partReplies?: boolean;
}

async function mount(messages: EnrichedMessage[], flags: Flags) {
  const setReplyTo = jest.fn();
  const hook = await renderHook(() => {
    const [liveMessages] = useState(messages);
    return useMessageActions({
      guid: CHAT,
      messages: liveMessages,
      imessageReactionsAvailable: true,
      imessageEmojiReactionsAvailable: false,
      imessagePartReactionsAvailable: flags.partReactions,
      imessageRepliesAvailable: true,
      imessagePartRepliesAvailable: flags.partReplies,
      setReplyTo,
    });
  });
  return { ...hook, setReplyTo };
}

function sentPartIndex(): unknown {
  return (react as jest.Mock).mock.calls.at(-1)?.[0]?.partIndex;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useMessageActions: tapbacks and replies on the pressed part', () => {
  it('targets the pressed photo (part 0) even with the restored part switches off', async () => {
    const target = photoWithCaption();
    const { result, setReplyTo } = await mount([target], {});

    await act(async () => result.current.onLongPressMessage(target, rect, PHOTO_PRESS));
    expect(result.current.selected?.canReact).toBe(true);
    expect(result.current.selected?.replyPartIndex).toBe(0);
    expect(result.current.selected?.pressedPartIndex).toBe(0);

    await act(async () => result.current.onReact('love'));
    expect(react).toHaveBeenCalledTimes(1);
    expect(sentPartIndex()).toBe(0);
    await act(async () => result.current.onReplyToSelected?.());
    expect(setReplyTo).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'server-guid-1', targetPartIndex: 0 }),
    );
  });

  it('targets the pressed caption (part 1) only while the restored part switches are on', async () => {
    const target = photoWithCaption();
    const off = await mount([target], {});
    await act(async () => off.result.current.onLongPressMessage(target, rect, CAPTION_PRESS));
    expect(off.result.current.selected?.canReact).toBe(false);
    expect(off.result.current.selected?.replyPartIndex).toBeUndefined();
    await act(async () => off.result.current.onReact('like'));
    await act(async () => off.result.current.onReplyToSelected?.());
    expect(react).not.toHaveBeenCalled();
    expect(off.setReplyTo).not.toHaveBeenCalled();

    const on = await mount([target], { partReactions: true, partReplies: true });
    await act(async () => on.result.current.onLongPressMessage(target, rect, CAPTION_PRESS));
    expect(on.result.current.selected?.canReact).toBe(true);
    expect(on.result.current.selected?.replyPartIndex).toBe(1);
    await act(async () => on.result.current.onReact('like'));
    expect(sentPartIndex()).toBe(1);
    await act(async () => on.result.current.onReplyToSelected?.());
    expect(on.setReplyTo).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'server-guid-1', targetPartIndex: 1 }),
    );
  });

  it("counts only the pressed part's own tapbacks as yours", async () => {
    const lovedPhoto = photoWithCaption([
      {
        targetGuid: 'server-guid-1',
        targetPart: 0,
        baseType: 'love',
        emoji: null,
        isFromMe: 1,
        senderName: null,
        dateCreated: 2000,
      },
    ]);
    const { result } = await mount([lovedPhoto], { partReactions: true, partReplies: true });

    await act(async () => result.current.onLongPressMessage(lovedPhoto, rect, CAPTION_PRESS));
    // The heart is on the photo, so on the caption a heart is a new tapback, not a removal.
    expect(result.current.selected?.mine).toEqual([]);

    await act(async () => result.current.onLongPressMessage(lovedPhoto, rect, PHOTO_PRESS));
    expect(result.current.selected?.mine).toEqual(['love']);
    await act(async () => result.current.onReact('-love'));
    expect(sentPartIndex()).toBe(0);
  });

  it('keeps the whole-message rules when the bubble reports no part', async () => {
    const target = photoWithCaption();
    const { result } = await mount([target], { partReactions: true, partReplies: true });

    await act(async () => result.current.onLongPressMessage(target, rect));
    // As before this change: no tapback on a several-part message, and replies go to part 0.
    expect(result.current.selected?.canReact).toBe(false);
    expect(result.current.selected?.replyPartIndex).toBe(0);
    expect(result.current.selected?.pressedPartIndex).toBeUndefined();
    await act(async () => result.current.onReact('love'));
    expect(react).not.toHaveBeenCalled();
  });
});
