package expo.modules.gatorpasteinput

import java.io.File
import java.io.InputStream
import java.io.OutputStream

internal const val MAX_PASTED_FILES = 10
internal const val MAX_PASTED_FILE_BYTES = 128L * 1024 * 1024
internal const val MAX_PASTED_BATCH_BYTES = 512L * 1024 * 1024
internal const val PASTE_BATCH_TIMEOUT_MS = 60_000L
internal const val PASTE_COPY_BUFFER_BYTES = 64 * 1024
internal const val PASTE_CACHE_MAX_BYTES = 1024L * 1024 * 1024
internal const val PASTE_CACHE_MAX_BATCHES = 32
internal const val PASTE_CACHE_MAX_ROOT_ENTRIES = 64
internal const val PASTE_CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
internal const val MAX_PROTECTED_PASTE_PATHS = 2_000
internal const val MAX_PROTECTED_PASTE_URI_CHARS = 4_096

private val COMMITTED_BATCH_DIRECTORY = Regex("^\\d+-\\d+$")
private val PENDING_BATCH_DIRECTORY = Regex("^\\d+-\\d+\\.pending$")
// The pre-worker implementation used only System.currentTimeMillis() as its directory name.
private val LEGACY_BATCH_DIRECTORY = Regex("^\\d+$")

internal enum class PasteBatchFailure {
  COUNT,
  FILE_SIZE,
  BATCH_SIZE,
  DEADLINE,
  EMPTY,
  UNAVAILABLE,
  CACHE_QUOTA,
}

internal class PasteBatchException(
  val reason: PasteBatchFailure,
) : Exception(reason.name)

/**
 * One budget shared by every stream in a paste batch.
 *
 * The deadline is absolute and begins when the UI listener receives the payload, so time spent
 * waiting behind the single worker or querying a provider consumes the same allowance as copying.
 * The stream loop reads at most the remaining allowance plus one sentinel byte and never writes
 * that sentinel, closing both per-file and aggregate size races when a provider reports no size.
 */
internal class PasteBatchBudget(
  private val deadlineAtMs: Long,
  private val nowMs: () -> Long,
  private val maxFileBytes: Long = MAX_PASTED_FILE_BYTES,
  private val maxBatchBytes: Long = MAX_PASTED_BATCH_BYTES,
  private val bufferBytes: Int = PASTE_COPY_BUFFER_BYTES,
) {
  private var reportedBytes = 0L

  var copiedBytes: Long = 0L
    private set

  init {
    require(maxFileBytes > 0L)
    require(maxBatchBytes > 0L)
    require(bufferBytes > 0)
  }

  fun checkDeadline() {
    requirePasteDeadline(nowMs(), deadlineAtMs)
  }

  /** Reject every declared-size failure before the first provider stream is opened. */
  fun validateReportedSizes(sizes: List<Long?>) {
    requireValidPasteCount(sizes.size)
    sizes.forEach(::validateReportedSize)
  }

  /** Add one provider declaration; callers stop querying the batch as soon as this rejects. */
  fun validateReportedSize(rawSize: Long?) {
    val size = rawSize?.takeIf { it >= 0L } ?: return
    if (size > maxFileBytes) throw PasteBatchException(PasteBatchFailure.FILE_SIZE)
    if (size > maxBatchBytes - reportedBytes) {
      throw PasteBatchException(PasteBatchFailure.BATCH_SIZE)
    }
    reportedBytes += size
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
      // A blocking provider read may return just as the deadline fires. Do not write those bytes.
      checkDeadline()
      if (read < 0) break
      if (read == 0) continue
      if (read.toLong() > fileRemaining) {
        throw PasteBatchException(PasteBatchFailure.FILE_SIZE)
      }
      if (read.toLong() > batchRemaining) {
        throw PasteBatchException(PasteBatchFailure.BATCH_SIZE)
      }
      output.write(buffer, 0, read)
      fileBytes += read.toLong()
      copiedBytes += read.toLong()
    }
    if (fileBytes == 0L) throw PasteBatchException(PasteBatchFailure.EMPTY)
    output.flush()
    return fileBytes
  }
}

internal fun requirePasteDeadline(nowMs: Long, deadlineAtMs: Long) {
  if (nowMs >= deadlineAtMs) throw PasteBatchException(PasteBatchFailure.DEADLINE)
}

/** Only grant-mediated ContentProviders may act as rich-paste sources. */
internal fun isSupportedPasteUriScheme(scheme: String?): Boolean = scheme == "content"

internal fun requireValidPasteCount(count: Int) {
  if (count !in 1..MAX_PASTED_FILES) throw PasteBatchException(PasteBatchFailure.COUNT)
}

internal data class PasteCacheStats(
  val committedBatches: Int,
  val committedBytes: Long,
)

/**
 * Remove only exact pending, empty, or expired unreferenced directories, then measure retained bytes.
 *
 * The root is app-private, but its contents are still treated as corrupt until they match the
 * module's exact shape. Unknown entries, symlinks, nested directories, and oversized scans fail
 * closed without being deleted. `File.listFiles()` necessarily materializes Android's directory
 * listing; the entry ceiling bounds child-directory traversal and deletion. An over-cap legacy
 * root receives a bounded cleanup chunk and the paste still fails closed until a later pass brings
 * the root under the ceiling.
 */
internal fun inspectPasteCacheRoot(
  root: File,
  nowMs: Long,
  protectedPaths: Set<String>,
  maxAgeMs: Long = PASTE_CACHE_MAX_AGE_MS,
  maxRootEntries: Int = PASTE_CACHE_MAX_ROOT_ENTRIES,
): PasteCacheStats {
  require(maxAgeMs >= 0L)
  require(maxRootEntries > 0)
  require(protectedPaths.size <= MAX_PROTECTED_PASTE_PATHS)
  if (!root.exists() && !root.mkdirs()) throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
  val canonicalRoot = canonicalPlainPasteFile(root)
    ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  if (!canonicalRoot.isDirectory) throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)

  val cutoff = if (nowMs < Long.MIN_VALUE + maxAgeMs) Long.MIN_VALUE else nowMs - maxAgeMs
  val firstPass = canonicalRoot.listFiles()
    ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  // `listFiles()` itself necessarily materializes the root listing. If an older release left more
  // directories than today's ceiling, perform only a bounded number of exact pending/expired
  // deletions, then reject this paste and let the next attach/paste continue the migration.
  if (firstPass.size > maxRootEntries) {
    cleanupPasteRootOverage(canonicalRoot, firstPass, cutoff, protectedPaths, maxRootEntries)
    throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  }
  firstPass.forEach { raw ->
    val entry = canonicalPlainPasteFile(raw)
      ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    if (entry.parentFile?.path != canonicalRoot.path || !entry.isDirectory) {
      throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
    when {
      PENDING_BATCH_DIRECTORY.matches(entry.name) -> {
        deleteOwnedPasteBatchDirectory(entry, allowEmpty = true)
      }
      COMMITTED_BATCH_DIRECTORY.matches(entry.name) || LEGACY_BATCH_DIRECTORY.matches(entry.name) -> {
        val stamp = entry.name.substringBefore('-').toLongOrNull()
          ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
        // Validate every child before deletion. Age is authority only after the DB snapshot proves
        // that no attachment row or outgoing queue fallback still owns a file in this batch.
        val files = ownedPasteBatchFiles(entry, allowEmpty = true)
        // Older releases could leave an exact timestamp-only directory empty after every copy
        // failed. It is abandoned, not a permanent cache-poisoning unknown entry.
        if (files.isEmpty() || (stamp < cutoff && files.none { it.path in protectedPaths })) {
          deleteOwnedPasteBatchDirectory(entry, allowEmpty = true)
        }
      }
      else -> throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
  }

  val retained = canonicalRoot.listFiles()
    ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  if (retained.size > maxRootEntries) throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)

  var batches = 0
  var bytes = 0L
  retained.forEach { raw ->
    val batch = canonicalPlainPasteFile(raw)
      ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    if (
      batch.parentFile?.path != canonicalRoot.path ||
      !batch.isDirectory ||
      !(COMMITTED_BATCH_DIRECTORY.matches(batch.name) || LEGACY_BATCH_DIRECTORY.matches(batch.name))
    ) {
      throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
    ownedPasteBatchFiles(batch, allowEmpty = false).forEach { file ->
      val length = file.length()
      if (length <= 0L || length > MAX_PASTED_FILE_BYTES || bytes > Long.MAX_VALUE - length) {
        throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
      }
      bytes += length
    }
    batches += 1
  }
  return PasteCacheStats(batches, bytes)
}

/** Reserve one new committed directory and return the exact actual-byte budget it may consume. */
internal fun availablePasteBatchBytes(
  stats: PasteCacheStats,
  maxCacheBytes: Long = PASTE_CACHE_MAX_BYTES,
  maxBatches: Int = PASTE_CACHE_MAX_BATCHES,
  maxBatchBytes: Long = MAX_PASTED_BATCH_BYTES,
): Long {
  require(maxCacheBytes > 0L)
  require(maxBatches > 0)
  require(maxBatchBytes > 0L)
  if (stats.committedBatches >= maxBatches || stats.committedBytes >= maxCacheBytes) {
    throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  }
  val available = minOf(maxBatchBytes, maxCacheBytes - stats.committedBytes)
  if (available <= 0L) throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  return available
}

/** Reject path aliases/symlinks instead of following them during quota scans or cleanup. */
private fun canonicalPlainPasteFile(file: File): File? = runCatching {
  file.canonicalFile.takeIf { canonical -> canonical.path == file.absoluteFile.path }
}.getOrNull()

/** Canonicalize one possibly-missing DB reference under an exact committed paste batch. */
internal fun ownedPasteReferencePath(root: File, candidate: File): String? {
  if (candidate.absolutePath.length > MAX_PROTECTED_PASTE_URI_CHARS) return null
  val canonicalRoot = canonicalPlainPasteFile(root) ?: return null
  val target = canonicalPlainPasteFile(candidate) ?: return null
  val batch = target.parentFile ?: return null
  if (
    batch.parentFile?.path != canonicalRoot.path ||
    !(COMMITTED_BATCH_DIRECTORY.matches(batch.name) || LEGACY_BATCH_DIRECTORY.matches(batch.name))
  ) {
    return null
  }
  return target.path
}

private fun ownedPasteBatchFiles(directory: File, allowEmpty: Boolean): List<File> {
  val rawFiles = directory.listFiles() ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  if (rawFiles.size > MAX_PASTED_FILES || (!allowEmpty && rawFiles.isEmpty())) {
    throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  }
  return rawFiles.map { raw ->
    val file = canonicalPlainPasteFile(raw)
      ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    if (!file.isFile || file.parentFile?.path != directory.path) {
      throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
    file
  }
}

internal fun deleteOwnedPasteBatchDirectory(directory: File, allowEmpty: Boolean) {
  ownedPasteBatchFiles(directory, allowEmpty).forEach { file ->
    if (!file.delete() && file.exists()) throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  }
  if (!directory.delete() && directory.exists()) {
    throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
  }
}

private fun cleanupPasteRootOverage(
  root: File,
  entries: Array<File>,
  cutoff: Long,
  protectedPaths: Set<String>,
  maxDeletes: Int,
) {
  var deleted = 0
  entries.forEach { raw ->
    if (deleted >= maxDeletes) return
    val pending = PENDING_BATCH_DIRECTORY.matches(raw.name)
    val stamp = when {
      COMMITTED_BATCH_DIRECTORY.matches(raw.name) -> raw.name.substringBefore('-').toLongOrNull()
      LEGACY_BATCH_DIRECTORY.matches(raw.name) -> raw.name.toLongOrNull()
      else -> null
    }
    if (!pending && (stamp == null || stamp >= cutoff)) return@forEach

    val entry = canonicalPlainPasteFile(raw)
      ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    if (entry.parentFile?.path != root.path || !entry.isDirectory) {
      throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
    val files = ownedPasteBatchFiles(entry, allowEmpty = true)
    if (pending || files.none { it.path in protectedPaths }) {
      deleteOwnedPasteBatchDirectory(entry, allowEmpty = true)
      deleted += 1
    }
  }

  // A recent empty legacy/current directory is also abandoned. Inspect only the remaining bounded
  // cleanup allowance; old protected batches were retained in phase one.
  val maxAdditionalInspections = maxDeletes - deleted
  var inspected = 0
  entries.forEach { raw ->
    if (deleted >= maxDeletes || inspected >= maxAdditionalInspections) return
    val stamp = when {
      COMMITTED_BATCH_DIRECTORY.matches(raw.name) -> raw.name.substringBefore('-').toLongOrNull()
      LEGACY_BATCH_DIRECTORY.matches(raw.name) -> raw.name.toLongOrNull()
      else -> null
    } ?: return@forEach
    if (stamp < cutoff) return@forEach

    val entry = canonicalPlainPasteFile(raw)
      ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    if (entry.parentFile?.path != root.path || !entry.isDirectory) {
      throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
    }
    val files = ownedPasteBatchFiles(entry, allowEmpty = true)
    inspected += 1
    if (files.isEmpty()) {
      deleteOwnedPasteBatchDirectory(entry, allowEmpty = true)
      deleted += 1
    }
  }
}

internal data class CommittedPasteBatch<T>(
  val directory: File,
  val items: List<T>,
)

/**
 * Build in a visibly pending directory and publish the directory with one same-filesystem rename.
 * Any exception or short result removes every byte, so callers can emit the whole batch or none.
 */
internal fun <T> createAtomicPasteBatch(
  root: File,
  batchId: String,
  expectedCount: Int,
  build: (pendingDirectory: File) -> List<T>,
): CommittedPasteBatch<T> {
  requireValidPasteCount(expectedCount)
  if (!COMMITTED_BATCH_DIRECTORY.matches(batchId)) {
    throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
  }
  if (!root.exists() && !root.mkdirs()) throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
  val pending = File(root, "$batchId.pending")
  val committed = File(root, batchId)
  if (pending.exists() || committed.exists()) {
    throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
  }
  if (!pending.mkdir()) throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)

  var published = false
  try {
    val items = build(pending)
    if (items.size != expectedCount) throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
    if (!pending.renameTo(committed)) throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
    published = true
    return CommittedPasteBatch(committed, items)
  } finally {
    if (!published) {
      if (pending.exists()) {
        runCatching { deleteOwnedPasteBatchDirectory(pending, allowEmpty = true) }
      }
      // `renameTo` may succeed and a later operation may still throw on an unusual filesystem.
      // `batchId` is request-unique, so this can never target another paste's committed directory.
      if (committed.exists()) {
        runCatching { deleteOwnedPasteBatchDirectory(committed, allowEmpty = true) }
      }
    }
  }
}
