# `DELETE-SYNC-01` exact-device verification

> **Status:** OPEN. No device result is recorded here yet.

This checklist closes only the remaining Android runtime proof for `DELETE-SYNC-01`. It does not
prove Google Play delivery and must not be copied into the retired version-code-56 device matrix.
Use a synthetic conversation and keep server addresses, credentials, message text, raw GUIDs, device
serials, and unredacted logs out of Git.

## Exact test boundary

- [ ] Record the committed app and server Git revisions.
- [ ] Build the Android app locally from that exact app revision. Record the artifact kind, package,
      version/version code, build variant, SHA-256, Android device model/version, and test date.
- [ ] Confirm the Mac is running the exact server revision with its real Messages database service
      and a synthetic test conversation. Record only a non-secret server/fixture alias.
- [ ] Confirm the app uses its normal encrypted op-sqlite/SQLCipher database and deletion sync; do
      not substitute an in-memory database or fixture-only database command.

## Killed-process catch-up

- [ ] Sync one synthetic message to the Android device and record a sanitized baseline showing it
      is visible.
- [ ] Stop the Android app process with `adb shell am kill <package>` and verify it is no longer
      running. Leave its app data intact. Never use `am force-stop`, because Android then blocks
      broadcasts until the user manually launches the app.
- [ ] Delete that synthetic message on the Mac while the Android app remains stopped. Allow one
      normal server reconciliation cycle so the background watcher can journal the deletion.
- [ ] Relaunch and reconnect the app. Confirm the message disappears through catch-up even though no
      live deletion event reached the stopped process.
- [ ] Kill and relaunch once more. Confirm the message does not reappear and the retry produces no
      duplicate or stuck sync behavior.

## App-Lock catch-up

- [ ] Sync a different synthetic message, enable App Lock, and let the lock become active.
- [ ] Delete that message on the Mac while the app is locked, then unlock and reconnect.
- [ ] Confirm the message disappears only after the authorized database session resumes, remains
      absent after another restart, and no private preview or message content appears in diagnostics.

## Evidence and closure

- [ ] Record PASS/FAIL for both branches, the exact revisions/artifact identity, sanitized timestamps,
      and a private evidence reference. Do not commit raw database rows, screenshots with content,
      endpoints, tokens, or account/device identifiers.
- [ ] On any failure, leave `DELETE-SYNC-01` open and record the failed step plus a sanitized symptom.
- [ ] Mark `DELETE-SYNC-01` complete only when both branches pass on the exact recorded app/server
      pair and the remediation-plan status/docs are updated in the same evidence commit.
