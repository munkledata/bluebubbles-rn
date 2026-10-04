import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  runScheduledRecoveryCheck,
  scheduledRecoveryCallGraphErrors,
  scheduledRecoverySourceErrors,
  scheduledHandoffSourceErrors,
  scheduledRunnerUsageErrors,
  scheduledEnsureRecoveryBodyHash,
  scheduledReserveRunBodyHash,
  scheduledRunDueBodyHash,
  scheduledSendTextBodyHash,
} from './check-scheduled-recovery.mjs';

const schedulePath = 'src/services/send/scheduleService.ts';
const sendPath = 'src/services/send/sendService.ts';
const validSource = readFileSync(schedulePath, 'utf8');
const validSendServiceSource = readFileSync(sendPath, 'utf8');

const runnerPaths = [
  'app/(app)/home.tsx',
  'app/(app)/chat/[guid].tsx',
  'src/features/conversations/useChatScheduledCatchup.ts',
  'src/services/background/backgroundSync.ts',
  'src/native/backgroundTaskExecution.ts',
  'src/services/background/registerBackgroundSyncHeadlessTask.ts',
  'src/services/background/backgroundSyncOrchestrator.ts',
  'src/services/send/outgoingQueueService.ts',
  'src/services/send/attachmentUpload.ts',
  'src/utils/uploadFilename.ts',
  'src/core/api/http.ts',
  'src/services/send/index.ts',
  schedulePath,
];
const validRunnerSources = runnerPaths.map((path) => ({
  path,
  source: readFileSync(path, 'utf8'),
}));

const expectedFindings = [
  {
    path: schedulePath,
    symbol: 'recoverInterruptedScheduledRows',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#resetStuckScheduled',
  },
  {
    path: schedulePath,
    symbol: 'runDueScheduled',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
  },
  {
    path: sendPath,
    symbol: 'sendTextMessage',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#handoverScheduledTextToOutgoing',
  },
  {
    path: sendPath,
    symbol: 'sendTextMessage.<callback:abc123>',
    operation: 'mutator-call',
    target: 'src/db/repositories/outgoing.ts#insertOutgoingTextWithinTransaction',
  },
];

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'expected one mutation target: ' + before);
  return source.replace(before, after);
}

function mutateRunnerSource(path, mutate) {
  return validRunnerSources.map((entry) =>
    entry.path === path ? { ...entry, source: mutate(entry.source) } : entry,
  );
}

function assertErrors(errors, expected) {
  assert.match(errors.join('\n'), expected);
}

test('accepts the current one-claim scheduled recovery and text handoff design', () => {
  assert.deepEqual(scheduledRecoverySourceErrors(validSource), []);
  assert.deepEqual(scheduledHandoffSourceErrors(validSendServiceSource), []);
  assert.deepEqual(scheduledRecoveryCallGraphErrors(expectedFindings), []);
});

test('requires one early unconditional recovery barrier', () => {
  const barrier = '    await ensureScheduledRecovery(db, accountScope, maxRows);\n';
  assertErrors(
    scheduledRecoverySourceErrors(replaceOnce(validSource, barrier, '')),
    /exactly once/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        barrier.trimEnd(),
        '    if (accountScope) await ensureScheduledRecovery(db, accountScope, maxRows);',
      ),
    ),
    /unconditional awaited statement inside the serialized owner/,
  );
  const delayed = replaceOnce(
    replaceOnce(validSource, barrier, ''),
    '    const due = await listDueScheduled(db, now, maxRows, true);',
    '    const due = await listDueScheduled(db, now, maxRows, true);\n' + barrier.trimEnd(),
  );
  assertErrors(scheduledRecoverySourceErrors(delayed), /before due-list or claim/);
});

test('requires exactly one closed-world claim owner and one atomic handoff owner', () => {
  const extraClaim = [
    ...expectedFindings,
    {
      path: 'src/services/send/other.ts',
      symbol: 'claimElsewhere',
      operation: 'mutator-call',
      target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
    },
  ];
  assertErrors(scheduledRecoveryCallGraphErrors(extraClaim), /exactly one.*found 2/);
  assertErrors(
    scheduledRecoveryCallGraphErrors(
      expectedFindings.filter(
        (finding) => !finding.target.endsWith('#handoverScheduledTextToOutgoing'),
      ),
    ),
    /handoverScheduledTextToOutgoing.*found 0/,
  );
  const aliased = expectedFindings.map((finding, index) =>
    index === 1 ? { ...finding, operation: 'mutator-reference' } : finding,
  );
  assertErrors(scheduledRecoveryCallGraphErrors(aliased), /references and aliases are forbidden/);
});

test('forbids every production use of the retired broad claim helper', () => {
  const findings = [
    ...expectedFindings,
    {
      path: 'src/services/send/legacyScheduler.ts',
      symbol: 'legacyClaim',
      operation: 'mutator-call',
      target: 'src/db/repositories/scheduled.ts#claimScheduled',
    },
  ];
  assertErrors(scheduledRecoveryCallGraphErrors(findings), /broad claimScheduled helper.*found 1/);
});

test('requires the exact one-claim inputs', () => {
  const claim = 'claimDueScheduled(db, candidate.id, now, commitGuard)';
  for (const replacement of [
    'claimDueScheduled(db, candidate.chatGuid, now, commitGuard)',
    'claimDueScheduled(db, candidate.id, Date.now(), commitGuard)',
    'claimDueScheduled(db, candidate.id, now, undefined)',
    'claimDueScheduled(db, candidate.id, now)',
  ]) {
    assertErrors(
      scheduledRecoverySourceErrors(replaceOnce(validSource, claim, replacement)),
      /claimDueScheduled must be exactly/,
    );
  }
});

test('captures one immutable capability source immediately before the claim', () => {
  const capture = '      const capabilitySource = captureCapabilitySource?.();';
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, capture, '      const capabilitySource = undefined;'),
    ),
    /capture one immutable capabilitySource/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, capture, capture + '\n      captureCapabilitySource?.();'),
    ),
    /capture one immutable capabilitySource/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, capture, capture + '\n      void candidate.id;'),
    ),
    /immediately before its claim/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, capture, capture.replace('const', 'let')),
    ),
    /immutable capabilitySource/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        capture + '\n      try {\n        m = await claimDueScheduled',
        capture +
          '\n      try {\n        await Promise.resolve();\n        m = await claimDueScheduled',
      ),
    ),
    /immediately before its claim/,
  );
});

test('does not allow another capability capture outside the attempt loop', () => {
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '    let fired = 0;',
        '    captureCapabilitySource?.();\n    let fired = 0;',
      ),
    ),
    /capture one immutable capabilitySource/,
  );
});

test('passes the same captured capability source to the scheduled send', () => {
  const sourceArgument = '            capabilitySource,\n          );';
  for (const replacement of [
    '            undefined,\n          );',
    '            captureCapabilitySource?.(),\n          );',
    '            otherCapabilitySource,\n          );',
  ]) {
    assertErrors(
      scheduledRecoverySourceErrors(replaceOnce(validSource, sourceArgument, replacement)),
      /capability snapshot captured before its claim/,
    );
  }
});

test('sends only the claimed chat and text', () => {
  const payload =
    '            {\n              chatGuid: m.chatGuid,\n              text: m.text,\n            },';
  for (const replacement of [
    '            {\n              chatGuid: candidate.chatGuid,\n              text: candidate.text,\n            },',
    '            {\n              chatGuid: m.chatGuid,\n              text: m.chatGuid,\n            },',
    '            {\n              chatGuid: m.chatGuid,\n              text: m.text,\n              selectedMessageGuid: m.selectedMessageGuid,\n            },',
    '            payload,',
  ]) {
    assertErrors(
      scheduledRecoverySourceErrors(replaceOnce(validSource, payload, replacement)),
      /payload must be exactly the claimed chat and text/,
    );
  }
});

test('keeps recurrence and atomic handoff tied to the claimed row', () => {
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, 'asRecurrence(m.recurrence)', 'asRecurrence(candidate.recurrence)'),
    ),
    /recurrence must be exactly/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        'nextOccurrence(m.scheduledFor, recurrence, now)',
        'nextOccurrence(candidate.scheduledFor, recurrence, now)',
      ),
    ),
    /rearm time must be exactly/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '{ scheduledId: m.id, transition, commitGuard }',
        '{ scheduledId: candidate.id, transition, commitGuard }',
      ),
    ),
    /claimed row id/,
  );
});

test('rejects mutation or shadowing of the claimed row and handoff bindings', () => {
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '      if (!m) continue;',
        '      if (!m) continue;\n      m = candidate;',
      ),
    ),
    /claimed row may not be/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '        } else {\n          await sendTextMessage(',
        "        } else {\n          const transition = { kind: 'sent' };\n          await sendTextMessage(",
      ),
    ),
    /transition must have exactly one/,
  );
});

test('fails closed on RCS reply targets and retired rich text fields', () => {
  const rcsTarget =
    '  if (target && isRcsChatGuid(args.chatGuid)) {\n' +
    "    throw new Error('This server cannot send an RCS threaded reply.');\n" +
    '  }\n';
  assertErrors(
    scheduledHandoffSourceErrors(replaceOnce(validSendServiceSource, rcsTarget, '')),
    /RCS threaded target/,
  );
  const privateApiBarrier =
    '  if (hasRetiredRichFields) {\n' +
    "    throw new Error('Private API message features were retired in this release.');\n" +
    '  }\n';
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        privateApiBarrier + '  const tempGuid = generateTempGuid();',
        '  const tempGuid = generateTempGuid();',
      ),
    ),
    /Private API-only text features must fail closed/,
  );
});

test('admits only exact part-zero, bounded, well-formed, unscheduled iMessage replies', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '  if (target && target.partIndex !== 0) {',
        '  if (target && target.partIndex < 0) {',
      ),
    ),
    /exact message part zero/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'utf8Encode(args.text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES',
        'args.text.length > MAX_SEND_ATTACHMENT_TEXT_BYTES',
      ),
    ),
    /bounded, nonblank, NUL-free, well-formed plain text/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(validSendServiceSource, "args.text.includes('\\u0000') ||", 'false ||'),
    ),
    /NUL-free/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'utf8Decode(utf8Encode(args.text)) !== args.text ||',
        'false ||',
      ),
    ),
    /well-formed plain text/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '  if (target && scheduledHandover) {',
        '  if (false && scheduledHandover) {',
      ),
    ),
    /remain unscheduled/,
  );
});

test('keeps scheduled replies retired and RCS scheduling local-only', () => {
  const replyBarrier =
    '  if (args.selectedMessageGuid !== undefined || args.selectedMessagePartIndex !== undefined) {\n' +
    "    throw new Error('Scheduled replies were retired in this release.');\n" +
    '  }\n';
  assertErrors(
    scheduledRecoverySourceErrors(replaceOnce(validSource, replyBarrier, '')),
    /reject every scheduled reply target/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '): Promise<{ id: number; serverId: string | null }> {\n  assertScheduledScope(accountScope);\n' +
          '  if (args.selectedMessageGuid',
        '): Promise<{ id: number; serverId: string | null }> {\n  void http;\n' +
          '  if (args.selectedMessageGuid',
      ),
    ),
    /begin with the exact account-scope assertion/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        'if (!isRcsChatGuid(args.chatGuid) && !args.selectedMessageGuid && !args.recurrence)',
        'if (!args.selectedMessageGuid && !args.recurrence)',
      ),
    ),
    /server-side scheduling must remain limited to non-RCS/,
  );
});

test('keeps the send method AppleScript-only', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(validSendServiceSource, "  return 'apple-script';", "  return 'private-api';"),
    ),
    /return only apple-script/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        "export function chooseSendMethod(needsPrivateApi: boolean): 'apple-script' {\n  if (needsPrivateApi)",
        "export function chooseSendMethod(needsPrivateApi: boolean): 'apple-script' {\n  if (false && needsPrivateApi)",
      ),
    ),
    /fail closed for Private API requirements/,
  );
});

test('requires pinned RCS or reply capability before durable admission', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '{ requireServerInfo: rcsChat || target != null || provenPlainTextChat }',
        '{ requireServerInfo: false }',
      ),
    ),
    /require ServerInfo exactly for RCS or replies/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'throw new RcsCapabilityUnavailableError(',
        'throw new Error(',
      ),
    ),
    /RCS must require capability.serverInfo.rcs === true/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource)',
        'sendCapabilityCommitGuard(effectiveCommitGuard, capabilitySource)',
      ),
    ),
    /capabilityGuard must be/,
  );
});

test('requires current reply capability and a proven existing one-to-one header', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'capability.serverInfo?.supports_imessage_replies !== true',
        'capability.serverInfo?.supports_imessage_replies === false',
      ),
    ),
    /exact reply capability/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '    const header = await getChatHeader(db, args.chatGuid);',
        "    const header = await getChatHeader(db, 'other');",
      ),
    ),
    /proven existing one-to-one/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();',
        '    void capabilityGuard;',
      ),
    ),
    /current lease/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'isProvenOneToOneIMessageChat(header)',
        'isProvenOneToOneIMessageChat(undefined)',
      ),
    ),
    /proven existing one-to-one/,
  );
});

test('requires the guarded scheduled handoff and ordinary transaction owner', () => {
  const handoff =
    '          outgoing,\n' + '        },\n' + '        capabilityGuard,\n' + '      )';
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        handoff,
        handoff.replace('capabilityGuard', 'effectiveCommitGuard'),
      ),
    ),
    /scheduled handoff call/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        "          if (authorizedTarget && resolvedTarget?.basis !== 'exact-topology') {",
        '          if (false) {',
      ),
    ),
    /resolve exact reply topology/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '  const outgoing = {',
        '  messageTargetCommitGuard();\n  const outgoing = {',
      ),
    ),
    /must not use legacy target authorization/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        "    if (authorizedTarget && finalTarget?.basis !== 'exact-topology') {",
        '    if (false) {',
      ),
    ),
    /exact reply topology revalidation/,
  );
});

test('checks account, transport, and the same capability source before networking', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        'pinSendTransport(http, effectiveCommitGuard)',
        'pinSendTransport(http, ordinaryCommitGuard)',
      ),
    ),
    /pinSendTransport/,
  );
  const capabilityGuard =
    "    if (capabilitySource?.kind === 'session' && !capabilitySource.isCurrent()) {\n" +
    '      throw new DbCommitGuardRejectedError();\n' +
    '    }\n';
  assertErrors(
    scheduledHandoffSourceErrors(replaceOnce(validSendServiceSource, capabilityGuard, '')),
    /post-await account\/capability checks/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        capabilityGuard,
        capabilityGuard.replace('DbCommitGuardRejectedError', 'Error'),
      ),
    ),
    /post-await account\/capability checks/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(validSendServiceSource, '    transport.assertNetworkCurrent();\n', ''),
    ),
    /post-await account\/capability checks/,
  );
});

test('keeps the exact canonical network payload and guarded settlement', () => {
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '          clientAttemptGeneration: attemptOwnerToken?.generation,\n          message: args.text,',
        '          clientAttemptGeneration: attemptOwnerToken?.generation,\n          message: args.chatGuid,',
      ),
    ),
    /canonical chat, temp id, attempt generation, message, exact resolved reply target/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '      selectedMessageGuid: finalTarget?.messageGuid,',
        '      selectedMessageGuid: target?.messageGuid,',
      ),
    ),
    /exact resolved reply target/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '        server.viaPrivateApi !== true)',
        '        server.viaPrivateApi === false)',
      ),
    ),
    /exact bounded private-API acknowledgement/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(validSendServiceSource, '        networkStarted ||\n', ''),
    ),
    /ownership rejection rethrown first/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {\n' +
          '      attemptOwnerToken: attemptOwnerToken ?? undefined,\n' +
          '      expectedChatGuid: args.chatGuid,\n' +
          '    });',
        '    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {\n' +
          '      attemptOwnerToken: undefined,\n' +
          '      expectedChatGuid: args.chatGuid,\n' +
          '    });',
      ),
    ),
    /success and failure settlement/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '      expectedChatGuid: args.chatGuid,',
        '      expectedChatGuid: undefined,',
      ),
    ),
    /success and failure settlement/,
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        "              ? { terminalUncertainKind: 'reply' as const }",
        '              ? {}',
      ),
    ),
    /one-shot uncertain outcomes/,
  );
});

test('keeps the plain-text route proof, exclusive dispatch, and certified retry boundary', () => {
  const mutations = [
    [
      '!rcsChat && target == null ? await getChatHeader(db, args.chatGuid) : null',
      'await getChatHeader(db, args.chatGuid)',
      /plain-text admission/,
    ],
    [
      'const provenPlainTextChat = isProvenOneToOneIMessageChat(candidatePlainTextHeader);',
      'const provenPlainTextChat = true;',
      /plain-text admission/,
    ],
    [
      'provenPlainTextChat && capability.serverInfo?.supports_imessage_plain_text === true',
      'provenPlainTextChat || capability.serverInfo?.supports_imessage_plain_text === true',
      /plain-text route must require/,
    ],
    [
      '    requireIMessagePlainTextRequest({ chatGuid: args.chatGuid, message: args.text, tempGuid });',
      '',
      /validate before ownership/,
    ],
    [
      '    imessagePlainTextV1: useIMessagePlainText,',
      '    imessagePlainTextV1: false,',
      /outgoing text must contain/,
    ],
    [
      'const server = useIMessagePlainText',
      'const server = false',
      /exclusively opposite the exact plain-text call/,
    ],
    [
      'await sendIMessagePlainText(transport.http, {',
      'await sendIMessagePlainText(http, {',
      /exclusively opposite the exact plain-text call/,
    ],
    [
      '          chatGuid: args.chatGuid,\n          tempGuid,\n          message: args.text,',
      '          chatGuid: args.chatGuid,\n          tempGuid,\n          message: args.text,\n          method,',
      /exclusively opposite the exact plain-text call/,
    ],
    [
      '    networkStarted = true;\n',
      '    networkStarted = false;\n',
      /assigned true only immediately before dispatch/,
    ],
    [
      '    networkStarted = true;\n',
      '    networkStarted = true;\n    const escaped = networkStarted;\n',
      /networkStarted may not be.*escaped/,
    ],
    [
      'useIMessagePlainText && (!networkStarted || isRetryableIMessagePlainTextUnavailable(e))',
      'useIMessagePlainText && (!networkStarted || e instanceof ApiError)',
      /canonical unavailable proof/,
    ],
    [
      '(effectiveCommitGuard && !effectiveCommitGuard())\n      )',
      'false\n      )',
      /ownership rejection rethrown first/,
    ],
    [
      "            ? { terminalUncertainKind: 'plain' as const }",
      '            ? { imessagePlainTextRetrySafe: true }',
      /canonical unavailable proof/,
    ],
    [
      '  isRetryableIMessagePlainTextUnavailable,',
      '  sendText as isRetryableIMessagePlainTextUnavailable,',
      /isRetryableIMessagePlainTextUnavailable must retain its unaliased canonical import/,
    ],
    [
      '    const retrySafePlainText =',
      '    function isRetryableIMessagePlainTextUnavailable() { return true; }\n    const retrySafePlainText =',
      /isRetryableIMessagePlainTextUnavailable must retain its unaliased canonical import/,
    ],
    [
      '  if (useIMessagePlainText) {',
      '  if (useIMessagePlainText) {\n    const useIMessagePlainText = true;',
      /useIMessagePlainText must have exactly one variable binding/,
    ],
    [
      '  const outgoing = {',
      '  const routeAlias = useIMessagePlainText;\n  const outgoing = {',
      /useIMessagePlainText may not be.*escaped/,
    ],
  ];
  for (const [before, after, expected] of mutations) {
    assertErrors(
      scheduledHandoffSourceErrors(replaceOnce(validSendServiceSource, before, after)),
      expected,
    );
  }
});

test('reviewed function fingerprints fail closed on otherwise unchecked edits', () => {
  const runDueHash = scheduledRunDueBodyHash(validSource);
  const reserveRunHash = scheduledReserveRunBodyHash(validSource);
  const ensureRecoveryHash = scheduledEnsureRecoveryBodyHash(validSource);
  const expectedRecoveryHashes = {
    expectedBodyHash: runDueHash,
    expectedReserveBodyHash: reserveRunHash,
    expectedEnsureBodyHash: ensureRecoveryHash,
  };
  assert.deepEqual(scheduledRecoverySourceErrors(validSource, expectedRecoveryHashes), []);
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, '    return fired;', '    void fired;\n    return fired;'),
      expectedRecoveryHashes,
    ),
    /reviewed AST body fingerprint/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '  const waitForTurn = tails.get(key) ?? Promise.resolve();',
        '  const waitForTurn = Promise.resolve();',
      ),
      expectedRecoveryHashes,
    ),
    /reserveScheduledRun no longer matches its reviewed AST body fingerprint/,
  );
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '  if (existing) return existing.promise;',
        '  if (existing && accountScope?.isCurrent()) return existing.promise;',
      ),
      expectedRecoveryHashes,
    ),
    /ensureScheduledRecovery no longer matches its reviewed AST body fingerprint/,
  );

  const sendHash = scheduledSendTextBodyHash(validSendServiceSource);
  assert.deepEqual(
    scheduledHandoffSourceErrors(validSendServiceSource, { expectedBodyHash: sendHash }),
    [],
  );
  assertErrors(
    scheduledHandoffSourceErrors(
      replaceOnce(
        validSendServiceSource,
        '  return { tempGuid };\n}',
        '  void tempGuid;\n  return { tempGuid };\n}',
      ),
      { expectedBodyHash: sendHash },
    ),
    /reviewed AST body fingerprint/,
  );
});

test('rejects bypass or early release of the scheduled-run FIFO', () => {
  const expectedRecoveryHashes = {
    expectedBodyHash: scheduledRunDueBodyHash(validSource),
    expectedReserveBodyHash: scheduledReserveRunBodyHash(validSource),
    expectedEnsureBodyHash: scheduledEnsureRecoveryBodyHash(validSource),
  };
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(
        validSource,
        '    await reservation.waitForTurn;',
        '    void reservation.waitForTurn;',
      ),
      expectedRecoveryHashes,
    ),
    /reviewed AST body fingerprint|reserved FIFO turn/,
  );

  const guardedRelease =
    '    try {\n' +
    '      if (accountScope && !accountScope.isCurrent()) {\n' +
    '        recoveryStatesForDatabase(db as object).delete(recoveryKey);\n' +
    '      }\n' +
    '    } finally {\n' +
    '      reservation.finish();\n' +
    '    }';
  const earlyRelease =
    '    reservation.finish();\n' +
    '    if (accountScope && !accountScope.isCurrent()) {\n' +
    '      recoveryStatesForDatabase(db as object).delete(recoveryKey);\n' +
    '    }';
  assertErrors(
    scheduledRecoverySourceErrors(
      replaceOnce(validSource, guardedRelease, earlyRelease),
      expectedRecoveryHashes,
    ),
    /reviewed AST body fingerprint/,
  );
});

test('accepts all reviewed production scheduler owners', () => {
  assert.deepEqual(scheduledRunnerUsageErrors(validRunnerSources), []);
});

test('requires the background callback to wire its reviewed schedule owner directly', () => {
  const wrapped = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      '      recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,',
      '      recoverAndDrainSchedules: (...args) => recoverAndDrainBackgroundSchedules(...args),',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(wrapped), /background schedule owner directly/);

  const conditional = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      replaceOnce(
        source,
        '    const run = runBackgroundSync({',
        '    const run = true ? runBackgroundSync({',
      ),
      '    });\n\n    owner.continuationFinished = false;',
      '    }) : Promise.reject(new Error());\n\n    owner.continuationFinished = false;',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(conditional), /background schedule owner directly/);

  const earlyExit = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      '    const run = runBackgroundSync({',
      '    return BackgroundTask.BackgroundTaskResult.Success;\n    const run = runBackgroundSync({',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(earlyExit), /reviewed scheduled-owner fingerprint/);

  const unownedRun = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      '    });\n\n    owner.continuationFinished = false;',
      '    });\n\n    return BackgroundTask.BackgroundTaskResult.Success;\n    owner.continuationFinished = false;',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(unownedRun), /reviewed scheduled-owner fingerprint/);

  const detachedOwner = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(source, '    void run\n      .then(', '    void Promise.resolve()\n      .then('),
  );
  assertErrors(scheduledRunnerUsageErrors(detachedOwner), /reviewed scheduled-owner fingerprint/);

  const detachedRace = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      "      run.then((outcome) => ({ kind: 'outcome' as const, outcome })),",
      "      Promise.resolve().then((outcome) => ({ kind: 'outcome' as const, outcome })),",
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(detachedRace), /reviewed scheduled-owner fingerprint/);
});

test('pins the complete background callback lifetime and work graph', () => {
  const widenedDeadline = mutateRunnerSource(
    'src/services/background/backgroundSync.ts',
    (source) =>
      replaceOnce(
        source,
        'BACKGROUND_CALLBACK_WORK_WINDOW_MS = 50_000',
        'BACKGROUND_CALLBACK_WORK_WINDOW_MS = 300_000',
      ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(widenedDeadline),
    /reviewed REL-001 callback dependency fingerprint/,
  );

  const disabledAbort = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      "controller.abort(new Error('Background callback work deadline expired'));",
      'void controller;',
    ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(disabledAbort),
    /reviewed REL-001 callback dependency fingerprint/,
  );
});

test('pins the complete background callback dependency chain', () => {
  for (const [path, before, after] of [
    [
      'src/native/backgroundTaskExecution.ts',
      'if (event?.executionId === executionId) cancel();',
      'if (true) cancel();',
    ],
    [
      'src/services/background/registerBackgroundSyncHeadlessTask.ts',
      'retainBackgroundTaskExecution(body.executionInfo.eventId, body.data?.gatorExecutionId)',
      'null',
    ],
  ]) {
    assertErrors(
      scheduledRunnerUsageErrors(
        mutateRunnerSource(path, (source) => replaceOnce(source, before, after)),
      ),
      /reviewed REL-001 callback dependency fingerprint/,
    );
    assertErrors(
      scheduledRunnerUsageErrors(validRunnerSources.filter((entry) => entry.path !== path)),
      /reviewed REL-001 callback dependency fingerprint/,
    );
  }
  const detachedOutgoingDrain = mutateRunnerSource(
    'src/services/background/backgroundSyncOrchestrator.ts',
    (source) =>
      replaceOnce(
        source,
        '    await deps.drainOutgoing(context.db, context.client, budgetScope, context.serverInfo);',
        '    void deps.drainOutgoing(context.db, context.client, budgetScope, context.serverInfo);',
      ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(detachedOutgoingDrain),
    /reviewed REL-001 callback dependency fingerprint/,
  );

  const droppedHttpLifetimeSignal = mutateRunnerSource('src/core/api/http.ts', (source) =>
    replaceOnce(
      source,
      '    const linkedSignal = linkAbortSignals(opts.signal, this.cfg.lifetimeSignal);',
      '    const linkedSignal = linkAbortSignals(opts.signal, undefined);',
    ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(droppedHttpLifetimeSignal),
    /reviewed REL-001 callback dependency fingerprint/,
  );

  const droppedOutgoingSignal = mutateRunnerSource(
    'src/services/send/outgoingQueueService.ts',
    (source) =>
      replaceOnce(
        source,
        '            signal: attachmentSignal,',
        '            signal: undefined,',
      ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(droppedOutgoingSignal),
    /reviewed REL-001 callback dependency fingerprint/,
  );

  const disabledUploadAbort = mutateRunnerSource(
    'src/services/send/attachmentUpload.ts',
    (source) =>
      replaceOnce(
        source,
        "  const abortFromOwner = (): void => stopAttempt('cancelled');",
        '  const abortFromOwner = (): void => undefined;',
      ),
  );
  assertErrors(
    scheduledRunnerUsageErrors(disabledUploadAbort),
    /reviewed REL-001 callback dependency fingerprint/,
  );
  const unboundedFilename = mutateRunnerSource('src/utils/uploadFilename.ts', (source) =>
    replaceOnce(source, 'name.length > 255', 'name.length > Number.MAX_SAFE_INTEGER'),
  );
  assertErrors(
    scheduledRunnerUsageErrors(unboundedFilename),
    /reviewed REL-001 callback dependency fingerprint/,
  );
  assertErrors(
    scheduledRunnerUsageErrors(
      validRunnerSources.filter((entry) => entry.path !== 'src/utils/uploadFilename.ts'),
    ),
    /uploadFilename/,
  );
});

test('requires explicit foreground and background ownership sources', () => {
  const foreground = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, '        captureSessionRcsCapabilityLease,', '        () => undefined,'),
  );
  assertErrors(scheduledRunnerUsageErrors(foreground), /capability-source factory/);

  const background = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      '      () => fixedRcsCapabilitySource(serverInfo),',
      '      () => fixedRcsCapabilitySource(undefined),',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(background), /capability-source factory/);
});

test('reviewed UI owners reject removal of the scheduled-reply retirement guard', () => {
  for (const path of [
    'app/(app)/home.tsx',
    'src/features/conversations/useChatScheduledCatchup.ts',
  ]) {
    const mutated = mutateRunnerSource(path, (source) =>
      replaceOnce(source, 'if (selectedMessageGuid) {', 'if (false && selectedMessageGuid) {'),
    );
    assertErrors(scheduledRunnerUsageErrors(mutated), /fingerprint|scheduled-effect owner/);
  }
});

test('reviewed UI owners reject reintroduction of the retired reply sender', () => {
  for (const path of [
    'app/(app)/home.tsx',
    'src/features/conversations/useChatScheduledCatchup.ts',
  ]) {
    const mutated = mutateRunnerSource(path, (source) =>
      replaceOnce(source, 'return devSendFake(', 'return devSendFakeReply('),
    );
    assertErrors(scheduledRunnerUsageErrors(mutated), /fingerprint|scheduled-effect owner/);
  }
});

test('rejects scheduler aliases and unreviewed callers', () => {
  const aliased = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      'return await runScheduledAccountOperation(accountLease, () =>\n      runDueScheduled(\n        getDatabase(),',
      'return await runScheduledAccountOperation(accountLease, () =>\n      (runDueScheduled)(\n        getDatabase(),',
    ),
  );
  assertErrors(scheduledRunnerUsageErrors(aliased), /references and aliases are forbidden/);

  assertErrors(
    scheduledRunnerUsageErrors([
      ...validRunnerSources,
      { path: 'src/services/send/otherRunner.ts', source: 'fireDueScheduled();' },
    ]),
    /unreviewed production/,
  );
});

test('the live repository satisfies the scheduled recovery contract', () => {
  assert.deepEqual(runScheduledRecoveryCheck(), {
    resetCalls: 1,
    claimCalls: 1,
    handoffCalls: 1,
  });
});
