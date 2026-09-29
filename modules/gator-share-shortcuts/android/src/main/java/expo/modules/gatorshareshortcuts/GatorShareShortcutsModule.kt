package expo.modules.gatorshareshortcuts

import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.atomic.AtomicLong

internal const val RETIRED_SHORTCUT_LABEL = "Gator"
internal const val RETIRED_SHORTCUT_DISABLED_MESSAGE = "This shortcut is no longer available"
private const val RETIRED_SHORTCUT_PERSON_KEY = "gator-retired-shortcut"
private const val RETIRED_SHORTCUT_LOCUS_ID = "gator-retired-shortcut"
internal const val RETIRED_SHORTCUT_CATEGORY =
  "com.bluegreengatorapps.messages.category.RETIRED_SHORTCUT"
internal const val CURRENT_SHARE_SHORTCUT_PREFIX = "gator-share-v2-"
internal const val CURRENT_SHARE_SHORTCUT_CATEGORY =
  "com.bluegreengatorapps.messages.category.SHARE_TARGET"
private const val RETIRED_SHORTCUT_MARKER_KEY = "gator.retired"
private const val RETIRED_SHORTCUT_MARKER_VALUE = "1"
private const val MAX_PUBLISHED_SHORTCUTS = 10
private const val MAX_SHORTCUT_LABEL_CHARS = 80
private val LEGACY_SHORTCUT_MATCH_FLAGS =
  ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or
    ShortcutManagerCompat.FLAG_MATCH_CACHED or
    ShortcutManagerCompat.FLAG_MATCH_PINNED

internal data class RetiredShortcutSpec(
  val id: String,
  val shortLabel: String = RETIRED_SHORTCUT_LABEL,
  val longLabel: String = RETIRED_SHORTCUT_LABEL,
  val disabledMessage: String = RETIRED_SHORTCUT_DISABLED_MESSAGE,
  val personName: String = RETIRED_SHORTCUT_LABEL,
  val personKey: String = RETIRED_SHORTCUT_PERSON_KEY,
  val locusId: String = RETIRED_SHORTCUT_LOCUS_ID,
)

internal data class LegacyShortcutState(
  val id: String,
  val isDynamic: Boolean,
  val isCached: Boolean,
  val isPinned: Boolean,
  val isEnabled: Boolean,
  val shortLabel: String,
  val longLabel: String?,
  val disabledMessage: String?,
  val categories: Set<String>,
  val retirementMarker: String?,
  val locusId: String?,
  val intentIsGeneric: Boolean,
) {
  fun hasRetiredMetadata(): Boolean =
    shortLabel == RETIRED_SHORTCUT_LABEL &&
      longLabel == RETIRED_SHORTCUT_LABEL &&
      disabledMessage == RETIRED_SHORTCUT_DISABLED_MESSAGE &&
      categories == setOf(RETIRED_SHORTCUT_CATEGORY) &&
      retirementMarker == RETIRED_SHORTCUT_MARKER_VALUE &&
      locusId == RETIRED_SHORTCUT_LOCUS_ID &&
      intentIsGeneric
}

/** Narrow seam that keeps cleanup ordering and failure behavior JVM-testable without Robolectric. */
internal interface LegacyShortcutStore {
  fun list(): List<LegacyShortcutState>

  fun replacePinnedWithRetiredMetadata(replacements: List<RetiredShortcutSpec>): Boolean

  fun disablePinned(ids: List<String>)

  fun removeDynamic(ids: List<String>)

  fun removeLongLived(ids: List<String>)
}

/**
 * Scrub private pinned metadata before disabling it, then remove every removable copy.
 *
 * Android does not let an app delete a user-pinned launcher shortcut. A pinned copy can outlive
 * removal of the dynamic Direct Share row, so disabling alone would leave the old conversation
 * name/photo visible. Any rejected native operation or stale postcondition throws; the JavaScript
 * caller then keeps account replacement blocked instead of accepting an unproved cleanup.
 */
internal fun clearLegacyShareShortcuts(store: LegacyShortcutStore) {
  clearShareShortcutSubset(store) { id -> !id.startsWith(CURRENT_SHARE_SHORTCUT_PREFIX) }
}

internal fun clearCurrentShareShortcuts(store: LegacyShortcutStore) {
  clearShareShortcutSubset(store) { id -> id.startsWith(CURRENT_SHARE_SHORTCUT_PREFIX) }
}

/** Retire only current-namespace rows that the next publication will not refresh. */
internal fun clearStaleCurrentShareShortcuts(
  store: LegacyShortcutStore,
  retainedIds: Set<String>,
) {
  clearShareShortcutSubset(store) { id ->
    id.startsWith(CURRENT_SHARE_SHORTCUT_PREFIX) && id !in retainedIds
  }
}

internal data class ShareShortcutSpec(
  val guid: String,
  val label: String,
)

/** Expo bridge input. Conversation identities never become Android shortcut ids or intent extras. */
class ShareShortcutRecord : Record {
  @Field
  var guid: String = ""

  @Field
  var label: String = ""
}

internal fun normalizeShareShortcutSpecs(records: List<ShareShortcutRecord>): List<ShareShortcutSpec> {
  require(records.size <= MAX_PUBLISHED_SHORTCUTS) { "Too many Direct Share shortcuts" }
  val seen = mutableSetOf<String>()
  return records.map { record ->
    val guid = record.guid.trim()
    val label = record.label.trim()
    require(guid.isNotEmpty() && guid.toByteArray().size <= 1024) {
      "Invalid Direct Share conversation identity"
    }
    require(
      label.isNotEmpty() && label.codePointCount(0, label.length) <= MAX_SHORTCUT_LABEL_CHARS,
    ) {
      "Invalid Direct Share label"
    }
    require(seen.add(guid)) { "Duplicate Direct Share conversation identity" }
    ShareShortcutSpec(guid, label)
  }
}

private fun clearShareShortcutSubset(
  store: LegacyShortcutStore,
  ownsId: (String) -> Boolean,
) {
  val before = store.list().filter { ownsId(it.id) }
  val allIds = before.map { it.id }.distinct()
  val pinned = before.filter { it.isPinned }
  val replacements = pinned
    .filter { it.isEnabled || !it.hasRetiredMetadata() }
    .map { RetiredShortcutSpec(it.id) }
    .distinctBy { it.id }

  if (replacements.isNotEmpty()) {
    check(store.replacePinnedWithRetiredMetadata(replacements)) {
      val suffix = if (replacements.size == 1) "" else "s"
      "Direct Share cleanup could not replace ${replacements.size} pinned shortcut$suffix"
    }
  }

  val enabledPinnedIds = pinned.filter { it.isEnabled }.map { it.id }.distinct()
  if (enabledPinnedIds.isNotEmpty()) store.disablePinned(enabledPinnedIds)

  val dynamicIds = before.filter { it.isDynamic }.map { it.id }.distinct()
  if (dynamicIds.isNotEmpty()) store.removeDynamic(dynamicIds)
  if (allIds.isNotEmpty()) store.removeLongLived(allIds)

  val unsafe = store.list()
    .filter { ownsId(it.id) }
    .filter { current ->
      current.isDynamic ||
        current.isCached ||
        (current.isPinned && (current.isEnabled || !current.hasRetiredMetadata()))
    }
  check(unsafe.isEmpty()) {
    val suffix = if (unsafe.size == 1) "" else "s"
    "Direct Share shortcut cleanup left ${unsafe.size} unsafe persisted shortcut$suffix"
  }
}

private class AndroidLegacyShortcutStore(private val context: Context) : LegacyShortcutStore {
  override fun list(): List<LegacyShortcutState> = ShortcutManagerCompat.getShortcuts(
    context,
    LEGACY_SHORTCUT_MATCH_FLAGS,
  ).map { shortcut ->
    val intent = shortcut.intent
    val targetPackage = intent.component?.packageName ?: intent.`package`
    LegacyShortcutState(
      id = shortcut.id,
      isDynamic = shortcut.isDynamic,
      isCached = shortcut.isCached,
      isPinned = shortcut.isPinned,
      isEnabled = shortcut.isEnabled,
      shortLabel = shortcut.shortLabel.toString(),
      longLabel = shortcut.longLabel?.toString(),
      disabledMessage = shortcut.disabledMessage?.toString(),
      categories = shortcut.categories?.toSet().orEmpty(),
      retirementMarker = shortcut.extras?.getString(RETIRED_SHORTCUT_MARKER_KEY),
      locusId = shortcut.locusId?.id,
      intentIsGeneric =
        intent.action == Intent.ACTION_VIEW &&
          targetPackage == context.packageName &&
          intent.data == null &&
          intent.clipData == null &&
          intent.categories.isNullOrEmpty() &&
          (intent.extras == null || intent.extras?.isEmpty == true),
    )
  }

  override fun replacePinnedWithRetiredMetadata(
    replacements: List<RetiredShortcutSpec>,
  ): Boolean {
    val appIcon = IconCompat.createWithResource(context, context.applicationInfo.icon)
    val launchComponent = context.packageManager
      .getLaunchIntentForPackage(context.packageName)
      ?.component
    val launchIntent = Intent(Intent.ACTION_VIEW).apply {
      setPackage(context.packageName)
      if (launchComponent != null) component = launchComponent
    }
    val retired = replacements.map { replacement ->
      val person = Person.Builder()
        .setName(replacement.personName)
        .setKey(replacement.personKey)
        .setIcon(appIcon)
        .build()
      ShortcutInfoCompat.Builder(context, replacement.id)
        .setShortLabel(replacement.shortLabel)
        .setLongLabel(replacement.longLabel)
        .setDisabledMessage(replacement.disabledMessage)
        .setIcon(appIcon)
        .setIntent(Intent(launchIntent))
        .setPerson(person)
        // Empty categories collapse to null across Binder and Android then preserves the old
        // Direct Share category. A harmless nonempty sentinel forces a real replacement.
        .setCategories(setOf(RETIRED_SHORTCUT_CATEGORY))
        .setLocusId(LocusIdCompat(replacement.locusId))
        .setLongLived(false)
        .setExtras(
          PersistableBundle().apply {
            putString(RETIRED_SHORTCUT_MARKER_KEY, RETIRED_SHORTCUT_MARKER_VALUE)
          },
        )
        .build()
    }
    return ShortcutManagerCompat.updateShortcuts(context, retired)
  }

  override fun disablePinned(ids: List<String>) {
    ShortcutManagerCompat.disableShortcuts(context, ids, RETIRED_SHORTCUT_DISABLED_MESSAGE)
  }

  override fun removeDynamic(ids: List<String>) {
    ShortcutManagerCompat.removeDynamicShortcuts(context, ids)
  }

  override fun removeLongLived(ids: List<String>) {
    ShortcutManagerCompat.removeLongLivedShortcuts(context, ids)
  }
}

/**
 * Owned SHARE-02 Direct Share boundary.
 *
 * Android receives only opaque HMAC ids plus a bounded display label and the generic app icon.
 * Resolution always happens against the current unlocked account's candidate GUIDs supplied by
 * JavaScript; stale, forged, deleted, or wrong-account ids resolve to null.
 */
class GatorShareShortcutsModule : Module() {
  companion object {
    /** Functions are synchronous, but this also fences stale calls across React-context reloads. */
    private val lastMutationRevision = AtomicLong(0L)
  }

  override fun definition() = ModuleDefinition {
    Name("GatorShareShortcuts")

    Function("clearLegacyShareShortcuts") { revision: Double ->
      mutate(revision) { context ->
        clearLegacyShareShortcuts(AndroidLegacyShortcutStore(context))
      }
    }

    // Compatibility alias for the already-shipped foreground cleanup caller. New JavaScript uses
    // the explicit legacy/current names so account teardown cannot accidentally skip either set.
    Function("clearShareShortcuts") { revision: Double ->
      mutate(revision) { context ->
        clearLegacyShareShortcuts(AndroidLegacyShortcutStore(context))
      }
    }

    Function("clearCurrentShareShortcuts") { revision: Double ->
      mutate(revision) { context ->
        clearCurrentAndRotate(context)
      }
    }

    Function("clearAllShareShortcuts") { revision: Double ->
      mutate(revision) { context ->
        val store = AndroidLegacyShortcutStore(context)
        clearLegacyShareShortcuts(store)
        clearCurrentShareShortcuts(store)
        check(ShareShortcutTokenOwner(context).rotate()) {
          "Direct Share account scope could not be rotated"
        }
      }
    }

    Function("setShareShortcuts") {
        revision: Double,
        records: List<ShareShortcutRecord>,
        appLockEnabled: Boolean,
      ->
      mutate(revision) { context ->
        val store = AndroidLegacyShortcutStore(context)
        if (appLockEnabled) {
          // Hiding rows while locked does not change account ownership; unlock may republish them.
          clearCurrentShareShortcuts(store)
          return@mutate
        }
        publishShareShortcuts(context, normalizeShareShortcutSpecs(records))
      }
    }

    Function("resolveShareShortcutTarget") { token: String, candidates: List<String> ->
      val context = requireContext()
      ShareShortcutTokenOwner(context).resolve(token, candidates)
    }

    Function("reportShareShortcutUsed") { token: String ->
      require(token.startsWith(CURRENT_SHARE_SHORTCUT_PREFIX)) { "Invalid Direct Share token" }
      ShortcutManagerCompat.reportShortcutUsed(requireContext(), token)
    }
  }

  private fun requireContext(): Context = checkNotNull(appContext.reactContext) {
    "React context unavailable while accessing Direct Share shortcuts"
  }

  private fun mutate(revision: Double, action: (Context) -> Unit) {
    require(revision.isFinite() && revision >= 1.0 && revision <= 9_007_199_254_740_991.0) {
      "Invalid Direct Share mutation revision"
    }
    val exact = revision.toLong()
    require(exact.toDouble() == revision) { "Invalid Direct Share mutation revision" }
    synchronized(lastMutationRevision) {
      check(exact > lastMutationRevision.get()) { "Stale Direct Share mutation" }
      action(requireContext())
      lastMutationRevision.set(exact)
    }
  }

  private fun clearCurrentAndRotate(context: Context) {
    clearCurrentShareShortcuts(AndroidLegacyShortcutStore(context))
    check(ShareShortcutTokenOwner(context).rotate()) {
      "Direct Share account scope could not be rotated"
    }
  }

  private fun publishShareShortcuts(context: Context, requested: List<ShareShortcutSpec>) {
    val owner = ShareShortcutTokenOwner(context)
    val limit = minOf(
      MAX_PUBLISHED_SHORTCUTS,
      ShortcutManagerCompat.getMaxShortcutCountPerActivity(context).coerceAtLeast(0),
    )
    val requestedWithTokens = requested.take(limit).map { spec -> spec to owner.tokenFor(spec.guid) }
    // setDynamicShortcuts replaces dynamic rows, but Android may retain cached, long-lived, or
    // user-pinned copies. Scrub every no-longer-requested current row before publishing the next
    // exact set so a removed/renamed conversation cannot leave private chooser metadata behind.
    clearStaleCurrentShareShortcuts(
      AndroidLegacyShortcutStore(context),
      requestedWithTokens.mapTo(mutableSetOf()) { it.second },
    )

    val appIcon = IconCompat.createWithResource(context, context.applicationInfo.icon)
    val launchIntent = checkNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName)) {
      "Direct Share launch activity is unavailable"
    }.apply {
      action = Intent.ACTION_VIEW
      replaceExtras(null)
      data = null
      clipData = null
    }
    val shortcuts = requestedWithTokens.map { (spec, token) ->
      val person = Person.Builder()
        .setName(spec.label)
        .setKey(token)
        .setIcon(appIcon)
        .build()
      ShortcutInfoCompat.Builder(context, token)
        .setShortLabel(spec.label)
        .setLongLabel(spec.label)
        .setIcon(appIcon)
        .setIntent(Intent(launchIntent))
        .setPerson(person)
        .setCategories(setOf(CURRENT_SHARE_SHORTCUT_CATEGORY))
        .setLocusId(LocusIdCompat(token))
        .setLongLived(true)
        .build()
    }
    check(ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)) {
      "Direct Share shortcuts could not be published"
    }
  }
}
