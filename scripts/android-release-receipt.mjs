import { isDeepStrictEqual } from 'node:util';

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RELEASE_AAB_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_NATIVE_COMPILE_DATABASES = 256;
const MAX_RELEASE_NATIVE_COMPILE_COMMANDS = 250_000;
const MAX_RELEASE_NATIVE_DATABASE_BYTES = 128 * 1024 * 1024;
const RELEASE_NATIVE_PROOF_KEYS = Object.freeze([
  'compileCommands',
  'compileDatabases',
  'databaseBytes',
  'gradleDestination',
  'schemaVersion',
  'sourceDestination',
]);
const RELEASE_BUILD_ARTIFACT_KEYS = Object.freeze(['bytes', 'filename', 'sha256']);
const RELEASE_BUILD_RECEIPT_KEYS = Object.freeze([
  'artifact',
  'environment',
  'exitCode',
  'finishedAt',
  'mode',
  'nativePathProof',
  'output',
  'profile',
  'remoteVersionMayHaveAdvanced',
  'runId',
  'schemaVersion',
  'startedAt',
]);

function hasExactKeys(value, expected) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), expected)
  );
}

function isExactIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function isValidReleaseNativePathProof(proof) {
  if (!hasExactKeys(proof, RELEASE_NATIVE_PROOF_KEYS)) return false;
  const boundedPositiveInteger = (value, maximum) =>
    Number.isSafeInteger(value) && value > 0 && value <= maximum;
  return (
    proof.schemaVersion === 1 &&
    boundedPositiveInteger(proof.compileDatabases, MAX_RELEASE_NATIVE_COMPILE_DATABASES) &&
    boundedPositiveInteger(proof.compileCommands, MAX_RELEASE_NATIVE_COMPILE_COMMANDS) &&
    proof.compileCommands >= proof.compileDatabases &&
    boundedPositiveInteger(proof.databaseBytes, MAX_RELEASE_NATIVE_DATABASE_BYTES) &&
    proof.sourceDestination === '/gator/source' &&
    proof.gradleDestination === '/gator/gradle'
  );
}

export function isValidReleaseBuildReceipt(receipt, { runId, artifact } = {}) {
  if (!hasExactKeys(receipt, RELEASE_BUILD_RECEIPT_KEYS)) return false;
  if (!hasExactKeys(receipt.artifact, RELEASE_BUILD_ARTIFACT_KEYS)) return false;
  if (
    receipt.schemaVersion !== 2 ||
    !RUN_ID_PATTERN.test(receipt.runId) ||
    (runId != null && receipt.runId !== runId) ||
    receipt.mode !== 'local' ||
    receipt.profile !== 'production' ||
    receipt.environment !== 'production' ||
    receipt.output !== 'artifact.pending.aab' ||
    receipt.remoteVersionMayHaveAdvanced !== true ||
    receipt.exitCode !== 0 ||
    !isExactIsoTimestamp(receipt.startedAt) ||
    !isExactIsoTimestamp(receipt.finishedAt) ||
    receipt.finishedAt < receipt.startedAt ||
    receipt.artifact.filename !== receipt.output ||
    !Number.isSafeInteger(receipt.artifact.bytes) ||
    receipt.artifact.bytes <= 0 ||
    receipt.artifact.bytes > MAX_RELEASE_AAB_BYTES ||
    !SHA256_PATTERN.test(receipt.artifact.sha256) ||
    !isValidReleaseNativePathProof(receipt.nativePathProof)
  ) {
    return false;
  }
  return (
    artifact == null ||
    (receipt.artifact.bytes === artifact.bytes && receipt.artifact.sha256 === artifact.sha256)
  );
}
