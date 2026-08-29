#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const SOURCE_DIRECTORIES = ['src', 'app', 'modules'];
const INVENTORY_PATH = 'scripts/db-write-inventory.json';
const BUILDER_METHODS = new Set(['insert', 'update', 'delete']);
const RAW_METHODS = new Set([
  'all',
  'allAsync',
  'exec',
  'execAsync',
  'execute',
  'executeAsync',
  'executeRaw',
  'executeRawAsync',
  'executeSync',
  'get',
  'getAsync',
  'run',
  'runAsync',
]);
const DYNAMIC_RAW_METHODS = new Set([
  'execAsync',
  'execute',
  'executeAsync',
  'executeRaw',
  'executeRawAsync',
  'executeSync',
  'runAsync',
]);
const SAFE_DATABASE_METHODS = new Set([
  'all',
  'allAsync',
  'close',
  'flushPendingReactiveQueries',
  'get',
  'getAsync',
  'query',
  'reactiveExecute',
  'select',
]);
export const DB_WRITE_DISPOSITIONS = ['coordinated', 'proven-temporal-exclusion', 'unproven'];
const COORDINATED_CONTEXTS = new Set([
  'account-transition-delegation',
  'coordinated-delegation',
  'error-report-lifecycle-delegation',
  'foreground-boot-lifecycle-delegation',
  'incoming-ingress-delegation',
  'notification-effect-lifecycle-delegation',
  'runtime-drizzle-adapter',
  'transaction-coordinator',
  'withDbTransaction',
  'withDbWriteLock',
]);
const DIRECT_COORDINATED_CONTEXTS = new Set([
  'transaction-coordinator',
  'withDbTransaction',
  'withDbWriteLock',
]);
/**
 * Exact reviewed orchestration surfaces whose unresolved call edges may use the whole-program
 * delegation proof below. This is only an eligibility boundary: an unsafe or dynamic target stays
 * unresolved, and callers in composition roots remain unresolved even when they target these files.
 */
const COORDINATED_DELEGATION_PATHS = new Set([
  'app/(app)/_layout.tsx',
  'app/(app)/chat/[guid].tsx',
  'app/(app)/chat-settings/[guid].tsx',
  'app/(app)/home.tsx',
  'app/(app)/new-chat.tsx',
  'app/(app)/scheduled.tsx',
  'app/(app)/settings.tsx',
  'app/(setup)/manual.tsx',
  'app/(setup)/permissions.tsx',
  'app/(setup)/scan.tsx',
  'app/(setup)/welcome.tsx',
  'src/db/repositories/chats.ts',
  'src/db/repositories/errorReports.ts',
  'src/db/repositories/maintenance.ts',
  'src/db/repositories/outgoing.ts',
  'src/features/conversations/devFixtureSession.ts',
  'src/features/facetime/useFaceTime.ts',
  'src/services/backup/backup.ts',
  'src/services/backup/backupService.ts',
  'src/services/boot/foregroundBoot.ts',
  'src/services/bootstrap.ts',
  'src/services/chat/groupManagement.ts',
  'src/services/contacts/serverAvatars.ts',
  'src/services/databaseControl.ts',
  'src/services/errors/errorReportQueueService.ts',
  'src/services/errors/errorReportSink.ts',
  'src/services/errors/globalErrorHandlers.ts',
  'src/services/errors/index.ts',
  'src/services/featureSettingsCommands.ts',
  'src/services/lock.ts',
  'src/services/notifications/notifeeService.ts',
  'src/services/notifications/remindersService.ts',
  'src/services/realtime/incomingEventDispatcher.ts',
  'src/services/realtime/incomingEventDrain.ts',
  'src/services/realtimeControl.ts',
  'src/services/notifications/actions.ts',
  'src/services/paste/pasteInput.ts',
  'src/services/send/outgoingQueueService.ts',
  'src/services/send/outgoingPasteOwnership.ts',
  'src/services/send/sendAttachmentService.ts',
  'src/services/send/sendContactService.ts',
  'src/services/send/sendOutcome.ts',
  'src/services/send/sendReactionService.ts',
  'src/services/send/sendService.ts',
  'src/services/send/index.ts',
  'src/services/chatActions.ts',
  'src/features/conversations/devSeed.ts',
  'src/services/syncControl.ts',
  'src/services/sync/engine.ts',
  'src/services/backgrounds/syncedBackground.ts',
  'src/services/background/backgroundSync.ts',
  'src/db/repositories/scheduled.ts',
  'src/services/download/attachmentCacheCoordinator.ts',
  'src/services/download/attachmentCacheRecovery.ts',
  'src/services/download/downloadService.ts',
  'src/services/download/index.ts',
  'src/services/send/scheduleService.ts',
  'src/services/send/sendEditService.ts',
  'src/state/featureSettingsStore.ts',
  'src/state/themeStore.ts',
  'src/ui/attachments/AudioAttachment.tsx',
  'src/ui/attachments/ContactCard.tsx',
  'src/ui/attachments/FileChip.tsx',
  'src/ui/attachments/ImageAttachment.tsx',
  'src/ui/attachments/LocationCard.tsx',
  'src/ui/attachments/StickerOverlay.tsx',
  'src/ui/attachments/VideoPlayer.tsx',
  'src/ui/conversations/ChatActionsSheet.tsx',
  'src/ui/conversations/ConversationListScreen.tsx',
  'src/ui/conversations/ConversationTile.tsx',
]);
const TEMPORAL_EXCLUSION_CONTEXTS = new Set([
  'startup-initialization',
  'startup-migration-adapter',
  'startup-single-flight-delegation',
  'startup-migration',
  'throwaway-database-delegation',
  'throwaway-database',
]);

const NATIVE_DB_MARKERS = [
  /\bandroid\.database\.sqlite\b/,
  /\b(?:RoomDatabase|SQLiteDatabase|SupportSQLiteDatabase)\b/,
  /\.execSQL\s*\(/,
  /\bsqlite3_(?:exec|prepare|step)\s*\(/,
];

function normalizePath(path) {
  return path.split(sep).join('/');
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return sourceFiles(path);
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function nativeSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return nativeSourceFiles(path);
    return /\.(?:c|cc|cpp|cxx|java|kt|m|mm|swift)$/.test(entry.name) ? [path] : [];
  });
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isDbSchemaModule(specifier, fileName) {
  if (specifier === '@db/schema' || specifier === '@/db/schema') return true;
  if (!specifier.startsWith('.')) return false;
  return /(?:^|\/)src\/db\//.test(normalizePath(fileName)) && /(?:^|\/)schema$/.test(specifier);
}

function schemaBindings(file, fileName) {
  const names = new Map();
  const namespaces = new Set();
  const sqlTags = new Set(['sql']);
  const opSqliteOpeners = new Set();
  const opSqliteHandles = new Set();
  const coordinators = new Map([
    ['withDbTransaction', 'withDbTransaction'],
    ['withDbWriteLock', 'withDbWriteLock'],
  ]);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (isDbSchemaModule(specifier, fileName)) {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          names.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }
    if (specifier === 'drizzle-orm' && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'sql') {
          sqlTags.add(element.name.text);
        }
      }
    }
    if (specifier === '@op-engineering/op-sqlite' && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'open') {
          opSqliteOpeners.add(element.name.text);
        }
      }
    }
    if (
      (specifier === '@db/transaction' || /(?:^|\/)db\/transaction$/.test(specifier)) &&
      bindings &&
      ts.isNamedImports(bindings)
    ) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === 'withDbTransaction' || imported === 'withDbWriteLock') {
          coordinators.set(element.name.text, imported);
        }
      }
    }
  }

  function visitDynamicImports(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const awaited = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const imported = unwrapExpression(awaited);
      if (
        ts.isCallExpression(imported) &&
        imported.expression.kind === ts.SyntaxKind.ImportKeyword &&
        imported.arguments[0] &&
        ts.isStringLiteral(imported.arguments[0]) &&
        imported.arguments[0].text === '@op-engineering/op-sqlite'
      ) {
        for (const element of node.name.elements) {
          const original = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
              ? element.propertyName.text
              : undefined
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
          if (original === 'open' && ts.isIdentifier(element.name)) {
            opSqliteOpeners.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visitDynamicImports);
  }
  visitDynamicImports(file);

  const openedHandleName = (expression) => {
    const call = callExpression(expression);
    return call && ts.isIdentifier(unwrapExpression(call.expression))
      ? opSqliteOpeners.has(unwrapExpression(call.expression).text)
      : false;
  };
  function visitOpenedHandles(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      openedHandleName(node.initializer)
    ) {
      opSqliteHandles.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(node.left)) &&
      openedHandleName(node.right)
    ) {
      opSqliteHandles.add(unwrapExpression(node.left).text);
    }
    ts.forEachChild(node, visitOpenedHandles);
  }
  visitOpenedHandles(file);
  return { coordinators, names, namespaces, opSqliteHandles, opSqliteOpeners, sqlTags };
}

function isSchemaTable(node, bindings) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return bindings.names.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  let root = expression.expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) && bindings.namespaces.has(root.text)
    ? expression.name.text
    : undefined;
}

function templateText(template) {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  if (!ts.isTemplateExpression(template)) return undefined;
  return `${template.head.text}${template.templateSpans
    .map((span) => `?${span.literal.text}`)
    .join('')}`;
}

function sqlText(node, sqlTags = new Set(['sql'])) {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return templateText(expression);
  if (ts.isTaggedTemplateExpression(expression)) {
    const tag = unwrapExpression(expression.tag);
    const tagName = ts.isIdentifier(tag)
      ? tag.text
      : ts.isPropertyAccessExpression(tag)
        ? tag.name.text
        : undefined;
    if (tagName && sqlTags.has(tagName)) return templateText(expression.template);
  }
  return undefined;
}

function sqlTarget(source, operation) {
  const sql = stripSqlComments(source);
  if (operation.startsWith('transaction-')) return '<connection>';
  if (operation === 'sql-pragma') {
    return /^PRAGMA\s+([A-Za-z0-9_.]+)/i.exec(sql)?.[1] ?? '<pragma>';
  }
  const patterns = {
    'sql-insert': /\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+[`"[]?([A-Za-z0-9_.]+)/i,
    'sql-update': /\bUPDATE(?:\s+OR\s+\w+)?\s+[`"[]?([A-Za-z0-9_.]+)/i,
    'sql-delete': /\bDELETE\s+FROM\s+[`"[]?([A-Za-z0-9_.]+)/i,
    'sql-schema':
      /\b(?:CREATE(?:\s+VIRTUAL)?|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER)?\s*(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"[]?([A-Za-z0-9_.]+)/i,
    'sql-attach': /\b(?:ATTACH|DETACH)(?:\s+DATABASE)?\s+[`"[]?([A-Za-z0-9_.?]+)/i,
    'sql-maintenance': /\b(?:ANALYZE|REINDEX|VACUUM)\s*[`"[]?([A-Za-z0-9_.]*)/i,
  };
  return patterns[operation]?.exec(sql)?.[1] || '<unknown>';
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
}

function operationForKeyword(keyword) {
  switch (keyword) {
    case 'INSERT':
    case 'REPLACE':
      return 'sql-insert';
    case 'UPDATE':
      return 'sql-update';
    case 'DELETE':
      return 'sql-delete';
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'VACUUM':
    case 'REINDEX':
      return 'sql-schema';
    case 'ATTACH':
    case 'DETACH':
      return 'sql-attach';
    case 'ANALYZE':
      return 'sql-maintenance';
    case 'PRAGMA':
      return 'sql-pragma';
    case 'BEGIN':
    case 'SAVEPOINT':
      return 'transaction-begin';
    case 'COMMIT':
    case 'END':
      return 'transaction-commit';
    case 'ROLLBACK':
    case 'RELEASE':
      return 'transaction-rollback';
    default:
      return undefined;
  }
}

export function classifySqlOperation(source) {
  const sql = stripSqlComments(source).toUpperCase();
  const head = /^([A-Z]+)/.exec(sql)?.[1];
  const direct = head ? operationForKeyword(head) : undefined;
  if (direct) return direct;

  // SQLite permits mutating WITH statements. A full SQL parser would obscure this guard; this
  // conservative check deliberately prefers a manual review over silently missing a CTE write.
  if (head === 'WITH') {
    const mutation = /\b(INSERT|REPLACE|UPDATE|DELETE)\b/.exec(sql)?.[1];
    if (mutation) return operationForKeyword(mutation);
  }

  // Also catch a later mutating statement in a multi-statement raw string.
  for (const statement of sql.split(';').slice(1)) {
    const keyword = /^\s*([A-Z]+)/.exec(statement)?.[1];
    const operation = keyword ? operationForKeyword(keyword) : undefined;
    if (operation) return operation;
  }
  return undefined;
}

function receiverLooksDatabaseLike(node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return /^(?:db|rawDb|database|sqlite|runner|connection)$|(?:Db|Database)$/i.test(
      expression.text,
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return /^(?:db|rawDb|database|sqlite|runner|connection)$|(?:Db|Database)$/i.test(
      expression.name.text,
    );
  }
  if (ts.isCallExpression(expression)) {
    const name = calledIdentifier(expression.expression);
    return name === 'getDatabase' || name === 'getRawDatabase';
  }
  return false;
}

function callAccess(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return { method: expression.name.text, receiver: expression.expression };
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return { method: expression.argumentExpression.text, receiver: expression.expression };
  }
  return undefined;
}

function calledIdentifier(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return undefined;
}

/**
 * True only when `node` executes in `callable`'s own body.
 *
 * Mere AST containment is not enough for transaction ownership: a timer, promise continuation,
 * event handler, or any other nested function can run after the transaction callback has returned.
 * Those callbacks must earn a coordinator context through the whole-program call graph instead of
 * inheriting one lexically from an outer function they happen to be declared inside.
 */
function isDirectlyInsideCallable(node, callable) {
  for (let current = node.parent; current; current = current.parent) {
    if (current === callable) return true;
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function detectedContext(node, fileName, symbol, bindings) {
  const path = normalizePath(fileName);
  if (path.endsWith('src/db/migrations.ts') || path.endsWith('src/db/migrate.ts')) {
    return 'startup-migration';
  }
  if (path.endsWith('src/db/transaction.ts') && symbol === 'withDbTransaction') {
    return 'transaction-coordinator';
  }
  if (path.endsWith('src/db/database.ts')) {
    if (symbol === 'initDatabase') return 'startup-initialization';
    return 'driver-adapter';
  }
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const localName = calledIdentifier(current.expression);
    const coordinator = localName ? bindings.coordinators.get(localName) : undefined;
    if (!coordinator) continue;
    const callback = current.arguments[coordinator === 'withDbTransaction' ? 1 : 0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      isDirectlyInsideCallable(node, callback)
    ) {
      return coordinator;
    }
  }
  return 'unresolved';
}

function isOpSqliteDelete(call, access, bindings) {
  if (access.method !== 'delete' || call.arguments.length !== 0) return false;
  const receiver = unwrapExpression(access.receiver);
  return Boolean(
    (ts.isCallExpression(receiver) &&
      ts.isIdentifier(receiver.expression) &&
      bindings.opSqliteOpeners.has(receiver.expression.text)) ||
    (ts.isIdentifier(receiver) && bindings.opSqliteHandles.has(receiver.text)),
  );
}

function declarationName(node) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isPropertyAssignment(node.parent) &&
    (ts.isIdentifier(node.parent.name) || ts.isStringLiteralLike(node.parent.name))
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

function unaliasSymbol(symbol, checker) {
  let current = symbol;
  const seen = new Set();
  while (current && current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
    seen.add(current);
    try {
      current = checker.getAliasedSymbol(current);
    } catch {
      return undefined;
    }
  }
  return current;
}

function isConstVariableDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    Boolean(node.parent.flags & ts.NodeFlags.Const)
  );
}

function callableNodeFromSymbol(symbol, checker, seen = new Set()) {
  const current = unaliasSymbol(symbol, checker);
  if (!current || seen.has(current)) return undefined;
  seen.add(current);

  for (const declaration of current.declarations ?? []) {
    if (ts.isFunctionLike(declaration)) return declaration;
    if (
      (ts.isVariableDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.initializer
    ) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return initializer;
      }
      if (!isConstVariableDeclaration(declaration)) continue;
      const target = checker.getSymbolAtLocation(initializer);
      const resolved = target ? callableNodeFromSymbol(target, checker, new Set(seen)) : undefined;
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function callableNodeForExpression(expression, checker) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol ? callableNodeFromSymbol(symbol, checker) : undefined;
}

function stableCallableResolutionFromSymbol(symbol, checker, seen = new Set()) {
  const current = unaliasSymbol(symbol, checker);
  if (!current || seen.has(current)) return undefined;
  seen.add(current);

  const declarations = current.declarations ?? [];
  if (declarations.length > 0 && declarations.every(ts.isFunctionDeclaration)) {
    const implementations = declarations.filter((declaration) => declaration.body);
    if (implementations.length !== 1) return undefined;
    return { callable: implementations[0], symbols: new Set([current]) };
  }

  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (!declaration || !isConstVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return { callable: initializer, symbols: new Set([current]) };
  }
  if (!ts.isIdentifier(initializer)) return undefined;
  const target = checker.getSymbolAtLocation(initializer);
  const resolved = target
    ? stableCallableResolutionFromSymbol(target, checker, new Set(seen))
    : undefined;
  if (!resolved) return undefined;
  resolved.symbols.add(current);
  return resolved;
}

/**
 * Resolve only callback expressions whose runtime identity cannot change behind the scanner:
 * inline functions, function declarations, or identifier-only chains of `const` aliases.
 * Mutable variables and object/class properties deliberately fail closed.
 */
function stableCallableResolutionForExpression(expression, checker) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return { callable: unwrapped, symbols: new Set() };
  }
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol ? stableCallableResolutionFromSymbol(symbol, checker) : undefined;
}

function constAliasSymbolForInitializerReference(expression, checker) {
  const declaration = expression.parent;
  if (
    !isConstVariableDeclaration(declaration) ||
    !declaration.initializer ||
    unwrapExpression(declaration.initializer) !== expression ||
    !ts.isIdentifier(declaration.name)
  ) {
    return undefined;
  }
  return unaliasSymbol(checker.getSymbolAtLocation(declaration.name), checker);
}

function callbackBindingsAreExclusive(symbols, files, checker, allowedExpressions, allowedSymbols) {
  if (symbols.size === 0) return true;
  let unsafe = false;
  for (const file of files) {
    function visit(node) {
      if (unsafe) return;
      const expression = referenceExpression(node);
      if (expression) {
        const symbol = unaliasSymbol(checker.getSymbolAtLocation(expression), checker);
        if (symbol && symbols.has(symbol)) {
          const aliasSymbol = constAliasSymbolForInitializerReference(expression, checker);
          if (aliasSymbol) {
            if (!allowedSymbols.has(aliasSymbol)) unsafe = true;
          } else if (
            !isDeclarationOrModuleAliasReference(expression) &&
            !allowedExpressions.has(expression)
          ) {
            unsafe = true;
          }
          if (unsafe) return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (unsafe) return false;
  }
  return true;
}

function enclosingCallableNode(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function callableOwnName(node, file) {
  const name = declarationName(node);
  if (name) {
    if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)) {
      const className = node.parent.name?.text;
      return className ? `${className}.${name}` : name;
    }
    return name;
  }
  const digest = createHash('sha256')
    .update(normalizedSnippet(node, file))
    .digest('hex')
    .slice(0, 10);
  return `<callback:${digest}>`;
}

function callableDisplayName(node) {
  const file = node.getSourceFile();
  const names = [];
  for (let current = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) names.unshift(callableOwnName(current, file));
  }
  return names.join('.');
}

function callableDescriptor(node, root) {
  const path = normalizePath(relative(root, node.getSourceFile().fileName));
  return `${path}#${callableDisplayName(node)}`;
}

function enclosingSymbol(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const name = declarationName(current);
    if (!name) continue;
    if (ts.isMethodDeclaration(current) && ts.isClassLike(current.parent)) {
      const className = current.parent.name?.text;
      return className ? `${className}.${name}` : name;
    }
    return name;
  }
  return '<module>';
}

function normalizedSnippet(node, file) {
  return node.getText(file).replace(/\s+/g, ' ').trim();
}

function findingId(path, symbol, operation, target, snippet) {
  const digest = createHash('sha256')
    .update(`${path}\0${symbol}\0${operation}\0${target}\0${snippet}`)
    .digest('hex')
    .slice(0, 12);
  return `${path}#${symbol}:${operation}:${digest}`;
}

export function scanDbWritesInSource(source, fileName = 'source.ts') {
  const scriptKind = extname(fileName).toLowerCase().includes('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const bindings = schemaBindings(file, fileName);
  const findings = [];
  const duplicateIds = new Map();

  function record(node, operation, target = '<unknown>', symbolOverride) {
    const path = normalizePath(fileName);
    const symbol = symbolOverride ?? enclosingSymbol(node);
    const detected = detectedContext(node, fileName, symbol, bindings);
    const context =
      operation === 'database-client-escape' || operation === 'extracted-database-method'
        ? 'unresolved'
        : detected;
    const snippet = normalizedSnippet(node, file);
    const baseId = findingId(path, symbol, operation, target, snippet);
    const occurrence = (duplicateIds.get(baseId) ?? 0) + 1;
    duplicateIds.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}:${occurrence}`;
    const sourceOffset = node.getStart(file);
    const { line } = file.getLineAndCharacterOfPosition(sourceOffset);
    findings.push({
      id,
      path,
      line: line + 1,
      sourceOffset,
      symbol,
      operation,
      target,
      detectedContext: context,
      snippet,
    });
  }

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const access = callAccess(node);
      if (access?.method === '$client') {
        record(node, 'database-client-escape', '<driver-client:$client>');
      } else if (access?.method === 'client') {
        const receiverAccess = callAccess(unwrapExpression(access.receiver));
        if (receiverAccess?.method === 'session') {
          record(node, 'database-client-escape', '<driver-client:session.client>');
        }
      }
      if (access && DYNAMIC_RAW_METHODS.has(access.method) && !isDirectCallReference(node)) {
        record(node, 'extracted-database-method', `<method:${access.method}>`);
      }
    }

    if (ts.isCallExpression(node)) {
      const access = callAccess(node.expression);
      if (!access) {
        if (
          ts.isElementAccessExpression(node.expression) &&
          receiverLooksDatabaseLike(node.expression.expression)
        ) {
          record(node, 'unknown-database-method', '<computed-method>');
        }
        ts.forEachChild(node, visit);
        return;
      }
      const { method } = access;
      const firstArgument = node.arguments[0];
      const table = firstArgument ? isSchemaTable(firstArgument, bindings) : undefined;
      if (
        firstArgument &&
        BUILDER_METHODS.has(method) &&
        (table || receiverLooksDatabaseLike(access.receiver))
      ) {
        record(node, `drizzle-${method}`, table ?? '<dynamic-table>');
      } else if (isOpSqliteDelete(node, access, bindings)) {
        record(node, 'native-database-delete', '<database-file>');
      } else if (firstArgument && RAW_METHODS.has(method)) {
        const sql = sqlText(firstArgument, bindings.sqlTags);
        const operation = sql === undefined ? undefined : classifySqlOperation(sql);
        if (operation) {
          record(node, operation, sqlTarget(sql, operation));
        } else if (
          sql === undefined &&
          (DYNAMIC_RAW_METHODS.has(method) || receiverLooksDatabaseLike(access.receiver))
        ) {
          record(node, 'raw-dynamic', '<dynamic>');
        }
      } else if (
        receiverLooksDatabaseLike(access.receiver) &&
        !SAFE_DATABASE_METHODS.has(method) &&
        !BUILDER_METHODS.has(method)
      ) {
        record(node, 'unknown-database-method', `<method:${method}>`);
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectBindingPattern(node.name) && receiverLooksDatabaseLike(node.initializer)) {
        for (const element of node.name.elements) {
          const method = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
              ? element.propertyName.text
              : undefined
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
          if (method && (RAW_METHODS.has(method) || BUILDER_METHODS.has(method))) {
            record(element, 'extracted-database-method', `<method:${method}>`);
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        const access = callAccess(unwrapExpression(node.initializer));
        if (
          access &&
          receiverLooksDatabaseLike(access.receiver) &&
          !DYNAMIC_RAW_METHODS.has(access.method) &&
          (RAW_METHODS.has(access.method) || BUILDER_METHODS.has(access.method))
        ) {
          record(node, 'extracted-database-method', `<method:${access.method}>`);
        }
      }
    }

    if (normalizePath(fileName).endsWith('src/db/migrations.ts') && ts.isPropertyAssignment(node)) {
      const propertyName =
        ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
          ? node.name.text
          : undefined;
      if (propertyName === 'statements' && ts.isArrayLiteralExpression(node.initializer)) {
        const object = node.parent;
        const nameProperty = ts.isObjectLiteralExpression(object)
          ? object.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                property.name.text === 'name',
            )
          : undefined;
        const migrationName =
          nameProperty && ts.isPropertyAssignment(nameProperty)
            ? sqlText(nameProperty.initializer, bindings.sqlTags)
            : undefined;
        for (const statement of node.initializer.elements) {
          const sql = sqlText(statement, bindings.sqlTags);
          const operation = sql === undefined ? undefined : classifySqlOperation(sql);
          if (sql && operation) {
            record(
              statement,
              operation,
              sqlTarget(sql, operation),
              migrationName ? `migration:${migrationName}` : 'migration:<unknown>',
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return findings.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

export function scanNativeDbWritesInSource(source, fileName = 'source.kt') {
  const path = normalizePath(fileName);
  const findings = [];
  for (const [index, lineSource] of source.split(/\r?\n/).entries()) {
    const snippet = lineSource.trim();
    if (!snippet || !NATIVE_DB_MARKERS.some((marker) => marker.test(snippet))) continue;
    const operation = 'native-database-api';
    findings.push({
      id: findingId(path, '<native>', operation, '<native-database>', snippet),
      path,
      line: index + 1,
      symbol: '<native>',
      operation,
      target: '<native-database>',
      detectedContext: '<native>',
      snippet,
    });
  }
  return findings;
}

function compilerOptionsForRoot(root) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
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
    return { ...parsed.options, allowJs: true, checkJs: false, noEmit: true };
  }
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
  };
}

function runtimeProgram(root, files) {
  return ts.createProgram({
    rootNames: files,
    options: compilerOptionsForRoot(root),
  });
}

function sourceFileMap(program, root, files) {
  const runtimeFiles = new Set(files.map((file) => normalizePath(resolve(file))));
  const byPath = new Map();
  for (const file of program.getSourceFiles()) {
    if (!runtimeFiles.has(normalizePath(resolve(file.fileName)))) continue;
    byPath.set(normalizePath(relative(root, file.fileName)), file);
  }
  return byPath;
}

function topLevelFunction(filesByPath, path, name) {
  const file = filesByPath.get(path);
  if (!file) return undefined;
  const matches = file.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function topLevelClassMethod(filesByPath, path, className, methodName) {
  const file = filesByPath.get(path);
  if (!file) return undefined;
  const classes = file.statements.filter(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (classes.length !== 1) return undefined;
  const methods = classes[0].members.filter(
    (member) =>
      ts.isMethodDeclaration(member) &&
      member.body &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
      member.name.text === methodName,
  );
  return methods.length === 1 ? methods[0] : undefined;
}

function topLevelVariable(file, name) {
  const matches = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push({ declaration, declarationList: statement.declarationList });
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function singleConstDeclaration(statement, name) {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) && declaration.name.text === name
    ? declaration
    : undefined;
}

function namedImportBinding(file, moduleName, importedName) {
  const matches = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === importedName) {
        matches.push(element.name);
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function namespaceImportBinding(file, moduleName) {
  const matches = file.statements
    .filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === moduleName &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings),
    )
    .map((statement) => statement.importClause.namedBindings.name);
  return matches.length === 1 ? matches[0] : undefined;
}

function soleNamedImportBinding(file, moduleName, importedName) {
  const imports = file.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName,
  );
  if (imports.length !== 1) return undefined;
  const importClause = imports[0].importClause;
  if (
    !importClause ||
    importClause.isTypeOnly ||
    importClause.name ||
    !importClause.namedBindings ||
    !ts.isNamedImports(importClause.namedBindings) ||
    importClause.namedBindings.elements.length !== 1
  ) {
    return undefined;
  }
  const element = importClause.namedBindings.elements[0];
  return element &&
    !element.isTypeOnly &&
    (element.propertyName?.text ?? element.name.text) === importedName
    ? element.name
    : undefined;
}

function runtimeReferencesToBinding(file, binding, checker) {
  const references = [];
  function isInsideStaticImport(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isImportDeclaration(current)) return true;
      if (ts.isStatement(current) || ts.isFunctionLike(current)) return false;
    }
    return false;
  }
  function visit(node) {
    if (
      (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !isCompileTimeOnlyReference(node) &&
      !isInsideStaticImport(node) &&
      sameSymbol(node, binding, checker)
    ) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return references;
}

/** Collect references to several exported boundaries with one whole-project AST traversal. */
function runtimeReferencesToBindings(files, bindings, checker) {
  const referencesByBinding = new Map(bindings.map((binding) => [binding, []]));
  const bindingBySymbol = new Map();
  for (const binding of bindings) {
    const symbol = unaliasSymbol(checker.getSymbolAtLocation(binding), checker);
    if (!symbol || bindingBySymbol.has(symbol)) return undefined;
    bindingBySymbol.set(symbol, binding);
  }

  function isInsideStaticImport(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isImportDeclaration(current)) return true;
      if (ts.isStatement(current) || ts.isFunctionLike(current)) return false;
    }
    return false;
  }
  function visit(node) {
    if (
      (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !isCompileTimeOnlyReference(node) &&
      !isInsideStaticImport(node)
    ) {
      const symbol = unaliasSymbol(checker.getSymbolAtLocation(node), checker);
      const binding = symbol ? bindingBySymbol.get(symbol) : undefined;
      if (binding) referencesByBinding.get(binding).push(node);
    }
    ts.forEachChild(node, visit);
  }
  for (const file of files) visit(file);
  return referencesByBinding;
}

function callExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isCallExpression(unwrapped) ? unwrapped : undefined;
}

function awaitedCallExpression(statement) {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = unwrapExpression(statement.expression);
  if (!ts.isAwaitExpression(expression)) return undefined;
  return callExpression(expression.expression);
}

function callableCall(expression, callable, checker) {
  const call = callExpression(expression);
  return call && callableNodeForExpression(call.expression, checker) === callable
    ? call
    : undefined;
}

function identifierNamed(node, name) {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression) && expression.text === name;
}

function identifierAssignment(
  statement,
  leftName,
  rightName,
  operator = ts.SyntaxKind.EqualsToken,
) {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = unwrapExpression(statement.expression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== operator ||
    !identifierNamed(expression.left, leftName) ||
    !identifierNamed(expression.right, rightName)
  ) {
    return undefined;
  }
  return expression;
}

function symbolsMatch(leftSymbol, rightSymbol, checker) {
  if (!leftSymbol || !rightSymbol) return false;
  if (leftSymbol === rightSymbol) return true;
  const resolvedLeft = unaliasSymbol(leftSymbol, checker);
  const resolvedRight = unaliasSymbol(rightSymbol, checker);
  return Boolean(resolvedLeft && resolvedRight && resolvedLeft === resolvedRight);
}

function sameSymbol(left, right, checker) {
  return symbolsMatch(
    checker.getSymbolAtLocation(left),
    checker.getSymbolAtLocation(right),
    checker,
  );
}

function hasPlainIdentifierParameters(callable, names) {
  return (
    callable.parameters.length === names.length &&
    callable.parameters.every((parameter, index) => {
      const expected = names[index];
      return (
        expected !== undefined &&
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === expected &&
        !parameter.initializer &&
        !parameter.dotDotDotToken &&
        !parameter.questionToken &&
        !parameter.modifiers?.length
      );
    })
  );
}

function hasExactIdentifierParameters(callable, specs) {
  return (
    callable.parameters.length === specs.length &&
    callable.parameters.every((parameter, index) => {
      const spec = specs[index];
      if (!spec || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return false;
      return (
        parameter.name.text === spec.name &&
        Boolean(parameter.questionToken) === Boolean(spec.optional) &&
        Boolean(parameter.initializer) === Boolean(spec.defaulted) &&
        !parameter.modifiers?.length
      );
    })
  );
}

function assignmentWritesTo(file, declarationNameNode, checker) {
  const writes = [];
  const declarationSymbol = checker.getSymbolAtLocation(declarationNameNode);

  function targetWritesState(target) {
    const expression = unwrapExpression(target);
    if (ts.isIdentifier(expression)) {
      return symbolsMatch(checker.getSymbolAtLocation(expression), declarationSymbol, checker);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return symbolsMatch(checker.getSymbolAtLocation(expression), declarationSymbol, checker);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return symbolsMatch(
            checker.getShorthandAssignmentValueSymbol(property),
            declarationSymbol,
            checker,
          );
        }
        if (ts.isPropertyAssignment(property)) {
          return targetWritesState(property.initializer);
        }
        return ts.isSpreadAssignment(property) && targetWritesState(property.expression);
      });
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) => {
        if (ts.isOmittedExpression(element)) return false;
        return ts.isSpreadElement(element)
          ? targetWritesState(element.expression)
          : targetWritesState(element);
      });
    }
    return false;
  }

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (targetWritesState(node.left)) writes.push(node);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrapExpression(node.operand);
      if (ts.isIdentifier(operand) && sameSymbol(operand, declarationNameNode, checker)) {
        writes.push(node);
      }
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      targetWritesState(node.initializer)
    ) {
      writes.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return writes;
}

function callableIsInside(callable, ancestor) {
  for (let current = callable; current; current = enclosingCallableNode(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

function directCallsToBinding(file, binding, checker) {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (ts.isIdentifier(expression) && sameSymbol(expression, binding, checker)) {
        calls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function projectModuleBasePath(importerPath, specifier) {
  const canonical = (path) => normalizePath(resolve('/', path)).slice(1);
  if (specifier.startsWith('.')) {
    return canonical(resolve('/', dirname(importerPath), specifier));
  }
  if (specifier.startsWith('@/')) return canonical(`src/${specifier.slice(2)}`);
  for (const [prefix, target] of [
    ['@core/', 'src/core/'],
    ['@db/', 'src/db/'],
    ['@ui/', 'src/ui/'],
    ['@state/', 'src/state/'],
    ['@features/', 'src/features/'],
    ['@native/', 'src/native/'],
    ['@utils/', 'src/utils/'],
  ]) {
    if (specifier.startsWith(prefix)) {
      return canonical(`${target}${specifier.slice(prefix.length)}`);
    }
  }
  const mapped = {
    '@core': 'src/core/index',
    '@db': 'src/db/schema',
    '@ui': 'src/ui/index',
    '@utils': 'src/utils/index',
  }[specifier];
  return mapped ? canonical(mapped) : undefined;
}

function projectModulePathCandidates(importerPath, specifier) {
  const base = projectModuleBasePath(importerPath, specifier);
  if (!base) return [];
  const extension = extname(base);
  if (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts') {
    return [base];
  }
  if (extension === '.js') {
    return [
      base,
      `${base.slice(0, -extension.length)}.ts`,
      `${base.slice(0, -extension.length)}.tsx`,
    ];
  }
  if (extension === '.jsx') {
    return [
      base,
      `${base.slice(0, -extension.length)}.tsx`,
      `${base.slice(0, -extension.length)}.ts`,
    ];
  }
  if (extension === '.mjs') {
    return [base, `${base.slice(0, -extension.length)}.mts`];
  }
  if (extension === '.cjs') {
    return [base, `${base.slice(0, -extension.length)}.cts`];
  }
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
}

function moduleSpecifierTargetsPath(importerPath, specifier, targetPath) {
  return projectModulePathCandidates(importerPath, specifier).includes(targetPath);
}

function runtimeModuleSpecifier(node) {
  if (!ts.isStringLiteralLike(node)) return false;
  let expression = node;
  while (
    expression.parent &&
    (ts.isAsExpression(expression.parent) ||
      ts.isParenthesizedExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === expression &&
    (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      identifierNamed(parent.expression, 'require'))
  ) {
    return true;
  }
  return ts.isExternalModuleReference(parent) && parent.expression === expression;
}

function hasNonStaticModuleSpecifierOfPath(filesByPath, targetPath) {
  let found = false;
  for (const [importerPath, file] of filesByPath) {
    function visit(node) {
      if (found) return;
      if (
        runtimeModuleSpecifier(node) &&
        moduleSpecifierTargetsPath(importerPath, node.text, targetPath)
      ) {
        found = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (found) return true;
  }
  return false;
}

function hasRuntimeModuleLoad(file, moduleName) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (runtimeModuleSpecifier(node) && node.text === moduleName) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function hasProjectLocalCommonJsLoad(filesByPath) {
  let found = false;
  for (const [importerPath, file] of filesByPath) {
    function visit(node) {
      if (found) return;
      if (ts.isStringLiteralLike(node)) {
        const parent = node.parent;
        const isRequireCall =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          identifierNamed(parent.expression, 'require');
        const isImportEquals = ts.isExternalModuleReference(parent) && parent.expression === node;
        if (
          (isRequireCall || isImportEquals) &&
          projectModulePathCandidates(importerPath, node.text).some((path) => filesByPath.has(path))
        ) {
          found = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (found) return true;
  }
  return false;
}

/**
 * Prove the exact DB-03B process-death contracts and the one-launch DB-02C runtime-concurrency
 * contract before their database operations or boot handoffs receive a throwaway context. All
 * database halves are limited to fixed-file entry points behind one exact durable-marker state
 * machine. Whole-function fingerprints keep ordering and finite assertions exact, while symbol
 * checks below prove that no handle, runner, rekey capability, or production capability escapes.
 */
function dbProcessRelaunchCertificateCandidate({
  filesByPath,
  checker,
  edges,
  referenceEdges,
  dynamicCallbacks,
  dynamicDispatches,
  findings,
  findingCallables,
}) {
  const databasePath = 'src/db/database.ts';
  const relaunchPath = 'src/services/boot/devDbRelaunchContract.ts';
  const runtimeWavePath = 'src/services/boot/dbRuntimeConcurrencyWave.ts';
  const foregroundPath = 'src/services/boot/foregroundBoot.ts';
  const databaseFile = filesByPath.get(databasePath);
  const relaunchFile = filesByPath.get(relaunchPath);
  const runtimeWaveFile = filesByPath.get(runtimeWavePath);
  const foregroundFile = filesByPath.get(foregroundPath);
  if (!databaseFile || !relaunchFile || !runtimeWaveFile || !foregroundFile) return undefined;
  if (
    createHash('sha256')
      .update(normalizedSnippet(runtimeWaveFile, runtimeWaveFile))
      .digest('hex') !== '20b474430d8b24dab5ee93c9fe1172bbdae80532cff2fa87060b04e22ea33553'
  ) {
    return undefined;
  }

  const databaseCallableNames = [
    'emptyDbRuntimeConcurrencyDatabaseChecks',
    'cleanupDbRuntimeConcurrencySelfTestDatabase',
    'dbRuntimeConcurrencyMigrationNames',
    'firstDbRuntimeConcurrencyWaveFailure',
    'runDbRuntimeConcurrencySelfTest',
    'emptyDbProcessRelaunchPrepareChecks',
    'emptyDbProcessRelaunchResumeChecks',
    'cleanupDbProcessRelaunchSelfTestDatabase',
    'dbProcessRelaunchMigrationNames',
    'inspectDbProcessRelaunchPartialState',
    'prepareDbProcessRelaunchSelfTest',
    'resumeDbProcessRelaunchSelfTest',
    'emptyDbActiveWalWriteDeathPrepareChecks',
    'emptyDbActiveWalWriteDeathResumeChecks',
    'pragmaContainsString',
    'isSuccessfulTruncateCheckpoint',
    'inspectDbActiveWalWriteDeathState',
    'cleanupDbActiveWalWriteDeathSelfTestDatabase',
    'retireDbActiveWalWriteDeathSelfTestDatabase',
    'prepareDbActiveWalWriteDeathSelfTest',
    'resumeDbActiveWalWriteDeathSelfTest',
    'emptyDbActiveMigrationDeathPrepareChecks',
    'emptyDbActiveMigrationDeathResumeChecks',
    'dbActiveMigrationNames',
    'dbActiveMigrationFixtureRows',
    'hasExactDbActiveMigrationFixture',
    'evaluateDbActiveMigrationState',
    'inspectDbActiveMigrationState',
    'inspectDbActiveMigrationRunnerState',
    'dbActiveMigrationPrefixRunner',
    'dbActiveMigrationCrashRunner',
    'seedDbActiveMigrationFixture',
    'cleanupDbActiveMigrationDeathSelfTestDatabase',
    'retireDbActiveMigrationDeathSelfTestDatabase',
    'prepareDbActiveMigrationDeathSelfTest',
    'resumeDbActiveMigrationDeathSelfTest',
  ];
  const databaseCallables = new Map(
    databaseCallableNames.map((name) => [name, topLevelFunction(filesByPath, databasePath, name)]),
  );
  const expectedDatabaseFingerprints = new Map([
    [
      'emptyDbRuntimeConcurrencyDatabaseChecks',
      '2392174f85d4221e9d329516dbfe62bc9fef531ff2ee00fc1523885771366d9e',
    ],
    [
      'cleanupDbRuntimeConcurrencySelfTestDatabase',
      '116c009b71f62536a358e2afd89c5e6f79f9fb7ae764f9115cbd19150db8730c',
    ],
    [
      'dbRuntimeConcurrencyMigrationNames',
      'bf93308fc49ec9fb6b3d4d66113e4db99eac92c3bd0bbebae8298d4b3680c4e2',
    ],
    [
      'firstDbRuntimeConcurrencyWaveFailure',
      '939ac9fa923f3fe00355592e6858a488fc0f9c5b418f945ce7ca19032077b0a2',
    ],
    [
      'runDbRuntimeConcurrencySelfTest',
      'fa80d5b3f51604fc400c64c3d0eb75c8ca91c0ff2dbc13814905109f1ffc10e8',
    ],
    [
      'emptyDbProcessRelaunchPrepareChecks',
      'ab03418083f72f49ca5c16470167aa389b358407a8553eb01bda9e44f0217782',
    ],
    [
      'emptyDbProcessRelaunchResumeChecks',
      'b5cc50c0cfc83271e8a43eaf1248f6ed529aa789aec1e6c2c1bcdf895ada4826',
    ],
    [
      'cleanupDbProcessRelaunchSelfTestDatabase',
      'b6ac96f11239746dec94a6216a49f033ccd8d368a03b765eb8b6f1eb26ad1837',
    ],
    [
      'dbProcessRelaunchMigrationNames',
      '1eafd2dec706a6d4ed3badf4f5e0dcef3c0b50e36ea249667d34ae1fc024b76a',
    ],
    [
      'inspectDbProcessRelaunchPartialState',
      '1217d3f0513c65bf3f1737f4ef87d3b4f82cdba7d9c2f93980427913c707ebdd',
    ],
    [
      'prepareDbProcessRelaunchSelfTest',
      '41a0e707c7f6a4bdad9b71f59235b9dbe67e693ce3f2e0451daaa6666b4003d0',
    ],
    [
      'resumeDbProcessRelaunchSelfTest',
      '5bac5cf033539d3ab68e00d18ba1109f4183f0a34825734b25dfb1b3ad2fa829',
    ],
    [
      'emptyDbActiveWalWriteDeathPrepareChecks',
      '611c9831042d5500477d44cf1fc81b1931111791d6cfb6e526506ac84c54777f',
    ],
    [
      'emptyDbActiveWalWriteDeathResumeChecks',
      '8fcca158ae0223d7363501a3f5752696d25e7a08bc919bea9e94c4e01e3c10aa',
    ],
    ['pragmaContainsString', 'cd3da0d18d353bd67fcc9e66dd43d79a0385ca00db23f851a747ef5134a826f3'],
    [
      'isSuccessfulTruncateCheckpoint',
      'dd34b61eb00839f87a6891a76d7f05ac826c72bcd6d6d6577280d7f7f5835b55',
    ],
    [
      'inspectDbActiveWalWriteDeathState',
      '600d4030a69a09584d6ed8c57dfce61835fbe7a00f064c30b580d1def0d33435',
    ],
    [
      'cleanupDbActiveWalWriteDeathSelfTestDatabase',
      '3c5f28f90f3427a04f2e8203e9cbd4d4365c60c0f7efe96e48d307a6ef0d8ee5',
    ],
    [
      'retireDbActiveWalWriteDeathSelfTestDatabase',
      'a00ee5b85148a0ec8ac1bbb38f31fa29d0a337950f5407699158087cc3a07026',
    ],
    [
      'prepareDbActiveWalWriteDeathSelfTest',
      '09dea0b4fcf81a47fa3b549c19f5c973831e42beafbb097aea745efc5cec0a51',
    ],
    [
      'resumeDbActiveWalWriteDeathSelfTest',
      '3b31d33d021ab2d24557f3f16043470ea6161d9414ab8ac938022b996c6605bb',
    ],
    [
      'emptyDbActiveMigrationDeathPrepareChecks',
      '4619c4eb1cc8f8a4186c40f0230920a4497760bfe9afbf6cde0a2391ed00d507',
    ],
    [
      'emptyDbActiveMigrationDeathResumeChecks',
      '4dece3fe4635db49bba36dfab20731a9281fba52b6615e36a36fd95ad73461f0',
    ],
    ['dbActiveMigrationNames', '1d49a04507ff167b222d9be33facff708972eec3ac1ca9ee4c8715c29fd3f146'],
    [
      'dbActiveMigrationFixtureRows',
      '303abf81c3d7373d48802a6d0b0a9fcd6724c1e91713975a3eee43e51c356ebd',
    ],
    [
      'hasExactDbActiveMigrationFixture',
      '1d9767f7b7e9f8f0ca0d3864018419ff725f3ec3431c43de2fd594e75a5f99e8',
    ],
    [
      'evaluateDbActiveMigrationState',
      'e8b1ea421af992fcd0de8b375b96df3ecfa66b67366c2325266b9bb4aa21ba0d',
    ],
    [
      'inspectDbActiveMigrationState',
      'db65bce22bc363c4344b4afeea01f5a003c6910d6aa024913a50e7b6e3898019',
    ],
    [
      'inspectDbActiveMigrationRunnerState',
      'fc8d5ec3edde9f985d64bcdea4baa1fb7e1844a49d269a79f3c5c299b8991dfe',
    ],
    [
      'dbActiveMigrationPrefixRunner',
      'bb5464c48c556991e4a050bcec9a51de2f1d88b971fd71bf4995adafac10e0f6',
    ],
    [
      'dbActiveMigrationCrashRunner',
      '6655bb5b361b7c8edd4b5e194d8f3fd77b18b7cb8eae19209c8c0ea7d5b77296',
    ],
    [
      'seedDbActiveMigrationFixture',
      '7e4686fb40a294009263e8cb94d77fede518635ac954221ec45462c378491ae1',
    ],
    [
      'cleanupDbActiveMigrationDeathSelfTestDatabase',
      'ab996bc12f4d169404c604fcccf2d0dcb73a21071daae45261bcfd3e903d8370',
    ],
    [
      'retireDbActiveMigrationDeathSelfTestDatabase',
      'c38382aafdb842f60f0d375ef46689347897279e11d816ae67836958ca4493f1',
    ],
    [
      'prepareDbActiveMigrationDeathSelfTest',
      '6b3d7ef35a2550172c78aa346f12156d30156f3233722ba049d8360e81282a80',
    ],
    [
      'resumeDbActiveMigrationDeathSelfTest',
      '1ced26b353c26e170e11a8cfcc04bc23d7f51c25f40e8df593f219dc6175d018',
    ],
  ]);
  for (const [name, expected] of expectedDatabaseFingerprints) {
    const callable = databaseCallables.get(name);
    if (
      !callable?.body ||
      createHash('sha256').update(normalizedSnippet(callable, databaseFile)).digest('hex') !==
        expected
    ) {
      return undefined;
    }
  }
  const runtimeWaveCallableNames = [
    'deferred',
    'observe',
    'syncChat',
    'liveMessage',
    'syncApi',
    'count',
    'submitOrderedCoordinatorWave',
    'runDbRuntimeConcurrencyWave',
  ];
  const runtimeWaveCallables = new Map(
    runtimeWaveCallableNames.map((name) => [
      name,
      topLevelFunction(filesByPath, runtimeWavePath, name),
    ]),
  );
  const expectedRuntimeWaveFingerprints = new Map([
    ['deferred', '749b46b1f7f78556be7dfdc72d405a2f92493d45bf2e87e990c99a25e24b45eb'],
    ['observe', '2a1287160d12928bb5a95a0ce78bff88adf80562d831e4aedd6dd9c261f1f965'],
    ['syncChat', '71ea327d809efd891f9196214ebb20b4149304a9c8b5e715143030ff114c30db'],
    ['liveMessage', '4cccfc43e183566a82228df3a9689f8b217d78cfed297c6f523a6485fa05b4a6'],
    ['syncApi', 'bc4e46fa51e2e97b812b7cd1b9473812c2edc49cde9ae414c33b3b54fe080284'],
    ['count', '04da8112837e41f975bb09ef7205ea81050dd24c1c167eba8914b3ba69a54ef1'],
    [
      'submitOrderedCoordinatorWave',
      '5bbe0ae791b6df42ec968ebfe7506e1bb2ca459500efc0e3bbd0f148ec8c6b72',
    ],
    [
      'runDbRuntimeConcurrencyWave',
      '191426b03e8950e87f8e0e4a9b7a650e9b66a2879f5ab7a822fcb700d3214a55',
    ],
  ]);
  for (const [name, expected] of expectedRuntimeWaveFingerprints) {
    const callable = runtimeWaveCallables.get(name);
    if (
      !callable?.body ||
      createHash('sha256').update(normalizedSnippet(callable, runtimeWaveFile)).digest('hex') !==
        expected
    ) {
      return undefined;
    }
  }
  const relaunchCallableNames = [
    'markerFile',
    'markerPresence',
    'inspectDurableMarkers',
    'classifyRuntimeConcurrencyState',
    'runtimeConcurrencyRecoveryFailureCode',
    'standardRelaunchRecoveryFailureCode',
    'classifyScenarioState',
    'classifyStartMode',
    'createZeroByteMarker',
    'deleteMarkerIfPresent',
    'cleanupDurableMarkers',
    'emptyPrepareMarkerChecks',
    'emptyFinalMarkerChecks',
    'emptyWalWriteDeathPrepareMarkerChecks',
    'emptyWalWriteDeathFinalMarkerChecks',
    'emptyActiveMigrationDeathPrepareMarkerChecks',
    'emptyActiveMigrationDeathFinalMarkerChecks',
    'emptyRuntimeConcurrencyMarkerChecks',
    'logPrepareMarker',
    'logFinalMarker',
    'logWalWriteDeathPrepareMarker',
    'logWalWriteDeathFinalMarker',
    'logActiveMigrationDeathPrepareMarker',
    'logActiveMigrationDeathFinalMarker',
    'logRuntimeConcurrencyMarker',
    'waitForHostKill',
    'finishRuntimeConcurrencyFailure',
    'runRuntimeConcurrencyPhase',
    'runRuntimeConcurrencyRecoveryPhase',
    'finishPrepareFailure',
    'runPreparePhase',
    'finalChecksFromDatabaseResult',
    'runResumePhase',
    'runRecoveryPhase',
    'finishWalWriteDeathPrepareFailure',
    'runWalWriteDeathPreparePhase',
    'walWriteDeathFinalChecksFromDatabaseResult',
    'runWalWriteDeathResumePhase',
    'runWalWriteDeathRecoveryPhase',
    'finishActiveMigrationDeathPrepareFailure',
    'runActiveMigrationDeathPreparePhase',
    'activeMigrationDeathFinalChecksFromDatabaseResult',
    'runActiveMigrationDeathResumePhase',
    'runActiveMigrationDeathRecoveryPhase',
    'startDevDbRelaunchContractIfRequested',
  ];
  const relaunchCallables = new Map(
    relaunchCallableNames.map((name) => [name, topLevelFunction(filesByPath, relaunchPath, name)]),
  );
  const expectedRelaunchFingerprints = new Map([
    ['markerFile', 'eda1812af05ac12274d65dfd1515d39d3cce9604a5949e5d6e8757dedbf890e2'],
    ['markerPresence', '1ff240b3eb4c17304be77bf05659a48f430bb64cfd87d4d823e72b52ab0f7292'],
    ['inspectDurableMarkers', '16a6450318ed99d112f31e62adf467b41332bdd28287559f87a202f236d83b77'],
    [
      'classifyRuntimeConcurrencyState',
      '40391fc1c6edd8ece3d4cf420308cb0318df0b85ca3a51254e4bf91d8abb9208',
    ],
    [
      'runtimeConcurrencyRecoveryFailureCode',
      '3458dbf03fd89fabfa6516d1b09ccb1507f20965a908e79bf025ae2bfc4a45e8',
    ],
    [
      'standardRelaunchRecoveryFailureCode',
      '0380fb3fa6059440f285130d422ef06765c9c27240910107746f3df78a385475',
    ],
    ['classifyScenarioState', 'dff892f0d85e2400d993e8837ac38c6aa07b4bf9c112157de5129e404de94357'],
    ['classifyStartMode', 'c97367796603cc4a63c4261efa2b63a2b0850d7092dedc2552503f623810d070'],
    ['createZeroByteMarker', 'e3a4a775c111eb4efba310531ed863b7ad9d18af9aa85ad49cf5ba73d1329ae6'],
    ['deleteMarkerIfPresent', '5e846690dc0cc970d28b421b067cb4d0303d04e96fa965fc5fae174b33626dc5'],
    ['cleanupDurableMarkers', 'ad702babce9f4b9e3a5aae7dabceb5cb4894aac4911f4de722e92148055448a7'],
    [
      'emptyPrepareMarkerChecks',
      '19a57fcc764d8a98c1903a1f61cdbdcdbdc0518adb6dcb4651de70b0f0367533',
    ],
    ['emptyFinalMarkerChecks', '5c0167ffe8e52df76ede63a9e3cb44153b0b8cbd85a807cf71a377fc7c27b647'],
    [
      'emptyWalWriteDeathPrepareMarkerChecks',
      '6e96537d1f7ae4a674aa1a9204b01a8749494afcb2b4b2ee0d8bcdad8ce4782a',
    ],
    [
      'emptyWalWriteDeathFinalMarkerChecks',
      '8dd09b54acf74a2aff2dcfcc3d20f349c896acb5ada2d5337277c6e7548a75a8',
    ],
    [
      'emptyActiveMigrationDeathPrepareMarkerChecks',
      'fba938aaafc627573e53e202480058f333a6153e52ba3ccfbc2c3aeab43afbe0',
    ],
    [
      'emptyActiveMigrationDeathFinalMarkerChecks',
      'c187086dd48f2bd728cedb0110f3e3642a899ab2b32f39446dbf5e4d8c8e1954',
    ],
    [
      'emptyRuntimeConcurrencyMarkerChecks',
      '3163635505446d32e6d59a8ad3829cca91335d792110532691d729b6b7429bfc',
    ],
    ['logPrepareMarker', '77a5b04f3b046f29d31de9039ba5d7a53e9d5cbba0bca0e4c9bc2e27231c3751'],
    ['logFinalMarker', '94a635d8a3f96201f7b5201b5e326e3b045bd7ec81f4bae2ec79ef12f3c693b6'],
    [
      'logWalWriteDeathPrepareMarker',
      '3cae2aa0bc3b175dd85ea5dc2580681882fe1ff5c3732713d7a1611a2d78400c',
    ],
    [
      'logWalWriteDeathFinalMarker',
      'cb033f6bbae4f3d257f6dfe1debf01e6e10694ecbf8060e04c6ae27aa53e6abd',
    ],
    [
      'logActiveMigrationDeathPrepareMarker',
      'bd4b92e2c20efb96c284924c2b168903446cb8ecd9b94ea9c9d64cf5ace28a31',
    ],
    [
      'logActiveMigrationDeathFinalMarker',
      '4f586d6d11d91ee5569f7ff506b6567e99d8f8c553973c8802f34372d1bba084',
    ],
    [
      'logRuntimeConcurrencyMarker',
      '282abf2b7573a308c799718ad952312a2d497860fb6f5880fdc5c1dec1f330ca',
    ],
    ['waitForHostKill', 'c6ab060b1894631fa3bb6c8e41049159ad2412aa676b6708a489c759ac40f4bf'],
    [
      'finishRuntimeConcurrencyFailure',
      '2b718c8b921c3c5a6730d2c72ff6238a50af3c2f1fc6e456c8dba024f87b8c7e',
    ],
    [
      'runRuntimeConcurrencyPhase',
      '68c22e54cdd211a9f63ed62ccb1eb510b0279f316c3707ff39f28eca3dc1e194',
    ],
    [
      'runRuntimeConcurrencyRecoveryPhase',
      '7b1be09333eacb96abfec93fd30d48ccfdced81ef2b093afcea4e5c821131a6a',
    ],
    ['finishPrepareFailure', 'c8c195872eadf73ada6062c73e9f594c2214a5ebd7ab48a781eeeabec78ce5d7'],
    ['runPreparePhase', '7f1cfda87b5c6e2363f285a78bfaf809473285a8ac0b2a896589c4d5cbf6e621'],
    [
      'finalChecksFromDatabaseResult',
      '79d8e8c3387379ecd02e33e728fc80149ec4b516926f3e69507876ffe231808f',
    ],
    ['runResumePhase', '85ade713071959dcd8944771c3794793682de3c15a9fbddfd79bb2feb9893828'],
    ['runRecoveryPhase', '71732a7570d6134babcbb33be3cb7a98c57ed2fe52c430940cc101faca7a3832'],
    [
      'finishWalWriteDeathPrepareFailure',
      '39dea4bb1209fa4c632a170df1abea12deaa536d50477e5a982baaa14722e184',
    ],
    [
      'runWalWriteDeathPreparePhase',
      'bf07a1a54c9e2eb96fdabbd07583bdb1bb3016163191aed1f65d58470191c03f',
    ],
    [
      'walWriteDeathFinalChecksFromDatabaseResult',
      'e89402c60a218799b369bdd79ba43f7cac8340047e981b15179761901c005764',
    ],
    [
      'runWalWriteDeathResumePhase',
      'fcc40ec295d4f9da598b4dcfc50b6ce0243ac7bcde2726518287eeafc52fcbad',
    ],
    [
      'runWalWriteDeathRecoveryPhase',
      '1c117218cf3c90b6e575f5b2bd43e43fd39396097161ba3233c347212baf0105',
    ],
    [
      'finishActiveMigrationDeathPrepareFailure',
      '1132a5dfe7fadc0a280d6e25ab9811b7e867e6102ff7a2314abd6e1f2748c55e',
    ],
    [
      'runActiveMigrationDeathPreparePhase',
      'cae92b12dfa9261bc152130abd23bfa7d03c4975e69c542f77202bc73b4dd39a',
    ],
    [
      'activeMigrationDeathFinalChecksFromDatabaseResult',
      '3399c420b42ed060afd6a5ad3a8136898848089899650af2620e76c3c660684f',
    ],
    [
      'runActiveMigrationDeathResumePhase',
      '81ddb576788cdfc0998d271474caf489bc5bd4600499e4f9ba113f5783f9eeb7',
    ],
    [
      'runActiveMigrationDeathRecoveryPhase',
      '825d8ad721bb7ec93d419950ed1cd9cb7b0ebffe8193304e7272922c22d69165',
    ],
    [
      'startDevDbRelaunchContractIfRequested',
      '33bee4d4d92e6bfe14ac5a10b79f2ddf29a50c0600a201f4818b9636bba4fabc',
    ],
  ]);
  const actualRelaunchFunctions = relaunchFile.statements.filter(ts.isFunctionDeclaration);
  if (
    relaunchFile.statements.length !== 98 ||
    actualRelaunchFunctions.map((callable) => callable.name?.text).join('\n') !==
      relaunchCallableNames.join('\n')
  ) {
    return undefined;
  }
  for (const [name, expected] of expectedRelaunchFingerprints) {
    const callable = relaunchCallables.get(name);
    if (
      !callable?.body ||
      createHash('sha256').update(normalizedSnippet(callable, relaunchFile)).digest('hex') !==
        expected
    ) {
      return undefined;
    }
  }
  const expectedImports = [
    "import { File, Paths } from 'expo-file-system';",
    "import { logger } from '@core/secure';",
    "import { cleanupDbActiveMigrationDeathSelfTestDatabase, cleanupDbActiveWalWriteDeathSelfTestDatabase, cleanupDbProcessRelaunchSelfTestDatabase, cleanupDbRuntimeConcurrencySelfTestDatabase, prepareDbActiveMigrationDeathSelfTest, prepareDbActiveWalWriteDeathSelfTest, prepareDbProcessRelaunchSelfTest, resumeDbActiveMigrationDeathSelfTest, resumeDbActiveWalWriteDeathSelfTest, resumeDbProcessRelaunchSelfTest, runDbRuntimeConcurrencySelfTest, type DbActiveMigrationDeathPrepareChecks, type DbActiveMigrationDeathPrepareFailureCode, type DbActiveMigrationDeathResumeFailureCode, type DbActiveMigrationDeathResumeResult, type DbActiveWalWriteDeathPrepareChecks, type DbActiveWalWriteDeathPrepareFailureCode, type DbActiveWalWriteDeathResumeFailureCode, type DbActiveWalWriteDeathResumeResult, type DbProcessRelaunchPrepareChecks, type DbProcessRelaunchPrepareFailureCode, type DbProcessRelaunchResumeFailureCode, type DbProcessRelaunchResumeResult, type DbRuntimeConcurrencyDatabaseChecks, type DbRuntimeConcurrencyDatabaseFailureCode, type DbRuntimeConcurrencyDatabaseResult, } from '@db/database';",
    "import { runDbRuntimeConcurrencyWave } from '@/services/boot/dbRuntimeConcurrencyWave';",
  ];
  if (
    relaunchFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => normalizedSnippet(statement, relaunchFile))
      .join('\n') !== expectedImports.join('\n')
  ) {
    return undefined;
  }
  const expectedRelaunchVariables = new Map([
    ['DB_RELAUNCH_MARKER_PREFIX', [ts.NodeFlags.Const, "'GATOR_DB_RELAUNCH_V1 '"]],
    ['DB_WAL_WRITE_DEATH_MARKER_PREFIX', [ts.NodeFlags.Const, "'GATOR_DB_WAL_WRITE_DEATH_V1 '"]],
    [
      'DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX',
      [ts.NodeFlags.Const, "'GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 '"],
    ],
    [
      'DB_RUNTIME_CONCURRENCY_MARKER_PREFIX',
      [ts.NodeFlags.Const, "'GATOR_DB_RUNTIME_CONCURRENCY_V1 '"],
    ],
    ['DB_RELAUNCH_REQUEST_FILE', [ts.NodeFlags.Const, "'.gator-db-relaunch-request-v1'"]],
    [
      'DB_WAL_WRITE_DEATH_REQUEST_FILE',
      [ts.NodeFlags.Const, "'.gator-db-wal-write-death-request-v1'"],
    ],
    [
      'DB_ACTIVE_MIGRATION_DEATH_REQUEST_FILE',
      [ts.NodeFlags.Const, "'.gator-db-active-migration-death-request-v1'"],
    ],
    [
      'DB_RUNTIME_CONCURRENCY_REQUEST_FILE',
      [ts.NodeFlags.Const, "'.gator-db-runtime-concurrency-request-v1'"],
    ],
    [
      'DB_RUNTIME_CONCURRENCY_RUNNING_FILE',
      [ts.NodeFlags.Const, "'.gator-db-runtime-concurrency-running-v1'"],
    ],
    ['DB_RELAUNCH_PREPARING_FILE', [ts.NodeFlags.Const, "'.gator-db-relaunch-preparing-v1'"]],
    ['DB_RELAUNCH_READY_FILE', [ts.NodeFlags.Const, "'.gator-db-relaunch-ready-v1'"]],
    ['DB_RELAUNCH_RESUMING_FILE', [ts.NodeFlags.Const, "'.gator-db-relaunch-resuming-v1'"]],
    [
      'DB_WAL_WRITE_DEATH_PREPARING_FILE',
      [ts.NodeFlags.Const, "'.gator-db-wal-write-death-preparing-v1'"],
    ],
    ['DB_WAL_WRITE_DEATH_READY_FILE', [ts.NodeFlags.Const, "'.gator-db-wal-write-death-ready-v1'"]],
    [
      'DB_WAL_WRITE_DEATH_RESUMING_FILE',
      [ts.NodeFlags.Const, "'.gator-db-wal-write-death-resuming-v1'"],
    ],
    [
      'DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE',
      [ts.NodeFlags.Const, "'.gator-db-active-migration-death-preparing-v1'"],
    ],
    [
      'DB_ACTIVE_MIGRATION_DEATH_READY_FILE',
      [ts.NodeFlags.Const, "'.gator-db-active-migration-death-ready-v1'"],
    ],
    [
      'DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE',
      [ts.NodeFlags.Const, "'.gator-db-active-migration-death-resuming-v1'"],
    ],
    ['DB_RELAUNCH_MIGRATION_COUNT', [ts.NodeFlags.Const, '42 as const']],
    ['DB_RELAUNCH_MIGRATION_HEAD', [ts.NodeFlags.Const, "'0042_message_part_identity' as const"]],
    ['WAIT_FOR_HOST_PROCESS_KILL', [ts.NodeFlags.Const, 'new Promise<never>(() => undefined)']],
    ['activeDbRelaunchContract', [ts.NodeFlags.Let, undefined]],
    ['ordinaryBootClaimedProcess', [ts.NodeFlags.Let, 'false']],
  ]);
  const actualRelaunchVariables = relaunchFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) =>
      statement.declarationList.declarations.map((declaration) => ({ declaration, statement })),
    );
  if (
    actualRelaunchVariables.length !== expectedRelaunchVariables.size ||
    actualRelaunchVariables.some(({ declaration, statement }) => {
      if (!ts.isIdentifier(declaration.name)) return true;
      const expected = expectedRelaunchVariables.get(declaration.name.text);
      return (
        !expected ||
        statement.modifiers?.length ||
        !(statement.declarationList.flags & expected[0]) ||
        (declaration.initializer
          ? normalizedSnippet(declaration.initializer, relaunchFile)
          : undefined) !== expected[1]
      );
    })
  ) {
    return undefined;
  }
  const expectedDatabaseVariables = new Map([
    ['DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME', "'driver-runtime-concurrency-selftest.db'"],
    ['DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A', "'db-02c-public-throwaway-key-a-v1'"],
    ['DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B', "'db-02c-public-throwaway-key-b-v1'"],
    ['DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_COUNT', '42 as const'],
    ['DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_HEAD', "'0042_message_part_identity' as const"],
    ['DB_RUNTIME_CONCURRENCY_SENTINEL_KEY', "'gator-db-runtime-wave-sentinel'"],
    ['DB_RUNTIME_CONCURRENCY_SENTINEL_VALUE', "'committed'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_NAME', "'driver-relaunch-selftest.db'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_KEY', "'db-03b1-public-throwaway-key-v1'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_SENTINEL', "'driver-relaunch-continuity-v1'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT', '29'],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_HEAD', "'0029_chats_deleted_at'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_RETRY_MIGRATION_START', "'0030_attachment_cache_entries'"],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT', '42 as const'],
    ['DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD', "'0042_message_part_identity' as const"],
    ['DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME', "'driver-wal-write-death-selftest.db'"],
    ['DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY', "'db-03b2b1-public-throwaway-key-v1'"],
    ['DB_ACTIVE_WAL_WRITE_DEATH_BASELINE', "'db-03b2b1-baseline-v1'"],
    ['DB_ACTIVE_WAL_WRITE_DEATH_RECOVERY', "'db-03b2b1-recovery-v1'"],
    ['DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT', '128'],
    ['DB_ACTIVE_WAL_WRITE_DEATH_CANARY_BYTES', '8_192'],
    ['DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME', "'driver-active-migration-death-selftest.db'"],
    ['DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY', "'db-03b2b2-public-throwaway-key-v1'"],
    ['DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT', '37'],
    ['DB_ACTIVE_MIGRATION_DEATH_PREFIX_HEAD', "'0037_purge_legacy_redacted_mode_setting' as const"],
    ['DB_ACTIVE_MIGRATION_DEATH_TARGET', "'0038_scrub_reaction_selected_message_text' as const"],
    ['DB_ACTIVE_MIGRATION_DEATH_HEAD', "'0042_message_part_identity' as const"],
    ['DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT', '42 as const'],
    ['DB_ACTIVE_MIGRATION_DEATH_TARGET_COUNT', '128'],
    ['DB_ACTIVE_MIGRATION_DEATH_SELECTED_TEXT_LENGTH', '8_192'],
    [
      'DB_ACTIVE_MIGRATION_DEATH_TARGET_SQL',
      "`UPDATE outgoing_queue SET payload = json_remove(payload, '$.selectedMessageText') WHERE kind = 'reaction' AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.selectedMessageText') IS NOT NULL ELSE 0 END`",
    ],
    [
      'DB_ACTIVE_MIGRATION_PREFIX_STOP',
      "Object.freeze({ kind: 'db-active-migration-prefix-ready', })",
    ],
  ]);
  for (const [name, expected] of expectedDatabaseVariables) {
    const state = topLevelVariable(databaseFile, name);
    const statement = state?.declarationList.parent;
    if (
      !state?.declaration.initializer ||
      !(state.declarationList.flags & ts.NodeFlags.Const) ||
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.modifiers?.length ||
      normalizedSnippet(state.declaration.initializer, databaseFile) !== expected
    ) {
      return undefined;
    }
  }
  const cleanup = databaseCallables.get('cleanupDbProcessRelaunchSelfTestDatabase');
  const cleanupRuntimeConcurrency = databaseCallables.get(
    'cleanupDbRuntimeConcurrencySelfTestDatabase',
  );
  const runtimeConcurrencyMigrationNames = databaseCallables.get(
    'dbRuntimeConcurrencyMigrationNames',
  );
  const runRuntimeConcurrencySelfTest = databaseCallables.get('runDbRuntimeConcurrencySelfTest');
  const migrationNames = databaseCallables.get('dbProcessRelaunchMigrationNames');
  const inspectPartial = databaseCallables.get('inspectDbProcessRelaunchPartialState');
  const prepare = databaseCallables.get('prepareDbProcessRelaunchSelfTest');
  const resume = databaseCallables.get('resumeDbProcessRelaunchSelfTest');
  const cleanupWalWriteDeath = databaseCallables.get(
    'cleanupDbActiveWalWriteDeathSelfTestDatabase',
  );
  const retireWalWriteDeath = databaseCallables.get('retireDbActiveWalWriteDeathSelfTestDatabase');
  const prepareWalWriteDeath = databaseCallables.get('prepareDbActiveWalWriteDeathSelfTest');
  const resumeWalWriteDeath = databaseCallables.get('resumeDbActiveWalWriteDeathSelfTest');
  const cleanupActiveMigration = databaseCallables.get(
    'cleanupDbActiveMigrationDeathSelfTestDatabase',
  );
  const retireActiveMigration = databaseCallables.get(
    'retireDbActiveMigrationDeathSelfTestDatabase',
  );
  const prepareActiveMigration = databaseCallables.get('prepareDbActiveMigrationDeathSelfTest');
  const resumeActiveMigration = databaseCallables.get('resumeDbActiveMigrationDeathSelfTest');
  const finishPrepareFailure = relaunchCallables.get('finishPrepareFailure');
  const finishRuntimeConcurrencyFailure = relaunchCallables.get('finishRuntimeConcurrencyFailure');
  const runRuntimeConcurrencyPhase = relaunchCallables.get('runRuntimeConcurrencyPhase');
  const runRuntimeConcurrencyRecoveryPhase = relaunchCallables.get(
    'runRuntimeConcurrencyRecoveryPhase',
  );
  const runPreparePhase = relaunchCallables.get('runPreparePhase');
  const runResumePhase = relaunchCallables.get('runResumePhase');
  const runRecoveryPhase = relaunchCallables.get('runRecoveryPhase');
  const finishWalWriteDeathPrepareFailure = relaunchCallables.get(
    'finishWalWriteDeathPrepareFailure',
  );
  const runWalWriteDeathPreparePhase = relaunchCallables.get('runWalWriteDeathPreparePhase');
  const runWalWriteDeathResumePhase = relaunchCallables.get('runWalWriteDeathResumePhase');
  const runWalWriteDeathRecoveryPhase = relaunchCallables.get('runWalWriteDeathRecoveryPhase');
  const finishActiveMigrationPrepareFailure = relaunchCallables.get(
    'finishActiveMigrationDeathPrepareFailure',
  );
  const runActiveMigrationPreparePhase = relaunchCallables.get(
    'runActiveMigrationDeathPreparePhase',
  );
  const runActiveMigrationResumePhase = relaunchCallables.get('runActiveMigrationDeathResumePhase');
  const runActiveMigrationRecoveryPhase = relaunchCallables.get(
    'runActiveMigrationDeathRecoveryPhase',
  );
  const startContract = relaunchCallables.get('startDevDbRelaunchContractIfRequested');
  const runtimeConcurrencyWave = runtimeWaveCallables.get('runDbRuntimeConcurrencyWave');
  const runtimeConcurrencyCount = runtimeWaveCallables.get('count');
  const submitOrderedCoordinatorWave = runtimeWaveCallables.get('submitOrderedCoordinatorWave');
  const withDbTransaction = topLevelFunction(
    filesByPath,
    'src/db/transaction.ts',
    'withDbTransaction',
  );
  const withDbWriteLock = topLevelFunction(filesByPath, 'src/db/transaction.ts', 'withDbWriteLock');
  const syncAllChats = topLevelFunction(filesByPath, 'src/services/sync/engine.ts', 'syncAllChats');
  const linkHandlesAfterCommit = topLevelFunction(
    filesByPath,
    'src/services/sync/engine.ts',
    'linkHandlesAfterCommit',
  );
  const sendImageMessage = topLevelFunction(
    filesByPath,
    'src/services/send/sendAttachmentService.ts',
    'sendImageMessage',
  );
  const reconcileSendOutcome = topLevelFunction(
    filesByPath,
    'src/services/send/sendOutcome.ts',
    'reconcileSendOutcome',
  );
  const handleSendFailure = topLevelFunction(
    filesByPath,
    'src/services/send/sendOutcome.ts',
    'handleSendFailure',
  );
  const withCurrentDeliveryTransaction = topLevelFunction(
    filesByPath,
    'src/services/realtime/dbEventSink.ts',
    'withCurrentDeliveryTransaction',
  );
  const dbEventSinkConstructor = topLevelClassConstructor(
    filesByPath,
    'src/services/realtime/dbEventSink.ts',
    'DbEventSink',
  );
  const dbEventSinkLinkContacts = topLevelClassMethod(
    filesByPath,
    'src/services/realtime/dbEventSink.ts',
    'DbEventSink',
    'linkContactsAfterCommit',
  );
  const dbEventSinkOnEvent = topLevelClassMethod(
    filesByPath,
    'src/services/realtime/dbEventSink.ts',
    'DbEventSink',
    'onEvent',
  );
  // The runtime wave retains these returned promises until disposable-handle cleanup. Pin the
  // reviewed entry bodies plus the exact contact-link bypass and send-outcome suppression closure,
  // so internal DB/native work cannot become detached while an outer inventory id stays unchanged.
  const runtimeProductionCalleeFingerprints = new Map([
    [syncAllChats, 'e1ae59d2c2e53c2c758eddfcfaca8626e281feaae298237c5f2681f0acf33294'],
    [linkHandlesAfterCommit, '02704855bb63dd6db55395393c6f25fa309d91fdb3aac54422c71ca86fd206b6'],
    [sendImageMessage, '360a1f755ec516935f104ced3e5225ffc6e14b645f536be03e7b00704dca7f5d'],
    [reconcileSendOutcome, 'c8ef12e12a7a116289e00886b0589bfe42abfa5060d7411b650fa323f0a22c8c'],
    [handleSendFailure, 'c7aeae6c332c61990873f7513974be7fa205e35bd422acb57e1a5b6e6e903e3b'],
    [
      withCurrentDeliveryTransaction,
      '08e52d3be405df405ae6ff1f66b29922b89884b05bb0378629c0b6b040ef3330',
    ],
    [dbEventSinkConstructor, '087d0cd2cd9cde22afc602591260d35f760b01178c18ff22a5e9c9ff0b4e7fb6'],
    [dbEventSinkLinkContacts, 'efeff49c6e0d6e74395d05dcf5f3e1f6774decb7fec6e773ea61761d9e01d0e9'],
    [dbEventSinkOnEvent, '30dc8ee01f193a59b8424e1324aac5acc98224209d5d153cb409d0c4ab32d691'],
  ]);
  const startForegroundBoot = topLevelFunction(filesByPath, foregroundPath, 'startForegroundBoot');
  const extractRows = topLevelFunction(filesByPath, databasePath, 'extractRows');
  const opRunner = topLevelFunction(filesByPath, databasePath, 'opRunner');
  const drizzleAdapter = topLevelFunction(filesByPath, databasePath, 'drizzleAdapter');
  const runMigrations = topLevelFunction(filesByPath, 'src/db/migrate.ts', 'runMigrations');
  if (
    !cleanup?.body ||
    !cleanupRuntimeConcurrency?.body ||
    !runtimeConcurrencyMigrationNames?.body ||
    !runRuntimeConcurrencySelfTest?.body ||
    !migrationNames?.body ||
    !inspectPartial?.body ||
    !prepare?.body ||
    !resume?.body ||
    !cleanupWalWriteDeath?.body ||
    !retireWalWriteDeath?.body ||
    !prepareWalWriteDeath?.body ||
    !resumeWalWriteDeath?.body ||
    !cleanupActiveMigration?.body ||
    !retireActiveMigration?.body ||
    !prepareActiveMigration?.body ||
    !resumeActiveMigration?.body ||
    !finishPrepareFailure?.body ||
    !finishRuntimeConcurrencyFailure?.body ||
    !runRuntimeConcurrencyPhase?.body ||
    !runRuntimeConcurrencyRecoveryPhase?.body ||
    !runPreparePhase?.body ||
    !runResumePhase?.body ||
    !runRecoveryPhase?.body ||
    !finishWalWriteDeathPrepareFailure?.body ||
    !runWalWriteDeathPreparePhase?.body ||
    !runWalWriteDeathResumePhase?.body ||
    !runWalWriteDeathRecoveryPhase?.body ||
    !finishActiveMigrationPrepareFailure?.body ||
    !runActiveMigrationPreparePhase?.body ||
    !runActiveMigrationResumePhase?.body ||
    !runActiveMigrationRecoveryPhase?.body ||
    !startContract?.body ||
    !runtimeConcurrencyWave?.body ||
    !runtimeConcurrencyCount?.body ||
    !submitOrderedCoordinatorWave?.body ||
    !withDbTransaction?.body ||
    !withDbWriteLock?.body ||
    !syncAllChats?.body ||
    !sendImageMessage?.body ||
    !dbEventSinkOnEvent?.body ||
    [...runtimeProductionCalleeFingerprints].some(
      ([callable, expected]) =>
        !callable?.body ||
        createHash('sha256')
          .update(normalizedSnippet(callable, callable.getSourceFile()))
          .digest('hex') !== expected,
    ) ||
    !startForegroundBoot?.body ||
    !extractRows?.body ||
    !opRunner?.body ||
    !drizzleAdapter?.body ||
    !runMigrations?.body
  ) {
    return undefined;
  }
  if (
    createHash('sha256')
      .update(normalizedSnippet(startForegroundBoot, foregroundFile))
      .digest('hex') !== 'f9bcb633c6ebc27b8342f226fdf9832e0d057def7ff48d419d599e8d982d3236'
  ) {
    return undefined;
  }

  const openBinding = soleNamedImportBinding(databaseFile, '@op-engineering/op-sqlite', 'open');
  const migrationsBinding = soleNamedImportBinding(databaseFile, './migrations', 'MIGRATIONS');
  if (!openBinding || !migrationsBinding) return undefined;
  const allOpenCalls = directCallsToBinding(databaseFile, openBinding, checker);
  const processOpenCalls = allOpenCalls
    .filter(
      (call) =>
        nodeIsInside(call, cleanup) || nodeIsInside(call, prepare) || nodeIsInside(call, resume),
    )
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedProcessOpenCalls = [
    'open({ name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME })',
    'open({ name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME, encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY, })',
    'open({ name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME, encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY, readOnly: true, })',
    'open({ name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME, encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY, })',
  ];
  if (
    processOpenCalls.length !== expectedProcessOpenCalls.length ||
    processOpenCalls.some(
      (call, index) => normalizedSnippet(call, databaseFile) !== expectedProcessOpenCalls[index],
    )
  ) {
    return undefined;
  }

  const walWriteDeathOpenCalls = allOpenCalls
    .filter(
      (call) =>
        nodeIsInside(call, cleanupWalWriteDeath) ||
        nodeIsInside(call, retireWalWriteDeath) ||
        nodeIsInside(call, prepareWalWriteDeath) ||
        nodeIsInside(call, resumeWalWriteDeath),
    )
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedWalWriteDeathOpenCalls = [
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME })',
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY, readOnly: true, })',
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY, readOnly: true, })',
  ];
  if (
    walWriteDeathOpenCalls.length !== expectedWalWriteDeathOpenCalls.length ||
    walWriteDeathOpenCalls.some(
      (call, index) =>
        normalizedSnippet(call, databaseFile) !== expectedWalWriteDeathOpenCalls[index],
    )
  ) {
    return undefined;
  }
  const activeMigrationOpenCalls = allOpenCalls
    .filter(
      (call) =>
        nodeIsInside(call, cleanupActiveMigration) ||
        nodeIsInside(call, retireActiveMigration) ||
        nodeIsInside(call, prepareActiveMigration) ||
        nodeIsInside(call, resumeActiveMigration),
    )
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedActiveMigrationOpenCalls = [
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME })',
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY, readOnly: true, })',
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY, })',
    'open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME, encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY, readOnly: true, })',
  ];
  if (
    activeMigrationOpenCalls.length !== expectedActiveMigrationOpenCalls.length ||
    activeMigrationOpenCalls.some(
      (call, index) =>
        normalizedSnippet(call, databaseFile) !== expectedActiveMigrationOpenCalls[index],
    )
  ) {
    return undefined;
  }
  const runtimeConcurrencyOpenCalls = allOpenCalls
    .filter(
      (call) =>
        nodeIsInside(call, cleanupRuntimeConcurrency) ||
        nodeIsInside(call, runRuntimeConcurrencySelfTest),
    )
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedRuntimeConcurrencyOpenCalls = [
    'open({ name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME })',
    'open({ name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME, encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A, })',
    'open({ name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME, encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B, readOnly: true, })',
    'open({ name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME, encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A, readOnly: true, })',
  ];
  if (
    runtimeConcurrencyOpenCalls.length !== expectedRuntimeConcurrencyOpenCalls.length ||
    runtimeConcurrencyOpenCalls.some(
      (call, index) =>
        normalizedSnippet(call, databaseFile) !== expectedRuntimeConcurrencyOpenCalls[index],
    )
  ) {
    return undefined;
  }
  const candidateOpenCalls = [
    ...processOpenCalls,
    ...walWriteDeathOpenCalls,
    ...activeMigrationOpenCalls,
    ...runtimeConcurrencyOpenCalls,
  ];

  const migrationCalls = edges
    .filter(
      (edge) =>
        edge.callee === runMigrations &&
        edge.node &&
        (nodeIsInside(edge.node, prepare) || nodeIsInside(edge.node, resume)),
    )
    .map((edge) => edge.node)
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const runnerFactoryCalls = directCallsToBinding(databaseFile, opRunner.name, checker)
    .filter((call) => nodeIsInside(call, prepare) || nodeIsInside(call, resume))
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const walWriteDeathMigrationCalls = edges.filter(
    (edge) =>
      edge.callee === runMigrations &&
      edge.node &&
      (nodeIsInside(edge.node, prepareWalWriteDeath) ||
        nodeIsInside(edge.node, resumeWalWriteDeath) ||
        nodeIsInside(edge.node, retireWalWriteDeath)),
  );
  const walWriteDeathRunnerFactoryCalls = directCallsToBinding(
    databaseFile,
    opRunner.name,
    checker,
  ).filter(
    (call) =>
      nodeIsInside(call, prepareWalWriteDeath) ||
      nodeIsInside(call, resumeWalWriteDeath) ||
      nodeIsInside(call, retireWalWriteDeath),
  );
  const activeMigrationCalls = edges
    .filter(
      (edge) =>
        edge.callee === runMigrations &&
        edge.node &&
        (nodeIsInside(edge.node, prepareActiveMigration) ||
          nodeIsInside(edge.node, resumeActiveMigration)),
    )
    .map((edge) => edge.node)
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const activeMigrationRunnerFactoryCalls = directCallsToBinding(
    databaseFile,
    opRunner.name,
    checker,
  )
    .filter(
      (call) =>
        nodeIsInside(call, prepareActiveMigration) || nodeIsInside(call, resumeActiveMigration),
    )
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const runtimeConcurrencyMigrationCalls = edges
    .filter(
      (edge) =>
        edge.callee === runMigrations &&
        edge.node &&
        nodeIsInside(edge.node, runRuntimeConcurrencySelfTest),
    )
    .map((edge) => edge.node);
  const runtimeConcurrencyRunnerFactoryCalls = directCallsToBinding(
    databaseFile,
    opRunner.name,
    checker,
  ).filter((call) => nodeIsInside(call, runRuntimeConcurrencySelfTest));
  const runtimeConcurrencyAdapterCalls = directCallsToBinding(
    databaseFile,
    drizzleAdapter.name,
    checker,
  ).filter((call) => nodeIsInside(call, runRuntimeConcurrencySelfTest));
  const runtimeConcurrencyAdapterCall = runtimeConcurrencyAdapterCalls[0];
  const runtimeConcurrencyDrizzleCall = runtimeConcurrencyAdapterCall?.parent;
  const drizzleBinding = soleNamedImportBinding(databaseFile, 'drizzle-orm/op-sqlite', 'drizzle');
  const prefixRunner = databaseCallables.get('dbActiveMigrationPrefixRunner');
  const crashRunner = databaseCallables.get('dbActiveMigrationCrashRunner');
  const prefixRunnerCalls = directCallsToBinding(databaseFile, prefixRunner.name, checker).filter(
    (call) => nodeIsInside(call, prepareActiveMigration),
  );
  const crashRunnerCalls = directCallsToBinding(databaseFile, crashRunner.name, checker).filter(
    (call) => nodeIsInside(call, prepareActiveMigration),
  );
  const prefixRunnerCall = prefixRunnerCalls[0];
  const crashRunnerCall = crashRunnerCalls[0];
  if (
    migrationCalls.length !== 3 ||
    runnerFactoryCalls.length !== 3 ||
    walWriteDeathMigrationCalls.length !== 0 ||
    walWriteDeathRunnerFactoryCalls.length !== 0 ||
    migrationCalls.some((call, index) => {
      const runnerCall = runnerFactoryCalls[index];
      return (
        !runnerCall ||
        call.arguments.length !== 1 ||
        call.arguments[0] !== runnerCall ||
        runnerCall.parent !== call ||
        !ts.isAwaitExpression(call.parent)
      );
    }) ||
    activeMigrationCalls.length !== 4 ||
    activeMigrationRunnerFactoryCalls.length !== 4 ||
    prefixRunnerCalls.length !== 1 ||
    crashRunnerCalls.length !== 1 ||
    !prefixRunnerCall ||
    !crashRunnerCall ||
    activeMigrationCalls[0]?.arguments[0] !== prefixRunnerCall ||
    prefixRunnerCall.parent !== activeMigrationCalls[0] ||
    prefixRunnerCall.arguments.length !== 1 ||
    prefixRunnerCall.arguments[0] !== activeMigrationRunnerFactoryCalls[0] ||
    activeMigrationRunnerFactoryCalls[0]?.parent !== prefixRunnerCall ||
    activeMigrationCalls[1]?.arguments[0] !== crashRunnerCall ||
    crashRunnerCall.parent !== activeMigrationCalls[1] ||
    crashRunnerCall.arguments.length !== 2 ||
    crashRunnerCall.arguments[0] !== activeMigrationRunnerFactoryCalls[1] ||
    activeMigrationRunnerFactoryCalls[1]?.parent !== crashRunnerCall ||
    activeMigrationCalls[2]?.arguments[0] !== activeMigrationRunnerFactoryCalls[2] ||
    activeMigrationRunnerFactoryCalls[2]?.parent !== activeMigrationCalls[2] ||
    activeMigrationCalls[3]?.arguments[0] !== activeMigrationRunnerFactoryCalls[3] ||
    activeMigrationRunnerFactoryCalls[3]?.parent !== activeMigrationCalls[3] ||
    activeMigrationCalls.some(
      (call) => call.arguments.length !== 1 || !ts.isAwaitExpression(call.parent),
    ) ||
    normalizedSnippet(activeMigrationCalls[2], databaseFile) !==
      'runMigrations(opRunner(reopened))' ||
    normalizedSnippet(activeMigrationCalls[3], databaseFile) !==
      'runMigrations(opRunner(reopened))' ||
    runtimeConcurrencyMigrationCalls.length !== 1 ||
    runtimeConcurrencyRunnerFactoryCalls.length !== 1 ||
    runtimeConcurrencyMigrationCalls[0]?.arguments.length !== 1 ||
    runtimeConcurrencyMigrationCalls[0]?.arguments[0] !== runtimeConcurrencyRunnerFactoryCalls[0] ||
    runtimeConcurrencyRunnerFactoryCalls[0]?.parent !== runtimeConcurrencyMigrationCalls[0] ||
    !ts.isAwaitExpression(runtimeConcurrencyMigrationCalls[0]?.parent) ||
    normalizedSnippet(runtimeConcurrencyMigrationCalls[0], databaseFile) !==
      'runMigrations(opRunner(activeHandle))' ||
    runtimeConcurrencyAdapterCalls.length !== 1 ||
    !runtimeConcurrencyAdapterCall ||
    runtimeConcurrencyAdapterCall.arguments.length !== 1 ||
    !identifierNamed(runtimeConcurrencyAdapterCall.arguments[0], 'activeHandle') ||
    !runtimeConcurrencyDrizzleCall ||
    !ts.isCallExpression(runtimeConcurrencyDrizzleCall) ||
    runtimeConcurrencyDrizzleCall.arguments.length !== 1 ||
    runtimeConcurrencyDrizzleCall.arguments[0] !== runtimeConcurrencyAdapterCall ||
    !drizzleBinding ||
    !sameSymbol(
      unwrapExpression(runtimeConcurrencyDrizzleCall.expression),
      drizzleBinding,
      checker,
    ) ||
    normalizedSnippet(runtimeConcurrencyDrizzleCall, databaseFile) !==
      'drizzle(drizzleAdapter(activeHandle))'
  ) {
    return undefined;
  }

  const processExtractCalls = directCallsToBinding(databaseFile, extractRows.name, checker).filter(
    (call) => nodeIsInside(call, inspectPartial) || nodeIsInside(call, resume),
  );
  const walWriteDeathExtractCalls = directCallsToBinding(
    databaseFile,
    extractRows.name,
    checker,
  ).filter(
    (call) =>
      nodeIsInside(call, databaseCallables.get('inspectDbActiveWalWriteDeathState')) ||
      nodeIsInside(call, retireWalWriteDeath) ||
      nodeIsInside(call, prepareWalWriteDeath) ||
      nodeIsInside(call, resumeWalWriteDeath),
  );
  const activeMigrationExtractCalls = directCallsToBinding(
    databaseFile,
    extractRows.name,
    checker,
  ).filter(
    (call) =>
      nodeIsInside(call, databaseCallables.get('inspectDbActiveMigrationState')) ||
      nodeIsInside(call, retireActiveMigration) ||
      nodeIsInside(call, prepareActiveMigration) ||
      nodeIsInside(call, resumeActiveMigration),
  );
  const runtimeConcurrencyExtractCalls = directCallsToBinding(
    databaseFile,
    extractRows.name,
    checker,
  ).filter((call) => nodeIsInside(call, runRuntimeConcurrencySelfTest));
  if (
    processExtractCalls.length !== 8 ||
    walWriteDeathExtractCalls.length !== 11 ||
    activeMigrationExtractCalls.length !== 15 ||
    runtimeConcurrencyExtractCalls.length !== 4
  ) {
    return undefined;
  }
  const extractCalls = [
    ...processExtractCalls,
    ...walWriteDeathExtractCalls,
    ...activeMigrationExtractCalls,
    ...runtimeConcurrencyExtractCalls,
  ];

  const migrationListReferences = runtimeReferencesToBinding(
    databaseFile,
    migrationsBinding,
    checker,
  );
  const migrationListCall = migrationListReferences
    .map((reference) => {
      const access = reference.parent;
      return access &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === reference &&
        access.name.text === 'map'
        ? callExpression(access.parent)
        : undefined;
    })
    .find((call) => call && nodeIsInside(call, migrationNames));
  if (
    !migrationListCall ||
    migrationListCall.arguments.length !== 1 ||
    normalizedSnippet(migrationListCall.arguments[0], databaseFile) !==
      '(migration) => migration.name'
  ) {
    return undefined;
  }
  const activeMigrationNameReferences = migrationListReferences.filter((reference) =>
    nodeIsInside(reference, databaseCallables.get('dbActiveMigrationNames')),
  );
  const runtimeConcurrencyMigrationReferences = migrationListReferences.filter((reference) =>
    nodeIsInside(reference, runtimeConcurrencyMigrationNames),
  );
  const processMigrationReferences = migrationListReferences.filter(
    (reference) =>
      nodeIsInside(reference, migrationNames) ||
      nodeIsInside(reference, databaseCallables.get('dbActiveMigrationNames')) ||
      nodeIsInside(reference, runtimeConcurrencyMigrationNames),
  );
  if (
    activeMigrationNameReferences.length !== 2 ||
    runtimeConcurrencyMigrationReferences.length !== 1 ||
    processMigrationReferences.length !== 4 ||
    !activeMigrationNameReferences.some(
      (reference) =>
        ts.isElementAccessExpression(reference.parent) && reference.parent.expression === reference,
    )
  ) {
    return undefined;
  }

  const cleanupPrepareEdges = exactCallEdges(edges, prepare, cleanup);
  const cleanupResumeEdges = exactCallEdges(edges, resume, cleanup);
  const cleanupFailureEdges = exactCallEdges(edges, finishPrepareFailure, cleanup);
  const cleanupResumeServiceEdges = exactCallEdges(edges, runResumePhase, cleanup);
  const cleanupRecoveryEdges = exactCallEdges(edges, runRecoveryPhase, cleanup);
  const finishEdges = exactCallEdges(edges, runPreparePhase, finishPrepareFailure);
  const prepareEdges = exactCallEdges(edges, runPreparePhase, prepare);
  const resumeEdges = exactCallEdges(edges, runResumePhase, resume);
  const startPrepareEdges = exactCallEdges(edges, startContract, runPreparePhase);
  const startResumeEdges = exactCallEdges(edges, startContract, runResumePhase);
  const startRecoveryEdges = exactCallEdges(edges, startContract, runRecoveryPhase);
  const cleanupWalWriteDeathPrepareEdges = exactCallEdges(
    edges,
    prepareWalWriteDeath,
    cleanupWalWriteDeath,
  );
  const cleanupWalWriteDeathResumeEdges = exactCallEdges(
    edges,
    resumeWalWriteDeath,
    cleanupWalWriteDeath,
  );
  const retireWalWriteDeathResumeEdges = exactCallEdges(
    edges,
    resumeWalWriteDeath,
    retireWalWriteDeath,
  );
  const cleanupWalWriteDeathRetireEdges = exactCallEdges(
    edges,
    retireWalWriteDeath,
    cleanupWalWriteDeath,
  );
  const cleanupWalWriteDeathOldRecoveryEdges = exactCallEdges(
    edges,
    runRecoveryPhase,
    cleanupWalWriteDeath,
  );
  const cleanupWalWriteDeathFailureEdges = exactCallEdges(
    edges,
    finishWalWriteDeathPrepareFailure,
    cleanupWalWriteDeath,
  );
  const finishWalWriteDeathEdges = exactCallEdges(
    edges,
    runWalWriteDeathPreparePhase,
    finishWalWriteDeathPrepareFailure,
  );
  const prepareWalWriteDeathEdges = exactCallEdges(
    edges,
    runWalWriteDeathPreparePhase,
    prepareWalWriteDeath,
  );
  const resumeWalWriteDeathEdges = exactCallEdges(
    edges,
    runWalWriteDeathResumePhase,
    resumeWalWriteDeath,
  );
  const cleanupWalWriteDeathResumeServiceEdges = exactCallEdges(
    edges,
    runWalWriteDeathResumePhase,
    cleanupWalWriteDeath,
  );
  const cleanupOldWalWriteDeathRecoveryEdges = exactCallEdges(
    edges,
    runWalWriteDeathRecoveryPhase,
    cleanup,
  );
  const cleanupWalWriteDeathRecoveryEdges = exactCallEdges(
    edges,
    runWalWriteDeathRecoveryPhase,
    cleanupWalWriteDeath,
  );
  const startWalWriteDeathPrepareEdges = exactCallEdges(
    edges,
    startContract,
    runWalWriteDeathPreparePhase,
  );
  const startWalWriteDeathResumeEdges = exactCallEdges(
    edges,
    startContract,
    runWalWriteDeathResumePhase,
  );
  const startWalWriteDeathRecoveryEdges = exactCallEdges(
    edges,
    startContract,
    runWalWriteDeathRecoveryPhase,
  );
  const cleanupActiveMigrationPrepareEdges = exactCallEdges(
    edges,
    prepareActiveMigration,
    cleanupActiveMigration,
  );
  const cleanupActiveMigrationResumeEdges = exactCallEdges(
    edges,
    resumeActiveMigration,
    cleanupActiveMigration,
  );
  const retireActiveMigrationResumeEdges = exactCallEdges(
    edges,
    resumeActiveMigration,
    retireActiveMigration,
  );
  const cleanupActiveMigrationRetireEdges = exactCallEdges(
    edges,
    retireActiveMigration,
    cleanupActiveMigration,
  );
  const seedActiveMigrationPrepareEdges = exactCallEdges(
    edges,
    prepareActiveMigration,
    databaseCallables.get('seedDbActiveMigrationFixture'),
  );
  const cleanupActiveMigrationOldRecoveryEdges = exactCallEdges(
    edges,
    runRecoveryPhase,
    cleanupActiveMigration,
  );
  const cleanupActiveMigrationWalRecoveryEdges = exactCallEdges(
    edges,
    runWalWriteDeathRecoveryPhase,
    cleanupActiveMigration,
  );
  const cleanupOldActiveMigrationRecoveryEdges = exactCallEdges(
    edges,
    runActiveMigrationRecoveryPhase,
    cleanup,
  );
  const cleanupWalActiveMigrationRecoveryEdges = exactCallEdges(
    edges,
    runActiveMigrationRecoveryPhase,
    cleanupWalWriteDeath,
  );
  const cleanupActiveMigrationFailureEdges = exactCallEdges(
    edges,
    finishActiveMigrationPrepareFailure,
    cleanupActiveMigration,
  );
  const finishActiveMigrationEdges = exactCallEdges(
    edges,
    runActiveMigrationPreparePhase,
    finishActiveMigrationPrepareFailure,
  );
  const prepareActiveMigrationEdges = exactCallEdges(
    edges,
    runActiveMigrationPreparePhase,
    prepareActiveMigration,
  );
  const resumeActiveMigrationEdges = exactCallEdges(
    edges,
    runActiveMigrationResumePhase,
    resumeActiveMigration,
  );
  const cleanupActiveMigrationResumeServiceEdges = exactCallEdges(
    edges,
    runActiveMigrationResumePhase,
    cleanupActiveMigration,
  );
  const cleanupActiveMigrationRecoveryEdges = exactCallEdges(
    edges,
    runActiveMigrationRecoveryPhase,
    cleanupActiveMigration,
  );
  const startActiveMigrationPrepareEdges = exactCallEdges(
    edges,
    startContract,
    runActiveMigrationPreparePhase,
  );
  const startActiveMigrationResumeEdges = exactCallEdges(
    edges,
    startContract,
    runActiveMigrationResumePhase,
  );
  const startActiveMigrationRecoveryEdges = exactCallEdges(
    edges,
    startContract,
    runActiveMigrationRecoveryPhase,
  );
  const cleanupRuntimeConcurrencyDatabaseEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencySelfTest,
    cleanupRuntimeConcurrency,
  );
  const cleanupRuntimeConcurrencyFailureEdges = exactCallEdges(
    edges,
    finishRuntimeConcurrencyFailure,
    cleanupRuntimeConcurrency,
  );
  const finishRuntimeConcurrencyEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyPhase,
    finishRuntimeConcurrencyFailure,
  );
  const runRuntimeConcurrencyDatabaseEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyPhase,
    runRuntimeConcurrencySelfTest,
  );
  const cleanupOldRuntimeConcurrencyRecoveryEdges = exactCallEdges(
    edges,
    runRecoveryPhase,
    cleanupRuntimeConcurrency,
  );
  const cleanupWalRuntimeConcurrencyRecoveryEdges = exactCallEdges(
    edges,
    runWalWriteDeathRecoveryPhase,
    cleanupRuntimeConcurrency,
  );
  const cleanupActiveRuntimeConcurrencyRecoveryEdges = exactCallEdges(
    edges,
    runActiveMigrationRecoveryPhase,
    cleanupRuntimeConcurrency,
  );
  const cleanupRuntimeConcurrencyOldRecoveryEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyRecoveryPhase,
    cleanup,
  );
  const cleanupRuntimeConcurrencyWalRecoveryEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyRecoveryPhase,
    cleanupWalWriteDeath,
  );
  const cleanupRuntimeConcurrencyActiveRecoveryEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyRecoveryPhase,
    cleanupActiveMigration,
  );
  const cleanupRuntimeConcurrencyRecoveryEdges = exactCallEdges(
    edges,
    runRuntimeConcurrencyRecoveryPhase,
    cleanupRuntimeConcurrency,
  );
  const startRuntimeConcurrencyEdges = exactCallEdges(
    edges,
    startContract,
    runRuntimeConcurrencyPhase,
  );
  const startRuntimeConcurrencyRecoveryEdges = exactCallEdges(
    edges,
    startContract,
    runRuntimeConcurrencyRecoveryPhase,
  );
  const foregroundEdges = exactCallEdges(edges, startForegroundBoot, startContract);
  const expectedCleanupEdges = [
    ...cleanupPrepareEdges,
    ...cleanupResumeEdges,
    ...cleanupFailureEdges,
    ...cleanupResumeServiceEdges,
    ...cleanupRecoveryEdges,
    ...cleanupOldWalWriteDeathRecoveryEdges,
    ...cleanupOldActiveMigrationRecoveryEdges,
    ...cleanupRuntimeConcurrencyOldRecoveryEdges,
  ];
  const expectedWalWriteDeathCleanupEdges = [
    ...cleanupWalWriteDeathPrepareEdges,
    ...cleanupWalWriteDeathResumeEdges,
    ...cleanupWalWriteDeathRetireEdges,
    ...cleanupWalWriteDeathOldRecoveryEdges,
    ...cleanupWalWriteDeathFailureEdges,
    ...cleanupWalWriteDeathResumeServiceEdges,
    ...cleanupWalWriteDeathRecoveryEdges,
    ...cleanupWalActiveMigrationRecoveryEdges,
    ...cleanupRuntimeConcurrencyWalRecoveryEdges,
  ];
  const expectedActiveMigrationCleanupEdges = [
    ...cleanupActiveMigrationPrepareEdges,
    ...cleanupActiveMigrationResumeEdges,
    ...cleanupActiveMigrationRetireEdges,
    ...cleanupActiveMigrationOldRecoveryEdges,
    ...cleanupActiveMigrationWalRecoveryEdges,
    ...cleanupActiveMigrationFailureEdges,
    ...cleanupActiveMigrationResumeServiceEdges,
    ...cleanupActiveMigrationRecoveryEdges,
    ...cleanupRuntimeConcurrencyActiveRecoveryEdges,
  ];
  const expectedRuntimeConcurrencyCleanupEdges = [
    ...cleanupRuntimeConcurrencyDatabaseEdges,
    ...cleanupRuntimeConcurrencyFailureEdges,
    ...cleanupOldRuntimeConcurrencyRecoveryEdges,
    ...cleanupWalRuntimeConcurrencyRecoveryEdges,
    ...cleanupActiveRuntimeConcurrencyRecoveryEdges,
    ...cleanupRuntimeConcurrencyRecoveryEdges,
  ];
  if (
    cleanupPrepareEdges.length !== 2 ||
    cleanupResumeEdges.length !== 1 ||
    cleanupFailureEdges.length !== 1 ||
    cleanupResumeServiceEdges.length !== 1 ||
    cleanupRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === cleanup).length !== expectedCleanupEdges.length ||
    cleanupWalWriteDeathPrepareEdges.length !== 2 ||
    cleanupWalWriteDeathResumeEdges.length !== 1 ||
    retireWalWriteDeathResumeEdges.length !== 1 ||
    cleanupWalWriteDeathRetireEdges.length !== 1 ||
    cleanupWalWriteDeathOldRecoveryEdges.length !== 1 ||
    cleanupWalWriteDeathFailureEdges.length !== 1 ||
    cleanupWalWriteDeathResumeServiceEdges.length !== 1 ||
    cleanupOldWalWriteDeathRecoveryEdges.length !== 1 ||
    cleanupWalWriteDeathRecoveryEdges.length !== 1 ||
    cleanupOldActiveMigrationRecoveryEdges.length !== 1 ||
    cleanupWalActiveMigrationRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === cleanupWalWriteDeath).length !==
      expectedWalWriteDeathCleanupEdges.length ||
    edges.filter((edge) => edge.callee === retireWalWriteDeath).length !== 1 ||
    finishEdges.length !== 3 ||
    edges.filter((edge) => edge.callee === finishPrepareFailure).length !== 3 ||
    prepareEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === prepare).length !== 1 ||
    resumeEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === resume).length !== 1 ||
    startPrepareEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runPreparePhase).length !== 1 ||
    startResumeEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runResumePhase).length !== 1 ||
    startRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runRecoveryPhase).length !== 1 ||
    finishWalWriteDeathEdges.length !== 3 ||
    edges.filter((edge) => edge.callee === finishWalWriteDeathPrepareFailure).length !== 3 ||
    prepareWalWriteDeathEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === prepareWalWriteDeath).length !== 1 ||
    resumeWalWriteDeathEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === resumeWalWriteDeath).length !== 1 ||
    startWalWriteDeathPrepareEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runWalWriteDeathPreparePhase).length !== 1 ||
    startWalWriteDeathResumeEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runWalWriteDeathResumePhase).length !== 1 ||
    startWalWriteDeathRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runWalWriteDeathRecoveryPhase).length !== 1 ||
    cleanupActiveMigrationPrepareEdges.length !== 3 ||
    cleanupActiveMigrationResumeEdges.length !== 1 ||
    retireActiveMigrationResumeEdges.length !== 1 ||
    cleanupActiveMigrationRetireEdges.length !== 1 ||
    seedActiveMigrationPrepareEdges.length !== 1 ||
    cleanupActiveMigrationOldRecoveryEdges.length !== 1 ||
    cleanupActiveMigrationWalRecoveryEdges.length !== 1 ||
    cleanupActiveMigrationFailureEdges.length !== 1 ||
    cleanupActiveMigrationResumeServiceEdges.length !== 1 ||
    cleanupActiveMigrationRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === cleanupActiveMigration).length !==
      expectedActiveMigrationCleanupEdges.length ||
    edges.filter((edge) => edge.callee === retireActiveMigration).length !== 1 ||
    edges.filter((edge) => edge.callee === databaseCallables.get('seedDbActiveMigrationFixture'))
      .length !== 1 ||
    finishActiveMigrationEdges.length !== 3 ||
    edges.filter((edge) => edge.callee === finishActiveMigrationPrepareFailure).length !== 3 ||
    prepareActiveMigrationEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === prepareActiveMigration).length !== 1 ||
    resumeActiveMigrationEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === resumeActiveMigration).length !== 1 ||
    startActiveMigrationPrepareEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runActiveMigrationPreparePhase).length !== 1 ||
    startActiveMigrationResumeEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runActiveMigrationResumePhase).length !== 1 ||
    startActiveMigrationRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runActiveMigrationRecoveryPhase).length !== 1 ||
    cleanupRuntimeConcurrencyDatabaseEdges.length !== 2 ||
    cleanupRuntimeConcurrencyFailureEdges.length !== 1 ||
    cleanupOldRuntimeConcurrencyRecoveryEdges.length !== 1 ||
    cleanupWalRuntimeConcurrencyRecoveryEdges.length !== 1 ||
    cleanupActiveRuntimeConcurrencyRecoveryEdges.length !== 1 ||
    cleanupRuntimeConcurrencyOldRecoveryEdges.length !== 1 ||
    cleanupRuntimeConcurrencyWalRecoveryEdges.length !== 1 ||
    cleanupRuntimeConcurrencyActiveRecoveryEdges.length !== 1 ||
    cleanupRuntimeConcurrencyRecoveryEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === cleanupRuntimeConcurrency).length !==
      expectedRuntimeConcurrencyCleanupEdges.length ||
    finishRuntimeConcurrencyEdges.length !== 2 ||
    edges.filter((edge) => edge.callee === finishRuntimeConcurrencyFailure).length !== 2 ||
    runRuntimeConcurrencyDatabaseEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runRuntimeConcurrencySelfTest).length !== 1 ||
    startRuntimeConcurrencyEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === runRuntimeConcurrencyPhase).length !== 1 ||
    startRuntimeConcurrencyRecoveryEdges.length !== 2 ||
    edges.filter((edge) => edge.callee === runRuntimeConcurrencyRecoveryPhase).length !== 2 ||
    foregroundEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === startContract).length !== 1
  ) {
    return undefined;
  }

  const runtimeWaveReferences = referenceEdges.filter(
    (reference) => reference.target === runtimeConcurrencyWave,
  );
  const runtimeWaveReference = runtimeWaveReferences[0];
  if (
    runtimeWaveReferences.length !== 1 ||
    !runtimeWaveReference ||
    runtimeWaveReference.caller !== runRuntimeConcurrencyPhase ||
    runtimeWaveReference.node.parent !== runRuntimeConcurrencyDatabaseEdges[0]?.node ||
    runRuntimeConcurrencyDatabaseEdges[0]?.node.arguments[0] !== runtimeWaveReference.node
  ) {
    return undefined;
  }

  const runtimeWaveOwnerIsProtected = (callable) =>
    callable &&
    [submitOrderedCoordinatorWave, runtimeConcurrencyWave].some((owner) =>
      callableIsInside(callable, owner),
    );
  const runtimeWaveEdgesTo = (callee) =>
    edges.filter((edge) => runtimeWaveOwnerIsProtected(edge.caller) && edge.callee === callee);
  const runtimeWaveTransactionEdges = runtimeWaveEdgesTo(withDbTransaction);
  const runtimeWaveLockEdges = runtimeWaveEdgesTo(withDbWriteLock);
  const runtimeWaveCountEdges = runtimeWaveEdgesTo(runtimeConcurrencyCount);
  const runtimeWaveSubmitEdges = runtimeWaveEdgesTo(submitOrderedCoordinatorWave);
  const runtimeWaveSyncEdges = runtimeWaveEdgesTo(syncAllChats);
  const runtimeWaveSendEdges = runtimeWaveEdgesTo(sendImageMessage);
  const runtimeWaveEventEdges = runtimeWaveEdgesTo(dbEventSinkOnEvent);
  const allSendImageEdges = edges.filter((edge) => edge.callee === sendImageMessage);
  const productionSendImageEdges = allSendImageEdges.filter(
    (edge) => edge !== runtimeWaveSendEdges[0],
  );
  const isDirectUnspreadCallEdge = (edge, callee) =>
    edge.callee === callee &&
    callableNodeForExpression(edge.node.expression, checker) === callee &&
    !edge.node.arguments.some(ts.isSpreadElement);
  const allReconcileEdges = edges.filter((edge) => edge.callee === reconcileSendOutcome);
  const allFailureEdges = edges.filter((edge) => edge.callee === handleSendFailure);
  const directReconcileEdges = allReconcileEdges.filter((edge) =>
    isDirectUnspreadCallEdge(edge, reconcileSendOutcome),
  );
  const directFailureEdges = allFailureEdges.filter((edge) =>
    isDirectUnspreadCallEdge(edge, handleSendFailure),
  );
  const optionedReconcileEdges = directReconcileEdges.filter(
    (edge) => edge.node.arguments.length >= 6,
  );
  const optionedFailureEdges = directFailureEdges.filter((edge) => edge.node.arguments.length >= 8);
  const runtimeSendNode = runtimeWaveSendEdges[0]?.node;
  const runtimeSendOptions = runtimeSendNode?.arguments[6];
  const runtimeWaveCallNodes = [
    ...runtimeWaveTransactionEdges,
    ...runtimeWaveLockEdges,
    ...runtimeWaveCountEdges,
    ...runtimeWaveSubmitEdges,
    ...runtimeWaveSyncEdges,
    ...runtimeWaveSendEdges,
    ...runtimeWaveEventEdges,
  ].map((edge) => edge.node);
  if (
    runtimeWaveTransactionEdges.length !== 4 ||
    runtimeWaveLockEdges.length !== 1 ||
    runtimeWaveCountEdges.length !== 15 ||
    runtimeWaveSubmitEdges.length !== 1 ||
    runtimeWaveSyncEdges.length !== 2 ||
    runtimeWaveSendEdges.length !== 1 ||
    runtimeWaveEventEdges.length !== 1 ||
    allSendImageEdges.length !== 3 ||
    allSendImageEdges.some((edge) => edge.node.arguments.some(ts.isSpreadElement)) ||
    productionSendImageEdges.length !== 2 ||
    productionSendImageEdges.some(
      (edge) =>
        edge.node.arguments.length !== 8 ||
        !identifierNamed(edge.node.arguments[6], 'undefined') ||
        !identifierNamed(edge.node.arguments[7], 'pasteOwnership'),
    ) ||
    directReconcileEdges.length !== allReconcileEdges.length ||
    directFailureEdges.length !== allFailureEdges.length ||
    !runtimeSendNode ||
    runtimeSendNode.arguments.length !== 7 ||
    !runtimeSendOptions ||
    normalizedSnippet(runtimeSendOptions, runtimeWaveFile) !==
      "{ failureNoticeMode: 'suppressed' }" ||
    optionedReconcileEdges.length !== 1 ||
    optionedReconcileEdges[0]?.caller !== sendImageMessage ||
    !identifierNamed(optionedReconcileEdges[0]?.node.arguments[5], 'outcomeOptions') ||
    optionedFailureEdges.length !== 1 ||
    optionedFailureEdges[0]?.caller !== sendImageMessage ||
    !identifierNamed(optionedFailureEdges[0]?.node.arguments[7], 'outcomeOptions') ||
    edges.filter((edge) => edge.callee === runtimeConcurrencyCount).length !== 15 ||
    edges.filter((edge) => edge.callee === submitOrderedCoordinatorWave).length !== 1 ||
    edges.filter((edge) => edge.callee === runtimeConcurrencyWave).length !== 0 ||
    runtimeWaveCallNodes.length !== 25 ||
    new Set(runtimeWaveCallNodes).size !== 25
  ) {
    return undefined;
  }

  const protectedTargets = new Set([
    cleanup,
    cleanupRuntimeConcurrency,
    runtimeConcurrencyMigrationNames,
    runRuntimeConcurrencySelfTest,
    prepare,
    resume,
    cleanupWalWriteDeath,
    retireWalWriteDeath,
    prepareWalWriteDeath,
    resumeWalWriteDeath,
    ...databaseCallableNames
      .filter((name) => name.includes('ActiveMigration'))
      .map((name) => databaseCallables.get(name)),
    finishPrepareFailure,
    runPreparePhase,
    runResumePhase,
    runRecoveryPhase,
    finishWalWriteDeathPrepareFailure,
    runWalWriteDeathPreparePhase,
    runWalWriteDeathResumePhase,
    runWalWriteDeathRecoveryPhase,
    cleanupActiveMigration,
    retireActiveMigration,
    prepareActiveMigration,
    resumeActiveMigration,
    finishActiveMigrationPrepareFailure,
    runActiveMigrationPreparePhase,
    runActiveMigrationResumePhase,
    runActiveMigrationRecoveryPhase,
    finishRuntimeConcurrencyFailure,
    runRuntimeConcurrencyPhase,
    runRuntimeConcurrencyRecoveryPhase,
    ...runtimeWaveCallables.values(),
    startContract,
  ]);
  const expectedGlobalReferenceCounts = [
    [cleanup, 10],
    [cleanupRuntimeConcurrency, 8],
    [runRuntimeConcurrencySelfTest, 2],
    [prepare, 2],
    [resume, 2],
    [cleanupWalWriteDeath, 11],
    [prepareWalWriteDeath, 2],
    [resumeWalWriteDeath, 2],
    [cleanupActiveMigration, 12],
    [prepareActiveMigration, 2],
    [resumeActiveMigration, 2],
    [startContract, 2],
  ];
  const globalReferences = runtimeReferencesToBindings(
    filesByPath.values(),
    expectedGlobalReferenceCounts.map(([callable]) => callable.name),
    checker,
  );
  const expectedLocalReferenceCounts = [
    [databaseCallables.get('emptyDbRuntimeConcurrencyDatabaseChecks'), 2],
    [runtimeConcurrencyMigrationNames, 2],
    [databaseCallables.get('firstDbRuntimeConcurrencyWaveFailure'), 2],
    [databaseCallables.get('emptyDbActiveWalWriteDeathPrepareChecks'), 2],
    [databaseCallables.get('emptyDbActiveWalWriteDeathResumeChecks'), 2],
    [databaseCallables.get('pragmaContainsString'), 11],
    [databaseCallables.get('isSuccessfulTruncateCheckpoint'), 5],
    [databaseCallables.get('inspectDbActiveWalWriteDeathState'), 5],
    [retireWalWriteDeath, 2],
    [databaseCallables.get('emptyDbActiveMigrationDeathPrepareChecks'), 2],
    [databaseCallables.get('emptyDbActiveMigrationDeathResumeChecks'), 2],
    [databaseCallables.get('dbActiveMigrationNames'), 4],
    [databaseCallables.get('dbActiveMigrationFixtureRows'), 3],
    [databaseCallables.get('hasExactDbActiveMigrationFixture'), 3],
    [databaseCallables.get('evaluateDbActiveMigrationState'), 3],
    [databaseCallables.get('inspectDbActiveMigrationState'), 6],
    [databaseCallables.get('inspectDbActiveMigrationRunnerState'), 2],
    [prefixRunner, 2],
    [crashRunner, 2],
    [databaseCallables.get('seedDbActiveMigrationFixture'), 2],
    [retireActiveMigration, 2],
  ];
  const runtimeCapabilityOwners = new Set([
    cleanupRuntimeConcurrency,
    runRuntimeConcurrencySelfTest,
    finishRuntimeConcurrencyFailure,
    runRuntimeConcurrencyPhase,
    runRuntimeConcurrencyRecoveryPhase,
    ...runtimeWaveCallables.values(),
  ]);
  const runtimeCapabilityOwnerIsProtected = (callable) =>
    callable && [...runtimeCapabilityOwners].some((owner) => callableIsInside(callable, owner));
  if (
    !globalReferences ||
    expectedGlobalReferenceCounts.some(([callable, expectedCount]) => {
      const references = globalReferences.get(callable.name);
      return references.length !== expectedCount || !references.includes(callable.name);
    }) ||
    expectedLocalReferenceCounts.some(([callable, expectedCount]) => {
      const references = runtimeReferencesToBinding(databaseFile, callable.name, checker);
      return (
        callable.modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword,
        ) ||
        references.length !== expectedCount ||
        !references.includes(callable.name)
      );
    }) ||
    referenceEdges.some(
      (reference) =>
        typeof reference.target !== 'string' &&
        protectedTargets.has(reference.target) &&
        reference !== runtimeWaveReference,
    ) ||
    referenceEdges.some(
      (reference) =>
        runtimeCapabilityOwnerIsProtected(reference.caller) && reference !== runtimeWaveReference,
    ) ||
    dynamicCallbacks.some((callback) => runtimeCapabilityOwnerIsProtected(callback.caller)) ||
    dynamicDispatches.some((dispatch) => runtimeCapabilityOwnerIsProtected(dispatch.caller)) ||
    hasNonStaticModuleSpecifierOfPath(filesByPath, databasePath) ||
    hasNonStaticModuleSpecifierOfPath(filesByPath, relaunchPath) ||
    hasNonStaticModuleSpecifierOfPath(filesByPath, runtimeWavePath)
  ) {
    return undefined;
  }

  const protectedOwners = new Set([
    cleanup,
    prepare,
    resume,
    cleanupWalWriteDeath,
    retireWalWriteDeath,
    prepareWalWriteDeath,
    resumeWalWriteDeath,
    ...databaseCallableNames
      .filter((name) => name.includes('ActiveMigration'))
      .map((name) => databaseCallables.get(name)),
  ]);
  const rawFindings = findings.filter((finding) => {
    const callable = findingCallables.get(finding.id);
    return callable && protectedOwners.has(callable) && finding.operation !== 'mutator-call';
  });
  const findingSignature = (finding) =>
    `${callableDisplayName(findingCallables.get(finding.id))}|${finding.operation}|${finding.target}`;
  const expectedRawFindingSignatures = [
    'cleanupDbProcessRelaunchSelfTestDatabase|native-database-delete|<database-file>',
    'prepareDbProcessRelaunchSelfTest|sql-insert|driver_relaunch_contract_state',
    'prepareDbProcessRelaunchSelfTest|sql-pragma|foreign_keys',
    'prepareDbProcessRelaunchSelfTest|sql-schema|attachment_cache_entries_state_lru_idx',
    'prepareDbProcessRelaunchSelfTest|sql-schema|driver_relaunch_contract_state',
    'resumeDbProcessRelaunchSelfTest|sql-pragma|foreign_key_check',
    'resumeDbProcessRelaunchSelfTest|sql-pragma|foreign_keys',
    'resumeDbProcessRelaunchSelfTest|sql-pragma|foreign_keys',
    'resumeDbProcessRelaunchSelfTest|sql-pragma|integrity_check',
    'resumeDbProcessRelaunchSelfTest|sql-schema|attachment_cache_entries_state_lru_idx',
    'resumeDbProcessRelaunchSelfTest|sql-schema|driver_relaunch_contract_state',
    'cleanupDbActiveWalWriteDeathSelfTestDatabase|native-database-delete|<database-file>',
    'retireDbActiveWalWriteDeathSelfTestDatabase|sql-pragma|journal_mode',
    'retireDbActiveWalWriteDeathSelfTestDatabase|sql-pragma|journal_mode',
    'retireDbActiveWalWriteDeathSelfTestDatabase|sql-pragma|wal_checkpoint',
    'prepareDbActiveWalWriteDeathSelfTest|sql-insert|driver_wal_write_death_contract',
    'prepareDbActiveWalWriteDeathSelfTest|sql-insert|driver_wal_write_death_contract',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|cache_size',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|cache_spill',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|foreign_keys',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|journal_mode',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|journal_mode',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|wal_autocheckpoint',
    'prepareDbActiveWalWriteDeathSelfTest|sql-pragma|wal_checkpoint',
    'prepareDbActiveWalWriteDeathSelfTest|sql-schema|driver_wal_write_death_contract',
    'prepareDbActiveWalWriteDeathSelfTest|transaction-begin|<connection>',
    'prepareDbActiveWalWriteDeathSelfTest|transaction-begin|<connection>',
    'prepareDbActiveWalWriteDeathSelfTest|transaction-commit|<connection>',
    'prepareDbActiveWalWriteDeathSelfTest|transaction-rollback|<connection>',
    'prepareDbActiveWalWriteDeathSelfTest|transaction-rollback|<connection>',
    'resumeDbActiveWalWriteDeathSelfTest|sql-insert|driver_wal_write_death_contract',
    'resumeDbActiveWalWriteDeathSelfTest|sql-pragma|foreign_key_check',
    'resumeDbActiveWalWriteDeathSelfTest|sql-pragma|foreign_keys',
    'resumeDbActiveWalWriteDeathSelfTest|sql-pragma|foreign_keys',
    'resumeDbActiveWalWriteDeathSelfTest|sql-pragma|integrity_check',
    'resumeDbActiveWalWriteDeathSelfTest|sql-pragma|journal_mode',
    'resumeDbActiveWalWriteDeathSelfTest|transaction-begin|<connection>',
    'resumeDbActiveWalWriteDeathSelfTest|transaction-commit|<connection>',
    'resumeDbActiveWalWriteDeathSelfTest|transaction-rollback|<connection>',
    'seedDbActiveMigrationFixture|sql-insert|outgoing_queue',
    'seedDbActiveMigrationFixture|transaction-begin|<connection>',
    'seedDbActiveMigrationFixture|transaction-commit|<connection>',
    'seedDbActiveMigrationFixture|transaction-rollback|<connection>',
    'cleanupDbActiveMigrationDeathSelfTestDatabase|native-database-delete|<database-file>',
    'retireDbActiveMigrationDeathSelfTestDatabase|sql-pragma|journal_mode',
    'retireDbActiveMigrationDeathSelfTestDatabase|sql-pragma|journal_mode',
    'retireDbActiveMigrationDeathSelfTestDatabase|sql-pragma|wal_checkpoint',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|cache_size',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|cache_spill',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|foreign_keys',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|journal_mode',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|journal_mode',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|wal_autocheckpoint',
    'prepareDbActiveMigrationDeathSelfTest|sql-pragma|wal_checkpoint',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|foreign_key_check',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|foreign_key_check',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|foreign_keys',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|foreign_keys',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|integrity_check',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|integrity_check',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|integrity_check',
    'resumeDbActiveMigrationDeathSelfTest|sql-pragma|journal_mode',
  ].sort();
  if (
    rawFindings.length !== expectedRawFindingSignatures.length ||
    rawFindings.map(findingSignature).sort().join('\n') !== expectedRawFindingSignatures.join('\n')
  ) {
    return undefined;
  }

  const runtimeRawOwners = new Set([
    cleanupRuntimeConcurrency,
    runRuntimeConcurrencySelfTest,
    runtimeConcurrencyCount,
    submitOrderedCoordinatorWave,
    runtimeConcurrencyWave,
  ]);
  const runtimeRawFindings = findings.filter((finding) => {
    const callable = findingCallables.get(finding.id);
    return (
      callable &&
      [...runtimeRawOwners].some((owner) => callableIsInside(callable, owner)) &&
      finding.operation !== 'mutator-call'
    );
  });
  const runtimeFindingSignature = (finding) =>
    `${finding.path}|${finding.symbol}|${finding.operation}|${finding.target}`;
  const expectedRuntimeRawFindingSignatures = [
    'src/db/database.ts|cleanupDbRuntimeConcurrencySelfTestDatabase|native-database-delete|<database-file>',
    'src/db/database.ts|rawRekey|sql-pragma|rekey',
    'src/db/database.ts|runDbRuntimeConcurrencySelfTest|sql-pragma|foreign_key_check',
    'src/db/database.ts|runDbRuntimeConcurrencySelfTest|sql-pragma|foreign_keys',
    'src/db/database.ts|runDbRuntimeConcurrencySelfTest|sql-pragma|integrity_check',
    'src/services/boot/dbRuntimeConcurrencyWave.ts|count|raw-dynamic|<dynamic>',
    'src/services/boot/dbRuntimeConcurrencyWave.ts|runDbRuntimeConcurrencyWave|sql-insert|kv',
    'src/services/boot/dbRuntimeConcurrencyWave.ts|submitOrderedCoordinatorWave|sql-insert|kv',
    'src/services/boot/dbRuntimeConcurrencyWave.ts|submitOrderedCoordinatorWave|sql-insert|kv',
    'src/services/boot/dbRuntimeConcurrencyWave.ts|submitOrderedCoordinatorWave|sql-insert|kv',
  ].sort();
  if (
    runtimeRawFindings.length !== expectedRuntimeRawFindingSignatures.length ||
    runtimeRawFindings.map(runtimeFindingSignature).sort().join('\n') !==
      expectedRuntimeRawFindingSignatures.join('\n')
  ) {
    return undefined;
  }

  const databaseCallNodes = [
    ...cleanupPrepareEdges,
    ...cleanupResumeEdges,
    ...migrationCalls.map((node) => ({ node })),
    ...cleanupWalWriteDeathPrepareEdges,
    ...cleanupWalWriteDeathResumeEdges,
    ...retireWalWriteDeathResumeEdges,
    ...cleanupWalWriteDeathRetireEdges,
    ...activeMigrationCalls.map((node) => ({ node })),
    ...cleanupActiveMigrationPrepareEdges,
    ...cleanupActiveMigrationResumeEdges,
    ...retireActiveMigrationResumeEdges,
    ...cleanupActiveMigrationRetireEdges,
    ...seedActiveMigrationPrepareEdges,
    ...cleanupRuntimeConcurrencyDatabaseEdges,
    ...runtimeConcurrencyMigrationCalls.map((node) => ({ node })),
  ].map((edge) => edge.node);
  const orchestrationCallNodes = [
    ...cleanupFailureEdges,
    ...finishEdges,
    ...prepareEdges,
    ...resumeEdges,
    ...cleanupResumeServiceEdges,
    ...cleanupRecoveryEdges,
    ...startPrepareEdges,
    ...startResumeEdges,
    ...startRecoveryEdges,
    ...cleanupWalWriteDeathOldRecoveryEdges,
    ...cleanupWalWriteDeathFailureEdges,
    ...finishWalWriteDeathEdges,
    ...prepareWalWriteDeathEdges,
    ...resumeWalWriteDeathEdges,
    ...cleanupWalWriteDeathResumeServiceEdges,
    ...cleanupOldWalWriteDeathRecoveryEdges,
    ...cleanupWalWriteDeathRecoveryEdges,
    ...startWalWriteDeathPrepareEdges,
    ...startWalWriteDeathResumeEdges,
    ...startWalWriteDeathRecoveryEdges,
    ...cleanupActiveMigrationOldRecoveryEdges,
    ...cleanupActiveMigrationWalRecoveryEdges,
    ...cleanupActiveMigrationFailureEdges,
    ...finishActiveMigrationEdges,
    ...prepareActiveMigrationEdges,
    ...resumeActiveMigrationEdges,
    ...cleanupActiveMigrationResumeServiceEdges,
    ...cleanupOldActiveMigrationRecoveryEdges,
    ...cleanupWalActiveMigrationRecoveryEdges,
    ...cleanupActiveMigrationRecoveryEdges,
    ...startActiveMigrationPrepareEdges,
    ...startActiveMigrationResumeEdges,
    ...startActiveMigrationRecoveryEdges,
    ...cleanupRuntimeConcurrencyFailureEdges,
    ...finishRuntimeConcurrencyEdges,
    ...runRuntimeConcurrencyDatabaseEdges,
    ...cleanupOldRuntimeConcurrencyRecoveryEdges,
    ...cleanupWalRuntimeConcurrencyRecoveryEdges,
    ...cleanupActiveRuntimeConcurrencyRecoveryEdges,
    ...cleanupRuntimeConcurrencyOldRecoveryEdges,
    ...cleanupRuntimeConcurrencyWalRecoveryEdges,
    ...cleanupRuntimeConcurrencyActiveRecoveryEdges,
    ...cleanupRuntimeConcurrencyRecoveryEdges,
    ...startRuntimeConcurrencyEdges,
    ...startRuntimeConcurrencyRecoveryEdges,
    { node: runtimeWaveReference.node },
    ...runtimeWaveCallNodes.map((node) => ({ node })),
  ].map((edge) => edge.node);
  if (
    databaseCallNodes.length !== 25 ||
    new Set(databaseCallNodes).size !== 25 ||
    orchestrationCallNodes.length !== 79 ||
    new Set(orchestrationCallNodes).size !== 79
  ) {
    return undefined;
  }

  return {
    adapterCall: runtimeConcurrencyAdapterCall,
    allFindingIds: new Set([...rawFindings, ...runtimeRawFindings].map((finding) => finding.id)),
    cleanup,
    databaseCallNodes,
    drizzleCall: runtimeConcurrencyDrizzleCall,
    extractCalls,
    foregroundCall: foregroundEdges[0].node,
    migrationCalls: [
      ...migrationCalls,
      ...activeMigrationCalls,
      ...runtimeConcurrencyMigrationCalls,
    ],
    migrationReferences: processMigrationReferences,
    nestedRunnerAdoptions: [
      {
        migrationCall: activeMigrationCalls[0],
        runnerFactoryCall: activeMigrationRunnerFactoryCalls[0],
        wrapperCall: prefixRunnerCall,
      },
      {
        migrationCall: activeMigrationCalls[1],
        runnerFactoryCall: activeMigrationRunnerFactoryCalls[1],
        wrapperCall: crashRunnerCall,
      },
    ],
    openCalls: candidateOpenCalls,
    orchestrationCallNodes,
    rawFindingIds: new Set([...rawFindings, ...runtimeRawFindings].map((finding) => finding.id)),
    runnerFactoryCalls: [
      ...runnerFactoryCalls,
      ...activeMigrationRunnerFactoryCalls,
      ...runtimeConcurrencyRunnerFactoryCalls,
    ],
    startContract,
  };
}

/**
 * Prove the private V3 repository-history extension before composing it into the existing driver
 * self-test certificate. Whole-function fingerprints preserve the two exact reviewed fixtures and
 * their data assertions; the symbol checks below separately prove fixed-file authority, private
 * helper membership, runner adoption, and the absence of a production-handle escape.
 */
function driverHistorySelfTestCertificateCandidate({
  filesByPath,
  checker,
  edges,
  referenceEdges,
  dynamicCallbacks,
  dynamicDispatches,
  findings,
  findingCallables,
  parentSelfTest,
}) {
  const databasePath = 'src/db/database.ts';
  const databaseFile = filesByPath.get(databasePath);
  const extractRows = topLevelFunction(filesByPath, databasePath, 'extractRows');
  const opRunner = topLevelFunction(filesByPath, databasePath, 'opRunner');
  const runMigrations = topLevelFunction(filesByPath, 'src/db/migrate.ts', 'runMigrations');
  const getDatabase = topLevelFunction(filesByPath, databasePath, 'getDatabase');
  const getRawDatabase = topLevelFunction(filesByPath, databasePath, 'getRawDatabase');
  if (
    !databaseFile ||
    !parentSelfTest?.body ||
    !extractRows?.body ||
    !opRunner?.body ||
    !runMigrations?.body ||
    !getDatabase?.body ||
    !getRawDatabase?.body
  ) {
    return undefined;
  }

  const callableNames = [
    'emptyDbHistoricalMigrationChecks',
    'deleteDriverHistorySelfTestDatabase',
    'driverHistoryPrefixDigest',
    'isExpectedDriverHistoryStop',
    'driverHistoryNextMigrationRolledBack',
    'driverHistoryPrefix',
    'driverHistoryFtsToken',
    'seedDriverHistoryFixture',
    'verifyDriverHistoryFixture',
    'verifyDriverHistoryMigratedData',
    'verifyDriverHistoryFts',
    'runDbHistoricalMigrationSelfTest',
  ];
  const callables = new Map(
    callableNames.map((name) => [name, topLevelFunction(filesByPath, databasePath, name)]),
  );
  const expectedFingerprints = new Map([
    [
      'emptyDbHistoricalMigrationChecks',
      'f790eee5a6c3415c7a0cceefa30184c4fecaa620632c6733aa1273fb1c4f8460',
    ],
    [
      'deleteDriverHistorySelfTestDatabase',
      '939bc1ceb3772cb0059eb9a026c80042f7f4a055dd97dc14cd711bb7560c3eea',
    ],
    [
      'driverHistoryPrefixDigest',
      '27401a81ab3d07a6c281cd3758a5a1686af11857015e6f565eebe6926536f6be',
    ],
    [
      'isExpectedDriverHistoryStop',
      '660d70399b43ead29bf00746659921786c92f512c508ce4943fc081b8222168c',
    ],
    [
      'driverHistoryNextMigrationRolledBack',
      '78807aa6b7ecc0cfcaa23b3f370215deb9c1225679e0e883cc5fa146732b788f',
    ],
    ['driverHistoryPrefix', 'e5a0dda8ba06280f0778927b1433a67f4734e8c64fd928c40051cb5857a7b3c6'],
    ['driverHistoryFtsToken', '09aab44b3379e23d4f88711b1c5459ec031ce21ff94543086d0cb1adf333068a'],
    [
      'seedDriverHistoryFixture',
      '67a6bcbcfaab732d506d2abc358bea1bb75f975af7fa3abbe4a738e08583da82',
    ],
    [
      'verifyDriverHistoryFixture',
      'd60ccb6fc5f4ba6a038807ead52101c18109f2d15947e2eeb0cb0426da9ce9a2',
    ],
    [
      'verifyDriverHistoryMigratedData',
      '33f4853f8ae0506abc3ae1ea594be5db91b7a6dba4c27c8cc5858b2d4f29afb1',
    ],
    ['verifyDriverHistoryFts', '90eb0f96d83bf6188dea4f9ef0ffc46511599e96e059b7b3b1ea6ee5bbedd7d3'],
    [
      'runDbHistoricalMigrationSelfTest',
      '7cdabc2ad4d766652236862a42386e894bd1625997183e032d97dcf615238c3b',
    ],
  ]);
  for (const [name, expected] of expectedFingerprints) {
    const callable = callables.get(name);
    if (
      !callable?.body ||
      createHash('sha256').update(normalizedSnippet(callable, databaseFile)).digest('hex') !==
        expected
    ) {
      return undefined;
    }
  }
  const expectedVariables = new Map([
    ['DRIVER_HISTORY_SELF_TEST_DB_NAME', "'driver-history-selftest.db'"],
    ['DRIVER_HISTORY_SELF_TEST_KEY', "'db-03b2a-public-throwaway-key-v1'"],
    ['DRIVER_HISTORY_SELF_TEST_WRONG_KEY', "'db-03b2a-wrong-public-throwaway-key-v1'"],
    ['DRIVER_HISTORY_STOP_MESSAGE', "'db-03b2a-stop-after-reviewed-head'"],
  ]);
  const variableStates = new Map();
  for (const [name, expected] of expectedVariables) {
    const state = topLevelVariable(databaseFile, name);
    const statement = state?.declarationList.parent;
    if (
      !state?.declaration.initializer ||
      !(state.declarationList.flags & ts.NodeFlags.Const) ||
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.modifiers?.length ||
      normalizedSnippet(state.declaration.initializer, databaseFile) !== expected
    ) {
      return undefined;
    }
    variableStates.set(name, state);
  }
  const casesState = topLevelVariable(databaseFile, 'DRIVER_HISTORY_CASES');
  const casesStatement = casesState?.declarationList.parent;
  if (
    !casesState?.declaration.initializer ||
    !(casesState.declarationList.flags & ts.NodeFlags.Const) ||
    !casesStatement ||
    !ts.isVariableStatement(casesStatement) ||
    casesStatement.modifiers?.length ||
    createHash('sha256')
      .update(normalizedSnippet(casesState.declaration.initializer, databaseFile))
      .digest('hex') !== '11d3f0adcf2689b4ccd7ee9cb77e2eb23b7300a665e26c0da3b619be44f97ecd'
  ) {
    return undefined;
  }
  variableStates.set('DRIVER_HISTORY_CASES', casesState);
  const expectedCallableReferenceCounts = new Map([
    ['emptyDbHistoricalMigrationChecks', 2],
    ['deleteDriverHistorySelfTestDatabase', 3],
    ['driverHistoryPrefixDigest', 2],
    ['isExpectedDriverHistoryStop', 2],
    ['driverHistoryNextMigrationRolledBack', 3],
    ['driverHistoryPrefix', 5],
    ['driverHistoryFtsToken', 11],
    ['seedDriverHistoryFixture', 2],
    ['verifyDriverHistoryFixture', 4],
    ['verifyDriverHistoryMigratedData', 2],
    ['verifyDriverHistoryFts', 2],
    ['runDbHistoricalMigrationSelfTest', 2],
  ]);
  for (const [name, expectedCount] of expectedCallableReferenceCounts) {
    const callable = callables.get(name);
    const references = callable
      ? runtimeReferencesToBinding(databaseFile, callable.name, checker)
      : [];
    if (
      !callable ||
      callable.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ) ||
      references.length !== expectedCount ||
      references[0] !== callable.name
    ) {
      return undefined;
    }
  }
  const expectedVariableReferenceCounts = new Map([
    ['DRIVER_HISTORY_SELF_TEST_DB_NAME', 6],
    ['DRIVER_HISTORY_SELF_TEST_KEY', 4],
    ['DRIVER_HISTORY_SELF_TEST_WRONG_KEY', 2],
    ['DRIVER_HISTORY_STOP_MESSAGE', 3],
    ['DRIVER_HISTORY_CASES', 3],
  ]);
  for (const [name, expectedCount] of expectedVariableReferenceCounts) {
    const state = variableStates.get(name);
    const references = state
      ? runtimeReferencesToBinding(databaseFile, state.declaration.name, checker)
      : [];
    if (
      !state ||
      references.length !== expectedCount ||
      references[0] !== state.declaration.name ||
      assignmentWritesTo(databaseFile, state.declaration.name, checker).length !== 0
    ) {
      return undefined;
    }
  }
  const protectedOwners = new Set(callables.values());
  const ownerIsProtected = (callable) =>
    callable && [...protectedOwners].some((owner) => callableIsInside(callable, owner));
  const protectedTargets = new Set(callables.values());
  if (
    referenceEdges.some(
      (reference) =>
        (typeof reference.target !== 'string' && protectedTargets.has(reference.target)) ||
        ownerIsProtected(reference.caller),
    ) ||
    dynamicCallbacks.some((callback) => ownerIsProtected(callback.caller)) ||
    dynamicDispatches.some((dispatch) => ownerIsProtected(dispatch.caller))
  ) {
    return undefined;
  }
  const productionStates = ['rawDb', 'dbInstance', 'DB_NAME']
    .map((name) => topLevelVariable(databaseFile, name))
    .filter(Boolean);
  if (
    productionStates.length !== 3 ||
    productionStates.some((state) =>
      runtimeReferencesToBinding(databaseFile, state.declaration.name, checker).some((reference) =>
        [...protectedOwners].some((owner) => nodeIsInside(reference, owner)),
      ),
    ) ||
    edges.some(
      (edge) =>
        ownerIsProtected(edge.caller) &&
        (edge.callee === getDatabase || edge.callee === getRawDatabase),
    )
  ) {
    return undefined;
  }
  const openBinding = soleNamedImportBinding(databaseFile, '@op-engineering/op-sqlite', 'open');
  const migrationsBinding = soleNamedImportBinding(databaseFile, './migrations', 'MIGRATIONS');
  if (!openBinding || !migrationsBinding) return undefined;
  const openCalls = directCallsToBinding(databaseFile, openBinding, checker)
    .filter((call) => [...protectedOwners].some((owner) => nodeIsInside(call, owner)))
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedOpenCalls = [
    'open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME })',
    'open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME, encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY, })',
    'open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME, encryptionKey: DRIVER_HISTORY_SELF_TEST_WRONG_KEY, readOnly: true, })',
    'open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME, encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY, readOnly: true, })',
    'open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME, encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY, })',
  ];
  if (
    openCalls.length !== expectedOpenCalls.length ||
    openCalls.some(
      (call, index) => normalizedSnippet(call, databaseFile) !== expectedOpenCalls[index],
    )
  ) {
    return undefined;
  }
  const historySelfTest = callables.get('runDbHistoricalMigrationSelfTest');
  const migrationCalls = edges
    .filter(
      (edge) =>
        edge.callee === runMigrations && edge.node && nodeIsInside(edge.node, historySelfTest),
    )
    .map((edge) => edge.node)
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const runnerFactoryCalls = directCallsToBinding(databaseFile, opRunner.name, checker)
    .filter((call) => nodeIsInside(call, historySelfTest))
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedMigrationCalls = [
    'runMigrations(opRunner(prepared))',
    'runMigrations(opRunner(reopened))',
    'runMigrations(opRunner(reopened))',
  ];
  if (
    migrationCalls.length !== expectedMigrationCalls.length ||
    runnerFactoryCalls.length !== expectedMigrationCalls.length ||
    migrationCalls.some((migrationCall, index) => {
      const runnerCall = runnerFactoryCalls[index];
      return (
        !runnerCall ||
        normalizedSnippet(migrationCall, databaseFile) !== expectedMigrationCalls[index] ||
        migrationCall.arguments.length !== 1 ||
        migrationCall.arguments[0] !== runnerCall ||
        runnerCall.parent !== migrationCall ||
        runnerCall.arguments.length !== 1 ||
        !ts.isAwaitExpression(migrationCall.parent)
      );
    })
  ) {
    return undefined;
  }
  const migrationReferences = runtimeReferencesToBinding(
    databaseFile,
    migrationsBinding,
    checker,
  ).filter((reference) => [...protectedOwners].some((owner) => nodeIsInside(reference, owner)));
  if (migrationReferences.length !== 7) return undefined;
  const extractCalls = directCallsToBinding(databaseFile, extractRows.name, checker).filter(
    (call) => [...protectedOwners].some((owner) => nodeIsInside(call, owner)),
  );
  if (extractCalls.length !== 30) return undefined;
  const cleanup = callables.get('deleteDriverHistorySelfTestDatabase');
  const nextRollback = callables.get('driverHistoryNextMigrationRolledBack');
  const seedFixture = callables.get('seedDriverHistoryFixture');
  const verifyFixture = callables.get('verifyDriverHistoryFixture');
  const verifyFts = callables.get('verifyDriverHistoryFts');
  const cleanupEdges = exactCallEdges(edges, historySelfTest, cleanup);
  const nextRollbackEdges = [
    ...exactCallEdges(edges, historySelfTest, nextRollback),
    ...exactCallEdges(edges, verifyFixture, nextRollback),
  ];
  const seedEdges = exactCallEdges(edges, historySelfTest, seedFixture);
  const verifyFixtureEdges = exactCallEdges(edges, historySelfTest, verifyFixture);
  const verifyFtsEdges = exactCallEdges(edges, historySelfTest, verifyFts);
  const parentEdges = exactCallEdges(edges, parentSelfTest, historySelfTest);
  if (
    cleanupEdges.length !== 2 ||
    edges.filter((edge) => edge.callee === cleanup).length !== 2 ||
    nextRollbackEdges.length !== 2 ||
    edges.filter((edge) => edge.callee === nextRollback).length !== 2 ||
    seedEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === seedFixture).length !== 1 ||
    verifyFixtureEdges.length !== 3 ||
    edges.filter((edge) => edge.callee === verifyFixture).length !== 3 ||
    verifyFtsEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === verifyFts).length !== 1 ||
    parentEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === historySelfTest).length !== 1
  ) {
    return undefined;
  }
  const historyFindings = findings.filter((finding) =>
    ownerIsProtected(findingCallables.get(finding.id)),
  );
  const findingSignature = (finding) =>
    `${callableDisplayName(findingCallables.get(finding.id))}|${finding.operation}|${finding.target}`;
  const expectedFindingSignatures = [
    'deleteDriverHistorySelfTestDatabase|native-database-delete|<database-file>',
    'driverHistoryNextMigrationRolledBack|sql-pragma|table_info',
    'driverHistoryNextMigrationRolledBack|sql-pragma|table_info',
    'driverHistoryNextMigrationRolledBack|sql-pragma|table_info',
    'seedDriverHistoryFixture|sql-insert|chats',
    'seedDriverHistoryFixture|sql-insert|error_reports',
    'seedDriverHistoryFixture|sql-insert|kv',
    'seedDriverHistoryFixture|sql-insert|kv',
    'seedDriverHistoryFixture|sql-insert|messages',
    'seedDriverHistoryFixture|sql-insert|outgoing_queue',
    'seedDriverHistoryFixture|sql-insert|outgoing_queue',
    'seedDriverHistoryFixture|sql-insert|outgoing_queue',
    'seedDriverHistoryFixture|sql-insert|scheduled_messages',
    'seedDriverHistoryFixture|sql-insert|scheduled_messages',
    'seedDriverHistoryFixture|sql-insert|scheduled_messages',
    'verifyDriverHistoryFts|sql-delete|messages',
    'verifyDriverHistoryFts|sql-insert|messages',
    'verifyDriverHistoryFts|sql-update|messages',
    'runDbHistoricalMigrationSelfTest|sql-pragma|foreign_key_check',
    'runDbHistoricalMigrationSelfTest|sql-pragma|foreign_keys',
    'runDbHistoricalMigrationSelfTest|sql-pragma|foreign_keys',
    'runDbHistoricalMigrationSelfTest|sql-pragma|foreign_keys',
    'runDbHistoricalMigrationSelfTest|sql-pragma|integrity_check',
    'runDbHistoricalMigrationSelfTest|sql-schema|_migrations',
    'runDbHistoricalMigrationSelfTest|sql-schema|driver_history_stop_after_reviewed_head',
    'runDbHistoricalMigrationSelfTest|sql-schema|driver_history_stop_after_reviewed_head',
  ].sort();
  if (
    historyFindings.length !== expectedFindingSignatures.length ||
    historyFindings.map(findingSignature).sort().join('\n') !== expectedFindingSignatures.join('\n')
  ) {
    return undefined;
  }

  const internalCallNodes = [
    ...cleanupEdges,
    ...nextRollbackEdges,
    ...seedEdges,
    ...verifyFixtureEdges,
    ...verifyFtsEdges,
    ...migrationCalls.map((node) => ({ node })),
    ...parentEdges,
  ].map((edge) => edge.node);
  if (internalCallNodes.length !== 13 || new Set(internalCallNodes).size !== 13) {
    return undefined;
  }

  return {
    cleanup,
    cleanupEdges,
    extractCalls,
    findingIds: new Set(historyFindings.map((finding) => finding.id)),
    historySelfTest,
    internalCallNodes,
    migrationCalls,
    migrationReferences,
    openCalls,
    protectedOwners,
    runnerFactoryCalls,
  };
}

/**
 * Prove the exact disposable Android driver contract without making the private adapter a public
 * capability. This is a candidate only: the adapter certificate below must also prove the shared
 * Proxy body and all three sole consumers before any finding receives a throwaway context.
 */
function driverSelfTestCertificateCandidate({
  filesByPath,
  checker,
  edges,
  referenceEdges,
  dynamicCallbacks,
  dynamicDispatches,
  findings,
  findingCallables,
  processRelaunchCandidate,
}) {
  const databasePath = 'src/db/database.ts';
  const databaseFile = filesByPath.get(databasePath);
  const initDatabase = topLevelFunction(filesByPath, databasePath, 'initDatabase');
  const getDatabase = topLevelFunction(filesByPath, databasePath, 'getDatabase');
  const getRawDatabase = topLevelFunction(filesByPath, databasePath, 'getRawDatabase');
  const extractRows = topLevelFunction(filesByPath, databasePath, 'extractRows');
  const opRunner = topLevelFunction(filesByPath, databasePath, 'opRunner');
  const drizzleAdapter = topLevelFunction(filesByPath, databasePath, 'drizzleAdapter');
  const runMigrations = topLevelFunction(filesByPath, 'src/db/migrate.ts', 'runMigrations');
  const cleanup = topLevelFunction(filesByPath, databasePath, 'deleteDriverSelfTestDatabase');
  const emptyChecks = topLevelFunction(filesByPath, databasePath, 'emptyDbDriverContractChecks');
  const requireContract = topLevelFunction(filesByPath, databasePath, 'requireDriverContract');
  const expectedConflict = topLevelFunction(
    filesByPath,
    databasePath,
    'isExpectedDriverMigrationConflict',
  );
  const exactStringColumn = topLevelFunction(filesByPath, databasePath, 'hasExactStringColumn');
  const subscribe = topLevelFunction(filesByPath, databasePath, 'subscribeForDriverSelfTestValue');
  const selfTest = topLevelFunction(filesByPath, databasePath, 'runDbDriverSelfTest');
  const nameState = databaseFile
    ? topLevelVariable(databaseFile, 'DRIVER_SELF_TEST_DB_NAME')
    : undefined;
  const rawState = databaseFile ? topLevelVariable(databaseFile, 'rawDb') : undefined;
  const drizzleState = databaseFile ? topLevelVariable(databaseFile, 'dbInstance') : undefined;
  const productionNameState = databaseFile ? topLevelVariable(databaseFile, 'DB_NAME') : undefined;
  const migrationCountState = databaseFile
    ? topLevelVariable(databaseFile, 'DRIVER_SELF_TEST_MIGRATION_COUNT')
    : undefined;
  const migrationHeadState = databaseFile
    ? topLevelVariable(databaseFile, 'DRIVER_SELF_TEST_MIGRATION_HEAD')
    : undefined;
  const partialMigrationCountState = databaseFile
    ? topLevelVariable(databaseFile, 'DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT')
    : undefined;
  const internalFailureState = databaseFile
    ? topLevelVariable(databaseFile, 'DB_DRIVER_CONTRACT_INTERNAL_FAILURE')
    : undefined;
  if (
    !databaseFile ||
    !initDatabase?.body ||
    !getDatabase?.body ||
    !getRawDatabase?.body ||
    !extractRows?.body ||
    !opRunner?.body ||
    !drizzleAdapter?.body ||
    !runMigrations?.body ||
    !cleanup?.body ||
    !emptyChecks?.body ||
    !requireContract?.body ||
    !expectedConflict?.body ||
    !exactStringColumn?.body ||
    !subscribe?.body ||
    !selfTest?.body ||
    !processRelaunchCandidate ||
    !nameState?.declaration.initializer ||
    !rawState ||
    !drizzleState ||
    !productionNameState ||
    !migrationCountState?.declaration.initializer ||
    !migrationHeadState?.declaration.initializer ||
    !partialMigrationCountState?.declaration.initializer ||
    !internalFailureState?.declaration.initializer
  ) {
    return undefined;
  }
  if (
    !(nameState.declarationList.flags & ts.NodeFlags.Const) ||
    !ts.isStringLiteralLike(nameState.declaration.initializer) ||
    nameState.declaration.initializer.text !== 'driver-selftest.db' ||
    !(migrationCountState.declarationList.flags & ts.NodeFlags.Const) ||
    normalizedSnippet(migrationCountState.declaration.initializer, databaseFile) !==
      '42 as const' ||
    !(migrationHeadState.declarationList.flags & ts.NodeFlags.Const) ||
    normalizedSnippet(migrationHeadState.declaration.initializer, databaseFile) !==
      "'0042_message_part_identity' as const" ||
    !(partialMigrationCountState.declarationList.flags & ts.NodeFlags.Const) ||
    normalizedSnippet(partialMigrationCountState.declaration.initializer, databaseFile) !== '29' ||
    !(internalFailureState.declarationList.flags & ts.NodeFlags.Const) ||
    normalizedSnippet(internalFailureState.declaration.initializer, databaseFile) !==
      "{ schema: 3, suite: 'android-db-contract', status: 'fail', migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT, migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD, checks: emptyDbDriverContractChecks(), failureCode: 'internal', }" ||
    !hasExactIdentifierParameters(cleanup, []) ||
    !hasExactIdentifierParameters(emptyChecks, []) ||
    emptyChecks.modifiers?.length ||
    emptyChecks.asteriskToken ||
    emptyChecks.body.statements.length !== 1 ||
    normalizedSnippet(emptyChecks.body.statements[0], databaseFile) !==
      'return { encryptedOpen: false, wrongKeyRejected: false, migrationRollback: false, migrationRetry: false, migrationLedger: false, migrationData: false, fts5: false, integrity: false, idempotent: false, rollback: false, syncReactive: false, asyncReactive: false, rawReactive: false, rekey: false, newKeyReopen: false, oldKeyRejected: false, historicalProvenance: false, historical0024: false, historical0027: false, historical0029: false, historicalReadOnly: false, historicalWrongKeyRejected: false, historicalData: false, historicalFts5: false, historicalIntegrity: false, historicalIdempotent: false, historicalCleanup: false, cleanup: false, };' ||
    !hasExactIdentifierParameters(subscribe, [
      { name: 'db' },
      { name: 'expected' },
      { name: 'waitForExpected', defaulted: true },
    ]) ||
    subscribe.parameters[2]?.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    !hasExactIdentifierParameters(requireContract, [{ name: 'condition' }]) ||
    requireContract.modifiers?.length ||
    requireContract.asteriskToken ||
    requireContract.body.statements.length !== 1 ||
    normalizedSnippet(requireContract.body.statements[0], databaseFile) !==
      "if (!condition) throw new Error('database driver contract assertion failed');" ||
    !hasExactIdentifierParameters(expectedConflict, [{ name: 'error' }]) ||
    expectedConflict.modifiers?.length ||
    expectedConflict.asteriskToken ||
    expectedConflict.body.statements.length !== 3 ||
    normalizedSnippet(expectedConflict.body.statements[0], databaseFile) !==
      'if (!(error instanceof Error)) return false;' ||
    normalizedSnippet(expectedConflict.body.statements[1], databaseFile) !==
      'const message = error.message.toLowerCase();' ||
    normalizedSnippet(expectedConflict.body.statements[2], databaseFile) !==
      "return ( message.includes('attachment_cache_entries_state_lru_idx') && message.includes('already exists') );" ||
    !hasExactIdentifierParameters(exactStringColumn, [
      { name: 'rows' },
      { name: 'column' },
      { name: 'expected' },
    ]) ||
    exactStringColumn.modifiers?.length ||
    exactStringColumn.asteriskToken ||
    exactStringColumn.body.statements.length !== 1 ||
    normalizedSnippet(exactStringColumn.body.statements[0], databaseFile) !==
      'return ( rows.length === expected.length && rows.every((row, index) => row[column] === expected[index]) );' ||
    !hasExactIdentifierParameters(selfTest, []) ||
    selfTest.modifiers?.filter((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      .length !== 1 ||
    selfTest.asteriskToken
  ) {
    return undefined;
  }

  const migrationsBinding = soleNamedImportBinding(databaseFile, './migrations', 'MIGRATIONS');
  if (!migrationsBinding) return undefined;
  const historyCandidate = driverHistorySelfTestCertificateCandidate({
    filesByPath,
    checker,
    edges,
    referenceEdges,
    dynamicCallbacks,
    dynamicDispatches,
    findings,
    findingCallables,
    parentSelfTest: selfTest,
  });
  if (!historyCandidate) return undefined;

  const declarationsNamed = (owner, name) => {
    const matches = [];
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        matches.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(owner);
    return matches;
  };
  const soleDeclaration = (owner, name) => {
    const matches = declarationsNamed(owner, name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const keyA = soleDeclaration(selfTest, 'keyA');
  const keyB = soleDeclaration(selfTest, 'keyB');
  const checks = soleDeclaration(selfTest, 'checks');
  const failureCode = soleDeclaration(selfTest, 'failureCode');
  const phase = soleDeclaration(selfTest, 'phase');
  const initial = soleDeclaration(selfTest, 'initial');
  const expectedMigrationConflict = soleDeclaration(selfTest, 'expectedMigrationConflict');
  const wrongKeyHandle = soleDeclaration(selfTest, 'wrongKeyHandle');
  const reopened = soleDeclaration(selfTest, 'reopened');
  const retriedMigrations = soleDeclaration(selfTest, 'retriedMigrations');
  const idempotentMigrations = soleDeclaration(selfTest, 'idempotentMigrations');
  const database = soleDeclaration(selfTest, 'database');
  const transactionOpen = soleDeclaration(selfTest, 'transactionOpen');
  const commitProbe = soleDeclaration(selfTest, 'commitProbe');
  const rollbackProbe = soleDeclaration(selfTest, 'rollbackProbe');
  const syncProbe = soleDeclaration(selfTest, 'syncProbe');
  const asyncProbe = soleDeclaration(selfTest, 'asyncProbe');
  const rawProbe = soleDeclaration(selfTest, 'rawProbe');
  const afterCommit = soleDeclaration(selfTest, 'afterCommit');
  const afterRollback = soleDeclaration(selfTest, 'afterRollback');
  const rekeyed = soleDeclaration(selfTest, 'rekeyed');
  const oldKeyHandle = soleDeclaration(selfTest, 'oldKeyHandle');
  const cleanupHandle = soleDeclaration(cleanup, 'cleanup');
  if (
    !keyA ||
    !keyB ||
    !checks ||
    !failureCode ||
    !phase ||
    !initial ||
    !expectedMigrationConflict ||
    !wrongKeyHandle ||
    !reopened ||
    !retriedMigrations ||
    !idempotentMigrations ||
    !database ||
    !transactionOpen ||
    !commitProbe ||
    !rollbackProbe ||
    !syncProbe ||
    !asyncProbe ||
    !rawProbe ||
    !afterCommit ||
    !afterRollback ||
    !rekeyed ||
    !oldKeyHandle ||
    !cleanupHandle ||
    !ts.isIdentifier(keyA.name) ||
    !ts.isIdentifier(keyB.name)
  ) {
    return undefined;
  }

  const selfTestStatements = selfTest.body.statements;
  if (
    selfTestStatements.length !== 6 ||
    normalizedSnippet(selfTestStatements[0], databaseFile) !==
      'const checks = emptyDbDriverContractChecks();' ||
    normalizedSnippet(selfTestStatements[1], databaseFile) !==
      'let failureCode: DbDriverContractFailureCode | undefined;' ||
    normalizedSnippet(selfTestStatements[2], databaseFile) !==
      "let phase: DbDriverContractFailureCode = 'internal';" ||
    normalizedSnippet(selfTestStatements[4], databaseFile) !==
      "if (!failureCode && Object.values(checks).every(Boolean)) { return { schema: 3, suite: 'android-db-contract', status: 'pass', migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT, migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD, checks, }; }" ||
    normalizedSnippet(selfTestStatements[5], databaseFile) !==
      "return { schema: 3, suite: 'android-db-contract', status: 'fail', migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT, migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD, checks, failureCode: failureCode ?? 'internal', };"
  ) {
    return undefined;
  }

  // The V3 fixture retains several deliberately long migration-data assertions. Pin the normalized
  // AST statement fingerprints so every assertion remains exact without duplicating those
  // multi-kilobyte expressions in the scanner implementation.
  const requireCalls = directCallsToBinding(databaseFile, requireContract.name, checker)
    .filter((call) => nodeIsInside(call, selfTest))
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const requireFingerprints = requireCalls.map((call) =>
    ts.isExpressionStatement(call.parent)
      ? createHash('sha256').update(normalizedSnippet(call.parent, databaseFile)).digest('hex')
      : '',
  );
  const expectedRequireFingerprints = [
    '87e153128fa64453be7e5538e6576d9cb40b7c2fcb04af9e7d1108dd4ca18f2b',
    'dc06cfff7e95ac7b61bda911a6f650868fcaabe84d29788bbbab8246ee8438ed',
    'a0c471fe3b44da81db8e6a46db559ad7f7f4bd7f21ad8b9de90412d321a5afc8',
    'd5561f64b2455aae98c4b554be9f2a23d9e77b1d810fb3065493d1ca9be6258f',
    'be89ca2796686783b0f5bea839478c79f1e567c641403b18a00d74bafd8cb9cd',
    '5f6512b7189fd94b672b5d5305d59669d2fdea36c53a06aed13b07783a9cc550',
    '7a940b587a872aec350c8a5ea7080bd6fd455c4d985af8bfd116c36457a817d2',
    '4546a761b35d47badf0b53ab8d9ef1a8f9b7e91ca9d91e02c4ef2f17c05eecd0',
    'dea3f20145b1018b5e90f10f58c12070396e6cae7809032db59988c651dbbd37',
    'f14fb5135d1f7da47e34fd075ce84a6e8cddba09b728f39567fa8e74bb931f70',
    '35ae9457e54679aec5c336b2a369b63cabc8c1c81c531b58d5beb7142eee4afd',
    'a71697d2e3f6970e2ffcda7f4e4961f116a6276eeed640aa01016645cb15d53b',
    '41e9c767ff982ab4d5edc62f6a4e94297e241b0b0058c2491064d41962ced537',
    '60124a4bd623b3f4b5d5ed35379021fd8543aba61ce9725dadffb5d6d54fa5e1',
    'd86ebb01ad6b3ae1ddbd86081a6b1ac02594f0b5e57f8582cb5fe73f4548497f',
    'dc81d7ca09711e4f048603245f6bcf772cb05a08f5948b0fb19d12a127aa2742',
    '27934089eaef5ffe2b833ecb434e8ad237ade81eba28eced579160fc560c90a2',
    '8f9464157d87ce4edc851975358f80238ca5d1f6b2c6dd0ec65f67d5dba6b575',
    '5b76aa9063252502d2fd2ddcee40f87d1de3acb808d7d72d9cd14d8e9599f920',
    '81904bbc204329d98022e96854150234b7ba07d462d07d91bde345d4fca7fe17',
    '4d14fde62bd46c78ad65e826631fe2cea23e0892db380be1c551003be9efdca7',
    '2aaec15558f1a394501d3b6149e17a5892e1f0af60345eedbfd8cb50334b3fd4',
    '9c8e5772929ca3031670758d262088988fff1ae9801fccecc133bac4febba6ee',
    '20b5609ba08ee48d5d9871a63af932d86f7bec0f046b2ecc7b44eeb849528dc5',
    '01a4e278d2b5a501d36938e0ae965f5ba7856079539bfacc46c2970a1d22dea8',
    '4445b5dde524eb1791f8ab408c8e593d13351ee43e6833099a3a2b4561de6317',
    '7ba014a2bb3be3f7de32f344c2e85e75904f1769c2b2fe5b1905c7fde0f0bbad',
    '509806aea32f77cbeb121a004f5be3037762a138fc01d35f2180758dd94166ab',
    '766d449f1625d2a1bad0b39d4112295954cefbe5a9563fbdcbe4abd8b38fd44b',
  ];
  if (requireFingerprints.join('\n') !== expectedRequireFingerprints.join('\n')) {
    return undefined;
  }

  const phaseWrites = assignmentWritesTo(databaseFile, phase.name, checker);
  const expectedPhaseValues = [
    "'key-generation'",
    "'pre-cleanup'",
    "'encrypted-open'",
    "'migration-rollback'",
    "'wrong-key-not-rejected'",
    "'correct-key-reopen'",
    "'migration-data'",
    "'migration-retry'",
    "'migration-ledger'",
    "'migration-data'",
    "'fts5'",
    "'integrity'",
    "'idempotent'",
    "'rollback'",
    "'sync-reactive'",
    "'async-reactive'",
    "'raw-reactive'",
    "'rekey'",
    "'new-key-reopen'",
    "'old-key-not-rejected'",
    "'historical-provenance'",
    'historicalResult.failureCode',
  ];
  if (
    phaseWrites.length !== expectedPhaseValues.length ||
    phaseWrites.some(
      (write, index) => normalizedSnippet(write.right, databaseFile) !== expectedPhaseValues[index],
    )
  ) {
    return undefined;
  }

  const checkWrites = [];
  const collectCheckWrites = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      sameSymbol(unwrapExpression(node.left.expression), checks.name, checker)
    ) {
      checkWrites.push(node);
    }
    ts.forEachChild(node, collectCheckWrites);
  };
  collectCheckWrites(selfTest);
  checkWrites.sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedCheckWrites = [
    ['encryptedOpen', 'true'],
    ['migrationRollback', 'true'],
    ['wrongKeyRejected', 'true'],
    ['migrationRetry', 'true'],
    ['migrationLedger', 'true'],
    ['migrationData', 'true'],
    ['fts5', 'true'],
    ['integrity', 'true'],
    ['idempotent', 'true'],
    ['rollback', 'true'],
    ['syncReactive', 'true'],
    ['asyncReactive', 'true'],
    ['rawReactive', 'true'],
    ['rekey', 'true'],
    ['newKeyReopen', 'true'],
    ['oldKeyRejected', 'true'],
    ['historical0029', 'true'],
    ['cleanup', 'deleteDriverSelfTestDatabase()'],
  ];
  if (
    checkWrites.length !== expectedCheckWrites.length ||
    checkWrites.some((write, index) => {
      const expected = expectedCheckWrites[index];
      return (
        !expected ||
        write.left.name.text !== expected[0] ||
        normalizedSnippet(write.right, databaseFile) !== expected[1]
      );
    })
  ) {
    return undefined;
  }

  const outerTry = selfTestStatements[3];
  if (
    !ts.isTryStatement(outerTry) ||
    !outerTry.catchClause ||
    outerTry.catchClause.variableDeclaration ||
    outerTry.catchClause.block.statements.length !== 1 ||
    normalizedSnippet(outerTry.catchClause.block.statements[0], databaseFile) !==
      'failureCode = phase;' ||
    !outerTry.finallyBlock ||
    outerTry.finallyBlock.statements.length !== 2 ||
    normalizedSnippet(outerTry.finallyBlock.statements[0], databaseFile) !==
      'checks.cleanup = deleteDriverSelfTestDatabase();' ||
    normalizedSnippet(outerTry.finallyBlock.statements[1], databaseFile) !==
      "if (!checks.cleanup) failureCode = 'cleanup';"
  ) {
    return undefined;
  }

  const openBinding = soleNamedImportBinding(databaseFile, '@op-engineering/op-sqlite', 'open');
  const drizzleBinding = soleNamedImportBinding(databaseFile, 'drizzle-orm/op-sqlite', 'drizzle');
  if (!openBinding || !drizzleBinding) return undefined;
  const allOpenCalls = directCallsToBinding(databaseFile, openBinding, checker);
  const productionOpenCalls = allOpenCalls.filter((call) => nodeIsInside(call, initDatabase));
  const cleanupOpenCalls = allOpenCalls.filter((call) => nodeIsInside(call, cleanup));
  const selfTestOpenCalls = allOpenCalls.filter((call) => nodeIsInside(call, selfTest));
  const historyOpenCallSet = new Set(historyCandidate.openCalls);
  const processOpenCallSet = new Set(processRelaunchCandidate.openCalls);
  if (
    allOpenCalls.length !== 32 ||
    productionOpenCalls.length !== 1 ||
    cleanupOpenCalls.length !== 1 ||
    selfTestOpenCalls.length !== 5 ||
    historyOpenCallSet.size !== 5 ||
    historyCandidate.openCalls.some((call) => !allOpenCalls.includes(call)) ||
    processOpenCallSet.size !== 20 ||
    processRelaunchCandidate.openCalls.some((call) => !allOpenCalls.includes(call))
  ) {
    return undefined;
  }

  const boundOpenCall = (declaration) => {
    if (declaration.initializer) return callExpression(declaration.initializer);
    const writes = assignmentWritesTo(databaseFile, declaration.name, checker);
    if (writes.length !== 1) return undefined;
    const write = writes[0];
    return ts.isBinaryExpression(write) ? callExpression(write.right) : undefined;
  };
  const cleanupOpen = boundOpenCall(cleanupHandle);
  const initialOpen = boundOpenCall(initial);
  const wrongKeyOpen = boundOpenCall(wrongKeyHandle);
  const reopenedOpen = boundOpenCall(reopened);
  const rekeyedOpen = boundOpenCall(rekeyed);
  const oldKeyOpen = boundOpenCall(oldKeyHandle);
  const candidateOpenCalls = [
    cleanupOpen,
    initialOpen,
    wrongKeyOpen,
    reopenedOpen,
    rekeyedOpen,
    oldKeyOpen,
  ];
  if (
    candidateOpenCalls.some((call) => !call) ||
    new Set(candidateOpenCalls).size !== 6 ||
    candidateOpenCalls.some((call) => !allOpenCalls.includes(call))
  ) {
    return undefined;
  }

  const openOptionsMatch = (call, encryptionKey) => {
    if (!call || call.arguments.length !== 1) return false;
    const options = unwrapExpression(call.arguments[0]);
    if (!ts.isObjectLiteralExpression(options)) return false;
    if (options.properties.length !== (encryptionKey ? 2 : 1)) return false;
    const nameProperty = options.properties[0];
    if (
      !nameProperty ||
      !ts.isPropertyAssignment(nameProperty) ||
      !identifierNamed(nameProperty.name, 'name') ||
      !sameSymbol(unwrapExpression(nameProperty.initializer), nameState.declaration.name, checker)
    ) {
      return false;
    }
    if (!encryptionKey) return true;
    const keyProperty = options.properties[1];
    return Boolean(
      keyProperty &&
      ts.isPropertyAssignment(keyProperty) &&
      identifierNamed(keyProperty.name, 'encryptionKey') &&
      sameSymbol(unwrapExpression(keyProperty.initializer), encryptionKey.name, checker),
    );
  };
  if (
    !openOptionsMatch(cleanupOpen, undefined) ||
    !openOptionsMatch(initialOpen, keyA) ||
    !openOptionsMatch(wrongKeyOpen, keyB) ||
    !openOptionsMatch(reopenedOpen, keyA) ||
    !openOptionsMatch(rekeyedOpen, keyB) ||
    !openOptionsMatch(oldKeyOpen, keyA)
  ) {
    return undefined;
  }

  const allDrizzleCalls = directCallsToBinding(databaseFile, drizzleBinding, checker);
  const selfTestDrizzleCalls = allDrizzleCalls.filter((call) => nodeIsInside(call, selfTest));
  if (allDrizzleCalls.length !== 3 || selfTestDrizzleCalls.length !== 1) return undefined;
  const selfTestDrizzleCall = selfTestDrizzleCalls[0];
  const selfTestAdapterCall = selfTestDrizzleCall.arguments[0]
    ? callableCall(selfTestDrizzleCall.arguments[0], drizzleAdapter, checker)
    : undefined;
  if (
    !selfTestAdapterCall ||
    selfTestDrizzleCall.arguments.length !== 1 ||
    selfTestAdapterCall.arguments.length !== 1 ||
    !sameSymbol(unwrapExpression(selfTestAdapterCall.arguments[0]), reopened.name, checker) ||
    !database.initializer ||
    callExpression(database.initializer) !== selfTestDrizzleCall ||
    !(database.parent.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }

  const migrationCalls = edges
    .filter(
      (edge) => edge.callee === runMigrations && edge.node && nodeIsInside(edge.node, selfTest),
    )
    .map((edge) => edge.node)
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const runnerFactoryCalls = directCallsToBinding(databaseFile, opRunner.name, checker)
    .filter((call) => nodeIsInside(call, selfTest))
    .sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  const expectedRunnerHandles = [initial, reopened, reopened];
  if (
    migrationCalls.length !== 3 ||
    runnerFactoryCalls.length !== 3 ||
    migrationCalls.some((migrationCall, index) => {
      const runnerCall = runnerFactoryCalls[index];
      const expectedHandle = expectedRunnerHandles[index];
      return (
        !runnerCall ||
        !expectedHandle ||
        migrationCall.arguments.length !== 1 ||
        migrationCall.arguments[0] !== runnerCall ||
        runnerCall.parent !== migrationCall ||
        runnerCall.arguments.length !== 1 ||
        !sameSymbol(unwrapExpression(runnerCall.arguments[0]), expectedHandle.name, checker) ||
        !ts.isAwaitExpression(migrationCall.parent)
      );
    }) ||
    !retriedMigrations.initializer ||
    unwrapExpression(retriedMigrations.initializer) !== migrationCalls[1].parent ||
    !(retriedMigrations.parent.flags & ts.NodeFlags.Const) ||
    !idempotentMigrations.initializer ||
    unwrapExpression(idempotentMigrations.initializer) !== migrationCalls[2].parent ||
    !(idempotentMigrations.parent.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }

  let firstMigrationTry;
  for (
    let current = migrationCalls[0].parent;
    current && current !== selfTest;
    current = current.parent
  ) {
    if (ts.isTryStatement(current)) {
      firstMigrationTry = current;
      break;
    }
  }
  if (
    !firstMigrationTry ||
    normalizedSnippet(firstMigrationTry, databaseFile) !==
      'try { await runMigrations(opRunner(initial)); } catch (error) { expectedMigrationConflict = isExpectedDriverMigrationConflict(error); }' ||
    expectedMigrationConflict.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    !(expectedMigrationConflict.parent.flags & ts.NodeFlags.Let) ||
    assignmentWritesTo(databaseFile, expectedMigrationConflict.name, checker).length !== 1
  ) {
    return undefined;
  }

  const migrationListReferences = runtimeReferencesToBinding(
    databaseFile,
    migrationsBinding,
    checker,
  );
  const migrationListCalls = [];
  const processMigrationReferenceSet = new Set(processRelaunchCandidate.migrationReferences);
  const historyMigrationReferenceSet = new Set(historyCandidate.migrationReferences);
  for (const reference of migrationListReferences) {
    if (
      historyMigrationReferenceSet.has(reference) ||
      processMigrationReferenceSet.has(reference)
    ) {
      continue;
    }
    const access = reference.parent;
    const call =
      access &&
      ts.isPropertyAccessExpression(access) &&
      access.expression === reference &&
      access.name.text === 'map'
        ? callExpression(access.parent)
        : undefined;
    if (
      !call ||
      call.expression !== access ||
      call.arguments.length !== 1 ||
      normalizedSnippet(call.arguments[0], databaseFile) !== '(migration) => migration.name' ||
      !nodeIsInside(call, selfTest)
    ) {
      return undefined;
    }
    migrationListCalls.push(call);
  }
  migrationListCalls.sort(
    (left, right) => left.getStart(databaseFile) - right.getStart(databaseFile),
  );
  const selfTestMigrationListCalls = migrationListCalls.filter((call) =>
    nodeIsInside(call, selfTest),
  );
  if (
    migrationListCalls.length !== 3 ||
    selfTestMigrationListCalls.length !== 3 ||
    !(
      selfTestMigrationListCalls[0].getStart(databaseFile) <
      migrationCalls[0].getStart(databaseFile)
    ) ||
    !(
      migrationCalls[0].getStart(databaseFile) <
      selfTestMigrationListCalls[1].getStart(databaseFile)
    ) ||
    !(
      selfTestMigrationListCalls[1].getStart(databaseFile) <
      migrationCalls[1].getStart(databaseFile)
    ) ||
    !(
      migrationCalls[2].getStart(databaseFile) <
      selfTestMigrationListCalls[2].getStart(databaseFile)
    )
  ) {
    return undefined;
  }

  const subscribeCalls = directCallsToBinding(databaseFile, subscribe.name, checker).filter(
    (call) => nodeIsInside(call, selfTest),
  );
  const boundSubscribeCall = (declaration) =>
    declaration.initializer ? callableCall(declaration.initializer, subscribe, checker) : undefined;
  const commitSubscribe = boundSubscribeCall(commitProbe);
  const rollbackSubscribe = boundSubscribeCall(rollbackProbe);
  const syncSubscribe = boundSubscribeCall(syncProbe);
  const asyncSubscribe = boundSubscribeCall(asyncProbe);
  const rawSubscribe = boundSubscribeCall(rawProbe);
  const expectedSubscriptions = [
    [commitSubscribe, 'committed', false],
    [rollbackSubscribe, 'committed', true],
    [syncSubscribe, 'sync-route', false],
    [asyncSubscribe, 'async-route', false],
    [rawSubscribe, 'raw-route', false],
  ];
  if (
    subscribeCalls.length !== 5 ||
    expectedSubscriptions.some(([call, expected, waitForExpected]) => {
      const expectedArgument = call?.arguments[1];
      const waitArgument = call?.arguments[2];
      return (
        !call ||
        !subscribeCalls.includes(call) ||
        call.arguments.length !== (waitForExpected ? 3 : 2) ||
        !sameSymbol(unwrapExpression(call.arguments[0]), reopened.name, checker) ||
        !expectedArgument ||
        !ts.isStringLiteralLike(unwrapExpression(expectedArgument)) ||
        unwrapExpression(expectedArgument).text !== expected ||
        (waitForExpected && waitArgument?.kind !== ts.SyntaxKind.TrueKeyword)
      );
    }) ||
    new Set(expectedSubscriptions.map(([call]) => call)).size !== subscribeCalls.length
  ) {
    return undefined;
  }

  const allowedHandleArguments = new Set([
    selfTestAdapterCall,
    ...subscribeCalls,
    ...runnerFactoryCalls,
  ]);
  const handleIsContained = (declaration, openCall, expectedMethods) => {
    const references = runtimeReferencesToBinding(databaseFile, declaration.name, checker);
    const methods = [];
    for (const reference of references) {
      if (reference === declaration.name) continue;
      if (
        ts.isBinaryExpression(reference.parent) &&
        reference.parent.left === reference &&
        reference.parent.right === openCall
      ) {
        continue;
      }
      const access = reference.parent;
      const call =
        access && ts.isPropertyAccessExpression(access) && access.expression === reference
          ? callExpression(access.parent)
          : undefined;
      if (call && call.expression === access) {
        const method = access.name.text;
        if (!expectedMethods.includes(method)) return false;
        if (method === 'execute' && !ts.isAwaitExpression(call.parent)) return false;
        methods.push(method);
        continue;
      }
      const argumentCall = reference.parent;
      if (
        argumentCall &&
        ts.isCallExpression(argumentCall) &&
        argumentCall.arguments.includes(reference) &&
        allowedHandleArguments.has(argumentCall)
      ) {
        continue;
      }
      return false;
    }
    return (
      methods.sort().join(',') === [...expectedMethods].sort().join(',') &&
      (declaration.parent.flags & ts.NodeFlags.Const
        ? assignmentWritesTo(databaseFile, declaration.name, checker).length === 0
        : assignmentWritesTo(databaseFile, declaration.name, checker).length === 1)
    );
  };
  const executeAndClose = (count) => [...Array(count).fill('execute'), 'close'];
  if (
    !handleIsContained(cleanupHandle, cleanupOpen, ['delete', 'close']) ||
    !handleIsContained(initial, initialOpen, executeAndClose(7)) ||
    !handleIsContained(wrongKeyHandle, wrongKeyOpen, ['execute', 'close']) ||
    !handleIsContained(reopened, reopenedOpen, executeAndClose(45)) ||
    !handleIsContained(rekeyed, rekeyedOpen, executeAndClose(3)) ||
    !handleIsContained(oldKeyHandle, oldKeyOpen, ['execute', 'close'])
  ) {
    return undefined;
  }

  const executeCallsFor = (declaration) => {
    const calls = [];
    for (const reference of runtimeReferencesToBinding(databaseFile, declaration.name, checker)) {
      const access = reference.parent;
      const call =
        access &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === reference &&
        access.name.text === 'execute'
          ? callExpression(access.parent)
          : undefined;
      if (call && call.expression === access) calls.push(call);
    }
    return calls.sort((left, right) => left.getStart(databaseFile) - right.getStart(databaseFile));
  };
  const rawSqlShape = (call) => {
    if (call.arguments.length < 1 || call.arguments.length > 2) return undefined;
    const statement = unwrapExpression(call.arguments[0]);
    const text = sqlText(statement)?.replace(/\s+/g, ' ').trim();
    const templateValues = ts.isTemplateExpression(statement)
      ? statement.templateSpans.map((span) => normalizedSnippet(span.expression, databaseFile))
      : [];
    const params = call.arguments[1] ? unwrapExpression(call.arguments[1]) : undefined;
    if (params && !ts.isArrayLiteralExpression(params)) return undefined;
    const parameterValues = params
      ? params.elements.map((element) => normalizedSnippet(element, databaseFile))
      : [];
    return { call, parameterValues, templateValues, text };
  };
  const exactRawSql = (declaration, expected) => {
    const shapes = executeCallsFor(declaration).map(rawSqlShape);
    return (
      shapes.length === expected.length &&
      shapes.every((shape, index) => {
        const wanted = expected[index];
        return (
          shape &&
          wanted &&
          shape.text === wanted[0] &&
          shape.templateValues.join(',') === wanted[1].join(',') &&
          shape.parameterValues.join(',') === wanted[2].join(',')
        );
      })
    );
  };
  if (
    !exactRawSql(initial, [
      ['PRAGMA foreign_keys = ON', [], []],
      [
        'CREATE TABLE driver_contract_migration_conflict ( state TEXT NOT NULL, last_used_at INTEGER NOT NULL, path TEXT NOT NULL )',
        [],
        [],
      ],
      [
        'CREATE INDEX attachment_cache_entries_state_lru_idx ON driver_contract_migration_conflict (state, last_used_at, path)',
        [],
        [],
      ],
      [
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'attachment_cache_entries_state_lru_idx'",
        [],
        [],
      ],
      ['SELECT name FROM _migrations ORDER BY name', [], []],
      [
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachment_cache_entries'",
        [],
        [],
      ],
      [
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'attachment_cache_entries_state_lru_idx'",
        [],
        [],
      ],
    ]) ||
    !exactRawSql(wrongKeyHandle, [['SELECT count(*) FROM sqlite_master', [], []]]) ||
    !exactRawSql(reopened, [
      ['PRAGMA foreign_keys = ON', [], []],
      ['SELECT name FROM _migrations ORDER BY name', [], []],
      ['DROP INDEX attachment_cache_entries_state_lru_idx', [], []],
      ['DROP TABLE driver_contract_migration_conflict', [], []],
      [
        'INSERT INTO chats (guid, display_name) VALUES (?, ?)',
        [],
        ["'driver-contract-chat'", "'Driver Contract'"],
      ],
      ['SELECT id FROM chats WHERE guid = ?', [], ["'driver-contract-chat'"]],
      [
        'INSERT INTO handles (id, address, display_name) VALUES (?, ?, ?)',
        [],
        ['1', "'driver-contract@example.invalid'", "'seed'"],
      ],
      [
        'INSERT INTO messages (guid, chat_id, text, date_deleted) VALUES (?, ?, ?, ?)',
        [],
        ["'driver-contract-deleted'", 'chatId', "'deleted control'", '1234'],
      ],
      [
        'INSERT INTO messages (guid, chat_id, text, date_deleted) VALUES (?, ?, ?, NULL)',
        [],
        ["'driver-contract-visible'", 'chatId', "'persistentsentinel'"],
      ],
      [
        'INSERT INTO error_reports (level, message, created_at) VALUES (?, ?, ?)',
        [],
        ["'error'", "'driver contract safe error'", '1'],
      ],
      [
        'INSERT INTO scheduled_messages (server_id, chat_guid, payload, scheduled_for, status, attempts) VALUES (?, ?, ?, ?, ?, ?)',
        [],
        ['null', "'driver-contract-local-sending'", "'{}'", '1000', "'sending'", '2'],
      ],
      [
        'INSERT INTO scheduled_messages (server_id, chat_guid, payload, scheduled_for, status, attempts) VALUES (?, ?, ?, ?, ?, ?)',
        [],
        ['7', "'driver-contract-server-sending'", "'{}'", '1001', "'sending'", '3'],
      ],
      [
        'INSERT INTO scheduled_messages (server_id, chat_guid, payload, scheduled_for, status, attempts) VALUES (?, ?, ?, ?, ?, ?)',
        [],
        ['null', "'driver-contract-local-pending'", "'{}'", '1002', "'pending'", '4'],
      ],
      ['INSERT INTO kv (key, value) VALUES (?, ?)', [], ["'privacy.redactedMode'", "'retired'"]],
      [
        'INSERT INTO kv (key, value) VALUES (?, ?)',
        [],
        ["'privacy.redactedMode.extra'", "'preserved'"],
      ],
      [
        'INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload) VALUES (?, ?, ?, ?)',
        [],
        [
          "'driver-contract-reaction-valid'",
          "'driver-contract-chat'",
          "'reaction'",
          'validReactionBefore',
        ],
      ],
      [
        'INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload) VALUES (?, ?, ?, ?)',
        [],
        [
          "'driver-contract-reaction-malformed'",
          "'driver-contract-chat'",
          "'reaction'",
          'malformedReaction',
        ],
      ],
      [
        'INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload) VALUES (?, ?, ?, ?)',
        [],
        [
          "'driver-contract-message-control'",
          "'driver-contract-chat'",
          "'message'",
          'nonReactionControl',
        ],
      ],
      [
        'SELECT guid, date_deleted FROM messages WHERE guid IN (?, ?) ORDER BY guid',
        [],
        ["'driver-contract-deleted'", "'driver-contract-visible'"],
      ],
      ['SELECT level, message, created_at FROM error_reports ORDER BY id', [], []],
      [
        'SELECT server_id, chat_guid, status, attempts FROM scheduled_messages ORDER BY chat_guid',
        [],
        [],
      ],
      ['SELECT key, value FROM kv ORDER BY key', [], []],
      [
        "SELECT temp_guid, kind, payload FROM outgoing_queue WHERE temp_guid LIKE 'driver-contract-%' ORDER BY temp_guid",
        [],
        [],
      ],
      ['SELECT name FROM _migrations ORDER BY name', [], []],
      ['SELECT guid, date_deleted FROM message_deletion_ledger ORDER BY guid', [], []],
      ['SELECT id FROM error_reports', [], []],
      [
        'SELECT server_id, chat_guid, status, attempts FROM scheduled_messages ORDER BY chat_guid',
        [],
        [],
      ],
      ['SELECT key, value FROM kv ORDER BY key', [], []],
      [
        "SELECT temp_guid, kind, payload FROM outgoing_queue WHERE temp_guid LIKE 'driver-contract-%' ORDER BY temp_guid",
        [],
        [],
      ],
      [
        'INSERT INTO messages (guid, chat_id, text) VALUES (?, ?, ?)',
        [],
        ["'driver-contract-fts'", 'chatId', "'orangesentinel'"],
      ],
      ['SELECT id FROM messages WHERE guid = ?', [], ["'driver-contract-fts'"]],
      ["SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'orangesentinel'", [], []],
      [
        'UPDATE messages SET text = ? WHERE guid = ?',
        [],
        ["'violetsentinel'", "'driver-contract-fts'"],
      ],
      ["SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'orangesentinel'", [], []],
      ["SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'violetsentinel'", [], []],
      ['DELETE FROM messages WHERE guid = ?', [], ["'driver-contract-fts'"]],
      ["SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'violetsentinel'", [], []],
      [
        "SELECT messages_fts.rowid FROM messages_fts JOIN messages ON messages.id = messages_fts.rowid WHERE messages_fts MATCH 'persistentsentinel' AND messages.guid = 'driver-contract-visible'",
        [],
        [],
      ],
      ['PRAGMA foreign_keys', [], []],
      ['PRAGMA foreign_key_check', [], []],
      ['PRAGMA integrity_check', [], []],
      ['SELECT id, display_name FROM handles WHERE id = 1', [], []],
      ['SELECT display_name FROM handles WHERE id = 1', [], []],
      ['SELECT display_name FROM handles WHERE id = 1', [], []],
      ["PRAGMA rekey = '?'", ['keyB'], []],
    ]) ||
    !exactRawSql(rekeyed, [
      ['SELECT id, display_name FROM handles WHERE id = 1', [], []],
      ['SELECT name FROM _migrations ORDER BY name', [], []],
      [
        "SELECT messages_fts.rowid FROM messages_fts JOIN messages ON messages.id = messages_fts.rowid WHERE messages_fts MATCH 'persistentsentinel' AND messages.guid = 'driver-contract-visible'",
        [],
        [],
      ],
    ]) ||
    !exactRawSql(oldKeyHandle, [['SELECT count(*) FROM sqlite_master', [], []]])
  ) {
    return undefined;
  }

  const reopenedExecuteCalls = executeCallsFor(reopened);
  const durableReadIsProved = (declaration, expectedAssertion) => {
    const extractCall = declaration.initializer
      ? callableCall(declaration.initializer, extractRows, checker)
      : undefined;
    const awaitedRaw = extractCall?.arguments[0]
      ? unwrapExpression(extractCall.arguments[0])
      : undefined;
    const rawCall =
      awaitedRaw && ts.isAwaitExpression(awaitedRaw)
        ? callExpression(awaitedRaw.expression)
        : undefined;
    const rawShape = rawCall ? rawSqlShape(rawCall) : undefined;
    const references = runtimeReferencesToBinding(databaseFile, declaration.name, checker);
    let assertionStatement;
    if (references.length === 2) {
      for (
        let current = references[1].parent;
        current && current !== selfTest;
        current = current.parent
      ) {
        if (ts.isExpressionStatement(current)) {
          assertionStatement = current;
          break;
        }
      }
    }
    return Boolean(
      extractCall &&
      extractCall.arguments.length === 1 &&
      awaitedRaw &&
      ts.isAwaitExpression(awaitedRaw) &&
      rawCall &&
      reopenedExecuteCalls.includes(rawCall) &&
      rawShape?.text === 'SELECT display_name FROM handles WHERE id = 1' &&
      rawShape.templateValues.length === 0 &&
      rawShape.parameterValues.length === 0 &&
      references[0] === declaration.name &&
      assignmentWritesTo(databaseFile, declaration.name, checker).length === 0 &&
      assertionStatement &&
      normalizedSnippet(assertionStatement, databaseFile) === expectedAssertion,
    );
  };
  if (
    !durableReadIsProved(
      afterCommit,
      "requireDriverContract(afterCommit[0]?.display_name === 'committed');",
    ) ||
    !durableReadIsProved(
      afterRollback,
      "requireDriverContract(afterRollback[0]?.display_name === 'committed');",
    )
  ) {
    return undefined;
  }

  const sqlBinding = namedImportBinding(databaseFile, 'drizzle-orm', 'sql');
  const handlesBinding = namedImportBinding(databaseFile, './schema', 'handles');
  if (!sqlBinding || !handlesBinding) return undefined;

  const clientReferences = runtimeReferencesToBinding(databaseFile, database.name, checker);
  const clientCalls = [];
  for (const reference of clientReferences) {
    if (reference === database.name) continue;
    const access = reference.parent;
    const call =
      access && ts.isPropertyAccessExpression(access) && access.expression === reference
        ? callExpression(access.parent)
        : undefined;
    if (
      !call ||
      call.expression !== access ||
      !['all', 'run', 'update'].includes(access.name.text)
    ) {
      return undefined;
    }
    let awaited = false;
    for (let current = call.parent; current && !ts.isStatement(current); current = current.parent) {
      if (ts.isAwaitExpression(current)) awaited = true;
    }
    if (!awaited) return undefined;
    clientCalls.push({ call, method: access.name.text });
  }
  clientCalls.sort(
    (left, right) => left.call.getStart(databaseFile) - right.call.getStart(databaseFile),
  );
  if (
    clientCalls
      .map(({ method }) => method)
      .sort()
      .join(',') !== 'all,run,run,run,run,run,run,run,run,run,update' ||
    assignmentWritesTo(databaseFile, database.name, checker).length !== 0
  ) {
    return undefined;
  }

  const sqlClientCalls = clientCalls.filter(({ method }) => method !== 'update');
  const sqlClientShape = ({ call, method }) => {
    if (call.arguments.length !== 1) return undefined;
    const statement = unwrapExpression(call.arguments[0]);
    if (
      !ts.isTaggedTemplateExpression(statement) ||
      !sameSymbol(unwrapExpression(statement.tag), sqlBinding, checker)
    ) {
      return undefined;
    }
    const text = templateText(statement.template)?.replace(/\s+/g, ' ').trim();
    const values = ts.isTemplateExpression(statement.template)
      ? statement.template.templateSpans.map((span) =>
          normalizedSnippet(span.expression, databaseFile),
        )
      : [];
    return { call, method, text, values };
  };
  const sqlClientShapes = sqlClientCalls.map(sqlClientShape);
  const expectedSqlClientShapes = [
    ['run', 'BEGIN IMMEDIATE', []],
    ['run', 'UPDATE handles SET display_name = ? WHERE id = ?', ["'committed'", '1']],
    ['run', 'COMMIT', []],
    ['run', 'ROLLBACK', []],
    ['run', 'BEGIN IMMEDIATE', []],
    ['run', 'UPDATE handles SET display_name = ? WHERE id = ?', ["'rolled-back'", '1']],
    ['run', 'ROLLBACK', []],
    ['run', 'ROLLBACK', []],
    [
      'all',
      'UPDATE handles SET display_name = ? WHERE id = ? RETURNING id, display_name',
      ["'sync-route'", '1'],
    ],
    ['run', 'UPDATE handles SET display_name = ? WHERE id = ?', ["'async-route'", '1']],
  ];
  if (
    sqlClientShapes.length !== expectedSqlClientShapes.length ||
    sqlClientShapes.some((shape, index) => {
      const expected = expectedSqlClientShapes[index];
      return (
        !shape ||
        !expected ||
        shape.method !== expected[0] ||
        shape.text !== expected[1] ||
        shape.values.join(',') !== expected[2].join(',')
      );
    })
  ) {
    return undefined;
  }

  const rawBuilder = clientCalls[10];
  if (
    !rawBuilder ||
    rawBuilder.method !== 'update' ||
    rawBuilder.call.arguments.length !== 1 ||
    !sameSymbol(unwrapExpression(rawBuilder.call.arguments[0]), handlesBinding, checker)
  ) {
    return undefined;
  }

  const [
    beginCommit,
    committedUpdate,
    commitBoundary,
    commitFallback,
    beginRollback,
    rolledBackUpdate,
    rollbackBoundary,
    rollbackFallback,
    syncUpdate,
    asyncUpdate,
  ] = sqlClientShapes.map((shape) => shape.call);
  const transactionWrites = assignmentWritesTo(databaseFile, transactionOpen.name, checker);
  const transactionReferences = runtimeReferencesToBinding(
    databaseFile,
    transactionOpen.name,
    checker,
  );
  const fallbackIsGuarded = (call, protectedCalls) => {
    let guard;
    for (let current = call.parent; current && current !== selfTest; current = current.parent) {
      if (
        ts.isIfStatement(current) &&
        sameSymbol(unwrapExpression(current.expression), transactionOpen.name, checker) &&
        nodeIsInside(call, current.thenStatement) &&
        !current.elseStatement
      ) {
        guard = current;
        break;
      }
    }
    if (!guard) return false;
    for (let current = guard.parent; current && current !== selfTest; current = current.parent) {
      if (
        ts.isTryStatement(current) &&
        !current.catchClause &&
        current.finallyBlock &&
        nodeIsInside(guard, current.finallyBlock) &&
        protectedCalls.every((protectedCall) => nodeIsInside(protectedCall, current.tryBlock))
      ) {
        return true;
      }
    }
    return false;
  };
  if (
    !(transactionOpen.parent.flags & ts.NodeFlags.Let) ||
    transactionOpen.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    transactionWrites.length !== 4 ||
    transactionWrites.map((write) => normalizedSnippet(write.right, databaseFile)).join(',') !==
      'true,false,true,false' ||
    transactionReferences.length !== 7 ||
    transactionReferences[0] !== transactionOpen.name ||
    !fallbackIsGuarded(commitFallback, [committedUpdate, commitBoundary]) ||
    !fallbackIsGuarded(rollbackFallback, [rolledBackUpdate, rollbackBoundary]) ||
    !(
      beginCommit.getStart(databaseFile) < transactionWrites[0].getStart(databaseFile) &&
      transactionWrites[0].getStart(databaseFile) < commitSubscribe.getStart(databaseFile) &&
      commitSubscribe.getStart(databaseFile) < committedUpdate.getStart(databaseFile) &&
      committedUpdate.getStart(databaseFile) < commitBoundary.getStart(databaseFile) &&
      commitBoundary.getStart(databaseFile) < transactionWrites[1].getStart(databaseFile) &&
      transactionWrites[1].getStart(databaseFile) < commitFallback.getStart(databaseFile) &&
      commitFallback.getStart(databaseFile) < beginRollback.getStart(databaseFile) &&
      beginRollback.getStart(databaseFile) < transactionWrites[2].getStart(databaseFile) &&
      transactionWrites[2].getStart(databaseFile) < rollbackSubscribe.getStart(databaseFile) &&
      rollbackSubscribe.getStart(databaseFile) < rolledBackUpdate.getStart(databaseFile) &&
      rolledBackUpdate.getStart(databaseFile) < rollbackBoundary.getStart(databaseFile) &&
      rollbackBoundary.getStart(databaseFile) < transactionWrites[3].getStart(databaseFile) &&
      transactionWrites[3].getStart(databaseFile) < rollbackFallback.getStart(databaseFile)
    )
  ) {
    return undefined;
  }

  const probeIsContained = (declaration, subscription, write, boundary = write) => {
    const references = runtimeReferencesToBinding(databaseFile, declaration.name, checker);
    let resultAccess;
    let unsubscribeCall;
    for (const reference of references) {
      if (reference === declaration.name) continue;
      const access = reference.parent;
      if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== reference) {
        return false;
      }
      if (access.name.text === 'result') {
        if (resultAccess) return false;
        resultAccess = access;
        continue;
      }
      if (access.name.text === 'unsubscribe') {
        const call = callExpression(access.parent);
        if (unsubscribeCall || !call || call.expression !== access || call.arguments.length !== 0) {
          return false;
        }
        unsubscribeCall = call;
        continue;
      }
      return false;
    }
    const resultAwait = resultAccess?.parent;
    const resultRequirement = resultAwait?.parent;
    let cleanupTry;
    if (unsubscribeCall) {
      for (
        let current = unsubscribeCall.parent;
        current && current !== selfTest;
        current = current.parent
      ) {
        if (
          ts.isTryStatement(current) &&
          !current.catchClause &&
          current.finallyBlock &&
          nodeIsInside(unsubscribeCall, current.finallyBlock) &&
          nodeIsInside(write, current.tryBlock) &&
          nodeIsInside(boundary, current.tryBlock) &&
          resultAccess &&
          nodeIsInside(resultAccess, current.tryBlock)
        ) {
          cleanupTry = current;
          break;
        }
      }
    }
    return Boolean(
      resultAccess &&
      ts.isAwaitExpression(resultAwait) &&
      resultRequirement &&
      ts.isCallExpression(resultRequirement) &&
      resultRequirement.arguments.length === 1 &&
      resultRequirement.arguments[0] === resultAwait &&
      callableNodeForExpression(resultRequirement.expression, checker) === requireContract &&
      unsubscribeCall &&
      cleanupTry &&
      assignmentWritesTo(databaseFile, declaration.name, checker).length === 0 &&
      subscription.getStart(databaseFile) < write.getStart(databaseFile) &&
      write.getStart(databaseFile) <= boundary.getStart(databaseFile) &&
      boundary.getStart(databaseFile) < resultAccess.getStart(databaseFile) &&
      resultAccess.getStart(databaseFile) < unsubscribeCall.getStart(databaseFile),
    );
  };
  if (
    !probeIsContained(commitProbe, commitSubscribe, committedUpdate, commitBoundary) ||
    !probeIsContained(rollbackProbe, rollbackSubscribe, rolledBackUpdate, rollbackBoundary) ||
    !probeIsContained(syncProbe, syncSubscribe, syncUpdate) ||
    !probeIsContained(asyncProbe, asyncSubscribe, asyncUpdate) ||
    !probeIsContained(rawProbe, rawSubscribe, rawBuilder.call)
  ) {
    return undefined;
  }

  const subscribeDbParameter = subscribe.parameters[0]?.name;
  const subscribeDbReferences = subscribeDbParameter
    ? runtimeReferencesToBinding(databaseFile, subscribeDbParameter, checker)
    : [];
  const reactiveReference = subscribeDbReferences[1];
  const reactiveAccess = reactiveReference?.parent;
  const reactiveCall =
    reactiveAccess && ts.isPropertyAccessExpression(reactiveAccess)
      ? callExpression(reactiveAccess.parent)
      : undefined;
  const reactiveOptions = reactiveCall?.arguments[0]
    ? unwrapExpression(reactiveCall.arguments[0])
    : undefined;
  const reactiveProperties =
    reactiveOptions && ts.isObjectLiteralExpression(reactiveOptions)
      ? reactiveOptions.properties
      : [];
  const reactiveCallbackProperty = reactiveProperties[3];
  const reactiveCallback =
    reactiveCallbackProperty && ts.isPropertyAssignment(reactiveCallbackProperty)
      ? unwrapExpression(reactiveCallbackProperty.initializer)
      : undefined;
  const expectedParameter = subscribe.parameters[1]?.name;
  const waitParameter = subscribe.parameters[2]?.name;
  const expectedReferences = expectedParameter
    ? runtimeReferencesToBinding(databaseFile, expectedParameter, checker)
    : [];
  const waitReferences = waitParameter
    ? runtimeReferencesToBinding(databaseFile, waitParameter, checker)
    : [];
  if (
    !subscribeDbParameter ||
    subscribeDbReferences.length !== 2 ||
    subscribeDbReferences[0] !== subscribeDbParameter ||
    !reactiveAccess ||
    !ts.isPropertyAccessExpression(reactiveAccess) ||
    reactiveAccess.expression !== reactiveReference ||
    reactiveAccess.name.text !== 'reactiveExecute' ||
    !reactiveCall ||
    reactiveCall.expression !== reactiveAccess ||
    reactiveCall.arguments.length !== 1 ||
    assignmentWritesTo(databaseFile, subscribeDbParameter, checker).length !== 0 ||
    !reactiveOptions ||
    !ts.isObjectLiteralExpression(reactiveOptions) ||
    reactiveProperties.length !== 4 ||
    normalizedSnippet(reactiveProperties[0], databaseFile) !==
      "query: 'SELECT display_name FROM handles WHERE id = 1'" ||
    normalizedSnippet(reactiveProperties[1], databaseFile) !== 'arguments: []' ||
    normalizedSnippet(reactiveProperties[2], databaseFile) !==
      "fireOn: [{ table: 'handles', ids: [1] }]" ||
    !reactiveCallbackProperty ||
    !ts.isPropertyAssignment(reactiveCallbackProperty) ||
    !identifierNamed(reactiveCallbackProperty.name, 'callback') ||
    !reactiveCallback ||
    !ts.isArrowFunction(reactiveCallback) ||
    !reactiveCallback.body ||
    !ts.isBlock(reactiveCallback.body) ||
    !hasExactIdentifierParameters(reactiveCallback, [{ name: 'response' }]) ||
    reactiveCallback.body.statements.length !== 2 ||
    normalizedSnippet(reactiveCallback.body.statements[0], databaseFile) !==
      'const value = extractRows(response)[0]?.display_name;' ||
    normalizedSnippet(reactiveCallback.body.statements[1], databaseFile) !==
      'if (value === expected) finish(true); else if (!waitForExpected) finish(false);' ||
    !expectedParameter ||
    expectedReferences.length !== 2 ||
    expectedReferences[0] !== expectedParameter ||
    assignmentWritesTo(databaseFile, expectedParameter, checker).length !== 0 ||
    !waitParameter ||
    waitReferences.length !== 2 ||
    waitReferences[0] !== waitParameter ||
    assignmentWritesTo(databaseFile, waitParameter, checker).length !== 0
  ) {
    return undefined;
  }

  const nameReferences = runtimeReferencesToBinding(
    databaseFile,
    nameState.declaration.name,
    checker,
  );
  const candidateOpenSet = new Set(candidateOpenCalls);
  if (
    nameReferences.length !== 7 ||
    nameReferences[0] !== nameState.declaration.name ||
    nameReferences.slice(1).some((reference) => {
      const property = reference.parent;
      const options = property?.parent;
      const call = options?.parent;
      return !(
        property &&
        ts.isPropertyAssignment(property) &&
        property.initializer === reference &&
        options &&
        ts.isObjectLiteralExpression(options) &&
        call &&
        ts.isCallExpression(call) &&
        candidateOpenSet.has(call)
      );
    })
  ) {
    return undefined;
  }

  for (const state of [rawState, drizzleState, productionNameState]) {
    if (
      runtimeReferencesToBinding(databaseFile, state.declaration.name, checker).some(
        (reference) =>
          nodeIsInside(reference, selfTest) ||
          nodeIsInside(reference, cleanup) ||
          nodeIsInside(reference, subscribe),
      )
    ) {
      return undefined;
    }
  }
  const forbiddenGetterCalls = edges.filter(
    (edge) =>
      edge.caller &&
      callableIsInside(edge.caller, selfTest) &&
      (edge.callee === getDatabase || edge.callee === getRawDatabase),
  );
  if (forbiddenGetterCalls.length !== 0) return undefined;

  const cleanupEdges = exactCallEdges(edges, selfTest, cleanup);
  const conflictEdges = exactCallEdges(edges, selfTest, expectedConflict);
  const exactColumnEdges = exactCallEdges(edges, selfTest, exactStringColumn);
  const emptyCheckCalls = directCallsToBinding(databaseFile, emptyChecks.name, checker);
  const protectedOwners = new Set([selfTest, cleanup, subscribe]);
  const ownerIsProtected = (callable) =>
    callable && [...protectedOwners].some((owner) => callableIsInside(callable, owner));
  if (
    cleanupEdges.length !== 2 ||
    edges.filter((edge) => edge.callee === cleanup).length !== 2 ||
    conflictEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === expectedConflict).length !== 2 ||
    exactColumnEdges.length !== 4 ||
    edges.filter((edge) => edge.callee === exactStringColumn).length !== 13 ||
    emptyCheckCalls.length !== 2 ||
    referenceEdges.some(
      (reference) =>
        reference.target === selfTest ||
        reference.target === cleanup ||
        reference.target === emptyChecks ||
        reference.target === expectedConflict ||
        reference.target === exactStringColumn ||
        ownerIsProtected(reference.caller),
    ) ||
    dynamicCallbacks.some((callback) => ownerIsProtected(callback.caller)) ||
    dynamicDispatches.some((dispatch) => ownerIsProtected(dispatch.caller))
  ) {
    return undefined;
  }

  const protectedFindings = findings.filter((finding) => {
    const callable = findingCallables.get(finding.id);
    return callable && ownerIsProtected(callable);
  });
  const findingSignature = (finding) =>
    `${callableDisplayName(findingCallables.get(finding.id))}|${finding.operation}|${finding.target}`;
  const expectedFindingSignatures = [
    'deleteDriverSelfTestDatabase|native-database-delete|<database-file>',
    'runDbDriverSelfTest|drizzle-update|handles',
    'runDbDriverSelfTest|sql-delete|messages',
    'runDbDriverSelfTest|sql-insert|chats',
    'runDbDriverSelfTest|sql-insert|error_reports',
    'runDbDriverSelfTest|sql-insert|handles',
    'runDbDriverSelfTest|sql-insert|kv',
    'runDbDriverSelfTest|sql-insert|kv',
    'runDbDriverSelfTest|sql-insert|messages',
    'runDbDriverSelfTest|sql-insert|messages',
    'runDbDriverSelfTest|sql-insert|messages',
    'runDbDriverSelfTest|sql-insert|outgoing_queue',
    'runDbDriverSelfTest|sql-insert|outgoing_queue',
    'runDbDriverSelfTest|sql-insert|outgoing_queue',
    'runDbDriverSelfTest|sql-insert|scheduled_messages',
    'runDbDriverSelfTest|sql-insert|scheduled_messages',
    'runDbDriverSelfTest|sql-insert|scheduled_messages',
    'runDbDriverSelfTest|sql-pragma|foreign_key_check',
    'runDbDriverSelfTest|sql-pragma|foreign_keys',
    'runDbDriverSelfTest|sql-pragma|foreign_keys',
    'runDbDriverSelfTest|sql-pragma|foreign_keys',
    'runDbDriverSelfTest|sql-pragma|integrity_check',
    'runDbDriverSelfTest|sql-pragma|rekey',
    'runDbDriverSelfTest|sql-schema|attachment_cache_entries_state_lru_idx',
    'runDbDriverSelfTest|sql-schema|attachment_cache_entries_state_lru_idx',
    'runDbDriverSelfTest|sql-schema|driver_contract_migration_conflict',
    'runDbDriverSelfTest|sql-schema|driver_contract_migration_conflict',
    'runDbDriverSelfTest|sql-update|handles',
    'runDbDriverSelfTest|sql-update|handles',
    'runDbDriverSelfTest|sql-update|messages',
    'runDbDriverSelfTest|sql-update|handles',
    'runDbDriverSelfTest|sql-update|handles',
    'runDbDriverSelfTest|transaction-begin|<connection>',
    'runDbDriverSelfTest|transaction-begin|<connection>',
    'runDbDriverSelfTest|transaction-commit|<connection>',
    'runDbDriverSelfTest|transaction-rollback|<connection>',
    'runDbDriverSelfTest|transaction-rollback|<connection>',
    'runDbDriverSelfTest|transaction-rollback|<connection>',
  ];
  if (
    protectedFindings.length !== expectedFindingSignatures.length ||
    protectedFindings.map(findingSignature).sort().join('\n') !==
      expectedFindingSignatures.sort().join('\n')
  ) {
    return undefined;
  }

  const extractCalls = directCallsToBinding(databaseFile, extractRows.name, checker).filter(
    (call) => nodeIsInside(call, selfTest) || nodeIsInside(call, subscribe),
  );
  if (extractCalls.length !== 33) return undefined;

  return {
    adapterCall: selfTestAdapterCall,
    cleanup,
    cleanupEdges,
    drizzleCall: selfTestDrizzleCall,
    extractCalls: [...extractCalls, ...historyCandidate.extractCalls],
    findingIds: new Set([
      ...protectedFindings.map((finding) => finding.id),
      ...historyCandidate.findingIds,
    ]),
    internalCallNodes: [
      ...cleanupEdges.map((edge) => edge.node),
      ...migrationCalls,
      ...historyCandidate.internalCallNodes,
    ],
    migrationCalls: [...migrationCalls, ...historyCandidate.migrationCalls],
    openCalls: [...candidateOpenCalls, ...historyCandidate.openCalls],
    protectedOwners: new Set([...protectedOwners, ...historyCandidate.protectedOwners]),
    runnerFactoryCalls: [...runnerFactoryCalls, ...historyCandidate.runnerFactoryCalls],
    selfTest,
  };
}

/**
 * Prove the one exceptional write lifecycle that runs before the shared runtime connection exists:
 * every caller of ensureDatabase shares one synchronously published promise, and initDatabase does
 * not publish either handle until its awaited PRAGMA and migrations finish. This is deliberately an
 * exact structural + symbol-identity certificate. A similarly named helper, a second initializer
 * entry point, detached work, or even a reordered publication fails closed.
 */
function startupSingleFlightDelegationTargets({
  filesByPath,
  checker,
  edges,
  mutators,
  dynamicCallbacks,
  dynamicDispatches,
  referenceEdges,
  findings,
  findingCallables,
  driverSelfTestCandidate,
  processRelaunchCandidate,
}) {
  const empty = () => new Set();
  const databaseFile = filesByPath.get('src/db/database.ts');
  const controlFile = filesByPath.get('src/services/databaseControl.ts');
  const initDatabase = topLevelFunction(filesByPath, 'src/db/database.ts', 'initDatabase');
  const getDatabase = topLevelFunction(filesByPath, 'src/db/database.ts', 'getDatabase');
  const getRawDatabase = topLevelFunction(filesByPath, 'src/db/database.ts', 'getRawDatabase');
  const runMigrations = topLevelFunction(filesByPath, 'src/db/migrate.ts', 'runMigrations');
  const opRunner = topLevelFunction(filesByPath, 'src/db/database.ts', 'opRunner');
  const drizzleAdapter = topLevelFunction(filesByPath, 'src/db/database.ts', 'drizzleAdapter');
  const resolveDbKey = topLevelFunction(filesByPath, 'src/db/key.ts', 'resolveDbKey');
  const startDatabaseOpen = topLevelFunction(
    filesByPath,
    'src/services/databaseControl.ts',
    'startDatabaseOpen',
  );
  const ensureDatabase = topLevelFunction(
    filesByPath,
    'src/services/databaseControl.ts',
    'ensureDatabase',
  );
  if (
    !databaseFile ||
    !controlFile ||
    !initDatabase?.body ||
    !getDatabase?.body ||
    !getRawDatabase?.body ||
    !runMigrations?.body ||
    !opRunner?.body ||
    !drizzleAdapter?.body ||
    !resolveDbKey?.body ||
    !startDatabaseOpen?.body ||
    !ensureDatabase?.body
  ) {
    return empty();
  }

  if (
    !hasPlainIdentifierParameters(initDatabase, ['encryptionKey']) ||
    !hasPlainIdentifierParameters(getDatabase, []) ||
    !hasPlainIdentifierParameters(getRawDatabase, []) ||
    !hasPlainIdentifierParameters(opRunner, ['db']) ||
    !hasPlainIdentifierParameters(drizzleAdapter, ['db']) ||
    !hasPlainIdentifierParameters(startDatabaseOpen, []) ||
    !hasPlainIdentifierParameters(ensureDatabase, [])
  ) {
    return empty();
  }

  const rawState = topLevelVariable(databaseFile, 'rawDb');
  const drizzleState = topLevelVariable(databaseFile, 'dbInstance');
  const flightState = topLevelVariable(controlFile, 'openInFlight');
  const dbNameState = topLevelVariable(databaseFile, 'DB_NAME');
  if (
    !rawState ||
    !drizzleState ||
    !flightState ||
    !dbNameState ||
    !(rawState.declarationList.flags & ts.NodeFlags.Let) ||
    !(drizzleState.declarationList.flags & ts.NodeFlags.Let) ||
    !(flightState.declarationList.flags & ts.NodeFlags.Let) ||
    !(dbNameState.declarationList.flags & ts.NodeFlags.Const) ||
    rawState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    drizzleState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    flightState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    !dbNameState.declaration.initializer ||
    !ts.isStringLiteralLike(dbNameState.declaration.initializer) ||
    dbNameState.declaration.initializer.text !== 'gator.db'
  ) {
    return empty();
  }

  for (const [getter, stateName] of [
    [getDatabase, 'dbInstance'],
    [getRawDatabase, 'rawDb'],
  ]) {
    const statements = getter.body.statements;
    const guard = statements[0];
    const condition =
      guard && ts.isIfStatement(guard) ? unwrapExpression(guard.expression) : undefined;
    if (
      statements.length !== 2 ||
      !guard ||
      !ts.isIfStatement(guard) ||
      !condition ||
      !ts.isPrefixUnaryExpression(condition) ||
      condition.operator !== ts.SyntaxKind.ExclamationToken ||
      !identifierNamed(condition.operand, stateName) ||
      !sameSymbol(
        unwrapExpression(condition.operand),
        stateName === 'dbInstance' ? drizzleState.declaration.name : rawState.declaration.name,
        checker,
      ) ||
      !ts.isThrowStatement(guard.thenStatement) ||
      guard.elseStatement ||
      !ts.isReturnStatement(statements[1]) ||
      !statements[1].expression ||
      !identifierNamed(statements[1].expression, stateName) ||
      !sameSymbol(
        unwrapExpression(statements[1].expression),
        stateName === 'dbInstance' ? drizzleState.declaration.name : rawState.declaration.name,
        checker,
      )
    ) {
      return empty();
    }
  }

  const initStatements = initDatabase.body.statements;
  if (initStatements.length !== 3) return empty();
  const cachedReturn = initStatements[0];
  if (
    !ts.isIfStatement(cachedReturn) ||
    !identifierNamed(cachedReturn.expression, 'dbInstance') ||
    !sameSymbol(
      unwrapExpression(cachedReturn.expression),
      drizzleState.declaration.name,
      checker,
    ) ||
    !ts.isReturnStatement(cachedReturn.thenStatement) ||
    !cachedReturn.thenStatement.expression ||
    !identifierNamed(cachedReturn.thenStatement.expression, 'dbInstance') ||
    !sameSymbol(
      unwrapExpression(cachedReturn.thenStatement.expression),
      drizzleState.declaration.name,
      checker,
    ) ||
    cachedReturn.elseStatement
  ) {
    return empty();
  }

  const openedDeclaration = singleConstDeclaration(initStatements[1], 'opened');
  const openCall = openedDeclaration?.initializer
    ? callExpression(openedDeclaration.initializer)
    : undefined;
  const openBinding = soleNamedImportBinding(databaseFile, '@op-engineering/op-sqlite', 'open');
  const openOptions = openCall?.arguments[0] ? unwrapExpression(openCall.arguments[0]) : undefined;
  const nameOption =
    openOptions && ts.isObjectLiteralExpression(openOptions)
      ? openOptions.properties[0]
      : undefined;
  const keyOption =
    openOptions && ts.isObjectLiteralExpression(openOptions)
      ? openOptions.properties[1]
      : undefined;
  if (
    !openCall ||
    !openBinding ||
    !ts.isIdentifier(unwrapExpression(openCall.expression)) ||
    !sameSymbol(unwrapExpression(openCall.expression), openBinding, checker) ||
    openCall.arguments.length !== 1 ||
    !openOptions ||
    !ts.isObjectLiteralExpression(openOptions) ||
    openOptions.properties.length !== 2 ||
    !nameOption ||
    !ts.isPropertyAssignment(nameOption) ||
    !identifierNamed(nameOption.name, 'name') ||
    !identifierNamed(nameOption.initializer, 'DB_NAME') ||
    !sameSymbol(unwrapExpression(nameOption.initializer), dbNameState.declaration.name, checker) ||
    !keyOption ||
    !ts.isShorthandPropertyAssignment(keyOption) ||
    keyOption.name.text !== 'encryptionKey' ||
    checker.getShorthandAssignmentValueSymbol(keyOption) !==
      checker.getSymbolAtLocation(initDatabase.parameters[0].name)
  ) {
    return empty();
  }

  const initialization = initStatements[2];
  if (
    !ts.isTryStatement(initialization) ||
    !initialization.catchClause ||
    initialization.finallyBlock
  ) {
    return empty();
  }
  const initialize = initialization.tryBlock.statements;
  if (initialize.length !== 6) return empty();

  const pragmaCall = awaitedCallExpression(initialize[0]);
  const pragmaAccess = pragmaCall ? callAccess(pragmaCall.expression) : undefined;
  if (
    !pragmaCall ||
    !pragmaAccess ||
    pragmaAccess.method !== 'execute' ||
    !identifierNamed(pragmaAccess.receiver, 'opened') ||
    !sameSymbol(unwrapExpression(pragmaAccess.receiver), openedDeclaration.name, checker) ||
    pragmaCall.arguments.length !== 1 ||
    !ts.isStringLiteralLike(pragmaCall.arguments[0]) ||
    pragmaCall.arguments[0].text !== 'PRAGMA foreign_keys = ON'
  ) {
    return empty();
  }

  const migrationCall = awaitedCallExpression(initialize[1]);
  const runnerCall = migrationCall?.arguments[0]
    ? callableCall(migrationCall.arguments[0], opRunner, checker)
    : undefined;
  if (
    !migrationCall ||
    callableNodeForExpression(migrationCall.expression, checker) !== runMigrations ||
    migrationCall.arguments.length !== 1 ||
    !runnerCall ||
    runnerCall.arguments.length !== 1 ||
    !identifierNamed(runnerCall.arguments[0], 'opened') ||
    !sameSymbol(unwrapExpression(runnerCall.arguments[0]), openedDeclaration.name, checker)
  ) {
    return empty();
  }

  const databaseDeclaration = singleConstDeclaration(initialize[2], 'database');
  const drizzleCall = databaseDeclaration?.initializer
    ? callExpression(databaseDeclaration.initializer)
    : undefined;
  const drizzleBinding = soleNamedImportBinding(databaseFile, 'drizzle-orm/op-sqlite', 'drizzle');
  const adapterCall = drizzleCall?.arguments[0]
    ? callableCall(drizzleCall.arguments[0], drizzleAdapter, checker)
    : undefined;
  if (
    !drizzleCall ||
    !drizzleBinding ||
    !ts.isIdentifier(unwrapExpression(drizzleCall.expression)) ||
    !sameSymbol(unwrapExpression(drizzleCall.expression), drizzleBinding, checker) ||
    drizzleCall.arguments.length !== 1 ||
    !adapterCall ||
    adapterCall.arguments.length !== 1 ||
    !identifierNamed(adapterCall.arguments[0], 'opened') ||
    !sameSymbol(unwrapExpression(adapterCall.arguments[0]), openedDeclaration.name, checker)
  ) {
    return empty();
  }
  const openReferences = runtimeReferencesToBinding(databaseFile, openBinding, checker);
  const drizzleReferences = runtimeReferencesToBinding(databaseFile, drizzleBinding, checker);
  const expectedOpenReferences = new Set([
    unwrapExpression(openCall.expression),
    ...(driverSelfTestCandidate?.openCalls ?? []).map((candidate) =>
      unwrapExpression(candidate.expression),
    ),
    ...(processRelaunchCandidate?.openCalls ?? []).map((candidate) =>
      unwrapExpression(candidate.expression),
    ),
  ]);
  const expectedDrizzleReferences = new Set([
    unwrapExpression(drizzleCall.expression),
    ...(driverSelfTestCandidate
      ? [unwrapExpression(driverSelfTestCandidate.drizzleCall.expression)]
      : []),
    ...(processRelaunchCandidate
      ? [unwrapExpression(processRelaunchCandidate.drizzleCall.expression)]
      : []),
  ]);
  if (
    openReferences.length !== expectedOpenReferences.size ||
    openReferences.some((reference) => !expectedOpenReferences.has(reference)) ||
    drizzleReferences.length !== expectedDrizzleReferences.size ||
    drizzleReferences.some((reference) => !expectedDrizzleReferences.has(reference)) ||
    hasRuntimeModuleLoad(databaseFile, '@op-engineering/op-sqlite') ||
    hasRuntimeModuleLoad(databaseFile, 'drizzle-orm/op-sqlite')
  ) {
    return empty();
  }

  const rawPublication = identifierAssignment(initialize[3], 'rawDb', 'opened');
  const drizzlePublication = identifierAssignment(initialize[4], 'dbInstance', 'database');
  if (
    !rawPublication ||
    !drizzlePublication ||
    !ts.isReturnStatement(initialize[5]) ||
    !initialize[5].expression ||
    !identifierNamed(initialize[5].expression, 'database')
  ) {
    return empty();
  }

  const catchClause = initialization.catchClause;
  const errorName = catchClause.variableDeclaration?.name;
  const failureStatements = catchClause.block.statements;
  const closeTry = failureStatements[0];
  if (
    !errorName ||
    !ts.isIdentifier(errorName) ||
    failureStatements.length !== 2 ||
    !ts.isTryStatement(closeTry) ||
    closeTry.tryBlock.statements.length !== 1 ||
    !ts.isExpressionStatement(closeTry.tryBlock.statements[0]) ||
    !closeTry.catchClause ||
    closeTry.catchClause.block.statements.length !== 0 ||
    closeTry.finallyBlock ||
    !ts.isThrowStatement(failureStatements[1]) ||
    !failureStatements[1].expression ||
    !identifierNamed(failureStatements[1].expression, errorName.text)
  ) {
    return empty();
  }
  const closeCall = callExpression(closeTry.tryBlock.statements[0].expression);
  const closeAccess = closeCall ? callAccess(closeCall.expression) : undefined;
  if (
    !closeCall ||
    !closeAccess ||
    closeAccess.method !== 'close' ||
    !identifierNamed(closeAccess.receiver, 'opened') ||
    !sameSymbol(unwrapExpression(closeAccess.receiver), openedDeclaration.name, checker) ||
    closeCall.arguments.length !== 0
  ) {
    return empty();
  }

  const startStatements = startDatabaseOpen.body.statements;
  if (startStatements.length !== 4) return empty();
  const attemptDeclaration = singleConstDeclaration(startStatements[0], 'attempt');
  const attemptCall = attemptDeclaration?.initializer
    ? callExpression(attemptDeclaration.initializer)
    : undefined;
  const attemptCallback = attemptCall ? unwrapExpression(attemptCall.expression) : undefined;
  if (
    !attemptCall ||
    attemptCall.arguments.length !== 0 ||
    !attemptCallback ||
    !ts.isArrowFunction(attemptCallback) ||
    !hasPlainIdentifierParameters(attemptCallback, []) ||
    !attemptCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !ts.isBlock(attemptCallback.body) ||
    attemptCallback.body.statements.length !== 2
  ) {
    return empty();
  }
  const keyDeclaration = singleConstDeclaration(attemptCallback.body.statements[0], 'key');
  const keyInitializer = keyDeclaration?.initializer
    ? unwrapExpression(keyDeclaration.initializer)
    : undefined;
  const keyCall =
    keyInitializer && ts.isAwaitExpression(keyInitializer)
      ? callableCall(keyInitializer.expression, resolveDbKey, checker)
      : undefined;
  const initReturn = attemptCallback.body.statements[1];
  const initCall =
    ts.isReturnStatement(initReturn) && initReturn.expression
      ? callableCall(initReturn.expression, initDatabase, checker)
      : undefined;
  if (
    !keyCall ||
    keyCall.arguments.length !== 1 ||
    !identifierNamed(keyCall.arguments[0], 'vault') ||
    !initCall ||
    initCall.arguments.length !== 1 ||
    !identifierNamed(initCall.arguments[0], 'key') ||
    !sameSymbol(unwrapExpression(initCall.arguments[0]), keyDeclaration.name, checker)
  ) {
    return empty();
  }

  const clearDeclaration = singleConstDeclaration(startStatements[1], 'clear');
  const clearCallback = clearDeclaration?.initializer
    ? unwrapExpression(clearDeclaration.initializer)
    : undefined;
  if (
    !clearCallback ||
    !ts.isArrowFunction(clearCallback) ||
    !hasPlainIdentifierParameters(clearCallback, []) ||
    !ts.isBlock(clearCallback.body) ||
    clearCallback.body.statements.length !== 1 ||
    !ts.isIfStatement(clearCallback.body.statements[0])
  ) {
    return empty();
  }
  const clearIf = clearCallback.body.statements[0];
  const clearCondition = unwrapExpression(clearIf.expression);
  const clearAssignment = ts.isExpressionStatement(clearIf.thenStatement)
    ? unwrapExpression(clearIf.thenStatement.expression)
    : undefined;
  if (
    !ts.isBinaryExpression(clearCondition) ||
    clearCondition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !identifierNamed(clearCondition.left, 'openInFlight') ||
    !sameSymbol(unwrapExpression(clearCondition.left), flightState.declaration.name, checker) ||
    !identifierNamed(clearCondition.right, 'attempt') ||
    !sameSymbol(unwrapExpression(clearCondition.right), attemptDeclaration.name, checker) ||
    !clearAssignment ||
    !ts.isBinaryExpression(clearAssignment) ||
    clearAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !identifierNamed(clearAssignment.left, 'openInFlight') ||
    !sameSymbol(unwrapExpression(clearAssignment.left), flightState.declaration.name, checker) ||
    clearAssignment.right.kind !== ts.SyntaxKind.NullKeyword ||
    clearIf.elseStatement
  ) {
    return empty();
  }
  const settleStatement = startStatements[2];
  const settleCall = ts.isExpressionStatement(settleStatement)
    ? callExpression(settleStatement.expression)
    : undefined;
  const settleAccess = settleCall ? callAccess(settleCall.expression) : undefined;
  if (
    !settleCall ||
    !settleAccess ||
    settleAccess.method !== 'then' ||
    !identifierNamed(settleAccess.receiver, 'attempt') ||
    !sameSymbol(unwrapExpression(settleAccess.receiver), attemptDeclaration.name, checker) ||
    settleCall.arguments.length !== 2 ||
    !identifierNamed(settleCall.arguments[0], 'clear') ||
    !sameSymbol(unwrapExpression(settleCall.arguments[0]), clearDeclaration.name, checker) ||
    !identifierNamed(settleCall.arguments[1], 'clear') ||
    !sameSymbol(unwrapExpression(settleCall.arguments[1]), clearDeclaration.name, checker) ||
    !ts.isReturnStatement(startStatements[3]) ||
    !startStatements[3].expression ||
    !identifierNamed(startStatements[3].expression, 'attempt') ||
    !sameSymbol(unwrapExpression(startStatements[3].expression), attemptDeclaration.name, checker)
  ) {
    return empty();
  }

  const ensureStatements = ensureDatabase.body.statements;
  if (ensureStatements.length !== 3) return empty();
  const fastPath = ensureStatements[0];
  const fastReturn = ts.isTryStatement(fastPath) ? fastPath.tryBlock.statements[0] : undefined;
  const getCall =
    fastReturn &&
    ts.isReturnStatement(fastReturn) &&
    fastReturn.expression &&
    fastPath.tryBlock.statements.length === 1
      ? callableCall(fastReturn.expression, getDatabase, checker)
      : undefined;
  if (
    !ts.isTryStatement(fastPath) ||
    !fastPath.catchClause ||
    fastPath.catchClause.variableDeclaration ||
    fastPath.catchClause.block.statements.length !== 0 ||
    fastPath.finallyBlock ||
    !getCall ||
    getCall.arguments.length !== 0
  ) {
    return empty();
  }
  const flightStatement = ensureStatements[1];
  const flightAssignment = ts.isExpressionStatement(flightStatement)
    ? unwrapExpression(flightStatement.expression)
    : undefined;
  const startCall =
    flightAssignment &&
    ts.isBinaryExpression(flightAssignment) &&
    flightAssignment.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
    identifierNamed(flightAssignment.left, 'openInFlight') &&
    sameSymbol(unwrapExpression(flightAssignment.left), flightState.declaration.name, checker)
      ? callableCall(flightAssignment.right, startDatabaseOpen, checker)
      : undefined;
  if (
    !flightAssignment ||
    !ts.isBinaryExpression(flightAssignment) ||
    !startCall ||
    startCall.arguments.length !== 0 ||
    !ts.isReturnStatement(ensureStatements[2]) ||
    !ensureStatements[2].expression ||
    !identifierNamed(ensureStatements[2].expression, 'openInFlight') ||
    !sameSymbol(
      unwrapExpression(ensureStatements[2].expression),
      flightState.declaration.name,
      checker,
    )
  ) {
    return empty();
  }

  const rawWrites = assignmentWritesTo(databaseFile, rawState.declaration.name, checker);
  const drizzleWrites = assignmentWritesTo(databaseFile, drizzleState.declaration.name, checker);
  const flightWrites = assignmentWritesTo(controlFile, flightState.declaration.name, checker);
  if (
    rawWrites.length !== 1 ||
    rawWrites[0] !== rawPublication ||
    drizzleWrites.length !== 1 ||
    drizzleWrites[0] !== drizzlePublication ||
    flightWrites.length !== 2 ||
    !flightWrites.includes(clearAssignment) ||
    !flightWrites.includes(flightAssignment)
  ) {
    return empty();
  }

  const expectedMigrationCalls = new Set([
    migrationCall,
    ...(driverSelfTestCandidate?.migrationCalls ?? []),
    ...(processRelaunchCandidate?.migrationCalls ?? []),
  ]);
  const incomingMigrationCalls = edges.filter((edge) => edge.callee === runMigrations);
  if (
    incomingMigrationCalls.length !== expectedMigrationCalls.size ||
    incomingMigrationCalls.some((edge) => !expectedMigrationCalls.has(edge.node))
  ) {
    return empty();
  }

  const exactIncomingCalls = [
    [attemptCallback, attemptCall],
    [initDatabase, initCall],
    [startDatabaseOpen, startCall],
  ];
  for (const [target, expectedNode] of exactIncomingCalls) {
    const incoming = edges.filter((edge) => edge.callee === target);
    if (incoming.length !== 1 || incoming[0].node !== expectedNode) return empty();
  }

  const protectedTargets = new Set([runMigrations, initDatabase, startDatabaseOpen]);
  if (
    hasNonStaticModuleSpecifierOfPath(filesByPath, 'src/db/database.ts') ||
    hasNonStaticModuleSpecifierOfPath(filesByPath, 'src/db/migrate.ts') ||
    hasNonStaticModuleSpecifierOfPath(filesByPath, 'src/services/databaseControl.ts') ||
    hasProjectLocalCommonJsLoad(filesByPath) ||
    referenceEdges.some(
      (reference) => typeof reference.target !== 'string' && protectedTargets.has(reference.target),
    ) ||
    dynamicDispatches.some((dispatch) =>
      dispatch.possibleCallees.some((callable) => protectedTargets.has(callable)),
    )
  ) {
    return empty();
  }

  const protectedOwners = [
    initDatabase,
    getDatabase,
    getRawDatabase,
    startDatabaseOpen,
    ensureDatabase,
  ];
  const allowedMutatorCalls = new Set([migrationCall, attemptCall, initCall, startCall]);
  if (
    edges.some(
      (edge) =>
        edge.caller &&
        mutators.has(edge.callee) &&
        protectedOwners.some((owner) => callableIsInside(edge.caller, owner)) &&
        !allowedMutatorCalls.has(edge.node),
    ) ||
    dynamicCallbacks.some(
      (callback) =>
        callback.caller &&
        protectedOwners.some((owner) => callableIsInside(callback.caller, owner)),
    ) ||
    dynamicDispatches.some(
      (dispatch) =>
        dispatch.caller &&
        protectedOwners.some((owner) => callableIsInside(dispatch.caller, owner)),
    ) ||
    findings.some((finding) => {
      const callable = findingCallables.get(finding.id);
      return (
        callable &&
        callable !== initDatabase &&
        protectedOwners.some((owner) => callableIsInside(callable, owner))
      );
    })
  ) {
    return empty();
  }

  return new Set([attemptCallback, initDatabase, startDatabaseOpen, ensureDatabase]);
}

/**
 * Prove the five raw driver calls that cannot use the normal transaction-owner graph.
 *
 * The migration runner has exactly fifteen awaited call sites: the unpublished production
 * first-open handle, six same-process disposable probes, three relaunch probes, four
 * active-migration-death probes, and the fixed DB-02C runtime-concurrency probe. Thirteen adopt
 * opRunner directly; the remaining two use the exact identity-bound prefix and crash wrapper
 * triples before awaited runMigrations. The three Drizzle overrides are coordinated adapter calls:
 * a private, exact Proxy forwards one operation to the sole op-sqlite handle used by each of the
 * three exact Drizzle clients. Any escape, detached runner call, extra override, dependency drift,
 * or newly unresolved raw write empties both sets.
 */
function driverAdapterCertifiedCallables({
  root,
  filesByPath,
  checker,
  edges,
  findings,
  findingCallables,
  startupSingleFlightTargets,
  driverSelfTestCandidate,
  processRelaunchCandidate,
}) {
  const empty = () => ({
    coordinated: new Set(),
    temporal: new Set(),
    throwawayDelegationCallNodes: new Set(),
    throwawayFindingIds: new Set(),
    throwawayCallNodes: new Set(),
  });
  const databasePath = 'src/db/database.ts';
  const migrationPath = 'src/db/migrate.ts';
  const databaseFile = filesByPath.get(databasePath);
  const migrationFile = filesByPath.get(migrationPath);
  const initDatabase = topLevelFunction(filesByPath, databasePath, 'initDatabase');
  const extractRows = topLevelFunction(filesByPath, databasePath, 'extractRows');
  const opRunner = topLevelFunction(filesByPath, databasePath, 'opRunner');
  const drizzleAdapter = topLevelFunction(filesByPath, databasePath, 'drizzleAdapter');
  const runMigrations = topLevelFunction(filesByPath, migrationPath, 'runMigrations');
  if (
    !databaseFile ||
    !migrationFile ||
    !initDatabase?.body ||
    !extractRows?.body ||
    !opRunner?.body ||
    !drizzleAdapter?.body ||
    !runMigrations?.body ||
    !driverSelfTestCandidate ||
    !processRelaunchCandidate ||
    !startupSingleFlightTargets.has(initDatabase)
  ) {
    return empty();
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  } catch {
    return empty();
  }
  if (
    packageJson?.dependencies?.['@op-engineering/op-sqlite'] !== '17.1.2' ||
    packageJson?.dependencies?.['drizzle-orm'] !== '0.45.2'
  ) {
    return empty();
  }

  const isNativeLibSymbol = (node) => {
    const symbol = unaliasSymbol(checker.getSymbolAtLocation(node), checker);
    return Boolean(
      symbol?.declarations?.length &&
      symbol.declarations.every((declaration) => {
        const source = declaration.getSourceFile();
        return (
          source.isDeclarationFile &&
          /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(normalizePath(source.fileName))
        );
      }),
    );
  };
  const sole = (values) => (values.length === 1 ? values[0] : undefined);
  const statementIs = (statement, text) =>
    Boolean(statement && normalizedSnippet(statement, statement.getSourceFile()) === text);
  const hasOnlyAsyncModifier = (callable) =>
    callable.modifiers?.length === 1 &&
    callable.modifiers[0]?.kind === ts.SyntaxKind.AsyncKeyword &&
    !callable.asteriskToken;
  const hasRuntimeIdentifierNamed = (node, names) => {
    let found = false;
    const visit = (current) => {
      if (found) return;
      if (
        ts.isIdentifier(current) &&
        names.has(current.text) &&
        !isCompileTimeOnlyReference(current)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };

  if (
    !hasExactIdentifierParameters(extractRows, [{ name: 'res' }]) ||
    !hasExactIdentifierParameters(opRunner, [{ name: 'db' }]) ||
    !hasExactIdentifierParameters(drizzleAdapter, [{ name: 'db' }]) ||
    !hasExactIdentifierParameters(runMigrations, [{ name: 'runner' }]) ||
    opRunner.modifiers?.length ||
    opRunner.asteriskToken ||
    drizzleAdapter.modifiers?.length ||
    drizzleAdapter.asteriskToken ||
    hasRuntimeIdentifierNamed(runMigrations, new Set(['arguments'])) ||
    hasRuntimeIdentifierNamed(databaseFile, new Set(['eval', 'Function'])) ||
    hasRuntimeIdentifierNamed(migrationFile, new Set(['eval', 'Function']))
  ) {
    return empty();
  }

  const extractStatements = extractRows.body.statements;
  if (
    extractStatements.length !== 5 ||
    !statementIs(extractStatements[0], 'const r = res as { rows?: unknown };') ||
    !statementIs(
      extractStatements[1],
      'if (Array.isArray(r?.rows)) return r.rows as Array<Record<string, unknown>>;',
    ) ||
    !statementIs(
      extractStatements[2],
      'const legacy = (r?.rows as { _array?: unknown })?._array;',
    ) ||
    !statementIs(
      extractStatements[3],
      'if (Array.isArray(legacy)) return legacy as Array<Record<string, unknown>>;',
    ) ||
    !statementIs(extractStatements[4], 'return [];')
  ) {
    return empty();
  }
  const runtimeArrayIdentifiers = [];
  const collectRuntimeArrayIdentifiers = (node) => {
    if (ts.isIdentifier(node) && node.text === 'Array' && !isCompileTimeOnlyReference(node)) {
      runtimeArrayIdentifiers.push(node);
    }
    ts.forEachChild(node, collectRuntimeArrayIdentifiers);
  };
  collectRuntimeArrayIdentifiers(extractRows);
  if (
    runtimeArrayIdentifiers.length !== 2 ||
    runtimeArrayIdentifiers.some((identifier) => !isNativeLibSymbol(identifier))
  ) {
    return empty();
  }

  const runnerReturn = opRunner.body.statements[0];
  const runnerObject =
    runnerReturn && ts.isReturnStatement(runnerReturn) && runnerReturn.expression
      ? unwrapExpression(runnerReturn.expression)
      : undefined;
  if (
    opRunner.body.statements.length !== 1 ||
    !runnerObject ||
    !ts.isObjectLiteralExpression(runnerObject) ||
    runnerObject.properties.length !== 2
  ) {
    return empty();
  }
  const execMethod = runnerObject.properties[0];
  const queryMethod = runnerObject.properties[1];
  if (
    !execMethod ||
    !ts.isMethodDeclaration(execMethod) ||
    !execMethod.body ||
    !identifierNamed(execMethod.name, 'exec') ||
    !hasOnlyAsyncModifier(execMethod) ||
    !hasExactIdentifierParameters(execMethod, [{ name: 'sql' }, { name: 'params' }]) ||
    !queryMethod ||
    !ts.isMethodDeclaration(queryMethod) ||
    !queryMethod.body ||
    !identifierNamed(queryMethod.name, 'query') ||
    !hasOnlyAsyncModifier(queryMethod) ||
    !hasExactIdentifierParameters(queryMethod, [{ name: 'sql' }, { name: 'params' }]) ||
    execMethod.body.statements.length !== 1 ||
    !statementIs(
      execMethod.body.statements[0],
      'await db.execute(sql, (params as never[]) ?? []);',
    ) ||
    queryMethod.body.statements.length !== 2 ||
    !statementIs(
      queryMethod.body.statements[0],
      'const res = await db.execute(sql, (params as never[]) ?? []);',
    ) ||
    !statementIs(queryMethod.body.statements[1], 'return extractRows(res) as never[];')
  ) {
    return empty();
  }

  const execCall = awaitedCallExpression(execMethod.body.statements[0]);
  const execAccess = execCall ? callAccess(execCall.expression) : undefined;
  const queryResult = singleConstDeclaration(queryMethod.body.statements[0], 'res');
  const queryAwait = queryResult?.initializer
    ? unwrapExpression(queryResult.initializer)
    : undefined;
  const queryCall =
    queryAwait && ts.isAwaitExpression(queryAwait)
      ? callExpression(queryAwait.expression)
      : undefined;
  const queryAccess = queryCall ? callAccess(queryCall.expression) : undefined;
  const queryReturn = queryMethod.body.statements[1];
  const extractCall =
    ts.isReturnStatement(queryReturn) && queryReturn.expression
      ? callableCall(queryReturn.expression, extractRows, checker)
      : undefined;
  const runnerDbParameter = opRunner.parameters[0]?.name;
  if (
    !runnerDbParameter ||
    !execCall ||
    !execAccess ||
    execAccess.method !== 'execute' ||
    !sameSymbol(unwrapExpression(execAccess.receiver), runnerDbParameter, checker) ||
    execCall.arguments.length !== 2 ||
    !sameSymbol(unwrapExpression(execCall.arguments[0]), execMethod.parameters[0].name, checker) ||
    !queryCall ||
    !queryAccess ||
    queryAccess.method !== 'execute' ||
    !sameSymbol(unwrapExpression(queryAccess.receiver), runnerDbParameter, checker) ||
    queryCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(queryCall.arguments[0]),
      queryMethod.parameters[0].name,
      checker,
    ) ||
    !extractCall ||
    extractCall.arguments.length !== 1 ||
    !queryResult ||
    !sameSymbol(unwrapExpression(extractCall.arguments[0]), queryResult.name, checker)
  ) {
    return empty();
  }

  const runnerFactoryCalls = directCallsToBinding(databaseFile, opRunner.name, checker);
  const disposableRunnerCalls = new Set([
    ...driverSelfTestCandidate.runnerFactoryCalls,
    ...processRelaunchCandidate.runnerFactoryCalls,
  ]);
  const productionRunnerCall = sole(
    runnerFactoryCalls.filter((call) => !disposableRunnerCalls.has(call)),
  );
  const runnerFactoryReferences = runtimeReferencesToBinding(databaseFile, opRunner.name, checker);
  const extractReferences = runtimeReferencesToBinding(databaseFile, extractRows.name, checker);
  const expectedExtractReferences = new Set([
    extractRows.name,
    unwrapExpression(extractCall.expression),
    ...driverSelfTestCandidate.extractCalls.map((call) => unwrapExpression(call.expression)),
    ...processRelaunchCandidate.extractCalls.map((call) => unwrapExpression(call.expression)),
  ]);
  const productionMigrationCall = productionRunnerCall?.parent;
  const expectedRunnerCalls = new Set([
    productionRunnerCall,
    ...driverSelfTestCandidate.runnerFactoryCalls,
    ...processRelaunchCandidate.runnerFactoryCalls,
  ]);
  const expectedMigrationCalls = new Set([
    productionMigrationCall,
    ...driverSelfTestCandidate.migrationCalls,
    ...processRelaunchCandidate.migrationCalls,
  ]);
  const nestedRunnerAdoptions = processRelaunchCandidate.nestedRunnerAdoptions;
  const nestedRunnerAdoptionByFactoryCall = new Map(
    nestedRunnerAdoptions.map((adoption) => [adoption.runnerFactoryCall, adoption]),
  );
  if (
    !productionRunnerCall ||
    !productionMigrationCall ||
    expectedRunnerCalls.size !== 15 ||
    expectedMigrationCalls.size !== 15 ||
    nestedRunnerAdoptions.length !== 2 ||
    nestedRunnerAdoptionByFactoryCall.size !== 2 ||
    runnerFactoryCalls.length !== expectedRunnerCalls.size ||
    runnerFactoryCalls.some((call) => !expectedRunnerCalls.has(call)) ||
    runnerFactoryCalls.some((runnerCall) => {
      const nestedAdoption = nestedRunnerAdoptionByFactoryCall.get(runnerCall);
      const wrapperCall = nestedAdoption?.wrapperCall;
      const migrationCall = nestedAdoption?.migrationCall ?? runnerCall.parent;
      return (
        runnerCall.arguments.length !== 1 ||
        (nestedAdoption &&
          (runnerCall.parent !== wrapperCall ||
            wrapperCall?.arguments[0] !== runnerCall ||
            wrapperCall.parent !== migrationCall)) ||
        !migrationCall ||
        !ts.isCallExpression(migrationCall) ||
        migrationCall.arguments.length !== 1 ||
        migrationCall.arguments[0] !== (nestedAdoption ? wrapperCall : runnerCall) ||
        callableNodeForExpression(migrationCall.expression, checker) !== runMigrations ||
        !ts.isAwaitExpression(migrationCall.parent) ||
        !expectedMigrationCalls.has(migrationCall)
      );
    }) ||
    runnerFactoryReferences.length !== 16 ||
    runnerFactoryReferences[0] !== opRunner.name ||
    runnerFactoryReferences.slice(1).some((reference) => {
      const runnerCall = reference.parent;
      return !expectedRunnerCalls.has(runnerCall);
    }) ||
    extractReferences.length !== expectedExtractReferences.size ||
    extractReferences.some((reference) => !expectedExtractReferences.has(reference)) ||
    edges.filter((edge) => edge.callee === runMigrations).length !== expectedMigrationCalls.size ||
    edges
      .filter((edge) => edge.callee === runMigrations)
      .some((edge) => !expectedMigrationCalls.has(edge.node))
  ) {
    return empty();
  }

  const migrationRunnerParameter = runMigrations.parameters[0]?.name;
  const migrationRunnerReferences = migrationRunnerParameter
    ? runtimeReferencesToBinding(migrationFile, migrationRunnerParameter, checker)
    : [];
  const migrationStatements = runMigrations.body.statements;
  if (
    !migrationRunnerParameter ||
    migrationStatements.length !== 6 ||
    !statementIs(
      migrationStatements[0],
      'await runner.exec( `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)`, );',
    ) ||
    !statementIs(
      migrationStatements[1],
      'const rows = await runner.query<{ name: string }>(`SELECT name FROM _migrations`);',
    ) ||
    !statementIs(migrationStatements[2], 'const applied = new Set(rows.map((r) => r.name));') ||
    !statementIs(migrationStatements[3], 'const ran: string[] = [];') ||
    !statementIs(
      migrationStatements[4],
      "for (const migration of MIGRATIONS) { if (applied.has(migration.name)) continue; // Each migration is atomic: a failure rolls back so partial tables never // linger (which would make a retry fail with \"table already exists\"). await runner.exec('BEGIN'); try { for (const statement of migration.statements) { await runner.exec(statement); } await runner.exec(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, [ migration.name, Date.now(), ]); await runner.exec('COMMIT'); } catch (e) { await runner.exec('ROLLBACK').catch(() => undefined); throw e; } ran.push(migration.name); }",
    ) ||
    !statementIs(migrationStatements[5], 'return ran;') ||
    migrationRunnerReferences.length !== 8 ||
    migrationRunnerReferences[0] !== migrationRunnerParameter ||
    assignmentWritesTo(migrationFile, migrationRunnerParameter, checker).length !== 0
  ) {
    return empty();
  }
  const migrationRunnerCalls = [];
  for (const reference of migrationRunnerReferences.slice(1)) {
    const access = reference.parent;
    const call =
      access && ts.isPropertyAccessExpression(access) ? callExpression(access.parent) : undefined;
    if (
      !access ||
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== reference ||
      access.questionDotToken ||
      !call ||
      call.expression !== access ||
      call.questionDotToken ||
      !isDirectlyInsideCallable(call, runMigrations)
    ) {
      return empty();
    }
    migrationRunnerCalls.push({ call, method: access.name.text });
  }
  if (
    migrationRunnerCalls.map(({ method }) => method).join(',') !==
      'exec,query,exec,exec,exec,exec,exec' ||
    migrationRunnerCalls.slice(0, 6).some(({ call }) => !ts.isAwaitExpression(call.parent))
  ) {
    return empty();
  }
  const rollbackCall = migrationRunnerCalls[6]?.call;
  const rollbackCatchAccess = rollbackCall?.parent;
  const rollbackCatchCall =
    rollbackCatchAccess && ts.isPropertyAccessExpression(rollbackCatchAccess)
      ? callExpression(rollbackCatchAccess.parent)
      : undefined;
  const rollbackCatchCallback = rollbackCatchCall?.arguments[0]
    ? unwrapExpression(rollbackCatchCall.arguments[0])
    : undefined;
  if (
    !rollbackCall ||
    rollbackCall.arguments.length !== 1 ||
    !ts.isStringLiteralLike(rollbackCall.arguments[0]) ||
    rollbackCall.arguments[0].text !== 'ROLLBACK' ||
    !rollbackCatchAccess ||
    !ts.isPropertyAccessExpression(rollbackCatchAccess) ||
    rollbackCatchAccess.expression !== rollbackCall ||
    rollbackCatchAccess.name.text !== 'catch' ||
    !rollbackCatchCall ||
    rollbackCatchCall.expression !== rollbackCatchAccess ||
    rollbackCatchCall.arguments.length !== 1 ||
    !rollbackCatchCallback ||
    !ts.isArrowFunction(rollbackCatchCallback) ||
    !hasExactIdentifierParameters(rollbackCatchCallback, []) ||
    !identifierNamed(rollbackCatchCallback.body, 'undefined') ||
    !ts.isAwaitExpression(rollbackCatchCall.parent)
  ) {
    return empty();
  }

  const adapterStatements = drizzleAdapter.body.statements;
  if (
    adapterStatements.length !== 8 ||
    !statementIs(
      adapterStatements[0],
      'const wrap = (r: { rows?: unknown[] }): unknown => ({ ...r, rows: { _array: r.rows ?? [] } });',
    ) ||
    !statementIs(
      adapterStatements[1],
      'const flush = (): void => void db.flushPendingReactiveQueries();',
    ) ||
    !statementIs(adapterStatements[2], 'let transactionOpen = false;') ||
    !statementIs(
      adapterStatements[3],
      "const transactionCommand = (statement: string): string => statement.trim().replace(/;+$/, '').toUpperCase();",
    ) ||
    !statementIs(
      adapterStatements[4],
      "const flushAfter = (command: string): void => { if (command.startsWith('BEGIN')) { transactionOpen = true; return; } if (command === 'COMMIT' || command === 'ROLLBACK') { transactionOpen = false; flush(); return; } if (!transactionOpen) flush(); };",
    ) ||
    !statementIs(
      adapterStatements[5],
      "const retireFailedRollback = (command: string): void => { // SQLite may auto-abort before reporting a ROLLBACK error. The shared transaction owner // deliberately contains that cleanup error, so the adapter must not suppress every later // autocommit notification under a stale in-memory transaction flag. if (command === 'ROLLBACK') transactionOpen = false; };",
    ) ||
    !statementIs(
      adapterStatements[6],
      'const overrides: Record<string, unknown> = { execute: (statement: string, params?: unknown[]) => { const command = transactionCommand(statement); try { const r = db.executeSync(statement, (params as never[]) ?? []); flushAfter(command); return wrap(r); } catch (error) { retireFailedRollback(command); throw error; } }, executeAsync: async (statement: string, params?: unknown[]) => { const command = transactionCommand(statement); try { const r = await db.execute(statement, (params as never[]) ?? []); flushAfter(command); return wrap(r); } catch (error) { retireFailedRollback(command); throw error; } }, executeRawAsync: async (statement: string, params?: unknown[]) => { const command = transactionCommand(statement); try { const r = await db.executeRaw(statement, (params as never[]) ?? []); flushAfter(command); return r.rawRows; } catch (error) { retireFailedRollback(command); throw error; } }, };',
    ) ||
    !statementIs(
      adapterStatements[7],
      "return new Proxy(db as object, { get(target, prop, receiver) { if (typeof prop === 'string' && prop in overrides) return overrides[prop]; const value = Reflect.get(target, prop, receiver); return typeof value === 'function' ? value.bind(target) : value; }, }) as RawDb;",
    )
  ) {
    return empty();
  }
  const wrapDeclaration = singleConstDeclaration(adapterStatements[0], 'wrap');
  const flushDeclaration = singleConstDeclaration(adapterStatements[1], 'flush');
  const transactionStatement = adapterStatements[2];
  const transactionDeclaration =
    transactionStatement &&
    ts.isVariableStatement(transactionStatement) &&
    transactionStatement.declarationList.declarations.length === 1
      ? transactionStatement.declarationList.declarations[0]
      : undefined;
  const transactionCommandDeclaration = singleConstDeclaration(
    adapterStatements[3],
    'transactionCommand',
  );
  const flushAfterDeclaration = singleConstDeclaration(adapterStatements[4], 'flushAfter');
  const retireFailedRollbackDeclaration = singleConstDeclaration(
    adapterStatements[5],
    'retireFailedRollback',
  );
  const overridesDeclaration = singleConstDeclaration(adapterStatements[6], 'overrides');
  const wrapCallable = wrapDeclaration?.initializer
    ? unwrapExpression(wrapDeclaration.initializer)
    : undefined;
  const flushCallable = flushDeclaration?.initializer
    ? unwrapExpression(flushDeclaration.initializer)
    : undefined;
  const transactionCommandCallable = transactionCommandDeclaration?.initializer
    ? unwrapExpression(transactionCommandDeclaration.initializer)
    : undefined;
  const flushAfterCallable = flushAfterDeclaration?.initializer
    ? unwrapExpression(flushAfterDeclaration.initializer)
    : undefined;
  const retireFailedRollbackCallable = retireFailedRollbackDeclaration?.initializer
    ? unwrapExpression(retireFailedRollbackDeclaration.initializer)
    : undefined;
  const overridesObject = overridesDeclaration?.initializer
    ? unwrapExpression(overridesDeclaration.initializer)
    : undefined;
  if (
    !wrapCallable ||
    !ts.isArrowFunction(wrapCallable) ||
    !flushCallable ||
    !ts.isArrowFunction(flushCallable) ||
    !transactionDeclaration ||
    !ts.isIdentifier(transactionDeclaration.name) ||
    transactionDeclaration.name.text !== 'transactionOpen' ||
    !(transactionStatement.declarationList.flags & ts.NodeFlags.Let) ||
    transactionDeclaration.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    !transactionCommandCallable ||
    !ts.isArrowFunction(transactionCommandCallable) ||
    !hasExactIdentifierParameters(transactionCommandCallable, [{ name: 'statement' }]) ||
    !flushAfterCallable ||
    !ts.isArrowFunction(flushAfterCallable) ||
    !hasExactIdentifierParameters(flushAfterCallable, [{ name: 'command' }]) ||
    !retireFailedRollbackCallable ||
    !ts.isArrowFunction(retireFailedRollbackCallable) ||
    !hasExactIdentifierParameters(retireFailedRollbackCallable, [{ name: 'command' }]) ||
    !overridesObject ||
    !ts.isObjectLiteralExpression(overridesObject) ||
    overridesObject.properties.length !== 3
  ) {
    return empty();
  }
  const overrideCallables = [];
  for (const [index, expected] of ['execute', 'executeAsync', 'executeRawAsync'].entries()) {
    const property = overridesObject.properties[index];
    const callable =
      property && ts.isPropertyAssignment(property)
        ? unwrapExpression(property.initializer)
        : undefined;
    if (
      !property ||
      !ts.isPropertyAssignment(property) ||
      !identifierNamed(property.name, expected) ||
      !callable ||
      !ts.isArrowFunction(callable) ||
      !hasExactIdentifierParameters(callable, [
        { name: 'statement' },
        { name: 'params', optional: true },
      ]) ||
      (expected === 'execute'
        ? Boolean(callable.modifiers?.length) || Boolean(callable.asteriskToken)
        : !hasOnlyAsyncModifier(callable))
    ) {
      return empty();
    }
    overrideCallables.push(callable);
  }

  const adapterDbParameter = drizzleAdapter.parameters[0]?.name;
  const adapterDbReferences = adapterDbParameter
    ? runtimeReferencesToBinding(databaseFile, adapterDbParameter, checker)
    : [];
  const wrapReferences = wrapDeclaration
    ? runtimeReferencesToBinding(databaseFile, wrapDeclaration.name, checker)
    : [];
  const flushReferences = flushDeclaration
    ? runtimeReferencesToBinding(databaseFile, flushDeclaration.name, checker)
    : [];
  const transactionReferences = transactionDeclaration
    ? runtimeReferencesToBinding(databaseFile, transactionDeclaration.name, checker)
    : [];
  const transactionCommandReferences = transactionCommandDeclaration
    ? runtimeReferencesToBinding(databaseFile, transactionCommandDeclaration.name, checker)
    : [];
  const flushAfterReferences = flushAfterDeclaration
    ? runtimeReferencesToBinding(databaseFile, flushAfterDeclaration.name, checker)
    : [];
  const retireFailedRollbackReferences = retireFailedRollbackDeclaration
    ? runtimeReferencesToBinding(databaseFile, retireFailedRollbackDeclaration.name, checker)
    : [];
  const overridesReferences = overridesDeclaration
    ? runtimeReferencesToBinding(databaseFile, overridesDeclaration.name, checker)
    : [];
  const adapterFactoryCalls = directCallsToBinding(databaseFile, drizzleAdapter.name, checker);
  const adapterFactoryCall = sole(
    adapterFactoryCalls.filter(
      (call) =>
        call !== driverSelfTestCandidate.adapterCall &&
        call !== processRelaunchCandidate.adapterCall,
    ),
  );
  const adapterFactoryReferences = runtimeReferencesToBinding(
    databaseFile,
    drizzleAdapter.name,
    checker,
  );
  if (
    !adapterDbParameter ||
    adapterDbReferences.length !== 6 ||
    adapterDbReferences[0] !== adapterDbParameter ||
    assignmentWritesTo(databaseFile, adapterDbParameter, checker).length !== 0 ||
    wrapReferences.length !== 3 ||
    wrapReferences[0] !== wrapDeclaration.name ||
    flushReferences.length !== 3 ||
    flushReferences[0] !== flushDeclaration.name ||
    transactionReferences.length !== 5 ||
    transactionReferences[0] !== transactionDeclaration.name ||
    assignmentWritesTo(databaseFile, transactionDeclaration.name, checker).length !== 3 ||
    transactionCommandReferences.length !== 4 ||
    transactionCommandReferences[0] !== transactionCommandDeclaration.name ||
    flushAfterReferences.length !== 4 ||
    flushAfterReferences[0] !== flushAfterDeclaration.name ||
    retireFailedRollbackReferences.length !== 4 ||
    retireFailedRollbackReferences[0] !== retireFailedRollbackDeclaration.name ||
    overridesReferences.length !== 3 ||
    overridesReferences[0] !== overridesDeclaration.name ||
    adapterFactoryCalls.length !== 3 ||
    !adapterFactoryCalls.includes(driverSelfTestCandidate.adapterCall) ||
    !adapterFactoryCalls.includes(processRelaunchCandidate.adapterCall) ||
    !adapterFactoryCall ||
    adapterFactoryCall.arguments.length !== 1 ||
    adapterFactoryReferences.length !== 4 ||
    adapterFactoryReferences[0] !== drizzleAdapter.name ||
    !adapterFactoryReferences.includes(unwrapExpression(adapterFactoryCall.expression)) ||
    !adapterFactoryReferences.includes(
      unwrapExpression(driverSelfTestCandidate.adapterCall.expression),
    ) ||
    !adapterFactoryReferences.includes(
      unwrapExpression(processRelaunchCandidate.adapterCall.expression),
    )
  ) {
    return empty();
  }
  const drizzleCall = adapterFactoryCall.parent;
  const drizzleBinding = soleNamedImportBinding(databaseFile, 'drizzle-orm/op-sqlite', 'drizzle');
  if (
    !drizzleCall ||
    !ts.isCallExpression(drizzleCall) ||
    drizzleCall.arguments.length !== 1 ||
    drizzleCall.arguments[0] !== adapterFactoryCall ||
    !drizzleBinding ||
    !sameSymbol(unwrapExpression(drizzleCall.expression), drizzleBinding, checker) ||
    !nodeIsInside(drizzleCall, initDatabase)
  ) {
    return empty();
  }

  const nativeIdentifiers = [];
  const collectNativeIdentifiers = (node) => {
    if (ts.isIdentifier(node) && (node.text === 'Proxy' || node.text === 'Reflect')) {
      nativeIdentifiers.push(node);
    }
    ts.forEachChild(node, collectNativeIdentifiers);
  };
  collectNativeIdentifiers(drizzleAdapter);
  if (
    nativeIdentifiers.length !== 2 ||
    nativeIdentifiers.some((identifier) => !isNativeLibSymbol(identifier))
  ) {
    return empty();
  }

  const temporal = new Set([execMethod, queryMethod]);
  const coordinated = new Set(overrideCallables);
  const driverFindings = findings.filter(
    (finding) =>
      finding.path === databasePath &&
      finding.detectedContext === 'driver-adapter' &&
      !driverSelfTestCandidate.findingIds.has(finding.id) &&
      !processRelaunchCandidate.rawFindingIds.has(finding.id),
  );
  const expectedCallables = new Set([...temporal, ...coordinated]);
  if (
    driverFindings.length !== 5 ||
    driverFindings.some(
      (finding) =>
        finding.operation !== 'raw-dynamic' ||
        finding.target !== '<dynamic>' ||
        !expectedCallables.has(findingCallables.get(finding.id)),
    ) ||
    [...expectedCallables].some(
      (callable) =>
        driverFindings.filter((finding) => findingCallables.get(finding.id) === callable).length !==
        1,
    ) ||
    findings.some(
      (finding) =>
        !driverFindings.includes(finding) &&
        !driverSelfTestCandidate.findingIds.has(finding.id) &&
        !processRelaunchCandidate.allFindingIds.has(finding.id) &&
        !COORDINATED_CONTEXTS.has(finding.detectedContext) &&
        !TEMPORAL_EXCLUSION_CONTEXTS.has(finding.detectedContext),
    )
  ) {
    return empty();
  }

  return {
    coordinated,
    temporal,
    throwawayFindingIds: new Set([
      ...driverSelfTestCandidate.findingIds,
      ...processRelaunchCandidate.rawFindingIds,
    ]),
    throwawayCallNodes: new Set([
      ...driverSelfTestCandidate.internalCallNodes,
      ...processRelaunchCandidate.databaseCallNodes,
    ]),
    throwawayDelegationCallNodes: new Set(processRelaunchCandidate.orchestrationCallNodes),
  };
}

function topLevelObjectMethod(filesByPath, path, variableName, methodName) {
  const file = filesByPath.get(path);
  const variable = file ? topLevelVariable(file, variableName) : undefined;
  const initializer = variable?.declaration.initializer
    ? unwrapExpression(variable.declaration.initializer)
    : undefined;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return undefined;
  const matches = initializer.properties.filter(
    (property) =>
      ts.isMethodDeclaration(property) &&
      property.body &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === methodName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function topLevelClassConstructor(filesByPath, path, className) {
  const file = filesByPath.get(path);
  if (!file) return undefined;
  const classes = file.statements.filter(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (classes.length !== 1) return undefined;
  const constructors = classes[0].members.filter(
    (member) => ts.isConstructorDeclaration(member) && member.body,
  );
  return constructors.length === 1 ? constructors[0] : undefined;
}

function nodeIsInside(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function statementText(callable, index) {
  const statement =
    callable?.body && ts.isBlock(callable.body) ? callable.body.statements[index] : undefined;
  return statement ? normalizedSnippet(statement, statement.getSourceFile()) : undefined;
}

function exactCallEdges(edges, caller, callee) {
  return edges.filter((edge) => edge.caller === caller && edge.callee === callee);
}

/** Shared fail-closed proof for the synchronous, process-wide foreground-boot composition. */
function foregroundBootCompositionCandidate(root, filesByPath, checker, edges, dynamicDispatches) {
  const foregroundPath = 'src/services/boot/foregroundBoot.ts';
  const invalidationPath = 'src/services/boot/foregroundBootInvalidation.ts';
  const foregroundFile = filesByPath.get(foregroundPath);
  const invalidationFile = filesByPath.get(invalidationPath);
  const initializeForegroundBootComposition = topLevelFunction(
    filesByPath,
    foregroundPath,
    'initializeForegroundBootComposition',
  );
  const startForegroundBoot = topLevelFunction(filesByPath, foregroundPath, 'startForegroundBoot');
  const subscribeForegroundBoot = topLevelFunction(
    filesByPath,
    foregroundPath,
    'subscribeForegroundBoot',
  );
  const compositionInitialized = foregroundFile
    ? topLevelVariable(foregroundFile, 'compositionInitialized')
    : undefined;
  if (
    !foregroundFile ||
    !invalidationFile ||
    !initializeForegroundBootComposition?.body ||
    !startForegroundBoot?.body ||
    !subscribeForegroundBoot?.body ||
    !compositionInitialized?.declaration.initializer
  ) {
    return undefined;
  }

  const entryPath = resolve(root, 'index.js');
  const packagePath = resolve(root, 'package.json');
  if (!existsSync(entryPath) || !existsSync(packagePath)) return undefined;
  let packageMain;
  try {
    packageMain = JSON.parse(readFileSync(packagePath, 'utf8'))?.main;
  } catch {
    return undefined;
  }
  const entryFile = ts.createSourceFile(
    entryPath,
    readFileSync(entryPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const expectedEntryImports = [
    './src/services/errors/registerReactNativeExceptionPrivacy',
    './src/services/logging/registerPersistentLogs',
    './src/services/notifications/backgroundEvents',
    './src/services/background/registerBackgroundSyncHeadlessTask',
    './src/services/notifications/registerFcmBackgroundHandler',
    './src/services/download/registerBoundedNativeDownloadCleanup',
    'expo-router/entry',
  ];
  const entryImports = entryFile.statements.map((statement) =>
    ts.isImportDeclaration(statement) &&
    !statement.importClause &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined,
  );
  if (
    packageMain !== 'index.js' ||
    entryImports.length !== expectedEntryImports.length ||
    entryImports.some((specifier, index) => specifier !== expectedEntryImports[index])
  ) {
    return undefined;
  }

  const compositionStatements = initializeForegroundBootComposition.body.statements;
  const compositionGuard = compositionStatements[0];
  const compositionClaimStatement = compositionStatements[1];
  const compositionClaim =
    compositionClaimStatement && ts.isExpressionStatement(compositionClaimStatement)
      ? unwrapExpression(compositionClaimStatement.expression)
      : undefined;
  if (
    !(compositionInitialized.declarationList.flags & ts.NodeFlags.Let) ||
    compositionInitialized.declaration.initializer.kind !== ts.SyntaxKind.FalseKeyword ||
    !hasExactIdentifierParameters(initializeForegroundBootComposition, []) ||
    compositionStatements.length !== 6 ||
    createHash('sha256')
      .update(normalizedSnippet(initializeForegroundBootComposition, foregroundFile))
      .digest('hex') !== '860764eab237d7ef345ce11ff24eac3181805d55b80ce28090fcd01ffecf7105' ||
    !compositionGuard ||
    !ts.isIfStatement(compositionGuard) ||
    !sameSymbol(
      unwrapExpression(compositionGuard.expression),
      compositionInitialized.declaration.name,
      checker,
    ) ||
    !ts.isReturnStatement(compositionGuard.thenStatement) ||
    compositionGuard.thenStatement.expression ||
    compositionGuard.elseStatement ||
    !compositionClaim ||
    !ts.isBinaryExpression(compositionClaim) ||
    compositionClaim.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !sameSymbol(
      unwrapExpression(compositionClaim.left),
      compositionInitialized.declaration.name,
      checker,
    ) ||
    compositionClaim.right.kind !== ts.SyntaxKind.TrueKeyword ||
    assignmentWritesTo(foregroundFile, compositionInitialized.declaration.name, checker).length !==
      1 ||
    assignmentWritesTo(foregroundFile, compositionInitialized.declaration.name, checker)[0] !==
      compositionClaim
  ) {
    return undefined;
  }

  const installerSpecs = [
    {
      name: 'installForegroundBootInvalidator',
      statementIndex: 3,
      hash: 'd2c36b418e464d48ddeb084c13edb216546d502fa3447308312e1f02e5b9ab55',
      slotName: 'invalidateOwner',
      consumerName: 'invalidateForegroundBootForAccountTransition',
      consumerHash: '66c339c7277629a5fc2fd50c7656db22406a62487997ddf237fdbd883fe163f6',
    },
    {
      name: 'installForegroundBootRestarter',
      statementIndex: 4,
      hash: '0ff75f4e7d8c9a2f22d0fba835517132ce724bafcac16fd8b66ea291b33f4a9e',
      slotName: 'restartOwner',
      consumerName: 'restartForegroundBootAfterAccountTransition',
      consumerHash: 'f59466864e9b8758856e02e1eb7cef4b5be90636d4b2ccdda6bcbacbd6492a1e',
    },
    {
      name: 'installForegroundBootIssueReporter',
      statementIndex: 5,
      hash: 'fcc8b07d30866399c39431ec78019ccac9393dd59efc0990b37af74c786bd525',
      slotName: 'issueOwner',
      consumerName: 'reportForegroundBootIssue',
      consumerHash: 'a2b0f54ca212e58a247694e2ae2555d51556dd425145bb66bedc10713f7e6dcf',
    },
  ].map((spec) => ({
    ...spec,
    target: topLevelFunction(filesByPath, invalidationPath, spec.name),
    binding: namedImportBinding(foregroundFile, './foregroundBootInvalidation', spec.name),
    slot: topLevelVariable(invalidationFile, spec.slotName),
    consumer: topLevelFunction(filesByPath, invalidationPath, spec.consumerName),
  }));
  if (
    installerSpecs.some(
      (spec) =>
        !spec.target?.body ||
        !spec.binding ||
        !spec.slot?.declaration.initializer ||
        !spec.consumer?.body,
    )
  ) {
    return undefined;
  }

  const protectedTargets = new Set([
    initializeForegroundBootComposition,
    ...installerSpecs.map((spec) => spec.target),
  ]);
  const symbolExposesProtectedTarget = (symbol, seen = new Set()) => {
    const current = unaliasSymbol(symbol, checker);
    if (!current || seen.has(current)) return false;
    seen.add(current);
    const callable = callableNodeFromSymbol(current, checker);
    if (callable && protectedTargets.has(callable)) return true;
    return Boolean(
      current.flags & ts.SymbolFlags.Module &&
      checker
        .getExportsOfModule(current)
        .some((exported) => symbolExposesProtectedTarget(exported, seen)),
    );
  };
  const moduleExportsProtectedTarget = (file) => {
    const moduleSymbol = checker.getSymbolAtLocation(file) ?? file.symbol;
    return symbolExposesProtectedTarget(moduleSymbol);
  };
  let hasProtectedRuntimeModuleLoad = false;
  for (const [importerPath, file] of filesByPath) {
    function visit(node) {
      if (hasProtectedRuntimeModuleLoad) return;
      if (ts.isCallExpression(node)) {
        const loader = unwrapExpression(node.expression);
        if (loader.kind === ts.SyntaxKind.ImportKeyword || identifierNamed(loader, 'require')) {
          const argument = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
          if (!argument || !ts.isStringLiteralLike(argument)) {
            hasProtectedRuntimeModuleLoad = true;
            return;
          }
          if (
            projectModulePathCandidates(importerPath, argument.text)
              .map((path) => filesByPath.get(path))
              .filter(Boolean)
              .some(moduleExportsProtectedTarget)
          ) {
            hasProtectedRuntimeModuleLoad = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (hasProtectedRuntimeModuleLoad) break;
  }
  const hasProtectedNamespaceReference = [...filesByPath.values()].some((file) =>
    file.statements.some((statement) => {
      const bindings = [];
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        if (statement.importClause.name) bindings.push(statement.importClause.name);
        const namedBindings = statement.importClause.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          bindings.push(namedBindings.name);
        } else if (namedBindings && ts.isNamedImports(namedBindings)) {
          bindings.push(...namedBindings.elements.map((element) => element.name));
        }
      } else if (ts.isImportEqualsDeclaration(statement)) {
        bindings.push(statement.name);
      }
      return bindings.some((binding) => {
        const importedSymbol = unaliasSymbol(checker.getSymbolAtLocation(binding), checker);
        if (
          !importedSymbol ||
          !(importedSymbol.flags & ts.SymbolFlags.Module) ||
          !symbolExposesProtectedTarget(importedSymbol)
        ) {
          return false;
        }
        return runtimeReferencesToBinding(file, binding, checker).some(
          (reference) => reference !== binding,
        );
      });
    }),
  );
  if (
    hasProtectedRuntimeModuleLoad ||
    hasProtectedNamespaceReference ||
    dynamicDispatches.some((dispatch) =>
      dispatch.possibleCallees.some((callable) => protectedTargets.has(callable)),
    )
  ) {
    return undefined;
  }

  const compositionStartEdges = exactCallEdges(
    edges,
    startForegroundBoot,
    initializeForegroundBootComposition,
  );
  const compositionSubscribeEdges = exactCallEdges(
    edges,
    subscribeForegroundBoot,
    initializeForegroundBootComposition,
  );
  const referencesByBinding = runtimeReferencesToBindings(
    filesByPath.values(),
    [
      initializeForegroundBootComposition.name,
      ...installerSpecs.flatMap((spec) => [spec.target.name, spec.slot.declaration.name]),
    ],
    checker,
  );
  const compositionReferences = referencesByBinding?.get(initializeForegroundBootComposition.name);
  if (
    compositionStartEdges.length !== 1 ||
    compositionSubscribeEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === initializeForegroundBootComposition).length !== 2 ||
    !compositionReferences ||
    compositionReferences.length !== 3 ||
    !compositionReferences.includes(initializeForegroundBootComposition.name) ||
    !compositionReferences.includes(unwrapExpression(compositionStartEdges[0]?.node.expression)) ||
    !compositionReferences.includes(unwrapExpression(compositionSubscribeEdges[0]?.node.expression))
  ) {
    return undefined;
  }

  const installers = [];
  for (const spec of installerSpecs) {
    const calls = directCallsToBinding(foregroundFile, spec.binding, checker);
    const call = calls[0];
    const callEdges = exactCallEdges(edges, initializeForegroundBootComposition, spec.target);
    const references = referencesByBinding?.get(spec.target.name);
    const slotWrites = assignmentWritesTo(invalidationFile, spec.slot.declaration.name, checker);
    const slotReferences = referencesByBinding?.get(spec.slot.declaration.name);
    const slotStatement = spec.slot.declarationList.parent;
    if (
      !sameSymbol(spec.binding, spec.target.name, checker) ||
      createHash('sha256')
        .update(normalizedSnippet(spec.target, invalidationFile))
        .digest('hex') !== spec.hash ||
      !(spec.slot.declarationList.flags & ts.NodeFlags.Let) ||
      spec.slot.declaration.initializer.kind !== ts.SyntaxKind.NullKeyword ||
      !ts.isVariableStatement(slotStatement) ||
      Boolean(slotStatement.modifiers?.length) ||
      createHash('sha256')
        .update(normalizedSnippet(spec.consumer, invalidationFile))
        .digest('hex') !== spec.consumerHash ||
      slotWrites.length !== 2 ||
      slotWrites.some((write) => !nodeIsInside(write, spec.target)) ||
      !slotReferences ||
      !slotReferences.includes(spec.slot.declaration.name) ||
      slotReferences.some(
        (reference) =>
          reference !== spec.slot.declaration.name &&
          !nodeIsInside(reference, spec.target) &&
          !nodeIsInside(reference, spec.consumer),
      ) ||
      calls.length !== 1 ||
      !call ||
      call.parent !== compositionStatements[spec.statementIndex] ||
      call.arguments.length !== 1 ||
      callEdges.length !== 1 ||
      callEdges[0]?.node !== call ||
      edges.filter((edge) => edge.callee === spec.target).length !== 1 ||
      !references ||
      references.length !== 2 ||
      !references.includes(spec.target.name) ||
      !references.includes(unwrapExpression(call.expression))
    ) {
      return undefined;
    }
    installers.push({ ...spec, call });
  }

  return {
    initializeForegroundBootComposition,
    compositionStatements,
    compositionStartEdges,
    compositionSubscribeEdges,
    compositionReferences,
    installers,
  };
}

function nestedCallEdges(edges, owner, callee) {
  return edges.filter(
    (edge) => edge.caller && callableIsInside(edge.caller, owner) && edge.callee === callee,
  );
}

function oneInlineCallback(call, argumentIndex, parameterName) {
  const expression = call.arguments[argumentIndex];
  const callback = expression ? unwrapExpression(expression) : undefined;
  return callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    hasPlainIdentifierParameters(callback, [parameterName])
    ? callback
    : undefined;
}

function incomingIngressRoots(filesByPath) {
  return new Set(
    [
      topLevelFunction(filesByPath, 'src/services/realtimeControl.ts', 'dispatchRealtimeEvent'),
      topLevelFunction(
        filesByPath,
        'src/services/notifications/fcmMessaging.ts',
        'handleIncomingFcm',
      ),
    ].filter(Boolean),
  );
}

/**
 * Certify only the exact AST call/reference nodes that form socket, FCM, and DEV admission into
 * the durable incoming-event queue. The two public roots are seeded independently so a failed
 * certificate keeps the full finding surface visible as unresolved instead of making it vanish.
 * Every check below is tied to a concrete function, statement, symbol, or call node; comments and
 * same-named lookalikes cannot confer ownership.
 */
function incomingIngressCertifiedNodes({
  root,
  program,
  filesByPath,
  checker,
  edges,
  referenceEdges,
  dynamicCallbacks,
  dynamicDispatches,
  foregroundBootComposition,
  mutators,
  findings,
  findingCallables,
}) {
  const empty = () => new Set();
  const controlPath = 'src/services/realtimeControl.ts';
  const dispatcherPath = 'src/services/realtime/incomingEventDispatcher.ts';
  const drainPath = 'src/services/realtime/incomingEventDrain.ts';
  const codecPath = 'src/core/realtime/incomingEventCodec.ts';
  const routerPath = 'src/core/realtime/eventRouter.ts';
  const coordinatorPath = 'src/services/realtime/deliveryCoordinator.ts';
  const socketPath = 'src/services/realtime/socketService.ts';
  const fcmPath = 'src/services/notifications/fcmMessaging.ts';
  const fcmRegistrationPath = 'src/services/notifications/registerFcmBackgroundHandler.ts';
  const foregroundBootPath = 'src/services/boot/foregroundBoot.ts';
  const devPath = 'src/features/conversations/devSeed.ts';
  const chatPath = 'app/(app)/chat/[guid].tsx';
  const digestPath = 'src/services/realtime/expoDigestBackend.ts';

  const controlFile = filesByPath.get(controlPath);
  const dispatcherFile = filesByPath.get(dispatcherPath);
  const drainFile = filesByPath.get(drainPath);
  const codecFile = filesByPath.get(codecPath);
  const coordinatorFile = filesByPath.get(coordinatorPath);
  const socketFile = filesByPath.get(socketPath);
  const fcmFile = filesByPath.get(fcmPath);
  const fcmRegistrationFile = filesByPath.get(fcmRegistrationPath);
  const foregroundBootFile = filesByPath.get(foregroundBootPath);
  const devFile = filesByPath.get(devPath);
  const chatFile = filesByPath.get(chatPath);
  const digestFile = filesByPath.get(digestPath);
  if (
    !controlFile ||
    !dispatcherFile ||
    !drainFile ||
    !codecFile ||
    !coordinatorFile ||
    !socketFile ||
    !fcmFile ||
    !fcmRegistrationFile ||
    !foregroundBootFile ||
    !devFile ||
    !chatFile ||
    !digestFile
  ) {
    return empty();
  }

  const fn = (path, name) => topLevelFunction(filesByPath, path, name);
  const method = (path, className, name) => topLevelClassMethod(filesByPath, path, className, name);
  const dispatchRealtimeEvent = fn(controlPath, 'dispatchRealtimeEvent');
  const dispatchWithContext = fn(controlPath, 'dispatchWithContext');
  const applyNewServerUrl = fn(controlPath, 'applyNewServerUrl');
  const resetRealtimeRuntime = fn(controlPath, 'resetRealtimeRuntime');
  const getRealtimeRuntime = fn(controlPath, 'getRealtimeRuntime');
  const getFallbackOccurrenceNamespace = fn(controlPath, 'getFallbackOccurrenceNamespace');
  const realtimeSink = fn(controlPath, 'realtimeSink');
  const sharedRouter = fn(controlPath, 'sharedRouter');
  const realtimeIntakeLocked = fn(controlPath, 'realtimeIntakeLocked');
  const canPersistRealtimeEvent = fn(controlPath, 'canPersistRealtimeEvent');
  const createDevProofContext = fn(controlPath, 'createDevProofContext');
  const devPersist = fn(controlPath, 'devPersistRealtimeEventWithoutDrain');
  const devResume = fn(controlPath, 'devResumePersistedRealtimeEvents');
  const startRealtime = fn(controlPath, 'startRealtime');
  const resumeRealtime = fn(controlPath, 'resumeRealtime');
  const devPushInject = topLevelObjectMethod(filesByPath, controlPath, 'devPush', 'inject');
  const runTrackedWork = fn(coordinatorPath, 'runTrackedRealtimeWork');
  const runTrackedDelivery = fn(coordinatorPath, 'runTrackedRealtimeDelivery');
  const captureRealtimeDeliveryLease = fn(coordinatorPath, 'captureRealtimeDeliveryLease');
  const pauseRealtimeDeliveries = fn(coordinatorPath, 'pauseRealtimeDeliveries');
  const resumeRealtimeDeliveries = fn(coordinatorPath, 'resumeRealtimeDeliveries');
  const subscribeRealtimeGenerationInvalidation = fn(
    coordinatorPath,
    'subscribeRealtimeGenerationInvalidation',
  );
  const expoDigestSha256 = topLevelObjectMethod(
    filesByPath,
    digestPath,
    'expoDigestBackend',
    'sha256',
  );
  const effectivelyLocked = fn('src/services/notifications/lockGate.ts', 'effectivelyLocked');
  const isLockExpired = fn('src/core/security/lockTimeout.ts', 'isLockExpired');
  const strictServerOrigin = fn('src/core/config/serverDiscovery.ts', 'strictServerOrigin');
  const isDevServer = fn('src/utils/isDev.ts', 'isDevServer');
  const readAccountRevocationState = fn(
    'src/core/secure/accountRevocation.ts',
    'readAccountRevocationState',
  );
  const hasActiveServerSession = fn('src/core/secure/vault.ts', 'hasActiveServerSession');
  const ensureDatabase = fn('src/services/databaseControl.ts', 'ensureDatabase');
  const captureIncomingEvent = fn(codecPath, 'captureIncomingEvent');
  const snapshotIncomingEvent = fn(codecPath, 'snapshotIncomingEvent');
  const canonicalizeIncomingEvent = fn(codecPath, 'canonicalizeIncomingEvent');
  const normalizeRealtimeEvent = fn(routerPath, 'normalizeRealtimeEvent');
  const durableHandle = method(dispatcherPath, 'DurableRealtimeDispatcher', 'handle');
  const durablePersist = method(
    dispatcherPath,
    'DurableRealtimeDispatcher',
    'persistWithoutDrainForDev',
  );
  const durableResume = method(dispatcherPath, 'DurableRealtimeDispatcher', 'resume');
  const durableDispose = method(dispatcherPath, 'DurableRealtimeDispatcher', 'dispose');
  const queuePersistence = method(dispatcherPath, 'DurableRealtimeDispatcher', 'queuePersistence');
  const persistAdmission = method(dispatcherPath, 'DurableRealtimeDispatcher', 'persist');
  const finishAdmission = method(dispatcherPath, 'DurableRealtimeDispatcher', 'finishAdmission');
  const enqueueIncomingEvent = fn('src/db/repositories/incomingEvents.ts', 'enqueueIncomingEvent');
  const enqueueAndClaimIncomingEventIfQueueEmpty = fn(
    'src/db/repositories/incomingEvents.ts',
    'enqueueAndClaimIncomingEventIfQueueEmpty',
  );
  const drainDispose = method(drainPath, 'IncomingEventDrain', 'dispose');
  const drainCancelWakeTimer = method(drainPath, 'IncomingEventDrain', 'cancelWakeTimer');
  const socketConstructor = topLevelClassConstructor(filesByPath, socketPath, 'SocketService');
  const makeProcessSocketOccurrenceNonce = fn(socketPath, 'makeProcessSocketOccurrenceNonce');
  const makeSocketOccurrenceNamespace = fn(socketPath, 'makeSocketOccurrenceNamespace');
  const socketConnect = method(socketPath, 'SocketService', 'connect');
  const socketOpen = method(socketPath, 'SocketService', 'openSocket');
  const socketEscalate = method(socketPath, 'SocketService', 'runEscalation');
  const socketDisconnect = method(socketPath, 'SocketService', 'disconnect');
  const socketRetire = method(socketPath, 'SocketService', 'retireCurrentConnection');
  const captureFcm = fn(fcmPath, 'captureFcmDelivery');
  const storedAppLockRequiresProtection = fn(fcmPath, 'storedAppLockRequiresProtection');
  const parseFcmData = fn(fcmPath.replace('fcmMessaging.ts', 'fcmPayload.ts'), 'parseFcmData');
  const rehydrateFcmEnvelopeChatGuid = fn(
    fcmPath.replace('fcmMessaging.ts', 'fcmPayload.ts'),
    'rehydrateFcmEnvelopeChatGuid',
  );
  const decryptFcmPayload = fn(
    fcmPath.replace('fcmMessaging.ts', 'fcmDecrypt.ts'),
    'decryptFcmPayload',
  );
  const deliver = fn(fcmPath, 'deliver');
  const deliverRespectingLock = fn(fcmPath, 'deliverRespectingLock');
  const handleIncomingFcm = fn(fcmPath, 'handleIncomingFcm');
  const handleBackgroundFcm = fn(fcmPath, 'handleBackgroundFcm');
  const startFcm = fn(fcmPath, 'startFcm');
  const startProcessWork = fn(foregroundBootPath, 'startProcessWork');
  const initializeForegroundBootComposition = fn(
    foregroundBootPath,
    'initializeForegroundBootComposition',
  );
  const startForegroundBoot = fn(foregroundBootPath, 'startForegroundBoot');
  const readFcmSessionState = fn(
    'src/services/notifications/fcmSessionGate.ts',
    'readFcmSessionState',
  );
  const postLockedNotification = fn(
    'src/services/notifications/notifeeService.ts',
    'postLockedNotification',
  );
  const flushHeadlessLogs = fn(
    'src/services/logging/fileLogSink.ts',
    'flushPersistentLogsForHeadlessCompletion',
  );
  const runDevAccountWrite = fn(devPath, 'runDevAccountWrite');
  const devQueue = fn(devPath, 'devQueueIncomingMessageWithoutDrain');
  const devResumeQueued = fn(devPath, 'devResumeQueuedIncomingMessages');
  const injectMessage = fn(devPath, 'injectMessage');
  const injectFaceTime = fn(devPath, 'devInjectIncomingFaceTime');
  const injectEffect = fn(devPath, 'devInjectEffect');
  const chatScreen = fn(chatPath, 'ChatScreenInner');
  const required = [
    dispatchRealtimeEvent,
    dispatchWithContext,
    applyNewServerUrl,
    resetRealtimeRuntime,
    getRealtimeRuntime,
    getFallbackOccurrenceNamespace,
    realtimeSink,
    sharedRouter,
    realtimeIntakeLocked,
    canPersistRealtimeEvent,
    createDevProofContext,
    devPersist,
    devResume,
    startRealtime,
    resumeRealtime,
    devPushInject,
    runTrackedWork,
    runTrackedDelivery,
    captureRealtimeDeliveryLease,
    pauseRealtimeDeliveries,
    resumeRealtimeDeliveries,
    subscribeRealtimeGenerationInvalidation,
    expoDigestSha256,
    effectivelyLocked,
    isLockExpired,
    strictServerOrigin,
    isDevServer,
    readAccountRevocationState,
    hasActiveServerSession,
    ensureDatabase,
    captureIncomingEvent,
    snapshotIncomingEvent,
    canonicalizeIncomingEvent,
    normalizeRealtimeEvent,
    durableHandle,
    durablePersist,
    durableResume,
    durableDispose,
    queuePersistence,
    persistAdmission,
    finishAdmission,
    enqueueIncomingEvent,
    enqueueAndClaimIncomingEventIfQueueEmpty,
    drainDispose,
    drainCancelWakeTimer,
    socketConstructor,
    makeProcessSocketOccurrenceNonce,
    makeSocketOccurrenceNamespace,
    socketConnect,
    socketOpen,
    socketEscalate,
    socketDisconnect,
    socketRetire,
    captureFcm,
    storedAppLockRequiresProtection,
    parseFcmData,
    rehydrateFcmEnvelopeChatGuid,
    decryptFcmPayload,
    deliver,
    deliverRespectingLock,
    handleIncomingFcm,
    handleBackgroundFcm,
    startFcm,
    startProcessWork,
    initializeForegroundBootComposition,
    startForegroundBoot,
    readFcmSessionState,
    postLockedNotification,
    flushHeadlessLogs,
    runDevAccountWrite,
    devQueue,
    devResumeQueued,
    injectMessage,
    injectFaceTime,
    injectEffect,
    chatScreen,
  ];
  if (
    required.some((callable) => !callable?.body) ||
    foregroundBootComposition?.initializeForegroundBootComposition !==
      initializeForegroundBootComposition
  ) {
    return empty();
  }
  const parametersAreExact =
    hasExactIdentifierParameters(dispatchRealtimeEvent, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'source' },
      { name: 'context', optional: true },
      { name: 'occurrence', optional: true },
    ]) &&
    hasExactIdentifierParameters(dispatchWithContext, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'source' },
      { name: 'context' },
      { name: 'occurrence', optional: true },
      { name: 'receivedAt', optional: true },
    ]) &&
    hasExactIdentifierParameters(applyNewServerUrl, [
      { name: 'url' },
      { name: 'context', optional: true },
    ]) &&
    hasExactIdentifierParameters(resetRealtimeRuntime, [{ name: 'expected', optional: true }]) &&
    hasExactIdentifierParameters(getRealtimeRuntime, [{ name: 'db' }, { name: 'context' }]) &&
    hasExactIdentifierParameters(getFallbackOccurrenceNamespace, []) &&
    hasExactIdentifierParameters(realtimeSink, [{ name: 'db' }]) &&
    hasExactIdentifierParameters(sharedRouter, [{ name: 'db' }]) &&
    hasExactIdentifierParameters(realtimeIntakeLocked, []) &&
    hasExactIdentifierParameters(canPersistRealtimeEvent, [{ name: 'event' }]) &&
    hasExactIdentifierParameters(effectivelyLocked, [
      { name: 'lock' },
      { name: 'appLockEnabled' },
      { name: 'now', defaulted: true },
    ]) &&
    hasExactIdentifierParameters(strictServerOrigin, [{ name: 'input' }]) &&
    hasExactIdentifierParameters(isDevServer, []) &&
    hasExactIdentifierParameters(isLockExpired, [
      { name: 'lastBackgrounded' },
      { name: 'now' },
      { name: 'timeoutMs' },
    ]) &&
    hasExactIdentifierParameters(readAccountRevocationState, [{ name: 'marker' }]) &&
    hasExactIdentifierParameters(hasActiveServerSession, [
      { name: 'state' },
      { name: 'address' },
      { name: 'password' },
    ]) &&
    hasExactIdentifierParameters(createDevProofContext, [{ name: 'context' }]) &&
    hasExactIdentifierParameters(devPersist, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'context' },
      { name: 'occurrence' },
    ]) &&
    hasExactIdentifierParameters(devResume, [{ name: 'context' }]) &&
    hasExactIdentifierParameters(devPushInject, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'context', optional: true },
      { name: 'occurrence', optional: true },
    ]) &&
    hasExactIdentifierParameters(runTrackedDelivery, [{ name: 'task' }]) &&
    hasExactIdentifierParameters(runTrackedWork, [{ name: 'lease' }, { name: 'task' }]) &&
    hasExactIdentifierParameters(captureFcm, [{ name: 'msg' }]) &&
    hasExactIdentifierParameters(storedAppLockRequiresProtection, [{ name: 'value' }]) &&
    hasExactIdentifierParameters(deliver, [{ name: 'delivery' }, { name: 'lease' }]) &&
    hasExactIdentifierParameters(deliverRespectingLock, [
      { name: 'delivery' },
      { name: 'source' },
      { name: 'lease' },
    ]) &&
    hasExactIdentifierParameters(handleIncomingFcm, [{ name: 'msg' }, { name: 'source' }]) &&
    hasExactIdentifierParameters(handleBackgroundFcm, [{ name: 'msg' }]) &&
    hasExactIdentifierParameters(startFcm, []) &&
    hasExactIdentifierParameters(startProcessWork, []) &&
    hasExactIdentifierParameters(initializeForegroundBootComposition, []) &&
    hasExactIdentifierParameters(startForegroundBoot, []) &&
    hasExactIdentifierParameters(readFcmSessionState, [
      { name: 'vault' },
      { name: 'revocationMarker' },
    ]) &&
    hasExactIdentifierParameters(captureIncomingEvent, [
      { name: 'eventName' },
      { name: 'rawData' },
    ]) &&
    hasExactIdentifierParameters(snapshotIncomingEvent, [
      { name: 'eventName' },
      { name: 'rawData' },
    ]) &&
    hasExactIdentifierParameters(canonicalizeIncomingEvent, [{ name: 'event' }]) &&
    hasExactIdentifierParameters(normalizeRealtimeEvent, [
      { name: 'eventName' },
      { name: 'rawData' },
    ]) &&
    hasExactIdentifierParameters(runDevAccountWrite, [
      { name: 'accountLease' },
      { name: 'write' },
    ]) &&
    hasExactIdentifierParameters(durableHandle, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'source' },
      { name: 'context', optional: true },
      { name: 'occurrence', optional: true },
      { name: 'receivedAt', defaulted: true },
    ]) &&
    hasExactIdentifierParameters(durableDispose, []) &&
    hasExactIdentifierParameters(queuePersistence, [
      { name: 'eventName' },
      { name: 'rawData' },
      { name: 'source' },
      { name: 'context', optional: true },
      { name: 'occurrence', optional: true },
      { name: 'devLeaseToken', optional: true },
      { name: 'receivedAt', defaulted: true },
    ]) &&
    hasExactIdentifierParameters(persistAdmission, [
      { name: 'event' },
      { name: 'source' },
      { name: 'receivedAt' },
      { name: 'context', optional: true },
      { name: 'occurrence', optional: true },
      { name: 'devLeaseToken', optional: true },
    ]) &&
    hasExactIdentifierParameters(drainDispose, []) &&
    hasExactIdentifierParameters(drainCancelWakeTimer, []) &&
    hasExactIdentifierParameters(socketConnect, [
      { name: 'origin' },
      { name: 'password' },
      { name: 'opts', defaulted: true },
    ]) &&
    hasExactIdentifierParameters(startRealtime, [{ name: 'options', defaulted: true }]) &&
    hasExactIdentifierParameters(resumeRealtime, []) &&
    hasExactIdentifierParameters(socketOpen, []) &&
    hasExactIdentifierParameters(socketEscalate, []) &&
    hasExactIdentifierParameters(socketDisconnect, []) &&
    hasExactIdentifierParameters(socketRetire, []) &&
    hasExactIdentifierParameters(makeProcessSocketOccurrenceNonce, []) &&
    hasExactIdentifierParameters(makeSocketOccurrenceNamespace, []) &&
    hasExactIdentifierParameters(captureRealtimeDeliveryLease, []) &&
    hasExactIdentifierParameters(pauseRealtimeDeliveries, []) &&
    hasExactIdentifierParameters(resumeRealtimeDeliveries, []) &&
    hasExactIdentifierParameters(subscribeRealtimeGenerationInvalidation, [
      { name: 'generation' },
      { name: 'listener' },
    ]) &&
    hasExactIdentifierParameters(expoDigestSha256, [{ name: 'input' }]);
  if (!parametersAreExact) return empty();

  const approved = [];
  const exactly = (values, count) => values.length === count;
  const sole = (values) => (values.length === 1 ? values[0] : undefined);
  const snippetIs = (node, text) => normalizedSnippet(node, node.getSourceFile()) === text;
  const isNativeLibSymbol = (symbol) =>
    Boolean(
      symbol?.declarations?.length &&
      symbol.declarations.every((declaration) => {
        const source = declaration.getSourceFile();
        return (
          source.isDeclarationFile &&
          /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(normalizePath(source.fileName))
        );
      }),
    );

  // The shared boot candidate pins the real entry and registration order. Foreground registration
  // must also remain reachable from the one process-work gate. These mixed boot callers stay
  // unresolved; they are prerequisites, not promoted ingress edges.
  const startFcmBinding = namedImportBinding(
    foregroundBootFile,
    '../notifications/fcmMessaging',
    'startFcm',
  );
  const fcmEnabledBinding = namedImportBinding(foregroundBootFile, '@core/realtime', 'FCM_ENABLED');
  const foregroundStartFcmCalls = startFcmBinding
    ? directCallsToBinding(foregroundBootFile, startFcmBinding, checker).filter((call) =>
        nodeIsInside(call, startProcessWork),
      )
    : [];
  const foregroundStartFcmCall = sole(foregroundStartFcmCalls);
  const foregroundCompositionStatement = startForegroundBoot.body.statements[0];
  const foregroundCompositionCall = ts.isExpressionStatement(foregroundCompositionStatement)
    ? callableCall(
        foregroundCompositionStatement.expression,
        initializeForegroundBootComposition,
        checker,
      )
    : undefined;
  const foregroundRelaunchStatement = startForegroundBoot.body.statements[1];
  const foregroundProcessWorkStatement = startForegroundBoot.body.statements[3];
  const foregroundProcessWorkCall = ts.isExpressionStatement(foregroundProcessWorkStatement)
    ? callableCall(foregroundProcessWorkStatement.expression, startProcessWork, checker)
    : undefined;
  const foregroundFcmIf = (() => {
    for (let current = foregroundStartFcmCall; current; current = current.parent) {
      if (ts.isIfStatement(current)) return current;
      if (current === startProcessWork) return undefined;
    }
    return undefined;
  })();
  const foregroundFcmStatement = (() => {
    for (let current = foregroundStartFcmCall; current; current = current.parent) {
      if (ts.isExpressionStatement(current)) return current;
      if (current === foregroundFcmIf) return undefined;
    }
    return undefined;
  })();
  const foregroundFcmVoid = foregroundFcmStatement
    ? unwrapExpression(foregroundFcmStatement.expression)
    : undefined;
  const foregroundFcmCatch =
    foregroundFcmVoid && ts.isVoidExpression(foregroundFcmVoid)
      ? callExpression(foregroundFcmVoid.expression)
      : undefined;
  const foregroundFcmCatchAccess = foregroundFcmCatch
    ? callAccess(foregroundFcmCatch.expression)
    : undefined;
  const foregroundFcmThen = foregroundFcmCatchAccess
    ? callExpression(foregroundFcmCatchAccess.receiver)
    : undefined;
  const foregroundFcmThenAccess = foregroundFcmThen
    ? callAccess(foregroundFcmThen.expression)
    : undefined;
  if (
    !startFcmBinding ||
    !fcmEnabledBinding ||
    foregroundStartFcmCalls.length !== 1 ||
    !foregroundStartFcmCall ||
    foregroundStartFcmCall.arguments.length !== 0 ||
    !foregroundFcmIf ||
    foregroundFcmIf.parent !== startProcessWork.body ||
    !sameSymbol(unwrapExpression(foregroundFcmIf.expression), fcmEnabledBinding, checker) ||
    !ts.isBlock(foregroundFcmIf.thenStatement) ||
    foregroundFcmIf.thenStatement.statements.length !== 1 ||
    foregroundFcmStatement !== foregroundFcmIf.thenStatement.statements[0] ||
    !foregroundFcmVoid ||
    !ts.isVoidExpression(foregroundFcmVoid) ||
    !foregroundFcmCatch ||
    !foregroundFcmCatchAccess ||
    foregroundFcmCatchAccess.method !== 'catch' ||
    foregroundFcmCatch.arguments.length !== 1 ||
    !foregroundFcmThen ||
    !foregroundFcmThenAccess ||
    foregroundFcmThenAccess.method !== 'then' ||
    foregroundFcmThen.arguments.length !== 1 ||
    callExpression(foregroundFcmThenAccess.receiver) !== foregroundStartFcmCall ||
    startForegroundBoot.body.statements.length !== 6 ||
    !foregroundCompositionCall ||
    foregroundCompositionCall.arguments.length !== 0 ||
    !foregroundRelaunchStatement ||
    normalizedSnippet(foregroundRelaunchStatement, foregroundBootFile) !==
      "if (typeof __DEV__ !== 'undefined' && __DEV__) { const relaunchContract = startDevDbRelaunchContractIfRequested(); if (relaunchContract) return relaunchContract; }" ||
    !foregroundProcessWorkCall ||
    foregroundProcessWorkCall.arguments.length !== 0
  ) {
    return empty();
  }

  // These policy helpers are trusted leaves for ingress. Pin their fail-closed implementations,
  // not merely their names, so an always-allowing lookalike cannot preserve the outer certificate.
  const lockGateFile = effectivelyLocked.getSourceFile();
  const lockExpiredBinding = namedImportBinding(
    lockGateFile,
    '@core/security/lockTimeout',
    'isLockExpired',
  );
  const maxServerOriginInputLength = topLevelVariable(
    strictServerOrigin.getSourceFile(),
    'MAX_SERVER_ORIGIN_INPUT_LENGTH',
  );
  const lockExpiredCalls = lockExpiredBinding
    ? directCallsToBinding(lockGateFile, lockExpiredBinding, checker)
    : [];
  const isDevFile = isDevServer.getSourceFile();
  const isDevSessionBinding = namedImportBinding(
    isDevFile,
    '@state/sessionStore',
    'useSessionStore',
  );
  const isDevSessionDeclaration = singleConstDeclaration(isDevServer.body.statements[1], 'session');
  const isDevSessionCall = isDevSessionDeclaration?.initializer
    ? callExpression(isDevSessionDeclaration.initializer)
    : undefined;
  const isDevSessionAccess = isDevSessionCall ? callAccess(isDevSessionCall.expression) : undefined;
  const devOriginState = topLevelVariable(isDevFile, 'DEV_SERVER_ORIGIN');
  const devPasswordState = topLevelVariable(isDevFile, 'DEV_SERVER_PASSWORD');
  const sessionGateFile = readFcmSessionState.getSourceFile();
  const vaultFile = hasActiveServerSession.getSourceFile();
  const serverSessionState = topLevelVariable(vaultFile, 'SERVER_SESSION_STATE');
  const serverSessionStateInitializer = serverSessionState?.declaration.initializer
    ? unwrapExpression(serverSessionState.declaration.initializer)
    : undefined;
  const acceptingDeliveriesState = topLevelVariable(coordinatorFile, 'acceptingDeliveries');
  const accountGenerationState = topLevelVariable(coordinatorFile, 'accountGeneration');
  const admittedDeliveriesState = topLevelVariable(coordinatorFile, 'admittedDeliveries');
  const invalidationListenersState = topLevelVariable(
    coordinatorFile,
    'generationInvalidationListeners',
  );
  const invalidationListenersInitializer = invalidationListenersState?.declaration.initializer
    ? unwrapExpression(invalidationListenersState.declaration.initializer)
    : undefined;
  const invalidationMapSymbol =
    invalidationListenersInitializer && ts.isNewExpression(invalidationListenersInitializer)
      ? unaliasSymbol(
          checker.getSymbolAtLocation(
            unwrapExpression(invalidationListenersInitializer.expression),
          ),
          checker,
        )
      : undefined;
  const admittedDeliveriesInitializer = admittedDeliveriesState?.declaration.initializer
    ? unwrapExpression(admittedDeliveriesState.declaration.initializer)
    : undefined;
  const admittedSetSymbol =
    admittedDeliveriesInitializer && ts.isNewExpression(admittedDeliveriesInitializer)
      ? unaliasSymbol(
          checker.getSymbolAtLocation(unwrapExpression(admittedDeliveriesInitializer.expression)),
          checker,
        )
      : undefined;
  const capturedGenerationDeclaration = singleConstDeclaration(
    captureRealtimeDeliveryLease.body.statements[0],
    'generation',
  );
  const acceptedAtCaptureDeclaration = singleConstDeclaration(
    captureRealtimeDeliveryLease.body.statements[1],
    'acceptedAtCapture',
  );
  const acceptingDeliveriesWrites = acceptingDeliveriesState
    ? assignmentWritesTo(coordinatorFile, acceptingDeliveriesState.declaration.name, checker)
    : [];
  const accountGenerationWrites = accountGenerationState
    ? assignmentWritesTo(coordinatorFile, accountGenerationState.declaration.name, checker)
    : [];
  const pauseGate = pauseRealtimeDeliveries.body.statements[0];
  const pauseBlock =
    ts.isIfStatement(pauseGate) && ts.isBlock(pauseGate.thenStatement)
      ? pauseGate.thenStatement
      : undefined;
  const retiredGenerationDeclaration = pauseBlock
    ? singleConstDeclaration(pauseBlock.statements[0], 'retiredGeneration')
    : undefined;
  const pauseListenersDeclaration = pauseBlock
    ? singleConstDeclaration(pauseBlock.statements[3], 'listeners')
    : undefined;
  const pauseListenerLoop = pauseBlock?.statements[5];
  const pauseListenerDeclaration =
    pauseListenerLoop &&
    ts.isForOfStatement(pauseListenerLoop) &&
    ts.isVariableDeclarationList(pauseListenerLoop.initializer) &&
    pauseListenerLoop.initializer.declarations.length === 1
      ? pauseListenerLoop.initializer.declarations[0]
      : undefined;
  const pauseListenerIterable =
    pauseListenerLoop && ts.isForOfStatement(pauseListenerLoop)
      ? unwrapExpression(pauseListenerLoop.expression)
      : undefined;
  const pauseListenerTry =
    pauseListenerLoop &&
    ts.isForOfStatement(pauseListenerLoop) &&
    ts.isBlock(pauseListenerLoop.statement) &&
    ts.isTryStatement(pauseListenerLoop.statement.statements[0])
      ? pauseListenerLoop.statement.statements[0]
      : undefined;
  const invalidationListenerReferences = invalidationListenersState
    ? runtimeReferencesToBinding(
        coordinatorFile,
        invalidationListenersState.declaration.name,
        checker,
      ).filter((reference) => reference !== invalidationListenersState.declaration.name)
    : [];
  const admittedDeliveryReferences = admittedDeliveriesState
    ? runtimeReferencesToBinding(
        coordinatorFile,
        admittedDeliveriesState.declaration.name,
        checker,
      ).filter((reference) => reference !== admittedDeliveriesState.declaration.name)
    : [];
  const reviewedInvalidationReferenceOwners = [
    subscribeRealtimeGenerationInvalidation.body.statements[1],
    subscribeRealtimeGenerationInvalidation.body.statements[2],
    subscribeRealtimeGenerationInvalidation.body.statements[5],
    pauseBlock?.statements[3],
    pauseBlock?.statements[4],
  ].filter(Boolean);
  const trackedDrainDeclaration = singleConstDeclaration(
    runTrackedWork.body.statements[2],
    'drainSlot',
  );
  const trackedDrainConstruction = trackedDrainDeclaration?.initializer
    ? unwrapExpression(trackedDrainDeclaration.initializer)
    : undefined;
  const trackedPromiseSymbol =
    trackedDrainConstruction && ts.isNewExpression(trackedDrainConstruction)
      ? unaliasSymbol(
          checker.getSymbolAtLocation(unwrapExpression(trackedDrainConstruction.expression)),
          checker,
        )
      : undefined;
  const trackedAddStatement = runTrackedWork.body.statements[3];
  const trackedAddCall =
    trackedAddStatement && ts.isExpressionStatement(trackedAddStatement)
      ? callExpression(trackedAddStatement.expression)
      : undefined;
  const trackedAddAccess = trackedAddCall ? callAccess(trackedAddCall.expression) : undefined;
  const trackedResultDeclaration = singleConstDeclaration(
    runTrackedWork.body.statements[6],
    'result',
  );
  const finishTrackingDeclaration = singleConstDeclaration(
    runTrackedWork.body.statements[7],
    'finishTracking',
  );
  const finishTrackingCallback = finishTrackingDeclaration?.initializer
    ? unwrapExpression(finishTrackingDeclaration.initializer)
    : undefined;
  const trackedDeleteStatement =
    finishTrackingCallback &&
    ts.isArrowFunction(finishTrackingCallback) &&
    ts.isBlock(finishTrackingCallback.body)
      ? finishTrackingCallback.body.statements[0]
      : undefined;
  const trackedDeleteCall =
    trackedDeleteStatement && ts.isExpressionStatement(trackedDeleteStatement)
      ? callExpression(trackedDeleteStatement.expression)
      : undefined;
  const trackedDeleteAccess = trackedDeleteCall
    ? callAccess(trackedDeleteCall.expression)
    : undefined;
  const trackedFinishStatement = runTrackedWork.body.statements[8];
  const trackedFinishExpression =
    trackedFinishStatement && ts.isExpressionStatement(trackedFinishStatement)
      ? unwrapExpression(trackedFinishStatement.expression)
      : undefined;
  const trackedFinishCall =
    trackedFinishExpression && ts.isVoidExpression(trackedFinishExpression)
      ? callExpression(trackedFinishExpression.expression)
      : undefined;
  const trackedFinishAccess = trackedFinishCall
    ? callAccess(trackedFinishCall.expression)
    : undefined;
  const pauseDrainAwait = pauseRealtimeDeliveries.body.statements[1];
  const pauseDrainExpression =
    pauseDrainAwait && ts.isExpressionStatement(pauseDrainAwait)
      ? unwrapExpression(pauseDrainAwait.expression)
      : undefined;
  const pauseDrainCall =
    pauseDrainExpression && ts.isAwaitExpression(pauseDrainExpression)
      ? callExpression(pauseDrainExpression.expression)
      : undefined;
  const readRevocationBinding = namedImportBinding(
    sessionGateFile,
    '@core/secure',
    'readAccountRevocationState',
  );
  const activeSessionBinding = namedImportBinding(
    sessionGateFile,
    '@core/secure',
    'hasActiveServerSession',
  );
  const sessionRevocationDeclaration = singleConstDeclaration(
    readFcmSessionState.body.statements[0],
    'revocation',
  );
  const sessionRevocationCall = sessionRevocationDeclaration?.initializer
    ? callableCall(sessionRevocationDeclaration.initializer, readAccountRevocationState, checker)
    : undefined;
  const sessionGateTry = readFcmSessionState.body.statements[3];
  const sessionGateReturn =
    sessionGateTry && ts.isTryStatement(sessionGateTry)
      ? sessionGateTry.tryBlock.statements[1]
      : undefined;
  const sessionGateConditional =
    sessionGateReturn && ts.isReturnStatement(sessionGateReturn) && sessionGateReturn.expression
      ? unwrapExpression(sessionGateReturn.expression)
      : undefined;
  const activeSessionCall =
    sessionGateConditional && ts.isConditionalExpression(sessionGateConditional)
      ? callableCall(sessionGateConditional.condition, hasActiveServerSession, checker)
      : undefined;
  if (
    effectivelyLocked.body.statements.length !== 4 ||
    statementText(effectivelyLocked, 0) !==
      'const enabled = appLockEnabled || (lock.hydrated && lock.enabled);' ||
    statementText(effectivelyLocked, 1) !== 'if (!enabled) return false;' ||
    statementText(effectivelyLocked, 2) !== 'if (!lock.hydrated) return true;' ||
    statementText(effectivelyLocked, 3) !==
      'return lock.locked || isLockExpired(lock.lastBackgrounded, now, lock.timeoutMs);' ||
    !lockExpiredBinding ||
    lockExpiredCalls.length !== 1 ||
    !nodeIsInside(lockExpiredCalls[0], effectivelyLocked.body.statements[3]) ||
    isLockExpired.body.statements.length !== 2 ||
    statementText(isLockExpired, 0) !== 'if (lastBackgrounded == null) return false;' ||
    statementText(isLockExpired, 1) !== 'return now - lastBackgrounded >= timeoutMs;' ||
    !maxServerOriginInputLength ||
    !(maxServerOriginInputLength.declarationList.flags & ts.NodeFlags.Const) ||
    !maxServerOriginInputLength.declaration.initializer ||
    !ts.isNumericLiteral(maxServerOriginInputLength.declaration.initializer) ||
    maxServerOriginInputLength.declaration.initializer.text !== '2048' ||
    strictServerOrigin.body.statements.length !== 5 ||
    statementText(strictServerOrigin, 0) !== 'if (!input || input !== input.trim()) return null;' ||
    statementText(strictServerOrigin, 1) !==
      'if (input.length > MAX_SERVER_ORIGIN_INPUT_LENGTH) return null;' ||
    statementText(strictServerOrigin, 2) !==
      String.raw`if (/[\\\u0000-\u001f\u007f]/.test(input) || input.includes('@')) return null;` ||
    statementText(strictServerOrigin, 3) !==
      String.raw`if (!/^https?:\/\/[^/?#]+\/?$/i.test(input)) return null;` ||
    statementText(strictServerOrigin, 4) !==
      "try { const url = new URL(input); if (url.protocol !== 'https:' && url.protocol !== 'http:') return null; if (url.username || url.password || !url.hostname) return null; return url.origin; } catch { return null; }" ||
    isDevServer.body.statements.length !== 3 ||
    statementText(isDevServer, 0) !==
      "if (typeof __DEV__ === 'undefined' || !__DEV__) return false;" ||
    statementText(isDevServer, 1) !== 'const session = useSessionStore.getState();' ||
    statementText(isDevServer, 2) !==
      "return ( session.status === 'connected' && session.origin === DEV_SERVER_ORIGIN && session.password === DEV_SERVER_PASSWORD );" ||
    !isDevSessionBinding ||
    !isDevSessionCall ||
    !isDevSessionAccess ||
    isDevSessionAccess.method !== 'getState' ||
    !sameSymbol(isDevSessionAccess.receiver, isDevSessionBinding, checker) ||
    isDevSessionCall.arguments.length !== 0 ||
    !devOriginState ||
    !ts.isStringLiteral(devOriginState.declaration.initializer) ||
    devOriginState.declaration.initializer.text !== 'https://dev.local' ||
    !devPasswordState ||
    !ts.isStringLiteral(devPasswordState.declaration.initializer) ||
    devPasswordState.declaration.initializer.text !== 'dev' ||
    readAccountRevocationState.body.statements.length !== 1 ||
    statementText(readAccountRevocationState, 0) !==
      "try { return marker.isRevoked() ? 'revoked' : 'clear'; } catch { return 'unavailable'; }" ||
    hasActiveServerSession.body.statements.length !== 1 ||
    !serverSessionState ||
    !(serverSessionState.declarationList.flags & ts.NodeFlags.Const) ||
    !serverSessionStateInitializer ||
    !ts.isObjectLiteralExpression(serverSessionStateInitializer) ||
    normalizedSnippet(serverSessionStateInitializer, vaultFile) !==
      "{ writing: 'writing', active: 'active', forgotten: 'forgotten', }" ||
    statementText(hasActiveServerSession, 0) !==
      'return (state === null || state === SERVER_SESSION_STATE.active) && !!address && !!password;' ||
    !acceptingDeliveriesState ||
    !(acceptingDeliveriesState.declarationList.flags & ts.NodeFlags.Let) ||
    acceptingDeliveriesState.declaration.initializer?.kind !== ts.SyntaxKind.TrueKeyword ||
    !accountGenerationState ||
    !(accountGenerationState.declarationList.flags & ts.NodeFlags.Let) ||
    !accountGenerationState.declaration.initializer ||
    !ts.isNumericLiteral(accountGenerationState.declaration.initializer) ||
    accountGenerationState.declaration.initializer.text !== '0' ||
    !admittedDeliveriesState ||
    !(admittedDeliveriesState.declarationList.flags & ts.NodeFlags.Const) ||
    !admittedDeliveriesInitializer ||
    !ts.isNewExpression(admittedDeliveriesInitializer) ||
    !identifierNamed(admittedDeliveriesInitializer.expression, 'Set') ||
    (admittedDeliveriesInitializer.arguments?.length ?? 0) !== 0 ||
    !admittedSetSymbol ||
    !admittedSetSymbol.declarations?.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) ||
    !invalidationListenersState ||
    !(invalidationListenersState.declarationList.flags & ts.NodeFlags.Const) ||
    !invalidationListenersInitializer ||
    !ts.isNewExpression(invalidationListenersInitializer) ||
    !identifierNamed(invalidationListenersInitializer.expression, 'Map') ||
    (invalidationListenersInitializer.arguments?.length ?? 0) !== 0 ||
    !invalidationMapSymbol ||
    !invalidationMapSymbol.declarations?.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) ||
    captureRealtimeDeliveryLease.body.statements.length !== 3 ||
    statementText(captureRealtimeDeliveryLease, 0) !== 'const generation = accountGeneration;' ||
    statementText(captureRealtimeDeliveryLease, 1) !==
      'const acceptedAtCapture = acceptingDeliveries;' ||
    statementText(captureRealtimeDeliveryLease, 2) !==
      'return { generation, isCurrent: () => acceptedAtCapture && acceptingDeliveries && generation === accountGeneration, };' ||
    !capturedGenerationDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(capturedGenerationDeclaration.initializer),
      accountGenerationState.declaration.name,
      checker,
    ) ||
    !acceptedAtCaptureDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(acceptedAtCaptureDeclaration.initializer),
      acceptingDeliveriesState.declaration.name,
      checker,
    ) ||
    runTrackedDelivery.body.statements.length !== 3 ||
    statementText(runTrackedDelivery, 0) !==
      "if (!acceptingDeliveries) return Promise.resolve('paused');" ||
    statementText(runTrackedDelivery, 1) !== 'const lease = captureRealtimeDeliveryLease();' ||
    statementText(runTrackedDelivery, 2) !== 'return runTrackedRealtimeWork(lease, task);' ||
    runTrackedWork.body.statements.length !== 10 ||
    statementText(runTrackedWork, 0) !==
      "if (!lease.isCurrent()) return Promise.resolve('paused');" ||
    statementText(runTrackedWork, 1) !== 'let settleDrainSlot!: () => void;' ||
    statementText(runTrackedWork, 2) !==
      'const drainSlot = new Promise<void>((resolve) => { settleDrainSlot = resolve; });' ||
    !trackedDrainDeclaration ||
    !trackedDrainConstruction ||
    !ts.isNewExpression(trackedDrainConstruction) ||
    !identifierNamed(trackedDrainConstruction.expression, 'Promise') ||
    trackedDrainConstruction.arguments?.length !== 1 ||
    !trackedPromiseSymbol ||
    !trackedPromiseSymbol.declarations?.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) ||
    !trackedAddCall ||
    !trackedAddAccess ||
    trackedAddAccess.method !== 'add' ||
    !sameSymbol(trackedAddAccess.receiver, admittedDeliveriesState.declaration.name, checker) ||
    trackedAddCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(trackedAddCall.arguments[0]),
      trackedDrainDeclaration.name,
      checker,
    ) ||
    statementText(runTrackedWork, 4) !== 'let taskPromise: Promise<unknown>;' ||
    statementText(runTrackedWork, 5) !==
      'try { taskPromise = Promise.resolve(task(lease)); } catch (error) { taskPromise = Promise.reject(error); }' ||
    statementText(runTrackedWork, 6) !==
      "const result = taskPromise.then(() => 'delivered' as const);" ||
    !trackedResultDeclaration ||
    statementText(runTrackedWork, 7) !==
      'const finishTracking = (): void => { admittedDeliveries.delete(drainSlot); settleDrainSlot(); };' ||
    !finishTrackingDeclaration ||
    !finishTrackingCallback ||
    !ts.isArrowFunction(finishTrackingCallback) ||
    !hasPlainIdentifierParameters(finishTrackingCallback, []) ||
    !ts.isBlock(finishTrackingCallback.body) ||
    finishTrackingCallback.body.statements.length !== 2 ||
    !trackedDeleteCall ||
    !trackedDeleteAccess ||
    trackedDeleteAccess.method !== 'delete' ||
    !sameSymbol(trackedDeleteAccess.receiver, admittedDeliveriesState.declaration.name, checker) ||
    trackedDeleteCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(trackedDeleteCall.arguments[0]),
      trackedDrainDeclaration.name,
      checker,
    ) ||
    !trackedFinishCall ||
    !trackedFinishAccess ||
    trackedFinishAccess.method !== 'then' ||
    !trackedResultDeclaration ||
    !sameSymbol(trackedFinishAccess.receiver, trackedResultDeclaration.name, checker) ||
    trackedFinishCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(trackedFinishCall.arguments[0]),
      finishTrackingDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(trackedFinishCall.arguments[1]),
      finishTrackingDeclaration.name,
      checker,
    ) ||
    statementText(runTrackedWork, 9) !== 'return result;' ||
    admittedDeliveryReferences.length !== 3 ||
    !admittedDeliveryReferences.every((reference) =>
      [trackedAddStatement, trackedDeleteStatement, pauseDrainAwait].some((owner) =>
        nodeIsInside(reference, owner),
      ),
    ) ||
    acceptingDeliveriesWrites.length !== 2 ||
    accountGenerationWrites.length !== 1 ||
    pauseRealtimeDeliveries.body.statements.length !== 2 ||
    !ts.isIfStatement(pauseGate) ||
    !sameSymbol(
      unwrapExpression(pauseGate.expression),
      acceptingDeliveriesState.declaration.name,
      checker,
    ) ||
    !pauseBlock ||
    pauseBlock.statements.length !== 6 ||
    !retiredGenerationDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(retiredGenerationDeclaration.initializer),
      accountGenerationState.declaration.name,
      checker,
    ) ||
    normalizedSnippet(pauseBlock.statements[1], coordinatorFile) !==
      'acceptingDeliveries = false;' ||
    !acceptingDeliveriesWrites.some((write) => nodeIsInside(write, pauseBlock.statements[1])) ||
    normalizedSnippet(pauseBlock.statements[2], coordinatorFile) !== 'accountGeneration += 1;' ||
    !accountGenerationWrites.some((write) => nodeIsInside(write, pauseBlock.statements[2])) ||
    !pauseListenersDeclaration?.initializer ||
    normalizedSnippet(pauseBlock.statements[3], coordinatorFile) !==
      'const listeners = generationInvalidationListeners.get(retiredGeneration);' ||
    normalizedSnippet(pauseBlock.statements[4], coordinatorFile) !==
      'generationInvalidationListeners.delete(retiredGeneration);' ||
    !pauseListenerLoop ||
    !ts.isForOfStatement(pauseListenerLoop) ||
    pauseListenerLoop.awaitModifier ||
    !ts.isVariableDeclarationList(pauseListenerLoop.initializer) ||
    !(pauseListenerLoop.initializer.flags & ts.NodeFlags.Const) ||
    !pauseListenerDeclaration ||
    !ts.isIdentifier(pauseListenerDeclaration.name) ||
    pauseListenerDeclaration.name.text !== 'listener' ||
    !pauseListenerIterable ||
    !ts.isBinaryExpression(pauseListenerIterable) ||
    pauseListenerIterable.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !sameSymbol(
      unwrapExpression(pauseListenerIterable.left),
      pauseListenersDeclaration.name,
      checker,
    ) ||
    !ts.isArrayLiteralExpression(unwrapExpression(pauseListenerIterable.right)) ||
    unwrapExpression(pauseListenerIterable.right).elements.length !== 0 ||
    !ts.isBlock(pauseListenerLoop.statement) ||
    pauseListenerLoop.statement.statements.length !== 1 ||
    !pauseListenerTry ||
    pauseListenerTry.finallyBlock ||
    !pauseListenerTry.catchClause ||
    pauseListenerTry.catchClause.variableDeclaration ||
    pauseListenerTry.tryBlock.statements.length !== 1 ||
    normalizedSnippet(pauseListenerTry.tryBlock.statements[0], coordinatorFile) !== 'listener();' ||
    pauseListenerTry.catchClause.block.statements.length !== 0 ||
    statementText(pauseRealtimeDeliveries, 1) !== 'await Promise.all([...admittedDeliveries]);' ||
    !pauseDrainCall ||
    !sameSymbol(
      unwrapExpression(pauseDrainCall.expression.expression),
      unwrapExpression(trackedDrainConstruction.expression),
      checker,
    ) ||
    resumeRealtimeDeliveries.body.statements.length !== 1 ||
    statementText(resumeRealtimeDeliveries, 0) !== 'acceptingDeliveries = true;' ||
    !acceptingDeliveriesWrites.some((write) =>
      nodeIsInside(write, resumeRealtimeDeliveries.body.statements[0]),
    ) ||
    invalidationListenerReferences.length !== 5 ||
    !invalidationListenerReferences.every((reference) =>
      reviewedInvalidationReferenceOwners.some((owner) => nodeIsInside(reference, owner)),
    ) ||
    readFcmSessionState.body.statements.length !== 4 ||
    statementText(readFcmSessionState, 0) !==
      'const revocation = readAccountRevocationState(revocationMarker);' ||
    statementText(readFcmSessionState, 1) !==
      "if (revocation === 'unavailable') return 'unavailable';" ||
    statementText(readFcmSessionState, 2) !== "if (revocation === 'revoked') return 'forgotten';" ||
    statementText(readFcmSessionState, 3) !==
      "try { const [sessionState, address, password] = await Promise.all([ vault.get('serverSessionState'), vault.get('serverAddress'), vault.get('serverPassword'), ]); return hasActiveServerSession(sessionState, address, password) ? 'active' : 'forgotten'; } catch { return 'unavailable'; }" ||
    !readRevocationBinding ||
    !activeSessionBinding ||
    !sessionRevocationCall ||
    sessionRevocationCall.arguments.length !== 1 ||
    !snippetIs(sessionRevocationCall.arguments[0], 'revocationMarker') ||
    !activeSessionCall ||
    activeSessionCall.arguments.length !== 3 ||
    !snippetIs(activeSessionCall.arguments[0], 'sessionState') ||
    !snippetIs(activeSessionCall.arguments[1], 'address') ||
    !snippetIs(activeSessionCall.arguments[2], 'password')
  ) {
    return empty();
  }

  // Both public and dispatcher admission carry only codec-owned snapshots across suspension.
  // Pin the leaf implementations and the native JSON round-trip rather than trusting their names.
  const captureCodecEventDeclaration = singleConstDeclaration(
    captureIncomingEvent.body.statements[0],
    'event',
  );
  const captureCodecNormalizeCall = captureCodecEventDeclaration?.initializer
    ? callableCall(captureCodecEventDeclaration.initializer, normalizeRealtimeEvent, checker)
    : undefined;
  const captureCodecCanonicalDeclaration = singleConstDeclaration(
    captureIncomingEvent.body.statements[2],
    'canonical',
  );
  const captureCodecCanonicalCall = captureCodecCanonicalDeclaration?.initializer
    ? callableCall(captureCodecCanonicalDeclaration.initializer, canonicalizeIncomingEvent, checker)
    : undefined;
  const captureCodecReturn = captureIncomingEvent.body.statements[3];
  const captureCodecReturnObject =
    captureCodecReturn && ts.isReturnStatement(captureCodecReturn) && captureCodecReturn.expression
      ? unwrapExpression(captureCodecReturn.expression)
      : undefined;
  const captureCodecRawDataProperty =
    captureCodecReturnObject && ts.isObjectLiteralExpression(captureCodecReturnObject)
      ? captureCodecReturnObject.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && identifierNamed(property.name, 'rawData'),
        )
      : undefined;
  const captureCodecJsonCall =
    captureCodecRawDataProperty && ts.isPropertyAssignment(captureCodecRawDataProperty)
      ? callExpression(captureCodecRawDataProperty.initializer)
      : undefined;
  const captureCodecJsonAccess = captureCodecJsonCall
    ? callAccess(captureCodecJsonCall.expression)
    : undefined;
  const captureCodecJsonSymbol = captureCodecJsonAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(captureCodecJsonAccess.receiver)),
        checker,
      )
    : undefined;
  const snapshotCodecCapturedDeclaration = singleConstDeclaration(
    snapshotIncomingEvent.body.statements[0],
    'captured',
  );
  const snapshotCodecCaptureCall = snapshotCodecCapturedDeclaration?.initializer
    ? callableCall(snapshotCodecCapturedDeclaration.initializer, captureIncomingEvent, checker)
    : undefined;
  const snapshotCodecReturn = snapshotIncomingEvent.body.statements[1];
  const snapshotCodecConditional =
    snapshotCodecReturn &&
    ts.isReturnStatement(snapshotCodecReturn) &&
    snapshotCodecReturn.expression
      ? unwrapExpression(snapshotCodecReturn.expression)
      : undefined;
  const snapshotCodecNormalizeCall =
    snapshotCodecConditional && ts.isConditionalExpression(snapshotCodecConditional)
      ? callableCall(snapshotCodecConditional.whenTrue, normalizeRealtimeEvent, checker)
      : undefined;
  if (
    captureIncomingEvent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    captureIncomingEvent.asteriskToken ||
    captureIncomingEvent.body.statements.length !== 4 ||
    statementText(captureIncomingEvent, 0) !==
      'const event = normalizeRealtimeEvent(eventName, rawData);' ||
    statementText(captureIncomingEvent, 1) !== 'if (!event) return null;' ||
    statementText(captureIncomingEvent, 2) !==
      'const canonical = canonicalizeIncomingEvent(event);' ||
    statementText(captureIncomingEvent, 3) !==
      'return { eventName: canonical.eventName, rawData: JSON.parse(canonical.payload) };' ||
    !captureCodecNormalizeCall ||
    captureCodecNormalizeCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(captureCodecNormalizeCall.arguments[0]),
      captureIncomingEvent.parameters[0].name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(captureCodecNormalizeCall.arguments[1]),
      captureIncomingEvent.parameters[1].name,
      checker,
    ) ||
    !captureCodecCanonicalCall ||
    captureCodecCanonicalCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(captureCodecCanonicalCall.arguments[0]),
      captureCodecEventDeclaration.name,
      checker,
    ) ||
    !captureCodecJsonCall ||
    captureCodecJsonCall.arguments.length !== 1 ||
    !captureCodecJsonAccess ||
    captureCodecJsonAccess.method !== 'parse' ||
    !isNativeLibSymbol(captureCodecJsonSymbol) ||
    !ts.isPropertyAccessExpression(unwrapExpression(captureCodecJsonCall.arguments[0])) ||
    unwrapExpression(captureCodecJsonCall.arguments[0]).name.text !== 'payload' ||
    !sameSymbol(
      unwrapExpression(captureCodecJsonCall.arguments[0]).expression,
      captureCodecCanonicalDeclaration.name,
      checker,
    ) ||
    snapshotIncomingEvent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    snapshotIncomingEvent.asteriskToken ||
    snapshotIncomingEvent.body.statements.length !== 2 ||
    statementText(snapshotIncomingEvent, 0) !==
      'const captured = captureIncomingEvent(eventName, rawData);' ||
    statementText(snapshotIncomingEvent, 1) !==
      'return captured ? normalizeRealtimeEvent(captured.eventName, captured.rawData) : null;' ||
    !snapshotCodecCaptureCall ||
    snapshotCodecCaptureCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(snapshotCodecCaptureCall.arguments[0]),
      snapshotIncomingEvent.parameters[0].name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(snapshotCodecCaptureCall.arguments[1]),
      snapshotIncomingEvent.parameters[1].name,
      checker,
    ) ||
    !snapshotCodecConditional ||
    !ts.isConditionalExpression(snapshotCodecConditional) ||
    !sameSymbol(
      unwrapExpression(snapshotCodecConditional.condition),
      snapshotCodecCapturedDeclaration.name,
      checker,
    ) ||
    unwrapExpression(snapshotCodecConditional.whenFalse).kind !== ts.SyntaxKind.NullKeyword ||
    !snapshotCodecNormalizeCall ||
    snapshotCodecNormalizeCall.arguments.length !== 2 ||
    !snapshotCodecNormalizeCall.arguments.every((argument) => {
      const access = unwrapExpression(argument);
      return (
        ts.isPropertyAccessExpression(access) &&
        sameSymbol(
          unwrapExpression(access.expression),
          snapshotCodecCapturedDeclaration.name,
          checker,
        )
      );
    }) ||
    unwrapExpression(snapshotCodecNormalizeCall.arguments[0]).name.text !== 'eventName' ||
    unwrapExpression(snapshotCodecNormalizeCall.arguments[1]).name.text !== 'rawData'
  ) {
    return empty();
  }

  // Public admission captures payload, receipt time, and occurrence before either tracking call.
  // A canonical `new-server` event takes one exact, awaited, ephemeral approval handoff before the
  // database-opening branch; every other event retains the reviewed durable admission shape.
  const rotationSnapshotCall = sole(
    exactCallEdges(edges, dispatchRealtimeEvent, snapshotIncomingEvent),
  );
  const rotationApplyCall = sole(exactCallEdges(edges, dispatchRealtimeEvent, applyNewServerUrl));
  if (
    dispatchRealtimeEvent.body.statements.length !== 9 ||
    statementText(dispatchRealtimeEvent, 0) !==
      'const receivedAt = occurrence?.receivedAt ?? Date.now();' ||
    statementText(dispatchRealtimeEvent, 1) !==
      'if ((context && !context.isCurrent()) || realtimeIntakeLocked()) return;' ||
    statementText(dispatchRealtimeEvent, 2) !==
      'const captured = captureIncomingEvent(eventName, rawData);' ||
    statementText(dispatchRealtimeEvent, 3) !==
      "if (!captured) { logger.debug('[incomingEvents] dropped invalid realtime event', { event: eventName, source }); return; }" ||
    statementText(dispatchRealtimeEvent, 4) !==
      'const capturedOccurrence = occurrence ? { serverEventId: occurrence.serverEventId, transportOccurrenceId: occurrence.transportOccurrenceId, } : undefined;' ||
    statementText(dispatchRealtimeEvent, 5) !==
      'const normalized = snapshotIncomingEvent(captured.eventName, captured.rawData);' ||
    statementText(dispatchRealtimeEvent, 6) !==
      "if (normalized?.type === 'new-server') { await applyNewServerUrl(normalized.url, context); return; }" ||
    !rotationSnapshotCall ||
    !nodeIsInside(rotationSnapshotCall.node, dispatchRealtimeEvent.body.statements[5]) ||
    !snippetIs(
      rotationSnapshotCall.node,
      'snapshotIncomingEvent(captured.eventName, captured.rawData)',
    ) ||
    !rotationApplyCall ||
    !nodeIsInside(rotationApplyCall.node, dispatchRealtimeEvent.body.statements[6]) ||
    !ts.isAwaitExpression(unwrapExpression(rotationApplyCall.node.parent)) ||
    !snippetIs(rotationApplyCall.node, 'applyNewServerUrl(normalized.url, context)')
  ) {
    return empty();
  }
  const captureCalls = exactCallEdges(edges, dispatchRealtimeEvent, captureIncomingEvent);
  const trackedWorkCalls = exactCallEdges(edges, dispatchRealtimeEvent, runTrackedWork);
  const trackedDeliveryCalls = exactCallEdges(edges, dispatchRealtimeEvent, runTrackedDelivery);
  const dispatchCalls = nestedCallEdges(edges, dispatchRealtimeEvent, dispatchWithContext);
  const dispatchResultDeclaration = singleConstDeclaration(
    dispatchRealtimeEvent.body.statements[7],
    'result',
  );
  const dispatchResultConditional = dispatchResultDeclaration?.initializer
    ? unwrapExpression(dispatchResultDeclaration.initializer)
    : undefined;
  const dispatchTrackedWorkAwait =
    dispatchResultConditional && ts.isConditionalExpression(dispatchResultConditional)
      ? unwrapExpression(dispatchResultConditional.whenTrue)
      : undefined;
  const dispatchTrackedDeliveryAwait =
    dispatchResultConditional && ts.isConditionalExpression(dispatchResultConditional)
      ? unwrapExpression(dispatchResultConditional.whenFalse)
      : undefined;
  const dispatchTrackedWorkBranch =
    dispatchTrackedWorkAwait && ts.isAwaitExpression(dispatchTrackedWorkAwait)
      ? callExpression(dispatchTrackedWorkAwait.expression)
      : undefined;
  const dispatchTrackedDeliveryBranch =
    dispatchTrackedDeliveryAwait && ts.isAwaitExpression(dispatchTrackedDeliveryAwait)
      ? callExpression(dispatchTrackedDeliveryAwait.expression)
      : undefined;
  if (
    !exactly(captureCalls, 1) ||
    !exactly(trackedWorkCalls, 1) ||
    !exactly(trackedDeliveryCalls, 1) ||
    !exactly(dispatchCalls, 2) ||
    !dispatchResultConditional ||
    !ts.isConditionalExpression(dispatchResultConditional) ||
    !sameSymbol(
      unwrapExpression(dispatchResultConditional.condition),
      dispatchRealtimeEvent.parameters[3].name,
      checker,
    ) ||
    dispatchTrackedWorkBranch !== trackedWorkCalls[0].node ||
    dispatchTrackedDeliveryBranch !== trackedDeliveryCalls[0].node ||
    !nodeIsInside(captureCalls[0].node, dispatchRealtimeEvent.body.statements[2]) ||
    !nodeIsInside(trackedWorkCalls[0].node, dispatchRealtimeEvent.body.statements[7]) ||
    !nodeIsInside(trackedDeliveryCalls[0].node, dispatchRealtimeEvent.body.statements[7]) ||
    !coordinatorCallbackAdoptsInvocation(trackedWorkCalls[0].node, dispatchRealtimeEvent) ||
    !coordinatorCallbackAdoptsInvocation(trackedDeliveryCalls[0].node, dispatchRealtimeEvent) ||
    !snippetIs(
      trackedWorkCalls[0].node,
      'runTrackedRealtimeWork(context, (lease) => dispatchWithContext( captured.eventName, captured.rawData, source, lease, capturedOccurrence, receivedAt, ), )',
    ) ||
    !snippetIs(
      trackedDeliveryCalls[0].node,
      'runTrackedRealtimeDelivery((lease) => dispatchWithContext( captured.eventName, captured.rawData, source, lease, capturedOccurrence, receivedAt, ), )',
    )
  ) {
    return empty();
  }
  const trackedWorkCallback = oneInlineCallback(trackedWorkCalls[0].node, 1, 'lease');
  const trackedDeliveryCallback = oneInlineCallback(trackedDeliveryCalls[0].node, 0, 'lease');
  if (
    !trackedWorkCallback ||
    !trackedDeliveryCallback ||
    !dispatchCalls.some((edge) => edge.caller === trackedWorkCallback) ||
    !dispatchCalls.some((edge) => edge.caller === trackedDeliveryCallback) ||
    !dispatchCalls.every((edge) => coordinatorCallbackAdoptsInvocation(edge.node, edge.caller))
  ) {
    return empty();
  }
  approved.push(...dispatchCalls.map((edge) => edge.node));

  // The database opens between identical current+lock guards, and the exact captured arguments
  // are awaited into the one durable dispatcher instance.
  const databaseCall = sole(exactCallEdges(edges, dispatchWithContext, ensureDatabase));
  const durableHandleCall = sole(exactCallEdges(edges, dispatchWithContext, durableHandle));
  if (
    dispatchWithContext.body.statements.length !== 4 ||
    statementText(dispatchWithContext, 0) !==
      'if (!context.isCurrent() || realtimeIntakeLocked()) return;' ||
    statementText(dispatchWithContext, 1) !== 'const db = await ensureDatabase();' ||
    statementText(dispatchWithContext, 2) !==
      'if (!context.isCurrent() || realtimeIntakeLocked()) return;' ||
    !databaseCall ||
    !durableHandleCall ||
    !nodeIsInside(databaseCall.node, dispatchWithContext.body.statements[1]) ||
    !nodeIsInside(durableHandleCall.node, dispatchWithContext.body.statements[3]) ||
    !coordinatorCallbackAdoptsInvocation(durableHandleCall.node, dispatchWithContext) ||
    !snippetIs(
      durableHandleCall.node,
      'getRealtimeRuntime(db, context)?.dispatcher.handle( eventName, rawData, source, context, occurrence, receivedAt, )',
    )
  ) {
    return empty();
  }
  approved.push(durableHandleCall.node);

  // Runtime publication is keyed by database+account generation, identity-fenced on invalidation,
  // and disposes the old dispatcher synchronously before replacement.
  const runtimeState = topLevelVariable(controlFile, 'realtimeRuntimeInstance');
  const fallbackOccurrenceSequenceState = topLevelVariable(
    controlFile,
    'fallbackOccurrenceSequence',
  );
  const fallbackOccurrenceNamespaceState = topLevelVariable(
    controlFile,
    'fallbackOccurrenceNamespace',
  );
  const cryptoNamespaceBinding = namespaceImportBinding(controlFile, 'expo-crypto');
  const fallbackNamespaceAssignmentStatement = getFallbackOccurrenceNamespace.body.statements[0];
  const fallbackNamespaceAssignment = ts.isExpressionStatement(fallbackNamespaceAssignmentStatement)
    ? unwrapExpression(fallbackNamespaceAssignmentStatement.expression)
    : undefined;
  const fallbackNamespaceCall =
    fallbackNamespaceAssignment && ts.isBinaryExpression(fallbackNamespaceAssignment)
      ? callExpression(fallbackNamespaceAssignment.right)
      : undefined;
  const fallbackNamespaceAccess = fallbackNamespaceCall
    ? callAccess(fallbackNamespaceCall.expression)
    : undefined;
  const fallbackNamespaceReturn = getFallbackOccurrenceNamespace.body.statements[1];
  const fallbackNamespaceWrites = fallbackOccurrenceNamespaceState
    ? assignmentWritesTo(controlFile, fallbackOccurrenceNamespaceState.declaration.name, checker)
    : [];
  const fallbackNamespaceReferences = fallbackOccurrenceNamespaceState
    ? runtimeReferencesToBinding(
        controlFile,
        fallbackOccurrenceNamespaceState.declaration.name,
        checker,
      )
    : [];
  const fallbackNamespaceGetterCalls = directCallsToBinding(
    controlFile,
    getFallbackOccurrenceNamespace.name,
    checker,
  );
  const fallbackNamespaceGetterCall = fallbackNamespaceGetterCalls[0];
  const runtimeDbParameter = getRealtimeRuntime.parameters[0];
  const runtimeContextParameter = getRealtimeRuntime.parameters[1];
  const sharedRouterDbParameter = sharedRouter.parameters[0];
  const sharedRouterState = topLevelVariable(controlFile, 'sharedRouterInstance');
  const realtimeSinkDbParameter = realtimeSink.parameters[0];
  const realtimeSinkState = topLevelVariable(controlFile, 'realtimeSinkInstance');
  const realtimeSinkInitStatement = realtimeSink.body.statements[0];
  const realtimeSinkInit = ts.isExpressionStatement(realtimeSinkInitStatement)
    ? unwrapExpression(realtimeSinkInitStatement.expression)
    : undefined;
  const realtimeSinkConstruction =
    realtimeSinkInit && ts.isBinaryExpression(realtimeSinkInit)
      ? unwrapExpression(realtimeSinkInit.right)
      : undefined;
  const realtimeSinkReturn = realtimeSink.body.statements[1];
  const realtimeSinkWrites = realtimeSinkState
    ? assignmentWritesTo(controlFile, realtimeSinkState.declaration.name, checker)
    : [];
  const sinkSpineSpecs = [
    ['./realtime/serverUrlEventSink', 'ServerUrlEventSink', 2],
    ['./realtime/rcsAlertEventSink', 'RcsAlertEventSink', 2],
    ['./realtime/faceTimeEventSink', 'FaceTimeEventSink', 3],
    ['./realtime/typingEventSink', 'TypingEventSink', 2],
    ['./realtime/groupEventSideEffectSink', 'GroupEventSideEffectSink', 2],
    ['./realtime/notifyingEventSink', 'NotifyingEventSink', 4],
    ['./realtime/dbEventSink', 'DbEventSink', 4],
  ];
  const sinkSpine = [];
  let sinkSpineCursor = realtimeSinkConstruction;
  let sinkSpineValid = true;
  for (const [moduleName, importedName, argumentCount] of sinkSpineSpecs) {
    const binding = namedImportBinding(controlFile, moduleName, importedName);
    if (
      !sinkSpineCursor ||
      !ts.isNewExpression(sinkSpineCursor) ||
      !binding ||
      !sameSymbol(unwrapExpression(sinkSpineCursor.expression), binding, checker) ||
      sinkSpineCursor.arguments?.length !== argumentCount
    ) {
      sinkSpineValid = false;
      break;
    }
    sinkSpine.push(sinkSpineCursor);
    sinkSpineCursor = unwrapExpression(sinkSpineCursor.arguments[0]);
  }
  const notifyingSinkConstruction = sinkSpine[5];
  const dbEventSinkConstruction = sinkSpine[6];
  const sharedRouterInitStatement = sharedRouter.body.statements[0];
  const sharedRouterInit = ts.isExpressionStatement(sharedRouterInitStatement)
    ? unwrapExpression(sharedRouterInitStatement.expression)
    : undefined;
  const sharedRouterConstruction =
    sharedRouterInit && ts.isBinaryExpression(sharedRouterInit)
      ? unwrapExpression(sharedRouterInit.right)
      : undefined;
  const eventRouterBinding = namedImportBinding(controlFile, '@core/realtime', 'EventRouter');
  const sharedRouterSinkCall =
    sharedRouterConstruction &&
    ts.isNewExpression(sharedRouterConstruction) &&
    sharedRouterConstruction.arguments?.[0]
      ? callableCall(sharedRouterConstruction.arguments[0], realtimeSink, checker)
      : undefined;
  const sharedRouterReturn = sharedRouter.body.statements[1];
  const sharedRouterWrites = sharedRouterState
    ? assignmentWritesTo(controlFile, sharedRouterState.declaration.name, checker)
    : [];
  const routerDeclaration = singleConstDeclaration(getRealtimeRuntime.body.statements[4], 'router');
  const routerCall = routerDeclaration?.initializer
    ? callableCall(routerDeclaration.initializer, sharedRouter, checker)
    : undefined;
  const dispatcherDeclaration = singleConstDeclaration(
    getRealtimeRuntime.body.statements[7],
    'dispatcher',
  );
  const dispatcherConstruction = dispatcherDeclaration?.initializer
    ? unwrapExpression(dispatcherDeclaration.initializer)
    : undefined;
  const dispatcherBinding = namedImportBinding(
    controlFile,
    './realtime/incomingEventDispatcher',
    'DurableRealtimeDispatcher',
  );
  const canDrainDeclaration = singleConstDeclaration(
    getRealtimeRuntime.body.statements[5],
    'canDrainPrivateQueue',
  );
  const canDrainCallback = canDrainDeclaration?.initializer
    ? unwrapExpression(canDrainDeclaration.initializer)
    : undefined;
  const drainDeclaration = singleConstDeclaration(getRealtimeRuntime.body.statements[6], 'drain');
  const drainConstruction = drainDeclaration?.initializer
    ? unwrapExpression(drainDeclaration.initializer)
    : undefined;
  const drainBinding = namedImportBinding(
    controlFile,
    './realtime/incomingEventDrain',
    'IncomingEventDrain',
  );
  const drainOptions =
    drainConstruction && ts.isNewExpression(drainConstruction)
      ? drainConstruction.arguments?.[3]
      : undefined;
  const dispatcherOptions =
    dispatcherConstruction && ts.isNewExpression(dispatcherConstruction)
      ? dispatcherConstruction.arguments?.[3]
      : undefined;
  const drainCanDrainProperty =
    drainOptions && ts.isObjectLiteralExpression(drainOptions)
      ? drainOptions.properties[1]
      : undefined;
  const drainLeaseTokenProperty =
    drainOptions && ts.isObjectLiteralExpression(drainOptions)
      ? drainOptions.properties[0]
      : undefined;
  const drainLeaseTokenCallback =
    drainLeaseTokenProperty && ts.isPropertyAssignment(drainLeaseTokenProperty)
      ? unwrapExpression(drainLeaseTokenProperty.initializer)
      : undefined;
  const drainLeaseTokenCall =
    drainLeaseTokenCallback && ts.isArrowFunction(drainLeaseTokenCallback)
      ? callExpression(drainLeaseTokenCallback.body)
      : undefined;
  const drainLeaseTokenAccess = drainLeaseTokenCall
    ? callAccess(drainLeaseTokenCall.expression)
    : undefined;
  const dispatcherCanPersistProperty =
    dispatcherOptions && ts.isObjectLiteralExpression(dispatcherOptions)
      ? dispatcherOptions.properties[2]
      : undefined;
  const dispatcherDevProperty =
    dispatcherOptions && ts.isObjectLiteralExpression(dispatcherOptions)
      ? dispatcherOptions.properties[1]
      : undefined;
  const dispatcherDevCall =
    dispatcherDevProperty && ts.isPropertyAssignment(dispatcherDevProperty)
      ? callableCall(dispatcherDevProperty.initializer, isDevServer, checker)
      : undefined;
  const expoDigestBinding = namedImportBinding(
    controlFile,
    './realtime/expoDigestBackend',
    'expoDigestBackend',
  );
  const expoDigestState = topLevelVariable(digestFile, 'expoDigestBackend');
  const expoDigestCryptoBinding = namespaceImportBinding(digestFile, 'expo-crypto');
  const expoDigestCalls = [];
  const visitExpoDigestCalls = (node) => {
    if (ts.isCallExpression(node)) {
      const access = callAccess(node.expression);
      if (
        access?.method === 'digest' &&
        expoDigestCryptoBinding &&
        sameSymbol(access.receiver, expoDigestCryptoBinding, checker)
      ) {
        expoDigestCalls.push(node);
      }
    }
    ts.forEachChild(node, visitExpoDigestCalls);
  };
  visitExpoDigestCalls(expoDigestSha256.body);
  const expoDigestCall = expoDigestCalls[0];
  const expoDigestAlgorithm = expoDigestCall?.arguments[0]
    ? unwrapExpression(expoDigestCall.arguments[0])
    : undefined;
  const expoDigestAlgorithmGroup =
    expoDigestAlgorithm && ts.isPropertyAccessExpression(expoDigestAlgorithm)
      ? unwrapExpression(expoDigestAlgorithm.expression)
      : undefined;
  const expoDigestBytes = singleConstDeclaration(expoDigestSha256.body.statements[0], 'bytes');
  const invalidationAssignmentStatement = getRealtimeRuntime.body.statements[10];
  const invalidationAssignment = ts.isExpressionStatement(invalidationAssignmentStatement)
    ? unwrapExpression(invalidationAssignmentStatement.expression)
    : undefined;
  const invalidationCall =
    invalidationAssignment && ts.isBinaryExpression(invalidationAssignment)
      ? callableCall(invalidationAssignment.right, subscribeRealtimeGenerationInvalidation, checker)
      : undefined;
  const invalidationCallback = invalidationCall?.arguments[1]
    ? unwrapExpression(invalidationCall.arguments[1])
    : undefined;
  const invalidationResetCall =
    invalidationCallback &&
    ts.isArrowFunction(invalidationCallback) &&
    !ts.isBlock(invalidationCallback.body)
      ? callableCall(invalidationCallback.body, resetRealtimeRuntime, checker)
      : undefined;
  const fallbackSequenceWrites = fallbackOccurrenceSequenceState
    ? assignmentWritesTo(controlFile, fallbackOccurrenceSequenceState.declaration.name, checker)
    : [];
  const runtimeDeclaration = singleConstDeclaration(
    getRealtimeRuntime.body.statements[8],
    'runtime',
  );
  const runtimeObject = runtimeDeclaration?.initializer
    ? unwrapExpression(runtimeDeclaration.initializer)
    : undefined;
  const runtimeObjectProperties =
    runtimeObject && ts.isObjectLiteralExpression(runtimeObject) ? runtimeObject.properties : [];
  const runtimeGenerationInitializer =
    runtimeObjectProperties[1] && ts.isPropertyAssignment(runtimeObjectProperties[1])
      ? unwrapExpression(runtimeObjectProperties[1].initializer)
      : undefined;
  const currentDeclaration = singleConstDeclaration(
    resetRealtimeRuntime.body.statements[0],
    'current',
  );
  const runtimeDisposeStatement = resetRealtimeRuntime.body.statements[4];
  const runtimeDisposeCall =
    runtimeDisposeStatement && ts.isExpressionStatement(runtimeDisposeStatement)
      ? callableCall(runtimeDisposeStatement.expression, durableDispose, checker)
      : undefined;
  const existingDeclaration = singleConstDeclaration(
    getRealtimeRuntime.body.statements[1],
    'existing',
  );
  const lockReturn = realtimeIntakeLocked.body.statements[0];
  const lockCall =
    ts.isReturnStatement(lockReturn) && lockReturn.expression
      ? callableCall(lockReturn.expression, effectivelyLocked, checker)
      : undefined;
  const lockStateCall = lockCall?.arguments[0] ? callExpression(lockCall.arguments[0]) : undefined;
  const lockStateAccess = lockStateCall ? callAccess(lockStateCall.expression) : undefined;
  const lockStoreBinding = namedImportBinding(controlFile, '@state/lockStore', 'useLockStore');
  if (
    !runtimeState ||
    !realtimeSinkState ||
    realtimeSinkState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    realtimeSink.body.statements.length !== 2 ||
    !realtimeSinkInit ||
    !ts.isBinaryExpression(realtimeSinkInit) ||
    realtimeSinkInit.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken ||
    !sameSymbol(
      unwrapExpression(realtimeSinkInit.left),
      realtimeSinkState.declaration.name,
      checker,
    ) ||
    !sinkSpineValid ||
    sinkSpine.length !== sinkSpineSpecs.length ||
    !dbEventSinkConstruction ||
    !notifyingSinkConstruction ||
    !sameSymbol(
      unwrapExpression(dbEventSinkConstruction.arguments[0]),
      realtimeSinkDbParameter.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(notifyingSinkConstruction.arguments[1]),
      realtimeSinkDbParameter.name,
      checker,
    ) ||
    !sameSymbol(sinkSpineCursor, realtimeSinkDbParameter.name, checker) ||
    !ts.isReturnStatement(realtimeSinkReturn) ||
    !realtimeSinkReturn.expression ||
    !sameSymbol(
      unwrapExpression(realtimeSinkReturn.expression),
      realtimeSinkState.declaration.name,
      checker,
    ) ||
    realtimeSinkWrites.length !== 2 ||
    !realtimeSinkWrites.some((write) => nodeIsInside(write, realtimeSinkInitStatement)) ||
    !realtimeSinkWrites.some((write) =>
      nodeIsInside(write, resetRealtimeRuntime.body.statements[5]),
    ) ||
    !sharedRouterState ||
    sharedRouterState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    sharedRouter.body.statements.length !== 2 ||
    !sharedRouterInit ||
    !ts.isBinaryExpression(sharedRouterInit) ||
    sharedRouterInit.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken ||
    !sameSymbol(
      unwrapExpression(sharedRouterInit.left),
      sharedRouterState.declaration.name,
      checker,
    ) ||
    !sharedRouterConstruction ||
    !ts.isNewExpression(sharedRouterConstruction) ||
    !eventRouterBinding ||
    !sameSymbol(
      unwrapExpression(sharedRouterConstruction.expression),
      eventRouterBinding,
      checker,
    ) ||
    sharedRouterConstruction.arguments?.length !== 1 ||
    !sharedRouterSinkCall ||
    sharedRouterSinkCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(sharedRouterSinkCall.arguments[0]),
      sharedRouterDbParameter.name,
      checker,
    ) ||
    !ts.isReturnStatement(sharedRouterReturn) ||
    !sharedRouterReturn.expression ||
    !sameSymbol(
      unwrapExpression(sharedRouterReturn.expression),
      sharedRouterState.declaration.name,
      checker,
    ) ||
    sharedRouterWrites.length !== 2 ||
    !sharedRouterWrites.some((write) => nodeIsInside(write, sharedRouterInitStatement)) ||
    !sharedRouterWrites.some((write) =>
      nodeIsInside(write, resetRealtimeRuntime.body.statements[6]),
    ) ||
    !fallbackOccurrenceSequenceState ||
    !(fallbackOccurrenceSequenceState.declarationList.flags & ts.NodeFlags.Let) ||
    !fallbackOccurrenceSequenceState.declaration.initializer ||
    !ts.isNumericLiteral(fallbackOccurrenceSequenceState.declaration.initializer) ||
    fallbackOccurrenceSequenceState.declaration.initializer.text !== '0' ||
    !fallbackOccurrenceNamespaceState ||
    !(fallbackOccurrenceNamespaceState.declarationList.flags & ts.NodeFlags.Let) ||
    fallbackOccurrenceNamespaceState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    getFallbackOccurrenceNamespace.body.statements.length !== 2 ||
    !fallbackNamespaceAssignment ||
    !ts.isBinaryExpression(fallbackNamespaceAssignment) ||
    fallbackNamespaceAssignment.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken ||
    !sameSymbol(
      unwrapExpression(fallbackNamespaceAssignment.left),
      fallbackOccurrenceNamespaceState.declaration.name,
      checker,
    ) ||
    !fallbackNamespaceCall ||
    !fallbackNamespaceAccess ||
    fallbackNamespaceAccess.method !== 'randomUUID' ||
    !cryptoNamespaceBinding ||
    !sameSymbol(fallbackNamespaceAccess.receiver, cryptoNamespaceBinding, checker) ||
    fallbackNamespaceCall.arguments.length !== 0 ||
    fallbackNamespaceWrites.length !== 1 ||
    fallbackNamespaceWrites[0] !== fallbackNamespaceAssignment ||
    !fallbackNamespaceReturn ||
    !ts.isReturnStatement(fallbackNamespaceReturn) ||
    !fallbackNamespaceReturn.expression ||
    !sameSymbol(
      unwrapExpression(fallbackNamespaceReturn.expression),
      fallbackOccurrenceNamespaceState.declaration.name,
      checker,
    ) ||
    fallbackNamespaceReferences.length !== 3 ||
    fallbackNamespaceReferences.some(
      (reference) =>
        reference !== fallbackOccurrenceNamespaceState.declaration.name &&
        !nodeIsInside(reference, getFallbackOccurrenceNamespace),
    ) ||
    fallbackNamespaceGetterCalls.length !== 1 ||
    !fallbackNamespaceGetterCall ||
    fallbackNamespaceGetterCall.arguments.length !== 0 ||
    !expoDigestBinding ||
    !expoDigestState ||
    !(expoDigestState.declarationList.flags & ts.NodeFlags.Const) ||
    !expoDigestState.declaration.initializer ||
    !ts.isObjectLiteralExpression(expoDigestState.declaration.initializer) ||
    expoDigestState.declaration.initializer.properties.length !== 1 ||
    expoDigestState.declaration.initializer.properties[0] !== expoDigestSha256 ||
    !expoDigestCryptoBinding ||
    expoDigestSha256.body.statements.length !== 3 ||
    statementText(expoDigestSha256, 0) !== 'const bytes = new Uint8Array(input.byteLength);' ||
    statementText(expoDigestSha256, 1) !== 'bytes.set(input);' ||
    statementText(expoDigestSha256, 2) !==
      'return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));' ||
    expoDigestCalls.length !== 1 ||
    !expoDigestCall ||
    !nodeIsInside(expoDigestCall, expoDigestSha256.body.statements[2]) ||
    expoDigestCall.arguments.length !== 2 ||
    !expoDigestAlgorithm ||
    !ts.isPropertyAccessExpression(expoDigestAlgorithm) ||
    expoDigestAlgorithm.name.text !== 'SHA256' ||
    !expoDigestAlgorithmGroup ||
    !ts.isPropertyAccessExpression(expoDigestAlgorithmGroup) ||
    expoDigestAlgorithmGroup.name.text !== 'CryptoDigestAlgorithm' ||
    !sameSymbol(
      unwrapExpression(expoDigestAlgorithmGroup.expression),
      expoDigestCryptoBinding,
      checker,
    ) ||
    !expoDigestBytes ||
    !sameSymbol(unwrapExpression(expoDigestCall.arguments[1]), expoDigestBytes.name, checker) ||
    subscribeRealtimeGenerationInvalidation.body.statements.length !== 6 ||
    statementText(subscribeRealtimeGenerationInvalidation, 0) !==
      'if (!acceptingDeliveries || generation !== accountGeneration) { listener(); return () => undefined; }' ||
    statementText(subscribeRealtimeGenerationInvalidation, 1) !==
      'const listeners = generationInvalidationListeners.get(generation) ?? new Set<() => void>();' ||
    statementText(subscribeRealtimeGenerationInvalidation, 2) !==
      'generationInvalidationListeners.set(generation, listeners);' ||
    statementText(subscribeRealtimeGenerationInvalidation, 3) !== 'listeners.add(listener);' ||
    statementText(subscribeRealtimeGenerationInvalidation, 4) !== 'let subscribed = true;' ||
    statementText(subscribeRealtimeGenerationInvalidation, 5) !==
      'return () => { if (!subscribed) return; subscribed = false; listeners.delete(listener); if (listeners.size === 0) generationInvalidationListeners.delete(generation); };' ||
    resetRealtimeRuntime.body.statements.length !== 7 ||
    getRealtimeRuntime.body.statements.length !== 12 ||
    statementText(resetRealtimeRuntime, 1) !==
      'if (!current || (expected && current !== expected)) return;' ||
    statementText(resetRealtimeRuntime, 0) !== 'const current = realtimeRuntimeInstance;' ||
    statementText(resetRealtimeRuntime, 2) !== 'realtimeRuntimeInstance = null;' ||
    statementText(resetRealtimeRuntime, 3) !== 'current.unsubscribeInvalidation();' ||
    statementText(resetRealtimeRuntime, 4) !== 'current.dispatcher.dispose();' ||
    !runtimeDisposeCall ||
    runtimeDisposeCall.arguments.length !== 0 ||
    statementText(resetRealtimeRuntime, 5) !== 'realtimeSinkInstance = null;' ||
    statementText(resetRealtimeRuntime, 6) !== 'sharedRouterInstance = null;' ||
    statementText(getRealtimeRuntime, 0) !== 'if (!context.isCurrent()) return null;' ||
    statementText(getRealtimeRuntime, 1) !== 'const existing = realtimeRuntimeInstance;' ||
    statementText(getRealtimeRuntime, 2) !==
      'if (existing?.db === db && existing.generation === context.generation) return existing;' ||
    statementText(getRealtimeRuntime, 3) !== 'resetRealtimeRuntime();' ||
    statementText(realtimeIntakeLocked, 0) !==
      'return effectivelyLocked(useLockStore.getState(), false);' ||
    !lockCall ||
    lockCall.arguments.length !== 2 ||
    !lockStateCall ||
    !lockStateAccess ||
    lockStateAccess.method !== 'getState' ||
    !lockStoreBinding ||
    !sameSymbol(lockStateAccess.receiver, lockStoreBinding, checker) ||
    lockStateCall.arguments.length !== 0 ||
    unwrapExpression(lockCall.arguments[1]).kind !== ts.SyntaxKind.FalseKeyword ||
    canPersistRealtimeEvent.body.statements.length !== 4 ||
    statementText(canPersistRealtimeEvent, 0) !==
      "if (realtimeIntakeLocked()) { logger.debug('[realtime] ignored private event while App Lock is active', { event: event.type, }); return false; }" ||
    statementText(canPersistRealtimeEvent, 1) !== "if (event.type !== 'new-server') return true;" ||
    statementText(canPersistRealtimeEvent, 2) !==
      "logger.warn('[realtime] kept new-server event out of durable persistence');" ||
    statementText(canPersistRealtimeEvent, 3) !== 'return false;' ||
    !runtimeDbParameter ||
    !runtimeContextParameter ||
    !routerDeclaration ||
    !routerCall ||
    routerCall.arguments.length !== 1 ||
    !sameSymbol(unwrapExpression(routerCall.arguments[0]), runtimeDbParameter.name, checker) ||
    !canDrainCallback ||
    !ts.isArrowFunction(canDrainCallback) ||
    !hasPlainIdentifierParameters(canDrainCallback, []) ||
    normalizedSnippet(canDrainCallback.body, controlFile) !== '!realtimeIntakeLocked()' ||
    !drainConstruction ||
    !ts.isNewExpression(drainConstruction) ||
    !drainBinding ||
    !sameSymbol(unwrapExpression(drainConstruction.expression), drainBinding, checker) ||
    drainConstruction.arguments?.length !== 4 ||
    !sameSymbol(
      unwrapExpression(drainConstruction.arguments[0]),
      runtimeDbParameter.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(drainConstruction.arguments[1]),
      routerDeclaration.name,
      checker,
    ) ||
    !sameSymbol(unwrapExpression(drainConstruction.arguments[2]), expoDigestBinding, checker) ||
    !drainOptions ||
    !ts.isObjectLiteralExpression(drainOptions) ||
    drainOptions.properties.length !== 4 ||
    normalizedSnippet(drainOptions.properties[0], controlFile) !==
      'makeLeaseToken: () => Crypto.randomUUID()' ||
    !drainLeaseTokenProperty ||
    !ts.isPropertyAssignment(drainLeaseTokenProperty) ||
    !drainLeaseTokenCallback ||
    !ts.isArrowFunction(drainLeaseTokenCallback) ||
    !hasPlainIdentifierParameters(drainLeaseTokenCallback, []) ||
    ts.isBlock(drainLeaseTokenCallback.body) ||
    !drainLeaseTokenCall ||
    !drainLeaseTokenAccess ||
    drainLeaseTokenAccess.method !== 'randomUUID' ||
    !cryptoNamespaceBinding ||
    !sameSymbol(drainLeaseTokenAccess.receiver, cryptoNamespaceBinding, checker) ||
    drainLeaseTokenCall.arguments.length !== 0 ||
    normalizedSnippet(drainOptions.properties[1], controlFile) !==
      'canDrain: canDrainPrivateQueue' ||
    !ts.isPropertyAssignment(drainCanDrainProperty) ||
    !sameSymbol(
      unwrapExpression(drainCanDrainProperty.initializer),
      canDrainDeclaration.name,
      checker,
    ) ||
    normalizedSnippet(drainOptions.properties[2], controlFile) !==
      'canScheduleWake: () => realtimeForegroundActive && canDrainPrivateQueue()' ||
    normalizedSnippet(drainOptions.properties[3], controlFile) !==
      "onPermanentFailure: (_eventName, deliveryContext) => requestRealtimeRecovery({ kind: 'sync-account' }, deliveryContext)" ||
    statementText(getRealtimeRuntime, 9) !== 'realtimeRuntimeInstance = runtime;' ||
    statementText(getRealtimeRuntime, 8) !==
      'const runtime: RealtimeRuntime = { db, generation: context.generation, dispatcher, unsubscribeInvalidation: () => undefined, };' ||
    !currentDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(currentDeclaration.initializer),
      runtimeState?.declaration.name,
      checker,
    ) ||
    !existingDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(existingDeclaration.initializer),
      runtimeState?.declaration.name,
      checker,
    ) ||
    !dispatcherConstruction ||
    !ts.isNewExpression(dispatcherConstruction) ||
    !dispatcherBinding ||
    !sameSymbol(unwrapExpression(dispatcherConstruction.expression), dispatcherBinding, checker) ||
    dispatcherConstruction.arguments?.length !== 4 ||
    !sameSymbol(
      unwrapExpression(dispatcherConstruction.arguments[0]),
      runtimeDbParameter.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(dispatcherConstruction.arguments[1]),
      expoDigestBinding,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(dispatcherConstruction.arguments[2]),
      drainDeclaration.name,
      checker,
    ) ||
    !dispatcherOptions ||
    !ts.isObjectLiteralExpression(dispatcherOptions) ||
    dispatcherOptions.properties.length !== 4 ||
    normalizedSnippet(dispatcherOptions.properties[0], controlFile) !==
      'makeTransportOccurrenceId: (source) => `${source}:${getFallbackOccurrenceNamespace()}:${++fallbackOccurrenceSequence}`' ||
    !nodeIsInside(fallbackNamespaceGetterCall, dispatcherOptions.properties[0]) ||
    runtimeReferencesToBinding(controlFile, getFallbackOccurrenceNamespace.name, checker).length !==
      2 ||
    fallbackSequenceWrites.length !== 1 ||
    !nodeIsInside(fallbackSequenceWrites[0], dispatcherOptions.properties[0]) ||
    normalizedSnippet(dispatcherOptions.properties[1], controlFile) !==
      'allowDevPersistWithoutDrain: isDevServer()' ||
    !dispatcherDevCall ||
    dispatcherDevCall.arguments.length !== 0 ||
    normalizedSnippet(dispatcherOptions.properties[2], controlFile) !==
      'canPersist: canPersistRealtimeEvent' ||
    !ts.isPropertyAssignment(dispatcherCanPersistProperty) ||
    !sameSymbol(
      unwrapExpression(dispatcherCanPersistProperty.initializer),
      canPersistRealtimeEvent.name,
      checker,
    ) ||
    normalizedSnippet(dispatcherOptions.properties[3], controlFile) !==
      'requestRecovery: (recovery, _reason, deliveryContext) => requestRealtimeRecovery(recovery, deliveryContext)' ||
    statementText(getRealtimeRuntime, 10) !==
      'runtime.unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation( context.generation, () => resetRealtimeRuntime(runtime), );' ||
    !runtimeDeclaration ||
    !invalidationAssignment ||
    !ts.isBinaryExpression(invalidationAssignment) ||
    invalidationAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(unwrapExpression(invalidationAssignment.left)) ||
    unwrapExpression(invalidationAssignment.left).name.text !== 'unsubscribeInvalidation' ||
    !sameSymbol(
      unwrapExpression(invalidationAssignment.left).expression,
      runtimeDeclaration.name,
      checker,
    ) ||
    !invalidationCall ||
    invalidationCall.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(unwrapExpression(invalidationCall.arguments[0])) ||
    unwrapExpression(invalidationCall.arguments[0]).name.text !== 'generation' ||
    !sameSymbol(
      unwrapExpression(invalidationCall.arguments[0]).expression,
      runtimeContextParameter.name,
      checker,
    ) ||
    !invalidationCallback ||
    !ts.isArrowFunction(invalidationCallback) ||
    !hasPlainIdentifierParameters(invalidationCallback, []) ||
    ts.isBlock(invalidationCallback.body) ||
    !invalidationResetCall ||
    invalidationResetCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(invalidationResetCall.arguments[0]),
      runtimeDeclaration.name,
      checker,
    ) ||
    statementText(getRealtimeRuntime, 11) !==
      'return context.isCurrent() && realtimeRuntimeInstance === runtime ? runtime : null;' ||
    !runtimeDeclaration ||
    !runtimeObject ||
    !ts.isObjectLiteralExpression(runtimeObject) ||
    runtimeObjectProperties.length !== 4 ||
    !ts.isShorthandPropertyAssignment(runtimeObjectProperties[0]) ||
    !symbolsMatch(
      checker.getShorthandAssignmentValueSymbol(runtimeObjectProperties[0]),
      checker.getSymbolAtLocation(runtimeDbParameter.name),
      checker,
    ) ||
    !runtimeGenerationInitializer ||
    !ts.isPropertyAccessExpression(runtimeGenerationInitializer) ||
    runtimeGenerationInitializer.name.text !== 'generation' ||
    !sameSymbol(
      unwrapExpression(runtimeGenerationInitializer.expression),
      runtimeContextParameter.name,
      checker,
    ) ||
    !ts.isShorthandPropertyAssignment(runtimeObjectProperties[2]) ||
    !symbolsMatch(
      checker.getShorthandAssignmentValueSymbol(runtimeObjectProperties[2]),
      checker.getSymbolAtLocation(dispatcherDeclaration.name),
      checker,
    )
  ) {
    return empty();
  }
  const runtimeWrites = assignmentWritesTo(controlFile, runtimeState.declaration.name, checker);
  if (
    runtimeState.declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    runtimeWrites.length !== 2 ||
    !runtimeWrites.some((write) => nodeIsInside(write, resetRealtimeRuntime.body.statements[2])) ||
    !runtimeWrites.some((write) => nodeIsInside(write, getRealtimeRuntime.body.statements[9]))
  ) {
    return empty();
  }

  // Runtime retirement must stop both the dispatcher and its drain, including any scheduled wake.
  // Bind the concrete methods and state fields so a same-named/no-op replacement cannot preserve
  // the outer ingress certificate.
  const dispatcherClass = ts.isClassDeclaration(durableDispose.parent)
    ? durableDispose.parent
    : undefined;
  const drainClass = ts.isClassDeclaration(drainDispose.parent) ? drainDispose.parent : undefined;
  const classPropertyWritesTo = (file, property) => {
    const writes = [];
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrapExpression(node.left);
        if (ts.isPropertyAccessExpression(left) && sameSymbol(left.name, property.name, checker)) {
          writes.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return writes;
  };
  const classPropertyReferencesTo = (file, property) => {
    const references = [];
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && sameSymbol(node.name, property.name, checker)) {
        references.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return references;
  };
  const namedClassMembers = (classNode, name) =>
    classNode
      ? classNode.members.filter(
          (member) =>
            member.name &&
            (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
            member.name.text === name,
        )
      : [];
  const dispatcherStoppedMembers = namedClassMembers(dispatcherClass, 'stopped');
  const dispatcherStoppedField = dispatcherStoppedMembers[0];
  const drainStoppedMembers = namedClassMembers(drainClass, 'stopped');
  const drainStoppedField = drainStoppedMembers[0];
  const drainWakeTimerMembers = namedClassMembers(drainClass, 'wakeTimer');
  const drainWakeTimerField = drainWakeTimerMembers[0];
  const dispatcherDrainDisposeCall =
    durableDispose.body.statements[1] && ts.isExpressionStatement(durableDispose.body.statements[1])
      ? callableCall(durableDispose.body.statements[1].expression, drainDispose, checker)
      : undefined;
  const drainCancelCall =
    drainDispose.body.statements[1] && ts.isExpressionStatement(drainDispose.body.statements[1])
      ? callableCall(drainDispose.body.statements[1].expression, drainCancelWakeTimer, checker)
      : undefined;
  const dispatcherStoppedWrites =
    dispatcherStoppedField && ts.isPropertyDeclaration(dispatcherStoppedField)
      ? classPropertyWritesTo(dispatcherFile, dispatcherStoppedField)
      : [];
  const drainStoppedWrites =
    drainStoppedField && ts.isPropertyDeclaration(drainStoppedField)
      ? classPropertyWritesTo(drainFile, drainStoppedField)
      : [];
  const drainWakeTimerWrites =
    drainWakeTimerField && ts.isPropertyDeclaration(drainWakeTimerField)
      ? classPropertyWritesTo(drainFile, drainWakeTimerField)
      : [];
  const cancelWakeNullAssignmentStatement = drainCancelWakeTimer.body.statements[2];
  const cancelWakeNullAssignment =
    cancelWakeNullAssignmentStatement && ts.isExpressionStatement(cancelWakeNullAssignmentStatement)
      ? unwrapExpression(cancelWakeNullAssignmentStatement.expression)
      : undefined;
  const cancelWakeStatement = drainCancelWakeTimer.body.statements[1];
  const cancelWakeCall =
    cancelWakeStatement && ts.isExpressionStatement(cancelWakeStatement)
      ? callExpression(cancelWakeStatement.expression)
      : undefined;
  const cancelWakeCallee = cancelWakeCall ? unwrapExpression(cancelWakeCall.expression) : undefined;
  const cancelWakeFallback =
    cancelWakeCallee &&
    ts.isBinaryExpression(cancelWakeCallee) &&
    cancelWakeCallee.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ? unwrapExpression(cancelWakeCallee.right)
      : undefined;
  const cancelWakeFallbackSymbol = cancelWakeFallback
    ? unaliasSymbol(checker.getSymbolAtLocation(cancelWakeFallback), checker)
    : undefined;
  if (
    dispatcherStoppedMembers.length !== 1 ||
    !dispatcherStoppedField ||
    !ts.isPropertyDeclaration(dispatcherStoppedField) ||
    dispatcherStoppedField.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    dispatcherStoppedWrites.length !== 1 ||
    durableDispose.body.statements.length !== 2 ||
    statementText(durableDispose, 0) !== 'this.stopped = true;' ||
    !dispatcherStoppedWrites.some((write) =>
      nodeIsInside(write, durableDispose.body.statements[0]),
    ) ||
    statementText(durableDispose, 1) !== 'this.drain.dispose();' ||
    !dispatcherDrainDisposeCall ||
    dispatcherDrainDisposeCall.arguments.length !== 0 ||
    drainStoppedMembers.length !== 1 ||
    !drainStoppedField ||
    !ts.isPropertyDeclaration(drainStoppedField) ||
    drainStoppedField.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    drainStoppedWrites.length !== 1 ||
    drainDispose.body.statements.length !== 2 ||
    statementText(drainDispose, 0) !== 'this.stopped = true;' ||
    !drainStoppedWrites.some((write) => nodeIsInside(write, drainDispose.body.statements[0])) ||
    statementText(drainDispose, 1) !== 'this.cancelWakeTimer();' ||
    !drainCancelCall ||
    drainCancelCall.arguments.length !== 0 ||
    drainWakeTimerMembers.length !== 1 ||
    !drainWakeTimerField ||
    !ts.isPropertyDeclaration(drainWakeTimerField) ||
    drainWakeTimerField.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    drainCancelWakeTimer.body.statements.length !== 3 ||
    statementText(drainCancelWakeTimer, 0) !== 'if (this.wakeTimer == null) return;' ||
    statementText(drainCancelWakeTimer, 1) !==
      '(this.options.cancelWake ?? clearTimeout)(this.wakeTimer);' ||
    !cancelWakeCall ||
    cancelWakeCall.arguments.length !== 1 ||
    !cancelWakeCallee ||
    !ts.isBinaryExpression(cancelWakeCallee) ||
    cancelWakeCallee.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !cancelWakeFallback ||
    !identifierNamed(cancelWakeFallback, 'clearTimeout') ||
    !cancelWakeFallbackSymbol?.declarations?.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) ||
    !ts.isPropertyAccessExpression(unwrapExpression(cancelWakeCall.arguments[0])) ||
    unwrapExpression(cancelWakeCall.arguments[0]).expression.kind !== ts.SyntaxKind.ThisKeyword ||
    !sameSymbol(
      unwrapExpression(cancelWakeCall.arguments[0]).name,
      drainWakeTimerField.name,
      checker,
    ) ||
    statementText(drainCancelWakeTimer, 2) !== 'this.wakeTimer = null;' ||
    !ts.isBinaryExpression(cancelWakeNullAssignment) ||
    cancelWakeNullAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(unwrapExpression(cancelWakeNullAssignment.left)) ||
    unwrapExpression(cancelWakeNullAssignment.left).expression.kind !== ts.SyntaxKind.ThisKeyword ||
    !sameSymbol(
      unwrapExpression(cancelWakeNullAssignment.left).name,
      drainWakeTimerField.name,
      checker,
    ) ||
    !drainWakeTimerWrites.includes(cancelWakeNullAssignment)
  ) {
    return empty();
  }

  // Direct dispatcher callers get the same pre-FIFO payload and occurrence snapshots.
  const queueCalls = exactCallEdges(edges, durableHandle, queuePersistence);
  const finishCalls = nestedCallEdges(edges, durableHandle, finishAdmission);
  const queueSnapshotCalls = exactCallEdges(edges, queuePersistence, snapshotIncomingEvent);
  const queuePersistCalls = nestedCallEdges(edges, queuePersistence, persistAdmission);
  const admissionCallback = queuePersistCalls[0]?.caller;
  const admissionIifeCalls = admissionCallback
    ? exactCallEdges(edges, queuePersistence, admissionCallback)
    : [];
  const dispatcherIntakeTailMembers = namedClassMembers(dispatcherClass, 'intakeTail');
  const dispatcherIntakeTailField = dispatcherIntakeTailMembers[0];
  const intakeTailInitializer =
    dispatcherIntakeTailField && ts.isPropertyDeclaration(dispatcherIntakeTailField)
      ? callExpression(dispatcherIntakeTailField.initializer)
      : undefined;
  const intakeTailInitializerAccess = intakeTailInitializer
    ? callAccess(intakeTailInitializer.expression)
    : undefined;
  const intakeTailPromiseSymbol = intakeTailInitializerAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(intakeTailInitializerAccess.receiver)),
        checker,
      )
    : undefined;
  const intakeTailWrites =
    dispatcherIntakeTailField && ts.isPropertyDeclaration(dispatcherIntakeTailField)
      ? classPropertyWritesTo(dispatcherFile, dispatcherIntakeTailField)
      : [];
  const intakeTailReferences =
    dispatcherIntakeTailField && ts.isPropertyDeclaration(dispatcherIntakeTailField)
      ? classPropertyReferencesTo(dispatcherFile, dispatcherIntakeTailField)
      : [];
  const queuePreviousDeclaration = singleConstDeclaration(
    queuePersistence.body.statements[0],
    'previous',
  );
  const queueReleaseDeclaration =
    queuePersistence.body.statements[1] &&
    ts.isVariableStatement(queuePersistence.body.statements[1]) &&
    queuePersistence.body.statements[1].declarationList.flags & ts.NodeFlags.Let
      ? queuePersistence.body.statements[1].declarationList.declarations[0]
      : undefined;
  const intakeTailAssignmentStatement = queuePersistence.body.statements[2];
  const intakeTailAssignment =
    intakeTailAssignmentStatement && ts.isExpressionStatement(intakeTailAssignmentStatement)
      ? unwrapExpression(intakeTailAssignmentStatement.expression)
      : undefined;
  const intakeTailConstruction =
    intakeTailAssignment && ts.isBinaryExpression(intakeTailAssignment)
      ? unwrapExpression(intakeTailAssignment.right)
      : undefined;
  const intakeTailConstructionSymbol =
    intakeTailConstruction && ts.isNewExpression(intakeTailConstruction)
      ? unaliasSymbol(
          checker.getSymbolAtLocation(unwrapExpression(intakeTailConstruction.expression)),
          checker,
        )
      : undefined;
  const intakeTailCallback =
    intakeTailConstruction &&
    ts.isNewExpression(intakeTailConstruction) &&
    intakeTailConstruction.arguments?.length === 1
      ? unwrapExpression(intakeTailConstruction.arguments[0])
      : undefined;
  const intakeTailReleaseAssignment =
    intakeTailCallback &&
    ts.isArrowFunction(intakeTailCallback) &&
    ts.isBlock(intakeTailCallback.body) &&
    intakeTailCallback.body.statements[0] &&
    ts.isExpressionStatement(intakeTailCallback.body.statements[0])
      ? unwrapExpression(intakeTailCallback.body.statements[0].expression)
      : undefined;
  const queueReleaseWrites =
    queueReleaseDeclaration && ts.isIdentifier(queueReleaseDeclaration.name)
      ? assignmentWritesTo(dispatcherFile, queueReleaseDeclaration.name, checker)
      : [];
  const queueReleaseReferences =
    queueReleaseDeclaration && ts.isIdentifier(queueReleaseDeclaration.name)
      ? runtimeReferencesToBinding(dispatcherFile, queueReleaseDeclaration.name, checker).filter(
          (reference) => reference !== queueReleaseDeclaration.name,
        )
      : [];
  const admissionDeclaration = singleConstDeclaration(
    queuePersistence.body.statements[7],
    'admission',
  );
  const admissionAwaitStatement = admissionCallback?.body?.statements?.[0];
  const admissionAwait =
    admissionAwaitStatement && ts.isExpressionStatement(admissionAwaitStatement)
      ? unwrapExpression(admissionAwaitStatement.expression)
      : undefined;
  const admissionTry = admissionCallback?.body?.statements?.[1];
  const admissionFinallyStatement =
    admissionTry && ts.isTryStatement(admissionTry)
      ? admissionTry.finallyBlock?.statements[0]
      : undefined;
  const admissionReleaseCall =
    admissionFinallyStatement && ts.isExpressionStatement(admissionFinallyStatement)
      ? callExpression(admissionFinallyStatement.expression)
      : undefined;
  const queueReturnStatement = queuePersistence.body.statements[8];
  const snapshotAssignment = queueSnapshotCalls[0]?.node.parent;
  const queueEventDeclaration = (() => {
    for (const statement of queuePersistence.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (statement.declarationList.declarations.length !== 1) continue;
      const declaration = statement.declarationList.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === 'event') {
        return declaration;
      }
    }
    return undefined;
  })();
  const queueEventWrites = queueEventDeclaration
    ? assignmentWritesTo(dispatcherFile, queueEventDeclaration.name, checker)
    : [];
  const firstAwait = (() => {
    let found;
    function visit(node) {
      if (!found && ts.isAwaitExpression(node)) found = node;
      if (!found) ts.forEachChild(node, visit);
    }
    visit(queuePersistence.body);
    return found;
  })();
  const postAwaitCallerOwnedReferences = [];
  if (firstAwait) {
    const rawDataParameter = queuePersistence.parameters[1].name;
    const occurrenceParameter = queuePersistence.parameters[4].name;
    const visitPostAwaitReferences = (node) => {
      if (
        node.getStart(dispatcherFile) > firstAwait.getStart(dispatcherFile) &&
        ts.isIdentifier(node) &&
        (sameSymbol(node, rawDataParameter, checker) ||
          sameSymbol(node, occurrenceParameter, checker))
      ) {
        postAwaitCallerOwnedReferences.push(node);
      }
      ts.forEachChild(node, visitPostAwaitReferences);
    };
    visitPostAwaitReferences(queuePersistence.body);
  }
  const capturedOccurrenceStatement = queuePersistence.body.statements[6];
  if (
    !exactly(queueCalls, 1) ||
    !exactly(finishCalls, 1) ||
    !exactly(queueSnapshotCalls, 1) ||
    !exactly(queuePersistCalls, 1) ||
    !exactly(admissionIifeCalls, 1) ||
    queuePersistence.body.statements.length !== 9 ||
    dispatcherIntakeTailMembers.length !== 1 ||
    !dispatcherIntakeTailField ||
    !ts.isPropertyDeclaration(dispatcherIntakeTailField) ||
    dispatcherIntakeTailField.modifiers?.length !== 1 ||
    dispatcherIntakeTailField.modifiers[0].kind !== ts.SyntaxKind.PrivateKeyword ||
    !intakeTailInitializer ||
    !intakeTailInitializerAccess ||
    intakeTailInitializerAccess.method !== 'resolve' ||
    intakeTailInitializer.arguments.length !== 0 ||
    !isNativeLibSymbol(intakeTailPromiseSymbol) ||
    intakeTailWrites.length !== 1 ||
    intakeTailReferences.length !== 2 ||
    !intakeTailReferences.every(
      (reference) => unwrapExpression(reference.expression).kind === ts.SyntaxKind.ThisKeyword,
    ) ||
    !intakeTailReferences.every((reference) =>
      [queuePersistence.body.statements[0], queuePersistence.body.statements[2]].some((owner) =>
        nodeIsInside(reference, owner),
      ),
    ) ||
    !queuePreviousDeclaration?.initializer ||
    !sameSymbol(
      unwrapExpression(queuePreviousDeclaration.initializer),
      dispatcherIntakeTailField.name,
      checker,
    ) ||
    !queueReleaseDeclaration ||
    !ts.isIdentifier(queueReleaseDeclaration.name) ||
    queueReleaseDeclaration.name.text !== 'release' ||
    statementText(queuePersistence, 1) !== 'let release = (): void => {};' ||
    !ts.isBinaryExpression(intakeTailAssignment) ||
    intakeTailAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(unwrapExpression(intakeTailAssignment.left)) ||
    !sameSymbol(
      unwrapExpression(intakeTailAssignment.left).name,
      dispatcherIntakeTailField.name,
      checker,
    ) ||
    intakeTailWrites[0] !== intakeTailAssignment ||
    !intakeTailConstruction ||
    !ts.isNewExpression(intakeTailConstruction) ||
    !intakeTailConstructionSymbol ||
    !symbolsMatch(intakeTailConstructionSymbol, intakeTailPromiseSymbol, checker) ||
    !intakeTailCallback ||
    !ts.isArrowFunction(intakeTailCallback) ||
    !hasPlainIdentifierParameters(intakeTailCallback, ['resolve']) ||
    !ts.isBlock(intakeTailCallback.body) ||
    intakeTailCallback.body.statements.length !== 1 ||
    !ts.isBinaryExpression(intakeTailReleaseAssignment) ||
    intakeTailReleaseAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !sameSymbol(
      unwrapExpression(intakeTailReleaseAssignment.left),
      queueReleaseDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(intakeTailReleaseAssignment.right),
      intakeTailCallback.parameters[0].name,
      checker,
    ) ||
    queueReleaseWrites.length !== 1 ||
    queueReleaseWrites[0] !== intakeTailReleaseAssignment ||
    queueReleaseReferences.length !== 2 ||
    !queueReleaseReferences.every((reference) =>
      [intakeTailReleaseAssignment, admissionFinallyStatement].some(
        (owner) => owner && nodeIsInside(reference, owner),
      ),
    ) ||
    !ts.isBinaryExpression(snapshotAssignment) ||
    snapshotAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !identifierNamed(snapshotAssignment.left, 'event') ||
    snapshotAssignment.right !== queueSnapshotCalls[0].node ||
    !queueEventDeclaration ||
    queueEventWrites.length !== 1 ||
    queueEventWrites[0] !== snapshotAssignment ||
    postAwaitCallerOwnedReferences.length !== 0 ||
    !capturedOccurrenceStatement ||
    normalizedSnippet(capturedOccurrenceStatement, dispatcherFile) !==
      'const capturedOccurrence = occurrence ? { serverEventId: occurrence.serverEventId, transportOccurrenceId: occurrence.transportOccurrenceId, } : undefined;' ||
    snapshotIncomingEvent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    snapshotIncomingEvent.asteriskToken ||
    !firstAwait ||
    queueSnapshotCalls[0].node.getStart() >= firstAwait.getStart() ||
    capturedOccurrenceStatement.getStart() >= firstAwait.getStart() ||
    !snippetIs(queueSnapshotCalls[0].node, 'snapshotIncomingEvent(eventName, rawData)') ||
    !coordinatorCallbackAdoptsInvocation(queuePersistCalls[0].node, queuePersistCalls[0].caller) ||
    !snippetIs(
      queuePersistCalls[0].node,
      'this.persist( event, source, receivedAt, context, capturedOccurrence, devLeaseToken, )',
    ) ||
    !coordinatorCallbackAdoptsInvocation(finishCalls[0].node, finishCalls[0].caller) ||
    !snippetIs(finishCalls[0].node, 'this.finishAdmission(persisted)') ||
    !admissionCallback ||
    !ts.isArrowFunction(admissionCallback) ||
    !admissionCallback.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    !hasPlainIdentifierParameters(admissionCallback, []) ||
    !ts.isBlock(admissionCallback.body) ||
    admissionCallback.body.statements.length !== 2 ||
    admissionIifeCalls[0].node.arguments.length !== 0 ||
    !admissionDeclaration?.initializer ||
    unwrapExpression(admissionDeclaration.initializer) !== admissionIifeCalls[0].node ||
    !admissionAwait ||
    !ts.isAwaitExpression(admissionAwait) ||
    !sameSymbol(
      unwrapExpression(admissionAwait.expression),
      queuePreviousDeclaration.name,
      checker,
    ) ||
    firstAwait !== admissionAwait ||
    !admissionTry ||
    !ts.isTryStatement(admissionTry) ||
    admissionTry.tryBlock.statements.length !== 3 ||
    !nodeIsInside(queuePersistCalls[0].node, admissionTry.tryBlock.statements[2]) ||
    admissionTry.catchClause ||
    !admissionTry.finallyBlock ||
    admissionTry.finallyBlock.statements.length !== 1 ||
    !admissionReleaseCall ||
    admissionReleaseCall.arguments.length !== 0 ||
    !sameSymbol(
      unwrapExpression(admissionReleaseCall.expression),
      queueReleaseDeclaration.name,
      checker,
    ) ||
    !queueReturnStatement ||
    !ts.isReturnStatement(queueReturnStatement) ||
    !queueReturnStatement.expression ||
    !sameSymbol(
      unwrapExpression(queueReturnStatement.expression),
      admissionDeclaration.name,
      checker,
    ) ||
    statementText(queuePersistence, queuePersistence.body.statements.length - 1) !==
      'return admission;' ||
    !snippetIs(
      queueCalls[0].node,
      'this.queuePersistence( eventName, rawData, source, context, occurrence, undefined, receivedAt, )',
    )
  ) {
    return empty();
  }

  // Persistence keeps one monotonic stop/account/App-Lock guard through hashing and both queue
  // owners. If any check rejects, the same closure stays revoked for the rest of the admission.
  const persistAdmissionRevokedDeclaration =
    persistAdmission.body.statements[1] &&
    ts.isVariableStatement(persistAdmission.body.statements[1]) &&
    persistAdmission.body.statements[1].declarationList.flags & ts.NodeFlags.Let
      ? persistAdmission.body.statements[1].declarationList.declarations[0]
      : undefined;
  const persistGuardDeclaration = singleConstDeclaration(
    persistAdmission.body.statements[2],
    'guard',
  );
  const persistGuardCallback = persistGuardDeclaration?.initializer
    ? unwrapExpression(persistGuardDeclaration.initializer)
    : undefined;
  const persistAllowedDeclaration =
    persistGuardCallback &&
    ts.isArrowFunction(persistGuardCallback) &&
    ts.isBlock(persistGuardCallback.body)
      ? singleConstDeclaration(persistGuardCallback.body.statements[1], 'allowed')
      : undefined;
  const persistEnqueueCalls = exactCallEdges(edges, persistAdmission, enqueueIncomingEvent);
  const persistAtomicEnqueueCalls = exactCallEdges(
    edges,
    persistAdmission,
    enqueueAndClaimIncomingEventIfQueueEmpty,
  );
  const persistEnqueueCall = sole(persistEnqueueCalls);
  const persistAtomicEnqueueCall = sole(persistAtomicEnqueueCalls);
  if (
    statementText(persistAdmission, 0) !==
      'if (this.stopped || (context && !context.isCurrent())) return null;' ||
    !persistAdmissionRevokedDeclaration ||
    !ts.isIdentifier(persistAdmissionRevokedDeclaration.name) ||
    persistAdmissionRevokedDeclaration.name.text !== 'admissionRevoked' ||
    persistAdmissionRevokedDeclaration.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    !persistGuardDeclaration ||
    !persistGuardCallback ||
    !ts.isArrowFunction(persistGuardCallback) ||
    !hasPlainIdentifierParameters(persistGuardCallback, []) ||
    !ts.isBlock(persistGuardCallback.body) ||
    persistGuardCallback.body.statements.length !== 4 ||
    normalizedSnippet(persistGuardCallback.body.statements[0], dispatcherFile) !==
      'if (admissionRevoked) return false;' ||
    !persistAllowedDeclaration ||
    normalizedSnippet(persistGuardCallback.body.statements[1], dispatcherFile) !==
      'const allowed = !this.stopped && (!context || context.isCurrent()) && (!this.options.canPersist || this.options.canPersist(event));' ||
    normalizedSnippet(persistGuardCallback.body.statements[2], dispatcherFile) !==
      'if (!allowed) admissionRevoked = true;' ||
    normalizedSnippet(persistGuardCallback.body.statements[3], dispatcherFile) !==
      'return allowed;' ||
    persistEnqueueCalls.length !== 1 ||
    persistAtomicEnqueueCalls.length !== 1 ||
    persistEnqueueCall.node.arguments.length !== 4 ||
    !sameSymbol(
      unwrapExpression(persistEnqueueCall.node.arguments[2]),
      persistGuardDeclaration.name,
      checker,
    ) ||
    persistAtomicEnqueueCall.node.arguments.length !== 4 ||
    !sameSymbol(
      unwrapExpression(persistAtomicEnqueueCall.node.arguments[3]),
      persistGuardDeclaration.name,
      checker,
    )
  ) {
    return empty();
  }

  // DEV process-death seams retain their one-way proof context and exact captured metadata.
  const proofDeclaration = singleConstDeclaration(
    createDevProofContext.body.statements[1],
    'proofContext',
  );
  const proofObject = proofDeclaration?.initializer
    ? unwrapExpression(proofDeclaration.initializer)
    : undefined;
  const proofCurrentProperty =
    proofObject && ts.isObjectLiteralExpression(proofObject)
      ? proofObject.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && identifierNamed(property.name, 'isCurrent'),
        )
      : undefined;
  const proofCurrent =
    proofCurrentProperty && ts.isPropertyAssignment(proofCurrentProperty)
      ? unwrapExpression(proofCurrentProperty.initializer)
      : undefined;
  const isDevBinding = namedImportBinding(controlFile, '@utils/isDev', 'isDevServer');
  const isDevCalls = isDevBinding ? directCallsToBinding(controlFile, isDevBinding, checker) : [];
  const proofIsDevCalls = proofCurrent
    ? isDevCalls.filter((call) => nodeIsInside(call, proofCurrent))
    : [];
  const devPersistProofDeclaration = singleConstDeclaration(
    devPersist.body.statements[0],
    'proofContext',
  );
  const devPersistProofCall = devPersistProofDeclaration?.initializer
    ? callableCall(devPersistProofDeclaration.initializer, createDevProofContext, checker)
    : undefined;
  const devResumeProofDeclaration = singleConstDeclaration(
    devResume.body.statements[0],
    'proofContext',
  );
  const devResumeProofCall = devResumeProofDeclaration?.initializer
    ? callableCall(devResumeProofDeclaration.initializer, createDevProofContext, checker)
    : undefined;
  const devProofCalls = directCallsToBinding(controlFile, createDevProofContext.name, checker);
  if (
    createDevProofContext.body.statements.length !== 3 ||
    statementText(createDevProofContext, 0) !== 'let revoked = false;' ||
    !proofObject ||
    !ts.isObjectLiteralExpression(proofObject) ||
    proofObject.properties.length !== 2 ||
    normalizedSnippet(proofObject.properties[0], controlFile) !==
      'generation: context.generation' ||
    !proofCurrent ||
    !ts.isArrowFunction(proofCurrent) ||
    proofCurrent.parameters.length !== 0 ||
    !ts.isBlock(proofCurrent.body) ||
    proofCurrent.body.statements.length !== 4 ||
    normalizedSnippet(proofCurrent.body.statements[0], controlFile) !==
      'if (revoked) return false;' ||
    normalizedSnippet(proofCurrent.body.statements[1], controlFile) !==
      'const allowed = context.isCurrent() && isDevServer() && !realtimeIntakeLocked();' ||
    normalizedSnippet(proofCurrent.body.statements[2], controlFile) !==
      'if (!allowed) revoked = true;' ||
    normalizedSnippet(proofCurrent.body.statements[3], controlFile) !== 'return allowed;' ||
    !isDevBinding ||
    isDevCalls.length !== 2 ||
    proofIsDevCalls.length !== 1 ||
    !isDevCalls.includes(dispatcherDevCall) ||
    devProofCalls.length !== 2 ||
    !devPersistProofCall ||
    !devResumeProofCall ||
    !devProofCalls.includes(devPersistProofCall) ||
    !devProofCalls.includes(devResumeProofCall) ||
    devPersistProofCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(devPersistProofCall.arguments[0]),
      devPersist.parameters[2].name,
      checker,
    ) ||
    devResumeProofCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(devResumeProofCall.arguments[0]),
      devResume.parameters[0].name,
      checker,
    ) ||
    statementText(devPersist, 1) !== 'if (!proofContext) return null;' ||
    statementText(devResume, 1) !== 'if (!proofContext) return null;' ||
    statementText(createDevProofContext, 2) !==
      'return proofContext.isCurrent() ? proofContext : null;' ||
    statementText(devPersist, 2) !== 'const receivedAt = Date.now();' ||
    statementText(devPersist, 3) !== 'const captured = captureIncomingEvent(eventName, rawData);' ||
    statementText(devPersist, 5) !==
      'const capturedOccurrence = { serverEventId: occurrence.serverEventId, transportOccurrenceId: occurrence.transportOccurrenceId, };'
  ) {
    return empty();
  }
  const persistCall = sole(exactCallEdges(edges, devPersist, durablePersist));
  const resumeProofCall = sole(exactCallEdges(edges, devResume, durableResume));
  const devPersistDatabaseCall = sole(exactCallEdges(edges, devPersist, ensureDatabase));
  const devResumeDatabaseCall = sole(exactCallEdges(edges, devResume, ensureDatabase));
  const devPersistDatabaseDeclaration = singleConstDeclaration(devPersist.body.statements[6], 'db');
  const devResumeDatabaseDeclaration = singleConstDeclaration(devResume.body.statements[2], 'db');
  const devPersistRuntimeDeclaration = singleConstDeclaration(
    devPersist.body.statements[10],
    'runtime',
  );
  const devPersistRuntimeCall = devPersistRuntimeDeclaration?.initializer
    ? callableCall(devPersistRuntimeDeclaration.initializer, getRealtimeRuntime, checker)
    : undefined;
  const devResumeRuntimeDeclaration = singleConstDeclaration(
    devResume.body.statements[4],
    'runtime',
  );
  const devResumeRuntimeCall = devResumeRuntimeDeclaration?.initializer
    ? callableCall(devResumeRuntimeDeclaration.initializer, getRealtimeRuntime, checker)
    : undefined;
  const devPersistReceiver = persistCall
    ? unwrapExpression(persistCall.node.expression)
    : undefined;
  const devPersistDispatcher =
    devPersistReceiver && ts.isPropertyAccessExpression(devPersistReceiver)
      ? unwrapExpression(devPersistReceiver.expression)
      : undefined;
  const devPersistRuntimeRoot =
    devPersistDispatcher && ts.isPropertyAccessExpression(devPersistDispatcher)
      ? unwrapExpression(devPersistDispatcher.expression)
      : undefined;
  const devResumeReceiver = resumeProofCall
    ? unwrapExpression(resumeProofCall.node.expression)
    : undefined;
  const devResumeDispatcher =
    devResumeReceiver && ts.isPropertyAccessExpression(devResumeReceiver)
      ? unwrapExpression(devResumeReceiver.expression)
      : undefined;
  const devResumeRuntimeRoot =
    devResumeDispatcher && ts.isPropertyAccessExpression(devResumeDispatcher)
      ? unwrapExpression(devResumeDispatcher.expression)
      : undefined;
  if (
    !persistCall ||
    !resumeProofCall ||
    !devPersistDatabaseCall ||
    !devPersistDatabaseDeclaration ||
    !nodeIsInside(devPersistDatabaseCall.node, devPersist.body.statements[6]) ||
    statementText(devPersist, 7) !== 'if (!proofContext.isCurrent()) return null;' ||
    !devResumeDatabaseCall ||
    !devResumeDatabaseDeclaration ||
    !nodeIsInside(devResumeDatabaseCall.node, devResume.body.statements[2]) ||
    statementText(devResume, 3) !== 'if (!proofContext.isCurrent()) return null;' ||
    !devPersistRuntimeDeclaration ||
    !devPersistRuntimeCall ||
    devPersistRuntimeCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(devPersistRuntimeCall.arguments[0]),
      devPersistDatabaseDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(devPersistRuntimeCall.arguments[1]),
      devPersistProofDeclaration.name,
      checker,
    ) ||
    !devPersistRuntimeRoot ||
    !sameSymbol(devPersistRuntimeRoot, devPersistRuntimeDeclaration.name, checker) ||
    !devResumeRuntimeDeclaration ||
    !devResumeRuntimeCall ||
    devResumeRuntimeCall.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(devResumeRuntimeCall.arguments[0]),
      devResumeDatabaseDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(devResumeRuntimeCall.arguments[1]),
      devResumeProofDeclaration.name,
      checker,
    ) ||
    statementText(devResume, 5) !== 'if (!runtime) return null;' ||
    !devResumeRuntimeRoot ||
    !sameSymbol(devResumeRuntimeRoot, devResumeRuntimeDeclaration.name, checker) ||
    !coordinatorCallbackAdoptsInvocation(persistCall.node, devPersist) ||
    !coordinatorCallbackAdoptsInvocation(resumeProofCall.node, devResume) ||
    !snippetIs(
      persistCall.node,
      "runtime?.dispatcher.persistWithoutDrainForDev( captured.eventName, captured.rawData, 'dev', proofContext, capturedOccurrence, leaseToken, receivedAt, )",
    ) ||
    !snippetIs(resumeProofCall.node, 'runtime.dispatcher.resume(proofContext)')
  ) {
    return empty();
  }
  approved.push(persistCall.node, resumeProofCall.node);

  // The direct DEV wrapper has no retained callback. Every production fixture call is awaited
  // inside the account-tracked helper and forwards that helper's exact lease.
  const devDispatchCall = sole(exactCallEdges(edges, devPushInject, dispatchRealtimeEvent));
  const devTrackerCall = sole(exactCallEdges(edges, runDevAccountWrite, runTrackedWork));
  const devTrackerLeaseParameter = runDevAccountWrite.parameters[0];
  const devTrackerWriteParameter = runDevAccountWrite.parameters[1];
  if (
    devPushInject.body.statements.length !== 1 ||
    !devDispatchCall ||
    !coordinatorCallbackAdoptsInvocation(devDispatchCall.node, devPushInject) ||
    !snippetIs(
      devDispatchCall.node,
      "dispatchRealtimeEvent(eventName, rawData, 'dev', context, occurrence)",
    ) ||
    runDevAccountWrite.body.statements.length !== 1 ||
    !devTrackerCall ||
    !coordinatorCallbackAdoptsInvocation(devTrackerCall.node, runDevAccountWrite) ||
    devTrackerCall.node.arguments.length !== 2 ||
    !sameSymbol(
      unwrapExpression(devTrackerCall.node.arguments[0]),
      devTrackerLeaseParameter.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(devTrackerCall.node.arguments[1]),
      devTrackerWriteParameter.name,
      checker,
    ) ||
    !snippetIs(devTrackerCall.node, 'runTrackedRealtimeWork(accountLease, write)')
  ) {
    return empty();
  }
  approved.push(devDispatchCall.node);

  const devOuterTargets = [
    [devQueue, devPersist],
    [devResumeQueued, devResume],
    [injectMessage, devPushInject],
    [injectFaceTime, devPushInject],
    [injectEffect, devPushInject],
  ];
  const devOuterNodes = [];
  const devCallbacks = [];
  const devIsDevBinding = namedImportBinding(devFile, '@utils/isDev', 'isDevServer');
  const devIsDevCalls = devIsDevBinding
    ? directCallsToBinding(devFile, devIsDevBinding, checker)
    : [];
  for (const [owner, target] of devOuterTargets) {
    const matches = nestedCallEdges(edges, owner, target);
    const ownerDevCalls = devIsDevCalls.filter((call) => nodeIsInside(call, owner));
    if (
      !devIsDevBinding ||
      ownerDevCalls.length !== 1 ||
      !nodeIsInside(ownerDevCalls[0], owner.body.statements[0]) ||
      statementText(owner, 0) !== 'if (!isDevServer()) return;' ||
      !exactly(matches, 1) ||
      !coordinatorCallbackAdoptsInvocation(matches[0].node, matches[0].caller)
    ) {
      return empty();
    }
    const accountLeaseParameter = owner.parameters.find(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'accountLease',
    );
    const passedLease =
      target === devPushInject
        ? matches[0].node.arguments[2]
        : matches[0].node.arguments[target === devPersist ? 2 : 0];
    if (
      !accountLeaseParameter ||
      !passedLease ||
      !sameSymbol(unwrapExpression(passedLease), accountLeaseParameter.name, checker)
    ) {
      return empty();
    }
    const callback = matches[0].caller;
    devCallbacks.push(callback);
    const owningTracker = edges.find(
      (edge) =>
        edge.caller === owner &&
        edge.callee === runDevAccountWrite &&
        edge.node.arguments.length === 2 &&
        unwrapExpression(edge.node.arguments[1]) === callback,
    );
    if (
      !owningTracker ||
      !sameSymbol(
        unwrapExpression(owningTracker.node.arguments[0]),
        accountLeaseParameter.name,
        checker,
      ) ||
      !coordinatorCallbackAdoptsInvocation(owningTracker.node, owner)
    ) {
      return empty();
    }
    devOuterNodes.push(matches[0].node);
  }
  approved.push(...devOuterNodes);

  // The chat DEV button checks the screen lease before its contained public-dispatch promise.
  const chatDispatchCall = sole(nestedCallEdges(edges, chatScreen, dispatchRealtimeEvent));
  const chatCallback = chatDispatchCall?.caller;
  const useStateBinding = namedImportBinding(chatFile, 'react', 'useState');
  const chatIsDevBinding = namedImportBinding(chatFile, '@utils/isDev', 'isDevServer');
  const chatIsDevCalls = chatIsDevBinding
    ? directCallsToBinding(chatFile, chatIsDevBinding, checker)
    : [];
  const chatLeaseState = (() => {
    const matches = [];
    for (const statement of chatScreen.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isArrayBindingPattern(declaration.name) || declaration.name.elements.length !== 1) {
          continue;
        }
        const element = declaration.name.elements[0];
        if (
          !element ||
          !ts.isBindingElement(element) ||
          !ts.isIdentifier(element.name) ||
          element.name.text !== 'accountLease' ||
          !declaration.initializer
        ) {
          continue;
        }
        const stateCall = callExpression(declaration.initializer);
        const initializer = stateCall?.arguments[0]
          ? unwrapExpression(stateCall.arguments[0])
          : undefined;
        const captureCall =
          initializer && ts.isArrowFunction(initializer) && !ts.isBlock(initializer.body)
            ? callableCall(initializer.body, captureRealtimeDeliveryLease, checker)
            : undefined;
        if (
          stateCall &&
          useStateBinding &&
          sameSymbol(unwrapExpression(stateCall.expression), useStateBinding, checker) &&
          stateCall.arguments.length === 1 &&
          initializer &&
          ts.isArrowFunction(initializer) &&
          hasPlainIdentifierParameters(initializer, []) &&
          captureCall &&
          captureCall.arguments.length === 0
        ) {
          matches.push({ binding: element.name, captureCall });
        }
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  })();
  const chatGuard =
    chatCallback && ts.isBlock(chatCallback.body) ? chatCallback.body.statements[0] : undefined;
  const chatLeaseGuardCalls = [];
  if (chatGuard && ts.isIfStatement(chatGuard)) {
    const visitChatGuard = (node) => {
      if (ts.isCallExpression(node)) {
        const access = callAccess(node.expression);
        if (
          access?.method === 'isCurrent' &&
          chatLeaseState &&
          sameSymbol(access.receiver, chatLeaseState.binding, checker)
        ) {
          chatLeaseGuardCalls.push(node);
        }
      }
      ts.forEachChild(node, visitChatGuard);
    };
    visitChatGuard(chatGuard.expression);
  }
  const chatCallbackIsDevCalls = chatCallback
    ? chatIsDevCalls.filter((call) => nodeIsInside(call, chatCallback))
    : [];
  if (
    !chatDispatchCall ||
    !chatCallback ||
    !ts.isArrowFunction(chatCallback) ||
    !hasPlainIdentifierParameters(chatCallback, []) ||
    !ts.isBlock(chatCallback.body) ||
    chatCallback.body.statements.length !== 2 ||
    !chatLeaseState ||
    !chatIsDevBinding ||
    chatCallbackIsDevCalls.length !== 1 ||
    chatCallbackIsDevCalls[0].arguments.length !== 0 ||
    !chatGuard ||
    !ts.isIfStatement(chatGuard) ||
    chatLeaseGuardCalls.length !== 1 ||
    chatLeaseGuardCalls[0].arguments.length !== 0 ||
    !ts.isReturnStatement(chatGuard.thenStatement) ||
    normalizedSnippet(chatCallback.body.statements[0], chatFile) !==
      'if (!isDevServer() || !accountLease.isCurrent()) return;' ||
    chatDispatchCall.node.arguments.length !== 4 ||
    !sameSymbol(
      unwrapExpression(chatDispatchCall.node.arguments[3]),
      chatLeaseState.binding,
      checker,
    ) ||
    !snippetIs(
      chatDispatchCall.node,
      "dispatchRealtimeEvent( 'typing-indicator', { chatGuid: guid, display: true }, 'dev', accountLease, )",
    )
  ) {
    return empty();
  }
  approved.push(chatDispatchCall.node);

  // Socket construction passes the exact public dispatcher. Native callbacks use the account
  // lease captured at connect, reserve occurrence synchronously, and return the handler promise
  // from the tracked callback; disconnect invalidates the lifecycle before teardown.
  const socketReferences = referenceEdges.filter(
    (reference) => reference.target === dispatchRealtimeEvent && reference.caller === startRealtime,
  );
  const socketReference = sole(socketReferences);
  const socketNew = socketReference
    ? (() => {
        for (let current = socketReference.node.parent; current; current = current.parent) {
          if (ts.isNewExpression(current)) return current;
          if (ts.isStatement(current)) return undefined;
        }
        return undefined;
      })()
    : undefined;
  const socketBinding = namedImportBinding(
    controlFile,
    './realtime/socketService',
    'SocketService',
  );
  const socketIoBinding = namedImportBinding(socketFile, 'socket.io-client', 'io');
  const serverEventsBinding = namedImportBinding(socketFile, '@core/config', 'SERVER_EVENTS');
  const socketState = topLevelVariable(controlFile, 'socket');
  const socketAssignment = socketNew?.parent;
  const socketHandlerMembers = ts.isClassDeclaration(socketConstructor.parent)
    ? socketConstructor.parent.members.filter(
        (member) =>
          member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
          member.name.text === 'handleRawEvent',
      )
    : [];
  const socketHandlerField = socketHandlerMembers[0];
  const socketAccountLeaseMembers = ts.isClassDeclaration(socketConstructor.parent)
    ? socketConstructor.parent.members.filter(
        (member) =>
          member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
          member.name.text === 'accountLease',
      )
    : [];
  const socketAccountLeaseField = socketAccountLeaseMembers[0];
  const socketLifecycleMembers = ts.isClassDeclaration(socketConstructor.parent)
    ? socketConstructor.parent.members.filter(
        (member) =>
          member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
          member.name.text === 'lifecycleGeneration',
      )
    : [];
  const socketLifecycleField = socketLifecycleMembers[0];
  const socketHandlerAssignments = [];
  if (ts.isClassDeclaration(socketConstructor.parent)) {
    const visitSocketHandlerAssignment = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrapExpression(node.left);
        if (ts.isPropertyAccessExpression(left) && left.name.text === 'handleRawEvent') {
          socketHandlerAssignments.push(node);
        }
      }
      ts.forEachChild(node, visitSocketHandlerAssignment);
    };
    visitSocketHandlerAssignment(socketConstructor.parent);
  }
  const socketConstructorAssignmentStatement = socketConstructor.body.statements[0];
  const socketConstructorAssignment = ts.isExpressionStatement(socketConstructorAssignmentStatement)
    ? unwrapExpression(socketConstructorAssignmentStatement.expression)
    : undefined;
  const socketTrackedCalls = nestedCallEdges(edges, socketOpen, runTrackedWork);
  const socketTrackedCall = sole(socketTrackedCalls);
  const socketTask = socketTrackedCall
    ? oneInlineCallback(socketTrackedCall.node, 1, 'lease')
    : undefined;
  const socketConnectLeaseStatement = socketConnect.body.statements[5];
  const socketConnectLeaseExpression = ts.isExpressionStatement(socketConnectLeaseStatement)
    ? unwrapExpression(socketConnectLeaseStatement.expression)
    : undefined;
  const socketConnectLeaseCall =
    socketConnectLeaseExpression && ts.isBinaryExpression(socketConnectLeaseExpression)
      ? callableCall(socketConnectLeaseExpression.right, captureRealtimeDeliveryLease, checker)
      : undefined;
  const socketAccountLeaseWrites =
    socketAccountLeaseField && ts.isPropertyDeclaration(socketAccountLeaseField)
      ? assignmentWritesTo(socketFile, socketAccountLeaseField.name, checker)
      : [];
  const socketLifecycleWrites =
    socketLifecycleField && ts.isPropertyDeclaration(socketLifecycleField)
      ? assignmentWritesTo(socketFile, socketLifecycleField.name, checker)
      : [];
  const socketSequenceState = topLevelVariable(socketFile, 'processSocketOpenSequence');
  const socketNonceState = topLevelVariable(socketFile, 'processSocketOccurrenceNonce');
  const socketNonceInitializerCall = socketNonceState?.declaration.initializer
    ? callableCall(
        socketNonceState.declaration.initializer,
        makeProcessSocketOccurrenceNonce,
        checker,
      )
    : undefined;
  const socketNonceTry = makeProcessSocketOccurrenceNonce.body.statements[0];
  const socketNonceRandomDeclaration = singleConstDeclaration(
    makeProcessSocketOccurrenceNonce.body.statements[1],
    'random',
  );
  const socketNonceCalls = [];
  const visitSocketNonceCalls = (node) => {
    if (ts.isCallExpression(node)) socketNonceCalls.push(node);
    ts.forEachChild(node, visitSocketNonceCalls);
  };
  visitSocketNonceCalls(makeProcessSocketOccurrenceNonce.body);
  const socketNonceDateCall = sole(
    socketNonceCalls.filter((call) => {
      const access = callAccess(call.expression);
      return access?.method === 'now' && identifierNamed(access.receiver, 'Date');
    }),
  );
  const socketNonceMathCall = sole(
    socketNonceCalls.filter((call) => {
      const access = callAccess(call.expression);
      return access?.method === 'random' && identifierNamed(access.receiver, 'Math');
    }),
  );
  const socketNonceDateAccess = socketNonceDateCall
    ? callAccess(socketNonceDateCall.expression)
    : undefined;
  const socketNonceMathAccess = socketNonceMathCall
    ? callAccess(socketNonceMathCall.expression)
    : undefined;
  const socketNonceDateSymbol = socketNonceDateAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(socketNonceDateAccess.receiver)),
        checker,
      )
    : undefined;
  const socketNonceMathSymbol = socketNonceMathAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(socketNonceMathAccess.receiver)),
        checker,
      )
    : undefined;
  const socketSequenceIncrement = makeSocketOccurrenceNamespace.body.statements[0];
  const socketSequenceIncrementExpression = ts.isExpressionStatement(socketSequenceIncrement)
    ? unwrapExpression(socketSequenceIncrement.expression)
    : undefined;
  const socketSequenceReturn = makeSocketOccurrenceNamespace.body.statements[1];
  const socketSequenceReturnReferences = [];
  const socketNonceReturnReferences = [];
  if (socketSequenceState && ts.isReturnStatement(socketSequenceReturn)) {
    const visitSequenceReturn = (node) => {
      if (
        ts.isIdentifier(node) &&
        sameSymbol(node, socketSequenceState.declaration.name, checker)
      ) {
        socketSequenceReturnReferences.push(node);
      }
      if (
        socketNonceState &&
        ts.isIdentifier(node) &&
        sameSymbol(node, socketNonceState.declaration.name, checker)
      ) {
        socketNonceReturnReferences.push(node);
      }
      ts.forEachChild(node, visitSequenceReturn);
    };
    if (socketSequenceReturn.expression) visitSequenceReturn(socketSequenceReturn.expression);
  }
  const socketSequenceWrites = socketSequenceState
    ? assignmentWritesTo(socketFile, socketSequenceState.declaration.name, checker)
    : [];
  const occurrenceNamespaceStatement = socketOpen.body.statements[2];
  const socketAccountLeaseDeclaration = singleConstDeclaration(
    socketOpen.body.statements[1],
    'accountLease',
  );
  const occurrenceNamespaceDeclaration =
    ts.isVariableStatement(occurrenceNamespaceStatement) &&
    occurrenceNamespaceStatement.declarationList.declarations.length === 1
      ? occurrenceNamespaceStatement.declarationList.declarations[0]
      : undefined;
  const occurrenceNamespaceCall = occurrenceNamespaceDeclaration?.initializer
    ? callExpression(occurrenceNamespaceDeclaration.initializer)
    : undefined;
  const occurrenceNamespaceAccess = occurrenceNamespaceCall
    ? callAccess(occurrenceNamespaceCall.expression)
    : undefined;
  const eventSequenceStatement = socketOpen.body.statements[3];
  const eventSequenceDeclaration =
    ts.isVariableStatement(eventSequenceStatement) &&
    eventSequenceStatement.declarationList.declarations.length === 1
      ? eventSequenceStatement.declarationList.declarations[0]
      : undefined;
  const hasConnectedStatement = socketOpen.body.statements[4];
  const hasConnectedDeclaration =
    ts.isVariableStatement(hasConnectedStatement) &&
    hasConnectedStatement.declarationList.declarations.length === 1
      ? hasConnectedStatement.declarationList.declarations[0]
      : undefined;
  const socketOpenAssignmentStatement = socketOpen.body.statements[5];
  const socketOpenAssignment = ts.isExpressionStatement(socketOpenAssignmentStatement)
    ? unwrapExpression(socketOpenAssignmentStatement.expression)
    : undefined;
  const socketIoCall =
    socketOpenAssignment && ts.isBinaryExpression(socketOpenAssignment)
      ? callExpression(socketOpenAssignment.right)
      : undefined;
  const socketConnectRegistrationStatement = socketOpen.body.statements[7];
  const socketConnectRegistration = ts.isExpressionStatement(socketConnectRegistrationStatement)
    ? callExpression(socketConnectRegistrationStatement.expression)
    : undefined;
  const socketConnectRegistrationAccess = socketConnectRegistration
    ? callAccess(socketConnectRegistration.expression)
    : undefined;
  const socketConnectedCallback = socketConnectRegistration?.arguments[1]
    ? unwrapExpression(socketConnectRegistration.arguments[1])
    : undefined;
  const socketReconnectBranch =
    socketConnectedCallback &&
    ts.isArrowFunction(socketConnectedCallback) &&
    ts.isBlock(socketConnectedCallback.body) &&
    ts.isIfStatement(socketConnectedCallback.body.statements[1])
      ? socketConnectedCallback.body.statements[1]
      : undefined;
  const socketReconnectAssignment =
    socketReconnectBranch && ts.isBlock(socketReconnectBranch.thenStatement)
      ? socketReconnectBranch.thenStatement.statements[0]
      : undefined;
  const socketReconnectSequenceReset =
    socketReconnectBranch && ts.isBlock(socketReconnectBranch.thenStatement)
      ? socketReconnectBranch.thenStatement.statements[1]
      : undefined;
  const socketReconnectAssignmentExpression =
    socketReconnectAssignment && ts.isExpressionStatement(socketReconnectAssignment)
      ? unwrapExpression(socketReconnectAssignment.expression)
      : undefined;
  const socketReconnectNamespaceCall =
    socketReconnectAssignmentExpression &&
    ts.isBinaryExpression(socketReconnectAssignmentExpression)
      ? callExpression(socketReconnectAssignmentExpression.right)
      : undefined;
  const socketEscalationTry = socketEscalate.body.statements[3];
  const socketEscalationStatements = ts.isTryStatement(socketEscalationTry)
    ? socketEscalationTry.tryBlock.statements
    : [];
  if (
    !socketReference ||
    !socketNew ||
    !socketBinding ||
    !sameSymbol(unwrapExpression(socketNew.expression), socketBinding, checker) ||
    socketNew.arguments?.length !== 1 ||
    unwrapExpression(socketNew.arguments[0]) !== socketReference.node ||
    !socketState ||
    !ts.isBinaryExpression(socketAssignment) ||
    socketAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    socketAssignment.right !== socketNew ||
    !sameSymbol(unwrapExpression(socketAssignment.left), socketState.declaration.name, checker) ||
    socketAssignment.parent !== startRealtime.body.statements[11] ||
    socketHandlerMembers.length !== 1 ||
    !socketHandlerField ||
    !ts.isPropertyDeclaration(socketHandlerField) ||
    socketHandlerField.questionToken ||
    socketHandlerField.initializer ||
    socketHandlerField.modifiers?.length !== 2 ||
    !socketHandlerField.modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    ) ||
    !socketHandlerField.modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) ||
    socketConstructor.parameters.length !== 2 ||
    !ts.isIdentifier(socketConstructor.parameters[0].name) ||
    socketConstructor.parameters[0].name.text !== 'handler' ||
    socketConstructor.parameters[0].questionToken ||
    socketConstructor.parameters[0].initializer ||
    socketConstructor.parameters[0].modifiers?.length ||
    !ts.isIdentifier(socketConstructor.parameters[1].name) ||
    socketConstructor.parameters[1].name.text !== 'makeOccurrenceNamespace' ||
    socketConstructor.parameters[1].questionToken ||
    !socketConstructor.parameters[1].initializer ||
    !sameSymbol(
      unwrapExpression(socketConstructor.parameters[1].initializer),
      makeSocketOccurrenceNamespace.name,
      checker,
    ) ||
    socketConstructor.parameters[1].modifiers?.length !== 2 ||
    !socketConstructor.parameters[1].modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    ) ||
    !socketConstructor.parameters[1].modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) ||
    socketConstructor.body.statements.length !== 1 ||
    statementText(socketConstructor, 0) !== 'this.handleRawEvent = handler;' ||
    !socketConstructorAssignment ||
    !ts.isBinaryExpression(socketConstructorAssignment) ||
    socketHandlerAssignments.length !== 1 ||
    socketHandlerAssignments[0] !== socketConstructorAssignment ||
    socketAccountLeaseMembers.length !== 1 ||
    !socketAccountLeaseField ||
    !ts.isPropertyDeclaration(socketAccountLeaseField) ||
    socketAccountLeaseField.questionToken ||
    socketAccountLeaseField.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    socketAccountLeaseField.modifiers?.length !== 1 ||
    socketAccountLeaseField.modifiers[0].kind !== ts.SyntaxKind.PrivateKeyword ||
    socketAccountLeaseWrites.length !== 2 ||
    socketLifecycleMembers.length !== 1 ||
    !socketLifecycleField ||
    !ts.isPropertyDeclaration(socketLifecycleField) ||
    socketLifecycleField.questionToken ||
    !socketLifecycleField.initializer ||
    !ts.isNumericLiteral(socketLifecycleField.initializer) ||
    socketLifecycleField.initializer.text !== '0' ||
    socketLifecycleField.modifiers?.length !== 1 ||
    socketLifecycleField.modifiers[0].kind !== ts.SyntaxKind.PrivateKeyword ||
    socketLifecycleWrites.length !== 3 ||
    socketConnect.body.statements.length !== 8 ||
    statementText(socketConnect, 0) !== 'this.lifecycleGeneration += 1;' ||
    statementText(socketConnect, 1) !== 'this.retireCurrentConnection();' ||
    statementText(socketConnect, 2) !== 'this.stopped = false;' ||
    statementText(socketConnect, 3) !== 'this.origin = origin;' ||
    statementText(socketConnect, 4) !== 'this.password = password;' ||
    statementText(socketConnect, 5) !== 'this.accountLease = captureRealtimeDeliveryLease();' ||
    !socketConnectLeaseCall ||
    socketConnectLeaseCall.arguments.length !== 0 ||
    !socketAccountLeaseWrites.some((write) =>
      nodeIsInside(write, socketConnect.body.statements[5]),
    ) ||
    !socketLifecycleWrites.some((write) => nodeIsInside(write, socketConnect.body.statements[0])) ||
    statementText(socketConnect, 6) !==
      'this.opts = { ...opts, headers: opts.headers ? { ...opts.headers } : undefined };' ||
    statementText(socketConnect, 7) !== 'this.openSocket();' ||
    !socketSequenceState ||
    !(socketSequenceState.declarationList.flags & ts.NodeFlags.Let) ||
    !socketSequenceState.declaration.initializer ||
    !ts.isNumericLiteral(socketSequenceState.declaration.initializer) ||
    socketSequenceState.declaration.initializer.text !== '0' ||
    !socketNonceState ||
    !(socketNonceState.declarationList.flags & ts.NodeFlags.Const) ||
    !socketNonceInitializerCall ||
    socketNonceInitializerCall.arguments.length !== 0 ||
    makeProcessSocketOccurrenceNonce.body.statements.length !== 3 ||
    !ts.isTryStatement(socketNonceTry) ||
    !socketNonceTry.catchClause ||
    socketNonceTry.finallyBlock ||
    socketNonceTry.tryBlock.statements.length !== 2 ||
    socketNonceTry.catchClause.variableDeclaration ||
    socketNonceTry.catchClause.block.statements.length !== 0 ||
    normalizedSnippet(socketNonceTry.tryBlock.statements[0], socketFile) !==
      'const uuid = globalThis.crypto?.randomUUID?.();' ||
    normalizedSnippet(socketNonceTry.tryBlock.statements[1], socketFile) !==
      'if (uuid) return uuid;' ||
    !socketNonceRandomDeclaration ||
    normalizedSnippet(socketNonceRandomDeclaration.initializer, socketFile) !==
      "Math.floor(Math.random() * 0x1_0000_0000) .toString(36) .padStart(7, '0')" ||
    !socketNonceMathCall ||
    socketNonceMathCall.arguments.length !== 0 ||
    !isNativeLibSymbol(socketNonceMathSymbol) ||
    statementText(makeProcessSocketOccurrenceNonce, 2) !==
      'return `${Date.now().toString(36)}-${random}`;' ||
    !socketNonceDateCall ||
    socketNonceDateCall.arguments.length !== 0 ||
    !isNativeLibSymbol(socketNonceDateSymbol) ||
    makeSocketOccurrenceNamespace.body.statements.length !== 2 ||
    !ts.isBinaryExpression(socketSequenceIncrementExpression) ||
    socketSequenceIncrementExpression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken ||
    !sameSymbol(
      unwrapExpression(socketSequenceIncrementExpression.left),
      socketSequenceState.declaration.name,
      checker,
    ) ||
    !ts.isNumericLiteral(unwrapExpression(socketSequenceIncrementExpression.right)) ||
    unwrapExpression(socketSequenceIncrementExpression.right).text !== '1' ||
    statementText(makeSocketOccurrenceNamespace, 1) !==
      'return `socket:${processSocketOccurrenceNonce}:${processSocketOpenSequence}`;' ||
    socketSequenceReturnReferences.length !== 1 ||
    socketNonceReturnReferences.length !== 1 ||
    socketSequenceWrites.length !== 1 ||
    socketSequenceWrites[0] !== socketSequenceIncrementExpression ||
    !occurrenceNamespaceDeclaration ||
    !ts.isIdentifier(occurrenceNamespaceDeclaration.name) ||
    occurrenceNamespaceDeclaration.name.text !== 'occurrenceNamespace' ||
    !(occurrenceNamespaceStatement.declarationList.flags & ts.NodeFlags.Let) ||
    !occurrenceNamespaceCall ||
    !occurrenceNamespaceAccess ||
    occurrenceNamespaceAccess.method !== 'makeOccurrenceNamespace' ||
    !snippetIs(occurrenceNamespaceAccess.receiver, 'this') ||
    !sameSymbol(
      unwrapExpression(occurrenceNamespaceCall.expression),
      socketConstructor.parameters[1].name,
      checker,
    ) ||
    occurrenceNamespaceCall.arguments.length !== 0 ||
    !eventSequenceDeclaration ||
    !ts.isIdentifier(eventSequenceDeclaration.name) ||
    eventSequenceDeclaration.name.text !== 'eventSequence' ||
    !(eventSequenceStatement.declarationList.flags & ts.NodeFlags.Let) ||
    !eventSequenceDeclaration.initializer ||
    !ts.isNumericLiteral(eventSequenceDeclaration.initializer) ||
    eventSequenceDeclaration.initializer.text !== '0' ||
    !hasConnectedDeclaration ||
    !ts.isIdentifier(hasConnectedDeclaration.name) ||
    hasConnectedDeclaration.name.text !== 'hasConnected' ||
    !(hasConnectedStatement.declarationList.flags & ts.NodeFlags.Let) ||
    hasConnectedDeclaration.initializer?.kind !== ts.SyntaxKind.FalseKeyword ||
    !socketIoBinding ||
    !socketOpenAssignment ||
    !ts.isBinaryExpression(socketOpenAssignment) ||
    socketOpenAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !snippetIs(socketOpenAssignment.left, 'this.socket') ||
    !socketIoCall ||
    !sameSymbol(unwrapExpression(socketIoCall.expression), socketIoBinding, checker) ||
    socketIoCall.arguments.length !== 2 ||
    !snippetIs(socketIoCall.arguments[0], 'this.origin') ||
    !socketConnectRegistration ||
    !socketConnectRegistrationAccess ||
    socketConnectRegistrationAccess.method !== 'on' ||
    !snippetIs(socketConnectRegistrationAccess.receiver, 'this.socket') ||
    socketConnectRegistration.arguments.length !== 2 ||
    !ts.isStringLiteral(unwrapExpression(socketConnectRegistration.arguments[0])) ||
    unwrapExpression(socketConnectRegistration.arguments[0]).text !== 'connect' ||
    !socketConnectedCallback ||
    !ts.isArrowFunction(socketConnectedCallback) ||
    !hasPlainIdentifierParameters(socketConnectedCallback, []) ||
    !ts.isBlock(socketConnectedCallback.body) ||
    socketConnectedCallback.body.statements.length !== 5 ||
    !socketReconnectBranch ||
    !ts.isBlock(socketReconnectBranch.thenStatement) ||
    socketReconnectBranch.thenStatement.statements.length !== 2 ||
    !ts.isBlock(socketReconnectBranch.elseStatement) ||
    socketReconnectBranch.elseStatement.statements.length !== 1 ||
    !ts.isExpressionStatement(socketReconnectAssignment) ||
    !ts.isExpressionStatement(socketReconnectSequenceReset) ||
    normalizedSnippet(socketReconnectAssignment, socketFile) !==
      'occurrenceNamespace = this.makeOccurrenceNamespace();' ||
    normalizedSnippet(socketReconnectSequenceReset, socketFile) !== 'eventSequence = 0;' ||
    !socketReconnectNamespaceCall ||
    socketReconnectNamespaceCall.arguments.length !== 0 ||
    !sameSymbol(
      unwrapExpression(socketReconnectNamespaceCall.expression),
      socketConstructor.parameters[1].name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(unwrapExpression(socketReconnectAssignment.expression).left),
      occurrenceNamespaceDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(unwrapExpression(socketReconnectSequenceReset.expression).left),
      eventSequenceDeclaration.name,
      checker,
    ) ||
    normalizedSnippet(socketReconnectBranch.elseStatement.statements[0], socketFile) !==
      'hasConnected = true;' ||
    statementText(socketOpen, 0) !== 'const lifecycleGeneration = this.lifecycleGeneration;' ||
    statementText(socketOpen, 1) !== 'const accountLease = this.accountLease;' ||
    !socketAccountLeaseDeclaration ||
    !socketAccountLeaseDeclaration.initializer ||
    !sameSymbol(
      unwrapExpression(socketAccountLeaseDeclaration.initializer),
      socketAccountLeaseField.name,
      checker,
    ) ||
    socketEscalate.body.statements.length !== 4 ||
    statementText(socketEscalate, 0) !== 'if (this.stopped || this.socket?.connected) return;' ||
    statementText(socketEscalate, 1) !== 'let lifecycleGeneration = this.lifecycleGeneration;' ||
    statementText(socketEscalate, 2) !== 'this.escalationInProgress = true;' ||
    !ts.isTryStatement(socketEscalationTry) ||
    !socketEscalationTry.catchClause ||
    !socketEscalationTry.finallyBlock ||
    socketEscalationStatements.length !== 4 ||
    normalizedSnippet(socketEscalationStatements[0], socketFile) !==
      'this.lifecycleGeneration += 1;' ||
    !socketLifecycleWrites.some((write) => nodeIsInside(write, socketEscalationStatements[0])) ||
    normalizedSnippet(socketEscalationStatements[1], socketFile) !==
      'lifecycleGeneration = this.lifecycleGeneration;' ||
    normalizedSnippet(socketEscalationStatements[2], socketFile) !== 'this.teardownSocket();' ||
    normalizedSnippet(socketEscalationStatements[3], socketFile) !==
      'if (!this.stopped) this.openSocket();' ||
    socketEscalationTry.catchClause.block.statements.length !== 1 ||
    normalizedSnippet(socketEscalationTry.catchClause.block.statements[0], socketFile) !==
      'this.logSocketError(e, lifecycleGeneration);' ||
    socketEscalationTry.finallyBlock.statements.length !== 1 ||
    normalizedSnippet(socketEscalationTry.finallyBlock.statements[0], socketFile) !==
      'if (lifecycleGeneration === this.lifecycleGeneration) this.escalationInProgress = false;' ||
    !socketTrackedCall ||
    !socketTask ||
    !ts.isBlock(socketTask.body) ||
    socketTask.body.statements.length !== 2 ||
    statementText(socketTask, 0) !== 'deliveryLease = lease;' ||
    statementText(socketTask, 1) !==
      "return this.handleRawEvent(event, data, 'socket', lease, occurrence);" ||
    !snippetIs(socketTrackedCall.node.arguments[0], 'accountLease') ||
    socketDisconnect.body.statements.length !== 2 ||
    statementText(socketDisconnect, 0) !== 'this.lifecycleGeneration += 1;' ||
    !socketLifecycleWrites.some((write) =>
      nodeIsInside(write, socketDisconnect.body.statements[0]),
    ) ||
    statementText(socketDisconnect, 1) !== 'this.retireCurrentConnection();' ||
    socketRetire.body.statements.length !== 7 ||
    statementText(socketRetire, 0) !== 'this.stopped = true;' ||
    statementText(socketRetire, 1) !== 'this.cancelEscalation();' ||
    statementText(socketRetire, 2) !== 'this.escalationAttempt = 0;' ||
    statementText(socketRetire, 3) !== 'this.escalationInProgress = false;' ||
    statementText(socketRetire, 4) !== 'this.lastErrorLoggedAt.clear();' ||
    statementText(socketRetire, 5) !== 'this.accountLease = null;' ||
    !socketAccountLeaseWrites.some((write) =>
      nodeIsInside(write, socketRetire.body.statements[5]),
    ) ||
    statementText(socketRetire, 6) !== 'this.teardownSocket();'
  ) {
    return empty();
  }
  const socketNativeCallback = socketTrackedCall.caller;
  const socketOnCall = socketNativeCallback?.parent;
  const socketOnAccess = ts.isCallExpression(socketOnCall)
    ? callAccess(socketOnCall.expression)
    : undefined;
  const socketOnStatement = socketOnCall?.parent;
  const socketLoop = ts.isForOfStatement(socketOpen.body.statements[6])
    ? socketOpen.body.statements[6]
    : undefined;
  const socketLoopBody = socketLoop ? socketLoop.statement : undefined;
  const socketLoopDeclaration =
    socketLoop &&
    ts.isVariableDeclarationList(socketLoop.initializer) &&
    socketLoop.initializer.declarations.length === 1
      ? socketLoop.initializer.declarations[0]
      : undefined;
  const socketOccurrenceDeclaration =
    socketNativeCallback && ts.isBlock(socketNativeCallback.body)
      ? singleConstDeclaration(socketNativeCallback.body.statements[2], 'occurrence')
      : undefined;
  const socketDeliveryLeaseStatement =
    socketNativeCallback && ts.isBlock(socketNativeCallback.body)
      ? socketNativeCallback.body.statements[3]
      : undefined;
  const socketDeliveryLeaseDeclaration =
    socketDeliveryLeaseStatement &&
    ts.isVariableStatement(socketDeliveryLeaseStatement) &&
    socketDeliveryLeaseStatement.declarationList.declarations.length === 1
      ? socketDeliveryLeaseStatement.declarationList.declarations[0]
      : undefined;
  const socketHandlerReturn =
    socketTask && ts.isBlock(socketTask.body) ? socketTask.body.statements[1] : undefined;
  const socketHandlerCall =
    socketHandlerReturn &&
    ts.isReturnStatement(socketHandlerReturn) &&
    socketHandlerReturn.expression
      ? callExpression(socketHandlerReturn.expression)
      : undefined;
  const socketDeliveryStatement =
    socketNativeCallback && ts.isBlock(socketNativeCallback.body)
      ? socketNativeCallback.body.statements[4]
      : undefined;
  const socketDeliveryVoid =
    socketDeliveryStatement && ts.isExpressionStatement(socketDeliveryStatement)
      ? unwrapExpression(socketDeliveryStatement.expression)
      : undefined;
  const socketCatchCall =
    socketDeliveryVoid && ts.isVoidExpression(socketDeliveryVoid)
      ? callExpression(socketDeliveryVoid.expression)
      : undefined;
  const socketCatchAccess = socketCatchCall ? callAccess(socketCatchCall.expression) : undefined;
  const socketThenCall = socketCatchAccess ? callExpression(socketCatchAccess.receiver) : undefined;
  const socketThenAccess = socketThenCall ? callAccess(socketThenCall.expression) : undefined;
  const socketThenCallback = socketThenCall?.arguments[0]
    ? unwrapExpression(socketThenCall.arguments[0])
    : undefined;
  const socketCatchCallback = socketCatchCall?.arguments[0]
    ? unwrapExpression(socketCatchCall.arguments[0])
    : undefined;
  const socketRetiredFailureIf =
    socketCatchCallback &&
    ts.isArrowFunction(socketCatchCallback) &&
    ts.isBlock(socketCatchCallback.body) &&
    ts.isIfStatement(socketCatchCallback.body.statements[0])
      ? socketCatchCallback.body.statements[0]
      : undefined;
  if (
    !socketNativeCallback ||
    !ts.isArrowFunction(socketNativeCallback) ||
    !hasPlainIdentifierParameters(socketNativeCallback, ['data']) ||
    !ts.isBlock(socketNativeCallback.body) ||
    socketNativeCallback.body.statements.length !== 5 ||
    statementText(socketNativeCallback, 0) !==
      'if ( this.stopped || lifecycleGeneration !== this.lifecycleGeneration || !accountLease?.isCurrent() ) { return; }' ||
    statementText(socketNativeCallback, 1) !== 'eventSequence += 1;' ||
    statementText(socketNativeCallback, 2) !==
      'const occurrence: EventOccurrenceMetadata = { transportOccurrenceId: `${occurrenceNamespace}:${eventSequence}`, };' ||
    statementText(socketNativeCallback, 3) !==
      'let deliveryLease: RealtimeDeliveryLease | null = null;' ||
    !socketDeliveryLeaseDeclaration ||
    !ts.isIdentifier(socketDeliveryLeaseDeclaration.name) ||
    socketDeliveryLeaseDeclaration.name.text !== 'deliveryLease' ||
    socketDeliveryLeaseDeclaration.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
    !socketLoop ||
    !serverEventsBinding ||
    !sameSymbol(unwrapExpression(socketLoop.expression), serverEventsBinding, checker) ||
    !socketLoopDeclaration ||
    !ts.isIdentifier(socketLoopDeclaration.name) ||
    socketLoopDeclaration.name.text !== 'event' ||
    !socketAccountLeaseDeclaration ||
    !socketOccurrenceDeclaration ||
    !socketHandlerCall ||
    !sameSymbol(unwrapExpression(socketHandlerCall.expression), socketHandlerField.name, checker) ||
    socketHandlerCall.arguments.length !== 5 ||
    !sameSymbol(
      unwrapExpression(socketHandlerCall.arguments[0]),
      socketLoopDeclaration.name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(socketHandlerCall.arguments[1]),
      socketNativeCallback.parameters[0].name,
      checker,
    ) ||
    !ts.isStringLiteral(unwrapExpression(socketHandlerCall.arguments[2])) ||
    unwrapExpression(socketHandlerCall.arguments[2]).text !== 'socket' ||
    !sameSymbol(
      unwrapExpression(socketHandlerCall.arguments[3]),
      socketTask.parameters[0].name,
      checker,
    ) ||
    !sameSymbol(
      unwrapExpression(socketHandlerCall.arguments[4]),
      socketOccurrenceDeclaration.name,
      checker,
    ) ||
    !nodeIsInside(socketTrackedCall.node, socketNativeCallback.body.statements[4]) ||
    !ts.isCallExpression(socketOnCall) ||
    !socketOnAccess ||
    socketOnAccess.method !== 'on' ||
    !snippetIs(socketOnAccess.receiver, 'this.socket') ||
    socketOnCall.arguments.length !== 2 ||
    unwrapExpression(socketOnCall.arguments[1]) !== socketNativeCallback ||
    !snippetIs(socketOnCall.arguments[0], 'event') ||
    !sameSymbol(unwrapExpression(socketOnCall.arguments[0]), socketLoopDeclaration.name, checker) ||
    !nodeIsInside(socketOnCall, socketOpen.body.statements[6]) ||
    !ts.isBlock(socketLoopBody) ||
    socketLoopBody.statements.length !== 1 ||
    socketOnStatement !== socketLoopBody.statements[0] ||
    !sameSymbol(
      unwrapExpression(socketTrackedCall.node.arguments[0]),
      socketAccountLeaseDeclaration.name,
      checker,
    ) ||
    !socketDeliveryVoid ||
    !ts.isVoidExpression(socketDeliveryVoid) ||
    !socketCatchCall ||
    !socketCatchAccess ||
    socketCatchAccess.method !== 'catch' ||
    socketCatchCall.arguments.length !== 1 ||
    !socketThenCall ||
    !socketThenAccess ||
    socketThenAccess.method !== 'then' ||
    socketThenCall.arguments.length !== 1 ||
    callExpression(socketThenAccess.receiver) !== socketTrackedCall.node ||
    !socketThenCallback ||
    !ts.isArrowFunction(socketThenCallback) ||
    !hasPlainIdentifierParameters(socketThenCallback, ['result']) ||
    !ts.isBlock(socketThenCallback.body) ||
    socketThenCallback.body.statements.length !== 1 ||
    normalizedSnippet(socketThenCallback.body.statements[0], socketFile) !==
      "if (result === 'paused') { logger.debug('[socket] event delivery paused during account transition', { event }); }" ||
    !socketCatchCallback ||
    !ts.isArrowFunction(socketCatchCallback) ||
    !hasPlainIdentifierParameters(socketCatchCallback, ['err']) ||
    !ts.isBlock(socketCatchCallback.body) ||
    socketCatchCallback.body.statements.length !== 2 ||
    !socketRetiredFailureIf ||
    normalizedSnippet(socketRetiredFailureIf.expression, socketFile) !==
      'deliveryLease && !deliveryLease.isCurrent()' ||
    !ts.isBlock(socketRetiredFailureIf.thenStatement) ||
    socketRetiredFailureIf.thenStatement.statements.length !== 2 ||
    normalizedSnippet(socketRetiredFailureIf.thenStatement.statements[0], socketFile) !==
      "logger.debug('[socket] event failure retired during account transition', { event });" ||
    !ts.isReturnStatement(socketRetiredFailureIf.thenStatement.statements[1]) ||
    normalizedSnippet(socketCatchCallback.body.statements[1], socketFile) !==
      "logger.error('[socket] event handling failed', 's1v3iohm10', { event, error: err, });"
  ) {
    return empty();
  }
  approved.push(socketReference.node);

  // FCM snapshots native data before tracking; session and lock gates re-check the same lease;
  // the locked branch posts only the generic notice and returns before durable dispatch.
  const fcmLockTry = deliverRespectingLock.body.statements[6];
  const encryptedBranch = deliver.body.statements[1];
  const supportedEncryptionBranch =
    ts.isIfStatement(encryptedBranch) && ts.isBlock(encryptedBranch.thenStatement)
      ? encryptedBranch.thenStatement.statements[0]
      : undefined;
  const supportedEncryptionBody =
    supportedEncryptionBranch &&
    ts.isIfStatement(supportedEncryptionBranch) &&
    ts.isBlock(supportedEncryptionBranch.thenStatement)
      ? supportedEncryptionBranch.thenStatement
      : undefined;
  const supportedEncryptionCondition =
    supportedEncryptionBranch && ts.isIfStatement(supportedEncryptionBranch)
      ? unwrapExpression(supportedEncryptionBranch.expression)
      : undefined;
  const supportedEncryptionSchemeCheck =
    supportedEncryptionCondition &&
    ts.isBinaryExpression(supportedEncryptionCondition) &&
    supportedEncryptionCondition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? unwrapExpression(supportedEncryptionCondition.left)
      : undefined;
  const fcmEncryptionTypeState = topLevelVariable(
    filesByPath.get('src/services/notifications/fcmDecrypt.ts'),
    'FCM_ENCRYPTION_TYPE',
  );
  const captureReturn = captureFcm.body.statements[5];
  const captureReturnObject =
    ts.isReturnStatement(captureReturn) && captureReturn.expression
      ? unwrapExpression(captureReturn.expression)
      : undefined;
  const captureParsedProperty =
    captureReturnObject && ts.isObjectLiteralExpression(captureReturnObject)
      ? captureReturnObject.properties[0]
      : undefined;
  const captureParseCall =
    captureParsedProperty && ts.isPropertyAssignment(captureParsedProperty)
      ? callableCall(captureParsedProperty.initializer, parseFcmData, checker)
      : undefined;
  const fcmSequenceState = topLevelVariable(fcmFile, 'fcmLocalOccurrenceSequence');
  const fcmNonceState = topLevelVariable(fcmFile, 'fcmProcessOccurrenceNonce');
  const fcmAdmissionTailState = topLevelVariable(fcmFile, 'fcmAdmissionTail');
  const fcmNonceInitializer = fcmNonceState?.declaration.initializer
    ? unwrapExpression(fcmNonceState.declaration.initializer)
    : undefined;
  const fcmNonceCalls = [];
  if (fcmNonceInitializer) {
    const visitNonceCalls = (node) => {
      if (ts.isCallExpression(node)) fcmNonceCalls.push(node);
      ts.forEachChild(node, visitNonceCalls);
    };
    visitNonceCalls(fcmNonceInitializer);
  }
  const fcmNonceDateCall = sole(
    fcmNonceCalls.filter((call) => {
      const access = callAccess(call.expression);
      return access?.method === 'now' && identifierNamed(access.receiver, 'Date');
    }),
  );
  const fcmNonceMathCall = sole(
    fcmNonceCalls.filter((call) => {
      const access = callAccess(call.expression);
      return access?.method === 'random' && identifierNamed(access.receiver, 'Math');
    }),
  );
  const fcmNonceDateAccess = fcmNonceDateCall ? callAccess(fcmNonceDateCall.expression) : undefined;
  const fcmNonceMathAccess = fcmNonceMathCall ? callAccess(fcmNonceMathCall.expression) : undefined;
  const fcmNonceDateSymbol = fcmNonceDateAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(fcmNonceDateAccess.receiver)),
        checker,
      )
    : undefined;
  const fcmNonceMathSymbol = fcmNonceMathAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(fcmNonceMathAccess.receiver)),
        checker,
      )
    : undefined;
  const fcmReceivedAtDeclaration = singleConstDeclaration(
    captureFcm.body.statements[4],
    'receivedAt',
  );
  const fcmReceivedAtCall = fcmReceivedAtDeclaration?.initializer
    ? callExpression(fcmReceivedAtDeclaration.initializer)
    : undefined;
  const fcmReceivedAtAccess = fcmReceivedAtCall
    ? callAccess(fcmReceivedAtCall.expression)
    : undefined;
  const fcmReceivedAtDateSymbol = fcmReceivedAtAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(fcmReceivedAtAccess.receiver)),
        checker,
      )
    : undefined;
  const fcmAdmissionTailInitializer = fcmAdmissionTailState?.declaration.initializer
    ? callExpression(fcmAdmissionTailState.declaration.initializer)
    : undefined;
  const fcmAdmissionTailInitializerAccess = fcmAdmissionTailInitializer
    ? callAccess(fcmAdmissionTailInitializer.expression)
    : undefined;
  const fcmAdmissionTailPromiseSymbol = fcmAdmissionTailInitializerAccess
    ? unaliasSymbol(
        checker.getSymbolAtLocation(unwrapExpression(fcmAdmissionTailInitializerAccess.receiver)),
        checker,
      )
    : undefined;
  const fcmSequenceWrites = fcmSequenceState
    ? assignmentWritesTo(fcmFile, fcmSequenceState.declaration.name, checker)
    : [];
  const fcmAdmissionTailWrites = fcmAdmissionTailState
    ? assignmentWritesTo(fcmFile, fcmAdmissionTailState.declaration.name, checker)
    : [];
  const passwordDeclaration = supportedEncryptionBody
    ? singleConstDeclaration(supportedEncryptionBody.statements[0], 'password')
    : undefined;
  const passwordAwait = passwordDeclaration?.initializer
    ? unwrapExpression(passwordDeclaration.initializer)
    : undefined;
  const passwordCall =
    passwordAwait && ts.isAwaitExpression(passwordAwait)
      ? callExpression(passwordAwait.expression)
      : undefined;
  const passwordAccess = passwordCall ? callAccess(passwordCall.expression) : undefined;
  const vaultBinding = namedImportBinding(fcmFile, '../clients', 'vault');
  const accountRevocationMarkerBinding = namedImportBinding(
    fcmFile,
    '../clients',
    'accountRevocationMarker',
  );
  const decryptTry = supportedEncryptionBody?.statements[4];
  const decryptStatement =
    decryptTry && ts.isTryStatement(decryptTry) ? decryptTry.tryBlock.statements[0] : undefined;
  const decryptAssignment =
    decryptStatement && ts.isExpressionStatement(decryptStatement)
      ? unwrapExpression(decryptStatement.expression)
      : undefined;
  const decryptAwait =
    decryptAssignment && ts.isBinaryExpression(decryptAssignment)
      ? unwrapExpression(decryptAssignment.right)
      : undefined;
  const decryptCall =
    decryptAwait && ts.isAwaitExpression(decryptAwait)
      ? callableCall(decryptAwait.expression, decryptFcmPayload, checker)
      : undefined;
  const hydratedDeclaration = supportedEncryptionBody
    ? singleConstDeclaration(supportedEncryptionBody.statements[6], 'hydratedBody')
    : undefined;
  const hydrateCall = hydratedDeclaration?.initializer
    ? callableCall(hydratedDeclaration.initializer, rehydrateFcmEnvelopeChatGuid, checker)
    : undefined;
  const fcmStoredLockDeclaration =
    fcmLockTry && ts.isTryStatement(fcmLockTry)
      ? singleConstDeclaration(fcmLockTry.tryBlock.statements[0], 'storedAppLock')
      : undefined;
  const fcmLockAssignmentStatement =
    fcmLockTry && ts.isTryStatement(fcmLockTry) ? fcmLockTry.tryBlock.statements[1] : undefined;
  const fcmLockAssignment =
    fcmLockAssignmentStatement && ts.isExpressionStatement(fcmLockAssignmentStatement)
      ? unwrapExpression(fcmLockAssignmentStatement.expression)
      : undefined;
  const fcmEffectiveLockCall =
    fcmLockAssignment && ts.isBinaryExpression(fcmLockAssignment)
      ? callableCall(fcmLockAssignment.right, effectivelyLocked, checker)
      : undefined;
  const fcmLockStateCall = fcmEffectiveLockCall?.arguments[0]
    ? callExpression(fcmEffectiveLockCall.arguments[0])
    : undefined;
  const fcmLockStateAccess = fcmLockStateCall ? callAccess(fcmLockStateCall.expression) : undefined;
  const fcmStoredLockGuardCall = fcmEffectiveLockCall?.arguments[1]
    ? callableCall(fcmEffectiveLockCall.arguments[1], storedAppLockRequiresProtection, checker)
    : undefined;
  const fcmUseLockStoreBinding = namedImportBinding(fcmFile, '@state/lockStore', 'useLockStore');
  if (
    captureFcm.body.statements.length !== 6 ||
    statementText(captureFcm, 0) !==
      "const providerMessageId = typeof msg.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : null;" ||
    statementText(captureFcm, 1) !== 'let transportOccurrenceId = providerMessageId;' ||
    statementText(captureFcm, 2) !==
      'if (!transportOccurrenceId) { fcmLocalOccurrenceSequence += 1; transportOccurrenceId = `fcm-local:${fcmProcessOccurrenceNonce}:${fcmLocalOccurrenceSequence}`; }' ||
    statementText(captureFcm, 3) !== 'const data = msg.data ? { ...msg.data } : undefined;' ||
    statementText(captureFcm, 4) !== 'const receivedAt = Date.now();' ||
    !fcmReceivedAtCall ||
    fcmReceivedAtCall.arguments.length !== 0 ||
    !fcmReceivedAtAccess ||
    fcmReceivedAtAccess.method !== 'now' ||
    !isNativeLibSymbol(fcmReceivedAtDateSymbol) ||
    statementText(captureFcm, 5) !==
      'return { parsed: parseFcmData(data), occurrence: { transportOccurrenceId, receivedAt }, };' ||
    !captureParseCall ||
    captureParseCall.arguments.length !== 1 ||
    !snippetIs(captureParseCall.arguments[0], 'data') ||
    !fcmSequenceState ||
    !(fcmSequenceState.declarationList.flags & ts.NodeFlags.Let) ||
    !fcmSequenceState.declaration.initializer ||
    !ts.isNumericLiteral(fcmSequenceState.declaration.initializer) ||
    fcmSequenceState.declaration.initializer.text !== '0' ||
    !fcmNonceState ||
    !(fcmNonceState.declarationList.flags & ts.NodeFlags.Const) ||
    !fcmNonceState.declaration.initializer ||
    normalizedSnippet(fcmNonceState.declaration.initializer, fcmFile) !==
      '`${Date.now().toString(36)}-${Math.random() .toString(36) .slice(2, 14)}`' ||
    !fcmNonceDateCall ||
    fcmNonceDateCall.arguments.length !== 0 ||
    !isNativeLibSymbol(fcmNonceDateSymbol) ||
    !fcmNonceMathCall ||
    fcmNonceMathCall.arguments.length !== 0 ||
    !isNativeLibSymbol(fcmNonceMathSymbol) ||
    fcmSequenceWrites.length !== 1 ||
    !nodeIsInside(fcmSequenceWrites[0], captureFcm.body.statements[2]) ||
    storedAppLockRequiresProtection.body.statements.length !== 1 ||
    statementText(storedAppLockRequiresProtection, 0) !==
      "return value !== null && value !== 'false';" ||
    deliverRespectingLock.body.statements.length !== 10 ||
    statementText(deliverRespectingLock, 0) !==
      'const { eventName: receivedEvent } = delivery.parsed;' ||
    statementText(deliverRespectingLock, 1) !==
      "logger.event('fcm.push_received', { eventName: receivedEvent, source });" ||
    statementText(deliverRespectingLock, 2) !==
      'const sessionState = await readFcmSessionState(vault, accountRevocationMarker);' ||
    statementText(deliverRespectingLock, 3) !== 'if (!lease.isCurrent()) return;' ||
    statementText(deliverRespectingLock, 4) !==
      "if (sessionState !== 'active') { if (sessionState === 'unavailable') { logger.warn('[fcm] session check unavailable — push dropped; sync will recover'); } else { logger.debug('[fcm] push for a forgotten server — dropped'); } return; }" ||
    statementText(deliverRespectingLock, 5) !== 'let locked = true;' ||
    !ts.isIfStatement(encryptedBranch) ||
    !ts.isBlock(encryptedBranch.thenStatement) ||
    encryptedBranch.thenStatement.statements.length !== 3 ||
    !supportedEncryptionBody ||
    supportedEncryptionBody.statements.length !== 9 ||
    normalizedSnippet(supportedEncryptionBody.statements[0], fcmFile) !==
      "const password = await vault.get('serverPassword');" ||
    normalizedSnippet(supportedEncryptionBody.statements[1], fcmFile) !==
      'if (!lease.isCurrent()) return;' ||
    normalizedSnippet(supportedEncryptionBody.statements[2], fcmFile) !==
      "if (!password) { logger.warn( '[fcm] encrypted push but no stored server password — will arrive on next sync', { event: eventName, }, ); return; }" ||
    normalizedSnippet(supportedEncryptionBody.statements[3], fcmFile) !==
      'let plaintext: string;' ||
    !passwordCall ||
    !passwordAccess ||
    passwordAccess.method !== 'get' ||
    !vaultBinding ||
    !sameSymbol(passwordAccess.receiver, vaultBinding, checker) ||
    passwordCall.arguments.length !== 1 ||
    !ts.isStringLiteral(unwrapExpression(passwordCall.arguments[0])) ||
    unwrapExpression(passwordCall.arguments[0]).text !== 'serverPassword' ||
    !decryptTry ||
    !ts.isTryStatement(decryptTry) ||
    !decryptTry.catchClause ||
    decryptTry.finallyBlock ||
    decryptTry.tryBlock.statements.length !== 1 ||
    decryptTry.catchClause.block.statements.length !== 2 ||
    !decryptAssignment ||
    !ts.isBinaryExpression(decryptAssignment) ||
    decryptAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !identifierNamed(decryptAssignment.left, 'plaintext') ||
    !decryptCall ||
    decryptCall.arguments.length !== 2 ||
    !snippetIs(decryptCall.arguments[0], 'body') ||
    !snippetIs(decryptCall.arguments[1], 'password') ||
    normalizedSnippet(decryptTry.catchClause.block.statements[0], fcmFile) !==
      "logger.warn('[fcm] failed to decrypt push — will arrive on next sync', e);" ||
    !ts.isReturnStatement(decryptTry.catchClause.block.statements[1]) ||
    normalizedSnippet(supportedEncryptionBody.statements[5], fcmFile) !==
      'if (!lease.isCurrent()) return;' ||
    !hydratedDeclaration ||
    !hydrateCall ||
    hydrateCall.arguments.length !== 2 ||
    !snippetIs(hydrateCall.arguments[0], 'plaintext') ||
    !snippetIs(hydrateCall.arguments[1], 'envelopeChatGuid') ||
    !ts.isReturnStatement(supportedEncryptionBody.statements[8]) ||
    !ts.isTryStatement(fcmLockTry) ||
    !fcmLockTry.catchClause ||
    fcmLockTry.finallyBlock ||
    fcmLockTry.tryBlock.statements.length !== 2 ||
    normalizedSnippet(fcmLockTry.tryBlock.statements[0], fcmFile) !==
      "const storedAppLock = await vault.get('appLockEnabled');" ||
    normalizedSnippet(fcmLockTry.tryBlock.statements[1], fcmFile) !==
      'locked = effectivelyLocked( useLockStore.getState(), storedAppLockRequiresProtection(storedAppLock), );' ||
    !fcmStoredLockDeclaration ||
    !fcmLockAssignment ||
    !ts.isBinaryExpression(fcmLockAssignment) ||
    fcmLockAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !identifierNamed(fcmLockAssignment.left, 'locked') ||
    !fcmEffectiveLockCall ||
    fcmEffectiveLockCall.arguments.length !== 2 ||
    !fcmLockStateCall ||
    !fcmLockStateAccess ||
    fcmLockStateAccess.method !== 'getState' ||
    !fcmUseLockStoreBinding ||
    !sameSymbol(fcmLockStateAccess.receiver, fcmUseLockStoreBinding, checker) ||
    fcmLockStateCall.arguments.length !== 0 ||
    !fcmStoredLockGuardCall ||
    fcmStoredLockGuardCall.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(fcmStoredLockGuardCall.arguments[0]),
      fcmStoredLockDeclaration.name,
      checker,
    ) ||
    fcmLockTry.catchClause.block.statements.length !== 1 ||
    normalizedSnippet(fcmLockTry.catchClause.block.statements[0], fcmFile) !==
      "logger.warn('[fcm] lock-state check failed — failing closed (content-less notice)', e);" ||
    statementText(deliverRespectingLock, 7) !== 'if (!lease.isCurrent()) return;' ||
    statementText(deliverRespectingLock, 8) !==
      'if (locked) { await postLockedNotification(lease); return; }' ||
    statementText(deliverRespectingLock, 9) !== 'return deliver(delivery, lease);'
  ) {
    return empty();
  }
  const fcmDispatchCalls = exactCallEdges(edges, deliver, dispatchRealtimeEvent);
  const encryptedDispatchCall = fcmDispatchCalls.find(
    (edge) =>
      normalizedSnippet(edge.node, fcmFile) ===
      "dispatchRealtimeEvent(eventName, hydratedBody, 'fcm', lease, delivery.occurrence)",
  );
  const plaintextDispatchCall = fcmDispatchCalls.find(
    (edge) =>
      normalizedSnippet(edge.node, fcmFile) ===
      "dispatchRealtimeEvent(eventName, body, 'fcm', lease, delivery.occurrence)",
  );
  const deliverCall = sole(exactCallEdges(edges, deliverRespectingLock, deliver));
  const sessionCall = sole(exactCallEdges(edges, deliverRespectingLock, readFcmSessionState));
  const lockedNoticeCall = sole(
    exactCallEdges(edges, deliverRespectingLock, postLockedNotification),
  );
  if (
    deliver.body.statements.length !== 3 ||
    statementText(deliver, 0) !==
      'const { eventName, body, envelopeChatGuid, encrypted, encryptionType } = delivery.parsed;' ||
    !ts.isIfStatement(encryptedBranch) ||
    !identifierNamed(encryptedBranch.expression, 'encrypted') ||
    !ts.isBlock(encryptedBranch.thenStatement) ||
    encryptedBranch.thenStatement.statements.length !== 3 ||
    supportedEncryptionBranch !== encryptedBranch.thenStatement.statements[0] ||
    !supportedEncryptionBranch ||
    !ts.isIfStatement(supportedEncryptionBranch) ||
    normalizedSnippet(supportedEncryptionBranch.expression, fcmFile) !==
      "encryptionType === FCM_ENCRYPTION_TYPE && typeof body === 'string'" ||
    !supportedEncryptionSchemeCheck ||
    !ts.isBinaryExpression(supportedEncryptionSchemeCheck) ||
    supportedEncryptionSchemeCheck.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !fcmEncryptionTypeState ||
    !sameSymbol(
      unwrapExpression(supportedEncryptionSchemeCheck.right),
      fcmEncryptionTypeState.declaration.name,
      checker,
    ) ||
    normalizedSnippet(encryptedBranch.thenStatement.statements[1], fcmFile) !==
      "logger.warn('[fcm] encrypted push with unsupported scheme skipped — will arrive on next sync', { event: eventName, encryptionType, });" ||
    !ts.isReturnStatement(encryptedBranch.thenStatement.statements[2]) ||
    !exactly(fcmDispatchCalls, 2) ||
    !encryptedDispatchCall ||
    !plaintextDispatchCall ||
    !nodeIsInside(encryptedDispatchCall.node, supportedEncryptionBody.statements[7]) ||
    !nodeIsInside(plaintextDispatchCall.node, deliver.body.statements[2]) ||
    !fcmDispatchCalls.every(
      (edge) =>
        coordinatorCallbackAdoptsInvocation(edge.node, deliver) &&
        [
          "dispatchRealtimeEvent(eventName, hydratedBody, 'fcm', lease, delivery.occurrence)",
          "dispatchRealtimeEvent(eventName, body, 'fcm', lease, delivery.occurrence)",
        ].includes(normalizedSnippet(edge.node, fcmFile)),
    ) ||
    !deliverCall ||
    !coordinatorCallbackAdoptsInvocation(deliverCall.node, deliverRespectingLock) ||
    !sessionCall ||
    !nodeIsInside(sessionCall.node, deliverRespectingLock.body.statements[2]) ||
    sessionCall.node.arguments.length !== 2 ||
    !vaultBinding ||
    !sameSymbol(unwrapExpression(sessionCall.node.arguments[0]), vaultBinding, checker) ||
    !accountRevocationMarkerBinding ||
    !sameSymbol(
      unwrapExpression(sessionCall.node.arguments[1]),
      accountRevocationMarkerBinding,
      checker,
    ) ||
    !lockedNoticeCall ||
    !nodeIsInside(lockedNoticeCall.node, deliverRespectingLock.body.statements[8])
  ) {
    return empty();
  }
  approved.push(...fcmDispatchCalls.map((edge) => edge.node), deliverCall.node);

  const fcmCaptureCall = sole(exactCallEdges(edges, handleIncomingFcm, captureFcm));
  const fcmTrackedCall = sole(exactCallEdges(edges, handleIncomingFcm, runTrackedDelivery));
  const fcmTask = fcmTrackedCall ? oneInlineCallback(fcmTrackedCall.node, 0, 'lease') : undefined;
  const fcmLockCall = fcmTask
    ? sole(exactCallEdges(edges, fcmTask, deliverRespectingLock))
    : undefined;
  const fcmTry = handleIncomingFcm.body.statements[0];
  const fcmDeliveryDeclaration = ts.isTryStatement(fcmTry)
    ? singleConstDeclaration(fcmTry.tryBlock.statements[0], 'delivery')
    : undefined;
  const fcmPreviousDeclaration = ts.isTryStatement(fcmTry)
    ? singleConstDeclaration(fcmTry.tryBlock.statements[1], 'previous')
    : undefined;
  const fcmTrackedDeclaration = ts.isTryStatement(fcmTry)
    ? singleConstDeclaration(fcmTry.tryBlock.statements[2], 'tracked')
    : undefined;
  const fcmTailStatement = ts.isTryStatement(fcmTry) ? fcmTry.tryBlock.statements[3] : undefined;
  const fcmTailAssignment =
    fcmTailStatement && ts.isExpressionStatement(fcmTailStatement)
      ? unwrapExpression(fcmTailStatement.expression)
      : undefined;
  const fcmTailThenCall =
    fcmTailAssignment && ts.isBinaryExpression(fcmTailAssignment)
      ? callExpression(fcmTailAssignment.right)
      : undefined;
  const fcmTailThenAccess = fcmTailThenCall ? callAccess(fcmTailThenCall.expression) : undefined;
  const fcmResultDeclaration = ts.isTryStatement(fcmTry)
    ? singleConstDeclaration(fcmTry.tryBlock.statements[4], 'result')
    : undefined;
  const fcmResultAwait = fcmResultDeclaration?.initializer
    ? unwrapExpression(fcmResultDeclaration.initializer)
    : undefined;
  if (
    !fcmAdmissionTailState ||
    !(fcmAdmissionTailState.declarationList.flags & ts.NodeFlags.Let) ||
    !fcmAdmissionTailState.declaration.initializer ||
    normalizedSnippet(fcmAdmissionTailState.declaration.initializer, fcmFile) !==
      'Promise.resolve()' ||
    !fcmAdmissionTailInitializer ||
    fcmAdmissionTailInitializer.arguments.length !== 0 ||
    !fcmAdmissionTailInitializerAccess ||
    fcmAdmissionTailInitializerAccess.method !== 'resolve' ||
    !isNativeLibSymbol(fcmAdmissionTailPromiseSymbol) ||
    fcmAdmissionTailWrites.length !== 1 ||
    captureFcm.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    captureFcm.asteriskToken ||
    handleIncomingFcm.body.statements.length !== 1 ||
    !ts.isTryStatement(fcmTry) ||
    !fcmTry.catchClause ||
    fcmTry.finallyBlock ||
    fcmTry.tryBlock.statements.length !== 6 ||
    fcmTry.catchClause.block.statements.length !== 1 ||
    normalizedSnippet(fcmTry.catchClause.block.statements[0], fcmFile) !==
      "logger.warn('[fcm] push delivery failed; sync will recover', { source, errorName: error instanceof Error ? error.name : 'UnknownError', });" ||
    !fcmCaptureCall ||
    !fcmDeliveryDeclaration ||
    !fcmDeliveryDeclaration.initializer ||
    unwrapExpression(fcmDeliveryDeclaration.initializer) !== fcmCaptureCall.node ||
    fcmCaptureCall.node.arguments.length !== 1 ||
    !sameSymbol(
      unwrapExpression(fcmCaptureCall.node.arguments[0]),
      handleIncomingFcm.parameters[0].name,
      checker,
    ) ||
    !fcmPreviousDeclaration ||
    !fcmPreviousDeclaration.initializer ||
    !sameSymbol(
      unwrapExpression(fcmPreviousDeclaration.initializer),
      fcmAdmissionTailState.declaration.name,
      checker,
    ) ||
    !fcmTrackedCall ||
    fcmTrackedCall.node.arguments.length !== 1 ||
    !fcmTrackedDeclaration ||
    unwrapExpression(fcmTrackedDeclaration.initializer) !== fcmTrackedCall.node ||
    !nodeIsInside(fcmTrackedCall.node, fcmTry.tryBlock.statements[2]) ||
    !fcmTask ||
    !fcmTask.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !ts.isBlock(fcmTask.body) ||
    fcmTask.body.statements.length !== 3 ||
    normalizedSnippet(fcmTask.body.statements[0], fcmFile) !== 'await previous;' ||
    !sameSymbol(
      unwrapExpression(fcmTask.body.statements[0].expression.expression),
      fcmPreviousDeclaration.name,
      checker,
    ) ||
    normalizedSnippet(fcmTask.body.statements[1], fcmFile) !== 'if (!lease.isCurrent()) return;' ||
    !fcmLockCall ||
    !coordinatorCallbackAdoptsInvocation(fcmLockCall.node, fcmTask) ||
    !nodeIsInside(fcmLockCall.node, fcmTask.body.statements[2]) ||
    !snippetIs(fcmLockCall.node, 'deliverRespectingLock(delivery, source, lease)') ||
    !fcmTailAssignment ||
    !ts.isBinaryExpression(fcmTailAssignment) ||
    fcmTailAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !sameSymbol(
      unwrapExpression(fcmTailAssignment.left),
      fcmAdmissionTailState.declaration.name,
      checker,
    ) ||
    fcmAdmissionTailWrites[0] !== fcmTailAssignment ||
    !fcmTailThenCall ||
    !fcmTailThenAccess ||
    fcmTailThenAccess.method !== 'then' ||
    !sameSymbol(
      unwrapExpression(fcmTailThenAccess.receiver),
      fcmTrackedDeclaration.name,
      checker,
    ) ||
    fcmTailThenCall.arguments.length !== 2 ||
    normalizedSnippet(fcmTailThenCall.arguments[0], fcmFile) !== '() => undefined' ||
    normalizedSnippet(fcmTailThenCall.arguments[1], fcmFile) !== '() => undefined' ||
    !fcmResultDeclaration ||
    !fcmResultAwait ||
    !ts.isAwaitExpression(fcmResultAwait) ||
    !sameSymbol(unwrapExpression(fcmResultAwait.expression), fcmTrackedDeclaration.name, checker) ||
    normalizedSnippet(fcmTry.tryBlock.statements[5], fcmFile) !==
      "if (result === 'paused') { logger.debug('[fcm] delivery paused during account transition', { source }); }"
  ) {
    return empty();
  }
  approved.push(fcmLockCall.node);

  // Headless delivery awaits the common handler and log flush in finally. Foreground delivery is
  // a contained void call into the same catch-owning handler. Registration remains module-top.
  const backgroundIncoming = sole(exactCallEdges(edges, handleBackgroundFcm, handleIncomingFcm));
  const backgroundFlush = sole(exactCallEdges(edges, handleBackgroundFcm, flushHeadlessLogs));
  const backgroundTry = handleBackgroundFcm.body.statements[0];
  const foregroundIncoming = sole(nestedCallEdges(edges, startFcm, handleIncomingFcm));
  const foregroundCallback = foregroundIncoming?.caller;
  const foregroundRegistration = foregroundCallback?.parent;
  const foregroundStatement = foregroundRegistration?.parent;
  const startFcmTry = startFcm.body.statements[0];
  const backgroundReferences = referenceEdges.filter(
    (reference) => reference.target === handleBackgroundFcm && !reference.caller,
  );
  const backgroundReference = sole(backgroundReferences);
  const backgroundRegistration = backgroundReference?.node.parent;
  const backgroundStatement = backgroundRegistration?.parent;
  const backgroundTryBlock = backgroundStatement?.parent;
  const backgroundTopLevelTry = backgroundTryBlock?.parent;
  const onMessageBinding = namedImportBinding(
    fcmFile,
    '@react-native-firebase/messaging',
    'onMessage',
  );
  const foregroundGetMessagingBinding = namedImportBinding(
    fcmFile,
    '@react-native-firebase/messaging',
    'getMessaging',
  );
  const backgroundGetMessagingBinding = namedImportBinding(
    fcmRegistrationFile,
    '@react-native-firebase/messaging',
    'getMessaging',
  );
  const backgroundHandlerBinding = namedImportBinding(
    fcmRegistrationFile,
    '@react-native-firebase/messaging',
    'setBackgroundMessageHandler',
  );
  const backgroundFcmBinding = namedImportBinding(
    fcmRegistrationFile,
    './fcmMessaging',
    'handleBackgroundFcm',
  );
  const backgroundLoggerBinding = namedImportBinding(fcmRegistrationFile, '@core/secure', 'logger');
  const backgroundHandlerCalls = backgroundHandlerBinding
    ? directCallsToBinding(fcmRegistrationFile, backgroundHandlerBinding, checker)
    : [];
  const backgroundHandlerReferences = backgroundHandlerBinding
    ? runtimeReferencesToBindings(filesByPath.values(), [backgroundHandlerBinding], checker)?.get(
        backgroundHandlerBinding,
      )
    : undefined;
  const onMessageCalls = onMessageBinding
    ? directCallsToBinding(fcmFile, onMessageBinding, checker)
    : [];
  const foregroundGetMessagingCalls = foregroundGetMessagingBinding
    ? directCallsToBinding(fcmFile, foregroundGetMessagingBinding, checker)
    : [];
  const backgroundGetMessagingCalls = backgroundGetMessagingBinding
    ? directCallsToBinding(fcmRegistrationFile, backgroundGetMessagingBinding, checker)
    : [];
  const foregroundMessagingDeclaration = ts.isTryStatement(startFcmTry)
    ? singleConstDeclaration(startFcmTry.tryBlock.statements[0], 'm')
    : undefined;
  const foregroundMessagingCall = foregroundMessagingDeclaration?.initializer
    ? callExpression(foregroundMessagingDeclaration.initializer)
    : undefined;
  const tokenRegistration = topLevelFunction(filesByPath, fcmPath, 'registerFcmToken');
  const tokenMessagingCall = foregroundGetMessagingCalls.find(
    (call) => call !== foregroundMessagingCall,
  );
  const tokenLookupCall = tokenMessagingCall?.parent;
  const backgroundMessagingCall =
    ts.isCallExpression(backgroundRegistration) && backgroundRegistration.arguments[0]
      ? callExpression(backgroundRegistration.arguments[0])
      : undefined;
  const staticGetMessagingReferences = backgroundGetMessagingBinding
    ? runtimeReferencesToBindings(
        filesByPath.values(),
        [backgroundGetMessagingBinding],
        checker,
      )?.get(backgroundGetMessagingBinding)
    : undefined;
  const allowedStaticGetMessagingReferences = new Set(
    [foregroundMessagingCall, tokenMessagingCall, backgroundMessagingCall]
      .filter(Boolean)
      .map((call) => unwrapExpression(call.expression)),
  );
  const firebaseRuntimeLoads = [];
  const compilerOptions = program.getCompilerOptions();
  const moduleResolutionCache = ts.createModuleResolutionCache(
    root,
    (fileName) => fileName,
    compilerOptions,
  );
  const realPath = (path) => {
    try {
      return normalizePath(ts.sys.realpath?.(path) ?? path);
    } catch {
      return normalizePath(path);
    }
  };
  const firebasePackageRoots = new Map(
    [
      ['app', '@react-native-firebase/app'],
      ['messaging', '@react-native-firebase/messaging'],
    ].map(([packageKind, packageName]) => {
      const lexicalRoot = resolve(root, 'node_modules', packageName);
      return [packageKind, new Set([normalizePath(lexicalRoot), realPath(lexicalRoot)])];
    }),
  );
  const firebasePackageForResolvedPath = (path) => {
    const normalized = normalizePath(path);
    if (normalized.includes('/node_modules/@react-native-firebase/app/')) return 'app';
    if (normalized.includes('/node_modules/@react-native-firebase/messaging/')) {
      return 'messaging';
    }
    const resolvedRealPath = realPath(path);
    for (const [packageKind, packageRoots] of firebasePackageRoots) {
      if (
        [...packageRoots].some(
          (packageRoot) =>
            resolvedRealPath === packageRoot || resolvedRealPath.startsWith(`${packageRoot}/`),
        )
      ) {
        return packageKind;
      }
    }
    return undefined;
  };
  const firebasePackageForSpecifier = (importerPath, specifier, specifierNode) => {
    const moduleSymbol = specifierNode
      ? unaliasSymbol(checker.getSymbolAtLocation(specifierNode), checker)
      : undefined;
    for (const declaration of moduleSymbol?.declarations ?? []) {
      const resolvedPackage = firebasePackageForResolvedPath(declaration.getSourceFile().fileName);
      if (resolvedPackage) return resolvedPackage;
    }
    const resolvedModule = ts.resolveModuleName(
      specifier,
      filesByPath.get(importerPath)?.fileName ?? resolve(root, importerPath),
      compilerOptions,
      ts.sys,
      moduleResolutionCache,
    ).resolvedModule;
    if (resolvedModule) {
      if (resolvedModule.packageId?.name === '@react-native-firebase/app') return 'app';
      if (resolvedModule.packageId?.name === '@react-native-firebase/messaging') {
        return 'messaging';
      }
      const resolvedPackage = firebasePackageForResolvedPath(resolvedModule.resolvedFileName);
      if (resolvedPackage) return resolvedPackage;
    }
    const canonical = specifier.startsWith('.')
      ? normalizePath(resolve('/', dirname(importerPath), specifier)).slice(1)
      : normalizePath(specifier);
    const matches = (packageName) =>
      canonical === packageName ||
      canonical.startsWith(`${packageName}/`) ||
      canonical === `node_modules/${packageName}` ||
      canonical.startsWith(`node_modules/${packageName}/`) ||
      canonical.includes(`/node_modules/${packageName}/`);
    if (matches('@react-native-firebase/app')) return 'app';
    if (matches('@react-native-firebase/messaging')) return 'messaging';
    return undefined;
  };
  let hasUnexpectedFirebaseRuntimeLoad = false;
  for (const [importerPath, file] of filesByPath) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const loader = unwrapExpression(node.expression);
        const argument = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
        if (loader.kind === ts.SyntaxKind.ImportKeyword || identifierNamed(loader, 'require')) {
          if (!argument || !ts.isStringLiteralLike(argument)) {
            hasUnexpectedFirebaseRuntimeLoad = true;
            return;
          }
          const firebasePackage = firebasePackageForSpecifier(
            importerPath,
            argument.text,
            argument,
          );
          if (
            firebasePackage === 'messaging' &&
            argument.text === '@react-native-firebase/messaging'
          ) {
            firebaseRuntimeLoads.push(node);
          } else if (firebasePackage === 'messaging') {
            hasUnexpectedFirebaseRuntimeLoad = true;
          }
          if (firebasePackage === 'app') {
            hasUnexpectedFirebaseRuntimeLoad = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  const firebaseRuntimeLoad = firebaseRuntimeLoads[0];
  const firebaseRuntimeLoadDeclaration = (() => {
    for (let current = firebaseRuntimeLoad; current; current = current.parent) {
      if (ts.isVariableStatement(current)) return current;
      if (ts.isFunctionLike(current)) return undefined;
    }
    return undefined;
  })();
  const firebaseRuntimeLoadBlock = firebaseRuntimeLoadDeclaration?.parent;
  const messagingInstanceType = backgroundMessagingCall
    ? checker.getApparentType(checker.getTypeAtLocation(backgroundMessagingCall))
    : undefined;
  const instanceBackgroundHandlerSymbol = messagingInstanceType
    ? checker.getPropertyOfType(messagingInstanceType, 'setBackgroundMessageHandler')
    : undefined;
  const modularBackgroundHandlerSymbol = backgroundHandlerBinding
    ? unaliasSymbol(checker.getSymbolAtLocation(backgroundHandlerBinding), checker)
    : undefined;
  const staticSetterPropertyName = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const expression = unwrapExpression(name.expression);
      return ts.isStringLiteralLike(expression) ? expression.text : undefined;
    }
    return undefined;
  };
  const receiverExposesProtectedSetter = (expression) => {
    const receiverType = checker.getApparentType(
      checker.getTypeAtLocation(unwrapExpression(expression)),
    );
    const resolvedSetter = checker.getPropertyOfType(receiverType, 'setBackgroundMessageHandler');
    return Boolean(
      resolvedSetter &&
      ((instanceBackgroundHandlerSymbol &&
        symbolsMatch(resolvedSetter, instanceBackgroundHandlerSymbol, checker)) ||
        (modularBackgroundHandlerSymbol &&
          symbolsMatch(resolvedSetter, modularBackgroundHandlerSymbol, checker))),
    );
  };
  const backgroundHandlerNameNodes = [];
  let hasDynamicBackgroundHandlerSurface = false;
  let hasUnreviewedInstanceBackgroundHandlerAccess = false;
  for (const file of filesByPath.values()) {
    function visit(node) {
      if (hasUnreviewedInstanceBackgroundHandlerAccess) return;
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        node.text === 'setBackgroundMessageHandler'
      ) {
        backgroundHandlerNameNodes.push(node);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isElementAccessExpression(unwrapExpression(node.expression))
      ) {
        const access = unwrapExpression(node.expression);
        const property = access.argumentExpression
          ? unwrapExpression(access.argumentExpression)
          : undefined;
        if (!property || !ts.isStringLiteralLike(property)) {
          hasDynamicBackgroundHandlerSurface = true;
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const receiverExposesSetter = receiverExposesProtectedSetter(node.initializer);
        if (
          node.name.elements.some((element) => {
            const property = element.propertyName ?? element.name;
            const staticName = staticSetterPropertyName(property);
            return (
              staticName === 'setBackgroundMessageHandler' ||
              ((element.dotDotDotToken || staticName === undefined) && receiverExposesSetter)
            );
          })
        ) {
          hasUnreviewedInstanceBackgroundHandlerAccess = true;
          return;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(unwrapExpression(node.left))
      ) {
        const receiverExposesSetter = receiverExposesProtectedSetter(node.right);
        const pattern = unwrapExpression(node.left);
        if (
          pattern.properties.some((property) => {
            if (ts.isSpreadAssignment(property)) return receiverExposesSetter;
            const staticName = staticSetterPropertyName(property.name);
            return (
              staticName === 'setBackgroundMessageHandler' ||
              (staticName === undefined && receiverExposesSetter)
            );
          })
        ) {
          hasUnreviewedInstanceBackgroundHandlerAccess = true;
          return;
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const staticName = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined;
        if (
          staticName === 'setBackgroundMessageHandler' ||
          (staticName === undefined &&
            (receiverExposesProtectedSetter(node.expression) ||
              (ts.isElementAccessExpression(node) &&
                checker.getApparentType(checker.getTypeAtLocation(node)).getCallSignatures()
                  .length > 0)))
        ) {
          hasUnreviewedInstanceBackgroundHandlerAccess = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (hasUnreviewedInstanceBackgroundHandlerAccess) break;
  }
  const approvedMessagingImports = new Map([
    [fcmPath, new Set(['getMessaging', 'getToken', 'onMessage', 'onTokenRefresh'])],
    [fcmRegistrationPath, new Set(['getMessaging', 'setBackgroundMessageHandler'])],
  ]);
  const hasUnexpectedMessagingImport = [...filesByPath].some(([path, file]) =>
    file.statements.some((statement) => {
      const moduleSpecifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : ts.isImportEqualsDeclaration(statement) &&
              ts.isExternalModuleReference(statement.moduleReference) &&
              statement.moduleReference.expression &&
              ts.isStringLiteralLike(statement.moduleReference.expression)
            ? statement.moduleReference.expression.text
            : undefined;
      const moduleSpecifierNode =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier
          : ts.isImportEqualsDeclaration(statement) &&
              ts.isExternalModuleReference(statement.moduleReference) &&
              statement.moduleReference.expression &&
              ts.isStringLiteralLike(statement.moduleReference.expression)
            ? statement.moduleReference.expression
            : undefined;
      const isTypeOnly =
        (ts.isImportDeclaration(statement) && Boolean(statement.importClause?.isTypeOnly)) ||
        ((ts.isExportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) &&
          statement.isTypeOnly);
      const firebasePackage = moduleSpecifier
        ? firebasePackageForSpecifier(path, moduleSpecifier, moduleSpecifierNode)
        : undefined;
      if (firebasePackage === 'app' && !isTypeOnly) return true;
      if (
        firebasePackage === 'messaging' &&
        moduleSpecifier !== '@react-native-firebase/messaging' &&
        !isTypeOnly
      ) {
        return true;
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === '@react-native-firebase/messaging'
      ) {
        return true;
      }
      if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLike(statement.moduleReference.expression) &&
        statement.moduleReference.expression.text === '@react-native-firebase/messaging'
      ) {
        return true;
      }
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== '@react-native-firebase/messaging' ||
        statement.importClause?.isTypeOnly
      ) {
        return false;
      }
      const expected = approvedMessagingImports.get(path);
      const clause = statement.importClause;
      if (
        !expected ||
        !clause ||
        clause.name ||
        !clause.namedBindings ||
        !ts.isNamedImports(clause.namedBindings)
      ) {
        return true;
      }
      const imported = clause.namedBindings.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => element.propertyName?.text ?? element.name.text);
      return imported.length !== expected.size || imported.some((name) => !expected.has(name));
    }),
  );
  if (
    handleBackgroundFcm.body.statements.length !== 1 ||
    !ts.isTryStatement(backgroundTry) ||
    backgroundTry.catchClause ||
    !backgroundTry.finallyBlock ||
    backgroundTry.tryBlock.statements.length !== 1 ||
    backgroundTry.finallyBlock.statements.length !== 1 ||
    !backgroundIncoming ||
    !coordinatorCallbackAdoptsInvocation(backgroundIncoming.node, handleBackgroundFcm) ||
    !snippetIs(backgroundIncoming.node, "handleIncomingFcm(msg, 'background')") ||
    !backgroundFlush ||
    !coordinatorCallbackAdoptsInvocation(backgroundFlush.node, handleBackgroundFcm) ||
    !foregroundIncoming ||
    !snippetIs(foregroundIncoming.node, "handleIncomingFcm(msg, 'foreground')") ||
    !ts.isVoidExpression(unwrapExpression(foregroundIncoming.node.parent)) ||
    !foregroundCallback ||
    !ts.isArrowFunction(foregroundCallback) ||
    !hasPlainIdentifierParameters(foregroundCallback, ['msg']) ||
    !ts.isBlock(foregroundCallback.body) ||
    foregroundCallback.body.statements.length !== 1 ||
    !ts.isCallExpression(foregroundRegistration) ||
    !foregroundMessagingDeclaration ||
    !foregroundMessagingCall ||
    !tokenRegistration?.body ||
    foregroundGetMessagingCalls.length !== 2 ||
    !tokenMessagingCall ||
    !ts.isCallExpression(tokenLookupCall) ||
    normalizedSnippet(tokenLookupCall, fcmFile) !== 'getToken(getMessaging())' ||
    !nodeIsInside(tokenMessagingCall, tokenRegistration) ||
    !staticGetMessagingReferences ||
    staticGetMessagingReferences.length !== 3 ||
    allowedStaticGetMessagingReferences.size !== 3 ||
    staticGetMessagingReferences.some(
      (reference) => !allowedStaticGetMessagingReferences.has(reference),
    ) ||
    firebaseRuntimeLoads.length !== 1 ||
    hasUnexpectedFirebaseRuntimeLoad ||
    !firebaseRuntimeLoadDeclaration ||
    normalizedSnippet(
      firebaseRuntimeLoadDeclaration,
      firebaseRuntimeLoadDeclaration.getSourceFile(),
    ) !==
      "const { deleteToken, getMessaging } = await import('@react-native-firebase/messaging');" ||
    !ts.isBlock(firebaseRuntimeLoadBlock) ||
    firebaseRuntimeLoadBlock.statements.length !== 2 ||
    firebaseRuntimeLoadBlock.statements[0] !== firebaseRuntimeLoadDeclaration ||
    normalizedSnippet(
      firebaseRuntimeLoadBlock.statements[1],
      firebaseRuntimeLoadBlock.getSourceFile(),
    ) !== 'await deleteToken(getMessaging());' ||
    !foregroundGetMessagingBinding ||
    !sameSymbol(
      unwrapExpression(foregroundMessagingCall.expression),
      foregroundGetMessagingBinding,
      checker,
    ) ||
    foregroundMessagingCall.arguments.length !== 0 ||
    !onMessageBinding ||
    onMessageCalls.length !== 1 ||
    onMessageCalls[0] !== foregroundRegistration ||
    !sameSymbol(unwrapExpression(foregroundRegistration.expression), onMessageBinding, checker) ||
    foregroundRegistration.arguments.length !== 2 ||
    unwrapExpression(foregroundRegistration.arguments[1]) !== foregroundCallback ||
    !nodeIsInside(foregroundRegistration, startFcm.body.statements[0]) ||
    !ts.isTryStatement(startFcmTry) ||
    startFcmTry.tryBlock.statements.length !== 4 ||
    foregroundStatement !== startFcmTry.tryBlock.statements[1] ||
    !snippetIs(foregroundRegistration.arguments[0], 'm') ||
    !backgroundReference ||
    !instanceBackgroundHandlerSymbol ||
    !modularBackgroundHandlerSymbol ||
    backgroundHandlerNameNodes.length !== 2 ||
    !backgroundHandlerNameNodes.includes(backgroundHandlerBinding) ||
    !backgroundHandlerNameNodes.includes(unwrapExpression(backgroundRegistration.expression)) ||
    hasDynamicBackgroundHandlerSurface ||
    hasUnreviewedInstanceBackgroundHandlerAccess ||
    hasUnexpectedMessagingImport ||
    fcmRegistrationFile.statements.length !== 4 ||
    !fcmRegistrationFile.statements.slice(0, 3).every(ts.isImportDeclaration) ||
    !ts.isCallExpression(backgroundRegistration) ||
    backgroundRegistration.arguments.length !== 2 ||
    !backgroundMessagingCall ||
    backgroundReference.file !== fcmRegistrationFile ||
    !backgroundFcmBinding ||
    !sameSymbol(backgroundReference.node, backgroundFcmBinding, checker) ||
    backgroundRegistration.arguments[1] !== backgroundReference.node ||
    runtimeReferencesToBinding(fcmRegistrationFile, backgroundFcmBinding, checker).length !== 1 ||
    !backgroundGetMessagingBinding ||
    !sameSymbol(
      unwrapExpression(backgroundMessagingCall.expression),
      backgroundGetMessagingBinding,
      checker,
    ) ||
    backgroundMessagingCall.arguments.length !== 0 ||
    !backgroundHandlerBinding ||
    backgroundHandlerCalls.length !== 1 ||
    backgroundHandlerCalls[0] !== backgroundRegistration ||
    !backgroundHandlerReferences ||
    backgroundHandlerReferences.length !== 1 ||
    !backgroundHandlerReferences.includes(unwrapExpression(backgroundRegistration.expression)) ||
    !foregroundGetMessagingCalls.includes(foregroundMessagingCall) ||
    backgroundGetMessagingCalls.length !== 1 ||
    backgroundGetMessagingCalls[0] !== backgroundMessagingCall ||
    !sameSymbol(
      unwrapExpression(backgroundRegistration.expression),
      backgroundHandlerBinding,
      checker,
    ) ||
    normalizedSnippet(backgroundRegistration, fcmRegistrationFile) !==
      'setBackgroundMessageHandler(getMessaging(), handleBackgroundFcm)' ||
    !ts.isExpressionStatement(backgroundStatement) ||
    !ts.isBlock(backgroundTryBlock) ||
    backgroundTryBlock.statements.length !== 1 ||
    !ts.isTryStatement(backgroundTopLevelTry) ||
    backgroundTopLevelTry.tryBlock !== backgroundTryBlock ||
    backgroundTopLevelTry.parent !== fcmRegistrationFile ||
    backgroundTopLevelTry !== fcmRegistrationFile.statements[3] ||
    !backgroundTopLevelTry.catchClause ||
    backgroundTopLevelTry.finallyBlock ||
    !backgroundTopLevelTry.catchClause.variableDeclaration ||
    !ts.isIdentifier(backgroundTopLevelTry.catchClause.variableDeclaration.name) ||
    backgroundTopLevelTry.catchClause.variableDeclaration.name.text !== 'error' ||
    backgroundTopLevelTry.catchClause.block.statements.length !== 1 ||
    !backgroundLoggerBinding ||
    runtimeReferencesToBinding(fcmRegistrationFile, backgroundLoggerBinding, checker).length !==
      1 ||
    normalizedSnippet(
      backgroundTopLevelTry.catchClause.block.statements[0],
      fcmRegistrationFile,
    ) !== "logger.warn('[fcm] setBackgroundMessageHandler unavailable — push disabled', error);" ||
    !ts.isTryStatement(startFcmTry) ||
    !startFcmTry.catchClause ||
    startFcmTry.finallyBlock ||
    startFcmTry.catchClause.block.statements.length !== 2 ||
    normalizedSnippet(startFcmTry.tryBlock.statements[0], fcmFile) !==
      'const m = getMessaging();' ||
    normalizedSnippet(startFcmTry.tryBlock.statements[1], fcmFile) !==
      "onMessage(m, (msg) => { void handleIncomingFcm(msg, 'foreground'); });" ||
    normalizedSnippet(startFcmTry.tryBlock.statements[2], fcmFile) !==
      'onTokenRefresh(m, () => void registerFcmToken());' ||
    normalizedSnippet(startFcmTry.tryBlock.statements[3], fcmFile) !== "return 'ready';" ||
    normalizedSnippet(startFcmTry.catchClause.block.statements[0], fcmFile) !==
      "logger.warn('[fcm] startFcm failed — falling back to socket-only', e);" ||
    normalizedSnippet(startFcmTry.catchClause.block.statements[1], fcmFile) !== "return 'failed';"
  ) {
    return empty();
  }
  approved.push(backgroundIncoming.node, foregroundIncoming.node, backgroundReference.node);

  // Recovery kicks are certified only at the exact dispatcher.resume calls inside tracked
  // callbacks. The mixed startRealtime/resumeRealtime functions themselves remain unresolved.
  const startResumeCall = sole(nestedCallEdges(edges, startRealtime, durableResume));
  const resumeResumeCall = sole(nestedCallEdges(edges, resumeRealtime, durableResume));
  const startRecoveryTracker = sole(exactCallEdges(edges, startRealtime, runTrackedDelivery));
  const resumeRecoveryTracker = sole(exactCallEdges(edges, resumeRealtime, runTrackedDelivery));
  const startRecoveryTask = startRecoveryTracker
    ? oneInlineCallback(startRecoveryTracker.node, 0, 'lease')
    : undefined;
  const resumeRecoveryTask = resumeRecoveryTracker
    ? oneInlineCallback(resumeRecoveryTracker.node, 0, 'lease')
    : undefined;
  const resumeRecoveryDatabaseCall = resumeRecoveryTask
    ? sole(exactCallEdges(edges, resumeRecoveryTask, ensureDatabase))
    : undefined;
  const startDatabaseCall = sole(exactCallEdges(edges, startRealtime, ensureDatabase));
  const startDatabaseDeclaration = singleConstDeclaration(startRealtime.body.statements[2], 'db');
  const startDatabaseAwait = startDatabaseDeclaration?.initializer
    ? unwrapExpression(startDatabaseDeclaration.initializer)
    : undefined;
  const startDatabaseAwaitedCall =
    startDatabaseAwait && ts.isAwaitExpression(startDatabaseAwait)
      ? callExpression(startDatabaseAwait.expression)
      : undefined;
  const startLeaseDeclaration = singleConstDeclaration(
    startRealtime.body.statements[6],
    'accountLease',
  );
  const startLeaseCall = startLeaseDeclaration?.initializer
    ? callableCall(startLeaseDeclaration.initializer, captureRealtimeDeliveryLease, checker)
    : undefined;
  const startRuntimeDeclaration = singleConstDeclaration(
    startRealtime.body.statements[8],
    'runtime',
  );
  const startRuntimeCall = startRuntimeDeclaration?.initializer
    ? callableCall(startRuntimeDeclaration.initializer, getRealtimeRuntime, checker)
    : undefined;
  const startResumeExpression = startResumeCall
    ? unwrapExpression(startResumeCall.node.expression)
    : undefined;
  const startResumeRuntime =
    startResumeExpression && ts.isPropertyAccessExpression(startResumeExpression)
      ? unwrapExpression(startResumeExpression.expression)
      : undefined;
  const startResumeRuntimeRoot =
    startResumeRuntime && ts.isPropertyAccessExpression(startResumeRuntime)
      ? unwrapExpression(startResumeRuntime.expression)
      : undefined;
  const startRecoveryStatement = (() => {
    for (let current = startRecoveryTracker?.node; current; current = current.parent) {
      if (ts.isStatement(current)) return current;
      if (current === startRealtime) return undefined;
    }
    return undefined;
  })();
  const startSocketConnectStatement = startRealtime.body.statements[12];
  const startSocketConnectCall = ts.isExpressionStatement(startSocketConnectStatement)
    ? callExpression(startSocketConnectStatement.expression)
    : undefined;
  const startSocketConnectAccess = startSocketConnectCall
    ? callAccess(startSocketConnectCall.expression)
    : undefined;
  if (
    !startResumeCall ||
    !resumeResumeCall ||
    !snippetIs(startResumeCall.node, 'runtime.dispatcher.resume(lease)') ||
    !snippetIs(resumeResumeCall.node, 'getRealtimeRuntime(db, lease)?.dispatcher.resume(lease)') ||
    !startRecoveryTracker ||
    !resumeRecoveryTracker ||
    !startRecoveryTask ||
    !resumeRecoveryTask ||
    !ts.isBlock(resumeRecoveryTask.body) ||
    resumeRecoveryTask.body.statements.length !== 3 ||
    normalizedSnippet(resumeRecoveryTask.body.statements[0], controlFile) !==
      'const db = await ensureDatabase();' ||
    normalizedSnippet(resumeRecoveryTask.body.statements[1], controlFile) !==
      'if (!lease.isCurrent()) return;' ||
    !resumeRecoveryDatabaseCall ||
    !nodeIsInside(resumeRecoveryDatabaseCall.node, resumeRecoveryTask.body.statements[0]) ||
    !startDatabaseCall ||
    !startDatabaseDeclaration ||
    startDatabaseAwaitedCall !== startDatabaseCall.node ||
    !startLeaseDeclaration ||
    !startLeaseCall ||
    startLeaseCall.arguments.length !== 0 ||
    !startRuntimeDeclaration ||
    !startRuntimeCall ||
    statementText(startRealtime, 3) !==
      'if ( !realtimeForegroundActive || lifecycleEpoch !== realtimeLifecycleEpoch || realtimeIntakeLocked() ) { return; }' ||
    statementText(startRealtime, 6) !== 'const accountLease = captureRealtimeDeliveryLease();' ||
    statementText(startRealtime, 7) !== 'if (!accountLease.isCurrent()) return;' ||
    statementText(startRealtime, 9) !== 'if (!runtime) return;' ||
    !startSocketConnectCall ||
    !startSocketConnectAccess ||
    startSocketConnectAccess.method !== 'connect' ||
    !socketState ||
    !sameSymbol(startSocketConnectAccess.receiver, socketState.declaration.name, checker) ||
    startSocketConnectCall.arguments.length !== 3 ||
    !snippetIs(startSocketConnectCall.arguments[0], 'transport.origin') ||
    !snippetIs(startSocketConnectCall.arguments[1], 'transport.password') ||
    !snippetIs(
      startSocketConnectCall.arguments[2],
      "{ headers: { ...transport.headers }, legacyQueryAuth: transport.authMode === 'legacy-query', }",
    ) ||
    startRuntimeCall.arguments.length !== 2 ||
    !snippetIs(startRuntimeCall.arguments[0], 'db') ||
    !snippetIs(startRuntimeCall.arguments[1], 'accountLease') ||
    !startResumeRuntimeRoot ||
    !sameSymbol(startResumeRuntimeRoot, startRuntimeDeclaration.name, checker) ||
    startResumeCall.caller !== startRecoveryTask ||
    resumeResumeCall.caller !== resumeRecoveryTask ||
    !startRecoveryStatement ||
    !normalizedSnippet(startRecoveryStatement, controlFile).startsWith(
      'void runTrackedRealtimeDelivery((lease) => runtime.dispatcher.resume(lease)).catch(',
    ) ||
    !coordinatorCallbackAdoptsInvocation(resumeRecoveryTracker.node, resumeRealtime) ||
    !coordinatorCallbackAdoptsInvocation(startResumeCall.node, startResumeCall.caller) ||
    !coordinatorCallbackAdoptsInvocation(resumeResumeCall.node, resumeResumeCall.caller)
  ) {
    return empty();
  }
  approved.push(startResumeCall.node, resumeResumeCall.node);

  // Closed-world boundary: adding another direct/dynamic call or reference to any protected
  // ingress capability revokes the certificate rather than silently widening the milestone.
  const expectedCalls = new Map([
    [dispatchWithContext, dispatchCalls.map((edge) => edge.node)],
    [durableHandle, [durableHandleCall.node]],
    [durablePersist, [persistCall.node]],
    [durableResume, [resumeProofCall.node, startResumeCall.node, resumeResumeCall.node]],
    [
      dispatchRealtimeEvent,
      [...fcmDispatchCalls.map((edge) => edge.node), devDispatchCall.node, chatDispatchCall.node],
    ],
    [devPushInject, devOuterNodes.slice(2)],
    [devPersist, [devOuterNodes[0]]],
    [devResume, [devOuterNodes[1]]],
    [deliver, [deliverCall.node]],
    [deliverRespectingLock, [fcmLockCall.node]],
    [handleIncomingFcm, [backgroundIncoming.node, foregroundIncoming.node]],
  ]);
  for (const [target, expectedNodes] of expectedCalls) {
    const actualNodes = edges.filter((edge) => edge.callee === target).map((edge) => edge.node);
    if (
      actualNodes.length !== expectedNodes.length ||
      actualNodes.some((node) => !expectedNodes.includes(node))
    ) {
      return empty();
    }
  }
  const expectedReferences = new Map([
    [dispatchRealtimeEvent, [socketReference.node]],
    [handleBackgroundFcm, [backgroundReference.node]],
  ]);
  for (const [target, expectedNodes] of expectedReferences) {
    const actualNodes = referenceEdges
      .filter((reference) => reference.target === target)
      .map((reference) => reference.node);
    if (
      actualNodes.length !== expectedNodes.length ||
      actualNodes.some((node) => !expectedNodes.includes(node))
    ) {
      return empty();
    }
  }
  const dispatchRuntimeReferences = runtimeReferencesToBinding(
    controlFile,
    dispatchRealtimeEvent.name,
    checker,
  ).filter((reference) => reference !== dispatchRealtimeEvent.name);
  const allowedControlDispatchReferences = new Set([
    unwrapExpression(devDispatchCall.node.expression),
    socketReference.node,
  ]);
  if (
    dispatchRuntimeReferences.length !== allowedControlDispatchReferences.size ||
    dispatchRuntimeReferences.some((reference) => !allowedControlDispatchReferences.has(reference))
  ) {
    return empty();
  }
  const protectedTargets = new Set([...expectedCalls.keys(), ...expectedReferences.keys()]);
  const allowedReferenceNodes = new Set([...expectedReferences.values()].flat());
  if (
    referenceEdges.some(
      (reference) =>
        typeof reference.target !== 'string' &&
        protectedTargets.has(reference.target) &&
        !allowedReferenceNodes.has(reference.node),
    ) ||
    dynamicDispatches.some((dispatch) =>
      dispatch.possibleCallees.some((callee) => protectedTargets.has(callee)),
    )
  ) {
    return empty();
  }
  const certified = new Set(approved);
  if (approved.length !== 22 || certified.size !== 22) return empty();

  const protectedOwners = new Set([
    dispatchRealtimeEvent,
    dispatchWithContext,
    trackedWorkCallback,
    trackedDeliveryCallback,
    resetRealtimeRuntime,
    getRealtimeRuntime,
    realtimeIntakeLocked,
    canPersistRealtimeEvent,
    createDevProofContext,
    proofCurrent,
    devPersist,
    devResume,
    devPushInject,
    durableHandle,
    durableDispose,
    queuePersistence,
    persistAdmission,
    persistGuardCallback,
    drainDispose,
    drainCancelWakeTimer,
    captureIncomingEvent,
    snapshotIncomingEvent,
    socketConstructor,
    socketConnect,
    socketOpen,
    socketEscalate,
    socketNativeCallback,
    socketTask,
    socketDisconnect,
    socketRetire,
    captureRealtimeDeliveryLease,
    pauseRealtimeDeliveries,
    resumeRealtimeDeliveries,
    subscribeRealtimeGenerationInvalidation,
    captureFcm,
    deliver,
    deliverRespectingLock,
    handleIncomingFcm,
    fcmTask,
    handleBackgroundFcm,
    startFcm,
    foregroundCallback,
    runDevAccountWrite,
    ...devCallbacks,
    chatCallback,
    startRecoveryTask,
    resumeRecoveryTask,
  ]);
  const allowedInternalMutatorNodes = new Set([
    ...certified,
    databaseCall.node,
    devPersistDatabaseCall.node,
    devResumeDatabaseCall.node,
    resumeRecoveryDatabaseCall.node,
    queueCalls[0].node,
    finishCalls[0].node,
    queuePersistCalls[0].node,
    persistEnqueueCall.node,
    persistAtomicEnqueueCall.node,
    admissionIifeCalls[0].node,
    trackedWorkCalls[0].node,
    trackedDeliveryCalls[0].node,
    devTrackerCall.node,
    ...devOuterTargets
      .map(
        ([owner]) =>
          edges.find(
            (edge) =>
              edge.caller === owner &&
              edge.callee === runDevAccountWrite &&
              edge.node.arguments.some((argument) =>
                devCallbacks.includes(unwrapExpression(argument)),
              ),
          )?.node,
      )
      .filter(Boolean),
    fcmTrackedCall.node,
    startRecoveryTracker.node,
    resumeRecoveryTracker.node,
  ]);
  const ownerIsProtected = (callable) =>
    callable && [...protectedOwners].some((owner) => callableIsInside(callable, owner));
  if (
    edges.some(
      (edge) =>
        ownerIsProtected(edge.caller) &&
        mutators.has(edge.callee) &&
        !allowedInternalMutatorNodes.has(edge.node),
    ) ||
    referenceEdges.some(
      (reference) =>
        ownerIsProtected(reference.caller) &&
        typeof reference.target !== 'string' &&
        mutators.has(reference.target) &&
        !allowedInternalMutatorNodes.has(reference.node),
    ) ||
    dynamicCallbacks.some((callback) => ownerIsProtected(callback.caller)) ||
    dynamicDispatches.some(
      (dispatch) =>
        ownerIsProtected(dispatch.caller) &&
        dispatch.possibleCallees.some((callee) => mutators.has(callee)),
    ) ||
    findings.some((finding) => {
      const callable = findingCallables.get(finding.id);
      return (
        callable &&
        ownerIsProtected(callable) &&
        !DIRECT_COORDINATED_CONTEXTS.has(finding.detectedContext)
      );
    })
  ) {
    return empty();
  }

  return certified;
}

/**
 * Exact foreground-boot handoffs that are otherwise tainted by the DEV-only throwaway driver test.
 * Seven nodes delegate to already-coordinated owners; the driver test and the process-relaunch
 * entry inherit only their callees' throwaway-database lifetimes. Any shape drift empties both sets
 * and leaves all nine findings unresolved.
 */
function foregroundBootLifecycleDelegationNodes({
  root,
  filesByPath,
  checker,
  edges,
  referenceEdges,
  dynamicCallbacks,
  dynamicDispatches,
  foregroundBootComposition,
  mutators,
  findings,
  findingCallables,
  driverSelfTestCandidate,
  driverAdapterCallables,
  processRelaunchCandidate,
}) {
  const empty = () => ({ coordinated: new Set(), temporal: new Set() });
  const rootPath = 'app/_layout.tsx';
  const foregroundPath = 'src/services/boot/foregroundBoot.ts';
  const syncedBackgroundPath = 'src/services/backgrounds/syncedBackground.ts';
  const rootFile = filesByPath.get(rootPath);
  const foregroundFile = filesByPath.get(foregroundPath);
  const startProcessWork = topLevelFunction(filesByPath, foregroundPath, 'startProcessWork');
  const initializeForegroundBootComposition = topLevelFunction(
    filesByPath,
    foregroundPath,
    'initializeForegroundBootComposition',
  );
  const startForegroundBoot = topLevelFunction(filesByPath, foregroundPath, 'startForegroundBoot');
  const subscribeForegroundBoot = topLevelFunction(
    filesByPath,
    foregroundPath,
    'subscribeForegroundBoot',
  );
  const startSyncedBackgroundCacheMaintenance = topLevelFunction(
    filesByPath,
    syncedBackgroundPath,
    'startSyncedBackgroundCacheMaintenance',
  );
  const replayProcessIssues = topLevelFunction(filesByPath, foregroundPath, 'replayProcessIssues');
  const runDbDriverSelfTest = driverSelfTestCandidate?.selfTest;
  const rootLayout = topLevelFunction(filesByPath, rootPath, 'RootLayout');
  const processWorkStarted = foregroundFile
    ? topLevelVariable(foregroundFile, 'processWorkStarted')
    : undefined;
  const coordinator = foregroundFile ? topLevelVariable(foregroundFile, 'coordinator') : undefined;
  if (
    !rootFile ||
    !foregroundFile ||
    foregroundBootComposition?.initializeForegroundBootComposition !==
      initializeForegroundBootComposition ||
    !startProcessWork?.body ||
    !initializeForegroundBootComposition?.body ||
    !startForegroundBoot?.body ||
    !subscribeForegroundBoot?.body ||
    !startSyncedBackgroundCacheMaintenance?.body ||
    !replayProcessIssues?.body ||
    !runDbDriverSelfTest?.body ||
    !processRelaunchCandidate?.startContract?.body ||
    driverAdapterCallables.throwawayFindingIds.size !==
      driverSelfTestCandidate.findingIds.size + processRelaunchCandidate.rawFindingIds.size ||
    !rootLayout?.body ||
    !processWorkStarted?.declaration.initializer ||
    !coordinator
  ) {
    return empty();
  }

  const callExpectations = new Map([
    [
      'app/_layout.tsx|RootLayout.<callback:f429780a18>.startOwnedRun|mutator-call|src/services/boot/foregroundBoot.ts#startForegroundBoot',
      'coordinated',
    ],
    [
      'app/_layout.tsx|RootLayout.<callback:f429780a18>.<callback:a6d63425a0>|mutator-call|app/_layout.tsx#RootLayout.<callback:f429780a18>.startOwnedRun',
      'coordinated',
    ],
    [
      'app/_layout.tsx|RootLayout.<callback:f429780a18>|mutator-call|app/_layout.tsx#RootLayout.<callback:f429780a18>.startOwnedRun',
      'coordinated',
    ],
    [
      'src/services/boot/foregroundBoot.ts|initializeForegroundBootComposition.<callback:3745c8b485>|mutator-call|src/services/boot/foregroundBoot.ts#startForegroundBoot',
      'coordinated',
    ],
    [
      'src/services/boot/foregroundBoot.ts|initializeForegroundBootComposition.<callback:58f904a832>|mutator-call|src/services/boot/foregroundBoot.ts#startForegroundBoot',
      'coordinated',
    ],
    [
      'src/services/boot/foregroundBoot.ts|startProcessWork|mutator-call|src/services/errors/index.ts#initErrorReporting',
      'support',
    ],
    [
      'src/services/boot/foregroundBoot.ts|startProcessWork|mutator-call|src/db/database.ts#runDbDriverSelfTest',
      'temporal',
    ],
    [
      'src/services/boot/foregroundBoot.ts|startForegroundBoot|mutator-call|src/services/boot/devDbRelaunchContract.ts#startDevDbRelaunchContractIfRequested',
      'temporal',
    ],
    [
      'src/services/boot/foregroundBoot.ts|startForegroundBoot|mutator-call|src/services/boot/foregroundBoot.ts#startProcessWork',
      'coordinated',
    ],
  ]);
  const referenceExpectations = new Map([
    [
      'app/_layout.tsx|RootLayout|mutator-reference|src/services/lock.ts#completeUnlock',
      'coordinated',
    ],
    [
      'src/services/boot/foregroundBoot.ts|<module>|mutator-reference|src/services/bootstrap.ts#inspectForegroundBootSession',
      'support',
    ],
    [
      'src/services/boot/foregroundBoot.ts|<module>|mutator-reference|src/services/bootstrap.ts#openForegroundBootDatabase',
      'support',
    ],
    [
      'src/services/boot/foregroundBoot.ts|<module>|mutator-reference|src/services/bootstrap.ts#activateForegroundBootSession',
      'support',
    ],
  ]);
  const matched = new Map(
    [...callExpectations.keys(), ...referenceExpectations.keys()].map((key) => [key, []]),
  );
  const protectedPaths = new Set([rootPath, foregroundPath]);
  let relevantCount = 0;
  for (const edge of edges) {
    const path = normalizePath(relative(root, edge.file.fileName));
    if (!protectedPaths.has(path) || !mutators.has(edge.callee)) continue;
    relevantCount += 1;
    const owner = edge.caller ? callableDisplayName(edge.caller) : '<module>';
    const key = `${path}|${owner}|mutator-call|${callableDescriptor(edge.callee, root)}`;
    if (!matched.has(key)) return empty();
    matched.get(key).push(edge);
  }
  for (const reference of referenceEdges) {
    const path = normalizePath(relative(root, reference.file.fileName));
    if (!protectedPaths.has(path)) continue;
    if (typeof reference.target === 'string') return empty();
    if (!mutators.has(reference.target)) continue;
    relevantCount += 1;
    const owner = reference.caller ? callableDisplayName(reference.caller) : '<module>';
    const key = `${path}|${owner}|mutator-reference|${callableDescriptor(reference.target, root)}`;
    if (!matched.has(key)) return empty();
    matched.get(key).push(reference);
  }
  if (relevantCount !== 13 || [...matched.values()].some((values) => values.length !== 1)) {
    return empty();
  }

  const edgeFor = (key) => matched.get(key)[0];
  const startOwnedEdge = edgeFor([...callExpectations.keys()][0]);
  const activeRestartEdge = edgeFor([...callExpectations.keys()][1]);
  const initialStartEdge = edgeFor([...callExpectations.keys()][2]);
  const supersededRestartEdge = edgeFor([...callExpectations.keys()][3]);
  const installedRestartEdge = edgeFor([...callExpectations.keys()][4]);
  const driverSelfTestEdge = edgeFor([...callExpectations.keys()][6]);
  const relaunchContractEdge = edgeFor([...callExpectations.keys()][7]);
  const processWorkEdge = edgeFor([...callExpectations.keys()][8]);
  const completeUnlockReference = edgeFor([...referenceExpectations.keys()][0]);
  const startOwnedRun = startOwnedEdge.caller;
  const appStateCallback = activeRestartEdge.caller;
  const rootEffectCallback = initialStartEdge.caller;
  const supersededCallback = supersededRestartEdge.caller;
  const installedRestartCallback = installedRestartEdge.caller;
  if (
    !startOwnedRun?.body ||
    !appStateCallback?.body ||
    !rootEffectCallback?.body ||
    !supersededCallback?.body ||
    !installedRestartCallback?.body
  ) {
    return empty();
  }

  const {
    compositionStatements,
    compositionStartEdges,
    compositionSubscribeEdges,
    installers: compositionInstallers,
  } = foregroundBootComposition;
  const restarterInstaller = compositionInstallers.find(
    (installer) => installer.name === 'installForegroundBootRestarter',
  );
  const restarterBinding = restarterInstaller?.binding;
  const restarterCall = restarterInstaller?.call;
  const compositionRegistration =
    compositionStatements[2] && ts.isExpressionStatement(compositionStatements[2])
      ? callExpression(compositionStatements[2].expression)
      : undefined;
  const compositionRegistrationAccess = compositionRegistration
    ? callAccess(compositionRegistration.expression)
    : undefined;
  const subscribeCompositionStatement = subscribeForegroundBoot.body.statements[0];
  const subscribeCompositionCall = ts.isExpressionStatement(subscribeCompositionStatement)
    ? callableCall(
        subscribeCompositionStatement.expression,
        initializeForegroundBootComposition,
        checker,
      )
    : undefined;
  const subscribeReturn = subscribeForegroundBoot.body.statements[1];
  const subscribeRegistration =
    subscribeReturn && ts.isReturnStatement(subscribeReturn) && subscribeReturn.expression
      ? callExpression(subscribeReturn.expression)
      : undefined;
  const subscribeRegistrationAccess = subscribeRegistration
    ? callAccess(subscribeRegistration.expression)
    : undefined;
  const subscribeListener = subscribeRegistration?.arguments[0]
    ? unwrapExpression(subscribeRegistration.arguments[0])
    : undefined;
  const subscribeListenerCall =
    subscribeListener &&
    (ts.isArrowFunction(subscribeListener) || ts.isFunctionExpression(subscribeListener))
      ? callExpression(subscribeListener.body)
      : undefined;
  if (
    !restarterInstaller ||
    !compositionRegistration ||
    compositionRegistration.arguments.length !== 1 ||
    compositionRegistration.arguments[0] !== supersededCallback ||
    !compositionRegistrationAccess ||
    compositionRegistrationAccess.method !== 'subscribe' ||
    !sameSymbol(compositionRegistrationAccess.receiver, coordinator.declaration.name, checker) ||
    !hasExactIdentifierParameters(subscribeForegroundBoot, [{ name: 'listener' }]) ||
    subscribeForegroundBoot.body.statements.length !== 2 ||
    !subscribeCompositionCall ||
    subscribeCompositionCall !== compositionSubscribeEdges[0]?.node ||
    subscribeCompositionCall.arguments.length !== 0 ||
    !subscribeRegistration ||
    subscribeRegistration.arguments.length !== 1 ||
    !subscribeRegistrationAccess ||
    subscribeRegistrationAccess.method !== 'subscribe' ||
    !sameSymbol(subscribeRegistrationAccess.receiver, coordinator.declaration.name, checker) ||
    !subscribeListener ||
    !(ts.isArrowFunction(subscribeListener) || ts.isFunctionExpression(subscribeListener)) ||
    !hasExactIdentifierParameters(subscribeListener, []) ||
    !subscribeListenerCall ||
    subscribeListenerCall.arguments.length !== 0 ||
    !sameSymbol(
      unwrapExpression(subscribeListenerCall.expression),
      subscribeForegroundBoot.parameters[0].name,
      checker,
    )
  ) {
    return empty();
  }

  const processStatements = startProcessWork.body.statements;
  const processGuard = processStatements[0];
  const processClaimStatement = processStatements[1];
  const processClaim =
    processClaimStatement && ts.isExpressionStatement(processClaimStatement)
      ? unwrapExpression(processClaimStatement.expression)
      : undefined;
  if (
    !(processWorkStarted.declarationList.flags & ts.NodeFlags.Let) ||
    processWorkStarted.declaration.initializer.kind !== ts.SyntaxKind.FalseKeyword ||
    !hasExactIdentifierParameters(startProcessWork, []) ||
    processStatements.length !== 10 ||
    !processGuard ||
    !ts.isIfStatement(processGuard) ||
    !sameSymbol(
      unwrapExpression(processGuard.expression),
      processWorkStarted.declaration.name,
      checker,
    ) ||
    !ts.isReturnStatement(processGuard.thenStatement) ||
    processGuard.elseStatement ||
    !processClaim ||
    !ts.isBinaryExpression(processClaim) ||
    processClaim.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !sameSymbol(
      unwrapExpression(processClaim.left),
      processWorkStarted.declaration.name,
      checker,
    ) ||
    processClaim.right.kind !== ts.SyntaxKind.TrueKeyword ||
    assignmentWritesTo(foregroundFile, processWorkStarted.declaration.name, checker).length !== 1 ||
    assignmentWritesTo(foregroundFile, processWorkStarted.declaration.name, checker)[0] !==
      processClaim
  ) {
    return empty();
  }

  const maintenanceBinding = namedImportBinding(
    foregroundFile,
    '../backgrounds/syncedBackground',
    'startSyncedBackgroundCacheMaintenance',
  );
  const maintenanceCalls = maintenanceBinding
    ? directCallsToBinding(foregroundFile, maintenanceBinding, checker)
    : [];
  const maintenanceCall = maintenanceCalls[0];
  const maintenanceEdges = exactCallEdges(
    edges,
    startProcessWork,
    startSyncedBackgroundCacheMaintenance,
  );
  const maintenanceCatchAccess = maintenanceCall?.parent
    ? callAccess(maintenanceCall.parent)
    : undefined;
  const maintenanceCatchCall = maintenanceCall?.parent?.parent
    ? callExpression(maintenanceCall.parent.parent)
    : undefined;
  const maintenanceVoid =
    maintenanceCatchCall && ts.isVoidExpression(maintenanceCatchCall.parent)
      ? maintenanceCatchCall.parent
      : undefined;
  const maintenanceStatement =
    maintenanceVoid && ts.isExpressionStatement(maintenanceVoid.parent)
      ? maintenanceVoid.parent
      : undefined;
  const maintenanceFailureCallback = maintenanceCatchCall
    ? oneInlineCallback(maintenanceCatchCall, 0, 'error')
    : undefined;
  const maintenanceFailureCall = maintenanceFailureCallback
    ? callExpression(maintenanceFailureCallback.body)
    : undefined;
  const maintenanceFailureAccess = maintenanceFailureCall
    ? callAccess(maintenanceFailureCall.expression)
    : undefined;
  const loggerBinding = namedImportBinding(foregroundFile, '@core/secure', 'logger');
  if (
    !maintenanceBinding ||
    maintenanceCalls.length !== 1 ||
    runtimeReferencesToBinding(foregroundFile, maintenanceBinding, checker).length !== 1 ||
    maintenanceEdges.length !== 1 ||
    edges.filter((edge) => edge.callee === startSyncedBackgroundCacheMaintenance).length !== 1 ||
    !maintenanceCall ||
    maintenanceCall !== maintenanceEdges[0]?.node ||
    maintenanceCall.arguments.length !== 0 ||
    !maintenanceCatchAccess ||
    maintenanceCatchAccess.method !== 'catch' ||
    maintenanceCatchAccess.receiver !== maintenanceCall ||
    !maintenanceCatchCall ||
    maintenanceCatchCall.arguments.length !== 1 ||
    !maintenanceVoid ||
    maintenanceVoid.expression !== maintenanceCatchCall ||
    !maintenanceStatement ||
    maintenanceStatement !== processStatements[6] ||
    !maintenanceFailureCallback ||
    !maintenanceFailureCall ||
    maintenanceFailureCall.arguments.length !== 2 ||
    !maintenanceFailureAccess ||
    maintenanceFailureAccess.method !== 'warn' ||
    !loggerBinding ||
    !sameSymbol(maintenanceFailureAccess.receiver, loggerBinding, checker) ||
    !ts.isStringLiteralLike(maintenanceFailureCall.arguments[0]) ||
    maintenanceFailureCall.arguments[0].text !==
      '[boot] synced-background cache maintenance failed' ||
    !sameSymbol(
      unwrapExpression(maintenanceFailureCall.arguments[1]),
      maintenanceFailureCallback.parameters[0].name,
      checker,
    )
  ) {
    return empty();
  }

  const driverSelfTestBinding = namedImportBinding(
    foregroundFile,
    '@db/database',
    'runDbDriverSelfTest',
  );
  const internalFailureBinding = namedImportBinding(
    foregroundFile,
    '@db/database',
    'DB_DRIVER_CONTRACT_INTERNAL_FAILURE',
  );
  const driverSelfTestCalls = driverSelfTestBinding
    ? directCallsToBinding(foregroundFile, driverSelfTestBinding, checker)
    : [];
  const driverSelfTestCall = driverSelfTestEdge.node;
  let devIf;
  for (
    let current = driverSelfTestCall.parent;
    current && current !== startProcessWork;
    current = current.parent
  ) {
    if (ts.isIfStatement(current)) {
      devIf = current;
      break;
    }
  }
  const driverThenAccess = ts.isPropertyAccessExpression(driverSelfTestCall.parent)
    ? driverSelfTestCall.parent
    : undefined;
  const driverThenCall = driverThenAccess ? callExpression(driverThenAccess.parent) : undefined;
  const driverVoid =
    driverThenCall && ts.isVoidExpression(driverThenCall.parent)
      ? driverThenCall.parent
      : undefined;
  const driverStatement =
    driverVoid && ts.isExpressionStatement(driverVoid.parent) ? driverVoid.parent : undefined;
  const driverSuccessCallback = driverThenCall
    ? oneInlineCallback(driverThenCall, 0, 'result')
    : undefined;
  const driverFailureExpression = driverThenCall?.arguments[1]
    ? unwrapExpression(driverThenCall.arguments[1])
    : undefined;
  const driverFailureCallback =
    driverFailureExpression &&
    (ts.isArrowFunction(driverFailureExpression) ||
      ts.isFunctionExpression(driverFailureExpression)) &&
    hasExactIdentifierParameters(driverFailureExpression, [])
      ? driverFailureExpression
      : undefined;
  const devIdentifiers = [];
  if (devIf) {
    const visitDevCondition = (node) => {
      if (ts.isIdentifier(node) && node.text === '__DEV__') devIdentifiers.push(node);
      ts.forEachChild(node, visitDevCondition);
    };
    visitDevCondition(devIf.expression);
  }
  const devSymbol = devIdentifiers[0]
    ? unaliasSymbol(checker.getSymbolAtLocation(devIdentifiers[0]), checker)
    : undefined;
  if (
    !driverSelfTestBinding ||
    !internalFailureBinding ||
    driverSelfTestCalls.length !== 1 ||
    driverSelfTestCalls[0] !== driverSelfTestCall ||
    driverSelfTestCall.arguments.length !== 0 ||
    edges.filter((edge) => edge.callee === runDbDriverSelfTest).length !== 1 ||
    runtimeReferencesToBinding(foregroundFile, driverSelfTestBinding, checker).length !== 1 ||
    runtimeReferencesToBinding(foregroundFile, internalFailureBinding, checker).length !== 1 ||
    !devIf ||
    devIf.parent !== startProcessWork.body ||
    normalizedSnippet(devIf.expression, foregroundFile) !==
      "typeof __DEV__ !== 'undefined' && __DEV__" ||
    devIdentifiers.length !== 2 ||
    !sameSymbol(devIdentifiers[0], devIdentifiers[1], checker) ||
    !devSymbol?.declarations?.length ||
    devSymbol.declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile) ||
    !ts.isBlock(devIf.thenStatement) ||
    devIf.thenStatement.statements.length !== 2 ||
    devIf.elseStatement ||
    driverStatement !== devIf.thenStatement.statements[1] ||
    !driverThenAccess ||
    driverThenAccess.name.text !== 'then' ||
    !driverThenCall ||
    driverThenCall.arguments.length !== 2 ||
    !driverSuccessCallback ||
    !driverFailureCallback ||
    !driverVoid ||
    normalizedSnippet(driverSuccessCallback.body, foregroundFile) !==
      'logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(result)}`)' ||
    normalizedSnippet(driverFailureCallback.body, foregroundFile) !==
      'logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(DB_DRIVER_CONTRACT_INTERNAL_FAILURE)}`)'
  ) {
    return empty();
  }

  const bootStatements = startForegroundBoot.body.statements;
  const bootCompositionStatement = bootStatements[0];
  const bootCompositionCall = ts.isExpressionStatement(bootCompositionStatement)
    ? callableCall(
        bootCompositionStatement.expression,
        initializeForegroundBootComposition,
        checker,
      )
    : undefined;
  const relaunchIf = bootStatements[1];
  const relaunchBlock =
    relaunchIf && ts.isIfStatement(relaunchIf) && ts.isBlock(relaunchIf.thenStatement)
      ? relaunchIf.thenStatement
      : undefined;
  const relaunchDeclaration = relaunchBlock
    ? singleConstDeclaration(relaunchBlock.statements[0], 'relaunchContract')
    : undefined;
  const relaunchCall = relaunchDeclaration?.initializer
    ? callExpression(relaunchDeclaration.initializer)
    : undefined;
  const relaunchReturn = relaunchBlock?.statements[1];
  const relaunchBinding = namedImportBinding(
    foregroundFile,
    './devDbRelaunchContract',
    'startDevDbRelaunchContractIfRequested',
  );
  const runDeclaration = singleConstDeclaration(bootStatements[2], 'run');
  const coordinatorStart = runDeclaration?.initializer
    ? callExpression(runDeclaration.initializer)
    : undefined;
  const coordinatorStartAccess = coordinatorStart
    ? callAccess(coordinatorStart.expression)
    : undefined;
  const replayCall =
    bootStatements[4] && ts.isExpressionStatement(bootStatements[4])
      ? callableCall(bootStatements[4].expression, replayProcessIssues, checker)
      : undefined;
  const runReturn = bootStatements[5];
  if (
    !hasExactIdentifierParameters(startForegroundBoot, []) ||
    bootStatements.length !== 6 ||
    !bootCompositionCall ||
    bootCompositionCall !== compositionStartEdges[0]?.node ||
    bootCompositionCall.arguments.length !== 0 ||
    !relaunchIf ||
    !ts.isIfStatement(relaunchIf) ||
    normalizedSnippet(relaunchIf.expression, foregroundFile) !==
      "typeof __DEV__ !== 'undefined' && __DEV__" ||
    relaunchIf.elseStatement ||
    !relaunchBlock ||
    relaunchBlock.statements.length !== 2 ||
    !relaunchDeclaration ||
    !relaunchCall ||
    relaunchCall !== relaunchContractEdge.node ||
    relaunchCall !== processRelaunchCandidate.foregroundCall ||
    relaunchCall.arguments.length !== 0 ||
    !relaunchBinding ||
    runtimeReferencesToBinding(foregroundFile, relaunchBinding, checker).length !== 1 ||
    !relaunchReturn ||
    !ts.isIfStatement(relaunchReturn) ||
    normalizedSnippet(relaunchReturn, foregroundFile) !==
      'if (relaunchContract) return relaunchContract;' ||
    !runDeclaration ||
    !coordinatorStart ||
    coordinatorStart.arguments.length !== 0 ||
    !coordinatorStartAccess ||
    coordinatorStartAccess.method !== 'start' ||
    !sameSymbol(coordinatorStartAccess.receiver, coordinator.declaration.name, checker) ||
    !ts.isExpressionStatement(bootStatements[3]) ||
    callExpression(bootStatements[3].expression) !== processWorkEdge.node ||
    processWorkEdge.node.arguments.length !== 0 ||
    !replayCall ||
    replayCall.arguments.length !== 0 ||
    !runReturn ||
    !ts.isReturnStatement(runReturn) ||
    !runReturn.expression ||
    !sameSymbol(unwrapExpression(runReturn.expression), runDeclaration.name, checker)
  ) {
    return empty();
  }

  const supersededRegistration = ts.isCallExpression(supersededCallback.parent)
    ? supersededCallback.parent
    : undefined;
  const supersededRegistrationAccess = supersededRegistration
    ? callAccess(supersededRegistration.expression)
    : undefined;
  const supersededIf = supersededCallback.body.statements[0];
  const installedRegistration = ts.isCallExpression(installedRestartCallback.parent)
    ? installedRestartCallback.parent
    : undefined;
  if (
    !hasExactIdentifierParameters(supersededCallback, [{ name: 'state' }]) ||
    supersededCallback.body.statements.length !== 1 ||
    !supersededIf ||
    !ts.isIfStatement(supersededIf) ||
    normalizedSnippet(supersededIf.expression, foregroundFile) !==
      "state.status === 'failed' && state.failure.code === 'foreground-boot-superseded'" ||
    !ts.isBlock(supersededIf.thenStatement) ||
    supersededIf.thenStatement.statements.length !== 2 ||
    !ts.isVoidExpression(supersededRestartEdge.node.parent) ||
    supersededRestartEdge.node.parent.parent !== supersededIf.thenStatement.statements[1] ||
    supersededRestartEdge.node.arguments.length !== 0 ||
    !supersededRegistration ||
    supersededRegistration !== compositionRegistration ||
    supersededRegistration.parent !== compositionStatements[2] ||
    supersededRegistration.arguments.length !== 1 ||
    supersededRegistration.arguments[0] !== supersededCallback ||
    !supersededRegistrationAccess ||
    supersededRegistrationAccess.method !== 'subscribe' ||
    !sameSymbol(supersededRegistrationAccess.receiver, coordinator.declaration.name, checker) ||
    !hasExactIdentifierParameters(installedRestartCallback, []) ||
    installedRestartCallback.body.statements.length !== 1 ||
    !ts.isVoidExpression(installedRestartEdge.node.parent) ||
    installedRestartEdge.node.parent.parent !== installedRestartCallback.body.statements[0] ||
    installedRestartEdge.node.arguments.length !== 0 ||
    !restarterBinding ||
    !installedRegistration ||
    installedRegistration !== restarterCall ||
    installedRegistration.parent !== compositionStatements[4] ||
    installedRegistration.arguments.length !== 1 ||
    installedRegistration.arguments[0] !== installedRestartCallback ||
    !sameSymbol(unwrapExpression(installedRegistration.expression), restarterBinding, checker)
  ) {
    return empty();
  }

  if (
    !hasExactIdentifierParameters(startOwnedRun, []) ||
    startOwnedRun.body.statements.length !== 3 ||
    normalizedSnippet(startOwnedRun.body.statements[0], rootFile) !==
      'if (!mountedRef.current || !appActiveRef.current) { restartBootOnActiveRef.current = true; return; }' ||
    normalizedSnippet(startOwnedRun.body.statements[1], rootFile) !==
      'restartBootOnActiveRef.current = false;' ||
    normalizedSnippet(startOwnedRun.body.statements[2], rootFile) !==
      'void startForegroundBoot();' ||
    !nodeIsInside(startOwnedEdge.node, startOwnedRun.body.statements[2]) ||
    !hasExactIdentifierParameters(appStateCallback, [{ name: 'state' }]) ||
    appStateCallback.body.statements.length !== 3 ||
    normalizedSnippet(appStateCallback.body.statements[0], rootFile) !==
      "appActiveRef.current = state === 'active';" ||
    normalizedSnippet(appStateCallback.body.statements[1], rootFile) !==
      'if (!appActiveRef.current) { if (retireOwnedRun()) restartBootOnActiveRef.current = true; return; }' ||
    normalizedSnippet(appStateCallback.body.statements[2], rootFile) !==
      'if (restartBootOnActiveRef.current) startOwnedRun();' ||
    !nodeIsInside(activeRestartEdge.node, appStateCallback.body.statements[2]) ||
    normalizedSnippet(initialStartEdge.node.parent.parent, rootFile) !==
      'if (appActiveRef.current) startOwnedRun(); else restartBootOnActiveRef.current = true;'
  ) {
    return empty();
  }

  const appStateBinding = namedImportBinding(rootFile, 'react-native', 'AppState');
  const appStateRegistration = ts.isCallExpression(appStateCallback.parent)
    ? appStateCallback.parent
    : undefined;
  const appStateRegistrationAccess = appStateRegistration
    ? callAccess(appStateRegistration.expression)
    : undefined;
  const useEffectBinding = namedImportBinding(rootFile, 'react', 'useEffect');
  const rootEffectRegistration = ts.isCallExpression(rootEffectCallback.parent)
    ? rootEffectCallback.parent
    : undefined;
  const completeUnlockBinding = namedImportBinding(rootFile, '@/services/lock', 'completeUnlock');
  const foregroundLockGateBinding = namedImportBinding(
    rootFile,
    '@features/lock/ForegroundLockGate',
    'ForegroundLockGate',
  );
  const completeUnlockExpression = completeUnlockReference.node.parent;
  const completeUnlockAttribute = completeUnlockExpression?.parent;
  const completeUnlockAttributes = completeUnlockAttribute?.parent;
  const completeUnlockOpeningElement = completeUnlockAttributes?.parent;
  if (
    !appStateBinding ||
    !appStateRegistration ||
    appStateRegistration.arguments.length !== 2 ||
    !ts.isStringLiteral(appStateRegistration.arguments[0]) ||
    appStateRegistration.arguments[0].text !== 'change' ||
    appStateRegistration.arguments[1] !== appStateCallback ||
    !appStateRegistrationAccess ||
    appStateRegistrationAccess.method !== 'addEventListener' ||
    !sameSymbol(appStateRegistrationAccess.receiver, appStateBinding, checker) ||
    !useEffectBinding ||
    !rootEffectRegistration ||
    rootEffectRegistration.arguments.length !== 2 ||
    rootEffectRegistration.arguments[0] !== rootEffectCallback ||
    !sameSymbol(unwrapExpression(rootEffectRegistration.expression), useEffectBinding, checker) ||
    !ts.isArrayLiteralExpression(unwrapExpression(rootEffectRegistration.arguments[1])) ||
    unwrapExpression(rootEffectRegistration.arguments[1]).elements.length !== 0 ||
    !completeUnlockBinding ||
    !sameSymbol(completeUnlockReference.node, completeUnlockBinding, checker) ||
    !ts.isJsxExpression(completeUnlockExpression) ||
    completeUnlockExpression.expression !== completeUnlockReference.node ||
    !ts.isJsxAttribute(completeUnlockAttribute) ||
    !ts.isIdentifier(completeUnlockAttribute.name) ||
    completeUnlockAttribute.name.text !== 'onWarmUnlock' ||
    !foregroundLockGateBinding ||
    !completeUnlockAttributes ||
    !ts.isJsxAttributes(completeUnlockAttributes) ||
    !completeUnlockOpeningElement ||
    !ts.isJsxOpeningElement(completeUnlockOpeningElement) ||
    !ts.isIdentifier(completeUnlockOpeningElement.tagName) ||
    !sameSymbol(completeUnlockOpeningElement.tagName, foregroundLockGateBinding, checker)
  ) {
    return empty();
  }

  const protectedOwners = new Set([
    ...driverSelfTestCandidate.protectedOwners,
    startProcessWork,
    initializeForegroundBootComposition,
    startForegroundBoot,
    subscribeForegroundBoot,
    startOwnedRun,
    appStateCallback,
    supersededCallback,
    installedRestartCallback,
  ]);
  const ownerIsProtected = (callable) =>
    callable && [...protectedOwners].some((owner) => callableIsInside(callable, owner));
  const allowedNodes = new Set([
    ...[...matched.values()].flat().map((entry) => entry.node),
    ...driverSelfTestCandidate.internalCallNodes,
  ]);
  if (
    edges.some(
      (edge) =>
        ownerIsProtected(edge.caller) && mutators.has(edge.callee) && !allowedNodes.has(edge.node),
    ) ||
    referenceEdges.some(
      (reference) =>
        ownerIsProtected(reference.caller) &&
        (typeof reference.target === 'string' || mutators.has(reference.target)) &&
        !allowedNodes.has(reference.node),
    ) ||
    dynamicCallbacks.some((callback) => ownerIsProtected(callback.caller)) ||
    dynamicDispatches.some(
      (dispatch) =>
        ownerIsProtected(dispatch.caller) &&
        dispatch.possibleCallees.some((callee) => mutators.has(callee)),
    )
  ) {
    return empty();
  }

  const coordinated = new Set();
  const temporal = new Set();
  for (const [key, kind] of callExpectations) {
    const node = matched.get(key)[0].node;
    if (kind === 'coordinated') coordinated.add(node);
    if (kind === 'temporal') temporal.add(node);
  }
  for (const [key, kind] of referenceExpectations) {
    if (kind === 'coordinated') coordinated.add(matched.get(key)[0].node);
  }
  return coordinated.size === 7 && temporal.size === 2 ? { coordinated, temporal } : empty();
}

/**
 * Exact composition handoffs into the error-report subsystem.
 *
 * The source-local service edges use the generic negative-taint delegation proof. These seven
 * callers live in mixed orchestration files, so approving their whole paths would also bless
 * unrelated boot, realtime, sync, and notification work. Count every exact target instead: an
 * added, removed, or redirected handoff makes this set empty and leaves all seven findings visible
 * as unresolved for review.
 */
function errorReportLifecycleDelegationNodes({ root, edges }) {
  const appStateOwner = 'ConnectedAppLayout.<callback:2f0bceb3e7>.<callback:cff4117220>';
  const appStateTarget = 'src/services/errors/index.ts#flushErrorReports';
  const appStateKey = `app/(app)/_layout.tsx|${appStateOwner}|${appStateTarget}`;
  const expectations = new Map([
    [appStateKey, 2],
    [
      'app/(app)/_layout.tsx|ConnectedAppLayout.<callback:5bd646a3ed>|src/services/errors/index.ts#flushErrorReports',
      1,
    ],
    [
      'src/services/background/backgroundSync.ts|flushBackgroundDiagnostics|src/services/errors/errorReportQueueService.ts#runErrorReportQueue',
      1,
    ],
    [
      'src/services/background/backgroundSync.ts|executeBackgroundSyncTask.flushDiagnostics|src/services/background/backgroundSync.ts#flushBackgroundDiagnostics',
      1,
    ],
    [
      'src/services/boot/foregroundBoot.ts|startProcessWork|src/services/errors/index.ts#initErrorReporting',
      1,
    ],
    ['src/services/lock.ts|completeUnlock|src/services/errors/index.ts#flushErrorReports', 1],
  ]);
  const matched = new Map([...expectations].map(([key]) => [key, []]));
  for (const edge of edges) {
    const path = normalizePath(relative(root, edge.file.fileName));
    const owner = edge.caller ? callableDisplayName(edge.caller) : '<module>';
    const target = callableDescriptor(edge.callee, root);
    const key = `${path}|${owner}|${target}`;
    if (matched.has(key)) matched.get(key).push(edge.node);
  }
  for (const [key, count] of expectations) {
    if (matched.get(key).length !== count) return new Set();
  }
  const appStateNodes = matched.get(appStateKey);
  const isInsideExactBranch = (node, condition) => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isIfStatement(current) &&
        normalizedSnippet(current.expression, current.getSourceFile()) === condition &&
        current.thenStatement.pos <= node.pos &&
        node.end <= current.thenStatement.end
      ) {
        return true;
      }
      if (ts.isFunctionLike(current)) break;
    }
    return false;
  };
  if (
    appStateNodes.filter((node) =>
      isInsideExactBranch(node, "state === 'background' || state === 'inactive'"),
    ).length !== 1 ||
    appStateNodes.filter((node) => isInsideExactBranch(node, "state === 'active'")).length !== 1
  ) {
    return new Set();
  }
  const approved = [...matched.values()].flat();
  return approved.length === 7 && new Set(approved).size === 7 ? new Set(approved) : new Set();
}

/** Exact reminder-press handoffs in a mixed notification-action module. */
function notificationEffectLifecycleDelegationNodes({ root, edges }) {
  const expectations = new Map([
    [
      'src/services/notifications/actions.ts|handleNotificationPress.<callback:57842c3968>|src/services/notifications/actions.ts#handleNotificationPressForAccount',
      1,
    ],
    [
      'src/services/notifications/actions.ts|handleNotificationPressForAccount|src/db/repositories/reminders.ts#deleteReminderByNotificationId',
      1,
    ],
  ]);
  const matched = new Map([...expectations].map(([key]) => [key, []]));
  for (const edge of edges) {
    const path = normalizePath(relative(root, edge.file.fileName));
    const owner = edge.caller ? callableDisplayName(edge.caller) : '<module>';
    const target = callableDescriptor(edge.callee, root);
    const key = `${path}|${owner}|${target}`;
    if (matched.has(key)) matched.get(key).push(edge.node);
  }
  for (const [key, count] of expectations) {
    if (matched.get(key).length !== count) return new Set();
  }
  const approved = [...matched.values()].flat();
  return approved.length === 2 && new Set(approved).size === 2 ? new Set(approved) : new Set();
}

/** Exact account-transition handoffs in mixed UI/realtime composition owners. */
function accountTransitionDelegationNodes({ root, edges, referenceEdges }) {
  const expectations = new Map([
    ['app/(app)/home.tsx|Home.onDisconnect|mutator-call|src/services/bootstrap.ts#forget', 1],
    ['app/(app)/home.tsx|Home|mutator-reference|app/(app)/home.tsx#Home.onDisconnect', 1],
    [
      'app/(app)/settings.tsx|SettingsScreen.onDisconnect.onPress|mutator-call|src/services/bootstrap.ts#forget',
      1,
    ],
    [
      'src/services/realtimeControl.ts|realtimeSink.<callback:68fe0014d7>|mutator-call|src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.retireInactiveEntries',
      1,
    ],
    [
      'src/services/realtimeControl.ts|realtimeSink.<callback:68fe0014d7>|mutator-call|src/services/download/attachmentCacheCoordinator.ts#AttachmentCacheCoordinator.drainDueRetirements',
      1,
    ],
  ]);
  const matched = new Map([...expectations].map(([key]) => [key, []]));
  const collect = (edge, operation) => {
    const path = normalizePath(relative(root, edge.file.fileName));
    const owner = edge.caller ? callableDisplayName(edge.caller) : '<module>';
    const target = callableDescriptor(edge.callee, root);
    const key = `${path}|${owner}|${operation}|${target}`;
    if (matched.has(key)) matched.get(key).push(edge.node);
  };
  for (const edge of edges) collect(edge, 'mutator-call');
  for (const reference of referenceEdges) {
    if (typeof reference.target === 'string') continue;
    collect({ ...reference, callee: reference.target }, 'mutator-reference');
  }
  for (const [key, count] of expectations) {
    if (matched.get(key).length !== count) return new Set();
  }
  const approved = [...matched.values()].flat();
  return approved.length === 5 && new Set(approved).size === 5 ? new Set(approved) : new Set();
}

function callableNodeForFinding(finding, file) {
  const position =
    typeof finding.sourceOffset === 'number'
      ? finding.sourceOffset
      : file.getPositionOfLineAndCharacter(finding.line - 1, 0);
  let best;
  let bestWidth = Number.POSITIVE_INFINITY;
  function visit(node) {
    if (ts.isFunctionLike(node)) {
      const start = node.getStart(file);
      if (start <= position && node.end >= position) {
        const width = node.end - start;
        if (width < bestWidth) {
          best = node;
          bestWidth = width;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return best;
}

function directCoordinatorInfoForCallable(callable, root) {
  const path = normalizePath(relative(root, callable.getSourceFile().fileName));
  const name = declarationName(callable);
  if (
    path === 'src/db/transaction.ts' &&
    (name === 'withDbTransaction' || name === 'withDbWriteLock')
  ) {
    return {
      context: name,
      callbackParameterIndex: name === 'withDbTransaction' ? 1 : 0,
    };
  }
  return undefined;
}

function coordinatorInfoForCallable(callable, root, forwardedCoordinators = new Map()) {
  return directCoordinatorInfoForCallable(callable, root) ?? forwardedCoordinators.get(callable);
}

function coordinatorKindForCallable(callable, root, forwardedCoordinators = new Map()) {
  return coordinatorInfoForCallable(callable, root, forwardedCoordinators)?.context;
}

function isStableForwardedCoordinatorCallable(callable) {
  if (ts.isFunctionDeclaration(callable)) {
    return Boolean(callable.name && callable.body && !callable.asteriskToken);
  }
  if (
    !ts.isArrowFunction(callable) &&
    !(ts.isFunctionExpression(callable) && !callable.asteriskToken)
  ) {
    return false;
  }
  let expression = callable;
  while (
    expression.parent &&
    (ts.isAsExpression(expression.parent) ||
      ts.isParenthesizedExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const declaration = expression.parent;
  return (
    isConstVariableDeclaration(declaration) &&
    Boolean(declaration.initializer) &&
    unwrapExpression(declaration.initializer) === callable
  );
}

function isAnonymousInlineCoordinatorCallback(expression) {
  const callback = unwrapExpression(expression);
  return (
    ts.isArrowFunction(callback) ||
    (ts.isFunctionExpression(callback) &&
      callback.name === undefined &&
      callback.asteriskToken === undefined)
  );
}

function callableReferencesArguments(callable, checker) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      ts.isIdentifier(node) &&
      node.text === 'arguments' &&
      referenceExpression(node) === node &&
      (constAliasSymbolForInitializerReference(node, checker) !== undefined ||
        !isDeclarationOrModuleAliasReference(node))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (callable.body) visit(callable.body);
  return found;
}

function transparentExpressionParent(node) {
  const parent = node.parent;
  if (
    parent &&
    (ts.isAsExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent)) &&
    parent.expression === node
  ) {
    return parent;
  }
  return undefined;
}

function returnCanBeOverriddenByFinally(returnStatement, callback) {
  let child = returnStatement;
  for (let current = child.parent; current && current !== callback; current = current.parent) {
    if (
      ts.isTryStatement(current) &&
      current.finallyBlock &&
      (child === current.tryBlock || child === current.catchClause)
    ) {
      return true;
    }
    child = current;
  }
  return false;
}

function coordinatorCallbackAdoptsInvocation(call, callback) {
  let expression = call;
  let parent = transparentExpressionParent(expression);
  while (parent) {
    expression = parent;
    parent = transparentExpressionParent(expression);
  }
  if (
    ts.isAwaitExpression(expression.parent) &&
    expression.parent.expression === expression &&
    isDirectlyInsideCallable(expression.parent, callback)
  ) {
    return true;
  }
  if (ts.isArrowFunction(callback) && callback.body === expression) return true;
  const returnStatement = ts.isReturnStatement(expression.parent) ? expression.parent : undefined;
  return (
    returnStatement?.expression === expression &&
    isDirectlyInsideCallable(returnStatement, callback) &&
    !returnCanBeOverriddenByFinally(returnStatement, callback)
  );
}

function exactImportedRunInTransactionContext(call, checker, root) {
  const expression = unwrapExpression(call.expression);
  if (!ts.isIdentifier(expression)) return false;
  const imported = checker.getSymbolAtLocation(expression);
  if (!imported || !(imported.flags & ts.SymbolFlags.Alias)) return false;
  const callable = callableNodeForExpression(expression, checker);
  return Boolean(
    callable &&
    declarationName(callable) === 'runInTransactionContext' &&
    normalizePath(relative(root, callable.getSourceFile().fileName)) === 'src/db/transaction.ts',
  );
}

function transactionCallbackUsesOnlySuppliedDatabase(callback, checker) {
  const parameter =
    callback.parameters.length === 1 &&
    ts.isIdentifier(callback.parameters[0]?.name) &&
    !callback.parameters[0].initializer &&
    !callback.parameters[0].dotDotDotToken
      ? callback.parameters[0].name
      : undefined;
  let safe = true;

  function visit(node) {
    if (!safe) return;
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && isDirectlyInsideCallable(node, callback)) {
      const access = callAccess(unwrapExpression(node.expression));
      if (
        access &&
        (BUILDER_METHODS.has(access.method) || RAW_METHODS.has(access.method)) &&
        (DYNAMIC_RAW_METHODS.has(access.method) ||
          receiverLooksDatabaseLike(access.receiver) ||
          (parameter &&
            ts.isIdentifier(unwrapExpression(access.receiver)) &&
            sameSymbol(unwrapExpression(access.receiver), parameter, checker)))
      ) {
        const receiver = unwrapExpression(access.receiver);
        if (!parameter || !ts.isIdentifier(receiver) || !sameSymbol(receiver, parameter, checker)) {
          safe = false;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(callback.body);
  return safe;
}

/**
 * The runtime context join is not a SQL opener and earns no mutation record of its own. Its exact
 * imported, awaited/returned inline callback is nevertheless a real transaction body: the runtime
 * rejects forged/stale contexts and the owner waits for every synchronously registered task before
 * COMMIT/ROLLBACK. Named, dynamic, unawaited, and nested callbacks fail closed.
 */
function registeredTransactionCallbackInfo(files, checker, root) {
  const contexts = new Map();
  const edges = [];
  for (const file of files) {
    function visit(node) {
      if (ts.isCallExpression(node) && exactImportedRunInTransactionContext(node, checker, root)) {
        const caller = enclosingCallableNode(node);
        const callbackExpression = node.arguments[1];
        const callback = callbackExpression ? unwrapExpression(callbackExpression) : undefined;
        if (
          caller &&
          callback &&
          isAnonymousInlineCoordinatorCallback(callback) &&
          coordinatorCallbackAdoptsInvocation(node, caller) &&
          transactionCallbackUsesOnlySuppliedDatabase(callback, checker)
        ) {
          contexts.set(callback, 'withDbTransaction');
          // This edge preserves transitive mutator/coordinator propagation through a helper that
          // wraps its SQL in runInTransactionContext. It is suppressed when findings are emitted,
          // so the join itself never becomes an invented DB mutation or transaction opener.
          edges.push({ caller, callee: callback, node, file, suppressFinding: true });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return { contexts, edges };
}

/**
 * Infer a callback-forwarding coordinator wrapper only when both halves are closed-world:
 *
 * 1. the wrapper is a stable free function/const binding with no `arguments` escape;
 * 2. exactly one parameter is invoked, and every use is directly awaited or returned through a
 *    path no enclosing `finally` can override, by one anonymous non-generator callback; and
 * 3. every runtime reference to the wrapper is a statically resolved direct call whose callback
 *    argument resolves to a concrete callable.
 *
 * Anything dynamic, escaped, directly invoked outside the coordinator, or ambiguous removes the
 * wrapper from this map. This is intentionally one layer only; a wrapper must visibly bottom out
 * in the real transaction primitive rather than inheriting trust from another inferred wrapper.
 */
function forwardedCoordinatorInfos(files, checker, root) {
  const directCallbackContexts = new Map();
  for (const file of files) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = callableNodeForExpression(node.expression, checker);
        const info = callee ? directCoordinatorInfoForCallable(callee, root) : undefined;
        const expression = info ? node.arguments[info.callbackParameterIndex] : undefined;
        const callback = expression ? callableNodeForExpression(expression, checker) : undefined;
        const inlineCallback = expression ? unwrapExpression(expression) : undefined;
        if (
          callback &&
          info &&
          inlineCallback &&
          isAnonymousInlineCoordinatorCallback(inlineCallback)
        ) {
          const contexts = directCallbackContexts.get(callback) ?? new Set();
          contexts.add(info.context);
          directCallbackContexts.set(callback, contexts);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const candidates = new Map();
  for (const file of files) {
    function visit(node) {
      if (
        ts.isFunctionLike(node) &&
        node.body &&
        isStableForwardedCoordinatorCallable(node) &&
        !callableReferencesArguments(node, checker)
      ) {
        const parameterCandidates = [];
        for (const [index, parameter] of node.parameters.entries()) {
          if (!ts.isIdentifier(parameter.name)) continue;
          const parameterSymbol = unaliasSymbol(
            checker.getSymbolAtLocation(parameter.name),
            checker,
          );
          if (!parameterSymbol) continue;
          let referenced = false;
          let unsafe = false;
          const contexts = new Set();

          function inspect(reference) {
            if (reference !== parameter.name && ts.isIdentifier(reference)) {
              const symbol = unaliasSymbol(checker.getSymbolAtLocation(reference), checker);
              if (symbol === parameterSymbol) {
                referenced = true;
                const call =
                  ts.isCallExpression(reference.parent) &&
                  unwrapExpression(reference.parent.expression) === reference
                    ? reference.parent
                    : undefined;
                if (!call) {
                  unsafe = true;
                } else {
                  const matchingContexts = new Set();
                  for (const [callback, callbackContexts] of directCallbackContexts) {
                    if (
                      isDirectlyInsideCallable(callback, node) &&
                      isDirectlyInsideCallable(call, callback) &&
                      coordinatorCallbackAdoptsInvocation(call, callback)
                    ) {
                      for (const context of callbackContexts) matchingContexts.add(context);
                    }
                  }
                  if (matchingContexts.size !== 1) unsafe = true;
                  else contexts.add([...matchingContexts][0]);
                }
              }
            }
            ts.forEachChild(reference, inspect);
          }
          inspect(node.body);

          if (referenced && !unsafe && contexts.size === 1) {
            parameterCandidates.push({
              context: [...contexts][0],
              callbackParameterIndex: index,
            });
          }
        }
        if (parameterCandidates.length === 1) candidates.set(node, parameterCandidates[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const safe = new Map(candidates);
  const sawCall = new Set();
  const callbackUses = [];
  for (const file of files) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const dispatch = dynamicNamespaceDispatch(node, checker, root);
        if (dispatch) {
          for (const possibleCallee of dispatch.possibleCallees) {
            if (candidates.has(possibleCallee)) safe.delete(possibleCallee);
          }
        }
      }
      const expression = referenceExpression(node);
      if (expression && !isDeclarationOrModuleAliasReference(expression)) {
        const callable = callableNodeForExpression(expression, checker);
        const info = callable ? candidates.get(callable) : undefined;
        if (callable && info) {
          const call =
            isDirectCallReference(expression) && ts.isCallExpression(expression.parent)
              ? expression.parent
              : undefined;
          const callbackExpression = call?.arguments[info.callbackParameterIndex];
          const callbackResolution = callbackExpression
            ? stableCallableResolutionForExpression(callbackExpression, checker)
            : undefined;
          if (!call || !callbackResolution || call.arguments.some(ts.isSpreadElement)) {
            safe.delete(callable);
          } else {
            sawCall.add(callable);
            callbackUses.push({
              expression: unwrapExpression(callbackExpression),
              resolution: callbackResolution,
              wrapper: callable,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  for (const callable of safe.keys()) {
    if (!sawCall.has(callable)) safe.delete(callable);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const activeCallbackUses = callbackUses.filter((usage) => safe.has(usage.wrapper));
    const allowedExpressions = new Set(activeCallbackUses.map((usage) => usage.expression));
    const allowedSymbols = new Set(
      activeCallbackUses.flatMap((usage) => [...usage.resolution.symbols]),
    );
    for (const usage of callbackUses) {
      if (
        safe.has(usage.wrapper) &&
        !callbackBindingsAreExclusive(
          usage.resolution.symbols,
          files,
          checker,
          allowedExpressions,
          allowedSymbols,
        )
      ) {
        safe.delete(usage.wrapper);
        changed = true;
      }
    }
  }
  return safe;
}

function coordinatorCallback(call, checker, root, forwardedCoordinators = new Map()) {
  const callee = callableNodeForExpression(call.expression, checker);
  if (!callee) return undefined;
  const info = coordinatorInfoForCallable(callee, root, forwardedCoordinators);
  if (!info) return undefined;
  const expression = call.arguments[info.callbackParameterIndex];
  if (!expression) return undefined;
  const callback = callableNodeForExpression(expression, checker);
  return {
    callback,
    context: info.context,
    expression: unwrapExpression(expression),
  };
}

function indirectInvocation(call, checker) {
  const expression = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (expression.name.text !== 'call' && expression.name.text !== 'apply') return undefined;
  const targetExpression = unwrapExpression(expression.expression);
  const target = callableNodeForExpression(targetExpression, checker);
  return target ? { target, targetExpression } : undefined;
}

function namespaceModuleInfo(expression, checker, root) {
  const namespaceSymbol = unaliasSymbol(
    checker.getSymbolAtLocation(unwrapExpression(expression)),
    checker,
  );
  if (!namespaceSymbol || !(namespaceSymbol.flags & ts.SymbolFlags.Module)) return undefined;
  const exports = checker.getExportsOfModule(namespaceSymbol);
  const declaration = namespaceSymbol.declarations?.[0];
  const modulePath = declaration
    ? normalizePath(relative(root, declaration.getSourceFile().fileName))
    : '<unresolved-module>';
  return { exports, modulePath };
}

function dynamicNamespaceDispatch(call, checker, root) {
  const expression = unwrapExpression(call.expression);
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const module = namespaceModuleInfo(expression.expression, checker, root);
  if (!module) return undefined;
  const staticName =
    expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : undefined;
  const possibleCallees = module.exports
    .filter((symbol) => staticName === undefined || symbol.name === staticName)
    .map((symbol) => callableNodeFromSymbol(symbol, checker))
    .filter(Boolean);
  if (possibleCallees.length === 0) return undefined;
  return { modulePath: module.modulePath, possibleCallees, staticName };
}

function namespaceDestructuringReferences(node, checker, root, mutators) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    !node.initializer
  ) {
    return [];
  }
  const module = namespaceModuleInfo(node.initializer, checker, root);
  if (!module) return [];
  const references = [];
  for (const element of node.name.elements) {
    const property = element.propertyName ?? element.name;
    const staticName =
      ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
    const possibleCallees = module.exports
      .filter((symbol) => staticName === undefined || symbol.name === staticName)
      .map((symbol) => callableNodeFromSymbol(symbol, checker))
      .filter((callable) => callable && mutators.has(callable));
    if (possibleCallees.length === 1 && staticName !== undefined) {
      references.push({ node: element, target: possibleCallees[0] });
    } else if (possibleCallees.length > 0) {
      references.push({ node: element, target: `<dynamic:${module.modulePath}>` });
    }
  }
  return references;
}

function isDeclarationOrModuleAliasReference(node) {
  for (let current = node; current; current = current.parent) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return true;
    }
    if (ts.isStatement(current) || ts.isFunctionLike(current)) break;
  }
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    isConstVariableDeclaration(parent) &&
    parent.initializer &&
    unwrapExpression(parent.initializer) === node
  ) {
    return true;
  }
  return false;
}

function isDirectCallReference(node) {
  return ts.isCallExpression(node.parent) && unwrapExpression(node.parent.expression) === node;
}

function referenceExpression(node) {
  if (ts.isPropertyAccessExpression(node)) return node;
  if (!ts.isIdentifier(node)) return undefined;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return undefined;
  return node;
}

function isCompileTimeOnlyReference(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isFunctionLike(current)) return false;
  }
  return false;
}

function namedCallbackContexts(files, checker, callbackEdges) {
  const candidates = new Set(callbackEdges.map((edge) => edge.callee));
  const callbackContexts = new Map(
    callbackEdges.map((edge) => [edge.callbackExpression, edge.contextOverride]),
  );
  const usage = new Map(
    [...candidates].map((symbol) => [symbol, { contexts: new Set(), unsafe: false }]),
  );
  // Inline callbacks have no identifier reference for the traversal below to classify. Seed every
  // concrete callback edge directly; named callbacks still undergo the same whole-program escape
  // scan, which marks them unsafe if they are also invoked or stored anywhere else.
  for (const edge of callbackEdges) {
    usage.get(edge.callee)?.contexts.add(edge.contextOverride);
  }

  for (const file of files) {
    function visit(node) {
      const expression = referenceExpression(node);
      if (expression && !isDeclarationOrModuleAliasReference(expression)) {
        const callable = callableNodeForExpression(expression, checker);
        const state = callable ? usage.get(callable) : undefined;
        if (state) {
          const context = callbackContexts.get(expression);
          if (context) state.contexts.add(context);
          else state.unsafe = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const contexts = new Map();
  for (const [callable, state] of usage) {
    if (!state.unsafe && state.contexts.size === 1) {
      contexts.set(callable, [...state.contexts][0]);
    }
  }
  return contexts;
}

function scanMutatorCallSites({ root, files, findings }) {
  const program = runtimeProgram(root, files);
  const checker = program.getTypeChecker();
  const filesByPath = sourceFileMap(program, root, files);
  const runtimeFiles = [...filesByPath.values()];
  const forwardedCoordinators = forwardedCoordinatorInfos(runtimeFiles, checker, root);
  const registeredTransactionCallbacks = registeredTransactionCallbackInfo(
    runtimeFiles,
    checker,
    root,
  );
  const findingCallables = new Map();
  const directMutators = new Set();

  for (const finding of findings) {
    const file = filesByPath.get(finding.path);
    if (!file) continue;
    const callable = callableNodeForFinding(finding, file);
    if (!callable) continue;
    findingCallables.set(finding.id, callable);
    directMutators.add(callable);
  }

  const edges = [...registeredTransactionCallbacks.edges];
  const callbackEdges = [];
  const dynamicCallbacks = [];
  const dynamicDispatches = [];
  const indirectInvocationExpressions = new Set();
  for (const file of runtimeFiles) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const caller = enclosingCallableNode(node);
        const callee = callableNodeForExpression(node.expression, checker);
        if (callee) {
          edges.push({ caller, callee, node, file });
        }
        const indirect = indirectInvocation(node, checker);
        if (indirect) {
          edges.push({ caller, callee: indirect.target, node, file });
          indirectInvocationExpressions.add(indirect.targetExpression);
        }
        const dynamicDispatch = dynamicNamespaceDispatch(node, checker, root);
        if (dynamicDispatch) {
          if (dynamicDispatch.staticName && dynamicDispatch.possibleCallees.length === 1) {
            edges.push({
              caller,
              callee: dynamicDispatch.possibleCallees[0],
              node,
              file,
            });
          } else {
            dynamicDispatches.push({ caller, node, file, ...dynamicDispatch });
          }
        }
        const callback = coordinatorCallback(node, checker, root, forwardedCoordinators);
        if (callback) {
          if (callback.callback) {
            const edge = {
              caller,
              callee: callback.callback,
              node,
              file,
              callbackExpression: callback.expression,
              contextOverride: callback.context,
            };
            edges.push(edge);
            callbackEdges.push(edge);
          } else {
            dynamicCallbacks.push({
              caller,
              node,
              file,
              callbackExpression: callback.expression,
              contextOverride: callback.context,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  // These two public callback owners deliberately cross async tracking callbacks before reaching
  // the durable writer graph. Seed their exact declarations unconditionally so a broken ingress
  // certificate leaves visible unresolved findings instead of hiding the caller surface.
  const ingressRoots = incomingIngressRoots(filesByPath);
  const mutators = new Set([...directMutators, ...ingressRoots]);
  const coordinatorOpeners = new Set();
  for (const edge of edges) {
    if (coordinatorKindForCallable(edge.callee, root, forwardedCoordinators)) {
      mutators.add(edge.callee);
      coordinatorOpeners.add(edge.callee);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.caller && mutators.has(edge.callee) && !mutators.has(edge.caller)) {
        mutators.add(edge.caller);
        changed = true;
      }
    }
    for (const dispatch of dynamicDispatches) {
      if (
        dispatch.caller &&
        dispatch.possibleCallees.some((callee) => mutators.has(callee)) &&
        !mutators.has(dispatch.caller)
      ) {
        mutators.add(dispatch.caller);
        changed = true;
      }
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.caller &&
        coordinatorOpeners.has(edge.callee) &&
        !coordinatorOpeners.has(edge.caller)
      ) {
        coordinatorOpeners.add(edge.caller);
        changed = true;
      }
    }
    for (const dispatch of dynamicDispatches) {
      if (
        dispatch.caller &&
        dispatch.possibleCallees.some((callee) => coordinatorOpeners.has(callee)) &&
        !coordinatorOpeners.has(dispatch.caller)
      ) {
        coordinatorOpeners.add(dispatch.caller);
        changed = true;
      }
    }
  }

  const exclusiveCallbacks = namedCallbackContexts(runtimeFiles, checker, callbackEdges);
  function callableBodyContext(callable) {
    if (!callable) return undefined;
    const contexts = new Set();
    const registeredContext = registeredTransactionCallbacks.contexts.get(callable);
    const exclusiveContext = exclusiveCallbacks.get(callable);
    if (registeredContext) contexts.add(registeredContext);
    if (exclusiveContext) contexts.add(exclusiveContext);
    return contexts.size === 1 ? [...contexts][0] : undefined;
  }
  let contextualFindings = findings.map((finding) => {
    const context = callableBodyContext(findingCallables.get(finding.id));
    return finding.detectedContext === 'unresolved' && context
      ? { ...finding, detectedContext: context }
      : finding;
  });

  function callContext(
    node,
    file,
    targetCallable,
    contextOverride,
    possibleCoordinatorOpener = false,
  ) {
    const path = normalizePath(relative(root, file.fileName));
    const bindings = schemaBindings(file, path);
    const caller = enclosingCallableNode(node);
    const symbol = caller ? callableDisplayName(caller) : '<module>';
    const directCoordinator =
      typeof targetCallable === 'string'
        ? undefined
        : coordinatorKindForCallable(targetCallable, root, forwardedCoordinators);
    const opensCoordinator =
      possibleCoordinatorOpener ||
      (typeof targetCallable !== 'string' && coordinatorOpeners.has(targetCallable));
    let lexicalContext = detectedContext(node, path, symbol, bindings);
    if (lexicalContext === 'unresolved') {
      lexicalContext = callableBodyContext(caller) ?? lexicalContext;
    }
    const entersCoordinator =
      contextOverride === 'withDbTransaction' || contextOverride === 'withDbWriteLock';
    return opensCoordinator &&
      (entersCoordinator ||
        lexicalContext === 'withDbTransaction' ||
        lexicalContext === 'withDbWriteLock')
      ? 'nested-coordinator'
      : contextOverride
        ? contextOverride
        : directCoordinator
          ? 'transaction-coordinator'
          : lexicalContext;
  }

  // A resolved reference to a self-owning writer is safe to invoke later; a dynamic or unsafe
  // reference is not. Ignore compile-time-only type queries because they disappear from runtime.
  const referenceEdges = [];
  const callbackExpressions = new Set(callbackEdges.map((edge) => edge.callbackExpression));
  for (const file of runtimeFiles) {
    function visit(node) {
      for (const reference of namespaceDestructuringReferences(node, checker, root, mutators)) {
        referenceEdges.push({
          caller: enclosingCallableNode(reference.node),
          node: reference.node,
          file,
          target: reference.target,
        });
      }
      const expression = referenceExpression(node);
      if (
        expression &&
        !isCompileTimeOnlyReference(expression) &&
        !isDeclarationOrModuleAliasReference(expression) &&
        !isDirectCallReference(expression) &&
        !callbackExpressions.has(expression) &&
        !indirectInvocationExpressions.has(expression)
      ) {
        const callable = callableNodeForExpression(expression, checker);
        if (callable && mutators.has(callable)) {
          referenceEdges.push({
            caller: enclosingCallableNode(expression),
            node: expression,
            file,
            target: callable,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const processRelaunchCandidate = dbProcessRelaunchCertificateCandidate({
    filesByPath,
    checker,
    edges,
    referenceEdges,
    dynamicCallbacks,
    dynamicDispatches,
    findings: contextualFindings,
    findingCallables,
  });
  const driverSelfTestCandidate = driverSelfTestCertificateCandidate({
    filesByPath,
    checker,
    edges,
    referenceEdges,
    dynamicCallbacks,
    dynamicDispatches,
    findings: contextualFindings,
    findingCallables,
    processRelaunchCandidate,
  });
  const startupSingleFlightTargets = startupSingleFlightDelegationTargets({
    filesByPath,
    checker,
    edges,
    mutators,
    dynamicCallbacks,
    dynamicDispatches,
    referenceEdges,
    findings,
    findingCallables,
    driverSelfTestCandidate,
    processRelaunchCandidate,
  });
  contextualFindings = contextualFindings.map((finding) => {
    const callable = findingCallables.get(finding.id);
    return finding.detectedContext === 'startup-initialization' &&
      !startupSingleFlightTargets.has(callable)
      ? { ...finding, detectedContext: 'unresolved' }
      : finding;
  });

  const driverAdapterCallables = driverAdapterCertifiedCallables({
    root,
    filesByPath,
    checker,
    edges,
    findings: contextualFindings,
    findingCallables,
    startupSingleFlightTargets,
    driverSelfTestCandidate,
    processRelaunchCandidate,
  });
  contextualFindings = contextualFindings.map((finding) => {
    if (driverAdapterCallables.throwawayFindingIds.has(finding.id)) {
      return { ...finding, detectedContext: 'throwaway-database' };
    }
    if (finding.detectedContext !== 'driver-adapter') return finding;
    const callable = findingCallables.get(finding.id);
    return driverAdapterCallables.temporal.has(callable)
      ? { ...finding, detectedContext: 'startup-migration-adapter' }
      : driverAdapterCallables.coordinated.has(callable)
        ? { ...finding, detectedContext: 'runtime-drizzle-adapter' }
        : finding;
  });

  const foregroundBootComposition = foregroundBootCompositionCandidate(
    root,
    filesByPath,
    checker,
    edges,
    dynamicDispatches,
  );
  const foregroundBootLifecycleNodes = foregroundBootLifecycleDelegationNodes({
    root,
    filesByPath,
    checker,
    edges,
    referenceEdges,
    dynamicCallbacks,
    dynamicDispatches,
    foregroundBootComposition,
    mutators,
    findings: contextualFindings,
    findingCallables,
    driverSelfTestCandidate,
    driverAdapterCallables,
    processRelaunchCandidate,
  });

  /**
   * Prove self-owning mutation targets by propagating every unsafe leaf backward through the
   * existing whole-program graph. Starting with negative evidence is important for recursive
   * lifecycle code: a safe `kick` cycle remains safe, while one unresolved SQL leaf taints every
   * caller that can reach it. This computes eligibility only; findings outside the exact path set
   * below remain unresolved.
   */
  const unsafeDelegationTargets = new Set();
  function markUnsafeWithEnclosingCallables(callable) {
    for (let current = callable; current; current = enclosingCallableNode(current)) {
      unsafeDelegationTargets.add(current);
    }
  }
  for (const finding of contextualFindings) {
    const callable = findingCallables.get(finding.id);
    if (callable && !DIRECT_COORDINATED_CONTEXTS.has(finding.detectedContext)) {
      // A raw write in a timer/promise/native callback also makes its enclosing lifecycle method
      // unsafe, even when the external scheduler has no statically resolvable callback contract.
      markUnsafeWithEnclosingCallables(callable);
    }
  }
  for (const callback of dynamicCallbacks) {
    if (callback.caller) markUnsafeWithEnclosingCallables(callback.caller);
  }
  for (const dispatch of dynamicDispatches) {
    if (dispatch.caller && dispatch.possibleCallees.some((callee) => mutators.has(callee))) {
      markUnsafeWithEnclosingCallables(dispatch.caller);
    }
  }
  for (const reference of referenceEdges) {
    if (reference.caller && typeof reference.target === 'string') {
      markUnsafeWithEnclosingCallables(reference.caller);
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!edge.caller || !mutators.has(edge.callee)) continue;
      const context = callContext(edge.node, edge.file, edge.callee, edge.contextOverride);
      if (
        !DIRECT_COORDINATED_CONTEXTS.has(context) &&
        !startupSingleFlightTargets.has(edge.callee) &&
        !foregroundBootLifecycleNodes.temporal.has(edge.node) &&
        (context !== 'unresolved' || unsafeDelegationTargets.has(edge.callee)) &&
        !unsafeDelegationTargets.has(edge.caller)
      ) {
        const sizeBefore = unsafeDelegationTargets.size;
        markUnsafeWithEnclosingCallables(edge.caller);
        changed = unsafeDelegationTargets.size !== sizeBefore || changed;
      }
    }
    for (const reference of referenceEdges) {
      if (
        reference.caller &&
        typeof reference.target !== 'string' &&
        unsafeDelegationTargets.has(reference.target) &&
        !unsafeDelegationTargets.has(reference.caller)
      ) {
        const sizeBefore = unsafeDelegationTargets.size;
        markUnsafeWithEnclosingCallables(reference.caller);
        changed = unsafeDelegationTargets.size !== sizeBefore || changed;
      }
    }
  }
  const coordinatedDelegationTargets = new Set(
    [...mutators].filter((callable) => !unsafeDelegationTargets.has(callable)),
  );
  const incomingIngressNodes = incomingIngressCertifiedNodes({
    root,
    program,
    filesByPath,
    checker,
    edges,
    referenceEdges,
    dynamicCallbacks,
    dynamicDispatches,
    foregroundBootComposition,
    mutators,
    findings: contextualFindings,
    findingCallables,
  });
  const errorReportLifecycleNodes = errorReportLifecycleDelegationNodes({ root, edges });
  const notificationEffectLifecycleNodes = notificationEffectLifecycleDelegationNodes({
    root,
    edges,
  });
  const accountTransitionNodes = accountTransitionDelegationNodes({ root, edges, referenceEdges });

  const callFindings = [];
  const duplicateIds = new Map();
  function record(
    node,
    file,
    operation,
    targetCallable,
    contextOverride,
    possibleCoordinatorOpener = false,
  ) {
    const path = normalizePath(relative(root, file.fileName));
    const caller = enclosingCallableNode(node);
    const symbol = caller ? callableDisplayName(caller) : '<module>';
    const baseContext = callContext(
      node,
      file,
      targetCallable,
      contextOverride,
      possibleCoordinatorOpener,
    );
    const certifiedBaseContext = driverAdapterCallables.throwawayCallNodes.has(node)
      ? 'throwaway-database'
      : baseContext === 'startup-initialization' && !startupSingleFlightTargets.has(caller)
        ? 'unresolved'
        : baseContext;
    const context = driverAdapterCallables.throwawayDelegationCallNodes.has(node)
      ? 'throwaway-database-delegation'
      : certifiedBaseContext === 'unresolved' &&
          typeof targetCallable !== 'string' &&
          startupSingleFlightTargets.has(targetCallable)
        ? 'startup-single-flight-delegation'
        : certifiedBaseContext === 'unresolved' &&
            typeof targetCallable !== 'string' &&
            incomingIngressNodes.has(node) &&
            coordinatedDelegationTargets.has(targetCallable) &&
            (operation === 'mutator-reference' || !caller || !unsafeDelegationTargets.has(caller))
          ? 'incoming-ingress-delegation'
          : certifiedBaseContext === 'unresolved' &&
              typeof targetCallable !== 'string' &&
              errorReportLifecycleNodes.has(node) &&
              coordinatedDelegationTargets.has(targetCallable)
            ? 'error-report-lifecycle-delegation'
            : certifiedBaseContext === 'unresolved' &&
                typeof targetCallable !== 'string' &&
                notificationEffectLifecycleNodes.has(node) &&
                coordinatedDelegationTargets.has(targetCallable)
              ? 'notification-effect-lifecycle-delegation'
              : certifiedBaseContext === 'unresolved' &&
                  typeof targetCallable !== 'string' &&
                  accountTransitionNodes.has(node) &&
                  (operation === 'mutator-reference' ||
                    coordinatedDelegationTargets.has(targetCallable))
                ? 'account-transition-delegation'
                : certifiedBaseContext === 'unresolved' &&
                    typeof targetCallable !== 'string' &&
                    foregroundBootLifecycleNodes.temporal.has(node)
                  ? 'throwaway-database-delegation'
                  : certifiedBaseContext === 'unresolved' &&
                      typeof targetCallable !== 'string' &&
                      foregroundBootLifecycleNodes.coordinated.has(node) &&
                      coordinatedDelegationTargets.has(targetCallable) &&
                      (operation === 'mutator-reference' ||
                        !caller ||
                        !unsafeDelegationTargets.has(caller))
                    ? 'foreground-boot-lifecycle-delegation'
                    : certifiedBaseContext === 'unresolved' &&
                        COORDINATED_DELEGATION_PATHS.has(path) &&
                        !unsafeDelegationTargets.has(caller) &&
                        typeof targetCallable !== 'string' &&
                        coordinatedDelegationTargets.has(targetCallable)
                      ? 'coordinated-delegation'
                      : certifiedBaseContext;
    const target =
      typeof targetCallable === 'string'
        ? targetCallable
        : callableDescriptor(targetCallable, root);
    const snippet = normalizedSnippet(node, file);
    const baseId = findingId(path, symbol, operation, target, snippet);
    const occurrence = (duplicateIds.get(baseId) ?? 0) + 1;
    duplicateIds.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}:${occurrence}`;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    callFindings.push({
      id,
      path,
      line: line + 1,
      symbol,
      operation,
      target,
      detectedContext: context,
      snippet,
    });
  }

  for (const edge of edges) {
    if (mutators.has(edge.callee) && !edge.suppressFinding) {
      record(edge.node, edge.file, 'mutator-call', edge.callee, edge.contextOverride);
    }
  }

  for (const callback of dynamicCallbacks) {
    record(
      callback.node,
      callback.file,
      'dynamic-coordinator-callback',
      '<unresolved-callback>',
      'unresolved',
    );
  }

  for (const dispatch of dynamicDispatches) {
    if (dispatch.possibleCallees.some((callee) => mutators.has(callee))) {
      const possibleCoordinatorOpener = dispatch.possibleCallees.some((callee) =>
        coordinatorOpeners.has(callee),
      );
      record(
        dispatch.node,
        dispatch.file,
        'dynamic-mutator-call',
        `<dynamic:${dispatch.modulePath}>`,
        undefined,
        possibleCoordinatorOpener,
      );
    }
  }

  for (const reference of referenceEdges) {
    record(reference.node, reference.file, 'mutator-reference', reference.target);
  }

  return [...contextualFindings, ...callFindings].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.id.localeCompare(b.id),
  );
}

export function scanDbWrites({ root = process.cwd() } = {}) {
  const files = SOURCE_DIRECTORIES.flatMap((directory) =>
    sourceFiles(resolve(root, directory)),
  ).sort();
  const nativeFiles = nativeSourceFiles(resolve(root, 'modules')).sort();
  const directFindings = files.flatMap((file) =>
    scanDbWritesInSource(readFileSync(file, 'utf8'), normalizePath(relative(root, file))),
  );
  return [
    ...scanMutatorCallSites({ root, files, findings: directFindings }),
    ...nativeFiles.flatMap((file) =>
      scanNativeDbWritesInSource(readFileSync(file, 'utf8'), normalizePath(relative(root, file))),
    ),
  ].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.id.localeCompare(b.id));
}

export function createInventorySkeleton(findings) {
  return {
    version: 1,
    entries: findings.map(
      ({ id, path, line, symbol, operation, target, detectedContext: context }) => ({
        id,
        path,
        line,
        symbol,
        operation,
        target,
        detectedContext: context,
        owner: 'UNASSIGNED',
        transactionContext: 'unreviewed',
        disposition: 'unproven',
        evidence: '',
      }),
    ),
  };
}

const INVENTORY_SCANNER_FIELDS = ['path', 'symbol', 'operation', 'target', 'detectedContext'];

function normalizedCallbackIdentity(value) {
  return typeof value === 'string'
    ? value.replace(/<callback:[0-9a-f]{10}>/g, '<callback>')
    : value;
}

function reconciliationIdentity(entry) {
  return JSON.stringify([
    entry.path,
    normalizedCallbackIdentity(entry.symbol),
    entry.operation,
    normalizedCallbackIdentity(entry.target),
    entry.detectedContext,
  ]);
}

function groupByReconciliationIdentity(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = reconciliationIdentity(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function assertUniqueEntries(entries, label) {
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      throw new Error(`${label} contains an entry without a string id`);
    }
    if (ids.has(entry.id)) throw new Error(`${label} contains duplicate id: ${entry.id}`);
    ids.add(entry.id);
  }
}

/**
 * Reconcile scanner-owned identity and location fields without changing reviewed metadata.
 *
 * A changed id is carried forward only when a single old and live finding differ solely through
 * anonymous callback fingerprints. Recomputing the old id with the live snippet proves that the
 * write expression itself did not change. Everything ambiguous fails before a candidate is
 * returned; genuinely new findings receive the same unproven defaults as a skeleton inventory.
 */
export function reconcileDbWriteInventory({ findings, inventory }) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  if (!inventory || inventory.version !== 1 || !Array.isArray(inventory.entries)) {
    throw new Error('inventory must be an object with version 1 and an entries array');
  }
  assertUniqueEntries(findings, 'findings');
  assertUniqueEntries(inventory.entries, 'inventory');
  for (const entry of inventory.entries) {
    if (!DB_WRITE_DISPOSITIONS.includes(entry.disposition)) {
      throw new Error(`${entry.id} has invalid disposition: ${String(entry.disposition)}`);
    }
  }

  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  for (const entry of inventory.entries) {
    const finding = findingsById.get(entry.id);
    if (!finding) continue;
    for (const field of INVENTORY_SCANNER_FIELDS) {
      if (entry[field] !== finding[field]) {
        throw new Error(
          `${entry.id} has non-line drift in ${field}: expected ${String(finding[field])}`,
        );
      }
    }
  }

  const inventoryGroups = groupByReconciliationIdentity(inventory.entries);
  const findingGroups = groupByReconciliationIdentity(findings);
  const reconciledById = new Map();
  const lineShifts = [];
  const rekeys = [];
  const additions = [];
  const allKeys = new Set([...inventoryGroups.keys(), ...findingGroups.keys()]);

  for (const key of [...allKeys].sort()) {
    const oldEntries = inventoryGroups.get(key) ?? [];
    const liveFindings = findingGroups.get(key) ?? [];
    if (oldEntries.length === 0) {
      for (const entry of createInventorySkeleton(liveFindings).entries) {
        reconciledById.set(entry.id, entry);
        additions.push({ id: entry.id, line: entry.line });
      }
      continue;
    }
    if (liveFindings.length === 0) {
      throw new Error(`stale inventory entry has no live finding: ${oldEntries[0].id}`);
    }
    if (oldEntries.length !== liveFindings.length) {
      throw new Error(
        `ambiguous reconciliation cardinality for ${key}: inventory=${oldEntries.length} live=${liveFindings.length}`,
      );
    }

    if (oldEntries.length > 1) {
      const liveById = new Map(liveFindings.map((finding) => [finding.id, finding]));
      for (const entry of oldEntries) {
        const finding = liveById.get(entry.id);
        if (!finding) throw new Error(`ambiguous many-to-many rekey for ${key}`);
        const reconciled = { ...entry, line: finding.line };
        reconciledById.set(finding.id, reconciled);
        if (entry.line !== finding.line) {
          lineShifts.push({ id: entry.id, from: entry.line, to: finding.line });
        }
      }
      continue;
    }

    const entry = oldEntries[0];
    const finding = liveFindings[0];
    if (entry.id === finding.id) {
      reconciledById.set(finding.id, { ...entry, line: finding.line });
      if (entry.line !== finding.line) {
        lineShifts.push({ id: entry.id, from: entry.line, to: finding.line });
      }
      continue;
    }

    if (entry.symbol === finding.symbol && entry.target === finding.target) {
      throw new Error(`unsafe rekey changed the write expression: ${entry.id} -> ${finding.id}`);
    }
    if (typeof finding.snippet !== 'string') {
      throw new Error(`unsafe rekey has no live snippet: ${entry.id} -> ${finding.id}`);
    }
    const expectedOldId = findingId(
      entry.path,
      entry.symbol,
      entry.operation,
      entry.target,
      finding.snippet,
    );
    const expectedLiveId = findingId(
      finding.path,
      finding.symbol,
      finding.operation,
      finding.target,
      finding.snippet,
    );
    if (entry.id !== expectedOldId || finding.id !== expectedLiveId) {
      throw new Error(
        `unsafe rekey could not prove an unchanged snippet: ${entry.id} -> ${finding.id}`,
      );
    }

    reconciledById.set(finding.id, {
      ...entry,
      id: finding.id,
      path: finding.path,
      line: finding.line,
      symbol: finding.symbol,
      operation: finding.operation,
      target: finding.target,
      detectedContext: finding.detectedContext,
    });
    rekeys.push({ from: entry.id, to: finding.id, line: finding.line });
  }

  const entries = findings.map((finding) => reconciledById.get(finding.id));
  if (entries.some((entry) => !entry)) {
    throw new Error('reconciliation did not account for every live finding');
  }
  const candidate = { ...inventory, entries };
  const errors = validateDbWriteInventory({
    findings,
    inventory: candidate,
    requireApproved: false,
  });
  if (errors.length > 0) {
    throw new Error(
      `reconciled inventory is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  return { inventory: candidate, lineShifts, rekeys, additions };
}

export function validateDbWriteInventory({ findings, inventory, requireApproved = true }) {
  const errors = [];
  if (!inventory || inventory.version !== 1 || !Array.isArray(inventory.entries)) {
    return ['inventory must be an object with version 1 and an entries array'];
  }

  const actualById = new Map(findings.map((finding) => [finding.id, finding]));
  const inventoryById = new Map();
  for (const entry of inventory.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      errors.push('inventory contains an entry without a string id');
      continue;
    }
    if (inventoryById.has(entry.id)) {
      errors.push(`inventory contains duplicate id: ${entry.id}`);
      continue;
    }
    inventoryById.set(entry.id, entry);
    if (!DB_WRITE_DISPOSITIONS.includes(entry.disposition)) {
      errors.push(`${entry.id} has invalid disposition: ${String(entry.disposition)}`);
    }
  }

  for (const finding of findings) {
    const entry = inventoryById.get(finding.id);
    if (!entry) {
      errors.push(
        `unapproved database write: ${finding.path}:${finding.line} ${finding.operation}`,
      );
      continue;
    }
    for (const field of ['path', 'line', 'symbol', 'operation', 'target', 'detectedContext']) {
      if (entry[field] !== finding[field]) {
        errors.push(`${finding.id} has stale ${field}: expected ${String(finding[field])}`);
      }
    }
    if (!requireApproved) continue;
    if (!entry.owner || entry.owner === 'UNASSIGNED') {
      errors.push(`${finding.id} has no named owner`);
    }
    if (!entry.transactionContext || entry.transactionContext === 'unreviewed') {
      errors.push(`${finding.id} has no reviewed transaction context`);
    }
    if (entry.disposition === 'unproven') {
      errors.push(`${finding.id} has an unproven transaction disposition`);
    } else {
      if (entry.transactionContext !== finding.detectedContext) {
        errors.push(`${finding.id} transaction context does not match detected context`);
      }
      if (
        entry.disposition === 'coordinated' &&
        !COORDINATED_CONTEXTS.has(finding.detectedContext)
      ) {
        errors.push(`${finding.id} does not have a detected coordinator`);
      }
      if (
        entry.disposition === 'proven-temporal-exclusion' &&
        !TEMPORAL_EXCLUSION_CONTEXTS.has(finding.detectedContext)
      ) {
        errors.push(`${finding.id} does not have a detected temporal-exclusion context`);
      }
      if (!entry.evidence) errors.push(`${finding.id} has no evidence for ${entry.disposition}`);
    }
  }

  for (const entry of inventory.entries) {
    if (entry?.id && !actualById.has(entry.id)) errors.push(`stale inventory entry: ${entry.id}`);
  }
  return errors.sort();
}

function readInventory(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function reportLines(findings, inventory) {
  const inventoryById = new Map((inventory?.entries ?? []).map((entry) => [entry.id, entry]));
  return findings.map((finding) => {
    const entry = inventoryById.get(finding.id);
    const state = entry?.disposition ?? 'missing';
    return `${state.padEnd(27)} ${finding.path}:${finding.line} ${finding.symbol} ${finding.operation} ${finding.target} [${finding.detectedContext}]`;
  });
}

export function runDbWriteInventory({
  root = process.cwd(),
  inventoryPath = resolve(root, INVENTORY_PATH),
  requireApproved = true,
} = {}) {
  const findings = scanDbWrites({ root });
  const inventory = readInventory(inventoryPath);
  const errors = validateDbWriteInventory({ findings, inventory, requireApproved });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { findings, inventory };
}

export function parseDbWriteCliArgs(args) {
  if (!Array.isArray(args)) throw new Error('CLI arguments must be an array');
  const allowed = new Set(['--report', '--check', '--skeleton', '--reconcile', '--write']);
  const flags = new Set();
  for (const argument of args) {
    if (!allowed.has(argument)) throw new Error(`unknown argument: ${String(argument)}`);
    if (flags.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    flags.add(argument);
  }
  const modes = ['--report', '--check', '--skeleton', '--reconcile'].filter((mode) =>
    flags.has(mode),
  );
  if (modes.length > 1) throw new Error(`conflicting modes: ${modes.join(', ')}`);
  if (flags.has('--write') && !flags.has('--reconcile')) {
    throw new Error('--write requires --reconcile');
  }
  return {
    mode: modes[0]?.slice(2) ?? 'report',
    write: flags.has('--write'),
  };
}

function reconciliationReportLines({ lineShifts, rekeys, additions }) {
  return [
    `DB write inventory reconciliation: ${lineShifts.length} line shifts; ${rekeys.length} rekeys; ${additions.length} additions.`,
    ...lineShifts.map((change) => `line  ${change.id} ${change.from} -> ${change.to}`),
    ...rekeys.map((change) => `rekey ${change.from} -> ${change.to}`),
    ...additions.map((change) => `add   ${change.id} at line ${change.line}`),
  ];
}

export function writeDbWriteInventoryAtomically(path, inventory) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const cli = parseDbWriteCliArgs(process.argv.slice(2));
    const findings = scanDbWrites();
    if (cli.mode === 'skeleton') {
      console.log(JSON.stringify(createInventorySkeleton(findings), null, 2));
    } else {
      const inventory = readInventory(resolve(INVENTORY_PATH));
      if (cli.mode === 'check') {
        const errors = validateDbWriteInventory({ findings, inventory, requireApproved: true });
        if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
        console.log(`DB write inventory guard passed: ${findings.length} approved mutations.`);
      } else if (cli.mode === 'reconcile') {
        const result = reconcileDbWriteInventory({ findings, inventory });
        console.log(reconciliationReportLines(result).join('\n'));
        const changeCount =
          result.lineShifts.length + result.rekeys.length + result.additions.length;
        if (!cli.write) {
          console.log('Dry run only; rerun with --reconcile --write to update the inventory.');
        } else if (changeCount === 0) {
          console.log('DB write inventory is already current; no file was written.');
        } else {
          writeDbWriteInventoryAtomically(resolve(INVENTORY_PATH), result.inventory);
          console.log(`DB write inventory updated atomically: ${INVENTORY_PATH}`);
        }
      } else {
        console.log(reportLines(findings, inventory).join('\n'));
        const errors = validateDbWriteInventory({
          findings,
          inventory,
          requireApproved: false,
        });
        console.log(
          `DB write inventory report: ${findings.length} mutations; ${errors.length} structural/membership errors.`,
        );
      }
    }
  } catch (error) {
    console.error(
      `DB write inventory failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
