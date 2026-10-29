import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0056_retire_doubled_rcs_local_copies';
const RCS = 'RCS;-;gpe1_test:conversation-1';
const MINUTE = 60_000;

function runnerFor(raw: Database.Database, stopBefore0056: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0056.value && statement.includes('CREATE TEMP TABLE m0056_leftovers')) {
        throw new Error('test stop before migration 0056');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

interface Row {
  guid: string;
  chat?: number;
  text?: string | null;
  fromMe?: boolean;
  at?: number | null;
  sendState?: string;
  attachment?: boolean;
  /** has_attachments; defaults to `attachment`. Older rows can hold an attachment without it. */
  attachmentFlag?: boolean;
  reaction?: boolean;
}

async function migrateWith(
  seed: (insert: (row: Row) => void, chats: Record<string, number>) => void,
) {
  const raw = new Database(':memory:');
  const stop = { value: true };
  const runner = runnerFor(raw, stop);
  await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0056');
  for (const guid of [RCS, 'RCS;-;gpe1_test:conversation-2', 'iMessage;-;+15551234567']) {
    raw.prepare('INSERT INTO chats (guid, latest_message_date) VALUES (?, 0)').run(guid);
  }
  const chats = Object.fromEntries(
    (raw.prepare('SELECT id, guid FROM chats').all() as { id: number; guid: string }[]).map((c) => [
      c.guid,
      c.id,
    ]),
  );
  seed((row) => {
    const result = raw
      .prepare(
        `INSERT INTO messages
           (guid, chat_id, text, is_from_me, date_created, send_state, has_attachments,
            associated_message_guid, associated_message_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.guid,
        row.chat ?? chats[RCS],
        row.text === undefined ? 'hello' : row.text,
        row.fromMe === false ? 0 : 1,
        row.at === undefined ? 1_000 * MINUTE : row.at,
        row.sendState ?? 'sent',
        (row.attachmentFlag ?? row.attachment) ? 1 : 0,
        row.reaction ? 'rcs-target' : null,
        row.reaction ? 'love' : null,
      );
    if (row.attachment) {
      raw
        .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
        .run(`${row.guid}-att`, result.lastInsertRowid);
    }
  }, chats);
  stop.value = false;
  // This migration and every later one apply, so a newer migration cannot break this test.
  await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));
  const hidden = (
    raw.prepare('SELECT guid FROM messages WHERE date_deleted IS NOT NULL ORDER BY guid').all() as {
      guid: string;
    }[]
  ).map((r) => r.guid);
  return { raw, chats, hidden };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('hides each leftover local copy that pairs with its server copy, and nothing else', async () => {
    const { raw, chats, hidden } = await migrateWith((insert) => {
      // A plain double: the leftover goes, the server copy stays.
      insert({ guid: 'temp-a', text: 'one', at: 1_000 * MINUTE });
      insert({ guid: 'rcs-a', text: 'one', at: 1_000 * MINUTE + 2_000 });
      // The same words sent twice, each doubled: both pairs resolve one to one.
      insert({ guid: 'temp-b1', text: 'again', at: 2_000 * MINUTE });
      insert({ guid: 'rcs-b1', text: 'again', at: 2_000 * MINUTE + 1_000 });
      insert({ guid: 'temp-b2', text: 'again', at: 2_000 * MINUTE + 5_000 });
      insert({ guid: 'rcs-b2', text: 'again', at: 2_000 * MINUTE + 6_000 });
      // Two leftovers but only one server copy: only the nearer leftover pairs; one stays visible.
      insert({ guid: 'temp-c1', text: 'lonely', at: 3_000 * MINUTE });
      insert({ guid: 'temp-c2', text: 'lonely', at: 3_000 * MINUTE + 30_000 });
      insert({ guid: 'rcs-c', text: 'lonely', at: 3_000 * MINUTE + 1_000 });
    });
    try {
      expect(hidden).toEqual(['temp-a', 'temp-b1', 'temp-b2', 'temp-c1']);
      expect(
        raw
          .prepare('SELECT guid, chat_guid AS chatGuid FROM message_deletion_ledger ORDER BY guid')
          .all(),
      ).toEqual(
        ['temp-a', 'temp-b1', 'temp-b2', 'temp-c1'].map((guid) => ({ guid, chatGuid: RCS })),
      );
      // The chat sorts by its newest visible message: here a server copy, never a hidden leftover.
      expect(
        raw.prepare('SELECT latest_message_date AS at FROM chats WHERE id = ?').get(chats[RCS]),
      ).toEqual({
        at: 3_000 * MINUTE + 30_000,
      });
      expect(
        raw.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'm0056_leftovers'").all(),
      ).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('leaves every row that is not a clear text double alone', async () => {
    const { raw, hidden } = await migrateWith((insert, chats) => {
      const iMessage = chats['iMessage;-;+15551234567'];
      const otherRcs = chats['RCS;-;gpe1_test:conversation-2'];
      insert({ guid: 'rcs-server', text: 'hi', at: 5_000 * MINUTE });
      // Unsent or failed local bubbles are real messages the user can retry.
      insert({ guid: 'temp-sending', text: 'hi', at: 5_000 * MINUTE + 1, sendState: 'sending' });
      insert({ guid: 'temp-error', text: 'hi', at: 5_000 * MINUTE + 2, sendState: 'error' });
      // Further apart than ten minutes.
      insert({ guid: 'temp-late', text: 'later', at: 6_000 * MINUTE });
      insert({ guid: 'rcs-late', text: 'later', at: 6_000 * MINUTE + 10 * MINUTE + 1 });
      // Different words.
      insert({ guid: 'temp-words', text: 'abc', at: 7_000 * MINUTE });
      insert({ guid: 'rcs-words', text: 'abd', at: 7_000 * MINUTE });
      // Pictures, reactions and empty text are out of scope.
      insert({ guid: 'temp-pic', text: 'cap', at: 8_000 * MINUTE, attachment: true });
      insert({ guid: 'rcs-pic', text: 'cap', at: 8_000 * MINUTE });
      insert({ guid: 'temp-love', text: '', at: 9_000 * MINUTE, reaction: true });
      insert({ guid: 'rcs-love', text: '', at: 9_000 * MINUTE, reaction: true });
      // An attachment row without the has_attachments flag, and a reaction that carries text.
      insert({
        guid: 'temp-unflagged',
        text: 'pic',
        at: 9_100 * MINUTE,
        attachment: true,
        attachmentFlag: false,
      });
      insert({ guid: 'rcs-unflagged', text: 'pic', at: 9_100 * MINUTE });
      insert({ guid: 'temp-love-text', text: 'Loved', at: 9_200 * MINUTE, reaction: true });
      insert({ guid: 'rcs-love-text', text: 'Loved', at: 9_200 * MINUTE });
      // The server copy must be ours, in the same chat, and RCS.
      insert({ guid: 'temp-peer', text: 'echo', at: 10_000 * MINUTE });
      insert({ guid: 'rcs-peer', text: 'echo', at: 10_000 * MINUTE, fromMe: false });
      insert({ guid: 'temp-otherchat', text: 'where', at: 11_000 * MINUTE });
      insert({ guid: 'rcs-otherchat', text: 'where', at: 11_000 * MINUTE, chat: otherRcs });
      insert({ guid: 'temp-imsg', text: 'blue', at: 12_000 * MINUTE, chat: iMessage });
      insert({ guid: 'imsg-server', text: 'blue', at: 12_000 * MINUTE, chat: iMessage });
    });
    try {
      expect(hidden).toEqual([]);
      expect(raw.prepare('SELECT COUNT(*) AS n FROM message_deletion_ledger').get()).toEqual({
        n: 0,
      });
    } finally {
      raw.close();
    }
  });
});
