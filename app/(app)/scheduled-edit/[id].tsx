import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { asRecurrence, type Recurrence } from '@core/schedule';
import { logger } from '@core/secure';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { getScheduledById, type ScheduledOccurrence } from '@db/repositories';
import { editScheduled, ScheduledEditChangedError } from '@/services/send';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { RecurrencePicker } from '@ui/conversations/RecurrencePicker';
import { ScheduleSheet, SCHEDULE_DELIVERY_TIMING_NOTE } from '@ui/conversations/RecurrenceSheet';
import { formatChatDate, formatTime } from '@utils';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

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
  const accountLease = useScreenAccountLease();
  const [text, setText] = useState('');
  const [when, setWhen] = useState<number | null>(null);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialDraft, setInitialDraft] = useState<ScheduledDraft | null>(null);
  // The exact occurrence this editor was opened on; Save may only change that one.
  const [occurrence, setOccurrence] = useState<ScheduledOccurrence | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerWhen, setPickerWhen] = useState(0);
  const pickerOpenRef = useRef(false);
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
      pickerOpenRef.current = false;
    },
  });

  useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
      pickerOpenRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const row = await getScheduledById(getDatabase(), schedId);
        if (!accountLease.isCurrent()) return;
        if (row) {
          if (row.attachmentName) {
            setLoadError(
              'File schedules cannot be edited. Cancel this schedule and create a new one.',
            );
            return;
          }
          const nextRecurrence = asRecurrence(row.recurrence);
          setText(row.text);
          setWhen(row.scheduledFor);
          setRecurrence(nextRecurrence);
          setInitialDraft({
            text: row.text,
            when: row.scheduledFor,
            recurrence: nextRecurrence,
          });
          setOccurrence({
            id: row.id,
            chatGuid: row.chatGuid,
            serverId: row.serverId,
            scheduledFor: row.scheduledFor,
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

  const reschedule = (): void => {
    if (!accountLease.isCurrent() || abandonedRef.current || saving || pickerOpenRef.current)
      return;
    pickerOpenRef.current = true;
    setPickerWhen(when ?? Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
    setPickerOpen(true);
  };

  const save = (): void => {
    if (!accountLease.isCurrent() || abandonedRef.current || saving || pickerOpenRef.current)
      return;
    const trimmed = text.trim();
    if (!trimmed || !occurrence) return;
    setSaving(true);
    // editScheduled mirrors the change to the server first (for server-backed rows); a failed
    // server update rethrows so we surface it instead of silently diverging. The time goes only
    // when the user changed it, so a text-only edit never moves the schedule.
    void editScheduled(
      occurrence,
      {
        text: trimmed,
        ...(when != null && when !== occurrence.scheduledFor ? { scheduledFor: when } : {}),
        recurrence,
      },
      accountLease,
    )
      .then(() => {
        if (accountLease.isCurrent() && !abandonedRef.current) {
          navigateWithoutPrompt(() => router.back());
        }
      })
      .catch((error: unknown) => {
        if (accountLease.isCurrent() && !abandonedRef.current) {
          showDialog(
            'Scheduled',
            error instanceof ScheduledEditChangedError
              ? 'This message was sent or its schedule changed while you were editing, so your edit was not saved. Open it again to edit what is still scheduled.'
              : 'Couldn’t update — the server is unreachable.',
          );
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
            onPress={reschedule}
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
      {pickerOpen && !saving && accountLease.isCurrent() ? (
        <ScheduleSheet
          initialWhen={pickerWhen}
          title="Reschedule message"
          confirmLabel="Use this time"
          showRepeat={false}
          onClose={() => {
            pickerOpenRef.current = false;
            setPickerOpen(false);
          }}
          onConfirm={(picked) => {
            if (!pickerOpenRef.current) return;
            pickerOpenRef.current = false;
            setPickerOpen(false);
            if (!accountLease.isCurrent() || abandonedRef.current || saving || picked <= Date.now())
              return;
            setWhen(picked);
          }}
        />
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
