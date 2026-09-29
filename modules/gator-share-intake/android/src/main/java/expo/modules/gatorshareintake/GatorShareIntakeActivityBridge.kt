package expo.modules.gatorshareintake

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Stable static surface invoked by the app's generated MainActivity hooks. */
object GatorShareIntakeActivityBridge {
  @JvmStatic
  fun captureOnCreate(
    activity: Activity,
    intent: Intent?,
    savedInstanceState: Bundle?,
  ): Boolean {
    GatorShareIntakeManager.initialize(activity.applicationContext)
    if (savedInstanceState != null) {
      // Android may restore the original launch Intent. It was already ingested before the saved
      // state existed, so clear and replace it without creating a duplicate batch.
      if (GatorShareIntakeManager.isShareIntent(intent)) replaceActivityIntent(activity, intent)
      return false
    }
    val accepted = GatorShareIntakeManager.accept(activity, intent)
    if (accepted) replaceActivityIntent(activity, intent)
    return accepted
  }

  @JvmStatic
  fun captureOnNewIntent(activity: Activity, intent: Intent?): Boolean {
    GatorShareIntakeManager.initialize(activity.applicationContext)
    val accepted = GatorShareIntakeManager.accept(activity, intent)
    if (accepted) replaceActivityIntent(activity, intent)
    return accepted
  }

  private fun replaceActivityIntent(activity: Activity, consumed: Intent?) {
    consumed?.let(GatorShareIntakeManager::sanitize)
    activity.intent = Intent(Intent.ACTION_MAIN).apply {
      component = activity.componentName
      addCategory(Intent.CATEGORY_LAUNCHER)
    }
  }
}
