import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { claimScheduled, insertScheduled } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { sendImageMessage, type AttachmentUploader } from '@/services/send/sendAttachmentService';
import { sendContactMessage } from '@/services/send/sendContactService';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import { sendTextMessage } from '@/services/send/sendService';
import { createTestDb } from '../support/testDb';

type SendKind = 'text' | 'contact' | 'reaction' | 'attachment';

const SEND_KINDS: SendKind[] = ['text', 'contact', 'reaction', 'attachment'];

const IMAGE = {
  uri: 'file:///identity-race.jpg',
  name: 'identity-race.jpg',
  mimeType: 'image/jpeg',
  size: 123,
};

interface NetworkSnapshot {
  messageChatGuid: string;
  queueChatGuid: string;
  kind: string;
  wireChatGuid: string;
}

interface Observed<T> {
  outcome: Promise<{ kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown }>;
  settled(): boolean;
}

function observe<T>(promise: Promise<T>): Observed<T> {
  let didSettle = false;
  const outcome = promise.then(
    (value) => {
      didSettle = true;
      return { kind: 'fulfilled' as const, value };
    },
    (error: unknown) => {
      didSettle = true;
      return { kind: 'rejected' as const, error };
    },
  );
  return { outcome, settled: () => didSettle };
}

async function nextTurns(count = 2): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} did not happen within 20 event-loop turns`);
}

function count(raw: Database.Database, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function seedChat(raw: Database.Database, guid: string): void {
  raw.prepare('INSERT INTO chats(guid) VALUES (?)').run(guid);
}

function outgoingAtNetworkStart(raw: Database.Database, wireChatGuid: string): NetworkSnapshot {
  const row = raw
    .prepare(
      `SELECT c.guid AS messageChatGuid, q.chat_guid AS queueChatGuid, q.kind
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN outgoing_queue q ON q.temp_guid = m.guid
        ORDER BY m.id DESC
        LIMIT 1`,
    )
    .get() as Omit<NetworkSnapshot, 'wireChatGuid'> | undefined;
  if (!row) throw new Error('network started without durable outgoing state');
  return { ...row, wireChatGuid };
}

function watchChatResolution(
  db: AppDatabase,
  raw: Database.Database,
  scheduledId?: number,
  onFirstLookup?: () => void,
): { inTransactions: boolean[]; scheduledStatuses: string[]; restore(): void } {
  type All = (query: unknown) => unknown;
  const realAll = db.all.bind(db) as All;
  const inTransactions: boolean[] = [];
  const scheduledStatuses: string[] = [];
  const spy = jest.spyOn(db, 'all').mockImplementation(((query: unknown) => {
    const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
    if (shape.includes('select id from chats') && shape.includes('where guid')) {
      inTransactions.push(raw.inTransaction);
      if (inTransactions.length === 1) onFirstLookup?.();
      if (scheduledId != null) {
        const state = raw
          .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
          .get(scheduledId) as { status: string } | undefined;
        scheduledStatuses.push(state?.status ?? 'missing');
      }
    }
    return realAll(query);
  }) as unknown as AppDatabase['all']);
  return { inTransactions, scheduledStatuses, restore: () => spy.mockRestore() };
}

async function holdDeletedChatUntilRollback(
  db: AppDatabase,
  raw: Database.Database,
  chatGuid: string,
): Promise<{ release(): void; outcome: Promise<unknown> }> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = withDbTransaction(db, async () => {
    raw.prepare('DELETE FROM chats WHERE guid = ?').run(chatGuid);
    markStarted();
    await held;
    throw new Error('identity neighbour rollback');
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, outcome };
}

function startSend(
  kind: SendKind,
  db: AppDatabase,
  raw: Database.Database,
  chatGuid: string,
  onNetwork: (snapshot: NetworkSnapshot) => Promise<void> | void,
): Promise<{ tempGuid: string }> {
  const http = {
    post: async (_path: string, _schema: unknown, options?: { json?: unknown }) => {
      const body = (options?.json ?? {}) as { chatGuid?: string };
      await onNetwork(outgoingAtNetworkStart(raw, body.chatGuid ?? 'missing'));
      return { guid: `real-${kind}`, viaPrivateApi: true };
    },
  } as unknown as HttpClient;

  if (kind === 'text') {
    return sendTextMessage(db, http, { chatGuid, text: 'identity text' }, 1_000);
  }
  if (kind === 'contact') {
    return sendContactMessage(
      db,
      http,
      { chatGuid, contact: { firstName: 'Identity', lastName: 'Contact' } },
      1_000,
    );
  }
  if (kind === 'reaction') {
    return sendReactionMessage(
      db,
      http,
      { chatGuid, targetGuid: 'target-message', reaction: 'love' },
      1_000,
    );
  }

  const upload: AttachmentUploader = async (args) => {
    await onNetwork(outgoingAtNetworkStart(raw, args.chatGuid));
    return { guid: 'real-attachment', viaPrivateApi: true };
  };
  return sendImageMessage(db, http, { chatGuid, image: IMAGE }, upload, 1_000);
}

describe('outgoing chat identity is resolved by the optimistic insert owner', () => {
  it.each(SEND_KINDS)(
    '%s waits out a rolled-back chat deletion before lookup and network',
    async (kind) => {
      const { db, raw } = await createTestDb();
      const targetGuid = 'target-chat';
      seedChat(raw, targetGuid);
      seedChat(raw, 'decoy-chat');
      const lookup = watchChatResolution(db, raw);
      const neighbour = await holdDeletedChatUntilRollback(db, raw, targetGuid);
      const network: NetworkSnapshot[] = [];
      let releaseNetwork!: () => void;
      const networkHeld = new Promise<void>((resolve) => {
        releaseNetwork = resolve;
      });
      const send = observe(
        startSend(kind, db, raw, targetGuid, async (snapshot) => {
          network.push(snapshot);
          await networkHeld;
        }),
      );
      let successor: Observed<void> | undefined;
      let observationError: unknown;
      try {
        await nextTurns();
        expect(send.settled()).toBe(false);
        expect(network).toEqual([]);
        expect(count(raw, 'messages')).toBe(0);
        expect(count(raw, 'attachments')).toBe(0);
        expect(count(raw, 'outgoing_queue')).toBe(0);
      } catch (error) {
        observationError = error;
      } finally {
        neighbour.release();
      }

      const neighbourResult = await neighbour.outcome;
      try {
        if (observationError) throw observationError;
        expect(String(neighbourResult)).toContain('identity neighbour rollback');
        await waitFor(() => network.length === 1, `${kind} network start`);
        expect(send.settled()).toBe(false);
        successor = observe(
          withDbTransaction(db, async () => {
            raw.prepare("INSERT INTO kv(key, value) VALUES ('identity.successor', ?)").run(kind);
          }),
        );
        await waitFor(() => successor?.settled() === true, `${kind} DB successor`);
        expect(await successor.outcome).toMatchObject({ kind: 'fulfilled' });
        expect(send.settled()).toBe(false);
        expect(lookup.inTransactions).toEqual([true]);
        expect(network).toEqual([
          {
            messageChatGuid: targetGuid,
            queueChatGuid: targetGuid,
            kind,
            wireChatGuid: targetGuid,
          },
        ]);
      } catch (error) {
        observationError = error;
      } finally {
        releaseNetwork();
      }

      const [sendResult] = await Promise.all([
        send.outcome,
        successor?.outcome ?? Promise.resolve({ kind: 'fulfilled' as const, value: undefined }),
      ]);
      try {
        if (observationError) throw observationError;
        expect(sendResult.kind).toBe('fulfilled');
        expect(
          raw
            .prepare(
              `SELECT c.guid AS chatGuid
               FROM messages m JOIN chats c ON c.id = m.chat_id
              WHERE m.guid = ?`,
            )
            .get(`real-${kind}`),
        ).toEqual({ chatGuid: targetGuid });
      } finally {
        lookup.restore();
        raw.close();
      }
    },
  );

  it.each(SEND_KINDS)(
    '%s rejects a committed missing chat without residue or network',
    async (kind) => {
      const { db, raw } = await createTestDb();
      const lookup = watchChatResolution(db, raw);
      const network: NetworkSnapshot[] = [];
      try {
        const result = await observe(
          startSend(kind, db, raw, 'missing-chat', (snapshot) => {
            network.push(snapshot);
          }),
        ).outcome;
        expect(result.kind).toBe('rejected');
        if (result.kind === 'rejected') expect(String(result.error)).toContain('unknown chat');
        expect(lookup.inTransactions).toEqual([true]);
        expect(network).toEqual([]);
        expect(count(raw, 'messages')).toBe(0);
        expect(count(raw, 'attachments')).toBe(0);
        expect(count(raw, 'outgoing_queue')).toBe(0);
        expect(raw.inTransaction).toBe(false);
      } finally {
        lookup.restore();
        raw.close();
      }
    },
  );

  it('cannot put text lookup and insert in separate queue owners', async () => {
    const { db, raw } = await createTestDb();
    seedChat(raw, 'atomic-chat');
    let deletionOutcome:
      | Promise<{ kind: 'fulfilled'; changes: number } | { kind: 'rejected'; error: unknown }>
      | undefined;
    const lookup = watchChatResolution(db, raw, undefined, () => {
      // Claim the next queue slot synchronously at the exact lookup. If lookup and insert were
      // separate owners, this deletion would commit in their gap. With one owner, the committed
      // message makes the predicate false before this slot runs, so the chat remains available.
      deletionOutcome = withDbTransaction(db, async () => {
        const result = raw
          .prepare(
            `DELETE FROM chats
                   WHERE guid = 'atomic-chat'
                     AND NOT EXISTS (
                       SELECT 1 FROM messages WHERE chat_id = chats.id
                     )`,
          )
          .run();
        return result.changes;
      }).then(
        (changes) => ({ kind: 'fulfilled' as const, changes }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
    });
    const network: NetworkSnapshot[] = [];
    try {
      const send = await observe(
        startSend('text', db, raw, 'atomic-chat', (snapshot) => {
          network.push(snapshot);
        }),
      ).outcome;
      const deletion = await deletionOutcome;
      expect(send.kind).toBe('fulfilled');
      expect(deletion).toEqual({ kind: 'fulfilled', changes: 0 });
      expect(lookup.inTransactions).toEqual([true]);
      expect(network).toEqual([
        {
          messageChatGuid: 'atomic-chat',
          queueChatGuid: 'atomic-chat',
          kind: 'text',
          wireChatGuid: 'atomic-chat',
        },
      ]);
      expect(raw.prepare("SELECT guid FROM chats WHERE guid = 'atomic-chat'").get()).toEqual({
        guid: 'atomic-chat',
      });
    } finally {
      await deletionOutcome;
      lookup.restore();
      raw.close();
    }
  });

  it('keeps scheduled transition, chat lookup, and outgoing insert in one transaction', async () => {
    const { db, raw } = await createTestDb();
    seedChat(raw, 'scheduled-chat');
    const scheduledId = await insertScheduled(db, {
      chatGuid: 'scheduled-chat',
      text: 'scheduled identity',
      scheduledFor: 1,
    });
    expect(await claimScheduled(db, scheduledId)).toBe(true);
    const lookup = watchChatResolution(db, raw, scheduledId);
    const network: NetworkSnapshot[] = [];
    try {
      await sendTextMessage(
        db,
        {
          post: async (_path: string, _schema: unknown, options?: { json?: unknown }) => {
            const body = (options?.json ?? {}) as { chatGuid?: string };
            network.push(outgoingAtNetworkStart(raw, body.chatGuid ?? 'missing'));
            expect(
              raw.prepare('SELECT status FROM scheduled_messages WHERE id = ?').get(scheduledId),
            ).toEqual({ status: 'sent' });
            return { guid: 'real-scheduled', viaPrivateApi: true };
          },
        } as unknown as HttpClient,
        { chatGuid: 'scheduled-chat', text: 'scheduled identity' },
        2_000,
        undefined,
        { scheduledId, transition: { kind: 'sent' } },
      );

      expect(lookup.inTransactions).toEqual([true]);
      expect(lookup.scheduledStatuses).toEqual(['sent']);
      expect(network).toEqual([
        {
          messageChatGuid: 'scheduled-chat',
          queueChatGuid: 'scheduled-chat',
          kind: 'text',
          wireChatGuid: 'scheduled-chat',
        },
      ]);
      expect(raw.inTransaction).toBe(false);
    } finally {
      lookup.restore();
      raw.close();
    }
  });
});
