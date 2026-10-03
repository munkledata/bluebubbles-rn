import { z } from 'zod/v4';
import { currentRcsProviderEpoch, isRcsProviderEpoch } from '../rcs/providerIdentity';

/** Hard client ceiling even if a malformed server advertises a larger caption allowance. */
export const MAX_SEND_ATTACHMENT_TEXT_BYTES = 65_536;
/** The narrow helper-backed attachment slice admits one JPEG, PNG, or PDF up to 10 MiB. */
export const MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024;
/** One recorded AAC/MPEG-4 voice note uses the same bounded file budget. */
export const MAX_IMESSAGE_VOICE_UPLOAD_BYTES = MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES;
/** Existing scheduled-message JSON/store budget permits one smaller file. */
export const MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES = 512 * 1024;
/** A group photo is streamed once and capped to match the narrow server route. */
export const MAX_IMESSAGE_GROUP_PHOTO_BYTES = 20 * 1024 * 1024;

export function isSupportedImessageAttachmentType(mimeType: string, name: string): boolean {
  return (
    (mimeType === 'image/jpeg' && /\.jpe?g$/i.test(name)) ||
    (mimeType === 'image/png' && /\.png$/i.test(name)) ||
    (mimeType === 'application/pdf' && /\.pdf$/i.test(name))
  );
}

export function isSupportedImessageVoiceType(mimeType: string, name: string): boolean {
  return mimeType === 'audio/mp4' && /\.m4a$/i.test(name);
}

export function isSupportedImessageGroupPhotoType(mimeType: string, name: string): boolean {
  return (
    (mimeType === 'image/jpeg' && /\.jpe?g$/i.test(name)) ||
    (mimeType === 'image/png' && /\.png$/i.test(name))
  );
}

/**
 * Subset of GET /api/v1/server/info used for version gating and discovery.
 *
 * Wire-shape tolerance: the upstream app emits `server_version` (+ os_version,
 * private_api, proxy_service); the Gator fork's `coreOperations` emits only `{ version }`.
 * We accept either and coalesce into `server_version` so a Gator server parses (previously
 * the required `server_version` made `.parse` throw → connect failed). Fields the Gator
 * fork doesn't send stay nullish and degrade gracefully. Private API fields are accepted for
 * wire compatibility but normalized to the current release's permanent-retirement policy.
 */
export const ServerInfo = z
  .object({
    server_version: z.string().nullish(),
    /** Gator fork emits this instead of `server_version`. */
    version: z.string().nullish(),
    os_version: z.string().nullish(),
    private_api: z.boolean().nullish(),
    proxy_service: z.string().nullish(),
    /** Whether the server accepts header-based auth (rebuild requirement). */
    supports_header_auth: z.boolean().nullish(),
    /** Whether this server accepts per-device, scoped, independently revocable credentials. */
    supports_scoped_device_credentials: z.boolean().nullish(),
    /** Whether device registration accepts and acknowledges a random per-device FCM key. */
    supports_fcm_device_encryption: z.boolean().nullish(),
    /** Whether a scoped client can enroll the final identity-bound V3 push scheme. */
    supports_fcm_push_encryption_v3: z.boolean().nullish(),
    /** Whether V3 registration supports versioned, idempotent in-place push-key rotation. */
    supports_fcm_push_key_rotation: z.boolean().nullish(),
    /**
     * Whether RCS acknowledgements and success/error events carry one exact server-owned physical
     * attempt identity. Only this explicit capability enables client-side attempt-owner fencing;
     * older servers keep the legacy temp-guid/content reconciliation path.
     */
    supports_rcs_send_attempt_ownership: z.boolean().nullish(),
    /** Whether all app-facing RCS ids carry the current persisted Google pairing epoch. */
    supports_rcs_epoch_qualified_ids: z.boolean().nullish(),
    /** Opaque current Google pairing epoch; null while the RCS identity is unavailable. */
    rcs_provider_epoch: z.string().refine(isRcsProviderEpoch).nullable().optional(),
    /**
     * Whether the server can detect message deletions (macOS "Recently Deleted") and emit the
     * `message-deleted` event. Additive; absent/false on older servers, which simply never emit the
     * event. Reflects a LIVE capability (the table+column must exist on the Mac), so it can flip
     * across reconnects. No UI gates on it today — DbEventSink applies deletions unconditionally (an
     * old server just never sends one); the accessor/hook exist for future affordances.
     */
    supports_message_deleted: z.boolean().nullish(),
    /** Whether the server can hold one stable view across multi-request sync/repair crawls. */
    supports_repair_snapshot: z.boolean().nullish(),
    supports_message_state_sync: z.boolean().nullish(),
    message_state_sync_version: z.number().int().nullish(),
    imessage_provider_epoch: z.string().uuid().nullish(),
    supports_provider_repair_snapshot: z.boolean().nullish(),
    /**
     * Whether the server exposes bounded text search over its live Messages database. Additive;
     * absent/false on older servers, so global search remains local-only until support is explicit.
     */
    supports_message_search: z.boolean().nullish(),
    /**
     * Whether the server can build + send a contact card from structured fields — the
     * `send-contact` action (`POST /api/v1/message/contact`) that assembles a vCard 3.0 server-side
     * and ships it as an attachment. Additive; absent/false on older servers. The app gates the
     * composer's "Contact" affordance on this so it never offers a send the server can't fulfil.
     */
    supports_send_contact: z.boolean().nullish(),
    /** Whether the RCS media route consumes body text in the same logical send. */
    supports_rcs_text_with_attachment: z.boolean().nullish(),
    /** Retired broad helper flag. Narrow one-file captions use their own capability below. */
    supports_imessage_text_with_attachment: z.boolean().nullish(),
    /** Whether the server exposes the read-only iMessage reachability lookup. */
    supports_imessage_availability: z.boolean().nullish(),
    /** Read-only status of the Mac's signed-in iMessage account; never authorizes alias changes. */
    supports_imessage_account_status: z.boolean().nullish(),
    /** A separately reviewed send-from-alias change with fresh vetted-alias checks and readback. */
    supports_imessage_alias_change: z.boolean().nullish(),
    /** Separately gated typing start/stop for a proven existing one-to-one iMessage chat. */
    supports_imessage_typing: z.boolean().nullish(),
    /** Mark read/unread on a proven existing one-to-one iMessage chat. */
    supports_imessage_read_state: z.boolean().nullish(),
    /** One recorded M4A voice note to an existing one-to-one iMessage chat. */
    supports_imessage_voice_upload: z.boolean().nullish(),
    /** Whether the authenticated Messages helper can create one-to-one iMessage chats. */
    supports_imessage_new_chat: z.boolean().nullish(),
    /** One file upload to a proven existing one-to-one iMessage chat. */
    supports_imessage_attachment_upload: z.boolean().nullish(),
    /** PDF is an additive exception; older image-only helpers must not expose it. */
    supports_imessage_pdf_attachment_upload: z.boolean().nullish(),
    /** A separate narrow gate for nonblank text sent with that same one-file iMessage upload. */
    supports_imessage_attachment_caption_upload: z.boolean().nullish(),
    /** One bounded plain-text send whose durable acknowledgement carries the native message GUID. */
    supports_imessage_plain_text: z.boolean().nullish(),
    /** Classic tapbacks on a proven existing one-to-one iMessage, independent of broad Private API. */
    supports_imessage_reactions: z.boolean().nullish(),
    /** Plain-text reply to exact part zero in a proven existing one-to-one iMessage chat. */
    supports_imessage_replies: z.boolean().nullish(),
    /** Plain-text edit of exact part zero in a proven existing one-to-one iMessage chat. */
    supports_imessage_edit: z.boolean().nullish(),
    /** Plain-text unsend of exact part zero in a proven existing one-to-one iMessage chat. */
    supports_imessage_unsend: z.boolean().nullish(),
    /** Delete one whole stored message from an exact existing iMessage chat on the Mac. */
    supports_imessage_remote_delete: z.boolean().nullish(),
    /** One allowlisted bubble/screen effect in a proven existing one-to-one iMessage chat. */
    supports_imessage_effects: z.boolean().nullish(),
    /** Rename one exact existing iMessage group through the dedicated helper command. */
    supports_imessage_group_rename: z.boolean().nullish(),
    /** Set or remove the photo for one exact existing iMessage group. */
    supports_imessage_group_photo: z.boolean().nullish(),
    /** Add one canonical address to one exact existing iMessage group. */
    supports_imessage_group_participant_add: z.boolean().nullish(),
    /** Remove one exact existing member from one exact iMessage group. */
    supports_imessage_group_participant_remove: z.boolean().nullish(),
    /** Leave one exact existing iMessage group through the dedicated narrow command. */
    supports_imessage_group_leave: z.boolean().nullish(),
    /** Create one plain Apple FaceTime bearer link through its dedicated narrow command. */
    supports_facetime_link_creation: z.boolean().nullish(),
    /** Start one audio/video FaceTime call to one canonical address. */
    supports_facetime_call_start: z.boolean().nullish(),
    /** Answer one exact incoming FaceTime call through its dedicated narrow command. */
    supports_facetime_call_answer: z.boolean().nullish(),
    /** Leave one exact FaceTime call through its dedicated narrow command. */
    supports_facetime_call_leave: z.boolean().nullish(),
    /** One text send with bounded mention ranges in a proven existing iMessage group. */
    supports_imessage_mentions: z.boolean().nullish(),
    /** One text send with bounded formatting ranges in a proven one-to-one iMessage chat. */
    supports_imessage_formatted_messages: z.boolean().nullish(),
    /** One foreground-acquired current-location card to a proven one-to-one iMessage chat. */
    supports_imessage_location: z.boolean().nullish(),
    /** One small, one-time server-owned iMessage attachment schedule. */
    supports_imessage_scheduled_attachment: z.boolean().nullish(),
    /** Whether message payloads can carry bounded, exact Apple multipart topology. */
    supports_message_part_topology: z.boolean().nullish(),
    /** Retired broad iCloud account/alias-control flag; never enables the read-only status screen. */
    supports_icloud_account: z.boolean().nullish(),
    /**
     * Gator RCS bridge enabled (additive; absent/false on older servers). When true the server
     * serves RCS chats through the same v1 endpoints (`RCS;-;` guids, `service:"RCS"`). The app
     * needs no gate to RECEIVE them (they just appear in the list) — this flag lets RCS-specific
     * UI (e.g. an RCS option in new-chat, Prompt 8) show only when the bridge is live.
     */
    rcs: z.boolean().nullish(),
    /**
     * Whether the server accepts client error-report uploads (`POST /api/v1/error-reports`) and
     * writes categorized logs to disk. Reflects a LIVE capability — the server sets it to its
     * `errorLogIngestionEnabled` config, so it flips when the operator toggles ingestion. Additive;
     * absent/false on older servers. The app gates uploads on this so it never POSTs to a server
     * that would just drop them.
     */
    supports_error_log_upload: z.boolean().nullish(),
    /** Whether the server can retrieve bounded link text/images through its SSRF-safe proxy. */
    supports_url_preview_proxy: z.boolean().nullish(),
  })
  .transform((s) => ({
    ...s,
    server_version: s.server_version ?? s.version ?? undefined,
    private_api: false as boolean,
    supports_imessage_text_with_attachment: false as boolean,
    supports_icloud_account: false as boolean,
  }));
// Callers may still construct the tolerant wire shape (old servers omit most capability fields).
// `ServerInfo.parse(...)` returns the normalized output, while this public type deliberately keeps
// those incoming fields optional so task-local fixtures and partial capability snapshots stay valid.
export type ServerInfo = z.input<typeof ServerInfo>;

/**
 * Apply the current release's permanent Private API retirement to any already-typed capability
 * object. This covers task-local/test-injected capability sources that did not cross the wire
 * schema, so an old or forged server response cannot restore helper authority.
 */
export function retirePrivateApiCapabilities(info: ServerInfo): ServerInfo {
  if (
    info.private_api === false &&
    info.supports_imessage_text_with_attachment === false &&
    info.supports_icloud_account === false
  ) {
    return info;
  }
  return {
    ...info,
    private_api: false,
    supports_imessage_text_with_attachment: false,
    supports_icloud_account: false,
  };
}

/** Stable identity for only the server flags that can change outgoing-send safety or encoding. */
export function serverSendCapabilityKey(info: ServerInfo | null | undefined): string {
  if (!info) return 'unknown';
  const flags = [
    info.rcs === true,
    info.supports_rcs_send_attempt_ownership === true,
    info.supports_rcs_epoch_qualified_ids === true,
    info.supports_message_part_topology === true,
    info.supports_rcs_text_with_attachment === true,
    info.supports_imessage_attachment_upload === true,
    info.supports_imessage_pdf_attachment_upload === true,
    info.supports_imessage_attachment_caption_upload === true,
    info.supports_imessage_plain_text === true,
    info.supports_imessage_reactions === true,
    info.supports_imessage_replies === true,
    info.supports_imessage_edit === true,
    info.supports_imessage_unsend === true,
    info.supports_imessage_remote_delete === true,
    info.supports_imessage_effects === true,
    info.supports_imessage_group_rename === true,
    info.supports_imessage_group_photo === true,
    info.supports_imessage_group_participant_add === true,
    info.supports_imessage_group_participant_remove === true,
    info.supports_imessage_group_leave === true,
    info.supports_facetime_link_creation === true,
    info.supports_facetime_call_start === true,
    info.supports_facetime_call_answer === true,
    info.supports_facetime_call_leave === true,
    info.supports_imessage_mentions === true,
    info.supports_imessage_formatted_messages === true,
    info.supports_imessage_location === true,
    info.supports_imessage_scheduled_attachment === true,
    info.supports_imessage_voice_upload === true,
    info.supports_send_contact === true,
  ]
    .map(Number)
    .join('');
  return `${flags}|${currentRcsProviderEpoch(info) ?? ''}`;
}
