import {
  IMESSAGE_TEXT_STYLES,
  type IMessageTextFormattingRange,
  type IMessageTextStyle,
} from '@core/api/endpoints/messages';
import { graphemeBoundaries } from '@utils/grapheme';

export interface TextSelection {
  start: number;
  end: number;
}

function canonicalStyles(styles: Iterable<IMessageTextStyle>): IMessageTextStyle[] {
  const selected = new Set(styles);
  return IMESSAGE_TEXT_STYLES.filter((style) => selected.has(style));
}

function sameStyles(
  left: readonly IMessageTextStyle[],
  right: readonly IMessageTextStyle[],
): boolean {
  return left.length === right.length && left.every((style, index) => style === right[index]);
}

function stylesAt(
  ranges: readonly IMessageTextFormattingRange[],
  start: number,
  end: number,
): IMessageTextStyle[] {
  const covering = ranges.find(
    (range) => range.start <= start && range.start + range.length >= end,
  );
  return covering ? [...covering.styles] : [];
}

function mergeAdjacent(
  ranges: readonly IMessageTextFormattingRange[],
): IMessageTextFormattingRange[] {
  const merged: IMessageTextFormattingRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.start + previous.length === range.start &&
      sameStyles(previous.styles, range.styles)
    ) {
      previous.length += range.length;
    } else {
      merged.push({ ...range, styles: [...range.styles] });
    }
  }
  return merged;
}

/**
 * Carry untouched style ranges through one TextInput edit. An edit that intersects a styled span
 * drops that span instead of guessing whether the newly typed characters should inherit it.
 */
export function reconcileAuthoredFormatting(
  previousText: string,
  nextText: string,
  ranges: readonly IMessageTextFormattingRange[],
): { textFormatting: IMessageTextFormattingRange[]; cursor: number } {
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
  const retained: IMessageTextFormattingRange[] = [];
  for (const range of ranges) {
    const rangeEnd = range.start + range.length;
    if (previousEditEnd <= range.start) {
      retained.push({ ...range, start: range.start + delta, styles: [...range.styles] });
    } else if (prefix >= rangeEnd) {
      retained.push({ ...range, styles: [...range.styles] });
    }
  }
  return { textFormatting: retained, cursor: nextEditEnd };
}

/** Toggle one style across a complete-character selection, returning null for unsafe input. */
export function toggleAuthoredStyle(
  text: string,
  ranges: readonly IMessageTextFormattingRange[],
  selection: TextSelection,
  style: IMessageTextStyle,
): IMessageTextFormattingRange[] | null {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const boundaries = graphemeBoundaries(text);
  if (
    !IMESSAGE_TEXT_STYLES.includes(style) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > text.length ||
    start === end ||
    !boundaries.has(start) ||
    !boundaries.has(end)
  ) {
    return null;
  }

  const points = new Set<number>([0, text.length, start, end]);
  for (const range of ranges) {
    points.add(range.start);
    points.add(range.start + range.length);
  }
  const sorted = [...points].sort((left, right) => left - right);
  const selectedSegments = sorted
    .slice(0, -1)
    .map((segmentStart, index) => ({ start: segmentStart, end: sorted[index + 1]! }))
    .filter(
      (segment) => segment.start >= start && segment.end <= end && segment.end > segment.start,
    );
  const remove = selectedSegments.every((segment) =>
    stylesAt(ranges, segment.start, segment.end).includes(style),
  );

  const next: IMessageTextFormattingRange[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const segmentStart = sorted[index]!;
    const segmentEnd = sorted[index + 1]!;
    if (segmentEnd <= segmentStart) continue;
    const current = stylesAt(ranges, segmentStart, segmentEnd);
    const insideSelection = segmentStart >= start && segmentEnd <= end;
    const styles = insideSelection
      ? canonicalStyles(
          remove ? current.filter((candidate) => candidate !== style) : [...current, style],
        )
      : canonicalStyles(current);
    if (styles.length > 0) {
      next.push({ start: segmentStart, length: segmentEnd - segmentStart, styles });
    }
  }
  const merged = mergeAdjacent(next);
  return merged.length <= 64 ? merged : null;
}

/** True only when every character in the current selection carries `style`. */
export function selectionHasStyle(
  ranges: readonly IMessageTextFormattingRange[],
  selection: TextSelection,
  style: IMessageTextStyle,
): boolean {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  if (start === end) return false;
  let cursor = start;
  for (const range of ranges) {
    const rangeEnd = range.start + range.length;
    if (rangeEnd <= cursor) continue;
    if (range.start > cursor || !range.styles.includes(style)) return false;
    cursor = Math.min(end, rangeEnd);
    if (cursor === end) return true;
  }
  return false;
}

/** Shift/clamp authored ranges onto the exact trimmed body submitted by the composer. */
export function formattingForTrimmedText(
  authoredText: string,
  ranges: readonly IMessageTextFormattingRange[],
): IMessageTextFormattingRange[] | null {
  if (ranges.length < 1 || ranges.length > 64) return null;
  const trimmed = authoredText.trim();
  const leading = authoredText.length - authoredText.trimStart().length;
  const authoredEnd = leading + trimmed.length;
  const boundaries = graphemeBoundaries(authoredText);

  const normalized: IMessageTextFormattingRange[] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    const originalEnd = range.start + range.length;
    const clippedStart = Math.max(range.start, leading);
    const clippedEnd = Math.min(originalEnd, authoredEnd);
    if (clippedEnd <= clippedStart) continue;
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.length) ||
      range.length <= 0 ||
      range.start < previousEnd ||
      !boundaries.has(clippedStart) ||
      !boundaries.has(clippedEnd) ||
      range.styles.length < 1 ||
      !sameStyles(range.styles, canonicalStyles(range.styles))
    ) {
      return null;
    }
    normalized.push({
      start: clippedStart - leading,
      length: clippedEnd - clippedStart,
      styles: [...range.styles],
    });
    previousEnd = originalEnd;
  }
  const merged = mergeAdjacent(normalized);
  return merged.length > 0 && merged.length <= 64 ? merged : null;
}
