/**
 * EdgeFade (src/ui/conversations/EdgeFade.tsx): the transcript edge veil for wallpaper chats — a
 * theme-tinted CSS gradient (RN 0.85 experimental_backgroundImage) that dissolves messages into
 * the floating header/composer zones instead of hard-clipping.
 *
 * The gradient-stop math is unit-tested in test/ui/edgeFadeStops (node project); here we assert the
 * COMPONENT wires it through correctly:
 *   - passes edgeFadeStops(color, holdFraction) into a linear-gradient background;
 *   - holdFraction = holdHeight / height (and 0 when height is 0);
 *   - top edge fades "to bottom", bottom edge fades "to top";
 *   - passes the height through and never intercepts touches (pointerEvents="none").
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, type RenderResult } from '../support/renderWithTheme';
import { EdgeFade } from '@ui/conversations/EdgeFade';
import { edgeFadeStops } from '@ui/conversations/edgeFadeStops';

/** The veil View EdgeFade renders IS the rendered root. */
function veilStyle(r: RenderResult): Record<string, unknown> {
  if (!r.root) throw new Error('no rendered root');
  // Never intercepts touches — the message list underneath must stay scrollable.
  expect(r.root.props.pointerEvents).toBe('none');
  return StyleSheet.flatten(r.root.props.style) as Record<string, unknown>;
}

describe('EdgeFade', () => {
  it('renders the top veil with a "to bottom" gradient of the expected stops', async () => {
    const color = '#0B1A2B';
    const r = await renderWithTheme(
      <EdgeFade edge="top" height={100} holdHeight={40} color={color} />,
    );

    const style = veilStyle(r);
    expect(style.height).toBe(100);

    const bg = style.experimental_backgroundImage as Array<{
      type: string;
      direction: string;
      colorStops: unknown;
    }>;
    expect(bg).toHaveLength(1);
    expect(bg[0]!.type).toBe('linear-gradient');
    expect(bg[0]!.direction).toBe('to bottom');
    // Passes the pure stop helper through with holdFraction = 40/100 = 0.4 (not recomputed here).
    expect(bg[0]!.colorStops).toEqual(edgeFadeStops(color, 0.4));
  });

  it('renders the bottom veil fading "to top"', async () => {
    const r = await renderWithTheme(
      <EdgeFade edge="bottom" height={80} holdHeight={20} color="#FFFFFF" />,
    );

    const style = veilStyle(r);
    const bg = style.experimental_backgroundImage as Array<{
      direction: string;
      colorStops: unknown;
    }>;
    expect(bg[0]!.direction).toBe('to top');
    expect(bg[0]!.colorStops).toEqual(edgeFadeStops('#FFFFFF', 20 / 80));
  });

  it('guards a zero height (holdFraction → 0)', async () => {
    const r = await renderWithTheme(
      <EdgeFade edge="top" height={0} holdHeight={40} color="#000000" />,
    );

    const style = veilStyle(r);
    expect(style.height).toBe(0);
    const bg = style.experimental_backgroundImage as Array<{ colorStops: unknown }>;
    expect(bg[0]!.colorStops).toEqual(edgeFadeStops('#000000', 0));
  });
});
