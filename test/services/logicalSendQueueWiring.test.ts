import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push(path.relative(PROJECT_ROOT, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(path.join(PROJECT_ROOT, root));
  return files;
}

const productionFiles = [...productionTypeScriptFiles('app'), ...productionTypeScriptFiles('src')];

function filesCalling(symbol: string): string[] {
  return productionFiles
    .filter((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(PROJECT_ROOT, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      let found = false;
      const visit = (node: ts.Node): void => {
        const calledName = ts.isCallExpression(node)
          ? ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : null
          : null;
        if (calledName === symbol) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    })
    .sort();
}

describe('logical send queue production wiring', () => {
  it('keeps every low-level user send behind an approved queue owner or durable scheduler', () => {
    expect(filesCalling('sendTextMessage')).toEqual([
      'src/services/notifications/actions.ts',
      'src/services/send/index.ts',
      'src/services/send/scheduleService.ts',
    ]);
    // The first caller is a scanner-certified fixed-file DEV harness that runs exclusively before
    // ordinary boot. It never receives user data or the production database; the second is the
    // sole production send owner.
    expect(filesCalling('sendImageMessage')).toEqual([
      'src/services/boot/dbRuntimeConcurrencyWave.ts',
      'src/services/send/index.ts',
    ]);
    expect(filesCalling('sendContactMessage')).toEqual(['src/services/send/index.ts']);
    expect(filesCalling('sendReactionMessage')).toEqual([
      'src/services/notifications/actions.ts',
      'src/services/send/index.ts',
    ]);
  });

  it('keeps new-chat creation as the sole explicit initial-message bypass', () => {
    // `/chat/new` atomically creates/deduplicates the thread and its first message before a chat
    // guid exists. It is intentionally outside the existing-chat FIFO; follow-up attachments use
    // `sendImages` and are covered above.
    expect(filesCalling('createChat')).toEqual(['src/services/chatActions.ts']);
  });
});
