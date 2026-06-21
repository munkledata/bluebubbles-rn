/** A normalized Find My device (subset of the server payload we render). */
export interface FindMyDevice {
  id: string;
  name: string;
  batteryLevel: number | null; // 0..1
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

/** A normalized Find My friend/person. */
export interface FindMyFriend {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  lastUpdated: number | null;
}
