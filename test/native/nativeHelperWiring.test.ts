import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const kotlin = (path: string): string =>
  readFileSync(resolve(repoRoot, 'modules', path), 'utf8').replace(/\s+/g, ' ');

/**
 * The JVM tests cover pure helpers; these pins keep production calling those exact helpers the
 * right way. Review M173 was precisely a tested helper that production never called.
 */
describe('production wiring of JVM-tested native helpers', () => {
  it('checks every shared URI with the tested content-URI policy, parts in order (M173)', () => {
    const manager = kotlin(
      'gator-share-intake/android/src/main/java/expo/modules/gatorshareintake/GatorShareIntakeManager.kt',
    );
    const add = manager.slice(manager.indexOf('fun add(uri: Uri?)'));
    const check = add.indexOf(
      'requireSupportedShareContentUri( uri.toString(), uri.scheme, uri.isHierarchical, uri.authority, )',
    );
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(add.indexOf('requireForeignShareProvider('));
    expect(check).toBeLessThan(add.indexOf('uris.putIfAbsent('));
  });

  it('streams every download through the tested bounded copy, then syncs it (M165)', () => {
    const module = kotlin(
      'gator-bounded-download/android/src/main/java/expo/modules/gatorboundeddownload/GatorBoundedDownloadModule.kt',
    );
    expect(module).toContain(
      'copyBoundedDownloadBody( input = input, output = output, maxBytes = maxBytes, ' +
        'deadlineMs = deadline, clock = SystemClock::elapsedRealtime, ' +
        'isCancelled = { state.cancelled }, abort = { call.cancel() }, ' +
        'onProgress = { loaded -> emitProgress(requestId, loaded, declaredBytes) }, ' +
        ').also { output.flush() output.fd.sync() }',
    );
    expect(module).toContain('val deadline = SystemClock.elapsedRealtime() + timeoutMs');
  });
});
