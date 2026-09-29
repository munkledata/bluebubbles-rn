import type Database from 'better-sqlite3';
import { Message } from '@core/models';
import type { EventDeliveryContext } from '@core/realtime';
import { getSyncMarker, kvGet, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { IncomingEventDependencyPendingError } from '@/services/realtime/incomingEventErrors';
import { RcsProviderEpochEventSink } from '@/services/realtime/rcsProviderEpochEventSink';
import {
  DELETIONS_SYNCED_AT_KEY,
  DeletionSyncProtocolError,
  incrementalSync,
  syncDeletedMessages,
} from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

const EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const providerInfo = (epoch: string) => ({
  rcs: true,
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: epoch,
});
const chatGuid = (epoch: string): string => `RCS;-;g1.${epoch}.${encoded('conversation-a')}`;
const messageGuid = (epoch: string): string => `rcs-g1.${epoch}.${encoded('message-a')}`;

function rcsMessage(epoch: string, rowId = 1) {
  const owner = chatGuid(epoch);
  return Message.parse({
    originalROWID: rowId,
    guid: messageGuid(epoch),
    providerEpoch: epoch,
    chatGuid: owner,
    text: 'RCS message',
    dateCreated: 1_000 + rowId,
    chats: [{ guid: owner, providerEpoch: epoch }],
  });
}

const appleMessage = Message.parse({
  originalROWID: 10,
  guid: 'apple-message',
  chatGuid: 'iMessage;-;apple@example.com',
  text: 'Apple message',
  dateCreated: 2_000,
  chats: [{ guid: 'iMessage;-;apple@example.com' }],
});

function syncApi(messages: Message[]): SyncApi {
  return {
    serverVersion: async () => '2.0.0',
    fetchChats: async () => [],
    fetchChatMessages: async () => [],
    fetchMessagesAfter: async () => messages,
    fetchDeletedAfter: async () => [],
  };
}

function messageCount(raw: Database.Database): number {
  return (raw.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count;
}

function durableContext(): EventDeliveryContext {
  return {
    generation: 1,
    isCurrent: () => true,
    durableEvent: {
      dbAppliedAt: null,
      markDbAppliedWithinTransaction: async () => undefined,
    },
  };
}

async function seedOptimisticRcsMessage(db: AppDatabase, guid: string): Promise<void> {
  const owner = chatGuid(EPOCH_A);
  const handles = await upsertHandles(db, [{ address: '+15550000001', service: 'RCS' }]);
  const chatMap = await upsertChats(
    db,
    [
      {
        guid: owner,
        providerEpoch: EPOCH_A,
        participants: [{ address: '+15550000001', service: 'RCS' }],
      },
    ],
    handles,
  );
  const message = Message.parse({ guid, chatGuid: owner, text: 'optimistic', chats: [] });
  await upsertMessages(db, [message], () => chatMap.get(owner), handles);
}

describe('RCS provider-epoch ingestion admission', () => {
  it('revokes the downstream delivery context when the provider epoch rotates mid-event', async () => {
    let liveInfo = providerInfo(EPOCH_A);
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const postCommitEffect = jest.fn();
    let innerContext: EventDeliveryContext | undefined;
    const sink = new RcsProviderEpochEventSink(
      {
        onEvent: async (_event, _source, context) => {
          innerContext = context;
          markStarted();
          await gate;
          if (context?.isCurrent()) postCommitEffect();
        },
      },
      () => liveInfo,
    );

    const pending = sink.onEvent(
      { type: 'new-message', message: rcsMessage(EPOCH_A) },
      'socket',
      durableContext(),
    );
    await started;
    liveInfo = providerInfo(EPOCH_B);
    release();
    await pending;

    expect(postCommitEffect).not.toHaveBeenCalled();
    expect(innerContext?.isCurrent()).toBe(false);
    liveInfo = providerInfo(EPOCH_A);
    expect(innerContext?.isCurrent()).toBe(false);
  });

  it('drops stale live rows before DB and defers a current row while provider authority is unavailable', async () => {
    const { db, raw } = await createTestDb();
    const staleSink = new DbEventSink(db, undefined, undefined, undefined, () =>
      providerInfo(EPOCH_A),
    );

    await staleSink.onEvent({ type: 'new-message', message: rcsMessage(EPOCH_B) }, 'socket');
    expect(messageCount(raw)).toBe(0);

    const unavailableSink = new DbEventSink(db, undefined, undefined, undefined, () => null);
    await expect(
      unavailableSink.onEvent(
        { type: 'new-message', message: rcsMessage(EPOCH_A) },
        'fcm',
        durableContext(),
      ),
    ).rejects.toBeInstanceOf(IncomingEventDependencyPendingError);
    expect(messageCount(raw)).toBe(0);
  });

  it('rolls back the RCS event transaction and suppresses post-commit effects when the epoch rotates mid-write', async () => {
    const { db, raw } = await createTestDb();
    let liveInfo = providerInfo(EPOCH_A);
    const stored = jest.fn();
    const retired = jest.fn();
    raw.function('rotate_rcs_provider_epoch', () => {
      liveInfo = providerInfo(EPOCH_B);
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER rotate_rcs_provider_epoch_after_message
      AFTER INSERT ON messages
      WHEN NEW.guid = '${messageGuid(EPOCH_A)}'
      BEGIN
        SELECT rotate_rcs_provider_epoch();
      END
    `);
    const sink = new DbEventSink(db, stored, retired, undefined, () => liveInfo);

    await expect(
      sink.onEvent({ type: 'new-message', message: rcsMessage(EPOCH_A) }, 'socket'),
    ).resolves.toBeUndefined();

    expect(messageCount(raw)).toBe(0);
    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM chats').get() as { count: number }).count,
    ).toBe(0);
    expect(stored).not.toHaveBeenCalled();
    expect(retired).not.toHaveBeenCalled();
  });

  it('resolves temp-only send-error ownership and never mutates an RCS row without current authority and scoped chat proof', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-rcs-send-error';
    await seedOptimisticRcsMessage(db, tempGuid);
    const event = {
      type: 'message-send-error' as const,
      payload: { tempGuid, error: 1 },
    };

    const unavailableSink = new DbEventSink(db, undefined, undefined, undefined, () => null);
    await expect(unavailableSink.onEvent(event, 'fcm', durableContext())).rejects.toBeInstanceOf(
      IncomingEventDependencyPendingError,
    );

    const currentSink = new DbEventSink(db, undefined, undefined, undefined, () =>
      providerInfo(EPOCH_A),
    );
    await expect(currentSink.onEvent(event, 'socket')).resolves.toBeUndefined();
    expect(raw.prepare('SELECT error FROM messages WHERE guid = ?').get(tempGuid)).toEqual({
      error: 0,
    });
  });

  it('uses promoted aliases and queue ownership before admitting an RCS send-error mutation', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-promoted-rcs-send-error';
    const canonicalGuid = messageGuid(EPOCH_A);
    const owner = chatGuid(EPOCH_A);
    await seedOptimisticRcsMessage(db, canonicalGuid);
    raw
      .prepare(
        'INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid) VALUES (?, ?, ?)',
      )
      .run(tempGuid, canonicalGuid, owner);
    raw
      .prepare(
        `INSERT INTO outgoing_queue
           (temp_guid, chat_guid, kind, payload, attempts, next_retry_at)
         VALUES (?, ?, 'text', '{}', 0, 0)`,
      )
      .run(tempGuid, owner);
    const tempOnly = {
      type: 'message-send-error' as const,
      payload: { tempGuid, error: 22 },
    };

    const unavailable = new DbEventSink(db, undefined, undefined, undefined, () => null);
    await expect(unavailable.onEvent(tempOnly, 'fcm', durableContext())).rejects.toBeInstanceOf(
      IncomingEventDependencyPendingError,
    );

    const stale = new DbEventSink(db, undefined, undefined, undefined, () => providerInfo(EPOCH_B));
    await stale.onEvent(tempOnly, 'socket');
    const current = new DbEventSink(db, undefined, undefined, undefined, () =>
      providerInfo(EPOCH_A),
    );
    await current.onEvent(tempOnly, 'socket');
    expect(raw.prepare('SELECT error FROM messages WHERE guid = ?').get(canonicalGuid)).toEqual({
      error: 0,
    });
    expect(
      raw.prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid),
    ).toEqual({ attempts: 0 });

    await current.onEvent(
      {
        type: 'message-send-error',
        payload: { tempGuid, messageGuid: canonicalGuid, chatGuid: owner, error: 22 },
      },
      'socket',
    );
    expect(raw.prepare('SELECT error FROM messages WHERE guid = ?').get(canonicalGuid)).toEqual({
      error: 22,
    });
    expect(
      raw.prepare('SELECT attempts FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid),
    ).toEqual({ attempts: 1 });
  });

  it('filters legacy RCS from an old-server mixed page but rejects epoch drift without cursor writes', async () => {
    const legacyRcs = Message.parse({
      originalROWID: 11,
      guid: 'rcs-legacy-message',
      chatGuid: 'RCS;-;legacy-chat',
      dateCreated: 2_001,
      chats: [{ guid: 'RCS;-;legacy-chat' }],
    });
    const compatible = await createTestDb();
    await expect(
      incrementalSync(compatible.db, syncApi([appleMessage, legacyRcs]), {
        serverVersion: '2.0.0',
        maxPages: 1,
      }),
    ).resolves.toEqual({ chats: 1, messages: 1 });
    expect(messageCount(compatible.raw)).toBe(1);

    const rotated = await createTestDb();
    const before = await getSyncMarker(rotated.db);
    await expect(
      incrementalSync(rotated.db, syncApi([appleMessage, rcsMessage(EPOCH_B, 12)]), {
        serverVersion: '2.0.0',
        maxPages: 1,
        rcsProviderInfo: providerInfo(EPOCH_A),
      }),
    ).rejects.toThrow('captured Google pairing epoch');
    expect(messageCount(rotated.raw)).toBe(0);
    expect(await getSyncMarker(rotated.db)).toEqual(before);
  });

  it('rejects an ownerless qualified RCS REST row without storing the mixed page or advancing its cursor', async () => {
    const ownerless = Message.parse({
      originalROWID: 13,
      guid: messageGuid(EPOCH_A),
      providerEpoch: EPOCH_A,
      chatGuid: chatGuid(EPOCH_A),
      text: 'owner omitted',
      dateCreated: 2_003,
    });
    const { db, raw } = await createTestDb();
    const before = await getSyncMarker(db);

    await expect(
      incrementalSync(db, syncApi([appleMessage, ownerless]), {
        serverVersion: '2.0.0',
        maxPages: 1,
        rcsProviderInfo: providerInfo(EPOCH_A),
      }),
    ).rejects.toThrow('captured Google pairing epoch');

    expect(messageCount(raw)).toBe(0);
    expect(await getSyncMarker(db)).toEqual(before);
  });

  it('does not tombstone or advance the deletion cursor for a different provider epoch', async () => {
    const { db, raw } = await createTestDb();
    const staleOwner = chatGuid(EPOCH_B);
    const api: SyncApi = {
      ...syncApi([]),
      fetchDeletedAfter: async () => [
        {
          guid: messageGuid(EPOCH_B),
          chatGuid: staleOwner,
          dateDeleted: 4_000,
        },
      ],
    };

    const outcome = syncDeletedMessages(db, api, {
      supported: true,
      rcsProviderInfo: providerInfo(EPOCH_A),
    });
    await expect(outcome).rejects.toMatchObject<Partial<DeletionSyncProtocolError>>({
      code: 'rcs-provider-epoch-mismatch',
    });
    expect(
      (
        raw.prepare('SELECT COUNT(*) AS count FROM message_deletion_ledger').get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBeNull();
  });
});
