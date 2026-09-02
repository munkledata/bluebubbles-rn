package expo.modules.gatorboundeddownload

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

internal const val ATTACHMENT_CACHE_DIRECTORY = "attachments"
internal const val PASTED_INPUT_CACHE_DIRECTORY = "pasted-in"
internal const val MAX_ATTACHMENT_CACHE_PATH_CHARS = 4096
internal const val MAX_LEGACY_ATTACHMENT_CACHE_SEGMENT_CHARS = 255
internal const val MAX_PASTED_ATTACHMENT_BYTES = 128L * 1024 * 1024
private const val MAX_PASTED_BATCH_FILES = 10
private const val MEDIA_SEGMENT_PREFIX = "media-"
private const val MAX_ENCODED_MEDIA_SEGMENT_CHARS = 180
private const val MAX_GENERATION_SEGMENT_CHARS = 32
private const val GENERATION_SEGMENT_PREFIX = "generation-"
private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val ENCODED_MEDIA_VALUE = Regex("^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})*$")
private val GENERATION_SEGMENT = Regex("^generation-(?:0|[1-9][0-9]*|unscoped)$")
private val COMMITTED_PASTE_BATCH = Regex("^(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*))?$")

/**
 * Canonicalize only ancestors of a native-fixed root, never the root entry itself.
 *
 * Android can expose the same app sandbox through two OS-owned path spellings. Requiring the raw
 * `filesDir` spelling to equal `canonicalFile` therefore rejects valid files on some devices. The
 * root's parent is trusted native input, so its alias may resolve; rebuilding the final component
 * below that canonical parent still rejects a symlink or alias at the cache root itself.
 */
internal fun canonicalOwnedRoot(root: File, label: String): File {
  val absoluteRoot = root.absoluteFile
  val absoluteParent = absoluteRoot.parentFile
    ?: throw IllegalArgumentException("$label has no parent directory")
  val canonicalParent = absoluteParent.canonicalFile
  val expectedCanonicalRoot = File(canonicalParent, absoluteRoot.name).absoluteFile
  val canonicalRoot = root.canonicalFile
  require(canonicalRoot.path == expectedCanonicalRoot.path) {
    "$label entry is a symlink or alias"
  }
  return canonicalRoot
}

/**
 * Resolve one descendant while permitting only the trusted root's inherited ancestor alias.
 *
 * The raw relative spelling is transplanted beneath the already-validated canonical root. Any
 * `..`, intermediate symlink, or final symlink makes the actual canonical path differ from that
 * expected spelling and is rejected.
 */
internal fun canonicalOwnedDescendant(
  root: File,
  canonicalRoot: File,
  candidate: File,
  label: String,
): File {
  val absoluteRoot = root.absoluteFile
  val absoluteCandidate = candidate.absoluteFile
  val prefix = absoluteRoot.path + File.separator
  require(absoluteCandidate.path.startsWith(prefix)) { "$label is outside the owned root" }
  val relativePath = absoluteCandidate.path.substring(prefix.length)
  require(relativePath.isNotEmpty()) { "$label is the owned root" }
  val expectedCanonical = File(canonicalRoot, relativePath).absoluteFile
  val canonicalCandidate = candidate.canonicalFile
  require(canonicalCandidate.path == expectedCanonical.path) {
    "$label is not canonical beneath the owned root"
  }
  return canonicalCandidate
}

/**
 * Validate one exact ordinary-attachment cache file without requiring it to still exist.
 *
 * The fixed root comes from `appContext.persistentFilesDirectory`; JavaScript cannot choose it.
 * Canonical equality rejects `..`, symlinks (including a symlinked parent), and alternate path
 * spellings. Two layouts are accepted during the pre-ledger upgrade:
 *
 * - current: `attachments/media-<encoded>/generation-(<digits>|unscoped)/media-<encoded>`
 * - legacy: `attachments/<safePathSegment(guid)>/<safePathSegment(name)>`
 *
 * Legacy names are deliberately broader because the old lossy writer preserved spaces, Unicode,
 * and literal percent signs. They remain bounded ordinary names at one exact depth. The bridge
 * separately requires an exact file-URI round trip and a regular-file lstat before deleting one
 * non-recursive target.
 */
internal fun requireOwnedAttachmentCachePath(root: File, candidate: File): File {
  val absoluteRoot = root.absoluteFile
  val canonicalRoot = canonicalOwnedRoot(root, "Attachment cache root")
  require(!canonicalRoot.exists() || canonicalRoot.isDirectory) {
    "Attachment cache root is not a directory"
  }

  val absoluteCandidate = candidate.absoluteFile
  require(absoluteCandidate.path.length <= MAX_ATTACHMENT_CACHE_PATH_CHARS) {
    "Attachment cache path is too long"
  }
  val canonicalCandidate = canonicalOwnedDescendant(
    root,
    canonicalRoot,
    candidate,
    "Attachment cache path",
  )
  require(canonicalCandidate.path.length <= MAX_ATTACHMENT_CACHE_PATH_CHARS) {
    "Canonical attachment cache path is too long"
  }
  val parentDirectory = canonicalCandidate.parentFile
    ?: throw IllegalArgumentException("Attachment cache path has no parent directory")

  if (parentDirectory.parentFile?.path == canonicalRoot.path) {
    require(isLegacyAttachmentCacheSegment(parentDirectory.name)) {
      "Legacy attachment cache directory is invalid"
    }
    require(isLegacyAttachmentCacheSegment(canonicalCandidate.name)) {
      "Legacy attachment cache filename is invalid"
    }
    return absoluteCandidate
  }

  val mediaDirectory = parentDirectory.parentFile
    ?: throw IllegalArgumentException("Attachment cache path has no media directory")
  require(mediaDirectory.parentFile?.path == canonicalRoot.path) {
    "Attachment cache path is outside the owned namespace"
  }
  require(isEncodedMediaSegment(mediaDirectory.name)) {
    "Attachment cache media directory is invalid"
  }
  require(isAttachmentCacheGenerationSegment(parentDirectory.name)) {
    "Attachment cache generation directory is invalid"
  }
  require(isEncodedMediaSegment(canonicalCandidate.name)) {
    "Attachment cache filename is invalid"
  }
  return absoluteCandidate
}

/** Accept only the current generation-scoped layout used for newly adopted outgoing files. */
internal fun requireOwnedCurrentAttachmentCachePath(root: File, candidate: File): File {
  val target = requireOwnedAttachmentCachePath(root, candidate)
  val generationDirectory = target.parentFile
    ?: throw IllegalArgumentException("Attachment cache path has no generation directory")
  val mediaDirectory = generationDirectory.parentFile
    ?: throw IllegalArgumentException("Attachment cache path has no media directory")
  require(mediaDirectory.parentFile?.path == root.absoluteFile.path) {
    "Outgoing attachment destination must use the current cache namespace"
  }
  require(isEncodedMediaSegment(mediaDirectory.name)) {
    "Outgoing attachment media directory is invalid"
  }
  require(isAttachmentCacheGenerationSegment(generationDirectory.name)) {
    "Outgoing attachment generation directory is invalid"
  }
  require(isEncodedMediaSegment(target.name)) {
    "Outgoing attachment filename is invalid"
  }
  return target
}

/**
 * Resolve one exact completed rich-paste file beneath the native-fixed cache root.
 *
 * The whole bounded batch is validated before returning. This prevents a corrupt sibling symlink
 * from turning a later empty-directory cleanup into a traversal primitive.
 */
internal fun requireOwnedPastedAttachment(root: File, candidate: File): File {
  val canonicalRoot = canonicalOwnedRoot(root, "Paste cache root")
  require(canonicalRoot.isDirectory) { "Paste cache root is unavailable" }

  val absoluteCandidate = candidate.absoluteFile
  require(absoluteCandidate.path.length <= MAX_ATTACHMENT_CACHE_PATH_CHARS) {
    "Pasted attachment path is too long"
  }
  val canonicalTarget = canonicalOwnedDescendant(
    root,
    canonicalRoot,
    candidate,
    "Pasted attachment path",
  )
  val canonicalBatch = canonicalTarget.parentFile
    ?: throw IllegalArgumentException("Pasted attachment has no batch")
  require(
    canonicalBatch.parentFile?.path == canonicalRoot.path &&
      COMMITTED_PASTE_BATCH.matches(canonicalBatch.name),
  ) {
    "Pasted attachment is outside a committed batch"
  }
  require(canonicalBatch.isDirectory && canonicalTarget.isFile) {
    "Pasted attachment is not a regular file"
  }

  val rawBatch = absoluteCandidate.parentFile
    ?: throw IllegalArgumentException("Pasted attachment has no raw batch")
  val siblings = rawBatch.listFiles() ?: throw IllegalArgumentException("Paste batch is unreadable")
  require(siblings.isNotEmpty() && siblings.size <= MAX_PASTED_BATCH_FILES) {
    "Paste batch has an invalid file count"
  }
  siblings.forEach { raw ->
    val sibling = canonicalOwnedDescendant(root, canonicalRoot, raw, "Pasted attachment sibling")
    require(
      sibling.parentFile?.path == canonicalBatch.path &&
        sibling.isFile,
    ) { "Paste batch contains an invalid file" }
  }
  require(siblings.any { it.absoluteFile.path == absoluteCandidate.path }) {
    "Pasted attachment is not in its batch"
  }
  return absoluteCandidate
}

/** Remove only the two exact empty current-layout parents created for one reserved file. */
internal fun pruneEmptyAttachmentCacheParents(root: File, target: File) {
  val ownedTarget = requireOwnedCurrentAttachmentCachePath(root, target)
  val generation = ownedTarget.parentFile ?: return
  val media = generation.parentFile ?: return
  if (generation.listFiles()?.isEmpty() == true) generation.delete()
  if (media.listFiles()?.isEmpty() == true) media.delete()
}

/** Match non-empty canonical output of JavaScript's `encodedMediaPathSegment`. */
internal fun isEncodedMediaSegment(value: String): Boolean {
  if (!value.startsWith(MEDIA_SEGMENT_PREFIX)) return false
  val encoded = value.substring(MEDIA_SEGMENT_PREFIX.length)
  if (
    encoded.isEmpty() ||
    encoded.length > MAX_ENCODED_MEDIA_SEGMENT_CHARS ||
    !ENCODED_MEDIA_VALUE.matches(encoded)
  ) {
    return false
  }

  val decodedBytes = ByteArray(encoded.length)
  var decodedLength = 0
  var index = 0
  while (index < encoded.length) {
    val current = encoded[index]
    if (current == '%') {
      val byteValue = encoded.substring(index + 1, index + 3).toInt(16)
      // `encodeURIComponent` never escapes its own ASCII allow-list. Reject aliases such as
      // `%41` for `A`; exact re-encoding in JavaScript makes the same distinction.
      if (byteValue < 0x80 && isEncodeUriComponentLiteral(byteValue.toChar())) return false
      decodedBytes[decodedLength] = byteValue.toByte()
      decodedLength += 1
      index += 3
      continue
    }
    decodedBytes[decodedLength] = current.code.toByte()
    decodedLength += 1
    index += 1
  }

  return try {
    Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(decodedBytes, 0, decodedLength))
    true
  } catch (_: CharacterCodingException) {
    false
  }
}

/** Match the only generation directories written by the attachment fetchers. */
internal fun isAttachmentCacheGenerationSegment(value: String): Boolean {
  if (value.length > MAX_GENERATION_SEGMENT_CHARS || !GENERATION_SEGMENT.matches(value)) return false
  if (value == "generation-unscoped") return true
  val generation = value.substring(GENERATION_SEGMENT_PREFIX.length).toLongOrNull() ?: return false
  return generation <= JS_MAX_SAFE_INTEGER
}

/** Match one exact segment emitted by the old `safePathSegment` cache writer. */
internal fun isLegacyAttachmentCacheSegment(value: String): Boolean =
  value.isNotEmpty() &&
    value.length <= MAX_LEGACY_ATTACHMENT_CACHE_SEGMENT_CHARS &&
    value.none { character -> character == '/' || character == '\\' || character == '\u0000' } &&
    value.any { character -> character != '.' }

private fun isEncodeUriComponentLiteral(value: Char): Boolean =
  value in 'A'..'Z' ||
    value in 'a'..'z' ||
    value in '0'..'9' ||
    value == '-' ||
    value == '_' ||
    value == '.' ||
    value == '!' ||
    value == '~' ||
    value == '*' ||
    value == '\'' ||
    value == '(' ||
    value == ')'
