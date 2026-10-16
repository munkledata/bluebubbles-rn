import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { ClientContext } from './errorReportQueueService';

/**
 * This device's constant context for the error-report upload envelope (Android RN client). Shared
 * by the foreground flush and the background task, so both report the app and Android version.
 */
export function clientContext(): ClientContext {
  return {
    appVersion: Constants.expoConfig?.version ?? undefined,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
  };
}
