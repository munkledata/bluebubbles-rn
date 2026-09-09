import type { AppDatabase } from '@db/types';
import { resolveAuthorizedRealtimeTransport } from '../background/authorizedRealtimeTransport';
import { ensureSyncedBackground } from './syncedBackground';

/** Realtime group-event entry point; best-effort failures remain owned by the decorating sink. */
export async function ensureSyncedBackgroundForRealtimeEvent(
  db: AppDatabase,
  guid: string,
  expectedAccountGeneration?: number,
): Promise<void> {
  const transport = await resolveAuthorizedRealtimeTransport(expectedAccountGeneration);
  if (!transport) return;
  await ensureSyncedBackground(transport.http, db, guid, transport.lease);
}
