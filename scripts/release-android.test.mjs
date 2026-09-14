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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  androidReleaseWorkspacePaths,
  createAndroidReleaseBuildEnvironment,
  findLocalBranchObjectId,
  isValidReleaseBuildReceipt,
  isValidReleaseNativePathProof,
  prepareManagedEasDirectory,
  requireEnvironmentCredential,
  removeManagedEasDirectory,
  stageGoogleServicesFile,
  verifyReleaseNativePathProof,
} from './release-android.mjs';
import { nativeCompilerPathMappingFlags } from './check-android-native-paths.mjs';

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
  assert.equal(environment.GATOR_NATIVE_PATH_MAP_FLAGS, expectedFlags);
  assert.equal(environment.EAS_LOCAL_BUILD_SKIP_CLEANUP, '1');
  assert.equal(environment.EAS_LOCAL_BUILD_SKIP_NATIVE_BUILD, '0');

  removeManagedEasDirectory(fixture.state, fixture.options);
  assert.equal(existsSync(paths.container), false);
  assert.equal(existsSync(paths.root), true);
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
  const bundle = join(paths.source, 'android/app/build/outputs/bundle/release/app-release.aab');
  mkdirSync(join(paths.source, 'android/app/src'), { recursive: true });
  mkdirSync(compileDirectory, { recursive: true });
  mkdirSync(join(paths.source, 'android/app/build/outputs/bundle/release'), { recursive: true });
  writeFileSync(source, 'int main() { return 0; }\n');
  const flags = nativeCompilerPathMappingFlags({
    sourceRoot: paths.source,
    gradleHome: paths.gradleHome,
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
  writeFileSync(bundle, 'fixture-aab');

  assert.deepEqual(verifyReleaseNativePathProof(paths, bundle), {
    schemaVersion: 1,
    compileDatabases: 1,
    compileCommands: 1,
    databaseBytes: statSync(join(compileDirectory, 'compile_commands.json')).size,
    sourceDestination: '/gator/source',
    gradleDestination: '/gator/gradle',
  });
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
