import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatTransferred, transferRatio } from '@utils';
import { ProgressRing } from './ProgressRing';

interface UploadProgressOverlayProps {
  sent: number;
  /** 0 until the native uploader reports the content length → ring falls back to a spinner. */
  total: number;
  /** Drop the byte readout when there is no room for it (a gallery cell, an inline Genmoji). */
  compact?: boolean;
}

/**
 * Overlay for an attachment that is currently UPLOADING — the outgoing twin of the download ring.
 *
 * It reuses `ProgressRing` (same spinner + percentage) and adds the byte readout, which the
 * download side has no use for: a download's size is already printed on its chip, whereas for an
 * outgoing file "how big is this and how much has gone" is the whole question being asked.
 *
 * `pointerEvents="none"` for the same reason as the download overlay — the bubble underneath stays
 * tappable (an uploading photo can still be opened in the viewer).
 */
export function UploadProgressOverlay({
  sent,
  total,
  compact,
}: UploadProgressOverlayProps): React.JSX.Element {
  return (
    <View style={styles.overlay} pointerEvents="none">
      <ProgressRing progress={transferRatio(sent, total)} />
      {compact ? null : (
        // Literal colours, not theme tokens: this sits on top of the user's photo, whose colours
        // owe nothing to the app theme — the same reasoning as the download retry disc and the
        // LIVE badge next to it.
        <Text style={styles.bytes} numberOfLines={1}>
          {formatTransferred(sent, total)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bytes: {
    marginTop: 6,
    maxWidth: '90%',
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
