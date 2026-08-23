// SDK 56 deprecated the root getContactsAsync (it throws); the /legacy entry
// preserves the imperative API we use.
import * as Contacts from 'expo-contacts/legacy';
import { getDatabase } from '@db/database';
import { logger } from '@core/secure';
import {
  matchContactsToHandles,
  upsertContacts,
  type ContactDbTaskRunner,
  type DeviceContact,
} from '@db/repositories';
// The session-bound HTTP client (used only at runtime inside syncContacts).
import { http } from '../clients';
import { backfillServerAvatars } from './serverAvatars';
import type { ContactCard } from '../send/sendContactService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/** Request READ_CONTACTS. Returns true if granted. */
export async function requestContactsPermission(): Promise<boolean> {
  const { status } = await Contacts.requestPermissionsAsync();
  return status === 'granted';
}

/** Check READ_CONTACTS without showing an Android permission dialog. */
async function hasContactsPermission(): Promise<boolean> {
  const { status } = await Contacts.getPermissionsAsync();
  return status === 'granted';
}

/** The user declined READ_CONTACTS; distinct from closing the contact picker without a choice. */
export class ContactsPermissionDeniedError extends Error {
  constructor() {
    super('contacts-permission-denied');
    this.name = 'ContactsPermissionDeniedError';
  }
}

export function isContactsPermissionDeniedError(
  error: unknown,
): error is ContactsPermissionDeniedError {
  return error instanceof ContactsPermissionDeniedError;
}

/**
 * Present the native contact picker and map the chosen contact to the structured fields the
 * `send-contact` endpoint wants. Returns null when the user cancels, but throws
 * `ContactsPermissionDeniedError` when access is denied so the UI can explain recovery. Only
 * name/org/phones/emails are carried (the server builds the vCard); the device photo is
 * intentionally left off (the server-side vCard builder omits PHOTO too).
 */
export async function pickContact(): Promise<ContactCard | null> {
  if (!(await requestContactsPermission())) throw new ContactsPermissionDeniedError();
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

/** A retired screen/session should quietly discard its pending contacts result. */
export class ContactsAccountChangedError extends Error {
  constructor() {
    super('contacts sync belongs to a previous account');
    this.name = 'ContactsAccountChangedError';
  }
}

export function isContactsAccountChangedError(error: unknown): boolean {
  return error instanceof ContactsAccountChangedError;
}

function assertCurrentAccount(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new ContactsAccountChangedError();
}

interface ContactsSyncSlot {
  readonly generation: number;
  readonly lease: RealtimeDeliveryLease;
  promise: Promise<ContactsSyncResult>;
  /** When the run this slot currently waits on actually started (for abandonment). */
  startedAt: number;
}

/** The current account generation's coalescing slot (see `syncContacts`). */
let inFlight: ContactsSyncSlot | null = null;

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
export function syncContacts(
  opts: { force?: boolean; accountLease?: RealtimeDeliveryLease } = {},
): Promise<ContactsSyncResult> {
  const accountLease = opts.accountLease ?? captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return Promise.reject(new ContactsAccountChangedError());

  // Coalescing is account-scoped. A permission/contact read from A may stay pending after A was
  // disconnected; B must start its own read rather than join A's eventual stale result.
  if (inFlight?.generation !== accountLease.generation || !inFlight.lease.isCurrent()) {
    inFlight = null;
  }

  // A slot older than the abandonment window is treated as gone: joiners start their own run
  // instead of waiting on it.
  let live = inFlight;
  if (live && Date.now() - live.startedAt >= IN_FLIGHT_ABANDON_MS) {
    logger.debug('[contacts] previous sync never settled; starting a fresh run');
    live = null;
  }
  if (live && !opts.force) return live.promise;

  // A chained run waits out the REMAINDER of its predecessor's abandonment window, never longer:
  // the check above only fires for a caller that happens to arrive after the window has already
  // elapsed, so without this cap a forced call landing one second early would chain onto the very
  // wedged run the cap exists to break and could never execute at all — leaving the Settings
  // button's spinner up for the life of the screen. The remainder (not a fresh full window) is
  // what keeps a run's deadline fixed at its own start, however many callers chain onto it.
  const slot: ContactsSyncSlot = {
    generation: accountLease.generation,
    lease: accountLease,
    promise: Promise.resolve({ contacts: 0, matched: 0 }),
    // A forced chain inherits its predecessor's age until its own run actually begins.
    startedAt: live?.startedAt ?? Date.now(),
  };
  const start = (): Promise<ContactsSyncResult> => {
    slot.startedAt = Date.now();
    // `force` is reserved for the explicit Settings button. Background startup sync may use an
    // existing grant, but must never surprise the user with a permission dialog.
    return runContactsSync(accountLease, opts.force === true);
  };
  const next = live
    ? settleWithin(
        live.promise,
        Math.max(0, IN_FLIGHT_ABANDON_MS - (Date.now() - live.startedAt)),
      ).then(start)
    : start();
  // Only the run that still OWNS the slot may clear it: a forced run that replaced this one has
  // already published a newer promise, and clearing that would let the next caller start a THIRD
  // run alongside it.
  slot.promise = next.finally(() => {
    if (inFlight === slot) inFlight = null;
  });
  inFlight = slot;
  return slot.promise;
}

/**
 * Admit exactly one short DB statement for the captured account. Native permission/address-book
 * waits stay outside teardown, while Disconnect drains a statement that already won the race and
 * rejects every later statement before it can touch a stale DB handle.
 */
async function runContactDbTask<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
): Promise<T> {
  let resolved = false;
  let value: T | undefined;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      assertCurrentAccount(activeLease);
      value = await task();
      resolved = true;
      assertCurrentAccount(activeLease);
    });
    if (status === 'paused' || !resolved) throw new ContactsAccountChangedError();
    assertCurrentAccount(lease);
    return value as T;
  } catch (error) {
    if (!lease.isCurrent()) throw new ContactsAccountChangedError();
    throw error;
  }
}

async function runContactsSync(
  accountLease: RealtimeDeliveryLease,
  requestPermission: boolean,
): Promise<ContactsSyncResult> {
  assertCurrentAccount(accountLease);
  const permissionGranted = requestPermission
    ? await requestContactsPermission()
    : await hasContactsPermission();
  assertCurrentAccount(accountLease);
  if (!permissionGranted) throw new Error('contacts-permission-denied');

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
  assertCurrentAccount(accountLease);

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

  // Obtain the handle under the same short admission rule as every statement that uses it. If A
  // is revoked between statements, the next runner rejects before invoking its closure, so B can
  // never be mutated through A's captured handle.
  const db = await runContactDbTask(accountLease, async () => getDatabase());
  const runDbTask: ContactDbTaskRunner = (task) => runContactDbTask(accountLease, task);
  const contacts = await upsertContacts(db, items, runDbTask);
  const matched = await matchContactsToHandles(db, runDbTask);
  assertCurrentAccount(accountLease);
  // Best-effort: fill in avatars from the server for handles the device address book had no
  // photo for. Fully guarded — a failure here must NOT fail the (already-complete) device sync.
  try {
    const filled = await backfillServerAvatars(db, http, accountLease);
    assertCurrentAccount(accountLease);
    if (filled > 0) logger.debug(`[contacts] backfilled ${filled} server avatar(s)`);
  } catch (e) {
    if (!accountLease.isCurrent()) throw new ContactsAccountChangedError();
    logger.debug('[contacts] server-avatar backfill skipped', e);
  }
  assertCurrentAccount(accountLease);
  return { contacts, matched };
}
