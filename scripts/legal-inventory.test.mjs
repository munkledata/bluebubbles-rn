import assert from 'node:assert/strict';
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

test('current repository inventory pins the 14 assets, 12 local components, and SQLCipher notice', () => {
  const { inventory } = buildInventory(ROOT);

  assert.equal(inventory.summary.assetFiles, 14);
  assert.equal(inventory.summary.localComponents, 12);
  assert.equal(inventory.summary.pendingAssetProvenance, 14);
  assert.equal(inventory.coverage.exactAab, false);
  assert.deepEqual(inventory.inventoryIssues, []);
  const opSqlite = inventory.productionPackages.find(
    (item) => item.installPath === 'node_modules/@op-engineering/op-sqlite',
  );
  assert.ok(opSqlite.legalDocuments.some((item) => item.path === 'cpp/sqlcipher/LICENSE.txt'));
  assert.ok(inventory.legalTexts.every((item) => typeof item.text === 'string'));
});
