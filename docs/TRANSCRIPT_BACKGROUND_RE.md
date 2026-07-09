# iMessage Transcript Backgrounds (iOS/macOS 26) — Reverse-Engineering Runbook

Goal: replicate Apple's iOS/macOS 26 "Backgrounds" feature (a chat wallpaper that syncs to all
iMessage participants) in Gator. This doc records what was proven on a real Tahoe box
so the build (and future OS bumps) don't have to rediscover it.

**Environment proven on:** macOS **26.5.2 (25F84)**, **arm64**, Messages **26.0**. Feature is
26-only. SIP was ENABLED on the RE box — receive needs no SIP-off; send (helper injection) does.
Feature gates: `IMChat -_supportsTranscriptBackgrounds`, `IMFeatureFlags -isTranscriptBackgroundsEnabled`,
`+[IMDeviceUtilities supportsTranscriptBackgrounds]`.

## Verdict
- **RECEIVE (show a background a participant set): PROVEN, easy, no crypto / no network / no injection.**
- **SEND (push a background that syncs out): reachable and buildable** — the send selector is on
  `IMChat` (IMCore), which the helper already drives; remaining work is authoring the poster + details.

---

## Data model (ground truth)

A background change arrives as a **message row**: `item_type = 3`, **`group_action_type = 4`**.
(NB: `gat=3` is a GROUP PHOTO; `gat=0` legacy group photo; group NAME is `item_type=2`. The bg row
has NO `message_attachment_join` — the image is delivered out-of-band via MMCS, not as an attachment.)
Confirmed by GUID match: the gat=4 row's `guid` == the chat's `backgroundChannelGUID` == `trabaid`.

The config lives in the **`chat.properties`** BLOB (NSKeyedArchiver / binary plist). Keys:
- `backgroundChannelGUID` — the background's channel/asset GUID (presence ⇒ chat has a background).
- `backgroundProperties` dict (the `traba*` = **TRA**nscript **BA**ckground fields):
  - `trabar` — iCloud **MMCS URL** for the full asset (the normal E2E attachment CDN, NOT CloudKit sync)
  - `trabak` — asset AES key: 1 tag byte + **32-byte AES-256 key** (base64)
  - `trabas` — signature, `traboid` — MMCS object id, `trabafs` — size, `trabapv`/`trabav` — versions
  - `refreshDate`, `trabaCommSafety`

## RECEIVE pipeline (proven end-to-end)

1. **Detect:** a chat has a background iff `chat.properties` contains `backgroundChannelGUID`. The
   `item_type=3, gat=4` message row (already flows through the server's chat.db poll as `new-message`)
   is the change trigger; use `backgroundChannelGUID` as the version key (refetch when it changes).
2. **Get the image (local, no key):**
   `~/Library/Messages/TranscriptBackgroundCache/<backgroundChannelGUID>` is a plain **AppleArchive**
   (magic `AA01`, not encrypted `AEA1`). Extract with the system tool:
   `/usr/bin/aa extract -i <file> -d <dir>` →
   `configuration/versions/0/contents/<uuid>/output.layerStack/portrait-layer_background.HEIC`
   (e.g. 948×2048) + `ConfigurationModel.plist` (the PosterKit config). Transcode for RN:
   `sips -s format jpeg <heic> --out bg.jpg`.
   - Native alternative (inside injected helper): `-[IMChat transcriptBackgroundPath]` /
     `+[IMDChatRecord transcriptBackgroundFileURLFromProperties:]` return the local file URL directly.
   - **Fallback** when the cache isn't populated yet: download `trabar`, AES-256-decrypt with `trabak`
     (drop the 1 tag byte), verify `trabas` — same MMCS path Gator already uses for attachments.
3. **Serve + render:** server exposes the JPEG + a server-owned `backgroundChannelGuid` on ChatV1;
   RN stores a NEW `synced_background_uri` column (do NOT reuse device-local `background_uri` — it's
   deliberately excluded from the upsert conflict set) and renders via the existing
   `chat/[guid].tsx` absoluteFill Image (resolve effective = local `background_uri` ?? synced).

## SEND selectors (macOS 26.5.2, discovered via runtime ObjC introspection)

`IMChat` (IMCore — the class the helper already drives via `_setDisplayName:` / `sendGroupPhotoUpdate:`):
```
-[IMChat setTranscriptBackgroundAndSendToChat:transferID:]   v32@0:8@16@24   // (id details, id transferID)
-[IMChat setTranscriptBackgroundDetails:]                     v24@0:8@16
-[IMChat transcriptBackgroundDetails / transcriptBackgroundGUID / transcriptBackgroundChannelTransferGUID
        / transcriptBackgroundPath / transcriptBackgroundVersion / transcriptBackgroundCommSafetyState]
-[IMChat refetchLocalTranscriptBackgroundAssetIfNecessary] / retryTranscriptBackgroundUploadIfNecessary
```
`IMChatRegistry`: `-_chat:setTranscriptBackgroundAndSendToChat:transferID:`,
`-_updateTranscriptBackgroundForChat:shouldPostNotification:`, `-transcriptBackgroundUpdatedForChatIdentifier:style:account:userInfo:`.
Daemon session (lower level): `-[IMDServiceSession setTranscriptBackground:andSendToChatIdentifier:chatStyle:transferID:isRefresh:]`.
Command authoring: `+[IMAttachmentBlastdoor generateTranscriptBackgroundCommandFrom:senderContext:completion:]`
and `generateTranscriptBackground:senderContext:completion:`.
Inbound/apply (for reference): `IMDChat -updateTranscriptBackgroundProperties:` / `-_applyTranscriptBackgroundChangesUsingSyncData:`
/ `-broadcastTranscriptBackgroundChanges`; BlastDoor `defuseTranscriptBackgroundCommand:`.
Pipeline classes: `IMTranscriptBackgroundCommandPipelineParameter`, `IMBlastDoorTranscriptBackgroundCommand{,TypeWrapper}`.
(`IMGroupActionItem` has NO background methods — background is its own command, not a group-action item.)

**Reachability:** `IMChat` lives in IMCore, linked by imagent/MobileSMS where the helper injects, so
`[chat setTranscriptBackgroundAndSendToChat:details transferID:guid]` is directly callable — same
process/pattern as the working `sendGroupPhotoUpdate:`. The old "send API is UI-process-only" fear is refuted.

### Send open items
- The `details` object shape passed to `setTranscriptBackgroundAndSendToChat:` / `setTranscriptBackgroundDetails:`
  (likely a dict mirroring `backgroundProperties`/`transcriptBackgroundDetails` — capture it live by
  swizzling/lldb-logging the selector while setting a background in Messages.app).
- Whether you must call `+[IMAttachmentBlastdoor generateTranscriptBackgroundCommandFrom:…]` to mint the
  command + `transferID`, or just stage a file transfer (like group photo) and pass the details.
- Authoring the **poster** the receiver accepts: build an AppleArchive of the PosterKit config
  (`manifest.plist`: `extensionIdentifier=com.apple.PhotosUIPrivate.PhotosPosterProvider`,
  `role=PRPosterRoleBackdrop`; `ConfigurationModel.plist`: NSKeyedArchiver of `PFPosterMedia`(assetUUID,
  mediaType=1 photo) + layoutConfiguration). We have a real extracted reference to clone. Start with a
  single-photo poster; gradient/dynamic posters later.
- Messages.app may need to be running to complete the poster upload (`retryTranscriptBackgroundUpload…`).

## Build plan
- **bbd (server, runs on Tahoe host):** module to read `chat.properties` → `backgroundChannelGUID`,
  `aa extract` → transcode → cache/serve; `GET /chat/:guid/background`; additive `backgroundChannelGuid`
  on `ChatV1` + `serializeChat`. Detection rides the existing `new-message` (itemType=3/gat=4).
- **RN:** migration `synced_background_uri` (+ `synced_background_channel` version) on chats;
  schema.ts + zod + upsertChats (value+conflict set); on serialized `backgroundChannelGuid` change,
  fetch `GET /chat/:guid/background` → persist → write column; `ChatThemeProvider` resolve local??synced.
- **helper (bluebubbles-helper, for SEND):** add `update-transcript-background` action cloning the
  `update-group-photo` handler (`prepareFileTransferForAttachment:` → `getIMChatFromGuid:` →
  respondsToSelector-gated `setTranscriptBackgroundAndSendToChat:transferID:` / `setTranscriptBackgroundDetails:`,
  @try-wrapped). Rebuild dylib → server `appResources/private-api/macos11/`. Register selectors in
  `tools/imcore-diff/manifest.json`. Needs SIP-off host + Messages.app running to test live.

## Implementation status (2026-07-01)
- **RECEIVE — code-complete, unit-verified, not yet run live.**
  - Server (bbd): `data/imessage/transcriptBackground.ts` (extract + `aa`/`sips` transcode),
    `api/chatBackgroundRoutes.ts` (`GET /api/v1/chat/:guid/background`, ETag=channelGuid),
    `ChatReader` reads `properties` + `getPropertiesBlob`, `serializeChat` emits `backgroundChannelGuid`,
    `ChatV1` field, mounted in `backend.ts`. tsc clean; 298 tests pass (incl. new
    `test/transcriptBackground.test.ts`); `resolveBackgroundJpeg` verified producing a real JPEG.
  - RN: migration `0013_synced_background` (`synced_background_channel` + `synced_background_uri`),
    schema + `Chat` model `backgroundChannelGuid`, `upsertChats` tracks the server channel (server-owned),
    `getSyncedBackgroundState`/`setSyncedBackgroundUri`, `services/backgrounds/syncedBackground.ts`
    (`ensureSyncedBackground`, authed `File.createDownloadTask`), `ChatThemeProvider` resolves
    local `background_uri` ?? `synced_background_uri`, called from the chat-screen open effect.
    tsc + lint clean; 536 tests pass.
  - **Left:** live end-to-end — run the patched bbd on the Tahoe host + point the app at it.
- **SEND — selectors mapped; poster authoring PROVEN; helper/live-test pending (SIP-gated).**
  - Poster authoring works with no SIP: copy the extracted PosterKit reference tree, swap
    `output.layerStack/portrait-layer_background.HEIC` for the chosen image, then
    `/usr/bin/aa archive -d <tree> -a none -o <out>` produces a **byte-format-matching `AA01`**
    AppleArchive (verified: header `AA01 … TYP1DPATP`, round-trips through `aa extract` with the
    swapped backdrop + intact `manifest.plist`/`ConfigurationModel.plist`). `-a none` is required —
    the default emits a compressed `pbze` stream; Messages' cache is raw `AA01`.
  - Still open (need SIP off to attach lldb to Messages, or build into the helper + test): the exact
    `details` object + whether `transferID` references the poster archive or the raw HEIC (capture
    live from `-[IMChat setTranscriptBackgroundAndSendToChat:transferID:]` /
    `+[IMAttachmentBlastdoor generateTranscriptBackgroundCommandFrom:senderContext:completion:]`),
    the helper handler (clone `update-group-photo`), and a live send to a 2nd 26 device (different Apple ID).
- **RECEIVE server also proven LIVE over HTTP** (Fastify `inject` against the real chat.db):
  authed → `200 image/jpeg` 165 415 B (JPEG magic, ETag=channelGuid); unauth → 404 (no oracle);
  matching `If-None-Match` → 304; bogus guid → 404.

## Tooling
- Discovery without ipsw: **runtime ObjC introspection** — `scratchpad/bg-re/dump-bg.m` dlopens
  IMCore/IMDaemonCore/etc. and scans `objc_copyClassList` for `transcriptBackground*` selectors +
  type encodings. Re-run after OS updates to catch renames (complements `tools/imcore-diff/check.m`).
- `aa`/`aea`/`yaa` (Apple Archive) and `sips` (HEIC transcode) ship with macOS.
