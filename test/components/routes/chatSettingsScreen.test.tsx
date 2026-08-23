/** Conversation Details: exact content plus GUID/account/picker ownership. */
import React from 'react';
import { AccessibilityInfo, Keyboard, Platform } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockShowDialog = jest.fn();
const mockLaunchImageLibrary = jest.fn();
const mockRequestPhotoLibraryAccess = jest.fn();
const mockSetGroupPhoto = jest.fn();
const mockClearGroupPhoto = jest.fn();
const mockLeaveGroupChat = jest.fn();
const mockRenameGroupChat = jest.fn();
const mockUpdateGroupParticipant = jest.fn();
const mockOpenNotificationSettings = jest.fn();
const mockSetChatTheme = jest.fn();
const mockSetBackgroundIsLight = jest.fn();
const mockSetChatCustomization = jest.fn();
const mockSetChatMute = jest.fn();
const mockSafeOpenUrl = jest.fn();
const mockSubscribeGenerationInvalidation = jest.fn();
const mockUseChatHeader = jest.fn();
const mockReactiveHookCall = jest.fn();
const mockDatabase = { kind: 'chat-settings-test-db' };
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
const PRIVATE_ADD_DRAFT = 'details-private-add-draft-a1a3';
const PRIVATE_RENAME_DRAFT = 'details-private-rename-draft-f2e4';
const PRIVATE_THEME_TOKEN = 'details-private-theme-token-889d';
const CHAT_GUID = 'iMessage;-;chat-settings-private-guid';
const MEDIA_GUID = 'details-private-message-guid';
const PRIVATE_LINK = 'https://details-a.example.invalid/path-a';
const ACCOUNT_CHANGED_COPY = 'Conversation account changed. Go back and reopen Details.';
const CHAT_GUID_B = 'iMessage;-;chat-settings-private-guid-b';
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

function privateCanaries(): string[] {
  return [
    PRIVATE_CUSTOM_TITLE,
    PRIVATE_SERVER_TITLE,
    PRIVATE_MEMBER,
    PRIVATE_ADDRESS,
    PRIVATE_MEDIA_URI,
    PRIVATE_BLURHASH,
    PRIVATE_ADD_DRAFT,
    PRIVATE_RENAME_DRAFT,
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

jest.mock('@db/repositories', () => ({
  getChatParticipants: jest.fn(),
  getChatTheme: jest.fn(),
  listChatAttachmentsByKind: jest.fn(),
  setBackgroundIsLight: (...args: unknown[]) => mockSetBackgroundIsLight(...args),
  setChatCustomization: (...args: unknown[]) => mockSetChatCustomization(...args),
  setChatMute: (...args: unknown[]) => mockSetChatMute(...args),
  setChatTheme: (...args: unknown[]) => mockSetChatTheme(...args),
}));

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
      return { data: [{ address: source.address, name: source.member }] };
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
        displayName: source.serverTitle,
        customName: source.customTitle,
        customColor: null,
        muteType: null,
        style: 43,
        participantCount: 2,
        participantNames: `${source.member}, Second Member`,
        participantAvatars: null,
        participantAddresses: `${source.address}|||second@example.invalid`,
        handleServices: null,
      },
    };
  },
}));

jest.mock('@utils', () => ({
  isGroupRow: (row: { style?: number }) => row.style === 43,
  resolveTitle: (row: { customName?: string | null; displayName?: string | null }) =>
    row.customName || row.displayName || 'Conversation',
  isLocalFileUri: (uri: string | null | undefined) => !!uri?.startsWith('file://'),
  safeOpenUrl: (...args: unknown[]) => mockSafeOpenUrl(...args),
}));

jest.mock('@/services', () => ({ computeBackgroundIsLight: jest.fn().mockResolvedValue(false) }));

jest.mock('@/services/notifications/notifeeService', () => ({
  openChatNotificationSettings: (...args: unknown[]) => mockOpenNotificationSettings(...args),
}));

jest.mock('@/services/chat/groupManagement', () => ({
  clearGroupPhoto: (...args: unknown[]) => mockClearGroupPhoto(...args),
  leaveGroupChat: (...args: unknown[]) => mockLeaveGroupChat(...args),
  renameGroupChat: (...args: unknown[]) => mockRenameGroupChat(...args),
  setGroupPhoto: (...args: unknown[]) => mockSetGroupPhoto(...args),
  updateGroupParticipant: (...args: unknown[]) => mockUpdateGroupParticipant(...args),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockAccountLease,
  subscribeRealtimeGenerationInvalidation: (generation: number, callback: () => void) => {
    mockSubscribeGenerationInvalidation(generation, callback);
    const listeners = mockInvalidationListeners.get(generation) ?? new Set<() => void>();
    listeners.add(callback);
    mockInvalidationListeners.set(generation, listeners);
    return () => listeners.delete(callback);
  },
  runTrackedRealtimeWork: async (lease: MockLease, task: (value: MockLease) => Promise<void>) => {
    if (!lease.isCurrent()) return 'revoked';
    await task(lease);
    return lease.isCurrent() ? 'delivered' : 'revoked';
  },
}));

jest.mock('@ui/permissions/photoLibraryPermission', () => ({
  requestPhotoLibraryAccess: (...args: unknown[]) => mockRequestPhotoLibraryAccess(...args),
}));

jest.mock('@ui/theme/adaptiveFromImage', () => ({
  adaptiveTokensFromImage: jest.fn().mockResolvedValue(null),
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
    }: {
      onCancel: () => void;
      onApply: (tokens: Record<string, unknown>) => void;
    }) =>
      ReactLib.createElement(
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
      ),
    useTheme: () => gatorTheme,
  };
});

// eslint-disable-next-line import/first
import ChatSettingsScreen from '../../../app/(app)/chat-settings/[guid]';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';

let keyboardDismissSpy: jest.SpiedFunction<typeof Keyboard.dismiss>;
const mockGetDatabase = getDatabase as jest.Mock;

beforeEach(() => {
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
  mockPendingReactiveGuid = null;
  mockAccountLease = makeLease(73);
  mockInvalidationListeners.clear();
  mockGetDatabase.mockReturnValue(mockDatabase);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  keyboardDismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  mockRequestPhotoLibraryAccess.mockResolvedValue(true);
  mockLaunchImageLibrary.mockResolvedValue({ canceled: true, assets: [] });
  mockSetGroupPhoto.mockResolvedValue(true);
  mockClearGroupPhoto.mockResolvedValue(true);
  mockLeaveGroupChat.mockResolvedValue(true);
  mockRenameGroupChat.mockResolvedValue(true);
  mockUpdateGroupParticipant.mockResolvedValue(true);
  mockOpenNotificationSettings.mockResolvedValue(undefined);
  mockSetChatTheme.mockResolvedValue(undefined);
  mockSetBackgroundIsLight.mockResolvedValue(undefined);
  mockSetChatCustomization.mockResolvedValue(undefined);
  mockSetChatMute.mockResolvedValue(undefined);
});

afterEach(() => {
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
    Array<{ text: string; onPress?: () => void }> | undefined;
  return actions?.find((action) => action.text === label)?.onPress;
}

function pickedAsset(uri: string): {
  canceled: false;
  assets: Array<{ uri: string; fileName: string; mimeType: string }>;
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
    expect(mockSetChatTheme).not.toHaveBeenCalled();
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
    expect(mockSetChatTheme).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');

    await emitReduceMotion(false);
    await view.rerender(<ChatSettingsScreen />);
    expect(studioModal().props.animationType).toBe('none');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply test theme' }));
    await waitFor(() => expect(screen.queryByTestId('chat-theme-studio-modal')).toBeNull());
    await waitFor(() =>
      expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, {
        themeTokens: JSON.stringify({ mode: 'dark', canary: PRIVATE_THEME_TOKEN }),
      }),
    );

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

describe('ChatSettingsScreen source and account ownership', () => {
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

    await fireEvent.press(screen.getByRole('image'));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(source.mediaGuid)}`);
    await fireEvent.press(screen.getByText(source.link));
    expect(mockSafeOpenUrl).toHaveBeenCalledWith(source.link);
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('key-remounts pending B without retained A data and revokes A callbacks across A to B to A', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);
    const oldMedia = retainConfiguredPress(screen.getByRole('image'));
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
    await fireEvent.press(screen.getByRole('button', { name: 'Add Person…' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Group…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), PRIVATE_ADD_DRAFT);
    await fireEvent.changeText(screen.getByPlaceholderText('New group name'), PRIVATE_RENAME_DRAFT);

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
    expect(mockSetChatTheme).not.toHaveBeenCalled();

    mockPendingReactiveGuid = null;
    await view.rerender(<ChatSettingsScreen />);
    expect(screen.getByText(PRIVATE_MEMBER_B)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_MEDIA_URI_B);
    expect(oldNotificationContext.isCurrent()).toBe(false);

    await fireEvent.press(screen.getByText('Chat Theme…'));
    expect(studioModal().props.animationType).toBe('none');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply test theme' }));
    await waitFor(() =>
      expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID_B, {
        themeTokens: JSON.stringify({ mode: 'dark', canary: PRIVATE_THEME_TOKEN }),
      }),
    );

    mockPendingReactiveGuid = CHAT_GUID;
    mockGuid = CHAT_GUID;
    await view.rerender(<ChatSettingsScreen />);
    mockPendingReactiveGuid = null;
    await view.rerender(<ChatSettingsScreen />);
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_MEDIA_URI);

    oldMedia();
    oldLink();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('image'));
    await fireEvent.press(screen.getByText(PRIVATE_LINK));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(MEDIA_GUID)}`);
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
    expect(screen.queryByRole('image')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);

    await act(async () => stale.unmount());
    mockGuid = CHAT_GUID_B;
    mockAccountLease = makeLease(74);
    await renderWithTheme(<ChatSettingsScreen />);
    expect(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE_B)).toBeTruthy();
    await fireEvent.press(screen.getByRole('image'));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent(MEDIA_GUID_B)}`);
  });

  it('automatically retires a mounted account and leaves retained controls inert', async () => {
    const oldLease = mockAccountLease;
    const view = await renderWithTheme(<ChatSettingsScreen />);
    const oldMedia = retainConfiguredPress(screen.getByRole('image'));
    const oldLink = retainConfiguredPress(screen.getByText(PRIVATE_LINK).parent!);
    await fireEvent.press(screen.getByText('Chat Theme…'));
    const oldApplyTheme = retainConfiguredPress(
      screen.getByRole('button', { name: 'Apply test theme' }),
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
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();
    expect(mockSetChatTheme).not.toHaveBeenCalled();

    await act(async () => view.unmount());
    mockGuid = CHAT_GUID_B;
    mockAccountLease = makeLease(74);
    await renderWithTheme(<ChatSettingsScreen />);
    await fireEvent.press(screen.getByText(PRIVATE_LINK_B));
    expect(mockSafeOpenUrl).toHaveBeenCalledWith(PRIVATE_LINK_B);
  });

  it.each([
    ['Change Photo…', 'success'],
    ['Change Photo…', 'rejection'],
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
      expect(mockSetGroupPhoto).not.toHaveBeenCalled();
      expect(mockSetChatTheme).not.toHaveBeenCalled();
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByText(control));
      if (control === 'Change Photo…') {
        await waitFor(() =>
          expect(mockSetGroupPhoto).toHaveBeenCalledWith(
            CHAT_GUID_B,
            {
              uri: 'file:///picked-current-b.jpg',
              name: 'picked.jpg',
              mimeType: 'image/jpeg',
            },
            mockAccountLease,
          ),
        );
      } else {
        await waitFor(() =>
          expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID_B, {
            backgroundUri: 'file:///documents/copied-background.jpg',
          }),
        );
      }
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['Change Photo…', 'cancel'],
    ['Change Photo…', 'rejection'],
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
      expect(mockSetGroupPhoto).not.toHaveBeenCalled();
      expect(mockSetChatTheme).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByText(control));
      if (control === 'Change Photo…') {
        await waitFor(() =>
          expect(mockSetGroupPhoto).toHaveBeenCalledWith(
            CHAT_GUID,
            {
              uri: 'file:///picked-retry-a.jpg',
              name: 'picked.jpg',
              mimeType: 'image/jpeg',
            },
            mockAccountLease,
          ),
        );
      } else {
        await waitFor(() =>
          expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, {
            backgroundUri: 'file:///documents/copied-background.jpg',
          }),
        );
      }
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
      mockSetChatTheme.mockRejectedValueOnce(new Error(rawError)).mockResolvedValueOnce(undefined);
      await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(title, copy));
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() => expect(mockSetChatTheme).toHaveBeenCalledTimes(2));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
      expect(mockSetChatTheme).toHaveBeenLastCalledWith(mockDatabase, CHAT_GUID, {
        backgroundUri: 'file:///documents/copied-background.jpg',
      });
      expect(mockSetBackgroundIsLight).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, false);
    },
  );

  it.each(['Set Background…', 'Generate theme from background'] as const)(
    'suppresses delayed A %s write rejection after B and then admits exact B',
    async (control) => {
      const pendingWrite = deferred<void>();
      const rawError = `raw-stale-${control}-write-error-b803`;
      mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-stale-write.jpg'));
      mockSetChatTheme.mockReturnValueOnce(pendingWrite.promise).mockResolvedValueOnce(undefined);
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByText(control));
      await waitFor(() =>
        expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, {
          backgroundUri: 'file:///documents/copied-background.jpg',
        }),
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
        expect(mockSetChatTheme).toHaveBeenCalledWith(mockDatabase, CHAT_GUID_B, {
          backgroundUri: 'file:///documents/copied-background.jpg',
        }),
      );
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
    },
  );

  it('revokes an old A removal confirmation and binds a fresh exact B confirmation', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: `Remove ${PRIVATE_MEMBER}` }));
    expect(mockShowDialog.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'Remove',
      'Remove this person from the group?',
    ]);
    const oldRemove = dialogAction('Remove');
    expect(oldRemove).toBeDefined();

    mockGuid = CHAT_GUID_B;
    await view.rerender(<ChatSettingsScreen />);
    await act(async () => {
      oldRemove?.();
      await Promise.resolve();
    });
    expect(mockUpdateGroupParticipant).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: `Remove ${PRIVATE_MEMBER_B}` }));
    await act(async () => {
      dialogAction('Remove')?.();
      await Promise.resolve();
    });
    expect(mockUpdateGroupParticipant).toHaveBeenCalledTimes(1);
    expect(mockUpdateGroupParticipant).toHaveBeenCalledWith(
      CHAT_GUID_B,
      'remove',
      PRIVATE_ADDRESS_B,
      mockAccountLease,
    );
  });

  it('revokes retained A Rename, Add, and Remove Photo callbacks across A to B to A', async () => {
    const view = await renderWithTheme(<ChatSettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Group…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('New group name'), 'old-a-rename');
    const oldRename = retainConfiguredPress(screen.getByText('Save').parent!);
    await fireEvent.press(screen.getByRole('button', { name: 'Add Person…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), 'old-a-add');
    const oldAdd = retainConfiguredPress(screen.getByText('Add').parent!);
    await fireEvent.press(screen.getByRole('button', { name: 'Remove Photo' }));
    const oldRemovePhoto = dialogAction('Remove');
    expect(oldRemovePhoto).toBeDefined();

    mockGuid = CHAT_GUID_B;
    await view.rerender(<ChatSettingsScreen />);
    mockGuid = CHAT_GUID;
    await view.rerender(<ChatSettingsScreen />);
    await act(async () => {
      oldRename();
      oldAdd();
      oldRemovePhoto?.();
      await Promise.resolve();
    });
    expect(mockRenameGroupChat).not.toHaveBeenCalled();
    expect(mockUpdateGroupParticipant).not.toHaveBeenCalled();
    expect(mockClearGroupPhoto).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Rename Group…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('New group name'), 'fresh-a-rename');
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(mockRenameGroupChat).toHaveBeenCalledWith(
        CHAT_GUID,
        'fresh-a-rename',
        mockAccountLease,
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Group…' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Add Person…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), 'fresh-a-add');
    await fireEvent.press(screen.getByText('Add'));
    await waitFor(() =>
      expect(mockUpdateGroupParticipant).toHaveBeenCalledWith(
        CHAT_GUID,
        'add',
        'fresh-a-add',
        mockAccountLease,
      ),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Remove Photo' }));
    await act(async () => {
      dialogAction('Remove')?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockClearGroupPhoto).toHaveBeenCalledWith(CHAT_GUID, mockAccountLease),
    );
  });

  it('suppresses a delayed A Rename rejection and reports then retries an exact current B error', async () => {
    const pending = deferred<boolean>();
    const staleRawError = 'raw-stale-rename-error-582f';
    const currentRawError = 'raw-current-rename-error-65b9';
    mockRenameGroupChat
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error(currentRawError))
      .mockResolvedValueOnce(true);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Rename Group…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('New group name'), 'stale-a-rename');
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(mockRenameGroupChat).toHaveBeenCalledWith(
        CHAT_GUID,
        'stale-a-rename',
        mockAccountLease,
      ),
    );

    mockGuid = CHAT_GUID_B;
    await view.rerender(<ChatSettingsScreen />);
    await act(async () => {
      pending.reject(new Error(staleRawError));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });
    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(staleRawError);

    await fireEvent.press(screen.getByRole('button', { name: 'Rename Group…' }));
    await fireEvent.changeText(screen.getByPlaceholderText('New group name'), 'fresh-b-rename');
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Group',
        'Couldn’t update — the server needs the Private API enabled.',
      ),
    );
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(currentRawError);

    await act(async () => {
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() => expect(mockRenameGroupChat).toHaveBeenCalledTimes(3));
    expect(mockRenameGroupChat).toHaveBeenLastCalledWith(
      CHAT_GUID_B,
      'fresh-b-rename',
      mockAccountLease,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Group…' })).toBeTruthy());
  });

  it.each(['success', 'rejection'] as const)(
    'suppresses delayed A setGroupPhoto %s and publishes only a fresh current B outcome',
    async (outcome) => {
      const pending = deferred<boolean>();
      const staleRawError = 'raw-stale-set-group-photo-error-28ad';
      const currentRawError = 'raw-current-set-group-photo-error-739c';
      mockLaunchImageLibrary.mockResolvedValue(pickedAsset('file:///picked-group-photo.jpg'));
      mockSetGroupPhoto.mockReturnValueOnce(pending.promise);
      if (outcome === 'success') {
        mockSetGroupPhoto.mockResolvedValueOnce(true);
      } else {
        mockSetGroupPhoto
          .mockRejectedValueOnce(new Error(currentRawError))
          .mockResolvedValueOnce(true);
      }
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByRole('button', { name: 'Change Photo…' }));
      await waitFor(() =>
        expect(mockSetGroupPhoto).toHaveBeenCalledWith(
          CHAT_GUID,
          {
            uri: 'file:///picked-group-photo.jpg',
            name: 'picked.jpg',
            mimeType: 'image/jpeg',
          },
          mockAccountLease,
        ),
      );

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      await fireEvent.press(screen.getByRole('button', { name: 'Change Photo…' }));
      expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === 'success') pending.resolve(true);
        else pending.reject(new Error(staleRawError));
        await pending.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockShowDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(staleRawError);

      await fireEvent.press(screen.getByRole('button', { name: 'Change Photo…' }));
      if (outcome === 'success') {
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith(
            'Group Photo',
            'Photo updated — it may take a moment to sync to everyone.',
          ),
        );
      } else {
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith(
            'Group Photo',
            'Couldn’t update the group photo.',
          ),
        );
        expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(currentRawError);
        await fireEvent.press(screen.getByRole('button', { name: 'Change Photo…' }));
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith(
            'Group Photo',
            'Photo updated — it may take a moment to sync to everyone.',
          ),
        );
      }
      expect(mockSetGroupPhoto).toHaveBeenLastCalledWith(
        CHAT_GUID_B,
        {
          uri: 'file:///picked-group-photo.jpg',
          name: 'picked.jpg',
          mimeType: 'image/jpeg',
        },
        mockAccountLease,
      );
    },
  );

  it.each(['success', 'rejection'] as const)(
    'suppresses delayed A clearGroupPhoto %s and publishes only a fresh current B outcome',
    async (outcome) => {
      const pending = deferred<boolean>();
      const staleRawError = 'raw-stale-clear-group-photo-error-392e';
      const currentRawError = 'raw-current-clear-group-photo-error-84c0';
      mockClearGroupPhoto.mockReturnValueOnce(pending.promise);
      if (outcome === 'success') {
        mockClearGroupPhoto.mockResolvedValueOnce(true);
      } else {
        mockClearGroupPhoto
          .mockRejectedValueOnce(new Error(currentRawError))
          .mockResolvedValueOnce(true);
      }
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByRole('button', { name: 'Remove Photo' }));
      await act(async () => {
        dialogAction('Remove')?.();
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(mockClearGroupPhoto).toHaveBeenCalledWith(CHAT_GUID, mockAccountLease),
      );

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      await act(async () => {
        if (outcome === 'success') pending.resolve(true);
        else pending.reject(new Error(staleRawError));
        await pending.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockShowDialog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(staleRawError);

      await fireEvent.press(screen.getByRole('button', { name: 'Remove Photo' }));
      await act(async () => {
        dialogAction('Remove')?.();
        await Promise.resolve();
      });
      if (outcome === 'success') {
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith('Group Photo', 'Photo removed.'),
        );
      } else {
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith(
            'Group Photo',
            'Couldn’t remove the group photo.',
          ),
        );
        expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(currentRawError);
        await fireEvent.press(screen.getByRole('button', { name: 'Remove Photo' }));
        await act(async () => {
          dialogAction('Remove')?.();
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(mockShowDialog).toHaveBeenCalledWith('Group Photo', 'Photo removed.'),
        );
      }
      expect(mockClearGroupPhoto).toHaveBeenLastCalledWith(CHAT_GUID_B, mockAccountLease);
    },
  );

  it.each(['success', 'rejection'] as const)(
    'suppresses an admitted A Leave %s after B and preserves a fresh exact B Leave',
    async (outcome) => {
      const pending = deferred<boolean>();
      const rawError = 'raw-stale-leave-error-c218';
      mockLeaveGroupChat.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true);
      const view = await renderWithTheme(<ChatSettingsScreen />);

      await fireEvent.press(screen.getByRole('button', { name: 'Leave group' }));
      const oldLeave = dialogAction('Leave');
      expect(oldLeave).toBeDefined();
      await act(async () => {
        oldLeave?.();
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(mockLeaveGroupChat).toHaveBeenCalledWith(CHAT_GUID, mockAccountLease),
      );

      mockGuid = CHAT_GUID_B;
      await view.rerender(<ChatSettingsScreen />);
      await act(async () => {
        if (outcome === 'success') pending.resolve(true);
        else pending.reject(new Error(rawError));
        await pending.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(mockBack).not.toHaveBeenCalled();
      expect(mockShowDialog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);

      await fireEvent.press(screen.getByRole('button', { name: 'Leave group' }));
      await act(async () => {
        dialogAction('Leave')?.();
        await Promise.resolve();
      });
      await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
      expect(mockLeaveGroupChat).toHaveBeenLastCalledWith(CHAT_GUID_B, mockAccountLease);
    },
  );

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
    mockSetChatCustomization
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce(undefined);
    const view = await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE), 'first-name-write');
    await waitFor(() =>
      expect(mockSetChatCustomization).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, {
        customName: 'first-name-write',
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);

    await fireEvent.changeText(screen.getByDisplayValue('first-name-write'), 'retry-name-write');
    await waitFor(() => expect(mockSetChatCustomization).toHaveBeenCalledTimes(2));
    expect(mockSetChatCustomization).toHaveBeenLastCalledWith(mockDatabase, CHAT_GUID, {
      customName: 'retry-name-write',
    });
    expect(screen.getByDisplayValue('retry-name-write')).toBeTruthy();
  });

  it('keeps exact current group, notification, customization, and Leave actions', async () => {
    await renderWithTheme(<ChatSettingsScreen />);

    await fireEvent.changeText(
      screen.getByDisplayValue(PRIVATE_CUSTOM_TITLE),
      'current-custom-title',
    );
    await waitFor(() =>
      expect(mockSetChatCustomization).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, {
        customName: 'current-custom-title',
      }),
    );
    await fireEvent.press(screen.getByRole('switch', { name: 'Mute' }));
    await waitFor(() =>
      expect(mockSetChatMute).toHaveBeenCalledWith(mockDatabase, CHAT_GUID, 'mute'),
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

    await fireEvent.press(screen.getByRole('button', { name: `Remove ${PRIVATE_MEMBER}` }));
    expect(mockShowDialog.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'Remove',
      'Remove this person from the group?',
    ]);
    await act(async () => {
      dialogAction('Remove')?.();
      await Promise.resolve();
    });
    expect(mockUpdateGroupParticipant).toHaveBeenCalledWith(
      CHAT_GUID,
      'remove',
      PRIVATE_ADDRESS,
      mockAccountLease,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Leave group' }));
    await act(async () => {
      dialogAction('Leave')?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockLeaveGroupChat).toHaveBeenCalledWith(CHAT_GUID, mockAccountLease),
    );
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
