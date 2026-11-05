import React, { useCallback, useLayoutEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCustomFolderSummaries } from '@features/conversations/useCustomFolderSummaries';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { useScreenAccountLease } from '../hooks/useScreenAccountLease';
import { readableTextOn, useTheme } from '../theme';

/**
 * A row of folder chips under the inbox title, shown only when you have folders. Tapping a chip
 * opens that folder's conversations. Self-contained so the inbox screen only renders it: it owns
 * its account lease, reads folder summaries only while the inbox is focused (the same rule as the
 * Folders screen), and hides itself while loading, on error, and once the account is retired.
 */
export function InboxFolderChips(): React.JSX.Element | null {
  const router = useRouter();
  const theme = useTheme();
  const accountLease = useScreenAccountLease();
  const [retired, setRetired] = useState(() => !accountLease.isCurrent());
  const [focused, setFocused] = useState(false);

  useLayoutEffect(
    () => subscribeRealtimeGenerationInvalidation(accountLease.generation, () => setRetired(true)),
    [accountLease],
  );
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const { data, error } = useCustomFolderSummaries(accountLease, !retired && focused);
  if (retired || error || !data || data.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityLabel="Folders"
    >
      {data.map((folder) => {
        const unread = folder.showUnreadBadge === 1 && folder.unreadChatCount > 0;
        return (
          <Pressable
            key={folder.id}
            onPress={() => {
              if (accountLease.isCurrent()) router.push(`/folders/${folder.id}/browse`);
            }}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${folder.name} folder${unread ? `, ${folder.unreadChatCount.toLocaleString('en-US')} unread` : ''}`}
            style={[styles.chip, { backgroundColor: theme.color.secondaryBackground }]}
          >
            <Text numberOfLines={1} style={[styles.chipText, { color: theme.color.label }]}>
              {folder.name}
            </Text>
            {unread ? (
              <View style={[styles.badge, { backgroundColor: theme.color.tint }]}>
                <Text style={[styles.badgeText, { color: readableTextOn(theme.color.tint) }]}>
                  {folder.unreadChatCount.toLocaleString('en-US')}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    maxWidth: 220,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  chipText: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  badge: { minWidth: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center' },
  badgeText: { fontSize: 12, fontWeight: '700' },
});
