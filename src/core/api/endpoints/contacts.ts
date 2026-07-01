import { z } from 'zod';
import type { HttpClient } from '../http';

/** A contact as returned by the Gator server's contacts endpoints. */
export const ServerContact = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  phoneNumbers: z.array(z.string()).nullish(),
  emails: z.array(z.string()).nullish(),
  hasAvatar: z.boolean().nullish(),
  /** Changes when the photo changes — for client-side avatar cache-busting. */
  avatarEtag: z.string().nullish(),
});
export type ServerContact = z.infer<typeof ServerContact>;

const ContactList = z.object({ contacts: z.array(ServerContact).nullish() });

/**
 * POST /api/v1/contact/query — server contacts matching the given phone numbers / emails.
 * Used to backfill avatars for handles the device address book didn't supply a photo for.
 */
export async function queryContactsByAddress(
  http: HttpClient,
  addresses: string[],
): Promise<ServerContact[]> {
  const res = await http.post('/contact/query', ContactList, { json: { addresses } });
  return res.contacts ?? [];
}

/**
 * The authed URL for a contact's avatar bytes — `GET /api/v1/contact/{id}/avatar`. Fetch it
 * with `http.buildHeaders()` (header auth keeps the password off the URL), e.g. via
 * `File.createDownloadTask(url, dest, { headers })` or `<Image source={{ uri, headers }}>`.
 */
export function contactAvatarUrl(http: HttpClient, id: string, size: 'thumb' | 'full' = 'thumb'): string {
  return http.buildUrl(`/contact/${encodeURIComponent(id)}/avatar?size=${size}`);
}
