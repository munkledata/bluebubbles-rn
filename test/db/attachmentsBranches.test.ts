/**
 * Branch top-ups for src/db/repositories/attachments.ts — the empty-input early returns, the
 * media bucketing (photo/video/document) with the all-buckets-full early break + link dedup,
 * getAttachmentByGuid miss, and the temp→real reconcile DELETE branch. Each case asserts
 * observable DB state.
 */
import type Database from 'better-sqlite3';
import { Attachment, Chat, Message } from '@core/models';
import {
  getAttachmentByGuid,
  getChatIdByGuid,
  insertOutgoingAttachment,
  type InsertOutgoingAttachmentArgs,
  listAttachmentsByMessageIds,
  listChatAttachmentsByKind,
  listChatImageAttachmentsByAttachmentGuid,
  updateAttachmentLocalPath,
  upsertAttachments,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { attachments, chats, messages, outgoingQueue } from '@db/schema';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

type OutgoingAttachmentArgs = InsertOutgoingAttachmentArgs & { chatId: number };

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function errorMessageChain(error: unknown): unknown[] {
  const messages: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current != null; depth += 1) {
    const record = current as { message?: unknown; cause?: unknown };
    messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

function latestMessageDate(raw: Database.Database, chatId: number): number | null {
  return (
    raw.prepare('SELECT latest_message_date AS value FROM chats WHERE id = ?').get(chatId) as {
      value: number | null;
    }
  ).value;
}

function expectNoOutgoingAttachmentRows(
  raw: Database.Database,
  args: OutgoingAttachmentArgs,
): void {
  expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get(args.tempGuid)).toBeUndefined();
  expect(
    raw.prepare('SELECT id FROM attachments WHERE guid = ?').get(args.attachmentGuid),
  ).toBeUndefined();
  expect(
    raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
  ).toBeUndefined();
}

function expectExactOutgoingAttachmentRows(
  raw: Database.Database,
  args: OutgoingAttachmentArgs,
  expectedLatestMessageDate: number,
): void {
  const message = raw
    .prepare(
      `SELECT id, guid, chat_id AS chatId, is_from_me AS isFromMe,
              date_created AS dateCreated, has_attachments AS hasAttachments,
              send_state AS sendState, error
         FROM messages WHERE guid = ?`,
    )
    .get(args.tempGuid) as {
    id: number;
    guid: string;
    chatId: number;
    isFromMe: number;
    dateCreated: number;
    hasAttachments: number;
    sendState: string;
    error: number;
  };
  expect(message).toEqual({
    id: expect.any(Number),
    guid: args.tempGuid,
    chatId: args.chatId,
    isFromMe: 1,
    dateCreated: args.now,
    hasAttachments: 1,
    sendState: 'sending',
    error: 0,
  });
  expect(
    raw
      .prepare(
        `SELECT guid, message_id AS messageId, mime_type AS mimeType,
                transfer_name AS transferName, total_bytes AS totalBytes,
                width, height, local_path AS localPath
           FROM attachments WHERE guid = ?`,
      )
      .get(args.attachmentGuid),
  ).toEqual({
    guid: args.attachmentGuid,
    messageId: message.id,
    mimeType: args.mimeType,
    transferName: args.transferName,
    totalBytes: args.totalBytes,
    width: args.width ?? null,
    height: args.height ?? null,
    localPath: args.localPath,
  });
  expect(
    raw
      .prepare(
        `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload,
                attempts, next_retry_at AS nextRetryAt
           FROM outgoing_queue WHERE temp_guid = ?`,
      )
      .get(args.tempGuid),
  ).toEqual({
    tempGuid: args.tempGuid,
    chatGuid: args.chatGuid,
    kind: 'attachment',
    payload: JSON.stringify({ attachmentGuid: args.attachmentGuid, localPath: args.localPath }),
    attempts: 0,
    nextRetryAt: 0,
  });
  expect(latestMessageDate(raw, args.chatId)).toBe(expectedLatestMessageDate);
}

interface DriverGate {
  didStart: boolean;
  held: Promise<void>;
  finished: Promise<void>;
  release(): void;
  markFinished(): void;
}

function driverGate(): DriverGate {
  let release!: () => void;
  let markFinished!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return { didStart: false, held, finished, release, markFinished };
}

function gateThenable<T extends object>(thenable: T, gate: DriverGate): T {
  return new Proxy(thenable, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'then') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (onFulfilled: unknown, onRejected: unknown) => {
        gate.didStart = true;
        return gate.held
          .then(() =>
            Reflect.apply(value as (...args: unknown[]) => unknown, target, [
              onFulfilled,
              onRejected,
            ]),
          )
          .finally(gate.markFinished);
      };
    },
  });
}

async function waitForDriverGate(gate: DriverGate, label: string): Promise<void> {
  for (let turn = 0; turn < 20 && !gate.didStart; turn += 1) {
    await nextEventLoopTurn();
  }
  if (!gate.didStart) throw new Error(`${label} did not start within 20 event-loop turns`);
}

async function holdRollingBackTransaction(db: AppDatabase): Promise<{
  release: () => void;
  failure: Promise<unknown>;
}> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const neighbour = withDbTransaction(db, async () => {
    markStarted();
    await held;
    throw new Error('neighbour rollback');
  });
  const failure = neighbour.then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

async function finishAfterQueuedObservation<T>(
  neighbour: { release: () => void; failure: Promise<unknown> },
  pending: Promise<T>,
  observe: () => void | Promise<void>,
): Promise<T> {
  let observationError: unknown;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await observe();
  } catch (error) {
    observationError = error;
  } finally {
    neighbour.release();
  }
  const neighbourError = await neighbour.failure;
  const result = await pending;
  if (observationError) throw observationError;
  expect(String(neighbourError)).toContain('neighbour rollback');
  return result;
}

async function seedChat(db: AppDatabase, guid = 'c1'): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  return (await getChatIdByGuid(db, guid))!;
}
/** Upsert a message (optionally with attachments/text) and return its row id. */
async function putMsg(
  db: AppDatabase,
  chatId: number,
  m: Record<string, unknown>,
): Promise<number> {
  const map = await upsertMessages(db, [Message.parse(m)], () => chatId, new Map());
  return map.get(m.guid as string)!;
}

describe('empty-input early returns', () => {
  it('upsertAttachments does nothing for [] and for guid-less items', async () => {
    const { db } = await createTestDb();
    await expect(upsertAttachments(db, [])).resolves.toBeUndefined();
    // A message with an item whose att has no guid → filtered → deduped empty → early return.
    const chatId = await seedChat(db);
    const id = await putMsg(db, chatId, { guid: 'm0', dateCreated: 1 });
    await expect(
      upsertAttachments(db, [{ att: { guid: '' } as unknown as Attachment, messageId: id }]),
    ).resolves.toBeUndefined();
    expect(await listAttachmentsByMessageIds(db, [id])).toEqual(new Map());
  });

  it('listAttachmentsByMessageIds returns an empty map for no ids', async () => {
    const { db } = await createTestDb();
    expect(await listAttachmentsByMessageIds(db, [])).toEqual(new Map());
  });

  it('getAttachmentByGuid returns null for a miss', async () => {
    const { db } = await createTestDb();
    expect(await getAttachmentByGuid(db, 'ghost')).toBeNull();
  });
});

describe('listChatAttachmentsByKind — bucketing + early break + link dedup', () => {
  it('buckets photos/videos/documents, stops once all buckets are full, and dedups links', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cMedia');
    // Newest-first scan; give descending dates. limit=1 so all three buckets fill fast and the
    // all-buckets-full break (line ~212) fires while a row still remains. Order so a photo, video
    // AND document all land inside the bounded scan window (limit*4), with a trailing extra row
    // AFTER all three buckets are full so the early break actually executes.
    const media: Array<[string, string, number]> = [
      ['p1', 'image/jpeg', 100],
      ['v1', 'video/mp4', 99],
      ['d1', 'application/pdf', 98],
      ['p2', 'image/png', 97], // trailing row: reached only if the break DIDN'T fire
    ];
    for (const [g, mime, date] of media) {
      await putMsg(db, chatId, {
        guid: `msg-${g}`,
        dateCreated: date,
        chats: [{ guid: 'cMedia' }],
        attachments: [{ guid: g, mimeType: mime }],
      });
    }
    // One link (the newest) — the per-bucket `limit` caps links too.
    await putMsg(db, chatId, {
      guid: 'L1',
      text: 'see https://a.com/x',
      dateCreated: 200,
      chats: [{ guid: 'cMedia' }],
    });

    const res = await listChatAttachmentsByKind(db, 'cMedia', 1);
    expect(res.photos).toHaveLength(1);
    expect(res.videos).toHaveLength(1);
    expect(res.documents).toHaveLength(1);
    // Newest of each kind wins the single slot.
    expect(res.photos[0]!.guid).toBe('p1');
    expect(res.videos[0]!.guid).toBe('v1');
    expect(res.documents[0]!.guid).toBe('d1');
    expect(res.links.map((l) => l.url)).toEqual(['https://a.com/x']);
  });

  it('dedups repeated link URLs to the most recent occurrence', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cLinks');
    // Two messages share a URL (dedup → one entry), one distinct URL. A high limit keeps the
    // loop from breaking early so the seen-URL `continue` branch is exercised.
    await putMsg(db, chatId, {
      guid: 'L1',
      text: 'see https://a.com/x',
      dateCreated: 200,
      chats: [{ guid: 'cLinks' }],
    });
    await putMsg(db, chatId, {
      guid: 'L2',
      text: 'also https://a.com/x again',
      dateCreated: 190,
      chats: [{ guid: 'cLinks' }],
    });
    await putMsg(db, chatId, {
      guid: 'L3',
      text: 'new https://b.com/y',
      dateCreated: 180,
      chats: [{ guid: 'cLinks' }],
    });
    const res = await listChatAttachmentsByKind(db, 'cLinks', 5);
    expect(res.links.map((l) => l.url)).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(res.links[0]!.messageGuid).toBe('L1'); // most-recent occurrence of the deduped URL
  });
});

describe('insertOutgoingAttachment — transaction owner and async lifetime', () => {
  it('waits behind a newer committed chat date and never regresses inbox ordering', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cQueuedImage');
    const args: OutgoingAttachmentArgs = {
      tempGuid: 'temp-image-older-than-neighbour',
      attachmentGuid: 'temp-image-older-than-neighbour-att',
      chatId,
      chatGuid: 'cQueuedImage',
      localPath: 'file:///queued-high-entropy.heic',
      mimeType: 'image/heic',
      transferName: 'queued-high-entropy.heic',
      totalBytes: 4_321_987,
      height: 720,
      now: 2_000,
    };
    const newerDate = 9_000;
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourOutcome = withDbTransaction(db, async () => {
      raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = ?').run(newerDate, chatId);
      neighbourStarted();
      await held;
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await started;

    let helperSettled = false;
    const helperOutcome = insertOutgoingAttachment(db, args)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });
    let observationError: unknown;
    try {
      await nextEventLoopTurn();
      expect(helperSettled).toBe(false);
      expectNoOutgoingAttachmentRows(raw, args);
      expect(latestMessageDate(raw, chatId)).toBe(newerDate);
    } catch (error) {
      observationError = error;
    } finally {
      releaseNeighbour();
    }
    const [neighbour, helper] = await Promise.all([neighbourOutcome, helperOutcome]);
    if (observationError) throw observationError;

    expect(neighbour).toEqual({ kind: 'resolved' });
    expect(helper).toEqual({ kind: 'resolved', value: undefined });
    expectExactOutgoingAttachmentRows(raw, args, newerDate);
  });

  it('rolls every insert back when the final chat update fails, then retries exactly', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cAtomicImage');
    const args: OutgoingAttachmentArgs = {
      tempGuid: 'temp-image-final-update-failure',
      attachmentGuid: 'temp-image-final-update-failure-att',
      chatId,
      chatGuid: 'cAtomicImage',
      localPath: 'file:///atomic-wide.png',
      mimeType: 'image/png',
      transferName: 'atomic-wide.png',
      totalBytes: 98_765,
      width: 1_920,
      height: 1_080,
      now: 10_000,
    };
    const canary = 'OUTGOING_ATTACHMENT_CHAT_UPDATE_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER reject_outgoing_attachment_chat_update
      BEFORE UPDATE OF latest_message_date ON chats
      WHEN OLD.id = ${chatId} AND NEW.latest_message_date = ${args.now}
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const failure = await insertOutgoingAttachment(db, args).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(failure.kind).toBe('rejected');
    if (failure.kind === 'rejected') {
      expect(errorMessageChain(failure.error)).toContain(canary);
    }
    expectNoOutgoingAttachmentRows(raw, args);
    expect(latestMessageDate(raw, chatId)).toBeNull();

    raw.exec('DROP TRIGGER reject_outgoing_attachment_chat_update');
    await expect(insertOutgoingAttachment(db, args)).resolves.toBeUndefined();
    expectExactOutgoingAttachmentRows(raw, args, args.now);
  });

  it('awaits message, attachment, queue, and chat driver writes in exact order', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cDelayedImage');
    const oldDate = 100;
    raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = ?').run(oldDate, chatId);
    const args: OutgoingAttachmentArgs = {
      tempGuid: 'temp-image-delayed-writes',
      attachmentGuid: 'temp-image-delayed-writes-att',
      chatId,
      chatGuid: 'cDelayedImage',
      localPath: 'file:///delayed-portrait.webp',
      mimeType: 'image/webp',
      transferName: 'delayed-portrait.webp',
      totalBytes: 12_345,
      width: 640,
      height: 960,
      now: 500,
    };
    const stages = {
      message: driverGate(),
      attachment: driverGate(),
      queue: driverGate(),
      chat: driverGate(),
    };

    type Insert = (table: unknown) => { values(values: unknown): object };
    type Update = (table: unknown) => {
      set(values: unknown): { where(condition: unknown): object };
    };
    const realInsert = db.insert.bind(db) as unknown as Insert;
    const realUpdate = db.update.bind(db) as unknown as Update;
    const insertSpy = jest.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      const builder = realInsert(table);
      const gate =
        table === messages
          ? stages.message
          : table === attachments
            ? stages.attachment
            : table === outgoingQueue
              ? stages.queue
              : undefined;
      if (!gate) return builder;
      return new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'values') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (values: unknown) => gateThenable(target.values(values), gate);
        },
      });
    }) as unknown as AppDatabase['insert']);
    const updateSpy = jest.spyOn(db, 'update').mockImplementation(((table: unknown) => {
      const builder = realUpdate(table);
      if (table !== chats) return builder;
      return new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'set') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (values: unknown) => {
            const setBuilder = target.set(values);
            return new Proxy(setBuilder, {
              get(setTarget, setProperty) {
                const setValue = Reflect.get(setTarget, setProperty, setTarget);
                if (setProperty !== 'where') {
                  return typeof setValue === 'function' ? setValue.bind(setTarget) : setValue;
                }
                return (condition: unknown) =>
                  gateThenable(setTarget.where(condition), stages.chat);
              },
            });
          };
        },
      });
    }) as unknown as AppDatabase['update']);

    let helperSettled = false;
    let helperOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      helperOutcome = insertOutgoingAttachment(db, args)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });

      await waitForDriverGate(stages.message, 'outgoing message insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expectNoOutgoingAttachmentRows(raw, args);
      expect(stages.attachment.didStart).toBe(false);
      expect(stages.queue.didStart).toBe(false);
      expect(stages.chat.didStart).toBe(false);
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);
      stages.message.release();
      await stages.message.finished;

      await waitForDriverGate(stages.attachment, 'outgoing attachment insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(raw.prepare('SELECT guid FROM messages WHERE guid = ?').get(args.tempGuid)).toEqual({
        guid: args.tempGuid,
      });
      expect(
        raw.prepare('SELECT id FROM attachments WHERE guid = ?').get(args.attachmentGuid),
      ).toBeUndefined();
      expect(
        raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
      ).toBeUndefined();
      expect(stages.queue.didStart).toBe(false);
      expect(stages.chat.didStart).toBe(false);
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);
      stages.attachment.release();
      await stages.attachment.finished;

      await waitForDriverGate(stages.queue, 'outgoing attachment queue insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(raw.prepare('SELECT guid FROM messages WHERE guid = ?').get(args.tempGuid)).toEqual({
        guid: args.tempGuid,
      });
      expect(
        raw.prepare('SELECT guid FROM attachments WHERE guid = ?').get(args.attachmentGuid),
      ).toEqual({ guid: args.attachmentGuid });
      expect(
        raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
      ).toBeUndefined();
      expect(stages.chat.didStart).toBe(false);
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);
      stages.queue.release();
      await stages.queue.finished;

      await waitForDriverGate(stages.chat, 'outgoing attachment chat update');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(
        raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
      ).toEqual({ id: expect.any(Number) });
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);

      stages.chat.release();
      const [outcome] = await Promise.all([helperOutcome, stages.chat.finished]);
      expect(outcome).toEqual({ kind: 'resolved', value: undefined });
      expect(helperSettled).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expectExactOutgoingAttachmentRows(raw, args, args.now);
    } finally {
      for (const gate of Object.values(stages)) gate.release();
      try {
        const drains: Promise<unknown>[] = [];
        if (helperOutcome) drains.push(helperOutcome);
        for (const gate of Object.values(stages)) {
          if (gate.didStart) drains.push(gate.finished);
        }
        await Promise.allSettled(drains);
      } finally {
        updateSpy.mockRestore();
        insertSpy.mockRestore();
      }
    }
  });
});

describe('upsertAttachments — temp→real reconcile DELETE branch', () => {
  it('queues a public upsert behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    const messageId = await putMsg(db, chatId, { guid: 'queued-owner', dateCreated: 1 });
    const neighbour = await holdRollingBackTransaction(db);
    const pending = upsertAttachments(db, [
      {
        att: Attachment.parse({ guid: 'queued-att', mimeType: 'image/jpeg' }),
        messageId,
      },
    ]);

    await finishAfterQueuedObservation(neighbour, pending, () => {
      expect(
        raw.prepare("SELECT guid FROM attachments WHERE guid = 'queued-att'").get(),
      ).toBeUndefined();
    });

    expect(raw.prepare("SELECT guid FROM attachments WHERE guid = 'queued-att'").get()).toEqual({
      guid: 'queued-att',
    });
  });

  it('restores the temp local-path carrier when the final upsert fails', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-atomic-message',
      attachmentGuid: 'temp-atomic-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///keep-me.jpg',
      mimeType: 'image/jpeg',
      transferName: 'keep-me.jpg',
      totalBytes: 10,
      now: 1,
    });
    const messageId = (
      raw.prepare("SELECT id FROM messages WHERE guid = 'temp-atomic-message'").get() as {
        id: number;
      }
    ).id;
    raw.exec(`
      CREATE TRIGGER fail_real_attachment_upsert
      BEFORE INSERT ON attachments
      WHEN NEW.guid = 'real-atomic-att'
      BEGIN
        SELECT RAISE(ABORT, 'forced final attachment failure');
      END
    `);

    let failure: unknown;
    try {
      await upsertAttachments(db, [
        {
          att: Attachment.parse({ guid: 'real-atomic-att', mimeType: 'image/jpeg' }),
          messageId,
        },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain('forced final attachment failure');
    expect(
      raw
        .prepare('SELECT guid, local_path localPath FROM attachments WHERE message_id = ?')
        .get(messageId),
    ).toEqual({ guid: 'temp-atomic-att', localPath: 'file:///keep-me.jpg' });
  });

  it('rolls back attachment ingestion when its account guard is revoked during the write', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    const messageId = await putMsg(db, chatId, { guid: 'guard-owner', dateCreated: 1 });
    let current = true;
    raw.function('revoke_attachment_guard', () => {
      current = false;
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER revoke_attachment_guard_after_insert
      AFTER INSERT ON attachments
      WHEN NEW.guid = 'guard-revoked-att'
      BEGIN
        SELECT revoke_attachment_guard();
      END
    `);

    let failure: unknown;
    try {
      await upsertAttachments(
        db,
        [
          {
            att: Attachment.parse({ guid: 'guard-revoked-att', mimeType: 'image/jpeg' }),
            messageId,
          },
        ],
        () => current,
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain('database commit guard rejected');
    expect(
      raw.prepare("SELECT guid FROM attachments WHERE guid = 'guard-revoked-att'").get(),
    ).toBeUndefined();
  });

  it('drops the temp -att row when the real guid already exists on the message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    // Optimistic picture: message + temp `-att` (with a local_path).
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-m',
      attachmentGuid: 'temp-m-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///pic.jpg',
      mimeType: 'image/jpeg',
      transferName: 'pic.jpg',
      totalBytes: 10,
      now: 1,
    });
    const messageId = (
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('temp-m') as { id: number }
    ).id;
    // The REAL attachment already exists on the same message (raw-insert so this doesn't itself reconcile).
    raw
      .prepare('INSERT INTO attachments (guid, message_id, mime_type) VALUES (?, ?, ?)')
      .run('real-att', messageId, 'image/jpeg');
    // Now the echo upsert arrives for the real att → temp found + real exists → DELETE temp branch.
    await upsertAttachments(db, [
      { att: Attachment.parse({ guid: 'real-att', mimeType: 'image/jpeg' }), messageId },
    ]);

    const atts = (await listAttachmentsByMessageIds(db, [messageId])).get(messageId)!;
    expect(atts.map((a) => a.guid)).toEqual(['real-att']); // temp-m-att deleted, no duplicate
  });
});

describe('Genmoji fields round-trip via the chat-scoped reads', () => {
  it('listChatImageAttachmentsByAttachmentGuid + listChatAttachmentsByKind carry the identifier + description', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cGen');
    await putMsg(db, chatId, {
      guid: 'm-gen',
      dateCreated: 10,
      chats: [{ guid: 'cGen' }],
      attachments: [
        {
          guid: 'gen-1',
          mimeType: 'image/png',
          emojiImageContentIdentifier: 'gm-xyz',
          emojiImageShortDescription: 'a dancing robot',
        },
      ],
    });

    // The fullscreen image-carousel query keeps the fields on each image row.
    const carousel = await listChatImageAttachmentsByAttachmentGuid(db, 'gen-1');
    const hit = carousel.items[carousel.index]!;
    expect(hit.emojiImageContentIdentifier).toBe('gm-xyz');
    expect(hit.emojiImageShortDescription).toBe('a dancing robot');

    // The conversation-details "shared media" query buckets it under photos with the fields intact.
    const media = await listChatAttachmentsByKind(db, 'cGen', 10);
    expect(media.photos[0]!.emojiImageContentIdentifier).toBe('gm-xyz');
    expect(media.photos[0]!.emojiImageShortDescription).toBe('a dancing robot');
  });
});

describe('updateAttachmentLocalPath', () => {
  it('persists a downloaded file path onto the attachment', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    const id = await putMsg(db, chatId, {
      guid: 'msg-dl',
      dateCreated: 1,
      chats: [{ guid: 'c1' }],
      attachments: [{ guid: 'att-dl', mimeType: 'image/jpeg' }],
    });
    await expect(updateAttachmentLocalPath(db, 'att-dl', 'file:///downloaded.jpg')).resolves.toBe(
      true,
    );
    const atts = (await listAttachmentsByMessageIds(db, [id])).get(id)!;
    expect(atts[0]!.localPath).toBe('file:///downloaded.jpg');

    await expect(updateAttachmentLocalPath(db, 'missing-att', 'file:///orphan.jpg')).resolves.toBe(
      false,
    );

    raw.prepare('UPDATE messages SET date_deleted = 2 WHERE guid = ?').run('msg-dl');
    await expect(updateAttachmentLocalPath(db, 'att-dl', 'file:///after-delete.jpg')).resolves.toBe(
      false,
    );
    expect((await listAttachmentsByMessageIds(db, [id])).get(id)![0]!.localPath).toBe(
      'file:///downloaded.jpg',
    );
  });

  it('queues a standalone path update behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await putMsg(db, chatId, {
      guid: 'msg-queued-download',
      dateCreated: 1,
      chats: [{ guid: 'c1' }],
      attachments: [{ guid: 'att-queued-download', mimeType: 'image/jpeg' }],
    });

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await held;
      throw new Error('neighbour rollback');
    });
    await started;

    const updating = updateAttachmentLocalPath(db, 'att-queued-download', 'file:///queued.jpg');
    await Promise.resolve();
    expect(
      raw
        .prepare("SELECT local_path AS localPath FROM attachments WHERE guid='att-queued-download'")
        .get(),
    ).toEqual({ localPath: null });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(updating).resolves.toBe(true);
    expect(
      raw
        .prepare("SELECT local_path AS localPath FROM attachments WHERE guid='att-queued-download'")
        .get(),
    ).toEqual({ localPath: 'file:///queued.jpg' });
  });
});

/**
 * D15 — the conflict clause must PRESERVE what a payload legitimately omits.
 *
 * A file shared INTO Gator arrives as {uri, name, mimeType, size} with no dimensions, so its
 * attachment row is inserted with NULL width/height. The server then reports the real dimensions
 * on every later fetch — and a plain `excluded.width` overwrite in one direction (or a NULL from
 * the bare socket echo in the other) is what left a landscape photo boxed at the portrait fallback
 * ratio permanently: the row already exists, so no re-sync could ever correct it.
 */
describe('upsertAttachments — width/height/transferName are COALESCE-preserved', () => {
  it('fills in dimensions the first payload lacked', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cDim');
    const id = await putMsg(db, chatId, {
      guid: 'm-dim',
      dateCreated: 1,
      chats: [{ guid: 'cDim' }],
    });
    // Shared-in: no dimensions, no display name.
    await upsertAttachments(db, [
      {
        att: Attachment.parse({ guid: 'att-dim', mimeType: 'image/jpeg' }),
        messageId: id,
      },
    ]);
    // The server's copy of the same attachment carries the real shape.
    await upsertAttachments(db, [
      {
        att: Attachment.parse({
          guid: 'att-dim',
          mimeType: 'image/jpeg',
          width: 4032,
          height: 3024,
          transferName: 'IMG_0042.jpg',
        }),
        messageId: id,
      },
    ]);

    const row = (await getAttachmentByGuid(db, 'att-dim'))!;
    expect(row.width).toBe(4032);
    expect(row.height).toBe(3024);
    expect(row.transferName).toBe('IMG_0042.jpg');
  });

  it('a later payload WITHOUT dimensions does not wipe the good ones', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cKeep');
    const id = await putMsg(db, chatId, {
      guid: 'm-keep',
      dateCreated: 1,
      chats: [{ guid: 'cKeep' }],
    });
    await upsertAttachments(db, [
      {
        att: Attachment.parse({
          guid: 'att-keep',
          mimeType: 'image/jpeg',
          width: 1600,
          height: 900,
          transferName: 'wide.jpg',
        }),
        messageId: id,
      },
    ]);
    // The bare live echo (and the lastMessage hydration) omit both.
    await upsertAttachments(db, [
      { att: Attachment.parse({ guid: 'att-keep', mimeType: 'image/jpeg' }), messageId: id },
    ]);

    const row = (await getAttachmentByGuid(db, 'att-keep'))!;
    expect(row.width).toBe(1600);
    expect(row.height).toBe(900);
    expect(row.transferName).toBe('wide.jpg');
  });

  it('adding those columns did not drag local_path into the clause (a re-sync cannot blank it)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cLp');
    const id = await putMsg(db, chatId, {
      guid: 'm-lp',
      dateCreated: 1,
      chats: [{ guid: 'cLp' }],
    });
    await upsertAttachments(db, [
      { att: Attachment.parse({ guid: 'att-lp', mimeType: 'image/jpeg' }), messageId: id },
    ]);
    await updateAttachmentLocalPath(db, 'att-lp', 'file:///on-disk.jpg');
    await upsertAttachments(db, [
      {
        att: Attachment.parse({ guid: 'att-lp', mimeType: 'image/jpeg', width: 10, height: 10 }),
        messageId: id,
      },
    ]);
    expect((await getAttachmentByGuid(db, 'att-lp'))!.localPath).toBe('file:///on-disk.jpg');
  });
});
