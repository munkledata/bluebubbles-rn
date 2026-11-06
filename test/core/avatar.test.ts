import { AVATAR_PALETTE, avatarColorFor, avatarInitials, avatarLetterSpec } from '@core/avatar';

describe('avatar letter rules', () => {
  it('takes the first letter of the first and last words, in any script', () => {
    expect(avatarInitials('Jordan Lee')).toBe('JL');
    expect(avatarInitials('  ana maría de la cruz ')).toBe('AC');
    expect(avatarInitials('Élodie')).toBe('É');
    expect(avatarInitials('(555) 123-4567')).toBe('');
    expect(avatarInitials('+1 555 0100')).toBe('');
    expect(avatarInitials('🙂 Sam')).toBe('S');
    expect(avatarInitials('')).toBe('');
  });

  it('gives a name the same palette colour every time', () => {
    expect(avatarColorFor('Jordan Lee')).toBe(avatarColorFor('Jordan Lee'));
    expect(AVATAR_PALETTE).toContain(avatarColorFor('Jordan Lee'));
    expect(AVATAR_PALETTE).toContain(avatarColorFor(''));
  });

  it('prefers a saved handle colour and picks readable text', () => {
    expect(avatarLetterSpec('Jordan Lee', '#ffffff')).toEqual({
      initials: 'JL',
      background: '#FFFFFF',
      foreground: '#111111',
    });
    expect(avatarLetterSpec('Jordan Lee', '#000000').foreground).toBe('#FFFFFF');
    // A malformed saved colour falls back to the palette, never passes through.
    expect(avatarLetterSpec('Jordan Lee', 'red').background).toBe(avatarColorFor('Jordan Lee'));
    // Every palette background is the 6-digit #RRGGBB form the native drawer accepts.
    for (const c of AVATAR_PALETTE) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });
});
