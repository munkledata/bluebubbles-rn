import {
  activeFcmDeviceEncryptionState,
  decodeFcmDeviceEncryptionKey,
  encodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_TYPE,
  inspectFcmDeviceEncryptionState,
  pendingFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';

const ORIGIN = 'https://gator.example';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('FCM device-encryption contract', () => {
  it('encodes and decodes the server canonical 32-byte base64url key', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(encodeFcmDeviceEncryptionKey(bytes)).toBe(KEY);
    expect(decodeFcmDeviceEncryptionKey(KEY)).toEqual(bytes);
  });

  it.each([
    '',
    'short',
    `${KEY}=`,
    `${KEY.slice(0, -1)}+`,
    // Same decoded bytes under a lenient decoder, but non-zero unused base64url padding bits.
    `${KEY.slice(0, -1)}9`,
  ])('rejects malformed or noncanonical key %p', (candidate) => {
    expect(() => decodeFcmDeviceEncryptionKey(candidate)).toThrow(
      'invalid FCM device encryption key',
    );
  });

  it('round-trips pending, active, and keyless revoked records', () => {
    const states = [
      pendingFcmDeviceEncryptionState(KEY, ORIGIN),
      activeFcmDeviceEncryptionState(KEY, 'device-1', ORIGIN),
      revokedFcmDeviceEncryptionState(),
    ];

    for (const state of states) {
      expect(inspectFcmDeviceEncryptionState(serializeFcmDeviceEncryptionState(state))).toEqual({
        kind: 'valid',
        state,
      });
    }
    expect(serializeFcmDeviceEncryptionState(revokedFcmDeviceEncryptionState())).not.toContain(KEY);
  });

  it('distinguishes absence from every malformed present value', () => {
    expect(inspectFcmDeviceEncryptionState(null)).toEqual({ kind: 'absent' });
    const malformed = [
      '',
      'not-json',
      '{}',
      JSON.stringify({
        version: 1,
        encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
        status: 'pending',
        origin: ORIGIN,
        key: KEY,
        unexpected: true,
      }),
      JSON.stringify({
        version: 1,
        encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
        status: 'pending',
        origin: `${ORIGIN}/`,
        key: KEY,
      }),
      JSON.stringify({
        version: 1,
        encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
        status: 'active',
        origin: ORIGIN,
        key: `${KEY.slice(0, -1)}9`,
        deviceId: 'device-1',
      }),
      'x'.repeat(4_097),
    ];

    for (const stored of malformed) {
      expect(inspectFcmDeviceEncryptionState(stored)).toEqual({ kind: 'invalid' });
    }
  });

  it('requires a canonical origin and a bounded nonempty acknowledgement id', () => {
    expect(() => pendingFcmDeviceEncryptionState(KEY, `${ORIGIN}/`)).toThrow(
      'invalid FCM device encryption origin',
    );
    expect(() => activeFcmDeviceEncryptionState(KEY, '', ORIGIN)).toThrow('invalid FCM device id');
    expect(() => activeFcmDeviceEncryptionState(KEY, 'x'.repeat(257), ORIGIN)).toThrow(
      'invalid FCM device id',
    );
  });
});
