import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessagePreview } from '@db/repositories';
import { useTheme } from '../theme';
import { EffectPicker } from './effects';

interface ComposerProps {
  /** effectId set when sending with an iMessage send-effect (long-press send). */
  onSend: (text: string, effectId?: string) => void;
  onAttach?: () => void;
  replyTo?: MessagePreview | null;
  onCancelReply?: () => void;
  /** When set, the composer edits this text instead of sending a new message. */
  editingText?: string | null;
  onCancelEdit?: () => void;
  /** When set, a 📅 button offers to schedule the typed text for a future time. */
  onSchedule?: (text: string, scheduledFor: number) => void;
  /** Emit typing state to the server (debounced). */
  onTyping?: (isTyping: boolean) => void;
  /** Start a voice-memo recording (mic button shown when the input is empty). */
  onStartVoice?: () => void;
}

/** iOS message composer: optional reply/edit bar + attach button + input + send button. */
export function Composer({
  onSend,
  onAttach,
  replyTo,
  onCancelReply,
  editingText,
  onCancelEdit,
  onSchedule,
  onTyping,
  onStartVoice,
}: ComposerProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [effectOpen, setEffectOpen] = useState(false);
  const trimmed = text.trim();
  const isEditing = editingText != null;

  // Debounced typing emit: start-typing on input, stop-typing after a pause / on send.
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);
  const emitTyping = (active: boolean): void => {
    if (active === typingActive.current) return;
    typingActive.current = active;
    onTyping?.(active);
  };
  const onChangeText = (value: string): void => {
    setText(value);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.length > 0) {
      emitTyping(true);
      typingTimer.current = setTimeout(() => emitTyping(false), 3000);
    } else {
      emitTyping(false);
    }
  };
  // Stop typing on unmount (leaving the chat).
  useEffect(() => () => emitTyping(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefill the input when an edit starts.
  useEffect(() => {
    if (editingText != null) setText(editingText);
  }, [editingText]);

  const submit = (effectId?: string): void => {
    if (!trimmed) return;
    const captured = trimmed;
    setText('');
    if (typingTimer.current) clearTimeout(typingTimer.current);
    emitTyping(false);
    onSend(captured, effectId);
  };

  const cancelEdit = (): void => {
    setText('');
    onCancelEdit?.();
  };

  // Two-step native pickers (date → time); cancelling either aborts scheduling.
  const pickSchedule = (): void => {
    if (!trimmed || !onSchedule) return;
    const captured = trimmed;
    const now = new Date();
    DateTimePickerAndroid.open({
      value: now,
      mode: 'date',
      minimumDate: now,
      onChange: (_e, date) => {
        if (!date) return;
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: false,
          onChange: (_e2, time) => {
            if (!time) return;
            const when = new Date(
              date.getFullYear(),
              date.getMonth(),
              date.getDate(),
              time.getHours(),
              time.getMinutes(),
              0,
              0,
            ).getTime();
            // `when` is floored to the minute; reject only minutes that have fully
            // passed (so picking the current minute is allowed — it fires next tick).
            const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
            if (when < currentMinute) return;
            setText('');
            onSchedule(captured, when);
          },
        });
      },
    });
  };

  const replyWho = replyTo
    ? replyTo.isFromMe === 1
      ? 'You'
      : (replyTo.senderName ?? 'Unknown')
    : '';
  const replySnippet = replyTo
    ? replyTo.text || (replyTo.hasAttachments === 1 ? '📎 Attachment' : '')
    : '';

  return (
    <View
      style={[
        styles.wrap,
        {
          paddingBottom: insets.bottom + 8,
          backgroundColor: theme.color.background,
          borderTopColor: theme.color.separator,
        },
      ]}
    >
      {isEditing ? (
        <View style={[styles.replyBar, { borderLeftColor: theme.color.tint }]}>
          <View style={styles.replyText}>
            <Text style={[styles.replyWho, { color: theme.color.secondaryLabel }]}>
              Editing message
            </Text>
          </View>
          <Pressable
            onPress={cancelEdit}
            hitSlop={10}
            style={styles.replyClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
          >
            <Text style={[styles.replyCloseText, { color: theme.color.secondaryLabel }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {replyTo && !isEditing ? (
        <View style={[styles.replyBar, { borderLeftColor: theme.color.tint }]}>
          <View style={styles.replyText}>
            <Text style={[styles.replyWho, { color: theme.color.secondaryLabel }]}>
              Replying to {replyWho}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.replySnippet, { color: theme.color.tertiaryLabel }]}
            >
              {replySnippet}
            </Text>
          </View>
          <Pressable
            onPress={onCancelReply}
            hitSlop={10}
            style={styles.replyClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <Text style={[styles.replyCloseText, { color: theme.color.secondaryLabel }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.row}>
        {onAttach ? (
          <Pressable
            onPress={onAttach}
            hitSlop={8}
            style={styles.attach}
            accessibilityRole="button"
            accessibilityLabel="Attach photo or file"
          >
            <Text style={[styles.plus, { color: theme.color.tint }]}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          multiline
          value={text}
          onChangeText={onChangeText}
          placeholder="iMessage"
          placeholderTextColor={theme.color.tertiaryLabel}
          style={[
            styles.input,
            {
              color: theme.color.label,
              borderColor: theme.color.separator,
              backgroundColor: theme.color.secondaryBackground,
            },
          ]}
        />
        {trimmed && onSchedule && !isEditing ? (
          <Pressable
            onPress={pickSchedule}
            hitSlop={8}
            style={styles.schedule}
            accessibilityRole="button"
            accessibilityLabel="Schedule message"
          >
            <Text style={styles.scheduleIcon}>🗓️</Text>
          </Pressable>
        ) : null}
        {trimmed ? (
          <Pressable
            onPress={() => submit()}
            onLongPress={isEditing ? undefined : () => setEffectOpen(true)}
            delayLongPress={250}
            style={[styles.send, { backgroundColor: theme.color.tint }]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint="Long-press to send with an effect"
          >
            <Text style={styles.arrow}>↑</Text>
          </Pressable>
        ) : null}
        {!trimmed && !isEditing && onStartVoice ? (
          <Pressable
            onPress={onStartVoice}
            hitSlop={8}
            style={styles.micBtn}
            accessibilityRole="button"
            accessibilityLabel="Record voice message"
          >
            <Text style={styles.mic}>🎤</Text>
          </Pressable>
        ) : null}
      </View>
      <EffectPicker
        visible={effectOpen}
        onClose={() => setEffectOpen(false)}
        onPick={(effectId) => submit(effectId)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, gap: 8 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    marginBottom: 8,
    paddingLeft: 8,
    borderLeftWidth: 2,
  },
  replyText: { flex: 1 },
  replyWho: { fontSize: 12, fontWeight: '600' },
  replySnippet: { fontSize: 13, marginTop: 1 },
  replyClose: { padding: 4 },
  replyCloseText: { fontSize: 15, fontWeight: '600' },
  schedule: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  scheduleIcon: { fontSize: 20 },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 19,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 16,
  },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  arrow: { color: '#fff', fontSize: 20, fontWeight: '800', lineHeight: 22 },
  attach: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center' },
  plus: { fontSize: 30, fontWeight: '400', lineHeight: 34 },
  micBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  mic: { fontSize: 22 },
});
