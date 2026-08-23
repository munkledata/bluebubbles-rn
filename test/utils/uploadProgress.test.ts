import {
  formatPercent,
  formatTransferred,
  isTransferStalled,
  rollupTransfers,
  transferRatio,
  uploadBarLabels,
  UPLOAD_STALL_MS,
} from '@utils/uploadProgress';

const KB = 1024;
const MB = 1024 * 1024;

describe('transferRatio', () => {
  it('divides sent by total', () => {
    expect(transferRatio(25, 100)).toBe(0.25);
  });

  it('reports an unknown total as indeterminate rather than 0%', () => {
    // The normal state at the very start of every upload: a voice memo is staged with size 0 and
    // the native uploader only reports the real length on its first progress event. Rendering
    // that as 0% gives a bar that sits dead at zero and then jumps.
    expect(transferRatio(0, 0)).toBeNull();
    expect(transferRatio(10, -1)).toBeNull();
  });

  it('clamps into [0,1] and rejects non-finite input', () => {
    expect(transferRatio(500, 100)).toBe(1);
    expect(transferRatio(-5, 100)).toBe(0);
    expect(transferRatio(Number.NaN, 100)).toBeNull();
    expect(transferRatio(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0.356)).toBe('36%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('passes indeterminate through as null', () => {
    expect(formatPercent(null)).toBeNull();
  });
});

describe('formatTransferred', () => {
  it('reads "<sent> of <total>" when both are known', () => {
    expect(formatTransferred(512 * KB, MB)).toBe('512 KB of 1 MB');
  });

  it('spells out a zero sent count', () => {
    // friendlySize renders 0 as an EMPTY string, which would leave a dangling " of 1 MB".
    expect(formatTransferred(0, MB)).toBe('0 B of 1 MB');
  });

  it('falls back to the sent amount alone while the total is unknown', () => {
    expect(formatTransferred(512 * KB, 0)).toBe('512 KB');
    expect(formatTransferred(0, 0)).toBe('0 B');
  });
});

describe('uploadBarLabels', () => {
  it('names the single file being sent', () => {
    expect(uploadBarLabels([{ name: 'photo.jpg', sent: 512 * KB, total: MB }])).toEqual({
      title: 'Sending photo.jpg',
      detail: '512 KB of 1 MB · 50%',
    });
  });

  it('counts them once there is more than one', () => {
    const labels = uploadBarLabels([
      { name: 'a.jpg', sent: 100, total: 400 },
      { name: 'b.jpg', sent: 100, total: 600 },
      { name: 'c.jpg', sent: 0, total: 1000 },
    ]);
    expect(labels?.title).toBe('Sending 3 files');
    expect(labels?.detail).toContain('10%'); // 200 sent of 2000 total
  });

  it('omits the percentage while any total is unknown', () => {
    const labels = uploadBarLabels([
      { name: 'a.jpg', sent: 100, total: 400 },
      { name: 'memo.m4a', sent: 50, total: 0 },
    ]);
    expect(labels?.detail).not.toContain('%');
  });

  it('replaces the numbers with a warning when stalled', () => {
    // Not appended to them: the byte count is exactly what is NOT moving, so showing it beside a
    // stall warning reads as though progress is still being made.
    const labels = uploadBarLabels([{ name: 'photo.jpg', sent: 512 * KB, total: MB }], {
      stalled: true,
    });
    expect(labels?.detail).toBe('Stalled — check your connection');
    expect(labels?.title).toBe('Sending photo.jpg');
  });

  it('falls back to a generic name when the file has none', () => {
    expect(uploadBarLabels([{ name: '   ', sent: 0, total: 10 }])?.title).toBe(
      'Sending attachment',
    );
  });

  it('returns null for an empty set — the signal to render no bar at all', () => {
    expect(uploadBarLabels([])).toBeNull();
  });
});

describe('isTransferStalled', () => {
  it('is false while bytes are still moving', () => {
    expect(isTransferStalled(1_000_000, 1_000_000 + 5_000)).toBe(false);
  });

  it('is true after the threshold of complete silence', () => {
    expect(isTransferStalled(1_000_000, 1_000_000 + UPLOAD_STALL_MS)).toBe(true);
    expect(isTransferStalled(1_000_000, 1_000_000 + UPLOAD_STALL_MS + 1)).toBe(true);
  });

  it('never flags an upload that has not reported yet', () => {
    // Every upload passes through this state in its first moments; flagging it would make each
    // send flash a "stalled" warning before it had a chance to move a byte.
    expect(isTransferStalled(0, 9_999_999)).toBe(false);
  });

  it('accepts a custom threshold', () => {
    expect(isTransferStalled(1000, 3000, 1000)).toBe(true);
    expect(isTransferStalled(1000, 3000, 5000)).toBe(false);
  });
});

describe('rollupTransfers', () => {
  it('sums a batch into one determinate bar', () => {
    const r = rollupTransfers([
      { sent: 100, total: 400 },
      { sent: 100, total: 600 },
    ]);
    expect(r).toEqual({ count: 2, sent: 200, total: 1000, ratio: 0.2 });
  });

  it('goes indeterminate when ANY total is still unknown, but keeps summing the known ones', () => {
    // A denominator that grows as each file reports in would make the bar march backwards, which
    // reads as a broken upload — so the percentage waits, while the size readout stays useful.
    const r = rollupTransfers([
      { sent: 100, total: 400 },
      { sent: 50, total: 0 },
    ]);
    expect(r.ratio).toBeNull();
    expect(r.sent).toBe(150);
    expect(r.total).toBe(400);
    expect(r.count).toBe(2);
  });

  it('handles an empty batch', () => {
    expect(rollupTransfers([])).toEqual({ count: 0, sent: 0, total: 0, ratio: null });
  });
});
