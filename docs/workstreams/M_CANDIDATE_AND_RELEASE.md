# Workstream M — exact-candidate distribution and release proof

> **Document role:** This file owns stable implementation design and sequencing for Workstream M.
> It never owns candidate identity, task status, dates, owners, blockers, or completion evidence.
> Those remain only in [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative
> tracker, and the exact-candidate checklist/runbook it names.

<a id="store-01"></a>

## `STORE-01` — private Internal Testing candidate

Freeze and identify one exact AAB, keep distribution limited to the intended private Internal Testing
audience, provide an isolated synthetic-data server/setup path and private feedback route, disclose
known limitations, and answer only the Play declarations actually presented for that artifact. Store
listing, privacy, legal, support, screenshots, and UGC materials may be prepared for later promotion
without being misrepresented as complete public-release evidence.

The preparation sequence is deliberately separated:

- `STORE-01B-SDK57-DEPS` aligns the selected Expo patch set and dependency advisories without changing
  SDK/RN minors.
- `STORE-01C-FIREBASE-EAS` binds project-scoped secret Firebase file variables to every selectable
  build environment without packaging machine-local fallbacks.
- `STORE-01D-RELEASE-NOISE` removes deterministic host-gate noise at its owning tests rather than
  suppressing production diagnostics globally.
- `STORE-01E-SOURCE-FREEZE` captures the complete reviewed source/evidence snapshot in an identified
  release commit before version/build operations.
- `STORE-01F-LOCAL-AAB` builds and inspects the signed production bundle locally, stopping before any
  hosted build, upload, or submission.
- `STORE-01G-TESTER-READINESS` owns the secret-free tester list labels, opt-in custody, staged server,
  feedback, notice, evidence aliases, cleanup, halt rules, and live read-only Play preflight.
- `STORE-01H-INTERNAL-TRACK-CONFIG-GUARD` makes any repository-declared submit destination other than
  the one reviewed Internal Testing profile fail closed.

<a id="store-01a"></a>

## `STORE-01A` — UGC safety before broader promotion

Before Closed, Open, or Production promotion, the direct-messaging product needs versioned terms,
discoverable blocking and reporting, authoritative server enforcement, owned moderation operations,
and exact reviewer evidence. Store declarations alone cannot supply those behaviors.

Implement only after the corresponding owner decisions, in this order:

1. `STORE-01A0` freezes actors, trust boundaries, contracts, decisions, and child sequencing without
   claiming compliance.
2. `STORE-01A1` gates every UGC-creating foreground/background path on current, principal-bound terms
   acceptance while preserving allowed read/export/delete behavior.
3. `STORE-01A2` implements approved identity and truthful local/server block semantics across services,
   aliases, chats, sync, search, attachments, notifications, backup, and account lifecycle.
4. `STORE-01A3` creates a consentful bounded abuse-report DTO, evidence selection, transport, retry,
   acknowledgement, privacy, and revocation path separate from diagnostic error reports.
5. `STORE-01A4` makes terms/block/report state authoritative across app and server mutation/delivery
   paths with typed private-safe failures and defined old/partial-upgrade behavior.
6. `STORE-01A5` assigns monitored intake, response, escalation, appeal, access, audit, retention,
   deletion, outage, and abandonment procedures to trained owners.
7. `STORE-01A6` proves the complete synthetic terms/block/report/enforcement/moderation journey on the
   exact candidate and compatible staged server.

<a id="device-01"></a>

## `DEVICE-01` — candidate-specific device evidence

Create a new matrix for the exact candidate; never transfer an older checkmark. Record app
version/code, source and artifact identity, device/API/OEM, navigation, permissions, server version,
and evidence class beside each result. Cover install/upgrade, killed-process delivery, encrypted DB
and FTS, privacy/lock, native links/WebViews, notifications/actions/calls, transfer and provider
cleanup, keyboard/insets, sync/repair, schedules, themes/contrast, TalkBack, and account replacement.

Preparation is divided into candidate-identity preflight and current-flow matrices for
notifications/lifecycle, database/files/native behavior, permissions/UI/accessibility/account cleanup,
and source-eligible Reduce Motion. Host or disposable-development observations may support diagnosis
but cannot earn exact Play-candidate credit.

<a id="release-02"></a>

## `RELEASE-02` — rollout and hotfix operations

First decide whether the candidate is the first production release or an update. A first release uses
test tracks as canaries and defines launch countries/window and hold criteria because Play does not
offer percentage staging for the initial production launch. An update defines test-track promotion,
production percentages/cadence, and halt/resume ownership. Both branches require objective crash/ANR,
delivery, support, and feedback thresholds plus a corrective-build procedure.

<a id="release-gate-01"></a>

## `RELEASE-GATE-01` — final release decision

Reconcile common, native, artifact, manifest, dependency/license, privacy/Data Safety, listing,
target-SDK, upgrade/install, device, Play-policy, support, and rollout evidence against the exact AAB.
No release blocker may remain unchecked, and every conditional path must be fixed or proven
unreachable. Any permitted waiver records owner, reason, user impact, compensating control, and
revisit date; credential exposure, executable injection, media-permission escape, and unbounded input
cannot be waived without tested disablement/controls plus security and privacy approval.
