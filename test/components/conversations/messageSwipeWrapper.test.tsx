/**
 * MessageSwipeWrapper (src/ui/conversations/MessageSwipeWrapper.tsx): structure + gesture-config only
 * — jest can't drive native touches, so the gesture MATH is covered in test/utils/swipeGesture.test.ts
 * and the FEEL is on-device territory. Locked here: children render, the row's timestamp label is in
 * the tree (revealed by opacity, so it must exist), the reply glyph appears only with onReply, and the
 * PanResponder is HARDENED so the FlashList scroll can't steal the swipe (the S25-Ultra ~50%-drop fix).
 */
import React from 'react';
import {
  PanResponder,
  Text,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
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

  // Config-level regression guard for the S25-Ultra bug: the swipe and the FlashList vertical scroll
  // race for the same finger-drag, and on Samsung One UI the scroll won ~50% of the time. jest can't
  // drive the drag, but it CAN assert the PanResponder is configured to hold the gesture once claimed.
  // If any of these guards is dropped, the flaky-swipe bug silently returns — so pin them here.
  it('hardens the PanResponder so the list scroll cannot steal the swipe', async () => {
    const evt = {} as GestureResponderEvent;
    const gesture = (dx: number, dy: number): PanResponderGestureState =>
      ({ dx, dy }) as unknown as PanResponderGestureState;
    const createSpy = jest.spyOn(PanResponder, 'create');

    await renderWithTheme(
      <MessageSwipeWrapper timestamp="3:14 PM" onReply={jest.fn()}>
        <Text>x</Text>
      </MessageSwipeWrapper>,
    );

    const cfg = createSpy.mock.calls[0]?.[0];
    expect(cfg).toBeDefined();
    // The key fix: once we own the drag, refuse to surrender it back to the scroll (default is true).
    expect(cfg?.onPanResponderTerminationRequest?.(evt, gesture(40, 0))).toBe(false);
    // Android: block the native scroll once the JS gesture is granted.
    expect(cfg?.onShouldBlockNativeResponder?.(evt, gesture(40, 0))).toBe(true);
    // Claim a mostly-horizontal drag in BOTH the bubble and capture phases…
    expect(cfg?.onMoveShouldSetPanResponder?.(evt, gesture(40, 5))).toBe(true);
    expect(cfg?.onMoveShouldSetPanResponderCapture?.(evt, gesture(40, 5))).toBe(true);
    // …but let a vertical scroll fall through, and never claim on touch-start (taps/long-press pass).
    expect(cfg?.onMoveShouldSetPanResponder?.(evt, gesture(5, 60))).toBe(false);
    expect(cfg?.onStartShouldSetPanResponder?.(evt, gesture(0, 0))).toBe(false);

    createSpy.mockRestore();
  });
});
