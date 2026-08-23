/**
 * MessageDetailsSheet (src/ui/conversations/MessageDetailsSheet.tsx): the "Details" bottom sheet
 * opened from the long-press menu, showing a single message's Sent/Delivered/Read/Edited times,
 * who it's from, and its service. Locked in:
 *   - a from-me message with delivery + read stamps shows the Sent/Delivered/Read/From/Service rows,
 *     with From = "You";
 *   - a received message with no delivery/read stamps OMITS those rows and shows the sender name;
 *   - an own message with no per-message service falls back to the chat's service;
 *   - `data={null}` renders nothing.
 *
 * Rows are dropped when their formatted value is empty (formatTime/formatSeparatorDate return '' for
 * a null/0 date), so the presence of a LABEL is the deterministic signal — no timezone-dependent
 * date-string assertions. Renders inside a RN Modal whose mount is async → assert via findBy.
 */
import React from 'react';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { SelectedMessage } from '@ui/conversations/MessageActionsOverlay';
import { formatSeparatorDate, formatTime } from '@utils';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { MessageDetailsSheet } from '@ui/conversations/MessageDetailsSheet';

const SENT_AT = Date.UTC(2026, 0, 2, 8, 5);
const DELIVERED_AT = Date.UTC(2026, 0, 2, 9, 17);
const READ_AT = Date.UTC(2026, 0, 2, 10, 29);
const EDITED_AT = Date.UTC(2026, 0, 3, 11, 41);
const PRIVATE_SENDER = 'private-details-sender-y-b42e@example.test';
const PRIVATE_SERVICE = 'private-details-service-y-38da';
const HIDDEN = { includeHiddenElements: true } as const;

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

function privateSelection(overrides: Partial<SelectedMessage> = {}): SelectedMessage {
  return sel({
    guid: 'private-details-guid-y-a91d@example.test',
    text: 'private-details-body-y-7c91@example.test',
    isFromMe: false,
    senderName: PRIVATE_SENDER,
    dateCreated: SENT_AT,
    dateDelivered: DELIVERED_AT,
    dateRead: READ_AT,
    dateEdited: EDITED_AT,
    senderService: PRIVATE_SERVICE,
    ...overrides,
  });
}

function StatefulSheet({
  initialData,
  onClose,
}: {
  initialData: SelectedMessage | null;
  onClose: () => void;
}): React.JSX.Element {
  const [data, setData] = React.useState<SelectedMessage | null>(initialData);
  const close = React.useCallback(() => {
    onClose();
    setData(null);
  }, [onClose]);

  return <MessageDetailsSheet data={data} onClose={close} />;
}

describe('MessageDetailsSheet', () => {
  it('shows exact Sent/Delivered/Read/Edited/From/Service values for a from-me message', async () => {
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({
          isFromMe: true,
          dateCreated: SENT_AT,
          dateDelivered: DELIVERED_AT,
          dateRead: READ_AT,
          dateEdited: EDITED_AT,
          senderService: PRIVATE_SERVICE,
        })}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Delivered')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Service')).toBeTruthy();
    expect(screen.getByRole('text', { name: formatSeparatorDate(SENT_AT) })).toBeTruthy();
    expect(screen.getByRole('text', { name: formatTime(DELIVERED_AT) })).toBeTruthy();
    expect(screen.getByRole('text', { name: formatTime(READ_AT) })).toBeTruthy();
    expect(screen.getByRole('text', { name: formatSeparatorDate(EDITED_AT) })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_SERVICE })).toBeTruthy();
  });

  it('omits Delivered/Read rows for a received message and shows the sender name', async () => {
    await renderWithTheme(
      <MessageDetailsSheet
        data={sel({
          isFromMe: false,
          senderName: PRIVATE_SENDER,
          dateDelivered: null,
          dateRead: null,
          senderService: 'SMS',
        })}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_SENDER })).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain(PRIVATE_SENDER);
    expect(screen.getByText('SMS')).toBeTruthy();
    expect(screen.queryByText('Delivered')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
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
    const onClose = jest.fn();
    await renderWithTheme(<MessageDetailsSheet data={null} onClose={onClose} />);
    await waitFor(() => expect(screen.queryByText('Details')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses visible details through the real backdrop and clears parent-owned data', async () => {
    const onClose = jest.fn();
    const view = await renderWithTheme(
      <StatefulSheet initialData={privateSelection()} onClose={onClose} />,
    );
    expect(await screen.findByText(PRIVATE_SENDER)).toBeTruthy();
    expect(screen.getByText(PRIVATE_SERVICE)).toBeTruthy();
    expect(screen.getByTestId('message-details-backdrop')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('message-details-backdrop'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Details', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('message-details-backdrop')).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_SENDER);
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_SERVICE);
  });
});
