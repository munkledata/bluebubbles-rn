import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Screen, useTheme } from '@ui';
import { createI18n } from '@utils/i18n';

export default function Connect(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const i18n = useMemo(() => createI18n(), []);

  return (
    <Screen>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.color.label }]}>
            {i18n.text('connect.title')}
          </Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            {i18n.format('connect.subtitle', {
              serverName: i18n.text('product.serverName'),
            })}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title={i18n.text('connect.action.scan')} onPress={() => router.push('/scan')} />
          <Button
            title={i18n.text('connect.action.manual')}
            variant="tinted"
            onPress={() => router.push('/manual')}
            style={styles.spaced}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24 },
  header: { marginTop: 24 },
  title: { fontSize: 30, fontWeight: '700' },
  subtitle: { fontSize: 16, marginTop: 12, lineHeight: 22 },
  actions: {},
  spaced: { marginTop: 12 },
});
