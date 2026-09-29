# DB-03 Samsung current-source refresh — 2026-09-29

## Scope

This record covers the six disposable Android database lanes run from committed local `master`
`b1bd04404327bb061c93c5ce73eb9fbdfab4a6ac` on a Samsung SM-S938U1 running Android 16/API 36,
arm64-v8a. It is current-source DEV evidence, not signed Google Play candidate evidence.

The clean-prebuilt debuggable APK reported version `0.1.51` / code `1`, was 164,274,521 bytes, and
had SHA-256 `9e354787363b7ca3a6dfb7511e21e0783380cc58e1052f5faf897ab8cfa5f5be`. Gradle completed
successfully with 934 tasks. Android confirmed the installed package was debuggable before any lane
ran. Metro served the exact frozen checkout, and every lane used only its fixed disposable database
and privacy-safe finite marker.

## Results

| Lane | Device/host result | Retained local report | Report SHA-256 |
| --- | --- | --- | --- |
| DB contract | 28/28 | `db-contract/android-db-contract-2026-09-29T06-21-16-715Z.json` | `78e0c2ea08f955b2be89e7debc346b58c1cd5a10b79c4dce97819a2d42ca98ed` |
| Process relaunch | 7/7 READY + 12/12 final + 3/3 host | `db-relaunch/android-db-relaunch-2026-09-29T06-21-33-756Z.json` | `01fd6bb56cd027bb4f367a0f7c1a992a9b0893b99d231565300e144ccae1fb24` |
| Active WAL write death | 9/9 READY + 12/12 final + 5/5 host | `db-wal-write-death/android-db-wal-write-death-2026-09-29T06-21-50-658Z.json` | `8e7d0e9a668ef661ac29dae902b1cf1f8617dedb44d0b0d6a17838b228d861de` |
| Active migration death | 11/11 READY + 15/15 final + 6/6 host | `db-active-migration-death/android-db-active-migration-death-2026-09-29T06-22-09-410Z.json` | `b77d29f8a9b6bd8362922a16abd7fd224fcff17c557c4d88eb29c5fbe79eb524` |
| Runtime concurrency | 22/22 device + 3/3 host | `db-runtime-concurrency/android-db-runtime-concurrency-2026-09-29T06-22-25-801Z.json` | `84ea9f60246472e902ee5efa1dc9a472de3ef4575c11cabccc82b125f098f613` |
| Backup/restore abort | 22/22 device + 3/3 host | `backup-restore/android-backup-restore-2026-09-29T06-22-43-828Z.json` | `2f381a56e7ec0ad039249c83d4d228c9881f6a24efc76ef25b6bf95d75eeea77` |

All **158/158** retained booleans were true. The ordinary contract launch also emitted the native
crypto self-test marker with `ok: true` and `round-trip + tamper-reject OK`. The contract command
first passed 13/13 host protocol tests; each of the other five commands first passed the shared
52/52 host protocol suite.

One setup-only attempt stopped before device execution with `adb-unavailable: spawnSync adb ENOENT`
because Android platform-tools was missing from that shell's narrowed `PATH`. Adding the installed
platform-tools directory fixed the host setup; the successful rerun above is the only retained DB
contract artifact.

## What this proves and does not prove

This refresh proves the current 52-migration registry through head
`0052_chat_history_deletion_boundary` on physical op-sqlite/SQLCipher, plus the controlled relaunch,
WAL-death, post-statement migration-death, runtime-concurrency, and backup/restore-abort contracts.
It refreshes already-completed `DB-02C` and `BACKUP-02` evidence and materially advances `DB-03`.

`DB-03` remains open. This DEV run does not prove recurring scheduled-CI stability, uncontrolled OS
or power loss, torn writes, interruption while a migration statement itself is executing, the
production database, historical signed/store upgrades, or the exact signed release candidate.
