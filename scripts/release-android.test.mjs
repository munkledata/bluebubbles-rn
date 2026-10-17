import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_UPLOAD_CERTIFICATE_SHA256,
  MANAGED_DIRECTORY_REMOVAL_OPTIONS,
  androidReleaseWorkspacePaths,
  assertSourceVerifiedByCi,
  createAndroidReleaseBuildEnvironment,
  classifyReleaseEvidenceFailure,
  finalizeVerifiedReleaseBuild,
  findLocalBranchObjectId,
  isValidReleaseBuildReceipt,
  isValidReleaseNativePathProof,
  prepareManagedEasDirectory,
  probeReleaseValidationTools,
  requireEnvironmentCredential,
  removeManagedEasDirectory,
  removeRetainedSigningCredentials,
  requireExpectedUploadCertificate,
  retainedWorkspaceNotice,
  stageGoogleServicesFile,
  verifyReleaseNativePathProof,
} from './release-android.mjs';
import { nativeCompilerPathMappingFlags } from './check-android-native-paths.mjs';
import {
  ANDROID_NATIVE_PATH_INIT_SCRIPT,
  installAndroidNativePathInitScript,
} from './android-native-path-init.mjs';

test('requires a nonblank local Maps credential without exposing its value', () => {
  const validKey = `AIza${'B'.repeat(34)}C`;
  assert.equal(
    requireEnvironmentCredential(
      { GOOGLE_MAPS_ANDROID_API_KEY: `  ${validKey}  ` },
      'GOOGLE_MAPS_ANDROID_API_KEY',
    ),
    validKey,
  );
  assert.throws(
    () => requireEnvironmentCredential({}, 'GOOGLE_MAPS_ANDROID_API_KEY'),
    /GOOGLE_MAPS_ANDROID_API_KEY is missing/,
  );
  assert.throws(
    () =>
      requireEnvironmentCredential(
        { GOOGLE_MAPS_ANDROID_API_KEY: 'restricted-map-key' },
        'GOOGLE_MAPS_ANDROID_API_KEY',
      ),
    /must be a valid Google API key/,
  );
  assert.throws(
    () =>
      requireEnvironmentCredential(
        { GOOGLE_MAPS_ANDROID_API_KEY: '   ' },
        'GOOGLE_MAPS_ANDROID_API_KEY',
      ),
    /GOOGLE_MAPS_ANDROID_API_KEY is missing/,
  );
  assert.throws(
    () =>
      requireEnvironmentCredential(
        { GOOGLE_MAPS_ANDROID_API_KEY: `AIza${'A'.repeat(35)}` },
        'GOOGLE_MAPS_ANDROID_API_KEY',
      ),
    /must not use the compile-only CI value/,
  );
});

function git(cwd, args, { input } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('treats a missing slash-containing release branch as absent and resolves it once created', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Gator Release Test']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial']);

  const branch = 'release/android-9.9.9';
  const head = git(root, ['rev-parse', 'HEAD']);
  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), null);

  git(root, ['update-ref', `refs/heads/${branch}`, head]);
  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), head);
});

test('treats an existing branch ref with a non-commit target as present', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-invalid-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  const branch = 'release/android-invalid';
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: 'not a commit' });
  const looseRefDirectory = join(root, '.git', 'refs', 'heads', 'release');
  mkdirSync(looseRefDirectory, { recursive: true });
  writeFileSync(join(looseRefDirectory, 'android-invalid'), `${blob}\n`);

  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), blob);
});

test('fails closed when Git reports a broken release branch ref', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-broken-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  const branch = 'release/android-broken';
  const looseRefDirectory = join(root, '.git', 'refs', 'heads', 'release');
  mkdirSync(looseRefDirectory, { recursive: true });
  writeFileSync(join(looseRefDirectory, 'android-broken'), 'not-an-object-id\n');

  assert.throws(
    () => findLocalBranchObjectId(branch, { cwd: root }),
    /could not determine whether the release branch exists/,
  );
});

test('stages Firebase config under a private relative release-worktree path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-firebase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree');
  const source = join(root, 'firebase-source.json');
  mkdirSync(worktree);
  writeFileSync(source, '{"project_info":{"project_id":"fixture"}}\n');

  const configuredPath = stageGoogleServicesFile(worktree, source);
  const stagedPath = join(worktree, '.gator-release', 'google-services.json');

  assert.equal(configuredPath, './.gator-release/google-services.json');
  assert.equal(readFileSync(stagedPath, 'utf8'), readFileSync(source, 'utf8'));
  assert.equal(statSync(stagedPath).mode & 0o777, 0o600);
  assert.throws(
    () => stageGoogleServicesFile(worktree, source),
    /already contains the reserved Firebase staging directory/,
  );
});

function nativeWorkspaceFixture(t, suffix = '') {
  const temporaryParent = realpathSync(
    mkdtempSync(join(tmpdir(), `gator-release-native-${suffix}`)),
  );
  t.after(() => rmSync(temporaryParent, { recursive: true, force: true }));
  const ownerUid = process.getuid?.();
  assert.equal(Number.isSafeInteger(ownerUid), true);
  return {
    state: { runId: `android-test${suffix}`, workspace: { token: `token${suffix}` } },
    options: { temporaryParent, ownerUid },
  };
}

test('uses one deterministic private run path with separate EAS and Gradle directories', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-layout');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);

  assert.equal(
    paths.container,
    join(
      fixture.options.temporaryParent,
      `gator-android-release-${fixture.options.ownerUid}`,
      fixture.state.runId,
    ),
  );
  assert.equal(paths.work, join(paths.container, 'work'));
  assert.equal(paths.gradleHome, join(paths.container, 'gradle-home'));
  assert.equal(paths.gradleInitDirectory, join(paths.gradleHome, 'init.d'));
  assert.equal(
    paths.nativePathInitScript,
    join(paths.gradleInitDirectory, 'gator-native-path-map.gradle'),
  );
  assert.equal(paths.source, join(paths.work, 'build'));
  for (const directory of [
    paths.root,
    paths.container,
    paths.work,
    paths.gradleHome,
    paths.gradleInitDirectory,
  ]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(statSync(paths.nativePathInitScript).mode & 0o777, 0o600);
  const nativePathInitScript = readFileSync(paths.nativePathInitScript, 'utf8');
  assert.match(nativePathInitScript, /GATOR_NATIVE_PATH_MAP_FLAGS must be set/);
  assert.match(nativePathInitScript, /-DCMAKE_C_FLAGS=\$\{gatorNativePathMapFlags\}/);
  assert.match(nativePathInitScript, /-DCMAKE_CXX_FLAGS=\$\{gatorNativePathMapFlags\}/);
  assert.match(nativePathInitScript, /-DCMAKE_ASM_FLAGS=\$\{gatorNativePathMapFlags\}/);
  assert.equal(statSync(paths.marker).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(paths.marker, 'utf8')), {
    schemaVersion: 2,
    runId: fixture.state.runId,
    token: fixture.state.workspace.token,
    ownerUid: fixture.options.ownerUid,
  });

  const environment = createAndroidReleaseBuildEnvironment(
    {
      PATH: '/reviewed/bin',
      CFLAGS: 'ambient-c-flags',
      CXXFLAGS: 'ambient-cxx-flags',
      ASMFLAGS: 'ambient-asm-flags',
      GRADLE_USER_HOME: '/unreviewed/gradle',
      EAS_LOCAL_BUILD_SKIP_CLEANUP: 'ambient-cleanup-policy',
      EAS_LOCAL_BUILD_SKIP_NATIVE_BUILD: '1',
    },
    paths,
  );
  const expectedFlags = [
    `-ffile-prefix-map=${paths.source}=/gator/source`,
    `-fdebug-prefix-map=${paths.source}=/gator/source`,
    `-ffile-prefix-map=${paths.gradleHome}=/gator/gradle`,
    `-fdebug-prefix-map=${paths.gradleHome}=/gator/gradle`,
  ].join(' ');
  assert.equal(environment.PATH, '/reviewed/bin');
  assert.equal(environment.GRADLE_USER_HOME, paths.gradleHome);
  assert.equal(environment.CFLAGS, expectedFlags);
  assert.equal(environment.CXXFLAGS, expectedFlags);
  assert.equal(environment.ASMFLAGS, expectedFlags);
  assert.equal(environment.GATOR_NATIVE_PATH_MAP_FLAGS, expectedFlags);
  assert.equal(environment.EAS_LOCAL_BUILD_SKIP_CLEANUP, '1');
  assert.equal(environment.EAS_LOCAL_BUILD_SKIP_NATIVE_BUILD, '0');

  removeManagedEasDirectory(fixture.state, fixture.options);
  assert.equal(existsSync(paths.container), false);
  assert.equal(existsSync(paths.root), true);
});

test('stops only the run-owned Gradle home before removing its native workspace', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-gradle-stop');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  const androidDirectory = join(paths.source, 'android');
  const gradleWrapper = join(androidDirectory, 'gradlew');
  const stopMarker = join(fixture.options.temporaryParent, 'gradle-stop-marker');
  mkdirSync(androidDirectory, { recursive: true });
  writeFileSync(
    gradleWrapper,
    `#!/bin/sh\n` +
      `test "$1" = "--stop" || exit 20\n` +
      `test -n "$GATOR_NATIVE_PATH_MAP_FLAGS" || exit 21\n` +
      `test -d "$GRADLE_USER_HOME" || exit 22\n` +
      `printf '%s\\n' "$GRADLE_USER_HOME" > '${stopMarker}'\n`,
  );
  chmodSync(gradleWrapper, 0o700);

  removeManagedEasDirectory(fixture.state, fixture.options);

  assert.equal(readFileSync(stopMarker, 'utf8'), `${paths.gradleHome}\n`);
  assert.equal(existsSync(paths.container), false);
});

test('retains the complete native workspace when its scoped Gradle stop fails', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-gradle-stop-failure');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  const androidDirectory = join(paths.source, 'android');
  const gradleWrapper = join(androidDirectory, 'gradlew');
  mkdirSync(androidDirectory, { recursive: true });
  writeFileSync(gradleWrapper, '#!/bin/sh\nexit 23\n');
  chmodSync(gradleWrapper, 0o700);

  assert.throws(
    () => removeManagedEasDirectory(fixture.state, fixture.options),
    /run-owned Gradle daemons could not be stopped.*workspace retained/,
  );
  assert.equal(existsSync(paths.work), true);
  assert.equal(existsSync(paths.gradleHome), true);
});

test('does not recreate a Gradle home while finishing partial workspace cleanup', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-partial-cleanup');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  const androidDirectory = join(paths.source, 'android');
  const gradleWrapper = join(androidDirectory, 'gradlew');
  const unexpectedStopMarker = join(fixture.options.temporaryParent, 'unexpected-gradle-stop');
  mkdirSync(androidDirectory, { recursive: true });
  writeFileSync(gradleWrapper, `#!/bin/sh\ntouch '${unexpectedStopMarker}'\nexit 24\n`);
  chmodSync(gradleWrapper, 0o700);
  rmSync(paths.gradleHome, { recursive: true, force: true });

  removeManagedEasDirectory(fixture.state, fixture.options);

  assert.equal(existsSync(unexpectedStopMarker), false);
  assert.equal(existsSync(paths.container), false);
});

test('probes every local artifact-validation tool before an artifact is judged', () => {
  const calls = [];
  probeReleaseValidationTools((command, args) => {
    calls.push([command, ...args]);
    return { status: 0, signal: null, stdout: '', stderr: '' };
  });
  assert.deepEqual(calls, [
    ['unzip', '-v'],
    ['jarsigner', '-help'],
    ['keytool', '-help'],
  ]);
});

test('a missing validation tool stops validation without blaming the artifact', () => {
  assert.throws(
    () =>
      probeReleaseValidationTools((command) => {
        if (command === 'jarsigner') {
          throw new Error('jarsigner could not start: spawn jarsigner ENOENT');
        }
        return { status: 0, signal: null, stdout: '', stderr: '' };
      }),
    (error) =>
      error.message.includes('cannot run jarsigner') &&
      error.message.includes('the run stays built') &&
      error.message.includes('spawn jarsigner ENOENT'),
  );
});

test('accepts only the reviewed Play upload certificate', () => {
  assert.match(EXPECTED_UPLOAD_CERTIFICATE_SHA256, /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/);
  assert.equal(
    requireExpectedUploadCertificate(EXPECTED_UPLOAD_CERTIFICATE_SHA256),
    EXPECTED_UPLOAD_CERTIFICATE_SHA256,
  );
  const otherKey = `00${EXPECTED_UPLOAD_CERTIFICATE_SHA256.slice(2)}`;
  assert.throws(
    () => requireExpectedUploadCertificate(otherKey),
    (error) =>
      error.message.includes(otherKey) &&
      error.message.includes('not the reviewed Play upload certificate'),
  );
});

test('a retained build workspace keeps its evidence but loses its signing credentials', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-retained-credentials');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  // The pinned EAS local-build plugin writes both files straight into its build directory.
  const keystore = 'keystore-0b3c8a52-6f1d-4a8e-9d2f-1c2b3a4d5e6f';
  mkdirSync(join(paths.source, 'android', 'app'), { recursive: true });
  writeFileSync(join(paths.source, keystore), 'keystore bytes');
  writeFileSync(join(paths.source, 'credentials.json'), '{"keystorePassword":"fixture"}');
  writeFileSync(join(paths.source, 'android', 'app', 'build.gradle'), 'evidence');
  writeFileSync(join(paths.source, 'package.json'), '{}');

  assert.deepEqual(removeRetainedSigningCredentials(fixture.state, fixture.options), [
    'credentials.json',
    keystore,
  ]);
  assert.equal(existsSync(join(paths.source, keystore)), false);
  assert.equal(existsSync(join(paths.source, 'credentials.json')), false);
  assert.equal(
    readFileSync(join(paths.source, 'android', 'app', 'build.gradle'), 'utf8'),
    'evidence',
  );
  assert.equal(existsSync(join(paths.source, 'package.json')), true);
  assert.deepEqual(removeRetainedSigningCredentials(fixture.state, fixture.options), []);

  removeManagedEasDirectory(fixture.state, fixture.options);
  assert.deepEqual(removeRetainedSigningCredentials(fixture.state, fixture.options), []);
});

test("credential removal refuses a workspace that is not this run's own", async (t) => {
  await t.test('wrong ownership token', () => {
    const fixture = nativeWorkspaceFixture(t, '-retained-wrong-token');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    mkdirSync(paths.source);
    writeFileSync(join(paths.source, 'credentials.json'), '{}');
    assert.throws(
      () =>
        removeRetainedSigningCredentials(
          { ...fixture.state, workspace: { token: 'different-token' } },
          fixture.options,
        ),
      /ownership marker does not match/,
    );
    assert.equal(existsSync(join(paths.source, 'credentials.json')), true);
  });

  await t.test('symlinked build directory', () => {
    const fixture = nativeWorkspaceFixture(t, '-retained-symlink');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    const outside = join(fixture.options.temporaryParent, 'outside-build');
    mkdirSync(outside);
    writeFileSync(join(outside, 'credentials.json'), '{}');
    symlinkSync(outside, paths.source);
    assert.throws(
      () => removeRetainedSigningCredentials(fixture.state, fixture.options),
      /retained EAS build directory must be a real directory/,
    );
    assert.equal(existsSync(join(outside, 'credentials.json')), true);
  });
});

test('a failed build that keeps its workspace reports the credential deletion and cleanup', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-retained-notice');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  mkdirSync(paths.source);
  writeFileSync(join(paths.source, 'credentials.json'), '{}');
  const cleanup = `npm run release:android:cleanup -- --run ${fixture.state.runId}`;

  const notice = retainedWorkspaceNotice(fixture.state, fixture.options);
  assert.equal(existsSync(join(paths.source, 'credentials.json')), false);
  assert.match(notice, /signing keystore and password file were deleted/);
  assert.ok(notice.endsWith(cleanup), notice);

  const failed = retainedWorkspaceNotice(fixture.state, fixture.options, () => {
    throw new Error('disk is read-only');
  });
  assert.match(failed, /password file FAILED \(disk is read-only\)/);
  assert.ok(failed.endsWith(cleanup), failed);
  removeManagedEasDirectory(fixture.state, fixture.options);
});

test('uses bounded retries for run-owned recursive directory removal', () => {
  assert.deepEqual(MANAGED_DIRECTORY_REMOVAL_OPTIONS, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

test('records sanitized proof from the exact retained EAS native workspace', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-proof');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  mkdirSync(paths.source, { recursive: true });
  const source = join(paths.source, 'android/app/src/main.cpp');
  const compileDirectory = join(
    paths.source,
    'android/app/.cxx/RelWithDebInfo/fingerprint/arm64-v8a',
  );
  const hermesCompileDirectory = join(
    paths.source,
    'node_modules/react-native/ReactAndroid/hermes-engine/.cxx/MinSizeRel/fingerprint/arm64-v8a',
  );
  const bundle = join(paths.source, 'android/app/build/outputs/bundle/release/app-release.aab');
  mkdirSync(join(paths.source, 'android/app/src'), { recursive: true });
  mkdirSync(compileDirectory, { recursive: true });
  mkdirSync(hermesCompileDirectory, { recursive: true });
  mkdirSync(join(paths.source, 'android/app/build/outputs/bundle/release'), { recursive: true });
  writeFileSync(source, 'int main() { return 0; }\n');
  const flags = nativeCompilerPathMappingFlags({
    sourceRoot: paths.source,
    gradleHome: paths.gradleHome,
    includePrivateTmpAlias: true,
  });
  writeFileSync(
    join(compileDirectory, 'compile_commands.json'),
    JSON.stringify([
      {
        directory: compileDirectory,
        arguments: ['clang++', ...flags, '-c', source],
        file: source,
      },
    ]),
  );
  const assemblySource = join(paths.source, 'node_modules/react-native/boost.S');
  mkdirSync(join(paths.source, 'node_modules/react-native'), { recursive: true });
  writeFileSync(assemblySource, '.text\n');
  const disabledHermesSource = join(
    hermesCompileDirectory,
    'lib/InternalJavaScript/internal_unit.c',
  );
  const disabledHermesOutput =
    'lib/InternalJavaScript/CMakeFiles/hermesInternalUnit_obj.dir/internal_unit.c.o';
  const selectedHermesOutput =
    'lib/InternalJavaScript/CMakeFiles/hermesInternalBytecode_obj.dir/InternalBytecode.cpp.o';
  const selectedHermesObject = join(hermesCompileDirectory, selectedHermesOutput);
  const hermesCache = join(hermesCompileDirectory, 'CMakeCache.txt');
  const hermesNinjaLog = join(hermesCompileDirectory, '.ninja_log');
  const finalHermesLibrary = join(
    paths.source,
    'node_modules/react-native/ReactAndroid/hermes-engine/build/intermediates/cxx/MinSizeRel/fingerprint/obj/arm64-v8a/libhermesvm.so',
  );
  mkdirSync(dirname(disabledHermesSource), { recursive: true });
  mkdirSync(dirname(selectedHermesObject), { recursive: true });
  mkdirSync(dirname(finalHermesLibrary), { recursive: true });
  const writeValidHermesCache = () =>
    writeFileSync(
      hermesCache,
      ['# fixture', 'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:BOOL=OFF', ''].join('\n'),
    );
  const validHermesNinjaLines = [
    '# ninja log v5',
    `1\t2\t3\t${selectedHermesOutput}\t0123456789abcdef`,
    `2\t3\t4\t${finalHermesLibrary}\tfedcba9876543210`,
    '',
  ];
  const writeValidHermesNinjaLog = () =>
    writeFileSync(hermesNinjaLog, validHermesNinjaLines.join('\n'));
  writeValidHermesCache();
  writeFileSync(selectedHermesObject, 'selected-bytecode-object');
  writeFileSync(finalHermesLibrary, 'selected-hermes-library');
  writeValidHermesNinjaLog();
  writeFileSync(
    join(hermesCompileDirectory, 'compile_commands.json'),
    JSON.stringify([
      {
        directory: hermesCompileDirectory,
        arguments: ['clang', ...flags, '-c', assemblySource],
        file: assemblySource,
      },
      {
        directory: hermesCompileDirectory,
        arguments: ['clang', ...flags, '-o', disabledHermesOutput, '-c', disabledHermesSource],
        file: disabledHermesSource,
        output: disabledHermesOutput,
      },
    ]),
  );
  writeFileSync(bundle, 'fixture-aab');

  assert.deepEqual(verifyReleaseNativePathProof(paths, bundle), {
    schemaVersion: 1,
    compileDatabases: 2,
    compileCommands: 3,
    databaseBytes:
      statSync(join(compileDirectory, 'compile_commands.json')).size +
      statSync(join(hermesCompileDirectory, 'compile_commands.json')).size,
    sourceDestination: '/gator/source',
    gradleDestination: '/gator/gradle',
  });

  writeFileSync(
    hermesCache,
    [
      'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:BOOL=OFF',
      'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:BOOL=ON',
      '',
    ].join('\n'),
  );
  assert.throws(
    () => verifyReleaseNativePathProof(paths, bundle),
    /does not select the bytecode internal-JavaScript implementation/,
  );
  writeValidHermesCache();

  writeFileSync(hermesNinjaLog, ['# ninja log v4', ...validHermesNinjaLines.slice(1)].join('\n'));
  assert.throws(() => verifyReleaseNativePathProof(paths, bundle), /invalid header/);
  writeFileSync(
    hermesNinjaLog,
    [
      '# ninja log v5',
      `not-a-number\t2\t3\t${selectedHermesOutput}\tnot-a-hash`,
      `2\t3\t4\t${finalHermesLibrary}\tfedcba9876543210`,
      '',
    ].join('\n'),
  );
  assert.throws(() => verifyReleaseNativePathProof(paths, bundle), /invalid record/);

  const disabledNinjaOutputSpellings = new Set([
    'lib/InternalJavaScript/internal_unit.c',
    disabledHermesSource,
    disabledHermesOutput,
    join(hermesCompileDirectory, disabledHermesOutput),
  ]);
  if (hermesCompileDirectory.startsWith('/private/tmp/')) {
    disabledNinjaOutputSpellings.add(disabledHermesSource.slice('/private'.length));
    disabledNinjaOutputSpellings.add(
      join(hermesCompileDirectory, disabledHermesOutput).slice('/private'.length),
    );
  }
  for (const disabledOutput of disabledNinjaOutputSpellings) {
    writeFileSync(
      hermesNinjaLog,
      [
        ...validHermesNinjaLines.slice(0, -1),
        `3\t4\t5\t${disabledOutput}\tabcdef0123456789`,
        '',
      ].join('\n'),
    );
    assert.throws(
      () => verifyReleaseNativePathProof(paths, bundle),
      /disabled native-JavaScript source or object/,
    );
  }
  writeValidHermesNinjaLog();

  const cacheTarget = join(hermesCompileDirectory, 'CMakeCache.fixture-target.txt');
  writeFileSync(cacheTarget, 'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:BOOL=OFF\n');
  rmSync(hermesCache);
  symlinkSync(cacheTarget, hermesCache);
  assert.throws(
    () => verifyReleaseNativePathProof(paths, bundle),
    /symbolic link is not allowed in native build metadata/,
  );
  rmSync(hermesCache);
  writeValidHermesCache();

  const bundleMtime = statSync(bundle).mtime;
  const staleMtime = new Date(bundleMtime.getTime() - 7 * 60 * 60 * 1000);
  utimesSync(selectedHermesObject, staleMtime, staleMtime);
  assert.throws(() => verifyReleaseNativePathProof(paths, bundle), /stale relative/);
  const futureMtime = new Date(bundleMtime.getTime() + 6_000);
  utimesSync(selectedHermesObject, futureMtime, futureMtime);
  assert.throws(() => verifyReleaseNativePathProof(paths, bundle), /newer than the release AAB/);
  utimesSync(selectedHermesObject, bundleMtime, bundleMtime);

  rmSync(selectedHermesObject);
  assert.throws(
    () => verifyReleaseNativePathProof(paths, bundle),
    /selected Hermes bytecode object/,
  );
});

// React Native builds Hermes for the DEBUG variant with CMAKE_BUILD_TYPE=Release (a faster build),
// so a workspace that built both variants (CI assembles the debug APK first) also holds a Hermes
// database under .cxx/Release whose generated internal_unit.c is gone, like MinSizeRel's.
test('accepts the debug-variant Hermes database that React Native builds as "Release"', (t) => {
  const fixture = nativeWorkspaceFixture(t, '-hermes-debug');
  const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
  const hermesRoot = join(paths.source, 'node_modules/react-native/ReactAndroid/hermes-engine');
  const hermesCompileDirectory = join(hermesRoot, '.cxx/Release/fingerprint/arm64-v8a');
  const bundle = join(paths.source, 'android/app/build/outputs/bundle/release/app-release.aab');
  const assemblySource = join(paths.source, 'node_modules/react-native/boost.S');
  const disabledHermesSource = join(
    hermesCompileDirectory,
    'lib/InternalJavaScript/internal_unit.c',
  );
  const disabledHermesOutput =
    'lib/InternalJavaScript/CMakeFiles/hermesInternalUnit_obj.dir/internal_unit.c.o';
  const selectedHermesOutput =
    'lib/InternalJavaScript/CMakeFiles/hermesInternalBytecode_obj.dir/InternalBytecode.cpp.o';
  const finalHermesLibrary = join(
    hermesRoot,
    'build/intermediates/cxx/Release/fingerprint/obj/arm64-v8a/libhermesvm.so',
  );
  mkdirSync(dirname(join(hermesCompileDirectory, selectedHermesOutput)), { recursive: true });
  mkdirSync(dirname(finalHermesLibrary), { recursive: true });
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(assemblySource, '.text\n');
  writeFileSync(
    join(hermesCompileDirectory, 'CMakeCache.txt'),
    'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:BOOL=OFF\n',
  );
  writeFileSync(join(hermesCompileDirectory, selectedHermesOutput), 'selected-bytecode-object');
  writeFileSync(finalHermesLibrary, 'selected-hermes-library');
  writeFileSync(
    join(hermesCompileDirectory, '.ninja_log'),
    [
      '# ninja log v5',
      `1\t2\t3\t${selectedHermesOutput}\t0123456789abcdef`,
      `2\t3\t4\t${finalHermesLibrary}\tfedcba9876543210`,
      '',
    ].join('\n'),
  );
  const flags = nativeCompilerPathMappingFlags({
    sourceRoot: paths.source,
    gradleHome: paths.gradleHome,
    includePrivateTmpAlias: true,
  });
  writeFileSync(
    join(hermesCompileDirectory, 'compile_commands.json'),
    JSON.stringify([
      {
        directory: hermesCompileDirectory,
        arguments: ['clang', ...flags, '-c', assemblySource],
        file: assemblySource,
      },
      {
        directory: hermesCompileDirectory,
        arguments: ['clang', ...flags, '-o', disabledHermesOutput, '-c', disabledHermesSource],
        file: disabledHermesSource,
        output: disabledHermesOutput,
      },
    ]),
  );
  writeFileSync(bundle, 'fixture-aab');

  assert.equal(verifyReleaseNativePathProof(paths, bundle).compileCommands, 2);

  // Only Hermes gets this exception: any other Release database naming a missing file fails.
  const appDirectory = join(paths.source, 'android/app/.cxx/Release/fingerprint/arm64-v8a');
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(
    join(appDirectory, 'compile_commands.json'),
    JSON.stringify([
      {
        directory: appDirectory,
        arguments: ['clang++', ...flags, '-c', join(paths.source, 'android/app/src/gone.cpp')],
        file: join(paths.source, 'android/app/src/gone.cpp'),
      },
    ]),
  );
  assert.throws(() => verifyReleaseNativePathProof(paths, bundle), /names a missing source file/);
});

test('retains native evidence and redacts host paths when release proof fails', () => {
  const paths = {
    source: '/private/tmp/gator-android-release-501/run/work/build',
    gradleHome: '/private/tmp/gator-android-release-501/run/gradle-home',
    work: '/private/tmp/gator-android-release-501/run/work',
  };
  const failure = classifyReleaseEvidenceFailure(
    new Error(
      `missing map for ${paths.source}\nand alias ${paths.source.replace('/private/tmp/', '/tmp/')}\tfrom ${process.cwd()}/dist/release/artifact.pending.aab`,
    ),
    'native_path_proof_failed',
    paths,
  );

  assert.equal(failure.releaseFailureCode, 'native_path_proof_failed');
  assert.equal(failure.retainWorkspace, true);
  assert.match(failure.releaseFailureDetail, /\[native source\]/);
  assert.match(failure.releaseFailureDetail, /\[release checkout\]/);
  assert.doesNotMatch(failure.releaseFailureDetail, /gator-android-release-/);
  assert.doesNotMatch(failure.releaseFailureDetail, /[\x00-\x1f\x7f]/);
});

test('maps both macOS temporary-directory spellings for release-native compilers', () => {
  assert.deepEqual(
    nativeCompilerPathMappingFlags({
      sourceRoot: '/private/tmp/gator/source',
      gradleHome: '/private/tmp/gator/gradle',
      includePrivateTmpAlias: true,
    }),
    [
      '-ffile-prefix-map=/private/tmp/gator/source=/gator/source',
      '-fdebug-prefix-map=/private/tmp/gator/source=/gator/source',
      '-ffile-prefix-map=/tmp/gator/source=/gator/source',
      '-fdebug-prefix-map=/tmp/gator/source=/gator/source',
      '-ffile-prefix-map=/private/tmp/gator/gradle=/gator/gradle',
      '-fdebug-prefix-map=/private/tmp/gator/gradle=/gator/gradle',
      '-ffile-prefix-map=/tmp/gator/gradle=/gator/gradle',
      '-fdebug-prefix-map=/tmp/gator/gradle=/gator/gradle',
    ],
  );
});

test('reconciliation accepts only the exact bounded native-path proof receipt shape', () => {
  const proof = {
    schemaVersion: 1,
    compileDatabases: 3,
    compileCommands: 41,
    databaseBytes: 8192,
    sourceDestination: '/gator/source',
    gradleDestination: '/gator/gradle',
  };
  assert.equal(isValidReleaseNativePathProof(proof), true);

  const rejectedMutations = [
    null,
    { ...proof, schemaVersion: 2 },
    { ...proof, compileDatabases: 0 },
    { ...proof, compileDatabases: 257 },
    { ...proof, compileCommands: 2 },
    { ...proof, compileCommands: 250_001 },
    { ...proof, databaseBytes: 0 },
    { ...proof, databaseBytes: 128 * 1024 * 1024 + 1 },
    { ...proof, sourceDestination: '/private/source' },
    { ...proof, gradleDestination: '/private/gradle' },
    { ...proof, hostPath: '/Users/reviewer/source' },
  ];
  for (const mutation of rejectedMutations) {
    assert.equal(isValidReleaseNativePathProof(mutation), false);
  }
});

test('build receipt strictly binds one pending AAB to its native-path proof', () => {
  const runId = 'android-0.1.44-abcdef0-20260909013045';
  const artifact = {
    filename: 'artifact.pending.aab',
    bytes: 4096,
    sha256: 'a'.repeat(64),
  };
  const receipt = {
    schemaVersion: 2,
    runId,
    mode: 'local',
    profile: 'production',
    environment: 'production',
    output: 'artifact.pending.aab',
    startedAt: '2026-09-09T01:30:45.000Z',
    finishedAt: '2026-09-09T01:31:45.000Z',
    remoteVersionMayHaveAdvanced: true,
    exitCode: 0,
    artifact,
    nativePathProof: {
      schemaVersion: 1,
      compileDatabases: 3,
      compileCommands: 41,
      databaseBytes: 8192,
      sourceDestination: '/gator/source',
      gradleDestination: '/gator/gradle',
    },
  };
  assert.equal(isValidReleaseBuildReceipt(receipt, { runId, artifact }), true);

  for (const mutation of [
    { ...receipt, schemaVersion: 1 },
    { ...receipt, runId: `${runId}-other` },
    { ...receipt, mode: 'cloud' },
    { ...receipt, finishedAt: 'not-a-time' },
    { ...receipt, artifact: { ...artifact, bytes: artifact.bytes + 1 } },
    { ...receipt, artifact: { ...artifact, sha256: 'b'.repeat(64) } },
    { ...receipt, nativePathProof: { ...receipt.nativePathProof, compileDatabases: 0 } },
    { ...receipt, unreviewed: true },
    { ...receipt, artifact: { ...artifact, hostPath: '/Users/reviewer/build.aab' } },
  ]) {
    assert.equal(isValidReleaseBuildReceipt(mutation, { runId, artifact }), false);
  }
  assert.equal(
    isValidReleaseBuildReceipt(receipt, {
      runId,
      artifact: { ...artifact, sha256: 'b'.repeat(64) },
    }),
    false,
  );
});

test('records a verified build before surfacing workspace cleanup failure', (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'gator-release-finalize-failure-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const pendingArtifact = join(temporaryDirectory, 'artifact.pending.aab');
  writeFileSync(pendingArtifact, 'verified-candidate');
  const state = {
    runId: 'android-test-finalize-failure',
    phase: 'building',
    build: { status: 'building' },
    history: [],
  };
  const events = [];
  const states = [];

  assert.throws(
    () =>
      finalizeVerifiedReleaseBuild({
        state,
        finishedAt: '2026-09-16T05:30:00.000Z',
        persistReceipt: () => events.push('receipt'),
        persistState: (nextState) => {
          states.push(structuredClone(nextState));
          events.push(`state:${nextState.phase}:${nextState.build.status}`);
        },
        cleanupWorkspaces: () => {
          events.push('cleanup');
          throw new Error('fixture ENOTEMPTY');
        },
      }),
    /verified build receipt is durable.*fixture ENOTEMPTY/,
  );

  assert.deepEqual(events, ['receipt', 'state:building:cleanup_required', 'cleanup']);
  assert.equal(states.length, 1);
  assert.equal(states[0].build.finishedAt, '2026-09-16T05:30:00.000Z');
  assert.equal(states[0].build.exitCode, 0);
  assert.equal(readFileSync(pendingArtifact, 'utf8'), 'verified-candidate');
});

test('releases a verified build for validation only after workspace cleanup succeeds', () => {
  const state = {
    runId: 'android-test-finalize-success',
    phase: 'building',
    build: { status: 'building' },
    history: [],
  };
  const events = [];

  const builtState = finalizeVerifiedReleaseBuild({
    state,
    finishedAt: '2026-09-16T05:31:00.000Z',
    persistReceipt: () => events.push('receipt'),
    persistState: (nextState) => events.push(`state:${nextState.phase}:${nextState.build.status}`),
    cleanupWorkspaces: () => events.push('cleanup'),
  });

  assert.deepEqual(events, [
    'receipt',
    'state:building:cleanup_required',
    'cleanup',
    'state:built:built',
  ]);
  assert.equal(builtState.phase, 'built');
  assert.equal(builtState.build.status, 'built');
  assert.deepEqual(
    builtState.history.map(({ phase, status }) => ({ phase, status })),
    [{ phase: 'build', status: 'passed' }],
  );
});

test('derives production workspaces only beneath the fixed /private/tmp root', () => {
  const paths = androidReleaseWorkspacePaths('android-0.1.44-proof', {
    temporaryParent: '/private/tmp',
    ownerUid: 501,
  });
  assert.equal(paths.container, '/private/tmp/gator-android-release-501/android-0.1.44-proof');
  assert.throws(
    () =>
      androidReleaseWorkspacePaths('../escape', {
        temporaryParent: '/private/tmp',
        ownerUid: 501,
      }),
    /run id is invalid/,
  );
});

test('refuses wrong tokens, unsafe modes, symlinks, and unexpected run entries', async (t) => {
  await t.test('wrong token', () => {
    const fixture = nativeWorkspaceFixture(t, '-wrong-token');
    prepareManagedEasDirectory(fixture.state, fixture.options);
    assert.throws(
      () =>
        removeManagedEasDirectory(
          { ...fixture.state, workspace: { token: 'different-token' } },
          fixture.options,
        ),
      /does not match this release run/,
    );
  });

  await t.test('unsafe directory mode', () => {
    const fixture = nativeWorkspaceFixture(t, '-mode');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    chmodSync(paths.gradleHome, 0o755);
    assert.throws(
      () => removeManagedEasDirectory(fixture.state, fixture.options),
      /Gradle home must have mode 0700/,
    );
  });

  await t.test('unsafe ownership-marker mode', () => {
    const fixture = nativeWorkspaceFixture(t, '-marker-mode');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    chmodSync(paths.marker, 0o644);
    assert.throws(
      () => removeManagedEasDirectory(fixture.state, fixture.options),
      /ownership marker has unsafe ownership or mode/,
    );
  });

  await t.test('symlinked ownership marker', () => {
    const fixture = nativeWorkspaceFixture(t, '-marker-link');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    const outside = join(fixture.options.temporaryParent, 'outside-marker');
    writeFileSync(outside, readFileSync(paths.marker));
    rmSync(paths.marker);
    symlinkSync(outside, paths.marker);
    assert.throws(
      () => removeManagedEasDirectory(fixture.state, fixture.options),
      /ownership marker is invalid/,
    );
  });

  await t.test('symlinked owned child', () => {
    const fixture = nativeWorkspaceFixture(t, '-symlink');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    const outside = join(fixture.options.temporaryParent, 'outside');
    mkdirSync(outside);
    rmSync(paths.work, { recursive: true });
    symlinkSync(outside, paths.work);
    assert.throws(
      () => removeManagedEasDirectory(fixture.state, fixture.options),
      /EAS work directory must be a real directory/,
    );
  });

  await t.test('unexpected run entry', () => {
    const fixture = nativeWorkspaceFixture(t, '-unexpected');
    const paths = prepareManagedEasDirectory(fixture.state, fixture.options);
    writeFileSync(join(paths.container, 'unreviewed'), 'keep');
    assert.throws(
      () => removeManagedEasDirectory(fixture.state, fixture.options),
      /unexpected retained entries: unreviewed/,
    );
  });

  await t.test('symlinked owner root', () => {
    const fixture = nativeWorkspaceFixture(t, '-root-link');
    const paths = androidReleaseWorkspacePaths(fixture.state.runId, fixture.options);
    const outside = join(fixture.options.temporaryParent, 'outside-root');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, paths.root);
    assert.throws(
      () => prepareManagedEasDirectory(fixture.state, fixture.options),
      /temporary root must be a real directory/,
    );
  });
});

// Static import statements only; lazy require/import() inside functions is allowed.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[\w\s{},*$]+\s+from\s+)?['"]([^'"]+)['"]/gm;

test('scripts CI runs before npm ci import only Node built-ins and local files at startup', () => {
  // CI's "Test toolchain policy" step runs these two test files before dependencies are installed.
  // Locally node_modules always exists, so a stray npm import only fails in CI; catch it here.
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const queue = ['check-toolchain.test.mjs', 'release-android.test.mjs'].map((name) =>
    join(scriptsDir, name),
  );
  const seen = new Set();
  const npmImports = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) queue.push(join(dirname(file), specifier));
      else npmImports.push(`${relative(scriptsDir, file)} imports '${specifier}'`);
    }
  }
  assert.ok(seen.size > 3, 'expected to follow the release script import chain');
  assert.deepEqual(npmImports, []);
});

test('refuses to release source that is unpushed or has no passing CI run', () => {
  const commit = 'a'.repeat(40);
  function fakeCommands({
    remoteBranches = 'origin/master',
    ciRuns = '[{"status":"completed","conclusion":"success"}]',
  } = {}) {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'git' && args[0] === 'branch') return { stdout: remoteBranches };
      if (command === 'gh') return { stdout: ciRuns };
      return { stdout: '' };
    };
    return { run, calls };
  }

  const verified = fakeCommands();
  assert.doesNotThrow(() => assertSourceVerifiedByCi(commit, { run: verified.run }));
  assert.deepEqual(verified.calls, [
    'git fetch --quiet origin',
    `git branch --remotes --contains ${commit} --format=%(refname:short)`,
    `gh run list --commit ${commit} --workflow CI --json status,conclusion`,
  ]);

  const unpushed = fakeCommands({ remoteBranches: '' });
  assert.throws(() => assertSourceVerifiedByCi(commit, { run: unpushed.run }), /is not on GitHub/);
  assert.ok(!unpushed.calls.some((call) => call.startsWith('gh ')));

  for (const ciRuns of [
    '[]',
    '[{"status":"in_progress","conclusion":""}]',
    '[{"status":"completed","conclusion":"failure"}]',
  ]) {
    assert.throws(
      () => assertSourceVerifiedByCi(commit, { run: fakeCommands({ ciRuns }).run }),
      /no passing GitHub CI run/,
    );
  }
  assert.throws(
    () => assertSourceVerifiedByCi(commit, { run: fakeCommands({ ciRuns: 'not json' }).run }),
    /could not read GitHub CI results/,
  );

  const ghMissing = (command) => {
    if (command === 'gh') throw new Error('gh could not start: spawn gh ENOENT');
    return { stdout: 'origin/master' };
  };
  assert.throws(() => assertSourceVerifiedByCi(commit, { run: ghMissing }), /gh could not start/);
});

// CI installs the same reviewed hook as the local release; Gradle applies every init.d script.
test('installs the shared native path-map hook into the Gradle home for CI', () => {
  const gradleHome = mkdtempSync(join(tmpdir(), 'gator-ci-gradle-'));
  try {
    const flags = '-ffile-prefix-map=/work=/gator/source -fdebug-prefix-map=/work=/gator/source';
    const installed = installAndroidNativePathInitScript({
      GRADLE_USER_HOME: gradleHome,
      GATOR_NATIVE_PATH_MAP_FLAGS: flags,
    });
    assert.equal(installed, join(gradleHome, 'init.d', 'gator-native-path-map.gradle'));
    assert.equal(readFileSync(installed, 'utf8'), ANDROID_NATIVE_PATH_INIT_SCRIPT);
    assert.match(
      ANDROID_NATIVE_PATH_INIT_SCRIPT,
      /-DCMAKE_ASM_FLAGS=\$\{gatorNativePathMapFlags\}/,
    );

    assert.throws(
      () => installAndroidNativePathInitScript({ GATOR_NATIVE_PATH_MAP_FLAGS: flags }),
      /GRADLE_USER_HOME must be an absolute path/,
    );
    assert.throws(
      () =>
        installAndroidNativePathInitScript({
          GRADLE_USER_HOME: 'relative/gradle',
          GATOR_NATIVE_PATH_MAP_FLAGS: flags,
        }),
      /GRADLE_USER_HOME must be an absolute path/,
    );
    assert.throws(
      () =>
        installAndroidNativePathInitScript({
          GRADLE_USER_HOME: gradleHome,
          GATOR_NATIVE_PATH_MAP_FLAGS: '  ',
        }),
      /GATOR_NATIVE_PATH_MAP_FLAGS must be set/,
    );
  } finally {
    rmSync(gradleHome, { recursive: true, force: true });
  }
});
