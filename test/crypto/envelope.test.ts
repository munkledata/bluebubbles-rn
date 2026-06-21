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

  it('rejects bad magic and short input on decode', () => {
    expect(() => decodeEnvelope(Buffer.from('AAAA').toString('base64'))).toThrow();
    expect(() => decodeEnvelope(Buffer.from([0x00, 0x00, 0x01]).toString('base64'))).toThrow();
  });
});
