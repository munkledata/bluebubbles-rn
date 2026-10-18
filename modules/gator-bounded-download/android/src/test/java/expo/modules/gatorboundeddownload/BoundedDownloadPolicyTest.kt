package expo.modules.gatorboundeddownload

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedDownloadPolicyTest {
  @Test
  fun `only a whole-file HTTP response is accepted`() {
    assertTrue(isCompleteDownloadResponse(200))
    assertFalse(isCompleteDownloadResponse(201))
    assertFalse(isCompleteDownloadResponse(204))
    assertFalse(isCompleteDownloadResponse(206))
    assertFalse(isCompleteDownloadResponse(299))
  }

  @Test
  fun `known response length must equal the streamed byte count`() {
    assertTrue(matchesDeclaredDownloadLength(-1L, 12L))
    assertTrue(matchesDeclaredDownloadLength(12L, 12L))
    assertFalse(matchesDeclaredDownloadLength(-2L, 12L))
    assertFalse(matchesDeclaredDownloadLength(11L, 12L))
    assertFalse(matchesDeclaredDownloadLength(13L, 12L))
  }

  // Review M165: the download loop itself, driven on the JVM with a fake clock and stream.
  @Test
  fun `a body at the cap is copied whole`() {
    val body = ByteArray(10) { it.toByte() }
    val output = ByteArrayOutputStream()
    val run = BodyCopy()

    assertEquals(10L, run.copy(ChunkedInput(body, chunk = 4), output, maxBytes = 10L))
    assertArrayEquals(body, output.toByteArray())
    assertEquals(0, run.aborts)
  }

  @Test
  fun `an oversized body fails before its sentinel byte is written`() {
    for (chunk in listOf(4, COPY_BUFFER_BYTES)) {
      val output = ByteArrayOutputStream()
      val run = BodyCopy()

      val failure = assertThrows(DownloadFailure::class.java) {
        run.copy(ChunkedInput(ByteArray(12), chunk), output, maxBytes = 10L)
      }

      assertEquals(REASON_SIZE, failure.reason)
      assertTrue("chunk $chunk wrote ${output.size()}", output.size() <= 10)
      assertEquals(1, run.aborts)
    }
  }

  @Test
  fun `cancellation stops the copy before the next read`() {
    val output = ByteArrayOutputStream()
    var reads = 0
    val input = object : InputStream() {
      override fun read(): Int = throw UnsupportedOperationException()
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        reads += 1
        buffer[offset] = 7
        return 1
      }
    }
    val run = BodyCopy(cancelAfterChecks = 2)

    val failure = assertThrows(DownloadFailure::class.java) {
      run.copy(input, output, maxBytes = 10L)
    }

    assertEquals(REASON_CANCELLED, failure.reason)
    assertEquals(1, reads)
    assertEquals(1, output.size())
  }

  @Test
  fun `the deadline stops a slow body and aborts its call`() {
    val output = ByteArrayOutputStream()
    val run = BodyCopy(deadlineMs = 3L)

    val failure = assertThrows(DownloadFailure::class.java) {
      run.copy(ChunkedInput(ByteArray(10), chunk = 1), output, maxBytes = 10L)
    }

    assertEquals(REASON_TIMEOUT, failure.reason)
    assertEquals(1, run.aborts)
    assertTrue(output.size() < 10)
  }

  @Test
  fun `a body that ends early returns its short count for the declared-length check`() {
    val run = BodyCopy()
    val copied = run.copy(ChunkedInput(ByteArray(3), chunk = 2), ByteArrayOutputStream(), 10L)

    assertEquals(3L, copied)
    assertFalse(matchesDeclaredDownloadLength(5L, copied))
  }

  @Test
  fun `a zero-byte read is retried rather than ending the body`() {
    val body = ByteArray(5) { 1 }
    val output = ByteArrayOutputStream()
    val copied = BodyCopy().copy(ChunkedInput(body, chunk = 5, zeroReadsFirst = 2), output, 10L)

    assertEquals(5L, copied)
    assertArrayEquals(body, output.toByteArray())
  }

  @Test
  fun `progress is reported at most once per interval`() {
    val run = BodyCopy(clockStepMs = 30L)
    run.copy(ChunkedInput(ByteArray(40), chunk = 1), ByteArrayOutputStream(), maxBytes = 40L)

    assertTrue(run.progress.size >= 2)
    run.progress.zipWithNext { earlier, later -> assertTrue(later > earlier) }
    run.progressTimes.zipWithNext { earlier, later ->
      assertTrue("$earlier -> $later", later - earlier >= PROGRESS_INTERVAL_MS)
    }
  }

  @Test
  fun `image validation decode stays beneath its pixel ceiling`() {
    assertEquals(1, imageValidationSampleSize(1024, 1024, 1024L * 1024))
    assertEquals(2, imageValidationSampleSize(1025, 1025, 1024L * 1024))
    assertEquals(8, imageValidationSampleSize(8000, 6000, 1024L * 1024))
    assertEquals(16, imageValidationSampleSize(16_384, 16_384, 1024L * 1024))
  }

  @Test
  fun `a download may only write its own partial file`() {
    val cache = File("/data/user/0/app/cache")
    val parts = File(cache, "bounded-download-parts")
    assertTrue(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1700000000000-1.part")))
    assertTrue(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1-12345.part")))

    // Review M160: any other file in the app's private folders is out of bounds.
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(cache, "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(File(cache, "other"), "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(File(parts, "nested"), "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1-1.tmp")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-a-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "gator.db")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, parts))
    assertFalse(
      isOwnedBoundedDownloadPartial(
        cache,
        File("/data/user/0/app/files/bounded-download-parts/request-1-1.part"),
      ),
    )
  }

  @Test
  fun `a failed exclusive create never removes the file already there`() {
    // Review M164: if the exclusive create fails, the file at that path is not this call's.
    var filled = 0
    var removed = 0
    val exists = IllegalStateException("EEXIST")
    val thrown = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { throw exists },
        fill = { _: Int -> filled += 1 },
        remove = { removed += 1 },
      )
    }
    assertSame(exists, thrown)
    assertEquals(0, filled)
    assertEquals(0, removed)
  }

  @Test
  fun `a failed fill removes only the file this call created`() {
    var removed = 0
    val copyFailed = IllegalStateException("copy failed")
    val thrown = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { 7 },
        fill = { descriptor ->
          assertEquals(7, descriptor)
          throw copyFailed
        },
        remove = { removed += 1 },
      )
    }
    assertSame(copyFailed, thrown)
    assertEquals(1, removed)

    // A failed removal must not hide why the fill failed.
    val stillCopyFailed = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { 7 },
        fill = { throw copyFailed },
        remove = { throw IllegalStateException("EBUSY") },
      )
    }
    assertSame(copyFailed, stillCopyFailed)

    removed = 0
    fillExclusivelyCreatedFile(create = { 7 }, fill = {}, remove = { removed += 1 })
    assertEquals(0, removed)
  }

  @Test
  fun `a fill that dies with an Error still removes the file this call created`() {
    var removed = 0
    val fatal = NotImplementedError("fatal")
    val thrown = assertThrows(NotImplementedError::class.java) {
      fillExclusivelyCreatedFile(create = { 7 }, fill = { throw fatal }, remove = { removed += 1 })
    }
    assertSame(fatal, thrown)
    assertEquals(1, removed)
  }
}

/** One body copy with a clock that advances on every check, so a spinning loop times out. */
private class BodyCopy(
  private val deadlineMs: Long = 1_000_000L,
  private val clockStepMs: Long = 1L,
  private val cancelAfterChecks: Int = Int.MAX_VALUE,
) {
  var aborts = 0
  val progress = mutableListOf<Long>()
  val progressTimes = mutableListOf<Long>()
  private var now = 0L
  private var checks = 0

  fun copy(input: InputStream, output: ByteArrayOutputStream, maxBytes: Long): Long =
    copyBoundedDownloadBody(
      input = input,
      output = output,
      maxBytes = maxBytes,
      deadlineMs = deadlineMs,
      clock = {
        now += clockStepMs
        now
      },
      isCancelled = {
        checks += 1
        checks >= cancelAfterChecks
      },
      abort = { aborts += 1 },
      onProgress = { loaded ->
        progress.add(loaded)
        progressTimes.add(now)
      },
    )
}

/** Serves [data] in reads of at most [chunk] bytes, after [zeroReadsFirst] empty reads. */
private class ChunkedInput(
  private val data: ByteArray,
  private val chunk: Int,
  private var zeroReadsFirst: Int = 0,
) : InputStream() {
  private var position = 0

  override fun read(): Int = throw UnsupportedOperationException()

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (zeroReadsFirst > 0) {
      zeroReadsFirst -= 1
      return 0
    }
    if (position >= data.size) return -1
    val count = minOf(chunk, length, data.size - position)
    System.arraycopy(data, position, buffer, offset, count)
    position += count
    return count
  }
}
