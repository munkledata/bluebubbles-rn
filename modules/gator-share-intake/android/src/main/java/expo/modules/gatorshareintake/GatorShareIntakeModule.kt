package expo.modules.gatorshareintake

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val EVENT_PENDING = "onPending"
private const val EVENT_REJECTED = "onRejected"

/** Thin bridge over the process-owned receiver; it never accepts a provider URI from JavaScript. */
class GatorShareIntakeModule : Module(), ShareIntakeListener {
  override fun definition() = ModuleDefinition {
    Name("GatorShareIntake")
    Events(EVENT_PENDING, EVENT_REJECTED)

    OnCreate {
      val context = checkNotNull(appContext.reactContext) { "Android context is unavailable" }
      GatorShareIntakeManager.initialize(context)
      GatorShareIntakeManager.addListener(this@GatorShareIntakeModule)
    }

    OnDestroy {
      GatorShareIntakeManager.removeListener(this@GatorShareIntakeModule)
    }

    AsyncFunction("takeNext") {
      GatorShareIntakeManager.takeNext()?.let(::bridgeManifest)
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("acknowledge") { batchId: String ->
      check(GatorShareIntakeManager.acknowledge(batchId)) {
        "Share batch could not be acknowledged"
      }
      true
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("release") { batchId: String ->
      check(GatorShareIntakeManager.release(batchId)) { "Share batch could not be released" }
      true
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("discard") { batchId: String ->
      check(GatorShareIntakeManager.discard(batchId)) { "Share batch could not be discarded" }
      true
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("discardForAccountReset") { batchId: String ->
      check(GatorShareIntakeManager.discardForAccountReset(batchId)) {
        "Account-bound share batch could not be discarded"
      }
      true
    }.runOnQueue(appContext.backgroundCoroutineScope)

    Function("takeLastError") {
      GatorShareIntakeManager.consumeLastFailure()?.name?.lowercase()
    }
  }

  override fun onPending() {
    sendEvent(EVENT_PENDING, emptyMap<String, Any>())
  }

  override fun onRejected(reason: ShareIntakeFailure) {
    sendEvent(EVENT_REJECTED, mapOf("reason" to reason.name.lowercase()))
  }

  private fun bridgeManifest(manifest: ShareManifest): Map<String, Any?> = mapOf(
    "batchId" to manifest.batchId,
    "createdAtMs" to manifest.createdAtMs.toDouble(),
    "text" to manifest.text,
    "targetToken" to manifest.targetToken,
    "files" to manifest.files.map { file ->
      val owned = GatorShareIntakeManager.committedFile(manifest, file)
      mapOf(
        "uri" to Uri.fromFile(owned).toString(),
        "name" to file.name.substringAfter('-', file.name),
        "mimeType" to file.mimeType,
        "size" to file.size.toDouble(),
      )
    },
  )
}
