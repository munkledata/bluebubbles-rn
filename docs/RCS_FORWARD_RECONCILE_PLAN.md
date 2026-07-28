# RCS Bridge — Structural Fix Plan

**Date:** 2026-07-27 · **Audit:** `docs/RCS_BRIDGE_AUDIT_2026-07-27.md` · **Repos:** `bluebubbles-rn`, `BB/bluebubbles-server`

---

## 1. The one-paragraph answer

Right now an RCS message only ever exists in your database if a network connection happened to be open at the exact moment Google pushed it. Nothing ever goes back and checks. **The fix is to stop trusting the live stream and start asking the phone "what do you have that I don't?" on a timer.** Concretely: for each conversation we remember the highest Google message ID we have stored (a *watermark*). Every 60 seconds the server asks Google Messages for a list of conversations, which comes back carrying each conversation's newest message ID. If that ID is higher than our watermark, we page that one conversation backwards — newest first — until we reach messages we already have, then stop. Nothing else. Separately, we keep a numbered log of everything the server learns, so the phone app can ask "give me everything since number 4,512" instead of only ever receiving live pushes. Two catch-up loops, both restartable, neither depending on a connection having been open at the right instant.

---

## 2. Why this and not the others

Three designs were judged. All three agreed on the core (per-conversation forward watermark keyed on the **numeric message ID**, a gap-gated newest-first re-page, and a separate app-facing cursor). They differed only in how much working code they disturbed to get there. **All three judges picked the same winner: the leased gap-gated reconciler with an ingest journal**, scoring 8.4 / 7.85 / 33 against 6.4 / 5.8 / 27 and 6.0 / 6.15 / 24.

### Why it won

- **It repairs the loss class prod actually shows.** Prod damage is not a clean tail-truncation — it is *interior holes*. In the contiguous live range 15850–16000, 147 of 151 ids are present; 15858, 15933, 15934 and 15984 are missing while *newer* ids in the same conversation arrived fine. For those conversations `latestMessageID` matches what we stored, so every gap gate says "clean". Only this design has an **unconditional daily backstop** (a page-1 re-walk that ignores the watermark, ~36 phone calls/day, reaching 50 messages back) that can find a hole the gap gate calls clean. The runner-up stops at the first message it already has — on a healthy tail that is row 1 of page 1, so it can never cross an interior hole at all.
- **Lowest blast radius.** It never touches `rcs_cursor`, never touches `rcs_messages`' shape, and leaves `#backfill`/`#backfillOne` (`packages/bbd/src/rcs/RcsListener.ts:549-601`) running exactly as they do today. bbd has **no migration framework** — the `CREATE TABLE IF NOT EXISTS` block at `RcsCacheStore.ts:42-64` is the only DDL that has ever run in the package, and prod `PRAGMA user_version` is 0 — so a new *sibling table* is free while an `ALTER TABLE` on a live 4,496-row table is the single riskiest write anyone proposed. This design needs zero ALTERs.
- **It is explainable.** New concepts: a table of watermarks, a timer that re-pages conversations whose watermark disagrees with the phone, and a numbered log the app reads. Three sentences. The runner-up needs a ring buffer, an epoch, four resume modes and a durable per-line offset with crash-recovery semantics — and its own author concedes the ring "contributes literally nothing" to the common case, because every sidecar restart empties it and sidecar restarts *are* the majority of prod gap events.

### Grafts taken from the runners-up

| Graft | From | Why |
|---|---|---|
| Per-subscriber **dropped counter** + an in-band `{"kind":"gap","dropped":N}` line | D1/D2 | Today `bridge.go:1351` logs a drop nobody reads. ~10 lines turns it into a signal bbd can act on. Keeps the drop *policy* unchanged (D2 wanted to close the whole stream — rejected as a new incident vector in the path that currently works). |
| `durableKind()` — never sequence `heartbeat`/`typing` | D2 | Heartbeats fire every ~20s (`server.go` `heartbeatInterval`) = ~4,320 lines/day. Without this filter a sequence number is 93% noise and "seq jumped by 3" means nothing. |
| A **`generation` stamp** on the app-facing cursor response | D1 | If `rcs.db` is deleted or restored from backup, sequence numbers restart at 1 and a stored app cursor of 4,600 silently suppresses **every** RCS message forever. D1 correctly calls this "invisible and total". Non-negotiable. |
| Advance the app journal on `isNew \|\| changed`, not just `isNew` | D1 | `RcsCacheStore.ts:230` already computes `changed` from a real status/text advance. One extra predicate stops an RCS bubble sticking on "Sent" after the app was backgrounded. |
| Log `stored N of M` from `ListMessagesResponse.totalMessages` (discarded today at `bridge.go:824-830`) | D1/D3 | Diagnostic only — the phone's total includes types we drop, so it is not a valid completeness test. But it is the only instrument that can ever answer "how much does the phone still hold." |
| The **anti-wedge test** written first, as the acceptance gate | D2 | A fetch that never resolves must abort, record error for *that* conversation, and let the sweep proceed. This is the exact failure `#backfilling` (`RcsListener.ts:550-560`) cannot survive — if the `await` never returns, the `finally` never runs. |
| **Simplifications cut from the winner before writing a line** | Judge 3 | Drop `lease_until`/`claimSweep` (one process, one synchronous better-sqlite3 handle — an in-process boolean plus an AbortSignal is enough) and drop `gap_cursor`/`gap_top_id` (the resume-a-capped-walk scheme is the subtlest thing in the design; at prod's ~35 msgs/day a 6-page cap converges in one sweep). Adds them later only if `outcome='capped'` is ever actually observed. `rcs_sync_state` drops from 15 columns to 9. |

### What the winner does NOT solve — stated plainly

1. **It cannot recover what the phone no longer holds.** Every fetch is executed *by the phone*, not by Google (`libgm/session_handler.go:202-221`). If Bugle deleted or never stored a row, no design here finds it. The four missing prod ids may be drafts, phone-side deletions, or genuinely lost — **this is unresolved and must be probed before you believe any recovery claim** (see §6).
2. **It cannot see a conversation outside the newest-N of a folder.** `ListConversationsRequest.cursor` exists in the proto but `Client.ListConversations` never sets it and `sessionHandler` is unexported (`libgm/client.go:117`), so paging the conversation list needs a libgm fork. Raising N to 100 and adding ARCHIVE widens the window; it does not remove it.
3. **A libgm decrypt failure is invisible to everything.** `event_handler.go:177-185` acks the frame *even when decryption failed* — consumed, never replayed, no drop log, no gap signal, no watermark disagreement. Only the daily deep sweep can stumble across the result.
4. **Recovered media may be permanently unfetchable.** Google-hosted media expires and a decryption key may only ever have arrived on one lost frame (the COALESCE merge at `RcsCacheStore.ts:199-229` exists precisely because keys arrive late and separately). A sweep can restore a picture's row and never its bytes — arguably worse UX than the current silence.
5. **Recovered messages are near-silent by design.** One coalesced push per sweep for inbound messages under 24h old, not one per message. A four-day recovery arrives quietly. That is a deliberate choice against a 400-notification storm and it will occasionally be the wrong one.

---

## 3. The design

### 3.1 Schema — two new sibling tables, zero ALTERs

Both go in the **existing** `CREATE TABLE IF NOT EXISTS` block at `RcsCacheStore.ts:42-64`, exactly like `rcs_cursor` already does. On an existing prod `rcs.db` they are simply created on next boot; on a fresh one they are created with everything else. There is no version number to bump and nothing to roll forward.

```sql
-- Forward currency: "how current are we with the phone, per conversation?"
-- rcs_cursor answers the OTHER question ("how far back have we walked?") and is untouched.
CREATE TABLE IF NOT EXISTS rcs_sync_state (
    conv_id         TEXT PRIMARY KEY,
    phone_id        TEXT    NOT NULL DEFAULT '',  -- scopes the watermark to one pairing
    hw_msg_id       INTEGER NOT NULL DEFAULT 0,   -- numeric Google messageID high-water
    hw_ts_ms        INTEGER NOT NULL DEFAULT 0,   -- diagnostics + degraded fallback only
    conv_latest_id  TEXT    NOT NULL DEFAULT '',  -- Conversation.latestMessageID, last seen
    conv_ts_ms      INTEGER NOT NULL DEFAULT 0,   -- Conversation.lastMessageTimestamp, last seen
    swept_at        INTEGER NOT NULL DEFAULT 0,
    deep_swept_at   INTEGER NOT NULL DEFAULT 0,   -- last watermark-ignoring page-1 re-walk
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,   -- backoff; NEVER a terminal state
    outcome         TEXT    NOT NULL DEFAULT '',  -- ''|clean|capped|error|cooldown
    last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rcs_sync_due ON rcs_sync_state (next_attempt_at);

-- The app-facing journal: "what has this server learned, in the order it learned it?"
CREATE TABLE IF NOT EXISTS rcs_ingest_log (
    msg_id TEXT PRIMARY KEY,
    seq    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcs_ingest_seq ON rcs_ingest_log (seq);

-- Counter + generation stamp. One row each.
CREATE TABLE IF NOT EXISTS rcs_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

**One-time seeding**, run in the constructor right after the DDL, idempotent because both use `INSERT OR IGNORE` / `WHERE NOT EXISTS`:

```sql
-- 1. generation: a uuid minted once per rcs.db file. If the file is ever deleted or
--    restored, a NEW uuid is minted and the app is forced to reset its cursor instead
--    of silently suppressing everything forever.
INSERT OR IGNORE INTO rcs_meta (k, v) VALUES ('generation', :uuid);

-- 2. seed the journal from what we already hold, in (ts, id) order, so the app's first
--    pull isn't 4,496 rows of ancient history at seq 1..4496 — it just starts at the head.
INSERT OR IGNORE INTO rcs_ingest_log (msg_id, seq)
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_ms, CAST(id AS INTEGER)) FROM rcs_messages;
INSERT OR IGNORE INTO rcs_meta (k, v)
  VALUES ('seq', (SELECT COALESCE(MAX(seq), 0) FROM rcs_ingest_log));

-- 3. seed watermarks from what we already stored (so the first sweep isn't a full re-page).
INSERT OR IGNORE INTO rcs_sync_state (conv_id, hw_msg_id, hw_ts_ms)
  SELECT conv_id, MAX(CAST(id AS INTEGER)), MAX(ts_ms) FROM rcs_messages GROUP BY conv_id;
```

On prod this writes 4,496 + ~34 rows once (~50 ms at boot) and is a no-op on every later boot.

**`rcs_cursor` (`rcsTables.ts:80-85`) is not touched, not reset, not redefined.** Its `backfilled_complete` correctly means "we walked back to the oldest message the phone holds" — a statement about the *past*. The bug was using that to skip a conversation forever (`RcsListener.ts:555-556`). The fix is that the **forward** sweep reads only `rcs_sync_state` and never reads `rcs_cursor`, and the **backward** backfill never writes `rcs_sync_state`. Two tables, two jobs. That is the whole structural point, and it needs no repair of the 32 latched prod rows.

### 3.2 Why the watermark is the numeric ID and not the timestamp

Prod evidence: all 4,496 ids are numeric (min 17, max 16000, zero non-numeric). Among the 500 newest messages by time, id order agrees with time order on **499/499** adjacent pairs. But globally only 912 of 4,495 pairs agree, 831 rows carry ids > 15000 with timestamps back to 1970, two rows have `ts_ms = 0`, and ids 15996/15997 share the same second. So: **id is safe for live arrivals, timestamp is not safe for anything.** The timestamp is stored as a tiebreak and as a fallback for the degraded case where the sidecar is too old to send `latestMessageID`.

The watermark is scoped by `phone_id` (already tracked at `bridge.go:195` from `sess.Mobile.GetSourceID()`, exposed on `/status` at `bridge.go:707,724`). A re-pair changes it → all watermarks reset to 0 rather than suppressing everything under a stale id space.

### 3.3 New / changed functions

**Go — `packages/rcs-sidecar/`**

| File:line | Change |
|---|---|
| `bridge.go:793-810` | `ListConversations(count, folder)` — wrap in `withReauthRetry` (`bridge.go:575`) + `callRPC(rpcTimeout)` (`bridge.go:540`, 30s at `bridge.go:83`); add the folder arg (today it hardcodes `_INBOX`). |
| `bridge.go:811-836` | `FetchMessages` — same wrapping; also return `resp.GetTotalMessages()` instead of discarding it. |
| `bridge.go:1323-1355` | `broadcast` — `durableKind(kind)` gate; assign `seq` inside `hubMu`; `subscribers` becomes `map[int]*sub` where `sub{ch, dropped atomic.Int64}`; increment `dropped` on the existing `default:` branch (`bridge.go:1351`) instead of only logging. |
| `normalize.go:16-25, 151-180` | `NormConversation` gains `LatestMessageID` (Conversation field 17) and `Status` (field 12). Populate from **both** `c.GetLatestMessageID()` and `c.GetLatestMessage().GetMessageID()` (line 177 already calls the latter for the snippet), preferring whichever is non-empty — we have never observed field 17 populated, so this buys a second independent source for free. Log which one fired. |
| `server.go:176-184` | `handleConversations` gains `?folder=inbox\|archive\|spam`, default `inbox` (today's behaviour byte-identical). |
| `server.go:207-231` | `handleMessages` adds `"totalMessages"` to the response body. |
| `server.go:417-455` | `handleEvents` writer loop: before each write, `if n := sub.dropped.Swap(0); n > 0` emit `{"kind":"gap","dropped":n}`. The writer goroutine owns `w`, so this costs no channel slot. |
| `main.go:37-42` | Read `BBD_RCS_PING_MINUTES` (already set at `RcsSidecarService.ts:287`, already defaulted to 20 at `configSchema.ts:122`, currently **read by nobody**) and call `cli.SetPingInterval`. libgm's default is 1 minute (`libgm/client.go:175`) = ~1,440 phone round-trips/day. This alone frees ~1,370/day — more than the entire reconciler spends. |

**TypeScript — `packages/bbd/src/rcs/`**

| File | Change |
|---|---|
| `rcsGap.ts` **(new, pure, no I/O, no clock)** | `numericId(id)`, `statusRank(status)`, `needsSweep(conv, state, now)`, `backoffMs(attempts)`, `pageMeetsWatermark(page, hwMsgId)`. Everything worth testing lives here. |
| `RcsReconciler.ts` **(new)** | The service. One 60s timer, one in-process `#sweeping` boolean, every fetch carrying `AbortSignal.timeout(...)`. |
| `RcsCacheStore.ts` | DDL + seeding above; `getSyncState`/`listSyncStates`/`recordProbe`/`advanceWatermark`/`recordSweep`; `bumpIngestSeq(msgId)`/`listSince(seq, limit)`/`generation()`; `upsertMessageFromSweep()` — a status-rank-guarded, text-preserving variant so a sweep page reporting `sent` can never regress a live row already at `read`. **The live `upsertMessage` (`RcsCacheStore.ts:175-232`) stays byte-identical.** |
| `rcsTables.ts` | `rcsSyncStateTable`, `rcsIngestLogTable`, `rcsMetaTable`. |
| `rcsTypes.ts` | `RcsSidecarConversation` gains `latestMessageID?`/`status?`; `RcsMessagesPage` gains `totalMessages?`. |
| `RcsListener.ts` | `#ingestMessage` (`:339-403`) calls `advanceWatermark` + `bumpIngestSeq` on the live path, and gates the push on `!msg.isOld` (the flag is on the wire at `normalize.go:68,234` and currently **never read**). `#handleAlert` (`:221-242`) forwards `BROWSER_ACTIVE` / `MOBILE_DATABASE_SYNC_COMPLETE` as a sweep hint and `PUSH_THROTTLE_STARTED`/`_ENDED` as a hard stop/resume. `#fetchPage` (`:603-614`) gains an `AbortSignal`. `#backfill`/`#backfillOne` **unchanged**. |
| `backend.ts` | Construct `RcsReconciler` beside `RcsListener` (`:897`) with the same sinks; append to the supervised service list (`:1352`) after `rcsListener`. |
| `readOperations.ts` | New sibling op `rcs-query-messages` (`POST /api/v1/rcs/message/query`) beside `query-messages`. The existing "deliberately not merged" comment at `:350-364` stays accurate and gains a pointer to it. |
| `coreOperations.ts:79-93` | `supports_rcs_query` capability flag. |

**App — `bluebubbles-rn/`**

| File | Change |
|---|---|
| `src/core/api/endpoints/messages.ts` (beside `queryMessages`, `:164`) | `rcsQueryMessages(http, { afterSeq, limit })`. |
| `src/core/models/serverInfo.ts` (beside `:59`) | `supports_rcs_query: z.boolean().nullish()`. |
| `src/services/sync/rcsSync.ts` **(new)** | `syncRcsMessages(db, api)` — kv cursor `sync.rcsSeq` + `sync.rcsGeneration`; a generation mismatch resets the cursor to 0. |
| `src/services/syncControl.ts`, `src/services/background/backgroundSync.ts:41-58` | Call it from `startSync` and the 15-minute task. **Today that task runs only `incrementalSync` → `queryMessages`, which excludes RCS by design — so it can currently recover zero RCS messages, ever.** |

### 3.4 The sweep, in numbered steps

Every 60 seconds, `RcsReconciler.tick()`:

1. **Gate.** Skip entirely if `rcsEnabled` is false, the sidecar isn't running, `#sweeping` is already true, or a `PUSH_THROTTLE_STARTED` is in effect without a matching `_ENDED`.
2. **Identity check.** `GET /status`. If `phoneID` differs from the stored one, wipe every `hw_msg_id` to 0 and store the new id. A different phone means a different id space.
3. **Discover** (only if ≥5 min since the last discovery, or a hint alert fired). `GET /conversations?count=100&folder=inbox`. Upsert every row into `rcs_conversations` and record `conv_latest_id` / `conv_ts_ms` into `rcs_sync_state`. Once a day, also `?folder=archive`. This endpoint has **zero callers in bbd today**.
4. **Gate per conversation** — the pure `needsSweep(conv, state, now)` returns true when *any* of:
   - `numericId(conv.latestMessageID) > state.hw_msg_id` (the primary test), **or**
   - `latestMessageID` is empty **and** `conv.lastMessageTimestampMs > state.hw_ts_ms` (degraded fallback — log that it fired, so the degradation is visible), **or**
   - `state.hw_msg_id === 0` (never swept — this is prod's conv 39 and 208, live snippet + zero stored messages), **or**
   - `now - state.deep_swept_at > 24h` (**the unconditional backstop**: re-walk page 1 with the watermark ignored, which is the only thing that can find an interior hole).
   
   And `now >= state.next_attempt_at` (backoff), and `outcome !== 'cooldown'`.
5. **Order** by `hw_msg_id === 0` first, then by how far behind the watermark is. Take at most **3 conversations per tick** so a burst is spread over minutes rather than fired at the phone at once.
6. **Sweep one conversation, serially:** `GET /conversations/{id}/messages?count=50` with **no cursor** (a nil cursor means "the newest N" — that is the only forward primitive the protocol has). For each page, oldest→newest:
   - `upsertMessageFromSweep(m)` for every message; `replaceReactions` only when the incoming list is non-empty.
   - `bumpIngestSeq(m.messageID)` when the upsert reports `isNew || changed`.
   - Track `newMax = max(numericId)` over the page and `insertedThisPage`.
7. **Stop** when: (a) `insertedThisPage === 0` **and** every id on the page is `<= hw_msg_id` → `outcome='clean'`; (b) no next cursor → `outcome='clean'`; (c) 6 pages / 300 messages → `outcome='capped'` (logged loudly, retried next tick from the newest again — at prod's ~35 msgs/day this cannot happen for any realistic outage, and if it ever does the log tells you to add a resume cursor).
8. **Commit.** On `clean`, `hw_msg_id = max(hw_msg_id, newMax)`, `attempts = 0`, `swept_at = now`, and if this was a deep sweep, `deep_swept_at = now`. **On `capped` or `error`, the watermark is not advanced** — only a sweep that proved contiguity may move it.
9. **On error:** `attempts += 1`, `next_attempt_at = now + backoffMs(attempts)`, record `last_error`. At `attempts >= 8`, `outcome='cooldown'` with a 6h `next_attempt_at` — and then it becomes eligible again. **There is no terminal state.** That is the direct structural inverse of `setCursor(convId, null, true)` at `RcsListener.ts:588`, which is why all 32 prod cursor rows are permanently skipped today.
10. **Fanout.** Recovered messages go through `#fanoutMessage(type, dto, { push: false })` so they reach socket + webhook (today the backfill path at `RcsListener.ts:571-584` does **no fanout at all**). Then at most **one** coalesced push per sweep run summarising inbound messages under 24h old. Call `prefetchMedia` for each recovered attachment. Suppress `MESSAGE_DELETED` (status 300) frames while `#sweeping` — the phone re-emits deletes during a resync.

### 3.5 Why it can neither duplicate nor lose

**Cannot duplicate (idempotency).** Every write path is keyed on the Google `messageID` primary key (`rcs_messages.id`, `RcsCacheStore.ts:193-197`). Re-ingesting the same message is an upsert, not an insert. Reactions are full snapshots replaced wholesale, never accumulated. Attachments merge per `(messageId, mediaId)` with COALESCE, so a keyless re-delivery cannot erase a learned key. Google's own replay is therefore harmless — libgm's dedup is 8 slots deep and `return`s out of the rest of a batch on a hit (`libgm/event_handler.go:254-255`), so redelivered frames reach us essentially un-deduped and we must be idempotent regardless. On the app side the same holds: RCS messages arrive as `MessageV1` with a stable `rcs-<messageID>` guid (`rcsMapping.ts:40-42`) and go through the existing guid-keyed `upsertMessages`.

**Cannot lose (ordering).** Three separate arguments:

- *Watermark.* `hw_msg_id` only ever increases, and only after a sweep proved it read a contiguous run down to the previous value. A capped or errored sweep stores nothing, so the next sweep re-covers exactly the same ground. A backward backfill never writes it. Therefore the watermark can never claim coverage the sweep did not achieve.
- *Journal.* `seq` comes from a single monotonic counter and a row's seq only ever moves **forward**. The app reads `WHERE seq > cursor ORDER BY seq LIMIT n`. A row whose seq is bumped from 50 to 500 while the app's cursor sits at 100 was already delivered at 50 and will be delivered again at 500 — a duplicate, which is idempotent. A row can never move *backward* past a cursor, which is the only way a "give me everything after X" cursor can skip. Since seq is bumped on `isNew || changed`, status advances the app missed while offline are pulled too.
- *Generation.* If `rcs.db` is rebuilt, the generation uuid changes, the app resets its cursor to 0, and re-pulls. Without this, a restored backup silently suppresses every RCS message forever with no error anywhere.

**One honest gap in the argument:** step 7(a)'s stop condition is fooled if the phone re-emits messages we already have *interleaved* with ones we do not. Only the 24h deep sweep covers that, and only 50 messages back.

---

## 4. Phases

### Phase 1 — Stop the bleeding: bound every RPC (S, no behaviour change) — ✅ IMPLEMENTED 2026-07-27, NOT YET DEPLOYED

**This is the correct first commit no matter what else you ever build.** Ship it alone.

> **As built.** Both paging RPCs now go through `callRPC(rpcDeadline)` **and** `withReauthRetry`
> (`bridge.go`); `GET /conversations` takes an optional `?folder=` that rejects an unrecognised
> value rather than silently serving the inbox; `#fetchPage` and `#fetchMediaBytes` carry an
> `AbortSignal.timeout` **around the body read as well as the request** (the signal aborts the
> response stream too, so a half-delivered page rejects out of `json()`, not `fetch()`); and
> `main.go` finally reads `BBD_RCS_PING_MINUTES`, which bbd has exported since day one and
> nothing ever consumed — libgm therefore ran at its 60s constructor default instead of the 20m
> that upstream mautrix-gmessages' own `example-config.yaml` ships. Each guard was
> **mutation-tested**: with the wrapper removed the Go test hangs to its 12s deadline and both
> bbd tests fail with the exact production symptom (the second conversation never backfills;
> the queued media download never runs). Timeout-injection seams (`backfillPageTimeoutMs`,
> `fetchTimeoutMs`, `rpcTimeoutOverride`) exist so those tests run in milliseconds.
>
> **The one real behaviour change is the ping cadence** (1,440 → 72 phone round-trips/day).
> Everything else is strictly "a hang becomes an error". Watch for `PhoneNotResponding`
> arriving later than before after deploy; `rcsPingMinutes` can be lowered in config without
> a rebuild if that matters.

`ListConversations` (`bridge.go:793`) and `FetchMessages` (`bridge.go:811`) are the only two libgm reads wrapped in **neither** `callRPC` **nor** `withReauthRetry`. libgm's response wait ends in a bare `return <-ch, nil` under a literal `// TODO hard timeout?` (`libgm/session_handler.go:167`). `#fetchPage` (`RcsListener.ts:603-614`) carries no `AbortSignal`, and the whole backfill is serialised behind one boolean (`RcsListener.ts:550-560`) whose `finally` never runs if the `await` never returns.

**Files:** `bridge.go` (wrap both, add the folder arg), `RcsListener.ts:603-614` + `RcsMediaCache.ts` (`AbortSignal.timeout(35_000)` — just past Go's 30s `rpcTimeout` so the Go side reports the real error first), `main.go:37-42` (read `BBD_RCS_PING_MINUTES`).

**Prevents:** one unanswered page permanently disabling all recovery for the life of the process — *in the code that ships today*. Also cuts phone round-trips from ~1,440/day to ~72/day.

**Proves it works:**
```bash
cd /Users/munkle/github/BB/bluebubbles-server/packages/rcs-sidecar && \
  go build ./... && go test ./... -run 'TestPagingRPCsAreTimeoutBounded|TestBroadcast' -v
cd ../bbd && npm run typecheck && npm test -- test/rcsListener.test.ts
```

### Phase 2 — Remember what we know (S/M, invisible)

The three tables + seeding + the live-path writes. **No reconciler runs.** Nothing behaves differently.

**Files:** `rcsTables.ts`, `RcsCacheStore.ts:42-64` + new methods, `RcsListener.ts:339-403` (`advanceWatermark` + `bumpIngestSeq`).

**Prevents:** nothing yet — it is the foundation, and it is the step where a schema mistake would hurt, so it lands alone and is verified against a copy of prod's `rcs.db` before it ships.

**Proves it works:**
```bash
cd packages/bbd && npm run typecheck && npm test -- test/rcsCacheStore.test.ts
# then, against a LOCAL COPY of prod rcs.db (never the live file):
scp bubbles@192.168.1.11:'~/Library/Application\ Support/gator-server/rcs.db' /tmp/rcs-copy.db
npx tsx -e "new (require('./src/rcs/RcsCacheStore').RcsCacheStore)('/tmp/rcs-copy.db')" && \
sqlite3 /tmp/rcs-copy.db "SELECT COUNT(*) FROM rcs_ingest_log; SELECT COUNT(*), SUM(hw_msg_id>0) FROM rcs_sync_state; SELECT * FROM rcs_meta;"
# expect 4496 journal rows, ~34 sync rows all with a watermark, and a generation uuid.
# run it TWICE — the second run must change nothing.
```

### Phase 3 — The reconciler (M, ships default OFF)

`rcsGap.ts` + `RcsReconciler.ts` + the sidecar's `latestMessageID`/`status`/`totalMessages`/`folder`/`seq`/gap-counter + `isOld` honoured + `MESSAGE_DELETED` suppression. Behind config `rcsReconcileEnabled` (**default false**) and `rcsDiscoveryMinutes` (default 5).

**Prevents:** permanent loss from a reconnect gap, a buffer overrun, a boot race, or days of downtime — the actual bug.

**Proves it works:** unit tests, then on prod, flip the flag and watch:
```bash
# BEFORE enabling — the read-only probe that decides whether any of this recovers anything:
ssh bubbles@192.168.1.11 'curl -s -H "Authorization: Bearer $SECRET" \
  http://127.0.0.1:8099/conversations/39/messages?count=50 | head -c 400'
# If that returns messages, conv 39 (live snippet, ZERO stored messages) is recoverable
# and this phase has a visible acceptance test. If it returns [], the phone no longer
# holds it and no design here can recover it — say so out loud rather than shipping a promise.

# AFTER enabling:
ssh bubbles@192.168.1.11 'tail -f ~/Library/Logs/Gator/bbd.log | grep rcs-reconcile'
ssh bubbles@192.168.1.11 'sqlite3 -readonly ~/Library/Application\ Support/gator-server/rcs.db \
  "SELECT conv_id, hw_msg_id, outcome, attempts, last_error FROM rcs_sync_state ORDER BY swept_at DESC LIMIT 10;"'
```
The acceptance test is conversations **39** and **208** going from zero stored messages to populated.

### Phase 4 — Let the app pull (M)

`rcs-query-messages` + `supports_rcs_query` + `syncRcsMessages` in `startSync` and the 15-minute background task.

**Prevents:** recovered messages reaching `rcs.db` and stopping there. Today the app's only bulk RCS reader is `ensureChatSynced` on chat open, so a server-side recovery is invisible until the user opens each thread one by one.

**Proves it works:**
```bash
cd /Users/munkle/github/bluebubbles-rn && npm run typecheck && npm test
curl -s -X POST https://gator.munkledata.com/api/v1/rcs/message/query \
  -H "Authorization: Bearer $PW" -H 'content-type: application/json' \
  -d '{"afterSeq":0,"limit":5}' | jq '{generation, count:(.data|length), maxSeq:([.data[].seq]|max)}'
```
Old app + new server: unaffected. New app + old server: the flag is absent, the call is skipped.

---

## 5. Tests

### Node-testable (extract these pure functions into `packages/bbd/src/rcs/rcsGap.ts` — no I/O, no clock)

| Function | Cases that matter |
|---|---|
| `numericId(id)` | `"16000"` → 16000; `""`/`"abc"` → 0 (never NaN, never negative). |
| `statusRank(status)` | `sending < sent < delivered < read`; `failed`/`received` handled explicitly. This is what stops a sweep page reporting `sent` from undoing a live `read`. |
| `needsSweep(conv, state, now)` | latest-id mismatch → true; equal ids → false; `hw_msg_id === 0` → true (**the prod 39/208 case**); empty `latestMessageID` falls back to the timestamp branch and *reports which branch fired*; `next_attempt_at` in the future → false; `deep_swept_at` older than 24h → true regardless of everything else. |
| `backoffMs(attempts)` | monotone, capped, and `attempts >= 8` yields the 6h cooldown — then *eligible again*. |
| `pageMeetsWatermark(page, hw)` | true only when zero inserts **and** every id ≤ hw. |

**Store-level** (`test/rcsCacheStore.test.ts`, already runs against a temp better-sqlite3 file): the seeding is idempotent across two constructions; `bumpIngestSeq` advances on `isNew` and on `changed` but not on an unchanged redelivery; a bumped seq moves forward, never backward; `listSince` pages with no gaps or repeats; `upsertMessageFromSweep` cannot lower a status or null out stored text; the watermark never regresses.

**Service-level** (`test/rcsReconciler.test.ts`, fake `fetch` + real store): gap gate skips a current conversation and sweeps a never-swept one; a clean sweep advances the watermark and a capped/errored one does not; `PUSH_THROTTLE_STARTED` suspends and `_ENDED` resumes; a sweep never calls the push sink per message; a `phoneID` change resets every watermark.

**The one test that decides whether any of this is trustworthy:** a fetch that never resolves must abort at the page timeout, record `error` for **that** conversation only, and let the tick proceed to the next conversation and the next tick run normally.

**Go** (`packages/rcs-sidecar/bridge_test.go`, already 399 lines — extend, don't build a harness): `TestPagingRPCsAreTimeoutBounded` (a stub client that never returns → `errRPCTimeout` within `rpcTimeout`); `TestBroadcastAssignsMonotonicSeq` (N concurrent broadcasters → seq set is exactly 1..N, and `heartbeat`/`typing` carry no `seq` key at all); `TestSlowSubscriberIncrementsDropped`.

### Prod/device-only — must be verified by observation

These are **unmeasured**, and every cost figure above is arithmetic on constants I read, not a measurement:

1. Whether `Conversation.latestMessageID` is ever populated at all. We have never observed it. If it comes back empty the gap gate silently degrades to the weaker timestamp test — hence the "log which branch fired" requirement.
2. Whether the phone honours `count=100` for conversations or `count=50` for messages, or silently truncates.
3. Whether conversations 39 and 208 are recoverable at all (the Phase-3 pre-flight probe).
4. Whether the four missing ids (15858, 15933, 15934, 15984) were dropped or legitimately absent (drafts, phone-side deletions).
5. Wall-clock latency of one `FetchMessages` page against this phone. Prod `bbd.log` is 2,227 bytes with zero backfill timing lines — there is no historical data to mine.
6. Whether `PUSH_THROTTLE_STARTED` ever fires, and at what request volume.
7. Whether a re-pair actually changes `sess.Mobile.GetSourceID()`, and whether phone-local ids restart at 1.

---

## 6. Rollout and rollback

**Deploy mechanics.** bbd hot-swaps: build with `npm run build-bbd`, copy `packages/bbd/dist/daemon-entry.cjs` to `/Applications/Gator.app/Contents/Resources/bbd/daemon-entry.cjs` on prod, restart the app. The sidecar is a Go binary at `Contents/Resources/appResources/macos/daemons/gator-rcs/arm64/gator-rcs` (source of truth: `packages/server/appResources/macos/daemons/gator-rcs/arm64/gator-rcs`) — build with `cd packages/rcs-sidecar && GOARCH=arm64 go build -o ...`, and **re-codesign after replacing it** or macOS will refuse to spawn it. Note the audit's finding that the checked-in binary can go stale relative to the Go source: build the sidecar as part of the release, don't trust the committed artifact.

**Order.** Phase 1 sidecar + bbd together (the folder arg is additive and defaults to today's behaviour, so an old bbd against a new sidecar is fine and vice versa). Phase 2 bbd only. Phase 3 both, **with `rcsReconcileEnabled` false**, then flip the flag by itself after the read-only probe. Phase 4 server first, app second on the normal 0.1.x internal track.

**What to watch after Phase 3 goes live** (all new log lines — none of this exists in any form today):
- `rcs-reconcile: swept <conv> pages=N stored=M outcome=clean` — count of sweeps/day is your real gap rate.
- `rcs-reconcile: gap gate fell back to timestamp` — if this is *every* conversation, `latestMessageID` is not populated and the gate is weaker than designed.
- `{"kind":"gap","dropped":N}` on the stream — the 256-slot buffer actually overflowing.
- `stored N of M` — the first honest measurement of how much the phone holds.
- `outcome='capped'` — if this repeats, add the resume cursor that was deliberately cut.

**Rollback.**
- Phase 4: the app skips the call if `supports_rcs_query` is absent; reverting the server op is enough.
- Phase 3: set `rcsReconcileEnabled = false`. No redeploy, no restart of anything else. This is why it ships flagged.
- Phase 2: revert `daemon-entry.cjs`. Three unused tables and one index remain in `rcs.db`; nothing reads them and nothing else changed.
- Phase 1: revert `daemon-entry.cjs` and restore the previous signed sidecar binary.

There is **no forward-incompatible write anywhere**. Nothing modifies `rcs_cursor`, `rcs_messages`, `rcs_conversations`, `rcs_attachments` or `rcs_reactions`, so a rolled-back binary sees exactly the database it left.

---

## 7. What is still not covered after all four phases

1. **Messages the phone no longer holds.** Unrecoverable, by construction. The sweep will report a perfectly clean outcome for a conversation whose history Bugle rotated away.
2. **Conversations outside the newest 100 of INBOX (+ the daily ARCHIVE pass).** A thread that went quiet during a long outage and got pushed out of the window is invisible to the gap test forever, and *nothing will ever notice*. Fixing this requires forking or upstreaming libgm to expose `ListConversationsRequest.cursor`.
3. **SPAM_BLOCKED.** Reachable via the new `?folder=` param but never queried by policy. A legitimate message Google misfiled is unrecoverable and the user gets no signal that the folder exists.
4. **libgm decrypt failures.** Acked and consumed with no replay (`event_handler.go:177-185`). They produce no dropped-line log, no gap line, and no watermark disagreement. Only the 24h deep sweep can stumble across the result, and only within 50 messages.
5. **Interior holes deeper than 50 messages.** The deep sweep's reach is fixed and does not adapt. If the `stored N of M` diagnostic ever shows a large persistent delta, that is your signal to scale it.
6. **Media whose bytes have expired.** A sweep can restore an attachment row and never its bytes. The app will render a broken attachment where today it renders nothing — arguably worse. `prefetchMedia` at least makes the failure observable as a failed download rather than silence.
7. **Notification fidelity for recovered messages.** One coalesced push per sweep, not one per message. "I never got a notification for that" stays true for anything the live stream missed by more than the coalescing window.
8. **A reaction removed while offline.** Reactions are full snapshots and the sweep only calls `replaceReactions` when the incoming list is non-empty (so a sweep can't wipe a live snapshot). The cost is that an empty snapshot is indistinguishable from "no data", so removals during downtime are silently retained.
9. **The control plane.** If the sidecar is dead, the reconciler gates off and writes nothing. It fixes the data plane only; a reconciler cannot report its own inability to run. That remains the watchdog's and `RcsSidecarService.onFault`'s job — already shipped, and this design assumes it holds.
10. **Identity.** Sender addresses are still display names and formatted numbers, not E.164 (`normalize.go:151-180`). Untouched here; a recovered message inherits the same unknown-sender/notification-gate weakness a live one has.

**One thing to take away:** the reason this bug survived four days silently is not that the code lacked a retry — it is that `setCursor(convId, null, true)` (`RcsListener.ts:588`) let a statement about the *past* ("we finished walking backward") become a permanent decision about the *future* ("never look at this conversation again"). Any state that means "give up" needs an expiry. That is the whole lesson, and it generalises well beyond RCS.

---

## 8. Verified against prod, 2026-07-27 (added after the design landed)

Two claims decided which design won, so both were re-checked directly on `bubbles@192.168.1.11`
(read-only) rather than taken on trust:

**1. The loss really is INTERIOR holes, not tail truncation.**
```
ids present in 15850-16000:  147 of 151
15858: 0   15933: 0   15934: 0   15984: 0     <- missing
15859: 1   15935: 1   15985: 1                <- newer ids in the same range, present
```
This is why a "page newest-first and stop at the first id you already have" reconciler cannot
repair prod: on a healthy tail it stops at row 1 of page 1 and never crosses the hole. Only the
unconditional daily deep sweep reaches these.

**2. The phone still holds what we are missing — so recovery is real, not theoretical.**
Both conversations that have a live snippet and ZERO stored messages returned data from the
sidecar's paging route:
```
conv 39  (snippet 2026-04-01, 0 stored) -> messageIDs 749, 748, ...   "Alright, it will be about 215ish..."
conv 208 (snippet 2024-07-23, 0 stored) -> messageID 3190
```
These two conversations are the acceptance test for Phase 3: they must go from zero stored
messages to populated. If they do not, the phase did not work.
