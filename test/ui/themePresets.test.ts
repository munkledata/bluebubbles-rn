import {
  darkTheme,
  DEFAULT_PRESET,
  gatorTheme,
  PRESET_ORDER,
  PRESETS,
  resolvePreset,
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
});
