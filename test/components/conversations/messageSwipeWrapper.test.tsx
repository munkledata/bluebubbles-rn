/**
 * MessageSwipeWrapper (src/ui/conversations/MessageSwipeWrapper.tsx): structure only — jest can't
 * drive native touches, so the gesture math is covered in test/utils/swipeGesture.test.ts and the
 * feel is on-device territory. Locked here: children render, the row's timestamp label is in the
 * tree (revealed by opacity, so it must exist), and the reply glyph appears only with onReply.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { MessageSwipeWrapper } from '@ui/conversations/MessageSwipeWrapper';

// Render icon glyphs synchronously (no deferred font-load setState → no act noise).
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

describe('MessageSwipeWrapper', () => {
  it('renders its children and the reveal-timestamp label', async () => {
    await renderWithTheme(
      <MessageSwipeWrapper timestamp="3:14 PM">
        <Text>bubble content</Text>
      </MessageSwipeWrapper>,
    );
    expect(screen.getByText('bubble content')).toBeTruthy();
    expect(screen.getByText('3:14 PM')).toBeTruthy();
  });

  it('shows the reply glyph only when onReply is provided', async () => {
    const { rerender } = await renderWithTheme(
      <MessageSwipeWrapper timestamp="3:14 PM">
        <Text>x</Text>
      </MessageSwipeWrapper>,
    );
    expect(screen.queryByText('arrow-undo')).toBeNull();
    rerender(
      <MessageSwipeWrapper timestamp="3:14 PM" onReply={jest.fn()}>
        <Text>x</Text>
      </MessageSwipeWrapper>,
    );
    expect(await screen.findByText('arrow-undo')).toBeTruthy();
  });
});
