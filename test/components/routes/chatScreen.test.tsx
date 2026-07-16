/**
 * ChatScreen (app/(app)/chat/[guid].tsx): the conversation route. This suite locks in the
 * SCREEN'S OWN wiring — how it maps a long-pressed message into a SelectedMessage, routes the
 * overlay/composer callbacks into the send services, drives the scheduled-message ticker, and
 * flips wallpaper chrome — while treating every child (MessageList, Composer,
 * MessageActionsOverlay, SmartReplyChips, …) as a probe (their internals are covered in their
 * own suites). The data hooks and the whole `@/services` + `@/services/send` surface are mocked
 * so assertions are about the ROUTE'S logic, not the DB/network.
 *
 * In-file mocks:
 *   - `@ui` barrel → light probes that CAPTURE the props/callbacks the screen passes (into
 *     `mockCaptured`) so a test can invoke `onLongPressMessage` / `onReact` / `onSend` directly
 *     and read back `selected` / `replyTo` / `editingText` / wallpaper insets. `useTheme`/`Screen`
 *     get trivial stubs. Mocking the barrel keeps the real (native-pulling) UI tree out.
 *   - the data hooks (`useMessages`, `useChatHeader`, `useNewScreenEffect`) + `useChatBackgroundUri`
 *     → controllable jest.fns.
 *   - `@/services` + `@/services/send` → jest.fn spies (the send/react/reply/edit/schedule wiring).
 *   - `@utils/isDev` (`isDevServer`) → forced FALSE so the screen takes the REAL service path
 *     (`react`/`reply`/`send`/`editText`/`fireDueScheduled`), not the `devSeed` fixtures — this is
 *     the path shipped to users and gives the cleaner assertions (see the ticker + react tests).
 *   - `expo-router` (fixed guid + a push spy), `expo-clipboard`/`expo-image`/`expo-media-library`,
 *     `react-native-safe-area-context` (zero insets), and the small `@ui/*` sibling modules
 *     (ChatThemeProvider, dialogStore, pickDateTime, LoadErrorBoundary) → native/inset stubs.
 *
 * The REAL `useTypingStore` (zustand) is driven via setState to exercise the typing-bubble branch.
 */
import React from 'react';
import { renderWithTheme, screen, act, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const GUID = 'iMessage;-;+15551234567';
const mockPush = jest.fn();
// Mutable so a test can hand the SAME mounted screen a new guid (reused-instance path).
let mockGuid = GUID;

/** Latest props each probe was rendered with — tests read/invoke these. */
const mockCaptured: {
  list?: Record<string, any>;
  overlay?: Record<string, any>;
  composer?: Record<string, any>;
  smartReply?: Record<string, any>;
} = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: mockGuid }),
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
}));
jest.mock('expo-image', () => {
  const R = require('react');
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => R.createElement(View, props) };
});

// The whole UI tree as prop-capturing probes (keeps the native-pulling real barrel out).
jest.mock('@ui', () => {
  const R = require('react');
  const { View, Text } = require('react-native');
  const capture = (key: 'list' | 'overlay' | 'composer' | 'smartReply') => (props: any) => {
    mockCaptured[key] = props;
    return null;
  };
  return {
    useTheme: () => ({ color: { background: '#000000' } }),
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    ConversationHeader: () => null,
    EdgeFade: () => null,
    ScreenEffectOverlay: () => null,
    TypingBubble: () => R.createElement(Text, null, 'typing…'),
    MessageList: capture('list'),
    MessageActionsOverlay: capture('overlay'),
    Composer: capture('composer'),
    SmartReplyChips: capture('smartReply'),
    ThreadSheet: () => null,
  };
});

jest.mock('@ui/theme/ChatThemeProvider', () => ({
  ChatThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useChatBackgroundUri: jest.fn(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('@ui/conversations/pickDateTime', () => ({ pickFutureDateTime: jest.fn() }));
jest.mock('@ui/LoadErrorBoundary', () => ({
  LoadErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@features/conversations/useMessages', () => ({ useMessages: jest.fn() }));
jest.mock('@features/conversations/useChatHeader', () => ({ useChatHeader: jest.fn() }));
jest.mock('@features/conversations/useNewScreenEffect', () => ({ useNewScreenEffect: jest.fn() }));
jest.mock('@features/conversations/devSeed', () => ({
  devEditFake: jest.fn(),
  devInjectEffect: jest.fn(),
  devSendFake: jest.fn(),
  devSendFakeReaction: jest.fn(),
  devSendFakeReply: jest.fn(),
  devUnsendFake: jest.fn(),
}));

// Force the REAL (non-dev) service path so the send/react/reply/edit spies below are what fires.
jest.mock('@utils/isDev', () => ({
  isDevServer: () => false,
  DEV_SERVER_ORIGIN: 'https://dev.local',
}));

jest.mock('@/services', () => ({
  dispatchRealtimeEvent: jest.fn(),
  ensureChatSynced: jest.fn(),
  ensureSyncedBackground: jest.fn(),
  http: {},
  markRead: jest.fn(),
  sendTyping: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({ clearChatNotification: jest.fn() }));
jest.mock('@/services/notifications/remindersService', () => ({ scheduleReminder: jest.fn() }));
jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));
jest.mock('@/services/send', () => ({
  cancelOutgoing: jest.fn(),
  editText: jest.fn(),
  fireDueScheduled: jest.fn(),
  react: jest.fn(),
  reply: jest.fn(),
  runDueScheduled: jest.fn(),
  schedule: jest.fn(),
  send: jest.fn(),
  sendImage: jest.fn(),
  sendImages: jest.fn(),
  unsend: jest.fn(),
}));

// eslint-disable-next-line import/first
import ChatScreen from '../../../app/(app)/chat/[guid]';
// eslint-disable-next-line import/first
import { useMessages } from '@features/conversations/useMessages';
// eslint-disable-next-line import/first
import { useChatHeader } from '@features/conversations/useChatHeader';
// eslint-disable-next-line import/first
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
// eslint-disable-next-line import/first
import { useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
// eslint-disable-next-line import/first
import { ensureChatSynced, markRead } from '@/services';
// eslint-disable-next-line import/first
import { editText, fireDueScheduled, react, reply, send } from '@/services/send';
// eslint-disable-next-line import/first
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { useTypingStore } from '@state/typingStore';

const useMessagesMock = useMessages as jest.Mock;
const useChatHeaderMock = useChatHeader as jest.Mock;
const useNewScreenEffectMock = useNewScreenEffect as jest.Mock;
const useChatBackgroundUriMock = useChatBackgroundUri as jest.Mock;

/** A received text message; only the fields onLongPressMessage reads need to be right. */
function makeMsg(overrides: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    id: 10,
    guid: 'm1',
    text: 'hey',
    isFromMe: 0,
    senderName: 'Alice',
    dateCreated: Date.now(),
    dateRetracted: null,
    sendState: 'sent',
    reactions: [],
    attachments: [],
    ...overrides,
  } as unknown as EnrichedMessage;
}

/** A reaction row (only isFromMe/baseType/emoji are read by the selection mapper). */
function reactionRow(over: Record<string, unknown>): any {
  return {
    targetGuid: 'm1',
    baseType: 'love',
    emoji: null,
    isFromMe: 1,
    senderName: null,
    dateCreated: 1,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuid = GUID;
  useTypingStore.setState({ typing: {} });
  useMessagesMock.mockReturnValue({ data: [], error: null });
  useChatHeaderMock.mockReturnValue({
    data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: null },
    error: null,
  });
  useNewScreenEffectMock.mockReturnValue({ effect: null, clear: jest.fn() });
  useChatBackgroundUriMock.mockReturnValue(null);
});

/** Invoke a captured screen callback inside act (it mutates screen state). */
async function run(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
  });
}

describe('ChatScreen — mount side effects', () => {
  it('marks the chat read and backfills history on open', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(markRead).toHaveBeenCalledWith(GUID);
    expect(ensureChatSynced).toHaveBeenCalledWith(GUID);
  });

  it('re-marks read and re-syncs when a reused screen instance gets a NEW guid', async () => {
    const GUID2 = 'iMessage;-;+15559990000';
    const view = await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(GUID));

    // Same mounted instance, new route param — the [guid]-keyed mount effect must run again
    // (a once-only ref here would leave the second chat unread/unsynced).
    mockGuid = GUID2;
    await act(async () => {
      view.rerender(<ChatScreen />);
    });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(GUID2));
    expect(ensureChatSynced).toHaveBeenCalledWith(GUID2);
  });

  it('passes the reactive messages + iMessage placeholder down to the list and composer', async () => {
    useMessagesMock.mockReturnValue({ data: [makeMsg()], error: null });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.list?.chatGuid).toBe(GUID);
    expect(mockCaptured.list?.messages).toHaveLength(1);
    expect(mockCaptured.composer?.placeholder).toBe('iMessage');
  });

  it('renders the error banner when the message query failed', async () => {
    useMessagesMock.mockReturnValue({ data: undefined, error: new Error('db down') });
    await renderWithTheme(<ChatScreen />);
    expect(screen.getByText(/Couldn.t load messages/)).toBeTruthy();
  });
});

describe('ChatScreen — long-press → SelectedMessage mapping', () => {
  it('maps classic own-reactions into `mine` and emoji tapbacks into `myEmojis` (excluding emoji from mine)', async () => {
    await renderWithTheme(<ChatScreen />);
    const msg = makeMsg({
      guid: 'm7',
      text: 'wired recently',
      isFromMe: 0,
      reactions: [
        reactionRow({ baseType: 'love', emoji: null, isFromMe: 1 }), // classic mine
        reactionRow({ baseType: 'like', emoji: null, isFromMe: 0 }), // not mine → excluded
        reactionRow({ baseType: 'emoji', emoji: '🎉', isFromMe: 1 }), // emoji mine → myEmojis, NOT mine
      ],
    });
    await run(() => mockCaptured.list!.onLongPressMessage(msg));

    const sel = mockCaptured.overlay!.selected;
    expect(sel.guid).toBe('m7');
    expect(sel.mine).toEqual(['love']);
    expect(sel.myEmojis).toEqual(['🎉']);
    expect(sel.isFromMe).toBe(false);
    expect(sel.isTemp).toBe(false);
  });

  it('flags a temp (optimistic) message via the temp- guid prefix', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'temp-abc', isFromMe: 1 })),
    );
    expect(mockCaptured.overlay!.selected.isTemp).toBe(true);
    expect(mockCaptured.overlay!.selected.isFromMe).toBe(true);
  });
});

describe('ChatScreen — onReact routing (real react() path)', () => {
  it('routes a classic tapback to react() with no emoji', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1', text: 'hey' })));
    await run(() => mockCaptured.overlay!.onReact('love'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: GUID,
        targetGuid: 'm1',
        reaction: 'love',
        emoji: undefined,
        selectedMessageText: 'hey',
      }),
    );
  });

  it('routes an arbitrary-emoji tapback to react() carrying the glyph', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1' })));
    await run(() => mockCaptured.overlay!.onReact('emoji', '🎉'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: 'emoji', emoji: '🎉', targetGuid: 'm1' }),
    );
  });
});

describe('ChatScreen — send routing', () => {
  it('routes plain composer text to send() with no effect', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.composer!.onSend('hello'));
    expect(send).toHaveBeenCalledWith({ chatGuid: GUID, text: 'hello', effectId: undefined });
    expect(reply).not.toHaveBeenCalled();
  });

  it('carries the effect id through send()', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onSend('party', 'com.apple.MobileSMS.expressivesend.impact'),
    );
    expect(send).toHaveBeenCalledWith({
      chatGuid: GUID,
      text: 'party',
      effectId: 'com.apple.MobileSMS.expressivesend.impact',
    });
  });

  it('a smart-reply chip pick routes through the same send()', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.smartReply!.onPick('on my way'));
    expect(send).toHaveBeenCalledWith({ chatGuid: GUID, text: 'on my way', effectId: undefined });
  });
});

describe('ChatScreen — reply flow', () => {
  it('selecting Reply sets the composer replyTo, and sending routes to reply()', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.list!.onLongPressMessage(
        makeMsg({ guid: 'm1', text: 'hey', senderName: 'Alice' }),
      ),
    );
    await run(() => mockCaptured.overlay!.onReply());

    expect(mockCaptured.composer!.replyTo).toEqual(
      expect.objectContaining({ guid: 'm1', text: 'hey', senderName: 'Alice', isFromMe: 0 }),
    );

    await run(() => mockCaptured.composer!.onSend('sure'));
    expect(reply).toHaveBeenCalledWith({
      chatGuid: GUID,
      text: 'sure',
      replyToGuid: 'm1',
      effectId: undefined,
    });
    expect(send).not.toHaveBeenCalled();
    // replyTo is cleared after the reply is sent.
    expect(mockCaptured.composer!.replyTo).toBeNull();
  });
});

describe('ChatScreen — edit flow', () => {
  it('selecting Edit prefills the composer, and confirming routes to editText()', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1', text: 'original', isFromMe: 1 })),
    );
    await run(() => mockCaptured.overlay!.onEdit());
    expect(mockCaptured.composer!.editingText).toBe('original');

    await run(() => mockCaptured.composer!.onSend('edited body'));
    expect(editText).toHaveBeenCalledWith({
      messageGuid: 'm1',
      newText: 'edited body',
      chatGuid: GUID,
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ChatScreen — typing indicator', () => {
  it('renders the TypingBubble when the typing store flags this chat', async () => {
    useTypingStore.setState({ typing: { [GUID]: true } });
    await renderWithTheme(<ChatScreen />);
    expect(await screen.findByText('typing…')).toBeTruthy();
  });

  it('does not render the TypingBubble when idle', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(screen.queryByText('typing…')).toBeNull();
  });
});

describe('ChatScreen — wallpaper chrome flip', () => {
  it('with no wallpaper, the list gets no insets and hasBackground=false', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.list!.hasBackground).toBe(false);
    expect(mockCaptured.list!.topInset).toBe(0);
    expect(mockCaptured.list!.bottomInset).toBe(0);
  });

  it('with a wallpaper uri, the list becomes full-bleed with positive bar insets', async () => {
    useChatBackgroundUriMock.mockReturnValue('file://wall.jpg');
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.list!.hasBackground).toBe(true);
    expect(mockCaptured.list!.topInset).toBeGreaterThan(0);
    expect(mockCaptured.list!.bottomInset).toBeGreaterThan(0);
  });
});

describe('ChatScreen — stable list callbacks (row memoization contract)', () => {
  it('keeps onLongPressMessage/onSwipeReply/onToggleSelect identities across re-renders', async () => {
    await renderWithTheme(<ChatScreen />);
    const first = {
      longPress: mockCaptured.list!.onLongPressMessage,
      swipe: mockCaptured.list!.onSwipeReply,
      toggle: mockCaptured.list!.onToggleSelect,
    };
    // Force an unrelated screen re-render (typing state) — a fresh closure here would
    // fail MessageRow's shallow memo compare and re-render every row.
    await act(async () => {
      useTypingStore.setState({ typing: { [GUID]: true } });
    });
    expect(mockCaptured.list!.onLongPressMessage).toBe(first.longPress);
    expect(mockCaptured.list!.onSwipeReply).toBe(first.swipe);
    expect(mockCaptured.list!.onToggleSelect).toBe(first.toggle);
  });
});

describe('ChatScreen — stable composer callbacks (Composer memo contract)', () => {
  it('keeps every composer callback identity across an unrelated screen re-render', async () => {
    await renderWithTheme(<ChatScreen />);
    const first = {
      send: mockCaptured.composer!.onSend,
      schedule: mockCaptured.composer!.onSchedule,
      attachments: mockCaptured.composer!.onSendAttachments,
      pickFiles: mockCaptured.composer!.onPickFiles,
      cancelReply: mockCaptured.composer!.onCancelReply,
      cancelEdit: mockCaptured.composer!.onCancelEdit,
      typing: mockCaptured.composer!.onTyping,
      voice: mockCaptured.composer!.onStartVoice,
    };
    expect(first.voice).toBeDefined(); // non-dev path passes the real stable callback
    // Unrelated screen state change (typing flag) — fresh closures here would defeat
    // the memoized Composer's shallow prop compare on every reactive tick.
    await act(async () => {
      useTypingStore.setState({ typing: { [GUID]: true } });
    });
    expect(mockCaptured.composer!.onSend).toBe(first.send);
    expect(mockCaptured.composer!.onSchedule).toBe(first.schedule);
    expect(mockCaptured.composer!.onSendAttachments).toBe(first.attachments);
    expect(mockCaptured.composer!.onPickFiles).toBe(first.pickFiles);
    expect(mockCaptured.composer!.onCancelReply).toBe(first.cancelReply);
    expect(mockCaptured.composer!.onCancelEdit).toBe(first.cancelEdit);
    expect(mockCaptured.composer!.onTyping).toBe(first.typing);
    expect(mockCaptured.composer!.onStartVoice).toBe(first.voice);
  });
});

describe('ChatScreen — attachment share/save routing (via @/services/media)', () => {
  const withAttachment = () =>
    makeMsg({
      guid: 'm9',
      attachments: [
        { guid: 'a1', localPath: 'file:///docs/a1.jpg', mimeType: 'image/jpeg' },
      ] as never,
    });

  it('routes Save to saveAttachmentsToPhotos with the attachment paths and reports the count', async () => {
    (saveAttachmentsToPhotos as jest.Mock).mockResolvedValue({ status: 'saved', saved: 1 });
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    await run(() => mockCaptured.overlay!.onSave());
    await waitFor(() =>
      expect(saveAttachmentsToPhotos).toHaveBeenCalledWith(['file:///docs/a1.jpg']),
    );
    await waitFor(() => expect(showDialog).toHaveBeenCalledWith('Save', 'Saved 1 item to Photos.'));
  });

  it('shares a downloaded attachment file via shareAttachment', async () => {
    (shareAttachment as jest.Mock).mockResolvedValue(true);
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() =>
      expect(shareAttachment).toHaveBeenCalledWith('file:///docs/a1.jpg', 'image/jpeg'),
    );
  });
});

describe('ChatScreen — scheduled-message ticker', () => {
  it('fires on mount + every 20s and stops (interval cleared) on unmount', async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderWithTheme(<ChatScreen />);
      // Mount tick (non-dev path → fireDueScheduled).
      expect(fireDueScheduled).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      expect(fireDueScheduled).toHaveBeenCalledTimes(2);

      await act(async () => {
        unmount();
      });
      await act(async () => {
        jest.advanceTimersByTime(40_000);
      });
      // Interval was cleared on unmount — no further ticks.
      expect(fireDueScheduled).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
