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
const PUBLIC_TEXT_INSERT_TARGET = 'src/db/repositories/outgoing.ts#insertOutgoingText';
const TRANSACTION_TEXT_INSERT_TARGET =
  'src/db/repositories/outgoing.ts#insertOutgoingTextWithinTransaction';
const REVIEWED_RUN_DUE_BODY_HASH =
  'e6259e87f1baef91ca5f55f92ada0b28604bfe628aa338b0e2c56bdcf1704d11';
const REVIEWED_SEND_TEXT_BODY_HASH =
  'dd6359aeef52eef3a725a11ced96aad328317417d940e1b774d5e9c9ffc95d62';
const HOME_PATH = 'app/(app)/home.tsx';
const CHAT_ROUTE_PATH = 'app/(app)/chat/[guid].tsx';
const CHAT_CATCHUP_PATH = 'src/features/conversations/useChatScheduledCatchup.ts';
const SEND_COMPOSITION_PATH = 'src/services/send/index.ts';
const BACKGROUND_SYNC_PATH = 'src/services/background/backgroundSync.ts';
const REVIEWED_SCHEDULED_SYNTAX_HASHES = new Map([
  [
    `${SEND_COMPOSITION_PATH}#fireDueScheduled`,
    'df82985dd8da9a2ff218aee1bae441a18b29bc0570f1181cf5f386323ab834ef',
  ],
  [
    `${SEND_COMPOSITION_PATH}#fireDueScheduledWithDevelopmentSender`,
    '2aebf4a5980ef6201af855583e6ff1a85f4b3b66aa5f89cf9a727f9dc8e1b260',
  ],
  [
    `${SEND_COMPOSITION_PATH}#runScheduledAccountOperation`,
    'a6932a4ec4fa73ff4c0211e0899a67999aae43b3e1ec890f7a6d40ddbc2706bd',
  ],
  [
    `${BACKGROUND_SYNC_PATH}#recoverAndDrainBackgroundSchedules`,
    '52405b0054b7144a559751cf3c7136b849af1ab1812401a749254afbcfaebac3',
  ],
  [
    `${BACKGROUND_SYNC_PATH}#asRealtimeLease`,
    '21c06aea640ecdb4ae509a6eb4f8768b4fbffb47226a992521e0b225beb68564',
  ],
  [
    `${CHAT_CATCHUP_PATH}#useChatScheduledCatchup`,
    '57f75b6dde11ec6d426c255edbb1a1b6b0f5a1528745b881fd38c9e762cc666a',
  ],
  [
    `${CHAT_ROUTE_PATH}#ChatScreen`,
    '06013bdb323211573156b5fadcd7c84f8b41f1fd393d9d0a8102071bf57f6d25',
  ],
  [
    `${HOME_PATH}#Home.scheduledEffect`,
    '2fb810524311c376ae5cdca62563f51f4fb6961e4f38107a8baa52d3edf6ea6e',
  ],
]);
const EXPECTED_SCHEDULED_CALLERS = new Map([
  [
    `runDueScheduled|${SEND_COMPOSITION_PATH}|fireDueScheduled`,
    { argumentCount: 5, scopeIndex: 4, scope: 'accountLease' },
  ],
  [
    `runDueScheduled|${SEND_COMPOSITION_PATH}|fireDueScheduledWithDevelopmentSender`,
    { argumentCount: 5, scopeIndex: 4, scope: 'accountLease' },
  ],
  [
    `runDueScheduled|${BACKGROUND_SYNC_PATH}|recoverAndDrainBackgroundSchedules`,
    { argumentCount: 6, scopeIndex: 4, scope: 'lease' },
  ],
  [`fireDueScheduled|${HOME_PATH}|Home`, { argumentCount: 0 }],
  [
    `fireDueScheduledWithDevelopmentSender|${HOME_PATH}|Home`,
    { argumentCount: 2, scopeIndex: 1, scope: 'accountLease' },
  ],
  [`fireDueScheduled|${CHAT_CATCHUP_PATH}|useChatScheduledCatchup`, { argumentCount: 0 }],
  [
    `fireDueScheduledWithDevelopmentSender|${CHAT_CATCHUP_PATH}|useChatScheduledCatchup`,
    { argumentCount: 2, scopeIndex: 1, scope: 'accountLease' },
  ],
  [
    `useChatScheduledCatchup|${CHAT_ROUTE_PATH}|ChatScreenInner`,
    { argumentCount: 1, scopeIndex: 0, scope: 'accountLease' },
  ],
]);
const SCHEDULED_DECLARATIONS = new Map([
  ['runDueScheduled', SCHEDULE_SERVICE_PATH],
  ['fireDueScheduled', SEND_COMPOSITION_PATH],
  ['fireDueScheduledWithDevelopmentSender', SEND_COMPOSITION_PATH],
  ['useChatScheduledCatchup', CHAT_CATCHUP_PATH],
]);
const SCHEDULED_IMPORTS = new Map([
  [`runDueScheduled|${SEND_COMPOSITION_PATH}`, './scheduleService'],
  [`runDueScheduled|${BACKGROUND_SYNC_PATH}`, '../send/scheduleService'],
  [`fireDueScheduled|${HOME_PATH}`, '@/services/send'],
  [`fireDueScheduledWithDevelopmentSender|${HOME_PATH}`, '@/services/send'],
  [`fireDueScheduled|${CHAT_CATCHUP_PATH}`, '@/services/send'],
  [`fireDueScheduledWithDevelopmentSender|${CHAT_CATCHUP_PATH}`, '@/services/send'],
  [`useChatScheduledCatchup|${CHAT_ROUTE_PATH}`, '@features/conversations/useChatScheduledCatchup'],
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

function syntaxHash(node, sourceFile) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const normalized = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
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
  const partIndexProperty =
    payload && ts.isObjectLiteralExpression(payload) ? payload.properties[3] : undefined;
  const partIndexInitializer =
    partIndexProperty && ts.isPropertyAssignment(partIndexProperty)
      ? partIndexProperty.initializer
      : undefined;
  if (
    !claimedRowIdentifier ||
    !payload ||
    !ts.isObjectLiteralExpression(payload) ||
    payload.properties.length !== 4 ||
    !isDirectPropertyAssignment(payload.properties[0], 'chatGuid', claimedRowIdentifier) ||
    !isDirectPropertyAssignment(payload.properties[1], 'text', claimedRowIdentifier) ||
    !isDirectPropertyAssignment(
      payload.properties[2],
      'selectedMessageGuid',
      claimedRowIdentifier,
    ) ||
    !partIndexProperty ||
    !ts.isPropertyAssignment(partIndexProperty) ||
    propertyNameText(partIndexProperty) !== 'partIndex' ||
    !partIndexInitializer ||
    !ts.isConditionalExpression(partIndexInitializer) ||
    !isDirectPropertyAccess(
      partIndexInitializer.condition,
      claimedRowIdentifier,
      'selectedMessageGuid',
    ) ||
    !isDirectPropertyAccess(
      partIndexInitializer.whenTrue,
      claimedRowIdentifier,
      'selectedMessagePartIndex',
    ) ||
    !ts.isIdentifier(partIndexInitializer.whenFalse) ||
    partIndexInitializer.whenFalse.text !== 'undefined'
  ) {
    errors.push(
      'production send payload must be exactly the claimed chat, text, selected message, and conditional selected-message part index',
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
    ...bindingIntegrityErrors(declaration, 'ordinaryCommitGuard', {
      label: 'ordinary commit-guard parameter',
    }),
    ...bindingIntegrityErrors(declaration.body, 'effectiveCommitGuard', {
      label: 'effective commit guard',
    }),
  );
  const finalParameter = declaration.parameters.at(-1);
  if (
    !finalParameter ||
    !ts.isIdentifier(finalParameter.name) ||
    finalParameter.name.text !== 'ordinaryCommitGuard' ||
    !finalParameter.questionToken
  ) {
    errors.push('sendTextMessage must retain ordinaryCommitGuard as its final optional parameter');
  }

  const effectiveBindings = bindingDeclarationsNamed(
    declaration.body,
    'effectiveCommitGuard',
  ).filter(ts.isVariableDeclaration);
  const effectiveBinding = effectiveBindings[0];
  const effectiveStatement = effectiveBinding?.parent?.parent;
  const effectiveInitializer = effectiveBinding?.initializer
    ?.getText(sourceFile)
    .replace(/\s+/g, '');
  if (
    effectiveBindings.length !== 1 ||
    !effectiveBinding ||
    !effectiveStatement ||
    !ts.isVariableStatement(effectiveStatement) ||
    effectiveStatement.parent !== declaration.body ||
    effectiveInitializer !== 'scheduledHandover?.commitGuard??ordinaryCommitGuard'
  ) {
    errors.push(
      'effectiveCommitGuard must be the one top-level scheduledHandover?.commitGuard ?? ordinaryCommitGuard binding',
    );
  }
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

  const ordinaryOwnerCalls = callsNamed(declaration.body, new Set(['withDbTransaction']));
  const ordinaryOwnerCall = ordinaryOwnerCalls[0];
  const ordinaryStatement = ordinaryOwnerCall
    ? directAwaitedCallStatement(ordinaryOwnerCall)
    : undefined;
  const transactionInsertCalls = callsNamed(
    declaration.body,
    new Set(['insertOutgoingTextWithinTransaction']),
  );
  const transactionInsertCall = transactionInsertCalls[0];
  const publicInsertCalls = callsNamed(declaration.body, new Set(['insertOutgoingText']));
  const ownerCallback = ordinaryOwnerCall?.arguments[1];
  const callbackBody =
    ownerCallback && ts.isArrowFunction(ownerCallback) && ts.isCallExpression(ownerCallback.body)
      ? ownerCallback.body
      : undefined;
  if (
    ordinaryOwnerCalls.length !== 1 ||
    !ordinaryOwnerCall ||
    !ordinaryStatement ||
    !branch ||
    !ts.isIfStatement(branch) ||
    !branch.elseStatement ||
    !ts.isBlock(branch.elseStatement) ||
    branch.elseStatement.statements.length !== 1 ||
    ordinaryStatement.parent !== branch.elseStatement ||
    ordinaryOwnerCall.arguments.length !== 3 ||
    !isIdentifierArgument(ordinaryOwnerCall, 0, 'db') ||
    !isIdentifierArgument(ordinaryOwnerCall, 2, 'effectiveCommitGuard') ||
    !ownerCallback ||
    !ts.isArrowFunction(ownerCallback) ||
    ownerCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    ownerCallback.parameters.length !== 1 ||
    !ownerCallback.parameters[0] ||
    !ts.isIdentifier(ownerCallback.parameters[0].name) ||
    ownerCallback.parameters[0].name.text !== 'context' ||
    !callbackBody ||
    directCallName(callbackBody) !== 'insertOutgoingTextWithinTransaction' ||
    transactionInsertCalls.length !== 1 ||
    transactionInsertCall !== callbackBody ||
    callbackBody.arguments.length !== 2 ||
    !isIdentifierArgument(callbackBody, 0, 'context') ||
    !isIdentifierArgument(callbackBody, 1, 'outgoing') ||
    publicInsertCalls.length !== 0
  ) {
    errors.push(
      'ordinary text must use the sole direct awaited guarded withDbTransaction/context insert in the scheduled handoff else branch',
    );
  }

  const bodyStatements = declaration.body.statements;
  const branchIndex = branch ? bodyStatements.indexOf(branch) : -1;
  if (branchIndex < 1 || bodyStatements[branchIndex - 1] !== effectiveStatement) {
    errors.push('effectiveCommitGuard must be declared immediately before the handoff branch');
  }
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
    compactGuardCondition !== 'effectiveCommitGuard&&!effectiveCommitGuard()' ||
    !guardThrow ||
    !ts.isThrowStatement(guardThrow) ||
    !guardThrow.expression ||
    !ts.isNewExpression(guardThrow.expression) ||
    !ts.isIdentifier(guardThrow.expression.expression) ||
    guardThrow.expression.expression.text !== 'DbCommitGuardRejectedError' ||
    (guardThrow.expression.arguments?.length ?? 0) !== 0
  ) {
    errors.push(
      'the exact effective commit-guard rejection must immediately follow onQueued before networking',
    );
  }

  const networkCalls = callsNamed(declaration.body, new Set(['sendText']));
  if (
    networkCalls.length !== 1 ||
    !networkCalls[0] ||
    !guardStatement ||
    networkCalls[0].getStart(sourceFile) <= guardStatement.getEnd()
  ) {
    errors.push('the one sendText network call must occur after the effective commit guard');
  }

  const reconcileCalls = callsNamed(declaration.body, new Set(['reconcileSendOutcome']));
  const failureCalls = callsNamed(declaration.body, new Set(['handleSendFailure']));
  const failureCall = failureCalls[0];
  const failureStatement = failureCall ? directAwaitedCallStatement(failureCall) : undefined;
  const catchClauses = [];
  function collectCatchClauses(node) {
    if (ts.isCatchClause(node)) catchClauses.push(node);
    ts.forEachChild(node, collectCatchClauses);
  }
  collectCatchClauses(declaration.body);
  const catchClause = catchClauses[0];
  const catchVariable = catchClause?.variableDeclaration?.name;
  const rethrow = catchClause?.block.statements[0];
  const rethrowCondition = rethrow && ts.isIfStatement(rethrow) ? rethrow.expression : undefined;
  const rethrowBody = rethrow && ts.isIfStatement(rethrow) ? rethrow.thenStatement : undefined;
  if (
    reconcileCalls.length !== 1 ||
    !reconcileCalls[0] ||
    reconcileCalls[0].arguments.length !== 5 ||
    !isIdentifierArgument(reconcileCalls[0], 4, 'effectiveCommitGuard') ||
    failureCalls.length !== 1 ||
    !failureCall ||
    failureCall.arguments.length !== 7 ||
    !isIdentifierArgument(failureCall, 6, 'effectiveCommitGuard') ||
    catchClauses.length !== 1 ||
    !catchClause ||
    !catchVariable ||
    !ts.isIdentifier(catchVariable) ||
    catchVariable.text !== 'e' ||
    !rethrowCondition ||
    !ts.isBinaryExpression(rethrowCondition) ||
    rethrowCondition.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword ||
    !ts.isIdentifier(rethrowCondition.left) ||
    rethrowCondition.left.text !== 'e' ||
    !ts.isIdentifier(rethrowCondition.right) ||
    rethrowCondition.right.text !== 'DbCommitGuardRejectedError' ||
    !rethrowBody ||
    !ts.isThrowStatement(rethrowBody) ||
    !ts.isIdentifier(rethrowBody.expression) ||
    rethrowBody.expression.text !== 'e' ||
    !failureStatement ||
    failureStatement.parent !== catchClause.block ||
    catchClause.block.statements[1] !== failureStatement
  ) {
    errors.push(
      'success and failure settlement must receive the effective guard, with ownership rejection rethrown before failure handling',
    );
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

function ordinaryTextOwnerErrors(findings) {
  const transactionUses = findings.filter(
    (finding) =>
      finding.path === SEND_SERVICE_PATH && finding.target === TRANSACTION_TEXT_INSERT_TARGET,
  );
  const publicUses = findings.filter(
    (finding) => finding.path === SEND_SERVICE_PATH && finding.target === PUBLIC_TEXT_INSERT_TARGET,
  );
  const [transactionUse] = transactionUses;
  const errors = [];
  if (
    transactionUses.length !== 1 ||
    !transactionUse ||
    transactionUse.operation !== 'mutator-call' ||
    !/^sendTextMessage\.<callback:[a-f0-9]+>$/.test(transactionUse.symbol)
  ) {
    errors.push(
      `ordinary text context insert must have exactly one direct sendTextMessage transaction-callback use (found ${transactionUses.length})`,
    );
  }
  if (publicUses.length !== 0) {
    errors.push(
      `public insertOutgoingText must have zero sendTextMessage calls or references (found ${publicUses.length})`,
    );
  }
  return errors;
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
    ...ordinaryTextOwnerErrors(findings),
  ];
}

function moduleSpecifierText(declaration) {
  return declaration?.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : undefined;
}

function exactNamedImportCount(sourceFile, name, module) {
  let count = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || moduleSpecifierText(statement) !== module) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    count += bindings.elements.filter(
      (element) => element.name.text === name && !element.propertyName,
    ).length;
  }
  return count;
}

function exactNamedReexportCount(sourceFile, name, module) {
  let count = 0;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      moduleSpecifierText(statement) !== module ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    count += statement.exportClause.elements.filter(
      (element) => element.name.text === name && !element.propertyName,
    ).length;
  }
  return count;
}

function topLevelFunctionOwner(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isFunctionDeclaration(current) && current.name && current.parent === sourceFile) {
      return current.name.text;
    }
    current = current.parent;
  }
  return '<module>';
}

function uniqueTopLevelFunction(sourceFile, name) {
  const matches = sourceFile?.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  return matches?.length === 1 && matches[0].body ? matches[0] : undefined;
}

function directZeroArgumentCall(node, name) {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    directCallName(node) === name &&
    !node.questionDotToken &&
    node.arguments.length === 0
  );
}

function hasExactMountedLease(declaration) {
  const matches = [];
  for (const statement of declaration.body.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1
    ) {
      continue;
    }
    const candidate = statement.declarationList.declarations[0];
    const elements = ts.isArrayBindingPattern(candidate.name) ? candidate.name.elements : [];
    const first = elements[0];
    if (
      elements.length === 1 &&
      first &&
      !ts.isOmittedExpression(first) &&
      ts.isIdentifier(first.name) &&
      first.name.text === 'accountLease'
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) return false;
  const initializer = matches[0].initializer;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    directCallName(initializer) !== 'useState' ||
    initializer.questionDotToken ||
    initializer.arguments.length !== 1
  ) {
    return false;
  }
  const capture = initializer.arguments[0];
  return (
    ts.isArrowFunction(capture) &&
    capture.parameters.length === 0 &&
    directZeroArgumentCall(capture.body, 'captureRealtimeDeliveryLease')
  );
}

function isAllowedScheduledIdentifier(identifier, path, sourceFile) {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent) && parent.expression === identifier) {
    return true;
  }
  if (ts.isImportSpecifier(parent) && parent.name === identifier && !parent.propertyName) {
    const declaration = parent.parent?.parent?.parent;
    return (
      ts.isImportDeclaration(declaration) &&
      moduleSpecifierText(declaration) === SCHEDULED_IMPORTS.get(`${identifier.text}|${path}`)
    );
  }
  if (
    identifier.text === 'runDueScheduled' &&
    path === SEND_COMPOSITION_PATH &&
    ts.isExportSpecifier(parent) &&
    parent.name === identifier &&
    !parent.propertyName
  ) {
    const declaration = parent.parent?.parent;
    return (
      ts.isExportDeclaration(declaration) &&
      moduleSpecifierText(declaration) === './scheduleService'
    );
  }
  return (
    SCHEDULED_DECLARATIONS.get(identifier.text) === path &&
    ts.isFunctionDeclaration(parent) &&
    parent.name === identifier &&
    parent.parent === sourceFile
  );
}

function statementCanExitOwner(statement) {
  let canExit = false;
  function visit(node) {
    if (canExit) return;
    if (
      (ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      unwrapStaticExpression(node.expression).kind === ts.SyntaxKind.TrueKeyword
    ) {
      canExit = true;
      return;
    }
    if (
      ts.isForStatement(node) &&
      (!node.condition || unwrapStaticExpression(node.condition).kind === ts.SyntaxKind.TrueKeyword)
    ) {
      canExit = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (
        ts.isParenthesizedExpression(callee) ||
        ts.isAsExpression(callee) ||
        ts.isSatisfiesExpression(callee) ||
        ts.isTypeAssertionExpression(callee) ||
        ts.isNonNullExpression(callee)
      ) {
        callee = callee.expression;
      }
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        canExit = true;
        return;
      }
    }
    if (node !== statement && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      canExit = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return canExit;
}

function bindingNameContains(name, forbidden) {
  if (ts.isIdentifier(name)) return forbidden.has(name.text);
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, forbidden),
  );
}

function ownerShadowsBindings(owner, names) {
  const forbidden = new Set(names);
  if (owner.parameters.some((parameter) => bindingNameContains(parameter.name, forbidden))) {
    return true;
  }
  let shadowed = false;
  function visit(node) {
    if (shadowed) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingNameContains(node.name, forbidden)
    ) {
      shadowed = true;
      return;
    }
    if (
      node !== owner &&
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      forbidden.has(node.name.text)
    ) {
      shadowed = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(owner.body);
  return shadowed;
}

function exactBackgroundScheduleWiring(sourceFile) {
  const task = uniqueTopLevelFunction(sourceFile, 'executeBackgroundSyncTask');
  if (
    !task ||
    !task.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !task.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    ownerShadowsBindings(task, ['recoverAndDrainBackgroundSchedules', 'runBackgroundSync'])
  ) {
    return false;
  }
  const calls = callsNamed(task.body, new Set(['runBackgroundSync']));
  if (calls.length !== 1 || calls[0].questionDotToken || calls[0].arguments.length !== 1) {
    return false;
  }
  const call = calls[0];
  const awaited = call.parent;
  const outcomeDeclaration = awaited?.parent;
  const declarationList = outcomeDeclaration?.parent;
  const outcomeStatement = declarationList?.parent;
  const tryBlock = outcomeStatement?.parent;
  const tryStatement = tryBlock?.parent;
  if (
    !ts.isAwaitExpression(awaited) ||
    !ts.isVariableDeclaration(outcomeDeclaration) ||
    !ts.isIdentifier(outcomeDeclaration.name) ||
    outcomeDeclaration.name.text !== 'outcome' ||
    outcomeDeclaration.initializer !== awaited ||
    !ts.isVariableDeclarationList(declarationList) ||
    !(declarationList.flags & ts.NodeFlags.Const) ||
    declarationList.declarations.length !== 1 ||
    !ts.isVariableStatement(outcomeStatement) ||
    !ts.isBlock(tryBlock) ||
    tryBlock.statements[0] !== outcomeStatement ||
    !ts.isTryStatement(tryStatement) ||
    tryStatement.tryBlock !== tryBlock ||
    task.body.statements[0] !== tryStatement
  ) {
    return false;
  }
  const configuration = call.arguments[0];
  if (!ts.isObjectLiteralExpression(configuration)) return false;
  if (
    configuration.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        ('name' in property && ts.isComputedPropertyName(property.name)),
    )
  ) {
    return false;
  }
  const wiring = configuration.properties.filter(
    (property) =>
      'name' in property &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === 'recoverAndDrainSchedules',
  );
  return (
    wiring.length === 1 &&
    ts.isPropertyAssignment(wiring[0]) &&
    ts.isIdentifier(wiring[0].initializer) &&
    wiring[0].initializer.text === 'recoverAndDrainBackgroundSchedules'
  );
}

function unwrapStaticExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function scheduledElementAliases(sourceFile) {
  const aliases = new Map();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      Boolean(node.parent.flags & ts.NodeFlags.Const) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrapStaticExpression(node.initializer);
      if (
        (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) &&
        SCHEDULED_DECLARATIONS.has(initializer.text)
      ) {
        aliases.set(node.name.text, initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return aliases;
}

function directHomeScheduledEffect(home) {
  const effects = home.body.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(
      (expression) => ts.isCallExpression(expression) && directCallName(expression) === 'useEffect',
    )
    .filter((call) => {
      const callback = call.arguments[0];
      if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) return false;
      return (
        callsNamed(callback.body, new Set(['fireDueScheduled'])).length === 1 &&
        callsNamed(callback.body, new Set(['fireDueScheduledWithDevelopmentSender'])).length === 1
      );
    });
  if (effects.length !== 1) return undefined;
  const effect = effects[0];
  const effectStatement = effect.parent;
  const effectIndex = home.body.statements.indexOf(effectStatement);
  const dependencies = effect.arguments[1];
  if (
    !ts.isExpressionStatement(effectStatement) ||
    effectIndex < 0 ||
    home.body.statements.slice(0, effectIndex).some(statementCanExitOwner) ||
    effect.questionDotToken ||
    effect.arguments.length !== 2 ||
    !ts.isArrayLiteralExpression(dependencies) ||
    dependencies.elements.length !== 1 ||
    !ts.isIdentifier(dependencies.elements[0]) ||
    dependencies.elements[0].text !== 'accountLease'
  ) {
    return undefined;
  }
  return effect.arguments[0];
}

function directChatCatchupCall(inner) {
  const calls = callsNamed(inner.body, new Set(['useChatScheduledCatchup'])).filter((call) => {
    const statement = call.parent;
    return (
      ts.isExpressionStatement(statement) &&
      statement.expression === call &&
      statement.parent === inner.body
    );
  });
  if (
    calls.length !== 1 ||
    calls[0].arguments.length !== 1 ||
    !isIdentifierArgument(calls[0], 0, 'accountLease')
  ) {
    return undefined;
  }
  const statement = calls[0].parent;
  const index = inner.body.statements.indexOf(statement);
  return inner.body.statements.slice(0, index).some(statementCanExitOwner) ? undefined : calls[0];
}

function reviewedScheduledOwnerErrors(sourceFiles) {
  const errors = [];
  const exportedNames = new Set([
    'fireDueScheduled',
    'fireDueScheduledWithDevelopmentSender',
    'useChatScheduledCatchup',
    'ChatScreen',
  ]);
  for (const [key, expectedHash] of REVIEWED_SCHEDULED_SYNTAX_HASHES) {
    if (key.endsWith('#Home.scheduledEffect')) continue;
    const separator = key.lastIndexOf('#');
    const path = key.slice(0, separator);
    const name = key.slice(separator + 1);
    const sourceFile = sourceFiles.get(path);
    const declaration = uniqueTopLevelFunction(sourceFile, name);
    const exported = declaration?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    const actualHash = declaration ? syntaxHash(declaration, sourceFile) : '<missing>';
    if (!declaration || (exportedNames.has(name) && !exported) || actualHash !== expectedHash) {
      errors.push(
        `${path}#${name} no longer matches its reviewed scheduled-owner fingerprint (expected ${expectedHash}; actual ${actualHash})`,
      );
    }
  }

  const homeSource = sourceFiles.get(HOME_PATH);
  const home = uniqueTopLevelFunction(homeSource, 'Home');
  const homeEffect = home ? directHomeScheduledEffect(home) : undefined;
  if (
    !home ||
    !home.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !home.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
    !hasExactMountedLease(home) ||
    ownerShadowsBindings(home, [
      'captureRealtimeDeliveryLease',
      'isDevServer',
      'useEffect',
      'useState',
    ]) ||
    !homeEffect ||
    syntaxHash(homeEffect, homeSource) !==
      REVIEWED_SCHEDULED_SYNTAX_HASHES.get(`${HOME_PATH}#Home.scheduledEffect`)
  ) {
    errors.push(`${HOME_PATH}#Home no longer matches its reviewed live scheduled-effect owner`);
  }

  const chatSource = sourceFiles.get(CHAT_ROUTE_PATH);
  const chatInner = uniqueTopLevelFunction(chatSource, 'ChatScreenInner');
  if (
    !chatInner ||
    !hasExactMountedLease(chatInner) ||
    ownerShadowsBindings(chatInner, ['captureRealtimeDeliveryLease', 'useState']) ||
    !directChatCatchupCall(chatInner)
  ) {
    errors.push(
      `${CHAT_ROUTE_PATH}#ChatScreenInner must directly invoke the reviewed catch-up hook with its mounted account lease`,
    );
  }

  const backgroundSource = sourceFiles.get(BACKGROUND_SYNC_PATH);
  if (!backgroundSource || !exactBackgroundScheduleWiring(backgroundSource)) {
    errors.push(
      `${BACKGROUND_SYNC_PATH}#executeBackgroundSyncTask must wire the reviewed background schedule owner directly`,
    );
  }

  const requiredImports = [
    ...[...SCHEDULED_IMPORTS].map(([key, module]) => {
      const separator = key.indexOf('|');
      return [key.slice(separator + 1), key.slice(0, separator), module];
    }),
    [HOME_PATH, 'useEffect', 'react'],
    [HOME_PATH, 'useState', 'react'],
    [HOME_PATH, 'captureRealtimeDeliveryLease', '@/services/realtime/deliveryCoordinator'],
    [HOME_PATH, 'isDevServer', '@utils/isDev'],
    [CHAT_CATCHUP_PATH, 'useEffect', 'react'],
    [CHAT_CATCHUP_PATH, 'useRef', 'react'],
    [CHAT_CATCHUP_PATH, 'isDevServer', '@utils/isDev'],
    [CHAT_ROUTE_PATH, 'useState', 'react'],
    [CHAT_ROUTE_PATH, 'captureRealtimeDeliveryLease', '@/services/realtime/deliveryCoordinator'],
    [SEND_COMPOSITION_PATH, 'getDatabase', '@db/database'],
    [SEND_COMPOSITION_PATH, 'http', '../clients'],
    [SEND_COMPOSITION_PATH, 'captureRealtimeDeliveryLease', '../realtime/deliveryCoordinator'],
    [SEND_COMPOSITION_PATH, 'runTrackedRealtimeWork', '../realtime/deliveryCoordinator'],
    [BACKGROUND_SYNC_PATH, 'runTrackedRealtimeWork', '../realtime/deliveryCoordinator'],
    [BACKGROUND_SYNC_PATH, 'runBackgroundSync', './backgroundSyncOrchestrator'],
  ];
  for (const [path, name, module] of requiredImports) {
    const sourceFile = sourceFiles.get(path);
    if (!sourceFile || exactNamedImportCount(sourceFile, name, module) !== 1) {
      errors.push(`${path} must import ${name} exactly once from ${module}`);
    }
  }
  const sendSource = sourceFiles.get(SEND_COMPOSITION_PATH);
  if (
    !sendSource ||
    exactNamedReexportCount(sendSource, 'runDueScheduled', './scheduleService') !== 1
  ) {
    errors.push(
      `${SEND_COMPOSITION_PATH} must re-export runDueScheduled exactly once from ./scheduleService`,
    );
  }
  for (const [name, path] of SCHEDULED_DECLARATIONS) {
    const declaration = uniqueTopLevelFunction(sourceFiles.get(path), name);
    if (
      !declaration ||
      !declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      errors.push(`${path} must contain exactly one exported ${name} declaration`);
    }
  }
  return errors;
}

/** Enforce the reviewed, account-scoped scheduled runner and its reachable foreground wrappers. */
export function scheduledRunnerUsageErrors(sources) {
  const errors = [];
  const callCounts = new Map();
  const sourceFiles = new Map();

  for (const { path, source } of sources) {
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
    for (const diagnostic of parseDiagnostics) {
      errors.push(
        `${path} has invalid TypeScript syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    }
    if (sourceFiles.has(path)) errors.push(`duplicate scheduled production source: ${path}`);
    sourceFiles.set(path, sourceFile);
    if (parseDiagnostics.length > 0) continue;
    const elementAliases = scheduledElementAliases(sourceFile);
    function visit(node) {
      const symbol = ts.isCallExpression(node) ? directCallName(node) : undefined;
      if (symbol && SCHEDULED_DECLARATIONS.has(symbol)) {
        const owner = topLevelFunctionOwner(node, sourceFile);
        const key = `${symbol}|${path}|${owner}`;
        const expected = EXPECTED_SCHEDULED_CALLERS.get(key);
        callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
        if (!expected) {
          errors.push(`unreviewed production ${symbol} caller: ${path}#${owner}`);
        } else if (
          node.arguments.length !== expected.argumentCount ||
          node.questionDotToken ||
          (expected.scope && !isIdentifierArgument(node, expected.scopeIndex, expected.scope))
        ) {
          errors.push(
            `${path}#${owner} must call ${symbol} with ${expected.argumentCount} arguments${expected.scope ? ` and explicit ${expected.scope} account scope` : ''}`,
          );
        }
      }
      if (
        ts.isIdentifier(node) &&
        SCHEDULED_DECLARATIONS.has(node.text) &&
        !isAllowedScheduledIdentifier(node, path, sourceFile)
      ) {
        errors.push(`${node.text} references and aliases are forbidden in production (${path})`);
      }
      if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        const argument = unwrapStaticExpression(node.argumentExpression);
        const scheduledName =
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
          SCHEDULED_DECLARATIONS.has(argument.text)
            ? argument.text
            : ts.isIdentifier(argument)
              ? elementAliases.get(argument.text)
              : undefined;
        if (scheduledName) {
          errors.push(
            `${scheduledName} element-access aliases are forbidden in production (${path})`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  for (const [key] of EXPECTED_SCHEDULED_CALLERS) {
    const count = callCounts.get(key) ?? 0;
    if (count !== 1) {
      errors.push(`${key} must have exactly one direct reviewed call (found ${count})`);
    }
  }
  return [...errors, ...reviewedScheduledOwnerErrors(sourceFiles)];
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
