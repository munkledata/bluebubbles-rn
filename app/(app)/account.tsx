import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Screen, ScreenHeader, useTheme } from '@ui';

/**
 * Kept as an explicit dead-end for old bookmarks and deep links. The helper-backed account and
 * send-from-alias feature is permanently retired in this release, regardless of server flags.
 */
export default function AccountScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Screen>
      <ScreenHeader title="iMessage Account" onBack={() => router.back()} />
      <View style={styles.center}>
        <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
          iMessage account details and send-from aliases were retired in this Gator release.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  note: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
