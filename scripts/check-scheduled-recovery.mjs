#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { scanDbWrites } from './check-db-writes.mjs';

const SCHEDULE_SERVICE_PATH = 'src/services/send/scheduleService.ts';
const SEND_SERVICE_PATH = 'src/services/send/sendService.ts';
const RESET_TARGET = 'src/db/repositories/scheduled.ts#resetStuckScheduled';
const CLAIM_TARGET = 'src/db/repositories/scheduled.ts#claimDueScheduled';
const BROAD_CLAIM_TARGET = 'src/db/repositories/scheduled.ts#claimScheduled';
const HANDOFF_TARGET = 'src/db/repositories/scheduled.ts#handoverScheduledTextToOutgoing';
const REVIEWED_RUN_DUE_BODY_HASH =
  '0102dd9c1bff60acd05562d68299fd5f3245f0775b0f909e0edf9031e0c352c0';
const REVIEWED_SEND_TEXT_BODY_HASH =
  '381feddb3727d7c9cca209c170c07cbfa06ae206fe48cd314c1d3730e4d1a482';
const EXPECTED_RUN_DUE_CALLERS = new Map([
  ['app/(app)/home.tsx', { argumentCount: 5, scope: 'accountLease' }],
  ['app/(app)/chat/[guid].tsx', { argumentCount: 5, scope: 'accountLease' }],
  ['src/services/send/index.ts', { argumentCount: 5, scope: 'accountLease' }],
  ['src/services/background/backgroundSync.ts', { argumentCount: 6, scope: 'lease' }],
]);

function directCallName(node) {
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

function callsNamed(node, names) {
  const calls = [];
  function visit(candidate) {
    if (ts.isCallExpression(candidate) && names.has(directCallName(candidate))) {
      calls.push(candidate);
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return calls;
}

function exportedFunction(sourceFile, name) {
  const matches = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (matches.length !== 1) return { matches, declaration: undefined };
  const declaration = matches[0];
  const exported = declaration.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  return { matches, declaration: exported ? declaration : undefined };
}

function functionBodyHash(declaration, sourceFile) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const normalized = printer.printNode(ts.EmitHint.Unspecified, declaration.body, sourceFile);
  return createHash('sha256').update(normalized).digest('hex');
}

function isExactTopLevelRecoveryAwait(call, body) {
  const awaited = call.parent;
  const statement = awaited?.parent;
  return (
    ts.isAwaitExpression(awaited) &&
    ts.isExpressionStatement(statement) &&
    statement.expression === awaited &&
    statement.parent === body
  );
}

function isIdentifierArgument(call, index, expected) {
  const argument = call.arguments[index];
  return !!argument && ts.isIdentifier(argument) && argument.text === expected;
}

function closestForOf(node) {
  let current = node.parent;
  while (current) {
    if (ts.isForOfStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function directAwaitedCallStatement(call) {
  const awaited = call.parent;
  const statement = awaited?.parent;
  if (
    !ts.isAwaitExpression(awaited) ||
    !ts.isExpressionStatement(statement) ||
    statement.expression !== awaited
  ) {
    return undefined;
  }
  return statement;
}

function propertyNameText(property) {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function rowIdentifierFromIdAccess(expression) {
  if (
    expression &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.name.text === 'id'
  ) {
    return expression.expression.text;
  }
  return undefined;
}

function forOfRowIdentifier(loop) {
  if (!loop || !ts.isVariableDeclarationList(loop.initializer)) return undefined;
  if (loop.initializer.declarations.length !== 1) return undefined;
  const declaration = loop.initializer.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function isDirectPropertyAccess(expression, owner, name) {
  return (
    !!expression &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === owner &&
    expression.name.text === name
  );
}

function isDirectPropertyAssignment(property, name, owner) {
  return (
    !!property &&
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === name &&
    isDirectPropertyAccess(property.initializer, owner, name)
  );
}

function directResultIdentifier(call) {
  const initializer = ts.isAwaitExpression(call.parent) ? call.parent : call;
  const owner = initializer.parent;
  if (
    ts.isVariableDeclaration(owner) &&
    owner.initializer === initializer &&
    ts.isIdentifier(owner.name)
  ) {
    return owner.name.text;
  }
  if (
    ts.isBinaryExpression(owner) &&
    owner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    owner.right === initializer &&
    ts.isIdentifier(owner.left)
  ) {
    return owner.left.text;
  }
  return undefined;
}

function bindingDeclarationsNamed(node, name) {
  const declarations = [];
  function visit(candidate) {
    if (
      (ts.isVariableDeclaration(candidate) || ts.isParameter(candidate)) &&
      ts.isIdentifier(candidate.name)
    ) {
      if (candidate.name.text === name) declarations.push(candidate);
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return declarations;
}

function directExpressionRootIdentifier(expression) {
  let current = expression;
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function bindingIntegrityErrors(
  scope,
  name,
  { allowedAssignment, forbidDirectEscape = false, label = name } = {},
) {
  if (!scope || !name) return [];
  const errors = [];
  const declarations = bindingDeclarationsNamed(scope, name);
  if (declarations.length !== 1) {
    errors.push(`${label} must have exactly one variable binding in its guarded scope`);
  }
  let integrityViolation = false;

  function visit(candidate) {
    if (
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      candidate.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      directExpressionRootIdentifier(candidate.left) === name &&
      candidate !== allowedAssignment
    ) {
      integrityViolation = true;
    }
    if (
      (ts.isPrefixUnaryExpression(candidate) || ts.isPostfixUnaryExpression(candidate)) &&
      (candidate.operator === ts.SyntaxKind.PlusPlusToken ||
        candidate.operator === ts.SyntaxKind.MinusMinusToken) &&
      directExpressionRootIdentifier(candidate.operand) === name
    ) {
      integrityViolation = true;
    }
    if (
      ts.isDeleteExpression(candidate) &&
      directExpressionRootIdentifier(candidate.expression) === name
    ) {
      integrityViolation = true;
    }
    if (
      forbidDirectEscape &&
      ts.isVariableDeclaration(candidate) &&
      candidate.initializer &&
      ts.isIdentifier(candidate.initializer) &&
      candidate.initializer.text === name
    ) {
      integrityViolation = true;
    }
    if (
      forbidDirectEscape &&
      ts.isCallExpression(candidate) &&
      candidate.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === name)
    ) {
      integrityViolation = true;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(scope);
  if (integrityViolation) {
    errors.push(`${label} may not be reassigned, mutated, shadowed, or directly escaped`);
  }
  return errors;
}

function claimedRowIntegrityErrors(loop, claimCall, claimedRowIdentifier) {
  if (!loop || !claimCall || !claimedRowIdentifier) return [];
  const awaitedClaim = ts.isAwaitExpression(claimCall.parent) ? claimCall.parent : undefined;
  const allowedAssignment =
    awaitedClaim &&
    ts.isBinaryExpression(awaitedClaim.parent) &&
    awaitedClaim.parent.right === awaitedClaim &&
    awaitedClaim.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(awaitedClaim.parent.left) &&
    awaitedClaim.parent.left.text === claimedRowIdentifier
      ? awaitedClaim.parent
      : undefined;
  return bindingIntegrityErrors(loop.statement, claimedRowIdentifier, {
    allowedAssignment,
    forbidDirectEscape: true,
    label: 'claimed row',
  });
}

function atomicSendErrors(declaration) {
  const errors = [];
  const sendCalls = callsNamed(declaration.body, new Set(['sendTextMessage']));
  if (sendCalls.length !== 1) {
    return [
      `runDueScheduled must have exactly one direct production sendTextMessage call (found ${sendCalls.length})`,
    ];
  }

  const sendCall = sendCalls[0];
  const sendStatement = directAwaitedCallStatement(sendCall);
  const sendBlock = sendStatement?.parent;
  const senderBranch = sendBlock?.parent;
  if (
    !sendStatement ||
    !sendBlock ||
    !ts.isBlock(sendBlock) ||
    !senderBranch ||
    !ts.isIfStatement(senderBranch) ||
    senderBranch.elseStatement !== sendBlock ||
    !ts.isIdentifier(senderBranch.expression) ||
    senderBranch.expression.text !== 'sender'
  ) {
    errors.push(
      'the production sendTextMessage call must be one direct awaited statement in the else branch of if (sender)',
    );
  }

  if (
    sendCall.arguments.length !== 6 ||
    !isIdentifierArgument(sendCall, 0, 'db') ||
    !isIdentifierArgument(sendCall, 1, 'http')
  ) {
    errors.push(
      'production sendTextMessage must receive exactly six arguments beginning with db, http',
    );
  }
  if (!isIdentifierArgument(sendCall, 4, 'recordAtomicHandover')) {
    errors.push(
      'production sendTextMessage must use recordAtomicHandover as its direct fifth argument',
    );
  }

  const claimCalls = callsNamed(declaration.body, new Set(['claimDueScheduled']));
  const sendLoop = closestForOf(sendCall);
  const claimCall = claimCalls.find((call) => closestForOf(call) === sendLoop);
  const claimedRowIdentifier = claimCall ? directResultIdentifier(claimCall) : undefined;
  const candidateRowIdentifier = forOfRowIdentifier(sendLoop);
  if (!claimCall || !claimedRowIdentifier) {
    errors.push(
      'production handoff must use the direct row returned by claimDueScheduled in the same loop',
    );
  }
  errors.push(...claimedRowIntegrityErrors(sendLoop, claimCall, claimedRowIdentifier));
  if (sendLoop) {
    errors.push(
      ...bindingIntegrityErrors(sendLoop, candidateRowIdentifier, {
        label: 'due candidate',
      }),
      ...bindingIntegrityErrors(sendLoop.statement, 'recurrence', { label: 'recurrence' }),
      ...bindingIntegrityErrors(sendLoop.statement, 'transition', { label: 'transition' }),
      ...bindingIntegrityErrors(sendLoop.statement, 'recordAtomicHandover', {
        label: 'atomic handoff callback',
      }),
    );
  }
  errors.push(
    ...bindingIntegrityErrors(declaration.body, 'commitGuard', { label: 'commit guard' }),
  );
  if (
    !claimCall ||
    claimCall.arguments.length !== 4 ||
    !isIdentifierArgument(claimCall, 0, 'db') ||
    rowIdentifierFromIdAccess(claimCall.arguments[1]) !== candidateRowIdentifier ||
    !isIdentifierArgument(claimCall, 2, 'now') ||
    !isIdentifierArgument(claimCall, 3, 'commitGuard')
  ) {
    errors.push(
      'claimDueScheduled must be exactly claimDueScheduled(db, <candidate>.id, now, commitGuard)',
    );
  }

  const payload = sendCall.arguments[2];
  if (
    !claimedRowIdentifier ||
    !payload ||
    !ts.isObjectLiteralExpression(payload) ||
    payload.properties.length !== 3 ||
    !isDirectPropertyAssignment(payload.properties[0], 'chatGuid', claimedRowIdentifier) ||
    !isDirectPropertyAssignment(payload.properties[1], 'text', claimedRowIdentifier) ||
    !isDirectPropertyAssignment(payload.properties[2], 'selectedMessageGuid', claimedRowIdentifier)
  ) {
    errors.push(
      'production send payload must be exactly { chatGuid: <claimed>.chatGuid, text: <claimed>.text, selectedMessageGuid: <claimed>.selectedMessageGuid }',
    );
  }

  const recurrenceCalls = callsNamed(declaration.body, new Set(['asRecurrence'])).filter(
    (call) => closestForOf(call) === sendLoop,
  );
  const recurrenceCall = recurrenceCalls[0];
  if (
    recurrenceCalls.length !== 1 ||
    !recurrenceCall ||
    directResultIdentifier(recurrenceCall) !== 'recurrence' ||
    recurrenceCall.arguments.length !== 1 ||
    !claimedRowIdentifier ||
    !isDirectPropertyAccess(recurrenceCall.arguments[0], claimedRowIdentifier, 'recurrence')
  ) {
    errors.push('recurrence must be exactly asRecurrence(<claimed>.recurrence)');
  }

  const nextOccurrenceCalls = callsNamed(declaration.body, new Set(['nextOccurrence'])).filter(
    (call) => closestForOf(call) === sendLoop,
  );
  const nextOccurrenceCall = nextOccurrenceCalls[0];
  const nextScheduledForProperty = nextOccurrenceCall?.parent;
  let transitionDeclaration = nextScheduledForProperty?.parent;
  while (transitionDeclaration && !ts.isVariableDeclaration(transitionDeclaration)) {
    transitionDeclaration = transitionDeclaration.parent;
  }
  if (
    nextOccurrenceCalls.length !== 1 ||
    !nextOccurrenceCall ||
    !nextScheduledForProperty ||
    !ts.isPropertyAssignment(nextScheduledForProperty) ||
    !ts.isIdentifier(nextScheduledForProperty.name) ||
    nextScheduledForProperty.name.text !== 'nextScheduledFor' ||
    nextScheduledForProperty.initializer !== nextOccurrenceCall ||
    !transitionDeclaration ||
    !ts.isVariableDeclaration(transitionDeclaration) ||
    !ts.isIdentifier(transitionDeclaration.name) ||
    transitionDeclaration.name.text !== 'transition' ||
    !transitionDeclaration.initializer ||
    !ts.isConditionalExpression(transitionDeclaration.initializer) ||
    !ts.isIdentifier(transitionDeclaration.initializer.condition) ||
    transitionDeclaration.initializer.condition.text !== 'recurrence' ||
    nextScheduledForProperty.parent !== transitionDeclaration.initializer.whenTrue ||
    nextOccurrenceCall.arguments.length !== 3 ||
    !claimedRowIdentifier ||
    !isDirectPropertyAccess(
      nextOccurrenceCall.arguments[0],
      claimedRowIdentifier,
      'scheduledFor',
    ) ||
    !isIdentifierArgument(nextOccurrenceCall, 1, 'recurrence') ||
    !isIdentifierArgument(nextOccurrenceCall, 2, 'now')
  ) {
    errors.push(
      'rearm time must be exactly nextOccurrence(<claimed>.scheduledFor, recurrence, now) in transition.nextScheduledFor',
    );
  }

  const handoff = sendCall.arguments[5];
  if (!handoff || !ts.isObjectLiteralExpression(handoff)) {
    errors.push(
      'production sendTextMessage sixth argument must be the direct atomic handoff object',
    );
    return errors;
  }

  const expectedNames = ['scheduledId', 'transition', 'commitGuard'];
  const actualNames = handoff.properties.map(propertyNameText);
  if (
    handoff.properties.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    errors.push(
      'atomic handoff must be exactly { scheduledId: <claimed row>.id, transition, commitGuard }',
    );
    return errors;
  }

  const [scheduledIdProperty, transitionProperty, commitGuardProperty] = handoff.properties;
  const scheduledIdOwner =
    scheduledIdProperty && ts.isPropertyAssignment(scheduledIdProperty)
      ? rowIdentifierFromIdAccess(scheduledIdProperty.initializer)
      : undefined;
  if (!scheduledIdOwner || scheduledIdOwner !== claimedRowIdentifier) {
    errors.push('atomic handoff scheduledId must come directly from the claimed row id');
  }
  if (
    !transitionProperty ||
    !ts.isShorthandPropertyAssignment(transitionProperty) ||
    transitionProperty.name.text !== 'transition'
  ) {
    errors.push('atomic handoff transition must be the direct transition shorthand');
  }
  if (
    !commitGuardProperty ||
    !ts.isShorthandPropertyAssignment(commitGuardProperty) ||
    commitGuardProperty.name.text !== 'commitGuard'
  ) {
    errors.push('atomic handoff commitGuard must be the direct commitGuard shorthand');
  }

  return errors;
}

/** Validate that the scheduled send path cannot fall through to the ordinary queue insert. */
export function scheduledHandoffSourceErrors(source, { expectedBodyHash } = {}) {
  const sourceFile = ts.createSourceFile(
    SEND_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = exportedFunction(sourceFile, 'sendTextMessage');
  if (matches.length !== 1 || !declaration?.body) {
    return ['sendTextMessage must be one exported top-level function declaration'];
  }

  const errors = [];
  if (expectedBodyHash && functionBodyHash(declaration, sourceFile) !== expectedBodyHash) {
    errors.push('sendTextMessage no longer matches its reviewed AST body fingerprint');
  }
  errors.push(
    ...bindingIntegrityErrors(declaration, 'scheduledHandover', {
      label: 'scheduled handoff parameter',
    }),
  );
  const handoffCalls = callsNamed(declaration.body, new Set(['handoverScheduledTextToOutgoing']));
  if (handoffCalls.length !== 1) {
    return [
      `sendTextMessage must call handoverScheduledTextToOutgoing exactly once (found ${handoffCalls.length})`,
    ];
  }

  const handoffCall = handoffCalls[0];
  const handoffStatement = directAwaitedCallStatement(handoffCall);
  const handoffBlock = handoffStatement?.parent;
  const branch = handoffBlock?.parent;
  if (
    !handoffStatement ||
    !handoffBlock ||
    !ts.isBlock(handoffBlock) ||
    handoffBlock.statements.length !== 1 ||
    !branch ||
    !ts.isIfStatement(branch) ||
    branch.parent !== declaration.body ||
    branch.thenStatement !== handoffBlock ||
    !ts.isIdentifier(branch.expression) ||
    branch.expression.text !== 'scheduledHandover'
  ) {
    errors.push(
      'scheduled handoff must be the sole direct awaited statement in a top-level if (scheduledHandover) branch',
    );
  }

  const handoffArgs = handoffCall.arguments[1];
  const expectedHandoffNames = ['scheduledId', 'transition', 'outgoing'];
  const handoffNames = ts.isObjectLiteralExpression(handoffArgs)
    ? handoffArgs.properties.map(propertyNameText)
    : [];
  const [scheduledIdProperty, transitionProperty, outgoingProperty] = ts.isObjectLiteralExpression(
    handoffArgs,
  )
    ? handoffArgs.properties
    : [];
  if (
    handoffCall.arguments.length !== 3 ||
    !isIdentifierArgument(handoffCall, 0, 'db') ||
    !ts.isObjectLiteralExpression(handoffArgs) ||
    handoffNames.length !== expectedHandoffNames.length ||
    handoffNames.some((name, index) => name !== expectedHandoffNames[index]) ||
    !isDirectPropertyAssignment(scheduledIdProperty, 'scheduledId', 'scheduledHandover') ||
    !isDirectPropertyAssignment(transitionProperty, 'transition', 'scheduledHandover') ||
    !outgoingProperty ||
    !ts.isShorthandPropertyAssignment(outgoingProperty) ||
    outgoingProperty.name.text !== 'outgoing' ||
    !isDirectPropertyAccess(handoffCall.arguments[2], 'scheduledHandover', 'commitGuard')
  ) {
    errors.push(
      'scheduled handoff call must directly pass db, scheduledHandover fields, outgoing, and scheduledHandover.commitGuard',
    );
  }

  const ordinaryCalls = callsNamed(declaration.body, new Set(['insertOutgoingText']));
  const ordinaryCall = ordinaryCalls[0];
  const ordinaryStatement = ordinaryCall ? directAwaitedCallStatement(ordinaryCall) : undefined;
  if (
    ordinaryCalls.length !== 1 ||
    !ordinaryCall ||
    !ordinaryStatement ||
    !branch ||
    !ts.isIfStatement(branch) ||
    !branch.elseStatement ||
    !ts.isBlock(branch.elseStatement) ||
    branch.elseStatement.statements.length !== 1 ||
    ordinaryStatement.parent !== branch.elseStatement ||
    ordinaryCall.arguments.length !== 2 ||
    !isIdentifierArgument(ordinaryCall, 0, 'db') ||
    !isIdentifierArgument(ordinaryCall, 1, 'outgoing')
  ) {
    errors.push(
      'ordinary insertOutgoingText must be the sole direct awaited statement in the scheduled handoff else branch',
    );
  }

  const bodyStatements = declaration.body.statements;
  const branchIndex = branch ? bodyStatements.indexOf(branch) : -1;
  const onQueuedCalls = callsNamed(declaration.body, new Set(['onQueued']));
  const onQueuedCall = onQueuedCalls[0];
  const onQueuedStatement = onQueuedCall ? directAwaitedCallStatement(onQueuedCall) : undefined;
  if (
    onQueuedCalls.length !== 1 ||
    !onQueuedStatement ||
    branchIndex < 0 ||
    bodyStatements[branchIndex + 1] !== onQueuedStatement
  ) {
    errors.push(
      'await onQueued?.() must be the first top-level statement after the handoff branch',
    );
  }

  const guardStatement = branchIndex >= 0 ? bodyStatements[branchIndex + 2] : undefined;
  const compactGuardCondition =
    guardStatement && ts.isIfStatement(guardStatement)
      ? guardStatement.expression.getText(sourceFile).replace(/\s+/g, '')
      : '';
  const guardBody =
    guardStatement && ts.isIfStatement(guardStatement) ? guardStatement.thenStatement : undefined;
  const guardThrow =
    guardBody && ts.isBlock(guardBody) && guardBody.statements.length === 1
      ? guardBody.statements[0]
      : undefined;
  if (
    !guardStatement ||
    !ts.isIfStatement(guardStatement) ||
    compactGuardCondition !== 'scheduledHandover?.commitGuard&&!scheduledHandover.commitGuard()' ||
    !guardThrow ||
    !ts.isThrowStatement(guardThrow) ||
    !guardThrow.expression ||
    !ts.isNewExpression(guardThrow.expression) ||
    !ts.isIdentifier(guardThrow.expression.expression) ||
    guardThrow.expression.expression.text !== 'DbCommitGuardRejectedError' ||
    (guardThrow.expression.arguments?.length ?? 0) !== 0
  ) {
    errors.push(
      'the exact scheduled commit-guard rejection must immediately follow onQueued before networking',
    );
  }

  const networkCalls = callsNamed(declaration.body, new Set(['sendText']));
  if (
    networkCalls.length !== 1 ||
    !networkCalls[0] ||
    !guardStatement ||
    networkCalls[0].getStart(sourceFile) <= guardStatement.getEnd()
  ) {
    errors.push('the one sendText network call must occur after the scheduled commit guard');
  }

  return errors;
}

export function scheduledSendTextBodyHash(source) {
  const sourceFile = ts.createSourceFile(
    SEND_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = exportedFunction(sourceFile, 'sendTextMessage');
  if (matches.length !== 1 || !declaration?.body) {
    throw new Error('sendTextMessage must be one exported top-level function declaration');
  }
  return functionBodyHash(declaration, sourceFile);
}

/** Validate the ordering inside the one production scheduler entry point. */
export function scheduledRecoverySourceErrors(source, { expectedBodyHash } = {}) {
  const errors = [];
  const sourceFile = ts.createSourceFile(
    SCHEDULE_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = exportedFunction(sourceFile, 'runDueScheduled');
  if (matches.length !== 1 || !declaration?.body) {
    return ['runDueScheduled must be one exported top-level function declaration'];
  }
  if (expectedBodyHash && functionBodyHash(declaration, sourceFile) !== expectedBodyHash) {
    errors.push('runDueScheduled no longer matches its reviewed AST body fingerprint');
  }

  const recoveryCalls = callsNamed(declaration.body, new Set(['ensureScheduledRecovery']));
  if (recoveryCalls.length !== 1) {
    errors.push(
      `runDueScheduled must call ensureScheduledRecovery exactly once (found ${recoveryCalls.length})`,
    );
  }
  const recovery = recoveryCalls[0];
  if (recovery) {
    if (!isExactTopLevelRecoveryAwait(recovery, declaration.body)) {
      errors.push('ensureScheduledRecovery must be an unconditional top-level awaited statement');
    }
    if (
      recovery.arguments.length !== 3 ||
      !isIdentifierArgument(recovery, 0, 'db') ||
      !isIdentifierArgument(recovery, 1, 'accountScope') ||
      !isIdentifierArgument(recovery, 2, 'maxRows')
    ) {
      errors.push('ensureScheduledRecovery must receive db, accountScope, and maxRows directly');
    }

    const recoveryStatement = recovery.parent.parent;
    const earlierStatements = declaration.body.statements.filter(
      (statement) => statement.getStart(sourceFile) < recoveryStatement.getStart(sourceFile),
    );
    const onlyInitialScopeAssertion =
      earlierStatements.length === 1 &&
      ts.isExpressionStatement(earlierStatements[0]) &&
      ts.isCallExpression(earlierStatements[0].expression) &&
      directCallName(earlierStatements[0].expression) === 'assertScheduledScope';
    if (!onlyInitialScopeAssertion) {
      errors.push('only the initial account-scope assertion may run before scheduled recovery');
    }
  }

  const workCalls = callsNamed(
    declaration.body,
    new Set(['listDueScheduled', 'claimDueScheduled']),
  );
  for (const required of ['listDueScheduled', 'claimDueScheduled']) {
    if (!workCalls.some((call) => directCallName(call) === required)) {
      errors.push(`runDueScheduled must retain its ${required} call`);
    }
  }
  if (
    recovery &&
    workCalls.some((call) => call.getStart(sourceFile) < recovery.getStart(sourceFile))
  ) {
    errors.push('scheduled recovery must complete before due-list or claim work starts');
  }

  errors.push(...atomicSendErrors(declaration));

  return errors;
}

export function scheduledRunDueBodyHash(source) {
  const sourceFile = ts.createSourceFile(
    SCHEDULE_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = exportedFunction(sourceFile, 'runDueScheduled');
  if (matches.length !== 1 || !declaration?.body) {
    throw new Error('runDueScheduled must be one exported top-level function declaration');
  }
  return functionBodyHash(declaration, sourceFile);
}

function exactCallErrors(findings, { label, target, path, symbol }) {
  const uses = findings.filter((finding) => finding.target === target);
  if (uses.length !== 1)
    return [`${label} must have exactly one production use (found ${uses.length})`];
  const [use] = uses;
  if (use.operation !== 'mutator-call' || use.path !== path || use.symbol !== symbol) {
    return [
      `${label} must be called directly only by ${path}#${symbol}; references and aliases are forbidden`,
    ];
  }
  return [];
}

function forbiddenUseErrors(findings, { label, target }) {
  const uses = findings.filter((finding) => finding.target === target);
  if (uses.length === 0) return [];
  return [`${label} must have zero production calls or references (found ${uses.length})`];
}

/** Validate the closed-world production call graph reported by the DB scanner. */
export function scheduledRecoveryCallGraphErrors(findings) {
  return [
    ...exactCallErrors(findings, {
      label: 'resetStuckScheduled',
      target: RESET_TARGET,
      path: SCHEDULE_SERVICE_PATH,
      symbol: 'recoverInterruptedScheduledRows',
    }),
    ...exactCallErrors(findings, {
      label: 'claimDueScheduled',
      target: CLAIM_TARGET,
      path: SCHEDULE_SERVICE_PATH,
      symbol: 'runDueScheduled',
    }),
    ...forbiddenUseErrors(findings, {
      label: 'broad claimScheduled helper',
      target: BROAD_CLAIM_TARGET,
    }),
    ...exactCallErrors(findings, {
      label: 'handoverScheduledTextToOutgoing',
      target: HANDOFF_TARGET,
      path: 'src/services/send/sendService.ts',
      symbol: 'sendTextMessage',
    }),
  ];
}

function isAllowedRunDueIdentifier(identifier, path) {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent) && parent.expression === identifier) {
    return true;
  }
  if (ts.isImportSpecifier(parent) && parent.name === identifier && !parent.propertyName) {
    return true;
  }
  if (
    path === 'src/services/send/index.ts' &&
    ts.isExportSpecifier(parent) &&
    parent.name === identifier &&
    !parent.propertyName
  ) {
    return true;
  }
  return (
    path === SCHEDULE_SERVICE_PATH && ts.isFunctionDeclaration(parent) && parent.name === identifier
  );
}

/** Enforce the reviewed, account-scoped production entry points to the scheduled runner. */
export function scheduledRunnerUsageErrors(sources) {
  const errors = [];
  const callCounts = new Map();

  for (const { path, source } of sources) {
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node) {
      if (ts.isCallExpression(node) && directCallName(node) === 'runDueScheduled') {
        const expected = EXPECTED_RUN_DUE_CALLERS.get(path);
        callCounts.set(path, (callCounts.get(path) ?? 0) + 1);
        if (!expected) {
          errors.push(`unreviewed production runDueScheduled caller: ${path}`);
        } else if (
          node.arguments.length !== expected.argumentCount ||
          node.questionDotToken ||
          !isIdentifierArgument(node, 4, expected.scope)
        ) {
          errors.push(
            `${path} must call runDueScheduled with ${expected.argumentCount} arguments and explicit ${expected.scope} account scope in position five`,
          );
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === 'runDueScheduled' &&
        !isAllowedRunDueIdentifier(node, path)
      ) {
        errors.push(`runDueScheduled references and aliases are forbidden in production (${path})`);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  for (const path of EXPECTED_RUN_DUE_CALLERS.keys()) {
    const count = callCounts.get(path) ?? 0;
    if (count !== 1) {
      errors.push(`${path} must have exactly one direct runDueScheduled call (found ${count})`);
    }
  }
  return errors;
}

function productionSources(root) {
  const sources = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      sources.push({
        path: relative(root, absolute).split(sep).join('/'),
        source: readFileSync(absolute, 'utf8'),
      });
    }
  }
  visit(resolve(root, 'app'));
  visit(resolve(root, 'src'));
  return sources;
}

export function runScheduledRecoveryCheck({ root = process.cwd() } = {}) {
  const scheduleService = resolve(root, SCHEDULE_SERVICE_PATH);
  const sendService = resolve(root, SEND_SERVICE_PATH);
  if (!existsSync(scheduleService)) throw new Error(`missing ${SCHEDULE_SERVICE_PATH}`);
  if (!existsSync(sendService)) throw new Error(`missing ${SEND_SERVICE_PATH}`);
  const findings = scanDbWrites({ root });
  const errors = [
    ...scheduledRecoverySourceErrors(readFileSync(scheduleService, 'utf8'), {
      expectedBodyHash: REVIEWED_RUN_DUE_BODY_HASH,
    }),
    ...scheduledHandoffSourceErrors(readFileSync(sendService, 'utf8'), {
      expectedBodyHash: REVIEWED_SEND_TEXT_BODY_HASH,
    }),
    ...scheduledRecoveryCallGraphErrors(findings),
    ...scheduledRunnerUsageErrors(productionSources(root)),
  ];
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { resetCalls: 1, claimCalls: 1, handoffCalls: 1 };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runScheduledRecoveryCheck();
    console.log(
      `Scheduled recovery guard passed: ${result.resetCalls} reset owner; ${result.claimCalls} claim owner; ${result.handoffCalls} atomic handoff owner.`,
    );
  } catch (error) {
    console.error(
      `Scheduled recovery guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
