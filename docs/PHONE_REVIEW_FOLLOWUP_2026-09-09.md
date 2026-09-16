# Phone follow-up to the architecture and adversarial reviews

Date: 2026-09-09. The [plain-English review summary](./ADVERSARIAL_COMPLEXITY_REVIEW_2026-09-09.md)
is saved at the beginning of the adversarial review.

**The reviews were not an exhaustive phone test.** Earlier review results came from source inspection,
host tests, and controlled experiments. This follow-up records fresh physical-device testing and its
limits; it does not mark the retired release-candidate checklist complete.

## Tested environment — initial development-build phase

- Connected physical Galaxy S25 Ultra, Android 16 / API 36, arm64.
- Installed Gator: development build `0.1.42`, version code `1`, debuggable.
- Installed base APK SHA-256:
  `97049e01d2f65af1cb5577c9fcef4d9071b231f608a908626231eaaffa5275c6`.
- This differs from the older local `android/app/build/outputs/apk/debug/app-debug.apk`
  (`0.1.41`). No APK was installed or replaced during this initial phase.
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

## Interactive checks on fixed commit `146f701`

These used the built-in local fixture session, not a paired messaging server. The fixture shortcut
adds sample conversations to the development app's normal database. One clearly named synthetic
outgoing message was simulated locally; no message was sent to another person.

| Check                                                   | Observed result                                                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome → Connect → manual entry                        | Screens opened; empty Connect was disabled; password text was masked.                                                                                                                              |
| HTTP address without consent, including keyboard submit | Connect remained disabled. Keyboard submit displayed the explicit insecure-connection error and retained the form. No security bypass was observed.                                                |
| Seed sample inbox and open a pinned chat                | Sample rows rendered and the selected chat opened.                                                                                                                                                 |
| Composer with Samsung keyboard visible                  | Input and Send stayed above the keyboard at the original font setting.                                                                                                                             |
| Local simulated send                                    | The sample bubble appeared with the simulated Delivered state; the composer cleared. This is not server-delivery evidence.                                                                         |
| Background → foreground                                 | The sample chat and message remained visible after returning. The fixture later showed Offline/socket warnings because no real server was connected.                                               |
| Chat details and Settings                               | Both screens opened and their controls rendered.                                                                                                                                                   |
| Secure Screen                                           | Switch changed false → true; ADB screenshot showed a black app area. Restoring false restored visible app content. Original setting restored. Screen recording was not separately tested.          |
| Android document picker: ordinary file                  | A 22-byte synthetic JSON document loaded into the restore field through the native reader.                                                                                                         |
| Android document picker: oversized file                 | A 7 MiB file was refused with `Couldn’t open the backup file.` This provider reports its size, so this alone does not prove the hidden/misreported-size limit.                                     |
| Android document picker: malformed text                 | A four-byte invalid UTF-8 file was refused with the same safe error.                                                                                                                               |
| Invalid backup restore                                  | The synthetic JSON was refused with `Couldn’t restore — check your passphrase and that the backup is valid.` No successful restore was performed against the app database.                         |
| Picker cancellation                                     | Returning out of the picker preserved the previously loaded text and re-enabled Choose a backup file.                                                                                              |
| Optional permissions                                    | Continued to Messages without enabling notifications or contact access.                                                                                                                            |
| Font scaling                                            | Temporarily tested Android font scale 2.0. Sample message bubbles expanded and wrapped; the inbox still opened the pinned chat. Header/overlay concerns below remain. Original scale 0.8 restored. |

### Issues and qualifications observed

1. **Accessibility follow-up:** the manual-entry insecure-connection switch exposed an empty Android
   `text` and `content-desc`, with `NAF="true"`, while its neighboring explanatory text was separate.
   This was observed in the first interactive pass; the same `aria-label` implementation is present
   in fixed commit `146f701`, at `app/(setup)/manual.tsx`. The Settings privacy switches did expose
   meaningful native labels. Use an explicit React Native accessibility label and verify spoken
   navigation with TalkBack before closing this concern. TalkBack itself was not enabled here.
2. **Development test UI obstructs product UI:** the development action bar covers the inbox search
   field even at scale 0.8 and covers much more content at scale 2.0. The floating Expo Tools button
   also overlaps top-right controls. These are development controls, so this is not proof of a
   release-build defect; it reduces how much normal interaction can be proved using this build.
3. **Offline presentation needs layout review:** the app's Offline/Retry banner overlays screen titles,
   including Settings, and obscures part of the large-font chat header. This is separate from the
   Expo Tools overlay. Message bubbles themselves wrapped correctly in the sampled large-font chat.
4. **Withdrawn navigation suspicion:** the initial return to Welcome during manual submission/chat
   navigation coincided with repeated JS reloads from other-session edits. It did not reproduce in
   the fixed snapshot. It must not be recorded as a confirmed navigation or credential-policy bug.

An initial oversized-file folder appeared empty until Android indexed the newly pushed fixtures;
after indexing, all three appeared. One scripted tap initially matched the header's `iMessage`
label instead of the composer; the selector was corrected to prefer the native text-input control.
Those were test setup/driver issues, not app findings. No application source was changed to obtain
the results above.

## Nondebuggable release Firebase follow-up

A local `assembleRelease` APK from app commit
`1f4c77c648a7b80ad3c5e7dd21a99a0899d6db67` (`0.1.42`, version code `1`, SHA-256
`572f7c05232812a70020cabdab1dafd4a25b3274efda3163bb7a71db2f4a6de2`) was installed in place with
`adb install -r`. Android reported install success, the app was nondebuggable, and pairing plus
notification permission survived. The APK uses the local development signing certificate, so it is
a release-variant validation build rather than a production-signed or Play candidate.

| App state        | Server result                               | Physical observation                                                                                    |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Foreground       | `{configured:true,total:1,sent:1,failed:0}` | The existing app process remained foreground.                                                           |
| Alive background | `{configured:true,total:1,sent:1,failed:0}` | The existing process remained alive while Android Home was foreground.                                  |
| Killed           | `{configured:true,total:1,sent:1,failed:0}` | After `am kill`, the old process was absent; Firebase started a new process and posted the test notice. |

The killed case used no force-stop. Android showed the fixed app-authored title/body `Gator` /
`Test notification received.` The exact live registration's vaulted envelope authenticated and
parsed as `AEAD_GCM_V3_IDENTITY`; the same production lookup/parser succeeded after a normal server
restart. Together these results prove use of the retained SecureStore key after an in-place update
and process death, plus server-side V3 key persistence across restart. They do not prove fresh
release-build key generation/enrollment because `install -r` retained prior app state. Enrollment
used a USB-reversed HTTP connection, so this run does not establish network confidentiality for the
enrollment key.

The running `/Applications/Gator.app` exactly matched the retained local
`packages/server/releases/mac-arm64/Gator.app`: each bundle contained 469 files, 405 directories, and
14 symlinks with canonical logical SHA-256
`ebe9808586e8fded512467977f591c8e9ada41f9bfeac8315ba25a263e560c3c`. The running `app.asar` SHA-256
was `43384972b2b774988bb092f765545d09bb0f756c2b0f689f415cd6f6163ebaac`, and the external server
daemon SHA-256 was `5a71d5ee47ef250854c7e2144afcf2e57e73f2877c24983681553916c24b6fdb`. The sealed
bundle records version `2.0.15`, commit `e55f12106b9844b4c56d55c8ed233b77fa6ea4c1`, Node `24.19.0`,
Electron `42.10.1`, and `sourceDirty:true`. This identifies the exact server bytes used in the phone
run, but not the uncommitted source patch that produced them.

## Boundaries of this evidence

The later checks cover real Firebase foreground, alive-background, and killed delivery for this local
install and bind the running server to an exact retained binary snapshot. They do not bind that dirty
binary to an exact frozen source snapshot or cover live
iMessage/RCS delivery, Firebase admission while locked, a production-signed upgrade, actual power
loss, or every file provider, redirect, timeout, and cancellation case. Development sample messages
do not prove transport delivery. App Lock is a presentation policy; these checks do not establish key
custody while the phone or app is locked.

Remaining work includes biometric App Lock/Recents behavior, real account replacement and unavailable-
server credential retirement, live messages and attachments, fresh release-build push-key enrollment,
exact replay after app restart, locked admission/unlock drain, physical cross-account/device rejection,
rotation/overlap/revocation, same-candidate downgrade rejection, native upload redirects, hostile or
stalling document providers, download cancellation/process death, large data sets, and supported-device
coverage. Those need a fixed matching app/server build and a disposable test account; some also need
human biometric interaction or purpose-built hostile-provider fixtures. This local release variant
cannot stand in for a production-signed candidate.

Recommended next step: run the remaining user journeys against one frozen candidate and a synthetic
test account, so failures can be reproduced without involving personal conversations.

## Cleanup and retained evidence

During the initial development-fixture phase, the original font scale and Secure Screen setting were
restored. The three disposable picker files and their folder were removed. The phone was returned to
Android Home, and the development app was background-killed with `am kill`. The temporary Metro
server, its port-8082 ADB mapping, and the temporary checkout/dependency copy were removed; the
pre-existing port mappings remain.

The built-in sample conversations, one local simulated message, and the optional-permissions onboarding
choice remained in the development app during that phase. No account disconnect, data wipe, successful
production-database restore, real message send, or release operation was performed. The later local
nondebuggable release variant was installed and paired, the phone was returned to Gator Settings, and
the normal packaged Gator server was restored at the end of that matrix. A subsequent read-only package
check found version `0.1.42` debuggable and Android's package state `stopped=true`, so concurrent later
work changed the device state and this report does not claim the release variant remains installed now.

Only summary results and privacy-safe harness artifacts are referenced here. Screenshots remain in
temporary local storage; phone serials, personal messages, credentials, and server addresses are not
included in this report. Current remediation and release status live in their separate owning plans.
