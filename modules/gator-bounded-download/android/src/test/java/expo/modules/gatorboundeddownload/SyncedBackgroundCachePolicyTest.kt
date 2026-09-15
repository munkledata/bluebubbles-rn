package expo.modules.gatorboundeddownload

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SyncedBackgroundCachePolicyTest {
  @get:Rule
  val temporary = TemporaryFolder()
  private val nioFileSystem = NioAttachmentCacheFileSystem()

  @Test
  fun `production quota and concurrent-final grace stay pinned`() {
    assertEquals(100L * 1024 * 1024, SYNCED_BACKGROUND_CACHE_MAX_BYTES)
    assertEquals(256, SYNCED_BACKGROUND_CACHE_MAX_FILES)
    assertEquals(10L * 1024 * 1024, SYNCED_BACKGROUND_DOWNLOAD_MAX_BYTES)
    assertEquals(90L * 1024 * 1024, SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES)
    assertEquals(255, SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES)
    assertEquals(8_192, SYNCED_BACKGROUND_CACHE_SCAN_MAX_FILES)
    assertEquals(32_768, SYNCED_BACKGROUND_CACHE_SCAN_MAX_NODES)
    assertEquals(0L, SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS)
  }

  @Test
  fun `pre-admission protects a legacy current file and reserves one maximum download`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val currentLegacy = sparseFile(File(root, "current-legacy.jpg"), 10L * 1024 * 1024, 9_000L)
    val newest = sparseMedia(root, 2, "newest", 80L * 1024 * 1024, 8_000L)
    val oldest = sparseMedia(root, 1, "oldest", 1L * 1024 * 1024, 1_000L)

    val result = prepareSyncedBackgroundCacheForDownload(
      root = root,
      fileSystem = nioFileSystem,
      keepFile = currentLegacy,
      nowMs = 10_000L,
    )

    assertTrue(result.withinQuota)
    assertEquals(SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES, result.remainingBytes)
    assertTrue(currentLegacy.exists())
    assertTrue(newest.exists())
    assertFalse(oldest.exists())
    assertTrue(
      result.remainingBytes + SYNCED_BACKGROUND_DOWNLOAD_MAX_BYTES <=
        SYNCED_BACKGROUND_CACHE_MAX_BYTES,
    )
    assertTrue(result.remainingFiles + 1L <= SYNCED_BACKGROUND_CACHE_MAX_FILES.toLong())
  }

  @Test
  fun `prunes globally across generations while always retaining the committed file`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val committed = media(root, 1, "committed", 6, 100L)
    val newest = media(root, 2, "newest", 4, 8_000L)
    val middle = media(root, 2, "middle", 4, 7_000L)
    val oldest = media(root, 3, "oldest", 4, 6_000L)

    val result = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      keepFile = committed,
      nowMs = 10_000L,
      maxBytes = 10L,
      maxFiles = 2,
      recentGraceMs = 1_000L,
    )

    assertTrue(result.withinQuota)
    assertEquals(2L, result.deletedFiles)
    assertEquals(8L, result.deletedBytes)
    assertEquals(2L, result.remainingFiles)
    assertEquals(10L, result.remainingBytes)
    assertTrue(committed.exists())
    assertTrue(newest.exists())
    assertFalse(middle.exists())
    assertFalse(oldest.exists())
  }

  @Test
  fun `recent concurrent final is deferred then removed by the next prune`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val committed = media(root, 1, "committed", 5, 100L)
    val concurrentFinal = media(root, 2, "concurrent", 7, 9_999L)

    val first = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      keepFile = committed,
      nowMs = 10_000L,
      maxBytes = 10L,
      maxFiles = 2,
      recentGraceMs = 1_000L,
    )

    assertFalse(first.withinQuota)
    assertTrue(committed.exists())
    assertTrue(concurrentFinal.exists())

    val later = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      keepFile = committed,
      nowMs = 20_000L,
      maxBytes = 10L,
      maxFiles = 2,
      recentGraceMs = 1_000L,
    )

    assertTrue(later.withinQuota)
    assertTrue(committed.exists())
    assertFalse(concurrentFinal.exists())
  }

  @Test
  fun `startup prune needs no DB uri and repairs stale process-restart bytes`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val newest = media(root, 8, "newest", 4, 5_000L)
    val stale = media(root, 7, "stale", 4, 4_000L)

    val result = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      keepFile = null,
      nowMs = 10_000L,
      maxBytes = 4L,
      maxFiles = 1,
      recentGraceMs = 1_000L,
    )

    assertTrue(result.withinQuota)
    assertTrue(newest.exists())
    assertFalse(stale.exists())
  }

  @Test
  fun `prunes through a trusted ancestor alias while retaining the exact keep file`() {
    val realBase = temporary.newFolder("real-background-base").canonicalFile
    val aliasBase = File(temporary.root.canonicalFile, "android-background-base-alias")
    Files.createSymbolicLink(aliasBase.toPath(), realBase.toPath())
    val realRoot = File(realBase, SYNCED_BACKGROUND_CACHE_DIRECTORY).apply { mkdirs() }
    val aliasRoot = File(aliasBase, SYNCED_BACKGROUND_CACHE_DIRECTORY)
    val keep = media(realRoot, 1, "keep", 4, 9_000L)
    val stale = media(realRoot, 2, "stale", 4, 1_000L)
    val aliasKeep = File(aliasRoot, "generation-1/media-keep.jpg")
    val validatedKeep = requireOwnedSyncedBackgroundEntry(aliasRoot, aliasKeep)

    val result = pruneSyncedBackgroundCache(
      root = aliasRoot,
      fileSystem = nioFileSystem,
      keepFile = validatedKeep,
      nowMs = 10_000L,
      maxBytes = 4L,
      maxFiles = 1,
      recentGraceMs = 0L,
    )

    assertTrue(result.withinQuota)
    assertEquals(aliasKeep.absoluteFile, validatedKeep)
    assertTrue(keep.exists())
    assertFalse(stale.exists())
    assertEquals(
      keep.canonicalFile,
      requireOwnedSyncedBackgroundRetirementPath(aliasRoot, aliasKeep),
    )
    assertTrue(
      runCatching {
        requireOwnedSyncedBackgroundRetirementPath(aliasRoot, keep)
      }.isFailure,
    )
  }

  @Test
  fun `a symlink at the fixed root is rejected before pruning`() {
    val realRoot = temporary.newFolder("real-background-root").canonicalFile
    val owned = media(realRoot, 1, "owned", 4, 100L)
    val linkedRoot = File(temporary.root.canonicalFile, "linked-background-root")
    Files.createSymbolicLink(linkedRoot.toPath(), realRoot.toPath())

    assertTrue(
      runCatching {
        pruneSyncedBackgroundCache(
          root = linkedRoot,
          fileSystem = nioFileSystem,
          nowMs = 10_000L,
          maxBytes = 1L,
          maxFiles = 1,
          recentGraceMs = 0L,
        )
      }.isFailure,
    )
    assertTrue(owned.exists())
  }

  @Test
  fun `unknown entry fails before any deletion`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val owned = media(root, 1, "owned", 4, 100L)
    val unknownRootFile = File(root, "not-wallpaper.bin").apply { writeBytes(byteArrayOf(1)) }

    val result = runCatching {
      pruneSyncedBackgroundCache(
        root = root,
        fileSystem = nioFileSystem,
        nowMs = 10_000L,
        maxBytes = 1L,
        maxFiles = 1,
        recentGraceMs = 0L,
      )
    }

    assertTrue(result.isFailure)
    assertTrue(owned.exists())
    assertTrue(unknownRootFile.exists())
  }

  @Test
  fun `a symlinked media entry fails closed without touching its target or owned files`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val owned = media(root, 1, "owned", 4, 100L)
    val outside = temporary.newFile("outside-secret.db").apply { writeBytes(byteArrayOf(9)) }
    val symlink = File(owned.parentFile, "media-link.jpg")
    Files.createSymbolicLink(symlink.toPath(), outside.toPath())

    val result = runCatching {
      pruneSyncedBackgroundCache(
        root = root,
        fileSystem = nioFileSystem,
        nowMs = 10_000L,
        maxBytes = 1L,
        maxFiles = 1,
        recentGraceMs = 0L,
      )
    }

    assertTrue(result.isFailure)
    assertTrue(owned.exists())
    assertTrue(outside.exists())
    assertTrue(symlink.exists())
  }

  @Test
  fun `accounts for and prunes canonical flat JPEGs written by the legacy implementation`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val current = media(root, 1, "current", 4, 9_000L)
    val legacy = File(root, "chat-guid-channel-guid.jpg").apply {
      writeBytes(ByteArray(4) { 1 })
      assertTrue(setLastModified(1_000L))
    }
    val result = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      nowMs = 10_000L,
      maxBytes = 4L,
      maxFiles = 1,
      recentGraceMs = 500L,
    )

    assertTrue(result.withinQuota)
    assertTrue(current.exists())
    assertFalse(legacy.exists())
    assertEquals(1L, result.remainingFiles)
    assertEquals(4L, result.remainingBytes)
  }

  @Test
  fun `an unreadable generation fails before any deletion`() {
    val root = temporary.newFolder("unreadable-generation").canonicalFile
    val first = media(root, 1, "first", 4, 100L)
    val second = media(root, 2, "second", 4, 200L)
    val unreadable = object : ForwardingAttachmentCacheFileSystem(nioFileSystem) {
      override fun openDirectory(directory: File): AttachmentCacheDirectoryCursor {
        if (directory.absoluteFile.path != root.absoluteFile.path) {
          throw IllegalStateException("synthetic unreadable directory")
        }
        return super.openDirectory(directory)
      }
    }

    val result = runCatching {
      pruneSyncedBackgroundCache(
        root = root,
        fileSystem = unreadable,
        maxBytes = 1L,
        maxFiles = 1,
      )
    }

    assertTrue(result.isFailure)
    assertTrue(first.exists())
    assertTrue(second.exists())
  }

  @Test
  fun `an enumerated file disappearance is corruption rather than an ignored miss`() {
    val root = temporary.newFolder("disappearing-entry").canonicalFile
    val owned = media(root, 1, "owned", 4, 100L)
    val disappearing = object : ForwardingAttachmentCacheFileSystem(nioFileSystem) {
      private var disappearOnNextInspect = false

      override fun inspect(file: File): AttachmentCacheNode? {
        if (disappearOnNextInspect && file.absoluteFile.path == owned.absoluteFile.path) {
          disappearOnNextInspect = false
          return null
        }
        return super.inspect(file)
      }

      override fun openDirectory(directory: File): AttachmentCacheDirectoryCursor {
        val cursor = super.openDirectory(directory)
        return object : AttachmentCacheDirectoryCursor {
          override fun nextOrNull(): File? = cursor.nextOrNull().also { child ->
            if (child?.absoluteFile?.path == owned.absoluteFile.path) {
              disappearOnNextInspect = true
            }
          }

          override fun close() = cursor.close()
        }
      }
    }

    val result = runCatching {
      pruneSyncedBackgroundCache(
        root = root,
        fileSystem = disappearing,
        maxBytes = 1L,
        maxFiles = 1,
      )
    }

    assertTrue(result.isFailure)
    assertTrue(owned.exists())
  }

  @Test
  fun `file and node scan ceilings fail before mutation`() {
    val fileCapRoot = temporary.newFolder("file-cap").canonicalFile
    val fileCapFirst = media(fileCapRoot, 1, "first", 4, 100L)
    val fileCapSecond = media(fileCapRoot, 1, "second", 4, 200L)
    val fileCapResult = runCatching {
      pruneSyncedBackgroundCache(
        root = fileCapRoot,
        fileSystem = nioFileSystem,
        maxBytes = 1L,
        maxFiles = 1,
        scanLimits = SyncedBackgroundCacheScanLimits(maxFiles = 1, maxNodes = 4),
      )
    }
    assertTrue(fileCapResult.isFailure)
    assertTrue(fileCapFirst.exists())
    assertTrue(fileCapSecond.exists())

    val nodeCapRoot = temporary.newFolder("node-cap").canonicalFile
    val nodeCapFirst = media(nodeCapRoot, 1, "first", 4, 100L)
    val nodeCapSecond = media(nodeCapRoot, 1, "second", 4, 200L)
    val nodeCapResult = runCatching {
      pruneSyncedBackgroundCache(
        root = nodeCapRoot,
        fileSystem = nioFileSystem,
        maxBytes = 1L,
        maxFiles = 1,
        scanLimits = SyncedBackgroundCacheScanLimits(maxFiles = 2, maxNodes = 2),
      )
    }
    assertTrue(nodeCapResult.isFailure)
    assertTrue(nodeCapFirst.exists())
    assertTrue(nodeCapSecond.exists())
  }

  @Test
  fun `a failed delete is reflected by the final strict scan`() {
    val root = temporary.newFolder("failed-delete").canonicalFile
    val oldest = media(root, 1, "oldest", 4, 100L)
    val newest = media(root, 1, "newest", 4, 200L)

    val result = pruneSyncedBackgroundCache(
      root = root,
      fileSystem = nioFileSystem,
      maxBytes = 4L,
      maxFiles = 1,
      deleteFile = { false },
    )

    assertFalse(result.withinQuota)
    assertEquals(0L, result.deletedFiles)
    assertEquals(2L, result.remainingFiles)
    assertEquals(8L, result.remainingBytes)
    assertTrue(oldest.exists())
    assertTrue(newest.exists())
  }

  @Test
  fun `noncanonical current names fail closed`() {
    val generationRoot = temporary.newFolder("noncanonical-generation").canonicalFile
    val leadingZeroDirectory = File(generationRoot, "generation-01").apply { mkdirs() }
    val leadingZeroFile = File(leadingZeroDirectory, "media-valid.jpg").apply {
      writeBytes(byteArrayOf(1))
    }
    assertTrue(
      runCatching {
        pruneSyncedBackgroundCache(generationRoot, nioFileSystem)
      }.isFailure,
    )
    assertTrue(leadingZeroFile.exists())

    val mediaRoot = temporary.newFolder("noncanonical-media").canonicalFile
    val mediaDirectory = File(mediaRoot, "generation-1").apply { mkdirs() }
    val encodedAlias = File(mediaDirectory, "media-%41.jpg").apply { writeBytes(byteArrayOf(1)) }
    assertTrue(
      runCatching {
        pruneSyncedBackgroundCache(mediaRoot, nioFileSystem)
      }.isFailure,
    )
    assertTrue(encodedAlias.exists())
  }

  @Test
  fun `an invalid keep path fails before any owned file is deleted`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val owned = media(root, 1, "owned", 4, 100L)
    val outside = temporary.newFile("outside.jpg").apply { writeBytes(byteArrayOf(9)) }

    var rejected = false
    try {
      pruneSyncedBackgroundCache(
        root = root,
        fileSystem = nioFileSystem,
        keepFile = outside,
        nowMs = 10_000L,
        maxBytes = 1L,
        maxFiles = 1,
        recentGraceMs = 1_000L,
      )
    } catch (_: IllegalArgumentException) {
      rejected = true
    }

    assertTrue(rejected)
    assertTrue(owned.exists())
    assertTrue(outside.exists())
  }

  @Test
  fun `retirement path accepts exact current and legacy files but rejects traversal and symlinks`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val current = media(root, 1, "current", 4, 100L)
    val legacy = File(root, "chat-guid-channel-guid.jpg").apply { writeBytes(byteArrayOf(1)) }
    val outside = temporary.newFile("outside.jpg").apply { writeBytes(byteArrayOf(9)) }
    val symlink = File(root, "linked.jpg")
    Files.createSymbolicLink(symlink.toPath(), outside.toPath())

    assertEquals(current.canonicalFile, requireOwnedSyncedBackgroundRetirementPath(root, current))
    assertEquals(legacy.canonicalFile, requireOwnedSyncedBackgroundRetirementPath(root, legacy))

    var outsideRejected = false
    try {
      requireOwnedSyncedBackgroundRetirementPath(root, outside)
    } catch (_: IllegalArgumentException) {
      outsideRejected = true
    }
    var symlinkRejected = false
    try {
      requireOwnedSyncedBackgroundRetirementPath(root, symlink)
    } catch (_: IllegalArgumentException) {
      symlinkRejected = true
    }
    assertTrue(outsideRejected)
    assertTrue(symlinkRejected)
    assertTrue(outside.exists())
  }

  private fun media(
    root: File,
    generation: Int,
    id: String,
    bytes: Int,
    modifiedAtMs: Long,
  ): File {
    val directory = File(root, "generation-$generation").apply { mkdirs() }
    return File(directory, "media-$id.jpg").apply {
      writeBytes(ByteArray(bytes) { 1 })
      assertTrue(setLastModified(modifiedAtMs))
    }
  }

  private fun sparseMedia(
    root: File,
    generation: Int,
    id: String,
    bytes: Long,
    modifiedAtMs: Long,
  ): File {
    val directory = File(root, "generation-$generation").apply { mkdirs() }
    return sparseFile(File(directory, "media-$id.jpg"), bytes, modifiedAtMs)
  }

  private fun sparseFile(file: File, bytes: Long, modifiedAtMs: Long): File = file.apply {
    RandomAccessFile(this, "rw").use { handle -> handle.setLength(bytes) }
    assertTrue(setLastModified(modifiedAtMs))
  }
}

private open class ForwardingAttachmentCacheFileSystem(
  private val delegate: AttachmentCacheFileSystem,
) : AttachmentCacheFileSystem {
  override fun inspect(file: File): AttachmentCacheNode? = delegate.inspect(file)

  override fun openDirectory(directory: File): AttachmentCacheDirectoryCursor =
    delegate.openDirectory(directory)
}
