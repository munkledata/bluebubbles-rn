import { isReaction } from '@core/models';

export interface PreviewInput {
  lastGuid: string | null;
  lastText: string | null;
  lastSubject: string | null;
  lastIsFromMe: number | null;
  lastHasAttachments: number | null;
  lastAssociatedType: string | null;
  /** Genmoji description of the latest message's Genmoji attachment (or null/absent) — used as the
   *  attachment fallback text in place of the generic "📎 Attachment". */
  lastAttachmentDescription?: string | null;
  /** Apple Messages extension identifier. It is classified locally and never displayed raw. */
  lastBalloonBundleId?: string | null;
  /** 1 when at least one attachment is not a hidden plugin payload. */
  lastHasVisibleAttachments?: number | null;
}

/**
 * iMessage/RCS attachment messages carry U+FFFC (OBJECT REPLACEMENT CHARACTER) in their text
 * as a placeholder for each inline attachment — it renders as an empty box. Strip those (and
 * surrounding whitespace) so previews/notifications show real text or fall through to an
 * attachment label instead of a box. Returns '' when the text was only placeholders/blank.
 */
export function stripAttachmentPlaceholder(text: string | null | undefined): string {
  return (text ?? '').replace(/\uFFFC/g, '').trim();
}

const HANDWRITING_BALLOON = 'com.apple.Handwriting.HandwritingProvider';
const DIGITAL_TOUCH_BALLOON = 'com.apple.DigitalTouchBalloonProvider';
const URL_BALLOON = 'com.apple.messages.URLBalloonProvider';

/**
 * A safe, local label for an Apple Messages extension payload. Unknown identifiers deliberately
 * collapse to one generic label: bundle ids are implementation metadata, not user content.
 */
export function interactiveMessageLabel(balloonBundleId: string | null | undefined): string | null {
  if (!balloonBundleId?.trim()) return null;
  if (balloonBundleId === URL_BALLOON) return 'Link preview unavailable';
  if (balloonBundleId === HANDWRITING_BALLOON) return 'Handwritten message';
  if (balloonBundleId === DIGITAL_TOUCH_BALLOON) return 'Digital Touch message';
  return 'Interactive message';
}

export interface MessageSnippetInput {
  text?: string | null;
  subject?: string | null;
  hasAttachments?: boolean | number | null;
  hasVisibleAttachments?: boolean | number | null;
  attachmentDescription?: string | null;
  balloonBundleId?: string | null;
}

function isPresentFlag(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

/**
 * Compact message text shared by inbox rows, reply quotes, thread rows, and notifications. Real
 * text wins, then an extension's safe local label. Attachment metadata is considered only for a
 * normal message, so a lean extension payload cannot leak its private attachment description. The
 * final attachment branch preserves the legacy fallback for older projections.
 */
export function buildMessageSnippet(input: MessageSnippetInput): string {
  const body = stripAttachmentPlaceholder(input.text) || stripAttachmentPlaceholder(input.subject);
  if (body) return body;

  const interactiveLabel = interactiveMessageLabel(input.balloonBundleId);
  if (interactiveLabel) return interactiveLabel;

  const attachmentDescription = input.attachmentDescription?.trim();
  if (attachmentDescription) return attachmentDescription;
  if (isPresentFlag(input.hasVisibleAttachments)) return '📎 Attachment';

  return isPresentFlag(input.hasAttachments) ? '📎 Attachment' : '';
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

  const body = buildMessageSnippet({
    text: row.lastText,
    subject: row.lastSubject,
    hasAttachments: row.lastHasAttachments,
    hasVisibleAttachments: row.lastHasVisibleAttachments,
    attachmentDescription: row.lastAttachmentDescription,
    balloonBundleId: row.lastBalloonBundleId,
  });
  if (!body) return '';

  return row.lastIsFromMe ? `You: ${body}` : body;
}
