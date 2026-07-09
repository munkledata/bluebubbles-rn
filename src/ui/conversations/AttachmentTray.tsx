import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
// SDK 56's root expo-media-library is the class-based API (async getters, MediaType.VIDEO); the
// /legacy entry keeps the imperative getAssetsAsync + plain-property Assets we use here.
import * as MediaLibrary from 'expo-media-library/legacy';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';
import { Icon } from '../primitives';
import { useTheme } from '../theme';

/** A photo/video/file the composer has staged but not yet sent (shape sendImages accepts). */
export interface PendingAttachment {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

export const ATTACHMENT_TRAY_HEIGHT = 104;
const THUMB = 84;

/** Best-effort MIME from a filename extension (MediaLibrary doesn't hand back a mimeType). */
function mimeFromName(name: string, isVideo: boolean): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    heic: 'image/heic',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
  };
  return map[ext] ?? (isVideo ? 'video/mp4' : 'image/jpeg');
}

interface AttachmentTrayProps {
  /** Stage a selected device photo/video onto the composer's pending list. */
  onPick: (item: PendingAttachment) => void;
  /** Open the document picker for non-media files (PDFs, etc.). */
  onPickFiles: () => void;
}

/**
 * Inline attachment tray — a horizontal strip of the device's recent photos/videos plus a
 * "Files" button. Replaces the old Alert→system-picker popup: tapping a thumbnail stages it as
 * a pending preview in the composer (no modal). Requests media-library permission on first open
 * and degrades to a short prompt if denied.
 */
export function AttachmentTray({ onPick, onPickFiles }: AttachmentTrayProps): React.JSX.Element {
  const theme = useTheme();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [perm, setPerm] = useState<'loading' | 'granted' | 'denied'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await MediaLibrary.requestPermissionsAsync();
        if (cancelled) return;
        if (!p.granted && p.accessPrivileges !== 'limited') {
          setPerm('denied');
          return;
        }
        const res = await MediaLibrary.getAssetsAsync({
          first: 40,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        if (!cancelled) {
          setAssets(res.assets);
          setPerm('granted');
        }
      } catch (e) {
        if (!cancelled) {
          logger.warn('[attachment-tray] could not load media library', e);
          setPerm('denied');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Capture a fresh photo with the system camera and stage it (parity with the old composer's
  // camera button). CAMERA is already declared by the expo-camera plugin, so no rebuild is needed.
  const capture = async (): Promise<void> => {
    try {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      const isVideo = a.type === 'video';
      onPick({
        uri: a.uri,
        name: a.fileName ?? `capture.${isVideo ? 'mp4' : 'jpg'}`,
        mimeType: a.mimeType ?? mimeFromName(a.fileName ?? (isVideo ? '.mp4' : '.jpg'), isVideo),
        size: a.fileSize ?? 0,
        width: a.width,
        height: a.height,
      });
    } catch (e) {
      logger.warn('[attachment-tray] camera capture failed', e);
    }
  };

  const pick = async (asset: MediaLibrary.Asset): Promise<void> => {
    const isVideo = asset.mediaType === MediaLibrary.MediaType.video;
    // getAssetInfoAsync resolves a readable file:// localUri (the raw asset uri can be a
    // non-readable content/ph reference). It can THROW under Android scoped storage / limited
    // photo access — if it does, fall back to the asset's own uri so the pick STILL stages
    // instead of silently vanishing (which reads to the user as "tapping does nothing").
    let uri = asset.uri;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      if (info.localUri) uri = info.localUri;
    } catch (e) {
      logger.warn('[attachment-tray] getAssetInfoAsync failed; staging raw asset uri', e);
    }
    onPick({
      uri,
      name: asset.filename,
      mimeType: mimeFromName(asset.filename, isVideo),
      size: 0,
      width: asset.width,
      height: asset.height,
    });
  };

  return (
    <View style={[styles.wrap, { borderTopColor: theme.color.separator }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={() => void capture()}
          style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
          accessibilityRole="button"
          accessibilityLabel="Take a photo"
        >
          <Icon name="camera-outline" size={26} color={theme.color.tint} />
          <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Camera</Text>
        </Pressable>

        <Pressable
          onPress={onPickFiles}
          style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
          accessibilityRole="button"
          accessibilityLabel="Attach a file"
        >
          <Icon name="document-outline" size={26} color={theme.color.tint} />
          <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Files</Text>
        </Pressable>

        {perm === 'denied' ? (
          <View style={styles.msg}>
            <Text style={[styles.msgText, { color: theme.color.secondaryLabel }]}>
              Allow photo access in Settings to attach from your library.
            </Text>
          </View>
        ) : (
          assets.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => void pick(a)}
              style={styles.thumbWrap}
              accessibilityRole="button"
              accessibilityLabel={a.mediaType === MediaLibrary.MediaType.video ? 'Attach video' : 'Attach photo'}
            >
              <Image source={{ uri: a.uri }} style={styles.thumb} contentFit="cover" />
              {a.mediaType === MediaLibrary.MediaType.video ? (
                <View style={styles.videoBadge}>
                  <Icon name="videocam" size={12} color="#fff" />
                </View>
              ) : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: ATTACHMENT_TRAY_HEIGHT, borderTopWidth: StyleSheet.hairlineWidth },
  row: { alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  files: {
    width: THUMB,
    height: THUMB,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  filesText: { fontSize: 12, fontWeight: '600' },
  thumbWrap: { width: THUMB, height: THUMB, borderRadius: 10, overflow: 'hidden' },
  thumb: { width: THUMB, height: THUMB },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    padding: 2,
  },
  msg: { height: THUMB, justifyContent: 'center', paddingHorizontal: 12, maxWidth: 240 },
  msgText: { fontSize: 13 },
});
