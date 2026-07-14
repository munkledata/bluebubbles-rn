/**
 * ServiceBadge (src/ui/primitives/ServiceBadge.tsx): a decorative pill that labels a
 * conversation's non-iMessage service. Expected colours come from the preset tokens in
 * src/ui/theme/tokens.ts (oled-dark = darkTheme). The service SEMANTICS this badge exists to
 * surface are defined by resolveChatService in src/utils/chat.ts (SMS/RCS/iMessage), so the
 * labels asserted here mirror what a caller would pass for each service.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { ServiceBadge } from '@ui/primitives/ServiceBadge';
import { darkTheme } from '@ui/theme/tokens';

// The badge marks itself accessibilityElementsHidden / no-hide-descendants (it's decorative),
// so RNTL's default `includeHiddenElements: false` won't match its text — opt those in here.
const HIDDEN = { includeHiddenElements: true } as const;

/** The badge's fill colour, read off the wrapping View that holds the label. */
function badgeBackground(label: string): string | undefined {
  const view = screen.getByText(label, HIDDEN).parent!;
  return StyleSheet.flatten(view.props.style)?.backgroundColor;
}

describe('ServiceBadge', () => {
  it('renders the given label text', async () => {
    await renderWithTheme(<ServiceBadge label="RCS" />);
    expect(screen.getByText('RCS', HIDDEN)).toBeTruthy();
  });

  it("defaults to the theme's RCS teal fill", async () => {
    await renderWithTheme(<ServiceBadge label="RCS" />, { preset: 'oled-dark' });
    expect(badgeBackground('RCS')).toBe(darkTheme.color.bubble.rcsBackground);
  });

  it('honours an explicit color override', async () => {
    await renderWithTheme(<ServiceBadge label="SMS" color="#123456" />);
    expect(badgeBackground('SMS')).toBe('#123456');
  });

  it('is hidden from accessibility (the adjacent title already announces the chat)', async () => {
    await renderWithTheme(<ServiceBadge label="RCS" />);
    const view = screen.getByText('RCS', HIDDEN).parent!;
    expect(view.props.accessibilityElementsHidden).toBe(true);
    expect(view.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
