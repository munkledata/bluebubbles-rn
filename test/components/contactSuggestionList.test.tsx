/**
 * ContactSuggestionList (src/ui/ContactSuggestionList.tsx) — the shared tappable suggestion
 * rows under a recipient input (new-chat, FaceTime dialer). Locks in:
 *   - each pick renders its name with the address as a secondary line;
 *   - a nameless pick shows its address as the title (no secondary line);
 *   - tapping a row reports the full pick via `onPick`;
 *   - an empty list renders nothing.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from './support/renderWithTheme';
import { ContactSuggestionList } from '@ui/ContactSuggestionList';
import type { ContactPick } from '@db/repositories';

describe('ContactSuggestionList', () => {
  it('renders name + address rows, and address-only for a nameless pick', async () => {
    await renderWithTheme(
      <ContactSuggestionList
        suggestions={[
          { name: 'Alice', address: '+15550000001' },
          { name: '', address: 'bob@example.com' },
        ]}
        onPick={jest.fn()}
      />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('+15550000001')).toBeTruthy();
    // The nameless pick falls back to its address as the title, rendered exactly once.
    expect(screen.getAllByText('bob@example.com')).toHaveLength(1);
  });

  it('reports the tapped pick via onPick', async () => {
    const onPick = jest.fn();
    const pick: ContactPick = { name: 'Alice', address: '+15550000001' };
    await renderWithTheme(<ContactSuggestionList suggestions={[pick]} onPick={onPick} />);
    await act(async () => {
      fireEvent.press(screen.getByText('Alice'));
    });
    expect(onPick).toHaveBeenCalledWith(pick);
  });

  it('renders nothing when there are no suggestions', async () => {
    const result = await renderWithTheme(
      <ContactSuggestionList suggestions={[]} onPick={jest.fn()} />,
    );
    expect(result.toJSON()).toBeNull();
  });
});
