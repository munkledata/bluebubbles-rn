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
  '6fcf727f957ebee14c1d31f6110b79f97999cfef6f50689f58768ed800a6b627';
const REVIEWED_RESERVE_SCHEDULED_RUN_BODY_HASH =
  'd8b2eff4e441b6340e91120123f6a7c76365e0c6dc519561b81305276c42ada2';
const REVIEWED_ENSURE_SCHEDULED_RECOVERY_BODY_HASH =
  '4b623fa83b24c1602c60e02c1a226e3b2cfd7e5b06bde9e947dc5b35a7a851fb';
const REVIEWED_SEND_TEXT_BODY_HASH =
  '33950c7af484ca93fef9e28814e6852016203c5c7f2b1a19c852043fc1bb2c2e';
const HOME_PATH = 'app/(app)/home.tsx';
const CHAT_ROUTE_PATH = 'app/(app)/chat/[guid].tsx';
const CHAT_CATCHUP_PATH = 'src/features/conversations/useChatScheduledCatchup.ts';
const SEND_COMPOSITION_PATH = 'src/services/send/index.ts';
const BACKGROUND_SYNC_PATH = 'src/services/background/backgroundSync.ts';
const BACKGROUND_SYNC_ORCHESTRATOR_PATH = 'src/services/background/backgroundSyncOrchestrator.ts';
const OUTGOING_QUEUE_SERVICE_PATH = 'src/services/send/outgoingQueueService.ts';
const ATTACHMENT_UPLOAD_PATH = 'src/services/send/attachmentUpload.ts';
const HTTP_CLIENT_PATH = 'src/core/api/http.ts';
const REVIEWED_CALLBACK_DEPENDENCY_FILE_HASHES = new Map([
  [BACKGROUND_SYNC_PATH, 'a8d29d10257bb5960987b6cae3c0c06158a614892de3c5246c9ecb6ad96b6667'],
  [
    'src/native/backgroundTaskExecution.ts',
    '81a55c2b984ad740c0160dbce50ecc71d711c10ac18f8d83c8da9fe1e4576541',
  ],
  [
    'src/services/background/registerBackgroundSyncHeadlessTask.ts',
    'eedf77478f9479465c46af5df103c1be282991b1a0d0f686feb6ccf87c197cd0',
  ],
  [
    BACKGROUND_SYNC_ORCHESTRATOR_PATH,
    '23521a4ea573372ae0ee825b2882a7a9571279bc05d8e3bd3ca7e84e7dd38f1f',
  ],
  [OUTGOING_QUEUE_SERVICE_PATH, 'a278f91abef0e39bbafd617ab81655a520538252f9d970f72dcabebf55653ee7'],
  [ATTACHMENT_UPLOAD_PATH, 'c667ff16db3e0269728cef9e4650fe4e9f17d05d2f2e20ab73dcefc365b73fd2'],
  [
    'src/utils/uploadFilename.ts',
    '7204895bb4a6c12a061d7aa393da9a36a519085b2675fd7d5f0b6579f9f340ef',
  ],
  [HTTP_CLIENT_PATH, '9de33f6afa815241607d4a93162b0cbb962cdfd2dacf3b7dfbef47044fcc4480'],
]);
const REVIEWED_SCHEDULED_SYNTAX_HASHES = new Map([
  [
    `${SEND_COMPOSITION_PATH}#fireDueScheduled`,
    '2453fc12396f1670a5a56579838a5d7da3e313348f49a39571a1fb6fff3624b7',
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
    '2069af4b037851a86bc475cf38aadc579093c93ebf763d305f1e5251fd554330',
  ],
  [
    `${BACKGROUND_SYNC_PATH}#asRealtimeLease`,
    '21c06aea640ecdb4ae509a6eb4f8768b4fbffb47226a992521e0b225beb68564',
  ],
  [
    `${BACKGROUND_SYNC_PATH}#executeBackgroundSyncTask`,
    'a28df95a6b753a3400debbacf3d20fc79c47286394a597be9982e21543a15343',
  ],
  [
    `${CHAT_CATCHUP_PATH}#useChatScheduledCatchup`,
    'a03aeefd70364fd0bb1f736038b968dcb1a18373fea2964c2b8394920a301b58',
  ],
  [
    `${CHAT_ROUTE_PATH}#ChatScreen`,
    'a099f555db9e001c31fe9e66e1a8aa1599e2a99ed786f80c1d88b3231a9e948d',
  ],
  [
    `${HOME_PATH}#Home.scheduledEffect`,
    '2f26ab1248670d51afe33ee820b3002f2cba3e944114d8eda0e96ea1b6c9c9fd',
  ],
]);
const EXPECTED_SCHEDULED_CALLERS = new Map([
  [
    `runDueScheduled|${SEND_COMPOSITION_PATH}|fireDueScheduled`,
    {
      argumentCount: 7,
      scopeIndex: 4,
      scope: 'accountLease',
      capabilityFactory: 'session',
    },
  ],
  [
    `runDueScheduled|${SEND_COMPOSITION_PATH}|fireDueScheduledWithDevelopmentSender`,
    { argumentCount: 5, scopeIndex: 4, scope: 'accountLease' },
  ],
  [
    `runDueScheduled|${BACKGROUND_SYNC_PATH}|recoverAndDrainBackgroundSchedules`,
    { argumentCount: 7, scopeIndex: 4, scope: 'lease', capabilityFactory: 'fixed' },
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

function propertyCallsNamed(node, owner, name) {
  const calls = [];
  function visit(candidate) {
    if (
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      ts.isIdentifier(candidate.expression.expression) &&
      candidate.expression.expression.text === owner &&
      candidate.expression.name.text === name
    ) {
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

function topLevelFunction(sourceFile, name) {
  const matches = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  return { matches, declaration: matches.length === 1 ? matches[0] : undefined };
}

function functionBodyHash(declaration, sourceFile) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const normalized = printer.printNode(ts.EmitHint.Unspecified, declaration.body, sourceFile);
  return createHash('sha256').update(normalized).digest('hex');
}

function normalizedNodeText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function hasExactCompactText(node, sourceFile, expected) {
  return !!node && node.getText(sourceFile).replace(/\s+/g, '') === expected.replace(/\s+/g, '');
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

function isDirectOptionalZeroArgumentCall(expression, name) {
  return (
    !!expression &&
    ts.isCallExpression(expression) &&
    directCallName(expression) === name &&
    !!expression.questionDotToken &&
    expression.arguments.length === 0
  );
}

function isExactMessageTargetCommitGuardCall(expression) {
  return (
    !!expression &&
    ts.isCallExpression(expression) &&
    directCallName(expression) === 'messageTargetCommitGuard' &&
    expression.arguments.length === 2 &&
    isIdentifierArgument(expression, 0, 'commitGuard') &&
    isIdentifierArgument(expression, 1, 'serverAuthorization')
  );
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

function isDirectOptionalPropertyAccess(expression, owner, name) {
  return (
    !!expression &&
    ts.isPropertyAccessExpression(expression) &&
    !!expression.questionDotToken &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === owner &&
    expression.name.text === name
  );
}

function isExactSuccessSettlementOptions(expression) {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  if (expression.properties.length !== 2) return false;
  const attemptOwnerProperty = expression.properties[0];
  if (
    !attemptOwnerProperty ||
    !ts.isPropertyAssignment(attemptOwnerProperty) ||
    propertyNameText(attemptOwnerProperty) !== 'attemptOwnerToken'
  ) {
    return false;
  }
  const initializer = attemptOwnerProperty.initializer;
  const expectedChatProperty = expression.properties[1];
  return (
    ts.isBinaryExpression(initializer) &&
    initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    ts.isIdentifier(initializer.left) &&
    initializer.left.text === 'attemptOwnerToken' &&
    ts.isIdentifier(initializer.right) &&
    initializer.right.text === 'undefined' &&
    !!expectedChatProperty &&
    ts.isPropertyAssignment(expectedChatProperty) &&
    propertyNameText(expectedChatProperty) === 'expectedChatGuid' &&
    isDirectPropertyAccess(expectedChatProperty.initializer, 'args', 'chatGuid')
  );
}

function isExactTextCapabilityOptions(expression, sourceFile) {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  if (expression.properties.length !== 1) return false;
  const property = expression.properties[0];
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    propertyNameText(property) !== 'requireServerInfo'
  ) {
    return false;
  }
  return (
    property.initializer.getText(sourceFile).replace(/\s+/g, '') ===
    'rcsChat||target!=null||provenPlainTextChat'
  );
}

function isExactTextFailureOptions(expression, sourceFile) {
  return hasExactCompactText(
    expression,
    sourceFile,
    `{
      attemptOwnerToken: attemptOwnerToken ?? undefined,
      ...(retrySafePlainText
        ? { imessagePlainTextRetrySafe: true }
        : useIMessagePlainText
          ? { terminalUncertainKind: 'plain' as const }
          : target
            ? { terminalUncertainKind: 'reply' as const }
            : {}),
    }`,
  );
}

function isExactThrowGuard(statement, sourceFile, condition, errorName, message) {
  if (!statement || !ts.isIfStatement(statement)) return false;
  if (statement.expression.getText(sourceFile).replace(/\s+/g, '') !== condition) return false;
  if (!ts.isBlock(statement.thenStatement) || statement.thenStatement.statements.length !== 1) {
    return false;
  }
  const throwStatement = statement.thenStatement.statements[0];
  if (
    !throwStatement ||
    !ts.isThrowStatement(throwStatement) ||
    !ts.isNewExpression(throwStatement.expression) ||
    !ts.isIdentifier(throwStatement.expression.expression) ||
    throwStatement.expression.expression.text !== errorName
  ) {
    return false;
  }
  const args = throwStatement.expression.arguments ?? [];
  if (message === undefined) return args.length === 0;
  return args.length === 1 && !!args[0] && ts.isStringLiteral(args[0]) && args[0].text === message;
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
      (ts.isVariableDeclaration(candidate) ||
        ts.isParameter(candidate) ||
        ts.isBindingElement(candidate)) &&
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
  { allowedAssignment, allowedAssignments, forbidDirectEscape = false, label = name } = {},
) {
  if (!scope || !name) return [];
  const errors = [];
  const declarations = bindingDeclarationsNamed(scope, name);
  if (declarations.length !== 1) {
    errors.push(`${label} must have exactly one variable binding in its guarded scope`);
  }
  const permittedAssignments = new Set(
    allowedAssignments ?? (allowedAssignment ? [allowedAssignment] : []),
  );
  let integrityViolation = false;

  function visit(candidate) {
    if (
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      candidate.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      directExpressionRootIdentifier(candidate.left) === name &&
      !permittedAssignments.has(candidate)
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

function claimedRowIntegrityErrors(loop, claimCalls, claimedRowIdentifier) {
  if (!loop || claimCalls.length === 0 || !claimedRowIdentifier) return [];
  const allowedAssignments = claimCalls.flatMap((claimCall) => {
    const awaitedClaim = ts.isAwaitExpression(claimCall.parent) ? claimCall.parent : undefined;
    const assignment = awaitedClaim?.parent;
    return assignment &&
      ts.isBinaryExpression(assignment) &&
      assignment.right === awaitedClaim &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(assignment.left) &&
      assignment.left.text === claimedRowIdentifier
      ? [assignment]
      : [];
  });
  return bindingIntegrityErrors(loop.statement, claimedRowIdentifier, {
    allowedAssignments,
    forbidDirectEscape: true,
    label: 'claimed row',
  });
}

function atomicSendErrors(declaration) {
  const errors = [];
  errors.push(
    ...bindingIntegrityErrors(declaration, 'captureCapabilitySource', {
      label: 'scheduled capability-source factory',
      forbidDirectEscape: true,
    }),
  );
  const capabilitySourceParameter = declaration.parameters[6];
  if (
    declaration.parameters.length !== 7 ||
    !capabilitySourceParameter ||
    !ts.isIdentifier(capabilitySourceParameter.name) ||
    capabilitySourceParameter.name.text !== 'captureCapabilitySource' ||
    !capabilitySourceParameter.questionToken
  ) {
    errors.push(
      'runDueScheduled must retain captureCapabilitySource as its seventh optional parameter',
    );
  }

  const sendCalls = callsNamed(declaration.body, new Set(['sendTextMessage']));
  if (sendCalls.length !== 1) {
    return [
      'runDueScheduled must have exactly one direct production sendTextMessage call (found ' +
        sendCalls.length +
        ')',
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
    sendCall.arguments.length !== 8 ||
    !isIdentifierArgument(sendCall, 0, 'db') ||
    !isIdentifierArgument(sendCall, 1, 'http')
  ) {
    errors.push(
      'production sendTextMessage must receive exactly eight arguments beginning with db, http',
    );
  }
  if (!isIdentifierArgument(sendCall, 4, 'recordAtomicHandover')) {
    errors.push(
      'production sendTextMessage must use recordAtomicHandover as its direct fifth argument',
    );
  }
  if (
    !isIdentifierArgument(sendCall, 6, 'undefined') ||
    !isIdentifierArgument(sendCall, 7, 'capabilitySource')
  ) {
    errors.push(
      'production sendTextMessage must pass undefined ordinary guard and the capability snapshot captured before its claim',
    );
  }

  const claimCalls = callsNamed(declaration.body, new Set(['claimDueScheduled']));
  const claimCall = claimCalls[0];
  const sendLoop = closestForOf(sendCall);
  const loopClaimCalls = claimCalls.filter((call) => closestForOf(call) === sendLoop);
  const claimedRowIdentifier = claimCall ? directResultIdentifier(claimCall) : undefined;
  const candidateRowIdentifier = forOfRowIdentifier(sendLoop);
  if (
    claimCalls.length !== 1 ||
    loopClaimCalls.length !== 1 ||
    !claimCall ||
    !claimedRowIdentifier
  ) {
    errors.push(
      'production handoff must use exactly one direct claimDueScheduled result assigned to one claimed row in the same loop',
    );
  }
  errors.push(...claimedRowIntegrityErrors(sendLoop, loopClaimCalls, claimedRowIdentifier));

  const capabilityBindings = sendLoop
    ? bindingDeclarationsNamed(sendLoop.statement, 'capabilitySource').filter(
        ts.isVariableDeclaration,
      )
    : [];
  const capabilityBinding = capabilityBindings[0];
  const capabilityStatement = capabilityBinding?.parent?.parent;
  const capabilityInitializer = capabilityBinding?.initializer;
  const capabilityFactoryCalls = callsNamed(declaration.body, new Set(['captureCapabilitySource']));
  let claimOwnerStatement = claimCall;
  while (claimOwnerStatement?.parent && claimOwnerStatement.parent !== sendLoop?.statement) {
    claimOwnerStatement = claimOwnerStatement.parent;
  }
  const loopStatements =
    sendLoop?.statement && ts.isBlock(sendLoop.statement) ? sendLoop.statement.statements : [];
  let claimStatement = claimCall;
  while (claimStatement?.parent && claimStatement.parent !== claimOwnerStatement?.tryBlock) {
    claimStatement = claimStatement.parent;
  }
  const capabilityStatementIndex = capabilityStatement
    ? loopStatements.indexOf(capabilityStatement)
    : -1;
  if (
    capabilityBindings.length !== 1 ||
    !capabilityBinding ||
    !capabilityStatement ||
    !ts.isVariableStatement(capabilityStatement) ||
    capabilityStatement.parent !== sendLoop?.statement ||
    capabilityBinding.parent.declarations.length !== 1 ||
    !(capabilityBinding.parent.flags & ts.NodeFlags.Const) ||
    !isDirectOptionalZeroArgumentCall(capabilityInitializer, 'captureCapabilitySource') ||
    capabilityFactoryCalls.length !== 1 ||
    capabilityFactoryCalls[0] !== capabilityInitializer ||
    !claimCall ||
    !claimOwnerStatement ||
    !ts.isTryStatement(claimOwnerStatement) ||
    claimOwnerStatement.parent !== sendLoop?.statement ||
    !claimStatement ||
    claimStatement.parent !== claimOwnerStatement.tryBlock ||
    claimOwnerStatement.tryBlock.statements.length !== 1 ||
    claimOwnerStatement.tryBlock.statements[0] !== claimStatement ||
    capabilityStatementIndex < 0 ||
    loopStatements[capabilityStatementIndex + 1] !== claimOwnerStatement
  ) {
    errors.push(
      'each scheduled attempt must capture one immutable capabilitySource immediately before its claim',
    );
  }

  if (sendLoop) {
    errors.push(
      ...bindingIntegrityErrors(sendLoop, candidateRowIdentifier, {
        label: 'due candidate',
      }),
      ...bindingIntegrityErrors(sendLoop.statement, 'capabilitySource', {
        label: 'scheduled capability source',
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
    loopClaimCalls.length !== 1 ||
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
    payload.properties.length !== 2 ||
    !isDirectPropertyAssignment(payload.properties[0], 'chatGuid', claimedRowIdentifier) ||
    !isDirectPropertyAssignment(payload.properties[1], 'text', claimedRowIdentifier)
  ) {
    errors.push('production send payload must be exactly the claimed chat and text');
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

function scheduledCreationErrors(sourceFile) {
  const { matches, declaration } = exportedFunction(sourceFile, 'scheduleTextMessage');
  if (matches.length !== 1 || !declaration?.body) {
    return ['scheduleTextMessage must be one exported top-level function declaration'];
  }

  const errors = [];
  const bodyStatements = declaration.body.statements;
  const initialScopeStatement = bodyStatements[0];
  const initialScopeCall =
    initialScopeStatement && ts.isExpressionStatement(initialScopeStatement)
      ? initialScopeStatement.expression
      : undefined;
  if (
    !initialScopeCall ||
    !ts.isCallExpression(initialScopeCall) ||
    directCallName(initialScopeCall) !== 'assertScheduledScope' ||
    initialScopeCall.questionDotToken ||
    initialScopeCall.arguments.length !== 1 ||
    !isIdentifierArgument(initialScopeCall, 0, 'accountScope')
  ) {
    errors.push(
      'scheduleTextMessage must begin with the exact account-scope assertion before reply retirement',
    );
  }
  const replyRetirement = bodyStatements[1];
  if (
    !isExactThrowGuard(
      replyRetirement,
      sourceFile,
      'args.selectedMessageGuid!==undefined||args.selectedMessagePartIndex!==undefined',
      'Error',
      'Scheduled replies were retired in this release.',
    )
  ) {
    errors.push(
      'scheduleTextMessage must reject every scheduled reply target before network or DB work',
    );
  }

  const createCalls = propertyCallsNamed(declaration.body, 'scheduledApi', 'createScheduled');
  const createCall = createCalls[0];
  let serverEligibility = createCall;
  while (
    serverEligibility?.parent &&
    !ts.isIfStatement(serverEligibility) &&
    serverEligibility.parent !== declaration.body
  ) {
    serverEligibility = serverEligibility.parent;
  }
  if (
    createCalls.length !== 1 ||
    !createCall ||
    !serverEligibility ||
    !ts.isIfStatement(serverEligibility) ||
    serverEligibility.parent !== declaration.body ||
    serverEligibility.expression.getText(sourceFile).replace(/\s+/g, '') !==
      '!isRcsChatGuid(args.chatGuid)&&!args.selectedMessageGuid&&!args.recurrence'
  ) {
    errors.push(
      'server-side scheduling must remain limited to non-RCS, non-reply, non-recurring text',
    );
  }
  return errors;
}

function chooseSendMethodErrors(sourceFile) {
  const { matches, declaration } = exportedFunction(sourceFile, 'chooseSendMethod');
  if (matches.length !== 1 || !declaration?.body) {
    return ['chooseSendMethod must be one exported top-level function declaration'];
  }
  const [retiredPrivateApi, appleScriptReturn] = declaration.body.statements;
  if (
    declaration.parameters.length !== 1 ||
    !declaration.parameters[0] ||
    !ts.isIdentifier(declaration.parameters[0].name) ||
    declaration.parameters[0].name.text !== 'needsPrivateApi' ||
    declaration.body.statements.length !== 2 ||
    !isExactThrowGuard(
      retiredPrivateApi,
      sourceFile,
      'needsPrivateApi',
      'Error',
      'Private API message features were retired in this release.',
    ) ||
    !appleScriptReturn ||
    !ts.isReturnStatement(appleScriptReturn) ||
    !appleScriptReturn.expression ||
    !ts.isStringLiteral(appleScriptReturn.expression) ||
    appleScriptReturn.expression.text !== 'apple-script'
  ) {
    return [
      'chooseSendMethod must fail closed for Private API requirements and return only apple-script',
    ];
  }
  return [];
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
  errors.push(...chooseSendMethodErrors(sourceFile));
  for (const [name, module] of [
    ['isRetryableIMessagePlainTextUnavailable', '@core/api/endpoints/messages'],
    ['requireIMessagePlainTextRequest', '@core/api/endpoints/messages'],
    ['sendIMessagePlainText', '@core/api/endpoints/messages'],
    ['isProvenOneToOneIMessageChat', '@utils/chat'],
  ]) {
    let shadowedOrMutated = bindingDeclarationsNamed(sourceFile, name).length !== 0;
    let imports = 0;
    function inspectBinding(node) {
      if (ts.isImportSpecifier(node) && node.name.text === name) imports += 1;
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node) ||
          ts.isNamespaceImport(node) ||
          ts.isImportClause(node)) &&
        node.name?.text === name
      ) {
        shadowedOrMutated = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        directExpressionRootIdentifier(node.left) === name
      ) {
        shadowedOrMutated = true;
      }
      ts.forEachChild(node, inspectBinding);
    }
    inspectBinding(sourceFile);
    if (
      imports !== 1 ||
      exactNamedImportCount(sourceFile, name, module) !== 1 ||
      shadowedOrMutated
    ) {
      errors.push(
        `${name} must retain its unaliased canonical import without shadowing or mutation`,
      );
    }
  }
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
    ...bindingIntegrityErrors(declaration, 'capabilitySource', {
      label: 'capability-source parameter',
    }),
    ...bindingIntegrityErrors(declaration.body, 'effectiveCommitGuard', {
      label: 'effective commit guard',
    }),
    ...bindingIntegrityErrors(declaration.body, 'transport', {
      label: 'pinned send transport',
    }),
    ...bindingIntegrityErrors(declaration.body, 'capability', {
      label: 'send capability result',
    }),
    ...bindingIntegrityErrors(declaration.body, 'rcsChat', {
      label: 'RCS chat classification',
    }),
    ...bindingIntegrityErrors(declaration.body, 'candidatePlainTextHeader'),
    ...bindingIntegrityErrors(declaration.body, 'provenPlainTextChat', {
      forbidDirectEscape: true,
    }),
    ...bindingIntegrityErrors(declaration.body, 'useIMessagePlainText', {
      forbidDirectEscape: true,
    }),
    ...bindingIntegrityErrors(declaration.body, 'retrySafePlainText', { forbidDirectEscape: true }),
    ...bindingIntegrityErrors(declaration.body, 'capabilityGuard', {
      label: 'combined send capability guard',
    }),
    ...bindingIntegrityErrors(declaration.body, 'hasRetiredRichFields', {
      label: 'retired rich-field send requirement',
    }),
    ...bindingIntegrityErrors(declaration.body, 'targetAuthorization', {
      label: 'reply target authorization',
    }),
    ...bindingIntegrityErrors(declaration.body, 'authorizedTarget', {
      label: 'authorized reply target',
    }),
    ...bindingIntegrityErrors(declaration.body, 'resolvedTarget', {
      label: 'admission-time reply target',
    }),
    ...bindingIntegrityErrors(declaration.body, 'finalTarget', {
      label: 'network-time reply target',
    }),
    ...bindingIntegrityErrors(declaration.body, 'attemptOwnerToken', {
      label: 'attempt-owner token',
    }),
  );

  const ordinaryCommitGuardParameter = declaration.parameters[6];
  const capabilitySourceParameter = declaration.parameters[7];
  if (
    declaration.parameters.length !== 8 ||
    !ordinaryCommitGuardParameter ||
    !ts.isIdentifier(ordinaryCommitGuardParameter.name) ||
    ordinaryCommitGuardParameter.name.text !== 'ordinaryCommitGuard' ||
    !ordinaryCommitGuardParameter.questionToken ||
    !capabilitySourceParameter ||
    !ts.isIdentifier(capabilitySourceParameter.name) ||
    capabilitySourceParameter.name.text !== 'capabilitySource' ||
    !capabilitySourceParameter.questionToken
  ) {
    errors.push(
      'sendTextMessage must retain ordinaryCommitGuard seventh and capabilitySource final, both optional',
    );
  }

  const bodyStatements = declaration.body.statements;
  const targetPartCalls = callsNamed(declaration.body, new Set(['explicitMessageTargetPart']));
  const targetPartCall = targetPartCalls[0];
  const targetPartDeclaration = targetPartCall?.parent;
  const targetPartStatement = targetPartDeclaration?.parent?.parent;
  const targetBindings = bindingDeclarationsNamed(declaration.body, 'target').filter(
    ts.isVariableDeclaration,
  );
  const targetBinding = targetBindings[0];
  const targetStatement = targetBinding?.parent?.parent;
  const targetPartIndex = targetPartStatement ? bodyStatements.indexOf(targetPartStatement) : -1;
  const targetIndex = targetStatement ? bodyStatements.indexOf(targetStatement) : -1;
  const rcsTargetStatement = targetIndex >= 0 ? bodyStatements[targetIndex + 1] : undefined;
  const exactPartStatement = targetIndex >= 0 ? bodyStatements[targetIndex + 2] : undefined;
  const replyTextStatement = targetIndex >= 0 ? bodyStatements[targetIndex + 3] : undefined;
  const scheduledReplyStatement = targetIndex >= 0 ? bodyStatements[targetIndex + 4] : undefined;
  const rcsGuidCalls = callsNamed(declaration.body, new Set(['isRcsChatGuid']));
  if (
    targetPartCalls.length !== 1 ||
    !targetPartCall ||
    targetPartCall.arguments.length !== 2 ||
    !isDirectPropertyAccess(targetPartCall.arguments[0], 'args', 'selectedMessageGuid') ||
    !isDirectPropertyAccess(targetPartCall.arguments[1], 'args', 'partIndex') ||
    !targetPartDeclaration ||
    !ts.isVariableDeclaration(targetPartDeclaration) ||
    !ts.isIdentifier(targetPartDeclaration.name) ||
    targetPartDeclaration.name.text !== 'targetPart' ||
    targetPartDeclaration.initializer !== targetPartCall ||
    !targetPartStatement ||
    !ts.isVariableStatement(targetPartStatement) ||
    targetPartStatement.parent !== declaration.body ||
    targetBindings.length !== 1 ||
    !targetBinding ||
    !targetBinding.initializer ||
    !ts.isConditionalExpression(targetBinding.initializer) ||
    !ts.isIdentifier(targetBinding.initializer.condition) ||
    targetBinding.initializer.condition.text !== 'targetPart' ||
    !hasExactCompactText(
      targetBinding.initializer,
      sourceFile,
      `targetPart
        ? {
            chatGuid: args.chatGuid,
            messageGuid: targetPart.messageGuid,
            partIndex: targetPart.partIndex,
          }
        : null`,
    ) ||
    targetBinding.initializer.whenFalse.kind !== ts.SyntaxKind.NullKeyword ||
    !targetStatement ||
    !ts.isVariableStatement(targetStatement) ||
    targetStatement.parent !== declaration.body
  ) {
    errors.push('text target normalization must retain the exact selected-message part mapping');
  }
  if (
    rcsGuidCalls.length !== 2 ||
    !isExactThrowGuard(
      rcsTargetStatement,
      sourceFile,
      'target&&isRcsChatGuid(args.chatGuid)',
      'Error',
      'This server cannot send an RCS threaded reply.',
    )
  ) {
    errors.push(
      'an RCS threaded target must be rejected exactly once immediately after target normalization and before capability lookup or durable admission',
    );
  }
  if (
    !isExactThrowGuard(
      exactPartStatement,
      sourceFile,
      'target&&target.partIndex!==0',
      'Error',
      'An iMessage reply needs exact message part zero.',
    )
  ) {
    errors.push('an iMessage reply must require exact message part zero before durable admission');
  }
  if (
    !isExactThrowGuard(
      replyTextStatement,
      sourceFile,
      "target&&(args.text.trim().length===0||args.text.includes('\\u0000')||utf8Decode(utf8Encode(args.text))!==args.text||utf8Encode(args.text).byteLength>MAX_SEND_ATTACHMENT_TEXT_BYTES)",
      'Error',
      'An iMessage reply must be nonblank, well-formed text without NUL and no more than 65,536 UTF-8 bytes.',
    )
  ) {
    errors.push(
      'an iMessage reply must remain bounded, nonblank, NUL-free, well-formed plain text',
    );
  }
  if (
    !isExactThrowGuard(
      scheduledReplyStatement,
      sourceFile,
      'target&&scheduledHandover',
      'Error',
      'Scheduled replies are not supported.',
    )
  ) {
    errors.push('an iMessage reply must remain unscheduled before durable admission');
  }

  const retiredRichFieldBindings = bindingDeclarationsNamed(
    declaration.body,
    'hasRetiredRichFields',
  ).filter(ts.isVariableDeclaration);
  const retiredRichFieldBinding = retiredRichFieldBindings[0];
  const retiredRichFieldStatement = retiredRichFieldBinding?.parent?.parent;
  const retiredRichFieldInitializer = retiredRichFieldBinding?.initializer
    ?.getText(sourceFile)
    .replace(/\s+/g, '');
  const retiredRichFieldIndex = retiredRichFieldStatement
    ? bodyStatements.indexOf(retiredRichFieldStatement)
    : -1;
  const retiredPrivateApiStatement =
    retiredRichFieldIndex >= 0 ? bodyStatements[retiredRichFieldIndex + 1] : undefined;
  if (
    retiredRichFieldBindings.length !== 1 ||
    !retiredRichFieldBinding ||
    !retiredRichFieldStatement ||
    !ts.isVariableStatement(retiredRichFieldStatement) ||
    retiredRichFieldStatement.parent !== declaration.body ||
    retiredRichFieldInitializer !==
      'args.effectId!==undefined||args.subject!==undefined||(target?args.mentions!==undefined:!!args.mentions?.length)'
  ) {
    errors.push(
      'retired rich fields must be derived exactly from effect, subject, or mentions without retiring the narrow reply target',
    );
  }
  if (
    !isExactThrowGuard(
      retiredPrivateApiStatement,
      sourceFile,
      'hasRetiredRichFields',
      'Error',
      'Private API message features were retired in this release.',
    )
  ) {
    errors.push(
      'retired Private API-only text features must fail closed before capability lookup or durable admission',
    );
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

  const transportCalls = callsNamed(declaration.body, new Set(['pinSendTransport']));
  const transportCall = transportCalls[0];
  const transportDeclaration = transportCall?.parent;
  const transportStatement =
    transportDeclaration && ts.isVariableDeclaration(transportDeclaration)
      ? transportDeclaration.parent?.parent
      : undefined;
  if (
    transportCalls.length !== 1 ||
    !transportCall ||
    transportCall.arguments.length !== 2 ||
    !isIdentifierArgument(transportCall, 0, 'http') ||
    !isIdentifierArgument(transportCall, 1, 'effectiveCommitGuard') ||
    !transportDeclaration ||
    !ts.isVariableDeclaration(transportDeclaration) ||
    !ts.isIdentifier(transportDeclaration.name) ||
    transportDeclaration.name.text !== 'transport' ||
    transportDeclaration.initializer !== transportCall ||
    !transportStatement ||
    !ts.isVariableStatement(transportStatement) ||
    transportStatement.parent !== declaration.body ||
    transportDeclaration.parent.declarations.length !== 1 ||
    !(transportDeclaration.parent.flags & ts.NodeFlags.Const)
  ) {
    errors.push(
      'transport must be the one top-level const pinSendTransport(http, effectiveCommitGuard)',
    );
  }

  const rcsChatBindings = bindingDeclarationsNamed(declaration.body, 'rcsChat').filter(
    ts.isVariableDeclaration,
  );
  const rcsChatBinding = rcsChatBindings[0];
  const rcsChatCall =
    rcsChatBinding?.initializer && ts.isCallExpression(rcsChatBinding.initializer)
      ? rcsChatBinding.initializer
      : undefined;
  const rcsChatStatement = rcsChatBinding?.parent?.parent;
  const plainHeaderBinding = bindingDeclarationsNamed(
    declaration.body,
    'candidatePlainTextHeader',
  )[0];
  const plainHeaderStatement = plainHeaderBinding?.parent?.parent;
  const plainProofBinding = bindingDeclarationsNamed(declaration.body, 'provenPlainTextChat')[0];
  const plainProofStatement = plainProofBinding?.parent?.parent;
  if (
    plainHeaderStatement?.parent !== declaration.body ||
    plainProofStatement?.parent !== declaration.body ||
    !hasExactCompactText(
      plainHeaderStatement,
      sourceFile,
      `const candidatePlainTextHeader =
        !rcsChat && target == null ? await getChatHeader(db, args.chatGuid) : null;`,
    ) ||
    !hasExactCompactText(
      plainProofStatement,
      sourceFile,
      'const provenPlainTextChat = isProvenOneToOneIMessageChat(candidatePlainTextHeader);',
    )
  ) {
    errors.push('plain-text admission must prove an existing one-to-one non-RCS, non-reply chat');
  }
  const capabilityCalls = callsNamed(declaration.body, new Set(['resolveRcsAttemptOwnership']));
  const capabilityCall = capabilityCalls[0];
  const capabilityAwait = capabilityCall?.parent;
  const capabilityDeclaration =
    capabilityAwait && ts.isAwaitExpression(capabilityAwait) ? capabilityAwait.parent : undefined;
  const capabilityStatement =
    capabilityDeclaration && ts.isVariableDeclaration(capabilityDeclaration)
      ? capabilityDeclaration.parent?.parent
      : undefined;
  if (
    rcsChatBindings.length !== 1 ||
    !rcsChatBinding ||
    !rcsChatCall ||
    directCallName(rcsChatCall) !== 'isRcsChatGuid' ||
    rcsChatCall.arguments.length !== 1 ||
    !isDirectPropertyAccess(rcsChatCall.arguments[0], 'args', 'chatGuid') ||
    !rcsChatStatement ||
    !ts.isVariableStatement(rcsChatStatement) ||
    rcsChatStatement.parent !== declaration.body ||
    capabilityCalls.length !== 1 ||
    !capabilityCall ||
    !capabilityAwait ||
    !ts.isAwaitExpression(capabilityAwait) ||
    !capabilityDeclaration ||
    !ts.isVariableDeclaration(capabilityDeclaration) ||
    !ts.isIdentifier(capabilityDeclaration.name) ||
    capabilityDeclaration.name.text !== 'capability' ||
    capabilityDeclaration.initializer !== capabilityAwait ||
    capabilityCall.arguments.length !== 5 ||
    !isDirectPropertyAccess(capabilityCall.arguments[0], 'transport', 'http') ||
    !isDirectPropertyAccess(capabilityCall.arguments[1], 'args', 'chatGuid') ||
    !isDirectPropertyAccess(capabilityCall.arguments[2], 'transport', 'admissionGuard') ||
    !isIdentifierArgument(capabilityCall, 3, 'capabilitySource') ||
    !isExactTextCapabilityOptions(capabilityCall.arguments[4], sourceFile) ||
    !capabilityStatement ||
    !ts.isVariableStatement(capabilityStatement) ||
    capabilityStatement.parent !== declaration.body
  ) {
    errors.push(
      'RCS classification and attempt capability must use the pinned transport and require ServerInfo exactly for RCS or replies or proven plain-text chats',
    );
  }

  const capabilityGuardCalls = callsNamed(declaration.body, new Set(['sendCapabilityCommitGuard']));
  const capabilityGuardCall = capabilityGuardCalls[0];
  const capabilityGuardDeclaration = capabilityGuardCall?.parent;
  const capabilityGuardStatement = capabilityGuardDeclaration?.parent?.parent;
  if (
    capabilityGuardCalls.length !== 1 ||
    !capabilityGuardCall ||
    capabilityGuardCall.arguments.length !== 2 ||
    !isDirectPropertyAccess(capabilityGuardCall.arguments[0], 'transport', 'admissionGuard') ||
    !isIdentifierArgument(capabilityGuardCall, 1, 'capabilitySource') ||
    !capabilityGuardDeclaration ||
    !ts.isVariableDeclaration(capabilityGuardDeclaration) ||
    !ts.isIdentifier(capabilityGuardDeclaration.name) ||
    capabilityGuardDeclaration.name.text !== 'capabilityGuard' ||
    capabilityGuardDeclaration.initializer !== capabilityGuardCall ||
    !capabilityGuardStatement ||
    !ts.isVariableStatement(capabilityGuardStatement) ||
    capabilityGuardStatement.parent !== declaration.body
  ) {
    errors.push(
      'capabilityGuard must be the one top-level sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource) binding',
    );
  }

  const capabilityGuardIndex = capabilityGuardStatement
    ? bodyStatements.indexOf(capabilityGuardStatement)
    : -1;
  const rcsSupportStatement =
    capabilityGuardIndex >= 0 ? bodyStatements[capabilityGuardIndex + 1] : undefined;
  if (
    !isExactThrowGuard(
      rcsSupportStatement,
      sourceFile,
      'rcsChat&&capability.serverInfo?.rcs!==true',
      'RcsCapabilityUnavailableError',
      'This server cannot send RCS messages without RCS support.',
    )
  ) {
    errors.push('RCS must require capability.serverInfo.rcs === true before durable admission');
  }

  const targetAuthorizationBindings = bindingDeclarationsNamed(
    declaration.body,
    'targetAuthorization',
  ).filter(ts.isVariableDeclaration);
  const targetAuthorizationBinding = targetAuthorizationBindings[0];
  const targetAuthorizationStatement = targetAuthorizationBinding?.parent?.parent;
  const authorizedTargetBindings = bindingDeclarationsNamed(
    declaration.body,
    'authorizedTarget',
  ).filter(ts.isVariableDeclaration);
  const authorizedTargetBinding = authorizedTargetBindings[0];
  const authorizedTargetStatement = authorizedTargetBinding?.parent?.parent;
  const authorizedTargetIndex = authorizedTargetStatement
    ? bodyStatements.indexOf(authorizedTargetStatement)
    : -1;
  const replyProofStatement =
    authorizedTargetIndex >= 0 ? bodyStatements[authorizedTargetIndex + 1] : undefined;
  const replyProofBlock =
    replyProofStatement && ts.isIfStatement(replyProofStatement)
      ? replyProofStatement.thenStatement
      : undefined;
  const replyCapabilityStatement =
    replyProofBlock && ts.isBlock(replyProofBlock) ? replyProofBlock.statements[0] : undefined;
  const headerStatement =
    replyProofBlock && ts.isBlock(replyProofBlock) ? replyProofBlock.statements[1] : undefined;
  const headerCurrentStatement =
    replyProofBlock && ts.isBlock(replyProofBlock) ? replyProofBlock.statements[2] : undefined;
  const oneToOneStatement =
    replyProofBlock && ts.isBlock(replyProofBlock) ? replyProofBlock.statements[3] : undefined;
  const headerCalls = callsNamed(declaration.body, new Set(['getChatHeader']));
  const oneToOneCalls = callsNamed(declaration.body, new Set(['isProvenOneToOneIMessageChat']));
  if (
    targetAuthorizationBindings.length !== 1 ||
    !targetAuthorizationBinding ||
    !targetAuthorizationStatement ||
    !ts.isVariableStatement(targetAuthorizationStatement) ||
    targetAuthorizationStatement.parent !== declaration.body ||
    !hasExactCompactText(
      targetAuthorizationBinding.initializer,
      sourceFile,
      `target
        ? Object.freeze({ allowsLegacyPartZero: false, isCurrent: capabilityGuard })
        : undefined`,
    ) ||
    authorizedTargetBindings.length !== 1 ||
    !authorizedTargetBinding ||
    !authorizedTargetStatement ||
    !ts.isVariableStatement(authorizedTargetStatement) ||
    authorizedTargetStatement.parent !== declaration.body ||
    !hasExactCompactText(
      authorizedTargetBinding.initializer,
      sourceFile,
      'target ? { ...target, serverAuthorization: targetAuthorization } : null',
    )
  ) {
    errors.push(
      'reply authorization must fail closed on exact topology and the same current capability guard',
    );
  }
  if (
    !replyProofStatement ||
    !ts.isIfStatement(replyProofStatement) ||
    !ts.isIdentifier(replyProofStatement.expression) ||
    replyProofStatement.expression.text !== 'authorizedTarget' ||
    !replyProofBlock ||
    !ts.isBlock(replyProofBlock) ||
    replyProofBlock.statements.length !== 4 ||
    !isExactThrowGuard(
      replyCapabilityStatement,
      sourceFile,
      'capability.serverInfo?.supports_imessage_replies!==true',
      'Error',
      'This server cannot send iMessage replies.',
    ) ||
    headerCalls.length !== 2 ||
    !hasExactCompactText(
      headerStatement,
      sourceFile,
      'const header = await getChatHeader(db, args.chatGuid);',
    ) ||
    !hasExactCompactText(
      headerCurrentStatement,
      sourceFile,
      'if (!capabilityGuard()) throw new DbCommitGuardRejectedError();',
    ) ||
    oneToOneCalls.length !== 2 ||
    !isExactThrowGuard(
      oneToOneStatement,
      sourceFile,
      '!isProvenOneToOneIMessageChat(header)',
      'Error',
      'A proven existing one-to-one iMessage chat is required.',
    )
  ) {
    errors.push(
      'reply admission must require the exact reply capability, its current lease, and a proven existing one-to-one iMessage header',
    );
  }

  const plainRouteBinding = bindingDeclarationsNamed(declaration.body, 'useIMessagePlainText')[0];
  const plainRouteStatement = plainRouteBinding?.parent?.parent;
  const plainRouteIndex = plainRouteStatement ? bodyStatements.indexOf(plainRouteStatement) : -1;
  const plainValidationStatement = bodyStatements[plainRouteIndex + 1];
  if (
    plainRouteStatement?.parent !== declaration.body ||
    !hasExactCompactText(
      plainRouteStatement,
      sourceFile,
      `const useIMessagePlainText =
        provenPlainTextChat && capability.serverInfo?.supports_imessage_plain_text === true;`,
    ) ||
    callsNamed(declaration.body, new Set(['requireIMessagePlainTextRequest'])).length !== 1 ||
    !hasExactCompactText(
      plainValidationStatement,
      sourceFile,
      `if (useIMessagePlainText) {
        requireIMessagePlainTextRequest({ chatGuid: args.chatGuid, message: args.text, tempGuid });
      }`,
    )
  ) {
    errors.push(
      'plain-text route must require the exact proven chat and capability, then validate before ownership',
    );
  }

  const outgoingBindings = bindingDeclarationsNamed(declaration.body, 'outgoing').filter(
    ts.isVariableDeclaration,
  );
  const outgoingBinding = outgoingBindings[0];
  const outgoingStatement = outgoingBinding?.parent?.parent;
  const outgoingProperties =
    outgoingBinding?.initializer && ts.isObjectLiteralExpression(outgoingBinding.initializer)
      ? outgoingBinding.initializer.properties
      : [];
  const [
    tempGuidProperty,
    chatGuidProperty,
    textProperty,
    nowProperty,
    selectedMessageProperty,
    partIndexProperty,
    threadOriginatorProperty,
    attemptAwareProperty,
    plainTextProperty,
  ] = outgoingProperties;
  if (
    outgoingBindings.length !== 1 ||
    !outgoingBinding ||
    !outgoingStatement ||
    !ts.isVariableStatement(outgoingStatement) ||
    outgoingStatement.parent !== declaration.body ||
    outgoingProperties.length !== 9 ||
    !tempGuidProperty ||
    !ts.isShorthandPropertyAssignment(tempGuidProperty) ||
    tempGuidProperty.name.text !== 'tempGuid' ||
    !chatGuidProperty ||
    !ts.isPropertyAssignment(chatGuidProperty) ||
    propertyNameText(chatGuidProperty) !== 'chatGuid' ||
    !isDirectPropertyAccess(chatGuidProperty.initializer, 'args', 'chatGuid') ||
    !textProperty ||
    !ts.isPropertyAssignment(textProperty) ||
    propertyNameText(textProperty) !== 'text' ||
    !isDirectPropertyAccess(textProperty.initializer, 'args', 'text') ||
    !nowProperty ||
    !ts.isShorthandPropertyAssignment(nowProperty) ||
    nowProperty.name.text !== 'now' ||
    !selectedMessageProperty ||
    !ts.isPropertyAssignment(selectedMessageProperty) ||
    propertyNameText(selectedMessageProperty) !== 'selectedMessageGuid' ||
    !isDirectOptionalPropertyAccess(selectedMessageProperty.initializer, 'target', 'messageGuid') ||
    !partIndexProperty ||
    !ts.isPropertyAssignment(partIndexProperty) ||
    propertyNameText(partIndexProperty) !== 'partIndex' ||
    !isDirectOptionalPropertyAccess(partIndexProperty.initializer, 'target', 'partIndex') ||
    !threadOriginatorProperty ||
    !ts.isPropertyAssignment(threadOriginatorProperty) ||
    propertyNameText(threadOriginatorProperty) !== 'threadOriginatorGuid' ||
    !isDirectOptionalPropertyAccess(
      threadOriginatorProperty.initializer,
      'target',
      'messageGuid',
    ) ||
    !attemptAwareProperty ||
    !ts.isPropertyAssignment(attemptAwareProperty) ||
    propertyNameText(attemptAwareProperty) !== 'attemptAware' ||
    !isDirectPropertyAccess(attemptAwareProperty.initializer, 'capability', 'attemptAware') ||
    !plainTextProperty ||
    !ts.isPropertyAssignment(plainTextProperty) ||
    propertyNameText(plainTextProperty) !== 'imessagePlainTextV1' ||
    !ts.isIdentifier(plainTextProperty.initializer) ||
    plainTextProperty.initializer.text !== 'useIMessagePlainText'
  ) {
    errors.push(
      'outgoing text must contain only the canonical ordinary fields, exact reply identity, and pinned attempt capability',
    );
  }

  const handoffCalls = callsNamed(declaration.body, new Set(['handoverScheduledTextToOutgoing']));
  const handoffCall = handoffCalls[0];
  const ordinaryOwnerCalls = callsNamed(declaration.body, new Set(['withDbTransaction']));
  const ordinaryOwnerCall = ordinaryOwnerCalls[0];
  const tokenBindings = bindingDeclarationsNamed(declaration.body, 'attemptOwnerToken').filter(
    ts.isBindingElement,
  );
  const tokenBinding = tokenBindings[0];
  const tokenPattern = tokenBinding?.parent;
  const ownershipDeclaration = tokenPattern?.parent;
  const ownershipConditional =
    ownershipDeclaration &&
    ts.isVariableDeclaration(ownershipDeclaration) &&
    ownershipDeclaration.initializer &&
    ts.isConditionalExpression(ownershipDeclaration.initializer)
      ? ownershipDeclaration.initializer
      : undefined;
  const ownershipStatement =
    ownershipDeclaration && ts.isVariableDeclaration(ownershipDeclaration)
      ? ownershipDeclaration.parent?.parent
      : undefined;
  const handoffAwait = handoffCall?.parent;
  const ordinaryAwait = ordinaryOwnerCall?.parent;
  if (
    handoffCalls.length !== 1 ||
    !handoffCall ||
    tokenBindings.length !== 1 ||
    !tokenBinding ||
    !!tokenBinding.propertyName ||
    !!tokenBinding.dotDotDotToken ||
    !!tokenBinding.initializer ||
    !ts.isIdentifier(tokenBinding.name) ||
    tokenBinding.name.text !== 'attemptOwnerToken' ||
    !tokenPattern ||
    !ts.isObjectBindingPattern(tokenPattern) ||
    tokenPattern.elements.length !== 1 ||
    !ownershipDeclaration ||
    !ts.isVariableDeclaration(ownershipDeclaration) ||
    !ownershipStatement ||
    !ts.isVariableStatement(ownershipStatement) ||
    ownershipStatement.parent !== declaration.body ||
    ownershipDeclaration.parent.declarations.length !== 1 ||
    !(ownershipDeclaration.parent.flags & ts.NodeFlags.Const) ||
    !ownershipConditional ||
    !ts.isIdentifier(ownershipConditional.condition) ||
    ownershipConditional.condition.text !== 'scheduledHandover' ||
    !handoffAwait ||
    !ts.isAwaitExpression(handoffAwait) ||
    handoffAwait.expression !== handoffCall ||
    ownershipConditional.whenTrue !== handoffAwait ||
    ordinaryOwnerCalls.length !== 1 ||
    !ordinaryOwnerCall ||
    !ordinaryAwait ||
    !ts.isAwaitExpression(ordinaryAwait) ||
    ordinaryAwait.expression !== ordinaryOwnerCall ||
    ownershipConditional.whenFalse !== ordinaryAwait
  ) {
    errors.push(
      'attemptOwnerToken must come from the exact top-level scheduledHandover ? await handoff : await ordinary-owner expression',
    );
  }

  const handoffArgs = handoffCall?.arguments[1];
  const expectedHandoffNames = ['scheduledId', 'transition', 'outgoing'];
  const handoffNames =
    handoffArgs && ts.isObjectLiteralExpression(handoffArgs)
      ? handoffArgs.properties.map(propertyNameText)
      : [];
  const [scheduledIdProperty, transitionProperty, handoffOutgoingProperty] =
    handoffArgs && ts.isObjectLiteralExpression(handoffArgs) ? handoffArgs.properties : [];
  if (
    !handoffCall ||
    handoffCall.arguments.length !== 3 ||
    !isIdentifierArgument(handoffCall, 0, 'db') ||
    !handoffArgs ||
    !ts.isObjectLiteralExpression(handoffArgs) ||
    handoffNames.length !== expectedHandoffNames.length ||
    handoffNames.some((name, index) => name !== expectedHandoffNames[index]) ||
    !isDirectPropertyAssignment(scheduledIdProperty, 'scheduledId', 'scheduledHandover') ||
    !isDirectPropertyAssignment(transitionProperty, 'transition', 'scheduledHandover') ||
    !handoffOutgoingProperty ||
    !ts.isShorthandPropertyAssignment(handoffOutgoingProperty) ||
    handoffOutgoingProperty.name.text !== 'outgoing' ||
    !isIdentifierArgument(handoffCall, 2, 'capabilityGuard')
  ) {
    errors.push(
      'scheduled handoff call must directly pass db, scheduledHandover fields, outgoing, and the combined capabilityGuard',
    );
  }

  const transactionInsertCalls = callsNamed(
    declaration.body,
    new Set(['insertOutgoingTextWithinTransaction']),
  );
  const transactionInsertCall = transactionInsertCalls[0];
  const publicInsertCalls = callsNamed(declaration.body, new Set(['insertOutgoingText']));
  const admissionTargetCalls = callsNamed(
    declaration.body,
    new Set(['resolveMessageTargetWithinTransaction']),
  );
  const ownerCallback = ordinaryOwnerCall?.arguments[1];
  if (
    ordinaryOwnerCalls.length !== 1 ||
    !ordinaryOwnerCall ||
    ordinaryOwnerCall.arguments.length !== 3 ||
    !isIdentifierArgument(ordinaryOwnerCall, 0, 'db') ||
    !isIdentifierArgument(ordinaryOwnerCall, 2, 'capabilityGuard') ||
    !ownerCallback ||
    !ts.isArrowFunction(ownerCallback) ||
    !ownerCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    ownerCallback.parameters.length !== 1 ||
    !ownerCallback.parameters[0] ||
    !ts.isIdentifier(ownerCallback.parameters[0].name) ||
    ownerCallback.parameters[0].name.text !== 'context' ||
    !transactionInsertCall ||
    transactionInsertCalls.length !== 1 ||
    admissionTargetCalls.length !== 1 ||
    !hasExactCompactText(
      ownerCallback,
      sourceFile,
      `async (context) => {
        const resolvedTarget = authorizedTarget
          ? await resolveMessageTargetWithinTransaction(context, authorizedTarget)
          : null;
        if (authorizedTarget && resolvedTarget?.basis !== 'exact-topology') {
          throw new MessageTargetUnavailableError();
        }
        return insertOutgoingTextWithinTransaction(context, {
          ...outgoing,
          selectedMessageGuid: resolvedTarget?.messageGuid,
          partIndex: resolvedTarget?.partIndex,
          threadOriginatorGuid: resolvedTarget?.messageGuid,
        });
      }`,
    ) ||
    publicInsertCalls.length !== 0
  ) {
    errors.push(
      'ordinary text must resolve exact reply topology and use the sole guarded context insert in the false ownership arm',
    );
  }

  const forbiddenTargetCalls = callsNamed(
    declaration.body,
    new Set(['messageTargetServerAuthorization', 'messageTargetCommitGuard']),
  );
  if (forbiddenTargetCalls.length !== 0) {
    errors.push(
      'reply authorization must not use legacy target authorization or commit-guard helpers',
    );
  }

  const effectiveIndex = effectiveStatement ? bodyStatements.indexOf(effectiveStatement) : -1;
  const transportIndex = transportStatement ? bodyStatements.indexOf(transportStatement) : -1;
  const rcsChatIndex = rcsChatStatement ? bodyStatements.indexOf(rcsChatStatement) : -1;
  const capabilityIndex = capabilityStatement ? bodyStatements.indexOf(capabilityStatement) : -1;
  const outgoingIndex = outgoingStatement ? bodyStatements.indexOf(outgoingStatement) : -1;
  const ownershipIndex = ownershipStatement ? bodyStatements.indexOf(ownershipStatement) : -1;
  if (
    targetPartIndex !== 0 ||
    targetIndex !== 1 ||
    bodyStatements[2] !== rcsTargetStatement ||
    bodyStatements[3] !== exactPartStatement ||
    bodyStatements[4] !== replyTextStatement ||
    bodyStatements[5] !== scheduledReplyStatement ||
    retiredRichFieldIndex !== 6 ||
    bodyStatements[7] !== retiredPrivateApiStatement ||
    effectiveIndex !== 9 ||
    transportIndex !== 10 ||
    rcsChatIndex !== 11 ||
    bodyStatements[12] !== plainHeaderStatement ||
    bodyStatements[13] !== plainProofStatement ||
    capabilityIndex !== 14 ||
    capabilityGuardIndex !== 15 ||
    bodyStatements[16] !== rcsSupportStatement ||
    bodyStatements[17] !== targetAuthorizationStatement ||
    bodyStatements[18] !== authorizedTargetStatement ||
    bodyStatements[19] !== replyProofStatement ||
    plainRouteIndex !== 20 ||
    bodyStatements[21] !== plainValidationStatement ||
    outgoingIndex !== 22 ||
    ownershipIndex !== 23
  ) {
    errors.push(
      'reply rejection, rich-field retirement, guards, capabilities, topology proof, outgoing payload, and ownership handoff must remain in reviewed order',
    );
  }

  const onQueuedCalls = callsNamed(declaration.body, new Set(['onQueued']));
  const onQueuedCall = onQueuedCalls[0];
  const onQueuedStatement = onQueuedCall ? directAwaitedCallStatement(onQueuedCall) : undefined;
  if (
    onQueuedCalls.length !== 1 ||
    !onQueuedCall ||
    !onQueuedCall.questionDotToken ||
    onQueuedCall.arguments.length !== 1 ||
    !isIdentifierArgument(onQueuedCall, 0, 'tempGuid') ||
    !onQueuedStatement ||
    ownershipIndex < 0 ||
    bodyStatements[ownershipIndex + 1] !== onQueuedStatement
  ) {
    errors.push(
      'await onQueued?.(tempGuid) must be the first top-level statement after queue ownership',
    );
  }

  const guardStatement = ownershipIndex >= 0 ? bodyStatements[ownershipIndex + 2] : undefined;
  if (
    !isExactThrowGuard(
      guardStatement,
      sourceFile,
      'effectiveCommitGuard&&!effectiveCommitGuard()',
      'DbCommitGuardRejectedError',
    )
  ) {
    errors.push(
      'the exact effective commit-guard rejection must immediately follow onQueued before networking',
    );
  }

  const networkCalls = callsNamed(declaration.body, new Set(['sendText']));
  const networkCall = networkCalls[0];
  const plainNetworkCalls = callsNamed(declaration.body, new Set(['sendIMessagePlainText']));
  const plainNetworkCall = plainNetworkCalls[0];
  let networkTryBlock = networkCall?.parent;
  while (
    networkTryBlock &&
    !(
      ts.isBlock(networkTryBlock) &&
      ts.isTryStatement(networkTryBlock.parent) &&
      networkTryBlock.parent.tryBlock === networkTryBlock
    )
  ) {
    networkTryBlock = networkTryBlock.parent;
  }
  const networkAwait = networkCall?.parent;
  const networkChoice =
    networkAwait && ts.isAwaitExpression(networkAwait) ? networkAwait.parent : undefined;
  const networkDeclaration =
    networkChoice && ts.isConditionalExpression(networkChoice) ? networkChoice.parent : undefined;
  const networkStatement =
    networkDeclaration && ts.isVariableDeclaration(networkDeclaration)
      ? networkDeclaration.parent?.parent
      : undefined;
  const currentnessCalls = propertyCallsNamed(
    declaration.body,
    'transport',
    'assertNetworkCurrent',
  );
  const currentnessCall = currentnessCalls[0];
  const currentnessStatement = currentnessCall?.parent;
  const finalTargetStatement = networkTryBlock?.statements[0];
  const finalTargetGuardStatement = networkTryBlock?.statements[1];
  const postAwaitAccountGuardStatement = networkTryBlock?.statements[3];
  const capabilityCurrentStatement = networkTryBlock?.statements[4];
  const capabilityCurrentCalls = propertyCallsNamed(
    declaration.body,
    'capabilitySource',
    'isCurrent',
  );
  const networkTargetCalls = callsNamed(declaration.body, new Set(['resolveMessageTarget']));
  const retireTargetCalls = callsNamed(
    declaration.body,
    new Set(['retireUnavailableMessageTarget']),
  );
  const methodCalls = callsNamed(declaration.body, new Set(['chooseSendMethod']));
  const methodCall = methodCalls[0];
  const methodBindings = bindingDeclarationsNamed(declaration.body, 'method').filter(
    ts.isVariableDeclaration,
  );
  const methodBinding = methodBindings[0];
  const methodStatement = methodBinding?.parent?.parent;
  const networkStartedStatement = bodyStatements[ownershipIndex + 3];
  const networkStartStatement = networkTryBlock?.statements[6];
  const networkStartAssignment =
    networkStartStatement && ts.isExpressionStatement(networkStartStatement)
      ? networkStartStatement.expression
      : undefined;
  errors.push(
    ...bindingIntegrityErrors(declaration.body, 'networkStarted', {
      allowedAssignment: networkStartAssignment,
      forbidDirectEscape: true,
    }),
  );
  if (
    !hasExactCompactText(networkStartedStatement, sourceFile, 'let networkStarted = false;') ||
    !hasExactCompactText(networkStartStatement, sourceFile, 'networkStarted = true;')
  ) {
    errors.push(
      'networkStarted must start false and be assigned true only immediately before dispatch',
    );
  }
  if (
    networkCalls.length !== 1 ||
    !networkCall ||
    networkCall.arguments.length !== 2 ||
    !isDirectPropertyAccess(networkCall.arguments[0], 'transport', 'http') ||
    !guardStatement ||
    networkCall.getStart(sourceFile) <= guardStatement.getEnd() ||
    !networkAwait ||
    !ts.isAwaitExpression(networkAwait) ||
    plainNetworkCalls.length !== 1 ||
    !plainNetworkCall ||
    plainNetworkCall.arguments.length !== 2 ||
    !hasExactCompactText(
      plainNetworkCall,
      sourceFile,
      'sendIMessagePlainText(transport.http, { chatGuid: args.chatGuid, tempGuid, message: args.text, })',
    ) ||
    !networkChoice ||
    !ts.isConditionalExpression(networkChoice) ||
    !ts.isIdentifier(networkChoice.condition) ||
    networkChoice.condition.text !== 'useIMessagePlainText' ||
    !ts.isAwaitExpression(networkChoice.whenTrue) ||
    networkChoice.whenTrue.expression !== plainNetworkCall ||
    networkChoice.whenFalse !== networkAwait ||
    !networkDeclaration ||
    !ts.isVariableDeclaration(networkDeclaration) ||
    !ts.isIdentifier(networkDeclaration.name) ||
    networkDeclaration.name.text !== 'server' ||
    networkDeclaration.initializer !== networkChoice ||
    networkDeclaration.parent.declarations.length !== 1 ||
    !(networkDeclaration.parent.flags & ts.NodeFlags.Const) ||
    !networkStatement ||
    !ts.isVariableStatement(networkStatement) ||
    !networkTryBlock ||
    !ts.isBlock(networkTryBlock) ||
    networkTryBlock.parent !== bodyStatements[ownershipIndex + 4] ||
    networkTryBlock.parent.parent !== declaration.body ||
    networkTryBlock.statements.length !== 10 ||
    networkTryBlock.parent.finallyBlock != null ||
    networkStatement.parent !== networkTryBlock ||
    currentnessCalls.length !== 1 ||
    !currentnessCall ||
    currentnessCall.questionDotToken ||
    currentnessCall.arguments.length !== 0 ||
    !currentnessStatement ||
    !ts.isExpressionStatement(currentnessStatement) ||
    currentnessStatement.expression !== currentnessCall ||
    currentnessStatement.parent !== networkTryBlock ||
    networkTargetCalls.length !== 1 ||
    retireTargetCalls.length !== 1 ||
    !hasExactCompactText(
      finalTargetStatement,
      sourceFile,
      `const finalTarget = authorizedTarget
        ? await resolveMessageTarget(db, authorizedTarget, capabilityGuard)
        : null;`,
    ) ||
    !hasExactCompactText(
      finalTargetGuardStatement,
      sourceFile,
      `if (authorizedTarget && finalTarget?.basis !== 'exact-topology') {
        await retireUnavailableMessageTarget(db, tempGuid, capabilityGuard);
        return { tempGuid };
      }`,
    ) ||
    networkTryBlock.statements[2] !== currentnessStatement ||
    !isExactThrowGuard(
      postAwaitAccountGuardStatement,
      sourceFile,
      'effectiveCommitGuard&&!effectiveCommitGuard()',
      'DbCommitGuardRejectedError',
    ) ||
    capabilityCurrentCalls.length !== 1 ||
    !isExactThrowGuard(
      capabilityCurrentStatement,
      sourceFile,
      "capabilitySource?.kind==='session'&&!capabilitySource.isCurrent()",
      'DbCommitGuardRejectedError',
    ) ||
    methodCalls.length !== 1 ||
    !methodCall ||
    methodCall.arguments.length !== 1 ||
    methodCall.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
    methodBindings.length !== 1 ||
    !methodBinding ||
    !hasExactCompactText(
      methodBinding.initializer,
      sourceFile,
      'target ? undefined : chooseSendMethod(false)',
    ) ||
    !methodStatement ||
    !ts.isVariableStatement(methodStatement) ||
    methodStatement.parent !== networkTryBlock ||
    networkTryBlock.statements[5] !== methodStatement ||
    networkTryBlock.statements[7] !== networkStatement
  ) {
    errors.push(
      'the one sendText call must follow exact reply topology revalidation, transport currentness, and post-await account/capability checks, exclusively opposite the exact plain-text call',
    );
  }

  const networkPayload = networkCall?.arguments[1];
  const networkProperties =
    networkPayload && ts.isObjectLiteralExpression(networkPayload) ? networkPayload.properties : [];
  const [
    networkChatGuid,
    networkTempGuid,
    generationProperty,
    networkMessage,
    networkSelectedMessage,
    networkPartIndex,
    networkMethod,
  ] = networkProperties;
  if (
    networkProperties.length !== 7 ||
    !networkChatGuid ||
    !ts.isPropertyAssignment(networkChatGuid) ||
    propertyNameText(networkChatGuid) !== 'chatGuid' ||
    !isDirectPropertyAccess(networkChatGuid.initializer, 'args', 'chatGuid') ||
    !networkTempGuid ||
    !ts.isShorthandPropertyAssignment(networkTempGuid) ||
    networkTempGuid.name.text !== 'tempGuid' ||
    !generationProperty ||
    !ts.isPropertyAssignment(generationProperty) ||
    propertyNameText(generationProperty) !== 'clientAttemptGeneration' ||
    !isDirectOptionalPropertyAccess(
      generationProperty.initializer,
      'attemptOwnerToken',
      'generation',
    ) ||
    !networkMessage ||
    !ts.isPropertyAssignment(networkMessage) ||
    propertyNameText(networkMessage) !== 'message' ||
    !isDirectPropertyAccess(networkMessage.initializer, 'args', 'text') ||
    !networkSelectedMessage ||
    !ts.isPropertyAssignment(networkSelectedMessage) ||
    propertyNameText(networkSelectedMessage) !== 'selectedMessageGuid' ||
    !isDirectOptionalPropertyAccess(
      networkSelectedMessage.initializer,
      'finalTarget',
      'messageGuid',
    ) ||
    !networkPartIndex ||
    !ts.isPropertyAssignment(networkPartIndex) ||
    propertyNameText(networkPartIndex) !== 'partIndex' ||
    !isDirectOptionalPropertyAccess(networkPartIndex.initializer, 'finalTarget', 'partIndex') ||
    !networkMethod ||
    !ts.isShorthandPropertyAssignment(networkMethod) ||
    networkMethod.name.text !== 'method'
  ) {
    errors.push(
      'sendText must receive only the canonical chat, temp id, attempt generation, message, exact resolved reply target, and ordinary-only method',
    );
  }

  const replyAckStatement = networkTryBlock?.statements[8];
  if (
    !hasExactCompactText(
      replyAckStatement,
      sourceFile,
      `if (
        target &&
        (typeof server.guid !== 'string' ||
          server.guid.trim().length === 0 ||
          server.guid.trim() !== server.guid ||
          server.guid === tempGuid ||
          server.guid === finalTarget?.messageGuid ||
          utf8Encode(server.guid).byteLength > 1_024 ||
          utf8Decode(utf8Encode(server.guid)) !== server.guid ||
          server.viaPrivateApi !== true)
      ) {
        throw new ApiError('parse_error', 'iMessage reply acknowledgement was incomplete');
      }`,
    )
  ) {
    errors.push('an iMessage reply must require the exact bounded private-API acknowledgement');
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
  const retrySafeStatement = catchClause?.block.statements[1];
  if (
    reconcileCalls.length !== 1 ||
    !reconcileCalls[0] ||
    reconcileCalls[0].arguments.length !== 6 ||
    !isIdentifierArgument(reconcileCalls[0], 4, 'effectiveCommitGuard') ||
    !isExactSuccessSettlementOptions(reconcileCalls[0].arguments[5]) ||
    directAwaitedCallStatement(reconcileCalls[0]) !== networkTryBlock?.statements[9] ||
    failureCalls.length !== 1 ||
    !failureCall ||
    failureCall.arguments.length !== 8 ||
    !isIdentifierArgument(failureCall, 6, 'effectiveCommitGuard') ||
    !isExactTextFailureOptions(failureCall.arguments[7], sourceFile) ||
    catchClauses.length !== 1 ||
    !catchClause ||
    networkTryBlock?.parent.catchClause !== catchClause ||
    catchClause.block.statements.length !== 3 ||
    !catchVariable ||
    !ts.isIdentifier(catchVariable) ||
    catchVariable.text !== 'e' ||
    !hasExactCompactText(
      rethrow,
      sourceFile,
      `if (e instanceof DbCommitGuardRejectedError) {
        if (!useIMessagePlainText || networkStarted || (effectiveCommitGuard && !effectiveCommitGuard())) {
          throw e;
        }
      }`,
    ) ||
    !hasExactCompactText(
      retrySafeStatement,
      sourceFile,
      `const retrySafePlainText =
        useIMessagePlainText && (!networkStarted || isRetryableIMessagePlainTextUnavailable(e));`,
    ) ||
    callsNamed(declaration.body, new Set(['isRetryableIMessagePlainTextUnavailable'])).length !==
      1 ||
    !failureStatement ||
    failureStatement.parent !== catchClause.block ||
    catchClause.block.statements[2] !== failureStatement
  ) {
    errors.push(
      'success and failure settlement must retain guarded ownership, with replies retired as one-shot uncertain outcomes and ownership rejection rethrown first; plain sends retry only before dispatch or with the canonical unavailable proof',
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
export function scheduledRecoverySourceErrors(
  source,
  { expectedBodyHash, expectedReserveBodyHash, expectedEnsureBodyHash } = {},
) {
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
  errors.push(...scheduledCreationErrors(sourceFile));
  if (expectedBodyHash && functionBodyHash(declaration, sourceFile) !== expectedBodyHash) {
    errors.push('runDueScheduled no longer matches its reviewed AST body fingerprint');
  }
  const reserve = topLevelFunction(sourceFile, 'reserveScheduledRun');
  if (reserve.matches.length !== 1 || !reserve.declaration?.body) {
    errors.push('reserveScheduledRun must be one top-level function declaration');
  } else if (
    expectedReserveBodyHash &&
    functionBodyHash(reserve.declaration, sourceFile) !== expectedReserveBodyHash
  ) {
    errors.push('reserveScheduledRun no longer matches its reviewed AST body fingerprint');
  }
  const ensure = exportedFunction(sourceFile, 'ensureScheduledRecovery');
  if (ensure.matches.length !== 1 || !ensure.declaration?.body) {
    errors.push('ensureScheduledRecovery must be one exported top-level function declaration');
  } else if (
    expectedEnsureBodyHash &&
    functionBodyHash(ensure.declaration, sourceFile) !== expectedEnsureBodyHash
  ) {
    errors.push('ensureScheduledRecovery no longer matches its reviewed AST body fingerprint');
  }

  const serializedTry = declaration.body.statements[2];
  const serializedWork =
    serializedTry && ts.isTryStatement(serializedTry) ? serializedTry.tryBlock : undefined;
  if (
    declaration.body.statements.length !== 3 ||
    !serializedTry ||
    !ts.isTryStatement(serializedTry) ||
    serializedTry.catchClause ||
    !serializedTry.finallyBlock
  ) {
    errors.push('runDueScheduled must keep one outer serialized try/finally owner');
  }

  const recoveryCalls = callsNamed(declaration.body, new Set(['ensureScheduledRecovery']));
  if (recoveryCalls.length !== 1) {
    errors.push(
      `runDueScheduled must call ensureScheduledRecovery exactly once (found ${recoveryCalls.length})`,
    );
  }
  const recovery = recoveryCalls[0];
  if (recovery) {
    if (!serializedWork || !isExactTopLevelRecoveryAwait(recovery, serializedWork)) {
      errors.push(
        'ensureScheduledRecovery must be an unconditional awaited statement inside the serialized owner',
      );
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
    const earlierStatements = (serializedWork?.statements ?? []).filter(
      (statement) => statement.getStart(sourceFile) < recoveryStatement.getStart(sourceFile),
    );
    const exactSerializedPrefix =
      earlierStatements.length === 2 &&
      normalizedNodeText(earlierStatements[0], sourceFile) === 'await reservation.waitForTurn;' &&
      normalizedNodeText(earlierStatements[1], sourceFile) ===
        'assertScheduledScope(accountScope);';
    if (!exactSerializedPrefix) {
      errors.push(
        'scheduled recovery must wait for the reserved FIFO turn before its initial account-scope assertion',
      );
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

export function scheduledReserveRunBodyHash(source) {
  const sourceFile = ts.createSourceFile(
    SCHEDULE_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = topLevelFunction(sourceFile, 'reserveScheduledRun');
  if (matches.length !== 1 || !declaration?.body) {
    throw new Error('reserveScheduledRun must be one top-level function declaration');
  }
  return functionBodyHash(declaration, sourceFile);
}

export function scheduledEnsureRecoveryBodyHash(source) {
  const sourceFile = ts.createSourceFile(
    SCHEDULE_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { matches, declaration } = exportedFunction(sourceFile, 'ensureScheduledRecovery');
  if (matches.length !== 1 || !declaration?.body) {
    throw new Error('ensureScheduledRecovery must be one exported top-level function declaration');
  }
  return functionBodyHash(declaration, sourceFile);
}

function exactCallErrors(findings, { label, target, path, symbol, count = 1 }) {
  const uses = findings.filter((finding) => finding.target === target);
  if (uses.length !== count) {
    const expectedCount = count === 1 ? 'one' : String(count);
    return [`${label} must have exactly ${expectedCount} production uses (found ${uses.length})`];
  }
  if (
    uses.some(
      (use) => use.operation !== 'mutator-call' || use.path !== path || use.symbol !== symbol,
    )
  ) {
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

function matchesScheduledCapabilityFactory(call, kind) {
  const factory = call.arguments[6];
  if (kind === 'session') {
    return (
      isIdentifierArgument(call, 5, 'undefined') &&
      !!factory &&
      ts.isIdentifier(factory) &&
      factory.text === 'captureSessionRcsCapabilityLease'
    );
  }
  if (kind === 'fixed') {
    if (
      !factory ||
      !ts.isArrowFunction(factory) ||
      factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      factory.parameters.length !== 0 ||
      !ts.isCallExpression(factory.body) ||
      directCallName(factory.body) !== 'fixedRcsCapabilitySource' ||
      factory.body.questionDotToken ||
      factory.body.arguments.length !== 1
    ) {
      return false;
    }
    return isIdentifierArgument(factory.body, 0, 'serverInfo');
  }
  return true;
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
  const runDeclaration = call.parent;
  const declarationList = runDeclaration?.parent;
  const runStatement = declarationList?.parent;
  const tryBlock = runStatement?.parent;
  const tryStatement = tryBlock?.parent;
  if (
    !ts.isVariableDeclaration(runDeclaration) ||
    !ts.isIdentifier(runDeclaration.name) ||
    runDeclaration.name.text !== 'run' ||
    runDeclaration.initializer !== call ||
    !ts.isVariableDeclarationList(declarationList) ||
    !(declarationList.flags & ts.NodeFlags.Const) ||
    declarationList.declarations.length !== 1 ||
    !ts.isVariableStatement(runStatement) ||
    !ts.isBlock(tryBlock) ||
    !tryBlock.statements.includes(runStatement) ||
    !ts.isTryStatement(tryStatement) ||
    tryStatement.tryBlock !== tryBlock ||
    tryStatement.parent !== task.body
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
    'executeBackgroundSyncTask',
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
  const homeEffectHash = homeEffect ? syntaxHash(homeEffect, homeSource) : '<missing>';
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
    homeEffectHash !== REVIEWED_SCHEDULED_SYNTAX_HASHES.get(`${HOME_PATH}#Home.scheduledEffect`)
  ) {
    errors.push(
      `${HOME_PATH}#Home no longer matches its reviewed live scheduled-effect owner ` +
        `(expected ${REVIEWED_SCHEDULED_SYNTAX_HASHES.get(`${HOME_PATH}#Home.scheduledEffect`)}; actual ${homeEffectHash})`,
    );
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

  for (const [path, expectedHash] of REVIEWED_CALLBACK_DEPENDENCY_FILE_HASHES) {
    const sourceFile = sourceFiles.get(path);
    const actualHash = sourceFile ? syntaxHash(sourceFile, sourceFile) : '<missing>';
    if (actualHash !== expectedHash) {
      errors.push(
        `${path} no longer matches its reviewed REL-001 callback dependency fingerprint ` +
          `(expected ${expectedHash}; actual ${actualHash})`,
      );
    }
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
    [SEND_COMPOSITION_PATH, 'captureSessionRcsCapabilityLease', './rcsAttemptCapability'],
    [BACKGROUND_SYNC_PATH, 'runTrackedRealtimeWork', '../realtime/deliveryCoordinator'],
    [BACKGROUND_SYNC_PATH, 'runBackgroundSync', './backgroundSyncOrchestrator'],
    [BACKGROUND_SYNC_PATH, 'fixedRcsCapabilitySource', '../send/rcsAttemptCapability'],
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
          (expected.scope && !isIdentifierArgument(node, expected.scopeIndex, expected.scope)) ||
          (expected.capabilityFactory &&
            !matchesScheduledCapabilityFactory(node, expected.capabilityFactory))
        ) {
          errors.push(
            `${path}#${owner} must call ${symbol} with ${expected.argumentCount} arguments${expected.scope ? ` and explicit ${expected.scope} account scope` : ''}${expected.capabilityFactory ? ' and the reviewed capability-source factory' : ''}`,
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
      expectedReserveBodyHash: REVIEWED_RESERVE_SCHEDULED_RUN_BODY_HASH,
      expectedEnsureBodyHash: REVIEWED_ENSURE_SCHEDULED_RECOVERY_BODY_HASH,
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
