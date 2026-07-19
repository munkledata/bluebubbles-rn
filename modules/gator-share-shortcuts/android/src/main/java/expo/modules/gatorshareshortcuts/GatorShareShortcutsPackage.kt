package expo.modules.gatorshareshortcuts

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Registers the lifecycle listener that captures a cold-start Direct Share tap. Expo autolinking
 * auto-discovers Package implementations in a linked module (proven by expo-share-intent, whose
 * expo-module.config.json also lists only its module yet still wires its Package).
 */
class GatorShareShortcutsPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context,
  ): List<ReactActivityLifecycleListener> {
    return listOf(GatorShareShortcutsReactActivityLifecycleListener(activityContext))
  }
}
