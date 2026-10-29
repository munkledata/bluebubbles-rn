/**
 * Pure geometry for the iMessage-style contextual reaction/action menu (React-free, node-tested).
 *
 * On a long-press we measure the pressed bubble's on-screen rectangle and float two pieces around
 * it: a horizontal tapback BAR (hugging the bubble's near top corner) and a vertical action MENU
 * card. This module decides WHERE those two go given the bubble rect, the screen size, the safe-area
 * insets, and which side the bubble is on — handling the awkward edges (bubble near the top → bar
 * flips below; bubble near the bottom → menu stacks above the bar; a bubble so tall that the menu
 * fits neither above nor below → the menu covers the bubble, just under the bar; long menu → it
 * scrolls within the space that's actually available).
 *
 * The component (`MessageActionsOverlay`) feeds a measured `BubbleRect` through `placeReactionMenu`
 * and applies the returned absolute coordinates. Keeping the math here (not in the component) makes
 * the fiddly clamping unit-testable without a device.
 */

/** A rectangle in window coordinates (what `View.measureInWindow` yields). */
export interface BubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReactionMenuInput {
  /** The pressed bubble's rectangle in window coordinates. */
  bubble: BubbleRect;
  /** The full window size the overlay covers. */
  screen: { width: number; height: number };
  /** Safe-area insets (status bar / gesture bar) to keep the floating pieces clear of. */
  insets: { top: number; bottom: number };
  /** Own (sent) bubbles sit on the right, so the menu hugs the right edge; received hug the left. */
  isFromMe: boolean;
  /** Measured/estimated height of the floating tapback bar. */
  barHeight: number;
  /** Gap between the bubble and each floating piece (and from the screen edges). */
  gap: number;
  /** Minimum horizontal margin the floating pieces keep from the screen's left/right edges. */
  sideInset: number;
  /**
   * The action menu's full height once measured. When it doesn't fit beside the bubble, the menu
   * covers the bubble instead of hiding its last rows. Omitted before the first measurement.
   */
  menuHeight?: number;
}

export type MenuAnchor =
  | { anchor: 'top'; value: number } // distance of the menu's TOP from the window top
  | { anchor: 'bottom'; value: number }; // distance of the menu's BOTTOM from the window bottom

export interface ReactionMenuPlacement {
  /** Which screen edge the bar + menu hug (matches the bubble's side). */
  align: 'left' | 'right';
  /** Distance from the aligned edge (`left` or `right`) for both the bar and the menu. */
  edgeOffset: number;
  /** The tapback bar's TOP, in window coordinates. */
  barTop: number;
  /** Where to pin the action menu (anchored from the top or the bottom). */
  menu: MenuAnchor;
  /** Cap on the menu's height for the space it landed in — it scrolls internally past this. */
  menuMaxHeight: number;
}

/** Below this much free space, a "menu below the bubble" is judged too cramped and flips above. */
const MENU_MIN_HEIGHT = 180;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * Compute absolute positions for the floating tapback bar and action menu around a pressed bubble.
 * All returned coordinates are relative to the full-window overlay.
 */
export function placeReactionMenu(input: ReactionMenuInput): ReactionMenuPlacement {
  const { bubble, screen, insets, isFromMe, barHeight, gap, sideInset } = input;
  const bubbleTop = bubble.y;
  const bubbleBottom = bubble.y + bubble.height;

  // Horizontal: hug the bubble's NEAR edge (right for own, left for received), then clamp so the
  // pieces never run off the opposite side. edgeOffset is a distance from the aligned edge.
  const align: 'left' | 'right' = isFromMe ? 'right' : 'left';
  const rawOffset = isFromMe ? screen.width - (bubble.x + bubble.width) : bubble.x;
  const edgeOffset = clamp(rawOffset, sideInset, screen.width - sideInset);

  // Vertical: the bar sits directly ABOVE the bubble when it fits under the top inset; otherwise it
  // drops just below the bubble (a bubble pinned to the very top of the thread).
  const barAbove = bubbleTop - gap - barHeight >= insets.top + gap;
  const barTop = barAbove ? bubbleTop - gap - barHeight : bubbleBottom + gap;

  let menu: MenuAnchor;
  let menuMaxHeight: number;

  if (barAbove) {
    // Preferred layout: menu directly BELOW the bubble.
    const menuTop = bubbleBottom + gap;
    const spaceBelow = screen.height - insets.bottom - gap - menuTop;
    const menuBottom = screen.height - (barTop - gap);
    const spaceAbove = barTop - gap - insets.top - gap;
    const below: MenuAnchor = { anchor: 'top', value: menuTop };
    const above: MenuAnchor = { anchor: 'bottom', value: menuBottom };
    const { menuHeight } = input;
    if (menuHeight == null) {
      // Not measured yet: below unless that's too cramped, then stack ABOVE the bar.
      [menu, menuMaxHeight] =
        spaceBelow >= MENU_MIN_HEIGHT ? [below, spaceBelow] : [above, spaceAbove];
    } else if (menuHeight <= spaceBelow) {
      [menu, menuMaxHeight] = [below, spaceBelow];
    } else if (menuHeight <= spaceAbove) {
      [menu, menuMaxHeight] = [above, spaceAbove];
    } else {
      // Fits on neither side (a very tall bubble such as a portrait video): cover the bubble, just
      // under the bar, so no row is hidden out of sight in the menu's scroll area. This space
      // contains the space below, so it is never smaller.
      const coverTop = barTop + barHeight + gap;
      const coverSpace = screen.height - insets.bottom - gap - coverTop;
      [menu, menuMaxHeight] =
        coverSpace >= spaceAbove
          ? [{ anchor: 'top', value: coverTop }, coverSpace]
          : [above, spaceAbove];
    }
  } else {
    // Bar had to go below the bubble (bubble near the top) — the menu follows below the bar.
    const menuTop = barTop + barHeight + gap;
    menu = { anchor: 'top', value: menuTop };
    menuMaxHeight = screen.height - insets.bottom - gap - menuTop;
  }

  return { align, edgeOffset, barTop, menu, menuMaxHeight: Math.max(0, menuMaxHeight) };
}
