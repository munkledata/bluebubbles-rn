import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { showToast } from '../toast/toastStore';
import type { PendingAttachment } from './AttachmentTray';

/** `undefined` preserves the historical synchronous callback contract and means "accepted". */
export type ComposerTextAdmission = void | boolean | Promise<void | boolean>;

/** One attachment and its body text share one durable queue admission. */
export type ComposerTextAttachmentAdmission = ComposerTextAdmission;

/**
 * Async attachment senders return the exact source URIs whose outgoing rows committed. A legacy
 * synchronous callback may still return `undefined`, which means the whole captured batch was
 * accepted. `false` means nothing was admitted and every chip must remain in the composer.
 */
export type ComposerAttachmentAdmission =
  void | false | readonly string[] | Promise<void | false | readonly string[]>;

export interface ComposerAdmissionResult {
  text: string;
  textAdmitted: boolean;
  attachmentUris: readonly string[];
  admittedAttachmentUris: readonly string[];
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return value != null && typeof (value as PromiseLike<T>).then === 'function';
}

interface ComposerAuthoringSessionOptions {
  active: boolean;
  editingText?: string | null;
  initialText?: string;
  initialAttachments?: PendingAttachment[];
  pending: PendingAttachment[];
  setPending: Dispatch<SetStateAction<PendingAttachment[]>>;
  setTrayOpen: Dispatch<SetStateAction<boolean>>;
  onSend: (text: string) => ComposerTextAdmission;
  onSendAttachments?: (items: PendingAttachment[]) => ComposerAttachmentAdmission;
  onSendTextAttachment?: (text: string, item: PendingAttachment) => ComposerTextAttachmentAdmission;
  canSubmit?: (logicalSendCount: number) => boolean;
  isSubmitOwnerCurrent?: () => boolean;
  onCancelEdit?: () => void;
  onDraftChange?: (text: string) => void;
  onTyping?: (isTyping: boolean) => void;
  onRemovalStateChange?: (state: {
    hasUnsavedEdit: boolean;
    hasUnsavedDraftMetadata: boolean;
  }) => void;
  /** Exact durable-admission result for an external handoff such as Android sharing. */
  onAdmissionApplied?: (result: ComposerAdmissionResult) => void;
}

/** Own the plain-text, edit, attachment, typing, draft, and submit lifecycle for one composer. */
export function useComposerAuthoringSession({
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
  onRemovalStateChange,
  onAdmissionApplied,
}: ComposerAuthoringSessionOptions) {
  const [text, setText] = useState('');
  const [submissionPending, setSubmissionPending] = useState(false);
  const submissionPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const trimmed = text.trim();
  const isEditing = editingText != null;
  // Retain staged files across a temporary capability loss, but do not count them as sendable.
  // A typed caption must not silently fall back to a separate text-only send while a chip remains.
  const attachmentsSendable = onSendAttachments != null;
  const canSend = isEditing
    ? trimmed.length > 0 && trimmed !== editingText?.trim()
    : trimmed.length > 0 || (attachmentsSendable && pending.length > 0);

  // Debounced typing emit: start-typing on input, stop-typing after a pause / on send.
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);
  const typingCallback = useRef(onTyping);
  useLayoutEffect(() => {
    if (typingCallback.current !== onTyping && typingActive.current) {
      // A chat or capability change must not leave the old conversation typing.
      typingCallback.current?.(false);
      typingActive.current = false;
    }
    typingCallback.current = onTyping;
  }, [onTyping]);
  const emitTyping = (isActive: boolean): void => {
    if (isActive && !typingCallback.current) return;
    if (isActive === typingActive.current) return;
    typingActive.current = isActive;
    typingCallback.current?.(isActive);
  };
  useEffect(() => {
    if (active) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    emitTyping(false);
  }, [active]);
  const onChangeText = (value: string): void => {
    setText(value);
    queueDraft(value);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (isEditing) {
      emitTyping(false);
      return;
    }
    if (value.length > 0) {
      emitTyping(true);
      typingTimer.current = setTimeout(() => emitTyping(false), 3000);
    } else {
      emitTyping(false);
    }
  };
  // Stop typing on unmount (leaving the chat).
  useEffect(() => () => emitTyping(false), []);

  // Restore a persisted draft — only into an EMPTY, non-editing composer (the draft loads async;
  // never clobber something the user already typed).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialText || isEditing) return;
    restoredRef.current = true;
    setText((current) => current || initialText);
  }, [initialText, isEditing]);

  // Seed shared attachments (Direct Share INTO this chat) into the tray once, on mount, without
  // clobbering anything the user may already have staged. Also opens the tray so they're visible.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialAttachments || initialAttachments.length === 0) return;
    seededRef.current = true;
    setPending((current) => {
      const seen = new Set(current.map((item) => item.uri));
      return [...current, ...initialAttachments.filter((item) => !seen.has(item.uri))];
    });
    setTrayOpen(true);
  }, [initialAttachments, setPending, setTrayOpen]);

  // Draft persistence: edits temporarily displace the ordinary chat draft but never overwrite it.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStateRef = useRef({ text: '', isEditing: false, onDraftChange });
  // The unmount cleanup needs the latest committed render, not the values from its first closure.
  draftStateRef.current = { text, isEditing, onDraftChange };

  const preEditRef = useRef('');
  const editingActiveRef = useRef(false);
  useEffect(() => {
    if (editingText != null) {
      if (!editingActiveRef.current) preEditRef.current = draftStateRef.current.text;
      editingActiveRef.current = true;
      // Entering edit mode deliberately replaces the local composer buffer with the exact
      // server-admitted message text. This prop transition is the state-machine boundary.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(editingText);
      emitTyping(false);
      return;
    }
    if (!editingActiveRef.current) return;
    editingActiveRef.current = false;
    setText(preEditRef.current);
    draftStateRef.current = {
      ...draftStateRef.current,
      text: preEditRef.current,
      isEditing: false,
    };
  }, [editingText]);

  // Body text already flushes to the per-chat DB draft below. Report only the authored pieces
  // that cannot be reconstructed after this component or route is removed.
  const hasUnsavedEdit = isEditing && text !== editingText;
  const hasUnsavedDraftMetadata = pending.length > 0;
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
      if (!state.isEditing) state.onDraftChange?.(state.text);
    },
    [],
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const submit = (textAdmissionOverride?: (text: string) => ComposerTextAdmission): void => {
    if (submissionPendingRef.current) return;
    const captured = trimmed;
    const capturedAuthoredText = text;
    if (!isEditing && pending.length > 0 && !attachmentsSendable) {
      showToast('Attachment sending is unavailable; remove the file to send text alone');
      return;
    }
    const attachments = isEditing ? [] : pending;
    if (!captured && attachments.length === 0) return;
    if (isSubmitOwnerCurrent && !isSubmitOwnerCurrent()) return;
    const isTextAttachment = !!captured && attachments.length > 0;
    if (isTextAttachment && attachments.length !== 1) {
      showToast('Send one attachment with its text at a time');
      return;
    }
    if (isTextAttachment && !onSendTextAttachment) {
      showToast('This server can’t send text and an attachment as one message');
      return;
    }
    const logicalSendCount = isTextAttachment
      ? 1
      : (attachments.length > 0 ? 1 : 0) + (captured ? 1 : 0);
    if (!isEditing && canSubmit && !canSubmit(logicalSendCount)) {
      showToast('Too many messages are waiting—try again in a moment');
      return;
    }

    // Capability discovery may be async. Keep the only authored copy until its DB row + outgoing
    // queue row commit. The ref closes the double-tap window before React can rerender.
    submissionPendingRef.current = true;
    setSubmissionPending(true);

    const normalizeAttachmentAdmission = (
      admitted: void | false | readonly string[],
    ): readonly string[] => {
      if (admitted === false) return [];
      if (admitted === undefined) return attachments.map((item) => item.uri);
      const capturedUris = new Set(attachments.map((item) => item.uri));
      return [...new Set(admitted)].filter((uri) => capturedUris.has(uri));
    };
    const admitAttachments = (): readonly string[] | Promise<readonly string[]> => {
      if (attachments.length === 0) return [];
      if (!onSendAttachments) return [];
      try {
        const admission = onSendAttachments(attachments);
        return isPromiseLike(admission)
          ? Promise.resolve(admission).then(normalizeAttachmentAdmission, () => [])
          : normalizeAttachmentAdmission(admission);
      } catch {
        return [];
      }
    };
    const normalizeTextAdmission = (admitted: void | boolean): boolean => admitted !== false;
    const admitTextAttachment = (): boolean | Promise<boolean> => {
      const attachment = attachments[0];
      if (!attachment || !captured || !onSendTextAttachment) return false;
      try {
        const admission = onSendTextAttachment(captured, attachment);
        return isPromiseLike(admission)
          ? Promise.resolve(admission).then(normalizeTextAdmission, () => false)
          : normalizeTextAdmission(admission);
      } catch {
        return false;
      }
    };
    const admitText = (): boolean | Promise<boolean> => {
      if (!captured) return false;
      try {
        const admission = (textAdmissionOverride ?? onSend)(captured);
        return isPromiseLike(admission)
          ? Promise.resolve(admission).then(normalizeTextAdmission, () => false)
          : normalizeTextAdmission(admission);
      } catch {
        return false;
      }
    };

    const applyAdmission = (
      admittedAttachmentUris: readonly string[],
      textAdmitted: boolean,
    ): void => {
      if (isSubmitOwnerCurrent && !isSubmitOwnerCurrent()) return;
      const admittedUris = new Set(admittedAttachmentUris);
      const everyAttachmentAdmitted =
        attachments.length === 0 || attachments.every((item) => admittedUris.has(item.uri));

      if (admittedUris.size > 0 && mountedRef.current) {
        setPending((current) => current.filter((item) => !admittedUris.has(item.uri)));
      }

      if (textAdmitted) {
        // An edit restores the ordinary draft it displaced; a new send consumes that draft.
        const postText = isEditing ? preEditRef.current : '';
        if (mountedRef.current) {
          setText(postText);
        }
        if (typingTimer.current) clearTimeout(typingTimer.current);
        if (draftTimer.current) clearTimeout(draftTimer.current);
        if (!isEditing) onDraftChange?.('');
        // Keep an immediate unmount from restoring the admitted text before React rerenders.
        draftStateRef.current = { ...draftStateRef.current, text: postText };
        emitTyping(false);
      } else if (capturedAuthoredText !== draftStateRef.current.text) {
        // A render may not have committed between the user's final keystroke and this submit.
        // Preserve the exact submitted copy for the unmount flush when admission failed.
        draftStateRef.current = { ...draftStateRef.current, text: capturedAuthoredText };
      }

      if (
        mountedRef.current &&
        everyAttachmentAdmitted &&
        (textAdmitted || attachments.length > 0)
      ) {
        setTrayOpen(false);
      }
      try {
        onAdmissionApplied?.({
          text: capturedAuthoredText,
          textAdmitted,
          attachmentUris: attachments.map((item) => item.uri),
          admittedAttachmentUris,
        });
      } catch {
        // Admission already committed. An optional observer must never roll authored UI back.
      }
    };
    const finishAdmission = (): void => {
      submissionPendingRef.current = false;
      if (mountedRef.current && (!isSubmitOwnerCurrent || isSubmitOwnerCurrent())) {
        setSubmissionPending(false);
      }
    };

    if (isTextAttachment) {
      const attachment = attachments[0]!;
      const admission = admitTextAttachment();
      const applyCombinedAdmission = (admitted: boolean): void => {
        applyAdmission(admitted ? [attachment.uri] : [], admitted);
      };
      if (!isPromiseLike(admission)) {
        try {
          applyCombinedAdmission(admission);
        } finally {
          finishAdmission();
        }
        return;
      }
      void Promise.resolve(admission)
        .then(applyCombinedAdmission)
        .finally(finishAdmission)
        .catch(() => undefined);
      return;
    }

    const attachmentAdmission = admitAttachments();
    const textAdmission = admitText();
    if (!isPromiseLike(attachmentAdmission) && !isPromiseLike(textAdmission)) {
      try {
        applyAdmission(attachmentAdmission, textAdmission);
      } finally {
        finishAdmission();
      }
      return;
    }

    void Promise.all([Promise.resolve(attachmentAdmission), Promise.resolve(textAdmission)])
      .then(([admittedAttachmentUris, textAdmitted]) => {
        applyAdmission(admittedAttachmentUris, textAdmitted);
      })
      .finally(finishAdmission)
      .catch(() => undefined);
  };

  const cancelEdit = (): void => {
    setText(preEditRef.current);
    draftStateRef.current = {
      ...draftStateRef.current,
      text: preEditRef.current,
      isEditing: false,
    };
    onCancelEdit?.();
  };

  return {
    text,
    setText,
    trimmed,
    isEditing,
    canSend,
    submissionPending,
    onChangeText,
    submit,
    cancelEdit,
  };
}
