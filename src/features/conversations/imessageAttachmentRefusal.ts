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

/**
 * Why a one-to-one iMessage chat cannot send these files, or null when it can. It refuses exactly
 * what the send service's isSupportedImessageAttachmentFile refuses, plus a PDF without the PDF
 * capability, and names the reason, so a share that cannot go here says what to do.
 */
export function imessageAttachmentRefusal(
  items: readonly StagedFile[],
  pdfAvailable: boolean,
): string | null {
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
  if (supportedType && supportedSize && (!pdf || pdfAvailable)) return null;
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
