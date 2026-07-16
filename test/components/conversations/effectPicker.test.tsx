/**
 * EffectPicker (src/ui/conversations/effects/EffectPicker.tsx): the long-press-send sheet that
 * lets you send the typed message with an iMessage send-effect. Plain Modal + Pressable chips,
 * one chip per EFFECT_OPTIONS entry (src/core/effects/effectsMapper.ts).
 *
 * Behaviours locked in:
 *   - every effect option (its exact label) renders, split under BUBBLE / SCREEN sections;
 *   - tapping a chip calls onPick with THAT effect id and then onClose (send-with-effect);
 *   - "Send without effect" calls onPick(undefined) + onClose;
 *   - tapping the backdrop calls onClose only (cancel — no pick).
 */
import React from 'react';
import { EFFECT_OPTIONS } from '@core/effects';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { EffectPicker } from '@ui/conversations/effects/EffectPicker';

describe('EffectPicker', () => {
  it('renders a chip for every effect option with its label', async () => {
    await renderWithTheme(<EffectPicker visible onClose={jest.fn()} onPick={jest.fn()} />);

    expect(screen.getByText('Send with effect')).toBeTruthy();
    expect(screen.getByText('BUBBLE')).toBeTruthy();
    expect(screen.getByText('SCREEN')).toBeTruthy();
    expect(screen.getByText('Send without effect')).toBeTruthy();

    // One chip per option — labels are the source of truth from effectsMapper.
    for (const opt of EFFECT_OPTIONS) {
      expect(screen.getByText(opt.label)).toBeTruthy();
    }
    expect(EFFECT_OPTIONS).toHaveLength(12);
  });

  it('picking a chip fires onPick with its id and then closes', async () => {
    const onPick = jest.fn();
    const onClose = jest.fn();
    await renderWithTheme(<EffectPicker visible onClose={onClose} onPick={onPick} />);

    fireEvent.press(screen.getByText('Slam'));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));

    // 'Slam' → the exact expressiveSendStyleId from effectsMapper.
    expect(onPick).toHaveBeenCalledWith('com.apple.MobileSMS.expressivesend.impact');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picking a SCREEN chip passes its id (screen effect)', async () => {
    const onPick = jest.fn();
    await renderWithTheme(<EffectPicker visible onClose={jest.fn()} onPick={onPick} />);

    fireEvent.press(screen.getByText('Confetti'));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick).toHaveBeenCalledWith('com.apple.messages.effect.CKConfettiEffect');
  });

  it('"Send without effect" fires onPick(undefined) and closes', async () => {
    const onPick = jest.fn();
    const onClose = jest.fn();
    await renderWithTheme(<EffectPicker visible onClose={onClose} onPick={onPick} />);

    fireEvent.press(screen.getByText('Send without effect'));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick).toHaveBeenCalledWith(undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tapping outside the chips (the backdrop) cancels — onClose only, no pick', async () => {
    const onPick = jest.fn();
    const onClose = jest.fn();
    await renderWithTheme(<EffectPicker visible onClose={onClose} onPick={onPick} />);

    // The title sits inside the sheet but under no chip Pressable, so a press bubbles up to the
    // backdrop Pressable (onPress = onClose) — the dismiss-on-outside-tap path.
    fireEvent.press(screen.getByText('Send with effect'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onPick).not.toHaveBeenCalled();
  });
});
