# Gator RN — Data Caching Architecture

_Reference notes, generated 2026-06-24 from a code-verified subsystem audit; download/cache boundary
updated 2026-09-15._

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
  `sync_markers` (the incremental cursor), legacy read-only `url_previews` rows, `kv`, `themes`.

### 2. DB encryption key + SecureVault (Android Keystore)

`src/db/key.ts`, `src/native/secureVault.ts`, `src/core/secure/vault.ts`, `src/services/index.ts`

- Secrets that **cannot** live in the encrypted DB (they must be readable at cold boot
  _before_ the DB opens): the SQLCipher `dbEncryptionKey` (+ pending-rotation slot),
  `serverAddress`/`serverPassword`, iCloud account, automation token, and `appLockEnabled`.
- `ExpoSecureVault` wraps expo-secure-store (Keystore + EncryptedSharedPrefs).
  `getOrCreateDbKey` generates 32 random bytes hex-encoded to 64 chars on first run.
  `resolveDbKey` completes an interrupted rotation; `rotateDbKey` is a 4-step crash-safe
  `PRAGMA rekey` sequence.
- `requireAuthentication` is intentionally **OFF** so an authenticated, active-bound V3 headless push
  can enqueue into SQLCipher while App Lock is active. It cannot read, claim, route, or apply content
  until unlock. `keychainAccessible: WHEN_UNLOCKED` is iOS-only and **inert on Android** (not an
  at-rest custody guarantee).

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

### 4. Realtime write path (FCM + socket → durable intake → EventRouter → DbEventSink)

`src/core/realtime/eventRouter.ts`, `src/services/realtime/dbEventSink.ts`,
`src/services/realtime/incomingEventDispatcher.ts`, `src/core/realtime/incomingEventCodec.ts`,
`src/services/notifications/fcmPayload.ts`

- `parseFcmData` reads the event name from the envelope `type` and the body from the nested
  `data` JSON string (no top-level `payload`).
- For eligible unlocked socket/FCM input, `dispatchRealtimeEvent` snapshots and normalizes the
  envelope, derives its canonical occurrence identity, and persists it to the encrypted
  `incoming_event_queue` **before** any domain or presentation effect. A bounded token/version-
  fenced lease then routes the normalized event through `EventRouter`/`DbEventSink`; the DB phase is
  checkpointed in its domain transaction and presentation retries read current DB truth. A locked,
  authenticated V2 delivery before its exclusive 2027-02-01 cutoff remains the deliberate no-DB
  exception and may post only a generic notice. Authenticated, active-bound V3 may only enqueue into
  SQLCipher; it cannot read, claim, route, or apply queued content before unlock, and only a newly
  admitted row can produce the generic notice. Absent/V1/plaintext/invalid delivery posts nothing.
- A background-FCM message commit synchronously queues its keyed attachment app-cache effect under
  the native callback. The collector starts deduplicated factories sequentially after dispatch and
  notification presentation, awaits them outside account teardown, and revokes them at an absolute
  40-second-from-receipt deadline with at most two seconds of cooperative cleanup. This bound does
  not cover the earlier delivery or final log flush and is not a durable process-death retry.
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
- Unlocked background FCM may make one bounded best-effort app-cache attempt after the message DB
  commit. It deliberately does not invoke `expo-media-library`, whose Photos write has no abort
  signal. For an eligible incoming non-sticker image with a Gallery/Gator Album preference, it
  instead commits a destination-bound encrypted receipt before native download work; if no receipt
  slot can be proved, it admits no private-cache download. Once `local_path` commits, an active,
  unlocked, connected foreground session with already-granted Photos permission can drain the
  receipt. The queue is bounded to 512 pending / 2,000 total receipts. Pending receipts expire after
  seven days; terminal receipts may remain for up to 30 days. Claims are limited to three total
  attempts, and each drain invocation processes at most eight exports. A process stop after
  MediaStore saves but before receipt completion consumes an attempt; repeated stops can produce at
  most two duplicate copies after the first save.
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
- Before a new synced wallpaper can start, native cleanup must strictly prove no more than 90 MiB / 255
  files while protecting the DB-referenced current wallpaper. The bounded transfer can then add at
  most 10 MiB / one file, and the post-commit prune retains the final 100 MiB / 256-file ceiling. Each
  pass streams at most 8,192 files / 32,768 nodes with no-follow metadata, exact current/legacy path
  grammar, and a final independent recount. Malformed, unreadable, symlinked, raced, or overflowing
  state refuses admission rather than silently skipping an entry.
- On success, `updateAttachmentLocalPath` writes `local_path` → adapter flush → `useMessages`
  re-queries → the image swaps from placeholder to media (driven by the **DB write**, never the
  store). The reservation remains identity-owned across this reactive handoff so a mounted reader
  can pin the path before eviction becomes possible.
- Authorized startup/explicit connect collects one complete bounded native manifest before any
  cache mutation, adopts old pre-ledger files in 100-row transactions, repairs missing entries,
  retires zero-byte/orphan/crash-owned files, and proactively conforms the quota before persistent
  downloads open. The scanner supports both the legacy `attachments/{safe-guid}/{safe-name}`
  layout and the canonical generation layout, with hard limits of 8,192 files and 32,768 nodes.
  Malformed/symlinked/partial inventories fail closed. On Android 7 (API 24/25), ordinary persistent
  attachment downloads and new synced-wallpaper downloads remain disabled because the bounded
  streaming directory API begins at Android 8.
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

- `GuidDeduper` (Set + insertion-order array, cap 5000, evicts oldest) remains a compatibility
  defense for message upserts.
- `EventRouter` has its own process-local `seen` Set (cap 500) on the legacy direct new-message
  path. Eligible modern socket/FCM events instead use canonical durable occurrence receipts;
  `message-send-error` uses server `attemptGuid` as exact identity when present.
- `outgoing.ts` `cancelledTempGuids` (cap 256) tracks user-cancelled sends.
- The in-memory sets reset on every (re)launch. Durable terminal receipts survive restart for seven
  days and at most 2,000 rows; cross-session message convergence also retains idempotent DB upserts.

---

## Data flow

- **In:** server → sync engine **or** eligible unlocked FCM/socket → encrypted durable queue →
  `EventRouter` / guarded upserts → DB tables → adapter flush. A locked, authenticated pre-cutoff V2
  delivery may post only a generic notice without opening the DB. Authenticated, active-bound V3
  may enqueue into SQLCipher while locked, but the queue stays unread and undrained until unlock.
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
- **URL/Open-Graph previews** — the client has no HTML fetch/parser. Text-only metadata may come from
  server-supplied message `payloadData` or an exact-key legacy `url_previews` row; a cache miss stays
  a raw externally opened link, and no path mounts remote artwork. A future proxy/native bounded-fetch
  design is tracked in the master work plan.
- **Encrypted FCM payloads (AES-GCM)** — the app generates a random per-device key, persists it
  before enrollment, and requires an exact server acknowledgement. Password-derived V1 and
  plaintext receive are retired even when no state exists. Random-key `AEAD_GCM_V2_DEVICE` remains
  encrypted compatibility only before the exclusive **2027-02-01T00:00:00Z** cutoff; its event type
  is authenticated, and a locked notice is posted only after the frame authenticates. Scoped
  sessions require identity-bound V3, which binds installation, principal, device, occurrence,
  event, and expiry. V3 keys rotate at 30 days; a crash-safe, stable rotation request accepts the
  immediately previous key only through the earlier server/local deadline. A pending, active,
  rotating, invalid, or revoked record never silently downgrades. Android SecureStore/native crypto,
  killed-process delivery, and the matching deployed server still require physical-device proof.
  After unsupported or bad input, server-state-backed message content may catch up on later sync;
  one-time events such as `message-send-error` may be lost without another live transport.
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
  does not govern SQLCipher history or third-party Expo Image and other Android/Expo-managed caches.
  Synced backgrounds have their own strict 90 MiB/255-file pre-admission reserve and native 100
  MiB/256-file final quota; Android/Expo-managed caches remain outside this ledger and may follow
  OS/library cleanup policy.
- **Disconnect is a verified account wipe.** `forget()` closes the authorization window, clears
  credentials and account-scoped DB contents, cancels known reminders/notifications/shortcuts, and
  removes persistent attachment/avatar/background/wallpaper directories. It clears the in-memory
  and persisted app logs last, while deliberately retaining the reusable DB key and OS-evictable
  cache. A required cleanup failure keeps the next connection blocked so the idempotent sweep can
  retry; the release device matrix must still inspect the exact native candidate.
- **App-lock is a UI/policy gate, not at-rest key custody (Android).** Foreground boot defers opening
  the DB. A locked, authenticated pre-cutoff V2 delivery avoids it and may post only a generic
  notice; absent/V1/plaintext/invalid delivery posts nothing. Authenticated, active-bound V3 alone
  may enqueue into SQLCipher, with no queued-content read or effect before unlock. The
  SecureStore-held key is not biometric-bound, and an unlocked headless wake can open the DB
  normally.
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
