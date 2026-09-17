import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Screen, ScreenHeader, useTheme } from '@ui';

/** Retained route for old links/bookmarks; FaceTime calling is permanently retired. */
export default function FaceTimeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Screen>
      <ScreenHeader title="FaceTime" onBack={() => router.back()} />
      <View style={styles.unavailable}>
        <Text style={[styles.unavailableText, { color: theme.color.secondaryLabel }]}>
          FaceTime calling from Gator was retired in this release.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  unavailable: { paddingHorizontal: 24, paddingTop: 40 },
  unavailableText: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
});
