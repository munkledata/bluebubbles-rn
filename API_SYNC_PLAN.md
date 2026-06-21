# API model sync plan — RN app ⇄ Gator server

_2026-06-21. How to align the RN app's zod models (`bluebubbles-rn/src/core/models`,
`src/core/api/endpoints`) with the Gator server's wire contracts
(`bluebubbles-server/packages/protocol` + `packages/bbd/src/serialize` + `.../api/operations`).
Grounded in a field-by-field divergence pass over both repos._

## Status (2026-06-21)

**Phase A — app adapts (DONE, on `bluebubbles-rn` master):** ServerInfo accepts Gator's `{version}`
(connect no longer throws) + advisory version gate; Find My uses Gator's `/findmy/*` paths + tuple/
camelCase shapes; scheduled adapted to Gator's `/scheduled-message` flat shape + string id +
delete-recreate edit. Contract-test gate stood up (`test/contract/wireContract.test.ts`). 449 tests.

**Phase D — server adds (DONE, on `bluebubbles-server` branch `app-sync/additive-wire-fields`):**
- #7 delivered-tier flags (`wasDeliveredQuietly`/`didNotifyRecipient`) emitted by `messageSerializer`.
- #1 `server/info` now also returns `server_version`/`private_api`/`proxy_service`/`supports_header_auth`.
- #4 `chat/query` honors `with:[participants,lastMessage]` (the inbox now gets members + a preview).
- bbd: 219 tests, tsc + lint clean. All additive (no wire renames/removals).

**Still open:** Phase B (formalize per-entity shapes in `protocol/v1`), Phase C (generate fixtures from
the server + extend the contract test to every entity), and the heavier Phase D items below — chat
mutations (#5, needs the Private-API write path), nested attachments (#6), and rich message fields
(attributedBody/payloadData/messageSummaryInfo — the reader has the columns; needs typedstream
decoding). os_version on `server/info` also left out.

## TL;DR — the core problem

The RN app was ported against **upstream BlueBubbles**'s `/api/v1`. Your server is the **Gator
fork**, a leaner re-implementation that **claims `protocol/v1` is "frozen / byte-compatible forever"**
but in practice **diverges from it** (renamed paths, missing fields, changed shapes). Net: **the app
breaks against Gator today** in several spots. There is also **no shared typed contract for the
per-entity `data` shapes** — only the envelope is in `protocol`; Message/Chat/Handle/Attachment are
defined implicitly by the `bbd/serialize/*` functions and mirrored by hand in the app's zod. That gap
is the drift engine.

**Good news:** the envelope is healthy in this server version — `apiResponse` unwraps
`{status,message,data}` correctly (no double-wrap), and both REST + Socket.IO accept the
`Authorization: Bearer` header the app sends (with a query fallback). So auth + transport are fine.

## Source of truth

Make **`protocol/v1` the single typed source of truth for the whole wire contract**, not just the
envelope. Today it only defines `ResponseFormat<T>`; extend it with the per-entity `data` shapes
(`MessageV1`, `ChatV1`, `HandleV1`, `AttachmentV1`, `ServerInfoV1`, `ScheduledMessageV1`,
`FindMyDeviceV1`/`FindMyFriendV1`, plus `ResponseError` + `ResponseMetadata`). Then:
- the **server** serializers/operations are typed to return those shapes (compile-time conformance);
- the **app** zod models are the runtime mirror of those shapes (one per entity), validated against
  golden fixtures in CI (below).

Direction rule: where Gator **drifted from upstream v1**, the **server** is wrong (it broke its own
frozen contract → fix server). Where Gator **intentionally** changed/renamed, the **app adapts** AND
`protocol/v1` is updated to document the real v1. Client-only fields never belong on the wire schema.

---

## Divergence decision table (prioritized)

### 🔴 P0 — the app cannot work against Gator until these are fixed

| # | Divergence | Decision |
|---|---|---|
| 1 | **ServerInfo**: server emits `{ version }`; app's `ServerInfo` **requires** `server_version` (+ wants `os_version`, `private_api`, `proxy_service`, `supports_header_auth`). App's `.parse` **throws → connect/version-gate fails**. | **Server** adds the v1 fields (`server_version`, `os_version`, `private_api`, `proxy_service`, `supports_header_auth`) in `coreOperations.ts`. Short-term **app** softens `server_version` to also read `version`. |
| 2 | **Scheduled path/shape**: app calls `/message/schedule` (GET/POST/**PUT**/DELETE), nested `{ payload:{chatGuid,message,method}, scheduledFor, schedule, type, id:number }`. Server is `/api/v1/scheduled-message` (GET/POST/DELETE only), **flat** `{ id:**string-uuid**, chatGuid, text, scheduledFor, status }`. → 404s, `z.number()` id rejects, no update, no recurrence. | **Both.** Server restores the upstream `/message/schedule` path + nested shape + PUT + the `schedule` recurrence field (honors frozen v1), **or** app adapts to `/scheduled-message` + flat shape + string id. Pick one and encode in `protocol/v1`. (Recommend server-conforms — the app already shipped the upstream shape.) |
| 3 | **FindMy path/shape**: app calls `/icloud/findmy/{devices,friends}(/refresh)`; server is `/api/v1/findmy/*`. Server uses `coordinates:[lat,lng]` tuple + `handle:string` + `shortAddress`/`longAddress` (camelCase); app's `normalize.ts` expects `.location.latitude`, `.handle.address`, `short_address` (snake_case). → 404 + nothing normalizes. | **Both.** Server restores `/icloud/findmy/*` + the upstream nested/snake_case shape, **or** app adapts paths + `normalize.ts` to the tuple/camelCase shape. Encode in `protocol/v1`. |
| 4 | **Chat `with` directive ignored**: app sends `with:[participants,lastMessage]`; `readOperations.ts` returns bare `serializeChat` (no participants/lastMessage). → inbox rows have no members/preview. | **Server** honors `with` in `/chat/query` + `/chat/{guid}` (nested participants + lastMessage), matching the app's `Chat` model. |

### 🟠 P1 — features silently no-op until the server emits the data

| # | Divergence | Decision |
|---|---|---|
| 5 | **Chat mutations** (`POST /chat/new`, participant add/remove, `PUT /chat/{guid}` rename) — app calls them; server may not implement. → new-chat + group management fail. | **Server** implements these operations returning the updated `Chat` (the app already persists the returned chat). |
| 6 | **Message attachments not nested**: app requests `with=attachments`; `messageSerializer` omits the array. | **Server** nests `attachments[]` on `MessageResponse` when requested (else app must N+1 fetch). |
| 7 | **Delivered tiers**: app just shipped `wasDeliveredQuietly` + `didNotifyRecipient` (Phase 2, migration 0010); server has the DB columns but the serializer **doesn't emit them**. → the "Delivered Quietly" tier never lights up. | **Server** emits both in `messageSerializer`. |
| 8 | **Rich message fields**: server omits `attributedBody`, `messageSummaryInfo`, `payloadData` (rich text / tapback summary / digital-touch). App models them. | **Server** emits them (or documents that Gator drops rich text → app degrades to plaintext). |
| 9 | **Attachment dimensions**: `height`/`width`/`webUrl` app-only (server never sends); `hideAttachment` server-only (app drops). | **Server** adds `height`/`width`; app adds `hideAttachment` to its zod (additive). |

### 🟡 P2 — model hygiene (no breakage, but tighten the contract)

| # | Divergence | Decision |
|---|---|---|
| 10 | **Client-only fields on the wire schema**: app's `Chat` expects `isPinned`/`muteType`/`muteArgs`/`lastReadMessageGuid`; `Handle` expects `color`/`displayName`/`originalROWID`. These are **local UI state / contact enrichment**, not server data. | **App** — move them OUT of the wire zod model (keep them as local DB columns only), so the wire schema reflects only what the server sends. Prevents false "server should send X" confusion. |
| 11 | **Envelope extras dropped**: server sends optional `error:{type,message}` (non-2xx) + `metadata:{offset,limit,total,count}` (pagination); app `apiResponse` models neither. | **App** — add `error` + `metadata` to `apiResponse` (additive) for better error messages + paginated sync. |
| 12 | **Contacts**: server has `GET /api/v1/contact` (`firstName`/`lastName`/`phoneNumbers`/`hasAvatar`); app only uses device contacts (`givenName`/`familyName`/file-uri avatar) and never calls it. | Leave app device-first; **if** server contacts get wired later, add a zod model with the server's naming. Document the intentional gap. |

---

## The plan (phased)

**Phase A — Stop the bleeding (app + server, P0 #1–4).** Get the app *functional* against Gator.
Pick the direction per #1–4 above (recommend: server conforms to upstream v1 paths/shapes; app makes
`server_version` tolerant as a stopgap). Each app-side change lands behind the existing gate
(tsc·eslint·jest) with an updated/added fixture (below).

**Phase B — Formalize the contract in `protocol/v1`.** Promote the per-entity `data` shapes into
`protocol/v1` as exported interfaces (`MessageV1`, `ChatV1`, …) + `ResponseError`/`ResponseMetadata`.
Type the `bbd/serialize/*` functions' return values to those interfaces (compile-time conformance on
the server). This makes "the serializer and the contract agree" a build error if violated.

**Phase C — Drift-prevention gate (the durable mechanism).**
1. **Golden fixtures.** Add a tiny server script/test that serializes representative rows and writes
   canonical JSON fixtures per entity+endpoint into `protocol/fixtures/v1/*.json` (committed).
2. **Contract test in the app.** A jest test loads each fixture and runs the matching zod model's
   `.parse` — a server shape change that the app doesn't model fails app CI. (The app already has the
   zod + the `apiResponse` unwrap; this just points them at the fixtures.)
3. **Reverse check (optional).** A server test asserts each serializer's output still matches its
   `protocol/v1` interface + the committed fixture, so the server can't drift silently either.
4. Publish `@bluebubbles/protocol` (or git-submodule/path-dep it) so the app can eventually import the
   **types** directly and hand-mirror only the zod (or codegen zod from the interfaces via
   `ts-to-zod`).

**Phase D — Close the feature gaps (server, P1 #5–9).** Implement chat mutations, the `with`
directives, nested attachments + dimensions, the delivered-tier flags, scheduled update/recurrence,
and rich message fields — each shrinks the app's "degrade gracefully" branches.

## Recommended first step

Do **Phase A #1 + #2 + #3** now (they're the literal app-breaks): make `ServerInfo` tolerant of
`version`, and decide+apply the scheduled + findmy path/shape direction. Then stand up **one golden
fixture + one app contract test** (Phase C.1–C.2) for `ServerInfo` and `Message` as the template — so
the rest of the reconciliation is test-driven from the start.

> Where to keep this doc long-term: ideally alongside `protocol/v1` in the server repo (the contract's
> home). It lives here for now because that's the active app-side workspace.
