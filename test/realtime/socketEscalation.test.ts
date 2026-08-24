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
  emit: jest.Mock;
  disconnect: jest.Mock;
  connected: boolean;
  handlers: Map<string, Handler>;
  io: { on: jest.Mock; handlers: Map<string, Handler> };
}

let sockets: FakeSocket[] = [];
const mockIo = jest.fn((..._args: unknown[]): FakeSocket => {
  const managerHandlers = new Map<string, Handler>();
  const handlers = new Map<string, Handler>();
  const socket: FakeSocket = {
    on: jest.fn((event: string, cb: Handler) => handlers.set(event, cb)),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connected: false,
    handlers,
    io: {
      handlers: managerHandlers,
      on: jest.fn((event: string, cb: Handler) => managerHandlers.set(event, cb)),
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
  socket.io.handlers.get('reconnect_failed')?.();
}

/** Fire a Socket-level native callback on the most-recently-opened socket. */
function fireSocketEvent(event: string, ...args: unknown[]): void {
  const socket = sockets[sockets.length - 1]!;
  socket.handlers.get(event)?.(...args);
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
    const retiredEvent = retiredSocket.handlers.get('new-message')!;
    const retiredReconnect = retiredSocket.io.handlers.get('reconnect_failed')!;

    retiredReconnect();
    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);

    // Native callbacks already queued by the retired instance must not reach durable intake or
    // schedule a second escalation against its replacement.
    retiredEvent({ guid: 'stale' });
    retiredReconnect();
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
