import type { MessageMention } from '@core/api/endpoints/messages';

export interface MentionParticipant {
  address: string;
  label: string;
}

export interface MentionQuery {
  /** Inclusive UTF-16 offset of the leading `@`. */
  start: number;
  /** Exclusive UTF-16 cursor offset. */
  end: number;
  query: string;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Carry untouched mention ranges through one TextInput edit. Any edit that intersects a tagged
 * label deliberately turns that label back into ordinary text instead of guessing its identity.
 */
export function reconcileAuthoredMentions(
  previousText: string,
  nextText: string,
  mentions: readonly MessageMention[],
): { mentions: MessageMention[]; cursor: number } {
  let prefix = 0;
  while (
    prefix < previousText.length &&
    prefix < nextText.length &&
    previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previousText.length - prefix &&
    suffix < nextText.length - prefix &&
    previousText.charCodeAt(previousText.length - 1 - suffix) ===
      nextText.charCodeAt(nextText.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const previousEditEnd = previousText.length - suffix;
  const nextEditEnd = nextText.length - suffix;
  const delta = nextText.length - previousText.length;
  const retained: MessageMention[] = [];
  for (const mention of mentions) {
    const mentionEnd = mention.start + mention.length;
    if (previousEditEnd <= mention.start) {
      retained.push({ ...mention, start: mention.start + delta });
    } else if (prefix >= mentionEnd) {
      retained.push({ ...mention });
    }
  }
  return { mentions: retained, cursor: nextEditEnd };
}

/** The unfinished `@query` immediately before the cursor, if there is one. */
export function findMentionQuery(text: string, cursor: number): MentionQuery | null {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]{0,128})$/u.exec(beforeCursor);
  if (!match) return null;
  const query = match[1] ?? '';
  return {
    start: cursor - query.length - 1,
    end: cursor,
    query,
  };
}

function validParticipant(participant: MentionParticipant): boolean {
  const address = participant.address;
  const label = participant.label.trim();
  return (
    address.length > 0 &&
    address === address.trim() &&
    !CONTROL_CHARACTER.test(address) &&
    label.length > 0 &&
    !CONTROL_CHARACTER.test(label)
  );
}

/** Replace one active `@query` with a participant label and tag only that exact visible label. */
export function insertAuthoredMention(
  text: string,
  mentions: readonly MessageMention[],
  query: MentionQuery,
  participant: MentionParticipant,
): { text: string; mentions: MessageMention[]; cursor: number } | null {
  if (
    !validParticipant(participant) ||
    query.start < 0 ||
    query.end > text.length ||
    query.start >= query.end ||
    text.slice(query.start, query.end) !== `@${query.query}`
  ) {
    return null;
  }

  const label = participant.label.trim();
  const suffix = text.slice(query.end);
  const trailingSpace = suffix.length > 0 && !/^\s/u.test(suffix) ? ' ' : '';
  const replacement = `${label}${trailingSpace}`;
  const nextText = text.slice(0, query.start) + replacement + suffix;
  const reconciled = reconcileAuthoredMentions(text, nextText, mentions);
  const nextMentions = [
    ...reconciled.mentions,
    { start: query.start, length: label.length, address: participant.address },
  ].sort((left, right) => left.start - right.start);
  return {
    text: nextText,
    mentions: nextMentions,
    cursor: query.start + replacement.length,
  };
}

/**
 * Composer submission trims surrounding whitespace. Shift mention offsets onto that exact outbound
 * string and fail closed if any tracked label no longer describes complete, nonblank text.
 */
export function mentionsForTrimmedText(
  authoredText: string,
  mentions: readonly MessageMention[],
): MessageMention[] | null {
  if (mentions.length === 0 || mentions.length > 64) return null;
  const trimmed = authoredText.trim();
  const leading = authoredText.length - authoredText.trimStart().length;
  const authoredEnd = leading + trimmed.length;
  let previousEnd = 0;
  const normalized: MessageMention[] = [];

  for (const mention of [...mentions].sort((left, right) => left.start - right.start)) {
    const end = mention.start + mention.length;
    if (
      !Number.isSafeInteger(mention.start) ||
      !Number.isSafeInteger(mention.length) ||
      mention.length <= 0 ||
      mention.start < leading ||
      end > authoredEnd ||
      mention.start < previousEnd ||
      mention.address.length === 0 ||
      mention.address !== mention.address.trim() ||
      CONTROL_CHARACTER.test(mention.address)
    ) {
      return null;
    }
    const label = authoredText.slice(mention.start, end);
    if (label.trim().length === 0) return null;
    const shifted = { ...mention, start: mention.start - leading };
    normalized.push(shifted);
    previousEnd = end;
  }
  return normalized;
}
