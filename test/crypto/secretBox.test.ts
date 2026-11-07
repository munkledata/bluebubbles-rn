import {
  CHUNKED_SECRET_BOX_CHUNK_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  ENVELOPE_VERSION,
  SecretBox,
} from '@core/crypto';
import { fromBase64, toBase64 } from '@utils/bytes';
import { createLibsodiumBackend } from '../support/libsodiumBackend';

describe('SecretBox (XChaCha20-Poly1305 + Argon2id)', () => {
  // Argon2id is intentionally slow; use the lightest params for tests.
  const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };

  it('seals and opens a round-trip', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const secret = 'super-secret-server-password';
    const sealed = await box.seal(secret, 'passphrase-123');
    expect(sealed).not.toContain(secret);
    const opened = await box.open(sealed, 'passphrase-123');
    expect(opened).toBe(secret);
  });

  it('fails to open with the wrong passphrase (authenticated)', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const sealed = await box.seal('payload', 'right-pass');
    await expect(box.open(sealed, 'wrong-pass')).rejects.toBeDefined();
  });

  it('rejects tampered ciphertext', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const sealed = await box.seal('payload', 'pass');
    const raw = fromBase64(sealed);
    const last = raw.length - 1;
    raw[last] = (raw[last]! ^ 0xff) & 0xff; // flip a ciphertext/tag bit
    const tampered = Buffer.from(raw).toString('base64');
    await expect(box.open(tampered, 'pass')).rejects.toBeDefined();
  });

  it('rejects one flipped ciphertext byte, salt byte or nonce byte, and leaks nothing', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const sealed = await box.seal('payload', 'pass');
    const parts = decodeEnvelope(sealed);
    const flipped = (mutate: (p: typeof parts) => void): string => {
      const copy = {
        salt: Uint8Array.from(parts.salt),
        nonce: Uint8Array.from(parts.nonce),
        body: Uint8Array.from(parts.body),
      };
      mutate(copy);
      return encodeEnvelope(copy);
    };
    const cases = [
      flipped((p) => void (p.body[0] = p.body[0]! ^ 0x01)), // first ciphertext byte, not the tag
      flipped((p) => void (p.salt[0] = p.salt[0]! ^ 0x01)), // key derivation input
      flipped((p) => void (p.nonce[0] = p.nonce[0]! ^ 0x01)), // AEAD nonce
    ];
    for (const tampered of cases) {
      const error: unknown = await box.open(tampered, 'pass').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain('payload');
    }
  });

  it('produces distinct ciphertext each time (fresh salt + nonce)', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const a = await box.seal('same', 'pass');
    const b = await box.seal('same', 'pass');
    expect(a).not.toBe(b);
    expect(decodeEnvelope(a).salt).not.toEqual(decodeEnvelope(b).salt);
  });

  it('writes a versioned envelope header', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const sealed = await box.seal('x', 'pass');
    const raw = fromBase64(sealed);
    expect(raw[0]).toBe(0x42); // 'B'
    expect(raw[1]).toBe(0x42); // 'B'
    expect(raw[2]).toBe(ENVELOPE_VERSION);
  });

  it('uses application-owned Argon2 costs; the envelope cannot supply attacker costs', async () => {
    const backend = await createLibsodiumBackend();
    const deriveKey = jest.spyOn(backend, 'deriveKey');
    const box = new SecretBox(backend, cheapArgon);
    const sealed = await box.seal('bounded payload', 'passphrase');
    await box.open(sealed, 'passphrase');

    expect(Object.keys(decodeEnvelope(sealed)).sort()).toEqual(['body', 'nonce', 'salt']);
    expect(deriveKey).toHaveBeenCalledTimes(2);
    for (const [params] of deriveKey.mock.calls) {
      expect(params).toEqual(expect.objectContaining(cheapArgon));
    }
  });
});

// I-5: BB2 frames authenticate their position, their final marker and the whole header (nonce
// counter plus AAD). Each forgery below passes the structural preflight, so the spy proves that
// authenticated decryption, not parsing, rejects it.
describe('SecretBox BB2 chunked envelope: authenticated frame binding', () => {
  const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };
  const LIMIT = 4 * CHUNKED_SECRET_BOX_CHUNK_BYTES;
  const MARKER = 'gator-plaintext-marker';

  async function boxWithDecryptSpy() {
    const backend = await createLibsodiumBackend();
    const decrypt = jest.spyOn(backend, 'aeadDecrypt');
    return { box: new SecretBox(backend, cheapArgon), decrypt };
  }

  async function expectAuthenticationFailure(
    box: SecretBox,
    decrypt: jest.SpyInstance,
    forged: string,
  ): Promise<void> {
    decrypt.mockClear();
    const error: unknown = await box.openChunked(forged, 'pass', LIMIT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(MARKER);
    expect(String((error as Error).message)).not.toContain('pass');
    // Parsing accepted the forgery; the first authenticated decryption threw.
    expect(decrypt).toHaveBeenCalledTimes(1);
    await expect(decrypt.mock.results[0]!.value).rejects.toBeDefined();
  }

  it('rejects two full frames swapped into each other position', async () => {
    const { box, decrypt } = await boxWithDecryptSpy();
    const plaintext = `${MARKER}${'a'.repeat(2 * CHUNKED_SECRET_BOX_CHUNK_BYTES)}`;
    const sealed = await box.sealChunked(plaintext, 'pass');
    const [magic, header, first, second, last] = sealed.split('.');
    expect(last).toBeDefined();
    expect(await box.openChunked(sealed, 'pass', LIMIT)).toBe(plaintext);

    await expectAuthenticationFailure(box, decrypt, [magic, header, second, first, last].join('.'));
  });

  it('rejects a truncated envelope whose header is rewritten to look complete', async () => {
    const { box, decrypt } = await boxWithDecryptSpy();
    const plaintext = `${MARKER}${'b'.repeat(CHUNKED_SECRET_BOX_CHUNK_BYTES)}`;
    const sealed = await box.sealChunked(plaintext, 'pass');
    const [magic, header, first, last] = sealed.split('.');
    expect(last).toBeDefined();

    // Drop the real final frame and claim exactly one full frame, so the first frame now parses
    // as the final one under a different header token.
    const headerBytes = fromBase64(header!);
    new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength).setUint32(
      headerBytes.length - 4,
      CHUNKED_SECRET_BOX_CHUNK_BYTES,
    );
    await expectAuthenticationFailure(
      box,
      decrypt,
      [magic, toBase64(headerBytes), first].join('.'),
    );
  });

  it('rejects one flipped tag byte in a frame', async () => {
    const { box, decrypt } = await boxWithDecryptSpy();
    const sealed = await box.sealChunked(`${MARKER} short`, 'pass');
    const parts = sealed.split('.');
    const frame = fromBase64(parts[2]!);
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 0x01;
    parts[2] = toBase64(frame);

    await expectAuthenticationFailure(box, decrypt, parts.join('.'));
  });
});
