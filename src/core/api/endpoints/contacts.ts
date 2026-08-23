import { z } from 'zod/v4';
import type { HttpClient, HttpUrlBuilder } from '../http';

/** One automatic backfill run never asks the server about more handles than this. */
export const CONTACT_QUERY_MAX_ADDRESSES = 64;
/** Fail closed on a server response that expands one bounded query into an unbounded contact list. */
export const CONTACT_QUERY_MAX_RESULTS = 64;
/** A single malformed contact cannot carry an unbounded phone/email array into the match index. */
export const CONTACT_QUERY_MAX_VALUES_PER_FIELD = 64;

/** A contact as returned by the Gator server's contacts endpoints. */
export const ServerContact = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  phoneNumbers: z.array(z.string()).max(CONTACT_QUERY_MAX_VALUES_PER_FIELD).nullish(),
  emails: z.array(z.string()).max(CONTACT_QUERY_MAX_VALUES_PER_FIELD).nullish(),
  hasAvatar: z.boolean().nullish(),
  /** Changes when the photo changes — for client-side avatar cache-busting. */
  avatarEtag: z.string().nullish(),
});
export type ServerContact = z.infer<typeof ServerContact>;

const ContactList = z.object({
  contacts: z.array(ServerContact).max(CONTACT_QUERY_MAX_RESULTS).nullish(),
});

/**
 * POST /api/v1/contact/query — server contacts matching the given phone numbers / emails.
 * Used to backfill avatars for handles the device address book didn't supply a photo for.
 */
export async function queryContactsByAddress(
  http: HttpClient,
  addresses: string[],
): Promise<ServerContact[]> {
  const res = await http.post('/contact/query', ContactList, {
    json: { addresses: addresses.slice(0, CONTACT_QUERY_MAX_ADDRESSES) },
  });
  return res.contacts ?? [];
}

/**
 * The authed URL for a contact's avatar bytes — `GET /api/v1/contact/{id}/avatar`. Fetch it
 * from one `http.snapshotTransport()` and pass that same snapshot's headers to the native task.
 * Header auth keeps the password off the URL; explicit legacy mode is added centrally by the
 * snapshot rather than by the feature.
 */
export function contactAvatarUrl(
  http: HttpUrlBuilder,
  id: string,
  size: 'thumb' | 'full' = 'thumb',
): string {
  return http.buildUrl(`/contact/${encodeURIComponent(id)}/avatar?size=${size}`);
}
