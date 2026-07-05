import { z } from 'zod';
import { Message } from '@core/models';
import type { ServerEventName } from '@core/config/constants';

/**
 * Zod schemas for realtime event payloads. Kept permissive (`.passthrough()` /
 * nullish) because payload shape varies slightly across server versions and
 * transports (socket vs FCM). We validate just enough to route safely.
 */
export const TypingIndicatorPayload = z
  .object({ guid: z.string().nullish(), chatGuid: z.string().nullish(), display: z.boolean() })
  .passthrough();

export const ReadStatusPayload = z
  .object({ chatGuid: z.string(), read: z.boolean().nullish() })
  .passthrough();

export const GroupChangePayload = z.object({ chats: z.array(z.unknown()).nullish() }).passthrough();

/**
 * The Gator RCS bridge's health alert (`rcs-alert`), relayed from the sidecar's `/events` stream.
 * Shape: `{ kind: 'alert', alertType: '<NAME>' }` — only `alertType` is load-bearing (e.g.
 * `GAIA_LOGGED_OUT`, `PHONE_NOT_RESPONDING`, `BROWSER_INACTIVE`). Permissive: newer bridge builds
 * may add alert types the app hasn't seen.
 */
export const RcsAlertPayload = z.object({ alertType: z.string().nullish() }).passthrough();

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
  .passthrough();

export const FaceTimeStatusPayload = z
  .object({
    uuid: z.string().nullish(),
    address: z.string().nullish(), // caller display (number/email)
    caller: z.string().nullish(), // legacy incoming-facetime caller
    is_audio: z.boolean().nullish(),
    handle: z.object({ address: z.string().nullish() }).passthrough().nullish(),
    status_id: z.number().nullish(), // 4 = incoming, 6 = ended
  })
  .passthrough();

/** A validated, transport-agnostic event ready for the app to act on. */
export type NormalizedEvent =
  | { type: 'new-message'; message: Message }
  | { type: 'updated-message'; message: Message }
  | { type: 'typing-indicator'; payload: z.infer<typeof TypingIndicatorPayload> }
  | { type: 'chat-read-status-changed'; payload: z.infer<typeof ReadStatusPayload> }
  | { type: 'group-name-change'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-added'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-removed'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'participant-left'; payload: z.infer<typeof GroupChangePayload> }
  | { type: 'ft-call-status-changed'; payload: z.infer<typeof FaceTimeStatusPayload> }
  | { type: 'incoming-facetime'; payload: z.infer<typeof FaceTimeStatusPayload> }
  | { type: 'imessage-aliases-removed'; payload: Record<string, unknown> }
  // The server forwards the helper's outgoing-send failure (Messages.app rejected the send).
  | { type: 'message-send-error'; payload: Record<string, unknown> }
  // The server's public URL rotated (e.g. the zrok tunnel) — reconnect to the new origin.
  | { type: 'new-server'; url: string }
  // The Gator RCS bridge relayed a health alert (phone offline / browser inactive / cookies
  // expired). UI-only — surfaced on the Server Health screen; never written to the DB.
  | { type: 'rcs-alert'; payload: z.infer<typeof RcsAlertPayload> }
  // The server's RCS bridge dropped / auth expired — posts a content-less status notification
  // from the server-supplied title/body. Never written to the DB.
  | { type: 'rcs-bridge-down'; payload: z.infer<typeof RcsBridgeDownPayload> };

/**
 * Pure, transport-free description of a notification to show (or clear). Emitted
 * by the event pipeline and consumed by the Notifee service — kept free of any
 * native types so `core/` stays React-free and Node-testable. Redaction (hiding
 * the body) is applied by the notification service, not here.
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
  /** The RCS bridge dropped / auth expired — a content-less server status notice (no private
   *  content, so no redaction needed). Title/body are supplied by the server push. */
  | { kind: 'rcs-bridge-down'; title: string; body: string };

export type { ServerEventName };
