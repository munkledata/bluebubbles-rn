#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKFLOW = '.github/workflows/ci.yml';
const DEFAULT_DEPENDABOT = '.github/dependabot.yml';
const DEFAULT_ANDROID_DB_RUNNER = 'scripts/run-android-db-ci.sh';
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/i;
const READABLE_VERSION = /^v\d+\.\d+\.\d+(?:\s|$)/;
const TOOLCHAIN_POLICY_TEST_NAME = 'Test toolchain policy';
const TOOLCHAIN_POLICY_TEST_COMMAND =
  'node --test scripts/check-toolchain.test.mjs scripts/release-android.test.mjs';
const TOOLCHAIN_GUARD_NAME = 'Verify toolchain pins';
const TOOLCHAIN_GUARD_COMMAND = 'node scripts/check-toolchain.mjs';
const INSTALL_NAME = 'Install dependencies';
const INSTALL_COMMAND = 'npm ci';
const SCHEDULED_DB_CRON = "- cron: '17 7 * * 2'";
const SCHEDULED_DB_CONDITION =
  "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
const SCHEDULED_DB_APK_ARTIFACT = 'scheduled-android-db-debug-apk';
const SCHEDULED_DB_REPORT_ARTIFACT = 'scheduled-android-db-reports';
const SCHEDULED_DB_RUNNER_LINES = [
  'set -euo pipefail',
  "readonly APP_PACKAGE='com.bluegreengatorapps.messages'",
  "readonly APK_PATH='android/app/build/outputs/apk/debug/app-debug.apk'",
  ': "${ANDROID_SERIAL:?ANDROID_SERIAL must identify the CI emulator.}"',
  ': "${RUNNER_TEMP:?RUNNER_TEMP must be set by GitHub Actions.}"',
  'readonly METRO_LOG="$RUNNER_TEMP/gator-metro.log"',
  "metro_pid=''",
  'cleanup() {',
  'adb -s "$ANDROID_SERIAL" shell am force-stop "$APP_PACKAGE" >/dev/null 2>&1 || :',
  'adb -s "$ANDROID_SERIAL" reverse --remove tcp:8081 >/dev/null 2>&1 || :',
  'if [[ -n "$metro_pid" ]]; then',
  'kill "$metro_pid" >/dev/null 2>&1 || :',
  'wait "$metro_pid" 2>/dev/null || :',
  'fi',
  '}',
  'show_metro_failure() {',
  "echo '::group::Last 80 lines from Metro startup'",
  'tail -n 80 "$METRO_LOG" 2>/dev/null || :',
  "echo '::endgroup::'",
  '}',
  'trap cleanup EXIT',
  'adb -s "$ANDROID_SERIAL" install -r "$APK_PATH"',
  'CI=1 EXPO_UNSTABLE_HEADLESS=1 NODE_OPTIONS=--dns-result-order=ipv4first npm start -- --dev-client --localhost >"$METRO_LOG" 2>&1 &',
  'metro_pid=$!',
  'metro_ready=0',
  'for _attempt in {1..90}; do',
  'metro_status=$(curl --silent --fail --max-time 2 http://127.0.0.1:8081/status 2>/dev/null || :)',
  'if [[ "$metro_status" == \'packager-status:running\' ]]; then',
  'metro_ready=1',
  'break',
  'fi',
  'if ! kill -0 "$metro_pid" 2>/dev/null; then',
  "echo '::error::Metro exited before becoming ready.'",
  'show_metro_failure',
  'exit 1',
  'fi',
  'sleep 1',
  'done',
  'if [[ "$metro_ready" -ne 1 ]]; then',
  "echo '::error::Metro did not become ready within 90 seconds.'",
  'show_metro_failure',
  'exit 1',
  'fi',
  'npm run test:android:db',
  'npm run test:android:db:relaunch',
  'npm run test:android:db:wal-write-death',
  'npm run test:android:db:active-migration-death',
];

function linesOf(source) {
  return source.replace(/\r\n/g, '\n').split('\n');
}

function indentation(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function extractIndentedBlock(source, startPattern) {
  const lines = linesOf(source);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return undefined;

  const baseIndent = indentation(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && indentation(line) <= baseIndent) break;
    end += 1;
  }
  return { source: lines.slice(start, end).join('\n'), start };
}

function extractJob(workflow, name) {
  return extractIndentedBlock(workflow, new RegExp(`^  ${name}:\\s*$`));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasStandaloneLine(block, value) {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, 'm').test(block ?? '');
}

function liveTrimmedLines(source) {
  return linesOf(source ?? '')
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((line) => line && !line.startsWith('#'));
}

function topLevelStepHeaders(job) {
  return linesOf(job)
    .filter((line) => indentation(line) === 6 && line.trimStart().startsWith('- '))
    .map((line) => line.trim());
}

function requireExactStepInventory(job, reviewedHeaders, errors, owner) {
  const actual = topLevelStepHeaders(job);
  if (
    actual.length !== reviewedHeaders.length ||
    actual.some((line, index) => line !== reviewedHeaders[index])
  ) {
    errors.push(`${owner} must keep the exact reviewed step order with no extra steps.`);
  }
}

function requireExactHeaderStep(job, header, reviewedLines, errors, owner, description) {
  const step = extractIndentedBlock(job, new RegExp(`^      ${escapeRegExp(header)}\\s*$`))?.source;
  const headerCount = topLevelStepHeaders(job).filter((line) => line === header).length;
  const expected = [header, ...reviewedLines];
  const actual = liveTrimmedLines(step);
  if (
    headerCount !== 1 ||
    !step ||
    actual.length !== expected.length ||
    actual.some((line, index) => line !== expected[index])
  ) {
    errors.push(`${owner} must declare the exact reviewed ${description} once.`);
  }
  return step;
}

function requireExactNamedStep(job, name, reviewedLines, errors, owner) {
  return requireExactHeaderStep(
    job,
    `- name: ${name}`,
    reviewedLines,
    errors,
    owner,
    `"${name}" step`,
  );
}

function extractNamedStep(job, name) {
  return extractIndentedBlock(job, new RegExp(`^      - name: ${escapeRegExp(name)}\\s*$`))?.source;
}

function requireBlockingUnconditionalStep(step, name, errors) {
  if (/^\s*if\s*:/m.test(step ?? '')) {
    errors.push(`"${name}" must run unconditionally; do not add a step-level if condition.`);
  }
  if (/^\s*continue-on-error\s*:/m.test(step ?? '')) {
    errors.push(`"${name}" must fail the Android job when the diagnostic scan fails.`);
  }
}

function requireExactBlockingStep(job, jobLabel, name, command, errors) {
  const nameLine = `      - name: ${name}`;
  const commandLine = `        run: ${command}`;
  const nameCount = linesOf(job).filter((line) => line === nameLine).length;
  const commandCount = linesOf(job).filter((line) => line === commandLine).length;
  const step = extractNamedStep(job, name);

  if (nameCount !== 1 || !step) {
    errors.push(`${jobLabel} must declare "${name}" exactly once.`);
  }
  if (commandCount !== 1) {
    errors.push(`${jobLabel} "${name}" must run exactly once: ${command}`);
  }

  const reviewedLines = new Set([nameLine, commandLine]);
  const liveLines = linesOf(step ?? '').filter(
    (line) => line.trim() && !line.trimStart().startsWith('#'),
  );
  if (liveLines.length !== 2 || liveLines.some((line) => !reviewedLines.has(line))) {
    errors.push(`${jobLabel} "${name}" may contain only its reviewed name and exact run command.`);
  }

  return job.indexOf(nameLine);
}

function requireToolchainGuardBeforeInstall(job, jobLabel, errors, { requireTests = false } = {}) {
  const guardIndex = requireExactBlockingStep(
    job,
    jobLabel,
    TOOLCHAIN_GUARD_NAME,
    TOOLCHAIN_GUARD_COMMAND,
    errors,
  );
  const installIndex = requireExactBlockingStep(
    job,
    jobLabel,
    INSTALL_NAME,
    INSTALL_COMMAND,
    errors,
  );

  if (guardIndex < 0 || installIndex < 0 || guardIndex >= installIndex) {
    errors.push(`${jobLabel} must run the direct toolchain guard before npm ci.`);
  }

  if (!requireTests) return;
  const testIndex = requireExactBlockingStep(
    job,
    jobLabel,
    TOOLCHAIN_POLICY_TEST_NAME,
    TOOLCHAIN_POLICY_TEST_COMMAND,
    errors,
  );
  if (testIndex < 0 || guardIndex < 0 || testIndex >= guardIndex) {
    errors.push(`${jobLabel} must run the toolchain policy tests before the direct guard.`);
  }
}

function validateExactDeclarations(source, indent, owner, reviewedDeclarations, errors) {
  const keyCounts = new Map();
  const declarationKind = owner.endsWith('job') ? 'job-level declaration' : 'declaration';
  for (const line of linesOf(source)) {
    if (!line.trim() || line.trimStart().startsWith('#') || indentation(line) !== indent) continue;
    const key = reviewedDeclarations.get(line);
    if (!key) {
      errors.push(`The ${owner} has an unreviewed ${declarationKind}: ${line.trim()}`);
      continue;
    }
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  for (const key of reviewedDeclarations.values()) {
    if (keyCounts.get(key) !== 1) {
      errors.push(`The ${owner} must declare "${key}" exactly once.`);
    }
  }
}

function validateWorkflowRootDeclarations(workflow, errors) {
  validateExactDeclarations(
    workflow,
    0,
    'CI workflow root',
    new Map([
      ['name: CI', 'name'],
      ['on:', 'on'],
      ['permissions:', 'permissions'],
      ['concurrency:', 'concurrency'],
      ['jobs:', 'jobs'],
    ]),
    errors,
  );
}

function validateWorkflowTriggers(workflow, errors) {
  const triggers = extractIndentedBlock(workflow, /^on:\s*$/)?.source;
  if (!triggers) {
    errors.push('CI is missing its event triggers.');
    return;
  }
  validateExactDeclarations(
    triggers,
    2,
    'CI workflow triggers',
    new Map([
      ['  push:', 'push'],
      ['  pull_request:', 'pull_request'],
      ['  schedule:', 'schedule'],
      ['  workflow_dispatch:', 'workflow_dispatch'],
    ]),
    errors,
  );

  const schedule = extractIndentedBlock(triggers, /^  schedule:\s*$/)?.source;
  const liveSchedule = liveTrimmedLines(schedule);
  if (
    liveSchedule.length !== 2 ||
    liveSchedule[0] !== 'schedule:' ||
    liveSchedule[1] !== SCHEDULED_DB_CRON
  ) {
    errors.push(
      `CI must declare exactly one reviewed weekly Android DB schedule: ${SCHEDULED_DB_CRON}`,
    );
  }

  const concurrency = extractIndentedBlock(workflow, /^concurrency:\s*$/)?.source;
  const expectedConcurrency = [
    'concurrency:',
    'group: ci-${{ github.event_name }}-${{ github.ref }}',
    'cancel-in-progress: true',
  ];
  const liveConcurrency = liveTrimmedLines(concurrency);
  if (
    liveConcurrency.length !== expectedConcurrency.length ||
    liveConcurrency.some((line, index) => line !== expectedConcurrency[index])
  ) {
    errors.push('CI concurrency must isolate schedule, dispatch, push, and pull-request runs.');
  }
}

function requireWorkflowSecurityGuard(checkJob, errors) {
  const name = 'Workflow supply-chain guard';
  const nameLine = `      - name: ${name}`;
  const step = extractNamedStep(checkJob, name);
  const reviewedLines = new Set([
    nameLine,
    '        shell: bash',
    '        run: |',
    '          node --test scripts/check-workflow-security.test.mjs',
    '          node scripts/check-workflow-security.mjs',
  ]);
  const liveLines = linesOf(step ?? '').filter(
    (line) => line.trim() && !line.trimStart().startsWith('#'),
  );
  if (
    linesOf(checkJob).filter((line) => line === nameLine).length !== 1 ||
    liveLines.length !== reviewedLines.size ||
    liveLines.some((line) => !reviewedLines.has(line))
  ) {
    errors.push(
      'The workflow supply-chain guard must run its exact mutation test and validator once under an explicit bash shell.',
    );
  }
}

function validateActionPins(workflow, errors) {
  const declarations = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\r\n]+)$/gm)];
  if (declarations.length === 0) errors.push('CI must use at least one reviewed GitHub Action.');

  for (const declaration of declarations) {
    const raw = declaration[1].trim();
    const commentIndex = raw.indexOf('#');
    const target = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
    const comment = commentIndex >= 0 ? raw.slice(commentIndex + 1).trim() : '';

    if (target.startsWith('./')) continue;

    const at = target.lastIndexOf('@');
    const action = at > 0 ? target.slice(0, at) : target;
    const ref = at > 0 ? target.slice(at + 1) : '';
    if (!action.includes('/') || !FULL_COMMIT_SHA.test(ref)) {
      errors.push(`${target} must be pinned to a full 40-character commit SHA.`);
    }
    if (!READABLE_VERSION.test(comment)) {
      errors.push(`${target} must include a readable version comment such as "# v4.4.0".`);
    }
  }
}

function validatePermissions(workflow, errors) {
  const lines = linesOf(workflow);
  const blocks = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)permissions:\s*(.*)$/);
    if (!match) return;
    const indent = match[1].length;
    const inline = match[2].trim();
    const entries = [];

    let cursor = index + 1;
    while (cursor < lines.length) {
      const child = lines[cursor];
      if (child.trim() && !child.trimStart().startsWith('#') && indentation(child) <= indent) break;
      const entry = child.match(/^\s+([A-Za-z-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
      if (entry) entries.push([entry[1], entry[2]]);
      cursor += 1;
    }
    blocks.push({ indent, inline, entries });
  });

  const root = blocks.find((block) => block.indent === 0);
  if (!root) {
    errors.push('CI needs a top-level permissions block.');
  }

  for (const block of blocks) {
    const isContentsRead =
      block.inline === '' &&
      block.entries.length === 1 &&
      block.entries[0][0] === 'contents' &&
      block.entries[0][1] === 'read';
    if (!isContentsRead) {
      errors.push('Every permissions block must grant only "contents: read".');
    }
  }
}

function requireSafeAuditStep(checkJob, name, command, errors) {
  const step = extractNamedStep(checkJob, name);
  if (!step) {
    errors.push(`CI check job is missing the "${name}" step.`);
    return;
  }
  if (!step.includes(`run: ${command}`)) {
    errors.push(`"${name}" must run exactly: ${command}`);
  }
  if (/continue-on-error:\s*true|\|\|\s*true/.test(step)) {
    errors.push(`"${name}" must fail the job when npm reports a vulnerability.`);
  }
}

function requireDatabaseWriteApprovalGuard(checkJob, installIndex, errors) {
  const name = 'Database write approval guard';
  const command = 'node scripts/check-db-writes.mjs --check';
  const step = extractNamedStep(checkJob, name);
  if (!step) {
    errors.push(`CI check job is missing the "${name}" step.`);
    return;
  }
  const reviewedLines = new Set([`      - name: ${name}`, `        run: ${command}`]);
  const liveLines = linesOf(step).filter(
    (line) => line.trim() && !line.trimStart().startsWith('#'),
  );
  if (liveLines.some((line) => !reviewedLines.has(line))) {
    errors.push(`"${name}" may contain only its reviewed name and exact run command.`);
  }
  if (liveLines.filter((line) => line === `        run: ${command}`).length !== 1) {
    errors.push(`"${name}" must run exactly: ${command}`);
  }
  if (checkJob.indexOf(`      - name: ${name}`) < installIndex) {
    errors.push(`"${name}" must run after npm ci installs the scanner dependencies.`);
  }
  if (/^\s*if\s*:/m.test(step)) {
    errors.push(`"${name}" must run unconditionally.`);
  }
  if (/^\s*continue-on-error\s*:/m.test(step) || /\|\|\s*true/.test(step)) {
    errors.push(`"${name}" must fail the CI job when an unapproved write is found.`);
  }
}

function requireUiCoverageGate(checkJob, installIndex, errors) {
  const name = 'Unit tests and UI coverage gate';
  const command = 'npm run coverage:ui -- --ci --runInBand';
  const nameLine = `      - name: ${name}`;
  const commandLine = `        run: ${command}`;
  const matchingNames = linesOf(checkJob).filter((line) => line === nameLine).length;
  const step = extractNamedStep(checkJob, name);
  if (!step) {
    errors.push(`CI check job is missing the "${name}" step.`);
    return;
  }
  if (matchingNames !== 1) {
    errors.push(`The CI check job must declare "${name}" exactly once.`);
  }

  const reviewedLines = new Set([nameLine, commandLine]);
  const liveLines = linesOf(step).filter(
    (line) => line.trim() && !line.trimStart().startsWith('#'),
  );
  if (liveLines.some((line) => !reviewedLines.has(line))) {
    errors.push(`"${name}" may contain only its reviewed name and exact run command.`);
  }
  if (liveLines.filter((line) => line === commandLine).length !== 1) {
    errors.push(`"${name}" must run exactly: ${command}`);
  }
  if (installIndex < 0 || checkJob.indexOf(nameLine) < installIndex) {
    errors.push(`"${name}" must run after npm ci installs the test dependencies.`);
  }
  if (/^\s*if\s*:/m.test(step)) {
    errors.push(`"${name}" must run unconditionally.`);
  }
  if (/^\s*continue-on-error\s*:/m.test(step) || /\|\|\s*true/.test(step)) {
    errors.push(`"${name}" must fail the CI job when tests or coverage fall below the floor.`);
  }
}

function validateCheckJob(workflow, errors) {
  const check = extractJob(workflow, 'check');
  if (!check) {
    errors.push('CI is missing the check job.');
    return;
  }

  // Keep this release-blocking job structurally fail-closed. Any new job-level control must be
  // reviewed here first; otherwise `if`, `needs`, or `continue-on-error` could skip or neutralize
  // every guard inside it while the individual step still looked correct.
  validateExactDeclarations(
    check.source,
    4,
    'CI check job',
    new Map([
      ['    name: Typecheck · Format · Test', 'name'],
      ['    runs-on: ubuntu-latest', 'runs-on'],
      ['    steps:', 'steps'],
    ]),
    errors,
  );

  const checkout = extractIndentedBlock(
    check.source,
    /^      - uses: actions\/checkout@[a-f0-9]{40}/i,
  )?.source;
  if (!checkout || !/^          fetch-depth:\s*0\s*$/m.test(checkout)) {
    errors.push('The check job checkout must use fetch-depth: 0 so history scanning is complete.');
  }

  requireWorkflowSecurityGuard(check.source, errors);

  requireToolchainGuardBeforeInstall(check.source, 'CI check job', errors, {
    requireTests: true,
  });

  const installIndex = check.source.indexOf('run: npm ci');
  requireDatabaseWriteApprovalGuard(check.source, installIndex, errors);
  requireUiCoverageGate(check.source, installIndex, errors);
  const fullAuditIndex = check.source.indexOf('run: npm audit --audit-level=high');
  const productionAuditIndex = check.source.indexOf('run: npm audit --omit=dev --audit-level=high');
  if (installIndex < 0 || fullAuditIndex < installIndex || productionAuditIndex < installIndex) {
    errors.push('Both high-severity npm audits must run after the clean npm ci install.');
  }

  requireSafeAuditStep(
    check.source,
    'Audit clean lockfile (all dependencies)',
    'npm audit --audit-level=high',
    errors,
  );
  requireSafeAuditStep(
    check.source,
    'Audit production dependencies',
    'npm audit --omit=dev --audit-level=high',
    errors,
  );
}

function validateAndroidJob(workflow, errors) {
  const android = extractJob(workflow, 'android');
  if (!android) {
    errors.push('CI is missing the Android build job.');
    return;
  }

  validateExactDeclarations(
    android.source,
    4,
    'Android CI job',
    new Map([
      ['    name: Clean Android prebuild · native modules · APK + AAB', 'name'],
      ['    runs-on: ubuntu-latest', 'runs-on'],
      ['    timeout-minutes: 45', 'timeout-minutes'],
      ['    steps:', 'steps'],
    ]),
    errors,
  );

  requireToolchainGuardBeforeInstall(android.source, 'Android CI job', errors);

  const prebuild = extractNamedStep(android.source, 'Clean Expo prebuild');
  const prebuildCommand =
    './node_modules/.bin/expo prebuild --platform android --clean --no-install';
  if (!hasStandaloneLine(prebuild, `run: ${prebuildCommand}`)) {
    errors.push(`The Android job must run a clean Expo prebuild: ${prebuildCommand}`);
  }

  const generatedDiagnosticGuard = extractNamedStep(
    android.source,
    'Scan generated Android diagnostics',
  );
  if (!hasStandaloneLine(generatedDiagnosticGuard, 'run: npm run check:error-diagnostics')) {
    errors.push('The Android job must scan generated Android diagnostics after prebuild.');
  } else if (
    android.source.indexOf('      - name: Scan generated Android diagnostics') <
    android.source.indexOf('      - name: Clean Expo prebuild')
  ) {
    errors.push('The generated Android diagnostic scan must run after the clean Expo prebuild.');
  }
  requireBlockingUnconditionalStep(
    generatedDiagnosticGuard,
    'Scan generated Android diagnostics',
    errors,
  );

  const nativeBuild = extractNamedStep(android.source, 'Compile local native modules');
  for (const task of [
    ':gator-paste-input:compileDebugKotlin',
    ':gator-share-shortcuts:compileDebugKotlin',
    ':gator-bounded-download:compileDebugKotlin',
    ':gator-screen-security:compileDebugKotlin',
  ]) {
    if (!hasStandaloneLine(nativeBuild, task)) {
      errors.push(`The Android job must run the native build task ${task}.`);
    }
  }

  const debugBuild = requireExactNamedStep(
    android.source,
    'Assemble debug APK',
    ['working-directory: android', 'run: ./gradlew :app:assembleDebug --no-daemon'],
    errors,
    'The Android build job',
  );
  if (!hasStandaloneLine(debugBuild, 'run: ./gradlew :app:assembleDebug --no-daemon')) {
    errors.push('The Android job must assemble the debug APK in its own Gradle invocation.');
  }

  const releaseBuild = requireExactNamedStep(
    android.source,
    'Bundle release AAB',
    ['working-directory: android', 'run: ./gradlew :app:bundleRelease --no-daemon'],
    errors,
    'The Android build job',
  );
  if (!hasStandaloneLine(releaseBuild, 'run: ./gradlew :app:bundleRelease --no-daemon')) {
    errors.push('The Android job must bundle the release AAB in its own Gradle invocation.');
  }

  const packagedArtifactGuard = requireExactNamedStep(
    android.source,
    'Verify debug/release manifests, release AAB, and headless entry',
    ['run: npm run check:android-build'],
    errors,
    'The Android build job',
  );
  if (!hasStandaloneLine(packagedArtifactGuard, 'run: npm run check:android-build')) {
    errors.push('The Android job must run npm run check:android-build.');
  }

  const apkHandoff = requireExactNamedStep(
    android.source,
    'Retain debug APK for scheduled database checks',
    [
      SCHEDULED_DB_CONDITION,
      'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
      'with:',
      `name: ${SCHEDULED_DB_APK_ARTIFACT}`,
      'path: android/app/build/outputs/apk/debug/app-debug.apk',
      'if-no-files-found: error',
      'retention-days: 1',
    ],
    errors,
    'The Android build job',
  );
  const androidStepHeaders = topLevelStepHeaders(android.source);
  const artifactGuardIndex = androidStepHeaders.indexOf(
    '- name: Verify debug/release manifests, release AAB, and headless entry',
  );
  const apkHandoffIndex = androidStepHeaders.indexOf(
    '- name: Retain debug APK for scheduled database checks',
  );
  const reviewedFinalSteps = [
    '- name: Assemble debug APK',
    '- name: Bundle release AAB',
    '- name: Verify debug/release manifests, release AAB, and headless entry',
    '- name: Retain debug APK for scheduled database checks',
  ];
  const actualFinalSteps = androidStepHeaders.slice(-reviewedFinalSteps.length);
  if (
    actualFinalSteps.length !== reviewedFinalSteps.length ||
    actualFinalSteps.some((line, index) => line !== reviewedFinalSteps[index])
  ) {
    errors.push(
      'The Android build job must end with the exact reviewed build, verification, and APK handoff step order.',
    );
  }
  if (
    !packagedArtifactGuard ||
    !apkHandoff ||
    artifactGuardIndex < 0 ||
    apkHandoffIndex !== artifactGuardIndex + 1
  ) {
    errors.push(
      'The scheduled DB APK handoff must immediately follow the packaged Android artifact guard.',
    );
  }
}

function validateScheduledAndroidDbJob(workflow, errors) {
  const job = extractJob(workflow, 'android-db');
  if (!job) {
    errors.push('CI is missing the scheduled Android DB job.');
    return;
  }

  validateExactDeclarations(
    job.source,
    4,
    'scheduled Android DB job',
    new Map([
      ['    name: Scheduled Android DB · API 36 x86_64', 'name'],
      [`    ${SCHEDULED_DB_CONDITION}`, 'if'],
      ['    needs: android', 'needs'],
      ['    runs-on: ubuntu-latest', 'runs-on'],
      ['    timeout-minutes: 45', 'timeout-minutes'],
      ['    steps:', 'steps'],
    ]),
    errors,
  );

  requireExactStepInventory(
    job.source,
    [
      '- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
      '- name: Set up Node',
      '- name: Verify toolchain pins',
      '- name: Set up Java',
      '- name: Install dependencies',
      '- name: Download reviewed debug APK',
      '- name: Enable KVM',
      '- name: Run real Android database lanes',
      '- name: Retain privacy-safe Android database reports',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireExactHeaderStep(
    job.source,
    '- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    [],
    errors,
    'The scheduled Android DB job',
    'checkout step',
  );

  requireExactNamedStep(
    job.source,
    'Set up Node',
    [
      'uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
      'with:',
      'node-version-file: .nvmrc',
      'cache: npm',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireToolchainGuardBeforeInstall(job.source, 'Scheduled Android DB job', errors);

  requireExactNamedStep(
    job.source,
    'Set up Java',
    [
      'uses: actions/setup-java@d7793b545071e98d581d3bf084a51c3213318a07 # v4.9.0',
      'with:',
      'distribution: temurin',
      'java-version: 17',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireExactNamedStep(
    job.source,
    'Download reviewed debug APK',
    [
      'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
      'with:',
      `name: ${SCHEDULED_DB_APK_ARTIFACT}`,
      'path: android/app/build/outputs/apk/debug',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireExactNamedStep(
    job.source,
    'Enable KVM',
    [
      'shell: bash',
      'run: |',
      'echo \'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\' \\',
      '| sudo tee /etc/udev/rules.d/99-kvm4all.rules',
      'sudo udevadm control --reload-rules',
      'sudo udevadm trigger --name-match=kvm',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireExactNamedStep(
    job.source,
    'Run real Android database lanes',
    [
      'uses: reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d # v2.38.0',
      'env:',
      'ANDROID_SERIAL: emulator-5554',
      'with:',
      'api-level: 36',
      'target: google_apis',
      'arch: x86_64',
      'profile: pixel_7',
      'emulator-port: 5554',
      'disable-animations: true',
      'script: bash scripts/run-android-db-ci.sh',
    ],
    errors,
    'The scheduled Android DB job',
  );

  requireExactNamedStep(
    job.source,
    'Retain privacy-safe Android database reports',
    [
      'if: always()',
      'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
      'with:',
      `name: ${SCHEDULED_DB_REPORT_ARTIFACT}`,
      'path: |',
      'android/app/build/reports/db-contract/android-db-contract-*.json',
      'android/app/build/reports/db-relaunch/android-db-relaunch-*.json',
      'android/app/build/reports/db-wal-write-death/android-db-wal-write-death-*.json',
      'android/app/build/reports/db-active-migration-death/android-db-active-migration-death-*.json',
      'if-no-files-found: error',
      'retention-days: 14',
    ],
    errors,
    'The scheduled Android DB job',
  );
}

function validateScheduledAndroidDbRunner(androidDbRunner, errors) {
  const actual = liveTrimmedLines(androidDbRunner);
  if (
    actual.length !== SCHEDULED_DB_RUNNER_LINES.length ||
    actual.some((line, index) => line !== SCHEDULED_DB_RUNNER_LINES[index])
  ) {
    errors.push(
      'The scheduled Android DB runner must keep the exact reviewed install, Metro, cleanup, and four-lane command sequence.',
    );
  }
}

function validateDependencyReview(workflow, errors) {
  if (/^\s*pull_request_target\s*:/m.test(workflow)) {
    errors.push('CI must not use pull_request_target for dependency review.');
  }

  const job = extractJob(workflow, 'dependency-review');
  if (!job) {
    errors.push('CI is missing the pull-request dependency-review job.');
    return;
  }
  if (!/^    if: github\.event_name == 'pull_request'\s*$/m.test(job.source)) {
    errors.push('The dependency-review job must run only for pull_request events.');
  }
  if (
    !/uses:\s*actions\/dependency-review-action@[a-f0-9]{40}\s+#\s+v\d+\.\d+\.\d+/i.test(job.source)
  ) {
    errors.push('The dependency-review job must use the SHA-pinned dependency review action.');
  }
  if (!/^          fail-on-severity:\s*high\s*$/m.test(job.source)) {
    errors.push('Dependency review must block newly introduced high and critical dependencies.');
  }
  if (/continue-on-error:\s*true/.test(job.source)) {
    errors.push('Dependency review must fail the job when it finds a blocked dependency.');
  }
}

function dependabotSection(source, ecosystem) {
  const pattern = new RegExp(`^  - package-ecosystem: ["']?${ecosystem}["']?\\s*$`, 'm');
  return extractIndentedBlock(source, pattern)?.source;
}

function validateDependabot(dependabot, errors) {
  if (!/^version:\s*2\s*$/m.test(dependabot)) {
    errors.push('Dependabot configuration must use version 2.');
  }

  for (const ecosystem of ['npm', 'github-actions']) {
    const matches = [
      ...dependabot.matchAll(
        new RegExp(`^  - package-ecosystem: ["']?${ecosystem}["']?\\s*$`, 'gm'),
      ),
    ];
    const section = dependabotSection(dependabot, ecosystem);
    if (matches.length !== 1 || !section) {
      errors.push(`Dependabot must contain exactly one ${ecosystem} update entry.`);
      continue;
    }
    if (!/^    directory:\s*["']?\/["']?\s*$/m.test(section)) {
      errors.push(`Dependabot ${ecosystem} updates must target the repository root.`);
    }
    if (!/^      interval:\s*weekly\s*$/m.test(section)) {
      errors.push(`Dependabot ${ecosystem} updates must run weekly.`);
    }
  }

  const npm = dependabotSection(dependabot, 'npm');
  if (npm && !/^    versioning-strategy:\s*increase-if-necessary\s*$/m.test(npm)) {
    errors.push('Dependabot npm updates must preserve exact pins unless an update is necessary.');
  }
}

export function validateWorkflowSecurity({ workflow, dependabot, androidDbRunner }) {
  const errors = [];
  validateWorkflowRootDeclarations(workflow, errors);
  validateWorkflowTriggers(workflow, errors);
  validateActionPins(workflow, errors);
  validatePermissions(workflow, errors);
  validateCheckJob(workflow, errors);
  validateAndroidJob(workflow, errors);
  validateScheduledAndroidDbJob(workflow, errors);
  validateScheduledAndroidDbRunner(androidDbRunner, errors);
  validateDependencyReview(workflow, errors);
  validateDependabot(dependabot, errors);
  return errors;
}

export function runWorkflowSecurityCheck({ root = process.cwd() } = {}) {
  const workflow = readFileSync(resolve(root, DEFAULT_WORKFLOW), 'utf8');
  const dependabot = readFileSync(resolve(root, DEFAULT_DEPENDABOT), 'utf8');
  const androidDbRunner = readFileSync(resolve(root, DEFAULT_ANDROID_DB_RUNNER), 'utf8');
  const errors = validateWorkflowSecurity({ workflow, dependabot, androidDbRunner });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));

  const actionCount = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*/gm)].length;
  return { actionCount };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runWorkflowSecurityCheck();
    console.log(
      `Workflow security guard passed: ${result.actionCount} action uses are immutable; database-write approval, UI coverage, audits, dependency review, Android release verification, and scheduled Android DB lane configuration are enforced.`,
    );
  } catch (error) {
    console.error(
      `Workflow security guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
