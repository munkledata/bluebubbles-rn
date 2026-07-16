/**
 * Avatar (src/ui/primitives/Avatar.tsx): a circular contact tile — photo when available, else
 * initials on a deterministic colour, or a seeded non-identifying tile in redacted mode. The
 * initials + redacted-label rules are derived directly from the source's `initials()` and
 * `seededRedacted()` (redacted values precomputed with the same hash the source uses).
 * AGENTS.md requires avatars be `accessible={false}` (a labelled avatar double-announces under
 * TalkBack next to the tile/header that already names the person).
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { Avatar } from '@ui/primitives/Avatar';

describe('Avatar initials', () => {
  it('uses the first letter for a single-word name, uppercased', async () => {
    await renderWithTheme(<Avatar name="cher" />);
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('combines first + last initials for a multi-word name', async () => {
    await renderWithTheme(<Avatar name="alice bob" />);
    expect(screen.getByText('AB')).toBeTruthy();
  });

  it('falls back to "?" for an empty / whitespace-only name', async () => {
    await renderWithTheme(<Avatar name="   " />);
    expect(screen.getByText('?')).toBeTruthy();
  });
});

describe('Avatar rendering modes', () => {
  it('renders a photo (no initials) when a uri is provided', async () => {
    await renderWithTheme(<Avatar name="Alice Bob" uri="file:///photo.jpg" />);
    // The image path is taken, so the initials are never rendered.
    expect(screen.queryByText('AB')).toBeNull();
  });

  it('redacted seed overrides name/photo with a deterministic 2-char tile', async () => {
    // seededRedacted('secret-seed') => label 'UE' (same 31-hash the source uses).
    await renderWithTheme(<Avatar name="Alice Bob" uri="file:///photo.jpg" seed="secret-seed" />);
    expect(screen.getByText('UE')).toBeTruthy();
    expect(screen.queryByText('AB')).toBeNull(); // real initials never leak
  });

  it('is decorative — accessible={false} on the tile', async () => {
    await renderWithTheme(<Avatar name="Alice Bob" />);
    const tile = screen.getByText('AB').parent!;
    expect(tile.props.accessible).toBe(false);
  });
});
