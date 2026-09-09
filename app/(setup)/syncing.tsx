import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSyncStore } from '@state/syncStore';
import { Button, Screen, useTheme } from '@ui';
import { createI18n } from '@utils/i18n';

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
  const i18n = useMemo(() => createI18n(), []);

  // Auto-advance to the explicit permission choices a beat after the sync finishes.
  useEffect(() => {
    if (status === 'done') {
      const id = setTimeout(() => router.replace('/permissions'), 700);
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
            {i18n.text(
              done ? 'sync.title.complete' : errored ? 'sync.title.error' : 'sync.title.progress',
            )}
          </Text>
          <Text style={[styles.detail, { color: theme.color.secondaryLabel }]}>
            {errored
              ? i18n.text('sync.detail.error')
              : `${i18n.count(
                  chats,
                  'sync.count.chat.one',
                  'sync.count.chat.other',
                )}${i18n.text('sync.count.separator')}${i18n.count(
                  messages,
                  'sync.count.message.one',
                  'sync.count.message.other',
                )}`}
          </Text>
        </View>

        <Button
          title={i18n.text(done ? 'sync.action.continue' : 'sync.action.background')}
          onPress={() => router.replace('/permissions')}
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
