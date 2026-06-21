import type { FindMyDevice, FindMyFriend } from './types';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Normalize a raw Find My device (server shape varies) into what we render. The
 * server sends `location: { latitude, longitude }`, a float `batteryLevel`, and a
 * `name`; the address may be a string or a nested object — best-effort.
 */
export function normalizeDevice(raw: unknown, index: number): FindMyDevice {
  const o = (raw ?? {}) as Record<string, unknown>;
  const loc = (o.location ?? {}) as Record<string, unknown>;
  const addr = o.address;
  const address =
    str(addr) ??
    str((addr as Record<string, unknown> | null)?.mapItemFullAddressLabel) ??
    str((addr as Record<string, unknown> | null)?.label) ??
    null;
  return {
    id: str(o.id) ?? str(o.name) ?? `device-${index}`,
    name: str(o.name) ?? str(o.deviceModel) ?? str(o.modelDisplayName) ?? 'Device',
    batteryLevel: num(o.batteryLevel),
    latitude: num(loc.latitude),
    longitude: num(loc.longitude),
    address,
  };
}

/**
 * Normalize a raw Find My friend. The server sends `coordinates: [lat, lng]`,
 * `title`/`subtitle`, `short_address`/`long_address`, and `last_updated`.
 */
export function normalizeFriend(raw: unknown, index: number): FindMyFriend {
  const o = (raw ?? {}) as Record<string, unknown>;
  const coords = Array.isArray(o.coordinates) ? (o.coordinates as unknown[]) : [];
  const handle = (o.handle ?? {}) as Record<string, unknown>;
  return {
    id: str(o.id) ?? str(handle.address) ?? str(o.title) ?? `friend-${index}`,
    name: str(o.title) ?? str(handle.address) ?? str(o.subtitle) ?? 'Unknown',
    address: str(o.short_address) ?? str(o.long_address) ?? str(o.subtitle) ?? null,
    latitude: num(coords[0]),
    longitude: num(coords[1]),
    lastUpdated: num(o.last_updated),
  };
}
