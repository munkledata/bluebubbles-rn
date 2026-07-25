package expo.modules.gatorshareshortcuts

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
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

private const val TAG = "GatorShareShortcuts"

// Our own ceiling. The real limit is the device's getMaxShortcutCountPerActivity() (commonly 10-15);
// we clamp to the smaller of the two rather than hardcoding the old, needlessly small 4.
private const val MAX_SHORTCUTS = 10

// Contact photos are thumbnails already, but decode them down to a sane icon size so a large
// image can't be held as a full-resolution bitmap per shortcut.
private const val ICON_TARGET_PX = 256

/** One conversation to publish as a Direct Share target. */
class ShareShortcutRecord : Record {
  @Field var id: String = ""
  @Field var name: String = ""
  @Field var avatarPath: String? = null
}

/**
 * Publishes the app's recent conversations as long-lived, share-target dynamic shortcuts so they
 * appear in the system share sheet's PRIORITIZED (Direct Share) row, and reports back which target
 * the user tapped so the JS layer can open that exact chat with the shared file staged.
 */
class GatorShareShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorShareShortcuts")

    AsyncFunction("setShareShortcuts") { items: List<ShareShortcutRecord> ->
      val context = appContext.reactContext ?: return@AsyncFunction
      // setDynamicShortcuts THROWS if the list exceeds the device cap, so ask rather than guess.
      val limit = runCatching { ShortcutManagerCompat.getMaxShortcutCountPerActivity(context) }
        .getOrDefault(MAX_SHORTCUTS)
        .coerceIn(1, MAX_SHORTCUTS)

      val shortcuts = items.take(limit).mapNotNull { item ->
        if (item.id.isEmpty()) return@mapNotNull null
        val label = item.name.ifEmpty { "Chat" }
        val icon = loadIcon(context, item.avatarPath)
          ?: IconCompat.createWithResource(context, context.applicationInfo.icon)
        // The People Service reads the PERSON's icon, not only the shortcut's — set both so the
        // chip shows the contact rather than a generic silhouette.
        val person = Person.Builder()
          .setName(label)
          .setKey(item.id)
          .setIcon(icon)
          .build()
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
      // Ends on an `if` (not on runCatching) so the block's value is Unit — an AsyncFunction that
      // returned a Kotlin Result would have no bridge converter.
      val published = runCatching { ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts) }
        .getOrDefault(false)
      if (!published) {
        Log.w(TAG, "share shortcuts were not published (device cap or disabled shortcuts)")
      }
    }

    Function("clearShareShortcuts") {
      // A synchronous Function's block is typed `() -> Any?`, so a bare `return@Function` (which is
      // Unit) won't type-check — use a null-safe let instead of the elvis-return idiom.
      appContext.reactContext?.let { ShortcutManagerCompat.removeAllDynamicShortcuts(it) }
    }

    // Ranking signal: tells Android's People Service which conversations the user actually uses, so
    // the Direct Share row is ordered by real affinity. A no-op for an unpublished id, so it is
    // always safe to call. (Notifications can't carry a matching shortcutId — react-native-notify-kit
    // strips the field — so this is the app's only affinity input.)
    AsyncFunction("reportShortcutUsed") { id: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      if (id.isNotEmpty()) runCatching { ShortcutManagerCompat.reportShortcutUsed(context, id) }
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

  /**
   * A contact avatar → an adaptive icon; null (→ launcher-icon fallback) if missing/undecodable.
   *
   * Must go through the ContentResolver, NOT BitmapFactory.decodeFile: expo-contacts stores the
   * device address book's PHOTO_THUMBNAIL_URI, which is a `content://com.android.contacts/…` uri
   * that decodeFile cannot open — so before this nearly every chip fell back to the app icon. Only
   * server-backfilled avatars (real `file://` paths) ever rendered.
   *
   * `IconCompat.createWithContentUri` is deliberately NOT used: the launcher/share-sheet process
   * would then have to read the contacts provider itself, and our READ_CONTACTS grant doesn't
   * transfer. Decoding in-process and shipping the bitmap is the portable route.
   */
  private fun loadIcon(context: Context, path: String?): IconCompat? {
    if (path.isNullOrEmpty()) return null
    return runCatching {
      val uri = Uri.parse(path)
      val bitmap = when (uri.scheme) {
        "content", "android.resource" -> decodeFromResolver(context, uri)
        // `uri.path` is nullable; fall back to stripping the scheme off the raw string.
        "file" -> BitmapFactory.decodeFile(uri.path ?: path.removePrefix("file://"))
        else -> BitmapFactory.decodeFile(path)
      } ?: return@runCatching null
      IconCompat.createWithAdaptiveBitmap(bitmap)
    }.getOrNull()
  }

  /** Two-pass decode (bounds, then sampled). A content stream can't rewind, so it is reopened. */
  private fun decodeFromResolver(context: Context, uri: Uri): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, bounds)
    } ?: return null
    val largest = maxOf(bounds.outWidth, bounds.outHeight)
    if (largest <= 0) return null
    val opts = BitmapFactory.Options().apply {
      inSampleSize = maxOf(1, largest / ICON_TARGET_PX)
    }
    return context.contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, opts)
    }
  }
}
