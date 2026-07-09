import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { logger } from '@core/secure';
import { sendErrorCode } from '@utils';
import {
  getChatIdByGuid,
  insertOutgoingAttachment,
  markOutgoingSentNoGuid,
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
 * Streams the picked file to the server's multipart upload route and returns the send ack.
 * Injected so this module stays Node-testable (the production uploader uses a native streaming
 * upload — `expo-file-system`'s `uploadAsync` — which reads the file from disk and never buffers
 * it in JS memory, so a 1 GB video uploads with flat memory use). See `expoAttachmentUploader`.
 */
export type AttachmentUploader = (args: {
  http: HttpClient;
  chatGuid: string;
  tempGuid: string;
  name: string;
  uri: string;
  mimeType: string;
}) => Promise<SendAck>;

/**
 * Optimistic image send: inserts a local attachment row (renders immediately from disk), streams
 * the file to the server, then reconciles message + attachment guids. Mirrors `sendTextMessage`;
 * pure orchestration (the upload is injected) so it is Node-testable. The file is streamed from
 * disk by the native layer, so a large video is never read into JS memory.
 */
export async function sendImageMessage(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; image: PickedImage },
  upload: AttachmentUploader,
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
    // Stream the file to the server (native upload — never buffered in JS memory).
    const server = await upload({
      http,
      chatGuid: args.chatGuid,
      tempGuid,
      name: args.image.name,
      uri: args.image.uri,
      mimeType: args.image.mimeType,
    });
    // The server ack carries only the message GUID (no attachment guid). Promote the message
    // row when the GUID is present; the optimistic attachment row keeps its local guid +
    // local_path until the live socket `new-message` echo reconciles the attachment guid in
    // place (upsertAttachments). On the no-guid path, flip to 'sent' + drop the queue row (no
    // spurious retry) and let the content-matched echo promote it. Never reconcile w/ undefined.
    if (server.guid) {
      await reconcileOutgoingSuccess(db, tempGuid, {
        guid: server.guid,
        dateCreated: now,
        dateDelivered: null,
      });
    } else {
      await markOutgoingSentNoGuid(db, tempGuid);
    }
  } catch (e) {
    logger.warn(`[send-attachment] failed: ${e instanceof Error ? e.message : String(e)}`);
    const code = sendErrorCode(e instanceof ApiError ? e.status ?? null : null);
    await reconcileOutgoingError(db, tempGuid, code);
  }

  return { tempGuid };
}
