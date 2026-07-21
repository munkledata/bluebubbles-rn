import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';
import type { UrlPreviewRow } from '@db/repositories';
import { safeOpenUrl } from '@utils';
import { useTheme } from '../theme';

// Some CDNs gate image requests on a browser-looking UA (same reason the OG fetch uses one).
const IMG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

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
    // TEMP diagnostics: pairs with the <Image> lifecycle logs below — if this fires but
    // loadStart never does, the native pipeline never even began the request.
    if (imageUrl) logger.warn('[preview] card has image', { uri: imageUrl });
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
        // RN's built-in Image (Fresco). The load-bearing part is fadeDuration={0} below — with
        // ANY fade (expo-image `transition` or Fresco's default 300ms), a network image decodes
        // but never becomes visible on-device (see the fadeDuration comment). Keyed by the URL
        // so a recycled row remounts and loads the NEW image instead of briefly showing the
        // previous message's.
        <Image
          testID="url-preview-image"
          key={imageUrl}
          source={{ uri: imageUrl, headers: { 'User-Agent': IMG_UA } }}
          onLoad={() => logger.warn('[preview] img loaded', { uri: imageUrl })}
          onError={(e) => {
            logger.warn('[preview] img ERROR', {
              uri: imageUrl,
              error: e.nativeEvent?.error != null ? String(e.nativeEvent.error) : 'unknown',
            });
            setImgFailed(true);
          }}
          resizeMode="cover"
          // NO fade-in — THE root cause of the years-of-blank-preview-images bug (S25U,
          // RN 0.86 Fabric): the network-image fade animation never runs, so the image
          // DECODES (onLoad fires) but stays at 0 alpha forever. Applies identically to
          // expo-image's `transition` and RN Image's `fadeDuration` (default 300 — must be
          // EXPLICITLY 0). Local images skip Fresco's fade, which is why avatars/attachments
          // always rendered. Confirmed on-device via the [preview] lifecycle logs: "loaded"
          // fired while the box stayed blank at 150ms fade; 0 renders instantly.
          fadeDuration={0}
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
