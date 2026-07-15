import {
  cloneTokens,
  EDITABLE_COLORS,
  isValidHex,
  type EditableColorField,
} from '@ui/theme/editableTokens';
import { iosLightTheme, type ThemeTokens } from '@ui/theme/tokens';

/** The token path each editable key is expected to read/write (derived from source). */
const EXPECTED_PATH: Record<string, (t: ThemeTokens) => string> = {
  tint: (t) => t.color.tint,
  background: (t) => t.color.background,
  secondaryBackground: (t) => t.color.secondaryBackground,
  label: (t) => t.color.label,
  secondaryLabel: (t) => t.color.secondaryLabel,
  separator: (t) => t.color.separator,
  destructive: (t) => t.color.destructive,
  senderBackground: (t) => t.color.bubble.senderBackground,
  senderText: (t) => t.color.bubble.senderText,
  receivedBackgroundTop: (t) => t.color.bubble.receivedBackgroundTop,
  receivedBackgroundBottom: (t) => t.color.bubble.receivedBackgroundBottom,
  receivedText: (t) => t.color.bubble.receivedText,
  smsBackground: (t) => t.color.bubble.smsBackground,
  rcsBackground: (t) => t.color.bubble.rcsBackground,
};

/** Flatten a token tree into a map of dotted-path → leaf string, for deep-diffing. */
function flatten(node: unknown, prefix = ''): Record<string, unknown> {
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  return { [prefix]: node };
}

/** Paths whose leaf value differs between two token trees. */
function changedPaths(a: ThemeTokens, b: ThemeTokens): string[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  return [...keys].filter((k) => fa[k] !== fb[k]);
}

describe('EDITABLE_COLORS catalog', () => {
  it('every field has a unique key, a non-empty label, and read/write functions', () => {
    expect(EDITABLE_COLORS.length).toBeGreaterThan(0);
    const keys = EDITABLE_COLORS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
    for (const field of EDITABLE_COLORS) {
      expect(typeof field.key).toBe('string');
      expect(field.key.length).toBeGreaterThan(0);
      expect(typeof field.label).toBe('string');
      expect(field.label.length).toBeGreaterThan(0);
      expect(typeof field.read).toBe('function');
      expect(typeof field.write).toBe('function');
    }
  });

  it('every field key has a documented expected path (catalog matches the token tree)', () => {
    const keys = EDITABLE_COLORS.map((f) => f.key).sort();
    expect(keys).toEqual(Object.keys(EXPECTED_PATH).sort());
  });

  it('read() returns the exact token value at the field’s intended path', () => {
    for (const field of EDITABLE_COLORS) {
      const expectAt = EXPECTED_PATH[field.key]!;
      expect(field.read(iosLightTheme)).toBe(expectAt(iosLightTheme));
    }
  });

  it('every read() yields a valid hex colour from the base preset', () => {
    for (const field of EDITABLE_COLORS) {
      expect(isValidHex(field.read(iosLightTheme))).toBe(true);
    }
  });
});

describe('EDITABLE_COLORS read/write round-trips', () => {
  it('write() then read() returns the written value (round-trip)', () => {
    for (const field of EDITABLE_COLORS) {
      const clone = cloneTokens(iosLightTheme);
      field.write(clone, '#010203');
      expect(field.read(clone)).toBe('#010203');
    }
  });

  it('write() mutates ONLY the field’s own leaf, nothing else', () => {
    for (const field of EDITABLE_COLORS) {
      const clone = cloneTokens(iosLightTheme);
      field.write(clone, '#010203');
      const changed = changedPaths(iosLightTheme, clone);
      // Exactly one leaf changed, and it is the field's documented path.
      expect(changed.length).toBe(1);
      const expectAt = EXPECTED_PATH[field.key]!;
      expect(expectAt(clone)).toBe('#010203');
    }
  });

  it('write() does not mutate the shared source preset (operates on the clone)', () => {
    const field = EDITABLE_COLORS.find((f) => f.key === 'tint') as EditableColorField;
    const before = iosLightTheme.color.tint;
    const clone = cloneTokens(iosLightTheme);
    field.write(clone, '#FF00FF');
    expect(iosLightTheme.color.tint).toBe(before);
    expect(clone.color.tint).toBe('#FF00FF');
  });
});

describe('isValidHex', () => {
  it('accepts #RRGGBB and #RGB, case-insensitively', () => {
    expect(isValidHex('#1982FC')).toBe(true);
    expect(isValidHex('#abcdef')).toBe(true);
    expect(isValidHex('#ABC')).toBe(true);
    expect(isValidHex('#0f0')).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidHex('  #FFFFFF  ')).toBe(true);
  });

  it('rejects missing #, wrong length, and non-hex characters', () => {
    expect(isValidHex('1982FC')).toBe(false); // no leading #
    expect(isValidHex('#12345')).toBe(false); // 5 digits
    expect(isValidHex('#1234567')).toBe(false); // 7 digits
    expect(isValidHex('#GGGGGG')).toBe(false); // non-hex
    expect(isValidHex('#12G')).toBe(false);
    expect(isValidHex('')).toBe(false);
    expect(isValidHex('#')).toBe(false);
  });
});

describe('cloneTokens', () => {
  it('produces a structurally equal but independent deep copy', () => {
    const clone = cloneTokens(iosLightTheme);
    expect(clone).toEqual(iosLightTheme);
    expect(clone).not.toBe(iosLightTheme);
    expect(clone.color).not.toBe(iosLightTheme.color);
    expect(clone.color.bubble).not.toBe(iosLightTheme.color.bubble);
  });

  it('mutating the clone (including nested bubble colours) leaves the original untouched', () => {
    const clone = cloneTokens(iosLightTheme);
    clone.color.tint = '#000000';
    clone.color.bubble.senderBackground = '#000000';
    expect(iosLightTheme.color.tint).not.toBe('#000000');
    expect(iosLightTheme.color.bubble.senderBackground).not.toBe('#000000');
  });
});
