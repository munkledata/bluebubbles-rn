import { File } from 'expo-file-system';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { parseVCard, safeOpenUrl, type VCardData } from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';

interface ContactCardProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

/**
 * A contact (vCard) attachment as an iOS-style contact card. The .vcf is text, so it
 * must be downloaded first; once local we read it (expo-file-system `File`) and parse
 * with the pure {@link parseVCard}. Tap downloads (when not local) or opens the card.
 */
export function ContactCard({ att, isFromMe }: ContactCardProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const [contact, setContact] = useState<VCardData | null>(null);

  useEffect(() => {
    const path = att.localPath;
    if (!path) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await new File(path).text();
        if (!cancelled) setContact(parseVCard(text));
      } catch {
        if (!cancelled) setContact(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [att.localPath]);

  const onPress = (): void => {
    if (att.localPath) void safeOpenUrl(att.localPath);
    else void download(att);
  };

  const title = contact?.displayName ?? att.transferName ?? 'Contact';
  const subtitle = contact
    ? (contact.phones[0] ?? contact.emails[0] ?? 'Contact card')
    : status === 'downloading'
      ? 'Downloading…'
      : status === 'error'
        ? 'Tap to retry'
        : 'Tap to view contact';
  const initials = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Contact: ${title}`}
      style={[
        styles.chip,
        {
          backgroundColor: theme.color.secondaryBackground,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.avatar, { backgroundColor: theme.color.tint }]}>
        {status === 'downloading' ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : initials ? (
          <Text style={styles.avatarText}>{initials}</Text>
        ) : (
          <Icon name="person-outline" size={20} color="#fff" />
        )}
      </View>
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {subtitle}
        </Text>
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
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  meta: { flexShrink: 1, flexGrow: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20, fontWeight: '600' },
});
