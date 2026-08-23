package expo.modules.gatorboundeddownload

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.StatFs
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InterruptedIOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Request

private const val EVENT_PROGRESS = "onProgress"
private const val COPY_BUFFER_BYTES = 64 * 1024
private const val MAX_REQUEST_ID_CHARS = 120
private const val MAX_HEADER_COUNT = 64
private const val MAX_HEADER_CHARS = 16 * 1024
private const val MAX_DOWNLOAD_BYTES = 512L * 1024 * 1024
private const val MAX_TIMEOUT_MS = 15L * 60 * 1000
private const val MAX_ACTIVE_REQUESTS = 8
private const val MAX_IMAGE_PIXELS = 100L * 1024 * 1024
private const val MAX_IMAGE_EDGE = 16_384
private const val PROGRESS_INTERVAL_MS = 100L

private const val REASON_CANCELLED = "cancelled"
private const val REASON_MISSING = "missing"
private const val REASON_NETWORK = "network"
private const val REASON_SIZE = "size"
private const val REASON_TIMEOUT = "timeout"
private const val REASON_UNAVAILABLE = "unavailable"

private class RequestState {
  @Volatile var cancelled = false
  @Volatile var call: Call? = null
}

private class DownloadFailure(val reason: String) : Exception()

/**
 * Android hard boundary for every server-sourced file download.
 *
 * Expo's stock DownloadTask reports progress to JavaScript after native bytes have already been
 * consumed, so a JavaScript callback cannot enforce an actual-byte security limit. This module
 * owns the OkHttp response stream, writes no byte beyond maxBytes, applies OkHttp's whole-call
 * deadline, and exposes synchronous prepare/cancel calls so AbortSignal cancellation cannot race
 * ahead of native request registration.
 */
class GatorBoundedDownloadModule : Module() {
  private val requests = ConcurrentHashMap<String, RequestState>()
  private val destinationOwners = ConcurrentHashMap<String, String>()
  private val syncedBackgroundPruneLock = Any()
  private val attachmentCacheIoLock = Any()
  private var attachmentCacheScanManager: AttachmentCacheScanManager? = null

  override fun definition() = ModuleDefinition {
    Name("GatorBoundedDownload")
    Events(EVENT_PROGRESS)

    Function("prepare") { requestId: String ->
      requireValidRequestId(requestId)
      // Keep the resource cap exact even if two React runtimes/headless callers prepare at once.
      // ConcurrentHashMap makes each operation safe, but size-check + insert still need one lock.
      synchronized(requests) {
        check(requests.size < MAX_ACTIVE_REQUESTS) {
          "Too many bounded downloads are already active"
        }
        check(requests.putIfAbsent(requestId, RequestState()) == null) {
          "A bounded download with this request id is already active"
        }
      }
    }

    Function("cancel") { requestId: String ->
      requests[requestId]?.let { state ->
        state.cancelled = true
        state.call?.cancel()
      }
    }

    Function("releasePrepared") { requestId: String ->
      requests[requestId]?.let { state ->
        if (state.call == null && requests.remove(requestId, state)) {
          state.cancelled = true
        }
      }
    }

    AsyncFunction("download") {
        requestId: String,
        url: String,
        destinationUri: String,
        headers: Map<String, String>,
        maxBytesValue: Double,
        timeoutMsValue: Double,
        maxImagePixelsValue: Double,
      ->
      download(
        requestId,
        url,
        destinationUri,
        headers,
        maxBytesValue,
        timeoutMsValue,
        maxImagePixelsValue,
      )
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("pruneSyncedBackgroundCache") { keepUri: String? ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      // The root is fixed natively: JavaScript cannot redirect this deletion primitive to another
      // app-private directory. A non-null keep URI must resolve to one exact owned media entry.
      val root = File(context.filesDir, SYNCED_BACKGROUND_CACHE_DIRECTORY)
      val keep = keepUri?.let { raw -> ownedSyncedBackgroundCacheEntry(root, raw) }
      val result = synchronized(syncedBackgroundPruneLock) {
        pruneSyncedBackgroundCache(root, keep)
      }
      pruneOutcome(result)
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("deleteSyncedBackgroundCacheFile") { rawUri: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      val root = File(context.filesDir, SYNCED_BACKGROUND_CACHE_DIRECTORY)
      val target = ownedSyncedBackgroundRetirementFile(root, rawUri)
      synchronized(syncedBackgroundPruneLock) {
        when {
          !target.exists() -> false
          !target.isFile -> throw IllegalArgumentException("Synced-background retirement target is not a file")
          target.delete() || !target.exists() -> true
          else -> throw IllegalStateException("Synced-background retirement file could not be deleted")
        }
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("statAttachmentCacheFile") { rawUri: String ->
      val root = File(appContext.persistentFilesDirectory, ATTACHMENT_CACHE_DIRECTORY)
      synchronized(attachmentCacheIoLock) {
        val target = ownedAttachmentCacheFile(root, rawUri)
        val stat = attachmentCacheLstat(target)
        when {
          stat == null -> attachmentCacheStatOutcome(false, 0L)
          !OsConstants.S_ISREG(stat.st_mode) -> {
            throw IllegalArgumentException("Attachment cache target is not a regular file")
          }
          stat.st_size < 0L -> throw IllegalStateException("Attachment cache file has invalid size")
          else -> attachmentCacheStatOutcome(true, stat.st_size)
        }
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("deleteAttachmentCacheFile") { rawUri: String ->
      val root = File(appContext.persistentFilesDirectory, ATTACHMENT_CACHE_DIRECTORY)
      synchronized(attachmentCacheIoLock) {
        val target = ownedAttachmentCacheFile(root, rawUri)
        val before = attachmentCacheLstat(target)
        if (before == null) {
          attachmentCacheDeleteOutcome("missing", 0L)
        } else {
          if (!OsConstants.S_ISREG(before.st_mode)) {
            throw IllegalArgumentException("Attachment cache retirement target is not a regular file")
          }
          require(before.st_size >= 0L) { "Attachment cache retirement file has invalid size" }
          try {
            // `remove(2)` never recursively removes a directory and unlinks a raced symlink rather
            // than following it. The lstat immediately above remains the ordinary type gate.
            Os.remove(target.path)
          } catch (error: ErrnoException) {
            if (error.errno != OsConstants.ENOENT) throw error
          }
          if (attachmentCacheLstat(target) != null) {
            throw IllegalStateException("Attachment cache file still exists after delete")
          }
          attachmentCacheDeleteOutcome("deleted", before.st_size)
        }
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("getAttachmentCacheAvailableBytes") {
      val available = StatFs(appContext.persistentFilesDirectory.path).availableBytes
      require(available >= 0L) { "Attachment cache available bytes are invalid" }
      mapOf("ok" to true, "availableBytes" to available.toDouble())
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("beginAttachmentCacheScan") {
      requireBoundedDirectoryStreamSupport()
      synchronized(attachmentCacheIoLock) {
        val scanId = getAttachmentCacheScanManager().begin()
        mapOf("ok" to true, "scanId" to scanId)
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("nextAttachmentCacheScanPage") { scanId: String ->
      requireBoundedDirectoryStreamSupport()
      synchronized(attachmentCacheIoLock) {
        attachmentCacheScanPageOutcome(getAttachmentCacheScanManager().next(scanId))
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("closeAttachmentCacheScan") { scanId: String ->
      // Close is deliberately idempotent: callers can always put it in `finally`, including after
      // native already closed a completed, expired, corrupt, or overflowing session.
      val closed = synchronized(attachmentCacheIoLock) {
        attachmentCacheScanManager?.close(scanId) ?: false
      }
      mapOf("ok" to true, "closed" to closed)
    }.runOnQueue(appContext.backgroundCoroutineScope)

    OnDestroy {
      requests.values.forEach { state ->
        state.cancelled = true
        state.call?.cancel()
      }
      requests.clear()
      destinationOwners.clear()
      synchronized(attachmentCacheIoLock) {
        attachmentCacheScanManager?.closeActive()
        attachmentCacheScanManager = null
      }
    }
  }

  private fun download(
    requestId: String,
    url: String,
    destinationUri: String,
    headers: Map<String, String>,
    maxBytesValue: Double,
    timeoutMsValue: Double,
    maxImagePixelsValue: Double,
  ): Map<String, Any> {
    val state = requests[requestId] ?: return outcomeFailure(REASON_CANCELLED)
    var destination: File? = null
    var destinationKey: String? = null
    var keepFile = false
    try {
      requireValidRequestId(requestId)
      val maxBytes = boundedPositiveLong(maxBytesValue, MAX_DOWNLOAD_BYTES)
      val timeoutMs = boundedPositiveLong(timeoutMsValue, MAX_TIMEOUT_MS)
      val maxImagePixels = boundedOptionalLong(maxImagePixelsValue, MAX_IMAGE_PIXELS)
      validateHeaders(headers)
      val context = appContext.reactContext ?: throw DownloadFailure(REASON_UNAVAILABLE)
      val target = ownedDestination(context, destinationUri)
      if (destinationOwners.putIfAbsent(target.path, requestId) != null) {
        throw DownloadFailure(REASON_UNAVAILABLE)
      }
      // Publish cleanup ownership only after the destination lock succeeds. A rejected duplicate
      // must never delete the first request's active file from its `finally` block.
      destination = target
      destinationKey = target.path
      if (state.cancelled) throw DownloadFailure(REASON_CANCELLED)

      target.parentFile?.let { parent ->
        if (!parent.exists() && !parent.mkdirs()) throw DownloadFailure(REASON_UNAVAILABLE)
      }
      if (target.exists() && !target.delete()) throw DownloadFailure(REASON_UNAVAILABLE)

      val requestBuilder = Request.Builder().url(url)
      headers.forEach { (name, value) -> requestBuilder.addHeader(name, value) }
      val client = appContext.okHttpClient.newBuilder()
        // A call deadline spans DNS/connect/headers AND every response-body read. The JS timer is
        // defense in depth; this native timeout is what releases a blocked InputStream.
        .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
      val call = client.newCall(requestBuilder.build())
      state.call = call
      if (state.cancelled) call.cancel()

      val response = call.execute()
      response.use { current ->
        if (state.cancelled) throw DownloadFailure(REASON_CANCELLED)
        if (current.code == 404 || current.code == 410) throw DownloadFailure(REASON_MISSING)
        if (!current.isSuccessful) throw DownloadFailure(REASON_NETWORK)
        val body = current.body ?: throw DownloadFailure(REASON_MISSING)
        val declaredBytes = body.contentLength()
        if (declaredBytes > maxBytes) throw DownloadFailure(REASON_SIZE)
        if (declaredBytes == 0L) throw DownloadFailure(REASON_MISSING)

        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        var total = 0L
        var lastProgressAt = 0L
        BufferedInputStream(body.byteStream(), COPY_BUFFER_BYTES).use { input ->
          FileOutputStream(target, false).use { output ->
            val buffer = ByteArray(COPY_BUFFER_BYTES)
            while (true) {
              if (state.cancelled) throw DownloadFailure(REASON_CANCELLED)
              if (SystemClock.elapsedRealtime() >= deadline) {
                call.cancel()
                throw DownloadFailure(REASON_TIMEOUT)
              }
              // Read at most the remaining allowance plus one sentinel byte. An oversized body is
              // detected natively before that sentinel is ever written to disk.
              val remaining = maxBytes - total
              val readLimit = minOf(buffer.size.toLong(), remaining + 1L).toInt()
              val read = input.read(buffer, 0, readLimit)
              if (read < 0) break
              if (read == 0) continue
              if (read.toLong() > remaining) {
                call.cancel()
                throw DownloadFailure(REASON_SIZE)
              }
              output.write(buffer, 0, read)
              total += read.toLong()
              val now = SystemClock.elapsedRealtime()
              if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                emitProgress(requestId, total, declaredBytes)
                lastProgressAt = now
              }
            }
            output.flush()
            output.fd.sync()
          }
        }
        if (state.cancelled) throw DownloadFailure(REASON_CANCELLED)
        if (total <= 0L || total > maxBytes || !target.exists() || target.length() != total) {
          throw DownloadFailure(REASON_SIZE)
        }
        if (maxImagePixels > 0L) validateImageBounds(target, maxImagePixels)
        emitProgress(requestId, total, declaredBytes)
        keepFile = true
        return outcomeSuccess(total)
      }
    } catch (problem: DownloadFailure) {
      return outcomeFailure(problem.reason)
    } catch (_: InterruptedIOException) {
      return outcomeFailure(if (state.cancelled) REASON_CANCELLED else REASON_TIMEOUT)
    } catch (_: Exception) {
      return outcomeFailure(if (state.cancelled) REASON_CANCELLED else REASON_NETWORK)
    } finally {
      state.call = null
      requests.remove(requestId, state)
      destinationKey?.let { key -> destinationOwners.remove(key, requestId) }
      if (!keepFile) destination?.delete()
    }
  }

  private fun emitProgress(requestId: String, loaded: Long, total: Long) {
    sendEvent(
      EVENT_PROGRESS,
      Bundle().apply {
        putString("requestId", requestId)
        putDouble("loaded", loaded.toDouble())
        putDouble("total", total.toDouble())
      },
    )
  }

  private fun requireValidRequestId(requestId: String) {
    require(requestId.isNotBlank() && requestId.length <= MAX_REQUEST_ID_CHARS) {
      "Invalid bounded-download request id"
    }
  }

  private fun boundedPositiveLong(value: Double, maximum: Long): Long {
    if (!value.isFinite() || value < 1.0 || value > maximum.toDouble() || value % 1.0 != 0.0) {
      throw DownloadFailure(REASON_UNAVAILABLE)
    }
    return value.toLong()
  }

  private fun boundedOptionalLong(value: Double, maximum: Long): Long {
    if (value == 0.0) return 0L
    return boundedPositiveLong(value, maximum)
  }

  /** Decode image metadata only; never allocate the remote bitmap before enforcing its bounds. */
  private fun validateImageBounds(file: File, maxPixels: Long) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
      throw DownloadFailure(REASON_SIZE)
    }
    if (width.toLong() * height.toLong() > maxPixels) throw DownloadFailure(REASON_SIZE)
  }

  private fun validateHeaders(headers: Map<String, String>) {
    if (headers.size > MAX_HEADER_COUNT) throw DownloadFailure(REASON_UNAVAILABLE)
    var chars = 0
    headers.forEach { (name, value) ->
      chars += name.length + value.length
      if (chars > MAX_HEADER_CHARS) throw DownloadFailure(REASON_UNAVAILABLE)
    }
  }

  /** Accept only canonical files under this app's private files/cache roots. */
  private fun ownedDestination(context: Context, rawUri: String): File {
    val uri = Uri.parse(rawUri)
    if (uri.scheme != "file") throw DownloadFailure(REASON_UNAVAILABLE)
    val rawPath = uri.path ?: throw DownloadFailure(REASON_UNAVAILABLE)
    val destination = File(rawPath).canonicalFile
    val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile)
    val owned = roots.any { root -> destination.path.startsWith(root.path + File.separator) }
    if (!owned) throw DownloadFailure(REASON_UNAVAILABLE)
    return destination
  }

  /** Accept only one canonical generation-N/media-*.jpg entry under the fixed cache root. */
  private fun ownedSyncedBackgroundCacheEntry(root: File, rawUri: String): File {
    val uri = Uri.parse(rawUri)
    require(uri.scheme == "file") { "Invalid synced-background cache URI" }
    val rawPath = uri.path ?: throw IllegalArgumentException("Missing synced-background path")
    return requireOwnedSyncedBackgroundEntry(root, File(rawPath))
  }

  /**
   * Resolve a DB-provided old-wallpaper URI without allowing URL normalization to change its
   * meaning. Exact round-tripping rejects encoded separators, fragments, queries, authorities,
   * and alternate path spellings before the non-recursive delete above can run.
   */
  private fun ownedSyncedBackgroundRetirementFile(root: File, rawUri: String): File {
    val uri = Uri.parse(rawUri)
    require(
      uri.scheme == "file" &&
        uri.authority.isNullOrEmpty() &&
        uri.query == null &&
        uri.fragment == null,
    ) { "Invalid synced-background retirement URI" }
    val rawPath = uri.path ?: throw IllegalArgumentException("Missing synced-background path")
    val target = requireOwnedSyncedBackgroundRetirementPath(root, File(rawPath))
    require(Uri.fromFile(target).toString() == rawUri) {
      "Synced-background retirement URI is not canonical"
    }
    return target
  }

  /** Resolve only an exact canonical file URI beneath the native-fixed attachment cache root. */
  private fun ownedAttachmentCacheFile(root: File, rawUri: String): File {
    val uri = Uri.parse(rawUri)
    require(
      uri.scheme == "file" &&
        uri.authority.isNullOrEmpty() &&
        uri.query == null &&
        uri.fragment == null,
    ) { "Invalid attachment cache URI" }
    val rawPath = uri.path ?: throw IllegalArgumentException("Missing attachment cache path")
    val target = requireOwnedAttachmentCachePath(root, File(rawPath))
    require(Uri.fromFile(target).toString() == rawUri) {
      "Attachment cache URI is not canonical"
    }
    return target
  }

  /** lstat keeps a last-moment symlink swap from being followed; ENOENT is an idempotent miss. */
  private fun attachmentCacheLstat(target: File): StructStat? = try {
    Os.lstat(target.path)
  } catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) null else throw error
  }

  /**
   * Android's streaming `DirectoryStream` API begins at API 26. Falling back to `File.listFiles`
   * on API 24/25 would allocate an attacker-amplifiable array before the native page cap applies,
   * so those versions fail closed instead.
   */
  private fun requireBoundedDirectoryStreamSupport() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      throw UnsupportedOperationException(
        "Bounded attachment cache scanning requires Android 8.0 or newer",
      )
    }
  }

  @Suppress("NewApi")
  private fun getAttachmentCacheScanManager(): AttachmentCacheScanManager {
    attachmentCacheScanManager?.let { return it }
    return AttachmentCacheScanManager(
      root = File(appContext.persistentFilesDirectory, ATTACHMENT_CACHE_DIRECTORY),
      fileSystem = NioAttachmentCacheFileSystem(),
      nowMs = SystemClock::elapsedRealtime,
    ).also { manager -> attachmentCacheScanManager = manager }
  }

  private fun outcomeSuccess(bytes: Long): Map<String, Any> = mapOf(
    "ok" to true,
    "bytes" to bytes.toDouble(),
  )

  private fun outcomeFailure(reason: String): Map<String, Any> = mapOf(
    "ok" to false,
    "reason" to reason,
  )

  private fun pruneOutcome(result: SyncedBackgroundPruneResult): Map<String, Any> = mapOf(
    "ok" to true,
    "withinQuota" to result.withinQuota,
    "deletedFiles" to result.deletedFiles.toDouble(),
    "deletedBytes" to result.deletedBytes.toDouble(),
    "remainingFiles" to result.remainingFiles.toDouble(),
    "remainingBytes" to result.remainingBytes.toDouble(),
  )

  private fun attachmentCacheStatOutcome(exists: Boolean, bytes: Long): Map<String, Any> = mapOf(
    "ok" to true,
    "exists" to exists,
    "bytes" to bytes.toDouble(),
  )

  private fun attachmentCacheDeleteOutcome(status: String, bytes: Long): Map<String, Any> = mapOf(
    "ok" to true,
    "status" to status,
    "bytes" to bytes.toDouble(),
  )

  private fun attachmentCacheScanPageOutcome(
    page: AttachmentCacheScanPage,
  ): Map<String, Any> = mapOf(
    "ok" to true,
    "done" to page.done,
    "overflow" to false,
    "files" to page.files.map { entry ->
      mapOf(
        "uri" to Uri.fromFile(entry.file).toString(),
        "bytes" to entry.bytes.toDouble(),
        "mtimeMs" to entry.modifiedAtMs.toDouble(),
      )
    },
  )
}
