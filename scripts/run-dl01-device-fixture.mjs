#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DL01_FIXTURE_TOKEN_ENV, startDl01FixtureServer } from './dl01-hostile-fixture.mjs';

const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,62}$/;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^android-[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const APK_NAME = /^[A-Za-z0-9._-]+\.apk$/;
const AAB_NAME = /^[A-Za-z0-9._-]+\.aab$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLER = /^(?:none|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UI_XML_BYTES = 4 * 1024 * 1024;

export const DL01_DIAGNOSTIC_SECTIONS = Object.freeze({
  'EXACT CANDIDATE': Object.freeze([
    'App version',
    'App build',
    'Android API',
    'Schema migrations',
    'Schema head',
    'DB / ownership bookends',
  ]),
  'DOWNLOAD ACTIVITY': Object.freeze([
    'Active transfers',
    'Owned destinations',
    'Temporary scan',
    'Temporary files',
    'Temporary bytes',
  ]),
  'GALLERY / ALBUM RECEIPTS': Object.freeze([
    'Pending',
    'Completed',
    'Terminal',
    'Gallery',
    'Gator Album',
    'Attempts 0 / 1',
    'Attempts 2 / 3',
    'Active leases',
    'Latest receipt present',
    'Latest pending',
    'Latest completed',
    'Latest terminal',
    'Latest Gallery',
    'Latest Gator Album',
    'Latest leased',
    'Latest attempts',
    'Latest has local path',
  ]),
  'ATTACHMENT CACHE': Object.freeze([
    'Attachment rows',
    'Rows with local path',
    'Distinct local paths',
    'Ledger files',
    'Ledger bytes',
    'Active files / bytes',
    'Reserved files / bytes',
    'Retiring files / bytes',
    'Within 2 GiB',
    'Within 4,096 files',
    'Native scan',
    'Native files',
    'Native bytes',
    'Missing active',
    'Byte mismatches',
    'Reserved present / missing',
    'Retiring present / missing',
    'Untracked native',
    'Settled DB/file exact',
    'Current generation',
    'Foreign generation',
    'Unscoped generation',
    'Legacy layout',
    'Free-space scan',
    'Available storage',
    '512 MiB floor met',
  ]),
  'LIVE OWNERSHIP': Object.freeze([
    'Reservations',
    'Reserved maximum',
    'Retirement owners',
    'Pending retirements',
    'Protected paths',
    'Protection owners',
  ]),
  'SYNCED WALLPAPERS': Object.freeze([
    'DB channels',
    'DB local references',
    'Distinct references',
    'Channel without path',
    'Path without channel',
    'Native scan',
    'Native files',
    'Native bytes',
    'Within 90 MiB / 255',
    'Within 100 MiB / 256',
    'Reference scan',
    'Valid references',
    'Invalid or missing',
  ]),
});

export const DL01_DIAGNOSTIC_LABELS = Object.freeze([
  ...new Set(Object.values(DL01_DIAGNOSTIC_SECTIONS).flat()),
]);

const DIAGNOSTIC_SECTION_SET = new Set(Object.keys(DL01_DIAGNOSTIC_SECTIONS));
const DIAGNOSTIC_ROW_SET = new Set(
  Object.entries(DL01_DIAGNOSTIC_SECTIONS).flatMap(([section, labels]) =>
    labels.map((label) => `${section}\0${label}`),
  ),
);
const EXPECTED_DIAGNOSTIC_KEYS = Object.freeze(
  Object.entries(DL01_DIAGNOSTIC_SECTIONS).flatMap(([section, labels]) =>
    labels.map((label) => `${section} / ${label}`),
  ),
);
const BOOLEAN_DIAGNOSTIC_LABELS = new Set([
  'DB / ownership bookends',
  'Latest receipt present',
  'Latest pending',
  'Latest completed',
  'Latest terminal',
  'Latest Gallery',
  'Latest Gator Album',
  'Latest leased',
  'Latest has local path',
  'Within 2 GiB',
  'Within 4,096 files',
  'Settled DB/file exact',
  '512 MiB floor met',
  'Within 90 MiB / 255',
  'Within 100 MiB / 256',
]);
const STATUS_DIAGNOSTIC_LABELS = new Set([
  'Temporary scan',
  'Native scan',
  'Free-space scan',
  'Reference scan',
]);
const BYTES_DIAGNOSTIC_LABELS = new Set([
  'Temporary bytes',
  'Ledger bytes',
  'Native bytes',
  'Available storage',
  'Reserved maximum',
]);
const COUNT_PAIR_DIAGNOSTIC_LABELS = new Set([
  'Attempts 0 / 1',
  'Attempts 2 / 3',
  'Reserved present / missing',
  'Retiring present / missing',
]);
const COUNT_BYTES_PAIR_DIAGNOSTIC_LABELS = new Set([
  'Active files / bytes',
  'Reserved files / bytes',
  'Retiring files / bytes',
]);
const COUNT_VALUE = /^(?:Unavailable|0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/;
const BYTES_VALUE =
  /^(?:Unavailable|(?:0|[1-9]\d{0,2}(?:,\d{3})*) B|(?:0|[1-9]\d*)\.\d{2} (?:KiB|MiB|GiB))$/;

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

function requiredInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return parsed;
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return resolve(value);
}

function parsePairs(argv, allowed) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) {
      throw new Error(`Unknown, repeated, or incomplete argument: ${String(key)}`);
    }
    values.set(key, value);
  }
  return values;
}

/** Parse only an exact device-loopback origin; paths, credentials, and implicit ports are refused. */
export function parseDeviceBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be an exact http://127.0.0.1:PORT origin.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('--base-url must be an exact http://127.0.0.1:PORT origin.');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--base-url contains an invalid port.');
  }
  return { origin: `http://127.0.0.1:${port}`, port };
}

/** Backward-compatible arguments for the long-lived fixture-server command. */
export function parseDl01DeviceFixtureArgs(argv) {
  const values = parsePairs(
    argv,
    new Set(['--serial', '--package', '--base-url', '--firebase-project-id', '--rcs-permissions']),
  );
  const serial = requiredString(values.get('--serial'), '--serial', SERIAL);
  const packageName = requiredString(values.get('--package'), '--package', PACKAGE);
  const base = parseDeviceBaseUrl(values.get('--base-url'));
  const firebaseProjectId = values.get('--firebase-project-id') ?? null;
  if (firebaseProjectId !== null && !PROJECT_ID.test(firebaseProjectId)) {
    throw new Error('--firebase-project-id is invalid.');
  }
  const rcsPermissions = values.get('--rcs-permissions');
  if (rcsPermissions !== undefined && rcsPermissions !== 'yes') {
    throw new Error('--rcs-permissions must be yes when provided.');
  }
  return { serial, packageName, base, firebaseProjectId, rcsPermissions: rcsPermissions === 'yes' };
}

export function parseDl01CandidateArgs(argv, options = {}) {
  const allowed = new Set([
    '--serial',
    '--package',
    '--expected-version',
    '--expected-code',
    '--expected-min-sdk',
    '--expected-target-sdk',
    '--expected-api',
    '--expected-installer',
    '--expected-play-cert-sha256',
    '--expected-aab-sha256',
    '--expected-source-commit',
    '--require-qemu',
    '--aab',
    '--validation-receipt',
    '--promotion-receipt',
    '--state-receipt',
    '--submission-recovery-receipt',
    '--apksigner',
    ...(options.diagnostics ? ['--scrolls'] : []),
  ]);
  const values = parsePairs(argv, allowed);
  const qemu = values.get('--require-qemu');
  if (qemu !== 'yes' && qemu !== 'no') {
    throw new Error('--require-qemu must be yes or no.');
  }
  const expectedInstaller = requiredString(
    values.get('--expected-installer'),
    '--expected-installer',
    INSTALLER,
  );
  const parsed = {
    serial: requiredString(values.get('--serial'), '--serial', SERIAL),
    packageName: requiredString(values.get('--package'), '--package', PACKAGE),
    expectedVersion: requiredString(
      values.get('--expected-version'),
      '--expected-version',
      VERSION_NAME,
    ),
    expectedCode: requiredInteger(values.get('--expected-code'), '--expected-code', 1),
    expectedMinSdk: requiredInteger(values.get('--expected-min-sdk'), '--expected-min-sdk', 1, 100),
    expectedTargetSdk: requiredInteger(
      values.get('--expected-target-sdk'),
      '--expected-target-sdk',
      1,
      100,
    ),
    expectedApi: requiredInteger(values.get('--expected-api'), '--expected-api', 1, 100),
    expectedInstaller: expectedInstaller === 'none' ? null : expectedInstaller,
    expectedPlayCertificateSha256: requiredString(
      values.get('--expected-play-cert-sha256')?.toLowerCase(),
      '--expected-play-cert-sha256',
      SHA256,
    ),
    expectedAabSha256: requiredString(
      values.get('--expected-aab-sha256')?.toLowerCase(),
      '--expected-aab-sha256',
      SHA256,
    ),
    expectedSourceCommit: requiredString(
      values.get('--expected-source-commit')?.toLowerCase(),
      '--expected-source-commit',
      COMMIT,
    ),
    requireQemu: qemu === 'yes',
    aabPath: requiredPath(values.get('--aab'), '--aab'),
    validationReceiptPath: requiredPath(values.get('--validation-receipt'), '--validation-receipt'),
    promotionReceiptPath: requiredPath(values.get('--promotion-receipt'), '--promotion-receipt'),
    stateReceiptPath: requiredPath(values.get('--state-receipt'), '--state-receipt'),
    submissionRecoveryReceiptPath: values.has('--submission-recovery-receipt')
      ? requiredPath(values.get('--submission-recovery-receipt'), '--submission-recovery-receipt')
      : null,
    apksignerPath: requiredPath(values.get('--apksigner'), '--apksigner'),
  };
  if (options.diagnostics) {
    parsed.scrolls = requiredInteger(values.get('--scrolls') ?? '8', '--scrolls', 0, 12);
  }
  return parsed;
}

function runFile(file, args, label, timeout = 30_000, maxBuffer = MAX_COMMAND_OUTPUT_BYTES) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer }, (error, stdout) => {
      if (error) {
        rejectPromise(new Error(`${label} failed.`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function adb(serial, args, timeout = 30_000, maxBuffer = MAX_COMMAND_OUTPUT_BYTES) {
  return runFile(
    'adb',
    ['-s', serial, ...args],
    `adb ${args[0] ?? 'operation'}`,
    timeout,
    maxBuffer,
  );
}

function reverseMappings(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ remote: parts.at(-2), local: parts.at(-1) }));
}

export function parseInstalledPackageDump(output, packageName) {
  const marker = `Package [${packageName}]`;
  const start = typeof output === 'string' ? output.indexOf(marker) : -1;
  if (start < 0) {
    throw new Error('The exact Android package is not installed on that device.');
  }
  const remainder = output.slice(start);
  const nextPackage = remainder.indexOf('\n  Package [', marker.length);
  const packageBlock = nextPackage < 0 ? remainder : remainder.slice(0, nextPackage);
  const sdk = /versionCode=(\d+)\s+minSdk=(\d+)\s+targetSdk=(\d+)/u.exec(packageBlock);
  const versionName = /^\s*versionName=([^\s]+)\s*$/mu.exec(packageBlock)?.[1];
  const installerMatch = /^\s*installerPackageName=([^\s]+)\s*$/mu.exec(packageBlock)?.[1] ?? null;
  if (
    !sdk ||
    versionName === undefined ||
    !VERSION_NAME.test(versionName) ||
    (installerMatch !== null && installerMatch !== 'null' && !PACKAGE.test(installerMatch))
  ) {
    throw new Error('The installed Android package identity could not be read.');
  }
  const values = [sdk[1], sdk[2], sdk[3]].map(Number);
  if (
    !Number.isSafeInteger(values[0]) ||
    values[0] < 1 ||
    values[0] > 100_000_000 ||
    values.slice(1).some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100)
  ) {
    throw new Error('The installed Android package identity is invalid.');
  }
  return {
    versionCode: values[0],
    minSdk: values[1],
    targetSdk: values[2],
    versionName,
    installerPackageName: installerMatch === 'null' ? null : installerMatch,
  };
}

function exactLines(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function verifyReadyDevice(serial) {
  const state = (await adb(serial, ['get-state'])).trim();
  if (state !== 'device') throw new Error('The exact Android serial is not ready.');
}

async function verifyExactDevice(serial, packageName) {
  await verifyReadyDevice(serial);
  const installedPaths = exactLines(await adb(serial, ['shell', 'pm', 'path', packageName]));
  if (installedPaths.length === 0 || installedPaths.some((line) => !line.startsWith('package:'))) {
    throw new Error('The exact Android package is not installed on that device.');
  }
}

async function sha256File(path, label) {
  try {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    throw new Error(`${label} could not be read.`);
  }
}

async function readBoundedJsonSnapshot(path, label, options = {}) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new Error(`${label} is missing or invalid.`);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_RECEIPT_BYTES) {
      throw new Error(`${label} is missing or invalid.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== details.size || bytes.length > MAX_RECEIPT_BYTES) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const text = bytes.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} is not a JSON object.`);
    }
    if (options.canonical === true && text !== `${JSON.stringify(parsed, null, 2)}\n`) {
      throw new Error(`${label} is not canonical JSON.`);
    }
    return {
      parsed,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(path, label, options) {
  return (await readBoundedJsonSnapshot(path, label, options)).parsed;
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function verifyDirectSubmissionRecovery({
  recovery,
  state,
  stateSha256,
  validation,
  promotion,
  args,
  runId,
  releaseCommit,
}) {
  const topKeys = [
    'schemaVersion',
    'kind',
    'runId',
    'preservedStateSha256',
    'sourceCommit',
    'releaseCommit',
    'applicationId',
    'versionName',
    'versionCode',
    'artifact',
    'directSubmission',
    'playReadback',
  ];
  const artifactKeys = ['filename', 'bytes', 'sha256'];
  const easKeys = [
    'cliVersion',
    'artifactSelection',
    'submissionId',
    'platform',
    'status',
    'error',
    'track',
    'releaseStatus',
    'createdAt',
    'completedAt',
  ];
  const playKeys = ['applicationId', 'track', 'releaseName', 'versionCode', 'status', 'observedAt'];
  const stateCompletedAt = canonicalTimestamp(state.submission?.completedAt);
  const easCreatedAt = canonicalTimestamp(recovery.directSubmission?.createdAt);
  const easCompletedAt = canonicalTimestamp(recovery.directSubmission?.completedAt);
  const playObservedAt = canonicalTimestamp(recovery.playReadback?.observedAt);
  const submissionId = recovery.directSubmission?.submissionId;
  const valid =
    hasExactKeys(recovery, topKeys) &&
    hasExactKeys(recovery.artifact, artifactKeys) &&
    hasExactKeys(recovery.directSubmission, easKeys) &&
    hasExactKeys(recovery.playReadback, playKeys) &&
    recovery.schemaVersion === 1 &&
    recovery.kind === 'direct-play-submission-recovery' &&
    recovery.runId === runId &&
    recovery.preservedStateSha256 === stateSha256 &&
    recovery.sourceCommit === args.expectedSourceCommit &&
    recovery.releaseCommit === releaseCommit &&
    recovery.applicationId === args.packageName &&
    recovery.versionName === args.expectedVersion &&
    recovery.versionCode === args.expectedCode &&
    AAB_NAME.test(recovery.artifact?.filename ?? '') &&
    recovery.artifact?.filename === promotion.artifactFilename &&
    recovery.artifact?.filename === state.artifact?.filename &&
    recovery.artifact?.bytes === state.artifact?.bytes &&
    recovery.artifact?.bytes === validation.artifact?.bytes &&
    Number.isSafeInteger(recovery.artifact?.bytes) &&
    recovery.artifact.bytes > 0 &&
    recovery.artifact?.sha256 === args.expectedAabSha256 &&
    typeof submissionId === 'string' &&
    UUID.test(submissionId) &&
    recovery.directSubmission?.cliVersion === '21.5.0' &&
    recovery.directSubmission?.artifactSelection === 'explicit-path' &&
    recovery.directSubmission?.platform === 'ANDROID' &&
    recovery.directSubmission?.status === 'FINISHED' &&
    recovery.directSubmission?.error === null &&
    recovery.directSubmission?.track === 'internal' &&
    recovery.directSubmission?.releaseStatus === 'COMPLETED' &&
    recovery.playReadback?.applicationId === args.packageName &&
    recovery.playReadback?.track === 'internal' &&
    recovery.playReadback?.releaseName === args.expectedVersion &&
    recovery.playReadback?.versionCode === args.expectedCode &&
    recovery.playReadback?.status === 'completed' &&
    stateCompletedAt !== null &&
    easCreatedAt !== null &&
    easCompletedAt !== null &&
    playObservedAt !== null &&
    stateCompletedAt < easCreatedAt &&
    easCreatedAt <= easCompletedAt &&
    easCompletedAt <= playObservedAt &&
    state.toolchain?.easCli === recovery.directSubmission?.cliVersion &&
    validation.artifact?.sha256 === recovery.artifact?.sha256;
  if (!valid) {
    throw new Error('The direct submission recovery receipt is missing or invalid.');
  }
  return submissionId;
}

export async function verifyCandidateReceipts(args) {
  const [validation, promotion, stateSnapshot, aabSha256, recovery] = await Promise.all([
    readBoundedJson(args.validationReceiptPath, 'validation receipt'),
    readBoundedJson(args.promotionReceiptPath, 'promotion receipt'),
    readBoundedJsonSnapshot(args.stateReceiptPath, 'release state receipt'),
    sha256File(args.aabPath, 'candidate AAB'),
    args.submissionRecoveryReceiptPath === null || args.submissionRecoveryReceiptPath === undefined
      ? Promise.resolve(null)
      : readBoundedJson(args.submissionRecoveryReceiptPath, 'submission recovery receipt', {
          canonical: true,
        }),
  ]);
  const state = stateSnapshot.parsed;
  const stateSha256 = stateSnapshot.sha256;
  const runId = validation.runId;
  const releaseCommit = promotion.commit;
  const uploadCertificateSha256 = normalizeCertificateSha256(
    validation.artifact?.uploadCertificateSha256 ?? '',
  );
  const promotedNotSubmitted =
    state.phase === 'promoted' &&
    hasExactKeys(state.submission, ['status']) &&
    state.submission.status === 'not_started';
  const cleanRunnerSubmission =
    state.phase === 'submitted' &&
    hasExactKeys(state.submission, [
      'schemaVersion',
      'runId',
      'status',
      'track',
      'artifactFilename',
      'sha256',
      'completedAt',
    ]) &&
    state.submission.schemaVersion === 1 &&
    state.submission.runId === runId &&
    state.submission.status === 'submitted' &&
    state.submission.track === 'internal' &&
    state.submission.artifactFilename === promotion.artifactFilename &&
    state.submission.sha256 === args.expectedAabSha256 &&
    canonicalTimestamp(state.submission.completedAt) !== null;
  const unknownRunnerSubmission =
    state.phase === 'submission_unknown' &&
    hasExactKeys(state.submission, [
      'schemaVersion',
      'runId',
      'status',
      'track',
      'exitCode',
      'signal',
      'processGroupId',
      'completedAt',
    ]) &&
    state.submission.schemaVersion === 1 &&
    state.submission.runId === runId &&
    state.submission?.status === 'unknown' &&
    state.submission?.track === 'internal' &&
    canonicalTimestamp(state.submission.completedAt) !== null;
  const valid =
    typeof runId === 'string' &&
    RUN_ID.test(runId) &&
    typeof releaseCommit === 'string' &&
    COMMIT.test(releaseCommit) &&
    SHA256.test(uploadCertificateSha256) &&
    validation.validation?.status === 'passed' &&
    validation.applicationId === args.packageName &&
    validation.versionName === args.expectedVersion &&
    validation.versionCode === args.expectedCode &&
    validation.sourceCommit === args.expectedSourceCommit &&
    validation.artifact?.sha256 === args.expectedAabSha256 &&
    promotion.runId === runId &&
    promotion.sourceCommit === args.expectedSourceCommit &&
    promotion.targetVersion === args.expectedVersion &&
    promotion.versionCode === args.expectedCode &&
    promotion.sha256 === args.expectedAabSha256 &&
    state.schemaVersion === 1 &&
    state.runId === runId &&
    state.source?.commit === args.expectedSourceCommit &&
    state.target?.version === args.expectedVersion &&
    state.target?.platform === 'android' &&
    state.promotion?.status === 'promoted' &&
    state.promotion?.commit === releaseCommit &&
    state.promotion?.artifactFilename === promotion.artifactFilename &&
    state.target?.track === 'internal' &&
    state.target?.applicationId === args.packageName &&
    state.artifact?.filename === promotion.artifactFilename &&
    state.artifact?.applicationId === args.packageName &&
    state.artifact?.versionName === args.expectedVersion &&
    state.artifact?.versionCode === args.expectedCode &&
    Number.isSafeInteger(state.artifact?.bytes) &&
    state.artifact.bytes > 0 &&
    state.artifact?.sha256 === args.expectedAabSha256 &&
    (promotedNotSubmitted || cleanRunnerSubmission || unknownRunnerSubmission) &&
    aabSha256 === args.expectedAabSha256;
  if (!valid) throw new Error('The frozen candidate receipts do not match the expected candidate.');
  if ((promotedNotSubmitted || cleanRunnerSubmission) && recovery !== null) {
    throw new Error('A clean runner submission must not have a recovery receipt.');
  }
  if (unknownRunnerSubmission && recovery === null) {
    throw new Error('The unknown runner submission requires a recovery receipt.');
  }
  const recoverySubmissionId =
    recovery === null
      ? null
      : verifyDirectSubmissionRecovery({
          recovery,
          state,
          stateSha256,
          validation,
          promotion,
          args,
          runId,
          releaseCommit,
        });
  return {
    runId,
    sourceCommit: args.expectedSourceCommit,
    releaseCommit,
    aabSha256,
    uploadCertificateSha256,
    phase: state.phase,
    submissionEvidence:
      recovery !== null ? 'direct_recovery' : cleanRunnerSubmission ? 'runner' : 'not_started',
    ...(recoverySubmissionId === null ? {} : { recoverySubmissionId }),
  };
}

function parsePmPaths(output) {
  const paths = exactLines(output).map((line) => {
    if (!line.startsWith('package:')) throw new Error('The installed split list is malformed.');
    const remotePath = line.slice('package:'.length);
    const filename = basename(remotePath);
    if (
      !remotePath.startsWith('/data/app/') ||
      /[\0\r\n]/u.test(remotePath) ||
      !APK_NAME.test(filename)
    ) {
      throw new Error('The installed split list contains an unsafe path.');
    }
    return { remotePath, filename };
  });
  if (
    paths.length === 0 ||
    !paths.some((entry) => entry.filename === 'base.apk') ||
    new Set(paths.map((entry) => entry.filename)).size !== paths.length
  ) {
    throw new Error('The installed split set is incomplete or ambiguous.');
  }
  return paths;
}

function normalizeCertificateSha256(value) {
  return typeof value === 'string' ? value.replaceAll(':', '').toLowerCase() : '';
}

async function inspectApk(apksignerPath, path) {
  const output = await runFile(
    apksignerPath,
    ['verify', '--verbose', '--print-certs', path],
    'APK signature verification',
    60_000,
  );
  const digests = [
    ...output.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]{64,95})/giu),
  ].map((match) => normalizeCertificateSha256(match[1]));
  if (digests.length !== 1 || !SHA256.test(digests[0])) {
    throw new Error('The installed APK must have exactly one readable signing certificate.');
  }
  return {
    sha256: await sha256File(path, 'pulled APK'),
    certificateSha256: digests[0],
  };
}

async function inspectInstalledSplits(args) {
  const beforeOutput = await adb(args.serial, ['shell', 'pm', 'path', args.packageName]);
  const before = parsePmPaths(beforeOutput);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gator-dl01-splits-'));
  try {
    await chmod(temporaryDirectory, 0o700);
    const inspected = [];
    for (const entry of before) {
      const localPath = join(temporaryDirectory, entry.filename);
      await adb(args.serial, ['pull', entry.remotePath, localPath], 120_000);
      inspected.push({
        filename: entry.filename,
        ...(await inspectApk(args.apksignerPath, localPath)),
      });
    }
    const afterOutput = await adb(args.serial, ['shell', 'pm', 'path', args.packageName]);
    if (afterOutput.trim() !== beforeOutput.trim()) {
      throw new Error('The installed split set changed during inspection.');
    }
    inspected.sort((left, right) => left.filename.localeCompare(right.filename, 'en'));
    const certificates = new Set(inspected.map((entry) => entry.certificateSha256));
    if (certificates.size !== 1 || !certificates.has(args.expectedPlayCertificateSha256)) {
      throw new Error(
        'The installed split signing identity does not match the expected Play signer.',
      );
    }
    return { splits: inspected, packagePaths: beforeOutput.trim() };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function collectCandidateEvidence(args) {
  const receipt = await verifyCandidateReceipts(args);
  await verifyReadyDevice(args.serial);
  const [apiText, qemuText, abiText, packageDump] = await Promise.all([
    adb(args.serial, ['shell', 'getprop', 'ro.build.version.sdk']),
    adb(args.serial, ['shell', 'getprop', 'ro.kernel.qemu']),
    adb(args.serial, ['shell', 'getprop', 'ro.product.cpu.abilist']),
    adb(args.serial, ['shell', 'dumpsys', 'package', args.packageName]),
  ]);
  const api = Number(apiText.trim());
  const qemuValue = qemuText.trim();
  if (qemuValue !== '0' && qemuValue !== '1') {
    throw new Error('The Android emulator identity property is unavailable or invalid.');
  }
  const qemu = qemuValue === '1';
  const abi = abiText.trim();
  const installed = parseInstalledPackageDump(packageDump, args.packageName);
  const identityMatches =
    api === args.expectedApi &&
    qemu === args.requireQemu &&
    abi.split(',').includes('arm64-v8a') &&
    installed.versionName === args.expectedVersion &&
    installed.versionCode === args.expectedCode &&
    installed.minSdk === args.expectedMinSdk &&
    installed.targetSdk === args.expectedTargetSdk &&
    installed.installerPackageName === args.expectedInstaller;
  if (!identityMatches) {
    throw new Error(
      'The installed candidate or Android runtime does not match the expected identity.',
    );
  }
  const splitEvidence = await inspectInstalledSplits(args);
  const [finalPackageDump, finalPackagePaths] = await Promise.all([
    adb(args.serial, ['shell', 'dumpsys', 'package', args.packageName]),
    adb(args.serial, ['shell', 'pm', 'path', args.packageName]),
  ]);
  const finalInstalled = parseInstalledPackageDump(finalPackageDump, args.packageName);
  if (
    JSON.stringify(finalInstalled) !== JSON.stringify(installed) ||
    finalPackagePaths.trim() !== splitEvidence.packagePaths
  ) {
    throw new Error('The installed candidate changed during exact split inspection.');
  }
  return {
    schemaVersion: 1,
    candidate: {
      ...receipt,
      applicationId: args.packageName,
      versionName: args.expectedVersion,
      versionCode: args.expectedCode,
      minSdk: installed.minSdk,
      targetSdk: installed.targetSdk,
    },
    device: {
      serialSha256: createHash('sha256').update(args.serial, 'utf8').digest('hex'),
      api,
      qemu,
      abi,
      installerPackageName: installed.installerPackageName,
      playCertificateSha256: args.expectedPlayCertificateSha256,
      splits: splitEvidence.splits,
    },
  };
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function diagnosticValueIsAllowed(label, value) {
  if (label === 'App version') return VERSION_NAME.test(value);
  if (label === 'Schema head') {
    return value === 'Unavailable' || /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(value);
  }
  if (BOOLEAN_DIAGNOSTIC_LABELS.has(label)) return /^(?:Yes|No|Unavailable)$/u.test(value);
  if (STATUS_DIAGNOSTIC_LABELS.has(label)) return /^(?:Verified|Rejected)$/u.test(value);
  if (BYTES_DIAGNOSTIC_LABELS.has(label)) return BYTES_VALUE.test(value);
  if (COUNT_PAIR_DIAGNOSTIC_LABELS.has(label)) {
    const parts = value.split(' / ');
    return parts.length === 2 && parts.every((part) => COUNT_VALUE.test(part));
  }
  if (COUNT_BYTES_PAIR_DIAGNOSTIC_LABELS.has(label)) {
    const separator = value.indexOf(' / ');
    return (
      separator > 0 &&
      COUNT_VALUE.test(value.slice(0, separator)) &&
      BYTES_VALUE.test(value.slice(separator + 3))
    );
  }
  return COUNT_VALUE.test(value);
}

function xmlTextNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>/gu)) {
    const attributes = match[1];
    const rawText = /\btext="([^"]*)"/u.exec(attributes)?.[1];
    const bounds = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(attributes);
    if (rawText === undefined || !bounds) continue;
    const text = decodeXmlAttribute(rawText).trim();
    if (text.length === 0) continue;
    const rectangle = bounds.slice(1).map(Number);
    if (
      rectangle.some((coordinate) => !Number.isSafeInteger(coordinate) || coordinate < 0) ||
      rectangle[2] <= rectangle[0] ||
      rectangle[3] <= rectangle[1]
    ) {
      continue;
    }
    nodes.push({ text, bounds: rectangle });
  }
  return nodes;
}

function sameDiagnosticRow(labelNode, valueNode) {
  const [labelLeft, labelTop, labelRight, labelBottom] = labelNode.bounds;
  const [valueLeft, valueTop, valueRight, valueBottom] = valueNode.bounds;
  const verticalOverlap = Math.min(labelBottom, valueBottom) - Math.max(labelTop, valueTop);
  return verticalOverlap > 0 && valueLeft >= labelLeft && valueRight > labelRight;
}

/** Extract one visible, allowlisted aggregate snapshot while carrying a scrolled section forward. */
export function parseDownloadIntegrityUiSnapshot(xml, initialSection = null) {
  if (typeof xml !== 'string' || xml.length === 0 || xml.length > MAX_UI_XML_BYTES) {
    throw new Error('The Android UI hierarchy is missing or too large.');
  }
  if (initialSection !== null && !DIAGNOSTIC_SECTION_SET.has(initialSection)) {
    throw new Error('The prior Download Integrity section is invalid.');
  }
  const nodes = xmlTextNodes(xml);
  if (!nodes.some((node) => node.text === 'Download Integrity')) {
    throw new Error('The Download Integrity screen is not visible.');
  }
  const rows = {};
  let section = initialSection;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const node = nodes[index];
    const text = node.text;
    if (DIAGNOSTIC_SECTION_SET.has(text)) {
      section = text;
      continue;
    }
    if (section === null || !DIAGNOSTIC_ROW_SET.has(`${section}\0${text}`)) continue;
    const label = `${section} / ${text}`;
    const valueNode = nodes[index + 1];
    const value = valueNode.text;
    if (
      DIAGNOSTIC_SECTION_SET.has(value) ||
      DIAGNOSTIC_ROW_SET.has(`${section}\0${value}`) ||
      !sameDiagnosticRow(node, valueNode) ||
      !diagnosticValueIsAllowed(text, value)
    ) {
      throw new Error(`The visible diagnostic row ${label} has no value.`);
    }
    if (Object.hasOwn(rows, label) && rows[label] !== value) {
      throw new Error(`The visible diagnostic row ${label} is ambiguous.`);
    }
    rows[label] = value;
  }
  return { rows, section };
}

/** Extract only allowlisted rows for callers that do not need scroll-section continuity. */
export function parseDownloadIntegrityUiXml(xml) {
  return parseDownloadIntegrityUiSnapshot(xml).rows;
}

function mergeDiagnostics(target, next) {
  for (const [label, value] of Object.entries(next)) {
    if (Object.hasOwn(target, label) && target[label] !== value) {
      throw new Error(`The diagnostic row ${label} changed during capture.`);
    }
    target[label] = value;
  }
}

async function dumpUiHierarchy(serial) {
  const remotePath = `/data/local/tmp/gator-dl01-ui-${randomBytes(8).toString('hex')}.xml`;
  try {
    await adb(serial, ['shell', 'uiautomator', 'dump', '--compressed', remotePath], 30_000);
    return await adb(serial, ['exec-out', 'cat', remotePath], 30_000, MAX_UI_XML_BYTES);
  } finally {
    await adb(serial, ['shell', 'rm', '-f', remotePath]);
  }
}

async function screenSize(serial) {
  const output = await adb(serial, ['shell', 'wm', 'size']);
  const last = [...output.matchAll(/(\d+)x(\d+)/gu)].at(-1);
  if (!last) throw new Error('The Android display size could not be read.');
  const width = Number(last[1]);
  const height = Number(last[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 320 ||
    height < 480
  ) {
    throw new Error('The Android display size is invalid.');
  }
  return { width, height };
}

async function collectVisibleDiagnostics(args) {
  const identity = await collectCandidateEvidence(args);
  const size = await screenSize(args.serial);
  const rows = {};
  let section = null;
  for (let index = 0; index <= args.scrolls; index += 1) {
    const snapshot = parseDownloadIntegrityUiSnapshot(await dumpUiHierarchy(args.serial), section);
    mergeDiagnostics(rows, snapshot.rows);
    section = snapshot.section;
    if (index === args.scrolls) break;
    await adb(args.serial, [
      'shell',
      'input',
      'swipe',
      String(Math.round(size.width * 0.5)),
      String(Math.round(size.height * 0.78)),
      String(Math.round(size.width * 0.5)),
      String(Math.round(size.height * 0.28)),
      '350',
    ]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
  }
  const missingRows = EXPECTED_DIAGNOSTIC_KEYS.filter((key) => !Object.hasOwn(rows, key));
  if (missingRows.length > 0) {
    throw new Error(
      `The Download Integrity capture is incomplete (${missingRows.length} aggregate rows missing).`,
    );
  }
  if (
    rows['EXACT CANDIDATE / App version'] !== args.expectedVersion ||
    rows['EXACT CANDIDATE / App build'] !== String(args.expectedCode) ||
    rows['EXACT CANDIDATE / Android API'] !== String(args.expectedApi)
  ) {
    throw new Error('The Download Integrity screen does not match the exact candidate runtime.');
  }
  return { ...identity, diagnostics: rows };
}

async function serveFixture(argv) {
  const args = parseDl01DeviceFixtureArgs(argv);
  const token = process.env[DL01_FIXTURE_TOKEN_ENV];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${DL01_FIXTURE_TOKEN_ENV} is required and is never printed.`);
  }
  await verifyExactDevice(args.serial, args.packageName);
  const remote = `tcp:${args.base.port}`;
  const local = `tcp:${args.base.port}`;
  const mappings = reverseMappings(await adb(args.serial, ['reverse', '--list']));
  if (mappings.some((mapping) => mapping.remote === remote)) {
    throw new Error(
      `The exact device port ${args.base.port} already has an adb reverse mapping; refusing to replace it.`,
    );
  }
  const fixture = await startDl01FixtureServer({
    authToken: token,
    host: '127.0.0.1',
    port: args.base.port,
    firebaseProjectId: args.firebaseProjectId,
    rcsPermissions: args.rcsPermissions,
  });
  let reverseAdded = false;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (reverseAdded) {
      try {
        const current = reverseMappings(await adb(args.serial, ['reverse', '--list']));
        if (current.some((mapping) => mapping.remote === remote && mapping.local === local)) {
          await adb(args.serial, ['reverse', '--remove', remote]);
        } else if (current.some((mapping) => mapping.remote === remote)) {
          process.stderr.write(
            'Warning: the DL-01 adb reverse mapping changed ownership and was not removed.\n',
          );
        }
      } catch {
        process.stderr.write(
          'Warning: the exact DL-01 adb reverse mapping could not be removed.\n',
        );
      }
    }
    await fixture.close();
  };
  try {
    await adb(args.serial, ['reverse', '--no-rebind', remote, local]);
    reverseAdded = true;
    process.stdout.write(`DL-01 device fixture is ready at ${args.base.origin}\n`);
    process.stdout.write('The exact device and installed package were verified.\n');
    process.stdout.write(
      'No app install, uninstall, launch, stop, or process kill was performed.\n',
    );
    process.stdout.write('The bearer credential and any FCM registration remain memory-only.\n');
    process.stdout.write(`Host status endpoint: ${fixture.origin}/_dl01/v1/status\n`);
    await new Promise((resolvePromise) => {
      process.once('SIGINT', resolvePromise);
      process.once('SIGTERM', resolvePromise);
    });
  } finally {
    await cleanup();
  }
}

function usage() {
  return `Usage:
  node scripts/run-dl01-device-fixture.mjs serve --serial SERIAL --package PACKAGE --base-url http://127.0.0.1:PORT [--firebase-project-id ID] [--rcs-permissions yes]
  node scripts/run-dl01-device-fixture.mjs verify-candidate <candidate options>
  node scripts/run-dl01-device-fixture.mjs capture-diagnostics <candidate options> [--scrolls 0..12]

Candidate options require independent expected version/code/SDK/API/source/AAB/signer values plus
the AAB, validation.json, promotion.json, state.json, and apksigner paths. A fail-closed direct-submit
recovery receipt is optional for an honestly preserved submission_unknown runner state. Output is
sanitized JSON.
Legacy invocation without the serve word remains supported.
`;
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && ['help', '--help', '-h'].includes(raw[0])) {
    process.stdout.write(usage());
    return;
  }
  const command = raw[0]?.startsWith('--') ? 'serve' : (raw.shift() ?? 'help');
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'serve') {
    await serveFixture(raw);
    return;
  }
  if (command === 'verify-candidate') {
    process.stdout.write(
      `${JSON.stringify(await collectCandidateEvidence(parseDl01CandidateArgs(raw)), null, 2)}\n`,
    );
    return;
  }
  if (command === 'capture-diagnostics') {
    process.stdout.write(
      `${JSON.stringify(
        await collectVisibleDiagnostics(parseDl01CandidateArgs(raw, { diagnostics: true })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  throw new Error(`Unknown DL-01 device-fixture command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'DL-01 device fixture failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
