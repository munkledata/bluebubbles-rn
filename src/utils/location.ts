/**
 * A real-world coordinate pair that is safe to render, or an explicit "don't".
 *
 * This is a DISCRIMINATED UNION on purpose, and it is the anti-drift device of this module: the
 * hidden branch carries no numeric fields at all, so TypeScript refuses to let a caller read a
 * coordinate without first narrowing on `visible`. Never add optional `latitude?`/`longitude?`
 * to the hidden branch and never cast — that would silently restore the leak this type exists to
 * make impossible.
 */
export type DisplayPoint =
  | { readonly visible: true; readonly latitude: number; readonly longitude: number }
  | { readonly visible: false };

/** The one hidden instance, so an invalid or incomplete result is referentially stable. */
export const HIDDEN_POINT: DisplayPoint = { visible: false };

/**
 * Resolve a stored coordinate pair into something renderable.
 *
 * Hidden when either value is missing, non-finite, or outside the geographic latitude/longitude
 * ranges, so malformed server data never crosses into a native map or external maps intent.
 */
export function resolveDisplayPoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): DisplayPoint {
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return HIDDEN_POINT;
  }
  return { visible: true, latitude, longitude };
}

/** Whether a complete real-world coordinate pair exists. */
export function hasCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return resolveDisplayPoint(latitude, longitude).visible;
}
