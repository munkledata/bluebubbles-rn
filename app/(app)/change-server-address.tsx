import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { requestServerAddressChange, type ServerAddressChangeRequest } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, ScreenHeader, TextField, useTheme } from '@ui';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';

const RESULT_MESSAGES: Record<Exclude<ServerAddressChangeRequest, 'offered'>, string> = {
  invalid: 'Enter a server address like https://example.com.',
  'same-address': 'That is already your server address.',
  'insecure-downgrade':
    'Gator won’t switch from a secure https address to an insecure http one. To use an http ' +
    'server, disconnect and set it up again.',
  unavailable:
    'Gator can’t change the address right now. Make sure Gator is connected and unlocked, then ' +
    'try again.',
};

/**
 * Change Server Address (review item 800): the non-destructive way to follow a server that moved.
 * The typed address goes through the same approval prompt a server-sent change uses, which asks for
 * the server password and checks the new address. Messages and settings stay on this phone.
 */
export default function ChangeServerAddressScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const kbVisible = useKeyboardVisible();
  const currentOrigin = useSessionStore((s) => s.origin);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy || !address.trim()) return;
    setBusy(true);
    setError(null);
    const result = await requestServerAddressChange(address);
    setBusy(false);
    // The approval prompt opens over the app; return so it is not hidden behind this screen.
    if (result === 'offered') router.back();
    else setError(RESULT_MESSAGES[result]);
  };

  return (
    <Screen>
      <ScreenHeader title="Change Server Address" onBack={() => router.back()} />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[styles.body, { color: theme.color.secondaryLabel }]}>
            Use this when your server’s address changed, for example after a new tunnel address.
            Gator checks the new address and asks for your server password before switching. Your
            messages and settings stay on this phone.
          </Text>
          <Text style={[styles.label, { color: theme.color.secondaryLabel }]}>Current address</Text>
          <Text selectable style={[styles.value, { color: theme.color.label }]}>
            {currentOrigin ?? '—'}
          </Text>
          <TextField
            label="New server address"
            placeholder="https://example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={address}
            onChangeText={(text) => {
              setAddress(text);
              setError(null);
            }}
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
            editable={!busy}
          />
          {error ? (
            <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Text style={[styles.error, { color: theme.color.destructive }]}>{error}</Text>
            </View>
          ) : null}
          <Button
            title="Continue"
            loading={busy}
            disabled={!address.trim() || busy}
            onPress={() => void submit()}
            style={styles.button}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
  body: { fontSize: 15, lineHeight: 21, marginBottom: 20 },
  label: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  value: { fontSize: 16, lineHeight: 22, marginBottom: 20 },
  error: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  button: { marginTop: 8 },
});
