import { z } from 'zod';

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
  blurhash: z.string().nullish(),
  metadata: z.record(z.unknown()).nullish(),
});
export type Attachment = z.infer<typeof Attachment>;
