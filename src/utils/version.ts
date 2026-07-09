/**
 * Minimal dotted-numeric version comparison (no pre-release semantics needed for
 * Gator server versions like "1.9.5"). Non-numeric segments are treated
 * as 0 and extra segments are zero-padded.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function isAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

function parse(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
}
