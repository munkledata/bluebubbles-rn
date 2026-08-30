import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  importSpecifiers,
  runArchitectureBoundaryCheck,
  runCoreBoundaryCheck,
  runServiceBoundaryCheck,
  validateCoreImports,
  validateServiceImports,
  validateSynchronousRuntimeCycles,
  validateUiDbCommands,
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

test('allows reviewed UI DB reads, type-only imports, and a query-only local handle', () => {
  const root = fixture({
    'app/read.ts': `
      import { getDatabase as openDatabase } from '@db/database';
      import {
        DRAFT_KV_PREFIX,
        getChatTheme as readChatTheme,
        type MessageRow,
      } from '@db/repositories';
      import { useReactiveQuery } from '@db/useReactiveQuery';
      import type { DbTransactionContext } from '@db/transaction';

      export async function read(guid: string): Promise<unknown> {
        const db = openDatabase();
        await readChatTheme(db, guid);
        return readChatTheme(openDatabase(), DRAFT_KV_PREFIX + guid);
      }
    `,
  });
  const file = resolve(root, 'app/read.ts');

  try {
    assert.deepEqual(validateUiDbCommands({ root, files: [file] }), []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects UI transaction/mutator imports, re-exports, and runtime loaders', () => {
  const root = fixture({
    'app/commands.ts': `
      import { withDbTransaction } from '@db/transaction';
      import { setChatTheme } from '@db/repositories';
      import {} from '@db/transaction';
      export { setChatPin } from '@/db/repositories';
      const repositories = require('../src/db/repositories');
      export async function loadCommands() { return import('@db/repositories/chats'); }
      export async function unknown(name: string) { return import(name); }
    `,
  });
  const file = resolve(root, 'app/commands.ts');

  try {
    const errors = validateUiDbCommands({ root, files: [file] });
    assert.equal(errors.length, 7);
    assert.ok(errors.some((error) => error.includes('withDbTransaction')));
    assert.ok(errors.some((error) => error.includes('setChatTheme')));
    assert.ok(errors.some((error) => error.includes('re-exports a runtime DB value')));
    assert.ok(errors.some((error) => error.includes('loads a DB module')));
    assert.ok(errors.some((error) => error.includes('non-literal runtime loader')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects a DB handle acquired through a service re-export', () => {
  const root = fixture({
    'app/commands.ts': `
      import { ensureDatabase } from '@/services';
      export async function erase(): Promise<void> {
        const db = await ensureDatabase();
        await db.run('DELETE FROM chats');
      }
    `,
    'src/db/types.ts': `
      export interface AppDatabase { run(sql: string): Promise<void> }
    `,
    'src/services/databaseControl.ts': `
      import type { AppDatabase } from '@/db/types';
      export declare function ensureDatabase(): Promise<AppDatabase>;
    `,
    'src/services/index.ts': `export { ensureDatabase } from './databaseControl';`,
  });
  const file = resolve(root, 'app/commands.ts');

  try {
    const errors = validateUiDbCommands({ root, files: [file] });
    assert.equal(errors.length, 2);
    assert.ok(
      errors.some((error) =>
        error.includes('acquires a database handle outside the reviewed DB read surface'),
      ),
    );
    assert.ok(errors.some((error) => error.includes('database handle escape')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects raw DB handles received as parameters or object properties', () => {
  const root = fixture({
    'app/commands.ts': `
      import type { AppDatabase } from '@/db/types';
      declare function acquireContainer(): { db: AppDatabase };

      export async function eraseParameter(db: AppDatabase): Promise<void> {
        await db.run('DELETE FROM chats');
      }
      export async function eraseGeneric<T extends AppDatabase>(db: T): Promise<void> {
        await db.run('DELETE FROM attachments');
      }
      export async function eraseProperty(): Promise<void> {
        const container = acquireContainer();
        await container.db.run('DELETE FROM messages');
      }
    `,
    'src/db/types.ts': `
      export interface AppDatabase { run(sql: string): Promise<void> }
    `,
  });
  const file = resolve(root, 'app/commands.ts');

  try {
    const errors = validateUiDbCommands({ root, files: [file] });
    assert.equal(errors.length, 3);
    assert.ok(errors.every((error) => error.includes('database handle escape')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects every raw native DB driver runtime load form', () => {
  const root = fixture({
    'src/ui/driver.ts': `
      import { open } from '@op-engineering/op-sqlite';
      import type { DB } from '@op-engineering/op-sqlite';
      export { open as openAgain } from '@op-engineering/op-sqlite';
      const required = require('@op-engineering/op-sqlite');
      export async function load() { return import('@op-engineering/op-sqlite'); }
      export async function injected(db: DB) { await db.execute('DELETE FROM chats'); }
    `,
    'node_modules/@op-engineering/op-sqlite/index.d.ts': `
      export interface DB { execute(sql: string): Promise<void> }
    `,
    'node_modules/@op-engineering/op-sqlite/package.json': `
      { "name": "@op-engineering/op-sqlite", "types": "index.d.ts" }
    `,
  });
  const file = resolve(root, 'src/ui/driver.ts');

  try {
    const errors = validateUiDbCommands({ root, files: [file] });
    assert.equal(errors.length, 5);
    assert.ok(errors.some((error) => error.includes('raw native DB driver')));
    assert.ok(errors.some((error) => error.includes('re-exports a runtime DB value')));
    assert.equal(errors.filter((error) => error.includes('loads a DB module')).length, 2);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('rejects raw UI DB commands, unreviewed handoff, and getDatabase binding escape', () => {
  const root = fixture({
    'src/ui/bad.ts': `
      import { getDatabase as openDatabase } from '@db/database';
      import { getChatTheme } from '@db/repositories';

      function hide(_value: unknown): void {}
      export async function bad(guid: string): Promise<void> {
        const db = openDatabase();
        await db.run('DELETE FROM chats');
        hide(openDatabase());
        hide(openDatabase);
        await getChatTheme(db, guid);
      }
    `,
  });
  const file = resolve(root, 'src/ui/bad.ts');

  try {
    const errors = validateUiDbCommands({ root, files: [file] });
    assert.equal(errors.length, 3);
    assert.ok(errors.some((error) => error.includes('database handle escape')));
    assert.ok(errors.some((error) => error.includes('outside a reviewed query argument')));
    assert.ok(errors.some((error) => error.includes('getDatabase binding escape')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('runtime cycle check ignores erased types and asynchronous import boundaries', () => {
  const root = fixture({
    'src/a.ts': `
      import { value } from './b';
      export async function loadB() { return import('./b'); }
      export const a = value;
    `,
    'src/b.ts': `
      import type { A } from './a';
      export type B = A;
      export const value = 1;
    `,
  });
  const files = [resolve(root, 'src/a.ts'), resolve(root, 'src/b.ts')];

  try {
    assert.deepEqual(validateSynchronousRuntimeCycles({ root, files }), {
      edges: 1,
      errors: [],
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('runtime cycle check rejects relative and aliased synchronous cycles', () => {
  const root = fixture({
    'app/a.ts': `import { b } from '@/cycle/b'; export const a = b;`,
    'src/cycle/b.ts': `export { a as b } from '../../app/a';`,
  });
  const files = [resolve(root, 'app/a.ts'), resolve(root, 'src/cycle/b.ts')];

  try {
    const result = validateSynchronousRuntimeCycles({ root, files });
    assert.equal(result.edges, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /app\/a\.ts -> src\/cycle\/b\.ts -> app\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('runtime cycle check follows TypeScript and Android platform resolution order', () => {
  const root = fixture({
    'app/extension-a.ts': `import { b } from './extension-b'; export const a = b;`,
    'app/extension-b.ts': `import { a } from './extension-a'; export const b = a;`,
    'app/extension-b.tsx': `export const b = 1;`,
    'app/platform-a.ts': `import { b } from './platform-b'; export const a = b;`,
    'app/platform-b.android.ts': `import { a } from './platform-a'; export const b = a;`,
    'app/platform-b.ts': `export const b = 1;`,
  });
  const files = [
    resolve(root, 'app/extension-a.ts'),
    resolve(root, 'app/extension-b.ts'),
    resolve(root, 'app/extension-b.tsx'),
    resolve(root, 'app/platform-a.ts'),
    resolve(root, 'app/platform-b.android.ts'),
    resolve(root, 'app/platform-b.ts'),
  ];

  try {
    const result = validateSynchronousRuntimeCycles({ root, files });
    assert.equal(result.edges, 4);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((error) => error.includes('extension-b.ts')));
    assert.ok(result.errors.some((error) => error.includes('platform-b.android.ts')));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('runtime cycle check fails closed on a non-literal synchronous require', () => {
  const root = fixture({
    'src/load.ts': `export function load(name) { return require(name); }`,
  });
  const file = resolve(root, 'src/load.ts');

  try {
    const result = validateSynchronousRuntimeCycles({ root, files: [file] });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /src\/load\.ts:1 uses a non-literal synchronous require/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the repository satisfies UI DB, cycle, and static headless entry architecture tails', () => {
  const result = runArchitectureBoundaryCheck();
  assert.ok(result.uiDb.files > 0);
  assert.ok(result.cycles.files > 0);
  assert.ok(result.cycles.edges > 0);
  assert.ok(result.headlessEntry.imports > 0);
});
