import { z } from 'zod/v4';
import type { HttpClient } from '../http';

const CanonicalUuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const RevokeSelfAck = z
  .object({
    revoked: z.boolean(),
    deviceId: CanonicalUuidV4,
    deviceRemoved: z.boolean(),
  })
  .strict();

export type RevokeSelfAck = z.infer<typeof RevokeSelfAck>;

/** Revoke exactly the scoped bearer authenticating this request; shared passwords are rejected. */
export function revokeSelf(http: HttpClient, signal?: AbortSignal): Promise<RevokeSelfAck> {
  return http.post('/device-credentials/revoke-self', RevokeSelfAck, {
    json: {},
    signal,
  });
}
