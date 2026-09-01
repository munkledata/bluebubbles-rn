import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validateWorkflowSecurity } from './check-workflow-security.mjs';

const root = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const dependabot = readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8');
const androidDbRunner = readFileSync(resolve(root, 'scripts/run-android-db-ci.sh'), 'utf8');
const toolchainPolicyTestStep = [
  '      - name: Test toolchain policy',
  '        run: node --test scripts/check-toolchain.test.mjs scripts/release-android.test.mjs',
].join('\n');
const toolchainGuardStep = [
  '      - name: Verify toolchain pins',
  '        run: node scripts/check-toolchain.mjs',
].join('\n');
const installStep = ['      - name: Install dependencies', '        run: npm ci'].join('\n');

function errorsFor(
  workflowMutation = workflow,
  dependabotMutation = dependabot,
  androidDbRunnerMutation = androidDbRunner,
) {
  return validateWorkflowSecurity({
    workflow: workflowMutation,
    dependabot: dependabotMutation,
    androidDbRunner: androidDbRunnerMutation,
  });
}

function replaceOccurrence(source, target, replacement, occurrence, description) {
  let index = -1;
  let offset = 0;
  for (let current = 0; current <= occurrence; current += 1) {
    index = source.indexOf(target, offset);
    assert.notEqual(index, -1, `${description} must find occurrence ${occurrence + 1}`);
    offset = index + target.length;
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
}

test('accepts the repository workflow and Dependabot policy', () => {
  assert.deepEqual(errorsFor(), []);
});

test('requires the reviewed weekly schedule, manual trigger, and event-isolated concurrency', () => {
  for (const [label, target, replacement, expectedError] of [
    ['schedule', '  schedule:\n', '  schedule-disabled:\n', 'workflow triggers'],
    ['cron', "- cron: '17 7 * * 2'", "- cron: '0 7 * * 2'", 'weekly Android DB schedule'],
    [
      'manual trigger',
      '  workflow_dispatch:\n',
      '  workflow_dispatch_disabled:\n',
      'workflow triggers',
    ],
    [
      'concurrency',
      'group: ci-${{ github.event_name }}-${{ github.ref }}',
      'group: ci-${{ github.ref }}',
      'concurrency',
    ],
  ]) {
    const mutated = workflow.replace(target, replacement);
    assert.notEqual(mutated, workflow, `${label} mutation must change the fixture`);
    assert.ok(
      errorsFor(mutated).some((error) => error.includes(expectedError)),
      `${label} must fail closed`,
    );
  }
});

test('requires the reviewed debug APK handoff after Android artifact verification', () => {
  for (const [label, target, replacement] of [
    [
      'event condition',
      "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
      'if: always()',
    ],
    ['artifact name', 'name: scheduled-android-db-debug-apk', 'name: unreviewed-apk'],
    ['missing-file policy', 'if-no-files-found: error', 'if-no-files-found: warn'],
  ]) {
    const mutated = workflow.replace(target, replacement);
    assert.notEqual(mutated, workflow, `${label} mutation must change the fixture`);
    assert.ok(
      errorsFor(mutated).some((error) =>
        error.includes('Retain debug APK for scheduled database checks'),
      ),
      `${label} must fail closed`,
    );
  }

  const stepStart = '      - name: Retain debug APK for scheduled database checks';
  const stepEnd = '\n\n  android-db:';
  const start = workflow.indexOf(stepStart);
  const end = workflow.indexOf(stepEnd, start);
  assert.ok(start >= 0 && end > start, 'the APK handoff step must exist in the fixture');
  const step = workflow.slice(start, end);
  const withoutStep = `${workflow.slice(0, start)}${workflow.slice(end)}`;
  const moved = withoutStep.replace(
    '      - name: Verify debug/release manifests, release AAB, and headless entry',
    `${step}\n\n      - name: Verify debug/release manifests, release AAB, and headless entry`,
  );
  assert.ok(
    errorsFor(moved).some((error) => error.includes('immediately follow the packaged Android')),
  );

  const mutatingStep = [
    '      - name: Mutate APK after verification',
    '        run: touch android/app/build/outputs/apk/debug/app-debug.apk',
    '',
  ].join('\n');
  const mutatedAfterVerification = workflow.replace(stepStart, `${mutatingStep}${stepStart}`);
  assert.notEqual(mutatedAfterVerification, workflow);
  assert.ok(
    errorsFor(mutatedAfterVerification).some((error) =>
      error.includes('immediately follow the packaged Android'),
    ),
  );
});

test('pins the scheduled Android DB emulator command and finite report upload', () => {
  for (const [label, target, replacement] of [
    ['job dependency', '    needs: android', '    needs: check'],
    ['Android API', '          api-level: 36', '          api-level: 35'],
    ['emulator ABI', '          arch: x86_64', '          arch: arm64-v8a'],
    [
      'runner command',
      '          script: bash scripts/run-android-db-ci.sh',
      '          script: bash scripts/unreviewed.sh',
    ],
    [
      'report terminal condition',
      '      - name: Retain privacy-safe Android database reports\n        if: always()',
      '      - name: Retain privacy-safe Android database reports\n        if: success()',
    ],
    [
      'report scope',
      '            android/app/build/reports/db-contract/android-db-contract-*.json',
      '            android/app/build/reports/**',
    ],
  ]) {
    const mutated = workflow.replace(target, replacement);
    assert.notEqual(mutated, workflow, `${label} mutation must change the fixture`);
    assert.ok(
      errorsFor(mutated).some((error) => error.includes('scheduled Android DB job')),
      `${label} must fail closed`,
    );
  }
});

test('pins the Android DB runner lifecycle and exact four-lane sequence', () => {
  for (const [label, target, replacement] of [
    ['fail-fast shell', 'set -euo pipefail', 'set +e'],
    ['cleanup trap', 'trap cleanup EXIT', 'trap - EXIT'],
    ['headless Expo', 'EXPO_UNSTABLE_HEADLESS=1', 'EXPO_UNSTABLE_HEADLESS=0'],
    [
      'IPv4 localhost resolution',
      'NODE_OPTIONS=--dns-result-order=ipv4first',
      'NODE_OPTIONS=--dns-result-order=verbatim',
    ],
    ['contract lane', 'npm run test:android:db\n', 'npm --version\n'],
    ['relaunch lane', 'npm run test:android:db:relaunch\n', 'npm --version\n'],
    ['WAL lane', 'npm run test:android:db:wal-write-death\n', 'npm --version\n'],
    ['migration lane', 'npm run test:android:db:active-migration-death\n', 'npm --version\n'],
  ]) {
    const mutated = androidDbRunner.replace(target, replacement);
    assert.notEqual(mutated, androidDbRunner, `${label} mutation must change the fixture`);
    assert.ok(
      errorsFor(workflow, dependabot, mutated).some((error) =>
        error.includes('scheduled Android DB runner'),
      ),
      `${label} must fail closed`,
    );
  }

  const withUnrelatedLane = androidDbRunner.replace(
    'npm run test:android:db:active-migration-death',
    'npm run test:android:db:active-migration-death\nnpm run test:android:db:runtime-concurrency',
  );
  assert.ok(
    errorsFor(workflow, dependabot, withUnrelatedLane).some((error) =>
      error.includes('scheduled Android DB runner'),
    ),
  );

  const withBrokenEnvironmentContinuation = androidDbRunner.replace(
    'NODE_OPTIONS=--dns-result-order=ipv4first npm start',
    'NODE_OPTIONS=--dns-result-order=ipv4first \\\n# break the exported environment\nnpm start',
  );
  assert.notEqual(withBrokenEnvironmentContinuation, androidDbRunner);
  assert.ok(
    errorsFor(workflow, dependabot, withBrokenEnvironmentContinuation).some((error) =>
      error.includes('scheduled Android DB runner'),
    ),
  );

  for (const mutated of [
    androidDbRunner.replace('trap cleanup EXIT', 'trap cleanup EXIT\n\u00a0#not-a-bash-comment'),
    androidDbRunner.replace('CI=1 EXPO_UNSTABLE_HEADLESS=1', '\u00a0CI=1 EXPO_UNSTABLE_HEADLESS=1'),
  ]) {
    assert.notEqual(mutated, androidDbRunner, 'Unicode mutation must change the fixture');
    assert.ok(
      errorsFor(workflow, dependabot, mutated).some((error) =>
        error.includes('scheduled Android DB runner'),
      ),
      'Unicode shell whitespace must fail closed',
    );
  }
});

test('rejects unreviewed steps that can mutate scheduled Android DB evidence', () => {
  const extraStep = [
    '      - name: Mutate downloaded evidence input',
    '        run: touch android/app/build/outputs/apk/debug/app-debug.apk',
    '',
  ].join('\n');
  const mutated = workflow.replace(
    '      - name: Enable KVM',
    `${extraStep}      - name: Enable KVM`,
  );
  assert.notEqual(mutated, workflow);
  assert.ok(errorsFor(mutated).some((error) => error.includes('exact reviewed step order')));
});

test('requires one exact direct toolchain guard before npm ci in all installing CI jobs', () => {
  assert.equal(workflow.split(toolchainGuardStep).length - 1, 3);
  assert.equal(workflow.split(installStep).length - 1, 3);

  for (const [jobLabel, occurrence] of [
    ['CI check job', 0],
    ['Android CI job', 1],
    ['Scheduled Android DB job', 2],
  ]) {
    const missing = replaceOccurrence(
      workflow,
      `${toolchainGuardStep}\n\n`,
      '',
      occurrence,
      `${jobLabel} missing guard mutation`,
    );
    assert.ok(errorsFor(missing).some((error) => error.includes(jobLabel)));

    for (const [label, replacement] of [
      ['npm-script alias', 'npm run check:toolchain'],
      ['ignored failure', 'node scripts/check-toolchain.mjs || true'],
      ['extra argument', 'node scripts/check-toolchain.mjs --skip-native-pins'],
    ]) {
      const wrongCommand = replaceOccurrence(
        workflow,
        toolchainGuardStep,
        toolchainGuardStep.replace('node scripts/check-toolchain.mjs', replacement),
        occurrence,
        `${jobLabel} ${label} mutation`,
      );
      assert.ok(
        errorsFor(wrongCommand).some(
          (error) => error.includes(jobLabel) && error.includes('must run exactly once'),
        ),
        `${jobLabel}: ${label}`,
      );
    }

    for (const control of [
      'if: false',
      "'if': false",
      'continue-on-error: true',
      '<<: { if: false }',
      'shell: bash',
      'run: node --version',
    ]) {
      const controlled = replaceOccurrence(
        workflow,
        toolchainGuardStep,
        toolchainGuardStep.replace('\n        run:', `\n        ${control}\n        run:`),
        occurrence,
        `${jobLabel} ${control} mutation`,
      );
      assert.ok(
        errorsFor(controlled).some(
          (error) => error.includes(jobLabel) && error.includes('only its reviewed name'),
        ),
        `${jobLabel}: ${control}`,
      );
    }

    const withoutGuard = replaceOccurrence(
      workflow,
      `${toolchainGuardStep}\n\n`,
      '',
      occurrence,
      `${jobLabel} ordering removal`,
    );
    const movedAfterInstall = replaceOccurrence(
      withoutGuard,
      installStep,
      `${installStep}\n\n${toolchainGuardStep}`,
      occurrence,
      `${jobLabel} ordering insertion`,
    );
    assert.ok(
      errorsFor(movedAfterInstall).some(
        (error) => error.includes(jobLabel) && error.includes('before npm ci'),
      ),
    );

    const duplicateGuard = replaceOccurrence(
      workflow,
      toolchainGuardStep,
      `${toolchainGuardStep}\n\n${toolchainGuardStep}`,
      occurrence,
      `${jobLabel} duplicate guard mutation`,
    );
    assert.ok(
      errorsFor(duplicateGuard).some(
        (error) => error.includes(jobLabel) && error.includes('exactly once'),
      ),
    );

    const duplicateInstall = replaceOccurrence(
      workflow,
      installStep,
      `${installStep}\n\n${installStep}`,
      occurrence,
      `${jobLabel} duplicate install mutation`,
    );
    assert.ok(
      errorsFor(duplicateInstall).some(
        (error) => error.includes(jobLabel) && error.includes('exactly once'),
      ),
    );
  }
});

test('requires the exact toolchain policy tests before the check-job guard', () => {
  const missing = workflow.replace(`${toolchainPolicyTestStep}\n\n`, '');
  assert.notEqual(missing, workflow);
  assert.ok(errorsFor(missing).some((error) => error.includes('Test toolchain policy')));

  const npmAlias = workflow.replace(
    toolchainPolicyTestStep,
    toolchainPolicyTestStep.replace(
      'node --test scripts/check-toolchain.test.mjs scripts/release-android.test.mjs',
      'npm run check:toolchain',
    ),
  );
  assert.notEqual(npmAlias, workflow);
  assert.ok(errorsFor(npmAlias).some((error) => error.includes('Test toolchain policy')));

  const conditional = workflow.replace(
    toolchainPolicyTestStep,
    toolchainPolicyTestStep.replace('\n        run:', '\n        if: false\n        run:'),
  );
  assert.notEqual(conditional, workflow);
  assert.ok(
    errorsFor(conditional).some(
      (error) =>
        error.includes('Test toolchain policy') && error.includes('only its reviewed name'),
    ),
  );

  const movedAfterGuard = workflow.replace(
    `${toolchainPolicyTestStep}\n\n${toolchainGuardStep}`,
    `${toolchainGuardStep}\n\n${toolchainPolicyTestStep}`,
  );
  assert.notEqual(movedAfterGuard, workflow);
  assert.ok(errorsFor(movedAfterGuard).some((error) => error.includes('policy tests before')));
});

test('rejects workflow and Android controls that can neutralize pre-install guards', () => {
  for (const shellLine of ['', '        shell: bash {0} || true\n']) {
    const mutated = workflow.replace(
      '        shell: bash\n        run: |',
      `${shellLine}        run: |`,
    );
    assert.notEqual(mutated, workflow);
    assert.ok(errorsFor(mutated).some((error) => error.includes('explicit bash shell')));
  }

  const workflowDefault = workflow.replace(
    '\njobs:\n',
    '\ndefaults:\n  run:\n    shell: bash {0} || true\n\njobs:\n',
  );
  assert.notEqual(workflowDefault, workflow);
  assert.ok(errorsFor(workflowDefault).some((error) => error.includes('CI workflow root')));

  for (const control of [
    'if: false',
    "'if': false",
    'continue-on-error: true',
    'defaults: { run: { shell: "bash {0} || true" } }',
    '<<: { if: false }',
  ]) {
    const mutated = workflow.replace(
      '  android:\n    name:',
      `  android:\n    ${control}\n    name:`,
    );
    assert.notEqual(mutated, workflow, control);
    assert.ok(
      errorsFor(mutated).some(
        (error) =>
          error.includes('Android CI job') && error.includes('unreviewed job-level declaration'),
      ),
      control,
    );
  }
});

test('rejects a mutable action tag', () => {
  const mutated = workflow.replace(
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    'actions/checkout@v4',
  );
  assert.ok(errorsFor(mutated).some((error) => error.includes('40-character commit SHA')));
});

test('rejects an action with no ref', () => {
  const mutated = workflow.replace(
    'actions/setup-java@d7793b545071e98d581d3bf084a51c3213318a07 # v4.9.0',
    'actions/setup-java',
  );
  assert.ok(errorsFor(mutated).some((error) => error.includes('40-character commit SHA')));
});

test('rejects an immutable action with no readable version comment', () => {
  const mutated = workflow.replace(' # v4.9.0', '');
  assert.ok(errorsFor(mutated).some((error) => error.includes('readable version comment')));
});

test('rejects elevated workflow permissions', () => {
  const mutated = workflow.replace(
    'permissions:\n  contents: read',
    'permissions:\n  contents: write',
  );
  assert.ok(errorsFor(mutated).some((error) => error.includes('only "contents: read"')));
});

test('requires complete Git history for the secret-hygiene scan', () => {
  const mutated = workflow.replace('          fetch-depth: 0', '          fetch-depth: 1');
  assert.ok(errorsFor(mutated).some((error) => error.includes('fetch-depth: 0')));
});

test('requires the fail-closed database write approval guard after dependency install', () => {
  const step = [
    '      - name: Database write approval guard',
    '        run: node scripts/check-db-writes.mjs --check',
  ].join('\n');

  const reportOnly = workflow.replace(
    'node scripts/check-db-writes.mjs --check',
    'node scripts/check-db-writes.mjs --report',
  );
  assert.notEqual(reportOnly, workflow, 'the report-only mutation must change the fixture');
  assert.ok(errorsFor(reportOnly).some((error) => error.includes('must run exactly')));

  const missing = workflow.replace(`${step}\n\n`, '');
  assert.notEqual(missing, workflow, 'the missing-step mutation must change the fixture');
  assert.ok(errorsFor(missing).some((error) => error.includes('missing')));

  const ignored = workflow.replace(
    step,
    `${step.split('\n')[0]}\n        continue-on-error: true\n${step.split('\n')[1]}`,
  );
  assert.notEqual(ignored, workflow, 'the ignored-failure mutation must change the fixture');
  assert.ok(errorsFor(ignored).some((error) => error.includes('must fail the CI job')));

  for (const extraStepControl of [
    '"if": false',
    "'continue-on-error': true",
    '<<: { if: false }',
    'shell: bash {0} || true',
  ]) {
    const controlledStep = workflow.replace(
      step,
      `${step.split('\n')[0]}\n        ${extraStepControl}\n${step.split('\n')[1]}`,
    );
    assert.notEqual(controlledStep, workflow, `${extraStepControl} must change the fixture`);
    assert.ok(
      errorsFor(controlledStep).some((error) => error.includes('only its reviewed name')),
      `the database guard step must reject ${extraStepControl}`,
    );
  }

  const duplicateRun = workflow.replace(
    step,
    `${step.split('\n')[0]}\n${step.split('\n')[1]}\n${step.split('\n')[1]}`,
  );
  assert.notEqual(duplicateRun, workflow, 'the duplicate-run mutation must change the fixture');
  assert.ok(errorsFor(duplicateRun).some((error) => error.includes('must run exactly')));

  const conditionalStep = workflow.replace(
    step,
    `${step.split('\n')[0]}\n        if: false\n${step.split('\n')[1]}`,
  );
  assert.notEqual(
    conditionalStep,
    workflow,
    'the conditional-step mutation must change the fixture',
  );
  assert.ok(errorsFor(conditionalStep).some((error) => error.includes('must run unconditionally')));

  const movedBeforeInstall = workflow
    .replace(`${step}\n\n`, '')
    .replace('      - name: Install dependencies', `${step}\n\n      - name: Install dependencies`);
  assert.notEqual(movedBeforeInstall, workflow, 'the ordering mutation must change the fixture');
  assert.ok(errorsFor(movedBeforeInstall).some((error) => error.includes('after npm ci')));

  for (const jobControl of [
    'if: false',
    'needs: dependency-review',
    'continue-on-error: true',
    'timeout-minutes: 1',
    '"if": false',
    "'needs': dependency-review",
    '"continue-on-error": true',
    '<<: { if: false }',
  ]) {
    const controlledJob = workflow.replace('  check:\n', `  check:\n    ${jobControl}\n`);
    assert.notEqual(controlledJob, workflow, `${jobControl} must change the fixture`);
    assert.ok(
      errorsFor(controlledJob).some((error) => error.includes('unreviewed job-level declaration')),
      `the check job must reject ${jobControl}`,
    );
  }

  const checkJobHeader = [
    '  check:',
    '    name: Typecheck · Format · Test',
    '    runs-on: ubuntu-latest',
    '    steps:',
  ].join('\n');
  const duplicateSteps = workflow.replace(checkJobHeader, `${checkJobHeader}\n    steps:`);
  assert.notEqual(duplicateSteps, workflow, 'the duplicate-key mutation must change the fixture');
  assert.ok(errorsFor(duplicateSteps).some((error) => error.includes('"steps" exactly once')));
});

test('requires the exact fail-closed UI coverage gate after dependency install', () => {
  const step = [
    '      - name: Unit tests and UI coverage gate',
    '        run: npm run coverage:ui -- --ci --runInBand',
  ].join('\n');

  const wrongCommand = workflow.replace(
    'npm run coverage:ui -- --ci --runInBand',
    'npm test -- --ci',
  );
  assert.notEqual(wrongCommand, workflow, 'the command mutation must change the fixture');
  assert.ok(errorsFor(wrongCommand).some((error) => error.includes('must run exactly')));

  const silentCommand = workflow.replace(
    'npm run coverage:ui -- --ci --runInBand',
    'npm run coverage:ui -- --ci --runInBand --silent',
  );
  assert.notEqual(silentCommand, workflow, 'the silent-command mutation must change the fixture');
  assert.ok(errorsFor(silentCommand).some((error) => error.includes('must run exactly')));

  const renamed = workflow.replace('Unit tests and UI coverage gate', 'Unit tests');
  assert.notEqual(renamed, workflow, 'the name mutation must change the fixture');
  assert.ok(errorsFor(renamed).some((error) => error.includes('missing')));

  const missing = workflow.replace(`${step}\n`, '');
  assert.notEqual(missing, workflow, 'the missing-step mutation must change the fixture');
  assert.ok(errorsFor(missing).some((error) => error.includes('missing')));

  const duplicate = workflow.replace(step, `${step}\n\n${step}`);
  assert.notEqual(duplicate, workflow, 'the duplicate-step mutation must change the fixture');
  assert.ok(errorsFor(duplicate).some((error) => error.includes('exactly once')));

  const movedBeforeInstall = workflow
    .replace(`${step}\n`, '')
    .replace('      - name: Install dependencies', `${step}\n\n      - name: Install dependencies`);
  assert.notEqual(movedBeforeInstall, workflow, 'the ordering mutation must change the fixture');
  assert.ok(errorsFor(movedBeforeInstall).some((error) => error.includes('after npm ci')));

  for (const extraStepControl of [
    'if: false',
    'continue-on-error: true',
    'shell: bash',
    'run: npm --version',
  ]) {
    const controlledStep = workflow.replace(
      step,
      `${step.split('\n')[0]}\n        ${extraStepControl}\n${step.split('\n')[1]}`,
    );
    assert.notEqual(controlledStep, workflow, `${extraStepControl} must change the fixture`);
    assert.ok(
      errorsFor(controlledStep).some((error) => error.includes('only its reviewed name')),
      `the UI coverage gate must reject ${extraStepControl}`,
    );
  }

  const ignoredFailure = workflow.replace(
    'npm run coverage:ui -- --ci --runInBand',
    'npm run coverage:ui -- --ci --runInBand || true',
  );
  assert.notEqual(ignoredFailure, workflow, 'the ignored-failure mutation must change the fixture');
  assert.ok(errorsFor(ignoredFailure).some((error) => error.includes('must fail the CI job')));

  const extraCommand = workflow.replace(
    'npm run coverage:ui -- --ci --runInBand',
    'npm run coverage:ui -- --ci --runInBand && npm --version',
  );
  assert.notEqual(extraCommand, workflow, 'the extra-command mutation must change the fixture');
  assert.ok(errorsFor(extraCommand).some((error) => error.includes('must run exactly')));
});

test('requires the Android build job', () => {
  const mutated = workflow.replace('\n  android:\n', '\n  android-disabled:\n');
  assert.notEqual(mutated, workflow, 'the Android job mutation must change the fixture');
  assert.ok(errorsFor(mutated).some((error) => error.includes('Android build job')));
});

test('requires a clean Expo Android prebuild', () => {
  const mutated = workflow.replace(
    'expo prebuild --platform android --clean --no-install',
    'expo prebuild --platform android --no-install',
  );
  assert.notEqual(mutated, workflow, 'the Expo prebuild mutation must change the fixture');
  assert.ok(errorsFor(mutated).some((error) => error.includes('clean Expo prebuild')));
});

test('requires the diagnostic guard to rescan generated Android source after prebuild', () => {
  const step = [
    '      - name: Scan generated Android diagnostics',
    '        run: npm run check:error-diagnostics',
  ].join('\n');
  const mutated = workflow.replace(step, `${step.split('\n')[0]}\n        run: node --version`);
  assert.notEqual(
    mutated,
    workflow,
    'the generated diagnostic scan mutation must change the fixture',
  );
  assert.ok(errorsFor(mutated).some((error) => error.includes('generated Android diagnostics')));

  const moved = workflow
    .replace(`${step}\n`, '')
    .replace('      - name: Clean Expo prebuild', `${step}\n\n      - name: Clean Expo prebuild`);
  assert.notEqual(moved, workflow, 'the diagnostic scan ordering mutation must change the fixture');
  assert.ok(errorsFor(moved).some((error) => error.includes('must run after')));
});

test('requires the generated Android diagnostic guard to run unconditionally', () => {
  const stepName = '      - name: Scan generated Android diagnostics';
  for (const neverRunCondition of ['false', "'false'", '${{ false }}', '0']) {
    const mutated = workflow.replace(stepName, `${stepName}\n        if: ${neverRunCondition}`);
    assert.notEqual(
      mutated,
      workflow,
      `the ${neverRunCondition} diagnostic condition mutation must change the fixture`,
    );
    assert.ok(
      errorsFor(mutated).some((error) => error.includes('must run unconditionally')),
      `the diagnostic guard must reject if: ${neverRunCondition}`,
    );
  }
});

test('requires the generated Android diagnostic guard to block the job on failure', () => {
  const stepName = '      - name: Scan generated Android diagnostics';
  for (const ignoredFailure of ['true', '${{ true }}']) {
    const mutated = workflow.replace(
      stepName,
      `${stepName}\n        continue-on-error: ${ignoredFailure}`,
    );
    assert.notEqual(
      mutated,
      workflow,
      `the ${ignoredFailure} continue-on-error mutation must change the fixture`,
    );
    assert.ok(
      errorsFor(mutated).some((error) => error.includes('must fail the Android job')),
      `the diagnostic guard must reject continue-on-error: ${ignoredFailure}`,
    );
  }
});

test('requires the local paste-input Kotlin compile task', () => {
  const mutated = workflow.replace(
    ':gator-paste-input:compileDebugKotlin',
    ':gator-paste-input:tasks',
  );
  assert.notEqual(mutated, workflow, 'the paste-input mutation must change the fixture');
  assert.ok(
    errorsFor(mutated).some((error) => error.includes(':gator-paste-input:compileDebugKotlin')),
  );
});

test('requires the local share-shortcuts Kotlin compile task', () => {
  const mutated = workflow.replace(
    ':gator-share-shortcuts:compileDebugKotlin',
    ':gator-share-shortcuts:tasks',
  );
  assert.notEqual(mutated, workflow, 'the share-shortcuts mutation must change the fixture');
  assert.ok(
    errorsFor(mutated).some((error) => error.includes(':gator-share-shortcuts:compileDebugKotlin')),
  );
});

test('requires the local bounded-download Kotlin compile task', () => {
  const mutated = workflow.replace(
    ':gator-bounded-download:compileDebugKotlin',
    ':gator-bounded-download:tasks',
  );
  assert.notEqual(mutated, workflow, 'the bounded-download mutation must change the fixture');
  assert.ok(
    errorsFor(mutated).some((error) =>
      error.includes(':gator-bounded-download:compileDebugKotlin'),
    ),
  );
});

test('requires the local screen-security Kotlin compile task', () => {
  const mutated = workflow.replace(
    ':gator-screen-security:compileDebugKotlin',
    ':gator-screen-security:tasks',
  );
  assert.notEqual(mutated, workflow, 'the screen-security mutation must change the fixture');
  assert.ok(
    errorsFor(mutated).some((error) => error.includes(':gator-screen-security:compileDebugKotlin')),
  );
});

test('requires the release AAB bundle task', () => {
  const mutated = workflow.replace(':app:bundleRelease', ':app:tasks');
  assert.notEqual(mutated, workflow, 'the bundleRelease mutation must change the fixture');
  assert.ok(errorsFor(mutated).some((error) => error.includes('release AAB in its own')));
});

test('requires debug and release packaging to use separate Gradle invocations', () => {
  const combined = workflow.replace(
    'run: ./gradlew :app:assembleDebug --no-daemon',
    'run: ./gradlew :app:assembleDebug :app:bundleRelease --no-daemon',
  );
  assert.notEqual(combined, workflow, 'the combined-build mutation must change the fixture');
  assert.ok(errorsFor(combined).some((error) => error.includes('debug APK in its own')));

  const missingDebug = workflow.replace(':app:assembleDebug', ':app:tasks');
  assert.ok(errorsFor(missingDebug).some((error) => error.includes('debug APK in its own')));

  const overwriteAfterAssemble = workflow.replace(
    '        run: ./gradlew :app:assembleDebug --no-daemon',
    [
      '        run: |',
      '          ./gradlew :app:assembleDebug --no-daemon',
      "          printf 'unreviewed' > app/build/outputs/apk/debug/app-debug.apk",
    ].join('\n'),
  );
  assert.notEqual(overwriteAfterAssemble, workflow);
  assert.ok(
    errorsFor(overwriteAfterAssemble).some((error) =>
      error.includes('exact reviewed "Assemble debug APK" step'),
    ),
  );

  const extraTailStep = workflow.replace(
    '      - name: Bundle release AAB',
    [
      '      - name: Mutate built APK',
      "        run: printf 'unreviewed' > android/app/build/outputs/apk/debug/app-debug.apk",
      '',
      '      - name: Bundle release AAB',
    ].join('\n'),
  );
  assert.notEqual(extraTailStep, workflow);
  assert.ok(
    errorsFor(extraTailStep).some((error) => error.includes('exact reviewed build, verification')),
  );
});

test('requires the packaged Android artifact guard', () => {
  const mutated = workflow.replace(
    'run: npm run check:android-build',
    'run: npm run check:architecture',
  );
  assert.notEqual(mutated, workflow, 'the Android guard mutation must change the fixture');
  assert.ok(errorsFor(mutated).some((error) => error.includes('npm run check:android-build')));
});

test('rejects either missing high-severity npm audit gate', () => {
  const missingFull = workflow.replace('run: npm audit --audit-level=high', 'run: npm --version');
  assert.ok(errorsFor(missingFull).some((error) => error.includes('Audit clean lockfile')));

  const missingProduction = workflow.replace(
    'run: npm audit --omit=dev --audit-level=high',
    'run: npm --version',
  );
  assert.ok(errorsFor(missingProduction).some((error) => error.includes('Audit production')));
});

test('rejects a non-blocking audit or dependency review outside pull requests', () => {
  const ignoredAudit = workflow.replace(
    'run: npm audit --audit-level=high',
    'continue-on-error: true\n        run: npm audit --audit-level=high',
  );
  assert.ok(errorsFor(ignoredAudit).some((error) => error.includes('must fail the job')));

  const allEvents = workflow.replace("if: github.event_name == 'pull_request'", 'if: always()');
  assert.ok(errorsFor(allEvents).some((error) => error.includes('only for pull_request')));
});

test('requires npm and GitHub Actions Dependabot coverage', () => {
  const missingActions = dependabot.replace(
    'package-ecosystem: github-actions',
    'package-ecosystem: docker',
  );
  assert.ok(
    errorsFor(workflow, missingActions).some((error) =>
      error.includes('github-actions update entry'),
    ),
  );
});
