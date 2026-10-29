/**
 * Whether the connected server currently emits Apple's Messages screening flags
 * (`Chat.isFiltered`, `Message.isSpam`; server-info `supports_apple_screening`).
 *
 * The repositories cannot import session state, so the services layer injects a live reader (see
 * `databaseControl.ts`). Until one is registered, and whenever it throws, the answer is false. That
 * is the safe direction: ingestion then leaves every stored flag untouched, because an absent field
 * from a server that does not emit it means "unknown", never "not filtered".
 */
let readCapability: () => boolean = () => false;

/** Register the live capability reader. A later call replaces the earlier one. */
export function setAppleScreeningCapabilityReader(reader: () => boolean): void {
  readCapability = reader;
}

/** True only when the server says it emits the screening flags right now. */
export function appleScreeningEmitted(): boolean {
  try {
    return readCapability() === true;
  } catch {
    return false;
  }
}

/**
 * The value to store for one optional screening flag: the server's boolean when the capability is
 * on and the payload carries it, otherwise null, which the upserts read as "keep what is stored".
 */
export function appleScreeningFlagForStorage(
  value: boolean | null | undefined,
  emitted: boolean,
): boolean | null {
  return emitted && typeof value === 'boolean' ? value : null;
}
