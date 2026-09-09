package expo.modules.gatorboundeddocument

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedDocumentReaderTest {
  @Test
  fun `cancellation wakes controller and runs provider cleanup off caller`() {
    val provider = boundedTestExecutor("cancel-provider")
    val cleanup = boundedTestExecutor("cancel-cleanup")
    val controller = boundedTestExecutor("cancel-controller")
    val release = CountDownLatch(1)
    val providerStarted = CountDownLatch(1)
    val cleanupStarted = CountDownLatch(1)
    val cleanupThread = AtomicReference<Thread>()
    val caller = Thread.currentThread()
    val state = activeState(DocumentCleanupDispatcher { action -> cleanup.execute(action) })
    try {
      val controllerFuture = controller.submit<Any?> {
        awaitBoundedProviderOperation(state, provider, 10_000) {
          val owner = Any()
          state.registerProviderOpenCancellation(owner) {
            cleanupThread.set(Thread.currentThread())
            cleanupStarted.countDown()
            ignoreInterruptsUntil(release)
          }
          providerStarted.countDown()
          ignoreInterruptsUntil(release)
          null
        }
      }
      assertTrue(providerStarted.await(1, TimeUnit.SECONDS))

      state.cancel()

      val failure = executionFailure(controllerFuture::get)
      assertEquals(DocumentReadReason.CANCELLED, failure.reason)
      assertTrue(cleanupStarted.await(1, TimeUnit.SECONDS))
      assertNotSame(caller, cleanupThread.get())
    } finally {
      release.countDown()
      controller.shutdownNow()
      provider.shutdownNow()
      cleanup.shutdownNow()
    }
  }

  @Test
  fun `release prepared cannot cancel a read that already started`() {
    val state = activeState()

    assertFalse(state.releasePrepared())
    assertNull(state.abortReason())
  }

  @Test
  fun `reads chunked unicode without seeking`() {
    val expected = "Gator backup: café · 河 · 🐊"
    val input = ChunkedInputStream(expected.toByteArray(StandardCharsets.UTF_8), 1)
    val state = activeState()

    val result = readBoundedUtf8(input, 1_024, state)

    assertEquals(expected, result.text)
    assertEquals(expected.toByteArray(StandardCharsets.UTF_8).size.toLong(), result.bytes)
    assertTrue(input.closed)
  }

  @Test
  fun `rejects max plus one without retaining the sentinel byte`() {
    val state = activeState()

    val failure = captureFailure {
      readBoundedUtf8(ByteArrayInputStream(ByteArray(9) { 7 }), 8, state)
    }

    assertEquals(DocumentReadReason.SIZE, failure.reason)
  }

  @Test
  fun `rejects malformed utf8`() {
    val state = activeState()

    val failure = captureFailure {
      readBoundedUtf8(ByteArrayInputStream(byteArrayOf(0xC3.toByte(), 0x28)), 8, state)
    }

    assertEquals(DocumentReadReason.INVALID, failure.reason)
  }

  @Test
  fun `cancellation closes and unblocks a pipe-like stream`() {
    val input = BlockingInputStream()
    val state = activeState()
    val executor = Executors.newSingleThreadExecutor()
    try {
      val future = executor.submit<BoundedDocumentRead> {
        readBoundedUtf8(input, 8, state)
      }
      assertTrue(input.entered.await(1, TimeUnit.SECONDS))

      state.cancel()

      val failure = executionFailure(future::get)
      assertEquals(DocumentReadReason.CANCELLED, failure.reason)
      assertTrue(input.closed)
    } finally {
      executor.shutdownNow()
    }
  }

  @Test
  fun `deadline closes and unblocks a pipe-like stream`() {
    val input = BlockingInputStream()
    val state = activeState()
    val worker = Executors.newSingleThreadExecutor()
    val scheduler = Executors.newSingleThreadScheduledExecutor()
    try {
      val future = worker.submit<BoundedDocumentRead> {
        readBoundedUtf8(input, 8, state)
      }
      assertTrue(input.entered.await(1, TimeUnit.SECONDS))
      scheduler.schedule({ state.timeout() }, 25, TimeUnit.MILLISECONDS)

      val failure = executionFailure(future::get)
      assertEquals(DocumentReadReason.TIMEOUT, failure.reason)
      assertTrue(input.closed)
    } finally {
      scheduler.shutdownNow()
      worker.shutdownNow()
    }
  }

  @Test
  fun `deadline returns while hostile read and close both remain blocked`() {
    val provider = boundedTestExecutor("timeout-provider")
    val cleanup = boundedTestExecutor("timeout-cleanup")
    val input = NonCooperativeInputStream()
    val state = activeState(DocumentCleanupDispatcher { action -> cleanup.execute(action) })
    try {
      val startedAt = System.nanoTime()
      val failure = captureFailure {
        awaitBoundedProviderOperation(state, provider, 250) {
          readBoundedUtf8(input, 8, state)
        }
      }
      val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)

      assertEquals(DocumentReadReason.TIMEOUT, failure.reason)
      assertTrue("controller exceeded its independent deadline: ${elapsedMs}ms", elapsedMs < 2_000)
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
  fun `close failure cannot replace the primary read failure`() {
    val primary = IOException("primary read failure")
    val secondary = IOException("secondary close failure")
    val input = object : InputStream() {
      override fun read(): Int = throw primary

      override fun close() {
        throw secondary
      }
    }
    val state = activeState()

    val failure = captureFailure { readBoundedUtf8(input, 8, state) }

    assertEquals(DocumentReadReason.UNAVAILABLE, failure.reason)
    assertSame(primary, failure.cause)
    assertEquals(1, failure.suppressed.size)
    assertSame(secondary, failure.suppressed.single())
  }

  private fun activeState(
    cleanupDispatcher: DocumentCleanupDispatcher = INLINE_CLEANUP,
  ): DocumentReadRequestState =
    DocumentReadRequestState(cleanupDispatcher).also { state -> assertTrue(state.begin()) }

  private fun captureFailure(block: () -> Unit): DocumentReadFailure = try {
    block()
    throw AssertionError("Expected a bounded-document failure")
  } catch (problem: DocumentReadFailure) {
    problem
  }

  private fun executionFailure(block: () -> Any?): DocumentReadFailure = try {
    block()
    throw AssertionError("Expected the worker to fail")
  } catch (problem: ExecutionException) {
    problem.cause as DocumentReadFailure
  }
}

private val INLINE_CLEANUP = DocumentCleanupDispatcher { cleanup -> cleanup() }

private fun boundedTestExecutor(name: String): ThreadPoolExecutor = ThreadPoolExecutor(
  1,
  1,
  0L,
  TimeUnit.MILLISECONDS,
  SynchronousQueue(),
  { runnable -> Thread(runnable, name).apply { isDaemon = true } },
  ThreadPoolExecutor.AbortPolicy(),
)

private fun ignoreInterruptsUntil(release: CountDownLatch) {
  while (!release.await(10, TimeUnit.MILLISECONDS)) {
    Thread.interrupted()
  }
}

private class ChunkedInputStream(
  bytes: ByteArray,
  private val chunkBytes: Int,
) : ByteArrayInputStream(bytes) {
  var closed = false
    private set

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    super.read(buffer, offset, minOf(length, chunkBytes))

  override fun close() {
    closed = true
    super.close()
  }
}

private class BlockingInputStream : InputStream() {
  val entered = CountDownLatch(1)
  private val release = CountDownLatch(1)

  @Volatile
  var closed = false
    private set

  override fun read(): Int {
    entered.countDown()
    release.await()
    throw IOException("provider stream closed")
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int = read()

  override fun close() {
    closed = true
    release.countDown()
  }
}

private class NonCooperativeInputStream : InputStream() {
  val readStarted = CountDownLatch(1)
  val closeStarted = CountDownLatch(1)
  private val releaseLatch = CountDownLatch(1)

  @Volatile
  var released = false
    private set

  override fun read(): Int {
    readStarted.countDown()
    ignoreInterruptsUntil(releaseLatch)
    throw IOException("hostile read released")
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int = read()

  override fun close() {
    closeStarted.countDown()
    ignoreInterruptsUntil(releaseLatch)
  }

  fun release() {
    released = true
    releaseLatch.countDown()
  }
}
