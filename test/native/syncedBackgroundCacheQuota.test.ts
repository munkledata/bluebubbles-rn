import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const kotlinRoot = resolve(
  repoRoot,
  'modules/gator-bounded-download/android/src/main/java/expo/modules/gatorboundeddownload',
);
const moduleSource = readFileSync(resolve(kotlinRoot, 'GatorBoundedDownloadModule.kt'), 'utf8');
const policySource = readFileSync(resolve(kotlinRoot, 'SyncedBackgroundCachePolicy.kt'), 'utf8');
const serviceSource = readFileSync(
  resolve(repoRoot, 'src/services/backgrounds/syncedBackground.ts'),
  'utf8',
);

describe('synced-background global disk quota contract', () => {
  it('pins one native-owned 100 MiB and 256-file global budget', () => {
    expect(policySource).toMatch(/SYNCED_BACKGROUND_CACHE_MAX_BYTES = 100L \* 1024 \* 1024\b/);
    expect(policySource).toMatch(/SYNCED_BACKGROUND_CACHE_MAX_FILES = 256\b/);
    expect(serviceSource).toMatch(/SYNCED_BACKGROUND_CACHE_MAX_BYTES = 100 \* 1024 \* 1024\b/);
    expect(serviceSource).toMatch(/SYNCED_BACKGROUND_CACHE_MAX_FILES = 256\b/);
  });

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

  it('recognizes canonical current and legacy media JPEGs and never recursively deletes', () => {
    expect(policySource).toContain('Regex("^generation-\\\\d+$")');
    expect(policySource).toContain('Regex("^media-[^/]+\\\\.jpg$")');
    expect(policySource).toContain('Regex("^[A-Za-z0-9._-]+\\\\.jpg$")');
    expect(policySource).toMatch(/canonical\.path == file\.absoluteFile\.path/);
    expect(policySource).toMatch(/canonicalChild\.parentFile\?\.path != canonicalGeneration\.path/);
    expect(policySource).not.toMatch(/deleteRecursively|walkTopDown|walkBottomUp/);
  });

  it('keeps survivor metadata bounded and serializes service work for an immediate hard cap', () => {
    expect(policySource).toMatch(/SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS = 0L\b/);
    expect(serviceSource).toMatch(/SYNCED_BACKGROUND_MAX_CONCURRENT = 1\b/);
    expect(policySource).toMatch(/PriorityQueue\(oldestFirst\)/);
    expect(policySource).toMatch(/HashSet<String>\(selectedOld\.size\)/);
    expect(policySource).toMatch(/entry\.modifiedAtMs >= recentCutoffMs/);
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

  it('runs after a committed URI and queues startup pruning through the shared slot', () => {
    expect(serviceSource).toMatch(/await pruneSyncedBackgroundCacheBestEffort\(dest\.uri\)/);
    expect(serviceSource).toMatch(
      /startupCacheMaintenance \?\?= withBackgroundWorkSlot\(\(\) =>\s*pruneSyncedBackgroundCacheBestEffort\(null\),?\s*\)/,
    );
  });

  it('coalesces, serializes, and generation-bounds delayed repair', () => {
    expect(serviceSource).toMatch(
      /SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS\s*=\s*\n?\s*SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS \+ 1_000/,
    );
    expect(serviceSource).toMatch(/SYNCED_BACKGROUND_CACHE_REPAIR_MAX_ATTEMPTS = 2\b/);
    expect(serviceSource).toMatch(
      /if \(!result\.withinQuota\) scheduleSyncedBackgroundQuotaRepair\(\)/,
    );
    expect(serviceSource).toMatch(/clearTimeout\(quotaRepairTimer\)/);
    expect(serviceSource).toMatch(/pruneNativeSyncedBackgroundCache\(null\)/);
    expect(serviceSource).toMatch(/quotaRepairGeneration \+= 1/);
    expect(serviceSource).toMatch(/void withBackgroundWorkSlot\(async \(\) =>/);
    expect(serviceSource).toMatch(/generation !== quotaRepairGeneration/);
    expect(serviceSource).toMatch(
      /catch\(\(error: unknown\).*quotaRepairAttemptsRemaining > 0\) armSyncedBackgroundQuotaRepair\(generation\)/s,
    );
  });
});
