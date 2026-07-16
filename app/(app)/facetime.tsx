import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { useFaceTime } from '@features/facetime/useFaceTime';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { ContactSuggestionList } from '@ui/ContactSuggestionList';

/**
 * Dedicated FaceTime dialer: enter or pick a recipient and place a call directly — no
 * message thread required. The native dial rings the recipient from your number.
 */
export default function FaceTimeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { startCallTo } = useFaceTime();
  const [recipient, setRecipient] = useState('');
  const [video, setVideo] = useState(true);
  const [busy, setBusy] = useState(false);
  const suggestions = useContactSearch(recipient);

  const addresses = recipient
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const canCall = !busy && addresses.length > 0;

  const onCall = async (): Promise<void> => {
    if (!canCall) return;
    setBusy(true);
    try {
      await startCallTo({ addresses, video });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="FaceTime" onBack={() => router.back()} />

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

        <View style={styles.modeRow}>
          {(
            [
              ['Video', true],
              ['Audio', false],
            ] as const
          ).map(([label, v]) => (
            <Pressable
              key={label}
              onPress={() => setVideo(v)}
              style={[
                styles.modeChip,
                {
                  backgroundColor: video === v ? theme.color.tint : theme.color.secondaryBackground,
                },
              ]}
            >
              <Text style={{ color: video === v ? '#fff' : theme.color.label, fontSize: 14 }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => void onCall()}
          disabled={!canCall}
          style={[
            styles.callBtn,
            { backgroundColor: canCall ? theme.color.tint : theme.color.secondaryBackground },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Start FaceTime call"
        >
          <Text style={[styles.callText, { color: canCall ? '#fff' : theme.color.tertiaryLabel }]}>
            📹 FaceTime
          </Text>
        </Pressable>

        <ContactSuggestionList suggestions={suggestions} onPick={(c) => setRecipient(c.address)} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  toLine: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  toLabel: { fontSize: 16, marginRight: 8 },
  toInput: { flex: 1, fontSize: 16, paddingVertical: 4 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 14 },
  callBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  callText: { fontSize: 17, fontWeight: '600' },
});
