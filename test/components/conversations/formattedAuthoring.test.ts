import {
  formattingForTrimmedText,
  reconcileAuthoredFormatting,
  selectionHasStyle,
  toggleAuthoredStyle,
} from '@/ui/conversations/formattedAuthoring';

describe('formatted-message authoring', () => {
  it('toggles and combines canonical styles across explicit selections', () => {
    const bold = toggleAuthoredStyle('Hello world', [], { start: 0, end: 5 }, 'bold');
    expect(bold).toEqual([{ start: 0, length: 5, styles: ['bold'] }]);

    const combined = toggleAuthoredStyle('Hello world', bold!, { start: 3, end: 11 }, 'italic');
    expect(combined).toEqual([
      { start: 0, length: 3, styles: ['bold'] },
      { start: 3, length: 2, styles: ['bold', 'italic'] },
      { start: 5, length: 6, styles: ['italic'] },
    ]);
    expect(selectionHasStyle(combined!, { start: 3, end: 5 }, 'bold')).toBe(true);
    expect(selectionHasStyle(combined!, { start: 3, end: 11 }, 'bold')).toBe(false);
  });

  it('shifts untouched ranges, drops an edited range, and normalizes trimmed text', () => {
    const range = [{ start: 3, length: 5, styles: ['underline'] as 'underline'[] }];
    expect(reconcileAuthoredFormatting('Hi Alice', 'Well, hi Alice', range).textFormatting).toEqual(
      [{ start: 9, length: 5, styles: ['underline'] }],
    );
    expect(reconcileAuthoredFormatting('Hi Alice', 'Hi Alix', range).textFormatting).toEqual([]);
    expect(
      formattingForTrimmedText('  Hello  ', [{ start: 2, length: 5, styles: ['bold'] }]),
    ).toEqual([{ start: 0, length: 5, styles: ['bold'] }]);
    expect(
      formattingForTrimmedText('A B', [{ start: 1, length: 1, styles: ['underline'] }]),
    ).toEqual([{ start: 1, length: 1, styles: ['underline'] }]);
  });

  it('permits bounded spaces but rejects empty selections and split graphemes', () => {
    expect(toggleAuthoredStyle('Hello', [], { start: 2, end: 2 }, 'bold')).toBeNull();
    expect(toggleAuthoredStyle('a b', [], { start: 1, end: 2 }, 'underline')).toEqual([
      { start: 1, length: 1, styles: ['underline'] },
    ]);
    expect(toggleAuthoredStyle('👩🏽‍💻', [], { start: 0, end: 2 }, 'bold')).toBeNull();
  });
});
