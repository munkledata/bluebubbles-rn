import { FaceTimeEventSink } from '@/services/realtime/faceTimeEventSink';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

const SOURCE = 'socket' as EventSource;

function setup() {
  const innerCalls: NormalizedEvent[] = [];
  const inner: EventSink = { onEvent: async (e) => void innerCalls.push(e) };
  const rings: Array<{ uuid: string; callerName: string; isAudio: boolean }> = [];
  const ended: string[] = [];
  const sink = new FaceTimeEventSink(
    inner,
    (c) => rings.push(c),
    (uuid) => ended.push(uuid),
  );
  return { sink, innerCalls, rings, ended };
}

describe('FaceTimeEventSink', () => {
  it('rings on incoming-facetime and still delegates to the inner sink (background ring)', async () => {
    const { sink, innerCalls, rings } = setup();
    await sink.onEvent(
      {
        type: 'incoming-facetime',
        payload: { uuid: 'u1', caller: 'Alice', is_audio: false },
      } as NormalizedEvent,
      SOURCE,
    );
    expect(rings).toEqual([{ uuid: 'u1', callerName: 'Alice', isAudio: false }]);
    expect(innerCalls).toHaveLength(1); // Notifee path downstream still runs
  });

  it('rings on ft-call-status-changed status 4 with address→handle fallback', async () => {
    const { sink, rings } = setup();
    await sink.onEvent(
      {
        type: 'ft-call-status-changed',
        payload: { uuid: 'u2', handle: { address: 'b@x.com' }, is_audio: true },
      } as NormalizedEvent,
      SOURCE,
    );
    // status_id missing → not a ring
    expect(rings).toHaveLength(0);
    await sink.onEvent(
      {
        type: 'ft-call-status-changed',
        payload: { uuid: 'u2', status_id: 4, handle: { address: 'b@x.com' }, is_audio: true },
      } as NormalizedEvent,
      SOURCE,
    );
    expect(rings).toEqual([{ uuid: 'u2', callerName: 'b@x.com', isAudio: true }]);
  });

  it('dismisses on status 6 (ended), not a ring', async () => {
    const { sink, rings, ended } = setup();
    await sink.onEvent(
      { type: 'ft-call-status-changed', payload: { uuid: 'u3', status_id: 6 } } as NormalizedEvent,
      SOURCE,
    );
    expect(ended).toEqual(['u3']);
    expect(rings).toHaveLength(0);
  });

  it('ignores a uuid-less facetime event but still delegates', async () => {
    const { sink, innerCalls, rings, ended } = setup();
    await sink.onEvent({ type: 'incoming-facetime', payload: {} } as NormalizedEvent, SOURCE);
    expect(rings).toHaveLength(0);
    expect(ended).toHaveLength(0);
    expect(innerCalls).toHaveLength(1);
  });

  it('passes non-FaceTime events straight through', async () => {
    const { sink, innerCalls, rings, ended } = setup();
    await sink.onEvent(
      { type: 'typing-indicator', payload: { chatGuid: 'c1', display: true } } as NormalizedEvent,
      SOURCE,
    );
    expect(rings).toHaveLength(0);
    expect(ended).toHaveLength(0);
    expect(innerCalls).toHaveLength(1);
  });
});
