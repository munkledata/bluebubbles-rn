import React from 'react';
import { MemberContactActions } from '@ui/conversations/MemberContactActions';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockCopy = jest.fn();
const mockCall = jest.fn();
const mockEmail = jest.fn();
const mockOpenContact = jest.fn();
const mockShowExternalOpenFailure = jest.fn();

jest.mock('@/services/memberContactActions', () => ({
  ...jest.requireActual('@/services/memberContactActions'),
  copyMemberAddress: (...args: unknown[]) => mockCopy(...args),
  callMember: (...args: unknown[]) => mockCall(...args),
  emailMember: (...args: unknown[]) => mockEmail(...args),
  openMemberContact: (...args: unknown[]) => mockOpenContact(...args),
}));
jest.mock('@ui/toast/external-open-feedback', () => ({
  showExternalOpenFailure: () => mockShowExternalOpenFailure(),
}));

beforeEach(() => {
  for (const mock of [
    mockCopy,
    mockCall,
    mockEmail,
    mockOpenContact,
    mockShowExternalOpenFailure,
  ]) {
    mock.mockReset();
  }
  mockCopy.mockResolvedValue(true);
  mockCall.mockResolvedValue(true);
  mockEmail.mockResolvedValue(true);
  mockOpenContact.mockResolvedValue(true);
});

describe('MemberContactActions', () => {
  it('offers Copy, Call and View Contact for a linked phone number', async () => {
    await renderWithTheme(
      <MemberContactActions name="Mom" address="+15551112222" contactSourceId="101" />,
    );
    expect(screen.getByRole('button', { name: 'Copy Mom’s address' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email Mom' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Call Mom' }));
    await fireEvent.press(screen.getByRole('button', { name: 'View Mom in Contacts' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Copy Mom’s address' }));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith('+15551112222'));
    expect(mockCall).toHaveBeenCalledWith('+15551112222');
    expect(mockOpenContact).toHaveBeenCalledWith({
      address: '+15551112222',
      contactSourceId: '101',
    });
    expect(mockShowExternalOpenFailure).not.toHaveBeenCalled();
  });

  it('offers Email and Add to Contacts for an unlinked email address', async () => {
    await renderWithTheme(
      <MemberContactActions name="Craig" address="craig@apple.com" contactSourceId={null} />,
    );
    expect(screen.queryByRole('button', { name: 'Call Craig' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Email Craig' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add Craig to Contacts' }));
    await waitFor(() =>
      expect(mockOpenContact).toHaveBeenCalledWith({
        address: 'craig@apple.com',
        contactSourceId: null,
      }),
    );
    expect(mockEmail).toHaveBeenCalledWith('craig@apple.com');
  });

  it('offers only Copy for a business short code', async () => {
    await renderWithTheme(
      <MemberContactActions name="Bank" address="37542" contactSourceId={null} />,
    );
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
      'Copy Bank’s address',
    ]);
  });

  it('shows the shared notice when the phone refuses the handoff', async () => {
    mockCall.mockResolvedValue(false);
    mockOpenContact.mockRejectedValue(new Error('planted'));
    await renderWithTheme(
      <MemberContactActions name="Mom" address="+15551112222" contactSourceId={null} />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Call Mom' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add Mom to Contacts' }));
    await waitFor(() => expect(mockShowExternalOpenFailure).toHaveBeenCalledTimes(2));
  });
});
