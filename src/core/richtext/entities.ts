const MAX_ENTITY_SCAN_LENGTH = 32_768;
const MAX_MESSAGE_ENTITIES = 64;
const MAX_URL_LENGTH = 2_048;

const URL_CANDIDATE_RE = /https?:\/\/[^\s<>{}\[\]"']+/giu;
// International numbers must be either one uninterrupted E.164-shaped token or consistently
// grouped with spaces/hyphens. A permissive "digits and separators" run can swallow a nearby ID
// or date into the phone target, which is worse than declining an unusual phone spelling.
const INTERNATIONAL_PHONE_RE =
  /\+(?:[1-9][0-9]{7,14}|[1-9][0-9]{0,2}([ -])[0-9]{2,4}(?:\1[0-9]{2,4}){1,3})/g;
const NANP_PHONE_RE =
  /(?:(?:\+?1)[ .-])?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ .-][2-9][0-9]{2}[ .-][0-9]{4}/g;
const ISO_DATE_RE = /\b([0-9]{4})-([0-9]{2})-([0-9]{2})\b/g;
const MONTH_NAME =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const MONTH_FIRST_DATE_RE = new RegExp(
  `\\b${MONTH_NAME}\\.?\\s+([0-9]{1,2}),?\\s+([0-9]{4})\\b`,
  'gi',
);
const DAY_FIRST_DATE_RE = new RegExp(
  `\\b([0-9]{1,2})\\s+${MONTH_NAME}\\.?[,]?\\s+([0-9]{4})\\b`,
  'gi',
);

const UNSAFE_URL_CHAR_RE = /[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const TOKEN_CHAR_RE = /[A-Za-z0-9_@]/;
const PHONE_EXTENSION_RE = /^\s*(?:x|ext\.?)\s*[0-9]/i;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

interface MessageEntityBase {
  start: number;
  end: number;
  text: string;
}

export interface MessageUrlEntity extends MessageEntityBase {
  kind: 'url';
  /** Validated explicit http(s) target. */
  url: string;
}

export interface MessagePhoneEntity extends MessageEntityBase {
  kind: 'phone';
  /** Canonical E.164-shaped target used to construct tel:/sms: URIs. */
  number: string;
}

export interface MessageDateEntity extends MessageEntityBase {
  kind: 'date';
  year: number;
  month: number;
  day: number;
  /** UTC all-day bounds for Android's calendar draft intent. */
  startUtcMs: number;
  endUtcMs: number;
}

export type MessageEntity = MessageUrlEntity | MessagePhoneEntity | MessageDateEntity;

export type MessageEntitySpan =
  { kind: 'text'; text: string } | { kind: 'entity'; entity: MessageEntity };

interface RankedEntity {
  entity: MessageEntity;
  priority: number;
}

interface TextRange {
  start: number;
  end: number;
}

function isTokenBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  return (!before || !TOKEN_CHAR_RE.test(before)) && (!after || !TOKEN_CHAR_RE.test(after));
}

function trimUrlSentencePunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && /[.,!?;:…]/.test(raw[end - 1]!)) end -= 1;

  // Keep balanced parentheses inside a path, but drop a sentence's unmatched closing parenthesis.
  let opens = 0;
  let closes = 0;
  for (let index = 0; index < end; index += 1) {
    if (raw[index] === '(') opens += 1;
    else if (raw[index] === ')') closes += 1;
  }
  let unmatchedClosings = Math.max(closes - opens, 0);
  while (unmatchedClosings > 0 && end > 0 && raw[end - 1] === ')') {
    end -= 1;
    unmatchedClosings -= 1;
  }
  return raw.slice(0, end);
}

/**
 * Validate an explicit web URL without widening it to bare domains or non-web schemes.
 * Returns the punctuation-trimmed original spelling so preview/cache keys stay stable.
 */
export function validatedMessageWebUrl(raw: string): string | null {
  // Bound work before punctuation/parenthesis processing; the surrounding message scan is larger.
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  const value = trimUrlSentencePunctuation(raw);
  if (!value || UNSAFE_URL_CHAR_RE.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return value;
}

/** Revalidate the canonical phone target immediately before a native dialer/SMS handoff. */
export function isCanonicalMessagePhone(number: string): boolean {
  return /^\+[1-9][0-9]{7,14}$/.test(number);
}

/** Revalidate the calendar bounds immediately before a native intent handoff. */
export function isValidMessageDate(entity: MessageDateEntity): boolean {
  if (entity.year < 1900 || entity.year > 2100) return false;
  const start = Date.UTC(entity.year, entity.month - 1, entity.day);
  const resolved = new Date(start);
  return (
    resolved.getUTCFullYear() === entity.year &&
    resolved.getUTCMonth() === entity.month - 1 &&
    resolved.getUTCDate() === entity.day &&
    entity.startUtcMs === start &&
    entity.endUtcMs === start + 86_400_000
  );
}

function dateEntity(
  text: string,
  start: number,
  end: number,
  year: number,
  month: number,
  day: number,
): MessageDateEntity | null {
  const startUtcMs = Date.UTC(year, month - 1, day);
  const entity: MessageDateEntity = {
    kind: 'date',
    start,
    end,
    text: text.slice(start, end),
    year,
    month,
    day,
    startUtcMs,
    endUtcMs: startUtcMs + 86_400_000,
  };
  return isValidMessageDate(entity) ? entity : null;
}

function collectUrls(
  text: string,
  out: RankedEntity[],
  lowerPriorityBlocks: TextRange[],
  truncated: boolean,
): void {
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const raw = match[0];
    const start = match.index;
    if (start == null) continue;
    // Even a malformed/oversized explicit URL-shaped token blocks phone/date extraction inside
    // itself. Otherwise rejecting its web action could accidentally expose a path fragment as a
    // different native action.
    lowerPriorityBlocks.push({ start, end: start + raw.length });
    // Keep scanning URL-shaped ranges after the valid-entity candidate cap. The message scan is
    // already bounded, and a later malformed URL must still block phone/date actions in its path.
    if (out.length >= MAX_MESSAGE_ENTITIES * 3) continue;
    if (truncated && start + raw.length === text.length) continue;
    if (start > 0 && TOKEN_CHAR_RE.test(text[start - 1]!)) continue;
    const url = validatedMessageWebUrl(raw);
    if (!url) continue;
    const end = start + url.length;
    out.push({ entity: { kind: 'url', start, end, text: url, url }, priority: 0 });
  }
}

function collectDates(text: string, out: RankedEntity[], truncated: boolean): void {
  const add = (
    raw: string,
    start: number | undefined,
    year: number,
    month: number,
    day: number,
  ): void => {
    if (start == null || out.length >= MAX_MESSAGE_ENTITIES * 3) return;
    const end = start + raw.length;
    if ((truncated && end === text.length) || !isTokenBoundary(text, start, end)) return;
    const entity = dateEntity(text, start, end, year, month, day);
    if (entity) out.push({ entity, priority: 1 });
  };

  for (const match of text.matchAll(ISO_DATE_RE)) {
    add(match[0], match.index, Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(MONTH_FIRST_DATE_RE)) {
    const month = MONTHS[match[1]?.toLowerCase() ?? ''];
    if (month != null) add(match[0], match.index, Number(match[3]), month, Number(match[2]));
  }
  for (const match of text.matchAll(DAY_FIRST_DATE_RE)) {
    const month = MONTHS[match[2]?.toLowerCase() ?? ''];
    if (month != null) add(match[0], match.index, Number(match[3]), month, Number(match[1]));
  }
}

function collectPhones(text: string, out: RankedEntity[], truncated: boolean): void {
  const add = (raw: string, start: number | undefined, international: boolean): void => {
    if (start == null || out.length >= MAX_MESSAGE_ENTITIES * 3) return;
    const end = start + raw.length;
    if ((truncated && end === text.length) || !isTokenBoundary(text, start, end)) return;
    if (
      !international &&
      (text[start - 1] === '+' ||
        /\+[1-9][0-9]{0,2}[ .-]+$/.test(text.slice(Math.max(0, start - 8), start)))
    ) {
      return;
    }
    if (PHONE_EXTENSION_RE.test(text.slice(end, end + 16))) return;

    const digits = raw.replace(/[^0-9]/g, '');
    const number = international
      ? `+${digits}`
      : digits.length === 10
        ? `+1${digits}`
        : digits.length === 11 && digits.startsWith('1')
          ? `+${digits}`
          : '';
    if (!isCanonicalMessagePhone(number)) return;
    out.push({ entity: { kind: 'phone', start, end, text: raw, number }, priority: 2 });
  };

  for (const match of text.matchAll(INTERNATIONAL_PHONE_RE)) {
    add(match[0], match.index, true);
  }
  for (const match of text.matchAll(NANP_PHONE_RE)) {
    add(match[0], match.index, false);
  }
}

/**
 * Find a bounded set of actionable entities in message text.
 *
 * Deliberately excluded: bare domains, bare digit runs, short codes/extensions, slash dates,
 * relative dates/times, email, postal addresses, tracking numbers, and flight numbers. Missing an
 * uncertain match is safer than turning ordinary peer-controlled text into the wrong native action.
 */
export function findMessageEntities(text: string): MessageEntity[] {
  if (!text) return [];
  const truncated = text.length > MAX_ENTITY_SCAN_LENGTH;
  const scanned = truncated ? text.slice(0, MAX_ENTITY_SCAN_LENGTH) : text;
  const candidates: RankedEntity[] = [];
  const lowerPriorityBlocks: TextRange[] = [];
  collectUrls(scanned, candidates, lowerPriorityBlocks, truncated);
  collectDates(scanned, candidates, truncated);
  collectPhones(scanned, candidates, truncated);
  candidates.sort(
    (a, b) =>
      a.entity.start - b.entity.start || a.priority - b.priority || b.entity.end - a.entity.end,
  );

  const selected: MessageEntity[] = [];
  let occupiedUntil = -1;
  for (const { entity } of candidates) {
    if (entity.start < occupiedUntil) continue;
    if (
      entity.kind !== 'url' &&
      lowerPriorityBlocks.some((range) => range.start < entity.end && entity.start < range.end)
    ) {
      continue;
    }
    selected.push(entity);
    occupiedUntil = entity.end;
    if (selected.length >= MAX_MESSAGE_ENTITIES) break;
  }
  return selected;
}

/** Split message text without changing or dropping any character. */
export function splitMessageEntitySpans(text: string): MessageEntitySpan[] {
  const entities = findMessageEntities(text);
  if (entities.length === 0) return text ? [{ kind: 'text', text }] : [];

  const spans: MessageEntitySpan[] = [];
  let cursor = 0;
  for (const entity of entities) {
    if (entity.start > cursor) spans.push({ kind: 'text', text: text.slice(cursor, entity.start) });
    spans.push({ kind: 'entity', entity });
    cursor = entity.end;
  }
  if (cursor < text.length) spans.push({ kind: 'text', text: text.slice(cursor) });
  return spans;
}
