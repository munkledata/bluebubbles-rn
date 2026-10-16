import { ApiError } from '@core/api/errors';
import {
  ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE,
  createCredentialUpgradeCandidate,
  createReplacedCredentialRecord,
  InMemoryVault,
  logger,
  revokedCredentialUpgradeJournal,
  serializeCredentialUpgradeJournal,
  serializeReplacedCredentialRecord,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';
import { inspectDurableServerSession } from '@/services/boot/durableSession';
import { connectToServer, persistServerConnection } from '@/services/connection';
import { ServerInfo } from '@core/models';

const upToDate = { server_version: '1.9.5' };
const SCOPED_CREDENTIAL = `bbd_device_v1_${'A'.repeat(43)}`;
let revoked = false;
const revocationMarker: AccountRevocationMarker = {
  isRevoked: () => revoked,
  markRevoked: () => {
    revoked = true;
  },
  clear: () => {
    revoked = false;
  },
};

afterEach(() => {
  jest.restoreAllMocks();
  revoked = false;
});

describe('connectToServer', () => {
  it('persists credentials and returns ok for a valid, up-to-date server', async () => {
    const vault = new InMemoryVault();
    revoked = true;
    const set = jest.spyOn(vault, 'set');
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => upToDate,
      vault,
      revocationMarker,
    });
    expect(res.ok).toBe(true);
    expect(await vault.get('serverAddress')).toBe('https://srv');
    expect(await vault.get('serverPassword')).toBe('pw');
    expect(await vault.get('serverSessionState')).toBe(SERVER_SESSION_STATE.active);
    expect(revoked).toBe(false);
    expect(set.mock.calls).toEqual([
      ['serverSessionState', SERVER_SESSION_STATE.writing],
      ['serverAddress', 'https://srv'],
      ['serverPassword', 'pw'],
      ['serverSessionState', SERVER_SESSION_STATE.active],
    ]);
  });

  it('atomically clears only a confirmed revoked upgrade tombstone for a fresh session', async () => {
    const vault = new InMemoryVault();
    await vault.set(
      'serverCredentialUpgrade',
      serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal()),
    );

    await expect(
      connectToServer('https://srv', SCOPED_CREDENTIAL, {
        fetchServerInfo: async () => upToDate,
        vault,
        revocationMarker,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    expect(await vault.get('serverSessionState')).toBe(SERVER_SESSION_STATE.active);
  });

  describe('a replaced-credential record left by the previous account (review M130)', () => {
    const OLD_BEARER = `bbd_device_v1_${'O'.repeat(43)}`;
    const record = serializeReplacedCredentialRecord(
      createReplacedCredentialRecord('https://old', OLD_BEARER),
    );
    const tombstone = serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal());

    it('is cleared together with the tombstone by the new account’s first save', async () => {
      const vault = new InMemoryVault();
      await vault.set('serverCredentialUpgrade', tombstone);
      await vault.set('replacedServerCredential', record);

      await expect(
        connectToServer('https://srv', SCOPED_CREDENTIAL, {
          fetchServerInfo: async () => upToDate,
          vault,
          revocationMarker,
        }),
      ).resolves.toMatchObject({ ok: true });

      expect(await vault.get('replacedServerCredential')).toBeNull();
      expect(await vault.get('serverCredentialUpgrade')).toBeNull();
    });

    it('fails the connect closed, tombstone kept, when it cannot be cleared', async () => {
      const backing = new InMemoryVault();
      await backing.set('serverCredentialUpgrade', tombstone);
      await backing.set('replacedServerCredential', record);
      const keepsRecord: SecureVault = {
        get: (key) => backing.get(key),
        set: (key, value) => backing.set(key, value),
        delete: async (key) => {
          if (key !== 'replacedServerCredential') await backing.delete(key);
        },
      };

      await expect(
        connectToServer('https://srv', SCOPED_CREDENTIAL, {
          fetchServerInfo: async () => upToDate,
          vault: keepsRecord,
          revocationMarker,
        }),
      ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
      expect(await backing.get('replacedServerCredential')).toBe(record);
      expect(await backing.get('serverCredentialUpgrade')).toBe(tombstone);
      expect(await backing.get('serverSessionState')).toBe(SERVER_SESSION_STATE.writing);
    });

    it('is never touched by a same-account address change, which still owes its revocation', async () => {
      const vault = new InMemoryVault();
      await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
      await vault.set('serverAddress', 'https://old');
      await vault.set('serverPassword', SCOPED_CREDENTIAL);
      await vault.set('replacedServerCredential', record);

      await expect(
        persistServerConnection('https://new', SCOPED_CREDENTIAL, upToDate, {
          vault,
          revocationMarker,
        }),
      ).resolves.toMatchObject({ ok: true });

      expect(await vault.get('serverAddress')).toBe('https://new');
      expect(await vault.get('replacedServerCredential')).toBe(record);
    });
  });

  it('fails closed when upgrade-state removal is unconfirmed or a live candidate exists', async () => {
    const revoked = serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal());
    const backing = new InMemoryVault();
    await backing.set('serverCredentialUpgrade', revoked);
    const noOpDelete: SecureVault = {
      get: (key) => backing.get(key),
      set: (key, value) => backing.set(key, value),
      delete: async () => undefined,
    };

    await expect(
      connectToServer('https://srv', SCOPED_CREDENTIAL, {
        fetchServerInfo: async () => upToDate,
        vault: noOpDelete,
        revocationMarker,
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(await backing.get('serverSessionState')).toBe(SERVER_SESSION_STATE.writing);
    expect(await backing.get('serverCredentialUpgrade')).toBe(revoked);

    const liveCandidate = new InMemoryVault();
    const candidate = createCredentialUpgradeCandidate(
      'https://srv',
      'legacy-password',
      SCOPED_CREDENTIAL,
    );
    await liveCandidate.set(
      'serverCredentialUpgrade',
      serializeCredentialUpgradeJournal(candidate),
    );
    const deleteCandidate = jest.spyOn(liveCandidate, 'delete');

    await expect(
      connectToServer('https://srv', 'replacement-password', {
        fetchServerInfo: async () => upToDate,
        vault: liveCandidate,
        revocationMarker,
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(deleteCandidate).not.toHaveBeenCalled();
    expect(await liveCandidate.get('serverSessionState')).toBeNull();
  });

  it('fails before activation when credential-upgrade preflight cannot be read', async () => {
    const backing = new InMemoryVault();
    const vault: SecureVault = {
      get: async (key) => {
        if (key === 'serverCredentialUpgrade') throw new Error('Keystore read failed');
        return backing.get(key);
      },
      set: (key, value) => backing.set(key, value),
      delete: (key) => backing.delete(key),
    };

    await expect(
      connectToServer('https://srv', 'pw', {
        fetchServerInfo: async () => upToDate,
        vault,
        revocationMarker,
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(await backing.get('serverSessionState')).toBeNull();
  });

  it('does not start credential persistence when Disconnect revokes an in-flight validation', async () => {
    const vault = new InMemoryVault();
    const set = jest.spyOn(vault, 'set');
    let current = true;
    let resolveInfo!: (info: typeof upToDate) => void;
    const run = connectToServer('https://srv', 'pw', {
      fetchServerInfo: () =>
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
      vault,
      revocationMarker,
      isAttemptCurrent: () => current,
    });

    current = false;
    revocationMarker.markRevoked();
    resolveInfo(upToDate);

    await expect(run).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    expect(set).not.toHaveBeenCalled();
    expect(revoked).toBe(true);
  });

  it('stops between vault writes and never clears revocation after Disconnect', async () => {
    const backing = new InMemoryVault();
    let releaseAddressWrite!: () => void;
    const vault: SecureVault = {
      get: (key) => backing.get(key),
      delete: (key) => backing.delete(key),
      set: async (key, value) => {
        if (key === 'serverAddress') {
          await new Promise<void>((resolve) => {
            releaseAddressWrite = resolve;
          });
        }
        await backing.set(key, value);
      },
    };
    const clear = jest.spyOn(revocationMarker, 'clear');
    let current = true;
    const run = connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => upToDate,
      vault,
      revocationMarker,
      isAttemptCurrent: () => current,
    });
    for (let i = 0; i < 20 && releaseAddressWrite == null; i += 1) await Promise.resolve();

    current = false;
    revocationMarker.markRevoked();
    releaseAddressWrite();

    await expect(run).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    expect(await vault.get('serverSessionState')).toBe(SERVER_SESSION_STATE.writing);
    expect(await vault.get('serverAddress')).toBe('https://srv');
    expect(await vault.get('serverPassword')).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    expect(revoked).toBe(true);
  });

  it('leaves a partial credential write inactive when SecureStore rejects', async () => {
    const backing = new InMemoryVault();
    const vault: SecureVault = {
      get: (key) => backing.get(key),
      delete: (key) => backing.delete(key),
      set: async (key, value) => {
        if (key === 'serverPassword') throw new Error('Keystore write failed');
        await backing.set(key, value);
      },
    };
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => upToDate,
      vault,
      revocationMarker,
    });

    expect(res).toMatchObject({ ok: false, kind: 'unknown' });
    expect(await vault.get('serverSessionState')).toBe(SERVER_SESSION_STATE.writing);
    expect(await vault.get('serverAddress')).toBe('https://srv');
    expect(await vault.get('serverPassword')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[connect] secure credential persistence failed — session was not activated',
      expect.any(Error),
    );
  });

  it('maps a 401 to unauthorized and does NOT persist credentials', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'bad', {
      fetchServerInfo: async () => {
        throw new ApiError('unauthorized', 'nope', 401);
      },
      vault,
      revocationMarker,
    });
    expect(res).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(await vault.get('serverPassword')).toBeNull();
  });

  it('maps connection/timeout errors to unreachable', async () => {
    const vault = new InMemoryVault();
    for (const kind of ['no_connection', 'timeout'] as const) {
      const res = await connectToServer('https://srv', 'pw', {
        fetchServerInfo: async () => {
          throw new ApiError(kind, 'x');
        },
        vault,
        revocationMarker,
      });
      expect(res).toMatchObject({ ok: false, kind: 'unreachable' });
    }
  });

  it('connects to a below-minimum server (version is advisory, not a hard gate) and persists', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => ({ server_version: '1.5.0' }),
      vault,
      revocationMarker,
      minServerVersion: '1.9.0',
    });
    expect(res.ok).toBe(true); // warns but proceeds — works degraded against the Gator fork
    expect(await vault.get('serverAddress')).toBe('https://srv');
    expect(warn).toHaveBeenCalledWith(
      '[connect] server 1.5.0 is below the recommended 1.9.0; proceeding (some features may be degraded).',
    );
  });

  it('treats unexpected errors as unknown', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => {
        throw new Error('boom');
      },
      vault,
      revocationMarker,
    });
    expect(res).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('does not claim a durable connection when the independent marker cannot be cleared', async () => {
    const vault = new InMemoryVault();
    revoked = true;
    const clearError = new Error('documents directory unavailable');
    const marker: AccountRevocationMarker = {
      ...revocationMarker,
      clear: jest.fn(() => {
        throw clearError;
      }),
    };
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => upToDate,
      vault,
      revocationMarker: marker,
    });

    expect(res).toEqual({
      ok: false,
      kind: 'unknown',
      message: ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE,
    });
    expect(await vault.get('serverSessionState')).toBe(SERVER_SESSION_STATE.active);
    expect(revoked).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[connect] account revocation marker clear failed — session was not activated',
      clearError,
    );
  });
});

// Review items 800/808: an approved server-address change for the SAME account reused the
// new-account commit, whose `writing` barrier turns an interruption into a full local wipe at the
// next launch. Only the address changes, so one atomic write is enough and always boots.
describe('persistServerConnection for a same-account address change', () => {
  const info = ServerInfo.parse({ server_version: '1.9.5' });

  async function liveAccount(password = 'pw'): Promise<InMemoryVault> {
    const vault = new InMemoryVault();
    await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
    await vault.set('serverAddress', 'https://old.example');
    await vault.set('serverPassword', password);
    return vault;
  }

  it('writes only the new address, so any interruption still boots', async () => {
    const vault = await liveAccount();
    const set = jest.spyOn(vault, 'set');
    const clear = jest.spyOn(revocationMarker, 'clear');

    await expect(
      persistServerConnection('https://new.example', 'pw', info, { vault, revocationMarker }),
    ).resolves.toMatchObject({ ok: true });

    expect(set.mock.calls).toEqual([['serverAddress', 'https://new.example']]);
    expect(clear).not.toHaveBeenCalled();
    await expect(inspectDurableServerSession(vault, revocationMarker)).resolves.toMatchObject({
      kind: 'ready',
      session: { origin: 'https://new.example', password: 'pw' },
    });
  });

  it('keeps the old address and says so when the write fails', async () => {
    const vault = await liveAccount();
    jest.spyOn(vault, 'set').mockRejectedValueOnce(new Error('keystore busy'));
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await persistServerConnection('https://new.example', 'pw', info, {
      vault,
      revocationMarker,
    });

    expect(result).toMatchObject({ ok: false, kind: 'unknown' });
    expect(result.ok ? '' : result.message).toMatch(/still using the old one.*Settings/s);
    // Never the residual-account wipe: the old session is complete and boots.
    await expect(inspectDurableServerSession(vault, revocationMarker)).resolves.toMatchObject({
      kind: 'ready',
      session: { origin: 'https://old.example' },
    });
  });

  it('keeps the full new-account commit when the credential differs', async () => {
    const vault = await liveAccount('old-pw');
    const set = jest.spyOn(vault, 'set');

    await expect(
      persistServerConnection('https://new.example', 'new-pw', info, { vault, revocationMarker }),
    ).resolves.toMatchObject({ ok: true });

    expect(set.mock.calls[0]).toEqual(['serverSessionState', SERVER_SESSION_STATE.writing]);
  });

  it('refuses, writing nothing, while Disconnect has revoked the account', async () => {
    const vault = await liveAccount();
    revoked = true;
    const set = jest.spyOn(vault, 'set');

    await expect(
      persistServerConnection('https://new.example', 'pw', info, { vault, revocationMarker }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    // Never the new-account `writing` barrier for a live account's address change.
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses, writing nothing, when the revocation marker cannot be read', async () => {
    const vault = await liveAccount();
    const set = jest.spyOn(vault, 'set');
    const unreadable: AccountRevocationMarker = {
      ...revocationMarker,
      isRevoked: () => {
        throw new Error('marker unreadable');
      },
    };

    await expect(
      persistServerConnection('https://new.example', 'pw', info, {
        vault,
        revocationMarker: unreadable,
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(set).not.toHaveBeenCalled();
  });

  it('treats a legacy session without a state value as the same live account', async () => {
    const vault = await liveAccount();
    await vault.delete('serverSessionState');
    const set = jest.spyOn(vault, 'set');

    await expect(
      persistServerConnection('https://new.example', 'pw', info, { vault, revocationMarker }),
    ).resolves.toMatchObject({ ok: true });
    expect(set.mock.calls).toEqual([['serverAddress', 'https://new.example']]);
  });

  it.each([
    [
      'a half-written session',
      async (vault: InMemoryVault) => vault.set('serverSessionState', SERVER_SESSION_STATE.writing),
      'https://new.example',
    ],
    ['the same address', async () => undefined, 'https://old.example/'],
    [
      'a revoked credential-upgrade tombstone',
      async (vault: InMemoryVault) =>
        vault.set(
          'serverCredentialUpgrade',
          serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal()),
        ),
      'https://new.example',
    ],
  ])('keeps the full commit for %s', async (_case, arrange, target) => {
    const vault = await liveAccount();
    await arrange(vault);
    const set = jest.spyOn(vault, 'set');

    await persistServerConnection(target, 'pw', info, { vault, revocationMarker });

    expect(set.mock.calls[0]).toEqual(['serverSessionState', SERVER_SESSION_STATE.writing]);
  });

  it('writes nothing when the saved session cannot be read', async () => {
    const vault = await liveAccount();
    const get = vault.get.bind(vault);
    jest
      .spyOn(vault, 'get')
      .mockImplementation(async (key) =>
        key === 'serverPassword' ? Promise.reject(new Error('locked')) : get(key),
      );
    const set = jest.spyOn(vault, 'set');
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      persistServerConnection('https://new.example', 'pw', info, { vault, revocationMarker }),
    ).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(set).not.toHaveBeenCalled();
  });
});
