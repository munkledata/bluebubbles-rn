import React from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import type { AttachmentRow } from '@db/repositories';
import { isLocalFileUri } from '@utils';
import { useTheme } from '../theme';
import { ImageAttachment } from './ImageAttachment';
import { useAttachmentCachePathProtection } from './useAttachmentCachePathProtection';

const GAP = 3;
const COLS = 2;

interface AttachmentGalleryGridProps {
  /** Image attachments of ONE message (the bubble routes here for image-only sets of ≥2). */
  atts: AttachmentRow[];
  isFromMe: boolean;
}

/**
 * iMessage-style multi-photo grid: a message with several images collapses into one two-column
 * grid bubble instead of a tall stack. Cells reuse `ImageAttachment` (in `cellSize` mode), so
 * blurhash placeholders, auto/tap download, progress/retry overlays, and tap-to-open (into the
 * fullscreen carousel) all behave exactly like a single image.
 */
export function AttachmentGalleryGrid({
  atts,
  isFromMe,
}: AttachmentGalleryGridProps): React.JSX.Element {
  const theme = useTheme();
  const total = Math.min(Dimensions.get('window').width * 0.6, 300);
  const cell = (total - GAP * (COLS - 1)) / COLS;
  return (
    <View
      style={[
        styles.grid,
        {
          width: total,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
          borderRadius: theme.radius.bubble,
        },
      ]}
    >
      {atts.map((att) => (
        <ProtectedGalleryCell key={att.guid} att={att} isFromMe={isFromMe} cellSize={cell} />
      ))}
    </View>
  );
}

/** Each simultaneously mounted grid cell owns its own reader pin. */
function ProtectedGalleryCell({
  att,
  isFromMe,
  cellSize,
}: {
  att: AttachmentRow;
  isFromMe: boolean;
  cellSize: number;
}): React.JSX.Element {
  const protectedPath = useAttachmentCachePathProtection(att.localPath);
  if (isLocalFileUri(att.localPath) && protectedPath !== att.localPath) {
    // Preserve the two-column geometry without mounting ImageAttachment's decoder or its
    // "undownloaded" auto-fetch effect against a path currently owned by retirement.
    return <View style={{ width: cellSize, height: cellSize }} />;
  }
  return <ImageAttachment att={att} isFromMe={isFromMe} showTail={false} cellSize={cellSize} />;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
    overflow: 'hidden',
    marginVertical: 1,
    marginHorizontal: 10,
  },
});
