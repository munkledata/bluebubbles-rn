import {
  InMemoryVault,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';
import { readFcmSessionState } from '@/services/notifications/fcmSessionGate';

let revoked = false;
const revocationMarker: Pick<AccountRevocationMarker, 'isRevoked'> = {
  isRevoked: () => revoked,
};

beforeEach(() => {
  revoked = false;
});

describe('FCM retained-session gate', () => {
  it('keeps the missing-marker legacy fallback for an existing complete credential pair', async () => {
    const vault = new InMemoryVault();
    await vault.set('serverAddress', 'https://server.example');
    await vault.set('serverPassword', 'secret');

    await expect(readFcmSessionState(vault, revocationMarker)).resolves.toBe('active');
  });

  it('accepts a complete credential pair committed as active', async () => {
    const vault = new InMemoryVault();
    await vault.set('serverAddress', 'https://server.example');
    await vault.set('serverPassword', 'secret');
    await vault.set('serverSessionState', SERVER_SESSION_STATE.active);

    await expect(readFcmSessionState(vault, revocationMarker)).resolves.toBe('active');
  });

  it('rejects old active credentials when the independent marker says they were revoked', async () => {
    const vault = new InMemoryVault();
    await vault.set('serverAddress', 'https://server.example');
    await vault.set('serverPassword', 'secret');
    await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
    revoked = true;

    await expect(readFcmSessionState(vault, revocationMarker)).resolves.toBe('forgotten');
  });

  it.each([SERVER_SESSION_STATE.writing, SERVER_SESSION_STATE.forgotten])(
    'rejects stale complete credentials when the correlated state is %s',
    async (state) => {
      const vault = new InMemoryVault();
      await vault.set('serverAddress', 'https://server.example');
      await vault.set('serverPassword', 'secret');
      await vault.set('serverSessionState', state);

      await expect(readFcmSessionState(vault, revocationMarker)).resolves.toBe('forgotten');
    },
  );

  it.each(['serverAddress', 'serverPassword'] as const)(
    'treats a session missing %s as forgotten',
    async (missing) => {
      const vault = new InMemoryVault();
      if (missing !== 'serverAddress') await vault.set('serverAddress', 'https://server.example');
      if (missing !== 'serverPassword') await vault.set('serverPassword', 'secret');

      await expect(readFcmSessionState(vault, revocationMarker)).resolves.toBe('forgotten');
    },
  );

  it('fails closed when Android secure storage cannot be read', async () => {
    const unavailable: Pick<SecureVault, 'get'> = {
      get: jest.fn().mockRejectedValue(new Error('Keystore unavailable')),
    };

    await expect(readFcmSessionState(unavailable, revocationMarker)).resolves.toBe('unavailable');
  });

  it('fails closed before reading SecureStore when the independent marker is unreadable', async () => {
    const get = jest.fn(async () => 'would-have-looked-active');
    const unreadable: Pick<AccountRevocationMarker, 'isRevoked'> = {
      isRevoked: () => {
        throw new Error('documents directory unavailable');
      },
    };

    await expect(readFcmSessionState({ get }, unreadable)).resolves.toBe('unavailable');
    expect(get).not.toHaveBeenCalled();
  });
});
