import { ApiError } from '@core/api/errors';
import {
  ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE,
  InMemoryVault,
  logger,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';
import { connectToServer } from '@/services/connection';

const upToDate = { server_version: '1.9.5' };
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
