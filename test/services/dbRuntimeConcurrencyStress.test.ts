import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { InMemoryVault } from '@core/secure';
import { rotateDbKey } from '@db/key';
import { withDbTransaction } from '@db/transaction';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { sendImageMessage } from '@/services/send/sendAttachmentService';
import { syncAllChats } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import {
  holdRollingBackDbNeighbour,
  observePromise,
  type ObservedPromise,
} from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

const NEW_KEY = '09'.repeat(32);

jest.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9),
}));

const dummyHttp = {} as HttpClient;
const IMAGE = {
  uri: 'file:///db02c-stress.jpg',
  name: 'db02c-stress.jpg',
  mimeType: 'image/jpeg',
  size: 1024,
  width: 800,
  height: 600,
};
const UPLOAD_CHAT_GUID = 'db02c-sync-upload-chat';
const DEADLINE_MS = 2_000;

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
  readonly released: () => boolean;
}

function gate(): Gate {
  let resolve!: () => void;
  let isReleased = false;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    release: () => {
      if (isReleased) return;
      isReleased = true;
      resolve();
    },
    released: () => isReleased,
  };
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} exceeded ${DEADLINE_MS}ms`)),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (await condition()) return;
    await nextTurn();
  }
  throw new Error(`${label} did not occur within 100 event-loop turns`);
}

function count(raw: Database.Database, statement: string, ...params: unknown[]): number {
  return (raw.prepare(statement).get(...params) as { count: number }).count;
}

function liveMessage(index: number): Message {
  return Message.parse({
    guid: `db02c-live-message-${index}`,
    text: `live ${index}`,
    dateCreated: 10_000 + index,
    handle: { address: `live-${index}@example.com` },
    chats: [
      {
        guid: `db02c-live-chat-${index}`,
        participants: [{ address: `live-${index}@example.com` }],
      },
    ],
  });
}

/**
 * DB-02C's aggregate host proof. This composes the real service/repository owners on one
 * better-sqlite3 connection; the injected upload and PRAGMA boundary prove lock lifetime but do
 * not claim native streaming or SQLCipher behavior, which remains Android-only evidence.
 */
describe('DB-02C mixed runtime concurrency', () => {
  it('isolates rollback while sync, live events, upload persistence, and rekey share one queue', async () => {
    const { db, raw } = await createTestDb();
    const vault = new InMemoryVault();
    await vault.set('dbEncryptionKey', 'OLD');

    const pageFetched = gate();
    const uploadEntered = gate();
    const uploadGate = gate();
    const rekeyEntered = gate();
    const rekeyGate = gate();
    const protectionRelease = jest.fn();
    const protect = jest
      .spyOn(attachmentCacheCoordinator, 'protect')
      .mockReturnValue({ path: IMAGE.uri, release: protectionRelease });
    const pragmas: string[] = [];
    const uploadTransactionStates: boolean[] = [];
    const rekeyTransactionStates: boolean[] = [];
    const retained: Promise<unknown>[] = [];
    const retain = <T>(promise: Promise<T>): ObservedPromise<T> => {
      const observed = observePromise(promise);
      retained.push(observed.promise);
      return observed;
    };

    const syncChats = Array.from({ length: 10 }, (_, index) =>
      Chat.parse({
        guid: index === 0 ? UPLOAD_CHAT_GUID : `db02c-sync-chat-${index}`,
        participants: [{ address: `sync-${index}@example.com` }],
      }),
    );
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async (offset) => {
        if (offset !== 0) return [];
        pageFetched.release();
        return syncChats;
      },
      fetchChatMessages: async () => [],
      fetchMessagesAfter: async () => [],
      fetchDeletedAfter: async () => [],
    };
    const sink = new DbEventSink(db);
    const neighbour = holdRollingBackDbNeighbour(
      db,
      async () => {
        await db.run(sql`INSERT INTO kv (key, value) VALUES ('db02c-doomed', 'rollback')`);
      },
      'db02c mixed neighbour rollback',
    );

    let syncRun: ObservedPromise<Awaited<ReturnType<typeof syncAllChats>>> | undefined;
    let sendRun: ObservedPromise<Awaited<ReturnType<typeof sendImageMessage>>> | undefined;
    let rotationRun: ObservedPromise<void> | undefined;
    let ninthLiveRun: ObservedPromise<void> | undefined;
    const firstLiveRuns: ObservedPromise<void>[] = [];

    try {
      await deadline(neighbour.entered, 'rolling-back neighbour entry');

      // syncAllChats submits its first five-chat owner before the other production paths.
      syncRun = retain(syncAllChats(db, api, 10));
      await deadline(pageFetched.promise, 'sync page fetch');
      await nextTurn();

      for (let index = 0; index < 8; index += 1) {
        firstLiveRuns.push(
          retain(sink.onEvent({ type: 'new-message', message: liveMessage(index) }, 'socket')),
        );
      }

      sendRun = retain(
        sendImageMessage(
          db,
          dummyHttp,
          { chatGuid: UPLOAD_CHAT_GUID, image: IMAGE },
          async () => {
            uploadTransactionStates.push(raw.inTransaction);
            uploadEntered.release();
            await uploadGate.promise;
            return { guid: 'db02c-real-attachment-message', viaPrivateApi: true };
          },
          20_000,
        ),
      );
      rotationRun = retain(
        rotateDbKey(vault, {
          execute: async (statement) => {
            pragmas.push(statement);
            rekeyTransactionStates.push(raw.inTransaction);
            rekeyEntered.release();
            await rekeyGate.promise;
          },
        }),
      );

      await waitFor(
        async () => (await vault.get('dbEncryptionKeyPending')) === NEW_KEY,
        'key staging',
      );
      await nextTurn();

      // Every production promise has reached the held wave, but none may write as a bystander in
      // the neighbour that is about to roll back.
      expect(syncRun.settled()).toBe(false);
      expect(firstLiveRuns.every((run) => !run.settled())).toBe(true);
      expect(sendRun.settled()).toBe(false);
      expect(rotationRun.settled()).toBe(false);
      expect(pragmas).toEqual([]);
      expect(uploadEntered.released()).toBe(false);
      expect(protectionRelease).not.toHaveBeenCalled();
      expect(raw.inTransaction).toBe(true);
      expect(count(raw, `SELECT COUNT(*) count FROM kv WHERE key='db02c-doomed'`)).toBe(1);
      expect(count(raw, `SELECT COUNT(*) count FROM chats WHERE guid LIKE 'db02c-%'`)).toBe(0);
      expect(count(raw, `SELECT COUNT(*) count FROM messages WHERE guid LIKE 'db02c-%'`)).toBe(0);

      neighbour.release();
      const neighbourOutcome = await deadline(neighbour.outcome, 'rolling-back neighbour outcome');
      expect(neighbourOutcome.status).toBe('rolled-back');
      if (neighbourOutcome.status === 'rolled-back') {
        expect(neighbourOutcome.error).toEqual(new Error('db02c mixed neighbour rollback'));
      }
      expect(count(raw, `SELECT COUNT(*) count FROM kv WHERE key='db02c-doomed'`)).toBe(0);

      // Send construction commits and releases its source before the injected upload waits. Rekey
      // then owns the queue exclusively while sync slice 2 and a ninth live event remain behind it.
      await deadline(
        Promise.all([uploadEntered.promise, rekeyEntered.promise]),
        'upload and rekey entry',
      );
      ninthLiveRun = retain(
        sink.onEvent({ type: 'new-message', message: liveMessage(8) }, 'socket'),
      );
      await nextTurn();

      expect(uploadGate.released()).toBe(false);
      expect(sendRun.settled()).toBe(false);
      expect(rotationRun.settled()).toBe(false);
      expect(syncRun.settled()).toBe(false);
      expect(ninthLiveRun.settled()).toBe(false);
      expect(uploadTransactionStates).toEqual([false]);
      expect(rekeyTransactionStates).toEqual([false]);
      expect(protectionRelease).toHaveBeenCalledTimes(1);
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, `SELECT COUNT(*) count FROM chats WHERE guid LIKE 'db02c-sync-%'`)).toBe(5);
      expect(
        count(raw, `SELECT COUNT(*) count FROM messages WHERE guid LIKE 'db02c-live-message-%'`),
      ).toBe(8);
      expect(count(raw, `SELECT COUNT(*) count FROM outgoing_queue`)).toBe(1);

      rekeyGate.release();
      await deadline(rotationRun.promise, 'key rotation completion');
      const storedChats = await deadline(syncRun.promise, 'sync completion');
      await deadline(
        Promise.all([...firstLiveRuns.map((run) => run.promise), ninthLiveRun.promise]),
        'live-event completion',
      );

      expect(storedChats).toHaveLength(10);
      expect(sendRun.settled()).toBe(false);
      expect(uploadGate.released()).toBe(false);
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, `SELECT COUNT(*) count FROM chats WHERE guid LIKE 'db02c-sync-%'`)).toBe(
        10,
      );
      expect(
        count(raw, `SELECT COUNT(*) count FROM messages WHERE guid LIKE 'db02c-live-message-%'`),
      ).toBe(9);

      uploadGate.release();
      const sent = await deadline(sendRun.promise, 'attachment settlement');

      expect(
        count(
          raw,
          `SELECT COUNT(*) count FROM messages WHERE guid='db02c-real-attachment-message'`,
        ),
      ).toBe(1);
      expect(count(raw, `SELECT COUNT(*) count FROM messages WHERE guid=?`, sent.tempGuid)).toBe(0);
      expect(
        count(
          raw,
          `SELECT COUNT(*) count
             FROM attachments a
             JOIN messages m ON m.id = a.message_id
            WHERE m.guid='db02c-real-attachment-message' AND a.local_path=?`,
          IMAGE.uri,
        ),
      ).toBe(1);
      expect(count(raw, `SELECT COUNT(*) count FROM outgoing_queue`)).toBe(0);
      expect(pragmas).toEqual([`PRAGMA rekey = '${NEW_KEY}'`]);
      expect(await vault.get('dbEncryptionKey')).toBe(NEW_KEY);
      expect(await vault.get('dbEncryptionKeyPending')).toBeNull();

      await deadline(
        withDbTransaction(db, async () => {
          await db.run(sql`INSERT INTO kv (key, value) VALUES ('db02c-sentinel', 'committed')`);
        }),
        'final sentinel transaction',
      );
      expect(count(raw, `SELECT COUNT(*) count FROM kv WHERE key='db02c-sentinel'`)).toBe(1);
      expect(raw.inTransaction).toBe(false);
    } finally {
      neighbour.release();
      rekeyGate.release();
      uploadGate.release();
      try {
        await deadline(neighbour.cleanup(), 'neighbour cleanup');
        await deadline(Promise.allSettled(retained), 'mixed-wave cleanup');
      } finally {
        protect.mockRestore();
        if (raw.open) raw.close();
      }
    }
  });
});
