import type { NormalizedEvent } from '@core/realtime';
import type { AppDatabase } from '@db/types';
import { buildMessageIntents } from '@/services/notifications/intents';

// FaceTime intents don't touch the DB; a stub is fine.
const db = {} as AppDatabase;

describe('buildMessageIntents — FaceTime', () => {
  it('maps a legacy incoming-facetime to a facetime-call intent', async () => {
    const ev: NormalizedEvent = {
      type: 'incoming-facetime',
      payload: { uuid: 'u1', caller: 'Alice', is_audio: false },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([
      { kind: 'facetime-call', uuid: 'u1', callerName: 'Alice', isAudio: false },
    ]);
  });

  it('maps ft-call-status-changed status 4 (incoming) to a facetime-call', async () => {
    const ev: NormalizedEvent = {
      type: 'ft-call-status-changed',
      payload: {
        uuid: 'u2',
        status_id: 4,
        address: 'Mom',
        is_audio: true,
        handle: { address: '+1' },
      },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([
      { kind: 'facetime-call', uuid: 'u2', callerName: 'Mom', isAudio: true },
    ]);
  });

  it('maps ft-call-status-changed status 6 (ended) to a facetime-cancel', async () => {
    const ev: NormalizedEvent = {
      type: 'ft-call-status-changed',
      payload: { uuid: 'u3', status_id: 6 },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([{ kind: 'facetime-cancel', uuid: 'u3' }]);
  });

  it('falls back to the handle address when there is no display address', async () => {
    const ev: NormalizedEvent = {
      type: 'ft-call-status-changed',
      payload: { uuid: 'u4', status_id: 4, handle: { address: '+15551234567' } },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([
      { kind: 'facetime-call', uuid: 'u4', callerName: '+15551234567', isAudio: false },
    ]);
  });

  it('ignores a FaceTime event with no uuid, and other statuses', async () => {
    expect(await buildMessageIntents(db, { type: 'incoming-facetime', payload: {} })).toEqual([]);
    expect(
      await buildMessageIntents(db, {
        type: 'ft-call-status-changed',
        payload: { uuid: 'u5', status_id: 1 },
      }),
    ).toEqual([]);
  });
});
