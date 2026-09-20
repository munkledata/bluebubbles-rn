import {
  acknowledgeCredentialUpgradePushAdoption,
  beginCredentialUpgradePushAdoption,
  createCredentialReplacementCandidate,
  createCredentialUpgradeCandidate,
  inspectCredentialUpgradeJournal,
  MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES,
  resolveCredentialUpgrade,
  revokedCredentialUpgradeJournal,
  serializeCredentialUpgradeJournal,
  type CredentialUpgradeFcmAdoptionAck,
  type CredentialUpgradeFcmRegistration,
  type CredentialUpgradeJournal,
} from '@core/secure';
import { FCM_DEVICE_ENCRYPTION_TYPE, FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';

const ORIGIN = 'https://gator.example';
const PREVIOUS_CREDENTIAL = 'legacy shared password';
const PREVIOUS_SCOPED_CREDENTIAL = `bbd_device_v1_${'B'.repeat(43)}`;
const CANDIDATE_CREDENTIAL = `bbd_device_v1_${'A'.repeat(43)}`;
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const V3_BINDING = {
  serverInstallationId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
};
const REGISTRATION: CredentialUpgradeFcmRegistration = {
  name: 'Gator (Android 36)',
  provider: 'fcm',
  token: 'current-fcm-token',
  pushEncryption: { type: FCM_DEVICE_ENCRYPTION_TYPE, key: KEY },
};
const V2_ACK: CredentialUpgradeFcmAdoptionAck = {
  id: 'device-1',
  pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
};
const V3_REGISTRATION: CredentialUpgradeFcmRegistration = {
  ...REGISTRATION,
  pushEncryption: { type: FCM_PUSH_ENCRYPTION_TYPE_V3, key: KEY },
};
const V3_ACK: CredentialUpgradeFcmAdoptionAck = {
  id: V3_BINDING.deviceId,
  pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
  pushEncryptionIdentity: V3_BINDING,
};

function states(
  registration: CredentialUpgradeFcmRegistration = REGISTRATION,
  ack: CredentialUpgradeFcmAdoptionAck = V2_ACK,
): {
  candidate: ReturnType<typeof createCredentialUpgradeCandidate>;
  adopting: ReturnType<typeof beginCredentialUpgradePushAdoption>;
  adopted: ReturnType<typeof acknowledgeCredentialUpgradePushAdoption>;
} {
  const candidate = createCredentialUpgradeCandidate(
    ORIGIN,
    PREVIOUS_CREDENTIAL,
    CANDIDATE_CREDENTIAL,
  );
  const adopting = beginCredentialUpgradePushAdoption(candidate, registration);
  const adopted = acknowledgeCredentialUpgradePushAdoption(adopting, ack);
  return { candidate, adopting, adopted };
}

describe('credential-upgrade durable journal', () => {
  it('round-trips canonical V2/V3 adoption and keyless revoked states', () => {
    const { candidate, adopting, adopted } = states();
    const v3 = states(V3_REGISTRATION, V3_ACK);
    for (const journal of [
      candidate,
      adopting,
      adopted,
      v3.adopting,
      v3.adopted,
      revokedCredentialUpgradeJournal(),
    ]) {
      expect(inspectCredentialUpgradeJournal(serializeCredentialUpgradeJournal(journal))).toEqual({
        kind: 'valid',
        journal,
      });
    }

    const revoked = serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal());
    expect(revoked).not.toContain(PREVIOUS_CREDENTIAL);
    expect(revoked).not.toContain(CANDIDATE_CREDENTIAL);
    expect(revoked).not.toContain(KEY);
  });

  it('preserves the exact registration target and permits only forward phase transitions', () => {
    const { candidate, adopting } = states();
    expect(adopting.registration).toEqual(REGISTRATION);
    expect(() => beginCredentialUpgradePushAdoption(adopting as never, REGISTRATION)).toThrow(
      'invalid credential-upgrade journal',
    );
    expect(() => acknowledgeCredentialUpgradePushAdoption(candidate as never, V2_ACK)).toThrow(
      'invalid credential-upgrade journal',
    );
  });

  it('round-trips V2 scoped replacement without changing V1 canonical bytes', () => {
    const replacement = createCredentialReplacementCandidate(
      ORIGIN,
      PREVIOUS_SCOPED_CREDENTIAL,
      CANDIDATE_CREDENTIAL,
    );
    const adopting = beginCredentialUpgradePushAdoption(replacement, V3_REGISTRATION);
    const adopted = acknowledgeCredentialUpgradePushAdoption(adopting, V3_ACK);

    expect(serializeCredentialUpgradeJournal(replacement)).toBe(
      JSON.stringify({
        version: 2,
        origin: ORIGIN,
        previousCredential: PREVIOUS_SCOPED_CREDENTIAL,
        candidateCredential: CANDIDATE_CREDENTIAL,
        phase: 'candidate',
      }),
    );
    for (const journal of [replacement, adopting, adopted]) {
      expect(inspectCredentialUpgradeJournal(serializeCredentialUpgradeJournal(journal))).toEqual({
        kind: 'valid',
        journal,
      });
    }
    expect(serializeCredentialUpgradeJournal(states().candidate)).toBe(
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        previousCredential: PREVIOUS_CREDENTIAL,
        candidateCredential: CANDIDATE_CREDENTIAL,
        phase: 'candidate',
      }),
    );
  });

  it('requires two different scoped bearers and V3 push adoption for V2 replacement', () => {
    expect(() =>
      createCredentialReplacementCandidate(ORIGIN, PREVIOUS_CREDENTIAL, CANDIDATE_CREDENTIAL),
    ).toThrow('invalid credential-upgrade journal');
    expect(() =>
      createCredentialReplacementCandidate(ORIGIN, CANDIDATE_CREDENTIAL, CANDIDATE_CREDENTIAL),
    ).toThrow('invalid credential-upgrade journal');
    const replacement = createCredentialReplacementCandidate(
      ORIGIN,
      PREVIOUS_SCOPED_CREDENTIAL,
      CANDIDATE_CREDENTIAL,
    );
    expect(() => beginCredentialUpgradePushAdoption(replacement, REGISTRATION)).toThrow(
      'invalid credential-upgrade journal',
    );
    expect(() =>
      acknowledgeCredentialUpgradePushAdoption(
        beginCredentialUpgradePushAdoption(replacement, V3_REGISTRATION),
        V2_ACK as never,
      ),
    ).toThrow('invalid credential-upgrade journal');
  });

  it('recovers each V2 boundary without promoting before acknowledged V3 adoption', () => {
    const candidate = createCredentialReplacementCandidate(
      ORIGIN,
      PREVIOUS_SCOPED_CREDENTIAL,
      CANDIDATE_CREDENTIAL,
    );
    const adopting = beginCredentialUpgradePushAdoption(candidate, V3_REGISTRATION);
    const adopted = acknowledgeCredentialUpgradePushAdoption(adopting, V3_ACK);
    const oldSession = { origin: ORIGIN, credential: PREVIOUS_SCOPED_CREDENTIAL };
    const newSession = { origin: ORIGIN, credential: CANDIDATE_CREDENTIAL };

    expect(
      resolveCredentialUpgrade(serializeCredentialUpgradeJournal(candidate), oldSession),
    ).toMatchObject({
      kind: 'resume-candidate',
      session: oldSession,
    });
    expect(
      resolveCredentialUpgrade(serializeCredentialUpgradeJournal(adopting), oldSession),
    ).toMatchObject({
      kind: 'retry-adoption',
      session: oldSession,
    });
    expect(
      resolveCredentialUpgrade(serializeCredentialUpgradeJournal(adopting), newSession),
    ).toEqual({
      kind: 'quarantined',
      reason: 'promotion-before-adoption',
    });
    expect(
      resolveCredentialUpgrade(serializeCredentialUpgradeJournal(adopted), oldSession),
    ).toMatchObject({
      kind: 'finish-promotion',
      session: newSession,
      writeMainCredential: true,
    });
    expect(
      resolveCredentialUpgrade(serializeCredentialUpgradeJournal(adopted), newSession),
    ).toMatchObject({
      kind: 'finish-promotion',
      session: newSession,
      writeMainCredential: false,
    });
  });

  it('requires the acknowledgement scheme and V3 identity to match the persisted request', () => {
    const v2Adopting = states().adopting;
    const v3Adopting = states(V3_REGISTRATION, V3_ACK).adopting;
    expect(() => acknowledgeCredentialUpgradePushAdoption(v2Adopting, V3_ACK)).toThrow(
      'invalid credential-upgrade journal',
    );
    expect(() => acknowledgeCredentialUpgradePushAdoption(v3Adopting, V2_ACK)).toThrow(
      'invalid credential-upgrade journal',
    );
    expect(() =>
      acknowledgeCredentialUpgradePushAdoption(v3Adopting, {
        ...V3_ACK,
        id: '44444444-4444-4444-8444-444444444444',
      }),
    ).toThrow('invalid credential-upgrade journal');
    expect(() =>
      acknowledgeCredentialUpgradePushAdoption(v3Adopting, {
        ...V3_ACK,
        pushEncryptionIdentity: {
          ...V3_BINDING,
          principalId: `A${V3_BINDING.principalId.slice(1)}`,
        },
      }),
    ).toThrow('invalid credential-upgrade journal');
  });

  it.each([
    { label: 'empty', stored: '' },
    { label: 'non-JSON', stored: 'not-json' },
    {
      label: 'missing fields',
      stored: JSON.stringify({ version: 1, phase: 'candidate' }),
    },
    {
      label: 'noncanonical origin',
      stored: JSON.stringify({
        version: 1,
        phase: 'candidate',
        origin: `${ORIGIN}/`,
        previousCredential: PREVIOUS_CREDENTIAL,
        candidateCredential: CANDIDATE_CREDENTIAL,
      }),
    },
    {
      label: 'malformed candidate',
      stored: JSON.stringify({
        version: 1,
        phase: 'candidate',
        origin: ORIGIN,
        previousCredential: PREVIOUS_CREDENTIAL,
        candidateCredential: 'bbd_device_v1_short',
      }),
    },
    {
      label: 'noncanonical V2 key',
      stored: JSON.stringify({
        version: 1,
        phase: 'adopting',
        origin: ORIGIN,
        previousCredential: PREVIOUS_CREDENTIAL,
        candidateCredential: CANDIDATE_CREDENTIAL,
        registration: {
          ...REGISTRATION,
          pushEncryption: { ...REGISTRATION.pushEncryption, key: `${KEY.slice(0, -1)}9` },
        },
      }),
    },
    {
      label: 'noncanonical JSON bytes',
      stored: `${serializeCredentialUpgradeJournal(states().candidate)} `,
    },
    {
      label: 'oversized character value',
      stored: 'x'.repeat(MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES + 1),
    },
    {
      label: 'oversized UTF-8 value',
      stored: 'é'.repeat(MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES / 2 + 1),
    },
  ])('rejects a present $label journal', ({ stored }) => {
    expect(inspectCredentialUpgradeJournal(stored)).toEqual({ kind: 'invalid' });
  });

  it('distinguishes an absent journal from every malformed present journal', () => {
    expect(inspectCredentialUpgradeJournal(null)).toEqual({ kind: 'absent' });
    expect(
      resolveCredentialUpgrade('', { origin: ORIGIN, credential: PREVIOUS_CREDENTIAL }),
    ).toEqual({ kind: 'quarantined', reason: 'invalid-journal' });
  });

  it.each([
    {
      boundary: 'before durable custody',
      journal: null,
      credential: PREVIOUS_CREDENTIAL,
      expected: { kind: 'none', session: { origin: ORIGIN, credential: PREVIOUS_CREDENTIAL } },
    },
    {
      boundary: 'after candidate custody',
      journal: serializeCredentialUpgradeJournal(states().candidate),
      credential: PREVIOUS_CREDENTIAL,
      expected: { kind: 'resume-candidate' },
    },
    {
      boundary: 'after request intent, including a lost response',
      journal: serializeCredentialUpgradeJournal(states().adopting),
      credential: PREVIOUS_CREDENTIAL,
      expected: { kind: 'retry-adoption' },
    },
    {
      boundary: 'after acknowledgement but before main credential write',
      journal: serializeCredentialUpgradeJournal(states().adopted),
      credential: PREVIOUS_CREDENTIAL,
      expected: {
        kind: 'finish-promotion',
        session: { origin: ORIGIN, credential: CANDIDATE_CREDENTIAL },
        writeMainCredential: true,
      },
    },
    {
      boundary: 'after main credential write but before journal cleanup',
      journal: serializeCredentialUpgradeJournal(states().adopted),
      credential: CANDIDATE_CREDENTIAL,
      expected: {
        kind: 'finish-promotion',
        session: { origin: ORIGIN, credential: CANDIDATE_CREDENTIAL },
        writeMainCredential: false,
      },
    },
    {
      boundary: 'after disconnect tombstones an unfinished upgrade',
      journal: serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal()),
      credential: PREVIOUS_CREDENTIAL,
      expected: { kind: 'revoked' },
    },
  ])('resolves the crash boundary $boundary', ({ journal, credential, expected }) => {
    expect(resolveCredentialUpgrade(journal, { origin: ORIGIN, credential })).toEqual(
      expect.objectContaining(expected),
    );
  });

  it.each([
    {
      case: 'candidate without its owning session',
      journal: () => states().candidate,
      session: null,
      reason: 'session-missing',
    },
    {
      case: 'candidate attached to another origin',
      journal: () => states().candidate,
      session: { origin: 'https://other.example', credential: PREVIOUS_CREDENTIAL },
      reason: 'origin-mismatch',
    },
    {
      case: 'candidate attached to another current credential',
      journal: () => states().candidate,
      session: { origin: ORIGIN, credential: 'different password' },
      reason: 'credential-mismatch',
    },
    {
      case: 'candidate promoted before adoption acknowledgement',
      journal: () => states().adopting,
      session: { origin: ORIGIN, credential: CANDIDATE_CREDENTIAL },
      reason: 'promotion-before-adoption',
    },
  ])('quarantines $case without selecting a credential', ({ journal, session, reason }) => {
    expect(resolveCredentialUpgrade(serializeCredentialUpgradeJournal(journal()), session)).toEqual(
      { kind: 'quarantined', reason },
    );
  });

  it('rejects extra fields at every nesting level instead of silently dropping them', () => {
    const { adopting } = states();
    expect(() =>
      serializeCredentialUpgradeJournal({
        ...adopting,
        unexpected: true,
      } as unknown as CredentialUpgradeJournal),
    ).toThrow('invalid credential-upgrade journal');
    expect(() =>
      serializeCredentialUpgradeJournal({
        ...adopting,
        registration: { ...adopting.registration, unexpected: true },
      } as unknown as CredentialUpgradeJournal),
    ).toThrow('invalid credential-upgrade journal');
  });

  it('returns immutable session snapshots from every successful recovery decision', () => {
    const mutableSession = { origin: ORIGIN, credential: PREVIOUS_CREDENTIAL };
    const resolution = resolveCredentialUpgrade(
      serializeCredentialUpgradeJournal(states().candidate),
      mutableSession,
    );
    expect(resolution.kind).toBe('resume-candidate');
    if (resolution.kind !== 'resume-candidate') throw new Error('unexpected resolution');
    expect(Object.isFrozen(resolution.session)).toBe(true);
    mutableSession.credential = 'changed afterward';
    expect(resolution.session.credential).toBe(PREVIOUS_CREDENTIAL);
  });
});
