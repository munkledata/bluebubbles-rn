import {
  isAggregateRetractionTombstone,
  isExactMessagePartTopology,
} from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
import type { EnrichedMessage } from './useMessages';

/**
 * Whether a reply may target this message's part 0: a server-confirmed (not temp-) iMessage that
 * is not a retraction tombstone and whose exact part topology includes part 0. The actions menu
 * and swipe-to-reply share this one rule so they can never disagree (review M233).
 */
export function canTargetReplyPartZero(msg: EnrichedMessage): boolean {
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  return (
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    (msg.senderService == null || msg.senderService === 'iMessage') &&
    isExactMessagePartTopology(topology) &&
    topology.currentParts.some((part) => part.index === 0)
  );
}

/** The index of the message's one current part, or null unless its exact topology has one part. */
function soleCurrentPartIndex(msg: EnrichedMessage): number | null {
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  if (!isExactMessagePartTopology(topology) || topology.currentParts.length !== 1) return null;
  return topology.currentParts[0]?.index ?? null;
}

function isServerConfirmedIMessage(msg: EnrichedMessage): boolean {
  return (
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    (msg.senderService == null || msg.senderService === 'iMessage')
  );
}

/**
 * The part a reply may target: 0 by the reviewed rule, otherwise (FP-006, only while the restored
 * part-reply switch is on) the message's one remaining part when its index is above 0 — for example
 * the caption left after its photo was unsent. Undefined when no part can be targeted.
 */
export function replyTargetPartIndex(
  msg: EnrichedMessage,
  allowRestoredPart: boolean,
): number | undefined {
  if (canTargetReplyPartZero(msg)) return 0;
  if (!allowRestoredPart || !isServerConfirmedIMessage(msg)) return undefined;
  const index = soleCurrentPartIndex(msg);
  return index !== null && index > 0 && index <= 63 ? index : undefined;
}

/**
 * The part an iMessage tapback may target: the message's one current part, which must be part 0
 * unless the restored part-reaction switch is on (FP-006). Undefined when none can be targeted.
 */
export function imessageReactionPartIndex(
  msg: EnrichedMessage,
  allowRestoredPart: boolean,
): number | undefined {
  if (msg.guid.startsWith('temp-')) return undefined;
  const index = soleCurrentPartIndex(msg);
  if (index === 0) return 0;
  return allowRestoredPart && index !== null && index > 0 && index <= 63 ? index : undefined;
}
