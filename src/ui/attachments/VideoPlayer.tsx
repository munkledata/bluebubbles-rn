import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useTheme } from '../theme';
import { ProgressRing } from './ProgressRing';

interface VideoPlayerProps {
  att: AttachmentRow;
  isFromMe: boolean;
  showTail: boolean;
}

/**
 * In-bubble video: a blurhash poster with a play badge that lazily mounts a
 * native VideoView on first tap. Downloads-then-plays when no local file yet;
 * pauses on blur so a recycled/backgrounded row doesn't keep audio running.
 */
export function VideoPlayer({ att, isFromMe, showTail }: VideoPlayerProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const progress = useDownloadStore((s) => s.progress[att.guid]);
  const [playing, setPlaying] = useState(false);

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
      void download(att);
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
    <Pressable onPress={onPress} style={[styles.wrap, box]}>
      <Image
        source={null}
        placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
        contentFit="cover"
        style={styles.fill}
      />
      {status === 'downloading' ? (
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
            <Text style={styles.playIcon}>{status === 'error' ? '↻' : '▶'}</Text>
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
  playIcon: { color: '#fff', fontSize: 18, marginLeft: 3 },
});
