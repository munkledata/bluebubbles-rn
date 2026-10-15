/**
 * Retiring an outgoing send marks its temp row and the canonical row its scoped alias points to.
 * Both lookups must use indexes: an OR with a correlated alias subquery made SQLite scan every
 * message while holding the global write lock (review M066).
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  insertOutgoingText,
  retireUncertainOutgoingWithinTransaction,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';
import { retireOutgoing } from '../support/repositoryWrappers';

const CHAT_GUID = 'iMessage;-;+15550000003';

async function seedAliasedSend(db: AppDatabase, raw: Database.Database, tempGuid: string) {
  const handles = await upsertHandles(db, [{ address: '+15550000003' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: CHAT_GUID, participants: [{ address: '+15550000003' }] })],
    handles,
  );
  const chatId = chats.get(CHAT_GUID)!;
  // Canonical GUIDs are real server ids; the alias table rejects a temp-looking one.
  const canonical = `real-${tempGuid}`;
  await upsertMessages(
    db,
    [Message.parse({ guid: canonical, text: 'promoted send', dateCreated: 1, isFromMe: true })],
    () => chatId,
    handles,
  );
  raw.prepare(`UPDATE messages SET send_state = 'sending' WHERE guid = ?`).run(canonical);
  await insertOutgoingText(db, { tempGuid, chatId, chatGuid: CHAT_GUID, text: 'queued', now: 10 });
  raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);
  raw
    .prepare(
      `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid) VALUES (?, ?, ?)`,
    )
    .run(tempGuid, canonical, CHAT_GUID);
  return canonical;
}

/** Record every statement the repository prepares while `run` executes. */
async function captureStatements(raw: Database.Database, run: () => Promise<unknown>) {
  const statements: string[] = [];
  const prepare = raw.prepare.bind(raw);
  const spy = jest.spyOn(raw, 'prepare').mockImplementation(((source: string) => {
    statements.push(source);
    return prepare(source);
  }) as typeof raw.prepare);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

function messageUpdatesThatScan(raw: Database.Database, statements: string[]): string[] {
  return statements
    .filter((statement) => /^\s*update\s+"?messages"?\s/i.test(statement))
    .filter((statement) => {
      const params = (statement.match(/\?/g) ?? []).map(() => null);
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params) as {
        detail: string;
      }[];
      return plan.some((row) => /^SCAN messages\b/.test(row.detail));
    });
}

describe('outgoing retirement lookups', () => {
  it('retires a scoped alias send through indexes only', async () => {
    const { db, raw } = await createTestDb();
    try {
      const canonical = await seedAliasedSend(db, raw, 'temp-retire');
      const statements = await captureStatements(raw, () => retireOutgoing(db, 'temp-retire', 55));

      expect(
        raw
          .prepare('SELECT send_state AS state, error FROM messages WHERE guid = ?')
          .get(canonical),
      ).toEqual({ state: 'error', error: 55 });
      expect(statements.some((s) => /^\s*update\s+"?messages"?\s/i.test(s))).toBe(true);
      expect(messageUpdatesThatScan(raw, statements)).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('retires an uncertain scoped alias send through indexes only', async () => {
    const { db, raw } = await createTestDb();
    try {
      const canonical = await seedAliasedSend(db, raw, 'temp-uncertain');
      let marked: boolean | undefined;
      const statements = await captureStatements(raw, async () => {
        marked = await withDbTransaction(db, (context) =>
          retireUncertainOutgoingWithinTransaction(context, 'temp-uncertain', 66, 'unknown'),
        );
      });

      expect(marked).toBe(true);
      expect(
        raw
          .prepare(
            'SELECT send_state AS state, error, error_message AS detail FROM messages WHERE guid = ?',
          )
          .get(canonical),
      ).toEqual({ state: 'error', error: 66, detail: 'unknown' });
      expect(messageUpdatesThatScan(raw, statements)).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
