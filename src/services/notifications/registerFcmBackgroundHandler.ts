import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import { logger } from '@core/secure';
import { handleBackgroundFcm } from './fcmMessaging';

// Explicit bundle-entry side effect. Android looks up this native handler in a killed/headless JS
// context that never renders Expo Router, so registration must finish during entry evaluation.
try {
  setBackgroundMessageHandler(getMessaging(), handleBackgroundFcm);
} catch (error) {
  logger.warn('[fcm] setBackgroundMessageHandler unavailable — push disabled', error);
}
