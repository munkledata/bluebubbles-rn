import {
  isAggregateRetractionTombstone,
  isExactMessagePartTopology,
} from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
import type { EnrichedMessage } from './useMessages';

/**
 * Which piece of a bubble a long-press landed on: one attachment, or the text body (which also
 * covers a link card and the bubble's empty edges). An accessibility action reports none, so it
 * keeps the whole-message rules below.
 */
export type MessagePressTarget =
  { readonly kind: 'attachment'; readonly attachmentGuid: string } | { readonly kind: 'body' };

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

/** How many current parts the message's exact topology proves (0 when it proves nothing). */
export function currentPartCount(msg: EnrichedMessage): number {
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  return isExactMessagePartTopology(topology) ? topology.currentParts.length : 0;
}

/** Whether `index` is a current part of the message's exact topology right now. */
function isCurrentExactPart(msg: EnrichedMessage, index: number): boolean {
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  return (
    isExactMessagePartTopology(topology) &&
    topology.currentParts.some((part) => part.index === index)
  );
}

function isServerConfirmedIMessage(msg: EnrichedMessage): boolean {
  return (
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    (msg.senderService == null || msg.senderService === 'iMessage')
  );
}

/**
 * The exact current part a long-press landed on: the one part that owns the pressed attachment, or
 * the message's only text part for a press on the body. Undefined whenever the exact topology can't
 * prove a single current part, so the whole-message rules apply instead.
 */
export function pressedPartIndex(
  msg: EnrichedMessage,
  target: MessagePressTarget | undefined,
): number | undefined {
  if (!target) return undefined;
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  if (!isExactMessagePartTopology(topology)) return undefined;
  const candidates =
    target.kind === 'attachment'
      ? topology.attachmentOwnership
          .filter((owner) => owner.attachmentGuid === target.attachmentGuid)
          .map((owner) => owner.partIndex)
      : topology.currentParts.filter((part) => part.kind === 'text').map((part) => part.index);
  const [index] = candidates;
  if (candidates.length !== 1 || index === undefined) return undefined;
  return topology.currentParts.some((part) => part.index === index) ? index : undefined;
}

/**
 * The part a reply may target. With a pressed part (see `pressedPartIndex`), only that part: part 0
 * by the reviewed rule, or a part above 0 while the restored part-reply switch is on (FP-006).
 * Without one: part 0 by the reviewed rule, otherwise (restored switch only) the message's one
 * remaining part above 0, for example the caption left after its photo was unsent. Undefined when
 * no part can be targeted.
 */
export function replyTargetPartIndex(
  msg: EnrichedMessage,
  allowRestoredPart: boolean,
  pressedPart?: number,
): number | undefined {
  if (pressedPart !== undefined) {
    if (!isCurrentExactPart(msg, pressedPart)) return undefined;
    if (pressedPart === 0) return canTargetReplyPartZero(msg) ? 0 : undefined;
    return allowRestoredPart && isServerConfirmedIMessage(msg) && pressedPart <= 63
      ? pressedPart
      : undefined;
  }
  if (canTargetReplyPartZero(msg)) return 0;
  if (!allowRestoredPart || !isServerConfirmedIMessage(msg)) return undefined;
  const index = soleCurrentPartIndex(msg);
  return index !== null && index > 0 && index <= 63 ? index : undefined;
}

/**
 * The part an iMessage tapback may target. With a pressed part, only that part: part 0, or a part
 * above 0 while the restored part-reaction switch is on (FP-006). Both helper commands look up the
 * exact part and use its own range (the reviewed one-to-one command finds part 0 itself), so part 0
 * of a several-part message is safe. Without a pressed part: the message's one current part, which
 * must be part 0 unless the restored switch is on. Undefined when none can be targeted.
 */
export function imessageReactionPartIndex(
  msg: EnrichedMessage,
  allowRestoredPart: boolean,
  pressedPart?: number,
): number | undefined {
  if (msg.guid.startsWith('temp-')) return undefined;
  if (pressedPart !== undefined) {
    if (!isCurrentExactPart(msg, pressedPart)) return undefined;
    if (pressedPart === 0) return 0;
    return allowRestoredPart && pressedPart <= 63 ? pressedPart : undefined;
  }
  const index = soleCurrentPartIndex(msg);
  if (index === 0) return 0;
  return allowRestoredPart && index !== null && index > 0 && index <= 63 ? index : undefined;
}
