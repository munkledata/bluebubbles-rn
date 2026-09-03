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
  it('does not install or configure the unsafe native intake package', () => {
    expect(packageJson.dependencies?.['expo-share-intent']).toBeUndefined();
    expect(JSON.stringify(packageLock)).not.toContain('expo-share-intent');
    expect((config.plugins ?? []).map(pluginName)).not.toContain('expo-share-intent');
  });

  it('does not configure generic or Direct Share manifest declarations', () => {
    const plugins = (config.plugins ?? []).map(pluginName);
    expect(plugins).not.toContain('./plugins/withShareTargets');

    const filters = config.android?.intentFilters ?? [];
    const serialized = JSON.stringify(filters);
    expect(serialized).not.toMatch(/android\.intent\.action\.(?:SEND|SEND_MULTIPLE)/);
  });

  it('does not import the native package anywhere in production TypeScript', () => {
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

  it('keeps both root and connected layouts free of capture/provider/navigation mounts', () => {
    const root = readFileSync(resolve(repoRoot, 'app/_layout.tsx'), 'utf8');
    const connected = readFileSync(resolve(repoRoot, 'app/(app)/_layout.tsx'), 'utf8');

    expect(root).not.toMatch(/ShareIntent(?:Provider|Capture)/);
    expect(connected).not.toMatch(/ShareIntentNavigator/);
  });

  it('clears legacy shortcuts from root-owned process boot and never republishes rows', () => {
    const root = readFileSync(resolve(repoRoot, 'app/_layout.tsx'), 'utf8');
    const foregroundBoot = readFileSync(
      resolve(repoRoot, 'src/services/boot/foregroundBoot.ts'),
      'utf8',
    );
    const connected = readFileSync(resolve(repoRoot, 'app/(app)/_layout.tsx'), 'utf8');
    const inbox = readFileSync(
      resolve(repoRoot, 'src/ui/conversations/ConversationListScreen.tsx'),
      'utf8',
    );
    const contacts = readFileSync(
      resolve(repoRoot, 'src/services/contacts/contactsService.ts'),
      'utf8',
    );
    const chatNavigator = readFileSync(resolve(repoRoot, 'src/ui/useChatNavigator.ts'), 'utf8');
    const shortcutBridge = readFileSync(
      resolve(repoRoot, 'src/services/shortcuts/shareShortcuts.ts'),
      'utf8',
    );
    const nativeShortcutBridge = readFileSync(
      resolve(
        repoRoot,
        'modules/gator-share-shortcuts/android/src/main/java/expo/modules/gatorshareshortcuts/GatorShareShortcutsModule.kt',
      ),
      'utf8',
    );

    expect(root).toMatch(/startForegroundBoot\(\)/);
    expect(foregroundBoot).toMatch(/clearShareShortcuts\(\)/);
    expect(connected).not.toMatch(/refreshShareShortcuts/);
    expect(inbox).not.toMatch(/publishShareShortcuts/);
    expect(contacts).not.toMatch(/refreshShareShortcuts/);
    expect(chatNavigator).not.toMatch(/reportChatOpened/);
    expect(shortcutBridge).not.toMatch(/setShareShortcuts/);
    expect(nativeShortcutBridge).toMatch(/Function\("clearShareShortcuts"\)/);
    expect(nativeShortcutBridge).not.toMatch(/runCatching|getOrDefault\(emptyList\(\)\)/);
    for (const marker of [
      'ShortcutManagerCompat.FLAG_MATCH_DYNAMIC',
      'ShortcutManagerCompat.FLAG_MATCH_CACHED',
      'ShortcutManagerCompat.FLAG_MATCH_PINNED',
      'com.bluegreengatorapps.messages.category.RETIRED_SHORTCUT',
      'val before = store.list()',
      'val unsafe = store.list().filter',
      'check(unsafe.isEmpty())',
      'categories == setOf(RETIRED_SHORTCUT_CATEGORY)',
      'IconCompat.createWithResource(context, context.applicationInfo.icon)',
      'val launchIntent = Intent(Intent.ACTION_VIEW)',
      'setPackage(context.packageName)',
      'ShortcutInfoCompat.Builder(context, replacement.id)',
      '.setName(replacement.personName)',
      '.setKey(replacement.personKey)',
      '.setShortLabel(replacement.shortLabel)',
      '.setLongLabel(replacement.longLabel)',
      '.setDisabledMessage(replacement.disabledMessage)',
      '.setIntent(Intent(launchIntent))',
      '.setPerson(person)',
      '.setCategories(setOf(RETIRED_SHORTCUT_CATEGORY))',
      '.setLocusId(LocusIdCompat(replacement.locusId))',
      '.setLongLived(false)',
      '.setExtras(',
      'putString(RETIRED_SHORTCUT_MARKER_KEY, RETIRED_SHORTCUT_MARKER_VALUE)',
      'ShortcutManagerCompat.updateShortcuts(context, retired)',
      'ShortcutManagerCompat.disableShortcuts',
      'ShortcutManagerCompat.removeAllDynamicShortcuts',
      'ShortcutManagerCompat.removeLongLivedShortcuts',
      'clearLegacyShareShortcuts(AndroidLegacyShortcutStore(context))',
    ]) {
      expect(nativeShortcutBridge).toContain(marker);
    }
    expect(nativeShortcutBridge.match(/\.setIcon\(appIcon\)/g)).toHaveLength(2);
    expect(nativeShortcutBridge).not.toMatch(
      /setShareShortcuts|reportShortcutUsed|getLaunchShortcutId|OnNewIntent|ShareShortcutRecord/,
    );
  });
});
