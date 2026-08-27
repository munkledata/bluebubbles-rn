import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  importSpecifiers,
  runCoreBoundaryCheck,
  runServiceBoundaryCheck,
  validateCoreImports,
  validateServiceImports,
} from './check-core-boundaries.mjs';

function fixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'gator-core-boundary-'));
  for (const [path, source] of Object.entries(files)) {
    const destination = resolve(root, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, source);
  }
  return root;
}

test('extracts static, exported, required, and dynamic module specifiers', () => {
  const specifiers = importSpecifiers(`
    import { z } from 'zod/v4';
    export { thing } from './thing';
    const value = require('ky');
    async function load() { return import('@core/models'); }
  `);

  assert.deepEqual(specifiers, ['zod/v4', './thing', 'ky', '@core/models']);
});

test('accepts Node-compatible packages and imports that stay inside core', () => {
  const root = fixture({
    'src/core/example.ts': `
      import ky from 'ky';
      import { bytes } from '@utils/bytes';
      import { model } from './model';
      export { z } from 'zod/v4';
    `,
    'src/core/model.ts': 'export const model = true;',
  });

  try {
    assert.deepEqual(runCoreBoundaryCheck({ root }), { files: 2 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects platform packages, cross-layer aliases, and relative escapes', () => {
  const root = fixture({
    'src/core/nested/example.ts': `
      import React from 'react';
      export { db } from '@db/database';
      import { boot } from '@/services/bootstrap';
      const crypto = require('expo-crypto');
      async function load() { return import('../../native/crypto'); }
    `,
  });
  const file = resolve(root, 'src/core/nested/example.ts');

  try {
    const errors = validateCoreImports({ root, files: [file] });
    assert.equal(errors.length, 5);
    assert.ok(errors.some((error) => error.includes('"react"')));
    assert.ok(errors.some((error) => error.includes('"@db/database"')));
    assert.ok(errors.some((error) => error.includes('"@/services/bootstrap"')));
    assert.ok(errors.some((error) => error.includes('"expo-crypto"')));
    assert.ok(errors.some((error) => error.includes('"../../native/crypto"')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects a non-literal dynamic import because its boundary cannot be checked', () => {
  const root = fixture({
    'src/core/example.ts': `
      export async function load(name: string) { return import(name); }
    `,
  });

  try {
    assert.throws(() => runCoreBoundaryCheck({ root }), /uses a non-literal require\/import/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the repository core currently satisfies the boundary', () => {
  const result = runCoreBoundaryCheck();
  assert.ok(result.files > 0);
});

test('rejects every service-to-UI import form and non-literal loading', () => {
  const root = fixture({
    'src/services/nested/example.ts': `
      import { Toast } from '@ui';
      export { Dialog } from '@/ui/dialog';
      const store = require('@ui/toast/toastStore');
      async function load() { return import('../../ui/theme'); }
      async function unknown(name: string) { return import(name); }
    `,
  });
  const file = resolve(root, 'src/services/nested/example.ts');

  try {
    const errors = validateServiceImports({ root, files: [file] });
    assert.equal(errors.length, 5);
    assert.ok(errors.some((error) => error.includes('"@ui"')));
    assert.ok(errors.some((error) => error.includes('"@/ui/dialog"')));
    assert.ok(errors.some((error) => error.includes('"@ui/toast/toastStore"')));
    assert.ok(errors.some((error) => error.includes('"../../ui/theme"')));
    assert.ok(errors.some((error) => error.includes('non-literal require/import')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the repository services currently satisfy the UI boundary', () => {
  const result = runServiceBoundaryCheck();
  assert.ok(result.files > 0);
});
