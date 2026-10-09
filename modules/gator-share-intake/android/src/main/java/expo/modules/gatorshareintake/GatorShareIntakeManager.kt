package expo.modules.gatorshareintake

import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val MAX_QUEUED_SHARE_BATCHES = 1
private const val MAX_ACTIVE_PROVIDER_WORKERS = 4
private const val MAX_PROVIDER_NAME_CHARS = 512
private const val MAX_CONTENT_URI_CHARS = 8_192
private const val MAX_CONTENT_AUTHORITY_CHARS = 255

internal interface ShareIntakeListener {
  fun onPending()

  fun onRejected(reason: ShareIntakeFailure)
}

private data class ShareInput(
  val uri: Uri,
  val mimeHint: String,
)

private data class PendingShare(
  val applicationContext: Context,
  // Retain the pre-sanitized clip/extras snapshot for the lifetime of provider access.
  val intentAnchor: Intent,
  val batchId: String,
  val receivedAtElapsedMs: Long,
  val receivedAtWallMs: Long,
  val text: String?,
  val targetToken: String?,
  val inputs: List<ShareInput>,
)

private data class ProviderMetadata(
  val input: ShareInput,
  val displayName: String?,
  val declaredSize: Long?,
  val mimeType: String,
)

private data class PreparedShare(
  val manifest: ShareManifest,
  val pendingDirectory: File?,
)

private fun namedThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
  Thread(runnable, name).apply { isDaemon = true }
}

private fun boundedProviderExecutor(name: String): ThreadPoolExecutor = ThreadPoolExecutor(
  MAX_ACTIVE_PROVIDER_WORKERS,
  MAX_ACTIVE_PROVIDER_WORKERS,
  0L,
  TimeUnit.MILLISECONDS,
  SynchronousQueue(),
  namedThreadFactory(name),
  ThreadPoolExecutor.AbortPolicy(),
)

/**
 * Process-owned Android share receiver.
 *
 * Activity hooks feed it before React exists. Only immutable app-private completed manifests cross
 * the JavaScript bridge; raw provider URIs never do.
 */
internal object GatorShareIntakeManager {
  private val initialized = AtomicBoolean(false)
  private val batchSequence = AtomicLong(0L)
  private val listeners = CopyOnWriteArraySet<ShareIntakeListener>()
  private val activePendingBatchIds = ConcurrentHashMap.newKeySet<String>()
  private val lastFailure = AtomicReference<ShareIntakeFailure?>(null)
  private val pendingEventLatched = AtomicBoolean(false)
  private val storageLock = Any()
  private val controller = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(MAX_QUEUED_SHARE_BATCHES),
    namedThreadFactory("gator-share-controller"),
    ThreadPoolExecutor.AbortPolicy(),
  )
  private val providerExecutor = boundedProviderExecutor("gator-share-provider")
  // CancellationSignal.cancel, Cursor.close and InputStream.close can invoke hostile provider code.
  private val cleanupExecutor = boundedProviderExecutor("gator-share-cleanup")
  private val cleanupDispatcher = ShareCleanupDispatcher { cleanup ->
    try {
      cleanupExecutor.execute { runCatching { cleanup() } }
    } catch (_: RejectedExecutionException) {
      // Never move hostile cleanup onto the controller or create an unbounded queue.
    }
  }
  private var applicationContext: Context? = null

  fun initialize(context: Context) {
    applicationContext = context.applicationContext
    if (!initialized.compareAndSet(false, true)) return
    try {
      controller.execute {
        runCatching {
          synchronized(storageLock) {
            storage(context.applicationContext).recoverAndPrune(System.currentTimeMillis())
          }
        }.onFailure { reject(failureReason(it)) }
        signalPendingIfPresent()
      }
    } catch (_: RejectedExecutionException) {
      reject(ShareIntakeFailure.BUSY)
    }
  }

  /** Returns true only when this was an inbound share intent and has been consumed/sanitized. */
  fun accept(context: Context, intent: Intent?): Boolean {
    if (!isShareIntent(intent)) return false
    initialize(context)
    val ownedIntent = checkNotNull(intent)
    if (ownedIntent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
      // Recents may replay the Activity's historical launch intent. It carries no new user share
      // authority and must never create a second batch.
      sanitize(ownedIntent)
      return true
    }
    val pending = try {
      snapshot(context.applicationContext, ownedIntent)
    } catch (error: Exception) {
      sanitize(ownedIntent)
      reject(failureReason(error))
      return true
    }
    // Snapshot and sanitization are deliberately complete before work is queued or this hook
    // returns to Activity lifecycle dispatch.
    sanitize(ownedIntent)
    try {
      controller.execute { process(pending) }
    } catch (_: RejectedExecutionException) {
      reject(ShareIntakeFailure.BUSY)
    }
    return true
  }

  fun isShareIntent(intent: Intent?): Boolean =
    intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

  fun sanitize(intent: Intent) {
    runCatching {
      intent.replaceExtras(null)
      intent.clipData = null
      intent.data = null
      intent.type = null
      intent.flags = 0
      intent.action = Intent.ACTION_MAIN
    }
  }

  fun addListener(listener: ShareIntakeListener) {
    listeners.add(listener)
    if (pendingEventLatched.get()) runCatching { listener.onPending() }
  }

  fun removeListener(listener: ShareIntakeListener) {
    listeners.remove(listener)
  }

  fun consumeLastFailure(): ShareIntakeFailure? {
    val context = applicationContext
    val memory = lastFailure.getAndSet(null)
    if (context == null) return memory
    val persisted = runCatching {
      synchronized(storageLock) { storage(context).consumeRejection() }
    }.getOrNull()
    return memory ?: persisted
  }

  fun takeNext(): ShareManifest? {
    val context = applicationContext ?: return null
    return synchronized(storageLock) {
      storage(context).takeNext(System.currentTimeMillis(), activePendingBatchIds.toSet())
    }
  }

  fun acknowledge(batchId: String): Boolean {
    val context = applicationContext ?: return false
    val acknowledged = synchronized(storageLock) { storage(context).acknowledge(batchId) }
    if (acknowledged) advancePendingEvent()
    return acknowledged
  }

  fun release(batchId: String): Boolean {
    val context = applicationContext ?: return false
    val released = synchronized(storageLock) { storage(context).release(batchId) }
    if (released) advancePendingEvent()
    return released
  }

  fun discard(batchId: String): Boolean {
    val context = applicationContext ?: return false
    val discarded = synchronized(storageLock) { storage(context).discard(batchId) }
    if (discarded) advancePendingEvent()
    return discarded
  }

  fun discardForAccountReset(batchId: String): Boolean {
    val context = applicationContext ?: return false
    val discarded = synchronized(storageLock) { storage(context).discardForAccountReset(batchId) }
    if (discarded) advancePendingEvent()
    return discarded
  }

  fun committedFile(manifest: ShareManifest, file: ShareManifestFile): File {
    val context = applicationContext
      ?: throw IllegalStateException("Share intake is unavailable")
    return synchronized(storageLock) { storage(context).committedFile(manifest, file) }
  }

  private fun snapshot(context: Context, intent: Intent): PendingShare {
    val rawText = runCatching { intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() }
      .getOrElse { throw ShareIntakeException(ShareIntakeFailure.MALFORMED) }
    val text = requireValidSharedText(rawText)
    val mimeHint = resolvedShareMimeType(null, intent.type)
    val uris = linkedMapOf<String, ShareInput>()

    fun add(uri: Uri?) {
      if (uri == null) return
      requireSupportedContentUri(uri)
      requireForeignShareProvider(uri.authority.orEmpty(), context.packageName) { authority ->
        context.packageManager
          .resolveContentProvider(authority, PackageManager.ComponentInfoFlags.of(0))
          ?.packageName
      }
      uris.putIfAbsent(uri.toString(), ShareInput(uri, mimeHint))
      if (uris.size > MAX_SHARED_FILES) throw ShareIntakeException(ShareIntakeFailure.COUNT)
    }

    val clip: ClipData? = runCatching { intent.clipData }
      .getOrElse { throw ShareIntakeException(ShareIntakeFailure.MALFORMED) }
    if (clip != null) {
      if (clip.itemCount > MAX_SHARED_FILES) throw ShareIntakeException(ShareIntakeFailure.COUNT)
      for (index in 0 until clip.itemCount) add(clip.getItemAt(index).uri)
    }

    try {
      if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        val streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        if (streams != null && streams.size > MAX_SHARED_FILES) {
          throw ShareIntakeException(ShareIntakeFailure.COUNT)
        }
        streams?.forEach(::add)
      } else {
        add(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
      }
    } catch (error: ShareIntakeException) {
      throw error
    } catch (_: Exception) {
      throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    }

    if (uris.isNotEmpty() && intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) {
      throw ShareIntakeException(ShareIntakeFailure.PERMISSION)
    }
    if (text == null && uris.isEmpty()) throw ShareIntakeException(ShareIntakeFailure.EMPTY)

    val rawTarget = runCatching { intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID) }.getOrNull()
    // A forged/stale Direct Share target never sinks otherwise-valid content. It becomes generic.
    val target = runCatching { requireValidShareTarget(rawTarget) }.getOrNull()
    val wallNow = System.currentTimeMillis()
    val sequence = batchSequence.incrementAndGet()
    val random = UUID.randomUUID().toString().replace("-", "").take(16)
    return PendingShare(
      applicationContext = context,
      intentAnchor = Intent(intent),
      batchId = "$wallNow-$sequence-$random",
      receivedAtElapsedMs = SystemClock.elapsedRealtime(),
      receivedAtWallMs = wallNow,
      text = text,
      targetToken = target,
      inputs = uris.values.toList(),
    )
  }

  private fun process(pending: PendingShare) {
    val deadlineAt = pending.receivedAtElapsedMs + SHARE_BATCH_TIMEOUT_MS
    val state = ShareProviderOperationState(
      deadlineAtMs = deadlineAt,
      nowMs = SystemClock::elapsedRealtime,
      cleanupDispatcher = cleanupDispatcher,
    )
    check(activePendingBatchIds.add(pending.batchId)) { "Share batch is already active" }
    try {
      val availableBytes = synchronized(storageLock) {
        storage(pending.applicationContext).admissionBudget(
          System.currentTimeMillis(),
          activePendingBatchIds.toSet(),
        )
      }
      val prepared = awaitShareProviderOperation(state, providerExecutor) {
        prepareProviderBatch(pending, availableBytes, state)
      }
      // Provider work is complete and no stale worker can publish. Keep the same absolute deadline
      // for the final bounded native storage transition.
      if (SystemClock.elapsedRealtime() >= deadlineAt) {
        throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
      }
      val committedWithinDeadline = synchronized(storageLock) {
        storage(pending.applicationContext).commitWithinDeadline(
          prepared.manifest,
          prepared.pendingDirectory,
          deadlineAt,
          SystemClock::elapsedRealtime,
        )
      }
      if (!committedWithinDeadline) {
        throw ShareIntakeException(ShareIntakeFailure.DEADLINE)
      }
      signalPending()
    } catch (error: Exception) {
      runCatching {
        synchronized(storageLock) {
          storage(pending.applicationContext).discardUnclaimed(pending.batchId)
        }
      }
      reject(failureReason(error))
    } finally {
      activePendingBatchIds.remove(pending.batchId)
    }
  }

  private fun prepareProviderBatch(
    pending: PendingShare,
    availableBytes: Long,
    state: ShareProviderOperationState,
  ): PreparedShare {
    var pendingDirectory: File? = null
    try {
      state.throwIfExpired()
      // Reading this retained value keeps the pre-sanitized intent snapshot alive across every
      // provider call without exposing it to JavaScript.
      check(
        pending.intentAnchor.action == Intent.ACTION_SEND ||
          pending.intentAnchor.action == Intent.ACTION_SEND_MULTIPLE,
      )
      val metadata = pending.inputs.map { input ->
        queryMetadata(pending.applicationContext.contentResolver, input, state)
      }
      val budget = ShareBatchBudget(
        deadlineAtMs = pending.receivedAtElapsedMs + SHARE_BATCH_TIMEOUT_MS,
        nowMs = SystemClock::elapsedRealtime,
        maxBatchBytes = availableBytes,
      )
      if (metadata.isNotEmpty()) budget.validateDeclaredSizes(metadata.map { it.declaredSize })

      val copied = if (metadata.isEmpty()) {
        emptyList()
      } else {
        val directory = synchronized(storageLock) {
          storage(pending.applicationContext).pendingFilesDirectory(pending.batchId)
        }
        if (directory.exists() || !directory.mkdir()) {
          throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
        }
        pendingDirectory = directory
        metadata.mapIndexed { index, item ->
          copyOne(pending.applicationContext.contentResolver, directory, index, item, budget, state)
        }
      }

      state.throwIfExpired()
      return PreparedShare(
        manifest = ShareManifest(
          batchId = pending.batchId,
          createdAtMs = pending.receivedAtWallMs,
          text = pending.text,
          targetToken = pending.targetToken,
          files = copied,
        ),
        pendingDirectory = pendingDirectory,
      )
    } catch (error: Exception) {
      pendingDirectory?.let { directory ->
        runCatching {
          directory.listFiles()?.forEach { child -> if (child.isFile) child.delete() }
          directory.delete()
        }
      }
      throw error
    }
  }

  private fun queryMetadata(
    resolver: ContentResolver,
    input: ShareInput,
    state: ShareProviderOperationState,
  ): ProviderMetadata {
    state.throwIfExpired()
    val signal = CancellationSignal()
    state.registerProviderCleanup(signal) { signal.cancel() }
    var cursor: Cursor? = null
    try {
      cursor = resolver.query(
        input.uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
        signal,
      )
      if (cursor == null) {
        state.clearProviderCleanup(signal)
      } else {
        val ownedCursor = cursor
        state.replaceProviderCleanup(signal, ownedCursor) { ownedCursor.close() }
      }
      state.throwIfExpired()
      val hasRow = cursor?.moveToFirst() == true
      state.throwIfExpired()
      val name = if (hasRow) {
        cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          .takeIf { it >= 0 }
          ?.let(cursor::getString)
          ?.take(MAX_PROVIDER_NAME_CHARS)
      } else {
        null
      }
      val size = if (hasRow) {
        cursor.getColumnIndex(OpenableColumns.SIZE)
          .takeIf { it >= 0 && !cursor.isNull(it) }
          ?.let(cursor::getLong)
          ?.takeIf { it >= 0L }
      } else {
        null
      }
      val providerMime = runCatching { resolver.getType(input.uri) }.getOrNull()
      state.throwIfExpired()
      return ProviderMetadata(input, name, size, resolvedShareMimeType(providerMime, input.mimeHint))
    } catch (error: ShareIntakeException) {
      throw error
    } catch (_: Exception) {
      state.throwIfExpired()
      throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
    } finally {
      val owned = cursor
      if (owned != null) {
        state.finishProviderResource(owned) { owned.close() }
      } else {
        state.clearProviderCleanup(signal)
      }
    }
  }

  private fun copyOne(
    resolver: ContentResolver,
    directory: File,
    index: Int,
    metadata: ProviderMetadata,
    budget: ShareBatchBudget,
    state: ShareProviderOperationState,
  ): ShareManifestFile {
    state.throwIfExpired()
    val name = sharedFileName(index, metadata.displayName, metadata.mimeType)
    val target = File(directory, name)
    require(target.parentFile?.absolutePath == directory.absolutePath && !target.exists()) {
      "Share destination is not a new owned file"
    }
    val signal = CancellationSignal()
    state.registerProviderCleanup(signal) { signal.cancel() }
    var stream: java.io.InputStream? = null
    try {
      val descriptor = resolver.openAssetFileDescriptor(metadata.input.uri, "r", signal)
        ?: throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
      stream = try {
        descriptor.createInputStream()
      } catch (error: Exception) {
        state.dispatchBestEffort { descriptor.close() }
        throw error
      }
      val ownedStream = stream
      state.replaceProviderCleanup(signal, ownedStream) { ownedStream.close() }
      FileOutputStream(target, false).use { output ->
        val copied = budget.copy(ownedStream, output)
        output.fd.sync()
        state.throwIfExpired()
        if (!target.isFile || target.length() != copied) {
          throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
        }
        return ShareManifestFile(name, metadata.mimeType, copied)
      }
    } catch (error: ShareIntakeException) {
      throw error
    } catch (_: Exception) {
      state.throwIfExpired()
      throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
    } finally {
      val ownedStream = stream
      if (ownedStream != null) {
        state.finishProviderResource(ownedStream) { ownedStream.close() }
      } else {
        state.clearProviderCleanup(signal)
      }
    }
  }

  private fun storage(context: Context): ShareIntakeStorage =
    ShareIntakeStorage(File(context.noBackupFilesDir, SHARE_INPUT_CACHE_DIRECTORY))

  private fun signalPendingIfPresent() {
    val context = applicationContext ?: return
    val present = runCatching {
      synchronized(storageLock) {
        storage(context).hasCompleteBatch(
          System.currentTimeMillis(),
          activePendingBatchIds.toSet(),
        )
      }
    }.getOrDefault(false)
    if (present) signalPending()
  }

  private fun signalPending() {
    if (!pendingEventLatched.compareAndSet(false, true)) return
    listeners.forEach { listener -> runCatching { listener.onPending() } }
  }

  private fun advancePendingEvent() {
    pendingEventLatched.set(false)
    signalPendingIfPresent()
  }

  private fun reject(reason: ShareIntakeFailure) {
    lastFailure.set(reason)
    applicationContext?.let { context ->
      runCatching {
        synchronized(storageLock) { storage(context).recordRejection(reason) }
      }
    }
    listeners.forEach { listener -> runCatching { listener.onRejected(reason) } }
  }

  private fun failureReason(error: Throwable): ShareIntakeFailure =
    (error as? ShareIntakeException)?.reason ?: ShareIntakeFailure.PROVIDER
}

private fun requireSupportedContentUri(uri: Uri) {
  val raw = uri.toString()
  val authority = uri.authority
  if (
    raw.length !in 1..MAX_CONTENT_URI_CHARS ||
    uri.scheme != ContentResolver.SCHEME_CONTENT ||
    !uri.isHierarchical ||
    authority.isNullOrBlank() ||
    authority.length > MAX_CONTENT_AUTHORITY_CHARS
  ) {
    throw ShareIntakeException(ShareIntakeFailure.SCHEME)
  }
}
