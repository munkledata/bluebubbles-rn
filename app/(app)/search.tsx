import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchResultRow } from '@db/repositories';
import { useChatMatches } from '@features/search/useChatMatches';
import { useSearch } from '@features/search/useSearch';
import { Screen, useTheme } from '@ui';
import { ConversationTile } from '@ui/conversations/ConversationTile';
import { formatChatDate, resolveTitle } from '@utils';

// Cap the chat list on this page so the (non-virtualized) header stays light; the matching set is
// identical to the inbox — this just bounds how many tiles render above the message hits.
const MAX_CHAT_RESULTS = 50;

// The chat title for a message hit, resolved exactly like the inbox so a group shows its
// name/participants (never a raw chat-guid) and a 1:1 shows the contact name. resolveTitle ignores
// style/participantCount, so a placeholder count is fine.
function chatTitle(r: SearchResultRow): string {
  return resolveTitle({
    customName: r.chatCustomName,
    displayName: r.chatDisplayName,
    chatIdentifier: r.chatIdentifier,
    participantNames: r.chatParticipantNames,
    style: r.chatStyle,
    participantCount: 0,
  });
}

/**
 * Unified search: a Chats section (the SAME matched chats the inbox top-bar shows, via the shared
 * useChatMatches) and a Messages section (full-text hits, incl. decoded edited/SMS text). Each
 * message hit shows a snippet centered on the match with the term bolded, and tapping it scrolls to
 * that message.
 */
export default function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const { results, loading } = useSearch(q);
  // Chats section = NAME/people matches only (jump to a conversation). Message-content matches show
  // in the Messages section below, with the snippet — so the Chats list never looks irrelevant.
  const matched = useChatMatches(q, { contentMatches: false });
  const searching = q.trim().length >= 2;
  const chatRows = (searching ? (matched.data ?? []) : []).slice(0, MAX_CHAT_RESULTS);

  const openChat = (guid: string): void => {
    router.push(`/chat/${encodeURIComponent(guid)}`);
  };
  // Open the chat focused on the matched message (the chat screen scrolls to + highlights it).
  const openMessage = (r: SearchResultRow): void => {
    const date = r.dateCreated != null ? `&focusDate=${r.dateCreated}` : '';
    router.push(
      `/chat/${encodeURIComponent(r.chatGuid)}?focus=${encodeURIComponent(r.guid)}${date}`,
    );
  };

  const sectionLabel = (label: string): React.JSX.Element => (
    <Text style={[styles.section, { color: theme.color.secondaryLabel }]}>{label}</Text>
  );

  // Bold the parts of the snippet that match the query — whole words starting with a query term
  // (matching the FTS prefix search) — so it's obvious WHY each result matched. Done in JS over the
  // centered snippet (no DB-side marks, which don't reliably survive the native bridge).
  const renderSnippet = (snippet: string | null): React.ReactNode => {
    const text = snippet ?? '';
    const terms =
      q
        .trim()
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    if (terms.length === 0 || !text) return text;
    return text.split(/([\p{L}\p{N}]+)/u).map((part, i) => {
      const lower = part.toLowerCase();
      return part && terms.some((t) => lower.startsWith(t)) ? (
        <Text key={i} style={{ fontWeight: '700', color: theme.color.label }}>
          {part}
        </Text>
      ) : (
        part
      );
    });
  };

  // Matched chats (identical to the inbox) render above the message hits, as the same tiles.
  const listHeader =
    chatRows.length > 0 || results.length > 0 ? (
      <View>
        {chatRows.length > 0 ? sectionLabel('Chats') : null}
        {chatRows.map((c) => (
          <ConversationTile key={c.guid} row={c} onPress={openChat} />
        ))}
        {results.length > 0 ? sectionLabel('Messages') : null}
      </View>
    ) : null;

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
          placeholder="Search messages & chats"
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
        ListHeaderComponent={listHeader}
        renderItem={({ item }: { item: SearchResultRow }) => (
          <Pressable
            style={[styles.row, { borderBottomColor: theme.color.separator }]}
            onPress={() => openMessage(item)}
          >
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
                {chatTitle(item)}
              </Text>
              <Text
                numberOfLines={2}
                style={[styles.snippet, { color: theme.color.secondaryLabel }]}
              >
                {renderSnippet(item.snippet ?? item.text)}
              </Text>
            </View>
            <Text style={[styles.date, { color: theme.color.tertiaryLabel }]}>
              {formatChatDate(item.dateCreated)}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          chatRows.length > 0 ? null : (
            <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
              {q.trim().length < 2
                ? 'Type to search your messages & chats'
                : loading
                  ? 'Searching…'
                  : 'No results'}
            </Text>
          )
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
  section: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
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
