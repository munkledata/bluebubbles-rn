import {
  acknowledgeCredentialUpgradePushAdoption,
  beginCredentialUpgradePushAdoption,
  createCredentialUpgradeCandidate,
  InMemoryVault,
  inspectCredentialUpgradeJournal,
  serializeCredentialUpgradeJournal,
  SERVER_SESSION_STATE,
  type CredentialUpgradeFcmRegistration,
  type CredentialUpgradeFcmV3AdoptionAck,
  type SecretKey,
} from '@core/secure';
import { FCM_DEVICE_ENCRYPTION_TYPE, FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';
import {
  beginCredentialUpgradeRuntime,
  discardCredentialUpgradeCandidateRuntime,
  resumeCredentialUpgradeRuntime,
  type CredentialUpgradeRuntimeDependencies,
} from '@/services/credentialUpgradeRuntime';

const ORIGIN = 'https://gator.example';
const PREVIOUS = 'legacy shared password';
const CANDIDATE = `bbd_device_v1_${'A'.repeat(43)}`;
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const REGISTRATION: CredentialUpgradeFcmRegistration = {
  name: 'Gator (Android 36)',
  provider: 'fcm',
  token: 'current-fcm-token',
  pushEncryption: { type: FCM_PUSH_ENCRYPTION_TYPE_V3, key: KEY },
};
const ACK: CredentialUpgradeFcmV3AdoptionAck = {
  id: '33333333-3333-4333-8333-333333333333',
  pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
  pushEncryptionIdentity: {
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
  },
};

class RecordingVault extends InMemoryVault {
  readonly events: string[] = [];

  override async set(key: SecretKey, value: string): Promise<void> {
    if (key === 'serverCredentialUpgrade') {
      const inspected = inspectCredentialUpgradeJournal(value);
      this.events.push(
        inspected.kind === 'valid' ? `journal:${inspected.journal.phase}` : 'journal:invalid',
      );
    } else if (key === 'serverPassword') {
      this.events.push('main-credential');
    }
    await super.set(key, value);
  }

  override async delete(key: SecretKey): Promise<void> {
    if (key === 'serverCredentialUpgrade') this.events.push('journal:delete');
    await super.delete(key);
  }
}

async function activeVault(): Promise<RecordingVault> {
  const vault = new RecordingVault();
  await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
  await vault.set('serverAddress', ORIGIN);
  await vault.set('serverPassword', PREVIOUS);
  vault.events.length = 0;
  return vault;
}

function dependencies(
  vault: RecordingVault,
  overrides: Partial<CredentialUpgradeRuntimeDependencies> = {},
): CredentialUpgradeRuntimeDependencies {
  let active = false;
  return {
    vault,
    isCurrent: () => true,
    beginExclusiveTransition: () => {
      vault.events.push('exclusive');
      return true;
    },
    fetchCandidateServerInfo: async () => {
      vault.events.push('candidate-info');
      return {
        server_version: '2.0.0',
        supports_scoped_device_credentials: true,
        supports_fcm_push_encryption_v3: true,
      };
    },
    prepareV3Registration: async () => {
      vault.events.push('prepare-v3');
      return REGISTRATION;
    },
    persistPendingV3: async () => {
      vault.events.push('fcm:pending');
    },
    registerV3: async () => {
      vault.events.push('server:adopt');
      return ACK;
    },
    persistActiveV3: async () => {
      vault.events.push('fcm:active');
      active = true;
    },
    activeV3Matches: async () => {
      vault.events.push('fcm:verify');
      return active;
    },
    revokeCandidate: async () => {
      vault.events.push('server:revoke-candidate');
    },
    publishCredential: () => {
      vault.events.push('live:publish');
      return true;
    },
    ...overrides,
  };
}

describe('scoped credential upgrade runtime', () => {
  it('persists every V3 adoption boundary before the matching mutation and promotes last', async () => {
    const vault = await activeVault();

    await expect(beginCredentialUpgradeRuntime(CANDIDATE, dependencies(vault))).resolves.toEqual({
      kind: 'adopted',
    });

    expect(await vault.get('serverPassword')).toBe(CANDIDATE);
    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    expect(vault.events).toEqual([
      'exclusive',
      'journal:candidate',
      'candidate-info',
      'prepare-v3',
      'journal:adopting',
      'fcm:pending',
      'server:adopt',
      'fcm:active',
      'journal:adopted',
      'fcm:verify',
      'main-credential',
      'journal:delete',
      'live:publish',
    ]);
  });

  it('retains the exact adopting request after failure and resumes it without minting another key', async () => {
    const vault = await activeVault();
    const firstDeps = dependencies(vault, {
      registerV3: async () => {
        vault.events.push('server:failed');
        throw new Error('response lost');
      },
    });

    await expect(beginCredentialUpgradeRuntime(CANDIDATE, firstDeps)).resolves.toEqual({
      kind: 'retry',
      stage: 'adoption',
    });
    const stored = inspectCredentialUpgradeJournal(await vault.get('serverCredentialUpgrade'));
    expect(stored).toMatchObject({
      kind: 'valid',
      journal: { phase: 'adopting', registration: REGISTRATION },
    });
    expect(await vault.get('serverPassword')).toBe(PREVIOUS);

    vault.events.length = 0;
    await expect(resumeCredentialUpgradeRuntime(dependencies(vault))).resolves.toEqual({
      kind: 'adopted',
    });
    expect(vault.events).not.toContain('prepare-v3');
    expect(vault.events).toEqual([
      'exclusive',
      'fcm:pending',
      'server:adopt',
      'fcm:active',
      'journal:adopted',
      'fcm:verify',
      'main-credential',
      'journal:delete',
      'live:publish',
    ]);
  });

  it('never promotes a V2 journal or a mismatched V3 acknowledgement', async () => {
    const v2Vault = await activeVault();
    const candidate = createCredentialUpgradeCandidate(ORIGIN, PREVIOUS, CANDIDATE);
    const v2Registration: CredentialUpgradeFcmRegistration = {
      ...REGISTRATION,
      pushEncryption: { type: FCM_DEVICE_ENCRYPTION_TYPE, key: KEY },
    };
    const v2Adopted = acknowledgeCredentialUpgradePushAdoption(
      beginCredentialUpgradePushAdoption(candidate, v2Registration),
      { id: 'legacy-device', pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE },
    );
    await v2Vault.set('serverCredentialUpgrade', serializeCredentialUpgradeJournal(v2Adopted));
    v2Vault.events.length = 0;

    await expect(resumeCredentialUpgradeRuntime(dependencies(v2Vault))).resolves.toEqual({
      kind: 'quarantined',
      reason: 'v3-registration-required',
    });
    expect(await v2Vault.get('serverPassword')).toBe(PREVIOUS);

    const badAckVault = await activeVault();
    await expect(
      beginCredentialUpgradeRuntime(
        CANDIDATE,
        dependencies(badAckVault, {
          registerV3: async () => ({
            ...ACK,
            id: '44444444-4444-4444-8444-444444444444',
          }),
        }),
      ),
    ).resolves.toEqual({ kind: 'quarantined', reason: 'invalid-v3-ack' });
    expect(await badAckVault.get('serverPassword')).toBe(PREVIOUS);
    expect(
      inspectCredentialUpgradeJournal(await badAckVault.get('serverCredentialUpgrade')),
    ).toMatchObject({
      kind: 'valid',
      journal: { phase: 'adopting' },
    });
  });

  it('retains a candidate until its server authority is confirmed revoked', async () => {
    const vault = await activeVault();
    const candidate = createCredentialUpgradeCandidate(ORIGIN, PREVIOUS, CANDIDATE);
    await vault.set('serverCredentialUpgrade', serializeCredentialUpgradeJournal(candidate));
    vault.events.length = 0;

    await expect(
      discardCredentialUpgradeCandidateRuntime(
        dependencies(vault, {
          revokeCandidate: async () => {
            vault.events.push('server:revoke-failed');
            throw new Error('server unavailable');
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'retry', stage: 'candidate-revocation' });
    expect(await vault.get('serverCredentialUpgrade')).not.toBeNull();
    expect(vault.events).toEqual(['exclusive', 'server:revoke-failed']);

    vault.events.length = 0;
    await expect(discardCredentialUpgradeCandidateRuntime(dependencies(vault))).resolves.toEqual({
      kind: 'discarded',
    });
    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    expect(vault.events).toEqual(['exclusive', 'server:revoke-candidate', 'journal:delete']);
  });
});
