import { buildDarkNavigationTheme, DARK_STATUS_BAR_STYLE } from '@ui/theme/dark-navigation-theme';

describe('dark-only root navigation appearance', () => {
  it('uses light system glyphs and an always-dark navigation base', () => {
    const theme = buildDarkNavigationTheme('#0B1A2B');
    expect(DARK_STATUS_BAR_STYLE).toBe('light');
    expect(theme.dark).toBe(true);
    expect(theme.colors.background).toBe('#0B1A2B');
    expect(theme.colors.card).toBe('#0B1A2B');
  });
});
