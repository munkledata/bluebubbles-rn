import notifee, { EventType } from 'react-native-notify-kit';
import { logger } from '@core/secure';
import { flushPersistentLogsForHeadlessCompletion } from '../logging/fileLogSink';
import { handleNotificationAction, handleNotificationPress } from './actions';
import { stashPendingNotification } from './pendingNav';

/**
 * Headless background notification handler. MUST be registered at module top
 * level (not in a component) so a press wakes the app even when killed.
 * Imported for its side effect from `index.js`, before `expo-router/entry`.
 *
 * Nothing may escape this callback. notifee awaits it across the native bridge and gives it no
 * error path of its own, so a rejection is simply swallowed: every headless failure — a DB that
 * couldn't be opened, a send that threw — used to look identical to "the button does nothing",
 * with no diagnostic to say otherwise. The `warn` breadcrumb is development-only; it deliberately
 * is not an ERROR because this path also runs while disconnected and ERROR would enter the durable
 * reporting queue. Release investigation uses the deterministic recovery path and native traces.
 */
notifee.onBackgroundEvent(async ({ type, detail }) => {
  try {
    if (type === EventType.ACTION_PRESS) {
      await handleNotificationAction(detail);
    } else if (type === EventType.PRESS) {
      // Body tap while the app is killed OR alive-but-backgrounded (notify-kit routes a PRESS here,
      // not to onForegroundEvent, whenever the Activity isn't RESUMED — the common way users tap a
      // notification). This handler has no router, so it can't deep-link directly. Stash the tapped
      // chat so the connected layout can open it on the next AppState 'active' (background-alive
      // case, same JS context), and run the headless side-effects (reminder cleanup) now. A
      // killed-app tap ALSO deep-links via getInitialNotification() on next mount; the layout
      // drains both, once.
      await handleNotificationPress(detail, stashPendingNotification);
    }
  } catch (e) {
    logger.warn('[notif] background event failed', { type, error: String(e) });
  } finally {
    // Android may tear down this headless runtime as soon as the native callback settles.
    await flushPersistentLogsForHeadlessCompletion();
  }
});
