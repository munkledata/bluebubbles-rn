import type { HttpClient } from '@core/api/http';
import type { MessageTargetServerAuthorization } from '@db/repositories';
import type { DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';

const RETIRED_MESSAGE = 'Editing and unsending iMessages were retired with the Private API helper.';

export interface SendEditArgs {
  messageGuid: string;
  newText: string;
  chatGuid?: string;
  partIndex?: number;
}

export interface SendUnsendArgs {
  messageGuid: string;
  chatGuid?: string;
  partIndex?: number;
}

/** Retained boundary for stale internal callers; retirement happens before DB or HTTP work. */
export function sendEdit(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<{ ok: boolean }> {
  void db;
  void http;
  void args;
  void now;
  void commitGuard;
  void serverAuthorization;
  return Promise.reject(new Error(RETIRED_MESSAGE));
}

/** Retained boundary for stale internal callers; retirement happens before DB or HTTP work. */
export function sendUnsend(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<{ ok: boolean }> {
  void db;
  void http;
  void args;
  void now;
  void commitGuard;
  void serverAuthorization;
  return Promise.reject(new Error(RETIRED_MESSAGE));
}
