import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import {
  Dimensions,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  getAttachmentByGuid,
  listChatImageAttachmentsByAttachmentGuid,
  type AttachmentRow,
} from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { ZoomableImage } from '@ui/attachments/ZoomableImage';
import { isLocalFileUri } from '@utils';

/**
 * Fullscreen media viewer. Images open in a swipe-carousel across EVERY photo in the chat (with an
 * "N of M" counter), each pinch-to-zoomable; a video opens singly with native controls. Share +
 * save-to-Photos act on the currently-visible item.
 */
export default function MediaViewer(): React.JSX.Element {
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const win = Dimensions.get('window');

  const [att, setAtt] = useState<AttachmentRow | null>(null);
  // The image carousel (siblings in the chat) + the index of the tapped photo. Null while loading
  // or when the tapped attachment is a video (which opens singly).
  const [gallery, setGallery] = useState<{ items: AttachmentRow[]; index: number } | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pagingEnabled, setPagingEnabled] = useState(true);

  const isVideo = (att?.mimeType ?? '').startsWith('video');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = getDatabase();
      const a = await getAttachmentByGuid(db, guid);
      if (!alive) return;
      setAtt(a);
      if (a && !(a.mimeType ?? '').startsWith('video')) {
        const g = await listChatImageAttachmentsByAttachmentGuid(db, guid);
        if (!alive) return;
        // Fall back to a one-item gallery if the tapped image isn't in the set (shouldn't happen).
        const items = g.items.length > 0 ? g.items : [a];
        const index = g.index >= 0 ? g.index : 0;
        setGallery({ items, index });
        setPageIndex(index);
      }
    })();
    return () => {
      alive = false;
    };
  }, [guid]);

  // The item the action bar (share/save) + counter refer to = the visible page (else the tapped att).
  const current = gallery?.items[pageIndex] ?? att;
  const local = isLocalFileUri(current?.localPath);

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / win.width);
      setPageIndex(i);
    },
    [win.width],
  );

  const onShare = async (): Promise<void> => {
    if (!current?.localPath || !local) return;
    await shareAttachment(current.localPath, current.mimeType);
  };

  const onSave = async (): Promise<void> => {
    if (!current?.localPath || !local) return;
    await saveAttachmentsToPhotos([current.localPath]);
  };

  return (
    <View style={styles.root}>
      {att && isVideo ? (
        att.localPath ? (
          <FullscreenVideo uri={att.localPath} />
        ) : null
      ) : gallery ? (
        <FlatList
          data={gallery.items}
          keyExtractor={(a) => a.guid}
          horizontal
          pagingEnabled
          scrollEnabled={pagingEnabled}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={gallery.index}
          getItemLayout={(_d, i) => ({ length: win.width, offset: win.width * i, index: i })}
          onMomentumScrollEnd={onScrollEnd}
          renderItem={({ item, index }) => (
            <ZoomableImage
              uri={isLocalFileUri(item.localPath) ? item.localPath : null}
              blurhash={item.blurhash}
              width={win.width}
              height={win.height}
              active={index === pageIndex}
              // Zoomed → disable paging so a one-finger drag pans the photo instead of changing it.
              onZoomChange={(zoomed) => setPagingEnabled(!zoomed)}
            />
          )}
        />
      ) : null}

      <View style={[styles.bar, { top: insets.top + 6 }]} pointerEvents="box-none">
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.pill}>
          <Text style={styles.glyph}>✕</Text>
        </Pressable>
        {/* "N of M" while paging through more than one photo. */}
        {gallery && gallery.items.length > 1 ? (
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>
              {pageIndex + 1} of {gallery.items.length}
            </Text>
          </View>
        ) : null}
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
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counter: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: { color: '#fff', fontSize: 14, fontWeight: '600' },
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
