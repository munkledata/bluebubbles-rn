package expo.modules.gatorboundeddownload

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

internal const val ATTACHMENT_CACHE_DIRECTORY = "attachments"
internal const val MAX_ATTACHMENT_CACHE_PATH_CHARS = 4096
internal const val MAX_LEGACY_ATTACHMENT_CACHE_SEGMENT_CHARS = 255
private const val MEDIA_SEGMENT_PREFIX = "media-"
private const val MAX_ENCODED_MEDIA_SEGMENT_CHARS = 180
private const val MAX_GENERATION_SEGMENT_CHARS = 32
private const val GENERATION_SEGMENT_PREFIX = "generation-"
private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val ENCODED_MEDIA_VALUE = Regex("^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})*$")
private val GENERATION_SEGMENT = Regex("^generation-(?:0|[1-9][0-9]*|unscoped)$")

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
  val canonicalRoot = root.canonicalFile
  require(canonicalRoot.path == absoluteRoot.path) {
    "Attachment cache root is not canonical"
  }
  require(!canonicalRoot.exists() || canonicalRoot.isDirectory) {
    "Attachment cache root is not a directory"
  }

  val absoluteCandidate = candidate.absoluteFile
  require(absoluteCandidate.path.length <= MAX_ATTACHMENT_CACHE_PATH_CHARS) {
    "Attachment cache path is too long"
  }
  val canonicalCandidate = candidate.canonicalFile
  require(canonicalCandidate.path == absoluteCandidate.path) {
    "Attachment cache path is not canonical"
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
    return canonicalCandidate
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
  return canonicalCandidate
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
