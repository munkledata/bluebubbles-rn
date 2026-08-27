/**
 * The app's REAL JS entry point (package.json `main`), ahead of `expo-router/entry`.
 *
 * WHY THIS FILE EXISTS — the killed-app push bug:
 * Android wakes the app headlessly for an FCM push (and for a background task) by loading the
 * JS bundle and IMMEDIATELY looking up a registered headless task by name. It never renders
 * anything. But `app/_layout.tsx` is a ROUTE module — expo-router loads it lazily, at RENDER
 * time, via its require.context. So a side-effect import placed at the top of `_layout` does
 * NOT run during a headless wake, and the registrations below never happen:
 *
 *   • `setBackgroundMessageHandler` (RNFB) → registers the `ReactNativeFirebaseMessagingHeadlessTask`
 *   • `TaskManager.defineTask`     (expo) → registers the `gator-bg-sync` task
 *
 * The observed failure was logcat printing, on every push to a process that had not rendered:
 *     D/RNFirebaseMsgReceiver: broadcast received for message
 *     W/ReactNativeJS: No task registered for key ReactNativeFirebaseMessagingHeadlessTask
 * …and the push being silently dropped. It LOOKED intermittent because push kept working while
 * the process happened to still be alive from the last time the user opened the app; once Android
 * reclaimed the process, every notification vanished until the app was manually reopened.
 *
 * Importing them HERE — from the bundle entry, which every headless wake evaluates — is what
 * actually registers them. `app/_layout.tsx` keeps its own imports (the module cache makes them
 * a no-op) so the app still works if this entry is ever changed.
 *
 * RULES:
 *   • `expo-router/entry` MUST be imported LAST (it registers the root component and starts the app).
 *   • Relative paths only — this file is outside the `@/` alias-checked TS project.
 *   • Anything added here runs on EVERY cold start, so keep it to cheap side-effect registrations.
 */

// Release-only native exception + console projection. MUST be the first side effect: even the
// headless registration modules below can fail while evaluating.
import './src/services/errors/registerReactNativeExceptionPrivacy';
// Attach the persistent ERROR sink before any killed-process task can execute.
import './src/services/logging/registerPersistentLogs';

// Headless notify-kit background events (notification taps/actions while killed).
import './src/services/notifications/backgroundEvents';
// TaskManager.defineTask('gator-bg-sync') — the background sync/outgoing-queue drain.
import './src/services/background/backgroundSync';
// setBackgroundMessageHandler(...) — killed-app FCM push delivery.
import './src/services/notifications/fcmMessaging';
// Constant-work cleanup for at most eight abandoned native download partials after process death.
import './src/services/download/registerBoundedNativeDownloadCleanup';

import 'expo-router/entry';
