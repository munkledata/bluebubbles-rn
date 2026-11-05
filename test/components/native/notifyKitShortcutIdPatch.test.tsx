/**
 * patches/react-native-notify-kit+10.4.8.patch: the library's native side applies
 * `android.shortcutId` (NotificationManager.java), but its JS validator copied only known fields
 * and dropped it, so a notification could never become an Android conversation. The patch passes a
 * bounded string through. This drives the REAL validator, not the test mock.
 */
import validateAndroidNotification from 'react-native-notify-kit/dist/validators/validateAndroidNotification.js';

const base = { channelId: 'messages' };

describe('notify-kit shortcutId patch', () => {
  it('passes a valid shortcut id through to the native payload', () => {
    expect(validateAndroidNotification({ ...base, shortcutId: 'gsc1_token' }).shortcutId).toBe(
      'gsc1_token',
    );
  });

  it('leaves it out when not given', () => {
    expect(validateAndroidNotification(base)).not.toHaveProperty('shortcutId');
  });

  it.each([[''], ['x'.repeat(257)], [42], [null]])('rejects %p', (bad) => {
    expect(() =>
      validateAndroidNotification({ ...base, shortcutId: bad as unknown as string }),
    ).toThrow("'notification.android.shortcutId' expected a non-empty string");
  });
});
