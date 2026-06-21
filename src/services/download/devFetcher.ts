import { Directory, File, Paths } from 'expo-file-system';
import type { AttachmentFetcher } from './downloadService';

/**
 * DEV-ONLY fetcher: downloads a real public image (picsum, HTTPS) with byte
 * progress, so the on-device progress ring/retry path is exercised without a
 * BlueBubbles server. Installed via setAttachmentFetcher() on the dev session.
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
  async download(
    guid: string,
    _transferName: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<string> {
    const dir = new Directory(Paths.document, 'attachments', guid);
    dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, `${guid}.jpg`);
    const url = `https://picsum.photos/seed/${encodeURIComponent(guid)}/1200/800`;
    const task = File.createDownloadTask(url, dest, {
      onProgress: ({ bytesWritten, totalBytes }) => onProgress?.(bytesWritten, totalBytes),
    });
    const file = await task.downloadAsync();
    if (!file) throw new Error('dev download failed');
    return file.uri;
  },
};
