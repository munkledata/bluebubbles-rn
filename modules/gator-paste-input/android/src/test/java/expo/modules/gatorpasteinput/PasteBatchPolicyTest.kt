package expo.modules.gatorpasteinput

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PasteBatchPolicyTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun `production limits stay pinned`() {
    assertEquals(10, MAX_PASTED_FILES)
    assertEquals(128L * 1024 * 1024, MAX_PASTED_FILE_BYTES)
    assertEquals(512L * 1024 * 1024, MAX_PASTED_BATCH_BYTES)
    assertEquals(60_000L, PASTE_BATCH_TIMEOUT_MS)
    assertEquals(1024L * 1024 * 1024, PASTE_CACHE_MAX_BYTES)
    assertEquals(32, PASTE_CACHE_MAX_BATCHES)
    assertEquals(64, PASTE_CACHE_MAX_ROOT_ENTRIES)
    assertEquals(24L * 60 * 60 * 1000, PASTE_CACHE_MAX_AGE_MS)
    assertEquals(2_000, MAX_PROTECTED_PASTE_PATHS)
  }

  @Test
  fun `count is rejected before an atomic batch invokes its builder`() {
    var invoked = false
    val failure = expectFailure(PasteBatchFailure.COUNT) {
      createAtomicPasteBatch(temporary.root.canonicalFile, "too-many", MAX_PASTED_FILES + 1) {
        invoked = true
        emptyList<String>()
      }
    }

    assertEquals(PasteBatchFailure.COUNT, failure.reason)
    assertFalse(invoked)
    assertFalse(File(temporary.root.canonicalFile, "too-many.pending").exists())
  }

  @Test
  fun `reported per-file and aggregate limits reject before streaming`() {
    expectFailure(PasteBatchFailure.FILE_SIZE) {
      budget(maxFile = 5, maxBatch = 20).validateReportedSizes(listOf(6))
    }
    expectFailure(PasteBatchFailure.BATCH_SIZE) {
      budget(maxFile = 10, maxBatch = 12).validateReportedSizes(listOf(7, 6))
    }
  }

  @Test
  fun `only grant-mediated content URI schemes are accepted`() {
    assertTrue(isSupportedPasteUriScheme("content"))
    assertFalse(isSupportedPasteUriScheme("file"))
    assertFalse(isSupportedPasteUriScheme("android.resource"))
    assertFalse(isSupportedPasteUriScheme(null))
  }

  @Test
  fun `deadline helper rejects the exact boundary and anything later`() {
    requirePasteDeadline(nowMs = 9L, deadlineAtMs = 10L)
    expectFailure(PasteBatchFailure.DEADLINE) {
      requirePasteDeadline(nowMs = 10L, deadlineAtMs = 10L)
    }
    expectFailure(PasteBatchFailure.DEADLINE) {
      requirePasteDeadline(nowMs = 11L, deadlineAtMs = 10L)
    }
  }

  @Test
  fun `unknown-size file writes no byte beyond its per-file cap`() {
    val output = ByteArrayOutputStream()
    val budget = budget(maxFile = 5, maxBatch = 20)

    expectFailure(PasteBatchFailure.FILE_SIZE) {
      budget.copy(ByteArrayInputStream(ByteArray(6) { 1 }), output)
    }

    assertEquals(0, output.size())
    assertEquals(0L, budget.copiedBytes)
  }

  @Test
  fun `one aggregate budget spans every file and stops the crossing chunk`() {
    val budget = budget(maxFile = 10, maxBatch = 10)
    val first = ByteArrayOutputStream()
    assertEquals(6L, budget.copy(ByteArrayInputStream(ByteArray(6) { 1 }), first))

    val second = ByteArrayOutputStream()
    expectFailure(PasteBatchFailure.BATCH_SIZE) {
      budget.copy(ByteArrayInputStream(ByteArray(5) { 2 }), second)
    }

    assertEquals(6, first.size())
    assertEquals(0, second.size())
    assertEquals(6L, budget.copiedBytes)
  }

  @Test
  fun `bytes returned at the absolute deadline are not written`() {
    var now = 0L
    val input = object : InputStream() {
      override fun read(): Int = error("bulk read expected")

      override fun read(target: ByteArray, offset: Int, length: Int): Int {
        target[offset] = 1
        now = 10L
        return 1
      }
    }
    val output = ByteArrayOutputStream()
    val budget = PasteBatchBudget(
      deadlineAtMs = 10L,
      nowMs = { now },
      maxFileBytes = 10L,
      maxBatchBytes = 10L,
      bufferBytes = 4,
    )

    expectFailure(PasteBatchFailure.DEADLINE) { budget.copy(input, output) }
    assertEquals(0, output.size())
    assertEquals(0L, budget.copiedBytes)
  }

  @Test
  fun `a failed or short batch deletes every partial file`() {
    val failed = expectFailure(PasteBatchFailure.UNAVAILABLE) {
      createAtomicPasteBatch<String>(temporary.root.canonicalFile, "1000-1", 2) { pending ->
        File(pending, "first.bin").writeBytes(byteArrayOf(1, 2, 3))
        throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
      }
    }
    assertEquals(PasteBatchFailure.UNAVAILABLE, failed.reason)
    assertFalse(File(temporary.root.canonicalFile, "1000-1.pending").exists())
    assertFalse(File(temporary.root.canonicalFile, "1000-1").exists())

    expectFailure(PasteBatchFailure.UNAVAILABLE) {
      createAtomicPasteBatch(temporary.root.canonicalFile, "1000-2", 2) { pending ->
        File(pending, "first.bin").writeBytes(byteArrayOf(1))
        listOf("first.bin")
      }
    }
    assertFalse(File(temporary.root.canonicalFile, "1000-2.pending").exists())
    assertFalse(File(temporary.root.canonicalFile, "1000-2").exists())
  }

  @Test
  fun `a complete batch publishes all files with one directory rename`() {
    val result = createAtomicPasteBatch(temporary.root.canonicalFile, "1000-3", 2) { pending ->
      File(pending, "one.bin").writeBytes(byteArrayOf(1))
      File(pending, "two.bin").writeBytes(byteArrayOf(2))
      listOf("one.bin", "two.bin")
    }

    assertEquals(File(temporary.root.canonicalFile, "1000-3"), result.directory)
    assertEquals(listOf("one.bin", "two.bin"), result.items)
    assertFalse(File(temporary.root.canonicalFile, "1000-3.pending").exists())
    assertTrue(File(result.directory, "one.bin").exists())
    assertTrue(File(result.directory, "two.bin").exists())
  }

  @Test
  fun `cache inspection deletes pending and expired unreferenced batches but preserves references`() {
    val root = temporary.newFolder("pasted-in").canonicalFile
    val pending = batch(root, "9000-1.pending", 3)
    val expired = batch(root, "1000-2", 4)
    val protected = batch(root, "1001-3", 6)
    val retained = batch(root, "9500-3", 5)

    val stats = inspectPasteCacheRoot(
      root,
      nowMs = 10_000L,
      protectedPaths = setOf(File(protected, "payload.bin").canonicalPath),
      maxAgeMs = 1_000L,
    )

    assertEquals(PasteCacheStats(committedBatches = 2, committedBytes = 11L), stats)
    assertFalse(pending.exists())
    assertFalse(expired.exists())
    assertTrue(protected.exists())
    assertTrue(retained.exists())
  }

  @Test
  fun `cache inspection safely accounts for legacy timestamp-only batches after upgrade`() {
    val root = temporary.newFolder("legacy-pasted-in").canonicalFile
    val expired = batch(root, "1000", 4)
    val protected = batch(root, "1001", 6)
    val retained = batch(root, "9500", 5)

    val stats = inspectPasteCacheRoot(
      root,
      nowMs = 10_000L,
      protectedPaths = setOf(File(protected, "payload.bin").canonicalPath),
      maxAgeMs = 1_000L,
    )

    assertEquals(PasteCacheStats(committedBatches = 2, committedBytes = 11L), stats)
    assertFalse(expired.exists())
    assertTrue(protected.exists())
    assertTrue(retained.exists())
  }

  @Test
  fun `cache inspection removes empty legacy and current batches left by failed copies`() {
    val root = temporary.newFolder("empty-upgrade-batches").canonicalFile
    val emptyLegacy = File(root, "9500").apply { mkdirs() }
    val emptyCurrent = File(root, "9500-1").apply { mkdirs() }
    val retained = batch(root, "9500-2", 5)

    val stats = inspectPasteCacheRoot(root, nowMs = 10_000L, protectedPaths = emptySet())

    assertEquals(PasteCacheStats(committedBatches = 1, committedBytes = 5L), stats)
    assertFalse(emptyLegacy.exists())
    assertFalse(emptyCurrent.exists())
    assertTrue(retained.exists())
  }

  @Test
  fun `one new batch receives only the remaining global byte allowance`() {
    assertEquals(
      100L,
      availablePasteBatchBytes(
        PasteCacheStats(committedBatches = 31, committedBytes = 900L),
        maxCacheBytes = 1_000L,
        maxBatches = 32,
        maxBatchBytes = 512L,
      ),
    )
    expectFailure(PasteBatchFailure.CACHE_QUOTA) {
      availablePasteBatchBytes(
        PasteCacheStats(committedBatches = 32, committedBytes = 1L),
        maxCacheBytes = 1_000L,
        maxBatches = 32,
      )
    }
    expectFailure(PasteBatchFailure.CACHE_QUOTA) {
      availablePasteBatchBytes(
        PasteCacheStats(committedBatches = 1, committedBytes = 1_000L),
        maxCacheBytes = 1_000L,
        maxBatches = 32,
      )
    }
  }

  @Test
  fun `unknown root entries and symlink children fail closed without deleting targets`() {
    val unknownRoot = temporary.newFolder("unknown-root").canonicalFile
    val unknown = File(unknownRoot, "not-owned.txt").apply { writeBytes(byteArrayOf(1)) }
    expectFailure(PasteBatchFailure.CACHE_QUOTA) {
      inspectPasteCacheRoot(unknownRoot, nowMs = 10_000L, protectedPaths = emptySet())
    }
    assertTrue(unknown.exists())

    val symlinkRoot = temporary.newFolder("symlink-root").canonicalFile
    val expired = File(symlinkRoot, "1000-1").apply { mkdirs() }
    val outside = temporary.newFile("outside-secret.bin").apply { writeBytes(byteArrayOf(9)) }
    Files.createSymbolicLink(File(expired, "linked.bin").toPath(), outside.toPath())
    expectFailure(PasteBatchFailure.CACHE_QUOTA) {
      inspectPasteCacheRoot(symlinkRoot, nowMs = 10_000L, protectedPaths = emptySet())
    }
    assertTrue(outside.exists())
    assertTrue(expired.exists())
  }

  @Test
  fun `over-cap legacy root performs bounded cleanup then succeeds on the next pass`() {
    val root = temporary.newFolder("many-batches").canonicalFile
    batch(root, "9000-1", 1)
    File(root, "8000-2").apply { mkdirs() }
    batch(root, "9000-3", 1)

    expectFailure(PasteBatchFailure.CACHE_QUOTA) {
      inspectPasteCacheRoot(
        root,
        nowMs = 10_000L,
        protectedPaths = emptySet(),
        maxAgeMs = 1_000L,
        maxRootEntries = 2,
      )
    }
    assertEquals(2, root.listFiles()?.size)

    val repaired = inspectPasteCacheRoot(
      root,
      nowMs = 10_000L,
      protectedPaths = emptySet(),
      maxAgeMs = 1_000L,
      maxRootEntries = 2,
    )
    assertEquals(PasteCacheStats(committedBatches = 2, committedBytes = 2L), repaired)
  }

  @Test
  fun `expired abandoned batches are reclaimed before the batch quota becomes permanent`() {
    val root = temporary.newFolder("abandoned-batches").canonicalFile
    repeat(PASTE_CACHE_MAX_BATCHES) { index -> batch(root, "${1_000 + index}-1", 1) }

    val stats = inspectPasteCacheRoot(
      root,
      nowMs = 100_000L,
      protectedPaths = emptySet(),
      maxAgeMs = 1_000L,
    )

    assertEquals(PasteCacheStats(committedBatches = 0, committedBytes = 0L), stats)
    assertEquals(0, root.listFiles()?.size)
  }

  @Test
  fun `DB reference paths accept exact committed batches and reject aliases or other roots`() {
    val root = temporary.newFolder("reference-root").canonicalFile
    val current = File(batch(root, "1000-1", 1), "payload.bin").canonicalFile
    val legacy = File(batch(root, "1001", 1), "payload.bin").canonicalFile
    val pending = File(batch(root, "1002-1.pending", 1), "payload.bin").canonicalFile
    val outside = temporary.newFile("outside-reference.bin").canonicalFile
    val alias = File(current.parentFile, "alias.bin")
    Files.createSymbolicLink(alias.toPath(), outside.toPath())

    assertEquals(current.path, ownedPasteReferencePath(root, current))
    assertEquals(legacy.path, ownedPasteReferencePath(root, legacy))
    assertNull(ownedPasteReferencePath(root, pending))
    assertNull(ownedPasteReferencePath(root, outside))
    assertNull(ownedPasteReferencePath(root, alias))
  }

  private fun budget(maxFile: Long, maxBatch: Long): PasteBatchBudget = PasteBatchBudget(
    deadlineAtMs = 100L,
    nowMs = { 0L },
    maxFileBytes = maxFile,
    maxBatchBytes = maxBatch,
    bufferBytes = 8,
  )

  private fun batch(root: File, name: String, bytes: Int): File = File(root, name).apply {
    mkdirs()
    File(this, "payload.bin").writeBytes(ByteArray(bytes) { 1 })
  }

  private fun expectFailure(
    reason: PasteBatchFailure,
    block: () -> Unit,
  ): PasteBatchException {
    val problem = try {
      block()
      throw AssertionError("expected $reason")
    } catch (problem: PasteBatchException) {
      problem
    }
    assertEquals(reason, problem.reason)
    return problem
  }
}
