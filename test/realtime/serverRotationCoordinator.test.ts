import { ServerRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

function harness(): {
  coordinator: ServerRotationCoordinator;
  lease: RealtimeDeliveryLease;
  invalidate: () => void;
  setCurrent: (value: boolean) => void;
} {
  let leaseCurrent = true;
  let foregroundCurrent = true;
  let invalidation: (() => void) | null = null;
  const coordinator = new ServerRotationCoordinator((_generation, listener) => {
    invalidation = listener;
    return () => {
      if (invalidation === listener) invalidation = null;
    };
  });
  const lease: RealtimeDeliveryLease = { generation: 7, isCurrent: () => leaseCurrent };
  return {
    coordinator,
    lease,
    invalidate: () => {
      leaseCurrent = false;
      invalidation?.();
    },
    setCurrent: (value) => {
      foregroundCurrent = value;
    },
  };
}

describe('ServerRotationCoordinator', () => {
  it.each([
    ['same origin', 'https://current.example/', 'same-origin'],
    ['malformed URL', 'https://current.example/path', 'invalid'],
    ['HTTPS downgrade', 'http://current.example', 'downgrade-rejected'],
  ] as const)('does not stage %s', (_label, candidate, expected) => {
    const { coordinator, lease } = harness();

    expect(coordinator.offer(candidate, 'https://current.example', 12, lease, () => true)).toBe(
      expected,
    );
    expect(coordinator.getSnapshot()).toBeNull();
  });

  it('stages only the canonical, non-secret proposal fields', () => {
    const { coordinator, lease } = harness();

    expect(
      coordinator.offer(
        'HTTPS://NEXT.EXAMPLE:443/',
        'https://current.example',
        12,
        lease,
        () => true,
      ),
    ).toBe('offered');
    expect(coordinator.getSnapshot()).toEqual({
      id: 1,
      currentOrigin: 'https://current.example',
      candidateOrigin: 'https://next.example',
      sessionEpoch: 12,
      deliveryGeneration: 7,
      requiresCleartextApproval: false,
    });
  });

  it('does not stage when foreground authority is absent', () => {
    const { coordinator, lease } = harness();

    expect(
      coordinator.offer('https://next.example', 'https://current.example', 12, lease, () => false),
    ).toBe('not-foreground');
    expect(coordinator.getSnapshot()).toBeNull();
  });

  it('keeps the first live proposal instead of letting later events replace visible consent', () => {
    const { coordinator, lease } = harness();
    coordinator.offer('https://first.example', 'https://current.example', 12, lease, () => true);

    expect(
      coordinator.offer('https://second.example', 'https://current.example', 12, lease, () => true),
    ).toBe('already-pending');
    expect(coordinator.getSnapshot()?.candidateOrigin).toBe('https://first.example');
  });

  it('retires the proposal synchronously with its account generation', () => {
    const { coordinator, lease, invalidate } = harness();
    const listener = jest.fn();
    coordinator.subscribe(listener);
    coordinator.offer('https://next.example', 'https://current.example', 12, lease, () => true);
    listener.mockClear();

    invalidate();

    expect(coordinator.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('makes a retained approval inert after foreground/session authority is revoked', () => {
    let current = true;
    const { coordinator, lease } = harness();
    coordinator.offer('https://next.example', 'https://current.example', 12, lease, () => current);
    const requestId = coordinator.getSnapshot()!.id;

    current = false;

    expect(coordinator.current(requestId)).toBeNull();
    expect(coordinator.getSnapshot()).toBeNull();
  });

  it('requires the matching request id to cancel', () => {
    const { coordinator, lease } = harness();
    coordinator.offer('http://next.lan:1234', 'http://current.lan:1234', 12, lease, () => true);
    const request = coordinator.getSnapshot()!;
    expect(request.requiresCleartextApproval).toBe(true);

    coordinator.cancel(request.id + 1);
    expect(coordinator.getSnapshot()).toBe(request);
    coordinator.cancel(request.id);
    expect(coordinator.getSnapshot()).toBeNull();
  });

  it('claims only the matching live request and removes it from the UI handoff', () => {
    const { coordinator, lease } = harness();
    coordinator.offer('https://next.example', 'https://current.example', 12, lease, () => true);
    const request = coordinator.getSnapshot()!;

    expect(coordinator.claim(request.id + 1)).toBeNull();
    expect(coordinator.claim(request.id)).toBe(request);
    expect(coordinator.getSnapshot()).toBeNull();
    expect(coordinator.claim(request.id)).toBeNull();

    expect(
      coordinator.offer('https://second.example', 'https://current.example', 12, lease, () => true),
    ).toBe('already-pending');
    coordinator.finish(request.id + 1);
    expect(
      coordinator.offer('https://second.example', 'https://current.example', 12, lease, () => true),
    ).toBe('already-pending');

    coordinator.finish(request.id);
    expect(
      coordinator.offer('https://second.example', 'https://current.example', 12, lease, () => true),
    ).toBe('offered');
  });
});
