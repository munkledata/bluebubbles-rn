import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  runScheduledRecoveryCheck,
  scheduledRecoveryCallGraphErrors,
  scheduledRecoverySourceErrors,
  scheduledHandoffSourceErrors,
  scheduledRunnerUsageErrors,
  scheduledRunDueBodyHash,
  scheduledSendTextBodyHash,
} from './check-scheduled-recovery.mjs';

const validSource = `
  export async function runDueScheduled(db, http, now, sender, accountScope, maxRows, captureCapabilitySource?) {
    assertScheduledScope(accountScope);
    await ensureScheduledRecovery(db, accountScope, maxRows);
    assertScheduledScope(accountScope);
    const commitGuard = accountScope ? () => accountScope.isCurrent() : undefined;
    const due = await listDueScheduled(db, now, maxRows, true);
    for (const candidate of due) {
      let m;
      const capabilitySource = captureCapabilitySource?.();
      let serverAuthorization = targetAuthorizationForSource(capabilitySource, accountScope);
      try {
        m = await claimDueScheduled(
          db,
          candidate.id,
          now,
          messageTargetCommitGuard(commitGuard, serverAuthorization),
          serverAuthorization,
        );
      } catch (error) {
        const capability = await resolveRcsAttemptOwnership();
        serverAuthorization = messageTargetServerAuthorization(
          capability.serverInfo,
          () => capabilitySource?.isCurrent() ?? true,
        );
        m = await claimDueScheduled(
          db,
          candidate.id,
          now,
          messageTargetCommitGuard(commitGuard, serverAuthorization),
          serverAuthorization,
        );
      }
      if (!m) continue;
      const recurrence = asRecurrence(m.recurrence);
      const transition = recurrence
        ? {
            kind: 'rearm',
            nextScheduledFor: nextOccurrence(m.scheduledFor, recurrence, now),
          }
        : { kind: 'sent' };
      const settle = async () => {};
      const recordAtomicHandover = () => {};
      if (sender) {
        await sender(m.chatGuid, m.text, m.selectedMessageGuid, settle);
      } else {
        await sendTextMessage(
          db,
          http,
          {
            chatGuid: m.chatGuid,
            text: m.text,
            selectedMessageGuid: m.selectedMessageGuid,
            partIndex: m.selectedMessageGuid ? m.selectedMessagePartIndex : undefined,
          },
          Date.now(),
          recordAtomicHandover,
          { scheduledId: m.id, transition, commitGuard },
          undefined,
          captureCapabilitySource?.(),
        );
      }
    }
    return 0;
  }
`;

const validSendServiceSource = `
  export async function sendTextMessage(db, http, args, now, onQueued, scheduledHandover, ordinaryCommitGuard?, capabilitySource?) {
    const targetPart = explicitMessageTargetPart(args.selectedMessageGuid, args.partIndex);
    const target = targetPart
      ? { chatGuid: args.chatGuid, messageGuid: targetPart.messageGuid, partIndex: targetPart.partIndex }
      : null;
    if (target && isRcsChatGuid(args.chatGuid)) {
      throw new Error('This server cannot send an RCS threaded reply.');
    }
    const tempGuid = generateTempGuid();
    const effectiveCommitGuard = scheduledHandover?.commitGuard ?? ordinaryCommitGuard;
    const transport = pinSendTransport(http, effectiveCommitGuard);
    const capability = await resolveRcsAttemptOwnership(
      transport.http,
      args.chatGuid,
      transport.admissionGuard,
      capabilitySource,
      { requireServerInfo: target != null },
    );
    const authorizedTarget = target
      ? {
          ...target,
          serverAuthorization: messageTargetServerAuthorization(
            capability.serverInfo,
            transport.admissionGuard,
          ),
        }
      : null;
    const targetCommitGuard = messageTargetCommitGuard(
      effectiveCommitGuard,
      authorizedTarget?.serverAuthorization,
    );
    const outgoing = {
      text: args.text,
      selectedMessageGuid: target?.messageGuid,
      partIndex: target?.partIndex,
      attemptAware: capability.attemptAware,
    };
    const { attemptOwnerToken } = scheduledHandover
      ? await handoverScheduledTextToOutgoing(
        db,
        {
          scheduledId: scheduledHandover.scheduledId,
          transition: scheduledHandover.transition,
          outgoing,
        },
        transport.admissionGuard,
        authorizedTarget?.serverAuthorization,
      )
      : await withDbTransaction(
        db,
        async (context) => {
          const resolvedTarget = authorizedTarget
            ? await resolveMessageTargetWithinTransaction(context, authorizedTarget)
            : null;
          if (authorizedTarget && !resolvedTarget) throw new MessageTargetUnavailableError();
          return insertOutgoingTextWithinTransaction(context, {
            ...outgoing,
            selectedMessageGuid: resolvedTarget?.messageGuid,
            partIndex: resolvedTarget?.partIndex,
            threadOriginatorGuid: resolvedTarget?.messageGuid,
          });
        },
        transport.admissionGuard,
      );
    await onQueued?.(tempGuid);
    if (effectiveCommitGuard && !effectiveCommitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
    try {
      const finalTarget = authorizedTarget
        ? await resolveMessageTarget(db, authorizedTarget, targetCommitGuard)
        : null;
      if (authorizedTarget && !finalTarget) {
        await retireUnavailableMessageTarget(db, tempGuid, targetCommitGuard);
        return { tempGuid };
      }
      transport.assertNetworkCurrent();
      const method = chooseSendMethod(false, capability.serverInfo?.private_api === true);
      const server = await sendText(transport.http, {
        ...args,
        clientAttemptGeneration: attemptOwnerToken?.generation,
        selectedMessageGuid: finalTarget?.messageGuid,
        partIndex: finalTarget?.partIndex,
        method,
      });
      await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
      });
    } catch (e) {
      if (e instanceof DbCommitGuardRejectedError) throw e;
      await handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard, {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
      });
    }
  }
`;

const runnerPaths = [
  'app/(app)/home.tsx',
  'app/(app)/chat/[guid].tsx',
  'src/features/conversations/useChatScheduledCatchup.ts',
  'src/services/background/backgroundSync.ts',
  'src/services/send/index.ts',
  'src/services/send/scheduleService.ts',
];
const validRunnerSources = runnerPaths.map((path) => ({
  path,
  source: readFileSync(path, 'utf8'),
}));

function mutateRunnerSource(path, mutate) {
  return validRunnerSources.map((entry) =>
    entry.path === path ? { ...entry, source: mutate(entry.source) } : entry,
  );
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `expected one mutation target: ${before}`);
  return source.replace(before, after);
}

const expectedFindings = [
  {
    path: 'src/services/send/scheduleService.ts',
    symbol: 'recoverInterruptedScheduledRows',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#resetStuckScheduled',
  },
  {
    path: 'src/services/send/scheduleService.ts',
    symbol: 'runDueScheduled',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
  },
  {
    path: 'src/services/send/scheduleService.ts',
    symbol: 'runDueScheduled',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
  },
  {
    path: 'src/services/send/sendService.ts',
    symbol: 'sendTextMessage',
    operation: 'mutator-call',
    target: 'src/db/repositories/scheduled.ts#handoverScheduledTextToOutgoing',
  },
  {
    path: 'src/services/send/sendService.ts',
    symbol: 'sendTextMessage.<callback:abc123>',
    operation: 'mutator-call',
    target: 'src/db/repositories/outgoing.ts#insertOutgoingTextWithinTransaction',
  },
];

test('accepts one early, unconditional recovery barrier and the reviewed production owners', () => {
  assert.deepEqual(scheduledRecoverySourceErrors(validSource), []);
  assert.deepEqual(scheduledHandoffSourceErrors(validSendServiceSource), []);
  assert.deepEqual(scheduledRecoveryCallGraphErrors(expectedFindings), []);
  assert.deepEqual(scheduledRunnerUsageErrors(validRunnerSources), []);
});

test('rejects a removed, weakened, or post-admission RCS threaded-target barrier', () => {
  const barrier = `    if (target && isRcsChatGuid(args.chatGuid)) {
      throw new Error('This server cannot send an RCS threaded reply.');
    }
`;
  const removed = replaceOnce(validSendServiceSource, barrier, '');
  assert.match(scheduledHandoffSourceErrors(removed).join('\n'), /RCS threaded target/);

  const weakened = replaceOnce(
    validSendServiceSource,
    'isRcsChatGuid(args.chatGuid)',
    'isRcsChatGuid(args.selectedMessageGuid)',
  );
  assert.match(scheduledHandoffSourceErrors(weakened).join('\n'), /RCS threaded target/);

  const postAdmission = replaceOnce(
    replaceOnce(validSendServiceSource, barrier, ''),
    '    await onQueued?.(tempGuid);',
    `${barrier}    await onQueued?.(tempGuid);`,
  );
  assert.match(scheduledHandoffSourceErrors(postAdmission).join('\n'), /RCS threaded target/);
});

test('rejects a removed recovery barrier', () => {
  assert.match(
    scheduledRecoverySourceErrors(
      validSource.replace('    await ensureScheduledRecovery(db, accountScope, maxRows);\n', ''),
    ).join('\n'),
    /exactly once/,
  );
});

test('rejects a conditional recovery barrier', () => {
  assert.match(
    scheduledRecoverySourceErrors(
      validSource.replace(
        '    await ensureScheduledRecovery(db, accountScope, maxRows);',
        '    if (accountScope) await ensureScheduledRecovery(db, accountScope, maxRows);',
      ),
    ).join('\n'),
    /unconditional top-level/,
  );
});

test('rejects recovery moved after due-list and claim work', () => {
  const delayed = validSource
    .replace('    await ensureScheduledRecovery(db, accountScope, maxRows);\n', '')
    .replace(
      '    const due = await listDueScheduled(db, now, maxRows, true);',
      '    const due = await listDueScheduled(db, now, maxRows, true);\n    await ensureScheduledRecovery(db, accountScope, maxRows);',
    );
  const errors = scheduledRecoverySourceErrors(delayed).join('\n');
  assert.match(errors, /only the initial account-scope assertion/);
  assert.match(errors, /before due-list or claim/);
});

test('rejects extra, aliased, or escaped reset ownership', () => {
  const extra = [
    ...expectedFindings,
    {
      path: 'src/services/background/backgroundSync.ts',
      symbol: 'backgroundSync',
      operation: 'mutator-call',
      target: 'src/db/repositories/scheduled.ts#resetStuckScheduled',
    },
  ];
  assert.match(scheduledRecoveryCallGraphErrors(extra).join('\n'), /exactly one/);

  const escaped = expectedFindings.map((finding, index) =>
    index === 0 ? { ...finding, operation: 'mutator-reference' } : finding,
  );
  assert.match(scheduledRecoveryCallGraphErrors(escaped).join('\n'), /aliases are forbidden/);
});

test('rejects an extra production claim owner or a missing atomic handoff owner', () => {
  const extraClaim = [
    ...expectedFindings,
    {
      path: 'src/services/send/other.ts',
      symbol: 'claimElsewhere',
      operation: 'mutator-call',
      target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
    },
  ];
  assert.match(scheduledRecoveryCallGraphErrors(extraClaim).join('\n'), /exactly 2/);
  assert.match(
    scheduledRecoveryCallGraphErrors(expectedFindings.slice(0, 3)).join('\n'),
    /handoverScheduledTextToOutgoing.*found 0/,
  );

  const oldClaim = expectedFindings.map((finding, index) =>
    index === 1 || index === 2
      ? { ...finding, target: 'src/db/repositories/scheduled.ts#claimScheduled' }
      : finding,
  );
  assert.match(scheduledRecoveryCallGraphErrors(oldClaim).join('\n'), /claimDueScheduled.*found 0/);
});

test('rejects every production use or escape of the older broad claim helper', () => {
  for (const operation of ['mutator-call', 'mutator-reference', 'dynamic-mutator-call']) {
    const withBroadClaim = [
      ...expectedFindings,
      {
        path: 'src/services/send/legacyScheduler.ts',
        symbol: 'legacyClaim',
        operation,
        target: 'src/db/repositories/scheduled.ts#claimScheduled',
      },
    ];
    assert.match(
      scheduledRecoveryCallGraphErrors(withBroadClaim).join('\n'),
      /broad claimScheduled helper must have zero production calls or references \(found 1\)/,
    );
  }
});

test('accepts a renamed authoritative claim-result variable', () => {
  const renamed = validSource
    .replace('      let m;', '      let claimedRow;')
    .replaceAll('m = await claimDueScheduled(', 'claimedRow = await claimDueScheduled(')
    .replaceAll('m.', 'claimedRow.')
    .replace('if (!m)', 'if (!claimedRow)');
  assert.deepEqual(scheduledRecoverySourceErrors(renamed), []);
});

test('accepts the two direct claimed-row assignments in the guarded retry flow', () => {
  assert.deepEqual(scheduledRecoverySourceErrors(validSource), []);
});

test('rejects omitted or misbound authoritative-claim inputs', () => {
  const exactClaim = `claimDueScheduled(
          db,
          candidate.id,
          now,
          messageTargetCommitGuard(commitGuard, serverAuthorization),
          serverAuthorization,
        )`;
  const regressions = [
    `claimDueScheduled(
          db,
          candidate.id,
          now,
          messageTargetCommitGuard(commitGuard, serverAuthorization),
        )`,
    `claimDueScheduled(
          db,
          candidate.id,
          now,
          commitGuard,
          serverAuthorization,
        )`,
    exactClaim.replace('          now,', '          Date.now(),'),
    exactClaim.replace('          candidate.id,', '          candidate.chatGuid,'),
  ];
  for (const regression of regressions) {
    assert.match(
      scheduledRecoverySourceErrors(validSource.replace(exactClaim, regression)).join('\n'),
      /both claimDueScheduled calls must be exactly/,
    );
  }
});

test('rejects stale, indirect, or incorrectly mapped production send payloads', () => {
  const exactPayload = `{
            chatGuid: m.chatGuid,
            text: m.text,
            selectedMessageGuid: m.selectedMessageGuid,
            partIndex: m.selectedMessageGuid ? m.selectedMessagePartIndex : undefined,
          }`;
  const stalePayload = `{
            chatGuid: candidate.chatGuid,
            text: candidate.text,
            selectedMessageGuid: candidate.selectedMessageGuid,
            partIndex: candidate.selectedMessageGuid
              ? candidate.selectedMessagePartIndex
              : undefined,
          }`;
  for (const regression of [
    stalePayload,
    'payload',
    `{
            chatGuid: m.chatGuid,
            text: m.chatGuid,
            selectedMessageGuid: m.selectedMessageGuid,
            partIndex: m.selectedMessageGuid ? m.selectedMessagePartIndex : undefined,
          }`,
    `{
            chatGuid: m.chatGuid,
            text: m.text,
            selectedMessageGuid: m.selectedMessageGuid,
            partIndex: m.selectedMessagePartIndex,
          }`,
  ]) {
    assert.match(
      scheduledRecoverySourceErrors(validSource.replace(exactPayload, regression)).join('\n'),
      /production send payload must be exactly/,
    );
  }
});

test('rejects reassignment, mutation, or shadowing of the authoritative claimed-row binding', () => {
  const reassigned = validSource.replace(
    '      if (!m) continue;',
    '      if (!m) continue;\n      m = candidate;',
  );
  assert.match(scheduledRecoverySourceErrors(reassigned).join('\n'), /claimed row may not be/);

  const mutated = validSource.replace(
    '      if (!m) continue;',
    '      if (!m) continue;\n      m.text = candidate.text;',
  );
  assert.match(scheduledRecoverySourceErrors(mutated).join('\n'), /claimed row may not be/);

  const shadowed = validSource.replace(
    '      } else {\n        await sendTextMessage(',
    '      } else {\n        const m = candidate;\n        await sendTextMessage(',
  );
  const shadowErrors = scheduledRecoverySourceErrors(shadowed).join('\n');
  assert.match(shadowErrors, /exactly one variable binding/);
});

test('rejects shadowed handoff transition, guard, or commit callback bindings', () => {
  const insertionPoint = '      } else {\n        await sendTextMessage(';
  for (const [declaration, expected] of [
    ["const transition = { kind: 'sent' };", /transition must have exactly one/],
    ['const commitGuard = undefined;', /commit guard must have exactly one/],
    ['const recordAtomicHandover = settle;', /atomic handoff callback must have exactly one/],
  ]) {
    const shadowed = validSource.replace(
      insertionPoint,
      `      } else {\n        ${declaration}\n        await sendTextMessage(`,
    );
    assert.match(scheduledRecoverySourceErrors(shadowed).join('\n'), expected);
  }
});

test('rejects stale or shifted recurrence and rearm inputs', () => {
  const staleRecurrence = validSource.replace(
    'asRecurrence(m.recurrence)',
    'asRecurrence(candidate.recurrence)',
  );
  assert.match(
    scheduledRecoverySourceErrors(staleRecurrence).join('\n'),
    /recurrence must be exactly/,
  );

  const staleScheduledFor = validSource.replace(
    'nextOccurrence(m.scheduledFor, recurrence, now)',
    'nextOccurrence(candidate.scheduledFor, recurrence, now)',
  );
  assert.match(
    scheduledRecoverySourceErrors(staleScheduledFor).join('\n'),
    /rearm time must be exactly/,
  );

  const shiftedNow = validSource.replace(
    'nextOccurrence(m.scheduledFor, recurrence, now)',
    'nextOccurrence(m.scheduledFor, recurrence, now + 60_000)',
  );
  assert.match(scheduledRecoverySourceErrors(shiftedNow).join('\n'), /rearm time must be exactly/);
});

test('rejects an ordinary send without the direct atomic handoff', () => {
  const ordinary = validSource
    .replace('          recordAtomicHandover,', '          settle,')
    .replace('          { scheduledId: m.id, transition, commitGuard },\n', '');
  const errors = scheduledRecoverySourceErrors(ordinary).join('\n');
  assert.match(errors, /exactly eight arguments/);
  assert.match(errors, /recordAtomicHandover/);
  assert.match(errors, /sixth argument must be the direct atomic handoff object/);
});

test('rejects a conditional or indirect atomic handoff', () => {
  const conditional = validSource.replace(
    '{ scheduledId: m.id, transition, commitGuard },',
    'accountScope ? { scheduledId: m.id, transition, commitGuard } : undefined,',
  );
  assert.match(
    scheduledRecoverySourceErrors(conditional).join('\n'),
    /sixth argument must be the direct atomic handoff object/,
  );

  const indirect = validSource
    .replace(
      '      const recordAtomicHandover = () => {};',
      '      const recordAtomicHandover = () => {};\n      const handoff = { scheduledId: m.id, transition, commitGuard };',
    )
    .replace('{ scheduledId: m.id, transition, commitGuard },', 'handoff,');
  assert.match(
    scheduledRecoverySourceErrors(indirect).join('\n'),
    /sixth argument must be the direct atomic handoff object/,
  );
});

test('requires the scheduled production send to capture capability from the current owner', () => {
  const missingSource = validSource.replace(
    '          captureCapabilitySource?.(),',
    '          undefined,',
  );
  assert.match(
    scheduledRecoverySourceErrors(missingSource).join('\n'),
    /optional capability-source result/,
  );

  const aliasedSource = validSource.replace(
    '          captureCapabilitySource?.(),',
    '          capabilitySource,',
  );
  assert.match(
    scheduledRecoverySourceErrors(aliasedSource).join('\n'),
    /optional capability-source result/,
  );

  const fallbackSource = validSource.replace(
    '          captureCapabilitySource?.(),',
    '          captureCapabilitySource?.() ?? capabilitySource,',
  );
  assert.match(
    scheduledRecoverySourceErrors(fallbackSource).join('\n'),
    /optional capability-source result/,
  );

  const reboundAfterDiscovery = validSource.replace(
    '        serverAuthorization = messageTargetServerAuthorization(',
    '        capabilitySource = captureCapabilitySource?.() ?? capabilitySource;\n        serverAuthorization = messageTargetServerAuthorization(',
  );
  assert.match(
    scheduledRecoverySourceErrors(reboundAfterDiscovery).join('\n'),
    /scheduled capability source may not be/,
  );
});

test('rejects a handoff sourced from the stale listed row or carrying the wrong object shape', () => {
  const staleId = validSource.replace('scheduledId: m.id', 'scheduledId: candidate.id');
  assert.match(scheduledRecoverySourceErrors(staleId).join('\n'), /claimed row id/);

  const wrongTransition = validSource.replace(
    '{ scheduledId: m.id, transition, commitGuard }',
    '{ scheduledId: m.id, transition: otherTransition, commitGuard }',
  );
  assert.match(scheduledRecoverySourceErrors(wrongTransition).join('\n'), /transition shorthand/);

  const wrongGuard = validSource.replace(
    '{ scheduledId: m.id, transition, commitGuard }',
    '{ scheduledId: m.id, transition, commitGuard: undefined }',
  );
  assert.match(scheduledRecoverySourceErrors(wrongGuard).join('\n'), /commitGuard shorthand/);

  const extraProperty = validSource.replace(
    '{ scheduledId: m.id, transition, commitGuard }',
    '{ scheduledId: m.id, transition, commitGuard, ordinary: true }',
  );
  assert.match(scheduledRecoverySourceErrors(extraProperty).join('\n'), /must be exactly/);
});

test('rejects a production send hidden behind an additional condition', () => {
  const nested = validSource.replace(
    '        await sendTextMessage(',
    '        if (accountScope) await sendTextMessage(',
  );
  assert.match(scheduledRecoverySourceErrors(nested).join('\n'), /direct awaited statement/);
});

test('the reviewed runDueScheduled AST fingerprint fails closed on otherwise-unchecked edits', () => {
  const expectedBodyHash = scheduledRunDueBodyHash(validSource);
  assert.deepEqual(scheduledRecoverySourceErrors(validSource, { expectedBodyHash }), []);
  const mutated = validSource.replace(
    '    return 0;',
    '    void "unexpected edit";\n    return 0;',
  );
  assert.match(
    scheduledRecoverySourceErrors(mutated, { expectedBodyHash }).join('\n'),
    /reviewed AST body fingerprint/,
  );
});

test('rejects a malformed, non-awaited, or reassigned ownership handoff', () => {
  const unreachable = validSendServiceSource.replace(
    'const { attemptOwnerToken } = scheduledHandover',
    'const { attemptOwnerToken } = scheduledHandover && false',
  );
  assert.match(scheduledHandoffSourceErrors(unreachable).join('\n'), /exact top-level/);

  const notAwaited = validSendServiceSource.replace(
    '? await handoverScheduledTextToOutgoing(',
    '? handoverScheduledTextToOutgoing(',
  );
  assert.match(scheduledHandoffSourceErrors(notAwaited).join('\n'), /exact top-level/);

  const reassigned = validSendServiceSource.replace(
    '    const { attemptOwnerToken } = scheduledHandover',
    '    scheduledHandover = undefined;\n    const { attemptOwnerToken } = scheduledHandover',
  );
  assert.match(scheduledHandoffSourceErrors(reassigned).join('\n'), /may not be reassigned/);

  const tokenReassigned = validSendServiceSource.replace(
    '    await onQueued?.(tempGuid);',
    '    attemptOwnerToken = undefined;\n    await onQueued?.(tempGuid);',
  );
  assert.match(
    scheduledHandoffSourceErrors(tokenReassigned).join('\n'),
    /attempt-owner token may not/,
  );
});

test('rejects moving or removing the queue handoff and pre-network account guard', () => {
  const withoutQueued = validSendServiceSource.replace('    await onQueued?.(tempGuid);\n', '');
  assert.match(scheduledHandoffSourceErrors(withoutQueued).join('\n'), /onQueued/);

  const queuedAfterNetwork = validSendServiceSource
    .replace('    await onQueued?.(tempGuid);\n', '')
    .replace(
      '      const server = await sendText(transport.http, {',
      '      await onQueued?.(tempGuid);\n      const server = await sendText(transport.http, {',
    );
  assert.match(scheduledHandoffSourceErrors(queuedAfterNetwork).join('\n'), /onQueued/);

  const withoutGuard = validSendServiceSource.replace(
    `    if (effectiveCommitGuard && !effectiveCommitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
`,
    '',
  );
  const guardErrors = scheduledHandoffSourceErrors(withoutGuard).join('\n');
  assert.match(guardErrors, /commit-guard rejection/);
  assert.match(guardErrors, /one sendText call must follow/);
});

test('rejects an unguarded public insert or a malformed ordinary transaction owner', () => {
  const publicInsert = validSendServiceSource.replace(
    `        async (context) => {
          const resolvedTarget = authorizedTarget
            ? await resolveMessageTargetWithinTransaction(context, authorizedTarget)
            : null;
          if (authorizedTarget && !resolvedTarget) throw new MessageTargetUnavailableError();
          return insertOutgoingTextWithinTransaction(context, {
            ...outgoing,
            selectedMessageGuid: resolvedTarget?.messageGuid,
            partIndex: resolvedTarget?.partIndex,
            threadOriginatorGuid: resolvedTarget?.messageGuid,
          });
        },`,
    '        async () => insertOutgoingText(db, outgoing),',
  );
  assert.match(scheduledHandoffSourceErrors(publicInsert).join('\n'), /ordinary text/);

  const wrongGuard = validSendServiceSource.replace(
    `        },
        transport.admissionGuard,
      );`,
    `        },
        ordinaryCommitGuard,
      );`,
  );
  assert.match(scheduledHandoffSourceErrors(wrongGuard).join('\n'), /ordinary text/);

  const rawDatabase = validSendServiceSource.replace(
    'insertOutgoingTextWithinTransaction(context, {',
    'insertOutgoingTextWithinTransaction(db, {',
  );
  assert.match(scheduledHandoffSourceErrors(rawDatabase).join('\n'), /ordinary text/);
});

test('rejects changed guard precedence, settlement propagation, or ownership-error handling', () => {
  const wrongPrecedence = validSendServiceSource.replace(
    'scheduledHandover?.commitGuard ?? ordinaryCommitGuard',
    'ordinaryCommitGuard ?? scheduledHandover?.commitGuard',
  );
  assert.match(scheduledHandoffSourceErrors(wrongPrecedence).join('\n'), /effectiveCommitGuard/);

  const unguardedOutcome = validSendServiceSource.replace(
    `reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
      })`,
    `reconcileSendOutcome(db, tempGuid, server, now, undefined, {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
      })`,
  );
  assert.match(scheduledHandoffSourceErrors(unguardedOutcome).join('\n'), /success and failure/);

  const unguardedFailure = validSendServiceSource.replace(
    "handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard, {",
    "handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, undefined, {",
  );
  assert.match(scheduledHandoffSourceErrors(unguardedFailure).join('\n'), /success and failure/);

  const swallowedOwnershipLoss = validSendServiceSource.replace(
    '      if (e instanceof DbCommitGuardRejectedError) throw e;\n',
    '',
  );
  assert.match(scheduledHandoffSourceErrors(swallowedOwnershipLoss).join('\n'), /rethrown before/);

  const wrongCapabilityGuard = validSendServiceSource.replace(
    '      transport.admissionGuard,\n      capabilitySource,',
    '      effectiveCommitGuard,\n      capabilitySource,',
  );
  assert.match(scheduledHandoffSourceErrors(wrongCapabilityGuard).join('\n'), /capability/);

  const missingAttemptAware = validSendServiceSource.replace(
    'attemptAware: capability.attemptAware,',
    'attemptAware: false,',
  );
  assert.match(scheduledHandoffSourceErrors(missingAttemptAware).join('\n'), /capability/);

  const missingRequestGeneration = validSendServiceSource.replace(
    'clientAttemptGeneration: attemptOwnerToken?.generation',
    'clientAttemptGeneration: undefined',
  );
  assert.match(scheduledHandoffSourceErrors(missingRequestGeneration).join('\n'), /sendText/);

  const missingOutcomeToken = validSendServiceSource.replace(
    'attemptOwnerToken: attemptOwnerToken ?? undefined',
    'attemptOwnerToken: undefined',
  );
  assert.match(scheduledHandoffSourceErrors(missingOutcomeToken).join('\n'), /success and failure/);

  const missingFailureToken = validSendServiceSource.replace(
    `handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard, {
        attemptOwnerToken: attemptOwnerToken ?? undefined,`,
    `handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard, {
        attemptOwnerToken: undefined,`,
  );
  assert.match(scheduledHandoffSourceErrors(missingFailureToken).join('\n'), /success and failure/);
});

test('keeps capability discovery, queue admission, and network dispatch on one pinned transport', () => {
  const wrongPinGuard = validSendServiceSource.replace(
    'pinSendTransport(http, effectiveCommitGuard)',
    'pinSendTransport(http, ordinaryCommitGuard)',
  );
  assert.match(scheduledHandoffSourceErrors(wrongPinGuard).join('\n'), /pinSendTransport/);

  const wrongCapabilitySource = validSendServiceSource.replace(
    '      capabilitySource,',
    '      undefined,',
  );
  assert.match(
    scheduledHandoffSourceErrors(wrongCapabilitySource).join('\n'),
    /attempt capability/,
  );

  const missingTargetRequirement = validSendServiceSource.replace(
    '      { requireServerInfo: target != null },\n',
    '',
  );
  assert.match(
    scheduledHandoffSourceErrors(missingTargetRequirement).join('\n'),
    /target-required server info/,
  );

  const wrongHandoffGuard = validSendServiceSource.replace(
    `        },
        transport.admissionGuard,
        authorizedTarget?.serverAuthorization,
      )`,
    `        },
        effectiveCommitGuard,
        authorizedTarget?.serverAuthorization,
      )`,
  );
  assert.match(scheduledHandoffSourceErrors(wrongHandoffGuard).join('\n'), /scheduled handoff/);

  const missingHandoffAuthorization = validSendServiceSource.replace(
    '        authorizedTarget?.serverAuthorization,',
    '        undefined,',
  );
  assert.match(
    scheduledHandoffSourceErrors(missingHandoffAuthorization).join('\n'),
    /scheduled handoff/,
  );

  const unpinnedNetwork = validSendServiceSource.replace(
    'sendText(transport.http, {',
    'sendText(http, {',
  );
  assert.match(scheduledHandoffSourceErrors(unpinnedNetwork).join('\n'), /one sendText call/);

  const missingCurrentnessCheck = validSendServiceSource.replace(
    '      transport.assertNetworkCurrent();\n',
    '',
  );
  assert.match(
    scheduledHandoffSourceErrors(missingCurrentnessCheck).join('\n'),
    /assertNetworkCurrent/,
  );

  const unguardedFinalTarget = validSendServiceSource.replace(
    'resolveMessageTarget(db, authorizedTarget, targetCommitGuard)',
    'resolveMessageTarget(db, authorizedTarget, effectiveCommitGuard)',
  );
  assert.match(
    scheduledHandoffSourceErrors(unguardedFinalTarget).join('\n'),
    /target revalidation/,
  );

  const staleWireTarget = validSendServiceSource.replace(
    'selectedMessageGuid: finalTarget?.messageGuid,',
    'selectedMessageGuid: target?.messageGuid,',
  );
  assert.match(
    scheduledHandoffSourceErrors(staleWireTarget).join('\n'),
    /canonical final target part/,
  );

  const staleMethodCapability = validSendServiceSource.replace(
    'capability.serverInfo?.private_api === true',
    'sessionAccessors.privateApiEnabled()',
  );
  assert.match(scheduledHandoffSourceErrors(staleMethodCapability).join('\n'), /pinned capability/);
});

test('requires the exact ordinary context-helper call graph and forbids the public fallback', () => {
  const missingOwner = expectedFindings.slice(0, 4);
  assert.match(scheduledRecoveryCallGraphErrors(missingOwner).join('\n'), /context insert/);

  const extraOwner = [
    ...expectedFindings,
    {
      path: 'src/services/send/sendService.ts',
      symbol: 'sendTextMessage.<callback:def456>',
      operation: 'mutator-call',
      target: 'src/db/repositories/outgoing.ts#insertOutgoingTextWithinTransaction',
    },
  ];
  assert.match(scheduledRecoveryCallGraphErrors(extraOwner).join('\n'), /found 2/);

  const publicFallback = [
    ...expectedFindings,
    {
      path: 'src/services/send/sendService.ts',
      symbol: 'sendTextMessage',
      operation: 'mutator-call',
      target: 'src/db/repositories/outgoing.ts#insertOutgoingText',
    },
  ];
  assert.match(scheduledRecoveryCallGraphErrors(publicFallback).join('\n'), /zero.*found 1/);
});

test('the reviewed sendTextMessage AST fingerprint rejects an early aliased network request', () => {
  const expectedBodyHash = scheduledSendTextBodyHash(validSendServiceSource);
  assert.deepEqual(scheduledHandoffSourceErrors(validSendServiceSource, { expectedBodyHash }), []);
  const earlyNetwork = validSendServiceSource.replace(
    '    const { attemptOwnerToken } = scheduledHandover',
    `    const earlyNetwork = sendText;
    await earlyNetwork(http, args);
    const { attemptOwnerToken } = scheduledHandover`,
  );
  assert.match(
    scheduledHandoffSourceErrors(earlyNetwork, { expectedBodyHash }).join('\n'),
    /reviewed AST body fingerprint/,
  );
});

test('requires every reviewed production runner call to carry its explicit account scope', () => {
  const rawCall = `runDueScheduled(
        getDatabase(),
        http,
        now,
        undefined,
        accountLease,
        undefined,
        captureSessionRcsCapabilityLease,
      )`;
  const missingScope = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, rawCall.replace('        accountLease,\n', '')),
  );
  assert.match(scheduledRunnerUsageErrors(missingScope).join('\n'), /explicit accountLease/);

  const undefinedScope = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, rawCall.replace('        accountLease,', '        undefined,')),
  );
  assert.match(scheduledRunnerUsageErrors(undefinedScope).join('\n'), /explicit accountLease/);

  const optionalCall = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, rawCall.replace('runDueScheduled(', 'runDueScheduled?.(')),
  );
  assert.match(scheduledRunnerUsageErrors(optionalCall).join('\n'), /explicit accountLease/);
});

test('requires reviewed foreground and background scheduled capability sources', () => {
  const foreground = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, '        captureSessionRcsCapabilityLease,', '        () => undefined,'),
  );
  assert.match(scheduledRunnerUsageErrors(foreground).join('\n'), /capability-source factory/);

  const background = mutateRunnerSource('src/services/background/backgroundSync.ts', (source) =>
    replaceOnce(
      source,
      '      () => fixedRcsCapabilitySource(serverInfo),',
      '      () => fixedRcsCapabilitySource(undefined),',
    ),
  );
  assert.match(scheduledRunnerUsageErrors(background).join('\n'), /capability-source factory/);
});

test('rejects production runner aliases, escaped references, and unreviewed callers', () => {
  const rawCall = `runDueScheduled(
        getDatabase(),
        http,
        now,
        undefined,
        accountLease,
        undefined,
        captureSessionRcsCapabilityLease,
      )`;

  const commentOnlyChange = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      rawCall,
      rawCall.replace('runDueScheduled(', 'runDueScheduled(/* formatting-stable */'),
    ),
  );
  assert.deepEqual(scheduledRunnerUsageErrors(commentOnlyChange), []);

  const aliased = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, rawCall.replace('runDueScheduled(', '(runDueScheduled)(')),
  );
  const aliasErrors = scheduledRunnerUsageErrors(aliased).join('\n');
  assert.match(aliasErrors, /references and aliases are forbidden/);
  assert.match(aliasErrors, /exactly one direct reviewed call.*found 0/);

  const escaped = mutateRunnerSource(
    'app/(app)/home.tsx',
    (source) => `${source}\nvoid fireDueScheduled;`,
  );
  assert.match(
    scheduledRunnerUsageErrors(escaped).join('\n'),
    /references and aliases are forbidden/,
  );

  const unreviewed = [
    ...validRunnerSources,
    {
      path: 'src/services/send/otherRunner.ts',
      source: 'fireDueScheduled();',
    },
  ];
  assert.match(scheduledRunnerUsageErrors(unreviewed).join('\n'), /unreviewed production/);

  const droppedPromise = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      `return await runScheduledAccountOperation(accountLease, () =>
      ${rawCall},
    );`,
      `void runScheduledAccountOperation(accountLease, () =>
      ${rawCall},
    );
    return 0;`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(droppedPromise).join('\n'), /fingerprint/);

  const invalidSyntax = mutateRunnerSource(
    'src/services/send/index.ts',
    (source) => `${source}\nconst invalid = (;`,
  );
  assert.match(scheduledRunnerUsageErrors(invalidSyntax).join('\n'), /invalid TypeScript syntax/);

  const wrongImport = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      `import {
  ensureScheduledRecovery,
  runDueScheduled,
  scheduleTextMessage,
  ScheduledSessionChangedError,
  type ScheduleArgs,
} from './scheduleService';`,
      `import {
  ensureScheduledRecovery,
  runDueScheduled,
  scheduleTextMessage,
  ScheduledSessionChangedError,
  type ScheduleArgs,
} from './wrongScheduleService';`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(wrongImport).join('\n'), /must import runDueScheduled/);

  const deadHomeBranch = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      `void (async () => {
      try {
        if (!accountLease.isCurrent()) return;`,
      `void (async () => {
      try {
        return;
        if (!accountLease.isCurrent()) return;`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(deadHomeBranch).join('\n'), /scheduled-effect owner/);

  const sequentialBranches = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      `        } else {
          await fireDueScheduled();
        }`,
      `        }
        await fireDueScheduled();`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(sequentialBranches).join('\n'), /scheduled-effect owner/);

  const shadowedLease = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      `  useEffect(() => {
    const useDevFixtures = isDevServer();`,
      `  useEffect(() => {
    const accountLease = captureRealtimeDeliveryLease();
    const useDevFixtures = isDevServer();`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(shadowedLease).join('\n'), /scheduled-effect owner/);

  const earlyHomeExit = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      '  const [accountLease] = useState(() => captureRealtimeDeliveryLease());',
      `  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  if (showDevProofControls) return null;`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(earlyHomeExit).join('\n'), /scheduled-effect owner/);

  const earlyChatExit = mutateRunnerSource('app/(app)/chat/[guid].tsx', (source) =>
    replaceOnce(
      source,
      '  useChatScheduledCatchup(accountLease);',
      `  if (messagesLoading) return null;
  useChatScheduledCatchup(accountLease);`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(earlyChatExit).join('\n'), /directly invoke/);

  const blockedHome = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      '  useEffect(() => {',
      `  while (true) {}
  useEffect(() => {`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(blockedHome).join('\n'), /scheduled-effect owner/);

  const parenthesizedBlockedHome = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      '  useEffect(() => {',
      `  while ((true)) {}
  useEffect(() => {`,
    ),
  );
  assert.match(
    scheduledRunnerUsageErrors(parenthesizedBlockedHome).join('\n'),
    /scheduled-effect owner/,
  );

  const throwingChatIife = mutateRunnerSource('app/(app)/chat/[guid].tsx', (source) =>
    replaceOnce(
      source,
      '  useChatScheduledCatchup(accountLease);',
      `  (() => { throw new Error('blocked'); })();
  useChatScheduledCatchup(accountLease);`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(throwingChatIife).join('\n'), /directly invoke/);

  const shadowedHomeHelper = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      '  const [accountLease] = useState(() => captureRealtimeDeliveryLease());',
      `  const useEffect = () => undefined;
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(shadowedHomeHelper).join('\n'), /scheduled-effect owner/);

  const shadowedChatHelper = mutateRunnerSource('app/(app)/chat/[guid].tsx', (source) =>
    replaceOnce(
      source,
      '  const [accountLease] = useState(() => captureRealtimeDeliveryLease());',
      `  const useState = () => [captureRealtimeDeliveryLease()];
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());`,
    ),
  );
  assert.match(scheduledRunnerUsageErrors(shadowedChatHelper).join('\n'), /directly invoke/);

  const parameterShadowedHomeHelper = mutateRunnerSource('app/(app)/home.tsx', (source) =>
    replaceOnce(
      source,
      'export default function Home(): React.JSX.Element {',
      'export default function Home({ useEffect = () => undefined } = {}): React.JSX.Element {',
    ),
  );
  assert.match(
    scheduledRunnerUsageErrors(parameterShadowedHomeHelper).join('\n'),
    /scheduled-effect owner/,
  );

  const parameterShadowedChatHelper = mutateRunnerSource('app/(app)/chat/[guid].tsx', (source) =>
    replaceOnce(
      source,
      `function ChatScreenInner({
  guid,`,
      `function ChatScreenInner({
  useState,
  guid,`,
    ),
  );
  assert.match(
    scheduledRunnerUsageErrors(parameterShadowedChatHelper).join('\n'),
    /directly invoke/,
  );

  const nestedDeclaration = mutateRunnerSource(
    'src/services/send/index.ts',
    (source) => `${source}\nfunction legacyOwner() { function fireDueScheduled() {} }\n`,
  );
  assert.match(
    scheduledRunnerUsageErrors(nestedDeclaration).join('\n'),
    /references and aliases are forbidden/,
  );

  const elementAccess = mutateRunnerSource(
    'app/(app)/home.tsx',
    (source) => `${source}\nvoid legacyScheduler['fireDueScheduled']();\n`,
  );
  assert.match(scheduledRunnerUsageErrors(elementAccess).join('\n'), /element-access aliases/);

  const templateElementAccess = mutateRunnerSource(
    'app/(app)/home.tsx',
    (source) => source + '\nvoid legacyScheduler[`fireDueScheduled`]();\n',
  );
  assert.match(
    scheduledRunnerUsageErrors(templateElementAccess).join('\n'),
    /element-access aliases/,
  );

  const identifierElementAccess = mutateRunnerSource(
    'app/(app)/home.tsx',
    (source) =>
      `${source}\nimport * as scheduledService from '@/services/send';\nconst scheduledKey = 'fireDueScheduled' as const;\nvoid scheduledService[scheduledKey]();\n`,
  );
  assert.match(
    scheduledRunnerUsageErrors(identifierElementAccess).join('\n'),
    /element-access aliases/,
  );

  const deadBackgroundWiring = mutateRunnerSource(
    'src/services/background/backgroundSync.ts',
    (source) =>
      replaceOnce(
        source,
        'recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,',
        'recoverAndDrainSchedules: async () => undefined,',
      ),
  );
  assert.match(
    scheduledRunnerUsageErrors(deadBackgroundWiring).join('\n'),
    /wire the reviewed background schedule owner directly/,
  );

  const overriddenBackgroundWiring = mutateRunnerSource(
    'src/services/background/backgroundSync.ts',
    (source) =>
      replaceOnce(
        source,
        'recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,',
        `recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,
      ...{ recoverAndDrainSchedules: async () => undefined },`,
      ),
  );
  assert.match(
    scheduledRunnerUsageErrors(overriddenBackgroundWiring).join('\n'),
    /wire the reviewed background schedule owner directly/,
  );

  const optionalBackgroundCall = mutateRunnerSource(
    'src/services/background/backgroundSync.ts',
    (source) => replaceOnce(source, 'await runBackgroundSync({', 'await runBackgroundSync?.({'),
  );
  assert.match(
    scheduledRunnerUsageErrors(optionalBackgroundCall).join('\n'),
    /wire the reviewed background schedule owner directly/,
  );
});

test('the live repository satisfies the scheduled recovery contract', () => {
  assert.deepEqual(runScheduledRecoveryCheck(), {
    resetCalls: 1,
    claimCalls: 2,
    handoffCalls: 1,
  });
});
