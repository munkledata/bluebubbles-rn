/**
 * Pure, React-free display helpers for device-SMS addresses.
 *
 * SMS addresses arrive from the Telephony provider RAW (as the carrier stored
 * them) — a phone number, a short code, or occasionally an email gateway. These
 * helpers only normalize presentation; they never mutate the address used for
 * matching/sending (that stays the raw provider value).
 */

/**
 * Pretty-print an SMS address for display. North-American phone numbers get
 * `(AAA) BBB-CCCC` grouping (with a leading `+1` for the 11-digit form); short
 * codes, emails, and any unrecognized shape are returned trimmed as-is. Pure +
 * deterministic — safe for Node tests and the headless layer.
 */
export function formatSmsAddress(address: string): string {
  const raw = (address ?? '').trim();
  // Emails (rare SMS gateways) and empty values pass through untouched.
  if (!raw || raw.includes('@')) return raw;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  // Short codes (e.g. "262966") and international numbers we can't confidently
  // group are shown verbatim rather than mangled.
  return raw;
}
