import notifee, { EventType } from 'react-native-notify-kit';
import { handleNotificationAction, handleNotificationPress } from './actions';
import { stashPendingNotification } from './pendingNav';

/**
 * Headless background notification handler. MUST be registered at module top
 * level (not in a component) so a press wakes the app even when killed.
 * Imported for its side effect at the top of `app/_layout.tsx`.
 */
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.ACTION_PRESS) {
    await handleNotificationAction(detail);
  } else if (type === EventType.PRESS) {
    // Body tap while the app is killed OR alive-but-backgrounded (notify-kit routes a PRESS here,
    // not to onForegroundEvent, whenever the Activity isn't RESUMED — the common way users tap a
    // notification). This handler has no router, so it can't deep-link directly. Stash the tapped
    // chat so the connected layout can open it on the next AppState 'active' (background-alive case,
    // same JS context), and run the headless side-effects (reminder cleanup) now. A killed-app tap
    // ALSO deep-links via getInitialNotification() on next mount; the layout drains both, once.
    stashPendingNotification(detail.notification?.data);
    await handleNotificationPress(detail);
  }
});
