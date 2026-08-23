import type Database from 'better-sqlite3';
import { Attachment, Chat, Message } from '@core/models';
import {
  applyLocalUnsend,
  deleteMessageLocal,
  getChatHeader,
  listThreadMessages,
  getChatIdByGuid,
  getFirstUnreadInChat,
  getNewestReceivedGuid,
  insertOutgoingText,
  listChatsForInbox,
  listMessagesAround,
  listMessagesWithSenders,
  markMessageDeleted,
  markMessageSendError,
  reconcileOutgoingSuccess,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { messageDeletionLedger, outgoingQueue } from '@db/schema';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { buildGroupEventText } from '@utils';
import { createTestDb } from '../support/testDb';

async function holdRollingBackTransaction(
  db: AppDatabase,
  beforeHold: () => void = () => undefined,
): Promise<{
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
    beforeHold();
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

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

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

function queueCount(raw: Database.Database, guid: string): number {
  return (
    raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue WHERE temp_guid = ?').get(guid) as {
      count: number;
    }
  ).count;
}

function tombstone(raw: Database.Database, guid: string): number | null | undefined {
  return (
    raw.prepare('SELECT date_deleted AS value FROM messages WHERE guid = ?').get(guid) as
      { value: number | null } | undefined
  )?.value;
}

function deletionLedgerDate(raw: Database.Database, guid: string): number | undefined {
  return (
    raw
      .prepare('SELECT date_deleted AS value FROM message_deletion_ledger WHERE guid = ?')
      .get(guid) as { value: number } | undefined
  )?.value;
}

function latestMessageDate(raw: Database.Database, chatId: number): number | null {
  return (
    raw.prepare('SELECT latest_message_date AS value FROM chats WHERE id = ?').get(chatId) as {
      value: number | null;
    }
  ).value;
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

async function seed(db: AppDatabase) {
  const handles = await upsertHandles(db, [
    { address: 'a@x.com', displayName: 'Alice' },
    { address: 'b@x.com', displayName: 'Bob' },
  ]);
  const map = await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'c1',
        displayName: 'Group',
        participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
      }),
    ],
    handles,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm1',
        text: 'first',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({ guid: 'm2', text: 'mine', isFromMe: true, dateCreated: 200 }),
      Message.parse({
        guid: 'm3',
        text: 'latest',
        dateCreated: 300,
        handle: { address: 'b@x.com' },
      }),
    ],
    () => chatId,
    handles,
  );
  return chatId;
}

describe('upsertMessages transaction ownership', () => {
  it('queues a public upsert behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'owner@example.com' }]);
    const chatMap = await upsertChats(
      db,
      [Chat.parse({ guid: 'ownership-chat', participants: [{ address: 'owner@example.com' }] })],
      handles,
    );
    const chatId = chatMap.get('ownership-chat');
    if (chatId == null) throw new Error('ownership test chat was not stored');

    const neighbour = await holdRollingBackTransaction(db);
    const pending = upsertMessages(
      db,
      [
        Message.parse({
          guid: 'queued-message',
          text: 'wait for your own transaction',
          dateCreated: 100,
          handle: { address: 'owner@example.com' },
        }),
      ],
      () => chatId,
      handles,
    );

    const stored = await finishAfterQueuedObservation(neighbour, pending, () => {
      expect(
        raw.prepare("SELECT guid FROM messages WHERE guid = 'queued-message'").get(),
      ).toBeUndefined();
    });

    expect(stored.has('queued-message')).toBe(true);
    expect(raw.prepare("SELECT guid FROM messages WHERE guid = 'queued-message'").get()).toEqual({
      guid: 'queued-message',
    });
  });

  it('rolls back an inserted message when a later attachment write fails', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'atomic@example.com' }]);
    const chatMap = await upsertChats(
      db,
      [Chat.parse({ guid: 'atomic-chat', participants: [{ address: 'atomic@example.com' }] })],
      handles,
    );
    const chatId = chatMap.get('atomic-chat');
    if (chatId == null) throw new Error('atomicity test chat was not stored');
    raw.exec(`
      CREATE TRIGGER fail_message_attachment
      BEFORE INSERT ON attachments
      WHEN NEW.guid = 'forced-failure-att'
      BEGIN
        SELECT RAISE(ABORT, 'forced attachment failure');
      END
    `);

    let failure: unknown;
    try {
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'atomic-message',
            text: 'must roll back',
            dateCreated: 200,
            handle: { address: 'atomic@example.com' },
            attachments: [Attachment.parse({ guid: 'forced-failure-att', mimeType: 'image/png' })],
          }),
        ],
        () => chatId,
        handles,
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain('forced attachment failure');
    expect(
      raw.prepare("SELECT guid FROM messages WHERE guid = 'atomic-message'").get(),
    ).toBeUndefined();
    expect(
      raw.prepare("SELECT guid FROM attachments WHERE guid = 'forced-failure-att'").get(),
    ).toBeUndefined();
  });

  it('refreshes rich bodies atomically while preserving lean receipt projections', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'rich@example.com' }]);
    const chatMap = await upsertChats(
      db,
      [Chat.parse({ guid: 'rich-refresh-chat', participants: [{ address: 'rich@example.com' }] })],
      handles,
    );
    const chatId = chatMap.get('rich-refresh-chat');
    if (chatId == null) throw new Error('rich refresh chat was not stored');
    const oldBody = [{ string: 'cobalt predecessor', runs: [] }];
    const newBody = [{ string: 'saffron replacement', runs: [] }];
    const restoredBody = [{ string: 'ember same marker', runs: [] }];
    const row = () =>
      raw
        .prepare(
          `SELECT text, attributed_body AS attributedBody, date_edited AS dateEdited,
                  date_read AS dateRead, date_delivered AS dateDelivered
             FROM messages WHERE guid = 'rich-refresh-message'`,
        )
        .get();
    const hits = (term: string): number =>
      (
        raw
          .prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH ?')
          .get(term) as { count: number }
      ).count;
    let triggerInstalled = false;
    try {
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            text: '',
            attributedBody: oldBody,
            dateCreated: 100,
            dateEdited: 1_000,
            handle: { address: 'rich@example.com' },
          }),
        ],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'cobalt predecessor',
        attributedBody: JSON.stringify(oldBody),
        dateEdited: 1_000,
        dateRead: null,
        dateDelivered: null,
      });

      raw.exec(`CREATE TRIGGER fail_rich_refresh_attachment
        BEFORE INSERT ON attachments
        WHEN NEW.guid = 'rich-refresh-failure'
        BEGIN SELECT RAISE(ABORT, 'RICH_BODY_REFRESH_CANARY'); END`);
      triggerInstalled = true;
      let failure: unknown;
      try {
        await upsertMessages(
          db,
          [
            Message.parse({
              guid: 'rich-refresh-message',
              text: '',
              attributedBody: newBody,
              dateCreated: 100,
              dateEdited: 2_000,
              handle: { address: 'rich@example.com' },
              attachments: [
                Attachment.parse({ guid: 'rich-refresh-failure', mimeType: 'image/png' }),
              ],
            }),
          ],
          () => chatId,
          handles,
        );
      } catch (error) {
        failure = error;
      }
      expect(errorMessageChain(failure)).toContain('RICH_BODY_REFRESH_CANARY');
      expect(row()).toEqual({
        text: 'cobalt predecessor',
        attributedBody: JSON.stringify(oldBody),
        dateEdited: 1_000,
        dateRead: null,
        dateDelivered: null,
      });
      expect(hits('cobalt')).toBe(1);
      expect(hits('saffron')).toBe(0);

      raw.exec('DROP TRIGGER fail_rich_refresh_attachment');
      triggerInstalled = false;
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            text: '',
            attributedBody: newBody,
            dateCreated: 100,
            dateEdited: 2_000,
            handle: { address: 'rich@example.com' },
            attachments: [
              Attachment.parse({ guid: 'rich-refresh-failure', mimeType: 'image/png' }),
            ],
          }),
        ],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'saffron replacement',
        attributedBody: JSON.stringify(newBody),
        dateEdited: 2_000,
        dateRead: null,
        dateDelivered: null,
      });
      expect(hits('cobalt')).toBe(0);
      expect(hits('saffron')).toBe(1);

      // A newer marker alone is still a lean projection: without replacement text it cannot
      // prove that the rich rendering source should be cleared.
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            attributedBody: null,
            dateCreated: 100,
            dateEdited: 2_500,
            dateDelivered: 2_600,
          }),
        ],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'saffron replacement',
        attributedBody: JSON.stringify(newBody),
        dateEdited: 2_500,
        dateRead: null,
        dateDelivered: 2_600,
      });

      // A strictly newer plain edit is authoritative and must clear the old rich rendering source.
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            text: 'violet plain replacement',
            attributedBody: null,
            dateCreated: 100,
            dateEdited: 3_000,
            dateRead: 3_100,
          }),
        ],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'violet plain replacement',
        attributedBody: null,
        dateEdited: 3_000,
        dateRead: 3_100,
        dateDelivered: 2_600,
      });
      expect(hits('saffron')).toBe(0);
      expect(hits('violet')).toBe(1);

      // The richer projection can arrive second with the same marker and must restore rich runs.
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            text: '',
            attributedBody: restoredBody,
            dateCreated: 100,
            dateEdited: 3_000,
          }),
        ],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'ember same marker',
        attributedBody: JSON.stringify(restoredBody),
        dateEdited: 3_000,
        dateRead: 3_100,
        dateDelivered: 2_600,
      });

      // Equal-marker explicit NULL and an undated omitted body are lean projections, not clears.
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'rich-refresh-message',
            text: 'ember same marker',
            attributedBody: null,
            dateCreated: 100,
            dateEdited: 3_000,
            dateDelivered: 3_200,
          }),
        ],
        () => chatId,
        handles,
      );
      await upsertMessages(
        db,
        [Message.parse({ guid: 'rich-refresh-message', dateCreated: 100, dateRead: 3_300 })],
        () => chatId,
        handles,
      );
      expect(row()).toEqual({
        text: 'ember same marker',
        attributedBody: JSON.stringify(restoredBody),
        dateEdited: 3_000,
        dateRead: 3_300,
        dateDelivered: 3_200,
      });
      expect(hits('violet')).toBe(0);
      expect(hits('ember')).toBe(1);
    } finally {
      if (triggerInstalled) raw.exec('DROP TRIGGER IF EXISTS fail_rich_refresh_attachment');
      raw.close();
    }
  });
});

describe('conversation-view repositories', () => {
  it('getChatIdByGuid resolves hit/miss', async () => {
    const { db } = await createTestDb();
    const id = await seed(db);
    expect(await getChatIdByGuid(db, 'c1')).toBe(id);
    expect(await getChatIdByGuid(db, 'nope')).toBeNull();
  });

  it('listMessagesWithSenders returns newest-first with sender names', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const rows = await listMessagesWithSenders(db, chatId);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']); // newest first
    expect(rows[0]!.senderName).toBe('Bob');
    expect(rows[1]!.isFromMe).toBe(1);
    expect(rows[2]!.senderName).toBe('Alice');
  });

  it('listThreadMessages returns the originator + all its replies chronologically', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'r1',
          text: 'first reply',
          dateCreated: 400,
          threadOriginatorGuid: 'm1',
          handle: { address: 'a@x.com' },
        }),
        Message.parse({
          guid: 'r2',
          text: 'second reply',
          isFromMe: true,
          dateCreated: 500,
          threadOriginatorGuid: 'm1',
        }),
      ],
      () => chatId,
      handles,
    );
    const thread = await listThreadMessages(db, 'm1');
    expect(thread.map((m) => m.guid)).toEqual(['m1', 'r1', 'r2']); // originator first, then replies
    // Unrelated messages (m2/m3) are excluded.
    expect(thread.some((m) => m.guid === 'm3')).toBe(false);
  });

  it('getFirstUnreadInChat finds the oldest RECEIVED message past the read marker + count', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm4',
          text: 'newest',
          dateCreated: 400,
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      await upsertHandles(db, [{ address: 'a@x.com' }]),
    );

    // Marker at m1 → the first unread is m3 (m2 is OWN, never unread); count = m3 + m4.
    await setLastReadMessageGuid(db, 'c1', 'm1');
    const fu = await getFirstUnreadInChat(db, chatId);
    expect(fu).toMatchObject({ guid: 'm3', dateCreated: 300, count: 2 });

    // Never-read chat → everything received is unread, starting at m1.
    await setLastReadMessageGuid(db, 'c1', '');
    const never = await getFirstUnreadInChat(db, chatId);
    expect(never).toMatchObject({ guid: 'm1', count: 3 });

    // Fully read → null.
    await setLastReadMessageGuid(db, 'c1', 'm4');
    expect(await getFirstUnreadInChat(db, chatId)).toBeNull();
  });

  it('persists group-event columns and resolves other_handle → participant name', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [
      { address: 'a@x.com', displayName: 'Alice' },
      { address: 'b@x.com', displayName: 'Bob', originalROWID: 42 },
    ]);
    const map = await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'c1',
          displayName: 'Group',
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        }),
      ],
      handles,
    );
    const chatId = map.get('c1')!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'ge1',
          text: '',
          dateCreated: 500,
          handle: { address: 'a@x.com' },
          itemType: 1, // participant add/remove
          groupActionType: 0, // add
          otherHandle: 42, // Bob's server ROWID
        }),
      ],
      () => chatId,
      handles,
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'ge1')!;
    expect(row.itemType).toBe(1);
    expect(row.groupActionType).toBe(0);
    expect(row.otherHandleName).toBe('Bob'); // resolved from other_handle via original_row_id
    expect(row.senderName).toBe('Alice');
    expect(buildGroupEventText(row)).toBe('Alice added Bob to the conversation.');
  });

  it('repairs a null sender on a later hydrated re-sync, and never wipes a good one', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'a@x.com', displayName: 'Alice' }]);
    const map = await upsertChats(db, [Chat.parse({ guid: 'c1', displayName: 'Group' })], handles);
    const chatId = map.get('c1')!;

    // 1) Handle-less fetch (the old chat-open backfill): message inserted with NO sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    let row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBeNull(); // renders as "?"

    // 2) A later hydrated re-sync carries the sender → COALESCE fills the null handle.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
    expect(row.senderName).toBe('Alice');

    // 3) A subsequent handle-less fetch must NOT wipe the resolved sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi edited', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
  });

  it('paginates with beforeDate', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const older = await listMessagesWithSenders(db, chatId, 100, 300); // strictly older than m3
    expect(older.map((r) => r.guid)).toEqual(['m2', 'm1']);
  });

  it('listMessagesAround centers on the anchor with context on both sides', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Anchor on the middle message (m2 @ 200): both the newer (m3) and older (m1) appear.
    const rows = await listMessagesAround(db, chatId, 200);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']); // newest-first, anchor centered
  });

  it('listMessagesAround on the NEWEST message still loads older context (the bug repro)', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Old bug: jumping to a hit that's the newest message showed just that one message. The
    // window must still pull the older ones below it.
    const rows = await listMessagesAround(db, chatId, 300);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']);
  });

  it('listMessagesAround respects the before/after window caps', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Anchor m1 (@100) with before=0, after=1 → only the anchor + one newer (m3 excluded).
    const rows = await listMessagesAround(db, chatId, 100, 0, 1);
    expect(rows.map((r) => r.guid)).toEqual(['m2', 'm1']);
  });

  it('getNewestReceivedGuid ignores outgoing', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    expect(await getNewestReceivedGuid(db, chatId)).toBe('m3'); // not m2 (mine)
  });

  it('getChatHeader returns title + participant info', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const h = await getChatHeader(db, 'c1');
    expect(h?.displayName).toBe('Group');
    expect(h?.participantCount).toBe(2);
  });

  it('setLastReadMessageGuid clears the inbox unread count', async () => {
    const { db } = await createTestDb();
    await seed(db);
    let inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBeGreaterThan(0);
    await setLastReadMessageGuid(db, 'c1', 'm3');
    inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBe(0);
  });

  // Fix #8: a later event that OMITS a delivery-tier flag must not downgrade a stored
  // `true` (COALESCE(excluded.x, messages.x) on conflict). A later event that DOES carry
  // the flag still updates it.
  it('upsertMessages does not let a flagless re-upsert downgrade a stored delivery tier', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tier = (guid: string): { q: number | null; n: number | null } =>
      raw
        .prepare(
          'SELECT was_delivered_quietly q, did_notify_recipient n FROM messages WHERE guid = ?',
        )
        .get(guid) as { q: number | null; n: number | null };

    // First event sets the quiet-delivery tier true.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          text: 'quiet',
          dateCreated: 400,
          handle: { address: 'a@x.com' },
          wasDeliveredQuietly: true,
          didNotifyRecipient: true,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(1);

    // A later event for the same guid OMITS both flags → the stored trues must survive.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'q1', text: 'quiet edited', dateCreated: 400 })],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1); // not downgraded
    expect(tier('q1').n).toBe(1);

    // A later event that DOES carry a (different) flag still updates it.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          dateCreated: 400,
          wasDeliveredQuietly: true,
          didNotifyRecipient: false,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(0); // explicit false IS applied
  });

  // Apple "Send Later": the server emits isScheduled=true for ANY schedule_type=2 row — pending AND
  // after it sends (it's gated on schedule_type, NOT is_sent) — so isScheduled does NOT clear on
  // send. What flips is is_sent (0 → 1). Persist both; plain-overwrite on conflict so the send
  // propagates. The "Scheduled" badge is gated on `isScheduled && is_sent != 1` (see MessageBubble),
  // so a delivered Send-Later message stops badging because is_sent became 1 — not because
  // isScheduled cleared.
  it('persists isScheduled + isSent and flips isSent 0→1 on send (plain overwrite)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const flags = (guid: string): { s: number | null; sent: number | null } =>
      raw.prepare('SELECT is_scheduled s, is_sent sent FROM messages WHERE guid = ?').get(guid) as {
        s: number | null;
        sent: number | null;
      };

    // A PENDING Send-Later row: the server sends isScheduled:true + isSent:false.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'sch1',
          text: 'later',
          isFromMe: true,
          dateCreated: 4_000,
          isScheduled: true,
          isSent: false,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(flags('sch1')).toEqual({ s: 1, sent: 0 });
    const pending = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'sch1')!;
    expect(pending.isScheduled).toBe(1);
    expect(pending.isSent).toBe(0); // pending → the bubble badges it

    // The message SENDS: the server STILL emits isScheduled:true (schedule_type unchanged) but now
    // isSent:true. Plain-overwrite flips is_sent 0→1; is_scheduled stays 1. The badge hides on isSent.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'sch1',
          text: 'later',
          isFromMe: true,
          dateCreated: 4_000,
          isScheduled: true,
          isSent: true,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(flags('sch1')).toEqual({ s: 1, sent: 1 });

    // A never-scheduled message stores is_scheduled NULL (never badged).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'sch2',
          text: 'normal',
          dateCreated: 5_000,
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(flags('sch2').s).toBeNull();
  });
});

// The denormalized inbox sort key must agree with what the inbox actually RENDERS. Both the
// preview CTE and the unread count in listChatsForInbox skip `associated_message_type IS NOT NULL`,
// so a reaction that bumped latest_message_date would drag a chat to the top of the list carrying an
// unchanged, days-old preview and timestamp. This also protects insertOutgoingReaction's no-bump
// rule from the round-trip: the server echoes your own tapback back as an ordinary new-message.
describe('latest_message_date recompute ignores reactions', () => {
  it('an incoming tapback does not reorder the inbox, but a real message still does', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1@100, m2@200, m3@300 (newest real message)
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    expect(latestDate()).toBe(300);

    // Someone "likes" the three-day-old m3. The reaction row is far newer than every message …
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'react1',
          dateCreated: 9_000,
          associatedMessageGuid: 'm3',
          associatedMessageType: 'love',
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    // … yet the chat keeps its position: the preview would still read "latest" @300.
    expect(latestDate()).toBe(300);

    // The main path is untouched — a normal message still bumps the chat.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm4',
          text: 'a real reply',
          dateCreated: 10_000,
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    expect(latestDate()).toBe(10_000);
  });

  // MAX() over ZERO rows is NULL, and the reaction filter really can empty the candidate set: the
  // server's per-chat `lastMessage` is the newest message with NO reaction filter, so a chat whose
  // real history hasn't been backfilled yet (the whole of fullSync phase 2, and indefinitely for a
  // chat whose page errored) can hold exactly one local row — a tapback. NULL sorts LAST under
  // listChatsForInbox's `ORDER BY … latest_message_date DESC`, so without the COALESCE fallback that
  // chat sinks to the bottom of the inbox, which is the very thing the lastMessage upsert exists to
  // prevent. A tapback may not OUTRANK a real message; it may hold a spot nothing else is holding.
  it('a chat whose ONLY stored row is a reaction still gets a real sort key (never NULL)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db); // c1: m1@100, m2@200, m3@300 → latest 300
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    const map = await upsertChats(
      db,
      [Chat.parse({ guid: 'c2', displayName: 'Fresh', participants: [{ address: 'a@x.com' }] })],
      handles,
    );
    const chatId = map.get('c2')!;

    // All this chat has locally is the server-supplied lastMessage — and it is a tapback.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'react3',
          dateCreated: 9_000,
          associatedMessageGuid: 'not-yet-synced',
          associatedMessageType: 'love',
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );

    const latest = (
      raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
        d: number | null;
      }
    ).d;
    expect(latest).toBe(9_000); // NOT null
    // … so it still ranks against the other chats instead of dropping under all of them.
    expect((await listChatsForInbox(db)).map((r) => r.guid)).toEqual(['c2', 'c1']);
  });

  it('markMessageDeleted falls back past a NEWER reaction row, not onto it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1@100, m2@200, m3@300
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'react2',
          dateCreated: 9_000,
          associatedMessageGuid: 'm3',
          associatedMessageType: 'like',
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );

    // Deleting the newest real message drops the chat to m2 @200 — the reaction @9000 is not a
    // candidate, exactly as in upsertMessages' recompute (the two must never drift).
    expect(await markMessageDeleted(db, 'm3', 5_000)).toBe(true);
    expect(latestDate()).toBe(200);

    // Tombstone the rest and the filtered candidate set is EMPTY. The twin recompute carries the
    // same COALESCE fallback as upsertMessages, so the chat lands on the surviving reaction instead
    // of on a NULL that would sink it to the bottom of the inbox.
    expect(await markMessageDeleted(db, 'm2', 5_000)).toBe(true);
    expect(await markMessageDeleted(db, 'm1', 5_000)).toBe(true);
    expect(latestDate()).toBe(9_000);
  });
});

describe('markMessageDeleted (deletion tombstone)', () => {
  it('tombstones the newest message, recomputes latest_message_date to the survivor, and hides it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300 (newest)
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    expect(latestDate()).toBe(300); // m3 is the newest

    const found = await markMessageDeleted(db, 'm3', 5000);
    expect(found).toBe(true);

    // The tombstone is written (Unix ms) — the row still exists (NOT hard-deleted) …
    const del = (
      raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('m3') as {
        d: number | null;
      }
    ).d;
    expect(del).toBe(5000);
    // … but VANISHES from the rendered thread (the deleted-newest falls back to m2) …
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toEqual(['m2', 'm1']);
    // … and the denormalized inbox sort key falls to the previous surviving message (m2 @200).
    expect(latestDate()).toBe(200);
  });

  it('excludes the deleted originator/reply from listThreadMessages too', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'r1',
          text: 'a reply',
          dateCreated: 400,
          threadOriginatorGuid: 'm1',
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    expect((await listThreadMessages(db, 'm1')).map((m) => m.guid)).toEqual(['m1', 'r1']);
    await markMessageDeleted(db, 'r1', 5000);
    expect((await listThreadMessages(db, 'm1')).map((m) => m.guid)).toEqual(['m1']); // reply gone
  });

  it('recompute COUNTS retracted rows (they still render as tombstones) but excludes deleted ones', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1@100, m2@200, m3@300
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    // Unsend the NEWEST (m3): a retracted row still renders as a tombstone bubble, so it must keep
    // holding the chat's latest position.
    await applyLocalUnsend(db, 'm3', 4000);
    // Now delete a MIDDLE message (m2). Survivors: m1@100 and the retracted m3@300 → MAX must be 300.
    const found = await markMessageDeleted(db, 'm2', 5000);
    expect(found).toBe(true);
    expect(latestDate()).toBe(300); // retracted m3 counts; only the deleted m2 is excluded
  });

  // THE RE-SYNC HAZARD. A deleted message stays in the Mac's chat.db (~30 days) and the server keeps
  // returning it from query/sync, so the SAME guid is re-upserted after the tombstone. Two invariants
  // in upsertMessages keep the deletion from undoing itself, and this test pins both:
  //   1. `date_deleted` comes only from the local deletion ledger and the conflict set preserves the
  //      later local tombstone, so a wire re-upsert cannot clear it.
  //   2. its `latest_message_date` recompute filters `date_deleted IS NULL`, so re-ingesting the
  //      deleted NEWEST message can't re-inflate the chat's inbox position back to its date.
  it('a later sync re-upserting the SAME guid does NOT resurrect a tombstoned message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300 (newest)
    const handles = await upsertHandles(db, [{ address: 'b@x.com', displayName: 'Bob' }]);
    const tombstone = (): number | null =>
      (
        raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('m3') as {
          d: number | null;
        }
      ).d;
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;

    await markMessageDeleted(db, 'm3', 5000);
    expect(tombstone()).toBe(5000);
    expect(latestDate()).toBe(200); // dropped to the surviving m2

    // The next sync re-ingests m3 verbatim (the server still has it in Recently Deleted). A wire
    // MessageV1 NEVER carries the deletion — only the `message-deleted` EVENT does — so there is
    // nothing here that could legitimately clear the tombstone.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm3',
          text: 'latest',
          dateCreated: 300,
          dateRead: 350, // a receipt-shaped field DOES update — proves the row was really re-upserted
          handle: { address: 'b@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );

    // The re-upsert really happened (the row was touched) …
    const read = (
      raw.prepare('SELECT date_read r FROM messages WHERE guid = ?').get('m3') as {
        r: number | null;
      }
    ).r;
    expect(read).toBe(350);
    // … yet the locally sourced tombstone is untouched by the wire re-upsert.
    expect(tombstone()).toBe(5000);
    // … the message stays VANISHED from the thread …
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toEqual(['m2', 'm1']);
    // … and the inbox sort key was NOT re-inflated to 300 by upsertMessages' own recompute.
    expect(latestDate()).toBe(200);
  });

  it('is a safe no-op for an unknown guid (returns false, changes nothing)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    const before = latestDate();
    expect(await markMessageDeleted(db, 'does-not-exist', 5000)).toBe(false);
    expect(latestDate()).toBe(before); // untouched
    // No stray tombstone landed on any real row.
    const anyDeleted = raw
      .prepare('SELECT COUNT(*) c FROM messages WHERE date_deleted IS NOT NULL')
      .get() as { c: number };
    expect(anyDeleted.c).toBe(0);
  });
});

// Receipts, the edit marker and the unsend tombstone are MONOTONIC — the server never un-reports
// one, and no payload ever means "this was undone". They must therefore be COALESCE-preserved in
// the conflict set (present value wins, ABSENCE preserved) exactly like the delivery tiers. Without
// that, ensureChatSynced — which re-pages up to 500 messages on EVERY chat open — can land a page
// fetched BEFORE an unsend and carrying `dateRetracted: null`, which clears the tombstone; the
// original text is still in the row (it's COALESCE-preserved), so revoked content renders in full.
describe('monotonic receipt/edit/unsend columns survive a STALE re-upsert', () => {
  const marker = (
    raw: { prepare: (s: string) => { get: (g: string) => unknown } },
    guid: string,
    col: string,
  ): number | null =>
    (raw.prepare(`SELECT ${col} v FROM messages WHERE guid = ?`).get(guid) as { v: number | null })
      .v;

  it('an older sync page landing after an unsend does NOT resurrect the message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m3 recv@300, text "latest"
    const handles = await upsertHandles(db, [{ address: 'b@x.com', displayName: 'Bob' }]);

    // The sender unsends m3. The live event writes the retraction; the thread shows a tombstone and
    // the inbox preview drops it.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm3',
          text: 'latest',
          dateCreated: 300,
          dateRetracted: 8_000,
          handle: { address: 'b@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    expect(marker(raw, 'm3', 'date_retracted')).toBe(8_000);

    // Page 3 of the chat-open sync — fetched BEFORE the unsend, landing after it — carries no
    // retraction at all.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm3',
          text: 'latest',
          dateCreated: 300,
          dateRead: 9_000, // a receipt-shaped field proves the row really was re-upserted
          handle: { address: 'b@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    expect(marker(raw, 'm3', 'date_read')).toBe(9_000); // the re-upsert happened …
    expect(marker(raw, 'm3', 'date_retracted')).toBe(8_000); // … and the tombstone survived it
  });

  it('a flagless re-upsert does not blank a stored read/delivered receipt or the edit marker', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'r1',
          text: 'edited body',
          isFromMe: true,
          dateCreated: 400,
          dateDelivered: 410,
          dateRead: 420,
          dateEdited: 430,
        }),
      ],
      () => chatId,
      new Map(),
    );

    // A leaner projection (a live event, a hydrated `lastMessage`) omits all four.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'r1', text: 'edited body', isFromMe: true, dateCreated: 400 })],
      () => chatId,
      new Map(),
    );
    expect(marker(raw, 'r1', 'date_delivered')).toBe(410);
    expect(marker(raw, 'r1', 'date_read')).toBe(420);
    expect(marker(raw, 'r1', 'date_edited')).toBe(430);
  });

  it('a PRESENT value still wins — only ABSENCE is preserved', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'p1', text: 'hi', isFromMe: true, dateCreated: 500, dateRead: 510 })],
      () => chatId,
      new Map(),
    );
    // A later, newer receipt must still overwrite (COALESCE preserves absence, not staleness) …
    await upsertMessages(
      db,
      [Message.parse({ guid: 'p1', text: 'hi', isFromMe: true, dateCreated: 500, dateRead: 600 })],
      () => chatId,
      new Map(),
    );
    expect(marker(raw, 'p1', 'date_read')).toBe(600);
    // … and a genuine retraction still lands on a previously un-retracted row.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'p1',
          text: 'hi',
          isFromMe: true,
          dateCreated: 500,
          dateRetracted: 700,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(marker(raw, 'p1', 'date_retracted')).toBe(700);
  });

  // The v1 message DTO carries NO `error` field (send failures travel in the separate
  // `message-send-error` envelope), so `excluded.error` could only ever be the hard-coded 0 seed —
  // refreshing it on conflict erases rather than reflects.
  it('a re-sync does not erase a stored send-error code', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const state = (): { error: number; sendState: string } =>
      raw.prepare('SELECT error, send_state sendState FROM messages WHERE guid = ?').get('m3') as {
        error: number;
        sendState: string;
      };

    await markMessageSendError(db, 'm3', 22); // e.g. an RCS delivery failure keyed by its real guid
    expect(state()).toEqual({ error: 22, sendState: 'error' });

    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm3',
          text: 'latest',
          dateCreated: 300,
          dateRead: 9_500, // proves the row was re-upserted
          handle: { address: 'b@x.com' },
        }),
      ],
      () => chatId,
      await upsertHandles(db, [{ address: 'b@x.com' }]),
    );

    expect(
      (raw.prepare('SELECT date_read v FROM messages WHERE guid = ?').get('m3') as { v: number }).v,
    ).toBe(9_500);
    expect(state()).toEqual({ error: 22, sendState: 'error' }); // the specific code survives
  });
});

// The user's own Delete must be a TOMBSTONE, not a row removal: the deletion never leaves the
// device, so the server still returns that guid and ensureChatSynced — which runs on EVERY chat
// open — re-inserts it. A hard delete is undone the very next time the thread is opened.
describe('deleteMessageLocal (the user’s own delete)', () => {
  it('owns an exact current-temp deletion independently of a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tempGuid = 'temp-delete-current-neighbour';
    const phantomKey = 'message-delete.real-neighbour';
    const deletedAt = 6_000;
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'delete the exact current temp row',
      now: 400,
    });
    const neighbour = await holdRollingBackTransaction(db, () => {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(phantomKey, 'phantom');
    });
    let helperSettled = false;
    const helperOutcome = deleteMessageLocal(db, tempGuid, deletedAt)
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
      expect(raw.inTransaction).toBe(true);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
      expect(tombstone(raw, tempGuid)).toBeNull();
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
      expect(latestMessageDate(raw, chatId)).toBe(400);
    } catch (error) {
      observationError = error;
    } finally {
      neighbour.release();
    }

    const [neighbourFailure, outcome] = await Promise.all([neighbour.failure, helperOutcome]);
    if (observationError) throw observationError;
    expect(String(neighbourFailure)).toContain('neighbour rollback');
    expect(outcome).toEqual({ kind: 'resolved', value: 'applied' });
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expect(tombstone(raw, tempGuid)).toBe(deletedAt);
    expect(queueCount(raw, tempGuid)).toBe(0);
    expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
    expect(latestMessageDate(raw, chatId)).toBe(300);
  });

  it('resolves a stale temp guid only after the queued real-guid promotion commits', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tempGuid = 'temp-delete-after-promotion';
    const realGuid = 'real-delete-after-promotion';
    const deletedAt = 6_000;
    const phantomKey = 'message-delete.promotion-neighbour';
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'promote before deleting me',
      now: 400,
    });
    const neighbour = await holdRollingBackTransaction(db, () => {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(phantomKey, 'phantom');
    });
    let promotionSettled = false;
    let deletionSettled = false;
    const promotionOutcome = reconcileOutgoingSuccess(db, tempGuid, {
      guid: realGuid,
      dateCreated: 450,
      dateDelivered: 500,
    })
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        promotionSettled = true;
      });
    const deletionOutcome = deleteMessageLocal(db, tempGuid, deletedAt)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        deletionSettled = true;
      });

    let observationError: unknown;
    try {
      await nextEventLoopTurn();
      expect(promotionSettled).toBe(false);
      expect(deletionSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toEqual({
        value: 'phantom',
      });
      expect(
        raw.prepare('SELECT guid, send_state FROM messages WHERE guid = ?').get(tempGuid),
      ).toEqual({ guid: tempGuid, send_state: 'sending' });
      expect(raw.prepare('SELECT guid FROM messages WHERE guid = ?').get(realGuid)).toBeUndefined();
      expect(
        raw
          .prepare('SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = ?')
          .get(tempGuid),
      ).toBeUndefined();
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
      expect(deletionLedgerDate(raw, realGuid)).toBeUndefined();
      expect(latestMessageDate(raw, chatId)).toBe(400);
    } catch (error) {
      observationError = error;
    } finally {
      neighbour.release();
    }

    const [neighbourFailure, promotion, deletion] = await Promise.all([
      neighbour.failure,
      promotionOutcome,
      deletionOutcome,
    ]);
    if (observationError) throw observationError;
    expect(String(neighbourFailure)).toContain('neighbour rollback');
    expect(promotion).toEqual({ kind: 'resolved', value: undefined });
    expect(deletion).toEqual({ kind: 'resolved', value: 'applied' });
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(phantomKey)).toBeUndefined();
    expect(raw.prepare('SELECT guid FROM messages WHERE guid = ?').get(tempGuid)).toBeUndefined();
    expect(
      raw
        .prepare(
          'SELECT guid, date_created, date_delivered, send_state, error, date_deleted FROM messages WHERE guid = ?',
        )
        .get(realGuid),
    ).toEqual({
      guid: realGuid,
      date_created: 450,
      date_delivered: 500,
      send_state: 'sent',
      error: 0,
      date_deleted: deletedAt,
    });
    expect(
      raw
        .prepare('SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = ?')
        .get(tempGuid),
    ).toEqual({ canonical_guid: realGuid });
    expect(queueCount(raw, tempGuid)).toBe(0);
    expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
    expect(deletionLedgerDate(raw, realGuid)).toBe(deletedAt);
    expect(latestMessageDate(raw, chatId)).toBe(300);
  });

  it('awaits every temp-delete write and rolls them all back when the final chat update fails', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tempGuid = 'temp-delete-delayed-writes';
    const deletedAt = 6_000;
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'delay every deletion write',
      now: 400,
    });
    const messageFixture = raw
      .prepare(
        `SELECT guid, chat_id AS chatId, text, is_from_me AS isFromMe,
                date_created AS dateCreated, send_state AS sendState, error,
                date_deleted AS dateDeleted
           FROM messages WHERE guid = ?`,
      )
      .get(tempGuid) as {
      guid: string;
      chatId: number;
      text: string;
      isFromMe: number;
      dateCreated: number;
      sendState: string;
      error: number;
      dateDeleted: number | null;
    };
    const queueFixture = raw
      .prepare(
        `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts,
                next_retry_at AS nextRetryAt
           FROM outgoing_queue WHERE temp_guid = ?`,
      )
      .get(tempGuid);
    const storedMessage = (): unknown =>
      raw
        .prepare(
          `SELECT guid, chat_id AS chatId, text, is_from_me AS isFromMe,
                  date_created AS dateCreated, send_state AS sendState, error,
                  date_deleted AS dateDeleted
             FROM messages WHERE guid = ?`,
        )
        .get(tempGuid);
    const storedQueue = (): unknown =>
      raw
        .prepare(
          `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts,
                  next_retry_at AS nextRetryAt
             FROM outgoing_queue WHERE temp_guid = ?`,
        )
        .get(tempGuid);

    const triggerName = 'reject_delete_message_final_chat_update';
    const canary = 'DELETE_MESSAGE_FINAL_CHAT_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF latest_message_date ON chats
      WHEN NEW.id = ${chatId} AND NEW.latest_message_date = 300
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const stages = {
      queue: driverGate(),
      ledger: driverGate(),
      message: driverGate(),
      chat: driverGate(),
    };
    type Delete = (table: unknown) => { where(condition: unknown): object };
    type ConflictBuilder = { onConflictDoUpdate(config: unknown): object };
    type Insert = (table: unknown) => { values(values: unknown): ConflictBuilder };
    type All = (query: unknown) => unknown;
    type Run = (query: unknown) => unknown;
    const realDelete = db.delete.bind(db) as unknown as Delete;
    const realInsert = db.insert.bind(db) as unknown as Insert;
    const realAll = db.all.bind(db) as All;
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
          return (condition: unknown) => gateThenable(target.where(condition), stages.queue);
        },
      });
    }) as unknown as AppDatabase['delete']);
    const insertSpy = jest.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      const builder = realInsert(table);
      if (table !== messageDeletionLedger) return builder;
      return new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'values') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (values: unknown) => {
            const conflictBuilder = target.values(values);
            return new Proxy(conflictBuilder, {
              get(conflictTarget, conflictProperty) {
                const conflictValue = Reflect.get(conflictTarget, conflictProperty, conflictTarget);
                if (conflictProperty !== 'onConflictDoUpdate') {
                  return typeof conflictValue === 'function'
                    ? conflictValue.bind(conflictTarget)
                    : conflictValue;
                }
                return (config: unknown) =>
                  gateThenable(conflictTarget.onConflictDoUpdate(config), stages.ledger);
              },
            });
          };
        },
      });
    }) as unknown as AppDatabase['insert']);
    let delayedMessageUpdate: Promise<unknown> | undefined;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (
        !stages.message.didStart &&
        shape.includes('update messages') &&
        shape.includes('set date_deleted') &&
        shape.includes('returning chat_id')
      ) {
        stages.message.didStart = true;
        delayedMessageUpdate = stages.message.held
          .then(() => realAll(query))
          .finally(stages.message.markFinished);
        void delayedMessageUpdate.catch(() => undefined);
        return delayedMessageUpdate;
      }
      return realAll(query);
    }) as unknown as AppDatabase['all']);
    let delayedChatUpdate: Promise<unknown> | undefined;
    const runSpy = jest.spyOn(db, 'run').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (
        !stages.chat.didStart &&
        shape.includes('update chats') &&
        shape.includes('latest_message_date') &&
        shape.includes('associated_message_type is null')
      ) {
        stages.chat.didStart = true;
        delayedChatUpdate = stages.chat.held
          .then(() => realRun(query))
          .finally(stages.chat.markFinished);
        void delayedChatUpdate.catch(() => undefined);
        return delayedChatUpdate;
      }
      return realRun(query);
    }) as unknown as AppDatabase['run']);

    let helperSettled = false;
    let helperOutcome:
      | Promise<
          | { kind: 'resolved'; value: Awaited<ReturnType<typeof deleteMessageLocal>> }
          | { kind: 'rejected'; error: unknown }
        >
      | undefined;
    try {
      try {
        helperOutcome = deleteMessageLocal(db, tempGuid, deletedAt)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            helperSettled = true;
          });

        await waitForDriverGate(stages.queue, 'message-delete outgoing-queue delete');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(queueCount(raw, tempGuid)).toBe(1);
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(tombstone(raw, tempGuid)).toBeNull();
        expect(latestMessageDate(raw, chatId)).toBe(400);
        expect(stages.ledger.didStart).toBe(false);
        expect(stages.message.didStart).toBe(false);
        expect(stages.chat.didStart).toBe(false);
        stages.queue.release();
        await stages.queue.finished;

        await waitForDriverGate(stages.ledger, 'message-delete ledger insert');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(queueCount(raw, tempGuid)).toBe(0);
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(tombstone(raw, tempGuid)).toBeNull();
        expect(latestMessageDate(raw, chatId)).toBe(400);
        expect(stages.message.didStart).toBe(false);
        expect(stages.chat.didStart).toBe(false);
        stages.ledger.release();
        await stages.ledger.finished;

        await waitForDriverGate(stages.message, 'message-delete tombstone update');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(queueCount(raw, tempGuid)).toBe(0);
        expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
        expect(tombstone(raw, tempGuid)).toBeNull();
        expect(latestMessageDate(raw, chatId)).toBe(400);
        expect(stages.chat.didStart).toBe(false);
        stages.message.release();
        await stages.message.finished;

        await waitForDriverGate(stages.chat, 'message-delete final chat update');
        expect(helperSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(queueCount(raw, tempGuid)).toBe(0);
        expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
        expect(tombstone(raw, tempGuid)).toBe(deletedAt);
        expect(latestMessageDate(raw, chatId)).toBe(400);

        stages.chat.release();
        const [outcome] = await Promise.all([helperOutcome, stages.chat.finished]);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
          expect(errorMessageChain(outcome.error)).toContain(canary);
        }
        expect(helperSettled).toBe(true);
        expect(raw.inTransaction).toBe(false);
        expect(queueCount(raw, tempGuid)).toBe(1);
        expect(storedQueue()).toEqual(queueFixture);
        expect(deletionLedgerDate(raw, tempGuid)).toBeUndefined();
        expect(tombstone(raw, tempGuid)).toBeNull();
        expect(storedMessage()).toEqual(messageFixture);
        expect(latestMessageDate(raw, chatId)).toBe(400);
      } finally {
        for (const gate of Object.values(stages)) gate.release();
        try {
          const drains: Promise<unknown>[] = [];
          if (helperOutcome) drains.push(helperOutcome);
          for (const gate of Object.values(stages)) {
            if (gate.didStart) drains.push(gate.finished);
          }
          if (delayedMessageUpdate) drains.push(delayedMessageUpdate);
          if (delayedChatUpdate) drains.push(delayedChatUpdate);
          await Promise.allSettled(drains);
        } finally {
          runSpy.mockRestore();
          allSpy.mockRestore();
          insertSpy.mockRestore();
          deleteSpy.mockRestore();
        }
      }
    } finally {
      raw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    await expect(deleteMessageLocal(db, tempGuid, deletedAt)).resolves.toBe('applied');
    expect(raw.inTransaction).toBe(false);
    expect(queueCount(raw, tempGuid)).toBe(0);
    expect(deletionLedgerDate(raw, tempGuid)).toBe(deletedAt);
    expect(tombstone(raw, tempGuid)).toBe(deletedAt);
    expect(storedMessage()).toEqual({ ...messageFixture, dateDeleted: deletedAt });
    expect(latestMessageDate(raw, chatId)).toBe(300);
  });

  it('survives a re-sync of the same guids — the messages stay gone', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1@100, m2 mine@200, m3@300
    const handles = await upsertHandles(db, [
      { address: 'a@x.com', displayName: 'Alice' },
      { address: 'b@x.com', displayName: 'Bob' },
    ]);
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;

    // The user selects m2 + m3 and deletes them (bulk delete shares one timestamp).
    await deleteMessageLocal(db, 'm2', 6_000);
    await deleteMessageLocal(db, 'm3', 6_000);
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toEqual(['m1']);
    // The raw delete never did this: the inbox sort key follows the surviving message.
    expect(latestDate()).toBe(100);

    // Backing out and re-opening the chat re-pages it from the server, which still has both guids.
    await upsertMessages(
      db,
      [
        Message.parse({ guid: 'm2', text: 'mine', isFromMe: true, dateCreated: 200 }),
        Message.parse({
          guid: 'm3',
          text: 'latest',
          dateCreated: 300,
          handle: { address: 'b@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );

    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toEqual(['m1']);
    expect(latestDate()).toBe(100); // and the chat didn't jump back up the inbox either
  });

  it('TOMBSTONES a temp- row and takes its queue row with it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-x1',
      chatId,
      chatGuid: 'c1',
      text: 'bye',
      now: 1,
    });

    await deleteMessageLocal(db, 'temp-x1', 6_000);

    // A `temp-` guid is NOT proof the server never saw the message: on the guid-less ack paths a
    // DELIVERED send keeps its temp guid, and an errored one may have landed anyway. Hard-deleting
    // destroyed the row the later echo promotes in place, so the message came back untombstoned.
    const row = raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('temp-x1') as
      { d: number | null } | undefined;
    expect(row?.d).toBe(6_000);
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).not.toContain('temp-x1');
    const q = raw
      .prepare('SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-x1') as { c: number };
    expect(q.c).toBe(0); // …and the retry processor can't re-send it
  });

  it('is a safe no-op for an unknown guid', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    await expect(deleteMessageLocal(db, 'never-synced', 6_000)).resolves.toBe('recorded');
    const anyDeleted = raw
      .prepare('SELECT COUNT(*) c FROM messages WHERE date_deleted IS NOT NULL')
      .get() as { c: number };
    expect(anyDeleted.c).toBe(0);
  });
});
