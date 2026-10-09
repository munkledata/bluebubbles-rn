import config from '../../app.config';

type ManifestElement = { $: Record<string, string> };
type AndroidManifest = {
  manifest: {
    $: Record<string, string>;
    application?: (ManifestElement & { activity?: ManifestElement[] })[];
  };
};

const { applyPrivateNotificationActivity, NOTIFICATION_RECEIVER_ACTIVITY } =
  require('../../plugins/withPrivateNotificationActivity') as {
    applyPrivateNotificationActivity: (manifest: AndroidManifest) => AndroidManifest;
    NOTIFICATION_RECEIVER_ACTIVITY: string;
  };

const PRIVATE_ACTIVITY = {
  $: {
    'android:name': 'app.notifee.core.NotificationReceiverActivity',
    'android:exported': 'false',
    'tools:replace': 'android:exported',
  },
};

function manifestWith(activities: ManifestElement[]): AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: { 'android:name': '.MainApplication' }, activity: activities }],
    },
  };
}

describe('private notify-kit notification activity', () => {
  it('registers the managed-project config plugin', () => {
    expect(config.plugins).toContain('./plugins/withPrivateNotificationActivity');
    expect(NOTIFICATION_RECEIVER_ACTIVITY).toBe('app.notifee.core.NotificationReceiverActivity');
  });

  it('overrides the library export with a tools:replace declaration', () => {
    const mainActivity = { $: { 'android:name': '.MainActivity', 'android:exported': 'true' } };
    const manifest = applyPrivateNotificationActivity(manifestWith([mainActivity]));

    expect(manifest.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    expect(manifest.manifest.application?.[0]?.activity).toEqual([mainActivity, PRIVATE_ACTIVITY]);
  });

  it('corrects an existing declaration and stays idempotent', () => {
    const manifest = manifestWith([
      { $: { 'android:name': NOTIFICATION_RECEIVER_ACTIVITY, 'android:exported': 'true' } },
    ]);

    applyPrivateNotificationActivity(manifest);
    applyPrivateNotificationActivity(manifest);

    expect(manifest.manifest.application?.[0]?.activity).toEqual([PRIVATE_ACTIVITY]);
  });

  it('refuses an ambiguous duplicate declaration', () => {
    const declaration = { $: { 'android:name': NOTIFICATION_RECEIVER_ACTIVITY } };

    expect(() =>
      applyPrivateNotificationActivity(manifestWith([declaration, { $: { ...declaration.$ } }])),
    ).toThrow('declared twice');
  });
});
