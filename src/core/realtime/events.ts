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
  | { type: 'new-server'; url: string };

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
  | { kind: 'alias-removed'; aliases: string[] };

export type { ServerEventName };
