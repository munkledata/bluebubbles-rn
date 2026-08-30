# Gator RN — Data Caching Architecture

_Reference notes, generated 2026-06-24 from a code-verified subsystem audit._

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

- _Content_: `messages` (incl. `attributedBody`, edited/SMS fields, `has_attachments`),
  `chats`, `handles`, `attachments` (metadata only), `chat_handles`.
- _Search_: `messages_fts` (FTS5 index — see layer 6).
- _Operational/queue state_: `scheduled_messages`, the outgoing send/retry queue,
  `sync_markers` (the incremental cursor), `url_previews` (negative-cached), `kv`, `themes`.

### 2. DB encryption key + SecureVault (Android Keystore)

`src/db/key.ts`, `src/native/secureVault.ts`, `src/core/secure/vault.ts`, `src/services/index.ts`

- Secrets that **cannot** live in the encrypted DB (they must be readable at cold boot
  _before_ the DB opens): the SQLCipher `dbEncryptionKey` (+ pending-rotation slot),
  `serverAddress`/`serverPassword`, iCloud account, automation token, and `appLockEnabled`.
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

`src/services/download/*` (downloader, quota coordinator, and startup recovery),
`src/native/boundedDownload.ts`, `modules/gator-bounded-download/`,
`src/db/repositories/attachmentCache.ts`, `src/db/repositories/attachments.ts`,
`src/ui/attachments/*`

- Attachment metadata keeps `local_path`; the encrypted `attachment_cache_entries` ledger owns
  each distinct physical cache path once, including its exact bytes, last-use time, and
  `reserved`/`active`/`retiring` lifecycle. Retiring and crash-surviving reserved files stay
  charged until exact native deletion is confirmed.
- Bytes are downloaded **on demand** (images
  known size <= 5 MiB automatic, everything else tap-to-download with a 512 MiB hard cap) to
  `Paths.document/attachments/media-{encoded-guid}/generation-{account}/media-{encoded-name}` via
  a verified `*.part` file,
  concurrency-capped at a configurable limit (default `DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2`,
  adjustable up to `MAX_CONCURRENT_DOWNLOADS_LIMIT = 6`), with per-guid dedup of concurrent calls.
- Before native work can create a destination, the coordinator durably reserves the transfer's
  maximum bytes. The global ordinary-attachment cache is limited to **2 GiB / 4,096 files** and
  preserves at least **512 MiB free**. Deterministic least-recently-used eviction protects files
  used in the last ten minutes, mounted/current readers, in-flight identities, and outgoing
  send/retry inputs. If protected or cleanup-pending files prevent proof of capacity, the new
  download is refused rather than bypassing the limit.
- All shipped native file-download routes share the same actual-byte/timeout boundary: attachment
  transfers use 2-minute automatic or 15-minute manual deadlines; server contact thumbnails use
  5 MiB / 30 seconds; synced chat wallpapers use 10 MiB / 60 seconds. Each route downloads to a
  Gator-owned `*.part`, verifies a positive final stat, promotes it, and prunes abandoned partials.
- On success, `updateAttachmentLocalPath` writes `local_path` → adapter flush → `useMessages`
  re-queries → the image swaps from placeholder to media (driven by the **DB write**, never the
  store). The reservation remains identity-owned across this reactive handoff so a mounted reader
  can pin the path before eviction becomes possible.
- Authorized startup/explicit connect collects one complete bounded native manifest before any
  cache mutation, adopts old pre-ledger files in 100-row transactions, repairs missing entries,
  retires zero-byte/orphan/crash-owned files, and proactively conforms the quota before persistent
  downloads open. The scanner supports both the legacy `attachments/{safe-guid}/{safe-name}`
  layout and the canonical generation layout, with hard limits of 8,192 files and 32,768 nodes.
  Malformed/symlinked/partial inventories fail closed. On Android 7 (API 24/25), persistent
  downloads remain disabled because the bounded streaming directory API begins at Android 8.
- `downloadStore` (zustand) is **presentation-only** byte progress (`0..1 | null`, status) —
  it never carries the path. expo-image runs its own native memory/disk bitmap cache (never
  cleared).

### 8. kv prefs table (non-secret, inside the encrypted DB)

`src/db/repositories/kv.ts`

- Persisted non-secret prefs: `theme.preset`, `theme.custom`, `privacy.redactedMode`. Survives restart but unreadable until the DB is open.
- `kvGet`/`kvSet` only (no delete; "clearing" writes an empty string). `kv(key TEXT PK,
value TEXT)`.

### 9. In-memory zustand stores

- _kv-mirroring_: `themeStore`, `redactedModeStore`, `featureSettingsStore`
  (feature flags + attachment auto-download / wifi-only settings), `syncSettingsStore`
  (messages-per-chat) — hydrate from `kv`, set memory first then best-effort `kvSet`.
- _vault-mirroring_: `sessionStore` (credentials), `lockStore` (`appLockEnabled`) — never
  persisted by zustand.
- _purely ephemeral_ (reset every reload): `downloadStore`, `syncStore`, `typingStore`,
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
  is backfilled when a thread opens (`ensureChatSynced`/`syncChatMessages`) or when the user runs
  **Repair Conversation** from its Details screen. The manual path also refreshes that exact chat's
  server metadata and participants; it does not scan other chats or move the global cursor. Older
  un-pulled history is reached only by the all-history Local Cache Repair.
- **Locally deleted conversations** — tombstoned chats stay out of normal lists but remain available
  under Server Management → Restore Deleted Conversations. Restore re-fetches a bounded history
  prefix while the tombstone still hides it, then advances the unread floor and clears that exact
  deletion atomically. A bounded crawl must carry its own pre-deletion floor candidate into the
  guarded write; ambient purge leftovers are not proof. It fails closed when the prefix cannot
  prove a safe floor.
- **Pull-to-refresh** deliberately does a _light_ sync and does not bulk re-fetch existing
  chats' messages (avoids wedging the single-threaded server).
- **URL/Open-Graph previews** — current containment is cache-only: previously stored metadata may
  render, but displaying a message does not fetch its arbitrary remote URL. A future proxy/native
  bounded-fetch design is tracked in the master work plan.
- **Encrypted FCM payloads (AES-GCM)** — supported `AEAD_GCM_V1` frames are decrypted on-device and
  enter `EventRouter` when the App Lock policy allows DB work. Unsupported/bad frames and locked
  delivery catch up on the next sync; locked delivery posts only a generic notice.
- **Backups** — new encrypted v3 backups carry allow-listed settings, user themes, per-chat
  customizations, and custom-folder name/order/badge/membership data. Folder membership uses the
  same portable service/kind/stable-identifier/participant evidence as chat-customization restore;
  it can therefore contain participant phone numbers or email addresses, but never message text,
  drafts, attachments, contact display data, credentials, or the DB key. Temporarily absent,
  ambiguous, and unsafe folder members are counted and visibly skipped instead of restoring an
  opaque server-specific GUID. V1/v2 imports leave existing folders untouched. Folder restore
  preserves local-only folders/members, merges exact normalized names, appends new names in backup
  order, and applies all settings/theme/chat/folder writes in one guarded transaction. The UI and
  server-slot paths expose only encrypted output; legacy plaintext backups remain importable.
  Import stats a picked file before reading it (6 MiB cap), bounds encoded text before base64 decode
  (6 MiB), bounds decrypted/legacy plaintext before JSON parsing (4 MiB), and applies per-collection,
  aggregate-membership, and per-string schema limits. Argon2 cost is application-owned. New exports
  require a 15-character, non-common passphrase; old encrypted backups retain their original
  passphrase compatibility.

---

## Characteristics & caveats

- **Only ordinary attachment files use the app-managed global LRU.** The 2 GiB/4,096-file ledger
  does not govern SQLCipher history or third-party Expo Image/WebView caches. Synced backgrounds
  have their own native 100 MiB/256-file quota; Android/Expo-managed caches remain outside this
  ledger and may follow OS/library cleanup policy.
- **Disconnect is a verified account wipe.** `forget()` closes the authorization window, clears
  credentials and account-scoped DB contents, cancels known reminders/notifications/shortcuts, and
  removes persistent attachment/avatar/background/wallpaper directories. It clears the in-memory
  and persisted app logs last, while deliberately retaining the reusable DB key and OS-evictable
  cache. A required cleanup failure keeps the next connection blocked so the idempotent sweep can
  retry; the release device matrix must still inspect the exact native candidate.
- **App-lock is a UI/policy gate, not at-rest key custody (Android).** Foreground boot and the
  locked headless FCM path both defer opening the DB; the latter posts a generic notice and catches
  up after unlock. However, the SecureStore-held key itself is not biometric-bound, and an unlocked
  headless wake can open the DB.
- **FTS5 indexes only `text`** — but edited/SMS messages, whose body arrives in `attributedBody`
  with an empty `text` column, now have `text` populated from the decoded attributedBody at upsert
  (plus a one-time boot backfill for already-cached history), so they **are** full-text searchable.
  `subject` is still not indexed.
- **Best-effort kv persistence.** kv setters set memory first then swallow `kvSet` failures,
  so a toggle can silently fail to survive a restart.
- **Adapter-bypass staleness.** A write directly on `getRawDatabase()` mutates data but does
  not flush, so the UI silently goes stale until another adapter write.
- **Test-vs-device divergence.** FTS5/SQLCipher are op-sqlite build flags — without them
  `messages_fts`/rekey fail _only on device_ (Node's better-sqlite3 has FTS5 and no SQLCipher
  codec, so green Jest does not prove device-correct encryption or search).

---

## Key files

| File                                   | Role                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `src/db/database.ts`                   | Open DB, drizzle adapter, reactive flush                                         |
| `src/db/key.ts`                        | DB encryption key generate/resolve/rotate                                        |
| `src/native/secureVault.ts`            | Keystore-backed secret storage                                                   |
| `src/db/schema.ts` / `migrations.ts`   | Tables + schema evolution                                                        |
| `src/db/useReactiveQuery.ts`           | Table-keyed reactive read subscriptions                                          |
| `src/services/sync/engine.ts`          | full/incremental sync, marker                                                    |
| `src/core/realtime/eventRouter.ts`     | socket + FCM normalization                                                       |
| `src/services/realtime/dbEventSink.ts` | realtime → DB upserts                                                            |
| `src/db/repositories/*`                | upserts, reads, kv, sync marker                                                  |
| `src/services/download/*`              | on-demand media download, concurrency cap, per-guid dedup, on-disk file cache    |
| `src/ui/attachments/*`                 | UI trigger/render layer (fires the download, swaps on the DB `local_path` write) |
