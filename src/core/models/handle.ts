import { z } from 'zod/v4';
import { ServiceType } from './common';

const HANDLE_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Canonicalize a device-owned handle color for storage/rendering. */
export function normalizeHandleColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  return HANDLE_COLOR_RE.test(color) ? color.toUpperCase() : null;
}

/** A phone number or email address that participates in chats (Flutter: Handle). */
export const Handle = z.object({
  originalROWID: z.number().nullish(),
  address: z.string(),
  service: ServiceType.nullish(),
  country: z.string().nullish(),
  uncanonicalizedId: z.string().nullish(),
  /** Device-owned per-handle avatar/bubble color. Inbound server values are ignored. */
  color: z.string().nullish(),
  displayName: z.string().nullish(),
});
export type Handle = z.infer<typeof Handle>;
