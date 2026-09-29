export interface VLocationData {
  latitude: number;
  longitude: number;
  url: string;
}

/**
 * Parse an Apple location attachment (.loc.vcf / text/x-vlocation) — a vCard whose
 * URL line is an Apple Maps link. Apple encodes the coordinate as
 * `ll=<latitude>,<longitude>`; the comma is commonly backslash-escaped (`\,`) in
 * vCards or percent-encoded (`%2C`). Returns null if the URL or coordinates are
 * missing, malformed, non-finite, or outside the valid latitude/longitude ranges.
 * Pure + Node-testable.
 */
export function parseVLocation(content: string): VLocationData | null {
  const unfolded = content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const urlLine = unfolded.match(/^URL[^:\n]*:(.*)$/im);
  if (!urlLine) return null;
  const url = urlLine[1]!.trim();

  const ll = url.match(
    /[?&]ll=(-?(?:\d+(?:\.\d+)?|\.\d+))(?:\\,|%2C|,)(-?(?:\d+(?:\.\d+)?|\.\d+))(?:[&#]|$)/i,
  );
  if (!ll) return null;
  const latitude = Number.parseFloat(ll[1]!);
  const longitude = Number.parseFloat(ll[2]!);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude, url };
}
