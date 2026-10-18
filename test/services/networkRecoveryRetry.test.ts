/**
 * Review M116: when the device network comes back, the live socket is restarted right away instead
 * of waiting out its capped reconnect backoff (up to about a minute), during which the banner kept
 * saying "Connection problem" although the server was reachable again.
 */
import { startNetworkRecoveryRetry } from '@/services/realtime/networkRecoveryRetry';
import { useTransportHealthStore } from '@state/transportHealthStore';

const store = () => useTransportHealthStore.getState();

/** A foreground lifecycle whose socket gave up while the network was down. */
function brokenSocketWhileOffline(socket: 'error' | 'reconnecting' = 'error'): number {
  const generation = store().beginLifecycle();
  store().setNetworkState(generation, 'offline');
  store().setSocketState(generation, socket);
  return generation;
}

beforeEach(() => {
  jest.useFakeTimers();
  store().reset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('startNetworkRecoveryRetry', () => {
  it.each(['error', 'reconnecting'] as const)(
    'restarts a %s socket once when the network comes back',
    (socket) => {
      const retry = jest.fn(() => true);
      const stop = startNetworkRecoveryRetry(retry);
      const generation = brokenSocketWhileOffline(socket);

      store().setNetworkState(generation, 'online');
      // Deferred one tick so the network publication and its own reachability probe finish first.
      expect(retry).not.toHaveBeenCalled();
      store().setServerState(generation, 'reachable');
      jest.runOnlyPendingTimers();

      expect(retry).toHaveBeenCalledTimes(1);
      stop();
    },
  );

  it.each(['connected', 'auth-rejected'] as const)('leaves a %s socket alone', (socket) => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    const generation = brokenSocketWhileOffline();
    store().setSocketState(generation, socket);

    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it('does not treat the first network snapshot (unknown to online) as a recovery', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    const generation = store().beginLifecycle();
    store().setSocketState(generation, 'error');

    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it('skips a recovery whose lifecycle was paused or replaced before the deferred tick', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);

    let generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');
    store().pause();
    jest.runOnlyPendingTimers();

    generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');
    store().beginLifecycle();
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it('skips the retry when the socket reconnected on its own before the deferred tick', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    const generation = brokenSocketWhileOffline();

    store().setNetworkState(generation, 'online');
    store().setSocketState(generation, 'connected');
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it('skips the retry when the network dropped again before the deferred tick', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    const generation = brokenSocketWhileOffline();

    store().setNetworkState(generation, 'online');
    store().setNetworkState(generation, 'offline');
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it('retries once for a network that flaps back online within the same tick', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    const generation = brokenSocketWhileOffline();

    store().setNetworkState(generation, 'online');
    store().setNetworkState(generation, 'offline');
    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();

    expect(retry).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops watching, and cancels a pending retry, when stopped', () => {
    const retry = jest.fn(() => true);
    const stop = startNetworkRecoveryRetry(retry);
    let generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');

    stop();
    jest.runOnlyPendingTimers();
    generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();

    expect(retry).not.toHaveBeenCalled();
  });

  it('keeps watching after a retry that throws', () => {
    const retry = jest
      .fn<boolean, []>()
      .mockImplementationOnce(() => {
        throw new Error('socket bridge unavailable');
      })
      .mockReturnValue(true);
    const stop = startNetworkRecoveryRetry(retry);

    let generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();
    generation = brokenSocketWhileOffline();
    store().setNetworkState(generation, 'online');
    jest.runOnlyPendingTimers();

    expect(retry).toHaveBeenCalledTimes(2);
    stop();
  });
});
