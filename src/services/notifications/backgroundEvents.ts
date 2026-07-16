import notifee, { EventType } from 'react-native-notify-kit';
import { handleNotificationAction } from './actions';

/**
 * Headless background notification handler. MUST be registered at module top
 * level (not in a component) so an action press wakes the app even when killed.
 * Imported for its side effect at the top of `app/_layout.tsx`.
 */
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.ACTION_PRESS) {
    await handleNotificationAction(detail);
  }
});
