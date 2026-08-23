import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MAX_FILES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
  ATTACHMENT_CACHE_RECENT_GRACE_MS,
  planAttachmentCacheAdmission,
  planAttachmentCacheConformance,
  type AttachmentCacheConformancePlanInput,
  type AttachmentCacheQuotaPlanInput,
} from '@/services/download/attachmentCacheQuotaPolicy';

const NOW = 2_000_000;
const old = (
  path: string,
  bytes: number,
  lastUsedAt = 1,
): { path: string; bytes: number; lastUsedAt: number } => ({
  path,
  bytes,
  lastUsedAt,
});

function input(
  overrides: Partial<AttachmentCacheQuotaPlanInput> = {},
): AttachmentCacheQuotaPlanInput {
  return {
    usage: { bytes: 0, files: 0 },
    pendingWriteBytes: 0,
    incomingBytes: 10,
    availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 100,
    now: NOW,
    candidates: [],
    ...overrides,
  };
}

function conformanceInput(
  overrides: Partial<AttachmentCacheConformancePlanInput> = {},
): AttachmentCacheConformancePlanInput {
  return {
    usage: { bytes: 0, files: 0 },
    availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES,
    now: NOW,
    candidates: [],
    ...overrides,
  };
}

describe('attachment cache quota policy', () => {
  it('pins the global byte, file, free-space, and grace limits', () => {
    expect(ATTACHMENT_CACHE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(ATTACHMENT_CACHE_MAX_FILES).toBe(4096);
    expect(ATTACHMENT_CACHE_MIN_FREE_BYTES).toBe(512 * 1024 * 1024);
    expect(ATTACHMENT_CACHE_RECENT_GRACE_MS).toBe(10 * 60 * 1000);
  });

  it('admits a file without eviction when every projected bound remains healthy', () => {
    expect(planAttachmentCacheAdmission(input())).toEqual({
      allowed: true,
      retirePaths: [],
      projectedBytes: 10,
      projectedFiles: 1,
      projectedAvailableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 90,
    });
  });

  it('selects deterministic LRU paths until both byte and file pressure are relieved', () => {
    const plan = planAttachmentCacheAdmission(
      input({
        usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES - 5, files: ATTACHMENT_CACHE_MAX_FILES },
        incomingBytes: 10,
        availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 100,
        candidates: [old('/c', 3, 10), old('/b', 3, 1), old('/a', 3, 1)],
      }),
    );

    expect(plan).toEqual(expect.objectContaining({ allowed: true, retirePaths: ['/a', '/b'] }));

    const reversed = planAttachmentCacheAdmission(
      input({
        usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES - 5, files: ATTACHMENT_CACHE_MAX_FILES },
        incomingBytes: 10,
        availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 100,
        candidates: [old('/a', 3, 1), old('/b', 3, 1), old('/c', 3, 10)],
      }),
    );
    expect(reversed).toEqual(expect.objectContaining({ retirePaths: ['/a', '/b'] }));
  });

  it('evicts enough actual bytes to preserve the native free-space floor', () => {
    const plan = planAttachmentCacheAdmission(
      input({
        availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 4,
        incomingBytes: 10,
        candidates: [old('/small', 5), old('/enough', 2, 2)],
      }),
    );

    expect(plan).toEqual(
      expect.objectContaining({
        allowed: true,
        retirePaths: ['/small', '/enough'],
        projectedAvailableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 1,
      }),
    );
  });

  it('charges durable concurrent reservations against both quota and free space', () => {
    const plan = planAttachmentCacheAdmission(
      input({
        // The prior 15-byte reservation is already represented in these durable ledger totals.
        usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES - 5, files: ATTACHMENT_CACHE_MAX_FILES - 1 },
        pendingWriteBytes: 15,
        incomingBytes: 10,
        availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 25,
        candidates: [old('/old', 5)],
      }),
    );

    expect(plan).toEqual(expect.objectContaining({ allowed: true, retirePaths: ['/old'] }));
  });

  it('never selects protected or recently-used files and rejects when they alone exceed capacity', () => {
    expect(
      planAttachmentCacheAdmission(
        input({
          usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES, files: 1 },
          candidates: [
            old('/protected', 20),
            old('/recent', 20, NOW - ATTACHMENT_CACHE_RECENT_GRACE_MS + 1),
          ],
          protectedPaths: new Set(['/protected']),
        }),
      ),
    ).toEqual({ allowed: false, reason: 'insufficient_capacity' });
  });

  it('keeps the exact ten-minute boundary in grace and evicts only strictly older rows', () => {
    const boundary = NOW - ATTACHMENT_CACHE_RECENT_GRACE_MS;
    expect(
      planAttachmentCacheAdmission(
        input({
          usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES, files: 2 },
          candidates: [old('/at-boundary', 20, boundary), old('/older', 20, boundary - 1)],
        }),
      ),
    ).toEqual(expect.objectContaining({ allowed: true, retirePaths: ['/older'] }));
  });

  it('keeps retiring/non-candidate bytes charged and fails closed when nothing eligible can free them', () => {
    expect(
      planAttachmentCacheAdmission(
        input({
          usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES, files: 1 },
          candidates: [],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'insufficient_capacity' });
  });

  it('rejects an individually oversized transfer and malformed accounting inputs', () => {
    expect(
      planAttachmentCacheAdmission(input({ incomingBytes: ATTACHMENT_CACHE_MAX_BYTES + 1 })),
    ).toEqual({ allowed: false, reason: 'incoming_too_large' });
    expect(() => planAttachmentCacheAdmission(input({ pendingWriteBytes: -1 }))).toThrow(
      'non-negative safe integer',
    );
    expect(() =>
      planAttachmentCacheAdmission(
        input({
          candidates: [old('/same', 1), old('/same', 1)],
        }),
      ),
    ).toThrow('unique paths');
  });

  it('checks current conformance without pretending to add an incoming file', () => {
    expect(
      planAttachmentCacheConformance(
        conformanceInput({
          usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES, files: ATTACHMENT_CACHE_MAX_FILES },
        }),
      ),
    ).toEqual({
      withinQuota: true,
      canConform: true,
      retirePaths: [],
      byteShortfall: 0,
      fileShortfall: 0,
      freeSpaceShortfall: 0,
      projectedBytes: ATTACHMENT_CACHE_MAX_BYTES,
      projectedFiles: ATTACHMENT_CACHE_MAX_FILES,
      projectedAvailableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES,
    });
  });

  it('selects deterministic old rows for current byte and file shortfalls', () => {
    const plan = planAttachmentCacheConformance(
      conformanceInput({
        usage: {
          bytes: ATTACHMENT_CACHE_MAX_BYTES + 5,
          files: ATTACHMENT_CACHE_MAX_FILES + 2,
        },
        candidates: [old('/c', 10, 2), old('/b', 3, 1), old('/a', 3, 1)],
      }),
    );

    expect(plan).toEqual({
      withinQuota: false,
      canConform: true,
      retirePaths: ['/a', '/b'],
      byteShortfall: 5,
      fileShortfall: 2,
      freeSpaceShortfall: 0,
      projectedBytes: ATTACHMENT_CACHE_MAX_BYTES - 1,
      projectedFiles: ATTACHMENT_CACHE_MAX_FILES,
      projectedAvailableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 6,
    });
  });

  it('computes native free-space pressure from the current file set only', () => {
    expect(
      planAttachmentCacheConformance(
        conformanceInput({
          usage: { bytes: 7, files: 2 },
          availableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES - 6,
          candidates: [old('/five', 5), old('/two', 2, 2)],
        }),
      ),
    ).toEqual({
      withinQuota: false,
      canConform: true,
      retirePaths: ['/five', '/two'],
      byteShortfall: 0,
      fileShortfall: 0,
      freeSpaceShortfall: 6,
      projectedBytes: 0,
      projectedFiles: 0,
      projectedAvailableBytes: ATTACHMENT_CACHE_MIN_FREE_BYTES + 1,
    });
  });

  it('returns only a safe partial plan when protected, recent, or non-active usage blocks conformance', () => {
    const plan = planAttachmentCacheConformance(
      conformanceInput({
        usage: { bytes: ATTACHMENT_CACHE_MAX_BYTES + 5, files: 4 },
        candidates: [
          old('/protected', 20),
          old('/recent', 20, NOW - ATTACHMENT_CACHE_RECENT_GRACE_MS),
          old('/partial', 2, 2),
        ],
        protectedPaths: new Set(['/protected']),
      }),
    );

    expect(plan).toEqual(
      expect.objectContaining({
        withinQuota: false,
        canConform: false,
        retirePaths: ['/partial'],
        byteShortfall: 5,
      }),
    );
  });

  it('validates every current-conformance input before taking the healthy fast path', () => {
    expect(() =>
      planAttachmentCacheConformance(conformanceInput({ usage: { bytes: -1, files: 0 } })),
    ).toThrow('non-negative safe integers');
    expect(() =>
      planAttachmentCacheConformance(conformanceInput({ availableBytes: Number.NaN })),
    ).toThrow('availableBytes');
    expect(() => planAttachmentCacheConformance(conformanceInput({ now: -1 }))).toThrow('now');
    expect(() =>
      planAttachmentCacheConformance(
        conformanceInput({ candidates: [old('/same', 1), old('/same', 2)] }),
      ),
    ).toThrow('unique paths');
    expect(() =>
      planAttachmentCacheConformance(conformanceInput({ protectedPaths: new Set(['']) })),
    ).toThrow('must not be empty');
  });
});
