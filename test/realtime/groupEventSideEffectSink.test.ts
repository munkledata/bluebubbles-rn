import { GroupEventSideEffectSink } from '@/services/realtime/groupEventSideEffectSink';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';

const SOURCE = 'socket' as EventSource;
const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

describe('GroupEventSideEffectSink', () => {
  it('refetches the wallpaper on a background-CHANGED group event (itemType 3, gAT 4)', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    await new GroupEventSideEffectSink(inner, refetch).onEvent(
      ev({ type: 'new-message', message: { itemType: 3, groupActionType: 4, chatGuid: 'chat-1' } }),
      SOURCE,
    );
    expect(refetch).toHaveBeenCalledWith('chat-1');
    // The DB write (inner) must ALWAYS run — the refetch is an add-on side effect.
    expect(inner.onEvent).toHaveBeenCalledTimes(1);
  });

  it('refetches on a background-REMOVED group event (itemType 3, gAT 6) and resolves chats[] guid', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    await new GroupEventSideEffectSink(inner, refetch).onEvent(
      ev({
        type: 'new-message',
        message: { itemType: 3, groupActionType: 6, chats: [{ guid: 'chat-embedded' }] },
      }),
      SOURCE,
    );
    expect(refetch).toHaveBeenCalledWith('chat-embedded');
  });

  it('refetches on an UPDATED-message background change too (not just new-message)', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    await new GroupEventSideEffectSink(inner, refetch).onEvent(
      ev({
        type: 'updated-message',
        message: { itemType: 3, groupActionType: 4, chatGuid: 'chat-2' },
      }),
      SOURCE,
    );
    expect(refetch).toHaveBeenCalledWith('chat-2');
  });

  it('does NOT refetch for a normal message or other itemType-3 actions, but still delegates', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    const sink = new GroupEventSideEffectSink(inner, refetch);
    // normal message
    await sink.onEvent(
      ev({ type: 'new-message', message: { itemType: 0, groupActionType: 0, chatGuid: 'c' } }),
      SOURCE,
    );
    // itemType 3 but a NON-background action (photo change)
    await sink.onEvent(
      ev({ type: 'new-message', message: { itemType: 3, groupActionType: 1, chatGuid: 'c' } }),
      SOURCE,
    );
    // itemType 3 gAT 3 — the server-unconfirmed action must NOT trigger a refetch
    await sink.onEvent(
      ev({ type: 'new-message', message: { itemType: 3, groupActionType: 3, chatGuid: 'c' } }),
      SOURCE,
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(inner.onEvent).toHaveBeenCalledTimes(3);
  });

  it('passes non-message events straight through without a refetch', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    await new GroupEventSideEffectSink(inner, refetch).onEvent(
      ev({ type: 'typing-indicator', payload: { chatGuid: 'c1', display: true } }),
      SOURCE,
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(inner.onEvent).toHaveBeenCalledTimes(1);
  });

  it('skips the refetch when the bg-change message has no resolvable chat guid', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn();
    await new GroupEventSideEffectSink(inner, refetch).onEvent(
      ev({ type: 'new-message', message: { itemType: 3, groupActionType: 4 } }),
      SOURCE,
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(inner.onEvent).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a refetch failure — never throws into the router', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const refetch = jest.fn().mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(
      new GroupEventSideEffectSink(inner, refetch).onEvent(
        ev({
          type: 'new-message',
          message: { itemType: 3, groupActionType: 4, chatGuid: 'chat-1' },
        }),
        SOURCE,
      ),
    ).resolves.toBeUndefined();
    expect(refetch).toHaveBeenCalledWith('chat-1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates an inner-sink failure and does not attempt the refetch', async () => {
    const inner: EventSink = { onEvent: jest.fn().mockRejectedValue(new Error('db write failed')) };
    const refetch = jest.fn();
    await expect(
      new GroupEventSideEffectSink(inner, refetch).onEvent(
        ev({
          type: 'new-message',
          message: { itemType: 3, groupActionType: 4, chatGuid: 'chat-1' },
        }),
        SOURCE,
      ),
    ).rejects.toThrow('db write failed');
    expect(refetch).not.toHaveBeenCalled();
  });
});
