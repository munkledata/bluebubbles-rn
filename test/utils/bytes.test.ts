import {
  concatBytes,
  fromBase64,
  timingSafeEqual,
  toBase64,
  utf8Decode,
  utf8Encode,
} from '@utils/bytes';

describe('bytes', () => {
  it('base64 round-trips and matches Node Buffer', () => {
    for (let len = 0; len < 64; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const b64 = toBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(fromBase64(b64))).toEqual(Array.from(bytes));
    }
  });

  it('decodes standard base64 produced by Buffer', () => {
    const original = Buffer.from('hello bluebubbles 🫧', 'utf8');
    const decoded = fromBase64(original.toString('base64'));
    expect(Buffer.from(decoded).toString('utf8')).toBe('hello bluebubbles 🫧');
  });

  it('utf8 round-trips', () => {
    const s = 'iMessage — café 🎉';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });

  it('concatBytes joins parts in order', () => {
    const out = concatBytes(Uint8Array.from([1, 2]), Uint8Array.from([]), Uint8Array.from([3]));
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('timingSafeEqual compares content and rejects length mismatch', () => {
    expect(timingSafeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]))).toBe(false);
  });
});
