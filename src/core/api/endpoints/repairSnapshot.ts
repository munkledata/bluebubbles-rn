import { z } from 'zod/v4';
import type { HttpClient } from '../http';
import { ApiError, UnimplementedEndpointError } from '../errors';

const ENDPOINT = '/sync/repair-snapshot';
const Token = z.string().uuid();
const BeginResult = z
  .object({
    version: z.literal(1),
    action: z.literal('begin'),
    token: Token,
    expiresAt: z.number().int().positive(),
  })
  .strict();
const FinishResult = z
  .object({ version: z.literal(1), action: z.literal('finish'), stable: z.literal(true) })
  .strict();
const CancelResult = z
  .object({ version: z.literal(1), action: z.literal('cancel'), cancelled: z.boolean() })
  .strict();

export interface RepairSnapshotLease {
  readonly token: string;
  readonly expiresAt: number;
}

/** Snapshot support exists, but the server cannot freeze its independently-owned RCS cache. */
export class RepairSnapshotRcsActiveError extends Error {
  constructor(cause?: unknown) {
    super('Stable deletion initialization is deferred while RCS is enabled.', { cause });
    this.name = 'RepairSnapshotRcsActiveError';
  }
}

function surfaceSafeServerDetail(error: unknown, missingMeansUnsupported = false): never {
  if (missingMeansUnsupported && error instanceof ApiError && error.status === 404) {
    throw new UnimplementedEndpointError(ENDPOINT);
  }
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.serverErrorType === 'repair_snapshot_rcs_active'
  ) {
    throw new RepairSnapshotRcsActiveError(error);
  }
  if (error instanceof ApiError && error.serverDetail) {
    throw new Error(error.serverDetail, { cause: error });
  }
  throw error;
}

/** Begin one short-lived server-stability proof before an all-history repair crawl. */
export async function begin(http: HttpClient, signal?: AbortSignal): Promise<RepairSnapshotLease> {
  try {
    const result = await http.post(ENDPOINT, BeginResult, {
      json: { action: 'begin' },
      signal,
      retry: false,
      captureErrorDetail: true,
    });
    return { token: result.token, expiresAt: result.expiresAt };
  } catch (error) {
    return surfaceSafeServerDetail(error, true);
  }
}

/** Consume the proof. Success means the server read universe stayed unchanged for the crawl. */
export async function finish(http: HttpClient, token: string, signal?: AbortSignal): Promise<void> {
  try {
    await http.post(ENDPOINT, FinishResult, {
      json: { action: 'finish', token },
      signal,
      retry: false,
      captureErrorDetail: true,
    });
  } catch (error) {
    surfaceSafeServerDetail(error);
  }
}

/** Best-effort early release after a non-terminal repair failure; server expiry is the fallback. */
export async function cancel(http: HttpClient, token: string, signal?: AbortSignal): Promise<void> {
  try {
    await http.post(ENDPOINT, CancelResult, {
      json: { action: 'cancel', token },
      signal,
      retry: false,
    });
  } catch {
    // Cleanup is not repair authority. The bounded server lease expires automatically.
  }
}
