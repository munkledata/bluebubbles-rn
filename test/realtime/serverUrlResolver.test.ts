/**
 * serverUrlResolver — the `refreshUrl` hook the composition root hands the socket's
 * reconnect escalation. Contract: consult the injected sources in order and return the
 * first VALID http(s) URL that DIFFERS from the origin the socket is currently trying;
 * return null when nothing new is known (→ the escalation retries the same origin).
 */
import {
  createServerUrlResolver,
  normalizeServerUrl,
  type ServerUrlSource,
} from '@/services/realtime/serverUrlResolver';

const source = (value: string | null | undefined): ServerUrlSource => ({
  name: 'test',
  get: () => value,
});

describe('normalizeServerUrl', () => {
  it('accepts a trimmed http(s) URL', () => {
    expect(normalizeServerUrl('https://srv.example')).toBe('https://srv.example');
    expect(normalizeServerUrl('  http://srv.example  ')).toBe('http://srv.example');
  });

  it('rejects empty, null, and non-http(s) values', () => {
    expect(normalizeServerUrl(null)).toBeNull();
    expect(normalizeServerUrl(undefined)).toBeNull();
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('ftp://srv.example')).toBeNull();
    expect(normalizeServerUrl('intent://evil')).toBeNull();
    expect(normalizeServerUrl('srv.example')).toBeNull();
  });
});

describe('createServerUrlResolver', () => {
  it('returns the stored URL when it differs from the one the socket is trying', async () => {
    const resolve = createServerUrlResolver([source('https://new.example')]);
    await expect(resolve('https://old.example')).resolves.toBe('https://new.example');
  });

  it('returns null when the stored URL matches the current one (nothing rotated)', async () => {
    const resolve = createServerUrlResolver([source('https://same.example')]);
    await expect(resolve('https://same.example')).resolves.toBeNull();
  });

  it('never returns an invalid or empty URL', async () => {
    const resolve = createServerUrlResolver([source(''), source('gator://x'), source(null)]);
    await expect(resolve('https://old.example')).resolves.toBeNull();
  });

  it('trims the stored URL before comparing/returning', async () => {
    const resolve = createServerUrlResolver([source('  https://new.example ')]);
    await expect(resolve('https://old.example')).resolves.toBe('https://new.example');
    await expect(resolve('https://new.example')).resolves.toBeNull();
  });

  it('skips a throwing source and falls through to the next one', async () => {
    const broken: ServerUrlSource = {
      name: 'broken',
      get: () => {
        throw new Error('boom');
      },
    };
    const resolve = createServerUrlResolver([broken, source('https://new.example')]);
    await expect(resolve('https://old.example')).resolves.toBe('https://new.example');
  });

  it('supports async sources (a future Firebase-RTDB lookup)', async () => {
    const asyncSource: ServerUrlSource = {
      name: 'rtdb',
      get: async () => 'https://moved.example',
    };
    const resolve = createServerUrlResolver([asyncSource]);
    await expect(resolve('https://old.example')).resolves.toBe('https://moved.example');
  });

  it('returns null with no sources', async () => {
    const resolve = createServerUrlResolver([]);
    await expect(resolve('https://old.example')).resolves.toBeNull();
  });
});
