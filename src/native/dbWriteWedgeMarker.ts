import { File, Paths } from 'expo-file-system';

/**
 * Durable, non-secret record that the database write queue wedged (review M045).
 *
 * The wedge's own error report cannot be saved while the queue is stuck, because saving it needs
 * that queue. This zero-byte file in Android's app-private documents directory keeps the fact for
 * the next launch, where error reporting replays it. As with the account revocation marker, the
 * file's presence is the whole state, and Expo SDK 57's File API is synchronous for these tiny
 * metadata operations, so recording never waits on the stuck database or a filesystem promise.
 */
const DB_WRITE_WEDGE_FILE = '.gator-db-write-wedge-v1';

export class ExpoDbWriteWedgeMarker {
  isMarked(): boolean {
    return this.file().info().exists;
  }

  mark(): void {
    const file = this.file();
    if (file.info().exists) return;
    try {
      file.create();
    } catch (error) {
      // A concurrent create may win first; only fail when the record is genuinely missing.
      if (file.info().exists) return;
      throw error;
    }
  }

  clear(): void {
    const file = this.file();
    if (file.info().exists) file.delete();
  }

  private file(): File {
    return new File(Paths.document, DB_WRITE_WEDGE_FILE);
  }
}
