import { FaceTimeEventSink } from '@/services/realtime/faceTimeEventSink';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

const SOURCE = 'socket' as EventSource;

function setup() {
  const innerCalls: NormalizedEvent[] = [];
  const inner: EventSink = { onEvent: async (e) => void innerCalls.push(e) };
  const sink = new FaceTimeEventSink(inner);
  return { sink, innerCalls };
}

describe('FaceTimeEventSink', () => {
  it('drops every helper-originated FaceTime event before downstream effects', async () => {
    const { sink, innerCalls } = setup();

    await sink.onEvent(
      {
        type: 'incoming-facetime',
        payload: { uuid: 'retired-1', caller: 'Stale caller', is_audio: false },
      } as NormalizedEvent,
      SOURCE,
    );
    await sink.onEvent(
      {
        type: 'ft-call-status-changed',
        payload: { uuid: 'retired-2', status_id: 4, address: 'stale@example.com' },
      } as NormalizedEvent,
      SOURCE,
    );

    expect(innerCalls).toHaveLength(0);
  });

  it('passes non-FaceTime events straight through', async () => {
    const { sink, innerCalls } = setup();
    await sink.onEvent(
      { type: 'typing-indicator', payload: { chatGuid: 'c1', display: true } } as NormalizedEvent,
      SOURCE,
    );
    expect(innerCalls).toHaveLength(1);
  });
});
