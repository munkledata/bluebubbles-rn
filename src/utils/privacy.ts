/**
 * Pure redaction helpers for privacy ("redacted") mode. Generic placeholders (no
 * lorem-ipsum / fake names) — the goal is to hide content from a glance, not to
 * fabricate plausible text. Empty inputs stay empty so layout doesn't shift.
 *
 * REDACTION MUST COVER DERIVED DATA, NOT JUST LABELS. Redacted mode exists so a screenshot is
 * safe, and a real pin on a real street is more identifying than a name — so masking a marker's
 * label while still plotting its true coordinates defeats the whole feature. That was a live
 * defect in the Find My screen. Coordinates therefore go through {@link resolveDisplayPoint}, and
 * any FUTURE derived field (last-updated time, live status, altitude, speed, precise battery)
 * belongs in this module too rather than being masked ad hoc at a render site.
 *
 * WITHHOLD, DON'T DECOY. We hide the point rather than substituting a plausible fake one. A decoy
 * is worse than nothing: it looks authoritative, so a viewer (or the user themself) can't tell a
 * redacted map from a real one, and "somewhere near home" still narrows a location.
 */

/** Mask a conversation-list message preview. */
export function redactPreview(text: string, redacted: boolean): string {
  if (!redacted) return text;
  return text ? 'Message' : '';
}

/**
 * The single masking primitive: swap `value` for a generic `placeholder` when redacted.
 * Empty input stays empty so layout doesn't shift.
 */
export function redactLabel(value: string, placeholder: string, redacted: boolean): string {
  if (!redacted) return value;
  return value ? placeholder : '';
}

/** Mask a contact / chat title (name). */
export function redactTitle(title: string, redacted: boolean): string {
  return redactLabel(title, 'Contact', redacted);
}

/** Mask a chat message body. Null stays empty. */
export function redactMessageText(text: string | null | undefined, redacted: boolean): string {
  if (!redacted) return text ?? '';
  return text ? 'Message' : '';
}

/**
 * A location that is safe to render, or an explicit "don't".
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

/** The one hidden instance, so a redacted result is referentially stable. */
export const HIDDEN_POINT: DisplayPoint = { visible: false };

/**
 * Resolve a stored coordinate pair into something renderable.
 *
 * Hidden when redacted, and hidden when either value is missing or non-finite — so a
 * half-located device can never plot at (0, 0), which would point at the Gulf of Guinea.
 */
export function resolveDisplayPoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  redacted: boolean,
): DisplayPoint {
  if (redacted) return HIDDEN_POINT;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return HIDDEN_POINT;
  return { visible: true, latitude: latitude as number, longitude: longitude as number };
}

/**
 * Whether a coordinate pair exists at all — IGNORING redaction.
 *
 * Used only to choose copy ("Location available" vs "No location"). "This device is locatable" is
 * not itself identifying, and hiding it would make a redacted list unreadable.
 */
export function hasCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}

/**
 * The secondary line for a locatable thing. A reverse-geocoded street address is fully
 * identifying, so under redaction it collapses to the same coarse copy as a missing address.
 */
export function redactLocationDetail(
  detail: string | null | undefined,
  located: boolean,
  redacted: boolean,
): string {
  const fallback = located ? 'Location available' : 'No location';
  if (redacted) return fallback;
  return detail ?? fallback;
}

/**
 * Battery as a whole percent, or null when it should not be shown.
 *
 * Battery level is a surprisingly strong correlator (it identifies a specific physical device
 * across screenshots), so redacted mode drops it entirely rather than coarsening it.
 */
export function redactBatteryPercent(
  level: number | null | undefined,
  redacted: boolean,
): number | null {
  if (redacted || !Number.isFinite(level)) return null;
  return Math.round((level as number) * 100);
}
