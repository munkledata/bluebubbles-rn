import { Directory, File, Paths } from 'expo-file-system';
import {
  MANUAL_ATTACHMENT_MAX_BYTES,
  MANUAL_DOWNLOAD_TIMEOUT_MS,
  type AttachmentFetcher,
} from './downloadService';
import { deleteOwnedFile, downloadBoundedNativeFile } from './boundedNativeDownload';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from './pathSafety';

// The bounded downloader deliberately rejects redirects. Keep this synthetic DEV fixture on the
// direct Picsum CDN object instead of the public seed endpoint, which responds with HTTP 302.
const DEV_PROGRESS_IMAGE_URL =
  'https://fastly.picsum.photos/id/1078/1200/800.jpg?hmac=AaoeVGhypi-ZEGH8YpfSBDKaT3Lya5Hr4ETQOkVoqiI';

function developmentDestination(
  guid: string,
  transferName: string,
  generation?: number,
): { dir: Directory; file: File } {
  const safeGuid = encodedMediaPathSegment(guid);
  const dir = new Directory(
    Paths.document,
    'attachments',
    safeGuid,
    mediaGenerationPathSegment(generation),
  );
  return { dir, file: new File(dir, encodedMediaPathSegment(transferName)) };
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
  destinationUri(guid: string, transferName: string, generation?: number): string {
    return developmentDestination(guid, transferName, generation).file.uri;
  },
  async download(
    guid: string,
    transferName: string,
    onProgress?: (loaded: number, total: number) => void,
    _service?: string | null,
    generation?: number,
    limits?,
  ) {
    const { dir, file: dest } = developmentDestination(guid, transferName, generation);
    dir.create({ intermediates: true, idempotent: true });
    const maxBytes = limits?.maxBytes ?? MANUAL_ATTACHMENT_MAX_BYTES;
    const result = await downloadBoundedNativeFile({
      url: DEV_PROGRESS_IMAGE_URL,
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
