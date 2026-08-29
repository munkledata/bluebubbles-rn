import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  activeMentionQuery,
  computeMentionRanges,
  type MentionPick,
  type MentionRange,
} from '@utils';
import { showToast } from '../toast/toastStore';
import type { PendingAttachment } from './AttachmentTray';

interface ComposerAuthoringSessionOptions {
  active: boolean;
  editingText?: string | null;
  initialText?: string;
  initialAttachments?: PendingAttachment[];
  mentionParticipants: { address: string; name: string }[];
  pending: PendingAttachment[];
  setPending: Dispatch<SetStateAction<PendingAttachment[]>>;
  setTrayOpen: Dispatch<SetStateAction<boolean>>;
  onSend: (text: string, effectId?: string, subject?: string, mentions?: MentionRange[]) => void;
  onSendAttachments?: (items: PendingAttachment[]) => void;
  canSubmit?: (logicalSendCount: number) => boolean;
  isSubmitOwnerCurrent?: () => boolean;
  onCancelEdit?: () => void;
  onDraftChange?: (text: string) => void;
  onTyping?: (isTyping: boolean) => void;
  onRemovalStateChange?: (state: {
    hasUnsavedEdit: boolean;
    hasUnsavedDraftMetadata: boolean;
  }) => void;
}

/** Own the authored text, typing, edit, draft, mention, and submit lifecycle for one composer. */
export function useComposerAuthoringSession({
  active,
  editingText,
  initialText,
  initialAttachments,
  mentionParticipants,
  pending,
  setPending,
  setTrayOpen,
  onSend,
  onSendAttachments,
  canSubmit,
  isSubmitOwnerCurrent,
  onCancelEdit,
  onDraftChange,
  onTyping,
  onRemovalStateChange,
}: ComposerAuthoringSessionOptions) {
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  // Picked @mentions (resolved to text spans at send time) + the current cursor for @-detection.
  const [mentions, setMentions] = useState<MentionPick[]>([]);
  const [cursor, setCursor] = useState(0);
  const trimmed = text.trim();
  const isEditing = editingText != null;
  const canSend = trimmed.length > 0 || (!isEditing && pending.length > 0);

  // @mention autocomplete: the query being typed at the cursor and the participants it matches.
  const mentionQ =
    mentionParticipants.length > 0 && !isEditing ? activeMentionQuery(text, cursor) : null;
  const mentionMatches =
    mentionQ != null
      ? mentionParticipants
          .filter((participant) => {
            const query = mentionQ.query.toLowerCase();
            return (
              participant.name.toLowerCase().includes(query) ||
              participant.address.toLowerCase().includes(query)
            );
          })
          .slice(0, 6)
      : [];

  // Replace the in-progress "@query" with "@Name " and record the mention for send-time resolution.
  const pickMention = (participant: { address: string; name: string }): void => {
    if (!mentionQ) return;
    const label = `@${participant.name}`;
    const before = text.slice(0, mentionQ.atIndex);
    const after = text.slice(cursor);
    const next = `${before}${label} ${after}`;
    setText(next);
    setMentions((current) => [...current, { address: participant.address, label }]);
    setCursor(before.length + label.length + 1);
  };

  // Debounced typing emit: start-typing on input, stop-typing after a pause / on send.
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);
  const emitTyping = (isActive: boolean): void => {
    if (isActive === typingActive.current) return;
    typingActive.current = isActive;
    onTyping?.(isActive);
  };
  useEffect(() => {
    if (active) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    emitTyping(false);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const editingActiveRef = useRef(false);
  useEffect(() => {
    if (editingText != null) {
      if (!editingActiveRef.current) preEditRef.current = draftStateRef.current.text;
      editingActiveRef.current = true;
      // Editing is an explicit prop-to-local-state transition; mirroring it here is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(editingText);
      return;
    }
    // Route-level Back can cancel edit mode by clearing the parent `editing` prop. Restore the
    // displaced draft here as well as in the visible Cancel handler so both paths are lossless.
    if (editingActiveRef.current) {
      editingActiveRef.current = false;
      setText(preEditRef.current);
      draftStateRef.current = { ...draftStateRef.current, text: preEditRef.current };
    }
  }, [editingText]);

  // Restore a persisted draft — only into an EMPTY, non-editing composer (the draft loads async;
  // never clobber something the user already typed).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialText || isEditing) return;
    restoredRef.current = true;
    setText((current) => current || initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  // Seed shared attachments (Direct Share INTO this chat) into the tray once, on mount, without
  // clobbering anything the user may already have staged. Also opens the tray so they're visible.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialAttachments || initialAttachments.length === 0) return;
    seededRef.current = true;
    setPending((current) => (current.length > 0 ? current : initialAttachments));
    setTrayOpen(true);
  }, [initialAttachments, setPending, setTrayOpen]);

  // Draft persistence: debounced while typing; flushed on unmount so the last keystrokes aren't
  // lost when backing out of the chat. Editing an existing message never persists as a draft.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStateRef = useRef({ text: '', isEditing: false, onDraftChange });
  // The unmount cleanup needs the latest committed render, not the values from its first closure.
  // eslint-disable-next-line react-hooks/immutability
  draftStateRef.current = { text, isEditing, onDraftChange };

  // Body text already flushes to the per-chat DB draft below. Report only the authored pieces
  // that cannot be reconstructed after this component or route is removed.
  const hasUnsavedEdit = isEditing && text !== editingText;
  const hasUnsavedDraftMetadata =
    subject.trim().length > 0 || pending.length > 0 || mentions.length > 0;
  useEffect(() => {
    onRemovalStateChange?.({ hasUnsavedEdit, hasUnsavedDraftMetadata });
  }, [hasUnsavedDraftMetadata, hasUnsavedEdit, onRemovalStateChange]);
  const queueDraft = (value: string): void => {
    if (!onDraftChange || isEditing) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(value), 500);
  };
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const state = draftStateRef.current;
      if (state.onDraftChange && !state.isEditing) state.onDraftChange(state.text);
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
    const attachments = isEditing ? [] : pending;
    if (!captured && attachments.length === 0) return;
    if (isSubmitOwnerCurrent && !isSubmitOwnerCurrent()) return;
    const logicalSendCount = (attachments.length > 0 ? 1 : 0) + (captured ? 1 : 0);
    if (!isEditing && canSubmit && !canSubmit(logicalSendCount)) {
      showToast('Too many messages are waiting—try again in a moment');
      return;
    }

    // Queue admission happens synchronously inside these callbacks. Start every job covered by the
    // all-or-none capacity preflight before clearing the only user-authored copy below.
    if (attachments.length > 0) onSendAttachments?.(attachments);
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
    // Keep an immediate unmount from restoring the just-consumed draft before React rerenders.
    // eslint-disable-next-line react-hooks/immutability
    draftStateRef.current = { ...draftStateRef.current, text: postText };
    emitTyping(false);
  };

  const cancelEdit = (): void => {
    // Restore whatever draft the edit displaced (not blank) so cancelling an edit keeps the draft.
    setText(preEditRef.current);
    // Keep an immediate unmount from flushing the edited message as the user's saved draft.
    // eslint-disable-next-line react-hooks/immutability
    draftStateRef.current = { ...draftStateRef.current, text: preEditRef.current };
    onCancelEdit?.();
  };

  return {
    text,
    setText,
    subject,
    setSubject,
    trimmed,
    isEditing,
    canSend,
    mentionMatches,
    pickMention,
    setCursor,
    onChangeText,
    submit,
    cancelEdit,
  };
}
