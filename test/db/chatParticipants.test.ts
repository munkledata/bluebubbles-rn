import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import { getChatParticipants, upsertChats, upsertHandles } from '@db/repositories';
import { createTestDb } from '../support/testDb';

/**
 * Record a chat's participant-link count after EVERY write statement, and return the growing log.
 *
 * Each statement is its own commit here, and on device the drizzle→op-sqlite adapter calls
 * `flushPendingReactiveQueries()` after every write — so these snapshots are exactly the states
 * the inbox, the chat header, and the unknown-sender notification gate can observe. A 0 in the log
 * for a chat that had members before and after is the bug: no participant rows means no
 * `participantNames`, so the title falls back to the raw `chat_identifier` (a phone number) and
 * `chatHasKnownSender` answers false, permanently dropping the notification.
 */
function watchParticipantCount(raw: Database.Database, chatId: number): number[] {
  const seen: number[] = [];
  const prepare = raw.prepare.bind(raw);
  const countStmt = prepare('SELECT COUNT(*) AS n FROM chat_handles WHERE chat_id = ?');
  const record = (): void => void seen.push((countStmt.get(chatId) as { n: number }).n);

  (raw as unknown as { prepare: (source: string) => unknown }).prepare = (
    source: string,
  ): unknown => {
    const stmt = prepare(source);
    if (!/^\s*(insert|update|delete)\b/i.test(source)) return stmt;
    // Drizzle routes a write through run() (non-returning) or all()/get() (RETURNING), so hook
    // all three rather than guessing which builder shape the repository used.
    const target = stmt as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
    for (const method of ['run', 'all', 'get']) {
      const original = target[method]?.bind(stmt);
      if (!original) continue;
      target[method] = (...args: unknown[]): unknown => {
        const result = original(...args);
        record();
        return result;
      };
    }
    return stmt;
  };
  return seen;
}

describe('getChatParticipants', () => {
  it('returns each participant address + resolved name (for group add/remove)', async () => {
    const t = await createTestDb();
    const handles = await upsertHandles(t.db, [
      { address: '+15551112222', displayName: 'Mom' },
      { address: 'craig@apple.com' },
    ]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g1',
          style: 43,
          participants: [{ address: '+15551112222' }, { address: 'craig@apple.com' }],
        }),
      ],
      handles,
    );

    const members = await getChatParticipants(t.db, 'g1');
    expect(members).toContainEqual({ address: '+15551112222', name: 'Mom' });
    expect(members).toContainEqual({ address: 'craig@apple.com', name: 'craig@apple.com' });
  });

  it('returns empty for an unknown chat', async () => {
    const t = await createTestDb();
    expect(await getChatParticipants(t.db, 'nope')).toEqual([]);
  });

  it('upsertChats prunes a removed participant on re-sync but preserves links when omitted', async () => {
    const t = await createTestDb();
    const both = await upsertHandles(t.db, [{ address: 'a@x.com' }, { address: 'b@x.com' }]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g',
          style: 43,
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        }),
      ],
      both,
    );
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'b@x.com',
    ]);

    // Re-sync with b removed → the stale link is pruned (was the bug: additive-only).
    const justA = await upsertHandles(t.db, [{ address: 'a@x.com' }]);
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g', style: 43, participants: [{ address: 'a@x.com' }] })],
      justA,
    );
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address)).toEqual(['a@x.com']);

    // A payload WITHOUT participants must NOT wipe the existing links.
    await upsertChats(t.db, [Chat.parse({ guid: 'g', style: 43 })], new Map());
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address)).toEqual(['a@x.com']);
  });

  it('treats an empty / unresolvable participants list as "no information", not "no members"', async () => {
    const t = await createTestDb();
    const both = await upsertHandles(t.db, [{ address: 'a@x.com' }, { address: 'b@x.com' }]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g',
          style: 43,
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        }),
      ],
      both,
    );

    // The server legitimately sends `participants: []` (its read path defaults to an empty array).
    await upsertChats(t.db, [Chat.parse({ guid: 'g', style: 43, participants: [] })], both);
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'b@x.com',
    ]);

    // Participants present but NONE of them resolve to a handle id (a caller that didn't upsert
    // the handles first) is the same "no information" case.
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g', style: 43, participants: [{ address: 'a@x.com' }] })],
      new Map(),
    );
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });

  it('never leaves a chat with ZERO participant links at any commit boundary mid-batch', async () => {
    const t = await createTestDb();
    const handles = await upsertHandles(t.db, [{ address: 'a@x.com' }, { address: 'b@x.com' }]);
    const chatOf = (guid: string) =>
      Chat.parse({
        guid,
        style: 43,
        participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
      });

    // Seed all three chats so every one of them has links BEFORE the batch under test.
    const map = await upsertChats(t.db, ['c1', 'c2', 'c3'].map(chatOf), handles);
    const chatId = map.get('c1');
    expect(chatId).toBeDefined();
    if (chatId == null) return;

    // Re-sync the same page (what every incremental sync does) while watching chat c1.
    const counts = watchParticipantCount(t.raw, chatId);
    await upsertChats(t.db, ['c1', 'c2', 'c3'].map(chatOf), handles);

    expect(counts.length).toBeGreaterThan(0);
    // The old delete-in-the-loop / insert-after-the-loop shape logged a 0 here for the whole
    // duration of the page — every chat simultaneously participant-less.
    expect(counts).not.toContain(0);
    expect((await getChatParticipants(t.db, 'c1')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });

  it('prunes a departed member without ever dipping to zero links', async () => {
    const t = await createTestDb();
    const handles = await upsertHandles(t.db, [
      { address: 'a@x.com' },
      { address: 'b@x.com' },
      { address: 'c@x.com' },
    ]);
    const map = await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g',
          style: 43,
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }, { address: 'c@x.com' }],
        }),
      ],
      handles,
    );
    const chatId = map.get('g');
    expect(chatId).toBeDefined();
    if (chatId == null) return;

    const counts = watchParticipantCount(t.raw, chatId);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g',
          style: 43,
          participants: [{ address: 'a@x.com' }, { address: 'c@x.com' }],
        }),
      ],
      handles,
    );

    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'c@x.com',
    ]);
    // Add-then-prune: the count only ever shrinks toward the truth, never through 0.
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
  });
});
