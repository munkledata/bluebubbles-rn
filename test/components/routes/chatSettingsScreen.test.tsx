/** Conversation Details: exact content plus GUID/account/picker ownership. */
import React from 'react';
import { AccessibilityInfo, Keyboard, Platform } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockShowDialog = jest.fn();
const mockShowToast = jest.fn();
const mockLaunchImageLibrary = jest.fn();
const mockRequestPhotoLibraryAccess = jest.fn();
const mockOpenNotificationSettings = jest.fn();
const mockSetChatAppearanceWithinTransaction = jest.fn();
const mockSetChatCustomizationWithinTransaction = jest.fn();
const mockSetHandleColorWithinTransaction = jest.fn();
const mockSetChatMuteWithinTransaction = jest.fn();
const mockComputeBackgroundIsLight = jest.fn();
const mockAdaptiveTokensFromImage = jest.fn();
const mockSafeOpenUrl = jest.fn();
const mockStartChatRepair = jest.fn();
const mockRenameAppleGroup = jest.fn();
const mockPrepareAppleGroupPhotoSet = jest.fn();
const mockSubmitAppleGroupPhoto = jest.fn();
const mockCancelAppleGroupPhoto = jest.fn();
const mockRemoveAppleGroupPhoto = jest.fn();
const mockAddAppleGroupParticipant = jest.fn();
const mockRemoveAppleGroupParticipant = jest.fn();
const mockLeaveAppleGroup = jest.fn();
const mockSubscribeGenerationInvalidation = jest.fn();
const mockUseChatHeader = jest.fn();
const mockReactiveHookCall = jest.fn();
const mockDatabase = {
  kind: 'chat-settings-account-a-db',
  run: jest.fn(async (_statement: unknown) => undefined),
};
const mockDatabaseB = {
  kind: 'chat-settings-account-b-db',
  run: jest.fn(async (_statement: unknown) => undefined),
};
const originalPlatformOS = Platform.OS;
const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

interface MockLease {
  generation: number;
  current: boolean;
  isCurrent(): boolean;
}

function makeLease(generation: number, current = true): MockLease {
  return {
    generation,
    current,
    isCurrent: function isCurrent() {
      return this.current;
    },
  };
}

let mockAccountLease = makeLease(73);
let mockGuid = 'iMessage;-;chat-settings-private-guid';
let mockMuteType: 'mute' | null = null;
let mockCustomColor: string | null = null;
let mockHandleColor: string | null = null;
let mockChatStyle = 43;
let mockParticipantCount = 2;
let mockHandleServices: string | null = null;
let mockDisplayNameOverride: string | null | undefined;
let mockPendingReactiveGuid: string | null = null;
const mockInvalidationListeners = new Map<number, Set<() => void>>();
let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;

const PRIVATE_CUSTOM_TITLE = 'details-private-custom-title-19b7';
const PRIVATE_SERVER_TITLE = 'details-private-server-title-a840';
const PRIVATE_MEMBER = 'details-private-member-c615';
const PRIVATE_ADDRESS = 'private-member-address@example.invalid';
const PRIVATE_MEDIA_URI = 'file:///details-private-photo-3e0f.jpg';
const PRIVATE_BLURHASH = 'details-private-blurhash-771c';
const PRIVATE_THEME_TOKEN = 'details-private-theme-token-889d';
const CHAT_GUID = 'iMessage;-;chat-settings-private-guid';
const MEDIA_GUID = 'details-private-message-guid';
const PRIVATE_LINK = 'https://details-a.example.invalid/path-a';
const ACCOUNT_CHANGED_COPY = 'Conversation account changed. Go back and reopen Details.';
const CHAT_GUID_B = 'iMessage;-;chat-settings-private-guid-b';
const GROUP_CHAT_GUID = 'iMessage;+;chat-settings-private-group-guid';
const PRIVATE_CUSTOM_TITLE_B = 'details-private-custom-title-b-31f0';
const PRIVATE_SERVER_TITLE_B = 'details-private-server-title-b-42a1';
const PRIVATE_MEMBER_B = 'details-private-member-b-53b2';
const PRIVATE_ADDRESS_B = 'private-member-b@example.invalid';
const PRIVATE_MEDIA_URI_B = 'file:///details-private-photo-b-64c3.jpg';
const PRIVATE_BLURHASH_B = 'details-private-blurhash-b-75d4';
const MEDIA_GUID_B = 'details-private-message-guid-b';
const PRIVATE_LINK_B = 'https://details-b.example.invalid/path-b';

function mockSourceFor(guid: string): {
  guid: string;
  customTitle: string;
  serverTitle: string;
  member: string;
  address: string;
  mediaUri: string;
  blurhash: string;
  mediaGuid: string;
  link: string;
} {
  return guid === CHAT_GUID_B
    ? {
        guid,
        customTitle: PRIVATE_CUSTOM_TITLE_B,
        serverTitle: PRIVATE_SERVER_TITLE_B,
        member: PRIVATE_MEMBER_B,
        address: PRIVATE_ADDRESS_B,
        mediaUri: PRIVATE_MEDIA_URI_B,
        blurhash: PRIVATE_BLURHASH_B,
        mediaGuid: MEDIA_GUID_B,
        link: PRIVATE_LINK_B,
      }
    : {
        guid,
        customTitle: PRIVATE_CUSTOM_TITLE,
        serverTitle: PRIVATE_SERVER_TITLE,
        member: PRIVATE_MEMBER,
        address: PRIVATE_ADDRESS,
        mediaUri: PRIVATE_MEDIA_URI,
        blurhash: PRIVATE_BLURHASH,
        mediaGuid: MEDIA_GUID,
        link: PRIVATE_LINK,
      };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sqlStatementText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('queryChunks' in value)) return '';
  const chunks = (value as { queryChunks: { value?: unknown }[] }).queryChunks;
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .filter((part): part is string => typeof part === 'string')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function expectDbRunSequence(db: { run: jest.Mock }, expected: string[]): void {
  expect(db.run.mock.calls.map(([statement]) => sqlStatementText(statement))).toEqual(expected);
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

function defaultColorSwatch(): NonNullable<ReturnType<typeof screen.getByText>['parent']> {
  return screen.getByRole('radio', { name: 'Default bubble color' });
}

function privateCanaries(): string[] {
  return [
    PRIVATE_CUSTOM_TITLE,
    PRIVATE_SERVER_TITLE,
    PRIVATE_MEMBER,
    PRIVATE_ADDRESS,
    PRIVATE_MEDIA_URI,
    PRIVATE_BLURHASH,
    PRIVATE_THEME_TOKEN,
  ];
}

function expectPrivateCanariesAbsent(tree: unknown): void {
  const json = JSON.stringify(tree);
  for (const canary of privateCanaries()) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(canary)).toBeNull();
    expect(screen.queryByDisplayValue(canary)).toBeNull();
    expect(screen.queryByLabelText(new RegExp(canary))).toBeNull();
  }
}

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: mockGuid }),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents' },
  Directory: class Directory {
    create(): void {}
  },
  File: class File {
    extension = '.jpg';
    uri = 'file:///documents/copied-background.jpg';
    async copy(): Promise<void> {}
  },
}));

jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));

jest.mock('@ui/toast/toastStore', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

jest.mock('@db/repositories', () => ({
  getChatParticipants: jest.fn(),
  getChatTheme: jest.fn(),
  listChatAttachmentsByKind: jest.fn(),
  setChatAppearanceWithinTransaction: (...args: unknown[]) =>
    mockSetChatAppearanceWithinTransaction(...args),
  setChatCustomizationWithinTransaction: (...args: unknown[]) =>
    mockSetChatCustomizationWithinTransaction(...args),
  setHandleColorWithinTransaction: (...args: unknown[]) =>
    mockSetHandleColorWithinTransaction(...args),
  setChatMuteWithinTransaction: (...args: unknown[]) => mockSetChatMuteWithinTransaction(...args),
}));

// Exercise the route through the real account-scoped chat command implementations while keeping
// their unrelated network/cache dependencies inert in this host-rendered component suite.
jest.mock('@core/api', () => ({ chatsApi: {}, scheduledApi: {} }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase: async () =>
    (
      jest.requireMock('@db/database') as {
        getDatabase: () => unknown;
      }
    ).getDatabase(),
}));
jest.mock('@/services/download/attachmentCacheAccountScope', () => ({
  createAttachmentCacheAccountScope: jest.fn(),
}));
jest.mock('@/services/download/downloadService', () => ({
  cancelAttachmentDownloads: jest.fn(),
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {},
}));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn() }));

jest.mock('@db/useReactiveQuery', () => ({
  useReactiveQuery: (_query: unknown, tables: string[], deps: unknown[]) => {
    const ReactLib = jest.requireActual('react') as typeof import('react');
    mockReactiveHookCall(tables, deps);
    const requestedGuid = String(deps[0] ?? mockGuid);
    const firstGuid = ReactLib.useRef(requestedGuid).current;
    if (mockPendingReactiveGuid === requestedGuid && firstGuid === requestedGuid) {
      return { data: null, isLoading: true, error: null };
    }
    const source = mockSourceFor(
      mockPendingReactiveGuid === requestedGuid ? firstGuid : requestedGuid,
    );
    if (tables.includes('chat_handles')) {
      return {
        data: [
          {
            address: source.address,
            name: source.member,
            service: 'iMessage',
            color: mockHandleColor,
          },
        ],
      };
    }
    if (tables.includes('messages')) {
      return {
        data: {
          photos: [
            {
              id: 1,
              guid: source.mediaGuid,
              messageId: 91,
              mimeType: 'image/jpeg',
              transferName: 'shared-photo.jpg',
              totalBytes: 1000,
              height: 100,
              width: 100,
              blurhash: source.blurhash,
              hasLivePhoto: 0,
              isSticker: 0,
              hideAttachment: 0,
              localPath: source.mediaUri,
              service: null,
            },
          ],
          videos: [],
          documents: [],
          links: [{ url: source.link, messageGuid: `${source.mediaGuid}-link`, dateCreated: 1 }],
        },
      };
    }
    return { data: { themeTokens: null, backgroundUri: source.mediaUri } };
  },
}));

jest.mock('@features/conversations/useChatHeader', () => ({
  useChatHeader: (guid: string) => {
    mockUseChatHeader(guid);
    const source = mockSourceFor(guid);
    return {
      data: {
        id: 91,
        guid,
        chatIdentifier: 'private-chat-identifier',
        displayName:
          mockDisplayNameOverride === undefined ? source.serverTitle : mockDisplayNameOverride,
        customName: source.customTitle,
        customColor: mockCustomColor,
        muteType: mockMuteType,
        style: mockChatStyle,
        participantCount: mockParticipantCount,
        participantNames: `${source.member}, Second Member`,
        participantAvatars: null,
        participantAddresses: `${source.address}|||second@example.invalid`,
        handleServices: mockHandleServices,
      },
    };
  },
}));

jest.mock('@features/conversations/useSharedDocuments', () => ({
  useSharedDocuments: (guid: string) => {
    const source = mockSourceFor(guid);
    return {
      data: {
        items: [
          {
            id: 2,
            guid: `${source.mediaGuid}-document`,
            messageId: 92,
            mimeType: 'application/pdf',
            transferName: 'shared-document.pdf',
            totalBytes: 2000,
            height: null,
            width: null,
            blurhash: null,
            hasLivePhoto: 0,
            isSticker: 0,
            hideAttachment: 0,
            localPath: null,
            service: null,
            dateCreated: 2,
          },
        ],
        hasMore: false,
      },
      isLoading: false,
      error: null,
      hasMore: false,
      loadingMore: false,
      loadMoreError: null,
      loadMore: jest.fn(),
      retry: jest.fn(),
    };
  },
}));

jest.mock('@utils', () => ({
  isGroupRow: (row: { style?: number }) => row.style === 43,
  isProvenIMessageGroupChat: (row: {
    guid?: string;
    style?: number;
    participantCount?: number;
    handleServices?: string | null;
  }) => {
    const services = (row.handleServices ?? '').split(',').filter(Boolean);
    return (
      !!row.guid?.startsWith('iMessage;+;') &&
      row.style === 43 &&
      (row.participantCount ?? 0) >= 2 &&
      services.length === row.participantCount &&
      services.every((service) => service === 'iMessage')
    );
  },
  resolveTitle: (row: { customName?: string | null; displayName?: string | null }) =>
    row.customName || row.displayName || 'Conversation',
  isLocalFileUri: (uri: string | null | undefined) => !!uri?.startsWith('file://'),
  safeOpenUrl: (...args: unknown[]) => mockSafeOpenUrl(...args),
}));

jest.mock('@/services', () => {
  const chatActions = jest.requireActual(
    '@/services/chatActions',
  ) as typeof import('@/services/chatActions');
  return {
    addAppleGroupParticipant: (...args: unknown[]) => mockAddAppleGroupParticipant(...args),
    computeBackgroundIsLight: (...args: unknown[]) => mockComputeBackgroundIsLight(...args),
    leaveAppleGroup: (...args: unknown[]) => mockLeaveAppleGroup(...args),
    prepareAppleGroupPhotoSet: (...args: unknown[]) => mockPrepareAppleGroupPhotoSet(...args),
    renameAppleGroup: (...args: unknown[]) => mockRenameAppleGroup(...args),
    removeAppleGroupPhoto: (...args: unknown[]) => mockRemoveAppleGroupPhoto(...args),
    removeAppleGroupParticipant: (...args: unknown[]) => mockRemoveAppleGroupParticipant(...args),
    resetChatLocalPreferences: chatActions.resetChatLocalPreferences,
    setChatMuted: chatActions.setChatMuted,
    startChatRepair: (...args: unknown[]) => mockStartChatRepair(...args),
    updateChatAppearance: chatActions.updateChatAppearance,
    updateChatCustomization: chatActions.updateChatCustomization,
    updateHandleColor: chatActions.updateHandleColor,
  };
});

jest.mock('@/services/notifications/notifeeService', () => ({
  openChatNotificationSettings: (...args: unknown[]) => mockOpenNotificationSettings(...args),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => {
  const actual = jest.requireActual(
    '@/services/realtime/deliveryCoordinator',
  ) as typeof import('@/services/realtime/deliveryCoordinator');
  return {
    captureRealtimeDeliveryLease: () => mockAccountLease,
    subscribeRealtimeGenerationInvalidation: (generation: number, callback: () => void) => {
      mockSubscribeGenerationInvalidation(generation, callback);
      const listeners = mockInvalidationListeners.get(generation) ?? new Set<() => void>();
      listeners.add(callback);
      mockInvalidationListeners.set(generation, listeners);
      return () => listeners.delete(callback);
    },
    runTrackedRealtimeWork: actual.runTrackedRealtimeWork,
    pauseRealtimeDeliveries: actual.pauseRealtimeDeliveries,
    resumeRealtimeDeliveries: actual.resumeRealtimeDeliveries,
  };
});

jest.mock('@ui/permissions/photoLibraryPermission', () => ({
  requestPhotoLibraryAccess: (...args: unknown[]) => mockRequestPhotoLibraryAccess(...args),
}));

jest.mock('@ui/theme/adaptiveFromImage', () => ({
  adaptiveTokensFromImage: (...args: unknown[]) => mockAdaptiveTokensFromImage(...args),
}));

jest.mock('expo-image', () => {
  const ReactNative = jest.requireActual('react-native') as typeof import('react-native');
  const ReactLib = jest.requireActual('react') as typeof import('react');
  return {
    Image: (props: Record<string, unknown>) =>
      ReactLib.createElement(ReactNative.View, { ...props, testID: 'route-media-image' }),
  };
});

jest.mock('@ui/attachments/useAttachmentCachePathProtection', () => ({
  useAttachmentCachePathProtection: (path: string | null) => path,
}));

jest.mock('@ui', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  const { Pressable, Text, View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  const { gatorTheme } = jest.requireActual(
    '@ui/theme/tokens',
  ) as typeof import('@ui/theme/tokens');
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, children);
  return {
    Screen: passthrough,
    ScreenHeader: ({ title, onBack }: { title: string; onBack: () => void }) =>
      ReactLib.createElement(
        View,
        null,
        ReactLib.createElement(
          Pressable,
          { accessibilityRole: 'button', accessibilityLabel: 'Back', onPress: onBack },
          ReactLib.createElement(Text, null, 'Back'),
        ),
        ReactLib.createElement(Text, null, title),
      ),
    SettingsSection: ({ label, children }: { label: string; children?: React.ReactNode }) =>
      ReactLib.createElement(View, null, ReactLib.createElement(Text, null, label), children),
    NavRow: ({
      label,
      accessibilityLabel,
      onPress,
      disabled,
    }: {
      label: string;
      accessibilityLabel?: string;
      onPress?: () => void;
      disabled?: boolean;
    }) =>
      ReactLib.createElement(
        Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: accessibilityLabel ?? label,
          accessibilityState: { disabled: !!disabled },
          disabled,
          onPress,
        },
        ReactLib.createElement(Text, null, label),
      ),
    SwitchRow: ({
      label,
      value,
      onValueChange,
    }: {
      label: string;
      value: boolean;
      onValueChange: (value: boolean) => void;
    }) =>
      ReactLib.createElement(
        Pressable,
        {
          accessibilityRole: 'switch',
          accessibilityLabel: label,
          onPress: () => onValueChange(!value),
        },
        ReactLib.createElement(Text, null, label),
      ),
    ThemeStudio: ({
      onCancel,
      onApply,
      cancelRequest = 0,
    }: {
      onCancel: () => void;
      onApply: (tokens: Record<string, unknown>) => void;
      cancelRequest?: number;
    }) => {
      const lastCancelRequest = ReactLib.useRef(cancelRequest);
      ReactLib.useEffect(() => {
        if (cancelRequest === lastCancelRequest.current) return;
        lastCancelRequest.current = cancelRequest;
        onCancel();
      }, [cancelRequest, onCancel]);

      return ReactLib.createElement(
        View,
        null,
        ReactLib.createElement(Text, null, PRIVATE_THEME_TOKEN),
        ReactLib.createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Close theme editor',
            onPress: onCancel,
          },
          ReactLib.createElement(Text, null, 'Close theme editor'),
        ),
        ReactLib.createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Apply test theme',
            onPress: () => onApply({ mode: 'dark', canary: PRIVATE_THEME_TOKEN }),
          },
          ReactLib.createElement(Text, null, 'Apply test theme'),
        ),
      );
    },
    useTheme: () => gatorTheme,
  };
});

// eslint-disable-next-line import/first
import ChatSettingsScreen from '../../../app/(app)/chat-settings/[guid]';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

let keyboardDismissSpy: jest.SpiedFunction<typeof Keyboard.dismiss>;
const mockGetDatabase = getDatabase as jest.Mock;

beforeEach(() => {
  resumeRealtimeDeliveries();
  useSessionStore.setState({ serverInfo: { version: 'test', private_api: true } as any });
  jest.clearAllMocks();
  reduceMotionListener = undefined;
  removeReduceMotionListener = jest.fn();
  mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
  mockAddEventListener.mockReset().mockImplementation((event, listener) => {
    expect(event).toBe('reduceMotionChanged');
    reduceMotionListener = listener as (enabled: boolean) => void;
    return { remove: removeReduceMotionListener };
  });
  mockGuid = CHAT_GUID;
  mockMuteType = null;
  mockCustomColor = null;
  mockHandleColor = null;
  mockChatStyle = 43;
  mockParticipantCount = 2;
  mockHandleServices = null;
  mockDisplayNameOverride = undefined;
  mockPendingReactiveGuid = null;
  mockAccountLease = makeLease(73);
  mockInvalidationListeners.clear();
  mockGetDatabase.mockReset().mockReturnValue(mockDatabase);
  mockDatabase.run.mockReset().mockResolvedValue(undefined);
  mockDatabaseB.run.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  keyboardDismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  mockRequestPhotoLibraryAccess.mockResolvedValue(true);
  mockLaunchImageLibrary.mockResolvedValue({ canceled: true, assets: [] });
  mockOpenNotificationSettings.mockResolvedValue(undefined);
  mockSetChatAppearanceWithinTransaction.mockReset().mockResolvedValue(undefined);
  mockSetChatCustomizationWithinTransaction.mockReset().mockResolvedValue(undefined);
  mockSetHandleColorWithinTransaction.mockReset().mockResolvedValue(true);
  mockSetChatMuteWithinTransaction.mockReset().mockResolvedValue(undefined);
  mockComputeBackgroundIsLight.mockReset().mockResolvedValue(false);
  mockAdaptiveTokensFromImage.mockReset().mockResolvedValue(null);
  mockSafeOpenUrl.mockReset().mockResolvedValue(true);
  mockStartChatRepair.mockReset().mockResolvedValue({
    messages: 0,
    historyExhausted: false,
    restored: false,
  });
  mockRenameAppleGroup.mockReset().mockResolvedValue({
    status: 'accepted',
    tempGuid: 'temp-rename1',
    guid: GROUP_CHAT_GUID,
    displayName: 'Renamed Group',
  });
  mockSubmitAppleGroupPhoto.mockReset().mockResolvedValue({
    status: 'accepted',
    operation: 'set',
    tempGuid: 'temp-photo1',
    guid: GROUP_CHAT_GUID,
  });
  mockCancelAppleGroupPhoto.mockReset();
  mockPrepareAppleGroupPhotoSet.mockReset().mockResolvedValue({
    submit: (...args: unknown[]) => mockSubmitAppleGroupPhoto(...args),
    cancel: () => mockCancelAppleGroupPhoto(),
  });
  mockRemoveAppleGroupPhoto.mockReset().mockResolvedValue({
    status: 'accepted',
    operation: 'remove',
    tempGuid: 'temp-photo2',
    guid: GROUP_CHAT_GUID,
  });
  mockAddAppleGroupParticipant.mockReset().mockResolvedValue({
    status: 'accepted',
    tempGuid: 'temp-participant1',
    guid: GROUP_CHAT_GUID,
    address: '+15559876543',
  });
  mockRemoveAppleGroupParticipant.mockReset().mockResolvedValue({
    status: 'accepted',
    tempGuid: 'temp-participant-remove1',
    guid: GROUP_CHAT_GUID,
    address: PRIVATE_ADDRESS,
  });
  mockLeaveAppleGroup.mockReset().mockResolvedValue({
    status: 'outcome-unknown',
    tempGuid: 'temp-leave1',
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
  keyboardDismissSpy.mockRestore();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
});

async function retireLease(lease: MockLease): Promise<void> {
  lease.current = false;
  await act(async () => {
    for (const listener of mockInvalidationListeners.get(lease.generation) ?? []) listener();
    await Promise.resolve();
  });
}

function dialogAction(label: string): (() => void) | undefined {
  const actions = mockShowDialog.mock.calls.at(-1)?.[2] as
    { text: string; onPress?: () => void }[] | undefined;
  return actions?.find((action) => action.text === label)?.onPress;
}

function pickedAsset(uri: string): {
  canceled: false;
  assets: { uri: string; fileName: string; mimeType: string }[];
} {
  return {
    canceled: false,
    assets: [{ uri, fileName: 'picked.jpg', mimeType: 'image/jpeg' }],
  };
}

async function settleMotionPreference(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
}

async function emitReduceMotion(enabled: boolean): Promise<void> {
  expect(reduceMotionListener).toBeDefined();
  await act(async () => reduceMotionListener?.(enabled));
}

function studioModal() {
  return screen.getByTestId('chat-theme-studio-modal');
}

async function requestCloseStudio(): Promise<void> {
  const onRequestClose = studioModal().props.onRequestClose as () => void;
  await act(async () => onRequestClose());
  await waitFor(() => expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull());
}

describe('ChatSettingsScreen reduced motion', () => {
  it('latches an unresolved opening at none and applies later false only after Back and reopening', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    await view.rerender(<ChatSettingsScreen />);
    expect(studioModal().props.animationType).toBe('none');

    await requestCloseStudio();
    expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull();
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('slide');
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['enabled', true, 'none'],
    ['query failure', new Error('motion preference unavailable'), 'slide'],
  ] as const)('uses the expected opening after initial %s', async (_label, result, expected) => {
    if (result instanceof Error) mockIsReduceMotionEnabled.mockRejectedValue(result);
    else mockIsReduceMotionEnabled.mockResolvedValue(result);
    await renderWithTheme(<ChatSettingsScreen />);
    await settleMotionPreference();

    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe(expected);
  });

  it('keeps a visible opening stable, then applies live changes after Cancel or Apply', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);
    await settleMotionPreference();
    const themeRow = screen.getByText('Chat Theme…');
    if (!themeRow.parent) throw new Error('Expected the Chat Theme Pressable');
    const retainedOpen = retainConfiguredPress(themeRow.parent);

    await fireEvent.press(themeRow);
    expect(studioModal().props.animationType).toBe('slide');
    await emitReduceMotion(true);
    await view.rerender(<ChatSettingsScreen />);
    await act(async () => retainedOpen());
    expect(studioModal().props.animationType).toBe('slide');

    await fireEvent.press(screen.getByRole('button', { name: 'Close theme editor' }));
    expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull();
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');

    await emitReduceMotion(false);
    await view.rerender(<ChatSettingsScreen />);
    expect(studioModal().props.animationType).toBe('none');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply test theme' }));
    await waitFor(() => expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull());
    await waitFor(() =>
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        {
          themeTokens: JSON.stringify({ mode: 'dark', canary: PRIVATE_THEME_TOKEN }),
        },
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));

    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('slide');
  });

  it('lets a synchronous registration event beat a stale query and removes the owner once', async () => {
    const staleQuery = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(staleQuery.promise);
    mockAddEventListener.mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      reduceMotionListener(true);
      return { remove: removeReduceMotionListener };
    });
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await act(async () => {
      staleQuery.resolve(false);
      await staleQuery.promise;
    });
    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');

    await requestCloseStudio();
    await emitReduceMotion(false);
    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('slide');

    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
  });
});

describe('ChatSettingsScreen Apple group rename', () => {
  function configureEligibleGroup(): void {
    mockGuid = GROUP_CHAT_GUID;
    mockChatStyle = 43;
    mockParticipantCount = 2;
    mockHandleServices = 'iMessage,iMessage';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_rename: true,
      } as any,
    });
  }

  it('keeps the phone-local nickname separate and submits the exact Apple group name once', async () => {
    configureEligibleGroup();
    const view = await renderWithTheme(<ChatSettingsScreen />);

    expect(screen.getByText('PHONE-LOCAL NICKNAME')).toBeTruthy();
    expect(screen.getByLabelText('Phone-Local Nickname').props.value).toBe(PRIVATE_CUSTOM_TITLE);
    expect(screen.getByText('APPLE GROUP NAME')).toBeTruthy();
    const input = screen.getByLabelText('Apple Group Name');
    expect(input.props.value).toBe(PRIVATE_SERVER_TITLE);

    await fireEvent.changeText(input, 'Renamed Group');
    await fireEvent.press(screen.getByRole('button', { name: 'Rename in Apple Messages' }));

    await waitFor(() =>
      expect(mockRenameAppleGroup).toHaveBeenCalledWith(
        { chatGuid: GROUP_CHAT_GUID, displayName: 'Renamed Group' },
        mockAccountLease,
      ),
    );
    expect(mockRenameAppleGroup).toHaveBeenCalledTimes(1);
    expect(mockSetChatCustomizationWithinTransaction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Rename in Apple Messages' }).props.accessibilityState,
      ).toEqual({ disabled: true }),
    );

    // Keep the accepted name visible while the reactive row still contains the pre-submit value.
    await view.rerender(<ChatSettingsScreen />);
    expect(screen.getByLabelText('Apple Group Name').props.value).toBe('Renamed Group');

    // Once sync echoes the accepted value, release the local overlay. Later remote renames must
    // flow through the same mounted screen instead of remaining masked by the accepted draft.
    mockDisplayNameOverride = 'Renamed Group';
    await view.rerender(<ChatSettingsScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText('Apple Group Name').props.value).toBe('Renamed Group'),
    );
    mockDisplayNameOverride = 'Renamed by Another Member';
    await view.rerender(<ChatSettingsScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText('Apple Group Name').props.value).toBe(
        'Renamed by Another Member',
      ),
    );
  });

  it('releases an accepted overlay when the authoritative name changes before its echo', async () => {
    configureEligibleGroup();
    mockRenameAppleGroup.mockResolvedValueOnce({
      status: 'accepted',
      tempGuid: 'temp-accepted-before-echo',
      guid: GROUP_CHAT_GUID,
      displayName: 'My Accepted Name',
    });
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(screen.getByLabelText('Apple Group Name'), 'My Accepted Name');
    await fireEvent.press(screen.getByRole('button', { name: 'Rename in Apple Messages' }));
    await waitFor(() => expect(mockRenameAppleGroup).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Apple Group Name').props.value).toBe('My Accepted Name');

    mockDisplayNameOverride = 'A Newer Remote Name';
    await view.rerender(<ChatSettingsScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText('Apple Group Name').props.value).toBe('A Newer Remote Name'),
    );
  });

  it.each([
    [{ status: 'rejected', tempGuid: 'temp-reject1' }, 'Apple Group Name Not Changed'],
    [{ status: 'outcome-unknown', tempGuid: 'temp-unknown1' }, 'Rename Not Confirmed'],
  ])(
    'keeps the typed name after %j and never submits it again automatically',
    async (result, title) => {
      configureEligibleGroup();
      mockRenameAppleGroup.mockResolvedValue(result);
      await renderWithTheme(<ChatSettingsScreen />);

      const input = screen.getByLabelText('Apple Group Name');
      await fireEvent.changeText(input, 'Keep My Typed Name');
      await fireEvent.press(screen.getByRole('button', { name: 'Rename in Apple Messages' }));

      await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(title, expect.any(String)));
      expect(screen.getByLabelText('Apple Group Name').props.value).toBe('Keep My Typed Name');
      expect(mockRenameAppleGroup).toHaveBeenCalledTimes(1);
    },
  );

  it('hides the remote control without both the live capability and exact participant proof', async () => {
    mockGuid = GROUP_CHAT_GUID;
    mockHandleServices = 'iMessage,iMessage';
    const withoutCapability = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByLabelText('Apple Group Name')).toBeNull();
    await withoutCapability.unmount();

    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_rename: true,
      } as any,
    });
    mockHandleServices = 'iMessage,SMS';
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByLabelText('Apple Group Name')).toBeNull();
    expect(mockRenameAppleGroup).not.toHaveBeenCalled();
  });
});

describe('ChatSettingsScreen Apple group photo', () => {
  function configureEligibleGroupPhoto(): void {
    mockGuid = GROUP_CHAT_GUID;
    mockChatStyle = 43;
    mockParticipantCount = 2;
    mockHandleServices = 'iMessage,iMessage';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_photo: true,
      } as any,
    });
  }

  it('pins the exact operation before picker UI and submits one JPEG without local mutation', async () => {
    configureEligibleGroupPhoto();
    mockLaunchImageLibrary.mockResolvedValueOnce(pickedAsset('file:///picker/group-photo.jpg'));
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Change Apple Group Photo' }));
    await waitFor(() => expect(mockSubmitAppleGroupPhoto).toHaveBeenCalledTimes(1));

    expect(mockPrepareAppleGroupPhotoSet).toHaveBeenCalledWith(GROUP_CHAT_GUID, mockAccountLease);
    expect(mockPrepareAppleGroupPhotoSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequestPhotoLibraryAccess.mock.invocationCallOrder[0]!,
    );
    expect(mockPrepareAppleGroupPhotoSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockLaunchImageLibrary.mock.invocationCallOrder[0]!,
    );
    expect(mockSubmitAppleGroupPhoto).toHaveBeenCalledWith({
      uri: 'file:///picker/group-photo.jpg',
      name: 'picked.jpg',
      mimeType: 'image/jpeg',
      size: undefined,
    });
    expect(mockSubmitAppleGroupPhoto).toHaveBeenCalledTimes(1);
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
    expect(mockSetChatCustomizationWithinTransaction).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Group Photo Change Accepted',
      expect.stringContaining('Check the group in Messages on your Mac'),
    );
  });

  it('rejects a HEIC MIME or filename clearly and cancels the unused pinned grant', async () => {
    configureEligibleGroupPhoto();
    mockLaunchImageLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///picker/group-photo.heic',
          fileName: 'group-photo.heic',
          mimeType: 'image/heic',
        },
      ],
    });
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Change Apple Group Photo' }));
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Unsupported Group Photo',
        expect.stringContaining('HEIC photos are not supported'),
      ),
    );
    expect(mockSubmitAppleGroupPhoto).not.toHaveBeenCalled();
    expect(mockCancelAppleGroupPhoto).toHaveBeenCalledTimes(1);
  });

  it('uses explicit uncertainty wording and never retries set or remove automatically', async () => {
    configureEligibleGroupPhoto();
    mockLaunchImageLibrary.mockResolvedValueOnce(pickedAsset('file:///picker/group-photo.jpg'));
    mockSubmitAppleGroupPhoto.mockResolvedValueOnce({
      status: 'outcome-unknown',
      operation: 'set',
      tempGuid: 'temp-photo-unknown',
    });
    mockRemoveAppleGroupPhoto.mockResolvedValueOnce({
      status: 'outcome-unknown',
      operation: 'remove',
      tempGuid: 'temp-remove-unknown',
    });
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Change Apple Group Photo' }));
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Photo Change Not Confirmed',
        expect.stringContaining('may have reached Messages'),
      ),
    );
    expect(mockSubmitAppleGroupPhoto).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Remove Apple Group Photo' }));
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Remove Apple Group Photo?',
      expect.any(String),
      expect.any(Array),
    );
    await act(async () => dialogAction('Remove Photo')?.());
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Photo Removal Not Confirmed',
        expect.stringContaining('may have reached Messages'),
      ),
    );
    expect(mockRemoveAppleGroupPhoto).toHaveBeenCalledWith(
      { chatGuid: GROUP_CHAT_GUID },
      mockAccountLease,
    );
    expect(mockRemoveAppleGroupPhoto).toHaveBeenCalledTimes(1);
  });

  it('hides both controls without the live capability and exact local group proof', async () => {
    mockGuid = GROUP_CHAT_GUID;
    mockHandleServices = 'iMessage,iMessage';
    const withoutCapability = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: 'Change Apple Group Photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Apple Group Photo' })).toBeNull();
    await withoutCapability.unmount();

    configureEligibleGroupPhoto();
    mockHandleServices = 'iMessage,SMS';
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: 'Change Apple Group Photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Apple Group Photo' })).toBeNull();
  });
});

describe('ChatSettingsScreen Apple group participant add', () => {
  function configureEligibleGroupParticipantAdd(): void {
    mockGuid = GROUP_CHAT_GUID;
    mockChatStyle = 43;
    mockParticipantCount = 2;
    mockHandleServices = 'iMessage,iMessage';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_participant_add: true,
      } as any,
    });
  }

  it('submits one exact address, clears only accepted input, and waits for roster sync', async () => {
    configureEligibleGroupParticipantAdd();
    await renderWithTheme(<ChatSettingsScreen />);

    const input = screen.getByLabelText('Apple Group Participant Address');
    await fireEvent.changeText(input, '+15559876543');
    await fireEvent.press(screen.getByRole('button', { name: 'Add Person to Apple Group' }));

    await waitFor(() =>
      expect(mockAddAppleGroupParticipant).toHaveBeenCalledWith(
        { chatGuid: GROUP_CHAT_GUID, address: '+15559876543' },
        mockAccountLease,
      ),
    );
    expect(mockAddAppleGroupParticipant).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByLabelText('Apple Group Participant Address').props.value).toBe(''),
    );
    expect(mockSetChatCustomizationWithinTransaction).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Add Request Accepted',
      expect.stringContaining('after Messages syncs the roster'),
    );
  });

  it.each([
    [{ status: 'rejected', tempGuid: 'temp-participant-rejected' }, 'Person Not Added'],
    [{ status: 'outcome-unknown', tempGuid: 'temp-participant-unknown' }, 'Add Not Confirmed'],
  ])('preserves the address after %j and does not retry automatically', async (result, title) => {
    configureEligibleGroupParticipantAdd();
    mockAddAppleGroupParticipant.mockResolvedValueOnce(result);
    await renderWithTheme(<ChatSettingsScreen />);

    const input = screen.getByLabelText('Apple Group Participant Address');
    await fireEvent.changeText(input, 'person@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add Person to Apple Group' }));

    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(title, expect.any(String)));
    expect(screen.getByLabelText('Apple Group Participant Address').props.value).toBe(
      'person@example.com',
    );
    expect(mockAddAppleGroupParticipant).toHaveBeenCalledTimes(1);
  });

  it('hides the control without both the live capability and exact local group proof', async () => {
    mockGuid = GROUP_CHAT_GUID;
    mockHandleServices = 'iMessage,iMessage';
    const withoutCapability = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByLabelText('Apple Group Participant Address')).toBeNull();
    await withoutCapability.unmount();

    configureEligibleGroupParticipantAdd();
    mockHandleServices = 'iMessage,SMS';
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByLabelText('Apple Group Participant Address')).toBeNull();
    expect(mockAddAppleGroupParticipant).not.toHaveBeenCalled();
  });
});

describe('ChatSettingsScreen Apple group participant removal', () => {
  function configureEligibleGroupParticipantRemoval(includeAdd = false): void {
    mockGuid = GROUP_CHAT_GUID;
    mockChatStyle = 43;
    mockParticipantCount = 3;
    mockHandleServices = 'iMessage,iMessage,iMessage';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_participant_remove: true,
        supports_imessage_group_participant_add: includeAdd,
      } as any,
    });
  }

  it('confirm-gates one exact loaded member and waits for sync after acceptance', async () => {
    configureEligibleGroupParticipantRemoval();
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: `Remove ${PRIVATE_MEMBER} from Apple Group` }),
    );
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Remove Person from Apple Group?',
      expect.stringContaining('for everyone in Apple Messages'),
      expect.any(Array),
    );
    expect(mockRemoveAppleGroupParticipant).not.toHaveBeenCalled();

    await act(async () => dialogAction('Remove Person')?.());
    await waitFor(() =>
      expect(mockRemoveAppleGroupParticipant).toHaveBeenCalledWith(
        { chatGuid: GROUP_CHAT_GUID, address: PRIVATE_ADDRESS },
        mockAccountLease,
      ),
    );
    expect(mockRemoveAppleGroupParticipant).toHaveBeenCalledTimes(1);
    expect(screen.getByText(PRIVATE_MEMBER)).toBeTruthy();
    expect(mockSetChatCustomizationWithinTransaction).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Removal Request Accepted',
      expect.stringContaining('after Messages sync confirms it'),
    );
  });

  it.each([
    [{ status: 'rejected', tempGuid: 'temp-remove-rejected' }, 'Person Not Removed'],
    [{ status: 'outcome-unknown', tempGuid: 'temp-remove-unknown' }, 'Removal Not Confirmed'],
  ])('keeps the roster after %j and never retries automatically', async (result, title) => {
    configureEligibleGroupParticipantRemoval();
    mockRemoveAppleGroupParticipant.mockResolvedValueOnce(result);
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: `Remove ${PRIVATE_MEMBER} from Apple Group` }),
    );
    await act(async () => dialogAction('Remove Person')?.());
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(title, expect.any(String)));

    expect(screen.getByText(PRIVATE_MEMBER)).toBeTruthy();
    expect(mockRemoveAppleGroupParticipant).toHaveBeenCalledTimes(1);
  });

  it('hides removal without the capability, three members, and exact iMessage proof', async () => {
    mockGuid = GROUP_CHAT_GUID;
    mockParticipantCount = 3;
    mockHandleServices = 'iMessage,iMessage,iMessage';
    const withoutCapability = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: /from Apple Group$/u })).toBeNull();
    await withoutCapability.unmount();

    configureEligibleGroupParticipantRemoval();
    mockParticipantCount = 2;
    mockHandleServices = 'iMessage,iMessage';
    const withTwoMembers = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: /from Apple Group$/u })).toBeNull();
    await withTwoMembers.unmount();

    configureEligibleGroupParticipantRemoval();
    mockHandleServices = 'iMessage,iMessage,SMS';
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: /from Apple Group$/u })).toBeNull();
  });

  it('does not start removal while an add attempt owns the shared membership lane', async () => {
    configureEligibleGroupParticipantRemoval(true);
    const pendingAdd = deferred<{
      status: 'accepted';
      tempGuid: string;
      guid: string;
      address: string;
    }>();
    mockAddAppleGroupParticipant.mockReturnValueOnce(pendingAdd.promise);
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(
      screen.getByLabelText('Apple Group Participant Address'),
      '+15559876543',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Add Person to Apple Group' }));
    await waitFor(() => expect(mockAddAppleGroupParticipant).toHaveBeenCalledTimes(1));

    const remove = screen.getByRole('button', {
      name: `Remove ${PRIVATE_MEMBER} from Apple Group`,
    });
    expect(remove.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(remove);
    expect(mockRemoveAppleGroupParticipant).not.toHaveBeenCalled();

    await act(async () => {
      pendingAdd.resolve({
        status: 'accepted',
        tempGuid: 'temp-add-cross-lane',
        guid: GROUP_CHAT_GUID,
        address: '+15559876543',
      });
      await pendingAdd.promise;
    });
  });
});

describe('ChatSettingsScreen Apple group leave', () => {
  function configureEligibleGroupLeave(includeOtherMembershipActions = false): void {
    mockGuid = GROUP_CHAT_GUID;
    mockChatStyle = 43;
    mockParticipantCount = includeOtherMembershipActions ? 3 : 2;
    mockHandleServices = includeOtherMembershipActions
      ? 'iMessage,iMessage,iMessage'
      : 'iMessage,iMessage';
    useSessionStore.setState({
      serverInfo: {
        version: 'test',
        private_api: false,
        supports_imessage_group_leave: true,
        supports_imessage_group_participant_add: includeOtherMembershipActions,
        supports_imessage_group_participant_remove: includeOtherMembershipActions,
      } as any,
    });
  }

  it.each([
    [
      { status: 'accepted', tempGuid: 'temp-leave-accepted', guid: GROUP_CHAT_GUID },
      'Leave Request Accepted',
      'authoritative sync',
    ],
    [{ status: 'rejected', tempGuid: 'temp-leave-rejected' }, 'Group Not Left', 'roster unchanged'],
    [
      { status: 'outcome-unknown', tempGuid: 'temp-leave-unknown' },
      'Leave Not Confirmed',
      'may have reached Messages',
    ],
  ])(
    'confirm-gates %j, keeps the local conversation, and waits for Messages',
    async (result, title, copy) => {
      configureEligibleGroupLeave();
      mockLeaveAppleGroup.mockResolvedValueOnce(result);
      await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByRole('button', { name: 'Leave Apple Group' }));
      expect(mockShowDialog).toHaveBeenLastCalledWith(
        'Leave Apple Group?',
        expect.stringContaining('may remove your access'),
        expect.any(Array),
      );
      expect(mockLeaveAppleGroup).not.toHaveBeenCalled();

      await act(async () => dialogAction('Leave Group')?.());
      await waitFor(() =>
        expect(mockLeaveAppleGroup).toHaveBeenCalledWith(
          { chatGuid: GROUP_CHAT_GUID },
          mockAccountLease,
        ),
      );
      await waitFor(() =>
        expect(mockShowDialog).toHaveBeenCalledWith(title, expect.stringContaining(copy)),
      );
      expect(mockLeaveAppleGroup).toHaveBeenCalledTimes(1);
      expect(screen.getByText(PRIVATE_MEMBER)).toBeTruthy();
      expect(mockBack).not.toHaveBeenCalled();
      expect(mockDatabase.run).not.toHaveBeenCalled();
    },
  );

  it('hides leave without both its live capability and exact iMessage group proof', async () => {
    mockGuid = GROUP_CHAT_GUID;
    mockHandleServices = 'iMessage,iMessage';
    const withoutCapability = await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: 'Leave Apple Group' })).toBeNull();
    await withoutCapability.unmount();

    configureEligibleGroupLeave();
    mockHandleServices = 'iMessage,SMS';
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.queryByRole('button', { name: 'Leave Apple Group' })).toBeNull();
    expect(mockLeaveAppleGroup).not.toHaveBeenCalled();
  });

  it('owns the shared UI lane against both add and remove while leave is pending', async () => {
    configureEligibleGroupLeave(true);
    const pendingLeave = deferred<{
      status: 'outcome-unknown';
      tempGuid: string;
    }>();
    mockLeaveAppleGroup.mockReturnValueOnce(pendingLeave.promise);
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(
      screen.getByLabelText('Apple Group Participant Address'),
      '+15559876543',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Leave Apple Group' }));
    await act(async () => dialogAction('Leave Group')?.());
    await waitFor(() => expect(mockLeaveAppleGroup).toHaveBeenCalledTimes(1));

    const add = screen.getByRole('button', { name: 'Add Person to Apple Group' });
    const remove = screen.getByRole('button', {
      name: `Remove ${PRIVATE_MEMBER} from Apple Group`,
    });
    expect(add.props.accessibilityState).toEqual({ disabled: true });
    expect(remove.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(add);
    await fireEvent.press(remove);
    expect(mockAddAppleGroupParticipant).not.toHaveBeenCalled();
    expect(mockRemoveAppleGroupParticipant).not.toHaveBeenCalled();

    await act(async () => {
      pendingLeave.resolve({ status: 'outcome-unknown', tempGuid: 'temp-leave-pending' });
      await pendingLeave.promise;
    });
  });
});

describe('ChatSettingsScreen source and account ownership', () => {
  it('keeps group details read-only even when an old server advertises Private API', async () => {
    await renderWithTheme(<ChatSettingsScreen />);

    expect(screen.getByText(PRIVATE_MEMBER)).toBeTruthy();
    expect(screen.getByText('Chat Theme…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Remove ${PRIVATE_MEMBER}` })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Person…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Group…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change Photo…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Photo' })).toBeNull();
  });

  it.each([
    [CHAT_GUID, 73],
    [CHAT_GUID_B, 74],
  ] as const)('renders exact ordinary content and actions for %s', async (guid, generation) => {
    mockGuid = guid;
    mockAccountLease = makeLease(generation);
    const source = mockSourceFor(guid);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    expect(screen.getByDisplayValue(source.customTitle)).toBeTruthy();
    expect(screen.getByPlaceholderText(source.serverTitle)).toBeTruthy();
    expect(screen.getByText(source.member)).toBeTruthy();
    expect(screen.getByText(source.link)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(source.mediaUri);
    expect(JSON.stringify(view.toJSON())).toContain(source.blurhash);

    await fireEvent.press(screen.getByRole('imagebutton', { name: 'Shared photo 1 of 1' }));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(source.mediaGuid)}`);
    await fireEvent.press(screen.getByRole('button', { name: 'Shared documents, 1' }));
    expect(mockPush).toHaveBeenCalledWith(`/documents/${encodeURIComponent(guid)}`);
    await fireEvent.press(screen.getByText(source.link));
    expect(mockSafeOpenUrl).toHaveBeenCalledWith(source.link);
    expect(mockShowToast).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('shows generic feedback for a current shared-link failure', async () => {
    mockSafeOpenUrl.mockResolvedValue(false);
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText(PRIVATE_LINK));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Couldn’t open this outside Gator.'),
    );
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  it('drops an old shared-link failure after the keyed route source changes', async () => {
    const oldOpen = deferred<boolean>();
    mockSafeOpenUrl.mockReturnValueOnce(oldOpen.promise).mockResolvedValueOnce(false);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText(PRIVATE_LINK));
    await waitFor(() => expect(mockSafeOpenUrl).toHaveBeenCalledWith(PRIVATE_LINK));

    mockPendingReactiveGuid = CHAT_GUID_B;
    mockGuid = CHAT_GUID_B;
    await view.rerender(<ChatSettingsScreen />);
    mockPendingReactiveGuid = null;
    await view.rerender(<ChatSettingsScreen />);

    await act(async () => {
      oldOpen.resolve(false);
      await oldOpen.promise;
    });
    expect(mockShowToast).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText(PRIVATE_LINK_B));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));
    expect(mockShowToast).toHaveBeenCalledWith('Couldn’t open this outside Gator.');
  });

  it('key-remounts pending B without retained A data and revokes A callbacks across A to B to A', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);
    const oldMedia = retainConfiguredPress(
      screen.getByRole('imagebutton', { name: 'Shared photo 1 of 1' }),
    );
    const oldDocuments = retainConfiguredPress(
      screen.getByRole('button', { name: 'Shared documents, 1' }),
    );
    const oldLink = retainConfiguredPress(screen.getByText(PRIVATE_LINK).parent!);
    const oldOpenStudio = retainConfiguredPress(screen.getByText('Chat Theme…').parent!);
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Open system notification settings for this conversation',
      }),
    );
    const oldNotificationContext = mockOpenNotificationSettings.mock.calls.at(-1)?.[2] as {
      generation: number;
      isCurrent(): boolean;
    };
    expect(oldNotificationContext.generation).toBe(73);
    expect(oldNotificationContext.isCurrent()).toBe(true);

    await fireEvent.press(screen.getByText('Chat Theme…'));
    const oldApplyTheme = retainConfiguredPress(
      screen.getByRole('button', { name: 'Apply test theme' }),
    );
    await emitReduceMotion(true);
    expect(studioModal().props.animationType).toBe('slide');

    mockPendingReactiveGuid = CHAT_GUID_B;
    mockGuid = CHAT_GUID_B;
    await view.rerender(<ChatSettingsScreen />);
    expect(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE_B)).toBeTruthy();
    expectPrivateCanariesAbsent(view.toJSON());
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(removeReduceMotionListener).not.toHaveBeenCalled();
    await act(async () => {
      oldOpenStudio();
      oldApplyTheme();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull();
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();

    mockPendingReactiveGuid = null;
    await view.rerender(<ChatSettingsScreen />);
    expect(screen.getByText(PRIVATE_MEMBER_B)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_MEDIA_URI_B);
    expect(oldNotificationContext.isCurrent()).toBe(false);

    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply test theme' }));
    await waitFor(() =>
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID_B,
        {
          themeTokens: JSON.stringify({ mode: 'dark', canary: PRIVATE_THEME_TOKEN }),
        },
      ),
    );

    mockPendingReactiveGuid = CHAT_GUID;
    mockGuid = CHAT_GUID;
    await view.rerender(<ChatSettingsScreen />);
    mockPendingReactiveGuid = null;
    await view.rerender(<ChatSettingsScreen />);
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_MEDIA_URI);

    oldMedia();
    oldDocuments();
    oldLink();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('imagebutton', { name: 'Shared photo 1 of 1' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Shared documents, 1' }));
    await fireEvent.press(screen.getByText(PRIVATE_LINK));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(MEDIA_GUID)}`);
    expect(mockPush).toHaveBeenCalledWith(`/documents/${encodeURIComponent(CHAT_GUID)}`);
    expect(mockSafeOpenUrl).toHaveBeenCalledWith(PRIVATE_LINK);
  });

  it('fails closed on an initially stale lease and a fresh account remount works', async () => {
    const staleLease = makeLease(73, false);
    mockAccountLease = staleLease;
    const stale = await renderWithTheme(<ChatSettingsScreen />);

    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
    expectPrivateCanariesAbsent(stale.toJSON());
    expect(mockUseChatHeader).not.toHaveBeenCalled();
    expect(mockReactiveHookCall).not.toHaveBeenCalled();
    expect(screen.queryByRole('imagebutton', { name: 'Shared photo 1 of 1' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);

    await act(async () => stale.unmount());
    mockGuid = CHAT_GUID_B;
    mockAccountLease = makeLease(74);
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE_B)).toBeTruthy();
    await fireEvent.press(screen.getByRole('imagebutton', { name: 'Shared photo 1 of 1' }));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(MEDIA_GUID_B)}`);
  });

  it('automatically retires a mounted account and leaves retained controls inert', async () => {
    const oldLease = mockAccountLease;
    const view = await renderWithTheme(<ChatSettingsScreen />);
    const oldMedia = retainConfiguredPress(
      screen.getByRole('imagebutton', { name: 'Shared photo 1 of 1' }),
    );
    const oldLink = retainConfiguredPress(screen.getByText(PRIVATE_LINK).parent!);
    await fireEvent.press(screen.getByText('Chat Theme…'));
    const oldApplyTheme = retainConfiguredPress(
      screen.getByRole('button', { name: 'Apply test theme' }),
    );
    const oldClearTheme = retainConfiguredPress(
      screen.getByText('Clear chat theme / background').parent!,
    );

    await retireLease(oldLease);

    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
    expectPrivateCanariesAbsent(view.toJSON());
    expect(keyboardDismissSpy).toHaveBeenCalled();
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(removeReduceMotionListener).not.toHaveBeenCalled();
    oldMedia();
    oldLink();
    oldApplyTheme();
    oldClearTheme();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();

    await act(async () => view.unmount());
    mockGuid = CHAT_GUID_B;
    mockAccountLease = makeLease(74);
    await renderWithTheme(<ChatSettingsScreen />);
    await fireEvent.press(screen.getByText(PRIVATE_LINK_B));
    expect(mockSafeOpenUrl).toHaveBeenCalledWith(PRIVATE_LINK_B);
  });

  it.each([
    ['Set Background…', 'success'],
    ['Set Background…', 'rejection'],
    ['Generate theme from background', 'success'],
    ['Generate theme from background', 'rejection'],
  ] as const)(
    'serializes %s across A to B after old A %s and then admits exact B',
    async (control, oldOutcome) => {
      const oldPick = deferred<ReturnType<typeof pickedAsset>>();
      mockLaunchImageLibrary
        .mockReturnValueOnce(oldPick.promise)
        .mockResolvedValueOnce(pickedAsset('file:///picked-current-b.jpg'));
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1));

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      await fireEvent.press(screen.getByText(control));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);

      const rawError = `raw-stale-${control}-picker-rejection-7c31`;
      await act(async () => {
        if (oldOutcome === 'success') {
          oldPick.resolve(pickedAsset('file:///picked-stale-a.jpg'));
        } else {
          oldPick.reject(new Error(rawError));
        }
        await oldPick.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() =>
        expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID_B,
          {
            backgroundUri: 'file:///documents/copied-background.jpg',
            backgroundIsLight: false,
          },
        ),
      );
      await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['Set Background…', 'cancel'],
    ['Set Background…', 'rejection'],
    ['Generate theme from background', 'rejection'],
  ] as const)(
    'releases the current %s picker after %s so an exact retry succeeds',
    async (control, outcome) => {
      const rawError = `raw-current-${control}-picker-rejection-a824`;
      if (outcome === 'cancel') {
        mockLaunchImageLibrary
          .mockResolvedValueOnce({ canceled: true, assets: [] })
          .mockResolvedValueOnce(pickedAsset('file:///picked-retry-a.jpg'));
      } else {
        mockLaunchImageLibrary
          .mockRejectedValueOnce(new Error(rawError))
          .mockResolvedValueOnce(pickedAsset('file:///picked-retry-a.jpg'));
      }
      await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1));
      if (outcome === 'cancel') {
        expect(mockShowDialog).not.toHaveBeenCalled();
      } else {
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith('Photos', 'Couldn’t open the photo picker.'),
        );
        expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);
      }
      expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByText(control));
      await waitFor(() =>
        expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID,
          {
            backgroundUri: 'file:///documents/copied-background.jpg',
            backgroundIsLight: false,
          },
        ),
      );
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['Set Background…', 'Background', 'Couldn’t finish updating this conversation’s background.'],
    [
      'Generate theme from background',
      'Chat Theme',
      'Couldn’t finish generating a theme from this background.',
    ],
  ] as const)(
    'reports fixed %s downstream errors and releases the picker token for retry',
    async (control, title, copy) => {
      const rawError = `raw-${title}-error-canary`;
      mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-background.jpg'));
      mockSetChatAppearanceWithinTransaction
        .mockRejectedValueOnce(new Error(rawError))
        .mockResolvedValueOnce(undefined);
      await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(title, copy));
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledTimes(2));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenLastCalledWith(
        expect.any(Object),
        CHAT_GUID,
        {
          backgroundUri: 'file:///documents/copied-background.jpg',
          backgroundIsLight: false,
        },
      );
      await waitFor(() =>
        expectDbRunSequence(mockDatabase, [
          'BEGIN IMMEDIATE',
          'ROLLBACK',
          'BEGIN IMMEDIATE',
          'COMMIT',
        ]),
      );
    },
  );

  it.each(['Set Background…', 'Generate theme from background'] as const)(
    'suppresses delayed A %s write rejection after B and then admits exact B',
    async (control) => {
      const pendingWrite = deferred<void>();
      const rawError = `raw-stale-${control}-write-error-b803`;
      mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-stale-write.jpg'));
      mockSetChatAppearanceWithinTransaction
        .mockReturnValueOnce(pendingWrite.promise)
        .mockResolvedValueOnce(undefined);
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() =>
        expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID,
          {
            backgroundUri: 'file:///documents/copied-background.jpg',
            backgroundIsLight: false,
          },
        ),
      );

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      await fireEvent.press(screen.getByText(control));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingWrite.reject(new Error(rawError));
        await pendingWrite.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() =>
        expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID_B,
          {
            backgroundUri: 'file:///documents/copied-background.jpg',
            backgroundIsLight: false,
          },
        ),
      );
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
    },
  );

  it('commits generated tokens, copied background, and luminance in one owner', async () => {
    const generatedTokens = { mode: 'dark', color: { tint: '#123456' } };
    mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-generated.jpg'));
    mockAdaptiveTokensFromImage.mockResolvedValue(generatedTokens);
    mockComputeBackgroundIsLight.mockResolvedValue(true);
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Generate theme from background'));

    await waitFor(() =>
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        {
          themeTokens: JSON.stringify(generatedTokens),
          backgroundUri: 'file:///documents/copied-background.jpg',
          backgroundIsLight: true,
        },
      ),
    );
    expect(mockAdaptiveTokensFromImage).toHaveBeenCalledWith(
      'file:///picked-generated.jpg',
      'dark',
    );
    expect(mockComputeBackgroundIsLight).toHaveBeenCalledWith(
      'file:///documents/copied-background.jpg',
    );
    expect(mockAdaptiveTokensFromImage.mock.invocationCallOrder[0]).toBeLessThan(
      mockComputeBackgroundIsLight.mock.invocationCallOrder[0]!,
    );
    expect(mockComputeBackgroundIsLight.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetChatAppearanceWithinTransaction.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
    expect(mockShowDialog).not.toHaveBeenCalledWith(
      'Background set',
      expect.stringContaining('Adaptive theming'),
    );
  });

  it('clears tokens, background, and luminance in one guarded owner', async () => {
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Clear chat theme / background'));

    await waitFor(() =>
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { themeTokens: null, backgroundUri: null, backgroundIsLight: null },
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
    expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledTimes(1);
    expect(mockDatabaseB.run).not.toHaveBeenCalled();
  });

  it('finishes admitted luminance work outside SQLite and starts no owner after retirement', async () => {
    const oldLease = mockAccountLease;
    const luminance = deferred<boolean | null>();
    mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-delayed-luminance.jpg'));
    mockComputeBackgroundIsLight.mockReturnValue(luminance.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Set Background…'));
    await waitFor(() =>
      expect(mockComputeBackgroundIsLight).toHaveBeenCalledWith(
        'file:///documents/copied-background.jpg',
      ),
    );
    expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
    expect(mockDatabase.run).not.toHaveBeenCalled();

    mockGetDatabase.mockClear().mockReturnValue(mockDatabaseB);
    let pauseSettled = false;
    const pausePromise = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    try {
      await retireLease(oldLease);
      expect(pauseSettled).toBe(false);

      await act(async () => {
        luminance.resolve(false);
        await luminance.promise;
      });
      await pausePromise;
      expect(pauseSettled).toBe(true);
      expect(mockGetDatabase).not.toHaveBeenCalled();
      expect(mockSetChatAppearanceWithinTransaction).not.toHaveBeenCalled();
      expect(mockDatabase.run).not.toHaveBeenCalled();
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(view.toJSON())).not.toContain('database commit guard rejected');
    } finally {
      await act(async () => {
        luminance.resolve(false);
        await luminance.promise;
        await pausePromise;
      });
      resumeRealtimeDeliveries();
    }
  });

  it('drains an admitted Clear owner and rolls all appearance fields back after retirement', async () => {
    const oldLease = mockAccountLease;
    const pendingAppearance = deferred<void>();
    mockSetChatAppearanceWithinTransaction.mockReturnValueOnce(pendingAppearance.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Clear chat theme / background'));
    await waitFor(() =>
      expect(mockSetChatAppearanceWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { themeTokens: null, backgroundUri: null, backgroundIsLight: null },
      ),
    );
    expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']);

    mockGetDatabase.mockClear().mockReturnValue(mockDatabaseB);
    let pauseSettled = false;
    const pausePromise = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    try {
      await retireLease(oldLease);
      expect(pauseSettled).toBe(false);

      await act(async () => {
        pendingAppearance.resolve();
        await pendingAppearance.promise;
      });
      await pausePromise;
      expect(pauseSettled).toBe(true);
      expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      expect(mockGetDatabase).not.toHaveBeenCalled();
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(view.toJSON())).not.toContain('database commit guard rejected');
    } finally {
      await act(async () => {
        pendingAppearance.resolve();
        await pendingAppearance.promise;
        await pausePromise;
      });
      resumeRealtimeDeliveries();
    }
  });

  it.each(['success', 'rejection'] as const)(
    'suppresses an admitted A notification %s after B, then reports and retries a current B error',
    async (outcome) => {
      const pending = deferred<void>();
      const staleRawError = 'raw-stale-notification-error-45b0';
      const currentRawError = 'raw-current-notification-error-64d2';
      mockOpenNotificationSettings
        .mockReturnValueOnce(pending.promise)
        .mockRejectedValueOnce(new Error(currentRawError))
        .mockResolvedValueOnce(undefined);
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(
        screen.getByRole('button', {
          name: 'Open system notification settings for this conversation',
        }),
      );
      const oldContext = mockOpenNotificationSettings.mock.calls[0]?.[2] as {
        generation: number;
        isCurrent(): boolean;
      };
      expect(oldContext.isCurrent()).toBe(true);

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      expect(oldContext.isCurrent()).toBe(false);
      await act(async () => {
        if (outcome === 'success') pending.resolve();
        else pending.reject(new Error(staleRawError));
        await pending.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(staleRawError);

      const notification = screen.getByRole('button', {
        name: 'Open system notification settings for this conversation',
      });
      await fireEvent.press(notification);
      await waitFor(() =>
        expect(mockShowDialog).toHaveBeenCalledWith(
          'Notification Settings',
          'Android notification settings could not be opened for this conversation.',
        ),
      );
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(currentRawError);

      await fireEvent.press(notification);
      await waitFor(() => expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(3));
      const freshCall = mockOpenNotificationSettings.mock.calls[2];
      expect(freshCall?.[0]).toBe(CHAT_GUID_B);
      expect(freshCall?.[1]).toBe(PRIVATE_CUSTOM_TITLE_B);
      const freshContext = freshCall?.[2] as { generation: number; isCurrent(): boolean };
      expect(freshContext.generation).toBe(73);
      expect(freshContext.isCurrent()).toBe(true);
    },
  );

  it('contains a current best-effort Name write rejection and permits an exact retry', async () => {
    const rawError = 'raw-current-name-write-error-77d1';
    mockSetChatCustomizationWithinTransaction
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce(undefined);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE), 'first-name-write');
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customName: 'first-name-write' },
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']));
    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
    expect(screen.getByDisplayValue('first-name-write')).toBeTruthy();

    await fireEvent.changeText(screen.getByDisplayValue('first-name-write'), 'retry-name-write');
    await waitFor(() => expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledTimes(2));
    expect(mockSetChatCustomizationWithinTransaction).toHaveBeenLastCalledWith(
      expect.any(Object),
      CHAT_GUID,
      { customName: 'retry-name-write' },
    );
    await waitFor(() =>
      expectDbRunSequence(mockDatabase, [
        'BEGIN IMMEDIATE',
        'ROLLBACK',
        'BEGIN IMMEDIATE',
        'COMMIT',
      ]),
    );
    expect(screen.getByDisplayValue('retry-name-write')).toBeTruthy();
  });

  it('keeps rapid optimistic Name edits ordered behind the global writer queue', async () => {
    const firstWrite = deferred<void>();
    mockSetChatCustomizationWithinTransaction
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    await renderWithTheme(<ChatSettingsScreen />);

    try {
      await fireEvent.changeText(
        screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE),
        'first-queued-name',
      );
      await waitFor(() =>
        expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID,
          { customName: 'first-queued-name' },
        ),
      );
      expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']);

      await fireEvent.changeText(
        screen.getByDisplayValue('first-queued-name'),
        'second-queued-name',
      );
      expect(screen.getByDisplayValue('second-queued-name')).toBeTruthy();
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledTimes(1);

      await act(async () => {
        firstWrite.resolve();
        await firstWrite.promise;
      });
      await waitFor(() =>
        expect(mockSetChatCustomizationWithinTransaction).toHaveBeenLastCalledWith(
          expect.any(Object),
          CHAT_GUID,
          { customName: 'second-queued-name' },
        ),
      );
      await waitFor(() =>
        expectDbRunSequence(mockDatabase, [
          'BEGIN IMMEDIATE',
          'COMMIT',
          'BEGIN IMMEDIATE',
          'COMMIT',
        ]),
      );
    } finally {
      await act(async () => {
        firstWrite.resolve();
        await firstWrite.promise;
      });
    }
  });

  it('names bubble-color radios, exposes selection, and preserves exact color writes', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);

    const expectedNames = [
      'Default bubble color',
      'Blue bubble color',
      'Green bubble color',
      'Purple bubble color',
      'Pink bubble color',
      'Orange bubble color',
      'Slate blue bubble color',
    ];
    // Seven chat-bubble choices plus eight choices for the one participant handle.
    expect(screen.getAllByRole('radio')).toHaveLength(expectedNames.length + 8);
    for (const accessibleName of expectedNames) {
      expect(screen.getByRole('radio', { name: accessibleName })).toBeTruthy();
    }
    expect(defaultColorSwatch().props.accessibilityState).toMatchObject({ selected: true });
    expect(defaultColorSwatch().props.hitSlop).toBe(6);

    mockCustomColor = '#AF52DE';
    await view.rerender(<ChatSettingsScreen />);
    expect(defaultColorSwatch().props.accessibilityState).toMatchObject({ selected: false });
    expect(
      screen.getByRole('radio', { name: 'Purple bubble color' }).props.accessibilityState,
    ).toMatchObject({ selected: true });

    await fireEvent.press(screen.getByRole('radio', { name: 'Blue bubble color' }));
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customColor: '#1982FC' },
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));

    mockSetChatCustomizationWithinTransaction.mockClear();
    mockDatabase.run.mockClear();
    await fireEvent.press(defaultColorSwatch());
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customColor: null },
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
    expect(mockDatabaseB.run).not.toHaveBeenCalled();
  });

  it('chooses and resets an exact device-owned participant color', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);

    const pale = screen.getByRole('radio', { name: `Pale yellow color for ${PRIVATE_MEMBER}` });
    const navy = screen.getByRole('radio', { name: `Navy color for ${PRIVATE_MEMBER}` });
    const reset = screen.getByRole('radio', { name: `Default color for ${PRIVATE_MEMBER}` });
    expect(pale).toBeTruthy();
    expect(navy).toBeTruthy();
    expect(reset.props.accessibilityState).toMatchObject({ selected: true });

    await fireEvent.press(pale);
    await waitFor(() =>
      expect(mockSetHandleColorWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        PRIVATE_ADDRESS,
        'iMessage',
        '#FFF3A3',
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));

    mockHandleColor = '#FFF3A3';
    await view.rerender(<ChatSettingsScreen />);
    expect(
      screen.getByRole('radio', { name: `Pale yellow color for ${PRIVATE_MEMBER}` }).props
        .accessibilityState,
    ).toMatchObject({ selected: true });

    mockSetHandleColorWithinTransaction.mockClear();
    mockDatabase.run.mockClear();
    await fireEvent.press(
      screen.getByRole('radio', { name: `Default color for ${PRIVATE_MEMBER}` }),
    );
    await waitFor(() =>
      expect(mockSetHandleColorWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        PRIVATE_ADDRESS,
        'iMessage',
        null,
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
    expect(mockDatabaseB.run).not.toHaveBeenCalled();
  });

  it.each([
    ['Mute', null, 'mute'],
    ['Unmute', 'mute', null],
  ] as const)(
    'guards an exact active %s write in one committed A transaction',
    async (_label, initialMuteType, expectedMuteType) => {
      mockMuteType = initialMuteType;
      await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByRole('switch', { name: 'Mute' }));

      await waitFor(() =>
        expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledWith(
          expect.any(Object),
          CHAT_GUID,
          expectedMuteType,
        ),
      );
      await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'COMMIT']));
      expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledTimes(1);
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
    },
  );

  it('keeps retained stale A Name, Color, Mute, and Reset controls inert, then binds fresh B', async () => {
    const oldLease = mockAccountLease;
    const view = await renderWithTheme(<ChatSettingsScreen />);
    const oldName = screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE).props.onChangeText as (
      text: string,
    ) => void;
    const oldColor = retainConfiguredPress(defaultColorSwatch());
    const oldMute = retainConfiguredPress(screen.getByRole('switch', { name: 'Mute' }));
    const oldReset = retainConfiguredPress(screen.getByText('Reset to default').parent!);

    await retireLease(oldLease);
    await view.unmount();
    mockGuid = CHAT_GUID_B;
    mockAccountLease = makeLease(74);
    mockGetDatabase.mockReturnValue(mockDatabaseB);
    mockGetDatabase.mockClear();
    mockSetChatCustomizationWithinTransaction.mockClear();
    mockSetChatMuteWithinTransaction.mockClear();
    mockDatabase.run.mockClear();
    mockDatabaseB.run.mockClear();

    await act(async () => {
      oldName('retained-a-name');
      oldColor();
      oldMute();
      oldReset();
      await Promise.resolve();
    });
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockSetChatCustomizationWithinTransaction).not.toHaveBeenCalled();
    expect(mockSetChatMuteWithinTransaction).not.toHaveBeenCalled();
    expect(mockDatabase.run).not.toHaveBeenCalled();
    expect(mockDatabaseB.run).not.toHaveBeenCalled();

    await renderWithTheme(<ChatSettingsScreen />);
    await fireEvent.changeText(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE_B), 'fresh-b-name');
    await fireEvent.press(defaultColorSwatch());
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        CHAT_GUID_B,
        { customName: 'fresh-b-name' },
      ),
    );
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        CHAT_GUID_B,
        { customColor: null },
      ),
    );
    await waitFor(() =>
      expectDbRunSequence(mockDatabaseB, [
        'BEGIN IMMEDIATE',
        'COMMIT',
        'BEGIN IMMEDIATE',
        'COMMIT',
      ]),
    );

    mockSetChatCustomizationWithinTransaction.mockClear();
    mockDatabaseB.run.mockClear();
    await fireEvent.press(screen.getByRole('switch', { name: 'Mute' }));
    await waitFor(() =>
      expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID_B,
        'mute',
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabaseB, ['BEGIN IMMEDIATE', 'COMMIT']));

    mockSetChatCustomizationWithinTransaction.mockClear();
    mockSetChatMuteWithinTransaction.mockClear();
    mockDatabaseB.run.mockClear();
    await fireEvent.press(screen.getByText('Reset to default'));
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID_B,
        { customName: null, customColor: null },
      ),
    );
    await waitFor(() =>
      expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID_B,
        null,
      ),
    );
    await waitFor(() => expectDbRunSequence(mockDatabaseB, ['BEGIN IMMEDIATE', 'COMMIT']));
    expect(mockSetChatCustomizationWithinTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetChatMuteWithinTransaction.mock.invocationCallOrder[0]!,
    );
    expect(mockDatabase.run).not.toHaveBeenCalled();
  });

  it('drains an admitted A Mute and rolls it back after account retirement', async () => {
    const oldLease = mockAccountLease;
    const pendingMute = deferred<void>();
    mockSetChatMuteWithinTransaction.mockReturnValueOnce(pendingMute.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByRole('switch', { name: 'Mute' }));
    await waitFor(() =>
      expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        'mute',
      ),
    );
    expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']);

    let pauseSettled = false;
    const pausePromise = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    try {
      await retireLease(oldLease);
      mockGetDatabase.mockReturnValue(mockDatabaseB);
      await act(async () => {
        await Promise.resolve();
      });
      expect(pauseSettled).toBe(false);

      await act(async () => {
        pendingMute.resolve();
        await pendingMute.promise;
      });
      await pausePromise;
      expect(pauseSettled).toBe(true);
      expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
      expect(JSON.stringify(view.toJSON())).not.toContain('database commit guard rejected');
    } finally {
      await act(async () => {
        pendingMute.resolve();
        await pendingMute.promise;
        await pausePromise;
      });
      resumeRealtimeDeliveries();
    }
  });

  it('rolls back Reset customization on retirement and never starts mute', async () => {
    const oldLease = mockAccountLease;
    const pendingCustomization = deferred<void>();
    mockSetChatCustomizationWithinTransaction.mockReturnValueOnce(pendingCustomization.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Reset to default'));
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customName: null, customColor: null },
      ),
    );
    expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']);
    expect(mockSetChatMuteWithinTransaction).not.toHaveBeenCalled();

    let pauseSettled = false;
    const pausePromise = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    try {
      await retireLease(oldLease);
      mockGetDatabase.mockReturnValue(mockDatabaseB);
      await act(async () => {
        await Promise.resolve();
      });
      expect(pauseSettled).toBe(false);

      await act(async () => {
        pendingCustomization.resolve();
        await pendingCustomization.promise;
      });
      await pausePromise;
      expect(pauseSettled).toBe(true);
      expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      expect(mockSetChatMuteWithinTransaction).not.toHaveBeenCalled();
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
      expect(JSON.stringify(view.toJSON())).not.toContain('database commit guard rejected');
    } finally {
      await act(async () => {
        pendingCustomization.resolve();
        await pendingCustomization.promise;
        await pausePromise;
      });
      resumeRealtimeDeliveries();
    }
  });

  it('rolls back Reset customization and mute together after retirement', async () => {
    const oldLease = mockAccountLease;
    const pendingCustomization = deferred<void>();
    const pendingMute = deferred<void>();
    mockSetChatCustomizationWithinTransaction.mockReturnValueOnce(pendingCustomization.promise);
    mockSetChatMuteWithinTransaction.mockReturnValueOnce(pendingMute.promise);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Reset to default'));
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customName: null, customColor: null },
      ),
    );
    expect(mockSetChatMuteWithinTransaction).not.toHaveBeenCalled();
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']));

    await act(async () => {
      pendingCustomization.resolve();
      await pendingCustomization.promise;
    });
    await waitFor(() =>
      expect(mockSetChatMuteWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        null,
      ),
    );
    expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE']);
    expect(mockSetChatCustomizationWithinTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetChatMuteWithinTransaction.mock.invocationCallOrder[0]!,
    );

    let pauseSettled = false;
    const pausePromise = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    try {
      await retireLease(oldLease);
      mockGetDatabase.mockReturnValue(mockDatabaseB);
      await act(async () => {
        await Promise.resolve();
      });
      expect(pauseSettled).toBe(false);

      await act(async () => {
        pendingMute.resolve();
        await pendingMute.promise;
      });
      await pausePromise;
      expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      expect(mockDatabaseB.run).not.toHaveBeenCalled();
      expect(JSON.stringify(view.toJSON())).not.toContain('database commit guard rejected');
    } finally {
      await act(async () => {
        pendingMute.resolve();
        await pendingMute.promise;
        await pausePromise;
      });
      resumeRealtimeDeliveries();
    }
  });

  it('contains a Reset customization rejection and never begins its mute transaction', async () => {
    const rawError = 'raw-current-reset-customization-error-85c4';
    mockSetChatCustomizationWithinTransaction.mockRejectedValueOnce(new Error(rawError));
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByText('Reset to default'));
    await waitFor(() => expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledTimes(1));
    await waitFor(() => expectDbRunSequence(mockDatabase, ['BEGIN IMMEDIATE', 'ROLLBACK']));
    expect(mockSetChatMuteWithinTransaction).not.toHaveBeenCalled();
    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
  });

  it('keeps exact current notification and local customization actions without group mutations', async () => {
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(
      screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE),
      'current-custom-title',
    );
    await waitFor(() =>
      expect(mockSetChatCustomizationWithinTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        CHAT_GUID,
        { customName: 'current-custom-title' },
      ),
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Open system notification settings for this conversation',
      }),
    );
    const notificationCall = mockOpenNotificationSettings.mock.calls.at(-1);
    expect(notificationCall?.[0]).toBe(CHAT_GUID);
    expect(notificationCall?.[1]).toBe(PRIVATE_CUSTOM_TITLE);
    const notificationContext = notificationCall?.[2] as {
      generation: number;
      isCurrent(): boolean;
    };
    expect(notificationContext.generation).toBe(73);
    expect(notificationContext.isCurrent()).toBe(true);
    expect(screen.getByText(PRIVATE_MEMBER)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Remove ${PRIVATE_MEMBER}` })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Person…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Group…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
  });
});

describe('ChatSettingsScreen targeted repair entry', () => {
  it('confirm-gates the exact conversation, locks the row while pending, and reports success', async () => {
    const repair = deferred<{
      messages: number;
      historyExhausted: boolean;
      restored: boolean;
    }>();
    mockStartChatRepair.mockReturnValueOnce(repair.promise);
    await renderWithTheme(<ChatSettingsScreen />);

    const repairRow = screen.getByRole('button', {
      name: 'Repair this conversation from the server',
    });
    await fireEvent.press(repairRow);

    expect(mockStartChatRepair).not.toHaveBeenCalled();
    expect(mockShowDialog.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'Repair Conversation',
      'Re-download this conversation’s server details and 500 most recent messages? Your local name, theme, wallpaper, mute setting, and deleted-message protections stay in place.',
    ]);
    const startRepair = dialogAction('Start Repair');
    expect(startRepair).toBeDefined();

    await act(async () => {
      startRepair?.();
      await Promise.resolve();
    });
    expect(mockStartChatRepair).toHaveBeenCalledTimes(1);
    expect(mockStartChatRepair).toHaveBeenCalledWith(CHAT_GUID);
    const busyRepairRow = screen.getByRole('button', {
      name: 'Repairing this conversation from the server',
    });
    expect(screen.getByText('Repairing Conversation…')).toBeTruthy();
    expect(busyRepairRow.props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(busyRepairRow);
    expect(mockStartChatRepair).toHaveBeenCalledTimes(1);

    await act(async () => {
      repair.resolve({ messages: 234, historyExhausted: false, restored: false });
      await repair.promise;
    });
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Conversation Repaired',
        '234 recent messages were refreshed.',
      ),
    );
    expect(screen.getByText('Repair Conversation')).toBeTruthy();
  });

  it('contains current failures and suppresses a retired repair result and confirmation', async () => {
    const rawCurrentError = 'raw-current-repair-error-2f71';
    mockStartChatRepair.mockRejectedValueOnce(new Error(rawCurrentError));
    const oldLease = mockAccountLease;
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Repair this conversation from the server' }),
    );
    await act(async () => {
      dialogAction('Start Repair')?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Repair Failed',
        'Gator couldn’t refresh this conversation. Check the server connection and try again.',
      ),
    );
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawCurrentError);

    const staleRepair = deferred<{
      messages: number;
      historyExhausted: boolean;
      restored: boolean;
    }>();
    mockStartChatRepair.mockReturnValueOnce(staleRepair.promise);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Repair this conversation from the server' }),
    );
    const retainedStart = dialogAction('Start Repair');
    expect(retainedStart).toBeDefined();
    await act(async () => {
      retainedStart?.();
      await Promise.resolve();
    });
    expect(mockStartChatRepair).toHaveBeenCalledTimes(2);
    const dialogCountBeforeRetirement = mockShowDialog.mock.calls.length;

    await retireLease(oldLease);
    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();

    const rawStaleError = 'raw-retired-repair-error-b8d4';
    await act(async () => {
      retainedStart?.();
      staleRepair.reject(new Error(rawStaleError));
      await staleRepair.promise.catch(() => undefined);
      await Promise.resolve();
    });
    expect(mockStartChatRepair).toHaveBeenCalledTimes(2);
    expect(mockShowDialog).toHaveBeenCalledTimes(dialogCountBeforeRetirement);
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawStaleError);
    expect(JSON.stringify(view.toJSON())).not.toContain(rawStaleError);
  });
});
