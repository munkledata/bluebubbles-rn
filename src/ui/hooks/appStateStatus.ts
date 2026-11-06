import { AppState, type AppStateStatus } from 'react-native';

const APP_STATE_STATUSES: ReadonlySet<string> = new Set<AppStateStatus>([
  'active',
  'background',
  'inactive',
  'extension',
  'unknown',
]);

/**
 * `AppState.currentState` is typed as a nullable string since React Native 0.88 (it mirrors the
 * native module's field), while listeners and our state hooks use the `AppStateStatus` union.
 * Anything outside the documented statuses, including a not-yet-reported state, reads as 'unknown'.
 */
export function readAppStateStatus(): AppStateStatus {
  const state = AppState.currentState;
  return typeof state === 'string' && APP_STATE_STATUSES.has(state)
    ? (state as AppStateStatus)
    : 'unknown';
}
