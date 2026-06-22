import { z } from 'zod';
import type { HttpClient } from '../http';

// Paths: the Gator fork serves /findmy/* (upstream used /icloud/findmy/*). The HttpClient
// unwraps the { status, message, data } envelope; Gator's `data` is a NAMED-KEY object
// ({ devices: [...] } / { friends: [...] }), not a bare array. Items stay opaque and are
// normalized in core/findmy (shape varies across versions).
const DevicesResponse = z.object({ devices: z.array(z.unknown()).nullish() }).passthrough();
const FriendsResponse = z.object({ friends: z.array(z.unknown()).nullish() }).passthrough();

export async function getDevices(http: HttpClient): Promise<unknown[]> {
  return (await http.get('/findmy/devices', DevicesResponse)).devices ?? [];
}

export async function getFriends(http: HttpClient): Promise<unknown[]> {
  return (await http.get('/findmy/friends', FriendsResponse)).friends ?? [];
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
