import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { logger } from '@core/secure';

const FALLBACK_PACKAGE = 'com.bluegreengatorapps.messages';

/**
 * Open the Android battery-optimization settings so the user can exempt this app from Doze (kept
 * exempt, background work and FCM/notification delivery stay reliable). Android-only (returns false
 * elsewhere).
 *
 * We deliberately do NOT use the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` direct-request dialog:
 * Android only shows that dialog the FIRST time (when the app isn't yet exempt) and silently
 * no-ops it forever after, so repeat presses appear to "do nothing" (the reported bug — there's no
 * way to detect the already-exempt state without a native PowerManager query). The battery-
 * optimization settings screen ALWAYS opens, so the button is reliable and lets the user both grant
 * and later see/undo the exemption.
 *
 * `expo-intent-launcher` is imported LAZILY so the JS bundle doesn't reference the native module on
 * any startup path; until it's linked (native rebuild) this throws and is caught (a no-op), keeping
 * the build green.
 */
export async function requestDisableBatteryOptimization(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const IntentLauncher = await import('expo-intent-launcher');
    const pkg = Constants.expoConfig?.android?.package ?? FALLBACK_PACKAGE;
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
      );
    } catch {
      // Some OEM ROMs don't expose that screen — fall back to this app's system Info page, from
      // which the user can reach Battery → Unrestricted.
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: `package:${pkg}` },
      );
    }
    return true;
  } catch (e) {
    logger.warn('battery-optimization request failed', e);
    return false;
  }
}
