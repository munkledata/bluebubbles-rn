import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  type DigestBackend,
  type EventDeliveryContext,
  EventRouter,
  type IncomingEventConflictRecovery,
  type NormalizedEvent,
} from '@core/realtime';
import { DurableRealtimeDispatcher } from '@/services/realtime/incomingEventDispatcher';
import { IncomingEventDrain } from '@/services/realtime/incomingEventDrain';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import {
  getChatIdByGuid,
  INCOMING_EVENT_LEASE_MS,
  insertOutgoingText,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

const digest: DigestBackend = {
  async sha256(input) {
    return new Uint8Array(createHash('sha256').update(input).digest());
  },
};

const NOW = 1_800_000_000_000;

function rawMessage(guid: string, text = 'hello', textTruncated = false) {
  return {
    guid,
    text,
    ...(textTruncated ? { textTruncated: true } : {}),
    dateCreated: NOW - 1,
    chats: [{ guid: 'dispatcher-chat' }],
  };
}

function currentLease(): EventDeliveryContext {
  return { generation: 11, isCurrent: () => true };
}

function wire(
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  raw: Database.Database,
  options: {
    digest?: DigestBackend;
    canPersist?: (event: NormalizedEvent) => boolean;
    canDrain?: () => boolean;
    onEffect?: (event: NormalizedEvent) => void | Promise<void>;
    allowDevPersistWithoutDrain?: boolean;
    now?: () => number;
  } = {},
) {
  const effects: NormalizedEvent[] = [];
  const handler = {
    async handleNormalized(event: NormalizedEvent) {
      // The effect can only run after enqueue + claim made the row durable.
      const queued = raw
        .prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue WHERE state = 'pending'`)
        .get() as { count: number };
      expect(queued.count).toBeGreaterThan(0);
      effects.push(event);
      await options.onEffect?.(event);
      return 'processed' as const;
    },
  };
  let leaseId = 0;
  const now = options.now ?? (() => NOW);
  const drain = new IncomingEventDrain(db, handler, options.digest ?? digest, {
    now,
    makeLeaseToken: () => `dispatcher-lease-${++leaseId}`,
    scheduleContinuation: jest.fn(),
    canDrain: options.canDrain,
  });
  let occurrence = 0;
  const recoveries = jest.fn<
    Promise<void>,
    [
      IncomingEventConflictRecovery,
      'key-conflict' | 'intake-poisoned' | 'duplicate-poisoned' | 'truncated-payload',
      EventDeliveryContext?,
    ]
  >(async () => undefined);
  const dispatcher = new DurableRealtimeDispatcher(db, options.digest ?? digest, drain, {
    now,
    makeTransportOccurrenceId: (source) => `${source}:${++occurrence}`,
    allowDevPersistWithoutDrain: options.allowDevPersistWithoutDrain,
    canPersist: options.canPersist,
    requestRecovery: recoveries,
  });
  return { dispatcher, effects, recoveries };
}

describe('durable realtime dispatcher', () => {
  it('keeps the DEV persist-without-drain seam closed unless composition explicitly opts in', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects } = wire(db, raw);

    await expect(
      dispatcher.persistWithoutDrainForDev(
        'new-message',
        rawMessage('closed-proof-seam'),
        'dev',
        currentLease(),
        { transportOccurrenceId: 'dev-proof:closed' },
        'dev-proof:closed-lease',
      ),
    ).resolves.toBeNull();

    expect(effects).toHaveLength(0);
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(0);
  });

  it('never lets a non-DEV source use the persist-without-drain seam', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects } = wire(db, raw, { allowDevPersistWithoutDrain: true });

    await expect(
      dispatcher.persistWithoutDrainForDev(
        'new-message',
        rawMessage('wrong-source-proof-seam'),
        'socket',
        currentLease(),
        { transportOccurrenceId: 'socket:wrong-source' },
        'dev-proof:wrong-source-lease',
      ),
    ).resolves.toBeNull();

    expect(effects).toHaveLength(0);
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(0);
  });

  it('persists without effects when DEV opts in, then resumes exactly once', async () => {
    const { db, raw } = await createTestDb();
    let now = NOW;
    const { dispatcher, effects } = wire(db, raw, {
      allowDevPersistWithoutDrain: true,
      now: () => now,
    });

    await expect(
      dispatcher.persistWithoutDrainForDev(
        'new-message',
        rawMessage('process-death-proof'),
        'dev',
        currentLease(),
        { transportOccurrenceId: 'dev-proof:queued' },
        'dev-proof:queued-lease',
      ),
    ).resolves.toMatchObject({
      event: { type: 'new-message' },
      queueId: expect.any(Number),
      claim: { attempts: 1, leaseToken: 'dev-proof:queued-lease' },
    });

    expect(effects).toHaveLength(0);
    expect(raw.prepare(`SELECT state, attempts FROM incoming_event_queue`).get()).toEqual({
      state: 'pending',
      attempts: 1,
    });

    now += INCOMING_EVENT_LEASE_MS;
    await dispatcher.resume(currentLease());
    await dispatcher.resume(currentLease());

    expect(effects).toHaveLength(1);
    expect(raw.prepare(`SELECT state, payload, attempts FROM incoming_event_queue`).get()).toEqual({
      state: 'completed',
      payload: null,
      attempts: 2,
    });
  });

  it('persists and claims before the first terminal effect, then scrubs the receipt', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects } = wire(db, raw);

    await dispatcher.handle('new-message', rawMessage('durable-first'), 'socket', currentLease(), {
      transportOccurrenceId: 'socket:1',
    });

    expect(effects).toHaveLength(1);
    expect(raw.prepare(`SELECT state, payload, attempts FROM incoming_event_queue`).get()).toEqual({
      state: 'completed',
      payload: null,
      attempts: 1,
    });
  });

  it('deduplicates the exact socket + FCM copies of one message across terminal receipts', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects, recoveries } = wire(db, raw);
    const payload = rawMessage('cross-source-duplicate');

    await dispatcher.handle('new-message', payload, 'socket', currentLease(), {
      transportOccurrenceId: 'socket:1',
    });
    await dispatcher.handle('new-message', JSON.stringify(payload), 'fcm', currentLease(), {
      transportOccurrenceId: 'fcm-provider-1',
    });

    expect(effects).toHaveLength(1);
    expect(recoveries).not.toHaveBeenCalled();
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(1);
  });

  it('does not request account recovery for the server rich/lean updated-message pair', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects, recoveries } = wire(db, raw);
    const richSocket = {
      guid: 'cross-source-update',
      text: 'same message',
      dateCreated: NOW - 10,
      dateDelivered: NOW - 1,
      attributedBody: [{ string: 'same message', runs: [] }],
      wasDeliveredQuietly: false,
      didNotifyRecipient: true,
      chats: [{ guid: 'dispatcher-chat' }],
    };
    const leanFcm = {
      guid: 'cross-source-update',
      text: 'same message',
      dateCreated: NOW - 10,
      dateDelivered: NOW - 1,
      attributedBody: null,
    };

    await dispatcher.handle('updated-message', richSocket, 'socket', currentLease(), {
      transportOccurrenceId: 'socket:update:1',
    });
    await dispatcher.handle('updated-message', leanFcm, 'fcm', currentLease(), {
      transportOccurrenceId: 'fcm:update:1',
    });

    expect(effects).toHaveLength(1);
    expect(recoveries).not.toHaveBeenCalled();
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(1);
  });

  it('ignores a delayed FCM copy after the same server send failure has begun retrying', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'send-error@x.com' }]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'send-error-chat',
          participants: [{ address: 'send-error@x.com' }],
        }),
      ],
      handles,
    );
    const chatId = await getChatIdByGuid(db, 'send-error-chat');
    if (chatId == null) throw new Error('send-error fixture failed to create its chat');
    await insertOutgoingText(db, {
      tempGuid: 'temp-delayed-send-error',
      chatId,
      chatGuid: 'send-error-chat',
      text: 'retry me',
      now: NOW - 1_000,
    });
    let leaseId = 0;
    const drain = new IncomingEventDrain(db, new EventRouter(new DbEventSink(db)), digest, {
      now: () => NOW,
      makeLeaseToken: () => `send-error-lease-${++leaseId}`,
      scheduleContinuation: jest.fn(),
    });
    const dispatcher = new DurableRealtimeDispatcher(db, digest, drain, {
      now: () => NOW,
      makeTransportOccurrenceId: (source) => `${source}:fallback`,
    });
    const errorPayload = {
      guid: 'real-delayed-send-attempt',
      tempGuid: 'temp-delayed-send-error',
      error: 22,
      retryable: true,
    };

    await dispatcher.handle('message-send-error', errorPayload, 'socket', currentLease(), {
      transportOccurrenceId: 'socket:error:1',
    });
    expect(
      raw
        .prepare(
          `SELECT m.send_state AS sendState, m.error, q.attempts
             FROM messages m JOIN outgoing_queue q ON q.temp_guid = m.guid
            WHERE m.guid = ?`,
        )
        .get('temp-delayed-send-error'),
    ).toEqual({ sendState: 'error', error: 22, attempts: 1 });

    // A user/queue retry has started since the socket copy. The provider-delayed copy describes
    // the OLD server attempt and must not regress this new one back to error.
    raw
      .prepare(`UPDATE messages SET send_state = 'sending', error = 0 WHERE guid = ?`)
      .run('temp-delayed-send-error');
    await dispatcher.handle('message-send-error', errorPayload, 'fcm', currentLease(), {
      transportOccurrenceId: 'fcm:error:1',
    });

    expect(
      raw
        .prepare(
          `SELECT m.send_state AS sendState, m.error, q.attempts
             FROM messages m JOIN outgoing_queue q ON q.temp_guid = m.guid
            WHERE m.guid = ?`,
        )
        .get('temp-delayed-send-error'),
    ).toEqual({ sendState: 'sending', error: 0, attempts: 1 });
  });

  it('re-requests recovery when an exact redelivery finds a poisoned receipt', async () => {
    const { db, raw } = await createTestDb();
    let eligible = true;
    const { dispatcher, recoveries } = wire(db, raw, {
      canPersist: () => eligible,
    });
    const payload = rawMessage('poisoned-redelivery');

    await dispatcher.handle('new-message', payload, 'fcm', currentLease(), {
      transportOccurrenceId: 'fcm-poisoned-original',
    });
    raw
      .prepare(
        `UPDATE incoming_event_queue
            SET state = 'poisoned', payload = NULL, terminal_at = ?, last_error_code = 'attempt-cap'`,
      )
      .run(NOW);
    recoveries.mockClear();

    await dispatcher.handle('new-message', payload, 'fcm', currentLease(), {
      transportOccurrenceId: 'fcm-poisoned-redelivery',
    });

    expect(recoveries).toHaveBeenCalledWith(
      { kind: 'sync-chat', chatGuid: 'dispatcher-chat' },
      'duplicate-poisoned',
      expect.any(Object),
    );
    const recoveryContext = recoveries.mock.calls[0]?.[2] as EventDeliveryContext;
    expect(recoveryContext.isCurrent()).toBe(true);
    eligible = false;
    expect(recoveryContext.isCurrent()).toBe(false);
  });

  it.each([
    [
      'full then capped',
      rawMessage('variant-a', 'complete body'),
      rawMessage('variant-a', 'complete…', true),
    ],
    [
      'capped then full',
      rawMessage('variant-b', 'complete…', true),
      rawMessage('variant-b', 'complete body'),
    ],
  ])('uses first-wins without redundant conflict recovery for %s', async (label, first, second) => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects, recoveries } = wire(db, raw);

    await dispatcher.handle('new-message', first, 'socket', currentLease(), {
      transportOccurrenceId: 'first-copy',
    });
    await dispatcher.handle('new-message', second, 'fcm', currentLease(), {
      transportOccurrenceId: 'second-copy',
    });

    expect(effects).toHaveLength(1);
    if (label === 'capped then full') {
      expect(recoveries).toHaveBeenCalledTimes(1);
      expect(recoveries).toHaveBeenCalledWith(
        { kind: 'sync-chat', chatGuid: 'dispatcher-chat' },
        'truncated-payload',
        expect.any(Object),
      );
    } else {
      expect(recoveries).not.toHaveBeenCalled();
    }
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(1);
  });

  it('requests proactive chat recovery for a lone truncated FCM payload', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, recoveries } = wire(db, raw);

    await dispatcher.handle(
      'new-message',
      rawMessage('truncated-only', 'long…', true),
      'fcm',
      currentLease(),
      { transportOccurrenceId: 'fcm-truncated' },
    );

    expect(recoveries).toHaveBeenCalledWith(
      { kind: 'sync-chat', chatGuid: 'dispatcher-chat' },
      'truncated-payload',
      expect.any(Object),
    );
  });

  it('reserves intake order before asynchronous hashing can finish out of order', async () => {
    const { db, raw } = await createTestDb();
    let releaseFirst!: () => void;
    let hashStarts = 0;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        hashStarts += 1;
        if (hashStarts === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return digest.sha256(input);
      },
    };
    const { dispatcher, effects } = wire(db, raw, { digest: gatedDigest });

    const first = dispatcher.handle(
      'new-message',
      rawMessage('ordered-1'),
      'socket',
      currentLease(),
    );
    const second = dispatcher.handle(
      'new-message',
      rawMessage('ordered-2'),
      'socket',
      currentLease(),
    );
    await Promise.resolve();
    expect(hashStarts).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(
      effects.map((event) => (event.type === 'new-message' ? event.message.guid : '')),
    ).toEqual(['ordered-1', 'ordered-2']);
  });

  it('snapshots a queued callback payload before waiting behind earlier hashing', async () => {
    const { db, raw } = await createTestDb();
    let releaseFirst!: () => void;
    let markFirstHashStarted!: () => void;
    const firstHashStarted = new Promise<void>((resolve) => {
      markFirstHashStarted = resolve;
    });
    const firstHashGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let hashStarts = 0;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        hashStarts += 1;
        if (hashStarts === 1) {
          markFirstHashStarted();
          await firstHashGate;
        }
        return digest.sha256(input);
      },
    };
    const { dispatcher, effects } = wire(db, raw, { digest: gatedDigest });
    const first = dispatcher.handle(
      'new-message',
      rawMessage('snapshot-first'),
      'socket',
      currentLease(),
    );
    await firstHashStarted;
    const secondPayload = rawMessage('snapshot-second', 'before mutation');
    const secondOccurrence = {
      serverEventId: 'server-before-mutation',
      transportOccurrenceId: 'socket:before-mutation',
    };
    const second = dispatcher.handle(
      'new-message',
      secondPayload,
      'socket',
      currentLease(),
      secondOccurrence,
    );

    secondPayload.text = 'after mutation';
    secondPayload.chats[0]!.guid = 'mutated-chat';
    secondOccurrence.serverEventId = 'server-after-mutation';
    secondOccurrence.transportOccurrenceId = 'socket:after-mutation';
    releaseFirst();
    await Promise.all([first, second]);

    const delivered = effects.find(
      (event) => event.type === 'new-message' && event.message.guid === 'snapshot-second',
    );
    expect(delivered).toMatchObject({
      type: 'new-message',
      message: {
        text: 'before mutation',
        chats: [{ guid: 'dispatcher-chat' }],
      },
    });

    const effectsBeforeDuplicate = effects.length;
    await dispatcher.handle(
      'new-message',
      rawMessage('snapshot-second', 'before mutation'),
      'socket',
      currentLease(),
      {
        serverEventId: 'server-before-mutation',
        transportOccurrenceId: 'socket:before-mutation',
      },
    );
    expect(effects).toHaveLength(effectsBeforeDuplicate);
  });

  it('timestamps receipt when each callback reserves its FIFO slot, before earlier hashing finishes', async () => {
    const { db, raw } = await createTestDb();
    let releaseFirst!: () => void;
    let markFirstHashStarted!: () => void;
    const firstHashStarted = new Promise<void>((resolve) => {
      markFirstHashStarted = resolve;
    });
    const firstHashGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let hashStarts = 0;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        hashStarts += 1;
        if (hashStarts === 1) {
          markFirstHashStarted();
          await firstHashGate;
        }
        return digest.sha256(input);
      },
    };
    let now = NOW;
    const { dispatcher } = wire(db, raw, { digest: gatedDigest, now: () => now });

    const first = dispatcher.handle(
      'new-message',
      rawMessage('receipt-before-fifo-1'),
      'socket',
      currentLease(),
    );
    await firstHashStarted;
    now = NOW + 1;
    const second = dispatcher.handle(
      'new-message',
      rawMessage('receipt-before-fifo-2'),
      'socket',
      currentLease(),
    );
    now = NOW + 1_000;
    releaseFirst();
    await Promise.all([first, second]);

    expect(
      raw
        .prepare(
          `SELECT received_at AS receivedAt
             FROM incoming_event_queue
            ORDER BY id`,
        )
        .all(),
    ).toEqual([{ receivedAt: NOW }, { receivedAt: NOW + 1 }]);
  });

  it('releases the intake slot after persistence instead of waiting for a slow effect', async () => {
    const { db, raw } = await createTestDb();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstEffect = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const { dispatcher, effects } = wire(db, raw, {
      onEffect: (event) => {
        if (event.type === 'new-message' && event.message.guid === 'slow-effect-1') {
          markFirstStarted();
          return firstEffect;
        }
      },
    });

    const first = dispatcher.handle(
      'new-message',
      rawMessage('slow-effect-1'),
      'socket',
      currentLease(),
    );
    await firstStarted;
    expect(effects).toHaveLength(1);

    const second = dispatcher.handle(
      'new-message',
      rawMessage('slow-effect-2'),
      'socket',
      currentLease(),
    );
    for (let index = 0; index < 20; index += 1) {
      const count = (
        raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number }
      ).count;
      if (count === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(2);
    expect(effects).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(
      effects.map((event) => (event.type === 'new-message' ? event.message.guid : '')),
    ).toEqual(['slow-effect-1', 'slow-effect-2']);
  });

  it('drops invalid/ineligible input before persistence and before effects', async () => {
    const { db, raw } = await createTestDb();
    const { dispatcher, effects } = wire(db, raw, {
      canPersist: (event) => event.type !== 'new-server',
    });

    await expect(dispatcher.handle('new-message', { text: 'no guid' }, 'fcm')).resolves.toBeNull();
    await expect(
      dispatcher.handle('new-server', { server_address: 'https://foreign.example.com' }, 'fcm'),
    ).resolves.toBeNull();

    expect(effects).toHaveLength(0);
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(0);
  });

  it('does not enqueue when persistence eligibility closes during asynchronous hashing', async () => {
    const { db, raw } = await createTestDb();
    let releaseHash!: () => void;
    let markHashStarted!: () => void;
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const hashStarted = new Promise<void>((resolve) => {
      markHashStarted = resolve;
    });
    let firstHash = true;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        if (firstHash) {
          firstHash = false;
          markHashStarted();
          await hashGate;
        }
        return digest.sha256(input);
      },
    };
    let canPersist = true;
    const persistenceGate = jest.fn(() => canPersist);
    const { dispatcher, effects } = wire(db, raw, {
      digest: gatedDigest,
      canPersist: persistenceGate,
    });

    const pending = dispatcher.handle(
      'new-message',
      rawMessage('locked-during-hash'),
      'fcm',
      currentLease(),
    );
    await hashStarted;
    canPersist = false;
    releaseHash();

    await expect(pending).resolves.toBeNull();
    expect(persistenceGate).toHaveBeenCalledTimes(2);
    expect(effects).toHaveLength(0);
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(0);
  });

  it('does not launch recovery when eligibility closes during the admitted drain', async () => {
    const { db, raw } = await createTestDb();
    let eligible = true;
    let releaseEffect!: () => void;
    let markEffectStarted!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    const { dispatcher, recoveries } = wire(db, raw, {
      canPersist: () => eligible,
      canDrain: () => eligible,
      onEffect: async () => {
        markEffectStarted();
        await effectGate;
      },
    });

    const pending = dispatcher.handle(
      'new-message',
      rawMessage('locked-during-drain', 'partial…', true),
      'fcm',
      currentLease(),
      { transportOccurrenceId: 'fcm:locked-during-drain' },
    );
    await effectStarted;
    eligible = false;
    releaseEffect();

    await expect(pending).resolves.toBeNull();
    expect(recoveries).not.toHaveBeenCalled();
    expect(
      raw
        .prepare(`SELECT state, payload IS NOT NULL AS hasPayload FROM incoming_event_queue`)
        .get(),
    ).toEqual({ state: 'pending', hasPayload: 1 });
  });

  it('does not enqueue after an account lease becomes stale during hashing', async () => {
    const { db, raw } = await createTestDb();
    let current = true;
    let release!: () => void;
    let calls = 0;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        if (calls++ === 0) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return digest.sha256(input);
      },
    };
    const { dispatcher, effects } = wire(db, raw, { digest: gatedDigest });
    const context: EventDeliveryContext = { generation: 1, isCurrent: () => current };
    const pending = dispatcher.handle('new-message', rawMessage('stale-hash'), 'fcm', context);
    await Promise.resolve();
    current = false;
    release();
    await expect(pending).resolves.toBeNull();
    expect(effects).toHaveLength(0);
    expect(
      (raw.prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue`).get() as { count: number })
        .count,
    ).toBe(0);
  });
});
