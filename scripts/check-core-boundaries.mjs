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
const FORBIDDEN_SOURCE_DIRECTORIES = ['db', 'features', 'native', 'services', 'state', 'ui'];
const FORBIDDEN_ALIASES = ['@db', '@features', '@native', '@services', '@state', '@ui'];
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
  'MAX_CUSTOM_FOLDER_MEMBERS',
  'findChatByParticipantAddresses',
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
    (value) => value !== 'DRAFT_KV_PREFIX' && value !== 'MAX_CUSTOM_FOLDER_MEMBERS',
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

export function importSpecifiers(source, fileName = 'source.ts') {
  const scriptKind = extname(fileName).toLowerCase().includes('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
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

function isForbiddenPackage(specifier) {
  return (
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-native' ||
    specifier.startsWith('react-native/') ||
    specifier === 'zustand' ||
    specifier.startsWith('zustand/') ||
    specifier === 'expo' ||
    specifier.startsWith('expo/') ||
    specifier.startsWith('expo-') ||
    specifier.startsWith('@expo/')
  );
}

function isForbiddenAlias(specifier) {
  return (
    FORBIDDEN_ALIASES.some((alias) => specifier === alias || specifier.startsWith(`${alias}/`)) ||
    FORBIDDEN_SOURCE_DIRECTORIES.some(
      (directory) => specifier === `@/${directory}` || specifier.startsWith(`@/${directory}/`),
    )
  );
}

function isInside(candidate, directory) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function isForbiddenRelativeImport({ root, file, specifier }) {
  if (!specifier.startsWith('.')) return false;
  const target = resolve(file, '..', specifier);
  return FORBIDDEN_SOURCE_DIRECTORIES.some((directory) =>
    isInside(target, resolve(root, 'src', directory)),
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
      } else if (
        isForbiddenPackage(specifier) ||
        isForbiddenAlias(specifier) ||
        isForbiddenRelativeImport({ root, file, specifier })
      ) {
        errors.push(`${relative(root, file)} imports forbidden boundary "${specifier}".`);
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
  const core = resolve(root, CORE_DIRECTORY);
  const files = sourceFiles(core);
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

export function runArchitectureBoundaryCheck({ root = process.cwd() } = {}) {
  return {
    core: runCoreBoundaryCheck({ root }),
    services: runServiceBoundaryCheck({ root }),
    uiDb: runUiDbCommandBoundaryCheck({ root }),
    cycles: runSynchronousRuntimeCycleCheck({ root }),
    headlessEntry: runHeadlessEntryCheck({ root }),
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runArchitectureBoundaryCheck();
    console.log(
      `Architecture boundary guard passed: ${result.core.files} core files, ${result.services.files} UI-free service files, ${result.uiDb.files} UI/app files with read-only DB ownership, ${result.cycles.files} production files / ${result.cycles.edges} synchronous runtime edges without cycles, and ${result.headlessEntry.imports} ordered entry imports.`,
    );
  } catch (error) {
    console.error(
      `Architecture boundary guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
