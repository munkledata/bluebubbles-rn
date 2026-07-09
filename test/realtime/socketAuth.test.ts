/**
 * SocketService auth-mode wiring. The secure default puts the password in the
 * handshake `auth` payload (never the URL); legacy mode falls back to a `?guid=`
 * query for a stock/old server that only reads the legacy param. These
 * tests assert the exact `io()` options for each mode so a regression can't silently
 * leak the password into the URL (or break stock-server connectivity).
 */
const mockEmit = jest.fn();
const mockIo = jest.fn((..._args: unknown[]) => ({
  on: jest.fn(),
  emit: mockEmit,
  disconnect: jest.fn(),
  connected: false,
}));
jest.mock('socket.io-client', () => ({ io: mockIo }));

import type { EventSink } from '@core/realtime';
import { SocketService } from '@/services/realtime/socketService';

const sink: EventSink = { onEvent: jest.fn() };

function lastIoOptions(): Record<string, unknown> {
  const { calls } = mockIo.mock;
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}

describe('SocketService auth mode', () => {
  beforeEach(() => {
    mockIo.mockClear();
    mockEmit.mockClear();
  });

  it('secure default: sends the auth payload and no query', () => {
    new SocketService(sink).connect('https://srv', 'pw', {
      headers: { Authorization: 'Bearer pw' },
    });
    const opts = lastIoOptions();
    expect(opts.auth).toEqual({ password: 'pw' });
    expect(opts.query).toBeUndefined();
    expect(opts.extraHeaders).toEqual({ Authorization: 'Bearer pw' });
  });

  it('legacy mode: sends a ?guid= query and no auth payload', () => {
    new SocketService(sink).connect('https://srv', 'pw', { legacyQueryAuth: true });
    const opts = lastIoOptions();
    expect(opts.query).toEqual({ guid: 'pw' });
    expect(opts.auth).toBeUndefined();
  });

  it('never places the password in the connection origin (URL)', () => {
    new SocketService(sink).connect('https://srv', 'pw', { legacyQueryAuth: false });
    expect(mockIo.mock.calls[0]![0]).toBe('https://srv');
  });

  it('emit() forwards to the socket; no-op before connect', () => {
    const svc = new SocketService(sink);
    svc.emit('started-typing', { chatGuid: 'c1' }); // not connected → no throw, no call
    expect(mockEmit).not.toHaveBeenCalled();
    svc.connect('https://srv', 'pw', {});
    svc.emit('started-typing', { chatGuid: 'c1' });
    expect(mockEmit).toHaveBeenCalledWith('started-typing', { chatGuid: 'c1' });
  });
});
