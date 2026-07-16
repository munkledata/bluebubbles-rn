/**
 * SettingsScreen route (app/(app)/settings.tsx): the top-level settings list.
 *
 * This suite locks in the SCREEN'S wiring to the real stores + services, not the
 * store internals (those have their own node tests):
 *   - toggles flip the REAL kv-backed stores optimistically AND invoke the persist
 *     path (`kvSet`) — @db/database is mocked in the shared setup so the real persist
 *     is swallowed; here `@db/repositories` keeps every real export but swaps `kvSet`
 *     for a spy so we can OBSERVE the persist call;
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

const mockPush = jest.fn();
const mockBack = jest.fn();

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
jest.mock('@native/biometrics', () => ({ isBiometricAvailable: jest.fn() }));
jest.mock('@/services', () => ({
  forget: jest.fn(),
  rotateDatabaseKey: jest.fn(),
  setAppLockEnabled: jest.fn(),
}));
jest.mock('@/services/contacts/contactsService', () => ({ syncContacts: jest.fn() }));
// Keep every real repository export; only replace kvSet so we can watch the persist calls.
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  kvSet: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import SettingsScreen from '../../../app/(app)/settings';
// eslint-disable-next-line import/first
import { isBiometricAvailable } from '@native/biometrics';
// eslint-disable-next-line import/first
import { forget, rotateDatabaseKey, setAppLockEnabled } from '@/services';
// eslint-disable-next-line import/first
import { syncContacts } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import { kvSet } from '@db/repositories';
// eslint-disable-next-line import/first
import { useSmartReplyStore } from '@state/smartReplyStore';
// eslint-disable-next-line import/first
import { useRedactedModeStore } from '@state/redactedModeStore';
// eslint-disable-next-line import/first
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useSyncSettingsStore } from '@state/syncSettingsStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useThemeStore } from '@state/themeStore';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { PRESET_ORDER, PRESETS, DEFAULT_PRESET } from '@ui/theme/tokens';

const mockIsBiometricAvailable = isBiometricAvailable as jest.Mock;
const mockForget = forget as jest.Mock;
const mockRotate = rotateDatabaseKey as jest.Mock;
const mockSetAppLock = setAppLockEnabled as jest.Mock;
const mockSyncContacts = syncContacts as jest.Mock;
const mockKvSet = kvSet as jest.Mock;

beforeEach(() => {
  // Reset the kv-backed stores to their defaults BEFORE each test (harness rule: reset in
  // beforeEach, never afterEach — an afterEach setState fires on a still-mounted tree).
  useSmartReplyStore.setState({ enabled: true, hydrated: true });
  useRedactedModeStore.setState({ enabled: false, hydrated: true });
  useFeatureSettingsStore.setState({
    privateApiEnabled: true,
    sendTypingIndicators: true,
    sendReadReceipts: true,
    autoDownloadAttachments: true,
    autoDownloadOnWifiOnly: false,
    sendWithReturn: false,
    showDeliveryTimestamps: true,
    compactChatList: false,
    messageNotifications: true,
    maxConcurrentDownloads: 2,
    hydrated: true,
  });
  useLockStore.setState({ enabled: false, locked: false, hydrated: true });
  useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: true });
  useSessionStore.setState({ origin: null, serverInfo: null });
  useDialogStore.setState({ current: null, queue: [] });
  mockIsBiometricAvailable.mockResolvedValue(true);
  mockSyncContacts.mockResolvedValue({ contacts: 3, matched: 2 });
  mockRotate.mockResolvedValue(undefined);
  mockKvSet.mockResolvedValue(undefined);
});

describe('SettingsScreen — toggles wire to the real stores + persist', () => {
  it('flips Suggested Replies and calls the persist path', async () => {
    await renderWithTheme(<SettingsScreen />);
    const sw = screen.getByLabelText('Toggle suggested replies');
    await act(async () => {
      fireEvent(sw, 'valueChange', false);
    });
    expect(useSmartReplyStore.getState().enabled).toBe(false);
    // The db handle is the shared-mock's getDatabase() (undefined here); assert on key+value.
    await waitFor(() =>
      expect(mockKvSet.mock.calls.some((c) => c[1] === 'smartReply.enabled' && c[2] === '0')).toBe(
        true,
      ),
    );
  });

  it('flips Redacted Mode on and persists it', async () => {
    await renderWithTheme(<SettingsScreen />);
    const sw = screen.getByLabelText('Hide message previews, names, and notification contents');
    await act(async () => {
      fireEvent(sw, 'valueChange', true);
    });
    expect(useRedactedModeStore.getState().enabled).toBe(true);
    await waitFor(() =>
      expect(
        mockKvSet.mock.calls.some((c) => c[1] === 'privacy.redactedMode' && c[2] === '1'),
      ).toBe(true),
    );
  });

  it('flips a feature flag (Read Receipts off) via setFlag + persists it', async () => {
    await renderWithTheme(<SettingsScreen />);
    const sw = screen.getByLabelText('Let others see when you have read their messages');
    await act(async () => {
      fireEvent(sw, 'valueChange', false);
    });
    expect(useFeatureSettingsStore.getState().sendReadReceipts).toBe(false);
    await waitFor(() =>
      expect(
        mockKvSet.mock.calls.some((c) => c[1] === 'privateApi.sendReadReceipts' && c[2] === '0'),
      ).toBe(true),
    );
  });

  it('leaves the Send-Typing switch disabled while Private API is off', async () => {
    useFeatureSettingsStore.setState({ privateApiEnabled: false });
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByLabelText('Let others see when you are typing').props.disabled).toBe(true);
  });

  it('steps the Parallel Downloads cap up through the store', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('More parallel downloads'));
    });
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(3);
  });
});

describe('SettingsScreen — App Lock biometric gate', () => {
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
  it('routes each disclosure row via the router', async () => {
    await renderWithTheme(<SettingsScreen />);
    const cases: Array<[string, string]> = [
      ['Custom Themes…', '/themes'],
      ['Reminders', '/reminders'],
      ['Backup', '/backup'],
      ['Find My', '/findmy'],
      ['Server Management…', '/server-management'],
      ['Server Health…', '/server-health'],
    ];
    for (const [label, route] of cases) {
      await act(async () => {
        fireEvent.press(screen.getByText(label));
      });
      expect(mockPush).toHaveBeenCalledWith(route);
    }
  });

  it('goes back from the header', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalled();
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
    const confirm = dialog!.buttons.find((b) => b.text === 'Disconnect');
    expect(confirm?.style).toBe('destructive');
    await act(async () => {
      confirm!.onPress?.();
    });
    expect(mockForget).toHaveBeenCalled();
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

  it('surfaces a permission-denied error as guidance', async () => {
    mockSyncContacts.mockRejectedValue(new Error('contacts-permission-denied'));
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
    });
    await waitFor(() => {
      const d = useDialogStore.getState().current;
      expect(d?.title).toBe('Contacts');
      expect(d?.message).toMatch(/Permission denied/);
    });
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

  it('shows the no-results message when nothing matches', async () => {
    await renderWithTheme(<SettingsScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search settings'), 'zzzznope');
    });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
  });
});
