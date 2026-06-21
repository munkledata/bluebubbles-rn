import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useTheme } from '../theme';

function fmt(sec: number): string {
  const s = !isFinite(sec) || sec < 0 ? 0 : sec;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
}

/** In-bubble audio / voice-memo player: play/pause + a progress bar (download-gated). */
export function AudioAttachment({
  att,
  isFromMe,
}: {
  att: AttachmentRow;
  isFromMe: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const dl = useDownloadStore((s) => s.status[att.guid]);
  // Hook must run unconditionally; a null source leaves the player idle until downloaded.
  const player = useAudioPlayer(att.localPath ? { uri: att.localPath } : null);
  const status = useAudioPlayerStatus(player);
  const ready = !!att.localPath;
  const duration = status.duration || 0;
  const progress = duration > 0 ? Math.min(1, status.currentTime / duration) : 0;

  const onToggle = (): void => {
    if (!ready) {
      void download(att);
      return;
    }
    if (status.playing) {
      player.pause();
    } else {
      if (duration > 0 && status.currentTime >= duration - 0.05) void player.seekTo(0);
      player.play();
    }
  };

  const sub =
    dl === 'downloading'
      ? 'Downloading…'
      : ready
        ? `${fmt(status.currentTime)} / ${fmt(duration)}`
        : 'Voice message · tap to load';

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={status.playing ? 'Pause audio' : 'Play audio'}
      style={[
        styles.wrap,
        {
          backgroundColor: theme.color.secondaryBackground,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.play, { backgroundColor: theme.color.tint }]}>
        <Text style={styles.playIcon}>{!ready ? '⭳' : status.playing ? '❚❚' : '▶'}</Text>
      </View>
      <View style={styles.body}>
        <View style={[styles.track, { backgroundColor: theme.color.separator }]}>
          <View
            style={[
              styles.fill,
              { width: `${progress * 100}%`, backgroundColor: theme.color.tint },
            ]}
          />
        </View>
        <Text style={[styles.time, { color: theme.color.secondaryLabel }]}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '78%',
    minWidth: 200,
    marginVertical: 2,
    marginHorizontal: 10,
    padding: 10,
    borderRadius: 16,
    gap: 10,
  },
  play: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#fff', fontSize: 13, fontWeight: '800' },
  body: { flex: 1 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  time: { fontSize: 12, marginTop: 6 },
});
