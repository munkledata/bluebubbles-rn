// SDK 56 deprecated the root getContactsAsync (it throws); the /legacy entry
// preserves the imperative API we use.
import * as Contacts from 'expo-contacts/legacy';
import { getDatabase } from '@db/database';
import { logger } from '@core/secure';
import { matchContactsToHandles, upsertContacts, type DeviceContact } from '@db/repositories';
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

/**
 * Read device contacts → upsert into the DB → re-match handles (writing contact
 * name + photo onto each matched handle). Returns counts for the UI. Throws
 * 'contacts-permission-denied' when access isn't granted.
 */
export async function syncContacts(): Promise<{ contacts: number; matched: number }> {
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
  return { contacts, matched };
}
