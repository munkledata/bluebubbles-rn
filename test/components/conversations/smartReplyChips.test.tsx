/**
 * SmartReplyChips (src/ui/conversations/SmartReplyChips.tsx): a horizontal row of tappable
 * suggested-reply chips shown above the composer. The chip strings come from the
 * `useSmartReplies(messages)` hook (which is async + store-gated), so we mock that hook to feed
 * the component a controlled suggestion list — the component's OWN behaviour under test is:
 * map suggestions -> chips, tap a chip -> onPick(thatString), empty suggestions -> render nothing.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { SmartReplyChips } from '@ui/conversations/SmartReplyChips';
import { useSmartReplies } from '@features/conversations/useSmartReplies';

// The suggestion source is a hook, not a prop — mock it so tests choose the chips directly.
jest.mock('@features/conversations/useSmartReplies', () => ({
  useSmartReplies: jest.fn(() => [] as string[]),
}));

const mockedUseSmartReplies = useSmartReplies as jest.MockedFunction<typeof useSmartReplies>;

function setSuggestions(suggestions: string[]): void {
  mockedUseSmartReplies.mockReturnValue(suggestions);
}

describe('SmartReplyChips', () => {
  afterEach(() => {
    mockedUseSmartReplies.mockReset();
    mockedUseSmartReplies.mockReturnValue([]);
  });

  it('renders one chip per suggestion', async () => {
    setSuggestions(['Sounds good', 'On my way', 'Thanks!']);
    await renderWithTheme(<SmartReplyChips messages={[]} onPick={jest.fn()} />);

    expect(screen.getByText('Sounds good')).toBeTruthy();
    expect(screen.getByText('On my way')).toBeTruthy();
    expect(screen.getByText('Thanks!')).toBeTruthy();
  });

  it('calls onPick with the tapped chip text', async () => {
    setSuggestions(['Yes', 'No']);
    const onPick = jest.fn();
    await renderWithTheme(<SmartReplyChips messages={[]} onPick={onPick} />);

    fireEvent.press(screen.getByText('No'));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('No');
  });

  it('renders nothing when there are no suggestions', async () => {
    setSuggestions([]);
    const { toJSON } = await renderWithTheme(
      <SmartReplyChips messages={[]} onPick={jest.fn()} />,
    );

    expect(toJSON()).toBeNull();
    expect(screen.queryByText('Yes')).toBeNull();
  });

  it('renders chip text verbatim (no escaping/interpretation of the suggestion string)', async () => {
    setSuggestions(['<b>hi</b> & bye']);
    await renderWithTheme(<SmartReplyChips messages={[]} onPick={jest.fn()} />);

    expect(screen.getByText('<b>hi</b> & bye')).toBeTruthy();
  });
});
