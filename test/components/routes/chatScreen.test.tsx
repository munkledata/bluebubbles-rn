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
 *   - `@/services` + `@/services/send` → jest.fn spies (send, RCS reaction, and schedule wiring).
 *   - `@utils/isDev` (`isDevServer`) → false by default so the screen takes the REAL service path
 *     (`react`/`send`/`fireDueScheduled`), not the `devSeed` fixtures — this is the path shipped to
 *     users and gives the cleaner assertions (see the ticker + RCS reaction tests).
 *   - `expo-router` (fixed guid + a push spy), `expo-clipboard`/`expo-image`/`expo-media-library`,
 *     `react-native-safe-area-context` (zero insets), and the small `@ui/*` sibling modules
 *     (ChatThemeProvider, dialogStore, pickDateTime, LoadErrorBoundary) → native/inset stubs.
 *
 * The REAL `useTypingStore` (zustand) is driven via setState to exercise the typing-bubble branch.
 */
import React from 'react';
import { AppState } from 'react-native';
import { renderWithTheme, screen, act, fireEvent, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import type { ChatSearchResultRow } from '@db/repositories';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';

const GUID = 'iMessage;-;+15551234567';
const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.dGhyZWFkLTE`;
const RCS_MESSAGE_GUID = `rcs-g1.${RCS_PROVIDER_EPOCH}.bWVzc2FnZS0x`;
const PRIVATE_WALLPAPER_URI = 'file:///private/chat-wallpaper-r-canary-9f31d7.jpg';
const SECOND_WALLPAPER_URI = 'file:///private/chat-wallpaper-second-74c02a.jpg';
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetParams = jest.fn();
const mockRouter = { push: mockPush, replace: mockReplace, setParams: mockSetParams };
const mockNavigationDispatch = jest.fn();
const mockUsePreventRemove = jest.fn();
const mockShowConfirm = jest.fn();
const mockDismissLocationDialog = jest.fn();
let mockDialogId = 0;
let mockScreenFocused = true;
const mockFocusCleanups = new Set<() => void>();
const mockAppStateListeners = new Set<(state: string) => void>();
const mockLocationAdapter = {
  Accuracy: { Balanced: 3 },
  hasServicesEnabledAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
};
const mockIsDevServer = jest.fn(() => false);
const mockUseChatSearch = jest.fn();
const mockRefreshWindow = jest.fn();
const ACCOUNT_A_DB = { account: 'A' };
// Mutable so a test can hand the SAME mounted screen a new guid (reused-instance path).
let mockGuid = GUID;
let mockFocus: string | undefined;
let mockFocusDate: string | undefined;
let mockShareBatch: string | undefined;
let mockRouteKey = 'chat-route-1';
let mockMessagePreview: EnrichedMessage | null = null;

/** Latest props each probe was rendered with — tests read/invoke these. */
const mockCaptured: {
  header?: Record<string, any>;
  list?: Record<string, any>;
  overlay?: Record<string, any>;
  upload?: Record<string, any>;
  composer?: Record<string, any>;
  search?: Record<string, any>;
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
      return actual.createElement(jest.requireActual('react-native').View, {
        testID: 'voice-recorder',
      });
    },
  };
});

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) =>
      R.useEffect(() => {
        if (!mockScreenFocused) return;
        const cleanup = callback();
        if (!cleanup) return;
        mockFocusCleanups.add(cleanup);
        return () => {
          mockFocusCleanups.delete(cleanup);
          cleanup();
        };
      }, [callback]),
    useLocalSearchParams: () => ({
      guid: mockGuid,
      focus: mockFocus,
      focusDate: mockFocusDate,
      shareBatch: mockShareBatch,
    }),
    useNavigation: () => ({ dispatch: mockNavigationDispatch }),
    useRoute: () => ({ key: mockRouteKey }),
    useRouter: () => mockRouter,
  };
});
jest.mock('react-native/Libraries/AppState/AppState', () => ({
  __esModule: true,
  default: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.add(listener);
      return { remove: () => mockAppStateListeners.delete(listener) };
    },
  },
}));
jest.mock('@/services/location/expoLocationAdapter', () => ({
  getExpoLocationAdapter: () => mockLocationAdapter,
}));
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
  const capture = (key: 'header' | 'list' | 'overlay' | 'upload' | 'composer' | 'search') =>
    function CapturedProbe(props: any) {
      const instance = R.useRef(Symbol(key));
      mockCaptured[key] = { ...props, __instance: instance.current };
      return null;
    };
  return {
    useTheme: () => ({ color: { background: '#000000' } }),
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    ConversationHeader: capture('header'),
    ChatSearchBar: capture('search'),
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
jest.mock('@ui/dialog/dialogStore', () => ({
  showConfirm: (...args: unknown[]) => mockShowConfirm(...args),
  showDialog: jest.fn(() => ++mockDialogId),
  useDialogStore: { getState: () => ({ dismissById: mockDismissLocationDialog }) },
}));
jest.mock('@ui/conversations/pickDateTime', () => ({ pickFutureDateTime: jest.fn() }));
jest.mock('@ui/LoadErrorBoundary', () => ({
  LoadErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@features/conversations/useMessages', () => ({ useMessages: jest.fn() }));
jest.mock('@features/conversations/useChatHeader', () => ({ useChatHeader: jest.fn() }));
jest.mock('@features/conversations/useNewScreenEffect', () => ({ useNewScreenEffect: jest.fn() }));
jest.mock('@features/conversations/useChatSearch', () => ({
  useChatSearch: (...args: unknown[]) => mockUseChatSearch(...args),
}));
jest.mock('@features/conversations/devSeed', () => ({ devSendFake: jest.fn() }));

// Force the REAL (non-dev) service path so the send/react spies below are what fire.
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
  getMessagePreviewByGuid: jest.fn(async () => mockMessagePreview),
  resolveMessageTarget: jest.fn(async (_db, target) => ({ ...target, basis: 'exact-topology' })),
  isChatHiddenByDeletion: jest.fn(async () => false),
  kvGet: jest.fn(async () => null),
}));

jest.mock('@/services', () => ({
  ensureChatSynced: jest.fn(),
  ensureSyncedBackgroundForChat: jest.fn(),
  markRead: jest.fn(),
  saveChatDraft: jest.fn().mockResolvedValue(undefined),
  sendTyping: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({ clearChatNotification: jest.fn() }));
jest.mock('@/services/notifications/remindersService', () => ({
  scheduleMessageReminder: jest.fn(),
}));
jest.mock('@/services/remoteMessageDeleteUiService', () => ({
  deleteMessageFromMac: jest.fn(),
}));
jest.mock('@/services/share/shareIntake', () => ({
  admitShareIntakeTextDraft: jest.fn(async () => ({ draft: 'Shared text' })),
  consumeShareIntakeBatch: jest.fn(),
  discardShareIntakeItem: jest.fn(async () => undefined),
  discardShareIntakeBatch: jest.fn(),
  drainShareIntake: jest.fn(() => Promise.resolve()),
  isShareIntakeFileSettled: jest.fn(
    (receipt: { items?: Record<string, unknown> } | null, index: number) =>
      receipt?.items?.[`file:${String(index).padStart(2, '0')}`] != null,
  ),
  isShareIntakeReceiptComplete: jest.fn(() => false),
  readShareIntakeReceipt: jest.fn(async () => null),
}));
jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: jest.fn(),
}));
jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));
jest.mock('@/services/send', () => ({
  acquireAndSendCurrentLocation: jest.fn(),
  fireDueScheduled: jest.fn(),
  fireDueScheduledWithDevelopmentSender: jest.fn(),
  hasLogicalSendCapacity: jest.fn(() => true),
  isSupportedImessageAttachmentFile: jest.fn(
    (image: { mimeType: string; name: string; size: number }) =>
      image.size > 0 &&
      image.size <= 10 * 1024 * 1024 &&
      ((image.mimeType === 'image/jpeg' && /\.jpg$/i.test(image.name)) ||
        (image.mimeType === 'image/png' && /\.png$/i.test(image.name)) ||
        (image.mimeType === 'application/pdf' && /\.pdf$/i.test(image.name))),
  ),
  isContactsPermissionDeniedError: jest.fn(
    (error: unknown) => error instanceof Error && error.name === 'ContactsPermissionDeniedError',
  ),
  pickAndSendContact: jest.fn(),
  react: jest.fn().mockResolvedValue(null),
  recoverOutgoing: jest.fn().mockResolvedValue({ eligible: 0, sent: 0 }),
  schedule: jest.fn().mockResolvedValue(undefined),
  send: jest.fn(
    (
      _args: unknown,
      _lease: unknown,
      _reportIssue: unknown,
      onQueued?: (tempGuid: string) => void,
    ) => {
      onQueued?.('temp-send');
      return Promise.resolve({ tempGuid: 'temp-send' });
    },
  ),
  sendEffect: jest.fn().mockResolvedValue({ status: 'accepted', tempGuid: 'temp-effect' }),
  sendFormatted: jest.fn().mockResolvedValue({ status: 'accepted', tempGuid: 'temp-formatted' }),
  sendMention: jest.fn().mockResolvedValue({ status: 'accepted', tempGuid: 'temp-mention' }),
  sendImage: jest.fn(),
  sendVoice: jest.fn(),
  sendImages: jest.fn().mockResolvedValue(null),
  sendTextAttachment: jest.fn(
    (
      _args: unknown,
      _lease: unknown,
      _reportIssue: unknown,
      onQueued?: (tempGuid: string) => void,
    ) => {
      onQueued?.('temp-combined');
      return Promise.resolve({ tempGuid: 'temp-combined' });
    },
  ),
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
import { ensureChatSynced, markRead, saveChatDraft, sendTyping } from '@/services';
// eslint-disable-next-line import/first
import { getContactsPermissionState } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import {
  acquireAndSendCurrentLocation,
  fireDueScheduled,
  fireDueScheduledWithDevelopmentSender,
  hasLogicalSendCapacity,
  pickAndSendContact,
  react,
  schedule,
  send,
  sendEffect,
  sendFormatted,
  sendMention,
  sendImage,
  sendVoice,
  sendImages,
  sendTextAttachment,
} from '@/services/send';
// eslint-disable-next-line import/first
import { showToast } from '@ui';
// eslint-disable-next-line import/first
import { presentSendIssue } from '@ui/conversations/sendNotices';
// eslint-disable-next-line import/first
import { devSendFake } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  admitShareIntakeTextDraft,
  consumeShareIntakeBatch,
  discardShareIntakeBatch,
  drainShareIntake,
  isShareIntakeReceiptComplete,
  readShareIntakeReceipt,
  discardShareIntakeItem,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useTypingStore } from '@state/typingStore';
// eslint-disable-next-line import/first
import { useShareIntentStore } from '@state/shareIntentStore';
// eslint-disable-next-line import/first
import { getMessagePreviewByGuid, isChatHiddenByDeletion } from '@db/repositories';
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
const mockGetDatabase = getDatabase as jest.Mock;
const mockConsumeShareIntakeBatch = consumeShareIntakeBatch as jest.Mock;
const mockDiscardShareIntakeBatch = discardShareIntakeBatch as jest.Mock;
const mockDrainShareIntake = drainShareIntake as jest.Mock;
const mockAdmitShareIntakeTextDraft = admitShareIntakeTextDraft as jest.Mock;
const mockGetShareIntakeReceipt = readShareIntakeReceipt as jest.Mock;
const mockIsShareIntakeReceiptComplete = isShareIntakeReceiptComplete as jest.Mock;

const SHARE_BATCH = '1700000000000-1-0123456789abcdef';
const OTHER_SHARE_BATCH = '1700000000001-2-fedcba9876543210';
const SHARED_FILE = {
  uri: `file:///data/no_backup/shared-in/files/${SHARE_BATCH}/00-photo.jpg`,
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 42,
  origin: 'share' as const,
  shareItemIndex: 0,
};

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

function makeSearchHit(id: number, guid: string): ChatSearchResultRow {
  return {
    id,
    guid,
    dateCreated: id,
    text: `search result ${id}`,
    snippet: `search snippet ${id}`,
    isFromMe: 0,
    senderName: 'Search Sender',
    senderAddress: 'search-sender@example.invalid',
  };
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

function configureRcsChat(serverInfo: Record<string, unknown> = {}): void {
  mockGuid = RCS_GUID;
  useSessionStore.setState({
    serverInfo: {
      version: 'test',
      private_api: false,
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: RCS_PROVIDER_EPOCH,
      ...serverInfo,
    } as any,
  });
  useChatHeaderMock.mockReturnValue({
    data: {
      id: 2,
      guid: RCS_GUID,
      style: 45,
      participantCount: 1,
      handleServices: 'RCS',
    },
    error: null,
  });
}

function stageExactShare(
  batchId = SHARE_BATCH,
  options: { text?: string | null; files?: (typeof SHARED_FILE)[] } = {},
): void {
  mockShareBatch = batchId;
  useShareIntentStore.setState({
    batchId,
    createdAtMs: 1_700_000_000_000,
    text: options.text ?? null,
    files: options.files ?? [SHARED_FILE],
    targetToken: null,
    failureReason: null,
  });
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  AppState.currentState = 'active';
  mockScreenFocused = true;
  mockFocusCleanups.clear();
  mockAppStateListeners.clear();
  mockShowConfirm.mockImplementation(() => ++mockDialogId);
  mockLocationAdapter.hasServicesEnabledAsync.mockReset().mockResolvedValue(true);
  mockLocationAdapter.getForegroundPermissionsAsync
    .mockReset()
    .mockResolvedValue({ granted: true, canAskAgain: true });
  mockLocationAdapter.requestForegroundPermissionsAsync
    .mockReset()
    .mockResolvedValue({ granted: true, canAskAgain: true });
  mockLocationAdapter.watchPositionAsync.mockReset();
  mockGetDatabase.mockReset().mockReturnValue(ACCOUNT_A_DB);
  (saveChatDraft as jest.Mock).mockReset().mockResolvedValue(undefined);
  (fireDueScheduledWithDevelopmentSender as jest.Mock).mockReset().mockResolvedValue(0);
  mockIsDevServer.mockReturnValue(false);
  mockGetContactsPermissionState.mockResolvedValue({ status: 'granted', canAskAgain: true });
  (pickAndSendContact as jest.Mock).mockResolvedValue(null);
  (acquireAndSendCurrentLocation as jest.Mock).mockResolvedValue({
    status: 'queued',
    tempGuid: 'temp-location',
  });
  mockGuid = GUID;
  mockFocus = undefined;
  mockFocusDate = undefined;
  mockShareBatch = undefined;
  mockRouteKey = 'chat-route-1';
  mockInsetBottom = 0;
  mockKbVisible = false;
  mockVoiceRecorderProps = undefined;
  mockMessagePreview = null;
  mockConsumeShareIntakeBatch.mockReset().mockResolvedValue(true);
  mockDiscardShareIntakeBatch.mockReset().mockResolvedValue(true);
  mockDrainShareIntake.mockReset().mockResolvedValue(undefined);
  mockGetShareIntakeReceipt.mockReset().mockResolvedValue(null);
  mockIsShareIntakeReceiptComplete.mockReset().mockReturnValue(false);
  mockAdmitShareIntakeTextDraft.mockReset().mockResolvedValue({ draft: 'Shared text' });
  for (const key of Object.keys(mockCaptured) as (keyof typeof mockCaptured)[]) {
    delete mockCaptured[key];
  }
  useShareIntentStore.getState().clear();
  useShareIntentStore.setState({ failureReason: null });
  useSessionStore.setState({
    serverInfo: {
      version: 'legacy-test',
      private_api: true,
      supports_message_part_topology: false,
    } as any,
  });
  useTypingStore.setState({ typing: {} });
  useMessagesMock.mockReturnValue({
    data: [],
    error: null,
    isCurrentWindow: true,
    isLoading: false,
    refreshWindow: mockRefreshWindow,
  });
  useChatHeaderMock.mockReturnValue({
    data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: null },
    error: null,
  });
  useNewScreenEffectMock.mockReturnValue({ effect: null, clear: jest.fn() });
  useChatBackgroundUriMock.mockReturnValue(null);
  mockUseChatSearch.mockReset().mockReturnValue({
    data: undefined,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isPending: true,
    results: [],
    totalCount: 0,
    query: '',
  });
});

/** Invoke a captured screen callback inside act (it mutates screen state). */
async function run(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
  });
}

/**
 * A long-pressed row necessarily belongs to the route's reactive window in production. Keep that
 * invariant in this route-level mock so the retraction guard can distinguish a current row from a
 * row that was genuinely deleted or redacted after selection.
 */
async function longPressMessage(msg: EnrichedMessage): Promise<void> {
  mockMessagePreview = msg;
  useMessagesMock.mockReturnValue({
    data: [msg],
    error: null,
    isCurrentWindow: true,
    isLoading: false,
    refreshWindow: mockRefreshWindow,
  });
  await run(() => mockCaptured.list!.onLongPressMessage(msg));
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

function hiddenComposerGateCount(tree: unknown): number {
  let count = 0;
  visitHostTree(tree, (node) => {
    const style = flattenTestStyle(node.props?.style);
    if (
      style.display === 'none' &&
      node.props?.pointerEvents === 'none' &&
      node.props?.accessibilityElementsHidden === true &&
      node.props?.importantForAccessibility === 'no-hide-descendants'
    ) {
      count += 1;
    }
  });
  return count;
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

describe('ChatScreen — exact native share handoff', () => {
  it('preserves share provenance and consumes only after composer admission is durable', async () => {
    configureRcsChat();
    stageExactShare();
    mockGetShareIntakeReceipt.mockResolvedValue({
      destination: { chatGuid: RCS_GUID, routeKind: 'existing_chat' },
      newChatPlan: null,
      items: {},
    });
    mockIsShareIntakeReceiptComplete.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await renderWithTheme(<ChatScreen />);

    await waitFor(() => expect(mockCaptured.composer?.initialAttachments).toEqual([SHARED_FILE]));
    expect(mockCaptured.composer?.onAdmissionApplied).toEqual(expect.any(Function));
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: SHARE_BATCH,
      files: [SHARED_FILE],
    });
    expect(mockConsumeShareIntakeBatch).not.toHaveBeenCalled();

    await act(async () => {
      mockCaptured.composer!.onAdmissionApplied({
        admittedAttachmentUris: [SHARED_FILE.uri],
        textAdmitted: false,
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockConsumeShareIntakeBatch).toHaveBeenCalledWith(
        SHARE_BATCH,
        expect.objectContaining({
          drainNext: false,
          lease: expect.objectContaining({ isCurrent: expect.any(Function) }),
        }),
      ),
    );
    expect(mockConsumeShareIntakeBatch.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDrainShareIntake.mock.invocationCallOrder[0]!,
    );
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['still loading after a cold start', null, false],
    ['known and RCS unavailable', { rcs: false }, true],
  ] as const)(
    'warns that the chat cannot take shared files only once capabilities are known (%s)',
    async (_label, serverInfo, warns) => {
      configureRcsChat(serverInfo ?? {});
      if (serverInfo === null) useSessionStore.setState({ serverInfo: null });
      stageExactShare();
      mockGetShareIntakeReceipt.mockResolvedValue({
        destination: { chatGuid: RCS_GUID, routeKind: 'existing_chat' },
        newChatPlan: null,
        items: {},
      });

      await renderWithTheme(<ChatScreen />);
      await waitFor(() => expect(mockGetShareIntakeReceipt).toHaveBeenCalled());
      await act(async () => {
        await Promise.resolve();
      });

      // This batch is already bound here (its receipt names this chat), so it cannot move: the
      // only way forward for its files is to remove them.
      if (warns) {
        expect(showDialog).toHaveBeenCalledWith(
          'This conversation can’t receive files',
          expect.any(String),
          [
            expect.objectContaining({ text: 'Not Now' }),
            expect.objectContaining({ text: 'Remove Files' }),
          ],
        );
      } else {
        expect(showDialog).not.toHaveBeenCalledWith(
          'This conversation can’t receive files',
          expect.anything(),
          expect.anything(),
        );
      }
    },
  );

  function filesDialogButtons(): { text: string; onPress?: () => void }[] {
    const call = jest
      .mocked(showDialog)
      .mock.calls.find(([title]) => title === 'This conversation can’t receive files');
    if (!call) throw new Error('Expected the shared-files dialog');
    return call[2] as { text: string; onPress?: () => void }[];
  }

  it('offers another conversation for a share nothing has used yet, keeping its files', async () => {
    configureRcsChat({ rcs: false });
    stageExactShare();
    mockGetShareIntakeReceipt.mockResolvedValue(null);

    await renderWithTheme(<ChatScreen />);
    await waitFor(() =>
      expect(filesDialogButtons().map((button) => button.text)).toEqual([
        'Not Now',
        'Choose Another Conversation',
      ]),
    );
    await act(async () => {
      filesDialogButtons().find((button) => button.text === 'Choose Another Conversation')!
        .onPress!();
    });

    expect(mockReplace).toHaveBeenCalledWith(`/new-chat?shareBatch=${SHARE_BATCH}`);
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();
  });

  it('holds shared text until the person chooses, then can use only the text here', async () => {
    configureRcsChat({ rcs: false });
    stageExactShare(SHARE_BATCH, { text: 'Shared text' });
    mockGetShareIntakeReceipt.mockResolvedValue(null);

    await renderWithTheme(<ChatScreen />);
    await waitFor(() =>
      expect(filesDialogButtons().map((button) => button.text)).toEqual([
        'Not Now',
        'Use Text Only',
        'Choose Another Conversation',
      ]),
    );
    // Merging the text would bind the whole share to this chat and rule out moving it.
    expect(mockAdmitShareIntakeTextDraft).not.toHaveBeenCalled();

    await act(async () => {
      filesDialogButtons().find((button) => button.text === 'Use Text Only')!.onPress!();
    });

    await waitFor(() => expect(mockAdmitShareIntakeTextDraft).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(discardShareIntakeItem).toHaveBeenCalledWith(
        expect.objectContaining({ itemIndex: SHARED_FILE.shareItemIndex }),
        expect.any(Function),
      ),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not mount an editable composer until shared text is durably merged', async () => {
    configureRcsChat();
    const receiptRead = deferred<Record<string, unknown> | null>();
    stageExactShare(SHARE_BATCH, { text: 'Shared text', files: [] });
    mockGetShareIntakeReceipt.mockReturnValue(receiptRead.promise);

    await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer).toBeUndefined();
    expect(screen.getByText('Preparing shared item…')).toBeTruthy();

    await act(async () => {
      receiptRead.resolve({
        destination: { chatGuid: RCS_GUID, routeKind: 'existing_chat' },
        newChatPlan: null,
        items: {},
      });
      await receiptRead.promise;
    });

    await waitFor(() => expect(mockAdmitShareIntakeTextDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockCaptured.composer?.initialText).toBe('Shared text'));
    expect(screen.queryByText('Preparing shared item…')).toBeNull();
  });

  it('redirects its own share to the receipt destination without asking to discard it', async () => {
    configureRcsChat();
    stageExactShare();
    mockGetShareIntakeReceipt.mockResolvedValue({
      destination: { chatGuid: 'iMessage;-;elsewhere@example.test', routeKind: 'existing_chat' },
      newChatPlan: null,
      items: {},
    });
    // Stand in for Expo Router running the removal guard for this replace.
    mockReplace.mockImplementationOnce(() => {
      const guard = mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
      if (guard?.[0]) guard[1]({ data: { action: { type: 'REPLACE' } } });
    });

    await renderWithTheme(<ChatScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(mockNavigationDispatch).toHaveBeenCalledWith({ type: 'REPLACE' });
  });

  it('returns a plan-owned share to new-chat instead of exposing the wrong composer', async () => {
    configureRcsChat();
    stageExactShare();
    mockGetShareIntakeReceipt.mockResolvedValue({
      destination: null,
      newChatPlan: { address: '+15551234567' },
      items: {},
    });

    await renderWithTheme(<ChatScreen />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(SHARE_BATCH)}`,
      ),
    );
    expect(mockCaptured.composer).toBeUndefined();
  });

  it('does not adopt an ambient share when the route names a different batch', async () => {
    configureRcsChat();
    useShareIntentStore.setState({
      batchId: SHARE_BATCH,
      text: 'Ambient share must not leak',
      files: [SHARED_FILE],
      targetToken: null,
    });
    mockShareBatch = OTHER_SHARE_BATCH;

    await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer?.initialAttachments).toBeUndefined();
    expect(mockCaptured.composer?.onAdmissionApplied).toBeUndefined();
    expect(mockConsumeShareIntakeBatch).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().batchId).toBe(SHARE_BATCH);
  });

  it('discards the exact pending batch before allowing route removal', async () => {
    configureRcsChat();
    stageExactShare();
    await renderWithTheme(<ChatScreen />);

    const latestGuardCall =
      mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
    expect(latestGuardCall?.[0]).toBe(true);
    await run(() => latestGuardCall?.[1]({ data: { action: { type: 'GO_BACK' } } }));

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard shared item?', onConfirm: expect.any(Function) }),
    );
    const confirmation = mockShowConfirm.mock.calls[0]?.[0] as
      { onConfirm?: () => void } | undefined;
    await act(async () => {
      confirmation?.onConfirm?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockDiscardShareIntakeBatch).toHaveBeenCalledWith(
        SHARE_BATCH,
        expect.objectContaining({
          drainNext: false,
          lease: expect.objectContaining({ isCurrent: expect.any(Function) }),
        }),
      ),
    );
    expect(mockConsumeShareIntakeBatch).not.toHaveBeenCalled();
    expect(mockNavigationDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    expect(mockNavigationDispatch.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDrainShareIntake.mock.invocationCallOrder[0]!,
    );
  });
});

describe('ChatScreen — long-press → SelectedMessage mapping', () => {
  it('does not project iMessage reaction metadata into the retired picker', async () => {
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
    await longPressMessage(msg);

    const sel = mockCaptured.overlay!.selected;
    expect(sel.guid).toBe('m7');
    expect(sel.mine).toEqual([]);
    expect(sel.myEmojis).toEqual([]);
    expect(sel.canReact).toBe(false);
    expect(sel.isFromMe).toBe(false);
    expect(sel.isTemp).toBe(false);
  });

  it('flags a temp (optimistic) message via the temp- guid prefix', async () => {
    await renderWithTheme(<ChatScreen />);
    await longPressMessage(makeMsg({ guid: 'temp-abc', isFromMe: 1 }));
    expect(mockCaptured.overlay!.selected.isTemp).toBe(true);
    expect(mockCaptured.overlay!.selected.isFromMe).toBe(true);
  });
});

describe('ChatScreen — RCS reaction routing', () => {
  it('routes a classic reaction to react() with no emoji', async () => {
    configureRcsChat();
    await renderWithTheme(<ChatScreen />);
    await longPressMessage(makeMsg({ guid: RCS_MESSAGE_GUID, text: 'hey' }));
    await run(() => mockCaptured.overlay!.onReact('love'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: RCS_GUID,
        targetGuid: RCS_MESSAGE_GUID,
        reaction: 'love',
        emoji: undefined,
        selectedMessageText: 'hey',
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });

  it('routes an arbitrary emoji reaction carrying the glyph', async () => {
    configureRcsChat();
    await renderWithTheme(<ChatScreen />);
    await longPressMessage(makeMsg({ guid: RCS_MESSAGE_GUID }));
    await run(() => mockCaptured.overlay!.onReact('emoji', '🎉'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: 'emoji', emoji: '🎉', targetGuid: RCS_MESSAGE_GUID }),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });
});

describe('ChatScreen — send routing', () => {
  it('offers only a single JPEG/PNG upload in a proven existing iMessage DM', async () => {
    mockGuid = 'any;-;+15551234567';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_attachment_upload: true,
      } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 2,
        guid: mockGuid,
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer).toEqual(
      expect.objectContaining({
        onSendAttachments: expect.any(Function),
        onSendTextAttachment: undefined,
        onPickContact: undefined,
        onStartVoice: undefined,
        onTyping: undefined,
        onSendMention: undefined,
        mentionParticipants: [],
      }),
    );
    const image = { uri: 'file:///photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', size: 42 };
    await act(async () => {
      await mockCaptured.composer!.onSendAttachments([image]);
    });
    expect(sendImages).toHaveBeenCalledWith(
      { chatGuid: mockGuid, images: [image], service: 'iMessage' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );
    await act(async () => {
      await mockCaptured.composer!.onSendAttachments([image, { ...image, uri: 'file:///two.jpg' }]);
    });
    expect(sendImages).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Choose one JPEG or PNG image no larger than 10 MiB');
  });

  it('offers PDF only when the separate PDF helper capability is advertised', async () => {
    mockGuid = 'any;-;+15551234567';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        supports_imessage_attachment_upload: true,
        supports_imessage_pdf_attachment_upload: true,
      } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 2,
        guid: mockGuid,
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    const pdf = {
      uri: 'file:///report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    };
    await act(async () => {
      await mockCaptured.composer!.onSendAttachments([pdf]);
    });
    expect(sendImages).toHaveBeenCalledWith(
      { chatGuid: mockGuid, images: [pdf], service: 'iMessage' },
      expect.anything(),
      presentSendIssue,
      expect.any(Function),
    );
    expect(sendImages).toHaveBeenCalledTimes(1);
  });

  it('routes one JPEG or PDF with text through one iMessage send only with caption capability', async () => {
    mockGuid = 'any;-;+15551234567';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        supports_imessage_attachment_upload: true,
        supports_imessage_pdf_attachment_upload: true,
        supports_imessage_attachment_caption_upload: true,
        supports_imessage_text_with_attachment: false,
      } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 2,
        guid: mockGuid,
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer!.onSendTextAttachment).toEqual(expect.any(Function));
    const pdf = {
      uri: 'file:///report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    };
    await expect(mockCaptured.composer!.onSendTextAttachment('  caption  ', pdf)).resolves.toBe(
      true,
    );
    expect(sendTextAttachment).toHaveBeenCalledWith(
      { chatGuid: mockGuid, image: pdf, text: '  caption  ', service: 'iMessage' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );
    expect(send).not.toHaveBeenCalled();
    expect(sendImages).not.toHaveBeenCalled();
  });

  it('does not expose caption send for image-only support or an unproven chat', async () => {
    mockGuid = 'any;-;+15551234567';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        supports_imessage_attachment_upload: true,
        supports_imessage_text_with_attachment: true,
      } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 2,
        guid: mockGuid,
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer!.onSendTextAttachment).toBeUndefined();

    await act(async () => {
      useSessionStore.setState({
        serverInfo: {
          version: 'test',
          supports_imessage_attachment_upload: true,
          supports_imessage_attachment_caption_upload: true,
        } as any,
      });
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 3,
        guid: mockGuid,
        style: 43,
        participantCount: 2,
        handleServices: 'iMessage',
      },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer!.onSendTextAttachment).toBeUndefined();
  });

  it('does not expose the image tray for an SMS handle or a stale previous-chat header', async () => {
    mockGuid = 'any;-;+15551234567';
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_attachment_upload: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 2,
        guid: 'any;-;+15557654321',
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer!.onSendAttachments).toBeUndefined();

    useChatHeaderMock.mockReturnValue({
      data: {
        id: 3,
        guid: mockGuid,
        style: 45,
        participantCount: 1,
        handleServices: 'SMS',
      },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer!.onSendAttachments).toBeUndefined();
  });

  it('offers and routes one RCS attachment-plus-text send only when the server advertises it', async () => {
    configureRcsChat({ supports_rcs_text_with_attachment: true });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer!.onSendTextAttachment).toEqual(expect.any(Function));

    const item = {
      uri: 'file:///caption.jpg',
      name: 'caption.jpg',
      mimeType: 'image/jpeg',
      size: 42,
    };
    await expect(mockCaptured.composer!.onSendTextAttachment('caption', item)).resolves.toBe(true);
    expect(sendTextAttachment).toHaveBeenCalledWith(
      {
        chatGuid: RCS_GUID,
        image: item,
        text: 'caption',
        service: 'RCS',
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );
    expect(send).not.toHaveBeenCalled();
    expect(sendImages).not.toHaveBeenCalled();
  });

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
      { chatGuid: GUID, text: 'hello' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );
  });

  it('keeps plain iMessage text and local actions while hiding helper-only affordances', async () => {
    useSessionStore.setState({ serverInfo: null });
    await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer).toEqual(
      expect.objectContaining({
        onSend: expect.any(Function),
        onSendAttachments: undefined,
        onSendTextAttachment: undefined,
        onPickFiles: undefined,
        onPickContact: undefined,
        onStartVoice: undefined,
        onTyping: undefined,
      }),
    );
    expect(mockCaptured.composer).not.toHaveProperty('replyTo');
    expect(mockCaptured.composer).not.toHaveProperty('editingText');
    expect(mockCaptured.composer).not.toHaveProperty('subjectEnabled');
    expect(mockCaptured.composer).not.toHaveProperty('effectsEnabled');
    expect(mockCaptured.list?.onSwipeReply).toBeUndefined();
    expect(screen.queryByText('💥')).toBeNull();

    await run(() => mockCaptured.composer!.onSend('plain still works'));
    expect(send).toHaveBeenCalledWith(
      { chatGuid: GUID, text: 'plain still works' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );

    await longPressMessage(makeMsg({ guid: 'local-action-message', text: 'keep me local' }));
    expect(mockCaptured.overlay).toEqual(
      expect.objectContaining({
        selected: expect.objectContaining({ canReact: false }),
        onCopy: expect.any(Function),
        onDelete: expect.any(Function),
        onForward: undefined,
      }),
    );
  });

  it('preserves supported RCS reaction, attachment, contact, typing, and voice controls', async () => {
    configureRcsChat({ supports_send_contact: false });
    await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer).toEqual(
      expect.objectContaining({
        onSendAttachments: expect.any(Function),
        onPickFiles: expect.any(Function),
        onPickContact: expect.any(Function),
        onStartVoice: expect.any(Function),
        onTyping: expect.any(Function),
      }),
    );
    expect(mockCaptured.composer).not.toHaveProperty('effectsEnabled');
    expect(mockCaptured.overlay?.onForward).toEqual(expect.any(Function));

    await longPressMessage(makeMsg({ guid: RCS_MESSAGE_GUID }));
    expect(mockCaptured.overlay?.selected).toEqual(expect.objectContaining({ canReact: true }));

    await act(async () => {
      useSessionStore.setState({
        serverInfo: { version: 'test', private_api: true, rcs: false } as any,
      });
    });
    expect(mockCaptured.composer).toEqual(
      expect.objectContaining({
        onSendAttachments: undefined,
        onPickFiles: undefined,
        onPickContact: undefined,
        onStartVoice: undefined,
        onTyping: undefined,
      }),
    );
  });

  it('offers Send Contact for iMessage only with the live capability and an exact DM', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_send_contact: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer?.onPickContact).toEqual(expect.any(Function));

    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 43, participantCount: 2, handleServices: 'iMessage' },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer?.onPickContact).toBeUndefined();

    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test' } as any });
    });
    expect(mockCaptured.composer?.onPickContact).toBeUndefined();
  });

  function configureLocationChat(): void {
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://location.test',
      password: 'synthetic-location-credential',
      serverInfo: { version: 'test', supports_imessage_location: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
  }

  const changeLocationAppState = (state: 'active' | 'background'): void => {
    AppState.currentState = state;
    for (const listener of [...mockAppStateListeners]) listener(state);
  };

  async function beginLocationPermission(): Promise<
    (value: { granted: boolean; canAskAgain: boolean }) => void
  > {
    let resolve!: (value: { granted: boolean; canAskAgain: boolean }) => void;
    mockLocationAdapter.getForegroundPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    });
    mockLocationAdapter.requestForegroundPermissionsAsync.mockImplementation(() => {
      changeLocationAppState('background'); // Android pauses Gator for its own permission Activity.
      return new Promise((done) => {
        resolve = done;
      });
    });
    await act(async () => mockCaptured.composer?.onShareLocation());
    await act(async () => mockShowConfirm.mock.calls.at(-1)?.[0].onConfirm());
    expect(mockLocationAdapter.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
    return resolve;
  }

  it('confirms one current-location send only for a capable exact iMessage DM', async () => {
    configureLocationChat();
    const view = await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer?.onShareLocation).toEqual(expect.any(Function));

    await act(async () => mockCaptured.composer?.onShareLocation());
    expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
    const confirmation = mockShowConfirm.mock.calls[0]?.[0] as
      { onConfirm?: () => void } | undefined;
    expect(confirmation).toEqual(
      expect.objectContaining({
        title: 'Send Current Location?',
        confirmText: 'Send Location',
        onConfirm: expect.any(Function),
      }),
    );

    await act(async () => {
      confirmation?.onConfirm?.();
      confirmation?.onConfirm?.();
      await Promise.resolve();
    });
    expect(acquireAndSendCurrentLocation).toHaveBeenCalledTimes(1);
    expect(acquireAndSendCurrentLocation).toHaveBeenCalledWith(
      GUID,
      expect.objectContaining({
        foregroundLifecycle: expect.objectContaining({
          isActive: expect.any(Function),
          subscribeToInactive: expect.any(Function),
        }),
        accountLease: expect.objectContaining({ isCurrent: expect.any(Function) }),
        reportIssue: presentSendIssue,
      }),
    );

    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 43, participantCount: 2, handleServices: 'iMessage' },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer?.onShareLocation).toBeUndefined();

    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'SMS' },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer?.onShareLocation).toBeUndefined();

    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test' } as any });
    });
    expect(mockCaptured.composer?.onShareLocation).toBeUndefined();
  });

  it('shows location denial recovery after the permission Activity returns to the foreground', async () => {
    configureLocationChat();
    await renderWithTheme(<ChatScreen />);
    const resolve = await beginLocationPermission();
    await act(async () => resolve({ granted: false, canAskAgain: true }));
    expect(showDialog).not.toHaveBeenCalled();
    await act(async () => changeLocationAppState('active'));
    expect(showDialog).toHaveBeenCalledWith('Location Permission Needed', expect.any(String), [
      expect.objectContaining({ text: 'Not Now' }),
      expect.objectContaining({ text: 'Try Again' }),
    ]);
    expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
    expect(mockLocationAdapter.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('requires a fresh one-shot location send confirmation after a prompted grant, including a Home interval', async () => {
    configureLocationChat();
    await renderWithTheme(<ChatScreen />);
    const resolve = await beginLocationPermission();
    await act(async () => {
      changeLocationAppState('background');
      resolve({ granted: true, canAskAgain: true });
    });
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    await act(async () => changeLocationAppState('active'));
    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
    expect(mockShowConfirm.mock.calls[1]?.[0].message).toContain('Nothing has been sent yet');
    expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
    expect(mockLocationAdapter.watchPositionAsync).not.toHaveBeenCalled();
    await act(async () => {
      mockShowConfirm.mock.calls[1]?.[0].onConfirm();
      mockShowConfirm.mock.calls[1]?.[0].onConfirm();
    });
    expect(acquireAndSendCurrentLocation).toHaveBeenCalledTimes(1);
  });

  it.each(['blur', 'unmount', 'account', 'capability'] as const)(
    'discards a late location permission result after %s retirement',
    async (reason) => {
      configureLocationChat();
      const view = await renderWithTheme(<ChatScreen />);
      const resolve = await beginLocationPermission();
      // RNTL's unmount already owns act. Complete that commit before settling native work.
      if (reason === 'unmount') await view.unmount();
      await act(async () => {
        if (reason === 'blur') {
          mockScreenFocused = false;
          for (const cleanup of [...mockFocusCleanups]) cleanup();
        } else if (reason === 'account') await pauseRealtimeDeliveries();
        else if (reason === 'capability')
          useSessionStore.setState((state) => ({
            sendCapabilityRevision: state.sendCapabilityRevision + 1,
          }));
        resolve({ granted: true, canAskAgain: true });
        changeLocationAppState('active');
      });
      expect(mockShowConfirm).toHaveBeenCalledTimes(1);
      expect(showDialog).not.toHaveBeenCalled();
      expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
      expect(mockLocationAdapter.watchPositionAsync).not.toHaveBeenCalled();
    },
  );

  it('retires a retained location confirmation when Home is pressed after granting permission', async () => {
    configureLocationChat();
    await renderWithTheme(<ChatScreen />);
    const resolve = await beginLocationPermission();
    await act(async () => {
      changeLocationAppState('active');
      resolve({ granted: true, canAskAgain: true });
    });
    const confirmation = mockShowConfirm.mock.calls[1]?.[0];
    const ownedId = mockShowConfirm.mock.results[1]?.value;
    await act(async () => {
      changeLocationAppState('background');
      changeLocationAppState('active');
      confirmation.onConfirm();
    });
    expect(mockDismissLocationDialog).toHaveBeenCalledWith(ownedId);
    expect(acquireAndSendCurrentLocation).not.toHaveBeenCalled();
  });

  it('still cancels an already-permitted location acquisition when the foreground lifetime ends', async () => {
    configureLocationChat();
    const cancel = jest.fn();
    (acquireAndSendCurrentLocation as jest.Mock).mockImplementationOnce((_guid, options) => {
      options.foregroundLifecycle.subscribeToInactive(cancel);
      return new Promise(() => undefined);
    });
    await renderWithTheme(<ChatScreen />);
    await act(async () => mockCaptured.composer?.onShareLocation());
    await act(async () => mockShowConfirm.mock.calls[0]?.[0].onConfirm());
    expect(acquireAndSendCurrentLocation).toHaveBeenCalledTimes(1);
    expect(mockLocationAdapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    await act(async () => changeLocationAppState('background'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('offers iMessage typing only for a proven chat with its separate live capability', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_typing: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer?.onTyping).toEqual(expect.any(Function));

    await act(async () => {
      useTypingStore.setState({ typing: { [GUID]: true } });
    });
    expect(screen.getByText('typing…')).toBeTruthy();

    await act(async () => mockCaptured.composer?.onTyping(true));
    expect(sendTyping).toHaveBeenCalledWith(GUID, true);

    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test' } as any });
    });
    expect(mockCaptured.composer?.onTyping).toBeUndefined();
    expect(screen.queryByText('typing…')).toBeNull();
  });

  it('cancels a reply permanently when its capability is revoked', async () => {
    const enabled = { version: 'test', supports_imessage_replies: true } as any;
    useSessionStore.setState({ serverInfo: enabled });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    const target = makeMsg({
      guid: 'reply-revoked',
      text: 'Reply target',
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
    });
    await longPressMessage(target);
    await run(() => mockCaptured.overlay!.onReply());
    expect(mockCaptured.composer?.replyTo?.guid).toBe(target.guid);
    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test' } as any });
    });
    expect(mockCaptured.composer?.replyTo).toBeUndefined();
    await act(async () => {
      useSessionStore.setState({ serverInfo: enabled });
    });
    expect(mockCaptured.composer?.replyTo).toBeUndefined();
  });

  it('cancels editing when the target disappears even if the row returns', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_edit: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);
    const target = makeMsg({
      guid: 'edit-removed',
      text: 'Edit target',
      isFromMe: 1,
      sendState: 'sent',
      dateCreated: Date.now(),
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
    });
    await longPressMessage(target);
    await run(() => mockCaptured.overlay!.onEdit());
    expect(mockCaptured.composer?.editingText).toBe('Edit target');
    const currentWindow = useMessagesMock.mock.results.at(-1)!.value;
    // The database confirms the message is gone, not merely outside the loaded window.
    mockMessagePreview = null;
    useMessagesMock.mockReturnValue({ ...currentWindow, data: [] });
    await view.rerender(<ChatScreen />);
    await waitFor(() => expect(mockCaptured.composer?.editingText).toBeUndefined());
    useMessagesMock.mockReturnValue({ ...currentWindow, data: [target] });
    await view.rerender(<ChatScreen />);
    expect(mockCaptured.composer?.editingText).toBeUndefined();
  });

  it('keeps an in-progress edit when search moves the window away from its message', async () => {
    // Search, the unread chip and thread jumps load a window of +-150 messages around their
    // target; a newer message being edited can fall outside it while it still exists.
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_edit: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);
    const target = makeMsg({
      guid: 'edit-out-of-window',
      text: 'Edit target',
      isFromMe: 1,
      sendState: 'sent',
      dateCreated: Date.now(),
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
    });
    await longPressMessage(target);
    await run(() => mockCaptured.overlay!.onEdit());
    expect(mockCaptured.composer?.editingText).toBe('Edit target');
    const currentWindow = useMessagesMock.mock.results.at(-1)!.value;
    const oldHit = makeMsg({ guid: 'weeks-old-hit', text: 'Old search hit', dateCreated: 1 });
    jest.mocked(getMessagePreviewByGuid).mockClear();
    useMessagesMock.mockReturnValue({ ...currentWindow, data: [oldHit] });
    await view.rerender(<ChatScreen />);
    await waitFor(() =>
      expect(getMessagePreviewByGuid).toHaveBeenCalledWith(
        expect.anything(),
        GUID,
        'edit-out-of-window',
        0,
      ),
    );
    await run(() => undefined);
    expect(mockCaptured.composer?.editingText).toBe('Edit target');
    useMessagesMock.mockReturnValue({ ...currentWindow, data: [target] });
    await view.rerender(<ChatScreen />);
    expect(mockCaptured.composer?.editingText).toBe('Edit target');
  });

  it('offers the voice recorder only with the separate iMessage voice capability', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_voice_upload: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);
    expect(mockCaptured.composer?.onStartVoice).toEqual(expect.any(Function));
    expect(sendVoice).not.toHaveBeenCalled();
    await run(() => mockCaptured.composer!.onStartVoice());
    expect(screen.getByTestId('voice-recorder')).toBeTruthy();

    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test', private_api: true } as any });
    });
    expect(mockCaptured.composer?.onStartVoice).toBeUndefined();
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
    await act(async () => {
      useSessionStore.setState({
        serverInfo: { version: 'test', supports_imessage_voice_upload: true } as any,
      });
    });
    expect(mockCaptured.composer?.onStartVoice).toEqual(expect.any(Function));
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
  });

  it('ignores injected effect arguments and sends ordinary text', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onSend('party', 'com.apple.MobileSMS.expressivesend.impact'),
    );
    expect(send).toHaveBeenCalledWith(
      { chatGuid: GUID, text: 'party' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
      expect.any(Function),
    );
  });

  it('exposes the narrow effect action only for a proven exact one-to-one iMessage chat', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_effects: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 1,
        guid: GUID,
        style: 45,
        participantCount: 1,
        handleServices: 'iMessage',
      },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer?.onSendEffect).toEqual(expect.any(Function));
    await expect(
      mockCaptured.composer!.onSendEffect('party', 'com.apple.MobileSMS.expressivesend.impact'),
    ).resolves.toBe(true);
    expect(sendEffect).toHaveBeenCalledWith(
      {
        chatGuid: GUID,
        text: 'party',
        effectId: 'com.apple.MobileSMS.expressivesend.impact',
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );

    useChatHeaderMock.mockReturnValue({
      data: {
        id: 1,
        guid: GUID,
        style: 43,
        participantCount: 2,
        handleServices: 'iMessage,iMessage',
      },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer?.onSendEffect).toBeUndefined();

    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await act(async () => {
      useSessionStore.setState({ serverInfo: { version: 'test' } as any });
    });
    expect(mockCaptured.composer?.onSendEffect).toBeUndefined();
  });

  it('exposes formatted text for a proven style-45 multi-alias iMessage chat', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_formatted_messages: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 1,
        guid: GUID,
        style: 45,
        participantCount: 2,
        handleServices: 'iMessage,iMessage',
      },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer?.onSendFormatted).toEqual(expect.any(Function));
    await expect(
      mockCaptured.composer!.onSendFormatted('A B', [
        { start: 1, length: 1, styles: ['underline'] },
      ]),
    ).resolves.toBe(true);
    expect(sendFormatted).toHaveBeenCalledWith(
      {
        chatGuid: GUID,
        text: 'A B',
        textFormatting: [{ start: 1, length: 1, styles: ['underline'] }],
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );
  });

  it('exposes exact group participants for the narrow mention action and rejects an ambiguous roster', async () => {
    mockGuid = 'iMessage;+;mention-group';
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_mentions: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: {
        id: 7,
        guid: mockGuid,
        style: 43,
        participantCount: 2,
        handleServices: 'iMessage,iMessage',
        participantNames: JSON.stringify(['Alice', 'Bob']),
        participantAddresses: 'alice@example.test|||+15551234567',
      },
      error: null,
    });
    const view = await renderWithTheme(<ChatScreen />);

    expect(mockCaptured.composer?.mentionParticipants).toEqual([
      { address: 'alice@example.test', label: 'Alice' },
      { address: '+15551234567', label: 'Bob' },
    ]);
    expect(mockCaptured.composer?.onSendMention).toEqual(expect.any(Function));
    await expect(
      mockCaptured.composer!.onSendMention('Hi Alice', [
        { start: 3, length: 5, address: 'alice@example.test' },
      ]),
    ).resolves.toBe(true);
    expect(sendMention).toHaveBeenCalledWith(
      {
        chatGuid: mockGuid,
        text: 'Hi Alice',
        mentions: [{ start: 3, length: 5, address: 'alice@example.test' }],
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      presentSendIssue,
    );

    useChatHeaderMock.mockReturnValue({
      data: {
        id: 7,
        guid: mockGuid,
        style: 43,
        participantCount: 2,
        handleServices: 'iMessage,iMessage',
        participantNames: JSON.stringify(['Alice', 'Alice duplicate']),
        participantAddresses: 'alice@example.test|||alice@example.test',
      },
      error: null,
    });
    await act(async () => view.rerender(<ChatScreen />));
    expect(mockCaptured.composer?.mentionParticipants).toEqual([]);
    expect(mockCaptured.composer?.onSendMention).toBeUndefined();
  });

  it('retains effect text after definite refusal and consumes it after outcome-unknown', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_imessage_effects: true } as any,
    });
    useChatHeaderMock.mockReturnValue({
      data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: 'iMessage' },
      error: null,
    });
    await renderWithTheme(<ChatScreen />);

    (sendEffect as jest.Mock).mockResolvedValueOnce({
      status: 'rejected',
      tempGuid: 'temp-reject',
    });
    await expect(
      mockCaptured.composer!.onSendEffect('keep me', 'com.apple.MobileSMS.expressivesend.loud'),
    ).resolves.toBe(false);
    expect(showDialog).toHaveBeenCalledWith(
      'Effect Not Sent',
      'Your message is still here so you can try again.',
    );

    (sendEffect as jest.Mock).mockResolvedValueOnce({
      status: 'outcome-unknown',
      tempGuid: 'temp-unknown',
    });
    await expect(
      mockCaptured.composer!.onSendEffect(
        'maybe sent',
        'com.apple.messages.effect.CKConfettiEffect',
      ),
    ).resolves.toBe(true);
    expect(showDialog).toHaveBeenCalledWith(
      'Effect Not Confirmed',
      'It may have been delivered. Check the conversation before sending another copy.',
    );
    expect(sendEffect).toHaveBeenCalledTimes(2);
  });

  it('threads the mounted account lease through DEV plain-text sends', async () => {
    mockIsDevServer.mockReturnValue(true);
    await renderWithTheme(<ChatScreen />);
    const plainAdmission = mockCaptured.composer!.onSend('plain-dev') as Promise<boolean>;
    await expect(plainAdmission).resolves.toBe(false);
    const accountLease = (devSendFake as jest.Mock).mock.calls[0]![3];
    expect(devSendFake).toHaveBeenCalledWith(
      GUID,
      'plain-dev',
      undefined,
      accountLease,
      expect.any(Function),
    );

    expect(mockCaptured.overlay).not.toHaveProperty('onReply');
    expect(accountLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
  });

  it('shows recovery guidance when Send Contact permission is denied', async () => {
    configureRcsChat();
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
    configureRcsChat();
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
      { text: string; onPress?: () => void }[] | undefined;
    await run(() => buttons?.find((button) => button.text === 'Continue')?.onPress?.());
    await waitFor(() => expect(pickAndSendContact).toHaveBeenCalledTimes(1));
  });

  it('keeps a canceled Send Contact picker silent', async () => {
    configureRcsChat();
    (pickAndSendContact as jest.Mock).mockResolvedValueOnce(null);
    await renderWithTheme(<ChatScreen />);

    await run(() => mockCaptured.composer!.onPickContact());
    await waitFor(() => expect(pickAndSendContact).toHaveBeenCalledTimes(1));

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('wires microphone denial and native-request errors to recovery dialogs', async () => {
    configureRcsChat();
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

  it('accepts a voice recording only after its durable queue callback', async () => {
    configureRcsChat();
    let markQueued!: (tempGuid: string) => void;
    let finishOperation!: (value: { tempGuid: string }) => void;
    (sendImage as jest.Mock).mockImplementationOnce(
      (
        _args: unknown,
        _lease: unknown,
        _reportIssue: unknown,
        onQueued: (tempGuid: string) => void,
      ) => {
        markQueued = onQueued;
        return new Promise((resolve) => {
          finishOperation = resolve;
        });
      },
    );
    await renderWithTheme(<ChatScreen />);
    await run(() => mockCaptured.composer!.onStartVoice());
    await waitFor(() => expect(mockVoiceRecorderProps).toBeDefined());

    const admission = mockVoiceRecorderProps!.onSend('file:///cache/voice.m4a') as Promise<boolean>;
    let settled = false;
    void admission.then(() => {
      settled = true;
    });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);
    expect(sendImage).toHaveBeenCalledWith(
      {
        chatGuid: RCS_GUID,
        image: {
          uri: 'file:///cache/voice.m4a',
          name: 'voice.m4a',
          mimeType: 'audio/mp4',
          size: 0,
        },
      },
      expect.anything(),
      presentSendIssue,
      expect.any(Function),
    );

    markQueued('temp-voice');
    await expect(admission).resolves.toBe(true);
    finishOperation({ tempGuid: 'temp-voice' });
  });
});

describe('ChatScreen — typing indicator', () => {
  it('renders the TypingBubble when the typing store flags this chat', async () => {
    configureRcsChat();
    useTypingStore.setState({ typing: { [RCS_GUID]: true } });
    await renderWithTheme(<ChatScreen />);
    expect(await screen.findByText('typing…')).toBeTruthy();
  });

  it('does not render the TypingBubble when idle', async () => {
    configureRcsChat();
    await renderWithTheme(<ChatScreen />);
    expect(screen.queryByText('typing…')).toBeNull();
  });
});

describe('ChatScreen — current-chat search orchestration', () => {
  it('debounces a trimmed query, anchors its exact first hit, and preserves the ordinary-route composer', async () => {
    jest.useFakeTimers();
    const newest = makeSearchHit(901, 'search-newest-guid');
    const middle = makeSearchHit(802, 'search-middle-guid');
    const hits = [newest, middle];
    let needleHits = hits;
    mockUseChatSearch.mockImplementation(
      (_chatGuid: string, query: string, _accountLease: unknown) => {
        const ready = query === 'needle';
        return {
          data: ready ? { pages: [{ results: needleHits, totalCount: 3 }] } : undefined,
          fetchNextPage: jest.fn(),
          hasNextPage: ready,
          isError: false,
          isFetchingNextPage: false,
          isPending: !ready,
          results: ready ? needleHits : [],
          totalCount: ready ? 3 : 0,
          query,
        };
      },
    );
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;

    try {
      view = await renderWithTheme(<ChatScreen />);
      const composerInstance = mockCaptured.composer!.__instance;
      expect(mockCaptured.header?.searchActive).toBe(false);
      expect(mockCaptured.composer?.active).toBe(true);

      await run(() => mockCaptured.header!.onSearchPress());
      expect(mockCaptured.header?.searchActive).toBe(true);
      expect(mockCaptured.search?.status).toBe('Type at least 3 characters');
      expect(mockCaptured.composer?.__instance).toBe(composerInstance);
      expect(mockCaptured.composer?.active).toBe(false);
      expect(mockCaptured.list?.onLongPressMessage).toBeUndefined();
      expect(mockCaptured.list?.onSwipeReply).toBeUndefined();
      expect(mockCaptured.list?.onToggleSelect).toBeUndefined();

      await run(() => mockCaptured.search!.onChangeText('  needle  '));
      expect(mockCaptured.search?.value).toBe('  needle  ');
      expect(mockCaptured.search?.status).toBe('Searching…');
      expect(mockUseChatSearch.mock.calls.at(-1)?.[1]).toBe('');

      await act(async () => {
        jest.advanceTimersByTime(249);
      });
      expect(mockUseChatSearch.mock.calls.at(-1)?.[1]).toBe('');

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(mockUseChatSearch).toHaveBeenLastCalledWith(
        GUID,
        'needle',
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      );
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: newest.id,
        guid: newest.guid,
      });
      expect(mockCaptured.list?.focusMessageId).toBe(newest.id);
      expect(mockCaptured.list?.focusGuid).toBe(newest.guid);
      expect(mockCaptured.search?.status).toBe('Result 3 of 3');
      expect(mockCaptured.search?.canGoOlder).toBe(true);
      expect(mockCaptured.search?.canGoNewer).toBe(false);

      // Whitespace is presentation-only after trimming. It must not clear the selected hit while
      // React correctly treats the normalized query state update as a no-op.
      await run(() => mockCaptured.search!.onChangeText(' needle '));
      expect(mockCaptured.list?.focusMessageId).toBe(newest.id);
      expect(mockCaptured.list?.focusGuid).toBe(newest.guid);
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: newest.id,
        guid: newest.guid,
      });

      await run(() => mockCaptured.search!.onChangeText('different'));
      expect(mockCaptured.list?.focusMessageId).toBeUndefined();
      expect(mockCaptured.list?.focusGuid).toBeUndefined();
      needleHits = [makeSearchHit(999, 'stale-refreshed-needle-guid'), ...hits];
      await act(async () => view?.rerender(<ChatScreen />));
      expect(mockCaptured.list?.focusMessageId).toBeUndefined();
      expect(mockCaptured.list?.focusGuid).toBeUndefined();

      await run(() => mockCaptured.header!.onSearchPress());
      expect(mockCaptured.header?.searchActive).toBe(false);
      expect(mockCaptured.composer?.__instance).toBe(composerInstance);
      expect(mockCaptured.composer?.active).toBe(true);
      expect(mockCaptured.list?.focusMessageId).toBeUndefined();
      expect(mockCaptured.list?.focusGuid).toBeUndefined();
      expect(mockCaptured.list?.onLongPressMessage).toEqual(expect.any(Function));
      expect(mockCaptured.list?.onSwipeReply).toBeUndefined();
      expect(mockSetParams).toHaveBeenLastCalledWith({ focus: '', focusDate: '' });

      await run(() => mockCaptured.header!.onSearchPress());
      expect(mockCaptured.search?.value).toBe('');
      expect(mockCaptured.search?.status).toBe('Type at least 3 characters');
      expect(mockCaptured.search?.canGoOlder).toBe(false);
      expect(mockCaptured.search?.canGoNewer).toBe(false);
      expect(mockUseChatSearch.mock.calls.at(-1)?.[1]).toBe('');
      expect(mockCaptured.list?.focusMessageId).toBeUndefined();
      expect(mockCaptured.list?.focusGuid).toBeUndefined();
      expect(mockCaptured.composer?.__instance).toBe(composerInstance);
      await run(() => mockCaptured.header!.onSearchPress());
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it('keeps a focused-route composer mounted and hidden until the newest window is current', async () => {
    mockFocus = 'route-focus-guid';
    mockFocusDate = '123456';
    let newestWindowCurrent = false;
    const retainedRows = [makeMsg({ guid: 'route-focus-guid' })];
    useMessagesMock.mockImplementation(
      (_chatGuid: string, _limit: number, anchor?: { guid: string; id?: number }) => ({
        data: retainedRows,
        error: null,
        isCurrentWindow: anchor != null || newestWindowCurrent,
        isLoading: false,
        refreshWindow: mockRefreshWindow,
      }),
    );
    const view = await renderWithTheme(<ChatScreen />);
    const composerInstance = mockCaptured.composer!.__instance;

    expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
      guid: 'route-focus-guid',
    });
    await run(() => mockCaptured.header!.onSearchPress());
    await run(() => mockCaptured.header!.onSearchPress());

    expect(mockSetParams).toHaveBeenLastCalledWith({ focus: '', focusDate: '' });
    expect(mockRefreshWindow).toHaveBeenCalledTimes(1);
    expect(mockCaptured.composer?.__instance).toBe(composerInstance);
    expect(mockCaptured.composer?.active).toBe(false);
    expect(hiddenComposerGateCount(view.toJSON())).toBe(1);

    // `setParams` updates the same navigator route. Apply those changed params as Expo Router would;
    // the old focus-keyed screen remounted here and silently discarded non-text Composer state.
    mockFocus = '';
    mockFocusDate = '';
    await act(async () => view.rerender(<ChatScreen />));

    expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, undefined);
    expect(mockCaptured.composer?.__instance).toBe(composerInstance);
    expect(mockCaptured.composer?.active).toBe(false);
    expect(hiddenComposerGateCount(view.toJSON())).toBe(1);

    newestWindowCurrent = true;
    await act(async () => view.rerender(<ChatScreen />));
    await waitFor(() => expect(mockCaptured.composer?.active).toBe(true));
    expect(mockCaptured.composer?.__instance).toBe(composerInstance);
    expect(hiddenComposerGateCount(view.toJSON())).toBe(0);
  });

  it('does not reuse an older newest proof after closing a still-loading search anchor', async () => {
    jest.useFakeTimers();
    const searchHit = makeSearchHit(901, 'pending-search-guid');
    let newestWindowCurrent = true;
    mockRefreshWindow.mockImplementation(() => {
      newestWindowCurrent = false;
    });
    useMessagesMock.mockImplementation(
      (_chatGuid: string, _limit: number, anchor?: { guid: string; id?: number }) => ({
        data: [makeMsg({ guid: 'retained-newest-guid' })],
        error: null,
        isCurrentWindow: anchor == null && newestWindowCurrent,
        isLoading: false,
        refreshWindow: mockRefreshWindow,
      }),
    );
    mockUseChatSearch.mockImplementation(
      (_chatGuid: string, query: string, _accountLease: unknown) => {
        const ready = query === 'needle';
        return {
          data: ready ? { pages: [{ results: [searchHit], totalCount: 1 }] } : undefined,
          fetchNextPage: jest.fn(),
          hasNextPage: false,
          isError: false,
          isFetchingNextPage: false,
          isPending: !ready,
          results: ready ? [searchHit] : [],
          totalCount: ready ? 1 : 0,
          query,
        };
      },
    );
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;

    try {
      view = await renderWithTheme(<ChatScreen />);
      const composerInstance = mockCaptured.composer!.__instance;
      for (let cycle = 1; cycle <= 2; cycle++) {
        await run(() => mockCaptured.header!.onSearchPress());
        await run(() => mockCaptured.search!.onChangeText('needle'));
        await act(async () => {
          jest.advanceTimersByTime(250);
        });
        expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
          id: searchHit.id,
          guid: searchHit.guid,
        });

        // Close before the anchored message query settles. The older retained newest rows cannot
        // prove that the fresh return-to-newest request triggered by this close has completed.
        await run(() => mockCaptured.header!.onSearchPress());
        expect(mockRefreshWindow).toHaveBeenCalledTimes(cycle);
        expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, undefined);
        expect(mockCaptured.composer?.__instance).toBe(composerInstance);
        expect(mockCaptured.composer?.active).toBe(false);
        expect(hiddenComposerGateCount(view.toJSON())).toBe(1);

        newestWindowCurrent = true;
        await act(async () => view?.rerender(<ChatScreen />));
        await waitFor(() => expect(mockCaptured.composer?.active).toBe(true));
        expect(mockCaptured.composer?.__instance).toBe(composerInstance);
        expect(hiddenComposerGateCount(view.toJSON())).toBe(0);
      }
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it('adopts a same-focus external route replacement instead of retaining a local search jump', async () => {
    jest.useFakeTimers();
    mockFocus = 'external-focus-guid';
    mockFocusDate = '123456';
    const searchHit = makeSearchHit(901, 'local-search-guid');
    mockUseChatSearch.mockImplementation(
      (_chatGuid: string, query: string, _accountLease: unknown) => {
        const ready = query === 'needle';
        return {
          data: ready ? { pages: [{ results: [searchHit], totalCount: 1 }] } : undefined,
          fetchNextPage: jest.fn(),
          hasNextPage: false,
          isError: false,
          isFetchingNextPage: false,
          isPending: !ready,
          results: ready ? [searchHit] : [],
          totalCount: ready ? 1 : 0,
          query,
        };
      },
    );
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;

    try {
      view = await renderWithTheme(<ChatScreen />);
      const composerInstance = mockCaptured.composer!.__instance;
      await run(() => mockCaptured.header!.onSearchPress());
      await run(() => mockCaptured.search!.onChangeText('needle'));
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: searchHit.id,
        guid: searchHit.guid,
      });

      // Current focused navigation uses router.replace. The focus value can repeat, but the new
      // navigator route key must still reset local search/jump state and adopt its route anchor.
      mockRouteKey = 'chat-route-2';
      await act(async () => view?.rerender(<ChatScreen />));

      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        guid: 'external-focus-guid',
      });
      expect(mockCaptured.composer?.__instance).not.toBe(composerInstance);
      expect(mockCaptured.header?.searchActive).toBe(false);
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it('navigates loaded and paged exact hits and rejects a late retired-account page', async () => {
    jest.useFakeTimers();
    const newest = makeSearchHit(901, 'search-newest-guid');
    const middle = makeSearchHit(802, 'search-middle-guid');
    const oldest = makeSearchHit(703, 'search-oldest-guid');
    const stalePage = deferred<{
      data: { pages: { results: ChatSearchResultRow[] }[] };
    }>();
    const fetchedPages = {
      data: {
        pages: [{ results: [newest, middle] }, { results: [oldest] }],
      },
    };
    const fetchNextPage = jest
      .fn()
      .mockResolvedValueOnce(fetchedPages)
      .mockReturnValueOnce(stalePage.promise);
    mockUseChatSearch.mockImplementation(
      (_chatGuid: string, query: string, _accountLease: unknown) => {
        const ready = query === 'needle';
        return {
          data: ready ? { pages: [{ results: [newest, middle], totalCount: 3 }] } : undefined,
          fetchNextPage,
          hasNextPage: ready,
          isError: false,
          isFetchingNextPage: false,
          isPending: !ready,
          results: ready ? [newest, middle] : [],
          totalCount: ready ? 3 : 0,
          query,
        };
      },
    );
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;

    try {
      view = await renderWithTheme(<ChatScreen />);
      await run(() => mockCaptured.header!.onSearchPress());
      await run(() => mockCaptured.search!.onChangeText('needle'));
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: newest.id,
        guid: newest.guid,
      });
      expect(mockCaptured.list?.focusMessageId).toBe(newest.id);
      expect(mockCaptured.list?.focusGuid).toBe(newest.guid);

      await run(() => mockCaptured.search!.onGoOlder());
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: middle.id,
        guid: middle.guid,
      });
      expect(mockCaptured.list?.focusMessageId).toBe(middle.id);
      expect(mockCaptured.list?.focusGuid).toBe(middle.guid);
      expect(mockCaptured.search?.status).toBe('Result 2 of 3');
      expect(mockCaptured.search?.canGoNewer).toBe(true);

      await act(async () => {
        mockCaptured.search!.onGoOlder();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: oldest.id,
        guid: oldest.guid,
      });
      expect(mockCaptured.list?.focusMessageId).toBe(oldest.id);
      expect(mockCaptured.list?.focusGuid).toBe(oldest.guid);
      expect(mockCaptured.search?.status).toBe('Result 1 of 3');
      expect(mockCaptured.search?.canGoOlder).toBe(false);

      await run(() => mockCaptured.search!.onGoNewer());
      expect(mockCaptured.list?.focusMessageId).toBe(middle.id);
      expect(mockCaptured.list?.focusGuid).toBe(middle.guid);

      await run(() => mockCaptured.search!.onGoOlder());
      expect(fetchNextPage).toHaveBeenCalledTimes(2);
      expect(mockCaptured.search?.loading).toBe(true);
      expect(mockCaptured.search?.canGoOlder).toBe(false);
      expect(mockCaptured.search?.canGoNewer).toBe(false);

      await pauseRealtimeDeliveries();
      await act(async () => {
        stalePage.resolve(fetchedPages);
        await stalePage.promise;
        await Promise.resolve();
      });
      expect(useMessagesMock).toHaveBeenLastCalledWith(GUID, 250, {
        id: middle.id,
        guid: middle.guid,
      });
      expect(mockCaptured.list?.focusMessageId).toBe(middle.id);
      expect(mockCaptured.list?.focusGuid).toBe(middle.guid);
    } finally {
      stalePage.resolve(fetchedPages);
      resumeRealtimeDeliveries();
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
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
    await longPressMessage(makeMsg({ guid: 'm1' }));
    await run(() => mockCaptured.overlay!.onSelect());
    const bar = (await screen.findByText('1 selected')).parent;
    const flat = Object.assign({}, ...[bar?.props.style].flat(Infinity).filter(Boolean));
    expect(flat.paddingBottom).toBe(NAV_BAR + 14);

    mockKbVisible = true;
    const secondMessage = makeMsg({ guid: 'm2' });
    useMessagesMock.mockReturnValue({
      data: [mockMessagePreview!, secondMessage],
      error: null,
      isCurrentWindow: true,
      isLoading: false,
      refreshWindow: mockRefreshWindow,
    });
    await run(() => mockCaptured.list!.onToggleSelect(secondMessage));
    const barUp = (await screen.findByText('2 selected')).parent;
    const flatUp = Object.assign({}, ...[barUp?.props.style].flat(Infinity).filter(Boolean));
    expect(flatUp.paddingBottom).toBe(14);
  });

  it('keeps Composer mounted and makes Back exit selection before removing the chat', async () => {
    await renderWithTheme(<ChatScreen />);
    const composerInstance = mockCaptured.composer!.__instance;

    await longPressMessage(makeMsg({ guid: 'm1' }));
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

  it.each([false, true])(
    'makes route Back close the attachment tray before removing the chat (staged=%s)',
    async (hasUnsavedDraftMetadata) => {
      await renderWithTheme(<ChatScreen />);
      const dismissAttachmentTray = jest.fn();

      await run(() =>
        mockCaptured.composer!.onRemovalStateChange({
          hasUnsavedDraftMetadata,
          hasOpenAttachmentTray: true,
          dismissAttachmentTray,
        }),
      );

      const latestGuardCall =
        mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
      expect(latestGuardCall?.[0]).toBe(true);
      await run(() => latestGuardCall?.[1]({ data: { action: { type: 'GO_BACK' } } }));

      expect(dismissAttachmentTray).toHaveBeenCalledTimes(1);
      expect(mockShowConfirm).not.toHaveBeenCalled();
      expect(mockNavigationDispatch).not.toHaveBeenCalled();
    },
  );

  const latestGuard = () =>
    mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];

  it('opens another chat from a notification tap without closing layers first', async () => {
    await renderWithTheme(<ChatScreen />);
    await longPressMessage(makeMsg({ guid: 'm1' }));
    await run(() => mockCaptured.overlay!.onSelect());
    expect(latestGuard()?.[0]).toBe(true);

    const openOtherChat = { type: 'REPLACE', payload: { name: 'chat/[guid]' } };
    await run(() => latestGuard()?.[1]({ data: { action: openOtherChat } }));

    expect(mockNavigationDispatch).toHaveBeenCalledWith(openOtherChat);
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it('leaves for another chat while the attachment tray is open', async () => {
    await renderWithTheme(<ChatScreen />);
    const dismissAttachmentTray = jest.fn();
    await run(() =>
      mockCaptured.composer!.onRemovalStateChange({
        hasUnsavedDraftMetadata: false,
        hasOpenAttachmentTray: true,
        dismissAttachmentTray,
      }),
    );

    await run(() => latestGuard()?.[1]({ data: { action: { type: 'NAVIGATE' } } }));

    expect(mockNavigationDispatch).toHaveBeenCalledWith({ type: 'NAVIGATE' });
    expect(dismissAttachmentTray).not.toHaveBeenCalled();
  });

  it('asks once before another chat discards staged attachments', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onRemovalStateChange({
        hasUnsavedDraftMetadata: true,
        hasOpenAttachmentTray: true,
        dismissAttachmentTray: jest.fn(),
      }),
    );

    await run(() => latestGuard()?.[1]({ data: { action: { type: 'REPLACE' } } }));

    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard message attachments?' }),
    );
    expect(mockNavigationDispatch).not.toHaveBeenCalled();
    const confirmation = mockShowConfirm.mock.calls[0]?.[0] as { onConfirm?: () => void };
    await run(() => confirmation.onConfirm?.());
    expect(mockNavigationDispatch).toHaveBeenCalledWith({ type: 'REPLACE' });
  });

  it('asks before another chat discards an unsaved edit', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onRemovalStateChange({
        hasUnsavedDraftMetadata: false,
        hasUnsavedEdit: true,
      }),
    );

    await run(() => latestGuard()?.[1]({ data: { action: { type: 'REPLACE' } } }));

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard this edit?' }),
    );
    expect(mockNavigationDispatch).not.toHaveBeenCalled();
    const confirmation = mockShowConfirm.mock.calls[0]?.[0] as { onConfirm?: () => void };
    await run(() => confirmation.onConfirm?.());
    expect(mockNavigationDispatch).toHaveBeenCalledWith({ type: 'REPLACE' });
  });

  it('warns that formatted draft metadata will be discarded on route removal', async () => {
    await renderWithTheme(<ChatScreen />);
    await run(() =>
      mockCaptured.composer!.onRemovalStateChange({
        hasUnsavedDraftMetadata: true,
        hasUnsavedFormattingMetadata: true,
      }),
    );

    const latestGuardCall =
      mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
    await run(() => latestGuardCall?.[1]({ data: { action: { type: 'GO_BACK' } } }));

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Discard message details?',
        message: 'Text formatting is not part of the saved plain-text draft.',
      }),
    );
  });
});

describe('ChatScreen — stable list callbacks (row memoization contract)', () => {
  it('keeps onLongPressMessage/onToggleSelect identities across re-renders', async () => {
    await renderWithTheme(<ChatScreen />);
    const first = {
      longPress: mockCaptured.list!.onLongPressMessage,
      toggle: mockCaptured.list!.onToggleSelect,
    };
    // Force an unrelated screen re-render (typing state) — a fresh closure here would
    // fail MessageRow's shallow memo compare and re-render every row.
    await act(async () => {
      useTypingStore.setState({ typing: { [GUID]: true } });
    });
    expect(mockCaptured.list!.onLongPressMessage).toBe(first.longPress);
    expect(mockCaptured.list!.onToggleSelect).toBe(first.toggle);
  });
});

describe('ChatScreen — stable composer callbacks (Composer memo contract)', () => {
  it('surfaces a current-account attachment admission failure', async () => {
    configureRcsChat();
    const loggerWarn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const failure = new Error('paste ownership unavailable');
    try {
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
        'Couldn’t queue one or more attachments. They’re still in your composer—try again when connected',
      );
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith('[chat] attachment queue admission failed', failure);
    } finally {
      loggerWarn.mockRestore();
    }
  });

  it('asks the person to rename a file whose name cannot be sent', async () => {
    configureRcsChat();
    const loggerWarn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const uri = 'file:///cache/DocumentPicker/quoted.pdf';
    try {
      (sendImages as jest.Mock).mockImplementationOnce(
        async (
          _args: unknown,
          _lease: unknown,
          _reportIssue: unknown,
          onAdmission?: (admission: { uri: string; queued: boolean; reason?: 'file-name' }) => void,
        ) => {
          onAdmission?.({ uri, queued: false, reason: 'file-name' });
          throw new Error('Choose a file with a valid name of at most 255 UTF-8 bytes.');
        },
      );
      await renderWithTheme(<ChatScreen />);

      await act(async () => {
        mockCaptured.composer!.onSendAttachments([
          { uri, name: 'Q3 "final".pdf', mimeType: 'application/pdf', size: 10 },
        ]);
        await Promise.resolve();
      });

      expect(showToast).toHaveBeenCalledWith(
        'A file’s name can’t be sent. Rename it without quotes or slashes (and shorter if it’s very long), then attach it again.',
      );
      expect(showToast).not.toHaveBeenCalledWith(
        expect.stringContaining('try again when connected'),
      );
    } finally {
      loggerWarn.mockRestore();
    }
  });

  it('keeps every composer callback identity across an unrelated screen re-render', async () => {
    configureRcsChat();
    await renderWithTheme(<ChatScreen />);
    const first = {
      send: mockCaptured.composer!.onSend,
      schedule: mockCaptured.composer!.onSchedule,
      attachments: mockCaptured.composer!.onSendAttachments,
      pickFiles: mockCaptured.composer!.onPickFiles,
      typing: mockCaptured.composer!.onTyping,
      voice: mockCaptured.composer!.onStartVoice,
    };
    expect(first.voice).toBeDefined(); // non-dev path passes the real stable callback
    // Unrelated screen state change (typing flag) — fresh closures here would defeat
    // the memoized Composer's shallow prop compare on every reactive tick.
    await act(async () => {
      useTypingStore.setState({ typing: { [RCS_GUID]: true } });
    });
    expect(mockCaptured.composer!.onSend).toBe(first.send);
    expect(mockCaptured.composer!.onSchedule).toBe(first.schedule);
    expect(mockCaptured.composer!.onSendAttachments).toBe(first.attachments);
    expect(mockCaptured.composer!.onPickFiles).toBe(first.pickFiles);
    expect(mockCaptured.composer!.onTyping).toBe(first.typing);
    expect(mockCaptured.composer!.onStartVoice).toBe(first.voice);
  });

  it('drops a native file-picker result after the screen account that opened it retires', async () => {
    let finishPicker!: (value: {
      canceled: false;
      assets: { uri: string; name: string; mimeType: string; size: number }[];
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

  it('asks Android for one JPEG/PNG only in the narrow iMessage picker', async () => {
    const getDocumentAsync = jest.fn(async () => ({ canceled: true, assets: null }));
    await pickDocumentFilesForLease(
      captureRealtimeDeliveryLease(),
      async () => ({ getDocumentAsync }),
      true,
    );
    expect(getDocumentAsync).toHaveBeenCalledWith({
      multiple: false,
      copyToCacheDirectory: true,
      type: ['image/jpeg', 'image/png'],
    });
  });

  it('adds PDF to the single-file iMessage picker only with the PDF capability', async () => {
    const getDocumentAsync = jest.fn(async () => ({ canceled: true, assets: null }));
    await pickDocumentFilesForLease(
      captureRealtimeDeliveryLease(),
      async () => ({ getDocumentAsync }),
      true,
      true,
    );
    expect(getDocumentAsync).toHaveBeenCalledWith({
      multiple: false,
      copyToCacheDirectory: true,
      type: ['image/jpeg', 'image/png', 'application/pdf'],
    });
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
    configureRcsChat();
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
    await longPressMessage(withAttachment());
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
    await longPressMessage(withAttachment());
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
    await longPressMessage(
      makeMsg({
        guid: 'm9',
        text: null,
        attachments: [
          { guid: 'a1', localPath: 'file:///docs/a1.jpg', mimeType: 'image/jpeg' },
        ] as never,
      }),
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
    await longPressMessage(withAttachment()); // text: 'hey'
    await run(() => mockCaptured.overlay!.onShare());
    await waitFor(() => expect(showDialog).toHaveBeenCalled());
    expect(rnShare).not.toHaveBeenCalled();
    rnShare.mockRestore();
  });

  it('drops a delayed attachment-share failure after the screen account retires', async () => {
    const response = deferred<{ ok: false; reason: 'failed' }>();
    (shareAttachment as jest.Mock).mockReturnValueOnce(response.promise);
    await renderWithTheme(<ChatScreen />);
    await longPressMessage(withAttachment());
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
    await longPressMessage(withAttachment());
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
    await longPressMessage(withAttachment());
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
          selectedMessagePartIndex?: number,
        ) => Promise<void>,
        accountLease: { isCurrent(): boolean },
      ) => {
        expect(accountLease.isCurrent()).toBe(true);
        await sender('plain-chat', 'plain', undefined, async () => undefined);
        await expect(
          sender('reply-chat', 'reply', 'reply-target', async () => undefined, 2),
        ).rejects.toThrow('Scheduled replies were retired in this release.');
        return 1;
      },
    );

    await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(fireDueScheduledWithDevelopmentSender).toHaveBeenCalledTimes(1));
    const accountLease = (fireDueScheduledWithDevelopmentSender as jest.Mock).mock.calls[0]![1];
    expect(devSendFake).toHaveBeenCalledWith(
      'plain-chat',
      'plain',
      undefined,
      accountLease,
      expect.any(Function),
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
