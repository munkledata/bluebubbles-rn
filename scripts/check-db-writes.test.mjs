import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifySqlOperation,
  createInventorySkeleton,
  parseDbWriteCliArgs,
  reconcileDbWriteInventory,
  scanDbWrites,
  scanDbWritesInSource,
  scanNativeDbWritesInSource,
  validateDbWriteInventory,
  writeDbWriteInventoryAtomically,
} from './check-db-writes.mjs';

const DB_WRITE_SCANNER_CLI = fileURLToPath(new URL('./check-db-writes.mjs', import.meta.url));
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fullOnlyTest = process.env.DB_WRITE_SCANNER_FULL === '1' ? test : test.skip;
let cachedProjectFindings;

function scanProjectDbWrites() {
  cachedProjectFindings ??= scanDbWrites({ root: PROJECT_ROOT });
  return cachedProjectFindings;
}

function fixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'gator-db-writes-'));
  for (const [path, source] of Object.entries(files)) {
    const destination = resolve(root, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, source);
  }
  return root;
}

function incomingIngressFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'gator-incoming-ingress-'));
  cpSync(resolve(PROJECT_ROOT, 'src'), resolve(root, 'src'), { recursive: true });
  cpSync(resolve(PROJECT_ROOT, 'app'), resolve(root, 'app'), { recursive: true });
  cpSync(resolve(PROJECT_ROOT, 'index.js'), resolve(root, 'index.js'));
  cpSync(resolve(PROJECT_ROOT, 'package.json'), resolve(root, 'package.json'));
  symlinkSync(resolve(PROJECT_ROOT, 'node_modules'), resolve(root, 'node_modules'), 'dir');
  writeFileSync(
    resolve(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        baseUrl: '.',
        jsx: 'react-jsx',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        paths: {
          '@/*': ['./src/*'],
          '@core': ['./src/core/index.ts'],
          '@core/*': ['./src/core/*'],
          '@db': ['./src/db/schema.ts'],
          '@db/*': ['./src/db/*'],
          '@features/*': ['./src/features/*'],
          '@native/*': ['./src/native/*'],
          '@state/*': ['./src/state/*'],
          '@ui': ['./src/ui/index.ts'],
          '@ui/*': ['./src/ui/*'],
          '@utils': ['./src/utils/index.ts'],
          '@utils/*': ['./src/utils/*'],
        },
      },
      include: ['src', 'app'],
    }),
  );
  return root;
}

function replaceFixtureSource(root, path, before, after) {
  const file = resolve(root, path);
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes(before), `mutation source not found in ${path}`);
  writeFileSync(file, source.replace(before, after));
}

test('classifies mutating SQL, transaction control, CTE writes, and reads', () => {
  assert.equal(classifySqlOperation('INSERT INTO t VALUES (1)'), 'sql-insert');
  assert.equal(classifySqlOperation('UPDATE t SET v = 1'), 'sql-update');
  assert.equal(classifySqlOperation('DELETE FROM t'), 'sql-delete');
  assert.equal(classifySqlOperation("PRAGMA rekey = 'abc'"), 'sql-pragma');
  assert.equal(classifySqlOperation('BEGIN IMMEDIATE'), 'transaction-begin');
  assert.equal(classifySqlOperation('COMMIT'), 'transaction-commit');
  assert.equal(classifySqlOperation('ROLLBACK'), 'transaction-rollback');
  assert.equal(
    classifySqlOperation(
      'WITH candidates AS (SELECT id FROM t) DELETE FROM t WHERE id IN candidates',
    ),
    'sql-delete',
  );
  assert.equal(classifySqlOperation('SELECT * FROM t'), undefined);
});

test('finds aliased Drizzle builders and static, computed, or dynamic raw database writes', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages as messageRows, outgoingQueue } from '@db/schema';
      import { sql as statement } from 'drizzle-orm';
      export async function persist(db: AppDatabase, raw: RawDb, statement: string) {
        await db.insert(messageRows).values({ guid: 'm1' });
        await db.update(messageRows).set({ text: 'new' });
        await db.delete(outgoingQueue);
        await db['all'](statement\`UPDATE messages SET text = \${'new'} RETURNING id\`);
        await raw.execute('PRAGMA foreign_keys = ON');
        await raw.execute(statement);
      }
    `,
    'src/services/persist.ts',
  );

  assert.deepEqual(
    findings.map((finding) => finding.operation),
    [
      'drizzle-insert',
      'drizzle-update',
      'drizzle-delete',
      'sql-update',
      'sql-pragma',
      'raw-dynamic',
    ],
  );
  assert.ok(findings.every((finding) => finding.symbol === 'persist'));
  assert.deepEqual(
    findings.map((finding) => finding.target),
    ['messages', 'messages', 'outgoingQueue', 'messages', 'foreign_keys', '<dynamic>'],
  );
  assert.equal(new Set(findings.map((finding) => finding.id)).size, findings.length);
});

test('fails closed on dynamic tables, computed methods, extracted methods, and unknown DB APIs', () => {
  const findings = scanDbWritesInSource(
    `
      export async function evasions(db, table, method, statement) {
        await db.insert(table).values({});
        await db[method](statement);
        const { run } = db;
        const execute = db.execute;
        await db.writeBatch(statement);
      }
    `,
    'src/services/evasions.ts',
  );
  assert.deepEqual(
    findings.map((finding) => finding.operation),
    [
      'drizzle-insert',
      'unknown-database-method',
      'extracted-database-method',
      'extracted-database-method',
      'unknown-database-method',
    ],
  );
  assert.ok(findings.every((finding) => finding.detectedContext === 'unresolved'));
});

test('finds public Drizzle client exposure and raw-driver method escapes', () => {
  const findings = scanDbWritesInSource(
    `
      export function bypass(db, statement) {
        const publicClient = db.$client;
        const sessionClient = db.session.client;
        const invoke = publicClient.executeAsync;
        return invoke(statement);
      }
    `,
    'src/services/driverClientBypass.ts',
  );

  assert.deepEqual(
    findings.map(({ operation, target }) => ({ operation, target })),
    [
      { operation: 'database-client-escape', target: '<driver-client:$client>' },
      { operation: 'database-client-escape', target: '<driver-client:session.client>' },
      { operation: 'extracted-database-method', target: '<method:executeAsync>' },
    ],
  );
  assert.ok(findings.every((finding) => finding.detectedContext === 'unresolved'));
});

test('keeps escaped database capabilities unresolved inside a transaction owner', () => {
  const findings = scanDbWritesInSource(
    `
      import { withDbTransaction } from '@db/transaction';
      export function leak(db, statement) {
        return withDbTransaction(db, async () => {
          const client = db.$client;
          const invoke = client.executeAsync;
          await invoke(statement);
        });
      }
    `,
    'src/services/driverClientLeak.ts',
  );

  const capabilityFindings = findings.filter(
    (finding) =>
      finding.operation === 'database-client-escape' ||
      finding.operation === 'extracted-database-method',
  );
  assert.equal(capabilityFindings.length, 2);
  assert.ok(capabilityFindings.every((finding) => finding.detectedContext === 'unresolved'));
});

test('records lexical coordinator context without approving the disposition', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      import { withDbTransaction as transact } from '@db/transaction';
      export function safe(db) {
        return transact(db, async () => db.delete(messages));
      }
    `,
    'src/services/safe.ts',
  );
  assert.equal(findings[0]?.detectedContext, 'withDbTransaction');
  const inventory = createInventorySkeleton(findings);
  assert.equal(inventory.entries[0]?.disposition, 'unproven');

  const eager = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      import { withDbTransaction } from '@db/transaction';
      export function unsafe(db) {
        return withDbTransaction(db, db.delete(messages));
      }
    `,
    'src/services/unsafe.ts',
  );
  assert.equal(eager[0]?.detectedContext, 'unresolved');
});

test('does not inherit transaction context through an intervening callback boundary', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      import { withDbTransaction } from '@db/transaction';
      export function delayed(db) {
        return withDbTransaction(db, async () => {
          setTimeout(() => db.delete(messages), 0);
          Promise.resolve().then(() => db.update(messages).set({ text: 'late' }));
        });
      }
    `,
    'src/services/delayed.ts',
  );

  assert.deepEqual(
    findings.map(({ operation, detectedContext }) => ({ operation, detectedContext })),
    [
      { operation: 'drizzle-delete', detectedContext: 'unresolved' },
      { operation: 'drizzle-update', detectedContext: 'unresolved' },
    ],
  );
});

test('keeps direct transaction callback work in coordinator context', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      import { withDbTransaction } from '@db/transaction';
      export function immediate(db) {
        return withDbTransaction(db, async () => {
          await db.delete(messages);
        });
      }
    `,
    'src/services/immediate.ts',
  );

  assert.equal(findings[0]?.detectedContext, 'withDbTransaction');
});

test('recognizes only an awaited or returned exact imported transaction-context join body', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export type DbTransactionContext = object;
      export function runInTransactionContext(context, callback) { return callback(context.db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/owned.ts': `
      import { messages } from '../db/schema';
      import { writeRows } from '../db/repositories/writer';
      import { runInTransactionContext as joinTransaction } from '../db/transaction';
      export function owned(context) {
        return joinTransaction(context, async db => {
          await db.update(messages).set({ text: 'owned' });
          await writeRows(db);
        });
      }
      export async function awaited(context) {
        await joinTransaction(context, async db => {
          await db.insert(messages).values({ text: 'awaited' });
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/owned.ts' &&
          finding.operation === 'drizzle-update' &&
          finding.detectedContext === 'withDbTransaction',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/owned.ts' &&
          finding.operation === 'drizzle-insert' &&
          finding.detectedContext === 'withDbTransaction',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/owned.ts' &&
          finding.target.endsWith('src/db/repositories/writer.ts#writeRows') &&
          finding.detectedContext === 'withDbTransaction',
      ),
    );
    assert.ok(
      findings.every(
        (finding) => !finding.target.endsWith('src/db/transaction.ts#runInTransactionContext'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails transaction-context joins closed when unawaited, named, lookalike, or dynamic', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function runInTransactionContext(context, callback) { return callback(context.db); }
    `,
    'src/services/lookalike.ts': `
      export function runInTransactionContext(context, callback) { return callback(context.db); }
    `,
    'src/services/unsafe.ts': `
      import { messages } from '../db/schema';
      import { runInTransactionContext as joinTransaction } from '../db/transaction';
      import { runInTransactionContext as fakeJoin } from './lookalike';
      import * as Transaction from '../db/transaction';
      export async function unawaited(context) {
        joinTransaction(context, async db => db.delete(messages));
      }
      export function named(context) {
        const body = async db => db.delete(messages);
        return joinTransaction(context, body);
      }
      export function lookalike(context) {
        return fakeJoin(context, async db => db.delete(messages));
      }
      export function namespace(context) {
        return Transaction.runInTransactionContext(
          context,
          async db => db.delete(messages),
        );
      }
      export function dynamic(context, name) {
        return Transaction[name](context, async db => db.delete(messages));
      }
      export function overridden(context) {
        try {
          return joinTransaction(context, async db => db.delete(messages));
        } finally {
          return Promise.resolve();
        }
      }
      export function mismatched(context, otherDb) {
        return joinTransaction(context, async db => otherDb.delete(messages));
      }
      export function captured(context, raw) {
        return joinTransaction(context, async db => {
          await raw.execute('UPDATE messages SET text = NULL');
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root }).filter(
      (finding) =>
        finding.path === 'src/services/unsafe.ts' && finding.operation === 'drizzle-delete',
    );
    assert.equal(findings.length, 7);
    assert.ok(findings.every((finding) => finding.detectedContext === 'unresolved'));
    assert.equal(
      scanDbWrites({ root }).find(
        (finding) => finding.symbol === 'captured' && finding.operation === 'sql-update',
      )?.detectedContext,
      'unresolved',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps raw-database work in nested callbacks outside the joined transaction body', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function runInTransactionContext(context, callback) { return callback(context.db); }
    `,
    'src/services/escape.ts': `
      import { messages } from '../db/schema';
      import { runInTransactionContext } from '../db/transaction';
      export function escape(context) {
        return runInTransactionContext(context, async db => {
          await db.delete(messages);
          setTimeout(() => db.update(messages).set({ text: 'late' }), 0);
          Promise.resolve().then(() => db.insert(messages).values({ text: 'later' }));
          return () => db.delete(messages);
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root }).filter(
      (finding) => finding.path === 'src/services/escape.ts',
    );
    assert.equal(
      findings.filter((finding) => finding.detectedContext === 'withDbTransaction').length,
      1,
    );
    assert.equal(findings.filter((finding) => finding.detectedContext === 'unresolved').length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flags direct and transitive coordinators nested inside a transaction-context join', () => {
  const root = fixture({
    'src/db/transaction.ts': `
      export function runInTransactionContext(context, callback) { return callback(context.db); }
      export function withDbTransaction(db, callback) { return callback(); }
      export function withDbWriteLock(callback) { return callback(); }
    `,
    'src/db/repositories/writer.ts': `
      import { withDbTransaction } from '../transaction';
      export function selfTransacting(db) {
        return withDbTransaction(db, async () => undefined);
      }
    `,
    'src/services/nested.ts': `
      import { selfTransacting } from '../db/repositories/writer';
      import {
        runInTransactionContext,
        withDbTransaction,
        withDbWriteLock,
      } from '../db/transaction';
      export function nested(context) {
        return runInTransactionContext(context, async db => {
          await withDbTransaction(db, async () => undefined);
          await selfTransacting(db);
          await withDbWriteLock(async () => undefined);
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root }).filter(
      (finding) => finding.path === 'src/services/nested.ts',
    );
    for (const target of ['#withDbTransaction', '#selfTransacting', '#withDbWriteLock']) {
      assert.ok(
        findings.some(
          (finding) =>
            finding.target.endsWith(target) && finding.detectedContext === 'nested-coordinator',
        ),
        target,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finds migration payloads and an op-sqlite database-file delete without flagging file deletion', () => {
  const migrations = scanDbWritesInSource(
    `
      export const MIGRATIONS = [{
        name: '0001_example',
        statements: [
          'CREATE TABLE messages (id INTEGER)',
          \`WITH stale AS (SELECT id FROM messages) DELETE FROM messages WHERE id IN (SELECT id FROM stale)\`,
        ],
      }];
    `,
    'src/db/migrations.ts',
  );
  assert.deepEqual(
    migrations.map(({ symbol, operation, target }) => ({ symbol, operation, target })),
    [
      { symbol: 'migration:0001_example', operation: 'sql-schema', target: 'messages' },
      { symbol: 'migration:0001_example', operation: 'sql-delete', target: 'messages' },
    ],
  );

  const deleteFindings = scanDbWritesInSource(
    `
      export async function wipe(file) {
        const { open: openDb } = await import('@op-engineering/op-sqlite');
        file.delete();
        openDb({ name: 'throwaway.db' }).delete();
        let cleanup;
        cleanup = openDb({ name: 'assigned-throwaway.db' });
        cleanup.delete();
      }
    `,
    'src/db/key.ts',
  );
  assert.deepEqual(
    deleteFindings.map((finding) => finding.operation),
    ['native-database-delete', 'native-database-delete'],
  );
});

test('fails closed on native SQLite APIs under owned modules', () => {
  const findings = scanNativeDbWritesInSource(
    `
      import android.database.sqlite.SQLiteDatabase
      fun write(db: SQLiteDatabase) {
        db.execSQL("DELETE FROM messages")
      }
    `,
    'modules/example/android/Example.kt',
  );
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => finding.operation === 'native-database-api'));
  assert.ok(findings.every((finding) => finding.detectedContext === '<native>'));
});

test('does not confuse Map, file, HTTP, promise, regex, or concurrency-gate methods with DB writes', () => {
  const findings = scanDbWritesInSource(
    `
      export async function ordinaryWork(map, file, http, gate, regex, jobs) {
        map.delete('key');
        file.delete();
        await http.delete('/chat/1');
        await gate.run(async () => undefined);
        regex.exec(file.name);
        await Promise.all(jobs);
      }
    `,
    'src/services/ordinary.ts',
  );
  assert.deepEqual(findings, []);
});

test('mutation fixtures fail closed in repository, service, UI, sync, and native-support paths', () => {
  const files = {
    'src/db/repositories/example.ts': `
      import { messages } from '../schema';
      export const repositoryWrite = (db) => db.insert(messages).values({});
    `,
    'src/services/example.ts': `
      import { sql } from 'drizzle-orm';
      export const serviceWrite = (db) => db.run(sql\`DELETE FROM messages\`);
    `,
    'src/ui/example.tsx': `
      import { messages } from '@db/schema';
      export const UiWrite = ({ db }) => db.update(messages).set({ text: 'x' });
    `,
    'src/services/sync/example.ts': `
      export const syncWrite = (raw) => raw.execute('UPDATE messages SET text = NULL');
    `,
    'src/native/example.ts': `
      export const nativeSupportWrite = (nativeDb, statement) => nativeDb.execute(statement);
    `,
    'modules/example/android/Example.kt': `
      fun unsafe(db: SQLiteDatabase) { db.execSQL("DELETE FROM messages") }
    `,
    'test/ignored.test.ts': `
      import { messages } from '@db/schema';
      db.delete(messages);
    `,
  };
  const root = fixture(files);
  try {
    const findings = scanDbWrites({ root });
    assert.equal(findings.length, 6);
    const errors = validateDbWriteInventory({
      findings,
      inventory: { version: 1, entries: [] },
    });
    for (const path of Object.keys(files).filter((path) => !path.startsWith('test/'))) {
      assert.ok(
        errors.some((error) => error.includes(path)),
        path,
      );
    }
    assert.ok(!findings.some((finding) => finding.path.startsWith('test/')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inventories aliased, re-exported, transitive, and named-callback mutator calls', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/db/repositories/index.ts': `export { writeRows as persistRows } from './writer';`,
    'src/services/safe.ts': `
      import { persistRows as persist } from '../db/repositories';
      import { withDbTransaction as transact } from '../db/transaction';
      export function safe(db) {
        const write = () => persist(db);
        return transact(db, write);
      }
    `,
    'src/ui/consumer.ts': `
      import { safe } from '../services/safe';
      export function consume(db) { return safe(db); }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const calls = findings.filter((finding) => finding.operation === 'mutator-call');
    const writerCall = calls.find((finding) =>
      finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.symbol, 'safe.write');
    assert.equal(writerCall?.detectedContext, 'withDbTransaction');
    assert.ok(
      calls.some(
        (finding) =>
          finding.target.endsWith('src/services/safe.ts#safe.write') &&
          finding.detectedContext === 'withDbTransaction',
      ),
    );
    assert.ok(
      calls.some(
        (finding) =>
          finding.target.endsWith('src/db/transaction.ts#withDbTransaction') &&
          finding.detectedContext === 'transaction-coordinator',
      ),
    );
    assert.ok(
      calls.some(
        (finding) =>
          finding.symbol === 'consume' && finding.target.endsWith('src/services/safe.ts#safe'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proves only exact incoming lifecycle delegation paths through safe recursive targets', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      import { withDbTransaction } from '../transaction';
      export function safeWriter(db) {
        return withDbTransaction(db, async () => db.delete(messages));
      }
      export function unsafeWriter(db) {
        db.delete(messages);
        return safeWriter(db);
      }
    `,
    'src/services/realtime/incomingEventDrain.ts': `
      import { messages } from '../../db/schema';
      import { safeWriter, unsafeWriter } from '../../db/repositories/writer';
      import * as writers from '../../db/repositories/writer';
      import { withDbTransaction } from '../../db/transaction';
      type SafeResult = ReturnType<typeof safeWriter>;
      export function drain(db, recurse) {
        if (recurse) return drain(db, false);
        return safeWriter(db);
      }
      export function unsafeDrain(db) { return unsafeWriter(db); }
      export function scheduledUnsafeDrain(db) {
        setTimeout(() => db.delete(messages), 0);
        return safeWriter(db);
      }
      export function scheduledTransitiveDrain(db) {
        setTimeout(() => unsafeWriter(db), 0);
        return safeWriter(db);
      }
      export function scheduledDynamicDrain(db, name) {
        setTimeout(() => writers[name](db), 0);
        return safeWriter(db);
      }
      export function scheduledDynamicCallbackDrain(db, callback) {
        setTimeout(() => withDbTransaction(db, callback), 0);
        return safeWriter(db);
      }
      export function scheduledUnsafeReferenceDrain(db, consume) {
        setTimeout(() => consume(unsafeWriter), 0);
        return safeWriter(db);
      }
    `,
    'src/services/realtime/incomingEventDispatcher.ts': `
      import { drain } from './incomingEventDrain';
      export function dispatch(db) { return drain(db, true); }
    `,
    'src/services/realtimeControl.ts': `
      import { drain } from './realtime/incomingEventDrain';
      export function resume(db) { return drain(db, false); }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const contextFor = (path, symbol, targetSuffix) =>
      findings.find(
        (finding) =>
          finding.path === path &&
          finding.symbol === symbol &&
          finding.target.endsWith(targetSuffix),
      )?.detectedContext;

    assert.equal(
      contextFor(
        'src/services/realtime/incomingEventDrain.ts',
        'drain',
        'incomingEventDrain.ts#drain',
      ),
      'coordinated-delegation',
    );
    assert.equal(
      contextFor('src/services/realtime/incomingEventDrain.ts', 'drain', 'writer.ts#safeWriter'),
      'coordinated-delegation',
    );
    assert.equal(
      contextFor(
        'src/services/realtime/incomingEventDispatcher.ts',
        'dispatch',
        'incomingEventDrain.ts#drain',
      ),
      'coordinated-delegation',
    );
    assert.equal(
      contextFor(
        'src/services/realtime/incomingEventDrain.ts',
        'unsafeDrain',
        'writer.ts#unsafeWriter',
      ),
      'unresolved',
    );
    for (const symbol of [
      'scheduledDynamicDrain',
      'scheduledDynamicCallbackDrain',
      'scheduledUnsafeReferenceDrain',
      'scheduledTransitiveDrain',
    ]) {
      assert.equal(
        contextFor('src/services/realtime/incomingEventDrain.ts', symbol, 'writer.ts#safeWriter'),
        'unresolved',
      );
    }
    assert.equal(
      contextFor(
        'src/services/realtime/incomingEventDrain.ts',
        'scheduledUnsafeDrain',
        'writer.ts#safeWriter',
      ),
      'unresolved',
    );
    assert.equal(
      contextFor('src/services/realtimeControl.ts', 'resume', 'incomingEventDrain.ts#drain'),
      'coordinated-delegation',
    );
    assert.ok(
      !findings.some(
        (finding) =>
          finding.operation === 'mutator-reference' &&
          finding.path === 'src/services/realtime/incomingEventDrain.ts' &&
          finding.symbol === '<module>' &&
          finding.target.endsWith('writer.ts#safeWriter'),
      ),
      'compile-time ReturnType references must not enter the runtime inventory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delegation proof requires an adopted exact transaction-context join', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function runInTransactionContext(context, callback) { return callback(context.db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      import { runInTransactionContext } from '../transaction';
      export function joined(context) {
        return runInTransactionContext(context, async (db) => db.delete(messages));
      }
      export function detached(context) {
        runInTransactionContext(context, async (db) => db.delete(messages));
      }
    `,
    'src/services/realtime/incomingEventDrain.ts': `
      import { joined, detached } from '../../db/repositories/writer';
      export function safe(context) { return joined(context); }
      export function unsafe(context) { return detached(context); }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const calls = findings.filter(
      (finding) =>
        finding.path === 'src/services/realtime/incomingEventDrain.ts' &&
        finding.operation === 'mutator-call',
    );
    assert.equal(
      calls.find((finding) => finding.target.endsWith('writer.ts#joined'))?.detectedContext,
      'coordinated-delegation',
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/db/repositories/writer.ts' &&
          finding.operation === 'drizzle-delete' &&
          finding.detectedContext === 'unresolved',
      ),
    );
    assert.ok(!calls.some((finding) => finding.target.endsWith('writer.ts#detached')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delegation proof never masks nested or dynamic coordinator entry', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      import { withDbTransaction } from '../transaction';
      export function safeWriter(db) {
        return withDbTransaction(db, async () => db.delete(messages));
      }
    `,
    'src/db/repositories/index.ts': `export { safeWriter } from './writer';`,
    'src/services/realtime/incomingEventDrain.ts': `
      import * as writers from '../../db/repositories';
      import { safeWriter } from '../../db/repositories/writer';
      import { withDbTransaction } from '../../db/transaction';
      export function nested(db) {
        return withDbTransaction(db, async () => safeWriter(db));
      }
      export function dynamic(db, name) { return writers[name](db); }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/realtime/incomingEventDrain.ts' &&
          finding.target.endsWith('writer.ts#safeWriter') &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/realtime/incomingEventDrain.ts' &&
          finding.operation === 'dynamic-mutator-call' &&
          finding.detectedContext === 'unresolved',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function startupSingleFlightFixture({ databaseTransform, controlTransform, extraFiles = {} } = {}) {
  const database = `
    import { open } from '@op-engineering/op-sqlite';
    import { drizzle } from 'drizzle-orm/op-sqlite';
    import { runMigrations } from './migrate';
    const DB_NAME = 'gator.db';
    let rawDb = null;
    let dbInstance = null;
    function opRunner(db) {
      return { exec(sql) { return db.execute(sql); } };
    }
    function drizzleAdapter(db) {
      return { execute(sql) { return db.execute(sql); } };
    }
    export async function initDatabase(encryptionKey) {
      if (dbInstance) return dbInstance;
      const opened = open({ name: DB_NAME, encryptionKey });
      try {
        await opened.execute('PRAGMA foreign_keys = ON');
        await runMigrations(opRunner(opened));
        const database = drizzle(drizzleAdapter(opened));
        rawDb = opened;
        dbInstance = database;
        return database;
      } catch (error) {
        try { opened.close(); } catch {}
        throw error;
      }
    }
    export function getDatabase() {
      if (!dbInstance) throw new Error('not initialized');
      return dbInstance;
    }
    export function getRawDatabase() {
      if (!rawDb) throw new Error('not initialized');
      return rawDb;
    }
  `;
  const control = `
    import { getDatabase, initDatabase } from '../db/database';
    import { resolveDbKey } from '../db/key';
    import { vault } from './clients';
    let openInFlight = null;
    function startDatabaseOpen() {
      const attempt = (async () => {
        const key = await resolveDbKey(vault);
        return initDatabase(key);
      })();
      const clear = () => {
        if (openInFlight === attempt) openInFlight = null;
      };
      attempt.then(clear, clear);
      return attempt;
    }
    export async function ensureDatabase() {
      try {
        return getDatabase();
      } catch {}
      openInFlight ??= startDatabaseOpen();
      return openInFlight;
    }
  `;
  return {
    'src/startup-externals.d.ts': `
      declare module '@op-engineering/op-sqlite' {
        export function open(options: unknown): any;
      }
      declare module 'drizzle-orm/op-sqlite' {
        export function drizzle(database: unknown): any;
      }
    `,
    'src/db/migrate.ts': `
      export async function runMigrations(runner) { await runner.exec('BEGIN'); }
    `,
    'src/db/key.ts': `export async function resolveDbKey() { return 'key'; }`,
    'src/db/database.ts': databaseTransform ? databaseTransform(database) : database,
    'src/services/clients.ts': `export const vault = {};`,
    'src/services/databaseControl.ts': controlTransform ? controlTransform(control) : control,
    'src/services/consumer.ts': `
      import { ensureDatabase } from './databaseControl';
      export function openDirectly() { return ensureDatabase(); }
      export function injectOpen(consume) { return consume(ensureDatabase); }
    `,
    'src/services/allowedRuntimeStrings.ts': `
      declare function require(path: string): unknown;
      export const diagnostic = '../db/database';
      export const external = require('external-package');
      export const asset = require('../../assets/icon.png');
    `,
    'src/services/startupLookalike.ts': `
      export function ensureDatabase(db) { return db.execute('UPDATE lookalike SET value = 1'); }
      export function callLookalike(db) { return ensureDatabase(db); }
    `,
    ...extraFiles,
  };
}

function startupContext(findings, path, symbol, targetSuffix) {
  return findings.find(
    (finding) =>
      finding.path === path && finding.symbol === symbol && finding.target.endsWith(targetSuffix),
  )?.detectedContext;
}

function assertStartupCertificateRevoked(findings, label) {
  const outer = findings.find(
    (finding) =>
      finding.path === 'src/services/consumer.ts' &&
      finding.symbol === 'openDirectly' &&
      finding.target.endsWith('src/services/databaseControl.ts#ensureDatabase'),
  );
  const migration = findings.find(
    (finding) =>
      finding.path === 'src/db/database.ts' &&
      finding.symbol === 'initDatabase' &&
      finding.target.endsWith('src/db/migrate.ts#runMigrations'),
  );
  const pragma = findings.find(
    (finding) =>
      finding.path === 'src/db/database.ts' &&
      finding.symbol === 'initDatabase' &&
      finding.operation === 'sql-pragma',
  );
  assert.equal(outer?.detectedContext, 'unresolved', `${label}: outer caller`);
  assert.equal(migration?.detectedContext, 'unresolved', `${label}: migration edge`);
  assert.equal(pragma?.detectedContext, 'unresolved', `${label}: initializer write`);

  const inventory = createInventorySkeleton([outer]);
  Object.assign(inventory.entries[0], {
    owner: 'database open lifecycle',
    transactionContext: outer.detectedContext,
    disposition: 'proven-temporal-exclusion',
    evidence: 'startup certificate fixture',
  });
  assert.ok(
    validateDbWriteInventory({ findings: [outer], inventory }).some((error) =>
      error.includes('does not have a detected temporal-exclusion context'),
    ),
    `${label}: temporal validation must fail`,
  );
}

test('certifies only the exact database startup single-flight and delayed publication chain', () => {
  const root = fixture(startupSingleFlightFixture());
  try {
    const findings = scanDbWrites({ root });
    for (const [path, symbol, target] of [
      [
        'src/services/databaseControl.ts',
        'startDatabaseOpen',
        'databaseControl.ts#startDatabaseOpen.<callback:',
      ],
      [
        'src/services/databaseControl.ts',
        'startDatabaseOpen.<callback:',
        'src/db/database.ts#initDatabase',
      ],
      [
        'src/services/databaseControl.ts',
        'ensureDatabase',
        'src/services/databaseControl.ts#startDatabaseOpen',
      ],
      [
        'src/services/consumer.ts',
        'openDirectly',
        'src/services/databaseControl.ts#ensureDatabase',
      ],
      ['src/services/consumer.ts', 'injectOpen', 'src/services/databaseControl.ts#ensureDatabase'],
    ]) {
      const context = findings.find(
        (finding) =>
          finding.path === path &&
          finding.symbol.startsWith(symbol) &&
          finding.target.includes(target),
      )?.detectedContext;
      assert.equal(context, 'startup-single-flight-delegation');
    }
    assert.equal(
      startupContext(
        findings,
        'src/db/database.ts',
        'initDatabase',
        'src/db/migrate.ts#runMigrations',
      ),
      'startup-initialization',
    );
    const adapterFindings = findings.filter(
      (finding) =>
        finding.path === 'src/db/database.ts' && finding.detectedContext === 'driver-adapter',
    );
    assert.equal(adapterFindings.length, 2);
    const adapterInventory = createInventorySkeleton(adapterFindings);
    for (const entry of adapterInventory.entries) {
      Object.assign(entry, {
        owner: 'driver adapter',
        transactionContext: entry.detectedContext,
        disposition: 'proven-temporal-exclusion',
        evidence: 'must remain unapproved',
      });
    }
    const adapterErrors = validateDbWriteInventory({
      findings: adapterFindings,
      inventory: adapterInventory,
    });
    assert.equal(adapterErrors.length, adapterFindings.length);
    assert.ok(
      adapterErrors.every((error) =>
        error.includes('does not have a detected temporal-exclusion context'),
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/startupLookalike.ts' &&
          finding.symbol === 'callLookalike' &&
          finding.detectedContext === 'unresolved',
      ),
    );
    assert.equal(
      findings.find(
        (finding) => finding.path === 'src/db/database.ts' && finding.operation === 'sql-pragma',
      )?.detectedContext,
      'startup-initialization',
    );

    const reviewed = findings.filter((finding) =>
      ['startup-initialization', 'startup-migration', 'startup-single-flight-delegation'].includes(
        finding.detectedContext,
      ),
    );
    const inventory = createInventorySkeleton(reviewed);
    for (const entry of inventory.entries) {
      Object.assign(entry, {
        owner: 'database open lifecycle',
        transactionContext: entry.detectedContext,
        disposition: 'proven-temporal-exclusion',
        evidence: 'startup certificate fixture',
      });
    }
    assert.deepEqual(validateDbWriteInventory({ findings: reviewed, inventory }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup single-flight certificate fails closed on admission and cleanup mutations', () => {
  const mutations = [
    [
      'unmemoized open',
      (source) =>
        source.replace(
          'openInFlight ??= startDatabaseOpen();',
          'openInFlight = startDatabaseOpen();',
        ),
    ],
    [
      'yield before admission',
      (source) =>
        source.replace(
          'openInFlight ??= startDatabaseOpen();',
          'await Promise.resolve();\n      openInFlight ??= startDatabaseOpen();',
        ),
    ],
    [
      'one-sided cleanup',
      (source) => source.replace('attempt.then(clear, clear);', 'attempt.then(clear);'),
    ],
    [
      'cleanup without identity fencing',
      (source) =>
        source.replace(
          'if (openInFlight === attempt) openInFlight = null;',
          'if (openInFlight) openInFlight = null;',
        ),
    ],
    [
      'cleanup callback shadows the attempt',
      (source) => source.replace('const clear = () => {', 'const clear = (attempt) => {'),
    ],
    [
      'side-effecting default admission parameter',
      (source) =>
        source.replace(
          'export async function ensureDatabase() {',
          'export async function ensureDatabase(_ = 1) {',
        ),
    ],
    [
      'different returned promise',
      (source) => source.replace('return openInFlight;', 'return startDatabaseOpen();'),
    ],
    [
      'second start entry',
      (source) => `${source}\nexport function bypassSingleFlight() { return startDatabaseOpen(); }`,
    ],
    [
      'destructured memo replacement',
      (source) => `${source}\nexport function resetFlight(state) { ({ openInFlight } = state); }`,
    ],
    [
      'loop-target memo replacement',
      (source) =>
        `${source}\nexport function resetFlight(states) { for (openInFlight of states) break; }`,
    ],
  ];
  for (const [label, controlTransform] of mutations) {
    const root = fixture(startupSingleFlightFixture({ controlTransform }));
    try {
      assertStartupCertificateRevoked(scanDbWrites({ root }), label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('startup single-flight certificate fails closed on publication and initializer escapes', () => {
  const cases = [
    {
      label: 'early raw publication',
      databaseTransform: (source) =>
        source.replace(
          "await opened.execute('PRAGMA foreign_keys = ON');",
          "rawDb = opened;\n        await opened.execute('PRAGMA foreign_keys = ON');",
        ),
    },
    {
      label: 'unawaited migration',
      databaseTransform: (source) =>
        source.replace(
          'await runMigrations(opRunner(opened));',
          'runMigrations(opRunner(opened));',
        ),
    },
    {
      label: 'extra open argument',
      databaseTransform: (source) =>
        source.replace(
          'open({ name: DB_NAME, encryptionKey })',
          'open({ name: DB_NAME, encryptionKey }, Promise.resolve())',
        ),
    },
    {
      label: 'missing failure close',
      databaseTransform: (source) => source.replace('try { opened.close(); } catch {}', ''),
    },
    {
      label: 'replaced initialization error',
      databaseTransform: (source) =>
        source.replace('throw error;', "throw new Error('replacement');"),
    },
    {
      label: 'getter bypass',
      databaseTransform: (source) =>
        source.replace("if (!dbInstance) throw new Error('not initialized');", ''),
    },
    {
      label: 'mutating getter guard',
      databaseTransform: (source) =>
        `import { writeRows } from './writer';\n${source}`.replace(
          "throw new Error('not initialized');",
          'throw writeRows();',
        ),
      extraFiles: {
        'src/db/writer.ts': `
          import { messages } from './schema';
          export function writeRows(db) { return db.delete(messages); }
        `,
        'src/db/schema.ts': `export const messages = {};`,
      },
    },
    {
      label: 'second init call',
      extraFiles: {
        'src/services/initBypass.ts': `
          import { initDatabase } from '../db/database';
          export function bypass() { return initDatabase('key'); }
        `,
      },
    },
    {
      label: 'escaped init reference',
      extraFiles: {
        'src/services/initBypass.ts': `
          import { initDatabase } from '../db/database';
          export function bypass(consume) { return consume(initDatabase); }
        `,
      },
    },
    {
      label: 'second migration call',
      extraFiles: {
        'src/services/migrationBypass.ts': `
          import { runMigrations } from '../db/migrate';
          export function bypass(runner) { return runMigrations(runner); }
        `,
      },
    },
    {
      label: 'dynamic init import',
      extraFiles: {
        'src/services/dynamicInitBypass.ts': `
          export async function bypass() {
            const database = await import('../db/database');
            return database.initDatabase('key');
          }
        `,
      },
    },
    {
      label: 'required init alias',
      extraFiles: {
        'src/services/requiredInitBypass.ts': `
          declare function require(path: string): any;
          const { initDatabase: openIt } = require('../db/database');
          export function bypass() { return openIt('other-key'); }
        `,
      },
    },
    {
      label: 'required init alias with JavaScript specifier',
      extraFiles: {
        'src/services/requiredJsInitBypass.ts': `
          declare function require(path: string): any;
          const { initDatabase: openIt } = require('../db/database.js');
          export function bypass() { return openIt('other-key'); }
        `,
      },
    },
    {
      label: 'required migration alias',
      extraFiles: {
        'src/services/requiredMigrationBypass.ts': `
          declare function require(path: string): any;
          const { runMigrations: runIt } = require('../db/migrate');
          export function bypass(runner) { return runIt(runner); }
        `,
      },
    },
    {
      label: 'required ensure alias',
      extraFiles: {
        'src/services/requiredEnsureBypass.ts': `
          declare function require(path: string): any;
          const { ensureDatabase: openIt } = require('./databaseControl');
          export function bypass() { return openIt(); }
        `,
      },
    },
    {
      label: 'required ensure barrel alias',
      extraFiles: {
        'src/services/index.ts': `export { ensureDatabase } from './databaseControl';`,
        'src/services/requiredBarrelBypass.ts': `
          declare function require(path: string): any;
          const { ensureDatabase: openIt } = require('@/services');
          export function bypass() { return openIt(); }
        `,
      },
    },
    {
      label: 'required ensure dotted barrel alias',
      extraFiles: {
        'src/services/startup.db.ts': `export { ensureDatabase } from './databaseControl';`,
        'src/services/requiredDottedBarrelBypass.ts': `
          declare function require(path: string): any;
          const { ensureDatabase: openIt } = require('./startup.db');
          export function bypass() { return openIt(); }
        `,
      },
    },
    {
      label: 'second native open call',
      databaseTransform: (source) =>
        `${source}\nexport function bypassOpen(encryptionKey) { return open({ name: DB_NAME, encryptionKey }); }`,
    },
    {
      label: 'namespace native open call',
      databaseTransform: (source) =>
        `import * as otherSqlite from '@op-engineering/op-sqlite';\n${source}\nexport function bypassOpen(encryptionKey) { return otherSqlite.open({ name: DB_NAME, encryptionKey }); }`,
    },
    {
      label: 'required native open call',
      databaseTransform: (source) =>
        `${source}\ndeclare function require(path: string): any;\nconst { open: openOther } = require('@op-engineering/op-sqlite');\nexport function bypassOpen(encryptionKey) { return openOther({ name: DB_NAME, encryptionKey }); }`,
    },
    {
      label: 'locally aliased native open call',
      databaseTransform: (source) =>
        `${source}\nconst openOther = open;\nexport function bypassOpen(encryptionKey) { return openOther({ name: DB_NAME, encryptionKey }); }`,
    },
    {
      label: 'destructured database publication replacement',
      databaseTransform: (source) =>
        `${source}\nexport function resetDatabase(state) { ({ rawDb, dbInstance } = state); }`,
    },
  ];
  for (const { label, databaseTransform, extraFiles } of cases) {
    const root = fixture(startupSingleFlightFixture({ databaseTransform, extraFiles }));
    try {
      assertStartupCertificateRevoked(scanDbWrites({ root }), label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a newly introduced startup caller gets the safe context but still fails exact membership', () => {
  const root = fixture(startupSingleFlightFixture());
  try {
    const inventory = createInventorySkeleton(scanDbWrites({ root }));
    const consumer = resolve(root, 'src/services/newStartupConsumer.ts');
    writeFileSync(
      consumer,
      `
        import { ensureDatabase } from './databaseControl';
        export function newlyAdded() { return ensureDatabase(); }
      `,
    );
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.path === 'src/services/newStartupConsumer.ts' &&
          finding.detectedContext === 'startup-single-flight-delegation',
      ),
    );
    assert.ok(
      validateDbWriteInventory({ findings, inventory, requireApproved: false }).some((error) =>
        error.includes('unapproved database write'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('certifies exactly the reviewed direct incoming-ingress edge nodes', () => {
  const findings = scanProjectDbWrites();
  const ingress = findings.filter(
    (finding) => finding.detectedContext === 'incoming-ingress-delegation',
  );

  assert.equal(ingress.length, 22);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(ingress.map((finding) => finding.path))]
        .sort()
        .map((path) => [path, ingress.filter((finding) => finding.path === path).length]),
    ),
    {
      'app/(app)/chat/[guid].tsx': 1,
      'src/features/conversations/devSeed.ts': 5,
      'src/services/notifications/fcmMessaging.ts': 6,
      'src/services/notifications/registerFcmBackgroundHandler.ts': 1,
      'src/services/realtimeControl.ts': 9,
    },
  );
  assert.equal(ingress.filter((finding) => finding.operation === 'mutator-reference').length, 2);
  assert.ok(
    findings
      .filter(
        (finding) =>
          finding.target.endsWith('src/services/realtimeControl.ts#startRealtime') ||
          finding.target.endsWith('src/services/realtimeControl.ts#resumeRealtime'),
      )
      .every((finding) => finding.detectedContext !== 'incoming-ingress-delegation'),
  );
});

test('certifies exactly the reviewed error-report ownership and outer lifecycle edges', () => {
  const findings = scanProjectDbWrites();
  const localPaths = new Set([
    'src/db/repositories/errorReports.ts',
    'src/services/errors/errorReportQueueService.ts',
    'src/services/errors/errorReportSink.ts',
    'src/services/errors/globalErrorHandlers.ts',
    'src/services/errors/index.ts',
  ]);
  const local = findings.filter(
    (finding) =>
      localPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const repositoryOwnerSymbols = new Set([
    'claimErrorReports',
    'claimErrorReportsWithinTransaction',
    'deleteErrorReports',
    'deleteErrorReportsWithinTransaction',
    'listRetryableErrorReports',
    'listRetryableErrorReportsWithinTransaction',
    'markErrorReportsFailed',
    'markErrorReportsFailedWithinTransaction',
  ]);
  const repositoryTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/errorReports.ts' &&
      repositoryOwnerSymbols.has(finding.symbol.split('.<callback:')[0]) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const queueTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/errors/errorReportQueueService.ts' &&
      finding.symbol.startsWith('runQueueBody') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const outer = findings.filter(
    (finding) => finding.detectedContext === 'error-report-lifecycle-delegation',
  );

  assert.equal(local.length, 16);
  assert.deepEqual(
    local.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/errorReports.ts#insertErrorReport:mutator-call:184b64238855',
      'src/services/errors/errorReportQueueService.ts#runErrorReportQueue.<callback:1146394e6d>:mutator-call:94a3c2f0ecbf',
      'src/services/errors/errorReportQueueService.ts#runErrorReportQueue:mutator-call:6ab4a7e8d484',
      'src/services/errors/errorReportSink.ts#ErrorReportSink.flushToDb:mutator-call:e3fd2f80780c',
      'src/services/errors/errorReportSink.ts#ErrorReportSink.scheduleDrain.<callback:1067ca9296>:mutator-call:c0f2f41e3a9e',
      'src/services/errors/errorReportSink.ts#captureError:mutator-call:a8184e42b9cb',
      'src/services/errors/globalErrorHandlers.ts#installErrorUtils.<callback:b4a5ef749c>:mutator-call:40328b68c92f',
      'src/services/errors/globalErrorHandlers.ts#installRejectionTracker.onUnhandled:mutator-call:b340f115e916',
      'src/services/errors/index.ts#ensureConsentObserver.<callback:a350d282b8>:mutator-call:81274b260511',
      'src/services/errors/index.ts#ensureConsentObserver:mutator-call:5631fb0106eb',
      'src/services/errors/index.ts#flushErrorReports:mutator-call:1ae42da375cc',
      'src/services/errors/index.ts#flushErrorReports:mutator-call:35b3c74315d6',
      'src/services/errors/index.ts#flushErrorReports:mutator-call:4c82a62c3bba',
      'src/services/errors/index.ts#flushErrorReports:mutator-call:a82e15453f42',
      'src/services/errors/index.ts#initErrorReporting:mutator-call:e859266a73cf',
      'src/services/errors/index.ts#revokeErrorReporting:mutator-call:df9a116f1f15',
    ].sort(),
  );
  assert.deepEqual(
    repositoryTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/errorReports.ts#claimErrorReports.<callback:c9aa239408>:mutator-call:80199932a94d',
      'src/db/repositories/errorReports.ts#claimErrorReports:mutator-call:25becb5bc7ba',
      'src/db/repositories/errorReports.ts#claimErrorReports:mutator-call:c48fe530c9bc',
      'src/db/repositories/errorReports.ts#claimErrorReportsWithinTransaction:sql-update:a6cadd1370ec',
      'src/db/repositories/errorReports.ts#deleteErrorReports.<callback:5ff1fe5664>:mutator-call:95b001f7a2ae',
      'src/db/repositories/errorReports.ts#deleteErrorReports:mutator-call:317f3471e7da',
      'src/db/repositories/errorReports.ts#deleteErrorReports:mutator-call:f0097ddea70a',
      'src/db/repositories/errorReports.ts#deleteErrorReportsWithinTransaction:sql-delete:bb847c13001b',
      'src/db/repositories/errorReports.ts#listRetryableErrorReports.<callback:34ae7037fb>:mutator-call:fa1851fb1552',
      'src/db/repositories/errorReports.ts#listRetryableErrorReports:mutator-call:231b4b71f6c6',
      'src/db/repositories/errorReports.ts#listRetryableErrorReports:mutator-call:2538e5c2e5d3',
      'src/db/repositories/errorReports.ts#listRetryableErrorReportsWithinTransaction.<callback:6d0d0f76a3>:mutator-call:38305fef3c77',
      'src/db/repositories/errorReports.ts#markErrorReportsFailed.<callback:de20fdbd27>:mutator-call:1f1e7f013451',
      'src/db/repositories/errorReports.ts#markErrorReportsFailed:mutator-call:8312ba5644a2',
      'src/db/repositories/errorReports.ts#markErrorReportsFailed:mutator-call:ba127dd07f32',
      'src/db/repositories/errorReports.ts#markErrorReportsFailedWithinTransaction:sql-delete:b6a752ef4ffa',
      'src/db/repositories/errorReports.ts#markErrorReportsFailedWithinTransaction:sql-update:fafc5a007c8e',
    ].sort(),
  );
  assert.equal(repositoryTransactions.length, 17);
  assert.deepEqual(
    queueTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:0a89819f93>.<callback:c04c1aca31>:mutator-call:4c8e5e7f7a7a',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:0a89819f93>:mutator-call:d14964c68db3',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:0a89819f93>:mutator-call:e8da34c8d417',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:1c51f3e183>.<callback:46d8afbc49>:mutator-call:d889281ba3b1',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:1c51f3e183>:mutator-call:06c0f41534b8',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:1c51f3e183>:mutator-call:c1ba7ef65fda',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:5d7016c73c>.<callback:e0e11b4c8c>:mutator-call:fa0394c809cc',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:5d7016c73c>:mutator-call:819af640a00c',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:5d7016c73c>:mutator-call:a360ea2bc00f',
      'src/services/errors/errorReportQueueService.ts#runQueueBody.<callback:3beb70afb0>:mutator-call:42846afff5c3',
      'src/services/errors/errorReportQueueService.ts#runQueueBody:mutator-call:4d7d77b3c92a',
      'src/services/errors/errorReportQueueService.ts#runQueueBody:mutator-call:9aa37e5faf01',
    ].sort(),
  );
  assert.equal(queueTransactions.length, 12);
  const revokeTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/errors/index.ts' &&
      finding.symbol.startsWith('revokeErrorReporting.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  assert.deepEqual(
    revokeTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/errors/index.ts#revokeErrorReporting.<callback:6ba16ab0fa>:mutator-call:00b329553e04',
      'src/services/errors/index.ts#revokeErrorReporting.<callback:6ba16ab0fa>:mutator-call:3cd60f103698',
      'src/services/errors/index.ts#revokeErrorReporting.<callback:6ba16ab0fa>.<callback:df5455005c>:mutator-call:0af467bde68f',
    ].sort(),
  );
  assert.equal(outer.length, 7);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(outer.map((finding) => finding.path))]
        .sort()
        .map((path) => [path, outer.filter((finding) => finding.path === path).length]),
    ),
    {
      'app/(app)/_layout.tsx': 3,
      'src/services/background/backgroundSync.ts': 2,
      'src/services/boot/foregroundBoot.ts': 1,
      'src/services/lock.ts': 1,
    },
  );
  assert.ok(
    findings
      .filter(
        (finding) =>
          ['app/(app)/_layout.tsx', 'src/services/background/backgroundSync.ts'].includes(
            finding.path,
          ) && !outer.includes(finding),
      )
      .every((finding) => finding.detectedContext !== 'error-report-lifecycle-delegation'),
  );
});

fullOnlyTest(
  'error-report outer lifecycle proof fails closed when an exact handoff is redirected',
  () => {
    const root = incomingIngressFixture();
    try {
      const baseline = scanDbWrites({ root });
      assert.equal(
        baseline.filter(
          (finding) => finding.detectedContext === 'error-report-lifecycle-delegation',
        ).length,
        7,
      );
      replaceFixtureSource(
        root,
        'src/services/lock.ts',
        'void flushErrorReports().catch((error: unknown) => {',
        'void resumeRealtime().catch((error: unknown) => {',
      );
      const mutated = scanDbWrites({ root });
      assert.equal(
        mutated.filter((finding) => finding.detectedContext === 'error-report-lifecycle-delegation')
          .length,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

fullOnlyTest(
  'error-report outer lifecycle proof distinguishes background and active AppState handoffs',
  () => {
    const root = incomingIngressFixture();
    try {
      const baseline = scanDbWrites({ root });
      assert.equal(
        baseline.filter(
          (finding) => finding.detectedContext === 'error-report-lifecycle-delegation',
        ).length,
        7,
      );
      replaceFixtureSource(
        root,
        'app/(app)/_layout.tsx',
        'pauseRealtime();\n        void flushErrorReports();\n        return;',
        'pauseRealtime();\n        return;',
      );
      replaceFixtureSource(
        root,
        'app/(app)/_layout.tsx',
        'void flushErrorReports();\n        // Drain the outgoing retry queue',
        'void flushErrorReports();\n        void flushErrorReports();\n        // Drain the outgoing retry queue',
      );
      const mutated = scanDbWrites({ root });
      assert.equal(
        mutated.filter((finding) => finding.detectedContext === 'error-report-lifecycle-delegation')
          .length,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('certifies exactly the reviewed notification presentation and reminder-effect edges', () => {
  const findings = scanProjectDbWrites();
  const localPaths = new Set([
    'src/services/notifications/notifeeService.ts',
    'src/services/notifications/remindersService.ts',
  ]);
  const local = findings.filter(
    (finding) =>
      localPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const reminderPress = findings.filter(
    (finding) => finding.detectedContext === 'notification-effect-lifecycle-delegation',
  );
  const cancelReminderTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/notifications/remindersService.ts' &&
      finding.symbol.startsWith('cancelReminder.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const createReminderTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/notifications/remindersService.ts' &&
      finding.symbol.startsWith('scheduleReminder.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      finding.snippet.includes('createReminderWithinTransaction'),
  );
  const scheduleReminderMoveTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/notifications/remindersService.ts' &&
      finding.symbol.startsWith('scheduleReminder.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      finding.snippet.includes('updateReminderTimeWithinTransaction'),
  );
  const rescheduleReminderMoveTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/notifications/remindersService.ts' &&
      finding.symbol.startsWith('rescheduleReminder.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      finding.snippet.includes('updateReminderTimeWithinTransaction'),
  );

  assert.deepEqual(
    local.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/notifeeService.ts#armSanitizedReminder:mutator-call:f8804eee4845',
      'src/services/notifications/notifeeService.ts#armSanitizedReminders:mutator-call:988bcd2108e5',
      'src/services/notifications/notifeeService.ts#cancelAllNotifications.<callback:d88b914181>:mutator-call:5e1eda48b4c7',
      'src/services/notifications/notifeeService.ts#cancelFaceTimeNotification.<callback:4ef3145a64>:mutator-call:dd3a6cf045a8',
      'src/services/notifications/notifeeService.ts#cancelFaceTimeNotificationNow:mutator-call:22faf30a92fa',
      'src/services/notifications/notifeeService.ts#postFaceTimeNotification:mutator-call:61526340fc91',
      'src/services/notifications/notifeeService.ts#postNotification.<callback:3a468d9c93>:mutator-call:12d78e0bda2f',
      'src/services/notifications/notifeeService.ts#postNotificationNow:mutator-call:3715d5ebf0b8',
      'src/services/notifications/notifeeService.ts#postNotificationNow:mutator-call:a1fe19482506',
      'src/services/notifications/notifeeService.ts#postSendFailureNotification.<callback:733692bd31>:mutator-call:69ad00d25654',
      'src/services/notifications/notifeeService.ts#prepareNotificationPresentationState.<callback:2d26413326>.<callback:aaa5db8dfb>:mutator-call:49cfa621c037',
      'src/services/notifications/notifeeService.ts#prepareNotificationPresentationStateNow:mutator-call:636ff0e2c483',
      'src/services/notifications/notifeeService.ts#repairMissingFutureReminderTriggers:mutator-call:2e4db01772b0',
      'src/services/notifications/notifeeService.ts#sanitizeDisplayedNotifications:mutator-call:1a0c7f4aa6a7',
      'src/services/notifications/notifeeService.ts#sanitizeDisplayedNotifications:mutator-call:fc0ca0b8b11a',
      'src/services/notifications/notifeeService.ts#sanitizeLegacyNotificationPayloadsIfPresent:mutator-call:9e429c36e49b',
      'src/services/notifications/notifeeService.ts#sanitizeLegacyNotificationPayloadsIfPresent:mutator-call:e82c1c7ba163',
      'src/services/notifications/notifeeService.ts#sanitizeLegacyNotificationPayloadsIfPresent:mutator-call:e85e19312cb9',
      'src/services/notifications/notifeeService.ts#sanitizeTriggerNotifications:mutator-call:fd918617393f',
      'src/services/notifications/notifeeService.ts#sanitizedFaceTimeNotification:mutator-call:89a00ac79465',
      'src/services/notifications/notifeeService.ts#sanitizedNotification:mutator-call:0c7b1862fc9e',
    ].sort(),
  );
  assert.deepEqual(
    createReminderTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>.<callback:8aa1abdd3a>:mutator-call:74ab19e0d1ee',
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>:mutator-call:331f4ed00ce9',
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>:mutator-call:516c0ff5660a',
    ].sort(),
  );
  assert.deepEqual(
    scheduleReminderMoveTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>.<callback:63ddd06ef2>:mutator-call:bcd082c58a78',
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>:mutator-call:2192dc48d599',
      'src/services/notifications/remindersService.ts#scheduleReminder.<callback:6f7507c0ae>:mutator-call:e9106648ae6e',
    ].sort(),
  );
  assert.deepEqual(
    rescheduleReminderMoveTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/remindersService.ts#rescheduleReminder.<callback:d65374144e>.<callback:e57c656026>:mutator-call:fc889821acbc',
      'src/services/notifications/remindersService.ts#rescheduleReminder.<callback:d65374144e>:mutator-call:40f7376d4664',
      'src/services/notifications/remindersService.ts#rescheduleReminder.<callback:d65374144e>:mutator-call:50c902933fef',
    ].sort(),
  );
  assert.deepEqual(
    reminderPress.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/actions.ts#handleNotificationPress.<callback:57842c3968>:mutator-call:34d83832cc06',
      'src/services/notifications/actions.ts#handleNotificationPressForAccount:mutator-call:b83aedcb7b5e',
    ].sort(),
  );
  assert.deepEqual(
    cancelReminderTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/remindersService.ts#cancelReminder.<callback:e1c2492a6b>.<callback:e767effe3c>:mutator-call:8bd102043c73',
      'src/services/notifications/remindersService.ts#cancelReminder.<callback:e1c2492a6b>:mutator-call:ad8222e0df7c',
      'src/services/notifications/remindersService.ts#cancelReminder.<callback:e1c2492a6b>:mutator-call:d1aecba69f8f',
    ].sort(),
  );
});

test('certifies exactly the reviewed interactive leaf-delegation edges', () => {
  const findings = scanProjectDbWrites();
  const paths = new Set(['src/services/featureSettingsCommands.ts']);
  const delegated = findings.filter(
    (finding) => paths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const featureSettingTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/state/featureSettingsStore.ts' &&
      (finding.symbol.includes('.setFlag') ||
        finding.symbol.includes('.setMaxConcurrentDownloads') ||
        finding.symbol.includes('.setAutoDownloadDestination')) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const permissionOnboardingTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/state/featureSettingsStore.ts' &&
      finding.symbol.includes('completePermissionOnboarding') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const customThemeTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/state/themeStore.ts' &&
      (finding.symbol.includes('.setCustomTheme') ||
        finding.symbol.includes('.clearCustomTheme')) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const scheduledHistoryTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/index.ts' &&
      finding.symbol.startsWith('clearScheduledHistoryItem') &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/scheduled.ts#deleteScheduledHistoryWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/send/index.ts#clearScheduledHistoryItem.'))),
  );
  const markAllReadTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('markAllChatsRead') &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/chats.ts#markAllChatsReadLocalWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/chatActions.ts#markAllChatsRead.'))),
  );
  const inboxPreferenceTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      ['setChatArchived', 'setChatMuted', 'setChatPinned'].some((symbol) =>
        finding.symbol.startsWith(symbol),
      ) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/chats.ts#setChatPinWithinTransaction' ||
        finding.target === 'src/db/repositories/chats.ts#setChatMuteWithinTransaction' ||
        finding.target === 'src/db/repositories/chats.ts#setChatArchiveWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/chatActions.ts#'))),
  );
  const chatSettingsPreferenceTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      ['resetChatLocalPreferences', 'setChatMuted', 'updateChatCustomization'].some((symbol) =>
        finding.symbol.startsWith(symbol),
      ) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/chatAppearance.ts#setChatCustomizationWithinTransaction' ||
        finding.target === 'src/db/repositories/chats.ts#setChatMuteWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/chatActions.ts#'))),
  );
  const chatAppearanceTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('updateChatAppearance') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/chatAppearance.ts#setChatAppearanceWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/chatActions.ts#'))),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/services/featureSettingsCommands.ts#finishPermissionOnboarding.<callback:709a896369>:mutator-call:4fd32f61a8df',
    ].sort(),
  );
  assert.deepEqual(
    chatAppearanceTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#updateChatAppearance.<callback:a52e69008e>.<callback:a4a4f489ab>:mutator-call:a3e90d5b284c',
      'src/services/chatActions.ts#updateChatAppearance.<callback:a52e69008e>:mutator-call:a9658d09049c',
      'src/services/chatActions.ts#updateChatAppearance.<callback:a52e69008e>:mutator-call:e718c205d92d',
    ].sort(),
  );
  assert.deepEqual(
    chatSettingsPreferenceTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#resetChatLocalPreferences.<callback:5186ac7666>.<callback:63de6d5552>:mutator-call:3cbd76759ff2',
      'src/services/chatActions.ts#resetChatLocalPreferences.<callback:5186ac7666>.<callback:63de6d5552>:mutator-call:672a4295bae0',
      'src/services/chatActions.ts#resetChatLocalPreferences.<callback:5186ac7666>:mutator-call:7392b85d41c5',
      'src/services/chatActions.ts#resetChatLocalPreferences.<callback:5186ac7666>:mutator-call:a9cd1d0d27f5',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>.<callback:df7eb4dfd5>:mutator-call:fff2c3df103d',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>:mutator-call:45188afd5c9d',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>:mutator-call:ff21837237be',
      'src/services/chatActions.ts#updateChatCustomization.<callback:f581c08ebb>.<callback:1b5bbbd65e>:mutator-call:730a44cfe2b8',
      'src/services/chatActions.ts#updateChatCustomization.<callback:f581c08ebb>:mutator-call:d10f1cc01664',
      'src/services/chatActions.ts#updateChatCustomization.<callback:f581c08ebb>:mutator-call:fcfcd294d82a',
    ].sort(),
  );
  assert.deepEqual(
    featureSettingTransactions.map((finding) => finding.id).sort(),
    [
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setAutoDownloadDestination.<callback:28c2902011>:mutator-call:871620dfdfc6',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setAutoDownloadDestination:mutator-call:a26397b9b8de',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setAutoDownloadDestination:mutator-call:f5771ac5ff88',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setFlag.<callback:80c80d5352>:mutator-call:9ccbe5ed583b',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setFlag:mutator-call:51b5050425db',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setFlag:mutator-call:82d3c0c91fe5',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setMaxConcurrentDownloads.<callback:62a8e00576>:mutator-call:14d9adb34146',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setMaxConcurrentDownloads:mutator-call:359ad75a4f18',
      'src/state/featureSettingsStore.ts#<callback:75c0086a87>.setMaxConcurrentDownloads:mutator-call:35ef614f5e5b',
    ].sort(),
  );
  assert.deepEqual(
    permissionOnboardingTransactions.map((finding) => finding.id).sort(),
    [
      'src/state/featureSettingsStore.ts#completePermissionOnboarding.<callback:4c0b01ae7f>:mutator-call:b1453f9eca38',
      'src/state/featureSettingsStore.ts#completePermissionOnboarding:mutator-call:163756f4a357',
      'src/state/featureSettingsStore.ts#completePermissionOnboarding:mutator-call:a81286d61932',
    ].sort(),
  );
  assert.deepEqual(
    customThemeTransactions.map((finding) => finding.id).sort(),
    [
      'src/state/themeStore.ts#<callback:2281b2e3e0>.clearCustomTheme.<callback:3d4db5413f>:mutator-call:48f115f8f4e7',
      'src/state/themeStore.ts#<callback:2281b2e3e0>.clearCustomTheme:mutator-call:07ee3458db41',
      'src/state/themeStore.ts#<callback:2281b2e3e0>.clearCustomTheme:mutator-call:9c61595b9b7e',
      'src/state/themeStore.ts#<callback:2281b2e3e0>.setCustomTheme.<callback:096d9b3756>:mutator-call:1207f46aa710',
      'src/state/themeStore.ts#<callback:2281b2e3e0>.setCustomTheme:mutator-call:07c82ca7ed59',
      'src/state/themeStore.ts#<callback:2281b2e3e0>.setCustomTheme:mutator-call:8783edd1784f',
    ].sort(),
  );
  assert.deepEqual(
    scheduledHistoryTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>.<callback:be2a685944>:mutator-call:211114e3d101',
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>:mutator-call:2a14c566d346',
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>:mutator-call:a18389a7fa4c',
    ].sort(),
  );
  assert.deepEqual(
    markAllReadTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#markAllChatsRead.<callback:c1af206d58>.<callback:ce8558bae3>:mutator-call:06b61d4ce067',
      'src/services/chatActions.ts#markAllChatsRead.<callback:c1af206d58>:mutator-call:b2a54e1ab9af',
      'src/services/chatActions.ts#markAllChatsRead.<callback:c1af206d58>:mutator-call:f44a034cf669',
    ].sort(),
  );
  assert.deepEqual(
    inboxPreferenceTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#setChatArchived.<callback:addd45115f>.<callback:c406ab49dc>:mutator-call:c5b362dfbac5',
      'src/services/chatActions.ts#setChatArchived.<callback:addd45115f>:mutator-call:11e8006fa75c',
      'src/services/chatActions.ts#setChatArchived.<callback:addd45115f>:mutator-call:f55d0850873e',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>.<callback:df7eb4dfd5>:mutator-call:fff2c3df103d',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>:mutator-call:45188afd5c9d',
      'src/services/chatActions.ts#setChatMuted.<callback:f5111910d0>:mutator-call:ff21837237be',
      'src/services/chatActions.ts#setChatPinned.<callback:292474dbe8>.<callback:610d973b6a>:mutator-call:d069f0ae2e74',
      'src/services/chatActions.ts#setChatPinned.<callback:292474dbe8>:mutator-call:ee9a99c798bf',
      'src/services/chatActions.ts#setChatPinned.<callback:292474dbe8>:mutator-call:f67fba6bccda',
    ].sort(),
  );
});

test('certifies exactly the reviewed ordinary-send delegation edges', () => {
  const findings = scanProjectDbWrites();
  const paths = new Set([
    'src/services/notifications/actions.ts',
    'src/services/send/outgoingQueueService.ts',
    'src/services/send/sendAttachmentService.ts',
    'src/services/send/sendContactService.ts',
    'src/services/send/sendOutcome.ts',
    'src/services/send/sendReactionService.ts',
    'src/services/send/sendService.ts',
  ]);
  const delegated = findings.filter(
    (finding) => paths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const failureTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendOutcome.ts' &&
      finding.symbol.startsWith('handleSendFailure') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const successTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendOutcome.ts' &&
      finding.symbol.startsWith('reconcileSendOutcome') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#markOutgoingSentNoGuidWithinTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendOutcome.ts#reconcileSendOutcome.<callback:',
          ))),
  );
  const outgoingQueueClaimTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/outgoingQueueService.ts' &&
      finding.symbol.startsWith('runOutgoingQueueBody.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoingRetry.ts#claimOutgoingForSendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/outgoingQueueService.ts#runOutgoingQueueBody.<callback:',
          ))),
  );
  const outgoingQueueRetirementTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/outgoingQueueService.ts' &&
      finding.symbol.startsWith('retireUnsendableOutgoing') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/outgoing.ts#retireOutgoingWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/outgoingQueueService.ts#retireUnsendableOutgoing.<callback:',
          ))),
  );
  const outgoingAttachmentInsertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendAttachmentService.ts' &&
      finding.symbol.startsWith('sendImageMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/attachmentCache.ts#commitAttachmentCacheReservation' ||
        finding.target ===
          'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendAttachmentService.ts#sendImageMessage.<callback:',
          ))),
  );
  const outgoingContactInsertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendContactService.ts' &&
      finding.symbol.startsWith('sendContactMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#insertOutgoingContactWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendContactService.ts#sendContactMessage.<callback:',
          ))),
  );
  const outgoingReactionInsertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendReactionService.ts' &&
      finding.symbol.startsWith('sendReactionMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#insertOutgoingReactionWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendReactionService.ts#sendReactionMessage.<callback:',
          ))),
  );
  const outgoingTextInsertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendService.ts' &&
      finding.symbol.startsWith('sendTextMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/outgoing.ts#insertOutgoingTextWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendService.ts#sendTextMessage.<callback:',
          ))),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/services/notifications/actions.ts#handleNotificationAction.<callback:383ea8d776>:mutator-call:f5e067703ee5',
      'src/services/notifications/actions.ts#handleNotificationActionForAccount:mutator-call:6c2fa704827f',
      'src/services/notifications/actions.ts#handleNotificationActionForAccount:mutator-call:d1008c7afb46',
      'src/services/notifications/actions.ts#loveMessage:mutator-call:83b1671c589d',
      'src/services/notifications/actions.ts#replyTo:mutator-call:a4a5d51a8f95',
      'src/services/send/outgoingQueueService.ts#resendOutgoingRow.<callback:181ea993ff>:mutator-call:fcca55f5e353',
      'src/services/send/outgoingQueueService.ts#resendOutgoingRow.<callback:49d47bc9dc>:mutator-call:ad52ad6af0e9',
      'src/services/send/outgoingQueueService.ts#resendOutgoingRow.<callback:49d47bc9dc>:mutator-call:ad52ad6af0e9:2',
      'src/services/send/outgoingQueueService.ts#resendOutgoingRow.<callback:e6daa15e91>:mutator-call:a1862003ebf3',
      'src/services/send/sendAttachmentService.ts#sendImageMessage:mutator-call:2e3d7266513e',
      'src/services/send/sendAttachmentService.ts#sendImageMessage:mutator-call:b12265a94c42',
      'src/services/send/sendContactService.ts#sendContactMessage:mutator-call:091ee2e61ccd',
      'src/services/send/sendContactService.ts#sendContactMessage:mutator-call:f3987a155aed',
      'src/services/send/sendReactionService.ts#sendReactionMessage:mutator-call:4722f6c1c506',
      'src/services/send/sendReactionService.ts#sendReactionMessage:mutator-call:e8547c9b8ebc',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:04c64cabafc4',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:2a25e55b8b30',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:bdeed6c57910',
    ].sort(),
  );
  assert.deepEqual(
    outgoingAttachmentInsertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendAttachmentService.ts#sendImageMessage.<callback:be9e092e28>:mutator-call:64e0c86ab356',
      'src/services/send/sendAttachmentService.ts#sendImageMessage.<callback:be9e092e28>:mutator-call:dd1ad3915782',
      'src/services/send/sendAttachmentService.ts#sendImageMessage:mutator-call:416a9b797aaf',
      'src/services/send/sendAttachmentService.ts#sendImageMessage:mutator-call:80f38074242e',
    ].sort(),
  );
  assert.deepEqual(
    outgoingContactInsertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendContactService.ts#sendContactMessage.<callback:579fb0f07b>:mutator-call:9d87cf90b13e',
      'src/services/send/sendContactService.ts#sendContactMessage:mutator-call:27797dbe4479',
      'src/services/send/sendContactService.ts#sendContactMessage:mutator-call:63d697dcdb18',
    ].sort(),
  );
  assert.deepEqual(
    outgoingQueueClaimTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/outgoingQueueService.ts#runOutgoingQueueBody.<callback:fd2e59ed90>.<callback:ef896ff493>:mutator-call:3273a288d180',
      'src/services/send/outgoingQueueService.ts#runOutgoingQueueBody.<callback:fd2e59ed90>:mutator-call:7b452e2c0efa',
      'src/services/send/outgoingQueueService.ts#runOutgoingQueueBody.<callback:fd2e59ed90>:mutator-call:a62d23d465c7',
    ].sort(),
  );
  assert.deepEqual(
    outgoingQueueRetirementTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/outgoingQueueService.ts#retireUnsendableOutgoing.<callback:4fb0fd5796>:mutator-call:082adb25d74d',
      'src/services/send/outgoingQueueService.ts#retireUnsendableOutgoing:mutator-call:10b9cb63a5a1',
      'src/services/send/outgoingQueueService.ts#retireUnsendableOutgoing:mutator-call:ebe5f8857989',
    ].sort(),
  );
  assert.deepEqual(
    outgoingReactionInsertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendReactionService.ts#sendReactionMessage.<callback:bb2f03f995>:mutator-call:d61ca293f0db',
      'src/services/send/sendReactionService.ts#sendReactionMessage:mutator-call:affc16f291fa',
      'src/services/send/sendReactionService.ts#sendReactionMessage:mutator-call:b3e3fdaf9d7a',
    ].sort(),
  );
  assert.deepEqual(
    outgoingTextInsertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendService.ts#sendTextMessage.<callback:3940f52b1d>:mutator-call:b8808f288fd5',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:03948a377dc5',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:e72ad74ae84c',
    ].sort(),
  );
  assert.deepEqual(
    successTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendOutcome.ts#reconcileSendOutcome.<callback:697c6fbfc2>:mutator-call:3094df649745',
      'src/services/send/sendOutcome.ts#reconcileSendOutcome.<callback:a142c06cb1>:mutator-call:83fb7347f21a',
      'src/services/send/sendOutcome.ts#reconcileSendOutcome:mutator-call:337ad594df75',
      'src/services/send/sendOutcome.ts#reconcileSendOutcome:mutator-call:7859b6c0463a',
      'src/services/send/sendOutcome.ts#reconcileSendOutcome:mutator-call:c1122a9108a5',
      'src/services/send/sendOutcome.ts#reconcileSendOutcome:mutator-call:e0d100734a46',
    ].sort(),
  );
  assert.deepEqual(
    failureTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendOutcome.ts#handleSendFailure.<callback:8a7e90a9b5>:mutator-call:cbfdaadfa96f',
      'src/services/send/sendOutcome.ts#handleSendFailure:mutator-call:95eb83c8fd28',
      'src/services/send/sendOutcome.ts#handleSendFailure:mutator-call:adfe95b7e2a5',
    ].sort(),
  );
});

test('certifies exactly the reviewed deferred-send service delegation edges', () => {
  const findings = scanProjectDbWrites();
  const paths = new Set([
    'src/db/repositories/scheduled.ts',
    'src/services/send/scheduleService.ts',
    'src/services/send/sendEditService.ts',
  ]);
  const delegated = findings.filter(
    (finding) => paths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const editApplyTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendEditService.ts' &&
      finding.symbol.startsWith('sendEditOnce') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#applyLocalEditWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendEditService.ts#sendEditOnce.<callback:',
          ))),
  );
  const editRevertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendEditService.ts' &&
      finding.symbol.startsWith('revertOptimisticEdit') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#revertLocalEditWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendEditService.ts#revertOptimisticEdit.<callback:',
          ))),
  );
  const unsendApplyTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendEditService.ts' &&
      finding.symbol.startsWith('sendUnsendOnce') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#applyLocalUnsendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendEditService.ts#sendUnsendOnce.<callback:',
          ))),
  );
  const unsendRevertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/sendEditService.ts' &&
      finding.symbol.startsWith('revertOptimisticUnsend') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#revertLocalUnsendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/sendEditService.ts#revertOptimisticUnsend.<callback:',
          ))),
  );
  const scheduledInsertTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/send/scheduleService.ts' &&
      finding.symbol.startsWith('scheduleTextMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/scheduled.ts#insertScheduledWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/send/scheduleService.ts#scheduleTextMessage.<callback:',
          ))),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/scheduled.ts#reconcileServerScheduled:mutator-call:6df044728f30',
      'src/services/send/scheduleService.ts#ensureScheduledRecovery.<callback:e4909b0f75>:mutator-call:b9ac52b2d1ee',
      'src/services/send/scheduleService.ts#recoverInterruptedScheduledRows:mutator-call:8fc2072469ba',
      'src/services/send/scheduleService.ts#runDueScheduled.settle:mutator-call:57f0ecf6912d',
      'src/services/send/scheduleService.ts#runDueScheduled.writeTerminal:mutator-call:934d3ba3156d',
      'src/services/send/scheduleService.ts#runDueScheduled.writeTerminal:mutator-call:ae2537472d84',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:129221ae16e0',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:2d6c1d03bc6e',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:3dac61ecbedb',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:d0f8f32a27ab',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:fe7c5860f178',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-reference:28e61216ad29',
      'src/services/send/sendEditService.ts#sendEdit.<callback:71e546f9ee>:mutator-call:58af46e14a80',
      'src/services/send/sendEditService.ts#sendEditOnce:mutator-call:a6eb301d978e',
      'src/services/send/sendEditService.ts#sendEditOnce:mutator-call:a6eb301d978e:2',
      'src/services/send/sendEditService.ts#sendUnsend.<callback:837ccd781d>:mutator-call:9ba6d956947c',
      'src/services/send/sendEditService.ts#sendUnsendOnce:mutator-call:9f4270c480f8',
      'src/services/send/sendEditService.ts#sendUnsendOnce:mutator-call:9f4270c480f8:2',
    ].sort(),
  );
  assert.deepEqual(
    editApplyTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendEditService.ts#sendEditOnce.<callback:2e1345eb02>:mutator-call:a1a20f9ed038',
      'src/services/send/sendEditService.ts#sendEditOnce:mutator-call:7b44b7789938',
      'src/services/send/sendEditService.ts#sendEditOnce:mutator-call:b26ddcfe9197',
    ].sort(),
  );
  assert.deepEqual(
    editRevertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendEditService.ts#revertOptimisticEdit.<callback:bcbc86276a>:mutator-call:3a035e3ce559',
      'src/services/send/sendEditService.ts#revertOptimisticEdit:mutator-call:536da85cdca4',
      'src/services/send/sendEditService.ts#revertOptimisticEdit:mutator-call:bea2b441da12',
    ].sort(),
  );
  assert.deepEqual(
    unsendApplyTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendEditService.ts#sendUnsendOnce.<callback:9b6c16c1d0>:mutator-call:5691003cf12c',
      'src/services/send/sendEditService.ts#sendUnsendOnce:mutator-call:053735d4ade9',
      'src/services/send/sendEditService.ts#sendUnsendOnce:mutator-call:a7367d0cdccd',
    ].sort(),
  );
  assert.deepEqual(
    unsendRevertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/sendEditService.ts#revertOptimisticUnsend.<callback:ce6ae5122c>:mutator-call:d66c9a3fba2f',
      'src/services/send/sendEditService.ts#revertOptimisticUnsend:mutator-call:74c66704d912',
      'src/services/send/sendEditService.ts#revertOptimisticUnsend:mutator-call:7d69e3e3aa4b',
    ].sort(),
  );
  assert.deepEqual(
    scheduledInsertTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/scheduleService.ts#scheduleTextMessage.<callback:bcbf452138>:mutator-call:ef3b92e88431',
      'src/services/send/scheduleService.ts#scheduleTextMessage:mutator-call:31eb04a40935',
      'src/services/send/scheduleService.ts#scheduleTextMessage:mutator-call:c6c6102cb4ec',
    ].sort(),
  );
});

test('certifies the exact residual repository delegations after explicit-owner conversion', () => {
  const findings = scanProjectDbWrites().filter(
    (finding) =>
      finding.detectedContext === 'coordinated-delegation' &&
      finding.target.startsWith('src/db/repositories/'),
  );
  const devFixtures = findings.filter(
    (finding) => finding.path === 'src/features/conversations/devSeed.ts',
  );
  const scheduledStateMachine = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/scheduled.ts' ||
      finding.path === 'src/services/send/index.ts' ||
      finding.path === 'src/services/send/scheduleService.ts' ||
      finding.path === 'src/services/send/sendService.ts',
  );
  const intentionalBoundaries = findings.filter(
    (finding) => !devFixtures.includes(finding) && !scheduledStateMachine.includes(finding),
  );

  assert.equal(devFixtures.length, 18);
  assert.equal(intentionalBoundaries.length, 22);
  assert.equal(scheduledStateMachine.length, 9);
  assert.deepEqual(
    findings.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/chats.ts#deleteChatLocal:mutator-call:4b0c893b8080',
      'src/db/repositories/chats.ts#resumeChatPurges:mutator-call:09fe46a88daa',
      'src/db/repositories/errorReports.ts#insertErrorReport:mutator-call:184b64238855',
      'src/db/repositories/scheduled.ts#reconcileServerScheduled:mutator-call:6df044728f30',
      'src/features/conversations/devSeed.ts#devEditFake.<callback:5de2143777>:mutator-call:22334d03d1f3',
      'src/features/conversations/devSeed.ts#devSendFake.<callback:3603f2d977>:mutator-call:5f9f1755f5ee',
      'src/features/conversations/devSeed.ts#devSendFakeImage.<callback:daefab75bd>:mutator-call:149c3a85dd8b',
      'src/features/conversations/devSeed.ts#devSendFakeReaction.<callback:052cf0ea2e>:mutator-call:3990f707da46',
      'src/features/conversations/devSeed.ts#devSendFakeReply.<callback:60ad1f7fd0>:mutator-call:f3c74c27a202',
      'src/features/conversations/devSeed.ts#devUnsendFake.<callback:0403b8ef33>:mutator-call:1c3853448684',
      'src/features/conversations/devSeed.ts#queueDevSendReconcile.<callback:a529712610>.reconcile:mutator-call:e5846ec828a7',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:263f9a2cf920',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:2d1329c7ad6c',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:4663da7605da',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:701132d9a72e',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:71542bb99e88',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:737bc3296081',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:98585f0a84d3',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:9baf717e8519',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:c189a52293cc',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:c27d9f7b2550',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:f915d3f0f0ea',
      'src/services/bootstrap.ts#wipeLocalCache:mutator-call:80814999e829',
      'src/services/bootstrap.ts#wipeLocalCache:mutator-call:972629a8899e',
      'src/services/chatActions.ts#movePinnedChat.<callback:f539212418>:mutator-call:d3f83b7bb36a',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:93672ec10293',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:e98149765f27',
      'src/services/paste/pasteInput.ts#loadPastedAttachmentProtectionPaths:mutator-call:2756cd6e5177',
      'src/services/realtime/incomingEventDispatcher.ts#DurableRealtimeDispatcher.persist:mutator-call:6fde253c2f8b',
      'src/services/realtime/incomingEventDispatcher.ts#DurableRealtimeDispatcher.persist:mutator-call:8c46c894d3aa',
      'src/services/realtime/incomingEventDrain.ts#IncomingEventDrain.drainFlight:mutator-call:45ee0a84041c',
      'src/services/realtime/incomingEventDrain.ts#IncomingEventDrain.processClaim:mutator-call:28df56079c8d',
      'src/services/realtime/incomingEventDrain.ts#IncomingEventDrain.processClaim:mutator-call:3cf169c31a85',
      'src/services/realtime/incomingEventDrain.ts#IncomingEventDrain.processClaim:mutator-call:6cc62ed5573d',
      'src/services/realtime/incomingEventDrain.ts#IncomingEventDrain.processClaim:mutator-call:b0a846e7dfb7',
      'src/services/realtime/incomingEventDrain.ts#durableContext.markDbAppliedWithinTransaction:mutator-call:737d7a3d436b',
      'src/services/send/index.ts#syncScheduledFromServer.<callback:c129c31bd8>:mutator-call:1a675a1023a2',
      'src/services/send/index.ts#syncScheduledFromServer.<callback:c129c31bd8>:mutator-call:73312ae182ae',
      'src/services/send/scheduleService.ts#recoverInterruptedScheduledRows:mutator-call:8fc2072469ba',
      'src/services/send/scheduleService.ts#runDueScheduled.writeTerminal:mutator-call:934d3ba3156d',
      'src/services/send/scheduleService.ts#runDueScheduled.writeTerminal:mutator-call:ae2537472d84',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:3dac61ecbedb',
      'src/services/send/scheduleService.ts#runDueScheduled:mutator-call:fe7c5860f178',
      'src/services/send/sendService.ts#sendTextMessage:mutator-call:04c64cabafc4',
      'src/services/sync/engine.ts#syncAllChats:mutator-call:d025e1f31f26',
      'src/services/sync/engine.ts#syncChatMessageRange:mutator-call:34deba18cbca',
      'src/services/sync/engine.ts#syncSingleChat:mutator-call:3c8efb8e47a5',
      'src/services/syncControl.ts#runSync:mutator-call:1c0575e425d1',
      'src/services/syncControl.ts#runSync:mutator-call:3cf984fb6208',
    ].sort(),
  );
});

test('certifies exactly the reviewed send front-door delegation edges', () => {
  const findings = scanProjectDbWrites();
  const sendFrontDoorFindings = findings.filter(
    (finding) => finding.path === 'src/services/send/index.ts',
  );
  const delegated = sendFrontDoorFindings.filter(
    (finding) => finding.detectedContext === 'coordinated-delegation',
  );
  const cancelScheduledTransaction = sendFrontDoorFindings.filter(
    (finding) =>
      finding.symbol.startsWith('cancelScheduled.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const retryClaimTransaction = sendFrontDoorFindings.filter(
    (finding) =>
      finding.symbol.startsWith('retry.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetryWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/send/index.ts#retry.<callback:'))),
  );
  const discardMessageTransaction = sendFrontDoorFindings.filter(
    (finding) =>
      finding.symbol.startsWith('discardMessage.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#discardOutgoingMessageWithinTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#deleteMessageLocalWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/send/index.ts#discardMessage.<callback:'))),
  );
  const clearScheduledHistoryTransaction = sendFrontDoorFindings.filter(
    (finding) =>
      finding.symbol.startsWith('clearScheduledHistoryItem.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const editScheduledTransaction = sendFrontDoorFindings.filter(
    (finding) =>
      finding.symbol.includes('.persistPatch') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/scheduled.ts#updateScheduledWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.includes('.persistPatch.<callback:'))),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>:mutator-call:62b0ffba8707',
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>:mutator-call:bba07d1c582e',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>:mutator-call:3e0d7582bc2c',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>:mutator-call:3e0d7582bc2c:2',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>:mutator-call:b3039aaa43d0',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>:mutator-call:bdc77bdcd522',
      'src/services/send/index.ts#fireDueScheduled.<callback:0a6836762d>:mutator-call:7402c4c31861',
      'src/services/send/index.ts#fireDueScheduledWithDevelopmentSender.<callback:0d6a663823>:mutator-call:a9efdbe22d70',
      'src/services/send/index.ts#pickAndSendContact.<callback:4a34f6e20d>:mutator-call:3494b022ac25',
      'src/services/send/index.ts#react.<callback:2a9e50aa06>:mutator-call:51ae9ba2c80c',
      'src/services/send/index.ts#reply.<callback:82d8d37cdf>:mutator-call:5af837449254',
      'src/services/send/index.ts#schedule.<callback:ec99a4a3ef>:mutator-call:7f1fac39c380',
      'src/services/send/index.ts#send.<callback:a9b9e4712f>:mutator-call:68982b8cb319',
      'src/services/send/index.ts#sendContactCard.<callback:7880c0d756>:mutator-call:5ae33ad44a99',
      'src/services/send/index.ts#sendImage.<callback:3e5d127268>:mutator-call:e13c9737cd25',
      'src/services/send/index.ts#sendImages.<callback:644cd98236>.<callback:293c535c7f>:mutator-call:148a999c74e6',
      'src/services/send/index.ts#syncScheduledFromServer.<callback:c129c31bd8>:mutator-call:1a675a1023a2',
      'src/services/send/index.ts#syncScheduledFromServer.<callback:c129c31bd8>:mutator-call:73312ae182ae',
    ].sort(),
  );

  assert.deepEqual(
    cancelScheduledTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#cancelScheduled.<callback:65476a8afb>.<callback:a851d931f6>:mutator-call:3c7e71894c98',
      'src/services/send/index.ts#cancelScheduled.<callback:65476a8afb>:mutator-call:0b12396b320f',
      'src/services/send/index.ts#cancelScheduled.<callback:65476a8afb>:mutator-call:ac5ab63b2745',
    ].sort(),
  );
  assert.deepEqual(
    retryClaimTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#retry.<callback:eca51ea93a>.<callback:4478d45b13>:mutator-call:32d6ff39e45d',
      'src/services/send/index.ts#retry.<callback:eca51ea93a>:mutator-call:3092ba25376d',
      'src/services/send/index.ts#retry.<callback:eca51ea93a>:mutator-call:e8b1ba719cf4',
    ].sort(),
  );
  assert.deepEqual(
    discardMessageTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>.<callback:5fed71ee07>:mutator-call:986b92faa7d9',
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>.<callback:5fed71ee07>:mutator-call:a8d83da321cf',
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>:mutator-call:1abb626333b6',
      'src/services/send/index.ts#discardMessage.<callback:f7610a8b8e>:mutator-call:d2b77772e5ec',
    ].sort(),
  );
  assert.deepEqual(
    clearScheduledHistoryTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>.<callback:be2a685944>:mutator-call:211114e3d101',
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>:mutator-call:2a14c566d346',
      'src/services/send/index.ts#clearScheduledHistoryItem.<callback:48588e5ef4>:mutator-call:a18389a7fa4c',
    ].sort(),
  );
  assert.deepEqual(
    editScheduledTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/send/index.ts#editScheduled.<callback:f519119574>.persistPatch.<callback:4cb2405734>:mutator-call:580db6ed626e',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>.persistPatch:mutator-call:4c70b4d099b8',
      'src/services/send/index.ts#editScheduled.<callback:f519119574>.persistPatch:mutator-call:9a5e1dfb2592',
    ].sort(),
  );
  assert.equal(sendFrontDoorFindings.length, 34);
});

test('certifies exactly the reviewed conversation-action delegation edges', () => {
  const findings = scanProjectDbWrites();
  const paths = new Set(['src/features/conversations/devSeed.ts', 'src/services/chatActions.ts']);
  const delegated = findings.filter(
    (finding) => paths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const markReadTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('markRead.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const markUnreadTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('markUnread.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const cancelServerScheduledTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('cancelServerScheduledForChat') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const cancelReminderCleanupTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('cancelRemindersForChat') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/features/conversations/devSeed.ts#devEditFake.<callback:5de2143777>:mutator-call:22334d03d1f3',
      'src/features/conversations/devSeed.ts#devSendFake.<callback:3603f2d977>:mutator-call:5f9f1755f5ee',
      'src/features/conversations/devSeed.ts#devSendFakeImage.<callback:daefab75bd>:mutator-call:149c3a85dd8b',
      'src/features/conversations/devSeed.ts#devSendFakeReaction.<callback:052cf0ea2e>:mutator-call:3990f707da46',
      'src/features/conversations/devSeed.ts#devSendFakeReply.<callback:60ad1f7fd0>:mutator-call:f3c74c27a202',
      'src/features/conversations/devSeed.ts#devUnsendFake.<callback:0403b8ef33>:mutator-call:1c3853448684',
      'src/features/conversations/devSeed.ts#queueDevSendReconcile.<callback:a529712610>.reconcile:mutator-call:e5846ec828a7',
      'src/features/conversations/devSeed.ts#queueDevSendReconcile.<callback:a529712610>:mutator-reference:7993eb4dd862',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:263f9a2cf920',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:2d1329c7ad6c',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:4663da7605da',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:701132d9a72e',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:71542bb99e88',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:737bc3296081',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:98585f0a84d3',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:9baf717e8519',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:c189a52293cc',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:c27d9f7b2550',
      'src/features/conversations/devSeed.ts#seedFixtures:mutator-call:f915d3f0f0ea',
      'src/services/chatActions.ts#deleteChat.<callback:f472676191>:mutator-call:7a4702559112',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:3c4dc28c8ea2',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:3c4dc28c8ea2:2',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:547b14db746a',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:8ed8e4254d1b',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:8ed8e4254d1b:2',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:93672ec10293',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:d3a2be781833',
      'src/services/chatActions.ts#deleteChatForAccount:mutator-call:e98149765f27',
      'src/services/chatActions.ts#movePinnedChat.<callback:f539212418>:mutator-call:d3f83b7bb36a',
    ].sort(),
  );
  assert.deepEqual(
    markReadTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#markRead.<callback:4923a4cef3>.<callback:f2c8eca326>:mutator-call:5beeafb66653',
      'src/services/chatActions.ts#markRead.<callback:4923a4cef3>:mutator-call:dfec54e681be',
      'src/services/chatActions.ts#markRead.<callback:4923a4cef3>:mutator-call:fcc9aef62714',
    ].sort(),
  );
  assert.deepEqual(
    markUnreadTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#markUnread.<callback:dbe9d133c5>.<callback:add0a7f05b>:mutator-call:d8cbd79b8427',
      'src/services/chatActions.ts#markUnread.<callback:dbe9d133c5>:mutator-call:01f6d1879a3c',
      'src/services/chatActions.ts#markUnread.<callback:dbe9d133c5>:mutator-call:6019b26b2128',
    ].sort(),
  );
  assert.deepEqual(
    cancelServerScheduledTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#cancelServerScheduledForChat.<callback:dc7ea326bb>:mutator-call:0d29d38fd70c',
      'src/services/chatActions.ts#cancelServerScheduledForChat:mutator-call:1837e71127eb',
      'src/services/chatActions.ts#cancelServerScheduledForChat:mutator-call:716a5525b26b',
    ].sort(),
  );
  assert.deepEqual(
    cancelReminderCleanupTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#cancelRemindersForChat.<callback:9d59a41411>:mutator-call:4d7918588245',
      'src/services/chatActions.ts#cancelRemindersForChat:mutator-call:10e5ab4c9101',
      'src/services/chatActions.ts#cancelRemindersForChat:mutator-call:f4f2756f3147',
    ].sort(),
  );
});

test('certifies exactly the reviewed sync delegation edges', () => {
  const findings = scanProjectDbWrites();
  const paths = new Set([
    'src/services/background/backgroundSync.ts',
    'src/services/backgrounds/syncedBackground.ts',
    'src/services/sync/engine.ts',
    'src/services/syncControl.ts',
  ]);
  const delegated = findings.filter(
    (finding) => paths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );
  const syncedBackgroundTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/services/backgrounds/syncedBackground.ts' &&
      finding.symbol.startsWith('runSyncedBackgroundRequest.') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/services/background/backgroundSync.ts#executeBackgroundSyncTask.synchronize:mutator-call:23a950f7cc3a',
      'src/services/background/backgroundSync.ts#recoverAndDrainBackgroundSchedules.<callback:c05c5f67e9>:mutator-call:d0fa0a16f072',
      'src/services/sync/engine.ts#fullSync:mutator-call:9cbcacf70584',
      'src/services/sync/engine.ts#fullSync:mutator-call:e0e0072c3545',
      'src/services/sync/engine.ts#syncAllChats:mutator-call:d025e1f31f26',
      'src/services/sync/engine.ts#syncChatMessageRange:mutator-call:34deba18cbca',
      'src/services/sync/engine.ts#syncChatMessages:mutator-call:2b2df2741e83',
      'src/services/sync/engine.ts#syncSingleChat:mutator-call:3c8efb8e47a5',
      'src/services/syncControl.ts#ensureChatSynced.<callback:910670867e>:mutator-call:c1b6e98cef19',
      'src/services/syncControl.ts#runSync:mutator-call:15ffb54cca3e',
      'src/services/syncControl.ts#runSync:mutator-call:1c0575e425d1',
      'src/services/syncControl.ts#runSync:mutator-call:3cf984fb6208',
      'src/services/syncControl.ts#runSync:mutator-call:471d6b8fb139',
      'src/services/syncControl.ts#runSync:mutator-call:60ab7d89146f',
      'src/services/syncControl.ts#runSync:mutator-call:62e252e57364',
      'src/services/syncControl.ts#runSync:mutator-call:62e252e57364:2',
      'src/services/syncControl.ts#runSync:mutator-call:ab6c20d59676',
      'src/services/syncControl.ts#runSync:mutator-call:c0d8b5d51637',
      'src/services/syncControl.ts#runSync:mutator-call:cad4b657fd83',
      'src/services/syncControl.ts#runSync:mutator-call:cad4b657fd83:2',
      'src/services/syncControl.ts#runSync:mutator-call:e410b409f997',
      'src/services/syncControl.ts#runSync:mutator-call:f2bc335e17da',
      'src/services/syncControl.ts#startFullRepair.<callback:a019ed9cf6>:mutator-call:7349d6139eeb',
      'src/services/syncControl.ts#startSync.<callback:4c2f340da4>:mutator-call:7042cc5b18c2',
      'src/services/syncControl.ts#startTargetedChatRepair.<callback:a243d0b024>:mutator-call:dfe6a528cca3',
      'src/services/syncControl.ts#startTargetedChatRepair.<callback:a243d0b024>:mutator-call:fd59b1934680',
    ].sort(),
  );
  assert.deepEqual(
    syncedBackgroundTransactions.map((finding) => finding.id).sort(),
    [
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:6ea5277294>.<callback:7387e3781d>:mutator-call:6bcf163c0bcb',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:6ea5277294>:mutator-call:7428789aa7d4',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:6ea5277294>:mutator-call:e6f6b158199c',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:399e3e6480>.<callback:bcb5586cc8>:mutator-call:b6873ce22c57',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:399e3e6480>:mutator-call:17a5f7a01d73',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:399e3e6480>:mutator-call:e796b0707ded',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:80d8fc6d66>.<callback:668ab24076>:mutator-call:b1c4bd00d1c9',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:80d8fc6d66>:mutator-call:65c8511e514c',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:80d8fc6d66>:mutator-call:bc9bdf219775',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:ad4898f757>.<callback:4f9ac2820f>:mutator-call:4c9290858373',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:ad4898f757>:mutator-call:331132e4ce88',
      'src/services/backgrounds/syncedBackground.ts#runSyncedBackgroundRequest.<callback:ad4898f757>:mutator-call:fcfa941fe19e',
    ].sort(),
  );
});

test('certifies exactly the reviewed attachment-cache transaction-context boundary', () => {
  const findings = scanProjectDbWrites();
  const leafSymbols = new Set([
    'adoptAttachmentCacheScanBatch',
    'claimAttachmentCachePathsForDeletedMessage',
    'claimAttachmentCachePathsForRetirement',
    'commitAttachmentCacheReservation',
    'confirmAttachmentCacheEntryDeleted',
    'createAttachmentCacheReservation',
    'recordAttachmentCacheAccess',
    'recordAttachmentCacheEntry',
    'repairMissingActiveAttachmentCacheEntry',
    'scheduleAttachmentCacheRetirementRetry',
  ]);
  const leaves = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/attachmentCache.ts' &&
      leafSymbols.has(finding.symbol.split('.<callback:')[0]) &&
      finding.detectedContext === 'withDbTransaction',
  );
  const snapshotOwners = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/attachmentCache.ts' &&
      finding.symbol === 'listPastedAttachmentProtectionPaths' &&
      finding.detectedContext === 'transaction-coordinator',
  );
  const delegatedPaths = new Set([
    'src/services/download/attachmentCacheCoordinator.ts',
    'src/services/download/attachmentCacheRecovery.ts',
    'src/services/paste/pasteInput.ts',
    'src/services/send/outgoingPasteOwnership.ts',
  ]);
  const delegated = findings.filter(
    (finding) =>
      delegatedPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );

  assert.deepEqual(
    [...leaves, ...snapshotOwners, ...delegated].map((finding) => finding.id).sort(),
    [
      'src/db/repositories/attachmentCache.ts#adoptAttachmentCacheScanBatch:sql-insert:99e2263a1304',
      'src/db/repositories/attachmentCache.ts#adoptAttachmentCacheScanBatch:sql-update:9609800f7a37',
      'src/db/repositories/attachmentCache.ts#claimAttachmentCachePathsForDeletedMessage.<callback:acf3a0c5f3>:mutator-call:e802ea4e2e1e',
      'src/db/repositories/attachmentCache.ts#claimAttachmentCachePathsForRetirement:sql-update:0fd63f0dd34a',
      'src/db/repositories/attachmentCache.ts#claimAttachmentCachePathsForRetirement:sql-update:300d170b9271',
      'src/db/repositories/attachmentCache.ts#commitAttachmentCacheReservation:sql-update:8061a1433826',
      'src/db/repositories/attachmentCache.ts#confirmAttachmentCacheEntryDeleted:sql-delete:f009e63ebbd9',
      'src/db/repositories/attachmentCache.ts#createAttachmentCacheReservation:sql-insert:23906c8fe812',
      'src/db/repositories/attachmentCache.ts#listPastedAttachmentProtectionPaths:mutator-call:543990b98095',
      'src/db/repositories/attachmentCache.ts#recordAttachmentCacheAccess:sql-update:3ca8ab1b4190',
      'src/db/repositories/attachmentCache.ts#recordAttachmentCacheEntry:sql-insert:1d5b6db8c26c',
      'src/db/repositories/attachmentCache.ts#repairMissingActiveAttachmentCacheEntry:sql-delete:b9564831e666',
      'src/db/repositories/attachmentCache.ts#repairMissingActiveAttachmentCacheEntry:sql-update:27b8750a28ca',
      'src/db/repositories/attachmentCache.ts#scheduleAttachmentCacheRetirementRetry:sql-update:94a4794dc91e',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.conformCurrentQuota.<callback:0dcf6c14a5>:mutator-call:7a455dfc3371',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.conformCurrentQuota:mutator-call:407a969fb807',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.conformCurrentQuota:mutator-call:b2ebff423c78',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.drainDueRetirements:mutator-call:95f380d7a8a7',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.publicReservation.release:mutator-call:f3b469f7fd19',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.reserve.<callback:545c570a32>:mutator-call:8fa5b0c434c3',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.reserve:mutator-call:57660cf8e9b1',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.reserve:mutator-call:790799f83301',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.retireInactiveEntries:mutator-call:00d0f346acf8',
      'src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.reuseExisting:mutator-call:38f52c5bccc4',
      'src/services/download/attachmentCacheRecovery.ts#drainCrashOwners:mutator-call:25bf144af248',
      'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery:mutator-call:12f416335881',
      'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery:mutator-call:5c4827eec261',
      'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery:mutator-call:bbf16113995b',
      'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery:mutator-call:d137fff87abf',
      'src/services/download/attachmentCacheRecovery.ts#recoverAttachmentCache.<callback:496dd08887>:mutator-call:953608ed77f1',
      'src/services/download/attachmentCacheRecovery.ts#retireInactiveFiles:mutator-call:0004c1106585',
      'src/services/paste/pasteInput.ts#attachPasteListener:mutator-reference:b3d6e6429035',
      'src/services/paste/pasteInput.ts#loadPastedAttachmentProtectionPaths:mutator-call:2756cd6e5177',
      'src/services/send/outgoingPasteOwnership.ts#createOutgoingPasteOwnershipPreparer.<callback:ca2b04b199>:mutator-call:4adc4cfd204e',
    ].sort(),
  );
  assert.equal(leaves.length, 13);
  assert.equal(snapshotOwners.length, 1);
  assert.equal(delegated.length, 20);
  assert.deepEqual(
    findings
      .filter((finding) => finding.path === 'src/services/download/attachmentCacheAccountScope.ts')
      .map((finding) => [finding.operation, finding.detectedContext]),
    [],
  );
});

test('certifies exactly the reviewed attachment-download delegation boundary', () => {
  const findings = scanProjectDbWrites();
  const reviewedPaths = new Set([
    'src/services/download/downloadService.ts',
    'src/services/download/index.ts',
    'src/ui/attachments/AudioAttachment.tsx',
    'src/ui/attachments/ContactCard.tsx',
    'src/ui/attachments/FileChip.tsx',
    'src/ui/attachments/ImageAttachment.tsx',
    'src/ui/attachments/LocationCard.tsx',
    'src/ui/attachments/StickerOverlay.tsx',
    'src/ui/attachments/VideoPlayer.tsx',
  ]);
  const delegated = findings.filter(
    (finding) =>
      reviewedPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'src/services/download/downloadService.ts#ensureDownloaded:mutator-call:aacca386ab26',
      'src/services/download/downloadService.ts#ensureDownloadedOutcome:mutator-call:4108587ea0f4',
      'src/services/download/index.ts#download:mutator-call:73f4bd568161',
      'src/services/download/index.ts#downloadScope.reserveCache:mutator-call:9a68094fc094',
      'src/services/download/index.ts#downloadScope.reuseCache:mutator-call:18cfc11c39e4',
      'src/services/download/index.ts#runDownload.<callback:6cd1952f6a>.<callback:5059ebce7a>:mutator-call:a91b975c46cc',
      'src/services/download/index.ts#runDownload:mutator-call:3dd749a9ad12',
      'src/ui/attachments/AudioAttachment.tsx#AudioAttachment.onToggle:mutator-call:14fdf073006e',
      'src/ui/attachments/AudioAttachment.tsx#AudioAttachment:mutator-reference:6c803e2f12fc',
      'src/ui/attachments/ContactCard.tsx#ContactCard.onPress.<callback:c626cc26f6>:mutator-call:d7520b586d39',
      'src/ui/attachments/ContactCard.tsx#ContactCard.onPress:mutator-call:1f8dbbc4c7e6',
      'src/ui/attachments/ContactCard.tsx#ContactCard.onPress:mutator-call:825631505f95',
      'src/ui/attachments/ContactCard.tsx#ContactCard:mutator-reference:6f03b1e5f758',
      'src/ui/attachments/FileChip.tsx#FileChip.onPress.<callback:08fd24739a>:mutator-call:b00e65e1611c',
      'src/ui/attachments/FileChip.tsx#FileChip.onPress:mutator-call:4783aae969eb',
      'src/ui/attachments/FileChip.tsx#FileChip.onPress:mutator-call:fcf22eadb47f',
      'src/ui/attachments/FileChip.tsx#FileChip:mutator-reference:8833b8ec6280',
      'src/ui/attachments/ImageAttachment.tsx#ImageAttachment.<callback:3ce78bcbe6>:mutator-call:d25f31bcd5a6',
      'src/ui/attachments/ImageAttachment.tsx#ImageAttachment.onPress:mutator-call:75c9a2b2048c',
      'src/ui/attachments/ImageAttachment.tsx#ImageAttachment:mutator-reference:82a46914061d',
      'src/ui/attachments/LocationCard.tsx#LocationCard.onPress:mutator-call:d714255e3467',
      'src/ui/attachments/LocationCard.tsx#LocationCard:mutator-reference:0f964b79c990',
      'src/ui/attachments/StickerOverlay.tsx#StickerTile.<callback:24b750a587>:mutator-call:3ce3ffc4583e',
      'src/ui/attachments/StickerOverlay.tsx#StickerTile.<callback:decf0839e5>:mutator-call:cffc02fe4b39',
      'src/ui/attachments/VideoPlayer.tsx#VideoPlayer.onPress:mutator-call:9e1d5a50a2f3',
      'src/ui/attachments/VideoPlayer.tsx#VideoPlayer:mutator-reference:53bdc004099c',
    ].sort(),
  );
  assert.equal(delegated.length, 26);
  assert.equal(
    findings.some((finding) => finding.symbol.includes('runTrackedDownloadTransaction')),
    false,
  );
});

test('eliminates the reviewed generic cache and contact transaction callbacks', () => {
  const findings = scanProjectDbWrites();
  const selected = findings.filter(
    (finding) =>
      finding.id ===
        'src/db/repositories/contacts.ts#applyContactMatchWithinTransaction:drizzle-update:5bf953ebc01e' ||
      finding.id ===
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>:mutator-call:098c54160192' ||
      finding.id ===
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>:mutator-call:be38fd49cfc4' ||
      finding.id ===
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>.<callback:85e2728caa>:mutator-call:cebe12beaa6a' ||
      finding.id ===
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>:mutator-call:81d14570571e' ||
      finding.id ===
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>:mutator-call:f096b5d8da50' ||
      finding.id ===
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>.<callback:d4b3663967>:mutator-call:efd43b2c46fc' ||
      finding.id ===
        'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery.<callback:909eb19064>:mutator-call:95c779ab9d88',
  );

  assert.deepEqual(
    selected.map((finding) => [finding.id, finding.detectedContext]).sort(),
    [
      [
        'src/db/repositories/contacts.ts#applyContactMatchWithinTransaction:drizzle-update:5bf953ebc01e',
        'withDbTransaction',
      ],
      [
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>:mutator-call:098c54160192',
        'withDbTransaction',
      ],
      [
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>:mutator-call:be38fd49cfc4',
        'transaction-coordinator',
      ],
      [
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:f0572f0ddc>.<callback:85e2728caa>:mutator-call:cebe12beaa6a',
        'withDbTransaction',
      ],
      [
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>:mutator-call:81d14570571e',
        'transaction-coordinator',
      ],
      [
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>:mutator-call:f096b5d8da50',
        'withDbTransaction',
      ],
      [
        'src/db/repositories/contacts.ts#matchContactsToHandles.<callback:ca444a7b8b>.<callback:d4b3663967>:mutator-call:efd43b2c46fc',
        'withDbTransaction',
      ],
      [
        'src/services/download/attachmentCacheRecovery.ts#performAttachmentCacheRecovery.<callback:909eb19064>:mutator-call:95c779ab9d88',
        'transaction-coordinator',
      ],
    ].sort(),
  );

  const protectedPaths = new Set([
    'src/db/repositories/contacts.ts',
    'src/services/download/attachmentCacheAccountScope.ts',
    'src/services/download/attachmentCacheRecovery.ts',
    'src/services/download/index.ts',
  ]);
  assert.equal(
    findings.some(
      (finding) =>
        protectedPaths.has(finding.path) && finding.operation === 'dynamic-coordinator-callback',
    ),
    false,
  );
  for (const path of protectedPaths) {
    const source = readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
    assert.doesNotMatch(source, /runTrackedDownloadTransaction|linkHandlesToContactsWithWriter/);
    if (path.includes('attachmentCache')) assert.doesNotMatch(source, /runTransaction/);
  }
});

test('certifies exactly the reviewed outer-lifecycle delegation boundary', () => {
  const findings = scanProjectDbWrites();
  const reviewedPaths = new Set([
    'app/(app)/_layout.tsx',
    'app/(setup)/manual.tsx',
    'app/(setup)/scan.tsx',
    'app/(setup)/welcome.tsx',
    'src/features/conversations/devFixtureSession.ts',
    'src/services/boot/foregroundBoot.ts',
    'src/services/bootstrap.ts',
    'src/services/lock.ts',
    'src/services/realtimeControl.ts',
  ]);
  const delegated = findings.filter(
    (finding) =>
      reviewedPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation',
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'app/(app)/_layout.tsx#ConnectedAppLayout.<callback:2f0bceb3e7>.<callback:cff4117220>:mutator-call:9c6ba7fb690a',
      'app/(setup)/manual.tsx#Manual.submit:mutator-call:5e0818285fda',
      'app/(setup)/manual.tsx#Manual:mutator-reference:cb409be66510',
      'app/(setup)/manual.tsx#Manual:mutator-reference:cb409be66510:2',
      'app/(setup)/scan.tsx#Scan.onBarcodeScanned:mutator-call:a94b6122a495',
      'app/(setup)/scan.tsx#Scan:mutator-reference:1cff632b86f3',
      'app/(setup)/welcome.tsx#Welcome.<callback:b1fa990a01>:mutator-call:7469e4d131fc',
      'app/(setup)/welcome.tsx#Welcome.devSeedAndOpen:mutator-call:da967f4afb4d',
      'src/features/conversations/devFixtureSession.ts#startDevFixtureSession.<callback:a9dbc72121>:mutator-call:b9b130735b2c',
      'src/features/conversations/devFixtureSession.ts#startDevFixtureSession:mutator-call:82b309039516',
      'src/services/boot/foregroundBoot.ts#<module>:mutator-reference:ace67f713c95',
      'src/services/boot/foregroundBoot.ts#<module>:mutator-reference:ca17968027de',
      'src/services/boot/foregroundBoot.ts#<module>:mutator-reference:fcf356fa69c2',
      'src/services/bootstrap.ts#activateForegroundBootSession:mutator-call:f0181c470642',
      'src/services/bootstrap.ts#cleanupAccountDatabase:mutator-call:9c87d79ec275',
      'src/services/bootstrap.ts#connect:mutator-call:0215e207799e',
      'src/services/bootstrap.ts#connect:mutator-call:e75fcdcefedc',
      'src/services/bootstrap.ts#forget:mutator-call:fde5b98b6a5c',
      'src/services/bootstrap.ts#hydrateSession:mutator-call:8cea0fe82b02',
      'src/services/bootstrap.ts#hydrateSession:mutator-call:8cea0fe82b02:2',
      'src/services/bootstrap.ts#hydrateSession:mutator-call:c52a509eefea',
      'src/services/bootstrap.ts#inspectForegroundBootSession:mutator-call:106ee7ea858e',
      'src/services/bootstrap.ts#prepareCandidateConnection:mutator-call:21c31fa08724',
      'src/services/bootstrap.ts#prepareCandidateConnection:mutator-call:a35e092f20bd',
      'src/services/bootstrap.ts#resolveBootSession:mutator-call:4be60ae765e3',
      'src/services/bootstrap.ts#runForget:mutator-call:8d5a9e357850',
      'src/services/bootstrap.ts#runOrAwaitForget:mutator-call:a0e09cd34906',
      'src/services/bootstrap.ts#startForget:mutator-call:976b6c7c71bc',
      'src/services/bootstrap.ts#wipeLocalCache:mutator-call:80814999e829',
      'src/services/bootstrap.ts#wipeLocalCache:mutator-call:972629a8899e',
      'src/services/lock.ts#completeUnlock:mutator-call:97831ab6c576',
      'src/services/realtimeControl.ts#approveNewServerUrl.reconnect:mutator-call:8f17c75f698b',
      'src/services/realtimeControl.ts#resumeRealtime:mutator-call:602dd63b9e5a',
    ].sort(),
  );
  assert.equal(delegated.length, 33);

  for (const suffix of [
    '8c40f7e0add0',
    'c3c00126e820',
    'ed99cc48f9ac',
    '19030e8b5855',
    '15ccf5091206',
    '04a93a9688cb',
  ]) {
    assert.equal(
      findings.some((finding) => finding.id.endsWith(suffix)),
      false,
    );
  }
});

test('certifies exactly the five reviewed startup and runtime driver adapter calls', () => {
  const findings = scanProjectDbWrites();
  const temporal = findings.filter(
    (finding) => finding.detectedContext === 'startup-migration-adapter',
  );
  const coordinated = findings.filter(
    (finding) => finding.detectedContext === 'runtime-drizzle-adapter',
  );

  assert.deepEqual(temporal.map((finding) => finding.id).sort(), [
    'src/db/database.ts#exec:raw-dynamic:cd5d0385470a',
    'src/db/database.ts#query:raw-dynamic:65140a624a68',
  ]);
  assert.deepEqual(
    coordinated.map((finding) => finding.id).sort(),
    [
      'src/db/database.ts#execute:raw-dynamic:6aeb161bfea5',
      'src/db/database.ts#executeAsync:raw-dynamic:dc5075d9aedf',
      'src/db/database.ts#executeRawAsync:raw-dynamic:d54c72385fdd',
    ].sort(),
  );
  assert.equal(
    findings.some((finding) => finding.detectedContext === 'driver-adapter'),
    false,
  );
});

test('certifies exactly the disposable driver self-test writes', () => {
  const findings = scanProjectDbWrites();
  const throwaway = findings.filter(
    (finding) =>
      finding.path === 'src/db/database.ts' &&
      finding.detectedContext === 'throwaway-database' &&
      ['deleteDriverSelfTestDatabase', 'runDbDriverSelfTest'].includes(finding.symbol) &&
      finding.target !== 'src/db/database.ts#runDbHistoricalMigrationSelfTest',
  );

  assert.deepEqual(
    throwaway.map((finding) => finding.id).sort(),
    [
      'src/db/database.ts#deleteDriverSelfTestDatabase:native-database-delete:7f88558fd106',
      'src/db/database.ts#runDbDriverSelfTest:drizzle-update:d2a95e01e17b',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:3dfafb738cb3',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:3dfafb738cb3:2',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:50cd95a59734',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:6e9f462c2573',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:6e9f462c2573:2',
      'src/db/database.ts#runDbDriverSelfTest:sql-delete:10901d46b32a',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:3222e4ca0230',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:652cb2618749',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:67cd17749f10',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:73a6969ab115',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:7e076a2d5a02',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:957cb3abc89d',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:95b1b00ea4f5',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:afeb55a1b579',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:da34dd2af660',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:e7736589b61c',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:ee6a3be14437',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:f00c3a8dc7c9',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:f2142ffad97d',
      'src/db/database.ts#runDbDriverSelfTest:sql-insert:fc639fb66318',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:2e4e15afe397',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:926c7398aabf',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:a1191cb9f05f',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:a2c4065836f3',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:c49d1a8c0add',
      'src/db/database.ts#runDbDriverSelfTest:sql-pragma:da75d0359a58',
      'src/db/database.ts#runDbDriverSelfTest:sql-schema:0c978f644327',
      'src/db/database.ts#runDbDriverSelfTest:sql-schema:1f9217b0d7ae',
      'src/db/database.ts#runDbDriverSelfTest:sql-schema:4dae6e8d3a0e',
      'src/db/database.ts#runDbDriverSelfTest:sql-schema:a38a282ed9df',
      'src/db/database.ts#runDbDriverSelfTest:sql-update:3e7d9beac678',
      'src/db/database.ts#runDbDriverSelfTest:sql-update:616f2665fd11',
      'src/db/database.ts#runDbDriverSelfTest:sql-update:967e86a8dcad',
      'src/db/database.ts#runDbDriverSelfTest:sql-update:ce33b8faf091',
      'src/db/database.ts#runDbDriverSelfTest:sql-update:f56ba7a56007',
      'src/db/database.ts#runDbDriverSelfTest:transaction-begin:5c7a13643a31',
      'src/db/database.ts#runDbDriverSelfTest:transaction-begin:5c7a13643a31:2',
      'src/db/database.ts#runDbDriverSelfTest:transaction-commit:f6472ddd0938',
      'src/db/database.ts#runDbDriverSelfTest:transaction-rollback:49402d35bbe6',
      'src/db/database.ts#runDbDriverSelfTest:transaction-rollback:49402d35bbe6:2',
      'src/db/database.ts#runDbDriverSelfTest:transaction-rollback:49402d35bbe6:3',
    ].sort(),
  );
  assert.equal(throwaway.length, 43);
});

test('certifies exactly the V3 disposable repository-history writes', () => {
  const findings = scanProjectDbWrites();
  const historySymbols = new Set([
    'deleteDriverHistorySelfTestDatabase',
    'driverHistoryNextMigrationRolledBack',
    'seedDriverHistoryFixture',
    'verifyDriverHistoryFixture',
    'verifyDriverHistoryFts',
    'runDbHistoricalMigrationSelfTest',
  ]);
  const throwaway = findings.filter(
    (finding) =>
      finding.path === 'src/db/database.ts' &&
      finding.detectedContext === 'throwaway-database' &&
      (historySymbols.has(finding.symbol) ||
        (finding.symbol === 'runDbDriverSelfTest' &&
          finding.target === 'src/db/database.ts#runDbHistoricalMigrationSelfTest')),
  );

  assert.deepEqual(
    throwaway.map((finding) => finding.id).sort(),
    [
      'src/db/database.ts#deleteDriverHistorySelfTestDatabase:native-database-delete:3128d7a4f737',
      'src/db/database.ts#driverHistoryNextMigrationRolledBack:sql-pragma:2d6705384f85',
      'src/db/database.ts#driverHistoryNextMigrationRolledBack:sql-pragma:5766a6aaea10',
      'src/db/database.ts#driverHistoryNextMigrationRolledBack:sql-pragma:94a19b5850c9',
      'src/db/database.ts#runDbDriverSelfTest:mutator-call:85271bee0dcf',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:12903965e8b2',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:385a825e1246',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:4b4ecfb48d70',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:6a4ca47cc776',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:781ab19f2c5a',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:9561f47c420a',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:a62e21f28f31',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:a62e21f28f31:2',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:cd8ae95f9ac5',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:d9302813dbdf',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:mutator-call:d9302813dbdf:2',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-pragma:08567fdb7003',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-pragma:1736365e8295',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-pragma:411fd161d3d5',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-pragma:a40ba555d13e',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-pragma:cd9294d29a79',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-schema:29d8e103eb01',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-schema:d325624455d6',
      'src/db/database.ts#runDbHistoricalMigrationSelfTest:sql-schema:d6e06500206d',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:17e545c79b2c',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:5985a7b2bf3f',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:817f65b4527c',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:82c463341e3f',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:90a0f5028f1b',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:929f397d7c63',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:965abd604193',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:a3b31a6ceb94',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:b449c6787aa3',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:b6b8fedfa7f7',
      'src/db/database.ts#seedDriverHistoryFixture:sql-insert:e3bae2841210',
      'src/db/database.ts#verifyDriverHistoryFixture:mutator-call:851edbc94d70',
      'src/db/database.ts#verifyDriverHistoryFts:sql-delete:1adccbf499dd',
      'src/db/database.ts#verifyDriverHistoryFts:sql-insert:105ca9af7dbb',
      'src/db/database.ts#verifyDriverHistoryFts:sql-update:aa0ced26e5fd',
    ].sort(),
  );
  assert.equal(throwaway.length, 39);
});

fullOnlyTest('V3 repository-history proof fails closed on historical-contract drift', () => {
  const approvedCounts = (findings) => {
    const historySymbols = new Set([
      'deleteDriverHistorySelfTestDatabase',
      'driverHistoryNextMigrationRolledBack',
      'seedDriverHistoryFixture',
      'verifyDriverHistoryFixture',
      'verifyDriverHistoryFts',
      'runDbHistoricalMigrationSelfTest',
    ]);
    return {
      history: findings.filter(
        (finding) =>
          finding.path === 'src/db/database.ts' &&
          finding.detectedContext === 'throwaway-database' &&
          (historySymbols.has(finding.symbol) ||
            (finding.symbol === 'runDbDriverSelfTest' &&
              finding.target === 'src/db/database.ts#runDbHistoricalMigrationSelfTest')),
      ).length,
      boot: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database-delegation' &&
          finding.target === 'src/db/database.ts#runDbDriverSelfTest',
      ).length,
    };
  };
  const cases = [
    {
      label: 'fixed historical filename is redirected to production',
      path: 'src/db/database.ts',
      before: "const DRIVER_HISTORY_SELF_TEST_DB_NAME = 'driver-history-selftest.db';",
      after: "const DRIVER_HISTORY_SELF_TEST_DB_NAME = 'gator.db';",
    },
    {
      label: 'private historical entry point gains another runtime consumer',
      path: 'src/db/database.ts',
      transform(source) {
        return `${source}\nexport const escapedDbHistoricalMigrationSelfTest = runDbHistoricalMigrationSelfTest;\n`;
      },
    },
    {
      label: 'wrong-key probe reuses the correct key',
      path: 'src/db/database.ts',
      before:
        "const DRIVER_HISTORY_SELF_TEST_WRONG_KEY = 'db-03b2a-wrong-public-throwaway-key-v1';",
      after: "const DRIVER_HISTORY_SELF_TEST_WRONG_KEY = 'db-03b2a-public-throwaway-key-v1';",
    },
    {
      label: 'reviewed 0024 prefix digest drifts',
      path: 'src/db/database.ts',
      before: "digest: 'd7cce2d30a027e90dc2bd046fea104037c04c8128099161608ec41a21ad2bfbb',",
      after: "digest: '07cce2d30a027e90dc2bd046fea104037c04c8128099161608ec41a21ad2bfbb',",
    },
    {
      label: 'repository provenance accepts only digest length',
      path: 'src/db/database.ts',
      before: '          digest === history.digest,',
      after: '          digest.length === history.digest.length,',
    },
    {
      label: 'current-head case replaces a reviewed historical case',
      path: 'src/db/database.ts',
      before: '      if (history.count === 29) continue;',
      after: '      if (history.count === 27) continue;',
    },
    {
      label: 'abort trigger targets the reviewed head instead of the next migration',
      path: 'src/db/database.ts',
      before: "               WHEN NEW.name = '${history.next}'",
      after: "               WHEN NEW.name = '${history.head}'",
    },
    {
      label: 'abort classifier accepts an unrelated migration error',
      path: 'src/db/database.ts',
      before:
        '  return error instanceof Error && error.message.includes(DRIVER_HISTORY_STOP_MESSAGE);',
      after: '  return error instanceof Error;',
    },
    {
      label: 'prefix migration runner is detached',
      path: 'src/db/database.ts',
      before: '            await runMigrations(opRunner(prepared));',
      after: '            void runMigrations(opRunner(prepared));',
    },
    {
      label: 'temporary abort trigger is not dropped before the retry fixture',
      path: 'src/db/database.ts',
      before:
        "          await prepared.execute('DROP TRIGGER driver_history_stop_after_reviewed_head');",
      after:
        "          void prepared.execute('DROP TRIGGER driver_history_stop_after_reviewed_head');",
    },
    {
      label: 'correct-key continuity probe may write before the migration retry',
      path: 'src/db/database.ts',
      before:
        '        const readOnly = open({\n' +
        '          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,\n' +
        '          encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY,\n' +
        '          readOnly: true,\n' +
        '        });',
      after:
        '        const readOnly = open({\n' +
        '          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,\n' +
        '          encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY,\n' +
        '          readOnly: false,\n' +
        '        });',
    },
    {
      label: 'historical tail migration receives the production raw singleton',
      path: 'src/db/database.ts',
      before: '          const migrated = await runMigrations(opRunner(reopened));',
      after: '          const migrated = await runMigrations(opRunner(rawDb!));',
    },
    {
      label: 'historical migration no longer proves the exact current tail',
      path: 'src/db/database.ts',
      before: '              migrated.every((name, index) => name === expectedTail[index]) &&',
      after: '              migrated.length > 0 &&',
    },
    {
      label: 'historical migrated-data proof is bypassed',
      path: 'src/db/database.ts',
      before:
        '          requireDriverContract(await verifyDriverHistoryMigratedData(reopened, history));',
      after: '          requireDriverContract(true);',
    },
    {
      label: 'historical FTS transition proof is bypassed',
      path: 'src/db/database.ts',
      before: '          requireDriverContract(await verifyDriverHistoryFts(reopened, history));',
      after: '          requireDriverContract(true);',
    },
    {
      label: 'historical foreign-key integrity accepts violations',
      path: 'src/db/database.ts',
      before: '              foreignKeyViolations.length === 0 &&',
      after: '              foreignKeyViolations.length >= 0 &&',
    },
    {
      label: 'historical idempotence accepts a nonempty migration result',
      path: 'src/db/database.ts',
      before: '          requireDriverContract(idempotent.length === 0);',
      after: '          requireDriverContract(idempotent.length >= 0);',
    },
    {
      label: 'historical final cleanup is bypassed',
      path: 'src/db/database.ts',
      before: '    checks.historicalCleanup = deleteDriverHistorySelfTestDatabase();',
      after: '    checks.historicalCleanup = true;',
    },
    {
      label: 'driver result schema regresses from V3',
      path: 'src/db/database.ts',
      before: "      schema: 3,\n      suite: 'android-db-contract',\n      status: 'pass',",
      after: "      schema: 2,\n      suite: 'android-db-contract',\n      status: 'pass',",
    },
    {
      label: 'foreground success marker regresses from V3',
      path: 'src/services/boot/foregroundBoot.ts',
      before: 'logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(result)}`)',
      after: 'logger.info(`GATOR_DB_CONTRACT_V2 ${JSON.stringify(result)}`)',
      expected: { history: 39, boot: 0 },
    },
    {
      label: 'foreground internal-failure marker diverges from V3',
      path: 'src/services/boot/foregroundBoot.ts',
      before:
        'logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(DB_DRIVER_CONTRACT_INTERNAL_FAILURE)}`)',
      after:
        'logger.info(`GATOR_DB_CONTRACT_V2 ${JSON.stringify(DB_DRIVER_CONTRACT_INTERNAL_FAILURE)}`)',
      expected: { history: 39, boot: 0 },
    },
  ];

  const root = incomingIngressFixture();
  try {
    assert.deepEqual(approvedCounts(scanDbWrites({ root })), { history: 39, boot: 1 });
    for (const mutation of cases) {
      const file = resolve(root, mutation.path);
      const original = readFileSync(file, 'utf8');
      try {
        if (mutation.transform) {
          writeFileSync(file, mutation.transform(original));
        } else {
          replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
        }
        assert.deepEqual(
          approvedCounts(scanDbWrites({ root })),
          mutation.expected ?? { history: 0, boot: 0 },
          mutation.label,
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('certifies exactly the DB-03B1 disposable relaunch writes and handoffs', () => {
  const findings = scanProjectDbWrites();
  const directSymbols = new Set([
    'cleanupDbProcessRelaunchSelfTestDatabase',
    'prepareDbProcessRelaunchSelfTest',
    'resumeDbProcessRelaunchSelfTest',
  ]);
  const direct = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database' && directSymbols.has(finding.symbol),
  );
  const oldServiceSymbols = new Set(['finishPrepareFailure', 'runPreparePhase', 'runResumePhase']);
  const oldStartTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase',
  ]);
  const delegated = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database-delegation' &&
      ((finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
        (oldServiceSymbols.has(finding.symbol) ||
          (finding.symbol === 'runRecoveryPhase' &&
            finding.target === 'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase') ||
          (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
            oldStartTargets.has(finding.target)))) ||
        finding.target ===
          'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested'),
  );

  assert.deepEqual(direct.map((finding) => finding.id).sort(), [
    'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase:native-database-delete:860e30d458b6',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:mutator-call:2dc6c9d994e3',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:mutator-call:78a96f3a3bed',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:mutator-call:78a96f3a3bed:2',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:sql-insert:d06f16054f08',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:sql-pragma:98ade7597ab6',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:sql-schema:20987ce13c0a',
    'src/db/database.ts#prepareDbProcessRelaunchSelfTest:sql-schema:c1f4d0d378ed',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:mutator-call:7703c0036c7a',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:mutator-call:7703c0036c7a:2',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:mutator-call:a2933f18497f',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-pragma:97a60ddc35e9',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-pragma:9d9f6dc1a811',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-pragma:d39bb496244b',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-pragma:e8881cdf40b0',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-schema:1a0dd42737ff',
    'src/db/database.ts#resumeDbProcessRelaunchSelfTest:sql-schema:de2036f42ae3',
  ]);
  assert.deepEqual(delegated.map((finding) => finding.id).sort(), [
    'src/services/boot/devDbRelaunchContract.ts#finishPrepareFailure:mutator-call:c84e27e39a87',
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase:mutator-call:06e4b4c5d3f8',
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase:mutator-call:0f7bb0c84df8',
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase:mutator-call:45d67e550f11',
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase:mutator-call:95e3c615c793',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase:mutator-call:e834a6bf82ca',
    'src/services/boot/devDbRelaunchContract.ts#runResumePhase:mutator-call:67b1b319807d',
    'src/services/boot/devDbRelaunchContract.ts#runResumePhase:mutator-call:89fb75db5aa5',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:326aa359317e',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:67e695f5d505',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:dfdc7b4be6f1',
    'src/services/boot/foregroundBoot.ts#startForegroundBoot:mutator-call:165c37fb47c7',
  ]);
  assert.equal(direct.length, 17);
  assert.equal(delegated.length, 12);
});

test('certifies exactly the DB-03B2B1 active-WAL write-death boundary', () => {
  const findings = scanProjectDbWrites();
  const directSymbols = new Set([
    'cleanupDbActiveWalWriteDeathSelfTestDatabase',
    'retireDbActiveWalWriteDeathSelfTestDatabase',
    'prepareDbActiveWalWriteDeathSelfTest',
    'resumeDbActiveWalWriteDeathSelfTest',
  ]);
  const direct = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database' && directSymbols.has(finding.symbol),
  );
  const delegatedSymbols = new Set([
    'finishWalWriteDeathPrepareFailure',
    'runWalWriteDeathPreparePhase',
    'runWalWriteDeathResumePhase',
  ]);
  const recoveryTargets = new Set([
    'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase',
    'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase',
  ]);
  const startTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase',
  ]);
  const delegated = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database-delegation' &&
      finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
      (delegatedSymbols.has(finding.symbol) ||
        (finding.symbol === 'runWalWriteDeathRecoveryPhase' &&
          recoveryTargets.has(finding.target)) ||
        (finding.symbol === 'runRecoveryPhase' &&
          finding.target === 'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase') ||
        (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
          startTargets.has(finding.target))),
  );

  assert.deepEqual(direct.map((finding) => finding.id).sort(), [
    'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase:native-database-delete:8e13e65bfb20',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:mutator-call:bd30872c6ced',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:mutator-call:bd30872c6ced:2',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-insert:0a2d70af725a',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-insert:7486e5179484',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:1296d13830af',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:6cb3197a0e7f',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:842170241933',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:94f5ed4904f1',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:c21262db8e21',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:d4d476c6ec97',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-pragma:da4b09e3e792',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:sql-schema:c0583bd16b02',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:transaction-begin:4424eaa0f4f3',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:transaction-begin:4424eaa0f4f3:2',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:transaction-commit:101ad0ef4295',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:transaction-rollback:ff0044d35701',
    'src/db/database.ts#prepareDbActiveWalWriteDeathSelfTest:transaction-rollback:ff0044d35701:2',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:mutator-call:16f2286de9f7',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:mutator-call:2138da1e426f',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-insert:ccb9bc2c9d78',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-pragma:09713a4279c2',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-pragma:0fd91424ea23',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-pragma:15c65a528917',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-pragma:192261000ef7',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:sql-pragma:f02cf304acf4',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:transaction-begin:20fada601317',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:transaction-commit:4ef08fffbb12',
    'src/db/database.ts#resumeDbActiveWalWriteDeathSelfTest:transaction-rollback:5973ed080e9b',
    'src/db/database.ts#retireDbActiveWalWriteDeathSelfTestDatabase:mutator-call:79dc019c8e8d',
    'src/db/database.ts#retireDbActiveWalWriteDeathSelfTestDatabase:sql-pragma:6610a957a70e',
    'src/db/database.ts#retireDbActiveWalWriteDeathSelfTestDatabase:sql-pragma:70acd331c2b4',
    'src/db/database.ts#retireDbActiveWalWriteDeathSelfTestDatabase:sql-pragma:e87e5387e478',
  ]);
  assert.deepEqual(delegated.map((finding) => finding.id).sort(), [
    'src/services/boot/devDbRelaunchContract.ts#finishWalWriteDeathPrepareFailure:mutator-call:31fd203d923e',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase:mutator-call:f3c815a2f8ac',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase:mutator-call:3deb11b9fc39',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase:mutator-call:58a39f6a9679',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase:mutator-call:9dfa7859a02a',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase:mutator-call:c6f605742a76',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase:mutator-call:7a2962730f1e',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase:mutator-call:da8a8b5328ee',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathResumePhase:mutator-call:2d9378699f25',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathResumePhase:mutator-call:8d1c810b5187',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:8e5f8c2c6304',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:ca091b398fb4',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:e64fa57d29fa',
  ]);
  assert.equal(direct.length, 33);
  assert.equal(delegated.length, 13);
});

test('certifies exactly the DB-03B2B2 active-migration-death boundary', () => {
  const findings = scanProjectDbWrites();
  const directSymbols = new Set([
    'seedDbActiveMigrationFixture',
    'cleanupDbActiveMigrationDeathSelfTestDatabase',
    'retireDbActiveMigrationDeathSelfTestDatabase',
    'prepareDbActiveMigrationDeathSelfTest',
    'resumeDbActiveMigrationDeathSelfTest',
  ]);
  const direct = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database' && directSymbols.has(finding.symbol),
  );
  const delegatedSymbols = new Set([
    'finishActiveMigrationDeathPrepareFailure',
    'runActiveMigrationDeathPreparePhase',
    'runActiveMigrationDeathResumePhase',
    'runActiveMigrationDeathRecoveryPhase',
  ]);
  const startTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase',
  ]);
  const delegated = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database-delegation' &&
      finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
      (delegatedSymbols.has(finding.symbol) ||
        (finding.symbol === 'runRecoveryPhase' &&
          finding.target === 'src/db/database.ts#cleanupDbActiveMigrationDeathSelfTestDatabase') ||
        (finding.symbol === 'runWalWriteDeathRecoveryPhase' &&
          finding.target === 'src/db/database.ts#cleanupDbActiveMigrationDeathSelfTestDatabase') ||
        (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
          startTargets.has(finding.target))),
  );

  assert.deepEqual(direct.map((finding) => finding.id).sort(), [
    'src/db/database.ts#cleanupDbActiveMigrationDeathSelfTestDatabase:native-database-delete:ff711eb9d33c',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:141d9a18377f',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:141d9a18377f:2',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:141d9a18377f:3',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:254b29b633bb',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:3cfd0e0c8f97',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:mutator-call:c7abb8aa650a',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:3325773da814',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:35ad534021f8',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:9892b3f1c7e3',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:99b1a0573820',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:a67fc9cbd417',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:d5bda51e292b',
    'src/db/database.ts#prepareDbActiveMigrationDeathSelfTest:sql-pragma:eaa28d9b10fc',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:mutator-call:5ee851488aef',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:mutator-call:6f3aee398a18',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:mutator-call:6f3aee398a18:2',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:mutator-call:9a802871e899',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:04e15312f1b5',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:04e15312f1b5:2',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:0b110227b222',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:6ffd5dc1ecae',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:c2f4ef1e9fd6',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:c41b1d9e3f5f',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:d603c995b313',
    'src/db/database.ts#resumeDbActiveMigrationDeathSelfTest:sql-pragma:fa6f6c173b44',
    'src/db/database.ts#retireDbActiveMigrationDeathSelfTestDatabase:mutator-call:19e578aa2615',
    'src/db/database.ts#retireDbActiveMigrationDeathSelfTestDatabase:sql-pragma:0aa5a5c36cc7',
    'src/db/database.ts#retireDbActiveMigrationDeathSelfTestDatabase:sql-pragma:be383f8cf826',
    'src/db/database.ts#retireDbActiveMigrationDeathSelfTestDatabase:sql-pragma:f397641246bb',
    'src/db/database.ts#seedDbActiveMigrationFixture:sql-insert:5bfe29d2deac',
    'src/db/database.ts#seedDbActiveMigrationFixture:transaction-begin:0180d179a806',
    'src/db/database.ts#seedDbActiveMigrationFixture:transaction-commit:284a8b93b648',
    'src/db/database.ts#seedDbActiveMigrationFixture:transaction-rollback:0211c22bc703',
  ]);
  assert.deepEqual(delegated.map((finding) => finding.id).sort(), [
    'src/services/boot/devDbRelaunchContract.ts#finishActiveMigrationDeathPrepareFailure:mutator-call:0e8942f0e789',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase:mutator-call:05ba6bb2849a',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase:mutator-call:bb48d492c752',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase:mutator-call:bdcec4c50149',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase:mutator-call:bf77a4004308',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase:mutator-call:02c4d2f06909',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase:mutator-call:1485d9175c3e',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase:mutator-call:52ec4f1e8a66',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase:mutator-call:c2f4a2e3929b',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathResumePhase:mutator-call:6235ccc0af5a',
    'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathResumePhase:mutator-call:c6052b35d17e',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase:mutator-call:3e4b53a1402f',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase:mutator-call:3067733c44d4',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:0bbcb32791e8',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:31aa9673996a',
    'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:9bc5c78844a2',
  ]);
  assert.equal(direct.length, 34);
  assert.equal(delegated.length, 16);
});

test('certifies exactly the DB-02C runtime-concurrency writes and exclusive handoffs', () => {
  const findings = scanProjectDbWrites();
  const databaseSymbols = new Set([
    'cleanupDbRuntimeConcurrencySelfTestDatabase',
    'rawRekey',
    'runDbRuntimeConcurrencySelfTest',
  ]);
  const runtimeServiceSymbols = new Set([
    'finishRuntimeConcurrencyFailure',
    'runRuntimeConcurrencyPhase',
    'runRuntimeConcurrencyRecoveryPhase',
  ]);
  const runtimeStartTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase',
    'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase',
  ]);
  const certified = findings.filter(
    (finding) =>
      (finding.path === 'src/db/database.ts' && databaseSymbols.has(finding.symbol)) ||
      finding.path === 'src/services/boot/dbRuntimeConcurrencyWave.ts' ||
      (finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
        (runtimeServiceSymbols.has(finding.symbol) ||
          finding.target === 'src/db/database.ts#cleanupDbRuntimeConcurrencySelfTestDatabase' ||
          (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
            runtimeStartTargets.has(finding.target)))),
  );

  assert.deepEqual(
    certified.map((finding) => finding.id).sort(),
    [
      'src/db/database.ts#cleanupDbRuntimeConcurrencySelfTestDatabase:native-database-delete:c8b7acd29fe1',
      'src/db/database.ts#rawRekey:sql-pragma:ddc2470a0581',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:mutator-call:6d2f77f00160',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:mutator-call:6d2f77f00160:2',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:mutator-call:98c4b223c92b',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:sql-pragma:5fe2be0ec9b8',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:sql-pragma:e0e6e9973f0d',
      'src/db/database.ts#runDbRuntimeConcurrencySelfTest:sql-pragma:f7abad6fe3d2',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#count:raw-dynamic:194b38c0dc2f',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave.<callback:924687d0a1>:mutator-call:499477a70fe6',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:03e440125172',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:04b4fca63da2',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:04b4fca63da2:2',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:150264484d1d',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:189f55fb6c2e',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:2c5121e200af',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:3509064feb66',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:45be8e671e33',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:45f44e962bfd',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:6f56de572180',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:6fa4b9d0433f',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:75b6613ec9c7',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:95d97cd77af9',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:b78b41da9526',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:bcdace9d293d',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:da8a7a29ea3f',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:da8a7a29ea3f:2',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:mutator-call:779a08232837',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#runDbRuntimeConcurrencyWave:sql-insert:c225ba9768f7',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave.<callback:250c3794fc>:mutator-call:55ffe792a557',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave.<callback:7b24129e54>:mutator-call:8cb85d5f3bee',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave.<callback:7b24129e54>:mutator-call:98f7f8fb4e90',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:31b64135cad8',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:438c945711e6',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:53f5e929f07d',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:6395b5094423',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:a8582564276c',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:c22febfc7213',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:d60d21c42996',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:mutator-call:e1a5e8843d07',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:sql-insert:268fc51a1761',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:sql-insert:7418c90170ea',
      'src/services/boot/dbRuntimeConcurrencyWave.ts#submitOrderedCoordinatorWave:sql-insert:9266b8d70936',
      'src/services/boot/devDbRelaunchContract.ts#finishRuntimeConcurrencyFailure:mutator-call:997d9112a0e0',
      'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase:mutator-call:1485d9175c3e',
      'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase:mutator-call:ea193e30ffcb',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase:mutator-call:301e5cdc6904',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase:mutator-call:ba293dc8a9a8',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase:mutator-call:e21f80c86ea7',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase:mutator-reference:fec6f21ca7fe',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase:mutator-call:2697cff60054',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase:mutator-call:716ab824be25',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase:mutator-call:85dc498ee8c3',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase:mutator-call:d25f21ea1dbf',
      'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase:mutator-call:0102ba91a751',
      'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:8bffa75c6fb1',
      'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:b3653b4235b7',
      'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested:mutator-call:e9ba7858d27b',
    ].sort(),
  );
  assert.equal(
    certified.filter((finding) => finding.detectedContext === 'throwaway-database').length,
    13,
  );
  assert.equal(
    certified.filter((finding) => finding.detectedContext === 'throwaway-database-delegation')
      .length,
    45,
  );
  assert.equal(certified.length, 58);
});

fullOnlyTest(
  'DB-02C runtime-concurrency proof fails closed on capability and lifetime drift',
  () => {
    const databaseSymbols = new Set([
      'cleanupDbRuntimeConcurrencySelfTestDatabase',
      'rawRekey',
      'runDbRuntimeConcurrencySelfTest',
    ]);
    const runtimeServiceSymbols = new Set([
      'finishRuntimeConcurrencyFailure',
      'runRuntimeConcurrencyPhase',
      'runRuntimeConcurrencyRecoveryPhase',
    ]);
    const runtimeStartTargets = new Set([
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyPhase',
      'src/services/boot/devDbRelaunchContract.ts#runRuntimeConcurrencyRecoveryPhase',
    ]);
    const approvedCounts = (findings) => {
      const runtime = findings.filter(
        (finding) =>
          (finding.path === 'src/db/database.ts' && databaseSymbols.has(finding.symbol)) ||
          finding.path === 'src/services/boot/dbRuntimeConcurrencyWave.ts' ||
          (finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
            (runtimeServiceSymbols.has(finding.symbol) ||
              finding.target === 'src/db/database.ts#cleanupDbRuntimeConcurrencySelfTestDatabase' ||
              (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
                runtimeStartTargets.has(finding.target)))),
      );
      return {
        direct: runtime.filter((finding) => finding.detectedContext === 'throwaway-database')
          .length,
        delegated: runtime.filter(
          (finding) => finding.detectedContext === 'throwaway-database-delegation',
        ).length,
      };
    };
    const cases = [
      {
        label: 'fixed runtime filename redirected to production',
        path: 'src/db/database.ts',
        before:
          "const DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME = 'driver-runtime-concurrency-selftest.db';",
        after: "const DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME = 'gator.db';",
      },
      {
        label: 'new rekey value reuses the old disposable key',
        path: 'src/db/database.ts',
        before:
          "const DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B = 'db-02c-public-throwaway-key-b-v1';",
        after: "const DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B = 'db-02c-public-throwaway-key-a-v1';",
      },
      {
        label: 'runtime Drizzle client receives the production singleton',
        path: 'src/db/database.ts',
        before: 'const database = drizzle(drizzleAdapter(activeHandle)) as unknown as AppDatabase;',
        after: 'const database = drizzle(drizzleAdapter(rawDb!)) as unknown as AppDatabase;',
      },
      {
        label: 'runtime Drizzle client bypasses the reviewed adapter',
        path: 'src/db/database.ts',
        before: 'const database = drizzle(drizzleAdapter(activeHandle)) as unknown as AppDatabase;',
        after: 'const database = drizzle(activeHandle as never) as unknown as AppDatabase;',
      },
      {
        label: 'runtime migration call is detached from its awaited owner',
        path: 'src/db/database.ts',
        before: 'const appliedMigrations = await runMigrations(opRunner(activeHandle));',
        after:
          'const appliedMigrations: string[] = [];\n' +
          '    void runMigrations(opRunner(activeHandle));',
      },
      {
        label: 'rekey callback attempts to reacquire the global writer lock',
        path: 'src/services/boot/dbRuntimeConcurrencyWave.ts',
        before: '      await rawRekey();',
        after: '      await withDbWriteLock(rawRekey);',
      },
      {
        label: 'runtime wave capability gains another exported consumer',
        path: 'src/services/boot/dbRuntimeConcurrencyWave.ts',
        transform(source) {
          return `${source}\nexport const escapedRuntimeConcurrencyWave = runDbRuntimeConcurrencyWave;\n`;
        },
      },
      {
        label: 'retained DB owners are no longer awaited before native close',
        path: 'src/services/boot/dbRuntimeConcurrencyWave.ts',
        before: '    await Promise.allSettled(retained);',
        after: '    void Promise.allSettled(retained);',
      },
      {
        label: 'image-send callee detaches its optimistic DB owner',
        path: 'src/services/send/sendAttachmentService.ts',
        before: '    await withDbTransaction(\n      db,\n      async (context) => {',
        after: '    void withDbTransaction(\n      db,\n      async (context) => {',
      },
      {
        label: 'sync contact bypass helper detaches its reachable DB work',
        path: 'src/services/sync/engine.ts',
        before: '    await linkHandlesToContacts(db, unique, undefined, commitGuard);',
        after: '    void linkHandlesToContacts(db, unique, undefined, commitGuard);',
      },
      {
        label: 'realtime sink constructor installs a detached default hook',
        path: 'src/services/realtime/dbEventSink.ts',
        before:
          '    private readonly onMessageStored?: (messageId: number) => void | Promise<void>,',
        after:
          '    private readonly onMessageStored: (messageId: number) => void | Promise<void> = async () => undefined,',
      },
      {
        label: 'runtime send enables the production OS-notice namespace',
        path: 'src/services/boot/dbRuntimeConcurrencyWave.ts',
        before: "        { failureNoticeMode: 'suppressed' },",
        after: "        { failureNoticeMode: 'enabled' },",
      },
      {
        label: 'production image send enters the harness-only notice-suppression lane',
        path: 'src/services/send/index.ts',
        before: '        undefined,\n        pasteOwnership,\n      );',
        after:
          "        { failureNoticeMode: 'suppressed' },\n" +
          '        pasteOwnership,\n' +
          '      );',
      },
      {
        label: 'production image send drops the reviewed paste-ownership preparer',
        path: 'src/services/send/index.ts',
        before: '        pasteOwnership,\n      );',
        after: '        undefined,\n      );',
      },
      {
        label: 'production success call hides notice suppression inside a spread',
        path: 'src/services/send/sendService.ts',
        before: '    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard);',
        after:
          '    await reconcileSendOutcome(\n' +
          '      ...([\n' +
          '        db,\n' +
          '        tempGuid,\n' +
          '        server,\n' +
          '        now,\n' +
          '        effectiveCommitGuard,\n' +
          "        { failureNoticeMode: 'suppressed' },\n" +
          '      ] as const),\n' +
          '    );',
      },
      {
        label: 'production failure call hides notice suppression inside apply',
        path: 'src/services/send/sendService.ts',
        before:
          '    await handleSendFailure(\n' +
          '      db,\n' +
          '      tempGuid,\n' +
          '      e,\n' +
          "      'send',\n" +
          '      args.chatGuid,\n' +
          '      undefined,\n' +
          '      effectiveCommitGuard,\n' +
          '    );',
        after:
          '    await handleSendFailure.apply(null, [\n' +
          '      db,\n' +
          '      tempGuid,\n' +
          '      e,\n' +
          "      'send',\n" +
          '      args.chatGuid,\n' +
          '      undefined,\n' +
          '      effectiveCommitGuard,\n' +
          "      { failureNoticeMode: 'suppressed' },\n" +
          '    ]);',
      },
      {
        label: 'success outcome ignores OS-notice suppression',
        path: 'src/services/send/sendOutcome.ts',
        before:
          "  if (options?.failureNoticeMode !== 'suppressed') {\n    await clearFailedSendNotice(",
        after: '  if (true) {\n    await clearFailedSendNotice(',
      },
      {
        label: 'failure outcome ignores OS-notice suppression',
        path: 'src/services/send/sendOutcome.ts',
        before: "  if (reconciled && options?.failureNoticeMode !== 'suppressed') {",
        after: '  if (reconciled) {',
      },
      {
        label: 'final fixed-file cleanup is bypassed',
        path: 'src/db/database.ts',
        before: '    checks.databaseCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();',
        after: '    checks.databaseCleanup = true;',
      },
      {
        label: 'runtime request is dispatched into another relaunch lane',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        before:
          "    if (mode.kind === 'prepare') activeDbRelaunchContract = runRuntimeConcurrencyPhase();",
        after: "    if (mode.kind === 'prepare') activeDbRelaunchContract = runPreparePhase();",
      },
      {
        label: 'runtime marker prefix drifts from the host protocol',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        before: "const DB_RUNTIME_CONCURRENCY_MARKER_PREFIX = 'GATOR_DB_RUNTIME_CONCURRENCY_V1 ';",
        after: "const DB_RUNTIME_CONCURRENCY_MARKER_PREFIX = 'GATOR_DB_RUNTIME_CONCURRENCY_V2 ';",
      },
      {
        label: 'database entry point gains another runtime capability consumer',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        transform(source) {
          return `${source}\nexport const escapedRuntimeDatabaseSelfTest = runDbRuntimeConcurrencySelfTest;\n`;
        },
      },
    ];

    const root = incomingIngressFixture();
    try {
      assert.deepEqual(approvedCounts(scanDbWrites({ root })), { direct: 13, delegated: 45 });
      for (const mutation of cases) {
        const file = resolve(root, mutation.path);
        const original = readFileSync(file, 'utf8');
        try {
          if (mutation.transform) {
            writeFileSync(file, mutation.transform(original));
          } else {
            replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
          }
          assert.deepEqual(
            approvedCounts(scanDbWrites({ root })),
            { direct: 0, delegated: 0 },
            mutation.label,
          );
        } finally {
          writeFileSync(file, original);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

fullOnlyTest('DB-03B1 relaunch proof fails closed on scope and process-boundary drift', () => {
  const oldServiceSymbols = new Set(['finishPrepareFailure', 'runPreparePhase', 'runResumePhase']);
  const oldStartTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase',
  ]);
  const approvedCounts = (findings) => ({
    direct: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database' &&
        [
          'cleanupDbProcessRelaunchSelfTestDatabase',
          'prepareDbProcessRelaunchSelfTest',
          'resumeDbProcessRelaunchSelfTest',
        ].includes(finding.symbol),
    ).length,
    delegated: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database-delegation' &&
        ((finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
          (oldServiceSymbols.has(finding.symbol) ||
            (finding.symbol === 'runRecoveryPhase' &&
              finding.target === 'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase') ||
            (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
              oldStartTargets.has(finding.target)))) ||
          finding.target ===
            'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested'),
    ).length,
  });
  const cases = [
    {
      label: 'fixed disposable filename redirected to production',
      path: 'src/db/database.ts',
      before: "const DB_PROCESS_RELAUNCH_SELF_TEST_NAME = 'driver-relaunch-selftest.db';",
      after: "const DB_PROCESS_RELAUNCH_SELF_TEST_NAME = 'gator.db';",
    },
    {
      label: 'continuity open may recreate the database',
      path: 'src/db/database.ts',
      before:
        '        name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME,\n' +
        '        encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY,\n' +
        '        readOnly: true,',
      after:
        '        name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME,\n' +
        '        encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY,\n' +
        '        readOnly: false,',
    },
    {
      label: 'migration retry receives the production raw singleton',
      path: 'src/db/database.ts',
      before:
        '          DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT,\n' +
        '        );\n' +
        '        const retriedMigrations = await runMigrations(opRunner(reopened));',
      after:
        '          DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT,\n' +
        '        );\n' +
        '        const retriedMigrations = await runMigrations(opRunner(rawDb!));',
    },
    {
      label: 'prepare callback receives the native handle',
      path: 'src/db/database.ts',
      before: '    return await onPrepared(Object.freeze({ ...checks }));',
      after: '    return await onPrepared(Object.freeze({ ...checks, handle }) as never);',
    },
    {
      label: 'migration retry exact-tail assertion is weakened',
      path: 'src/db/database.ts',
      before:
        '        const retriedMigrations = await runMigrations(opRunner(reopened));\n' +
        '        requireDriverContract(\n' +
        '          retriedMigrations.length === expectedTailNames.length &&\n' +
        '            retriedMigrations.every((name, index) => name === expectedTailNames[index]),\n' +
        '        );',
      after:
        '        const retriedMigrations = await runMigrations(opRunner(reopened));\n' +
        '        requireDriverContract(retriedMigrations.length > 0);',
    },
    {
      label: 'prepare entry point gains another runtime consumer',
      path: 'src/db/database.ts',
      transform(source) {
        return `${source}\nexport const escapedDbProcessRelaunchPrepare = prepareDbProcessRelaunchSelfTest;\n`;
      },
    },
    {
      label: 'host-kill wait can settle',
      path: 'src/services/boot/devDbRelaunchContract.ts',
      before: 'const WAIT_FOR_HOST_PROCESS_KILL = new Promise<never>(() => undefined);',
      after: 'const WAIT_FOR_HOST_PROCESS_KILL = Promise.resolve<never>(undefined as never);',
    },
    {
      label: 'resuming marker fence is dropped',
      path: 'src/services/boot/devDbRelaunchContract.ts',
      before:
        '    result = await resumeDbProcessRelaunchSelfTest(() => {\n' +
        '      createZeroByteMarker(DB_RELAUNCH_RESUMING_FILE);\n' +
        '    });',
      after: '    result = await resumeDbProcessRelaunchSelfTest(() => undefined);',
    },
    {
      label: 'late request may overlap an ordinary boot',
      path: 'src/services/boot/devDbRelaunchContract.ts',
      before: '    ordinaryBootClaimedProcess = true;',
      after: '    void ordinaryBootClaimedProcess;',
    },
    {
      label: 'foreground boot continues after claiming the relaunch lane',
      path: 'src/services/boot/foregroundBoot.ts',
      before: '    if (relaunchContract) return relaunchContract;',
      after: '    if (relaunchContract) void relaunchContract;',
    },
  ];

  const root = incomingIngressFixture();
  try {
    assert.deepEqual(approvedCounts(scanDbWrites({ root })), { direct: 17, delegated: 12 });
    for (const mutation of cases) {
      const file = resolve(root, mutation.path);
      const original = readFileSync(file, 'utf8');
      try {
        if (mutation.transform) {
          writeFileSync(file, mutation.transform(original));
        } else {
          replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
        }
        assert.deepEqual(
          approvedCounts(scanDbWrites({ root })),
          { direct: 0, delegated: 0 },
          mutation.label,
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

fullOnlyTest('DB-03B2B1 WAL-death proof fails closed on capability and crash-order drift', () => {
  const oldServiceSymbols = new Set(['finishPrepareFailure', 'runPreparePhase', 'runResumePhase']);
  const oldStartTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase',
  ]);
  const walDirectSymbols = new Set([
    'cleanupDbActiveWalWriteDeathSelfTestDatabase',
    'retireDbActiveWalWriteDeathSelfTestDatabase',
    'prepareDbActiveWalWriteDeathSelfTest',
    'resumeDbActiveWalWriteDeathSelfTest',
  ]);
  const walServiceSymbols = new Set([
    'finishWalWriteDeathPrepareFailure',
    'runWalWriteDeathPreparePhase',
    'runWalWriteDeathResumePhase',
  ]);
  const walRecoveryTargets = new Set([
    'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase',
    'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase',
  ]);
  const walStartTargets = new Set([
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathResumePhase',
    'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase',
  ]);
  const historySymbols = new Set([
    'deleteDriverHistorySelfTestDatabase',
    'driverHistoryNextMigrationRolledBack',
    'seedDriverHistoryFixture',
    'verifyDriverHistoryFixture',
    'verifyDriverHistoryFts',
    'runDbHistoricalMigrationSelfTest',
  ]);
  const approvedCounts = (findings) => ({
    oldDirect: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database' &&
        [
          'cleanupDbProcessRelaunchSelfTestDatabase',
          'prepareDbProcessRelaunchSelfTest',
          'resumeDbProcessRelaunchSelfTest',
        ].includes(finding.symbol),
    ).length,
    oldDelegated: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database-delegation' &&
        ((finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
          (oldServiceSymbols.has(finding.symbol) ||
            (finding.symbol === 'runRecoveryPhase' &&
              finding.target === 'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase') ||
            (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
              oldStartTargets.has(finding.target)))) ||
          finding.target ===
            'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested'),
    ).length,
    walDirect: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database' && walDirectSymbols.has(finding.symbol),
    ).length,
    walDelegated: findings.filter(
      (finding) =>
        finding.detectedContext === 'throwaway-database-delegation' &&
        finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
        (walServiceSymbols.has(finding.symbol) ||
          (finding.symbol === 'runWalWriteDeathRecoveryPhase' &&
            walRecoveryTargets.has(finding.target)) ||
          (finding.symbol === 'runRecoveryPhase' &&
            finding.target === 'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase') ||
          (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
            walStartTargets.has(finding.target))),
    ).length,
    history: findings.filter(
      (finding) =>
        finding.path === 'src/db/database.ts' &&
        finding.detectedContext === 'throwaway-database' &&
        (historySymbols.has(finding.symbol) ||
          (finding.symbol === 'runDbDriverSelfTest' &&
            finding.target === 'src/db/database.ts#runDbHistoricalMigrationSelfTest')),
    ).length,
  });
  const cases = [
    {
      label: 'fixed WAL filename redirected to production',
      path: 'src/db/database.ts',
      before:
        "const DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME = 'driver-wal-write-death-selftest.db';",
      after: "const DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME = 'gator.db';",
    },
    {
      label: 'reviewed canary bound drifts',
      path: 'src/db/database.ts',
      before: 'const DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT = 128;',
      after: 'const DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT = 129;',
    },
    {
      label: 'TRUNCATE checkpoint moves inside active transaction',
      path: 'src/db/database.ts',
      before:
        "    phase = 'wal-checkpoint';\n" +
        "    await handle.execute('PRAGMA wal_autocheckpoint = 0');\n" +
        "    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(TRUNCATE)'));\n" +
        '    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));\n' +
        '    checks.walCheckpointTruncated = true;\n' +
        '\n' +
        "    phase = 'write-transaction';\n" +
        "    await handle.execute('PRAGMA cache_size = 8');\n" +
        "    await handle.execute('PRAGMA cache_spill = ON');\n" +
        "    await handle.execute('BEGIN IMMEDIATE');\n" +
        '    transactionOpen = true;',
      after:
        "    phase = 'write-transaction';\n" +
        "    await handle.execute('PRAGMA cache_size = 8');\n" +
        "    await handle.execute('PRAGMA cache_spill = ON');\n" +
        "    await handle.execute('BEGIN IMMEDIATE');\n" +
        '    transactionOpen = true;\n' +
        '\n' +
        "    phase = 'wal-checkpoint';\n" +
        "    await handle.execute('PRAGMA wal_autocheckpoint = 0');\n" +
        "    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(TRUNCATE)'));\n" +
        '    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));\n' +
        '    checks.walCheckpointTruncated = true;',
    },
    {
      label: 'cache spill disabled',
      path: 'src/db/database.ts',
      before: "    await handle.execute('PRAGMA cache_spill = ON');",
      after: "    await handle.execute('PRAGMA cache_spill = OFF');",
    },
    {
      label: 'canary transaction commits before READY',
      path: 'src/db/database.ts',
      before:
        '       FROM canary`,\n    );\n    const active = await inspectDbActiveWalWriteDeathState(handle);',
      after:
        '       FROM canary`,\n' +
        '    );\n' +
        "    await handle.execute('COMMIT');\n" +
        '    const active = await inspectDbActiveWalWriteDeathState(handle);',
    },
    {
      label: 'prepare callback leaks handle',
      path: 'src/db/database.ts',
      before:
        '  try {\n' +
        '    return await onPrepared(Object.freeze({ ...checks }));\n' +
        '  } finally {\n' +
        '    // A successful device run crashes the process before this executes.',
      after:
        '  try {\n' +
        '    return await onPrepared(Object.freeze({ ...checks, handle }) as never);\n' +
        '  } finally {\n' +
        '    // A successful device run crashes the process before this executes.',
    },
    {
      label: 'process B first open may recreate',
      path: 'src/db/database.ts',
      before:
        '      const readOnly = open({\n' +
        '        name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,\n' +
        '        encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,\n' +
        '        readOnly: true,\n' +
        '      });',
      after:
        '      const readOnly = open({\n' +
        '        name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,\n' +
        '        encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,\n' +
        '        readOnly: false,\n' +
        '      });',
    },
    {
      label: 'recovered singleton assertion weakened',
      path: 'src/db/database.ts',
      before:
        '        requireDriverContract(recovered.rowCount === 1 && recovered.baselinePresent);',
      after: '        requireDriverContract(recovered.baselinePresent);',
    },
    {
      label: 'WAL lane touches production singleton',
      path: 'src/db/database.ts',
      before: "    phase = 'wal-mode';\n" + "    await handle.execute('PRAGMA foreign_keys = ON');",
      after: "    phase = 'wal-mode';\n" + "    await rawDb!.execute('PRAGMA foreign_keys = ON');",
    },
    {
      label: 'post-persistence WAL retirement bypassed',
      path: 'src/db/database.ts',
      before:
        '    checks.databaseCleanup = checks.reopenPersistence\n' +
        '      ? retireDbActiveWalWriteDeathSelfTestDatabase()\n' +
        '      : cleanupDbActiveWalWriteDeathSelfTestDatabase();',
      after: '    checks.databaseCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();',
    },
    {
      label: 'WAL entry gains runtime alias consumer',
      path: 'src/db/database.ts',
      transform(source) {
        return `${source}\nexport const escapedDbActiveWalWriteDeathPrepare = prepareDbActiveWalWriteDeathSelfTest;\n`;
      },
    },
    {
      label: 'WAL resuming fence dropped',
      path: 'src/services/boot/devDbRelaunchContract.ts',
      before:
        '    result = await resumeDbActiveWalWriteDeathSelfTest(() => {\n' +
        '      createZeroByteMarker(DB_WAL_WRITE_DEATH_RESUMING_FILE);\n' +
        '    });',
      after: '    result = await resumeDbActiveWalWriteDeathSelfTest(() => undefined);',
    },
  ];

  const root = incomingIngressFixture();
  try {
    const baselineFindings = scanDbWrites({ root });
    assert.deepEqual(approvedCounts(baselineFindings), {
      oldDirect: 17,
      oldDelegated: 12,
      walDirect: 33,
      walDelegated: 13,
      history: 39,
    });
    const throwawayContexts = new Set(['throwaway-database', 'throwaway-database-delegation']);
    const baselineThrowawayApprovals = new Set(
      baselineFindings
        .filter((finding) => throwawayContexts.has(finding.detectedContext))
        .map((finding) => `${finding.detectedContext}\0${finding.id}`),
    );

    for (const mutation of cases) {
      const file = resolve(root, mutation.path);
      const original = readFileSync(file, 'utf8');
      try {
        if (mutation.transform) {
          writeFileSync(file, mutation.transform(original));
        } else {
          replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
        }
        const findings = scanDbWrites({ root });
        const counts = approvedCounts(findings);
        assert.equal(counts.walDirect, 0, mutation.label);
        assert.equal(counts.walDelegated, 0, mutation.label);
        assert.ok(counts.oldDirect <= 17, mutation.label);
        assert.ok(counts.oldDelegated <= 12, mutation.label);
        assert.ok(counts.history <= 39, mutation.label);
        assert.deepEqual(
          findings
            .filter(
              (finding) =>
                throwawayContexts.has(finding.detectedContext) &&
                !baselineThrowawayApprovals.has(`${finding.detectedContext}\0${finding.id}`),
            )
            .map((finding) => `${finding.detectedContext}:${finding.id}`)
            .sort(),
          [],
          mutation.label,
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

fullOnlyTest(
  'DB-03B2B2 active-migration-death proof fails closed on capability and crash-order drift',
  () => {
    const oldDirectSymbols = new Set([
      'cleanupDbProcessRelaunchSelfTestDatabase',
      'prepareDbProcessRelaunchSelfTest',
      'resumeDbProcessRelaunchSelfTest',
    ]);
    const oldServiceSymbols = new Set([
      'finishPrepareFailure',
      'runPreparePhase',
      'runResumePhase',
    ]);
    const oldStartTargets = new Set([
      'src/services/boot/devDbRelaunchContract.ts#runPreparePhase',
      'src/services/boot/devDbRelaunchContract.ts#runResumePhase',
      'src/services/boot/devDbRelaunchContract.ts#runRecoveryPhase',
    ]);
    const walDirectSymbols = new Set([
      'cleanupDbActiveWalWriteDeathSelfTestDatabase',
      'retireDbActiveWalWriteDeathSelfTestDatabase',
      'prepareDbActiveWalWriteDeathSelfTest',
      'resumeDbActiveWalWriteDeathSelfTest',
    ]);
    const walServiceSymbols = new Set([
      'finishWalWriteDeathPrepareFailure',
      'runWalWriteDeathPreparePhase',
      'runWalWriteDeathResumePhase',
    ]);
    const walRecoveryTargets = new Set([
      'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase',
      'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase',
    ]);
    const walStartTargets = new Set([
      'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathPreparePhase',
      'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathResumePhase',
      'src/services/boot/devDbRelaunchContract.ts#runWalWriteDeathRecoveryPhase',
    ]);
    const activeDirectSymbols = new Set([
      'seedDbActiveMigrationFixture',
      'cleanupDbActiveMigrationDeathSelfTestDatabase',
      'retireDbActiveMigrationDeathSelfTestDatabase',
      'prepareDbActiveMigrationDeathSelfTest',
      'resumeDbActiveMigrationDeathSelfTest',
    ]);
    const activeServiceSymbols = new Set([
      'finishActiveMigrationDeathPrepareFailure',
      'runActiveMigrationDeathPreparePhase',
      'runActiveMigrationDeathResumePhase',
      'runActiveMigrationDeathRecoveryPhase',
    ]);
    const activeStartTargets = new Set([
      'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathPreparePhase',
      'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathResumePhase',
      'src/services/boot/devDbRelaunchContract.ts#runActiveMigrationDeathRecoveryPhase',
    ]);
    const historySymbols = new Set([
      'deleteDriverHistorySelfTestDatabase',
      'driverHistoryNextMigrationRolledBack',
      'seedDriverHistoryFixture',
      'verifyDriverHistoryFixture',
      'verifyDriverHistoryFts',
      'runDbHistoricalMigrationSelfTest',
    ]);
    const approvedCounts = (findings) => ({
      oldDirect: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database' && oldDirectSymbols.has(finding.symbol),
      ).length,
      oldDelegated: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database-delegation' &&
          ((finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
            (oldServiceSymbols.has(finding.symbol) ||
              (finding.symbol === 'runRecoveryPhase' &&
                finding.target === 'src/db/database.ts#cleanupDbProcessRelaunchSelfTestDatabase') ||
              (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
                oldStartTargets.has(finding.target)))) ||
            finding.target ===
              'src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested'),
      ).length,
      walDirect: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database' && walDirectSymbols.has(finding.symbol),
      ).length,
      walDelegated: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database-delegation' &&
          finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
          (walServiceSymbols.has(finding.symbol) ||
            (finding.symbol === 'runWalWriteDeathRecoveryPhase' &&
              walRecoveryTargets.has(finding.target)) ||
            (finding.symbol === 'runRecoveryPhase' &&
              finding.target ===
                'src/db/database.ts#cleanupDbActiveWalWriteDeathSelfTestDatabase') ||
            (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
              walStartTargets.has(finding.target))),
      ).length,
      activeDirect: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database' &&
          activeDirectSymbols.has(finding.symbol),
      ).length,
      activeDelegated: findings.filter(
        (finding) =>
          finding.detectedContext === 'throwaway-database-delegation' &&
          finding.path === 'src/services/boot/devDbRelaunchContract.ts' &&
          (activeServiceSymbols.has(finding.symbol) ||
            (finding.symbol === 'runRecoveryPhase' &&
              finding.target ===
                'src/db/database.ts#cleanupDbActiveMigrationDeathSelfTestDatabase') ||
            (finding.symbol === 'runWalWriteDeathRecoveryPhase' &&
              finding.target ===
                'src/db/database.ts#cleanupDbActiveMigrationDeathSelfTestDatabase') ||
            (finding.symbol === 'startDevDbRelaunchContractIfRequested' &&
              activeStartTargets.has(finding.target))),
      ).length,
      history: findings.filter(
        (finding) =>
          finding.path === 'src/db/database.ts' &&
          finding.detectedContext === 'throwaway-database' &&
          (historySymbols.has(finding.symbol) ||
            (finding.symbol === 'runDbDriverSelfTest' &&
              finding.target === 'src/db/database.ts#runDbHistoricalMigrationSelfTest')),
      ).length,
    });
    const cases = [
      {
        label: 'fixed active-migration filename redirected to production',
        path: 'src/db/database.ts',
        before:
          "const DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME = 'driver-active-migration-death-selftest.db';",
        after: "const DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME = 'gator.db';",
      },
      {
        label: 'target migration is selected from the wrong repository index',
        path: 'src/db/database.ts',
        before: 'const target = MIGRATIONS[DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT];',
        after: 'const target = MIGRATIONS[DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT - 1];',
      },
      {
        label: 'reviewed active-migration fixture bound drifts',
        path: 'src/db/database.ts',
        before: 'const DB_ACTIVE_MIGRATION_DEATH_TARGET_COUNT = 128;',
        after: 'const DB_ACTIVE_MIGRATION_DEATH_TARGET_COUNT = 129;',
      },
      {
        label: 'active-migration fixture accepts a non-exact row set',
        path: 'src/db/database.ts',
        before:
          '  const expected = dbActiveMigrationFixtureRows(migrated);\n' +
          '  return (\n' +
          '    rows.length === expected.length &&',
        after:
          '  const expected = dbActiveMigrationFixtureRows(migrated);\n' +
          '  return (\n' +
          '    rows.length >= expected.length &&',
      },
      {
        label: 'prefix migration bypasses its exact stopping runner',
        path: 'src/db/database.ts',
        before: '      await runMigrations(dbActiveMigrationPrefixRunner(opRunner(handle)));',
        after: '      await runMigrations(opRunner(handle));',
      },
      {
        label: 'prefix runner becomes a public capability',
        path: 'src/db/database.ts',
        before: 'function dbActiveMigrationPrefixRunner(base: SqlRunner): SqlRunner {',
        after: 'export function dbActiveMigrationPrefixRunner(base: SqlRunner): SqlRunner {',
      },
      {
        label: 'prefix runner gains an extra runtime consumer',
        path: 'src/db/database.ts',
        transform(source) {
          return `${source}\nexport const escapedDbActiveMigrationPrefixRunner = dbActiveMigrationPrefixRunner;\n`;
        },
      },
      {
        label: 'active migration commits before the READY callback',
        path: 'src/db/database.ts',
        before:
          '        migrationWriteApplied = true;\n' +
          '        const activeState = await inspectDbActiveMigrationRunnerState(base);',
        after:
          '        migrationWriteApplied = true;\n' +
          "        await base.exec('COMMIT');\n" +
          '        const activeState = await inspectDbActiveMigrationRunnerState(base);',
      },
      {
        label: 'active migration receives the production raw singleton',
        path: 'src/db/database.ts',
        before:
          '      dbActiveMigrationCrashRunner(opRunner(handle), async (): Promise<never> => {',
        after: '      dbActiveMigrationCrashRunner(opRunner(rawDb!), async (): Promise<never> => {',
      },
      {
        label: 'active-migration prepare callback receives the native handle',
        path: 'src/db/database.ts',
        before: '        return onPrepared(Object.freeze({ ...checks }));',
        after: '        return onPrepared(Object.freeze({ ...checks, handle }) as never);',
      },
      {
        label: 'pre-crash checkpoint no longer truncates the WAL',
        path: 'src/db/database.ts',
        before:
          "    phase = 'wal-checkpoint';\n" +
          "    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(TRUNCATE)'));",
        after:
          "    phase = 'wal-checkpoint';\n" +
          "    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(PASSIVE)'));",
      },
      {
        label: 'process B first active-migration open may recreate',
        path: 'src/db/database.ts',
        before:
          '      const readOnly = open({\n' +
          '        name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,\n' +
          '        encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,\n' +
          '        readOnly: true,\n' +
          '      });',
        after:
          '      const readOnly = open({\n' +
          '        name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,\n' +
          '        encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,\n' +
          '        readOnly: false,\n' +
          '      });',
      },
      {
        label: 'active-migration retry accepts an inexact migration result',
        path: 'src/db/database.ts',
        before:
          '          retriedMigrations.length === expectedTailNames.length &&\n' +
          '            retriedMigrations.every((name, index) => name === expectedTailNames[index]),',
        after:
          '          retriedMigrations.length >= expectedTailNames.length &&\n' +
          '            retriedMigrations.every((name, index) => name === expectedTailNames[index]),',
      },
      {
        label: 'post-persistence active-migration retirement is bypassed',
        path: 'src/db/database.ts',
        before:
          '    checks.databaseCleanup = checks.reopenPersistence\n' +
          '      ? retireDbActiveMigrationDeathSelfTestDatabase()\n' +
          '      : cleanupDbActiveMigrationDeathSelfTestDatabase();',
        after: '    checks.databaseCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();',
      },
      {
        label: 'active-migration resuming fence is dropped',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        before:
          '    result = await resumeDbActiveMigrationDeathSelfTest(() => {\n' +
          '      createZeroByteMarker(DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE);\n' +
          '    });',
        after: '    result = await resumeDbActiveMigrationDeathSelfTest(() => undefined);',
      },
      {
        label: 'four-family dispatcher routes active migration into the WAL lane',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        before: "  } else if (mode.scenario === 'active-migration-death') {",
        after: "  } else if (mode.scenario === 'active-wal-write-death') {",
      },
      {
        label: 'active-migration marker protocol version drifts',
        path: 'src/services/boot/devDbRelaunchContract.ts',
        before:
          "const DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX = 'GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 ';",
        after:
          "const DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX = 'GATOR_DB_ACTIVE_MIGRATION_DEATH_V2 ';",
      },
    ];

    const root = incomingIngressFixture();
    try {
      const baselineFindings = scanDbWrites({ root });
      assert.deepEqual(approvedCounts(baselineFindings), {
        oldDirect: 17,
        oldDelegated: 12,
        walDirect: 33,
        walDelegated: 13,
        activeDirect: 34,
        activeDelegated: 16,
        history: 39,
      });
      const throwawayContexts = new Set(['throwaway-database', 'throwaway-database-delegation']);
      const baselineThrowawayApprovals = new Set(
        baselineFindings
          .filter((finding) => throwawayContexts.has(finding.detectedContext))
          .map((finding) => `${finding.detectedContext}\0${finding.id}`),
      );

      for (const mutation of cases) {
        const file = resolve(root, mutation.path);
        const original = readFileSync(file, 'utf8');
        try {
          if (mutation.transform) {
            writeFileSync(file, mutation.transform(original));
          } else {
            replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
          }
          const findings = scanDbWrites({ root });
          const counts = approvedCounts(findings);
          assert.equal(counts.activeDirect, 0, mutation.label);
          assert.equal(counts.activeDelegated, 0, mutation.label);
          assert.ok(counts.oldDirect <= 17, mutation.label);
          assert.ok(counts.oldDelegated <= 12, mutation.label);
          assert.ok(counts.walDirect <= 33, mutation.label);
          assert.ok(counts.walDelegated <= 13, mutation.label);
          assert.ok(counts.history <= 39, mutation.label);
          assert.deepEqual(
            findings
              .filter(
                (finding) =>
                  throwawayContexts.has(finding.detectedContext) &&
                  !baselineThrowawayApprovals.has(`${finding.detectedContext}\0${finding.id}`),
              )
              .map((finding) => `${finding.detectedContext}:${finding.id}`)
              .sort(),
            [],
            mutation.label,
          );
        } finally {
          writeFileSync(file, original);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

fullOnlyTest('driver adapter proof fails closed on forwarding, escape, and scope drift', () => {
  const approvedCount = (findings) =>
    findings.filter(
      (finding) =>
        finding.detectedContext === 'startup-migration-adapter' ||
        finding.detectedContext === 'runtime-drizzle-adapter',
    ).length;

  const baselineRoot = incomingIngressFixture();
  try {
    assert.equal(approvedCount(scanDbWrites({ root: baselineRoot })), 5);
  } finally {
    rmSync(baselineRoot, { recursive: true, force: true });
  }

  const cases = [
    {
      label: 'throwaway filename redirected to production',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "const DRIVER_SELF_TEST_DB_NAME = 'driver-selftest.db';",
          "const DRIVER_SELF_TEST_DB_NAME = 'gator.db';",
        );
      },
    },
    {
      label: 'one throwaway open redirected to production',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'const initial = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyA });',
          'const initial = open({ name: DB_NAME, encryptionKey: keyA });',
        );
      },
    },
    {
      label: 'production raw handle substituted into self-test adapter',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'const database = drizzle(drizzleAdapter(reopened)) as unknown as AppDatabase;',
          'const database = drizzle(drizzleAdapter(rawDb!)) as unknown as AppDatabase;',
        );
      },
    },
    {
      label: 'self-test bypasses production adapter',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'const database = drizzle(drizzleAdapter(reopened)) as unknown as AppDatabase;',
          'const database = drizzle(reopened) as unknown as AppDatabase;',
        );
      },
    },
    {
      label: 'adapted self-test client escapes',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "        phase = 'sync-reactive';",
          "        Reflect.set(globalThis, '__driverClient', database);\n        phase = 'sync-reactive';",
        );
      },
    },
    {
      label: 'detached Drizzle self-test write',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '          await database.run(sql`',
          '          void database.run(sql`',
        );
      },
    },
    {
      label: 'self-test final cleanup removed',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '    checks.cleanup = deleteDriverSelfTestDatabase();',
          '    checks.cleanup = true;',
        );
      },
    },
    {
      label: 'first production migration probe is detached',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '          await runMigrations(opRunner(initial));',
          '          void runMigrations(opRunner(initial));',
        );
      },
    },
    {
      label: 'migration conflict accepts an unrelated error',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "message.includes('attachment_cache_entries_state_lru_idx') && message.includes('already exists')",
          "message.includes('attachment_cache_entries_state_lru_idx') || message.includes('already exists')",
        );
      },
    },
    {
      label: 'partial migration boundary drifts from 29',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'const DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT = 29;',
          'const DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT = 28;',
        );
      },
    },
    {
      label: 'failed migration may leave its created table behind',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '            rolledBackTable.length === 0 &&',
          '            rolledBackTable.length >= 0 &&',
        );
      },
    },
    {
      label: 'migration retry is redirected to the production singleton',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '        const retriedMigrations = await runMigrations(opRunner(reopened));',
          '        const retriedMigrations = await runMigrations(opRunner(rawDb!));',
        );
      },
    },
    {
      label: 'migration retry no longer proves the exact tail',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'retriedMigrations.every((name, index) => name === expectedTailNames[index])',
          'retriedMigrations.length > 0',
        );
      },
    },
    {
      label: 'full migration ledger assertion is weakened',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "requireDriverContract(hasExactStringColumn(fullLedger, 'name', expectedMigrationNames));",
          'requireDriverContract(fullLedger.length > 0);',
        );
      },
    },
    {
      label: 'migration data scrub assertion is removed',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "!Object.prototype.hasOwnProperty.call(parsedReaction, 'selectedMessageText') &&",
          "Object.prototype.hasOwnProperty.call(parsedReaction, 'targetGuid') &&",
        );
      },
    },
    {
      label: 'production FTS update transition is redirected',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "await reopened.execute('UPDATE messages SET text = ? WHERE guid = ?', [",
          "await reopened.execute('UPDATE handles SET display_name = ? WHERE address = ?', [",
        );
      },
    },
    {
      label: 'foreign-key integrity assertion is weakened',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '            foreignKeyViolations.length === 0 &&',
          '            foreignKeyViolations.length >= 0 &&',
        );
      },
    },
    {
      label: 'idempotent migration result may be nonempty',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          'requireDriverContract(idempotentMigrations.length === 0);',
          'requireDriverContract(idempotentMigrations.length >= 0);',
        );
      },
    },
    {
      label: 'extra private runner consumer is added',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "        phase = 'idempotent';",
          "        void opRunner(reopened);\n        phase = 'idempotent';",
        );
      },
    },
    {
      label: 'migration head metadata drifts',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "const DRIVER_SELF_TEST_MIGRATION_HEAD = '0040_chats_pin_order' as const;",
          "const DRIVER_SELF_TEST_MIGRATION_HEAD = '0039_message_error_message' as const;",
        );
      },
    },
    {
      label: 'driver contract result schema drifts',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "      schema: 3,\n      suite: 'android-db-contract',\n      status: 'pass',",
          "      schema: 2,\n      suite: 'android-db-contract',\n      status: 'pass',",
        );
      },
    },
    {
      label: 'extra migration entry point is added',
      mutate(root) {
        writeFileSync(
          resolve(root, 'src/services/migrationBypass.ts'),
          `import { runMigrations } from '../db/migrate';
          export function migrationBypass(runner: Parameters<typeof runMigrations>[0]) {
            return runMigrations(runner);
          }`,
        );
      },
    },
    {
      label: 'transaction adapter stops flushing rollbacks',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "if (command === 'COMMIT' || command === 'ROLLBACK') {",
          "if (command === 'COMMIT') {",
        );
      },
    },
    {
      label: 'transaction adapter flushes uncommitted writes',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '    if (!transactionOpen) flush();',
          '    flush();',
        );
      },
    },
    {
      label: 'failed rollback leaves the adapter transaction flag stale',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "    if (command === 'ROLLBACK') transactionOpen = false;",
          '    void command;',
        );
      },
    },
    {
      label: 'one adapter route skips failed-rollback retirement',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '        retireFailedRollback(command);',
          '        void command;',
        );
      },
    },
    {
      label: 'commit boundary bypasses the Drizzle adapter',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '          await database.run(sql`COMMIT`);',
          "          await reopened.execute('COMMIT');",
        );
      },
    },
    {
      label: 'rollback boundary bypasses the Drizzle adapter',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '          await database.run(sql`ROLLBACK`);\n          transactionOpen = false;\n          requireDriverContract(await rollbackProbe.result);',
          "          await reopened.execute('ROLLBACK');\n          transactionOpen = false;\n          requireDriverContract(await rollbackProbe.result);",
        );
      },
    },
    {
      label: 'rollback subscriber accepts the uncommitted notification',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "subscribeForDriverSelfTestValue(reopened, 'committed', true)",
          "subscribeForDriverSelfTestValue(reopened, 'committed')",
        );
      },
    },
    {
      label: 'commit subscriber starts before the transaction',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "        await database.run(sql`BEGIN IMMEDIATE`);\n        transactionOpen = true;\n        const commitProbe = subscribeForDriverSelfTestValue(reopened, 'committed');",
          "        const commitProbe = subscribeForDriverSelfTestValue(reopened, 'committed');\n        await database.run(sql`BEGIN IMMEDIATE`);\n        transactionOpen = true;",
        );
      },
    },
    {
      label: 'commit boundary is replaced with an unrecognized alias',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '          await database.run(sql`COMMIT`);',
          '          await database.run(sql`END`);',
        );
      },
    },
    {
      label: 'rollback durable-state assertion is weakened',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "requireDriverContract(afterRollback[0]?.display_name === 'committed');",
          "requireDriverContract(afterRollback[0]?.display_name !== 'rolled-back');",
        );
      },
    },
    {
      label: 'driver contract assertion helper is disabled',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          "  if (!condition) throw new Error('database driver contract assertion failed');",
          '  void condition;',
        );
      },
    },
    {
      label: 'rollback probe stops waiting for the durable value',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '        else if (!waitForExpected) finish(false);',
          '        else finish(false);',
        );
      },
    },
    {
      label: 'detached migration statement',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/migrate.ts',
          '        await runner.exec(statement);',
          '        void runner.exec(statement);',
        );
      },
    },
    {
      label: 'implicit arguments runner escape',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/migrate.ts',
          '  return ran;',
          "  const delayedSql = 'UPDATE messages SET text = NULL';\n  setTimeout(() => void arguments[0].exec(delayedSql), 0);\n  return ran;",
        );
      },
    },
    {
      label: 'escaped runner factory',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '/**\n * Adapter so drizzle-orm',
          'export const escapedRunnerFactory = opRunner;\n\n/**\n * Adapter so drizzle-orm',
        );
      },
    },
    {
      label: 'escaped Drizzle adapter',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '/**\n * Open the encrypted database',
          'export const escapedDrizzleAdapter = drizzleAdapter;\n\n/**\n * Open the encrypted database',
        );
      },
    },
    {
      label: 'reflective Drizzle adapter escape',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '/**\n * Open the encrypted database',
          `export function reflectiveAdapterBypass(raw: unknown, statement: string) {
            const adapted = eval('drizzleAdapter')(raw);
            const invoke = adapted.executeAsync;
            return invoke(statement);
          }

          /**
           * Open the encrypted database`,
        );
      },
    },
    {
      label: 'extra raw override',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '    executeRawAsync: async (statement: string, params?: unknown[]) => {',
          '    executeRaw: (statement: string, params?: unknown[]) => db.executeRaw(statement, (params as never[]) ?? []),\n    executeRawAsync: async (statement: string, params?: unknown[]) => {',
        );
      },
    },
    {
      label: 'missing synchronous reactive flush',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '        const r = db.executeSync(statement, (params as never[]) ?? []);\n        flushAfter(command);\n        return wrap(r);',
          '      const r = db.executeSync(statement, (params as never[]) ?? []);\n      return wrap(r);',
        );
      },
    },
    {
      label: 'row extraction bypass',
      mutate(root) {
        replaceFixtureSource(
          root,
          'src/db/database.ts',
          '      return extractRows(res) as never[];',
          '      return [] as never[];',
        );
      },
    },
    {
      label: 'op-sqlite dependency drift',
      mutate(root) {
        replaceFixtureSource(root, 'package.json', '"17.1.2"', '"17.1.3"');
      },
    },
    {
      label: 'public Drizzle client escape',
      mutate(root) {
        writeFileSync(
          resolve(root, 'src/services/adapterClientBypass.ts'),
          `import { getDatabase } from '../db/database';
          export function adapterClientBypass(statement: string) {
            const client = (getDatabase() as any).$client;
            const invoke = client.executeAsync;
            return invoke(statement);
          }`,
        );
      },
    },
    {
      label: 'new unresolved database write',
      mutate(root) {
        writeFileSync(
          resolve(root, 'src/services/driverAdapterBypass.ts'),
          `export async function bypass(db: { execute(sql: string): Promise<unknown> }) {
            await db.execute('UPDATE messages SET text = NULL');
          }`,
        );
      },
    },
  ];

  for (const { label, mutate } of cases) {
    const root = incomingIngressFixture();
    try {
      mutate(root);
      assert.equal(approvedCount(scanDbWrites({ root })), 0, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('certifies exactly the reviewed foreground-boot lifecycle boundary', () => {
  const findings = scanProjectDbWrites();
  const coordinated = findings.filter(
    (finding) => finding.detectedContext === 'foreground-boot-lifecycle-delegation',
  );
  const temporal = findings.filter(
    (finding) =>
      finding.detectedContext === 'throwaway-database-delegation' &&
      finding.target === 'src/db/database.ts#runDbDriverSelfTest',
  );

  assert.deepEqual(
    coordinated.map((finding) => finding.id).sort(),
    [
      'app/_layout.tsx#RootLayout.<callback:f429780a18>.startOwnedRun:mutator-call:33ee7bd33824',
      'app/_layout.tsx#RootLayout.<callback:f429780a18>.<callback:a6d63425a0>:mutator-call:246367c31649',
      'app/_layout.tsx#RootLayout.<callback:f429780a18>:mutator-call:09b9cd24cd8c',
      'app/_layout.tsx#RootLayout:mutator-reference:8e2aa31388d0',
      'src/services/boot/foregroundBoot.ts#initializeForegroundBootComposition.<callback:3745c8b485>:mutator-call:60bff6bb7fec',
      'src/services/boot/foregroundBoot.ts#initializeForegroundBootComposition.<callback:58f904a832>:mutator-call:f6945f73aad5',
      'src/services/boot/foregroundBoot.ts#startForegroundBoot:mutator-call:0337c4c095d4',
    ].sort(),
  );
  assert.equal(coordinated.length, 7);
  assert.deepEqual(
    temporal.map((finding) => finding.id),
    ['src/services/boot/foregroundBoot.ts#startProcessWork:mutator-call:aa8863fe1bcb'],
  );
});

fullOnlyTest(
  'foreground-boot proof fails closed on authority and throwaway-scope mutations',
  () => {
    const cases = [
      {
        path: 'src/db/database.ts',
        before: "const DRIVER_SELF_TEST_DB_NAME = 'driver-selftest.db';",
        after: "const DRIVER_SELF_TEST_DB_NAME = 'gator.db';",
      },
      {
        path: 'src/db/database.ts',
        before: 'const initial = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyA });',
        after: 'const initial = open({ name: DB_NAME, encryptionKey: keyA });',
      },
      {
        path: 'src/db/database.ts',
        before: 'const database = drizzle(drizzleAdapter(reopened)) as unknown as AppDatabase;',
        after: 'const database = drizzle(drizzleAdapter(rawDb!)) as unknown as AppDatabase;',
      },
      {
        path: 'src/services/boot/foregroundBoot.ts',
        before: '  if (processWorkStarted) return;',
        after: '  if (false) return;',
      },
      {
        path: 'src/services/boot/foregroundBoot.ts',
        before: 'GATOR_DB_CONTRACT_V3 ${JSON.stringify(result)}',
        after: 'GATOR_DB_CONTRACT_V2 ${JSON.stringify(result)}',
      },
      {
        path: 'src/services/boot/foregroundBoot.ts',
        before: '  processWorkStarted = true;\n\n  if (!clearShareShortcuts()) {',
        after:
          '  processWorkStarted = true;\n  const __DEV__ = true;\n\n  if (!clearShareShortcuts()) {',
      },
      {
        path: 'app/_layout.tsx',
        before: '              onWarmUnlock={completeUnlock}',
        after: '              onWarmUnlock={() => completeUnlock()}',
      },
      {
        path: 'app/_layout.tsx',
        before:
          '          <ThemeProvider renderWithFallbackTheme>\n' +
          '            <StatusBar style={DARK_STATUS_BAR_STYLE} />\n' +
          '            <ForegroundLockGate\n' +
          '              bootState={bootState}\n' +
          '              lockHydrated={lockHydrated}\n' +
          '              locked={locked}\n' +
          '              foregroundUnlockId={foregroundUnlockId}\n' +
          '              onColdUnlock={completeColdUnlock}\n' +
          '              onWarmUnlock={completeUnlock}',
        after:
          '          <ThemeProvider renderWithFallbackTheme onWarmUnlock={completeUnlock}>\n' +
          '            <StatusBar style={DARK_STATUS_BAR_STYLE} />\n' +
          '            <ForegroundLockGate\n' +
          '              bootState={bootState}\n' +
          '              lockHydrated={lockHydrated}\n' +
          '              locked={locked}\n' +
          '              foregroundUnlockId={foregroundUnlockId}\n' +
          '              onColdUnlock={completeColdUnlock}\n' +
          '              onWarmUnlock={async () => undefined}',
      },
    ];

    for (const mutation of cases) {
      const root = incomingIngressFixture();
      try {
        for (const replacement of mutation.replacements ?? [mutation]) {
          replaceFixtureSource(root, mutation.path, replacement.before, replacement.after);
        }
        const findings = scanDbWrites({ root });
        assert.equal(
          findings.filter(
            (finding) =>
              finding.detectedContext === 'foreground-boot-lifecycle-delegation' ||
              (finding.detectedContext === 'throwaway-database-delegation' &&
                finding.target === 'src/db/database.ts#runDbDriverSelfTest'),
          ).length,
          0,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test('certifies exactly the reviewed live-rekey delegation boundary', () => {
  const findings = scanProjectDbWrites();
  const delegated = findings.filter(
    (finding) =>
      finding.target === 'src/services/databaseControl.ts#rotateDatabaseKey' ||
      finding.target === 'src/db/key.ts#rotateDbKey',
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'app/(app)/settings.tsx#SettingsScreen.onRotateKey.onPress.<callback:e1dc7f6ab7>:mutator-call:ac9fcd609606',
      'src/services/databaseControl.ts#rotateDatabaseKey:mutator-call:dc60d96f0ec1',
    ].sort(),
  );
  assert.equal(delegated.length, 2);
  for (const finding of delegated) {
    assert.equal(finding.detectedContext, 'coordinated-delegation');
  }
});

test('certifies exactly the reviewed account-transition delegation boundary', () => {
  const findings = scanProjectDbWrites();
  const delegated = findings.filter(
    (finding) => finding.detectedContext === 'account-transition-delegation',
  );

  assert.deepEqual(
    delegated.map((finding) => finding.id).sort(),
    [
      'app/(app)/home.tsx#Home.onDisconnect:mutator-call:5c664d7c8961',
      'app/(app)/home.tsx#Home:mutator-reference:386e7d319726',
      'app/(app)/settings.tsx#SettingsScreen.onDisconnect.onPress:mutator-call:d4cf58af3ec2',
      'src/services/realtimeControl.ts#realtimeSink.<callback:68fe0014d7>:mutator-call:017af705079d',
      'src/services/realtimeControl.ts#realtimeSink.<callback:68fe0014d7>:mutator-call:83761d97b204',
    ].sort(),
  );
  assert.equal(delegated.length, 5);
  for (const suffix of ['a9efdbe22d70', '602dd63b9e5a']) {
    assert.equal(
      findings.find((finding) => finding.id.endsWith(suffix))?.detectedContext,
      'coordinated-delegation',
    );
  }
});

fullOnlyTest('account-transition proof fails closed when one exact handoff is redirected', () => {
  const root = incomingIngressFixture();
  try {
    const baseline = scanDbWrites({ root });
    assert.equal(
      baseline.filter((finding) => finding.detectedContext === 'account-transition-delegation')
        .length,
      5,
    );
    replaceFixtureSource(
      root,
      'app/(app)/home.tsx',
      '      await forget();',
      '      await runDueScheduled();',
    );
    const mutated = scanDbWrites({ root });
    assert.equal(
      mutated.filter((finding) => finding.detectedContext === 'account-transition-delegation')
        .length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('certifies exactly the reviewed repository-context and thin-delegation boundary', () => {
  const findings = scanProjectDbWrites();
  const reviewedPaths = new Set([
    'app/(app)/chat/[guid].tsx',
    'app/(app)/new-chat.tsx',
    'src/db/repositories/chats.ts',
    'src/db/repositories/outgoing.ts',
    'src/features/facetime/useFaceTime.ts',
    'src/services/backup/backup.ts',
    'src/services/backup/backupService.ts',
    'src/services/chat/groupManagement.ts',
    'src/services/contacts/serverAvatars.ts',
  ]);
  const leafSymbols = new Set([
    'applyLocalEditWithinTransaction',
    'applyLocalUnsendWithinTransaction',
    'claimErrorReportsWithinTransaction',
    'createReminderWithinTransaction',
    'deleteErrorReportsWithinTransaction',
    'deleteReminderByNotificationIdWithinTransaction',
    'deleteReminderWithinTransaction',
    'deleteMessageLocalWithinTransaction',
    'deleteScheduledHistoryWithinTransaction',
    'deleteScheduledWithinTransaction',
    'discardOutgoingMessageWithinTransaction',
    'kvSetWithinTransaction',
    'markAllChatsReadLocalWithinTransaction',
    'markMessageSendErrorWithinTransaction',
    'markOutgoingSentNoGuidWithinTransaction',
    'claimOutgoingForSendWithinTransaction',
    'claimFailedOutgoingForRetryWithinTransaction',
    'insertOutgoingAttachmentWithinTransaction',
    'insertOutgoingContactWithinTransaction',
    'insertOutgoingReactionWithinTransaction',
    'insertScheduledWithinTransaction',
    'listRetryableErrorReportsWithinTransaction',
    'markErrorReportsFailedWithinTransaction',
    'retireOutgoingWithinTransaction',
    'revertLocalEditWithinTransaction',
    'revertLocalUnsendWithinTransaction',
    'reconcileOutgoingSuccessWithinTransaction',
    'reconcileReadMarkersFromTimestamps',
    'restorePreparedBackupWithinTransaction',
    'setChatAppearanceWithinTransaction',
    'setChatArchiveWithinTransaction',
    'setChatCustomizationWithinTransaction',
    'setChatMuteWithinTransaction',
    'setChatPinWithinTransaction',
    'swapPinnedChatOrderWithinTransaction',
    'setChatUnreadLocalWithinTransaction',
    'setHandleServerAvatarWithinTransaction',
    'setSyncedBackgroundLuminanceIfCurrentWithinTransaction',
    'setSyncedBackgroundUriIfCurrentWithinTransaction',
    'setSyncMarkerWithinTransaction',
    'updateReminderTimeWithinTransaction',
    'updateScheduledWithinTransaction',
    'updateSearchTextBatch',
    'upsertHandlesWithinTransaction',
  ]);
  const selected = findings.filter(
    (finding) =>
      (reviewedPaths.has(finding.path) && finding.detectedContext === 'coordinated-delegation') ||
      (leafSymbols.has(finding.symbol.split('.<callback:')[0]) &&
        finding.detectedContext === 'withDbTransaction'),
  );
  const restoreTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/backup/backup.ts' &&
      finding.symbol.startsWith('restoreBackup') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext),
  );
  const clearLocalCacheMarkerTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/maintenance.ts' &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/sync.ts#setSyncMarkerWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/maintenance.ts#clearLocalCache.<callback:',
          ))),
  );
  const chatDraftTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/chatActions.ts' &&
      finding.symbol.startsWith('saveChatDraft.') &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/kv.ts#kvSetWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/services/chatActions.ts#saveChatDraft.<callback:'))),
  );
  const serverAvatarTransaction = findings.filter(
    (finding) =>
      finding.path === 'src/services/contacts/serverAvatars.ts' &&
      finding.symbol.startsWith('backfillServerAvatars') &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/contacts.ts#setHandleServerAvatarWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/services/contacts/serverAvatars.ts#backfillServerAvatars.<callback:',
          ))),
  );
  const createReminderTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/reminders.ts' &&
      finding.symbol.startsWith('createReminder') &&
      !finding.symbol.startsWith('createReminderWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/reminders.ts#createReminderWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/db/repositories/reminders.ts#createReminder.<callback:'))),
  );
  const updateReminderTimeTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/reminders.ts' &&
      finding.symbol.startsWith('updateReminderTime') &&
      !finding.symbol.startsWith('updateReminderTimeWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      finding.snippet.includes('updateReminderTimeWithinTransaction'),
  );
  const insertScheduledTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/scheduled.ts' &&
      finding.symbol.startsWith('insertScheduled') &&
      !finding.symbol.startsWith('insertScheduledWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/scheduled.ts#insertScheduledWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/scheduled.ts#insertScheduled.<callback:',
          ))),
  );
  const updateScheduledTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/scheduled.ts' &&
      finding.symbol.startsWith('updateScheduled') &&
      !finding.symbol.startsWith('updateScheduledWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/scheduled.ts#updateScheduledWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/scheduled.ts#updateScheduled.<callback:',
          ))),
  );
  const sendSuccessOwnerTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      (finding.symbol.startsWith('reconcileOutgoingSuccess') ||
        finding.symbol.startsWith('markOutgoingSentNoGuid')) &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#markOutgoingSentNoGuidWithinTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          (finding.target.startsWith(
            'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess.<callback:',
          ) ||
            finding.target.startsWith(
              'src/db/repositories/outgoing.ts#markOutgoingSentNoGuid.<callback:',
            )))),
  );
  const retryClaimTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      finding.symbol.startsWith('claimFailedOutgoingForRetry') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetryWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetry.<callback:',
          ))),
  );
  const automaticClaimTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoingRetry.ts' &&
      finding.symbol.startsWith('claimOutgoingForSend') &&
      !finding.symbol.startsWith('claimOutgoingForSendWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoingRetry.ts#claimOutgoingForSendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/outgoingRetry.ts#claimOutgoingForSend.<callback:',
          ))),
  );
  const discardOutgoingTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      finding.symbol.startsWith('discardOutgoingMessage') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#discardOutgoingMessageWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/outgoing.ts#discardOutgoingMessage.<callback:',
          ))),
  );
  const retireOutgoingTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      finding.symbol.startsWith('retireOutgoing') &&
      !finding.symbol.startsWith('retireOutgoingWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/outgoing.ts#retireOutgoingWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/db/repositories/outgoing.ts#retireOutgoing.<callback:'))),
  );
  const insertOutgoingAttachmentTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/attachments.ts' &&
      finding.symbol.startsWith('insertOutgoingAttachment') &&
      !finding.symbol.startsWith('insertOutgoingAttachmentWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/attachments.ts#insertOutgoingAttachment.<callback:',
          ))),
  );
  const insertOutgoingReactionTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      finding.symbol.startsWith('insertOutgoingReaction') &&
      !finding.symbol.startsWith('insertOutgoingReactionWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#insertOutgoingReactionWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/outgoing.ts#insertOutgoingReaction.<callback:',
          ))),
  );
  const insertOutgoingContactTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/outgoing.ts' &&
      finding.symbol.startsWith('insertOutgoingContact') &&
      !finding.symbol.startsWith('insertOutgoingContactWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target ===
          'src/db/repositories/outgoing.ts#insertOutgoingContactWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/outgoing.ts#insertOutgoingContact.<callback:',
          ))),
  );
  const deleteMessageLocalTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/messages.ts' &&
      finding.symbol.startsWith('deleteMessageLocal') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#deleteMessageLocalWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/messages.ts#deleteMessageLocal.<callback:',
          ))),
  );
  const applyLocalEditTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/messages.ts' &&
      finding.symbol.startsWith('applyLocalEdit') &&
      !finding.symbol.startsWith('applyLocalEditWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#applyLocalEditWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/db/repositories/messages.ts#applyLocalEdit.<callback:'))),
  );
  const applyLocalUnsendTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/messages.ts' &&
      finding.symbol.startsWith('applyLocalUnsend') &&
      !finding.symbol.startsWith('applyLocalUnsendWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#applyLocalUnsendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/messages.ts#applyLocalUnsend.<callback:',
          ))),
  );
  const revertLocalEditTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/messages.ts' &&
      finding.symbol.startsWith('revertLocalEdit') &&
      !finding.symbol.startsWith('revertLocalEditWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#revertLocalEditWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith('src/db/repositories/messages.ts#revertLocalEdit.<callback:'))),
  );
  const revertLocalUnsendTransactions = findings.filter(
    (finding) =>
      finding.path === 'src/db/repositories/messages.ts' &&
      finding.symbol.startsWith('revertLocalUnsend') &&
      !finding.symbol.startsWith('revertLocalUnsendWithinTransaction') &&
      ['transaction-coordinator', 'withDbTransaction'].includes(finding.detectedContext) &&
      (finding.target === 'src/db/transaction.ts#withDbTransaction' ||
        finding.target === 'src/db/repositories/messages.ts#revertLocalUnsendWithinTransaction' ||
        (finding.detectedContext === 'withDbTransaction' &&
          finding.target.startsWith(
            'src/db/repositories/messages.ts#revertLocalUnsend.<callback:',
          ))),
  );

  assert.deepEqual(
    selected.map((finding) => finding.id).sort(),
    [
      'app/(app)/new-chat.tsx#NewChatScreen.<callback:6cde4fbfd5>:mutator-call:b4a563a44345',
      'app/(app)/new-chat.tsx#NewChatScreen.onStart:mutator-call:4838a450d3a7',
      'src/db/repositories/chats.ts#deleteChatLocal:mutator-call:4b0c893b8080',
      'src/db/repositories/chats.ts#markAllChatsReadLocalWithinTransaction:sql-update:52eca3e393a6',
      'src/db/repositories/chats.ts#reconcileReadMarkersFromTimestamps:sql-update:9a087251324f',
      'src/db/repositories/chats.ts#resumeChatPurges:mutator-call:09fe46a88daa',
      'src/db/repositories/chatAppearance.ts#setChatAppearanceWithinTransaction:drizzle-update:dcdfc8b2ae2e',
      'src/db/repositories/chats.ts#setChatArchiveWithinTransaction:drizzle-update:3391b90becf2',
      'src/db/repositories/chatAppearance.ts#setChatCustomizationWithinTransaction:drizzle-update:619f3250f770',
      'src/db/repositories/chats.ts#setChatMuteWithinTransaction:drizzle-update:467399acf638',
      'src/db/repositories/chats.ts#setChatPinWithinTransaction:sql-update:600d385756f7',
      'src/db/repositories/chatAppearance.ts#setSyncedBackgroundLuminanceIfCurrentWithinTransaction:drizzle-update:3887cf9f4044',
      'src/db/repositories/chatAppearance.ts#setSyncedBackgroundUriIfCurrentWithinTransaction:drizzle-update:0ac7abb5b110',
      'src/db/repositories/chats.ts#swapPinnedChatOrderWithinTransaction:sql-update:b0faceaf9bcd',
      'src/db/repositories/contacts.ts#setHandleServerAvatarWithinTransaction:drizzle-update:6f0e2fd8121c',
      'src/db/repositories/errorReports.ts#claimErrorReportsWithinTransaction:sql-update:a6cadd1370ec',
      'src/db/repositories/errorReports.ts#deleteErrorReportsWithinTransaction:sql-delete:bb847c13001b',
      'src/db/repositories/errorReports.ts#listRetryableErrorReportsWithinTransaction.<callback:6d0d0f76a3>:mutator-call:38305fef3c77',
      'src/db/repositories/errorReports.ts#markErrorReportsFailedWithinTransaction:sql-delete:b6a752ef4ffa',
      'src/db/repositories/errorReports.ts#markErrorReportsFailedWithinTransaction:sql-update:fafc5a007c8e',
      'src/db/repositories/reminders.ts#createReminderWithinTransaction:drizzle-insert:3f7e289128b3',
      'src/db/repositories/reminders.ts#deleteReminderByNotificationIdWithinTransaction:drizzle-delete:c5786892fa3b',
      'src/db/repositories/reminders.ts#deleteReminderWithinTransaction:drizzle-delete:4d16415ac0cf',
      'src/db/repositories/reminders.ts#updateReminderTimeWithinTransaction:drizzle-update:69b01aa5bda9',
      'src/db/repositories/backup.ts#restorePreparedBackupWithinTransaction:sql-insert:06ff79484d3e',
      'src/db/repositories/backup.ts#restorePreparedBackupWithinTransaction:sql-insert:d7e3e27b0ac0',
      'src/db/repositories/backup.ts#restorePreparedBackupWithinTransaction:sql-update:1978156bf977',
      'src/db/repositories/backup.ts#restorePreparedBackupWithinTransaction:sql-update:22e3903ba5ed',
      'src/db/repositories/scheduled.ts#insertScheduledWithinTransaction:drizzle-insert:cc8ec01847ce',
      'src/db/repositories/scheduled.ts#deleteScheduledHistoryWithinTransaction:drizzle-delete:7419c1ff4890',
      'src/db/repositories/scheduled.ts#deleteScheduledWithinTransaction:drizzle-delete:8fead5d6c602',
      'src/db/repositories/scheduled.ts#updateScheduledWithinTransaction:drizzle-update:65c7e3fe2055',
      'src/db/repositories/handles.ts#upsertHandlesWithinTransaction:drizzle-insert:147fd2d8dc47',
      'src/db/repositories/kv.ts#kvSetWithinTransaction:drizzle-insert:0fe9d15a2010',
      'src/db/repositories/outgoingRetry.ts#markMessageSendErrorWithinTransaction:drizzle-update:254ffd3887c5',
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuidWithinTransaction:drizzle-delete:8425f72e3b86',
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuidWithinTransaction:drizzle-delete:8425f72e3b86:2',
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuidWithinTransaction:sql-update:21d3ccc056b3',
      'src/db/repositories/outgoingRetry.ts#claimOutgoingForSendWithinTransaction:drizzle-update:7f620d3bb4f5',
      'src/db/repositories/outgoingRetry.ts#claimOutgoingForSendWithinTransaction:sql-update:25d36f3569c3',
      'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetryWithinTransaction:sql-update:1365bab7e11e',
      'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetryWithinTransaction:sql-update:74de183f35c6',
      'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction:drizzle-insert:5374f7183358',
      'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction:drizzle-insert:eca25accb829',
      'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction:drizzle-insert:fc8d72883c5b',
      'src/db/repositories/attachments.ts#insertOutgoingAttachmentWithinTransaction:drizzle-update:1de3c8263d4f',
      'src/db/repositories/outgoing.ts#insertOutgoingContactWithinTransaction:drizzle-insert:325cfa72fa07',
      'src/db/repositories/outgoing.ts#insertOutgoingContactWithinTransaction:drizzle-insert:5371eb923c6f',
      'src/db/repositories/outgoing.ts#insertOutgoingContactWithinTransaction:drizzle-update:f9ebc8cf63d8',
      'src/db/repositories/outgoing.ts#insertOutgoingReactionWithinTransaction:drizzle-insert:60b18ede0ce6',
      'src/db/repositories/outgoing.ts#insertOutgoingReactionWithinTransaction:drizzle-insert:8ad15d9f2163',
      'src/db/repositories/outgoing.ts#retireOutgoingWithinTransaction:drizzle-update:235ea7732450',
      'src/db/repositories/outgoing.ts#retireOutgoingWithinTransaction:drizzle-update:c06b002a01f7',
      'src/db/repositories/messages.ts#deleteMessageLocalWithinTransaction.<callback:4315b7c2a1>:mutator-call:8f577f345052',
      'src/db/repositories/messages.ts#deleteMessageLocalWithinTransaction:drizzle-delete:d78d925090ff',
      'src/db/repositories/messages.ts#applyLocalEditWithinTransaction:drizzle-update:a52bab6f4d6f',
      'src/db/repositories/messages.ts#applyLocalUnsendWithinTransaction:drizzle-update:e31d64188078',
      'src/db/repositories/messages.ts#revertLocalEditWithinTransaction:sql-update:61bd18cc4a5f',
      'src/db/repositories/messages.ts#revertLocalUnsendWithinTransaction:sql-update:b1fe717be3ae',
      'src/db/repositories/outgoing.ts#discardOutgoingMessageWithinTransaction.<callback:a1e7b9de6b>:mutator-call:d5204e46c499',
      'src/db/repositories/outgoing.ts#discardOutgoingMessageWithinTransaction:drizzle-delete:2cde35e0f6d4',
      'src/db/repositories/outgoing.ts#discardOutgoingMessageWithinTransaction:sql-update:1320d8a402de',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction.<callback:7038d35d21>:mutator-call:17a4a16e0a8e',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction.<callback:7038d35d21>:mutator-call:4f9ad23d68e9',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction.<callback:7038d35d21>:mutator-call:53202ca06801',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction:drizzle-delete:0bd89180f0e1',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction:drizzle-delete:3374b727a87f',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction:drizzle-update:caa13f78f819',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccessWithinTransaction:sql-update:fb0297907ce8',
      'src/db/repositories/chats.ts#setChatUnreadLocalWithinTransaction:drizzle-update:bc72f0e85266',
      'src/db/repositories/sync.ts#setSyncMarkerWithinTransaction:drizzle-update:7582ca63d697',
      'src/features/facetime/useFaceTime.ts#useFaceTime.<callback:fff597c8bc>:mutator-call:ea4e12c6ab95',
      'src/services/backup/backupService.ts#restoreCurrentBackup.<callback:bdb49d16ac>:mutator-call:7143c8024e48',
      'src/services/chat/groupManagement.ts#renameGroupChat.<callback:c13ecdb63a>:mutator-call:2e89e3325c50',
      'src/services/chat/groupManagement.ts#updateGroupParticipant.<callback:50428f1bde>:mutator-call:4e81064f65bb',
      'src/services/databaseControl.ts#updateSearchTextBatch:sql-update:3f71f4710a3f',
    ].sort(),
  );
  assert.equal(selected.length, 76);
  assert.deepEqual(
    restoreTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/backup/backup.ts#restoreBackup.<callback:0154bc3d51>:mutator-call:7ecb8b973875',
      'src/services/backup/backup.ts#restoreBackup:mutator-call:712f6a809fbc',
      'src/services/backup/backup.ts#restoreBackup:mutator-call:cedfc911f115',
    ].sort(),
  );
  assert.deepEqual(
    clearLocalCacheMarkerTransaction.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/maintenance.ts#clearLocalCache.<callback:f5b3fd4c12>:mutator-call:7571dbda310a',
      'src/db/repositories/maintenance.ts#clearLocalCache:mutator-call:2ffb1910cfce',
      'src/db/repositories/maintenance.ts#clearLocalCache:mutator-call:7ff9694f91da',
    ].sort(),
  );
  assert.deepEqual(
    chatDraftTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/chatActions.ts#saveChatDraft.<callback:9ae03f03fc>.<callback:126fc1e56e>:mutator-call:bc0d1a9ae9ce',
      'src/services/chatActions.ts#saveChatDraft.<callback:9ae03f03fc>:mutator-call:641f69856a73',
      'src/services/chatActions.ts#saveChatDraft.<callback:9ae03f03fc>:mutator-call:6d954968e9f8',
    ].sort(),
  );
  assert.deepEqual(
    serverAvatarTransaction.map((finding) => finding.id).sort(),
    [
      'src/services/contacts/serverAvatars.ts#backfillServerAvatars.<callback:ce605bb71a>.<callback:77cdb8c804>:mutator-call:300095ddd30c',
      'src/services/contacts/serverAvatars.ts#backfillServerAvatars.<callback:ce605bb71a>:mutator-call:478f5d06d71e',
      'src/services/contacts/serverAvatars.ts#backfillServerAvatars.<callback:ce605bb71a>:mutator-call:9f5be45386f3',
    ].sort(),
  );
  assert.deepEqual(
    createReminderTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/reminders.ts#createReminder.<callback:93ad5d4304>:mutator-call:a479b4f12b8b',
      'src/db/repositories/reminders.ts#createReminder:mutator-call:237141e4ef46',
      'src/db/repositories/reminders.ts#createReminder:mutator-call:9cec12455bc4',
    ].sort(),
  );
  assert.deepEqual(
    updateReminderTimeTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/reminders.ts#updateReminderTime.<callback:01f3a3c07f>:mutator-call:861aece00d05',
      'src/db/repositories/reminders.ts#updateReminderTime:mutator-call:1516cdcafef5',
      'src/db/repositories/reminders.ts#updateReminderTime:mutator-call:920049d903c2',
    ].sort(),
  );
  assert.deepEqual(
    insertScheduledTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/scheduled.ts#insertScheduled.<callback:6909ad3bc5>:mutator-call:1b3e4af90ec4',
      'src/db/repositories/scheduled.ts#insertScheduled:mutator-call:a7f6784fcded',
      'src/db/repositories/scheduled.ts#insertScheduled:mutator-call:de8b7dc6408f',
    ].sort(),
  );
  assert.deepEqual(
    updateScheduledTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/scheduled.ts#updateScheduled.<callback:45d83ae862>:mutator-call:90bc9a3e87f3',
      'src/db/repositories/scheduled.ts#updateScheduled:mutator-call:0445ebfc3bea',
      'src/db/repositories/scheduled.ts#updateScheduled:mutator-call:f53009bb2e28',
    ].sort(),
  );
  assert.deepEqual(
    sendSuccessOwnerTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuid.<callback:a142c06cb1>:mutator-call:c476b9568e57',
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuid:mutator-call:7b31765b5cbe',
      'src/db/repositories/outgoing.ts#markOutgoingSentNoGuid:mutator-call:9e7cb9dc1fb3',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess.<callback:a142c06cb1>:mutator-call:dd151c6d7808',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess.<callback:350f3c11ce>:mutator-call:466aed95663c',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess:mutator-call:43b965ef483f',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess:mutator-call:9efd07b3e6a8',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess:mutator-call:7cffdc80344c',
      'src/db/repositories/outgoing.ts#reconcileOutgoingSuccess:mutator-call:dc16ee7659f0',
    ].sort(),
  );
  assert.deepEqual(
    retryClaimTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetry.<callback:e9bf331847>:mutator-call:4b8448a9e2d5',
      'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetry:mutator-call:0ef007da403c',
      'src/db/repositories/outgoing.ts#claimFailedOutgoingForRetry:mutator-call:abe11442dbc6',
    ].sort(),
  );
  assert.deepEqual(
    automaticClaimTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoingRetry.ts#claimOutgoingForSend.<callback:8b54a95643>:mutator-call:4da8b89b721a',
      'src/db/repositories/outgoingRetry.ts#claimOutgoingForSend:mutator-call:1dbbf9522fdd',
      'src/db/repositories/outgoingRetry.ts#claimOutgoingForSend:mutator-call:6041bba0203c',
    ].sort(),
  );
  assert.deepEqual(
    discardOutgoingTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#discardOutgoingMessage.<callback:8d83cb9fc1>:mutator-call:0be1e09bf5c4',
      'src/db/repositories/outgoing.ts#discardOutgoingMessage:mutator-call:6218930bffa9',
      'src/db/repositories/outgoing.ts#discardOutgoingMessage:mutator-call:d96cda348479',
    ].sort(),
  );
  assert.deepEqual(
    retireOutgoingTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#retireOutgoing.<callback:f2328120f0>:mutator-call:298962d2933f',
      'src/db/repositories/outgoing.ts#retireOutgoing:mutator-call:bc4e8c366140',
      'src/db/repositories/outgoing.ts#retireOutgoing:mutator-call:c3043ae321f5',
    ].sort(),
  );
  assert.deepEqual(
    insertOutgoingAttachmentTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/attachments.ts#insertOutgoingAttachment.<callback:a5e1fc3fd8>:mutator-call:3069c9e0883c',
      'src/db/repositories/attachments.ts#insertOutgoingAttachment:mutator-call:060b68f9fb33',
      'src/db/repositories/attachments.ts#insertOutgoingAttachment:mutator-call:2109f62f577e',
    ].sort(),
  );
  assert.deepEqual(
    insertOutgoingContactTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#insertOutgoingContact.<callback:98f48e222c>:mutator-call:09a076f2e3c8',
      'src/db/repositories/outgoing.ts#insertOutgoingContact:mutator-call:bc8c5c28d457',
      'src/db/repositories/outgoing.ts#insertOutgoingContact:mutator-call:d628f90e07c7',
    ].sort(),
  );
  assert.deepEqual(
    insertOutgoingReactionTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/outgoing.ts#insertOutgoingReaction.<callback:f1bafaf13b>:mutator-call:72bc76227c21',
      'src/db/repositories/outgoing.ts#insertOutgoingReaction:mutator-call:64518fc230a9',
      'src/db/repositories/outgoing.ts#insertOutgoingReaction:mutator-call:9142aa33dfcf',
    ].sort(),
  );
  assert.deepEqual(
    deleteMessageLocalTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/messages.ts#deleteMessageLocal.<callback:2c9cb5d4ae>:mutator-call:c061bbf7d8c4',
      'src/db/repositories/messages.ts#deleteMessageLocal:mutator-call:231b571b1d67',
      'src/db/repositories/messages.ts#deleteMessageLocal:mutator-call:c9f4ead00063',
    ].sort(),
  );
  assert.deepEqual(
    applyLocalEditTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/messages.ts#applyLocalEdit.<callback:883947ca1e>:mutator-call:9cf93eb40606',
      'src/db/repositories/messages.ts#applyLocalEdit:mutator-call:86ec033b9584',
      'src/db/repositories/messages.ts#applyLocalEdit:mutator-call:d242660d2423',
    ].sort(),
  );
  assert.deepEqual(
    applyLocalUnsendTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/messages.ts#applyLocalUnsend.<callback:6a0c9830c6>:mutator-call:16a53eb65fd1',
      'src/db/repositories/messages.ts#applyLocalUnsend:mutator-call:4fef908e0de8',
      'src/db/repositories/messages.ts#applyLocalUnsend:mutator-call:a3df4279d248',
    ].sort(),
  );
  assert.deepEqual(
    revertLocalEditTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/messages.ts#revertLocalEdit.<callback:db18ec7032>:mutator-call:2c433275da29',
      'src/db/repositories/messages.ts#revertLocalEdit:mutator-call:a093dbcecc09',
      'src/db/repositories/messages.ts#revertLocalEdit:mutator-call:bf0de4f4d033',
    ].sort(),
  );
  assert.deepEqual(
    revertLocalUnsendTransactions.map((finding) => finding.id).sort(),
    [
      'src/db/repositories/messages.ts#revertLocalUnsend.<callback:cd36f36705>:mutator-call:7038feb61aed',
      'src/db/repositories/messages.ts#revertLocalUnsend:mutator-call:2e8d7955a2c2',
      'src/db/repositories/messages.ts#revertLocalUnsend:mutator-call:d67d4e187ef6',
    ].sort(),
  );
  assert.equal(
    findings.some(
      (finding) =>
        finding.id ===
        'src/db/repositories/contacts.ts#linkHandlesToContacts.<callback:09ff882e2a>.<callback:f24376f3c1>:dynamic-coordinator-callback:ed99cc48f9ac',
    ),
    false,
  );
});

fullOnlyTest(
  'incoming-ingress certificate fails closed on admission, lock, snapshot, and escape mutations',
  () => {
    const root = incomingIngressFixture();
    const cases = [
      {
        label: 'unadopted supplied-context tracking',
        path: 'src/services/realtimeControl.ts',
        before: '? await runTrackedRealtimeWork(context,',
        after: '? runTrackedRealtimeWork(context,',
      },
      {
        label: 'original context forwarded instead of adopted lease',
        path: 'src/services/realtimeControl.ts',
        before: 'source,\n          lease,\n          capturedOccurrence,',
        after: 'source,\n          context,\n          capturedOccurrence,',
      },
      {
        label: 'locked intake persistence bypass',
        path: 'src/services/realtimeControl.ts',
        before: 'canPersist: canPersistRealtimeEvent,',
        after: 'canPersist: () => true,',
      },
      {
        label: 'DEV proof gate bypass',
        path: 'src/services/realtimeControl.ts',
        before: 'const allowed = context.isCurrent() && isDevServer() && !realtimeIntakeLocked();',
        after: 'const allowed = true;',
      },
      {
        label: 'runtime router retained across account generation',
        path: 'src/services/realtimeControl.ts',
        before: 'sharedRouterInstance = null;',
        after: 'void sharedRouterInstance;',
      },
      {
        label: 'no-op realtime sink composition',
        path: 'src/services/realtimeControl.ts',
        transform: (source) => {
          const start = source.indexOf('function realtimeSink(db: AppDatabase): EventSink {');
          const marker = '\n}\n\n// One normalizer/sink chain per account generation.';
          const end = source.indexOf(marker, start);
          assert.notEqual(start, -1);
          assert.notEqual(end, -1);
          return `${source.slice(0, start)}function realtimeSink(db: AppDatabase): EventSink {\n  void db;\n  return { handle: async () => undefined };\n}${source.slice(end + 2)}`;
        },
      },
      {
        label: 'decoy digest backend injected into intake',
        path: 'src/services/realtimeControl.ts',
        before: 'new IncomingEventDrain(db, router, expoDigestBackend, {',
        after: 'new IncomingEventDrain(db, router, { sha256: async (input) => input }, {',
      },
      {
        label: 'generation invalidation subscription disabled',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'if (!acceptingDeliveries || generation !== accountGeneration) {',
        after: 'if (true) {',
      },
      {
        label: 'captured account lease never expires',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before:
          'isCurrent: () => acceptedAtCapture && acceptingDeliveries && generation === accountGeneration,',
        after: 'isCurrent: () => true,',
      },
      {
        label: 'captured account lease shadows generation state',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'export function captureRealtimeDeliveryLease(): RealtimeDeliveryLease {',
        after:
          'export function captureRealtimeDeliveryLease(accountGeneration = 0, acceptingDeliveries = true): RealtimeDeliveryLease {',
      },
      {
        label: 'pause leaves the retired account generation current',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: '    accountGeneration += 1;',
        after: '    void accountGeneration;',
      },
      {
        label: 'resume resurrects the original account generation',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'export function resumeRealtimeDeliveries(): void {\n  acceptingDeliveries = true;',
        after:
          'export function resumeRealtimeDeliveries(): void {\n  accountGeneration = 0;\n  acceptingDeliveries = true;',
      },
      {
        label: 'generation listener map discards subscriptions',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'const generationInvalidationListeners = new Map<number, Set<() => void>>();',
        after:
          'class DroppingListenerMap extends Map<number, Set<() => void>> { override set(): this { return this; } }\nconst generationInvalidationListeners = new DroppingListenerMap();',
      },
      {
        label: 'generation listener map is overwritten after initialization',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'const generationInvalidationListeners = new Map<number, Set<() => void>>();',
        after:
          'const generationInvalidationListeners = new Map<number, Set<() => void>>();\ngenerationInvalidationListeners.set = () => generationInvalidationListeners;',
      },
      {
        label: 'admitted-delivery set discards registrations',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: 'const admittedDeliveries = new Set<Promise<void>>();',
        after:
          'class DroppingDeliverySet extends Set<Promise<void>> { override add(): this { return this; } }\nconst admittedDeliveries = new DroppingDeliverySet();',
      },
      {
        label: 'tracked work skips teardown registration',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: '  admittedDeliveries.add(drainSlot);',
        after: '  void admittedDeliveries;',
      },
      {
        label: 'tracked failure never settles its teardown slot',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: '  void result.then(finishTracking, finishTracking);',
        after: '  void result.then(finishTracking);',
      },
      {
        label: 'pause does not await admitted deliveries',
        path: 'src/services/realtime/deliveryCoordinator.ts',
        before: '  await Promise.all([...admittedDeliveries]);',
        after: '  await Promise.all([]);',
      },
      {
        label: 'optional socket durable handler',
        path: 'src/services/realtime/socketService.ts',
        before: 'handler: RawRealtimeEventHandler,',
        after: 'handler?: RawRealtimeEventHandler,',
      },
      {
        label: 'socket account lease accessor always reports current',
        path: 'src/services/realtime/socketService.ts',
        before: 'private accountLease: RealtimeDeliveryLease | null = null;',
        after:
          'private get accountLease(): RealtimeDeliveryLease | null { return { generation: 0, isCurrent: () => true }; }\n  private set accountLease(_value: RealtimeDeliveryLease | null) {}',
      },
      {
        label: 'socket lifecycle callback decoy',
        path: 'src/services/realtime/socketService.ts',
        before: 'this.socket.on(event, (data: unknown) => {',
        after: 'if (false) this.socket.on(event, (data: unknown) => {',
      },
      {
        label: 'socket server event loop disabled',
        path: 'src/services/realtime/socketService.ts',
        before: 'for (const event of SERVER_EVENTS) {',
        after: 'for (const event of []) {',
      },
      {
        label: 'socket escalation keeps retired lifecycle current',
        path: 'src/services/realtime/socketService.ts',
        before:
          '      this.lifecycleGeneration += 1;\n      lifecycleGeneration = this.lifecycleGeneration;',
        after:
          '      void this.lifecycleGeneration;\n      lifecycleGeneration = this.lifecycleGeneration;',
      },
      {
        label: 'socket escalation silently changes the approved origin',
        path: 'src/services/realtime/socketService.ts',
        before: '      this.lifecycleGeneration += 1;',
        after:
          "      this.origin = 'https://unapproved.example';\n      this.lifecycleGeneration += 1;",
      },
      {
        label: 'socket fallback nonce uses a shadowed Date',
        path: 'src/services/realtime/socketService.ts',
        before: 'let processSocketOpenSequence = 0;',
        after: 'const Date = { now: () => 0 };\nlet processSocketOpenSequence = 0;',
      },
      {
        label: 'socket fallback nonce uses a shadowed Math',
        path: 'src/services/realtime/socketService.ts',
        before: 'let processSocketOpenSequence = 0;',
        after:
          'const Math = { random: () => 0, floor: globalThis.Math.floor, max: globalThis.Math.max, min: globalThis.Math.min, round: globalThis.Math.round };\nlet processSocketOpenSequence = 0;',
      },
      {
        label: 'dispatcher re-reads caller payload after FIFO wait',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: 'return await this.persist(\n          event,',
        after: 'return await this.persist(\n          snapshotIncomingEvent(eventName, rawData),',
      },
      {
        label: 'dispatcher rewrites the snapshot after FIFO wait',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '      await previous;\n      try {',
        after:
          '      await previous;\n      event = snapshotIncomingEvent(eventName, rawData);\n      try {',
      },
      {
        label: 'dispatcher skips its FIFO predecessor',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '      await previous;\n      try {',
        after: '      void previous;\n      try {',
      },
      {
        label: 'dispatcher releases its FIFO slot before admission',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '    const admission = (async () => {',
        after: '    release();\n    const admission = (async () => {',
      },
      {
        label: 'dispatcher FIFO resolver is not retained',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '      release = resolve;',
        after: '      void resolve;',
      },
      {
        label: 'dispatcher FIFO slot is not released in finally',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '        release();',
        after: '        void release;',
      },
      {
        label: 'dispatcher FIFO uses a shadowed Promise constructor',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: 'export class DurableRealtimeDispatcher {',
        after: 'const Promise = globalThis.Promise;\nexport class DurableRealtimeDispatcher {',
      },
      {
        label: 'dispatcher snapshot helper becomes asynchronous',
        path: 'src/core/realtime/incomingEventCodec.ts',
        before: 'export function snapshotIncomingEvent(',
        after: 'export async function snapshotIncomingEvent(',
      },
      {
        label: 'dispatcher persistence guard always permits admission',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before:
          '      const allowed =\n        !this.stopped &&\n        (!context || context.isCurrent()) &&\n        (!this.options.canPersist || this.options.canPersist(event));',
        after: '      const allowed = true;',
      },
      {
        label: 'normal enqueue receives a different guard',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: 'result = await enqueueIncomingEvent(this.db, encoded.envelope, guard, this.now);',
        after:
          'result = await enqueueIncomingEvent(this.db, encoded.envelope, () => true, this.now);',
      },
      {
        label: 'atomic DEV enqueue receives a different guard',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before:
          '          { now: receivedAt, clock: this.now, leaseToken: devLeaseToken },\n          guard,\n        );',
        after:
          '          { now: receivedAt, clock: this.now, leaseToken: devLeaseToken },\n          () => true,\n        );',
      },
      {
        label: 'public capture returns caller-owned payload data',
        path: 'src/core/realtime/incomingEventCodec.ts',
        before:
          'return { eventName: canonical.eventName, rawData: JSON.parse(canonical.payload) };',
        after: 'return { eventName: canonical.eventName, rawData };',
      },
      {
        label: 'dispatcher snapshot reuses the caller-owned payload',
        path: 'src/core/realtime/incomingEventCodec.ts',
        before:
          'return captured ? normalizeRealtimeEvent(captured.eventName, captured.rawData) : null;',
        after: 'return captured ? normalizeRealtimeEvent(eventName, rawData) : null;',
      },
      {
        label: 'public capture uses a shadowed JSON parser',
        path: 'src/core/realtime/incomingEventCodec.ts',
        before: 'export function captureIncomingEvent(',
        after:
          'const JSON = { parse: (value: string): unknown => value };\nexport function captureIncomingEvent(',
      },
      {
        label: 'dispatcher retirement leaves its drain running',
        path: 'src/services/realtime/incomingEventDispatcher.ts',
        before: '  dispose(): void {\n    this.stopped = true;\n    this.drain.dispose();\n  }',
        after: '  dispose(): void {}',
      },
      {
        label: 'runtime reset skips dispatcher retirement',
        path: 'src/services/realtimeControl.ts',
        before: '  current.dispatcher.dispose();',
        after: '  void current.dispatcher;',
      },
      {
        label: 'drain retirement leaves its scheduled wake running',
        path: 'src/services/realtime/incomingEventDrain.ts',
        before: '  dispose(): void {\n    this.stopped = true;\n    this.cancelWakeTimer();\n  }',
        after: '  dispose(): void {}',
      },
      {
        label: 'drain wake cancellation is disabled',
        path: 'src/services/realtime/incomingEventDrain.ts',
        before:
          '  private cancelWakeTimer(): void {\n    if (this.wakeTimer == null) return;\n    (this.options.cancelWake ?? clearTimeout)(this.wakeTimer);\n    this.wakeTimer = null;\n  }',
        after: '  private cancelWakeTimer(): void {}',
      },
      {
        label: 'drain wake cancellation uses a shadowed clearTimeout',
        path: 'src/services/realtime/incomingEventDrain.ts',
        before: 'export const INCOMING_EVENT_DELIVERY_TIMEOUT_MS = 90_000;',
        after:
          'const clearTimeout = (_handle: ReturnType<typeof setTimeout>): void => {};\nexport const INCOMING_EVENT_DELIVERY_TIMEOUT_MS = 90_000;',
      },
      {
        label: 'FCM defaults unlocked',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'let locked = true;',
        after: 'let locked = false;',
      },
      {
        label: 'lease-token crypto call resolves to a constant decoy',
        path: 'src/services/realtimeControl.ts',
        transform: (source) =>
          source
            .replace(
              "import * as Crypto from 'expo-crypto';",
              "import * as RealCrypto from 'expo-crypto';\nconst Crypto = { randomUUID: () => 'constant-token' };",
            )
            .replace(
              'const fallbackOccurrenceNamespace = Crypto.randomUUID();',
              'const fallbackOccurrenceNamespace = RealCrypto.randomUUID();',
            ),
      },
      {
        label: 'digest crypto call resolves to an identity decoy',
        path: 'src/services/realtime/expoDigestBackend.ts',
        transform: (source) =>
          source.replace(
            "import * as Crypto from 'expo-crypto';",
            "import * as RealCrypto from 'expo-crypto';\nvoid RealCrypto;\nconst Crypto = { digest: async (_algorithm: unknown, bytes: Uint8Array) => bytes, CryptoDigestAlgorithm: { SHA256: 'SHA-256' } };",
          ),
      },
      {
        label: 'FCM later callback bypasses the admission tail',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'const previous = fcmAdmissionTail;',
        after: 'const previous = Promise.resolve();',
      },
      {
        label: 'FCM admission tail uses a shadowed never-settling Promise',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'let fcmAdmissionTail: Promise<void> = Promise.resolve();',
        after:
          'const Promise = { resolve: (): globalThis.Promise<void> => new globalThis.Promise<void>(() => undefined) };\nlet fcmAdmissionTail: Promise<void> = Promise.resolve();',
      },
      {
        label: 'FCM receipt clock and process nonce use a shadowed Date',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'const fcmProcessOccurrenceNonce =',
        after: 'const Date = { now: () => 0 };\nconst fcmProcessOccurrenceNonce =',
      },
      {
        label: 'FCM process nonce uses a shadowed Math',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'const fcmProcessOccurrenceNonce =',
        after: 'const Math = { random: () => 0 };\nconst fcmProcessOccurrenceNonce =',
      },
      {
        label: 'FCM capture yields before reserving FIFO position',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: 'const delivery = captureFcmDelivery(msg);',
        after: 'const delivery = await Promise.resolve(captureFcmDelivery(msg));',
      },
      {
        label: 'FCM tracking invocation evaluates a yielding extra argument',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: '    const tracked = runTrackedRealtimeDelivery(async (lease) => {',
        after: '    const tracked = runTrackedRealtimeDelivery(async (lease) => {',
        transform: (source) =>
          source.replace(
            '      await deliverRespectingLock(delivery, source, lease);\n    });',
            '      await deliverRespectingLock(delivery, source, lease);\n    }, await Promise.resolve());',
          ),
      },
      {
        label: 'FCM failure poisons the admission tail',
        path: 'src/services/notifications/fcmMessaging.ts',
        before:
          '    fcmAdmissionTail = tracked.then(\n      () => undefined,\n      () => undefined,\n    );',
        after: '    fcmAdmissionTail = tracked.then(() => undefined);',
      },
      {
        label: 'FCM queued callback skips its post-wait lease check',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: '      if (!lease.isCurrent()) return;\n      await deliverRespectingLock',
        after: '      await Promise.resolve();\n      await deliverRespectingLock',
      },
      {
        label: 'detached headless handler',
        path: 'src/services/notifications/fcmMessaging.ts',
        before: "await handleIncomingFcm(msg, 'background');",
        after: "void handleIncomingFcm(msg, 'background');",
      },
      {
        label: 'conditional background registration',
        path: 'src/services/notifications/registerFcmBackgroundHandler.ts',
        before: 'setBackgroundMessageHandler(getMessaging(), handleBackgroundFcm);',
        after: 'if (false) setBackgroundMessageHandler(getMessaging(), handleBackgroundFcm);',
      },
      {
        label: 'second background registration overrides the durable handler',
        path: 'src/services/notifications/registerFcmBackgroundHandler.ts',
        transform: (source) =>
          `${source}\nsetBackgroundMessageHandler(getMessaging(), async () => undefined);\n`,
      },
      {
        label: 'killed-app entry import removed',
        path: 'index.js',
        before: "import './src/services/notifications/registerFcmBackgroundHandler';",
        after: "import './src/services/notifications/fcmPayload';",
      },
      {
        label: 'bundle entry no longer points at index',
        path: 'package.json',
        before: '"main": "index.js"',
        after: '"main": "expo-router/entry"',
      },
      {
        label: 'DEV helper fails open in release',
        path: 'src/utils/isDev.ts',
        before: "  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;",
        after: '  return true;',
      },
      {
        label: 'lock helper always reports unlocked',
        path: 'src/services/notifications/lockGate.ts',
        transform: (source) =>
          source.replace(
            /export function effectivelyLocked\([\s\S]*?\n}\n$/,
            'export function effectivelyLocked(lock: any, appLockEnabled: boolean, now = Date.now()): boolean {\n  void lock; void appLockEnabled; void now;\n  return false;\n}\n',
          ),
      },
      {
        label: 'FCM session helper always reports active',
        path: 'src/services/notifications/fcmSessionGate.ts',
        transform: (source) =>
          source.replace(
            /export async function readFcmSessionState\([\s\S]*?\n}\n$/,
            "export async function readFcmSessionState(vault: any, revocationMarker: any): Promise<FcmSessionState> {\n  void vault; void revocationMarker;\n  return 'active';\n}\n",
          ),
      },
      {
        label: 'active session marker aliases the writing state',
        path: 'src/core/secure/vault.ts',
        before: "  active: 'active',",
        after: "  active: 'writing',",
      },
      {
        label: 'DEV seed owner guard removed',
        path: 'src/features/conversations/devSeed.ts',
        before:
          'export async function injectMessage(accountLease: RealtimeDeliveryLease): Promise<void> {\n  if (!isDevServer()) return;',
        after:
          'export async function injectMessage(accountLease: RealtimeDeliveryLease): Promise<void> {',
      },
      {
        label: 'chat DEV callback loses its release gate',
        path: 'app/(app)/chat/[guid].tsx',
        before: 'if (!isDevServer() || !accountLease.isCurrent()) return;',
        after: 'if (!accountLease.isCurrent()) return;',
      },
      {
        label: 'rotation proposal bypasses the canonical snapshot',
        path: 'src/services/realtimeControl.ts',
        before: 'const normalized = snapshotIncomingEvent(captured.eventName, captured.rawData);',
        after: 'const normalized = snapshotIncomingEvent(eventName, rawData);',
      },
      {
        label: 'rotation approval handoff is detached',
        path: 'src/services/realtimeControl.ts',
        before: '    await applyNewServerUrl(normalized.url, context);',
        after: '    void applyNewServerUrl(normalized.url, context);',
      },
      {
        label: 'rotation event is allowed into durable persistence',
        path: 'src/services/realtimeControl.ts',
        before: "  if (event.type !== 'new-server') return true;",
        after: '  return true;',
      },
      {
        label: 'escaped public dispatcher reference',
        path: 'src/services/realtimeControl.ts',
        transform: (source) =>
          `${source}\nexport const escapedIncomingDispatch = dispatchRealtimeEvent;\n`,
      },
      {
        label: 'raw writer added under protected admission owner',
        path: 'src/services/realtimeControl.ts',
        before: '  const receivedAt = occurrence?.receivedAt ?? Date.now();',
        after:
          "  await db.execute('DELETE FROM messages');\n  const receivedAt = occurrence?.receivedAt ?? Date.now();",
      },
    ];

    try {
      const baseline = scanDbWrites({ root });
      assert.equal(
        baseline.filter((finding) => finding.detectedContext === 'incoming-ingress-delegation')
          .length,
        22,
        'incoming-ingress fixture must exercise the live positive certificate',
      );
      for (const mutation of cases) {
        const file = resolve(root, mutation.path);
        const original = readFileSync(file, 'utf8');
        try {
          if (mutation.transform) {
            writeFileSync(file, mutation.transform(original));
          } else {
            replaceFixtureSource(root, mutation.path, mutation.before, mutation.after);
          }
          const findings = scanDbWrites({ root });
          assert.equal(
            findings.filter((finding) => finding.detectedContext === 'incoming-ingress-delegation')
              .length,
            0,
            mutation.label,
          );
          assert.ok(
            findings.some(
              (finding) =>
                finding.target.endsWith('src/services/realtimeControl.ts#dispatchRealtimeEvent') &&
                finding.detectedContext === 'unresolved',
            ),
            mutation.label,
          );
        } finally {
          writeFileSync(file, original);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('does not approve a named transaction callback that also escapes or runs directly', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/unsafe.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { withDbTransaction } from '../db/transaction';
      export function unsafe(db, dispatch, runDirectly) {
        const write = () => writeRows(db);
        dispatch(write);
        if (runDirectly) write();
        return withDbTransaction(db, write);
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const helperCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(helperCall?.detectedContext, 'unresolved');
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-reference' &&
          finding.target.endsWith('src/services/unsafe.ts#unsafe.write'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on forwarded transaction callbacks and nested transaction entry', () => {
  const root = fixture({
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/services/wrappers.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function forward(db, task) {
        return withDbTransaction(db, task);
      }
      export function nested(db) {
        return withDbTransaction(db, () => withDbTransaction(db, () => undefined));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'dynamic-coordinator-callback' &&
          finding.symbol === 'forward' &&
          finding.detectedContext === 'unresolved',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/db/transaction.ts#withDbTransaction') &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes a closed-world wrapper that invokes its callback only inside a transaction', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function guarded(db, context, task) {
        return withDbTransaction(db, async () => {
          if (!context.isCurrent()) return null;
          const result = await task();
          if (!context.isCurrent()) throw new Error('stale');
          return result;
        });
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { guarded } from './wrapper';
      export function consume(db) {
        return guarded(db, { isCurrent: () => true }, async () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/wrapper.ts#guarded') &&
          finding.detectedContext === 'transaction-coordinator',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/db/repositories/writer.ts#writeRows') &&
          finding.detectedContext === 'withDbTransaction',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes a const-bound wrapper that directly returns its callback lifetime', () => {
  for (const declaration of [
    `export const guarded = (db, task) => withDbTransaction(db, () => task());`,
    `export const guarded = function guarded(db, task) {
      return withDbTransaction(db, function () { return task(); });
    };`,
  ]) {
    const root = fixture({
      'src/db/schema.ts': `export const messages = {};`,
      'src/db/transaction.ts': `
        export function withDbTransaction(db, callback) { return callback(db); }
      `,
      'src/db/repositories/writer.ts': `
        import { messages } from '../schema';
        export function writeRows(db) { return db.delete(messages); }
      `,
      'src/services/wrapper.ts': `
        import { withDbTransaction } from '../db/transaction';
        ${declaration}
      `,
      'src/services/consumer.ts': `
        import { writeRows } from '../db/repositories/writer';
        import { guarded } from './wrapper';
        export function consume(db) { return guarded(db, () => writeRows(db)); }
      `,
    });
    try {
      const findings = scanDbWrites({ root });
      assert.ok(
        findings.some(
          (finding) =>
            finding.target.endsWith('src/services/wrapper.ts#guarded') &&
            finding.detectedContext === 'transaction-coordinator',
        ),
      );
      assert.ok(
        findings.some(
          (finding) =>
            finding.target.endsWith('src/db/repositories/writer.ts#writeRows') &&
            finding.detectedContext === 'withDbTransaction',
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects a wrapper that starts but does not adopt an async callback lifetime', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export async function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function unsafe(db, task) {
        return withDbTransaction(db, async () => { task(); });
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { unsafe } from './wrapper';
      export function consume(db) {
        return unsafe(db, async () => {
          await Promise.resolve();
          return writeRows(db);
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const wrapperCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/services/wrapper.ts#unsafe'),
    );
    assert.equal(wrapperCall?.detectedContext, 'unresolved');
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects return adoption that an enclosing finally block can override', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export async function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function unsafe(db, task) {
        return withDbTransaction(db, async () => {
          try {
            return task();
          } finally {
            return null;
          }
        });
      }
      export function safe(db, task) {
        return withDbTransaction(db, async () => {
          try {
            return await task();
          } finally {
            return null;
          }
        });
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { safe, unsafe } from './wrapper';
      export function consume(db) {
        return unsafe(db, async () => {
          await Promise.resolve();
          return writeRows(db);
        });
      }
      export function consumeSafe(db) {
        return safe(db, async () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const wrapperCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/services/wrapper.ts#unsafe'),
    );
    assert.equal(wrapperCall?.detectedContext, 'unresolved');
    const safeWrapperCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/services/wrapper.ts#safe'),
    );
    assert.equal(safeWrapperCall?.detectedContext, 'transaction-coordinator');
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects arguments leaks and unsafe coordinator callback function shapes', () => {
  const wrapperBodies = [
    `
      const forwardedArguments = arguments;
      leak(forwardedArguments);
      return withDbTransaction(db, async () => await task());
    `,
    `
      return withDbTransaction(db, async function body() {
        leak(body);
        return await task();
      });
    `,
    `
      return withDbTransaction(db, async function* () {
        await task();
      });
    `,
  ];

  for (const wrapperBody of wrapperBodies) {
    const root = fixture({
      'src/db/schema.ts': `export const messages = {};`,
      'src/db/transaction.ts': `
        export function withDbTransaction(db, callback) { return callback(db); }
      `,
      'src/db/repositories/writer.ts': `
        import { messages } from '../schema';
        export function writeRows(db) { return db.delete(messages); }
      `,
      'src/services/wrapper.ts': `
        import { withDbTransaction } from '../db/transaction';
        export function unsafe(db, task, leak) { ${wrapperBody} }
      `,
      'src/services/consumer.ts': `
        import { writeRows } from '../db/repositories/writer';
        import { unsafe } from './wrapper';
        export function consume(db) {
          return unsafe(db, () => writeRows(db), () => undefined);
        }
      `,
    });
    try {
      const findings = scanDbWrites({ root });
      const wrapperCall = findings.find(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/wrapper.ts#unsafe'),
      );
      assert.equal(wrapperCall?.detectedContext, 'unresolved');
      const writerCall = findings.find(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
      );
      assert.equal(writerCall?.detectedContext, 'unresolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects an overridable class method as a coordinator wrapper', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { withDbTransaction } from '../db/transaction';
      export class Guard {
        guarded(db, task) {
          return withDbTransaction(db, async () => await task());
        }
      }
      export class ReplaceableGuard extends Guard {
        override guarded(_db, task) { task(); }
      }
      export function consume(db, guard: Guard) {
        return guard.guarded(db, async () => {
          await Promise.resolve();
          return writeRows(db);
        });
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const wrapperCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/services/consumer.ts#Guard.guarded'),
    );
    assert.equal(wrapperCall?.detectedContext, 'unresolved');
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a wrapper whose callback runs directly, escapes, or crosses another callback', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/unsafe-wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function unsafe(db, dispatch, task) {
        task();
        dispatch(task);
        return withDbTransaction(db, () => setTimeout(() => task(), 0));
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { unsafe } from './unsafe-wrapper';
      export function consume(db, dispatch) {
        return unsafe(db, dispatch, () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a wrapper when the coordinator callback itself can escape', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/unsafe-wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function unsafe(db, dispatch, task) {
        const body = () => task();
        dispatch(body);
        return withDbTransaction(db, body);
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { unsafe } from './unsafe-wrapper';
      export function consume(db, dispatch) {
        return unsafe(db, dispatch, () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects wrapper inference when any callback argument cannot be resolved statically', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function guarded(db, task) {
        return withDbTransaction(db, async () => task());
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { guarded } from './wrapper';
      export function safeLooking(db) { return guarded(db, () => writeRows(db)); }
      export function dynamic(db, chooseTask) { return guarded(db, chooseTask()); }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
    assert.ok(
      !findings.some(
        (finding) =>
          finding.target.endsWith('src/services/wrapper.ts#guarded') &&
          finding.detectedContext === 'transaction-coordinator',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts function declarations and const-only callback aliases for inferred wrappers', () => {
  for (const callbackSetup of [
    `
      function task() { return writeRows(db); }
      return guarded(db, task);
    `,
    `
      const task = () => writeRows(db);
      const alias = task;
      return guarded(db, alias);
    `,
  ]) {
    const root = fixture({
      'src/db/schema.ts': `export const messages = {};`,
      'src/db/transaction.ts': `
        export function withDbTransaction(db, callback) { return callback(db); }
      `,
      'src/db/repositories/writer.ts': `
        import { messages } from '../schema';
        export function writeRows(db) { return db.delete(messages); }
      `,
      'src/services/wrapper.ts': `
        import { withDbTransaction } from '../db/transaction';
        export function guarded(db, task) {
          return withDbTransaction(db, async () => task());
        }
      `,
      'src/services/consumer.ts': `
        import { writeRows } from '../db/repositories/writer';
        import { guarded } from './wrapper';
        export function consume(db) { ${callbackSetup} }
      `,
    });
    try {
      const findings = scanDbWrites({ root });
      assert.ok(
        findings.some(
          (finding) =>
            finding.target.endsWith('src/services/wrapper.ts#guarded') &&
            finding.detectedContext === 'transaction-coordinator',
        ),
      );
      assert.ok(
        findings.some(
          (finding) =>
            finding.target.endsWith('src/db/repositories/writer.ts#writeRows') &&
            finding.detectedContext === 'withDbTransaction',
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects mutable, reassigned, and property callback arguments for inferred wrappers', () => {
  const cases = [
    {
      name: 'reassigned let callback',
      callbackSetup: `
        let task = () => writeRows(db);
        task = () => withDbTransaction(db, () => writeRows(db));
        return guarded(db, task);
      `,
    },
    {
      name: 'var callback',
      callbackSetup: `
        var task = () => writeRows(db);
        return guarded(db, task);
      `,
    },
    {
      name: 'reassigned function declaration',
      callbackSetup: `
        function task() { return writeRows(db); }
        task = () => withDbTransaction(db, () => writeRows(db));
        return guarded(db, task);
      `,
    },
    {
      name: 'mutable object property',
      callbackSetup: `
        const holder = { task: () => writeRows(db) };
        return guarded(db, holder.task);
      `,
    },
    {
      name: 'escaped const callback',
      callbackSetup: `
        const task = () => writeRows(db);
        dispatch(task);
        return guarded(db, task);
      `,
    },
    {
      name: 'escaped forward const alias',
      callbackSetup: `
        const task = () => writeRows(db);
        const escaped = task;
        dispatch(escaped);
        return guarded(db, task);
      `,
    },
    {
      name: 'directly invoked function declaration',
      callbackSetup: `
        function task() { return writeRows(db); }
        task();
        return guarded(db, task);
      `,
    },
  ];

  for (const { name, callbackSetup } of cases) {
    const root = fixture({
      'src/db/schema.ts': `export const messages = {};`,
      'src/db/transaction.ts': `
        export function withDbTransaction(db, callback) { return callback(db); }
      `,
      'src/db/repositories/writer.ts': `
        import { messages } from '../schema';
        export function writeRows(db) { return db.delete(messages); }
      `,
      'src/services/wrapper.ts': `
        import { withDbTransaction } from '../db/transaction';
        export function guarded(db, task) {
          return withDbTransaction(db, async () => task());
        }
      `,
      'src/services/consumer.ts': `
        import { writeRows } from '../db/repositories/writer';
        import { withDbTransaction } from '../db/transaction';
        import { guarded } from './wrapper';
        export function consume(db, dispatch) { ${callbackSetup} }
      `,
    });
    try {
      const findings = scanDbWrites({ root });
      const wrapperCall = findings.find(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/wrapper.ts#guarded'),
      );
      assert.equal(wrapperCall?.detectedContext, 'unresolved', name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects wrapper inference when the wrapper itself escapes', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function guarded(db, task) {
        return withDbTransaction(db, async () => task());
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { guarded } from './wrapper';
      export function consume(db, dispatch) {
        dispatch(guarded);
        return guarded(db, () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-reference' &&
          finding.target.endsWith('src/services/wrapper.ts#guarded'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects wrapper inference through computed namespace dispatch', () => {
  for (const computedCall of [
    'Wrappers[name](db, () => writeRows(db))',
    "Wrappers['guarded'](db, () => writeRows(db))",
  ]) {
    const root = fixture({
      'src/db/schema.ts': `export const messages = {};`,
      'src/db/transaction.ts': `
        export function withDbTransaction(db, callback) { return callback(db); }
      `,
      'src/db/repositories/writer.ts': `
        import { messages } from '../schema';
        export function writeRows(db) { return db.delete(messages); }
      `,
      'src/services/wrapper.ts': `
        import { withDbTransaction } from '../db/transaction';
        export function guarded(db, task) {
          return withDbTransaction(db, async () => task());
        }
      `,
      'src/services/consumer.ts': `
        import { writeRows } from '../db/repositories/writer';
        import { guarded } from './wrapper';
        import * as Wrappers from './wrapper';
        export function safeLooking(db) { return guarded(db, () => writeRows(db)); }
        export function computed(db, name) { return ${computedCall}; }
      `,
    });
    try {
      const findings = scanDbWrites({ root });
      const writerCalls = findings.filter(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
      );
      assert.ok(writerCalls.length > 0);
      assert.ok(writerCalls.every((finding) => finding.detectedContext === 'unresolved'));
      assert.ok(
        !findings.some(
          (finding) =>
            finding.target.endsWith('src/services/wrapper.ts#guarded') &&
            finding.detectedContext === 'transaction-coordinator',
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects wrapper inference when a spread makes callback position ambiguous', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function guarded(db, task) {
        return withDbTransaction(db, async () => task());
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { guarded } from './wrapper';
      export function consume(db, prefix) {
        return guarded(...prefix, () => writeRows(db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerCall = findings.find(
      (finding) =>
        finding.operation === 'mutator-call' &&
        finding.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.equal(writerCall?.detectedContext, 'unresolved');
    assert.ok(
      !findings.some(
        (finding) =>
          finding.target.endsWith('src/services/wrapper.ts#guarded') &&
          finding.detectedContext === 'transaction-coordinator',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flags a forwarded callback that opens another transaction as nested', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/wrapper.ts': `
      import { withDbTransaction } from '../db/transaction';
      export function guarded(db, task) {
        return withDbTransaction(db, async () => task());
      }
    `,
    'src/services/consumer.ts': `
      import { writeRows } from '../db/repositories/writer';
      import { withDbTransaction } from '../db/transaction';
      import { guarded } from './wrapper';
      export function consume(db) {
        return guarded(db, () => withDbTransaction(db, () => writeRows(db)));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.includes('src/services/consumer.ts#consume.<callback:') &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a transaction calls a helper that transitively opens the coordinator', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/transaction.ts': `
      export function withDbTransaction(db, callback) { return callback(db); }
    `,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      import { withDbTransaction } from '../transaction';
      export function serializedWrite(db) {
        return withDbTransaction(db, () => db.delete(messages));
      }
    `,
    'src/services/wrappers.ts': `
      import { serializedWrite } from '../db/repositories/writer';
      import * as Writers from '../db/repositories/writer';
      import { withDbTransaction } from '../db/transaction';
      export function forwardedWrite(db) { return serializedWrite(db); }
      export function mixedCallback(db) {
        return withDbTransaction(db, () => serializedWrite(db));
      }
      export function nested(db) {
        return withDbTransaction(db, () => forwardedWrite(db));
      }
      export function nestedNamed(db) {
        mixedCallback(db);
        return withDbTransaction(db, mixedCallback);
      }
      export function nestedDynamic(db, name) {
        return withDbTransaction(db, () => Writers[name](db));
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/wrappers.ts#forwardedWrite') &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'dynamic-mutator-call' &&
          finding.target === '<dynamic:src/db/repositories/writer.ts>' &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/wrappers.ts#mixedCallback') &&
          finding.detectedContext === 'nested-coordinator',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracks call/apply and immutable aliases while rejecting binds, escapes, and dynamic dispatch', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/db/repositories/index.ts': `export * from './writer';`,
    'src/services/indirect.ts': `
      import * as Writers from '../db/repositories';
      export function indirect(db, dispatch, method) {
        Writers.writeRows.call(null, db);
        Writers.writeRows.apply(null, [db]);
        const immutableAlias = Writers.writeRows;
        immutableAlias(db);
        Writers['writeRows'](db);
        const { writeRows: extractedWriter } = Writers;
        extractedWriter(db);
        Writers.writeRows.bind(null, db);
        dispatch(Writers.writeRows);
        let mutableAlias = Writers.writeRows;
        mutableAlias(db);
        Writers[method](db);
      }
    `,
  });
  try {
    const findings = scanDbWrites({ root });
    const writerTarget = 'src/db/repositories/writer.ts#writeRows';
    assert.equal(
      findings.filter(
        (finding) => finding.operation === 'mutator-call' && finding.target.endsWith(writerTarget),
      ).length,
      4,
    );
    assert.ok(
      findings.filter(
        (finding) =>
          finding.operation === 'mutator-reference' && finding.target.endsWith(writerTarget),
      ).length >= 4,
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'dynamic-mutator-call' &&
          finding.target === '<dynamic:src/db/repositories/index.ts>',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newly introduced call to an inventoried writer fails exact membership', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
  });
  try {
    const inventory = createInventorySkeleton(scanDbWrites({ root }));
    const consumer = resolve(root, 'src/ui/new-consumer.ts');
    mkdirSync(resolve(consumer, '..'), { recursive: true });
    writeFileSync(
      consumer,
      `
        import { writeRows } from '../db/repositories/writer';
        export function newlyUnsafe(db) { return writeRows(db); }
      `,
    );
    const errors = validateDbWriteInventory({
      findings: scanDbWrites({ root }),
      inventory,
      requireApproved: false,
    });
    assert.ok(
      errors.some(
        (error) => error.includes('unapproved database write') && error.includes('mutator-call'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps same-named local callbacks separate by declaration identity', () => {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/locals.ts': `import { writeRows } from '../db/repositories/writer';
      export function mutating(db) { const write = () => writeRows(db); return write(); } export function readOnly(log) { const write = () => log('read only'); return write(); }`,
  });
  try {
    const findings = scanDbWrites({ root });
    assert.ok(
      findings.some(
        (finding) =>
          finding.operation === 'mutator-call' &&
          finding.target.endsWith('src/services/locals.ts#mutating.write'),
      ),
    );
    assert.ok(
      !findings.some(
        (finding) =>
          finding.operation.startsWith('mutator-') &&
          (finding.symbol.startsWith('readOnly') ||
            finding.target.includes('src/services/locals.ts#readOnly')),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inventory ids stay stable across unrelated line movement', () => {
  const source = `
    import { messages } from '@db/schema';
    export function write(db) { return db.delete(messages); }
  `;
  const shifted = `\n\n${source}`;
  const original = scanDbWritesInSource(source, 'src/services/write.ts')[0];
  const moved = scanDbWritesInSource(shifted, 'src/services/write.ts')[0];
  assert.ok(original);
  assert.ok(moved);
  assert.equal(original.id, moved.id);
  assert.notEqual(original.line, moved.line);
});

test('an unreviewed skeleton reports owners, context, and dispositions as incomplete', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      export function write(db) { return db.delete(messages); }
    `,
    'src/services/write.ts',
  );
  const inventory = createInventorySkeleton(findings);
  assert.equal(validateDbWriteInventory({ findings, inventory, requireApproved: false }).length, 0);
  const errors = validateDbWriteInventory({ findings, inventory, requireApproved: true });
  assert.ok(errors.some((error) => error.includes('no named owner')));
  assert.ok(errors.some((error) => error.includes('no reviewed transaction context')));
  assert.ok(errors.some((error) => error.includes('unproven transaction disposition')));

  inventory.entries[0].owner = 'send service';
  inventory.entries[0].transactionContext = 'unresolved';
  inventory.entries[0].disposition = 'coordinated';
  inventory.entries[0].evidence = 'test/services/send.test.ts';
  assert.ok(
    validateDbWriteInventory({ findings, inventory }).some((error) =>
      error.includes('does not have a detected coordinator'),
    ),
  );

  const coordinatedFindings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      import { withDbTransaction } from '@db/transaction';
      export function write(db) {
        return withDbTransaction(db, () => db.delete(messages));
      }
    `,
    'src/services/write.ts',
  );
  const coordinated = createInventorySkeleton(coordinatedFindings);
  coordinated.entries[0].owner = 'write';
  coordinated.entries[0].transactionContext = 'withDbTransaction';
  coordinated.entries[0].disposition = 'coordinated';
  coordinated.entries[0].evidence = 'test/db/withDbTransaction.test.ts';
  assert.deepEqual(
    validateDbWriteInventory({ findings: coordinatedFindings, inventory: coordinated }),
    [],
  );
});

test('rejects stale, duplicate, and invalid inventory entries', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      export function write(db) { return db.delete(messages); }
    `,
    'src/services/write.ts',
  );
  const skeleton = createInventorySkeleton(findings);
  const entry = skeleton.entries[0];
  const errors = validateDbWriteInventory({
    findings,
    inventory: {
      version: 1,
      entries: [
        { ...entry, line: 999, disposition: 'invented' },
        { ...entry },
        { ...entry, id: 'stale-id' },
      ],
    },
    requireApproved: false,
  });
  assert.ok(errors.some((error) => error.includes('duplicate id')));
  assert.ok(errors.some((error) => error.includes('invalid disposition')));
  assert.ok(errors.some((error) => error.includes('stale line')));
  assert.ok(errors.some((error) => error.includes('stale inventory entry')));
});

function reviewedInventory(findings) {
  const inventory = createInventorySkeleton(findings);
  for (const entry of inventory.entries) {
    entry.owner = 'reviewed owner';
    entry.transactionContext = entry.detectedContext;
    entry.disposition = 'coordinated';
    entry.evidence = 'test/db/reviewed-owner.test.ts';
  }
  return inventory;
}

function callbackWriterFinding(siblingValue, writeArgument = 'db') {
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/db/repositories/writer.ts': `
      import { messages } from '../schema';
      export function writeRows(db) { return db.delete(messages); }
    `,
    'src/services/owner.ts': `
      import { withDbTransaction } from '../db/transaction';
      import { writeRows } from '../db/repositories/writer';
      export function ownWrite(db) {
        return withDbTransaction(db, async () => {
          const primaryDb = db;
          await writeRows(${writeArgument});
          return ${siblingValue};
        });
      }
    `,
    'src/db/transaction.ts': `
      export async function withDbTransaction(db, callback) { return callback(db); }
    `,
  });
  try {
    const finding = scanDbWrites({ root }).find((entry) =>
      entry.target.endsWith('src/db/repositories/writer.ts#writeRows'),
    );
    assert.ok(finding);
    return finding;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reconciles a same-id line shift without changing reviewed metadata or its input', () => {
  const source = `
    import { messages } from '@db/schema';
    import { withDbTransaction } from '@db/transaction';
    export function write(db) { return withDbTransaction(db, () => db.delete(messages)); }
  `;
  const original = scanDbWritesInSource(source, 'src/services/write.ts');
  const shifted = scanDbWritesInSource(`\n\n${source}`, 'src/services/write.ts');
  const inventory = reviewedInventory(original);
  const originalEntry = structuredClone(inventory.entries[0]);

  const result = reconcileDbWriteInventory({ findings: shifted, inventory });

  assert.deepEqual(result.lineShifts, [
    { id: originalEntry.id, from: originalEntry.line, to: shifted[0].line },
  ]);
  assert.deepEqual(result.rekeys, []);
  assert.deepEqual(result.additions, []);
  assert.deepEqual(inventory.entries[0], originalEntry);
  assert.deepEqual(result.inventory.entries[0], { ...originalEntry, line: shifted[0].line });
});

test('preserves reviewed metadata across one unique callback-fingerprint rekey', () => {
  const original = callbackWriterFinding(1);
  const changedSibling = callbackWriterFinding(2);
  assert.notEqual(original.id, changedSibling.id);
  assert.equal(original.snippet, changedSibling.snippet);
  const inventory = reviewedInventory([original]);

  const result = reconcileDbWriteInventory({
    findings: [changedSibling],
    inventory,
  });

  assert.deepEqual(result.lineShifts, []);
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.rekeys, [
    { from: original.id, to: changedSibling.id, line: changedSibling.line },
  ]);
  assert.deepEqual(
    {
      owner: result.inventory.entries[0].owner,
      transactionContext: result.inventory.entries[0].transactionContext,
      disposition: result.inventory.entries[0].disposition,
      evidence: result.inventory.entries[0].evidence,
    },
    {
      owner: inventory.entries[0].owner,
      transactionContext: inventory.entries[0].transactionContext,
      disposition: inventory.entries[0].disposition,
      evidence: inventory.entries[0].evidence,
    },
  );
});

test('adds genuinely new findings as unproven skeletons and follows live order', () => {
  const findings = scanDbWritesInSource(
    `
      import { messages } from '@db/schema';
      export function first(db) { return db.delete(messages); }
      export function second(db) { return db.update(messages); }
    `,
    'src/services/writes.ts',
  );
  assert.equal(findings.length, 2);
  const inventory = reviewedInventory([findings[0]]);

  const result = reconcileDbWriteInventory({ findings, inventory });

  assert.deepEqual(
    result.inventory.entries.map((entry) => entry.id),
    findings.map((finding) => finding.id),
  );
  assert.deepEqual(result.additions, [{ id: findings[1].id, line: findings[1].line }]);
  assert.deepEqual(result.inventory.entries[1], createInventorySkeleton([findings[1]]).entries[0]);
  assert.equal(result.inventory.entries[0].disposition, 'coordinated');
});

test('rejects a same-shape rekey when the write expression changed or cannot be proved', () => {
  const original = scanDbWritesInSource(
    `
      import { sql } from 'drizzle-orm';
      export function write(db) { return db.run(sql\`DELETE FROM messages WHERE id = 1\`); }
    `,
    'src/services/write.ts',
  );
  const changed = scanDbWritesInSource(
    `
      import { sql } from 'drizzle-orm';
      export function write(db) { return db.run(sql\`DELETE FROM messages WHERE id = 2\`); }
    `,
    'src/services/write.ts',
  );
  assert.equal(original.length, 1);
  assert.equal(changed.length, 1);
  assert.throws(
    () => reconcileDbWriteInventory({ findings: changed, inventory: reviewedInventory(original) }),
    /unsafe rekey changed the write expression/,
  );

  const oldCallback = callbackWriterFinding(1);
  const newCallback = callbackWriterFinding(2);
  const withoutSnippet = { ...newCallback };
  delete withoutSnippet.snippet;
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings: [withoutSnippet],
        inventory: reviewedInventory([oldCallback]),
      }),
    /unsafe rekey has no live snippet/,
  );
});

test('rejects a callback-fingerprint rekey when the mutator-call snippet also changed', () => {
  const original = callbackWriterFinding(1, 'db');
  const changedCallbackAndCall = callbackWriterFinding(2, 'primaryDb');
  assert.notEqual(original.symbol, changedCallbackAndCall.symbol);
  assert.equal(original.target, changedCallbackAndCall.target);
  assert.notEqual(original.snippet, changedCallbackAndCall.snippet);

  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings: [changedCallbackAndCall],
        inventory: reviewedInventory([original]),
      }),
    /unsafe rekey could not prove an unchanged snippet/,
  );
});

test('rejects non-line drift for an unchanged id', () => {
  const findings = scanDbWritesInSource(
    `import { messages } from '@db/schema'; export function write(db) { return db.delete(messages); }`,
    'src/services/write.ts',
  );
  const changedContext = [{ ...findings[0], detectedContext: 'withDbTransaction' }];
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings: changedContext,
        inventory: reviewedInventory(findings),
      }),
    /non-line drift in detectedContext/,
  );
});

test('rejects a stale inventory entry instead of deleting reviewed metadata', () => {
  const findings = scanDbWritesInSource(
    `import { messages } from '@db/schema'; export function write(db) { return db.delete(messages); }`,
    'src/services/write.ts',
  );
  assert.throws(
    () => reconcileDbWriteInventory({ findings: [], inventory: reviewedInventory(findings) }),
    /stale inventory entry has no live finding/,
  );
});

test('rejects one-to-many reconciliation around an existing finding', () => {
  const findings = scanDbWritesInSource(
    `import { messages } from '@db/schema'; export function write(db) { return db.delete(messages); }`,
    'src/services/write.ts',
  );
  const duplicate = { ...findings[0], id: `${findings[0].id}:2`, line: findings[0].line + 1 };
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings: [findings[0], duplicate],
        inventory: reviewedInventory(findings),
      }),
    /ambiguous reconciliation cardinality/,
  );
});

test('rejects a many-to-many callback rekey', () => {
  const original = callbackWriterFinding(1);
  const changed = callbackWriterFinding(2);
  const originalDuplicate = { ...original, id: `${original.id}:2`, line: original.line + 1 };
  const changedDuplicate = { ...changed, id: `${changed.id}:2`, line: changed.line + 1 };
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings: [changed, changedDuplicate],
        inventory: reviewedInventory([original, originalDuplicate]),
      }),
    /ambiguous many-to-many rekey/,
  );
});

test('rejects duplicate or invalid inventory entries before reconciliation', () => {
  const findings = scanDbWritesInSource(
    `import { messages } from '@db/schema'; export function write(db) { return db.delete(messages); }`,
    'src/services/write.ts',
  );
  const inventory = reviewedInventory(findings);
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings,
        inventory: { ...inventory, entries: [inventory.entries[0], inventory.entries[0]] },
      }),
    /inventory contains duplicate id/,
  );
  assert.throws(
    () =>
      reconcileDbWriteInventory({
        findings,
        inventory: {
          ...inventory,
          entries: [{ ...inventory.entries[0], disposition: 'automatically-approved' }],
        },
      }),
    /invalid disposition/,
  );
});

test('parses only the documented reconciliation CLI combinations', () => {
  assert.deepEqual(parseDbWriteCliArgs([]), { mode: 'report', write: false });
  assert.deepEqual(parseDbWriteCliArgs(['--report']), { mode: 'report', write: false });
  assert.deepEqual(parseDbWriteCliArgs(['--reconcile']), {
    mode: 'reconcile',
    write: false,
  });
  assert.deepEqual(parseDbWriteCliArgs(['--reconcile', '--write']), {
    mode: 'reconcile',
    write: true,
  });
  assert.throws(() => parseDbWriteCliArgs(['--write']), /requires --reconcile/);
  assert.throws(() => parseDbWriteCliArgs(['--check', '--reconcile']), /conflicting modes/);
  assert.throws(() => parseDbWriteCliArgs(['--reconcile', '--reconcile']), /duplicate argument/);
  assert.throws(() => parseDbWriteCliArgs(['--unknown']), /unknown argument/);
});

test('atomically replaces an explicitly written inventory and cleans temporary files', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gator-db-write-inventory-'));
  const inventoryPath = resolve(root, 'db-write-inventory.json');
  try {
    writeFileSync(inventoryPath, 'old bytes\n');
    writeDbWriteInventoryAtomically(inventoryPath, { version: 1, entries: [] });

    assert.equal(
      readFileSync(inventoryPath, 'utf8'),
      `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
    );
    assert.deepEqual(readdirSync(root), ['db-write-inventory.json']);

    const blockedTarget = resolve(root, 'blocked-target');
    mkdirSync(blockedTarget);
    assert.throws(() =>
      writeDbWriteInventoryAtomically(blockedTarget, { version: 1, entries: [] }),
    );
    assert.deepEqual(
      readdirSync(root).filter((entry) => entry.includes('.tmp-')),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI dry-run is byte-immutable, explicit write applies, and a second write is a no-op', () => {
  const source = `
    import { messages } from '@db/schema';
    export function write(db) { return db.delete(messages); }
  `;
  const root = fixture({
    'src/db/schema.ts': `export const messages = {};`,
    'src/services/write.ts': source,
  });
  const inventoryPath = resolve(root, 'scripts/db-write-inventory.json');
  try {
    const originalFindings = scanDbWrites({ root });
    const inventory = reviewedInventory(originalFindings);
    mkdirSync(resolve(inventoryPath, '..'), { recursive: true });
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    writeFileSync(resolve(root, 'src/services/write.ts'), `\n\n${source}`);
    const beforeBytes = readFileSync(inventoryPath, 'utf8');

    const dryRun = spawnSync(process.execPath, [DB_WRITE_SCANNER_CLI, '--reconcile'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /1 line shifts; 0 rekeys; 0 additions/);
    assert.match(dryRun.stdout, /Dry run only/);
    assert.equal(readFileSync(inventoryPath, 'utf8'), beforeBytes);

    const liveFindings = scanDbWrites({ root });
    const expected = reconcileDbWriteInventory({ findings: liveFindings, inventory }).inventory;
    const writeRun = spawnSync(process.execPath, [DB_WRITE_SCANNER_CLI, '--reconcile', '--write'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(writeRun.status, 0, writeRun.stderr);
    assert.match(writeRun.stdout, /1 line shifts; 0 rekeys; 0 additions/);
    assert.match(writeRun.stdout, /updated atomically/);
    assert.equal(readFileSync(inventoryPath, 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);

    const inodeBeforeNoOp = statSync(inventoryPath).ino;
    const noOpWrite = spawnSync(
      process.execPath,
      [DB_WRITE_SCANNER_CLI, '--reconcile', '--write'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(noOpWrite.status, 0, noOpWrite.stderr);
    assert.match(noOpWrite.stdout, /0 line shifts; 0 rekeys; 0 additions/);
    assert.match(noOpWrite.stdout, /already current; no file was written/);
    assert.equal(statSync(inventoryPath).ino, inodeBeforeNoOp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
