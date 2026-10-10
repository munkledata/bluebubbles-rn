import { HEX_COLOR_PATTERN } from '@core/color';
import { parseThemeTokensJson } from '@core/themeTokens';
import { contrastRatio, generateAdaptiveTokens, readableTextOn } from '@ui/theme/adaptiveFromImage';
import { isValidHex } from '@ui/theme/editableTokens';
import { darkTheme, lightTheme, safeParseTokens } from '@ui/theme/tokens';

const withTint = (tint: unknown): string =>
  JSON.stringify({ ...darkTheme, color: { ...darkTheme.color, tint } });

describe('stored theme-token validation', () => {
  it('accepts the built-in presets and every app-generated adaptive theme', () => {
    expect(safeParseTokens(JSON.stringify(darkTheme))).toEqual(darkTheme);
    expect(safeParseTokens(JSON.stringify(lightTheme))).toEqual(lightTheme);
    for (const seed of ['#1982FC', '#000000', '#FFFFFF', '#7F7F7F', '#E91E63']) {
      for (const mode of ['dark', 'light'] as const) {
        const generated = generateAdaptiveTokens(seed, mode);
        expect(safeParseTokens(JSON.stringify(generated))).toEqual(generated);
      }
    }
  });

  it.each([
    ['an empty blob', ''],
    ['corrupt JSON', '{not json'],
    ['no colour block', '{"mode":"dark"}'],
    ['an rgb() colour', withTint('rgb(25,130,252)')],
    ['a named colour', withTint('red')],
    ['an 8-digit hex colour', withTint('#1982FCFF')],
    ['a colour without #', withTint('1982FC')],
    ['a missing colour', withTint(undefined)],
    ['an unknown mode', JSON.stringify({ ...darkTheme, mode: 'sepia' })],
    [
      'a non-numeric size',
      JSON.stringify({ ...darkTheme, spacing: { ...darkTheme.spacing, md: '12' } }),
    ],
  ])('rejects %s', (_label, json) => {
    expect(parseThemeTokensJson(json)).toBeNull();
    expect(safeParseTokens(json)).toBeNull();
  });

  it('returns a valid blob exactly as stored, extra keys included', () => {
    expect(safeParseTokens(JSON.stringify({ ...darkTheme, studio: { version: 2 } }))).toEqual({
      ...darkTheme,
      studio: { version: 2 },
    });
  });

  it('uses the same colour rule as the theme editor', () => {
    for (const sample of ['#fff', '#FFFFFF', '#1982fc', 'fff', '#ffff', '#1982FCFF', 'red', '']) {
      expect(HEX_COLOR_PATTERN.test(sample)).toBe(isValidHex(sample));
    }
  });
});

describe('contrast helpers on a bad colour', () => {
  it('score an unparseable colour as no contrast instead of throwing', () => {
    expect(contrastRatio('#FFFFFF', 'rgb(25,130,252)')).toBe(1);
    expect(contrastRatio(undefined as unknown as string, '#000000')).toBe(1);
  });

  it('readableTextOn falls back to near-white and is unchanged for real colours', () => {
    expect(readableTextOn('rgb(25,130,252)')).toBe('#FFFFFF');
    expect(readableTextOn(undefined as unknown as string)).toBe('#FFFFFF');
    expect(readableTextOn('#000000')).toBe('#FFFFFF');
    expect(readableTextOn('#FFFFFF')).toBe('#111111');
  });
});
