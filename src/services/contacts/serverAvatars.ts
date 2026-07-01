import { Directory, File, Paths } from 'expo-file-system';
import { contactsApi } from '@core/api';
import { logger } from '@core/secure';
import { emailKey, handleKey, phoneKey } from '@utils/contactMatch';
import { handlesNeedingAvatar, setHandleServerAvatar } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { HttpClient } from '@core/api';

/**
 * Backfill server-sourced avatars onto handles the DEVICE address book didn't supply a photo
 * for (e.g. a contact on the Mac but not the phone). Best-effort + additive: it only writes a
 * photo onto handles whose `avatar` is null — device photos are never touched — so a failure
 * here can't affect the primary device-contact sync. Avatars download to a cache dir as
 * `file://` uris, so the existing Avatar rendering works unchanged; the client caches by
 * contact id and skips already-downloaded files.
 *
 * Returns the number of handles a server avatar was written to.
 */
export async function backfillServerAvatars(db: AppDatabase, http: HttpClient): Promise<number> {
  const needing = await handlesNeedingAvatar(db);
  if (needing.length === 0) return 0;

  const contacts = await contactsApi.queryContactsByAddress(
    http,
    needing.map((h) => h.address),
  );
  if (contacts.length === 0) return 0;

  // Index address-key → contact-with-photo (last-10-digits phone / lowercased email — the
  // same keys the device-contact matcher uses).
  const byKey = new Map<string, contactsApi.ServerContact>();
  for (const c of contacts) {
    if (!c.hasAvatar || !c.id) continue;
    for (const p of c.phoneNumbers ?? []) byKey.set(phoneKey(p), c);
    for (const e of c.emails ?? []) byKey.set(emailKey(e), c);
  }
  if (byKey.size === 0) return 0;

  const dir = new Directory(Paths.document, 'server-contact-avatars');
  dir.create({ intermediates: true, idempotent: true });
  const headers = http.buildHeaders();

  let written = 0;
  for (const h of needing) {
    const c = byKey.get(handleKey(h.address));
    if (!c || !c.id) continue;
    try {
      // Name the file by (id, etag) so a changed photo re-downloads; reuse an existing file.
      const dest = new File(dir, `${sanitize(c.id)}-${sanitize(c.avatarEtag ?? 'v0')}.img`);
      if (!dest.exists) {
        const task = File.createDownloadTask(contactsApi.contactAvatarUrl(http, c.id, 'thumb'), dest, {
          headers,
        });
        const file = await task.downloadAsync();
        if (!file) continue;
      }
      await setHandleServerAvatar(db, h.id, dest.uri);
      written += 1;
    } catch (e) {
      logger.warn('[contacts] server-avatar backfill failed for a handle', e);
    }
  }
  return written;
}

/** Keep downloaded filenames to a safe charset. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
