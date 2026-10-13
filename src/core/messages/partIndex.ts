import { MAX_MESSAGE_PART_INDEX } from '../reactions/reactionType';
import { isExactMessagePartTopology, type MessagePartTopology } from './retraction';

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

export interface ExactMessagePartLayout extends MessagePartLayout {
  /** Parsed server topology. A present but incomplete value never permits a legacy guess. */
  topology: MessagePartTopology | null | undefined;
  /** A capable server must prove topology; only an older server may use the compatibility rule. */
  topologySupported: boolean | null;
  /** Stable GUIDs of the ordinary attachments that are currently visible for this message. */
  visibleAttachmentGuids: readonly string[];
}

/**
 * Resolve an action target without treating an unknown part as part zero.
 *
 * Complete server topology is authoritative. If it is absent on a known older server, retain the
 * bounded compatibility heuristic. Every inconsistent, incomplete, or ambiguous modern layout
 * returns `undefined`, so callers can disable/abort a destructive or server-mutating action.
 */
export function resolveExactMessageTargetPartIndex(
  layout: ExactMessagePartLayout,
): number | undefined {
  const { topology } = layout;
  if (topology != null) {
    if (!isExactMessagePartTopology(topology)) return undefined;
    // The UI exposes one action surface for the whole bubble. More than one surviving part is
    // therefore ambiguous even if exactly one of them is text: a press on a mixed bubble cannot
    // prove which rendered part the user intended.
    if (topology.currentParts.length !== 1) return undefined;
    const onlyPart = topology.currentParts[0];
    if (!onlyPart || onlyPart.kind === 'unknown') return undefined;

    if (onlyPart.kind === 'text') {
      return layout.hasText && layout.visibleAttachmentGuids.length === 0
        ? onlyPart.index
        : undefined;
    }

    if (!layout.hasText && layout.visibleAttachmentGuids.length > 0) {
      const ownerByGuid = new Map(
        topology.attachmentOwnership.map(
          (entry) => [entry.attachmentGuid, entry.partIndex] as const,
        ),
      );
      for (const attachmentGuid of new Set(layout.visibleAttachmentGuids)) {
        const owner = ownerByGuid.get(attachmentGuid);
        if (owner !== onlyPart.index) return undefined;
      }
      return onlyPart.index;
    }

    return undefined;
  }

  if (layout.topologySupported !== false) return undefined;
  return resolveTargetPartIndex(layout);
}
