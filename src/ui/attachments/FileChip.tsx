import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import { openAttachmentFile } from '@/services/openFile';
import {
  fileTypeLabel,
  formatPercent,
  formatTransferred,
  friendlySize,
  transferRatio,
} from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';
import { showToast } from '../toast/toastStore';

interface FileChipProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

/** Generic (non-image) attachment chip: icon + filename + "TYPE • size", with download state. */
export function FileChip({ att, isFromMe }: FileChipProps): React.JSX.Element {
  const theme = useTheme();
  const [accountLease] = React.useState(() => captureRealtimeDeliveryLease());
  const status = useDownloadStore((s) => s.status[att.guid]);
  // Present only while this file is being SENT — the entry is removed once the attempt settles.
  const upload = useUploadStore((s) => s.byGuid[att.guid]);
  const label = fileTypeLabel(att.mimeType, att.transferName);
  const baseSub = att.totalBytes ? `${label} • ${friendlySize(att.totalBytes)}` : label;
  // A chip has a subtitle line already, so the upload readout goes there rather than as an overlay:
  // "4.2 MB of 12.1 MB • 35%", dropping the percentage until the total is known (see transferRatio).
  const uploadPercent = upload ? formatPercent(transferRatio(upload.sent, upload.total)) : null;
  const uploadSub = upload
    ? `${formatTransferred(upload.sent, upload.total)}${uploadPercent ? ` • ${uploadPercent}` : ''}`
    : null;
  // Upload wins: a file we are SENDING came from this device and can never be downloading too.
  const sub =
    uploadSub ??
    (status === 'downloading' ? 'Downloading…' : status === 'error' ? 'Tap to retry' : baseSub);

  // In-flight guard: opening is async and a double-tap would fire two intents.
  const opening = React.useRef(false);

  const onPress = (): void => {
    if (!accountLease.isCurrent()) return;
    const path = att.localPath;
    if (!path) {
      void download(att, 'manual', accountLease);
      return;
    }
    if (opening.current) return;
    opening.current = true;
    void (async () => {
      try {
        const res = await openAttachmentFile(path, att.mimeType, {
          isCurrent: accountLease.isCurrent,
        });
        if (!accountLease.isCurrent()) return;
        // The result MUST be consumed here — a discarded one is exactly how "tapping the PDF
        // does nothing" shipped. NOTE there is deliberately no toast for 'shared': the share
        // sheet is a system window that appears immediately and IS the feedback, and AppToast
        // is pointerEvents:'none' behind it, so a toast would be invisible and then gone.
        if (res.status === 'missing') void download(att, 'manual', accountLease);
        else if (res.status === 'no_handler')
          showToast(`No app on this device can open ${label} files`);
        else if (res.status === 'error') showToast('Couldn’t open this file');
      } finally {
        opening.current = false;
      }
    })();
  };

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: theme.color.secondaryBackground,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: theme.color.tint }]}>
        {upload || status === 'downloading' ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : status === 'error' ? (
          <Icon name="refresh-outline" size={20} color="#fff" />
        ) : (
          <Text style={styles.iconText}>{label.slice(0, 3)}</Text>
        )}
      </View>
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
          {att.transferName ?? 'File'}
        </Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '78%',
    marginVertical: 2,
    marginHorizontal: 10,
    padding: 10,
    borderRadius: 14,
    gap: 10,
  },
  icon: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  meta: { flexShrink: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
});
