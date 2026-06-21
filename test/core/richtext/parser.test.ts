import { hasMention, parseAttributedRuns } from '@core/richtext';

// A realistic BlueBubbles attributedBody for "Hey @Alice!" where "@Alice" is a
// confirmed mention. range is NSRange [start, length]; the only meaningful
// attribute keys are messagePart, the mention, and the attachment GUID.
const MENTION_BODY = JSON.stringify([
  {
    string: 'Hey @Alice!',
    runs: [
      { range: [0, 4], attributes: { __kIMMessagePartAttributeName: 0 } },
      {
        range: [4, 6],
        attributes: {
          __kIMMessagePartAttributeName: 0,
          __kIMMentionConfirmedMention: '+15551234567',
        },
      },
      { range: [10, 1], attributes: { __kIMMessagePartAttributeName: 0 } },
    ],
  },
]);

describe('parseAttributedRuns', () => {
  it('falls back to a single plain run when there is no attributedBody', () => {
    expect(parseAttributedRuns(null, 'hello')).toEqual([{ text: 'hello' }]);
    expect(parseAttributedRuns(undefined, null)).toEqual([{ text: '' }]);
  });

  it('falls back to plain text on malformed JSON', () => {
    expect(parseAttributedRuns('{not json', 'plain')).toEqual([{ text: 'plain' }]);
  });

  it('splits a mention out of the surrounding text by NSRange [start, length]', () => {
    const runs = parseAttributedRuns(MENTION_BODY, 'Hey @Alice!');
    expect(runs).toEqual([{ text: 'Hey ' }, { text: '@Alice', mention: true }, { text: '!' }]);
    expect(hasMention(runs)).toBe(true);
  });

  it('treats a part with no runs as one plain run', () => {
    const body = JSON.stringify([{ string: 'just text', runs: [] }]);
    expect(parseAttributedRuns(body, 'x')).toEqual([{ text: 'just text' }]);
  });

  it('flags inline attachment placeholders', () => {
    const body = JSON.stringify([
      {
        string: '￼ photo',
        runs: [
          { range: [0, 1], attributes: { __kIMFileTransferGUIDAttributeName: 'att-guid' } },
          { range: [1, 6] },
        ],
      },
    ]);
    const runs = parseAttributedRuns(body, '');
    expect(runs[0]).toEqual({ text: '￼', attachment: true });
    expect(runs[1]).toEqual({ text: ' photo' });
    expect(hasMention(runs)).toBe(false);
  });

  it('ignores unknown attribute keys (forward compatible) → plain text', () => {
    const body = JSON.stringify([
      { string: 'bold?', runs: [{ range: [0, 5], attributes: { __kIMSomeFutureStyle: 1 } }] },
    ]);
    expect(parseAttributedRuns(body, 'bold?')).toEqual([{ text: 'bold?' }]);
  });

  it('fills gaps when runs do not tile the whole string (no text dropped)', () => {
    // Realistic: a single mention run inside a longer string, leaving gaps.
    const body = JSON.stringify([
      {
        string: 'Hey @bob check this',
        runs: [{ range: [4, 4], attributes: { __kIMMentionConfirmedMention: 'b@x.com' } }],
      },
    ]);
    const runs = parseAttributedRuns(body, 'Hey @bob check this');
    expect(runs).toEqual([
      { text: 'Hey ' },
      { text: '@bob', mention: true },
      { text: ' check this' },
    ]);
    // The full message text is preserved.
    expect(runs.map((r) => r.text).join('')).toBe('Hey @bob check this');
  });

  it('concatenates runs across multiple parts', () => {
    const body = JSON.stringify([
      { string: 'one', runs: [] },
      { string: 'two', runs: [] },
    ]);
    expect(parseAttributedRuns(body, '')).toEqual([{ text: 'one' }, { text: 'two' }]);
  });
});
