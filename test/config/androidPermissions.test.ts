import config from '../../app.config';

const directPermissions = config.android?.permissions ?? [];
const blockedPermissions = config.android?.blockedPermissions ?? [];

function pluginOptions(name: string): Record<string, unknown> | undefined {
  const entry = config.plugins?.find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) && plugin[0] === name,
  );
  return entry?.[1];
}

describe('Android permission containment', () => {
  it('disables Android app-data backup at the Expo manifest source', () => {
    expect(config.android?.allowBackup).toBe(false);
  });

  it('does not request the direct battery-optimization exemption permission', () => {
    expect(directPermissions).not.toContain(
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    );
  });

  it('blocks permissions not backed by a Gator user flow', () => {
    expect(blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.WRITE_CONTACTS',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.ACCESS_NOTIFICATION_POLICY',
        'android.permission.SCHEDULE_EXACT_ALARM',
        'android.permission.USE_EXACT_ALARM',
      ]),
    );
  });

  it('configures expo-media-library for photo/video reads only', () => {
    expect(pluginOptions('expo-media-library')?.granularPermissions).toEqual(['photo', 'video']);
  });
});
