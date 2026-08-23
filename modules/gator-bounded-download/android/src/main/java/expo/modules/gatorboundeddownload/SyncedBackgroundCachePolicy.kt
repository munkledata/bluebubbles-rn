package expo.modules.gatorboundeddownload

import java.io.File
import java.util.PriorityQueue

internal const val SYNCED_BACKGROUND_CACHE_DIRECTORY = "synced-backgrounds"
internal const val SYNCED_BACKGROUND_CACHE_MAX_BYTES = 100L * 1024 * 1024
internal const val SYNCED_BACKGROUND_CACHE_MAX_FILES = 256
// Synced-background work is serialized in JavaScript. With no peer promotion in flight, native
// pruning can enforce the budget immediately instead of retaining a rolling minute of new files.
internal const val SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS = 0L

private const val MAX_MEDIA_FILE_NAME_CHARS = 190
private const val MAX_LEGACY_MEDIA_FILE_NAME_CHARS = 255
private val GENERATION_DIRECTORY = Regex("^generation-\\d+$")
private val MEDIA_FILE = Regex("^media-[^/]+\\.jpg$")
// The pre-quota implementation wrote `<sanitized-guid>-<sanitized-channel>.jpg` directly in root.
private val LEGACY_MEDIA_FILE = Regex("^[A-Za-z0-9._-]+\\.jpg$")

internal data class SyncedBackgroundPruneResult(
  val deletedFiles: Long,
  val deletedBytes: Long,
  val remainingFiles: Long,
  val remainingBytes: Long,
  val withinQuota: Boolean,
)

private data class CacheEntry(
  val file: File,
  val path: String,
  val bytes: Long,
  val modifiedAtMs: Long,
)

private val oldestFirst = Comparator<CacheEntry> { left, right ->
  val byTime = left.modifiedAtMs.compareTo(right.modifiedAtMs)
  if (byTime != 0) byTime else left.path.compareTo(right.path)
}

/**
 * Enforce one global cache budget without ever walking outside the owned root. Current files use
 * the exact generation/media two-level shape; canonical flat JPEGs are the one migration-only
 * exception because released builds wrote them directly in this same dedicated directory.
 *
 * Only a bounded set of survivor metadata is retained. This intentionally favors recent files
 * over perfect byte-bin packing: it may evict an extra small old image, but memory stays bounded
 * by [maxFiles] even when an old app version left a very large cache behind.
 *
 * The optional recent grace exists for policy tests/alternate callers, but production uses the
 * pinned zero default because its promotion → DB commit → prune path is serialized. Partials live
 * in the separate cache/bounded-download-parts namespace and never match this shape.
 */
internal fun pruneSyncedBackgroundCache(
  root: File,
  keepFile: File? = null,
  nowMs: Long = System.currentTimeMillis(),
  maxBytes: Long = SYNCED_BACKGROUND_CACHE_MAX_BYTES,
  maxFiles: Int = SYNCED_BACKGROUND_CACHE_MAX_FILES,
  recentGraceMs: Long = SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS,
): SyncedBackgroundPruneResult {
  require(maxBytes > 0L)
  require(maxFiles > 0)
  require(recentGraceMs >= 0L)

  val canonicalRoot = canonicalPlainRoot(root)
  if (!canonicalRoot.exists()) {
    return SyncedBackgroundPruneResult(0L, 0L, 0L, 0L, true)
  }
  require(canonicalRoot.isDirectory) { "Synced-background cache root is not a directory" }

  val keep = keepFile?.let { candidate ->
    requireOwnedEntry(canonicalRoot, candidate)
  }
  val keepPath = keep?.path
  val keepBytes = keep?.length()?.coerceAtLeast(0L) ?: 0L
  val recentCutoffMs = subtractSaturated(nowMs, recentGraceMs)

  var reservedFiles = if (keep == null) 0L else 1L
  var reservedBytes = keepBytes
  val selectedOld = PriorityQueue(oldestFirst)
  var selectedOldBytes = 0L

  forEachOwnedEntry(canonicalRoot) { entry ->
    if (entry.path == keepPath) return@forEachOwnedEntry
    if (recentGraceMs > 0L && entry.modifiedAtMs >= recentCutoffMs) {
      reservedFiles = addSaturated(reservedFiles, 1L)
      reservedBytes = addSaturated(reservedBytes, entry.bytes)
    } else {
      selectedOld.add(entry)
      selectedOldBytes = addSaturated(selectedOldBytes, entry.bytes)
    }
    selectedOldBytes = trimOldSurvivors(
      selectedOld,
      selectedOldBytes,
      maxFiles,
      maxBytes,
      reservedFiles,
      reservedBytes,
    )
  }

  val retainedOldPaths = HashSet<String>(selectedOld.size)
  selectedOld.forEach { entry -> retainedOldPaths.add(entry.path) }

  var deletedFiles = 0L
  var deletedBytes = 0L
  forEachOwnedEntry(canonicalRoot) { entry ->
    val protected = entry.path == keepPath ||
      (recentGraceMs > 0L && entry.modifiedAtMs >= recentCutoffMs) ||
      retainedOldPaths.contains(entry.path)
    if (!protected && entry.file.delete()) {
      deletedFiles = addSaturated(deletedFiles, 1L)
      deletedBytes = addSaturated(deletedBytes, entry.bytes)
    }
  }

  // Re-stat after deletion so failed deletes and alternate-caller concurrent promotions are
  // reflected honestly. Production serialization makes its ordinary result a hard cap.
  var remainingFiles = 0L
  var remainingBytes = 0L
  forEachOwnedEntry(canonicalRoot) { entry ->
    remainingFiles = addSaturated(remainingFiles, 1L)
    remainingBytes = addSaturated(remainingBytes, entry.bytes)
  }

  return SyncedBackgroundPruneResult(
    deletedFiles = deletedFiles,
    deletedBytes = deletedBytes,
    remainingFiles = remainingFiles,
    remainingBytes = remainingBytes,
    withinQuota = remainingFiles <= maxFiles.toLong() && remainingBytes <= maxBytes,
  )
}

/** Return the canonical entry only when every path component has the exact owned shape. */
internal fun requireOwnedSyncedBackgroundEntry(root: File, candidate: File): File {
  val canonicalRoot = canonicalPlainRoot(root)
  return requireOwnedEntry(canonicalRoot, candidate)
}

/**
 * Validate one current or legacy retirement path without requiring it to still exist.
 *
 * This is the ownership boundary for deleting a DB-referenced old wallpaper. It accepts only an
 * exact namespace path; the bridge separately requires a canonical file URI, checks that a
 * present target is a regular file, and performs a non-recursive file delete.
 */
internal fun requireOwnedSyncedBackgroundRetirementPath(root: File, candidate: File): File {
  val canonicalRoot = canonicalPlainRoot(root)
  val canonicalCandidate = canonicalPlain(candidate)
    ?: throw IllegalArgumentException("Synced-background retirement path is not canonical")
  val parent = canonicalCandidate.parentFile
    ?: throw IllegalArgumentException("Synced-background retirement path has no parent")

  val legacy =
    parent.path == canonicalRoot.path &&
      canonicalCandidate.name.length <= MAX_LEGACY_MEDIA_FILE_NAME_CHARS &&
      LEGACY_MEDIA_FILE.matches(canonicalCandidate.name)
  val current =
    parent.parentFile?.path == canonicalRoot.path &&
      GENERATION_DIRECTORY.matches(parent.name) &&
      canonicalCandidate.name.length <= MAX_MEDIA_FILE_NAME_CHARS &&
      MEDIA_FILE.matches(canonicalCandidate.name)
  require(current || legacy) { "Synced-background retirement path is outside the owned namespace" }
  return canonicalCandidate
}

private fun trimOldSurvivors(
  selected: PriorityQueue<CacheEntry>,
  selectedBytesValue: Long,
  maxFiles: Int,
  maxBytes: Long,
  reservedFiles: Long,
  reservedBytes: Long,
): Long {
  var selectedBytes = selectedBytesValue
  val availableFiles = (maxFiles.toLong() - reservedFiles).coerceAtLeast(0L)
  val availableBytes = (maxBytes - reservedBytes).coerceAtLeast(0L)
  while (selected.size.toLong() > availableFiles || selectedBytes > availableBytes) {
    val removed = selected.poll() ?: break
    selectedBytes = (selectedBytes - removed.bytes).coerceAtLeast(0L)
  }
  return selectedBytes
}

private inline fun forEachOwnedEntry(root: File, action: (CacheEntry) -> Unit) {
  val rootEntries = root.listFiles()
    ?: throw IllegalStateException("Synced-background cache root could not be listed")
  rootEntries.forEach { generation ->
    if (
      generation.name.length <= MAX_LEGACY_MEDIA_FILE_NAME_CHARS &&
      LEGACY_MEDIA_FILE.matches(generation.name)
    ) {
      val legacy = canonicalPlain(generation) ?: return@forEach
      if (legacy.isFile && legacy.parentFile?.path == root.path) {
        action(
          CacheEntry(
            file = legacy,
            path = legacy.path,
            bytes = legacy.length().coerceAtLeast(0L),
            modifiedAtMs = legacy.lastModified(),
          ),
        )
      }
      return@forEach
    }
    if (!GENERATION_DIRECTORY.matches(generation.name)) return@forEach
    val canonicalGeneration = canonicalPlain(generation) ?: return@forEach
    if (!canonicalGeneration.isDirectory || canonicalGeneration.parentFile?.path != root.path) {
      return@forEach
    }
    val children = canonicalGeneration.listFiles() ?: return@forEach
    children.forEach childLoop@{ child ->
      if (child.name.length > MAX_MEDIA_FILE_NAME_CHARS || !MEDIA_FILE.matches(child.name)) {
        return@childLoop
      }
      val canonicalChild = canonicalPlain(child) ?: return@childLoop
      if (!canonicalChild.isFile || canonicalChild.parentFile?.path != canonicalGeneration.path) {
        return@childLoop
      }
      action(
        CacheEntry(
          file = canonicalChild,
          path = canonicalChild.path,
          bytes = canonicalChild.length().coerceAtLeast(0L),
          modifiedAtMs = canonicalChild.lastModified(),
        ),
      )
    }
  }
}

private fun requireOwnedEntry(root: File, candidate: File): File {
  val generation = candidate.parentFile
    ?: throw IllegalArgumentException("Synced-background file has no generation directory")
  require(GENERATION_DIRECTORY.matches(generation.name)) {
    "Invalid synced-background generation directory"
  }
  require(candidate.name.length <= MAX_MEDIA_FILE_NAME_CHARS && MEDIA_FILE.matches(candidate.name)) {
    "Invalid synced-background media filename"
  }

  val canonicalGeneration = canonicalPlain(generation)
    ?: throw IllegalArgumentException("Synced-background generation is not canonical")
  require(canonicalGeneration.isDirectory && canonicalGeneration.parentFile?.path == root.path) {
    "Synced-background generation is outside the owned root"
  }
  val canonicalCandidate = canonicalPlain(candidate)
    ?: throw IllegalArgumentException("Synced-background file is not canonical")
  require(canonicalCandidate.isFile && canonicalCandidate.parentFile?.path == canonicalGeneration.path) {
    "Synced-background file is outside the owned generation"
  }
  return canonicalCandidate
}

private fun canonicalPlainRoot(root: File): File {
  val canonical = root.canonicalFile
  require(canonical.path == root.absoluteFile.path) {
    "Synced-background cache root is not canonical"
  }
  return canonical
}

/** Reject symlinks and path aliases rather than following them during cache deletion. */
private fun canonicalPlain(file: File): File? = runCatching {
  file.canonicalFile.takeIf { canonical -> canonical.path == file.absoluteFile.path }
}.getOrNull()

private fun addSaturated(left: Long, right: Long): Long =
  if (right > 0L && left > Long.MAX_VALUE - right) Long.MAX_VALUE else left + right

private fun subtractSaturated(left: Long, right: Long): Long =
  if (right > 0L && left < Long.MIN_VALUE + right) Long.MIN_VALUE else left - right
