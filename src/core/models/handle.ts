import { z } from 'zod';
import { ServiceType } from './common';

/** A phone number or email address that participates in chats (Flutter: Handle). */
export const Handle = z.object({
  originalROWID: z.number().nullish(),
  address: z.string(),
  service: ServiceType.nullish(),
  country: z.string().nullish(),
  uncanonicalizedId: z.string().nullish(),
  /** Per-handle bubble color (hex), used by "colorful bubbles". */
  color: z.string().nullish(),
  displayName: z.string().nullish(),
});
export type Handle = z.infer<typeof Handle>;
