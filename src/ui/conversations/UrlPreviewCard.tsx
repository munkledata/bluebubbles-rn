import { Image } from 'expo-image';
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
}

/** A compact Open Graph link card under a message bubble; hidden until metadata loads. */
export function UrlPreviewCard({
  url,
  preview,
  isFromMe,
}: UrlPreviewCardProps): React.JSX.Element | null {
  const theme = useTheme();

  // Nothing useful yet (loading or negative cache) → render nothing.
  if (!preview || preview.error === 1 || (!preview.title && !preview.imageUrl)) return null;

  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep raw */
  }

  return (
    <Pressable
      onPress={() => void safeOpenUrl(url)}
      style={[
        styles.card,
        {
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
          backgroundColor: theme.color.secondaryBackground,
          borderColor: theme.color.separator,
        },
      ]}
    >
      {preview.imageUrl ? (
        <Image source={{ uri: preview.imageUrl }} contentFit="cover" style={styles.image} />
      ) : null}
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
}

const styles = StyleSheet.create({
  card: {
    maxWidth: '78%',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
    marginTop: 2,
  },
  image: { width: '100%', height: 140 },
  body: { padding: 10, gap: 2 },
  title: { fontSize: 14, fontWeight: '600' },
  desc: { fontSize: 13, lineHeight: 17 },
  domain: { fontSize: 11, marginTop: 2 },
});
