import { File, Paths } from 'expo-file-system';
import type { AccountRevocationMarker } from '@core/secure';

/**
 * Durable, non-secret disconnect marker in Android's app-private documents directory.
 *
 * This deliberately does not share SecureStore's Android Keystore failure domain. The marker's
 * presence is the state; a zero-byte file is sufficient, so a content-write cannot leave a file
 * that exists but is interpreted as clear. Expo SDK 57's modern File API is synchronous for these
 * tiny metadata operations, which also means Disconnect closes this restart gate before its first
 * asynchronous SecureStore call and cannot wait forever on a filesystem promise.
 */
const ACCOUNT_REVOCATION_FILE = '.gator-account-revoked-v1';

export class ExpoAccountRevocationMarker implements AccountRevocationMarker {
  isRevoked(): boolean {
    // `exists` alone also returns false when access is denied. `info()` returns `{exists:false}` for
    // a genuinely absent file but throws on an unreadable/invalid path, allowing policy to fail
    // closed instead of confusing an I/O failure with permission to restore an account.
    return this.file().info().exists;
  }

  markRevoked(): void {
    const file = this.file();
    if (file.info().exists) return;
    try {
      // `createNewFile` is atomic on Android. Do not use `overwrite:true`: Expo implements that as
      // delete-then-create, which would briefly remove an already-valid revocation marker.
      file.create();
    } catch (error) {
      // Two callers can both observe absence before one wins the atomic create. The loser still
      // achieved the required state; only rethrow when the marker genuinely remains unavailable.
      if (file.info().exists) return;
      throw error;
    }
  }

  clear(): void {
    const file = this.file();
    if (file.info().exists) file.delete();
  }

  private file(): File {
    return new File(Paths.document, ACCOUNT_REVOCATION_FILE);
  }
}
