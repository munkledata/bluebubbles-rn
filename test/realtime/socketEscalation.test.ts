/**
 * Reconnect-escalation wiring (Phase 1.1) — the integration half of the socket
 * robustness work that the pure backoff schedule (socketBackoff.test.ts) can't cover.
 *
 * The escalation ladder is ONLY reachable because openSocket() caps socket.io's built-in
 * retries (`reconnectionAttempts`); otherwise the Manager's `reconnect_failed` event
 * (the sole trigger for scheduleEscalation) never fires. These tests assert both halves:
 *   1. openSocket() passes a FINITE reconnectionAttempts so socket.io surrenders to us.
 *   2. when the Manager emits `reconnect_failed`, a delayed re-open of the socket happens
 *      after the capped-backoff (nextSocketBackoffMs(0) ≈ 1s, jitter ≤ 10%).
 */
type Handler = (...args: unknown[]) => void;

/** A fake socket whose Manager (`io`) we can drive `reconnect_failed` through. */
interface FakeSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connected: boolean;
  active: boolean;
  handlers: Map<string, Handler[]>;
  io: { on: jest.Mock; off: jest.Mock; handlers: Map<string, Handler[]> };
}

let sockets: FakeSocket[] = [];
const mockIo = jest.fn((..._args: unknown[]): FakeSocket => {
  const managerHandlers = new Map<string, Handler[]>();
  const handlers = new Map<string, Handler[]>();
  const addHandler = (target: Map<string, Handler[]>, event: string, handler: Handler): void => {
    target.set(event, [...(target.get(event) ?? []), handler]);
  };
  const removeHandler = (target: Map<string, Handler[]>, event: string, handler: Handler): void => {
    target.set(
      event,
      (target.get(event) ?? []).filter((candidate) => candidate !== handler),
    );
  };
  const socket: FakeSocket = {
    on: jest.fn((event: string, cb: Handler) => addHandler(handlers, event, cb)),
    off: jest.fn((event: string, cb: Handler) => removeHandler(handlers, event, cb)),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connected: false,
    active: true,
    handlers,
    io: {
      handlers: managerHandlers,
      on: jest.fn((event: string, cb: Handler) => addHandler(managerHandlers, event, cb)),
      off: jest.fn((event: string, cb: Handler) => removeHandler(managerHandlers, event, cb)),
    },
  };
  sockets.push(socket);
  return socket;
});
jest.mock('socket.io-client', () => ({ io: mockIo }));

import { logger } from '@core/secure';
import { SocketService, type RawRealtimeEventHandler } from '@/services/realtime/socketService';

const handleRawEvent: RawRealtimeEventHandler = async () => null;

/** Fire the Manager-level `reconnect_failed` on the most-recently-opened socket. */
function fireReconnectFailed(): void {
  const socket = sockets[sockets.length - 1]!;
  for (const handler of socket.io.handlers.get('reconnect_failed') ?? []) handler();
}

function fireManagerEvent(event: string, ...args: unknown[]): void {
  const socket = sockets[sockets.length - 1]!;
  for (const handler of socket.io.handlers.get(event) ?? []) handler(...args);
}

/** Fire a Socket-level native callback on the most-recently-opened socket. */
function fireSocketEvent(event: string, ...args: unknown[]): void {
  const socket = sockets[sockets.length - 1]!;
  for (const handler of socket.handlers.get(event) ?? []) handler(...args);
}

describe('SocketService reconnect escalation', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    mockIo.mockClear();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('caps socket.io retries so it can surrender to the app-level ladder', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw', {});
    const opts = mockIo.mock.calls[0]![1] as Record<string, unknown>;
    // A finite count (NOT the socket.io default of Infinity) is what lets the Manager
    // ever emit `reconnect_failed` and reach the escalation.
    expect(typeof opts.reconnectionAttempts).toBe('number');
    expect(opts.reconnectionAttempts as number).toBeGreaterThan(0);
    expect(Number.isFinite(opts.reconnectionAttempts as number)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('publishes the finite connect, drop, retry, and recovery lifecycle', () => {
    const onLifecycleEvent = jest.fn();
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.observeLifecycle(onLifecycleEvent);

    fireSocketEvent('connect');
    fireSocketEvent('disconnect', 'transport close');
    fireManagerEvent('reconnect_attempt', 1);
    fireSocketEvent('connect');

    expect(onLifecycleEvent.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'connecting' },
      { phase: 'connected', recovered: false },
      { phase: 'reconnecting' },
      { phase: 'reconnecting' },
      { phase: 'connected', recovered: true },
    ]);
  });

  it('keeps an intentional terminal disconnect silent', () => {
    const onLifecycleEvent = jest.fn();
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.observeLifecycle(onLifecycleEvent);
    fireSocketEvent('connect');
    onLifecycleEvent.mockClear();

    service.disconnect();
    fireSocketEvent('disconnect', 'io client disconnect');

    expect(onLifecycleEvent).not.toHaveBeenCalled();
  });

  it('re-opens the socket (delayed) when the Manager reports reconnect_failed', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw', {});
    expect(mockIo).toHaveBeenCalledTimes(1);

    // socket.io exhausted its capped retries → Manager fires reconnect_failed.
    fireReconnectFailed();
    // The escalation is scheduled, not immediate (capped backoff).
    expect(mockIo).toHaveBeenCalledTimes(1);

    // Advance past the first backoff (~1s + ≤10% jitter) → a fresh openSocket() runs.
    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);
    // The new socket remains pinned to the already-approved origin.
    expect(mockIo.mock.calls[1]![0]).toBe('https://srv');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[socket\] reconnect attempts exhausted .+ restarting in \d+ms$/),
    );
  });

  it('manually retries immediately with the same approved transport and a fresh event namespace', async () => {
    const handle = jest.fn(async (..._args: Parameters<RawRealtimeEventHandler>) => null);
    const namespaces = ['socket:before-manual-retry', 'socket:after-manual-retry'];
    const makeNamespace = jest.fn(() => namespaces.shift()!);
    const onLifecycleEvent = jest.fn();
    const service = new SocketService(handle, makeNamespace);
    service.connect('https://trusted.example', 'account-password', {
      headers: { 'X-Client': 'gator' },
    });
    const stopObserving = service.observeLifecycle(onLifecycleEvent);
    const retiredSocket = sockets[0]!;
    const retiredEvent = retiredSocket.handlers.get('new-message')![0]!;
    retiredSocket.disconnect.mockImplementationOnce(() => {
      // Some native bridges can synchronously flush one final event from disconnect(). Retry must
      // fence that callback before crossing the native boundary, not only after disconnect returns.
      retiredEvent({ guid: 'retired-during-disconnect' });
    });
    fireSocketEvent('connect');
    onLifecycleEvent.mockClear();

    expect(service.retryConnection()).toBe(true);

    expect(retiredSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledTimes(2);
    expect(mockIo.mock.calls[1]).toEqual([
      'https://trusted.example',
      expect.objectContaining({
        auth: { password: 'account-password' },
        extraHeaders: { 'X-Client': 'gator' },
      }),
    ]);
    expect(onLifecycleEvent).toHaveBeenCalledWith({ phase: 'reconnecting' });

    retiredEvent({ guid: 'retired' });
    fireSocketEvent('new-message', { guid: 'current' });
    await Promise.resolve();
    await Promise.resolve();

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[1]).toEqual({ guid: 'current' });
    expect(handle.mock.calls[0]?.[4]).toEqual({
      transportOccurrenceId: 'socket:after-manual-retry:1',
    });
    expect(makeNamespace).toHaveBeenCalledTimes(2);

    const callsBeforeStop = onLifecycleEvent.mock.calls.length;
    stopObserving();
    fireSocketEvent('connect');
    expect(onLifecycleEvent).toHaveBeenCalledTimes(callsBeforeStop);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a manual retry after terminal disconnect', () => {
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.disconnect();

    expect(service.retryConnection()).toBe(false);
    expect(mockIo).toHaveBeenCalledTimes(1);
  });

  it('publishes error while retries are exhausted, then reconnecting when escalation opens', () => {
    const onLifecycleEvent = jest.fn();
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.observeLifecycle(onLifecycleEvent);
    fireSocketEvent('connect');
    onLifecycleEvent.mockClear();

    fireReconnectFailed();
    expect(onLifecycleEvent).toHaveBeenLastCalledWith({ phase: 'error' });

    jest.advanceTimersByTime(1_200);
    expect(onLifecycleEvent).toHaveBeenLastCalledWith({ phase: 'reconnecting' });

    fireSocketEvent('connect');
    expect(onLifecycleEvent).toHaveBeenLastCalledWith({ phase: 'connected', recovered: true });
  });

  it('escalates a server-forced disconnect that Socket.IO will not retry itself', () => {
    const onLifecycleEvent = jest.fn();
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.observeLifecycle(onLifecycleEvent);
    const opened = sockets[0]!;
    opened.active = false;
    onLifecycleEvent.mockClear();

    fireSocketEvent('disconnect', 'io server disconnect');
    expect(onLifecycleEvent).toHaveBeenCalledWith({ phase: 'reconnecting' });
    expect(mockIo).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);
  });

  it('contains a throwing lifecycle observer without breaking the socket', () => {
    const onLifecycleEvent = jest.fn(() => {
      throw new Error('observer sentinel');
    });
    const service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});

    expect(() => service.observeLifecycle(onLifecycleEvent)).not.toThrow();
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[socket] lifecycle observer failed', {
      phase: 'connecting',
      errorName: 'Error',
    });
  });

  it('does not reopen if a reconnecting observer terminally stops the service', () => {
    let service!: SocketService;
    const onLifecycleEvent = jest.fn(({ phase }: { phase: string }) => {
      if (phase === 'reconnecting') service.disconnect();
    });
    service = new SocketService(handleRawEvent);
    service.connect('https://srv', 'pw', {});
    service.observeLifecycle(onLifecycleEvent);

    fireReconnectFailed();
    jest.advanceTimersByTime(1_200);

    expect(mockIo).toHaveBeenCalledTimes(1);
  });

  it('assigns a fresh occurrence namespace when escalation re-opens the socket', async () => {
    const handle = jest.fn(async (..._args: Parameters<RawRealtimeEventHandler>) => null);
    const namespaces = ['socket:before-escalation', 'socket:after-escalation'];
    const makeNamespace = jest.fn(() => namespaces.shift()!);
    new SocketService(handle, makeNamespace).connect('https://srv', 'pw', {});

    fireSocketEvent('new-message', { guid: 'before' });
    fireReconnectFailed();
    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);
    fireSocketEvent('new-message', { guid: 'after' });
    await Promise.resolve();

    expect(handle.mock.calls.map((call) => call[4])).toEqual([
      { transportOccurrenceId: 'socket:before-escalation:1' },
      { transportOccurrenceId: 'socket:after-escalation:1' },
    ]);
    expect(makeNamespace).toHaveBeenCalledTimes(2);
  });

  it('retires callbacks owned by the socket that escalation replaces', async () => {
    const handle = jest.fn(async (..._args: Parameters<RawRealtimeEventHandler>) => null);
    new SocketService(handle).connect('https://srv', 'pw', {});
    const retiredSocket = sockets[0]!;
    const retiredEvent = retiredSocket.handlers.get('new-message')![0]!;
    const retiredReconnect = [...retiredSocket.io.handlers.get('reconnect_failed')!];

    for (const handler of retiredReconnect) handler();
    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);

    // Native callbacks already queued by the retired instance must not reach durable intake or
    // schedule a second escalation against its replacement.
    retiredEvent({ guid: 'stale' });
    for (const handler of retiredReconnect) handler();
    jest.advanceTimersByTime(5_000);
    fireSocketEvent('new-message', { guid: 'current' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![1]).toEqual({ guid: 'current' });
  });

  it('does not escalate after disconnect() (stopped wins the race)', () => {
    const svc = new SocketService(handleRawEvent);
    svc.connect('https://srv', 'pw', {});
    fireReconnectFailed();
    svc.disconnect(); // cancels the pending escalation timer
    jest.advanceTimersByTime(5_000);
    // Only the original open; no re-open after teardown.
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not report a late native connection error after disconnect()', () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const svc = new SocketService(handleRawEvent);
    svc.connect('https://srv', 'pw', {});

    svc.disconnect();
    fireSocketEvent('connect_error', new Error('account A socket closed'));

    expect(error).not.toHaveBeenCalled();
  });

  it('keeps repeated escalations pinned to the approved origin and password', () => {
    new SocketService(handleRawEvent).connect('https://trusted.example', 'account-password', {});

    fireReconnectFailed();
    jest.advanceTimersByTime(1_200);
    fireReconnectFailed();
    jest.advanceTimersByTime(2_500);

    expect(mockIo).toHaveBeenCalledTimes(3);
    for (const call of mockIo.mock.calls) {
      expect(call).toEqual([
        'https://trusted.example',
        expect.objectContaining({ auth: { password: 'account-password' } }),
      ]);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
