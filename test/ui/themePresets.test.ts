import {
  darkTheme,
  darkThemeOrFallback,
  DEFAULT_PRESET,
  gatorTheme,
  iosLightTheme,
  isDarkThemeTokens,
  PRESET_ORDER,
  PRESETS,
  resolvePreset,
  resolvePresetKey,
} from '@ui/theme/tokens';

describe('theme presets', () => {
  it('offers OLED Dark + Gator, but keeps the other definitions in the catalog (re-enableable)', () => {
    expect(PRESET_ORDER).toEqual(['oled-dark', 'gator']);
    expect(DEFAULT_PRESET).toBe('oled-dark');
    // Definitions stay in PRESETS so a theme can be re-enabled by adding its key to PRESET_ORDER.
    expect(PRESETS['nord']).toBeDefined();
    expect(PRESETS['ios-light']).toBeDefined();
    expect(PRESETS['bright-white']).toBeDefined();
  });

  it('keeps every currently enabled preset dark', () => {
    expect(PRESET_ORDER).not.toHaveLength(0);
    for (const key of PRESET_ORDER) expect(PRESETS[key].tokens.mode).toBe('dark');
    expect(PRESETS[DEFAULT_PRESET].tokens.mode).toBe('dark');
  });

  it('resolves the active preset key to its tokens', () => {
    expect(resolvePreset('oled-dark')).toBe(darkTheme);
    expect(resolvePreset('gator')).toBe(gatorTheme);
  });

  it('falls back to the default for unknown, empty, OR now-disabled keys', () => {
    expect(resolvePreset(undefined)).toBe(PRESETS[DEFAULT_PRESET].tokens);
    expect(resolvePreset('bogus')).toBe(PRESETS[DEFAULT_PRESET].tokens);
    expect(resolvePreset(null)).toBe(PRESETS[DEFAULT_PRESET].tokens);
    // A disabled preset (still in the catalog) resolves to the default OLED Dark, not its own tokens.
    expect(resolvePreset('nord')).toBe(darkTheme);
    expect(resolvePreset('ios-light')).toBe(darkTheme);
  });

  it('normalizes disabled persisted keys to the enabled default', () => {
    expect(resolvePresetKey('gator')).toBe('gator');
    expect(resolvePresetKey('ios-light')).toBe(DEFAULT_PRESET);
    expect(resolvePresetKey('bogus')).toBe(DEFAULT_PRESET);
  });

  it('contains legacy light tokens without deleting the dormant definitions', () => {
    expect(isDarkThemeTokens(iosLightTheme)).toBe(false);
    expect(darkThemeOrFallback(iosLightTheme, gatorTheme)).toBe(gatorTheme);
    expect(darkThemeOrFallback(gatorTheme, darkTheme)).toBe(gatorTheme);
    // THEME-01B groundwork remains in the catalog; it is simply not renderable today.
    expect(PRESETS['ios-light'].tokens).toBe(iosLightTheme);
  });
});
