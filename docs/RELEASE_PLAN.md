# Release plan

> **Status:** ACTIVE — created 2026-09-13; latest artifact checkpoint updated 2026-10-19.
>
> **Authority:** This document is the only task-status authority for `RELEASE-01`, `STORE-01`,
> `RELEASE-02`, and `RELEASE-GATE-01`. The remediation tracker remains authoritative for its 107
> engineering, security, privacy, feature, and device-proof tasks.

This plan separates release operations from remediation work. It tracks how a reviewed build is
created, distributed, and eventually promoted; it does not mark an underlying remediation item done
or turn a partial device result into broad release approval.

Use the related documents for their narrower purposes:

- [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) owns remediation status, including
  `DEVICE-01` and every task-specific Android acceptance result.
- [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) is the operational checklist for one exact
  candidate.
- [`DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md`](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md)
  records the completed bounded v80 phone-testing round, its active continuation, and separate host proof for subsequent fixes;
  it does not close the general journey or broader release gates.
- [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) is the
  superseded v63 execution snapshot and must be refreshed before any current staged-server round.
- [`DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md`](./DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md)
  records the superseded v75 Play-installed API-36 `DL-01` matrix and supporting API-37
  compatibility evidence; it is not v77 device proof.
- [`DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md`](./DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md)
  records the superseded v67 Play-update/lifecycle checkpoint.
- [`TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md) records
  the superseded v64 candidate's bounded transport evidence.
- [`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md) retains the
  superseded v63 candidate's bounded preview evidence.
- [`PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md`](./PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md) retains
  bounded historical evidence from the superseded v62 candidate.

## Status register

This is the counting authority for the four release tasks below.

- **DONE — 1:** `RELEASE-01`.
- **IN_PROGRESS — 1:** `STORE-01`.
- **BLOCKED — 0:** none.
- **TODO — 2:** `RELEASE-02`, `RELEASE-GATE-01`.
- **WAIVED/DROPPED — 0.**

Three of four release tasks remain open. The current private Internal Testing release is live, but
the staged-server journey and broader release gates are not complete.

## Current candidate

The current candidate table is the frozen release-checklist boundary, not the latest artifact on the
Internal track. Play `0.1.62` / version code `84` is the latest live Internal Testing artifact.
The table below deliberately remains frozen to v77 because the operational release checklist has
not been rebound. No later artifact's task result transfers into a v77-only release row. V78's
task-scoped `PERM-01`, `UI-01`, and `THEME-01A` evidence remains recorded in the remediation plan.

**Latest live artifact, 2026-10-20 — not a checklist rebind:** **`0.1.62` / code `84`** was built
from source `6bec8553861de0b14e0fdca48d2bbbb81936cef6` (the Disconnect fixes, the Welcome
pending-revocation warning, the legal-fingerprint fix and the `--confirm` submission option, all
CI-green) and promoted as release commit `f55e9a9587da3f00a271d168def186bef392b1e4` on local branch
`release/android-0.1.62`. Run `android-0.1.62-6bec855-20261020191431` produced
`gator-release-0.1.62-v84-f55e9a9.aab`, **58,308,477 bytes**, SHA-256
`01ffacece33b1e7b577aa1f81d4af7695a5c1f3013fe2851324a0a3384068885`. The clean local production
build, native path proof and expected upload certificate (`6E:18:F9:…:2F:43`) pass. Under owner
decision 2026-10-20 the agent submitted it with `--execute --confirm` and the exact phrase
`SUBMIT 0.1.62 v84 01ffacece33b TO PLAY INTERNAL`; the Maps key came from the login Keychain.
Android Publisher readback after the 2026-10-20T19:57:38Z submission confirms Internal release
`0.1.62`, code `84`, `completed`. `check:legal-inventory` passes on the release commit without
regeneration, so this build's in-app notices are current. Code `83` was consumed by an earlier
`0.1.62` build from `e02ed25` (run `android-0.1.62-e02ed25-20261020083117`), validated and promoted
but never submitted; its local release branch was deleted. The device update and the pending rows in
`docs/DEVICE_VERIFICATION_CHECKLIST.md` remain open. No task status or frozen v77 checklist row is
changed by this Internal release.

**Historical v82 artifact, 2026-10-19:** **`0.1.61` / code `82`** was built
from source `03582e26d86ccb1eb089d5002a2eb92c9dba2751` (the CI-green batch 8 minor-note fixes) and
promoted as release commit `c62d822d6f4cb41bc2b0f305765ea4be7f1e6281` on local branch
`release/android-0.1.61`. Run `android-0.1.61-03582e2-20261019204805` produced
`gator-release-0.1.61-v82-c62d822.aab`, **58,306,995 bytes**, SHA-256
`9b16a88900d372fb1a7c07773f83d1db2d57e2800ba8f6e6d489f65c1dea2870`. The clean local production
build, native path proof and expected upload certificate (`6E:18:F9:…:2F:43`) pass, and the owner
typed the candidate-specific submission phrase. Android Publisher readback right after the
2026-10-19T23:58:04Z submission confirms Internal release `0.1.61`, code `82`, `completed`. The
Maps key came from a temporary git-ignored file deleted after use. The release commit's lock
version bump left the generated legal notices one digest behind (regenerated on master
afterwards), so this build's in-app notices quote the 0.1.60 lock digest. The device update and the
batch 8 rows in `docs/DEVICE_VERIFICATION_CHECKLIST.md` are pending. No task status or frozen v77
checklist row is changed by this Internal release.

**Historical v81 artifact, 2026-10-04:** **`0.1.60` / code `81`** was built
from source `2c09378b495b11efdd145cdaa6ef0cc54c12f54a` and promoted as release commit
`ec5beee552253b9c73f95b66034fb6f76c29b97e` on local branch `release/android-0.1.60`.
Run `android-0.1.60-2c09378-20261004112548` produced
`gator-release-0.1.60-v81-ec5beee.aab`, **58,172,630 bytes**, SHA-256
`7ecad1e31bb3a55a25695681c8a57813d0f79dc84216f4b9192825ca80b5221b`.
The clean local production build, merged-manifest/packaged-artifact checks, expected upload
certificate, arm64-only libraries, source/tree/Maps bindings and independent review pass.
Android Publisher readback at **2026-10-04T12:15:29.413Z** confirms Internal `completed`, with
no releases on other tracks. The temporary submission credential was removed after use.
All **177 native tests** pass with zero failures/errors/skips, including the **42** previously
pending tests; the debug APK and six local Kotlin modules also compile successfully.
The earlier **542 suites / 6,849 tests** and coverage results remain bound to host-tested parent
`2f853fa`; subsequent source changes are documentation and two native-test-only compiler fixes.
Private evidence: `BB/gator-android-0.1.60-20261004/RELEASE_REPORT.json`.
The Samsung subsequently updated through Google Play to v81; all four delivered APK signatures
match the expected Play signer, and disconnected Welcome plus a **461 ms** cold relaunch after
an observed ordinary process kill pass. Repaired-feature acceptance and existing
security/legal/wider-release gates remain separate.
AMFI stays enabled for the owner-approved Mac helper correction. No task status or frozen v77
checklist row is changed by this Internal release.

**Historical v80 artifact, 2026-10-03:** `0.1.59` / code `80` was built from
source `bf1a9116463aed2bc5e420a3b5d8b6e7c963ead2` and promoted as release commit
`acf08e7ee2ad68aceb2fbc104f409124627034a7`. The retained
`gator-release-0.1.59-v80-acf08e7.aab` is 58,153,376 bytes with SHA-256
`4430c8edb5fc29484b75a73ed8afd3755ed0a9bc80e3a04e673f5e794eb755cd`.
The private release receipt (`BB/gator-android-release-2026-10-03/RELEASE_REPORT.json`) records the clean
successful build, artifact validation, independent review, and completed Internal submission
`5c4dce7e-d8af-4c9a-909a-7bfa4e455e3c`. Android Publisher read-back confirmed Internal `completed`
with no releases on the other tracks. The later
[v80 device report](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md) binds the Play-installed,
nondebuggable API-36 package to scoped verification of its four delivered APKs. The release receipt's
original no-device-evidence statement describes the earlier submission checkpoint, not the later
phone session. Neither this update nor the device report changes the four task statuses below.
Private receipt paths in this checkpoint are relative to the checkout's parent directory.

The phone has since reproduced automatic sync-repair failure and loss of surviving notification
history on cold-process withdrawal. Their subsequent source fixes pass the combined host milestone
(`BB/gator-play-v80-device-20261003/combined-repair-milestone-cjZ2Bd/result.json`)
(538 suites / 6,702 tests, two existing opt-in skips; architecture 52/52; migrations 5/5), but
**neither fix is installed in v80**. A new candidate and exact-device replays remain required.
The later combined executable-source checkpoint `58b2759a3a3a8a4e3bd3c218151d7c6fa2452af1`
adds reviewed Settings-label search, banner/offline-copy, App Lock old-notice privacy and multipart
filename repairs, plus finite sync diagnostics. Its final full run passes **539 suites / 6,778 tests**,
and UI coverage passes all configured floors. Production JavaScript export and clean native project
generation pass; Kotlin execution, signed Android build and exact-device replays remain pending.
The clean-install review also refreshed one stale bounded-download component count/digest in the
generated legal inventory. Documentation/data refreshes require a fresh final source identity and
release receipts. Earlier source `ea7054a4c011fa4d7598070236fac9a2e2684053` is prepared as
`android-0.1.60-ea7054a-20261004001707`; earlier unused preparations are superseded. No remote
build number was consumed and no Android build or submission occurred. The Mac server package at
`917bd819` is installed with verified package, signature, state preservation and local/public HTTP
health. A later explicit helper/status refresh showed authenticated CONNECTED and HEALTHY/READY;
the [device continuation](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md) records its scope.
Further v80 background testing passed uninterrupted request/deadline lanes but exposed missing
native-stop propagation and a timer-keeper lifetime gap. Folder deletion also caused a native
process crash; review found a concrete Screens multi-pop ordering defect, though the redacted
device error does not establish exact attribution. Both corrections passed independent source
review and await final integrated host checks, native compilation, and exact-phone replay. The
prepared Android candidate predates these corrections and must be superseded before building.
The reviewed combined source checkpoint `15874ff` includes those corrections and passes its static
gates. Its full coverage run passes 540 suites / 6,798 tests and all UI floors, with two existing
skips. The simultaneous ordinary Jest process crashed in V8 garbage collection (exit 139), so that
incomplete run is not a pass. The serial ordinary rerun on final executable source
`b7b92e84b697adb05df4756daf4002f33e705848` passes **540 suites / 6,798 tests**, with two existing
skips. Final artifact/native-path guard units pass **39 tests**; fresh dependency installation,
Android JavaScript export and clean native generation pass without a JVM. A later v80 warm-background
unreachable-server lane took 194.059 seconds to return RETRY, only after foregrounding. A separate
native scheduler-wait watchdog now passes independent source review and 27 focused guard tests;
its six additional native tests remain uncompiled/unrun. `15874ff` is not the final
build authorization or a claim that this later runtime failure is resolved.
The Mac session has since installed `5d9ac754` with automatic visible-status polling; its 5,480
JS/TS tests, nine Python tests, Go checks, package/signature and state-preservation checks pass.
Latest-build owner visual confirmation and coordinated reboot recovery remain pending. Expanded
encrypted-backup and bounded account-switch tests now pass on v80, with scope in the device report.
Live text/edit/reaction, reply, Unsend, image, and captioned-PDF
observations retain their distinct delivery limits. Automatic retry reached the UI's up-to-date state after an unexplained
sync failure; independently reconciled history parity, general privacy, and the full journey remain
unproven. Raw dependency audit failures remain unresolved and are not waived by the local mitigations.

**Historical prebuild checkpoint, 2026-10-04 UTC:** clean host-tested source
`2f853fa053e51145db6c586e45efd84b39897035` includes the approved Gator scheduling sheet,
both cancellation repairs and photo tap/hold actions. Production source is `5d34c22`; the child
only awaits two Settings-test interactions. Serial full Jest and UI coverage each pass
**542 suites / 6,849 tests**, with two existing skips and zero console warning/error blocks.
Coverage floors, static/database gates and Android JavaScript export pass. The renewed
[v80 device report](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md) records the remaining bounded
download, account, upload, share, media and notification-action checks and their limitations.
All older `0.1.60` preparations, including `android-0.1.60-5aadc5a-20261004015037`, are
superseded. Final documentation is copied into a clean child; its exact source/tree and fresh
preparation are retained in `BB/gator-prebuild-remaining-20261003/combined-build-handoff.json`.
Preparation consumes no Android version code. The 42 added native tests, native compilation,
signed artifact validation and replacement-phone replays remain pending until the coordinated
AMFI-on build window. Mac source `5d9ac754` remains installed; its session confirmed signature,
HTTP health and saved boot-setting rollback checks. This checkpoint changes no task status or
the frozen v77 checklist boundary, and is not approval for a broader release.

**Historical v79 submission/device checkpoint:** `0.1.58` / version code `79` was built from
source `a0add484c00fdda06b7ee2c0a5bb5221d256d292` and promoted as release commit
`4cbb05064ec9f891f00cb0a4f697435206f54fce` by run
`android-0.1.58-a0add48-20260929062534`. The retained
`gator-release-0.1.58-v79-4cbb050.aab` is 58,215,008 bytes with SHA-256
`c60cc661a318399afc5d30ed6d914303df41674cfafadfef9d835bfe3c442e19`. EAS submission
`3138fc9b-c658-4fbc-b144-6a19f68a9e6e` finished successfully for Internal Testing with release
status `COMPLETED`. After a short propagation delay, Google Play updated the enrolled Android
16/API-36 Samsung from v78 to v79. Package Manager reported `com.android.vending` as installer,
version `0.1.58` / code `79`, a non-debuggable arm64/en/xxhdpi split set, and min/target SDK 36. A
bounded unauthenticated smoke passed: 439 ms cold Welcome launch, 22 ms hot resume, ordinary process
kill, and 430 ms cold relaunch, with a live replacement PID and no scoped fatal exception. This
proves one tester's Play delivery and basic lifecycle only—not Android Publisher live-track readback,
the tester-list boundary, signing-certificate inspection, authentication, staged-server behavior, or
the broader device matrix.

| Field             | Frozen value                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version           | `0.1.56` / Android version code `77`                                                                                                                          |
| Source commit     | `da05b66cfcbd9b3c35ebd6d0ec3ba0ed781bf7d0`                                                                                                                    |
| Release commit    | `694d65bce9effde40a50c100e264cc50d0ef594b` on `release/android-0.1.56`                                                                                        |
| Release run       | `android-0.1.56-da05b66-20260919025209`; local phase receipts are retained under `dist/release/`                                                              |
| Submitted AAB     | `gator-release-0.1.56-v77-694d65b.aab` — 57,879,683 bytes                                                                                                     |
| AAB SHA-256       | `ba85e8356be306bd8d820ef0f09ed4cb5a9781afb2e601d76b792a9bf843f6d2`                                                                                            |
| Play destination  | Google Play Internal Testing only                                                                                                                             |
| Submission        | EAS id `e7ca0440-81f3-40a0-ae6e-b05f2c52e59b` finished; Android Publisher readback at `2026-09-19T03:18:57Z` found only Internal `0.1.56` / `77`, `completed` |
| Device checkpoint | Play-installed Samsung/Android 16/API 36 v77: synthetic killed-FCM/attachment slice passed; full journey and installed-signature check remain open            |

Play v77 remains the frozen release-checklist candidate, but it is no longer the latest live
Internal artifact. It predates `FEAT-05A` Current Location, its coarse/fine foreground permissions,
and the revised privacy/store disclosures. It therefore provides no Current Location permission,
send, retry, background-containment, or Data Safety evidence. Shipping that feature requires an
explicit rebind to a new source-frozen candidate and the exact checks in
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md); neither historical no-location-permission results
nor later v78–v80 task results transfer to the frozen v77 rows.

The validated v77 AAB binds the exact package, version, source/release tree, upload certificate,
Maps-key digest, artifact hash, and native-path proof. The first 0.1.56 build from `f95d4f3`
failed in Gradle and consumed code `76` without an artifact or Play submission; the detailed EAS
log was not retained. A no-increment diagnostic reproduced D8's 2 GiB Java-heap exhaustion.
The bounded 4 GiB fix is in source `da05b66`; its diagnostic and exact signed release build passed.
No Android device result from v75 is relabeled as v77 evidence. On 2026-09-18 Play updated the
Samsung from v75 to v77, then delivered a clean v77 reinstall after Disconnect
reported incomplete cleanup of the old disposable fixture session. The replacement fixture counted
11 unauthorized requests, consistent with the old and new synthetic credentials differing. The clean
install paired to synthetic loopback data; ordinary `am kill` removed the process, one encrypted FCM
woke a new process, and one attachment download finished before foregrounding. In-app diagnostics
later showed one attachment row with one local path and zero active transfers. An initialized
background WorkManager run executed and contacted the fixture; two forced runs after `am kill`
started processes but did not execute native `doWork` or change the fixture API count, so
killed-process WorkManager work remains unproven. The installed split-signature verifier stopped
at a Java `SIGBUS` in local `apksigner`; the other session owns that Java issue, and this run did
not troubleshoot it.

The superseded v75 Play-installed Samsung passed all five scoped `DL-01` groups, with supporting
Play-signed sideloaded API-37 compatibility and controlled private-state proof. Under the owner's
approved split, `DL-01` remains done; `DEVICE-01` and `STORE-01` remain open for v77 Play installs,
API-37 provenance, fresh/prepared install paths, the general staged journey, and other gates. The
earlier v67 natural-update/App Lock, v64 `TLS-00`, and v63 `NET-01`/`RT-01A` results likewise remain
historical unless an owning task explicitly combines them.

## Release disposition

| Task              | Disposition                         | Required state                                                                                               |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `RELEASE-01`      | Done                                | Use the receipt-bound, failure-safe release phases for every future candidate.                               |
| `STORE-01`        | Blocks completion of Internal round | Keep distribution private and do not claim the selected tester/staged journey is complete while open.        |
| `RELEASE-02`      | Conditional for Internal Testing    | Activate and complete it before any Closed, Open, or Production promotion.                                   |
| `RELEASE-GATE-01` | Blocks broader release              | Do not approve a wider release until the exact-candidate remediation, Play, device, and approval gates pass. |

## Primary release tasks

<a id="release-01"></a>

### [x] `RELEASE-01` — Make release commands failure-safe

- **Priority/size:** P1 / M.
- **Implementation spec:** [`RELEASE-01`](./workstreams/J_PACKAGE_AND_ANDROID_FIT.md#release-01).
- **Acceptance:** Every artifact maps to a version, commit, environment, and validation record;
  failures do not churn the shared checkout or silently reuse a consumed version code.
- **Verify:** Forced failure leaves the shared source unchanged; a successful run records exact
  preparation, build, validation, promotion, and submission receipts.
- **Completion evidence (2026-09-10):** The isolated runner failed closed when its first checkout
  lacked dependencies, remote version code remained `61`, and the shared checkout was unchanged.
  After the locked dependencies were installed, one run built and validated version `0.1.45` / `62`,
  promoted release commit `644a566`, and submitted the exact retained AAB only to Internal Testing.
  The AAB size, SHA-256, upload certificate, source/release commits, environment, and EAS submission
  are bound by the retained receipts. Independent review returned GO for task closure.

<a id="store-01"></a>

### [ ] `STORE-01` — Prepare the exact Google Play Internal Testing candidate

- **Priority/size:** P0 / M for the current private Internal Testing scope.
- **Implementation spec:** [`STORE-01`](./workstreams/M_CANDIDATE_AND_RELEASE.md#store-01).
- **Acceptance:** The exact candidate is available only to the intended private audience; testers
  can reach core functionality through an isolated synthetic-data setup; known limitations and the
  feedback route are clear; no Closed, Open, or Production release is active; and no result is
  presented as public-release approval.
- **Verify:** Confirm repository track/config, the live track and tester list, exact AAB identity,
  hash, and Play signing, install or update through Play, staged-server journeys, feedback path,
  cleanup, and every Play prompt shown for this artifact.
- **Current status (2026-10-03):** **IN_PROGRESS — v80 is validated, Internal `completed` is confirmed
  by Publisher read-back, and the Play-installed API-36 candidate has scoped identity/signature and
  device proof; the full selected journey, disclosures, and broader release gates remain open.** See
  the [device report](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md) for the exact evidence
  and limits. The two subsequent source fixes still require a replacement candidate and device proof.
  The v77 live Internal `completed` state and narrow Play-installed v77/API-36 killed-FCM slice remain
  historical proof. The
  superseded v75 natural Play build-73→75 update and scoped Samsung `DL-01` matrix remain task history,
  while its Play-signed API-37 result remains supporting-only.
  Remaining work is tester administration, genuine API-37 Play delivery, coverage beyond the bounded
  synthetic fixtures, the full selected connect/sync/send/receive/notification/restart/disconnect
  journey, general cleanup and candidate
  limitations, and artifact-specific Play declarations or prompts. Exact-candidate proof must also
  reconcile foreground coarse/fine location, absence of background/location-service permission,
  Current Location success/no-send/retry behavior, privacy copy, and Data Safety. No wider-track
  promotion is authorized.

Current child disposition:

| Child                                   | Status      | Remaining boundary                                                                                         |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `STORE-01A-UGC-SAFETY`                  | Deferred    | Required before Closed, Open, or Production promotion, or earlier if Play requires it                      |
| `STORE-01B-SDK57-DEPS`                  | Done        | V80 release receipt records Doctor 20/20; raw dependency audits still fail and remain a separate open gate |
| `STORE-01C-FIREBASE-EAS`                | Done        | Runtime Firebase behavior remains task-specific device evidence                                            |
| `STORE-01D-RELEASE-NOISE`               | Done        | None for deterministic host-test noise                                                                     |
| `STORE-01E-SOURCE-FREEZE`               | Done        | Exact v77 source and release identities are recorded above                                                 |
| `STORE-01F-LOCAL-AAB`                   | Done        | Exact v77 build/validation identity and retained local AAB are recorded above                              |
| `STORE-01G-TESTER-READINESS`            | In progress | Tester, staged-server, Current Location disclosure/device, journey, and cleanup evidence                   |
| `STORE-01H-INTERNAL-TRACK-CONFIG-GUARD` | Done        | Live v77 Internal status is verified; tester readiness remains separate                                    |

The deferred UGC-safety branch is the code-bearing exception inside this release plan: before any
wider promotion, children A1–A4 require app/server terms, blocking, reporting, and enforcement code;
A5 is operational ownership and A6 is reviewer/device proof. None is selected for the current
private Internal Testing scope.

<a id="release-02"></a>

### [ ] `RELEASE-02` — Define staged rollout, health thresholds, and hotfix operations

- **Priority/size:** P0 / M.
- **Implementation spec:** [`RELEASE-02`](./workstreams/M_CANDIDATE_AND_RELEASE.md#release-02).
- **Acceptance:** The applicable first-release or update path, objective hold thresholds, monitoring
  access, and named halt, hotfix, and support owners are selected and rehearsed. The owner can ship
  and support a corrective build without inventing procedure during an incident. A first release
  does not promise percentage rollout control or rollback to a nonexistent prior build.
- **Verify:** For a first release, rehearse promotion of the same signed candidate through the
  applicable test tracks and the launch/hold decision. For an update, rehearse staged production,
  halt/resume, and corrective-build handling.
- **Current status (2026-09-13):** **TODO — deferred while distribution remains private Internal
  Testing.** This becomes mandatory before any Closed, Open, or Production promotion.

<a id="release-gate-01"></a>

### [ ] `RELEASE-GATE-01` — Final release gate

- **Priority/size:** P0 / M.
- **Implementation spec:** [`RELEASE-GATE-01`](./workstreams/M_CANDIDATE_AND_RELEASE.md#release-gate-01).
- **Acceptance:** No selected release blocker is unchecked; every conditional path is fixed or
  proven unreachable in the exact candidate; the artifact identity and approvals are retained.
  Credential exfiltration, executable injection, media-permission escape, and unbounded input cannot
  be waived without a tested compensating control or proven disablement plus security/privacy
  approval.
- **Verify:** Run the common remediation gates, candidate device matrix, Play pre-launch/policy
  checks, and the release checklist applicable to the selected distribution scope.
- **Current status (2026-09-13):** **TODO.** Internal Testing evidence is partial and no broader
  release has been approved.

## Status-update rule

Update these four statuses only in this file. Supporting evidence may remain in receipts, the release
checklist, runbook, device-proof documents, and Git history, but those sources do not override this
register. Update the remediation plan separately when release testing supplies evidence for one of
its tasks.
