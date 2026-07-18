# iMessage Account screen — server + app implementation plan

_Status: **IMPLEMENTED 2026-07-18** (server `packages/bbd` + app, both unit-tested). Written 2026-07-18._

> **What shipped** (both sides, server-TS only — no dylib rebuild):
> - **Server** (`~/github/BB/bluebubbles-server`, branch `fix/push-delivery-hardening`):
>   `MessageSender.getAccountInfo()`/`setActiveAlias()` (`get-account-info`/`modify-active-alias`),
>   new `api/operations/icloudOperations.ts` (`buildIcloudOperations`) registered in `backend.ts`,
>   `supports_icloud_account` on `ServerInfoV1` + emitted from `server/info` as `cfg.enablePrivateApi`.
>   Tests: `packages/bbd/test/icloudOperations.test.ts` (+ the two ServerInfoV1 literal/assert tests).
>   719 bbd + 11 protocol tests pass.
> - **App**: `serverInfo.supports_icloud_account`, `useIcloudAccountSupported()` +
>   `sessionAccessors.icloudAccountSupported`, Settings row gated on the flag, `account.tsx` 404
>   fallback kept. Tests: `sessionCapabilities.test.ts` + `useIcloudAccountSupported.test.tsx`.
>   1854 app tests pass.
>
> **Two divergences from the plan below (found during implementation):**
> 1. `MessageSender` lives at `packages/bbd/src/messaging/MessageSender.ts`, **not** `api/services/`.
> 2. bbd's `PrivateApiTransport` nests the helper payload **one level (`res.data`)**, not the legacy
>    server's `res.data.data`. So `getAccountInfo()` reads `res.data` (with an `res.extra` fallback).
>
> The rest of the plan (contract, normalization, gating, rollout) matched reality and is preserved
> below for reference and for the on-device verification checklist.

_Feasibility: **confirmed, server-side TypeScript only.**_

## What the screen is for

`app/(app)/account.tsx` (Settings → "iMessage Account…") is the app's equivalent of iOS
_Settings → Messages → Send & Receive_. It shows the signed-in **Apple ID**, the account **name**, a
**login-status** line, and a **"Start Chats Using" alias picker** — the phone numbers/emails on the
account, letting you choose which one _new_ iMessage conversations are sent **from** (limited to the
aliases Apple vetted for iMessage). Reads/writes go through the server's Private-API helper.

Today it always errors: the client calls `GET /api/v1/icloud/account`, which the Gator server never
implemented → 404. The app now maps that 404 to `UnimplementedEndpointError` and shows an honest
"not supported on this server yet" state (`src/core/api/endpoints/icloud.ts`, `account.tsx`). This
plan makes it actually work.

## Feasibility verdict

**Feasible with server TypeScript only — no dylib rebuild.** The injected helper
(`BlueBubblesHelper.dylib`, shipped at `packages/server/appResources/private-api/macos11/`) already
implements the needed actions — confirmed via `strings` on the binary: `get-account-info`,
`modify-active-alias`, `get-nickname-info`, plus a `BBH_IMAccount` category (`getAliases:`,
`vettedAliases`, `activeIMessageAccount`, …) and reply keys `apple_id`, `account_name`,
`active_alias`, `aliases`, `vetted_aliases` (`[{ Alias }]`), `login_status_message`. The Gator daemon
(`packages/bbd`) simply never calls them. A **complete reference implementation** exists in the other
clone `~/github/bluebubbles-server` (`PrivateApiCloud.ts`, `iCloudInterface.ts`, `icloudRouter.ts`,
`httpRoutes.ts:92-115`) — the work is porting that pattern into the bbd operation/registry structure.

## Part A — Server (`~/github/BB/bluebubbles-server`, `packages/bbd`)

### A1. Backing methods on `MessageSender` — template: `checkIMessageAvailability` (`MessageSender.ts:393-404`)
Add two methods (before the closing brace ~line 415), each guarding `this.#transport.isConnected()`
(throw "requires the Private API" like line 395) then dispatching over the framed UDS transport:
- `getAccountInfo()` → `await this.#transport.send({ action: "get-account-info", data: {} })`; the
  payload nests under `res.data` (upstream reads `data.data`); throw on `res.error`; return the raw dict.
- `setActiveAlias(alias)` → `await this.#transport.send({ action: "modify-active-alias", data: { alias } })`;
  throw on `res.error`.

(Alternative: a small `AccountService(PrivateApiTransport)` mirroring `FaceTimeService` — but reusing
the existing `sender` dep is the least new plumbing.)

### A2. New operation group — create `packages/bbd/src/api/operations/icloudOperations.ts`
Copy the shape of `handleOperations.ts` (the closest template — a Private-API read via `deps.sender`).
Two `defineOperation(...)` entries in a `buildIcloudOperations({ sender }): Operation[]` factory:

- **GET** `/api/v1/icloud/account`, `auth: true`, no input → call `sender.getAccountInfo()`, then
  **NORMALIZE snake→camel** (see the gotcha below) and return:
  ```ts
  { appleId: raw.apple_id ?? null, displayName: raw.account_name ?? null,
    activeAlias: raw.active_alias ?? null, aliases: raw.aliases ?? [],
    vettedAliases: (raw.vetted_aliases ?? []).map(e => e.Alias),
    loginStatusMessage: raw.login_status_message ?? null }
  ```
- **POST** `/api/v1/icloud/account/alias`, `auth: true`, input `z.object({ alias: z.string().min(1) })`
  → optionally validate `alias ∈ vettedAliases` (upstream does), call `sender.setActiveAlias(input.alias)`,
  return `{ activeAlias: input.alias }` (matches the app's `SetAliasResult`).

Routing/auth are fully declarative — `mountFastify`/`mountSocket` iterate the registry and auto-expose
any `Operation` on REST **and** Socket.IO; `executeOperation` enforces `auth: true`. No adapter edits.

### A3. Register the group — `packages/bbd/src/backend.ts`
Add `import { buildIcloudOperations } from "./api/operations/icloudOperations";` (near the other
operation imports ~line 56), and insert `.registerAll(buildIcloudOperations({ sender }))` into the
registry chain right after `.registerAll(buildHandleOperations({ sender }))` (~line 462). `sender`
already exists (~line 357). Export the builder from `packages/bbd/src/index.ts` for parity.

### A4. Advertise the capability flag
- `packages/protocol/src/v1/entities.ts`: add `supports_icloud_account: boolean;` to the
  `ServerInfoV1` interface (~after line 225) — **required or bbd tsc fails.**
- `packages/bbd/src/api/operations/coreOperations.ts`: in the `server/info` handler (~after line 85)
  return **`supports_icloud_account: cfg.enablePrivateApi`** (`cfg` already read at line 76). Gating on
  `enablePrivateApi` is the honest value: these endpoints _require_ the helper, so the flag is true
  exactly when Private API is on. (Static `true` like `supports_send_contact` would lie on
  private-API-off servers.)

### A5. Server tests
Clone `packages/bbd/test/handleAvailability.test.ts` (the `FakeTransport` pattern) to assert the
request action strings (`get-account-info` / `modify-active-alias`) and the **snake→camel
normalization**. Run the bbd package typecheck + tests.

## Part B — App (`/Users/munkle/github/bluebubbles-rn`)

### B1. Capability flag → model + hook (mirror `supports_send_contact` exactly)
- `src/core/models/serverInfo.ts`: add `supports_icloud_account: z.boolean().nullish(),` inside the
  `z.object({...})` (after `supports_send_contact`, line 36). The line-45 `.transform` spreads `...s`,
  so no other change.
- `src/state/sessionStore.ts`: add hook `export const useIcloudAccountSupported = () =>
  useSessionStore((s) => !!s.serverInfo?.supports_icloud_account);` (after line 85), and (for parity)
  the non-React accessor `icloudAccountSupported` in `sessionAccessors` (after line 73).

### B2. Gate the Settings entrance — `app/(app)/settings.tsx`
`serverInfo` is already in scope (line 75). Wrap the nav row (~line 400):
```tsx
{serverInfo?.supports_icloud_account && (
  <NavRow label="iMessage Account…" onPress={() => router.push('/account')} />
)}
```
So the row only appears when the server advertises support. The surrounding SERVER section stays
(Server Management / Health remain).

### B3. Keep the graceful fallback in `account.tsx`
**Keep** the `'unsupported'` (404 → `UnimplementedEndpointError`) state as defense-in-depth: the flag
hides the _entrance_, but the screen is still reachable via a deep link (`gator://account`) or a
null/stale `serverInfo` (capability can flip across reconnects). Removing it would regress that safety.

_Optional follow-up:_ handle the **helper-off case** distinctly. When Private API is enabled but the
helper isn't connected, `get-account-info` throws → the server returns **500, not 404**, so the app
shows a generic error. If desired, map a "private API not connected" 500 to a clearer message in
`icloud.ts`/`account.tsx`. Not a blocker (gating on `enablePrivateApi` already hides the row when
Private API is off).

### B4. App tests
Add an `icloudAccountSupported` case to `test/state/sessionCapabilities.test.ts` (parse
`ServerInfo.parse({ version, supports_icloud_account: true/false })`); a hook test mirroring
`test/components/hooks/useMessageDeletedSupported.test.tsx`; optionally the wire-contract fixture
`test/fixtures/contract/v1/serverInfo.enriched.gator.json`. Run `npm run typecheck` + `npm test`.

## Critical gotchas

1. **snake_case → camelCase normalization (server-side).** The helper/upstream return
   `apple_id`/`account_name`/`active_alias`/`vetted_aliases: [{Alias}]`. The app's `AccountInfo` schema
   is camelCase (`appleId`/`displayName`/`activeAlias`/`vettedAliases: string[]`). Because the schema is
   `.loose()` + all-`.nullish()`, a raw upstream-style passthrough returns **200 but every field null**
   ("No aliases found"). **The Gator route must normalize** (A2) — do NOT rely on the app parser.
2. **Helper-off = 500, not 404.** `UnimplementedEndpointError` only remaps 404. Gating the row on
   `enablePrivateApi` (A4) avoids the common case; the residual (flag on, helper crashed) surfaces as a
   generic error in `account.tsx` — acceptable, or address via the B3 optional follow-up.
3. **Capability can flip live.** `supports_icloud_account` is null on first render and can change across
   reconnects (same caveat as `supports_message_deleted`) — the B3 fallback covers it.
4. **macOS version gating.** Upstream requires ≥ High Sierra for account-info (≥ Big Sur for the contact
   card). Replicate if old macOS is supported.
5. **Helper version.** Confirm the _injected_ helper on the target host contains `get-account-info`
   (the shipped `macos11` binary does; very old builds may predate it). `version.txt` +
   `macos10`/`macos11` variants live under `packages/server/appResources/private-api/`.

## Rollout order & verification

1. **Server first.** Ship A1–A5, deploy to the prod host (`bubbles@192.168.1.11`). Verify against a live
   injected helper: `curl {origin}/api/v1/icloud/account` returns 200 with **camelCase** fields
   populated (`strings` proves the keys exist but not that values are populated on every macOS version —
   this is on-device-only, must be checked on the Mac host).
2. **App second.** Ship B1–B4. The gate self-activates once `/server/info` advertises the flag; on older
   servers the flag is absent → false → row hidden (no regression, fallback still covers deep links).

## Effort estimate

- Server: ~1 new file + 2 methods + 3 small edits + 1 test — a few hours, low risk (mirrors existing
  patterns; no native work).
- App: 3 small edits + tests — ~1 hour, low risk.
- The only non-code unknown is verifying the live helper populates real values on the target macOS —
  a single on-device check.
