/**
 * Literal URL classification retained for inert, server-supplied preview metadata. This module
 * deliberately performs no network request. A future preview transport must independently resolve
 * and pin public addresses before connecting; string checks cannot prevent DNS rebinding.
 *
 * Private/reserved IPv4 classification is shared by plain IPv4 and the IPv4-mapped IPv6 forms.
 */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // this-network, loopback, private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * The IPv4 embedded in an IPv4-mapped/-translated IPv6 host, or null.
 *
 * MUST handle BOTH spellings. `new URL('http://[::ffff:127.0.0.1]')` normalizes the host to
 * the HEX form `[::ffff:7f00:1]` under a spec-compliant parser, but React Native ships its own
 * URL implementation, so the dotted form can survive to this function on device. Matching only
 * one spelling is how `[::ffff:127.0.0.1]` used to walk through the retired fetcher's literal-host
 * guard.
 */
function mappedIpv4(h: string): [number, number] | null {
  // Dotted: ::ffff:127.0.0.1 (and the ::ffff:0:127.0.0.1 translated form).
  const dotted = /^::ffff:(?:0:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) return [Number(dotted[1]), Number(dotted[2])];
  // Hex: ::ffff:7f00:1 — the two 16-bit groups hold the four IPv4 octets.
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    return [(hi >> 8) & 0xff, hi & 0xff];
  }
  return null;
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  )
    return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return isPrivateIpv4(Number(m[1]), Number(m[2]));
  const mapped = mappedIpv4(h);
  if (mapped) return isPrivateIpv4(mapped[0], mapped[1]);
  if (h === '::1' || h === '::') return true; // IPv6 loopback / unspecified
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  return false;
}

/**
 * Whether `raw` has an eligible HTTP(S) scheme, standard port, and non-private literal host.
 * This is suitable only for inert metadata filtering; it does not authorize a network request.
 */
export function isSafePreviewUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; // only http(s)
  if (u.port && u.port !== '80' && u.port !== '443') return false; // standard web ports only
  return !isPrivateHost(u.hostname);
}
