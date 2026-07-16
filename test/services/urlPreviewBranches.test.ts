/**
 * Branch top-ups for urlPreview.ts's IMPURE `fetchOgMetadata` (the SSRF-guarded network path,
 * not covered by ogParser.test/urlPreviewSsrf.test) plus the `absolutize` catch. Mocks the global
 * `fetch` in-file; each mock returns a minimal Response-shaped object the fetcher reads.
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
    const meta = await fetchOgMetadata('https://example.com/p');
    expect(meta).toMatchObject({ title: 'Hello', domain: 'example.com' });
  });

  it('rejects a private host before any fetch (SSRF guard)', async () => {
    expect(await fetchOgMetadata('http://localhost/x')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null for a non-HTML content type', async () => {
    mockFetch.mockResolvedValue(
      resp({ status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(await fetchOgMetadata('https://example.com')).toBeNull();
  });

  it('returns null for an oversized document (content-length cap)', async () => {
    mockFetch.mockResolvedValue(
      resp({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024) },
      }),
    );
    expect(await fetchOgMetadata('https://example.com')).toBeNull();
  });

  it('returns null on a non-ok status', async () => {
    mockFetch.mockResolvedValue(resp({ status: 500, headers: {} }));
    expect(await fetchOgMetadata('https://example.com')).toBeNull();
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
    const meta = await fetchOgMetadata('https://example.com/start');
    expect(meta).toMatchObject({ title: 'Hello' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect that points at a private host', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ status: 302, headers: { location: 'http://192.168.1.5/' } }),
    );
    expect(await fetchOgMetadata('https://example.com/start')).toBeNull();
  });

  it('returns null when a redirect has no Location header', async () => {
    mockFetch.mockResolvedValueOnce(resp({ status: 302, headers: {} }));
    expect(await fetchOgMetadata('https://example.com/start')).toBeNull();
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
    expect(await fetchOgMetadata('https://example.com/p')).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    expect(await fetchOgMetadata('https://example.com')).toBeNull();
  });
});

describe('parseOgMetadata absolutize fallback', () => {
  it('keeps the raw image src when the base url is unparseable', () => {
    const html = '<meta property="og:image" content="/pic.png">';
    const meta = parseOgMetadata(html, 'not-a-valid-url');
    expect(meta.image).toBe('/pic.png'); // new URL(src, badBase) threw → src returned as-is
  });
});
