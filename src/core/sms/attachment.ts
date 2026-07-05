/**
 * Pure, React-free helpers for classifying + labeling MMS attachments and for
 * labeling empty conversation snippets. No provider / React access — safe for
 * Node tests and any headless code.
 *
 * MMS parts arrive from the native module as `{ partId, contentType, uri,
 * fileName }`; the UI decides how to render each part from its content type.
 */

/** Coarse render kind derived from an attachment's MIME content type. */
export type SmsAttachmentKind = 'image' | 'video' | 'audio' | 'file';

/**
 * Classify an attachment by its MIME content type. Only the top-level type is
 * considered (`image/*`, `video/*`, `audio/*`); everything else — including an
 * empty/unknown type — is a generic `file`. Case-insensitive.
 */
export function classifyAttachmentKind(contentType: string): SmsAttachmentKind {
  const ct = (contentType ?? '').trim().toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Label for a NON-image attachment chip (images render inline, so this is used
 * for video/audio/file parts). Prefers a stable kind word ("Video"/"Audio"),
 * then the provider file name, then the generic "Attachment".
 */
export function attachmentChipLabel(att: { contentType: string; fileName: string }): string {
  const kind = classifyAttachmentKind(att.contentType);
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  const name = (att.fileName ?? '').trim();
  return name.length > 0 ? name : 'Attachment';
}

/**
 * Snippet text for a conversation row. MMS-latest threads often carry an empty
 * (or subject-only) snippet from the provider; fall back to a generic
 * "Attachment" label so the row never renders blank.
 */
export function smsSnippetLabel(snippet: string): string {
  const s = (snippet ?? '').trim();
  return s.length > 0 ? s : 'Attachment';
}
