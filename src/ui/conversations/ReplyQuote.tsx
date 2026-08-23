import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { MessagePreview } from '@db/repositories';
import { useTheme } from '../theme';
import { overlayPillStyle, overlayTextStyle } from './overlayText';

interface ReplyQuoteProps {
  preview: MessagePreview;
  isFromMe: boolean;
  /** Tap to jump to the original message (set when the original is in the list). */
  onPress?: () => void;
  /** A chat wallpaper is set → back the quote with a frosted pill + primary-label text so it stays
   *  legible over the image, matching every other non-bubble label. */
  hasBackground?: boolean;
}

/** A dimmed preview of the original message, shown above a reply bubble. Tappable. */
export function ReplyQuote({
  preview,
  isFromMe,
  onPress,
  hasBackground,
}: ReplyQuoteProps): React.JSX.Element {
  const theme = useTheme();
  // Over a wallpaper, back the quote with the same frosted pill + primary-label text the other
  // non-bubble labels use (overlayText) — the muted colours below wash out on a busy photo.
  const pill = overlayPillStyle(hasBackground, theme.color.background);
  const whoColor = overlayTextStyle(
    hasBackground,
    theme.color.secondaryLabel,
    theme.color.label,
  ).color;
  const textColor = overlayTextStyle(
    hasBackground,
    theme.color.tertiaryLabel,
    theme.color.label,
  ).color;
  const who = preview.isFromMe === 1 ? 'You' : (preview.senderName ?? 'Unknown');
  const text =
    (preview.text ?? '') ||
    (preview.hasAttachments === 1 ? preview.attachmentDescription?.trim() || '📎 Attachment' : '');

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.wrap,
        { alignSelf: isFromMe ? 'flex-end' : 'flex-start', borderLeftColor: theme.color.tint },
        pill,
        hasBackground ? styles.wrapOnBackground : null,
      ]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `Reply to ${who}. Tap to jump to the original.` : undefined}
    >
      <Text numberOfLines={1} style={[styles.who, { color: whoColor }]}>
        {who}
      </Text>
      <Text numberOfLines={2} style={[styles.text, { color: textColor }]}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    maxWidth: '70%',
    borderLeftWidth: 2,
    paddingLeft: 8,
    marginHorizontal: 14,
    marginBottom: 3,
    opacity: 0.95,
  },
  // On a wallpaper the frosted pill carries legibility, so drop the slight dim that muted the
  // quote against a solid theme background.
  wrapOnBackground: { opacity: 1 },
  who: { fontSize: 11, fontWeight: '600' },
  text: { fontSize: 13, lineHeight: 17 },
});
