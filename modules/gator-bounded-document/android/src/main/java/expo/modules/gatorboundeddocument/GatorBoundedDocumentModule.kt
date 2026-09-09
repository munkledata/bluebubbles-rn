package expo.modules.gatorboundeddocument

import android.content.ContentResolver
import android.content.res.AssetFileDescriptor
import android.net.Uri
import android.os.CancellationSignal
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

private fun documentThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
  Thread(runnable, name).apply { isDaemon = true }
}

private fun boundedDocumentExecutor(name: String): ThreadPoolExecutor = ThreadPoolExecutor(
  MAX_ACTIVE_DOCUMENT_REQUESTS,
  MAX_ACTIVE_DOCUMENT_REQUESTS,
  0L,
  TimeUnit.MILLISECONDS,
  SynchronousQueue(),
  documentThreadFactory(name),
  ThreadPoolExecutor.AbortPolicy(),
)

/** Android-only hard boundary for reading user-selected backup documents. */
class GatorBoundedDocumentModule : Module() {
  private val requests = ConcurrentHashMap<String, DocumentReadRequestState>()
  private val providerExecutor = boundedDocumentExecutor("gator-document-provider")
  // Provider cleanup is isolated because CancellationSignal.cancel and InputStream.close can both
  // invoke hostile provider code. Its zero-capacity queue bounds abandoned cleanup calls too.
  private val cleanupExecutor = boundedDocumentExecutor("gator-document-cleanup")
  private val cleanupDispatcher = DocumentCleanupDispatcher { cleanup ->
    try {
      cleanupExecutor.execute { runCatching { cleanup() } }
    } catch (_: RejectedExecutionException) {
      // Four hostile cleanup calls may consume the bounded pool. Dropping later best-effort
      // cleanup is safer than running provider code on the bridge or creating unbounded work.
    }
  }

  override fun definition() = ModuleDefinition {
    Name("GatorBoundedDocument")

    Function("prepare") { requestId: String ->
      requireValidRequestId(requestId)
      synchronized(requests) {
        check(requests.size < MAX_ACTIVE_DOCUMENT_REQUESTS) {
          "Too many bounded document reads are already active"
        }
        check(
          requests.putIfAbsent(
            requestId,
            DocumentReadRequestState(cleanupDispatcher),
          ) == null,
        ) {
          "A bounded document read with this request id is already active"
        }
      }
    }

    Function("cancel") { requestId: String ->
      requests[requestId]?.let { state ->
        if (state.cancel()) requests.remove(requestId, state)
      }
    }

    Function("releasePrepared") { requestId: String ->
      requests[requestId]?.let { state ->
        if (state.releasePrepared()) requests.remove(requestId, state)
      }
    }

    AsyncFunction("read") {
        requestId: String,
        rawUri: String,
        maxBytesValue: Double,
        timeoutMsValue: Double,
      ->
      read(requestId, rawUri, maxBytesValue, timeoutMsValue)
    }.runOnQueue(appContext.backgroundCoroutineScope)

    OnDestroy {
      requests.values.forEach { state -> state.cancel() }
      requests.clear()
      providerExecutor.shutdownNow()
      cleanupExecutor.shutdownNow()
    }
  }

  private fun read(
    requestId: String,
    rawUri: String,
    maxBytesValue: Double,
    timeoutMsValue: Double,
  ): Map<String, Any> {
    if (!isValidRequestId(requestId)) return failureOutcome(DocumentReadReason.INVALID)
    val state = requests[requestId] ?: return failureOutcome(DocumentReadReason.CANCELLED)
    if (!state.begin()) {
      requests.remove(requestId, state)
      return failureOutcome(state.abortReason() ?: DocumentReadReason.INVALID)
    }

    try {
      val maxBytes = boundedPositiveLong(maxBytesValue, MAX_DOCUMENT_BYTES)
      val timeoutMs = boundedPositiveLong(timeoutMsValue, MAX_DOCUMENT_TIMEOUT_MS)
      val uri = requireContentUri(rawUri)
      state.throwIfAborted()

      val result = awaitBoundedProviderOperation(state, providerExecutor, timeoutMs) {
        val context = appContext.reactContext
          ?: throw DocumentReadFailure(DocumentReadReason.UNAVAILABLE)
        val input = openDocument(context.contentResolver, uri, state)
        readBoundedUtf8(input, maxBytes, state)
      }
      return successOutcome(result)
    } catch (problem: DocumentReadFailure) {
      return failureOutcome(state.abortReason() ?: problem.reason)
    } catch (_: Exception) {
      return failureOutcome(state.abortReason() ?: DocumentReadReason.UNAVAILABLE)
    } finally {
      requests.remove(requestId, state)
    }
  }

  private fun openDocument(
    resolver: ContentResolver,
    uri: Uri,
    state: DocumentReadRequestState,
  ): InputStream {
    val cancellationSignal = CancellationSignal()
    state.registerProviderOpenCancellation(cancellationSignal) { cancellationSignal.cancel() }
    var descriptor: AssetFileDescriptor? = null
    var streamOwnsDescriptor = false
    try {
      // This cancellation-aware API is the same content-provider stream boundary used by
      // openInputStream, but unlike that convenience method it can abort a provider stalled in
      // open. createInputStream supports regular descriptors and pipe-backed providers without
      // seeking or making a temporary copy.
      descriptor = resolver.openAssetFileDescriptor(uri, "r", cancellationSignal)
        ?: throw DocumentReadFailure(DocumentReadReason.UNAVAILABLE)
      val input = descriptor.createInputStream()
      streamOwnsDescriptor = true
      return input
    } catch (problem: DocumentReadFailure) {
      throw problem
    } catch (_: Exception) {
      // Provider exceptions can include private document names and URIs. Collapse them here.
      throw DocumentReadFailure(state.abortReason() ?: DocumentReadReason.UNAVAILABLE)
    } finally {
      if (!streamOwnsDescriptor) {
        state.unregisterProviderOpenCancellation(cancellationSignal)
        runCatching { descriptor?.close() }
      }
    }
  }

  private fun requireContentUri(rawUri: String): Uri {
    if (rawUri.length > 8_192) throw DocumentReadFailure(DocumentReadReason.INVALID)
    val uri = try {
      Uri.parse(rawUri)
    } catch (_: Exception) {
      throw DocumentReadFailure(DocumentReadReason.INVALID)
    }
    if (
      uri.scheme != ContentResolver.SCHEME_CONTENT ||
      !uri.isHierarchical ||
      uri.authority.isNullOrBlank()
    ) {
      throw DocumentReadFailure(DocumentReadReason.INVALID)
    }
    return uri
  }

  private fun boundedPositiveLong(value: Double, maximum: Long): Long {
    if (!value.isFinite() || value < 1.0 || value > maximum.toDouble() || value % 1.0 != 0.0) {
      throw DocumentReadFailure(DocumentReadReason.INVALID)
    }
    return value.toLong()
  }

  private fun requireValidRequestId(requestId: String) {
    require(isValidRequestId(requestId)) { "Invalid bounded-document request id" }
  }

  private fun isValidRequestId(requestId: String): Boolean =
    requestId.isNotBlank() && requestId.length <= MAX_DOCUMENT_REQUEST_ID_CHARS

  private fun successOutcome(result: BoundedDocumentRead): Map<String, Any> = mapOf(
    "ok" to true,
    "text" to result.text,
    "bytes" to result.bytes.toDouble(),
  )

  private fun failureOutcome(reason: DocumentReadReason): Map<String, Any> = mapOf(
    "ok" to false,
    "reason" to reason.value,
  )
}
