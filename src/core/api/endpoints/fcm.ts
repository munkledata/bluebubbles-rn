import { z } from 'zod';
import type { HttpClient } from '../http';

// Gator's register-device op returns `{ id }` (the new device row's id) post-unwrap.
const RegisterAck = z.object({ id: z.string().nullish() }).passthrough();

/**
 * POST /api/v1/devices — register this device for push so the server can notify us.
 *
 * Matches the Gator `register-device` op: a discriminated-union body keyed on `provider`
 * (here always "fcm"), with `name` (human label) + `token` (the FCM token). Returns the
 * new device's `{ id }`. (The legacy upstream used `POST /fcm/device` with
 * `{ name, identifier }` and no meaningful return — Gator unified all push providers
 * under `/devices`.)
 */
export async function registerDevice(
  http: HttpClient,
  name: string,
  token: string,
): Promise<{ id: string | null }> {
  const res = await http.post('/devices', RegisterAck, {
    json: { name, provider: 'fcm', token },
  });
  return { id: res.id ?? null };
}
