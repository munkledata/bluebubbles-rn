import type { ServerInfo } from '@core/models';
import type { ConnectResult } from '@/services/connection';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { ServerRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
import {
  approveServerRotation,
  type ServerRotationExecutorDeps,
} from '@/services/realtime/serverRotationExecutor';

const SERVER_INFO = { server_version: '1.0.0' } as ServerInfo;
const NEXT_SERVER_INFO = { server_version: '1.1.0' } as ServerInfo;
const SCOPED_DEVICE_CREDENTIAL = `bbd_device_v1_${'A'.repeat(43)}`;

function setup(
  options: { currentOrigin?: string; candidateOrigin?: string; currentPassword?: string } = {},
): {
  deps: ServerRotationExecutorDeps;
  requestId: number;
  session: { origin: string | null; password: string | null; epoch: number };
  setForeground: (value: boolean) => void;
  setLeaseCurrent: (value: boolean) => void;
  validateCandidate: jest.Mock<
    Promise<ConnectResult>,
    Parameters<ServerRotationExecutorDeps['validateCandidate']>
  >;
  persistCandidate: jest.Mock<
    Promise<ConnectResult>,
    Parameters<ServerRotationExecutorDeps['persistCandidate']>
  >;
  moveFcmPushKeyState: jest.Mock<
    Promise<void>,
    Parameters<ServerRotationExecutorDeps['moveFcmPushKeyState']>
  >;
  settleReplacedCredential: jest.Mock<
    Promise<'settled' | 'pending' | 'cancelled'>,
    Parameters<ServerRotationExecutorDeps['settleReplacedCredential']>
  >;
  publishCandidate: jest.Mock;
  reconnect: jest.Mock;
} {
  const currentOrigin = options.currentOrigin ?? 'https://current.example';
  const candidateOrigin = options.candidateOrigin ?? 'https://next.example';
  let foreground = true;
  let leaseCurrent = true;
  let invalidation: (() => void) | null = null;
  const coordinator = new ServerRotationCoordinator((_generation, listener) => {
    invalidation = listener;
    return () => {
      if (invalidation === listener) invalidation = null;
    };
  });
  const lease: RealtimeDeliveryLease = { generation: 4, isCurrent: () => leaseCurrent };
  const session = {
    origin: currentOrigin as string | null,
    password: (options.currentPassword ?? 'correct-password') as string | null,
    epoch: 9,
  };
  coordinator.offer(candidateOrigin, currentOrigin, session.epoch, lease, () => foreground);
  const requestId = coordinator.getSnapshot()!.id;
  const validateCandidate = jest.fn<
    Promise<ConnectResult>,
    Parameters<ServerRotationExecutorDeps['validateCandidate']>
  >(async () => ({ ok: true, serverInfo: SERVER_INFO }));
  const persistCandidate = jest.fn<
    Promise<ConnectResult>,
    Parameters<ServerRotationExecutorDeps['persistCandidate']>
  >(async () => ({ ok: true, serverInfo: SERVER_INFO }));
  const moveFcmPushKeyState = jest.fn<
    Promise<void>,
    Parameters<ServerRotationExecutorDeps['moveFcmPushKeyState']>
  >(async () => undefined);
  const settleReplacedCredential = jest.fn<
    Promise<'settled' | 'pending' | 'cancelled'>,
    Parameters<ServerRotationExecutorDeps['settleReplacedCredential']>
  >(async () => 'settled');
  const publishCandidate = jest.fn((origin: string) => {
    session.origin = origin;
  });
  const reconnect = jest.fn(async () => undefined);
  const deps: ServerRotationExecutorDeps = {
    coordinator,
    getSession: () => ({ ...session }),
    captureLease: () => lease,
    validateCandidate,
    persistCandidate,
    moveFcmPushKeyState,
    settleReplacedCredential,
    publishCandidate,
    reconnect,
  };
  return {
    deps,
    requestId,
    session,
    setForeground: (value) => {
      foreground = value;
    },
    setLeaseCurrent: (value) => {
      leaseCurrent = value;
      if (!value) invalidation?.();
    },
    validateCandidate,
    persistCandidate,
    moveFcmPushKeyState,
    settleReplacedCredential,
    publishCandidate,
    reconnect,
  };
}

describe('approveServerRotation', () => {
  describe('a replaced credential still waiting for revocation (review M130)', () => {
    it('is revoked at the current address after validation, before the new address is saved', async () => {
      const { deps, requestId, validateCandidate, settleReplacedCredential, persistCandidate } =
        setup();
      let currentWhileSettling: boolean | undefined;
      settleReplacedCredential.mockImplementationOnce(async (isCurrent) => {
        currentWhileSettling = isCurrent();
        return 'settled';
      });

      await expect(
        approveServerRotation(requestId, 'correct-password', false, deps),
      ).resolves.toEqual({ ok: true });

      expect(settleReplacedCredential).toHaveBeenCalledTimes(1);
      expect(currentWhileSettling).toBe(true);
      expect(validateCandidate.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        settleReplacedCredential.mock.invocationCallOrder[0]!,
      );
      expect(settleReplacedCredential.mock.invocationCallOrder[0]!).toBeLessThan(
        persistCandidate.mock.invocationCallOrder[0]!,
      );
    });

    it('keeps the change waiting, retryable, while that revocation cannot finish', async () => {
      const { deps, requestId, settleReplacedCredential, persistCandidate, publishCandidate } =
        setup();
      settleReplacedCredential.mockResolvedValueOnce('pending');

      await expect(
        approveServerRotation(requestId, 'correct-password', false, deps),
      ).resolves.toMatchObject({
        ok: false,
        kind: 'previous-credential-pending',
        terminal: false,
      });
      expect(persistCandidate).not.toHaveBeenCalled();
      expect(publishCandidate).not.toHaveBeenCalled();
      // The prompt can try again once the revocation goes through.
      expect(deps.coordinator.current(requestId)).not.toBeNull();
      await expect(
        approveServerRotation(requestId, 'correct-password', false, deps),
      ).resolves.toEqual({ ok: true });
    });

    it('keeps the change waiting, retryable, when that revocation fails unexpectedly (M130 second review)', async () => {
      const { deps, requestId, settleReplacedCredential, persistCandidate } = setup();
      settleReplacedCredential.mockRejectedValueOnce(new Error('module failed to load'));

      await expect(
        approveServerRotation(requestId, 'correct-password', false, deps),
      ).resolves.toMatchObject({
        ok: false,
        kind: 'previous-credential-pending',
        terminal: false,
      });
      expect(persistCandidate).not.toHaveBeenCalled();
      expect(deps.coordinator.current(requestId)).not.toBeNull();
    });

    it('drops the change when ownership moves during that revocation', async () => {
      const { deps, requestId, settleReplacedCredential, persistCandidate } = setup();
      settleReplacedCredential.mockResolvedValueOnce('cancelled');

      await expect(
        approveServerRotation(requestId, 'correct-password', false, deps),
      ).resolves.toMatchObject({ ok: false, kind: 'stale' });
      expect(persistCandidate).not.toHaveBeenCalled();
    });
  });

  it('rejects a mismatched reconfirmation before candidate network or persistence', async () => {
    const h = setup();

    await expect(
      approveServerRotation(h.requestId, 'wrong-password', false, h.deps),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, kind: 'password-mismatch', terminal: false }),
    );
    expect(h.validateCandidate).not.toHaveBeenCalled();
    expect(h.persistCandidate).not.toHaveBeenCalled();
    expect(h.deps.coordinator.getSnapshot()?.id).toBe(h.requestId);
  });

  it('requires separate cleartext consent before candidate network use', async () => {
    const h = setup({
      currentOrigin: 'http://current.lan:1234',
      candidateOrigin: 'http://next.lan:1234',
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, kind: 'cleartext-consent-required', terminal: false }),
    );
    expect(h.validateCandidate).not.toHaveBeenCalled();
    expect(h.persistCandidate).not.toHaveBeenCalled();
  });

  it('proves a scoped rotation at the trusted origin and preserves the device credential', async () => {
    const h = setup({ currentPassword: SCOPED_DEVICE_CREDENTIAL });
    h.validateCandidate
      .mockResolvedValueOnce({ ok: true, serverInfo: SERVER_INFO })
      .mockResolvedValueOnce({ ok: true, serverInfo: NEXT_SERVER_INFO });
    h.persistCandidate.mockImplementation(async (_origin, _password, info) => ({
      ok: true,
      serverInfo: info,
    }));

    await expect(
      approveServerRotation(h.requestId, 'fresh-shared-password', false, h.deps),
    ).resolves.toEqual({ ok: true });

    expect(h.validateCandidate).toHaveBeenNthCalledWith(
      1,
      'https://current.example',
      'fresh-shared-password',
      expect.any(Function),
    );
    expect(h.validateCandidate).toHaveBeenNthCalledWith(
      2,
      'https://next.example',
      SCOPED_DEVICE_CREDENTIAL,
      expect.any(Function),
    );
    expect(h.persistCandidate).toHaveBeenCalledWith(
      'https://next.example',
      SCOPED_DEVICE_CREDENTIAL,
      NEXT_SERVER_INFO,
      expect.any(Object),
      expect.any(Function),
    );
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });

  // Review of items 800/808: a typed address can point at a different Mac that happens to accept the
  // same password; keeping this phone's data while syncing through it would mix two accounts.
  describe('server identity', () => {
    const CURRENT_EPOCH = '11111111-1111-4111-8111-111111111111';
    const OTHER_EPOCH = '22222222-2222-4222-8222-222222222222';

    function withCurrentEpoch(
      h: ReturnType<typeof setup>,
      epoch: string | null,
    ): ServerRotationExecutorDeps {
      return {
        ...h.deps,
        getCurrentServerInfo: () => ({ ...SERVER_INFO, imessage_provider_epoch: epoch }),
      };
    }

    it('refuses an address that answers as a different Messages server', async () => {
      const h = setup();
      h.validateCandidate.mockResolvedValue({
        ok: true,
        serverInfo: { ...NEXT_SERVER_INFO, imessage_provider_epoch: OTHER_EPOCH },
      });

      const result = await approveServerRotation(
        h.requestId,
        'correct-password',
        false,
        withCurrentEpoch(h, CURRENT_EPOCH),
      );

      expect(result).toMatchObject({ ok: false, kind: 'different-server', terminal: true });
      expect(h.persistCandidate).not.toHaveBeenCalled();
      expect(h.publishCandidate).not.toHaveBeenCalled();
    });

    it('refuses an address that cannot say which Messages server it is', async () => {
      const h = setup();
      h.validateCandidate.mockResolvedValue({
        ok: true,
        serverInfo: { ...NEXT_SERVER_INFO, imessage_provider_epoch: null },
      });

      await expect(
        approveServerRotation(
          h.requestId,
          'correct-password',
          false,
          withCurrentEpoch(h, CURRENT_EPOCH),
        ),
      ).resolves.toMatchObject({ ok: false, kind: 'different-server' });
      expect(h.persistCandidate).not.toHaveBeenCalled();
    });

    it('accepts the same Messages server at its new address', async () => {
      const h = setup();
      h.validateCandidate.mockResolvedValue({
        ok: true,
        serverInfo: { ...NEXT_SERVER_INFO, imessage_provider_epoch: CURRENT_EPOCH },
      });

      await expect(
        approveServerRotation(
          h.requestId,
          'correct-password',
          false,
          withCurrentEpoch(h, CURRENT_EPOCH),
        ),
      ).resolves.toEqual({ ok: true });
      expect(h.persistCandidate).toHaveBeenCalledTimes(1);
    });

    it('keeps the earlier behaviour when the current server reports no identity', async () => {
      const h = setup();

      await expect(
        approveServerRotation(h.requestId, 'correct-password', false, withCurrentEpoch(h, null)),
      ).resolves.toEqual({ ok: true });
    });
  });

  it('says when a paired device cannot reach its current server to check the password', async () => {
    const h = setup({ currentPassword: SCOPED_DEVICE_CREDENTIAL });
    h.validateCandidate.mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      message:
        'Could not reach your server. Check the URL and that it is accessible from this device.',
    });

    const result = await approveServerRotation(h.requestId, 'fresh-shared-password', false, h.deps);

    expect(result).toMatchObject({ ok: false, kind: 'validation-failed', terminal: false });
    expect(result.ok ? '' : result.message).toMatch(/current server/i);
    // The new address is never contacted with the device credential.
    expect(h.validateCandidate).toHaveBeenCalledTimes(1);
    expect(h.validateCandidate).toHaveBeenCalledWith(
      'https://current.example',
      'fresh-shared-password',
      expect.any(Function),
    );
  });

  it('does not expose a scoped credential when the shared-password proof fails', async () => {
    const h = setup({ currentPassword: SCOPED_DEVICE_CREDENTIAL });
    h.validateCandidate.mockResolvedValue({
      ok: false,
      kind: 'unauthorized',
      message: 'Unauthorized.',
    });

    await expect(
      approveServerRotation(h.requestId, 'wrong-shared-password', false, h.deps),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, kind: 'password-mismatch', terminal: false }),
    );
    expect(h.validateCandidate).toHaveBeenCalledTimes(1);
    expect(h.validateCandidate).toHaveBeenCalledWith(
      'https://current.example',
      'wrong-shared-password',
      expect.any(Function),
    );
    expect(h.persistCandidate).not.toHaveBeenCalled();
  });

  it('stops a scoped rotation before contacting the candidate when authority changes', async () => {
    const h = setup({ currentPassword: SCOPED_DEVICE_CREDENTIAL });
    h.validateCandidate.mockImplementation(async () => {
      h.setLeaseCurrent(false);
      return { ok: true, serverInfo: SERVER_INFO };
    });

    await expect(
      approveServerRotation(h.requestId, 'fresh-shared-password', false, h.deps),
    ).resolves.toEqual(expect.objectContaining({ ok: false, kind: 'stale' }));
    expect(h.validateCandidate).toHaveBeenCalledTimes(1);
    expect(h.persistCandidate).not.toHaveBeenCalled();
  });

  it('leaves the trusted session unchanged when candidate validation fails', async () => {
    const h = setup();
    h.validateCandidate.mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      message: 'Candidate unavailable.',
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual({
      ok: false,
      kind: 'validation-failed',
      message: 'Candidate unavailable.',
      terminal: false,
    });
    expect(h.validateCandidate).toHaveBeenCalledWith(
      'https://next.example',
      'correct-password',
      expect.any(Function),
    );
    expect(h.persistCandidate).not.toHaveBeenCalled();
    expect(h.session.origin).toBe('https://current.example');
  });

  it('drops a deferred validation result after foreground authority is revoked', async () => {
    const h = setup();
    let resolveValidation!: (result: ConnectResult) => void;
    h.validateCandidate.mockReturnValue(
      new Promise<ConnectResult>((resolve) => {
        resolveValidation = resolve;
      }),
    );
    const approval = approveServerRotation(h.requestId, 'correct-password', false, h.deps);

    h.setForeground(false);
    resolveValidation({ ok: true, serverInfo: SERVER_INFO });

    await expect(approval).resolves.toEqual(expect.objectContaining({ ok: false, kind: 'stale' }));
    expect(h.persistCandidate).not.toHaveBeenCalled();
    expect(h.publishCandidate).not.toHaveBeenCalled();
  });

  it('drops a deferred validation result after the session epoch changes', async () => {
    const h = setup();
    h.validateCandidate.mockImplementation(async () => {
      h.session.epoch += 1;
      return { ok: true, serverInfo: SERVER_INFO };
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual(expect.objectContaining({ ok: false, kind: 'stale' }));
    expect(h.persistCandidate).not.toHaveBeenCalled();
  });

  it('awaits validation, tracked persistence, live publication, and reconnect in order', async () => {
    const h = setup();
    const order: string[] = [];
    h.validateCandidate.mockImplementation(async (_origin, _password, isCurrent) => {
      expect(isCurrent()).toBe(true);
      order.push('validate');
      return { ok: true, serverInfo: SERVER_INFO };
    });
    h.persistCandidate.mockImplementation(async (_origin, _password, info, lease, isCurrent) => {
      expect(info).toBe(SERVER_INFO);
      expect(lease.generation).toBe(4);
      expect(isCurrent()).toBe(true);
      order.push('persist');
      return { ok: true, serverInfo: SERVER_INFO };
    });
    h.moveFcmPushKeyState.mockImplementation(async (fromOrigin, toOrigin, lease, isCurrent) => {
      expect([fromOrigin, toOrigin]).toEqual(['https://current.example', 'https://next.example']);
      expect(lease.generation).toBe(4);
      expect(isCurrent()).toBe(true);
      order.push('move push key');
    });
    h.publishCandidate.mockImplementation((origin: string) => {
      order.push('publish');
      h.session.origin = origin;
    });
    h.reconnect.mockImplementation(async (_lease, isCurrent) => {
      expect(isCurrent()).toBe(true);
      order.push('reconnect');
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual({ ok: true });
    // The V3 push-key record must follow the committed origin before reconnect re-registers push.
    expect(order).toEqual(['validate', 'persist', 'move push key', 'publish', 'reconnect']);
    expect(h.session.origin).toBe('https://next.example');
    expect(h.deps.coordinator.getSnapshot()).toBeNull();
  });

  it('reports a failed live handoff as a terminal reopen message instead of throwing', async () => {
    const h = setup();
    h.publishCandidate.mockImplementationOnce((origin: string) => {
      // The session already moved to the saved address; closing the old socket then threw.
      h.session.origin = origin;
      throw new Error('native socket close failed');
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual({
      ok: false,
      kind: 'reconnect-failed',
      message: 'The server changed, but live updates could not restart. Reopen Gator to retry.',
      terminal: true,
    });
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.deps.coordinator.getSnapshot()).toBeNull();
  });

  it('keeps the exclusive rotation slot while persistence is suspended', async () => {
    const h = setup();
    let resolvePersistence!: (result: ConnectResult) => void;
    h.persistCandidate.mockReturnValue(
      new Promise<ConnectResult>((resolve) => {
        resolvePersistence = resolve;
      }),
    );

    const approval = approveServerRotation(h.requestId, 'correct-password', false, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.persistCandidate).toHaveBeenCalledTimes(1);

    expect(
      h.deps.coordinator.offer(
        'https://second.example',
        'https://current.example',
        9,
        h.deps.captureLease(),
        () => true,
      ),
    ).toBe('already-pending');

    resolvePersistence({ ok: true, serverInfo: SERVER_INFO });
    await expect(approval).resolves.toEqual({ ok: true });
    expect(
      h.deps.coordinator.offer(
        'https://third.example',
        'https://next.example',
        9,
        h.deps.captureLease(),
        () => true,
      ),
    ).toBe('offered');
  });

  it('does not publish or reconnect when account ownership retires during persistence', async () => {
    const h = setup();
    h.persistCandidate.mockImplementation(async () => {
      h.setLeaseCurrent(false);
      return { ok: false, kind: 'cancelled', message: 'cancelled' };
    });

    await expect(
      approveServerRotation(h.requestId, 'correct-password', false, h.deps),
    ).resolves.toEqual(expect.objectContaining({ ok: false, kind: 'stale' }));
    expect(h.moveFcmPushKeyState).not.toHaveBeenCalled();
    expect(h.publishCandidate).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
