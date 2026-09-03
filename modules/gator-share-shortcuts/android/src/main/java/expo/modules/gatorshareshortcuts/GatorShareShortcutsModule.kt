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

internal const val RETIRED_SHORTCUT_LABEL = "Gator"
internal const val RETIRED_SHORTCUT_DISABLED_MESSAGE = "This shortcut is no longer available"
private const val RETIRED_SHORTCUT_PERSON_KEY = "gator-retired-shortcut"
private const val RETIRED_SHORTCUT_LOCUS_ID = "gator-retired-shortcut"
internal const val RETIRED_SHORTCUT_CATEGORY =
  "com.bluegreengatorapps.messages.category.RETIRED_SHORTCUT"
private const val RETIRED_SHORTCUT_MARKER_KEY = "gator.retired"
private const val RETIRED_SHORTCUT_MARKER_VALUE = "1"
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

  fun removeAllDynamic()

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
  val before = store.list()
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

  store.removeAllDynamic()
  if (allIds.isNotEmpty()) store.removeLongLived(allIds)

  val unsafe = store.list().filter { current ->
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

  override fun removeAllDynamic() {
    ShortcutManagerCompat.removeAllDynamicShortcuts(context)
  }

  override fun removeLongLived(ids: List<String>) {
    ShortcutManagerCompat.removeLongLivedShortcuts(context, ids)
  }
}

/**
 * IPC-01 legacy cleanup bridge.
 *
 * Older Gator builds published long-lived Android Direct Share shortcuts containing conversation
 * names and contact photos. The inbound-share feature is now fail-closed, but Android may retain
 * those shortcuts across an app upgrade. Keep only this one-way cleanup API until upgraded installs
 * have had a chance to retire or remove that persistent system state.
 */
class GatorShareShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorShareShortcuts")

    Function("clearShareShortcuts") { _: Double ->
      val context = checkNotNull(appContext.reactContext) {
        "React context unavailable while clearing Direct Share shortcuts"
      }
      clearLegacyShareShortcuts(AndroidLegacyShortcutStore(context))
    }
  }
}
