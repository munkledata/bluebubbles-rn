import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES,
  MAX_IMESSAGE_VOICE_UPLOAD_BYTES,
  MAX_RCS_ATTACHMENT_UPLOAD_BYTES,
  MAX_SEND_ATTACHMENT_TEXT_BYTES,
  isSupportedImessageAttachmentType,
  isSupportedImessageVoiceType,
} from '@core/models/serverInfo';
import {
  commitAttachmentCacheReservation,
  claimShareIntakeFileWithinTransaction,
  getChatHeader,
  insertOutgoingAttachmentWithinTransaction,
  type ShareIntakeManifestIdentity,
  type SendAttemptOwnerToken,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { utf8Encode } from '@utils/bytes';
import { isProvenOneToOneIMessageChat, isRcsChatGuid } from '@utils/chat';
import { assertSafeUploadFilename } from '@utils/uploadFilename';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheReservation,
} from '../download/attachmentCacheCoordinator';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome, type SendOutcomeOptions } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

export interface PickedImage {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  /** Native-owned transient file; production must adopt it before DB ownership. */
  origin?: 'paste' | 'share';
  /** Stable native-share manifest ordinal; meaningful only when origin is `share`. */
  shareItemIndex?: number;
}

export type AttachmentTextService = 'iMessage' | 'RCS';

export interface SendImageMessageArgs {
  chatGuid: string;
  image: PickedImage;
  /** Present only for one attachment + text represented by this one optimistic message. */
  text?: string;
  /** Required for iMessage files and for RCS combined sends; never inferred from a GUID alone. */
  service?: AttachmentTextService;
  /** Distinct one-file iMessage voice mode; never inferred from the MIME type alone. */
  voice?: true;
  /** Optional reply target for helper-backed iMessage. RCS media replies currently fail closed. */
  selectedMessageGuid?: string;
  partIndex?: number;
  /** Exact native batch identity required when this file came from Android share intake. */
  shareIntake?: ShareIntakeManifestIdentity;
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
  /** Local request generation echoed by attempt-aware RCS success/error events. */
  clientAttemptGeneration?: number;
  /** Await-free final capability fence immediately before native code opens the request. */
  assertNetworkStart?: () => void;
  /** Body text consumed by the same server transport as this one attachment. */
  text?: string;
  /** Explicit transport mode; omitted for the existing RCS upload path. */
  service?: AttachmentTextService;
  /** Exact audio-only upload mode; the server requires a matching multipart uploadKind. */
  voice?: true;
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
  /** Optional owner lifetime; abort requests native cancellation before any later settlement. */
  signal?: AbortSignal;
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

/** The file's own name cannot be uploaded as is; nothing was written or sent. */
export class UnsendableAttachmentNameError extends Error {
  constructor() {
    super('Choose a file with a valid name of at most 255 UTF-8 bytes.');
    this.name = 'UnsendableAttachmentNameError';
  }
}

/** The file is over the RCS media limit; nothing was written or sent. */
export class RcsAttachmentTooLargeError extends Error {
  constructor() {
    super('Choose a file no larger than 100 MiB for RCS.');
    this.name = 'RcsAttachmentTooLargeError';
  }
}

export function isSupportedImessageAttachmentFile(image: PickedImage): boolean {
  if (typeof image.mimeType !== 'string' || typeof image.name !== 'string') return false;
  return (
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    image.size <= MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES &&
    isSupportedImessageAttachmentType(image.mimeType, image.name)
  );
}

export function isSupportedImessageVoiceFile(image: PickedImage): boolean {
  return (
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    image.size <= MAX_IMESSAGE_VOICE_UPLOAD_BYTES &&
    isSupportedImessageVoiceType(image.mimeType, image.name)
  );
}

/**
 * Optimistic file send: inserts one local attachment row (renders immediately from disk), streams
 * the file with optional caption to the server, then reconciles message + attachment guids. Mirrors `sendTextMessage`;
 * pure orchestration (the upload is injected) so it is Node-testable. The file is streamed from
 * disk by the native layer, so a large video is never read into JS memory.
 */
export async function sendImageMessage(
  db: AppDatabase,
  http: HttpClient,
  args: SendImageMessageArgs,
  upload: AttachmentUploader,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  outcomeOptions?: SendOutcomeOptions,
  prepareOwnership?: AttachmentOwnershipPreparer,
  /** Fires only after the optimistic message, attachment, and outgoing queue row commit. */
  onQueued?: (tempGuid: string) => Promise<void> | void,
  /** Explicit provenance for foreground cache data or already-proven task-local server info. */
  capabilitySource?: RcsCapabilitySource,
): Promise<{ tempGuid: string }> {
  const rcsChat = isRcsChatGuid(args.chatGuid);
  const imessageAttachment = !rcsChat && args.service === 'iMessage';
  const imessageVoice = imessageAttachment && args.voice === true;
  if (!rcsChat && !imessageAttachment) {
    throw new Error('iMessage attachments require the narrow attachment-only capability.');
  }
  if ((args.image.origin === 'share') !== (args.shareIntake !== undefined)) {
    throw new Error('Shared attachment is missing its exact native batch identity.');
  }
  if (
    args.shareIntake &&
    (!Number.isInteger(args.image.shareItemIndex) || args.image.shareItemIndex == null)
  ) {
    throw new Error('Shared attachment is missing its stable native item index.');
  }
  if (args.selectedMessageGuid !== undefined || args.partIndex !== undefined) {
    throw new Error(
      imessageAttachment
        ? 'This server cannot send an iMessage attachment reply.'
        : 'This server cannot send an RCS media reply.',
    );
  }
  // The uploader sends the file's own name and cannot carry some (quotes, slashes, control
  // characters, over 255 bytes). Refuse before any bubble or queue row so the person can rename
  // the file: refused after admission, iMessage read "may have been sent" and RCS retried 5 times.
  try {
    assertSafeUploadFilename(args.image.name);
  } catch {
    throw new UnsendableAttachmentNameError();
  }
  if (imessageAttachment) {
    const supportedFile = imessageVoice
      ? isSupportedImessageVoiceFile(args.image)
      : isSupportedImessageAttachmentFile(args.image);
    if (!supportedFile) {
      throw new Error(
        imessageVoice
          ? 'Choose one recorded M4A voice note no larger than 10 MiB.'
          : 'Choose one JPEG, PNG, or PDF file no larger than 10 MiB.',
      );
    }
    if (imessageVoice && args.text !== undefined) {
      throw new Error('iMessage voice notes cannot include a caption.');
    }
    if (
      args.text !== undefined &&
      (args.text.trim().length === 0 ||
        utf8Encode(args.text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES)
    ) {
      throw new Error('Attachment caption is blank or exceeds the 65,536-byte limit.');
    }
  } else {
    if (args.voice === true) throw new Error('Voice mode requires an iMessage chat.');
    if (args.service === 'iMessage') {
      throw new Error('An RCS attachment cannot use the iMessage transport.');
    }
    if (args.text !== undefined && args.service !== 'RCS') {
      throw new Error('Attachment text must use the RCS transport.');
    }
    // The server refuses RCS media over the limit only after the whole upload. Refuse it here,
    // before any bubble or queue row, so the person can remove the file.
    if (
      Number.isSafeInteger(args.image.size) &&
      args.image.size > MAX_RCS_ATTACHMENT_UPLOAD_BYTES
    ) {
      throw new RcsAttachmentTooLargeError();
    }
  }
  // Pin before pasted-file ownership preparation: that native/cache await belongs to the same
  // exact transport decision as capability discovery, durable admission, and upload.
  const transport = pinSendTransport(http, commitGuard);
  const tempGuid = generateTempGuid();
  const attachmentGuid = `${tempGuid}-att`;
  let image = args.image;
  let cacheReservation: AttachmentCacheReservation | undefined;
  let cacheProtectionHandoff = false;
  let attemptOwnerToken: SendAttemptOwnerToken | null = null;
  let duplicateOwnerGuid: string | null = null;
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    args.chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: true },
  );
  const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
  // Reject false/missing service capability before cache ownership or durable queue admission.
  // The retired helper was the only iMessage attachment transport; RCS remains independent but
  // still requires its own live bridge rather than inheriting authority from `private_api`.
  if (imessageAttachment) {
    const serverInfo = capability.serverInfo;
    if (
      !serverInfo ||
      (imessageVoice
        ? serverInfo.supports_imessage_voice_upload !== true
        : serverInfo.supports_imessage_attachment_upload !== true)
    ) {
      throw new Error(
        imessageVoice
          ? 'This server cannot send iMessage voice notes.'
          : 'This server cannot send iMessage attachments.',
      );
    }
    if (
      image.mimeType === 'application/pdf' &&
      serverInfo.supports_imessage_pdf_attachment_upload !== true
    ) {
      throw new Error('This server cannot send PDF iMessage attachments.');
    }
    if (
      args.text !== undefined &&
      serverInfo.supports_imessage_attachment_caption_upload !== true
    ) {
      throw new Error('This server cannot send text with an iMessage attachment.');
    }
    const header = await getChatHeader(db, args.chatGuid);
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    if (!isProvenOneToOneIMessageChat(header)) {
      throw new Error('A proven existing one-to-one iMessage chat is required.');
    }
  } else if (capability.serverInfo?.rcs !== true) {
    throw new Error('This server cannot send RCS attachments without RCS support.');
  }
  if (!imessageAttachment && args.text !== undefined) {
    if (
      args.text.length === 0 ||
      utf8Encode(args.text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES
    ) {
      throw new Error('Attachment text is empty or exceeds the 65,536-byte limit.');
    }
    const supported = capability.serverInfo.supports_rcs_text_with_attachment === true;
    if (!supported) {
      throw new Error('This server cannot send text with an attachment for this chat service.');
    }
  }
  if (image.origin === 'paste' || image.origin === 'share') {
    if (!prepareOwnership) {
      throw new Error('Staged attachment ownership preparation is unavailable.');
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
    const preparedFileSupported =
      !imessageAttachment ||
      (imessageVoice
        ? isSupportedImessageVoiceFile(image)
        : isSupportedImessageAttachmentFile(image));
    if (!preparedFileSupported) {
      await cacheReservation.release().catch(() => undefined);
      throw new Error(
        imessageVoice
          ? 'Choose one recorded M4A voice note no larger than 10 MiB.'
          : 'Choose one JPEG, PNG, or PDF file no larger than 10 MiB.',
      );
    }
    if (
      imessageAttachment &&
      image.mimeType === 'application/pdf' &&
      capability.serverInfo?.supports_imessage_pdf_attachment_upload !== true
    ) {
      await cacheReservation.release().catch(() => undefined);
      throw new Error('This server cannot send PDF iMessage attachments.');
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
    const admission = await withDbTransaction(
      db,
      async (context) => {
        if (args.shareIntake) {
          const shareClaim = await claimShareIntakeFileWithinTransaction(context, {
            identity: args.shareIntake,
            chatGuid: args.chatGuid,
            itemIndex: image.shareItemIndex!,
            ownerGuid: tempGuid,
            appliedAtMs: now,
          });
          if (!shareClaim.claimed) {
            return { kind: 'duplicate' as const, ownerGuid: shareClaim.ownerGuid };
          }
        }
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
        const inserted = await insertOutgoingAttachmentWithinTransaction(context, {
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
          text: args.text,
          attemptAware: capability.attemptAware,
          ...(imessageAttachment ? { imessageAttachmentV1: true } : {}),
        });
        return { kind: 'inserted' as const, inserted };
      },
      capabilityGuard,
    );
    if (admission.kind === 'duplicate') duplicateOwnerGuid = admission.ownerGuid;
    else attemptOwnerToken = admission.inserted.attemptOwnerToken;
  } catch (error) {
    if (cacheReservation && cacheProtectionHandoff) {
      cacheReservation.rollbackProtectionHandoff();
      cacheProtectionHandoff = false;
    }
    if (error === ATTACHMENT_CACHE_PROMOTION_CONFLICT) {
      throw new Error('Staged attachment ownership changed before it could be sent.');
    }
    throw error;
  } finally {
    // The queue row plus attachment local_path now provide durable ownership. Releasing earlier
    // would reopen the deletion race; retaining it through the network upload would pin needlessly.
    sourceProtection?.release();
    if (cacheReservation) await cacheReservation.release().catch(() => undefined);
  }

  const queuedGuid = duplicateOwnerGuid ?? tempGuid;
  await onQueued?.(queuedGuid);
  if (duplicateOwnerGuid) return { tempGuid: duplicateOwnerGuid };

  // Disconnect can retire this operation immediately after COMMIT. Do not let that old
  // continuation register a brand-new native upload after the synchronous cancel sweep.
  if (!capabilityGuard()) throw new DbCommitGuardRejectedError();

  try {
    transport.assertNetworkCurrent();
    // Stream the file to the server (native upload — never buffered in JS memory).
    const server = await upload({
      http: transport.http,
      chatGuid: args.chatGuid,
      tempGuid,
      clientAttemptGeneration: attemptOwnerToken?.generation,
      assertNetworkStart: () => {
        if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      },
      text: args.text,
      ...(imessageAttachment ? { service: 'iMessage' as const } : {}),
      ...(imessageVoice ? { voice: true as const } : {}),
      attachmentGuid,
      name: image.name,
      uri: image.uri,
      mimeType: image.mimeType,
      totalBytes: image.size,
    });
    if (
      imessageAttachment &&
      (typeof server.guid !== 'string' ||
        server.guid.trim().length === 0 ||
        server.guid.length > 256 ||
        server.viaPrivateApi !== true)
    ) {
      throw new ApiError('parse_error', 'iMessage attachment acknowledgement was incomplete');
    }
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    // The server ack carries only the message GUID (no attachment guid) — the optimistic
    // attachment row keeps its local guid + local_path until the live socket `new-message`
    // echo reconciles the attachment guid in place (upsertAttachments).
    const attemptOptions: SendOutcomeOptions = {
      ...outcomeOptions,
      attemptOwnerToken: attemptOwnerToken ?? undefined,
      expectedChatGuid: args.chatGuid,
    };
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard, attemptOptions);
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
      {
        ...outcomeOptions,
        attemptOwnerToken: attemptOwnerToken ?? undefined,
        ...(imessageAttachment
          ? { terminalUncertain: true, failureNoticeMode: 'suppressed' as const }
          : {}),
      },
    );
  }

  return { tempGuid };
}
