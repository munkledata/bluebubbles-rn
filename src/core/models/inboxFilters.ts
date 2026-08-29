export type InboxReadFilter = 'any' | 'unread';
export type InboxSenderFilter = 'any' | 'known' | 'unknown';
export type InboxKindFilter = 'any' | 'direct' | 'group';
export type InboxMuteFilter = 'any' | 'muted' | 'unmuted';
export type InboxServiceFilter = 'any' | 'imessage' | 'sms' | 'rcs';

/** Five independent predicates applied to chat identities before an inbox page is cut. */
export interface InboxFilters {
  read: InboxReadFilter;
  sender: InboxSenderFilter;
  kind: InboxKindFilter;
  mute: InboxMuteFilter;
  service: InboxServiceFilter;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  read: 'any',
  sender: 'any',
  kind: 'any',
  mute: 'any',
  service: 'any',
};

interface PersistedInboxFiltersV1 {
  version: 1;
  filters: InboxFilters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail each unknown axis independently to "any" instead of rejecting every valid choice. */
export function normalizeInboxFilters(value: unknown): InboxFilters {
  const candidate = isRecord(value) ? value : {};
  return {
    read: candidate.read === 'unread' ? 'unread' : 'any',
    sender:
      candidate.sender === 'known' || candidate.sender === 'unknown' ? candidate.sender : 'any',
    kind: candidate.kind === 'direct' || candidate.kind === 'group' ? candidate.kind : 'any',
    mute: candidate.mute === 'muted' || candidate.mute === 'unmuted' ? candidate.mute : 'any',
    service:
      candidate.service === 'imessage' || candidate.service === 'sms' || candidate.service === 'rcs'
        ? candidate.service
        : 'any',
  };
}

/** Parse the versioned account-local value. Missing, malformed, and future versions fail open. */
export function parsePersistedInboxFilters(raw: string | null | undefined): InboxFilters {
  if (!raw) return { ...DEFAULT_INBOX_FILTERS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_INBOX_FILTERS };
    return normalizeInboxFilters(value.filters);
  } catch {
    return { ...DEFAULT_INBOX_FILTERS };
  }
}

export function serializeInboxFilters(filters: InboxFilters): string {
  const value: PersistedInboxFiltersV1 = { version: 1, filters: normalizeInboxFilters(filters) };
  return JSON.stringify(value);
}

export function activeInboxFilterCount(filters: InboxFilters): number {
  const normalized = normalizeInboxFilters(filters);
  return Object.values(normalized).filter((value) => value !== 'any').length;
}
