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
});

describe('FailedMessageSheet — actions', () => {
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
