/**
 * What happens when a socket event handler REJECTS (a failed DB write for an incoming message:
 * FK violation, SQLITE_BUSY, disk full, an FTS trigger error).
 *
 * socket.io handlers are synchronous, so the dispatch is fire-and-forget — and a bare `void`
 * swallows the rejection entirely. The `.catch` here is what keeps the failure visible, but the
 * LEVEL it logs at is the load-bearing part: `ErrorReportSink` captures ONLY `error` lines into
 * the uploadable `error_reports` queue, so a `warn` would leave only a development App Logs line
 * (and nothing in a release build). Because the rejection is handled here, the global
 * unhandled-rejection tracker no longer picks it up either. These tests pin both halves:
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

import { EventRouter, type EventSink } from '@core/realtime';
import { logSinks, type LogLevel } from '@core/secure';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { SocketService, type RawRealtimeEventHandler } from '@/services/realtime/socketService';

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

function handlersFor(event: string): Array<(data: unknown) => void> {
  return mockOn.mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as (data: unknown) => void);
}

function rawHandlerForSink(sink: EventSink): RawRealtimeEventHandler {
  const router = new EventRouter(sink);
  return (eventName, rawData, source, context, occurrence) =>
    router.handle(eventName, rawData, source, context, occurrence);
}

describe('SocketService event dispatch failures', () => {
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    captured.length = 0;
    mockIo.mockClear();
    mockOn.mockClear();
  });

  afterEach(async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    jest.restoreAllMocks();
  });

  it('keeps an admitted socket handler in the common account-transition drain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink: EventSink = { onEvent: jest.fn(() => gate) };
    new SocketService(rawHandlerForSink(sink)).connect('https://srv', 'pw', {});

    handlerFor('new-message')({ guid: 'socket-drain', dateCreated: 1 });
    const pause = pauseRealtimeDeliveries();
    let drained = false;
    void pause.then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(sink.onEvent).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    // Admission closed synchronously: a later native callback cannot enter the old account.
    handlerFor('new-message')({ guid: 'socket-too-late', dateCreated: 2 });
    await Promise.resolve();
    expect(sink.onEvent).toHaveBeenCalledTimes(1);

    release();
    await pause;
    expect(drained).toBe(true);
  });

  it('drops an account-A native callback that runs only after account B resumes', async () => {
    const accountASink: EventSink = { onEvent: jest.fn(async () => {}) };
    new SocketService(rawHandlerForSink(accountASink)).connect(
      'https://account-a.example',
      'account-a-password',
      {},
    );
    // Native code already queued this exact A closure, but JS has not entered it yet.
    const queuedAccountACallback = handlerFor('new-message');

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    const accountBSink: EventSink = { onEvent: jest.fn(async () => {}) };
    new SocketService(rawHandlerForSink(accountBSink)).connect(
      'https://account-b.example',
      'account-b-password',
      {},
    );

    queuedAccountACallback({ guid: 'account-a-message', dateCreated: 1 });
    await Promise.resolve();

    expect(accountASink.onEvent).not.toHaveBeenCalled();
    expect(accountBSink.onEvent).not.toHaveBeenCalled();
  });

  it('assigns ordered occurrence ids and resets the sequence on a built-in reconnect', async () => {
    const handle = jest.fn(async (..._args: Parameters<RawRealtimeEventHandler>) => null);
    const rawHandler: RawRealtimeEventHandler = handle;
    const namespaces = ['socket:test-open', 'socket:test-reconnect'];
    const makeNamespace = jest.fn(() => namespaces.shift()!);
    new SocketService(rawHandler, makeNamespace).connect('https://srv', 'pw', {});

    const onConnect = handlerFor('connect');
    const onMessage = handlerFor('new-message');
    // First connect owns the namespace allocated by openSocket().
    onConnect(undefined);
    onMessage({ guid: 'ordered-1' });
    onMessage({ guid: 'ordered-2' });
    // Socket.IO reuses the same object for its built-in reconnect, so the second connect event must
    // rotate the namespace and restart its local sequence.
    onConnect(undefined);
    onMessage({ guid: 'ordered-after-reconnect' });
    await Promise.resolve();

    expect(handle.mock.calls.map((call) => call[4])).toEqual([
      { transportOccurrenceId: 'socket:test-open:1' },
      { transportOccurrenceId: 'socket:test-open:2' },
      { transportOccurrenceId: 'socket:test-reconnect:1' },
    ]);
    expect(handle.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['new-message', { guid: 'ordered-1' }, 'socket'],
      ['new-message', { guid: 'ordered-2' }, 'socket'],
      ['new-message', { guid: 'ordered-after-reconnect' }, 'socket'],
    ]);
    expect(makeNamespace).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh namespace for a new open and rejects its retired native callback', async () => {
    const handle = jest.fn(async (..._args: Parameters<RawRealtimeEventHandler>) => null);
    const rawHandler: RawRealtimeEventHandler = handle;
    const namespaces = ['socket:first-open', 'socket:second-open'];
    const makeNamespace = jest.fn(() => namespaces.shift()!);
    const service = new SocketService(rawHandler, makeNamespace);

    service.connect('https://first.example', 'pw-a', {});
    const retiredCallback = handlersFor('new-message')[0]!;
    retiredCallback({ guid: 'first-live' });

    service.connect('https://second.example', 'pw-b', {});
    const currentCallback = handlersFor('new-message')[1]!;
    // Native code may already have queued this closure, but its captured lifecycle is retired.
    retiredCallback({ guid: 'first-too-late' });
    currentCallback({ guid: 'second-live' });
    await Promise.resolve();

    expect(handle.mock.calls.map((call) => call[1])).toEqual([
      { guid: 'first-live' },
      { guid: 'second-live' },
    ]);
    expect(handle.mock.calls.map((call) => call[4])).toEqual([
      { transportOccurrenceId: 'socket:first-open:1' },
      { transportOccurrenceId: 'socket:second-open:1' },
    ]);
    expect(makeNamespace).toHaveBeenCalledTimes(2);
  });

  it('reports a rejecting handler at ERROR level (the only level ErrorReportSink uploads)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const sink: EventSink = {
      onEvent: jest.fn(() => Promise.reject(new Error('disk I/O error'))),
    };
    new SocketService(rawHandlerForSink(sink)).connect('https://srv', 'pw', {});

    // socket.io invokes the handler synchronously and ignores its return value.
    expect(() =>
      handlerFor('new-message')({ guid: 'g1', text: 'hi', chatGuid: 'c1', dateCreated: 1 }),
    ).not.toThrow();
    // Let the rejection settle through the router into the `.catch`.
    await new Promise((r) => setTimeout(r, 0));

    const line = captured.find((l) => l.message.startsWith('socket.event_handling_failed'));
    expect(line).toBeDefined();
    expect(line!.level).toBe('error');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not report an account-A rejection after Disconnect revokes its delivery lease', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    let rejectDelivery!: (reason: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const sink: EventSink = { onEvent: jest.fn(() => gate) };
    new SocketService(rawHandlerForSink(sink)).connect('https://srv', 'pw', {});

    handlerFor('new-message')({ guid: 'account-a-event', dateCreated: 1 });
    const pause = pauseRealtimeDeliveries();
    rejectDelivery(new Error('old account DB was retired'));
    await pause;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.some((line) => line.message.startsWith('socket.event_handling_failed'))).toBe(
      false,
    );
    expect(
      captured.some((line) =>
        line.message.startsWith('[socket] event failure retired during account transition'),
      ),
    ).toBe(true);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith(
      '[socket] event failure retired during account transition',
      { event: 'new-message' },
    );
  });

  it('a succeeding handler logs no failure line', async () => {
    const sink: EventSink = { onEvent: jest.fn(async () => {}) };
    new SocketService(rawHandlerForSink(sink)).connect('https://srv', 'pw', {});

    handlerFor('new-message')({ guid: 'g2', text: 'hi', chatGuid: 'c1', dateCreated: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.some((l) => l.message.startsWith('socket.event_handling_failed'))).toBe(false);
  });
});
