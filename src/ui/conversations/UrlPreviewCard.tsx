import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
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
  // Many OG images fail to load on device (hotlink/403 protection, dead/relative URLs). Without a
  // placeholder this left a persistent blank 140px box; track a load error so a failed image
  // collapses (to a text-only card, or nothing) instead of showing an empty box. Reset when the
  // image URL changes — MessageBubble is memoized inside a RECYCLING FlashList, so the same card
  // instance is reused across messages (also why the <Image> below needs a recyclingKey).
  const [imgFailed, setImgFailed] = useState(false);
  const imageUrl = preview?.imageUrl ?? null;
  useEffect(() => {
    setImgFailed(false);
  }, [imageUrl]);
  const showImage = !!imageUrl && !imgFailed;

  // Nothing useful to show (loading, negative cache, or an image-only card whose image failed to
  // load) → render nothing rather than a blank box.
  if (!preview || preview.error === 1 || (!preview.title && !showImage)) return null;

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
      {showImage && imageUrl ? (
        // RN's built-in Image (Fresco), NOT expo-image — deliberate. On-device (S25U/Android 16,
        // release build) expo-image mounts the view for a remote https source but never starts a
        // Glide load: no network request, no onError, just a permanent blank box (verified via
        // Glide verbose logging; local file:// attachments are unaffected, so expo-image stays
        // everywhere else). RN Image is what avatars use and provably renders on this device.
        // Keyed by the URL so a recycled row remounts and loads the NEW image instead of briefly
        // showing the previous message's.
        <Image
          testID="url-preview-image"
          key={imageUrl}
          source={{ uri: imageUrl }}
          onError={() => setImgFailed(true)}
          resizeMode="cover"
          fadeDuration={150}
          style={[styles.image, { backgroundColor: theme.color.separator }]}
        />
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
