import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  nativeCompilerPathMappingFlags,
  runAndroidNativePathCheck,
} from './check-android-native-paths.mjs';

function fixture(t) {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gator-native-paths-')));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const root = join(temporaryRoot, 'source');
  const gradleHome = join(temporaryRoot, 'gradle-home');
  const bundle = join(root, 'android/app/build/outputs/bundle/release/app-release.aab');
  mkdirSync(root);
  mkdirSync(gradleHome);
  mkdirSync(join(root, 'android/app/build/outputs/bundle/release'), { recursive: true });
  writeFileSync(bundle, 'fixture-aab');
  return { root, gradleHome, bundle };
}

function writeCompileDatabase(
  fixtureState,
  relativeOwner,
  {
    configuration = 'RelWithDebInfo',
    flags = nativeCompilerPathMappingFlags({
      sourceRoot: fixtureState.root,
      gradleHome: fixtureState.gradleHome,
    }),
    records,
  } = {},
) {
  const source = join(fixtureState.root, relativeOwner, 'src/main.cpp');
  const directory = join(
    fixtureState.root,
    relativeOwner,
    '.cxx',
    configuration,
    'fingerprint',
    'arm64-v8a',
  );
  const database = join(directory, 'compile_commands.json');
  mkdirSync(join(fixtureState.root, relativeOwner, 'src'), { recursive: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(source, 'int main() { return 0; }\n');
  writeFileSync(
    database,
    JSON.stringify(
      records ?? [
        {
          directory,
          command: `clang++ ${flags.join(' ')} -c ${source}`,
          file: source,
        },
      ],
    ),
  );
  return { database, directory, source };
}

function checkFixture(fixtureState, overrides = {}) {
  return runAndroidNativePathCheck({
    root: fixtureState.root,
    sourceRoot: fixtureState.root,
    gradleHome: fixtureState.gradleHome,
    releaseBundlePath: fixtureState.bundle,
    ...overrides,
  });
}

test('builds exact source and Gradle file/debug prefix-map flags', () => {
  assert.deepEqual(
    nativeCompilerPathMappingFlags({
      sourceRoot: '/private/tmp/gator/source',
      gradleHome: '/private/tmp/gator/gradle',
    }),
    [
      '-ffile-prefix-map=/private/tmp/gator/source=/gator/source',
      '-fdebug-prefix-map=/private/tmp/gator/source=/gator/source',
      '-ffile-prefix-map=/private/tmp/gator/gradle=/gator/gradle',
      '-fdebug-prefix-map=/private/tmp/gator/gradle=/gator/gradle',
    ],
  );
  assert.throws(
    () => nativeCompilerPathMappingFlags({ sourceRoot: 'relative', gradleHome: '/private/gradle' }),
    /absolute path/,
  );
  assert.throws(
    () =>
      nativeCompilerPathMappingFlags({
        sourceRoot: '/private/path with space',
        gradleHome: '/private/gradle',
      }),
    /whitespace/,
  );
});

test('checks every command in every discovered release compile database', (t) => {
  const state = fixture(t);
  writeCompileDatabase(state, 'android/app');
  const second = writeCompileDatabase(state, 'node_modules/example/android', {
    configuration: 'Release',
  });

  const result = checkFixture(state);
  assert.equal(result.compileDatabases, 2);
  assert.equal(result.compileCommands, 2);

  const flags = nativeCompilerPathMappingFlags({
    sourceRoot: state.root,
    gradleHome: state.gradleHome,
  });
  writeFileSync(
    second.database,
    JSON.stringify([
      {
        directory: second.directory,
        command: `clang++ ${flags.slice(0, -1).join(' ')} -c ${second.source}`,
        file: second.source,
      },
    ]),
  );
  assert.throws(() => checkFixture(state), /missing required compiler flag -fdebug-prefix-map=/);

  for (const extraFlag of [flags[0], `-ffile-prefix-map=${state.root}=/conflicting/source`]) {
    writeFileSync(
      second.database,
      JSON.stringify([
        {
          directory: second.directory,
          command: `clang++ ${flags.join(' ')} ${extraFlag} -c ${second.source}`,
          file: second.source,
        },
      ]),
    );
    assert.throws(() => checkFixture(state), /conflicting or duplicate compiler path map/);
  }

  writeFileSync(
    second.database,
    JSON.stringify([
      {
        directory: second.directory,
        command: `clang++ ${flags.join(' ')} -fdebug-prefix-map=/private/tmp=/unreviewed -c ${second.source}`,
        file: second.source,
      },
    ]),
  );
  assert.throws(() => checkFixture(state), /unexpected compiler path map/);
});

test('rejects absent, malformed, ambiguous, and oversized compile databases', (t) => {
  const state = fixture(t);
  assert.throws(() => checkFixture(state), /no release compile_commands/);

  const written = writeCompileDatabase(state, 'android/app');
  writeFileSync(written.database, '{');
  assert.throws(() => checkFixture(state), /malformed JSON/);

  writeFileSync(
    written.database,
    JSON.stringify([
      {
        directory: written.directory,
        command: 'clang++',
        arguments: ['clang++'],
        file: written.source,
      },
    ]),
  );
  assert.throws(() => checkFixture(state), /exactly one of command or arguments/);

  truncateSync(written.database, 65);
  assert.throws(
    () => checkFixture(state, { maximumDatabaseBytes: 64 }),
    /exceeds its 64-byte limit/,
  );
});

test('rejects stale, future, and different-tree compile evidence', (t) => {
  const state = fixture(t);
  const written = writeCompileDatabase(state, 'android/app');
  const now = Date.now();
  const stale = new Date(now - 10_000);
  const fresh = new Date(now);
  utimesSync(written.database, stale, stale);
  utimesSync(state.bundle, fresh, fresh);
  assert.throws(
    () => checkFixture(state, { nowMs: now, maximumProofAgeMs: 1_000 }),
    /stale relative to the release AAB/,
  );

  utimesSync(written.database, fresh, fresh);
  const future = new Date(now + 10_000);
  utimesSync(state.bundle, future, future);
  assert.throws(() => checkFixture(state, { nowMs: now }), /future modification time/);

  utimesSync(state.bundle, fresh, fresh);
  const flags = nativeCompilerPathMappingFlags({
    sourceRoot: state.root,
    gradleHome: state.gradleHome,
  });
  writeFileSync(
    written.database,
    JSON.stringify([
      {
        directory: state.gradleHome,
        arguments: ['clang++', ...flags, '-c', written.source],
        file: written.source,
      },
    ]),
  );
  assert.throws(() => checkFixture(state), /belongs to a different source tree/);
});

test('refuses symbolic links inside native build metadata', (t) => {
  const state = fixture(t);
  const written = writeCompileDatabase(state, 'android/app');
  const target = join(state.root, 'outside.json');
  writeFileSync(target, '[]');
  rmSync(written.database);
  symlinkSync(target, written.database);

  assert.throws(() => checkFixture(state), /symbolic link is not allowed/);
});
