# BACKUP-SLOTS-01 Samsung partial device proof — 2026-09-24

## Result

`BACKUP-SLOTS-01` remains **IN_PROGRESS**. The Samsung one-client exercise is green, including
direct inspection of the exact live server row. The required independent second-device revision
conflict and final delete proof remain open.

This is a development-client receipt, not exact-candidate evidence:

- Device: Samsung SM-S938U1, Android 16 / API 36.
- Native app: `0.1.51-debug`; JavaScript was served from the current dirty app worktree at
  `a49cff8e285e`.
- Live server repository: dirty worktree at `ff5ecdf418c0`.
- The app and server worktrees had unrelated concurrent changes, so this receipt does not freeze or
  identify a release candidate.

## Live checks completed

1. Created a fresh scoped client credential in the Gator desktop UI and enrolled the Samsung debug
   app without changing or uninstalling the Play app. The server recorded the new active credential
   as used.
2. Force-stopped the debug app, reconnected its Expo development client, and reopened Backup. The
   server-backup form loaded with no list/authentication error, proving secure credential persistence
   across the process restart.
3. Created the empty synthetic folder `BBSlotsMarker-20260924-A`, then saved the named server slot
   `Remediation-Samsung-20260924-A` with a newly generated test-only passphrase.
4. Confirmed the success dialog and listed the saved slot.
5. Attempted restore with a deliberately wrong passphrase. The expected fixed failure copy appeared,
   and the synthetic folder remained unchanged.
6. Deleted only the empty synthetic folder from the debug app, restored the slot with the correct
   passphrase, received the successful restore result, and verified that the folder reappeared.

## Exact live-row inspection

The read-only query selected exactly
`(kind = 'settings', name = 'Remediation-Samsung-20260924-A')` from the live Gator `backups` table.
Only booleans and lengths were emitted:

- exact row count: `1`
- SQLite storage type: text
- ciphertext prefix: `BB2.`
- ciphertext length: `421` characters
- revision: canonical 32-character lowercase hexadecimal
- synthetic plaintext folder marker absent from ciphertext
- test passphrase absent from ciphertext
- JSON plaintext keys such as `"version"` and `"customFolders"` absent from ciphertext

The raw ciphertext, revision, passphrase, server URL, credential, and account identifiers were not
recorded.

## Deliberately retained state and remaining proof

- The test slot and restored empty synthetic folder remain in place for the second-device exercise.
- The test passphrase is retained temporarily in the logged-in user's macOS Keychain under the
  service `gator-remediation-backup-slots-20260924`; it is not stored in this repository or the shell
  transcript.
- The one-time client credential was removed from the Mac clipboard, and its reveal panel was
  dismissed. Its revocable server record and the debug app's secure copy remain active so testing can
  resume.
- The Pixel is owner-excluded from development and testing and was not modified. Full closure still
  needs another explicitly approved, independently authenticated test device to refresh/list the
  slot, prove wrong/correct cross-device restore, cache the same revision, lose a stale overwrite
  race, verify the row stayed unchanged, refresh to the winner, and complete the confirmed
  delete/final-zero-row check.
- Repeat the accepted flow on the eventual exact release candidate before treating this as release
  evidence.
