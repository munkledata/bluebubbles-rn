package expo.modules.gatorshareintake

import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

internal interface ShareIntakeListener {
  /** [newShare] is true only for a batch that was just committed, not a reminder that one waits. */
  fun onPending(newShare: Boolean)

  fun onRejected(reason: ShareIntakeFailure)
}

/**
 * Tells JavaScript about shares. Every committed batch signals as new, so the app hears about a
 * newer share even while it still holds an earlier one. The other signals only say a batch is
 * waiting: one found on disk, the next one after a batch settles, and one reminder to a listener
 * added while a batch waits, until a batch settles.
 */
internal class ShareIntakeSignal {
  private val listeners = CopyOnWriteArraySet<ShareIntakeListener>()
  private val waiting = AtomicBoolean(false)

  fun add(listener: ShareIntakeListener) {
    listeners.add(listener)
    if (waiting.get()) runCatching { listener.onPending(newShare = false) }
  }

  fun remove(listener: ShareIntakeListener) {
    listeners.remove(listener)
  }

  /** A complete batch is waiting: [newShare] when it was just committed, else one found on disk. */
  fun pending(newShare: Boolean) {
    waiting.set(true)
    listeners.forEach { listener -> runCatching { listener.onPending(newShare) } }
  }

  /**
   * A batch settled. Forget the old signal before looking for another batch, so a batch committed
   * during the look still leaves the signal set.
   */
  fun settled(anotherBatchWaiting: () -> Boolean) {
    waiting.set(false)
    if (anotherBatchWaiting()) pending(newShare = false)
  }

  fun rejected(reason: ShareIntakeFailure) {
    listeners.forEach { listener -> runCatching { listener.onRejected(reason) } }
  }
}
