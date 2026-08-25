/**
 * Branch top-ups for src/db/repositories/outgoing.ts — the guard clauses, backstops, and
 * cancelled-send paths not exercised by echoReconcile/outgoingQueueService. Every case
 * asserts observable DB state (or a documented return value).
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  applyServerSendError,
  cancelOutgoing,
  claimFailedOutgoingForRetry,
  claimOutgoingForSend,
  deleteChatLocal,
  discardOutgoingMessage,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingContact,
  insertOutgoingReaction,
  insertOutgoingText,
  listAttachmentsByMessageIds,
  listMessages,
  listMessagesWithSenders,
  markMessageDeleted,
  markOutgoingSentNoGuid,
  OUTGOING_MAX_ATTEMPTS,
  reconcileEchoByContent,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  retireOutgoing,
  upsertChats,
  upsertHandles,
  upsertMessages,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import { chats, messages, outgoingQueue } from '@db/schema';
import type { AppDatabase } from '@db/types';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  return (await getChatIdByGuid(db, guid))!;
}
const msgState = (raw: Database.Database, guid: string) =>
  raw.prepare('SELECT send_state s, error e FROM messages WHERE guid = ?').get(guid) as
    { s: string; e: number } | undefined;
/** date_deleted for a guid: undefined = no row, null = live, a number = tombstoned. */
const tombstone = (raw: Database.Database, guid: string): number | null | undefined =>
  (
    raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get(guid) as
      { d: number | null } | undefined
  )?.d;
const queueCount = (raw: Database.Database, tempGuid: string): number =>
  (
    raw.prepare('SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid) as {
      c: number;
    }
  ).c;
const deletionLedgerDate = (raw: Database.Database, guid: string): number | undefined =>
  (
    raw.prepare('SELECT date_deleted d FROM message_deletion_ledger WHERE guid = ?').get(guid) as
      { d: number } | undefined
  )?.d;
const messageAliasTarget = (raw: Database.Database, aliasGuid: string): string | undefined =>
  (
    raw
      .prepare(
        'SELECT canonical_guid AS canonicalGuid FROM message_guid_aliases WHERE alias_guid = ?',
      )
      .get(aliasGuid) as { canonicalGuid: string } | undefined
  )?.canonicalGuid;
const outgoingIdentityRow = (raw: Database.Database, guid: string) =>
  raw
    .prepare(
      `SELECT guid, date_created AS dateCreated, date_delivered AS dateDelivered,
              is_from_me AS isFromMe, send_state AS sendState, error,
              date_deleted AS dateDeleted
         FROM messages WHERE guid = ?`,
    )
    .get(guid) as
    | {
        guid: string;
        dateCreated: number;
        dateDelivered: number | null;
        isFromMe: number;
        sendState: string | null;
        error: number;
        dateDeleted: number | null;
      }
    | undefined;

function expectExactOutgoingPromotion(
  raw: Database.Database,
  tempGuid: string,
  server: { guid: string; dateCreated: number; dateDelivered: number | null },
  dateDeleted: number | null = null,
): void {
  expect(outgoingIdentityRow(raw, tempGuid)).toBeUndefined();
  expect(messageAliasTarget(raw, tempGuid)).toBe(server.guid);
  expect(outgoingIdentityRow(raw, server.guid)).toEqual({
    guid: server.guid,
    dateCreated: server.dateCreated,
    dateDelivered: server.dateDelivered,
    isFromMe: 1,
    sendState: 'sent',
    error: 0,
    dateDeleted,
  });
  expect(queueCount(raw, tempGuid)).toBe(0);
}

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

async function holdRollingBackNeighbour(
  db: AppDatabase,
  raw: Database.Database,
  phantomKey: string,
): Promise<{ release(): void; failure: Promise<unknown> }> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = withDbTransaction(db, async () => {
    raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(phantomKey, 'phantom');
    markStarted();
    await held;
    throw new Error('no-guid neighbour rollback');
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

async function finishAfterQueuedObservation<T>(
  neighbour: { release(): void; failure: Promise<unknown> },
  pending: Promise<T>,
  observe: () => void | Promise<void>,
): Promise<T> {
  let observationError: unknown;
  try {
    await nextEventLoopTurn();
    await observe();
  } catch (error) {
    observationError = error;
  } finally {
    neighbour.release();
  }
  const [neighbourError, outcome] = await Promise.all([neighbour.failure, pending]);
  if (observationError) throw observationError;
  expect(String(neighbourError)).toContain('no-guid neighbour rollback');
  return outcome;
}

type OutgoingInsertKind = 'text' | 'contact';

interface OutgoingInsertFixture {
  tempGuid: string;
  chatId: number;
  chatGuid: string;
  text: string;
  now: number;
}

const selectedGuidFor = (args: OutgoingInsertFixture): string => `selected-${args.tempGuid}`;
const threadGuidFor = (args: OutgoingInsertFixture): string => `thread-${args.tempGuid}`;
const subjectFor = (args: OutgoingInsertFixture): string => `Subject ${args.tempGuid}`;
const effectFor = (args: OutgoingInsertFixture): string =>
  `com.apple.MobileSMS.expressivesend.${args.tempGuid}`;
const contactFor = (args: OutgoingInsertFixture) => ({
  firstName: 'Ada',
  lastName: `Lovelace ${args.tempGuid}`,
  organization: 'Analytical Engines',
  phones: [{ label: 'work', number: '+15551234000' }],
  emails: [{ label: 'work', address: `${args.tempGuid}@example.test` }],
});

function insertOutgoingFixture(
  db: AppDatabase,
  kind: OutgoingInsertKind,
  args: OutgoingInsertFixture,
): Promise<void> {
  if (kind === 'text') {
    return insertOutgoingText(db, {
      ...args,
      selectedMessageGuid: selectedGuidFor(args),
      threadOriginatorGuid: threadGuidFor(args),
      effectId: effectFor(args),
      subject: subjectFor(args),
    });
  }
  return insertOutgoingContact(db, {
    ...args,
    contact: contactFor(args),
    selectedMessageGuid: selectedGuidFor(args),
    threadOriginatorGuid: threadGuidFor(args),
  });
}

function latestMessageDate(raw: Database.Database, chatId: number): number | null {
  return (
    raw.prepare('SELECT latest_message_date AS value FROM chats WHERE id = ?').get(chatId) as {
      value: number | null;
    }
  ).value;
}

function expectNoOutgoingFixtureRows(raw: Database.Database, args: OutgoingInsertFixture): void {
  expect(
    raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
  ).toBeUndefined();
  expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get(args.tempGuid)).toBeUndefined();
}

function expectExactOutgoingFixtureRows(
  raw: Database.Database,
  kind: OutgoingInsertKind,
  args: OutgoingInsertFixture,
  expectedLatestMessageDate: number,
): void {
  const queue = raw
    .prepare(
      `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload,
              attempts, next_retry_at AS nextRetryAt
         FROM outgoing_queue WHERE temp_guid = ?`,
    )
    .get(args.tempGuid) as
    | {
        tempGuid: string;
        chatGuid: string;
        kind: string;
        payload: string;
        attempts: number;
        nextRetryAt: number;
      }
    | undefined;
  expect(queue).toMatchObject({
    tempGuid: args.tempGuid,
    chatGuid: args.chatGuid,
    kind,
    attempts: 0,
    nextRetryAt: 0,
  });
  expect(queue?.payload == null ? undefined : JSON.parse(queue.payload)).toEqual(
    kind === 'text'
      ? {
          message: args.text,
          selectedMessageGuid: selectedGuidFor(args),
          effectId: effectFor(args),
          subject: subjectFor(args),
        }
      : {
          ...contactFor(args),
          selectedMessageGuid: selectedGuidFor(args),
        },
  );
  expect(
    raw
      .prepare(
        `SELECT guid, chat_id AS chatId, text, subject, is_from_me AS isFromMe,
                date_created AS dateCreated, send_state AS sendState, error,
                thread_originator_guid AS threadOriginatorGuid,
                expressive_send_style_id AS expressiveSendStyleId
           FROM messages WHERE guid = ?`,
      )
      .get(args.tempGuid),
  ).toEqual({
    guid: args.tempGuid,
    chatId: args.chatId,
    text: args.text,
    subject: kind === 'text' ? subjectFor(args) : null,
    isFromMe: 1,
    dateCreated: args.now,
    sendState: 'sending',
    error: 0,
    threadOriginatorGuid: threadGuidFor(args),
    expressiveSendStyleId: kind === 'text' ? effectFor(args) : null,
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

async function expectDeletionSurvivesPurgeAndReingest(
  db: AppDatabase,
  raw: Database.Database,
  chatId: number,
  guid: string,
  text: string | null,
  expectedDateDeleted: number,
): Promise<void> {
  await deleteChatLocal(db, 'c1', 9_500);
  expect(tombstone(raw, guid)).toBeUndefined();
  expect(deletionLedgerDate(raw, guid)).toBe(expectedDateDeleted);

  await withDbTransaction(db, (context) =>
    upsertMessagesWithinTransaction(
      context,
      [Message.parse({ guid, isFromMe: true, text, dateCreated: 10_000 })],
      () => chatId,
      new Map(),
    ),
  );
  expect(tombstone(raw, guid)).toBe(expectedDateDeleted);
}

describe('outgoing text/contact inserts — monotonic chat date and transaction ownership', () => {
  const kinds = ['text', 'contact'] as const;

  it.each(kinds)(
    '%s initializes and advances the chat date, then waits behind and preserves a newer commit',
    async (kind) => {
      const { db, raw } = await createTestDb();
      const chatGuid = `c-${kind}-date-owner`;
      const chatId = await seedChat(db, chatGuid);
      const fromNull = {
        tempGuid: `temp-${kind}-from-null`,
        chatId,
        chatGuid,
        text: `${kind} initializes a NULL chat date`,
        now: 100,
      } satisfies OutgoingInsertFixture;
      expect(latestMessageDate(raw, chatId)).toBeNull();
      await insertOutgoingFixture(db, kind, fromNull);
      expectExactOutgoingFixtureRows(raw, kind, fromNull, fromNull.now);

      const fromLower = {
        tempGuid: `temp-${kind}-from-lower`,
        chatId,
        chatGuid,
        text: `${kind} advances a lower chat date`,
        now: 200,
      } satisfies OutgoingInsertFixture;
      await insertOutgoingFixture(db, kind, fromLower);
      expectExactOutgoingFixtureRows(raw, kind, fromLower, fromLower.now);

      const newerDate = 9_000;
      let markNeighbourStarted!: () => void;
      let releaseNeighbour!: () => void;
      const neighbourStarted = new Promise<void>((resolve) => {
        markNeighbourStarted = resolve;
      });
      const neighbourHeld = new Promise<void>((resolve) => {
        releaseNeighbour = resolve;
      });
      const neighbourOutcome = withDbTransaction(db, async () => {
        raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = ?').run(newerDate, chatId);
        markNeighbourStarted();
        await neighbourHeld;
      }).then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      await neighbourStarted;

      const olderQueued = {
        tempGuid: `temp-${kind}-older-than-neighbour`,
        chatId,
        chatGuid,
        text: `${kind} must not regress a newer chat date`,
        now: 300,
      } satisfies OutgoingInsertFixture;
      let helperSettled = false;
      const helperOutcome = insertOutgoingFixture(db, kind, olderQueued)
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
        expectNoOutgoingFixtureRows(raw, olderQueued);
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
      expectExactOutgoingFixtureRows(raw, kind, olderQueued, newerDate);
    },
  );

  it.each(kinds)(
    '%s rolls queue/message inserts back when the final chat update fails, then retries exactly',
    async (kind) => {
      const { db, raw } = await createTestDb();
      const chatGuid = `c-${kind}-atomic-insert`;
      const chatId = await seedChat(db, chatGuid);
      const args = {
        tempGuid: `temp-${kind}-final-update-failure`,
        chatId,
        chatGuid,
        text: `${kind} atomic final update`,
        now: 10_000,
      } satisfies OutgoingInsertFixture;
      const triggerName = `reject_${kind}_outgoing_chat_update`;
      const canary = `${kind.toUpperCase()}_OUTGOING_CHAT_UPDATE_RAW_CANARY`;
      raw.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF latest_message_date ON chats
        WHEN OLD.id = ${chatId} AND NEW.latest_message_date = ${args.now}
        BEGIN
          SELECT RAISE(ABORT, '${canary}');
        END
      `);

      try {
        const failure = await insertOutgoingFixture(db, kind, args).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        expect(failure.kind).toBe('rejected');
        if (failure.kind === 'rejected') {
          expect(errorMessageChain(failure.error)).toContain(canary);
        }
        expectNoOutgoingFixtureRows(raw, args);
        expect(latestMessageDate(raw, chatId)).toBeNull();
      } finally {
        raw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      }

      await expect(insertOutgoingFixture(db, kind, args)).resolves.toBeUndefined();
      expectExactOutgoingFixtureRows(raw, kind, args, args.now);
    },
  );

  it('awaits each contact queue, message, and chat driver write in semantic order', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'c-contact-delayed-writes';
    const chatId = await seedChat(db, chatGuid);
    const oldDate = 100;
    raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = ?').run(oldDate, chatId);
    const args = {
      tempGuid: 'temp-contact-delayed-writes',
      chatId,
      chatGuid,
      text: 'Grace Hopper delayed contact card',
      now: 500,
    } satisfies OutgoingInsertFixture;
    const stages = {
      queue: driverGate(),
      message: driverGate(),
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
        table === outgoingQueue ? stages.queue : table === messages ? stages.message : undefined;
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
      helperOutcome = insertOutgoingFixture(db, 'contact', args)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });

      await waitForDriverGate(stages.queue, 'outgoing contact queue insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expectNoOutgoingFixtureRows(raw, args);
      expect(stages.message.didStart).toBe(false);
      expect(stages.chat.didStart).toBe(false);
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);
      stages.queue.release();
      await stages.queue.finished;

      await waitForDriverGate(stages.message, 'outgoing contact message insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(queueCount(raw, args.tempGuid)).toBe(1);
      expect(
        raw.prepare('SELECT id FROM messages WHERE guid = ?').get(args.tempGuid),
      ).toBeUndefined();
      expect(stages.chat.didStart).toBe(false);
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);
      stages.message.release();
      await stages.message.finished;

      await waitForDriverGate(stages.chat, 'outgoing contact chat update');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(queueCount(raw, args.tempGuid)).toBe(1);
      expect(raw.prepare('SELECT guid FROM messages WHERE guid = ?').get(args.tempGuid)).toEqual({
        guid: args.tempGuid,
      });
      expect(latestMessageDate(raw, chatId)).toBe(oldDate);

      stages.chat.release();
      const [outcome] = await Promise.all([helperOutcome, stages.chat.finished]);
      expect(outcome).toEqual({ kind: 'resolved', value: undefined });
      expect(helperSettled).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expectExactOutgoingFixtureRows(raw, 'contact', args, args.now);
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

describe('insertOutgoingReaction — private payload and transaction ownership', () => {
  const privateSelectedText = `PRIVATE_SELECTED_REACTION_TEXT_${'x'.repeat(4_096)}`;

  interface ReactionInsertFixture {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    targetGuid: string;
    reaction: string;
    emoji: string;
    now: number;
  }

  function insertReactionFixture(db: AppDatabase, args: ReactionInsertFixture): Promise<void> {
    return insertOutgoingReaction(db, {
      ...args,
      selectedMessageText: privateSelectedText,
    });
  }

  function expectNoReactionFixtureRows(raw: Database.Database, args: ReactionInsertFixture): void {
    expect(
      raw.prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?').get(args.tempGuid),
    ).toBeUndefined();
    expect(
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get(args.tempGuid),
    ).toBeUndefined();
  }

  function expectExactReactionFixtureRows(
    raw: Database.Database,
    args: ReactionInsertFixture,
  ): void {
    const queue = raw
      .prepare(
        `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload,
                attempts, next_retry_at AS nextRetryAt
           FROM outgoing_queue WHERE temp_guid = ?`,
      )
      .get(args.tempGuid) as {
      tempGuid: string;
      chatGuid: string;
      kind: string;
      payload: string;
      attempts: number;
      nextRetryAt: number;
    };
    expect(queue).toMatchObject({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'reaction',
      attempts: 0,
      nextRetryAt: 0,
    });
    expect(JSON.parse(queue.payload)).toEqual({
      selectedMessageGuid: args.targetGuid,
      reaction: args.reaction,
      emoji: args.emoji,
    });
    expect(queue.payload).not.toContain(privateSelectedText);
    expect(queue.payload).not.toContain('selectedMessageText');

    expect(
      raw
        .prepare(
          `SELECT guid, chat_id AS chatId, text, is_from_me AS isFromMe,
                  date_created AS dateCreated, send_state AS sendState, error,
                  associated_message_guid AS associatedMessageGuid,
                  associated_message_type AS associatedMessageType,
                  associated_message_emoji AS associatedMessageEmoji
             FROM messages WHERE guid = ?`,
        )
        .get(args.tempGuid),
    ).toEqual({
      guid: args.tempGuid,
      chatId: args.chatId,
      text: null,
      isFromMe: 1,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      associatedMessageGuid: args.targetGuid,
      associatedMessageType: args.reaction,
      associatedMessageEmoji: args.emoji,
    });
  }

  it('waits behind a rolling-back predecessor, then commits only the retry fields', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'c-reaction-owner';
    const chatId = await seedChat(db, chatGuid);
    const args = {
      tempGuid: 'temp-reaction-owner',
      chatId,
      chatGuid,
      targetGuid: 'target-reaction-owner',
      reaction: 'emoji',
      emoji: '🫡',
      now: 1_000,
    } satisfies ReactionInsertFixture;
    const phantomKey = 'reaction.owner.predecessor';
    const predecessor = await holdRollingBackNeighbour(db, raw, phantomKey);
    let helperSettled = false;
    const helperOutcome = insertReactionFixture(db, args)
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
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
      expectNoReactionFixtureRows(raw, args);
    } catch (error) {
      observationError = error;
    } finally {
      predecessor.release();
    }
    const [predecessorError, helper] = await Promise.all([predecessor.failure, helperOutcome]);
    if (observationError) throw observationError;

    expect(String(predecessorError)).toContain('no-guid neighbour rollback');
    expect(helper).toEqual({ kind: 'resolved', value: undefined });
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expectExactReactionFixtureRows(raw, args);
  });

  it('awaits queue then message insert, rolls both back on the exact second insert, and retries', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'c-reaction-second-insert';
    const chatId = await seedChat(db, chatGuid);
    const args = {
      tempGuid: 'temp-reaction-second-insert',
      chatId,
      chatGuid,
      targetGuid: 'target-reaction-second-insert',
      reaction: 'emoji',
      emoji: '🔥',
      now: 2_000,
    } satisfies ReactionInsertFixture;
    const canary = 'REACTION_EXACT_MESSAGE_INSERT_CANARY';
    const triggerName = 'reject_exact_reaction_message_insert';
    raw.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON messages
      WHEN NEW.guid = '${args.tempGuid}'
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const stages = { queue: driverGate(), message: driverGate() };
    type Insert = (table: unknown) => { values(values: unknown): object };
    const realInsert = db.insert.bind(db) as unknown as Insert;
    const insertSpy = jest.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      const builder = realInsert(table);
      const gate =
        table === outgoingQueue ? stages.queue : table === messages ? stages.message : undefined;
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

    let helperSettled = false;
    let helperOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      helperOutcome = insertReactionFixture(db, args)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });

      await waitForDriverGate(stages.queue, 'outgoing reaction queue insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expectNoReactionFixtureRows(raw, args);
      expect(stages.message.didStart).toBe(false);
      stages.queue.release();
      await stages.queue.finished;

      await waitForDriverGate(stages.message, 'outgoing reaction message insert');
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(queueCount(raw, args.tempGuid)).toBe(1);
      expect(
        raw.prepare('SELECT id FROM messages WHERE guid = ?').get(args.tempGuid),
      ).toBeUndefined();

      stages.message.release();
      const [failure] = await Promise.all([helperOutcome, stages.message.finished]);
      expect(failure.kind).toBe('rejected');
      if (failure.kind === 'rejected') {
        expect(errorMessageChain(failure.error)).toContain(canary);
      }
      expect(helperSettled).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expectNoReactionFixtureRows(raw, args);
    } finally {
      for (const gate of Object.values(stages)) gate.release();
      const drains: Promise<unknown>[] = [];
      if (helperOutcome) drains.push(helperOutcome);
      for (const gate of Object.values(stages)) {
        if (gate.didStart) drains.push(gate.finished);
      }
      await Promise.allSettled(drains);
      insertSpy.mockRestore();
      raw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    await expect(insertReactionFixture(db, args)).resolves.toBeUndefined();
    expectExactReactionFixtureRows(raw, args);
  });
});

describe('reconcileOutgoingSuccess — backstops & branches', () => {
  it('no-ops on an empty guid (never promote a row to NULL identity)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-1',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileOutgoingSuccess(db, 'temp-1', { guid: '', dateCreated: 1, dateDelivered: null });
    // Row untouched: still the temp guid, still sending, queue row intact.
    expect(msgState(raw, 'temp-1')?.s).toBe('sending');
    expect(queueCount(raw, 'temp-1')).toBe(1);
  });

  it('treats guid===tempGuid (RCS self-ack) like the no-guid path: sent + dequeue, not promote', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs',
      chatId,
      chatGuid: 'c1',
      text: 'yo',
      now: 1,
    });
    await reconcileOutgoingSuccess(db, 'temp-rcs', {
      guid: 'temp-rcs',
      dateCreated: 1,
      dateDelivered: null,
    });
    // Still identified by the tempGuid (NOT deleted as its own "duplicate"), flipped to sent, dequeued.
    expect(msgState(raw, 'temp-rcs')?.s).toBe('sent');
    expect(queueCount(raw, 'temp-rcs')).toBe(0);
  });

  it('moves a cancelled-send ledger marker through HTTP-ack promotion and later purge', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-http-deleted',
      chatId,
      chatGuid: 'c1',
      text: 'cancelled before ack',
      now: 100,
    });
    await cancelOutgoing(db, 'temp-http-deleted', 9_000);

    await reconcileOutgoingSuccess(db, 'temp-http-deleted', {
      guid: 'real-http-deleted',
      dateCreated: 100,
      dateDelivered: null,
    });

    expect(deletionLedgerDate(raw, 'temp-http-deleted')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'real-http-deleted')).toBe(9_000);
    await expectDeletionSurvivesPurgeAndReingest(
      db,
      raw,
      chatId,
      'real-http-deleted',
      'cancelled before ack',
      9_000,
    );
  });

  it('keeps the later real-guid deletion timestamp when it precedes HTTP-ack promotion', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-http-max',
      chatId,
      chatGuid: 'c1',
      text: 'two deletion clocks',
      now: 100,
    });
    await cancelOutgoing(db, 'temp-http-max', 9_000);
    await markMessageDeleted(db, 'real-http-max', 9_500);

    await reconcileOutgoingSuccess(db, 'temp-http-max', {
      guid: 'real-http-max',
      dateCreated: 100,
      dateDelivered: null,
    });

    expect(deletionLedgerDate(raw, 'temp-http-max')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'real-http-max')).toBe(9_500);
    expect(tombstone(raw, 'real-http-max')).toBe(9_500);
  });

  it('dup-branch WITHOUT a temp local_path just drops the temp row (no UPDATE)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    // Optimistic TEXT (no attachment → no local_path to carry over).
    await insertOutgoingText(db, {
      tempGuid: 'temp-d',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // Echo already inserted the real message directly (dup-branch precondition).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-d',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingSuccess(db, 'temp-d', {
      guid: 'real-d',
      dateCreated: 1,
      dateDelivered: null,
    });
    const guids = ((await listMessages(db, chatId)) as Array<{ guid: string }>).map((m) => m.guid);
    expect(guids).toEqual(['real-d']); // temp dropped, no duplicate
  });

  it('waits behind a rolling-back neighbour before handing over and promoting a normal ack', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-reconcile-queued-current';
    const phantomKey = 'outgoing.reconcile.current-neighbour';
    const chatId = await seedChat(db, 'c1');
    const server = {
      guid: 'real-reconcile-queued-current',
      dateCreated: 200,
      dateDelivered: 300,
    };
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'promote after neighbour rollback',
      now: 100,
    });
    const neighbour = await holdRollingBackNeighbour(db, raw, phantomKey);
    let helperSettled = false;
    const helperOutcome = reconcileOutgoingSuccess(db, tempGuid, server)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, helperOutcome, () => {
      expect(helperSettled).toBe(false);
      expect(outgoingIdentityRow(raw, tempGuid)).toEqual({
        guid: tempGuid,
        dateCreated: 100,
        dateDelivered: null,
        isFromMe: 1,
        sendState: 'sending',
        error: 0,
        dateDeleted: null,
      });
      expect(outgoingIdentityRow(raw, server.guid)).toBeUndefined();
      expect(messageAliasTarget(raw, tempGuid)).toBeUndefined();
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
    });

    expect(outcome).toEqual({ kind: 'resolved', value: undefined });
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expectExactOutgoingPromotion(raw, tempGuid, server);
  });

  it('rejects a queued revoked promotion unchanged and releases the slot for a fresh retry', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-reconcile-queued-revoked';
    const phantomKey = 'outgoing.reconcile.revoked-neighbour';
    const chatId = await seedChat(db, 'c1');
    const server = {
      guid: 'real-reconcile-queued-revoked',
      dateCreated: 210,
      dateDelivered: 310,
    };
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'retire promotion while queued',
      now: 110,
    });
    const neighbour = await holdRollingBackNeighbour(db, raw, phantomKey);
    let current = true;
    let helperSettled = false;
    const helperOutcome = reconcileOutgoingSuccess(db, tempGuid, server, () => current)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, helperOutcome, () => {
      expect(helperSettled).toBe(false);
      expect(outgoingIdentityRow(raw, tempGuid)).toEqual({
        guid: tempGuid,
        dateCreated: 110,
        dateDelivered: null,
        isFromMe: 1,
        sendState: 'sending',
        error: 0,
        dateDeleted: null,
      });
      expect(outgoingIdentityRow(raw, server.guid)).toBeUndefined();
      expect(messageAliasTarget(raw, tempGuid)).toBeUndefined();
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
      // The helper synchronously owns the next write slot; revoke only after that admission.
      current = false;
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
    }
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expect(outgoingIdentityRow(raw, tempGuid)).toEqual({
      guid: tempGuid,
      dateCreated: 110,
      dateDelivered: null,
      isFromMe: 1,
      sendState: 'sending',
      error: 0,
      dateDeleted: null,
    });
    expect(outgoingIdentityRow(raw, server.guid)).toBeUndefined();
    expect(messageAliasTarget(raw, tempGuid)).toBeUndefined();
    expect(queueCount(raw, tempGuid)).toBe(1);

    await expect(
      reconcileOutgoingSuccess(db, tempGuid, server, () => true),
    ).resolves.toBeUndefined();
    expectExactOutgoingPromotion(raw, tempGuid, server);
  });

  it('awaits the exact final queue delete and rolls the whole promotion back if it fails', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-reconcile-delayed-delete-failure';
    const chatId = await seedChat(db, 'c1');
    const server = {
      guid: 'real-reconcile-delayed-delete-failure',
      dateCreated: 220,
      dateDelivered: 320,
    };
    const deletedAt = 9_000;
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'rollback a delayed final delete',
      now: 120,
    });
    await markMessageDeleted(db, tempGuid, deletedAt);

    const triggerName = 'reject_reconcile_final_queue_delete';
    const canary = 'RECONCILE_FINAL_QUEUE_DELETE_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE DELETE ON outgoing_queue
      WHEN OLD.temp_guid = '${tempGuid}'
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    type Delete = (table: unknown) => { where(condition: unknown): object };
    const realDelete = db.delete.bind(db) as unknown as Delete;
    const queueDelete = driverGate();
    const deleteSpy = jest.spyOn(db, 'delete').mockImplementation(((table: unknown) => {
      const builder = realDelete(table);
      if (table !== outgoingQueue) return builder;
      return new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'where') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (condition: unknown) => gateThenable(target.where(condition), queueDelete);
        },
      });
    }) as unknown as AppDatabase['delete']);

    let helperSettled = false;
    let helperOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      try {
        helperOutcome = reconcileOutgoingSuccess(db, tempGuid, server)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            helperSettled = true;
          });

        await waitForDriverGate(queueDelete, 'reconcile final outgoing queue delete');
        await nextEventLoopTurn();
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(outgoingIdentityRow(raw, tempGuid)).toBeUndefined();
        expect(messageAliasTarget(raw, tempGuid)).toBe(server.guid);
        expect(outgoingIdentityRow(raw, server.guid)).toEqual({
          guid: server.guid,
          dateCreated: server.dateCreated,
          dateDelivered: server.dateDelivered,
          isFromMe: 1,
          sendState: 'sent',
          error: 0,
          dateDeleted: deletedAt,
        });
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(deletionLedgerDate(raw, server.guid)).toBe(deletedAt);
        expect(queueCount(raw, tempGuid)).toBe(1);

        queueDelete.release();
        const [outcome] = await Promise.all([helperOutcome, queueDelete.finished]);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
          expect(errorMessageChain(outcome.error)).toContain(canary);
        }
        expect(helperSettled).toBe(true);
        expect(raw.inTransaction).toBe(false);
        expect(outgoingIdentityRow(raw, tempGuid)).toEqual({
          guid: tempGuid,
          dateCreated: 120,
          dateDelivered: null,
          isFromMe: 1,
          sendState: 'sending',
          error: 0,
          dateDeleted: deletedAt,
        });
        expect(outgoingIdentityRow(raw, server.guid)).toBeUndefined();
        expect(messageAliasTarget(raw, tempGuid)).toBeUndefined();
        expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
        expect(deletionLedgerDate(raw, server.guid)).toBeUndefined();
        expect(queueCount(raw, tempGuid)).toBe(1);
      } finally {
        queueDelete.release();
        try {
          const drains: Promise<unknown>[] = [];
          if (helperOutcome) drains.push(helperOutcome);
          if (queueDelete.didStart) drains.push(queueDelete.finished);
          await Promise.allSettled(drains);
        } finally {
          deleteSpy.mockRestore();
        }
      }
    } finally {
      raw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    await expect(reconcileOutgoingSuccess(db, tempGuid, server)).resolves.toBeUndefined();
    expectExactOutgoingPromotion(raw, tempGuid, server, deletedAt);
    expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
    expect(deletionLedgerDate(raw, server.guid)).toBe(deletedAt);
  });
});

describe('cancelOutgoing — branches', () => {
  it('returns false when there is no queue row (already reconciled / never queued)', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    expect(await cancelOutgoing(db, 'nope')).toBe(false);
  });

  // Cleared, because an orphan queue row re-sends blind on the next drain — but reported as
  // not-owned: clearing an orphan is not the same as removing the user's message, and the Delete
  // path skips its tombstone when this answers true.
  it('clears a STRANDED queue row that has no matching temp message, reporting not-owned', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-s',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // Delete only the message, leaving the queue row stranded.
    raw.prepare('DELETE FROM messages WHERE guid = ?').run('temp-s');
    expect(await cancelOutgoing(db, 'temp-s')).toBe(false);
    expect(queueCount(raw, 'temp-s')).toBe(0);
  });

  it("an 'error' cancel TOMBSTONES rather than deleting — the server may still have it", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-err',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("UPDATE messages SET send_state = 'error' WHERE guid = ?").run('temp-err');
    expect(await cancelOutgoing(db, 'temp-err', 9_000)).toBe(true);
    // 'error' is NOT proof the server never got it: a send can fail client-side (a 30s HTTP
    // timeout) after the origin processed it. The row has to survive so the later echo can
    // carry the deletion onto the real guid.
    expect(tombstone(raw, 'temp-err')).toBe(9_000);
    // …and invisible either way (listMessagesWithSenders is the render query; it filters tombstones)
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(queueCount(raw, 'temp-err')).toBe(0);
  });

  it("a 'sending' cancel survives a late success-ack whose echo already landed (dup branch)", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-snd',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-snd', 9_000)).toBe(true);
    // The socket echo beat the ack and inserted the real message.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-snd',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    // The in-flight POST resolves late. The dup branch destroys the temp row, so it must carry the
    // tombstone across first — a HARD delete of the real guid here was undone by the next re-page.
    await reconcileOutgoingSuccess(db, 'temp-snd', {
      guid: 'real-snd',
      dateCreated: 1,
      dateDelivered: null,
    });
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0); // cancelled stays cancelled
    expect(tombstone(raw, 'real-snd')).toBe(9_000);
    // A re-page cannot bring it back: upsertMessages only sources date_deleted from the local
    // ledger and merges it monotonically, never from the ordinary wire payload.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-snd',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('moves the durable temp marker when purge and a real echo both precede the late ack', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-purged-before-ack',
      chatId,
      chatGuid: 'c1',
      text: 'late ack after purge',
      now: 100,
    });
    await cancelOutgoing(db, 'temp-purged-before-ack', 9_003);
    await deleteChatLocal(db, 'c1', 9_500);
    expect(tombstone(raw, 'temp-purged-before-ack')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'temp-purged-before-ack')).toBe(9_003);

    // The real echo/backfill materializes before the HTTP request finally resolves. With no real
    // ledger key yet, this row is initially live; the late ack's duplicate branch must repair it.
    await withDbTransaction(db, (context) =>
      upsertMessagesWithinTransaction(
        context,
        [
          Message.parse({
            guid: 'real-purged-before-ack',
            isFromMe: true,
            text: 'late ack after purge',
            dateCreated: 10_000,
          }),
        ],
        () => chatId,
        new Map(),
      ),
    );
    expect(tombstone(raw, 'real-purged-before-ack')).toBeNull();

    await reconcileOutgoingSuccess(db, 'temp-purged-before-ack', {
      guid: 'real-purged-before-ack',
      dateCreated: 10_000,
      dateDelivered: null,
    });

    expect(deletionLedgerDate(raw, 'temp-purged-before-ack')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'real-purged-before-ack')).toBe(9_003);
    expect(tombstone(raw, 'real-purged-before-ack')).toBe(9_003);
  });

  it('a late NO-GUID (AppleScript/RCS) ack after a cancel keeps the row hidden, not resurrected', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-ng',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-ng', 9_000)).toBe(true);
    // The guid-less ack resolves late. It flips the state, never the tombstone — the row has to
    // stay so the fanout's rcs-<id> is promoted ONTO it (carrying date_deleted) instead of
    // inserting a fresh, visible bubble.
    await markOutgoingSentNoGuid(db, 'temp-ng');
    expect(msgState(raw, 'temp-ng')?.s).toBe('sent');
    expect(tombstone(raw, 'temp-ng')).toBe(9_000);
    expect(queueCount(raw, 'temp-ng')).toBe(0);
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'rcs-42', isFromMe: true, text: 'hi', dateCreated: 1 },
        chatId,
      ),
    );
    expect(tombstone(raw, 'rcs-42')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });
});

describe('discardOutgoingMessage — transaction ownership', () => {
  it('waits behind a rolling-back neighbour, then commits its tombstone independently', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'c-discard-current-neighbour';
    const chatId = await seedChat(db, chatGuid);
    const survivorGuid = 'discard-current-survivor';
    const survivorDate = 100;
    const tempGuid = 'temp-discard-current-neighbour';
    const outgoingDate = 200;
    const deletedAt = 9_000;
    const phantomKey = 'outgoing.discard.current-neighbour';
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: survivorGuid,
          text: 'surviving older message',
          isFromMe: false,
          dateCreated: survivorDate,
        }),
      ],
      () => chatId,
      new Map(),
    );
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid,
      text: 'discard only after neighbour rollback',
      now: outgoingDate,
    });
    expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);

    const neighbour = await holdRollingBackNeighbour(db, raw, phantomKey);
    let helperSettled = false;
    const helperOutcome = discardOutgoingMessage(db, tempGuid, deletedAt)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, helperOutcome, () => {
      expect(helperSettled).toBe(false);
      expect(outgoingIdentityRow(raw, tempGuid)).toEqual({
        guid: tempGuid,
        dateCreated: outgoingDate,
        dateDelivered: null,
        isFromMe: 1,
        sendState: 'sending',
        error: 0,
        dateDeleted: null,
      });
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
      expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
    });

    expect(outcome).toEqual({ kind: 'resolved', value: true });
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expect(tombstone(raw, tempGuid)).toBe(deletedAt);
    expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
    expect(queueCount(raw, tempGuid)).toBe(0);
    expect(tombstone(raw, survivorGuid)).toBeNull();
    expect(latestMessageDate(raw, chatId)).toBe(survivorDate);
  });

  it('awaits queue deletion and final chat recompute, rolling every write back on failure', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'c-discard-delayed-final-failure';
    const chatId = await seedChat(db, chatGuid);
    const survivorGuid = 'discard-delayed-survivor';
    const survivorDate = 110;
    const tempGuid = 'temp-discard-delayed-final-failure';
    const outgoingDate = 220;
    const deletedAt = 9_100;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: survivorGuid,
          text: 'survives failed discard',
          isFromMe: false,
          dateCreated: survivorDate,
        }),
      ],
      () => chatId,
      new Map(),
    );
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid,
      text: 'rollback every discard write',
      now: outgoingDate,
    });
    expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);

    const triggerName = 'reject_discard_final_chat_update';
    const canary = 'DISCARD_FINAL_CHAT_UPDATE_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF latest_message_date ON chats
      WHEN NEW.id = ${chatId} AND NEW.latest_message_date = ${survivorDate}
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const queueDelete = driverGate();
    const chatUpdate = driverGate();
    type Delete = (table: unknown) => { where(condition: unknown): object };
    type Run = (query: unknown) => unknown;
    const realDelete = db.delete.bind(db) as unknown as Delete;
    const realRun = db.run.bind(db) as Run;
    const deleteSpy = jest.spyOn(db, 'delete').mockImplementation(((table: unknown) => {
      const builder = realDelete(table);
      if (table !== outgoingQueue) return builder;
      return new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'where') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (condition: unknown) => gateThenable(target.where(condition), queueDelete);
        },
      });
    }) as unknown as AppDatabase['delete']);
    let delayedChatRun: Promise<unknown> | undefined;
    const runSpy = jest.spyOn(db, 'run').mockImplementation(((query: unknown) => {
      const sqlShape = JSON.stringify(query);
      if (
        !chatUpdate.didStart &&
        sqlShape.includes('UPDATE chats') &&
        sqlShape.includes('latest_message_date') &&
        sqlShape.includes('associated_message_type IS NULL')
      ) {
        chatUpdate.didStart = true;
        delayedChatRun = chatUpdate.held
          .then(() => realRun(query))
          .finally(chatUpdate.markFinished);
        // Observe a detached-await mutation without changing the rejecting promise returned to
        // the real caller. Cleanup also drains this exact promise before restoring the driver.
        void delayedChatRun.catch(() => undefined);
        return delayedChatRun;
      }
      return realRun(query);
    }) as unknown as AppDatabase['run']);

    let helperSettled = false;
    let helperOutcome:
      | Promise<{ kind: 'resolved'; value: boolean } | { kind: 'rejected'; error: unknown }>
      | undefined;
    try {
      try {
        helperOutcome = discardOutgoingMessage(db, tempGuid, deletedAt)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            helperSettled = true;
          });

        await waitForDriverGate(queueDelete, 'discard outgoing queue delete');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(tombstone(raw, tempGuid)).toBe(deletedAt);
        expect(queueCount(raw, tempGuid)).toBe(1);
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);
        expect(chatUpdate.didStart).toBe(false);

        queueDelete.release();
        await queueDelete.finished;
        await waitForDriverGate(chatUpdate, 'discard final chat latest-date update');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(queueCount(raw, tempGuid)).toBe(0);
        expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
        expect(tombstone(raw, tempGuid)).toBe(deletedAt);
        expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);

        chatUpdate.release();
        const [outcome] = await Promise.all([helperOutcome, chatUpdate.finished]);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
          expect(errorMessageChain(outcome.error)).toContain(canary);
        }
        expect(helperSettled).toBe(true);
        expect(raw.inTransaction).toBe(false);
        expect(tombstone(raw, tempGuid)).toBeNull();
        expect(queueCount(raw, tempGuid)).toBe(1);
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(tombstone(raw, survivorGuid)).toBeNull();
        expect(latestMessageDate(raw, chatId)).toBe(outgoingDate);
      } finally {
        queueDelete.release();
        chatUpdate.release();
        try {
          const drains: Promise<unknown>[] = [];
          if (helperOutcome) drains.push(helperOutcome);
          if (queueDelete.didStart) drains.push(queueDelete.finished);
          await Promise.allSettled(drains);
          if (delayedChatRun) await Promise.allSettled([delayedChatRun]);
        } finally {
          runSpy.mockRestore();
          deleteSpy.mockRestore();
        }
      }
    } finally {
      raw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    await expect(discardOutgoingMessage(db, tempGuid, deletedAt)).resolves.toBe(true);
    expect(tombstone(raw, tempGuid)).toBe(deletedAt);
    expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
    expect(queueCount(raw, tempGuid)).toBe(0);
    expect(tombstone(raw, survivorGuid)).toBeNull();
    expect(latestMessageDate(raw, chatId)).toBe(survivorDate);
  });
});

describe('reconcileOutgoingError — attempts + backoff', () => {
  it('marks errored, bumps attempts to 1, and schedules a backoff on the queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-e',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileOutgoingError(db, 'temp-e', 42, 1_000);
    expect(msgState(raw, 'temp-e')).toEqual({ s: 'error', e: 42 });
    const q = raw
      .prepare('SELECT attempts a, next_retry_at n FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-e') as { a: number; n: number };
    expect(q.a).toBe(1);
    expect(q.n).toBe(1_000 + 30_000); // first backoff = 30s
  });

  it('persists one detail, preserves it across duplicate fanout, and clears it on manual retry', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c-detail');
    await insertOutgoingText(db, {
      tempGuid: 'temp-detail',
      chatId,
      chatGuid: 'c-detail',
      text: 'hi',
      now: 1,
    });

    await reconcileOutgoingError(db, 'temp-detail', 42, 1_000, undefined, 'Useful detail');
    await reconcileOutgoingError(db, 'temp-detail', 42, 1_001);
    expect(
      raw
        .prepare('SELECT error_message AS detail, send_state AS state FROM messages WHERE guid = ?')
        .get('temp-detail'),
    ).toEqual({ detail: 'Useful detail', state: 'error' });
    expect(
      raw.prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?').get('temp-detail'),
    ).toEqual({ attempts: 1 });

    await expect(
      claimFailedOutgoingForRetry(db, 'temp-detail', () => 2_000),
    ).resolves.toMatchObject({ claim: 'claimed' });
    expect(
      raw.prepare('SELECT error_message AS detail FROM messages WHERE guid = ?').get('temp-detail'),
    ).toEqual({ detail: null });
  });

  it('clears stale detail when the automatic retry worker claims the next attempt', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c-auto-detail');
    await insertOutgoingText(db, {
      tempGuid: 'temp-auto-detail',
      chatId,
      chatGuid: 'c-auto-detail',
      text: 'hi',
      now: 1,
    });
    await reconcileOutgoingError(db, 'temp-auto-detail', 42, 1_000, undefined, 'Stale detail');
    const row = raw
      .prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-auto-detail') as { id: number };

    await expect(claimOutgoingForSend(db, row.id, () => 40_000)).resolves.toBe(true);
    expect(
      raw
        .prepare(
          'SELECT error_message AS detail, send_state AS state, error FROM messages WHERE guid = ?',
        )
        .get('temp-auto-detail'),
    ).toEqual({ detail: null, state: 'sending', error: 0 });
  });

  it('reports FALSE when no queue row owns the guid (so a caller can fall through)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-noq',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-noq'").run();

    expect(await reconcileOutgoingError(db, 'temp-noq', 42, 1_000)).toBe(false);
    // The bubble is still flipped — only the ladder had nothing to advance.
    expect(msgState(raw, 'temp-noq')).toEqual({ s: 'error', e: 42 });
  });

  it('waits behind a rolling-back neighbour instead of silently joining its transaction', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-queued-error',
      chatId,
      chatGuid: 'c1',
      text: 'queue me',
      now: 1,
    });

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const reconcile = reconcileOutgoingError(db, 'temp-queued-error', 42, 1_000);
    await Promise.resolve();
    expect(msgState(raw, 'temp-queued-error')).toEqual({ s: 'sending', e: 0 });

    releaseNeighbour();
    const neighbourError = await neighbour.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(neighbourError)).toContain('neighbour rollback');
    await expect(reconcile).resolves.toBe(true);
    expect(msgState(raw, 'temp-queued-error')).toEqual({ s: 'error', e: 42 });
    const queue = raw
      .prepare('SELECT attempts a FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-queued-error') as { a: number };
    expect(queue.a).toBe(1);
  });
});

describe('retireOutgoing — transaction ownership', () => {
  it('waits behind a rolling-back neighbour instead of silently joining it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-queued-retire',
      chatId,
      chatGuid: 'c1',
      text: 'retire me',
      now: 1,
    });

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
    const neighbourFailure = neighbour.then(
      () => null,
      (error: unknown) => error,
    );
    await started;

    const retirementResult = retireOutgoing(db, 'temp-queued-retire', 77).then(
      () => null,
      (error: unknown) => error,
    );
    let preReleaseError: unknown;
    let neighbourError: unknown;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(
        raw
          .prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?')
          .get('temp-queued-retire'),
      ).toEqual({ attempts: 0 });
      expect(msgState(raw, 'temp-queued-retire')).toEqual({ s: 'sending', e: 0 });
    } catch (error) {
      preReleaseError = error;
    } finally {
      release();
      neighbourError = await neighbourFailure;
      await retirementResult;
    }
    if (preReleaseError) throw preReleaseError;

    expect(String(neighbourError)).toContain('neighbour rollback');
    expect(await retirementResult).toBeNull();
    expect(
      raw
        .prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?')
        .get('temp-queued-retire'),
    ).toEqual({ attempts: OUTGOING_MAX_ATTEMPTS });
    expect(msgState(raw, 'temp-queued-retire')).toEqual({ s: 'error', e: 77 });
  });

  it('rolls the queue cap back when marking the bubble fails', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-atomic-retire',
      chatId,
      chatGuid: 'c1',
      text: 'stay atomic',
      now: 1,
    });
    const realUpdate = db.update.bind(db);
    let updateCalls = 0;
    jest.spyOn(db, 'update').mockImplementation(((table: Parameters<AppDatabase['update']>[0]) => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error('forced retire failure');
      return realUpdate(table);
    }) as AppDatabase['update']);

    await expect(retireOutgoing(db, 'temp-atomic-retire', 77)).rejects.toThrow(
      'forced retire failure',
    );

    expect(
      raw
        .prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?')
        .get('temp-atomic-retire'),
    ).toEqual({ attempts: 0 });
    expect(msgState(raw, 'temp-atomic-retire')).toEqual({ s: 'sending', e: 0 });
  });
});

describe('markOutgoingSentNoGuid — transaction ownership', () => {
  it('waits behind a rolling-back neighbour and promotes a NULL-state bubble after rollback', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-no-guid-queued-current';
    const phantomKey = 'outgoing.no-guid.current-neighbour';
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'promote after rollback',
      now: 1,
    });
    raw.prepare('UPDATE messages SET send_state = NULL, error = 73 WHERE guid = ?').run(tempGuid);
    const neighbour = await holdRollingBackNeighbour(db, raw, phantomKey);
    let helperSettled = false;
    const helperOutcome = markOutgoingSentNoGuid(db, tempGuid)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, helperOutcome, () => {
      expect(helperSettled).toBe(false);
      expect(msgState(raw, tempGuid)).toEqual({ s: null, e: 73 });
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
    });

    expect(outcome).toEqual({ kind: 'resolved', value: undefined });
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sent', e: 0 });
    expect(queueCount(raw, tempGuid)).toBe(0);
  });

  it('rejects a queued revoked owner unchanged and releases the slot for a fresh retry', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-no-guid-queued-revoked';
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'retire while queued',
      now: 1,
    });
    const neighbour = await holdRollingBackNeighbour(db, raw, 'outgoing.no-guid.revoked-neighbour');
    let current = true;
    let helperSettled = false;
    const helperOutcome = markOutgoingSentNoGuid(db, tempGuid, () => current)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        helperSettled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, helperOutcome, () => {
      expect(helperSettled).toBe(false);
      expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
      expect(queueCount(raw, tempGuid)).toBe(1);
      // The helper claimed this queue slot synchronously when `helperOutcome` was created.
      current = false;
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
    }
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
    expect(queueCount(raw, tempGuid)).toBe(1);

    await expect(markOutgoingSentNoGuid(db, tempGuid, () => true)).resolves.toBeUndefined();
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sent', e: 0 });
    expect(queueCount(raw, tempGuid)).toBe(0);
  });

  it('rolls the promoted bubble back when its exact queue delete fails, then retries', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-no-guid-delete-failure';
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'delete atomically',
      now: 1,
    });
    const canary = 'NO_GUID_QUEUE_DELETE_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER reject_no_guid_queue_delete
      BEFORE DELETE ON outgoing_queue
      WHEN OLD.temp_guid = '${tempGuid}'
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const failure = await markOutgoingSentNoGuid(db, tempGuid).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(failure.kind).toBe('rejected');
    if (failure.kind === 'rejected') {
      expect(errorMessageChain(failure.error)).toContain(canary);
    }
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
    expect(queueCount(raw, tempGuid)).toBe(1);

    raw.exec('DROP TRIGGER reject_no_guid_queue_delete');
    await expect(markOutgoingSentNoGuid(db, tempGuid)).resolves.toBeUndefined();
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sent', e: 0 });
    expect(queueCount(raw, tempGuid)).toBe(0);
  });

  it('awaits the orphan queue delete before committing or returning', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-no-guid-delayed-orphan-delete';
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'orphan delete lifetime',
      now: 1,
    });
    raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);

    type Delete = (table: unknown) => { where(condition: unknown): object };
    const realDelete = db.delete.bind(db) as unknown as Delete;
    let deleteDidStart = false;
    let releaseDelete!: () => void;
    let markDeleteFinished!: () => void;
    const deleteHeld = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteFinished = new Promise<void>((resolve) => {
      markDeleteFinished = resolve;
    });
    const deleteSpy = jest.spyOn(db, 'delete').mockImplementation(((table: unknown) => {
      const builder = realDelete(table);
      if (table !== outgoingQueue) return builder;
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property !== 'where') {
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (condition: unknown) => {
            const whereBuilder = target.where(condition);
            return new Proxy(whereBuilder, {
              get(whereTarget, whereProperty, whereReceiver) {
                const value = Reflect.get(whereTarget, whereProperty, whereReceiver);
                if (whereProperty !== 'then') {
                  return typeof value === 'function' ? value.bind(whereTarget) : value;
                }
                return (onFulfilled: unknown, onRejected: unknown) => {
                  deleteDidStart = true;
                  return deleteHeld
                    .then(() =>
                      Reflect.apply(value as (...args: unknown[]) => unknown, whereTarget, [
                        onFulfilled,
                        onRejected,
                      ]),
                    )
                    .finally(markDeleteFinished);
                };
              },
            });
          };
        },
      });
    }) as unknown as AppDatabase['delete']);

    let helperSettled = false;
    let helperOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      helperOutcome = markOutgoingSentNoGuid(db, tempGuid)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });
      for (let turn = 0; turn < 20 && !deleteDidStart; turn += 1) {
        await nextEventLoopTurn();
      }
      if (!deleteDidStart) {
        throw new Error('orphan queue delete did not start within 20 event-loop turns');
      }

      await nextEventLoopTurn();
      expect(helperSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(msgState(raw, tempGuid)).toBeUndefined();
      expect(queueCount(raw, tempGuid)).toBe(1);

      releaseDelete();
      const [outcome] = await Promise.all([helperOutcome, deleteFinished]);
      expect(outcome).toEqual({ kind: 'resolved', value: undefined });
      expect(raw.inTransaction).toBe(false);
      expect(msgState(raw, tempGuid)).toBeUndefined();
      expect(queueCount(raw, tempGuid)).toBe(0);
    } finally {
      releaseDelete();
      try {
        const drains: Promise<unknown>[] = [];
        if (helperOutcome) drains.push(helperOutcome);
        if (deleteDidStart) drains.push(deleteFinished);
        await Promise.allSettled(drains);
      } finally {
        deleteSpy.mockRestore();
      }
    }
  });
});

/**
 * P3/P4 — the two guards in this file that used to read a value into JavaScript and then use the
 * stale copy as the condition for a write. Both are now compare-and-set.
 */
describe('sticky-error and ladder-ownership guards are IN the write', () => {
  it('markOutgoingSentNoGuid does not promote an errored row, and leaves its ladder alone', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-sticky',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // The server-pushed failure landed just before the success ack.
    await reconcileOutgoingError(db, 'temp-sticky', 77, 1_000);

    await markOutgoingSentNoGuid(db, 'temp-sticky');

    expect(msgState(raw, 'temp-sticky')).toEqual({ s: 'error', e: 77 });
    expect(queueCount(raw, 'temp-sticky')).toBe(1); // retry ladder intact
  });

  it('markOutgoingSentNoGuid still clears a queue row whose message is gone (no blind re-send)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-orph',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("DELETE FROM messages WHERE guid='temp-orph'").run();

    await markOutgoingSentNoGuid(db, 'temp-orph');

    expect(queueCount(raw, 'temp-orph')).toBe(0);
  });

  /**
   * The retryable branch of applyServerSendError only exists for the RCS immediate-ack flow, where
   * the ack has ALREADY deleted the queue row by the time the failure arrives. Deciding on a
   * separate "is there a queue row?" SELECT meant that when the ack landed between the read and the
   * write, the UPDATE matched nothing, reported nothing, and the re-enqueue was never reached.
   */
  it('applyServerSendError re-enqueues when the ladder is gone, instead of silently doing nothing', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-reenq',
      chatId,
      chatGuid: 'c1',
      text: 'relay me',
      now: 1,
    });
    // The immediate ack: bubble marked sent, queue row consumed.
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-reenq'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-reenq'").run();

    await applyServerSendError(db, 'temp-reenq', 502, 5_000_000, true);

    expect(msgState(raw, 'temp-reenq')).toEqual({ s: 'error', e: 502 });
    const q = raw
      .prepare("SELECT kind, attempts a FROM outgoing_queue WHERE temp_guid='temp-reenq'")
      .get() as { kind: string; a: number };
    expect(q).toMatchObject({ kind: 'text', a: 1 });
  });

  it('keeps a public server-error re-enqueue out of a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-queued-server-error',
      chatId,
      chatGuid: 'c1',
      text: 'relay after rollback',
      now: 1,
    });
    raw
      .prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-queued-server-error'")
      .run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-queued-server-error'").run();

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('server-error neighbour rollback');
    });
    await started;

    const apply = applyServerSendError(db, 'temp-queued-server-error', 502, 5_000_000, true);
    await Promise.resolve();
    expect(msgState(raw, 'temp-queued-server-error')).toEqual({ s: 'sent', e: 0 });
    expect(queueCount(raw, 'temp-queued-server-error')).toBe(0);

    releaseNeighbour();
    const neighbourError = await neighbour.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(neighbourError)).toContain('server-error neighbour rollback');
    await expect(apply).resolves.toBe(true);
    expect(msgState(raw, 'temp-queued-server-error')).toEqual({ s: 'error', e: 502 });
    const queue = raw
      .prepare('SELECT attempts a FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-queued-server-error') as { a: number };
    expect(queue.a).toBe(1);
  });

  it('applyServerSendError advances the EXISTING ladder rather than re-enqueuing a second one', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-live',
      chatId,
      chatGuid: 'c1',
      text: 'fast fail',
      now: 1,
    });

    await applyServerSendError(db, 'temp-live', 502, 5_000_000, true);

    expect(queueCount(raw, 'temp-live')).toBe(1); // one ladder, not two
    const q = raw
      .prepare("SELECT attempts a, next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-live'")
      .get() as { a: number; n: number };
    expect(q.a).toBe(1);
    expect(q.n).toBe(5_000_000 + 30_000);
  });
});

describe('reconcileEchoByContent — guard clauses', () => {
  it('returns early for a received (not-from-me) echo', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-g',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'real-x', isFromMe: false, text: 'hi', dateCreated: 1 },
        chatId,
      ),
    );
    // temp row untouched (still the temp guid).
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-g');
  });

  it('returns early when the echo carries a temp- guid (nothing real to reconcile to)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-h',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'temp-h', isFromMe: true, text: 'hi', dateCreated: 1 },
        chatId,
      ),
    );
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-h');
  });

  it('no-ops when the real guid already exists (already reconciled by the ack)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-y',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    // No temp row to promote AND the guid exists → pure no-op (no throw, no extra row).
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'real-y', isFromMe: true, text: 'hi', dateCreated: 1 },
        chatId,
      ),
    );
    expect(await listMessages(db, chatId)).toHaveLength(1);
  });

  it('matches with NO date window when the echo omits dateCreated', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-nw',
      chatId,
      chatGuid: 'c1',
      text: 'ping',
      now: 5,
    });
    // dateCreated undefined → the `window` fragment is empty; content match alone promotes.
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(context, { guid: 'real-nw', isFromMe: true, text: 'ping' }, chatId),
    );
    expect(msgState(raw, 'real-nw')?.s).toBe('sent');
    expect(queueCount(raw, 'temp-nw')).toBe(0);
  });

  it('moves a cancelled-send ledger marker through live-echo promotion and later purge', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-live-deleted',
      chatId,
      chatGuid: 'c1',
      text: 'cancelled before echo',
      now: 100,
    });
    await cancelOutgoing(db, 'temp-live-deleted', 9_001);

    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        {
          guid: 'real-live-deleted',
          isFromMe: true,
          text: 'cancelled before echo',
          dateCreated: 100,
        },
        chatId,
      ),
    );

    expect(deletionLedgerDate(raw, 'temp-live-deleted')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'real-live-deleted')).toBe(9_001);
    await expectDeletionSurvivesPurgeAndReingest(
      db,
      raw,
      chatId,
      'real-live-deleted',
      'cancelled before echo',
      9_001,
    );
  });
});

describe('reconcileOutgoingAttachmentByContent — sync-safe promote', () => {
  it('promotes a still-pending optimistic picture that owns a local attachment', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-att1',
      attachmentGuid: 'temp-att1-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///p.jpg',
      mimeType: 'image/jpeg',
      transferName: 'p.jpg',
      totalBytes: 10,
      now: 100,
    });
    raw
      .prepare("UPDATE messages SET error_message = 'stale detail' WHERE guid = 'temp-att1'")
      .run();
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'rcs-real-1', isFromMe: true, text: null, dateCreated: 100 },
      chatId,
    );
    expect(msgState(raw, 'rcs-real-1')?.s).toBe('sent');
    expect(
      raw.prepare('SELECT error_message AS detail FROM messages WHERE guid = ?').get('rcs-real-1'),
    ).toEqual({ detail: null });
    const id = (
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('rcs-real-1') as { id: number }
    ).id;
    const atts = (await listAttachmentsByMessageIds(db, [id])).get(id)!;
    expect(atts[0]!.localPath).toBe('file:///p.jpg'); // on-disk file preserved through the promote
  });

  it('moves a cancelled picture ledger marker through sync-safe promotion and later purge', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-att-deleted',
      attachmentGuid: 'temp-att-deleted-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///cancelled.jpg',
      mimeType: 'image/jpeg',
      transferName: 'cancelled.jpg',
      totalBytes: 10,
      now: 100,
    });
    await cancelOutgoing(db, 'temp-att-deleted', 9_002);

    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'real-att-deleted', isFromMe: true, text: null, dateCreated: 100 },
      chatId,
    );

    expect(deletionLedgerDate(raw, 'temp-att-deleted')).toBeUndefined();
    expect(deletionLedgerDate(raw, 'real-att-deleted')).toBe(9_002);
    await expectDeletionSurvivesPurgeAndReingest(db, raw, chatId, 'real-att-deleted', null, 9_002);
  });

  it('queues the queue-delete and guid promotion behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-queued-att',
      attachmentGuid: 'temp-queued-att-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///queued.jpg',
      mimeType: 'image/jpeg',
      transferName: 'queued.jpg',
      totalBytes: 10,
      now: 100,
    });

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const reconcile = reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'rcs-real-queued', isFromMe: true, text: null, dateCreated: 100 },
      chatId,
    );
    await Promise.resolve();
    expect(queueCount(raw, 'temp-queued-att')).toBe(1);
    expect(msgState(raw, 'temp-queued-att')?.s).toBe('sending');
    expect(msgState(raw, 'rcs-real-queued')).toBeUndefined();

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await reconcile;
    expect(queueCount(raw, 'temp-queued-att')).toBe(0);
    expect(msgState(raw, 'temp-queued-att')).toBeUndefined();
    expect(msgState(raw, 'rcs-real-queued')?.s).toBe('sent');
  });

  it('does NOT match a text-only pending send (no local attachment to protect)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-txt',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 100,
    });
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'rcs-real-2', isFromMe: true, text: 'hi', dateCreated: 100 },
      chatId,
    );
    // temp text row is NOT hijacked by the attachment reconcile.
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-txt');
  });

  it('no-ops for a received message and for an already-materialized guid', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    // not-from-me guard:
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'r', isFromMe: false, dateCreated: 1 },
      chatId,
    );
    // already-exists guard:
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'exists-1',
          isFromMe: true,
          dateCreated: 1,
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'exists-1', isFromMe: true, dateCreated: 1 },
      chatId,
    );
    expect(await listMessages(db, chatId)).toHaveLength(1);
  });
});

describe('a cancelled send vs a later IDENTICAL one', () => {
  /**
   * Both rows match the echo by content, so the ORDER BY has to prefer the LIVE one. Promoting the
   * tombstoned row instead would hide the message the user actually sent and leave the visible
   * bubble stuck on its temp identity.
   */
  it('promotes the live send first, and the cancelled one only on its own echo', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-a',
      chatId,
      chatGuid: 'c1',
      text: 'ok',
      now: 1,
    });
    await cancelOutgoing(db, 'temp-a', 9_000);
    await insertOutgoingText(db, {
      tempGuid: 'temp-b',
      chatId,
      chatGuid: 'c1',
      text: 'ok',
      now: 2,
    });

    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'real-b', isFromMe: true, text: 'ok', dateCreated: 2 },
        chatId,
      ),
    );
    expect(tombstone(raw, 'real-b')).toBeNull(); // the LIVE send took the echo
    expect(msgState(raw, 'temp-a')).toBeDefined(); // the cancelled one is still waiting

    // The cancelled send's own echo (it had left the device) then finds the only candidate left.
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'real-a', isFromMe: true, text: 'ok', dateCreated: 1 },
        chatId,
      ),
    );
    expect(tombstone(raw, 'real-a')).toBe(9_000);
    const visible = await listMessagesWithSenders(db, chatId);
    expect(visible.map((m) => m.guid)).toEqual(['real-b']);
  });
});
