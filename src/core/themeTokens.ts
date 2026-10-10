import { z } from 'zod';
import { HEX_COLOR_PATTERN } from './color';

const hexColor = z.string().regex(HEX_COLOR_PATTERN);
const size = z.number().nonnegative();

/**
 * The complete shape of a stored theme-token set: a custom theme, a per-chat theme, or one restored
 * from a backup. Rendering reads every field and runs the contrast helpers on the colours, so a
 * stored blob is only usable when the whole set is present and every colour is `#RGB` / `#RRGGBB`.
 * `ThemeTokens` in src/ui/theme/tokens.ts must stay assignable from this (typecheck enforces it).
 */
const ThemeTokensSchema = z.object({
  mode: z.enum(['light', 'dark']),
  color: z.object({
    background: hexColor,
    secondaryBackground: hexColor,
    groupedBackground: hexColor,
    label: hexColor,
    secondaryLabel: hexColor,
    tertiaryLabel: hexColor,
    separator: hexColor,
    tint: hexColor,
    destructive: hexColor,
    bubble: z.object({
      senderBackground: hexColor,
      senderText: hexColor,
      receivedBackgroundTop: hexColor,
      receivedBackgroundBottom: hexColor,
      receivedText: hexColor,
      smsBackground: hexColor,
      rcsBackground: hexColor,
    }),
  }),
  spacing: z.object({ xs: size, sm: size, md: size, lg: size, xl: size }),
  radius: z.object({ bubble: size, tail: size, card: size, pill: size }),
  font: z.object({
    family: z.string(),
    size: z.object({ caption: size, footnote: size, body: size, headline: size, title: size }),
  }),
});

export type ValidThemeTokens = z.infer<typeof ThemeTokensSchema>;

/**
 * Parse a stored theme-token JSON blob. Returns null for empty or corrupt JSON and for anything
 * that is not a complete, renderable token set (a hand-edited backup, another tool's file), so
 * callers fall back to a known theme instead of crashing on every render. A valid blob is returned
 * exactly as parsed, so any extra keys it carries are preserved.
 */
export function parseThemeTokensJson(json: string | null | undefined): ValidThemeTokens | null {
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return ThemeTokensSchema.safeParse(value).success ? (value as ValidThemeTokens) : null;
}
