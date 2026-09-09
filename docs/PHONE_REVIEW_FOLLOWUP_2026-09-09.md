# Phone follow-up to the architecture and adversarial reviews

Date: 2026-09-09. The [plain-English review summary](./ADVERSARIAL_COMPLEXITY_REVIEW_2026-09-09.md)
is saved at the beginning of the adversarial review.

**The reviews were not an exhaustive phone test.** Earlier review results came from source inspection,
host tests, and controlled experiments. This follow-up records fresh physical-device testing and its
limits; it does not mark the retired release-candidate checklist complete.

## Tested environment

- Connected physical Galaxy S25 Ultra, Android 16 / API 36, arm64.
- Installed Gator: development build `0.1.42`, version code `1`, debuggable.
- Installed base APK SHA-256:
  `97049e01d2f65af1cb5577c9fcef4d9071b231f608a908626231eaaffa5275c6`.
- This differs from the older local `android/app/build/outputs/apk/debug/app-debug.apk`
  (`0.1.41`). No APK was installed or replaced during this follow-up.
- Metro on port 8081 serves this repository. JavaScript is development code from the moving working
  tree; the installed native APK is not a frozen, signed release candidate. Version numbers alone do
  not establish that every native patch in current source is installed.
- During interactive checks, another session committed `146f701` and began new migration/repository
  edits. Its reloads reset the fixture session, followed by a compile error for missing
  `src/db/repositories/attachmentMediaExports`. Screen observations affected by these reloads are
  inconclusive. The follow-up switched to a temporary, unmodified checkout of `146f701` with its own
  dependency copy and Metro on port 8082 for reproducible screen checks.
- The app initially displayed Welcome, with the development fixture button. No real messaging account
  was connected for these checks.

## Fresh verification

The existing DB harnesses use named disposable databases and fixed request markers; they do not
target `gator.db`. Their foreground restart and forced-interruption tests do not prove killed-app
Firebase push delivery.

- Harness validation on the Mac: **65 tests passed, 0 failed, 0 skipped**.
- Android cryptography boot check: `ok: true`, `round-trip + tamper-reject OK`.
- **All six physical-device harnesses passed: 158/158 retained checks true, 0 false.** The total
  includes the harness's process/cleanup checks; it is not a count of independent user journeys.

| Group                                                              | Checks true | Artifact under `android/app/build/reports/`                                                 |
| ------------------------------------------------------------------ | ----------: | ------------------------------------------------------------------------------------------- |
| Encrypted DB, wrong key, rekey, migrations, search, reactive reads |       28/28 | `db-contract/android-db-contract-2026-09-09T13-43-38-208Z.json`                             |
| Process restart                                                    |       22/22 | `db-relaunch/android-db-relaunch-2026-09-09T13-44-04-795Z.json`                             |
| Process death during an active write                               |       26/26 | `db-wal-write-death/android-db-wal-write-death-2026-09-09T13-44-39-619Z.json`               |
| Process death during an active migration                           |       32/32 | `db-active-migration-death/android-db-active-migration-death-2026-09-09T13-45-25-575Z.json` |
| Concurrent runtime database work                                   |       25/25 | `db-runtime-concurrency/android-db-runtime-concurrency-2026-09-09T13-46-02-222Z.json`       |
| Native backup/restore, rollback, retry, limits, cleanup            |       25/25 | `backup-restore/android-backup-restore-2026-09-09T13-46-33-624Z.json`                       |

The five migration-bearing artifacts report all 47 migrations through
`0047_message_retraction_topology`. The active-write test intentionally has no migration-head field.
Prior phone results from other sessions also exist; they were inspected but are not counted as new
tests performed in this follow-up.

Android's installed-package resolver returned `No activities found` for package-scoped public
`ACTION_SEND` with `text/plain`, and `ACTION_SEND_MULTIPLE` with `image/jpeg`. That confirms the two
tested public intake declarations are absent without sending a sharing intent.

## Boundaries of this evidence

The device checks do not cover a matching staged messaging server, live iMessage/RCS delivery, real
Firebase delivery while killed or locked, signed upgrades, actual power loss, or every file provider,
redirect, timeout, and cancellation case. Development sample messages do not prove transport delivery.
App Lock is a presentation policy; these disposable encryption checks do not establish key custody
while the phone or app is locked.

Only summary results and privacy-safe harness artifacts are referenced here. Screenshots remain in
temporary local storage; phone serials, personal messages, credentials, and server addresses are not
included in this report. The master work plan remains authoritative for project task status.
