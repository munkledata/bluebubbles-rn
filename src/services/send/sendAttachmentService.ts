import { sendAttachment } from '@core/api/endpoints/attachments';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
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
 * Reads a file at `uri` and returns its bytes base64-encoded. Injected so this module stays
 * Node-testable (no expo-file-system import on the test path); the production reader uses the
 * expo-file-system `File` object API (see `expoBase64Reader` in the UI-facing wiring).
 */
export type FileBase64Reader = (uri: string) => Promise<string>;

/**
 * Optimistic image send: inserts a local attachment row (renders immediately from
 * disk), reads the file as base64, uploads it as JSON, then reconciles message +
 * attachment guids. Mirrors `sendTextMessage`; pure orchestration (the file read is
 * injected) so it is Node-testable.
 */
export async function sendImageMessage(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; image: PickedImage },
  readBase64: FileBase64Reader,
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
    // Read the file bytes as base64 (the server has no multipart parser — it wants JSON).
    const data = await readBase64(args.image.uri);
    const server = await sendAttachment(http, {
      chatGuid: args.chatGuid,
      tempGuid,
      name: args.image.name,
      data,
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
    const code = e instanceof ApiError && e.status ? e.status : -1;
    await reconcileOutgoingError(db, tempGuid, code);
  }

  return { tempGuid };
}
