package expo.modules.gatorshareshortcuts

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Captures the tapped Direct Share target on a COLD start: when a share LAUNCHES the killed app,
 * Android puts the chosen shortcut's id in the launch intent as EXTRA_SHORTCUT_ID. The module's
 * OnNewIntent covers the already-running case; this covers the killed case. Registered via
 * GatorShareShortcutsPackage (auto-discovered by Expo autolinking, same as expo-share-intent).
 */
class GatorShareShortcutsReactActivityLifecycleListener(context: Context) :
  ReactActivityLifecycleListener {

  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    val id = activity?.intent?.getStringExtra(Intent.EXTRA_SHORTCUT_ID)
    if (!id.isNullOrEmpty()) {
      ShareShortcutStore.pendingShortcutId = id
    }
  }
}
