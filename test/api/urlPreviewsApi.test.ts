import type { HttpClient } from '@core/api/http';
import { fetchUrlPreview } from '@core/api/endpoints/urlPreviews';

interface Parser {
  parse(value: unknown): unknown;
}

function parsedPost(value: unknown): jest.Mock {
  return jest.fn((_path: string, schema: Parser) =>
    Promise.resolve().then(() => schema.parse(value)),
  );
}

describe('URL preview endpoint', () => {
  const result = {
    url: 'https://example.com/final',
    title: 'Example title',
    description: 'Example description',
    siteName: 'Example',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  };

  it('uses the authenticated HttpClient boundary and forwards cancellation', async () => {
    const signal = new AbortController().signal;
    const post = parsedPost(result);
    const http = { post } as unknown as HttpClient;

    await expect(fetchUrlPreview(http, 'https://example.com/start', signal)).resolves.toEqual(
      result,
    );

    expect(post).toHaveBeenCalledWith('/url-preview', expect.anything(), {
      json: { url: 'https://example.com/start' },
      retry: false,
      signal,
    });
  });

  it.each([
    'file:///private/path',
    'https://user:secret@example.com/private',
    'https://example.com:8443/private',
    ' https://example.com',
  ])('rejects an unsafe request before contacting the configured server: %s', async (url) => {
    const post = parsedPost(result);
    const http = { post } as unknown as HttpClient;

    await expect(fetchUrlPreview(http, url)).rejects.toThrow('Invalid URL preview request');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    'https://cdn.example.com/image.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/gif;base64,R0lGODlh',
  ])('rejects non-proxied or executable image payloads: %s', async (imageDataUrl) => {
    const http = { post: parsedPost({ ...result, imageDataUrl }) } as unknown as HttpClient;

    await expect(fetchUrlPreview(http, 'https://example.com/start')).rejects.toBeDefined();
  });

  it('rejects unrecognized response fields instead of silently widening the contract', async () => {
    const http = {
      post: parsedPost({ ...result, unexpectedRemoteUrl: 'https://internal.example/secret' }),
    } as unknown as HttpClient;

    await expect(fetchUrlPreview(http, 'https://example.com/start')).rejects.toBeDefined();
  });

  it.each([
    { url: 'file:///private/path', title: result.title },
    { url: result.url, title: 'x'.repeat(301) },
  ])('rejects an unsafe final URL or oversized text metadata', async (malformed) => {
    const http = { post: parsedPost({ ...result, ...malformed }) } as unknown as HttpClient;

    await expect(fetchUrlPreview(http, 'https://example.com/start')).rejects.toBeDefined();
  });
});
