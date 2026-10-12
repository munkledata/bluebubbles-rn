#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RELEASE_BUNDLE = 'android/app/build/outputs/bundle/release/app-release.aab';
const RELEASE_CONFIGURATION_NAMES = new Set(['Release', 'RelWithDebInfo', 'MinSizeRel']);
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', '.gradle', 'build', 'coverage', 'dist']);
const MAX_DISCOVERED_ENTRIES = 250_000;
const MAX_DISCOVERED_DIRECTORIES = 75_000;
const MAX_DISCOVERY_DEPTH = 48;
const MAX_COMPILE_DATABASES = 256;
const MAX_COMPILE_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_COMPILE_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_COMPILE_COMMANDS = 250_000;
const MAX_HERMES_CMAKE_CACHE_BYTES = 1024 * 1024;
const MAX_HERMES_NINJA_LOG_BYTES = 16 * 1024 * 1024;
const MAX_PROOF_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5_000;
const SOURCE_MAP_DESTINATION = '/gator/source';
const GRADLE_MAP_DESTINATION = '/gator/gradle';
const ANDROID_ABIS = new Set(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
const HERMES_DISABLED_NATIVE_SOURCE = 'lib/InternalJavaScript/internal_unit.c';
const HERMES_DISABLED_NATIVE_OUTPUT =
  'lib/InternalJavaScript/CMakeFiles/hermesInternalUnit_obj.dir/internal_unit.c.o';
const HERMES_SELECTED_BYTECODE_OUTPUT =
  'lib/InternalJavaScript/CMakeFiles/hermesInternalBytecode_obj.dir/InternalBytecode.cpp.o';
// React Native builds Hermes for release with CMAKE_BUILD_TYPE=MinSizeRel and, to build faster,
// for DEBUG with CMAKE_BUILD_TYPE=Release. A workspace that built both variants (CI assembles the
// debug APK before the release AAB) holds both databases, each with the same generated source.
const HERMES_CMAKE_BUILD_TYPES = new Set(['MinSizeRel', 'Release']);

function fail(message) {
  throw new Error(`Android native-path proof failed: ${message}`);
}

function normalizedAbsoluteMappingPath(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalized = resolve(path);
  if (/[^\x21-\x7e]|[=]/.test(normalized)) {
    throw new Error(`${label} contains whitespace, control characters, or '='`);
  }
  return normalized.split(sep).join('/');
}

/**
 * Return the exact flags used by clean Android C, C++, and assembly configurations.
 *
 * `-ffile-prefix-map` covers source-level values such as `__FILE__`, while
 * `-fdebug-prefix-map` covers compiler debug metadata. Both roots are explicit so a Gradle prefab
 * header path cannot escape the source-root mapping.
 */
function privateTmpPathSpellings(path, includePrivateTmpAlias) {
  if (!includePrivateTmpAlias) return [path];
  if (path === '/private/tmp') return [path, '/tmp'];
  if (path.startsWith('/private/tmp/')) return [path, path.slice('/private'.length)];
  return [path];
}

export function nativeCompilerPathMappingFlags({
  sourceRoot,
  gradleHome,
  includePrivateTmpAlias = false,
}) {
  const source = normalizedAbsoluteMappingPath(sourceRoot, 'native source root');
  const gradle = normalizedAbsoluteMappingPath(gradleHome, 'Gradle user home');
  if (source === gradle) throw new Error('native source root and Gradle user home must differ');
  return [
    ...privateTmpPathSpellings(source, includePrivateTmpAlias).flatMap((path) => [
      `-ffile-prefix-map=${path}=${SOURCE_MAP_DESTINATION}`,
      `-fdebug-prefix-map=${path}=${SOURCE_MAP_DESTINATION}`,
    ]),
    ...privateTmpPathSpellings(gradle, includePrivateTmpAlias).flatMap((path) => [
      `-ffile-prefix-map=${path}=${GRADLE_MAP_DESTINATION}`,
      `-fdebug-prefix-map=${path}=${GRADLE_MAP_DESTINATION}`,
    ]),
  ];
}

function isDescendantOrSame(parent, child) {
  const fromParent = relative(parent, child);
  return (
    fromParent === '' ||
    (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function readRegularFileOnce(path, maximumBytes, label) {
  let pathState;
  try {
    pathState = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!pathState.isFile() || pathState.isSymbolicLink() || realpathSync(path) !== path) {
    fail(`${label} must be a regular file without path indirection`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`${label} cannot be opened without following symbolic links`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== pathState.dev || before.ino !== pathState.ino) {
      fail(`${label} changed while it was opened`);
    }
    if (before.size <= 0 || before.size > maximumBytes) {
      fail(`${label} is empty or exceeds its ${maximumBytes}-byte limit`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed while it was read`);
      offset += count;
    }
    const after = fstatSync(descriptor);
    const confirmedPathState = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== confirmedPathState.dev ||
      after.ino !== confirmedPathState.ino
    ) {
      fail(`${label} changed while it was read`);
    }
    return { bytes, stat: after };
  } finally {
    closeSync(descriptor);
  }
}

function regularFileStat(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!state.isFile() || state.isSymbolicLink() || state.size <= 0) {
    fail(`${label} must be a non-empty regular file without following symbolic links`);
  }
  return state;
}

function unindirectedRegularFileStat(path, label) {
  const state = regularFileStat(path, label);
  if (realpathSync(path) !== path) fail(`${label} must not use path indirection`);
  return state;
}

function requireFreshEvidence(state, label, bundleMtimeMs, maximumProofAgeMs) {
  if (state.mtimeMs > bundleMtimeMs + MAX_FUTURE_SKEW_MS) {
    fail(`${label} is newer than the release AAB`);
  }
  if (bundleMtimeMs - state.mtimeMs > maximumProofAgeMs) {
    fail(`${label} is stale relative to the release AAB`);
  }
}

function releaseCompileDatabasePath(path, cxxRoot) {
  const segments = relative(cxxRoot, path).split(sep);
  if (segments.at(-1) !== 'compile_commands.json' || segments[0] === 'tools') return false;
  return segments.some((segment) => RELEASE_CONFIGURATION_NAMES.has(segment));
}

function discoverReleaseCompileDatabases(root) {
  const startingDirectories = ['android', 'modules', 'node_modules']
    .map((entry) => resolve(root, entry))
    .filter(existsSync);
  const pending = startingDirectories.map((path) => ({ path, depth: 0, cxxRoot: null }));
  const databases = [];
  let discoveredEntries = 0;
  let discoveredDirectories = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    discoveredDirectories += 1;
    if (discoveredDirectories > MAX_DISCOVERED_DIRECTORIES) {
      fail(`directory discovery exceeds its ${MAX_DISCOVERED_DIRECTORIES}-directory limit`);
    }
    if (current.depth > MAX_DISCOVERY_DEPTH) {
      fail(`directory discovery exceeds its depth limit at ${relative(root, current.path)}`);
    }

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      fail(`cannot inspect ${relative(root, current.path)}`);
    }
    for (const entry of entries) {
      discoveredEntries += 1;
      if (discoveredEntries > MAX_DISCOVERED_ENTRIES) {
        fail(`directory discovery exceeds its ${MAX_DISCOVERED_ENTRIES}-entry limit`);
      }
      const path = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) {
        if (current.cxxRoot || entry.name === '.cxx') {
          fail(`symbolic link is not allowed in native build metadata: ${relative(root, path)}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        const cxxRoot = current.cxxRoot ?? (entry.name === '.cxx' ? path : null);
        if (!cxxRoot && SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        pending.push({ path, depth: current.depth + 1, cxxRoot });
        continue;
      }
      if (entry.isFile() && current.cxxRoot && releaseCompileDatabasePath(path, current.cxxRoot)) {
        databases.push(path);
        if (databases.length > MAX_COMPILE_DATABASES) {
          fail(`more than ${MAX_COMPILE_DATABASES} release compile databases were discovered`);
        }
      }
    }
  }

  return databases.sort((left, right) => left.localeCompare(right, 'en-US'));
}

function commandTokens(record, label) {
  const hasCommand = typeof record.command === 'string';
  const hasArguments = Array.isArray(record.arguments);
  if (hasCommand === hasArguments) {
    fail(`${label} must contain exactly one of command or arguments`);
  }
  if (hasArguments) {
    if (
      record.arguments.length === 0 ||
      record.arguments.some((argument) => typeof argument !== 'string' || argument.length === 0)
    ) {
      fail(`${label} has an invalid arguments array`);
    }
    return record.arguments;
  }
  if (record.command.length === 0 || /[\r\n\0]/.test(record.command)) {
    fail(`${label} has an invalid command string`);
  }
  return record.command.trim().split(/\s+/);
}

/**
 * Hermes configures both internal-JavaScript implementations, so its compile database includes
 * one command for the disabled native-C alternative. When the bytecode implementation is selected,
 * CMake never generates that command's source or object. Admit only that exact pinned layout and
 * require durable evidence that Ninja built the selected bytecode object and final ABI library.
 */
function validateDisabledHermesNativeSource({
  record,
  sourcePath,
  directory,
  databasePath,
  sourceRoot,
  bundleMtimeMs,
  maximumProofAgeMs,
}) {
  const databaseSegments = relative(sourceRoot, databasePath).split(sep);
  if (
    databaseSegments.length !== 9 ||
    databaseSegments[0] !== 'node_modules' ||
    databaseSegments[1] !== 'react-native' ||
    databaseSegments[2] !== 'ReactAndroid' ||
    databaseSegments[3] !== 'hermes-engine' ||
    databaseSegments[4] !== '.cxx' ||
    !HERMES_CMAKE_BUILD_TYPES.has(databaseSegments[5]) ||
    !/^[a-z0-9]+$/i.test(databaseSegments[6] ?? '') ||
    !ANDROID_ABIS.has(databaseSegments[7]) ||
    databaseSegments[8] !== 'compile_commands.json' ||
    directory !== dirname(databasePath) ||
    record.output !== HERMES_DISABLED_NATIVE_OUTPUT
  ) {
    return false;
  }

  const sourceParent = dirname(sourcePath);
  if (!existsSync(sourceParent)) return false;
  const canonicalSourcePath = resolve(realpathSync(sourceParent), 'internal_unit.c');
  if (canonicalSourcePath !== resolve(directory, HERMES_DISABLED_NATIVE_SOURCE)) return false;

  const buildType = databaseSegments[5];
  const fingerprint = databaseSegments[6];
  const abi = databaseSegments[7];
  const disabledObject = resolve(directory, HERMES_DISABLED_NATIVE_OUTPUT);
  if (existsSync(disabledObject)) {
    fail('disabled Hermes native-JavaScript object exists without its declared source');
  }

  const cache = readRegularFileOnce(
    resolve(directory, 'CMakeCache.txt'),
    MAX_HERMES_CMAKE_CACHE_BYTES,
    'Hermes CMake cache',
  );
  requireFreshEvidence(cache.stat, 'Hermes CMake cache', bundleMtimeMs, maximumProofAgeMs);
  const cacheSettingPrefix = 'HERMESVM_INTERNAL_JAVASCRIPT_NATIVE:';
  const cacheSetting = `${cacheSettingPrefix}BOOL=OFF`;
  const matchingCacheLines = cache.bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(cacheSettingPrefix));
  if (matchingCacheLines.length !== 1 || matchingCacheLines[0] !== cacheSetting) {
    fail('Hermes CMake cache does not select the bytecode internal-JavaScript implementation');
  }

  const selectedBytecodeObject = resolve(directory, HERMES_SELECTED_BYTECODE_OUTPUT);
  const selectedObjectState = unindirectedRegularFileStat(
    selectedBytecodeObject,
    'selected Hermes bytecode object',
  );
  requireFreshEvidence(
    selectedObjectState,
    'selected Hermes bytecode object',
    bundleMtimeMs,
    maximumProofAgeMs,
  );

  const hermesRoot = resolve(sourceRoot, 'node_modules/react-native/ReactAndroid/hermes-engine');
  const finalLibrary = resolve(
    hermesRoot,
    'build/intermediates/cxx',
    buildType,
    fingerprint,
    'obj',
    abi,
    'libhermesvm.so',
  );
  const finalLibraryState = unindirectedRegularFileStat(
    finalLibrary,
    'selected Hermes ABI library',
  );
  requireFreshEvidence(
    finalLibraryState,
    'selected Hermes ABI library',
    bundleMtimeMs,
    maximumProofAgeMs,
  );

  const ninjaLog = readRegularFileOnce(
    resolve(directory, '.ninja_log'),
    MAX_HERMES_NINJA_LOG_BYTES,
    'Hermes Ninja log',
  );
  requireFreshEvidence(ninjaLog.stat, 'Hermes Ninja log', bundleMtimeMs, maximumProofAgeMs);
  const ninjaLines = ninjaLog.bytes.toString('utf8').split(/\r?\n/);
  if (ninjaLines.shift() !== '# ninja log v5') {
    fail('Hermes Ninja log has an invalid header');
  }
  const ninjaOutputs = ninjaLines.filter(Boolean).map((line) => {
    const columns = line.split('\t');
    if (
      columns.length !== 5 ||
      columns.slice(0, 3).some((field) => !/^\d{1,20}$/.test(field)) ||
      !columns[3] ||
      columns[3].length > 32 * 1024 ||
      /[^\x21-\x7e]/.test(columns[3]) ||
      !/^[0-9a-f]{1,16}$/i.test(columns[4] ?? '')
    ) {
      fail('Hermes Ninja log has an invalid record');
    }
    return columns[3];
  });
  const disabledNinjaOutputs = new Set([
    HERMES_DISABLED_NATIVE_SOURCE,
    HERMES_DISABLED_NATIVE_OUTPUT,
    `./${HERMES_DISABLED_NATIVE_SOURCE}`,
    `./${HERMES_DISABLED_NATIVE_OUTPUT}`,
    ...privateTmpPathSpellings(resolve(directory, HERMES_DISABLED_NATIVE_SOURCE), true),
    ...privateTmpPathSpellings(resolve(directory, HERMES_DISABLED_NATIVE_OUTPUT), true),
  ]);
  if (ninjaOutputs.some((output) => disabledNinjaOutputs.has(output))) {
    fail('Hermes Ninja log says a disabled native-JavaScript source or object was built');
  }
  if (!ninjaOutputs.includes(HERMES_SELECTED_BYTECODE_OUTPUT)) {
    fail('Hermes Ninja log does not prove the selected bytecode object was built');
  }
  const finalLibrarySpellings = privateTmpPathSpellings(finalLibrary, true);
  if (!ninjaOutputs.some((output) => finalLibrarySpellings.includes(output))) {
    fail('Hermes Ninja log does not prove the selected ABI library was built');
  }
  return true;
}

function validateCompileCommand(
  record,
  { label, expectedFlags, sourceRoot, databasePath, bundleMtimeMs, maximumProofAgeMs },
) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${label} is not an object`);
  }
  if (typeof record.directory !== 'string' || !isAbsolute(record.directory)) {
    fail(`${label} has a non-absolute directory`);
  }
  if (typeof record.file !== 'string' || record.file.length === 0) {
    fail(`${label} has no source file`);
  }
  const directory = realpathSync(record.directory);
  if (!isDescendantOrSame(sourceRoot, directory)) {
    fail(`${label} belongs to a different source tree`);
  }
  const sourcePath = isAbsolute(record.file)
    ? resolve(record.file)
    : resolve(record.directory, record.file);

  const tokens = commandTokens(record, label);
  for (const flag of expectedFlags) {
    const selector = flag.slice(0, flag.lastIndexOf('=') + 1);
    const matches = tokens.filter((token) => token.startsWith(selector));
    if (matches.length === 0) fail(`${label} is missing required compiler flag ${flag}`);
    if (matches.length !== 1 || matches[0] !== flag) {
      fail(`${label} has a conflicting or duplicate compiler path map for ${selector}`);
    }
  }
  const pathMaps = tokens.filter(
    (token) => token.startsWith('-ffile-prefix-map=') || token.startsWith('-fdebug-prefix-map='),
  );
  if (
    pathMaps.length !== expectedFlags.length ||
    pathMaps.some((pathMap) => !expectedFlags.includes(pathMap))
  ) {
    fail(`${label} has an unexpected compiler path map`);
  }

  if (!existsSync(sourcePath)) {
    if (
      validateDisabledHermesNativeSource({
        record,
        sourcePath,
        directory,
        databasePath,
        sourceRoot,
        bundleMtimeMs,
        maximumProofAgeMs,
      })
    ) {
      return;
    }
    fail(`${label} names a missing source file`);
  }
  if (!statSync(sourcePath).isFile()) fail(`${label} source is not a regular file`);
  const realSourcePath = realpathSync(sourcePath);
  if (!isDescendantOrSame(sourceRoot, realSourcePath)) {
    fail(`${label} source file belongs to a different source tree`);
  }
}

export function runAndroidNativePathCheck({
  root = ROOT,
  sourceRoot = root,
  gradleHome = process.env.GRADLE_USER_HOME,
  releaseBundlePath = resolve(root, DEFAULT_RELEASE_BUNDLE),
  nowMs = Date.now(),
  maximumDatabaseBytes = MAX_COMPILE_DATABASE_BYTES,
  maximumTotalDatabaseBytes = MAX_TOTAL_COMPILE_DATABASE_BYTES,
  maximumProofAgeMs = MAX_PROOF_AGE_MS,
} = {}) {
  const canonicalRoot = realpathSync(resolve(root));
  const canonicalSourceRoot = realpathSync(resolve(sourceRoot));
  if (canonicalSourceRoot !== canonicalRoot) {
    fail('native source root must identify the checked repository');
  }
  if (typeof gradleHome !== 'string' || !isAbsolute(gradleHome) || !existsSync(gradleHome)) {
    fail('GRADLE_USER_HOME must identify an existing absolute directory');
  }
  const canonicalGradleHome = realpathSync(gradleHome);
  if (!statSync(canonicalGradleHome).isDirectory()) {
    fail('GRADLE_USER_HOME must identify a directory');
  }
  if (
    isDescendantOrSame(canonicalSourceRoot, canonicalGradleHome) ||
    isDescendantOrSame(canonicalGradleHome, canonicalSourceRoot)
  ) {
    fail('GRADLE_USER_HOME and the checked repository must be separate trees');
  }
  const expectedFlags = nativeCompilerPathMappingFlags({
    sourceRoot: canonicalSourceRoot,
    gradleHome: canonicalGradleHome,
    includePrivateTmpAlias: true,
  });

  const bundle = regularFileStat(resolve(releaseBundlePath), 'release AAB');
  if (bundle.mtimeMs > nowMs + MAX_FUTURE_SKEW_MS) {
    fail('release AAB has a future modification time');
  }
  if (nowMs - bundle.mtimeMs > maximumProofAgeMs) {
    fail('release AAB is stale; run this proof immediately after a clean build');
  }

  const databases = discoverReleaseCompileDatabases(canonicalRoot);
  if (databases.length === 0) fail('no release compile_commands.json database was discovered');
  let databaseBytes = 0;
  let commandCount = 0;

  for (const databasePath of databases) {
    const databaseLabel = relative(canonicalRoot, databasePath).split(sep).join('/');
    const snapshot = readRegularFileOnce(
      databasePath,
      maximumDatabaseBytes,
      `compile database ${databaseLabel}`,
    );
    databaseBytes += snapshot.bytes.length;
    if (databaseBytes > maximumTotalDatabaseBytes) {
      fail(`compile databases exceed their ${maximumTotalDatabaseBytes}-byte aggregate limit`);
    }
    if (snapshot.stat.mtimeMs > bundle.mtimeMs + MAX_FUTURE_SKEW_MS) {
      fail(`compile database ${databaseLabel} is newer than the release AAB`);
    }
    if (bundle.mtimeMs - snapshot.stat.mtimeMs > maximumProofAgeMs) {
      fail(`compile database ${databaseLabel} is stale relative to the release AAB`);
    }

    let records;
    try {
      records = JSON.parse(snapshot.bytes.toString('utf8'));
    } catch {
      fail(`compile database ${databaseLabel} is malformed JSON`);
    }
    if (!Array.isArray(records) || records.length === 0) {
      fail(`compile database ${databaseLabel} must contain a non-empty command array`);
    }
    commandCount += records.length;
    if (commandCount > MAX_COMPILE_COMMANDS) {
      fail(`compile commands exceed their ${MAX_COMPILE_COMMANDS}-record limit`);
    }
    records.forEach((record, index) =>
      validateCompileCommand(record, {
        label: `${databaseLabel}[${index}]`,
        expectedFlags,
        sourceRoot: canonicalSourceRoot,
        databasePath,
        bundleMtimeMs: bundle.mtimeMs,
        maximumProofAgeMs,
      }),
    );
  }

  return {
    compileDatabases: databases.length,
    compileCommands: commandCount,
    databaseBytes,
    expectedFlags,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: node scripts/check-android-native-paths.mjs');
    }
    const result = runAndroidNativePathCheck();
    process.stdout.write(
      `Android native-path proof passed: ${result.compileDatabases} release compile databases, ${result.compileCommands} compiler commands, ${result.databaseBytes} bytes.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
