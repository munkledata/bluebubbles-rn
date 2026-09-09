import { createCipheriv } from 'node:crypto';
import { encodeFcmPushEnvelopeIdentityV3, type FcmPushEnvelopeIdentityV3 } from '@core/realtime';
import { toBase64 } from '@utils/bytes';
import { decryptFcmV2Payload, decryptFcmV3Payload } from '@/services/notifications/fcmDecrypt';

// Fixed vector independently generated from the server's Node AES-256-GCM contract.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const EVENT_TYPE = 'message-send-error';
const PLAINTEXT = '{"guid":"p:0/vector","tempGuid":"temp-vector","attemptGuid":"attempt-vector"}';
const FRAME =
  'AqChoqOkpaanqKmqq+QI+6+GdLqJg9K3heHSQF6dOhtYLK8ghUAVveMoDKW9BMMrMr6VNgnxfmHzFs9XO/ACIpLfDyVYPOhruitWoZgzbyMlEqRdCyg6KWSGEfHE0dH1Gx3TgYOAjY068g==';
const V3_IDENTITY: FcmPushEnvelopeIdentityV3 = {
  version: 3,
  eventType: 'new-message',
  serverInstallationId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
  occurrenceId: '44444444-4444-4444-8444-444444444444',
  messageId: 'p:0/vector',
  issuedAt: 1_788_912_000_000,
  expiresAt: 1_788_912_300_000,
};

function v3Frame(plaintext: string): string {
  const aad = Buffer.from(encodeFcmPushEnvelopeIdentityV3(V3_IDENTITY));
  const iv = Buffer.alloc(12, 0x3c);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64url'), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const aadLength = Buffer.alloc(2);
  aadLength.writeUInt16BE(aad.length);
  return Buffer.concat([
    Buffer.from([0x03]),
    aadLength,
    aad,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64');
}

describe('FCM V2 decryption', () => {
  it('decrypts the fixed server-compatible vector', async () => {
    await expect(decryptFcmV2Payload(FRAME, KEY, EVENT_TYPE)).resolves.toBe(PLAINTEXT);
  });

  it.each([
    ['wrong key', `${KEY.slice(0, -1)}4`, EVENT_TYPE, FRAME],
    ['changed AAD event', KEY, 'new-message', FRAME],
  ])('rejects %s', async (_label, key, eventType, frame) => {
    await expect(decryptFcmV2Payload(frame, key, eventType)).rejects.toThrow();
  });

  it.each([
    ['version', 0],
    ['IV', 1],
    ['tag', 13],
    ['ciphertext', 29],
  ])('rejects a tampered %s byte', async (_label, byteIndex) => {
    const bytes = Uint8Array.from(Buffer.from(FRAME, 'base64'));
    bytes[byteIndex] = bytes[byteIndex]! ^ 0x01;
    await expect(decryptFcmV2Payload(toBase64(bytes), KEY, EVENT_TYPE)).rejects.toThrow();
  });

  it.each([FRAME.slice(0, -1), ` ${FRAME}`, `${FRAME}\n`, `${FRAME.slice(0, -3)}h==`])(
    'rejects malformed or noncanonical standard base64',
    async (frame) => {
      await expect(decryptFcmV2Payload(frame, KEY, EVENT_TYPE)).rejects.toThrow(
        'malformed FCM V2 frame encoding',
      );
    },
  );

  it('rejects short and oversized frames before native decryption', async () => {
    await expect(
      decryptFcmV2Payload(toBase64(new Uint8Array(28)), KEY, EVENT_TYPE),
    ).rejects.toThrow('FCM V2 frame too short');
    await expect(
      decryptFcmV2Payload(toBase64(new Uint8Array(4_097)), KEY, EVENT_TYPE),
    ).rejects.toThrow('malformed FCM V2 frame encoding');
  });

  it.each(['', 'x'.repeat(257)])('rejects an invalid event-type AAD bound', async (eventType) => {
    await expect(decryptFcmV2Payload(FRAME, KEY, eventType)).rejects.toThrow(
      'invalid FCM V2 event type',
    );
  });

  it('rejects authenticated plaintext that is not valid UTF-8', async () => {
    const iv = Buffer.alloc(12, 0x5a);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64url'), iv);
    cipher.setAAD(Buffer.from(EVENT_TYPE, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from([0xc3, 0x28])), cipher.final()]);
    const frame = Buffer.concat([Buffer.from([0x02]), iv, cipher.getAuthTag(), ciphertext]);

    await expect(decryptFcmV2Payload(frame.toString('base64'), KEY, EVENT_TYPE)).rejects.toThrow(
      'FCM V2 plaintext is not valid UTF-8',
    );
  });
});

describe('FCM V3 identity-bound decryption', () => {
  const plaintext = '{"guid":"p:0/vector","text":"hello"}';

  it('authenticates the canonical identity header and plaintext together', async () => {
    await expect(decryptFcmV3Payload(v3Frame(plaintext), KEY, 'new-message')).resolves.toEqual({
      plaintext,
      identity: V3_IDENTITY,
    });
  });

  it('rejects an outer-type mismatch and ciphertext tampering', async () => {
    const frame = v3Frame(plaintext);
    await expect(decryptFcmV3Payload(frame, KEY, 'updated-message')).rejects.toThrow(
      'outer event type',
    );

    const tampered = Uint8Array.from(Buffer.from(frame, 'base64'));
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(decryptFcmV3Payload(toBase64(tampered), KEY, 'new-message')).rejects.toThrow();
  });
});
