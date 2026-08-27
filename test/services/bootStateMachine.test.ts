import {
  CORE_BOOT_STAGES,
  OPTIONAL_BOOT_STAGES,
  initialBootState,
  transitionBoot,
  type BootFailure,
  type BootIssue,
  type BootState,
  type CoreBootStage,
} from '@/services/boot/bootStateMachine';

function begin(): Extract<BootState, { status: 'loading' }> {
  const state = transitionBoot(initialBootState(), { type: 'start' });
  if (state.status !== 'loading') throw new Error('expected loading state');
  return state;
}

function loadingAt(stage: CoreBootStage): Extract<BootState, { status: 'loading' }> {
  let state: BootState = begin();
  for (const current of CORE_BOOT_STAGES) {
    if (current === stage) break;
    state = transitionBoot(state, {
      type: 'stage-completed',
      runId: state.runId,
      stage: current,
    });
  }
  if (state.status !== 'loading' || state.stage !== stage) {
    throw new Error(`expected loading stage ${stage}`);
  }
  return state;
}

function failure(stage: CoreBootStage, kind: BootFailure['kind'] = 'retryable'): BootFailure {
  const base = {
    stage,
    code: `${stage}-failed`,
    userMessage: `Could not complete ${stage}`,
  };
  return kind === 'fatal'
    ? { ...base, kind, failClosed: true }
    : {
        ...base,
        kind,
        failClosed: stage === 'lock' || stage === 'session' || stage === 'database',
      };
}

describe('boot state machine', () => {
  it('starts idle and advances through the connected core stages in strict order', () => {
    const initial = initialBootState();
    expect(initial).toEqual({ status: 'idle', runId: 0, issues: [] });

    let state: BootState = transitionBoot(initial, { type: 'start' });
    expect(state).toMatchObject({ status: 'loading', runId: 1, stage: 'lock' });

    for (const stage of CORE_BOOT_STAGES) {
      expect(state).toMatchObject({ status: 'loading', runId: 1, stage });
      state = transitionBoot(state, { type: 'stage-completed', runId: 1, stage });
    }

    expect(state).toEqual({ status: 'ready', runId: 1, mode: 'connected', issues: [] });
  });

  it('reaches setup from the session gate without exposing a database stage', () => {
    let state: BootState = begin();
    state = transitionBoot(state, { type: 'stage-completed', runId: 1, stage: 'lock' });
    expect(state).toMatchObject({ status: 'loading', stage: 'session' });

    const illegalDatabaseCompletion = transitionBoot(state, {
      type: 'stage-completed',
      runId: 1,
      stage: 'database',
    });
    expect(illegalDatabaseCompletion).toBe(state);

    state = transitionBoot(state, { type: 'setup-ready', runId: 1 });
    expect(state).toEqual({ status: 'ready', runId: 1, mode: 'setup', issues: [] });
  });

  it('pauses for lock and resumes the same run at the session gate after unlock', () => {
    let state: BootState = begin();
    state = transitionBoot(state, { type: 'lock-required', runId: 1 });
    expect(state).toEqual({ status: 'locked', runId: 1, issues: [] });

    const progressWhileLocked = transitionBoot(state, {
      type: 'stage-completed',
      runId: 1,
      stage: 'lock',
    });
    expect(progressWhileLocked).toBe(state);

    state = transitionBoot(state, { type: 'unlock-completed', runId: 1 });
    expect(state).toEqual({ status: 'loading', runId: 1, stage: 'session', issues: [] });
  });

  it('rejects duplicate starts and illegal or out-of-order progress by object identity', () => {
    const state = begin();
    const rejected = [
      transitionBoot(state, { type: 'start' }),
      transitionBoot(state, { type: 'stage-completed', runId: 1, stage: 'session' }),
      transitionBoot(state, { type: 'setup-ready', runId: 1 }),
      transitionBoot(state, { type: 'unlock-completed', runId: 1 }),
      transitionBoot(state, { type: 'retry', runId: 1 }),
      transitionBoot(state, { type: 'failed', runId: 1, failure: failure('database') }),
    ];
    for (const result of rejected) expect(result).toBe(state);
  });

  it.each(CORE_BOOT_STAGES)('retries a retryable %s failure as a fresh run', (stage) => {
    let state: BootState = loadingAt(stage);
    const issue: BootIssue = {
      stage: 'device-integrity',
      level: 'diagnostic',
      code: 'check-failed',
    };
    state = transitionBoot(state, { type: 'issue', runId: 1, issue });
    state = transitionBoot(state, { type: 'failed', runId: 1, failure: failure(stage) });
    expect(state).toMatchObject({ status: 'failed', runId: 1, failure: { stage } });
    expect(state.issues).toEqual([issue]);

    state = transitionBoot(state, { type: 'retry', runId: 1 });
    expect(state).toEqual({ status: 'loading', runId: 2, stage: 'lock', issues: [] });
  });

  it('does not retry a fatal failure', () => {
    let state: BootState = loadingAt('database');
    state = transitionBoot(state, {
      type: 'failed',
      runId: 1,
      failure: failure('database', 'fatal'),
    });
    const retried = transitionBoot(state, { type: 'retry', runId: 1 });
    expect(retried).toBe(state);
  });

  it('ignores every late completion, failure, and issue from an earlier run', () => {
    let state: BootState = begin();
    state = transitionBoot(state, {
      type: 'failed',
      runId: 1,
      failure: failure('lock'),
    });
    state = transitionBoot(state, { type: 'retry', runId: 1 });
    expect(state).toMatchObject({ status: 'loading', runId: 2, stage: 'lock' });

    const staleEvents = [
      { type: 'stage-completed', runId: 1, stage: 'lock' } as const,
      { type: 'lock-required', runId: 1 } as const,
      { type: 'unlock-completed', runId: 1 } as const,
      { type: 'setup-ready', runId: 1 } as const,
      { type: 'failed', runId: 1, failure: failure('lock') } as const,
      {
        type: 'issue',
        runId: 1,
        issue: { stage: 'fcm', level: 'degraded', code: 'late' },
      } as const,
      { type: 'retry', runId: 1 } as const,
      { type: 'invalidate', runId: 1 } as const,
    ];
    for (const event of staleEvents) expect(transitionBoot(state, event)).toBe(state);
  });

  it('accepts core issues only while their core gate is current', () => {
    let state: BootState = begin();
    const lockIssue: BootIssue = {
      stage: 'lock',
      level: 'degraded',
      code: 'vault-read-slow',
    };
    state = transitionBoot(state, { type: 'issue', runId: 1, issue: lockIssue });
    expect(state.issues).toEqual([lockIssue]);

    state = transitionBoot(state, { type: 'stage-completed', runId: 1, stage: 'lock' });
    const pastIssue = transitionBoot(state, {
      type: 'issue',
      runId: 1,
      issue: { ...lockIssue, code: 'late-lock-result' },
    });
    expect(pastIssue).toBe(state);

    const futureIssue = transitionBoot(state, {
      type: 'issue',
      runId: 1,
      issue: { stage: 'database', level: 'degraded', code: 'not-started' },
    });
    expect(futureIssue).toBe(state);

    state = transitionBoot(state, { type: 'setup-ready', runId: 1 });
    const readyCoreIssue = transitionBoot(state, {
      type: 'issue',
      runId: 1,
      issue: { stage: 'session', level: 'degraded', code: 'late-session-result' },
    });
    expect(readyCoreIssue).toBe(state);
  });

  it('retains same-run issues through ready, deduplicates them, and accepts optional ready issues', () => {
    const degraded: BootIssue = {
      stage: 'device-integrity',
      level: 'diagnostic',
      code: 'native-module-unavailable',
    };
    let state: BootState = begin();
    state = transitionBoot(state, { type: 'issue', runId: 1, issue: degraded });
    const duplicate = transitionBoot(state, { type: 'issue', runId: 1, issue: degraded });
    expect(duplicate).toBe(state);

    for (const stage of CORE_BOOT_STAGES) {
      state = transitionBoot(state, { type: 'stage-completed', runId: 1, stage });
    }
    expect(state).toMatchObject({ status: 'ready', mode: 'connected', issues: [degraded] });

    const fcmIssue: BootIssue = {
      stage: 'fcm',
      level: 'degraded',
      code: 'permission-unavailable',
      userMessage: 'Messages still work while the app is open.',
    };
    state = transitionBoot(state, { type: 'issue', runId: 1, issue: fcmIssue });
    expect(state.issues).toEqual([degraded, fcmIssue]);
  });

  it('resolves only the exact same-run issue and preserves unrelated degradation', () => {
    const persistentLogs: BootIssue = {
      stage: 'persistent-logs',
      level: 'degraded',
      code: 'persistent-log-init-failed',
    };
    const fcm: BootIssue = {
      stage: 'fcm',
      level: 'degraded',
      code: 'foreground-fcm-start-failed',
    };
    let state: BootState = begin();
    state = transitionBoot(state, { type: 'issue', runId: 1, issue: persistentLogs });
    state = transitionBoot(state, { type: 'issue', runId: 1, issue: fcm });

    expect(
      transitionBoot(state, {
        type: 'issue-resolved',
        runId: 1,
        stage: 'persistent-logs',
        code: 'different-failure',
      }),
    ).toBe(state);
    expect(
      transitionBoot(state, {
        type: 'issue-resolved',
        runId: 999,
        stage: 'persistent-logs',
        code: 'persistent-log-init-failed',
      }),
    ).toBe(state);

    const resolved = transitionBoot(state, {
      type: 'issue-resolved',
      runId: 1,
      stage: 'persistent-logs',
      code: 'persistent-log-init-failed',
    });
    expect(resolved.issues).toEqual([fcm]);
    expect(
      transitionBoot(resolved, {
        type: 'issue-resolved',
        runId: 1,
        stage: 'persistent-logs',
        code: 'persistent-log-init-failed',
      }),
    ).toBe(resolved);
  });

  it('keeps one priority-aware issue per stage so one noisy stage cannot starve another', () => {
    let state: BootState = begin();
    for (let index = 0; index < 100; index += 1) {
      state = transitionBoot(state, {
        type: 'issue',
        runId: 1,
        issue: { stage: 'notifications', level: 'diagnostic', code: `issue-${index}` },
      });
    }
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.code).toBe('issue-0');

    const upgraded = transitionBoot(state, {
      type: 'issue',
      runId: 1,
      issue: {
        stage: 'notifications',
        level: 'degraded',
        code: 'permission-unavailable',
        userMessage: 'Notifications are unavailable.',
      },
    });
    expect(upgraded.issues).toHaveLength(1);
    expect(upgraded.issues[0]).toMatchObject({
      level: 'degraded',
      code: 'permission-unavailable',
    });

    const degradationCannotBeLost = transitionBoot(begin(), {
      type: 'issue',
      runId: 1,
      issue: { stage: 'fcm', level: 'degraded', code: 'fcm-unavailable' },
    });
    const enriched = transitionBoot(degradationCannotBeLost, {
      type: 'issue',
      runId: 1,
      issue: {
        stage: 'fcm',
        level: 'diagnostic',
        code: 'fcm-unavailable',
        userMessage: 'Push is unavailable.',
      },
    });
    expect(enriched.issues[0]).toMatchObject({
      level: 'degraded',
      code: 'fcm-unavailable',
      userMessage: 'Push is unavailable.',
    });

    const anotherStage = transitionBoot(upgraded, {
      type: 'issue',
      runId: 1,
      issue: { stage: 'realtime', level: 'diagnostic', code: 'socket-delayed' },
    });
    expect(anotherStage.issues).toHaveLength(2);
    expect(CORE_BOOT_STAGES.length + OPTIONAL_BOOT_STAGES.length).toBe(16);
  });

  it('invalidates an active run before reset so its run id cannot be reused', () => {
    const runOne = begin();
    const invalidated = transitionBoot(runOne, { type: 'invalidate', runId: 1 });
    expect(invalidated).toEqual({ status: 'idle', runId: 1, issues: [] });

    const runTwo = transitionBoot(invalidated, { type: 'start' });
    expect(runTwo).toMatchObject({ status: 'loading', runId: 2, stage: 'lock' });
    expect(transitionBoot(runTwo, { type: 'stage-completed', runId: 1, stage: 'lock' })).toBe(
      runTwo,
    );
  });

  it('keeps terminal states closed to unrelated progress', () => {
    let ready: BootState = loadingAt('activate');
    ready = transitionBoot(ready, { type: 'stage-completed', runId: 1, stage: 'activate' });
    const readyRejected = [
      transitionBoot(ready, { type: 'start' }),
      transitionBoot(ready, { type: 'stage-completed', runId: 1, stage: 'activate' }),
      transitionBoot(ready, { type: 'failed', runId: 1, failure: failure('activate') }),
      transitionBoot(ready, { type: 'retry', runId: 1 }),
    ];
    for (const result of readyRejected) expect(result).toBe(ready);

    let failed: BootState = loadingAt('session');
    failed = transitionBoot(failed, {
      type: 'failed',
      runId: 1,
      failure: failure('session', 'fatal'),
    });
    const failedRejected = [
      transitionBoot(failed, { type: 'start' }),
      transitionBoot(failed, { type: 'stage-completed', runId: 1, stage: 'session' }),
      transitionBoot(failed, { type: 'retry', runId: 1 }),
    ];
    for (const result of failedRejected) expect(result).toBe(failed);
  });
});
