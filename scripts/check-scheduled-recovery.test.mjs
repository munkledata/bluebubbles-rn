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
  export async function runDueScheduled(db, http, now, sender, accountScope, maxRows) {
    assertScheduledScope(accountScope);
    await ensureScheduledRecovery(db, accountScope, maxRows);
    assertScheduledScope(accountScope);
    const commitGuard = accountScope ? () => accountScope.isCurrent() : undefined;
    const due = await listDueScheduled(db, now, maxRows, true);
    for (const candidate of due) {
      const m = await claimDueScheduled(db, candidate.id, now, commitGuard);
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
        );
      }
    }
    return 0;
  }
`;

const validSendServiceSource = `
  export async function sendTextMessage(db, http, args, now, onQueued, scheduledHandover, ordinaryCommitGuard?) {
    const outgoing = { text: args.text };
    const effectiveCommitGuard = scheduledHandover?.commitGuard ?? ordinaryCommitGuard;
    if (scheduledHandover) {
      await handoverScheduledTextToOutgoing(
        db,
        {
          scheduledId: scheduledHandover.scheduledId,
          transition: scheduledHandover.transition,
          outgoing,
        },
        scheduledHandover.commitGuard,
      );
    } else {
      await withDbTransaction(
        db,
        (context) => insertOutgoingTextWithinTransaction(context, outgoing),
        effectiveCommitGuard,
      );
    }
    await onQueued?.();
    if (effectiveCommitGuard && !effectiveCommitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
    try {
      const server = await sendText(http, args);
      await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard);
    } catch (e) {
      if (e instanceof DbCommitGuardRejectedError) throw e;
      await handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard);
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
      '      const m = await claimDueScheduled(db, candidate.id, now, commitGuard);',
      '      const m = await claimDueScheduled(db, candidate.id, now, commitGuard);\n      await ensureScheduledRecovery(db, accountScope, maxRows);',
    );
  const errors = scheduledRecoverySourceErrors(delayed).join('\n');
  assert.match(errors, /unconditional top-level/);
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

test('rejects a second production claim owner or a missing atomic handoff owner', () => {
  const secondClaim = [
    ...expectedFindings,
    {
      path: 'src/services/send/other.ts',
      symbol: 'claimElsewhere',
      operation: 'mutator-call',
      target: 'src/db/repositories/scheduled.ts#claimDueScheduled',
    },
  ];
  assert.match(scheduledRecoveryCallGraphErrors(secondClaim).join('\n'), /exactly one/);
  assert.match(
    scheduledRecoveryCallGraphErrors(expectedFindings.slice(0, 2)).join('\n'),
    /handoverScheduledTextToOutgoing.*found 0/,
  );

  const oldClaim = expectedFindings.map((finding, index) =>
    index === 1
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
    .replace(
      'const m = await claimDueScheduled(db, candidate.id, now, commitGuard);',
      'const claimedRow = await claimDueScheduled(db, candidate.id, now, commitGuard);',
    )
    .replaceAll('m.', 'claimedRow.')
    .replace('if (!m)', 'if (!claimedRow)');
  assert.deepEqual(scheduledRecoverySourceErrors(renamed), []);
});

test('accepts a directly assigned claimed row when claim revocation is translated in a try block', () => {
  const guardedClaim = validSource.replace(
    '      const m = await claimDueScheduled(db, candidate.id, now, commitGuard);',
    `      let m;
      try {
        m = await claimDueScheduled(db, candidate.id, now, commitGuard);
      } catch (error) {
        assertScheduledScope(accountScope);
        throw error;
      }`,
  );
  assert.deepEqual(scheduledRecoverySourceErrors(guardedClaim), []);
});

test('rejects omitted or misbound authoritative-claim inputs', () => {
  const exactClaim = 'claimDueScheduled(db, candidate.id, now, commitGuard)';
  const regressions = [
    'claimDueScheduled(db, candidate.id, now)',
    'claimDueScheduled(db, candidate.id, now, undefined)',
    'claimDueScheduled(db, candidate.id, Date.now(), commitGuard)',
    'claimDueScheduled(db, candidate.chatGuid, now, commitGuard)',
  ];
  for (const regression of regressions) {
    assert.match(
      scheduledRecoverySourceErrors(validSource.replace(exactClaim, regression)).join('\n'),
      /claimDueScheduled must be exactly/,
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
  assert.match(errors, /exactly six arguments/);
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

test('rejects an unreachable, nested, or reassigned scheduled-handoff branch', () => {
  const unreachable = validSendServiceSource.replace(
    'if (scheduledHandover) {',
    'if (scheduledHandover && false) {',
  );
  assert.match(scheduledHandoffSourceErrors(unreachable).join('\n'), /top-level if/);

  const nested = validSendServiceSource
    .replace('    if (scheduledHandover) {', '    if (enabled) {\n      if (scheduledHandover) {')
    .replace(
      `    } else {
      await withDbTransaction(
        db,
        (context) => insertOutgoingTextWithinTransaction(context, outgoing),
        effectiveCommitGuard,
      );
    }`,
      `      } else {
        await withDbTransaction(
          db,
          (context) => insertOutgoingTextWithinTransaction(context, outgoing),
          effectiveCommitGuard,
        );
      }
    }`,
    );
  assert.match(scheduledHandoffSourceErrors(nested).join('\n'), /top-level if/);

  const reassigned = validSendServiceSource.replace(
    '    if (scheduledHandover) {',
    '    scheduledHandover = undefined;\n    if (scheduledHandover) {',
  );
  assert.match(scheduledHandoffSourceErrors(reassigned).join('\n'), /may not be reassigned/);
});

test('rejects moving or removing the queue handoff and pre-network account guard', () => {
  const withoutQueued = validSendServiceSource.replace('    await onQueued?.();\n', '');
  assert.match(scheduledHandoffSourceErrors(withoutQueued).join('\n'), /onQueued/);

  const queuedAfterNetwork = validSendServiceSource
    .replace('    await onQueued?.();\n', '')
    .replace(
      '    const server = await sendText(http, args);',
      '    const server = await sendText(http, args);\n    await onQueued?.();',
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
  assert.match(guardErrors, /network call must occur after/);
});

test('rejects an unguarded public insert or a malformed ordinary transaction owner', () => {
  const owner = `      await withDbTransaction(
        db,
        (context) => insertOutgoingTextWithinTransaction(context, outgoing),
        effectiveCommitGuard,
      );`;
  const publicInsert = validSendServiceSource.replace(
    owner,
    '      await insertOutgoingText(db, outgoing);',
  );
  assert.match(scheduledHandoffSourceErrors(publicInsert).join('\n'), /ordinary text/);

  const wrongGuard = validSendServiceSource.replace(
    owner,
    owner.replace('effectiveCommitGuard,', 'ordinaryCommitGuard,'),
  );
  assert.match(scheduledHandoffSourceErrors(wrongGuard).join('\n'), /ordinary text/);

  const rawDatabase = validSendServiceSource.replace(
    'insertOutgoingTextWithinTransaction(context, outgoing)',
    'insertOutgoingTextWithinTransaction(db, outgoing)',
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
    'reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard)',
    'reconcileSendOutcome(db, tempGuid, server, now, undefined)',
  );
  assert.match(scheduledHandoffSourceErrors(unguardedOutcome).join('\n'), /success and failure/);

  const unguardedFailure = validSendServiceSource.replace(
    "handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, effectiveCommitGuard)",
    "handleSendFailure(db, tempGuid, e, 'send', args.chatGuid, undefined, undefined)",
  );
  assert.match(scheduledHandoffSourceErrors(unguardedFailure).join('\n'), /success and failure/);

  const swallowedOwnershipLoss = validSendServiceSource.replace(
    '      if (e instanceof DbCommitGuardRejectedError) throw e;\n',
    '',
  );
  assert.match(scheduledHandoffSourceErrors(swallowedOwnershipLoss).join('\n'), /rethrown before/);
});

test('requires the exact ordinary context-helper call graph and forbids the public fallback', () => {
  const missingOwner = expectedFindings.slice(0, 3);
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
    '    if (scheduledHandover) {',
    `    const earlyNetwork = sendText;
    await earlyNetwork(http, args);
    if (scheduledHandover) {`,
  );
  assert.match(
    scheduledHandoffSourceErrors(earlyNetwork, { expectedBodyHash }).join('\n'),
    /reviewed AST body fingerprint/,
  );
});

test('requires every reviewed production runner call to carry its explicit account scope', () => {
  const rawCall = 'runDueScheduled(getDatabase(), http, now, undefined, accountLease)';
  const missingScope = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, 'runDueScheduled(getDatabase(), http, now, undefined)'),
  );
  assert.match(scheduledRunnerUsageErrors(missingScope).join('\n'), /explicit accountLease/);

  const undefinedScope = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, 'runDueScheduled(getDatabase(), http, now, undefined, undefined)'),
  );
  assert.match(scheduledRunnerUsageErrors(undefinedScope).join('\n'), /explicit accountLease/);

  const optionalCall = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(source, rawCall, rawCall.replace('runDueScheduled(', 'runDueScheduled?.(')),
  );
  assert.match(scheduledRunnerUsageErrors(optionalCall).join('\n'), /explicit accountLease/);
});

test('rejects production runner aliases, escaped references, and unreviewed callers', () => {
  const rawCall = 'runDueScheduled(getDatabase(), http, now, undefined, accountLease)';

  const commentOnlyChange = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      rawCall,
      'runDueScheduled(/* formatting-stable */ getDatabase(), http, now, undefined, accountLease)',
    ),
  );
  assert.deepEqual(scheduledRunnerUsageErrors(commentOnlyChange), []);

  const aliased = mutateRunnerSource('src/services/send/index.ts', (source) =>
    replaceOnce(
      source,
      rawCall,
      `(runDueScheduled)(getDatabase(), http, now, undefined, accountLease)`,
    ),
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
    claimCalls: 1,
    handoffCalls: 1,
  });
});
