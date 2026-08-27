import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockReplace = jest.fn();
const mockDb = { account: 'permission-onboarding-account' };

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@state/featureSettingsStore', () => ({
  completePermissionOnboarding: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({ generation: 1, isCurrent: () => true }),
}));
jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: jest.fn(),
  isContactsPermissionDeniedError: jest.fn(() => false),
  syncContacts: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  getNotificationPermissionState: jest.fn(),
  openNotificationPermissionSettings: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));
jest.mock('@ui/permissions/contactsPermission', () => ({
  openContactsPermissionSettings: jest.fn(),
  showContactsPermissionRecovery: jest.fn(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

// eslint-disable-next-line import/first
import PermissionsScreen from '../../../app/(setup)/permissions';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { getContactsPermissionState, syncContacts } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import {
  getNotificationPermissionState,
  openNotificationPermissionSettings,
  requestNotificationPermission,
} from '@/services/notifications/notifeeService';
// eslint-disable-next-line import/first
import { openContactsPermissionSettings } from '@ui/permissions/contactsPermission';
// eslint-disable-next-line import/first
import { completePermissionOnboarding } from '@state/featureSettingsStore';

const mockGetContactsPermissionState = getContactsPermissionState as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockSyncContacts = syncContacts as jest.Mock;
const mockGetNotificationPermissionState = getNotificationPermissionState as jest.Mock;
const mockOpenNotificationPermissionSettings = openNotificationPermissionSettings as jest.Mock;
const mockRequestNotificationPermission = requestNotificationPermission as jest.Mock;
const mockOpenContactsPermissionSettings = openContactsPermissionSettings as jest.Mock;
const mockCompletePermissionOnboarding = completePermissionOnboarding as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue(mockDb);
  mockGetNotificationPermissionState.mockResolvedValue('not-determined');
  mockGetContactsPermissionState.mockResolvedValue({
    status: 'undetermined',
    canAskAgain: true,
  });
  mockRequestNotificationPermission.mockResolvedValue(true);
  mockOpenNotificationPermissionSettings.mockResolvedValue(undefined);
  mockSyncContacts.mockResolvedValue({ contacts: 3, matched: 2 });
  mockOpenContactsPermissionSettings.mockResolvedValue(undefined);
  mockCompletePermissionOnboarding.mockResolvedValue(true);
});

describe('PermissionsScreen', () => {
  it('shows optional rationale without launching either native prompt', async () => {
    await renderWithTheme(<PermissionsScreen />);

    await waitFor(() => expect(screen.getByText('Not enabled yet')).toBeTruthy());
    expect(screen.getByText('Optional — not requested')).toBeTruthy();
    expect(screen.getByText(/typing a phone number or email address instead/)).toBeTruthy();
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
    expect(mockSyncContacts).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByText('Enable Notifications'));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.press(screen.getByText('Continue to Messages'));
      await Promise.resolve();
    });
    expect(mockCompletePermissionOnboarding).toHaveBeenCalledWith({
      db: mockDb,
      shouldCommit: expect.any(Function),
    });
    expect(mockReplace).toHaveBeenCalledWith('/home');
  });

  it('rechecks an unavailable status without launching the native notification prompt', async () => {
    mockGetNotificationPermissionState
      .mockRejectedValueOnce(new Error('STATUS_UNAVAILABLE'))
      .mockResolvedValueOnce('not-determined');
    await renderWithTheme(<PermissionsScreen />);

    await waitFor(() => expect(screen.getByText('Status unavailable')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByText('Check Again'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('Not enabled yet')).toBeTruthy());
    expect(mockGetNotificationPermissionState).toHaveBeenCalledTimes(2);
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
  });

  it('requests Contacts only after the explicit Sync Contacts action', async () => {
    await renderWithTheme(<PermissionsScreen />);
    await waitFor(() => expect(screen.getByText('Optional — not requested')).toBeTruthy());
    expect(mockSyncContacts).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByText('Sync Contacts'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockSyncContacts).toHaveBeenCalledWith({
        force: true,
        accountLease: expect.objectContaining({ generation: 1 }),
      }),
    );
  });

  it('routes denied states to Android settings without re-requesting', async () => {
    mockGetNotificationPermissionState.mockResolvedValue('denied');
    mockGetContactsPermissionState.mockResolvedValue({ status: 'denied', canAskAgain: false });
    await renderWithTheme(<PermissionsScreen />);

    await waitFor(() =>
      expect(screen.getByText('Denied — open Android settings to enable')).toBeTruthy(),
    );
    expect(screen.getByText('Denied — enable in Android settings')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Open Notification Settings'));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Open App Settings'));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockOpenNotificationPermissionSettings).toHaveBeenCalledTimes(1));
    expect(mockOpenContactsPermissionSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
    expect(mockSyncContacts).not.toHaveBeenCalled();
  });
});
