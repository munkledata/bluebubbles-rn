import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const kotlinRoot = resolve(
  __dirname,
  '../../modules/gator-screen-security/android/src/main/java/expo/modules/gatorscreensecurity',
);
const read = (file: string): string =>
  readFileSync(resolve(kotlinRoot, file), 'utf8').replace(/\s+/g, ' ');
const controller = read('GatorScreenSecurityModule.kt');
const lifecycle = read('GatorScreenSecurityPackage.kt');

/**
 * Host tests cannot run an Activity, so this pins the window policy left after review M179
 * removed the pre-Android-13 fallback. The phone check is in DEVICE_VERIFICATION_CHECKLIST.md.
 */
describe('App Lock and Secure Screen window policy', () => {
  it('hides Recents for App Lock and leaves FLAG_SECURE to Secure Screen alone', () => {
    const apply = controller.slice(
      controller.indexOf('private fun apply(activity: Activity)'),
      controller.indexOf('fun refresh(activity: Activity)'),
    );
    expect(apply).toContain('activity.setRecentsScreenshotEnabled(!appLockEnabled(activity))');
    expect(apply).toContain('setWindowSecure(activity.window, secureScreen)');
    expect(apply).toContain(
      'extraWindows.forEach { window -> setWindowSecure(window, secureScreen) }',
    );
    expect(controller).not.toMatch(/Build\.VERSION|ForegroundTransition|activityInForeground/);
  });

  it('secures an extra window with no owning Activity until the policy can be applied', () => {
    expect(controller).toContain(
      'extraWindows.add(window) if (activity == null) { // A newly created window with no ' +
        'resolvable owner must not briefly expose content. setWindowSecure(window, true) } ' +
        'else { apply(activity) }',
    );
  });

  it('applies the persisted policy on create, on every resume and on every change', () => {
    expect(lifecycle).toMatch(
      /override fun onCreate\(activity: Activity, savedInstanceState: Bundle\?\) \{ ScreenSecurityController\.refresh\(activity\) \}/,
    );
    expect(lifecycle).toMatch(
      /override fun onResume\(activity: Activity\) \{ ScreenSecurityController\.refresh\(activity\) \}/,
    );
    for (const key of ['APP_LOCK_ENABLED', 'SECURE_SCREEN_ENABLED']) {
      expect(controller).toContain(`persist(activity, ${key}, enabled) apply(activity)`);
    }
  });
});
