import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import {
  MessageStatePage,
  compareMessageStateSequence,
  type MessageStateAuthority,
  type MessageStateEvent,
} from '@core/models/messageState';
import {
  applyMessageStateWithinTransaction,
  bindHydratedMessageOwnerWithinTransaction,
  getMessageStateAuthorityWithinTransaction,
  setMessageStateAuthorityWithinTransaction,
} from '@db/repositories/messageState';
import {
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import { resolveMessageChatGuid } from '@core/models';
import { classifyRcsMessageRecord } from '@core/rcs';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

export const MESSAGE_STATE_FOREGROUND_MAX_PAGES = 1_000;

/** Committed pages stay resumable, but a partial boundary must never be reported as complete. */
export class MessageStateSyncIncompleteError extends Error {
  constructor() {
    super('Message-state sync has more pages to fetch. Retry to continue.');
    this.name = 'MessageStateSyncIncompleteError';
  }
}

export interface MessageStateSyncOptions {
  providerEpoch: string;
  /** Headless work defaults to five pages; foreground may drain up to the finite ceiling. */
  maxPages?: number;
  shouldAbort?: () => boolean;
  commitGuard?: DbCommitGuard;
  signal?: AbortSignal;
}

/** Each bounded page and its continuation commit together; realtime never writes this cursor. */
export async function syncMessageState(
  db: AppDatabase,
  api: SyncApi,
  options: MessageStateSyncOptions,
): Promise<void> {
  const maxPages = options.maxPages ?? 5;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MESSAGE_STATE_FOREGROUND_MAX_PAGES
  )
    throw new RangeError('Message-state page budget is outside its allowed bounds.');
  const guard = () => !options.shouldAbort?.() && (options.commitGuard?.() ?? true);
  if (!guard()) return;
  let authority = await withDbTransaction(
    db,
    (context) => getMessageStateAuthorityWithinTransaction(context),
    guard,
  );
  if (!authority || authority.providerEpoch !== options.providerEpoch)
    throw new MessageStateRepairRequiredError();
  if (!api.fetchMessageState)
    throw new Error('The advertised message-state endpoint is unavailable.');
  let boundary: string | null = null;
  for (let count = 0; count < maxPages; count++) {
    if (!guard()) return;
    const previous: MessageStateAuthority = authority;
    const page = MessageStatePage.parse(
      await api.fetchMessageState(previous.cursor, options.signal),
    );
    if (!guard()) return;
    if (page.providerEpoch !== previous.providerEpoch || page.ledgerEpoch !== previous.ledgerEpoch)
      throw new MessageStateRepairRequiredError();
    let last = previous.sequence;
    for (const event of page.events) {
      if (
        compareMessageStateSequence(event.sequence, last) <= 0 ||
        compareMessageStateSequence(event.sequence, page.boundary) > 0
      )
        throw new Error('Message-state events are not strictly ordered within their boundary.');
      last = event.sequence;
    }
    if (
      compareMessageStateSequence(page.sequence, previous.sequence) < 0 ||
      page.sequence !== last ||
      compareMessageStateSequence(page.sequence, page.boundary) > 0 ||
      (page.hasMore
        ? page.sequence === page.boundary || page.events.length === 0
        : page.sequence !== page.boundary) ||
      (boundary != null && boundary !== page.boundary) ||
      compareMessageStateSequence(page.prunedThrough, previous.sequence) > 0 ||
      (page.hasMore && page.cursor === previous.cursor)
    )
      throw new Error('Message-state continuation is inconsistent.');
    boundary = page.boundary;
    // Every event above must validate, but only its message's final state may become visible.
    // Retain an earlier exact owner when the last event lacks one; conflicting owners invalidate
    // the entire page before hydration or writes can assign the identity to either claimant.
    const latestEvents = new Map<string, MessageStateEvent>();
    for (const event of page.events) {
      const earlier = latestEvents.get(event.guid);
      if (
        earlier?.chatGuid != null &&
        event.chatGuid != null &&
        earlier.chatGuid !== event.chatGuid
      )
        throw new Error('Message-state page contains conflicting message owners.');
      latestEvents.set(event.guid, {
        ...event,
        chatGuid: event.chatGuid ?? earlier?.chatGuid ?? null,
      });
    }
    // Network hydration is outside the page owner. Each small transaction binds only the proven
    // owner and body; final per-message transitions and the checkpoint commit in the final owner.
    const restoredOwners = new Map<string, string>();
    for (const event of latestEvents.values()) {
      if (event.kind !== 'restored' || !api.fetchActiveMessage) continue;
      const message = await api.fetchActiveMessage(event.guid, page.providerEpoch, options.signal);
      if (!guard()) return;
      if (!message) throw new MessageStateRepairRequiredError();
      const owner = resolveMessageChatGuid(message);
      if (
        message.guid !== event.guid ||
        !owner ||
        (event.chatGuid != null && owner !== event.chatGuid) ||
        classifyRcsMessageRecord(null, message, owner) !== 'non-rcs' ||
        !message.chats?.length ||
        message.chats.some((chat) => chat.guid !== owner) ||
        (message.chatGuid != null && message.chatGuid !== owner)
      )
        throw new Error('Restored message does not match its exact provider owner.');
      restoredOwners.set(event.sequence, owner);
      await withDbTransaction(
        db,
        async (context) => {
          // Active exact-GUID hydration supplies the missing owner for a previously quarantined
          // server receipt. Local/legacy ownerless deletion receipts remain independently closed.
          await bindHydratedMessageOwnerWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch: page.providerEpoch,
            ledgerEpoch: page.ledgerEpoch,
            ...event,
            chatGuid: owner,
          });
          const chats = message.chats ?? [];
          const handles = await upsertHandlesWithinTransaction(context, [
            ...chats.flatMap((chat) => chat.participants ?? []),
            ...(message.handle ? [message.handle] : []),
          ]);
          const chatIds = await upsertChatsWithinTransaction(context, chats, handles);
          await upsertMessagesWithinTransaction(
            context,
            [message],
            () => chatIds.get(owner),
            handles,
          );
        },
        guard,
      );
    }
    const next = { ...previous, cursor: page.cursor, sequence: page.sequence };
    await withDbTransaction(
      db,
      async (context) => {
        const current = await getMessageStateAuthorityWithinTransaction(context);
        if (
          !current ||
          current.cursor !== previous.cursor ||
          current.providerEpoch !== previous.providerEpoch ||
          current.ledgerEpoch !== previous.ledgerEpoch
        )
          throw new Error('Message-state authority changed while a page was in flight.');
        for (const event of latestEvents.values())
          await applyMessageStateWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch: page.providerEpoch,
            ledgerEpoch: page.ledgerEpoch,
            ...event,
            chatGuid: restoredOwners.get(event.sequence) ?? event.chatGuid,
          });
        await setMessageStateAuthorityWithinTransaction(context, next);
      },
      guard,
    );
    authority = next;
    if (!page.hasMore) return;
  }
  throw new MessageStateSyncIncompleteError();
}
