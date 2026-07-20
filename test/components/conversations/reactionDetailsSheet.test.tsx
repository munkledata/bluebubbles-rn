/**
 * ReactionDetailsSheet (src/ui/conversations/ReactionDetailsSheet.tsx): the "who reacted" bottom
 * sheet opened by tapping a message's reaction badges. Locked in:
 *   - one row per reactor showing the reaction glyph + the reactor's name;
 *   - the current user's reaction shows "You" (never a name);
 *   - an arbitrary-emoji tapback shows its own glyph, not a classic emoji;
 *   - redacted mode masks other people's names (privacy rule — the sheet must not leak a name a
 *     redacted thread hides), while "You" and the glyphs stay;
 *   - `data={null}` renders nothing.
 *
 * Renders inside a RN Modal whose mount is async → assert the first hit via findBy. Only
 * safe-area-context needs mocking (prop-driven, no DB fetch).
 */
import React from 'react';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { reactionMeta } from '@core/reactions/reactionType';
import type { ReactionRow } from '@db/repositories';
import type { ReactionBaseType } from '@core/reactions/reactionType';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { ReactionDetailsSheet } from '@ui/conversations/ReactionDetailsSheet';

function reaction(over: Partial<ReactionRow> & { baseType: ReactionBaseType | 'emoji' }): ReactionRow {
  return {
    targetGuid: 'msg-1',
    emoji: null,
    isFromMe: 0,
    senderName: null,
    dateCreated: 1_000,
    ...over,
  } as ReactionRow;
}

describe('ReactionDetailsSheet', () => {
  beforeEach(() => {
    useRedactedModeStore.setState({ enabled: false });
  });

  it('lists each reactor with their glyph, and shows "You" for the current user', async () => {
    await renderWithTheme(
      <ReactionDetailsSheet
        data={{
          reactions: [
            reaction({ baseType: 'love', isFromMe: 0, senderName: 'Alice' }),
            reaction({ baseType: 'like', isFromMe: 1 }),
          ],
        }}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Reactions')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy(); // ❤️ next to Alice
    expect(screen.getByText(reactionMeta('like').emoji)).toBeTruthy(); // 👍 next to You
  });

  it('shows the arbitrary-emoji glyph itself for an emoji tapback', async () => {
    await renderWithTheme(
      <ReactionDetailsSheet
        data={{ reactions: [reaction({ baseType: 'emoji', emoji: '🎉', senderName: 'Bob' })] }}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(screen.getByText('🎉')).toBeTruthy();
  });

  it('masks other people’s names under redacted mode but keeps "You" and glyphs', async () => {
    useRedactedModeStore.setState({ enabled: true });
    await renderWithTheme(
      <ReactionDetailsSheet
        data={{
          reactions: [
            reaction({ baseType: 'love', isFromMe: 0, senderName: 'Alice Wonderland' }),
            reaction({ baseType: 'like', isFromMe: 1 }),
          ],
        }}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Reactions');
    // The real name must appear NOWHERE in the tree (text or a11y labels).
    expect(JSON.stringify(screen.toJSON())).not.toContain('Alice Wonderland');
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy();
  });

  it('renders nothing when data is null', async () => {
    await renderWithTheme(<ReactionDetailsSheet data={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Reactions')).toBeNull());
  });
});
