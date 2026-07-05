import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import { searchContactAddresses, type ContactPick } from '@db/repositories';
import { getOrCreateSmsThreadId } from '@/services/deviceSms/deviceSmsService';
import { Screen, useTheme } from '@ui';

/** Only phone-shaped addresses can receive an SMS (skip email handles from contacts). */
function isPhoneLike(address: string): boolean {
  return !address.includes('@') && (address.match(/\d/g)?.length ?? 0) >= 3;
}

/** Compose a new device SMS: enter a number or pick a contact, then open the thread. */
export function SmsNewMessageScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<ContactPick[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await searchContactAddresses(getDatabase(), query, 30);
        if (active) setSuggestions(r.filter((c) => isPhoneLike(c.address)));
      } catch {
        // DB may not be open — degrade to raw entry, no suggestions.
        if (active) setSuggestions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [query]);

  const proceed = useCallback(
    async (address: string, name: string): Promise<void> => {
      const addr = address.trim();
      if (!addr || busy) return;
      setBusy(true);
      try {
        const threadId = await getOrCreateSmsThreadId(addr);
        router.replace({
          pathname: '/device-sms/[threadId]',
          params: { threadId: String(threadId), address: addr, name },
        });
      } catch {
        Alert.alert('Phone SMS', 'Couldn’t start this conversation.');
        setBusy(false);
      }
    },
    [busy, router],
  );

  const canSubmit = query.trim().length > 0 && !busy;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>New Text</Text>
        <Pressable
          onPress={() => void proceed(query, query.trim())}
          disabled={!canSubmit}
          accessibilityRole="button"
        >
          <Text style={[styles.next, { color: canSubmit ? theme.color.tint : theme.color.tertiaryLabel }]}>
            Next
          </Text>
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={[styles.toLine, { borderBottomColor: theme.color.separator }]}>
          <Text style={[styles.toLabel, { color: theme.color.secondaryLabel }]}>To:</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => void proceed(query, query.trim())}
            placeholder="Phone number"
            placeholderTextColor={theme.color.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
            style={[styles.toInput, { color: theme.color.label }]}
          />
        </View>

        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestions.map((c, i) => (
              <Pressable
                key={`${c.address}-${i}`}
                onPress={() => void proceed(c.address, c.name || c.address)}
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
  next: { fontSize: 17, fontWeight: '600' },
  content: { padding: 16, gap: 12 },
  toLine: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  toLabel: { fontSize: 16, marginRight: 8 },
  toInput: { flex: 1, fontSize: 16, paddingVertical: 4 },
  suggestions: { borderRadius: 12, overflow: 'hidden' },
  suggestion: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  suggestionName: { fontSize: 16 },
  suggestionAddr: { fontSize: 13, marginTop: 2 },
});
