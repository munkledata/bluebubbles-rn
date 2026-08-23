import React from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AttachmentRow, ChatMediaByKind } from '@db/repositories';
import { isLocalFileUri, safeOpenUrl } from '@utils';
import { useTheme } from '../theme';
import { useAttachmentCachePathProtection } from '../attachments/useAttachmentCachePathProtection';

/** A single attachment thumbnail in the shared-media strip (image preview or kind glyph). */
function MediaThumb({
  att,
  kind,
  glyph,
  onPress,
}: {
  att: AttachmentRow;
  kind: 'photo' | 'video';
  glyph: string;
  onPress?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  // expo-image can't decode a video file, so a video renders ONLY its blurhash poster (no file
  // source) or the ▶ glyph fallback; feeding the video uri to <Image source> would show a blank
  // tile.
  const wantsImage = kind === 'photo' && !!att.localPath;
  const videoPoster = kind === 'video' && !!att.blurhash;
  const hasManagedPath = isLocalFileUri(att.localPath);
  // A video tile renders only its blurhash, but its local path must survive the tap→viewer
  // navigation handoff. The details route stays mounted underneath until the viewer cell acquires
  // its own reader pin. A remote/dev image needs no cache protection and passes through directly.
  const protectedPath = useAttachmentCachePathProtection(hasManagedPath ? att.localPath : null);
  const protectionRefused = hasManagedPath && !protectedPath;
  const imagePath = wantsImage ? (hasManagedPath ? protectedPath : att.localPath) : null;
  const showImage = !!imagePath;
  const safeOnPress = protectionRefused ? undefined : onPress;
  return (
    <Pressable
      onPress={safeOnPress}
      disabled={!safeOnPress}
      // `secondaryBackground`, NOT `groupedBackground`: in 3 of the 5 presets (OLED Dark, Nord,
      // and the default Gator) groupedBackground is byte-identical to `background`, so the tile
      // vanished into the page and a poster-less video rendered as a bare ▶ floating on nothing.
      // Seen on device in Shared Media: "Photos · 60" showed real thumbnails while "Videos · 12"
      // showed five naked play arrows. secondaryBackground is distinct from background in EVERY
      // preset, so the fallback (and an undownloaded photo) always reads as a tile.
      style={[styles.thumb, { backgroundColor: theme.color.secondaryBackground }]}
      accessibilityRole="image"
    >
      {showImage ? (
        <Image
          source={{ uri: imagePath }}
          placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
          contentFit="cover"
          style={styles.thumbImg}
        />
      ) : videoPoster ? (
        // Poster-only: blurhash as the image (NO video source) with a play glyph overlay.
        <>
          <Image
            placeholder={{ blurhash: att.blurhash! }}
            contentFit="cover"
            style={styles.thumbImg}
          />
          <Text style={[styles.thumbGlyph, styles.thumbGlyphOverlay]}>▶</Text>
        </>
      ) : (
        // Themed, NOT the default Text colour: unstyled Text is near-black on Android, so on every
        // dark preset the fallback ▶ / 🖼 was a black glyph on a dark tile (seen on device once the
        // tile itself became visible). Its sibling `thumbGlyphOverlay` already hardcodes white for
        // the poster case; this branch has no image behind it, so it follows the theme instead.
        <Text style={[styles.thumbGlyph, { color: theme.color.secondaryLabel }]}>{glyph}</Text>
      )}
    </Pressable>
  );
}

/**
 * Conversation-details shared media (Phase 2.1): horizontal thumbnail strips for
 * Photos + Videos (tap → media viewer), and count rows for Documents + Links
 * (links open via the safe URL opener). Renders nothing when the chat has no media.
 */
export function MediaSections({
  media,
  onOpenMedia,
  onOpenLink = safeOpenUrl,
}: {
  media: ChatMediaByKind | null | undefined;
  onOpenMedia: (attachmentGuid: string) => void;
  onOpenLink?: (url: string) => unknown;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (!media) return null;
  const { photos, videos, documents, links } = media;
  if (!photos.length && !videos.length && !documents.length && !links.length) return null;

  const labelStyle = [styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }];
  const rowValueStyle = [styles.rowValue, { color: theme.color.tertiaryLabel }];

  return (
    <>
      <Text style={labelStyle}>SHARED MEDIA</Text>
      {photos.length > 0 ? (
        <>
          <Text style={[styles.mediaStripLabel, { color: theme.color.tertiaryLabel }]}>
            Photos · {photos.length}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
            {photos.map((a) => (
              <MediaThumb
                key={a.guid}
                att={a}
                kind="photo"
                glyph="🖼"
                onPress={() => onOpenMedia(a.guid)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
      {videos.length > 0 ? (
        <>
          <Text style={[styles.mediaStripLabel, { color: theme.color.tertiaryLabel }]}>
            Videos · {videos.length}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
            {videos.map((a) => (
              <MediaThumb
                key={a.guid}
                att={a}
                kind="video"
                glyph="▶"
                onPress={() => onOpenMedia(a.guid)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
      {documents.length > 0 || links.length > 0 ? (
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          {documents.length > 0 ? (
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.color.label }]}>Documents</Text>
              <Text style={rowValueStyle}>{documents.length}</Text>
            </View>
          ) : null}
          {links.length > 0 ? (
            <View>
              <View
                style={[
                  styles.row,
                  documents.length > 0 && {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>Links</Text>
                <Text style={rowValueStyle}>{links.length}</Text>
              </View>
              {links.slice(0, 5).map((l) => (
                <Pressable
                  key={l.messageGuid}
                  onPress={() => void onOpenLink(l.url)}
                  style={[
                    styles.row,
                    {
                      borderTopColor: theme.color.separator,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.linkText, { color: theme.color.tint }]}>
                    {l.url}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 13, marginBottom: 6, marginLeft: 12 },
  group: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15 },
  mediaStripLabel: { fontSize: 13, marginLeft: 12, marginBottom: 6, marginTop: 4 },
  strip: { marginBottom: 8 },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    marginRight: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: { width: '100%', height: '100%' },
  thumbGlyph: { fontSize: 26 },
  // Play glyph drawn over a video's blurhash poster (the strip tile is centered).
  thumbGlyphOverlay: {
    position: 'absolute',
    color: '#FFFFFF',
    textShadowColor: '#000000',
    textShadowRadius: 3,
  },
  linkText: { fontSize: 15, flex: 1 },
});
