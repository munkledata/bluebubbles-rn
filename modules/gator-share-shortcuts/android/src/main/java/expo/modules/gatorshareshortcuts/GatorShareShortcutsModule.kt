package expo.modules.gatorshareshortcuts

import androidx.core.content.pm.ShortcutManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * IPC-01 legacy cleanup bridge.
 *
 * Older Gator builds published long-lived Android Direct Share shortcuts containing conversation
 * names and contact photos. The inbound-share feature is now fail-closed, but Android may retain
 * those shortcuts across an app upgrade. Keep only this one-way removal API until upgraded installs
 * have had a chance to clear that persistent system state.
 */
class GatorShareShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorShareShortcuts")

    Function("clearShareShortcuts") { _: Double ->
      val context = checkNotNull(appContext.reactContext) {
        "React context unavailable while clearing Direct Share shortcuts"
      }
      // Capture the ids before removing dynamic shortcuts. Android 11+ can cache long-lived
      // shortcuts separately, so remove both the dynamic entries and their cached copies. Do not
      // swallow Android failures: Disconnect treats a successful return as proof that account A's
      // persisted names/photos are gone and must keep account B blocked when that proof is absent.
      val ids = ShortcutManagerCompat.getShortcuts(
        context,
        ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or
          ShortcutManagerCompat.FLAG_MATCH_CACHED,
      ).map { shortcut -> shortcut.id }.distinct()

      ShortcutManagerCompat.removeAllDynamicShortcuts(context)
      if (ids.isNotEmpty()) {
        ShortcutManagerCompat.removeLongLivedShortcuts(context, ids)
      }

      // A void return only proves that Android accepted the call, not that persistent account
      // metadata actually disappeared. Re-query the two stores we own and fail closed unless the
      // postcondition is true; Disconnect/Forget can then block instead of switching accounts on
      // an unverified cleanup.
      val remainingIds = ShortcutManagerCompat.getShortcuts(
        context,
        ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or
          ShortcutManagerCompat.FLAG_MATCH_CACHED,
      ).map { shortcut -> shortcut.id }.distinct()
      check(remainingIds.isEmpty()) {
        "Direct Share shortcut cleanup left ${remainingIds.size} persisted entries"
      }
    }
  }
}
