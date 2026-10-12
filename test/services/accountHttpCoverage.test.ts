/**
 * Review item 1073: a request made inside a tracked account slot must use `accountHttp(lease)`, so
 * Disconnect cancels it instead of waiting for its timeout. This scans the app for the shared
 * client (imported from the clients module or the services barrel) used inside a tracked-slot call.
 * Names are resolved with the TypeScript checker, so a parameter or local that happens to be called
 * `http` (for example the background task's own client) is not counted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.join(__dirname, '../..');
const TRACKED_SLOTS = new Set([
  'runUiAccountOperation',
  'runScheduledAccountOperation',
  'runTrackedRealtimeWork',
  'runTrackedRealtimeDelivery',
  'runChatAction',
  'runAccountScopedLocalMutation',
]);
const SHARED_CLIENT_MODULE = /(^|\/)clients$|^@\/services$|^@services$/;
// Still open: FCM registration is hash-pinned by the incoming-ingress proof and moves in its own
// reviewed change. Remove entries as they are fixed; this list may only shrink.
const OPEN_SITES: Record<string, number> = {
  'src/services/notifications/fcmMessaging.ts': 5,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [rel] : [];
  });
}

function sharedClientUsesInTrackedSlots(): Record<string, number> {
  const candidates = [...sourceFiles('src'), ...sourceFiles('app')].filter((rel) => {
    if (rel.startsWith('src/core/')) return false;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    return /\bhttp\b/.test(text) && [...TRACKED_SLOTS].some((name) => text.includes(`${name}(`));
  });
  const program = ts.createProgram(
    candidates.map((rel) => path.join(ROOT, rel)),
    { noResolve: true, noEmit: true, jsx: ts.JsxEmit.Preserve, types: [] },
  );
  const checker = program.getTypeChecker();
  const counts: Record<string, number> = {};
  for (const rel of candidates) {
    const file = program.getSourceFile(path.join(ROOT, rel));
    if (!file) throw new Error(`could not parse ${rel}`);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'http' && refersToSharedClient(node)) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            TRACKED_SLOTS.has(parent.expression.text)
          ) {
            counts[rel] = (counts[rel] ?? 0) + 1;
            break;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return counts;

  function refersToSharedClient(node: ts.Identifier): boolean {
    if (ts.isImportSpecifier(node.parent)) return false;
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return false;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return false;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration)) return false;
    const moduleSpecifier = declaration.parent.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(moduleSpecifier) && SHARED_CLIENT_MODULE.test(moduleSpecifier.text);
  }
}

describe('account requests inside tracked slots', () => {
  it('use the Disconnect-cancellable client everywhere except the known open sites', () => {
    expect(sharedClientUsesInTrackedSlots()).toEqual(OPEN_SITES);
  });
});
