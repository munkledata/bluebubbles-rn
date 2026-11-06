import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listTrackedMarkdownFiles, validateMarkdownLinks } from './check-docs.mjs';

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
