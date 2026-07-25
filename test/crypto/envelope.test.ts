import { CRYPTO_SIZES, decodeEnvelope, encodeEnvelope } from '@core/crypto';

function bytes(len: number, fill: number): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

describe('envelope', () => {
  const valid = {
    salt: bytes(CRYPTO_SIZES.salt, 1),
    nonce: bytes(CRYPTO_SIZES.nonce, 2),
    body: Uint8Array.from([9, 8, 7]),
  };

  it('encodes and decodes losslessly', () => {
    const decoded = decodeEnvelope(encodeEnvelope(valid));
    expect(Array.from(decoded.salt)).toEqual(Array.from(valid.salt));
    expect(Array.from(decoded.nonce)).toEqual(Array.from(valid.nonce));
    expect(Array.from(decoded.body)).toEqual(Array.from(valid.body));
  });

  it('rejects wrong salt/nonce sizes on encode', () => {
    expect(() => encodeEnvelope({ ...valid, salt: bytes(8, 1) })).toThrow(/salt/);
    expect(() => encodeEnvelope({ ...valid, nonce: bytes(8, 2) })).toThrow(/nonce/);
  });

  /**
   * The header is magic(2) + version(1) + salt(16) + nonce(24) = 43 bytes, and the LENGTH check
   * runs before the magic check. The previous version of this test passed 3-byte inputs for both
   * cases, so both tripped "envelope too short" and the magic/version branches were never
   * executed — a bare `.toThrow()` hid it. Each case below is ≥43 bytes so it reaches the branch
   * it names, and each asserts the specific message so it can't pass for the wrong reason.
   */
  const HEADER_LEN = 2 + 1 + CRYPTO_SIZES.salt + CRYPTO_SIZES.nonce;

  /** A well-formed-length buffer whose header bytes the caller can corrupt. */
  function frame(mutate: (b: Buffer) => void): string {
    const b = Buffer.alloc(HEADER_LEN + 3, 0);
    b[0] = 0x42; // 'B'
    b[1] = 0x42; // 'B'
    b[2] = 0x01; // version 1
    mutate(b);
    return b.toString('base64');
  }

  it('rejects input shorter than the header', () => {
    expect(() => decodeEnvelope(Buffer.from('AAAA').toString('base64'))).toThrow(/too short/);
    expect(() => decodeEnvelope(Buffer.alloc(HEADER_LEN - 1).toString('base64'))).toThrow(
      /too short/,
    );
  });

  it('rejects bad magic on a full-length frame', () => {
    // Long enough to clear the length check, so this genuinely exercises the magic branch.
    expect(() => decodeEnvelope(frame((b) => (b[0] = 0x41)))).toThrow(/magic/);
    expect(() => decodeEnvelope(frame((b) => (b[1] = 0x41)))).toThrow(/magic/);
  });

  /**
   * The version byte exists so the crypto can be rotated later. If this check regressed, a
   * future v2 envelope would be sliced with v1 offsets and the database key would decode to
   * garbage — silently, and unrecoverably.
   */
  it('rejects an unsupported version on a full-length frame with correct magic', () => {
    expect(() => decodeEnvelope(frame((b) => (b[2] = 0x02)))).toThrow(/version 2/);
    expect(() => decodeEnvelope(frame((b) => (b[2] = 0x09)))).toThrow(/version 9/);
  });

  it('accepts a full-length frame with correct magic and version', () => {
    // Guards the three negatives above: proves they fail on the corruption, not on the shape.
    expect(() => decodeEnvelope(frame(() => {}))).not.toThrow();
  });
});
