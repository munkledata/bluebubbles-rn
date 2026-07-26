/**
 * Branch top-ups for urlPreview.ts's IMPURE `fetchOgMetadata` (the SSRF-guarded network path,
 * not covered by ogParser.test/urlPreviewSsrf.test) plus the `absolutize` catch. Mocks the global
 * `fetch` in-file; each mock returns a minimal Response-shaped object the fetcher reads.
 *
 * Result kinds under test: `ok` (parsed), `empty` (definitive — negative-cached), `transient`
 * (retry later — NOT cached; 403/429/5xx bot-blocks and network errors land here).
 */
import { fetchOgMetadata, parseOgMetadata } from '@/services/urlPreview';

interface FakeResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers: Headers;
  text: () => Promise<string>;
}
function resp(init: {
  status: number;
  url?: string;
  headers?: Record<string, string>;
  text?: () => Promise<string>;
}): FakeResponse {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    url: init.url,
    headers: new Headers(init.headers ?? {}),
    text: init.text ?? (async () => ''),
  };
}

const HTML = '<html><head><meta property="og:title" content="Hello"><title>T</title></head></html>';
const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('fetchOgMetadata', () => {
  it('fetches a public HTML page and returns parsed OG metadata', async () => {
    mockFetch.mockResolvedValue(
      resp({
        status: 200,
        url: 'https://example.com/p',
        headers: { 'content-type': 'text/html' },
        text: async () => HTML,
      }),
    );
    const result = await fetchOgMetadata('https://example.com/p');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.meta).toMatchObject({ title: 'Hello', domain: 'example.com' });
    }
  });

  it('sends a real-browser User-Agent (bot-looking UAs get login walls → blank previews)', async () => {
    mockFetch.mockResolvedValue(
      resp({ status: 200, headers: { 'content-type': 'text/html' }, text: async () => HTML }),
    );
    await fetchOgMetadata('https://example.com');
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/Safari/);
    expect(headers['User-Agent']).not.toMatch(/Gator/);
  });

  it('rejects a private host before any fetch (SSRF guard) as a definitive empty', async () => {
    expect(await fetchOgMetadata('http://localhost/x')).toEqual({ kind: 'empty' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty for a non-HTML content type (definitive — this URL will never preview)', async () => {
    mockFetch.mockResolvedValue(
      resp({ status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(await fetchOgMetadata('https://example.com')).toEqual({ kind: 'empty' });
  });

  it('allows a page over the old 512KB limit (content-length is only a DoS guard now)', async () => {
    mockFetch.mockResolvedValue(
      resp({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(600 * 1024) },
        text: async () => HTML,
      }),
    );
    const result = await fetchOgMetadata('https://example.com');
    expect(result.kind).toBe('ok');
  });

  it('rejects an absurdly large document (>5MB content-length)', async () => {
    mockFetch.mockResolvedValue(
      resp({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) },
      }),
    );
    expect(await fetchOgMetadata('https://example.com')).toEqual({ kind: 'empty' });
  });

  it('treats an HTTP error status as transient (403/429 bot-blocks should retry, not cache)', async () => {
    mockFetch.mockResolvedValue(resp({ status: 403, headers: {} }));
    expect(await fetchOgMetadata('https://example.com')).toEqual({ kind: 'transient' });
    mockFetch.mockResolvedValue(resp({ status: 500, headers: {} }));
    expect(await fetchOgMetadata('https://example.com')).toEqual({ kind: 'transient' });
  });

  it('follows a redirect to another safe host and parses the final page', async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({ status: 302, headers: { location: 'https://example.org/final' } }),
      )
      .mockResolvedValueOnce(
        resp({
          status: 200,
          url: 'https://example.org/final',
          headers: { 'content-type': 'text/html' },
          text: async () => HTML,
        }),
      );
    const result = await fetchOgMetadata('https://example.com/start');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.meta).toMatchObject({ title: 'Hello' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect that points at a private host', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ status: 302, headers: { location: 'http://192.168.1.5/' } }),
    );
    expect(await fetchOgMetadata('https://example.com/start')).toEqual({ kind: 'empty' });
  });

  it('returns empty when a redirect has no Location header', async () => {
    mockFetch.mockResolvedValueOnce(resp({ status: 302, headers: {} }));
    expect(await fetchOgMetadata('https://example.com/start')).toEqual({ kind: 'empty' });
  });

  it('treats too many redirects as transient', async () => {
    mockFetch.mockResolvedValue(
      resp({ status: 302, headers: { location: 'https://example.com/loop' } }),
    );
    expect(await fetchOgMetadata('https://example.com/start')).toEqual({ kind: 'transient' });
  });

  it('re-validates the FINAL url host (device auto-follow guard) and rejects a private landing', async () => {
    mockFetch.mockResolvedValue(
      resp({
        status: 200,
        url: 'http://127.0.0.1/secret',
        headers: { 'content-type': 'text/html' },
        text: async () => HTML,
      }),
    );
    expect(await fetchOgMetadata('https://example.com/p')).toEqual({ kind: 'empty' });
  });

  it('returns transient when the fetch throws (offline/timeout)', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    expect(await fetchOgMetadata('https://example.com')).toEqual({ kind: 'transient' });
  });
});

describe('in-flight dedupe', () => {
  it('collapses concurrent lookups of the same URL into ONE outbound request', async () => {
    // Every link bubble's lookup lives in a reactive query subscribed to the whole url_previews
    // table, so a sibling preview resolving re-runs every still-unresolved hook — each of which
    // would otherwise start its own fetch of a URL that is already in flight.
    let release!: (r: FakeResponse) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<FakeResponse>((resolve) => {
        release = resolve;
      }),
    );

    const first = fetchOgMetadata('https://example.com/dedupe');
    const second = fetchOgMetadata('https://example.com/dedupe');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    release(
      resp({
        status: 200,
        url: 'https://example.com/dedupe',
        headers: { 'content-type': 'text/html' },
        text: async () => HTML,
      }),
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b); // the SAME promise, so both callers get the same result object
    expect(a.kind).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not share a result between DIFFERENT urls', async () => {
    mockFetch.mockResolvedValue(
      resp({ status: 200, headers: { 'content-type': 'text/html' }, text: async () => HTML }),
    );
    await Promise.all([
      fetchOgMetadata('https://example.com/a'),
      fetchOgMetadata('https://example.com/b'),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('releases the url once the fetch settles, so a later mount can retry', async () => {
    mockFetch.mockResolvedValue(resp({ status: 503, headers: {} }));
    expect(await fetchOgMetadata('https://example.com/retry')).toEqual({ kind: 'transient' });
    // A transient failure is deliberately not cached anywhere — if the in-flight entry leaked,
    // this URL could never be fetched again for the life of the JS context.
    expect(await fetchOgMetadata('https://example.com/retry')).toEqual({ kind: 'transient' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('parseOgMetadata absolutize fallback', () => {
  it('keeps the raw image src when the base url is unparseable', () => {
    const html = '<meta property="og:image" content="/pic.png">';
    const meta = parseOgMetadata(html, 'not-a-valid-url');
    expect(meta.image).toBe('/pic.png'); // new URL(src, badBase) threw → src returned as-is
  });
});
