/**
 * placeReactionMenu (src/utils/reactionMenuLayout.ts): the pure geometry that positions the
 * iMessage-style floating tapback bar + action menu around a long-pressed bubble. Device layout is
 * verified on-device; this suite locks the decision logic (which side, above/below, scroll cap).
 */
import { placeReactionMenu, type ReactionMenuInput } from '@utils';

// A tall phone; a mid-thread received bubble with comfortable room above and below.
function baseInput(over: Partial<ReactionMenuInput> = {}): ReactionMenuInput {
  return {
    bubble: { x: 12, y: 400, width: 220, height: 60 },
    screen: { width: 390, height: 844 },
    insets: { top: 47, bottom: 34 },
    isFromMe: false,
    barHeight: 52,
    gap: 8,
    sideInset: 12,
    ...over,
  };
}

describe('placeReactionMenu — side alignment', () => {
  it('received bubble hugs the LEFT edge at the bubble’s left offset', () => {
    const p = placeReactionMenu(baseInput({ isFromMe: false }));
    expect(p.align).toBe('left');
    expect(p.edgeOffset).toBe(12); // bubble.x
  });

  it('own bubble hugs the RIGHT edge at its distance from the right screen edge', () => {
    // bubble right edge = x(150)+width(220)=370 → 20px from a 390-wide screen.
    const p = placeReactionMenu(
      baseInput({ isFromMe: true, bubble: { x: 150, y: 400, width: 220, height: 60 } }),
    );
    expect(p.align).toBe('right');
    expect(p.edgeOffset).toBe(20);
  });

  it('clamps the edge offset to at least the side inset', () => {
    // A bubble flush to the left edge (x=2) still keeps the side inset margin.
    const p = placeReactionMenu(baseInput({ bubble: { x: 2, y: 400, width: 220, height: 60 } }));
    expect(p.edgeOffset).toBe(12); // sideInset
  });
});

describe('placeReactionMenu — vertical placement (common case)', () => {
  it('puts the bar directly above the bubble and the menu below it', () => {
    const p = placeReactionMenu(baseInput());
    // bar top = bubbleTop(400) - gap(8) - barHeight(52) = 340
    expect(p.barTop).toBe(340);
    // menu below: top = bubbleBottom(460) + gap(8) = 468
    expect(p.menu).toEqual({ anchor: 'top', value: 468 });
    // maxHeight = screen(844) - bottomInset(34) - gap(8) - menuTop(468) = 334
    expect(p.menuMaxHeight).toBe(334);
  });
});

describe('placeReactionMenu — bubble near the TOP', () => {
  it('flips the bar BELOW the bubble when there is no room above it', () => {
    // bubble at the very top → bubbleTop - gap - barHeight < top inset.
    const p = placeReactionMenu(baseInput({ bubble: { x: 12, y: 50, width: 220, height: 60 } }));
    // bar below: top = bubbleBottom(110) + gap(8) = 118
    expect(p.barTop).toBe(118);
    // menu follows below the bar: top = barTop(118) + barHeight(52) + gap(8) = 178
    expect(p.menu).toEqual({ anchor: 'top', value: 178 });
  });
});

describe('placeReactionMenu — bubble near the BOTTOM', () => {
  it('stacks the menu ABOVE the bar (anchored from the bottom) when there is no room below', () => {
    // A bubble low on screen: little space beneath it for the menu.
    const p = placeReactionMenu(baseInput({ bubble: { x: 12, y: 720, width: 220, height: 60 } }));
    // Bar still fits above: barTop = 720 - 8 - 52 = 660.
    expect(p.barTop).toBe(660);
    // spaceBelow = 844 - 34 - 8 - (780+8) = 14 < 180 → menu flips above the bar.
    expect(p.menu.anchor).toBe('bottom');
    if (p.menu.anchor === 'bottom') {
      // menu bottom = screenH(844) - (barTop(660) - gap(8)) = 192
      expect(p.menu.value).toBe(192);
    }
    // maxHeight of the space above the bar = barTop(660) - gap(8) - topInset(47) - gap(8) = 597
    expect(p.menuMaxHeight).toBe(597);
  });
});

describe('placeReactionMenu — never returns a negative height', () => {
  it('clamps menuMaxHeight to 0 in a degenerate tiny screen', () => {
    const p = placeReactionMenu(
      baseInput({
        screen: { width: 390, height: 200 },
        bubble: { x: 12, y: 150, width: 200, height: 40 },
      }),
    );
    expect(p.menuMaxHeight).toBeGreaterThanOrEqual(0);
  });
});
