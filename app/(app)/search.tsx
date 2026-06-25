import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatNameMatch, SearchResultRow } from '@db/repositories';
import { useSearch } from '@features/search/useSearch';
import { Screen, useTheme } from '@ui';
import { formatChatDate, resolveTitle } from '@utils';

// The FTS snippet wraps matched tokens in these control chars (see searchMessagesEnriched). Built
// via fromCharCode so the source carries no invisible characters.
const MARK_START = String.fromCharCode(2); // U+0002
const MARK_END = String.fromCharCode(3); // U+0003
const STRIP_MARKS = new RegExp('[' + MARK_START + MARK_END + ']', 'g');
const MARK_RE = new RegExp(MARK_START + '([^' + MARK_END + ']*)' + MARK_END, 'g');

function chatTitle(r: SearchResultRow): string {
  return r.chatDisplayName || r.chatIdentifier || r.senderName || 'Unknown';
}

/**
 * Unified search: chat matches (by name / contact / number) AND message full-text hits
 * (incl. decoded edited/SMS text) — the same coverage as the inbox top-bar. Each message hit shows
 * a snippet centered on the match with the term bolded, and tapping it scrolls to that message.
 */
export default function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const { chats, results, loading } = useSearch(q);

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

  // Render the FTS snippet, bolding the matched term(s) — so it's obvious WHY each result matched
  // (and the matched word is always visible, even when it's deep in a long message).
  const renderSnippet = (snippet: string | null): React.ReactNode => {
    const s = snippet ?? '';
    if (!s.includes(MARK_START)) return s.replace(STRIP_MARKS, '');
    const out: React.ReactNode[] = [];
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    MARK_RE.lastIndex = 0;
    while ((m = MARK_RE.exec(s)) !== null) {
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(
        <Text key={key++} style={{ fontWeight: '700', color: theme.color.label }}>
          {m[1]}
        </Text>,
      );
      last = MARK_RE.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last).replace(STRIP_MARKS, ''));
    return out;
  };

  // Chat matches render above the message hits (FlashList header) — few in number, tap to open.
  const listHeader =
    chats.length > 0 ? (
      <View>
        {sectionLabel('Chats')}
        {chats.map((c: ChatNameMatch) => (
          <Pressable
            key={c.guid}
            style={[styles.row, { borderBottomColor: theme.color.separator }]}
            onPress={() => openChat(c.guid)}
          >
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
                {resolveTitle(c)}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.snippet, { color: theme.color.secondaryLabel }]}
              >
                {c.participantNames ?? c.chatIdentifier ?? ''}
              </Text>
            </View>
          </Pressable>
        ))}
        {results.length > 0 ? sectionLabel('Messages') : null}
      </View>
    ) : results.length > 0 ? (
      sectionLabel('Messages')
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
          chats.length > 0 ? null : (
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
