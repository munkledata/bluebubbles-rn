package expo.modules.gatorshareshortcuts

/**
 * Cross-instance holder for the id of the Direct Share target the user just tapped (Android delivers
 * it as `Intent.EXTRA_SHORTCUT_ID` on the ACTION_SEND intent). Written by the lifecycle listener
 * (cold start) and the module's OnNewIntent (app already running); read + cleared once by
 * getLaunchShortcutId(). Mirrors expo-share-intent's ExpoShareIntentSingleton pattern.
 */
object ShareShortcutStore {
  @Volatile
  var pendingShortcutId: String? = null
}
