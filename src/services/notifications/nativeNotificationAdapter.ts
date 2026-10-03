import notifyKit, {
  AlarmType,
  AndroidCategory,
  AndroidGroupAlertBehavior,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  EventType,
  TriggerType,
} from 'react-native-notify-kit';
import type {
  DisplayedNotification,
  Event as NativeEvent,
  EventDetail as NativeEventDetail,
  InitialNotification as NativeInitialNotification,
  Notification,
  TimestampTrigger,
  TriggerNotification,
} from 'react-native-notify-kit';

/** The pinned Android patch adds receipt identity outside notification.data. */
type EventDetail = NativeEventDetail & { pressOccurrenceId?: string };
type Event = Omit<NativeEvent, 'detail'> & { detail: EventDetail };
type InitialNotification = NativeInitialNotification & { pressOccurrenceId?: string };

/**
 * The sole production boundary around react-native-notify-kit.
 *
 * Keep each method as an arrow wrapper instead of exporting the package singleton. That preserves
 * the native module's receiver and gives a replacement one small owned surface to implement.
 * Background registration remains synchronous at module evaluation time: index.js imports the
 * caller before expo-router/entry, and the wrapper immediately delegates to the native package.
 */
export const nativeNotificationAdapter = {
  cancelAllNotifications: (...args: Parameters<typeof notifyKit.cancelAllNotifications>) =>
    notifyKit.cancelAllNotifications(...args),
  cancelDisplayedNotifications: (
    ...args: Parameters<typeof notifyKit.cancelDisplayedNotifications>
  ) => notifyKit.cancelDisplayedNotifications(...args),
  cancelNotification: (...args: Parameters<typeof notifyKit.cancelNotification>) =>
    notifyKit.cancelNotification(...args),
  cancelTriggerNotification: (...args: Parameters<typeof notifyKit.cancelTriggerNotification>) =>
    notifyKit.cancelTriggerNotification(...args),
  cancelTriggerNotifications: (...args: Parameters<typeof notifyKit.cancelTriggerNotifications>) =>
    notifyKit.cancelTriggerNotifications(...args),
  createChannel: (...args: Parameters<typeof notifyKit.createChannel>) =>
    notifyKit.createChannel(...args),
  createTriggerNotification: (...args: Parameters<typeof notifyKit.createTriggerNotification>) =>
    notifyKit.createTriggerNotification(...args),
  deleteChannel: (...args: Parameters<typeof notifyKit.deleteChannel>) =>
    notifyKit.deleteChannel(...args),
  displayNotification: (...args: Parameters<typeof notifyKit.displayNotification>) =>
    notifyKit.displayNotification(...args),
  getChannel: (...args: Parameters<typeof notifyKit.getChannel>) => notifyKit.getChannel(...args),
  getChannels: (...args: Parameters<typeof notifyKit.getChannels>) =>
    notifyKit.getChannels(...args),
  getDisplayedNotifications: (...args: Parameters<typeof notifyKit.getDisplayedNotifications>) =>
    notifyKit.getDisplayedNotifications(...args),
  getInitialNotification: (
    ...args: Parameters<typeof notifyKit.getInitialNotification>
  ): Promise<InitialNotification | null> => notifyKit.getInitialNotification(...args),
  getNotificationSettings: (...args: Parameters<typeof notifyKit.getNotificationSettings>) =>
    notifyKit.getNotificationSettings(...args),
  getTriggerNotifications: (...args: Parameters<typeof notifyKit.getTriggerNotifications>) =>
    notifyKit.getTriggerNotifications(...args),
  onBackgroundEvent: (observer: (event: Event) => Promise<void>) =>
    notifyKit.onBackgroundEvent(observer),
  onForegroundEvent: (observer: (event: Event) => void) => notifyKit.onForegroundEvent(observer),
  openNotificationSettings: (...args: Parameters<typeof notifyKit.openNotificationSettings>) =>
    notifyKit.openNotificationSettings(...args),
  requestPermission: (...args: Parameters<typeof notifyKit.requestPermission>) =>
    notifyKit.requestPermission(...args),
} as const;

export {
  AlarmType,
  AndroidCategory,
  AndroidGroupAlertBehavior,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  EventType,
  TriggerType,
};
export type {
  DisplayedNotification,
  Event,
  EventDetail,
  InitialNotification,
  Notification,
  TimestampTrigger,
  TriggerNotification,
};
