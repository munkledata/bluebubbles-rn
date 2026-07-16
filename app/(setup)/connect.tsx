import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Screen, useTheme } from '@ui';

export default function Connect(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <Screen>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.color.label }]}>Connect</Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            Scan the QR code shown on your Gator Server, or enter the URL and password manually.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Scan QR Code" onPress={() => router.push('/scan')} />
          <Button
            title="Enter Manually"
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
