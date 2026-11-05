/**
 * GroupAvatar (src/ui/primitives/GroupAvatar.tsx): two overlapped Avatars for a group chat —
 * back = names[0], front = names[1], each with only its OWN photo. Fewer than two names draw one
 * full-size Avatar. Callers feed it the already-collapsed participant list (see
 * dedupeParticipantDetails in src/utils/chat.ts, which collapses one person reachable via
 * multiple handles); GroupAvatar itself just draws the first two entries it's given.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { GroupAvatar } from '@ui/primitives/GroupAvatar';
import { darkTheme } from '@ui/theme/tokens';

// Ionicons' async font-load setState trips overlapping-act; render its name synchronously.
jest.mock('@expo/vector-icons', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Ionicons: ({ name }: { name: string }) => R.createElement(Text, null, name) };
});

describe('GroupAvatar', () => {
  it('draws the first two participants (back + front)', async () => {
    const view = await renderWithTheme(<GroupAvatar names={['Alice', 'Bob', 'Carol']} />);
    expect(screen.getByText('A')).toBeTruthy(); // Alice → back
    expect(screen.getByText('B')).toBeTruthy(); // Bob → front
    expect(screen.queryByText('C')).toBeNull(); // Carol is not drawn

    await view.rerender(
      <GroupAvatar
        names={['Alice', 'Bob', 'Carol']}
        uris={['file:///alice.jpg', 'file:///bob.jpg', 'file:///carol.jpg']}
        size={72}
      />,
    );
    const images = view.root!.queryAll((node) => node.type === 'Image');
    expect(images).toHaveLength(2);
    expect(StyleSheet.flatten(view.root!.props.style)).toMatchObject({ width: 72, height: 72 });
    expect(images.map((image) => image.props.source)).toEqual([
      { uri: 'file:///alice.jpg' },
      { uri: 'file:///bob.jpg' },
    ]);
    for (const image of images) {
      expect(StyleSheet.flatten(image.props.style)).toMatchObject({
        width: 48,
        height: 48,
        borderRadius: 24,
      });
    }
    expect(StyleSheet.flatten(images[0]!.parent!.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
    });
    expect(StyleSheet.flatten(images[1]!.parent!.props.style)).toMatchObject({
      position: 'absolute',
      bottom: 0,
      right: 0,
      borderWidth: 2,
      borderRadius: 26,
      borderColor: darkTheme.color.background,
    });
  });

  it("shows the group's own photo, full size, instead of the member pictures", async () => {
    const view = await renderWithTheme(
      <GroupAvatar
        names={['Alice', 'Bob']}
        uris={['file:///alice.jpg', 'file:///bob.jpg']}
        photoUri="file:///doc/group-photos/generation-1/media-x.jpg"
        size={64}
      />,
    );
    // The photo is the whole avatar, so it is the rendered root itself.
    const photo = view.root!;
    expect(photo.type).toBe('Image');
    expect(photo.props.source).toEqual({
      uri: 'file:///doc/group-photos/generation-1/media-x.jpg',
    });
    expect(StyleSheet.flatten(photo.props.style)).toMatchObject({ width: 64, height: 64 });
    expect(photo.queryAll((node) => node.type === 'Image')).toHaveLength(0);

    // No photo (null): back to the two member pictures.
    await view.rerender(
      <GroupAvatar
        names={['Alice', 'Bob']}
        uris={['file:///alice.jpg', 'file:///bob.jpg']}
        photoUri={null}
      />,
    );
    expect(view.root!.queryAll((node) => node.type === 'Image')).toHaveLength(2);
  });

  it('draws ONE full-size avatar when only one participant is given', async () => {
    const view = await renderWithTheme(<GroupAvatar names={['Solo']} size={64} />);
    expect(screen.getAllByText('S')).toHaveLength(1); // never the same person twice

    await view.rerender(<GroupAvatar names={['Solo']} uris={['file:///solo.jpg']} size={64} />);
    const photo = view.root!;
    expect(photo.type).toBe('Image');
    expect(photo.props.source).toEqual({ uri: 'file:///solo.jpg' });
    expect(StyleSheet.flatten(photo.props.style)).toMatchObject({ width: 64, height: 64 });
  });

  it("never borrows the first member's photo for a second member without one", async () => {
    const view = await renderWithTheme(
      <GroupAvatar names={['Alice', 'Bob']} uris={['file:///alice.jpg', null]} />,
    );
    expect(
      view.root!.queryAll((node) => node.type === 'Image').map((image) => image.props.source),
    ).toEqual([{ uri: 'file:///alice.jpg' }]);
    expect(screen.getByText('B')).toBeTruthy(); // Bob shows his own initials
  });

  it('falls back to one person-glyph avatar with an empty participant list', async () => {
    await renderWithTheme(<GroupAvatar names={[]} />);
    expect(screen.getAllByText('person')).toHaveLength(1);
  });
});
