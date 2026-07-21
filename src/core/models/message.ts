import { z } from 'zod/v4';
import { stripAssociatedGuidPrefix } from '../reactions/reactionType';
import { epochMillis } from './common';
import { Handle } from './handle';
import { Attachment } from './attachment';
import { ChatSummary } from './chatSummary';

/**
 * One revision of an edited message part: the part's text at that revision plus the edit date
 * (Unix ms, nullable). The wire carries an ordered array per part — index 0 = the ORIGINAL text,
 * the last entry = the CURRENT text. `.loose()` + nullish inner keys so a shape drift on any one
 * revision degrades gracefully rather than rejecting the whole message.
 */
export const EditRevision = z
  .object({
    date: epochMillis, // number | null after coercion
    text: z.string().nullish(),
  })
  .loose();
export type EditRevision = z.infer<typeof EditRevision>;

/**
 * Apple `message_summary_info` (macOS 13+): per-part edit history + unsent ("retracted") parts.
 * Present ONLY on edited/retracted messages — the server omits the key entirely otherwise. Powers
 * the long-press "View Edit History" sheet.
 *   - `editedParts`: keyed by part index (JSON object keys are strings) → that part's ordered
 *     revision list (original → current).
 *   - `retractedParts`: the part indexes the sender unsent.
 * Deliberately tolerant — `.loose()` (keeps unknown keys like Apple's `otr`) + optional/nullish
 * inner keys — so a malformed value degrades to "no history" instead of a hard parse failure. A
 * sync page is ONE array parse, so one bad field must never stall the whole page (invariant:
 * readers degrade, never throw).
 */
export const MessageSummaryInfo = z
  .object({
    editedParts: z.record(z.string(), z.array(EditRevision)).nullish(),
    retractedParts: z.array(z.number()).nullish(),
  })
  .loose();
export type MessageSummaryInfo = z.infer<typeof MessageSummaryInfo>;

/**
 * One decoded rich-link preview from a URL balloon's `payload_data` — the LPLinkMetadata the
 * SENDER's device already fetched (title/summary/site + image/icon/video URLs). Every field
 * nullish + `.loose()`: the server owns the decode and this must tolerate shape drift.
 */
export const UrlPreviewItem = z
  .object({
    url: z.string().nullish(),
    originalUrl: z.string().nullish(),
    title: z.string().nullish(),
    summary: z.string().nullish(),
    siteName: z.string().nullish(),
    itemType: z.string().nullish(),
    imageUrl: z.string().nullish(),
    iconUrl: z.string().nullish(),
    videoUrl: z.string().nullish(),
  })
  .loose();
export type UrlPreviewItem = z.infer<typeof UrlPreviewItem>;

/**
 * Apple rich-link metadata for a URL balloon (`payloadData` on the wire). Presence-driven:
 * the server emits it only when the blob decoded to real data — placeholder RichLinks (link
 * sent before its metadata resolved), app balloons, and old servers simply omit it, and the
 * client falls back to its own OG fetch (useUrlPreview).
 */
export const PayloadData = z
  .object({
    urlData: z.array(UrlPreviewItem).nullish(),
  })
  .loose();
export type PayloadData = z.infer<typeof PayloadData>;

/**
 * A single message (Flutter: Message). Reactions are modelled server-side as
 * "associated messages" carrying an `associatedMessageType` (e.g. "love",
 * "like", "emphasize"); threading uses `threadOriginatorGuid`.
 */
export const Message = z.object({
  originalROWID: z.number().nullish(),
  guid: z.string(),
  text: z.string().nullish(),
  subject: z.string().nullish(),
  /** Apple typedstream rich-text payload, base64; parsed lazily off-thread. */
  attributedBody: z.array(z.unknown()).nullish(),
  handleId: z.number().nullish(),
  handle: Handle.nullish(),
  isFromMe: z.boolean().nullish(),
  /**
   * Whether the message has actually been sent (Apple `is_sent`). The wire ALWAYS carries it (like
   * `isFromMe`). Modeled `.nullish()` (matching `isFromMe`) so an old server that never emits it
   * degrades to undefined. Paired with `isScheduled` to gate the "Scheduled" badge — a pending
   * Send-Later row is `isScheduled && !isSent` (see MessageBubble).
   */
  isSent: z.boolean().nullish(),
  hasDdResults: z.boolean().nullish(),

  dateCreated: epochMillis,
  dateRead: epochMillis,
  dateDelivered: epochMillis,
  dateEdited: epochMillis,
  dateRetracted: epochMillis,

  /**
   * Apple edit history / unsent parts (macOS 13+). Presence-driven — arrives ONLY on edited or
   * retracted messages. `messageSummaryInfo` is already in SYNC_WITH_QUERY, so existing sync/query
   * flows deliver it once this field exists (older code silently stripped it for lack of a model
   * field). `.catch(undefined)` is the final guard: a malformed value coerces to "absent" rather
   * than failing the whole message parse (which would stall the sync page it rides in). Persisted
   * as JSON TEXT on the messages table; read back tolerantly via {@link parseMessageSummaryInfo}.
   */
  messageSummaryInfo: MessageSummaryInfo.nullish().catch(undefined),

  /**
   * Apple rich-link preview (URL balloons): the sender-fetched LPLinkMetadata, decoded
   * server-side. Presence-driven — arrives ONLY on URL balloons with real metadata; already in
   * SYNC_WITH_QUERY, so sync + live socket/FCM deliver it once this field exists. Same
   * `.catch(undefined)` guard as `messageSummaryInfo`: a malformed value degrades to "absent"
   * (→ the client's own OG fetch) instead of stalling the sync page. Persisted as JSON TEXT;
   * read back tolerantly via {@link parsePayloadData}.
   */
  payloadData: PayloadData.nullish().catch(undefined),

  hasAttachments: z.boolean().nullish(),
  attachments: z.array(Attachment).nullish(),

  /** Apple delivery tiers: delivered without notifying ("Delivered Quietly")
      vs explicitly notified the recipient. Surfaced in the status row. */
  wasDeliveredQuietly: z.boolean().nullish(),
  didNotifyRecipient: z.boolean().nullish(),

  /**
   * Apple "Send Later" (macOS 15+/iOS 18+): the server emits `true` for ANY scheduled
   * (`schedule_type === 2`) row — while it is PENDING *and* after it actually sends (the flag is
   * gated on `schedule_type`, NOT `is_sent`). So on its own it can't distinguish pending from sent,
   * and a delivered Send-Later message keeps emitting `isScheduled: true` forever. Presence-driven —
   * omitted on ordinary rows and older macOS. Arrives on live events AND query/sync paths. Persisted
   * so a synced row can render a "Scheduled" badge, but the badge is GATED on `isScheduled && !isSent`
   * (see {@link isSent} + MessageBubble): the pending row shows it; the sent row hides it once
   * `is_sent` flips to 1.
   */
  isScheduled: z.boolean().nullish(),

  /** Chats this message belongs to (message/query `with: ['chats']`). */
  chats: z.array(ChatSummary).nullish(),

  /**
   * Top-level chat GUID carried by LIVE realtime events (socket/FCM `new-message` /
   * `updated-message`). The server hydrates `chats[]` on these events, but if it is ever
   * empty/absent this is the defensive fallback so the event isn't silently dropped
   * (see DbEventSink + buildMessageIntents). Absent on the sync/query path (which always
   * carries `chats[]`).
   */
  chatGuid: z.string().nullish(),

  /**
   * Reaction/threading linkage. Normalized on parse to the BARE target guid: the wire carries a
   * part prefix (`p:0/<guid>` / `bp:0/<guid>`) that the target message's own `guid` does not, so
   * without this strip an incoming reaction never matches its target and stays invisible. Applied
   * here at the schema boundary so EVERY ingestion path (live socket/FCM event + sync/query) is
   * covered at once. See {@link stripAssociatedGuidPrefix}.
   */
  associatedMessageGuid: z
    .string()
    .transform(stripAssociatedGuidPrefix)
    .nullish(),
  associatedMessageType: z.string().nullish(),
  /** Glyph of an arbitrary-emoji tapback (associatedMessageType 'emoji'/'-emoji'). */
  associatedMessageEmoji: z.string().nullish(),
  threadOriginatorGuid: z.string().nullish(),

  /** iMessage expressive send effect id (effectMap in constants.dart). */
  expressiveSendStyleId: z.string().nullish(),

  /**
   * Group/chat-event metadata. `itemType` > 0 marks a system event (participant add/remove,
   * rename, leave, photo change, chat-background change, location, kept audio, SharePlay); `groupActionType`
   * disambiguates within a type; `groupTitle` is the new name on a rename; `otherHandle` is the
   * affected participant's server ROWID. Rendered as a centered event line (utils/groupEvent.ts).
   */
  itemType: z.number().nullish(),
  groupActionType: z.number().nullish(),
  groupTitle: z.string().nullish(),
  otherHandle: z.number().nullish(),

  error: z.number().nullish(),
});
export type Message = z.infer<typeof Message>;

/** True when the message is a reaction (tapback) rather than standalone content. */
export function isReaction(m: Pick<Message, 'associatedMessageType'>): boolean {
  const t = m.associatedMessageType;
  return !!t && !t.startsWith('-'); // "-love" etc. == reaction removal
}

/**
 * Resolve the GUID of the chat a (live) message belongs to: prefer the hydrated
 * `chats[0].guid`, falling back to the top-level `chatGuid` a realtime event may carry
 * when the server didn't embed `chats[]`. Returns null when neither is present (the
 * caller logs + skips rather than silently dropping the event — see DbEventSink).
 */
export function resolveMessageChatGuid(m: Pick<Message, 'chats' | 'chatGuid'>): string | undefined {
  return m.chats?.[0]?.guid ?? m.chatGuid ?? undefined;
}

/**
 * Tolerant read-back parse for the DB's `message_summary_info` JSON TEXT column: `JSON.parse`
 * then validate against {@link MessageSummaryInfo}. Returns null on ANY failure (absent, empty,
 * non-JSON, or shape mismatch) and NEVER throws — a corrupt/legacy value degrades to "no history"
 * instead of crashing the long-press menu. Mirror of the write side (`JSON.stringify` in
 * `upsertMessages`).
 */
export function parseMessageSummaryInfo(
  raw: string | null | undefined,
): MessageSummaryInfo | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = MessageSummaryInfo.safeParse(parsed);
  return res.success ? res.data : null;
}

/**
 * Tolerant read-back parse for the DB's `payload_data` JSON TEXT column: `JSON.parse` then
 * validate against {@link PayloadData}. Returns null on ANY failure (absent, empty, non-JSON,
 * shape mismatch, or no urlData entries) and NEVER throws — a corrupt value degrades to "no
 * server preview" and the OG-fetch fallback takes over. Mirror of the write side
 * (`JSON.stringify` in `upsertMessages`).
 */
export function parsePayloadData(raw: string | null | undefined): PayloadData | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = PayloadData.safeParse(parsed);
  if (!res.success || !res.data.urlData?.length) return null;
  return res.data;
}
