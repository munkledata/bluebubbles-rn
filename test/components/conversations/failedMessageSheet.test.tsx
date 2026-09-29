/**
 * FailedMessageSheet (src/ui/conversations/FailedMessageSheet.tsx): the themed in-app action
 * sheet shown when the "!" on a not-delivered message is tapped. This is the COMPONENT-level
 * source of truth for the sheet (messageList.test.tsx exercises it only through a probe mock, so
 * the real copy/callback wiring is verified here). Locks in:
 *   - the header copy — "Message Not Delivered" plus a subtitle that switches on isAttachment;
 *   - Try Again fires onRetry THEN onClose;
 *   - Delete fires onDelete THEN onClose;
 *   - Cancel fires only onClose (neither onRetry nor onDelete).
 *
 * In-file mock: `react-native-safe-area-context` — the sheet calls useSafeAreaInsets; return
 * zero insets so it resolves without a SafeAreaProvider.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { FailedMessageSheet } from '@ui/conversations/FailedMessageSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function handlers() {
  return { onClose: jest.fn(), onRetry: jest.fn(), onDelete: jest.fn() };
}

describe('FailedMessageSheet — header copy', () => {
  it('shows the not-delivered title and the plain-message subtitle by default', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible {...h} />);
    expect(screen.getByText('Message Not Delivered')).toBeTruthy();
    expect(screen.getByText('Your message couldn’t be sent.')).toBeTruthy();
  });

  it('switches the subtitle to attachment copy when isAttachment is true', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible isAttachment {...h} />);
    expect(screen.getByText('Your attachment couldn’t be sent.')).toBeTruthy();
    expect(screen.queryByText('Your message couldn’t be sent.')).toBeNull();
  });

  it('shows projected server detail only when the row provides it', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible errorDetail="Messages rejected this send." {...h} />,
    );
    expect(screen.getByText('Messages rejected this send.')).toBeTruthy();
  });
});

describe('FailedMessageSheet — actions', () => {
  it('explains an uncertain one-shot image without offering Retry', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isAttachment retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Attachment Status Unconfirmed')).toBeTruthy();
    expect(
      screen.getByText('Delivery may have occurred. Check Messages before sending a new copy.'),
    ).toBeTruthy();
    expect(screen.queryByText('Try Again')).toBeNull();
    fireEvent.press(screen.getByText('Remove from Gator'));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onRetry).not.toHaveBeenCalled();
  });

  it('keeps an uncertain one-shot reply distinct and never offers Retry', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isReply retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Reply Status Unconfirmed')).toBeTruthy();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('labels an uncertain current-location send without calling it an attachment', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isLocation retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Location Status Unconfirmed')).toBeTruthy();
    expect(screen.queryByText('Attachment Status Unconfirmed')).toBeNull();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('labels an uncertain effect and never offers Retry', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isEffect retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Effect Status Unconfirmed')).toBeTruthy();
    expect(
      screen.getByText(
        'This effect message may have been delivered. Check Messages before sending a new copy.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('labels an uncertain mention generically and never offers Retry', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isMention retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Mention Status Unconfirmed')).toBeTruthy();
    expect(
      screen.getByText(
        'This mention message may have been delivered. Check Messages before sending a new copy.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('labels an uncertain formatted message without calling it an attachment', async () => {
    const h = handlers();
    await renderWithTheme(
      <FailedMessageSheet visible isFormatted retryAllowed={false} deliveryUnconfirmed {...h} />,
    );
    expect(screen.getByText('Formatted Message Status Unconfirmed')).toBeTruthy();
    expect(
      screen.getByText(
        'This formatted message may have been delivered. Check Messages before sending a new copy.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Attachment Status Unconfirmed')).toBeNull();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('truthfully labels a location rejected before dispatch and never offers Retry', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible isLocation retryAllowed={false} {...h} />);
    expect(screen.getByText('Location Not Sent')).toBeTruthy();
    expect(
      screen.getByText(
        'This location was not sent and cannot be retried. Start a new location share if needed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('keeps retired attachment copy distinct from a confirmed uncertain outcome', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible isAttachment retryAllowed={false} {...h} />);
    expect(screen.getByText('Attachment Needs Review')).toBeTruthy();
    expect(
      screen.getByText(
        'This attachment cannot be retried. Review this copy before sending another.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Attachment Status Unconfirmed')).toBeNull();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('Try Again fires onRetry then onClose', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible {...h} />);
    fireEvent.press(screen.getByText('Try Again'));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it('Delete fires onDelete then onClose', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible {...h} />);
    fireEvent.press(screen.getByText('Delete'));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onRetry).not.toHaveBeenCalled();
  });

  it('Cancel dismisses without retrying or deleting', async () => {
    const h = handlers();
    await renderWithTheme(<FailedMessageSheet visible {...h} />);
    fireEvent.press(screen.getByText('Cancel'));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onRetry).not.toHaveBeenCalled();
    expect(h.onDelete).not.toHaveBeenCalled();
  });
});
