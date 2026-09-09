import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, TextField, useTheme } from '@ui';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';
import { createI18n } from '@utils/i18n';

export default function Manual(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbVisible = useKeyboardVisible();
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);
  const i18n = useMemo(() => createI18n(), []);

  const label = i18n.text('manual.insecure.label');
  const isHttp = /^http:\/\//i.test(url.trim());
  const submit = (): void => void connect(url.trim(), password, allowInsecure);

  useEffect(() => {
    if (status === 'connected') router.replace('/syncing');
  }, [status, router]);

  return (
    <Screen>
      {/* Android edge-to-edge no longer resizes this route reliably. Apply the keyboard inset as
          padding only while it is visible so the form stays reachable without leaving a residual
          navigation-bar-sized gap after the keyboard hides. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.title, { color: theme.color.label }]}>
            {i18n.text('manual.title')}
          </Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            {i18n.format('manual.subtitle', {
              serverName: i18n.text('product.serverName'),
            })}
          </Text>
          <TextField
            label={i18n.text('manual.field.url.label')}
            placeholder={i18n.text('manual.field.url.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={setUrl}
            returnKeyType="next"
          />
          <TextField
            label={i18n.text('manual.field.password.label')}
            placeholder={i18n.text('manual.field.password.placeholder')}
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
                <Text style={[styles.insecureTitle, { color: theme.color.label }]}>{label}</Text>
                <Text style={[styles.insecureSub, { color: theme.color.secondaryLabel }]}>
                  {`${i18n.text('manual.insecure.warning.prefix')}${i18n.text(
                    'manual.insecure.warning.protocol',
                  )}${i18n.text('manual.insecure.warning.suffix')}`}
                </Text>
              </View>
              <Switch aria-label={label} value={allowInsecure} onValueChange={setAllowInsecure} />
            </View>
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: theme.color.destructive }]}>{error}</Text>
          ) : null}
          <Button
            title={i18n.text('manual.action.connect')}
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
