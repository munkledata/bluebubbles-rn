import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSyncStore } from '@state/syncStore';
import { Button, Screen, useTheme } from '@ui';

/**
 * First-run sync progress. Shown right after a successful connect (scan/manual) so the user sees
 * the initial sync happen instead of landing on an empty inbox. Subscribes to the sync store;
 * auto-advances to the inbox when the sync completes (or lets the user skip / continue on error).
 */
export default function Syncing(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const status = useSyncStore((s) => s.status);
  const chats = useSyncStore((s) => s.chats);
  const messages = useSyncStore((s) => s.messages);

  // Auto-advance to the inbox a beat after the sync finishes.
  useEffect(() => {
    if (status === 'done') {
      const id = setTimeout(() => router.replace('/home'), 700);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [status, router]);

  const done = status === 'done';
  const errored = status === 'error';

  return (
    <Screen>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.center}>
          {done ? (
            <Text style={[styles.check, { color: theme.color.tint }]}>✓</Text>
          ) : errored ? (
            <Text style={[styles.check, { color: theme.color.destructive }]}>!</Text>
          ) : (
            <ActivityIndicator size="large" color={theme.color.tint} />
          )}
          <Text style={[styles.title, { color: theme.color.label }]}>
            {done ? 'Sync complete' : errored ? 'Sync had trouble' : 'Syncing your messages…'}
          </Text>
          <Text style={[styles.detail, { color: theme.color.secondaryLabel }]}>
            {errored
              ? 'Some messages may still be catching up — you can continue and they’ll fill in.'
              : `${chats.toLocaleString()} chats · ${messages.toLocaleString()} messages`}
          </Text>
        </View>

        <Button
          title={done ? 'Open Messages' : 'Continue in Background'}
          onPress={() => router.replace('/home')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  check: { fontSize: 56, fontWeight: '800' },
  title: { fontSize: 22, fontWeight: '700', marginTop: 8 },
  detail: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
});
