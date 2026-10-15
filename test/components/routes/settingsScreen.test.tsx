/**
 * SettingsScreen route (app/(app)/settings.tsx): the top-level settings list.
 *
 * This suite locks in the SCREEN'S wiring to the real stores + services, not the
 * store internals (those have their own node tests):
 *   - toggles flip the REAL kv-backed stores optimistically AND invoke the persist
 *     path (`kvSetWithinTransaction`) — @db/database is mocked in the shared setup so the real
 *     persist is swallowed; here `@db/repositories` keeps every real export but swaps the scoped
 *     helper for a spy so we can OBSERVE the persist call;
 *   - App Lock enable is gated on `isBiometricAvailable()` (mocked): no biometric →
 *     a "Biometrics required" dialog and `setAppLockEnabled` is NOT called;
 *   - theme-preset rows drive `useThemeStore.setPreset`;
 *   - navigation rows route via the mocked expo-router;
 *   - Disconnect / Rotate-key open the real themed dialog queue and their buttons
 *     call `forget` / `rotateDatabaseKey`;
 *   - Sync Contacts calls the (mocked) service and shows a result dialog;
 *   - the search box filters sections and shows the no-results message.
 *
 * Mock note: a jest.mock factory must NOT dereference an outer `const mock…` at
 * factory-eval time — ES imports hoist above the const initializers, so the const is
 * still `undefined` when the factory runs. So each factory creates its `jest.fn()`s
 * inline and we grab the references AFTER import (RNTL exemplar's `x as jest.Mock`).
 * The dialog store is the REAL singleton — we inspect its state (AppDialog renders at root).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import { SHARED_PASSWORD_PUSH_CUTOFF_MS } from '@core/config/constants';
import { logger } from '@core/secure';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockAccountADb = { account: 'A', run: jest.fn(async () => undefined) };
const mockAccountBDb = { account: 'B', run: jest.fn(async () => undefined) };

// The full `@ui` barrel drags in the conversation/attachment tree (expo-video/expo-image/ky —
// native/ESM modules jest-expo can't load). The screen only needs `Screen` + `useTheme`, so
// swap the barrel for its two lightweight submodules (same trick as lockScreen.test.tsx).
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
// `mockPush`/`mockBack` are safe here: they're only dereferenced inside useRouter()'s return,
// which runs at render time (well after the consts initialize).
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: 'fallback-version', android: { versionCode: 999 } },
  },
}));
jest.mock('expo-application', () => ({
  nativeApplicationVersion: '0.1.40',
  nativeBuildVersion: '53',
}));
jest.mock('@native/biometrics', () => ({ isBiometricAvailable: jest.fn() }));
jest.mock('@native/screenSecurity', () => ({
  getSecureScreenState: jest.fn(() => ({ available: true, enabled: false })),
  setSecureScreenEnabled: jest.fn(),
}));
jest.mock('@/services', () => ({
  disconnectFailureMessage: jest.fn(
    () =>
      'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.',
  ),
  forget: jest.fn().mockResolvedValue(undefined),
  forgetOnThisPhoneOnly: jest.fn().mockResolvedValue(undefined),
  isUnconfirmedCredentialRetirement: jest.fn(() => false),
  previousUnrevokedServerOrigin: jest.fn().mockResolvedValue('https://gone.example'),
  rotateDatabaseKey: jest.fn(),
  setAppLockEnabled: jest.fn(),
}));
jest.mock('@/services/contacts/contactsService', () => ({
  syncContacts: jest.fn(),
  getContactsPermissionState: jest.fn(),
  isContactsAccountChangedError: (error: unknown) =>
    error instanceof Error && error.name === 'ContactsAccountChangedError',
  isContactsPermissionDeniedError: (error: unknown) =>
    error instanceof Error && error.name === 'ContactsPermissionDeniedError',
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  getNotificationPermissionState: jest.fn(),
  openNotificationPermissionSettings: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));
// Keep every real repository export; only replace kvSetWithinTransaction so we can watch the
// persist calls.
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  kvSetWithinTransaction: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import SettingsScreen from '../../../app/(app)/settings';
// eslint-disable-next-line import/first
import { isBiometricAvailable } from '@native/biometrics';
// eslint-disable-next-line import/first
import { getSecureScreenState, setSecureScreenEnabled } from '@native/screenSecurity';
// eslint-disable-next-line import/first
import {
  forget,
  isUnconfirmedCredentialRetirement,
  rotateDatabaseKey,
  setAppLockEnabled,
} from '@/services';
// eslint-disable-next-line import/first
import { getContactsPermissionState, syncContacts } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import {
  getNotificationPermissionState,
  openNotificationPermissionSettings,
  requestNotificationPermission,
} from '@/services/notifications/notifeeService';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { kvSetWithinTransaction } from '@db/repositories';
// eslint-disable-next-line import/first
import { ERROR_REPORTING_CONSENT_KEY, useFeatureSettingsStore } from '@state/featureSettingsStore';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useSyncSettingsStore } from '@state/syncSettingsStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useThemeStore } from '@state/themeStore';
// eslint-disable-next-line import/first
import { useTransportHealthStore } from '@state/transportHealthStore';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { PRESET_ORDER, PRESETS, DEFAULT_PRESET } from '@ui/theme/tokens';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockIsBiometricAvailable = isBiometricAvailable as jest.Mock;
const mockGetSecureScreenState = getSecureScreenState as jest.Mock;
const mockSetSecureScreenEnabled = setSecureScreenEnabled as jest.Mock;
const mockForget = forget as jest.Mock;
const mockIsUnconfirmedCredentialRetirement = isUnconfirmedCredentialRetirement as jest.Mock;
const mockRotate = rotateDatabaseKey as jest.Mock;
const mockSetAppLock = setAppLockEnabled as jest.Mock;
const mockSyncContacts = syncContacts as jest.Mock;
const mockGetContactsPermissionState = getContactsPermissionState as jest.Mock;
const mockGetNotificationPermissionState = getNotificationPermissionState as jest.Mock;
const mockOpenNotificationPermissionSettings = openNotificationPermissionSettings as jest.Mock;
const mockRequestNotificationPermission = requestNotificationPermission as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockKvSetWithinTransaction = kvSetWithinTransaction as jest.Mock;

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

const PRIVATE_SERVER_SESSION = {
  origin: 'https://settings-private-origin-7f9e.example/tenant',
  serverInfo: {
    server_version: 'settings-private-server-build-8c2d',
    os_version: 'settings-private-macos-build-4a61',
    private_api: true,
    supports_icloud_account: true,
  },
};

function expectPrivateServerSessionHidden(): void {
  expect(screen.queryByText(PRIVATE_SERVER_SESSION.origin)).toBeNull();
  expect(screen.queryByText(PRIVATE_SERVER_SESSION.serverInfo.server_version)).toBeNull();
  expect(screen.queryByText(PRIVATE_SERVER_SESSION.serverInfo.os_version)).toBeNull();
  expect(screen.queryByText('iMessage Account…')).toBeNull();
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  // Reset the kv-backed stores to their defaults BEFORE each test (harness rule: reset in
  // beforeEach, never afterEach — an afterEach setState fires on a still-mounted tree).
  useFeatureSettingsStore.setState({
    sendTypingIndicators: true,
    sendReadReceipts: true,
    autoDownloadAttachments: true,
    autoDownloadOnWifiOnly: false,
    sendWithReturn: false,
    showDeliveryTimestamps: true,
    compactChatList: false,
    messageNotifications: true,
    errorReportingEnabled: false,
    maxConcurrentDownloads: 2,
    hydrated: true,
  });
  useLockStore.setState({ enabled: false, locked: false, hydrated: true });
  useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: true });
  useSessionStore.setState({ origin: null, serverInfo: null });
  useTransportHealthStore.getState().reset();
  const transportGeneration = useTransportHealthStore.getState().beginLifecycle();
  useTransportHealthStore.getState().setSocketState(transportGeneration, 'connected');
  useDialogStore.setState({ current: null, queue: [] });
  mockIsBiometricAvailable.mockResolvedValue(true);
  mockGetSecureScreenState.mockReturnValue({ available: true, enabled: false });
  mockSetSecureScreenEnabled.mockReset();
  mockForget.mockResolvedValue(undefined);
  mockSyncContacts.mockResolvedValue({ contacts: 3, matched: 2 });
  mockGetContactsPermissionState.mockResolvedValue({ status: 'granted', canAskAgain: true });
  mockGetNotificationPermissionState.mockResolvedValue('granted');
  mockOpenNotificationPermissionSettings.mockResolvedValue(undefined);
  mockRequestNotificationPermission.mockResolvedValue(true);
  mockRotate.mockResolvedValue(undefined);
  mockKvSetWithinTransaction.mockResolvedValue(undefined);
  mockAccountADb.run.mockResolvedValue(undefined);
  mockAccountBDb.run.mockResolvedValue(undefined);
  mockGetDatabase.mockReturnValue(mockAccountADb);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('SettingsScreen — toggles wire to the real stores + persist', () => {
  it('keeps service-supported messaging preferences without exposing retired controls', async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.queryByText('Enable Private API Features')).toBeNull();
    expect(screen.queryByText('Send Subject Lines')).toBeNull();
    expect(screen.getByText('Send Typing Indicators')).toBeTruthy();
    expect(screen.getByText('Send Read Receipts')).toBeTruthy();
    expect(screen.getByText(/connected messaging service supports them/)).toBeTruthy();

    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Let others see when you have read their messages on supported services',
        ),
        'valueChange',
        false,
      );
    });
    expect(useFeatureSettingsStore.getState().sendReadReceipts).toBe(false);
    await waitFor(() =>
      expect(
        mockKvSetWithinTransaction.mock.calls.some(
          (call) => call[1] === 'privateApi.sendReadReceipts' && call[2] === '0',
        ),
      ).toBe(true),
    );
  });

  it('switches a privacy preference back and says so when it cannot be saved', async () => {
    mockKvSetWithinTransaction.mockRejectedValueOnce(new Error('disk full'));
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Let others see when you have read their messages on supported services',
        ),
        'valueChange',
        false,
      );
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toMatchObject({
        title: 'Setting not saved',
        message: 'Gator could not save this change, so it was switched back. Try again.',
      }),
    );
    expect(useFeatureSettingsStore.getState().sendReadReceipts).toBe(true);
  });

  it('steps the Parallel Downloads cap up through the store', async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(/remembers a queued Photos or Gator Album copy/)).toBeTruthy();
    expect(screen.getByText(/turning off auto-download cancels queued copies/)).toBeTruthy();
    expect(screen.getByText(/Tap Photos gallery or Gator album to grant/)).toBeTruthy();
    expect(screen.getByText(/on Android 12 and earlier, tap the choice/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('More parallel downloads'));
    });
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(3);
  });

  it('explains error-report data and requires informed confirmation before opt-in', async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(/Off by default/)).toBeTruthy();
    expect(screen.getByText(/does not queue or send error reports/)).toBeTruthy();

    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        true,
      );
    });

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    const consent = useDialogStore.getState().current;
    expect(consent?.title).toBe('Share error reports?');
    expect(consent?.message).toContain('finite error code');
    expect(consent?.message).toContain('opaque Gator crash-site code');
    expect(consent?.message).toContain(
      'does not send the original error message, filename, function name, or stack trace',
    );
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      ERROR_REPORTING_CONSENT_KEY,
      'granted',
    );

    const allow = consent?.buttons.find((button) => button.text === 'Allow');
    useDialogStore.getState().dismiss();
    await act(async () => {
      allow?.onPress?.();
      // The serialized store tail starts on a later microtask. Settings must already have captured
      // account A's database before the global pointer can move to B.
      mockGetDatabase.mockReturnValue(mockAccountBDb);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true),
    );
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      ERROR_REPORTING_CONSENT_KEY,
      'granted',
    );
    expectDbRunSequence(mockAccountADb, ['BEGIN IMMEDIATE', 'DELETE FROM error_reports', 'COMMIT']);
    expect(mockAccountBDb.run).not.toHaveBeenCalled();
  });

  it('does not publish an admitted account-A consent write after the account retires', async () => {
    let finishWrite!: () => void;
    mockKvSetWithinTransaction.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        true,
      );
    });
    const consent = useDialogStore.getState().current;
    const allow = consent?.buttons.find((button) => button.text === 'Allow');
    useDialogStore.getState().dismiss();
    await act(async () => {
      allow?.onPress?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
        expect.anything(),
        ERROR_REPORTING_CONSENT_KEY,
        'granted',
      ),
    );
    expect(mockAccountADb.run).toHaveBeenCalledTimes(1);

    let pauseFinished = false;
    let pause!: Promise<void>;
    await act(async () => {
      pause = pauseRealtimeDeliveries().then(() => {
        pauseFinished = true;
      });
      await Promise.resolve();
    });
    expect(pauseFinished).toBe(false);

    await act(async () => {
      finishWrite();
      await pause;
    });
    expect(pauseFinished).toBe(true);
    resumeRealtimeDeliveries();
    mockGetDatabase.mockReturnValue(mockAccountBDb);
    await waitFor(() => expect(mockAccountADb.run).toHaveBeenCalledTimes(3));
    expectDbRunSequence(mockAccountADb, [
      'BEGIN IMMEDIATE',
      'DELETE FROM error_reports',
      'ROLLBACK',
    ]);

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    expect(useDialogStore.getState().current).toBeNull();
    expect(mockAccountBDb.run).not.toHaveBeenCalled();
  });

  it('restores a current failed denial, shows fixed copy, and retries without another prompt', async () => {
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    mockKvSetWithinTransaction.mockRejectedValueOnce(new Error('CONSENT_ROUTE_RAW_CANARY'));
    await renderWithTheme(<SettingsScreen />);

    let stateImmediatelyAfterRevocation: boolean | undefined;
    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        false,
      );
      stateImmediatelyAfterRevocation = useFeatureSettingsStore.getState().errorReportingEnabled;
      await Promise.resolve();
    });

    expect(stateImmediatelyAfterRevocation).toBe(false);
    await waitFor(() =>
      expect(useDialogStore.getState().current).toMatchObject({
        title: 'Error Reports',
        message:
          'Gator could not save that privacy choice. Your previous setting is still active; try again after restarting the app.',
      }),
    );
    expect(useDialogStore.getState().current?.message).not.toContain('CONSENT_ROUTE_RAW_CANARY');
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true);

    useDialogStore.getState().dismiss();
    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        false,
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false),
    );
    expect(useDialogStore.getState().current).toBeNull();
    expect(mockKvSetWithinTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      ERROR_REPORTING_CONSENT_KEY,
      'denied',
    );
  });

  it('makes an account-A consent callback inert and lets a fresh account opt in', async () => {
    const oldView = await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        true,
      );
    });
    const oldConsent = useDialogStore.getState().current;
    const oldAllow = oldConsent?.buttons.find((button) => button.text === 'Allow');
    useDialogStore.getState().dismiss();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    await act(async () => {
      oldAllow?.onPress?.();
      await Promise.resolve();
    });

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    expect(useDialogStore.getState().current).toBeNull();
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      ERROR_REPORTING_CONSENT_KEY,
      'granted',
    );

    await act(async () => {
      oldView.unmount();
    });
    mockGetDatabase.mockReturnValue(mockAccountBDb);
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent(
        screen.getByLabelText(
          'Allow Gator to send redacted error reports to your connected server',
        ),
        'valueChange',
        true,
      );
    });
    const freshConsent = useDialogStore.getState().current;
    const freshAllow = freshConsent?.buttons.find((button) => button.text === 'Allow');
    useDialogStore.getState().dismiss();
    await act(async () => {
      freshAllow?.onPress?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true),
    );
    expect(mockKvSetWithinTransaction).toHaveBeenCalledTimes(1);
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      ERROR_REPORTING_CONSENT_KEY,
      'granted',
    );
    expect(mockAccountADb.run).not.toHaveBeenCalled();
    expectDbRunSequence(mockAccountBDb, ['BEGIN IMMEDIATE', 'DELETE FROM error_reports', 'COMMIT']);
  });
});

describe('SettingsScreen — App Lock biometric gate', () => {
  it('states the independent App Lock, Recents, Secure Screen, and storage boundaries', async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(/keeps their content out of Android Recents/)).toBeTruthy();
    expect(screen.getByText(/Neither setting makes the database key biometric-bound/)).toBeTruthy();
    expect(screen.getByText(/Secure Screen separately blocks screenshots/)).toBeTruthy();
    expect(
      screen.getByText(
        /new message notices stay generic while it is enabled, including after unlock/,
      ),
    ).toBeTruthy();
  });

  it('toggles the independent native Secure Screen preference', async () => {
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent(
        screen.getByLabelText('Block Android screenshots and screen recording'),
        'valueChange',
        true,
      );
    });

    expect(mockSetSecureScreenEnabled).toHaveBeenCalledWith(true);
    expect(
      screen.getByLabelText('Block Android screenshots and screen recording').props.value,
    ).toBe(true);
  });

  it('blocks enabling and shows a dialog when no biometric is enrolled', async () => {
    mockIsBiometricAvailable.mockResolvedValue(false);
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent(
        screen.getByLabelText('Require biometric unlock to open the app'),
        'valueChange',
        true,
      );
    });
    await waitFor(() =>
      expect(useDialogStore.getState().current?.title).toBe('Biometrics required'),
    );
    expect(mockSetAppLock).not.toHaveBeenCalled();
  });

  it('enables app lock when biometrics are available', async () => {
    mockIsBiometricAvailable.mockResolvedValue(true);
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent(
        screen.getByLabelText('Require biometric unlock to open the app'),
        'valueChange',
        true,
      );
    });
    await waitFor(() => expect(mockSetAppLock).toHaveBeenCalledWith(true));
    expect(useDialogStore.getState().current).toBeNull();
  });

  it.each(['unmount', 'account retirement'])(
    'drops delayed biometric results after %s',
    async (retirement) => {
      let finish!: (available: boolean) => void;
      mockIsBiometricAvailable.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      );
      const view = await renderWithTheme(<SettingsScreen />);
      await act(async () => {
        fireEvent(
          screen.getByLabelText('Require biometric unlock to open the app'),
          'valueChange',
          true,
        );
      });
      if (retirement === 'unmount') await view.unmount();
      else {
        await act(async () => {
          await pauseRealtimeDeliveries();
          resumeRealtimeDeliveries();
        });
      }
      await act(async () => {
        finish(true);
      });
      expect(mockSetAppLock).not.toHaveBeenCalled();
      expect(useDialogStore.getState().current).toBeNull();
    },
  );

  it('ignores a second toggle while biometric availability is pending', async () => {
    let finish!: (available: boolean) => void;
    mockIsBiometricAvailable.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      const toggle = screen.getByLabelText('Require biometric unlock to open the app');
      await fireEvent(toggle, 'valueChange', true);
      await fireEvent(toggle, 'valueChange', false);
      finish(true);
    });
    expect(mockIsBiometricAvailable).toHaveBeenCalledTimes(1);
    expect(mockSetAppLock).toHaveBeenCalledTimes(1);
    expect(mockSetAppLock).toHaveBeenCalledWith(true);
  });

  it('reports an incomplete privacy transition without promising rollback', async () => {
    mockIsBiometricAvailable.mockResolvedValue(true);
    mockSetAppLock.mockRejectedValueOnce(new Error('native cleanup failed'));
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent(
        screen.getByLabelText('Require biometric unlock to open the app'),
        'valueChange',
        true,
      );
    });
    expect(useDialogStore.getState().current?.message).toMatch(
      /Try again before relying on App Lock/,
    );
    expect(useDialogStore.getState().current?.message).not.toMatch(/unchanged/);
  });
});

describe('SettingsScreen — theme presets', () => {
  it('selecting a preset row updates the theme store', async () => {
    // Pick a preset that is NOT the default so the change is observable.
    const target = PRESET_ORDER.find((k) => k !== DEFAULT_PRESET)!;
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText(PRESETS[target].label));
    });
    expect(useThemeStore.getState().preset).toBe(target);
  });
});

describe('SettingsScreen — navigation rows', () => {
  it.each([
    ['Server Management', 'Server Management…'],
    ['  SERVER   MANAGEMENT…  ', 'Server Management…'],
    ['Storage & File Privacy', 'Storage & File Privacy…'],
    ['Legal & Third-Party Notices', 'Legal & Third-Party Notices…'],
  ])('finds the visible label for %s', async (query, label) => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search settings'), query);
    });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/No settings match/)).toBeNull();
    expect(screen.queryByText('THEME')).toBeNull();
  });

  it('routes each disclosure row via the router', async () => {
    await renderWithTheme(<SettingsScreen />);
    const cases: [string, string][] = [
      ['Custom Themes…', '/themes'],
      ['Reminders', '/reminders'],
      ['Backup', '/backup'],
      ['Find My', '/findmy'],
      ['Storage & File Privacy…', '/storage-privacy'],
      ['Download Integrity…', '/download-integrity'],
      ['Privacy & Data Use…', '/storage-privacy'],
      ['Legal & Third-Party Notices…', '/legal-notices'],
      ['Server Management…', '/server-management'],
      ['Change Server Address…', '/change-server-address'],
      ['Server Health…', '/server-health'],
    ];
    for (const [label, route] of cases) {
      await act(async () => {
        fireEvent.press(screen.getByText(label));
      });
      expect(mockPush).toHaveBeenCalledWith(route);
    }
  });

  it.each([{ supports_facetime_link_creation: true }, { supports_facetime_call_start: true }])(
    'offers the FaceTime route for either exact narrow capability: %o',
    async (capability) => {
      await renderWithTheme(<SettingsScreen />);
      expect(screen.queryByText('FaceTime')).toBeNull();

      await act(async () => {
        useSessionStore.setState({
          origin: 'https://facetime-menu.test',
          serverInfo: { version: 'test', ...capability },
        });
      });
      await act(async () => {
        fireEvent.press(screen.getByText('FaceTime'));
      });
      expect(mockPush).toHaveBeenCalledWith('/facetime');
    },
  );

  it('goes back from the header', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('SettingsScreen — live transport truth', () => {
  it('reads Live Updates from transport health and makes degraded status searchable', async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText('Live Updates')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();

    const generation = useTransportHealthStore.getState().generation;
    await act(async () => {
      useTransportHealthStore.getState().setSocketState(generation, 'reconnecting');
      useTransportHealthStore.getState().setServerState(generation, 'unreachable');
    });
    expect(screen.getByText('Offline')).toBeTruthy();

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search settings'), 'offline');
    });
    expect(screen.getByText('SERVER')).toBeTruthy();
    expect(screen.getByText('Live Updates')).toBeTruthy();
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.queryByText('THEME')).toBeNull();
  });
});

describe('SettingsScreen — destructive/confirm dialogs', () => {
  it('Disconnect opens a confirm whose action calls forget()', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Disconnect from server'));
    });
    const dialog = useDialogStore.getState().current;
    expect(dialog?.title).toBe('Disconnect');
    expect(dialog?.message).toContain(
      'custom folders and device-owned contact colors are removed from this device',
    );
    expect(dialog?.message).toContain('a compatible encrypted backup made first can restore them');
    const confirm = dialog!.buttons.find((b) => b.text === 'Disconnect');
    expect(confirm?.style).toBe('destructive');
    await act(async () => {
      confirm!.onPress?.();
    });
    expect(mockForget).toHaveBeenCalled();
  });

  it('offers "Forget on this phone only" when the old server never confirmed revocation', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockForget.mockRejectedValueOnce(new Error('scoped retirement unconfirmed'));
    mockIsUnconfirmedCredentialRetirement.mockReturnValueOnce(true);
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Disconnect from server'));
    });
    const confirm = useDialogStore.getState().current!.buttons.find((b) => b.text === 'Disconnect');
    useDialogStore.getState().dismiss();

    await act(async () => {
      confirm!.onPress?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current?.title).toBe('Disconnect incomplete'),
    );
    const escape = useDialogStore
      .getState()
      .current!.buttons.find((b) => b.text === 'Forget on this phone only');
    expect(escape).toBeDefined();
    useDialogStore.getState().dismiss();
    await act(async () => {
      escape!.onPress?.();
    });
    await waitFor(() =>
      expect(useDialogStore.getState().current?.title).toBe('Forget on this phone only?'),
    );
    warn.mockRestore();
  });

  it('warns when Disconnect cannot confirm complete account cleanup', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockForget.mockRejectedValueOnce(new Error('credential removal unconfirmed'));
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Disconnect from server'));
    });
    const confirmDialog = useDialogStore.getState().current;
    const confirm = confirmDialog!.buttons.find((b) => b.text === 'Disconnect');
    // AppDialog dismisses before invoking a handler; mirror that ordering while calling the stored
    // callback directly in this route-level test.
    useDialogStore.getState().dismiss();

    await act(async () => {
      confirm!.onPress?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toMatchObject({
        title: 'Disconnect incomplete',
        message:
          'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      '[settings] Disconnect cleanup remains incomplete',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('makes an account-A Disconnect confirmation inert after account B opens', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Disconnect from server'));
    });
    const dialog = useDialogStore.getState().current;
    const confirm = dialog!.buttons.find((button) => button.text === 'Disconnect');
    useDialogStore.getState().dismiss();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    confirm?.onPress?.();
    await Promise.resolve();

    expect(mockForget).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('Rotate encryption key opens a confirm whose action calls rotateDatabaseKey()', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Rotate encryption key…'));
    });
    const dialog = useDialogStore.getState().current;
    expect(dialog?.title).toBe('Rotate encryption key');
    const confirm = dialog!.buttons.find((b) => b.text === 'Rotate');
    await act(async () => {
      confirm!.onPress?.();
    });
    await waitFor(() => expect(mockRotate).toHaveBeenCalled());
  });

  it('makes an account-A key-rotation confirmation inert after account B opens', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Rotate encryption key…'));
    });
    const dialog = useDialogStore.getState().current;
    const confirm = dialog!.buttons.find((button) => button.text === 'Rotate');
    useDialogStore.getState().dismiss();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    confirm?.onPress?.();
    await Promise.resolve();

    expect(mockRotate).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('drains an admitted key rotation but suppresses its account-A result after handoff', async () => {
    let finishRotation!: () => void;
    mockRotate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRotation = resolve;
      }),
    );
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Rotate encryption key…'));
    });
    const dialog = useDialogStore.getState().current;
    const confirm = dialog!.buttons.find((button) => button.text === 'Rotate');
    useDialogStore.getState().dismiss();
    confirm?.onPress?.();
    await waitFor(() => expect(mockRotate).toHaveBeenCalledTimes(1));

    let pauseFinished = false;
    let pause!: Promise<void>;
    await act(async () => {
      pause = pauseRealtimeDeliveries().then(() => {
        pauseFinished = true;
      });
      await Promise.resolve();
    });
    expect(pauseFinished).toBe(false);

    finishRotation();
    await pause;
    resumeRealtimeDeliveries();
    await Promise.resolve();

    expect(useDialogStore.getState().current).toBeNull();
  });
});

describe('SettingsScreen — account-owned server display', () => {
  it('renders exact installed and connected-server details without restoring the retired account route', async () => {
    useSessionStore.setState(PRIVATE_SERVER_SESSION);

    await renderWithTheme(<SettingsScreen />);

    expect(screen.getByText('App Version')).toBeTruthy();
    expect(screen.getByRole('text', { name: '0.1.40' })).toBeTruthy();
    expect(screen.getByText('App Build')).toBeTruthy();
    expect(screen.getByRole('text', { name: '53' })).toBeTruthy();
    expect(screen.getByText('Server')).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_SERVER_SESSION.origin })).toBeTruthy();
    expect(screen.getByText('Server Version')).toBeTruthy();
    expect(
      screen.getByRole('text', { name: PRIVATE_SERVER_SESSION.serverInfo.server_version }),
    ).toBeTruthy();
    expect(screen.getByText('macOS')).toBeTruthy();
    expect(
      screen.getByRole('text', { name: PRIVATE_SERVER_SESSION.serverInfo.os_version }),
    ).toBeTruthy();
    expect(screen.getByText('Private API')).toBeTruthy();
    expect(screen.getByRole('text', { name: 'Retired in this release' })).toBeTruthy();
    expect(screen.queryByText('fallback-version')).toBeNull();
    expect(screen.queryByText('999')).toBeNull();
    expect(screen.queryByText('iMessage Account…')).toBeNull();
  });

  it('does not let a stale account capability override Private API retirement', async () => {
    useSessionStore.setState({
      ...PRIVATE_SERVER_SESSION,
      serverInfo: {
        ...PRIVATE_SERVER_SESSION.serverInfo,
        private_api: false,
        supports_icloud_account: true,
      },
    });

    await renderWithTheme(<SettingsScreen />);

    expect(screen.getByText(PRIVATE_SERVER_SESSION.origin)).toBeTruthy();
    expect(screen.queryByText('iMessage Account…')).toBeNull();
    expect(screen.getByRole('text', { name: 'Retired in this release' })).toBeTruthy();
  });

  it('shows read-only account status only for its separate narrow capability', async () => {
    useSessionStore.setState({
      ...PRIVATE_SERVER_SESSION,
      serverInfo: {
        ...PRIVATE_SERVER_SESSION.serverInfo,
        supports_icloud_account: false,
        supports_imessage_account_status: true,
      },
    });

    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByRole('button', { name: 'View iMessage account' })).toBeTruthy();
    expect(screen.getByRole('text', { name: 'Retired in this release' })).toBeTruthy();
  });

  it('fails closed for an initially stale account and reveals exact details on a fresh mount', async () => {
    useSessionStore.setState(PRIVATE_SERVER_SESSION);
    await pauseRealtimeDeliveries();

    const staleView = await renderWithTheme(<SettingsScreen />);
    expectPrivateServerSessionHidden();

    await act(async () => {
      staleView.unmount();
    });
    resumeRealtimeDeliveries();
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(PRIVATE_SERVER_SESSION.origin)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.server_version)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.os_version)).toBeTruthy();
    expect(screen.queryByText('iMessage Account…')).toBeNull();
  });

  it('automatically hides account-A identity after handoff and lets a fresh account render', async () => {
    useSessionStore.setState(PRIVATE_SERVER_SESSION);
    const view = await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(PRIVATE_SERVER_SESSION.origin)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.server_version)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.os_version)).toBeTruthy();
    expect(screen.queryByText('iMessage Account…')).toBeNull();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    expectPrivateServerSessionHidden();

    await act(async () => {
      view.unmount();
    });
    resumeRealtimeDeliveries();
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText(PRIVATE_SERVER_SESSION.origin)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.server_version)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVER_SESSION.serverInfo.os_version)).toBeTruthy();
    expect(screen.queryByText('iMessage Account…')).toBeNull();
  });
});

describe('SettingsScreen — sync contacts', () => {
  it('runs the contacts sync and reports the result in a dialog', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
    });
    await waitFor(() => expect(mockSyncContacts).toHaveBeenCalled());
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Contacts synced'));
  });

  it('explains optional Contacts access before the first native request', async () => {
    mockGetContactsPermissionState.mockResolvedValueOnce({
      status: 'undetermined',
      canAskAgain: true,
    });
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
    });

    const rationale = useDialogStore.getState().current;
    expect(rationale?.title).toBe('Allow Contacts access?');
    expect(rationale?.message).toContain('still type phone numbers and email addresses');
    expect(mockSyncContacts).not.toHaveBeenCalled();

    useDialogStore.getState().dismiss();
    await act(async () => {
      rationale?.buttons.find((button) => button.text === 'Continue')?.onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockSyncContacts).toHaveBeenCalledTimes(1));
  });

  it('surfaces a permission-denied error as guidance', async () => {
    mockSyncContacts.mockRejectedValue(
      Object.assign(new Error('contacts-permission-denied'), {
        name: 'ContactsPermissionDeniedError',
        canAskAgain: false,
      }),
    );
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
    });
    await waitFor(() => {
      const d = useDialogStore.getState().current;
      expect(d?.title).toBe('Contacts access denied');
      expect(d?.message).toMatch(/Android won’t show/);
      expect(d?.buttons.some((button) => button.text === 'Open Settings')).toBe(true);
    });
  });

  it("does not show account A's delayed result after account B opens", async () => {
    let finishSync!: (result: { contacts: number; matched: number }) => void;
    mockSyncContacts.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSync = resolve;
      }),
    );
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
    });
    expect(mockSyncContacts).toHaveBeenCalledWith({
      force: true,
      accountLease: expect.objectContaining({ generation: expect.any(Number) }),
    });

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    await act(async () => {
      finishSync({ contacts: 99, matched: 88 });
      await Promise.resolve();
    });

    expect(useDialogStore.getState().current).toBeNull();
  });
});

describe('SettingsScreen — notification permission', () => {
  it('explains an unrequested grant and requests only after Enable', async () => {
    mockGetNotificationPermissionState.mockResolvedValue('not-determined');
    await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Notification Access…'));
    });
    const rationale = useDialogStore.getState().current;
    expect(rationale?.title).toBe('Turn on notifications?');
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();

    useDialogStore.getState().dismiss();
    await act(async () => {
      rationale?.buttons.find((button) => button.text === 'Enable')?.onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1));
    expect(mockOpenNotificationPermissionSettings).not.toHaveBeenCalled();
  });

  it('drops a delayed native permission result after Settings unmounts', async () => {
    let finishRequest!: (granted: boolean) => void;
    mockGetNotificationPermissionState.mockResolvedValue('not-determined');
    mockRequestNotificationPermission.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
    );
    const view = await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Notification Access…'));
    });
    const rationale = useDialogStore.getState().current;
    useDialogStore.getState().dismiss();
    await act(async () => {
      rationale?.buttons.find((button) => button.text === 'Enable')?.onPress?.();
      await Promise.resolve();
    });
    expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      finishRequest(false);
      await Promise.resolve();
    });

    expect(useDialogStore.getState().current).toBeNull();
  });

  it('does not launch a retained permission action after Settings unmounts', async () => {
    mockGetNotificationPermissionState.mockResolvedValue('not-determined');
    const view = await renderWithTheme(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Notification Access…'));
    });
    const rationale = useDialogStore.getState().current;
    useDialogStore.getState().dismiss();
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      rationale?.buttons.find((button) => button.text === 'Enable')?.onPress?.();
      await Promise.resolve();
    });

    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('SettingsScreen — search filter', () => {
  it('narrows to a matching section and hides the others', async () => {
    await renderWithTheme(<SettingsScreen />);
    // THEME renders initially.
    expect(screen.getByText('THEME')).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search settings'), 'contacts');
    });
    expect(screen.getByText('CONTACTS')).toBeTruthy();
    expect(screen.queryByText('THEME')).toBeNull();
  });

  it('finds Secure Screen by its visible and descriptive terms', async () => {
    await renderWithTheme(<SettingsScreen />);
    const searchField = screen.getByPlaceholderText('Search settings');

    for (const term of ['secure', 'screen', 'screenshot', 'recording', 'capture']) {
      await act(async () => {
        fireEvent.changeText(searchField, term);
      });
      expect(screen.getByText('GENERAL')).toBeTruthy();
      expect(screen.getByText('Secure Screen')).toBeTruthy();
      expect(screen.queryByText(/No settings match/)).toBeNull();
    }
  });

  it('shows the no-results message when nothing matches', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search settings'), 'zzzznope');
    });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
  });
});

describe('SettingsScreen — shared-password push deadline', () => {
  const DAY = 24 * 60 * 60 * 1000;
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('warns a shared-password phone before the cutoff and links straight to pairing', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(SHARED_PASSWORD_PUSH_CUTOFF_MS - 30 * DAY);
    useSessionStore.setState({ ...PRIVATE_SERVER_SESSION, password: 'shared-password-for-test' });

    await renderWithTheme(<SettingsScreen />);

    expect(
      screen.getByText(/shared-password phones end on February 1, 2027\. Pair this device/),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Pair This Device…'));
    });
    expect(mockPush).toHaveBeenCalledWith('/server-management');
  });

  it('says notifications ended once the cutoff has passed', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(SHARED_PASSWORD_PUSH_CUTOFF_MS + DAY);
    useSessionStore.setState({ ...PRIVATE_SERVER_SESSION, password: 'shared-password-for-test' });

    await renderWithTheme(<SettingsScreen />);

    expect(screen.getByText(/Background notifications ended on February 1, 2027/)).toBeTruthy();
    expect(screen.getByText('Pair This Device…')).toBeTruthy();
  });

  it('shows nothing for a phone that already has its own device credential', async () => {
    useSessionStore.setState({
      ...PRIVATE_SERVER_SESSION,
      password: `bbd_device_v1_${'A'.repeat(43)}`,
    });

    await renderWithTheme(<SettingsScreen />);

    expect(screen.queryByText('Pair This Device…')).toBeNull();
    expect(screen.queryByText(/February 1, 2027/)).toBeNull();
  });
});
