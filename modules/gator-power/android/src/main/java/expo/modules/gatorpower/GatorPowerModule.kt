package expo.modules.gatorpower

import android.content.Context
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Read-only power facts for the Settings screen. Nothing here asks Android to change anything: the
 * Battery row opens Android's own settings screen for that (see src/services/battery.ts).
 */
class GatorPowerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorPower")

    // True when Android exempts Gator from battery optimization ("Unrestricted"), false while Gator
    // is optimized, and null when the app context or the power service is unavailable.
    Function("isIgnoringBatteryOptimizations") { ignoringBatteryOptimizations() }
  }

  private fun ignoringBatteryOptimizations(): Boolean? {
    val context = appContext.reactContext ?: return null
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return null
    return power.isIgnoringBatteryOptimizations(context.packageName)
  }
}
