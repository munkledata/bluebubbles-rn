import { requireOptionalNativeModule } from 'expo';

interface GatorPowerNative {
  isIgnoringBatteryOptimizations: () => boolean | null;
}

function getNative(): GatorPowerNative | null {
  try {
    return requireOptionalNativeModule<GatorPowerNative>('GatorPower');
  } catch {
    return null;
  }
}

/**
 * Whether Android exempts Gator from battery optimization: true ("Unrestricted"), false (optimized
 * or restricted), or null when it can't be known (not Android, an app build without the native
 * module, or a failed query). Read-only: it never asks Android to change anything.
 */
export function isIgnoringBatteryOptimizations(): boolean | null {
  const native = getNative();
  if (!native) return null;
  try {
    const value = native.isIgnoringBatteryOptimizations();
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}
