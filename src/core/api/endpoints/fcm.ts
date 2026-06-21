import { z } from 'zod';
import type { HttpClient } from '../http';

/**
 * POST /api/v1/fcm/device — register this device's FCM token with the server so it can
 * push to us. `name` is a human-readable device label; `identifier` is the FCM token
 * (the server keys on the token). Mirrors the Flutter client's `addFcmDevice`.
 */
export function registerDevice(
  http: HttpClient,
  name: string,
  identifier: string,
): Promise<unknown> {
  return http.post('/fcm/device', z.unknown(), { json: { name, identifier } });
}
