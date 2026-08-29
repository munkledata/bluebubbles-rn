import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UrlPreviewRow } from '@db/repositories';
import { safeOpenUrl } from '@utils';
import { useTheme } from '../theme';

interface UrlPreviewCardProps {
  url: string;
  /** The already-fetched preview row (the parent bubble owns the hook so it runs once). */
  preview: UrlPreviewRow | null;
  isFromMe: boolean;
  /** Optional absolutely-positioned content (for example a tapback) anchored to this card. */
  overlay?: React.ReactNode;
}

/** A compact Open Graph link card under a message bubble; hidden until metadata loads. */
export function UrlPreviewCard({
  url,
  preview,
  isFromMe,
  overlay,
}: UrlPreviewCardProps): React.JSX.Element | null {
  const theme = useTheme();
  // NET-00: mounting a remote <Image> is itself an automatic in-app network request. Preserve
  // cached/server-supplied metadata, but never render preview artwork until NET-01 provides a
  // bounded fetch pipeline. An image-only server payload degrades to the external link's domain.
  if (!preview || preview.error === 1 || (!preview.title && !preview.imageUrl)) return null;

  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep raw */
  }

  const card = (
    <Pressable
      testID="url-preview-card"
      onPress={() => void safeOpenUrl(url)}
      style={[
        styles.card,
        overlay ? styles.anchoredCard : null,
        {
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
          backgroundColor: theme.color.secondaryBackground,
          borderColor: theme.color.separator,
        },
      ]}
    >
      <View style={styles.body}>
        <Text numberOfLines={2} style={[styles.title, { color: theme.color.label }]}>
          {preview.title ?? domain}
        </Text>
        {preview.description ? (
          <Text numberOfLines={2} style={[styles.desc, { color: theme.color.secondaryLabel }]}>
            {preview.description}
          </Text>
        ) : null}
        <Text style={[styles.domain, { color: theme.color.tertiaryLabel }]}>
          {preview.siteName ?? domain}
        </Text>
      </View>
    </Pressable>
  );

  if (!overlay) return card;
  return (
    <View
      style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}
      pointerEvents="box-none"
    >
      {card}
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'relative',
    width: '78%',
    marginHorizontal: 10,
    marginTop: 2,
  },
  card: {
    // Keep the existing iMessage-like constant card width while preview artwork is contained.
    width: '78%',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
    marginTop: 2,
  },
  anchoredCard: { width: '100%', marginHorizontal: 0, marginTop: 0 },
  body: { padding: 10, gap: 2 },
  title: { fontSize: 14, fontWeight: '600' },
  desc: { fontSize: 13, lineHeight: 17 },
  domain: { fontSize: 11, marginTop: 2 },
});
