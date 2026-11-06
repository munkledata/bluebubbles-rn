package expo.modules.gatorscreensecurity

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import expo.modules.core.BasePackage
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Eager Activity owner for persisted screen policy.
 *
 * Expo discovers `*Package.kt` implementations during native autolinking, so these callbacks run
 * before the JavaScript module is required and again for every Activity recreation. Every resume
 * re-applies the persisted policy as well; doing so is cheap and idempotent.
 *
 * The React Activity listener only sees the React host Activity. Other Activities in this process
 * (expo-video's fullscreen player, the image cropper, the ML Kit barcode scanner) would otherwise
 * show without FLAG_SECURE and with a live Recents thumbnail, so the application listener below
 * registers process-wide Activity callbacks that apply the same persisted policy to every Activity
 * as it is created and resumed (plan F-3 step 2). The React host Activity is refreshed twice; that
 * is harmless.
 */
class GatorScreenSecurityPackage : BasePackage() {
  override fun createApplicationLifecycleListeners(
    context: Context?,
  ): List<ApplicationLifecycleListener> = listOf(
    object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        application.registerActivityLifecycleCallbacks(
          object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
              ScreenSecurityController.refresh(activity)
            }

            override fun onActivityResumed(activity: Activity) {
              ScreenSecurityController.refresh(activity)
            }

            override fun onActivityStarted(activity: Activity) {}

            override fun onActivityPaused(activity: Activity) {}

            override fun onActivityStopped(activity: Activity) {}

            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

            override fun onActivityDestroyed(activity: Activity) {}
          },
        )
      }
    },
  )

  override fun createReactActivityLifecycleListeners(
    activityContext: Context?,
  ): List<ReactActivityLifecycleListener> = listOf(
    object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        ScreenSecurityController.refresh(activity)
      }

      override fun onResume(activity: Activity) {
        ScreenSecurityController.refresh(activity)
      }
    },
  )
}
