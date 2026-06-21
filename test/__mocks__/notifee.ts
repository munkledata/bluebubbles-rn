// Runtime stub for @notifee/react-native (a native module that can't load under
// Node). ts-jest still type-checks against the real .d.ts via tsconfig paths;
// jest swaps in this stub at runtime via moduleNameMapper. Only the values used
// at module-eval / call time need to exist.
export const AndroidImportance = { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 };
export const AndroidStyle = { BIGPICTURE: 0, BIGTEXT: 1, INBOX: 2, MESSAGING: 3 };
export const AuthorizationStatus = { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 };
export const TriggerType = { TIMESTAMP: 0, INTERVAL: 1 };
export const EventType = { DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2, DELIVERED: 3 };

const notifee = {
  createChannel: async () => 'channel',
  requestPermission: async () => ({ authorizationStatus: 1 }),
  displayNotification: async () => undefined,
  createTriggerNotification: async () => undefined,
  cancelNotification: async () => undefined,
  cancelTriggerNotification: async () => undefined,
  onForegroundEvent: () => () => undefined,
  onBackgroundEvent: () => undefined,
};
export default notifee;
