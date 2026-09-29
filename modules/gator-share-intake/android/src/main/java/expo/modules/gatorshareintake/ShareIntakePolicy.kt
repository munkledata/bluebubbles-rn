package expo.modules.gatorshareintake

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.CodingErrorAction

internal const val SHARE_INPUT_CACHE_DIRECTORY = "shared-in"
internal const val SHARE_QUEUE_DIRECTORY = "queue"
internal const val SHARE_FILES_DIRECTORY = "files"
internal const val MAX_SHARED_FILES = 10
internal const val MAX_SHARED_FILE_BYTES = 128L * 1024 * 1024
internal const val MAX_SHARED_BATCH_BYTES = 512L * 1024 * 1024
internal const val MAX_SHARED_TEXT_BYTES = 64 * 1024
internal const val SHARE_BATCH_TIMEOUT_MS = 60_000L
internal const val SHARE_COPY_BUFFER_BYTES = 64 * 1024
internal const val SHARE_CACHE_MAX_BYTES = 1024L * 1024 * 1024
internal const val SHARE_CACHE_MAX_BATCHES = 32
internal const val SHARE_CACHE_MAX_ROOT_ENTRIES = 96
internal const val SHARE_CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
internal const val MAX_SHARED_NAME_BYTES = 240
internal const val MAX_SHARED_MIME_BYTES = 240
internal const val MAX_SHARED_MIME_TYPE_CHARS = 120
internal const val MAX_SHARED_TARGET_BYTES = 240
internal const val MAX_SHARE_MANIFEST_BYTES = 128 * 1024

internal const val SHARE_SHORTCUT_PREFIX = "gator-share-v2-"

private const val SHARE_MANIFEST_VERSION = 1
private val SHARE_MANIFEST_MAGIC = "GATORSHARE".toByteArray(Charsets.US_ASCII)
private val SHARE_BATCH_ID = Regex("^[0-9]{1,19}-[0-9]{1,19}-[a-f0-9]{16}$")
private val SHARE_FILE_NAME = Regex("^[0-9]{2}-[A-Za-z0-9._-]{1,100}$")
private val SHARE_SHORTCUT_ID = Regex("^gator-share-v2-[A-Za-z0-9_-]{43}$")

enum class ShareIntakeFailure {
  COUNT,
  FILE_SIZE,
  BATCH_SIZE,
  TEXT_SIZE,
  DEADLINE,
  EMPTY,
  SCHEME,
  PERMISSION,
  PROVIDER,
  CACHE_QUOTA,
  BUSY,
  MALFORMED,
}

internal class ShareIntakeException(
  val reason: ShareIntakeFailure,
) : Exception(reason.name)

internal data class ShareManifestFile(
  val name: String,
  val mimeType: String,
  val size: Long,
)

internal data class ShareManifest(
  val batchId: String,
  val createdAtMs: Long,
  val text: String?,
  val targetToken: String?,
  val files: List<ShareManifestFile>,
)

/** One actual-byte and absolute-time budget shared by every stream in an inbound share. */
internal class ShareBatchBudget(
  private val deadlineAtMs: Long,
  private val nowMs: () -> Long,
  private val maxFileBytes: Long = MAX_SHARED_FILE_BYTES,
  private val maxBatchBytes: Long = MAX_SHARED_BATCH_BYTES,
  private val bufferBytes: Int = SHARE_COPY_BUFFER_BYTES,
) {
  private var declaredBytes = 0L

  var copiedBytes: Long = 0L
    private set

  init {
    require(maxFileBytes > 0L)
    require(maxBatchBytes > 0L)
    require(bufferBytes > 0)
  }

  fun checkDeadline() {
    if (nowMs() >= deadlineAtMs) throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
  }

  /** Validate every provider declaration before the first content stream is opened. */
  fun validateDeclaredSizes(sizes: List<Long?>) {
    requireValidShareCount(sizes.size)
    sizes.forEach { raw ->
      val size = raw?.takeIf { it >= 0L } ?: return@forEach
      if (size > maxFileBytes) throw ShareIntakeException(ShareIntakeFailure.FILE_SIZE)
      if (size > maxBatchBytes - declaredBytes) {
        throw ShareIntakeException(ShareIntakeFailure.BATCH_SIZE)
      }
      declaredBytes += size
    }
  }

  fun copy(input: InputStream, output: OutputStream): Long {
    var fileBytes = 0L
    val buffer = ByteArray(bufferBytes)
    while (true) {
      checkDeadline()
      val fileRemaining = maxFileBytes - fileBytes
      val batchRemaining = maxBatchBytes - copiedBytes
      val remaining = minOf(fileRemaining, batchRemaining)
      val readLimit = minOf(buffer.size.toLong(), remaining + 1L).toInt()
      val read = input.read(buffer, 0, readLimit)
      checkDeadline()
      if (read < 0) break
      if (read == 0) continue
      if (read.toLong() > fileRemaining) {
        throw ShareIntakeException(ShareIntakeFailure.FILE_SIZE)
      }
      if (read.toLong() > batchRemaining) {
        throw ShareIntakeException(ShareIntakeFailure.BATCH_SIZE)
      }
      output.write(buffer, 0, read)
      fileBytes += read.toLong()
      copiedBytes += read.toLong()
    }
    if (fileBytes == 0L) throw ShareIntakeException(ShareIntakeFailure.EMPTY)
    output.flush()
    return fileBytes
  }
}

internal fun requireValidShareCount(count: Int) {
  if (count !in 1..MAX_SHARED_FILES) throw ShareIntakeException(ShareIntakeFailure.COUNT)
}

internal fun requireSupportedShareUriScheme(scheme: String?) {
  if (scheme != "content") throw ShareIntakeException(ShareIntakeFailure.SCHEME)
}

internal fun requireValidSharedText(text: String?): String? {
  val normalized = text?.takeIf { it.isNotEmpty() } ?: return null
  if (normalized.toByteArray(Charsets.UTF_8).size > MAX_SHARED_TEXT_BYTES) {
    throw ShareIntakeException(ShareIntakeFailure.TEXT_SIZE)
  }
  return normalized
}

internal fun requireValidShareTarget(target: String?): String? {
  val normalized = target?.takeIf { it.isNotEmpty() } ?: return null
  if (!SHARE_SHORTCUT_ID.matches(normalized)) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
  return normalized
}

/** Prefer a concrete provider type; wildcard/invalid hints remain safe generic binary data. */
internal fun resolvedShareMimeType(providerType: String?, intentType: String?): String {
  fun concrete(raw: String?): String? {
    val normalized = raw?.trim()?.lowercase().orEmpty()
    if (
      normalized.length !in 1..MAX_SHARED_MIME_TYPE_CHARS ||
      '*' in normalized ||
      !Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$").matches(normalized)
    ) {
      return null
    }
    return normalized
  }
  return concrete(providerType) ?: concrete(intentType) ?: "application/octet-stream"
}

internal fun requireValidShareBatchId(batchId: String): String {
  if (!SHARE_BATCH_ID.matches(batchId)) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
  return batchId
}

/**
 * Produce one display-safe, collision-free filename. The two-digit ordinal is part of the owned
 * on-disk shape and is independently checked while a manifest is read.
 */
internal fun sharedFileName(index: Int, rawName: String?, mimeType: String): String {
  if (index !in 0 until MAX_SHARED_FILES) throw ShareIntakeException(ShareIntakeFailure.COUNT)
  val extension = extensionForMime(mimeType)
  val rawLeaf = rawName
    ?.substringAfterLast('/')
    ?.substringAfterLast('\\')
    ?.trim()
    .orEmpty()
  val cleaned = rawLeaf
    .map { character ->
      when {
        character.isLetterOrDigit() && character.code <= 0x7f -> character
        character == '.' || character == '_' || character == '-' -> character
        else -> '_'
      }
    }
    .joinToString("")
    .trim('.', '_')
    .take(90)
  val leaf = when {
    cleaned.isEmpty() -> "attachment$extension"
    '.' in cleaned -> cleaned
    else -> "$cleaned$extension"
  }
  return "%02d-%s".format(index, leaf.take(100)).also { name ->
    if (!SHARE_FILE_NAME.matches(name)) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
}

private fun extensionForMime(mimeType: String): String = when (mimeType.lowercase()) {
  "image/jpeg" -> ".jpg"
  "image/png" -> ".png"
  "image/gif" -> ".gif"
  "image/webp" -> ".webp"
  "video/mp4" -> ".mp4"
  "application/pdf" -> ".pdf"
  "text/plain" -> ".txt"
  "text/vcard", "text/x-vcard" -> ".vcf"
  else -> ".bin"
}

internal fun encodeShareManifest(manifest: ShareManifest): ByteArray {
  validateShareManifest(manifest)
  val bytes = ByteArrayOutputStream()
  DataOutputStream(bytes).use { output ->
    output.write(SHARE_MANIFEST_MAGIC)
    output.writeInt(SHARE_MANIFEST_VERSION)
    writeBoundedString(output, manifest.batchId, 96)
    output.writeLong(manifest.createdAtMs)
    writeNullableString(output, manifest.text, MAX_SHARED_TEXT_BYTES)
    writeNullableString(output, manifest.targetToken, MAX_SHARED_TARGET_BYTES)
    output.writeInt(manifest.files.size)
    manifest.files.forEach { file ->
      writeBoundedString(output, file.name, MAX_SHARED_NAME_BYTES)
      writeBoundedString(output, file.mimeType, MAX_SHARED_MIME_BYTES)
      output.writeLong(file.size)
    }
  }
  return bytes.toByteArray().also { encoded ->
    if (encoded.size > MAX_SHARE_MANIFEST_BYTES) {
      throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    }
  }
}

internal fun decodeShareManifest(bytes: ByteArray): ShareManifest {
  if (bytes.isEmpty() || bytes.size > MAX_SHARE_MANIFEST_BYTES) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
  try {
    DataInputStream(ByteArrayInputStream(bytes)).use { input ->
      val magic = ByteArray(SHARE_MANIFEST_MAGIC.size)
      input.readFully(magic)
      if (!magic.contentEquals(SHARE_MANIFEST_MAGIC)) {
        throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
      }
      if (input.readInt() != SHARE_MANIFEST_VERSION) {
        throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
      }
      val manifest = ShareManifest(
        batchId = readBoundedString(input, 96),
        createdAtMs = input.readLong(),
        text = readNullableString(input, MAX_SHARED_TEXT_BYTES),
        targetToken = readNullableString(input, MAX_SHARED_TARGET_BYTES),
        files = List(input.readInt().also { count ->
          if (count !in 0..MAX_SHARED_FILES) {
            throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
          }
        }) {
          ShareManifestFile(
            name = readBoundedString(input, MAX_SHARED_NAME_BYTES),
            mimeType = readBoundedString(input, MAX_SHARED_MIME_BYTES),
            size = input.readLong(),
          )
        },
      )
      if (input.read() != -1) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
      validateShareManifest(manifest)
      return manifest
    }
  } catch (error: ShareIntakeException) {
    throw error
  } catch (_: EOFException) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  } catch (_: Exception) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
}

internal fun validateShareManifest(manifest: ShareManifest) {
  requireValidShareBatchId(manifest.batchId)
  if (manifest.createdAtMs <= 0L) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  val text = requireValidSharedText(manifest.text)
  requireValidShareTarget(manifest.targetToken)
  if (text == null && manifest.files.isEmpty()) {
    throw ShareIntakeException(ShareIntakeFailure.EMPTY)
  }
  if (manifest.files.size > MAX_SHARED_FILES) {
    throw ShareIntakeException(ShareIntakeFailure.COUNT)
  }
  var total = 0L
  manifest.files.forEachIndexed { index, file ->
    if (!SHARE_FILE_NAME.matches(file.name) || !file.name.startsWith("%02d-".format(index))) {
      throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    }
    requireValidUtf8(file.name, MAX_SHARED_NAME_BYTES)
    requireValidUtf8(file.mimeType, MAX_SHARED_MIME_BYTES)
    if (file.mimeType.isEmpty() || file.size <= 0L || file.size > MAX_SHARED_FILE_BYTES) {
      throw ShareIntakeException(ShareIntakeFailure.FILE_SIZE)
    }
    if (file.size > MAX_SHARED_BATCH_BYTES - total) {
      throw ShareIntakeException(ShareIntakeFailure.BATCH_SIZE)
    }
    total += file.size
  }
}

private fun writeNullableString(output: DataOutputStream, value: String?, maxBytes: Int) {
  output.writeBoolean(value != null)
  if (value != null) writeBoundedString(output, value, maxBytes)
}

private fun readNullableString(input: DataInputStream, maxBytes: Int): String? =
  if (input.readBoolean()) readBoundedString(input, maxBytes) else null

private fun writeBoundedString(output: DataOutputStream, value: String, maxBytes: Int) {
  val encoded = value.toByteArray(Charsets.UTF_8)
  if (encoded.size > maxBytes) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  output.writeInt(encoded.size)
  output.write(encoded)
}

private fun readBoundedString(input: DataInputStream, maxBytes: Int): String {
  val length = input.readInt()
  if (length !in 0..maxBytes) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  val encoded = ByteArray(length)
  input.readFully(encoded)
  return try {
    Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(java.nio.ByteBuffer.wrap(encoded))
      .toString()
  } catch (_: Exception) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
}

private fun requireValidUtf8(value: String, maxBytes: Int) {
  if (value.toByteArray(Charsets.UTF_8).size > maxBytes) {
    throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
  }
}
