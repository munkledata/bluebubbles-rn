import {
  findMentionQuery,
  insertAuthoredMention,
  mentionsForTrimmedText,
  reconcileAuthoredMentions,
} from '@/ui/conversations/mentionAuthoring';

describe('mention authoring', () => {
  it('finds and replaces the active query with an exact participant range', () => {
    const query = findMentionQuery('Hello @ali', 10);
    expect(query).toEqual({ start: 6, end: 10, query: 'ali' });
    expect(
      insertAuthoredMention('Hello @ali', [], query!, {
        address: '+15551234567',
        label: 'Alice',
      }),
    ).toEqual({
      text: 'Hello Alice',
      mentions: [{ start: 6, length: 5, address: '+15551234567' }],
      cursor: 11,
    });
  });

  it('shifts untouched ranges and removes a range edited through its label', () => {
    const mention = [{ start: 3, length: 5, address: 'alice@example.test' }];
    expect(reconcileAuthoredMentions('Hi Alice', 'Well, hi Alice', mention).mentions).toEqual([
      { start: 9, length: 5, address: 'alice@example.test' },
    ]);
    expect(reconcileAuthoredMentions('Hi Alice', 'Hi Alix', mention).mentions).toEqual([]);
  });

  it('normalizes leading whitespace onto the exact trimmed outbound body', () => {
    expect(
      mentionsForTrimmedText('  Alice hello  ', [
        { start: 2, length: 5, address: 'alice@example.test' },
      ]),
    ).toEqual([{ start: 0, length: 5, address: 'alice@example.test' }]);
    expect(
      mentionsForTrimmedText('Alice', [{ start: 4, length: 4, address: 'alice@example.test' }]),
    ).toBeNull();
  });
});
