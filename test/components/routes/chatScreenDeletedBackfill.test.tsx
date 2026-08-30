/**
 * ChatScreen's on-open history backfill vs. a LOCALLY DELETED conversation
 * (app/(app)/chat/[guid].tsx).
 *
 * The screen stays reachable for a chat sitting under a deletion tombstone — a tapped notification,
 * a Direct Share chip published before the delete, `router.back()` out of chat settings — because
 * `getChatHeader` is deliberately not visibility-filtered (a null header would silently switch the
 * chat's MUTE off). What must NOT follow is the unconditional `ensureChatSynced`: it re-pages up to
 * 500 messages back into the DB and the FTS index while every restored row is `<= deleted_at`, so
 * the chat stays out of the inbox, the archive and search. The user cannot see what came back and
 * cannot delete it again, and nothing ever re-runs the purge — the delete is silently undone.
 *
 * The rule this pins: skip the backfill only while the chat is HIDDEN. A chat that legitimately came
 * back must sync exactly as before, and a failed tombstone read must not be a silent way to disable
 * history backfill for every chat.
 *
 * Everything below the screen is mocked at the module boundary (same shape as
 * `routes/chatScreen.test.tsx`), so the assertions are about the ROUTE's decision.
 */
import React from 'react';
import { act, renderWithTheme, waitFor } from '../support/renderWithTheme';

const GUID = 'iMessage;-;+15551234567';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => R.useEffect(callback, [callback]),
    useLocalSearchParams: () => ({ guid: GUID }),
    useNavigation: () => ({ dispatch: jest.fn() }),
    useRouter: () => ({ push: jest.fn(), setParams: jest.fn() }),
  };
});
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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

// The whole UI tree as inert probes (keeps the native-pulling real barrel out).
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    useTheme: () => ({ color: { background: '#000000' } }),
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    ConversationHeader: () => null,
    EdgeFade: () => null,
    ScreenEffectOverlay: () => null,
    TypingBubble: () => null,
    // Must be present even as a stub — a missing export renders as `undefined` and fails the
    // whole screen. Its own behavior lives in uploadStatusBar.test.tsx.
    UploadStatusBar: () => null,
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

jest.mock('@features/conversations/useMessages', () => ({
  useMessages: () => ({ data: [], error: null }),
}));
jest.mock('@features/conversations/useChatHeader', () => ({
  useChatHeader: () => ({
    data: { id: 1, guid: GUID, style: 45, participantCount: 1, handleServices: null },
    error: null,
  }),
}));
jest.mock('@features/conversations/useNewScreenEffect', () => ({
  useNewScreenEffect: () => ({ effect: null, clear: jest.fn() }),
}));
jest.mock('@features/conversations/useChatSearch', () => ({
  useChatSearch: () => ({
    data: undefined,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isPending: true,
    results: [],
    totalCount: 0,
  }),
}));
jest.mock('@features/conversations/devSeed', () => ({
  devEditFake: jest.fn(),
  devInjectEffect: jest.fn(),
  devSendFake: jest.fn(),
  devSendFakeReaction: jest.fn(),
  devSendFakeReply: jest.fn(),
  devUnsendFake: jest.fn(),
}));
jest.mock('@utils/isDev', () => ({
  isDevServer: () => false,
  DEV_SERVER_ORIGIN: 'https://dev.local',
}));
jest.mock('@core/secure', () => {
  const actual = jest.requireActual('@core/secure');
  return {
    ...actual,
    logger: { ...actual.logger, debug: jest.fn() },
  };
});

// The repository layer the mount effect reads. `isChatHiddenByDeletion` is the decision under test.
const mockIsChatHiddenByDeletion = jest.fn<Promise<boolean>, [unknown, string]>();
jest.mock('@db/repositories', () => ({
  getChatIdByGuid: jest.fn(async () => null),
  getChatParticipants: jest.fn(async () => []),
  getFirstUnreadInChat: jest.fn(async () => null),
  isChatHiddenByDeletion: (db: unknown, guid: string) => mockIsChatHiddenByDeletion(db, guid),
  kvGet: jest.fn(async () => null),
  kvSet: jest.fn(async () => undefined),
}));

jest.mock('@/services', () => ({
  dispatchRealtimeEvent: jest.fn(),
  ensureChatSynced: jest.fn(),
  ensureSyncedBackgroundForChat: jest.fn(),
  http: {},
  markRead: jest.fn(),
  sendTyping: jest.fn(),
}));
jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({ clearChatNotification: jest.fn() }));
jest.mock('@/services/notifications/remindersService', () => ({
  scheduleMessageReminder: jest.fn(),
}));
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
import ChatScreen from '../../../app/(app)/chat/[guid]';
// eslint-disable-next-line import/first
import { ensureChatSynced, markRead } from '@/services';
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockIsChatHiddenByDeletion.mockResolvedValue(false);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('ChatScreen — the on-open backfill honours a local delete', () => {
  it('does NOT re-page a deleted conversation the user can still reach', async () => {
    mockIsChatHiddenByDeletion.mockResolvedValue(true);

    await renderWithTheme(<ChatScreen />);

    // The mount effect definitely ran (same effect, one line up)…
    await waitFor(() =>
      expect(markRead).toHaveBeenCalledWith(
        GUID,
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
    expect(mockIsChatHiddenByDeletion.mock.calls.map((c) => c[1])).toEqual([GUID]);
    // …and the whole purged history was NOT restored behind the user's back.
    expect(ensureChatSynced).not.toHaveBeenCalled();
  });

  it('backfills normally for a chat that is not deleted', async () => {
    await renderWithTheme(<ChatScreen />);

    await waitFor(() => expect(ensureChatSynced).toHaveBeenCalledWith(GUID));
  });

  it('backfills anyway when the tombstone check itself fails', async () => {
    mockIsChatHiddenByDeletion.mockRejectedValue(new Error('db closed'));

    await renderWithTheme(<ChatScreen />);

    // A read that throws must not be a silent way to stop syncing every chat's history.
    await waitFor(() => expect(ensureChatSynced).toHaveBeenCalledWith(GUID));
    expect(logger.debug).toHaveBeenCalledWith('[chat] tombstone check failed; syncing anyway', {
      error: 'Error: db closed',
    });
  });

  it('does not let an account-A tombstone read start account-B history sync', async () => {
    const hiddenA = deferred<boolean>();
    mockIsChatHiddenByDeletion.mockReturnValueOnce(hiddenA.promise);
    await renderWithTheme(<ChatScreen />);
    await waitFor(() => expect(mockIsChatHiddenByDeletion).toHaveBeenCalledTimes(1));

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      hiddenA.resolve(false);
      await hiddenA.promise;
      await Promise.resolve();
    });

    expect(ensureChatSynced).not.toHaveBeenCalled();
  });
});
