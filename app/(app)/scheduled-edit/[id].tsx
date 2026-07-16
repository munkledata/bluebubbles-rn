import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { logger } from '@core/secure';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { getScheduledById } from '@db/repositories';
import { editScheduled } from '@/services/send';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
import { formatChatDate, formatTime } from '@utils';

/** Edit a still-pending scheduled message: change the text and/or the fire time. */
export default function ScheduledEditScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const schedId = Number(id);
  const [text, setText] = useState('');
  const [when, setWhen] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const row = await getScheduledById(getDatabase(), schedId);
        if (row) {
          setText(row.text);
          setWhen(row.scheduledFor);
        }
      } catch (e) {
        // A failed read must not leave the screen permanently blank (loaded stuck false).
        logger.warn('[scheduled-edit] could not load scheduled message', e);
        setLoadError('Couldn’t load this scheduled message.');
      } finally {
        setLoaded(true);
      }
    })();
  }, [schedId]);

  const reschedule = async (): Promise<void> => {
    const picked = await pickFutureDateTime();
    if (picked != null) setWhen(picked);
  };

  const save = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // editScheduled mirrors the change to the server first (for server-backed rows); a failed
    // server update rethrows so we surface it instead of silently diverging.
    void editScheduled(schedId, { text: trimmed, scheduledFor: when ?? undefined })
      .then(() => router.back())
      .catch(() => showDialog('Scheduled', 'Couldn’t update — the server is unreachable.'));
  };

  return (
    <Screen>
      <ScreenHeader
        title="Edit Scheduled"
        onBack={() => router.back()}
        right={
          <Pressable onPress={save} disabled={!text.trim()} accessibilityRole="button">
            <Text
              style={[
                styles.save,
                { color: text.trim() ? theme.color.tint : theme.color.tertiaryLabel },
              ]}
            >
              Save
            </Text>
          </Pressable>
        }
      />

      {loaded && loadError ? (
        <Text style={[styles.loadError, { color: theme.color.destructive }]}>{loadError}</Text>
      ) : null}
      {loaded && !loadError ? (
        <View style={styles.content}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder="Message"
            placeholderTextColor={theme.color.tertiaryLabel}
            style={[
              styles.input,
              { color: theme.color.label, backgroundColor: theme.color.secondaryBackground },
            ]}
          />
          <Pressable
            onPress={() => void reschedule()}
            style={[styles.timeRow, { backgroundColor: theme.color.secondaryBackground }]}
            accessibilityRole="button"
            accessibilityLabel="Reschedule"
          >
            <Text style={[styles.timeLabel, { color: theme.color.label }]}>Send</Text>
            <Text style={[styles.timeValue, { color: theme.color.tint }]}>
              {when != null ? `${formatChatDate(when)} ${formatTime(when)}` : 'Pick a time'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  save: { fontSize: 17, fontWeight: '600', textAlign: 'right' },
  content: { padding: 16, gap: 12 },
  loadError: { textAlign: 'center', marginTop: 40, fontSize: 15, paddingHorizontal: 16 },
  input: { minHeight: 90, borderRadius: 12, padding: 14, fontSize: 16, textAlignVertical: 'top' },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  timeLabel: { fontSize: 16 },
  timeValue: { fontSize: 16 },
});
