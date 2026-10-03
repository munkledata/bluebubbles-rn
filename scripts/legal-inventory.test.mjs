import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { isLegalFileName } from './legal-file-name.mjs';
import {
  buildInventory,
  collectAssetsAndComponents,
  collectProductionPackages,
  markdownToPlainText,
  releaseCheckErrors,
} from './legal-inventory.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('legal filename matching includes notices but excludes third-party source files', () => {
  for (const name of [
    'LICENSE',
    'LICENSE.txt',
    'LICENCE.md',
    'COPYING',
    'COPYING.LESSER',
    'NOTICE',
    'NOTICE.md',
    'ThirdPartyNoticeText.txt',
    'standalone.js.LICENSE.txt',
  ]) {
    assert.equal(isLegalFileName(name), true, name);
  }
  for (const name of [
    'third-party-web.js',
    'third-party.xcconfig',
    'thirdPartyModules.js',
    'foo.LICENSE.txt.js',
  ]) {
    assert.equal(isLegalFileName(name), false, name);
  }
});

function directory(path) {
  mkdirSync(path, { recursive: true });
}

function packageAt(root, installPath, name, version, legalFiles = {}) {
  const target = join(root, installPath);
  directory(target);
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  for (const [path, source] of Object.entries(legalFiles)) {
    directory(join(target, path, '..'));
    writeFileSync(join(target, path), source);
  }
}

test('production closure includes optional and nested packages and finds vendored legal texts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-legal-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  packageAt(root, 'node_modules/runtime', 'runtime', '1.0.0', {
    LICENSE: 'shared license\n',
    'cpp/sqlcipher/LICENSE.txt': 'sqlcipher license\n',
  });
  packageAt(root, 'node_modules/@scope/choice', '@scope/choice', '2.0.0', {
    NOTICE: 'shared license\n',
  });
  packageAt(root, 'node_modules/parent/node_modules/child', 'child', '3.0.0', {
    COPYING: 'child license\n',
  });
  directory(join(root, 'node_modules/runtime/vendor'));
  writeFileSync(join(root, 'outside-notice'), 'must not be read\n');
  symlinkSync(join(root, 'outside-notice'), join(root, 'node_modules/runtime/vendor/NOTICE.link'));

  const lock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/runtime': {
        version: '1.0.0',
        license: 'MIT',
        resolved: 'https://example/runtime.tgz',
        integrity: 'sha512-runtime',
      },
      'node_modules/dev-only': { version: '1.0.0', dev: true, license: 'MIT' },
      'node_modules/optional': {
        version: '1.0.0',
        optional: true,
        license: 'MIT',
        resolved: 'https://example/optional.tgz',
        integrity: 'sha512-optional',
      },
      'node_modules/@scope/choice': {
        version: '2.0.0',
        license: 'MIT OR Apache-2.0',
        resolved: 'https://example/choice.tgz',
        integrity: 'sha512-choice',
      },
      'node_modules/parent/node_modules/child': {
        version: '3.0.0',
        resolved: 'https://example/child.tgz',
        integrity: 'sha512-child',
      },
    },
  };
  const result = collectProductionPackages(root, lock);

  assert.deepEqual(
    result.records.map((item) => item.name),
    ['@scope/choice', 'optional', 'child', 'runtime'],
  );
  assert.equal(result.records.find((item) => item.name === 'optional').optional, true);
  assert.ok(
    result.records
      .find((item) => item.name === '@scope/choice')
      .issues.includes('license choice requires review'),
  );
  assert.ok(
    result.records
      .find((item) => item.name === 'child')
      .issues.includes('lockfile license is missing'),
  );
  const runtime = result.records.find((item) => item.name === 'runtime');
  assert.ok(runtime.legalDocuments.some((item) => item.path === 'cpp/sqlcipher/LICENSE.txt'));
  assert.ok(runtime.issues.some((issue) => issue.includes('symbolic link skipped')));
  assert.equal(
    result.legalTexts.find((item) => item.text === 'shared license\n').sources.length,
    2,
  );
});

test('asset and local-component reconciliation is bidirectional and never follows symlinks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-legal-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'assets/icon.png',
    'store-assets/feature.png',
    'modules/gator-one/source.kt',
    'plugins/active.js',
    'plugins/new.js',
  ]) {
    directory(join(root, path, '..'));
    writeFileSync(join(root, path), path);
  }
  writeFileSync(join(root, 'outside.png'), 'outside');
  symlinkSync(join(root, 'outside.png'), join(root, 'assets/link.png'));
  const tracked = [
    'assets/icon.png',
    'assets/link.png',
    'store-assets/feature.png',
    'modules/gator-one/source.kt',
    'plugins/active.js',
    'plugins/new.js',
  ];
  const provenance = {
    assets: [
      { path: 'assets/icon.png', provenanceStatus: 'approved' },
      { path: 'assets/old.png', provenanceStatus: 'unresolved' },
    ],
    localComponents: [
      { path: 'modules/gator-one', provenanceStatus: 'approved' },
      { path: 'plugins/active.js', provenanceStatus: 'approved' },
      { path: 'plugins/stale.js', provenanceStatus: 'unresolved' },
    ],
  };
  const result = collectAssetsAndComponents(root, provenance, tracked);

  assert.equal(
    result.assets.find((item) => item.path === 'store-assets/feature.png').provenanceStatus,
    'missing',
  );
  assert.match(
    result.assets.find((item) => item.path === 'assets/link.png').issue,
    /symbolic link/,
  );
  assert.deepEqual(result.staleAssets, ['assets/old.png']);
  assert.equal(
    result.localComponents.find((item) => item.path === 'plugins/new.js').provenanceStatus,
    'missing',
  );
  assert.deepEqual(result.staleComponents, ['plugins/stale.js']);
  assert.throws(
    () => collectAssetsAndComponents(root, { assets: [{ path: '../escape.png' }] }, tracked),
    /escapes root/,
  );
});

test('runtime notice conversion is plain text and release checking preserves open gates', () => {
  assert.equal(
    markdownToPlainText('# Notices\n\n> [`License`](./LICENSE) and **review**\n'),
    'Notices\n\nLicense and review\n',
  );
  assert.deepEqual(
    releaseCheckErrors({
      coverage: { exactAab: false },
      summary: { unresolvedPackageRecords: 2, pendingAssetProvenance: 1 },
      localComponents: [{ provenanceStatus: 'unresolved', issue: null }],
      inventoryIssues: ['missing asset provenance: assets/new.png'],
    }),
    [
      'exact AAB dependency/font/model/native-library coverage is absent',
      '2 package records need review',
      '1 assets have unresolved provenance',
      '1 local components have unresolved provenance',
      'missing asset provenance: assets/new.png',
    ],
  );
});

test('checkout discovery includes untracked source but excludes ignored output and preserves deletion/symlink failures', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gator-legal-checkout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const write = (path, source = path) => {
    directory(join(root, path, '..'));
    writeFileSync(join(root, path), source);
  };
  git('init', '--quiet');
  write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
  write('LICENSE', 'private project');
  write('THIRD_PARTY_NOTICES.md', 'third-party notices');
  write('.gitignore', 'node_modules/\n.env\nplugins/ignored.js\nmodules/*/android/build/\n');
  const provenance = {
    assets: [{ path: 'assets/tracked.png', provenanceStatus: 'unresolved' }],
    localComponents: [
      { path: 'plugins/tracked.js', provenanceStatus: 'unresolved' },
      { path: 'plugins/staged-delete.js', provenanceStatus: 'unresolved' },
    ],
  };
  write('legal/asset-provenance.json', JSON.stringify(provenance));
  const tracked = [
    'assets/tracked.png',
    'modules/gator-one/source.kt',
    'plugins/tracked.js',
    'plugins/staged-delete.js',
    'plugins/index-removed.js',
    'plugins/missing.js',
  ];
  for (const path of tracked) write(path);
  git('add', '--', ...tracked);
  git('rm', '--quiet', '--force', '--', 'plugins/staged-delete.js');
  git('rm', '--quiet', '--cached', '--', 'plugins/index-removed.js');
  rmSync(join(root, 'plugins/missing.js'));
  for (const path of [
    'assets/new.png',
    'store-assets/new.png',
    'modules/gator-one/added.kt',
    'modules/gator-one/android/build/generated.kt',
    'modules/gator-one/node_modules/private-package/source.js',
    'modules/gator-one/.env',
    'plugins/active-untracked.js',
    'plugins/ignored.js',
    'unrelated/private.js',
  ])
    write(path);
  write('outside.js', 'must not be read');
  symlinkSync(join(root, 'outside.js'), join(root, 'plugins/link.js'));
  directory(join(root, 'outside-module'));
  write('outside-module/secret.kt', 'must not be read');
  symlinkSync(join(root, 'outside-module'), join(root, 'modules/gator-link'), 'dir');

  const { inventory } = buildInventory(root);
  assert.deepEqual(
    inventory.assets.map((item) => item.path),
    ['assets/new.png', 'assets/tracked.png', 'store-assets/new.png'],
  );
  assert.deepEqual(
    inventory.localComponents.map((item) => item.path),
    [
      'modules/gator-link',
      'modules/gator-one',
      'plugins/active-untracked.js',
      'plugins/index-removed.js',
      'plugins/link.js',
      'plugins/missing.js',
      'plugins/tracked.js',
    ],
  );
  assert.equal(
    inventory.localComponents.find((item) => item.path === 'modules/gator-one').files,
    2,
  );
  assert.equal(
    inventory.localComponents.find((item) => item.path === 'plugins/tracked.js').files,
    1,
  );
  assert.ok(
    inventory.inventoryIssues.includes(
      'stale local-component provenance: plugins/staged-delete.js',
    ),
  );
  for (const path of ['modules/gator-link', 'plugins/link.js', 'plugins/missing.js']) {
    assert.ok(inventory.inventoryIssues.includes(`unreadable local component: ${path}`));
  }
  assert.ok(
    inventory.inventoryIssues.includes(
      'missing local-component provenance: plugins/active-untracked.js',
    ),
  );
  assert.deepEqual(buildInventory(root).inventory, inventory, 'discovery must be deterministic');

  const duplicates = ['modules/gator-one/source.kt', 'assets/tracked.png', 'plugins/tracked.js'];
  assert.deepEqual(
    collectAssetsAndComponents(root, provenance, [...duplicates, ...duplicates].reverse()),
    collectAssetsAndComponents(root, provenance, duplicates),
    'duplicate or reordered discovery records must not change hashes or counts',
  );
});

test('current repository inventory pins the 14 assets, 13 local components, and SQLCipher notice', () => {
  const { inventory } = buildInventory(ROOT);

  assert.equal(inventory.summary.assetFiles, 14);
  assert.equal(inventory.summary.localComponents, 13);
  assert.equal(inventory.summary.pendingAssetProvenance, 14);
  assert.equal(inventory.coverage.exactAab, false);
  assert.deepEqual(inventory.inventoryIssues, []);
  const opSqlite = inventory.productionPackages.find(
    (item) => item.installPath === 'node_modules/@op-engineering/op-sqlite',
  );
  assert.ok(opSqlite.legalDocuments.some((item) => item.path === 'cpp/sqlcipher/LICENSE.txt'));
  assert.ok(inventory.legalTexts.every((item) => typeof item.text === 'string'));
});
