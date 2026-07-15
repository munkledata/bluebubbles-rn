/**
 * ProgressRing (src/ui/attachments/ProgressRing.tsx): the SVG-free download indicator — a
 * translucent disc holding an ActivityIndicator, plus a rounded percentage label ONLY when the
 * total size is known. This suite locks in the progress→visual mapping:
 *   - progress === null (indeterminate: server sent no Content-Length) → spinner only, NO "%".
 *   - progress 0 / 0.5 / 1 → "0%" / "50%" / "100%" (Math.round(progress * 100)).
 *   - a fractional ratio rounds (0.567 → "57%").
 *   - the `size` prop drives the disc width/height/borderRadius (borderRadius === size/2).
 *   - the `color` prop tints the percentage label (and is passed to the spinner).
 *
 * Expected values are derived from the source (`pct = Math.round(progress * 100)`), never guessed.
 *
 * RNTL 14 here exposes no UNSAFE_/findByType queries — the render result's `root` is a
 * ReactTestInstance with `queryAll(predicate)`. ProgressRing's outer disc <View> IS `root`, so its
 * style comes from `root.props.style`; the spinner is found by host type 'ActivityIndicator'.
 */
import React from 'react';
import { StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { renderWithTheme, screen, type RenderResult } from '../support/renderWithTheme';
import { ProgressRing } from '@ui/attachments/ProgressRing';

const isSpinner = (n: { type: unknown }): boolean => n.type === 'ActivityIndicator';

/** `root` is typed nullable, but a rendered tree always has one — narrow it. */
function rootOf(r: RenderResult): NonNullable<RenderResult['root']> {
  if (!r.root) throw new Error('no rendered root');
  return r.root;
}

function discStyle(r: RenderResult): ViewStyle {
  return StyleSheet.flatten(rootOf(r).props.style) as ViewStyle;
}

function spinnerColor(r: RenderResult): string | undefined {
  const spinners = rootOf(r).queryAll(isSpinner);
  return spinners[0]?.props.color as string | undefined;
}

describe('ProgressRing — determinate percentage label', () => {
  it('renders a rounded whole-percent for a mid-progress ratio', async () => {
    await renderWithTheme(<ProgressRing progress={0.5} />);
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('renders "0%" at the very start (0 is a known total, not indeterminate)', async () => {
    await renderWithTheme(<ProgressRing progress={0} />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders "100%" when complete', async () => {
    await renderWithTheme(<ProgressRing progress={1} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('rounds a fractional ratio to the nearest whole percent (0.567 → 57%)', async () => {
    await renderWithTheme(<ProgressRing progress={0.567} />);
    expect(screen.getByText('57%')).toBeTruthy();
  });

  it('always shows a spinner alongside the percentage', async () => {
    const r = await renderWithTheme(<ProgressRing progress={0.42} />);
    expect(rootOf(r).queryAll(isSpinner)).toHaveLength(1);
    expect(screen.getByText('42%')).toBeTruthy();
  });
});

describe('ProgressRing — indeterminate (null) state', () => {
  it('shows the spinner but NO percentage label when progress is null', async () => {
    const r = await renderWithTheme(<ProgressRing progress={null} />);
    expect(rootOf(r).queryAll(isSpinner)).toHaveLength(1);
    expect(screen.queryByText(/%$/)).toBeNull();
  });
});

describe('ProgressRing — size + color props', () => {
  it('sizes the disc from the `size` prop (borderRadius === size / 2)', async () => {
    const r = await renderWithTheme(<ProgressRing progress={null} size={80} />);
    const style = discStyle(r);
    expect(style.width).toBe(80);
    expect(style.height).toBe(80);
    expect(style.borderRadius).toBe(40);
  });

  it('defaults the disc to 52px when no size is given', async () => {
    const r = await renderWithTheme(<ProgressRing progress={null} />);
    const style = discStyle(r);
    expect(style.width).toBe(52);
    expect(style.height).toBe(52);
    expect(style.borderRadius).toBe(26);
  });

  it('tints the percentage label AND the spinner with the `color` prop', async () => {
    const r = await renderWithTheme(<ProgressRing progress={0.25} color="#ff0000" />);
    const label = screen.getByText('25%');
    expect((StyleSheet.flatten(label.props.style) as TextStyle).color).toBe('#ff0000');
    expect(spinnerColor(r)).toBe('#ff0000');
  });

  it('defaults the spinner color to white', async () => {
    const r = await renderWithTheme(<ProgressRing progress={null} />);
    expect(spinnerColor(r)).toBe('#fff');
  });
});
