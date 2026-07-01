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
}

/** In-bubble image with an expo-image blurhash placeholder + download progress/retry. */
export function ImageAttachment({
  att,
  isFromMe,
  showTail,
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
    if (shouldAutoDownload(att)) void download(att);
  }, [att, autoDownload, wifiOnly, netType]);

  const win = Dimensions.get('window');
  const maxW = win.width * 0.6;
  const aspect = att.width && att.height ? att.width / att.height : 0.78;
  const width = Math.max(120, Math.min(att.width ?? maxW, maxW));
  const height = Math.max(80, Math.min(width / aspect, win.height * 0.55));

  const tail = showTail ? theme.radius.tail : theme.radius.bubble;
  const corners = isFromMe ? { borderBottomRightRadius: tail } : { borderBottomLeftRadius: tail };

  const onPress = (): void => {
    if (att.localPath) router.push(`/media/${encodeURIComponent(att.guid)}`);
    else void download(att);
  };

  return (
    <Pressable
      onPress={onPress}
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
      ]}
    >
      <Image
        source={att.localPath ? { uri: att.localPath } : null}
        placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
        contentFit="cover"
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
