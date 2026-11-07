import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { logger } from '@core/secure';
import { isIgnoringBatteryOptimizations } from '@/native/powerManager';

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
 * It opens Gator's own App info page first: Battery is one tap away there and uses the same word,
 * "Unrestricted", as the Settings note. Android's general battery-optimization list comes second:
 * on the Samsung the owner could not find Gator in it to switch the setting back (2026-11-07).
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
        IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: `package:${pkg}` },
      );
    } catch {
      // A ROM without a per-app Info page still has the general battery-optimization list.
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
      );
    }
    return true;
  } catch (e) {
    logger.warn('battery-optimization request failed', e);
    return false;
  }
}

export type BatteryOptimizationStatus = 'unrestricted' | 'optimized' | 'unknown';

/**
 * Gator's battery-optimization status on this phone, read fresh each time (the person may have
 * just changed it in Android's settings). "unknown" off Android, on an app build without the native
 * module, or when Android doesn't answer.
 */
export function getBatteryOptimizationStatus(): BatteryOptimizationStatus {
  if (Platform.OS !== 'android') return 'unknown';
  const ignoring = isIgnoringBatteryOptimizations();
  if (ignoring === null) return 'unknown';
  return ignoring ? 'unrestricted' : 'optimized';
}

/** The Settings note for a status; null when there is nothing reliable to say. */
export function batteryOptimizationNote(status: BatteryOptimizationStatus): string | null {
  switch (status) {
    case 'unrestricted':
      return 'Battery: Unrestricted. Android won’t hold back Gator’s notifications.';
    case 'optimized':
      return 'Battery: Optimized. Android may delay notifications while the phone is idle. For prompt notifications, open Battery Optimization Settings, tap Battery and choose “Unrestricted”.';
    case 'unknown':
      return null;
  }
}
