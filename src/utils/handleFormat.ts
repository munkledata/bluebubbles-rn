import { digitsOnly, handleKey } from './contactMatch';

/**
 * Pretty-print a handle address (phone number or email) for DISPLAY.
 *
 * Deliberately conservative — this is shown under a contact's name in the chat header, where a
 * mangled number is worse than an unformatted one. Only the two shapes we can be certain about are
 * reformatted (NANP 10-digit and 11-digit `1`-prefixed); everything else — emails, short codes,
 * international numbers, anything with letters — is returned trimmed but otherwise untouched.
 *
 * Pure: no locale/native dependency, so it runs in Node tests and the headless FCM context.
 */
export function formatHandleAddress(address: string | null | undefined): string {
  const raw = (address ?? '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw; // email — never reformat

  // A number we could reformat must be digits plus the usual separators, nothing else. A handle
  // like "AMAZON" or "GOOGLE-VERIFY" has to pass through as-is.
  if (!/^[+\d\s()\-.]+$/.test(raw)) return raw;

  const digits = digitsOnly(raw);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Short codes (e.g. "433768"), non-NANP international numbers, anything else: leave alone.
  return raw;
}

/**
 * True when `address` is effectively the same string already shown as the chat's title — i.e. the
 * contact isn't in the address book, so the "name" IS the number. Showing it twice (once as the
 * title, once as the subtitle) is noise, so the header suppresses the subtitle in that case.
 *
 * Compared on digits (phones) / lowercased text (everything else) so "(555) 123-4567" and
 * "+15551234567" count as the same thing.
 */
export function addressMatchesTitle(
  address: string | null | undefined,
  title: string | null | undefined,
): boolean {
  const a = (address ?? '').trim();
  const t = (title ?? '').trim();
  if (!a || !t) return false;
  if (a.includes('@') || t.includes('@')) return a.toLowerCase() === t.toLowerCase();
  const ad = digitsOnly(a);
  const td = digitsOnly(t);
  // Only treat two numbers as equal when both actually ARE numbers — a title with no digits at all
  // (a real name) must never match.
  if (!ad || !td) return a.toLowerCase() === t.toLowerCase();
  return ad === td || ad.slice(-10) === td.slice(-10);
}

/** Split the header row's `|||`-joined participant addresses into a list, dropping blanks. */
export function participantAddressList(joined: string | null | undefined): string[] {
  if (!joined) return [];
  return joined
    .split('|||')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * The ONE address to show under a 1:1 chat's title.
 *
 * Prefers the chat's own `chatIdentifier` when it really is one of the participants' handles — a
 * person reachable on both a number and an Apple ID has two handle rows, and the identifier names
 * the one this thread is actually keyed on (i.e. where a reply goes). Otherwise the first handle,
 * and finally the identifier alone (a chat whose handles haven't synced yet).
 *
 * Returns '' for anything that shouldn't get a subtitle, so callers can just test truthiness.
 */
export function primaryChatAddress(input: {
  chatIdentifier?: string | null;
  participantAddresses?: string | null;
}): string {
  const list = participantAddressList(input.participantAddresses);
  const id = (input.chatIdentifier ?? '').trim();
  // A group's chatIdentifier is a raw `chat<digits>` guid, never an address — reject it outright so
  // it can never leak into the header as if it were a phone number.
  const idIsAddress = id.length > 0 && !/^chat[0-9]+$/i.test(id);
  if (idIsAddress && list.some((a) => handleKey(a) === handleKey(id))) return id;
  return list[0] ?? (idIsAddress ? id : '');
}
