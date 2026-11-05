/**
 * Pure helpers for the chat-details contact actions (Copy, Call, Email). A participant address is
 * server-controlled, so every link built here is strict: only digits (and one leading +) reach a
 * `tel:` link, and only a plain single-@ address with no URL syntax reaches a `mailto:` link.
 */

export type MemberAddressKind = 'phone' | 'email' | 'other';

/** The fewest digits treated as a dialable number; shorter ones are carrier and business short codes. */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15; // E.164's maximum length
const PHONE_SHAPE = /^\+?[0-9 ().-]+$/;
// One "@", a dotted domain, and none of the characters that could add mailto headers or a second
// recipient (?, &, =, #, %, comma, semicolon) or break out of the address (<, >, quotes, spaces).
const EMAIL_SHAPE =
  /^[^\s@<>()[\],;:"'?&=#%\\]+@[^\s@<>()[\],;:"'?&=#%\\]+\.[^\s@<>()[\],;:"'?&=#%\\]+$/;

function phoneDigits(address: string): string | null {
  const trimmed = address.trim();
  if (!PHONE_SHAPE.test(trimmed)) return null;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** What kind of address this is: a dialable phone number, an email address, or neither. */
export function memberAddressKind(address: string): MemberAddressKind {
  if (phoneDigits(address) !== null) return 'phone';
  return EMAIL_SHAPE.test(address.trim()) ? 'email' : 'other';
}

/** A `tel:` link for a dialable phone number, or null. */
export function telUrlForAddress(address: string): string | null {
  const digits = phoneDigits(address);
  return digits === null ? null : `tel:${digits}`;
}

/** A `mailto:` link for a plain email address, or null. */
export function mailtoUrlForAddress(address: string): string | null {
  const trimmed = address.trim();
  return EMAIL_SHAPE.test(trimmed) ? `mailto:${trimmed}` : null;
}
