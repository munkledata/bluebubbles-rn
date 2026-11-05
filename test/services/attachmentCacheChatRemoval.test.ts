/**
 * "Remove this chat's downloaded files" goes through the coordinator's ordinary retirement owner:
 * the same in-memory gate, exact claim and native-delete settlement as inactive-file cleanup.
 */
import { getAttachmentCacheEntry } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  AttachmentCacheCoordinator,
  type AttachmentCacheNativeBoundary,
  type AttachmentCacheReservationScope,
} from '@/services/download/attachmentCacheCoordinator';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
} from '@/services/download/attachmentCacheQuotaPolicy';
import { createTestDb } from '../support/testDb';
import { recordAttachmentCacheEntry } from '../support/repositoryWrappers';

const NOW = 2_000_000;
const OLD = NOW - 20 * 60 * 1000;
const path = (name: string): string =>
  `file:///documents/attachments/media-${name}/generation-1/media-file.jpg`;

type Raw = Awaited<ReturnType<typeof createTestDb>>['raw'];

function nativeBoundary(raw: Raw) {
  const deleteTransactions: boolean[] = [];
  const deleteFile = jest.fn(async () => {
    deleteTransactions.push(raw.inTransaction);
    return { status: 'deleted' as const, bytes: 1 };
  });
  const io: AttachmentCacheNativeBoundary = {
    getAvailableBytes: jest
      .fn()
      .mockResolvedValue(ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES),
    statFile: jest.fn().mockResolvedValue({ exists: true, bytes: 1 }),
    deleteFile,
  };
  return { io, deleteFile, deleteTransactions };
}

function accountScope(): AttachmentCacheReservationScope & { revoke(): void } {
  let current = true;
  return {
    generation: 7,
    isCurrent: () => current,
    runTracked: <T>(task: () => Promise<T>) => (current ? task() : Promise.resolve(null)),
    revoke: () => {
      current = false;
    },
  };
}

/** Two chats, A and B, with one message each; returns a function that attaches files. */
async function seedChats(db: AppDatabase, raw: Raw) {
  raw.prepare(`INSERT INTO chats (guid) VALUES ('chat-a'), ('chat-b')`).run();
  const chatId = (guid: string) =>
    (raw.prepare('SELECT id FROM chats WHERE guid = ?').get(guid) as { id: number }).id;
  raw
    .prepare(
      `INSERT INTO messages (guid, chat_id, date_created) VALUES ('msg-a', ?, 1), ('msg-b', ?, 2)`,
    )
    .run(chatId('chat-a'), chatId('chat-b'));
  const messageId = (guid: string) =>
    (raw.prepare('SELECT id FROM messages WHERE guid = ?').get(guid) as { id: number }).id;
  return async (messageGuid: string, attachmentGuid: string, file: string): Promise<void> => {
    if (!(await getAttachmentCacheEntry(db, file))) {
      await withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: file, bytes: 10, lastUsedAt: OLD }),
      );
    }
    raw
      .prepare('INSERT INTO attachments (guid, message_id, local_path) VALUES (?, ?, ?)')
      .run(attachmentGuid, messageId(messageGuid), file);
  };
}

const localPathOf = (raw: Raw, guid: string) =>
  (
    raw.prepare('SELECT local_path AS p FROM attachments WHERE guid = ?').get(guid) as {
      p: unknown;
    }
  ).p;

describe('AttachmentCacheCoordinator.retireChatEntries', () => {
  it("deletes only the chat's own files, outside the transaction, and clears their paths", async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary(raw);
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const attach = await seedChats(db, raw);
    await attach('msg-a', 'a-own', path('a-own'));
    await attach('msg-a', 'a-shared', path('shared'));
    await attach('msg-b', 'b-shared', path('shared'));
    await attach('msg-b', 'b-own', path('b-own'));

    await expect(
      coordinator.retireChatEntries(db, { chatGuid: 'chat-a', scope: accountScope() }),
    ).resolves.toEqual({ status: 'complete', attempted: 1, confirmed: 1, failed: 0, skipped: 0 });

    expect(native.deleteFile.mock.calls).toEqual([[path('a-own')]]);
    expect(native.deleteTransactions).toEqual([false]);
    expect(await getAttachmentCacheEntry(db, path('a-own'))).toBeNull();
    expect(localPathOf(raw, 'a-own')).toBeNull(); // the message offers the download again
    // The shared copy and chat B's file are untouched.
    expect(localPathOf(raw, 'a-shared')).toBe(path('shared'));
    expect(localPathOf(raw, 'b-shared')).toBe(path('shared'));
    expect(localPathOf(raw, 'b-own')).toBe(path('b-own'));
    expect(await getAttachmentCacheEntry(db, path('b-own'))).toMatchObject({ state: 'active' });

    // Nothing of A's own is left: a repeat pass is empty.
    await expect(
      coordinator.retireChatEntries(db, { chatGuid: 'chat-a', scope: accountScope() }),
    ).resolves.toEqual({ status: 'complete', attempted: 0, confirmed: 0, failed: 0, skipped: 0 });
  });

  it('skips a file on screen and a file waiting to be sent', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary(raw);
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const attach = await seedChats(db, raw);
    await attach('msg-a', 'a-viewed', path('viewed'));
    await attach('msg-a', 'a-plain', path('plain'));
    // A live outgoing temp message in chat A with its own picture.
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created, is_from_me)
         VALUES ('temp-send', (SELECT id FROM chats WHERE guid = 'chat-a'), 3, 1)`,
      )
      .run();
    await attach('temp-send', 'a-sending', path('sending'));
    const pin = coordinator.protect(path('viewed'))!;

    const result = await coordinator.retireChatEntries(db, {
      chatGuid: 'chat-a',
      scope: accountScope(),
    });
    expect(result).toEqual({
      status: 'complete',
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 2,
    });
    expect(native.deleteFile.mock.calls).toEqual([[path('plain')]]);
    expect(localPathOf(raw, 'a-viewed')).toBe(path('viewed'));
    expect(localPathOf(raw, 'a-sending')).toBe(path('sending'));
    pin.release();
  });

  it('deletes nothing once the account is gone', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary(raw);
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const attach = await seedChats(db, raw);
    await attach('msg-a', 'a-own', path('a-own'));
    const scope = accountScope();
    scope.revoke();

    await expect(
      coordinator.retireChatEntries(db, { chatGuid: 'chat-a', scope }),
    ).resolves.toMatchObject({ status: 'stale', confirmed: 0 });
    expect(native.deleteFile).not.toHaveBeenCalled();
    expect(localPathOf(raw, 'a-own')).toBe(path('a-own'));
  });

  it('stops before the next native delete when the account goes mid-pass, and frees its paths', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary(raw);
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const attach = await seedChats(db, raw);
    await attach('msg-a', 'a-1', path('first'));
    await attach('msg-a', 'a-2', path('second'));
    // Disconnect lands just after the first file's delete is confirmed, before the second starts.
    let current = true;
    let revokeAfterNextTracked = false;
    const scope: AttachmentCacheReservationScope = {
      generation: 7,
      isCurrent: () => current,
      runTracked: async <T>(task: () => Promise<T>) => {
        if (!current) return null;
        const value = await task();
        if (revokeAfterNextTracked) current = false;
        return value;
      },
    };
    native.deleteFile.mockImplementationOnce(async () => {
      revokeAfterNextTracked = true;
      return { status: 'deleted' as const, bytes: 1 };
    });

    const result = await coordinator.retireChatEntries(db, { chatGuid: 'chat-a', scope });
    expect(result).toMatchObject({ status: 'stale', confirmed: 1 });
    expect(native.deleteFile.mock.calls).toEqual([[path('first')]]); // same age: path order
    // The path the pass never reached is not left "owned" in memory.
    const pin = coordinator.protect(path('second'));
    expect(pin).not.toBeNull();
    pin?.release();
  });
});
