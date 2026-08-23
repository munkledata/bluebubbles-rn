import { Chat, Message } from '@core/models';
import {
  markMessageDeleted,
  markMessageDeletedWithinTransaction,
  upsertChats,
  upsertHandles,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase): Promise<{
  chatId: number;
  handles: Map<string, number>;
}> {
  const handles = await upsertHandles(db, [{ address: 'alice@example.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'chat-1', participants: [{ address: 'alice@example.com' }] })],
    handles,
  );
  return { chatId: chats.get('chat-1')!, handles };
}

const message = (guid: string) =>
  Message.parse({
    guid,
    text: 'must stay hidden',
    dateCreated: 1000,
    chats: [{ guid: 'chat-1' }],
    handle: { address: 'alice@example.com' },
  });

describe('message deletion ledger', () => {
  it('records an unknown deletion and tombstones a later message in its initial INSERT', async () => {
    const { db, raw } = await createTestDb();
    await expect(markMessageDeleted(db, 'late-message', 5000)).resolves.toBe(false);
    expect(
      raw
        .prepare(
          `SELECT guid, date_deleted AS dateDeleted
             FROM message_deletion_ledger WHERE guid = 'late-message'`,
        )
        .get(),
    ).toEqual({ guid: 'late-message', dateDeleted: 5000 });

    const { chatId, handles } = await seedChat(db);
    raw.exec(`
      CREATE TABLE insertion_probe (date_deleted INTEGER);
      CREATE TRIGGER capture_message_initial_tombstone
      AFTER INSERT ON messages
      WHEN NEW.guid = 'late-message'
      BEGIN
        INSERT INTO insertion_probe (date_deleted) VALUES (NEW.date_deleted);
      END
    `);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(context, [message('late-message')], () => chatId, handles),
    );

    expect(raw.prepare('SELECT date_deleted FROM insertion_probe').get()).toEqual({
      date_deleted: 5000,
    });
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'late-message'").get(),
    ).toEqual({ date_deleted: 5000 });
  });

  it('keeps the later timestamp across repeated, out-of-order deletion events', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(
        context,
        [message('repeated-message')],
        () => chatId,
        handles,
      ),
    );

    await markMessageDeleted(db, 'repeated-message', 5000);
    await markMessageDeleted(db, 'repeated-message', 4000);

    expect(
      raw
        .prepare(
          `SELECT m.date_deleted AS messageDate, l.date_deleted AS ledgerDate
             FROM messages m JOIN message_deletion_ledger l ON l.guid = m.guid
            WHERE m.guid = 'repeated-message'`,
        )
        .get(),
    ).toEqual({ messageDate: 5000, ledgerDate: 5000 });
  });

  it('survives a hard row purge and tombstones the next re-ingestion', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(context, [message('purged-message')], () => chatId, handles),
    );
    await markMessageDeleted(db, 'purged-message', 5000);
    raw.prepare("DELETE FROM messages WHERE guid = 'purged-message'").run();

    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(context, [message('purged-message')], () => chatId, handles),
    );
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'purged-message'").get(),
    ).toEqual({ date_deleted: 5000 });
  });

  it('retains protection when ingestion cannot yet resolve a chat', async () => {
    const { db, raw } = await createTestDb();
    await markMessageDeleted(db, 'missing-chat-message', 5000);
    await expect(
      withDbTransaction(db, (context) =>
        upsertMessagesWithinTransaction(
          context,
          [message('missing-chat-message')],
          () => undefined,
          new Map(),
        ),
      ),
    ).resolves.toEqual(new Map());
    expect(
      raw
        .prepare(
          "SELECT date_deleted FROM message_deletion_ledger WHERE guid = 'missing-chat-message'",
        )
        .get(),
    ).toEqual({ date_deleted: 5000 });

    const { chatId, handles } = await seedChat(db);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(
        context,
        [message('missing-chat-message')],
        () => chatId,
        handles,
      ),
    );
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'missing-chat-message'").get(),
    ).toEqual({ date_deleted: 5000 });
  });

  it('rolls back an unknown ledger marker with its owning transaction', async () => {
    const { db, raw } = await createTestDb();
    await expect(
      withDbTransaction(db, async (context) => {
        await markMessageDeletedWithinTransaction(context, 'rolled-back-message', 5000);
        throw new Error('planned rollback');
      }),
    ).rejects.toThrow('planned rollback');

    expect(
      raw
        .prepare("SELECT guid FROM message_deletion_ledger WHERE guid = 'rolled-back-message'")
        .get(),
    ).toBeUndefined();
  });

  it('queues the public writer behind a neighbouring rollback, then commits ledger, message, and chat state together', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(context, [message('queued-message')], () => chatId, handles),
    );

    let markStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      markStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    const neighbourFailure = neighbour.then(
      () => null,
      (error: unknown) => error,
    );
    await started;

    let deletionSettled = false;
    const deletion = markMessageDeleted(db, 'queued-message', 5000).finally(() => {
      deletionSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(deletionSettled).toBe(false);
    expect(
      raw.prepare("SELECT guid FROM message_deletion_ledger WHERE guid = 'queued-message'").get(),
    ).toBeUndefined();
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'queued-message'").get(),
    ).toEqual({ date_deleted: null });
    expect(raw.prepare('SELECT latest_message_date FROM chats WHERE id = ?').get(chatId)).toEqual({
      latest_message_date: 1000,
    });

    releaseNeighbour();
    expect(String(await neighbourFailure)).toContain('neighbour rollback');
    await expect(deletion).resolves.toBe(true);
    expect(
      raw
        .prepare("SELECT date_deleted FROM message_deletion_ledger WHERE guid = 'queued-message'")
        .get(),
    ).toEqual({ date_deleted: 5000 });
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'queued-message'").get(),
    ).toEqual({ date_deleted: 5000 });
    expect(raw.prepare('SELECT latest_message_date FROM chats WHERE id = ?').get(chatId)).toEqual({
      latest_message_date: null,
    });
  });

  it('rolls back ledger and message writes when the final chat-sort update fails', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(
        context,
        [message('sort-failure-message')],
        () => chatId,
        handles,
      ),
    );
    raw.exec(`
      CREATE TRIGGER fail_message_deletion_chat_sort
      BEFORE UPDATE OF latest_message_date ON chats
      WHEN NEW.id = ${chatId}
      BEGIN
        SELECT RAISE(ABORT, 'planned chat sort failure');
      END
    `);

    await expect(markMessageDeleted(db, 'sort-failure-message', 5000)).rejects.toMatchObject({
      message: expect.stringContaining("Failed to run the query 'UPDATE chats"),
      cause: expect.objectContaining({ message: 'planned chat sort failure' }),
    });

    expect(
      raw
        .prepare("SELECT guid FROM message_deletion_ledger WHERE guid = 'sort-failure-message'")
        .get(),
    ).toBeUndefined();
    expect(
      raw.prepare("SELECT date_deleted FROM messages WHERE guid = 'sort-failure-message'").get(),
    ).toEqual({ date_deleted: null });
    expect(raw.prepare('SELECT latest_message_date FROM chats WHERE id = ?').get(chatId)).toEqual({
      latest_message_date: 1000,
    });
  });
});
