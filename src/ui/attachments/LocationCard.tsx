import { File } from 'expo-file-system';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { parseVLocation, safeOpenUrl, type VLocationData } from '@utils';
import { useTheme } from '../theme';

interface LocationCardProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

/**
 * An Apple location (.loc.vcf) attachment as a tappable map-link card. Downloaded then
 * parsed with the pure {@link parseVLocation}. Tap opens a `geo:` URL (Android-native,
 * consistent with the Find My "Open in Maps" fallback) — no Maps API key needed.
 */
export function LocationCard({ att, isFromMe }: LocationCardProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const [loc, setLoc] = useState<VLocationData | null>(null);

  useEffect(() => {
    const path = att.localPath;
    if (!path) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await new File(path).text();
        if (!cancelled) setLoc(parseVLocation(text));
      } catch {
        if (!cancelled) setLoc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [att.localPath]);

  const onPress = (): void => {
    if (!att.localPath) {
      void download(att);
      return;
    }
    if (loc) {
      void safeOpenUrl(`geo:${loc.latitude},${loc.longitude}?q=${loc.latitude},${loc.longitude}`);
    }
  };

  const subtitle = loc
    ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`
    : status === 'downloading'
      ? 'Downloading…'
      : status === 'error'
        ? 'Tap to retry'
        : 'Tap to open';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Location"
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
        ) : (
          <Text style={styles.iconText}>📍</Text>
        )}
      </View>
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
          {att.transferName ?? 'Location'}
        </Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>{subtitle}</Text>
      </View>
      <Text style={[styles.chevron, { color: theme.color.tertiaryLabel }]}>›</Text>
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
  icon: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 20 },
  meta: { flexShrink: 1, flexGrow: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20, fontWeight: '600' },
});
