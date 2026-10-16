import {
  acknowledgeCredentialUpgradePushAdoption,
  beginCredentialUpgradePushAdoption,
  createCredentialUpgradeCandidate,
  createCredentialReplacementCandidate,
  createReplacedCredentialRecord,
  InMemoryVault,
  inspectCredentialUpgradeJournal,
  inspectReplacedCredentialRecord,
  serializeReplacedCredentialRecord,
  serializeCredentialUpgradeJournal,
  SERVER_SESSION_STATE,
  type CredentialUpgradeFcmRegistration,
  type CredentialUpgradeFcmV3AdoptionAck,
  type SecretKey,
} from '@core/secure';
import { FCM_DEVICE_ENCRYPTION_TYPE, FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';
import { ApiError } from '@core/api/errors';
import {
  beginCredentialUpgradeRuntime,
  beginCredentialReplacementRuntime,
  discardCredentialUpgradeCandidateRuntime,
  resumeCredentialUpgradeRuntime,
  revokeReplacedCredentialRuntime,
  type CredentialUpgradeRuntimeDependencies,
} from '@/services/credentialUpgradeRuntime';
import { flushMicrotasks, waitForMicrotaskCondition } from '../support/async';

const ORIGIN = 'https://gator.example';
const PREVIOUS = 'legacy shared password';
const PREVIOUS_SCOPED = `bbd_device_v1_${'B'.repeat(43)}`;
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
    } else if (key === 'replacedServerCredential') {
      this.events.push('replaced:record');
    }
    await super.set(key, value);
  }

  override async delete(key: SecretKey): Promise<void> {
    if (key === 'serverCredentialUpgrade') this.events.push('journal:delete');
    if (key === 'replacedServerCredential') this.events.push('replaced:delete');
    await super.delete(key);
  }
}

async function activeVault(credential = PREVIOUS): Promise<RecordingVault> {
  const vault = new RecordingVault();
  await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
  await vault.set('serverAddress', ORIGIN);
  await vault.set('serverPassword', credential);
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
    checkBearerAccepted: async () => {
      vault.events.push('bearer-check');
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
    releasePreviousPushTarget: async () => {
      vault.events.push('server:release-previous-push');
      return 'released';
    },
    revokePreviousCredential: async () => {
      vault.events.push('server:revoke-previous');
    },
    publishCredential: () => {
      vault.events.push('live:publish');
      return true;
    },
    ...overrides,
  };
}

describe('scoped credential upgrade runtime', () => {
  it('says whether the saved attempt blocking a new one holds that exact credential', async () => {
    const vault = await activeVault();
    const deps = dependencies(vault, {
      fetchCandidateServerInfo: async () => {
        throw new ApiError('no_connection', 'offline');
      },
    });
    // The first try saves CANDIDATE and stops at validation, so its attempt stays saved.
    await expect(beginCredentialUpgradeRuntime(CANDIDATE, deps)).resolves.toMatchObject({
      kind: 'retry',
    });

    await expect(beginCredentialUpgradeRuntime(CANDIDATE, deps)).resolves.toEqual({
      kind: 'conflict',
      sameCandidate: true,
    });
    await expect(
      beginCredentialUpgradeRuntime(`bbd_device_v1_${'C'.repeat(43)}`, deps),
    ).resolves.toEqual({ kind: 'conflict', sameCandidate: false });
  });

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

  it('removes a scoped candidate only when the server also rejects its exact bearer', async () => {
    const unauthorized = ApiError.fromStatus(401, 'invalid credential');
    const vault = await activeVault(PREVIOUS_SCOPED);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          fetchCandidateServerInfo: async () => {
            throw unauthorized;
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'retry', stage: 'candidate-validation' });
    expect(await vault.get('serverCredentialUpgrade')).not.toBeNull();

    await expect(
      discardCredentialUpgradeCandidateRuntime(
        dependencies(vault, {
          revokeCandidate: async () => {
            throw unauthorized;
          },
          checkBearerAccepted: async () => {
            throw unauthorized;
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'discarded' });
    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    expect(await vault.get('serverPassword')).toBe(PREVIOUS_SCOPED);

    const validVault = await activeVault(PREVIOUS_SCOPED);
    await validVault.set(
      'serverCredentialUpgrade',
      serializeCredentialUpgradeJournal(
        createCredentialReplacementCandidate(ORIGIN, PREVIOUS_SCOPED, CANDIDATE),
      ),
    );
    await expect(
      discardCredentialUpgradeCandidateRuntime(
        dependencies(validVault, {
          revokeCandidate: async () => {
            throw unauthorized;
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'retry', stage: 'candidate-revocation' });
    expect(await validVault.get('serverCredentialUpgrade')).not.toBeNull();
  });

  it('replaces a scoped credential and keeps custody of the old bearer for revocation (M130)', async () => {
    const vault = await activeVault(PREVIOUS_SCOPED);
    const revokePreviousCredential = jest.fn(async () => undefined);

    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, { revokePreviousCredential }),
      ),
    ).resolves.toEqual({ kind: 'adopted' });

    expect(await vault.get('serverPassword')).toBe(CANDIDATE);
    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    // The caller revokes the old bearer next, once the new credential is live.
    expect(revokePreviousCredential).not.toHaveBeenCalled();
    expect(inspectReplacedCredentialRecord(await vault.get('replacedServerCredential'))).toEqual({
      kind: 'valid',
      record: { version: 1, origin: ORIGIN, credential: PREVIOUS_SCOPED },
    });
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
      // Custody of the old bearer moves to its own record before the journal goes away.
      'replaced:record',
      'journal:delete',
      'live:publish',
    ]);
    expect(vault.events).not.toContain('server:revoke-candidate');
  });
  it('keeps a V2 scoped replacement recoverable when the old push row cannot be freed', async () => {
    const vault = await activeVault(PREVIOUS_SCOPED);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          releasePreviousPushTarget: async () => {
            vault.events.push('server:release-refused');
            return 'refused';
          },
          registerV3: async () => {
            vault.events.push('server:adoption-conflict');
            throw ApiError.fromStatus(
              409,
              'device target already owned',
              undefined,
              'device_target_owned',
            );
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'blocked', reason: 'push-target-owned' });

    expect(await vault.get('serverPassword')).toBe(PREVIOUS_SCOPED);
    expect(
      inspectCredentialUpgradeJournal(await vault.get('serverCredentialUpgrade')),
    ).toMatchObject({
      kind: 'valid',
      journal: {
        version: 2,
        phase: 'adopting',
        previousCredential: PREVIOUS_SCOPED,
        candidateCredential: CANDIDATE,
        registration: REGISTRATION,
      },
    });
    expect(vault.events).not.toContain('server:revoke-candidate');
    expect(vault.events).not.toContain('server:revoke-previous');

    vault.events.length = 0;
    await expect(resumeCredentialUpgradeRuntime(dependencies(vault))).resolves.toEqual({
      kind: 'adopted',
    });
    expect(vault.events).not.toContain('prepare-v3');
    expect(vault.events).not.toContain('server:revoke-candidate');
    expect(await vault.get('serverPassword')).toBe(CANDIDATE);
  });

  it('keeps legacy upgrade and scoped replacement entry points separate', async () => {
    const scopedVault = await activeVault(PREVIOUS_SCOPED);
    await expect(
      beginCredentialUpgradeRuntime(CANDIDATE, dependencies(scopedVault)),
    ).resolves.toEqual({
      kind: 'quarantined',
      reason: 'legacy-session-required',
    });
    expect(scopedVault.events).toEqual([]);

    const legacyVault = await activeVault();
    await expect(
      beginCredentialReplacementRuntime(CANDIDATE, dependencies(legacyVault)),
    ).resolves.toEqual({ kind: 'quarantined', reason: 'scoped-session-required' });
    expect(legacyVault.events).toEqual([]);

    await expect(
      beginCredentialReplacementRuntime(PREVIOUS_SCOPED, dependencies(scopedVault)),
    ).resolves.toEqual({ kind: 'quarantined', reason: 'invalid-candidate' });
    expect(scopedVault.events).toEqual([]);
  });
});

describe('replaced scoped credential (M130)', () => {
  const OLDER_SCOPED = `bbd_device_v1_${'C'.repeat(43)}`;
  const conflict = (): ApiError =>
    ApiError.fromStatus(409, 'device target already owned', undefined, 'device_target_owned');
  const unauthorized = (): ApiError => ApiError.fromStatus(401, 'invalid credential');

  async function withRecord(main: string, recorded: string): Promise<RecordingVault> {
    const vault = await activeVault(main);
    await vault.set(
      'replacedServerCredential',
      serializeReplacedCredentialRecord(createReplacedCredentialRecord(ORIGIN, recorded)),
    );
    vault.events.length = 0;
    return vault;
  }

  it('frees the old push row with the old credential, then registers once more', async () => {
    const vault = await activeVault(PREVIOUS_SCOPED);
    const releasePreviousPushTarget = jest.fn(async () => {
      vault.events.push('server:release-previous-push');
      return 'released' as const;
    });
    let attempts = 0;
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          releasePreviousPushTarget,
          registerV3: async () => {
            attempts += 1;
            vault.events.push(attempts === 1 ? 'server:adoption-conflict' : 'server:adopt');
            if (attempts === 1) throw conflict();
            return ACK;
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'adopted' });

    expect(releasePreviousPushTarget).toHaveBeenCalledWith(ORIGIN, PREVIOUS_SCOPED);
    expect(vault.events.slice(5, 9)).toEqual([
      'fcm:pending',
      'server:adoption-conflict',
      'server:release-previous-push',
      'server:adopt',
    ]);
    expect(await vault.get('serverPassword')).toBe(CANDIDATE);
  });

  it('retries the adoption later when freeing the old push row fails for now', async () => {
    const vault = await activeVault(PREVIOUS_SCOPED);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          releasePreviousPushTarget: async () => {
            throw new Error('network down');
          },
          registerV3: async () => {
            throw conflict();
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'retry', stage: 'adoption' });
    expect(await vault.get('serverPassword')).toBe(PREVIOUS_SCOPED);
    expect(
      inspectCredentialUpgradeJournal(await vault.get('serverCredentialUpgrade')),
    ).toMatchObject({ kind: 'valid', journal: { phase: 'adopting' } });
  });

  it('reports a push target still owned after the old row was freed as blocked', async () => {
    const vault = await activeVault(PREVIOUS_SCOPED);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          registerV3: async () => {
            throw conflict();
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'blocked', reason: 'push-target-owned' });
    expect(await vault.get('serverPassword')).toBe(PREVIOUS_SCOPED);
  });

  it('keeps custody of the old bearer while its revocation fails, and finishes it later', async () => {
    const vault = await withRecord(CANDIDATE, PREVIOUS_SCOPED);
    await expect(
      revokeReplacedCredentialRuntime(
        dependencies(vault, {
          revokePreviousCredential: async () => {
            throw new Error('Mac unreachable');
          },
        }),
      ),
    ).resolves.toBe('pending');
    expect(inspectReplacedCredentialRecord(await vault.get('replacedServerCredential'))).toEqual({
      kind: 'valid',
      record: { version: 1, origin: ORIGIN, credential: PREVIOUS_SCOPED },
    });

    vault.events.length = 0;
    await expect(revokeReplacedCredentialRuntime(dependencies(vault))).resolves.toBe('revoked');
    expect(vault.events).toEqual(['server:revoke-previous', 'replaced:delete']);
    expect(await vault.get('replacedServerCredential')).toBeNull();
  });
  it('counts a 401 as already revoked only when the info endpoint agrees', async () => {
    const rejected = await withRecord(CANDIDATE, PREVIOUS_SCOPED);
    await expect(
      revokeReplacedCredentialRuntime(
        dependencies(rejected, {
          revokePreviousCredential: async () => {
            throw unauthorized();
          },
          checkBearerAccepted: async () => {
            throw unauthorized();
          },
        }),
      ),
    ).resolves.toBe('revoked');
    expect(await rejected.get('replacedServerCredential')).toBeNull();

    const stillValid = await withRecord(CANDIDATE, PREVIOUS_SCOPED);
    const checkBearerAccepted = jest.fn(async () => undefined);
    await expect(
      revokeReplacedCredentialRuntime(
        dependencies(stillValid, {
          revokePreviousCredential: async () => {
            throw unauthorized();
          },
          checkBearerAccepted,
        }),
      ),
    ).resolves.toBe('pending');
    expect(checkBearerAccepted).toHaveBeenCalledWith(ORIGIN, PREVIOUS_SCOPED);
    expect(await stillValid.get('replacedServerCredential')).not.toBeNull();
  });

  it('runs one record operation at a time, so a second revocation finds the record gone', async () => {
    const vault = await withRecord(CANDIDATE, PREVIOUS_SCOPED);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revokePreviousCredential = jest.fn(async () => {
      await held;
    });
    const deps = dependencies(vault, { revokePreviousCredential });

    const first = revokeReplacedCredentialRuntime(deps);
    const second = revokeReplacedCredentialRuntime(deps);
    await waitForMicrotaskCondition(
      () => revokePreviousCredential.mock.calls.length === 1,
      'first revocation',
      50,
    );
    await flushMicrotasks(20);
    expect(revokePreviousCredential).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe('revoked');
    await expect(second).resolves.toBe('none');
    expect(revokePreviousCredential).toHaveBeenCalledTimes(1);
  });

  it('never forgets a newer record that appeared while its revocation was in flight', async () => {
    const vault = await withRecord(CANDIDATE, PREVIOUS_SCOPED);
    const newer = serializeReplacedCredentialRecord(
      createReplacedCredentialRecord(ORIGIN, OLDER_SCOPED),
    );
    const revokePreviousCredential = jest.fn(async () => {
      // A writer outside the record lock lands mid-revocation.
      await vault.set('replacedServerCredential', newer);
    });

    await expect(
      revokeReplacedCredentialRuntime(dependencies(vault, { revokePreviousCredential })),
    ).resolves.toBe('revoked');
    expect(revokePreviousCredential).toHaveBeenCalledWith(ORIGIN, PREVIOUS_SCOPED);
    expect(await vault.get('replacedServerCredential')).toBe(newer);
  });

  it('finishes an earlier pending revocation before starting another replacement', async () => {
    const vault = await withRecord(PREVIOUS_SCOPED, OLDER_SCOPED);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, {
          revokePreviousCredential: async () => {
            throw new Error('Mac unreachable');
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'retry', stage: 'previous-revocation' });
    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    expect(await vault.get('serverPassword')).toBe(PREVIOUS_SCOPED);

    const revokePreviousCredential = jest.fn(async () => undefined);
    await expect(
      beginCredentialReplacementRuntime(
        CANDIDATE,
        dependencies(vault, { revokePreviousCredential }),
      ),
    ).resolves.toEqual({ kind: 'adopted' });
    expect(revokePreviousCredential.mock.calls).toEqual([[ORIGIN, OLDER_SCOPED]]);
    expect(await vault.get('serverPassword')).toBe(CANDIDATE);
    // Custody now holds the bearer this replacement retired, for the caller to revoke next.
    expect(
      inspectReplacedCredentialRecord(await vault.get('replacedServerCredential')),
    ).toMatchObject({ kind: 'valid', record: { credential: PREVIOUS_SCOPED } });
  });

  it('never revokes the live credential and drops a record that names it', async () => {
    const vault = await withRecord(CANDIDATE, CANDIDATE);
    const revokePreviousCredential = jest.fn(async () => undefined);
    await expect(
      revokeReplacedCredentialRuntime(dependencies(vault, { revokePreviousCredential })),
    ).resolves.toBe('none');
    expect(revokePreviousCredential).not.toHaveBeenCalled();
    expect(await vault.get('replacedServerCredential')).toBeNull();
  });

  it('drops an unreadable record without revoking anything', async () => {
    const vault = await activeVault(CANDIDATE);
    await vault.set('replacedServerCredential', '{"version":1}');
    const revokePreviousCredential = jest.fn(async () => undefined);
    await expect(
      revokeReplacedCredentialRuntime(dependencies(vault, { revokePreviousCredential })),
    ).resolves.toBe('none');
    expect(revokePreviousCredential).not.toHaveBeenCalled();
    expect(await vault.get('replacedServerCredential')).toBeNull();
  });

  it('does nothing when no credential is waiting', async () => {
    const vault = await activeVault(CANDIDATE);
    await expect(revokeReplacedCredentialRuntime(dependencies(vault))).resolves.toBe('none');
    expect(vault.events).toEqual([]);
  });
});
