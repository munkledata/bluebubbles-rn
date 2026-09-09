import {
  decodeFcmPushEnvelopeIdentityV3,
  encodeFcmPushEnvelopeIdentityV3,
  FCM_PUSH_ENVELOPE_IDENTITY_VERSION,
  FCM_PUSH_ENVELOPE_MAX_LIFETIME_MS,
  FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES,
  FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES,
  type FcmPushEnvelopeIdentityV3,
} from '@core/realtime';
import { fromBase64, toBase64 } from '@utils/bytes';

interface PushIdentityFixture {
  readonly contract: string;
  readonly vectors: readonly {
    readonly name: string;
    readonly identity: FcmPushEnvelopeIdentityV3;
    readonly aadHex: string;
    readonly aadBase64: string;
  }[];
}

const fixture =
  require('../fixtures/contract/fcmPushEnvelopeIdentity.v3.json') as PushIdentityFixture;
const present = fixture.vectors.find((vector) => vector.name === 'message-present')!;
const absent = fixture.vectors.find((vector) => vector.name === 'message-absent')!;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function fieldOffset(bytes: Uint8Array, wantedTag: number): number {
  let offset = 10;
  while (offset < bytes.length) {
    const tag = bytes[offset]!;
    const length = (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
    if (tag === wantedTag) return offset;
    offset += 3 + length;
  }
  throw new Error(`fixture is missing field tag ${wantedTag}`);
}

describe('FCM V3 push identity contract', () => {
  it('matches the server fixture byte for byte in both directions', () => {
    expect(fixture.contract).toBe('AEAD_GCM_V3_IDENTITY additional authenticated data');
    for (const vector of fixture.vectors) {
      const encoded = encodeFcmPushEnvelopeIdentityV3(vector.identity);
      expect(hex(encoded)).toBe(vector.aadHex);
      expect(toBase64(encoded)).toBe(vector.aadBase64);
      expect(encoded).toEqual(fromBase64(vector.aadBase64));
      expect(decodeFcmPushEnvelopeIdentityV3(encoded)).toEqual(vector.identity);
      expect(encodeFcmPushEnvelopeIdentityV3(decodeFcmPushEnvelopeIdentityV3(encoded))).toEqual(
        encoded,
      );
    }
  });

  it('enforces exact text and lifetime bounds', () => {
    expect(() =>
      encodeFcmPushEnvelopeIdentityV3({
        ...present.identity,
        eventType: `a${'b'.repeat(FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES - 1)}`,
        messageId: 'm'.repeat(FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES),
        expiresAt: present.identity.issuedAt + FCM_PUSH_ENVELOPE_MAX_LIFETIME_MS,
      }),
    ).not.toThrow();

    for (const invalid of [
      { ...present.identity, eventType: '' },
      { ...present.identity, eventType: 'New-Message' },
      {
        ...present.identity,
        eventType: `a${'b'.repeat(FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES)}`,
      },
      { ...present.identity, messageId: '' },
      {
        ...present.identity,
        messageId: 'm'.repeat(FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES + 1),
      },
      { ...present.identity, messageId: '\ud800' },
      { ...present.identity, issuedAt: -1 },
      { ...present.identity, expiresAt: present.identity.issuedAt },
      {
        ...present.identity,
        expiresAt: present.identity.issuedAt + FCM_PUSH_ENVELOPE_MAX_LIFETIME_MS + 1,
      },
    ]) {
      expect(() => encodeFcmPushEnvelopeIdentityV3(invalid)).toThrow();
    }
  });

  it('requires four canonical lowercase version-4 UUIDs', () => {
    for (const key of [
      'serverInstallationId',
      'principalId',
      'deviceId',
      'occurrenceId',
    ] as const) {
      expect(() =>
        encodeFcmPushEnvelopeIdentityV3({
          ...present.identity,
          [key]: `A${present.identity[key].slice(1)}`,
        }),
      ).toThrow();
      expect(() =>
        encodeFcmPushEnvelopeIdentityV3({
          ...present.identity,
          [key]: '11111111-1111-1111-8111-111111111111',
        }),
      ).toThrow();
    }
  });

  it('rejects message-presence disagreement and noncanonical fields', () => {
    const presentBytes = encodeFcmPushEnvelopeIdentityV3(present.identity);
    const falseAbsent = Uint8Array.from(presentBytes);
    falseAbsent[fieldOffset(presentBytes, 6) + 3] = 0;
    expect(() => decodeFcmPushEnvelopeIdentityV3(falseAbsent)).toThrow();

    const absentBytes = encodeFcmPushEnvelopeIdentityV3(absent.identity);
    const falsePresent = Uint8Array.from(absentBytes);
    falsePresent[fieldOffset(absentBytes, 6) + 3] = 1;
    expect(() => decodeFcmPushEnvelopeIdentityV3(falsePresent)).toThrow();

    const mutations = [
      presentBytes.subarray(0, presentBytes.length - 1),
      Uint8Array.from([...presentBytes, 0]),
      Uint8Array.from(presentBytes),
      Uint8Array.from(presentBytes),
      Uint8Array.from(presentBytes),
    ];
    mutations[2]![9] = 10;
    mutations[3]![10] = 99;
    mutations[4]![fieldOffset(presentBytes, 2)] = 1;
    for (const mutation of mutations) {
      expect(() => decodeFcmPushEnvelopeIdentityV3(mutation)).toThrow();
    }
  });

  it('keeps the public version literal pinned', () => {
    expect(present.identity.version).toBe(FCM_PUSH_ENVELOPE_IDENTITY_VERSION);
  });
});
