import { useCallback, useState } from 'react';
import { isAggregateRetractionTombstone } from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
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

export interface MessageWindowState extends ReactiveState<EnrichedMessage[]> {
  /** True only when the settled result belongs to the currently requested anchor/newest mode. */
  isCurrentWindow: boolean;
  /** Starts a fresh proof generation before leaving an anchored window. */
  refreshWindow(): void;
}

interface SettledMessageWindow {
  error: Error | null;
  messages: EnrichedMessage[] | null;
  requestKey: string;
}

function replyPreviewKey(guid: string, partIndex: number | null | undefined): string {
  return JSON.stringify([guid, partIndex ?? null]);
}

function getMessageWindowRequestKey(
  chatGuid: string,
  anchorGuid: string | undefined,
  anchorId: number | undefined,
  generation: number,
): string {
  return JSON.stringify(
    anchorGuid == null
      ? [chatGuid, 'newest', generation]
      : [chatGuid, 'anchor', anchorGuid, anchorId ?? null, generation],
  );
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
): MessageWindowState {
  const anchorGuid = anchor?.guid;
  const anchorId = anchor?.id;
  const [windowGeneration, setWindowGeneration] = useState(0);
  const refreshWindow = useCallback((): void => {
    setWindowGeneration((generation) => generation + 1);
  }, []);
  // Deliberately exclude `limit`: growing an already-current newest window is pagination, not a
  // switch between the live and anchored modes that control whether Composer may be used.
  const requestKey = getMessageWindowRequestKey(chatGuid, anchorGuid, anchorId, windowGeneration);
  // Every reactive flush rebuilds every row object; reconcile against the previous pass so an
  // UNCHANGED message keeps its identity and the memoized MessageRow/MessageBubble don't re-render
  // (the same churn that caused the ImageAttachment re-download storm). Keyed by guid, fingerprinted
  // over the whole enriched row (attachments/reactions/replyPreview included).
  // Lazy initializer — useRef(create()) would re-invoke the factory every render.
  const [reconcile] = useState(() => createRowIdentityCache<EnrichedMessage>((m) => m.guid));
  const reactive = useReactiveQuery<SettledMessageWindow>(
    async () => {
      try {
        const db = getDatabase();
        const chatId = await getChatIdByGuid(db, chatGuid);
        if (chatId == null) return { error: null, messages: [], requestKey };
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
        const attByMsg = await listAttachmentsByMessageIds(db, ids, undefined, {
          excludeRetractedAttachments: true,
        });
        const guids = msgs.map((m) => m.guid);
        const reactionsByGuid = await listReactionsByMessageGuids(db, guids);
        // Stickers target a message the same way a reaction does, so they key off the same guid list.
        // No new watched TABLE is needed: 'messages' covers the sticker row arriving and
        // 'attachments' covers its local_path being written, which is what makes the image appear
        // once downloaded.
        const stickersByGuid = await listStickersForTargets(db, guids);

        // Reply originals: dedupe the target guids, fetch each once.
        const replyTargets = new Map<string, { guid: string; partIndex: number | null }>();
        for (const message of msgs) {
          if (!message.threadOriginatorGuid) continue;
          const target = {
            guid: message.threadOriginatorGuid,
            partIndex: message.threadOriginatorPart ?? null,
          };
          replyTargets.set(replyPreviewKey(target.guid, target.partIndex), target);
        }
        const previews = new Map<string, MessagePreview>();
        await Promise.all(
          [...replyTargets].map(async ([key, target]) => {
            const preview = await getMessagePreviewByGuid(db, target.guid, target.partIndex);
            if (preview) previews.set(key, preview);
          }),
        );

        return {
          error: null,
          messages: reconcile(
            msgs.map((m) => {
              const topology = parseMessagePartTopology(m.messagePartTopology);
              const visibleParts =
                m.retractionState === 'partial'
                  ? new Set(topology?.currentParts.map((part) => part.index) ?? [])
                  : null;
              const aggregateRetracted = isAggregateRetractionTombstone(m);
              const reactions = aggregateRetracted
                ? []
                : (reactionsByGuid.get(m.guid) ?? []).filter(
                    (reaction) =>
                      visibleParts == null ||
                      (reaction.targetPart != null && visibleParts.has(reaction.targetPart)),
                  );
              const stickers = aggregateRetracted
                ? []
                : (stickersByGuid.get(m.guid) ?? []).filter(
                    (sticker) =>
                      visibleParts == null ||
                      (sticker.targetPart != null && visibleParts.has(sticker.targetPart)),
                  );
              return {
                ...m,
                attachments: attByMsg.get(m.id) ?? [],
                reactions,
                stickers,
                replyPreview: m.threadOriginatorGuid
                  ? (previews.get(
                      replyPreviewKey(m.threadOriginatorGuid, m.threadOriginatorPart),
                    ) ?? null)
                  : null,
              };
            }),
          ),
          requestKey,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
          messages: null,
          requestKey,
        };
      }
    },
    TABLES,
    [chatGuid, limit, anchorGuid, anchorId, windowGeneration],
  );

  // useReactiveQuery intentionally retains the previous dependency result during a new request.
  // Keep those rows visible, but do not describe them as current (or expose their old error) until
  // an envelope carrying this exact anchor/newest key settles successfully.
  const current = reactive.data?.requestKey === requestKey ? reactive.data : null;
  const isCurrentWindow = current != null && current.error == null;
  return {
    data: reactive.data?.messages ?? null,
    error: current?.error ?? reactive.error,
    isCurrentWindow,
    isLoading: reactive.isLoading || (current == null && reactive.error == null),
    refreshWindow,
  };
}
