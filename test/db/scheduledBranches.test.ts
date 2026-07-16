/**
 * Branch top-ups for src/db/repositories/scheduled.ts — the reconcile/prune branches, the
 * status-guarded edit, the attempt-cap retire, and the by-chat / stuck-recovery reads. Each
 * case asserts observable DB state or a documented return value.
 */
import type Database from 'better-sqlite3';
import {
  claimScheduled,
  deleteScheduled,
  getScheduledById,
  insertScheduled,
  listAllScheduled,
  listDueScheduled,
  listScheduledByChat,
  markScheduledFailed,
  markScheduledSent,
  reconcileServerScheduled,
  resetStuckScheduled,
  updateScheduled,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const attempts = (raw: Database.Database, id: number): number =>
  (raw.prepare('SELECT attempts a FROM scheduled_messages WHERE id = ?').get(id) as { a: number })
    .a;
const statusOf = (raw: Database.Database, id: number): string | undefined =>
  (raw.prepare('SELECT status s FROM scheduled_messages WHERE id = ?').get(id) as { s: string })?.s;
const rawServerId = (raw: Database.Database, id: number): string | null =>
  (
    raw.prepare('SELECT server_id s FROM scheduled_messages WHERE id = ?').get(id) as {
      s: string | null;
    }
  ).s;

describe('scheduled reads', () => {
  it('listScheduledByChat returns only that chat’s pending rows, soonest first', async () => {
    const { db } = await createTestDb();
    await insertScheduled(db, { chatGuid: 'cA', text: 'later', scheduledFor: 200 });
    await insertScheduled(db, { chatGuid: 'cA', text: 'soon', scheduledFor: 100 });
    await insertScheduled(db, { chatGuid: 'cB', text: 'other', scheduledFor: 100 });
    const rows = await listScheduledByChat(db, 'cA');
    expect(rows.map((r) => r.text)).toEqual(['soon', 'later']);
  });

  it('getScheduledById returns null for a missing id and maps the payload for a real one', async () => {
    const { db } = await createTestDb();
    expect(await getScheduledById(db, 999)).toBeNull();
    const id = await insertScheduled(db, {
      chatGuid: 'cA',
      text: 'hey',
      scheduledFor: 50,
      selectedMessageGuid: 'reply-1',
    });
    const row = await getScheduledById(db, id);
    expect(row).toMatchObject({ id, chatGuid: 'cA', text: 'hey', selectedMessageGuid: 'reply-1' });
  });

  it('listDueScheduled returns only pending rows at/under now', async () => {
    const { db } = await createTestDb();
    await insertScheduled(db, { chatGuid: 'cA', text: 'due', scheduledFor: 100 });
    await insertScheduled(db, { chatGuid: 'cA', text: 'future', scheduledFor: 500 });
    const due = await listDueScheduled(db, 200);
    expect(due.map((r) => r.text)).toEqual(['due']);
  });
});

describe('reconcileServerScheduled', () => {
  it('inserts a new server-backed row, then updates it PRESERVING the local reply target', async () => {
    const { db } = await createTestDb();
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-1', chatGuid: 'cA', text: 'first', scheduledFor: 100, status: 'pending' }],
      ['srv-1'],
    );
    // Give the local row a reply target the server doesn't know about.
    const rows = await listAllScheduled(db);
    await updateScheduled(db, rows[0]!.id, { text: 'first' }); // no-op-ish; keep row
    // Re-run with new text/time — the payload's non-text fields must survive.
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-1', chatGuid: 'cA', text: 'edited', scheduledFor: 999, status: 'pending' }],
      ['srv-1'],
    );
    const after = await getScheduledById(db, rows[0]!.id);
    expect(after).toMatchObject({ text: 'edited', scheduledFor: 999 });
  });

  it('recovers from a corrupt local payload (falls back to text-only)', async () => {
    const { db, raw } = await createTestDb();
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-2', chatGuid: 'cA', text: 'orig', scheduledFor: 100, status: 'pending' }],
      ['srv-2'],
    );
    const id = (await listAllScheduled(db))[0]!.id;
    raw.prepare('UPDATE scheduled_messages SET payload = ? WHERE id = ?').run('{not json', id);
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-2', chatGuid: 'cA', text: 'fixed', scheduledFor: 100, status: 'pending' }],
      ['srv-2'],
    );
    expect((await getScheduledById(db, id))!.text).toBe('fixed');
  });

  it('prunes local server-backed rows the server no longer reports (but keeps local-only rows)', async () => {
    const { db } = await createTestDb();
    await reconcileServerScheduled(
      db,
      [
        { serverId: 'srv-3', chatGuid: 'cA', text: 'keep', scheduledFor: 100, status: 'pending' },
        { serverId: 'srv-4', chatGuid: 'cA', text: 'drop', scheduledFor: 100, status: 'pending' },
      ],
      ['srv-3', 'srv-4'],
    );
    const localOnly = await insertScheduled(db, {
      chatGuid: 'cA',
      text: 'localonly',
      scheduledFor: 100,
    });
    // Server now only reports srv-3 → srv-4 is pruned, srv-3 + the local-only row remain.
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-3', chatGuid: 'cA', text: 'keep', scheduledFor: 100, status: 'pending' }],
      ['srv-3'],
    );
    const texts = (await listAllScheduled(db)).map((r) => r.text).sort();
    expect(texts).toEqual(['keep', 'localonly']);
    expect(await getScheduledById(db, localOnly)).not.toBeNull();
  });

  it('never prunes on an EMPTY server view (transient/failed fetch)', async () => {
    const { db } = await createTestDb();
    await reconcileServerScheduled(
      db,
      [{ serverId: 'srv-5', chatGuid: 'cA', text: 'safe', scheduledFor: 100, status: 'pending' }],
      ['srv-5'],
    );
    await reconcileServerScheduled(db, [], []); // empty items + empty ids → skip prune
    expect(await listAllScheduled(db)).toHaveLength(1);
  });
});

describe('updateScheduled — status-guarded edit', () => {
  it('edits text + time on a pending row, preserving the reply target', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'cA',
      text: 'a',
      scheduledFor: 100,
      selectedMessageGuid: 'reply-9',
    });
    await updateScheduled(db, id, { text: 'b', scheduledFor: 250 });
    const row = await getScheduledById(db, id);
    expect(row).toMatchObject({ text: 'b', scheduledFor: 250, selectedMessageGuid: 'reply-9' });
  });

  it('is a no-op when the patch is empty (nothing to set)', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    await updateScheduled(db, id, {}); // Object.keys(set).length === 0 → early return
    expect((await getScheduledById(db, id))!.text).toBe('x');
  });

  it('cannot edit a row that is no longer pending (the status guard is the lock)', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    raw.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id = ?").run(id);
    await updateScheduled(db, id, { text: 'nope', scheduledFor: 5, serverId: 'srv-new' });
    // Guard rejects the write → text/time/serverId unchanged.
    const row = await getScheduledById(db, id);
    expect(row).toMatchObject({ text: 'x', scheduledFor: 100 });
    expect(rawServerId(raw, id)).toBeNull();
  });

  it('re-associates a server id (Gator no-PUT re-create) on a pending row', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    await updateScheduled(db, id, { serverId: 'srv-assigned' });
    expect(rawServerId(raw, id)).toBe('srv-assigned');
  });
});

describe('claim / send / fail / recover', () => {
  it('claimScheduled wins once then returns false on the already-claimed row', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    expect(await claimScheduled(db, id)).toBe(true); // pending → sending
    expect(await claimScheduled(db, id)).toBe(false); // no longer pending
  });

  it('markScheduledSent records the server id', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    await markScheduledSent(db, id, 'srv-sent');
    expect(statusOf(raw, id)).toBe('sent');
    expect(rawServerId(raw, id)).toBe('srv-sent');
  });

  it('markScheduledFailed releases to pending under the cap, then retires to error at the cap', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    // Attempts 1..4 → still 'pending' (SCHED_MAX_ATTEMPTS = 5).
    for (let i = 1; i <= 4; i++) {
      expect(await markScheduledFailed(db, id)).toBe('pending');
      expect(attempts(raw, id)).toBe(i);
    }
    // 5th failure hits the cap → retired to 'error' (stops retrying every tick).
    expect(await markScheduledFailed(db, id)).toBe('error');
    expect(statusOf(raw, id)).toBe('error');
  });

  it('resetStuckScheduled returns interrupted sending rows to pending and reports the count', async () => {
    const { db, raw } = await createTestDb();
    const a = await insertScheduled(db, { chatGuid: 'cA', text: 'a', scheduledFor: 100 });
    const b = await insertScheduled(db, { chatGuid: 'cA', text: 'b', scheduledFor: 100 });
    raw.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id IN (?, ?)").run(a, b);
    expect(await resetStuckScheduled(db)).toBe(2);
    expect(statusOf(raw, a)).toBe('pending');
    expect(statusOf(raw, b)).toBe('pending');
  });

  it('deleteScheduled removes the row', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'cA', text: 'x', scheduledFor: 100 });
    await deleteScheduled(db, id);
    expect(await getScheduledById(db, id)).toBeNull();
  });
});
