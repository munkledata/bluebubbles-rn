import {
  findMessageEntities,
  splitMessageEntitySpans,
  type MessageDateEntity,
  type MessagePhoneEntity,
  type MessageUrlEntity,
} from '@core/richtext';
import {
  performMessageEntityAction,
  type MessageEntityActionDependencies,
} from '@/services/messageEntityActions';

function actionDependencies(): jest.Mocked<MessageEntityActionDependencies> {
  return {
    openUrl: jest.fn(async (_url: string) => true),
    copyText: jest.fn(async (_text: string) => undefined),
    openCalendarDraft: jest.fn(async (_date: MessageDateEntity) => undefined),
  };
}

describe('message entities', () => {
  it('recognizes only explicit web, strongly formatted phone, and full-year date entities', () => {
    const text =
      'See https://example.com/docs, call (303) 555-0199, +1 (720) 555-0100, or +44 20 7946 0958 on August 28, 2026.';
    const entities = findMessageEntities(text);

    expect(entities.map(({ kind, text: display }) => [kind, display])).toEqual([
      ['url', 'https://example.com/docs'],
      ['phone', '(303) 555-0199'],
      ['phone', '+1 (720) 555-0100'],
      ['phone', '+44 20 7946 0958'],
      ['date', 'August 28, 2026'],
    ]);
    expect(
      splitMessageEntitySpans(text)
        .map((span) => (span.kind === 'text' ? span.text : span.entity.text))
        .join(''),
    ).toBe(text);
  });

  it('rejects ambiguous and invalid text instead of guessing a native action', () => {
    expect(
      findMessageEntities(
        'www.example.com user@example.com 3035550199 123-456-7890 3/4/2026 tomorrow 2026-02-30',
      ),
    ).toEqual([]);
    expect(
      findMessageEntities('https://user:password@example.com/303-555-0199 javascript:alert(1)'),
    ).toEqual([]);
    expect(findMessageEntities('303-555-0199@example.com')).toEqual([]);
    expect(findMessageEntities('Call (303) 555-0199 ext 42')).toEqual([]);
    expect(findMessageEntities('Do not reinterpret +44 303-555-0199')).toEqual([]);
    expect(findMessageEntities(`http://a${')'.repeat(3_000)}`)).toEqual([]);
    expect(
      findMessageEntities(
        `${'https://user:password@example.com/x '.repeat(192)}https://user:password@example.com/303-555-0199`,
      ),
    ).toEqual([]);
  });

  it('lets an enclosing URL win over phone-shaped path text and trims sentence punctuation', () => {
    expect(findMessageEntities('Open https://example.com/call/303-555-0199).')).toEqual([
      expect.objectContaining({
        kind: 'url',
        text: 'https://example.com/call/303-555-0199',
        url: 'https://example.com/call/303-555-0199',
      }),
    ]);
  });

  it('maps validated entities only to the closed browser, phone, copy, and calendar actions', async () => {
    const dependencies = actionDependencies();
    const entities = findMessageEntities('https://example.com (303) 555-0199 August 28, 2026');
    const url = entities.find((entity): entity is MessageUrlEntity => entity.kind === 'url')!;
    const phone = entities.find((entity): entity is MessagePhoneEntity => entity.kind === 'phone')!;
    const date = entities.find((entity): entity is MessageDateEntity => entity.kind === 'date')!;

    await expect(
      performMessageEntityAction({ action: 'open-url', entity: url }, dependencies),
    ).resolves.toBe(true);
    await expect(
      performMessageEntityAction({ action: 'dial-phone', entity: phone }, dependencies),
    ).resolves.toBe(true);
    await expect(
      performMessageEntityAction({ action: 'message-phone', entity: phone }, dependencies),
    ).resolves.toBe(true);
    await expect(
      performMessageEntityAction({ action: 'copy-phone', entity: phone }, dependencies),
    ).resolves.toBe(true);
    await expect(
      performMessageEntityAction({ action: 'open-calendar-draft', entity: date }, dependencies),
    ).resolves.toBe(true);
    await expect(
      performMessageEntityAction({ action: 'copy-date', entity: date }, dependencies),
    ).resolves.toBe(true);

    expect(dependencies.openUrl.mock.calls).toEqual([
      ['https://example.com'],
      ['tel:+13035550199'],
      ['sms:+13035550199'],
    ]);
    expect(dependencies.copyText.mock.calls).toEqual([['(303) 555-0199'], ['August 28, 2026']]);
    expect(dependencies.openCalendarDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        startUtcMs: Date.UTC(2026, 7, 28),
        endUtcMs: Date.UTC(2026, 7, 29),
      }),
    );

    const forged = { ...phone, number: '+19999999999' };
    await expect(
      performMessageEntityAction({ action: 'dial-phone', entity: forged }, dependencies),
    ).resolves.toBe(false);
    expect(dependencies.openUrl).toHaveBeenCalledTimes(3);
  });
});
