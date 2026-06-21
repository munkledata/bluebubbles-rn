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
  io: { on: jest.Mock; handlers: Map<string, Handler> };
}

let sockets: FakeSocket[] = [];
const mockIo = jest.fn((..._args: unknown[]): FakeSocket => {
  const managerHandlers = new Map<string, Handler>();
  const socket: FakeSocket = {
    on: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connected: false,
    io: {
      handlers: managerHandlers,
      on: jest.fn((event: string, cb: Handler) => managerHandlers.set(event, cb)),
    },
  };
  sockets.push(socket);
  return socket;
});
jest.mock('socket.io-client', () => ({ io: mockIo }));

import type { EventSink } from '@core/realtime';
import { SocketService } from '@/services/realtime/socketService';

const sink: EventSink = { onEvent: jest.fn() };

/** Fire the Manager-level `reconnect_failed` on the most-recently-opened socket. */
function fireReconnectFailed(): void {
  const socket = sockets[sockets.length - 1]!;
  socket.io.handlers.get('reconnect_failed')?.();
}

describe('SocketService reconnect escalation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    mockIo.mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('caps socket.io retries so it can surrender to the app-level ladder', () => {
    new SocketService(sink).connect('https://srv', 'pw', {});
    const opts = mockIo.mock.calls[0]![1] as Record<string, unknown>;
    // A finite count (NOT the socket.io default of Infinity) is what lets the Manager
    // ever emit `reconnect_failed` and reach the escalation.
    expect(typeof opts.reconnectionAttempts).toBe('number');
    expect(opts.reconnectionAttempts as number).toBeGreaterThan(0);
    expect(Number.isFinite(opts.reconnectionAttempts as number)).toBe(true);
  });

  it('re-opens the socket (delayed) when the Manager reports reconnect_failed', () => {
    new SocketService(sink).connect('https://srv', 'pw', {});
    expect(mockIo).toHaveBeenCalledTimes(1);

    // socket.io exhausted its capped retries → Manager fires reconnect_failed.
    fireReconnectFailed();
    // The escalation is scheduled, not immediate (capped backoff).
    expect(mockIo).toHaveBeenCalledTimes(1);

    // Advance past the first backoff (~1s + ≤10% jitter) → a fresh openSocket() runs.
    jest.advanceTimersByTime(1_200);
    expect(mockIo).toHaveBeenCalledTimes(2);
    // The new socket targets the same origin (no refreshUrl hook wired).
    expect(mockIo.mock.calls[1]![0]).toBe('https://srv');
  });

  it('does not escalate after disconnect() (stopped wins the race)', () => {
    const svc = new SocketService(sink);
    svc.connect('https://srv', 'pw', {});
    fireReconnectFailed();
    svc.disconnect(); // cancels the pending escalation timer
    jest.advanceTimersByTime(5_000);
    // Only the original open; no re-open after teardown.
    expect(mockIo).toHaveBeenCalledTimes(1);
  });

  it('uses the refreshUrl hook to reconnect to a new origin', async () => {
    const refreshUrl = jest.fn(async () => 'https://moved');
    new SocketService(sink).connect('https://srv', 'pw', { refreshUrl });

    fireReconnectFailed();
    jest.advanceTimersByTime(1_200);
    // runEscalation awaits refreshUrl(); flush the microtask queue so the re-open lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshUrl).toHaveBeenCalled();
    expect(mockIo).toHaveBeenCalledTimes(2);
    expect(mockIo.mock.calls[1]![0]).toBe('https://moved');
  });
});
