import {
  projectCapturedDiagnosticEvent,
  projectStoredDiagnosticEvent,
  RedactingLogger,
  SHARE_INTAKE_EVENT_OUTCOMES,
  SHARE_INTAKE_EVENT_STAGES,
  SHARE_INTAKE_EVENT_TARGETS,
  SHARE_INTAKE_HELD_AGES,
  shareIntakeEventOutcome,
} from '@core/secure';

describe('share.intake diagnostic event', () => {
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  });

  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  });

  it('reaches a release sink as a finite, counts-only info line', () => {
    const writes: unknown[] = [];
    const log = new RedactingLogger({ write: (...args) => void writes.push(args) });

    log.event('share.intake', { stage: 'pickup', outcome: 'staged', files: 2, text: true });

    expect(writes).toEqual([
      [
        'info',
        'share.intake [stage:pickup|outcome:staged|files:2|text:yes]',
        { schemaVersion: 1, stage: 'pickup', outcome: 'staged', files: 2, text: true },
      ],
    ]);
  });

  it('keeps every field it allows, in a fixed order', () => {
    expect(
      projectCapturedDiagnosticEvent('share.intake', {
        held: 'under-1h',
        target: 'resolved',
        text: false,
        files: 3,
        outcome: 'chat',
        stage: 'route',
      }),
    ).toEqual({
      message:
        'share.intake [stage:route|outcome:chat|files:3|text:no|target:resolved|held:under-1h]',
      tag: 'share',
      meta: {
        schemaVersion: 1,
        stage: 'route',
        outcome: 'chat',
        files: 3,
        text: false,
        target: 'resolved',
        held: 'under-1h',
      },
    });
  });

  it('drops ids, names, text and anything off its lists', () => {
    const event = projectCapturedDiagnosticEvent('share.intake', {
      stage: 'PRIVATE_STAGE',
      outcome: 'hello from a shared note',
      files: 100,
      text: 'yes',
      target: 'iMessage;-;+15551234567',
      held: '5 minutes',
      batchId: '1720000000000-1-0123456789abcdef',
      chatGuid: 'iMessage;-;+15551234567',
      name: 'private-photo.jpg',
      sharedText: 'PRIVATE_SHARED_TEXT',
    });

    expect(event).toEqual({
      message: 'share.intake [stage:unknown|outcome:unknown]',
      tag: 'share',
      meta: { schemaVersion: 1, stage: 'unknown', outcome: 'unknown' },
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|15551234567|private-photo|1720000000000/);
  });

  it.each([-1, 2.5, 100, Number.NaN, '3'])('drops a file count of %p', (files) => {
    expect(
      projectCapturedDiagnosticEvent('share.intake', { stage: 'pickup', outcome: 'staged', files })
        ?.meta,
    ).toEqual({ schemaVersion: 1, stage: 'pickup', outcome: 'staged' });
  });

  it('re-checks a stored line on restore, so a tampered entry cannot carry text', () => {
    const report = projectStoredDiagnosticEvent({
      message: 'share.intake [stage:pickup|outcome:PRIVATE_SHARED_TEXT]',
      meta: JSON.stringify({
        schemaVersion: 1,
        stage: 'pickup',
        outcome: 'PRIVATE_SHARED_TEXT',
        files: 1,
        sharedText: 'PRIVATE_SHARED_TEXT',
      }),
    });

    expect(report).toEqual({
      level: 'info',
      message: 'share.intake [stage:pickup|outcome:unknown|files:1]',
      tag: 'share',
      meta: JSON.stringify({ schemaVersion: 1, stage: 'pickup', outcome: 'unknown', files: 1 }),
    });
  });

  it('passes every allowed label through unchanged', () => {
    for (const stage of SHARE_INTAKE_EVENT_STAGES) {
      expect(
        projectCapturedDiagnosticEvent('share.intake', { stage, outcome: 'none' })?.meta,
      ).toEqual({ schemaVersion: 1, stage, outcome: 'none' });
    }
    for (const outcome of SHARE_INTAKE_EVENT_OUTCOMES) {
      expect(shareIntakeEventOutcome(outcome)).toBe(outcome);
    }
    for (const target of SHARE_INTAKE_EVENT_TARGETS) {
      expect(
        projectCapturedDiagnosticEvent('share.intake', {
          stage: 'route',
          outcome: 'new-chat',
          target,
        })?.meta,
      ).toMatchObject({ target });
    }
    for (const held of SHARE_INTAKE_HELD_AGES) {
      expect(
        projectCapturedDiagnosticEvent('share.intake', {
          stage: 'held',
          outcome: 'foreground',
          held,
        })?.meta,
      ).toMatchObject({ held });
    }
  });

  it('maps every native rejection reason, and nothing else', () => {
    for (const reason of [
      'count',
      'file_size',
      'batch_size',
      'text_size',
      'deadline',
      'empty',
      'scheme',
      'permission',
      'provider',
      'cache_quota',
      'busy',
      'malformed',
      'unavailable',
    ]) {
      expect(shareIntakeEventOutcome(reason)).toBe(reason);
    }
    expect(shareIntakeEventOutcome('COUNT')).toBe('unknown');
    expect(shareIntakeEventOutcome('a reason with private words')).toBe('unknown');
    expect(shareIntakeEventOutcome(undefined)).toBe('unknown');
    expect(shareIntakeEventOutcome('x'.repeat(65))).toBe('unknown');
  });
});
