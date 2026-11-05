/**
 * `imessage:` links from other apps ("Message us" buttons, contact pages). Gator registers the
 * scheme (app.config.ts), and this turns `imessage:<address>`, `imessage://<address>` and an
 * optional `?body=<text>` (or BlueBubbles' `&body=` spelling) into the New Message route with that
 * recipient and text filled in. Nothing is sent: the person still reviews and taps Start.
 *
 * The link comes from any app on the phone, so it is treated as untrusted: one address only,
 * bounded lengths, no control characters, and anything malformed is ignored.
 */

const MAX_LINK_LENGTH = 4096;
const MAX_ADDRESS_LENGTH = 254;
const MAX_BODY_LENGTH = 2000;
const SCHEME_RE = /^imessage:(?:\/\/)?/i;
// Control characters (NUL..US, DEL), never part of a real address or a typed message.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%2B'));
  } catch {
    return null;
  }
}

/** Loose shape check; New Message validates the chip again before anything is sent. */
function plausibleAddress(address: string): boolean {
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return false;
  // One recipient only: a comma/semicolon list is refused rather than half-used.
  if (CONTROL_RE.test(address) || /[,;]/.test(address)) return false;
  if (address.includes('@')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);
  return /^[+\d\s()./-]+$/.test(address) && address.replace(/\D/g, '').length >= 7;
}

function bodyFrom(query: string): string | null {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).toLowerCase() !== 'body') continue;
    // In a query string `+` means a space.
    const value = safeDecode(part.slice(eq + 1).replace(/\+/g, ' '));
    if (value == null) return null;
    const body = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
    return body.trim() ? body.slice(0, MAX_BODY_LENGTH) : null;
  }
  return null;
}

/** The New Message path for an `imessage:` link, or null when the link isn't one we accept. */
export function newChatPathForIMessageLink(url: string): string | null {
  if (typeof url !== 'string' || url.length > MAX_LINK_LENGTH || !SCHEME_RE.test(url)) return null;
  const rest = url.replace(SCHEME_RE, '');
  const split = rest.search(/[?&]/);
  const rawAddress = split < 0 ? rest : rest.slice(0, split);
  const query = split < 0 ? '' : rest.slice(split + 1);
  const address = safeDecode(rawAddress)?.trim();
  if (!address || !plausibleAddress(address)) return null;
  const body = bodyFrom(query);
  return `/new-chat?to=${encodeURIComponent(address)}${
    body ? `&body=${encodeURIComponent(body)}` : ''
  }`;
}
