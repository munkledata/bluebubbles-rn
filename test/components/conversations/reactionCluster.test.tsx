/**
 * ReactionCluster (src/ui/conversations/ReactionCluster.tsx) — tapback badges.
 * Behaviors locked in (all derived from the source + @core/reactions/reactionType META):
 *   - one badge per DISTINCT baseType, in first-seen order (dedupe via Set)
 *   - each badge shows that reaction type's emoji
 *   - "mine" badges (a reaction with isFromMe) tint; others use the received-bubble color
 *   - empty reactions → renders nothing
 * Expected colors come from DEFAULT_PRESET ('oled-dark') → darkTheme tokens.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { ReactionCluster } from '@ui/conversations/ReactionCluster';
import { darkTheme } from '@ui/theme/tokens';
import { reactionMeta } from '@core/reactions/reactionType';
import type { ReactionRow } from '@db/repositories';
import type { ReactionBaseType } from '@core/reactions/reactionType';

function reaction(over: Partial<ReactionRow> & { baseType: ReactionBaseType }): ReactionRow {
  return {
    targetGuid: 'msg-1',
    emoji: null,
    isFromMe: 0,
    senderName: null,
    dateCreated: 1_000,
    ...over,
  };
}

/** The badge View wrapping an emoji Text = the emoji node's parent. */
function badgeStyleFor(emoji: string): Record<string, unknown> {
  const text = screen.getByText(emoji);
  return StyleSheet.flatten(text.parent?.props.style) as Record<string, unknown>;
}

describe('ReactionCluster', () => {
  it('renders one badge with the emoji for a single reaction', async () => {
    await renderWithTheme(
      <ReactionCluster reactions={[reaction({ baseType: 'love' })]} isFromMe={false} />,
    );
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy(); // ❤️
  });

  it('collapses multiple reactions of the SAME type into one badge', async () => {
    await renderWithTheme(
      <ReactionCluster
        reactions={[
          reaction({ baseType: 'like', senderName: 'A' }),
          reaction({ baseType: 'like', senderName: 'B' }),
        ]}
        isFromMe={false}
      />,
    );
    expect(screen.getAllByText(reactionMeta('like').emoji)).toHaveLength(1); // 👍 once
  });

  it('renders a distinct badge per distinct type', async () => {
    await renderWithTheme(
      <ReactionCluster
        reactions={[reaction({ baseType: 'love' }), reaction({ baseType: 'laugh' })]}
        isFromMe={false}
      />,
    );
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy(); // ❤️
    expect(screen.getByText(reactionMeta('laugh').emoji)).toBeTruthy(); // 😂
  });

  it('tints a badge the current user made, and uses the received color for others', async () => {
    await renderWithTheme(
      <ReactionCluster
        reactions={[
          reaction({ baseType: 'love', isFromMe: 1 }), // mine → tint
          reaction({ baseType: 'like', isFromMe: 0 }), // theirs → received bg
        ]}
        isFromMe={false}
      />,
    );
    expect(badgeStyleFor(reactionMeta('love').emoji).backgroundColor).toBe(darkTheme.color.tint);
    expect(badgeStyleFor(reactionMeta('like').emoji).backgroundColor).toBe(
      darkTheme.color.bubble.receivedBackgroundBottom,
    );
  });

  it('renders nothing for an empty reaction list', async () => {
    await renderWithTheme(<ReactionCluster reactions={[]} isFromMe={false} />);
    // No badge emojis present for any reaction type.
    expect(screen.queryByText(reactionMeta('love').emoji)).toBeNull();
    expect(screen.queryByText(reactionMeta('like').emoji)).toBeNull();
  });

  it('fires onPress when the cluster (a button) is tapped', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <ReactionCluster
        reactions={[reaction({ baseType: 'love' })]}
        isFromMe={false}
        onPress={onPress}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'View who reacted' }));
    await waitFor(() => expect(onPress).toHaveBeenCalledTimes(1));
  });

  it('stays inert (no button) when no handler is given', async () => {
    await renderWithTheme(<ReactionCluster reactions={[reaction({ baseType: 'love' })]} isFromMe={false} />);
    expect(screen.queryByRole('button', { name: 'View who reacted' })).toBeNull();
  });
});
