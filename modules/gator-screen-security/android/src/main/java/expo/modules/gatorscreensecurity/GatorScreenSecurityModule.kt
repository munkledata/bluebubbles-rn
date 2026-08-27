package expo.modules.gatorscreensecurity

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Looper
import android.view.Window
import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.interfaces.ExtraWindowEventListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.util.Collections
import java.util.WeakHashMap

private const val PREFERENCES_NAME = "gator_screen_security"
private const val APP_LOCK_ENABLED = "app_lock_enabled"
private const val SECURE_SCREEN_ENABLED = "secure_screen_enabled"

/**
 * Owns Android window policy independently of React rendering.
 *
 * Android 13+ has a Recents-only API, so App Lock can prevent task snapshots without disabling
 * ordinary foreground screenshots. Older supported Android versions need a transient secure
 * window while backgrounded. That fallback stays in place through `onResume` until JavaScript has
 * synchronously completed its grace-period/lock decision and calls `completeForegroundTransition`.
 * The separate Secure Screen preference keeps FLAG_SECURE set in every lifecycle state.
 */
internal object ScreenSecurityController {
  private var activityInForeground = false
  private var foregroundTransitionComplete = false
  private val extraWindows = Collections.newSetFromMap(WeakHashMap<Window, Boolean>())

  private fun preferences(activity: Activity) =
    activity.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun appLockEnabled(activity: Activity): Boolean =
    preferences(activity).getBoolean(APP_LOCK_ENABLED, false)

  fun secureScreenEnabled(activity: Activity): Boolean =
    preferences(activity).getBoolean(SECURE_SCREEN_ENABLED, false)

  private fun persist(activity: Activity, key: String, enabled: Boolean) {
    check(preferences(activity).edit().putBoolean(key, enabled).commit()) {
      "Android could not persist the screen-security preference"
    }
  }

  private fun setWindowSecure(window: Window, secure: Boolean) {
    if (secure) {
      window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  private fun apply(activity: Activity) {
    val appLock = appLockEnabled(activity)
    val secureScreen = secureScreenEnabled(activity)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // This affects only Overview/Recents. Foreground screenshots remain controlled solely by
      // Secure Screen, which keeps the two user-facing privacy controls independent.
      activity.setRecentsScreenshotEnabled(!appLock)
    }

    val needsLegacyRecentsProtection =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
        appLock &&
        (!activityInForeground || !foregroundTransitionComplete)
    val secureEveryWindow = secureScreen || needsLegacyRecentsProtection
    setWindowSecure(activity.window, secureEveryWindow)
    extraWindows.forEach { window -> setWindowSecure(window, secureEveryWindow) }
  }

  fun attach(activity: Activity) {
    // Fail closed on the legacy fallback until the active React tree confirms it is safe to show.
    foregroundTransitionComplete = false
    apply(activity)
  }

  fun refresh(activity: Activity) {
    apply(activity)
  }

  fun addExtraWindow(window: Window, activity: Activity?) {
    extraWindows.add(window)
    if (activity == null) {
      // A newly created window with no resolvable owner must not briefly expose content.
      setWindowSecure(window, true)
    } else {
      apply(activity)
    }
  }

  fun removeExtraWindow(window: Window) {
    extraWindows.remove(window)
  }

  fun enterForeground(activity: Activity) {
    activityInForeground = true
    foregroundTransitionComplete = !appLockEnabled(activity)
    apply(activity)
  }

  fun leaveForeground(activity: Activity) {
    activityInForeground = false
    foregroundTransitionComplete = false
    apply(activity)
  }

  fun completeForegroundTransition(activity: Activity): Boolean {
    if (!activityInForeground) return false
    foregroundTransitionComplete = true
    apply(activity)
    return true
  }

  fun setAppLockEnabled(activity: Activity, enabled: Boolean) {
    persist(activity, APP_LOCK_ENABLED, enabled)
    foregroundTransitionComplete = !enabled
    apply(activity)
  }

  fun setSecureScreenEnabled(activity: Activity, enabled: Boolean) {
    persist(activity, SECURE_SCREEN_ENABLED, enabled)
    apply(activity)
  }
}

private inline fun <T> runOnMainThread(crossinline block: () -> T): T {
  if (Looper.myLooper() == Looper.getMainLooper()) return block()
  return runBlocking(Dispatchers.Main) { block() }
}

class GatorScreenSecurityModule : Module() {
  private var registeredReactContext: ReactApplicationContext? = null
  private val extraWindowListener = object : ExtraWindowEventListener {
    override fun onExtraWindowCreate(window: Window) {
      ScreenSecurityController.addExtraWindow(window, registeredReactContext?.currentActivity)
    }

    override fun onExtraWindowDestroy(window: Window) {
      ScreenSecurityController.removeExtraWindow(window)
    }
  }

  private fun currentActivity(): Activity =
    checkNotNull(appContext.currentActivity) { "Android activity is unavailable" }

  override fun definition() = ModuleDefinition {
    Name("GatorScreenSecurity")

    OnCreate {
      val reactContext = appContext.reactContext
      check(reactContext is ReactApplicationContext) {
        "React application context is unavailable for screen-security window tracking"
      }
      registeredReactContext = reactContext
      reactContext.addExtraWindowEventListener(extraWindowListener)
      appContext.currentActivity?.let(ScreenSecurityController::refresh)
    }
    OnDestroy {
      registeredReactContext?.removeExtraWindowEventListener(extraWindowListener)
      registeredReactContext = null
    }

    Function("setAppLockEnabled") { enabled: Boolean ->
      runOnMainThread {
        ScreenSecurityController.setAppLockEnabled(currentActivity(), enabled)
      }
    }
    Function("completeForegroundTransition") {
      runOnMainThread {
        ScreenSecurityController.completeForegroundTransition(currentActivity())
      }
    }
    Function("getSecureScreenEnabled") {
      runOnMainThread {
        ScreenSecurityController.secureScreenEnabled(currentActivity())
      }
    }
    Function("setSecureScreenEnabled") { enabled: Boolean ->
      runOnMainThread {
        ScreenSecurityController.setSecureScreenEnabled(currentActivity(), enabled)
      }
    }
  }
}
