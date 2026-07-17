import notifee, { EventType } from 'react-native-notify-kit';
import { handleNotificationAction, handleNotificationPress } from './actions';

/**
 * Headless background notification handler. MUST be registered at module top
 * level (not in a component) so a press wakes the app even when killed.
 * Imported for its side effect at the top of `app/_layout.tsx`.
 */
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.ACTION_PRESS) {
    await handleNotificationAction(detail);
  } else if (type === EventType.PRESS) {
    // Body tap while killed/backgrounded: run the headless side-effects now (reminder
    // cleanup). Deep-linking to the chat happens on next mount via getInitialNotification().
    await handleNotificationPress(detail);
  }
});
