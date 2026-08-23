/**
 * Avatar (src/ui/primitives/Avatar.tsx): a circular contact tile — photo when available, else
 * name-derived initials on a deterministic colour.
 * AGENTS.md requires avatars be `accessible={false}` (a labelled avatar double-announces under
 * TalkBack next to the tile/header that already names the person).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { Avatar } from '@ui/primitives/Avatar';

describe('Avatar initials', () => {
  it('uses the first letter for a single-word name, uppercased', async () => {
    await renderWithTheme(
      <>
        <Avatar name="cher" />
        <Avatar name="cher" />
      </>,
    );
    const initials = screen.getAllByText('C');
    expect(initials).toHaveLength(2);
    expect(StyleSheet.flatten(initials[0]!.parent!.props.style).backgroundColor).toBe(
      StyleSheet.flatten(initials[1]!.parent!.props.style).backgroundColor,
    );
  });

  it('combines first + last initials for a multi-word name', async () => {
    await renderWithTheme(<Avatar name="alice middle bob" />);
    expect(screen.getByText('AB')).toBeTruthy();
  });

  it('falls back to "?" for an empty / whitespace-only name', async () => {
    await renderWithTheme(<Avatar name="   " />);
    expect(screen.getByText('?')).toBeTruthy();
  });
});

describe('Avatar rendering', () => {
  it('renders a photo (no initials) when a uri is provided', async () => {
    const view = await renderWithTheme(<Avatar name="Alice Bob" uri="file:///photo.jpg" />);
    const images = view.root!.queryAll((node) => node.type === 'Image', { includeSelf: true });
    expect(images).toHaveLength(1);
    const image = images[0]!;
    expect(image.props.source).toEqual({ uri: 'file:///photo.jpg' });
    expect(image.props.accessible).toBe(false);
    expect(screen.queryByText('AB')).toBeNull();
  });

  it('honors an explicit color and remains decorative', async () => {
    await renderWithTheme(<Avatar name="Alice Bob" color="#123456" size={50} />);
    const tile = screen.getByText('AB').parent!;
    expect(tile.props.accessible).toBe(false);
    expect(StyleSheet.flatten(tile.props.style)).toMatchObject({
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: '#123456',
    });
  });
});
