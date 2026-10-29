/** Strip everything but digits. "+1 (555) 123-4567" → "15551234567". */
export function digitsOnly(raw: string): string {
  return (raw ?? '').replace(/\D+/g, '');
}

/**
 * Match key for a phone: the last 10 digits (local-significant number), which
 * collapses country-code/formatting differences. Falls back to the full digit
 * string when shorter than 10. Pure + deterministic.
 */
export function phoneKey(raw: string): string {
  const d = digitsOnly(raw);
  return d.length > 10 ? d.slice(-10) : d;
}

/** Lowercased, trimmed email. */
export function emailKey(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/** Normalized match key for a handle address (email vs phone). */
export function handleKey(address: string): string {
  return address.includes('@') ? emailKey(address) : phoneKey(address);
}

/**
 * Type-scoped keys for automatic contact presentation. The prefix prevents malformed email data
 * such as "1234" from colliding with a phone key, and an empty normalized value never becomes a
 * shared key.
 */
export function contactPhoneMatchKey(raw: string): string {
  const key = phoneKey(raw);
  return key ? `phone:${key}` : '';
}

export function contactEmailMatchKey(raw: string): string {
  const key = emailKey(raw);
  return key ? `email:${key}` : '';
}

export function contactHandleMatchKey(address: string): string {
  return address.includes('@') ? contactEmailMatchKey(address) : contactPhoneMatchKey(address);
}

/**
 * The shortest national number the trunk-prefix fallback below will compare. Shorter strings are
 * short codes or fragments, and matching them by suffix would be guesswork.
 */
const MIN_NATIONAL_DIGITS = 6;

/**
 * Fallback key for a contact number saved in LOCAL national format with a single trunk `0`
 * ("0401 111 111" in Australia, "030 1234567" in Germany): the national number without that `0`.
 * The last-10-digits key misses these whenever the national number is shorter than ten digits,
 * because the handle's last ten digits then include part of its country code. Numbers written
 * internationally ("+61…", "0061…") and numbers without a trunk `0` (all of North America) get no
 * fallback key, so this can never change how they match.
 */
export function contactNationalMatchKey(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed.startsWith('+')) return '';
  const d = digitsOnly(trimmed);
  if (!d.startsWith('0') || d.startsWith('00')) return '';
  const national = d.slice(1);
  return national.length >= MIN_NATIONAL_DIGITS ? `national:${national}` : '';
}

/**
 * Candidate fallback keys for an international (+E.164) handle: its digits with a 1-, 2- or
 * 3-digit country code removed, because country codes are 1 to 3 digits long and the handle does
 * not say which. A real national number never starts with `0`, so such a candidate is dropped.
 * The caller accepts a match only when the candidates point at exactly one contact.
 */
export function contactHandleNationalMatchKeys(address: string): string[] {
  const trimmed = (address ?? '').trim();
  if (!trimmed.startsWith('+') || trimmed.includes('@')) return [];
  const d = digitsOnly(trimmed);
  // A North American (+1, ten-digit) number is exactly its last ten digits, which the exact key
  // already compares; a suffix guess could only link it to an unrelated foreign local number.
  if (d.length === 11 && d.startsWith('1')) return [];
  const keys: string[] = [];
  for (let codeLength = 1; codeLength <= 3; codeLength += 1) {
    const national = d.slice(codeLength);
    if (national.length < MIN_NATIONAL_DIGITS || national.startsWith('0')) continue;
    keys.push(`national:${national}`);
  }
  return keys;
}
