/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockPermissionState = jest.fn();
const mockPickAndSendContact = jest.fn();
const mockRationale = jest.fn();
const mockRecovery = jest.fn();

jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: () => mockPermissionState(),
}));
jest.mock('@/services/send', () => ({
  pickAndSendContact: (...args: unknown[]) => mockPickAndSendContact(...args),
  isContactsPermissionDeniedError: () => false,
}));
jest.mock('@ui/permissions/contactsPermission', () => ({
  showContactsPermissionRationale: (...args: unknown[]) => mockRationale(...args),
  showContactsPermissionRecovery: (...args: unknown[]) => mockRecovery(...args),
}));
jest.mock('@ui/conversations/sendNotices', () => ({ presentSendIssue: jest.fn() }));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('@core/secure', () => ({ logger: { warn: jest.fn() } }));

import { usePickAndSendContact } from '@features/conversations/usePickAndSendContact';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { act, renderHook, waitFor } from '../support/renderWithTheme';

const CHAT = 'iMessage;-;+15550001111';

async function pickContact(available = true): Promise<void> {
  const lease = captureRealtimeDeliveryLease();
  const { result } = await renderHook(() => usePickAndSendContact(CHAT, lease, available));
  await act(async () => {
    result.current();
  });
}

beforeEach(() => {
  mockPickAndSendContact.mockResolvedValue(undefined);
});

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
});

describe('usePickAndSendContact', () => {
  it('opens the contact picker right away when Contacts access is granted', async () => {
    mockPermissionState.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await pickContact();

    await waitFor(() => expect(mockPickAndSendContact).toHaveBeenCalledTimes(1));
    expect(mockPickAndSendContact.mock.calls[0]?.[0]).toBe(CHAT);
    expect(mockRationale).not.toHaveBeenCalled();
  });

  it('offers recovery instead of asking again when access is permanently denied', async () => {
    mockPermissionState.mockResolvedValue({ status: 'denied', canAskAgain: false });

    await pickContact();

    await waitFor(() => expect(mockRecovery).toHaveBeenCalledTimes(1));
    expect(mockRecovery.mock.calls[0]?.[0]).toMatchObject({ canAskAgain: false });
    expect(mockRationale).not.toHaveBeenCalled();
    expect(mockPickAndSendContact).not.toHaveBeenCalled();
  });

  it('explains optional access first, and opens the picker only after the person continues', async () => {
    mockPermissionState.mockResolvedValue({ status: 'undetermined', canAskAgain: true });

    await pickContact();

    await waitFor(() => expect(mockRationale).toHaveBeenCalledTimes(1));
    const rationale = mockRationale.mock.calls[0]?.[0] as {
      purpose: string;
      onContinue: () => void;
    };
    expect(rationale.purpose).toBe('share');
    expect(mockPickAndSendContact).not.toHaveBeenCalled();
    await act(async () => {
      rationale.onContinue();
    });
    expect(mockPickAndSendContact).toHaveBeenCalledTimes(1);
  });

  it('does not open the picker when Send Contact is unavailable for this chat', async () => {
    mockPermissionState.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await pickContact(false);

    await waitFor(() => expect(mockPermissionState).toHaveBeenCalledTimes(1));
    expect(mockPickAndSendContact).not.toHaveBeenCalled();
  });
});
