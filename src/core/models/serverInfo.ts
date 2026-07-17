import { z } from 'zod/v4';

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
    /**
     * Whether the server can detect message deletions (macOS "Recently Deleted") and emit the
     * `message-deleted` event. Additive; absent/false on older servers, which simply never emit the
     * event. Reflects a LIVE capability (the table+column must exist on the Mac), so it can flip
     * across reconnects. No UI gates on it today — DbEventSink applies deletions unconditionally (an
     * old server just never sends one); the accessor/hook exist for future affordances.
     */
    supports_message_deleted: z.boolean().nullish(),
    /**
     * Whether the server can build + send a contact card from structured fields — the
     * `send-contact` action (`POST /api/v1/message/contact`) that assembles a vCard 3.0 server-side
     * and ships it as an attachment. Additive; absent/false on older servers. The app gates the
     * composer's "Contact" affordance on this so it never offers a send the server can't fulfil.
     */
    supports_send_contact: z.boolean().nullish(),
    /**
     * Gator RCS bridge enabled (additive; absent/false on older servers). When true the server
     * serves RCS chats through the same v1 endpoints (`RCS;-;` guids, `service:"RCS"`). The app
     * needs no gate to RECEIVE them (they just appear in the list) — this flag lets RCS-specific
     * UI (e.g. an RCS option in new-chat, Prompt 8) show only when the bridge is live.
     */
    rcs: z.boolean().nullish(),
  })
  .transform((s) => ({ ...s, server_version: s.server_version ?? s.version ?? undefined }));
export type ServerInfo = z.infer<typeof ServerInfo>;
