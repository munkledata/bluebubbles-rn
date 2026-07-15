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
import type { AppDatabase } from '@db/types';
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
                  lastMessage: { guid: 'lm-mine', text: 'my preview', dateCreated: 600, isFromMe: true },
                }),
              ]
            : [],
      }),
    );
    expect(stored.map((s) => s.guid).sort()).toEqual(['cMine', 'cRecv']);

    const cRecv = (await listChats(db)) as Array<{ id: number; guid: string; latestMessageDate: number | null }>;
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
          offset === 0 ? [Chat.parse({ guid: 'cEmpty', participants: [{ address: 'a@x.com' }] })] : [],
      }),
    );
    expect(stored).toEqual([{ guid: 'cEmpty', chatId: (await getChatIdByGuid(db, 'cEmpty'))! }]);
    expect(await listMessages(db, stored[0]!.chatId)).toHaveLength(0);
  });
});

describe('syncChatMessages — on-demand backfill', () => {
  it('returns 0 when the chat is not synced yet (nothing to attach to)', async () => {
    const { db } = await createTestDb();
    expect(await syncChatMessages(db, api({}), 'unknown-chat')).toBe(0);
  });

  it('pages a synced chat’s messages and stops at the cap', async () => {
    const { db } = await createTestDb();
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid: 'cBk', participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, 'cBk'))!;

    const pages: Record<number, Message[]> = {
      0: [
        Message.parse({ guid: 'b1', text: 'one', dateCreated: 1, handle: { address: 'a@x.com' } }),
        Message.parse({ guid: 'b2', text: 'two', dateCreated: 2, handle: { address: 'a@x.com' } }),
      ],
      2: [
        Message.parse({ guid: 'b3', text: 'three', dateCreated: 3, handle: { address: 'a@x.com' } }),
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
    await upsertChats(db, [Chat.parse({ guid: 'cRcs', participants: [{ address: 'a@x.com' }] })], hm);
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
});
