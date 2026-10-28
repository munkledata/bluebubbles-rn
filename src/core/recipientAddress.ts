/**
 * One standard form for a recipient that someone typed or picked in New Message. Start sends to
 * it, and the search for an existing chat compares it (FEAT-06 §3, routing purpose).
 *
 * - **Email:** trimmed and lowercased.
 * - **Phone with a country code** (`+…`): spaces, dashes, dots and parentheses removed, giving
 *   E.164.
 * - **Phone without a country code:** the owner's region rule (2026-10-27) is North America. Ten
 *   digits that don't start with 0 or 1 get `+1`, and eleven digits starting with `1` get `+`.
 * - **Anything else is `null`:** short codes, other countries' local formats, extensions and
 *   names can't be proven. The caller keeps the exact text and offers no inferred existing chat.
 *
 * Use it only on typed or picked input. A number already stored in a chat is compared exactly:
 * giving a stored `5550000034` a `+1` would treat two separate conversations as one (FEAT-06
 * fixture `local-number-without-region`).
 */
export function canonicalRecipientAddress(raw: string): string | null {
  // Invisible format marks (direction marks, zero-width spaces) ride along with pasted and
  // address-book numbers, and are never part of an address.
  const text = raw.replace(FORMAT_CHARACTERS, '').trim();
  if (text.length === 0) return null;
  if (text.includes('@')) {
    return text.length <= MAX_EMAIL_LENGTH && EMAIL.test(text) ? text.toLowerCase() : null;
  }
  // "+44 (0)20…" marks a domestic-only 0 that E.164 drops; guessing which digit that is fails.
  if (!PHONE_TEXT.test(text) || text.includes('(0)')) return null;
  const digits = text.replace(/\D/gu, '');
  if (text.startsWith('+')) return E164_DIGITS.test(digits) ? `+${digits}` : null;
  if (NORTH_AMERICAN_TEN_DIGITS.test(digits)) return `+1${digits}`;
  if (digits.startsWith('1') && NORTH_AMERICAN_TEN_DIGITS.test(digits.slice(1))) {
    return `+${digits}`;
  }
  return null;
}

const FORMAT_CHARACTERS = /\p{Cf}/gu;
const MAX_EMAIL_LENGTH = 254;
/** Text on both sides of one `@` and a dot in the domain; the server is the real validator. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
/** Digits and the usual separators, with at most one `+` at the front: no letters or `;ext=`. */
const PHONE_TEXT = /^\+?[\d\s().-]+$/u;
/** E.164 without its `+`: a country code that doesn't start with 0, at most 15 digits in all. */
const E164_DIGITS = /^[1-9]\d{1,14}$/u;
/** A North American number: an area code that doesn't start with 0 or 1, then seven digits. */
const NORTH_AMERICAN_TEN_DIGITS = /^[2-9]\d{9}$/u;
