import { sql } from 'drizzle-orm';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { withDbTransaction, withDbWriteLock } from '@db/transaction';
import type {
  AppDatabase,
  DbRuntimeConcurrencyWaveChecks,
  DbRuntimeConcurrencyWaveOptions,
} from '@db/types';
import { DbEventSink } from '../realtime/dbEventSink';
import { sendImageMessage } from '../send/sendAttachmentService';
import { syncAllChats } from '../sync/engine';
import type { SyncApi } from '../sync/types';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface ObservedPromise<T> {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
}

interface UploadIdentity {
  readonly tempGuid: string;
  readonly attachmentGuid: string;
}

const PREFIX = 'gator-db-runtime-wave';
const UPLOAD_CHAT_GUID = `${PREFIX}-sync-chat-0`;
const UPLOAD_PATH = `file:///${PREFIX}-attachment.jpg`;
const UPLOAD_REAL_GUID = `${PREFIX}-attachment-message`;
const ROLLBACK_KEY = `${PREFIX}-rollback`;
const COMMITTED_KEY = `${PREFIX}-committed`;
const SUCCESSOR_KEY = `${PREFIX}-successor`;
const SENTINEL_KEY = `${PREFIX}-sentinel`;
const ROLLBACK_SIGNAL = Symbol('db-runtime-wave-rollback');

const dummyHttp = {} as HttpClient;
const uploadImage = {
  uri: UPLOAD_PATH,
  name: `${PREFIX}-attachment.jpg`,
  mimeType: 'image/jpeg',
  size: 1_024,
  width: 800,
  height: 600,
};

function deferred(): Deferred {
  let settled = false;
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      settle();
    },
  };
}

function observe<T>(promise: Promise<T>): ObservedPromise<T> {
  let isSettled = false;
  const observed = promise.then(
    (value) => {
      isSettled = true;
      return value;
    },
    (error: unknown) => {
      isSettled = true;
      throw error;
    },
  );
  void observed.catch(() => undefined);
  return { promise: observed, settled: () => isSettled };
}

function syncChat(index: number): Chat {
  return Chat.parse({
    guid: `${PREFIX}-sync-chat-${index}`,
    // Empty by design: contact linking is a separate post-commit read/write path and is not part
    // of this disposable database lifetime proof.
    participants: [],
  });
}

function liveMessage(index: number): Message {
  return Message.parse({
    guid: `${PREFIX}-live-message-${index}`,
    text: `synthetic live message ${index}`,
    dateCreated: 10_000 + index,
    chats: [
      {
        guid: `${PREFIX}-live-chat-${index}`,
        // Keep the post-commit contact-link branch on its reviewed empty-input return path.
        participants: [],
      },
    ],
  });
}

function syncApi(chats: Chat[]): SyncApi {
  return {
    serverVersion: async () => '1.9.0',
    fetchChats: async (offset) => (offset === 0 ? chats : []),
    fetchChatMessages: async () => [],
    fetchMessagesAfter: async () => [],
    fetchDeletedAfter: async () => [],
  };
}

async function count(db: AppDatabase, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.all<{ count: number }>(statement);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Submit four owners without yielding so their process-wide queue order is deterministic.
 * Callbacks contain only bounded database work; the upload gate is outside this helper.
 */
function submitOrderedCoordinatorWave(db: AppDatabase, rawRekey: () => Promise<void>) {
  let rollbackObserved = false;
  let rollbackAbsentBeforeCommit = false;
  let committedWriterFinished = false;
  let rekeyEntered = false;
  let rekeyFinished = false;
  let rekeyApplied = false;
  let rekeyExclusive = false;
  let syncFirstChunkBeforeRekey = false;
  let liveMessagesBlockedAtRekey = false;
  let successorEntered = false;
  let successorWaitedForRekey = false;

  const rollback = withDbTransaction(db, async () => {
    await db.run(sql`INSERT INTO kv (key, value) VALUES (${ROLLBACK_KEY}, 'rollback')`);
    throw ROLLBACK_SIGNAL;
  }).then(
    () => false,
    (error: unknown) => {
      rollbackObserved = error === ROLLBACK_SIGNAL;
      return rollbackObserved;
    },
  );
  const committed = withDbTransaction(db, async () => {
    rollbackAbsentBeforeCommit =
      (await count(db, sql`SELECT COUNT(*) AS count FROM kv WHERE key = ${ROLLBACK_KEY}`)) === 0;
    await db.run(sql`INSERT INTO kv (key, value) VALUES (${COMMITTED_KEY}, 'committed')`);
    committedWriterFinished = true;
  });
  const rekeyRun = withDbWriteLock(async () => {
    rekeyEntered = true;
    rekeyExclusive = committedWriterFinished && !successorEntered;
    try {
      syncFirstChunkBeforeRekey =
        (await count(
          db,
          sql`SELECT COUNT(*) AS count FROM chats WHERE guid LIKE ${`${PREFIX}-sync-chat-%`}`,
        )) === 5;
      liveMessagesBlockedAtRekey =
        (await count(
          db,
          sql`SELECT COUNT(*) AS count FROM messages WHERE guid LIKE ${`${PREFIX}-live-message-%`}`,
        )) === 0;
      await rawRekey();
      rekeyApplied = true;
    } catch {
      // The result remains false. Never retain or emit a native error that may contain a path/key.
      rekeyApplied = false;
    } finally {
      rekeyFinished = true;
    }
  });
  const successor = withDbTransaction(db, async () => {
    successorEntered = true;
    successorWaitedForRekey = rekeyEntered && rekeyFinished;
    await db.run(sql`INSERT INTO kv (key, value) VALUES (${SUCCESSOR_KEY}, 'resumed')`);
  });

  return {
    rollback,
    committed,
    rekeyRun,
    successor,
    state: () => ({
      rollbackObserved,
      rollbackAbsentBeforeCommit,
      rekeyApplied,
      rekeyExclusive,
      syncFirstChunkBeforeRekey,
      liveMessagesBlockedAtRekey,
      successorWaitedForRekey,
    }),
  };
}

/**
 * Run the reusable DB-02C concurrency wave against a fresh disposable database.
 *
 * All content is fixed synthetic data. No network or filesystem API is touched here; the caller
 * injects the disposable SQLCipher rekey operation, and send-outcome OS notices are explicitly
 * suppressed. The only deliberately held await is the injected upload, after its optimistic rows
 * have committed and released the writer queue.
 */
export async function runDbRuntimeConcurrencyWave(
  db: AppDatabase,
  options: DbRuntimeConcurrencyWaveOptions,
): Promise<DbRuntimeConcurrencyWaveChecks> {
  const uploadEntered = deferred();
  const releaseUpload = deferred();
  const retained: Promise<unknown>[] = [];
  let uploadIdentity: UploadIdentity | undefined;
  let sendRun: ObservedPromise<Awaited<ReturnType<typeof sendImageMessage>>> | undefined;

  try {
    const chats = Array.from({ length: 10 }, (_, index) => syncChat(index));
    // Seed only the upload owner. The ten-row call below remains the measured two-slice sync.
    await syncAllChats(db, syncApi([chats[0]!]), 1);

    sendRun = observe(
      sendImageMessage(
        db,
        dummyHttp,
        { chatGuid: UPLOAD_CHAT_GUID, image: uploadImage },
        async ({ tempGuid, attachmentGuid }) => {
          uploadIdentity = { tempGuid, attachmentGuid };
          uploadEntered.resolve();
          await releaseUpload.promise;
          return { guid: UPLOAD_REAL_GUID, viaPrivateApi: true };
        },
        20_000,
        undefined,
        { failureNoticeMode: 'suppressed' },
      ),
    );
    retained.push(sendRun.promise);
    await uploadEntered.promise;

    const identity = uploadIdentity;
    if (identity === undefined) throw new Error('disposable database runtime wave upload missing');
    const attachmentConstruction =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM messages WHERE guid = ${identity.tempGuid}`,
      )) === 1 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM attachments WHERE guid = ${identity.attachmentGuid} AND local_path = ${UPLOAD_PATH}`,
      )) === 1 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM outgoing_queue WHERE temp_guid = ${identity.tempGuid}`,
      )) === 1;

    const syncRun = syncAllChats(db, syncApi(chats), 10);
    retained.push(syncRun);
    // The resolved in-memory fetch resumes before this continuation, so slice one owns the queue
    // before the four calls below claim their slots synchronously.
    await Promise.resolve();
    const ordered = submitOrderedCoordinatorWave(db, options.rawRekey);
    retained.push(ordered.rollback, ordered.committed, ordered.rekeyRun, ordered.successor);

    const sink = new DbEventSink(db);
    const liveRuns = Array.from({ length: 9 }, (_, index) =>
      sink.onEvent({ type: 'new-message', message: liveMessage(index) }, 'socket'),
    );
    retained.push(...liveRuns);

    const [storedChats] = await Promise.all([
      syncRun,
      ordered.rollback,
      ordered.committed,
      ordered.rekeyRun,
      ordered.successor,
      Promise.all(liveRuns),
    ]);
    const orderedState = ordered.state();
    const rollbackIsolation =
      orderedState.rollbackObserved &&
      orderedState.rollbackAbsentBeforeCommit &&
      (await count(db, sql`SELECT COUNT(*) AS count FROM kv WHERE key = ${ROLLBACK_KEY}`)) === 0;
    const syncChunks =
      orderedState.syncFirstChunkBeforeRekey &&
      storedChats.length === 10 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM chats WHERE guid LIKE ${`${PREFIX}-sync-chat-%`}`,
      )) === 10;
    const liveMessages =
      orderedState.liveMessagesBlockedAtRekey &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM messages WHERE guid LIKE ${`${PREFIX}-live-message-%`}`,
      )) === 9;
    const uploadOutsideDbOwner = !sendRun.settled();
    const queuedWritersResumed =
      (await count(db, sql`SELECT COUNT(*) AS count FROM kv WHERE key = ${SUCCESSOR_KEY}`)) === 1 &&
      syncChunks &&
      liveMessages;

    releaseUpload.resolve();
    const sent = await sendRun.promise;
    const uploadSettlement =
      sent.tempGuid === identity.tempGuid &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM messages WHERE guid = ${UPLOAD_REAL_GUID}`,
      )) === 1 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM messages WHERE guid = ${identity.tempGuid}`,
      )) === 0 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count
              FROM attachments a
              JOIN messages m ON m.id = a.message_id
             WHERE m.guid = ${UPLOAD_REAL_GUID} AND a.local_path = ${UPLOAD_PATH}`,
      )) === 1;
    const queueDrained =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM outgoing_queue WHERE temp_guid = ${identity.tempGuid}`,
      )) === 0;

    await withDbTransaction(db, async () => {
      await db.run(sql`INSERT INTO kv (key, value) VALUES (${SENTINEL_KEY}, 'committed')`);
    });
    const sentinelCommit =
      (await count(db, sql`SELECT COUNT(*) AS count FROM kv WHERE key = ${SENTINEL_KEY}`)) === 1;

    return {
      rollbackIsolation,
      syncChunks,
      liveMessages,
      attachmentConstruction,
      uploadOutsideDbOwner,
      rekeyExclusive: orderedState.rekeyExclusive,
      queuedWritersBlocked: orderedState.successorWaitedForRekey,
      rekeyApplied: orderedState.rekeyApplied,
      queuedWritersResumed,
      uploadSettlement,
      queueDrained,
      sentinelCommit,
    };
  } catch {
    // Do not carry a native/SQLite error outward: paths and SQLCipher diagnostics can be private.
    throw new Error('disposable database runtime concurrency wave failed');
  } finally {
    releaseUpload.resolve();
    // A Promise timeout cannot cancel native SQLite safely. Await every started owner here; the
    // exclusive host harness bounds an actual native hang by stopping the whole app process.
    await Promise.allSettled(retained);
  }
}
