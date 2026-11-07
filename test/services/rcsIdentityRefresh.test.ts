import { ServerInfo } from '@core/models';
import { kvGet, RCS_IDENTITY_APPLIED_KEY, RCS_IDENTITY_PROGRESS_KEY } from '@db/repositories';
import type { TestDb } from '@db/types';
import {
  beginRcsIdentityRefresh,
  finishRcsIdentityRefreshIfComplete,
  noteRcsIdentityChatDone,
  saveRcsIdentityProgress,
} from '@/services/sync/rcsIdentityRefresh';
import { createTestDb } from '../support/testDb';

const epoch = `gpe1_${'A'.repeat(43)}`;
const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const rcsChat = (name: string) => `RCS;-;g1.${epoch}.${encoded(name)}`;
const info = ServerInfo.parse({
  server_version: '2.0.0',
  rcs: true,
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: epoch,
  rcs_identity_version: 2,
});
const go = () => true;

describe('RCS identity refresh bookkeeping', () => {
  let db: TestDb;
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('needs a complete listing before it treats a missing conversation as gone', async () => {
    const [a, b] = [rcsChat('a'), rcsChat('b')];
    const stored = new Map([
      [a, 'm-a'],
      [b, 'm-b'],
    ]);
    const refresh = (await beginRcsIdentityRefresh(db, info, go))!;
    await noteRcsIdentityChatDone(db, refresh, a, go);

    // The listing failed part-way after naming only `a`: `b` may still exist on the server.
    const partial = { complete: false, rcsChats: new Set([a]) };
    expect(await finishRcsIdentityRefreshIfComplete(db, refresh, info, stored, partial, go)).toBe(
      false,
    );
    expect(await kvGet(db, RCS_IDENTITY_APPLIED_KEY)).toBeNull();

    // The same listing, complete: the server no longer has `b`.
    const whole = { complete: true, rcsChats: new Set([a]) };
    expect(await finishRcsIdentityRefreshIfComplete(db, refresh, info, stored, whole, go)).toBe(
      true,
    );
    expect(await kvGet(db, RCS_IDENTITY_APPLIED_KEY)).toBe('2');
  });

  it('ignores stored conversations without messages and from another pairing', async () => {
    const otherPairing = `RCS;-;g1.gpe1_${'B'.repeat(43)}.${encoded('old')}`;
    const stored = new Map<string, string | null>([
      [rcsChat('empty'), null],
      [otherPairing, 'm-old'],
    ]);
    const refresh = (await beginRcsIdentityRefresh(db, info, go))!;
    const none = { complete: true, rcsChats: new Set<string>() };
    expect(await finishRcsIdentityRefreshIfComplete(db, refresh, info, stored, none, go)).toBe(
      true,
    );
  });

  it('writes progress in batches of ten and on request', async () => {
    const refresh = (await beginRcsIdentityRefresh(db, info, go))!;
    const chats = Array.from({ length: 12 }, (_, i) => rcsChat(`c${i}`));
    for (const chat of chats.slice(0, 9)) await noteRcsIdentityChatDone(db, refresh, chat, go);
    expect(await kvGet(db, RCS_IDENTITY_PROGRESS_KEY)).toBeNull();

    await noteRcsIdentityChatDone(db, refresh, chats[9]!, go);
    const saved = JSON.parse((await kvGet(db, RCS_IDENTITY_PROGRESS_KEY))!) as {
      version: number;
      done: string[];
    };
    expect(saved).toEqual({ version: 2, done: chats.slice(0, 10) });

    for (const chat of chats.slice(10)) await noteRcsIdentityChatDone(db, refresh, chat, go);
    await saveRcsIdentityProgress(db, refresh, go);
    const all = JSON.parse((await kvGet(db, RCS_IDENTITY_PROGRESS_KEY))!) as { done: string[] };
    expect(all.done).toEqual(chats);

    // A later sync picks the record up again.
    const resumed = (await beginRcsIdentityRefresh(db, info, go))!;
    expect([...resumed.done]).toEqual(chats);
  });
});
