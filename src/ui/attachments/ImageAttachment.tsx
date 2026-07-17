import { Image } from 'expo-image';
import * as Network from 'expo-network';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { shouldAutoDownload } from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';
import { ProgressRing } from './ProgressRing';

interface ImageAttachmentProps {
  att: AttachmentRow;
  isFromMe: boolean;
  showTail: boolean;
  /** Render as a fixed square grid cell (gallery grid) instead of a self-sized bubble image —
   *  the parent grid owns spacing + corner rounding; download/tap behavior is unchanged. */
  cellSize?: number;
}

/** In-bubble image with an expo-image blurhash placeholder + download progress/retry. */
export function ImageAttachment({
  att,
  isFromMe,
  showTail,
  cellSize,
}: ImageAttachmentProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const progress = useDownloadStore((s) => s.progress[att.guid]);
  const autoDownload = useFeatureSettingsStore((s) => s.autoDownloadAttachments);
  const wifiOnly = useFeatureSettingsStore((s) => s.autoDownloadOnWifiOnly);
  const netType = Network.useNetworkState().type;

  useEffect(() => {
    // Honor the auto-download setting + the WiFi-only restriction (tapping still downloads on
    // demand regardless — this only gates the automatic background fetch).
    if (!autoDownload) return;
    if (wifiOnly && netType !== Network.NetworkStateType.WIFI) return;
    // Only auto-fetch when we haven't tried this attachment yet this session. A prior failure
    // ('error') is left for the user to retry by tapping the retry icon — otherwise a
    // permanently-failing image (e.g. some RCS/MMS media the server 404s) would re-download on
    // EVERY reactive flush and hog the 2 concurrency slots, stalling images that WOULD load.
    if (status !== undefined) return;
    if (shouldAutoDownload(att)) void download(att);
    // Keyed on guid/localPath/status — NOT the whole `att`, which useMessages rebuilds as a fresh
    // object on every reactive flush (that identity churn is what caused the re-download storm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.guid, att.localPath, autoDownload, wifiOnly, netType, status]);

  // Genmoji (macOS 15.1+ AI-generated emoji) render INLINE at ~big-emoji size (mirrors the bubble's
  // bigEmoji precedent) — a small transparent square, never a full-width file box. Detected purely
  // from the presence of the server's `emojiImageContentIdentifier`; ordinary images are unchanged.
  const isGenmoji = !!att.emojiImageContentIdentifier;
  const genmojiSize = theme.font.size.body * 3;

  const win = Dimensions.get('window');
  const maxW = win.width * 0.6;
  const aspect = att.width && att.height ? att.width / att.height : 0.78;
  const width = isGenmoji ? genmojiSize : (cellSize ?? Math.max(120, Math.min(att.width ?? maxW, maxW)));
  const height = isGenmoji
    ? genmojiSize
    : (cellSize ?? Math.max(80, Math.min(width / aspect, win.height * 0.55)));

  const tail = showTail ? theme.radius.tail : theme.radius.bubble;
  // Grid-cell mode: the parent grid owns margins, alignment, and corner rounding — so DON'T emit a
  // tail corner. A per-corner radius overrides the `borderRadius: 0` shorthand on the native side
  // regardless of merge order, so leaving `corners` in would keep one rounded corner per cell,
  // notching the grid at the joins.
  const corners =
    isGenmoji || cellSize
      ? null
      : isFromMe
        ? { borderBottomRightRadius: tail }
        : { borderBottomLeftRadius: tail };
  const cellOverrides = cellSize
    ? { marginVertical: 0, marginHorizontal: 0, borderRadius: 0 }
    : null;
  // A Genmoji is a transparent inline emoji — drop the file-box tint and rounded bubble corner.
  const genmojiOverrides = isGenmoji ? { backgroundColor: 'transparent', borderRadius: 0 } : null;

  const onPress = (): void => {
    if (att.localPath) router.push(`/media/${encodeURIComponent(att.guid)}`);
    else void download(att);
  };

  return (
    <Pressable
      onPress={onPress}
      // Genmoji carry a natural-language description ("a smiling cat wearing a top hat") — surface it
      // as the accessibility label (alt text). Ordinary images have none set, so this stays
      // undefined for them (unchanged behavior).
      accessibilityLabel={att.emojiImageShortDescription ?? undefined}
      style={[
        styles.wrap,
        {
          width,
          height,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
          borderRadius: theme.radius.bubble,
          backgroundColor: theme.color.secondaryBackground,
          ...corners,
        },
        cellOverrides,
        genmojiOverrides,
      ]}
    >
      <Image
        source={att.localPath ? { uri: att.localPath } : null}
        placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
        contentFit={isGenmoji ? 'contain' : 'cover'}
        transition={150}
        style={styles.img}
      />
      {status === 'downloading' ? (
        <View style={styles.overlay} pointerEvents="none">
          <ProgressRing progress={progress ?? null} />
        </View>
      ) : status === 'error' ? (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.retry}>
            <Icon name="refresh-outline" size={24} color="#fff" />
          </View>
        </View>
      ) : null}
      {att.hasLivePhoto ? (
        <View style={styles.liveBadge} pointerEvents="none">
          <Text style={styles.liveText}>◉ LIVE</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', marginVertical: 1, marginHorizontal: 10 },
  img: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retry: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
