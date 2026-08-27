import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  findNodeHandle,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessagePreview } from '@db/repositories';
import { attachPasteListener } from '@/services/paste';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { showToast } from '../toast/toastStore';
import {
  activeMentionQuery,
  computeMentionRanges,
  type MentionPick,
  type MentionRange,
} from '@utils';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible';
import { Icon } from '../primitives';
import { readableTextOn, useTheme, withAlpha } from '../theme';
import type { Recurrence } from '@core/schedule';
import { AttachmentTray, type PendingAttachment } from './AttachmentTray';
import { EffectPicker } from './effects';
import { RecurrenceSheet } from './RecurrenceSheet';

interface ComposerProps {
  /** effectId set when sending with an iMessage send-effect (long-press send); subject is the
   *  optional Private-API iMessage subject line; mentions are @mention spans in the text. */
  onSend: (text: string, effectId?: string, subject?: string, mentions?: MentionRange[]) => void;
  /** Send photo/video/file attachments staged in the inline tray. */
  onSendAttachments?: (items: PendingAttachment[]) => void;
  /**
   * Synchronous all-or-none preflight for the logical jobs created by one submit. Returning false
   * leaves the authored text and attachments in place.
   */
  canSubmit?: (logicalSendCount: number) => boolean;
  /** Captured account owner must still be current before any submit consumes authored state. */
  isSubmitOwnerCurrent?: () => boolean;
  /** Open the document picker (the tray's "Files" button); returns picked items to stage. */
  onPickFiles?: () => Promise<PendingAttachment[]>;
  /** Pick a device contact and send it as a card (tray's "Contact" button). Provided only when the
   *  server can build vCards (`supports_send_contact`), so the button is capability-gated. */
  onPickContact?: () => void;
  replyTo?: MessagePreview | null;
  onCancelReply?: () => void;
  /** When set, the composer edits this text instead of sending a new message. */
  editingText?: string | null;
  onCancelEdit?: () => void;
  /** When set, a 📅 button offers to schedule the typed text for a future time
   *  (recurrence: null/undefined = send once, else repeat daily/weekly/monthly). */
  onSchedule?: (text: string, scheduledFor: number, recurrence?: Recurrence | null) => void;
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
  /** Pre-stage attachments into the tray on mount (e.g. a photo shared INTO this chat via the
   *  Android Direct Share row). Seeded once; the user reviews + taps send. */
  initialAttachments?: PendingAttachment[];
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
  canSubmit,
  isSubmitOwnerCurrent,
  onPickFiles,
  onPickContact,
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
  initialAttachments,
}: ComposerProps): React.JSX.Element {
  const theme = useTheme();
  const sendWithReturn = useFeatureSettingsStore((s) => s.sendWithReturn);
  const insets = useSafeAreaInsets();
  // Drives the bottom safe-area reservation below (see the `paddingBottom` comment) and enforces
  // the tray/keyboard exclusion — NOT a keyboard-avoidance mechanism (the screen's KAV owns that).
  const kbVisible = useKeyboardVisible();
  // Over a wallpaper the composer bar disappears; the input pill + each control float as bubbles.
  const chip = withAlpha(theme.color.background, 0.62);
  const bubble = translucent ? [styles.ctrlBubble, { backgroundColor: chip }] : null;
  // Over a wallpaper the composer bar is transparent, so the reply/edit preview would sit straight
  // on the image — back it with the same frosted chip the controls use.
  const replyBarBg = translucent ? [styles.replyBarBubble, { backgroundColor: chip }] : null;
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [effectOpen, setEffectOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  // Set once the date+time pickers resolve; the RecurrenceSheet (step 3) commits or cancels it.
  const [pendingSchedule, setPendingSchedule] = useState<{ text: string; when: number } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // Picked @mentions (resolved to text spans at send time) + the current cursor for @-detection.
  const [mentions, setMentions] = useState<MentionPick[]>([]);
  const [cursor, setCursor] = useState(0);
  const trimmed = text.trim();
  const isEditing = editingText != null;
  const attachEnabled = !!onSendAttachments && !isEditing;
  const canSend = trimmed.length > 0 || (!isEditing && pending.length > 0);

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

  /**
   * Pasted pictures/files (long-press Paste, a keyboard image/GIF/sticker commit, or a drop).
   *
   * The tag is captured from `onLayout` rather than a mount effect: the native lookup resolves
   * through the UIManager's mounting layer, so asking before the Fabric mount has landed on the
   * UI thread simply finds nothing and the listener is never registered.
   */
  const inputRef = useRef<TextInput | null>(null);
  const [inputTag, setInputTag] = useState<number | null>(null);
  const captureInputTag = useCallback((): void => {
    const tag = findNodeHandle(inputRef.current);
    if (typeof tag === 'number') setInputTag((cur) => (cur === tag ? cur : tag));
  }, []);

  useEffect(() => {
    if (inputTag == null) return;
    return attachPasteListener(inputTag, ({ files, dropped }) => {
      // Only `setPending` (stable) is used here, so the listener never needs re-attaching when
      // the composer re-renders — which would otherwise churn the native registration on every
      // keystroke.
      if (files.length > 0) {
        setPending((cur) => {
          const fresh = files.filter((f) => !cur.some((p) => p.uri === f.uri));
          return fresh.length > 0 ? [...cur, ...fresh] : cur;
        });
      }
      // Silence would read as "paste is broken" — say so when nothing could be staged.
      if (files.length === 0 && dropped > 0) showToast("Couldn't read that pasted file");
    });
  }, [inputTag]);
  const removePending = (uri: string): void =>
    setPending((cur) => cur.filter((p) => p.uri !== uri));
  const toggleTray = (): void =>
    setTrayOpen((open) => {
      if (!open) Keyboard.dismiss(); // the tray takes the keyboard's place
      return !open;
    });
  // The tray and the keyboard are meant to be mutually exclusive — the tray occupies the keyboard's
  // slot (fixed 104dp BELOW the input row), so both on screen at once stacks a second keyboard's
  // worth of chrome under the composer. `toggleTray` (dismiss on open) and `onFocus` (close on
  // focus) cover it from the tray's side, but they miss one path: Android's Back closes the IME
  // WITHOUT blurring the input, so tapping the still-focused field reopens the keyboard and fires
  // NO onFocus. Enforce the invariant from the keyboard's side too. Keyed on the kbVisible
  // transition (not on trayOpen), so opening the tray while the keyboard is still on its way down
  // isn't immediately undone.
  useEffect(() => {
    if (kbVisible) setTrayOpen(false);
  }, [kbVisible]);
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

  // Seed shared attachments (Direct Share INTO this chat) into the tray once, on mount, without
  // clobbering anything the user may already have staged. Also opens the tray so they're visible.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialAttachments || initialAttachments.length === 0) return;
    seededRef.current = true;
    setPending((cur) => (cur.length > 0 ? cur : initialAttachments));
    setTrayOpen(true);
  }, [initialAttachments]);

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
    // Attachments staged before an edit belong to the draft, not to the edited message. Keep them
    // untouched until edit mode ends instead of sending or discarding them with the edit.
    const atts = isEditing ? [] : pending;
    if (!captured && atts.length === 0) return;
    if (isSubmitOwnerCurrent && !isSubmitOwnerCurrent()) return;
    const logicalSendCount = (atts.length > 0 ? 1 : 0) + (captured ? 1 : 0);
    if (!isEditing && canSubmit && !canSubmit(logicalSendCount)) {
      showToast('Too many messages are waiting—try again in a moment');
      return;
    }

    // Queue admission happens synchronously inside these callbacks. Start every job covered by the
    // all-or-none capacity preflight before clearing the only user-authored copy below.
    if (atts.length > 0) onSendAttachments?.(atts);
    if (captured) {
      onSend(
        captured,
        effectId,
        capturedSubject || undefined,
        finalMentions.length > 0 ? finalMentions : undefined,
      );
    }

    // After a normal send the draft is consumed → empty. After an edit send the draft was never
    // consumed → put back whatever the edit displaced, so editing doesn't eat an in-progress draft.
    const postText = isEditing ? preEditRef.current : '';
    setText(postText);
    setSubject('');
    setMentions([]);
    if (!isEditing) setPending([]);
    setTrayOpen(false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    // Sent → the draft is consumed; clear it immediately (skip the debounce). Also sync the
    // unmount-flush ref NOW — setText lands async, so backing out right after sending would
    // otherwise re-persist the stale text from the ref.
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (!isEditing) onDraftChange?.('');
    draftStateRef.current = { ...draftStateRef.current, text: postText };
    emitTyping(false);
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
            // Step 3: pick a recurrence (or Send once) before committing the schedule.
            setPendingSchedule({ text: captured, when });
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
    ? replyTo.text ||
      // Genmoji: prefer its natural-language description over the generic attachment label. The
      // reply bar shows the exact text or description from the message the user selected.
      (replyTo.hasAttachments === 1 ? replyTo.attachmentDescription?.trim() || '📎 Attachment' : '')
    : '';

  return (
    <View
      // The bottom-inset rule below is device-only in effect but node-testable through this handle
      // (composerKeyboardInset.test.tsx) — it regressed once and is easy to "tidy" back.
      testID="composer-bar"
      style={[
        styles.wrap,
        {
          // THE BOTTOM INSET IS A UNION, NOT A SUM — this is what put an empty band between the
          // composer and the keyboard. `insets.bottom` is the NAVIGATION-BAR inset
          // (safe-area-context asks for statusBars|displayCutout|navigationBars|captionBar — never
          // `ime()`), so it does not shrink when the keyboard opens. But the keyboard COVERS the
          // nav bar: Android's IME inset is measured from the window bottom and already spans that
          // strip (RN's own ReactRootView subtracts `barInsets.bottom` back out of `imeInsets`).
          // Reserving it again on top of whatever lifted the bar is a double count, and it shows up
          // as `insets.bottom` of dead space above the keyboard — the taller the nav bar, the worse
          // (~32dp gesture, ~56dp 3-button). Android's own rule for this is max(ime, navBar), which
          // is what `kbVisible ? 0 : insets.bottom` expresses. The trailing 8 is the breathing room
          // under the input pill, kept in BOTH states so the bar looks the same either way.
          //
          // This replaced a fragile pair of opposing hacks: the screen's KAV used to pass
          // `keyboardVerticalOffset={-insets.bottom}` purely to cancel the reservation made here.
          // That only balances while the KAV is actually doing the lifting — its padding term is
          // clamped at `Math.max(…, 0)` and this one was not, so the moment the KAV contributed 0
          // (the window itself resizing for the IME) the cancellation vanished and the full
          // nav-bar-sized band appeared. Both offsets are now gone; see chat/[guid].tsx.
          paddingBottom: (kbVisible ? 0 : insets.bottom) + 8,
          backgroundColor: translucent ? 'transparent' : theme.color.background,
          borderTopColor: translucent ? 'transparent' : theme.color.separator,
        },
      ]}
    >
      {isEditing ? (
        <View style={[styles.replyBar, { borderLeftColor: theme.color.tint }, replyBarBg]}>
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
        <View style={[styles.replyBar, { borderLeftColor: theme.color.tint }, replyBarBg]}>
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
              {/* Guarded: a shared file can arrive with a null mimeType despite the type
                  saying otherwise — an unguarded `.startsWith` crashes the render. */}
              {(p.mimeType ?? '').startsWith('image/') ? (
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
                    name={
                      (p.mimeType ?? '').startsWith('video/')
                        ? 'videocam-outline'
                        : 'document-outline'
                    }
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
          ref={inputRef}
          multiline
          value={text}
          onChangeText={onChangeText}
          // Registers the native paste listener once the view exists (see captureInputTag).
          onLayout={captureInputTag}
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
            <Icon name="arrow-up" size={20} color={readableTextOn(theme.color.tint)} />
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
      {trayOpen ? (
        <AttachmentTray
          onPick={addPending}
          onPickFiles={handlePickFiles}
          onPickContact={
            onPickContact
              ? () => {
                  setTrayOpen(false);
                  onPickContact();
                }
              : undefined
          }
        />
      ) : null}
      <EffectPicker
        visible={effectOpen}
        onClose={() => setEffectOpen(false)}
        onPick={(effectId) => submit(effectId)}
      />
      <RecurrenceSheet
        visible={pendingSchedule != null}
        onClose={() => setPendingSchedule(null)} /* cancel keeps the typed text */
        onPick={(recurrence) => {
          const sched = pendingSchedule;
          setPendingSchedule(null);
          if (!sched || !onSchedule) return;
          setText('');
          onSchedule(sched.text, sched.when, recurrence);
        }}
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
  // Frosted pill behind the reply/edit bar when the composer floats over a wallpaper.
  replyBarBubble: { borderRadius: 10, overflow: 'hidden', paddingVertical: 4 },
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
