package expo.modules.gatorboundeddownload

import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

internal const val MAX_ATTACHMENT_GUID_UTF8_BYTES = 4096
private val HASHED_ATTACHMENT_IDENTITY = Regex("^id-sha256-[0-9a-f]{64}$")
private const val LOWERCASE_HEX = "0123456789abcdef"

/** Hash exact valid UTF-8 bytes, never replacement characters, normalized text, or truncated IDs. */
internal fun attachmentCacheGuidSha256(guid: String): String {
  require(guid.isNotEmpty()) { "Attachment identifier must not be empty" }
  require(guid.length <= MAX_ATTACHMENT_GUID_UTF8_BYTES) { "Attachment identifier is too long" }
  val encoded = Charsets.UTF_8.newEncoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
    .encode(CharBuffer.wrap(guid))
  require(encoded.remaining() <= MAX_ATTACHMENT_GUID_UTF8_BYTES) { "Attachment identifier is too long" }
  val digest = MessageDigest.getInstance("SHA-256")
  digest.update(encoded)
  return buildString(64) {
    for (byte in digest.digest()) {
      val unsigned = byte.toInt() and 0xff
      append(LOWERCASE_HEX[unsigned ushr 4])
      append(LOWERCASE_HEX[unsigned and 0x0f])
    }
  }
}

/** Only identity directories gain the hash spelling; transfer filenames keep the media grammar. */
internal fun isAttachmentCacheIdentitySegment(value: String): Boolean =
  isEncodedMediaSegment(value) || HASHED_ATTACHMENT_IDENTITY.matches(value)
