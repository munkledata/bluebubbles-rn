import { z } from 'zod';

/**
 * Shared zod helpers. BlueBubbles timestamps arrive as epoch-millis numbers
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

/** Apple service for a handle/message: iMessage or SMS. */
export const ServiceType = z.enum(['iMessage', 'SMS']);
export type ServiceType = z.infer<typeof ServiceType>;

/** Envelope every BlueBubbles REST response is wrapped in: { status, data, message }. */
export function apiResponse<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    status: z.number(),
    message: z.string().optional(),
    data,
  });
}
