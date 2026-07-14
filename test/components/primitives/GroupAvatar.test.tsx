/**
 * GroupAvatar (src/ui/primitives/GroupAvatar.tsx): two overlapped Avatars for a group chat —
 * back = names[0], front = names[1] (falling back to names[0] when there's only one). Callers
 * feed it the already-collapsed participant list (see dedupeParticipants in src/utils/chat.ts,
 * which collapses one person reachable via multiple handles); GroupAvatar itself just draws the
 * first two entries it's given.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { GroupAvatar } from '@ui/primitives/GroupAvatar';
import { dedupeParticipants } from '@utils/chat';

describe('GroupAvatar', () => {
  it('draws the first two participants (back + front)', async () => {
    await renderWithTheme(<GroupAvatar names={['Alice', 'Bob', 'Carol']} />);
    expect(screen.getByText('A')).toBeTruthy(); // Alice → back
    expect(screen.getByText('B')).toBeTruthy(); // Bob → front
    expect(screen.queryByText('C')).toBeNull(); // Carol is not drawn
  });

  it('reuses the sole name for both tiles when only one participant is given', async () => {
    await renderWithTheme(<GroupAvatar names={['Solo']} />);
    expect(screen.getAllByText('S')).toHaveLength(2); // back AND front fall back to names[0]
  });

  it('falls back to "?" for both tiles with an empty participant list', async () => {
    await renderWithTheme(<GroupAvatar names={[]} />);
    expect(screen.getAllByText('?')).toHaveLength(2);
  });

  it('after dedupeParticipants collapses a repeated person, the collage shows two DISTINCT people', async () => {
    // Same person reachable via two handles (same name+photo) collapses to one entry, so the
    // second tile is the genuinely different next person — not a duplicate of the first.
    const { names } = dedupeParticipants(
      ['Alice', 'Alice', 'Bob'],
      [null, null, null],
    );
    expect(names).toEqual(['Alice', 'Bob']);
    await renderWithTheme(<GroupAvatar names={names} />);
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('redacted seeds override names with deterministic tiles', async () => {
    // Deterministic (same 31-hash the source uses): 'seed-A' -> '5A', 'seed-B' -> '4A'.
    await renderWithTheme(
      <GroupAvatar names={['Alice', 'Bob']} seeds={['seed-A', 'seed-B']} />,
    );
    expect(screen.getByText('5A')).toBeTruthy();
    expect(screen.getByText('4A')).toBeTruthy();
    expect(screen.queryByText('A')).toBeNull(); // real initials never leak
  });
});
