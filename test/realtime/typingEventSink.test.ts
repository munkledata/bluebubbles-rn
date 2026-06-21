import type { EventSink, NormalizedEvent } from '@core/realtime';
import { TypingEventSink } from '@/services/realtime/typingEventSink';

const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

describe('TypingEventSink', () => {
  it('routes a typing event to onTyping and short-circuits the inner sink', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onTyping = jest.fn();
    await new TypingEventSink(inner, onTyping).onEvent(
      ev({ type: 'typing-indicator', payload: { chatGuid: 'c1', display: true } }),
      'socket',
    );
    expect(onTyping).toHaveBeenCalledWith('c1', true);
    expect(inner.onEvent).not.toHaveBeenCalled();
  });

  it('falls back to `guid` when `chatGuid` is absent', async () => {
    const onTyping = jest.fn();
    await new TypingEventSink({ onEvent: jest.fn() }, onTyping).onEvent(
      ev({ type: 'typing-indicator', payload: { guid: 'g1', display: false } }),
      'socket',
    );
    expect(onTyping).toHaveBeenCalledWith('g1', false);
  });

  it('delegates non-typing events to the inner sink', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onTyping = jest.fn();
    const event = ev({ type: 'new-message', payload: {} });
    await new TypingEventSink(inner, onTyping).onEvent(event, 'fcm');
    expect(inner.onEvent).toHaveBeenCalledWith(event, 'fcm');
    expect(onTyping).not.toHaveBeenCalled();
  });
});
