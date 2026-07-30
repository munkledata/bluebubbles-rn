/**
 * Regression guard for the LIVE read marker in ChatScreen (app/(app)/chat/[guid].tsx).
 *
 * The open-time effect has deps exactly `[guid]`, so it marks read once per open. Nothing advanced
 * the marker while the screen stayed mounted: a message you WATCHED arrive in the open thread left
 * a bold unread badge on the inbox when you pressed Back, and left its heads-up notification
 * sitting in the tray. A second effect now re-marks as new RECEIVED messages render.
 *
 * Four things this pins that are easy to break:
 *   - it fires on the newest RECEIVED guid, not on `messages`, so the in-place ticks that rebuild
 *     the array on every reactive flush (delivery receipts, localPath writes, reaction joins) and
 *     the user's OWN sends don't spam markRead / the server read receipt;
 *   - it is ARMED only after the open-time effect has captured `firstUnread` from the OLD marker —
 *     marking read any earlier would erase the "N unread — jump to first" target before it is used;
 *   - the FIRST window to resolve is a baseline, not an arrival. `useReactiveQuery` renders
 *     `data: null` first, so every open ends with an undefined→guid step that is merely the window
 *     landing; treating it as a new message fired a second markRead (+ a second server read
 *     receipt) on every single chat open. The mocked `useMessages` therefore starts at `null` here,
 *     exactly like the real hook — feeding rows on the first render hides the bug;
 *   - it only marks when the app is IN FRONT. The screen stays mounted while the app is
 *     backgrounded and underneath the app-lock overlay, and FCM keeps writing messages into the DB
 *     in both states — marking read there cancels the tray notification for a message the user
 *     never saw. Coming back / unlocking re-runs the effect, so the mark is deferred, not lost.
 *
 * The mock preamble mirrors test/components/routes/chatScreen.test.tsx: every child is a probe and
 * the data hooks / service surface are jest.fns, so the assertions are about the ROUTE's logic.
 */
import React from 'react';

const GUID = 'iMessage;-;+15551234567';
let mockGuid = GUID;

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: mockGuid }),
  useRouter: () => ({ push: jest.fn(), setParams: jest.fn() }),
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

jest.mock('@ui', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    useTheme: () => ({ color: { background: '#000000' } }),
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    ConversationHeader: () => null,
    EdgeFade: () => null,
    ScreenEffectOverlay: () => null,
    TypingBubble: () => null,
    MessageList: () => null,
    MessageActionsOverlay: () => null,
    Composer: () => null,
    ThreadSheet: () => null,
    EditHistorySheet: () => null,
    MessageDetailsSheet: () => null,
  };
});

jest.mock('@ui/theme/ChatThemeProvider', () => ({
  ChatThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useChatBackgroundUri: () => null,
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

// Force the REAL (non-dev) service path.
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
  pickAndSendContact: jest.fn(),
  react: jest.fn(),
  recoverOutgoing: jest.fn().mockResolvedValue({ eligible: 0, sent: 0 }),
  reply: jest.fn(),
  runDueScheduled: jest.fn(),
  schedule: jest.fn(),
  send: jest.fn(),
  sendImage: jest.fn(),
  sendImages: jest.fn(),
  unsend: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import ChatScreen from '../../../app/(app)/chat/[guid]';
// eslint-disable-next-line import/first
import { act, renderWithTheme, waitFor } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import { useMessages } from '@features/conversations/useMessages';
// eslint-disable-next-line import/first
import { useChatHeader } from '@features/conversations/useChatHeader';
// eslint-disable-next-line import/first
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
// eslint-disable-next-line import/first
import { markRead } from '@/services';
// eslint-disable-next-line import/first
import { clearChatNotification } from '@/services/notifications/notifeeService';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import type { EnrichedMessage } from '@features/conversations/useMessages';

const useMessagesMock = useMessages as jest.Mock;

/** `messages` is NEWEST-FIRST — build windows newest-first. */
function msg(guid: string, isFromMe: 0 | 1, dateCreated: number): EnrichedMessage {
  return {
    id: dateCreated,
    guid,
    text: guid,
    isFromMe,
    dateCreated,
    dateRetracted: null,
    sendState: 'sent',
    reactions: [],
    attachments: [],
  } as unknown as EnrichedMessage;
}

const INCOMING_1 = msg('in-1', 0, 1_000);
const INCOMING_2 = msg('in-2', 0, 2_000);
const OWN = msg('own-1', 1, 3_000);

/** The screen's AppState subscribers, so a test can drive background/foreground. */
type AppStateHandler = (state: AppStateStatus) => void;
const appStateHandlers: AppStateHandler[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGuid = GUID;
  appStateHandlers.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: AppStateHandler,
  ) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
  // The real hook resolves ASYNCHRONOUSLY: `useReactiveQuery` renders `data: null` first and the
  // window lands a few DB reads later. Start there or the baseline step below never happens.
  useMessagesMock.mockReturnValue({ data: null, error: null });
  (useChatHeader as jest.Mock).mockReturnValue({
    data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: null },
    error: null,
  });
  (useNewScreenEffect as jest.Mock).mockReturnValue({ effect: null, clear: jest.fn() });
  useLockStore.setState({ locked: false });
});

/** Hand the mounted screen a new message window (a reactive flush). */
async function flush(
  rerender: (ui: React.ReactElement) => void,
  data: EnrichedMessage[],
): Promise<void> {
  useMessagesMock.mockReturnValue({ data, error: null });
  await act(async () => {
    rerender(<ChatScreen />);
  });
}

/** Drive an AppState transition through the screen's own listener. */
async function appState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const h of appStateHandlers) h(state);
  });
}

/**
 * Open the chat the way the device does: mount with no window, let the open-time mark + arming
 * settle, then land the first window (the baseline). Mocks are cleared afterwards, so any call a
 * test sees came from a genuine live update.
 */
async function openChat(): Promise<{ rerender: (ui: React.ReactElement) => void }> {
  const { rerender } = await renderWithTheme(<ChatScreen />);
  await waitFor(() => expect(markRead).toHaveBeenCalledWith(GUID));
  await flush(rerender, [INCOMING_1]);
  (markRead as jest.Mock).mockClear();
  (clearChatNotification as jest.Mock).mockClear();
  return { rerender };
}

describe('ChatScreen — live read marker while the thread is open', () => {
  it('re-marks read and clears the tray notification when a new message arrives in the open chat', async () => {
    const { rerender } = await openChat();

    await flush(rerender, [INCOMING_2, INCOMING_1]);

    expect(markRead).toHaveBeenCalledWith(GUID);
    expect(clearChatNotification).toHaveBeenCalledWith(GUID);
  });

  it('does not re-mark for an in-place update or for the user’s own send', async () => {
    const { rerender } = await openChat();

    // A reactive flush that rebuilds the array without a new received message (delivery receipt,
    // localPath write, reaction join) — a fresh array reference, same newest received guid.
    await flush(rerender, [{ ...INCOMING_1, dateDelivered: 5 } as EnrichedMessage]);
    expect(markRead).not.toHaveBeenCalled();

    // Sending appends an OWN message; the marker tracks received messages only.
    await flush(rerender, [OWN, INCOMING_1]);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('treats the first resolved window as a baseline, not an arrival', async () => {
    // The open-time effect already marked everything that existed; the window only shows up
    // afterwards. Marking again here is a redundant `chats` write (which re-runs the inbox query)
    // plus a second POST /chat/:guid/read.
    const { rerender } = await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(GUID));

    await flush(rerender, [INCOMING_1]);

    expect(markRead).toHaveBeenCalledTimes(1);
    expect(clearChatNotification).toHaveBeenCalledTimes(1);
  });

  it('does not mark read while the app is backgrounded, and catches up on return', async () => {
    const { rerender } = await openChat();

    await appState('background');
    // FCM keeps writing incoming messages into the DB with the screen still mounted, which flushes
    // the reactive query — the user is looking at another app and has seen nothing.
    await flush(rerender, [INCOMING_2, INCOMING_1]);
    expect(markRead).not.toHaveBeenCalled();
    expect(clearChatNotification).not.toHaveBeenCalled();

    await appState('active');
    expect(markRead).toHaveBeenCalledWith(GUID);
    expect(clearChatNotification).toHaveBeenCalledWith(GUID);
  });

  it('does not mark read behind the app-lock overlay, and catches up after unlocking', async () => {
    const { rerender } = await openChat();

    // The lock gate is an absolute-fill overlay at the ROOT layout, so this screen stays mounted
    // (and still re-renders) underneath it.
    await act(async () => {
      useLockStore.setState({ locked: true });
    });
    await flush(rerender, [INCOMING_2, INCOMING_1]);
    expect(markRead).not.toHaveBeenCalled();
    expect(clearChatNotification).not.toHaveBeenCalled();

    await act(async () => {
      useLockStore.setState({ locked: false });
    });
    expect(markRead).toHaveBeenCalledWith(GUID);
    expect(clearChatNotification).toHaveBeenCalledWith(GUID);
  });
});
