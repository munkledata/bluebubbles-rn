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

export async function refreshDevices(http: HttpClient): Promise<unknown[]> {
  const res = await http.post('/findmy/devices/refresh', DevicesResponse, { json: {} });
  // Some server versions return no data on refresh — fall back to a GET.
  return (res.devices ?? []).length > 0 ? (res.devices ?? []) : getDevices(http);
}

export async function refreshFriends(http: HttpClient): Promise<unknown[]> {
  const res = await http.post('/findmy/friends/refresh', FriendsResponse, { json: {} });
  return (res.friends ?? []).length > 0 ? (res.friends ?? []) : getFriends(http);
}
