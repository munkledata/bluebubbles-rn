package expo.modules.gatorboundeddownload

import java.io.File

internal const val BOUNDED_DOWNLOAD_PARTIAL_DIRECTORY = "bounded-download-parts"

private const val MAX_PARTIAL_FILES = 16
private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val PARTIAL_FILE_NAME = Regex("request-[0-9]{1,16}-[0-9]{1,10}\\.part")

internal data class BoundedDownloadPartialsInspection(
  val files: Long,
  val bytes: Long,
)

private data class PartialEntry(
  val file: File,
  val bytes: Long,
  val modifiedAtMs: Long,
)

/**
 * Strictly inspect the fixed, flat temporary-download namespace without returning any filename.
 *
 * Active requests are capped at eight, so sixteen files leaves room to observe a handoff while
 * still rejecting an unexpected or hostile tree before it can consume unbounded memory. A file
 * that changes while it is counted rejects the snapshot; the UI can retry once the transfer is
 * stable.
 */
internal fun inspectBoundedDownloadPartials(
  root: File,
  fileSystem: AttachmentCacheFileSystem,
  maxFiles: Int = MAX_PARTIAL_FILES,
): BoundedDownloadPartialsInspection {
  require(maxFiles > 0)
  val initialRoot = inspectPartialNode(fileSystem, root, "partial-download root")
    ?: return BoundedDownloadPartialsInspection(files = 0L, bytes = 0L)
  requirePartialDirectory(initialRoot, "Partial-download root")
  val canonicalRoot = root.canonicalFile
  val entries = mutableListOf<PartialEntry>()
  var totalBytes = 0L

  val cursor = try {
    fileSystem.openDirectory(root)
  } catch (problem: Exception) {
    throw IllegalStateException("Partial-download root could not be opened", problem)
  }
  try {
    while (true) {
      val child = try {
        cursor.nextOrNull()
      } catch (problem: Exception) {
        throw IllegalStateException("Partial-download root could not be read", problem)
      } ?: break
      require(entries.size < maxFiles) { "Partial-download file limit exceeded" }
      require(PARTIAL_FILE_NAME.matches(child.name)) { "Partial-download filename is invalid" }
      val canonicalChild = child.canonicalFile
      require(canonicalChild.parentFile?.path == canonicalRoot.path) {
        "Partial-download file is outside the fixed root"
      }
      val node = inspectPartialNode(fileSystem, child, "partial-download file")
        ?: throw IllegalStateException("Partial-download file disappeared during scan")
      requirePartialFile(node, "Partial-download file")
      check(node.bytes <= JS_MAX_SAFE_INTEGER - totalBytes) {
        "Partial-download byte count overflowed"
      }
      totalBytes += node.bytes
      entries += PartialEntry(child, node.bytes, node.modifiedAtMs)
    }
  } finally {
    cursor.close()
  }

  for (entry in entries) {
    val current = inspectPartialNode(fileSystem, entry.file, "partial-download file")
      ?: throw IllegalStateException("Partial-download file disappeared during scan")
    requirePartialFile(current, "Partial-download file")
    check(current.bytes == entry.bytes && current.modifiedAtMs == entry.modifiedAtMs) {
      "Partial-download file changed during scan"
    }
  }
  val finalRoot = inspectPartialNode(fileSystem, root, "partial-download root")
    ?: throw IllegalStateException("Partial-download root disappeared during scan")
  requirePartialDirectory(finalRoot, "Partial-download root")
  check(root.canonicalFile.path == canonicalRoot.path) { "Partial-download root changed" }
  check(finalRoot.modifiedAtMs == initialRoot.modifiedAtMs) {
    "Partial-download root changed during scan"
  }

  return BoundedDownloadPartialsInspection(entries.size.toLong(), totalBytes)
}

private fun inspectPartialNode(
  fileSystem: AttachmentCacheFileSystem,
  file: File,
  label: String,
): AttachmentCacheNode? = try {
  fileSystem.inspect(file)
} catch (problem: Exception) {
  throw IllegalStateException("$label metadata could not be read", problem)
}

private fun requirePartialFile(node: AttachmentCacheNode, label: String) {
  require(node.kind == AttachmentCacheNodeKind.REGULAR_FILE) { "$label is not a plain file" }
  require(node.bytes in 0L..JS_MAX_SAFE_INTEGER) { "$label size is invalid" }
  require(node.modifiedAtMs in 0L..JS_MAX_SAFE_INTEGER) { "$label timestamp is invalid" }
}

private fun requirePartialDirectory(node: AttachmentCacheNode, label: String) {
  require(node.kind == AttachmentCacheNodeKind.DIRECTORY) { "$label is not a plain directory" }
  require(node.bytes in 0L..JS_MAX_SAFE_INTEGER) { "$label size is invalid" }
  require(node.modifiedAtMs in 0L..JS_MAX_SAFE_INTEGER) { "$label timestamp is invalid" }
}
