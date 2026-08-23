import assert from 'node:assert/strict';
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
          { chatGuid: m.chatGuid, text: m.text, selectedMessageGuid: m.selectedMessageGuid },
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
  export async function sendTextMessage(db, http, args, now, onQueued, scheduledHandover) {
    const outgoing = { text: args.text };
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
      await insertOutgoingText(db, outgoing);
    }
    await onQueued?.();
    if (scheduledHandover?.commitGuard && !scheduledHandover.commitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
    const server = await sendText(http, args);
    return server;
  }
`;

const validRunnerSources = [
  {
    path: 'app/(app)/home.tsx',
    source: 'runDueScheduled(db, http, now, sender, accountLease);',
  },
  {
    path: 'app/(app)/chat/[guid].tsx',
    source: 'runDueScheduled(db, http, now, sender, accountLease);',
  },
  {
    path: 'src/services/send/index.ts',
    source:
      "export { runDueScheduled } from './scheduleService'; runDueScheduled(db, http, now, undefined, accountLease);",
  },
  {
    path: 'src/services/background/backgroundSync.ts',
    source: 'runDueScheduled(db, http, now, undefined, lease, maxRows);',
  },
];

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
  const exactPayload =
    '{ chatGuid: m.chatGuid, text: m.text, selectedMessageGuid: m.selectedMessageGuid }';
  const stalePayload =
    '{ chatGuid: candidate.chatGuid, text: candidate.text, selectedMessageGuid: candidate.selectedMessageGuid }';
  for (const regression of [
    stalePayload,
    'payload',
    '{ chatGuid: m.chatGuid, text: m.chatGuid, selectedMessageGuid: m.selectedMessageGuid }',
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
      '    } else {\n      await insertOutgoingText(db, outgoing);\n    }',
      '      } else {\n        await insertOutgoingText(db, outgoing);\n      }\n    }',
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
    `    if (scheduledHandover?.commitGuard && !scheduledHandover.commitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
`,
    '',
  );
  const guardErrors = scheduledHandoffSourceErrors(withoutGuard).join('\n');
  assert.match(guardErrors, /commit-guard rejection/);
  assert.match(guardErrors, /network call must occur after/);
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
  const missingScope = validRunnerSources.map((entry) =>
    entry.path === 'app/(app)/home.tsx'
      ? { ...entry, source: 'runDueScheduled(db, http, now, sender);' }
      : entry,
  );
  assert.match(scheduledRunnerUsageErrors(missingScope).join('\n'), /explicit accountLease/);

  const undefinedScope = validRunnerSources.map((entry) =>
    entry.path === 'app/(app)/home.tsx'
      ? { ...entry, source: 'runDueScheduled(db, http, now, sender, undefined);' }
      : entry,
  );
  assert.match(scheduledRunnerUsageErrors(undefinedScope).join('\n'), /explicit accountLease/);

  const optionalCall = validRunnerSources.map((entry) =>
    entry.path === 'app/(app)/home.tsx'
      ? { ...entry, source: entry.source.replace('runDueScheduled(', 'runDueScheduled?.(') }
      : entry,
  );
  assert.match(scheduledRunnerUsageErrors(optionalCall).join('\n'), /explicit accountLease/);
});

test('rejects production runner aliases, escaped references, and unreviewed callers', () => {
  const aliased = validRunnerSources.map((entry) =>
    entry.path === 'app/(app)/home.tsx'
      ? {
          ...entry,
          source: 'const runner = runDueScheduled; runner(db, http, now, sender, accountLease);',
        }
      : entry,
  );
  const aliasErrors = scheduledRunnerUsageErrors(aliased).join('\n');
  assert.match(aliasErrors, /references and aliases are forbidden/);
  assert.match(aliasErrors, /exactly one direct.*found 0/);

  const escaped = validRunnerSources.map((entry) =>
    entry.path === 'app/(app)/home.tsx'
      ? { ...entry, source: `${entry.source}\nvoid runDueScheduled;` }
      : entry,
  );
  assert.match(
    scheduledRunnerUsageErrors(escaped).join('\n'),
    /references and aliases are forbidden/,
  );

  const unreviewed = [
    ...validRunnerSources,
    {
      path: 'src/services/send/otherRunner.ts',
      source: 'runDueScheduled(db, http, now, undefined, lease);',
    },
  ];
  assert.match(scheduledRunnerUsageErrors(unreviewed).join('\n'), /unreviewed production/);
});

test('the live repository satisfies the scheduled recovery contract', () => {
  assert.deepEqual(runScheduledRecoveryCheck(), {
    resetCalls: 1,
    claimCalls: 1,
    handoffCalls: 1,
  });
});
