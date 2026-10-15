/**
 * Backup restore re-implements the auto-download policy in SQL so it can revoke conflicting
 * pending "copy to Photos" jobs in the same transaction (review M075). This parity test keeps that
 * SQL identical to the live settings store: for every stored-value combination, a pending job
 * survives restore exactly when the store, loaded from the same values, has auto-download on with
 * that job's destination.
 */
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));

// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
// eslint-disable-next-line import/first
import { restoreBackup } from '@/services/backup/backup';
// eslint-disable-next-line import/first
import type { Backup } from '@/services/backup/backupSchema';
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';

const ENABLED_VALUES = [undefined, '1', '0', 'true', ''] as const;
const DESTINATION_VALUES = [undefined, 'app', 'gallery', 'album', 'bogus', ''] as const;
// A copy job only ever targets an outside destination; 'app' keeps media inside Gator.
const JOB_DESTINATIONS: readonly string[] = ['gallery', 'album'];

const cases = ENABLED_VALUES.flatMap((enabled) =>
  DESTINATION_VALUES.map((destination) => ({ enabled, destination })),
);

describe('backup restore auto-download policy', () => {
  it.each(cases)(
    'matches the live settings store (enabled=$enabled, destination=$destination)',
    async ({ enabled, destination }) => {
      const t = await createTestDb();
      try {
        // Same receipt window the existing restore test uses (expiry is exactly seven days later).
        const createdAt = 4_000_000_000_000;
        const insertJob = t.raw.prepare(
          `INSERT INTO attachment_media_exports (attachment_guid, destination, created_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        );
        for (const jobDestination of JOB_DESTINATIONS) {
          t.raw.prepare('INSERT INTO attachments (guid) VALUES (?)').run(jobDestination);
          insertJob.run(
            jobDestination,
            jobDestination,
            createdAt,
            createdAt + 7 * 24 * 60 * 60 * 1000,
          );
        }
        const kv: Backup['kv'] = [];
        if (enabled !== undefined) kv.push({ key: 'attachments.autoDownload', value: enabled });
        if (destination !== undefined) {
          kv.push({ key: 'attachments.autoDownloadDestination', value: destination });
        }

        await restoreBackup(t.db, {
          version: 1,
          exportedAt: 1,
          kv,
          themes: [],
          chatCustomizations: [],
        });

        (getDatabase as jest.Mock).mockReturnValue(t.db);
        useFeatureSettingsStore.setState({ hydrated: false });
        await useFeatureSettingsStore.getState().hydrate();
        const store = useFeatureSettingsStore.getState();
        const expected =
          store.autoDownloadAttachments && JOB_DESTINATIONS.includes(store.autoDownloadDestination)
            ? [store.autoDownloadDestination]
            : [];
        const surviving = (
          t.raw
            .prepare(
              `SELECT destination FROM attachment_media_exports
                WHERE state = 'pending' ORDER BY destination`,
            )
            .all() as { destination: string }[]
        ).map((row) => row.destination);

        expect(surviving).toEqual(expected);
      } finally {
        t.raw.close();
      }
    },
  );
});
