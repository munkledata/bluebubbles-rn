// SDK 56 deprecated the root getContactsAsync (it throws); the /legacy entry
// preserves the imperative API we use.
import * as Contacts from 'expo-contacts/legacy';
import { getDatabase } from '@db/database';
import { logger } from '@core/secure';
import { matchContactsToHandles, upsertContacts, type DeviceContact } from '@db/repositories';
import { sessionAccessors } from '@state/sessionStore';
// The session-bound HTTP client (used only at runtime inside syncContacts).
import { http } from '../clients';
import { backfillServerAvatars } from './serverAvatars';
import type { ContactCard } from '../send/sendContactService';

/** Request READ_CONTACTS. Returns true if granted. */
export async function requestContactsPermission(): Promise<boolean> {
  const { status } = await Contacts.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Present the native contact picker and map the chosen contact to the structured fields the
 * `send-contact` endpoint wants. Returns null when the user cancels or denies access — the caller
 * simply sends nothing. Only name/org/phones/emails are carried (the server builds the vCard);
 * the device photo is intentionally left off (the server-side vCard builder omits PHOTO too).
 */
export async function pickContact(): Promise<ContactCard | null> {
  if (!(await requestContactsPermission())) return null;
  const c = await Contacts.presentContactPickerAsync();
  if (!c) return null;
  return {
    firstName: c.firstName ?? undefined,
    lastName: c.lastName ?? undefined,
    organization: c.company ?? undefined,
    phones: (c.phoneNumbers ?? [])
      .map((p) => ({ number: (p.number ?? '').trim(), label: p.label ?? undefined }))
      .filter((p) => p.number),
    emails: (c.emails ?? [])
      .map((e) => ({ address: (e.email ?? '').trim(), label: e.label ?? undefined }))
      .filter((e) => e.address),
  };
}

/** Counts reported back to the UI by a contacts sync. */
type ContactsSyncResult = { contacts: number; matched: number };

/** The single in-flight contacts sync, shared by every concurrent caller (see `syncContacts`). */
let inFlight: Promise<ContactsSyncResult> | null = null;
/**
 * When the run the slot is waiting on actually STARTED (ms) — drives the abandonment check below.
 *
 * Stamped by `runContactsSync` itself, never at publish time. A chained (forced) call publishes a
 * new slot whose predecessor may already be minutes old, and stamping at publish would launder
 * that stale, possibly-wedged run into a fresh-looking one: every later caller would then wait out
 * a full abandonment window again, and each further tap would push the deadline out once more. A
 * chain therefore carries its PREDECESSOR's age until its own run begins.
 */
let inFlightStartedAt = 0;

/**
 * How long a run may hold the coalescing slot before later callers stop waiting on it. A real run
 * is seconds of work, so past this the promise is one that will never settle — an Android
 * permission dialog the user escaped by backgrounding the app leaves `requestPermissionsAsync`
 * pending for good. Without the cap that dangling promise is handed to EVERY later caller for the
 * rest of the process, so contacts never sync again until the app is restarted; one overlapping
 * generation swap is far cheaper than that.
 */
const IN_FLIGHT_ABANDON_MS = 120_000;

/**
 * Resolve when `p` settles OR after `ms`, whichever comes first — never rejecting, and clearing
 * its timer as soon as `p` settles so a normal run leaves nothing pending.
 *
 * This is what applies the abandonment cap to a CHAIN rather than only to a join. The check in
 * `syncContacts` runs once, at call time: a forced call arriving one second inside the window sees
 * a "live" predecessor and chains onto it — and if that predecessor is the wedged one the cap
 * exists to break, the chain inherits the wedge and can never run. The Settings button's spinner
 * then never clears.
 */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void p.then(done, done);
  });
}

/**
 * Read device contacts → upsert into the DB → re-match handles (writing contact
 * name + photo onto each matched handle). Returns counts for the UI. Throws
 * 'contacts-permission-denied' when access isn't granted.
 *
 * Coalesced behind one in-flight promise, the same way `startSync` is. `upsertContacts` is
 * add-then-prune, so the table is never EMPTY mid-run — but it is still two generations wide until
 * the prune, and two overlapping runs would prune each other's rows. The match pass guards against
 * a fully-empty read; a PARTIAL one still unlinks (and renames) every handle the other run hasn't
 * written yet. Both callers — the sync pipeline (`syncControl`) and the Settings button — fire this
 * uncoordinated, so the overlap is real, not theoretical.
 *
 * `force` is for the MANUAL entry point (the Settings "Sync Contacts" button), whose whole purpose
 * is "re-read the address book NOW and tell me the counts". Plain joining breaks that promise: it
 * hands back a run that read the device BEFORE the user's edit, so the just-added contact is
 * missing and the dialog still reports success. So a forced call CHAINS instead of joining — it
 * still serializes behind whatever is running (overlapping generation swaps are exactly what the
 * coalescing exists to prevent) and only then does its own fresh read. The chain carries the
 * abandonment cap with it, so it can never be stranded behind a run that will not finish.
 */
export function syncContacts(opts: { force?: boolean } = {}): Promise<ContactsSyncResult> {
  // A slot older than the abandonment window is treated as gone: joiners start their own run
  // instead of waiting on it.
  let live = inFlight;
  if (live && Date.now() - inFlightStartedAt >= IN_FLIGHT_ABANDON_MS) {
    logger.debug('[contacts] previous sync never settled; starting a fresh run');
    live = null;
  }
  if (live && !opts.force) return live;

  // A chained run waits out the REMAINDER of its predecessor's abandonment window, never longer:
  // the check above only fires for a caller that happens to arrive after the window has already
  // elapsed, so without this cap a forced call landing one second early would chain onto the very
  // wedged run the cap exists to break and could never execute at all — leaving the Settings
  // button's spinner up for the life of the screen. The remainder (not a fresh full window) is
  // what keeps a run's deadline fixed at its own start, however many callers chain onto it.
  const next = live
    ? settleWithin(live, Math.max(0, IN_FLIGHT_ABANDON_MS - (Date.now() - inFlightStartedAt))).then(
        () => runContactsSync(),
      )
    : runContactsSync();
  // Only the run that still OWNS the slot may clear it: a forced run that replaced this one has
  // already published a newer promise, and clearing that would let the next caller start a THIRD
  // run alongside it.
  const slot: Promise<ContactsSyncResult> = next.finally(() => {
    if (inFlight === slot) inFlight = null;
  });
  inFlight = slot;
  return slot;
}

async function runContactsSync(): Promise<ContactsSyncResult> {
  // Stamped HERE, not at publish — see `inFlightStartedAt`.
  inFlightStartedAt = Date.now();
  if (!(await requestContactsPermission())) throw new Error('contacts-permission-denied');

  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.Name,
      Contacts.Fields.FirstName,
      Contacts.Fields.LastName,
      Contacts.Fields.PhoneNumbers,
      Contacts.Fields.Emails,
      Contacts.Fields.Image,
    ],
  });

  const items: DeviceContact[] = data.map((c, i) => ({
    sourceId: c.id ?? `c-${i}`,
    displayName: (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')) || null,
    givenName: c.firstName ?? null,
    familyName: c.lastName ?? null,
    phones: (c.phoneNumbers ?? []).map((p) => p.number ?? '').filter(Boolean),
    emails: (c.emails ?? []).map((e) => e.email ?? '').filter(Boolean),
    // expo-contacts gives a file:// uri only when imageAvailable; store it directly.
    avatar: c.imageAvailable && c.image?.uri ? c.image.uri : null,
  }));

  const db = getDatabase();
  const contacts = await upsertContacts(db, items);
  const matched = await matchContactsToHandles(db);
  // Best-effort: fill in avatars from the server for handles the device address book had no
  // photo for. Fully guarded — a failure here must NOT fail the (already-complete) device sync.
  try {
    const filled = await backfillServerAvatars(db, http);
    if (filled > 0) logger.debug(`[contacts] backfilled ${filled} server avatar(s)`);
  } catch (e) {
    logger.debug('[contacts] server-avatar backfill skipped', e);
  }
  // Names and photos just changed, so the system's Direct Share chips are now stale. Lazily
  // imported to keep this module's Node import graph free of the native shortcuts bridge.
  //
  // ONLY WHILE A SESSION EXISTS. This run is fire-and-forget from the tail of every sync, so it
  // routinely outlives its parent — and `forget()` clears the Direct Share chips at the START of a
  // wipe that can then spend up to 20 seconds draining and deleting, with `chats` still fully
  // populated the whole time. Republishing there would put the PREVIOUS account's conversation
  // names and contact photos back into the system share sheet, where they are persistent state
  // that outlives the process: nothing later clears them, because a refresh over an emptied inbox
  // returns early rather than publishing zero. `forget()` clears the credentials before it drains,
  // so an absent origin is the signal that there is no account left to advertise.
  if (sessionAccessors.getOrigin()) {
    try {
      const { refreshShareShortcuts } = await import('@/services/shortcuts/shareShortcuts');
      void refreshShareShortcuts();
    } catch {
      // best-effort
    }
  }
  return { contacts, matched };
}
