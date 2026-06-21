import { ApiError } from '@core/api/errors';
import { InMemoryVault } from '@core/secure';
import { connectToServer } from '@/services/connection';

const upToDate = { server_version: '1.9.5' };

describe('connectToServer', () => {
  it('persists credentials and returns ok for a valid, up-to-date server', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => upToDate,
      vault,
    });
    expect(res.ok).toBe(true);
    expect(await vault.get('serverAddress')).toBe('https://srv');
    expect(await vault.get('serverPassword')).toBe('pw');
  });

  it('maps a 401 to unauthorized and does NOT persist credentials', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'bad', {
      fetchServerInfo: async () => {
        throw new ApiError('unauthorized', 'nope', 401);
      },
      vault,
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
      });
      expect(res).toMatchObject({ ok: false, kind: 'unreachable' });
    }
  });

  it('connects to a below-minimum server (version is advisory, not a hard gate) and persists', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => ({ server_version: '1.5.0' }),
      vault,
      minServerVersion: '1.9.0',
    });
    expect(res.ok).toBe(true); // warns but proceeds — works degraded against the Gator fork
    expect(await vault.get('serverAddress')).toBe('https://srv');
  });

  it('treats unexpected errors as unknown', async () => {
    const vault = new InMemoryVault();
    const res = await connectToServer('https://srv', 'pw', {
      fetchServerInfo: async () => {
        throw new Error('boom');
      },
      vault,
    });
    expect(res).toMatchObject({ ok: false, kind: 'unknown' });
  });
});
