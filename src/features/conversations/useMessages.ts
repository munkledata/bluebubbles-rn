import { useState } from 'react';
import { getDatabase } from '@db/database';
import {
  getChatIdByGuid,
  getMessagePreviewByGuid,
  listAttachmentsByMessageIds,
  listMessagesAround,
  listMessagesWithSenders,
  listReactionsByMessageGuids,
  listStickersForTargets,
  type AttachmentRow,
  type MessagePreview,
  type MessageRow,
  type MessageWindowAnchor,
  type ReactionRow,
  type StickerRow,
} from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { createRowIdentityCache } from './rowIdentity';

// Bubbles depend on message rows (which also hold reactions + replies), sender
// handles, and attachments — all already in these tables, so a reaction add/
// remove or reply re-fires the query without watching anything new.
const TABLES = ['messages', 'handles', 'attachments'];

export interface MessageWithAttachments extends MessageRow {
  attachments: AttachmentRow[];
}

export interface EnrichedMessage extends MessageWithAttachments {
  reactions: ReactionRow[];
  /** Stickers other people slapped ON this message, drawn as an overlay by the bubble. */
  stickers: StickerRow[];
  replyPreview: MessagePreview | null;
}

/**
 * Live, newest-first messages for a chat with attachments, reactions, and reply quotes.
 * `anchor` identifies the exact search/reminder hit to center in a context window instead of the
 * recent `limit` window. Global routes provide its guid; an in-chat result also supplies local id.
 */
export function useMessages(
  chatGuid: string,
  limit = 100,
  anchor?: MessageWindowAnchor,
): ReactiveState<EnrichedMessage[]> {
  const anchorGuid = anchor?.guid;
  const anchorId = anchor?.id;
  // Every reactive flush rebuilds every row object; reconcile against the previous pass so an
  // UNCHANGED message keeps its identity and the memoized MessageRow/MessageBubble don't re-render
  // (the same churn that caused the ImageAttachment re-download storm). Keyed by guid, fingerprinted
  // over the whole enriched row (attachments/reactions/replyPreview included).
  // Lazy initializer — useRef(create()) would re-invoke the factory every render.
  const [reconcile] = useState(() => createRowIdentityCache<EnrichedMessage>((m) => m.guid));
  return useReactiveQuery<EnrichedMessage[]>(
    async () => {
      const db = getDatabase();
      const chatId = await getChatIdByGuid(db, chatGuid);
      if (chatId == null) return [];
      const msgs =
        anchorGuid != null
          ? await listMessagesAround(
              db,
              chatId,
              anchorId == null ? { guid: anchorGuid } : { guid: anchorGuid, id: anchorId },
            )
          : await listMessagesWithSenders(db, chatId, limit);

      // Load attachments by actual stored rows, NOT by gating on `hasAttachments`: the server
      // omits that flag, so it persists as 0 and this filter excluded every message — which is
      // exactly why images rendered as blank "￼" bubbles. The attachment rows are already in the
      // DB; listAttachmentsByMessageIds filters by `message_id IN`, so passing every id simply
      // returns nothing for text-only messages.
      const ids = msgs.map((m) => m.id);
      const attByMsg = await listAttachmentsByMessageIds(db, ids);
      const guids = msgs.map((m) => m.guid);
      const reactionsByGuid = await listReactionsByMessageGuids(db, guids);
      // Stickers target a message the same way a reaction does, so they key off the same guid list.
      // No new watched TABLE is needed: 'messages' covers the sticker row arriving and 'attachments'
      // covers its local_path being written, which is what makes the image appear once downloaded.
      const stickersByGuid = await listStickersForTargets(db, guids);

      // Reply originals: dedupe the target guids, fetch each once.
      const replyGuids = [
        ...new Set(msgs.map((m) => m.threadOriginatorGuid).filter((g): g is string => !!g)),
      ];
      const previews = new Map<string, MessagePreview>();
      await Promise.all(
        replyGuids.map(async (g) => {
          const p = await getMessagePreviewByGuid(db, g);
          if (p) previews.set(g, p);
        }),
      );

      return reconcile(
        msgs.map((m) => ({
          ...m,
          attachments: attByMsg.get(m.id) ?? [],
          reactions: reactionsByGuid.get(m.guid) ?? [],
          stickers: stickersByGuid.get(m.guid) ?? [],
          replyPreview: m.threadOriginatorGuid
            ? (previews.get(m.threadOriginatorGuid) ?? null)
            : null,
        })),
      );
    },
    TABLES,
    [chatGuid, limit, anchorGuid, anchorId],
  );
}
