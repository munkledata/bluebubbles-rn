# Find My on macOS 14.4+ (incl. 26) — Implementation Plan

*Generated 2026-06-24. Porting the approach from upstream PR
[BlueBubblesApp/bluebubbles-server#810](https://github.com/BlueBubblesApp/bluebubbles-server/pull/810)
to **our** Gator bbd server + RN app, with two chosen extensions.*

**Status (updated 2026-07-17):** RN-side devices/friends are DONE — `normalizeDevice`/`normalizeFriend`
(both Gator + upstream shapes), the `[lat, lng]` coordinate-order pin test (Phase 4 item 15), and the
`findmyStore` / `findmyApi` / `FindMyMap` UI are all implemented in this repo. Still UNBUILT: Phase 4
item 16 (the items/AirTags split in this repo — `FindMyItem` type, `normalizeItem`, a `findmyItems`
endpoint + AirTags section/store slice), and ALL server-side phases 1–3 (the bbd decryption core,
items/devices endpoints, and the Gator key-import UI — they live in the `bluebubbles-server` repo).

## Why this is needed now

This Mac is **macOS 26 (Darwin 25.5.0)** — well past **14.4**, where Apple began encrypting the
Find My caches. So our Find My is **broken right now**:

| Feature | How our bbd does it today | Why it fails on 14.4+ |
|---|---|---|
| **Devices** | `FindMyDevicesReader` reads `~/Library/Caches/com.apple.findmy.fmipcore/Items.data` as **plaintext JSON** | file is now **ChaCha20-Poly1305 encrypted** → `JSON.parse` silently returns `[]` |
| **Friends** | `FindMyService.refreshFriends` drives Find My via the **Private API** dylib (`refresh-findmy-friends`) | the Private API helper **no longer works** for Find My on 14.4+ |

(Our bbd Find My is **byte-for-byte identical to upstream's** today, so the PR ports almost verbatim.)

## The fix (PR #810, version-aware)

On **14.4+**, read + decrypt the local caches directly (no code injection, no running Find My.app);
**< 14.4 keeps the existing Private-API/plaintext paths unchanged.**

- **Devices + Items** ← `fmipcore/Items.data` (+ `Devices.data`), **ChaCha20-Poly1305** with the **FMIP** key (`@noble/ciphers`, pure JS).
- **Friend coordinates** ← `…/group.com.apple.findmy.findmylocateagent/…/LocalStorage.db`, a custom **AES-256 keystream-XOR SQLite page codec** with the **LocalStorage** key (Node `crypto` + `better-sqlite3`); join `secureLocations` × `friends`.
- **Friend names** ← `fmfcore/FriendCacheData.data`, ChaCha20 with the **FMF** key.
- **3 keys** (`LocalStorage.key`, `FMIPDataManager.bplist`, `FMFDataManager.bplist`) imported once via the external [findmy-key-extractor](https://github.com/manonstreet/findmy-key-extractor); stable across reboots.

## Decisions taken
- **Key onboarding:** build a **Gator UI "Find My Keys" card** (import + validate), mirroring the PR — not just manual file-drop.
- **Scope:** **restore parity + split items/devices.** Today `Items.data` (AirTags/items) is mislabeled as "devices." We'll serve **real Apple devices** (`Devices.data`) on `/findmy/devices` and add a **new items/AirTags entity** (`Items.data`) on a new endpoint. This is safe to change because nothing works today on 26, so there's no live shape to break.

---

## Phase 1 — bbd decryption core (`BB/bluebubbles-server/packages/bbd/src/findmy/`)

Port the PR's crypto near-verbatim (it's plain Node/JS):

1. **Deps** → `@noble/ciphers` + `bplist-parser` (both pure JS; bundle into `daemon-entry.cjs` via esbuild — no native linking, no Gator rebuild). `better-sqlite3` already ships in the daemon (chat.db).
2. **`decrypt/cache.ts`** — ChaCha20-Poly1305 decrypt of `.data` caches: unwrap the bplist, `[12B nonce][ciphertext][16B tag]`, decrypt, parse inner bplist/JSON, normalize Apple's `"$null"` → `null`.
3. **`decrypt/localStorage.ts`** — per-4096B-page AES-256-CBC keystream-XOR (iv = `LE32(pgno) ‖ 12B page-tail`), WAL replay, page-0 SQLite-header validation (= key check).
4. **`decrypt/localStorageReader.ts`** — decrypt `LocalStorage.db` → **temp file (`0600`, deleted in `finally`)** → `better-sqlite3` (readonly) → join `secureLocations` (coords) × `friends` (handle). Plaintext coords must never linger.
5. **`decrypt/fmfReader.ts`** — friend display names from `FriendCacheData.data`.
6. **`decrypt/plistUtils.ts`** — bplist parse + extract the 32-byte symmetric key from `*.bplist`.
7. **`FindMyKeyManager.ts`** — load/validate/cache the 3 keys from a keys dir; status + import API.
8. **`macosVersion.ts`** — `isMinSonoma14_4` (parse `sw_vers`/`os.release()`).
9. **Make readers version-aware:**
   - `FindMyDevicesReader`: ≥14.4 → decrypt then map; <14.4 → current plaintext path.
   - `FindMyService`: ≥14.4 → assemble friends from `LocalStorage.db` (coords) + FMF (names); <14.4 → current Private-API path.
   - **Keep the existing friend wire shape** (`handle`, `coordinates:[lat,lng]|null`, `longAddress`, `shortAddress`, `lastUpdated`) so the app is unaffected (the app already normalizes it).

**Keys dir:** `…/Application Support/bluebubbles-server/FindMyKeys/` (Gator's config dir), `0700`.

## Phase 2 — Items/devices split (our extension)

10. Decrypt **both** `Items.data` (items/AirTags) and `Devices.data` (Apple devices).
11. `/api/v1/findmy/devices` → **`Devices.data`** (real devices: name, deviceModel, batteryLevel, location).
12. **New** `/api/v1/findmy/items` → **`Items.data`** (AirTags: name, serial/owner if present, location, separated-status), behind a new `FindMyItemsReader`.
13. Endpoint envelope stays `{ devices: [...] }` / `{ items: [...] }` (named-key list wrappers the app unwraps).

## Phase 3 — Gator key-import UI (`BB/bluebubbles-server/packages/ui`)

14. "Find My Decryption Keys" settings card (shown on 14.4+): folder picker → import + validate the 3 files → status (present/valid per key). Mirror the PR's `FindMyKeysField` + IPC (`get-findmy-keys-status`, `import-findmy-keys`).

## Phase 4 — App (`bluebubbles-rn`)

The app is a pure HTTP client and **already** normalizes devices + friends in both our and upstream shapes; the PR keeps those shapes unchanged → **devices + friends need no change** (just a regression test).

15. **Verify-only:** keep the device coordinate-order assumption `[lat, lng]` ([normalize.ts:29-30](../src/core/findmy/normalize.ts#L29-L30)) — our decrypted reader preserves it; add a test that pins it.
16. **New items entity (from Phase 2):** `FindMyItem` type + `normalizeItem` + a `findmyItems` endpoint + an "Items"/AirTags section on the Find My screen + store slice. (This is the only real app work, and only because we chose the split.)

## Key onboarding (one-time, by the user)
Run [findmy-key-extractor](https://github.com/manonstreet/findmy-key-extractor) once → produces
`LocalStorage.key`, `FMIPDataManager.bplist`, `FMFDataManager.bplist` → import via the Gator card
(Phase 3). Keys are derived from the iCloud account and **stable across reboots** — one-time setup.

## Deployment / risk notes
- bbd is esbuild-bundled; `@noble/ciphers` + `bplist-parser` are pure JS → they bundle into
  `daemon-entry.cjs`. Deploy = rebuild bbd → copy into Gator.app → **re-sign (ad-hoc) → re-grant FDA**
  (the same dance as the decode/perf fixes; FDA is required to read the caches).
- **Security:** the decrypted `LocalStorage.db` holds real coordinates — always temp-file `0600` +
  delete in `finally`. Never log coordinates. Keys dir `0700`.
- **Robustness:** keep the best-effort posture (missing key / wrong key / absent cache → `[]`), but
  **add debug logging** (today failures are silent — which is partly why "broken" wasn't obvious).
- **macOS gate:** exact `14.4` boundary; verify the detection on 26 (Darwin 25).

## Testing
- Unit-test `cache.ts` (ChaCha20) and `localStorage.ts` (AES page codec) — ideally against this Mac's
  real caches once keys are extracted; otherwise with captured fixtures.
- App: a normalize test pinning device `[lat,lng]` order + the new `normalizeItem`.
- End-to-end: requires the user to extract keys first (the gating prerequisite).

## Open follow-ups
- Confirm `Devices.data` vs `Items.data` decrypted JSON field differences (deviceModel/battery vs
  serial/owner/separated) — drives the items mapping + the app's `FindMyItem` shape.
- Decide whether friends should auto-refresh on a timer (today: only on POST refresh).
- The PR's unrelated "LAN URL multi-IP picker" is **out of scope** — skipped.
