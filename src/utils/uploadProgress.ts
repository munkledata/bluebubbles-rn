/**
 * Pure display math for in-flight uploads.
 *
 * Lives in `@utils` rather than in the store so the bubble ring, the file chip and the composer
 * status bar all read ONE implementation, and so the rollup arithmetic is node-testable without
 * pulling in React Native.
 */

import { friendlySize } from './attachment';

/**
 * Bytes → ratio in [0,1]; `null` means INDETERMINATE — render a spinner, not "0%".
 *
 * An unknown total is the normal state at the very start of an upload, not an error: a voice memo
 * is staged with `size: 0`, and the native uploader only reports the real content length on its
 * FIRST progress event. Rendering that as 0% gives a bar that sits dead at zero and then jumps,
 * which reads as a stalled send.
 *
 * (`progressRatio` in `@state/downloadStore` is the download-side twin. It is deliberately not
 * shared: `@utils` must not depend on `@state`, and that one is bound to the download store's
 * own callback shape.)
 */
export function transferRatio(sent: number, total: number): number | null {
  if (!Number.isFinite(sent) || !Number.isFinite(total)) return null;
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, sent / total));
}

/** "35%" — or null when the total is not known yet. */
export function formatPercent(ratio: number | null): string | null {
  return ratio == null ? null : `${Math.round(ratio * 100)}%`;
}

/**
 * "4.2 MB of 12.1 MB" — the size readout, falling back to just the sent amount while the total
 * is unknown.
 *
 * `friendlySize` renders 0 as an EMPTY string, so the zero case is spelled out here: an upload
 * that has sent nothing yet must still read "0 B of 12.1 MB", never " of 12.1 MB".
 */
export function formatTransferred(sent: number, total: number): string {
  const sentLabel = Number.isFinite(sent) && sent > 0 ? friendlySize(sent) : '0 B';
  const totalLabel = Number.isFinite(total) && total > 0 ? friendlySize(total) : '';
  return totalLabel ? `${sentLabel} of ${totalLabel}` : sentLabel;
}

/**
 * How long an upload may go without a single byte of progress before it is called stalled.
 *
 * Generous on purpose: the native side throttles progress events to one per 100 ms, but a phone
 * handing off between cells or waking from doze can genuinely go quiet for several seconds while
 * the transfer is still alive. Twenty seconds of true silence is a connection problem, not a slow
 * link — a slow link still moves bytes.
 */
export const UPLOAD_STALL_MS = 20_000;

/**
 * Has this upload gone silent? `updatedAt` is the entry's last progress timestamp.
 *
 * A zero/absent timestamp is NOT stalled — that is an entry that has not reported yet, which is
 * every upload for its first moments, and flagging those would make every send flash a warning.
 */
export function isTransferStalled(
  updatedAt: number,
  now: number,
  thresholdMs: number = UPLOAD_STALL_MS,
): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (!Number.isFinite(now)) return false;
  return now - updatedAt >= thresholdMs;
}

export interface TransferRollup {
  /** How many transfers were rolled up. */
  count: number;
  sent: number;
  /** Sum of the totals that are KNOWN — see the note on `ratio`. */
  total: number;
  /** null = indeterminate. */
  ratio: number | null;
}

/**
 * Roll N in-flight uploads into one bar.
 *
 * If ANY entry's total is still unknown the combined ratio is `null` rather than a ratio over the
 * known subset: a denominator that grows as each file reports in makes the bar march BACKWARDS,
 * which reads as a broken upload. The size readout stays useful because `total` still sums what
 * is known — it is only the percentage that waits until every file has reported.
 */
export interface UploadBarLabels {
  /** What is being sent — "Sending photo.jpg" / "Sending 3 files". */
  title: string;
  /** How far along — "4.2 MB of 12.1 MB · 35%", or the stall warning. */
  detail: string;
}

/**
 * The two lines of the composer's upload bar. Returns null when nothing is in flight, which is
 * also the signal to render no bar at all.
 *
 * Pure so the wording is node-testable and the component stays a thin shell around it.
 */
export function uploadBarLabels(
  entries: readonly { name: string; sent: number; total: number }[],
  opts?: { stalled?: boolean },
): UploadBarLabels | null {
  if (entries.length === 0) return null;
  const roll = rollupTransfers(entries);
  const first = entries[0];
  const title =
    entries.length === 1
      ? `Sending ${first?.name?.trim() || 'attachment'}`
      : `Sending ${entries.length} files`;
  if (opts?.stalled) {
    // Replaces the numbers rather than joining them: the byte count is what is NOT moving, so
    // repeating it next to a stall warning reads as though progress is still being made.
    return { title, detail: 'Stalled — check your connection' };
  }
  const percent = formatPercent(roll.ratio);
  const transferred = formatTransferred(roll.sent, roll.total);
  return { title, detail: percent ? `${transferred} · ${percent}` : transferred };
}

export function rollupTransfers(
  entries: readonly { sent: number; total: number }[],
): TransferRollup {
  let sent = 0;
  let total = 0;
  let anyUnknown = false;
  for (const e of entries) {
    if (Number.isFinite(e.sent) && e.sent > 0) sent += e.sent;
    if (Number.isFinite(e.total) && e.total > 0) total += e.total;
    else anyUnknown = true;
  }
  return {
    count: entries.length,
    sent,
    total,
    ratio: anyUnknown ? null : transferRatio(sent, total),
  };
}
