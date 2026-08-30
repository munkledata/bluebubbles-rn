import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_IMPLEMENTATION_MAPPING_COUNT,
  EXPECTED_IMPLEMENTATION_MAPPING_SHA256,
  EXPECTED_PRIMARY_TASK_COUNT,
  listTrackedMarkdownFiles,
  validateMarkdownLinks,
  validatePlanContract,
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

test('the reviewed plan passes and count or mapping drift fails closed', () => {
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
