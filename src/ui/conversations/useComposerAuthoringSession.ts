import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return value != null && typeof (value as PromiseLike<T>).then === 'function';
}

interface ComposerAuthoringSessionOptions {
  active: boolean;
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
  onDraftChange?: (text: string) => void;
  onTyping?: (isTyping: boolean) => void;
  onRemovalStateChange?: (state: { hasUnsavedDraftMetadata: boolean }) => void;
}

/** Own the plain-text, attachment, typing, draft, and submit lifecycle for one composer. */
export function useComposerAuthoringSession({
  active,
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
  onDraftChange,
  onTyping,
  onRemovalStateChange,
}: ComposerAuthoringSessionOptions) {
  const [text, setText] = useState('');
  const [submissionPending, setSubmissionPending] = useState(false);
  const submissionPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const trimmed = text.trim();
  // Retain staged files across a temporary capability loss, but do not count them as sendable or
  // combine them with plain text until an attachment sender is available again.
  const attachmentsSendable = onSendAttachments != null;
  const canSend = trimmed.length > 0 || (attachmentsSendable && pending.length > 0);

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

  // Restore a persisted draft — only into an EMPTY composer (the draft loads async;
  // never clobber something the user already typed).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialText) return;
    restoredRef.current = true;
    setText((current) => current || initialText);
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
  // lost when backing out of the chat.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStateRef = useRef({ text: '', onDraftChange });
  // The unmount cleanup needs the latest committed render, not the values from its first closure.
  draftStateRef.current = { text, onDraftChange };

  // Body text already flushes to the per-chat DB draft below. Report only the authored pieces
  // that cannot be reconstructed after this component or route is removed.
  const hasUnsavedDraftMetadata = pending.length > 0;
  useEffect(() => {
    onRemovalStateChange?.({ hasUnsavedDraftMetadata });
  }, [hasUnsavedDraftMetadata, onRemovalStateChange]);
  const queueDraft = (value: string): void => {
    if (!onDraftChange) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(value), 500);
  };
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const state = draftStateRef.current;
      state.onDraftChange?.(state.text);
    },
    [],
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const submit = (): void => {
    if (submissionPendingRef.current) return;
    const captured = trimmed;
    const capturedAuthoredText = text;
    const attachments = attachmentsSendable ? pending : [];
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
    if (canSubmit && !canSubmit(logicalSendCount)) {
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
        const admission = onSend(captured);
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
        // Inputs are read-only during this short admission wait, which makes the captured value the
        // value being cleared here.
        const postText = '';
        if (mountedRef.current) {
          setText(postText);
        }
        if (typingTimer.current) clearTimeout(typingTimer.current);
        if (draftTimer.current) clearTimeout(draftTimer.current);
        onDraftChange?.('');
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

  return {
    text,
    setText,
    trimmed,
    canSend,
    submissionPending,
    onChangeText,
    submit,
  };
}
