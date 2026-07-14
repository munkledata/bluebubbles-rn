import type { EventSink, NormalizedEvent } from '@core/realtime';
import { ServerUrlEventSink } from '@/services/realtime/serverUrlEventSink';

const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

describe('ServerUrlEventSink', () => {
  it('routes a new-server URL rotation to onNewUrl and short-circuits the inner sink', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onNewUrl = jest.fn();
    await new ServerUrlEventSink(inner, onNewUrl).onEvent(
      ev({ type: 'new-server', url: 'https://rotated.example.com' }),
      'socket',
    );
    expect(onNewUrl).toHaveBeenCalledWith('https://rotated.example.com');
    expect(inner.onEvent).not.toHaveBeenCalled();
  });

  it('delegates every other event to the inner sink untouched', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onNewUrl = jest.fn();
    const event = ev({ type: 'new-message', payload: {} });
    await new ServerUrlEventSink(inner, onNewUrl).onEvent(event, 'fcm');
    expect(inner.onEvent).toHaveBeenCalledWith(event, 'fcm');
    expect(onNewUrl).not.toHaveBeenCalled();
  });

  it('propagates an inner-sink failure (does not swallow it)', async () => {
    const inner: EventSink = { onEvent: jest.fn().mockRejectedValue(new Error('db write failed')) };
    await expect(
      new ServerUrlEventSink(inner, jest.fn()).onEvent(ev({ type: 'new-message', payload: {} }), 'socket'),
    ).rejects.toThrow('db write failed');
  });
});
