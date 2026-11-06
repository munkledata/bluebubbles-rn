import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_WORKFLOW,
  DEPENDENCY_AUDIT_NAME,
  readWorkflows,
  validateWorkflowSecurity,
} from './check-workflow-security.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflows = readWorkflows(ROOT);
const dependabot = readFileSync(resolve(ROOT, '.github/dependabot.yml'), 'utf8');

/** Errors for the repository's workflows with one file replaced (or Dependabot replaced). */
function errorsWith(file, mutate) {
  const mutated = new Map(workflows);
  if (file === 'dependabot') {
    return validateWorkflowSecurity({ workflows: mutated, dependabot: mutate(dependabot) });
  }
  const original = mutated.get(file);
  const replaced = mutate(original);
  assert.notEqual(replaced, original, `${file}: the mutation must change the fixture`);
  mutated.set(file, replaced);
  return validateWorkflowSecurity({ workflows: mutated, dependabot });
}

function replaceOnce(source, target, replacement) {
  const index = source.indexOf(target);
  assert.ok(index >= 0, `fixture lacks ${JSON.stringify(target)}`);
  return source.slice(0, index) + replacement + source.slice(index + target.length);
}

test('accepts the repository workflows and Dependabot policy', () => {
  assert.ok(workflows.size >= 3, 'expected the CI, Android and drift workflows');
  assert.deepEqual(validateWorkflowSecurity({ workflows, dependabot }), []);
});

test('every action use must be a full commit SHA with a readable version comment', () => {
  const pinned = /uses: actions\/checkout@[a-f0-9]{40} # v\d+\.\d+\.\d+/;
  const ci = workflows.get(CI_WORKFLOW);
  const line = ci.match(pinned)[0];
  const tag = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(s, line, 'uses: actions/checkout@v7 # v7.0.1'),
  );
  assert.ok(
    tag.some((e) => e.includes('full 40-character commit SHA')),
    tag.join('\n'),
  );
  const noComment = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(s, line, line.replace(/ # v.*$/, '')),
  );
  assert.ok(
    noComment.some((e) => e.includes('readable version comment')),
    noComment.join('\n'),
  );
});

test('permissions stay read-only and every workflow declares them at the root', () => {
  const write = errorsWith('android.yml', (s) =>
    replaceOnce(s, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
  );
  assert.ok(
    write.some((e) => e.includes('only "contents: read"')),
    write.join('\n'),
  );
  const noRoot = errorsWith('drift.yml', (s) =>
    replaceOnce(s, 'permissions:\n  contents: read\n', ''),
  );
  assert.ok(
    noRoot.some((e) => e.includes('root permissions block')),
    noRoot.join('\n'),
  );
});

test('rejects pull_request_target and a push workflow without cancelling concurrency', () => {
  const target = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(s, '  pull_request:\n', '  pull_request_target:\n'),
  );
  assert.ok(
    target.some((e) => e.includes('pull_request_target')),
    target.join('\n'),
  );
  const noConcurrency = errorsWith('android.yml', (s) =>
    replaceOnce(s, "  cancel-in-progress: ${{ github.event_name == 'push' }}\n", ''),
  );
  assert.ok(
    noConcurrency.some((e) => e.includes('concurrency group with cancel-in-progress')),
    noConcurrency.join('\n'),
  );
});

test('every checkout must drop its credentials', () => {
  const errors = errorsWith('android.yml', (s) =>
    replaceOnce(s, '          persist-credentials: false\n', ''),
  );
  assert.ok(
    errors.some((e) => e.includes('persist-credentials: false')),
    errors.join('\n'),
  );
});

test('the toolchain guard runs before every npm ci, and the install is unconditional', () => {
  const reordered = errorsWith('drift.yml', (s) =>
    replaceOnce(
      s,
      '      - name: Verify toolchain pins\n        run: node scripts/check-toolchain.mjs\n\n      - name: Install dependencies\n        run: npm ci\n',
      '      - name: Install dependencies\n        run: npm ci\n\n      - name: Verify toolchain pins\n        run: node scripts/check-toolchain.mjs\n',
    ),
  );
  assert.ok(
    reordered.some((e) => e.includes('before npm ci')),
    reordered.join('\n'),
  );
  const conditional = errorsWith('android.yml', (s) =>
    replaceOnce(
      s,
      '      - name: Install dependencies\n        run: npm ci\n',
      "      - name: Install dependencies\n        if: github.event_name == 'push'\n        run: npm ci\n",
    ),
  );
  assert.ok(
    conditional.some((e) => e.includes('unconditionally')),
    conditional.join('\n'),
  );
});

test('ci.yml keeps dependency review, its own guard before install, the history checkout and a blocking last audit', () => {
  const lowered = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(s, 'fail-on-severity: high', 'fail-on-severity: critical'),
  );
  assert.ok(
    lowered.some((e) => e.includes('dependency-review')),
    lowered.join('\n'),
  );
  const noGuard = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(s, '          node scripts/check-workflow-security.mjs\n', ''),
  );
  assert.ok(
    noGuard.some((e) => e.includes("this guard's test and validator")),
    noGuard.join('\n'),
  );
  const shallow = errorsWith(CI_WORKFLOW, (s) => replaceOnce(s, '          fetch-depth: 0\n', ''));
  assert.ok(
    shallow.some((e) => e.includes('fetch-depth: 0')),
    shallow.join('\n'),
  );
  const softAudit = errorsWith(CI_WORKFLOW, (s) =>
    replaceOnce(
      s,
      `      - name: ${DEPENDENCY_AUDIT_NAME}\n`,
      `      - name: ${DEPENDENCY_AUDIT_NAME}\n        continue-on-error: true\n`,
    ),
  );
  assert.ok(
    softAudit.some((e) => e.includes('block on failure')),
    softAudit.join('\n'),
  );
  const notLast = errorsWith(
    CI_WORKFLOW,
    (s) => s + '\n      - name: Afterthought\n        run: echo done\n',
  );
  assert.ok(
    notLast.some((e) => e.includes('last step of the check job')),
    notLast.join('\n'),
  );
});

test('Dependabot must cover npm with exact pins and github-actions', () => {
  const noActions = errorsWith('dependabot', (s) =>
    replaceOnce(s, 'package-ecosystem: github-actions', 'package-ecosystem: docker'),
  );
  assert.ok(
    noActions.some((e) => e.includes('github-actions ecosystem')),
    noActions.join('\n'),
  );
  const strategy = errorsWith('dependabot', (s) =>
    replaceOnce(s, 'versioning-strategy: increase-if-necessary', 'versioning-strategy: increase'),
  );
  assert.ok(
    strategy.some((e) => e.includes('preserve exact pins')),
    strategy.join('\n'),
  );
});
