import { MIGRATIONS } from '@db/migrations';

/** `name` and every migration after it, in order: what runMigrations applies from that point. */
export function migrationNamesFrom(name: string): string[] {
  const start = MIGRATIONS.findIndex((migration) => migration.name === name);
  if (start < 0) throw new Error(`Unknown migration ${name}`);
  return MIGRATIONS.slice(start).map((migration) => migration.name);
}
