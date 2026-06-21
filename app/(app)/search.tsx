import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchResultRow } from '@db/repositories';
import { useSearch } from '@features/search/useSearch';
import { Screen, useTheme } from '@ui';
import { formatChatDate } from '@utils';

function chatTitle(r: SearchResultRow): string {
  return r.chatDisplayName || r.chatIdentifier || r.senderName || 'Unknown';
}

/** Full-text message search over the local FTS index. */
export default function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const { results, loading } = useSearch(q);

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <TextInput
          autoFocus
          value={q}
          onChangeText={setQ}
          placeholder="Search messages"
          placeholderTextColor={theme.color.tertiaryLabel}
          returnKeyType="search"
          style={[
            styles.input,
            {
              color: theme.color.label,
              backgroundColor: theme.color.secondaryBackground,
            },
          ]}
        />
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, { color: theme.color.tint }]}>Cancel</Text>
        </Pressable>
      </View>

      <FlashList
        data={results}
        keyExtractor={(r: SearchResultRow) => String(r.id)}
        renderItem={({ item }: { item: SearchResultRow }) => (
          <Pressable
            style={[styles.row, { borderBottomColor: theme.color.separator }]}
            onPress={() => router.push(`/chat/${encodeURIComponent(item.chatGuid)}`)}
          >
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
                {chatTitle(item)}
              </Text>
              <Text
                numberOfLines={2}
                style={[styles.snippet, { color: theme.color.secondaryLabel }]}
              >
                {item.text ?? ''}
              </Text>
            </View>
            <Text style={[styles.date, { color: theme.color.tertiaryLabel }]}>
              {formatChatDate(item.dateCreated)}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            {q.trim().length < 2
              ? 'Type to search your messages'
              : loading
                ? 'Searching…'
                : 'No results'}
          </Text>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, height: 38, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  cancel: { fontSize: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600' },
  snippet: { fontSize: 14, marginTop: 2 },
  date: { fontSize: 12 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
