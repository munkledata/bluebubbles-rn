/**
 * Tell a LOCAL file failure apart from a network failure when an attachment upload throws.
 *
 * `expo-file-system`'s native uploader raises an ordinary `IOException` for both, so before this
 * every failure was wrapped as `no_connection` and the failed bubble read "Connection Refused" —
 * blaming the server for a file that simply wasn't there. The messages below are the ones the
 * Android side actually produces (`FileSystemLegacyModule.kt`: `checkIfFileExists` →
 * "Directory for '…' doesn't exist.", `ensurePermission` → "Location '…' isn't readable.") plus
 * the usual POSIX wording.
 *
 * PURE (no expo imports) so it stays testable in the node jest project — `attachmentUpload.ts`
 * itself can't be, since it imports expo-file-system.
 */

const LOCAL_FILE_PATTERNS =
  /ENOENT|EACCES|no such file|doesn'?t exist|does not exist|isn'?t readable|is not readable|unable to open|could not be opened|filenotfound|permission denied|unsupported scheme/i;

/** Does this thrown value describe a file on THIS device being missing or unreadable? */
export function isLocalFileFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  return LOCAL_FILE_PATTERNS.test(message);
}
