/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
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

import { SocketService, type RawRealtimeEventHandler } from '@/services/realtime/socketService';

const handleRawEvent: RawRealtimeEventHandler = async () => null;

function lastIoOptions(): Record<string, unknown> {
  const { calls } = mockIo.mock;
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}

describe('SocketService auth mode', () => {
  beforeEach(() => {
    mockIo.mockClear();
    mockEmit.mockClear();
  });

  it('secure default: sends a shared password in auth.password and no query', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw', {
      headers: { Authorization: 'Bearer pw' },
    });
    const opts = lastIoOptions();
    expect(opts.auth).toEqual({ password: 'pw' });
    expect(opts.query).toBeUndefined();
    expect(opts.extraHeaders).toEqual({ Authorization: 'Bearer pw' });
  });

  it('sends an exact scoped device credential in auth.token and no query', () => {
    const token = `bbd_device_v1_${'A_-b'.repeat(10)}Abc`;
    expect(token).toHaveLength('bbd_device_v1_'.length + 43);
    new SocketService(handleRawEvent).connect('https://srv', token, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const opts = lastIoOptions();
    expect(opts.auth).toEqual({ token });
    expect(opts.query).toBeUndefined();
    expect(opts.extraHeaders).toEqual({ Authorization: `Bearer ${token}` });
  });

  it('rejects a scoped device credential instead of leaking it through legacy query auth', () => {
    const token = `bbd_device_v1_${'z'.repeat(43)}`;
    const service = new SocketService(handleRawEvent);

    expect(() => service.connect('https://srv', token, { legacyQueryAuth: true })).toThrow(
      'Scoped device credentials require Socket.IO auth.token',
    );
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('rejects an invalid scoped reconnect before retiring the existing socket', () => {
    const service = new SocketService(handleRawEvent);
    service.connect('https://current.example', 'current-shared-password');
    const currentSocket = mockIo.mock.results[0]!.value as { disconnect: jest.Mock };
    const token = `bbd_device_v1_${'q'.repeat(43)}`;

    expect(() =>
      service.connect('https://replacement.example', token, { legacyQueryAuth: true }),
    ).toThrow('Scoped device credentials require Socket.IO auth.token');

    expect(currentSocket.disconnect).not.toHaveBeenCalled();
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenLastCalledWith(
      'https://current.example',
      expect.objectContaining({ auth: { password: 'current-shared-password' } }),
    );
  });

  it('legacy mode: sends a ?guid= query and no auth payload', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw', { legacyQueryAuth: true });
    const opts = lastIoOptions();
    expect(opts.query).toEqual({ guid: 'pw' });
    expect(opts.auth).toBeUndefined();
  });

  it('never places the password in the connection origin (URL)', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw', { legacyQueryAuth: false });
    expect(mockIo.mock.calls[0]![0]).toBe('https://srv');
  });

  it('releases its retained credential snapshot on terminal disconnect', () => {
    const svc = new SocketService(handleRawEvent);
    svc.connect('https://account-a.example', 'account-a-password', {
      headers: { Authorization: 'Bearer account-a-password' },
    });

    svc.disconnect();

    const retained = svc as unknown as {
      origin: string;
      password: string;
      opts: { headers?: Readonly<Record<string, string>> };
    };
    expect(retained.origin).toBe('');
    expect(retained.password).toBe('');
    expect(retained.opts).toEqual({});
  });

  it('releases the credential snapshot even when native disconnect throws', () => {
    const svc = new SocketService(handleRawEvent);
    svc.connect('https://account-a.example', 'account-a-password', {
      headers: { Authorization: 'Bearer account-a-password' },
    });
    const socket = mockIo.mock.results[mockIo.mock.results.length - 1]!.value as {
      disconnect: jest.Mock;
    };
    socket.disconnect.mockImplementationOnce(() => {
      throw new Error('native disconnect sentinel');
    });

    expect(() => svc.disconnect()).toThrow('native disconnect sentinel');

    const retained = svc as unknown as {
      origin: string;
      password: string;
      opts: { headers?: Readonly<Record<string, string>> };
    };
    expect(retained.origin).toBe('');
    expect(retained.password).toBe('');
    expect(retained.opts).toEqual({});
  });

  it('emit() forwards to the socket; no-op before connect', () => {
    const svc = new SocketService(handleRawEvent);
    svc.emit('started-typing', { chatGuid: 'c1' }); // not connected → no throw, no call
    expect(mockEmit).not.toHaveBeenCalled();
    svc.connect('https://srv', 'pw', {});
    svc.emit('started-typing', { chatGuid: 'c1' });
    expect(mockEmit).toHaveBeenCalledWith('started-typing', { chatGuid: 'c1' });
  });
});
