package expo.modules.gatorboundeddownload

import java.io.File
import java.nio.file.Files
import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AttachmentCacheScannerTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun `production scan limits stay hard-coded and bounded`() {
    assertEquals(100, ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE)
    assertEquals(8_192, ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES)
    assertEquals(512, ATTACHMENT_CACHE_SCAN_MAX_NODES_PER_PAGE)
    assertEquals(32_768, ATTACHMENT_CACHE_SCAN_MAX_TOTAL_NODES)
    assertEquals(50L, ATTACHMENT_CACHE_SCAN_MAX_PAGE_MS)
    assertEquals(30_000L, ATTACHMENT_CACHE_SCAN_TTL_MS)
  }

  @Test
  fun `production repair limits keep the per-page bounds and lift only the totals`() {
    val repair = AttachmentCacheScanLimits.REPAIR
    assertEquals(ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE, repair.maxFilesPerPage)
    assertEquals(ATTACHMENT_CACHE_SCAN_MAX_NODES_PER_PAGE, repair.maxNodesPerPage)
    assertEquals(ATTACHMENT_CACHE_SCAN_MAX_PAGE_MS, repair.maxPageMs)
    assertEquals(Int.MAX_VALUE, repair.maxTotalFiles)
    assertEquals(Int.MAX_VALUE, repair.maxTotalNodes)
    assertEquals(60_000L, ATTACHMENT_CACHE_REPAIR_SCAN_IDLE_TTL_MS)
    assertEquals(ATTACHMENT_CACHE_REPAIR_SCAN_IDLE_TTL_MS, repair.sessionTtlMs)
  }

  // Review item 888: an old cache over the startup totals made every startup scan overflow, so
  // downloads never turned back on. Storage → Repair Downloads reads it with a repair scan.
  @Test
  fun `a repair scan pages past the totals that make the startup scan overflow`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val expected = (1..5).map { index ->
      cacheFile(File(root, "legacy-guid-$index").apply { mkdirs() }, "photo $index.jpg", index)
    }
    val tight = AttachmentCacheScanLimits(
      maxFilesPerPage = 2,
      maxTotalFiles = 2,
      maxNodesPerPage = 4,
      maxTotalNodes = 6,
      maxPageMs = 1_000L,
      sessionTtlMs = 10_000L,
    )
    val startup = manager(root = root, ids = ArrayDeque(listOf("startup")), limits = tight)
    assertFailure(AttachmentCacheScanFailure.OVERFLOW) { collectAll(startup) }

    val repair = manager(
      root = root,
      ids = ArrayDeque(listOf("repair")),
      limits = tight,
      repairLimits = repairLimits(maxFilesPerPage = 2, maxNodesPerPage = 4),
    )
    val entries = collectAll(repair, AttachmentCacheScanMode.REPAIR)

    assertEquals(expected.map { it.path }.toSet(), entries.map { it.file.path }.toSet())
    assertEquals(setOf(1L, 2L, 3L, 4L, 5L), entries.map { it.bytes }.toSet())
  }

  @Test
  fun `a repair scan expires only after sitting idle between pages`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    repeat(3) { index ->
      cacheFile(File(root, "legacy-$index").apply { mkdirs() }, "photo.jpg", 1)
    }
    var nowMs = 0L
    val onePerPage = AttachmentCacheScanLimits(
      maxFilesPerPage = 1,
      maxNodesPerPage = 4,
      maxPageMs = 1_000L,
      sessionTtlMs = 100L,
    )

    // A startup scan has one fixed budget for the whole manifest.
    val startup = manager(
      root = root,
      ids = ArrayDeque(listOf("startup")),
      nowMs = { nowMs },
      limits = onePerPage,
    )
    val startupId = startup.begin()
    nowMs = 60L
    assertEquals(1, startup.next(startupId).files.size)
    nowMs = 120L
    assertFailure(AttachmentCacheScanFailure.EXPIRED) { startup.next(startupId) }

    // A repair cleans up between pages, so only the idle gap since the last page counts.
    nowMs = 0L
    val repair = manager(
      root = root,
      ids = ArrayDeque(listOf("repair")),
      nowMs = { nowMs },
      repairLimits = repairLimits(maxFilesPerPage = 1, maxNodesPerPage = 4, sessionTtlMs = 100L),
    )
    val repairId = repair.begin(AttachmentCacheScanMode.REPAIR)
    nowMs = 60L
    assertEquals(1, repair.next(repairId).files.size)
    nowMs = 150L
    assertEquals(1, repair.next(repairId).files.size)
    nowMs = 260L
    assertFailure(AttachmentCacheScanFailure.EXPIRED) { repair.next(repairId) }
  }

  @Test
  fun `a repair scan keeps going when cleanup removes the folder it was reading`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val legacy = cacheFile(File(root, "legacy-guid").apply { mkdirs() }, "photo.jpg", 1)
    val media = File(root, "media-chat")
    val first = cacheFile(File(media, "generation-1").apply { mkdirs() }, "media-a.jpg", 2)
    val second = cacheFile(File(media, "generation-2").apply { mkdirs() }, "media-b.jpg", 3)
    val repair = manager(
      root = root,
      repairLimits = repairLimits(maxFilesPerPage = 1, maxNodesPerPage = 4),
    )

    val removed = drainWhileDeleting(repair, AttachmentCacheScanMode.REPAIR, root)

    assertEquals(setOf(legacy.path, first.path, second.path), removed.map { it.path }.toSet())
    assertEquals(0, root.list()?.size)
  }

  @Test
  fun `a startup scan still fails closed when a folder it is reading disappears`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    cacheFile(File(root, "legacy-one").apply { mkdirs() }, "photo.jpg", 1)
    cacheFile(File(root, "legacy-two").apply { mkdirs() }, "photo.jpg", 1)
    val startup = manager(
      root = root,
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 1,
        maxNodesPerPage = 4,
        maxPageMs = 1_000L,
        sessionTtlMs = 10_000L,
      ),
    )

    assertFailure(AttachmentCacheScanFailure.CORRUPT) {
      drainWhileDeleting(startup, AttachmentCacheScanMode.STARTUP, root)
    }
  }

  @Test
  fun `a repair scan still rejects symlinks without following them`() {
    val legacyRoot = temporary.newFolder("legacy-$ATTACHMENT_CACHE_DIRECTORY").canonicalFile
    val legacyDirectory = File(legacyRoot, "legacy-guid").apply { mkdirs() }
    val outsideFile = temporary.newFile("repair-outside.db")
    outsideFile.writeBytes(ByteArray(4) { 1 })
    Files.createSymbolicLink(File(legacyDirectory, "linked.db").toPath(), outsideFile.toPath())
    val legacyRepair = manager(legacyRoot)
    val legacyId = legacyRepair.begin(AttachmentCacheScanMode.REPAIR)
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { legacyRepair.next(legacyId) }

    val mediaRoot = temporary.newFolder("media-$ATTACHMENT_CACHE_DIRECTORY").canonicalFile
    val outsideFolder = temporary.newFolder("repair-outside").canonicalFile
    val secret = File(outsideFolder, "secret.db").apply { writeBytes(byteArrayOf(9, 8, 7)) }
    Files.createSymbolicLink(File(mediaRoot, "media-linked").toPath(), outsideFolder.toPath())
    val mediaRepair = manager(mediaRoot)
    val mediaId = mediaRepair.begin(AttachmentCacheScanMode.REPAIR)
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { mediaRepair.next(mediaId) }

    assertEquals(4L, outsideFile.length())
    assertEquals(3L, secret.length())
  }

  @Test
  fun `startup and repair scans share the one active session`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val manager = manager(root = root, ids = ArrayDeque(listOf("startup", "repair")))

    val startupId = manager.begin()
    assertFailure(AttachmentCacheScanFailure.BUSY) { manager.begin(AttachmentCacheScanMode.REPAIR) }
    assertTrue(manager.close(startupId))
    val repairId = manager.begin(AttachmentCacheScanMode.REPAIR)
    assertEquals("repair", repairId)
    assertFailure(AttachmentCacheScanFailure.BUSY) { manager.begin() }
    assertTrue(manager.close(repairId))
  }

  @Test
  fun `streams legacy files and a mixed legacy-current directory in one manifest`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val legacyDirectory = File(root, "old chat +1555 % raw").apply { mkdirs() }
    val legacy = cacheFile(legacyDirectory, "Photo 100% €.jpg", 1)
    val mixedDirectory = File(root, "media-collision").apply { mkdirs() }
    val collidingLegacy = cacheFile(mixedDirectory, "generation-01", 2)
    val generation = File(mixedDirectory, "generation-0").apply { mkdirs() }
    val current = cacheFile(generation, "media-current%20photo.pdf", 3)
    val hashedDirectory = File(root, "id-sha256-" + "a".repeat(64)).apply { mkdirs() }
    val hashedLegacy = cacheFile(hashedDirectory, "generation-7", 4)
    val hashedGeneration = File(hashedDirectory, "generation-8").apply { mkdirs() }
    val hashedCurrent = cacheFile(hashedGeneration, "media-photo.png", 5)
    val manager = manager(root)

    val entries = collectAll(manager)

    assertEquals(
      setOf(legacy.path, collidingLegacy.path, current.path, hashedLegacy.path, hashedCurrent.path),
      entries.map { entry -> entry.file.path }.toSet(),
    )
    assertEquals(setOf(1L, 2L, 3L, 4L, 5L), entries.map { entry -> entry.bytes }.toSet())
  }

  @Test
  fun `rejects malformed hash directories hashed filenames and symlinks`() {
    val identity = "id-sha256-" + "a".repeat(64)
    val paths = listOf(
      "${identity.uppercase()}/generation-7/media-photo.png",
      "${identity.dropLast(1)}/generation-7/media-photo.png",
      "$identity/generation-07/media-photo.png",
      "$identity/generation-7/$identity",
      "$identity/extra/generation-7/media-photo.png",
    )
    for ((index, path) in paths.withIndex()) {
      val root = temporary.newFolder("malformed-$index").canonicalFile
      File(root, path).apply { parentFile?.mkdirs(); writeBytes(byteArrayOf(1)) }
      assertFailure(AttachmentCacheScanFailure.CORRUPT) { collectAll(manager(root)) }
    }
    val root = temporary.newFolder("symlinked").canonicalFile
    val generation = File(root, "$identity/generation-7").apply { mkdirs() }
    val outside = temporary.newFile("outside-hash-scan")
    Files.createSymbolicLink(File(generation, "media-linked.png").toPath(), outside.toPath())
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { collectAll(manager(root)) }
    assertTrue(outside.exists())
  }

  @Test
  fun `streams valid files over opaque bounded pages and retires a completed session`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val generation = File(root, "media-chat%2Fone/generation-7").apply { mkdirs() }
    val expected = listOf(
      cacheFile(generation, "media-one.jpg", 1),
      cacheFile(generation, "media-two.pdf", 2),
      cacheFile(generation, "media-%E2%82%AC.mov", 3),
    )
    val manager = manager(
      root = root,
      ids = ArrayDeque(listOf("opaque-first", "opaque-second")),
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 2,
        maxNodesPerPage = 8,
        maxTotalNodes = 20,
        maxPageMs = 1_000L,
        sessionTtlMs = 10_000L,
      ),
    )

    val scanId = manager.begin()
    assertEquals("opaque-first", scanId)
    assertFailure(AttachmentCacheScanFailure.BUSY) { manager.begin() }

    val first = manager.next(scanId)
    assertFalse(first.done)
    assertEquals(2, first.files.size)
    val second = manager.next(scanId)
    assertTrue(second.done)
    assertEquals(1, second.files.size)

    val entries = first.files + second.files
    assertEquals(expected.map { it.path }.toSet(), entries.map { it.file.path }.toSet())
    assertEquals(setOf(1L, 2L, 3L), entries.map { it.bytes }.toSet())
    assertTrue(entries.all { it.modifiedAtMs >= 0L })
    assertFalse(manager.close(scanId))
    assertEquals("opaque-second", manager.begin())
  }

  @Test
  fun `streams through a trusted ancestor alias without changing manifest path identity`() {
    val realBase = temporary.newFolder("real-scan-base").canonicalFile
    val aliasBase = File(temporary.root.canonicalFile, "android-scan-base-alias")
    Files.createSymbolicLink(aliasBase.toPath(), realBase.toPath())
    val realRoot = File(realBase, ATTACHMENT_CACHE_DIRECTORY).apply { mkdirs() }
    val realGeneration = File(realRoot, "media-guid/generation-3").apply { mkdirs() }
    cacheFile(realGeneration, "media-photo.jpg", 3)
    val aliasRoot = File(aliasBase, ATTACHMENT_CACHE_DIRECTORY)

    val entries = collectAll(manager(aliasRoot))

    assertEquals(1, entries.size)
    assertEquals(
      File(aliasRoot, "media-guid/generation-3/media-photo.jpg").absolutePath,
      entries.single().file.absolutePath,
    )
    assertEquals(3L, entries.single().bytes)
  }

  @Test
  fun `a page stops after its native node budget even before finding a file`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val generation = File(root, "media-chat/generation-unscoped").apply { mkdirs() }
    cacheFile(generation, "media-photo.jpg", 1)
    val manager = manager(
      root = root,
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 1,
        maxNodesPerPage = 1,
        maxTotalNodes = 10,
        maxPageMs = 1_000L,
        sessionTtlMs = 10_000L,
      ),
    )
    val id = manager.begin()

    val mediaDirectoryPage = manager.next(id)
    assertTrue(mediaDirectoryPage.files.isEmpty())
    assertFalse(mediaDirectoryPage.done)
    val generationDirectoryPage = manager.next(id)
    assertTrue(generationDirectoryPage.files.isEmpty())
    assertFalse(generationDirectoryPage.done)
    val filePage = manager.next(id)
    assertEquals(1, filePage.files.size)
    assertFalse(filePage.done)
    val completionPage = manager.next(id)
    assertTrue(completionPage.files.isEmpty())
    assertTrue(completionPage.done)
  }

  @Test
  fun `overflow returns no late partial page and closes the session`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val generation = File(root, "media-chat/generation-1").apply { mkdirs() }
    cacheFile(generation, "media-photo.jpg", 1)
    val ids = ArrayDeque(listOf("overflowing", "replacement"))
    val manager = manager(
      root = root,
      ids = ids,
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 1,
        maxNodesPerPage = 2,
        maxTotalNodes = 2,
        maxPageMs = 1_000L,
        sessionTtlMs = 10_000L,
      ),
    )
    val id = manager.begin()

    val directoriesOnly = manager.next(id)
    assertTrue(directoriesOnly.files.isEmpty())
    assertFalse(directoriesOnly.done)
    assertFailure(AttachmentCacheScanFailure.OVERFLOW) { manager.next(id) }
    assertFalse(manager.close(id))
    assertEquals("replacement", manager.begin())
  }

  @Test
  fun `the total file ceiling fails before returning an over-limit file`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val generation = File(root, "media-chat/generation-1").apply { mkdirs() }
    cacheFile(generation, "media-first.jpg", 1)
    cacheFile(generation, "media-second.jpg", 1)
    val manager = manager(
      root = root,
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 1,
        maxTotalFiles = 1,
        maxNodesPerPage = 4,
        maxTotalNodes = 10,
        maxPageMs = 1_000L,
        sessionTtlMs = 10_000L,
      ),
    )
    val id = manager.begin()

    val first = manager.next(id)
    assertEquals(1, first.files.size)
    assertFalse(first.done)
    assertFailure(AttachmentCacheScanFailure.OVERFLOW) { manager.next(id) }
    assertFalse(manager.close(id))
  }

  @Test
  fun `wrong ids cannot close another scan while expiry does release it`() {
    val root = File(temporary.root, ATTACHMENT_CACHE_DIRECTORY)
    val ids = ArrayDeque(listOf("first-secret", "second-secret"))
    var nowMs = 100L
    val manager = manager(
      root = root,
      ids = ids,
      nowMs = { nowMs },
      limits = AttachmentCacheScanLimits(
        maxFilesPerPage = 1,
        maxNodesPerPage = 1,
        maxTotalNodes = 1,
        maxPageMs = 5L,
        sessionTtlMs = 10L,
      ),
    )
    val first = manager.begin()

    assertFailure(AttachmentCacheScanFailure.INVALID_SCAN) { manager.next("guessed-id") }
    assertFalse(manager.close("guessed-id"))
    assertFailure(AttachmentCacheScanFailure.BUSY) { manager.begin() }

    nowMs = 110L
    assertFailure(AttachmentCacheScanFailure.EXPIRED) { manager.next(first) }
    assertFalse(manager.close(first))
    val second = manager.begin()
    assertEquals("second-secret", second)
    assertTrue(manager.close(second))
    assertFalse(manager.close(second))
  }

  @Test
  fun `a missing fixed root is an empty completed scan`() {
    val root = File(temporary.root, ATTACHMENT_CACHE_DIRECTORY)
    val manager = manager(root)

    val id = manager.begin()
    val page = manager.next(id)

    assertTrue(page.done)
    assertTrue(page.files.isEmpty())
    assertFalse(manager.close(id))
  }

  @Test
  fun `unexpected names and node types fail closed and release the session`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    File(root, "readme.txt").writeText("not cache data")
    val ids = ArrayDeque(listOf("corrupt", "after-corrupt"))
    val manager = manager(root = root, ids = ids)
    val first = manager.begin()

    assertFailure(AttachmentCacheScanFailure.CORRUPT) { manager.next(first) }
    assertFalse(manager.close(first))
    assertEquals("after-corrupt", manager.begin())
  }

  @Test
  fun `nested legacy directories and leading-zero current generations fail closed`() {
    val legacyRoot = temporary.newFolder("legacy-$ATTACHMENT_CACHE_DIRECTORY").canonicalFile
    File(legacyRoot, "legacy-guid/nested/file.pdf").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1))
    }
    val legacyManager = manager(legacyRoot)
    val legacyId = legacyManager.begin()
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { legacyManager.next(legacyId) }

    val currentRoot = temporary.newFolder("current-$ATTACHMENT_CACHE_DIRECTORY").canonicalFile
    val invalidGeneration = File(currentRoot, "media-guid/generation-01").apply { mkdirs() }
    cacheFile(invalidGeneration, "media-file.pdf", 1)
    val currentManager = manager(currentRoot)
    val currentId = currentManager.begin()
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { currentManager.next(currentId) }
  }

  @Test
  fun `media-directory symlinks are rejected without traversing their target`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val outside = temporary.newFolder("outside").canonicalFile
    val secret = File(outside, "secret.db").apply { writeBytes(byteArrayOf(9, 8, 7)) }
    Files.createSymbolicLink(File(root, "media-linked").toPath(), outside.toPath())
    val manager = manager(root)
    val id = manager.begin()

    assertFailure(AttachmentCacheScanFailure.CORRUPT) { manager.next(id) }
    assertTrue(secret.exists())
    assertEquals(3L, secret.length())
  }

  @Test
  fun `final-file symlinks are rejected without returning outside metadata`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val generation = File(root, "media-chat/generation-1").apply { mkdirs() }
    val outside = temporary.newFile("outside.db").apply { writeBytes(ByteArray(7) { 1 }) }
    Files.createSymbolicLink(File(generation, "media-linked.db").toPath(), outside.toPath())
    val manager = manager(root)
    val id = manager.begin()

    assertFailure(AttachmentCacheScanFailure.CORRUPT) { manager.next(id) }
    assertTrue(outside.exists())
    assertEquals(7L, outside.length())
  }

  @Test
  fun `legacy final-file symlinks are rejected without returning outside metadata`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val legacyDirectory = File(root, "legacy-guid").apply { mkdirs() }
    val outside = temporary.newFile("legacy-outside.db").apply { writeBytes(ByteArray(5) { 1 }) }
    Files.createSymbolicLink(File(legacyDirectory, "linked legacy.db").toPath(), outside.toPath())
    val manager = manager(root)
    val id = manager.begin()

    assertFailure(AttachmentCacheScanFailure.CORRUPT) { manager.next(id) }
    assertTrue(outside.exists())
    assertEquals(5L, outside.length())
  }

  @Test
  fun `a symlinked or non-directory fixed root is rejected before a session is published`() {
    val realRoot = temporary.newFolder("real-attachments").canonicalFile
    val linkedRoot = File(temporary.root, "linked-attachments")
    Files.createSymbolicLink(linkedRoot.toPath(), realRoot.toPath())
    val linkedManager = manager(linkedRoot)
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { linkedManager.begin() }

    val fileRoot = temporary.newFile("attachments-file")
    val fileManager = manager(fileRoot)
    assertFailure(AttachmentCacheScanFailure.CORRUPT) { fileManager.begin() }
  }

  private fun manager(
    root: File,
    ids: ArrayDeque<String> = ArrayDeque(listOf("opaque-scan-id")),
    nowMs: () -> Long = { 1_000L },
    limits: AttachmentCacheScanLimits = AttachmentCacheScanLimits(),
    repairLimits: AttachmentCacheScanLimits = AttachmentCacheScanLimits.REPAIR,
  ): AttachmentCacheScanManager = AttachmentCacheScanManager(
    root = root,
    fileSystem = NioAttachmentCacheFileSystem(),
    nowMs = nowMs,
    idFactory = { ids.removeFirst() },
    limits = limits,
    repairLimits = repairLimits,
  )

  private fun repairLimits(
    maxFilesPerPage: Int,
    maxNodesPerPage: Int,
    sessionTtlMs: Long = 10_000L,
  ): AttachmentCacheScanLimits = AttachmentCacheScanLimits.REPAIR.copy(
    maxFilesPerPage = maxFilesPerPage,
    maxNodesPerPage = maxNodesPerPage,
    maxPageMs = 1_000L,
    sessionTtlMs = sessionTtlMs,
  )

  private fun cacheFile(parent: File, name: String, bytes: Int): File =
    File(parent, name).apply { writeBytes(ByteArray(bytes) { 1 }) }

  private fun collectAll(
    manager: AttachmentCacheScanManager,
    mode: AttachmentCacheScanMode = AttachmentCacheScanMode.STARTUP,
  ): List<AttachmentCacheScanEntry> {
    val id = manager.begin(mode)
    val entries = mutableListOf<AttachmentCacheScanEntry>()
    while (true) {
      val page = manager.next(id)
      entries += page.files
      if (page.done) return entries
    }
  }

  /** Read every page, deleting each returned file and any folder it empties, as cleanup does. */
  private fun drainWhileDeleting(
    manager: AttachmentCacheScanManager,
    mode: AttachmentCacheScanMode,
    root: File,
  ): List<File> {
    val id = manager.begin(mode)
    val removed = mutableListOf<File>()
    while (true) {
      val page = manager.next(id)
      for (entry in page.files) {
        assertTrue(entry.file.delete())
        removed += entry.file
        var folder = entry.file.parentFile
        while (
          folder != null && folder.path != root.path && folder.list()?.isEmpty() == true
        ) {
          assertTrue(folder.delete())
          folder = folder.parentFile
        }
      }
      if (page.done) return removed
    }
  }

  private fun assertFailure(
    expected: AttachmentCacheScanFailure,
    block: () -> Unit,
  ): AttachmentCacheScanException {
    val problem = assertThrows(AttachmentCacheScanException::class.java, block)
    assertEquals(expected, problem.failure)
    return problem
  }
}
