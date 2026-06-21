import { z } from 'zod';
import type { HttpClient } from '../http';

// The HttpClient already unwraps the server's { status, message, data } envelope (see
// apiResponse), so the schema here is the INNER `data` payload — a bare array. Keep items
// opaque and normalize in core/findmy (server shape varies across versions).
const ListResponse = z.array(z.unknown()).nullish();

async function list(http: HttpClient, path: string): Promise<unknown[]> {
  return (await http.get(path, ListResponse)) ?? [];
}

export const getDevices = (http: HttpClient): Promise<unknown[]> =>
  list(http, '/icloud/findmy/devices');

export const getFriends = (http: HttpClient): Promise<unknown[]> =>
  list(http, '/icloud/findmy/friends');

export async function refreshDevices(http: HttpClient): Promise<unknown[]> {
  const res = await http.post('/icloud/findmy/devices/refresh', ListResponse, { json: {} });
  // Some server versions return no data on refresh — fall back to a GET.
  return res && res.length > 0 ? res : getDevices(http);
}

export async function refreshFriends(http: HttpClient): Promise<unknown[]> {
  const res = await http.post('/icloud/findmy/friends/refresh', ListResponse, { json: {} });
  return res && res.length > 0 ? res : getFriends(http);
}
