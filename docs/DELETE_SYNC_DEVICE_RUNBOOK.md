# `DELETE-SYNC-01` exact-device verification

> **Status:** PASS — completed on 2026-09-15. Both required branches passed on the exact recorded
> app/server pair; only sanitized evidence is retained below.

This checklist closes only the remaining Android runtime proof for `DELETE-SYNC-01`. It reuses the
existing v66 Google Play provenance record rather than claiming a new general Play-delivery proof,
and it must not be copied into the retired version-code-56 device matrix.
Use a synthetic conversation and keep server addresses, credentials, message text, raw GUIDs, device
serials, and unredacted logs out of Git.

## Exact test boundary

- [x] Record the committed app and server Git revisions.
- [x] Build the Android app locally from that exact app revision, or use the Play-delivered split set
      from a locally built, revision-recorded AAB. Record the artifact kind, package, version/version
      code, build variant, SHA-256, Android device model/version, and test date.
- [x] Confirm the Mac is running the exact server revision with its real Messages database service
      and a synthetic test conversation. Record only a non-secret server/fixture alias.
- [x] Confirm the app uses its normal encrypted op-sqlite/SQLCipher database and deletion sync; do
      not substitute an in-memory database or fixture-only database command.

## Killed-process catch-up

- [x] Sync one synthetic message to the Android device and record a sanitized baseline showing it
      is visible.
- [x] Stop the Android app process with `adb shell am kill <package>` or Android 16's non-force-stop
      `adb shell am stop-app <package>` equivalent and verify it is no longer running. Leave its app
      data intact. Never use `am force-stop`, because Android then blocks broadcasts until the user
      manually launches the app.
- [x] Delete that synthetic message on the Mac while the Android app remains stopped. Allow one
      normal server reconciliation cycle so the background watcher can journal the deletion.
- [x] Relaunch and reconnect the app. Confirm the message disappears through catch-up even though no
      live deletion event reached the stopped process.
- [x] Stop and relaunch once more. Confirm the message does not reappear and the retry produces no
      duplicate or stuck sync behavior.

## App-Lock catch-up

- [x] Sync a different synthetic message, enable App Lock, and let the lock become active.
- [x] Delete that message on the Mac while the app is locked, then unlock and reconnect.
- [x] Confirm the message disappears only after the authorized database session resumes, remains
      absent after another restart, and no private preview or message content appears in diagnostics.

## Evidence and closure

- [x] Record PASS/FAIL for both branches, the exact revisions/artifact identity, sanitized timestamps,
      and a private evidence reference. Do not commit raw database rows, screenshots with content,
      endpoints, tokens, or account/device identifiers.
- Failure policy: on any future failure, reopen `DELETE-SYNC-01` and record the failed step plus a
  sanitized symptom. No failure occurred in the closing run.
- [x] Mark `DELETE-SYNC-01` complete only when both branches pass on the exact recorded app/server
      pair and both repositories' remediation status/docs are updated in the same documentation
      batch.

## Sanitized PASS record — 2026-09-15

- **Source and artifact:** deletion-snapshot implementation `1fde92e` is an ancestor of reviewed app
  source `360d873` and release packaging commit `6b592755`. The physical phone ran the
  Google-Play-delivered split set for package `com.bluegreengatorapps.messages`, version `0.1.49` /
  code `66`. Its production-release AAB, `gator-release-0.1.49-v66-6b59275.aab`, was built locally
  on this Mac by the release runner and had SHA-256
  `9dfb0d3c9ea9f1e54ed32f2e6f008d57132f9e4d74cc76e5c3cb803447141570`; the installed app was
  nondebuggable. Exact AAB, installed base-APK, source, signing, and SHA-256 provenance is recorded in
  [`WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md`](./WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md#play-v66-app-lock-completion).
  The running server was the clean arm64 Gator `2.0.15` bundle whose embedded source revision is
  `eb44ec0`; its deletion/snapshot runtime files are unchanged on current server master `c75c7508`.
  The real system service exercised Apple's Messages database plus the durable deletion ledger. The
  phone was a physical Samsung `SM-S938U1` running Android 16 / API 36; its serial and account
  identifiers were deliberately not recorded.
- **Normal encrypted path:** the release app used its ordinary op-sqlite/SQLCipher database and
  production deletion-sync path. Server-side structural checks found one matching journal entry at
  the current ledger head. Apple's live chat join no longer contained the deleted row while the
  recoverable-deletion join retained it; no body, address, GUID, or row identifier was printed.
- **Stopped-process branch — PASS:** Android 16's non-force-stop `am stop-app` left app data intact
  and process absence was verified. After the Mac deletion and normal server reconciliation,
  relaunch/reconnect removed the deleted reply. The grouped notification changed only for the
  deleted contribution, and a second stop/relaunch produced neither resurrection nor a duplicate
  notification.
- **App-Lock branch — PASS:** a separate reply was deleted while Gator was locked. After the owner
  authenticated, the reply was absent. It remained absent after another complete stop/relaunch and
  biometric unlock, and the package notification count did not increase across that restart. The
  test retained no private preview, message content, raw UI tree, screenshot, endpoint, token,
  device serial, or raw GUID.
- **Cleanup and private reference:** App Lock was restored to its original disabled state, normal
  phone networking remained enabled, and no temporary credential remained. Private evidence
  reference: the local operator session transcript titled `FEATURE-08 / DELETE-SYNC-01 closure —
  2026-09-15` (not committed to Git), plus local release run
  `android-0.1.49-360d873-20260914153536`. Its retained private `build.json`, `validation.json`,
  `state.json`, and `submission.json` receipts bind local production mode, successful completion,
  package/version/source/release identity, AAB size/hash, and Internal submission without placing
  secrets in this document. The sanitized device-test window was 2026-09-15 evening MDT.
