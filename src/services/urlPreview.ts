export interface OgMetadata {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  domain: string;
}

const META_RE = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?>/gi;
const CONTENT_RE = /content\s*=\s*["']([^"']*)["']/i;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function absolutize(src: string, base: string): string {
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

/**
 * PURE: parse Open Graph / Twitter card meta tags (+ <title> fallback) from raw
 * HTML. No network — given HTML, return metadata. Node-testable.
 */
export function parseOgMetadata(html: string, url: string): OgMetadata {
  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep raw url */
  }
  const out: OgMetadata = { domain };

  META_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_RE.exec(html)) !== null) {
    const key = m[1]!.toLowerCase();
    const c = CONTENT_RE.exec(m[0]);
    if (!c) continue;
    const val = decode(c[1]!);
    if (!val) continue;
    if (key === 'og:title' || (key === 'twitter:title' && !out.title)) out.title = val;
    else if (key === 'og:description' || (key === 'twitter:description' && !out.description))
      out.description = val;
    else if (
      key === 'og:image' ||
      key === 'og:image:url' ||
      (key === 'twitter:image' && !out.image)
    )
      out.image = absolutize(val, url);
    else if (key === 'og:site_name') out.siteName = val;
  }
  if (!out.title) {
    const t = TITLE_RE.exec(html);
    if (t) out.title = decode(t[1]!);
  }
  return out;
}

const MAX_BYTES = 512 * 1024; // parse-window: OG tags live in <head>, well inside this
const HARD_CAP_BYTES = 5 * 1024 * 1024; // DoS guard only — header may be absent or compressed size
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/**
 * Outcome of a preview fetch. The split matters for caching:
 * - `ok`        → cache the metadata (success TTL)
 * - `empty`     → definitive "this URL will never preview" (unsafe target, non-HTML,
 *                 oversized) → negative-cache briefly
 * - `transient` → network error, timeout, or an HTTP error status (403/429 are usually
 *                 bot-blocks that clear on retry) → cache NOTHING so the next mount retries
 */
export type OgFetchResult =
  | { kind: 'ok'; meta: OgMetadata }
  | { kind: 'empty' }
  | { kind: 'transient' };

/**
 * SSRF guard: true if `hostname` is a private/loopback/link-local/internal address. The
 * link preview is fetched from a URL inside a RECEIVED message, so a sender must not be
 * able to make the recipient device hit internal endpoints (cloud metadata at
 * 169.254.169.254, 192.168.x, localhost, …). NOTE: this checks the literal hostname only —
 * DNS rebinding (a public name resolving to a private IP) is not catchable from JS fetch.
 */
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
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-network, loopback, private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h === '::1' || h === '::') return true; // IPv6 loopback / unspecified
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  return false;
}

/** True if `raw` is a safe PUBLIC http(s) URL (allowed scheme + port, non-private host). */
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

/**
 * IMPURE: securely fetch a URL and parse its OG metadata. http(s) only, HTML only,
 * size/time-capped, with an SSRF guard validating the host on EVERY redirect hop (manual
 * redirects). Returns an {@link OgFetchResult} so the caller can cache definitive failures
 * but retry transient ones. Does NOT use the Gator HttpClient, so the server auth header
 * never leaks to third-party sites.
 */
export async function fetchOgMetadata(url: string): Promise<OgFetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isSafePreviewUrl(current)) return { kind: 'empty' }; // SSRF: private/odd-port/non-http(s)
      const r = await fetch(current, {
        signal: ac.signal,
        redirect: 'manual', // follow manually so each hop is re-validated
        headers: {
          // A real mobile-browser UA: sites serve bot-looking UAs a login wall/empty shell,
          // which is what made previews blank. This client IS a phone, so the UA is honest.
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return { kind: 'empty' }; // malformed redirect — retrying won't help
        try {
          current = new URL(loc, current).toString();
        } catch {
          return { kind: 'empty' };
        }
        continue;
      }
      res = r;
      break;
    }
    if (!res) return { kind: 'transient' }; // too many redirects (loops sometimes resolve later)
    if (!res.ok) return { kind: 'transient' }; // 403/429/5xx: often a bot-block or hiccup — retry later
    // On device RN auto-follows redirects (it ignores `redirect: 'manual'`), so the per-hop
    // re-validation above may not run — re-check the FINAL URL's host here so a redirect can't
    // land the fetch on a private/internal address.
    if (res.url && !isSafePreviewUrl(res.url)) return { kind: 'empty' };
    const ctype = res.headers.get('content-type') ?? '';
    // Only parse HTML(-ish) documents. xhtml+xml is HTML-shaped and safe to regex; other
    // content types (json/images/pdf) are rejected so we never mis-parse binary as HTML.
    if (!ctype.includes('text/html') && !ctype.includes('application/xhtml+xml'))
      return { kind: 'empty' };
    if (Number(res.headers.get('content-length') ?? '0') > HARD_CAP_BYTES)
      return { kind: 'empty' }; // absurdly large — the parse slice below is the real cap
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { kind: 'ok', meta: parseOgMetadata(html, current) };
  } catch {
    return { kind: 'transient' }; // network error / timeout
  } finally {
    clearTimeout(timer);
  }
}
