import type { Message } from '@core/models';
import { logger } from '@core/secure';
import {
  boundSearchResultSnippet,
  linkHandlesToContacts,
  searchMessagesEnrichedByGuids,
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
  upsertMessagesWithinTransaction,
  type SearchResultRow,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

const SERVER_SEARCH_TX_CHUNK = 25;
const SERVER_SEARCH_RESULT_LIMIT = 50;

export interface ServerMessageSearchDependencies {
  fetchMessages(query: string, signal: AbortSignal): Promise<Message[]>;
  getDatabase(): AppDatabase;
}

function toAdoptableServerHit(message: Message): Message | null {
  const chat = message.chats?.[0];
  // The Mac endpoint searches chat.db only. Refuse an unexpected RCS sidecar result so the UI's
  // stated scope remains true and a malformed response cannot create a cross-service chat shell.
  const exposesRcsNamespace =
    message.guid.toLowerCase().startsWith('rcs-') ||
    message.chatGuid?.toLowerCase().startsWith('rcs;-;') === true ||
    message.associatedMessageGuid?.toLowerCase().startsWith('rcs-') === true ||
    message.providerEpoch != null ||
    (message.chats ?? []).some(
      (candidate) =>
        candidate.guid.toLowerCase().startsWith('rcs;-;') || candidate.providerEpoch != null,
    ) ||
    (message.attachments ?? []).some(
      (attachment) =>
        attachment.guid.toLowerCase().startsWith('rcs-media-') || attachment.providerEpoch != null,
    );
  if (
    !message.guid ||
    !chat?.guid ||
    message.chatGuid !== chat.guid ||
    (message.chats ?? []).some((candidate) => candidate.guid !== chat.guid) ||
    exposesRcsNamespace
  ) {
    return null;
  }
  // Search needs only the full text, sender and first routable chat. Its server endpoint does not
  // hydrate attachments or participants, but Message is a shared model whose nested collections
  // are otherwise unbounded. Strip every such collection here so an endpoint-impossible response
  // cannot turn a nominal 25-message owner into thousands of attachment/handle writes or giant
  // JSON serializations. Ordinary sync can fill this richer data later.
  const {
    attachments: _attachments,
    attributedBody: _attributedBody,
    messageSummaryInfo: _messageSummaryInfo,
    payloadData: _payloadData,
    chats: _chats,
    ...searchMessage
  } = message;
  const { participants: _participants, ...searchChat } = chat;
  return { ...searchMessage, chats: [searchChat] };
}

function dedupeAdoptableHits(messages: Message[]): Message[] {
  const byGuid = new Map<string, Message>();
  for (const message of messages) {
    const adoptable = toAdoptableServerHit(message);
    if (adoptable && !byGuid.has(adoptable.guid)) byGuid.set(adoptable.guid, adoptable);
  }
  return [...byGuid.values()].slice(0, SERVER_SEARCH_RESULT_LIMIT);
}

/**
 * Persist server hits before exposing them to navigation, then read them through the local search
 * visibility contract. Each 25-message slice owns one short, guarded transaction; no network work
 * runs while the process-wide DB writer lock is held.
 */
export async function adoptServerMessageSearchHits(
  db: AppDatabase,
  messages: Message[],
  lease: RealtimeDeliveryLease,
  queryText = '',
  shouldContinue: () => boolean = lease.isCurrent,
): Promise<SearchResultRow[]> {
  const hits = dedupeAdoptableHits(messages);
  if (hits.length === 0 || !lease.isCurrent() || !shouldContinue()) return [];
  const hitTextByGuid = new Map(hits.map((hit) => [hit.guid, hit.text ?? null]));

  const adoptedGuids: string[] = [];
  const adoptedAddresses: string[] = [];
  let adoptedRows: SearchResultRow[] = [];
  const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
    for (let index = 0; index < hits.length; index += SERVER_SEARCH_TX_CHUNK) {
      const slice = hits.slice(index, index + SERVER_SEARCH_TX_CHUNK);
      const sliceChats = slice.flatMap((message) => message.chats ?? []);
      const sliceHandles = [
        ...sliceChats.flatMap((chat) => chat.participants ?? []),
        ...slice.flatMap((message) => (message.handle ? [message.handle] : [])),
      ];
      const stored = await withDbTransaction(
        db,
        async (transactionContext) => {
          const handleMap = await upsertHandlesWithinTransaction(transactionContext, sliceHandles);
          const chatMap = await upsertChatsWithinTransaction(
            transactionContext,
            sliceChats,
            handleMap,
          );
          return upsertMessagesWithinTransaction(
            transactionContext,
            slice,
            (message) => {
              const chatGuid = message.chats?.[0]?.guid;
              return chatGuid ? chatMap.get(chatGuid) : undefined;
            },
            handleMap,
          );
        },
        () => activeLease.isCurrent() && shouldContinue(),
      );
      adoptedGuids.push(...stored.keys());
      adoptedAddresses.push(...sliceHandles.map((handle) => handle.address));
    }

    if (!activeLease.isCurrent() || !shouldContinue()) return;
    // Handles this search created link to saved contacts only after their transaction commits:
    // building the contact index reads the whole address book (review M057). Best effort.
    const linkIsCurrent = (): boolean => activeLease.isCurrent() && shouldContinue();
    await linkHandlesToContacts(db, adoptedAddresses, undefined, linkIsCurrent).catch(
      (error: unknown) => {
        if (linkIsCurrent())
          logger.debug('[search] contact linking for search results skipped', error);
      },
    );
    if (!activeLease.isCurrent() || !shouldContinue()) return;
    adoptedRows = await searchMessagesEnrichedByGuids(db, adoptedGuids);
  });

  if (outcome !== 'delivered' || !lease.isCurrent() || !shouldContinue()) return [];
  return adoptedRows.map((row) => ({
    ...row,
    snippet: boundSearchResultSnippet(hitTextByGuid.get(row.guid) ?? row.snippet, queryText),
  }));
}

/** Fetch outside the DB owner, abort on account retirement, then adopt under a tracked lease. */
export async function searchAndAdoptServerMessagesWith(
  dependencies: ServerMessageSearchDependencies,
  query: string,
  lease: RealtimeDeliveryLease,
  callerSignal?: AbortSignal,
): Promise<SearchResultRow[]> {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (callerSignal?.aborted) abort();
  callerSignal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, abort);

  try {
    if (!lease.isCurrent() || controller.signal.aborted) return [];
    const messages = await dependencies.fetchMessages(query, controller.signal);
    if (!lease.isCurrent() || controller.signal.aborted) return [];
    return await adoptServerMessageSearchHits(
      dependencies.getDatabase(),
      messages,
      lease,
      query,
      () => !controller.signal.aborted,
    );
  } finally {
    unsubscribe();
    callerSignal?.removeEventListener('abort', abort);
  }
}
