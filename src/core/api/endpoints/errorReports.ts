import { z } from 'zod/v4';
import type { HttpClient } from '../http';

/**
 * POST /api/v1/error-reports — upload a batch of ALREADY-redacted client error reports so the
 * server can fingerprint (categorize) them and write them to disk. Gated app-side on the
 * `supports_error_log_upload` capability; the server also re-checks its `errorLogIngestionEnabled`
 * config and answers `{ disabled: true }` when off (defense-in-depth against a stale capability).
 *
 * `retry: false` — the durable `error_reports` queue owns retries (backoff + attempt cap), so the
 * POST must not double-send. Everything here is already scrubbed of secrets by the redacting logger
 * before it was ever buffered.
 */
const Ack = z.object({ ingested: z.number().nullish(), disabled: z.boolean().nullish() }).loose();

/** One captured report in an upload batch (redacted; timestamp is the capture time, epoch ms). */
export interface ErrorReportUpload {
  level: string;
  message: string;
  stack?: string;
  tag?: string;
  timestamp: number;
  meta?: string;
}

/** A batch upload: the reports plus this device's constant context (for server-side bucketing). */
export interface ErrorReportBatch {
  reports: ErrorReportUpload[];
  appVersion?: string;
  platform?: string;
  osVersion?: string;
  deviceModel?: string;
}

export async function uploadErrorReports(
  http: HttpClient,
  batch: ErrorReportBatch,
): Promise<{ ingested: number; disabled: boolean }> {
  const res = await http.post('/error-reports', Ack, { json: batch, retry: false });
  return { ingested: res.ingested ?? 0, disabled: res.disabled ?? false };
}
