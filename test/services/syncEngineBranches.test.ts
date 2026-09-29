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

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const rcsChatGuid = (sourceId: string): string =>
  `RCS;-;g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const rcsMessageGuid = (sourceId: string): string =>
  `rcs-g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const rcsAttachmentGuid = (messageId: string, mediaId: string): string =>
  `rcs-media-g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(messageId).toString('base64url')}.${Buffer.from(mediaId).toString('base64url')}`;
const RCS_PROVIDER_INFO = {
  rcs: true,
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: RCS_PROVIDER_EPOCH,
} as const;

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
    const chatGuid = rcsChatGuid('picture-chat');
    const messageGuid = rcsMessageGuid('picture-message');
    const attachmentGuid = rcsAttachmentGuid('picture-message', 'picture-media');
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: chatGuid, participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, chatGuid))!;
    // Optimistic outgoing picture (RCS: materialized by sync, not the live echo).
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-rcs',
      attachmentGuid: 'temp-rcs-att',
      chatId,
      chatGuid,
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
                  guid: messageGuid,
                  providerEpoch: RCS_PROVIDER_EPOCH,
                  isFromMe: true,
                  dateCreated: 1000,
                  attachments: [
                    {
                      guid: attachmentGuid,
                      providerEpoch: RCS_PROVIDER_EPOCH,
                      mimeType: 'image/jpeg',
                    },
                  ],
                }),
              ]
            : [],
      }),
      chatGuid,
      { rcsProviderInfo: RCS_PROVIDER_INFO },
    );
    expect(total).toBe(1);
    const msgs = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    expect(msgs.map((m) => m.guid)).toEqual([messageGuid]); // temp promoted in place, no duplicate
    const atts = (await listAttachmentsByMessageIds(db, [msgs[0]!.id])).get(msgs[0]!.id)!;
    expect(atts[0]!.guid).toBe(attachmentGuid);
    expect(atts[0]!.localPath).toBe('file:///rcs.jpg'); // on-disk image kept, no re-download
  });

  it('rolls back an RCS picture reconcile retired mid-owner, then lets a fresh sync retry', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = rcsChatGuid('guarded-picture-chat');
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: chatGuid, participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(db, chatGuid))!;
    const tempGuid = 'temp-guarded-rcs';
    const realGuid = rcsMessageGuid('guarded-picture-message');
    const realAttachmentGuid = rcsAttachmentGuid(
      'guarded-picture-message',
      'guarded-picture-media',
    );
    await insertOutgoingAttachment(db, {
      tempGuid,
      attachmentGuid: `${tempGuid}-att`,
      chatId,
      chatGuid,
      localPath: 'file:///guarded-rcs.jpg',
      mimeType: 'image/jpeg',
      transferName: 'guarded-rcs.jpg',
      totalBytes: 20,
      now: 1000,
    });
    const original = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    const echo = Message.parse({
      guid: realGuid,
      providerEpoch: RCS_PROVIDER_EPOCH,
      isFromMe: true,
      dateCreated: 1000,
      attachments: [
        {
          guid: realAttachmentGuid,
          providerEpoch: RCS_PROVIDER_EPOCH,
          mimeType: 'image/jpeg',
        },
      ],
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
        syncChatMessages(db, syncApi, chatGuid, {
          shouldAbort: () => retired,
          rcsProviderInfo: RCS_PROVIDER_INFO,
        }),
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
        syncChatMessages(db, syncApi, chatGuid, {
          shouldAbort: () => retired,
          rcsProviderInfo: RCS_PROVIDER_INFO,
        }),
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
          guid: realAttachmentGuid,
          localPath: 'file:///guarded-rcs.jpg',
        }),
      ]);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS retire_sync_chat_attachment');
    }
  });
});
