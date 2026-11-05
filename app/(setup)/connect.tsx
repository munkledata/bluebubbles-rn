import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MESSAGES_PER_CHAT_OPTIONS, useSyncSettingsStore } from '@state/syncSettingsStore';
import { Button, NoteRow, Screen, SettingsSection, StepperRow, useTheme } from '@ui';
import { createI18n } from '@utils/i18n';

export default function Connect(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const i18n = useMemo(() => createI18n(), []);
  // Offered here because the first sync starts as soon as Scan/Manual connects. The store keeps the
  // choice even though the database usually isn't open yet, and saves it when connect opens it.
  const messagesPerChat = useSyncSettingsStore((s) => s.messagesPerChat);
  const setMessagesPerChat = useSyncSettingsStore((s) => s.setMessagesPerChat);
  const options = MESSAGES_PER_CHAT_OPTIONS as readonly number[];
  const index = Math.max(0, options.indexOf(messagesPerChat));

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
          <SettingsSection style={styles.syncDepth}>
            <StepperRow
              label={i18n.text('connect.syncDepth.label')}
              value={messagesPerChat === 0 ? i18n.text('connect.syncDepth.all') : messagesPerChat}
              onDecrement={() => void setMessagesPerChat(options[index - 1] ?? 0)}
              onIncrement={() => void setMessagesPerChat(options[index + 1] ?? messagesPerChat)}
              canDecrement={index > 0}
              canIncrement={index < options.length - 1}
              decrementLabel={i18n.text('connect.syncDepth.fewer')}
              incrementLabel={i18n.text('connect.syncDepth.more')}
            />
            <NoteRow text={i18n.text('connect.syncDepth.note')} />
          </SettingsSection>
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
  syncDepth: { marginTop: 32 },
  actions: {},
  spaced: { marginTop: 12 },
});
