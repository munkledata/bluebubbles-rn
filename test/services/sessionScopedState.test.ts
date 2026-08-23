import { findMyApi } from '@core/api';
import { resetSessionScopedState } from '@/services/sessionScopedState';
import {
  stashPendingNotification,
  takePendingNotification,
} from '@/services/notifications/pendingNav';
import { useDownloadStore } from '@state/downloadStore';
import { useFaceTimeStore } from '@state/faceTimeStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useFindMyStore } from '@state/findmyStore';
import { useLockStore } from '@state/lockStore';
import { queryClient } from '@state/queryClient';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { useShareIntentStore } from '@state/shareIntentStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useSyncStore } from '@state/syncStore';
import { useThemeStore } from '@state/themeStore';
import { useTypingStore } from '@state/typingStore';
import { useUploadStore } from '@state/uploadStore';
import { showDialog, useDialogStore } from '@ui/dialog/dialogStore';
import { showToast, useToastStore } from '@ui/toast/toastStore';

const mockIsDevServer = jest.fn();

jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));
jest.mock('@/services/clients', () => ({ http: {} }));
// Durable preference stores import the production database accessor for their persistence methods.
// This suite mutates only their in-memory Zustand values; keep the native op-sqlite module out of
// plain Node Jest so the "preferences survive" assertion stays focused on the reset boundary.
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@core/api', () => ({
  findMyApi: {
    getDevices: jest.fn(),
    getFriends: jest.fn(),
    getItems: jest.fn(),
    refreshDevices: jest.fn(),
    refreshFriends: jest.fn(),
    refreshItems: jest.fn(),
  },
}));

const api = findMyApi as unknown as {
  getDevices: jest.Mock;
  getFriends: jest.Mock;
  getItems: jest.Mock;
  refreshDevices: jest.Mock;
  refreshFriends: jest.Mock;
  refreshItems: jest.Mock;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
  mockIsDevServer.mockReturnValue(false);
  api.getDevices.mockResolvedValue([]);
  api.getFriends.mockResolvedValue([]);
  api.getItems.mockResolvedValue([]);
  api.refreshDevices.mockResolvedValue([]);
  api.refreshFriends.mockResolvedValue([]);
  api.refreshItems.mockResolvedValue([]);
  resetSessionScopedState();
});

afterEach(() => {
  resetSessionScopedState();
  useShareIntentStore.getState().clear();
  useFeatureSettingsStore.setState({ compactChatList: false });
  useSyncSettingsStore.setState({ messagesPerChat: 0 });
  useThemeStore.setState({ preset: 'oled-dark' });
  useLockStore.setState({ enabled: false, locked: false });
  jest.useRealTimers();
});

describe('resetSessionScopedState', () => {
  it('clears every account-owned UI/cache surface synchronously', () => {
    queryClient.setQueryData(['server', 'icloud-account'], {
      account: 'old-account@example.test',
    });
    useUploadStore
      .getState()
      .start('old-upload', { chatGuid: 'old-chat', name: 'private.jpg', total: 100 });
    useDownloadStore.getState().start('old-download');
    useFaceTimeStore.getState().open({
      link: 'facetime://old-call',
      chatGuid: 'old-chat',
      video: true,
    });
    useFaceTimeStore.getState().ring({
      uuid: 'old-call-uuid',
      callerName: 'Previous account caller',
      isAudio: false,
    });
    useTypingStore.getState().setTyping('old-chat', true);
    useRcsHealthStore.getState().setAlert('PHONE_NOT_RESPONDING');
    useSyncStore.getState().begin();
    useSyncStore.getState().progress({ chats: 12, messages: 345 });
    useSyncStore.getState().fail('Previous server failed');
    useFindMyStore.setState({
      devices: [
        {
          id: 'old-device',
          name: 'Previous account phone',
          batteryLevel: 0.5,
          latitude: 40,
          longitude: -105,
          address: 'Private address',
        },
      ],
      friends: [
        {
          id: 'old-friend',
          name: 'Previous account person',
          latitude: 41,
          longitude: -106,
          address: 'Private location',
          lastUpdated: 123,
        },
      ],
      items: [],
      loading: true,
      refreshing: true,
      error: 'Previous server error',
    });
    showDialog('Previous account', 'Private dialog copy');
    showToast('Private toast copy');
    stashPendingNotification({ chatGuid: 'old-chat' });

    resetSessionScopedState();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(useUploadStore.getState().byGuid).toEqual({});
    expect(useDownloadStore.getState()).toMatchObject({ progress: {}, status: {} });
    expect(useFaceTimeStore.getState()).toMatchObject({ call: null, incoming: null });
    expect(useTypingStore.getState().typing).toEqual({});
    expect(useRcsHealthStore.getState()).toMatchObject({
      lastAlertType: null,
      lastAlertAt: null,
    });
    expect(useSyncStore.getState()).toMatchObject({
      status: 'idle',
      chats: 0,
      messages: 0,
      error: null,
    });
    expect(useFindMyStore.getState()).toMatchObject({
      devices: [],
      friends: [],
      items: [],
      loading: false,
      refreshing: false,
      error: null,
    });
    expect(useDialogStore.getState()).toMatchObject({ current: null, queue: [] });
    expect(useToastStore.getState()).toMatchObject({ current: null, queue: [] });
    expect(takePendingNotification()).toBeNull();
  });

  it('cancels typing TTL timers instead of letting old timers mutate the new session', () => {
    useTypingStore.getState().setTyping('same-guid-on-both-servers', true);

    resetSessionScopedState();
    // Simulate the next session receiving state for the same stable chat guid without creating a
    // new timer. The previous session's timer must no longer be capable of flipping this value.
    useTypingStore.setState({ typing: { 'same-guid-on-both-servers': true } });
    jest.advanceTimersByTime(12_000);

    expect(useTypingStore.getState().typing['same-guid-on-both-servers']).toBe(true);
  });

  it('keeps a deferred TanStack query from restoring its cache entry after reset', async () => {
    let finishQuery!: (value: { account: string }) => void;
    const staleQuery = queryClient
      .fetchQuery({
        queryKey: ['server', 'deferred-private-account'],
        queryFn: () =>
          new Promise<{ account: string }>((resolve) => {
            finishQuery = resolve;
          }),
      })
      // `clear()` cancels the public fetch promise. Consume that expected cancellation so the test
      // can also settle an underlying query function that does not honor AbortSignal.
      .catch(() => undefined);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
    resetSessionScopedState();
    finishQuery({ account: 'old-account@example.test' });
    await staleQuery;

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(['server', 'deferred-private-account'])).toBeUndefined();
  });

  it('does not reset durable preferences or a share waiting at the auth gate', () => {
    useFeatureSettingsStore.setState({ compactChatList: true });
    useSyncSettingsStore.setState({ messagesPerChat: 25 });
    useThemeStore.setState({ preset: 'gator' });
    useLockStore.setState({ enabled: true, locked: true });
    useShareIntentStore.getState().set({
      text: 'shared while disconnected',
      files: [
        {
          uri: 'file:///pending.pdf',
          name: 'pending.pdf',
          mimeType: 'application/pdf',
          size: 10,
        },
      ],
    });

    resetSessionScopedState();

    expect(useFeatureSettingsStore.getState().compactChatList).toBe(true);
    expect(useSyncSettingsStore.getState().messagesPerChat).toBe(25);
    expect(useThemeStore.getState().preset).toBe('gator');
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true });
    expect(useShareIntentStore.getState()).toMatchObject({
      text: 'shared while disconnected',
      files: [expect.objectContaining({ name: 'pending.pdf' })],
    });
  });

  it('disowns a deferred Find My load so its old locations cannot return after reset', async () => {
    let resolveDevices!: (rows: unknown[]) => void;
    api.getDevices.mockReturnValueOnce(
      new Promise<unknown[]>((resolve) => {
        resolveDevices = resolve;
      }),
    );
    api.getFriends.mockResolvedValueOnce([
      { title: 'Old person', coordinates: [1, 2], long_address: 'Old address' },
    ]);

    const staleLoad = useFindMyStore.getState().load();
    expect(useFindMyStore.getState().loading).toBe(true);
    resetSessionScopedState();

    resolveDevices([{ name: 'Old phone', coordinates: [3, 4] }]);
    await staleLoad;

    expect(useFindMyStore.getState()).toMatchObject({
      devices: [],
      friends: [],
      items: [],
      loading: false,
      error: null,
    });
  });

  it('lets a new Find My refresh win while an old-account refresh is still settling', async () => {
    let resolveOldDevices!: (rows: unknown[]) => void;
    api.refreshDevices
      .mockReturnValueOnce(
        new Promise<unknown[]>((resolve) => {
          resolveOldDevices = resolve;
        }),
      )
      .mockResolvedValueOnce([{ name: 'New phone', coordinates: [30, 40] }]);

    const staleRefresh = useFindMyStore.getState().refresh();
    expect(useFindMyStore.getState().refreshing).toBe(true);
    resetSessionScopedState();

    await useFindMyStore.getState().refresh();
    expect(useFindMyStore.getState().devices[0]).toMatchObject({
      name: 'New phone',
      latitude: 30,
      longitude: 40,
    });

    resolveOldDevices([{ name: 'Old phone', coordinates: [1, 2] }]);
    await staleRefresh;

    expect(useFindMyStore.getState().devices[0]).toMatchObject({ name: 'New phone' });
    expect(useFindMyStore.getState().refreshing).toBe(false);
  });
});
