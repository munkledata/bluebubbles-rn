import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findLocalBranchObjectId } from './release-android.mjs';

function git(cwd, args, { input } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('treats a missing slash-containing release branch as absent and resolves it once created', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Gator Release Test']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial']);

  const branch = 'release/android-9.9.9';
  const head = git(root, ['rev-parse', 'HEAD']);
  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), null);

  git(root, ['update-ref', `refs/heads/${branch}`, head]);
  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), head);
});

test('treats an existing branch ref with a non-commit target as present', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-invalid-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  const branch = 'release/android-invalid';
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: 'not a commit' });
  const looseRefDirectory = join(root, '.git', 'refs', 'heads', 'release');
  mkdirSync(looseRefDirectory, { recursive: true });
  writeFileSync(join(looseRefDirectory, 'android-invalid'), `${blob}\n`);

  assert.equal(findLocalBranchObjectId(branch, { cwd: root }), blob);
});

test('fails closed when Git reports a broken release branch ref', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-release-broken-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '--quiet', '--initial-branch=main']);
  const branch = 'release/android-broken';
  const looseRefDirectory = join(root, '.git', 'refs', 'heads', 'release');
  mkdirSync(looseRefDirectory, { recursive: true });
  writeFileSync(join(looseRefDirectory, 'android-broken'), 'not-an-object-id\n');

  assert.throws(
    () => findLocalBranchObjectId(branch, { cwd: root }),
    /could not determine whether the release branch exists/,
  );
});
