package expo.modules.gatorpasteinput

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputContentInfo
import android.widget.EditText
import androidx.annotation.RequiresApi
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val EVENT_PASTE = "onPaste"

/** Batch directories live here, under the app's private cache. */
private const val CACHE_DIR = "pasted-in"

// Accept everything — a paste is as likely to be a PDF as a screenshot.
//
// MUST be enumerated by top-level type rather than the obvious catch-all wildcard. AOSP's
// View.setOnReceiveContentListener hard-rejects any entry starting with a star
// (Preconditions.checkArgument(!mimeType.startsWith("*"), "A MIME type set here must not start
// with *")), so the catch-all throws at attach time and paste silently stays broken — a wildcard
// is legal in the SUBTYPE only. This is the OPPOSITE of the manifest <share-target> in
// plugins/withShareTargets.js, which does take the literal catch-all; unrelated APIs, opposite
// rules. Listing every IANA top-level type is the real equivalent of "everything".
//
// (Line comments, not KDoc: a block comment containing the catch-all wildcard would be
// terminated early by the star-slash inside it.)
private val ACCEPTED_MIME_TYPES = arrayOf(
  "image/*",
  "video/*",
  "audio/*",
  "text/*",
  "application/*",
  "font/*",
  "model/*",
  "multipart/*",
  "message/*",
)

private const val DEFAULT_MIME = "application/octet-stream"
private const val MAX_NAME_LENGTH = 100
private const val MAX_RAW_NAME_LENGTH = 512
private const val MAX_MIME_LENGTH = 120
private const val MAX_QUEUED_BATCHES = 1

// AndroidX stores the API 25-30 permission token here after requestPermission(). API 31+ instead
// ties the grant to a hidden InputContentInfo field on the framework ContentInfo object, so the
// lease below must also keep the original ContentInfoCompat (and its platform object) strongly
// reachable until the worker finishes.
private const val EXTRA_INPUT_CONTENT_INFO = "androidx.core.view.extra.INPUT_CONTENT_INFO"

private data class PendingPasteBatch(
  val context: Context,
  val tag: Int,
  val uris: List<Uri>,
  val mimeHint: String?,
  val receivedAtElapsedMs: Long,
  val receivedAtWallMs: Long,
  val permission: PermissionLease,
)

private data class ProviderMetadata(
  val uri: Uri,
  val displayName: String?,
  val mimeType: String,
  val reportedSize: Long?,
)

private data class CopiedPasteFile(
  val name: String,
  val mimeType: String,
  val size: Long,
)

private class PermissionLease(
  anchor: ContentInfoCompat,
  private val releaseAction: (() -> Unit)?,
) {
  private val released = AtomicBoolean(false)
  private val contentAnchor = AtomicReference<ContentInfoCompat?>(anchor)

  fun release() {
    if (!released.compareAndSet(false, true)) return
    runCatching { releaseAction?.invoke() }
    contentAnchor.getAndSet(null)
  }
}

@RequiresApi(25)
private object InputPermissionApi25 {
  @Suppress("DEPRECATION")
  fun capture(payload: ContentInfoCompat): PermissionLease {
    val info = payload.extras?.getParcelable(EXTRA_INPUT_CONTENT_INFO) as? InputContentInfo
    return if (info == null) {
      PermissionLease(payload, null)
    } else {
      PermissionLease(payload) { info.releasePermission() }
    }
  }
}

/** Cancels provider queries and closes the active stream when the one batch deadline fires. */
private class PasteBatchDeadline(
  val deadlineAtMs: Long,
  scheduler: ScheduledExecutorService,
) : Closeable {
  val cancellationSignal = CancellationSignal()
  private val expired = AtomicBoolean(false)
  private val activeStream = AtomicReference<Closeable?>(null)
  private val timeout = scheduler.schedule(
    { abort() },
    maxOf(0L, deadlineAtMs - SystemClock.elapsedRealtime()),
    TimeUnit.MILLISECONDS,
  )

  fun register(stream: Closeable) {
    check(activeStream.compareAndSet(null, stream)) { "paste stream already active" }
    if (expired.get()) {
      activeStream.compareAndSet(stream, null)
      runCatching { stream.close() }
      throw PasteBatchException(PasteBatchFailure.DEADLINE)
    }
  }

  fun unregister(stream: Closeable) {
    activeStream.compareAndSet(stream, null)
  }

  fun throwIfExpired() {
    if (expired.get() || SystemClock.elapsedRealtime() >= deadlineAtMs) {
      abort()
      throw PasteBatchException(PasteBatchFailure.DEADLINE)
    }
  }

  fun abort() {
    if (expired.compareAndSet(false, true)) {
      cancellationSignal.cancel()
      activeStream.getAndSet(null)?.let { stream -> runCatching { stream.close() } }
    }
  }

  fun isExpired(): Boolean = expired.get()

  override fun close() {
    timeout.cancel(false)
    activeStream.set(null)
  }
}

private fun namedThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
  Thread(runnable, name).apply { isDaemon = true }
}

/**
 * Makes the chat composer accept pasted pictures and files.
 *
 * WHY THIS MODULE EXISTS: React Native's `ReactEditText` never declares that it accepts rich
 * content — it neither calls `EditorInfoCompat.setContentMimeTypes` (so Gboard refuses to insert
 * an image/GIF/sticker: "this app doesn't support image insertion here") nor handles a URI-bearing
 * clip. Worse, `ReactEditText.onTextContextMenuItem` rewrites every `android.R.id.paste` into
 * `pasteAsPlainText`, so the system's long-press Paste coerces an image to text and drops a raw
 * `content://…` string into the input.
 *
 * THE FIX IS ONE CALL ON THE VIEW RN ALREADY CREATED — no fork, no subclass, no custom
 * ViewManager. `ReactEditText` extends androidx's `AppCompatEditText`, which ALREADY contains the
 * whole receive-content implementation (the `setContentMimeTypes` + `InputConnectionCompat`
 * wiring on API ≤30, and `AppCompatReceiveContentHelper`, which intercepts both `paste` AND
 * `pasteAsPlainText` — so RN's rewrite still routes here). It is simply dormant until a listener
 * is registered. On API 31+ the framework `TextView` does the same natively. Registering
 * `ViewCompat.setOnReceiveContentListener` therefore lights up long-press Paste, keyboard
 * image/GIF/sticker commits, and drag-and-drop at once, for any MIME type.
 *
 * See the JS half in `src/services/paste/pasteInput.ts` + `pastePayload.ts`.
 */
class GatorPasteInputModule : Module() {
  private val destroyed = AtomicBoolean(false)
  private val cleanupScheduled = AtomicBoolean(false)
  private val batchSequence = AtomicLong(0L)
  private val outstandingPermissions = ConcurrentHashMap.newKeySet<PermissionLease>()
  private val activeDeadline = AtomicReference<PasteBatchDeadline?>(null)
  private val protectedPastePaths = AtomicReference<Set<String>?>(null)
  private val worker = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(MAX_QUEUED_BATCHES),
    namedThreadFactory("gator-paste-worker"),
    ThreadPoolExecutor.AbortPolicy(),
  )
  private val deadlineScheduler = Executors.newSingleThreadScheduledExecutor(
    namedThreadFactory("gator-paste-deadline"),
  )

  override fun definition() = ModuleDefinition {
    Name("GatorPasteInput")

    Events(EVENT_PASTE)

    // `tag` is the input's React tag, from `findNodeHandle(ref)`. It MUST be passed as a plain Int:
    // Expo's ref converter reads `nativeTag`, but RN 0.86's Fabric public instances expose
    // `__nativeTag`, so handing over the ref object itself silently resolves to nothing.
    //
    // Runs on the MAIN queue because `AppContext.findView` is annotated `@UiThread` (it resolves
    // through the UIManager's mounting layer).
    AsyncFunction("attach") { tag: Int, protectedUris: List<String> ->
      val view = appContext.findView<EditText>(tag)
      // Ends on an `if` (never on `runCatching`) so the block's value is Unit — the bridge has no
      // converter for a Kotlin `Result`.
      if (view != null) {
        val pasteRoot = File(view.context.cacheDir, CACHE_DIR)
        val protectionSnapshot = resolveProtectedPastePaths(pasteRoot, protectedUris)
        attach(view, tag, protectionSnapshot)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { tag: Int ->
      val view = appContext.findView<EditText>(tag)
      if (view != null) {
        runCatching {
          ViewCompat.setOnReceiveContentListener(view, null, null)
        }.onFailure { android.util.Log.w("GatorPasteInput", "detach failed") }
      }
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      destroyed.set(true)
      activeDeadline.getAndSet(null)?.abort()
      worker.shutdownNow()
      deadlineScheduler.shutdownNow()
      outstandingPermissions.forEach { it.release() }
      outstandingPermissions.clear()
      protectedPastePaths.set(null)
    }
  }

  private fun attach(view: EditText, tag: Int, protectionSnapshot: Set<String>) {
    runCatching {
      protectedPastePaths.set(protectionSnapshot)
      // Re-registering simply replaces the previous listener, so this is idempotent and needs no
      // "already attached" bookkeeping.
      ViewCompat.setOnReceiveContentListener(view, ACCEPTED_MIME_TYPES) { _, payload ->
        onReceive(view.context, payload, tag)
      }
      // `contentMimeTypes` is only read when the input connection is CREATED. Without this, a
      // field that is already focused when we attach keeps advertising plain-text-only until the
      // user defocuses and returns — i.e. the Gboard image chip stays greyed out on first open.
      val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.restartInput(view)
      scheduleStartupCleanup(view.context.applicationContext, protectionSnapshot)
    }.onFailure { android.util.Log.w("GatorPasteInput", "attach failed") }
  }

  /**
   * Handle one paste/commit/drop.
   *
   * Returns the NON-uri remainder so ordinary text paste keeps working through the platform's
   * default handling; the URI items are consumed here and must not be returned, or the default
   * listener would `coerceToText` them into a `content://…` string in the input.
   *
   * No provider call happens here. AndroidX already requested the temporary keyboard grant and
   * placed its `InputContentInfo` token in the payload extras; retaining that token keeps the grant
   * alive while one bounded worker performs metadata queries and streaming. We release it in the
   * worker's `finally` block. Count is rejected before that worker can touch a provider.
   */
  private fun onReceive(context: Context, payload: ContentInfoCompat, tag: Int): ContentInfoCompat? {
    val split = payload.partition { item -> item.uri != null }
    val withUris = split.first
    val remaining = split.second
    if (withUris == null) return remaining

    val clip = withUris.clip
    val count = clip.itemCount
    // Anchor the ORIGINAL payload, not the partition copy. On API 31+ its hidden framework
    // InputContentInfo owns the temporary IME grant while the queued worker is still copying.
    val permission = capturePermissionLease(payload)
    if (count !in 1..MAX_PASTED_FILES) {
      permission.release()
      emitRejected(tag, maxOf(count, 1))
      return remaining
    }

    // URI extraction is in-memory ClipData access, not a provider read. `withUris` came from a
    // URI predicate, but fail the whole batch if a malformed item contradicts that partition.
    val uris = (0 until count).mapNotNull { index -> clip.getItemAt(index)?.uri }
    if (uris.size != count || uris.any { !isSupportedPasteUriScheme(it.scheme) }) {
      permission.release()
      emitRejected(tag, count)
      return remaining
    }
    val batch = PendingPasteBatch(
      context = context.applicationContext,
      tag = tag,
      uris = uris,
      mimeHint = exactSingleItemMimeHint(withUris),
      receivedAtElapsedMs = SystemClock.elapsedRealtime(),
      receivedAtWallMs = System.currentTimeMillis(),
      permission = permission,
    )
    submit(batch)
    return remaining
  }

  private fun submit(batch: PendingPasteBatch) {
    outstandingPermissions.add(batch.permission)
    try {
      worker.execute {
        var committed: CommittedPasteBatch<CopiedPasteFile>? = null
        try {
          if (destroyed.get()) return@execute
          val result = processBatch(batch)
          committed = result
          // `processBatch` closes its deadline after the atomic rename. Re-check the original
          // absolute deadline immediately before publishing so queue/copy/fsync/rename time all
          // belong to one user-visible batch budget.
          val deadlineAtMs = batch.receivedAtElapsedMs + PASTE_BATCH_TIMEOUT_MS
          requirePasteDeadline(SystemClock.elapsedRealtime(), deadlineAtMs)
          if (destroyed.get()) {
            deleteCommittedBatchBestEffort(result.directory)
          } else if (!emitCommitted(batch.tag, result, deadlineAtMs)) {
            deleteCommittedBatchBestEffort(result.directory)
            emitRejected(batch.tag, batch.uris.size)
          }
        } catch (problem: PasteBatchException) {
          android.util.Log.w("GatorPasteInput", "paste batch rejected")
          committed?.directory?.let(::deleteCommittedBatchBestEffort)
          if (!destroyed.get()) emitRejected(batch.tag, batch.uris.size)
        } catch (problem: Exception) {
          // Provider messages may contain sensitive document names/uris; log only the class.
          android.util.Log.w("GatorPasteInput", "paste batch failed")
          committed?.directory?.let(::deleteCommittedBatchBestEffort)
          if (!destroyed.get()) emitRejected(batch.tag, batch.uris.size)
        } finally {
          outstandingPermissions.remove(batch.permission)
          batch.permission.release()
        }
      }
    } catch (_: RejectedExecutionException) {
      outstandingPermissions.remove(batch.permission)
      batch.permission.release()
      emitRejected(batch.tag, batch.uris.size)
    }
  }

  private fun processBatch(batch: PendingPasteBatch): CommittedPasteBatch<CopiedPasteFile> {
    val deadlineAt = batch.receivedAtElapsedMs + PASTE_BATCH_TIMEOUT_MS
    val deadline = PasteBatchDeadline(deadlineAt, deadlineScheduler)
    check(activeDeadline.compareAndSet(null, deadline)) { "paste deadline already active" }
    try {
      deadline.throwIfExpired()
      val root = File(batch.context.cacheDir, CACHE_DIR)
      // The serialized worker makes this reservation exact: a queued batch measures again only
      // after the prior batch has either committed or removed every partial. Reject cache pressure
      // before querying/opening any provider, then pass the remaining GLOBAL bytes into the same
      // actual-stream budget that enforces the per-batch limit.
      val protectionSnapshot = protectedPastePaths.get()
        ?: throw PasteBatchException(PasteBatchFailure.CACHE_QUOTA)
      val cacheStats = inspectPasteCacheRoot(
        root,
        System.currentTimeMillis(),
        protectionSnapshot,
      )
      val cacheAllowance = availablePasteBatchBytes(cacheStats)
      deadline.throwIfExpired()
      val budget = PasteBatchBudget(
        deadlineAtMs = deadlineAt,
        nowMs = SystemClock::elapsedRealtime,
        maxBatchBytes = cacheAllowance,
      )
      val resolver = batch.context.contentResolver
      val metadata = ArrayList<ProviderMetadata>(batch.uris.size)
      batch.uris.forEach { uri ->
        val item = queryMetadata(resolver, uri, batch.mimeHint, deadline, budget)
        // Stop touching subsequent providers as soon as one declaration breaks either cap.
        budget.validateReportedSize(item.reportedSize)
        metadata.add(item)
      }
      deadline.throwIfExpired()

      val batchId = "${batch.receivedAtWallMs}-${batchSequence.incrementAndGet()}"
      val usedNames = HashSet<String>()
      return createAtomicPasteBatch(root, batchId, metadata.size) { pendingDirectory ->
        val files = metadata.mapIndexed { index, item ->
          val baseName = safeSegment(item.displayName, index, item.mimeType)
          val name = uniqueName(usedNames, baseName)
          copyToCache(resolver, item, pendingDirectory, name, budget, deadline)
        }
        deadline.throwIfExpired()
        budget.checkDeadline()
        files
      }
    } catch (problem: Exception) {
      if (deadline.isExpired() && problem !is PasteBatchException) {
        throw PasteBatchException(PasteBatchFailure.DEADLINE)
      }
      throw problem
    } finally {
      activeDeadline.compareAndSet(deadline, null)
      deadline.close()
    }
  }

  private fun queryMetadata(
    resolver: ContentResolver,
    uri: Uri,
    mimeHint: String?,
    deadline: PasteBatchDeadline,
    budget: PasteBatchBudget,
  ): ProviderMetadata {
    budget.checkDeadline()
    var displayName: String? = null
    var reportedSize: Long? = null
    try {
      resolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
        deadline.cancellationSignal,
      )?.use { cursor ->
        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (cursor.moveToFirst()) {
          if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
            displayName = cursor.getString(nameColumn)?.take(MAX_RAW_NAME_LENGTH)
          }
          if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
            reportedSize = cursor.getLong(sizeColumn).takeIf { it >= 0L }
          }
        }
      }
    } catch (_: Exception) {
      deadline.throwIfExpired()
      // Metadata is optional. The actual stream and mandatory final stat remain authoritative.
    }
    budget.checkDeadline()
    val mimeType = mimeForExtension(displayName)
      ?: mimeForExtension(uri.lastPathSegment)
      ?: safeMimeType(mimeHint)
      ?: DEFAULT_MIME
    return ProviderMetadata(uri, displayName, mimeType, reportedSize)
  }

  private fun copyToCache(
    resolver: ContentResolver,
    metadata: ProviderMetadata,
    batchDir: File,
    name: String,
    budget: PasteBatchBudget,
    deadline: PasteBatchDeadline,
  ): CopiedPasteFile {
    deadline.throwIfExpired()
    budget.checkDeadline()
    val destination = File(batchDir, name)
    val descriptor = resolver.openAssetFileDescriptor(
      metadata.uri,
      "r",
      deadline.cancellationSignal,
    ) ?: throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
    val copied = descriptor.use { asset ->
      val input = asset.createInputStream()
      input.use { stream ->
        deadline.register(stream)
        try {
          FileOutputStream(destination, false).use { output ->
            val bytes = budget.copy(stream, output)
            output.fd.sync()
            bytes
          }
        } finally {
          deadline.unregister(stream)
        }
      }
    }
    deadline.throwIfExpired()
    budget.checkDeadline()
    val length = destination.length()
    if (!destination.exists() || copied <= 0L || length != copied) {
      throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
    }
    return CopiedPasteFile(name, metadata.mimeType, copied)
  }

  private fun emitCommitted(
    tag: Int,
    batch: CommittedPasteBatch<CopiedPasteFile>,
    deadlineAtMs: Long,
  ): Boolean = runCatching {
    val files = ArrayList<Bundle>(batch.items.size)
    batch.items.forEach { item ->
      val file = File(batch.directory, item.name)
      if (!file.exists() || file.length() != item.size) {
        throw PasteBatchException(PasteBatchFailure.UNAVAILABLE)
      }
      files.add(Bundle().apply {
        putString("uri", Uri.fromFile(file).toString())
        putString("name", item.name)
        putString("mimeType", item.mimeType)
        putDouble("size", item.size.toDouble())
      })
    }
    // Re-stat/bundle construction above is also part of the absolute batch budget. Keep this
    // check immediately adjacent to publication so post-rename expiry fails visibly and cleans up.
    requirePasteDeadline(SystemClock.elapsedRealtime(), deadlineAtMs)
    sendEvent(EVENT_PASTE, Bundle().apply {
      putInt("tag", tag)
      putParcelableArrayList("files", files)
      putInt("dropped", 0)
    })
    true
  }.getOrDefault(false)

  private fun emitRejected(tag: Int, count: Int) {
    runCatching {
      sendEvent(EVENT_PASTE, Bundle().apply {
        putInt("tag", tag)
        putParcelableArrayList("files", arrayListOf<Bundle>())
        putInt("dropped", maxOf(count, 1))
      })
    }
  }

  private fun deleteCommittedBatchBestEffort(directory: File) {
    runCatching { deleteOwnedPasteBatchDirectory(directory, allowEmpty = true) }
      .onFailure {
        android.util.Log.w("GatorPasteInput", "paste committed-batch cleanup failed")
      }
  }

  private fun capturePermissionLease(payload: ContentInfoCompat): PermissionLease {
    return if (Build.VERSION.SDK_INT >= 25) {
      InputPermissionApi25.capture(payload)
    } else {
      PermissionLease(payload, null)
    }
  }

  private fun exactSingleItemMimeHint(payload: ContentInfoCompat): String? {
    if (payload.clip.itemCount != 1) return null
    val description = payload.clip.description
    for (index in 0 until description.mimeTypeCount) {
      safeMimeType(description.getMimeType(index))?.let { return it }
    }
    return null
  }

  private fun scheduleStartupCleanup(context: Context, protectionSnapshot: Set<String>) {
    if (destroyed.get() || !cleanupScheduled.compareAndSet(false, true)) return
    try {
      worker.execute {
        runCatching {
          inspectPasteCacheRoot(
            File(context.cacheDir, CACHE_DIR),
            System.currentTimeMillis(),
            protectionSnapshot,
          )
        }.onFailure { android.util.Log.w("GatorPasteInput", "paste cache cleanup failed") }
      }
    } catch (_: RejectedExecutionException) {
      cleanupScheduled.set(false)
      // Every actual paste retries this cleanup inside its serialized worker job.
    }
  }

  /** Convert an all-or-none DB URI snapshot into exact canonical paths used by native cleanup. */
  private fun resolveProtectedPastePaths(root: File, rawUris: List<String>): Set<String> {
    require(rawUris.size <= MAX_PROTECTED_PASTE_PATHS) {
      "Too many protected pasted attachments"
    }
    return rawUris.mapTo(LinkedHashSet(rawUris.size)) { rawUri ->
      require(rawUri.isNotEmpty() && rawUri.length <= MAX_PROTECTED_PASTE_URI_CHARS) {
        "Invalid protected pasted attachment URI"
      }
      val uri = Uri.parse(rawUri)
      require(
        uri.scheme == "file" &&
          uri.authority.isNullOrEmpty() &&
          uri.query == null &&
          uri.fragment == null,
      ) { "Invalid protected pasted attachment URI" }
      val rawPath = uri.path
        ?: throw IllegalArgumentException("Protected pasted attachment URI has no path")
      val canonicalPath = ownedPasteReferencePath(root, File(rawPath))
        ?: throw IllegalArgumentException("Protected pasted attachment URI is outside the cache")
      require(Uri.fromFile(File(canonicalPath)).toString() == rawUri) {
        "Protected pasted attachment URI is not canonical"
      }
      canonicalPath
    }
  }

  private fun safeMimeType(raw: String?): String? {
    val value = raw?.trim() ?: return null
    if (value.isEmpty() || value.length > MAX_MIME_LENGTH) return null
    return if (MIME_PATTERN.matches(value)) value.lowercase() else null
  }

  /**
   * A display name reduced to one safe path segment that always carries an extension.
   *
   * Stripping everything up to the last separator and then every leading dot makes traversal
   * (`../../x`) and hidden-file names structurally impossible, not merely filtered.
   */
  private fun safeSegment(raw: String?, index: Int, mimeType: String): String {
    val base = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base
      .filter { it.code in 0x20..0x7e && it !in "/\\:*?\"<>|" }
      .trim()
      .trimStart('.')
      .trim()
    var name = if (cleaned.isEmpty()) "pasted-$index" else cleaned
    if (name.length > MAX_NAME_LENGTH) name = name.take(MAX_NAME_LENGTH)
    if (extensionOf(name).isEmpty()) {
      name = "$name.${extensionForMime(mimeType)}"
    }
    return name
  }

  /** Keep two files pasted in the same batch from colliding on one display name. */
  private fun uniqueName(used: MutableSet<String>, name: String): String {
    if (used.add(name)) return name
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    for (i in 1 until 100) {
      val candidate = "$stem-$i$ext"
      if (used.add(candidate)) return candidate
    }
    return "$stem-${System.nanoTime()}$ext".also { used.add(it) }
  }

  private fun extensionOf(name: String): String {
    val dot = name.lastIndexOf('.')
    if (dot <= 0 || dot == name.length - 1) return ""
    val ext = name.substring(dot + 1)
    return if (ext.matches(Regex("^[A-Za-z0-9]{1,8}$"))) ext.lowercase() else ""
  }

  /** A filename extension for a MIME type, without the dot. Always returns something. */
  private fun extensionForMime(mimeType: String): String {
    MIME_TO_EXT[mimeType.lowercase().trim()]?.let { return it }
    // e.g. 'image/svg+xml' → 'svg'. Anything that isn't a plain short token (including
    // 'octet-stream', whose hyphen fails the test) falls back to 'bin'.
    val subtype = mimeType.lowercase().substringAfter('/', "").substringBefore(';')
    val candidate = subtype.substringBefore('+')
    return if (candidate.matches(Regex("^[a-z0-9]{1,8}$"))) candidate else "bin"
  }

  private fun mimeForExtension(name: String?): String? {
    val ext = extensionOf(name ?: "")
    if (ext.isEmpty()) return null
    return MIME_TO_EXT.entries.firstOrNull { it.value == ext }?.key
  }

  private companion object {
    val MIME_PATTERN = Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+*-]+$")

    /** Mirrors the table in `src/services/share/shareIntentPayload.ts`. */
    val MIME_TO_EXT = mapOf(
      "application/pdf" to "pdf",
      "application/zip" to "zip",
      "text/plain" to "txt",
      "text/csv" to "csv",
      "text/vcard" to "vcf",
      "image/jpeg" to "jpg",
      "image/png" to "png",
      "image/gif" to "gif",
      "image/webp" to "webp",
      "image/heic" to "heic",
      "video/mp4" to "mp4",
      "video/quicktime" to "mov",
      "audio/mpeg" to "mp3",
      "audio/mp4" to "m4a",
    )
  }
}
