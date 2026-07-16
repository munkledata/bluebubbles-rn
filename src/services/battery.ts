import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { logger } from '@core/secure';

const FALLBACK_PACKAGE = 'com.bluegreengatorapps.messages';

/**
 * Ask Android to exempt this app from battery optimization (Doze), so background work and
 * FCM/notification delivery stay reliable — the app can be killed under Doze otherwise, dropping
 * pushes. Opens the OS "allow this app to ignore battery optimizations?" dialog. Android-only
 * (returns false elsewhere).
 *
 * `expo-intent-launcher` is imported LAZILY so the JS bundle doesn't reference the native module
 * on any startup path; the direct-request action needs the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
 * permission (declared in app.config) and the linked module, so it activates on the next native
 * rebuild — until then this throws and is caught (a no-op), keeping the build green.
 */
export async function requestDisableBatteryOptimization(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const IntentLauncher = await import('expo-intent-launcher');
    const pkg = Constants.expoConfig?.android?.package ?? FALLBACK_PACKAGE;
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
      { data: `package:${pkg}` },
    );
    return true;
  } catch (e) {
    logger.warn('battery-optimization request failed', e);
    return false;
  }
}
