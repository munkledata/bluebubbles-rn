import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const kotlinRoot = resolve(
  repoRoot,
  'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput',
);
const moduleSource = readFileSync(resolve(kotlinRoot, 'GatorPasteInputModule.kt'), 'utf8');
const policySource = readFileSync(resolve(kotlinRoot, 'PasteBatchPolicy.kt'), 'utf8');
const moduleConfig = readFileSync(
  resolve(repoRoot, 'modules/gator-paste-input/expo-module.config.json'),
  'utf8',
);
const serviceSource = readFileSync(resolve(repoRoot, 'src/services/paste/pasteInput.ts'), 'utf8');

describe('owned rich-paste native boundary', () => {
  it('pins count, per-file, aggregate, and absolute batch limits', () => {
    expect(policySource).toMatch(/MAX_PASTED_FILES = 10\b/);
    expect(policySource).toMatch(/MAX_PASTED_FILE_BYTES = 128L \* 1024 \* 1024\b/);
    expect(policySource).toMatch(/MAX_PASTED_BATCH_BYTES = 512L \* 1024 \* 1024\b/);
    expect(policySource).toMatch(/PASTE_BATCH_TIMEOUT_MS = 60_000L\b/);
    expect(policySource).toMatch(/PASTE_CACHE_MAX_BYTES = 1024L \* 1024 \* 1024\b/);
    expect(policySource).toMatch(/PASTE_CACHE_MAX_BATCHES = 32\b/);
    expect(policySource).toMatch(/PASTE_CACHE_MAX_ROOT_ENTRIES = 64\b/);
    expect(policySource).toMatch(/remaining \+ 1L/);
  });

  it('rejects count on the UI callback before any provider work is submitted', () => {
    const receive = moduleSource.slice(
      moduleSource.indexOf('private fun onReceive'),
      moduleSource.indexOf('private fun submit'),
    );
    expect(receive.indexOf('count !in 1..MAX_PASTED_FILES')).toBeGreaterThanOrEqual(0);
    expect(receive.indexOf('count !in 1..MAX_PASTED_FILES')).toBeLessThan(
      receive.indexOf('submit(batch)'),
    );
    expect(receive).toContain('isSupportedPasteUriScheme(it.scheme)');
    expect(receive.indexOf('isSupportedPasteUriScheme(it.scheme)')).toBeLessThan(
      receive.indexOf('submit(batch)'),
    );
    expect(receive).not.toMatch(
      /contentResolver|resolver\.(?:query|getType|openInputStream|openAssetFileDescriptor)/,
    );
  });

  it('accepts only content-provider schemes and rejects direct file/resource sources', () => {
    expect(policySource).toContain(
      'isSupportedPasteUriScheme(scheme: String?): Boolean = scheme == "content"',
    );
    expect(policySource).not.toMatch(/scheme\s*==\s*"file"|scheme\s*==\s*"android\.resource"/);
  });

  it('uses one bounded worker and one cancellable deadline for the whole batch', () => {
    expect(moduleSource).toMatch(/ThreadPoolExecutor\(\s*1,\s*1,/s);
    expect(moduleSource).toMatch(/ArrayBlockingQueue\(MAX_QUEUED_BATCHES\)/);
    expect(moduleSource).toMatch(/receivedAtElapsedMs \+ PASTE_BATCH_TIMEOUT_MS/);
    expect(moduleSource).toMatch(/CancellationSignal\(\)/);
    expect(moduleSource).toMatch(/openAssetFileDescriptor\([\s\S]*deadline\.cancellationSignal/);
    expect(moduleSource).toMatch(/activeStream\.getAndSet\(null\).*stream\.close\(\)/s);
  });

  it('reserves the global cache budget before touching any provider', () => {
    const process = moduleSource.slice(
      moduleSource.indexOf('private fun processBatch'),
      moduleSource.indexOf('private fun queryMetadata'),
    );
    expect(process).toMatch(/inspectPasteCacheRoot/);
    expect(process).toMatch(/availablePasteBatchBytes/);
    expect(process).toMatch(/maxBatchBytes = cacheAllowance/);
    expect(process.indexOf('inspectPasteCacheRoot')).toBeLessThan(process.indexOf('queryMetadata'));
    expect(policySource).toMatch(/PasteBatchFailure\.CACHE_QUOTA/);
    expect(policySource).toMatch(/canonical\.path == file\.absoluteFile\.path/);
    expect(policySource).toContain('Regex("^\\\\d+$")');
    expect(policySource.indexOf('firstPass.size > maxRootEntries')).toBeLessThan(
      policySource.indexOf('firstPass.forEach'),
    );
  });

  it('retains and explicitly releases the AndroidX IME permission token', () => {
    expect(moduleSource).toContain('androidx.core.view.extra.INPUT_CONTENT_INFO');
    expect(moduleSource).toMatch(/InputContentInfo/);
    expect(moduleSource).toMatch(/info\.releasePermission\(\)/);
    expect(moduleSource).toMatch(/contentAnchor = AtomicReference<ContentInfoCompat\?>\(anchor\)/);
    expect(moduleSource).toMatch(/contentAnchor\.getAndSet\(null\)/);
    expect(moduleSource).toContain('capturePermissionLease(payload)');
    expect(moduleSource).toMatch(/batch\.permission\.release\(\)/);
  });

  it('publishes a complete directory atomically and deletes every failed partial', () => {
    expect(policySource).toMatch(/"\$batchId\.pending"/);
    expect(policySource).toMatch(/items\.size != expectedCount/);
    expect(policySource).toMatch(/pending\.renameTo\(committed\)/);
    expect(policySource).toMatch(/deleteOwnedPasteBatchDirectory\(pending, allowEmpty = true\)/);
    expect(policySource).toMatch(/deleteOwnedPasteBatchDirectory\(committed, allowEmpty = true\)/);
    expect(`${moduleSource}\n${policySource}`).not.toMatch(/deleteRecursively/);
  });

  it('age-deletes only batches absent from a validated durable-reference snapshot', () => {
    expect(policySource).toMatch(/PASTE_CACHE_MAX_AGE_MS = 24L \* 60 \* 60 \* 1000\b/);
    expect(policySource).toMatch(/stamp < cutoff && files\.none \{ it\.path in protectedPaths \}/);
    expect(moduleSource).toContain(
      'AsyncFunction("attach") { tag: Int, protectedUris: List<String> ->',
    );
    expect(moduleSource).toContain('resolveProtectedPastePaths(pasteRoot, protectedUris)');
    expect(moduleSource).toContain('Uri.fromFile(File(canonicalPath)).toString() == rawUri');
    expect(moduleSource).toMatch(
      /inspectPasteCacheRoot\([\s\S]*System\.currentTimeMillis\(\),[\s\S]*protectionSnapshot/,
    );
    expect(serviceSource).toContain('listPastedAttachmentProtectionPaths(getDatabase())');
    expect(serviceSource).toContain('native.attach(tag, protectedUris)');
  });

  it('rechecks the absolute deadline immediately before publication and reports failure', () => {
    const submit = moduleSource.slice(
      moduleSource.indexOf('private fun submit'),
      moduleSource.indexOf('private fun processBatch'),
    );
    const emit = moduleSource.slice(
      moduleSource.indexOf('private fun emitCommitted'),
      moduleSource.indexOf('private fun emitRejected'),
    );
    expect(emit.indexOf('requirePasteDeadline')).toBeGreaterThan(
      emit.indexOf('batch.items.forEach'),
    );
    expect(emit.indexOf('requirePasteDeadline')).toBeLessThan(
      emit.indexOf('sendEvent(EVENT_PASTE'),
    );
    expect(submit).toMatch(
      /!emitCommitted[\s\S]*deleteCommittedBatchBestEffort[\s\S]*emitRejected/,
    );
  });

  it('does not reactivate generic ACTION_SEND intake', () => {
    expect(`${moduleSource}\n${policySource}\n${moduleConfig}`).not.toMatch(
      /ACTION_SEND|SEND_MULTIPLE|android\.intent\.action\.SEND/,
    );
    expect(moduleConfig).not.toMatch(/intentFilters|share-target/i);
  });
});
