/**
 * Make a SERVER-supplied string safe to use as a single filesystem path segment.
 *
 * Attachment `guid` and `transferName` both come straight from the server. expo-file-system's
 * `resolve()` keeps a leading `..` (unlike Node's `path.resolve`), so a hostile/compromised
 * server sending `guid: "../../databases"` + `transferName: "gator.db"` could otherwise
 * escape `{documents}/attachments/…` and overwrite the SQLCipher DB (permanent message loss).
 *
 * We neutralize BOTH escape routes: path separators (so a value can never introduce a new path
 * level) and an all-dots segment like `.` / `..` (a parent-directory reference). Everything else
 * is preserved, so legitimate guids/filenames land at the same place they always did.
 */
export function safePathSegment(s: string): string {
  const cleaned = s.replace(/[/\\]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}
