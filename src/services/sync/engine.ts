import { SYNC_BATCH_SIZE } from '@core/config';
import { advanceMarker, buildSyncCursor, GuidDeduper, type SyncMarker } from '@core/sync';
import {
  getSyncMarker,
  maxMessageMarker,
  setSyncMarker,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

export interface SyncProgress {
  chats: number;
  messages: number;
}

export interface FullSyncOptions {
  chatPageSize?: number;
  messagePageSize?: number;
  /** Cap messages fetched per chat during the initial sync (0/undefined = all). */
  maxMessagesPerChat?: number;
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Initial full sync: page through all chats, upsert participants + chats, then
 * page each chat's messages into the DB. Finishes by setting the incremental
 * marker to the highest message rowid/date stored. Port of full_sync_manager.dart.
 */
export async function fullSync(
  db: AppDatabase,
  api: SyncApi,
  opts: FullSyncOptions = {},
): Promise<SyncProgress> {
  const chatPageSize = opts.chatPageSize ?? 200;
  const messagePageSize = opts.messagePageSize ?? 100;
  let chats = 0;
  let messages = 0;
  let offset = 0;

  for (;;) {
    const batch = await api.fetchChats(offset, chatPageSize);
    if (batch.length === 0) break;

    const handleMap = await upsertHandles(
      db,
      batch.flatMap((c) => c.participants ?? []),
    );
    const chatMap = await upsertChats(db, batch, handleMap);
    chats += batch.length;

    for (const chat of batch) {
      const chatId = chatMap.get(chat.guid);
      if (chatId == null) continue;

      let mOffset = 0;
      for (;;) {
        const msgs = await api.fetchChatMessages(chat.guid, mOffset, messagePageSize);
        if (msgs.length === 0) break;

        const msgHandleMap = await upsertHandles(
          db,
          msgs.flatMap((m) => (m.handle ? [m.handle] : [])),
        );
        await upsertMessages(db, msgs, () => chatId, new Map([...handleMap, ...msgHandleMap]));
        messages += msgs.length;
        opts.onProgress?.({ chats, messages });

        mOffset += msgs.length;
        if (msgs.length < messagePageSize) break;
        if (opts.maxMessagesPerChat && mOffset >= opts.maxMessagesPerChat) break;
      }
    }

    offset += batch.length;
    if (batch.length < chatPageSize) break;
  }

  await setSyncMarker(db, await maxMessageMarker(db));
  return { chats, messages };
}

export interface IncrementalSyncOptions {
  serverVersion: string;
  batchSize?: number;
  /** Shared deduper (e.g. with the live socket path) to avoid double-processing. */
  deduper?: GuidDeduper;
  /**
   * Fired after EACH page is persisted (not just at the end) so a DB-reactive
   * inbox hydrates mid-sync. `chats` is the running count of distinct chats
   * seen, `messages` the running count of fresh messages stored.
   */
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Incremental sync: fetch messages after the stored cursor (rowid on server
 * >= 1.6.0, else timestamp), dedup by guid, upsert their embedded chats +
 * handles + the messages, and advance the marker. Port of
 * incremental_sync_manager.dart. The marker advances on every batch (even
 * all-duplicate ones) to guarantee forward progress.
 *
 * Each page is committed by its own `upsertChats`/`upsertMessages` calls (NOT
 * batched into one transaction spanning the whole loop), so the drizzle adapter
 * flushes op-sqlite's reactive queries per page and `onProgress` ticks per page
 * — letting the inbox render as data arrives.
 */
export async function incrementalSync(
  db: AppDatabase,
  api: SyncApi,
  opts: IncrementalSyncOptions,
): Promise<SyncProgress> {
  const batchSize = opts.batchSize ?? SYNC_BATCH_SIZE;
  const deduper = opts.deduper ?? new GuidDeduper();
  let marker: SyncMarker = await getSyncMarker(db);
  let messages = 0;
  const seenChats = new Set<string>();

  for (;;) {
    const cursor = buildSyncCursor(opts.serverVersion, marker);
    const batch = await api.fetchMessagesAfter(cursor, batchSize);
    if (batch.length === 0) break;

    const fresh = batch.filter((m) => deduper.markIfNew(m.guid));
    if (fresh.length > 0) {
      const embeddedChats = fresh.flatMap((m) => m.chats ?? []);
      const handleMap = await upsertHandles(db, [
        ...embeddedChats.flatMap((c) => c.participants ?? []),
        ...fresh.flatMap((m) => (m.handle ? [m.handle] : [])),
      ]);
      const chatMap = await upsertChats(db, embeddedChats, handleMap);
      await upsertMessages(
        db,
        fresh,
        (m) => {
          const guid = m.chats?.[0]?.guid;
          return guid ? chatMap.get(guid) : undefined;
        },
        handleMap,
      );
      messages += fresh.length;
      for (const c of embeddedChats) seenChats.add(c.guid);
    }

    marker = advanceMarker(
      marker,
      batch.map((m) => ({ rowId: m.originalROWID ?? null, timestamp: m.dateCreated ?? null })),
    );
    await setSyncMarker(db, marker);

    // Per-page tick: this page's writes are already committed + flushed above, so
    // surfacing progress here lets the reactive inbox catch up immediately.
    opts.onProgress?.({ chats: seenChats.size, messages });

    if (batch.length < batchSize) break;
  }

  return { chats: seenChats.size, messages };
}
