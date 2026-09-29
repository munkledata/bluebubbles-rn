import type { ExpoLocationAdapter } from './currentLocation';

/**
 * Load the native module only when a foreground location action actually begins.
 *
 * The literal require remains visible to Metro, while Node tests that import the send barrel do
 * not have to parse Expo's native ESM entry point.
 */
export function getExpoLocationAdapter(): ExpoLocationAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep this native module lazy and Metro-visible.
  return require('expo-location') as ExpoLocationAdapter;
}
