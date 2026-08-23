import { Directory, File, Paths } from 'expo-file-system';
import {
  MANUAL_ATTACHMENT_MAX_BYTES,
  MANUAL_DOWNLOAD_TIMEOUT_MS,
  type AttachmentFetcher,
} from './downloadService';
import { deleteOwnedFile, downloadBoundedNativeFile } from './boundedNativeDownload';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from './pathSafety';

function developmentDestination(guid: string, generation?: number): { dir: Directory; file: File } {
  const safeGuid = encodedMediaPathSegment(guid);
  const dir = new Directory(
    Paths.document,
    'attachments',
    safeGuid,
    mediaGenerationPathSegment(generation),
  );
  return { dir, file: new File(dir, `${safeGuid}.jpg`) };
}

/**
 * DEV-ONLY fetcher: downloads a real public image (picsum, HTTPS) with byte
 * progress, so the on-device progress ring/retry path is exercised without a
 * Gator server. Installed via setAttachmentFetcher() on the dev session.
 */
export const devProgressFetcher: AttachmentFetcher = {
  exists(localPath: string | null): boolean {
    if (!localPath) return false;
    try {
      return new File(localPath).exists;
    } catch {
      return false;
    }
  },
  destinationUri(guid: string, _transferName: string, generation?: number): string {
    return developmentDestination(guid, generation).file.uri;
  },
  async download(
    guid: string,
    _transferName: string,
    onProgress?: (loaded: number, total: number) => void,
    _service?: string | null,
    generation?: number,
    limits?,
  ) {
    const { dir, file: dest } = developmentDestination(guid, generation);
    dir.create({ intermediates: true, idempotent: true });
    const url = `https://picsum.photos/seed/${encodeURIComponent(guid)}/1200/800`;
    const maxBytes = limits?.maxBytes ?? MANUAL_ATTACHMENT_MAX_BYTES;
    const result = await downloadBoundedNativeFile({
      url,
      destination: dest,
      signal: limits?.signal,
      maxBytes,
      timeoutMs: limits?.timeoutMs ?? MANUAL_DOWNLOAD_TIMEOUT_MS,
      maxImagePixels: limits?.maxImagePixels,
      onProgress,
    });
    return { localPath: result.file.uri, bytes: result.bytes };
  },
  discard(localPath: string): void {
    try {
      const file = new File(localPath);
      deleteOwnedFile(file);
    } catch {
      // Best-effort development cache cleanup.
    }
  },
};
