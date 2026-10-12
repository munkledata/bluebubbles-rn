/**
 * Review item 1073: a request made inside a tracked account slot must use `accountHttp(lease)`, so
 * Disconnect cancels it instead of waiting for its timeout. This scans the app and reports:
 * - the shared client (imported from the clients module or the services barrel, under any local
 *   name, or through a one-level `const alias = http`) used inside a tracked-slot call, or handed to
 *   a function that opens its own slot;
 * - a fixed-credential client created inside a slot without `.withCancellation(...)`.
 * Names are resolved with the TypeScript checker, so a parameter or local that happens to be called
 * `http` (for example the background task's own client) is not counted. Not followed: closures
 * defined outside a slot and called inside it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.join(__dirname, '../..');
/** Calls whose callback runs inside an admitted account slot. */
const TRACKED_SLOTS = [
  'runUiAccountOperation',
  'runScheduledAccountOperation',
  'runTrackedRealtimeWork',
  'runTrackedRealtimeDelivery',
  'runChatAction',
  'runAccountScopedLocalMutation',
  'runMediaAccountTask',
  'runThemeCommand',
  'runReminderAccountOperation',
  'runContactDbTask',
  'runTrackedDownloadWork',
  'runAccountCommit',
  'runCredentialUpgrade',
];
/** Functions that open a slot themselves and use the client they are handed inside it. */
const SLOT_OPENING_CALLS = ['runOutgoingQueue', 'resendOutgoingRow', 'runErrorReportQueue'];
const FIXED_CREDENTIAL_FACTORIES = new Set(['fixedCredentialClient', 'candidateClient']);
const SHARED_CLIENT_MODULE =
  /(^|\/)clients$|^@\/services(\/index)?$|^@services(\/index)?$|^(\.\.?\/)+services(\/index)?$/;

// Known open sites, each with its reason. Remove entries as they are fixed; this list may only shrink.
const OPEN_SITES: Record<string, number> = {
  // Already cancellable another way: the flush passes its own upload AbortController signal, which
  // it aborts when Disconnect retires the account generation.
  'src/services/errors/index.ts (shared client)': 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [rel] : [];
  });
}

function uncancellableClientsInSlots(): Record<string, number> {
  const slotCall = new RegExp(
    `\\b(${[...TRACKED_SLOTS, ...SLOT_OPENING_CALLS].join('|')})\\s*[<(]`,
  );
  const candidates = [...sourceFiles('src'), ...sourceFiles('app')].filter((rel) => {
    if (rel.startsWith('src/core/')) return false;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    return /\bhttp\b|Client\b/.test(text) && slotCall.test(text);
  });
  const program = ts.createProgram(
    candidates.map((rel) => path.join(ROOT, rel)),
    { noResolve: true, noEmit: true, jsx: ts.JsxEmit.Preserve, types: [] },
  );
  const checker = program.getTypeChecker();
  const counts: Record<string, number> = {};
  const count = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  for (const rel of candidates) {
    const file = program.getSourceFile(path.join(ROOT, rel));
    if (!file) throw new Error(`could not parse ${rel}`);
    const aliases = new Set<ts.Symbol>();
    // One-level aliases such as `const client = http` or `const client = clientsAlias`.
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        isSharedClient(node.initializer)
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) aliases.add(symbol);
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(file);

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isReference(node) && (isSharedClient(node) || isAlias(node))) {
        if (insideSlot(node)) count(`${rel} (shared client)`);
      }
      if (isUncancellableFixedClient(node) && insideSlot(node)) {
        count(`${rel} (fixed-credential client)`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    function isAlias(node: ts.Identifier): boolean {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol !== undefined && aliases.has(symbol);
    }
  }
  return counts;

  function isReference(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isVariableDeclaration(parent)) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    return true;
  }

  function isSharedClient(node: ts.Identifier): boolean {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration)) return false;
    if ((declaration.propertyName ?? declaration.name).text !== 'http') return false;
    const moduleSpecifier = declaration.parent.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(moduleSpecifier) && SHARED_CLIENT_MODULE.test(moduleSpecifier.text);
  }

  function isUncancellableFixedClient(node: ts.Node): boolean {
    const created =
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        FIXED_CREDENTIAL_FACTORIES.has(node.expression.text)) ||
      (ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'HttpClient');
    if (!created) return false;
    const parent = node.parent;
    return !(
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === 'withCancellation'
    );
  }

  function insideSlot(node: ts.Node): boolean {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) continue;
      const name = parent.expression.text;
      if (TRACKED_SLOTS.includes(name)) return true;
      if (
        SLOT_OPENING_CALLS.includes(name) &&
        parent.arguments.some((arg) => contains(arg, node))
      ) {
        return true;
      }
    }
    return false;
  }

  function contains(outer: ts.Node, inner: ts.Node): boolean {
    return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
  }
}

describe('account requests inside tracked slots', () => {
  it('use the Disconnect-cancellable client everywhere except the known open sites', () => {
    expect(uncancellableClientsInSlots()).toEqual(OPEN_SITES);
  });
});
