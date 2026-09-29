package expo.modules.gatorshareintake

import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal fun interface ShareCleanupDispatcher {
  /** Enqueue cleanup without ever invoking provider code on the caller. */
  fun dispatch(cleanup: () -> Unit)
}

private data class ShareCleanupHandle(
  val owner: Any,
  val cleanup: () -> Unit,
)

/**
 * One absolute-deadline lease over a provider operation.
 *
 * A hostile provider may ignore interruption and may also block from `cancel` or `close`. The
 * controller therefore owns only a Future, while all provider cancellation/closing is dispatched
 * to a separate bounded executor. A worker that outlives the deadline can never become publishable.
 */
internal class ShareProviderOperationState(
  private val deadlineAtMs: Long,
  private val nowMs: () -> Long,
  private val cleanupDispatcher: ShareCleanupDispatcher,
) {
  private enum class Lifecycle {
    ACTIVE,
    COMPLETED,
    TIMED_OUT,
    FAILED,
  }

  private val lock = Any()
  private var lifecycle = Lifecycle.ACTIVE
  private var providerFuture: Future<*>? = null
  private var cleanupHandle: ShareCleanupHandle? = null

  fun registerFuture(future: Future<*>) {
    val accepted = synchronized(lock) {
      if (lifecycle == Lifecycle.ACTIVE && providerFuture == null) {
        providerFuture = future
        true
      } else {
        false
      }
    }
    if (!accepted) {
      future.cancel(true)
      throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
    }
  }

  fun registerProviderCleanup(owner: Any, cleanup: () -> Unit) {
    val accepted = synchronized(lock) {
      if (lifecycle == Lifecycle.ACTIVE && cleanupHandle == null) {
        cleanupHandle = ShareCleanupHandle(owner, cleanup)
        true
      } else {
        false
      }
    }
    if (!accepted) {
      dispatchCleanup(cleanup)
      throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
    }
  }

  /** Atomically transfers cancellation ownership from provider-open to the returned stream. */
  fun replaceProviderCleanup(
    previousOwner: Any,
    owner: Any,
    cleanup: () -> Unit,
  ) {
    val accepted = synchronized(lock) {
      if (
        lifecycle == Lifecycle.ACTIVE &&
        cleanupHandle?.owner === previousOwner
      ) {
        cleanupHandle = ShareCleanupHandle(owner, cleanup)
        true
      } else {
        false
      }
    }
    if (!accepted) {
      dispatchCleanup(cleanup)
      throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
    }
  }

  fun clearProviderCleanup(owner: Any) {
    synchronized(lock) {
      if (cleanupHandle?.owner === owner) cleanupHandle = null
    }
  }

  /** Removes exact cleanup ownership and closes normally away from the provider worker. */
  fun finishProviderResource(owner: Any, cleanup: () -> Unit) {
    val removed = synchronized(lock) {
      if (cleanupHandle?.owner === owner) {
        cleanupHandle = null
        true
      } else {
        false
      }
    }
    if (removed) dispatchCleanup(cleanup)
  }

  fun dispatchBestEffort(cleanup: () -> Unit) {
    dispatchCleanup(cleanup)
  }

  fun throwIfExpired() {
    if (nowMs() >= deadlineAtMs) {
      timeout()
      throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
    }
    val expired = synchronized(lock) { lifecycle == Lifecycle.TIMED_OUT }
    if (expired) throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
  }

  fun remainingMs(): Long = (deadlineAtMs - nowMs()).coerceAtLeast(0L)

  /** Completion wins only while the absolute deadline is still live. */
  fun complete(): Boolean = synchronized(lock) {
    if (
      lifecycle != Lifecycle.ACTIVE ||
      cleanupHandle != null ||
      nowMs() >= deadlineAtMs
    ) {
      false
    } else {
      lifecycle = Lifecycle.COMPLETED
      providerFuture = null
      cleanupHandle = null
      true
    }
  }

  fun fail() {
    val cleanup = synchronized(lock) {
      if (lifecycle == Lifecycle.ACTIVE) lifecycle = Lifecycle.FAILED
      providerFuture = null
      val ownedCleanup = cleanupHandle?.cleanup
      cleanupHandle = null
      ownedCleanup
    }
    cleanup?.let(::dispatchCleanup)
  }

  fun timeout() {
    var future: Future<*>? = null
    var cleanup: (() -> Unit)? = null
    synchronized(lock) {
      if (lifecycle != Lifecycle.ACTIVE) return
      lifecycle = Lifecycle.TIMED_OUT
      future = providerFuture
      providerFuture = null
      cleanup = cleanupHandle?.cleanup
      cleanupHandle = null
    }
    // Future.cancel does not wait for the worker. Provider callbacks are never run here.
    future?.cancel(true)
    cleanup?.let(::dispatchCleanup)
  }

  private fun dispatchCleanup(cleanup: () -> Unit) {
    runCatching { cleanupDispatcher.dispatch(cleanup) }
  }
}

/** Waits only until the request's absolute deadline, independent of provider cooperation. */
internal fun <T> awaitShareProviderOperation(
  state: ShareProviderOperationState,
  providerExecutor: ExecutorService,
  operation: () -> T,
): T {
  state.throwIfExpired()
  val future = try {
    providerExecutor.submit<T> { operation() }
  } catch (_: RejectedExecutionException) {
    throw ShareIntakeException(ShareIntakeFailure.BUSY)
  }
  state.registerFuture(future)

  try {
    val remaining = state.remainingMs()
    if (remaining <= 0L) throw TimeoutException()
    val result = future.get(remaining, TimeUnit.MILLISECONDS)
    if (!state.complete()) {
      state.timeout()
      throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
    }
    return result
  } catch (_: TimeoutException) {
    state.timeout()
    throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
  } catch (_: CancellationException) {
    throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
  } catch (problem: ExecutionException) {
    state.fail()
    val cause = problem.cause
    if (cause is ShareIntakeException) throw cause
    throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
  } catch (_: InterruptedException) {
    Thread.currentThread().interrupt()
    state.timeout()
    throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
  }
}
