package expo.modules.gatorscreensecurity

import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import com.facebook.common.logging.FLog
import expo.modules.core.BasePackage
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.ReactNativeHostHandler

private const val RELEASE_RUNTIME_FAILURE = "runtime.fatal [UnknownError]"

private class ReleaseReactInstanceException :
  RuntimeException(RELEASE_RUNTIME_FAILURE, null, false, false)

private class ReleaseReactStartupException :
  RuntimeException("runtime.startup_failed [UnknownError]", null, false, false)

/** Called directly from MainApplication, before Expo's lifecycle listeners exist. */
object GatorStartupPrivacy {
  fun run(debuggable: Boolean, startup: () -> Unit) {
    // This is the application's compiled BuildConfig.DEBUG, never a JS/runtime flag.
    if (debuggable) {
      startup()
      return
    }
    try {
      FLog.setMinimumLoggingLevel(Int.MAX_VALUE)
      startup()
    } catch (_: Exception) {
      throw ReleaseReactStartupException()
    } catch (_: LinkageError) {
      throw ReleaseReactStartupException()
    }
    // VM exhaustion, thread termination, and native signals are not recovery paths.
  }
}

private fun isDebuggable(context: Context?): Boolean =
  context != null &&
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

/** Release-only containment for React Native failures that happen before JavaScript can project. */
class GatorRuntimePrivacyPackage : BasePackage() {
  override fun createApplicationLifecycleListeners(
    context: Context?,
  ): List<ApplicationLifecycleListener> = listOf(
    object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        if (!isDebuggable(application)) {
          FLog.setMinimumLoggingLevel(Int.MAX_VALUE)
        }
      }
    },
  )

  override fun createReactNativeHostHandlers(
    context: Context?,
  ): List<ReactNativeHostHandler> {
    val debuggable = isDebuggable(context)
    return listOf(
      object : ReactNativeHostHandler {
        override fun onWillCreateReactInstance(useDeveloperSupport: Boolean) {
          if (!useDeveloperSupport || !debuggable) {
            FLog.setMinimumLoggingLevel(Int.MAX_VALUE)
          }
        }

        override fun onReactInstanceException(
          useDeveloperSupport: Boolean,
          exception: Exception,
        ) {
          if (useDeveloperSupport && debuggable) {
            throw exception
          }
          throw ReleaseReactInstanceException()
        }
      },
    )
  }
}
