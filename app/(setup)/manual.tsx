import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
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
  const [allowInsecure, setAllowInsecure] = useState(false);
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);

  // Show the insecure-connection acknowledgement only for an explicit http:// URL.
  const isHttp = /^http:\/\//i.test(url.trim());
  const submit = (): void => void connect(url.trim(), password, allowInsecure);

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
            onSubmitEditing={submit}
            returnKeyType="go"
          />
          {isHttp ? (
            <View style={styles.insecureRow}>
              <View style={styles.insecureText}>
                <Text style={[styles.insecureTitle, { color: theme.color.label }]}>
                  Allow insecure connection
                </Text>
                <Text style={[styles.insecureSub, { color: theme.color.secondaryLabel }]}>
                  This server uses unencrypted http://. Only enable for a server you trust.
                </Text>
              </View>
              <Switch value={allowInsecure} onValueChange={setAllowInsecure} />
            </View>
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: theme.color.destructive }]}>{error}</Text>
          ) : null}
          <Button
            title="Connect"
            loading={status === 'connecting'}
            disabled={!url.trim() || !password || (isHttp && !allowInsecure)}
            onPress={submit}
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
  insecureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 4,
    gap: 12,
  },
  insecureText: { flex: 1 },
  insecureTitle: { fontSize: 15, fontWeight: '600' },
  insecureSub: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
