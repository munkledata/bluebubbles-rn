/**
 * The newest migration in this build, pinned once: every device self-test and harness expects the
 * database to reach exactly this head after exactly this many migrations. Bump both with each new
 * migration; test/db/migrationHead.test.ts fails until they match MIGRATIONS and the registry.
 *
 * It lives apart from migrations.ts because the DB-write guard requires database.ts to import
 * exactly one name, MIGRATIONS, from that module.
 */
export const MIGRATION_HEAD = '0061_messages_fts_update_only_on_text' as const;
export const MIGRATION_COUNT = 61 as const;
