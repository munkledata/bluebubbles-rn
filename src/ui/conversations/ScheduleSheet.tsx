import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Recurrence } from '@core/schedule';
import { TextField } from '../primitives/TextField';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible';
import { readableTextOn, useTheme } from '../theme';

interface ScheduleSheetProps {
  initialWhen: number;
  /** The edit screen already owns recurrence; it uses this sheet for date/time only. */
  showRepeat?: boolean;
  /** File schedules are one-time only. */
  allowRepeat?: boolean;
  title?: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (when: number, recurrence: Recurrence | null) => void;
}

const CHOICES: { label: string; value: Recurrence | null }[] = [
  { label: 'Send once', value: null },
  { label: 'Repeat daily', value: 'daily' },
  { label: 'Repeat weekly', value: 'weekly' },
  { label: 'Repeat monthly', value: 'monthly' },
];

export const SCHEDULE_DELIVERY_TIMING_NOTE =
  'Scheduled delivery is best effort, not exact. One-time messages ask the server to schedule when available. Repeating messages and offline fallbacks rely on Android background work; sleep, battery limits, connectivity, or an unavailable Mac/server can delay them.';

/** Exact local fields: Date must not turn February 30 or a DST gap into a send. */
export function parseScheduleDateTime(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const [hour = -1, minute = -1] = time.split(':').map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
    return null;
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute
  )
    return null;
  return value.getTime();
}

function localDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

function localTime(value: Date): string {
  return [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
  ].join(':');
}

/** Mounted once per opening. Nothing leaves this sheet until explicit confirmation. */
export function ScheduleSheet({
  initialWhen,
  showRepeat = true,
  allowRepeat = true,
  title = 'Schedule message',
  confirmLabel = 'Schedule',
  onClose,
  onConfirm,
}: ScheduleSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [date, setDate] = useState(() => localDate(new Date(initialWhen)));
  const [time, setTime] = useState(() => localTime(new Date(initialWhen)));
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(false);
  useEffect(() => {
    completed.current = false;
    return () => {
      completed.current = true;
    };
  }, []);
  const close = (): void => {
    if (completed.current) return;
    completed.current = true;
    onClose();
  };
  const chooseShortcut = (tomorrow: boolean): void => {
    if (completed.current) return;
    const value = new Date(Date.now());
    if (tomorrow) {
      value.setDate(value.getDate() + 1);
      value.setHours(9, 0, 0, 0);
    } else {
      value.setTime(Math.ceil((value.getTime() + 60 * 60_000) / 60_000) * 60_000);
    }
    setDate(localDate(value));
    setTime(localTime(value));
    setError(null);
  };
  const confirm = (): void => {
    if (completed.current) return;
    const when = parseScheduleDateTime(date, time);
    if (when == null) {
      setError('Enter a real date (YYYY-MM-DD) and local time (HH:MM, 24-hour).');
      return;
    }
    if (when <= Date.now()) {
      setError('Choose a time in the future.');
      return;
    }
    completed.current = true;
    onConfirm(when, showRepeat && allowRepeat ? recurrence : null);
  };

  return (
    <Modal
      testID="schedule-modal"
      transparent
      visible
      animationType="fade"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView style={styles.fill} behavior="padding" enabled={keyboardVisible}>
        <View
          style={[
            styles.backdrop,
            {
              paddingTop: insets.top + 12,
              paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 12),
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessible={false}
            testID="schedule-backdrop"
          />
          <View style={[styles.sheet, { backgroundColor: theme.color.background }]}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.color.label }]}>
                {title}
              </Text>
              <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
                Choose a date and time in your phone’s local time zone.
              </Text>
              <View style={styles.shortcuts}>
                {['In 1 hour', 'Tomorrow morning'].map((label, index) => (
                  <Pressable
                    key={label}
                    onPress={() => chooseShortcut(index === 1)}
                    accessibilityRole="button"
                    accessibilityHint={
                      index === 1
                        ? 'Set tomorrow at 09:00; confirm below'
                        : 'Fill date and time; confirm below'
                    }
                    style={[styles.choice, { backgroundColor: theme.color.secondaryBackground }]}
                  >
                    <Text style={[styles.buttonText, { color: theme.color.tint }]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextField
                label="Date (YYYY-MM-DD)"
                accessibilityLabel="Schedule date"
                value={date}
                onChangeText={(value) => {
                  setDate(value);
                  setError(null);
                }}
                maxLength={10}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <TextField
                label="Time (24-hour HH:MM)"
                accessibilityLabel="Schedule time"
                value={time}
                onChangeText={(value) => {
                  setTime(value);
                  setError(null);
                }}
                maxLength={5}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {showRepeat ? (
                <View style={styles.choices}>
                  <Text style={[styles.section, { color: theme.color.secondaryLabel }]}>
                    Repeat
                  </Text>
                  {CHOICES.filter((choice) => allowRepeat || choice.value === null).map(
                    (choice) => (
                      <Pressable
                        key={choice.label}
                        onPress={() => setRecurrence(choice.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: recurrence === choice.value }}
                        style={[
                          styles.choice,
                          {
                            backgroundColor:
                              recurrence === choice.value
                                ? theme.color.tint
                                : theme.color.secondaryBackground,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.buttonText,
                            {
                              color:
                                recurrence === choice.value
                                  ? readableTextOn(theme.color.tint)
                                  : theme.color.label,
                            },
                          ]}
                        >
                          {choice.label}
                        </Text>
                      </Pressable>
                    ),
                  )}
                </View>
              ) : null}
              <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
                {SCHEDULE_DELIVERY_TIMING_NOTE}
              </Text>
              {error ? (
                <Text
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  style={{ color: theme.color.destructive }}
                >
                  {error}
                </Text>
              ) : null}
              <Pressable
                onPress={confirm}
                accessibilityRole="button"
                style={[styles.action, { backgroundColor: theme.color.tint }]}
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: readableTextOn(theme.color.tint), fontWeight: '600' },
                  ]}
                >
                  {confirmLabel}
                </Text>
              </Pressable>
              <Pressable
                onPress={close}
                accessibilityRole="button"
                style={[styles.action, { backgroundColor: theme.color.secondaryBackground }]}
              >
                <Text style={[styles.buttonText, { color: theme.color.tint }]}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  sheet: { maxHeight: '100%', borderRadius: 18, overflow: 'hidden' },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  note: { fontSize: 13 },
  section: { fontSize: 14, fontWeight: '600' },
  choices: { gap: 8 },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { padding: 12, borderRadius: 12, minHeight: 44 },
  action: { padding: 14, minHeight: 48, borderRadius: 12, alignItems: 'center' },
  buttonText: { fontSize: 17 },
});
