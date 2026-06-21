export interface VLocationData {
  latitude: number;
  longitude: number;
  url: string;
}

/**
 * Parse an Apple location attachment (.loc.vcf / text/x-vlocation) — a vCard whose
 * URL line is an Apple Maps link. CRITICAL: Apple encodes the coordinate as
 * `ll=<longitude>,<latitude>` (longitude first — confirmed in the Flutter
 * `createAppleLocation(longitude, latitude)` template), and the comma is usually
 * backslash-escaped (`\,`) or percent-encoded (`%2C`). Returns null if no parseable
 * URL/coords. Pure + Node-testable.
 */
export function parseVLocation(content: string): VLocationData | null {
  const unfolded = content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const urlLine = unfolded.match(/^URL[^:\n]*:(.*)$/im);
  if (!urlLine) return null;
  const url = urlLine[1]!.trim();

  const ll = url.match(/[?&]ll=(-?[0-9.]+)(?:\\,|%2C|,)(-?[0-9.]+)/i);
  if (!ll) return null;
  const longitude = Number.parseFloat(ll[1]!);
  const latitude = Number.parseFloat(ll[2]!);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;

  return { latitude, longitude, url };
}
