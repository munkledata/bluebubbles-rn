import type { SendAck } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  commitAttachmentCacheReservation,
  insertOutgoingAttachmentWithinTransaction,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheReservation,
} from '../download/attachmentCacheCoordinator';
import { handleSendFailure, reconcileSendOutcome, type SendOutcomeOptions } from './sendOutcome';
import { generateTempGuid } from './sendService';

export interface PickedImage {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  /** Native-owned rich-paste cache file; production must adopt it before DB ownership. */
  origin?: 'paste';
}

/**
 * Streams the picked file to the server's multipart upload route and returns the send ack.
 * Injected so this module stays Node-testable (the production uploader uses a native streaming
 * upload — `expo-file-system`'s legacy `createUploadTask` — which reads from disk and never buffers
 * it in JS memory, so a 1 GB video uploads with flat memory use). See `expoAttachmentUploader`.
 */
export type AttachmentUploader = (args: {
  http: HttpClient;
  chatGuid: string;
  tempGuid: string;
  /**
   * The ATTACHMENT row's guid — the key byte progress is published under. It is not the message
   * temp guid because the attachment components render under `att.guid`, so this is what lets the
   * ring land on the right bubble.
   */
  attachmentGuid: string;
  name: string;
  uri: string;
  mimeType: string;
  /** Size if the caller knows it, else 0/undefined — the uploader learns the real one natively. */
  totalBytes?: number;
  /**
   * Optional absolute limit for this invocation, covering its own native preflight, gate wait,
   * transfer, and response. Foreground sends deliberately omit it; bounded headless retries pass
   * the remainder of their attachment-attempt deadline.
   */
  timeoutMs?: number;
}) => Promise<SendAck>;

export interface PreparedAttachmentOwnership {
  readonly image: PickedImage;
  /** Present only when native paste bytes were moved into a reserved ordinary-cache path. */
  readonly cacheReservation?: AttachmentCacheReservation;
}

/** Native/file-system ownership preparation injected by the production composition root. */
export type AttachmentOwnershipPreparer = (input: {
  readonly db: AppDatabase;
  readonly image: PickedImage;
  readonly attachmentGuid: string;
}) => Promise<PreparedAttachmentOwnership>;

const ATTACHMENT_CACHE_PROMOTION_CONFLICT = Symbol('attachment-cache-promotion-conflict');

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
  commitGuard?: DbCommitGuard,
  outcomeOptions?: SendOutcomeOptions,
  prepareOwnership?: AttachmentOwnershipPreparer,
): Promise<{ tempGuid: string }> {
  const tempGuid = generateTempGuid();
  const attachmentGuid = `${tempGuid}-att`;
  let image = args.image;
  let cacheReservation: AttachmentCacheReservation | undefined;
  let cacheProtectionHandoff = false;
  if (image.origin === 'paste') {
    if (!prepareOwnership) {
      throw new Error('Pasted attachment ownership preparation is unavailable.');
    }
    const prepared = await prepareOwnership({ db, image, attachmentGuid });
    image = prepared.image;
    cacheReservation = prepared.cacheReservation;
    if (
      !cacheReservation ||
      image.uri !== cacheReservation.path ||
      image.size !== cacheReservation.maxBytes ||
      !Number.isSafeInteger(image.size) ||
      image.size <= 0
    ) {
      await cacheReservation?.release().catch(() => undefined);
      throw new Error('Prepared attachment ownership is inconsistent.');
    }
  }

  // A forwarded download can share this exact cache file with its source message. Pin it before
  // the first DB await so a concurrent tombstone/quota pass cannot claim and unlink it between the
  // user's Start tap and the durable outgoing attachment+queue commit. Non-cache picked files are
  // harmlessly pinned in memory for this short handoff too; the DB trigger is the final atomic gate
  // if a crash-surviving `reserved`/`retiring` ledger row already owns the path.
  let sourceProtection: ReturnType<typeof attachmentCacheCoordinator.protect> | undefined;
  if (!cacheReservation) {
    try {
      sourceProtection = attachmentCacheCoordinator.protect(image.uri);
    } catch {
      // Content-provider and future non-file URIs may be outside the cache coordinator's path
      // shape. They have no attachment-cache ledger row, so upload validation stays authoritative.
      sourceProtection = undefined;
    }
    if (sourceProtection === null) {
      throw new Error('Attachment is no longer available for sending.');
    }
  }

  try {
    await withDbTransaction(
      db,
      async (context) => {
        if (cacheReservation) {
          const promoted = await commitAttachmentCacheReservation(context, {
            path: image.uri,
            bytes: image.size,
            lastUsedAt: now,
          });
          if (!promoted || !cacheReservation.beginProtectionHandoff()) {
            throw ATTACHMENT_CACHE_PROMOTION_CONFLICT;
          }
          cacheProtectionHandoff = true;
        }
        await insertOutgoingAttachmentWithinTransaction(context, {
          tempGuid,
          attachmentGuid,
          chatGuid: args.chatGuid,
          localPath: image.uri,
          mimeType: image.mimeType,
          transferName: image.name,
          totalBytes: image.size,
          width: image.width,
          height: image.height,
          now,
        });
      },
      commitGuard,
    );
  } catch (error) {
    if (cacheReservation && cacheProtectionHandoff) {
      cacheReservation.rollbackProtectionHandoff();
      cacheProtectionHandoff = false;
    }
    if (error === ATTACHMENT_CACHE_PROMOTION_CONFLICT) {
      throw new Error('Pasted attachment ownership changed before it could be sent.');
    }
    throw error;
  } finally {
    // The queue row plus attachment local_path now provide durable ownership. Releasing earlier
    // would reopen the deletion race; retaining it through the network upload would pin needlessly.
    sourceProtection?.release();
    if (cacheReservation) await cacheReservation.release().catch(() => undefined);
  }

  // Disconnect can retire this operation immediately after COMMIT. Do not let that old
  // continuation register a brand-new native upload after the synchronous cancel sweep.
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  try {
    // Stream the file to the server (native upload — never buffered in JS memory).
    const server = await upload({
      http,
      chatGuid: args.chatGuid,
      tempGuid,
      attachmentGuid,
      name: image.name,
      uri: image.uri,
      mimeType: image.mimeType,
      totalBytes: image.size,
    });
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    // The server ack carries only the message GUID (no attachment guid) — the optimistic
    // attachment row keeps its local guid + local_path until the live socket `new-message`
    // echo reconciles the attachment guid in place (upsertAttachments).
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard, outcomeOptions);
  } catch (e) {
    // Ownership loss is not a transport failure. Leave the durable queue row for the current
    // account's recovery path instead of logging or starting a second stale-account owner.
    if (e instanceof DbCommitGuardRejectedError) throw e;
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    await handleSendFailure(
      db,
      tempGuid,
      e,
      'send-attachment',
      args.chatGuid,
      undefined,
      commitGuard,
      outcomeOptions,
    );
  }

  return { tempGuid };
}
