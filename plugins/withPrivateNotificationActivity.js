const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const NOTIFICATION_RECEIVER_ACTIVITY = 'app.notifee.core.NotificationReceiverActivity';

function applyPrivateNotificationActivity(androidManifest) {
  AndroidConfig.Manifest.ensureToolsAvailable(androidManifest);
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const activities = (application.activity ??= []);
  const declared = activities.filter(
    (activity) => activity.$?.['android:name'] === NOTIFICATION_RECEIVER_ACTIVITY,
  );
  if (declared.length > 1) {
    throw new Error(
      `withPrivateNotificationActivity: ${NOTIFICATION_RECEIVER_ACTIVITY} is declared twice`,
    );
  }

  const activity = declared[0] ?? { $: { 'android:name': NOTIFICATION_RECEIVER_ACTIVITY } };
  if (!declared[0]) activities.push(activity);
  activity.$['android:exported'] = 'false';
  activity.$['tools:replace'] = 'android:exported';
  return androidManifest;
}

/**
 * Make notify-kit's NotificationReceiverActivity private.
 *
 * The library declares it `android:exported="true"` with no permission, so any installed app
 * could launch it with a forged notification payload and make Gator reply, mark a chat read or
 * react. Gator's own notification PendingIntents run with Gator's identity, so a non-exported
 * activity still receives every real tap, and action buttons already use the non-exported
 * ReceiverService. `tools:replace` makes this value win the manifest merge;
 * scripts/check-android-build.mjs verifies the merged result.
 */
function withPrivateNotificationActivity(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyPrivateNotificationActivity(cfg.modResults);
    return cfg;
  });
}

module.exports = withPrivateNotificationActivity;
module.exports.NOTIFICATION_RECEIVER_ACTIVITY = NOTIFICATION_RECEIVER_ACTIVITY;
module.exports.applyPrivateNotificationActivity = applyPrivateNotificationActivity;
