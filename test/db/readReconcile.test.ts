import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  listChatsForInbox,
  markMessageDeleted,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

/**
 * Schema gap 7: `upsertChats` reconciles the macOS read watermark
 * (`Chat.lastReadMessageTimestamp`, Unix ms) into the local guid-based read marker
 * (`lastReadMessageGuid`). The marker maps to the newest LOCAL received (`is_from_me = 0`),
 * non-deleted message at/before the watermark — mirroring `getNewestReceivedGuid` — and only ever
 * advances (never regresses a marker the user has read further on this device). Because the unread
 * count derives from the marker, moving it automatically clears the inbox badge.
 */

function chat(guid: string, extra: Record<string, unknown> = {}) {
  return Chat.parse({
    guid,
    displayName: guid,
    participants: [{ address: 'alice@me.com' }],
    ...extra,
  });
}

/** A received (inbound) message — the reconcile-eligible kind (is_from_me = 0). */
function received(guid: string, dateCreated: number, extra: Record<string, unknown> = {}) {
  return Message.parse({ guid, text: guid, dateCreated, isFromMe: false, ...extra });
}

/** Ingest a chat exactly as the sync/chat-query path does: handles first, then upsertChats. */
async function ingestChat(db: AppDatabase, c: Chat): Promise<void> {
  const handles = await upsertHandles(db, c.participants ?? []);
  await upsertChats(db, [c], handles);
}

/** The chat's current guid-based read marker, read straight from the row. */
function marker(raw: Database.Database, chatGuid: string): string | null {
  const row = raw
    .prepare('SELECT last_read_message_guid AS g FROM chats WHERE guid = ?')
    .get(chatGuid) as { g: string | null } | undefined;
  return row?.g ?? null;
}

async function unreadCount(db: AppDatabase, chatGuid: string): Promise<number> {
  const rows = await listChatsForInbox(db);
  return rows.find((r) => r.guid === chatGuid)?.unreadCount ?? -1;
}

/** Seed chat 'c1' with three received messages at 1000 / 2000 / 3000 and its handle links. */
async function seedThree(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
  const map = await upsertChats(db, [chat('c1')], handles);
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [received('m1', 1000), received('m2', 2000), received('m3', 3000)],
    () => chatId,
    handles,
  );
  return chatId;
}

describe('read-state reconciliation from lastReadMessageTimestamp', () => {
  it('advances the marker to the newest received message at/before the watermark, dropping unread', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);
    await setLastReadMessageGuid(db, 'c1', 'm1'); // locally read only up to m1
    expect(await unreadCount(db, 'c1')).toBe(2); // m2, m3 unread

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 }));

    expect(marker(raw, 'c1')).toBe('m2'); // newest received <= 2500
    expect(await unreadCount(db, 'c1')).toBe(1); // only m3 remains
  });

  it('is inclusive at the boundary: a watermark equal to a message date selects that message', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);
    await setLastReadMessageGuid(db, 'c1', 'm1');

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2000 })); // == m2's date

    expect(marker(raw, 'c1')).toBe('m2');
  });

  it('never regresses a marker the user has read further locally (received)', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);
    await setLastReadMessageGuid(db, 'c1', 'm3'); // read everything locally
    expect(await unreadCount(db, 'c1')).toBe(0);

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 })); // Mac only read to m2

    expect(marker(raw, 'c1')).toBe('m3'); // untouched
    expect(await unreadCount(db, 'c1')).toBe(0);
  });

  it('never regresses when the local marker points at a NEWER outgoing message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedThree(db);
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    // An outgoing send newer than any received message; a mark-all-read could point the marker here.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'out', text: 'out', dateCreated: 3500, isFromMe: true })],
      () => chatId,
      handles,
    );
    await setLastReadMessageGuid(db, 'c1', 'out');

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 }));

    expect(marker(raw, 'c1')).toBe('out'); // 2000 (m2) is older than the marker's 3500 → no-op
  });

  it('ignores a null watermark ("never read on the Mac")', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);
    await setLastReadMessageGuid(db, 'c1', 'm1');

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: null }));

    expect(marker(raw, 'c1')).toBe('m1');
  });

  it('ignores an absent watermark field entirely', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);
    await setLastReadMessageGuid(db, 'c1', 'm1');

    await ingestChat(db, chat('c1')); // no lastReadMessageTimestamp key at all

    expect(marker(raw, 'c1')).toBe('m1');
  });

  it('is a no-op when the watermark predates every synced message (unresolvable)', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db); // earliest message is at 1000

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 500 }));

    expect(marker(raw, 'c1')).toBeNull(); // nothing received at/before 500 → marker never set
  });

  it('is a no-op on an empty chat (no messages) and does not throw', async () => {
    const { db, raw } = await createTestDb();

    await ingestChat(db, chat('empty', { lastReadMessageTimestamp: 2500 }));

    expect(marker(raw, 'empty')).toBeNull();
  });

  it('resolves received-only + non-deleted: skips an outgoing and a deleted received row', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const map = await upsertChats(db, [chat('c1')], handles);
    const chatId = map.get('c1')!;
    await upsertMessages(
      db,
      [
        received('r1', 1000),
        received('r2', 2400), // will be tombstoned → not eligible
        Message.parse({ guid: 'o1', text: 'o1', dateCreated: 2450, isFromMe: true }), // outgoing
      ],
      () => chatId,
      handles,
    );
    await markMessageDeleted(db, 'r2', 2400);

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 3000 }));

    // Newest RECEIVED, NON-DELETED <= 3000 is r1 (r2 deleted, o1 outgoing) → marker = r1.
    expect(marker(raw, 'c1')).toBe('r1');
  });

  it('reconciles MULTIPLE chats in one batch independently (pre-filter skips one, advances another)', async () => {
    // Guards the batched reconcile: one upsertChats call carrying watermarks for several chats must
    // resolve each marker independently — the cheap pre-filter skips a chat already read further,
    // while another advances — with no cross-talk between chats.
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const map = await upsertChats(db, [chat('c1'), chat('c2')], handles);
    await upsertMessages(db, [received('a1', 1000), received('a2', 2000)], () => map.get('c1')!, handles);
    await upsertMessages(db, [received('b1', 1500), received('b2', 3000)], () => map.get('c2')!, handles);
    await setLastReadMessageGuid(db, 'c1', 'a2'); // c1 already read to 2000; c2 never read

    // Batch: c1's watermark (1500) is <= its marker date (2000) → pre-filter SKIP; c2's (2000) advances.
    await upsertChats(
      db,
      [
        chat('c1', { lastReadMessageTimestamp: 1500 }),
        chat('c2', { lastReadMessageTimestamp: 2000 }),
      ],
      handles,
    );

    expect(marker(raw, 'c1')).toBe('a2'); // untouched — the pre-filter skipped it
    expect(marker(raw, 'c2')).toBe('b1'); // advanced to the newest received <= 2000 (b2@3000 excluded)
  });

  it('is idempotent: re-ingesting the same watermark leaves the marker unchanged', async () => {
    const { db, raw } = await createTestDb();
    await seedThree(db);

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 }));
    expect(marker(raw, 'c1')).toBe('m2');

    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 }));
    await ingestChat(db, chat('c1', { lastReadMessageTimestamp: 2500 }));
    expect(marker(raw, 'c1')).toBe('m2'); // still m2 — no drift
  });
});
