import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_COMBINED_TASK_COUNT,
  EXPECTED_IMPLEMENTATION_MAPPING_COUNT,
  EXPECTED_IMPLEMENTATION_MAPPING_SHA256,
  EXPECTED_PRIMARY_TASK_COUNT,
  EXPECTED_RELEASE_IMPLEMENTATION_MAPPING_COUNT,
  EXPECTED_RELEASE_MAPPING_SHA256,
  EXPECTED_RELEASE_TASK_COUNT,
  listTrackedMarkdownFiles,
  validateMarkdownLinks,
  validatePlanContract,
  validatePlanSeparation,
  validateReleasePlanContract,
} from './check-docs.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROTECTED_UNTRACKED_AUDIT = 'docs/POST_REMEDIATION_FEATURE_AUDIT_2026-08-26.md';

test('discovers only tracked Markdown and excludes the protected untracked audit', () => {
  const files = listTrackedMarkdownFiles(ROOT);

  assert.ok(files.includes('AGENTS.md'));
  assert.equal(files.includes(PROTECTED_UNTRACKED_AUDIT), false);
});

test('local-link validation rejects missing and case-mismatched paths', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-doc-check-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'Target.md'), '# Target\n');
  writeFileSync(
    join(root, 'Source.md'),
    '[valid](./Target.md) [wrong case](./target.md) [missing](./Missing.md) [external](https://example.com)\n\n[reference]: ./Target.md\n',
  );

  const result = validateMarkdownLinks({ root, markdownFiles: ['Source.md'] });

  assert.equal(result.linkCount, 4);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes('incorrect casing')));
  assert.ok(result.errors.some((error) => error.includes('does not exist')));
});

test('the reviewed remediation plan passes and count or mapping drift fails closed', () => {
  const planPath = join(ROOT, 'docs/WORK_PLAN_2026-08-03.md');
  const planSource = readFileSync(planPath, 'utf8');
  const current = validatePlanContract({ root: ROOT, planSource });

  assert.deepEqual(current.errors, []);
  assert.equal(current.primaryTaskCount, EXPECTED_PRIMARY_TASK_COUNT);
  assert.equal(current.mappingCount, EXPECTED_IMPLEMENTATION_MAPPING_COUNT);
  assert.equal(current.mappingSha256, EXPECTED_IMPLEMENTATION_MAPPING_SHA256);

  const doneDeclaration = /\*\*DONE — (\d+):\*\*/.exec(planSource);
  assert.ok(doneDeclaration);
  const wrongDoneCount = Number(doneDeclaration[1]) + 1;
  const wrongCount = validatePlanContract({
    root: ROOT,
    planSource: planSource.replace(doneDeclaration[0], `**DONE — ${wrongDoneCount}:**`),
  });
  assert.ok(
    wrongCount.errors.some((error) => error.includes(`DONE declares ${wrongDoneCount} tasks`)),
  );

  const wrongCheckbox = validatePlanContract({
    root: ROOT,
    planSource: planSource.replace('### [x] `BASE-01`', '### [ ] `BASE-01`'),
  });
  assert.ok(
    wrongCheckbox.errors.some((error) => error.includes('BASE-01 checkbox does not agree')),
  );

  const wrongMapping = validatePlanContract({
    root: ROOT,
    planSource: planSource.replace(
      './workstreams/A_BASELINE_AND_CONTAINMENT.md#base-01',
      './workstreams/A_BASELINE_AND_CONTAINMENT.md#base-01-drift',
    ),
  });
  assert.ok(wrongMapping.errors.some((error) => error.includes('mapping checksum')));
  assert.ok(wrongMapping.errors.some((error) => error.includes('has no explicit #base-01-drift')));
});

test('the release plan has exactly four owned tasks and fails closed on drift', () => {
  const releasePlanPath = join(ROOT, 'docs/RELEASE_PLAN.md');
  const releasePlanSource = readFileSync(releasePlanPath, 'utf8');
  const current = validateReleasePlanContract({ root: ROOT, planSource: releasePlanSource });

  assert.deepEqual(current.errors, []);
  assert.equal(current.primaryTaskCount, EXPECTED_RELEASE_TASK_COUNT);
  assert.equal(current.mappingCount, EXPECTED_RELEASE_IMPLEMENTATION_MAPPING_COUNT);
  assert.equal(current.mappingSha256, EXPECTED_RELEASE_MAPPING_SHA256);

  const wrongCount = validateReleasePlanContract({
    root: ROOT,
    planSource: releasePlanSource.replace('**DONE — 1:**', '**DONE — 2:**'),
  });
  assert.ok(wrongCount.errors.some((error) => error.includes('DONE declares 2 tasks')));

  const wrongCheckbox = validateReleasePlanContract({
    root: ROOT,
    planSource: releasePlanSource.replace('### [x] `RELEASE-01`', '### [ ] `RELEASE-01`'),
  });
  assert.ok(
    wrongCheckbox.errors.some((error) => error.includes('RELEASE-01 checkbox does not agree')),
  );

  const wrongId = validateReleasePlanContract({
    root: ROOT,
    planSource: releasePlanSource.replaceAll('`STORE-01`', '`STORE-99`'),
  });
  assert.ok(wrongId.errors.some((error) => error.includes('release plan task ids are')));

  const wrongMapping = validateReleasePlanContract({
    root: ROOT,
    planSource: releasePlanSource.replace(
      './workstreams/M_CANDIDATE_AND_RELEASE.md#release-02',
      './workstreams/M_CANDIDATE_AND_RELEASE.md#release-02-drift',
    ),
  });
  assert.ok(wrongMapping.errors.some((error) => error.includes('mapping checksum')));
  assert.ok(
    wrongMapping.errors.some((error) => error.includes('has no explicit #release-02-drift')),
  );
});

test('remediation and release plans cannot overlap or change the combined count', () => {
  const remediationSource = readFileSync(join(ROOT, 'docs/WORK_PLAN_2026-08-03.md'), 'utf8');
  const releaseSource = readFileSync(join(ROOT, 'docs/RELEASE_PLAN.md'), 'utf8');
  const remediation = validatePlanContract({ root: ROOT, planSource: remediationSource });
  const release = validateReleasePlanContract({ root: ROOT, planSource: releaseSource });

  assert.equal(remediation.taskIds.length + release.taskIds.length, EXPECTED_COMBINED_TASK_COUNT);
  assert.deepEqual(
    validatePlanSeparation({
      remediationTaskIds: remediation.taskIds,
      releaseTaskIds: release.taskIds,
    }),
    [],
  );

  const overlap = validatePlanSeparation({
    remediationTaskIds: [...remediation.taskIds, release.taskIds[0]],
    releaseTaskIds: release.taskIds,
  });
  assert.ok(overlap.some((error) => error.includes('appear in both plans')));

  const missing = validatePlanSeparation({
    remediationTaskIds: remediation.taskIds.slice(1),
    releaseTaskIds: release.taskIds,
  });
  assert.ok(missing.some((error) => error.includes('combined plans have')));
});
