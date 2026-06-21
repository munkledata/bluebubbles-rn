import { sendAttachment } from '@core/api/endpoints/attachments';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  getChatIdByGuid,
  insertOutgoingAttachment,
  promoteAttachmentGuid,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { generateTempGuid } from './sendService';

export interface PickedImage {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * Optimistic image send: inserts a local attachment row (renders immediately from
 * disk), uploads multipart, then reconciles message + attachment guids. Mirrors
 * `sendTextMessage`; pure orchestration (no RN imports) so it is Node-testable.
 */
export async function sendImageMessage(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; image: PickedImage },
  now: number = Date.now(),
): Promise<{ tempGuid: string }> {
  const chatId = await getChatIdByGuid(db, args.chatGuid);
  if (chatId == null) throw new Error(`unknown chat ${args.chatGuid}`);

  const tempGuid = generateTempGuid();
  const attachmentGuid = `${tempGuid}-att`;
  await insertOutgoingAttachment(db, {
    tempGuid,
    attachmentGuid,
    chatId,
    chatGuid: args.chatGuid,
    localPath: args.image.uri,
    mimeType: args.image.mimeType,
    transferName: args.image.name,
    totalBytes: args.image.size,
    width: args.image.width,
    height: args.image.height,
    now,
  });

  try {
    const server = await sendAttachment(http, {
      chatGuid: args.chatGuid,
      tempGuid,
      file: { uri: args.image.uri, name: args.image.name, type: args.image.mimeType },
    });
    const serverAtt = server.attachments?.[0];
    if (serverAtt?.guid) {
      await promoteAttachmentGuid(db, attachmentGuid, serverAtt.guid, args.image.uri);
    }
    await reconcileOutgoingSuccess(db, tempGuid, {
      guid: server.guid,
      dateCreated: server.dateCreated ?? now,
      dateDelivered: server.dateDelivered ?? null,
    });
  } catch (e) {
    const code = e instanceof ApiError && e.status ? e.status : -1;
    await reconcileOutgoingError(db, tempGuid, code);
  }

  return { tempGuid };
}
