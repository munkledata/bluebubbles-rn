import { z } from 'zod/v4';
import { projectServerErrorDetail } from '@core/api/serverErrorDetail';
import { Message, epochMillis } from '@core/models';
import type { ServerEventName } from '@core/config/constants';

/**
 * Zod schemas for realtime event payloads. Kept permissive (`.loose()` /
 * nullish) because payload shape varies slightly across server versions and
 * transports (socket vs FCM). We validate just enough to route safely.
 */
export const TypingIndicatorPayload = z
  .object({ guid: z.string().nullish(), chatGuid: z.string().nullish(), display: z.boolean() })
  .loose();

export const ReadStatusPayload = z
  // Current sink semantics can only advance the read marker. Stock servers call the flag `status`;
  // newer bridges may call it `read`. Reject explicit false in either spelling rather than silently
  // interpreting an unread event as read; old servers that omit both fields remain valid.
  .object({
    chatGuid: z.string().min(1),
    read: z.literal(true).nullish(),
    status: z.literal(true).nullish(),
  })
  .loose();

export const GroupChangePayload = z.object({ chats: z.array(z.unknown()).nullish() }).loose();

/**
 * The Gator RCS bridge's health alert (`rcs-alert`), relayed from the sidecar's `/events` stream.
 * Shape: `{ kind: 'alert', alertType: '<NAME>' }` — only `alertType` is load-bearing (e.g.
 * `GAIA_LOGGED_OUT`, `PHONE_NOT_RESPONDING`, `BROWSER_INACTIVE`). Permissive: newer bridge builds
 * may add alert types the app hasn't seen.
 */
export const RcsAlertPayload = z.object({ alertType: z.string().nullish() }).loose();

/**
 * The server's `rcs-bridge-down` FCM push — fired (high priority) when the RCS bridge drops or its
 * auth expires. Unlike `rcs-alert` (a raw alertType the app maps to copy), this carries a
 * ready-made `title`/`body` to show verbatim in a status notification, plus a machine `reason`.
 * Permissive so a newer server can add fields.
 */
export const RcsBridgeDownPayload = z
  .object({
    title: z.string().nullish(),
    body: z.string().nullish(),
    reason: z.string().nullish(),
  })
  .loose();

/**
 * The server's `test-notification` push — the dashboard's "Send Test Notification" button
 * (`send-test-notification` admin channel), which fans a `{ title, body }` out to every
 * registered device through the exact same dispatch + encryption path a real message uses.
 *
 * WHY IT MATTERS: this is the ONE end-to-end probe of the push chain, and until it was handled
 * here the app had no case for the event — the router hit `default: return null` and dropped it.
 * So the server reported `sent: N, failed: 0` while the phone showed nothing, which reads as
 * "push is broken" even on a perfectly healthy pipeline (and, worse, hid a genuinely broken one).
 * Diagnostics that can only report false negatives are worse than no diagnostics.
 */
export const TestNotificationPayload = z
  .object({
    title: z.string().nullish(),
    body: z.string().nullish(),
  })
  .loose();

/**
 * The server's `message-deleted` event (macOS "Recently Deleted"; fanned out over socket + webhook +
 * FCM). `guid` is the only load-bearing field — the sink resolves the owning chat from the local
 * message row, and falls back to now() for an absent delete date — so `chatGuid`/`dateDeleted` are
 * best-effort. `.loose()` + `epochMillis` coercion keep it tolerant across server/transport shapes
 * (e.g. a stringified `dateDeleted`). A guid-less payload fails this parse and is dropped at the router.
 */
export const MessageDeletedPayload = z
  .object({
    guid: z.string().min(1),
    chatGuid: z.string().nullish(),
    dateDeleted: epochMillis, // Unix ms; number | null after coercion
  })
  .loose();

export const FaceTimeStatusPayload = z
  .object({
    uuid: z.string().nullish(),
    address: z.string().nullish(), // caller display (number/email)
    caller: z.string().nullish(), // legacy incoming-facetime caller
    is_audio: z.boolean().nullish(),
    handle: z.object({ address: z.string().nullish() }).loose().nullish(),
    status_id: z.number().nullish(), // 4 = incoming, 6 = ended
  })
  .loose();

/** One or more of the user's own iMessage addresses were deregistered. */
export const AliasesRemovedPayload = z.object({ aliases: z.array(z.string()) }).loose();

const OptionalSendErrorId = z.string().min(1).nullish();
// Optional prose must never invalidate the authoritative send failure. Project it during
// normalization so durable incoming-event payloads cannot retain the raw server string.
const OptionalServerErrorDetail = z.preprocess(projectServerErrorDetail, z.string().optional());

const SendErrorMessagePayload = z
  .object({
    guid: OptionalSendErrorId,
    error: z.union([z.number(), z.string()]).nullish(),
    /** Additive prose projected before durable intake; the DB sink repeats the projection. */
    errorMessage: OptionalServerErrorDetail,
    retryable: z.boolean().nullish(),
  })
  .loose();

/**
 * A server-reported outgoing failure. A usable message identity is load-bearing: without one the
 * DB sink cannot apply the failure, while accepting an arbitrary object would falsely certify it
 * as safe to persist in the durable incoming queue.
 */
export const MessageSendErrorPayload = z
  .object({
    /** Future server-owned identity for one admitted dispatch attempt, shared by every fanout. */
    attemptGuid: OptionalSendErrorId,
    guid: OptionalSendErrorId,
    tempGuid: OptionalSendErrorId,
    messageGuid: OptionalSendErrorId,
    error: z.union([z.number(), z.string()]).nullish(),
    /** Explicit projected prose; never inferred from the numeric/string `error` code. */
    errorMessage: OptionalServerErrorDetail,
    retryable: z.boolean().nullish(),
    message: SendErrorMessagePayload.nullish(),
  })
  .loose()
  .refine(
    (payload) =>
      [payload.guid, payload.tempGuid, payload.messageGuid, payload.message?.guid].some(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    { message: 'message-send-error requires a usable message guid' },
  );

/** A validated, transport-agnostic event ready for the app to act on. */
export type NormalizedEvent =
  | { type: 'new-message'; message: Message }
  | { type: 'updated-message'; message: Message }
  // A message entered macOS "Recently Deleted". The sink TOMBSTONES the local row (never a hard
  // delete — the message stays in the Mac's chat.db and the sync path keeps returning it), so the
  // deletion survives the next sync. See DbEventSink → markMessageDeleted.
  | { type: 'message-deleted'; payload: z.infer<typeof MessageDeletedPayload> }
  | { type: 'typing-indicator'; payload: z.infer<typeof TypingIndicatorPayload> }
  | { type: 'chat-read-status-changed'; payload: z.infer<typeof ReadStatusPayload> }
  | { type: 'group-name-change'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-added'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-removed'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-left'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'ft-call-status-changed'; payload: z.infer<typeof FaceTimeStatusPayload> }
  | { type: 'incoming-facetime'; payload: z.infer<typeof FaceTimeStatusPayload> }
  | { type: 'imessage-aliases-removed'; payload: z.infer<typeof AliasesRemovedPayload> }
  // The server forwards the helper's outgoing-send failure (Messages.app rejected the send).
  | { type: 'message-send-error'; payload: z.infer<typeof MessageSendErrorPayload> }
  // The server's public URL rotated (e.g. the zrok tunnel) — reconnect to the new origin.
  | { type: 'new-server'; url: string }
  // The Gator RCS bridge relayed a health alert (phone offline / browser inactive / cookies
  // expired). UI-only — surfaced on the Server Health screen; never written to the DB.
  | { type: 'rcs-alert'; payload: z.infer<typeof RcsAlertPayload> }
  // The server's RCS bridge dropped / auth expired — posts a content-less status notification
  // from the server-supplied title/body. Never written to the DB.
  | { type: 'rcs-bridge-down'; payload: z.infer<typeof RcsBridgeDownPayload> }
  // The server's push self-test ("Send Test Notification"). Posts a status notification and is
  // never written to the DB — its only job is to prove the server→FCM→device chain end to end.
  | { type: 'test-notification'; payload: z.infer<typeof TestNotificationPayload> };

/**
 * Pure, transport-free description of a notification to show (or clear). Emitted
 * by the event pipeline and consumed by the Notifee service — kept free of any
 * native types so `core/` stays React-free and Node-testable. Message and FaceTime
 * intents carry ordinary detailed fields; App Lock independently substitutes its
 * fixed generic notice before native presentation.
 */
export type NotificationIntent =
  | {
      kind: 'message';
      chatGuid: string;
      chatTitle: string; // group name / participants / sender display name
      senderName: string;
      senderHandle: string;
      body: string;
      messageGuid: string;
      timestamp: number;
      isGroup: boolean;
      avatarUri?: string;
    }
  /** Fixed-copy local notice for an outgoing row that is durably in the error state. */
  | { kind: 'send-failure'; chatGuid: string; messageGuid: string }
  /** Withdraw that fixed-copy notice after success/echo reconciliation. */
  | { kind: 'send-failure-cancel'; chatGuid: string; messageGuid: string }
  | { kind: 'cancel'; chatGuid: string }
  | {
      kind: 'facetime-call';
      uuid: string;
      callerName: string;
      isAudio: boolean;
      avatarUri?: string;
    }
  | { kind: 'facetime-cancel'; uuid: string }
  /** One or more of the user's own iMessage aliases were deregistered server-side (F-6). */
  | { kind: 'alias-removed'; aliases: string[] }
  /** The RCS bridge dropped / auth expired — a status notice with no conversation message
   *  content, so no contact/content lookup is needed. Title/body come from the server push. */
  | { kind: 'rcs-bridge-down'; title: string; body: string }
  /** The server's push self-test landed. It contains no conversation message content, so no
   *  contact/content lookup is needed; seeing it on the lock screen is the successful result. */
  | { kind: 'test-notification'; title: string; body: string };

export type { ServerEventName };
