import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  findChatByParticipantAddresses,
  searchContactAddresses,
  type ContactPick,
} from '@db/repositories';
import { createNewChat } from '@/services';
import { Screen, useTheme } from '@ui';

/** A chosen recipient chip: an address plus its best display name. */
interface Recipient {
  address: string;
  name: string;
}

/** Start a new conversation: pick recipient chips + an initial message. */
export default function NewChatScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // A forwarded message pre-fills the composer (from the chat's "Forward" action).
  const { forwardText } = useLocalSearchParams<{ forwardText?: string }>();
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState(forwardText ?? '');
  const [service, setService] = useState<'iMessage' | 'SMS'>('iMessage');
  const [suggestions, setSuggestions] = useState<ContactPick[]>([]);
  const [existingGuid, setExistingGuid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await searchContactAddresses(getDatabase(), query, 30);
        if (active) setSuggestions(r.filter((c) => !chosen.has(c.address.toLowerCase())));
      } catch {
        if (active) setSuggestions([]);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, recipients]);

  // Detect whether a chat with exactly these recipients already exists → offer to continue it.
  useEffect(() => {
    let active = true;
    if (recipients.length === 0) {
      setExistingGuid(null);
      return;
    }
    void findChatByParticipantAddresses(
      getDatabase(),
      recipients.map((r) => r.address),
    ).then((g) => {
      if (active) setExistingGuid(g);
    });
    return () => {
      active = false;
    };
  }, [recipients]);

  const addRecipient = (r: Recipient): void => {
    if (chosen.has(r.address.toLowerCase())) return;
    setRecipients((prev) => [...prev, r]);
    setQuery('');
  };

  const removeRecipient = (address: string): void => {
    setRecipients((prev) => prev.filter((r) => r.address !== address));
  };

  // Backspace on an empty input removes the last chip (iOS token-field behavior).
  const onKeyPress = (key: string): void => {
    if (key === 'Backspace' && query.length === 0 && recipients.length > 0) {
      removeRecipient(recipients[recipients.length - 1]!.address);
    }
  };

  // Committing raw typed text (comma / return) as a chip, when it looks like an address.
  const commitRaw = (): void => {
    const raw = query.trim().replace(/,$/, '').trim();
    if (raw.length === 0) return;
    addRecipient({ address: raw, name: raw });
  };

  const canStart = !busy && recipients.length > 0 && message.trim().length > 0;

  const onStart = async (): Promise<void> => {
    if (!canStart) return;
    setBusy(true);
    try {
      // createNewChat is server-deduped, so it returns the existing chat if there is one.
      const guid = await createNewChat(
        recipients.map((r) => r.address),
        message.trim(),
        service,
      );
      router.replace(`/chat/${encodeURIComponent(guid)}`);
    } catch {
      Alert.alert(
        'New message',
        'Couldn’t start the conversation. Check the address and your server connection.',
      );
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>New Message</Text>
        <Pressable onPress={() => void onStart()} disabled={!canStart} accessibilityRole="button">
          <Text
            style={[
              styles.start,
              { color: canStart ? theme.color.tint : theme.color.tertiaryLabel },
            ]}
          >
            Start
          </Text>
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={[styles.toLine, { borderBottomColor: theme.color.separator }]}>
          <Text style={[styles.toLabel, { color: theme.color.secondaryLabel }]}>To:</Text>
          <View style={styles.chipsWrap}>
            {recipients.map((r) => (
              <Pressable
                key={r.address}
                onPress={() => removeRecipient(r.address)}
                style={[styles.chip, { backgroundColor: theme.color.tint }]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${r.name}`}
              >
                <Text style={styles.chipText}>{r.name} ✕</Text>
              </Pressable>
            ))}
            <TextInput
              value={query}
              onChangeText={(t) => {
                if (t.endsWith(',')) commitRaw();
                else setQuery(t);
              }}
              onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
              onSubmitEditing={commitRaw}
              placeholder={recipients.length === 0 ? 'Phone or email' : 'Add another…'}
              placeholderTextColor={theme.color.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={[styles.toInput, { color: theme.color.label }]}
            />
          </View>
        </View>

        {existingGuid ? (
          <Pressable
            onPress={() => router.replace(`/chat/${encodeURIComponent(existingGuid)}`)}
            style={[styles.existing, { backgroundColor: theme.color.secondaryBackground }]}
          >
            <Text style={[styles.existingText, { color: theme.color.tint }]}>
              You already have a conversation with{' '}
              {recipients.length === 1 ? 'this person' : 'these people'} — Open it ›
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.serviceRow}>
          {(['iMessage', 'SMS'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => setService(s)}
              style={[
                styles.serviceChip,
                {
                  backgroundColor:
                    service === s ? theme.color.tint : theme.color.secondaryBackground,
                },
              ]}
            >
              <Text style={{ color: service === s ? '#fff' : theme.color.label, fontSize: 14 }}>
                {s}
              </Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Message"
          placeholderTextColor={theme.color.tertiaryLabel}
          multiline
          style={[
            styles.message,
            { color: theme.color.label, backgroundColor: theme.color.secondaryBackground },
          ]}
        />

        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestions.map((c, i) => (
              <Pressable
                key={`${c.address}-${i}`}
                onPress={() => addRecipient({ address: c.address, name: c.name || c.address })}
                style={[styles.suggestion, { borderBottomColor: theme.color.separator }]}
              >
                <Text style={[styles.suggestionName, { color: theme.color.label }]}>
                  {c.name || c.address}
                </Text>
                {c.name ? (
                  <Text style={[styles.suggestionAddr, { color: theme.color.secondaryLabel }]}>
                    {c.address}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17 },
  title: { fontSize: 17, fontWeight: '600' },
  start: { fontSize: 17, fontWeight: '600' },
  content: { padding: 16, gap: 12 },
  toLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  toLabel: { fontSize: 16, marginRight: 8, marginTop: 6 },
  chipsWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { color: '#fff', fontSize: 14 },
  toInput: { flexGrow: 1, minWidth: 120, fontSize: 16, paddingVertical: 4 },
  existing: { borderRadius: 10, padding: 12 },
  existingText: { fontSize: 14, fontWeight: '500' },
  serviceRow: { flexDirection: 'row', gap: 8 },
  serviceChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
  message: { minHeight: 90, borderRadius: 12, padding: 14, fontSize: 16, textAlignVertical: 'top' },
  suggestions: { borderRadius: 12, overflow: 'hidden' },
  suggestion: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  suggestionName: { fontSize: 16 },
  suggestionAddr: { fontSize: 13, marginTop: 2 },
});
