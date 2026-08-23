import { Directory, File, Paths } from 'expo-file-system';
import { attachmentsApi, type HttpClient } from '@core/api';
import {
  MANUAL_ATTACHMENT_MAX_BYTES,
  MANUAL_DOWNLOAD_TIMEOUT_MS,
  type AttachmentFetcher,
} from './downloadService';
import { deleteOwnedFile, downloadBoundedNativeFile } from './boundedNativeDownload';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from './pathSafety';

function attachmentDestination(
  guid: string,
  transferName: string,
  generation?: number,
): { dir: Directory; file: File } {
  const dir = new Directory(
    Paths.document,
    'attachments',
    encodedMediaPathSegment(guid),
    mediaGenerationPathSegment(generation),
  );
  return { dir, file: new File(dir, encodedMediaPathSegment(transferName)) };
}

/**
 * Real attachment fetcher (expo-file-system new object API). Saves to
 * {documents}/attachments/{guid}/{generation}/{name} with header auth (URL stays clean). The
 * account generation prevents a late old-account transfer from becoming the next account's cache
 * hit even if its best-effort post-Disconnect deletion fails. Keeping `guid` first preserves the
 * per-chat cleanup boundary; Forget still removes the top-level `attachments` directory.
 */
export function expoFetcher(http: HttpClient): AttachmentFetcher {
  return {
    exists(localPath: string | null): boolean {
      if (!localPath) return false;
      try {
        return new File(localPath).exists;
      } catch {
        return false;
      }
    },
    destinationUri(guid: string, transferName: string, generation?: number): string {
      return attachmentDestination(guid, transferName, generation).file.uri;
    },
    async download(
      guid: string,
      transferName: string,
      onProgress?: (loaded: number, total: number) => void,
      service?: string | null,
      generation?: number,
      limits?,
    ) {
      const transport = http.snapshotTransport();
      // `guid` and `transferName` are SERVER-controlled, while generation can come from an injected
      // test context — sanitize every segment before it reaches the native filesystem boundary.
      // The raw `guid` still goes to the download URL below; only the local path is sanitized.
      const { dir, file: dest } = attachmentDestination(guid, transferName, generation);
      dir.create({ intermediates: true, idempotent: true });
      const url = attachmentsApi.attachmentDownloadUrl(transport, guid, service ?? undefined);
      const maxBytes = limits?.maxBytes ?? MANUAL_ATTACHMENT_MAX_BYTES;
      const result = await downloadBoundedNativeFile({
        url,
        destination: dest,
        headers: { ...transport.headers },
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
        // Teardown cleanup is best-effort; the account-wide media sweep is the fallback.
      }
    },
  };
}
