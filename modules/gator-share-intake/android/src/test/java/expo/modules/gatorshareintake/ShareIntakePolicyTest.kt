package expo.modules.gatorshareintake

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareIntakePolicyTest {
  private val temporaryRoots = mutableListOf<java.io.File>()

  @After
  fun cleanup() {
    temporaryRoots.forEach { it.deleteRecursively() }
  }

  @Test
  fun `actual bytes are copied under one file and aggregate budget`() {
    val output = ByteArrayOutputStream()
    val budget = ShareBatchBudget(
      deadlineAtMs = 10L,
      nowMs = { 0L },
      maxFileBytes = 4L,
      maxBatchBytes = 6L,
      bufferBytes = 2,
    )
    assertEquals(4L, budget.copy(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), output))
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), output.toByteArray())
    assertEquals(4L, budget.copiedBytes)

    val second = ByteArrayOutputStream()
    val error = assertThrows(ShareIntakeException::class.java) {
      budget.copy(ByteArrayInputStream(byteArrayOf(5, 6, 7)), second)
    }
    assertEquals(ShareIntakeFailure.BATCH_SIZE, error.reason)
    assertArrayEquals(byteArrayOf(5, 6), second.toByteArray())
  }

  @Test
  fun `sentinel byte rejects oversized file without writing it`() {
    val output = ByteArrayOutputStream()
    val budget = ShareBatchBudget(
      deadlineAtMs = 10L,
      nowMs = { 0L },
      maxFileBytes = 2L,
      maxBatchBytes = 10L,
      bufferBytes = 8,
    )
    val error = assertThrows(ShareIntakeException::class.java) {
      budget.copy(ByteArrayInputStream(byteArrayOf(1, 2, 3)), output)
    }
    assertEquals(ShareIntakeFailure.FILE_SIZE, error.reason)
    assertEquals(0, output.size())
  }

  @Test
  fun `all declared sizes reject before copy`() {
    val budget = ShareBatchBudget(
      deadlineAtMs = 10L,
      nowMs = { 0L },
      maxFileBytes = 5L,
      maxBatchBytes = 8L,
    )
    val error = assertThrows(ShareIntakeException::class.java) {
      budget.validateDeclaredSizes(listOf(4L, 5L))
    }
    assertEquals(ShareIntakeFailure.BATCH_SIZE, error.reason)
    assertEquals(0L, budget.copiedBytes)
  }

  @Test
  fun `deadline is checked again after a blocking read`() {
    var now = 0L
    val input = object : ByteArrayInputStream(byteArrayOf(1)) {
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        now = 10L
        return super.read(buffer, offset, length)
      }
    }
    val output = ByteArrayOutputStream()
    val error = assertThrows(ShareIntakeException::class.java) {
      ShareBatchBudget(10L, { now }).copy(input, output)
    }
    assertEquals(ShareIntakeFailure.DEADLINE, error.reason)
    assertEquals(0, output.size())
  }

  // Review M173: this is the exact check production runs on every shared URI.
  @Test
  fun `content uri check refuses everything but a bounded hierarchical content uri`() {
    val good = "content://media/external/images/media/1"
    requireSupportedShareContentUri(good, "content", true, "media")
    requireSupportedShareContentUri(
      "c".repeat(MAX_CONTENT_URI_CHARS),
      "content",
      true,
      "a".repeat(MAX_CONTENT_AUTHORITY_CHARS),
    )
    val refused: List<() -> Unit> = listOf(
      { requireSupportedShareContentUri("file:///sdcard/a.jpg", "file", true, null) },
      { requireSupportedShareContentUri("CONTENT://media/1", "CONTENT", true, "media") },
      { requireSupportedShareContentUri(good, null, true, "media") },
      // Each refusal is isolated: this one differs from a good URI only by being opaque.
      { requireSupportedShareContentUri(good, "content", false, "media") },
      { requireSupportedShareContentUri("content:///a", "content", true, "") },
      { requireSupportedShareContentUri("content://%20/a", "content", true, " ") },
      { requireSupportedShareContentUri("", "content", true, "media") },
      {
        requireSupportedShareContentUri(
          "c".repeat(MAX_CONTENT_URI_CHARS + 1),
          "content",
          true,
          "media",
        )
      },
      {
        requireSupportedShareContentUri(
          good,
          "content",
          true,
          "a".repeat(MAX_CONTENT_AUTHORITY_CHARS + 1),
        )
      },
    )
    refused.forEachIndexed { index, refusal ->
      assertEquals(
        "case $index",
        ShareIntakeFailure.SCHEME,
        assertThrows(ShareIntakeException::class.java) { refusal() }.reason,
      )
    }
  }

  @Test
  fun `share input policy rejects unsupported counts and text`() {
    assertEquals(
      ShareIntakeFailure.COUNT,
      assertThrows(ShareIntakeException::class.java) { requireValidShareCount(11) }.reason,
    )
    val own = "com.bluegreengatorapps.messages"
    val files = "com.bluegreengatorapps.messages.FileSystemFileProvider"
    val owner = mapOf(files to own, "media" to "com.android.providers.media.module")::get
    for (authority in listOf(files, "0@$files", "10@$files")) {
      assertEquals(
        ShareIntakeFailure.PERMISSION,
        assertThrows(ShareIntakeException::class.java) {
          requireForeignShareProvider(authority, own, owner)
        }.reason,
      )
    }
    // Another app's provider, or one Gator cannot see, stays eligible.
    for (authority in listOf("media", "0@media", "com.example.unknown")) {
      requireForeignShareProvider(authority, own, owner)
    }
    assertEquals(
      ShareIntakeFailure.TEXT_SIZE,
      assertThrows(ShareIntakeException::class.java) {
        requireValidSharedText("x".repeat(MAX_SHARED_TEXT_BYTES + 1))
      }.reason,
    )
  }

  @Test
  fun `direct share target requires the exact hmac token shape`() {
    val exact = "${SHARE_SHORTCUT_PREFIX}${"a".repeat(43)}"
    assertEquals(exact, requireValidShareTarget(exact))
    for (suffixLength in listOf(16, 42, 44, 180)) {
      assertEquals(
        ShareIntakeFailure.MALFORMED,
        assertThrows(ShareIntakeException::class.java) {
          requireValidShareTarget("${SHARE_SHORTCUT_PREFIX}${"a".repeat(suffixLength)}")
        }.reason,
      )
    }
  }

  @Test
  fun `generated file names remove traversal and remain distinct`() {
    assertEquals("00-secret.pdf", sharedFileName(0, "../../secret.pdf", "application/pdf"))
    assertEquals("01-attachment.jpg", sharedFileName(1, null, "image/jpeg"))
    assertEquals("02-r_sum.pdf", sharedFileName(2, "résumé.pdf", "application/pdf"))
  }

  // Review M170: a non-English name used to lose its extension ("Отчёт.docx" became "docx.bin").
  @Test
  fun `non english names keep their own ascii extension`() {
    val docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    assertEquals("00-attachment.docx", sharedFileName(0, "Отчёт.docx", docx))
    assertEquals("01-attachment.pdf", sharedFileName(1, "报告.pdf", "application/pdf"))
    assertEquals("02-2026.docx", sharedFileName(2, "Отчёт 2026.docx", docx))
    assertEquals("03-photo.JPG", sharedFileName(3, "photo.JPG", "image/jpeg"))
    assertEquals("04-report.tar.gz", sharedFileName(4, "report.tar.gz", "application/gzip"))
    // A long name keeps its extension instead of being cut through it.
    assertEquals(
      "05-${"a".repeat(80)}.docx",
      sharedFileName(5, "${"a".repeat(120)}.docx", "application/octet-stream"),
    )
    // No usable extension of its own: the type decides, as before.
    assertEquals("06-notes.txt", sharedFileName(6, "notes.тест", "text/plain"))
    assertEquals("07-bashrc.bin", sharedFileName(7, ".bashrc", "application/octet-stream"))
    assertEquals("08-attachment.pdf", sharedFileName(8, "报告", "application/pdf"))
    assertEquals("09-attachment.bin", sharedFileName(9, "Отчёт.", "application/octet-stream"))
  }

  @Test
  fun `provider mime resolves wildcard share hints without trusting malformed types`() {
    assertEquals("image/jpeg", resolvedShareMimeType("IMAGE/JPEG", "image/*"))
    assertEquals("application/pdf", resolvedShareMimeType(null, "application/pdf"))
    assertEquals("application/octet-stream", resolvedShareMimeType(null, "image/*"))
    assertEquals("application/octet-stream", resolvedShareMimeType("bad", "*/*"))
  }

  // Android formats %d in the phone's own digits, so on a phone set to Arabic (Egypt), Persian,
  // Bengali or Marathi every shared file name failed its own "00-" check and the share was refused.
  @Test
  fun `file names and manifests use ascii digits whatever the phone language`() {
    val original = Locale.getDefault()
    try {
      for (tag in listOf("ar-EG", "fa-IR", "bn-BD", "mr-IN")) {
        Locale.setDefault(Locale.forLanguageTag(tag))
        assertEquals(tag, "03-a.pdf", sharedFileName(3, "a.pdf", "application/pdf"))
        val manifest = manifest()
        assertEquals(tag, manifest, decodeShareManifest(encodeShareManifest(manifest)))
      }
    } finally {
      Locale.setDefault(original)
    }
  }

  @Test
  fun `manifest codec round trips one atomic text and file batch`() {
    val manifest = manifest()
    assertEquals(manifest, decodeShareManifest(encodeShareManifest(manifest)))
  }

  @Test
  fun `manifest codec rejects trailing bytes and content-free batches`() {
    val encoded = encodeShareManifest(manifest()) + byteArrayOf(1)
    assertEquals(
      ShareIntakeFailure.MALFORMED,
      assertThrows(ShareIntakeException::class.java) { decodeShareManifest(encoded) }.reason,
    )
    assertEquals(
      ShareIntakeFailure.EMPTY,
      assertThrows(ShareIntakeException::class.java) {
        encodeShareManifest(manifest().copy(text = null, files = emptyList()))
      }.reason,
    )
  }

  @Test
  fun `storage replays one exact claim and final acknowledgement deletes native sources`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val manifest = manifest()
    val pending = storage.pendingFilesDirectory(manifest.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))

    storage.commit(manifest, pending)
    assertEquals(manifest, storage.takeNext(manifest.createdAtMs))
    assertEquals(manifest, storage.takeNext(manifest.createdAtMs))
    assertTrue(storage.acknowledge(manifest.batchId))
    assertNull(storage.takeNext(manifest.createdAtMs))
    assertFalse(storage.committedFile(manifest, manifest.files.single()).exists())
    assertTrue(storage.acknowledge(manifest.batchId))
    assertTrue(storage.discard(manifest.batchId))
  }

  @Test
  fun `a commit that crosses the absolute deadline is retracted before publication`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val manifest = manifest()
    val pending = storage.pendingFilesDirectory(manifest.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))

    assertFalse(storage.commitWithinDeadline(manifest, pending, 10L) { 10L })
    assertNull(storage.takeNext(manifest.createdAtMs))
    assertFalse(storage.committedFile(manifest, manifest.files.single()).exists())
  }

  @Test
  fun `release is compare and set and makes the intact claim deliverable again`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val manifest = manifest()
    val pending = storage.pendingFilesDirectory(manifest.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
    storage.commit(manifest, pending)

    assertEquals(manifest, storage.takeNext(manifest.createdAtMs))
    assertFalse(storage.release("1001-1-0123456789abcdef"))
    assertTrue(storage.release(manifest.batchId))
    assertTrue(storage.committedFile(manifest, manifest.files.single()).isFile)
    assertEquals(manifest, storage.takeNext(manifest.createdAtMs))
    assertTrue(storage.discard(manifest.batchId))
    assertFalse(storage.committedFile(manifest, manifest.files.single()).exists())
  }

  @Test
  fun `claimed batch is replayed by a new storage owner after process restart`() {
    val root = temporaryRoot()
    val first = ShareIntakeStorage(root)
    val manifest = manifest()
    val pending = first.pendingFilesDirectory(manifest.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
    first.commit(manifest, pending)
    assertEquals(manifest, first.takeNext(manifest.createdAtMs))

    val restarted = ShareIntakeStorage(root)
    assertEquals(manifest, restarted.takeNext(manifest.createdAtMs + 1L))
    assertTrue(restarted.acknowledge(manifest.batchId))
  }

  @Test
  fun `durable settlement remains retryable when physical cleanup initially fails`() {
    for (settlement in listOf("acknowledge", "discard")) {
      val root = temporaryRoot()
      val storage = ShareIntakeStorage(root)
      val item = manifest(createdAtMs = 2_000L + temporaryRoots.size)
      commitBatch(storage, item)
      assertEquals(item, storage.takeNext(item.createdAtMs))

      val sharedFile = storage.committedFile(item, item.files.single())
      assertTrue(sharedFile.delete())
      assertTrue(sharedFile.mkdir())
      java.io.File(sharedFile, "blocks-cleanup").writeText("keep")

      val first = if (settlement == "acknowledge") {
        storage.acknowledge(item.batchId)
      } else {
        storage.discard(item.batchId)
      }
      assertFalse("$settlement hid an incomplete physical cleanup", first)
      assertFalse(storage.release(item.batchId))

      assertTrue(sharedFile.deleteRecursively())
      if (settlement == "discard") {
        storage.recoverAndPrune(item.createdAtMs + 1L)
      }
      val retry = if (settlement == "acknowledge") {
        storage.acknowledge(item.batchId)
      } else {
        storage.discard(item.batchId)
      }
      assertTrue("$settlement could not resume terminal cleanup", retry)
      assertAccountResetArtifactsAbsent(root, item.batchId)
      assertTrue(
        "recovery-win retry was not idempotent",
        if (settlement == "acknowledge") {
          storage.acknowledge(item.batchId)
        } else {
          storage.discard(item.batchId)
        },
      )
    }
  }

  @Test
  fun `age pruning keeps the live claim while admitting later work`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val claimed = manifest(createdAtMs = 1L)
    commitBatch(storage, claimed)
    assertEquals(claimed, storage.takeNext(claimed.createdAtMs))

    val afterCutoff = SHARE_CACHE_MAX_AGE_MS + 2L
    assertTrue(storage.admissionBudget(afterCutoff) > 0L)
    val later = manifest(createdAtMs = afterCutoff)
    commitBatch(storage, later)

    assertEquals(claimed, storage.takeNext(afterCutoff))
    assertTrue(storage.acknowledge(claimed.batchId))
    assertEquals(later, storage.takeNext(afterCutoff))
    assertTrue(storage.discard(later.batchId))
  }

  @Test
  fun `account reset discard is idempotent when the exact batch is absent`() {
    val storage = ShareIntakeStorage(temporaryRoot())
    val batchId = manifest().batchId

    assertTrue(storage.discardForAccountReset(batchId))
    assertTrue(storage.discardForAccountReset(batchId))
  }

  @Test
  fun `account reset discard removes ready claimed acknowledged and committed states`() {
    for (state in listOf("ready", "claimed", "acknowledged", "committed")) {
      val root = temporaryRoot()
      val storage = ShareIntakeStorage(root)
      val item = manifest(createdAtMs = 1_000L + temporaryRoots.size)
      val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
      val files = java.io.File(root, SHARE_FILES_DIRECTORY)

      when (state) {
        "ready" -> commitBatch(storage, item)
        "claimed" -> {
          commitBatch(storage, item)
          assertEquals(item, storage.takeNext(item.createdAtMs))
        }
        "acknowledged" -> {
          commitBatch(storage, item)
          assertTrue(
            java.io.File(queue, "${item.batchId}.share")
              .renameTo(java.io.File(queue, "${item.batchId}.acked")),
          )
        }
        "committed" -> {
          storage.pendingFilesDirectory(item.batchId)
          val committed = java.io.File(files, item.batchId)
          assertTrue(committed.mkdir())
          java.io.File(committed, item.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
        }
      }

      assertTrue("failed to discard $state state", storage.discardForAccountReset(item.batchId))
      assertAccountResetArtifactsAbsent(root, item.batchId)
      assertTrue("$state cleanup was not idempotent", storage.discardForAccountReset(item.batchId))
    }
  }

  @Test
  fun `account reset discard rejects a live pending batch without deleting it`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val item = manifest()
    val pendingFiles = storage.pendingFilesDirectory(item.batchId)
    assertTrue(pendingFiles.mkdir())
    java.io.File(pendingFiles, item.files.single().name).writeBytes(byteArrayOf(1, 2, 3))

    assertFalse(storage.discardForAccountReset(item.batchId))
    assertTrue(pendingFiles.isDirectory)

    val pendingManifest = java.io.File(
      java.io.File(root, SHARE_QUEUE_DIRECTORY),
      "${item.batchId}.pending",
    )
    pendingManifest.writeBytes(encodeShareManifest(item))
    assertFalse(storage.discardForAccountReset(item.batchId))
    assertTrue(pendingManifest.isFile)
    assertTrue(pendingFiles.isDirectory)
  }

  @Test
  fun `account reset discard rejects impossible ready and claimed ownership`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val item = manifest()
    commitBatch(storage, item)
    val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
    val ready = java.io.File(queue, "${item.batchId}.share")
    val claimed = java.io.File(queue, "${item.batchId}.claimed")
    ready.copyTo(claimed)

    assertFalse(storage.discardForAccountReset(item.batchId))
    assertTrue(ready.isFile)
    assertTrue(claimed.isFile)
    assertTrue(storage.committedFile(item, item.files.single()).isFile)
  }

  @Test
  fun `a second complete batch cannot displace the active claim`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val first = manifest(createdAtMs = 1_000L)
    val second = manifest(createdAtMs = 1_001L)
    for (item in listOf(first, second)) {
      val pending = storage.pendingFilesDirectory(item.batchId)
      assertTrue(pending.mkdir())
      java.io.File(pending, item.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
      storage.commit(item, pending)
    }

    assertEquals(first, storage.takeNext(1_001L))
    assertEquals(first, storage.takeNext(1_001L))
    assertTrue(storage.acknowledge(first.batchId))
    assertEquals(second, storage.takeNext(1_001L))
  }

  @Test
  fun `restart promotes a complete files-first crash window`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    storage.recoverAndPrune(1L)
    val manifest = manifest()
    val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
    val files = java.io.File(java.io.File(root, SHARE_FILES_DIRECTORY), manifest.batchId)
    assertTrue(files.mkdir())
    java.io.File(files, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
    java.io.File(queue, "${manifest.batchId}.pending").writeBytes(encodeShareManifest(manifest))

    storage.recoverAndPrune(manifest.createdAtMs)
    assertEquals(manifest, storage.takeNext(manifest.createdAtMs))
  }

  @Test
  fun `restart removes an incomplete pending batch`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    storage.recoverAndPrune(1L)
    val manifest = manifest()
    val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
    val pendingFiles = java.io.File(
      java.io.File(root, SHARE_FILES_DIRECTORY),
      "${manifest.batchId}.pending",
    )
    assertTrue(pendingFiles.mkdir())
    java.io.File(queue, "${manifest.batchId}.pending").writeBytes(encodeShareManifest(manifest))

    storage.recoverAndPrune(manifest.createdAtMs)
    assertNull(storage.takeNext(manifest.createdAtMs))
    assertFalse(pendingFiles.exists())
  }

  @Test
  fun `queue pulls preserve only the exact process active pending batch`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val manifest = manifest()
    val pendingFiles = storage.pendingFilesDirectory(manifest.batchId)
    assertTrue(pendingFiles.mkdir())
    java.io.File(pendingFiles, manifest.files.single().name).writeBytes(byteArrayOf(1))

    val activeStats = storage.recoverAndPrune(
      manifest.createdAtMs,
      setOf(manifest.batchId),
    )

    assertTrue(pendingFiles.isDirectory)
    assertEquals(0, activeStats.batches)
    assertEquals(0L, activeStats.bytes)

    storage.recoverAndPrune(manifest.createdAtMs)
    assertFalse(pendingFiles.exists())
  }

  @Test
  fun `restart removes corrupt and truncated pending manifests with exact batch files`() {
    for (bytes in listOf(byteArrayOf(1, 2, 3), encodeShareManifest(manifest()).copyOf(12))) {
      val root = temporaryRoot()
      val storage = ShareIntakeStorage(root)
      storage.recoverAndPrune(1L)
      val manifest = manifest()
      val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
      val files = java.io.File(java.io.File(root, SHARE_FILES_DIRECTORY), manifest.batchId)
      assertTrue(files.mkdir())
      java.io.File(files, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
      val pending = java.io.File(queue, "${manifest.batchId}.pending")
      pending.writeBytes(bytes)

      storage.recoverAndPrune(manifest.createdAtMs)

      assertFalse(pending.exists())
      assertFalse(files.exists())
      assertNull(storage.takeNext(manifest.createdAtMs))
    }
  }

  @Test
  fun `reason only rejection receipt survives restart and is consumed once`() {
    val root = temporaryRoot()
    ShareIntakeStorage(root).recordRejection(ShareIntakeFailure.DEADLINE)

    val restarted = ShareIntakeStorage(root)
    assertEquals(ShareIntakeFailure.DEADLINE, restarted.consumeRejection())
    assertNull(restarted.consumeRejection())
  }

  @Test
  fun `absolute deadline returns while hostile read and close both remain blocked`() {
    val provider = boundedTestExecutor("share-hostile-provider")
    val cleanup = boundedTestExecutor("share-hostile-cleanup")
    val input = NonCooperativeInputStream()
    val now = { TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) }
    val state = ShareProviderOperationState(
      deadlineAtMs = now() + 250L,
      nowMs = now,
      cleanupDispatcher = ShareCleanupDispatcher { action -> cleanup.execute(action) },
    )
    try {
      val startedAt = System.nanoTime()
      val failure = assertThrows(ShareIntakeException::class.java) {
        awaitShareProviderOperation(state, provider) {
          state.registerProviderCleanup(input) { input.close() }
          input.read()
        }
      }
      val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)

      assertEquals(ShareIntakeFailure.DEADLINE, failure.reason)
      assertTrue("controller exceeded its independent deadline: ${elapsedMs}ms", elapsedMs < 2_000L)
      assertTrue(input.readStarted.await(1, TimeUnit.SECONDS))
      assertTrue(input.closeStarted.await(1, TimeUnit.SECONDS))
      assertFalse(input.released)
    } finally {
      input.release()
      provider.shutdownNow()
      cleanup.shutdownNow()
    }
  }

  @Test
  fun `expired ready and acknowledged batches are pruned`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    val manifest = manifest(createdAtMs = 1L)
    val pending = storage.pendingFilesDirectory(manifest.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, manifest.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
    storage.commit(manifest, pending)

    val stats = storage.recoverAndPrune(SHARE_CACHE_MAX_AGE_MS + 2L)
    assertEquals(0, stats.batches)
    assertEquals(0L, stats.bytes)
    assertNull(storage.takeNext(SHARE_CACHE_MAX_AGE_MS + 2L))
  }

  @Test
  fun `unknown root entries fail closed without deletion`() {
    val root = temporaryRoot()
    val storage = ShareIntakeStorage(root)
    storage.recoverAndPrune(1L)
    val unknown = java.io.File(java.io.File(root, SHARE_QUEUE_DIRECTORY), "foreign")
    unknown.writeText("keep")
    assertThrows(ShareIntakeException::class.java) { storage.recoverAndPrune(2L) }
    assertTrue(unknown.exists())
  }

  private fun temporaryRoot(): java.io.File =
    Files.createTempDirectory("gator-share-intake-").toFile().also(temporaryRoots::add)

  private fun commitBatch(storage: ShareIntakeStorage, item: ShareManifest) {
    val pending = storage.pendingFilesDirectory(item.batchId)
    assertTrue(pending.mkdir())
    java.io.File(pending, item.files.single().name).writeBytes(byteArrayOf(1, 2, 3))
    storage.commit(item, pending)
  }

  private fun assertAccountResetArtifactsAbsent(root: java.io.File, batchId: String) {
    val queue = java.io.File(root, SHARE_QUEUE_DIRECTORY)
    val files = java.io.File(root, SHARE_FILES_DIRECTORY)
    for (suffix in listOf(".pending", ".share", ".claimed", ".acked")) {
      assertFalse(java.io.File(queue, "$batchId$suffix").exists())
    }
    assertFalse(java.io.File(files, batchId).exists())
    assertFalse(java.io.File(files, "$batchId.pending").exists())
  }

  private fun manifest(createdAtMs: Long = 1_000L): ShareManifest = ShareManifest(
    batchId = "$createdAtMs-1-0123456789abcdef",
    createdAtMs = createdAtMs,
    text = "shared note",
    targetToken = "${SHARE_SHORTCUT_PREFIX}${"a".repeat(43)}",
    files = listOf(ShareManifestFile("00-photo.jpg", "image/jpeg", 3L)),
  )
}

private fun boundedTestExecutor(name: String): ThreadPoolExecutor = ThreadPoolExecutor(
  1,
  1,
  0L,
  TimeUnit.MILLISECONDS,
  SynchronousQueue(),
  { runnable -> Thread(runnable, name).apply { isDaemon = true } },
  ThreadPoolExecutor.AbortPolicy(),
)

private class NonCooperativeInputStream : InputStream() {
  val readStarted = CountDownLatch(1)
  val closeStarted = CountDownLatch(1)
  private val releaseLatch = CountDownLatch(1)

  @Volatile
  var released = false
    private set

  override fun read(): Int {
    readStarted.countDown()
    ignoreInterruptsUntilRelease()
    return -1
  }

  override fun close() {
    closeStarted.countDown()
    ignoreInterruptsUntilRelease()
  }

  fun release() {
    released = true
    releaseLatch.countDown()
  }

  private fun ignoreInterruptsUntilRelease() {
    while (!releaseLatch.await(10, TimeUnit.MILLISECONDS)) {
      Thread.interrupted()
    }
  }
}
