import type { ServerInfo } from '@core/models';
import type { ConnectResult } from '@/services/connection';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { ServerRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
import {
  approveServerRotation,
  type ServerRotationExecutorDeps,
} from '@/services/realtime/serverRotationExecutor';

const SERVER_INFO = { server_version: '1.0.0' } as ServerInfo;

function setup(options: { currentOrigin?: string; candidateOrigin?: string } = {}): {
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
    password: 'correct-password' as string | null,
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
    publishCandidate,
    reconnect,
  };
}

describe('approveServerRotation', () => {
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
    expect(order).toEqual(['validate', 'persist', 'publish', 'reconnect']);
    expect(h.session.origin).toBe('https://next.example');
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
    expect(h.publishCandidate).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
