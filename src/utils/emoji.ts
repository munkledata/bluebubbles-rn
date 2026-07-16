/**
 * "Big emoji" detection (ported from the Flutter `MessageHelper.shouldShowBigEmoji`): iMessage
 * renders a message whose text is ONLY emoji (a small count) at a large size with no bubble.
 * Pure/testable; Hermes supports `\p{…}` Unicode property escapes (already used elsewhere).
 */

// Emoji + their modifiers/joiners: pictographs, variation selector, skin tones, ZWJ, and
// regional-indicator symbols (flags). Removing these should leave nothing for an emoji-only text.
const EMOJI_AND_MODIFIERS =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}]/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}/gu;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/gu;

/** Max emoji for the enlarged, bubble-less treatment (matches iMessage's small-count rule). */
const MAX_BIG_EMOJI = 3;

/** True when `text` is only emoji (1–3 of them) → render enlarged with no bubble. */
export function isBigEmoji(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, '');
  if (!t) return false;
  // Anything left after stripping emoji + modifiers means it's not emoji-only.
  if (t.replace(EMOJI_AND_MODIFIERS, '').length > 0) return false;
  // Approximate the visible emoji count: base pictographs + flag pairs (2 regional indicators).
  const pictographs = (t.match(PICTOGRAPH) ?? []).length;
  const flags = Math.floor((t.match(REGIONAL_INDICATOR) ?? []).length / 2);
  const count = pictographs + flags;
  return count >= 1 && count <= MAX_BIG_EMOJI;
}
