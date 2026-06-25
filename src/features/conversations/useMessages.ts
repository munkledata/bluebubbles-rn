import { getDatabase } from '@db/database';
import {
  getChatIdByGuid,
  getMessagePreviewByGuid,
  listAttachmentsByMessageIds,
  listMessagesWithSenders,
  listReactionsByMessageGuids,
  type AttachmentRow,
  type MessagePreview,
  type MessageRow,
  type ReactionRow,
} from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';

// Bubbles depend on message rows (which also hold reactions + replies), sender
// handles, and attachments — all already in these tables, so a reaction add/
// remove or reply re-fires the query without watching anything new.
const TABLES = ['messages', 'handles', 'attachments'];

export interface MessageWithAttachments extends MessageRow {
  attachments: AttachmentRow[];
}

export interface EnrichedMessage extends MessageWithAttachments {
  reactions: ReactionRow[];
  replyPreview: MessagePreview | null;
}

/**
 * Live, newest-first messages for a chat with attachments, reactions, and reply quotes.
 * `sinceDate` (set when opening from a search hit) widens the loaded window down to that date so
 * the target message is present to scroll to — capped by `limit`, so a very old hit in a very
 * active chat may still fall outside it (the list then just opens without auto-scrolling).
 */
export function useMessages(
  chatGuid: string,
  limit = 100,
  sinceDate?: number,
): ReactiveState<EnrichedMessage[]> {
  return useReactiveQuery<EnrichedMessage[]>(
    async () => {
      const db = getDatabase();
      const chatId = await getChatIdByGuid(db, chatGuid);
      if (chatId == null) return [];
      const msgs = await listMessagesWithSenders(db, chatId, limit, undefined, sinceDate);

      // Load attachments by actual stored rows, NOT by gating on `hasAttachments`: the server
      // omits that flag, so it persists as 0 and this filter excluded every message — which is
      // exactly why images rendered as blank "￼" bubbles. The attachment rows are already in the
      // DB; listAttachmentsByMessageIds filters by `message_id IN`, so passing every id simply
      // returns nothing for text-only messages.
      const ids = msgs.map((m) => m.id);
      const attByMsg = await listAttachmentsByMessageIds(db, ids);
      const reactionsByGuid = await listReactionsByMessageGuids(
        db,
        msgs.map((m) => m.guid),
      );

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

      return msgs.map((m) => ({
        ...m,
        attachments: attByMsg.get(m.id) ?? [],
        reactions: reactionsByGuid.get(m.guid) ?? [],
        replyPreview: m.threadOriginatorGuid
          ? (previews.get(m.threadOriginatorGuid) ?? null)
          : null,
      }));
    },
    TABLES,
    [chatGuid, limit, sinceDate],
  );
}
