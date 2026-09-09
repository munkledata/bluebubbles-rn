import { getDatabase } from '@db/database';
import { getMessagePreviewByGuid, type MessagePreview } from '@db/repositories';

/** Read one exact reply preview without exposing a raw database handle to the route layer. */
export function readMessagePreview(
  messageGuid: string,
  partIndex: number,
): Promise<MessagePreview | null> {
  return getMessagePreviewByGuid(getDatabase(), messageGuid, partIndex);
}
