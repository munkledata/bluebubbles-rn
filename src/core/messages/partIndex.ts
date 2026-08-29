import type { MessageSummaryInfo } from '../models/message';
import { MAX_MESSAGE_PART_INDEX } from '../reactions/reactionType';

export interface MessagePartLayout {
  /** Visible, ordinary attachments only; hidden extension payloads do not own rendered parts. */
  attachmentCount: number;
  hasText: boolean;
  partCount: number | null | undefined;
}

/**
 * Resolve the text part represented by Gator's aggregate bubble.
 *
 * Apple stores the common captioned-attachment layout as attachments first, then text. We use the
 * attachment count only when the server's partCount positively proves that index exists. Every
 * unknown, text-only, attachment-only, malformed, or inconsistent layout keeps the compatible
 * part-zero fallback instead of guessing at a destructive target.
 */
export function resolveTargetPartIndex(layout: MessagePartLayout): number {
  const { attachmentCount, hasText, partCount } = layout;
  if (!hasText || !Number.isSafeInteger(attachmentCount) || attachmentCount <= 0) return 0;
  if (!Number.isSafeInteger(partCount) || partCount == null || partCount <= 1) return 0;
  if (attachmentCount > MAX_MESSAGE_PART_INDEX || attachmentCount >= partCount) return 0;
  return attachmentCount;
}

/**
 * A re-edit must target the part Apple already recorded. Ambiguous/malformed histories return null
 * so callers can fall back to the strict visible-layout resolver.
 */
export function editedPartFromSummary(info: MessageSummaryInfo | null | undefined): number | null {
  const keys = Object.keys(info?.editedParts ?? {});
  if (keys.length !== 1 || !/^(0|[1-9]\d*)$/.test(keys[0] ?? '')) return null;
  const partIndex = Number(keys[0]);
  return Number.isSafeInteger(partIndex) && partIndex <= MAX_MESSAGE_PART_INDEX ? partIndex : null;
}
