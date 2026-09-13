import { z } from 'zod/v4';

/** Hard client ceiling even if a malformed server advertises a larger caption allowance. */
export const MAX_SEND_ATTACHMENT_TEXT_BYTES = 65_536;

/**
 * Subset of GET /api/v1/server/info used for version gating and discovery.
 *
 * Wire-shape tolerance: the upstream app emits `server_version` (+ os_version,
 * private_api, proxy_service); the Gator fork's `coreOperations` emits only `{ version }`.
 * We accept either and coalesce into `server_version` so a Gator server parses (previously
 * the required `server_version` made `.parse` throw → connect failed). Fields the Gator
 * fork doesn't send stay nullish and degrade gracefully (e.g. private_api → apple-script).
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
    /**
     * Whether the server can detect message deletions (macOS "Recently Deleted") and emit the
     * `message-deleted` event. Additive; absent/false on older servers, which simply never emit the
     * event. Reflects a LIVE capability (the table+column must exist on the Mac), so it can flip
     * across reconnects. No UI gates on it today — DbEventSink applies deletions unconditionally (an
     * old server just never sends one); the accessor/hook exist for future affordances.
     */
    supports_message_deleted: z.boolean().nullish(),
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
    /** Whether the currently connected iMessage helper consumes text with the attachment. */
    supports_imessage_text_with_attachment: z.boolean().nullish(),
    /** Whether message payloads can carry bounded, exact Apple multipart topology. */
    supports_message_part_topology: z.boolean().nullish(),
    /**
     * Whether the server can read/modify the signed-in iMessage account — the `icloud/account`
     * endpoints (Apple ID, display name, and the send-from alias picker) that require the Private-API
     * helper. Additive; absent/false on older servers (the route 404s → the screen shows "unsupported").
     * The app gates the Settings "iMessage Account" row on this. Reflects a LIVE capability (true iff
     * Private API is on), so it can flip across reconnects — the account screen keeps a 404 fallback.
     */
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
  .transform((s) => ({ ...s, server_version: s.server_version ?? s.version ?? undefined }));
export type ServerInfo = z.infer<typeof ServerInfo>;
