import { isReaction } from '@core/models';

export interface PreviewInput {
  lastGuid: string | null;
  lastText: string | null;
  lastSubject: string | null;
  lastIsFromMe: number | null;
  lastHasAttachments: number | null;
  lastAssociatedType: string | null;
}

const REACTION_LABELS: Record<string, string> = {
  love: 'Loved a message',
  like: 'Liked a message',
  dislike: 'Disliked a message',
  laugh: 'Laughed at a message',
  emphasize: 'Emphasized a message',
  question: 'Questioned a message',
};

function reactionText(type: string): string {
  return REACTION_LABELS[type.toLowerCase()] ?? 'Reacted to a message';
}

/**
 * Conversation-list subtitle preview. Adds the iOS "You: " prefix on outgoing
 * messages, a generic attachment placeholder when the latest message is media
 * with no text, and relabels reactions. Empty chats render "".
 */
export function buildPreview(row: PreviewInput): string {
  if (row.lastGuid == null && !row.lastText) return '';

  if (isReaction({ associatedMessageType: row.lastAssociatedType ?? undefined })) {
    const label = reactionText(row.lastAssociatedType ?? '');
    return row.lastIsFromMe ? `You ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
  }

  let body = (row.lastText ?? row.lastSubject ?? '').trim();
  if (!body && row.lastHasAttachments) body = '📎 Attachment';
  if (!body) return '';

  return row.lastIsFromMe ? `You: ${body}` : body;
}
