import { decodeEnvelope, ENVELOPE_VERSION, SecretBox } from '@core/crypto';
import { fromBase64 } from '@utils/bytes';
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
});
