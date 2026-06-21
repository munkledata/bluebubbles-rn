import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, TextField, useTheme } from '@ui';

export default function Manual(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);

  useEffect(() => {
    if (status === 'connected') router.replace('/home');
  }, [status, router]);

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.title, { color: theme.color.label }]}>Server details</Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            Enter your BlueBubbles Server URL and password.
          </Text>
          <TextField
            label="Server URL"
            placeholder="https://your-server.ngrok.io"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={setUrl}
            returnKeyType="next"
          />
          <TextField
            label="Password"
            placeholder="Server password"
            secureTextEntry
            autoCapitalize="none"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => connect(url.trim(), password)}
            returnKeyType="go"
          />
          {error ? (
            <Text style={[styles.error, { color: theme.color.destructive }]}>{error}</Text>
          ) : null}
          <Button
            title="Connect"
            loading={status === 'connecting'}
            disabled={!url.trim() || !password}
            onPress={() => connect(url.trim(), password)}
            style={styles.button}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 24, paddingBottom: 40 },
  title: { fontSize: 30, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 16, marginBottom: 24, lineHeight: 22 },
  error: { fontSize: 14, marginBottom: 12 },
  button: { marginTop: 8 },
});
