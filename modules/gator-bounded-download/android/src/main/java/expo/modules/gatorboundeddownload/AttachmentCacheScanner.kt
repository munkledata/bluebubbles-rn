package expo.modules.gatorboundeddownload

import java.io.File
import java.nio.file.DirectoryStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

internal const val ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE = 100
internal const val ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES = 8_192
internal const val ATTACHMENT_CACHE_SCAN_MAX_NODES_PER_PAGE = 512
internal const val ATTACHMENT_CACHE_SCAN_MAX_TOTAL_NODES = 32_768
internal const val ATTACHMENT_CACHE_SCAN_MAX_PAGE_MS = 50L
internal const val ATTACHMENT_CACHE_SCAN_TTL_MS = 30_000L

private const val MAX_SCAN_ID_CHARS = 80
private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L

internal enum class AttachmentCacheScanFailure(val code: String) {
  BUSY("busy"),
  CORRUPT("corrupt"),
  EXPIRED("expired"),
  INVALID_SCAN("invalid_scan"),
  OVERFLOW("overflow"),
}

internal class AttachmentCacheScanException(
  val failure: AttachmentCacheScanFailure,
  detail: String,
  cause: Throwable? = null,
) : IllegalStateException("Attachment cache scan ${failure.code}: $detail", cause)

internal data class AttachmentCacheScanEntry(
  val file: File,
  val bytes: Long,
  val modifiedAtMs: Long,
)

internal data class AttachmentCacheScanPage(
  val files: List<AttachmentCacheScanEntry>,
  val done: Boolean,
)

internal data class AttachmentCacheScanLimits(
  val maxFilesPerPage: Int = ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE,
  val maxTotalFiles: Int = ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES,
  val maxNodesPerPage: Int = ATTACHMENT_CACHE_SCAN_MAX_NODES_PER_PAGE,
  val maxTotalNodes: Int = ATTACHMENT_CACHE_SCAN_MAX_TOTAL_NODES,
  val maxPageMs: Long = ATTACHMENT_CACHE_SCAN_MAX_PAGE_MS,
  val sessionTtlMs: Long = ATTACHMENT_CACHE_SCAN_TTL_MS,
) {
  init {
    require(maxFilesPerPage > 0)
    require(maxTotalFiles >= maxFilesPerPage)
    require(maxNodesPerPage >= maxFilesPerPage)
    require(maxTotalNodes >= maxNodesPerPage)
    require(maxPageMs > 0L)
    require(sessionTtlMs > 0L)
  }
}

internal enum class AttachmentCacheNodeKind {
  DIRECTORY,
  REGULAR_FILE,
  SYMLINK,
  OTHER,
}

internal data class AttachmentCacheNode(
  val kind: AttachmentCacheNodeKind,
  val bytes: Long,
  val modifiedAtMs: Long,
)

/** A one-entry-at-a-time cursor. Implementations must never materialize a whole directory. */
internal interface AttachmentCacheDirectoryCursor : AutoCloseable {
  fun nextOrNull(): File?
}

internal interface AttachmentCacheFileSystem {
  fun inspect(file: File): AttachmentCacheNode?
  fun openDirectory(directory: File): AttachmentCacheDirectoryCursor
}

/**
 * Streaming filesystem access used on Android 8+.
 *
 * `DirectoryStream` is deliberate: `File.list()`/`listFiles()` allocate an array for every entry
 * before JavaScript can receive a page, so an unexpectedly large cache could still exhaust the
 * process. Attributes are always read with `NOFOLLOW_LINKS` and the scanner rejects statically
 * visible symlinks at every level before opening a child directory.
 */
internal class NioAttachmentCacheFileSystem : AttachmentCacheFileSystem {
  override fun inspect(file: File): AttachmentCacheNode? = try {
    val attributes = Files.readAttributes(
      file.toPath(),
      BasicFileAttributes::class.java,
      LinkOption.NOFOLLOW_LINKS,
    )
    val kind = when {
      attributes.isSymbolicLink -> AttachmentCacheNodeKind.SYMLINK
      attributes.isDirectory -> AttachmentCacheNodeKind.DIRECTORY
      attributes.isRegularFile -> AttachmentCacheNodeKind.REGULAR_FILE
      else -> AttachmentCacheNodeKind.OTHER
    }
    AttachmentCacheNode(
      kind = kind,
      bytes = attributes.size(),
      modifiedAtMs = attributes.lastModifiedTime().toMillis(),
    )
  } catch (_: NoSuchFileException) {
    null
  }

  override fun openDirectory(directory: File): AttachmentCacheDirectoryCursor {
    val stream = Files.newDirectoryStream(directory.toPath())
    return try {
      NioDirectoryCursor(stream)
    } catch (problem: Exception) {
      runCatching { stream.close() }
      throw problem
    }
  }
}

private class NioDirectoryCursor(
  private val stream: DirectoryStream<Path>,
) : AttachmentCacheDirectoryCursor {
  private val iterator = stream.iterator()

  override fun nextOrNull(): File? =
    if (iterator.hasNext()) iterator.next().toFile() else null

  override fun close() {
    stream.close()
  }
}

/** Owns the single opaque, short-lived scan session exposed by the native module. */
internal class AttachmentCacheScanManager(
  private val root: File,
  private val fileSystem: AttachmentCacheFileSystem,
  private val nowMs: () -> Long,
  private val idFactory: () -> String = { UUID.randomUUID().toString() },
  private val limits: AttachmentCacheScanLimits = AttachmentCacheScanLimits(),
) {
  private var active: AttachmentCacheScanSession? = null

  @Synchronized
  fun begin(): String {
    val now = nowMs()
    active?.let { existing ->
      if (existing.isExpired(now)) {
        existing.close()
        active = null
      } else {
        throw AttachmentCacheScanException(
          AttachmentCacheScanFailure.BUSY,
          "another scan is still active",
        )
      }
    }

    val scanId = idFactory()
    if (scanId.isBlank() || scanId.length > MAX_SCAN_ID_CHARS) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.CORRUPT,
        "native scan id generation failed",
      )
    }
    val session = AttachmentCacheScanSession(
      id = scanId,
      root = root,
      fileSystem = fileSystem,
      nowMs = nowMs,
      startedAtMs = now,
      limits = limits,
    )
    try {
      session.start()
      active = session
      return scanId
    } catch (problem: Exception) {
      session.close()
      throw problem
    }
  }

  @Synchronized
  fun next(scanId: String): AttachmentCacheScanPage {
    val session = requireActive(scanId)
    if (session.isExpired(nowMs())) {
      retire(session)
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.EXPIRED,
        "the scan session expired",
      )
    }
    return try {
      session.nextPage().also { page ->
        if (page.done) retire(session)
      }
    } catch (problem: Exception) {
      retire(session)
      throw problem
    }
  }

  /** Unknown/already-closed ids are an idempotent no-op for best-effort `finally` cleanup. */
  @Synchronized
  fun close(scanId: String): Boolean {
    val session = active ?: return false
    if (session.id != scanId) return false
    retire(session)
    return true
  }

  @Synchronized
  fun closeActive() {
    active?.let { session -> retire(session) }
  }

  private fun requireActive(scanId: String): AttachmentCacheScanSession {
    if (scanId.isBlank() || scanId.length > MAX_SCAN_ID_CHARS) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.INVALID_SCAN,
        "the scan id is invalid",
      )
    }
    val session = active
      ?: throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.INVALID_SCAN,
        "there is no active scan",
      )
    if (session.id != scanId) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.INVALID_SCAN,
        "the scan id does not own the active session",
      )
    }
    return session
  }

  private fun retire(session: AttachmentCacheScanSession) {
    session.close()
    if (active === session) active = null
  }
}

private class AttachmentCacheScanSession(
  val id: String,
  private val root: File,
  private val fileSystem: AttachmentCacheFileSystem,
  private val nowMs: () -> Long,
  startedAtMs: Long,
  private val limits: AttachmentCacheScanLimits,
) : AutoCloseable {
  private val expiresAtMs = addSaturated(startedAtMs, limits.sessionTtlMs)
  private var rootCursor: AttachmentCacheDirectoryCursor? = null
  private var attachmentDirectoryCursor: AttachmentCacheDirectoryCursor? = null
  private var generationCursor: AttachmentCacheDirectoryCursor? = null
  private var attachmentDirectory: File? = null
  private var generationDirectory: File? = null
  private var totalNodes = 0
  private var totalFiles = 0
  private var finished = false
  private var closed = false

  fun isExpired(now: Long): Boolean = now >= expiresAtMs

  fun start() = scanGuard {
    verifyRoot().let { rootNode ->
      if (rootNode == null) {
        finished = true
      } else {
        rootCursor = openDirectory(root)
      }
    }
  }

  fun nextPage(): AttachmentCacheScanPage = scanGuard {
    check(!closed) { "Attachment cache scan is already closed" }
    if (isExpired(nowMs())) {
      fail(AttachmentCacheScanFailure.EXPIRED, "the scan session expired")
    }
    if (finished) return@scanGuard AttachmentCacheScanPage(emptyList(), true)

    verifyRoot()
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "the cache root disappeared during the scan")
    verifyOpenDirectories()

    val pageStartedAtMs = nowMs()
    var pageNodes = 0
    val files = ArrayList<AttachmentCacheScanEntry>(limits.maxFilesPerPage)

    while (!finished && files.size < limits.maxFilesPerPage) {
      val currentTime = nowMs()
      if (isExpired(currentTime)) {
        fail(AttachmentCacheScanFailure.EXPIRED, "the scan session expired")
      }
      if (
        pageNodes >= limits.maxNodesPerPage ||
        (pageNodes > 0 && elapsedAtLeast(pageStartedAtMs, currentTime, limits.maxPageMs))
      ) {
        break
      }

      val currentGenerationCursor = generationCursor
      if (currentGenerationCursor != null) {
        val child = nextChild(currentGenerationCursor)
        if (child == null) {
          closeGenerationCursor()
          continue
        }
        pageNodes += 1
        recordNode()
        scanFile(child)?.let(files::add)
        continue
      }

      val currentAttachmentDirectoryCursor = attachmentDirectoryCursor
      if (currentAttachmentDirectoryCursor != null) {
        val child = nextChild(currentAttachmentDirectoryCursor)
        if (child == null) {
          closeAttachmentDirectoryCursor()
          continue
        }
        pageNodes += 1
        recordNode()
        scanAttachmentDirectoryChild(child)?.let(files::add)
        continue
      }

      val currentRootCursor = rootCursor
      if (currentRootCursor != null) {
        val child = nextChild(currentRootCursor)
        if (child == null) {
          closeRootCursor()
          finished = true
          continue
        }
        pageNodes += 1
        recordNode()
        openAttachmentDirectory(child)
        continue
      }

      finished = true
    }

    AttachmentCacheScanPage(files, finished)
  }

  override fun close() {
    if (closed) return
    closed = true
    runCatching { closeGenerationCursor() }
    runCatching { closeAttachmentDirectoryCursor() }
    runCatching { closeRootCursor() }
    attachmentDirectory = null
    generationDirectory = null
  }

  private fun verifyRoot(): AttachmentCacheNode? {
    val absoluteRoot = root.absoluteFile
    if (absoluteRoot.path.length > MAX_ATTACHMENT_CACHE_PATH_CHARS) {
      fail(AttachmentCacheScanFailure.CORRUPT, "the cache root path is too long")
    }
    // A missing native-fixed root is an empty cache. Resolve canonical identity only after lstat
    // confirms an entry exists; on macOS/JVM tests a missing child under `/var` canonicalizes via
    // `/private/var`, even though there is no node (and therefore no symlink) to reject.
    val node = inspect(root) ?: return null
    val canonicalRoot = try {
      root.canonicalFile
    } catch (problem: Exception) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.CORRUPT,
        "the cache root cannot be resolved",
        problem,
      )
    }
    if (canonicalRoot.path != absoluteRoot.path) {
      fail(AttachmentCacheScanFailure.CORRUPT, "the cache root is a symlink or alias")
    }
    if (node.kind != AttachmentCacheNodeKind.DIRECTORY) {
      fail(AttachmentCacheScanFailure.CORRUPT, "the cache root is not a plain directory")
    }
    return node
  }

  private fun verifyOpenDirectories() {
    attachmentDirectory?.let { directory ->
      verifyDirectory(
        parent = root,
        directory = directory,
        validName = isLegacyAttachmentCacheSegment(directory.name),
        label = "attachment directory",
      )
    }
    generationDirectory?.let { directory ->
      val parent = attachmentDirectory
        ?: fail(AttachmentCacheScanFailure.CORRUPT, "generation parent state is missing")
      if (!isEncodedMediaSegment(parent.name)) {
        fail(AttachmentCacheScanFailure.CORRUPT, "legacy attachment directory is nested")
      }
      verifyDirectory(
        parent = parent,
        directory = directory,
        validName = isAttachmentCacheGenerationSegment(directory.name),
        label = "generation directory",
      )
    }
  }

  private fun openAttachmentDirectory(directory: File) {
    verifyDirectory(
      parent = root,
      directory = directory,
      validName = isLegacyAttachmentCacheSegment(directory.name),
      label = "attachment directory",
    )
    attachmentDirectory = directory.absoluteFile
    attachmentDirectoryCursor = openDirectory(directory)
  }

  private fun openGeneration(directory: File) {
    val parent = attachmentDirectory
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "generation parent state is missing")
    if (!isEncodedMediaSegment(parent.name)) {
      fail(AttachmentCacheScanFailure.CORRUPT, "legacy attachment directory is nested")
    }
    verifyDirectory(
      parent = parent,
      directory = directory,
      validName = isAttachmentCacheGenerationSegment(directory.name),
      label = "generation directory",
    )
    generationDirectory = directory.absoluteFile
    generationCursor = openDirectory(directory)
  }

  private fun scanAttachmentDirectoryChild(candidate: File): AttachmentCacheScanEntry? {
    val parent = attachmentDirectory
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "attachment directory state is missing")
    requireDirectChild(parent, candidate, "attachment directory child")
    return when (inspect(candidate)?.kind ?: return null) {
      AttachmentCacheNodeKind.REGULAR_FILE -> scanLegacyFile(candidate)
      AttachmentCacheNodeKind.DIRECTORY -> {
        openGeneration(candidate)
        null
      }
      AttachmentCacheNodeKind.SYMLINK ->
        fail(AttachmentCacheScanFailure.CORRUPT, "attachment directory child is a symlink")
      AttachmentCacheNodeKind.OTHER ->
        fail(AttachmentCacheScanFailure.CORRUPT, "attachment directory child type is invalid")
    }
  }

  private fun verifyDirectory(
    parent: File,
    directory: File,
    validName: Boolean,
    label: String,
  ) {
    if (!validName) fail(AttachmentCacheScanFailure.CORRUPT, "$label name is invalid")
    requireDirectChild(parent, directory, label)
    val canonical = try {
      directory.canonicalFile
    } catch (problem: Exception) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.CORRUPT,
        "$label cannot be resolved",
        problem,
      )
    }
    if (canonical.path != directory.absoluteFile.path) {
      fail(AttachmentCacheScanFailure.CORRUPT, "$label is a symlink or alias")
    }
    val node = inspect(directory)
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "$label disappeared during the scan")
    if (node.kind != AttachmentCacheNodeKind.DIRECTORY) {
      fail(AttachmentCacheScanFailure.CORRUPT, "$label is not a plain directory")
    }
  }

  private fun scanFile(candidate: File): AttachmentCacheScanEntry? {
    val parent = generationDirectory
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "file generation state is missing")
    return scanRegularFile(
      parent = parent,
      candidate = candidate,
      validName = isEncodedMediaSegment(candidate.name),
      label = "attachment cache file",
    )
  }

  private fun scanLegacyFile(candidate: File): AttachmentCacheScanEntry? {
    val parent = attachmentDirectory
      ?: fail(AttachmentCacheScanFailure.CORRUPT, "legacy file parent state is missing")
    return scanRegularFile(
      parent = parent,
      candidate = candidate,
      validName = isLegacyAttachmentCacheSegment(candidate.name),
      label = "legacy attachment cache file",
    )
  }

  private fun scanRegularFile(
    parent: File,
    candidate: File,
    validName: Boolean,
    label: String,
  ): AttachmentCacheScanEntry? {
    if (!validName) fail(AttachmentCacheScanFailure.CORRUPT, "$label name is invalid")
    requireDirectChild(parent, candidate, label)
    val owned = try {
      requireOwnedAttachmentCachePath(root, candidate)
    } catch (problem: Exception) {
      throw AttachmentCacheScanException(
        AttachmentCacheScanFailure.CORRUPT,
        "$label is outside the fixed layout",
        problem,
      )
    }
    val node = inspect(owned) ?: return null
    if (node.kind != AttachmentCacheNodeKind.REGULAR_FILE) {
      fail(AttachmentCacheScanFailure.CORRUPT, "attachment cache entry is not a plain file")
    }
    if (node.bytes !in 0L..JS_MAX_SAFE_INTEGER) {
      fail(AttachmentCacheScanFailure.CORRUPT, "attachment cache file size is invalid")
    }
    if (node.modifiedAtMs !in 0L..JS_MAX_SAFE_INTEGER) {
      fail(AttachmentCacheScanFailure.CORRUPT, "attachment cache file timestamp is invalid")
    }
    if (totalFiles >= limits.maxTotalFiles) {
      fail(AttachmentCacheScanFailure.OVERFLOW, "the cache contains too many files")
    }
    totalFiles += 1
    return AttachmentCacheScanEntry(owned, node.bytes, node.modifiedAtMs)
  }

  private fun requireDirectChild(parent: File, child: File, label: String) {
    val absolute = child.absoluteFile
    if (absolute.path.length > MAX_ATTACHMENT_CACHE_PATH_CHARS) {
      fail(AttachmentCacheScanFailure.CORRUPT, "$label path is too long")
    }
    if (absolute.parentFile?.path != parent.absoluteFile.path) {
      fail(AttachmentCacheScanFailure.CORRUPT, "$label is outside its fixed parent")
    }
  }

  private fun inspect(file: File): AttachmentCacheNode? = try {
    fileSystem.inspect(file)
  } catch (problem: Exception) {
    throw AttachmentCacheScanException(
      AttachmentCacheScanFailure.CORRUPT,
      "filesystem metadata could not be read",
      problem,
    )
  }

  private fun openDirectory(directory: File): AttachmentCacheDirectoryCursor = try {
    fileSystem.openDirectory(directory)
  } catch (problem: Exception) {
    throw AttachmentCacheScanException(
      AttachmentCacheScanFailure.CORRUPT,
      "cache directory could not be opened",
      problem,
    )
  }

  private fun nextChild(cursor: AttachmentCacheDirectoryCursor): File? = try {
    cursor.nextOrNull()
  } catch (problem: Exception) {
    throw AttachmentCacheScanException(
      AttachmentCacheScanFailure.CORRUPT,
      "cache directory could not be read",
      problem,
    )
  }

  private fun recordNode() {
    if (totalNodes >= limits.maxTotalNodes) {
      fail(AttachmentCacheScanFailure.OVERFLOW, "the cache contains too many entries")
    }
    totalNodes += 1
  }

  private fun closeGenerationCursor() {
    val cursor = generationCursor
    generationCursor = null
    generationDirectory = null
    cursor?.close()
  }

  private fun closeAttachmentDirectoryCursor() {
    closeGenerationCursor()
    val cursor = attachmentDirectoryCursor
    attachmentDirectoryCursor = null
    attachmentDirectory = null
    cursor?.close()
  }

  private fun closeRootCursor() {
    closeAttachmentDirectoryCursor()
    val cursor = rootCursor
    rootCursor = null
    cursor?.close()
  }

  private inline fun <T> scanGuard(block: () -> T): T = try {
    block()
  } catch (problem: AttachmentCacheScanException) {
    close()
    throw problem
  } catch (problem: Exception) {
    close()
    throw AttachmentCacheScanException(
      AttachmentCacheScanFailure.CORRUPT,
      "unexpected filesystem state",
      problem,
    )
  }
}

private fun fail(failure: AttachmentCacheScanFailure, detail: String): Nothing =
  throw AttachmentCacheScanException(failure, detail)

private fun elapsedAtLeast(startedAtMs: Long, nowMs: Long, limitMs: Long): Boolean =
  nowMs >= addSaturated(startedAtMs, limitMs)

private fun addSaturated(left: Long, right: Long): Long =
  if (right > 0L && left > Long.MAX_VALUE - right) Long.MAX_VALUE else left + right
