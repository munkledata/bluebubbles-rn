import { Directory, File, Paths } from 'expo-file-system';
import { attachmentsApi, type HttpClient } from '@core/api';
import type { AttachmentFetcher } from './downloadService';
import { safePathSegment } from './pathSafety';

/**
 * Real attachment fetcher (expo-file-system new object API). Saves to
 * {documents}/attachments/{guid}/{name} with header auth (URL stays clean).
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
    async download(
      guid: string,
      transferName: string,
      onProgress?: (loaded: number, total: number) => void,
      service?: string | null,
    ): Promise<string> {
      // `guid` and `transferName` are SERVER-controlled — sanitize BOTH before using them as
      // path segments so a hostile server can't traverse out of {documents}/attachments/…
      // (the raw `guid` still goes to the download URL below; only the local path is sanitized).
      const dir = new Directory(Paths.document, 'attachments', safePathSegment(guid));
      dir.create({ intermediates: true, idempotent: true });
      const dest = new File(dir, safePathSegment(transferName));
      const url = attachmentsApi.attachmentDownloadUrl(http, guid, service ?? undefined);
      // createDownloadTask streams byte progress; header auth keeps the URL clean.
      // totalBytes === -1 when Content-Length is absent → reported as indeterminate.
      const task = File.createDownloadTask(url, dest, {
        headers: http.buildHeaders(),
        onProgress: ({ bytesWritten, totalBytes }) => onProgress?.(bytesWritten, totalBytes),
      });
      const file = await task.downloadAsync();
      if (!file) throw new Error(`download failed: ${guid}`);
      return file.uri;
    },
  };
}
