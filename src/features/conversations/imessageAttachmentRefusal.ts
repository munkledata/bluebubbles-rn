import {
  IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES,
  LEGACY_RESTORED_ATTACHMENT_CAPS,
  isRestoredAttachmentFile,
  restoredAttachmentExtension,
  type RestoredAttachmentCaps,
} from '@core/models/imessageRestoredFeatures';
import {
  MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES,
  isSupportedImessageAttachmentType,
} from '@core/models/serverInfo';

/** The parts of a staged file this check reads. */
interface StagedFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

/** Which iMessage file routes this chat has right now. */
export interface IMessageAttachmentRoutes {
  /** The one-to-one route for one JPEG, PNG, or PDF up to 10 MiB. */
  readonly narrow: boolean;
  /** The FP-006 restored route for one file of its wider allowlist, within the server's caps. */
  readonly restored: boolean;
}

/**
 * Why an iMessage chat cannot send these files, or null when it can. It refuses exactly what the
 * send service refuses (the narrow route's isSupportedImessageAttachmentFile, plus a PDF without
 * the PDF capability, or else the restored route's own caps), and names the reason, so a share that
 * cannot go here says what to do.
 */
export function imessageAttachmentRefusal(
  items: readonly StagedFile[],
  pdfAvailable: boolean,
  routes: IMessageAttachmentRoutes = { narrow: true, restored: false },
  caps: RestoredAttachmentCaps = LEGACY_RESTORED_ATTACHMENT_CAPS,
): string | null {
  // With the restored route each file goes as its own message, one after another, so several can
  // be picked at once; the narrow route alone still takes one file per send.
  if (routes.restored && items.length > 1) {
    if (items.length > IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES) {
      return `This iMessage chat sends up to ${IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES} files at a time. Remove some, then send.`;
    }
    for (const item of items) {
      const refusal = imessageAttachmentRefusal([item], pdfAvailable, routes, caps);
      if (refusal !== null) return refusal;
    }
    return null;
  }
  if (items.length !== 1) {
    return 'This iMessage chat sends one file at a time. Remove the others, then send.';
  }
  const item = items[0]!;
  const supportedType =
    typeof item.mimeType === 'string' &&
    typeof item.name === 'string' &&
    isSupportedImessageAttachmentType(item.mimeType, item.name);
  const supportedSize =
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    item.size <= MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES;
  const pdf = item.mimeType === 'application/pdf';
  if (routes.narrow && supportedType && supportedSize && (!pdf || pdfAvailable)) return null;
  if (routes.restored) {
    if (isRestoredAttachmentFile(item, caps)) return null;
    if (typeof item.name !== 'string' || restoredAttachmentExtension(item.name) === undefined) {
      return 'This iMessage chat can’t send this kind of file.';
    }
    const maxMiB = Math.floor(caps.maxFileBytes / (1024 * 1024));
    return /\.(?:txt|csv)$/i.test(item.name)
      ? 'This iMessage chat can send text files up to 1 MiB. Choose a smaller file.'
      : `This iMessage chat can send files up to ${maxMiB} MiB. Choose a smaller file.`;
  }
  if (/^image\/hei[cf]/i.test(String(item.mimeType)) || /\.hei[cf]$/i.test(String(item.name))) {
    return 'This iMessage chat can’t send HEIC photos yet. Send a JPEG or PNG instead.';
  }
  if (!supportedType || (pdf && !pdfAvailable)) {
    return pdfAvailable
      ? 'This iMessage chat can send only a JPEG, PNG, or PDF file.'
      : 'This iMessage chat can send only a JPEG or PNG image.';
  }
  return 'This iMessage chat can send files up to 10 MiB. Choose a smaller file.';
}
