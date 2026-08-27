import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import {
  ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE,
  ALLOWED_NATIVE_LOG_MESSAGES,
  EXPECTED_ERROR_DIAGNOSTIC_SITES,
  EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE,
  findDiagnosticSiteDefinitions,
  findExactProjectorMessages,
  findProjectorSitePairs,
  findUnsafeNativeLogCalls,
  findUnstructuredErrorCalls,
  runErrorDiagnosticCheck,
} from './check-error-diagnostics.mjs';

const root = resolve(import.meta.dirname, '..');
const ownedNativeFile = join(
  root,
  'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput/GatorPasteInputModule.kt',
);
const ownedNativeSource = readFileSync(ownedNativeFile, 'utf8');

function writeFixtureFile(fixtureRoot, relativePath, source) {
  const path = join(fixtureRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function initializeGuardFixture(fixtureRoot) {
  const projectorDefinitions = [...EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE]
    .map(
      ([message, sites]) =>
        `{ siteTokens: [${sites.map((site) => `ERROR_DIAGNOSTIC_SITES.${site}`).join(', ')}], matches: exact(${JSON.stringify(message)}) }`,
    )
    .join(',\n');
  writeFixtureFile(
    fixtureRoot,
    'src/core/secure/errorDiagnostic.ts',
    [
      `export const ERROR_DIAGNOSTIC_SITES = ${JSON.stringify(EXPECTED_ERROR_DIAGNOSTIC_SITES)} as const;`,
      'const exact = (message) => message;',
      `const EVENT_DEFINITIONS = [${projectorDefinitions}] as const;`,
    ].join('\n'),
  );
  writeFixtureFile(
    fixtureRoot,
    'src/fixture.ts',
    [...ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE]
      .flatMap(([message, sites]) =>
        sites.map(
          (site) =>
            `logger.error(${JSON.stringify(message)}, ${JSON.stringify(EXPECTED_ERROR_DIAGNOSTIC_SITES[site])}, new Error('private'));`,
        ),
      )
      .join('\n'),
  );
  mkdirSync(join(fixtureRoot, 'app'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'modules'), { recursive: true });
}

function topLevelFunctionText(source, fileName, name) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(
    declarations.length,
    1,
    `${name} must have one top-level declaration in the fixture`,
  );
  return declarations[0].getText(sourceFile);
}

function topLevelConsoleWriteText(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const owners = sourceFile.statements.filter(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'ConsoleSink',
  );
  assert.equal(owners.length, 1, 'ConsoleSink must have one top-level declaration in the fixture');
  const methods = owners[0].members.filter(
    (member) => ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === 'write',
  );
  assert.equal(methods.length, 1, 'ConsoleSink.write must have one declaration in the fixture');
  return methods[0].getText(sourceFile);
}

test('accepts every finite production event message as a string literal', () => {
  const source = [...ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE]
    .flatMap(([message, sites]) =>
      sites.map(
        (site) =>
          `logger.error(${JSON.stringify(message)}, ${JSON.stringify(EXPECTED_ERROR_DIAGNOSTIC_SITES[site])}, new Error('private'));`,
      ),
    )
    .join('\n');
  assert.deepEqual(findUnstructuredErrorCalls(source), []);
});

test('rejects missing, dynamic, and cross-event crash-site evidence', () => {
  const source = [
    "logger.error('[socket] connection failed');",
    "logger.error('[socket] connection failed', dynamicSite);",
    `logger.error('[socket] connection failed', ${JSON.stringify(EXPECTED_ERROR_DIAGNOSTIC_SITES.mediaShare)});`,
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    ['missing crash site', 'dynamic crash site', 'event/site mismatch'],
  );
});

test('pins the exact unique registry and projector event/site pairs', () => {
  const source = readFileSync(join(root, 'src/core/secure/errorDiagnostic.ts'), 'utf8');
  assert.deepEqual(
    Object.fromEntries(findDiagnosticSiteDefinitions(source)),
    EXPECTED_ERROR_DIAGNOSTIC_SITES,
  );
  assert.deepEqual(findProjectorSitePairs(source), EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE);
  assert.equal(
    new Set(Object.values(EXPECTED_ERROR_DIAGNOSTIC_SITES)).size,
    Object.keys(EXPECTED_ERROR_DIAGNOSTIC_SITES).length,
  );

  const spreadRegistry = source.replace(
    'export const ERROR_DIAGNOSTIC_SITES = {',
    'export const ERROR_DIAGNOSTIC_SITES = { ...dynamicSites,',
  );
  assert.notEqual(spreadRegistry, source);
  assert.notDeepEqual(
    Object.fromEntries(findDiagnosticSiteDefinitions(spreadRegistry)),
    EXPECTED_ERROR_DIAGNOSTIC_SITES,
  );

  const dynamicProjectorSite = source.replace(
    'siteTokens: [ERROR_DIAGNOSTIC_SITES.socketConnection],',
    'siteTokens: [ERROR_DIAGNOSTIC_SITES.socketConnection, dynamicSite],',
  );
  assert.notEqual(dynamicProjectorSite, source);
  assert.notDeepEqual(
    findProjectorSitePairs(dynamicProjectorSite),
    EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE,
  );

  const spreadProjectorDefinition = source.replace(
    'siteTokens: [ERROR_DIAGNOSTIC_SITES.socketConnection],',
    'siteTokens: [ERROR_DIAGNOSTIC_SITES.socketConnection], ...dynamicDefinition,',
  );
  assert.notEqual(spreadProjectorDefinition, source);
  assert.notDeepEqual(
    findProjectorSitePairs(spreadProjectorDefinition),
    EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE,
  );
});

test('rejects interpolated, variable, concatenated, and unknown messages', () => {
  const source = [
    'logger.error(`[socket] failed for ${privateValue}`);',
    'logger.error(message, error);',
    "logger.error('[db] ' + privateValue);",
    "logger.error('[new-event] arbitrary prose');",
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    ['dynamic message', 'dynamic message', 'dynamic message', 'unknown event'],
  );
});

test('resolves imported aliases, bracket access, and destructured logger.error', () => {
  const source = [
    "import { logger as appLogger } from '@core/secure';",
    'const alias = appLogger;',
    'const { error: reportError } = alias;',
    'appLogger.error(privateValue);',
    "alias['error'](privateValue);",
    'reportError(privateValue);',
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    ['logger.error reference', 'dynamic message', 'dynamic message', 'dynamic message'],
  );
});

test('resolves secure namespace, property-function, and assignment aliases', () => {
  const source = [
    "import * as secure from '@core/secure';",
    'const report = secure.logger.error;',
    'let loggerAlias;',
    'loggerAlias = secure.logger;',
    'let assignedReport;',
    'assignedReport = loggerAlias["error"];',
    'secure.logger.error(privateValue);',
    'report(privateValue);',
    'loggerAlias.error(privateValue);',
    'assignedReport(privateValue);',
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    [
      'logger.error reference',
      'logger.error reference',
      'dynamic message',
      'dynamic message',
      'dynamic message',
      'dynamic message',
    ],
  );
});

test('rejects direct writes at every level to known LogSink singletons and their aliases', () => {
  const source = [
    "import { logSinks as tee, memoryLogSink } from '@core/secure';",
    "import * as secure from '@core/secure';",
    "import { fileLogSink as disk } from '@/services/logging/fileLogSink';",
    'const sinkAlias = tee;',
    'const { write: directWrite } = sinkAlias;',
    'let assignedSink;',
    'assignedSink = secure.logSinks;',
    'const namespaceWrite = secure.memoryLogSink.write;',
    "tee.write('error', privateValue, privateMeta);",
    "memoryLogSink['write']('warn', privateValue);",
    "disk.write('info', privateValue);",
    "directWrite('debug', privateValue);",
    "secure.logSinks.write('warn', privateValue);",
    "assignedSink['write'](dynamicLevel, privateValue);",
    "namespaceWrite('info', privateValue);",
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    [
      'log sink write reference',
      'log sink write reference',
      'direct log sink write',
      'direct log sink write',
      'direct log sink write',
      'direct log sink write',
      'direct log sink write',
      'direct log sink write',
      'direct log sink write',
    ],
  );
});

test('rejects raw console calls, destructuring, and aliases outside the owned sink', () => {
  const source = [
    "console.warn('private');",
    'const localConsole = console;',
    'const { error: rawError } = localConsole;',
    'const rawInfo = console.info;',
    "localConsole.log('private');",
    "rawError('private');",
    "rawInfo('private');",
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    [
      'raw console call',
      'raw console function reference',
      'raw console function reference',
      'raw console call',
      'raw console call',
      'raw console call',
    ],
  );
});

test('rejects call/apply/bind indirection around logger, sink, and console functions', () => {
  const source = [
    "logSinks.write.call(logSinks, 'warn', privateValue);",
    'const boundWrite = logSinks.write.bind(logSinks);',
    "logger.error.apply(logger, ['[socket] connection failed', privateMeta]);",
    "console.warn.call(console, 'private');",
  ].join('\n');
  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    [
      'indirect log sink write',
      'diagnostic object forwarding',
      'indirect log sink write',
      'diagnostic object forwarding',
      'indirect logger.error call',
      'diagnostic object forwarding',
      'indirect raw console call',
      'diagnostic object forwarding',
    ],
  );
});

test('allows only finite static native logcat events', () => {
  assert.deepEqual(findUnsafeNativeLogCalls(ownedNativeSource, ownedNativeFile), []);
  for (const message of ALLOWED_NATIVE_LOG_MESSAGES) {
    assert.ok(
      ownedNativeSource.includes(
        `android.util.Log.w("GatorPasteInput", ${JSON.stringify(message)})`,
      ),
      message,
    );
  }

  const unsafe = `${ownedNativeSource}\n${[
    'android.util.Log.w("GatorPasteInput", "attach failed: ${error.message}")',
    'android.util.Log.e("GatorPasteInput", "attach failed", error)',
    'android.util.Log.i("GatorPasteInput", dynamicMessage)',
    'android.util.Log.w("GatorPasteInput", "new unreviewed event")',
  ].join('\n')}`;
  const unsafeFindings = findUnsafeNativeLogCalls(unsafe, ownedNativeFile);
  assert.ok(
    unsafeFindings.some((finding) => finding.reason === 'owned native source contract changed'),
  );
  assert.deepEqual(
    unsafeFindings
      .map((finding) => finding.reason)
      .filter((reason) => reason === 'unapproved native Log call'),
    [
      'unapproved native Log call',
      'unapproved native Log call',
      'unapproved native Log call',
      'unapproved native Log call',
    ],
  );
  assert.equal(unsafeFindings.at(-1)?.message, 'new unreviewed event');
});

test('covers core barrels, global consoles, conditional aliases, and function forwarding', () => {
  const source = [
    "import { secure as namedSecure } from '@core';",
    "import * as core from '@core';",
    "const requiredSecure = require('@core/secure');",
    "const { secure: destructuredSecure } = require('@core');",
    'namedSecure.logger.error(privateValue);',
    'core.secure.logger.error(privateValue);',
    'requiredSecure.logger.error(privateValue);',
    'destructuredSecure.logger.error(privateValue);',
    "globalThis.console.error('private');",
    "window.console.trace('private');",
    "console['table'](privateValue);",
    "console.assert(false, 'private');",
    'consume(logger.error);',
    'Reflect.apply(logger.error, logger, [privateValue]);',
    'const forwarded = condition ? logger.error : console.warn;',
    'forwarded(privateValue);',
  ].join('\n');

  assert.deepEqual(
    findUnstructuredErrorCalls(source).map((finding) => finding.reason),
    [
      'dynamic message',
      'dynamic message',
      'dynamic message',
      'dynamic message',
      'raw console call',
      'raw console call',
      'raw console call',
      'raw console call',
      'logger.error reference',
      'diagnostic object forwarding',
      'logger.error reference',
      'logger.error reference',
      'raw console function reference',
      'raw console call',
    ],
  );
});

test('keeps the owned console exceptions structural and narrow', () => {
  const loggerFile = join(root, 'src/core/secure/logger.ts');
  const loggerSource = readFileSync(loggerFile, 'utf8');
  assert.deepEqual(findUnstructuredErrorCalls(loggerSource, loggerFile), []);
  assert.ok(
    findUnstructuredErrorCalls(
      loggerSource.replace('    const out =', '    safe.message = privateValue;\n    const out ='),
      loggerFile,
    ).some((finding) => finding.reason === 'owned console sink contract changed'),
  );
  assert.ok(
    findUnstructuredErrorCalls(
      loggerSource.replace(
        'const diagnostic = projectCapturedErrorDiagnostic(message, meta);',
        'const diagnostic = { message, meta } as const;',
      ),
      loggerFile,
    ).some((finding) => finding.reason === 'owned console sink contract changed'),
  );
  assert.ok(
    findUnstructuredErrorCalls(
      loggerSource.replace(
        '    if (safe.meta === undefined)',
        '    Reflect.apply(out, console, [privateValue]);\n    if (safe.meta === undefined)',
      ),
      loggerFile,
    ).some((finding) => finding.reason === 'owned console sink contract changed'),
  );
  assert.ok(
    findUnstructuredErrorCalls(`${loggerSource}\nconsole.trace(privateValue);`, loggerFile).some(
      (finding) => finding.reason === 'raw console call',
    ),
  );

  const boundaryFile = join(root, 'src/services/errors/reactNativeExceptionPrivacy.ts');
  const boundarySource = readFileSync(boundaryFile, 'utf8');
  assert.deepEqual(findUnstructuredErrorCalls(boundarySource, boundaryFile), []);
  assert.ok(
    findUnstructuredErrorCalls(
      `${boundarySource}\nruntimeConsole.error(privateValue);`,
      boundaryFile,
    ).some((finding) => finding.reason === 'raw console call'),
  );
  assert.ok(
    findUnstructuredErrorCalls(
      boundarySource.replace(
        'Reflect.apply(originalError, runtimeConsole, safe)',
        'Reflect.apply(originalError, runtimeConsole, values)',
      ),
      boundaryFile,
    ).some((finding) => finding.reason === 'React Native console privacy contract changed'),
  );
  assert.ok(
    findUnstructuredErrorCalls(
      boundarySource.replace(
        '    const first = values[0];',
        '    return values as never;\n    const first = values[0];',
      ),
      boundaryFile,
    ).some((finding) => finding.reason === 'React Native console privacy contract changed'),
  );
  for (const mutated of [
    boundarySource.replace("  'log',\n", ''),
    boundarySource.replace('  installReleaseConsoleBoundary(runtimeConsole);\n', ''),
    boundarySource.replace(
      '    manager.unstable_setExceptionDecorator(projectReactNativeExceptionData);\n',
      '',
    ),
    boundarySource.replace(
      '  const release = options.release ?? !isVerboseLocalLoggingEnabled();',
      '  const release = false;',
    ),
    boundarySource.replace(
      "require('react-native/Libraries/Core/ExceptionsManager')",
      "require('react-native/Libraries/Core/UnsafeExceptionsManager')",
    ),
  ]) {
    assert.notEqual(mutated, boundarySource, 'the RN activation mutation must change the fixture');
    assert.ok(
      findUnstructuredErrorCalls(mutated, boundaryFile).some(
        (finding) => finding.reason === 'React Native console privacy contract changed',
      ),
    );
  }
});

test('does not let nested or duplicate declarations satisfy an owned console contract', () => {
  const loggerFile = join(root, 'src/core/secure/logger.ts');
  const loggerSource = readFileSync(loggerFile, 'utf8');
  const capturedErrorSinkValue = topLevelFunctionText(
    loggerSource,
    loggerFile,
    'capturedErrorSinkValue',
  );
  const unsafeLogger = loggerSource.replace(
    'const diagnostic = projectCapturedErrorDiagnostic(message, meta);',
    'const diagnostic = { message, meta } as const;',
  );
  const loggerWithNestedDecoy = `${unsafeLogger}\nnamespace GuardDecoy {\n${capturedErrorSinkValue}\n}`;
  assert.ok(
    findUnstructuredErrorCalls(loggerWithNestedDecoy, loggerFile).some(
      (finding) => finding.reason === 'owned console sink contract changed',
    ),
  );

  const unsafeWrite = loggerSource.replace(
    '    if (safe.meta === undefined)',
    '    Reflect.apply(out, console, [privateValue]);\n    if (safe.meta === undefined)',
  );
  const consoleWrite = topLevelConsoleWriteText(loggerSource, loggerFile);
  const loggerWithMethodDecoy = `${unsafeWrite}\nnamespace GuardDecoy {\nexport class ConsoleSink implements LogSink {\n${consoleWrite}\n}\n}`;
  assert.ok(
    findUnstructuredErrorCalls(loggerWithMethodDecoy, loggerFile).some(
      (finding) => finding.reason === 'owned console sink contract changed',
    ),
  );
  assert.ok(
    findUnstructuredErrorCalls(`${loggerSource}\n${capturedErrorSinkValue}`, loggerFile).some(
      (finding) => finding.reason === 'owned console sink contract changed',
    ),
  );

  const boundaryFile = join(root, 'src/services/errors/reactNativeExceptionPrivacy.ts');
  const boundarySource = readFileSync(boundaryFile, 'utf8');
  const projectedConsoleArguments = topLevelFunctionText(
    boundarySource,
    boundaryFile,
    'projectedConsoleArguments',
  );
  const unsafeBoundary = boundarySource.replace(
    '    const first = values[0];',
    '    return values as never;\n    const first = values[0];',
  );
  const boundaryWithNestedDecoy = `${unsafeBoundary}\nnamespace GuardDecoy {\n${projectedConsoleArguments}\n}`;
  assert.ok(
    findUnstructuredErrorCalls(boundaryWithNestedDecoy, boundaryFile).some(
      (finding) => finding.reason === 'React Native console privacy contract changed',
    ),
  );
});

test('rejects global aliases, object forwarding, sequence calls, and cross-file re-exports', () => {
  const source = [
    "import { logger as indexedLogger } from '@core/secure/index';",
    "import * as loggerModule from '@core/secure/logger';",
    'const g = globalThis;',
    'const { console: aliasedConsole } = window;',
    'g.console.error(privateValue);',
    'aliasedConsole.warn(privateValue);',
    'indexedLogger.error(privateValue);',
    'loggerModule.logger.error(privateValue);',
    'function emit(value) { value.error(privateValue); }',
    'emit(logger);',
    '({ error: report } = logger);',
    '(0, logger).error(privateValue);',
    'const container = { logger };',
    'const returnLogger = () => logger;',
    'function defaultLogger(value = logger) { return value; }',
    'export const exportedLogger = logger;',
    'global.nativeLoggingHook(privateValue, 1);',
  ].join('\n');
  const reasons = findUnstructuredErrorCalls(source).map((finding) => finding.reason);

  assert.equal(reasons.filter((reason) => reason === 'raw console call').length, 3);
  assert.equal(reasons.filter((reason) => reason === 'dynamic message').length, 3);
  assert.equal(reasons.filter((reason) => reason === 'diagnostic object forwarding').length, 6);

  const reExports = [
    "export { logger as diagnostic } from '@core/secure';",
    "export * from '@core/secure/index';",
    "import { logger as appLogger } from '@core/secure';",
    'export { appLogger };',
  ].join('\n');
  assert.equal(
    findUnstructuredErrorCalls(reExports).filter(
      (finding) =>
        finding.reason === 'diagnostic re-export' ||
        finding.reason === 'diagnostic object forwarding',
    ).length,
    3,
  );
});

test('rejects dynamic secure imports and computed, copied, or rest-spread global output', () => {
  for (const source of [
    "import('@core/secure').then(({ logger: appLogger }) => appLogger.error(privateValue));",
    "(await import('@core')).secure.logger.error(privateValue);",
    "globalThis['con' + 'sole'].error(privateValue);",
    'const copiedGlobal = { ...globalThis }; copiedGlobal.console.error(privateValue);',
    'const { location, ...restGlobal } = window; restGlobal.console.warn(privateValue);',
  ]) {
    assert.notDeepEqual(findUnstructuredErrorCalls(source), [], source);
  }

  assert.ok(
    findUnstructuredErrorCalls("globalThis['con' + 'sole'].error(privateValue);").some(
      (finding) => finding.reason === 'dynamic diagnostic namespace member',
    ),
  );
  assert.ok(
    findUnstructuredErrorCalls(
      "import('@core/secure').then(({ logger: appLogger }) => appLogger.error(privateValue));",
    ).some((finding) => finding.reason === 'diagnostic object forwarding'),
  );

  const globalHandlerFile = join(root, 'src/services/errors/globalErrorHandlers.ts');
  assert.ok(
    findUnstructuredErrorCalls(
      [
        'const g = globalThis;',
        'function installErrorUtils(runtime) { runtime.console.error(privateValue); }',
        'installErrorUtils(g);',
      ].join('\n'),
      globalHandlerFile,
    ).some((finding) => finding.reason === 'diagnostic object forwarding'),
  );
});

test('rejects awaited forwarding, explicit-extension imports, and import-equals aliases', () => {
  const mutations = [
    ['consume(await console);', 'diagnostic object forwarding'],
    ['consume(await logger);', 'diagnostic object forwarding'],
    ['consume(await logSinks);', 'diagnostic object forwarding'],
    ['async function leak() { const raw = await console; raw.error(secret); }', 'raw console call'],
    [
      'async function leak() { const appLogger = await logger; appLogger.error(secret); }',
      'dynamic message',
    ],
    [
      'async function leak() { const sink = await logSinks; sink.write("error", secret); }',
      'direct log sink write',
    ],
    ['(await console).error(privateValue);', 'raw console call'],
    ['(await logger).error(privateValue);', 'dynamic message'],
    ["(await logSinks).write('error', privateValue);", 'direct log sink write'],
    [
      "import { logger as appLogger } from '@core/secure/index.ts';\nappLogger.error(privateValue);",
      'dynamic message',
    ],
    [
      "import * as secure from '../src/core/secure/logger.js';\nsecure.logger.error(privateValue);",
      'dynamic message',
    ],
    [
      "import { logger as appLogger } from '../core/secure/index.js';\nappLogger.error(secret);",
      'dynamic message',
    ],
    [
      "import secure = require('@core/secure/logger.ts');\nsecure.logger.error(privateValue);",
      'dynamic message',
    ],
    ["import secure = require('@core/secure');\nsecure.logger.error(secret);", 'dynamic message'],
    [
      "import core = require('@core/index.js');\ncore.secure.logger.error(privateValue);",
      'dynamic message',
    ],
    ["export * from '@core/secure/index.mjs';", 'diagnostic re-export'],
  ];

  for (const [source, expectedReason] of mutations) {
    assert.ok(
      findUnstructuredErrorCalls(source).some((finding) => finding.reason === expectedReason),
      source,
    );
  }
});

test('detects native aliases, static imports, alternate outputs, dynamic tags, and references', () => {
  const aliased = [
    'import android.util.Log as AndroidLog',
    'AndroidLog.e("PrivateTag", privateValue)',
  ].join('\n');
  assert.deepEqual(
    findUnsafeNativeLogCalls(aliased, 'Example.kt').map((finding) => finding.reason),
    ['aliased native Log import', 'unapproved native Log call'],
  );

  const alternate = [
    'import static android.util.Log.e;',
    'e("PrivateTag", privateValue);',
    'android.util.Log.println(priority, privateTag, privateValue);',
    'System.err.println(privateValue);',
    'println(privateValue)',
    'error.printStackTrace()',
    'handler = Throwable::printStackTrace',
  ].join('\n');
  const reasons = findUnsafeNativeLogCalls(alternate, 'Example.java').map(
    (finding) => finding.reason,
  );
  assert.ok(reasons.includes('unapproved native Log import'));
  assert.equal(reasons.filter((reason) => reason === 'unapproved native Log call').length, 2);
  assert.equal(reasons.filter((reason) => reason === 'raw native stdout/stderr call').length, 2);
  assert.equal(reasons.filter((reason) => reason === 'raw native stack output').length, 2);

  const dynamicTag = 'android.util.Log.w(userAddress, "attach failed")';
  assert.ok(
    findUnsafeNativeLogCalls(dynamicTag, ownedNativeFile).some(
      (finding) => finding.reason === 'unapproved native Log call',
    ),
  );
});

test('detects native typealiases, callable references, qualified output, and stream aliases', () => {
  const typealiasFindings = findUnsafeNativeLogCalls(
    [
      'typealias AndroidLog = android.util.Log',
      'fun leak() { AndroidLog.e("PrivateTag", privateValue) }',
    ].join('\n'),
    'Example.kt',
  );
  assert.ok(typealiasFindings.some((finding) => finding.reason === 'native Log typealias'));
  assert.ok(typealiasFindings.some((finding) => finding.reason === 'unapproved native Log call'));

  const referenceFindings = findUnsafeNativeLogCalls(
    ['import android.util.Log', 'val emit: (String, String) -> Int = Log::w'].join('\n'),
    ownedNativeFile,
  );
  assert.ok(referenceFindings.some((finding) => finding.reason === 'native Log method reference'));

  for (const source of [
    'fun leak() { kotlin.io.println(privateValue) }',
    ['import kotlin.io.print as emit', 'fun leak() { emit(privateValue) }'].join('\n'),
    'val emit: (Any?) -> Unit = ::println',
    'fun leak() { val output = System.out; output.printf(privateValue) }',
    [
      'typealias RuntimeSystem = java.lang.System',
      'fun leak() { RuntimeSystem.err.append(privateValue) }',
    ].join('\n'),
  ]) {
    assert.ok(
      findUnsafeNativeLogCalls(source, 'Example.kt').some(
        (finding) => finding.reason === 'raw native stdout/stderr call',
      ),
      source,
    );
  }
});

test('requires a fully qualified literal owned tag and rejects native Log imports', () => {
  const shadowedTag = [
    'import android.util.Log',
    'private const val TAG = "GatorPasteInput"',
    'fun leak(TAG: String) { Log.w(TAG, "attach failed") }',
  ].join('\n');
  assert.ok(
    findUnsafeNativeLogCalls(shadowedTag, ownedNativeFile).some(
      (finding) => finding.reason === 'unapproved native Log call',
    ),
  );

  const starImport = [
    'import android.util.Log.*',
    'fun leak() { w("GatorPasteInput", "attach failed") }',
  ].join('\n');
  const starReasons = findUnsafeNativeLogCalls(starImport, ownedNativeFile).map(
    (finding) => finding.reason,
  );
  assert.ok(starReasons.includes('unapproved native Log import'));
  assert.ok(starReasons.includes('unapproved native Log call'));

  const exactImportReasons = findUnsafeNativeLogCalls(
    ['import android.util.Log', 'Log.w("GatorPasteInput", "attach failed")'].join('\n'),
    ownedNativeFile,
  ).map((finding) => finding.reason);
  assert.ok(exactImportReasons.includes('unapproved native Log import'));
  assert.ok(exactImportReasons.includes('unapproved native Log call'));

  assert.ok(
    findUnsafeNativeLogCalls('import android.util.*', ownedNativeFile).some(
      (finding) => finding.reason === 'unapproved native Log import',
    ),
  );

  const packageStar = [
    'import android.util.*',
    'fun leak() { Log.e("PrivateTag", privateValue) }',
  ].join('\n');
  assert.ok(
    findUnsafeNativeLogCalls(packageStar, 'Example.kt').some(
      (finding) => finding.reason === 'unapproved native Log call',
    ),
  );
});

test('inspects executable Kotlin string templates without treating literal examples as code', () => {
  const templated = [
    'val first = "${run { android.util.Log.e("PrivateTag", privateValue) }}"',
    'val second = """${System.err.println(privateValue)}"""',
  ].join('\n');
  const reasons = findUnsafeNativeLogCalls(templated, 'Example.kt').map(
    (finding) => finding.reason,
  );
  assert.ok(reasons.includes('unapproved native Log call'));
  assert.ok(reasons.includes('raw native stdout/stderr call'));

  assert.ok(
    findUnsafeNativeLogCalls(
      'val third = "${`}`.also { System.out.print(privateValue) }}"',
      'Example.kt',
    ).some((finding) => finding.reason === 'raw native stdout/stderr call'),
  );

  assert.deepEqual(
    findUnsafeNativeLogCalls(
      'val literal = "\\${android.util.Log.e(PrivateTag, privateValue)}"',
      'Example.kt',
    ),
    [],
  );
});

test('native tokenization ignores comments, string examples, and unrelated Log classes', () => {
  const source = [
    '// android.util.Log.e(TAG, privateValue)',
    'val example = "Log.e(TAG, privateValue)"',
    '/* System.err.println(privateValue) */',
    'class Log { fun e(tag: String, message: String) = Unit }',
    'Log().e("custom", "not Android logcat")',
  ].join('\n');
  assert.deepEqual(findUnsafeNativeLogCalls(source, 'Example.kt'), []);

  const languageSpecificComment = [
    '/* outer comment',
    '   /* inner comment */',
    '   android.util.Log.e(TAG, privateValue);',
    '   System.err.println(privateValue);',
    '// */',
  ].join('\n');
  assert.deepEqual(findUnsafeNativeLogCalls(languageSpecificComment, 'Example.kt'), []);
  const javaReasons = findUnsafeNativeLogCalls(languageSpecificComment, 'Example.java').map(
    (finding) => finding.reason,
  );
  assert.ok(javaReasons.includes('unapproved native Log call'));
  assert.ok(javaReasons.includes('raw native stdout/stderr call'));
});

test('rejects backticked Kotlin output and Java Unicode escapes before lexical filtering', () => {
  const kotlinMutations = [
    [
      ['import android.util.Log', 'Log.`e`("PrivateTag", privateValue)'].join('\n'),
      'unapproved native Log call',
    ],
    ['fun leak() { android.util.`Log`.e("PrivateTag", secret) }', 'unapproved native Log call'],
    ['fun leak() { kotlin.io.`println`(secret) }', 'raw native stdout/stderr call'],
    ['System.err.`println`(privateValue)', 'raw native stdout/stderr call'],
    ['`println`(privateValue)', 'raw native stdout/stderr call'],
  ];
  for (const [source, expectedReason] of kotlinMutations) {
    assert.ok(
      findUnsafeNativeLogCalls(source, 'Example.kt').some(
        (finding) => finding.reason === expectedReason,
      ),
      source,
    );
  }

  const javaMutations = [
    [
      String.raw`android\u002eutil\u002eLog\u002ee("PrivateTag", privateValue);`,
      'unapproved native Log call',
    ],
    [
      String.raw`class X { void leak() { \u0053ystem.err.println(secret); } }`,
      'raw native stdout/stderr call',
    ],
    [
      String.raw`class X { void leak() { android.util.\u004cog.e("PrivateTag", secret); } }`,
      'unapproved native Log call',
    ],
    [String.raw`java.lang.Syst\u0065m.err.println(privateValue);`, 'raw native stdout/stderr call'],
    [
      String.raw`// hidden until Unicode translation \u000a android.util.Log.e("PrivateTag", privateValue);`,
      'unapproved native Log call',
    ],
    [
      String.raw`// carriage return is also a Java line end \u000d System.err.println(privateValue);`,
      'raw native stdout/stderr call',
    ],
    [
      String.raw`/* hidden terminator \u002a\u002f System.err.println(privateValue);`,
      'raw native stdout/stderr call',
    ],
  ];
  for (const [source, expectedReason] of javaMutations) {
    assert.ok(
      findUnsafeNativeLogCalls(source, 'Example.java').some(
        (finding) => finding.reason === expectedReason,
      ),
      source,
    );
  }
});

test('honors Java Unicode-escape eligibility without weakening escaped-code detection', () => {
  const inertDoubleBackslash = String.raw`class X { void safe() { // inert \\u000a System.err.println(secret); } }`;
  assert.deepEqual(findUnsafeNativeLogCalls(inertDoubleBackslash, 'Example.java'), []);

  for (const source of [
    String.raw`class X { void leak() { // eligible third slash \\\u000a System.err.println(secret); } }`,
    String.raw`class X { void leak() { // escape-produced slash \u005c\u000a System.err.println(secret); } }`,
  ]) {
    assert.ok(
      findUnsafeNativeLogCalls(source, 'Example.java').some(
        (finding) => finding.reason === 'raw native stdout/stderr call',
      ),
      source,
    );
  }
});

test('normalizes raw and escaped Java identifier-ignorable characters', () => {
  const zeroWidthNonJoiner = String.fromCodePoint(0x200c);
  const identifierControl = String.fromCodePoint(0x0001);
  const mutations = [
    [`Sys${zeroWidthNonJoiner}tem.err.println(secret);`, 'raw native stdout/stderr call'],
    [
      `android.util.L${zeroWidthNonJoiner}og.e("PrivateTag", secret);`,
      'unapproved native Log call',
    ],
    [String.raw`Sys\u200ctem.err.println(secret);`, 'raw native stdout/stderr call'],
    [String.raw`android.util.L\u200Cog.e("PrivateTag", secret);`, 'unapproved native Log call'],
    [`Sys${identifierControl}tem.err.println(secret);`, 'raw native stdout/stderr call'],
    [String.raw`android.util.L\u0001og.e("PrivateTag", secret);`, 'unapproved native Log call'],
  ];

  for (const [source, expectedReason] of mutations) {
    assert.ok(
      findUnsafeNativeLogCalls(source, 'Example.java').some(
        (finding) => finding.reason === expectedReason,
      ),
      source,
    );
  }
});

test('rejects shadowable Log receivers and approves only the fully qualified finite call', () => {
  const ownedSource = (body) =>
    [
      'import expo.modules.kotlin.modules.Module',
      'import external.ExternalLogOwner',
      'private const val TAG = "GatorPasteInput"',
      'class GatorPasteInputModule : Module() {',
      `  fun leak(owner: ExternalLogOwner) { ${body} }`,
      '}',
    ].join('\n');

  for (const body of [
    'with(owner) { Log.w(TAG, "attach failed") }',
    'with(owner) { Log.w("GatorPasteInput", "attach failed") }',
    'owner.apply { Log.w("GatorPasteInput", "attach failed") }',
    'owner.run { Log.w("GatorPasteInput", "attach failed") }',
    'owner.configure { Log.w("GatorPasteInput", "attach failed") }',
    'val Log = owner; Log.w("GatorPasteInput", "attach failed")',
    'fun nested(Log: ExternalLogOwner) { Log.w("GatorPasteInput", "attach failed") }; nested(owner)',
  ]) {
    assert.ok(
      findUnsafeNativeLogCalls(ownedSource(body), ownedNativeFile).some(
        (finding) => finding.reason === 'unapproved native Log call',
      ),
      body,
    );
  }

  assert.deepEqual(findUnsafeNativeLogCalls(ownedNativeSource, ownedNativeFile), []);
});

test('pins the complete owned native source against android shadowing and decoys', () => {
  const reviewedCall = 'android.util.Log.w("GatorPasteInput", "detach failed")';
  assert.equal(ownedNativeSource.split(reviewedCall).length - 1, 1);

  const mutations = [
    [
      'local android',
      ownedNativeSource.replace(reviewedCall, `run { val android = owner; ${reviewedCall} }`),
    ],
    [
      'android parameter',
      ownedNativeSource.replace(
        'class GatorPasteInputModule : Module() {',
        [
          'class GatorPasteInputModule : Module() {',
          '  private fun shadow(android: ExternalAndroid) {',
          '    android.util.Log.w("GatorPasteInput", "detach failed")',
          '  }',
        ].join('\n'),
      ),
    ],
    [
      'member android property',
      ownedNativeSource.replace(
        'class GatorPasteInputModule : Module() {',
        [
          'class GatorPasteInputModule : Module() {',
          '  private val android = ExternalAndroid()',
          '  private fun shadowProperty() {',
          '    android.util.Log.w("GatorPasteInput", "detach failed")',
          '  }',
        ].join('\n'),
      ),
    ],
    [
      'implicit-receiver android property',
      ownedNativeSource.replace(reviewedCall, `with(owner) { ${reviewedCall} }`),
    ],
    [
      'reviewed-call decoy before shadowed call',
      ownedNativeSource.replace(
        reviewedCall,
        `if (false) { ${reviewedCall} }; with(owner) { ${reviewedCall} }`,
      ),
    ],
    ['duplicate reviewed call', `${ownedNativeSource}\n${reviewedCall}\n`],
  ];

  for (const [name, source] of mutations) {
    assert.notEqual(source, ownedNativeSource, name);
    const contractFindings = findUnsafeNativeLogCalls(source, ownedNativeFile).filter(
      (finding) => finding.reason === 'owned native source contract changed',
    );
    assert.equal(contractFindings.length, 1, name);
  }
});

test('the repository walk scans every generated Android application source set', (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'gator-error-guard-'));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  initializeGuardFixture(fixtureRoot);
  writeFixtureFile(
    fixtureRoot,
    'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput/GatorPasteInputModule.kt',
    ownedNativeSource,
  );
  writeFixtureFile(
    fixtureRoot,
    'android/app/src/release/java/com/example/GeneratedApplication.kt',
    ['import android.util.Log', 'Log.e("PrivateTag", privateValue)'].join('\n'),
  );

  assert.throws(
    () => runErrorDiagnosticCheck({ root: fixtureRoot }),
    /android\/app\/src\/release\/java\/com\/example\/GeneratedApplication\.kt/,
  );
});

test('the repository walk requires the exact owned native file', (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'gator-error-guard-missing-owner-'));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  initializeGuardFixture(fixtureRoot);

  assert.throws(
    () => runErrorDiagnosticCheck({ root: fixtureRoot }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          'owned native source must be encountered exactly once at ' +
            'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput/' +
            'GatorPasteInputModule.kt; found 0',
        ),
      );
      return true;
    },
  );
});

test('the repository walk rejects a symlinked owned-source parent', (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'gator-error-guard-symlink-owner-'));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  initializeGuardFixture(fixtureRoot);

  const target = join(fixtureRoot, 'outside-native-scan');
  writeFixtureFile(
    fixtureRoot,
    'outside-native-scan/GatorPasteInputModule.kt',
    'class Leak { fun run() { System.err.println(secret) } }',
  );
  const linkedParent = join(
    fixtureRoot,
    'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput',
  );
  mkdirSync(dirname(linkedParent), { recursive: true });
  symlinkSync(target, linkedParent, 'dir');

  assert.throws(
    () => runErrorDiagnosticCheck({ root: fixtureRoot }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput: ' +
            'native scan path must not be a symbolic link',
        ),
      );
      assert.ok(error.message.includes('owned native source must be encountered exactly once'));
      return true;
    },
  );
});

test('the repository walk does not grant ownership to a nested suffix decoy', (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'gator-error-guard-suffix-owner-'));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  initializeGuardFixture(fixtureRoot);

  const decoyPath =
    'modules/decoy/modules/gator-paste-input/android/src/main/java/expo/modules/' +
    'gatorpasteinput/GatorPasteInputModule.kt';
  writeFixtureFile(fixtureRoot, decoyPath, ownedNativeSource);

  assert.throws(
    () => runErrorDiagnosticCheck({ root: fixtureRoot }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`${decoyPath}:`));
      assert.ok(error.message.includes('unapproved native Log call'));
      assert.ok(
        error.message.includes('owned native source must be encountered exactly once') &&
          error.message.includes('found 0'),
      );
      return true;
    },
  );
});

test('ignores similarly named methods that are not the app logger', () => {
  assert.deepEqual(
    findUnstructuredErrorCalls(
      [
        'otherLogger.error(dynamic);',
        "file.write('error', privateValue);",
        "transport.write('error', privateValue);",
        "logger.warn('ordinary warning');",
        "import * as unrelated from './other'; unrelated.logger.error(dynamic);",
      ].join('\n'),
    ),
    [],
  );
});

test('extracts only literal exact-match registrations from the projector', () => {
  assert.deepEqual(
    [...findExactProjectorMessages("exact('[db] safe'); exact(dynamic); begins('[legacy] ');")],
    ['[db] safe'],
  );
});
