import { z } from 'zod/v4';

/**
 * Shared zod helpers. Gator timestamps arrive as epoch-millis numbers
 * (sometimes as numeric strings); coerce defensively at the boundary so the
 * rest of the app works with `number | null`.
 */
export const epochMillis = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : null;
  });

// Apple service for a handle/message. OPEN string at the wire boundary, NOT a closed enum:
// chat.db's handle.service column can hold values beyond iMessage/SMS (e.g. "RCS" on newer
// macOS, legacy carrier strings) and the server emits it verbatim. The Gator RCS bridge
// reuses this exact field, tagging its handles/messages `service: "RCS"` (chats keyed
// `RCS;-;<id>`) so they ride the frozen v1 pipeline unchanged. Because a query/message page is
// validated as ONE hard array parse, a single unknown service bound to a closed enum would fail
// the ENTIRE page (a sync stall). Matching the legacy Flutter `String service` contract avoids
// that; the UI distinguishes the known values (else renders iMessage).
export const KNOWN_SERVICES = ['iMessage', 'SMS', 'RCS'] as const;
export const ServiceType = z.string();
export type ServiceType = z.infer<typeof ServiceType>;

/** Envelope every Gator REST response is wrapped in: { status, data, message }. */
export function apiResponse<T extends z.ZodType>(data: T) {
  return z.object({
    status: z.number(),
    message: z.string().optional(),
    data,
  });
}
