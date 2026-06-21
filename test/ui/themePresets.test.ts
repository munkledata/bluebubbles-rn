import { darkTheme, DEFAULT_PRESET, PRESETS, resolvePreset } from '@ui/theme/tokens';

describe('theme presets', () => {
  it('resolves a known preset key to its tokens', () => {
    expect(resolvePreset('oled-dark')).toBe(darkTheme);
    expect(resolvePreset('nord').color.tint).toBe('#88C0D0');
    expect(resolvePreset('ios-light').color.background).toBe('#FFFFFF');
  });

  it('falls back to the default preset for unknown/empty keys', () => {
    expect(resolvePreset(undefined)).toBe(PRESETS[DEFAULT_PRESET].tokens);
    expect(resolvePreset('bogus')).toBe(PRESETS[DEFAULT_PRESET].tokens);
    expect(resolvePreset(null)).toBe(PRESETS[DEFAULT_PRESET].tokens);
  });
});
