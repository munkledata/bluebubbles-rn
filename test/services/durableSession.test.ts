import { InMemoryVault, SERVER_SESSION_STATE } from '@core/secure';
import {
  inspectDurableServerSession,
  isForegroundSessionSnapshot,
  sameForegroundSession,
  type ForegroundSessionSnapshot,
} from '@/services/boot/durableSession';

function clearMarker(): { isRevoked: jest.Mock<boolean, []> } {
  return { isRevoked: jest.fn(() => false) };
}

async function readyVault(
  sessionState: null | typeof SERVER_SESSION_STATE.active = SERVER_SESSION_STATE.active,
): Promise<InMemoryVault> {
  const vault = new InMemoryVault();
  if (sessionState !== null) await vault.set('serverSessionState', sessionState);
  await vault.set('serverAddress', 'https://gator.example');
  await vault.set('serverPassword', 'private-password');
  return vault;
}

describe('durable foreground session inspection', () => {
  it('recognizes a completely empty vault without opening an account', async () => {
    const marker = clearMarker();

    await expect(inspectDurableServerSession(new InMemoryVault(), marker)).resolves.toEqual({
      kind: 'empty',
    });
    expect(marker.isRevoked).toHaveBeenCalledTimes(2);
  });

  it.each([null, SERVER_SESSION_STATE.active] as const)(
    'returns one frozen, runtime-valid snapshot for compatible state %s',
    async (sessionState) => {
      const result = await inspectDurableServerSession(
        await readyVault(sessionState),
        clearMarker(),
      );

      expect(result).toEqual({
        kind: 'ready',
        session: {
          sessionState,
          origin: 'https://gator.example',
          password: 'private-password',
        },
      });
      if (result.kind !== 'ready') throw new Error('expected ready session');
      expect(Object.isFrozen(result.session)).toBe(true);
      expect(isForegroundSessionSnapshot(result.session)).toBe(true);
    },
  );

  it.each([
    [SERVER_SESSION_STATE.writing, 'https://gator.example', 'private-password'],
    [SERVER_SESSION_STATE.forgotten, 'https://gator.example', 'private-password'],
    ['unknown', 'https://gator.example', 'private-password'],
    [SERVER_SESSION_STATE.active, 'https://gator.example', null],
    [SERVER_SESSION_STATE.active, null, 'private-password'],
    [null, 'https://gator.example', null],
  ] as const)(
    'requires cleanup for an unsafe tuple (%s, %s, %s)',
    async (sessionState, origin, password) => {
      const vault = new InMemoryVault();
      if (sessionState !== null) await vault.set('serverSessionState', sessionState);
      if (origin !== null) await vault.set('serverAddress', origin);
      if (password !== null) await vault.set('serverPassword', password);

      await expect(inspectDurableServerSession(vault, clearMarker())).resolves.toEqual({
        kind: 'cleanup-required',
      });
    },
  );

  it('blocks before reading the vault when the independent marker is revoked or unreadable', async () => {
    const vault = { get: jest.fn(async () => 'must-not-be-read') };

    await expect(inspectDurableServerSession(vault, { isRevoked: () => true })).resolves.toEqual({
      kind: 'revoked',
    });
    await expect(
      inspectDurableServerSession(vault, {
        isRevoked: () => {
          throw new Error('marker unavailable');
        },
      }),
    ).resolves.toEqual({ kind: 'unavailable', source: 'marker' });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('lets a revocation published during the vault read win', async () => {
    const marker = { isRevoked: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true) };

    await expect(inspectDurableServerSession(await readyVault(), marker)).resolves.toEqual({
      kind: 'revoked',
    });
    expect(marker.isRevoked).toHaveBeenCalledTimes(2);
  });

  it('reports a vault read rejection without changing or erasing durable state', async () => {
    const error = new Error('Android Keystore unavailable');
    const vault = { get: jest.fn(async () => Promise.reject(error)) };

    const result = await inspectDurableServerSession(vault, clearMarker());

    expect(result).toEqual({ kind: 'unavailable', source: 'vault', error });
  });

  it.each([
    ['session state', { sessionState: null }],
    ['origin', { origin: 'https://other.example' }],
    ['password', { password: 'different-password' }],
  ] as const)('detects an exact %s change before activation', (_label, change) => {
    const authorized: ForegroundSessionSnapshot = Object.freeze({
      sessionState: SERVER_SESSION_STATE.active,
      origin: 'https://gator.example',
      password: 'private-password',
    });
    const current: ForegroundSessionSnapshot = Object.freeze({ ...authorized, ...change });

    expect(sameForegroundSession(authorized, current)).toBe(false);
    expect(sameForegroundSession(authorized, authorized)).toBe(true);
  });

  it('rejects mutable or malformed values in the runtime coordinator guard', () => {
    expect(
      isForegroundSessionSnapshot({
        sessionState: SERVER_SESSION_STATE.active,
        origin: 'https://gator.example',
        password: 'private-password',
      }),
    ).toBe(false);
    expect(isForegroundSessionSnapshot(Object.freeze({ origin: '', password: 'x' }))).toBe(false);
    expect(isForegroundSessionSnapshot(null)).toBe(false);
  });
});
