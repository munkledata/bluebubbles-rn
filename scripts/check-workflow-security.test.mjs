import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validateWorkflowSecurity } from './check-workflow-security.mjs';

const root = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const dependabot = readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8');

function errorsFor(workflowMutation = workflow, dependabotMutation = dependabot) {
  return validateWorkflowSecurity({
    workflow: workflowMutation,
    dependabot: dependabotMutation,
  });
}

test('accepts the repository workflow and Dependabot policy', () => {
  assert.deepEqual(errorsFor(), []);
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
