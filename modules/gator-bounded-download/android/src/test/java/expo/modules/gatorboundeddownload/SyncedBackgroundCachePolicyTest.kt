package expo.modules.gatorboundeddownload

import java.io.File
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

  @Test
  fun `production quota and concurrent-final grace stay pinned`() {
    assertEquals(100L * 1024 * 1024, SYNCED_BACKGROUND_CACHE_MAX_BYTES)
    assertEquals(256, SYNCED_BACKGROUND_CACHE_MAX_FILES)
    assertEquals(0L, SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS)
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
  fun `deletes only exact canonical two-level media entries`() {
    val root = temporary.newFolder(SYNCED_BACKGROUND_CACHE_DIRECTORY).canonicalFile
    val owned = media(root, 1, "owned", 4, 100L)
    val generation = File(root, "generation-1")
    val partial = File(generation, "request.part").apply { writeBytes(byteArrayOf(1)) }
    val wrongExtension = File(generation, "media-photo.png").apply { writeBytes(byteArrayOf(1)) }
    val unknownRootFile = File(root, "not-wallpaper.bin").apply { writeBytes(byteArrayOf(1)) }
    val unknownGeneration = File(root, "generation-active").apply { mkdirs() }
    val unknownMedia = File(unknownGeneration, "media-unknown.jpg").apply {
      writeBytes(byteArrayOf(1))
    }
    val outside = temporary.newFile("outside-secret.db").apply { writeBytes(byteArrayOf(9)) }
    val symlink = File(generation, "media-link.jpg")
    Files.createSymbolicLink(symlink.toPath(), outside.toPath())

    val result = pruneSyncedBackgroundCache(
      root = root,
      nowMs = 10_000L,
      maxBytes = 1L,
      maxFiles = 1,
      recentGraceMs = 1_000L,
    )

    assertTrue(result.withinQuota)
    assertFalse(owned.exists())
    assertTrue(partial.exists())
    assertTrue(wrongExtension.exists())
    assertTrue(unknownRootFile.exists())
    assertTrue(unknownMedia.exists())
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
    val unrelated = File(root, "readme.txt").apply { writeBytes(byteArrayOf(9)) }

    val result = pruneSyncedBackgroundCache(
      root = root,
      nowMs = 10_000L,
      maxBytes = 4L,
      maxFiles = 1,
      recentGraceMs = 500L,
    )

    assertTrue(result.withinQuota)
    assertTrue(current.exists())
    assertFalse(legacy.exists())
    assertTrue(unrelated.exists())
    assertEquals(1L, result.remainingFiles)
    assertEquals(4L, result.remainingBytes)
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
}
