export const GLOBAL_SEARCH_MAX_CODE_POINTS = 128;

/** Keep the controlled input within the server's UTF-16 pre-parse ceiling. */
export function boundGlobalSearchInput(value: string): string {
  return Array.from(value.normalize('NFC')).slice(0, GLOBAL_SEARCH_MAX_CODE_POINTS).join('');
}

/** Normalize the actual lookup term identically for local and server search. */
export function normalizeGlobalSearchQuery(value: string): string {
  return Array.from(value.normalize('NFC').trim()).slice(0, GLOBAL_SEARCH_MAX_CODE_POINTS).join('');
}

/** The local and Mac-backed search surfaces share one Unicode-aware minimum query length. */
export function isGlobalSearchQueryValid(value: string): boolean {
  return Array.from(normalizeGlobalSearchQuery(value)).length >= 2;
}
