package expo.modules.gatorboundeddownload

import java.io.File
import java.util.PriorityQueue

internal const val SYNCED_BACKGROUND_CACHE_DIRECTORY = "synced-backgrounds"
internal const val SYNCED_BACKGROUND_CACHE_MAX_BYTES = 100L * 1024 * 1024
internal const val SYNCED_BACKGROUND_CACHE_MAX_FILES = 256
internal const val SYNCED_BACKGROUND_DOWNLOAD_MAX_BYTES = 10L * 1024 * 1024
internal const val SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES =
  SYNCED_BACKGROUND_CACHE_MAX_BYTES - SYNCED_BACKGROUND_DOWNLOAD_MAX_BYTES
internal const val SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES =
  SYNCED_BACKGROUND_CACHE_MAX_FILES - 1
internal const val SYNCED_BACKGROUND_CACHE_SCAN_MAX_FILES = 8_192
internal const val SYNCED_BACKGROUND_CACHE_SCAN_MAX_NODES = 32_768

private const val MAX_MEDIA_FILE_NAME_CHARS = 190
private const val MAX_LEGACY_MEDIA_FILE_NAME_CHARS = 255
private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L
// The pre-quota implementation wrote `<sanitized-guid>-<sanitized-channel>.jpg` directly in root.
private val LEGACY_MEDIA_FILE = Regex("^[A-Za-z0-9._-]+\\.jpg$")

internal data class SyncedBackgroundPruneResult(
  val deletedFiles: Long,
  val deletedBytes: Long,
  val remainingFiles: Long,
  val remainingBytes: Long,
  val withinQuota: Boolean,
)

/** Count-only strict scan used by the release-safe Download Integrity report. */
internal data class SyncedBackgroundCacheInspection(
  val files: Long,
  val bytes: Long,
  val withinAdmissionLimit: Boolean,
  val withinFinalLimit: Boolean,
)

internal data class SyncedBackgroundCacheScanLimits(
  val maxFiles: Int = SYNCED_BACKGROUND_CACHE_SCAN_MAX_FILES,
  val maxNodes: Int = SYNCED_BACKGROUND_CACHE_SCAN_MAX_NODES,
) {
  init {
    require(maxFiles > 0)
    require(maxNodes >= maxFiles)
  }
}

private data class CacheEntry(
  val file: File,
  val path: String,
  val bytes: Long,
  val modifiedAtMs: Long,
)

private data class StrictScanSummary(
  val files: Long,
  val bytes: Long,
  val keepSeen: Boolean,
)

private val oldestFirst = Comparator<CacheEntry> { left, right ->
  val byTime = left.modifiedAtMs.compareTo(right.modifiedAtMs)
  if (byTime != 0) byTime else left.path.compareTo(right.path)
}

/**
 * Enforce one global cache budget without ever walking outside the owned root.
 *
 * Every pass streams directory entries through `DirectoryStream`, reads attributes without
 * following links, and rejects unknown names/types or incomplete metadata. The first pass must
 * finish before deletion starts. A final independent pass is the sole authority for the returned
 * remaining counts and quota decision, so a failed delete or raced file cannot produce a false
 * success.
 *
 * Only a bounded set of survivor metadata is retained. This intentionally favors recent files
 * over perfect byte-bin packing: it may evict an extra small old image, but memory stays bounded
 * by [maxFiles] even when an old app version left a very large cache behind.
 *
 * There is no recent-file exemption: synced-background work is serialized in JavaScript, so no
 * peer promotion is in flight and the budget applies immediately (review M163 removed the
 * always-zero grace setting).
 */
internal fun pruneSyncedBackgroundCache(
  root: File,
  fileSystem: AttachmentCacheFileSystem,
  keepFile: File? = null,
  maxBytes: Long = SYNCED_BACKGROUND_CACHE_MAX_BYTES,
  maxFiles: Int = SYNCED_BACKGROUND_CACHE_MAX_FILES,
  scanLimits: SyncedBackgroundCacheScanLimits = SyncedBackgroundCacheScanLimits(),
  deleteFile: (File) -> Boolean = File::delete,
): SyncedBackgroundPruneResult {
  require(maxBytes > 0L)
  require(maxFiles > 0)

  val keep = keepFile?.let { candidate ->
    requireOwnedSyncedBackgroundRetirementPath(root, candidate)
  }
  val keepPath = keep?.path
  val keepExpectedPresent = keep?.let { candidate ->
    val node = inspectStrict(fileSystem, candidate, "synced-background keep file")
    if (node == null) {
      false
    } else {
      requireRegularFileNode(node, "Synced-background keep file")
      true
    }
  } ?: false
  var reservedFiles = 0L
  var reservedBytes = 0L
  val selectedOld = PriorityQueue(oldestFirst)
  var selectedOldBytes = 0L

  val first = scanSyncedBackgroundCache(
    root = root,
    fileSystem = fileSystem,
    keepPath = keepPath,
    limits = scanLimits,
  ) { entry ->
    if (entry.path == keepPath) {
      reservedFiles = checkedAdd(reservedFiles, 1L, "reserved file count")
      reservedBytes = checkedAdd(reservedBytes, entry.bytes, "reserved byte count")
    } else {
      selectedOld.add(entry)
      selectedOldBytes = checkedAdd(selectedOldBytes, entry.bytes, "survivor byte count")
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
  requireKeepConsistency(first, keepPath, keepExpectedPresent, "initial")

  val retainedOldPaths = HashSet<String>(selectedOld.size)
  selectedOld.forEach { entry -> retainedOldPaths.add(entry.path) }

  var deletedFiles = 0L
  var deletedBytes = 0L
  val deletion = scanSyncedBackgroundCache(
    root = root,
    fileSystem = fileSystem,
    keepPath = keepPath,
    limits = scanLimits,
  ) { entry ->
    val protected = entry.path == keepPath || retainedOldPaths.contains(entry.path)
    if (!protected) {
      requireUnchangedRegularFile(fileSystem, entry)
      val deleted = try {
        deleteFile(entry.file)
      } catch (problem: Exception) {
        throw IllegalStateException("Synced-background cache file deletion failed", problem)
      }
      val afterDelete = inspectStrict(fileSystem, entry.file, "deleted synced-background file")
      if (deleted) {
        check(afterDelete == null) { "Synced-background cache file reappeared during deletion" }
        deletedFiles = checkedAdd(deletedFiles, 1L, "deleted file count")
        deletedBytes = checkedAdd(deletedBytes, entry.bytes, "deleted byte count")
      } else {
        check(afterDelete != null) { "Synced-background cache file disappeared during deletion" }
        requireRegularFileNode(afterDelete, "Undeleted synced-background cache file")
      }
    }
  }
  requireKeepConsistency(deletion, keepPath, keepExpectedPresent, "deletion")

  val final = scanSyncedBackgroundCache(
    root = root,
    fileSystem = fileSystem,
    keepPath = keepPath,
    limits = scanLimits,
  ) { _ -> }
  requireKeepConsistency(final, keepPath, keepExpectedPresent, "final")

  return SyncedBackgroundPruneResult(
    deletedFiles = deletedFiles,
    deletedBytes = deletedBytes,
    remainingFiles = final.files,
    remainingBytes = final.bytes,
    withinQuota = final.files <= maxFiles.toLong() && final.bytes <= maxBytes,
  )
}

/** Prove fixed room for one maximum-size wallpaper before any new bytes are admitted. */
internal fun prepareSyncedBackgroundCacheForDownload(
  root: File,
  fileSystem: AttachmentCacheFileSystem,
  keepFile: File? = null,
  scanLimits: SyncedBackgroundCacheScanLimits = SyncedBackgroundCacheScanLimits(),
  deleteFile: (File) -> Boolean = File::delete,
): SyncedBackgroundPruneResult = pruneSyncedBackgroundCache(
  root = root,
  fileSystem = fileSystem,
  keepFile = keepFile,
  maxBytes = SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES,
  maxFiles = SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES,
  scanLimits = scanLimits,
  deleteFile = deleteFile,
)

/**
 * Inspect the native-fixed wallpaper root without deleting, rewriting, or returning any path.
 *
 * This deliberately uses the same no-follow, bounded scanner as admission and pruning. Visible
 * corrupt, unreadable, symlinked, or over-limit state rejects the report instead of being
 * summarized as healthy. Admission/pruning, not this count-only observation, owns race rejection.
 */
internal fun inspectSyncedBackgroundCache(
  root: File,
  fileSystem: AttachmentCacheFileSystem,
  scanLimits: SyncedBackgroundCacheScanLimits = SyncedBackgroundCacheScanLimits(),
  shouldContinue: () -> Boolean = { true },
): SyncedBackgroundCacheInspection {
  val summary = scanSyncedBackgroundCache(
    root = root,
    fileSystem = fileSystem,
    keepPath = null,
    limits = scanLimits,
    shouldContinue = shouldContinue,
  ) { _ -> }
  return SyncedBackgroundCacheInspection(
    files = summary.files,
    bytes = summary.bytes,
    withinAdmissionLimit =
      summary.files <= SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES.toLong() &&
        summary.bytes <= SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES,
    withinFinalLimit =
      summary.files <= SYNCED_BACKGROUND_CACHE_MAX_FILES.toLong() &&
        summary.bytes <= SYNCED_BACKGROUND_CACHE_MAX_BYTES,
  )
}

/** Validate one exact current-layout entry; strict callers separately inspect its native type. */
internal fun requireOwnedSyncedBackgroundEntry(root: File, candidate: File): File {
  val canonicalRoot = canonicalPlainRoot(root)
  val canonicalCandidate = canonicalOwnedDescendant(
    root,
    canonicalRoot,
    candidate,
    "Synced-background file",
  )
  requireCurrentSyncedBackgroundPath(canonicalRoot, canonicalCandidate)
  return candidate.absoluteFile
}

/**
 * Validate one current or legacy retirement path without requiring it to still exist.
 *
 * This is the ownership boundary for deleting or protecting a DB-referenced old wallpaper. It
 * accepts only an exact namespace path; bridge code separately requires a canonical file URI.
 */
internal fun requireOwnedSyncedBackgroundRetirementPath(root: File, candidate: File): File {
  val canonicalRoot = canonicalPlainRoot(root)
  val canonicalCandidate = canonicalOwnedDescendant(
    root,
    canonicalRoot,
    candidate,
    "Synced-background retirement path",
  )
  val parent = canonicalCandidate.parentFile
    ?: throw IllegalArgumentException("Synced-background retirement path has no parent")

  val legacy =
    parent.path == canonicalRoot.path && isLegacySyncedBackgroundFileName(canonicalCandidate.name)
  val current = isCurrentSyncedBackgroundPath(canonicalRoot, canonicalCandidate)
  require(current || legacy) { "Synced-background retirement path is outside the owned namespace" }
  return canonicalCandidate
}

private fun scanSyncedBackgroundCache(
  root: File,
  fileSystem: AttachmentCacheFileSystem,
  keepPath: String?,
  limits: SyncedBackgroundCacheScanLimits,
  shouldContinue: () -> Boolean = { true },
  action: (CacheEntry) -> Unit,
): StrictScanSummary {
  check(shouldContinue()) { "Synced-background cache scan was cancelled" }
  val rootNode = inspectStrict(fileSystem, root, "synced-background cache root")
    ?: return StrictScanSummary(0L, 0L, false)
  requireDirectoryNode(rootNode, "Synced-background cache root")
  val canonicalRoot = canonicalPlainRoot(root)

  var totalNodes = 0
  var totalFiles = 0L
  var totalBytes = 0L
  var keepSeen = false

  fun recordNode() {
    check(shouldContinue()) { "Synced-background cache scan was cancelled" }
    check(totalNodes < limits.maxNodes) { "Synced-background cache contains too many entries" }
    totalNodes += 1
  }

  fun recordFile(entry: CacheEntry) {
    check(totalFiles < limits.maxFiles.toLong()) {
      "Synced-background cache contains too many files"
    }
    totalFiles = checkedAdd(totalFiles, 1L, "scanned file count")
    totalBytes = checkedAdd(totalBytes, entry.bytes, "scanned byte count")
    if (entry.path == keepPath) keepSeen = true
    action(entry)
  }

  forEachDirectoryChild(fileSystem, root, "synced-background cache root") { child ->
    recordNode()
    requireDirectChild(root, child, "Synced-background cache root entry")
    val node = inspectStrict(fileSystem, child, "synced-background cache root entry")
      ?: throw IllegalStateException("Synced-background cache root entry disappeared during scan")
    when (node.kind) {
      AttachmentCacheNodeKind.REGULAR_FILE -> {
        require(isLegacySyncedBackgroundFileName(child.name)) {
          "Invalid legacy synced-background filename"
        }
        val owned = canonicalOwnedDescendant(
          root,
          canonicalRoot,
          child,
          "Legacy synced-background file",
        )
        require(owned.parentFile?.path == canonicalRoot.path) {
          "Legacy synced-background file is outside the owned root"
        }
        requireRegularFileNode(node, "Legacy synced-background file")
        recordFile(CacheEntry(owned, owned.path, node.bytes, node.modifiedAtMs))
      }
      AttachmentCacheNodeKind.DIRECTORY -> {
        require(isCurrentSyncedBackgroundGeneration(child.name)) {
          "Invalid synced-background generation directory"
        }
        val canonicalGeneration = canonicalOwnedDescendant(
          root,
          canonicalRoot,
          child,
          "Synced-background generation directory",
        )
        require(canonicalGeneration.parentFile?.path == canonicalRoot.path) {
          "Synced-background generation is outside the owned root"
        }
        requireDirectoryNode(node, "Synced-background generation directory")
        forEachDirectoryChild(fileSystem, child, "synced-background generation directory") { file ->
          recordNode()
          requireDirectChild(child, file, "Synced-background generation entry")
          require(isCurrentSyncedBackgroundFileName(file.name)) {
            "Invalid synced-background media filename"
          }
          val fileNode = inspectStrict(fileSystem, file, "synced-background media file")
            ?: throw IllegalStateException("Synced-background media file disappeared during scan")
          requireRegularFileNode(fileNode, "Synced-background media file")
          val owned = canonicalOwnedDescendant(
            root,
            canonicalRoot,
            file,
            "Synced-background media file",
          )
          require(owned.parentFile?.path == canonicalGeneration.path) {
            "Synced-background media file is outside the owned generation"
          }
          recordFile(CacheEntry(owned, owned.path, fileNode.bytes, fileNode.modifiedAtMs))
        }
        requireStableDirectory(
          fileSystem,
          root,
          canonicalRoot,
          child,
          canonicalGeneration,
          "Synced-background generation directory",
        )
      }
      AttachmentCacheNodeKind.SYMLINK ->
        throw IllegalStateException("Synced-background cache root entry is a symlink")
      AttachmentCacheNodeKind.OTHER ->
        throw IllegalStateException("Synced-background cache root entry type is invalid")
    }
  }

  val finalRootNode = inspectStrict(fileSystem, root, "synced-background cache root")
    ?: throw IllegalStateException("Synced-background cache root disappeared during scan")
  requireDirectoryNode(finalRootNode, "Synced-background cache root")
  check(canonicalPlainRoot(root).path == canonicalRoot.path) {
    "Synced-background cache root changed during scan"
  }
  check(shouldContinue()) { "Synced-background cache scan was cancelled" }
  return StrictScanSummary(totalFiles, totalBytes, keepSeen)
}

private inline fun forEachDirectoryChild(
  fileSystem: AttachmentCacheFileSystem,
  directory: File,
  label: String,
  action: (File) -> Unit,
) {
  val cursor = try {
    fileSystem.openDirectory(directory)
  } catch (problem: Exception) {
    throw IllegalStateException("$label could not be opened", problem)
  }
  try {
    while (true) {
      val child = try {
        cursor.nextOrNull()
      } catch (problem: Exception) {
        throw IllegalStateException("$label could not be read", problem)
      } ?: break
      action(child)
    }
  } finally {
    cursor.close()
  }
}

private fun inspectStrict(
  fileSystem: AttachmentCacheFileSystem,
  file: File,
  label: String,
): AttachmentCacheNode? = try {
  fileSystem.inspect(file)
} catch (problem: Exception) {
  throw IllegalStateException("$label metadata could not be read", problem)
}

private fun requireRegularFileNode(node: AttachmentCacheNode, label: String) {
  require(node.kind == AttachmentCacheNodeKind.REGULAR_FILE) { "$label is not a plain file" }
  require(node.bytes in 0L..JS_MAX_SAFE_INTEGER) { "$label size is invalid" }
  require(node.modifiedAtMs in 0L..JS_MAX_SAFE_INTEGER) { "$label timestamp is invalid" }
}

private fun requireDirectoryNode(node: AttachmentCacheNode, label: String) {
  require(node.kind == AttachmentCacheNodeKind.DIRECTORY) { "$label is not a plain directory" }
  require(node.bytes in 0L..JS_MAX_SAFE_INTEGER) { "$label size is invalid" }
  require(node.modifiedAtMs in 0L..JS_MAX_SAFE_INTEGER) { "$label timestamp is invalid" }
}

private fun requireUnchangedRegularFile(
  fileSystem: AttachmentCacheFileSystem,
  entry: CacheEntry,
) {
  val node = inspectStrict(fileSystem, entry.file, "synced-background deletion candidate")
    ?: throw IllegalStateException("Synced-background deletion candidate disappeared")
  requireRegularFileNode(node, "Synced-background deletion candidate")
  check(node.bytes == entry.bytes && node.modifiedAtMs == entry.modifiedAtMs) {
    "Synced-background deletion candidate changed during scan"
  }
}

private fun requireStableDirectory(
  fileSystem: AttachmentCacheFileSystem,
  root: File,
  canonicalRoot: File,
  directory: File,
  canonicalDirectory: File,
  label: String,
) {
  val node = inspectStrict(fileSystem, directory, label)
    ?: throw IllegalStateException("$label disappeared during scan")
  requireDirectoryNode(node, label)
  val resolved = canonicalOwnedDescendant(root, canonicalRoot, directory, label)
  check(resolved.path == canonicalDirectory.path) { "$label changed during scan" }
}

private fun requireDirectChild(parent: File, child: File, label: String) {
  val absolute = child.absoluteFile
  require(absolute.path.length <= MAX_ATTACHMENT_CACHE_PATH_CHARS) { "$label path is too long" }
  require(absolute.parentFile?.path == parent.absoluteFile.path) {
    "$label is outside its fixed parent"
  }
}

private fun requireKeepConsistency(
  summary: StrictScanSummary,
  keepPath: String?,
  expectedPresent: Boolean,
  pass: String,
) {
  if (keepPath != null) {
    check(summary.keepSeen == expectedPresent) {
      "Synced-background keep file changed during $pass scan"
    }
  }
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

private fun isCurrentSyncedBackgroundPath(root: File, candidate: File): Boolean {
  val generation = candidate.parentFile ?: return false
  return generation.parentFile?.path == root.path &&
    isCurrentSyncedBackgroundGeneration(generation.name) &&
    isCurrentSyncedBackgroundFileName(candidate.name)
}

private fun requireCurrentSyncedBackgroundPath(root: File, candidate: File) {
  require(isCurrentSyncedBackgroundPath(root, candidate)) {
    "Invalid synced-background current-layout path"
  }
}

private fun isCurrentSyncedBackgroundGeneration(value: String): Boolean =
  value != "generation-unscoped" && isAttachmentCacheGenerationSegment(value)

private fun isCurrentSyncedBackgroundFileName(value: String): Boolean =
  value.length <= MAX_MEDIA_FILE_NAME_CHARS &&
    value.endsWith(".jpg") &&
    isEncodedMediaSegment(value.dropLast(4))

private fun isLegacySyncedBackgroundFileName(value: String): Boolean =
  value.length <= MAX_LEGACY_MEDIA_FILE_NAME_CHARS && LEGACY_MEDIA_FILE.matches(value)

private fun canonicalPlainRoot(root: File): File =
  canonicalOwnedRoot(root, "Synced-background cache root")

private fun checkedAdd(left: Long, right: Long, label: String): Long {
  require(left >= 0L && right >= 0L && left <= JS_MAX_SAFE_INTEGER - right) {
    "Synced-background $label overflowed"
  }
  return left + right
}
