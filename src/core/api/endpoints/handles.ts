import { z } from 'zod/v4';
import type { HttpClient } from '../http';

const Availability = z.object({ available: z.boolean() }).loose();

/**
 * GET /api/v1/handle/availability/imessage?address=… — is this address reachable over iMessage?
 * (Private-API helper `check-imessage-availability` under the hood.) The address is URL-encoded
 * here — an unencoded `+` in a phone number would decode to a space server-side. Errors are the
 * CALLER's to swallow: availability is advisory (a failed probe must not block composing).
 */
export async function checkIMessageAvailability(
  http: HttpClient,
  address: string,
): Promise<boolean> {
  const res = await http.get(
    `/handle/availability/imessage?address=${encodeURIComponent(address)}`,
    Availability,
  );
  return res.available;
}
