#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_PACKAGE = 'com.bluegreengatorapps.messages';
export const APP_ACTIVITY = `${APP_PACKAGE}/.MainActivity`;
export const CONTRACT_MARKER_PREFIX = 'GATOR_DB_CONTRACT_V3 ';
export const CONTRACT_SUITE = 'android-db-contract';
export const CONTRACT_SCHEMA = 3;
export const CONTRACT_MIGRATION_COUNT = 39;
export const CONTRACT_MIGRATION_HEAD = '0039_message_error_message';
const LEGACY_CONTRACT_MARKER_PREFIXES = Object.freeze([
  'GATOR_DB_CONTRACT_V1 ',
  'GATOR_DB_CONTRACT_V2 ',
]);

// Keep this exact and finite. A new or missing check must make the host lane fail closed instead of
// silently accepting a partial device contract.
export const CONTRACT_CHECKS = Object.freeze([
  'encryptedOpen',
  'wrongKeyRejected',
  'migrationRollback',
  'migrationRetry',
  'migrationLedger',
  'migrationData',
  'fts5',
  'integrity',
  'idempotent',
  'rollback',
  'syncReactive',
  'asyncReactive',
  'rawReactive',
  'rekey',
  'newKeyReopen',
  'oldKeyRejected',
  'historicalProvenance',
  'historical0024',
  'historical0027',
  'historical0029',
  'historicalReadOnly',
  'historicalWrongKeyRejected',
  'historicalData',
  'historicalFts5',
  'historicalIntegrity',
  'historicalIdempotent',
  'historicalCleanup',
  'cleanup',
]);
export const CONTRACT_FAILURE_CODES = Object.freeze([
  'key-generation',
  'pre-cleanup',
  'encrypted-open',
  'migration-rollback',
  'wrong-key-not-rejected',
  'correct-key-reopen',
  'migration-retry',
  'migration-ledger',
  'migration-data',
  'fts5',
  'integrity',
  'idempotent',
  'rollback',
  'sync-reactive',
  'async-reactive',
  'raw-reactive',
  'rekey',
  'new-key-reopen',
  'old-key-not-rejected',
  'historical-provenance',
  'historical-pre-cleanup',
  'historical-0024-fixture',
  'historical-0024-read-only',
  'historical-0024-wrong-key-not-rejected',
  'historical-0024-migration',
  'historical-0024-data',
  'historical-0024-fts5',
  'historical-0024-integrity',
  'historical-0024-idempotent',
  'historical-0027-fixture',
  'historical-0027-read-only',
  'historical-0027-wrong-key-not-rejected',
  'historical-0027-migration',
  'historical-0027-data',
  'historical-0027-fts5',
  'historical-0027-integrity',
  'historical-0027-idempotent',
  'historical-cleanup',
  'cleanup',
  'internal',
]);

const DEV_CLIENT_URL =
  'exp+bluegreengatorappsmessages://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';
const METRO_STATUS_URL = 'http://127.0.0.1:8081/status';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = resolve(ROOT, 'android/app/build/reports/db-contract');
const COMMAND_TIMEOUT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 120_000;
const RESULT_POLL_MS = 250;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MARKER_JSON_CHARS = 4_096;
const LOGCAT_BOUNDARY_PREFIX = 'GATOR_DB_CONTRACT_BOUNDARY_';

export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}

function compactToolOutput(value, serial) {
  let safe = String(value ?? '');
  if (serial) safe = safe.replaceAll(serial, '[device]');
  safe = safe.replace(/\/(?:Users|home)\/[^\s:]+/g, '[local-path]');
  safe = safe.replace(/\s+/g, ' ').trim();
  return safe.slice(0, 300);
}

function runCommand(command, args, options = {}) {
  const {
    code = 'command-failed',
    label = command,
    serial,
    timeoutMs = COMMAND_TIMEOUT_MS,
  } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: timeoutMs,
  });

  if (result.error) {
    const detail = compactToolOutput(result.error.message, serial);
    throw new HarnessError(code, `${label} failed${detail ? `: ${detail}` : ''}`);
  }
  if (result.status !== 0) {
    const detail = compactToolOutput(result.stderr || result.stdout, serial);
    throw new HarnessError(
      code,
      `${label} failed with exit ${String(result.status)}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function adbArgs(serial, ...args) {
  return ['-s', serial, ...args];
}

function runAdb(serial, args, options = {}) {
  return runCommand('adb', adbArgs(serial, ...args), { ...options, serial });
}

/** Parse only the serial/state columns from `adb devices`; extended device metadata is not used. */
export function parseAdbDevices(output) {
  const devices = [];
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'List of devices attached' || line.startsWith('* daemon')) continue;
    const match = /^(\S+)\s+(\S+)/.exec(line);
    if (match) devices.push({ serial: match[1], state: match[2] });
  }
  return devices;
}

export function selectAdbDevice(devices, requestedSerial) {
  if (requestedSerial) {
    const selected = devices.find((device) => device.serial === requestedSerial);
    if (!selected) {
      throw new HarnessError('requested-device-missing', 'ANDROID_SERIAL is not attached.');
    }
    if (selected.state !== 'device') {
      throw new HarnessError(
        'requested-device-unavailable',
        `ANDROID_SERIAL is ${selected.state}, not ready.`,
      );
    }
    return selected.serial;
  }

  const ready = devices.filter((device) => device.state === 'device');
  if (ready.length === 0) {
    throw new HarnessError('no-ready-device', 'No authorized, online Android device is attached.');
  }
  if (ready.length > 1) {
    throw new HarnessError(
      'multiple-ready-devices',
      'Multiple Android devices are ready; set ANDROID_SERIAL to choose one.',
    );
  }
  return ready[0].serial;
}

/** Rebuild only non-identifying candidate metadata from otherwise verbose Android commands. */
export function parseTargetMetadata({ packageDump, androidApi, abi }) {
  const versionName = /^\s*versionName=([0-9A-Za-z.+_-]{1,64})\s*$/m.exec(packageDump)?.[1];
  const versionCodeText = /^\s*versionCode=(\d+)\b/m.exec(packageDump)?.[1];
  const versionCode = versionCodeText === undefined ? Number.NaN : Number(versionCodeText);
  const api = Number(String(androidApi).trim());
  const normalizedAbi = String(abi).trim();
  if (
    versionName === undefined ||
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    !Number.isSafeInteger(api) ||
    api < 1 ||
    api > 999 ||
    !/^[0-9A-Za-z._-]{1,32}$/.test(normalizedAbi)
  ) {
    throw new HarnessError(
      'invalid-target-metadata',
      'Installed version, Android API, or ABI could not be read safely.',
    );
  }
  return { versionName, versionCode, androidApi: api, abi: normalizedAbi };
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError('invalid-contract-marker', `${label} must be an object.`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new HarnessError(
      'invalid-contract-marker',
      `${label} fields do not match the finite contract.`,
    );
  }
}

/** Validate and rebuild the marker so unreviewed fields can never reach the retained artifact. */
export function validateContractResult(value) {
  assertPlainObject(value, 'Result');
  if (value.schema !== CONTRACT_SCHEMA) {
    throw new HarnessError('invalid-contract-marker', 'Result schema must be 3.');
  }
  if (value.suite !== CONTRACT_SUITE) {
    throw new HarnessError('invalid-contract-marker', 'Result suite is not android-db-contract.');
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new HarnessError('invalid-contract-marker', 'Result status must be pass or fail.');
  }
  assertExactKeys(
    value,
    value.status === 'pass'
      ? ['schema', 'suite', 'status', 'migrationCount', 'migrationHead', 'checks']
      : ['schema', 'suite', 'status', 'migrationCount', 'migrationHead', 'checks', 'failureCode'],
    'Result',
  );
  if (
    value.migrationCount !== CONTRACT_MIGRATION_COUNT ||
    value.migrationHead !== CONTRACT_MIGRATION_HEAD
  ) {
    throw new HarnessError(
      'invalid-contract-marker',
      'Result migration count or head does not match the reviewed contract.',
    );
  }

  assertPlainObject(value.checks, 'Result checks');
  assertExactKeys(value.checks, CONTRACT_CHECKS, 'Result checks');
  const checks = {};
  for (const check of CONTRACT_CHECKS) {
    const checkValue = value.checks[check];
    if (typeof checkValue !== 'boolean') {
      throw new HarnessError('invalid-contract-marker', `Result check ${check} must be boolean.`);
    }
    checks[check] = checkValue;
  }

  const allPassed = Object.values(checks).every(Boolean);
  if ((value.status === 'pass') !== allPassed) {
    throw new HarnessError(
      'inconsistent-contract-marker',
      'Result status does not agree with its check booleans.',
    );
  }
  if (value.status === 'fail') {
    if (!CONTRACT_FAILURE_CODES.includes(value.failureCode)) {
      throw new HarnessError(
        'invalid-contract-marker',
        'Result failureCode is not part of the finite contract.',
      );
    }
    return {
      schema: CONTRACT_SCHEMA,
      suite: CONTRACT_SUITE,
      status: 'fail',
      migrationCount: CONTRACT_MIGRATION_COUNT,
      migrationHead: CONTRACT_MIGRATION_HEAD,
      checks,
      failureCode: value.failureCode,
    };
  }
  return {
    schema: CONTRACT_SCHEMA,
    suite: CONTRACT_SUITE,
    status: 'pass',
    migrationCount: CONTRACT_MIGRATION_COUNT,
    migrationHead: CONTRACT_MIGRATION_HEAD,
    checks,
  };
}

/** Extract exactly one marker from a bounded logcat snapshot. */
export function extractContractResult(logText) {
  const payloads = [];
  for (const line of String(logText).split(/\r?\n/)) {
    if (LEGACY_CONTRACT_MARKER_PREFIXES.some((prefix) => line.includes(prefix))) {
      throw new HarnessError(
        'stale-contract-marker',
        'A stale V1/V2 DB contract marker was emitted by the current app launch.',
      );
    }
    const markerIndex = line.indexOf(CONTRACT_MARKER_PREFIX);
    if (markerIndex < 0) continue;
    const payload = line.slice(markerIndex + CONTRACT_MARKER_PREFIX.length).trim();
    if (!payload || payload.length > MAX_MARKER_JSON_CHARS) {
      throw new HarnessError(
        'invalid-contract-marker',
        'Contract marker payload is empty or too large.',
      );
    }
    payloads.push(payload);
  }

  if (payloads.length === 0) return undefined;
  if (payloads.length !== 1) {
    throw new HarnessError(
      'duplicate-contract-marker',
      'More than one contract marker was emitted.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(payloads[0]);
  } catch {
    throw new HarnessError('invalid-contract-marker', 'Contract marker is not valid JSON.');
  }
  return validateContractResult(parsed);
}

/** Keep only logs written after this launch's non-destructive logcat boundary. */
export function logsAfterBoundary(logText, boundary) {
  if (!boundary.startsWith(LOGCAT_BOUNDARY_PREFIX)) {
    throw new HarnessError('invalid-log-boundary', 'The DB contract log boundary is invalid.');
  }
  const lines = String(logText).split(/\r?\n/);
  const indexes = lines.flatMap((line, index) => (line.trim() === boundary ? [index] : []));
  if (indexes.length !== 1) {
    throw new HarnessError(
      'log-boundary-missing',
      'The current DB contract log boundary is missing or duplicated.',
    );
  }
  return lines.slice(indexes[0] + 1).join('\n');
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Polling is dependency-injected so host tests never need adb or an Android device. */
export async function waitForContractResult(options) {
  const {
    readLogs,
    isProcessAlive,
    timeoutMs = RESULT_TIMEOUT_MS,
    pollMs = RESULT_POLL_MS,
    now = Date.now,
    sleep = delay,
  } = options;
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const result = extractContractResult(await readLogs());
    if (result) return result;
    if (!(await isProcessAlive())) {
      throw new HarnessError(
        'app-process-exited',
        'The Gator process exited before emitting its DB contract result.',
      );
    }
    await sleep(pollMs);
  }
  throw new HarnessError(
    'contract-result-timeout',
    `No DB contract marker arrived within ${String(timeoutMs)} ms.`,
  );
}

export function buildPrivacySafeArtifact(result, target, recordedAt = new Date()) {
  const validated = validateContractResult(result);
  const safeTarget = parseTargetMetadata({
    packageDump: `versionCode=${String(target.versionCode)}\nversionName=${target.versionName}`,
    androidApi: target.androidApi,
    abi: target.abi,
  });
  return {
    schema: CONTRACT_SCHEMA,
    suite: CONTRACT_SUITE,
    recordedAt: recordedAt.toISOString(),
    package: APP_PACKAGE,
    target: safeTarget,
    status: validated.status,
    migrationCount: validated.migrationCount,
    migrationHead: validated.migrationHead,
    checks: validated.checks,
    ...(validated.status === 'fail' ? { failureCode: validated.failureCode } : {}),
  };
}

function reportPath(recordedAt) {
  const stamp = recordedAt.toISOString().replace(/[:.]/g, '-');
  return resolve(REPORT_DIR, `android-db-contract-${stamp}.json`);
}

function writeArtifact(result, target, recordedAt = new Date()) {
  const artifact = buildPrivacySafeArtifact(result, target, recordedAt);
  const path = reportPath(recordedAt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path;
}

function checkMetro(timeoutMs = 3_000) {
  return new Promise((resolveCheck, rejectCheck) => {
    const request = get(METRO_STATUS_URL, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => {
        body = `${body}${chunk}`.slice(0, 256);
      });
      response.on('end', () => {
        if (response.statusCode === 200 && body.trim() === 'packager-status:running') {
          resolveCheck();
          return;
        }
        rejectCheck(
          new HarnessError(
            'metro-unavailable',
            'Metro did not return packager-status:running on 127.0.0.1:8081.',
          ),
        );
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new HarnessError('metro-unavailable', 'Metro did not respond on 127.0.0.1:8081.'),
      );
    });
    request.on('error', (error) => {
      rejectCheck(
        error instanceof HarnessError
          ? error
          : new HarnessError(
              'metro-unavailable',
              'Metro is not running on 127.0.0.1:8081; start it with npm start -- --dev-client.',
            ),
      );
    });
  });
}

function currentPid(serial) {
  try {
    const output = runAdb(serial, ['shell', 'pidof', '-s', APP_PACKAGE], {
      code: 'app-process-missing',
      label: 'Gator process lookup',
    });
    return /^\d+$/.test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

async function waitForPid(serial, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const pid = currentPid(serial);
    if (pid) return pid;
    await delay(100);
  }
  throw new HarnessError(
    'app-process-missing',
    'Gator did not create an app process after launch.',
  );
}

export async function runAndroidDbContract() {
  runCommand('adb', ['version'], { code: 'adb-unavailable', label: 'adb' });
  const deviceOutput = runCommand('adb', ['devices'], {
    code: 'adb-devices-failed',
    label: 'adb devices',
  });
  const serial = selectAdbDevice(parseAdbDevices(deviceOutput), process.env.ANDROID_SERIAL);

  const installedPath = runAdb(serial, ['shell', 'pm', 'path', APP_PACKAGE], {
    code: 'app-not-installed',
    label: 'Installed Gator package check',
  });
  if (!installedPath.startsWith('package:')) {
    throw new HarnessError('app-not-installed', 'The Gator Android package is not installed.');
  }
  const target = parseTargetMetadata({
    packageDump: runAdb(serial, ['shell', 'dumpsys', 'package', APP_PACKAGE], {
      code: 'target-metadata-unavailable',
      label: 'Installed Gator version check',
    }),
    androidApi: runAdb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], {
      code: 'target-metadata-unavailable',
      label: 'Android API check',
    }),
    abi: runAdb(serial, ['shell', 'getprop', 'ro.product.cpu.abi'], {
      code: 'target-metadata-unavailable',
      label: 'Android ABI check',
    }),
  });
  runAdb(serial, ['shell', 'run-as', APP_PACKAGE, 'true'], {
    code: 'app-not-debuggable',
    label: 'Debuggable Gator package check',
  });
  await checkMetro();
  runAdb(serial, ['reverse', 'tcp:8081', 'tcp:8081'], {
    code: 'adb-reverse-failed',
    label: 'adb reverse for Metro',
  });

  // This lane is an explicit foreground launch, not a killed-process push test. Force-stop gives
  // the DEV one-shot boot self-test a fresh JS process; the following VIEW launch immediately
  // removes Android's stopped state.
  runAdb(serial, ['shell', 'am', 'force-stop', APP_PACKAGE], {
    code: 'app-stop-failed',
    label: 'Gator cold-stop',
  });
  const logBoundary = `${LOGCAT_BOUNDARY_PREFIX}${randomUUID()}`;
  runAdb(serial, ['shell', 'log', '-p', 'i', '-t', 'GatorDbHarness', logBoundary], {
    code: 'log-boundary-failed',
    label: 'DB contract log boundary',
  });
  runAdb(
    serial,
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      DEV_CLIENT_URL,
      '-n',
      APP_ACTIVITY,
    ],
    { code: 'app-launch-failed', label: 'Gator DEV launch', timeoutMs: LAUNCH_TIMEOUT_MS },
  );

  const pid = await waitForPid(serial);
  const result = await waitForContractResult({
    readLogs: () =>
      logsAfterBoundary(
        runAdb(
          serial,
          ['logcat', '-d', '-v', 'raw', 'GatorDbHarness:I', 'ReactNativeJS:I', '*:S'],
          {
            code: 'logcat-read-failed',
            label: 'filtered Gator logcat',
          },
        ),
        logBoundary,
      ),
    isProcessAlive: () => currentPid(serial) === pid,
  });

  const path = writeArtifact(result, target);
  if (result.status !== 'pass') {
    const failedChecks = CONTRACT_CHECKS.filter((check) => !result.checks[check]);
    throw new HarnessError(
      'contract-failed',
      `Android DB contract failed: ${failedChecks.join(', ')}. Safe artifact: ${path}`,
    );
  }
  return { path, result };
}

export async function main() {
  const { path } = await runAndroidDbContract();
  process.stdout.write(`Android DB contract PASS\nSafe artifact: ${path}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof HarnessError ? error.code : 'unexpected-harness-error';
    const message = error instanceof Error ? error.message : 'Unknown harness failure.';
    process.stderr.write(`Android DB contract harness failed [${code}]: ${message}\n`);
    process.exitCode = 1;
  });
}
