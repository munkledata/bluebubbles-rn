/* eslint-disable import/first -- Jest must mock ESM-only ky before importing HttpClient. */
// ky is ESM-only; mock it so the shared response boundary is exercised under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { DEFAULT_MAX_JSON_RESPONSE_BYTES, HttpClient } from '@core/api/http';
import { z } from 'zod/v4';

const mockKy = ky as unknown as jest.Mock;

function envelope(data: unknown): string {
  return JSON.stringify({ status: 200, data });
}

function client(responseByteLimit = 256, timeoutMs = 30_000): HttpClient {
  return new HttpClient({
    getOrigin: () => 'https://server.example',
    getPassword: () => 'password',
    responseByteLimit,
    timeoutMs,
  });
}

beforeEach(() => {
  mockKy.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('HttpClient bounded JSON responses', () => {
  it('allows only tighter client-wide limits, never a cap-bypassing override', () => {
    expect(
      () =>
        new HttpClient({
          getOrigin: () => 'https://server.example',
          getPassword: () => 'password',
          responseByteLimit: DEFAULT_MAX_JSON_RESPONSE_BYTES + 1,
        }),
    ).toThrow(RangeError);
  });

  it('accepts a bounded streamed response with no Content-Length', async () => {
    const text = envelope({ ok: true });
    const response = new Response(text, {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.headers.get('content-length')).toBeNull();
    mockKy.mockResolvedValue(response);

    await expect(
      client(new TextEncoder().encode(text).byteLength).get('/bounded', z.unknown()),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects a lying small Content-Length when actual streamed bytes cross the cap', async () => {
    const response = new Response(envelope({ value: 'x'.repeat(200) }), {
      headers: { 'content-length': '1', 'content-type': 'application/json' },
    });
    mockKy.mockResolvedValue(response);

    await expect(client(64).get('/lying-length', z.unknown())).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response exceeded the safe size limit',
    });
    expect((mockKy.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('rejects an honestly over-limit Content-Length before reading its body', async () => {
    const response = new Response(envelope({ ok: true }), {
      headers: { 'content-length': '65', 'content-type': 'application/json' },
    });
    mockKy.mockResolvedValue(response);

    await expect(client(64).get('/declared-large', z.unknown())).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response exceeded the safe size limit',
    });
    expect((mockKy.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('counts UTF-8 bytes and preserves multibyte characters split across chunks or decode blocks', async () => {
    const text = envelope({ value: 'A界B' });
    const encoded = new TextEncoder().encode(text);
    expect(encoded.byteLength).toBeGreaterThan(text.length);
    const oneByteChunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    mockKy.mockResolvedValueOnce(
      new Response(oneByteChunks, { headers: { 'content-type': 'application/json' } }),
    );

    await expect(client(encoded.byteLength).get('/utf8', z.unknown())).resolves.toEqual({
      value: 'A界B',
    });

    const decodeBlockBytes = 64 * 1024;
    const boundaryPrefix = '{"status":200,"data":{"value":"';
    const filler = 'x'.repeat(decodeBlockBytes - 1 - boundaryPrefix.length);
    const boundaryText = `${boundaryPrefix}${filler}界B"}}`;
    const boundaryEncoded = new TextEncoder().encode(boundaryText);
    // The first byte of 界 lands at the end of one decode block; its remaining bytes land in the
    // next. This exercises the streaming decoder used by the bounded block coalescer.
    expect(boundaryEncoded.at(decodeBlockBytes - 1)).toBe(0xe7);
    mockKy.mockResolvedValueOnce(
      new Response(boundaryEncoded, { headers: { 'content-type': 'application/json' } }),
    );
    await expect(
      client(boundaryEncoded.byteLength).get('/utf8-block-boundary', z.unknown()),
    ).resolves.toEqual({ value: `${filler}界B` });

    mockKy.mockResolvedValueOnce(
      new Response(text, { headers: { 'content-type': 'application/json' } }),
    );
    await expect(client(encoded.byteLength - 1).get('/utf8', z.unknown())).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response exceeded the safe size limit',
    });
  });

  it('enforces a whole-body deadline after headers and aborts a stalled native request', async () => {
    jest.useFakeTimers();
    // A broken underlying cancel algorithm must not turn timeout cleanup into another hang.
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    mockKy.mockResolvedValue(
      new Response(stalledBody, { headers: { 'content-type': 'application/json' } }),
    );

    const result = client(256, 100).get('/stalled-body', z.unknown(), { retry: false });
    const rejection = expect(result).rejects.toMatchObject({
      kind: 'timeout',
      message: 'Response body timed out',
    });
    await jest.advanceTimersByTimeAsync(100);
    await rejection;

    expect((mockKy.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a stream that repeatedly emits empty chunks instead of making progress', async () => {
    let pulls = 0;
    const cancel = jest.fn();
    const emptyBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel,
    });
    mockKy.mockResolvedValue(
      new Response(emptyBody, { headers: { 'content-type': 'application/json' } }),
    );

    await expect(
      client().get('/empty-chunks', z.unknown(), { retry: false }),
    ).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response stream made no progress',
    });
    expect(pulls).toBeLessThan(20);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds total stream fragmentation even when every tiny chunk advances one byte', async () => {
    let pulls = 0;
    const cancel = jest.fn();
    const fragmentedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Uint8Array.of(0x20));
      },
      cancel,
    });
    mockKy.mockResolvedValue(
      new Response(fragmentedBody, { headers: { 'content-type': 'application/json' } }),
    );

    await expect(
      client(DEFAULT_MAX_JSON_RESPONSE_BYTES).get('/tiny-chunks', z.unknown(), { retry: false }),
    ).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response stream was too fragmented',
    });
    expect(pulls).toBeLessThan(20_000);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps malformed bounded JSON classified as a non-retryable parse error', async () => {
    mockKy.mockResolvedValue(
      new Response('{ definitely-not-json', {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(client().get('/malformed', z.unknown())).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response was not valid JSON',
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('accepts a normal 204 response only when the endpoint schema accepts no content', async () => {
    mockKy.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client().get('/empty', z.unknown())).resolves.toBeUndefined();
  });

  it('fails closed without invoking an unbounded text/json fallback when streaming is absent', async () => {
    const text = jest.fn(async () => envelope({ value: 'x'.repeat(1_000) }));
    const json = jest.fn(async () => ({ status: 200, data: { ok: true } }));
    mockKy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text,
      json,
    } as unknown as Response);

    await expect(client().get('/legacy-no-stream', z.unknown())).rejects.toMatchObject({
      kind: 'parse_error',
      message: 'Response body could not be read safely',
    });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('classifies an HTTP error without reading an attacker-controlled error body', async () => {
    const cancel = jest.fn(async () => undefined);
    const text = jest.fn(async () => 'huge proxy error');
    const json = jest.fn(async () => ({ message: 'huge proxy error' }));
    mockKy.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      body: { cancel },
      text,
      json,
    } as unknown as Response);

    await expect(
      client().get('/server-error', z.unknown(), { retry: false }),
    ).rejects.toMatchObject({
      kind: 'server_error',
      status: 500,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
