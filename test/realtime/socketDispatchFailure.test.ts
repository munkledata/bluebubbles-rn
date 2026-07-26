/**
 * What happens when a socket event handler REJECTS (a failed DB write for an incoming message:
 * FK violation, SQLITE_BUSY, disk full, an FTS trigger error).
 *
 * socket.io handlers are synchronous, so the dispatch is fire-and-forget — and a bare `void`
 * swallows the rejection entirely. The `.catch` here is what keeps the failure visible, but the
 * LEVEL it logs at is the load-bearing part: `ErrorReportSink` captures ONLY `error` lines into
 * the uploadable `error_reports` queue, so a `warn` would leave a lost incoming message as a line
 * in the on-device App Logs and nothing else — and because the rejection is now handled here, the
 * global unhandled-rejection tracker no longer picks it up either. These tests pin both halves:
 * the handler never throws into socket.io, and the report is error-level.
 */
const mockOn = jest.fn();
const mockIo = jest.fn((..._args: unknown[]) => ({
  on: mockOn,
  emit: jest.fn(),
  disconnect: jest.fn(),
  connected: false,
}));
jest.mock('socket.io-client', () => ({ io: mockIo }));

import type { EventSink } from '@core/realtime';
import { logSinks, type LogLevel } from '@core/secure';
import { SocketService } from '@/services/realtime/socketService';

const captured: Array<{ level: LogLevel; message: string }> = [];
logSinks.add({
  write(level, message) {
    captured.push({ level, message });
  },
});

/** The handler SocketService registered for `event`, as socket.io would invoke it. */
function handlerFor(event: string): (data: unknown) => void {
  const call = mockOn.mock.calls.find((c) => c[0] === event);
  expect(call).toBeDefined();
  return call![1] as (data: unknown) => void;
}

describe('SocketService event dispatch failures', () => {
  beforeEach(() => {
    captured.length = 0;
    mockIo.mockClear();
    mockOn.mockClear();
  });

  it('reports a rejecting handler at ERROR level (the only level ErrorReportSink uploads)', async () => {
    const sink: EventSink = {
      onEvent: jest.fn(() => Promise.reject(new Error('disk I/O error'))),
    };
    new SocketService(sink).connect('https://srv', 'pw', {});

    // socket.io invokes the handler synchronously and ignores its return value.
    expect(() =>
      handlerFor('new-message')({ guid: 'g1', text: 'hi', chatGuid: 'c1', dateCreated: 1 }),
    ).not.toThrow();
    // Let the rejection settle through the router into the `.catch`.
    await new Promise((r) => setTimeout(r, 0));

    const line = captured.find((l) => l.message.startsWith('[socket] event handling failed'));
    expect(line).toBeDefined();
    expect(line!.level).toBe('error');
  });

  it('a succeeding handler logs no failure line', async () => {
    const sink: EventSink = { onEvent: jest.fn(async () => {}) };
    new SocketService(sink).connect('https://srv', 'pw', {});

    handlerFor('new-message')({ guid: 'g2', text: 'hi', chatGuid: 'c1', dateCreated: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.some((l) => l.message.startsWith('[socket] event handling failed'))).toBe(false);
  });
});
