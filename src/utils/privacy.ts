/**
 * Pure redaction helpers for privacy ("redacted") mode. Generic placeholders (no
 * lorem-ipsum / fake names) — the goal is to hide content from a glance, not to
 * fabricate plausible text. Empty inputs stay empty so layout doesn't shift.
 */

/** Mask a conversation-list message preview. */
export function redactPreview(text: string, redacted: boolean): string {
  if (!redacted) return text;
  return text ? 'Message' : '';
}

/** Mask a contact / chat title (name). */
export function redactTitle(title: string, redacted: boolean): string {
  if (!redacted) return title;
  return title ? 'Contact' : '';
}

/** Mask a chat message body. Null stays empty. */
export function redactMessageText(text: string | null | undefined, redacted: boolean): string {
  if (!redacted) return text ?? '';
  return text ? 'Message' : '';
}
