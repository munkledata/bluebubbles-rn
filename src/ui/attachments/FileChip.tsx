import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { fileTypeLabel, friendlySize, safeOpenUrl } from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';

interface FileChipProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

/** Generic (non-image) attachment chip: icon + filename + "TYPE • size", with download state. */
export function FileChip({ att, isFromMe }: FileChipProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const label = fileTypeLabel(att.mimeType, att.transferName);
  const baseSub = att.totalBytes ? `${label} • ${friendlySize(att.totalBytes)}` : label;
  const sub =
    status === 'downloading' ? 'Downloading…' : status === 'error' ? 'Tap to retry' : baseSub;

  const onPress = (): void => {
    if (att.localPath) void safeOpenUrl(att.localPath);
    else void download(att);
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
        {status === 'downloading' ? (
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
