import { isCleartext, sanitizeServerAddress, ServerUrlResolver } from '@core/config';

describe('sanitizeServerAddress', () => {
  it('adds https:// when no scheme is provided', () => {
    expect(sanitizeServerAddress('abc.ngrok.io')).toBe('https://abc.ngrok.io');
  });

  it('preserves an explicit http scheme (LAN/IP opt-in handled elsewhere)', () => {
    expect(sanitizeServerAddress('http://192.168.1.10:1234')).toBe('http://192.168.1.10:1234');
  });

  it('strips paths, queries and trailing slashes down to the origin', () => {
    expect(sanitizeServerAddress('https://x.com/api/v1/?guid=abc')).toBe('https://x.com');
    expect(sanitizeServerAddress('https://x.com///')).toBe('https://x.com');
  });

  it('returns null for empty/invalid input', () => {
    expect(sanitizeServerAddress('')).toBeNull();
    expect(sanitizeServerAddress(null)).toBeNull();
    expect(sanitizeServerAddress('   ')).toBeNull();
  });

  it('flags cleartext origins', () => {
    expect(isCleartext('http://x')).toBe(true);
    expect(isCleartext('https://x')).toBe(false);
  });
});

describe('ServerUrlResolver', () => {
  it('saves a newly discovered origin when it differs from stored', async () => {
    let stored: string | null = 'https://old.example';
    const saveOrigin = jest.fn(async (o: string) => {
      stored = o;
    });
    const resolver = new ServerUrlResolver({
      getStoredOrigin: () => stored,
      fetchFromFirebase: async () => 'https://new.example',
      saveOrigin,
    });
    const result = await resolver.refresh();
    expect(result).toBe('https://new.example');
    expect(saveOrigin).toHaveBeenCalledWith('https://new.example');
  });

  it('does not re-save when the discovered origin is unchanged', async () => {
    const saveOrigin = jest.fn();
    const resolver = new ServerUrlResolver({
      getStoredOrigin: () => 'https://same.example',
      fetchFromFirebase: async () => 'same.example',
      saveOrigin,
    });
    await resolver.refresh();
    expect(saveOrigin).not.toHaveBeenCalled();
  });
});
