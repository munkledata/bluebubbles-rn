/**
 * MessageDetailsSheet (src/ui/conversations/MessageDetailsSheet.tsx): the "Details" bottom sheet
 * opened from the long-press menu, showing a single message's Sent/Delivered/Read/Edited times,
 * who it's from, and its service. Locked in:
 *   - a from-me message with delivery + read stamps shows the Sent/Delivered/Read/From/Service rows,
 *     with From = "You";
 *   - a received message with no delivery/read stamps OMITS those rows and shows the sender name;
 *   - redacted mode masks the sender name (AGENTS.md privacy rule — must not leak identity);
 *   - an own message with no per-message service falls back to the chat's service;
 *   - `data={null}` renders nothing.
 *
 * Rows are dropped when their formatted value is empty (formatTime/formatSeparatorDate return '' for
 * a null/0 date), so the presence of a LABEL is the deterministic signal — no timezone-dependent
 * date-string assertions. Renders inside a RN Modal whose mount is async → assert via findBy.
 */
import React from 'react';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { SelectedMessage } from '@ui/conversations/MessageActionsOverlay';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { MessageDetailsSheet } from '@ui/conversations/MessageDetailsSheet';

function sel(partial: Partial<SelectedMessage>): SelectedMessage {
  return {
    guid: 'g1',
    text: 'hello',
    isFromMe: true,
    senderName: null,
    mine: [],
    dateCreated: 1_700_000_000_000,
    isRetracted: false,
    isEdited: false,
    isTemp: false,
    sendState: 'sent',
    attachments: [],
    ...partial,
  };
}

describe('MessageDetailsSheet', () => {
  beforeEach(() => {
    useRedactedModeStore.setState({ enabled: false });
  });

  it('shows Sent/Delivered/Read/From/Service for a from-me message', async () => {
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({
          isFromMe: true,
          dateDelivered: 1_700_000_050_000,
          dateRead: 1_700_000_100_000,
          senderService: 'iMessage',
        })}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Delivered')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Service')).toBeTruthy();
    expect(screen.getByText('iMessage')).toBeTruthy();
  });

  it('omits Delivered/Read rows for a received message and shows the sender name', async () => {
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({
          isFromMe: false,
          senderName: 'Alice',
          dateDelivered: null,
          dateRead: null,
          senderService: 'SMS',
        })}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('SMS')).toBeTruthy();
    expect(screen.queryByText('Delivered')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('masks the sender name in redacted mode', async () => {
    useRedactedModeStore.setState({ enabled: true });
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({ isFromMe: false, senderName: 'Alice' })}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    // The "From" label still renders; the actual name is masked.
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('falls back to the chat service when the message carries none (own message)', async () => {
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({ isFromMe: true, senderService: null })}
        onClose={jest.fn()}
        chatService="RCS"
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.getByText('Service')).toBeTruthy();
    expect(screen.getByText('RCS')).toBeTruthy();
  });

  it('renders nothing when data is null (closed)', async () => {
    await renderWithTheme(<MessageDetailsSheet data={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Details')).toBeNull());
  });
});
