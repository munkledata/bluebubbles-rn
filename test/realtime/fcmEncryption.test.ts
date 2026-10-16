import {
  activeFcmPushKeyState,
  activeFcmDeviceEncryptionV3State,
  activeFcmDeviceEncryptionState,
  decodeFcmDeviceEncryptionKey,
  encodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_TYPE,
  FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
  FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  fcmPushDecryptionKeyCandidates,
  fcmPushKeyRotationDue,
  inspectFcmDeviceEncryptionState,
  pendingFcmPushKeyState,
  pendingFcmDeviceEncryptionV3State,
  pendingFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  rotatingFcmPushKeyState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';

const ORIGIN = 'https://gator.example';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NEXT_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const REQUESTED_AT = 1_700_000_000_000;
const ROTATION_ID = '44444444-4444-4444-8444-444444444444';
const V3_BINDING = {
  serverInstallationId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
} as const;

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
      pendingFcmDeviceEncryptionV3State(KEY, ORIGIN),
      activeFcmDeviceEncryptionV3State(KEY, V3_BINDING, ORIGIN),
      revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3),
      pendingFcmPushKeyState(KEY, ORIGIN, REQUESTED_AT),
      rotatingFcmPushKeyState(NEXT_KEY, KEY, 1, V3_BINDING, ORIGIN, ROTATION_ID, REQUESTED_AT),
      activeFcmPushKeyState(NEXT_KEY, 2, V3_BINDING, ORIGIN, REQUESTED_AT, {
        key: KEY,
        keyVersion: 1,
        expiresAt: REQUESTED_AT + 1_000,
      }),
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
      JSON.stringify({
        version: 1,
        encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        status: 'pending',
        origin: ORIGIN,
        key: KEY,
      }),
      JSON.stringify({
        ...activeFcmDeviceEncryptionV3State(KEY, V3_BINDING, ORIGIN),
        principalId: `A${V3_BINDING.principalId.slice(1)}`,
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

  it('requires exact canonical V3 enrollment identities', () => {
    expect(() =>
      activeFcmDeviceEncryptionV3State(
        KEY,
        { ...V3_BINDING, deviceId: '33333333-3333-3333-8333-333333333333' },
        ORIGIN,
      ),
    ).toThrow('invalid FCM device id');
  });

  it('keeps the previous key until a rotation is acknowledged, for at most one interval (M097)', () => {
    const rotating = rotatingFcmPushKeyState(
      NEXT_KEY,
      KEY,
      1,
      V3_BINDING,
      ORIGIN,
      ROTATION_ID,
      REQUESTED_AT,
    );
    const active = activeFcmPushKeyState(NEXT_KEY, 2, V3_BINDING, ORIGIN, REQUESTED_AT, {
      key: KEY,
      keyVersion: 1,
      expiresAt: REQUESTED_AT + 1_000,
    });
    const both = [
      { key: NEXT_KEY, role: 'current' },
      { key: KEY, role: 'previous' },
    ];
    const currentOnly = [{ key: NEXT_KEY, role: 'current' }];

    // Unacknowledged, the server may never have received NEXT_KEY and still encrypts with KEY, so
    // a day without an answer must not drop it.
    expect(
      fcmPushDecryptionKeyCandidates(rotating, REQUESTED_AT + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS),
    ).toEqual(both);
    expect(
      fcmPushDecryptionKeyCandidates(
        rotating,
        REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS - 1,
      ),
    ).toEqual(both);
    expect(
      fcmPushDecryptionKeyCandidates(rotating, REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS),
    ).toEqual(currentOnly);
    // A retry refreshes only requestedAt, so it cannot move the bound past the first attempt's.
    const agedRetry = rotatingFcmPushKeyState(
      NEXT_KEY,
      KEY,
      1,
      V3_BINDING,
      ORIGIN,
      ROTATION_ID,
      REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
      REQUESTED_AT,
    );
    expect(
      fcmPushDecryptionKeyCandidates(agedRetry, REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS),
    ).toEqual(currentOnly);
    // Once acknowledged, the server-bounded overlap applies instead.
    expect(fcmPushDecryptionKeyCandidates(active, REQUESTED_AT + 999)).toHaveLength(2);
    expect(fcmPushDecryptionKeyCandidates(active, REQUESTED_AT + 1_000)).toEqual(currentOnly);
  });

  it('rotates legacy V3 immediately and versioned keys at the fixed 30-day boundary', () => {
    const legacy = activeFcmDeviceEncryptionV3State(KEY, V3_BINDING, ORIGIN);
    const active = activeFcmPushKeyState(KEY, 1, V3_BINDING, ORIGIN, REQUESTED_AT);

    expect(fcmPushKeyRotationDue(legacy, REQUESTED_AT)).toBe(true);
    expect(
      fcmPushKeyRotationDue(active, REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS - 1),
    ).toBe(false);
    expect(fcmPushKeyRotationDue(active, REQUESTED_AT + FCM_PUSH_KEY_ROTATION_INTERVAL_MS)).toBe(
      true,
    );
  });
});
