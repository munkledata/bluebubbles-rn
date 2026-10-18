import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const kotlinRoot = resolve(
  repoRoot,
  'modules/gator-bounded-download/android/src/main/java/expo/modules/gatorboundeddownload',
);
const moduleSource = readFileSync(resolve(kotlinRoot, 'GatorBoundedDownloadModule.kt'), 'utf8');
const policySource = readFileSync(resolve(kotlinRoot, 'SyncedBackgroundCachePolicy.kt'), 'utf8');

/**
 * Native structure the Kotlin unit tests cannot see: the bridge shape, API-level guards and the
 * absence of recursive or unbounded file APIs. The shared constants are compared in
 * nativeLimitDrift.test.ts and the service's repair behavior in syncedBackgroundCacheRepair.test.ts
 * (review M206).
 */
describe('synced-background native cache contract', () => {
  it('does not expose a caller-selected root or quota through the native bridge', () => {
    expect(moduleSource).toMatch(
      /AsyncFunction\("pruneSyncedBackgroundCache"\) \{ keepUri: String\? ->/,
    );
    expect(moduleSource).toMatch(/File\(context\.filesDir, SYNCED_BACKGROUND_CACHE_DIRECTORY\)/);
    const bridge = moduleSource.slice(
      moduleSource.indexOf('AsyncFunction("pruneSyncedBackgroundCache")'),
      moduleSource.indexOf('OnDestroy'),
    );
    expect(bridge).not.toMatch(/rootUri|maxBytesValue|maxFilesValue/);
  });

  it('strictly streams canonical current and legacy media JPEGs without recursive deletion', () => {
    expect(policySource).toContain('isAttachmentCacheGenerationSegment(value)');
    expect(policySource).toContain('isEncodedMediaSegment(value.dropLast(4))');
    expect(policySource).toContain('Regex("^[A-Za-z0-9._-]+\\\\.jpg$")');
    expect(policySource).toContain('fileSystem.openDirectory(directory)');
    expect(policySource).toContain('fileSystem.inspect(file)');
    expect(policySource).toContain('requireKeepConsistency(final');
    expect(policySource).not.toMatch(/listFiles\(/);
    expect(policySource).not.toMatch(/deleteRecursively|walkTopDown|walkBottomUp/);
  });

  // minSdk 36 always has the API-26 DirectoryStream, so there is no version check or fallback to
  // an unbounded File.listFiles array (review M163).
  it('streams directories for prune and admission with no Android-version fallback', () => {
    const pruneBridge = moduleSource.slice(
      moduleSource.indexOf('AsyncFunction("pruneSyncedBackgroundCache")'),
      moduleSource.indexOf('AsyncFunction("prepareSyncedBackgroundCacheForDownload")'),
    );
    const admissionBridge = moduleSource.slice(
      moduleSource.indexOf('AsyncFunction("prepareSyncedBackgroundCacheForDownload")'),
      moduleSource.indexOf('AsyncFunction("deleteSyncedBackgroundCacheFile")'),
    );
    for (const bridge of [pruneBridge, admissionBridge]) {
      expect(bridge).toContain('newBoundedDirectoryStreamFileSystem()');
      expect(bridge).not.toMatch(/listFiles\(/);
    }
    expect(moduleSource).not.toMatch(/Build\.VERSION/);
  });

  it('keeps survivor metadata bounded', () => {
    expect(policySource).toMatch(/PriorityQueue\(oldestFirst\)/);
    expect(policySource).toMatch(/HashSet<String>\(selectedOld\.size\)/);
    expect(policySource).not.toMatch(/\.toList\(\)|\.sorted(?:By)?\(/);
  });

  it('retires a DB-provided URI only through a canonical native non-recursive file delete', () => {
    expect(moduleSource).toMatch(/AsyncFunction\("deleteSyncedBackgroundCacheFile"\)/);
    expect(moduleSource).toMatch(/Uri\.fromFile\(target\)\.toString\(\) == rawUri/);
    expect(moduleSource).toMatch(/!target\.isFile/);
    expect(moduleSource).toMatch(/target\.delete\(\) \|\| !target\.exists\(\)/);
    expect(policySource).toMatch(/requireOwnedSyncedBackgroundRetirementPath/);
    const retirementBridge = moduleSource.slice(
      moduleSource.indexOf('AsyncFunction("deleteSyncedBackgroundCacheFile")'),
      moduleSource.indexOf('OnDestroy'),
    );
    expect(retirementBridge).not.toMatch(/deleteRecursively/);
  });
});
