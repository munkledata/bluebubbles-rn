/**
 * Barrel for the DB repository layer. Re-exports every public symbol from the
 * domain submodules so existing `@db/repositories` imports resolve unchanged.
 *
 * NOTE: `./_shared` is intentionally NOT re-exported — its helpers (`dedupeBy`,
 * `toFtsQuery`) were module-private in the original `repositories.ts` and stay
 * internal to this directory.
 */

export * from './handles';
export * from './chats';
export * from './attachments';
export * from './messages';
export * from './reactions';
export * from './outgoing';
export * from './kv';
export * from './themes';
export * from './backup';
export * from './urlPreviews';
export * from './sync';
export * from './contacts';
export * from './scheduled';
export * from './reminders';
