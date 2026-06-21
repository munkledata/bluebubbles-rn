import { ruleSmartReplyProvider, suggestForText } from '@core/smartReply';

describe('suggestForText', () => {
  it('offers yes/no/maybe for a question', () => {
    expect(suggestForText('Are you coming?')).toEqual(['Yes', 'No', 'Maybe']);
  });

  it('responds to thanks', () => {
    expect(suggestForText('thanks so much')).toEqual(["You're welcome!", 'No problem', '👍']);
  });

  it('responds to a greeting', () => {
    expect(suggestForText('hey there')).toEqual(['Hey!', 'Hello!', 'What’s up?']);
  });

  it('falls back to generic suggestions', () => {
    expect(suggestForText('the package arrived')).toEqual(['Sounds good', 'Thanks!', 'Got it']);
  });

  it('returns nothing for empty text and caps at 3 unique', () => {
    expect(suggestForText('   ')).toEqual([]);
    expect(suggestForText('ok perfect cool').length).toBeLessThanOrEqual(3);
  });
});

describe('ruleSmartReplyProvider', () => {
  it('suggests a reply to the latest inbound message', async () => {
    const out = await ruleSmartReplyProvider.suggest([
      { text: 'Hey!', isFromMe: true },
      { text: 'Want to grab lunch?', isFromMe: false },
    ]);
    expect(out).toEqual(['Yes', 'No', 'Maybe']);
  });

  it('returns nothing when the last message is mine', async () => {
    const out = await ruleSmartReplyProvider.suggest([
      { text: 'Want to grab lunch?', isFromMe: false },
      { text: 'I already ate', isFromMe: true },
    ]);
    expect(out).toEqual([]);
  });

  it('returns nothing with no history', async () => {
    expect(await ruleSmartReplyProvider.suggest([])).toEqual([]);
  });
});
