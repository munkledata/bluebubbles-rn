import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessagePreview } from '@db/repositories';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import {
  activeMentionQuery,
  computeMentionRanges,
  type MentionPick,
  type MentionRange,
} from '@utils';
import { Icon } from '../primitives';
import { useTheme, withAlpha } from '../theme';
import { AttachmentTray, type PendingAttachment } from './AttachmentTray';
import { EffectPicker } from './effects';

interface ComposerProps {
  /** effectId set when sending with an iMessage send-effect (long-press send); subject is the
   *  optional Private-API iMessage subject line; mentions are @mention spans in the text. */
  onSend: (text: string, effectId?: string, subject?: string, mentions?: MentionRange[]) => void;
  /** Send photo/video/file attachments staged in the inline tray. */
  onSendAttachments?: (items: PendingAttachment[]) => void;
  /** Open the document picker (the tray's "Files" button); returns picked items to stage. */
  onPickFiles?: () => Promise<PendingAttachment[]>;
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
  /** A chat wallpaper is set → tint the composer translucent so the image shows through. */
  translucent?: boolean;
  /** Input placeholder; defaults to "iMessage". SMS screens pass "Text Message". */
  placeholder?: string;
  /** Show a Private-API subject-line field above the input (iMessage + setting on). */
  subjectEnabled?: boolean;
  /** Group participants for @mention autocomplete (empty/undefined → no mention picker). */
  mentionParticipants?: { address: string; name: string }[];
  /** Restore a persisted per-chat draft into an EMPTY composer (loads async after mount). */
  initialText?: string;
  /** Persist the draft (debounced while typing; '' immediately on send). */
  onDraftChange?: (text: string) => void;
}

/**
 * iOS message composer: optional reply/edit bar + attach button + input + send button.
 * Memoized: it re-renders on every keystroke from its own state, but the chat screen re-renders
 * on every reactive tick — the memo (with the screen's useCallback-stable props) keeps those
 * ticks from re-rendering the composer too.
 */
export const Composer = React.memo(function Composer({
  onSend,
  onSendAttachments,
  onPickFiles,
  replyTo,
  onCancelReply,
  editingText,
  onCancelEdit,
  onSchedule,
  onTyping,
  onStartVoice,
  translucent = false,
  placeholder = 'iMessage',
  subjectEnabled = false,
  mentionParticipants = [],
  initialText,
  onDraftChange,
}: ComposerProps): React.JSX.Element {
  const theme = useTheme();
  const sendWithReturn = useFeatureSettingsStore((s) => s.sendWithReturn);
  const insets = useSafeAreaInsets();
  // Over a wallpaper the composer bar disappears; the input pill + each control float as bubbles.
  const chip = withAlpha(theme.color.background, 0.62);
  const bubble = translucent ? [styles.ctrlBubble, { backgroundColor: chip }] : null;
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [effectOpen, setEffectOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // Picked @mentions (resolved to text spans at send time) + the current cursor for @-detection.
  const [mentions, setMentions] = useState<MentionPick[]>([]);
  const [cursor, setCursor] = useState(0);
  const trimmed = text.trim();
  const isEditing = editingText != null;
  const attachEnabled = !!onSendAttachments && !isEditing;
  const canSend = trimmed.length > 0 || pending.length > 0;

  // @mention autocomplete: the query being typed at the cursor and the participants it matches.
  const mentionQ =
    mentionParticipants.length > 0 && !isEditing ? activeMentionQuery(text, cursor) : null;
  const mentionMatches =
    mentionQ != null
      ? mentionParticipants
          .filter((p) => {
            const q = mentionQ.query.toLowerCase();
            return p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q);
          })
          .slice(0, 6)
      : [];

  // Replace the in-progress "@query" with "@Name " and record the mention for send-time resolution.
  const pickMention = (p: { address: string; name: string }): void => {
    if (!mentionQ) return;
    const label = `@${p.name}`;
    const before = text.slice(0, mentionQ.atIndex);
    const after = text.slice(cursor);
    const next = `${before}${label} ${after}`;
    setText(next);
    setMentions((m) => [...m, { address: p.address, label }]);
    setCursor(before.length + label.length + 1);
  };

  const addPending = (item: PendingAttachment): void =>
    setPending((cur) => (cur.some((p) => p.uri === item.uri) ? cur : [...cur, item]));
  const removePending = (uri: string): void =>
    setPending((cur) => cur.filter((p) => p.uri !== uri));
  const toggleTray = (): void =>
    setTrayOpen((open) => {
      if (!open) Keyboard.dismiss(); // the tray takes the keyboard's place
      return !open;
    });
  const handlePickFiles = (): void => {
    const p = onPickFiles?.();
    if (p) void p.then((items) => items.forEach(addPending));
  };

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
    queueDraft(value);
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

  // Prefill the input when an edit starts, stashing whatever draft it displaces so ending the edit
  // can put it back (otherwise editing a message silently discards the in-progress draft).
  const preEditRef = useRef('');
  useEffect(() => {
    if (editingText != null) {
      preEditRef.current = draftStateRef.current.text;
      setText(editingText);
    }
  }, [editingText]);

  // Restore a persisted draft — only into an EMPTY, non-editing composer (the draft loads async;
  // never clobber something the user already typed).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialText || isEditing) return;
    restoredRef.current = true;
    setText((cur) => cur || initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  // Draft persistence: debounced while typing; flushed on unmount so the last keystrokes aren't
  // lost when backing out of the chat. Editing an existing message never persists as a draft.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStateRef = useRef({ text: '', isEditing: false, onDraftChange });
  draftStateRef.current = { text, isEditing, onDraftChange };
  const queueDraft = (value: string): void => {
    if (!onDraftChange || isEditing) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(value), 500);
  };
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const s = draftStateRef.current;
      if (s.onDraftChange && !s.isEditing) s.onDraftChange(s.text);
    },
    [],
  );

  const submit = (effectId?: string): void => {
    const captured = trimmed;
    const capturedSubject = subject.trim();
    // Resolve mentions against the trimmed text that's actually sent, so the spans line up.
    const finalMentions = mentions.length > 0 ? computeMentionRanges(captured, mentions) : [];
    const atts = pending;
    if (!captured && atts.length === 0) return;
    // After a normal send the draft is consumed → empty. After an edit send the draft was never
    // consumed → put back whatever the edit displaced, so editing doesn't eat an in-progress draft.
    const postText = isEditing ? preEditRef.current : '';
    setText(postText);
    setSubject('');
    setMentions([]);
    setPending([]);
    setTrayOpen(false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    // Sent → the draft is consumed; clear it immediately (skip the debounce). Also sync the
    // unmount-flush ref NOW — setText lands async, so backing out right after sending would
    // otherwise re-persist the stale text from the ref.
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (!isEditing) onDraftChange?.('');
    draftStateRef.current = { ...draftStateRef.current, text: postText };
    emitTyping(false);
    if (atts.length > 0) onSendAttachments?.(atts);
    if (captured) {
      onSend(
        captured,
        effectId,
        capturedSubject || undefined,
        finalMentions.length > 0 ? finalMentions : undefined,
      );
    }
  };

  const cancelEdit = (): void => {
    // Restore whatever draft the edit displaced (not blank) so cancelling an edit keeps the draft.
    setText(preEditRef.current);
    draftStateRef.current = { ...draftStateRef.current, text: preEditRef.current };
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
          backgroundColor: translucent ? 'transparent' : theme.color.background,
          borderTopColor: translucent ? 'transparent' : theme.color.separator,
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
            <Icon name="close" size={18} color={theme.color.secondaryLabel} />
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
            <Icon name="close" size={18} color={theme.color.secondaryLabel} />
          </Pressable>
        </View>
      ) : null}

      {pending.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pendingRow}
          keyboardShouldPersistTaps="handled"
        >
          {pending.map((p) => (
            <View key={p.uri} style={styles.pendingItem}>
              {p.mimeType.startsWith('image/') ? (
                <Image source={{ uri: p.uri }} style={styles.pendingThumb} contentFit="cover" />
              ) : (
                <View
                  style={[
                    styles.pendingThumb,
                    styles.pendingFile,
                    { backgroundColor: theme.color.secondaryBackground },
                  ]}
                >
                  <Icon
                    name={p.mimeType.startsWith('video/') ? 'videocam-outline' : 'document-outline'}
                    size={22}
                    color={theme.color.secondaryLabel}
                  />
                </View>
              )}
              <Pressable
                onPress={() => removePending(p.uri)}
                hitSlop={6}
                style={styles.pendingRemove}
                accessibilityRole="button"
                accessibilityLabel="Remove attachment"
              >
                <Icon name="close-circle" size={20} color="#fff" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {subjectEnabled && !isEditing ? (
        <TextInput
          value={subject}
          onChangeText={setSubject}
          placeholder="Subject"
          placeholderTextColor={theme.color.tertiaryLabel}
          style={[
            styles.subjectInput,
            { color: theme.color.label, borderBottomColor: theme.color.separator },
          ]}
          accessibilityLabel="Subject line"
        />
      ) : null}
      {mentionMatches.length > 0 ? (
        <View style={[styles.mentionList, { backgroundColor: theme.color.secondaryBackground }]}>
          {mentionMatches.map((p) => (
            <Pressable
              key={p.address}
              onPress={() => pickMention(p)}
              style={[styles.mentionRow, { borderBottomColor: theme.color.separator }]}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${p.name}`}
            >
              <Text style={[styles.mentionName, { color: theme.color.label }]} numberOfLines={1}>
                {p.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        {attachEnabled ? (
          <Pressable
            onPress={toggleTray}
            hitSlop={8}
            style={styles.attach}
            accessibilityRole="button"
            accessibilityLabel={trayOpen ? 'Close attachments' : 'Attach photo or file'}
          >
            <View style={bubble}>
              <Icon name={trayOpen ? 'close' : 'add'} size={28} color={theme.color.tint} />
            </View>
          </Pressable>
        ) : null}
        <TextInput
          multiline
          value={text}
          onChangeText={onChangeText}
          // Track the caret so @mention autocomplete knows where the in-progress query is.
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.start)}
          onFocus={() => setTrayOpen(false)}
          // "Send with Return": Enter submits instead of inserting a newline.
          submitBehavior={sendWithReturn ? 'submit' : 'newline'}
          onSubmitEditing={sendWithReturn ? () => submit() : undefined}
          placeholder={placeholder}
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
            <View style={bubble}>
              <Icon name="calendar-outline" size={20} color={theme.color.tint} />
            </View>
          </Pressable>
        ) : null}
        {canSend ? (
          <Pressable
            onPress={() => submit()}
            onLongPress={!isEditing && trimmed ? () => setEffectOpen(true) : undefined}
            delayLongPress={250}
            style={[styles.send, { backgroundColor: theme.color.tint }]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint="Long-press to send with an effect"
          >
            <Icon name="arrow-up" size={20} color="#fff" />
          </Pressable>
        ) : null}
        {!canSend && !isEditing && onStartVoice ? (
          <Pressable
            onPress={onStartVoice}
            hitSlop={8}
            style={styles.micBtn}
            accessibilityRole="button"
            accessibilityLabel="Record voice message"
          >
            <View style={bubble}>
              <Icon name="mic-outline" size={22} color={theme.color.tint} />
            </View>
          </Pressable>
        ) : null}
      </View>
      {trayOpen ? <AttachmentTray onPick={addPending} onPickFiles={handlePickFiles} /> : null}
      <EffectPicker
        visible={effectOpen}
        onClose={() => setEffectOpen(false)}
        onPick={(effectId) => submit(effectId)}
      />
    </View>
  );
});

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
  schedule: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  subjectInput: {
    marginHorizontal: 14,
    marginBottom: 6,
    paddingVertical: 6,
    fontSize: 16,
    fontWeight: '600',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // @mention autocomplete list above the input.
  mentionList: { marginHorizontal: 10, marginBottom: 6, borderRadius: 12, overflow: 'hidden' },
  mentionRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mentionName: { fontSize: 16 },
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
  attach: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center' },
  micBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  // Frosted bubble behind a control when the composer floats over a wallpaper.
  ctrlBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 10 },
  pendingItem: { width: 60, height: 60 },
  pendingThumb: { width: 60, height: 60, borderRadius: 10 },
  pendingFile: { alignItems: 'center', justifyContent: 'center' },
  pendingRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 11,
  },
});
