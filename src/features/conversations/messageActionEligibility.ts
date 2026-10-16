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
