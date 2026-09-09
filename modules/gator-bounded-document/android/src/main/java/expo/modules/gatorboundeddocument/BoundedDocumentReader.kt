package expo.modules.gatorboundeddocument

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal const val MAX_DOCUMENT_BYTES = 6L * 1024 * 1024
internal const val MAX_DOCUMENT_TIMEOUT_MS = 30_000L
internal const val MAX_DOCUMENT_REQUEST_ID_CHARS = 120
internal const val MAX_ACTIVE_DOCUMENT_REQUESTS = 4

private const val READ_BUFFER_BYTES = 64 * 1024

internal enum class DocumentReadReason(val value: String) {
  CANCELLED("cancelled"),
  INVALID("invalid"),
  SIZE("size"),
  TIMEOUT("timeout"),
  UNAVAILABLE("unavailable"),
}

internal class DocumentReadFailure(
  val reason: DocumentReadReason,
  cause: Throwable? = null,
) : Exception(null, cause)

internal data class BoundedDocumentRead(
  val text: String,
  val bytes: Long,
)

internal fun interface DocumentCleanupDispatcher {
  /** Must enqueue cleanup without running provider code on the caller. */
  fun dispatch(cleanup: () -> Unit)
}

private data class DocumentCleanupHandle(
  val owner: Any,
  val cleanup: () -> Unit,
)

/**
 * One synchronously prepared document-read lease.
 *
 * Cancellation and timeout wake the waiting controller immediately, then dispatch provider-open
 * cancellation or active-stream closing to a separate bounded executor. Merely interrupting a
 * coroutine does not reliably release a blocked content-provider call, while running provider
 * cleanup inline could freeze the bridge itself.
 */
internal class DocumentReadRequestState(
  private val cleanupDispatcher: DocumentCleanupDispatcher,
) {
  private enum class Lifecycle {
    PREPARED,
    ACTIVE,
    COMPLETED,
    CANCELLED,
    TIMED_OUT,
  }

  private val lock = Any()
  private var lifecycle = Lifecycle.PREPARED
  private var providerFuture: Future<*>? = null
  private var cleanupHandle: DocumentCleanupHandle? = null

  fun begin(): Boolean = synchronized(lock) {
    if (lifecycle != Lifecycle.PREPARED) {
      false
    } else {
      lifecycle = Lifecycle.ACTIVE
      true
    }
  }

  /** Returns true when a prepared-only registry entry can be removed immediately. */
  fun cancel(): Boolean = abort(Lifecycle.CANCELLED)

  fun timeout() {
    abort(Lifecycle.TIMED_OUT)
  }

  /** Returns true only when no read ever started. */
  fun releasePrepared(): Boolean = synchronized(lock) {
    if (lifecycle != Lifecycle.PREPARED) {
      false
    } else {
      lifecycle = Lifecycle.CANCELLED
      true
    }
  }

  /** Installs Android's provider-open cancellation before any provider code is invoked. */
  fun registerProviderOpenCancellation(owner: Any, cancel: () -> Unit) {
    val failure = synchronized(lock) {
      when {
        lifecycle == Lifecycle.CANCELLED -> DocumentReadReason.CANCELLED
        lifecycle == Lifecycle.TIMED_OUT -> DocumentReadReason.TIMEOUT
        lifecycle != Lifecycle.ACTIVE || cleanupHandle != null -> {
          DocumentReadReason.INVALID
        }
        else -> {
          cleanupHandle = DocumentCleanupHandle(owner, cancel)
          null
        }
      }
    }
    if (failure != null) {
      dispatchCleanup(cancel)
      throw DocumentReadFailure(failure)
    }
  }

  fun unregisterProviderOpenCancellation(owner: Any) {
    synchronized(lock) {
      if (cleanupHandle?.owner === owner) cleanupHandle = null
    }
  }

  fun registerFuture(future: Future<*>) {
    val failure = synchronized(lock) {
      when {
        lifecycle == Lifecycle.CANCELLED -> DocumentReadReason.CANCELLED
        lifecycle == Lifecycle.TIMED_OUT -> DocumentReadReason.TIMEOUT
        lifecycle != Lifecycle.ACTIVE || providerFuture != null -> DocumentReadReason.INVALID
        else -> {
          providerFuture = future
          null
        }
      }
    }
    if (failure != null) {
      future.cancel(true)
      throw DocumentReadFailure(failure)
    }
  }

  fun register(stream: InputStream) {
    val failure = synchronized(lock) {
      when {
        lifecycle == Lifecycle.CANCELLED -> DocumentReadReason.CANCELLED
        lifecycle == Lifecycle.TIMED_OUT -> DocumentReadReason.TIMEOUT
        lifecycle != Lifecycle.ACTIVE || cleanupHandle?.owner is InputStream -> {
          DocumentReadReason.INVALID
        }
        else -> {
          // The provider has returned. From this exact state transition onward cancellation owns
          // the stream rather than the provider-open CancellationSignal.
          cleanupHandle = DocumentCleanupHandle(stream) { stream.close() }
          null
        }
      }
    }
    if (failure != null) {
      dispatchCleanup { stream.close() }
      throw DocumentReadFailure(failure)
    }
  }

  fun unregister(stream: InputStream) {
    synchronized(lock) {
      if (cleanupHandle?.owner === stream) cleanupHandle = null
    }
  }

  fun throwIfAborted() {
    abortReason()?.let { reason -> throw DocumentReadFailure(reason) }
  }

  fun abortReason(): DocumentReadReason? = synchronized(lock) {
    when (lifecycle) {
      Lifecycle.CANCELLED -> DocumentReadReason.CANCELLED
      Lifecycle.TIMED_OUT -> DocumentReadReason.TIMEOUT
      else -> null
    }
  }

  /** Completion wins only if cancellation/timeout did not already win the race. */
  fun complete(): Boolean = synchronized(lock) {
    if (lifecycle != Lifecycle.ACTIVE) {
      false
    } else {
      lifecycle = Lifecycle.COMPLETED
      providerFuture = null
      cleanupHandle = null
      true
    }
  }

  private fun abort(reason: Lifecycle): Boolean {
    var future: Future<*>? = null
    var cleanup: (() -> Unit)? = null
    val preparedOnly = synchronized(lock) {
      when (lifecycle) {
        Lifecycle.PREPARED -> {
          lifecycle = reason
          true
        }
        Lifecycle.ACTIVE -> {
          lifecycle = reason
          future = providerFuture
          providerFuture = null
          cleanup = cleanupHandle?.cleanup
          cleanupHandle = null
          false
        }
        Lifecycle.COMPLETED,
        Lifecycle.CANCELLED,
        Lifecycle.TIMED_OUT,
        -> false
      }
    }
    // Future.cancel is non-blocking and promptly wakes a controller waiting in Future.get. The
    // provider's own cancel/close callback is always dispatched away from this caller because a
    // hostile provider may block forever even while being closed.
    future?.cancel(true)
    cleanup?.let(::dispatchCleanup)
    return preparedOnly
  }

  private fun dispatchCleanup(cleanup: () -> Unit) {
    runCatching { cleanupDispatcher.dispatch(cleanup) }
  }
}

/**
 * Runs provider work on a bounded executor and waits on its Future, never on provider cleanup.
 *
 * A timed-out worker may ignore interruption and remain occupied, but it cannot hold this
 * controller past timeout. A SynchronousQueue-backed executor bounds abandoned workers and rejects
 * later work instead of accumulating an unbounded queue.
 */
internal fun <T> awaitBoundedProviderOperation(
  state: DocumentReadRequestState,
  providerExecutor: ExecutorService,
  timeoutMs: Long,
  operation: () -> T,
): T {
  val future = try {
    providerExecutor.submit<T> { operation() }
  } catch (_: RejectedExecutionException) {
    throw DocumentReadFailure(DocumentReadReason.UNAVAILABLE)
  }
  state.registerFuture(future)

  try {
    val result = future.get(timeoutMs, TimeUnit.MILLISECONDS)
    if (!state.complete()) {
      throw DocumentReadFailure(state.abortReason() ?: DocumentReadReason.INVALID)
    }
    return result
  } catch (_: TimeoutException) {
    state.timeout()
    throw DocumentReadFailure(state.abortReason() ?: DocumentReadReason.TIMEOUT)
  } catch (_: CancellationException) {
    throw DocumentReadFailure(state.abortReason() ?: DocumentReadReason.CANCELLED)
  } catch (problem: ExecutionException) {
    state.abortReason()?.let { reason -> throw DocumentReadFailure(reason) }
    val cause = problem.cause
    if (cause is DocumentReadFailure) throw cause
    throw DocumentReadFailure(DocumentReadReason.UNAVAILABLE)
  } catch (_: InterruptedException) {
    Thread.currentThread().interrupt()
    state.cancel()
    throw DocumentReadFailure(state.abortReason() ?: DocumentReadReason.CANCELLED)
  }
}

/**
 * Reads at most maxBytes from a generic stream and decodes it as strict UTF-8.
 *
 * The extra read is a one-byte sentinel: an input exactly at the limit is valid only after EOF is
 * observed, while max+1 is rejected before the extra byte is retained in memory.
 */
internal fun readBoundedUtf8(
  input: InputStream,
  maxBytes: Long,
  state: DocumentReadRequestState,
): BoundedDocumentRead {
  if (maxBytes <= 0L || maxBytes > MAX_DOCUMENT_BYTES) {
    throw DocumentReadFailure(DocumentReadReason.INVALID)
  }

  var primaryFailure: DocumentReadFailure? = null
  try {
    state.register(input)
    val output = ByteArrayOutputStream(minOf(maxBytes, READ_BUFFER_BYTES.toLong()).toInt())
    val buffer = ByteArray(READ_BUFFER_BYTES)
    var total = 0L

    while (true) {
      state.throwIfAborted()
      val remaining = maxBytes - total
      val readLimit = minOf(buffer.size.toLong(), remaining + 1L).toInt()
      val count = input.read(buffer, 0, readLimit)
      state.throwIfAborted()
      if (count < 0) break
      if (count == 0) {
        Thread.yield()
        continue
      }
      if (count.toLong() > remaining) {
        throw DocumentReadFailure(DocumentReadReason.SIZE)
      }
      output.write(buffer, 0, count)
      total += count.toLong()
    }

    state.throwIfAborted()
    val text = strictUtf8(output.toByteArray())
    state.throwIfAborted()
    return BoundedDocumentRead(text = text, bytes = total)
  } catch (problem: Exception) {
    val mapped = mapReadFailure(problem, state)
    primaryFailure = mapped
    throw mapped
  } finally {
    state.unregister(input)
    try {
      input.close()
    } catch (closeFailure: Exception) {
      if (primaryFailure != null) {
        primaryFailure.addSuppressed(closeFailure)
      } else {
        throw mapReadFailure(closeFailure, state)
      }
    }
  }
}

private fun strictUtf8(bytes: ByteArray): String = try {
  StandardCharsets.UTF_8
    .newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
    .decode(ByteBuffer.wrap(bytes))
    .toString()
} catch (problem: CharacterCodingException) {
  throw DocumentReadFailure(DocumentReadReason.INVALID, problem)
}

private fun mapReadFailure(
  problem: Exception,
  state: DocumentReadRequestState,
): DocumentReadFailure {
  state.abortReason()?.let { reason ->
    return if (problem is DocumentReadFailure && problem.reason == reason) {
      problem
    } else {
      DocumentReadFailure(reason, problem)
    }
  }
  return if (problem is DocumentReadFailure) {
    problem
  } else {
    DocumentReadFailure(DocumentReadReason.UNAVAILABLE, problem)
  }
}
