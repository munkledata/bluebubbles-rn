package expo.modules.gatorshareshortcuts

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// MUST match plugins/withShareTargets.js SHARE_TARGET_CATEGORY — the <share-target> category and the
// published shortcuts' category have to be identical for Android to surface Direct Share results.
private const val SHARE_CATEGORY = "com.bluegreengatorapps.messages.category.SHARE_TARGET"

// Android caps dynamic shortcuts (~ getMaxShortcutCountPerActivity, usually 4-5); keep it small.
private const val MAX_SHORTCUTS = 4

/** One conversation to publish as a Direct Share target. */
class ShareShortcutRecord : Record {
  @Field var id: String = ""
  @Field var name: String = ""
  @Field var avatarPath: String? = null
}

/**
 * Publishes the app's recent conversations as long-lived, share-target dynamic shortcuts so they
 * appear in the system share sheet's PRIORITIZED (Direct Share) row, and reports back which target
 * the user tapped so the JS layer can open that exact chat with the shared photo staged.
 */
class GatorShareShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorShareShortcuts")

    AsyncFunction("setShareShortcuts") { items: List<ShareShortcutRecord> ->
      val context = appContext.reactContext ?: return@AsyncFunction
      val shortcuts = items.take(MAX_SHORTCUTS).mapNotNull { item ->
        if (item.id.isEmpty()) return@mapNotNull null
        val label = item.name.ifEmpty { "Chat" }
        val icon = loadIcon(item.avatarPath)
          ?: IconCompat.createWithResource(context, context.applicationInfo.icon)
        val person = Person.Builder().setName(item.name).setKey(item.id).build()
        // Direct Share does NOT launch this intent (the shared content is delivered to the
        // share-target activity instead) — but a dynamic shortcut requires a valid intent for the
        // launcher-long-press case, so give it the normal launch intent.
        val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName)
          ?: Intent(Intent.ACTION_MAIN)).setAction(Intent.ACTION_VIEW)
        ShortcutInfoCompat.Builder(context, item.id)
          .setShortLabel(label)
          .setLongLived(true)
          .setCategories(setOf(SHARE_CATEGORY))
          .setPerson(person)
          .setIcon(icon)
          .setIntent(launch)
          .build()
      }
      ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
    }

    Function("clearShareShortcuts") {
      // A synchronous Function's block is typed `() -> Any?`, so a bare `return@Function` (which is
      // Unit) won't type-check — use a null-safe let instead of the elvis-return idiom.
      appContext.reactContext?.let { ShortcutManagerCompat.removeAllDynamicShortcuts(it) }
    }

    // Returns (and consumes) the chat id the user tapped in the Direct Share row, or null for a
    // plain share. Read once per share by the JS navigator to route to that chat.
    Function("getLaunchShortcutId") {
      val id = ShareShortcutStore.pendingShortcutId
      ShareShortcutStore.pendingShortcutId = null
      id
    }

    // App already running: a Direct Share tap arrives via onNewIntent (singleTask). Cold start is
    // handled by GatorShareShortcutsReactActivityLifecycleListener.
    OnNewIntent { intent ->
      val id = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID)
      if (!id.isNullOrEmpty()) {
        ShareShortcutStore.pendingShortcutId = id
        appContext.reactContext?.let { ctx ->
          runCatching { ShortcutManagerCompat.reportShortcutUsed(ctx, id) }
        }
      }
    }
  }

  /** A local avatar file → an adaptive icon; null (→ launcher-icon fallback) if missing/undecodable. */
  private fun loadIcon(path: String?): IconCompat? {
    if (path.isNullOrEmpty()) return null
    val file = path.removePrefix("file://")
    return runCatching {
      val bitmap = BitmapFactory.decodeFile(file) ?: return@runCatching null
      IconCompat.createWithAdaptiveBitmap(bitmap)
    }.getOrNull()
  }
}
