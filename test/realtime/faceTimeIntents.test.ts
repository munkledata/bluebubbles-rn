import type { NormalizedEvent } from '@core/realtime';
import type { AppDatabase } from '@db/types';
import { buildMessageIntents } from '@/services/notifications/intents';

// FaceTime intents don't touch the DB; a stub is fine.
const db = {} as AppDatabase;

describe('buildMessageIntents — FaceTime', () => {
  it('drops a legacy incoming-facetime event', async () => {
    const ev: NormalizedEvent = {
      type: 'incoming-facetime',
      payload: { uuid: 'u1', caller: 'Alice', is_audio: false },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([]);
  });

  it('drops an incoming ft-call-status-changed event', async () => {
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
    expect(await buildMessageIntents(db, ev)).toEqual([]);
  });

  it('maps ft-call-status-changed status 6 (ended) to a facetime-cancel', async () => {
    const ev: NormalizedEvent = {
      type: 'ft-call-status-changed',
      payload: { uuid: 'u3', status_id: 6 },
    };
    expect(await buildMessageIntents(db, ev)).toEqual([{ kind: 'facetime-cancel', uuid: 'u3' }]);
  });

  it('ignores a FaceTime event with no uuid and non-cleanup statuses', async () => {
    expect(await buildMessageIntents(db, { type: 'incoming-facetime', payload: {} })).toEqual([]);
    expect(
      await buildMessageIntents(db, {
        type: 'ft-call-status-changed',
        payload: { uuid: 'u5', status_id: 1 },
      }),
    ).toEqual([]);
  });
});
