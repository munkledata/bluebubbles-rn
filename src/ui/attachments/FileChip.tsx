import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow, ChatDocumentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import { openAttachmentFile } from '@/services/openFile';
import {
  fileTypeLabel,
  formatPercent,
  formatTransferred,
  friendlySize,
  isLocalFileUri,
  transferRatio,
} from '@utils';
import { Icon } from '../primitives';
import { readableTextOn, useTheme } from '../theme';
import { showToast } from '../toast/toastStore';
import { useAttachmentCachePathProtection } from './useAttachmentCachePathProtection';

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
  const fileName = att.transferName ?? 'file';
  const transferBusy = Boolean(upload) || status === 'downloading';
  const accessibilityAction = upload
    ? 'Uploading'
    : status === 'downloading'
      ? 'Downloading'
      : status === 'error'
        ? 'Retry'
        : att.localPath
          ? 'Open'
          : 'Download';

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
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityAction} ${fileName}`}
      accessibilityHint="Downloads the document or opens it in another app"
      accessibilityState={{ busy: transferBusy }}
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
          <ActivityIndicator color={readableTextOn(theme.color.tint)} size="small" />
        ) : status === 'error' ? (
          <Icon name="refresh-outline" size={20} color={readableTextOn(theme.color.tint)} />
        ) : (
          <Text style={[styles.iconText, { color: readableTextOn(theme.color.tint) }]}>
            {label.slice(0, 3)}
          </Text>
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
  iconText: { fontWeight: '800', fontSize: 12 },
  meta: { flexShrink: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  documentRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  documentIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentMeta: { flex: 1, minWidth: 0 },
  documentName: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  documentSubtitle: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  documentAction: { flexShrink: 0, fontSize: 15, fontWeight: '600' },
});

interface SharedDocumentRowProps {
  attachment: ChatDocumentRow;
  accountLease: ReturnType<typeof captureRealtimeDeliveryLease>;
  screenIsCurrent: () => boolean;
}

/** Full-width file action row used by the virtualized Shared Documents explorer. */
export function SharedDocumentRow({
  attachment,
  accountLease,
  screenIsCurrent,
}: SharedDocumentRowProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((state) => state.status[attachment.guid]);
  const protectedPath = useAttachmentCachePathProtection(attachment.localPath);
  const attachmentRef = React.useRef(attachment);
  const protectedPathRef = React.useRef(protectedPath);
  const mountedRef = React.useRef(true);
  const openingRef = React.useRef(false);
  const [opening, setOpening] = React.useState(false);
  attachmentRef.current = attachment;
  protectedPathRef.current = protectedPath;

  React.useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ownsAttachment = (guid: string, path?: string): boolean => {
    const current = attachmentRef.current;
    return (
      mountedRef.current &&
      screenIsCurrent() &&
      accountLease.isCurrent() &&
      current.guid === guid &&
      (path === undefined ||
        (current.localPath === path && protectedPathRef.current === current.localPath))
    );
  };
  const label = fileTypeLabel(attachment.mimeType, attachment.transferName);
  const size = friendlySize(attachment.totalBytes);
  const subtitle = size ? `${label} • ${size}` : label;
  const downloading = status === 'downloading';
  const protectionUnavailable =
    isLocalFileUri(attachment.localPath) && protectedPath !== attachment.localPath;
  const action = opening
    ? 'Opening…'
    : downloading
      ? 'Downloading…'
      : protectionUnavailable
        ? 'Unavailable'
        : attachment.localPath
          ? 'Open'
          : status === 'error'
            ? 'Retry'
            : 'Download';
  const busy = opening || downloading;
  const disabled = busy || protectionUnavailable;

  const onPress = (): void => {
    const current = attachmentRef.current;
    if (!ownsAttachment(current.guid) || openingRef.current || downloading) return;
    if (!current.localPath) {
      void download(current, 'manual', accountLease);
      return;
    }
    const path = protectedPathRef.current;
    if (path !== current.localPath) return;

    openingRef.current = true;
    setOpening(true);
    void (async () => {
      try {
        const result = await openAttachmentFile(path, current.mimeType, {
          isCurrent: () => ownsAttachment(current.guid, path),
        });
        if (!ownsAttachment(current.guid, path)) return;
        if (result.status === 'missing') {
          void download(attachmentRef.current, 'manual', accountLease);
        } else if (result.status === 'no_handler') {
          showToast(`No app on this device can open ${label} files`);
        } else if (result.status === 'error') {
          showToast('Couldn’t open this file');
        }
      } finally {
        openingRef.current = false;
        if (mountedRef.current && attachmentRef.current.guid === current.guid) setOpening(false);
      }
    })();
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${action} ${attachment.transferName ?? 'file'}`}
      accessibilityHint="Downloads the document or opens it in another app"
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [
        styles.documentRow,
        { backgroundColor: theme.color.background, opacity: pressed && !disabled ? 0.72 : 1 },
      ]}
    >
      <View style={[styles.documentIcon, { backgroundColor: theme.color.tint }]}>
        {downloading || opening ? (
          <ActivityIndicator color={readableTextOn(theme.color.tint)} size="small" />
        ) : status === 'error' && !attachment.localPath ? (
          <Icon name="refresh-outline" size={22} color={readableTextOn(theme.color.tint)} />
        ) : (
          <Icon name="document-outline" size={22} color={readableTextOn(theme.color.tint)} />
        )}
      </View>
      <View style={styles.documentMeta}>
        <Text numberOfLines={2} style={[styles.documentName, { color: theme.color.label }]}>
          {attachment.transferName ?? 'File'}
        </Text>
        <Text style={[styles.documentSubtitle, { color: theme.color.secondaryLabel }]}>
          {subtitle}
        </Text>
      </View>
      <Text style={[styles.documentAction, { color: theme.color.tint }]}>{action}</Text>
    </Pressable>
  );
}
