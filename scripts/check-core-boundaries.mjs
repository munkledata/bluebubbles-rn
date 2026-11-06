#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { runHeadlessEntryCheck } from './check-android-build.mjs';

const CORE_DIRECTORY = 'src/core';
const SERVICES_DIRECTORY = 'src/services';
const UI_DB_OWNER_DIRECTORIES = ['app', 'src/ui'];
const PRODUCTION_DIRECTORIES = ['app', 'src'];
const PRODUCTION_ENTRY_FILES = ['index.js'];
const EMBEDDED_WEBVIEW_MODULES = ['react-native-webview', '@expo/dom-webview', 'expo/dom/internal'];
// src/core must run unchanged everywhere the app runs (screens, headless tasks, Node tests), so it
// may import only these packages, its own modules, and these reviewed platform-free utilities.
// Anything else, including React Native, Expo, native drivers and the other app layers, is refused.
// src/utils also holds modules that import the database and app state, so utilities are listed
// one by one instead of allowing the whole @utils alias, and each listed utility file is checked
// with this same allowlist (unicode-segmenter is the pure-JS package @utils/grapheme wraps).
const CORE_ALLOWED_PACKAGES = ['zod', 'ky', 'unicode-segmenter'];
const CORE_ALLOWED_ALIASES = ['@core', '@/core'];
const CORE_ALLOWED_UTILITIES = ['bytes', 'grapheme', 'version'];
const CORE_ALLOWED_UTILITY_MODULES = new Set(
  CORE_ALLOWED_UTILITIES.map((name) => `@utils/${name}`),
);
const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.ts', '.js'];
const RAW_DB_DRIVER_MODULE = '@op-engineering/op-sqlite';
const RAW_DB_DRIVER_HANDLE_TYPES = new Set([
  'DB',
  'Transaction',
  'PreparedStatement',
  '_InternalDB',
  'OPSQLiteProxy',
]);
const REVIEWED_UI_DB_REPOSITORY_VALUES = new Set([
  'DRAFT_KV_PREFIX',
  // Key-prefix constant for a draft's saved reply target, read with kvGet like DRAFT_KV_PREFIX.
  'DRAFT_REPLY_KV_PREFIX',
  'MAX_CUSTOM_FOLDER_MEMBERS',
  'findChatsByParticipantAddresses',
  'getChatHeader',
  // Read-only: each participant's linked device contact id, for chat details' View Contact.
  'getChatParticipantContacts',
  'getChatParticipants',
  'getChatTheme',
  'getScheduledById',
  'getVisibleAttachmentByGuid',
  'kvGet',
  'listAllScheduled',
  'listChatAttachmentsByKind',
  'listChatImageAttachmentsByAttachmentGuid',
  'listCustomThemes',
  'listDeletedChats',
  'listReminders',
  'listScheduledHistory',
  'listThreadMessages',
]);
const REVIEWED_UI_DB_QUERY_VALUES = new Set(
  [...REVIEWED_UI_DB_REPOSITORY_VALUES].filter(
    (value) =>
      value !== 'DRAFT_KV_PREFIX' &&
      value !== 'DRAFT_REPLY_KV_PREFIX' &&
      value !== 'MAX_CUSTOM_FOLDER_MEMBERS',
  ),
);

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function literalText(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function parseSource(source, fileName) {
  const scriptKind = extname(fileName).toLowerCase().includes('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

export function importSpecifiers(source, fileName = 'source.ts') {
  const file = parseSource(source, fileName);
  const specifiers = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const argument = node.arguments[0];
        const specifier = argument ? literalText(argument) : undefined;
        specifiers.push(specifier ?? '<non-literal>');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return specifiers;
}

export function hasUseDomDirective(source, fileName = 'source.ts') {
  const file = parseSource(source, fileName);
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use dom') return true;
  }
  return false;
}

function isEmbeddedWebViewModule(specifier) {
  return EMBEDDED_WEBVIEW_MODULES.some(
    (module) =>
      specifier === module ||
      specifier.startsWith(`${module}/`) ||
      (module === 'expo/dom/internal' && specifier.startsWith(`${module}.`)),
  );
}

function isInside(candidate, directory) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function isAllowedCoreImport({ root, file, specifier }) {
  if (specifier.startsWith('.')) {
    const target = resolve(file, '..', specifier);
    return (
      isInside(target, resolve(root, CORE_DIRECTORY)) ||
      CORE_ALLOWED_UTILITIES.some((name) => target === resolve(root, 'src/utils', name))
    );
  }
  // TypeScript and Jest resolve `@core/../db/database` to src/db/database.ts, so a non-relative
  // path may not contain `.`, `..` or empty segments that could climb out of an allowed root.
  if (
    specifier.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return false;
  }
  if (CORE_ALLOWED_UTILITY_MODULES.has(specifier)) return true;
  return [...CORE_ALLOWED_PACKAGES, ...CORE_ALLOWED_ALIASES].some(
    (allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`),
  );
}

function isUiAlias(specifier) {
  return (
    specifier === '@ui' ||
    specifier.startsWith('@ui/') ||
    specifier === '@/ui' ||
    specifier.startsWith('@/ui/') ||
    specifier === 'src/ui' ||
    specifier.startsWith('src/ui/')
  );
}

function isUiRelativeImport({ root, file, specifier }) {
  if (!specifier.startsWith('.')) return false;
  return isInside(resolve(file, '..', specifier), resolve(root, 'src/ui'));
}

export function validateCoreImports({ root, files }) {
  const errors = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === '<non-literal>') {
        errors.push(`${relative(root, file)} uses a non-literal require/import.`);
      } else if (!isAllowedCoreImport({ root, file, specifier })) {
        errors.push(
          `${relative(root, file)} imports forbidden boundary "${specifier}"; src/core and its reviewed utilities may import only the CORE_ALLOWED_* entries in scripts/check-core-boundaries.mjs.`,
        );
      }
    }
  }

  return errors.sort();
}

export function validateServiceImports({ root, files }) {
  const errors = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === '<non-literal>') {
        errors.push(`${relative(root, file)} uses a non-literal require/import.`);
      } else if (isUiAlias(specifier) || isUiRelativeImport({ root, file, specifier })) {
        errors.push(`${relative(root, file)} imports forbidden UI boundary "${specifier}".`);
      }
    }
  }

  return errors.sort();
}

export function validateEmbeddedWebViewImports({ root, files }) {
  const errors = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (hasUseDomDirective(source, file)) {
      errors.push(
        `${relative(root, file)} declares disabled Expo DOM WebView directive "use dom".`,
      );
    }
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === '<non-literal>') {
        errors.push(
          `${relative(root, file)} uses a non-literal require/import, so the disabled embedded WebView boundary cannot be verified.`,
        );
      } else if (isEmbeddedWebViewModule(specifier)) {
        errors.push(
          `${relative(root, file)} imports disabled embedded WebView boundary "${specifier}".`,
        );
      }
    }
  }

  return errors.sort();
}

function sourceLocation(root, sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relative(root, sourceFile.fileName)}:${line + 1}`;
}

function stripSourceExtension(path) {
  const extension = SOURCE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  return extension ? path.slice(0, -extension.length) : path;
}

function projectCompilerOptions(root) {
  const configPath = resolve(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      root,
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) {
      throw new Error(
        parsed.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
          .join('\n'),
      );
    }
    return { ...parsed.options, moduleSuffixes: ['.android', '.native', ''] };
  }

  return {
    allowJs: true,
    baseUrl: root,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleSuffixes: ['.android', '.native', ''],
    noEmit: true,
    paths: {
      '@/*': ['src/*'],
      '@core': ['src/core/index.ts'],
      '@core/*': ['src/core/*'],
      '@db': ['src/db/schema.ts'],
      '@db/*': ['src/db/*'],
      '@features/*': ['src/features/*'],
      '@native/*': ['src/native/*'],
      '@state/*': ['src/state/*'],
      '@ui': ['src/ui/index.ts'],
      '@ui/*': ['src/ui/*'],
      '@utils': ['src/utils/index.ts'],
      '@utils/*': ['src/utils/*'],
    },
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
}

/** Resolve only the project DB aliases/relative paths needed to enforce the UI command boundary. */
function dbModuleKind({ root, file, specifier }) {
  const dbDirectory = resolve(root, 'src/db');
  let target;
  if (specifier === '@db') target = resolve(dbDirectory, 'schema');
  else if (specifier.startsWith('@db/')) target = resolve(dbDirectory, specifier.slice(4));
  else if (specifier === '@/db' || specifier === 'src/db') target = dbDirectory;
  else if (specifier.startsWith('@/db/')) target = resolve(dbDirectory, specifier.slice(5));
  else if (specifier.startsWith('src/db/')) target = resolve(root, specifier);
  else if (specifier.startsWith('.')) target = resolve(file, '..', specifier);
  else return null;

  if (!isInside(target, dbDirectory)) return null;
  const normalized = stripSourceExtension(target).replace(new RegExp(`\\${sep}index$`), '');
  if (normalized === resolve(dbDirectory, 'database')) return 'database';
  if (normalized === resolve(dbDirectory, 'useReactiveQuery')) return 'reactive-query';
  if (normalized === resolve(dbDirectory, 'repositories')) return 'repositories';
  return 'other-db';
}

function reviewedUiDbValues(moduleKind) {
  if (moduleKind === 'database') return new Set(['getDatabase']);
  if (moduleKind === 'reactive-query') return new Set(['useReactiveQuery']);
  if (moduleKind === 'repositories') return REVIEWED_UI_DB_REPOSITORY_VALUES;
  return new Set();
}

function isRawDbDriver(specifier) {
  return specifier === RAW_DB_DRIVER_MODULE;
}

function createsRuntimeImport(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  if (ts.isNamespaceImport(importClause.namedBindings)) return true;
  return (
    !importClause.namedBindings ||
    importClause.namedBindings.elements.length === 0 ||
    importClause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function createsRuntimeExport(exportDeclaration) {
  if (exportDeclaration.isTypeOnly) return false;
  if (!exportDeclaration.exportClause) return true;
  if (!ts.isNamedExports(exportDeclaration.exportClause)) return true;
  return (
    exportDeclaration.exportClause.elements.length === 0 ||
    exportDeclaration.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function symbolVariants(checker, node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return [];
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return [symbol];
  const target = checker.getAliasedSymbol(symbol);
  return target && target.name !== 'unknown' ? [symbol, target] : [symbol];
}

function callTargetsSymbol(call, checker, symbols) {
  return (
    ts.isIdentifier(call.expression) &&
    symbolVariants(checker, call.expression).some((symbol) => symbols.has(symbol))
  );
}

function isDirectReviewedQueryArgument(node, checker, querySymbols) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === node) &&
    callTargetsSymbol(parent, checker, querySymbols)
  );
}

/**
 * UI may observe the database through a small reviewed query surface, but it may not own commands.
 * Keeping the allowlist here makes a new runtime DB dependency fail until its read-only role is
 * reviewed. DB handles have an even smaller grammar: direct query argument or a local alias used
 * only as direct query arguments. That rejects raw driver calls and unreviewable handle facades.
 */
export function validateUiDbCommands({ root, files }) {
  const resolvedFiles = files.map((file) => resolve(file));
  const program = ts.createProgram({
    rootNames: resolvedFiles,
    options: projectCompilerOptions(root),
  });
  const checker = program.getTypeChecker();
  const sourceFileByPath = new Map(
    resolvedFiles.map((file) => {
      const sourceFile = program.getSourceFile(file);
      if (!sourceFile) throw new Error(`TypeScript did not load architecture source ${file}`);
      return [file, sourceFile];
    }),
  );
  const errors = [];
  const getDatabaseSymbols = new Set();
  const querySymbols = new Set();

  for (const [file, sourceFile] of sourceFileByPath) {
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const moduleKind = dbModuleKind({ root, file, specifier: statement.moduleSpecifier.text });
        const rawDriver = isRawDbDriver(statement.moduleSpecifier.text);
        if ((!moduleKind && !rawDriver) || !createsRuntimeImport(statement.importClause)) continue;
        const clause = statement.importClause;
        const location = sourceLocation(root, sourceFile, statement);
        if (rawDriver) {
          errors.push(`${location} imports the raw native DB driver.`);
          continue;
        }
        if (
          !clause ||
          clause.name ||
          !clause.namedBindings ||
          ts.isNamespaceImport(clause.namedBindings) ||
          clause.namedBindings.elements.length === 0
        ) {
          errors.push(`${location} uses an unreviewed runtime DB import.`);
          continue;
        }

        const reviewedValues = reviewedUiDbValues(moduleKind);
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          if (!reviewedValues.has(importedName)) {
            errors.push(`${location} imports unreviewed runtime DB value "${importedName}".`);
            continue;
          }
          const symbol = checker.getSymbolAtLocation(element.name);
          if (!symbol) {
            errors.push(`${location} cannot resolve reviewed DB binding "${element.name.text}".`);
            continue;
          }
          if (moduleKind === 'database' && importedName === 'getDatabase') {
            for (const variant of symbolVariants(checker, element.name)) {
              getDatabaseSymbols.add(variant);
            }
          } else if (
            moduleKind === 'repositories' &&
            REVIEWED_UI_DB_QUERY_VALUES.has(importedName)
          ) {
            for (const variant of symbolVariants(checker, element.name)) {
              querySymbols.add(variant);
            }
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLike(statement.moduleReference.expression) &&
        (dbModuleKind({
          root,
          file,
          specifier: statement.moduleReference.expression.text,
        }) ||
          isRawDbDriver(statement.moduleReference.expression.text))
      ) {
        errors.push(
          `${sourceLocation(root, sourceFile, statement)} uses an unreviewed runtime DB import.`,
        );
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        createsRuntimeExport(statement) &&
        (dbModuleKind({ root, file, specifier: statement.moduleSpecifier.text }) ||
          isRawDbDriver(statement.moduleSpecifier.text))
      ) {
        errors.push(
          `${sourceLocation(root, sourceFile, statement)} re-exports a runtime DB value.`,
        );
      }
    }

    function inspectLoader(node) {
      if (ts.isCallExpression(node)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteralLike(argument)) {
            errors.push(
              `${sourceLocation(root, sourceFile, node)} uses a non-literal runtime loader that cannot prove the UI DB boundary.`,
            );
          } else if (
            dbModuleKind({ root, file, specifier: argument.text }) ||
            isRawDbDriver(argument.text)
          ) {
            errors.push(
              `${sourceLocation(root, sourceFile, node)} loads a DB module outside the reviewed static read surface.`,
            );
          }
        }
      }
      ts.forEachChild(node, inspectLoader);
    }
    inspectLoader(sourceFile);
  }

  const dbAliasDeclarations = new Map();
  for (const sourceFile of sourceFileByPath.values()) {
    function collectAliases(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        callTargetsSymbol(node.initializer, checker, getDatabaseSymbols)
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) dbAliasDeclarations.set(symbol, node.name);
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(sourceFile);
  }

  function containsDbHandle(type, seen = new Set()) {
    if (seen.has(type)) return false;
    seen.add(type);
    const appDatabasePath = resolve(root, 'src/db/types');
    const appDatabaseDeclaration = [
      ...(type.aliasSymbol?.declarations ?? []),
      ...(type.symbol?.declarations ?? []),
    ].some(
      (declaration) =>
        stripSourceExtension(resolve(declaration.getSourceFile().fileName)) === appDatabasePath,
    );
    const drizzleDeclaration = type.symbol?.declarations?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .includes('/node_modules/drizzle-orm/sqlite-core/'),
    );
    const rawDriverDeclaration = [
      ...(type.aliasSymbol?.declarations ?? []),
      ...(type.symbol?.declarations ?? []),
    ].some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .includes('/node_modules/@op-engineering/op-sqlite/'),
    );
    const rawDriverTypeName = type.aliasSymbol?.name ?? type.symbol?.name;
    if (
      (type.aliasSymbol?.name === 'AppDatabase' && appDatabaseDeclaration) ||
      (type.symbol?.name === 'AppDatabase' && appDatabaseDeclaration) ||
      (type.symbol?.name === 'BaseSQLiteDatabase' && drizzleDeclaration) ||
      (rawDriverDeclaration &&
        rawDriverTypeName !== undefined &&
        RAW_DB_DRIVER_HANDLE_TYPES.has(rawDriverTypeName))
    ) {
      return true;
    }
    if (type.isUnionOrIntersection()) {
      return type.types.some((member) => containsDbHandle(member, seen));
    }
    if (type.flags & ts.TypeFlags.Object) {
      const typeArguments = checker.getTypeArguments(type);
      if (typeArguments.some((argument) => containsDbHandle(argument, seen))) return true;
      return (type.getBaseTypes?.() ?? []).some((base) => containsDbHandle(base, seen));
    }
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && containsDbHandle(constraint, seen)) return true;
    return false;
  }

  for (const sourceFile of sourceFileByPath.values()) {
    function validateHandleFlow(node) {
      if (
        ts.isCallExpression(node) &&
        callTargetsSymbol(node, checker, getDatabaseSymbols) &&
        !isDirectReviewedQueryArgument(node, checker, querySymbols)
      ) {
        const declaration = node.parent;
        const isReviewedAlias =
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer === node &&
          dbAliasDeclarations.has(checker.getSymbolAtLocation(declaration.name));
        if (!isReviewedAlias) {
          errors.push(
            `${sourceLocation(root, sourceFile, node)} uses getDatabase() outside a reviewed query argument.`,
          );
        }
      } else if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        containsDbHandle(checker.getTypeAtLocation(node)) &&
        !isDirectReviewedQueryArgument(node, checker, querySymbols)
      ) {
        errors.push(
          `${sourceLocation(root, sourceFile, node)} lets a database handle escape the reviewed query surface.`,
        );
      } else if (
        ts.isCallExpression(node) &&
        !callTargetsSymbol(node, checker, getDatabaseSymbols) &&
        containsDbHandle(checker.getTypeAtLocation(node))
      ) {
        errors.push(
          `${sourceLocation(root, sourceFile, node)} acquires a database handle outside the reviewed DB read surface.`,
        );
      } else if (ts.isIdentifier(node)) {
        const symbols = symbolVariants(checker, node);
        const symbol = symbols[0];
        if (symbols.some((candidate) => getDatabaseSymbols.has(candidate))) {
          const isImportBinding = ts.isImportSpecifier(node.parent) && node.parent.name === node;
          const isCallTarget = ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (!isImportBinding && !isCallTarget) {
            errors.push(
              `${sourceLocation(root, sourceFile, node)} lets the getDatabase binding escape.`,
            );
          }
        } else if (dbAliasDeclarations.has(symbol) && dbAliasDeclarations.get(symbol) !== node) {
          if (!isDirectReviewedQueryArgument(node, checker, querySymbols)) {
            errors.push(
              `${sourceLocation(root, sourceFile, node)} lets a database handle escape the reviewed query surface.`,
            );
          }
        } else if (
          !ts.isPartOfTypeNode(node) &&
          !ts.isDeclarationName(node) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          containsDbHandle(checker.getTypeAtLocation(node)) &&
          !isDirectReviewedQueryArgument(node, checker, querySymbols)
        ) {
          errors.push(
            `${sourceLocation(root, sourceFile, node)} lets a database handle escape the reviewed query surface.`,
          );
        }
      }
      ts.forEachChild(node, validateHandleFlow);
    }
    validateHandleFlow(sourceFile);
  }

  return [...new Set(errors)].sort();
}

function synchronousRuntimeSpecifiers(source, fileName) {
  const scriptKind = extname(fileName).toLowerCase().includes('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const specifiers = [];
  const errors = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (createsRuntimeImport(node.importClause)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (createsRuntimeExport(node)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteralLike(argument)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        errors.push(`${fileName}:${line + 1} uses a non-literal synchronous require.`);
      } else {
        specifiers.push(argument.text);
      }
    }
    // import() is deliberately not an edge: it is an asynchronous module boundary, not a
    // synchronous evaluation dependency. Its literal/non-literal bundling contract is enforced by
    // the relevant layer guard instead.
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { errors, specifiers };
}

function isLocalSourceSpecifier(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('@/') ||
    specifier === 'src' ||
    specifier.startsWith('src/')
  ) {
    const extension = extname(specifier);
    return extension === '' || SOURCE_EXTENSIONS.includes(extension);
  }
  return ['@core', '@db', '@ui', '@utils', '@state', '@features', '@native'].some(
    (alias) => specifier === alias || specifier.startsWith(`${alias}/`),
  );
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const components = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      components.push(component);
    }
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }
  return components;
}

function representativeCycle(component, graph) {
  const members = new Set(component);

  function search(start, node, path, visiting) {
    for (const target of graph.get(node) ?? []) {
      if (!members.has(target)) continue;
      if (target === start) return [...path, start];
      if (visiting.has(target)) continue;
      visiting.add(target);
      const found = search(start, target, [...path, target], visiting);
      visiting.delete(target);
      if (found) return found;
    }
    return null;
  }

  for (const start of [...component].sort()) {
    const found = search(start, start, [start], new Set([start]));
    if (found) return found;
  }
  return [...component, component[0]];
}

/** Check only synchronous runtime evaluation edges; erased types and async import() are non-edges. */
export function validateSynchronousRuntimeCycles({ root, files }) {
  const resolvedFiles = files.map((file) => resolve(file));
  const fileSet = new Set(resolvedFiles);
  const graph = new Map(resolvedFiles.map((file) => [file, []]));
  const errors = [];
  const compilerOptions = projectCompilerOptions(root);
  const resolutionHost = {
    ...ts.sys,
    fileExists: (file) => fileSet.has(resolve(file)) || ts.sys.fileExists(file),
  };

  for (const file of resolvedFiles) {
    const dependencies = synchronousRuntimeSpecifiers(readFileSync(file, 'utf8'), file);
    const rootPrefix = `${resolve(root)}${sep}`;
    errors.push(
      ...dependencies.errors.map((error) =>
        error.startsWith(rootPrefix) ? error.slice(rootPrefix.length) : error,
      ),
    );
    for (const specifier of dependencies.specifiers) {
      const resolvedModule = ts.resolveModuleName(
        specifier,
        file,
        compilerOptions,
        resolutionHost,
      ).resolvedModule;
      const resolvedTarget = resolvedModule ? resolve(resolvedModule.resolvedFileName) : null;
      const target = resolvedTarget && fileSet.has(resolvedTarget) ? resolvedTarget : null;
      if (target) graph.get(file).push(target);
      else if (isLocalSourceSpecifier(specifier)) {
        errors.push(
          `${relative(root, file)} cannot resolve local runtime dependency "${specifier}".`,
        );
      }
    }
    graph.set(file, [...new Set(graph.get(file))].sort());
  }

  for (const component of stronglyConnectedComponents(graph)) {
    const cycle = representativeCycle(component, graph).map((file) => relative(root, file));
    errors.push(`synchronous runtime dependency cycle: ${cycle.join(' -> ')}`);
  }

  return { edges: [...graph.values()].reduce((count, edges) => count + edges.length, 0), errors };
}

export function runCoreBoundaryCheck({ root = process.cwd() } = {}) {
  const files = [
    ...sourceFiles(resolve(root, CORE_DIRECTORY)),
    ...CORE_ALLOWED_UTILITIES.map((name) => resolve(root, 'src/utils', `${name}.ts`)).filter(
      (file) => existsSync(file),
    ),
  ];
  const errors = validateCoreImports({ root, files });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { files: files.length };
}

export function runServiceBoundaryCheck({ root = process.cwd() } = {}) {
  const services = resolve(root, SERVICES_DIRECTORY);
  const files = sourceFiles(services);
  const errors = validateServiceImports({ root, files });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { files: files.length };
}

export function runUiDbCommandBoundaryCheck({ root = process.cwd() } = {}) {
  const files = UI_DB_OWNER_DIRECTORIES.flatMap((directory) =>
    sourceFiles(resolve(root, directory)),
  );
  const errors = validateUiDbCommands({ root, files });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { files: files.length };
}

export function runSynchronousRuntimeCycleCheck({ root = process.cwd() } = {}) {
  const files = PRODUCTION_DIRECTORIES.flatMap((directory) =>
    sourceFiles(resolve(root, directory)),
  );
  const result = validateSynchronousRuntimeCycles({ root, files });
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => `- ${error}`).join('\n'));
  }
  return { edges: result.edges, files: files.length };
}

export function runEmbeddedWebViewBoundaryCheck({ root = process.cwd() } = {}) {
  const files = [
    ...PRODUCTION_DIRECTORIES.flatMap((directory) => sourceFiles(resolve(root, directory))),
    ...PRODUCTION_ENTRY_FILES.map((file) => resolve(root, file)).filter(existsSync),
  ];
  const errors = validateEmbeddedWebViewImports({ root, files });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { files: files.length };
}

const DB_HANDLE_ESCAPE_OWNERS = new Set([
  'withDbTransaction',
  'withDbWriteLock',
  'runInTransactionContext',
]);
// `REPLACE(` is also SQLite's string function, so only `REPLACE INTO` counts as a write.
const DB_HANDLE_ESCAPE_WRITE_SQL =
  /^\s*(?:(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX)\b|REPLACE\s+INTO\b)/i;
const DB_HANDLE_ESCAPE_RULES = {
  rawDriverImport: {
    specifiers: new Set([
      '@op-engineering/op-sqlite',
      'drizzle-orm/op-sqlite',
      'drizzle-orm/better-sqlite3',
    ]),
    allowed: new Set(['src/db/database.ts', 'src/db/key.ts']),
  },
  rawHandleCall: {
    allowed: new Set([
      'src/db/database.ts',
      'src/db/useReactiveQuery.ts',
      'src/services/databaseControl.ts',
    ]),
  },
  databaseFileName: {
    literal: 'gator.db',
    allowed: new Set(['src/db/database.ts', 'src/db/key.ts']),
  },
  writeHandleAssertion: { allowed: new Set(['src/db/transaction.ts', 'src/db/database.ts']) },
  rawWriteSql: {
    // transaction.ts is the owner implementation itself (BEGIN/COMMIT/ROLLBACK).
    allowed: new Set([
      'src/db/migrations.ts',
      'src/db/migrate.ts',
      'src/db/database.ts',
      'src/db/transaction.ts',
    ]),
    allowedPrefixes: ['src/db/devHarness/', 'src/db/performance/', 'src/services/boot/db'],
  },
};

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * The write-capable database handle must not escape its owners (src/db/types.ts). The ReadDb/WriteDb
 * split makes the common case a compile error; these rules close what types cannot see: raw driver
 * imports, the raw op-sqlite handle, the production file name, assertions that mint a WriteDb, and a
 * raw write statement issued outside an owner callback (a ReadDb still has `all()`).
 */
export function validateDbHandleEscape({ root, files }) {
  const errors = [];
  const inTests = (path) => path.startsWith('test/');
  for (const file of files) {
    const path = relative(root, file).split(sep).join('/');
    if (inTests(path)) continue;
    const sourceFile = parseSource(readFileSync(file, 'utf8'), file);
    const report = (node, message) =>
      errors.push(`${sourceLocation(root, sourceFile, node)} ${message}`);
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (
          DB_HANDLE_ESCAPE_RULES.rawDriverImport.specifiers.has(specifier) &&
          createsRuntimeImport(node.importClause) &&
          !DB_HANDLE_ESCAPE_RULES.rawDriverImport.allowed.has(path)
        ) {
          report(
            node,
            `imports the raw database driver ${specifier}; only src/db/database.ts and src/db/key.ts may`,
          );
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isImportKeyword(node.expression) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        DB_HANDLE_ESCAPE_RULES.rawDriverImport.specifiers.has(node.arguments[0].text) &&
        !DB_HANDLE_ESCAPE_RULES.rawDriverImport.allowed.has(path)
      ) {
        report(
          node,
          `loads the raw database driver ${node.arguments[0].text}; only src/db/database.ts and src/db/key.ts may`,
        );
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'getRawDatabase' &&
        !DB_HANDLE_ESCAPE_RULES.rawHandleCall.allowed.has(path)
      ) {
        report(
          node,
          'calls getRawDatabase(); the raw handle stays inside src/db and databaseControl',
        );
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === DB_HANDLE_ESCAPE_RULES.databaseFileName.literal &&
        !DB_HANDLE_ESCAPE_RULES.databaseFileName.allowed.has(path)
      ) {
        report(
          node,
          "names the production database file 'gator.db'; only src/db/database.ts and src/db/key.ts may",
        );
      }
      if (
        ts.isAsExpression(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ['WriteDb', 'TestDb'].includes(node.type.typeName.getText(sourceFile)) &&
        !DB_HANDLE_ESCAPE_RULES.writeHandleAssertion.allowed.has(path)
      ) {
        report(
          node,
          `asserts a ${node.type.typeName.getText(sourceFile)}; only withDbTransaction and the database module mint write handles`,
        );
      }
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isIdentifier(node.tag) &&
        node.tag.text === 'sql' &&
        !DB_HANDLE_ESCAPE_RULES.rawWriteSql.allowed.has(path) &&
        !DB_HANDLE_ESCAPE_RULES.rawWriteSql.allowedPrefixes.some((prefix) =>
          path.startsWith(prefix),
        )
      ) {
        const head = ts.isNoSubstitutionTemplateLiteral(node.template)
          ? node.template.text
          : node.template.head.text;
        if (DB_HANDLE_ESCAPE_WRITE_SQL.test(head) && !rawWriteIsOwned(node, sourceFile)) {
          report(
            node,
            'issues a raw write statement outside a transaction or write-lock owner and outside a WriteDb-typed function',
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return errors.sort();
}

/** A raw write is owned when it sits inside an owner callback or inside a function that holds a WriteDb. */
function rawWriteIsOwned(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      DB_HANDLE_ESCAPE_OWNERS.has(current.expression.text)
    ) {
      return true;
    }
    if (
      isFunctionLike(current) &&
      current.parameters.some(
        (parameter) =>
          parameter.type && ['WriteDb', 'TestDb'].includes(parameter.type.getText(sourceFile)),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function runDbHandleEscapeBoundaryCheck({ root = process.cwd() } = {}) {
  const files = [...sourceFiles(resolve(root, 'src')), ...sourceFiles(resolve(root, 'app'))];
  const errors = validateDbHandleEscape({ root, files });
  if (errors.length > 0) {
    throw new Error(
      `Database handle escape violations:\n${errors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  return { files: files.length };
}

// ---------------------------------------------------------------------------------------------
// Owned native modules must not touch SQLite (scanner triage E2, 2026-11-06). A Kotlin/Swift module
// opening the database behind the JS owner would bypass SQLCipher key custody and the write lock.
// This used to be the DB-write scanner's `<native>` finding, which could never be approved.
// ---------------------------------------------------------------------------------------------
const NATIVE_SOURCE_PATTERN = /\.(kt|java|swift|m|mm)$/;
export const NATIVE_SQLITE_MARKERS = [
  { pattern: /android\.database\.sqlite/, label: 'android.database.sqlite' },
  { pattern: /\bSQLiteDatabase\b/, label: 'SQLiteDatabase' },
  { pattern: /\bSQLiteOpenHelper\b/, label: 'SQLiteOpenHelper' },
  { pattern: /\bexecSQL\s*\(/, label: 'execSQL(' },
  { pattern: /\bsqlite3_[a-z_]+\s*\(/, label: 'sqlite3_*(' },
  { pattern: /\bFMDatabase\b/, label: 'FMDatabase' },
];

function nativeSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'build' ? [] : nativeSourceFiles(path);
    return NATIVE_SOURCE_PATTERN.test(entry.name) ? [path] : [];
  });
}

export function validateNativeSqliteMarkers({ root, files }) {
  const errors = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const { pattern, label } of NATIVE_SQLITE_MARKERS) {
          if (pattern.test(line)) {
            errors.push(
              `${relative(root, file)}:${index + 1} uses ${label}; an owned native module must not open the database (SQLCipher key custody and the write lock live in the JS owner)`,
            );
          }
        }
      });
  }
  return errors;
}

export function runNativeSqliteBoundaryCheck({ root = process.cwd() } = {}) {
  const files = nativeSourceFiles(resolve(root, 'modules'));
  const errors = validateNativeSqliteMarkers({ root, files });
  if (errors.length > 0) {
    throw new Error(
      `Native SQLite access in owned modules:\n${errors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  return { files: files.length };
}

// ---------------------------------------------------------------------------------------------
// Headless wake budgets must nest (scanner triage A5, 2026-11-06). Android gives a killed-app push
// or background wake roughly a minute; the windows below are the only statement of how the effect
// tail, the delivery/work window, finalization, the admission budget and the key-rotation overlap
// relate. The constants are read from source so the modules' native imports need no mocks.
// ---------------------------------------------------------------------------------------------
export const HEADLESS_BUDGET_SOURCES = [
  'src/services/background/realtimeHeadlessEffects.ts',
  'src/services/background/backgroundSync.ts',
  'src/services/background/realtimePrerequisiteRecovery.ts',
  'src/services/notifications/fcmMessaging.ts',
  'src/core/realtime/fcmEncryption.ts',
];
const RNFB_HEADLESS_TASK_MS = 60_000;
const SAMSUNG_WORKER_TIMEOUT_MS = 75_000;
const SERVER_PREVIOUS_KEY_OVERLAP_MS = 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000;
const ROTATION_OVERLAP_SLACK_MS = 5 * 60 * 1_000;
export const HEADLESS_BUDGET_RULES = [
  {
    rule: 'REALTIME_HEADLESS_EFFECT_WINDOW_MS + REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS <= FCM_HEADLESS_DELIVERY_WINDOW_MS',
    why: 'an effect must run and be cancelled inside the push delivery window',
    holds: (c) =>
      c.REALTIME_HEADLESS_EFFECT_WINDOW_MS + c.REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS <=
      c.FCM_HEADLESS_DELIVERY_WINDOW_MS,
  },
  {
    rule: 'REALTIME_HEADLESS_EFFECT_WINDOW_MS + REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS <= BACKGROUND_CALLBACK_WORK_WINDOW_MS',
    why: 'the same effect tail runs inside a background callback',
    holds: (c) =>
      c.REALTIME_HEADLESS_EFFECT_WINDOW_MS + c.REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS <=
      c.BACKGROUND_CALLBACK_WORK_WINDOW_MS,
  },
  {
    rule: 'FCM_HEADLESS_DELIVERY_WINDOW_MS < FCM_HEADLESS_FINALIZATION_WINDOW_MS < 60_000',
    why: "delivery stops before final logging, and both before RNFB's 60-second Android task ends",
    holds: (c) =>
      c.FCM_HEADLESS_DELIVERY_WINDOW_MS < c.FCM_HEADLESS_FINALIZATION_WINDOW_MS &&
      c.FCM_HEADLESS_FINALIZATION_WINDOW_MS < RNFB_HEADLESS_TASK_MS,
  },
  {
    rule: 'BACKGROUND_WAKE_ADMISSION_BUDGET_MS < BACKGROUND_CALLBACK_WORK_WINDOW_MS',
    why: "the orchestrator's own budget must fire while the callback is alive (review M187)",
    holds: (c) => c.BACKGROUND_WAKE_ADMISSION_BUDGET_MS < c.BACKGROUND_CALLBACK_WORK_WINDOW_MS,
  },
  {
    rule: 'BACKGROUND_CALLBACK_WORK_WINDOW_MS < BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS < 75_000',
    why: "work stops before cleanup, and both before Samsung's observed 75-second worker timeout",
    holds: (c) =>
      c.BACKGROUND_CALLBACK_WORK_WINDOW_MS < c.BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS &&
      c.BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS < SAMSUNG_WORKER_TIMEOUT_MS,
  },
  {
    rule: 'REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS <= REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS',
    why: 'a single chat recovery is a slice of the whole prerequisite recovery budget',
    holds: (c) =>
      c.REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS <= c.REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS,
  },
  {
    rule: 'FCM_ROTATION_TIMER_MAX_DELAY_MS <= FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS',
    why: 'the rotation check must fire before the previous key is retired locally',
    holds: (c) => c.FCM_ROTATION_TIMER_MAX_DELAY_MS <= c.FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS,
  },
  {
    rule: '24h05m <= FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS <= 24h10m < FCM_PUSH_KEY_ROTATION_INTERVAL_MS',
    why: "the local cap covers the server's 24h05 previous-key overlap plus five minutes of slack",
    holds: (c) =>
      c.FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS >= SERVER_PREVIOUS_KEY_OVERLAP_MS &&
      c.FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS <=
        SERVER_PREVIOUS_KEY_OVERLAP_MS + ROTATION_OVERLAP_SLACK_MS &&
      c.FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS < c.FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
  },
];

/** Top-level `const NAME = <number expression>` values of one module, exported or not. */
export function readNumericConstants(source, fileName = 'source.ts') {
  const sourceFile = parseSource(source, fileName);
  const values = new Map();
  const evaluate = (node) => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return evaluate(node.expression);
    if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const operand = evaluate(node.operand);
      return operand === undefined ? undefined : -operand;
    }
    if (ts.isIdentifier(node)) return values.get(node.text);
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (left === undefined || right === undefined) return undefined;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return left + right;
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return left / right;
        default:
          return undefined;
      }
    }
    return undefined;
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = evaluate(declaration.initializer);
      if (typeof value === 'number' && Number.isFinite(value))
        values.set(declaration.name.text, value);
    }
  }
  return values;
}

export function validateHeadlessBudgets({ root }) {
  const constants = {};
  const errors = [];
  for (const relativePath of HEADLESS_BUDGET_SOURCES) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) {
      errors.push(
        `${relativePath} is missing; update HEADLESS_BUDGET_SOURCES if the constants moved`,
      );
      continue;
    }
    for (const [name, value] of readNumericConstants(readFileSync(path, 'utf8'), path)) {
      if (name in constants && constants[name] !== value) {
        errors.push(`${name} is defined with different values in two budget sources`);
      }
      constants[name] = value;
    }
  }
  for (const { rule, why, holds } of HEADLESS_BUDGET_RULES) {
    const names = rule.match(/\b[A-Z][A-Z0-9_]+_MS\b/g) ?? [];
    const missing = names.filter((name) => !(name in constants));
    if (missing.length > 0) {
      errors.push(
        `${missing.join(', ')} not found as a numeric constant in the budget sources; if renamed, update HEADLESS_BUDGET_RULES`,
      );
      continue;
    }
    if (!holds(constants)) {
      const actual = names.map((name) => `${name}=${constants[name]}`).join(', ');
      errors.push(`headless budget rule broken: ${rule} (${why}); ${actual}`);
    }
  }
  return { errors, constants: Object.keys(constants).length };
}

export function runHeadlessBudgetCheck({ root = process.cwd() } = {}) {
  const { errors, constants } = validateHeadlessBudgets({ root });
  if (errors.length > 0) {
    throw new Error(`Headless budget violations:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return { rules: HEADLESS_BUDGET_RULES.length, constants };
}

export function runArchitectureBoundaryCheck({ root = process.cwd() } = {}) {
  return {
    core: runCoreBoundaryCheck({ root }),
    services: runServiceBoundaryCheck({ root }),
    uiDb: runUiDbCommandBoundaryCheck({ root }),
    cycles: runSynchronousRuntimeCycleCheck({ root }),
    embeddedWebView: runEmbeddedWebViewBoundaryCheck({ root }),
    dbHandleEscape: runDbHandleEscapeBoundaryCheck({ root }),
    nativeSqlite: runNativeSqliteBoundaryCheck({ root }),
    headlessBudgets: runHeadlessBudgetCheck({ root }),
    headlessEntry: runHeadlessEntryCheck({ root }),
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runArchitectureBoundaryCheck();
    console.log(
      `Architecture boundary guard passed: ${result.core.files} core files, ${result.services.files} UI-free service files, ${result.uiDb.files} UI/app files with read-only DB ownership, ${result.cycles.files} production files / ${result.cycles.edges} synchronous runtime edges without cycles, ${result.embeddedWebView.files} production files without embedded WebView imports, ${result.dbHandleEscape.files} production files without a database handle escape, and ${result.headlessEntry.imports} ordered entry imports.`,
    );
  } catch (error) {
    console.error(
      `Architecture boundary guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
