import { readableTextOn } from './color';
import { normalizeHandleColor } from './models';

/** The letter-circle palette (used when no per-handle colour is saved). */
export const AVATAR_PALETTE: readonly string[] = [
  '#FF6B6B',
  '#FFA94D',
  '#FFD43B',
  '#69DB7C',
  '#4DABF7',
  '#9775FA',
  '#F783AC',
  '#3BC9DB',
];

/** A stable palette colour for a name: the same name always gets the same colour. */
export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!;
}

/**
 * The first LETTER (any script) of the first and last words. Punctuation, digits and emoji never
 * count, so "(555) 123-4567" or "+1 555…" no longer show "(5" or "+". Empty when the name has no
 * letters at all; the avatar then shows a person glyph instead.
 */
export function avatarInitials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean);
  if (letters.length === 0) return '';
  if (letters.length === 1) return letters[0]!.toUpperCase();
  return (letters[0]! + letters[letters.length - 1]!).toUpperCase();
}

/** What a letter circle shows: initials ('' = person glyph) on `background` in `foreground`. */
export interface AvatarLetterSpec {
  initials: string;
  background: string;
  foreground: string;
}

/**
 * The letter circle for a name and optional saved handle colour: the in-app Avatar and the
 * notification/Direct Share shortcut pictures both draw exactly this, so they can't drift apart.
 */
export function avatarLetterSpec(name: string, color?: string | null): AvatarLetterSpec {
  const background = normalizeHandleColor(color) ?? avatarColorFor(name);
  return { initials: avatarInitials(name), background, foreground: readableTextOn(background) };
}
