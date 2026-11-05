import { getDatabase } from '@db/database';
import { getChatDownloadedFilesSummary, type ChatDownloadedFilesSummary } from '@db/repositories';

export type { ChatDownloadedFilesSummary };

/** What "Remove this chat's downloaded files" would remove and keep, for its confirmation. */
export function loadChatDownloadedFilesSummary(
  chatGuid: string,
): Promise<ChatDownloadedFilesSummary> {
  return getChatDownloadedFilesSummary(getDatabase(), chatGuid);
}
