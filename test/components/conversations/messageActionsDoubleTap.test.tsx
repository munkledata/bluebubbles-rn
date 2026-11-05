/**
 * Double-tap ♥ (`useMessageActions.onDoubleTapMessage`): a double-tap loves the tapped message, the
 * next one takes your ♥ back, and the callback stays stable for the memoized rows.
 */
import { useState } from 'react';
import { renderHook, act } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
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

const CHAT = 'iMessage;-;+15551112222';
const BODY = { kind: 'body' } as const;

function textMessage(overrides: Record<string, unknown> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'server-guid-1',
    text: 'See you at 7',
    isFromMe: 0,
    sendState: null,
    error: 0,
    dateCreated: 1000,
    dateDelivered: null,
    dateRead: null,
    dateEdited: null,
    dateRetracted: null,
    senderName: 'Laura',
    senderAddress: '+15551112222',
    senderService: 'iMessage',
    messageSummaryInfo: null,
    threadOriginatorGuid: null,
    hasAttachments: 0,
    attachments: [],
    reactions: [],
    // A server-confirmed single text part: iMessage tapbacks (menu or double-tap) need this proof.
    messagePartTopology: JSON.stringify({
      complete: true,
      originalPartIndexes: [0],
      currentParts: [{ index: 0, kind: 'text' }],
      attachmentOwnership: [],
    }),
    ...overrides,
  } as unknown as EnrichedMessage;
}

function love(isFromMe: boolean) {
  return {
    guid: `love-${isFromMe ? 'me' : 'them'}`,
    baseType: 'love',
    isFromMe,
    emoji: null,
    targetPart: 0,
  };
}

async function mount(initial: EnrichedMessage[]) {
  let setLive!: (next: EnrichedMessage[]) => void;
  const hook = await renderHook(() => {
    const [liveMessages, set] = useState(initial);
    setLive = set;
    return useMessageActions({
      guid: CHAT,
      messages: liveMessages,
      imessageReactionsAvailable: true,
    });
  });
  return { ...hook, setLive: (next: EnrichedMessage[]) => setLive(next) };
}

function lastReaction(): unknown {
  return (react as jest.Mock).mock.calls.at(-1)?.[0]?.reaction;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useMessageActions: double-tap ♥', () => {
  it('loves the message, and the next double-tap takes the ♥ back', async () => {
    const message = textMessage();
    const { result, setLive } = await mount([message]);

    await act(async () => result.current.onDoubleTapMessage(message, BODY));
    expect(react).toHaveBeenCalledTimes(1);
    expect((react as jest.Mock).mock.calls[0][0]).toMatchObject({
      chatGuid: CHAT,
      targetGuid: 'server-guid-1',
      reaction: 'love',
      partIndex: 0,
    });

    // The chat now shows your ♥, so the next double-tap removes it.
    await act(async () => setLive([textMessage({ reactions: [love(true)] })]));
    await act(async () => result.current.onDoubleTapMessage(message, BODY));
    expect(react).toHaveBeenCalledTimes(2);
    expect(lastReaction()).toBe('-love');
  });

  it('does not treat someone else’s ♥ as yours', async () => {
    const message = textMessage({ reactions: [love(false)] });
    const { result } = await mount([message]);
    await act(async () => result.current.onDoubleTapMessage(message, BODY));
    expect(lastReaction()).toBe('love');
  });

  it('leaves a message that is still sending alone', async () => {
    const message = textMessage({ guid: 'temp-123' });
    const { result } = await mount([message]);
    await act(async () => result.current.onDoubleTapMessage(message, BODY));
    expect(react).not.toHaveBeenCalled();
  });

  it('keeps one callback across renders, for the memoized rows', async () => {
    const message = textMessage();
    const { result, setLive } = await mount([message]);
    const first = result.current.onDoubleTapMessage;
    await act(async () => setLive([textMessage({ text: 'edited elsewhere' })]));
    expect(result.current.onDoubleTapMessage).toBe(first);
  });
});
