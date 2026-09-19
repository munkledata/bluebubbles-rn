/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * SocketService auth wiring. Credentials belong in the handshake `auth` payload, never
 * the URL query. These tests pin the shared-password and scoped-device forms so a regression
 * cannot silently leak either credential into a URL.
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

describe('SocketService auth', () => {
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

  it('never places the password in the connection origin (URL)', () => {
    new SocketService(handleRawEvent).connect('https://srv', 'pw');
    expect(mockIo.mock.calls[0]![0]).toBe('https://srv');
    expect(lastIoOptions().query).toBeUndefined();
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
