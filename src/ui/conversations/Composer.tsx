import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
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
import { attachPasteListener } from '@/services/paste';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { showToast } from '../toast/toastStore';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible';
import { Icon } from '../primitives';
import { readableTextOn, useTheme, withAlpha } from '../theme';
import type { Recurrence } from '@core/schedule';
import {
  IMESSAGE_TEXT_STYLES,
  type IMessageTextFormattingRange,
  type IMessageTextStyle,
  type MessageMention,
} from '@core/api/endpoints/messages';
import type { MessagePreview } from '@db/repositories';
import { buildMessageSnippet } from '@utils';
import {
  MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES,
  isSupportedImessageAttachmentType,
} from '@core/models/serverInfo';
import { AttachmentTray, type PendingAttachment } from './AttachmentTray';
import { ScheduleSheet } from './ScheduleSheet';
import { EffectPicker } from './effects';
import {
  findMentionQuery,
  insertAuthoredMention,
  mentionsForTrimmedText,
  reconcileAuthoredMentions,
  type MentionParticipant,
  type MentionQuery,
} from './mentionAuthoring';
import {
  formattingForTrimmedText,
  reconcileAuthoredFormatting,
  selectionHasStyle,
  toggleAuthoredStyle,
  type TextSelection,
} from './formattedAuthoring';
import {
  useComposerAuthoringSession,
  type ComposerAdmissionResult,
  type ComposerAttachmentAdmission,
  type ComposerTextAttachmentAdmission,
  type ComposerTextAdmission,
} from './useComposerAuthoringSession';

interface ComposerProps {
  /** Send an ordinary text message. */
  onSend: (text: string) => ComposerTextAdmission;
  /** Send ordinary text with one allowlisted iMessage effect. Omit to hide the gesture. */
  onSendEffect?: (text: string, effectId: string) => ComposerTextAdmission;
  /** Send text with exact participant mention ranges through the dedicated group-only command. */
  onSendMention?: (text: string, mentions: MessageMention[]) => ComposerTextAdmission;
  /** Send selected text styles through the dedicated one-to-one formatted-message command. */
  onSendFormatted?: (
    text: string,
    textFormatting: IMessageTextFormattingRange[],
  ) => ComposerTextAdmission;
  /** Exact current group participants offered after the user types `@`. */
  mentionParticipants?: MentionParticipant[];
  /** Exact message-part-zero target for the narrow plain-text reply path. */
  replyTo?: MessagePreview | null;
  /** Cancel the selected reply target without clearing the authored draft. */
  onCancelReply?: () => void;
  /** When set, the composer edits this exact message text instead of sending a new message. */
  editingText?: string | null;
  /** Cancel edit mode and restore the ordinary chat draft. */
  onCancelEdit?: () => void;
  /** Send photo/video/file attachments staged in the inline tray. */
  onSendAttachments?: (items: PendingAttachment[]) => ComposerAttachmentAdmission;
  /** Send one staged attachment and body text under one optimistic/retry identity. */
  onSendTextAttachment?: (text: string, item: PendingAttachment) => ComposerTextAttachmentAdmission;
  /**
   * Synchronous all-or-none preflight for the logical jobs created by one submit. Returning false
   * leaves the authored text and attachments in place.
   */
  canSubmit?: (logicalSendCount: number) => boolean;
  /** Captured account owner must still be current before any submit consumes authored state. */
  isSubmitOwnerCurrent?: () => boolean;
  /** Open the document picker (the tray's "Files" button); returns picked items to stage. */
  onPickFiles?: () => Promise<PendingAttachment[]>;
  /** Persist external-handoff disposal before removing its only visible chip. */
  onRemoveAttachment?: (item: PendingAttachment) => void | boolean | Promise<void | boolean>;
  /** This chat's narrow iMessage path needs a real photo byte count before staging. */
  imessageImageOnly?: boolean;
  /** Pick a device contact and send it as a card (tray's "Contact" button). Provided only when the
   *  current RCS chat can send interactive attachments, so the button is capability-gated. */
  onPickContact?: () => void;
  /** Share one foreground-acquired current location (capability-gated by the chat screen). */
  onShareLocation?: () => void;
  /** When set, a 📅 button offers to schedule the typed text for a future time
   *  (recurrence: null/undefined = send once, else repeat daily/weekly/monthly). */
  /** Resolves false when the schedule was not saved, so the composer keeps the text. */
  onSchedule?: (
    text: string,
    scheduledFor: number,
    recurrence?: Recurrence | null,
  ) => Promise<boolean> | void;
  /** One server-owned file schedule; false leaves the draft and staged file untouched. */
  onScheduleAttachment?: (
    text: string,
    item: PendingAttachment,
    scheduledFor: number,
  ) => Promise<boolean>;
  /** Emit typing state to the server (debounced). */
  onTyping?: (isTyping: boolean) => void;
  /** Start a voice-memo recording (mic button shown when the input is empty). */
  onStartVoice?: () => void;
  /** A chat wallpaper is set → tint the composer translucent so the image shows through. */
  translucent?: boolean;
  /** Input placeholder; defaults to "iMessage". SMS screens pass "Text Message". */
  placeholder?: string;
  /** Restore a persisted per-chat draft into an EMPTY composer (loads async after mount). */
  initialText?: string;
  /** Persist the draft (debounced while typing; '' immediately on send). */
  onDraftChange?: (text: string) => void;
  /** Pre-stage attachments into the tray on mount (e.g. a photo shared INTO this chat via the
   *  Android Direct Share row). Seeded once; the user reviews + taps send. */
  initialAttachments?: PendingAttachment[];
  /** Whether this composer is the active chat surface (false while multi-select replaces it). */
  active?: boolean;
  /** Reports authored state that is NOT covered by the normal per-chat text draft. */
  onRemovalStateChange?: (state: ComposerRemovalState) => void;
  /** Reports which authored pieces obtained durable outgoing ownership. */
  onAdmissionApplied?: (result: ComposerAdmissionResult) => void;
}

const FORMAT_BUTTON_COPY: Record<
  IMessageTextStyle,
  { readonly label: string; readonly glyph: string }
> = {
  bold: { label: 'Bold', glyph: 'B' },
  italic: { label: 'Italic', glyph: 'I' },
  underline: { label: 'Underline', glyph: 'U' },
  strikethrough: { label: 'Strikethrough', glyph: 'S' },
};

export interface ComposerRemovalState {
  /** Edited text differs from the selected message and is not persisted as the chat draft. */
  hasUnsavedEdit?: boolean;
  /** Attachments are not part of the persisted body-text draft. */
  hasUnsavedDraftMetadata: boolean;
  /** Mention identity ranges are not part of the persisted plain-text draft. */
  hasUnsavedMentionMetadata?: boolean;
  /** Text-style ranges are not part of the persisted plain-text draft. */
  hasUnsavedFormattingMetadata?: boolean;
  /** The inline attachment chooser must consume Back before the chat route can be removed. */
  hasOpenAttachmentTray?: boolean;
  /** Closes the chooser without discarding any attachments that were already staged. */
  dismissAttachmentTray?: () => void;
}

function sameRemovalState(a: ComposerRemovalState, b: ComposerRemovalState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ComposerRemovalState>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Message composer: optional RCS attachment button + plain-text input + send button.
 * Memoized: it re-renders on every keystroke from its own state, but the chat screen re-renders
 * on every reactive tick — the memo (with the screen's useCallback-stable props) keeps those
 * ticks from re-rendering the composer too.
 */
export const Composer = React.memo(function Composer({
  onSend,
  onSendEffect,
  onSendMention,
  onSendFormatted,
  mentionParticipants,
  replyTo,
  onCancelReply,
  editingText,
  onCancelEdit,
  onSendAttachments,
  onSendTextAttachment,
  canSubmit,
  isSubmitOwnerCurrent,
  onPickFiles,
  onRemoveAttachment,
  imessageImageOnly,
  onPickContact,
  onShareLocation,
  onSchedule,
  onScheduleAttachment,
  onTyping,
  onStartVoice,
  translucent = false,
  placeholder = 'iMessage',
  initialText,
  onDraftChange,
  initialAttachments,
  active = true,
  onRemovalStateChange,
  onAdmissionApplied,
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
  const [trayOpen, setTrayOpen] = useState(false);
  // One opening owns an immutable draft snapshot; only its explicit confirmation can commit.
  const [pendingSchedule, setPendingSchedule] = useState<{
    text: string;
    draft: string;
    when: number;
    attachment?: PendingAttachment;
    owner: ComposerProps['isSubmitOwnerCurrent'];
    onSchedule: ComposerProps['onSchedule'];
    onScheduleAttachment: ComposerProps['onScheduleAttachment'];
  } | null>(null);
  const pendingScheduleRef = useRef(pendingSchedule);
  pendingScheduleRef.current = pendingSchedule;
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const scheduleSavingRef = useRef(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [effectPickerOpen, setEffectPickerOpen] = useState(false);
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const mentionsRef = useRef<MessageMention[]>([]);
  mentionsRef.current = mentions;
  const [textFormatting, setTextFormatting] = useState<IMessageTextFormattingRange[]>([]);
  const textFormattingRef = useRef<IMessageTextFormattingRange[]>([]);
  textFormattingRef.current = textFormatting;
  const preEditFormattingRef = useRef<IMessageTextFormattingRange[] | null>(null);
  const editingMentionsActiveRef = useRef(false);
  const preEditMentionsRef = useRef<MessageMention[] | null>(null);
  const editingFormattingActiveRef = useRef(editingText != null);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const mentionParticipantsAvailable = !!onSendMention && (mentionParticipants?.length ?? 0) >= 2;
  const mentionParticipantIdentity = JSON.stringify(
    (mentionParticipants ?? []).map(({ address, label }) => [address, label]),
  );
  const previousMentionParticipantIdentityRef = useRef(mentionParticipantIdentity);
  const mentionParticipantsAvailableRef = useRef(mentionParticipantsAvailable);
  mentionParticipantsAvailableRef.current = mentionParticipantsAvailable;
  const effectLongPressConsumed = useRef(false);
  const attachmentsEnabled = !!onSendAttachments;
  const trayEnabled = attachmentsEnabled || !!onPickContact || !!onShareLocation;
  const attachmentsEnabledRef = useRef(attachmentsEnabled);
  attachmentsEnabledRef.current = attachmentsEnabled;

  // A server capability can disappear while this screen stays mounted. Keep already-staged files
  // visible/removable (they are user-authored state), but close the picker tray. The authoring hook
  // treats them as non-sendable until support returns, so they do not create a dead Send button.
  useEffect(() => {
    if (trayEnabled) return;
    setTrayOpen(false);
  }, [trayEnabled]);
  useEffect(() => {
    if (onSendEffect && active && !editingText && !replyTo) return;
    setEffectPickerOpen(false);
  }, [active, editingText, onSendEffect, replyTo]);
  useEffect(() => {
    const editing = editingText != null;
    const wasEditing = editingFormattingActiveRef.current;
    editingFormattingActiveRef.current = editing;

    if (editing && !wasEditing) {
      // Edit mode temporarily replaces the ordinary draft text. Preserve its ranges separately so
      // edits cannot reconcile those ranges against a different message, then restore them with the
      // pre-edit text when edit mode ends.
      preEditFormattingRef.current = textFormattingRef.current.map((range) => ({
        ...range,
        styles: [...range.styles],
      }));
      textFormattingRef.current = [];
      setTextFormatting([]);
      return;
    }

    if (!editing && wasEditing) {
      const preserved = preEditFormattingRef.current;
      preEditFormattingRef.current = null;
      // A direct edit -> reply transition still withholds the formatted callback temporarily.
      // Restore into that unchanged ordinary draft as well; reply submission remains plain below.
      const restored = (onSendFormatted || replyTo) && preserved ? preserved : [];
      textFormattingRef.current = restored;
      setTextFormatting(restored);
      return;
    }

    // Reply mode keeps the ordinary draft text in place, so retain and continue reconciling its
    // ranges while the formatted callback is intentionally withheld. Outside a temporary
    // reply/edit mode, a missing callback is real authority loss and must discard the metadata.
    if (!onSendFormatted && !replyTo && !editing) {
      textFormattingRef.current = [];
      setTextFormatting([]);
    }
  }, [editingText, onSendFormatted, replyTo]);
  useEffect(() => {
    const participantIdentityChanged =
      previousMentionParticipantIdentityRef.current !== mentionParticipantIdentity;
    previousMentionParticipantIdentityRef.current = mentionParticipantIdentity;
    const editing = editingText != null;
    const wasEditing = editingMentionsActiveRef.current;
    editingMentionsActiveRef.current = editing;
    // Search, selection and focus changes hide suggestions without changing the saved draft.
    if (!active) setMentionQuery(null);
    const replaceMentions = (next: MessageMention[]): void => {
      mentionsRef.current = next;
      setMentions(next);
      setMentionQuery(null);
    };
    if (participantIdentityChanged) {
      // A participant change removes only the metadata. The visible words stay in the ordinary
      // saved draft, but stale participant identities can never ride a later send.
      preEditMentionsRef.current = null;
      replaceMentions([]);
      return;
    }
    if (editing && !wasEditing) {
      // Edit mode replaces the draft text. Keep its mentions to restore with it, as formatting is.
      preEditMentionsRef.current = mentionsRef.current;
      replaceMentions([]);
      return;
    }
    if (!editing && wasEditing) {
      const preserved = preEditMentionsRef.current;
      preEditMentionsRef.current = null;
      // An edit -> reply transition restores them too; the reply itself is sent as plain text.
      replaceMentions((mentionParticipantsAvailable || replyTo) && preserved ? preserved : []);
      return;
    }
    // Reply mode keeps the draft text in place, so its mentions stay and keep reconciling while
    // mention sending is withheld. Outside reply/edit, losing mention support drops them.
    if (!mentionParticipantsAvailable && !replyTo && !editing) replaceMentions([]);
  }, [active, editingText, mentionParticipantIdentity, mentionParticipantsAvailable, replyTo]);
  // Declared after the formatting and mention effects, so it sees what reply mode kept.
  const replyingRef = useRef(false);
  useEffect(() => {
    const replying = replyTo != null;
    const wasReplying = replyingRef.current;
    replyingRef.current = replying;
    // A reply carries neither, so say so before sending rather than dropping them silently.
    if (
      replying &&
      !wasReplying &&
      (textFormattingRef.current.length > 0 || mentionsRef.current.length > 0)
    ) {
      showToast('Replies are sent as plain text, without formatting or mentions');
    }
  }, [replyTo]);

  const addPending = (item: PendingAttachment): void => {
    // A native picker can resolve after capability loss and after its tray has unmounted. Read the
    // live ref rather than the callback's render-time prop before admitting that late result.
    if (
      !attachmentsEnabledRef.current ||
      mentionsRef.current.length > 0 ||
      textFormattingRef.current.length > 0 ||
      scheduleSavingRef.current
    ) {
      return;
    }
    setPending((cur) => (cur.some((p) => p.uri === item.uri) ? cur : [...cur, item]));
  };

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
    if (!active || !attachmentsEnabled || inputTag == null) return;
    return attachPasteListener(inputTag, ({ files, dropped }) => {
      if (scheduleSavingRef.current) return;
      if (mentionsRef.current.length > 0 || textFormattingRef.current.length > 0) {
        // Files can't go with a mention or formatted text. Say why instead of ignoring the paste.
        if (files.length > 0 || dropped > 0) {
          showToast('Remove mentions and formatting to attach files');
        }
        return;
      }
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
  }, [active, attachmentsEnabled, inputTag]);
  const removePending = (uri: string): void => {
    if (scheduleSavingRef.current) return;
    const item = pending.find((candidate) => candidate.uri === uri);
    if (!item || !onRemoveAttachment) {
      setPending((cur) => cur.filter((candidate) => candidate.uri !== uri));
      return;
    }
    try {
      const outcome = onRemoveAttachment(item);
      if (outcome != null && typeof (outcome as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(outcome).then(
          (removed) => {
            if (removed !== false && mountedRef.current) {
              setPending((cur) => cur.filter((candidate) => candidate.uri !== uri));
            }
          },
          () => {
            // Keep the chip: an external owner was not durably released.
          },
        );
      } else if (outcome !== false) {
        setPending((cur) => cur.filter((candidate) => candidate.uri !== uri));
      }
    } catch {
      // Keep the chip: an external owner was not durably released.
    }
  };
  const toggleTray = (): void => {
    if (scheduleSavingRef.current) return;
    setTrayOpen((open) => {
      if (!open) Keyboard.dismiss(); // the tray takes the keyboard's place
      return !open;
    });
  };
  const dismissAttachmentTray = useCallback((): void => setTrayOpen(false), []);
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
  useEffect(() => {
    if (!active) {
      setTrayOpen(false);
      inputRef.current?.blur();
      Keyboard.dismiss();
    }
  }, [active]);
  useEffect(() => {
    if (!active || !trayOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setTrayOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [active, trayOpen]);
  const handlePickFiles = (): void => {
    if (scheduleSavingRef.current) return;
    const p = onPickFiles?.();
    if (p) void p.then((items) => items.forEach(addPending));
  };

  const {
    text,
    trimmed,
    isEditing,
    canSend,
    submissionPending,
    onChangeText,
    submit: submitAuthored,
    cancelEdit,
  } = useComposerAuthoringSession({
    active,
    editingText,
    initialText,
    initialAttachments,
    pending,
    setPending,
    setTrayOpen,
    onSend,
    onSendAttachments,
    onSendTextAttachment,
    canSubmit,
    isSubmitOwnerCurrent,
    onCancelEdit,
    onDraftChange,
    onTyping,
    onAdmissionApplied,
  });
  useEffect(() => {
    if (!isEditing) return;
    setTrayOpen(false);
    setPendingSchedule(null);
  }, [isEditing]);
  const lastRemovalReportRef = useRef<{
    report: ComposerProps['onRemovalStateChange'];
    state: ComposerRemovalState;
  } | null>(null);
  useEffect(() => {
    const hasOpenAttachmentTray = active && trayOpen && !isEditing;
    const hasSuspendedFormattingMetadata = (preEditFormattingRef.current?.length ?? 0) > 0;
    const hasSuspendedMentionMetadata = (preEditMentionsRef.current?.length ?? 0) > 0;
    const state: ComposerRemovalState = {
      ...(isEditing ? { hasUnsavedEdit: text !== editingText } : {}),
      hasUnsavedDraftMetadata:
        pending.length > 0 ||
        mentions.length > 0 ||
        hasSuspendedMentionMetadata ||
        textFormatting.length > 0 ||
        hasSuspendedFormattingMetadata,
      ...(mentions.length > 0 || hasSuspendedMentionMetadata
        ? { hasUnsavedMentionMetadata: true }
        : {}),
      ...(textFormatting.length > 0 || hasSuspendedFormattingMetadata
        ? { hasUnsavedFormattingMetadata: true }
        : {}),
      hasOpenAttachmentTray,
      ...(hasOpenAttachmentTray ? { dismissAttachmentTray } : {}),
    };
    // The text changes on every keystroke, but the screen re-renders on every report. Report only
    // when the state itself changed (or to a new receiver).
    const last = lastRemovalReportRef.current;
    if (last && last.report === onRemovalStateChange && sameRemovalState(last.state, state)) {
      return;
    }
    lastRemovalReportRef.current = { report: onRemovalStateChange, state };
    onRemovalStateChange?.(state);
  }, [
    active,
    dismissAttachmentTray,
    editingText,
    isEditing,
    mentions.length,
    onRemovalStateChange,
    pending.length,
    text,
    textFormatting.length,
    trayOpen,
  ]);
  const currentTextRef = useRef(text);
  currentTextRef.current = text;
  const [selection, setSelection] = useState<TextSelection>({
    start: text.length,
    end: text.length,
  });
  const selectionRef = useRef<TextSelection>(selection);
  selectionRef.current = selection;
  const changeText = (next: string): void => {
    if (scheduleSavingRef.current) return;
    pendingScheduleRef.current = null;
    setPendingSchedule(null);
    const reconciled = reconcileAuthoredMentions(currentTextRef.current, next, mentionsRef.current);
    const formatted = reconcileAuthoredFormatting(
      currentTextRef.current,
      next,
      textFormattingRef.current,
    );
    mentionsRef.current = reconciled.mentions;
    setMentions(reconciled.mentions);
    textFormattingRef.current = formatted.textFormatting;
    setTextFormatting(formatted.textFormatting);
    const nextSelection = { start: reconciled.cursor, end: reconciled.cursor };
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    setMentionQuery(
      mentionParticipantsAvailableRef.current ? findMentionQuery(next, reconciled.cursor) : null,
    );
    onChangeText(next);
  };
  /** The draft's formatting and mentions go with it once a send consumes the draft. */
  const consumeMetadataOnAdmission = (admission: ComposerTextAdmission): ComposerTextAdmission => {
    const clearMetadata = (): void => {
      textFormattingRef.current = [];
      setTextFormatting([]);
      mentionsRef.current = [];
      setMentions([]);
    };
    if (
      admission != null &&
      typeof (admission as PromiseLike<void | boolean>).then === 'function'
    ) {
      return Promise.resolve(admission).then((accepted) => {
        if (accepted !== false) clearMetadata();
        return accepted;
      });
    }
    if (admission !== false) clearMetadata();
    return admission;
  };
  const submit = (): void => {
    if (scheduleSavingRef.current) return;
    if (!replyTo && !isEditing && textFormattingRef.current.length > 0) {
      const submitFormatted = onSendFormatted;
      const normalized = formattingForTrimmedText(
        currentTextRef.current,
        textFormattingRef.current,
      );
      if (!submitFormatted || !normalized) {
        showToast('That formatting changed. Select the text again before sending');
        return;
      }
      void submitAuthored((captured) => {
        return consumeMetadataOnAdmission(submitFormatted(captured, normalized));
      });
      return;
    }
    if (replyTo && (textFormattingRef.current.length > 0 || mentionsRef.current.length > 0)) {
      // Replies are plain text: formatted or mentioning replies are not an admitted operation.
      // Send through the plain reply callback, consume the metadata only when that reply is
      // admitted, and retain it on refusal.
      void submitAuthored((captured) => consumeMetadataOnAdmission(onSend(captured)));
      return;
    }
    if (mentionsRef.current.length === 0) {
      void submitAuthored();
      return;
    }
    const submitMention = onSendMention;
    const normalized = mentionsForTrimmedText(currentTextRef.current, mentionsRef.current);
    if (!submitMention || !normalized) {
      showToast('That mention changed. Choose the participant again before sending');
      return;
    }
    void submitAuthored((captured) => {
      const admission = submitMention(captured, normalized);
      if (
        admission != null &&
        typeof (admission as PromiseLike<void | boolean>).then === 'function'
      ) {
        return Promise.resolve(admission).then((accepted) => {
          if (accepted !== false) {
            mentionsRef.current = [];
            setMentions([]);
            setMentionQuery(null);
          }
          return accepted;
        });
      }
      if (admission !== false) {
        mentionsRef.current = [];
        setMentions([]);
        setMentionQuery(null);
      }
      return admission;
    });
  };
  const effectsAvailable =
    !!onSendEffect &&
    active &&
    !isEditing &&
    !replyTo &&
    pending.length === 0 &&
    mentions.length === 0 &&
    textFormatting.length === 0 &&
    !!trimmed &&
    !submissionPending &&
    !scheduleSaving;
  const openEffectPicker = (): void => {
    if (!effectsAvailable) return;
    effectLongPressConsumed.current = true;
    setEffectPickerOpen(true);
  };
  const attachEnabled =
    trayEnabled && !isEditing && mentions.length === 0 && textFormatting.length === 0;
  const formattingControlsVisible =
    !!onSendFormatted &&
    active &&
    !isEditing &&
    !replyTo &&
    pending.length === 0 &&
    mentions.length === 0 &&
    text.length > 0;
  const hasFormatSelection = selection.start !== selection.end;
  const toggleFormatting = (style: IMessageTextStyle): void => {
    if (!formattingControlsVisible || submissionPending || scheduleSaving) return;
    const next = toggleAuthoredStyle(
      currentTextRef.current,
      textFormattingRef.current,
      selectionRef.current,
      style,
    );
    if (!next) {
      showToast('Select complete text to format');
      return;
    }
    textFormattingRef.current = next;
    setTextFormatting(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({ selection: selectionRef.current });
    });
  };
  const matchingMentionParticipants = mentionQuery
    ? (mentionParticipants ?? [])
        .filter((participant) => {
          const query = mentionQuery.query.toLocaleLowerCase();
          return (
            participant.label.toLocaleLowerCase().includes(query) ||
            participant.address.toLocaleLowerCase().includes(query)
          );
        })
        .slice(0, 8)
    : [];
  const selectMention = (participant: MentionParticipant): void => {
    const query = mentionQuery;
    if (!query || !mentionParticipantsAvailableRef.current || submissionPending) return;
    const inserted = insertAuthoredMention(
      currentTextRef.current,
      mentionsRef.current,
      query,
      participant,
    );
    if (!inserted) return;
    mentionsRef.current = inserted.mentions;
    setMentions(inserted.mentions);
    setMentionQuery(null);
    const nextSelection = { start: inserted.cursor, end: inserted.cursor };
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    onChangeText(inserted.text);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({
        selection: { start: inserted.cursor, end: inserted.cursor },
      });
    });
  };
  const replySnippet = replyTo
    ? buildMessageSnippet({
        text: replyTo.text,
        subject: replyTo.subject,
        hasAttachments: replyTo.hasAttachments,
        hasVisibleAttachments: replyTo.hasVisibleAttachments,
        attachmentDescription: replyTo.attachmentDescription,
        balloonBundleId: replyTo.balloonBundleId,
        isRetracted: replyTo.isRetracted,
      }) || 'Message'
    : '';

  const scheduleAvailable =
    active &&
    !isEditing &&
    !replyTo &&
    !submissionPending &&
    !scheduleSaving &&
    mentions.length === 0 &&
    textFormatting.length === 0 &&
    ((pending.length === 0 && !!trimmed && !!onSchedule) ||
      (pending.length === 1 && !!onScheduleAttachment));
  const scheduleContext = useRef({
    scheduleAvailable,
    text,
    pending,
    onSchedule,
    onScheduleAttachment,
    isSubmitOwnerCurrent,
  });
  scheduleContext.current = {
    scheduleAvailable,
    text,
    pending,
    onSchedule,
    onScheduleAttachment,
    isSubmitOwnerCurrent,
  };
  if (
    pendingSchedule &&
    (!scheduleAvailable ||
      text !== pendingSchedule.draft ||
      isSubmitOwnerCurrent !== pendingSchedule.owner ||
      pendingSchedule.owner?.() === false ||
      (pendingSchedule.attachment
        ? pending.length !== 1 ||
          pending[0] !== pendingSchedule.attachment ||
          onScheduleAttachment !== pendingSchedule.onScheduleAttachment
        : pending.length !== 0 || onSchedule !== pendingSchedule.onSchedule) ||
      isSubmitOwnerCurrent?.() === false)
  ) {
    pendingScheduleRef.current = null;
    setPendingSchedule(null);
  }

  const pickSchedule = (): void => {
    const current = scheduleContext.current;
    if (
      !mountedRef.current ||
      !current.scheduleAvailable ||
      scheduleSavingRef.current ||
      pendingScheduleRef.current ||
      current.isSubmitOwnerCurrent?.() === false
    )
      return;
    const attachment = current.pending.length === 1 ? current.pending[0] : undefined;
    if (current.pending.length > 0) {
      if (!attachment || !current.onScheduleAttachment) return;
      if (
        !attachment.uri.startsWith('file://') ||
        !isSupportedImessageAttachmentType(attachment.mimeType, attachment.name) ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size <= 0 ||
        attachment.size > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES
      ) {
        showToast('Schedule one local JPEG, PNG, or PDF no larger than 512 KiB');
        return;
      }
    } else if (!current.text.trim() || !current.onSchedule) return;
    Keyboard.dismiss();
    const request = {
      text: current.text.trim(),
      draft: current.text,
      when: Math.ceil((Date.now() + 60_000) / 60_000) * 60_000,
      owner: current.isSubmitOwnerCurrent,
      onSchedule: current.onSchedule,
      onScheduleAttachment: current.onScheduleAttachment,
      ...(attachment ? { attachment } : {}),
    };
    pendingScheduleRef.current = request;
    setPendingSchedule(request);
  };

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
        <View
          testID="composer-edit-preview"
          style={[
            styles.replyBar,
            {
              borderLeftColor: theme.color.tint,
              backgroundColor: translucent ? chip : theme.color.secondaryBackground,
            },
          ]}
        >
          <View style={styles.replyText}>
            <Text style={[styles.replyWho, { color: theme.color.tint }]}>Editing message</Text>
          </View>
          <Pressable
            onPress={cancelEdit}
            disabled={submissionPending || scheduleSaving}
            hitSlop={8}
            style={styles.replyClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
          >
            <Icon name="close" size={18} color={theme.color.secondaryLabel} />
          </Pressable>
        </View>
      ) : null}
      {replyTo && !isEditing ? (
        <View
          testID="composer-reply-preview"
          style={[
            styles.replyBar,
            {
              borderLeftColor: theme.color.tint,
              backgroundColor: translucent ? chip : theme.color.secondaryBackground,
            },
          ]}
        >
          <View style={styles.replyText}>
            <Text style={[styles.replyWho, { color: theme.color.tint }]} numberOfLines={1}>
              Replying to {replyTo.isFromMe === 1 ? 'You' : replyTo.senderName || 'Unknown'}
            </Text>
            <Text
              style={[styles.replySnippet, { color: theme.color.secondaryLabel }]}
              numberOfLines={1}
            >
              {replySnippet}
            </Text>
          </View>
          <Pressable
            onPress={onCancelReply}
            disabled={submissionPending || scheduleSaving}
            hitSlop={8}
            style={styles.replyClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <Icon name="close" size={18} color={theme.color.secondaryLabel} />
          </Pressable>
        </View>
      ) : null}
      {pending.length > 0 && !isEditing ? (
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
                disabled={submissionPending || scheduleSaving}
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

      {mentionQuery && matchingMentionParticipants.length > 0 ? (
        <ScrollView
          testID="mention-suggestions"
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.mentionSuggestions}
        >
          {matchingMentionParticipants.map((participant) => (
            <Pressable
              key={participant.address}
              onPress={() => selectMention(participant)}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${participant.label}`}
              style={[
                styles.mentionSuggestion,
                { backgroundColor: theme.color.secondaryBackground },
              ]}
            >
              <Text style={[styles.mentionLabel, { color: theme.color.label }]} numberOfLines={1}>
                {participant.label}
              </Text>
              {participant.address !== participant.label ? (
                <Text
                  style={[styles.mentionAddress, { color: theme.color.secondaryLabel }]}
                  numberOfLines={1}
                >
                  {participant.address}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {formattingControlsVisible ? (
        <View testID="formatting-toolbar" style={styles.formattingToolbar}>
          {IMESSAGE_TEXT_STYLES.map((style) => {
            const selected = selectionHasStyle(textFormatting, selection, style);
            const copy = FORMAT_BUTTON_COPY[style];
            return (
              <Pressable
                key={style}
                testID={`format-${style}`}
                onPress={() => toggleFormatting(style)}
                disabled={!hasFormatSelection || submissionPending || scheduleSaving}
                accessibilityRole="button"
                accessibilityLabel={copy.label}
                accessibilityState={{
                  selected,
                  disabled: !hasFormatSelection || submissionPending || scheduleSaving,
                }}
                style={[
                  styles.formatButton,
                  {
                    backgroundColor: selected ? theme.color.tint : theme.color.secondaryBackground,
                    opacity: hasFormatSelection ? 1 : 0.45,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.formatButtonText,
                    {
                      color: selected ? readableTextOn(theme.color.tint) : theme.color.label,
                      fontWeight: style === 'bold' ? '700' : '500',
                      fontStyle: style === 'italic' ? 'italic' : 'normal',
                      textDecorationLine:
                        style === 'underline'
                          ? 'underline'
                          : style === 'strikethrough'
                            ? 'line-through'
                            : 'none',
                    },
                  ]}
                >
                  {copy.glyph}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.row}>
        {attachEnabled ? (
          <Pressable
            onPress={toggleTray}
            disabled={submissionPending || scheduleSaving}
            hitSlop={8}
            style={styles.attach}
            accessibilityRole="button"
            accessibilityLabel={trayOpen ? 'Close attachment options' : 'Open attachment options'}
          >
            <View style={bubble}>
              <Icon name={trayOpen ? 'close' : 'add'} size={28} color={theme.color.tint} />
            </View>
          </Pressable>
        ) : null}
        <TextInput
          ref={inputRef}
          editable={active && !submissionPending && !scheduleSaving}
          multiline
          value={text}
          onChangeText={changeText}
          onSelectionChange={(event) => {
            selectionRef.current = event.nativeEvent.selection;
            setSelection(event.nativeEvent.selection);
            setMentionQuery(
              mentionParticipantsAvailableRef.current
                ? findMentionQuery(text, event.nativeEvent.selection.start)
                : null,
            );
          }}
          // Registers the native paste listener once the view exists (see captureInputTag).
          onLayout={captureInputTag}
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
        {scheduleAvailable ? (
          <Pressable
            onPress={pickSchedule}
            disabled={submissionPending || scheduleSaving}
            hitSlop={8}
            style={styles.schedule}
            accessibilityRole="button"
            accessibilityLabel={pending.length > 0 ? 'Schedule attachment' : 'Schedule message'}
          >
            <View style={bubble}>
              <Icon name="calendar-outline" size={20} color={theme.color.tint} />
            </View>
          </Pressable>
        ) : null}
        {canSend ? (
          <Pressable
            onPressIn={() => {
              effectLongPressConsumed.current = false;
            }}
            onLongPress={effectsAvailable ? openEffectPicker : undefined}
            delayLongPress={400}
            onPress={() => {
              if (effectLongPressConsumed.current) {
                effectLongPressConsumed.current = false;
                return;
              }
              submit();
            }}
            disabled={submissionPending || scheduleSaving}
            style={[
              styles.send,
              {
                backgroundColor: theme.color.tint,
                opacity: submissionPending || scheduleSaving ? 0.55 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint={
              effectsAvailable ? 'Long press to choose an iMessage effect' : undefined
            }
            accessibilityState={{
              disabled: submissionPending || scheduleSaving,
              busy: submissionPending || scheduleSaving,
            }}
          >
            <Icon name="arrow-up" size={20} color={readableTextOn(theme.color.tint)} />
          </Pressable>
        ) : null}
        {!isEditing && !canSend && !submissionPending && !scheduleSaving && onStartVoice ? (
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
      {trayOpen && !isEditing && !submissionPending && !scheduleSaving ? (
        <AttachmentTray
          onPick={addPending}
          onPickFiles={handlePickFiles}
          mediaEnabled={attachmentsEnabled}
          imessageImageOnly={imessageImageOnly}
          onPickContact={
            onPickContact
              ? () => {
                  setTrayOpen(false);
                  onPickContact();
                }
              : undefined
          }
          onShareLocation={
            onShareLocation
              ? () => {
                  setTrayOpen(false);
                  onShareLocation();
                }
              : undefined
          }
        />
      ) : null}
      {pendingSchedule && scheduleAvailable ? (
        <ScheduleSheet
          initialWhen={pendingSchedule.when}
          title={pendingSchedule.attachment ? 'Schedule attachment' : 'Schedule message'}
          allowRepeat={!pendingSchedule.attachment}
          onClose={() => {
            pendingScheduleRef.current = null;
            setPendingSchedule(null);
          }}
          onConfirm={(when, recurrence) => {
            const sched = pendingSchedule;
            if (!mountedRef.current || pendingScheduleRef.current !== sched) return;
            pendingScheduleRef.current = null;
            setPendingSchedule(null);
            const current = scheduleContext.current;
            if (
              !mountedRef.current ||
              !current.scheduleAvailable ||
              scheduleSavingRef.current ||
              sched.owner?.() === false ||
              current.isSubmitOwnerCurrent !== sched.owner ||
              current.isSubmitOwnerCurrent?.() === false ||
              current.text !== sched.draft ||
              (sched.attachment
                ? current.pending.length !== 1 ||
                  current.pending[0] !== sched.attachment ||
                  current.onScheduleAttachment !== sched.onScheduleAttachment
                : current.pending.length !== 0 || current.onSchedule !== sched.onSchedule)
            )
              return;
            if (!Number.isFinite(when) || when <= Date.now()) {
              showToast('That time has passed; choose Schedule again');
              return;
            }
            if (sched.attachment) {
              if (recurrence !== null || !sched.onScheduleAttachment) return;
              scheduleSavingRef.current = true;
              setScheduleSaving(true);
              void sched
                .onScheduleAttachment(sched.text, sched.attachment, when)
                .then((accepted) => {
                  if (
                    !accepted ||
                    !mountedRef.current ||
                    sched.owner?.() === false ||
                    scheduleContext.current.isSubmitOwnerCurrent !== sched.owner ||
                    scheduleContext.current.onScheduleAttachment !== sched.onScheduleAttachment ||
                    scheduleContext.current.isSubmitOwnerCurrent?.() === false
                  )
                    return;
                  setPending((current) => current.filter((item) => item !== sched.attachment));
                  if (currentTextRef.current === sched.draft) onChangeText('');
                })
                .catch(() => {
                  // The screen owns the visible error; keep both authored pieces for inspection.
                })
                .finally(() => {
                  scheduleSavingRef.current = false;
                  if (mountedRef.current) setScheduleSaving(false);
                });
              return;
            }
            const submitSchedule = sched.onSchedule;
            if (!submitSchedule) return;
            scheduleSavingRef.current = true;
            setScheduleSaving(true);
            void Promise.resolve(submitSchedule(sched.text, when, recurrence))
              .then((accepted) => {
                if (
                  accepted === false ||
                  !mountedRef.current ||
                  sched.owner?.() === false ||
                  scheduleContext.current.isSubmitOwnerCurrent !== sched.owner ||
                  scheduleContext.current.onSchedule !== submitSchedule ||
                  scheduleContext.current.isSubmitOwnerCurrent?.() === false
                )
                  return;
                // Through the authoring session, so the saved draft is cleared as well.
                if (currentTextRef.current === sched.draft) onChangeText('');
              })
              .catch(() => {
                // The screen owns the visible error; keep the authored text for another try.
              })
              .finally(() => {
                scheduleSavingRef.current = false;
                if (mountedRef.current) setScheduleSaving(false);
              });
          }}
        />
      ) : null}
      <EffectPicker
        visible={effectPickerOpen}
        onClose={() => setEffectPickerOpen(false)}
        onPick={(effectId) => {
          const submitEffect = onSendEffect;
          if (!submitEffect || !effectsAvailable || scheduleSavingRef.current) return;
          void submitAuthored((captured) => submitEffect(captured, effectId));
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    marginBottom: 8,
    paddingVertical: 6,
    paddingLeft: 10,
    paddingRight: 6,
    borderLeftWidth: 2,
    borderRadius: 10,
  },
  replyText: { flex: 1 },
  replyWho: { fontSize: 12, fontWeight: '600' },
  replySnippet: { fontSize: 13, marginTop: 1 },
  replyClose: { padding: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, gap: 8 },
  schedule: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
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
  mentionSuggestions: { paddingHorizontal: 10, paddingBottom: 8, gap: 8 },
  mentionSuggestion: { minWidth: 120, maxWidth: 220, borderRadius: 12, padding: 10 },
  mentionLabel: { fontSize: 14, fontWeight: '600' },
  mentionAddress: { fontSize: 12, marginTop: 2 },
  formattingToolbar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  formatButton: {
    width: 44,
    height: 44,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formatButtonText: { fontSize: 16 },
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
