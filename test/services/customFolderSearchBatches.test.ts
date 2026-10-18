/**
 * Folder search reads message matches in short batches (review M060). The full-text match over
 * message bodies walks every matching message in every chat, and the app's single database thread
 * runs one statement at a time, so one long match used to stall sends and sync for its whole
 * length. Each batch now reads at most 2,000 matches, newest first, in its own short transaction;
 * work that queued meanwhile runs before the next batch, and the search stops early once every
 * folder chat has matched or when a newer search replaces it.
 */
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from '@db/types';

let mockDb: AppDatabase;
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));

// eslint-disable-next-line import/first
import { withDbTransaction } from '@db/transaction';
// eslint-disable-next-line import/first
import { loadCustomFolderInboxPage } from '@/services/customFolderCommands';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';
// eslint-disable-next-line import/first
import { createCustomFolder, replaceCustomFolderMembership } from '../support/repositoryWrappers';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** One full-text candidate window per batch; every other full-text statement is range-bounded. */
const BATCH_WINDOW = 'ORDER BY rowid DESC';

function insertChat(raw: Database.Database, guid: string): number {
  return Number(
    raw
      .prepare(
        `INSERT INTO chats (guid, style, is_archived, is_pinned, latest_message_date)
         VALUES (?, 45, 0, 0, 1)`,
      )
      .run(guid).lastInsertRowid,
  );
}

function insertMatches(raw: Database.Database, chatId: number, prefix: string, count: number) {
  const insert = raw.prepare(
    `INSERT INTO messages (guid, chat_id, text, date_created, is_from_me)
     VALUES (?, ?, 'the haystack needle', ?, 0)`,
  );
  raw.transaction(() => {
    for (let index = 0; index < count; index += 1) insert.run(`${prefix}-${index}`, chatId, index);
  })();
}

/** Record every SQL statement the repository prepares (the test driver prepares per call). */
function recordStatements(t: TestDb, onStatement?: (source: string) => void) {
  const statements: string[] = [];
  const prepare = t.raw.prepare.bind(t.raw);
  const spy = jest.spyOn(t.raw, 'prepare').mockImplementation(((source: string) => {
    statements.push(source);
    onStatement?.(source);
    return prepare(source);
  }) as Database.Database['prepare']);
  return { statements, restore: () => spy.mockRestore() };
}

function fullTextStatements(statements: readonly string[]) {
  return statements.filter((source) => source.includes('messages_fts MATCH'));
}

beforeEach(() => {
  resumeRealtimeDeliveries();
});

it('reads the folder search in bounded batches, newest first, and still finds the oldest match', async () => {
  const t = await createTestDb();
  mockDb = t.db;
  // Insertion order sets message rowids: the old member match is the very first match, then 4,500
  // matches in a chat outside the folder, then the newest member match.
  insertMatches(t.raw, insertChat(t.raw, 'member-old'), 'old', 1);
  insertMatches(t.raw, insertChat(t.raw, 'outside-folder'), 'noise', 4_500);
  insertMatches(t.raw, insertChat(t.raw, 'member-new'), 'new', 1);
  const folder = await createCustomFolder(t.db, 'Batches');
  await replaceCustomFolderMembership(t.db, folder.id, ['member-old', 'member-new']);

  const recorded = recordStatements(t);
  try {
    const page = await loadCustomFolderInboxPage(
      folder.id,
      10,
      'needle',
      captureRealtimeDeliveryLease(),
    );
    expect(page).toMatchObject({ status: 'committed', value: { matchingCount: 2 } });
    if (page.status !== 'committed' || page.value == null) throw new Error('no page');
    expect(page.value.rows.map((row) => row.guid).sort()).toEqual(['member-new', 'member-old']);
  } finally {
    recorded.restore();
  }

  const fullText = fullTextStatements(recorded.statements);
  // 4,502 matches at 2,000 per batch: three batches, and no unbounded full-text statement.
  expect(fullText.filter((source) => source.includes(BATCH_WINDOW))).toHaveLength(3);
  for (const source of fullText) {
    expect(source.includes(BATCH_WINDOW) || source.includes('f.rowid >=')).toBe(true);
  }
  t.raw.close();
});

it('stops reading batches once every folder chat has matched', async () => {
  const t = await createTestDb();
  mockDb = t.db;
  insertMatches(t.raw, insertChat(t.raw, 'outside-folder'), 'noise', 4_500);
  insertMatches(t.raw, insertChat(t.raw, 'member'), 'member', 1);
  const folder = await createCustomFolder(t.db, 'Early stop');
  await replaceCustomFolderMembership(t.db, folder.id, ['member']);

  const recorded = recordStatements(t);
  try {
    await expect(
      loadCustomFolderInboxPage(folder.id, 10, 'needle', captureRealtimeDeliveryLease()),
    ).resolves.toMatchObject({ status: 'committed', value: { matchingCount: 1 } });
  } finally {
    recorded.restore();
  }
  const windows = fullTextStatements(recorded.statements).filter((source) =>
    source.includes(BATCH_WINDOW),
  );
  expect(windows).toHaveLength(1);
  t.raw.close();
});

it('stops between batches when a newer search replaces this one', async () => {
  const t = await createTestDb();
  mockDb = t.db;
  insertMatches(t.raw, insertChat(t.raw, 'member'), 'member', 1);
  insertMatches(t.raw, insertChat(t.raw, 'outside-folder'), 'noise', 4_500);
  const folder = await createCustomFolder(t.db, 'Superseded');
  await replaceCustomFolderMembership(t.db, folder.id, ['member']);

  let windowsRead = 0;
  const recorded = recordStatements(t, (source) => {
    if (source.includes('messages_fts MATCH') && source.includes(BATCH_WINDOW)) windowsRead += 1;
  });
  try {
    await expect(
      loadCustomFolderInboxPage(
        folder.id,
        10,
        'needle',
        captureRealtimeDeliveryLease(),
        () => windowsRead < 1,
      ),
    ).resolves.toEqual({ status: 'stale' });
  } finally {
    recorded.restore();
  }
  expect(windowsRead).toBe(1);
  t.raw.close();
});

it('lets a write that queued during a batch run before the next batch', async () => {
  const t = await createTestDb();
  mockDb = t.db;
  insertMatches(t.raw, insertChat(t.raw, 'member'), 'member', 1);
  insertMatches(t.raw, insertChat(t.raw, 'outside-folder'), 'noise', 4_500);
  const folder = await createCustomFolder(t.db, 'Interleaved');
  await replaceCustomFolderMembership(t.db, folder.id, ['member']);

  const order: string[] = [];
  let queuedWrite: Promise<void> | undefined;
  const recorded = recordStatements(t, (source) => {
    if (!source.includes('messages_fts MATCH') || !source.includes(BATCH_WINDOW)) return;
    order.push('batch');
    // A send or sync write arriving while the first batch runs queues behind it, not behind the
    // whole search.
    queuedWrite ??= withDbTransaction(t.db, async () => {
      await t.db.run(sql`UPDATE chats SET custom_name = custom_name WHERE guid = 'member'`);
      order.push('write');
    });
  });
  try {
    await expect(
      loadCustomFolderInboxPage(folder.id, 10, 'needle', captureRealtimeDeliveryLease()),
    ).resolves.toMatchObject({ status: 'committed', value: { matchingCount: 1 } });
    await queuedWrite;
  } finally {
    recorded.restore();
  }
  expect(order.slice(0, 3)).toEqual(['batch', 'write', 'batch']);
  t.raw.close();
});
