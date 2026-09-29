import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../../app.config';

const repoRoot = resolve(__dirname, '../..');
const packageJson = require('../../package.json') as {
  dependencies?: Record<string, string>;
};
const packageLock = require('../../package-lock.json') as unknown;

function pluginName(plugin: NonNullable<typeof config.plugins>[number]): string {
  return Array.isArray(plugin) ? (plugin[0] ?? '') : plugin;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('IPC-01 inbound-share containment', () => {
  it('keeps the unsafe community intake package absent', () => {
    expect(packageJson.dependencies?.['expo-share-intent']).toBeUndefined();
    expect(JSON.stringify(packageLock)).not.toContain('expo-share-intent');
    expect((config.plugins ?? []).map(pluginName)).not.toContain('expo-share-intent');
  });

  it('configures the owned manifest plugin exactly once', () => {
    const plugins = (config.plugins ?? []).map(pluginName);
    expect(plugins.filter((plugin) => plugin === './plugins/withShareTargets')).toHaveLength(1);

    const plugin = require('../../plugins/withShareTargets') as {
      INBOUND_SHARE_ACTIONS: string[];
      SHARE_TARGET_CATEGORY: string;
      SHORTCUTS_XML: string;
      ON_CREATE_CAPTURE: string;
      ON_NEW_INTENT_CAPTURE: string;
      applyShareIntentManifestPolicy: (activity: Record<string, unknown>) => void;
      applyMainActivityShareCapture: (source: string) => string;
    };
    const activity: Record<string, unknown> = {
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
          category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
        },
      ],
    };
    plugin.applyShareIntentManifestPolicy(activity);
    plugin.applyShareIntentManifestPolicy(activity);

    const filters = activity['intent-filter'] as Array<{
      action: Array<{ $: { 'android:name': string } }>;
      category: Array<{ $: { 'android:name': string } }>;
      data?: Array<{ $: { 'android:mimeType': string } }>;
    }>;
    for (const action of plugin.INBOUND_SHARE_ACTIONS) {
      const matches = filters.filter((filter) => filter.action[0]?.$['android:name'] === action);
      expect(matches).toEqual([
        {
          action: [{ $: { 'android:name': action } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [{ $: { 'android:mimeType': '*/*' } }],
        },
      ]);
    }
    expect(activity['meta-data']).toEqual([
      { $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' } },
    ]);
    expect(plugin.SHORTCUTS_XML).toContain(
      'android:targetClass="com.bluegreengatorapps.messages.MainActivity"',
    );
    expect(plugin.SHORTCUTS_XML).toContain('android:mimeType="*/*"');
    expect(plugin.SHORTCUTS_XML).toContain(`android:name="${plugin.SHARE_TARGET_CATEGORY}"`);

    const generated = plugin.applyMainActivityShareCapture(`
class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    prepareSplash()
    super.onCreate(null)
  }
}
`);
    expect(plugin.applyMainActivityShareCapture(generated)).toBe(generated);
    expect(generated.split(plugin.ON_CREATE_CAPTURE)).toHaveLength(2);
    expect(generated.split(plugin.ON_NEW_INTENT_CAPTURE)).toHaveLength(2);
    expect(generated.indexOf(plugin.ON_CREATE_CAPTURE)).toBeLessThan(
      generated.indexOf('prepareSplash()'),
    );
    expect(generated.indexOf(plugin.ON_CREATE_CAPTURE)).toBeLessThan(
      generated.indexOf('super.onCreate('),
    );
    expect(generated.indexOf(plugin.ON_NEW_INTENT_CAPTURE)).toBeLessThan(
      generated.indexOf('super.onNewIntent('),
    );
  });

  it('autolinks the owned native bridge module', () => {
    const moduleConfig = JSON.parse(
      readFileSync(resolve(repoRoot, 'modules/gator-share-intake/expo-module.config.json'), 'utf8'),
    ) as { platforms?: string[]; android?: { modules?: string[] } };
    expect(moduleConfig).toEqual({
      platforms: ['android'],
      android: { modules: ['expo.modules.gatorshareintake.GatorShareIntakeModule'] },
    });

    const moduleSource = readFileSync(
      resolve(
        repoRoot,
        'modules/gator-share-intake/android/src/main/java/expo/modules/gatorshareintake/GatorShareIntakeModule.kt',
      ),
      'utf8',
    );
    expect(moduleSource).toMatch(/Name\("GatorShareIntake"\)/);
    expect(moduleSource).toMatch(/AsyncFunction\("takeNext"\)/);
  });

  it('does not import the unsafe package anywhere in production TypeScript', () => {
    const files = [
      ...sourceFiles(resolve(repoRoot, 'app')),
      ...sourceFiles(resolve(repoRoot, 'src')),
    ];
    const offenders = files.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return /(?:from\s*|require\s*\()\s*['"]expo-share-intent['"]/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps provider URIs and provider-copy APIs out of the active JavaScript boundary', () => {
    for (const path of [
      resolve(repoRoot, 'src/native/shareIntake.ts'),
      resolve(repoRoot, 'src/services/share/shareIntake.ts'),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/content:\/\/|ContentResolver|copyAsync|expo-share-intent/);
    }
    const nativeBridge = readFileSync(resolve(repoRoot, 'src/native/shareIntake.ts'), 'utf8');
    expect(nativeBridge).toMatch(/requireOptionalNativeModule.*GatorShareIntake/s);
    expect(nativeBridge).toMatch(/\/shared-in\/files\//);
  });
});
