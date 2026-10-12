export const MAX_RETRACTION_PART_INDEX = 10_000;
/** Apple lets a sent iMessage be unsent for two minutes. */
export const IMESSAGE_UNSEND_WINDOW_MS = 2 * 60_000;
export const MAX_RETRACTION_PARTS = 128;
export const MAX_RETRACTION_ATTACHMENTS = 256;
export const MAX_RETRACTION_ATTACHMENT_GUID_BYTES = 1_024;
export const MAX_MESSAGE_PART_TOPOLOGY_BYTES = 1_048_576;

export type MessageRetractionState = 'intact' | 'partial' | 'fully-retracted' | 'unknown';

export interface MessagePartTopology {
  complete: boolean;
  originalPartIndexes: number[];
  currentParts: Array<{
    index: number;
    kind: 'text' | 'attachment' | 'unknown';
    attachmentGuids?: string[];
  }>;
  attachmentOwnership: Array<{
    attachmentGuid: string;
    partIndex: number;
  }>;
}

export interface MessageRetractionEvidence {
  dateRetracted?: unknown;
  retractedParts?: unknown;
  topology?: unknown;
}

export interface MessageRetractionClassification {
  state: MessageRetractionState;
  /** True only when the supplied topology is complete, valid, and exact for this classification. */
  topologyComplete: boolean;
  provenVisiblePartIndexes: ReadonlySet<number>;
  provenVisibleTextPartIndexes: ReadonlySet<number>;
  provenVisibleAttachmentGuids: ReadonlySet<string>;
}

/** Presentation fallback for migrated rows whose durable classifier column is still NULL. */
export function isAggregateRetractionTombstone(input: {
  retractionState?: string | null;
  dateRetracted?: number | null;
}): boolean {
  if (input.retractionState === 'partial' || input.retractionState === 'intact') return false;
  if (input.retractionState === 'fully-retracted' || input.retractionState === 'unknown') {
    return true;
  }
  return input.dateRetracted != null;
}

interface ValidatedCurrentPart {
  index: number;
  kind: 'text' | 'attachment';
  attachmentGuids: Set<string> | null;
}

interface ValidatedTopology {
  originalPartIndexes: Set<number>;
  currentParts: Map<number, ValidatedCurrentPart>;
  attachmentOwnership: Map<string, number>;
}

/** True only for a complete, internally consistent topology that is safe to use for actions. */
export function isExactMessagePartTopology(value: unknown): value is MessagePartTopology {
  return validateTopology(value) != null;
}

const utf8Encoder = new TextEncoder();

function emptyClassification(state: MessageRetractionState): MessageRetractionClassification {
  return {
    state,
    topologyComplete: false,
    provenVisiblePartIndexes: new Set(),
    provenVisibleTextPartIndexes: new Set(),
    provenVisibleAttachmentGuids: new Set(),
  };
}

function isPartIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RETRACTION_PART_INDEX
  );
}

function parsePartIndexSet(value: unknown): Set<number> | null {
  if (!Array.isArray(value) || value.length > MAX_RETRACTION_PARTS) return null;

  const indexes = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isPartIndex(value[index])) return null;
    indexes.add(value[index]);
  }
  return indexes;
}

function isAttachmentGuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RETRACTION_ATTACHMENT_GUID_BYTES &&
    utf8Encoder.encode(value).byteLength <= MAX_RETRACTION_ATTACHMENT_GUID_BYTES &&
    value.trim() === value &&
    !value.includes('\0')
  );
}

function parseAttachmentGuidSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.length > MAX_RETRACTION_ATTACHMENTS) return null;

  const guids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isAttachmentGuid(value[index])) return null;
    guids.add(value[index]);
  }
  return guids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function validateTopology(value: unknown): ValidatedTopology | null {
  if (!isRecord(value) || value.complete !== true) return null;

  const originalPartIndexes = parsePartIndexSet(value.originalPartIndexes);
  if (originalPartIndexes == null || originalPartIndexes.size === 0) return null;
  if (!Array.isArray(value.currentParts) || value.currentParts.length > MAX_RETRACTION_PARTS) {
    return null;
  }
  if (
    !Array.isArray(value.attachmentOwnership) ||
    value.attachmentOwnership.length > MAX_RETRACTION_ATTACHMENTS
  ) {
    return null;
  }

  const currentParts = new Map<number, ValidatedCurrentPart>();
  const allAttachmentGuids = new Set<string>();
  for (let offset = 0; offset < value.currentParts.length; offset += 1) {
    if (!(offset in value.currentParts)) return null;
    const candidate: unknown = value.currentParts[offset];
    if (!isRecord(candidate) || !isPartIndex(candidate.index)) return null;
    if (candidate.kind !== 'text' && candidate.kind !== 'attachment') return null;
    if (!originalPartIndexes.has(candidate.index) || currentParts.has(candidate.index)) return null;

    let attachmentGuids: Set<string> | null = null;
    if (candidate.attachmentGuids !== undefined) {
      attachmentGuids = parseAttachmentGuidSet(candidate.attachmentGuids);
      if (attachmentGuids == null) return null;
      for (const attachmentGuid of attachmentGuids) {
        allAttachmentGuids.add(attachmentGuid);
        if (allAttachmentGuids.size > MAX_RETRACTION_ATTACHMENTS) return null;
      }
    }
    if (candidate.kind === 'text' && attachmentGuids != null && attachmentGuids.size > 0) {
      return null;
    }

    currentParts.set(candidate.index, {
      index: candidate.index,
      kind: candidate.kind,
      attachmentGuids,
    });
  }

  const attachmentOwnership = new Map<string, number>();
  for (let offset = 0; offset < value.attachmentOwnership.length; offset += 1) {
    if (!(offset in value.attachmentOwnership)) return null;
    const candidate: unknown = value.attachmentOwnership[offset];
    if (
      !isRecord(candidate) ||
      !isAttachmentGuid(candidate.attachmentGuid) ||
      !isPartIndex(candidate.partIndex)
    ) {
      return null;
    }

    if (!originalPartIndexes.has(candidate.partIndex)) return null;
    const currentOwner = currentParts.get(candidate.partIndex);
    if (currentOwner?.kind === 'text') return null;
    const priorPartIndex = attachmentOwnership.get(candidate.attachmentGuid);
    if (priorPartIndex !== undefined && priorPartIndex !== candidate.partIndex) return null;
    attachmentOwnership.set(candidate.attachmentGuid, candidate.partIndex);
    allAttachmentGuids.add(candidate.attachmentGuid);
    if (allAttachmentGuids.size > MAX_RETRACTION_ATTACHMENTS) return null;
  }

  for (const part of currentParts.values()) {
    if (part.kind === 'text') continue;

    const ownedGuids = new Set<string>();
    for (const [attachmentGuid, partIndex] of attachmentOwnership) {
      if (partIndex === part.index) ownedGuids.add(attachmentGuid);
    }
    if (ownedGuids.size === 0) return null;
    if (part.attachmentGuids != null && !sameSet(part.attachmentGuids, ownedGuids)) return null;
  }

  return { originalPartIndexes, currentParts, attachmentOwnership };
}

function validRetractionDate(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0
  );
}

/**
 * Classify an aggregate message without guessing part identity from count or array order.
 *
 * Any uncertain retraction evidence fails closed to `unknown`. In that state all visible-content
 * sets are deliberately empty, so a caller cannot accidentally render content the topology did not
 * prove survived.
 */
export function classifyMessageRetraction(
  evidence: MessageRetractionEvidence,
): MessageRetractionClassification {
  const hasDateSignal = evidence.dateRetracted !== null && evidence.dateRetracted !== undefined;
  const hasPartsField = evidence.retractedParts !== null && evidence.retractedParts !== undefined;

  if (!hasDateSignal && !hasPartsField) return emptyClassification('intact');
  if (hasDateSignal && !validRetractionDate(evidence.dateRetracted)) {
    return emptyClassification('unknown');
  }

  const retractedParts = hasPartsField
    ? parsePartIndexSet(evidence.retractedParts)
    : new Set<number>();
  if (retractedParts == null) return emptyClassification('unknown');
  if (retractedParts.size === 0) {
    return hasDateSignal ? emptyClassification('unknown') : emptyClassification('intact');
  }

  const topology = validateTopology(evidence.topology);
  if (topology == null) return emptyClassification('unknown');

  for (const partIndex of retractedParts) {
    if (!topology.originalPartIndexes.has(partIndex) || topology.currentParts.has(partIndex)) {
      return emptyClassification('unknown');
    }
  }

  const exactUniverse = new Set(topology.currentParts.keys());
  for (const partIndex of retractedParts) exactUniverse.add(partIndex);
  if (!sameSet(exactUniverse, topology.originalPartIndexes)) {
    return emptyClassification('unknown');
  }

  if (topology.currentParts.size === 0) {
    return {
      ...emptyClassification('fully-retracted'),
      topologyComplete: true,
    };
  }

  const provenVisiblePartIndexes = new Set(topology.currentParts.keys());
  const provenVisibleTextPartIndexes = new Set<number>();
  const provenVisibleAttachmentGuids = new Set<string>();
  for (const part of topology.currentParts.values()) {
    if (part.kind === 'text') provenVisibleTextPartIndexes.add(part.index);
  }
  for (const [attachmentGuid, partIndex] of topology.attachmentOwnership) {
    if (topology.currentParts.get(partIndex)?.kind === 'attachment') {
      provenVisibleAttachmentGuids.add(attachmentGuid);
    }
  }

  return {
    state: 'partial',
    topologyComplete: true,
    provenVisiblePartIndexes,
    provenVisibleTextPartIndexes,
    provenVisibleAttachmentGuids,
  };
}
