import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import React, { useCallback, useEffect, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, View } from 'react-native';
import { download } from '@/services/download';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import { Icon } from '../primitives';
import { useTheme } from '../theme';
import { ProgressRing } from './ProgressRing';
import { UploadProgressOverlay } from './UploadProgressOverlay';

interface VideoPlayerProps {
  att: AttachmentRow;
  isFromMe: boolean;
  showTail: boolean;
}

/**
 * In-bubble video: a first-frame poster (generated from the local file) with a play badge that
 * lazily mounts a native VideoView on first tap. Downloads-then-plays when no local file yet;
 * pauses on blur so a recycled/backgrounded row doesn't keep audio running.
 */
export function VideoPlayer({ att, isFromMe, showTail }: VideoPlayerProps): React.JSX.Element {
  const theme = useTheme();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const status = useDownloadStore((s) => s.status[att.guid]);
  const progress = useDownloadStore((s) => s.progress[att.guid]);
  // Present only while this file is being SENT. An entry exists for the duration of one upload
  // attempt and is removed when it settles, so its presence is the whole condition.
  const upload = useUploadStore((s) => s.byGuid[att.guid]);
  const [playing, setPlaying] = useState(false);
  const [thumb, setThumb] = useState<VideoThumbnail | null>(null);

  const player = useVideoPlayer(att.localPath ?? null, (p) => {
    p.loop = false;
  });

  // Pause when the screen loses focus (e.g. opening the fullscreen viewer over a
  // playing video). Guarded: on unmount expo-video may already have released the
  // player, and calling a method on a released shared object throws.
  useFocusEffect(
    useCallback(
      () => () => {
        try {
          player.pause();
        } catch {
          // player already released on unmount — expo-video handles that case.
        }
      },
      [player],
    ),
  );

  // Real poster: once the file is local, pull its first frame so the bubble shows the video's
  // content instead of a gray box. expo-video's native generator returns an image the <Image>
  // below renders directly (no new dependency). Guarded like player.pause() above — the player may
  // be released on a recycled FlashList row and the call throws on a released/not-yet-loaded asset;
  // cancel-on-unmount so a late resolve doesn't setState on a recycled row.
  useEffect(() => {
    if (!att.localPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const thumbs = await player.generateThumbnailsAsync([0], { maxWidth: 600 });
        if (!cancelled && thumbs[0]) setThumb(thumbs[0]);
      } catch {
        // player released, asset not ready, or codec unsupported — keep the gray poster + play badge.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [player, att.localPath]);

  const win = Dimensions.get('window');
  const maxW = win.width * 0.6;
  const aspect = att.width && att.height ? att.width / att.height : 0.78;
  const width = Math.max(120, Math.min(att.width ?? maxW, maxW));
  const height = Math.max(80, Math.min(width / aspect, win.height * 0.55));

  const tail = showTail ? theme.radius.tail : theme.radius.bubble;
  const corners = isFromMe ? { borderBottomRightRadius: tail } : { borderBottomLeftRadius: tail };
  const box = {
    width,
    height,
    alignSelf: (isFromMe ? 'flex-end' : 'flex-start') as 'flex-end' | 'flex-start',
    borderRadius: theme.radius.bubble,
    backgroundColor: theme.color.secondaryBackground,
    ...corners,
  };

  const onPress = (): void => {
    if (!att.localPath) {
      void download(att, 'manual', accountLease);
      return;
    }
    setPlaying(true);
    player.play();
  };

  if (playing && att.localPath) {
    return (
      <View style={[styles.wrap, box]}>
        <VideoView player={player} nativeControls contentFit="contain" style={styles.fill} />
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      // Without these the video bubble is a focusable, clickable node with NO name — TalkBack reads
      // it as an anonymous button (verified on device). The label tracks `status`/`localPath`
      // because the tap does three different things: download, retry, or play.
      accessibilityRole="button"
      accessibilityLabel={
        upload
          ? 'Video, uploading'
          : status === 'downloading'
            ? 'Video, downloading'
            : status === 'error'
              ? 'Video, download failed, tap to retry'
              : att.localPath
                ? 'Video, tap to play'
                : 'Video, not downloaded'
      }
      style={[styles.wrap, box]}
    >
      <Image
        source={thumb}
        placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
        contentFit="cover"
        style={styles.fill}
      />
      {/* Upload wins over every download state: a file we are SENDING came from this device, so
          it can never be downloading at the same time, and the play badge would be misleading. */}
      {upload ? (
        <UploadProgressOverlay sent={upload.sent} total={upload.total} />
      ) : status === 'downloading' ? (
        <View style={styles.overlay} pointerEvents="none">
          <ProgressRing progress={progress ?? null} />
        </View>
      ) : (
        <View style={styles.overlay} pointerEvents="none">
          <View
            style={[
              styles.play,
              { backgroundColor: status === 'error' ? theme.color.destructive : theme.color.tint },
            ]}
          >
            <Icon name={status === 'error' ? 'refresh-outline' : 'play'} size={20} color="#fff" />
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', marginVertical: 1, marginHorizontal: 10 },
  fill: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  play: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
