#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Exact committed registry: public opaque labels, never hashes of user or runtime input. */
export const EXPECTED_ERROR_DIAGNOSTIC_SITES = Object.freeze({
  shareNoCacheDirectory: 'st1ncp1gde',
  shareAllFilesUnreadable: 'sz3en37b70',
  shareCaptureFailed: 'sj1gzvygll',
  dbForegroundInitialization: 'syjo8z3ok4',
  dbSessionInitialization: 'solmtuzd5x',
  connectDatabaseInitialization: 'skjyhvynmb',
  newChatCreate: 'sfcbzc1wod',
  mediaShareSourceUnprotected: 'sexrkdbhts',
  mediaShareSourceMissing: 'siyzk5fb53',
  mediaShare: 'scu302lx0h',
  backgroundWork: 'slwt25up17',
  dbWriteQueueWedge: 's9d54bjxmi',
  openFile: 'sk4i8sxfdf',
  uiRender: 'sgp6mdwnu1',
  socketEvent: 's1v3iohm10',
  socketConnection: 's8uz0091sa',
  lockUnlock: 'sfnkpmyuai',
  runtimeFatal: 's9b2ygxnbx',
  runtimeUncaught: 'sfdpe2gt2k',
  runtimeUnhandledRejection: 'sgddkqme19',
  runtimeRecoverable: 'sef4olsfn3',
});

/** Every production ERROR call must use its exact developer-owned event/site pair. */
export const ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE = new Map([
  ['[share] no cache directory available — cannot accept shared files', ['shareNoCacheDirectory']],
  ['[share] all shared files were unreadable', ['shareAllFilesUnreadable']],
  ['[share] capture failed', ['shareCaptureFailed']],
  ['[db] initialization failed', ['dbForegroundInitialization', 'dbSessionInitialization']],
  ['[connect] database initialization failed', ['connectDatabaseInitialization']],
  ['[new-chat] createNewChat failed', ['newChatCreate']],
  ['[media] share source could not be protected', ['mediaShareSourceUnprotected']],
  ['[media] share source is no longer available', ['mediaShareSourceMissing']],
  ['[media] share failed', ['mediaShare']],
  ['[bg] background work failed', ['backgroundWork']],
  ['[db] write queue appears wedged', ['dbWriteQueueWedge']],
  ['[openFile] failed to open attachment', ['openFile']],
  ['[ErrorBoundary] render crash', ['uiRender']],
  ['[socket] event handling failed', ['socketEvent']],
  ['[socket] connection failed', ['socketConnection']],
  ['[lock] unlock failed after successful auth', ['lockUnlock']],
  ['[fatal] runtime error', ['runtimeFatal']],
  ['[uncaught] runtime error', ['runtimeUncaught']],
  ['[unhandledRejection] runtime error', ['runtimeUnhandledRejection']],
]);

export const ALLOWED_ERROR_MESSAGES = new Set(ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE.keys());
export const EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE = new Map([
  ...ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE,
  ['[recoverable] runtime warning', ['runtimeRecoverable']],
]);
const EXPECTED_LOGGER_SITE_TOKENS = new Set(
  [...ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE.values()]
    .flat()
    .map((site) => EXPECTED_ERROR_DIAGNOSTIC_SITES[site]),
);
const INVALID_SITE_REGISTRY_ENTRY = '<invalid-site-registry-entry>';
const INVALID_PROJECTOR_SITE = '<invalid-projector-site>';
const INVALID_PROJECTOR_EVENT = '<invalid-projector-event>';
const PROJECTOR_EVENT_PROPERTIES = new Set(['code', 'tag', 'siteTokens', 'matches']);

/** Finite native logcat messages; raw throwable/provider prose is never permitted. */
export const ALLOWED_NATIVE_LOG_MESSAGES = new Set([
  'attach failed',
  'detach failed',
  'paste batch failed',
  'paste batch rejected',
  'paste cache cleanup failed',
  'paste committed-batch cleanup failed',
]);

const GENERATED_DIRECTORY_NAMES = new Set(['.gradle', 'build', 'dist', 'node_modules']);
const OWNED_CONSOLE_SINK = 'src/core/secure/logger.ts';
const OWNED_REACT_NATIVE_CONSOLE_BOUNDARY = 'src/services/errors/reactNativeExceptionPrivacy.ts';
const OWNED_CONSOLE_SINK_CONTRACT =
  '29ad9f69cac087f4f847b2901c9308ee8fac239ab9cc8486d83961410edef385';
const OWNED_REACT_NATIVE_CONSOLE_BOUNDARY_CONTRACT =
  'f0141cf6aed9164f125e36c37ac2b0962fe7c56821ab0ba9c89d51dea9276652';
const OWNED_NATIVE_LOG_FILE =
  'modules/gator-paste-input/android/src/main/java/expo/modules/gatorpasteinput/GatorPasteInputModule.kt';
const OWNED_NATIVE_LOG_TAG = 'GatorPasteInput';
const OWNED_NATIVE_LOG_SOURCE_CONTRACT =
  'daa290858ac0c0046d5eff0bf713969deb6c362e14f6d47ff0009bdcc77462c3';
const NATIVE_LOG_METHODS = new Set(['d', 'e', 'i', 'println', 'v', 'w', 'wtf']);
const JAVA_FORMAT_CHARACTER = /\p{Cf}/u;

function isJavaIdentifierIgnorable(char) {
  const codePoint = char.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x0000 && codePoint <= 0x0008) ||
      (codePoint >= 0x000e && codePoint <= 0x001b) ||
      (codePoint >= 0x007f && codePoint <= 0x009f) ||
      JAVA_FORMAT_CHARACTER.test(char))
  );
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory() && !GENERATED_DIRECTORY_NAMES.has(entry.name)) {
      files.push(...sourceFiles(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function nativeSourceFiles(dir, symbolicLinks) {
  const files = [];
  if (!existsSync(dir)) return files;
  if (lstatSync(dir).isSymbolicLink()) {
    symbolicLinks.push(dir);
    return files;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) {
      symbolicLinks.push(path);
    } else if (entry.isDirectory() && !GENERATED_DIRECTORY_NAMES.has(entry.name)) {
      files.push(...nativeSourceFiles(path, symbolicLinks));
    } else if (/\.(?:java|kt)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const KNOWN_SINK_EXPORTS = new Set(['errorReportSink', 'fileLogSink', 'logSinks', 'memoryLogSink']);

function moduleCanExportAppLogger(moduleName) {
  moduleName = moduleName.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return (
    ['@core/secure', '@core/secure/index', '@core/secure/logger'].includes(moduleName) ||
    /(?:^|\/)core\/secure(?:\/index|\/logger)?$/.test(moduleName)
  );
}

function moduleIsCoreBarrel(moduleName) {
  moduleName = moduleName.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return (
    ['@core', '@core/index'].includes(moduleName) || /(?:^|\/)core(?:\/index)?$/.test(moduleName)
  );
}

function normalizedPath(fileName) {
  return fileName.replaceAll('\\', '/');
}

function isPath(fileName, expected) {
  const path = normalizedPath(fileName);
  return path === expected || path.endsWith(`/${expected}`);
}

function memberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression;
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function receiver(expression) {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function identifierName(expression) {
  expression = unwrapExpression(expression);
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

function unwrapExpression(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function diagnosticSiteProperty(expression) {
  expression = expression && unwrapExpression(expression);
  if (!expression || !ts.isPropertyAccessExpression(expression)) return undefined;
  const owner = unwrapExpression(expression.expression);
  return ts.isIdentifier(owner) && owner.text === 'ERROR_DIAGNOSTIC_SITES'
    ? expression.name.text
    : undefined;
}

function combinedExpressionKind(...kinds) {
  const present = kinds.filter((kind) => kind !== undefined);
  if (present.includes('console-write')) return 'console-write';
  if (present.includes('sink-write')) return 'sink-write';
  if (present.includes('logger-error')) return 'logger-error';
  return present[0];
}

function expressionKind(expression, bindings) {
  expression = unwrapExpression(expression);
  const identifier = identifierName(expression);
  if (identifier) {
    if (bindings.loggers.has(identifier)) return 'logger';
    if (bindings.sinks.has(identifier)) return 'sink';
    if (bindings.loggerErrorFunctions.has(identifier)) return 'logger-error';
    if (bindings.sinkWriteFunctions.has(identifier)) return 'sink-write';
    if (bindings.consoleObjects.has(identifier)) return 'console';
    if (bindings.consoleFunctions.has(identifier)) return 'console-write';
    if (bindings.secureNamespaces.has(identifier)) return 'secure-namespace';
    if (bindings.coreNamespaces.has(identifier)) return 'core-namespace';
    if (bindings.globalObjects.has(identifier)) return 'global-object';
    return undefined;
  }
  if (ts.isCallExpression(expression) && expression.arguments.length === 1) {
    const isRequire =
      ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
    const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) return undefined;
    const moduleName = literalText(expression.arguments[0]);
    if (moduleName && moduleCanExportAppLogger(moduleName)) return 'secure-namespace';
    if (moduleName && moduleIsCoreBarrel(moduleName)) return 'core-namespace';
    return undefined;
  }
  if (ts.isConditionalExpression(expression)) {
    return combinedExpressionKind(
      expressionKind(expression.whenTrue, bindings),
      expressionKind(expression.whenFalse, bindings),
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return combinedExpressionKind(
      expressionKind(expression.left, bindings),
      expressionKind(expression.right, bindings),
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return expressionKind(expression.right, bindings);
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  const base = expressionKind(receiver(expression), bindings);
  const member = memberName(expression);
  if (base === 'global-object' && member === 'console') return 'console';
  if (base === 'global-object' && (member === 'nativeLoggingHook' || member === '__inspectorLog')) {
    return 'console-write';
  }
  if (base === 'core-namespace' && member === 'secure') return 'secure-namespace';
  if (base === 'secure-namespace') {
    if (member === 'logger') return 'logger';
    if (member && KNOWN_SINK_EXPORTS.has(member)) return 'sink';
  }
  if (base === 'logger' && member === 'error') return 'logger-error';
  if (base === 'sink' && member === 'write') return 'sink-write';
  // Any statically named console member can emit or expose an output function. Treating the whole
  // object as closed is safer than maintaining a browser/RN-version-specific method list.
  if (base === 'console' && member !== undefined) return 'console-write';
  return undefined;
}

function propertyBindingName(element) {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
}

/** Resolve the small, closed set of logger/sink aliases that can bypass the canonical spelling. */
function diagnosticBindings(sourceFile) {
  // Preserve the historical helper contract for snippets containing bare `logger.error(...)`, while
  // resolving real import aliases in production source. Sink names are public singletons and are
  // likewise reserved here; unrelated `.write('error', ...)` methods remain untouched.
  const loggers = new Set(['logger']);
  const sinks = new Set(KNOWN_SINK_EXPORTS);
  const loggerErrorFunctions = new Set();
  const sinkWriteFunctions = new Set();
  const secureNamespaces = new Set();
  const coreNamespaces = new Set();
  const consoleObjects = new Set(['console']);
  const consoleFunctions = new Set();
  const globalObjects = new Set(['global', 'globalThis', 'window']);

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const moduleName = literalText(statement.moduleReference.expression);
      if (moduleName && moduleCanExportAppLogger(moduleName)) {
        secureNamespaces.add(statement.name.text);
      } else if (moduleName && moduleIsCoreBarrel(moduleName)) {
        coreNamespaces.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    const moduleName = statement.moduleSpecifier.text;
    if (named && ts.isNamespaceImport(named)) {
      if (moduleCanExportAppLogger(moduleName)) secureNamespaces.add(named.name.text);
      else if (moduleIsCoreBarrel(moduleName)) coreNamespaces.add(named.name.text);
      continue;
    }
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (exported === 'logger' && moduleCanExportAppLogger(moduleName)) {
        loggers.add(element.name.text);
      }
      if (exported === 'secure' && moduleIsCoreBarrel(moduleName)) {
        secureNamespaces.add(element.name.text);
      }
      if (KNOWN_SINK_EXPORTS.has(exported)) sinks.add(element.name.text);
    }
  }

  // Resolve `const alias = logger`, `const { error: report } = logger`, and the equivalent
  // singleton-sink forms. This also covers simple `alias = logger` assignments. Iterate to a fixed
  // point so declaration order and a short alias chain cannot hide a call.
  const bindings = {
    loggers,
    sinks,
    loggerErrorFunctions,
    sinkWriteFunctions,
    secureNamespaces,
    coreNamespaces,
    consoleObjects,
    consoleFunctions,
    globalObjects,
  };
  const addBinding = (name, kind) => {
    const destination =
      kind === 'logger'
        ? loggers
        : kind === 'sink'
          ? sinks
          : kind === 'logger-error'
            ? loggerErrorFunctions
            : kind === 'sink-write'
              ? sinkWriteFunctions
              : kind === 'console'
                ? consoleObjects
                : kind === 'console-write'
                  ? consoleFunctions
                  : kind === 'secure-namespace'
                    ? secureNamespaces
                    : kind === 'core-namespace'
                      ? coreNamespaces
                      : kind === 'global-object'
                        ? globalObjects
                        : undefined;
    if (!destination || destination.has(name)) return false;
    destination.add(name);
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializerKind = expressionKind(node.initializer, bindings);
        if (ts.isIdentifier(node.name)) {
          if (addBinding(node.name.text, initializerKind)) changed = true;
        } else if (ts.isObjectBindingPattern(node.name) && initializerKind) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = propertyBindingName(element);
            const propertyKind =
              initializerKind === 'logger' && property === 'error'
                ? 'logger-error'
                : initializerKind === 'sink' && property === 'write'
                  ? 'sink-write'
                  : initializerKind === 'console' && property !== undefined
                    ? 'console-write'
                    : initializerKind === 'secure-namespace' && property === 'logger'
                      ? 'logger'
                      : initializerKind === 'secure-namespace' && KNOWN_SINK_EXPORTS.has(property)
                        ? 'sink'
                        : initializerKind === 'core-namespace' && property === 'secure'
                          ? 'secure-namespace'
                          : initializerKind === 'global-object' && property === 'console'
                            ? 'console'
                            : undefined;
            if (addBinding(element.name.text, propertyKind)) changed = true;
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (addBinding(node.left.text, expressionKind(node.right, bindings))) changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return bindings;
}

function literalText(node) {
  if (node) node = unwrapExpression(node);
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function normalizedNodesHash(nodes, sourceFile) {
  return createHash('sha256')
    .update(
      nodes
        .map((node) => node.getText(sourceFile).replace(/\s+/g, ' ').trim())
        .join('\n-- diagnostic-contract-boundary --\n'),
    )
    .digest('hex');
}

function normalizedSourceHash(source) {
  return createHash('sha256').update(source.replace(/\r\n?/g, '\n')).digest('hex');
}

/**
 * The only two production raw-console adapters are security boundaries, not broad file
 * exemptions. Pin their complete implementation bodies so a new assignment, shadowed `safe`, or
 * raw Reflect forwarding cannot inherit the structural whitelist by reusing trusted names.
 */
function ownedConsoleContractFindings(sourceFile) {
  const topLevelFunctions = (name) =>
    sourceFile.statements.filter(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
  const topLevelVariableStatements = (name) =>
    sourceFile.statements.filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        ),
    );
  const consoleSinkClasses = sourceFile.statements.filter(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'ConsoleSink',
  );
  const consoleSinkWrites = consoleSinkClasses.flatMap((declaration) =>
    declaration.members.filter(
      (member) => ts.isMethodDeclaration(member) && identifierName(member.name) === 'write',
    ),
  );
  const capturedErrorSinkValues = topLevelFunctions('capturedErrorSinkValue');
  const outputMethodDeclarations = topLevelVariableStatements('OUTPUT_METHODS_TO_SUPPRESS');
  const reactNativeExceptionProjectors = topLevelFunctions('projectReactNativeExceptionData');
  const projectedConsoleArgumentFunctions = topLevelFunctions('projectedConsoleArguments');
  const reactNativeBoundaries = topLevelFunctions('installReleaseConsoleBoundary');
  const exceptionManagerLoaders = topLevelFunctions('loadExceptionsManager');
  const reactNativeBoundaryInstallers = topLevelFunctions(
    'installReactNativeExceptionPrivacyBoundary',
  );

  const finding = (node, reason) => ({
    line: node ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 : 1,
    message: undefined,
    reason,
  });
  if (isPath(sourceFile.fileName, OWNED_CONSOLE_SINK)) {
    const exactShape =
      capturedErrorSinkValues.length === 1 &&
      consoleSinkClasses.length === 1 &&
      consoleSinkWrites.length === 1;
    const capturedErrorSinkValue = capturedErrorSinkValues[0];
    const consoleSinkWrite = consoleSinkWrites[0];
    if (
      !exactShape ||
      !capturedErrorSinkValue ||
      !consoleSinkWrite ||
      normalizedNodesHash([capturedErrorSinkValue, consoleSinkWrite], sourceFile) !==
        OWNED_CONSOLE_SINK_CONTRACT
    ) {
      return [
        finding(capturedErrorSinkValue ?? consoleSinkWrite, 'owned console sink contract changed'),
      ];
    }
  }
  if (isPath(sourceFile.fileName, OWNED_REACT_NATIVE_CONSOLE_BOUNDARY)) {
    const exactShape =
      outputMethodDeclarations.length === 1 &&
      reactNativeExceptionProjectors.length === 1 &&
      projectedConsoleArgumentFunctions.length === 1 &&
      reactNativeBoundaries.length === 1 &&
      exceptionManagerLoaders.length === 1 &&
      reactNativeBoundaryInstallers.length === 1;
    const outputMethodDeclaration = outputMethodDeclarations[0];
    const reactNativeExceptionProjector = reactNativeExceptionProjectors[0];
    const projectedConsoleArguments = projectedConsoleArgumentFunctions[0];
    const reactNativeBoundary = reactNativeBoundaries[0];
    const exceptionManagerLoader = exceptionManagerLoaders[0];
    const reactNativeBoundaryInstaller = reactNativeBoundaryInstallers[0];
    if (
      !exactShape ||
      !outputMethodDeclaration ||
      !reactNativeExceptionProjector ||
      !projectedConsoleArguments ||
      !reactNativeBoundary ||
      !exceptionManagerLoader ||
      !reactNativeBoundaryInstaller ||
      normalizedNodesHash(
        [
          outputMethodDeclaration,
          reactNativeExceptionProjector,
          projectedConsoleArguments,
          reactNativeBoundary,
          exceptionManagerLoader,
          reactNativeBoundaryInstaller,
        ],
        sourceFile,
      ) !== OWNED_REACT_NATIVE_CONSOLE_BOUNDARY_CONTRACT
    ) {
      return [
        finding(
          outputMethodDeclaration ??
            reactNativeExceptionProjector ??
            projectedConsoleArguments ??
            reactNativeBoundary ??
            exceptionManagerLoader ??
            reactNativeBoundaryInstaller,
          'React Native console privacy contract changed',
        ),
      ];
    }
  }
  return [];
}

function enclosingConsoleSinkWrite(node, sourceFile) {
  if (!isPath(sourceFile.fileName, OWNED_CONSOLE_SINK)) return undefined;
  let method;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current)) {
      method = current;
      break;
    }
  }
  if (!method || identifierName(method.name) !== 'write') return undefined;
  const owner = method.parent;
  if (!ts.isClassDeclaration(owner) || owner.name?.text !== 'ConsoleSink') return undefined;
  return method;
}

function isIdentifierText(node, expected) {
  return ts.isIdentifier(unwrapExpression(node)) && unwrapExpression(node).text === expected;
}

function isStringText(node, expected) {
  return literalText(node) === expected;
}

function isStrictStringCheck(node, identifier, expected) {
  node = unwrapExpression(node);
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isIdentifierText(node.left, identifier) &&
    isStringText(node.right, expected)
  );
}

function isBareConsoleMember(node, expected) {
  node = unwrapExpression(node);
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    identifierName(receiver(node)) === 'console' &&
    memberName(node) === expected
  );
}

/** The sole raw-console selector allowed in production source. */
function isApprovedConsoleSelector(node) {
  node = unwrapExpression(node);
  if (!ts.isConditionalExpression(node)) return false;
  const fallback = unwrapExpression(node.whenFalse);
  return (
    isStrictStringCheck(node.condition, 'level', 'error') &&
    isBareConsoleMember(node.whenTrue, 'error') &&
    ts.isConditionalExpression(fallback) &&
    isStrictStringCheck(fallback.condition, 'level', 'warn') &&
    isBareConsoleMember(fallback.whenTrue, 'warn') &&
    isBareConsoleMember(fallback.whenFalse, 'log')
  );
}

function approvedConsoleSelectorDeclaration(method) {
  if (!method.body) return undefined;
  for (const statement of method.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'out' &&
        declaration.initializer &&
        isApprovedConsoleSelector(declaration.initializer)
      ) {
        return declaration;
      }
    }
  }
  return undefined;
}

function isSafeProperty(node, objectName, propertyName) {
  node = unwrapExpression(node);
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    identifierName(receiver(node)) === objectName &&
    memberName(node) === propertyName
  );
}

function isApprovedConsoleSinkCall(node, sourceFile) {
  const method = enclosingConsoleSinkWrite(node, sourceFile);
  if (!method || !approvedConsoleSelectorDeclaration(method)) return false;
  if (!isIdentifierText(node.expression, 'out')) return false;
  return (
    (node.arguments.length === 1 && isSafeProperty(node.arguments[0], 'safe', 'message')) ||
    (node.arguments.length === 2 &&
      isSafeProperty(node.arguments[0], 'safe', 'message') &&
      isSafeProperty(node.arguments[1], 'safe', 'meta'))
  );
}

function isApprovedConsoleSinkReference(node, sourceFile) {
  const method = enclosingConsoleSinkWrite(node, sourceFile);
  if (!method) return false;
  for (let current = node.parent; current && current !== method; current = current.parent) {
    if (ts.isVariableDeclaration(current)) {
      return (
        ts.isIdentifier(current.name) &&
        current.name.text === 'out' &&
        current.initializer !== undefined &&
        isApprovedConsoleSelector(current.initializer)
      );
    }
  }
  return false;
}

function enclosingNamedFunction(node, expected) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === expected) return current;
  }
  return undefined;
}

/**
 * The RN privacy boundary has to capture and replace `console.error`/`console.warn`. Approve only
 * those four property references inside the one installer; calls still fail the guard.
 */
function isApprovedReactNativeConsoleBoundaryReference(node, sourceFile) {
  if (!isPath(sourceFile.fileName, OWNED_REACT_NATIVE_CONSOLE_BOUNDARY)) return false;
  if (!enclosingNamedFunction(node, 'installReleaseConsoleBoundary')) return false;
  const expression = outerTransparentExpression(node);
  if (
    (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) ||
    identifierName(receiver(expression)) !== 'runtimeConsole' ||
    !['error', 'warn'].includes(memberName(expression))
  ) {
    return false;
  }
  const expectedOriginal = memberName(expression) === 'error' ? 'originalError' : 'originalWarn';
  const parent = expression.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === expectedOriginal
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === expression &&
    ts.isIdentifier(parent.left) &&
    parent.left.text === expectedOriginal
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === expression &&
    ts.isArrowFunction(parent.right)
  );
}

/** Approve only the exact loop that replaces additional output methods with empty functions. */
function isApprovedReactNativeConsoleBoundaryDynamicMember(node, sourceFile) {
  if (!isPath(sourceFile.fileName, OWNED_REACT_NATIVE_CONSOLE_BOUNDARY)) return false;
  if (!enclosingNamedFunction(node, 'installReleaseConsoleBoundary')) return false;
  if (
    !ts.isElementAccessExpression(node) ||
    identifierName(receiver(node)) !== 'outputMethods' ||
    !node.argumentExpression ||
    identifierName(node.argumentExpression) !== 'method'
  ) {
    return false;
  }
  const expression = outerTransparentExpression(node);
  const parent = expression.parent;
  if (ts.isTypeOfExpression(parent) && parent.expression === expression) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === expression &&
    ts.isArrowFunction(parent.right) &&
    parent.right.parameters.length === 0 &&
    ts.isBlock(parent.right.body) &&
    parent.right.body.statements.length === 0
  );
}

function transparentParentExpression(node) {
  const parent = node.parent;
  if (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent)) &&
    parent.expression === node
  ) {
    return parent;
  }
  return undefined;
}

function outerTransparentExpression(node) {
  let current = node;
  for (;;) {
    const parent = transparentParentExpression(current);
    if (!parent) return current;
    current = parent;
  }
}

function isImmediateCallTarget(node) {
  const expression = outerTransparentExpression(node);
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

function isIndirectCallTarget(node) {
  const expression = outerTransparentExpression(node);
  const parent = expression.parent;
  if (
    !parent ||
    (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) ||
    !['apply', 'bind', 'call'].includes(memberName(parent))
  ) {
    return false;
  }
  const invocation = outerTransparentExpression(parent).parent;
  return (
    ts.isCallExpression(invocation) && invocation.expression === outerTransparentExpression(parent)
  );
}

const DIAGNOSTIC_OBJECT_KINDS = new Set([
  'console',
  'core-namespace',
  'global-object',
  'logger',
  'secure-namespace',
  'sink',
]);

function isApprovedDiagnosticObjectForwarding(node, kind, sourceFile) {
  if (isPath(sourceFile.fileName, OWNED_CONSOLE_SINK)) {
    const expression = outerTransparentExpression(node);
    const parent = expression.parent;
    if (ts.isNewExpression(parent) && parent.arguments?.includes(expression)) {
      const constructorName = identifierName(parent.expression);
      if (constructorName === 'TeeSink' && identifierName(expression) === 'memoryLogSink') {
        return true;
      }
      if (constructorName === 'RedactingLogger' && identifierName(expression) === 'logSinks') {
        return true;
      }
    }
  }
  if (isPath(sourceFile.fileName, OWNED_REACT_NATIVE_CONSOLE_BOUNDARY)) {
    if (enclosingNamedFunction(node, 'installReleaseConsoleBoundary')) return true;
    const expression = outerTransparentExpression(node);
    const parent = expression.parent;
    if (
      kind === 'console' &&
      ts.isCallExpression(parent) &&
      parent.arguments[0] === expression &&
      identifierName(parent.expression) === 'installReleaseConsoleBoundary' &&
      identifierName(expression) === 'runtimeConsole'
    ) {
      return true;
    }
  }

  const expression = outerTransparentExpression(node);
  const parent = expression.parent;
  if (
    kind === 'sink' &&
    ts.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === expression &&
    (ts.isPropertyAccessExpression(parent.expression) ||
      ts.isElementAccessExpression(parent.expression)) &&
    identifierName(receiver(parent.expression)) === 'logSinks' &&
    memberName(parent.expression) === 'add'
  ) {
    return (
      (isPath(sourceFile.fileName, 'src/services/errors/index.ts') &&
        identifierName(expression) === 'errorReportSink') ||
      (isPath(sourceFile.fileName, 'src/services/logging/fileLogSink.ts') &&
        identifierName(expression) === 'fileLogSink')
    );
  }
  return false;
}

function inspectErrorCalls(source, fileName = 'input.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = diagnosticBindings(sourceFile);
  const findings = ownedConsoleContractFindings(sourceFile);
  let calls = 0;
  const sites = [];
  const addLoggerCall = (node) => {
    calls += 1;
    const message = literalText(node.arguments[0]);
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (message === undefined || !ALLOWED_ERROR_MESSAGES.has(message)) {
      findings.push({
        line: position.line + 1,
        message,
        reason: message === undefined ? 'dynamic message' : 'unknown event',
      });
      return;
    }
    const siteToken = literalText(node.arguments[1]);
    if (siteToken === undefined) {
      findings.push({
        line: position.line + 1,
        message,
        reason: node.arguments[1] === undefined ? 'missing crash site' : 'dynamic crash site',
      });
      return;
    }
    const allowedTokens = (ALLOWED_ERROR_SITE_PROPERTIES_BY_MESSAGE.get(message) ?? []).map(
      (site) => EXPECTED_ERROR_DIAGNOSTIC_SITES[site],
    );
    if (allowedTokens.includes(siteToken)) {
      sites.push(siteToken);
      return;
    }
    findings.push({
      line: position.line + 1,
      message,
      reason: 'event/site mismatch',
    });
  };
  const addDirectSinkCall = (node) => {
    calls += 1;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: literalText(node.arguments[1]),
      reason: 'direct log sink write',
    });
  };
  const addRawConsoleCall = (node) => {
    if (isApprovedConsoleSinkCall(node, sourceFile)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: undefined,
      reason: 'raw console call',
    });
  };
  const addReference = (node, kind) => {
    if (
      kind === 'console-write' &&
      (isApprovedConsoleSinkReference(node, sourceFile) ||
        isApprovedReactNativeConsoleBoundaryReference(node, sourceFile))
    ) {
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: undefined,
      reason:
        kind === 'logger-error'
          ? 'logger.error reference'
          : kind === 'sink-write'
            ? 'log sink write reference'
            : 'raw console function reference',
    });
  };
  const addDynamicMember = (node, base) => {
    if (base === 'console' && isApprovedReactNativeConsoleBoundaryDynamicMember(node, sourceFile)) {
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: undefined,
      reason:
        base === 'logger'
          ? 'dynamic logger member'
          : base === 'sink'
            ? 'dynamic log sink member'
            : base === 'console'
              ? 'dynamic console member'
              : 'dynamic diagnostic namespace member',
    });
  };
  const addDestructuredReferences = (node) => {
    if (!ts.isObjectBindingPattern(node.name) || !node.initializer) return;
    const initializerKind = expressionKind(node.initializer, bindings);
    for (const element of node.name.elements) {
      const property = propertyBindingName(element);
      const kind =
        initializerKind === 'logger' && property === 'error'
          ? 'logger-error'
          : initializerKind === 'sink' && property === 'write'
            ? 'sink-write'
            : initializerKind === 'console' && property !== undefined
              ? 'console-write'
              : undefined;
      if (kind) addReference(element, kind);
    }
    // Object rest preserves every property not named explicitly, including console and native
    // logging hooks. Do not let a renamed copy of the global object escape the alias resolver.
    if (
      initializerKind === 'global-object' &&
      node.name.elements.some((element) => element.dotDotDotToken !== undefined)
    ) {
      addForwardedObject(node.initializer);
    }
  };
  const addIndirectCall = (node, kind) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: undefined,
      reason:
        kind === 'logger-error'
          ? 'indirect logger.error call'
          : kind === 'sink-write'
            ? 'indirect log sink write'
            : 'indirect raw console call',
    });
  };
  const addForwardedObject = (node) => {
    if (!node) return;
    const kind = expressionKind(node, bindings);
    if (!DIAGNOSTIC_OBJECT_KINDS.has(kind)) return;
    if (isApprovedDiagnosticObjectForwarding(node, kind, sourceFile)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      line: position.line + 1,
      message: undefined,
      reason: 'diagnostic object forwarding',
    });
  };
  const variableIsExported = (node) => {
    const statement = node.parent?.parent;
    return (
      statement &&
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      addDestructuredReferences(node);
      if (node.initializer && variableIsExported(node)) addForwardedObject(node.initializer);
    }
    if (ts.isParameter(node) && node.initializer) addForwardedObject(node.initializer);
    if (ts.isReturnStatement(node) && node.expression) addForwardedObject(node.expression);
    if (ts.isExportAssignment(node)) addForwardedObject(node.expression);
    if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
      if (node.initializer) addForwardedObject(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node)) addForwardedObject(node.name);
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      addForwardedObject(node.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) addForwardedObject(element);
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      addForwardedObject(node.body);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !ts.isIdentifier(node.left)
    ) {
      addForwardedObject(node.right);
    }
    if (ts.isJsxExpression(node) && node.expression) addForwardedObject(node.expression);
    if (ts.isExportDeclaration(node)) {
      const moduleName = literalText(node.moduleSpecifier);
      if (moduleName && (moduleCanExportAppLogger(moduleName) || moduleIsCoreBarrel(moduleName))) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({
          line: position.line + 1,
          message: undefined,
          reason: 'diagnostic re-export',
        });
      } else if (!moduleName && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addForwardedObject(element.propertyName ?? element.name);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addForwardedObject(node);
      const kind = expressionKind(node.expression, bindings);
      if (kind === 'logger-error') {
        addLoggerCall(node);
      } else if (kind === 'sink-write') {
        addDirectSinkCall(node);
      } else if (kind === 'console-write') {
        addRawConsoleCall(node);
      } else if (
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
        ['apply', 'bind', 'call'].includes(memberName(node.expression))
      ) {
        const indirectKind = expressionKind(receiver(node.expression), bindings);
        if (
          indirectKind === 'logger-error' ||
          indirectKind === 'sink-write' ||
          indirectKind === 'console-write'
        ) {
          addIndirectCall(node, indirectKind);
        }
      }
      for (const argument of node.arguments) addForwardedObject(argument);
    }
    if (ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) addForwardedObject(argument);
    }
    if (ts.isElementAccessExpression(node) && memberName(node) === undefined) {
      const base = expressionKind(receiver(node), bindings);
      if (
        [
          'logger',
          'sink',
          'console',
          'secure-namespace',
          'core-namespace',
          'global-object',
        ].includes(base)
      ) {
        addDynamicMember(node, base);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const kind = expressionKind(node, bindings);
      if (
        ['logger-error', 'sink-write', 'console-write'].includes(kind) &&
        !isImmediateCallTarget(node) &&
        !isIndirectCallTarget(node)
      ) {
        addReference(node, kind);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, findings, sites };
}

/** Return every dynamic or non-allowlisted `logger.error(...)` call in one source file. */
export function findUnstructuredErrorCalls(source, fileName = 'input.ts') {
  return inspectErrorCalls(source, fileName).findings;
}

function skipNativeBlockComment(source, start) {
  let index = start;
  let depth = 0;
  while (index < source.length) {
    if (source.charAt(index) === '/' && source.charAt(index + 1) === '*') {
      depth += 1;
      index += 2;
      continue;
    }
    if (source.charAt(index) === '*' && source.charAt(index + 1) === '/') {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return index;
}

function isNativeLineTerminator(char) {
  return char === '\n' || char === '\r';
}

function skipNativeQuotedLiteral(source, start, kotlin) {
  const quote = source.charAt(start);
  const triple = quote === '"' && source.slice(start, start + 3) === '"""';
  const delimiterLength = triple ? 3 : 1;
  let index = start + delimiterLength;
  let escaped = false;
  while (index < source.length) {
    if (triple && source.slice(index, index + delimiterLength) === '"""') {
      return index + delimiterLength;
    }
    if (!triple && !escaped && source.charAt(index) === quote) return index + 1;
    if (
      kotlin &&
      quote === '"' &&
      (triple || !escaped) &&
      source.charAt(index) === '$' &&
      source.charAt(index + 1) === '{'
    ) {
      const end = findKotlinTemplateExpressionEnd(source, index + 2);
      if (end === undefined) return source.length;
      index = end + 1;
      escaped = false;
      continue;
    }
    const current = source.charAt(index);
    if (!triple && current === '\\' && !escaped) escaped = true;
    else escaped = false;
    index += 1;
  }
  return index;
}

function findKotlinTemplateExpressionEnd(source, start) {
  let index = start;
  let depth = 1;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && !isNativeLineTerminator(source.charAt(index))) index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipNativeBlockComment(source, index);
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipNativeQuotedLiteral(source, index, true);
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < source.length && source.charAt(index) !== '`') index += 1;
      if (source.charAt(index) === '`') index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

/** Java Unicode-escape translation, including the JLS 3.3 eligibility rule. */
function decodeJavaUnicodeEscapes(source) {
  const translated = [];
  let trailingBackslashes = 0;
  let mostRecentFromEscape = false;
  for (let index = 0; index < source.length;) {
    const char = source.charAt(index);
    if (char !== '\\') {
      translated.push(char);
      trailingBackslashes = 0;
      mostRecentFromEscape = false;
      index += 1;
      continue;
    }

    const eligible = mostRecentFromEscape || trailingBackslashes % 2 === 0;
    let markerEnd = index + 1;
    while (source.charAt(markerEnd) === 'u') markerEnd += 1;
    const codePoint = source.slice(markerEnd, markerEnd + 4);
    if (eligible && markerEnd > index + 1 && /^[0-9a-fA-F]{4}$/.test(codePoint)) {
      const decoded = String.fromCharCode(Number.parseInt(codePoint, 16));
      translated.push(decoded);
      trailingBackslashes = decoded === '\\' ? trailingBackslashes + 1 : 0;
      mostRecentFromEscape = true;
      index = markerEnd + 4;
      continue;
    }

    translated.push(char);
    trailingBackslashes += 1;
    mostRecentFromEscape = false;
    index += 1;
  }
  return translated.join('');
}

/** Tokenize the small Java/Kotlin surface needed by the native-output guard. */
function nativeTokens(source, { kotlin = true, baseLine = 1, baseIndex = 0 } = {}) {
  const tokens = [];
  let index = 0;
  let line = baseLine;
  const advance = () => {
    const current = source.charAt(index);
    if (current === '\r' || (current === '\n' && source.charAt(index - 1) !== '\r')) line += 1;
    index += 1;
  };
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && !isNativeLineTerminator(source.charAt(index))) advance();
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      advance();
      advance();
      while (index < source.length && depth > 0) {
        if (kotlin && source.charAt(index) === '/' && source.charAt(index + 1) === '*') {
          depth += 1;
          advance();
          advance();
          continue;
        }
        if (source.charAt(index) === '*' && source.charAt(index + 1) === '/') {
          depth -= 1;
          advance();
          advance();
          continue;
        }
        advance();
      }
      continue;
    }
    if (char === '"') {
      const tokenLine = line;
      const tokenIndex = index;
      const triple = source.slice(index, index + 3) === '"""';
      const delimiter = triple ? '"""' : '"';
      index += delimiter.length;
      const contentStart = index;
      const templateTokens = [];
      let escaped = false;
      while (index < source.length) {
        if (triple && source.slice(index, index + 3) === delimiter) break;
        if (!triple && !escaped && source.charAt(index) === '"') break;
        const current = source.charAt(index);
        if (kotlin && (triple || !escaped) && current === '$' && source.charAt(index + 1) === '{') {
          const expressionStart = index + 2;
          const expressionLine = line;
          const expressionEnd = findKotlinTemplateExpressionEnd(source, expressionStart);
          if (expressionEnd !== undefined) {
            const nested = nativeTokens(source.slice(expressionStart, expressionEnd), {
              kotlin: true,
              baseLine: expressionLine,
              baseIndex: baseIndex + expressionStart,
            });
            templateTokens.push({
              kind: 'punctuation',
              text: '${',
              line: expressionLine,
              index: baseIndex + index,
            });
            templateTokens.push(...nested);
            templateTokens.push({
              kind: 'punctuation',
              text: '}',
              line: nested.at(-1)?.line ?? expressionLine,
              index: baseIndex + expressionEnd,
            });
            while (index <= expressionEnd) advance();
            escaped = false;
            continue;
          }
        }
        if (!triple && current === '\\' && !escaped) escaped = true;
        else escaped = false;
        advance();
      }
      const content = source.slice(contentStart, index);
      index += source.slice(index, index + delimiter.length) === delimiter ? delimiter.length : 0;
      tokens.push({
        kind: 'string',
        text: content,
        // The finite native messages contain no escapes or interpolation. Keeping other forms
        // opaque avoids pretending this small tokenizer is a Java/Kotlin string evaluator.
        value: !triple && !content.includes('\\') && !content.includes('$') ? content : undefined,
        line: tokenLine,
        index: baseIndex + tokenIndex,
      });
      tokens.push(...templateTokens);
      continue;
    }
    if (char === "'") {
      // Character literals cannot be approved messages. Consume them so `Log.w(...)` text inside
      // one cannot look like code.
      advance();
      let escaped = false;
      while (index < source.length) {
        const current = source.charAt(index);
        if (!escaped && current === "'") {
          advance();
          break;
        }
        if (current === '\\' && !escaped) escaped = true;
        else escaped = false;
        advance();
      }
      continue;
    }
    if (kotlin && char === '`') {
      const tokenLine = line;
      const tokenIndex = index;
      advance();
      const start = index;
      while (index < source.length && source.charAt(index) !== '`') advance();
      const text = source.slice(start, index);
      if (source.charAt(index) === '`') advance();
      tokens.push({
        kind: 'identifier',
        text,
        line: tokenLine,
        index: baseIndex + tokenIndex,
      });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const tokenLine = line;
      const tokenIndex = index;
      let text = '';
      while (index < source.length) {
        const codePoint = source.codePointAt(index);
        if (codePoint === undefined) break;
        const current = String.fromCodePoint(codePoint);
        if (/[A-Za-z0-9_$]/.test(current)) text += current;
        else if (!kotlin && isJavaIdentifierIgnorable(current)) {
          // JLS 3.8 ignores these characters when deciding whether two identifiers are equal.
        } else break;
        index += current.length;
      }
      tokens.push({
        kind: 'identifier',
        text,
        line: tokenLine,
        index: baseIndex + tokenIndex,
      });
      continue;
    }
    tokens.push({ kind: 'punctuation', text: char, line, index: baseIndex + index });
    advance();
  }
  return tokens;
}

function tokenSequence(tokens, start, expected) {
  return expected.every((text, offset) => tokens[start + offset]?.text === text);
}

function nativeLogImports(tokens) {
  const receivers = new Set();
  const staticMethods = new Set();
  const kotlinIoFunctions = new Set();
  const systemReceivers = new Set(['System']);
  const imports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== 'import') continue;
    let cursor = index + 1;
    const isStatic = tokens[cursor]?.text === 'static';
    if (isStatic) cursor += 1;

    if (tokenSequence(tokens, cursor, ['android', '.', 'util', '.', '*'])) {
      receivers.add('Log');
      imports.push({
        line: tokens[index].line,
        alias: undefined,
        isStatic: false,
        method: undefined,
        wildcard: true,
      });
      continue;
    }

    if (tokenSequence(tokens, cursor, ['kotlin', '.', 'io', '.'])) {
      const method = tokens[cursor + 4]?.text;
      if (['print', 'println'].includes(method)) {
        cursor += 5;
        const alias =
          tokens[cursor]?.text === 'as' && tokens[cursor + 1]?.kind === 'identifier'
            ? tokens[cursor + 1].text
            : undefined;
        kotlinIoFunctions.add(alias ?? method);
      }
      continue;
    }

    if (tokenSequence(tokens, cursor, ['java', '.', 'lang', '.', 'System'])) {
      cursor += 5;
      if (tokens[cursor]?.text === 'as' && tokens[cursor + 1]?.kind === 'identifier') {
        systemReceivers.add(tokens[cursor + 1].text);
      }
    }

    cursor = index + 1 + (isStatic ? 1 : 0);
    if (!tokenSequence(tokens, cursor, ['android', '.', 'util', '.', 'Log'])) continue;
    cursor += 5;
    let method;
    let wildcard = false;
    if (tokens[cursor]?.text === '.' && tokens[cursor + 1]?.kind === 'identifier') {
      method = tokens[cursor + 1].text;
      cursor += 2;
    } else if (tokens[cursor]?.text === '.' && tokens[cursor + 1]?.text === '*') {
      wildcard = true;
      cursor += 2;
    }
    const alias =
      tokens[cursor]?.text === 'as' && tokens[cursor + 1]?.kind === 'identifier'
        ? tokens[cursor + 1].text
        : undefined;
    if (wildcard) {
      for (const logMethod of NATIVE_LOG_METHODS) staticMethods.add(logMethod);
    } else if (isStatic || method !== undefined) {
      if (method) staticMethods.add(alias ?? method);
    } else {
      receivers.add(alias ?? 'Log');
    }
    imports.push({
      line: tokens[index].line,
      alias,
      isStatic: isStatic || method !== undefined,
      method,
      wildcard,
    });
  }

  const typeAliases = [];
  const seenTypeAliases = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      if (
        tokens[index]?.text !== 'typealias' ||
        tokens[index + 1]?.kind !== 'identifier' ||
        tokens[index + 2]?.text !== '='
      ) {
        continue;
      }
      const alias = tokens[index + 1].text;
      const target = tokens[index + 3];
      const isLogAlias =
        tokenSequence(tokens, index + 3, ['android', '.', 'util', '.', 'Log']) ||
        (target?.kind === 'identifier' && receivers.has(target.text));
      const isSystemAlias =
        tokenSequence(tokens, index + 3, ['java', '.', 'lang', '.', 'System']) ||
        (target?.kind === 'identifier' && systemReceivers.has(target.text));
      if (isLogAlias && !receivers.has(alias)) {
        receivers.add(alias);
        changed = true;
      }
      if (isSystemAlias && !systemReceivers.has(alias)) {
        systemReceivers.add(alias);
        changed = true;
      }
      if ((isLogAlias || isSystemAlias) && !seenTypeAliases.has(alias)) {
        seenTypeAliases.add(alias);
        typeAliases.push({ alias, isLogAlias, isSystemAlias, line: tokens[index].line });
      }
    }
  }

  return {
    imports,
    kotlinIoFunctions,
    receivers,
    staticMethods,
    systemReceivers,
    typeAliases,
  };
}

function nativeCallSites(tokens, imports, { detectUnqualifiedLog = false } = {}) {
  const calls = [];
  const add = (kind, receiverName, method, openIndex, line) => {
    calls.push({ kind, receiverName, method, openIndex, line });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.kind !== 'identifier') continue;

    if (tokenSequence(tokens, index, ['android', '.', 'util', '.', 'Log'])) {
      if (['import', 'static'].includes(tokens[index - 1]?.text)) continue;
      if (tokens[index + 5]?.text === '.' && tokens[index + 6]?.kind === 'identifier') {
        const method = tokens[index + 6].text;
        if (NATIVE_LOG_METHODS.has(method) && tokens[index + 7]?.text === '(') {
          add('android-log', 'android.util.Log', method, index + 7, token.line);
        } else if (NATIVE_LOG_METHODS.has(method)) {
          add('android-log-reference', 'android.util.Log', method, index + 7, token.line);
        }
      } else if (
        tokens[index + 5]?.text === ':' &&
        tokens[index + 6]?.text === ':' &&
        NATIVE_LOG_METHODS.has(tokens[index + 7]?.text)
      ) {
        add(
          'android-log-reference',
          'android.util.Log',
          tokens[index + 7].text,
          index + 8,
          token.line,
        );
      }
      continue;
    }

    if (
      (imports.receivers.has(token.text) || (detectUnqualifiedLog && token.text === 'Log')) &&
      !tokenSequence(tokens, index - 4, ['android', '.', 'util', '.']) &&
      tokens[index + 1]?.text === '.' &&
      tokens[index + 2]?.kind === 'identifier'
    ) {
      const method = tokens[index + 2].text;
      if (NATIVE_LOG_METHODS.has(method) && tokens[index + 3]?.text === '(') {
        add('android-log', token.text, method, index + 3, token.line);
      } else if (NATIVE_LOG_METHODS.has(method)) {
        add('android-log-reference', token.text, method, index + 3, token.line);
      }
      continue;
    }

    if (
      imports.receivers.has(token.text) &&
      tokens[index + 1]?.text === ':' &&
      tokens[index + 2]?.text === ':' &&
      NATIVE_LOG_METHODS.has(tokens[index + 3]?.text)
    ) {
      add('android-log-reference', token.text, tokens[index + 3].text, index + 4, token.line);
      continue;
    }

    if (imports.staticMethods.has(token.text)) {
      if (tokens[index + 1]?.text === '(') {
        add('android-log', '<static-import>', token.text, index + 1, token.line);
      } else if (tokens[index - 1]?.text === ':' && tokens[index - 2]?.text === ':') {
        add('android-log-reference', '<static-import>', token.text, index + 1, token.line);
      }
      continue;
    }

    if (
      tokenSequence(tokens, index, ['kotlin', '.', 'io', '.']) &&
      ['print', 'println'].includes(tokens[index + 4]?.text)
    ) {
      const method = tokens[index + 4].text;
      if (tokens[index + 5]?.text === '(') {
        add('native-stdout', 'kotlin.io', method, index + 5, token.line);
      }
      continue;
    }

    if (imports.kotlinIoFunctions.has(token.text)) {
      if (tokens[index + 1]?.text === '(') {
        add('native-stdout', 'kotlin.io', token.text, index + 1, token.line);
      } else if (tokens[index - 1]?.text === ':' && tokens[index - 2]?.text === ':') {
        add('native-stdout-reference', 'kotlin.io', token.text, index + 1, token.line);
      }
      continue;
    }

    const fullyQualifiedSystem = tokenSequence(tokens, index, ['java', '.', 'lang', '.', 'System']);
    const nestedQualifiedSystem = tokenSequence(tokens, index - 4, ['java', '.', 'lang', '.']);
    const namedSystem = imports.systemReceivers.has(token.text) && !nestedQualifiedSystem;
    const systemOffset = fullyQualifiedSystem ? 5 : 1;
    if (
      (fullyQualifiedSystem || namedSystem) &&
      tokens[index + systemOffset]?.text === '.' &&
      ['out', 'err'].includes(tokens[index + systemOffset + 1]?.text)
    ) {
      const stream = tokens[index + systemOffset + 1].text;
      const afterStream = index + systemOffset + 2;
      if (
        tokens[afterStream]?.text === '.' &&
        tokens[afterStream + 1]?.kind === 'identifier' &&
        tokens[afterStream + 2]?.text === '('
      ) {
        add(
          'native-stdout',
          `System.${stream}`,
          tokens[afterStream + 1].text,
          afterStream + 2,
          token.line,
        );
      } else {
        add('native-stdout-reference', `System.${stream}`, '<reference>', afterStream, token.line);
      }
      continue;
    }

    if (
      ['print', 'println'].includes(token.text) &&
      tokens[index - 1]?.text !== '.' &&
      tokens[index - 1]?.text !== 'fun' &&
      tokens[index + 1]?.text === '('
    ) {
      add('native-stdout', '<top-level>', token.text, index + 1, token.line);
      continue;
    }

    if (
      ['print', 'println'].includes(token.text) &&
      tokens[index - 1]?.text === ':' &&
      tokens[index - 2]?.text === ':'
    ) {
      add('native-stdout-reference', '<top-level>', token.text, index + 1, token.line);
      continue;
    }

    if (
      token.text === 'printStackTrace' &&
      tokens[index - 1]?.text === '.' &&
      tokens[index + 1]?.text === '('
    ) {
      add('native-stack', '<throwable>', 'printStackTrace', index + 1, token.line);
      continue;
    }

    if (
      token.text === 'printStackTrace' &&
      tokens[index - 1]?.text === ':' &&
      tokens[index - 2]?.text === ':'
    ) {
      add('native-stack', '<throwable-reference>', 'printStackTrace', index + 1, token.line);
    }
  }
  return calls;
}

function nativeCallArguments(tokens, openIndex) {
  let depth = 0;
  const args = [];
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.text === '(') depth += 1;
    if (token.text === ')') {
      if (depth === 0) return { args, closeIndex: index };
      depth -= 1;
    }
    args.push(token);
  }
  return { args, closeIndex: undefined };
}

function exactOwnedNativeCall(tokens, call, owned) {
  if (!owned) return undefined;
  if (
    call.kind !== 'android-log' ||
    call.receiverName !== 'android.util.Log' ||
    call.method !== 'w'
  ) {
    return undefined;
  }
  const { args, closeIndex } = nativeCallArguments(tokens, call.openIndex);
  if (
    closeIndex === undefined ||
    args.length !== 3 ||
    args[0]?.kind !== 'string' ||
    args[0].value !== OWNED_NATIVE_LOG_TAG ||
    args[1]?.text !== ',' ||
    args[2]?.kind !== 'string' ||
    !ALLOWED_NATIVE_LOG_MESSAGES.has(args[2].value)
  ) {
    return undefined;
  }
  return args[2].value;
}

function inspectNativeLogCalls(
  source,
  fileName = 'input.kt',
  { owned = isPath(fileName, OWNED_NATIVE_LOG_FILE) } = {},
) {
  const kotlin = normalizedPath(fileName).endsWith('.kt');
  const translatedSource = kotlin ? source : decodeJavaUnicodeEscapes(source);
  const tokens = nativeTokens(translatedSource, { kotlin });
  const imports = nativeLogImports(tokens);
  const calls = nativeCallSites(tokens, imports, { detectUnqualifiedLog: owned });
  const findings = [];
  if (owned && normalizedSourceHash(source) !== OWNED_NATIVE_LOG_SOURCE_CONTRACT) {
    findings.push({
      line: 1,
      message: undefined,
      reason: 'owned native source contract changed',
    });
  }
  for (const entry of imports.imports) {
    findings.push({
      line: entry.line,
      message: undefined,
      reason: entry.alias ? 'aliased native Log import' : 'unapproved native Log import',
    });
  }
  for (const entry of imports.typeAliases) {
    if (!entry.isLogAlias) continue;
    findings.push({
      line: entry.line,
      message: undefined,
      reason: 'native Log typealias',
    });
  }
  const seenMessages = new Set();
  for (const call of calls) {
    const approvedMessage = exactOwnedNativeCall(tokens, call, owned);
    if (approvedMessage !== undefined && !seenMessages.has(approvedMessage)) {
      seenMessages.add(approvedMessage);
      continue;
    }
    const args = nativeCallArguments(tokens, call.openIndex).args;
    const messageArg =
      call.kind === 'android-log' && args[2]?.kind === 'string'
        ? args[2]
        : args.find((token) => token.kind === 'string');
    findings.push({
      line: call.line,
      message: messageArg?.value,
      reason:
        approvedMessage !== undefined
          ? 'duplicate native log event'
          : call.kind === 'android-log-reference'
            ? 'native Log method reference'
            : call.kind === 'android-log'
              ? 'unapproved native Log call'
              : call.kind === 'native-stack'
                ? 'raw native stack output'
                : 'raw native stdout/stderr call',
    });
  }
  return { calls: calls.length, findings };
}

/** Reject every native output path except the six exact owned file/tag/message sites. */
export function findUnsafeNativeLogCalls(source, fileName = 'input.kt') {
  return inspectNativeLogCalls(source, fileName).findings;
}

/** Extract the static messages registered through `exact('...')` in the core projector. */
export function findExactProjectorMessages(source, fileName = 'errorDiagnostic.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const messages = new Set();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'exact'
    ) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        messages.add(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return messages;
}

function topLevelVariableInitializer(sourceFile, variableName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) {
        return declaration.initializer && unwrapExpression(declaration.initializer);
      }
    }
  }
  return undefined;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Read the exact finite token registry without executing application code. */
export function findDiagnosticSiteDefinitions(source, fileName = 'errorDiagnostic.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializer = topLevelVariableInitializer(sourceFile, 'ERROR_DIAGNOSTIC_SITES');
  const definitions = new Map();
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return definitions;
  let invalidEntry = 0;
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      definitions.set(`${INVALID_SITE_REGISTRY_ENTRY}:${invalidEntry++}`, undefined);
      continue;
    }
    const name = staticPropertyName(property.name);
    const value = literalText(property.initializer);
    if (name === undefined || value === undefined || definitions.has(name)) {
      definitions.set(`${INVALID_SITE_REGISTRY_ENTRY}:${invalidEntry++}`, undefined);
      continue;
    }
    definitions.set(name, value);
  }
  return definitions;
}

/** Extract each finite projector message and the registry properties allowed to group it. */
export function findProjectorSitePairs(source, fileName = 'errorDiagnostic.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializer = topLevelVariableInitializer(sourceFile, 'EVENT_DEFINITIONS');
  const pairs = new Map();
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return pairs;
  let invalidEvent = 0;
  for (const element of initializer.elements) {
    const definition = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(definition)) {
      pairs.set(`${INVALID_PROJECTOR_EVENT}:${invalidEvent++}`, []);
      continue;
    }
    const propertyNames = definition.properties.map((property) =>
      ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : undefined,
    );
    if (
      propertyNames.length !== PROJECTOR_EVENT_PROPERTIES.size ||
      propertyNames.some((name) => name === undefined || !PROJECTOR_EVENT_PROPERTIES.has(name)) ||
      new Set(propertyNames).size !== propertyNames.length
    ) {
      pairs.set(`${INVALID_PROJECTOR_EVENT}:${invalidEvent++}`, []);
      continue;
    }
    const siteProperty = definition.properties.find(
      (property) => staticPropertyName(property.name) === 'siteTokens',
    );
    const matchesProperty = definition.properties.find(
      (property) => staticPropertyName(property.name) === 'matches',
    );
    const exactMessages = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'exact'
      ) {
        const message = literalText(node.arguments[0]);
        if (message !== undefined) exactMessages.push(message);
      }
      ts.forEachChild(node, visit);
    };
    if (matchesProperty && ts.isPropertyAssignment(matchesProperty)) {
      visit(matchesProperty.initializer);
    }
    if (
      !siteProperty ||
      !ts.isPropertyAssignment(siteProperty) ||
      !matchesProperty ||
      !ts.isPropertyAssignment(matchesProperty) ||
      exactMessages.length === 0
    ) {
      pairs.set(`${INVALID_PROJECTOR_EVENT}:${invalidEvent++}`, []);
      continue;
    }
    const siteInitializer = unwrapExpression(siteProperty.initializer);
    const sites =
      siteInitializer && ts.isArrayLiteralExpression(siteInitializer)
        ? siteInitializer.elements.map(
            (site) => diagnosticSiteProperty(site) ?? INVALID_PROJECTOR_SITE,
          )
        : [INVALID_PROJECTOR_SITE];
    for (const message of exactMessages) {
      const previous = pairs.get(message);
      pairs.set(message, previous ? [...previous, INVALID_PROJECTOR_SITE] : sites);
    }
  }
  return pairs;
}

export function runErrorDiagnosticCheck({ root = process.cwd() } = {}) {
  const errors = [];
  let calls = 0;
  let nativeCalls = 0;
  const seenSites = [];
  const projectorSource = readFileSync(resolve(root, 'src/core/secure/errorDiagnostic.ts'), 'utf8');
  const projectorMessages = findExactProjectorMessages(projectorSource);
  const siteDefinitions = findDiagnosticSiteDefinitions(projectorSource);
  const projectorSitePairs = findProjectorSitePairs(projectorSource);
  for (const [name, expectedValue] of Object.entries(EXPECTED_ERROR_DIAGNOSTIC_SITES)) {
    const actualValue = siteDefinitions.get(name);
    if (actualValue !== expectedValue) {
      errors.push(
        `diagnostic site ${name} must equal ${JSON.stringify(expectedValue)}; found ${JSON.stringify(actualValue)}`,
      );
    }
  }
  for (const name of siteDefinitions.keys()) {
    if (!(name in EXPECTED_ERROR_DIAGNOSTIC_SITES)) {
      errors.push(`unapproved diagnostic site registry property: ${name}`);
    }
  }
  const siteValues = [...siteDefinitions.values()];
  if (new Set(siteValues).size !== siteValues.length) {
    errors.push('diagnostic site registry values must be globally unique');
  }
  for (const value of siteValues) {
    if (!/^s[a-z0-9]{9}$/.test(value)) {
      errors.push(`diagnostic site token has an unsafe format: ${JSON.stringify(value)}`);
    }
  }
  for (const message of ALLOWED_ERROR_MESSAGES) {
    if (!projectorMessages.has(message)) {
      errors.push(`allowed production event is missing from the core projector: ${message}`);
    }
  }
  for (const [message, expectedSites] of EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE) {
    const actualSites = projectorSitePairs.get(message) ?? [];
    if (
      actualSites.length !== expectedSites.length ||
      actualSites.some((site, index) => site !== expectedSites[index])
    ) {
      errors.push(
        `projector event/site mismatch for ${JSON.stringify(message)}: expected ${expectedSites.join(',')}; found ${actualSites.join(',')}`,
      );
    }
  }
  for (const message of projectorSitePairs.keys()) {
    if (!EXPECTED_PROJECTOR_SITE_PROPERTIES_BY_MESSAGE.has(message)) {
      errors.push(`unapproved projector site event: ${JSON.stringify(message)}`);
    }
  }
  const javascriptFiles = ['src', 'app', 'modules'].flatMap((base) =>
    sourceFiles(resolve(root, base)),
  );
  const entry = resolve(root, 'index.js');
  if (existsSync(entry)) javascriptFiles.push(entry);
  for (const file of javascriptFiles) {
    const source = readFileSync(file, 'utf8');
    const inspected = inspectErrorCalls(source, file);
    calls += inspected.calls;
    seenSites.push(...inspected.sites);
    for (const finding of inspected.findings) {
      errors.push(
        `${relative(root, file)}:${finding.line} ${finding.reason}` +
          (finding.message === undefined ? '' : `: ${JSON.stringify(finding.message)}`),
      );
    }
  }
  const siteCounts = new Map();
  for (const site of seenSites) siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
  for (const site of EXPECTED_LOGGER_SITE_TOKENS) {
    const count = siteCounts.get(site) ?? 0;
    if (count !== 1)
      errors.push(`production crash site ${site} must appear exactly once; found ${count}`);
  }
  for (const site of siteCounts.keys()) {
    if (!EXPECTED_LOGGER_SITE_TOKENS.has(site)) {
      errors.push(`unapproved production crash site: ${site}`);
    }
  }
  const nativeRoots = [resolve(root, 'modules')];
  const generatedAndroidRoot = resolve(root, 'android/app/src');
  if (existsSync(generatedAndroidRoot)) nativeRoots.push(generatedAndroidRoot);
  const nativeFiles = [];
  const nativeSymbolicLinks = [];
  for (const nativeRoot of nativeRoots) {
    nativeFiles.push(...nativeSourceFiles(nativeRoot, nativeSymbolicLinks));
  }
  for (const link of nativeSymbolicLinks) {
    errors.push(
      `${normalizedPath(relative(root, link))}: native scan path must not be a symbolic link`,
    );
  }
  const ownedNativeFiles = nativeFiles.filter(
    (file) => normalizedPath(relative(root, file)) === OWNED_NATIVE_LOG_FILE,
  );
  if (ownedNativeFiles.length !== 1) {
    errors.push(
      `owned native source must be encountered exactly once at ${OWNED_NATIVE_LOG_FILE}; found ${ownedNativeFiles.length}`,
    );
  }
  for (const file of nativeFiles) {
    const relativeFile = normalizedPath(relative(root, file));
    const source = readFileSync(file, 'utf8');
    const inspected = inspectNativeLogCalls(source, relativeFile, {
      owned: relativeFile === OWNED_NATIVE_LOG_FILE,
    });
    nativeCalls += inspected.calls;
    for (const finding of inspected.findings) {
      errors.push(
        `${relativeFile}:${finding.line} ${finding.reason}` +
          (finding.message === undefined ? '' : `: ${JSON.stringify(finding.message)}`),
      );
    }
  }
  if (calls === 0) errors.push('no production logger.error calls were found');
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return {
    calls,
    allowedMessages: ALLOWED_ERROR_MESSAGES.size,
    crashSites: EXPECTED_LOGGER_SITE_TOKENS.size,
    nativeCalls,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runErrorDiagnosticCheck();
    console.log(
      `Error-diagnostic guard passed: ${result.calls} production calls; ${result.allowedMessages} error events; ${result.crashSites} opaque crash sites; ${result.nativeCalls} native log events.`,
    );
  } catch (error) {
    console.error(
      `Error-diagnostic guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
