/**
 * Bubble (src/ui/primitives/Bubble.tsx): the iOS message bubble. Colour contract per its own
 * comment — from-me iMessage = blue senderBackground, from-me SMS = green, from-me RCS = teal;
 * received always uses receivedBackgroundBottom regardless of service. Alignment flips on
 * isFromMe. Expected colours are the oled-dark (darkTheme) preset tokens.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { Bubble } from '@ui/primitives/Bubble';
import { darkTheme } from '@ui/theme/tokens';

const b = darkTheme.color.bubble;

/** Flattened style of the View wrapping the bubble text. */
function bubbleStyle(text: string): Record<string, unknown> {
  const view = screen.getByText(text).parent!;
  return StyleSheet.flatten(view.props.style) as Record<string, unknown>;
}

describe('Bubble', () => {
  it('renders the message text', async () => {
    await renderWithTheme(<Bubble text="hello there" isFromMe />);
    expect(screen.getByText('hello there')).toBeTruthy();
  });

  it('from-me iMessage bubble is blue and right-aligned', async () => {
    await renderWithTheme(<Bubble text="mine" isFromMe service="iMessage" />, {
      preset: 'oled-dark',
    });
    const style = bubbleStyle('mine');
    expect(style.backgroundColor).toBe(b.senderBackground);
    expect(style.alignSelf).toBe('flex-end');
  });

  it('from-me SMS bubble is green', async () => {
    await renderWithTheme(<Bubble text="sms" isFromMe service="SMS" />, { preset: 'oled-dark' });
    expect(bubbleStyle('sms').backgroundColor).toBe(b.smsBackground);
  });

  it('from-me RCS bubble is teal', async () => {
    await renderWithTheme(<Bubble text="rcs" isFromMe service="RCS" />, { preset: 'oled-dark' });
    expect(bubbleStyle('rcs').backgroundColor).toBe(b.rcsBackground);
  });

  it('received bubble ignores service colour and left-aligns', async () => {
    await renderWithTheme(<Bubble text="theirs" isFromMe={false} service="SMS" />, {
      preset: 'oled-dark',
    });
    const style = bubbleStyle('theirs');
    // Received uses the neutral received background even though service is SMS.
    expect(style.backgroundColor).toBe(b.receivedBackgroundBottom);
    expect(style.alignSelf).toBe('flex-start');
  });
});
