/**
 * A finite coordinate pair that is safe to render, or an explicit "don't".
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
 * Hidden when either value is missing or non-finite, so a half-located device can never plot at
 * (0, 0), which would point at the Gulf of Guinea.
 */
export function resolveDisplayPoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): DisplayPoint {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return HIDDEN_POINT;
  return { visible: true, latitude: latitude as number, longitude: longitude as number };
}

/** Whether a complete finite coordinate pair exists. */
export function hasCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}
