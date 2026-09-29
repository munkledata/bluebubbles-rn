import { getDatabase } from '@db/database';
import {
  getMessagePreviewByGuid,
  resolveMessageTarget,
  type MessagePreview,
} from '@db/repositories';

/** Read one exact reply preview without exposing a raw database handle to the route layer. */
export function readMessagePreview(
  chatGuid: string,
  messageGuid: string,
  partIndex: number,
): Promise<MessagePreview | null> {
  const db = getDatabase();
  return resolveMessageTarget(db, {
    chatGuid,
    messageGuid,
    partIndex,
    // This restored reply slice deliberately has no legacy part-zero compatibility path.
    serverAuthorization: { allowsLegacyPartZero: false, isCurrent: () => true },
  }).then(async (target) => {
    if (target?.basis !== 'exact-topology') return null;
    const preview = await getMessagePreviewByGuid(
      db,
      chatGuid,
      target.messageGuid,
      target.partIndex,
    );
    return preview && !preview.isRetracted
      ? { ...preview, guid: target.messageGuid, targetPartIndex: target.partIndex }
      : null;
  });
}
