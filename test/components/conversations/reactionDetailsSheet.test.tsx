/**
 * ReactionDetailsSheet (src/ui/conversations/ReactionDetailsSheet.tsx): the "who reacted" bottom
 * sheet opened by tapping a message's reaction badges. Locked in:
 *   - one row per reactor showing the reaction glyph + the reactor's name;
 *   - the current user's reaction shows "You" (never a name);
 *   - an arbitrary-emoji tapback shows its own glyph, not a classic emoji;
 *   - the backdrop closes parent-owned data, which can then open a fresh reaction set;
 *   - `data={null}` renders nothing.
 *
 * Renders inside a RN Modal whose mount is async → assert the first hit via findBy. Only
 * safe-area-context needs mocking (prop-driven, no DB fetch).
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { reactionMeta } from '@core/reactions/reactionType';
import type { ReactionRow } from '@db/repositories';
import type { ReactionBaseType } from '@core/reactions/reactionType';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { ReactionDetailsSheet } from '@ui/conversations/ReactionDetailsSheet';

const PRIVATE_REACTOR = 'private-reactor-w-a91d@example.test';
const PRIVATE_EMOJI = 'W-private-emoji-7c91-🧪';
const FRESH_REACTOR = 'fresh-reactor-w-b42e@example.test';
const FRESH_EMOJI = 'W-fresh-emoji-38da-🌀';

function reaction(
  over: Partial<ReactionRow> & { baseType: ReactionBaseType | 'emoji' },
): ReactionRow {
  return {
    targetGuid: 'msg-1',
    emoji: null,
    isFromMe: 0,
    senderName: null,
    dateCreated: 1_000,
    ...over,
  } as ReactionRow;
}

type SheetData = NonNullable<React.ComponentProps<typeof ReactionDetailsSheet>['data']>;

function StatefulSheet({
  initialData,
  freshData,
  onClose,
}: {
  initialData: SheetData | null;
  freshData: SheetData;
  onClose: () => void;
}): React.JSX.Element {
  const [data, setData] = React.useState<SheetData | null>(initialData);
  const close = React.useCallback(() => {
    onClose();
    setData(null);
  }, [onClose]);

  return (
    <>
      <ReactionDetailsSheet data={data} onClose={close} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open fresh reactions"
        onPress={() => setData(freshData)}
      >
        <Text>Open fresh reactions</Text>
      </Pressable>
    </>
  );
}

function privateData(): SheetData {
  return {
    reactions: [
      reaction({ baseType: 'emoji', emoji: PRIVATE_EMOJI, senderName: PRIVATE_REACTOR }),
      reaction({ baseType: 'like', isFromMe: 1 }),
    ],
  };
}

function freshData(): SheetData {
  return {
    reactions: [reaction({ baseType: 'emoji', emoji: FRESH_EMOJI, senderName: FRESH_REACTOR })],
  };
}

describe('ReactionDetailsSheet', () => {
  it('lists each reactor with their glyph, and shows "You" for the current user', async () => {
    await renderWithTheme(
      <ReactionDetailsSheet
        data={{
          reactions: [
            reaction({ baseType: 'love', isFromMe: 0, senderName: PRIVATE_REACTOR }),
            reaction({ baseType: 'like', isFromMe: 1 }),
          ],
        }}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Reactions')).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_REACTOR })).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain(PRIVATE_REACTOR);
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy(); // ❤️ next to the reactor
    expect(screen.getByText(reactionMeta('like').emoji)).toBeTruthy(); // 👍 next to You
  });

  it('shows the arbitrary-emoji glyph itself for an emoji tapback', async () => {
    await renderWithTheme(
      <ReactionDetailsSheet
        data={{
          reactions: [
            reaction({ baseType: 'emoji', emoji: PRIVATE_EMOJI, senderName: PRIVATE_REACTOR }),
          ],
        }}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByRole('text', { name: PRIVATE_REACTOR })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_EMOJI })).toBeTruthy();
  });

  it('renders nothing when data is null', async () => {
    const onClose = jest.fn();
    await renderWithTheme(<ReactionDetailsSheet data={null} onClose={onClose} />);
    await waitFor(() => expect(screen.queryByText('Reactions')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the empty state for an open reaction set with no rows', async () => {
    await renderWithTheme(<ReactionDetailsSheet data={{ reactions: [] }} onClose={jest.fn()} />);
    expect(await screen.findByText('No reactions.')).toBeTruthy();
  });

  it('closes parent-owned data through the real backdrop and can open a fresh reaction set', async () => {
    const onClose = jest.fn();
    const view = await renderWithTheme(
      <StatefulSheet initialData={privateData()} freshData={freshData()} onClose={onClose} />,
    );
    expect(await screen.findByRole('text', { name: PRIVATE_REACTOR })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_EMOJI })).toBeTruthy();

    await fireEvent.press(screen.getByTestId('reaction-details-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Reactions')).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_REACTOR);
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_EMOJI);

    await fireEvent.press(screen.getByRole('button', { name: 'Open fresh reactions' }));
    expect(await screen.findByRole('text', { name: FRESH_REACTOR })).toBeTruthy();
    expect(screen.getByRole('text', { name: FRESH_EMOJI })).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(FRESH_REACTOR);
    expect(JSON.stringify(view.toJSON())).toContain(FRESH_EMOJI);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
