import { z } from 'zod';

/**
 * Subset of GET /api/v1/server/info used for version gating and discovery.
 *
 * Wire-shape tolerance: upstream BlueBubbles emits `server_version` (+ os_version,
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
     * Gator RCS bridge enabled (additive; absent/false on older servers). When true the server
     * serves RCS chats through the same v1 endpoints (`RCS;-;` guids, `service:"RCS"`). The app
     * needs no gate to RECEIVE them (they just appear in the list) — this flag lets RCS-specific
     * UI (e.g. an RCS option in new-chat, Prompt 8) show only when the bridge is live.
     */
    rcs: z.boolean().nullish(),
  })
  .transform((s) => ({ ...s, server_version: s.server_version ?? s.version ?? undefined }));
export type ServerInfo = z.infer<typeof ServerInfo>;
