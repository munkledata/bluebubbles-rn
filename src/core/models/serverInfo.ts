import { z } from 'zod';

/** Subset of GET /api/v1/server/info used for version gating and discovery. */
export const ServerInfo = z.object({
  server_version: z.string(),
  os_version: z.string().nullish(),
  private_api: z.boolean().nullish(),
  proxy_service: z.string().nullish(),
  /** Whether the server accepts header-based auth (rebuild requirement). */
  supports_header_auth: z.boolean().nullish(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;
