// SDK 56 deprecated the root getContactsAsync (it throws); the /legacy entry
// preserves the imperative API we use.
import * as Contacts from 'expo-contacts/legacy';
import { getDatabase } from '@db/database';
import { matchContactsToHandles, upsertContacts, type DeviceContact } from '@db/repositories';

/** Request READ_CONTACTS. Returns true if granted. */
export async function requestContactsPermission(): Promise<boolean> {
  const { status } = await Contacts.requestPermissionsAsync();
  return status === 'granted';
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
  return { contacts, matched };
}
