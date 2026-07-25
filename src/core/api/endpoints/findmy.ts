import { z } from 'zod/v4';
import { logger } from '@core/secure';
import { ApiError } from '../errors';
import type { HttpClient } from '../http';

// Paths: the Gator fork serves /findmy/* (upstream used /icloud/findmy/*). The HttpClient
// unwraps the { status, message, data } envelope; Gator's `data` is a NAMED-KEY object
// ({ devices: [...] } / { friends: [...] }), not a bare array. Items stay opaque and are
// normalized in core/findmy (shape varies across versions).
const DevicesResponse = z.object({ devices: z.array(z.unknown()).nullish() }).loose();
const FriendsResponse = z.object({ friends: z.array(z.unknown()).nullish() }).loose();
// Items / AirTags — Gator's /findmy/items (added for the items/devices split). Same opaque,
// version-tolerant element shape as devices (normalized via core/findmy).
const ItemsResponse = z.object({ items: z.array(z.unknown()).nullish() }).loose();

export async function getDevices(http: HttpClient): Promise<unknown[]> {
  return (await http.get('/findmy/devices', DevicesResponse)).devices ?? [];
}

export async function getFriends(http: HttpClient): Promise<unknown[]> {
  return (await http.get('/findmy/friends', FriendsResponse)).friends ?? [];
}

export async function getItems(http: HttpClient): Promise<unknown[]> {
  // Tolerate a server that predates the items/devices split: `/findmy/items` 404s there, and we must
  // NOT fail the combined devices+friends+items load over it — degrade to no items.
  //
  // The degrade stays catch-ALL on purpose: the caller (findmyStore) awaits devices+friends+items
  // in one Promise.all, so throwing here would blank the WHOLE Find My screen — including the
  // devices and friends that loaded fine — behind "check your server connection".
  //
  // But a 401/500/parse failure is NOT the same as "old server", and silently returning [] made
  // the two indistinguishable: the Items tab just sat empty forever with no error and no log.
  // Anything that isn't the expected 404 is now logged at warn so it is diagnosable.
  try {
    return (await http.get('/findmy/items', ItemsResponse)).items ?? [];
  } catch (e) {
    const status = e instanceof ApiError ? e.status : null;
    if (status !== 404) {
      logger.warn(
        `[findmy] /findmy/items failed for a reason other than an old server (status ${
          status ?? 'none'
        }) — showing no items: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return [];
  }
}

/**
 * "Refresh" devices. AUDIT (F-20): the Gator server has NO `/findmy/devices/refresh` route
 * (only `/findmy/friends/refresh` exists) — POSTing it 404s. So we don't issue the doomed
 * request; we just GET the current device list, which degrades gracefully (no misleading
 * error). If a server adds the route, restore the POST + GET-fallback here.
 */
export async function refreshDevices(http: HttpClient): Promise<unknown[]> {
  return getDevices(http);
}

export async function refreshFriends(http: HttpClient): Promise<unknown[]> {
  const res = await http.post('/findmy/friends/refresh', FriendsResponse, { json: {} });
  return (res.friends ?? []).length > 0 ? (res.friends ?? []) : getFriends(http);
}

/** "Refresh" items — no `/findmy/items/refresh` route exists, so GET (degrades gracefully). */
export async function refreshItems(http: HttpClient): Promise<unknown[]> {
  return getItems(http);
}
