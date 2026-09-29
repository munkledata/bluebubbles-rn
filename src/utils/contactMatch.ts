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
