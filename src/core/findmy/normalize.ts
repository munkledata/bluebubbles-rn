import type { FindMyDevice, FindMyFriend } from './types';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Normalize a raw Find My device. Tolerates both shapes: the Gator fork emits
 * `{ name, deviceModel, batteryLevel, coordinates: [lat, lng] }` (no id/address); upstream
 * emits `location: { latitude, longitude }` + an `address` string/object.
 */
export function normalizeDevice(raw: unknown, index: number): FindMyDevice {
  const o = (raw ?? {}) as Record<string, unknown>;
  const loc = (o.location ?? {}) as Record<string, unknown>;
  const coords = Array.isArray(o.coordinates) ? (o.coordinates as unknown[]) : [];
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
    latitude: num(coords[0]) ?? num(loc.latitude), // Gator: coordinates tuple; upstream: location
    longitude: num(coords[1]) ?? num(loc.longitude),
    address,
  };
}

/**
 * Normalize a raw Find My friend. Tolerates both shapes: the Gator fork emits
 * `{ handle: string, coordinates: [lat, lng], shortAddress, longAddress }` (no id/name/
 * lastUpdated); upstream emits a `handle` object + `title`/`subtitle` + snake_case addresses.
 */
export function normalizeFriend(raw: unknown, index: number): FindMyFriend {
  const o = (raw ?? {}) as Record<string, unknown>;
  const coords = Array.isArray(o.coordinates) ? (o.coordinates as unknown[]) : [];
  // Gator: handle is a plain string. Upstream: handle is an object with `.address`.
  const handleStr = str(o.handle);
  const handleAddr = str((o.handle as Record<string, unknown> | null)?.address);
  const shortAddr = str(o.shortAddress) ?? str(o.short_address);
  const longAddr = str(o.longAddress) ?? str(o.long_address);
  return {
    id: str(o.id) ?? handleStr ?? handleAddr ?? str(o.title) ?? shortAddr ?? `friend-${index}`,
    name: str(o.title) ?? shortAddr ?? handleStr ?? handleAddr ?? 'Unknown',
    address: longAddr ?? shortAddr ?? str(o.subtitle) ?? null,
    latitude: num(coords[0]),
    longitude: num(coords[1]),
    lastUpdated: num(o.last_updated),
  };
}
