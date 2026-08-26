/**
 * Branch top-ups for src/services/sync/engine.ts — the two paths syncEngine.test.ts doesn't
 * reach: syncAllChats persisting each chat's embedded `lastMessage` (so message-less chats,
 * notably RCS, still get a preview + date), and syncChatMessages (on-demand per-chat backfill,
 * incl. its not-synced guard, page cap, and the sync-safe optimistic-attachment reconcile).
 */
import { Chat, Message } from '@core/models';
import {
  getChatIdByGuid,
  insertOutgoingAttachment,
  listAttachmentsByMessageIds,
  listChats,
  listMessages,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { syncAllChats, syncChatMessages } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

/** A SyncApi whose message/chat fetchers are provided; unused ones are inert stubs. */
function api(over: Partial<SyncApi>): SyncApi {
  return {
    serverVersion: async () => '1.9.0',
    fetchChats: async () => [],
    fetchChatMessages: async () => [],
    fetchMessagesAfter: async () => [],
    fetchDeletedAfter: async () => [],
    ...over,
  };
}

describe('syncAllChats — embedded lastMessage', () => {
  it('stores each chat + its lastMessage, giving even a message-less chat a preview + date', async () => {
    const { db } = await createTestDb();
    const stored = await syncAllChats(
      db,
      api({
        fetchChats: async (offset) =>
          offset === 0
            ? [
                Chat.parse({
                  guid: 'cRecv',
                  participants: [{ address: 'a@x.com' }],
                  lastMessage: {
                    guid: 'lm-recv',
                    text: 'incoming preview',
                    dateCreated: 500,
                    handle: { address: 'a@x.com' },
                  },
                }),
                Chat.parse({
                  guid: 'cMine',
                  participants: [{ address: 'b@x.com' }],
                  // is-from-me lastMessage exercises the reconcileOutgoingAttachmentByContent call.
                  lastMessage: {
                    guid: 'lm-mine',
                    text: 'my preview',
                    dateCreated: 600,
                    isFromMe: true,
                  },
                }),
              ]
            : [],
      }),
    );
    expect(stored.map((s) => s.guid).sort()).toEqual(['cMine', 'cRecv']);

    const cRecv = (await listChats(db)) as Array<{
      id: number;
      guid: string;
      latestMessageDate: number | null;
    }>;
    const recv = cRecv.find((c) => c.guid === 'cRecv')!;
    expect(await listMessages(db, recv.id)).toHaveLength(1); // lastMessage materialized
    expect(recv.latestMessageDate).toBe(500); // denormalized preview date refreshed
  });

  it('handles a chat with NO lastMessage (nothing to upsert) without error', async () => {
    const { db } = await createTestDb();
    const stored = await syncAllChats(
      db,
      api({
        fetchChats: async (offset) =>
          offset === 0
            ? [Chat.parse({ guid: 'cEmpty', participants: [{ address: 'a@x.com' }] })]
            : [],
      }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      guid: 'cEmpty',
      chatId: (await getChatIdByGuid(db, 'cEmpty'))!,
      // The payload rides along so fullSync can re-apply this chat's read watermark once its
      // messages are backfilled (see reapplyReadWatermarks).
      chat: { guid: 'cEmpty' },
    });
    expect(await listMessages(db, stored[0]!.chatId)).toHaveLength(0);
  });
});

describe('syncChatMessages — on-demand backfill', () => {
  it('returns 0 when the chat is not synced yet (nothing to attach to)', async () => {
    const { db } = await createTestDb();
    expect(await syncChatMessages(db, api({}), 'unknown-chat')).toBe(0);
  });

  it('drops a fetched account-A page when its session is revoked before the DB write', async () => {
    const { db } = await createTestDb();
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cAbort', participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, 'cAbort'))!;
    let revoked = false;

    const total = await syncChatMessages(
      db,
      api({
        fetchChatMessages: async () => {
          revoked = true;
          return [
            Message.parse({
              guid: 'old-account-message',
              text: 'must not cross accounts',
              dateCreated: 1,
              handle: { address: 'old@example.com' },
            }),
          ];
        },
      }),
      'cAbort',
      { shouldAbort: () => revoked },
    );

    expect(total).toBe(0);
    expect(await listMessages(db, chatId)).toHaveLength(0);
  });

  it('pages a synced chat’s messages and stops at the cap', async () => {
    const { db } = await createTestDb();
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cBk', participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, 'cBk'))!;

    const pages: Record<number, Message[]> = {
      0: [
        Message.parse({ guid: 'b1', text: 'one', dateCreated: 1, handle: { address: 'a@x.com' } }),
        Message.parse({ guid: 'b2', text: 'two', dateCreated: 2, handle: { address: 'a@x.com' } }),
      ],
      2: [
        Message.parse({
          guid: 'b3',
          text: 'three',
          dateCreated: 3,
          handle: { address: 'a@x.com' },
        }),
        Message.parse({ guid: 'b4', text: 'four', dateCreated: 4, handle: { address: 'a@x.com' } }),
      ],
    };
    const total = await syncChatMessages(
      db,
      api({ fetchChatMessages: async (_g, offset) => pages[offset] ?? [] }),
      'cBk',
      { pageSize: 2, maxMessages: 3 }, // cap < a full second page → stops after page 2 via total>=cap
    );
    expect(total).toBe(4); // both full pages fetched, then the cap breaks the loop
    expect(await listMessages(db, chatId)).toHaveLength(4);
  });

  it('promotes an optimistic RCS picture in place on the sync path (local_path preserved, no dup)', async () => {
    const { db } = await createTestDb();
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cRcs', participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, 'cRcs'))!;
    // Optimistic outgoing picture (RCS: materialized by sync, not the live echo).
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-rcs',
      attachmentGuid: 'temp-rcs-att',
      chatId,
      chatGuid: 'cRcs',
      localPath: 'file:///rcs.jpg',
      mimeType: 'image/jpeg',
      transferName: 'rcs.jpg',
      totalBytes: 20,
      now: 1000,
    });
    // The sync read materializes the real RCS message (is-from-me, null text, near the temp's date).
    const total = await syncChatMessages(
      db,
      api({
        fetchChatMessages: async (_g, offset) =>
          offset === 0
            ? [
                Message.parse({
                  guid: 'rcs-real',
                  isFromMe: true,
                  dateCreated: 1000,
                  attachments: [{ guid: 'rcs-real-att', mimeType: 'image/jpeg' }],
                }),
              ]
            : [],
      }),
      'cRcs',
    );
    expect(total).toBe(1);
    const msgs = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    expect(msgs.map((m) => m.guid)).toEqual(['rcs-real']); // temp promoted in place, no duplicate
    const atts = (await listAttachmentsByMessageIds(db, [msgs[0]!.id])).get(msgs[0]!.id)!;
    expect(atts[0]!.guid).toBe('rcs-real-att');
    expect(atts[0]!.localPath).toBe('file:///rcs.jpg'); // on-disk image kept, no re-download
  });

  it('rolls back an RCS picture reconcile retired mid-owner, then lets a fresh sync retry', async () => {
    const { db, raw } = await createTestDb();
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cGuardedRcs', participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, 'cGuardedRcs'))!;
    const tempGuid = 'temp-guarded-rcs';
    const realGuid = 'rcs-real-guarded';
    await insertOutgoingAttachment(db, {
      tempGuid,
      attachmentGuid: `${tempGuid}-att`,
      chatId,
      chatGuid: 'cGuardedRcs',
      localPath: 'file:///guarded-rcs.jpg',
      mimeType: 'image/jpeg',
      transferName: 'guarded-rcs.jpg',
      totalBytes: 20,
      now: 1000,
    });
    const original = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    const echo = Message.parse({
      guid: realGuid,
      isFromMe: true,
      dateCreated: 1000,
      attachments: [{ guid: `${realGuid}-att`, mimeType: 'image/jpeg' }],
    });
    const syncApi = api({
      fetchChatMessages: async (_guid, offset) => (offset === 0 ? [echo] : []),
    });
    const queueCount = (): number =>
      (
        raw
          .prepare('SELECT COUNT(*) AS count FROM outgoing_queue WHERE temp_guid = ?')
          .get(tempGuid) as { count: number }
      ).count;
    const aliasTarget = (): string | undefined =>
      (
        raw
          .prepare(
            'SELECT canonical_guid AS canonicalGuid FROM message_guid_aliases WHERE alias_guid = ?',
          )
          .get(tempGuid) as { canonicalGuid: string } | undefined
      )?.canonicalGuid;

    let retired = false;
    let triggerRan = false;
    raw.function('retire_sync_chat_attachment', () => {
      triggerRan = true;
      retired = true;
      return 0;
    });
    raw.exec(`CREATE TRIGGER retire_sync_chat_attachment
      AFTER DELETE ON outgoing_queue
      WHEN OLD.temp_guid = '${tempGuid}'
      BEGIN SELECT retire_sync_chat_attachment(); END`);

    try {
      await expect(
        syncChatMessages(db, syncApi, 'cGuardedRcs', { shouldAbort: () => retired }),
      ).resolves.toBe(0);

      expect(triggerRan).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(queueCount()).toBe(1);
      expect(aliasTarget()).toBeUndefined();
      const rolledBack = (await listMessages(db, chatId)) as Array<{
        id: number;
        guid: string;
        sendState: string | null;
      }>;
      expect(rolledBack).toHaveLength(1);
      expect(rolledBack[0]).toMatchObject({
        id: original[0]!.id,
        guid: tempGuid,
        sendState: 'sending',
      });
      const rolledBackAttachments = (await listAttachmentsByMessageIds(db, [original[0]!.id])).get(
        original[0]!.id,
      )!;
      expect(rolledBackAttachments).toEqual([
        expect.objectContaining({ guid: `${tempGuid}-att`, localPath: 'file:///guarded-rcs.jpg' }),
      ]);

      raw.exec('DROP TRIGGER retire_sync_chat_attachment');
      retired = false;
      await expect(
        syncChatMessages(db, syncApi, 'cGuardedRcs', { shouldAbort: () => retired }),
      ).resolves.toBe(1);

      expect(queueCount()).toBe(0);
      expect(aliasTarget()).toBe(realGuid);
      const committed = (await listMessages(db, chatId)) as Array<{
        id: number;
        guid: string;
        sendState: string | null;
      }>;
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        id: original[0]!.id,
        guid: realGuid,
        sendState: 'sent',
      });
      const committedAttachments = (await listAttachmentsByMessageIds(db, [original[0]!.id])).get(
        original[0]!.id,
      )!;
      expect(committedAttachments).toEqual([
        expect.objectContaining({
          guid: `${realGuid}-att`,
          localPath: 'file:///guarded-rcs.jpg',
        }),
      ]);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS retire_sync_chat_attachment');
    }
  });
});
