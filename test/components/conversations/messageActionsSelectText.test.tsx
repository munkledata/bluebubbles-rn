/**
 * "Select Text" (`useMessageActions`): the long-pressed message's text opens in a selection sheet,
 * the same text Copy takes, and an unsend or edit arriving while it is open closes the sheet.
 */
import { useState } from 'react';
import { renderHook, act, waitFor } from '../support/renderWithTheme';
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

const CHAT = 'iMessage;-;+15551112222';
const rect = { x: 0, y: 0, width: 10, height: 10 };

function textMessage(overrides: Record<string, unknown> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'server-guid-1',
    text: 'The gate code is 4417',
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
    ...overrides,
  } as unknown as EnrichedMessage;
}

async function mount(initial: EnrichedMessage[]) {
  let setLive!: (next: EnrichedMessage[]) => void;
  const hook = await renderHook(() => {
    const [liveMessages, set] = useState(initial);
    setLive = set;
    return useMessageActions({ guid: CHAT, messages: liveMessages });
  });
  return { ...hook, setLive: (next: EnrichedMessage[]) => setLive(next) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useMessageActions: Select Text', () => {
  it('opens the long-pressed message’s text, and closing clears it', async () => {
    const message = textMessage();
    const { result } = await mount([message]);
    await act(async () => result.current.onLongPressMessage(message, rect));
    await act(async () => result.current.onSelectTextSelected());
    expect(result.current.textSelection?.text).toBe('The gate code is 4417');

    await act(async () => result.current.setTextSelection(null));
    expect(result.current.textSelection).toBeNull();
  });

  it('closes when the message is unsent while the sheet is open', async () => {
    const message = textMessage();
    const { result, setLive } = await mount([message]);
    await act(async () => result.current.onLongPressMessage(message, rect));
    await act(async () => result.current.onSelectTextSelected());
    // The menu closes after its action runs; the sheet must not depend on the menu's snapshot.
    await act(async () => result.current.setSelected(null));
    expect(result.current.textSelection).not.toBeNull();

    await act(async () => setLive([textMessage({ dateRetracted: 2000, retractionState: 1 })]));
    await waitFor(() => expect(result.current.textSelection).toBeNull());
  });

  it('stays open through unrelated updates, such as a new reaction', async () => {
    const message = textMessage();
    const { result, setLive } = await mount([message]);
    await act(async () => result.current.onLongPressMessage(message, rect));
    await act(async () => result.current.onSelectTextSelected());
    await act(async () => result.current.setSelected(null));
    await act(async () =>
      setLive([
        textMessage({
          reactions: [{ baseType: 'love', isFromMe: false, emoji: null, targetPart: 0 }],
        }),
      ]),
    );
    expect(result.current.textSelection?.text).toBe('The gate code is 4417');
  });

  it('does nothing for a message with no text', async () => {
    const message = textMessage({ text: '   ' });
    const { result } = await mount([message]);
    await act(async () => result.current.onLongPressMessage(message, rect));
    await act(async () => result.current.onSelectTextSelected());
    expect(result.current.textSelection).toBeNull();
  });
});
