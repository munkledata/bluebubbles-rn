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

/** Live, newest-first messages for a chat with attachments, reactions, and reply quotes. */
export function useMessages(chatGuid: string, limit = 100): ReactiveState<EnrichedMessage[]> {
  return useReactiveQuery<EnrichedMessage[]>(
    async () => {
      const db = getDatabase();
      const chatId = await getChatIdByGuid(db, chatGuid);
      if (chatId == null) return [];
      const msgs = await listMessagesWithSenders(db, chatId, limit);

      const ids = msgs.filter((m) => m.hasAttachments === 1).map((m) => m.id);
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
    [chatGuid, limit],
  );
}
