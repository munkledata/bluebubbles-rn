/**
 * ReplyQuote (src/ui/conversations/ReplyQuote.tsx) — the dimmed preview above a reply bubble.
 * Behaviors locked in (derived from the source):
 *   - "who": 'You' for a from-me original, else senderName, else 'Unknown'
 *   - "text": the preview text, else '📎 Attachment' when it has attachments, else empty
 *   - with onPress: role=button + a jump accessibilityLabel, and press fires the callback
 *   - without onPress: disabled, no button role/label
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { ReplyQuote } from '@ui/conversations/ReplyQuote';
import type { MessagePreview } from '@db/repositories';

function preview(over: Partial<MessagePreview> = {}): MessagePreview {
  return {
    guid: 'orig-1',
    text: 'original text',
    senderName: 'Dana',
    isFromMe: 0,
    hasAttachments: 0,
    ...over,
  };
}

describe('ReplyQuote who/text rendering', () => {
  it('shows the sender name and the quoted text for a received original', async () => {
    await renderWithTheme(
      <ReplyQuote
        preview={preview({ senderName: 'Dana', text: 'original text' })}
        isFromMe={false}
      />,
    );
    expect(screen.getByText('Dana')).toBeTruthy();
    expect(screen.getByText('original text')).toBeTruthy();
  });

  it("shows 'You' when the original message was from me", async () => {
    await renderWithTheme(<ReplyQuote preview={preview({ isFromMe: 1 })} isFromMe />);
    expect(screen.getByText('You')).toBeTruthy();
  });

  it("shows 'Unknown' when a received original has no sender name", async () => {
    await renderWithTheme(
      <ReplyQuote preview={preview({ isFromMe: 0, senderName: null })} isFromMe={false} />,
    );
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it("shows '📎 Attachment' when the original has no text but has attachments", async () => {
    await renderWithTheme(
      <ReplyQuote preview={preview({ text: null, hasAttachments: 1 })} isFromMe={false} />,
    );
    expect(screen.getByText('📎 Attachment')).toBeTruthy();
  });
});

describe('ReplyQuote tap-to-jump affordance', () => {
  it('exposes a button role + jump label and fires onPress when tapped', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <ReplyQuote preview={preview({ senderName: 'Dana' })} isFromMe={false} onPress={onPress} />,
    );
    const button = screen.getByRole('button');
    expect(button.props.accessibilityLabel).toBe('Reply to Dana. Tap to jump to the original.');
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is not a button (disabled, no jump label) when onPress is absent', async () => {
    await renderWithTheme(
      <ReplyQuote preview={preview({ senderName: 'Dana' })} isFromMe={false} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Reply to Dana. Tap to jump to the original.')).toBeNull();
  });
});
