import { File } from 'expo-file-system';
import type { FileBase64Reader } from './sendAttachmentService';

/**
 * Production {@link FileBase64Reader}: reads a file at `uri` as base64 via the expo-file-system
 * `File` object API (SDK 56). Kept out of `sendAttachmentService` so that module stays free of
 * the expo import and remains Node-testable; the service takes this reader injected.
 */
export const expoBase64Reader: FileBase64Reader = (uri) => new File(uri).base64();
