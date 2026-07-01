import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { getAttachmentByGuid, type AttachmentRow } from '@db/repositories';

/** A downloaded local file can be shared/saved; a remote dev URL cannot. */
function isLocalFile(path: string | null | undefined): boolean {
  return !!path && path.startsWith('file://');
}

/** Fullscreen image viewer (pinch-zoom via ScrollView) with share + save-to-Photos. */
export default function MediaViewer(): React.JSX.Element {
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [att, setAtt] = useState<AttachmentRow | null>(null);
  const win = Dimensions.get('window');
  const local = isLocalFile(att?.localPath);
  const isVideo = (att?.mimeType ?? '').startsWith('video');

  useEffect(() => {
    void getAttachmentByGuid(getDatabase(), guid).then(setAtt);
  }, [guid]);

  const onShare = async (): Promise<void> => {
    if (!att?.localPath || !local) return;
    try {
      if (!(await Sharing.isAvailableAsync())) return;
      await Sharing.shareAsync(att.localPath, { mimeType: att.mimeType ?? undefined });
    } catch (e) {
      logger.warn('share failed', e);
    }
  };

  const onSave = async (): Promise<void> => {
    if (!att?.localPath || !local) return;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (perm.status !== 'granted') return;
      await MediaLibrary.saveToLibraryAsync(att.localPath);
    } catch (e) {
      logger.warn('save failed', e);
    }
  };

  return (
    <View style={styles.root}>
      {att?.localPath && isVideo ? (
        <FullscreenVideo uri={att.localPath} />
      ) : (
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          contentContainerStyle={styles.center}
        >
          {att?.localPath ? (
            <Image
              source={{ uri: att.localPath }}
              placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
              contentFit="contain"
              style={{ width: win.width, height: win.height }}
            />
          ) : null}
        </ScrollView>
      )}

      <View style={[styles.bar, { top: insets.top + 6 }]} pointerEvents="box-none">
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.pill}>
          <Text style={styles.glyph}>✕</Text>
        </Pressable>
        <View style={styles.actions} pointerEvents="box-none">
          <Pressable
            onPress={() => void onShare()}
            disabled={!local}
            hitSlop={12}
            style={[styles.pill, !local && styles.disabled]}
          >
            <Text style={styles.glyph}>⤴</Text>
          </Pressable>
          <Pressable
            onPress={() => void onSave()}
            disabled={!local}
            hitSlop={12}
            style={[styles.pill, !local && styles.disabled]}
          >
            <Text style={styles.glyph}>⤓</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Fullscreen native video with controls; autoplays on mount. useVideoPlayer auto-releases
 *  on unmount, so no manual cleanup is needed (this screen owns the player for its lifetime). */
function FullscreenVideo({ uri }: { uri: string }): React.JSX.Element {
  const win = Dimensions.get('window');
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: win.width, height: win.height }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actions: { flexDirection: 'row', gap: 10 },
  pill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.35 },
  glyph: { color: '#fff', fontSize: 20, fontWeight: '600' },
});
