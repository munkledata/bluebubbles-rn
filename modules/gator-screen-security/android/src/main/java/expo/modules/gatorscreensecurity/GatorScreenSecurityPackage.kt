package expo.modules.gatorscreensecurity

import android.app.Activity
import android.content.Context
import android.os.Bundle
import expo.modules.core.BasePackage
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Eager Activity owner for persisted screen policy.
 *
 * Expo discovers `*Package.kt` implementations during native autolinking, so these callbacks run
 * before the JavaScript module is required and again for every Activity recreation.
 */
class GatorScreenSecurityPackage : BasePackage() {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context?,
  ): List<ReactActivityLifecycleListener> = listOf(
    object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        ScreenSecurityController.attach(activity)
      }

      override fun onResume(activity: Activity) {
        ScreenSecurityController.enterForeground(activity)
      }

      override fun onUserLeaveHint(activity: Activity) {
        ScreenSecurityController.leaveForeground(activity)
      }

      override fun onPause(activity: Activity) {
        ScreenSecurityController.leaveForeground(activity)
      }
    },
  )
}
