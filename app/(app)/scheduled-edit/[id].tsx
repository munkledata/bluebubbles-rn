import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { asRecurrence, type Recurrence } from '@core/schedule';
import { logger } from '@core/secure';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { getScheduledById } from '@db/repositories';
import { editScheduled } from '@/services/send';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
import { RecurrencePicker } from '@ui/conversations/RecurrencePicker';
import { SCHEDULE_DELIVERY_TIMING_NOTE } from '@ui/conversations/RecurrenceSheet';
import { formatChatDate, formatTime } from '@utils';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';

interface ScheduledDraft {
  text: string;
  when: number | null;
  recurrence: Recurrence | null;
}

/** Edit a still-pending scheduled message: change the text and/or the fire time. */
export default function ScheduledEditScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const schedId = Number(id);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [text, setText] = useState('');
  const [when, setWhen] = useState<number | null>(null);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialDraft, setInitialDraft] = useState<ScheduledDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const abandonedRef = useRef(false);

  const hasUnsavedChanges =
    loaded &&
    initialDraft != null &&
    (text !== initialDraft.text ||
      when !== initialDraft.when ||
      recurrence !== initialDraft.recurrence);
  const { navigateWithoutPrompt } = useUnsavedChangesGuard({
    enabled: hasUnsavedChanges,
    title: saving ? 'Leave while saving?' : 'Discard scheduled-message changes?',
    message: saving
      ? 'The update may still finish, but this screen will not navigate again after you leave.'
      : 'Your edited message, time, and repeat setting will be lost.',
    onDiscard: () => {
      abandonedRef.current = true;
    },
  });

  useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const row = await getScheduledById(getDatabase(), schedId);
        if (!accountLease.isCurrent()) return;
        if (row) {
          const nextRecurrence = asRecurrence(row.recurrence);
          setText(row.text);
          setWhen(row.scheduledFor);
          setRecurrence(nextRecurrence);
          setInitialDraft({
            text: row.text,
            when: row.scheduledFor,
            recurrence: nextRecurrence,
          });
        }
      } catch (e) {
        if (!accountLease.isCurrent()) return;
        // A failed read must not leave the screen permanently blank (loaded stuck false).
        logger.warn('[scheduled-edit] could not load scheduled message', e);
        setLoadError('Couldn’t load this scheduled message.');
      } finally {
        if (accountLease.isCurrent()) setLoaded(true);
      }
    })();
  }, [accountLease, schedId]);

  const reschedule = async (): Promise<void> => {
    if (!accountLease.isCurrent()) return;
    try {
      const picked = await pickFutureDateTime();
      if (picked != null && accountLease.isCurrent()) setWhen(picked);
    } catch {
      if (accountLease.isCurrent()) {
        showDialog('Scheduled', 'Couldn’t open the date picker.');
      }
    }
  };

  const save = (): void => {
    if (!accountLease.isCurrent() || saving) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    // editScheduled mirrors the change to the server first (for server-backed rows); a failed
    // server update rethrows so we surface it instead of silently diverging.
    void editScheduled(
      schedId,
      { text: trimmed, scheduledFor: when ?? undefined, recurrence },
      accountLease,
    )
      .then(() => {
        if (accountLease.isCurrent() && !abandonedRef.current) {
          navigateWithoutPrompt(() => router.back());
        }
      })
      .catch(() => {
        if (accountLease.isCurrent() && !abandonedRef.current) {
          showDialog('Scheduled', 'Couldn’t update — the server is unreachable.');
        }
      })
      .finally(() => {
        if (accountLease.isCurrent() && !abandonedRef.current) setSaving(false);
      });
  };

  return (
    <Screen>
      <ScreenHeader
        title="Edit Scheduled"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={save}
            disabled={!text.trim() || saving}
            accessibilityRole="button"
            accessibilityState={{ disabled: !text.trim() || saving }}
          >
            <Text
              style={[
                styles.save,
                {
                  color: text.trim() && !saving ? theme.color.tint : theme.color.tertiaryLabel,
                },
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
          <Text style={[styles.timingNote, { color: theme.color.secondaryLabel }]}>
            {SCHEDULE_DELIVERY_TIMING_NOTE}
          </Text>
          <Text style={[styles.repeatLabel, { color: theme.color.secondaryLabel }]}>Repeat</Text>
          <RecurrencePicker value={recurrence} onChange={setRecurrence} />
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
  timingNote: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  repeatLabel: { fontSize: 13, marginTop: 4, marginLeft: 4 },
});
