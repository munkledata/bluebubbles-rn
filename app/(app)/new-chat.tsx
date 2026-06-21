import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import { searchContactAddresses, type ContactPick } from '@db/repositories';
import { createNewChat } from '@/services';
import { Screen, useTheme } from '@ui';

/** Start a new conversation: pick/enter recipient(s) + an initial message. */
export default function NewChatScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState('');
  const [service, setService] = useState<'iMessage' | 'SMS'>('iMessage');
  const [suggestions, setSuggestions] = useState<ContactPick[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await searchContactAddresses(getDatabase(), recipient, 30);
        if (active) setSuggestions(r);
      } catch {
        if (active) setSuggestions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [recipient]);

  const addresses = recipient
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const canStart = !busy && addresses.length > 0 && message.trim().length > 0;

  const onStart = async (): Promise<void> => {
    if (!canStart) return;
    setBusy(true);
    try {
      const guid = await createNewChat(addresses, message.trim(), service);
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
          <TextInput
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Phone or email (comma-separated for a group)"
            placeholderTextColor={theme.color.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={[styles.toInput, { color: theme.color.label }]}
          />
        </View>

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
                onPress={() => setRecipient(c.address)}
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
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  toLabel: { fontSize: 16, marginRight: 8 },
  toInput: { flex: 1, fontSize: 16, paddingVertical: 4 },
  serviceRow: { flexDirection: 'row', gap: 8 },
  serviceChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
  message: { minHeight: 90, borderRadius: 12, padding: 14, fontSize: 16, textAlignVertical: 'top' },
  suggestions: { borderRadius: 12, overflow: 'hidden' },
  suggestion: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  suggestionName: { fontSize: 16 },
  suggestionAddr: { fontSize: 13, marginTop: 2 },
});
