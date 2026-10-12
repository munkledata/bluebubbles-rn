import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const moduleSource = readFileSync(
  resolve(
    repoRoot,
    'modules/gator-bounded-download/android/src/main/java/expo/modules/gatorboundeddownload/GatorBoundedDownloadModule.kt',
  ),
  'utf8',
);

/** The source of one Kotlin function, from its signature to the next member declaration. */
function kotlinFunction(name: string): string {
  const start = moduleSource.indexOf(`private fun ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = moduleSource.indexOf('\n  private fun ', start + 1);
  return moduleSource.slice(start, next === -1 ? undefined : next);
}

// Host tests cannot run android.system.Os, so this pins the shape of the fix. On Android,
// FileInputStream/FileOutputStream(FileDescriptor) do not own the descriptor: closing the streams
// left both open after every successful copy, keeping deleted share files' space allocated.
it('closes both shared-attachment copy descriptors on every path, not only on failure', () => {
  const copy = kotlinFunction('copyOwnedSharedAttachment');
  const finallyAt = copy.indexOf('} finally {');
  expect(finallyAt).toBeGreaterThan(copy.indexOf('FileInputStream(sourceDescriptor)'));

  // The finally block ends at its own closing brace, indented like the `try`.
  const cleanup = copy.slice(finallyAt, copy.indexOf('\n    }\n', finallyAt));
  expect(cleanup).toContain('Os.close(sourceDescriptor)');
  expect(cleanup).toContain('Os.close(destinationDescriptor)');
});
