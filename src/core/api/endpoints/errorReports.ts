import { z } from 'zod/v4';
import type { HttpClient } from '../http';

/**
 * POST /api/v1/error-reports — upload a batch of strictly projected client error reports so the
 * server can fingerprint (categorize) them and write them to disk. Gated app-side on the
 * `supports_error_log_upload` capability; the server also re-checks its `errorLogIngestionEnabled`
 * config and answers `{ disabled: true }` when off (defense-in-depth against a stale capability).
 *
 * `retry: false` — the durable `error_reports` queue owns retries (backoff + attempt cap), so the
 * POST must not double-send. Every report was rebuilt from a finite event/field allowlist before
 * persistence and again immediately before this boundary.
 */
const Ack = z
  .object({ ingested: z.number().int().nonnegative().nullish(), disabled: z.boolean().nullish() })
  .loose();

/** One structured report in an upload batch (timestamp is minute-rounded epoch ms). */
export interface ErrorReportUpload {
  level: string;
  message: string;
  stack?: string;
  tag?: string;
  timestamp: number;
  meta?: string;
}

/** A batch upload: reports plus privacy-safe context retained with the server's diagnostic sample. */
export interface ErrorReportBatch {
  reports: ErrorReportUpload[];
  appVersion?: string;
  platform?: string;
  osVersion?: string;
}

export async function uploadErrorReports(
  http: HttpClient,
  batch: ErrorReportBatch,
  signal?: AbortSignal,
): Promise<{ ingested: number; disabled: boolean }> {
  const res = await http.post('/error-reports', Ack, { json: batch, retry: false, signal });
  return { ingested: res.ingested ?? 0, disabled: res.disabled ?? false };
}
