# Release plan

> **Status:** ACTIVE — created 2026-09-13.
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
- [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) is the
  superseded v63 execution snapshot and must be refreshed before any current staged-server round.
- [`DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md`](./DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md)
  records the current v67 candidate identity and narrow Play-update/lifecycle checkpoint.
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

| Field             | Frozen value                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Version           | `0.1.50` / Android version code `67`                                                                                                       |
| Source commit     | `2c7f426e3549127972fdd5c601bf98f651a75870` containing `DL-01` implementation `9139cf72bb56d613f1b848de63fe882b2029e91a`                    |
| Release commit    | `12a45924a2e8b5dc998e0b56e0df6c58f8186960`                                                                                                 |
| Release run       | `android-0.1.50-9139cf7-20260915234900`; archived session record only                                                                      |
| Submitted AAB     | `gator-release-0.1.50-v67-12a4592.aab` — 56,806,011 bytes; local bytes and receipt directory were removed by the later host update         |
| AAB SHA-256       | `1bec41156c38e556eb9dbe079bc0cf83ee1577d07d0912144fb0524739304702`                                                                         |
| Play destination  | Google Play Internal Testing only                                                                                                          |
| Submission        | EAS submission `67253f5c-6f5c-47a9-b669-c0ea25c4f5de` completed; live Internal release `0.1.50` / code `67` reports status `completed`     |
| Device checkpoint | Play v66→v67 update, visible session continuity, and ordinary-kill/App Lock biometric resume on owner-enrolled Samsung Android 16 / API 36 |

The linked v67 checkpoint proves Play delivery, a natural update with visible app-state continuity,
packaging of the current `DL-01` source markers, and one ordinary process-death/App Lock resume. It
does not prove a fresh install, hostile attachment transport, destination-receipt ordering, cache or
wallpaper quotas, private DB/filesystem outcomes, staged connect/sync/send/receive/notification,
permission/accessibility/account cleanup, or broader release readiness. `DL-01`, `DEVICE-01`, and
`STORE-01` therefore remain open.

The superseded v64 candidate retains its bounded `TLS-00` evidence only. That device result and the
superseded v63 `NET-01`/`RT-01A` results do not transfer to v67. V67 contains the restored native Find
My implementation, but this checkpoint did not repeat its full candidate-specific device matrix.

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
- **Current status (2026-09-15):** **IN_PROGRESS — v67 candidate creation and validation, EAS
  submission, live Internal `completed` state, Play v66→v67 update, and one bounded ordinary-kill/App
  Lock resume are proven.** Remaining work is tester/track administration, a stable non-production
  server and general fixtures, the full selected connect/sync/send/receive/notification/restart/
  disconnect journey, cleanup, candidate limitations, hostile `DL-01` proof, and artifact-specific
  Play declarations or prompts. No wider-track promotion is authorized.

Current child disposition:

| Child                                   | Status      | Remaining boundary                                                                          |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `STORE-01A-UGC-SAFETY`                  | Deferred    | Required before Closed, Open, or Production promotion, or earlier if Play requires it       |
| `STORE-01B-SDK57-DEPS`                  | Done        | None for the current SDK 57 dependency slice                                                |
| `STORE-01C-FIREBASE-EAS`                | Done        | Runtime Firebase behavior remains task-specific device evidence                             |
| `STORE-01D-RELEASE-NOISE`               | Done        | None for deterministic host-test noise                                                      |
| `STORE-01E-SOURCE-FREEZE`               | Done        | Current source identity is recorded above                                                   |
| `STORE-01F-LOCAL-AAB`                   | Done        | Identity is recorded; the local artifact/receipt workspace was removed and cannot be reused |
| `STORE-01G-TESTER-READINESS`            | In progress | Tester, staged-server, disclosure, journey, and cleanup evidence                            |
| `STORE-01H-INTERNAL-TRACK-CONFIG-GUARD` | Done        | Live v67 Internal status is verified; tester readiness remains separate                     |

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
