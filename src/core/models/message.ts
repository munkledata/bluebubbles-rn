import { z } from 'zod/v4';
import { isRcsProviderEpoch } from '../rcs/providerIdentity';
import {
  MAX_RETRACTION_ATTACHMENT_GUID_BYTES,
  MAX_RETRACTION_ATTACHMENTS,
  MAX_RETRACTION_PARTS,
  MAX_MESSAGE_PART_TOPOLOGY_BYTES,
  type MessagePartTopology,
} from '../messages/retraction';
import {
  MAX_MESSAGE_PART_INDEX,
  partIndexFromAssociatedGuid,
  stripAssociatedGuidPrefix,
} from '../reactions/reactionType';
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
    retractedParts: z
      .array(z.number().int().min(0).max(MAX_MESSAGE_PART_INDEX))
      .max(MAX_RETRACTION_PARTS)
      .nullish(),
  })
  .loose();
export type MessageSummaryInfo = z.infer<typeof MessageSummaryInfo>;

const topologyUtf8Encoder = new TextEncoder();
const TopologyAttachmentGuid = z
  .string()
  .min(1)
  .max(MAX_RETRACTION_ATTACHMENT_GUID_BYTES)
  .refine(
    (value) =>
      value.trim() === value &&
      !value.includes('\0') &&
      topologyUtf8Encoder.encode(value).byteLength <= MAX_RETRACTION_ATTACHMENT_GUID_BYTES,
  );
const TopologyPartIndex = z.number().int().min(0).max(MAX_MESSAGE_PART_INDEX);

/** Bounded additive server contract used to prove exact Apple multipart identity. */
export const MessagePartTopologyModel = z
  .object({
    complete: z.boolean(),
    originalPartIndexes: z.array(TopologyPartIndex).max(MAX_RETRACTION_PARTS),
    currentParts: z
      .array(
        z
          .object({
            index: TopologyPartIndex,
            kind: z.enum(['text', 'attachment', 'unknown']),
            attachmentGuids: z
              .array(TopologyAttachmentGuid)
              .max(MAX_RETRACTION_ATTACHMENTS)
              .optional(),
          })
          .loose(),
      )
      .max(MAX_RETRACTION_PARTS),
    attachmentOwnership: z
      .array(
        z
          .object({
            attachmentGuid: TopologyAttachmentGuid,
            partIndex: TopologyPartIndex,
          })
          .loose(),
      )
      .max(MAX_RETRACTION_ATTACHMENTS),
  })
  .loose()
  .refine((value) => {
    try {
      return (
        topologyUtf8Encoder.encode(JSON.stringify(value)).byteLength <=
        MAX_MESSAGE_PART_TOPOLOGY_BYTES
      );
    } catch {
      return false;
    }
  }, 'message part topology exceeds the durable storage bound');

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
 * client falls back to its read-only legacy preview cache or the raw external link.
 */
export const PayloadData = z
  .object({
    urlData: z.array(UrlPreviewItem).nullish(),
  })
  .loose();
export type PayloadData = z.infer<typeof PayloadData>;

// Keep explicit malformed/oversized values distinguishable from a genuinely absent identifier.
// The private sentinel is persisted only to choose the generic local fallback; it is never shown.
const UNKNOWN_BALLOON_BUNDLE_ID = 'gator.invalid-balloon-bundle-id';
const BalloonBundleId = z.preprocess((value) => {
  if (value == null) return value;
  if (typeof value !== 'string') return UNKNOWN_BALLOON_BUNDLE_ID;
  // SQLite's length(TEXT) stops at U+0000, so a raw NUL could pass this model's JavaScript length
  // check and then violate the database constraint. Collapse it to the same safe local sentinel as
  // every other malformed identifier before it reaches persistence.
  return value.trim().length > 0 && value.length <= 255 && !value.includes('\0')
    ? value
    : UNKNOWN_BALLOON_BUNDLE_ID;
}, z.string().max(255).nullish());

// Part metadata is server-controlled and lands in SQLite. Invalid/oversized values degrade to
// absent so one malformed message cannot reject a whole sync page or manufacture an action target.
const MessagePartIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_MESSAGE_PART_INDEX)
  .nullish()
  .catch(undefined);

/**
 * A single message (Flutter: Message). Reactions are modelled server-side as
 * "associated messages" carrying an `associatedMessageType` (e.g. "love",
 * "like", "emphasize"); threading uses `threadOriginatorGuid`.
 */
const MessageWire = z.object({
  originalROWID: z.number().nullish(),
  guid: z.string(),
  /** Google pairing generation for an epoch-qualified RCS message. */
  providerEpoch: z.string().refine(isRcsProviderEpoch).nullish(),
  text: z.string().nullish(),
  /**
   * Gator's FCM payload cap marks a long message whose text was shortened for push delivery.
   * Keep that transport fact through validation so durable intake can request normal sync for the
   * complete body. It is presentation/recovery metadata only and is never written to `messages`.
   */
  textTruncated: z.boolean().nullish(),
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
   * field). The transform below records malformed input separately instead of treating it as
   * ordinary absence: a bad retraction summary must fail closed without rejecting its whole page.
   * Persisted as JSON TEXT on the messages table; read back tolerantly via
   * {@link parseMessageSummaryInfo}.
   */
  messageSummaryInfo: z.unknown().nullish(),
  messageSummaryInfoInvalid: z.literal(true).optional().catch(undefined),

  /** Exact Apple multipart topology from a capable server; absent on old/lean payloads. */
  messagePartTopology: z.unknown().nullish(),
  /** Canonical-envelope marker: malformed topology was observed and must not regain trust. */
  messagePartTopologyInvalid: z.literal(true).optional().catch(undefined),

  /**
   * Apple rich-link preview (URL balloons): the sender-fetched LPLinkMetadata, decoded
   * server-side. Presence-driven — arrives ONLY on URL balloons with real metadata; already in
   * SYNC_WITH_QUERY, so sync + live socket/FCM deliver it once this field exists. Same
   * `.catch(undefined)` guard as `messageSummaryInfo`: a malformed value degrades to "absent"
   * (→ the read-only legacy cache or raw external link) instead of stalling the sync page.
   * Persisted as JSON TEXT; read back tolerantly via {@link parsePayloadData}.
   */
  payloadData: PayloadData.nullish().catch(undefined),

  /**
   * Apple Messages extension identifier (Digital Touch, handwriting, third-party iMessage apps,
   * and other interactive balloons). The identifier is presentation metadata only: Gator uses it
   * to replace an otherwise blank payload with a generic local label and never displays the raw
   * value. Invalid or oversized server values normalize to a private generic-fallback sentinel so
   * one bad message cannot reject a whole sync page or recreate the blank-message path.
   */
  balloonBundleId: BalloonBundleId,

  /** Number of Apple message parts currently reported for this aggregate message row. */
  partCount: MessagePartIndex,

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

  /**
   * Apple's `message.is_spam` flag (Gator server, opt-in). Sent only while the server advertises
   * `supports_apple_screening`; an ABSENT key means "unknown", never "not spam", so ingestion keeps
   * the stored value then (see `appleScreeningEmitted`).
   */
  isSpam: z.boolean().nullish(),

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
   * Exact optimistic-send correlation emitted only by capable RCS servers. The pair is transport
   * metadata: it lets success install the physical-attempt owner without relying on content.
   */
  // Keep the raw values through this boundary so the transform below can distinguish genuinely
  // absent legacy correlation from a malformed/partial modern tuple. Silently dropping a bad
  // tuple would grant permission to fall back to content matching.
  tempGuid: z.unknown().nullish(),
  attemptGuid: z.unknown().nullish(),
  clientAttemptGeneration: z.unknown().nullish(),
  // Derived during first normalization and retained in the canonical durable envelope. Accepting
  // only literal true is safe for a direct wire payload too: it can only disable heuristic matching.
  sendAttemptCorrelationInvalid: z.literal(true).optional().catch(undefined),

  /**
   * Reaction/threading linkage. Normalized on parse to the BARE target guid: the wire carries a
   * part prefix (`p:0/<guid>` / `bp:0/<guid>`) that the target message's own `guid` does not, so
   * without this strip an incoming reaction never matches its target and stays invisible. Applied
   * here at the schema boundary so EVERY ingestion path (live socket/FCM event + sync/query) is
   * covered at once. See {@link stripAssociatedGuidPrefix}.
   */
  associatedMessageGuid: z.string().nullish(),
  /** Exact target-part id for an associated message; normally derived from the raw guid prefix. */
  associatedMessagePart: MessagePartIndex,
  associatedMessageType: z.string().nullish(),
  /** Glyph of an arbitrary-emoji tapback (associatedMessageType 'emoji'/'-emoji'). */
  associatedMessageEmoji: z.string().nullish(),
  threadOriginatorGuid: z.string().nullish(),
  /** Reply target part when a future/additive server payload exposes it. */
  threadOriginatorPart: MessagePartIndex,

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

export const Message = MessageWire.transform((message) => {
  // Capture the part BEFORE normalizing `p:<n>/<guid>` to the bare target guid. Future servers may
  // send an explicit numeric field; a valid explicit value is authoritative when present.
  const rawAssociatedGuid = message.associatedMessageGuid;
  const hasCorrelationInput =
    message.sendAttemptCorrelationInvalid === true ||
    message.tempGuid != null ||
    message.attemptGuid != null ||
    message.clientAttemptGeneration != null;
  const normalizedTempGuid =
    typeof message.tempGuid === 'string' &&
    message.tempGuid.length >= 1 &&
    message.tempGuid.length <= 256
      ? message.tempGuid
      : undefined;
  const normalizedAttemptGuid =
    typeof message.attemptGuid === 'string' &&
    message.attemptGuid.length >= 1 &&
    message.attemptGuid.length <= 128
      ? message.attemptGuid
      : undefined;
  const normalizedGeneration =
    typeof message.clientAttemptGeneration === 'number' &&
    Number.isInteger(message.clientAttemptGeneration) &&
    message.clientAttemptGeneration >= 1 &&
    message.clientAttemptGeneration <= 2_147_483_647
      ? message.clientAttemptGeneration
      : undefined;
  const completeCorrelation =
    normalizedTempGuid !== undefined &&
    normalizedAttemptGuid !== undefined &&
    normalizedGeneration !== undefined;
  const summaryResult = MessageSummaryInfo.safeParse(message.messageSummaryInfo);
  const topologyResult = MessagePartTopologyModel.safeParse(message.messagePartTopology);
  const normalizedSummary =
    message.messageSummaryInfo == null
      ? message.messageSummaryInfo
      : summaryResult.success
        ? summaryResult.data
        : undefined;
  const normalizedTopology =
    message.messagePartTopology == null
      ? message.messagePartTopology
      : topologyResult.success
        ? (topologyResult.data as MessagePartTopology)
        : undefined;
  const {
    messageSummaryInfo: _rawMessageSummaryInfo,
    messagePartTopology: _rawMessagePartTopology,
    ...messageWithoutRawRetractionMetadata
  } = message;
  return {
    ...messageWithoutRawRetractionMetadata,
    ...(normalizedSummary == null ? {} : { messageSummaryInfo: normalizedSummary }),
    messageSummaryInfoInvalid:
      message.messageSummaryInfoInvalid === true ||
      (message.messageSummaryInfo != null && !summaryResult.success)
        ? (true as const)
        : undefined,
    ...(normalizedTopology == null ? {} : { messagePartTopology: normalizedTopology }),
    messagePartTopologyInvalid:
      message.messagePartTopologyInvalid === true ||
      (message.messagePartTopology != null && !topologyResult.success)
        ? (true as const)
        : undefined,
    // One-sided/malformed correlation is not exact, but it is also not legacy. Preserve a private
    // marker so reconciliation can fail closed while still storing the canonical server message.
    tempGuid: completeCorrelation ? normalizedTempGuid : undefined,
    attemptGuid: completeCorrelation ? normalizedAttemptGuid : undefined,
    clientAttemptGeneration: completeCorrelation ? normalizedGeneration : undefined,
    sendAttemptCorrelationInvalid:
      !completeCorrelation && hasCorrelationInput ? (true as const) : undefined,
    associatedMessageGuid:
      rawAssociatedGuid == null ? rawAssociatedGuid : stripAssociatedGuidPrefix(rawAssociatedGuid),
    associatedMessagePart:
      message.associatedMessagePart ?? partIndexFromAssociatedGuid(rawAssociatedGuid),
  };
});
export type Message = z.infer<typeof Message>;

/** Tolerant read-back parser for the DB's `message_part_topology` JSON TEXT column. */
export function parseMessagePartTopology(
  raw: string | null | undefined,
): MessagePartTopology | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = MessagePartTopologyModel.safeParse(parsed);
  return result.success ? (result.data as MessagePartTopology) : null;
}

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
export function parseMessageSummaryInfo(raw: string | null | undefined): MessageSummaryInfo | null {
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
 * server preview" and the read-only legacy cache or raw external link takes over. Mirror of the
 * write side (`JSON.stringify` in `upsertMessages`).
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
