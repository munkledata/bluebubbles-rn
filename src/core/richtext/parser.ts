import type { TextRun } from './types';

interface RawRun {
  range?: unknown;
  attributes?: Record<string, unknown> | null;
}
interface RawPart {
  string?: unknown;
  runs?: unknown;
}

// iMessage attributedBody attribute keys (see Flutter attributed_body.dart).
const MENTION_KEY = '__kIMMentionConfirmedMention';
const ATTACHMENT_KEY = '__kIMFileTransferGUIDAttributeName';

function attrPresent(attrs: Record<string, unknown> | null | undefined, key: string): boolean {
  return !!attrs && typeof attrs === 'object' && attrs[key] != null;
}

/**
 * Parse a stored `attributedBody` (a JSON array of `{ string, runs }`) into flat
 * styled runs. Each run's `range` is an NSRange `[start, length]`. Confirmed
 * mentions are flagged for accent styling; inline-attachment placeholders are
 * flagged so the bubble can skip them in text. Unknown attributes are ignored
 * (forward-compatible). Any malformed input falls back to a single plain run.
 *
 * NOTE (Android-only v1): BlueBubbles' data carries no bold/italic/underline
 * styling attributes, so only mentions + attachment placeholders are extracted;
 * links are still handled downstream by the bubble's linkify.
 */
export function parseAttributedRuns(
  attributedBodyJson: string | null | undefined,
  fallbackText: string | null | undefined,
): TextRun[] {
  const fallback = (): TextRun[] => [{ text: fallbackText ?? '' }];
  if (!attributedBodyJson) return fallback();

  let parsed: unknown;
  try {
    parsed = JSON.parse(attributedBodyJson);
  } catch {
    return fallback();
  }

  const parts: RawPart[] = Array.isArray(parsed) ? parsed : [parsed as RawPart];
  const out: TextRun[] = [];
  for (const part of parts) {
    const str = typeof part?.string === 'string' ? part.string : '';
    if (!str) continue;
    const runs = Array.isArray(part?.runs) ? (part.runs as RawRun[]) : [];
    if (runs.length === 0) {
      out.push({ text: str });
      continue;
    }
    // Runs may not tile the whole string; emit the uncovered gaps as plain text
    // so no message content is ever silently dropped.
    let cursor = 0;
    for (const run of runs) {
      const range = Array.isArray(run?.range) ? (run.range as unknown[]) : [];
      const start = typeof range[0] === 'number' ? range[0] : cursor;
      const length = typeof range[1] === 'number' ? range[1] : str.length - start;
      const end = Math.min(str.length, Math.max(start, start + length));
      if (start > cursor) out.push({ text: str.substring(cursor, start) }); // gap before this run
      const text = str.substring(Math.max(cursor, start), end);
      cursor = Math.max(cursor, end);
      if (!text) continue;
      const attrs = run?.attributes;
      out.push({
        text,
        ...(attrPresent(attrs, MENTION_KEY) ? { mention: true } : {}),
        ...(attrPresent(attrs, ATTACHMENT_KEY) ? { attachment: true } : {}),
      });
    }
    if (cursor < str.length) out.push({ text: str.substring(cursor) }); // trailing remainder
  }
  return out.length > 0 ? out : fallback();
}

/** True if any run is a confirmed mention (gates the rich renderer). */
export function hasMention(runs: TextRun[]): boolean {
  return runs.some((r) => r.mention);
}

/**
 * Plain text recovered from a stored `attributedBody` JSON — the message's words with
 * inline-attachment placeholders dropped and U+FFFC stripped. Returns '' when there's no
 * real text. Used to populate `messages.text` (and thus the FTS index) for edited/SMS
 * messages, whose `text` column is empty because their body lives only in attributedBody.
 */
export function plainTextFromAttributedBody(attributedBodyJson: string | null | undefined): string {
  if (!attributedBodyJson) return '';
  return parseAttributedRuns(attributedBodyJson, '')
    .filter((r) => !r.attachment)
    .map((r) => r.text)
    .join('')
    .replace(/￼/g, '')
    .trim();
}
