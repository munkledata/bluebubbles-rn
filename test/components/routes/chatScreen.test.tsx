/**
 * ChatScreen (app/(app)/chat/[guid].tsx): the conversation route. This suite locks in the
 * SCREEN'S OWN wiring — how it maps a long-pressed message into a SelectedMessage, routes the
 * overlay/composer callbacks into the send services, drives the scheduled-message ticker, and
 * flips wallpaper chrome — while treating every child (MessageList, Composer,
 * MessageActionsOverlay, …) as a probe (their internals are covered in their
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
 *   - `@utils/isDev` (`isDevServer`) → false by default so the screen takes the REAL service path
 *     (`react`/`reply`/`send`/`editText`/`fireDueScheduled`), not the `devSeed` fixtures — this is
 *     the path shipped to users and gives the cleaner assertions (see the ticker + react tests).
 *   - `expo-router` (fixed guid + a push spy), `expo-clipboard`/`expo-image`/`expo-media-library`,
 *     `react-native-safe-area-context` (zero insets), and the small `@ui/*` sibling modules
 *     (ChatThemeProvider, dialogStore, pickDateTime, LoadErrorBoundary) → native/inset stubs.
 *
 * The REAL `useTypingStore` (zustand) is driven via setState to exercise the typing-bubble branch.
 */
import React from 'react';
import { renderWithTheme, screen, act, fireEvent, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const GUID = 'iMessage;-;+15551234567';
const PRIVATE_WALLPAPER_URI = 'file:///private/chat-wallpaper-r-canary-9f31d7.jpg';
const SECOND_WALLPAPER_URI = 'file:///private/chat-wallpaper-second-74c02a.jpg';
const mockPush = jest.fn();
const mockNavigationDispatch = jest.fn();
const mockUsePreventRemove = jest.fn();
const mockIsDevServer = jest.fn(() => false);
// Mutable so a test can hand the SAME mounted screen a new guid (reused-instance path).
let mockGuid = GUID;

/** Latest props each probe was rendered with — tests read/invoke these. */
const mockCaptured: {
  header?: Record<string, any>;
  list?: Record<string, any>;
  overlay?: Record<string, any>;
  upload?: Record<string, any>;
  composer?: Record<string, any>;
} = {};
let mockVoiceRecorderProps: Record<string, any> | undefined;

// This Jest config cannot execute the route's native-facing dynamic import. Replace React.lazy
// with a prop-capturing component so the route test still exercises the real recording state and
// the exact callbacks it passes to VoiceRecorder; VoiceRecorder's own suite covers its internals.
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    lazy: () => (props: Record<string, any>) => {
      mockVoiceRecorderProps = props;
      return null;
    },
  };
});

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => R.useEffect(callback, [callback]),
    useLocalSearchParams: () => ({ guid: mockGuid }),
    useNavigation: () => ({ dispatch: mockNavigationDispatch }),
    useRouter: () => ({ push: mockPush }),
  };
});
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (enabled: boolean, callback: (options: unknown) => void) =>
    mockUsePreventRemove(enabled, callback),
}));

// Zero by default (what the rest of the suite wants); mutable so the keyboard-inset test can hand
// the selection bar a realistic navigation bar.
let mockInsetBottom = 0;
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: mockInsetBottom, left: 0, right: 0 }),
}));
// The screen's bottom bars collapse their nav-bar reservation while the keyboard is up (union, not
// sum — see Composer.tsx's paddingBottom). RNTL has no soft keyboard, so drive the hook directly.
let mockKbVisible = false;
jest.mock('@ui/hooks/useKeyboardVisible', () => ({
  useKeyboardVisible: () => mockKbVisible,
}));

/** Latest props the screen's KeyboardAvoidingView was rendered with (see the keyboard test). */
let mockKavProps: Record<string, unknown> = {};
// RNTL 14 dropped the UNSAFE_* type queries and its tree is host-only, so a composite's props are
// unreachable from the render result — capture them by standing in for the module instead. The
// stand-in renders a Fragment: under jest the real KAV's padding is always 0 (no soft keyboard),
// so it contributes nothing to the tree the other tests read.
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      mockKavProps = props;
      return R.createElement(R.Fragment, null, props.children as React.ReactNode);
    },
  };
});

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
}));
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => R.createElement(View, props) };
});

// The whole UI tree as prop-capturing probes (keeps the native-pulling real barrel out).
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View, Text } = require('react-native');
  const capture = (key: 'header' | 'list' | 'overlay' | 'upload' | 'composer') =>
    function CapturedProbe(props: any) {
      const instance = R.useRef(Symbol(key));
      mockCaptured[key] = { ...props, __instance: instance.current };
      return null;
    };
  return {
    useTheme: () => ({ color: { background: '#000000' } }),
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    ConversationHeader: capture('header'),
    EdgeFade: () => null,
    ScreenEffectOverlay: () => null,
    TypingBubble: () => R.createElement(Text, null, 'typing…'),
    // Renders null here on purpose: its own behavior is covered by uploadStatusBar.test.tsx, and
    // the real one subscribes to the upload store + runs a stall interval this screen test has no
    // reason to drive. It must still be PRESENT — a missing export renders as `undefined` and
    // takes the whole screen down.
    UploadStatusBar: capture('upload'),
    MessageList: capture('list'),
    MessageActionsOverlay: capture('overlay'),
    Composer: capture('composer'),
    ThreadSheet: () => null,
    EditHistorySheet: () => null,
    MessageDetailsSheet: () => null,
    showToast: jest.fn(),
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
  isDevServer: () => mockIsDevServer(),
  DEV_SERVER_ORIGIN: 'https://dev.local',
}));

// Keep route-level tests out of the real repository layer. In particular, the open-time deletion
// check needs an explicit normal-chat fixture; otherwise it receives the undefined test database,
// takes the intentional failure fallback, and prints one misleading debug line per render.
jest.mock('@db/repositories', () => ({
  DRAFT_KV_PREFIX: 'draft.',
  getChatIdByGuid: jest.fn(async () => null),
  getChatParticipants: jest.fn(async () => []),
  getFirstUnreadInChat: jest.fn(async () => null),
  isChatHiddenByDeletion: jest.fn(async () => false),
  kvGet: jest.fn(async () => null),
}));

jest.mock('@/services', () => ({
  dispatchRealtimeEvent: jest.fn(async () => undefined),
  ensureChatSynced: jest.fn(),
  ensureSyncedBackgroundForChat: jest.fn(),
  markRead: jest.fn(),
  saveChatDraft: jest.fn().mockResolvedValue(undefined),
  sendTyping: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({ clearChatNotification: jest.fn() }));
jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: jest.fn(),
}));
jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));
jest.mock('@/services/send', () => ({
  editText: jest.fn(),
  fireDueScheduled: jest.fn(),
  fireDueScheduledWithDevelopmentSender: jest.fn(),
  hasLogicalSendCapacity: jest.fn(() => true),
  isContactsPermissionDeniedError: jest.fn(
    (error: unknown) => error instanceof Error && error.name === 'ContactsPermissionDeniedError',
  ),
  pickAndSendContact: jest.fn(),
  react: jest.fn(),
  recoverOutgoing: jest.fn().mockResolvedValue({ eligible: 0, sent: 0 }),
  reply: jest.fn(),
  schedule: jest.fn().mockResolvedValue(undefined),
  send: jest.fn(),
  sendImage: jest.fn(),
  sendImages: jest.fn().mockResolvedValue(null),
  unsend: jest.fn(),
}));

// eslint-disable-next-line import/first
import ChatScreen, { pickDocumentFilesForLease } from '../../../app/(app)/chat/[guid]';
// eslint-disable-next-line import/first
import { useMessages } from '@features/conversations/useMessages';
// eslint-disable-next-line import/first
import { useChatHeader } from '@features/conversations/useChatHeader';
// eslint-disable-next-line import/first
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
// eslint-disable-next-line import/first
import { useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
// eslint-disable-next-line import/first
import {
  dispatchRealtimeEvent,
  ensureChatSynced,
  markRead,
  saveChatDraft,
  sendTyping,
} from '@/services';
// eslint-disable-next-line import/first
import { getContactsPermissionState } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import {
  editText,
  fireDueScheduled,
  fireDueScheduledWithDevelopmentSender,
  hasLogicalSendCapacity,
  pickAndSendContact,
  react,
  reply,
  schedule,
  send,
  sendImages,
} from '@/services/send';
// eslint-disable-next-line import/first
import { showToast } from '@ui';
// eslint-disable-next-line import/first
import { presentSendIssue } from '@ui/conversations/sendNotices';
// eslint-disable-next-line import/first
import { devSendFake, devSendFakeReply } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useTypingStore } from '@state/typingStore';
// eslint-disable-next-line import/first
import { isChatHiddenByDeletion } from '@db/repositories';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const useMessagesMock = useMessages as jest.Mock;
const useChatHeaderMock = useChatHeader as jest.Mock;
const useNewScreenEffectMock = useNewScreenEffect as jest.Mock;
const useChatBackgroundUriMock = useChatBackgroundUri as jest.Mock;
const mockGetContactsPermissionState = getContactsPermissionState as jest.Mock;

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
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  (saveChatDraft as jest.Mock).mockReset().mockResolvedValue(undefined);
  (fireDueScheduledWithDevelopmentSender as jest.Mock).mockReset().mockResolvedValue(0);
  mockIsDevServer.mockReturnValue(false);
  mockGetContactsPermissionState.mockResolvedValue({ status: 'granted', canAskAgain: true });
  (pickAndSendContact as jest.Mock).mockResolvedValue(null);
  mockGuid = GUID;
  mockInsetBottom = 0;
  mockKbVisible = false;
  mockVoiceRecorderProps = undefined;
  useSessionStore.setState({ serverInfo: null });
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HostJsonNode {
  type?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
}

function visitHostTree(tree: unknown, visit: (node: HostJsonNode) => void): void {
  if (tree == null) return;
  if (Array.isArray(tree)) {
    tree.forEach((node) => visitHostTree(node, visit));
    return;
  }
  if (typeof tree !== 'object') return;
  const node = tree as HostJsonNode;
  visit(node);
  visitHostTree(node.children, visit);
}

function flattenTestStyle(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>(
      (result, part) => Object.assign(result, flattenTestStyle(part)),
      {},
    );
  }
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function wallpaperSourceUris(tree: unknown): string[] {
  const uris: string[] = [];
  visitHostTree(tree, (node) => {
    const source = node.props?.source;
    if (source == null || typeof source !== 'object') return;
    const uri = (source as Record<string, unknown>).uri;
    if (typeof uri === 'string') uris.push(uri);
  });
  return uris;
}

function overlayStyleCounts(tree: unknown): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  visitHostTree(tree, (node) => {
    if (node.type !== 'View') return;
    const style = flattenTestStyle(node.props?.style);
    if (
      style.position !== 'absolute' ||
      style.left !== 0 ||
      style.right !== 0 ||
      style.zIndex !== 2
    ) {
      return;
    }
    if (style.top === 0) top += 1;
    if (style.bottom === 0) bottom += 1;
  });
  return { top, bottom };
}

function expectWallpaperPresentation(tree: unknown, uri: string | null): void {
  expect(wallpaperSourceUris(tree)).toEqual(uri == null ? [] : [uri]);
  expect(mockCaptured.header?.translucent).toBe(uri != null);
  expect(mockCaptured.upload?.translucent).toBe(uri != null);
  expect(mockCaptured.composer?.translucent).toBe(uri != null);
  expect(mockCaptured.list?.hasBackground).toBe(uri != null);
  if (uri == null) {
    expect(mockCaptured.list?.topInset).toBe(0);
    expect(mockCaptured.list?.bottomInset).toBe(0);
    expect(overlayStyleCounts(tree)).toEqual({ top: 0, bottom: 0 });
  } else {
    expect(mockCaptured.list?.topInset).toBeGreaterThan(0);
    expect(mockCaptured.list?.bottomInset).toBeGreaterThan(0);
    expect(overlayStyleCounts(tree)).toEqual({ top: 1, bottom: 1 });
  }
}

describe('ChatScreen — mount side effects', () => {
  it('marks the chat read and backfills history on open', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(markRead).toHaveBeenCalledWith(
      GUID,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(ensureChatSynced).toHaveBeenCalledWith(GUID);
  });

  it('re-marks read and re-syncs when a reused screen instance gets a NEW guid', async () => {
    const GUID2 = 'iMessage;-;+15559990000';
    const view = await renderWithTheme(<ChatScreen />);
    await waitFor(() =>
      expect(markRead).toHaveBeenCalledWith(
        GUID,
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );

    // Same mounted instance, new route param — the [guid]-keyed mount effect must run again
    // (a once-only ref here would leave the second chat unread/unsynced).
    mockGuid = GUID2;
    await act(async () => {
      view.rerender(<ChatScreen />);
    });
    await waitFor(() =>
      expect(markRead).toHaveBeenCalledWith(
        GUID2,
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
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

  it('does not let a retained account-A pull-to-refresh start account-B backfill', async () => {
    await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(isChatHiddenByDeletion).toHaveBeenCalledTimes(1));
    const refreshFromA = mockCaptured.list!.onRefresh as () => Promise<void>;

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    (isChatHiddenByDeletion as jest.Mock).mockClear();
    (ensureChatSynced as jest.Mock).mockClear();
    await refreshFromA();

    expect(isChatHiddenByDeletion).not.toHaveBeenCalled();
    expect(ensureChatSynced).not.toHaveBeenCalled();
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

  it('flags an edited message and parses its messageSummaryInfo JSON onto the selection', async () => {
    await renderWithTheme(<ChatScreen />);
    const info = {
      editedParts: {
        '0': [
          { date: 1, text: 'a' },
          { date: 2, text: 'b' },
        ],
      },
    };
    await run(() =>
      mockCaptured.list!.onLongPressMessage(
        makeMsg({ guid: 'm9', dateEdited: 2, messageSummaryInfo: JSON.stringify(info) }),
      ),
    );
    const sel = mockCaptured.overlay!.selected;
    expect(sel.isEdited).toBe(true);
    // The raw JSON column is parsed into the structured history (original → current).
    expect(sel.messageSummaryInfo.editedParts['0']).toHaveLength(2);
  });

  it('leaves isEdited false and messageSummaryInfo null for an un-edited message', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1' })));
    expect(mockCaptured.overlay!.selected.isEdited).toBe(false);
    expect(mockCaptured.overlay!.selected.messageSummaryInfo).toBeNull();
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
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });

  it('routes an arbitrary-emoji tapback to react() carrying the glyph', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1' })));
    await run(() => mockCaptured.overlay!.onReact('emoji', '🎉'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: 'emoji', emoji: '🎉', targetGuid: 'm1' }),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });
});

describe('ChatScreen — send routing', () => {
  it('gives the composer synchronous capacity and account-owner guards', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer!.canSubmit).toBe(hasLogicalSendCapacity);
    const isSubmitOwnerCurrent = mockCaptured.composer!.isSubmitOwnerCurrent as () => boolean;
    expect(isSubmitOwnerCurrent()).toBe(true);

    await pauseRealtimeDeliveries();
    expect(isSubmitOwnerCurrent()).toBe(false);
    resumeRealtimeDeliveries();
  });

  it('routes plain composer text to send() with no effect', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.composer!.onSend('hello'));
    expect(send).toHaveBeenCalledWith(
      { chatGuid: GUID, text: 'hello', effectId: undefined },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it('carries the effect id through send()', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onSend('party', 'com.apple.MobileSMS.expressivesend.impact'),
    );
    expect(send).toHaveBeenCalledWith(
      {
        chatGuid: GUID,
        text: 'party',
        effectId: 'com.apple.MobileSMS.expressivesend.impact',
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });

  it('threads the mounted account lease through DEV text and reply sends', async () => {
    mockIsDevServer.mockReturnValue(true);
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.composer!.onSend('plain-dev'));
    const accountLease = (devSendFake as jest.Mock).mock.calls[0]![3];
    expect(devSendFake).toHaveBeenCalledWith(GUID, 'plain-dev', undefined, accountLease);

    await run(() =>
      mockCaptured.list!.onLongPressMessage(
        makeMsg({ guid: 'reply-target', text: 'question', senderName: 'Alice' }),
      ),
    );
    await run(() => mockCaptured.overlay!.onReply());
    await run(() => mockCaptured.composer!.onSend('reply-dev'));
    expect(devSendFakeReply).toHaveBeenCalledWith(
      GUID,
      'reply-dev',
      'reply-target',
      undefined,
      accountLease,
    );
    expect(accountLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
  });

  it('shows recovery guidance when Send Contact permission is denied', async () => {
    useSessionStore.setState({ serverInfo: { supports_send_contact: true } as any });
    const denied = Object.assign(new Error('contacts-permission-denied'), {
      name: 'ContactsPermissionDeniedError',
      canAskAgain: false,
    });
    (pickAndSendContact as jest.Mock).mockRejectedValueOnce(denied);
    await renderWithTheme(<ChatScreen />);

    await run(() => mockCaptured.composer!.onPickContact());

    await waitFor(() =>
      expect(showDialog).toHaveBeenCalledWith(
        'Contacts access denied',
        expect.stringContaining('Android won’t show'),
        expect.arrayContaining([expect.objectContaining({ text: 'Open Settings' })]),
      ),
    );
  });

  it('explains optional Contacts access before opening the native contact picker', async () => {
    useSessionStore.setState({ serverInfo: { supports_send_contact: true } as any });
    mockGetContactsPermissionState.mockResolvedValueOnce({
      status: 'undetermined',
      canAskAgain: true,
    });
    await renderWithTheme(<ChatScreen />);

    await run(() => mockCaptured.composer!.onPickContact());
    await waitFor(() =>
      expect(showDialog).toHaveBeenCalledWith(
        'Allow Contacts access?',
        expect.stringContaining('still type phone numbers and email addresses'),
        expect.any(Array),
      ),
    );
    expect(pickAndSendContact).not.toHaveBeenCalled();

    const buttons = (showDialog as jest.Mock).mock.calls.at(-1)?.[2] as
      Array<{ text: string; onPress?: () => void }> | undefined;
    await run(() => buttons?.find((button) => button.text === 'Continue')?.onPress?.());
    await waitFor(() => expect(pickAndSendContact).toHaveBeenCalledTimes(1));
  });

  it('keeps a canceled Send Contact picker silent', async () => {
    useSessionStore.setState({ serverInfo: { supports_send_contact: true } as any });
    (pickAndSendContact as jest.Mock).mockResolvedValueOnce(null);
    await renderWithTheme(<ChatScreen />);

    await run(() => mockCaptured.composer!.onPickContact());
    await waitFor(() => expect(pickAndSendContact).toHaveBeenCalledTimes(1));

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('wires microphone denial and native-request errors to recovery dialogs', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.composer!.onStartVoice());
    await waitFor(() => expect(mockVoiceRecorderProps).toBeDefined());

    mockVoiceRecorderProps!.onPermissionDenied();
    expect(showDialog).toHaveBeenLastCalledWith(
      'Microphone',
      'Microphone access was denied. Enable it in system settings to record voice messages.',
    );

    mockVoiceRecorderProps!.onPermissionError();
    expect(showDialog).toHaveBeenLastCalledWith(
      'Microphone',
      'Microphone access is unavailable. Try again or enable it in system settings.',
    );
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
    expect(reply).toHaveBeenCalledWith(
      {
        chatGuid: GUID,
        text: 'sure',
        replyToGuid: 'm1',
        effectId: undefined,
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
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
    expect(editText).toHaveBeenCalledWith(
      {
        messageGuid: 'm1',
        newText: 'edited body',
        chatGuid: GUID,
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
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

  it('binds the DEV typing injection to the mounted account lease', async () => {
    mockIsDevServer.mockReturnValue(true);
    await renderWithTheme(<ChatScreen />);

    await fireEvent.press(screen.getByText('⌨️'));

    expect(dispatchRealtimeEvent).toHaveBeenCalledWith(
      'typing-indicator',
      { chatGuid: GUID, display: true },
      'dev',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('does not dispatch DEV typing outside the local fixture session', async () => {
    await renderWithTheme(<ChatScreen />);

    await fireEvent.press(screen.getByText('⌨️'));

    expect(dispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('drops a retained account-A DEV typing button after account B is admitted', async () => {
    mockIsDevServer.mockReturnValue(true);
    await renderWithTheme(<ChatScreen />);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    (dispatchRealtimeEvent as jest.Mock).mockClear();

    await fireEvent.press(screen.getByText('⌨️'));

    expect(dispatchRealtimeEvent).not.toHaveBeenCalled();
  });
});

describe('ChatScreen — wallpaper chrome flip', () => {
  it('with no wallpaper, the list gets no insets and hasBackground=false', async () => {
    const view = await renderWithTheme(<ChatScreen />);
    expectWallpaperPresentation(view.toJSON(), null);
  });

  it('with a wallpaper uri, mounts it and gives every chrome surface wallpaper props', async () => {
    useChatBackgroundUriMock.mockReturnValue(PRIVATE_WALLPAPER_URI);
    const view = await renderWithTheme(<ChatScreen />);

    expectWallpaperPresentation(view.toJSON(), PRIVATE_WALLPAPER_URI);
  });

  it('reacts to URI → null → new URI without remounting the list or composer', async () => {
    useChatBackgroundUriMock.mockReturnValue(PRIVATE_WALLPAPER_URI);
    const view = await renderWithTheme(<ChatScreen />);
    const firstListInstance = mockCaptured.list!.__instance;
    const firstComposerInstance = mockCaptured.composer!.__instance;
    const firstLongPress = mockCaptured.list!.onLongPressMessage;
    const firstSend = mockCaptured.composer!.onSend;

    expectWallpaperPresentation(view.toJSON(), PRIVATE_WALLPAPER_URI);
    useChatBackgroundUriMock.mockReturnValue(null);
    await act(async () => {
      view.rerender(<ChatScreen />);
    });

    expectWallpaperPresentation(view.toJSON(), null);
    expect(mockCaptured.list!.__instance).toBe(firstListInstance);
    expect(mockCaptured.composer!.__instance).toBe(firstComposerInstance);
    expect(mockCaptured.list!.onLongPressMessage).toBe(firstLongPress);
    expect(mockCaptured.composer!.onSend).toBe(firstSend);

    useChatBackgroundUriMock.mockReturnValue(SECOND_WALLPAPER_URI);
    await act(async () => {
      view.rerender(<ChatScreen />);
    });

    expectWallpaperPresentation(view.toJSON(), SECOND_WALLPAPER_URI);
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_WALLPAPER_URI);
    expect(mockCaptured.list!.__instance).toBe(firstListInstance);
    expect(mockCaptured.composer!.__instance).toBe(firstComposerInstance);
    expect(mockCaptured.list!.onLongPressMessage).toBe(firstLongPress);
    expect(mockCaptured.composer!.onSend).toBe(firstSend);
  });

  it('removes the wallpaper on the next render after the mounted account lease is revoked', async () => {
    useChatBackgroundUriMock.mockReturnValue(PRIVATE_WALLPAPER_URI);
    const view = await renderWithTheme(<ChatScreen />);
    expectWallpaperPresentation(view.toJSON(), PRIVATE_WALLPAPER_URI);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      view.rerender(<ChatScreen />);
    });

    expectWallpaperPresentation(view.toJSON(), null);
  });
});

describe('ChatScreen — keyboard avoidance contract', () => {
  // Half of the "empty band between the composer and the keyboard" fix. The Composer collapses its
  // own nav-bar reservation while the keyboard is up (locked in conversations/
  // composerKeyboardInset.test.tsx); this screen must therefore NOT also pass the old
  // `keyboardVerticalOffset={-insets.bottom}` counterweight, which existed only to cancel that
  // reservation. With both in place the composer is pushed BEHIND the keyboard — so the two
  // invariants have to move together, and each side asserts its half.
  // The real lift is device-only (RNTL has no soft keyboard); the PROPS are all jest can see.
  it('uses behavior="padding" with NO keyboardVerticalOffset counterweight', async () => {
    await renderWithTheme(<ChatScreen />);
    expect(mockKavProps.behavior).toBe('padding');
    expect(mockKavProps.keyboardVerticalOffset ?? 0).toBe(0);
  });

  // The SELECTION bar is the third copy of the union rule (Composer and the inbox search bar are
  // the other two, each guarded in its own suite). It replaces the Composer in multi-select, so it
  // owns the bottom safe area while it is up.
  it('collapses the selection bar’s nav-bar reservation while the keyboard is up', async () => {
    const NAV_BAR = 48;
    mockInsetBottom = NAV_BAR;
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1' })));
    await run(() => mockCaptured.overlay!.onSelect());
    const bar = (await screen.findByText('1 selected')).parent;
    const flat = Object.assign({}, ...[bar?.props.style].flat(Infinity).filter(Boolean));
    expect(flat.paddingBottom).toBe(NAV_BAR + 14);

    mockKbVisible = true;
    await run(() => mockCaptured.list!.onToggleSelect(makeMsg({ guid: 'm2' })));
    const barUp = (await screen.findByText('2 selected')).parent;
    const flatUp = Object.assign({}, ...[barUp?.props.style].flat(Infinity).filter(Boolean));
    expect(flatUp.paddingBottom).toBe(14);
  });

  it('keeps Composer mounted and makes Back exit selection before removing the chat', async () => {
    await renderWithTheme(<ChatScreen />);
    const composerInstance = mockCaptured.composer!.__instance;

    await run(() => mockCaptured.list!.onLongPressMessage(makeMsg({ guid: 'm1' })));
    await run(() => mockCaptured.overlay!.onSelect());
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect(mockCaptured.composer!.__instance).toBe(composerInstance);
    expect(mockCaptured.composer!.active).toBe(false);

    const latestGuardCall =
      mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
    expect(latestGuardCall?.[0]).toBe(true);
    await run(() => latestGuardCall?.[1]({ data: { action: { type: 'GO_BACK' } } }));

    expect(screen.queryByText('1 selected')).toBeNull();
    expect(mockCaptured.composer!.__instance).toBe(composerInstance);
    expect(mockCaptured.composer!.active).toBe(true);
    expect(mockNavigationDispatch).not.toHaveBeenCalled();
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
  it('surfaces a current-account attachment admission failure', async () => {
    const failure = new Error('paste ownership unavailable');
    (sendImages as jest.Mock).mockRejectedValueOnce(failure);
    await renderWithTheme(<ChatScreen />);

    await act(async () => {
      mockCaptured.composer!.onSendAttachments([
        {
          uri: 'file:///cache/pasted-in/1000-1/photo.jpg',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 10,
          origin: 'paste',
        },
      ]);
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith(
      'Couldn’t send one or more attachments—add the missing file again',
    );
  });

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

  it('drops a native file-picker result after the screen account that opened it retires', async () => {
    let finishPicker!: (value: {
      canceled: false;
      assets: Array<{ uri: string; name: string; mimeType: string; size: number }>;
    }) => void;
    const getDocumentAsync = jest.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        finishPicker = resolve;
      }),
    );
    const pickerLease = captureRealtimeDeliveryLease();
    const picked = pickDocumentFilesForLease(pickerLease, async () => ({ getDocumentAsync }));
    await waitFor(() => expect(getDocumentAsync).toHaveBeenCalledTimes(1));

    // The open OS picker owns no account data, so it does not hold the Disconnect barrier.
    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();

    finishPicker({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/a-secret.pdf',
          name: 'a-secret.pdf',
          mimeType: 'application/pdf',
          size: 123,
        },
      ],
    });

    await expect(picked).resolves.toEqual([]);
  });

  it('routes an admitted draft write through the exact screen account lease', async () => {
    await renderWithTheme(<ChatScreen />);
    const flushDraft = mockCaptured.composer!.onDraftChange as (text: string) => void;
    await run(() => flushDraft('A-only admitted draft'));
    await waitFor(() => expect(saveChatDraft).toHaveBeenCalledTimes(1));

    expect(mockCaptured.composer!.initialText).toBe('A-only admitted draft');
    expect(saveChatDraft).toHaveBeenCalledWith(
      GUID,
      'A-only admitted draft',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    const accountLease = (saveChatDraft as jest.Mock).mock.calls[0]![2] as {
      isCurrent(): boolean;
    };
    expect(accountLease.isCurrent()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(accountLease.isCurrent()).toBe(false);
    resumeRealtimeDeliveries();
  });

  it('drops draft-flush and typing callbacks after their screen account retires', async () => {
    await renderWithTheme(<ChatScreen />);
    const flushDraft = mockCaptured.composer!.onDraftChange as (text: string) => void;
    const emitTyping = mockCaptured.composer!.onTyping as (active: boolean) => void;
    (saveChatDraft as jest.Mock).mockClear();
    (sendTyping as jest.Mock).mockClear();

    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    // These are exactly the debounce/unmount callbacks that can run after the old screen has
    // disappeared. Neither may persist or emit through the newly connected account.
    flushDraft('A-only draft');
    emitTyping(false);

    expect(saveChatDraft).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('handles a stale scheduled-send rejection quietly instead of leaking an unhandled promise', async () => {
    await renderWithTheme(<ChatScreen />);
    const scheduleFromOldScreen = mockCaptured.composer!.onSchedule as (
      text: string,
      scheduledFor: number,
    ) => void;
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    (schedule as jest.Mock).mockRejectedValueOnce(new Error('account session changed'));
    (showDialog as jest.Mock).mockClear();

    await act(async () => {
      scheduleFromOldScreen('A-only scheduled text', Date.now() + 60_000);
      await Promise.resolve();
    });

    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A-only scheduled text' }),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(showDialog).not.toHaveBeenCalled();
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
      expect(saveAttachmentsToPhotos).toHaveBeenCalledWith(
        ['file:///docs/a1.jpg'],
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(showDialog).toHaveBeenCalledWith('Save', 'Saved 1 item to Photos.'));
  });

  it('shares a downloaded attachment file via shareAttachment', async () => {
    (shareAttachment as jest.Mock).mockResolvedValue({ ok: true });
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() =>
      expect(shareAttachment).toHaveBeenCalledWith(
        'file:///docs/a1.jpg',
        'image/jpeg',
        expect.any(Function),
      ),
    );
    // The sheet opened, so nothing else happens — no fallback text share, no dialog.
    expect(showDialog).not.toHaveBeenCalled();
  });

  // A file share that FAILS must not be reported as "open the attachment first to download it" —
  // the file WAS downloaded; the share sheet is what broke.
  it('reports a failed share honestly instead of blaming a missing download', async () => {
    (shareAttachment as jest.Mock).mockResolvedValue({ ok: false, reason: 'failed' });
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.list!.onLongPressMessage(
        makeMsg({
          guid: 'm9',
          text: null,
          attachments: [
            { guid: 'a1', localPath: 'file:///docs/a1.jpg', mimeType: 'image/jpeg' },
          ] as never,
        }),
      ),
    );
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() => expect(showDialog).toHaveBeenCalled());
    const [title, message] = (showDialog as jest.Mock).mock.calls[0] as [string, string];
    expect(title).toBe('Share');
    expect(message).not.toMatch(/download/i);
  });

  // A CAPTIONED photo whose file share fails must not quietly share the caption instead — the user
  // asked to share the picture, and an OS share sheet carrying only the text reads as success.
  it('does not silently fall back to sharing the caption when the file share fails', async () => {
    const rnShare = jest
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .spyOn(require('react-native').Share, 'share')
      .mockResolvedValue({ action: 'dismissedAction' });
    (shareAttachment as jest.Mock).mockResolvedValue({ ok: false, reason: 'failed' });
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment())); // text: 'hey'
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() => expect(showDialog).toHaveBeenCalled());
    expect(rnShare).not.toHaveBeenCalled();
    rnShare.mockRestore();
  });

  it('drops a delayed attachment-share failure after the screen account retires', async () => {
    const response = deferred<{ ok: false; reason: 'failed' }>();
    (shareAttachment as jest.Mock).mockReturnValueOnce(response.promise);
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() => expect(shareAttachment).toHaveBeenCalledTimes(1));

    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    await act(async () => {
      response.resolve({ ok: false, reason: 'failed' });
      await response.promise;
    });

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('drops a delayed attachment-save result after the screen account retires', async () => {
    const response = deferred<{ status: 'saved'; saved: number }>();
    (saveAttachmentsToPhotos as jest.Mock).mockReturnValueOnce(response.promise);
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    await run(() => mockCaptured.overlay!.onSave());
    await waitFor(() => expect(saveAttachmentsToPhotos).toHaveBeenCalledTimes(1));

    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    await act(async () => {
      response.resolve({ status: 'saved', saved: 1 });
      await response.promise;
    });

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('does not start attachment share or save from callbacks retained by the old account', async () => {
    (shareAttachment as jest.Mock).mockResolvedValueOnce({ ok: true });
    (saveAttachmentsToPhotos as jest.Mock).mockResolvedValueOnce({ status: 'saved', saved: 1 });
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.list!.onLongPressMessage(withAttachment()));
    const oldShare = mockCaptured.overlay!.onShare as () => void;
    const oldSave = mockCaptured.overlay!.onSave as () => void;

    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    await run(() => {
      oldShare();
      oldSave();
    });

    expect(shareAttachment).not.toHaveBeenCalled();
    expect(saveAttachmentsToPhotos).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
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

  it('threads one screen lease through the DEV ticker and its fake senders', async () => {
    mockIsDevServer.mockReturnValue(true);
    (fireDueScheduledWithDevelopmentSender as jest.Mock).mockImplementationOnce(
      async (
        sender: (
          chatGuid: string,
          text: string,
          selectedMessageGuid: string | undefined,
          onQueued: () => Promise<void>,
        ) => Promise<void>,
        accountLease: { isCurrent(): boolean },
      ) => {
        expect(accountLease.isCurrent()).toBe(true);
        await sender('plain-chat', 'plain', undefined, async () => undefined);
        await sender('reply-chat', 'reply', 'reply-target', async () => undefined);
        return 2;
      },
    );

    await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(fireDueScheduledWithDevelopmentSender).toHaveBeenCalledTimes(1));
    const accountLease = (fireDueScheduledWithDevelopmentSender as jest.Mock).mock.calls[0]![1];
    expect(devSendFake).toHaveBeenCalledWith('plain-chat', 'plain', undefined, accountLease);
    expect(devSendFakeReply).toHaveBeenCalledWith(
      'reply-chat',
      'reply',
      'reply-target',
      undefined,
      accountLease,
    );
  });

  it('does not let a retained account-A DEV interval start work in account B', async () => {
    jest.useFakeTimers();
    try {
      mockIsDevServer.mockReturnValue(true);
      await renderWithTheme(<ChatScreen />);
      expect(fireDueScheduledWithDevelopmentSender).toHaveBeenCalledTimes(1);

      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });

      expect(fireDueScheduledWithDevelopmentSender).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
