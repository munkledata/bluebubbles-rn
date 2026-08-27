#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { inspectPackagedAndroidBundle } from './check-android-build.mjs';
import {
  REQUIRED_EAS_CLI_VERSION,
  REQUIRED_EAS_SUBMIT_CONFIG,
  reviewedEasNpxArgs,
  reviewedLocalBuildPluginNpxArgs,
  runToolchainCheck,
} from './check-toolchain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = resolve(ROOT, 'dist');
const RELEASE_ROOT = resolve(ROOT, 'dist/release');
const LOCK_PATH = resolve(RELEASE_ROOT, '.lock');
const STATE_FILENAME = 'state.json';
const APPLICATION_ID = 'com.bluegreengatorapps.messages';
const LOCAL_BUILD_PLUGIN_VERSION = REQUIRED_EAS_CLI_VERSION;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ZERO_OBJECT_ID = '0'.repeat(40);

function nowIso() {
  return new Date().toISOString();
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals >= 0) {
      const name = token.slice(2, equals);
      if (options.has(name)) throw new Error(`--${name} was provided more than once`);
      options.set(name, token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    if (options.has(name)) throw new Error(`--${name} was provided more than once`);
    const next = args[index + 1];
    if (next != null && !next.startsWith('--')) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return options;
}

function assertOnlyOptions(options, allowed) {
  const allowedNames = new Set(allowed);
  for (const name of options.keys()) {
    if (!allowedNames.has(name)) throw new Error(`unknown option: --${name}`);
  }
}

function requiredStringOption(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requireFlag(options, name, message) {
  if (options.get(name) !== true) throw new Error(message ?? `--${name} is required`);
}

function runCapture(command, args, { cwd = ROOT, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(`${command} exited ${String(result.status)}${detail ? `:\n${detail}` : ''}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function processGroupIsRunning(processGroupId) {
  if (process.platform === 'win32' || !Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsRunning(processGroupId) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !processGroupIsRunning(processGroupId);
}

async function runInherited(
  command,
  args,
  { cwd = ROOT, env = process.env, onSpawn = () => {} } = {},
) {
  return await new Promise((resolveOutcome, reject) => {
    const usesProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      detached: usesProcessGroup,
    });
    const processGroupId = usesProcessGroup ? child.pid : null;
    let forwardedSignal = null;
    let signalForwardingFailed = false;
    let settled = false;
    const forward = (signal) => {
      forwardedSignal = signal;
      try {
        if (processGroupId) process.kill(-processGroupId, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') signalForwardingFailed = true;
      }
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    const removeHandlers = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    child.once('error', (error) => {
      removeHandlers();
      settled = true;
      reject(new Error(`${command} could not start: ${error.message}`));
    });
    child.once('close', async (status, signal) => {
      removeHandlers();
      if (settled) return;
      settled = true;
      const processGroupExited = processGroupId
        ? await waitForProcessGroupExit(processGroupId)
        : true;
      resolveOutcome({
        status,
        signal: signal ?? forwardedSignal,
        processGroupId,
        descendantsRunning: !processGroupExited,
        retainWorkspace: !processGroupExited,
        signalForwardingFailed,
      });
    });
    try {
      onSpawn(processGroupId);
    } catch (error) {
      try {
        forward('SIGTERM');
      } catch {
        // The child may already have exited; the original state-write error remains authoritative.
      }
      removeHandlers();
      settled = true;
      const spawnCallbackError =
        error instanceof Error ? error : new Error(`release state update failed: ${String(error)}`);
      spawnCallbackError.processGroupId = processGroupId;
      spawnCallbackError.retainWorkspace = processGroupIsRunning(processGroupId);
      reject(spawnCallbackError);
    }
  });
}

function git(args, options) {
  return runCapture('git', args, options).stdout;
}

function ensureReleaseRoot() {
  if (existsSync(DIST_ROOT)) {
    const dist = lstatSync(DIST_ROOT);
    if (!dist.isDirectory() || dist.isSymbolicLink()) {
      throw new Error('dist must be a real directory before release state can be written');
    }
  }
  mkdirSync(RELEASE_ROOT, { recursive: true, mode: 0o700 });
  const dist = lstatSync(DIST_ROOT);
  const releaseRoot = lstatSync(RELEASE_ROOT);
  if (
    !dist.isDirectory() ||
    dist.isSymbolicLink() ||
    !releaseRoot.isDirectory() ||
    releaseRoot.isSymbolicLink()
  ) {
    throw new Error('dist/release must be a real managed directory');
  }
  assertDescendant(realpathSync(ROOT), realpathSync(RELEASE_ROOT), 'real release root');
}

function assertDescendant(parent, child, label) {
  const pathFromParent = relative(parent, child);
  if (
    pathFromParent === '' ||
    pathFromParent === '..' ||
    pathFromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new Error(`${label} is outside its managed directory`);
  }
}

function validateRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('release run id is invalid');
  return runId;
}

function runDirectory(runId) {
  const path = resolve(RELEASE_ROOT, validateRunId(runId));
  assertDescendant(RELEASE_ROOT, path, 'release run');
  return path;
}

function runFile(runId, filename) {
  const directory = runDirectory(runId);
  const path = resolve(directory, filename);
  assertDescendant(directory, path, 'release run file');
  return path;
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

function writeImmutableFile(path, value) {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  assertDescendant(directory, temporary, 'temporary immutable release file');
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeImmutableJson(path, value) {
  writeImmutableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readState(runId) {
  assertManagedRunDirectory(runId);
  const state = readJson(runFile(runId, STATE_FILENAME));
  if (state?.schemaVersion !== 1 || state?.runId !== runId) {
    throw new Error('release state has an invalid schema or run id');
  }
  return state;
}

function assertManagedRunDirectory(runId) {
  ensureReleaseRoot();
  const directory = runDirectory(runId);
  const runDirectoryState = lstatSync(directory);
  if (!runDirectoryState.isDirectory() || runDirectoryState.isSymbolicLink()) {
    throw new Error('release run must be a real managed directory');
  }
  assertDescendant(
    realpathSync(RELEASE_ROOT),
    realpathSync(directory),
    'real release run directory',
  );
  return directory;
}

function writeState(state) {
  atomicWriteJson(runFile(state.runId, STATE_FILENAME), state);
}

function historyEntry(phase, status) {
  return { phase, status, at: nowIso() };
}

function requirePhase(state, ...allowed) {
  if (!allowed.includes(state.phase)) {
    throw new Error(
      `release run ${state.runId} is ${state.phase}; expected ${allowed.join(' or ')}`,
    );
  }
}

async function withReleaseLock(runId, phase, action) {
  ensureReleaseRoot();
  const token = randomUUID();
  const temporaryLockPath = resolve(RELEASE_ROOT, `.lock.${process.pid}.${token}.tmp`);
  assertDescendant(RELEASE_ROOT, temporaryLockPath, 'temporary release lock');
  writeFileSync(
    temporaryLockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token,
      runId,
      phase,
      pid: process.pid,
      createdAt: nowIso(),
    })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  try {
    linkSync(temporaryLockPath, LOCK_PATH);
  } catch (error) {
    unlinkSync(temporaryLockPath);
    if (error?.code !== 'EEXIST') throw error;
    throw new Error(
      'another release phase or a stale release lock exists; use release:android:cleanup only after confirming no release process is running',
    );
  }
  unlinkSync(temporaryLockPath);
  const identity = lstatSync(LOCK_PATH);
  if (readJson(LOCK_PATH)?.token !== token) {
    throw new Error('release lock ownership changed during acquisition');
  }
  let actionFailed = false;
  try {
    return await action();
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    const released = removeOwnedLock({ identity, token });
    if (!released && !actionFailed) {
      throw new Error('release lock ownership changed; the replacement lock was not removed');
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnedLock({ identity, token }) {
  if (!identity || !existsSync(LOCK_PATH)) return false;
  const currentIdentity = lstatSync(LOCK_PATH);
  if (!sameFileIdentity(identity, currentIdentity)) return false;
  try {
    if (readJson(LOCK_PATH)?.token !== token) return false;
  } catch {
    return false;
  }
  unlinkSync(LOCK_PATH);
  return true;
}

function readLockSnapshot() {
  const identity = lstatSync(LOCK_PATH);
  if (!identity.isFile()) throw new Error('release lock is not a regular file');
  const lock = readJson(LOCK_PATH);
  const confirmedIdentity = lstatSync(LOCK_PATH);
  if (!sameFileIdentity(identity, confirmedIdentity)) {
    throw new Error('release lock changed while cleanup inspected it');
  }
  if (lock?.schemaVersion !== 1 || typeof lock?.token !== 'string') {
    throw new Error('release lock is malformed; refusing automatic removal');
  }
  return { identity, token: lock.token, lock };
}

function assertCleanCurrentSource(expectedCommit) {
  const root = git(['rev-parse', '--show-toplevel']);
  if (resolve(root) !== ROOT) throw new Error('release command must run from this repository');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error(`release source is not clean:\n${status}`);
  const head = git(['rev-parse', 'HEAD']);
  if (expectedCommit && head !== expectedCommit) {
    throw new Error(`release source moved from ${expectedCommit} to ${head}`);
  }
  return head;
}

function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`version must be strict major.minor.patch: ${version}`);
  return match.slice(1).map(Number);
}

function assertVersionAdvances(current, target) {
  const before = parseVersion(current);
  const after = parseVersion(target);
  for (let index = 0; index < before.length; index += 1) {
    if (after[index] > before[index]) return;
    if (after[index] < before[index]) break;
  }
  throw new Error(`target version ${target} must be newer than ${current}`);
}

function readProjectVersionState(root = ROOT) {
  const packageJson = readJson(resolve(root, 'package.json'));
  const packageLock = readJson(resolve(root, 'package-lock.json'));
  const rootLock = packageLock.packages?.[''];
  if (
    typeof packageJson.version !== 'string' ||
    packageJson.version !== packageLock.version ||
    packageJson.version !== rootLock?.version
  ) {
    throw new Error('package.json and package-lock.json release versions do not agree');
  }
  return { packageJson, packageLock, version: packageJson.version };
}

function withoutReleaseVersions({ packageJson, packageLock }) {
  const packageCopy = structuredClone(packageJson);
  const lockCopy = structuredClone(packageLock);
  delete packageCopy.version;
  delete lockCopy.version;
  if (lockCopy.packages?.['']) delete lockCopy.packages[''].version;
  return { packageJson: packageCopy, packageLock: lockCopy };
}

function assertOnlyReleaseVersionsChanged(before, after, targetVersion) {
  if (after.version !== targetVersion)
    throw new Error('prepared package version is not the target');
  if (!isDeepStrictEqual(withoutReleaseVersions(before), withoutReleaseVersions(after))) {
    throw new Error(
      'version preparation changed fields other than the three package version values',
    );
  }
}

function resolveCredentialPath(variableName, fallback) {
  const configured = process.env[variableName];
  const path = configured ? resolve(configured) : resolve(ROOT, fallback);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${variableName} file is missing`);
  }
  return path;
}

function requireConfiguredSubmitCredential() {
  const configuredPath = REQUIRED_EAS_SUBMIT_CONFIG.production.android.serviceAccountKeyPath;
  const path = resolve(ROOT, configuredPath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `Play service-account file is missing at the configured path: ${configuredPath}`,
    );
  }
  return path;
}

function assertRecordedToolchain(state) {
  const current = runToolchainCheck({ root: ROOT });
  const recorded = {
    node: state.toolchain.node,
    npm: state.toolchain.npm,
    easCli: state.toolchain.easCli,
    androidSubmitTrack: state.target.track,
  };
  if (!isDeepStrictEqual(current, recorded)) {
    throw new Error('release toolchain no longer matches the preflight receipt');
  }
}

function managedWorktreePath(runId) {
  return runFile(runId, 'worktree');
}

function managedEasWorkingPath(runId) {
  const container = runFile(runId, 'eas-container');
  const path = resolve(container, 'work');
  assertDescendant(container, path, 'temporary EAS directory');
  return path;
}

function managedEasContainerPath(runId) {
  return runFile(runId, 'eas-container');
}

function easOwnershipMarkerPath(runId) {
  const container = managedEasContainerPath(runId);
  const path = resolve(container, '.owner.json');
  assertDescendant(container, path, 'EAS ownership marker');
  return path;
}

function removeManagedWorktree(runId) {
  const path = managedWorktreePath(runId);
  if (existsSync(path)) {
    const removal = runCapture('git', ['worktree', 'remove', '--force', path], {
      allowFailure: true,
    });
    if (removal.status !== 0 || existsSync(path)) {
      throw new Error(
        `Git could not remove the managed release worktree; retained for review: ${path}`,
      );
    }
  }
  git(['worktree', 'prune']);
}

function expectedEasOwnership(state) {
  if (typeof state.workspace?.token !== 'string') {
    throw new Error('release state has no workspace ownership token');
  }
  return { schemaVersion: 1, runId: state.runId, token: state.workspace.token };
}

function removeManagedEasDirectory(state) {
  const runDirectoryPath = assertManagedRunDirectory(state.runId);
  const container = managedEasContainerPath(state.runId);
  if (!existsSync(container)) return;
  const containerState = lstatSync(container);
  if (!containerState.isDirectory() || containerState.isSymbolicLink()) {
    throw new Error(`refusing to remove an unowned EAS container: ${container}`);
  }
  assertDescendant(realpathSync(runDirectoryPath), realpathSync(container), 'real EAS container');
  const markerPath = easOwnershipMarkerPath(state.runId);
  if (!existsSync(markerPath)) throw new Error('EAS workspace ownership marker is missing');
  const markerState = lstatSync(markerPath);
  if (!markerState.isFile() || markerState.isSymbolicLink()) {
    throw new Error('EAS workspace ownership marker is invalid');
  }
  if (!isDeepStrictEqual(readJson(markerPath), expectedEasOwnership(state))) {
    throw new Error('EAS workspace ownership marker does not match this release run');
  }
  const work = managedEasWorkingPath(state.runId);
  if (existsSync(work)) {
    const workState = lstatSync(work);
    if (!workState.isDirectory() || workState.isSymbolicLink()) {
      throw new Error(`refusing to remove an unowned EAS workspace: ${work}`);
    }
    assertDescendant(realpathSync(container), realpathSync(work), 'real EAS workspace');
    rmSync(work, { recursive: true, force: true });
  }
  const remaining = readdirSync(container).filter((entry) => entry !== '.owner.json');
  if (remaining.length > 0) {
    throw new Error(`EAS container has unexpected retained entries: ${remaining.join(', ')}`);
  }
  unlinkSync(markerPath);
  rmdirSync(container);
}

function prepareManagedEasDirectory(state) {
  removeManagedEasDirectory(state);
  const container = managedEasContainerPath(state.runId);
  mkdirSync(container, { mode: 0o700 });
  writeImmutableJson(easOwnershipMarkerPath(state.runId), expectedEasOwnership(state));
  return managedEasWorkingPath(state.runId);
}

async function withWorktree(state, { applyPreparedPatch }, action) {
  const worktree = managedWorktreePath(state.runId);
  if (existsSync(worktree)) {
    throw new Error(`temporary release worktree already exists; run cleanup for ${state.runId}`);
  }
  git(['worktree', 'add', '--detach', worktree, state.source.commit]);
  let retainWorkspace = false;
  try {
    if (applyPreparedPatch) {
      const patchPath = runFile(state.runId, 'version.patch');
      git(['-C', worktree, 'apply', '--index', patchPath]);
      const tree = git(['-C', worktree, 'write-tree']);
      if (tree !== state.preparation.releaseTree) {
        throw new Error('prepared version patch no longer produces the recorded release tree');
      }
      const versionState = readProjectVersionState(worktree);
      if (versionState.version !== state.target.version) {
        throw new Error('prepared worktree version no longer matches the release target');
      }
    }
    const result = await action(worktree);
    retainWorkspace = result?.retainWorkspace === true;
    return result;
  } catch (error) {
    retainWorkspace = error?.retainWorkspace === true;
    throw error;
  } finally {
    if (!retainWorkspace) removeManagedWorktree(state.runId);
  }
}

function createRunId(version, commit) {
  const timestamp = nowIso()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return validateRunId(`android-${version}-${commit.slice(0, 7)}-${timestamp}`);
}

async function preflight(options) {
  assertOnlyOptions(options, ['version', 'source']);
  const version = requiredStringOption(options, 'version');
  const requestedSource = requiredStringOption(options, 'source').toLowerCase();
  if (!FULL_COMMIT_PATTERN.test(requestedSource))
    throw new Error('--source must be a full Git SHA');
  return await withReleaseLock('new', 'preflight', async () => {
    const sourceCommit = assertCleanCurrentSource();
    if (sourceCommit !== requestedSource) {
      throw new Error(`--source ${requestedSource} is not the current clean HEAD ${sourceCommit}`);
    }
    const sourceTree = git(['show', '-s', '--format=%T', sourceCommit]);
    const branch = git(['branch', '--show-current']) || 'detached';
    const project = readProjectVersionState();
    assertVersionAdvances(project.version, version);
    const releaseBranch = `release/android-${version}`;
    const branchExists = runCapture(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${releaseBranch}`],
      { allowFailure: true },
    ).status;
    if (branchExists === 0) throw new Error(`release branch already exists: ${releaseBranch}`);
    if (branchExists !== 1)
      throw new Error('could not determine whether the release branch exists');
    resolveCredentialPath('GOOGLE_SERVICES_JSON', 'google-services.json');
    const toolchain = runToolchainCheck({ root: ROOT });
    const runId = createRunId(version, sourceCommit);
    const directory = runDirectory(runId);
    if (existsSync(directory)) throw new Error(`release run already exists: ${runId}`);
    mkdirSync(directory, { mode: 0o700 });
    const preparedAt = nowIso();
    const state = {
      schemaVersion: 1,
      runId,
      phase: 'preflighted',
      source: { commit: sourceCommit, tree: sourceTree, branch },
      target: {
        version,
        platform: 'android',
        profile: 'production',
        environment: 'production',
        track: 'internal',
        applicationId: APPLICATION_ID,
        releaseBranch,
      },
      toolchain: {
        node: toolchain.node,
        npm: toolchain.npm,
        easCli: toolchain.easCli,
        localBuildPlugin: LOCAL_BUILD_PLUGIN_VERSION,
      },
      workspace: { token: randomUUID() },
      preparation: null,
      build: { status: 'not_started', remoteVersionMayHaveAdvanced: false },
      artifact: null,
      promotion: null,
      submission: { status: 'not_started' },
      failure: null,
      history: [historyEntry('preflight', 'passed')],
      createdAt: preparedAt,
    };
    writeImmutableJson(runFile(runId, 'preflight.json'), {
      schemaVersion: 1,
      runId,
      source: state.source,
      target: state.target,
      toolchain: state.toolchain,
      completedAt: preparedAt,
    });
    writeImmutableJson(runFile(runId, STATE_FILENAME), state);
    process.stdout.write(`${JSON.stringify({ runId, sourceCommit, version }, null, 2)}\n`);
  });
}

async function prepare(options) {
  assertOnlyOptions(options, ['run']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  await withReleaseLock(runId, 'prepare', async () => {
    const state = readState(runId);
    requirePhase(state, 'preflighted');
    assertCleanCurrentSource(state.source.commit);
    assertRecordedToolchain(state);
    const before = readProjectVersionState();
    const prepared = await withWorktree(state, { applyPreparedPatch: false }, async (worktree) => {
      runCapture(
        'npm',
        ['version', state.target.version, '--no-git-tag-version', '--ignore-scripts'],
        { cwd: worktree },
      );
      const after = readProjectVersionState(worktree);
      assertOnlyReleaseVersionsChanged(before, after, state.target.version);
      const changed = git(['-C', worktree, 'diff', '--name-only'])
        .split('\n')
        .filter(Boolean)
        .sort();
      if (!isDeepStrictEqual(changed, ['package-lock.json', 'package.json'])) {
        throw new Error(`version preparation changed unexpected paths: ${changed.join(', ')}`);
      }
      const patch = runCapture('git', [
        '-C',
        worktree,
        'diff',
        '--binary',
        '--',
        'package.json',
        'package-lock.json',
      ]).stdout;
      if (!patch) throw new Error('version preparation produced an empty patch');
      git(['-C', worktree, 'add', '--', 'package.json', 'package-lock.json']);
      const releaseTree = git(['-C', worktree, 'write-tree']);
      return { patch: `${patch}\n`, releaseTree };
    });
    const patchPath = runFile(runId, 'version.patch');
    writeImmutableFile(patchPath, prepared.patch);
    const completedAt = nowIso();
    const preparation = {
      patchSha256: sha256Bytes(prepared.patch),
      releaseTree: prepared.releaseTree,
      changedFiles: ['package.json', 'package-lock.json'],
      completedAt,
    };
    writeImmutableJson(runFile(runId, 'preparation.json'), {
      schemaVersion: 1,
      runId,
      targetVersion: state.target.version,
      ...preparation,
    });
    writeState({
      ...state,
      phase: 'prepared',
      preparation,
      history: [...state.history, historyEntry('prepare', 'passed')],
    });
    process.stdout.write(`Prepared ${runId} as tree ${prepared.releaseTree}.\n`);
  });
}

function resolveLocalBuildPlugin() {
  const executable = runCapture('npx', reviewedLocalBuildPluginNpxArgs()).stdout;
  if (!executable) throw new Error('could not resolve the pinned EAS local-build plugin');
  accessSync(executable, fsConstants.X_OK);
  let directory = dirname(realpathSync(executable));
  let resolvedVersion = null;
  while (true) {
    const packagePath = resolve(directory, 'package.json');
    if (existsSync(packagePath)) {
      const packageJson = readJson(packagePath);
      if (packageJson?.name === 'eas-cli-local-build-plugin') {
        resolvedVersion = packageJson.version;
        break;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (resolvedVersion !== LOCAL_BUILD_PLUGIN_VERSION) {
    throw new Error(
      `resolved EAS local-build plugin is ${String(resolvedVersion)}, expected ${LOCAL_BUILD_PLUGIN_VERSION}`,
    );
  }
  return executable;
}

function moveFailedArtifact(runId) {
  const pending = runFile(runId, 'artifact.pending.aab');
  const invalid = runFile(runId, 'artifact.invalid.aab');
  if (!existsSync(pending)) return null;
  if (existsSync(invalid)) throw new Error('invalid artifact path already exists');
  renameSync(pending, invalid);
  return 'artifact.invalid.aab';
}

async function build(options) {
  assertOnlyOptions(options, ['run', 'execute', 'confirm-remote-version-increment']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  requireFlag(options, 'execute', 'build requires --execute');
  requireFlag(
    options,
    'confirm-remote-version-increment',
    'build requires --confirm-remote-version-increment because EAS may consume a versionCode before compilation',
  );
  await withReleaseLock(runId, 'build', async () => {
    let state = readState(runId);
    requirePhase(state, 'prepared');
    assertCleanCurrentSource(state.source.commit);
    assertRecordedToolchain(state);
    const pendingPath = runFile(runId, 'artifact.pending.aab');
    if (existsSync(pendingPath) || existsSync(runFile(runId, 'artifact.invalid.aab'))) {
      throw new Error('release run already has a pending or invalid artifact');
    }
    const googleServices = resolveCredentialPath('GOOGLE_SERVICES_JSON', 'google-services.json');
    const localBuildPlugin = resolveLocalBuildPlugin();
    const easWorkingDirectory = prepareManagedEasDirectory(state);
    const startedAt = nowIso();
    state = {
      ...state,
      phase: 'building',
      build: {
        status: 'building',
        startedAt,
        remoteVersionMayHaveAdvanced: true,
      },
      history: [...state.history, historyEntry('build', 'started')],
    };
    writeState(state);

    let outcome;
    try {
      outcome = await withWorktree(state, { applyPreparedPatch: true }, async (worktree) => {
        const environment = { ...process.env };
        delete environment.EAS_LOCAL_BUILD_SKIP_CLEANUP;
        Object.assign(environment, {
          GOOGLE_SERVICES_JSON: googleServices,
          EAS_LOCAL_BUILD_PLUGIN_PATH: localBuildPlugin,
          EAS_LOCAL_BUILD_WORKINGDIR: easWorkingDirectory,
          GATOR_RELEASE_OUTPUT: pendingPath,
        });
        return await runInherited('npx', reviewedEasNpxArgs('build'), {
          cwd: worktree,
          env: environment,
          onSpawn: (processGroupId) => {
            state = {
              ...state,
              build: { ...state.build, processGroupId },
            };
            writeState(state);
          },
        });
      });
    } catch (error) {
      outcome = {
        status: null,
        signal: null,
        startError: String(error),
        processGroupId: error?.processGroupId ?? state.build.processGroupId ?? null,
        descendantsRunning: error?.retainWorkspace === true,
        retainWorkspace: error?.retainWorkspace === true,
      };
    } finally {
      if (!outcome?.retainWorkspace) removeManagedEasDirectory(state);
    }

    const finishedAt = nowIso();
    const succeeded =
      outcome?.status === 0 &&
      outcome?.signal == null &&
      outcome?.signalForwardingFailed !== true &&
      outcome?.descendantsRunning !== true &&
      existsSync(pendingPath) &&
      statSync(pendingPath).isFile() &&
      statSync(pendingPath).size > 0;
    if (!succeeded) {
      const retainedArtifact = outcome?.descendantsRunning
        ? existsSync(pendingPath)
          ? 'artifact.pending.aab'
          : null
        : moveFailedArtifact(runId);
      const failure = {
        phase: 'build',
        code: outcome?.descendantsRunning
          ? 'build_process_group_still_running'
          : outcome?.startError
            ? 'build_start_failed'
            : 'build_failed_or_missing_artifact',
        exitCode: outcome?.status ?? null,
        signal: outcome?.signal ?? null,
        processGroupId: outcome?.processGroupId ?? null,
        remoteVersionMayHaveAdvanced: true,
        retainedArtifact,
        at: finishedAt,
      };
      state = {
        ...state,
        phase: 'failed',
        build: { ...state.build, status: 'failed', finishedAt, ...failure },
        failure,
        history: [...state.history, historyEntry('build', 'failed')],
      };
      writeImmutableJson(runFile(runId, 'build-failure.json'), {
        schemaVersion: 1,
        runId,
        ...failure,
      });
      writeState(state);
      throw new Error(
        `release build failed; run ${runId} is terminal because its remote versionCode may have advanced`,
      );
    }

    const buildReceipt = {
      schemaVersion: 1,
      runId,
      mode: 'local',
      profile: 'production',
      environment: 'production',
      output: 'artifact.pending.aab',
      startedAt,
      finishedAt,
      remoteVersionMayHaveAdvanced: true,
      exitCode: 0,
    };
    writeImmutableJson(runFile(runId, 'build.json'), buildReceipt);
    writeState({
      ...state,
      phase: 'built',
      build: { ...state.build, status: 'built', finishedAt, exitCode: 0 },
      history: [...state.history, historyEntry('build', 'passed')],
    });
    process.stdout.write(`Built ${runId}; validate artifact.pending.aab before promotion.\n`);
  });
}

function uploadCertificateFingerprint(artifactPath) {
  runCapture('jarsigner', ['-verify', artifactPath]);
  const output = runCapture('keytool', [
    '-J-Duser.language=en',
    '-J-Duser.country=US',
    '-printcert',
    '-jarfile',
    artifactPath,
  ]).stdout;
  const fingerprints = new Set(
    [...output.matchAll(/SHA256:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})/gi)].map((match) =>
      match[1].toUpperCase(),
    ),
  );
  if (fingerprints.size !== 1) {
    throw new Error('AAB must expose exactly one SHA-256 upload-certificate fingerprint');
  }
  return [...fingerprints][0];
}

function inspectReleaseArtifact(artifactPath, state) {
  if (!existsSync(artifactPath)) {
    throw new Error('release artifact is missing');
  }
  const artifactState = lstatSync(artifactPath);
  if (!artifactState.isFile() || artifactState.isSymbolicLink()) {
    throw new Error('release artifact must be a regular non-symbolic file');
  }
  const bytes = artifactState.size;
  if (bytes <= 0) throw new Error('release artifact is empty');
  runCapture('unzip', ['-tqq', artifactPath]);
  const identity = inspectPackagedAndroidBundle(artifactPath);
  if (identity.applicationId !== APPLICATION_ID) {
    throw new Error(`AAB application id is ${identity.applicationId}, expected ${APPLICATION_ID}`);
  }
  if (identity.versionName !== state.target.version) {
    throw new Error(`AAB versionName is ${identity.versionName}, expected ${state.target.version}`);
  }
  return {
    ...identity,
    bytes,
    sha256: sha256File(artifactPath),
    uploadCertificateSha256: uploadCertificateFingerprint(artifactPath),
  };
}

async function validate(options) {
  assertOnlyOptions(options, ['run']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  await withReleaseLock(runId, 'validate', async () => {
    const state = readState(runId);
    requirePhase(state, 'built');
    const artifactPath = runFile(runId, 'artifact.pending.aab');
    let artifact;
    try {
      artifact = inspectReleaseArtifact(artifactPath, state);
    } catch (error) {
      const retainedArtifact = moveFailedArtifact(runId);
      const failure = {
        phase: 'validate',
        code: 'artifact_validation_failed',
        retainedArtifact,
        at: nowIso(),
      };
      writeImmutableJson(runFile(runId, 'validation-failure.json'), {
        schemaVersion: 1,
        runId,
        ...failure,
      });
      writeState({
        ...state,
        phase: 'failed',
        failure,
        history: [...state.history, historyEntry('validate', 'failed')],
      });
      throw error;
    }

    const validationPath = runFile(runId, 'validation.json');
    const completedAt = existsSync(validationPath)
      ? readJson(validationPath).validation?.completedAt
      : nowIso();
    if (typeof completedAt !== 'string') {
      throw new Error('existing validation receipt has an invalid completion time');
    }
    const receipt = {
      schemaVersion: 1,
      runId,
      applicationId: artifact.applicationId,
      targetVersion: state.target.version,
      versionName: artifact.versionName,
      versionCode: artifact.versionCode,
      versionCodeSource: 'eas-remote',
      sourceCommit: state.source.commit,
      releaseTree: state.preparation.releaseTree,
      build: {
        mode: 'local',
        profile: 'production',
        environment: 'production',
        easCli: REQUIRED_EAS_CLI_VERSION,
      },
      artifact: {
        filename: 'artifact.pending.aab',
        applicationId: artifact.applicationId,
        versionName: artifact.versionName,
        versionCode: artifact.versionCode,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        uploadCertificateSha256: artifact.uploadCertificateSha256,
      },
      validation: {
        status: 'passed',
        validator: 'scripts/check-android-build.mjs',
        checks: ['zip-integrity', 'packaged-artifact', 'identity', 'signature', 'hash'],
        completedAt,
      },
    };
    if (existsSync(validationPath)) {
      if (!isDeepStrictEqual(readJson(validationPath), receipt)) {
        throw new Error('existing validation receipt no longer matches the artifact');
      }
    } else {
      writeImmutableJson(validationPath, receipt);
    }
    writeState({
      ...state,
      phase: 'validated',
      artifact: receipt.artifact,
      failure: null,
      history: [...state.history, historyEntry('validate', 'passed')],
    });
    process.stdout.write(
      `Validated ${runId}: ${artifact.versionName} v${artifact.versionCode} ${artifact.sha256}.\n`,
    );
  });
}

function verifyRecordedArtifact(state, artifactPath) {
  const artifact = inspectReleaseArtifact(artifactPath, state);
  if (
    artifact.sha256 !== state.artifact?.sha256 ||
    artifact.bytes !== state.artifact?.bytes ||
    artifact.versionCode !== state.artifact?.versionCode ||
    artifact.uploadCertificateSha256 !== state.artifact?.uploadCertificateSha256
  ) {
    throw new Error('release artifact no longer matches its validation receipt');
  }
  return artifact;
}

async function promote(options) {
  assertOnlyOptions(options, ['run']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  await withReleaseLock(runId, 'promote', async () => {
    let state = readState(runId);
    requirePhase(state, 'validated', 'promoting');
    assertCleanCurrentSource(state.source.commit);
    const pendingPath = runFile(runId, 'artifact.pending.aab');
    const artifact = verifyRecordedArtifact(state, pendingPath);
    const releaseTree = state.preparation.releaseTree;
    git(['cat-file', '-e', `${releaseTree}^{tree}`]);
    if (state.phase === 'validated') {
      const releaseCommit = runCapture('git', [
        'commit-tree',
        releaseTree,
        '-p',
        state.source.commit,
        '-m',
        `chore(release): prepare Android ${state.target.version}`,
      ]).stdout;
      const committedTree = git(['show', '-s', '--format=%T', releaseCommit]);
      if (committedTree !== releaseTree) {
        throw new Error('release commit tree does not match build tree');
      }
      const artifactFilename = `gator-release-${state.target.version}-v${artifact.versionCode}-${releaseCommit.slice(0, 7)}.aab`;
      state = {
        ...state,
        phase: 'promoting',
        promotion: {
          status: 'promoting',
          branch: state.target.releaseBranch,
          commit: releaseCommit,
          tree: releaseTree,
          artifactFilename,
          startedAt: nowIso(),
        },
        history: [...state.history, historyEntry('promote', 'started')],
      };
      writeState(state);
    }

    const promotion = state.promotion;
    if (
      promotion?.status !== 'promoting' ||
      promotion.branch !== state.target.releaseBranch ||
      !FULL_COMMIT_PATTERN.test(promotion.commit) ||
      promotion.tree !== releaseTree
    ) {
      throw new Error('recorded promotion plan is invalid');
    }
    const expectedFilename = `gator-release-${state.target.version}-v${artifact.versionCode}-${promotion.commit.slice(0, 7)}.aab`;
    if (promotion.artifactFilename !== expectedFilename) {
      throw new Error('recorded promotion filename is invalid');
    }
    const committedTree = git(['show', '-s', '--format=%T', promotion.commit]);
    if (committedTree !== releaseTree) throw new Error('release commit tree changed');

    const releaseBranchRef = `refs/heads/${promotion.branch}`;
    const finalPath = resolve(ROOT, promotion.artifactFilename);
    const partialPath = runFile(runId, 'artifact.promoting.aab');
    const promotionReceiptPath = runFile(runId, 'promotion.json');
    try {
      if (existsSync(finalPath)) {
        verifyRecordedArtifact(state, finalPath);
      } else {
        if (existsSync(partialPath)) {
          verifyRecordedArtifact(state, partialPath);
        } else {
          copyFileSync(pendingPath, partialPath, fsConstants.COPYFILE_EXCL);
          verifyRecordedArtifact(state, partialPath);
        }
        try {
          linkSync(partialPath, finalPath);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        verifyRecordedArtifact(state, finalPath);
      }
      if (existsSync(partialPath)) unlinkSync(partialPath);

      const existingBranch = runCapture(
        'git',
        ['show-ref', '--hash', '--verify', releaseBranchRef],
        { allowFailure: true },
      );
      if (existingBranch.status === 0) {
        if (existingBranch.stdout !== promotion.commit) {
          throw new Error(`release branch points at another commit: ${promotion.branch}`);
        }
      } else if (existingBranch.status === 1) {
        git(['update-ref', releaseBranchRef, promotion.commit, ZERO_OBJECT_ID]);
      } else {
        throw new Error('could not determine whether the release branch exists');
      }

      const completedAt = nowIso();
      const receipt = {
        schemaVersion: 1,
        runId,
        sourceCommit: state.source.commit,
        targetVersion: state.target.version,
        versionCode: artifact.versionCode,
        sha256: artifact.sha256,
        uploadCertificateSha256: artifact.uploadCertificateSha256,
        branch: promotion.branch,
        commit: promotion.commit,
        tree: promotion.tree,
        artifactFilename: promotion.artifactFilename,
        completedAt,
      };
      if (existsSync(promotionReceiptPath)) {
        const existingReceipt = readJson(promotionReceiptPath);
        receipt.completedAt = existingReceipt.completedAt;
        if (!isDeepStrictEqual(existingReceipt, receipt)) {
          throw new Error('existing promotion receipt does not match the promotion plan');
        }
      } else {
        writeImmutableJson(promotionReceiptPath, receipt);
      }
      writeState({
        ...state,
        phase: 'promoted',
        artifact: { ...state.artifact, filename: promotion.artifactFilename },
        promotion: { ...promotion, status: 'promoted', completedAt: receipt.completedAt },
        history: [...state.history, historyEntry('promote', 'passed')],
      });
      process.stdout.write(
        `Promoted ${promotion.artifactFilename} from exact source ${promotion.commit} on ${promotion.branch}.\n`,
      );
    } catch (error) {
      const failure = {
        phase: 'promote',
        code: 'promotion_completion_unknown',
        at: nowIso(),
      };
      try {
        if (!existsSync(runFile(runId, 'promotion-unknown.json'))) {
          writeImmutableJson(runFile(runId, 'promotion-unknown.json'), {
            schemaVersion: 1,
            runId,
            ...failure,
          });
        }
        writeState({
          ...state,
          phase: 'promotion_unknown',
          failure,
          history: [...state.history, historyEntry('promote', 'unknown')],
        });
      } catch {
        // Preserve every artifact/ref/receipt for manual reconciliation if state persistence fails.
      }
      throw new Error(
        `promotion could not be proven complete; preserved all release material for review: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function submissionPhrase(state) {
  return `SUBMIT ${state.target.version} v${state.artifact.versionCode} ${state.artifact.sha256.slice(0, 12)} TO PLAY INTERNAL`;
}

function promotedArtifactPath(state) {
  const filename = state.promotion?.artifactFilename;
  if (
    typeof filename !== 'string' ||
    basename(filename) !== filename ||
    !filename.endsWith('.aab')
  ) {
    throw new Error('promoted artifact filename is invalid');
  }
  return resolve(ROOT, filename);
}

async function submit(options) {
  assertOnlyOptions(options, ['run', 'execute']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  const state = readState(runId);
  requirePhase(state, 'promoted');
  assertCleanCurrentSource(state.source.commit);
  runToolchainCheck({ root: ROOT });
  const artifactPath = promotedArtifactPath(state);
  verifyRecordedArtifact(state, artifactPath);
  const phrase = submissionPhrase(state);
  const commandPreview = `eas submit -p android --profile production --path ${state.promotion.artifactFilename} --non-interactive --wait`;
  if (options.get('execute') !== true) {
    process.stdout.write(
      `${commandPreview}\nNo submission was made. Re-run with --execute and type:\n${phrase}\n`,
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('executing Play submission requires an interactive terminal');
  }
  requireConfiguredSubmitCredential();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await prompt.question('Type the candidate-specific submission phrase exactly:\n> ');
  } finally {
    prompt.close();
  }
  if (answer !== phrase)
    throw new Error('submission confirmation did not match; no submission made');

  await withReleaseLock(runId, 'submit', async () => {
    let current = readState(runId);
    requirePhase(current, 'promoted');
    assertCleanCurrentSource(current.source.commit);
    runToolchainCheck({ root: ROOT });
    requireConfiguredSubmitCredential();
    verifyRecordedArtifact(current, artifactPath);
    const startedAt = nowIso();
    current = {
      ...current,
      phase: 'submitting',
      submission: { status: 'submitting', startedAt, track: 'internal' },
      history: [...current.history, historyEntry('submit', 'started')],
    };
    writeState(current);
    let outcome;
    try {
      outcome = await runInherited('npx', reviewedEasNpxArgs('submit'), {
        cwd: ROOT,
        env: { ...process.env, GATOR_RELEASE_ARTIFACT: artifactPath },
        onSpawn: (processGroupId) => {
          current = {
            ...current,
            submission: { ...current.submission, processGroupId },
          };
          writeState(current);
        },
      });
    } catch (error) {
      outcome = {
        status: null,
        signal: null,
        processGroupId: error?.processGroupId ?? current.submission.processGroupId ?? null,
        descendantsRunning: error?.retainWorkspace === true,
      };
    }
    const completedAt = nowIso();
    if (
      outcome.status !== 0 ||
      outcome.signal != null ||
      outcome.signalForwardingFailed === true ||
      outcome.descendantsRunning === true
    ) {
      const receipt = {
        schemaVersion: 1,
        runId,
        status: 'unknown',
        track: 'internal',
        exitCode: outcome.status ?? null,
        signal: outcome.signal,
        processGroupId: outcome.processGroupId ?? null,
        completedAt,
      };
      writeImmutableJson(runFile(runId, 'submission-unknown.json'), receipt);
      writeState({
        ...current,
        phase: 'submission_unknown',
        submission: receipt,
        history: [...current.history, historyEntry('submit', 'unknown')],
      });
      throw new Error(
        'submission did not complete cleanly; verify Play/EAS state before any retry',
      );
    }
    const receipt = {
      schemaVersion: 1,
      runId,
      status: 'submitted',
      track: 'internal',
      artifactFilename: state.promotion.artifactFilename,
      sha256: state.artifact.sha256,
      completedAt,
    };
    writeImmutableJson(runFile(runId, 'submission.json'), receipt);
    writeState({
      ...current,
      phase: 'submitted',
      submission: receipt,
      history: [...current.history, historyEntry('submit', 'passed')],
    });
    process.stdout.write(
      `Submitted ${state.promotion.artifactFilename} to Play Internal Testing.\n`,
    );
  });
}

async function reconcilePreparation(state) {
  const patchPath = runFile(state.runId, 'version.patch');
  const receiptPath = runFile(state.runId, 'preparation.json');
  const hasPatch = existsSync(patchPath);
  const hasReceipt = existsSync(receiptPath);
  if (!hasPatch && !hasReceipt) {
    process.stdout.write(
      `Release run ${state.runId} has no interrupted preparation to reconcile.\n`,
    );
    return;
  }
  if (!hasPatch || !hasReceipt) {
    const failure = {
      phase: 'prepare',
      code: 'preparation_interrupted',
      at: nowIso(),
    };
    writeState({
      ...state,
      phase: 'failed',
      failure,
      history: [...state.history, historyEntry('reconcile', 'preparation_failed')],
    });
    throw new Error('preparation was interrupted before its patch and receipt were both durable');
  }
  const receipt = readJson(receiptPath);
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.runId !== state.runId ||
    receipt.targetVersion !== state.target.version ||
    !FULL_COMMIT_PATTERN.test(receipt.releaseTree) ||
    receipt.patchSha256 !== sha256File(patchPath) ||
    !isDeepStrictEqual(receipt.changedFiles, ['package.json', 'package-lock.json']) ||
    typeof receipt.completedAt !== 'string'
  ) {
    throw new Error('preparation receipt does not match its release patch');
  }
  const preparation = {
    patchSha256: receipt.patchSha256,
    releaseTree: receipt.releaseTree,
    changedFiles: receipt.changedFiles,
    completedAt: receipt.completedAt,
  };
  const preparedState = { ...state, preparation };
  await withWorktree(preparedState, { applyPreparedPatch: true }, async () => null);
  writeState({
    ...preparedState,
    phase: 'prepared',
    history: [...state.history, historyEntry('reconcile', 'prepared')],
  });
  process.stdout.write(`Reconciled ${state.runId} to prepared without invoking EAS.\n`);
}

function reconcileBuilding(state) {
  assertReleaseProcessGroupsStopped(state);
  const successPath = runFile(state.runId, 'build.json');
  const failurePath = runFile(state.runId, 'build-failure.json');
  const hasSuccess = existsSync(successPath);
  const hasFailure = existsSync(failurePath);
  if (hasSuccess && hasFailure) {
    throw new Error('build has conflicting success and failure receipts');
  }
  if (hasSuccess) {
    const receipt = readJson(successPath);
    const pendingPath = runFile(state.runId, 'artifact.pending.aab');
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.runId !== state.runId ||
      receipt.mode !== 'local' ||
      receipt.profile !== 'production' ||
      receipt.environment !== 'production' ||
      receipt.output !== 'artifact.pending.aab' ||
      receipt.exitCode !== 0 ||
      typeof receipt.finishedAt !== 'string' ||
      !existsSync(pendingPath) ||
      !lstatSync(pendingPath).isFile() ||
      lstatSync(pendingPath).isSymbolicLink() ||
      lstatSync(pendingPath).size <= 0
    ) {
      throw new Error('successful build receipt or pending artifact is invalid');
    }
    writeState({
      ...state,
      phase: 'built',
      build: {
        ...state.build,
        status: 'built',
        finishedAt: receipt.finishedAt,
        exitCode: 0,
      },
      history: [...state.history, historyEntry('reconcile', 'built')],
    });
    process.stdout.write(`Reconciled ${state.runId} to built without invoking EAS.\n`);
    return;
  }
  if (hasFailure) {
    const receipt = readJson(failurePath);
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.runId !== state.runId ||
      receipt.phase !== 'build' ||
      receipt.remoteVersionMayHaveAdvanced !== true
    ) {
      throw new Error('build failure receipt is invalid');
    }
    const failure = { ...receipt };
    delete failure.schemaVersion;
    delete failure.runId;
    writeState({
      ...state,
      phase: 'failed',
      build: { ...state.build, status: 'failed', ...failure },
      failure,
      history: [...state.history, historyEntry('reconcile', 'build_failed')],
    });
    throw new Error(`reconciled ${state.runId} as a terminal failed build`);
  }

  const pendingPath = runFile(state.runId, 'artifact.pending.aab');
  let retainedArtifact = null;
  if (existsSync(pendingPath)) {
    const pendingState = lstatSync(pendingPath);
    retainedArtifact =
      pendingState.isFile() && !pendingState.isSymbolicLink()
        ? moveFailedArtifact(state.runId)
        : 'artifact.pending.aab';
  }
  const failure = {
    phase: 'build',
    code: 'build_interrupted_without_receipt',
    exitCode: null,
    signal: null,
    processGroupId: state.build?.processGroupId ?? null,
    remoteVersionMayHaveAdvanced: true,
    retainedArtifact,
    at: nowIso(),
  };
  writeImmutableJson(failurePath, { schemaVersion: 1, runId: state.runId, ...failure });
  writeState({
    ...state,
    phase: 'failed',
    build: { ...state.build, status: 'failed', ...failure },
    failure,
    history: [...state.history, historyEntry('reconcile', 'build_unknown')],
  });
  throw new Error(
    `reconciled ${state.runId} as terminal because an interrupted build has no conclusive receipt`,
  );
}

function reconcileSubmitting(state) {
  assertReleaseProcessGroupsStopped(state);
  const successPath = runFile(state.runId, 'submission.json');
  const unknownPath = runFile(state.runId, 'submission-unknown.json');
  const hasSuccess = existsSync(successPath);
  const hasUnknown = existsSync(unknownPath);
  if (hasSuccess && hasUnknown) {
    throw new Error('submission has conflicting success and unknown receipts');
  }
  if (hasSuccess) {
    const receipt = readJson(successPath);
    const artifactPath = promotedArtifactPath(state);
    verifyRecordedArtifact(state, artifactPath);
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.runId !== state.runId ||
      receipt.status !== 'submitted' ||
      receipt.track !== 'internal' ||
      receipt.artifactFilename !== state.promotion.artifactFilename ||
      receipt.sha256 !== state.artifact.sha256 ||
      typeof receipt.completedAt !== 'string'
    ) {
      throw new Error('submission success receipt does not match the promoted artifact');
    }
    writeState({
      ...state,
      phase: 'submitted',
      submission: receipt,
      history: [...state.history, historyEntry('reconcile', 'submitted')],
    });
    process.stdout.write(`Reconciled ${state.runId} to submitted from its conclusive receipt.\n`);
    return;
  }

  const receipt = hasUnknown
    ? readJson(unknownPath)
    : {
        schemaVersion: 1,
        runId: state.runId,
        status: 'unknown',
        track: 'internal',
        exitCode: null,
        signal: null,
        processGroupId: state.submission?.processGroupId ?? null,
        reconciledAfterInterruption: true,
        completedAt: nowIso(),
      };
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.runId !== state.runId ||
    receipt.status !== 'unknown' ||
    receipt.track !== 'internal' ||
    typeof receipt.completedAt !== 'string'
  ) {
    throw new Error('submission unknown receipt is invalid');
  }
  if (!hasUnknown) writeImmutableJson(unknownPath, receipt);
  writeState({
    ...state,
    phase: 'submission_unknown',
    submission: receipt,
    history: [...state.history, historyEntry('reconcile', 'submission_unknown')],
  });
  throw new Error('submission outcome is unknown; verify Play/EAS state before any retry');
}

async function reconcile(options) {
  assertOnlyOptions(options, ['run']);
  const runId = validateRunId(requiredStringOption(options, 'run'));
  await withReleaseLock(runId, 'reconcile', async () => {
    const state = readState(runId);
    assertCleanCurrentSource(state.source.commit);
    if (state.phase === 'preflighted') return await reconcilePreparation(state);
    if (state.phase === 'building') return reconcileBuilding(state);
    if (state.phase === 'submitting') return reconcileSubmitting(state);
    if (state.phase === 'promoting') {
      throw new Error('promotion is resumable through release:android:promote, not reconcile');
    }
    process.stdout.write(`Release run ${runId} is ${state.phase}; no reconciliation is needed.\n`);
  });
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertReleaseProcessGroupsStopped(state) {
  for (const processGroupId of [state.build?.processGroupId, state.submission?.processGroupId]) {
    if (processGroupIsRunning(processGroupId)) {
      throw new Error(
        `release process group ${processGroupId} is still running; operation refused`,
      );
    }
  }
}

async function cleanup(options) {
  assertOnlyOptions(options, ['run']);
  ensureReleaseRoot();
  const requestedRun = options.get('run');
  if (requestedRun != null && typeof requestedRun !== 'string') {
    throw new Error('--run must name a release run');
  }
  let effectiveRunId = typeof requestedRun === 'string' ? validateRunId(requestedRun) : null;
  let staleLockRemoved = false;
  if (existsSync(LOCK_PATH)) {
    const snapshot = readLockSnapshot();
    if (processIsRunning(snapshot.lock.pid)) {
      throw new Error(`release process ${snapshot.lock.pid} is still running; cleanup refused`);
    }
    const lockedRunId = snapshot.lock.runId;
    if (typeof lockedRunId === 'string' && RUN_ID_PATTERN.test(lockedRunId)) {
      if (effectiveRunId && effectiveRunId !== lockedRunId) {
        throw new Error(
          `stale lock belongs to ${lockedRunId}; cleanup for ${effectiveRunId} was refused`,
        );
      }
      if (!existsSync(runFile(lockedRunId, STATE_FILENAME))) {
        throw new Error(`stale lock names ${lockedRunId}, but its release state is missing`);
      }
      const lockedState = readState(lockedRunId);
      assertReleaseProcessGroupsStopped(lockedState);
      effectiveRunId = lockedRunId;
    } else if (lockedRunId !== 'new' && lockedRunId !== 'cleanup') {
      throw new Error('stale release lock has an invalid run id; refusing automatic removal');
    }
    if (!removeOwnedLock(snapshot)) {
      throw new Error('release lock changed during cleanup; the replacement lock was not removed');
    }
    staleLockRemoved = true;
  }
  await withReleaseLock(effectiveRunId ?? 'cleanup', 'cleanup', async () => {
    if (effectiveRunId) {
      if (!existsSync(runFile(effectiveRunId, STATE_FILENAME))) {
        throw new Error(`release state is missing for ${effectiveRunId}; cleanup refused`);
      }
      const releaseState = readState(effectiveRunId);
      assertReleaseProcessGroupsStopped(releaseState);
      removeManagedWorktree(effectiveRunId);
      removeManagedEasDirectory(releaseState);
      process.stdout.write(
        `Removed only temporary workspaces for ${effectiveRunId}; receipts and artifacts remain.\n`,
      );
      return;
    }
    process.stdout.write(
      staleLockRemoved
        ? 'Removed the stale release lock; receipts and artifacts remain.\n'
        : 'No stale release lock or temporary run workspace needed cleanup.\n',
    );
  });
}

function status(options) {
  assertOnlyOptions(options, ['run']);
  const requested = options.get('run');
  if (typeof requested === 'string') {
    process.stdout.write(`${JSON.stringify(readState(validateRunId(requested)), null, 2)}\n`);
    return;
  }
  if (!existsSync(RELEASE_ROOT)) {
    process.stdout.write('No Android release runs.\n');
    return;
  }
  const runs = readdirSync(RELEASE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => {
      try {
        const state = readState(entry.name);
        return {
          runId: state.runId,
          phase: state.phase,
          version: state.target.version,
          sourceCommit: state.source.commit,
        };
      } catch {
        return { runId: entry.name, phase: 'invalid' };
      }
    });
  process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
}

function usage() {
  return `Android release phases (no phase invokes another):
  preflight --version <x.y.z> --source <full-sha>
  prepare --run <run-id>
  build --run <run-id> --execute --confirm-remote-version-increment
  validate --run <run-id>
  promote --run <run-id>
  submit --run <run-id> [--execute]
  status [--run <run-id>]
  reconcile --run <run-id>
  cleanup [--run <run-id>]

Build is local but contacts EAS and may consume a remote versionCode. Submit defaults to a dry
command preview and requires an interactive candidate-specific confirmation when --execute is used.
`;
}

export async function runReleaseAndroid(argv = process.argv.slice(2)) {
  const [phase, ...args] = argv;
  const options = parseOptions(args);
  switch (phase) {
    case 'preflight':
      return await preflight(options);
    case 'prepare':
      return await prepare(options);
    case 'build':
      return await build(options);
    case 'validate':
      return await validate(options);
    case 'promote':
      return await promote(options);
    case 'submit':
      return await submit(options);
    case 'status':
      return status(options);
    case 'reconcile':
      return await reconcile(options);
    case 'cleanup':
      return await cleanup(options);
    case undefined:
    case 'help':
    case '--help':
      assertOnlyOptions(options, []);
      process.stdout.write(usage());
      return;
    default:
      throw new Error(`unknown release phase: ${String(phase)}\n\n${usage()}`);
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runReleaseAndroid().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
