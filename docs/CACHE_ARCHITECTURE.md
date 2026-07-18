# Gator RN — Data Caching Architecture

*Reference notes, generated 2026-06-24 from a code-verified subsystem audit.*

## TL;DR

The app is **offline-first with one source of truth: an encrypted on-device SQLite
database** (`gator.db`, op-sqlite + SQLCipher). The network never feeds the UI
directly — the sync engine and the realtime (FCM/socket) path **write** into the DB; the
UI **reads** the DB reactively. Layered on top: secrets in the Android Keystore,
downloaded media files on disk, a key-value prefs table, in-memory zustand stores, and an
FTS5 search index.

---

## Layers (bottom → top)

### 1. Encrypted SQLite database — the canonical store
`src/db/database.ts`, `migrate.ts`, `migrations.ts`, `schema.ts`

- op-sqlite compiled with `sqlcipher: true` + `fts5: true` (package.json). AES-encrypted
  at rest; unreadable without the vault's DB key.
- `initDatabase(key)` opens once via `open({ name: 'gator.db', encryptionKey })`,
  sets `PRAGMA foreign_keys=ON`, runs transactional name-guarded migrations, then wraps the
  handle in `drizzle(drizzleAdapter(rawDb))`.
- The **drizzleAdapter Proxy** shims the op-sqlite v17 ↔ drizzle-orm API mismatch and calls
  `flushPendingReactiveQueries()` after every async write so reactive subscribers re-run.
- `getDatabase()` throws if not open; `ensureDatabase()` is the lazy, headless-safe entry
  (used by killed-app FCM/notification handlers).

**Tables cached here:**
- *Content*: `messages` (incl. `attributedBody`, edited/SMS fields, `has_attachments`),
  `chats`, `handles`, `attachments` (metadata only), `chat_handles`.
- *Search*: `messages_fts` (FTS5 index — see layer 6).
- *Operational/queue state*: `scheduled_messages`, the outgoing send/retry queue,
  `sync_markers` (the incremental cursor), `url_previews` (negative-cached), `kv`, `themes`.

### 2. DB encryption key + SecureVault (Android Keystore)
`src/db/key.ts`, `src/native/secureVault.ts`, `src/core/secure/vault.ts`, `src/services/index.ts`

- Secrets that **cannot** live in the encrypted DB (they must be readable at cold boot
  *before* the DB opens): the SQLCipher `dbEncryptionKey` (+ pending-rotation slot),
  `serverAddress`/`serverPassword`, iCloud account, automation token, `appLockEnabled`,
  cert pins.
- `ExpoSecureVault` wraps expo-secure-store (Keystore + EncryptedSharedPrefs).
  `getOrCreateDbKey` generates 32 random bytes hex-encoded to 64 chars on first run.
  `resolveDbKey` completes an interrupted rotation; `rotateDbKey` is a 4-step crash-safe
  `PRAGMA rekey` sequence.
- `requireAuthentication` is intentionally **OFF** so a headless locked FCM push can still
  decrypt the DB. `keychainAccessible: WHEN_UNLOCKED` is iOS-only and **inert on Android**
  (not an at-rest custody guarantee).

### 3. Sync write path + persisted cursor
`src/services/sync/engine.ts`, `src/services/syncControl.ts`, `src/core/sync/cursor.ts`,
`src/db/repositories/sync.ts`, `src/services/background/backgroundSync.ts`, `src/services/index.ts`

- `runSync` (a module-local orchestrator in `src/services/syncControl.ts` — the engine's actual
  exports are `fullSync` / `incrementalSync` / `syncAllChats` / `syncChatMessages` in
  `src/services/sync/engine.ts`) reads the cursor (single-row `sync_markers id=1`: `last_synced_row_id` /
  `last_synced_timestamp`):
  - both NULL → **fullSync** (all chats + participants first, then ~100 recent msgs/chat,
    concurrency 2 + pacing).
  - else → `syncAllChats` + **incrementalSync** (rowid mode on server ≥ 1.6.0, else
    timestamp mode with a 5 s overlap).
- Each page upserts embedded chats/handles/messages in **its own transaction** (so the
  adapter flushes and the inbox hydrates mid-sync), advances the marker by MAX rowid/ts over
  the whole batch (incl. duplicates → forward progress), and **persists it after every page**
  so sync resumes after a kill. Only this path advances the marker.

### 4. Realtime write path (FCM + socket → EventRouter → DbEventSink)
`src/core/realtime/eventRouter.ts`, `src/services/realtime/dbEventSink.ts`,
`src/services/notifications/fcmPayload.ts`

- `parseFcmData` reads the event name from the envelope `type` and the body from the nested
  `data` JSON string (no top-level `payload`).
- `dispatchRealtimeEvent` → one shared `EventRouter` (socket + FCM share its dedup set) →
  `coerceData` JSON-parses the body once → zod normalize → `DbEventSink.onEvent` upserts
  handles/chats, resolves the chat, reconciles your own optimistic `temp-` row in place, then
  `upsertMessages`.
- Does **not** advance the sync marker — the next incrementalSync re-fetches the overlap and
  the idempotent upsert + `GuidDeduper` absorb it.

### 5. Reactive read path
`src/db/useReactiveQuery.ts`, `src/features/conversations/useChats.ts`, `useMessages.ts`,
`src/db/repositories/messages.ts`, `chats.ts`

- `useChats`/`useMessages` delegate to `useReactiveQuery(run, tables, deps)`. It runs `run()`
  once, then subscribes via `reactiveExecute({ query: 'SELECT 1', fireOn: tables })` — the
  `SELECT 1` result is ignored; it is a **pure change trigger keyed on table names**.
- A write → adapter flush → callback fires → 24 ms debounce → re-run `run()` → `setState`.
- Reads use raw `db.all(sql\`…\`)` (sync fast path), which neither needs nor triggers a flush.
- `useChats` watches `[messages, chats, chat_handles, handles]`; `useMessages` watches
  `[messages, handles, attachments]`.

### 6. FTS5 full-text search index (`messages_fts`)
- External-content virtual table `messages_fts USING fts5(text, content='messages',
  content_rowid='id')`, created in migration 0001, kept current by AFTER INSERT/DELETE/UPDATE
  triggers.
- Queried via `messages_fts MATCH … JOIN messages`.
- **Indexes ONLY the `text` column** — `subject` and `attributed_body` are not searchable.
  (FTS5 must be compiled in, or it fails on device only.)

### 7. Attachment binary file cache (filesystem)
`src/services/download/*` (downloader — `downloadService`, `expoFetcher`/`devFetcher`, `pathSafety`), `src/db/repositories/attachments.ts` (`updateAttachmentLocalPath`), `src/ui/attachments/*` (UI trigger/render layer only)

- Only `local_path` is cached in the DB row. The bytes are downloaded **on demand** (images
  < 5 MB auto, everything else tap-to-download) to `Paths.document/attachments/{guid}/`,
  concurrency-capped at a configurable limit (default `DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2`,
  adjustable up to `MAX_CONCURRENT_DOWNLOADS_LIMIT = 6`), with per-guid dedup of concurrent calls.
- On success, `updateAttachmentLocalPath` writes `local_path` → adapter flush → `useMessages`
  re-queries → the image swaps from placeholder to media (driven by the **DB write**, never
  the store).
- `downloadStore` (zustand) is **presentation-only** byte progress (`0..1 | null`, status) —
  it never carries the path. expo-image runs its own native memory/disk bitmap cache (never
  cleared).

### 8. kv prefs table (non-secret, inside the encrypted DB)
`src/db/repositories/kv.ts`

- Persisted non-secret prefs: `theme.preset`, `theme.custom`, `smartReply.enabled`,
  `privacy.redactedMode`. Survives restart but unreadable until the DB is open.
- `kvGet`/`kvSet` only (no delete; "clearing" writes an empty string). `kv(key TEXT PK,
  value TEXT)`.

### 9. In-memory zustand stores
- *kv-mirroring*: `themeStore`, `smartReplyStore`, `redactedModeStore`, `featureSettingsStore`
  (feature flags + attachment auto-download / wifi-only settings), `syncSettingsStore`
  (messages-per-chat) — hydrate from `kv`, set memory first then best-effort `kvSet`.
- *vault-mirroring*: `sessionStore` (credentials), `lockStore` (`appLockEnabled`) — never
  persisted by zustand.
- *purely ephemeral* (reset every reload): `downloadStore`, `syncStore`, `typingStore`,
  `findmyStore`.
- Gotcha: `hydrate()` wraps `getDatabase()` in try/catch (it throws pre-connect) and re-runs
  on home mount.

### 10. Bounded in-memory dedup / cancel sets
- `GuidDeduper` (Set + insertion-order array, cap 5000, evicts oldest) de-dups FCM-vs-socket
  message overlap; can be shared with the live path.
- `EventRouter` has its own `seen` Set (cap 500) to suppress duplicate **notifications**
  (new-message only; updated-message is not deduped).
- `outgoing.ts` `cancelledTempGuids` (cap 256) tracks user-cancelled sends.
- All reset on every (re)launch; cross-session dedup relies on the idempotent DB upsert.

---

## Data flow

- **In:** server → sync engine **or** FCM/socket → `EventRouter` / upserts → DB tables →
  adapter flush.
- **Out:** DB write → flush → reactive subscription fires → re-query → React state → UI.

---

## What is NOT cached (fetched on demand)

- **Secrets** — live in the Keystore-backed SecureVault, not the DB.
- **Attachment binaries** — only `local_path` is in the DB; bytes download on first view.
- **Full per-chat message history** — bulk sync caps at ~100 messages/chat; up to 500 more
  is backfilled **only when a thread is opened** (`ensureChatSynced`/`syncChatMessages`).
  Older un-pulled history is never reached by the incremental cursor.
- **Pull-to-refresh** deliberately does a *light* sync and does not bulk re-fetch existing
  chats' messages (avoids wedging the single-threaded server).
- **URL/Open-Graph previews** — fetched on demand, negative-cached (`error=1`) so dead URLs
  aren't refetched.
- **Encrypted FCM payloads (AES)** — not decrypted in RN; recovered on the next sync.
- **Backups** — export *settings only* (kv minus secret-looking keys + user themes + per-chat
  customizations). Message history, handles, attachments, and the DB key are never exported;
  restoring on a fresh device requires a full re-sync.

---

## Characteristics & caveats

- **No TTL / eviction / pruning anywhere.** Nothing deletes old messages, chats, handles, or
  downloaded media. The DB and on-disk media cache grow **unbounded** with history. Only
  per-entity user/server-driven deletes exist (`deleteChatLocal` cascade, `deleteMessageByGuid`,
  and the full contacts wipe in `upsertContacts` via `db.delete(contacts)`). No size cap, age cap, LRU, or cleanup job; expo-image's bitmap cache is
  never cleared. *(This is the place to add a cache-size cap if ever wanted.)*
- **Logout does not wipe the cache.** `forget()` removes only `serverAddress` +
  `serverPassword` and resets the session store — it leaves the DB key in the vault and the
  entire encrypted DB on disk. Reconnecting to the same server reuses the existing cache.
- **App-lock is a UI gate, not at-rest key custody (Android).** It withholds the DB key only
  on the foreground boot path; a headless FCM push still opens + decrypts the DB while locked.
- **FTS5 indexes only `text`** — but edited/SMS messages, whose body arrives in `attributedBody`
  with an empty `text` column, now have `text` populated from the decoded attributedBody at upsert
  (plus a one-time boot backfill for already-cached history), so they **are** full-text searchable.
  `subject` is still not indexed.
- **Best-effort kv persistence.** kv setters set memory first then swallow `kvSet` failures,
  so a toggle can silently fail to survive a restart.
- **Echo reconcile + upsert are not yet one transaction** (TODO in `dbEventSink.ts`): a hard
  crash in the sub-ms gap could strand an unpromoted `temp-` row as a duplicate bubble.
- **Adapter-bypass staleness.** A write directly on `getRawDatabase()` mutates data but does
  not flush, so the UI silently goes stale until another adapter write.
- **Test-vs-device divergence.** FTS5/SQLCipher are op-sqlite build flags — without them
  `messages_fts`/rekey fail *only on device* (Node's better-sqlite3 has FTS5 and no SQLCipher
  codec, so green Jest does not prove device-correct encryption or search).

---

## Key files

| File | Role |
|------|------|
| `src/db/database.ts` | Open DB, drizzle adapter, reactive flush |
| `src/db/key.ts` | DB encryption key generate/resolve/rotate |
| `src/native/secureVault.ts` | Keystore-backed secret storage |
| `src/db/schema.ts` / `migrations.ts` | Tables + schema evolution |
| `src/db/useReactiveQuery.ts` | Table-keyed reactive read subscriptions |
| `src/services/sync/engine.ts` | full/incremental sync, marker |
| `src/core/realtime/eventRouter.ts` | socket + FCM normalization |
| `src/services/realtime/dbEventSink.ts` | realtime → DB upserts |
| `src/db/repositories/*` | upserts, reads, kv, sync marker |
| `src/services/download/*` | on-demand media download, concurrency cap, per-guid dedup, on-disk file cache |
| `src/ui/attachments/*` | UI trigger/render layer (fires the download, swaps on the DB `local_path` write) |
