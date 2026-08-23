const mockDigest = jest.fn();

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (...args: unknown[]) => mockDigest(...args),
}));

import { expoDigestBackend } from '@/services/realtime/expoDigestBackend';

describe('expoDigestBackend', () => {
  beforeEach(() => {
    mockDigest.mockReset();
  });

  it('passes an exact Uint8Array copy to the SDK 57 native digest bridge', async () => {
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const slicedInput = new Uint8Array(backing.buffer, 1, 3);
    mockDigest.mockResolvedValue(new Uint8Array([7, 8, 9]).buffer);

    const result = await expoDigestBackend.sha256(slicedInput);

    expect(mockDigest).toHaveBeenCalledTimes(1);
    expect(mockDigest.mock.calls[0]?.[0]).toBe('SHA-256');
    const nativeInput = mockDigest.mock.calls[0]?.[1];
    expect(nativeInput).toBeInstanceOf(Uint8Array);
    expect(nativeInput).not.toBe(slicedInput);
    expect(Array.from(nativeInput as Uint8Array)).toEqual([1, 2, 3]);
    expect(Array.from(result)).toEqual([7, 8, 9]);
  });
});
