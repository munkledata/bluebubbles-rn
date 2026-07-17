import { z } from 'zod/v4';

/** A file/media attachment on a message (Flutter: Attachment). */
export const Attachment = z.object({
  originalROWID: z.number().nullish(),
  guid: z.string(),
  uti: z.string().nullish(),
  mimeType: z.string().nullish(),
  transferName: z.string().nullish(),
  totalBytes: z.number().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  /** Server-hosted URL for web/desktop; mobile downloads to local storage. */
  webUrl: z.string().nullish(),
  hasLivePhoto: z.boolean().nullish(),
  isSticker: z.boolean().nullish(),
  /**
   * iMessage flags rich-link / plugin-payload attachments (URL previews, App Store, Apple
   * Music, …) as hidden — they back a rich card, not a real file, and must NOT render as an
   * attachment. The server sends this from chat.db's `hide_attachment`.
   */
  hideAttachment: z.boolean().nullish(),
  blurhash: z.string().nullish(),
  /**
   * Genmoji (macOS 15.1+ AI-generated emoji images). Both keys are presence-driven — the server
   * emits them ONLY on Genmoji attachments and omits them otherwise. `emojiImageContentIdentifier`
   * is the image's identity (its presence marks the attachment as a Genmoji → render inline
   * emoji-sized, not full-width); `emojiImageShortDescription` is natural-language alt text
   * (e.g. "a smiling cat wearing a top hat"), used as the accessibility label and as the
   * notification/preview fallback in place of the generic "📎 Attachment".
   */
  emojiImageContentIdentifier: z.string().nullish(),
  emojiImageShortDescription: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type Attachment = z.infer<typeof Attachment>;
