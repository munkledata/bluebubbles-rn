# Documentation index

Start with the root [`README.md`](../README.md) for the product and architecture overview and
[`AGENTS.md`](../AGENTS.md) for rules that apply while editing the repository.

## Current status and release operations

- [`STATUS.md`](./STATUS.md) is the remediation-task status authority.
  It owns 107 engineering, security, privacy, feature, and device-proof tasks.
  Its dated status log lives in [`history/WORK_PLAN_2026-08-03_log.md`](./history/WORK_PLAN_2026-08-03_log.md).
- [`RELEASE_PLAN.md`](./RELEASE_PLAN.md) is the release-task status authority. It owns `RELEASE-01`,
  `STORE-01`, `RELEASE-02`, and `RELEASE-GATE-01`.
- [`POST_REMEDIATION_PLAN.md`](./POST_REMEDIATION_PLAN.md) preserves explicitly deferred product work. Its items are
  outside both active task counts and start only after remediation unless the owner moves one back.
- [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) is the short operational gate for the current
  frozen `0.1.56` / code `77` Internal Testing candidate. It does not replace either task plan.
- [`DEVICE_VERIFICATION_CHECKLIST.md`](./DEVICE_VERIFICATION_CHECKLIST.md) preserves the retired v56 preparation
  ledger. It is not executable for a replacement candidate; `DEVICE-01` owns the candidate-specific rewrite.
- [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) is the private Internal Testing
  procedure; Play/EAS/server writes still require explicit owner approval.
- [`PUBLIC_RELEASE_LICENSING.md`](./PUBLIC_RELEASE_LICENSING.md) records the private/no-public-license decision and
  the ownership, notice, distribution-terms, and approval gate required before broader distribution.

## Architecture and owned contracts

| Area                                   | Read before changing it                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved package boundaries            | [`APP_STACK_ADR.md`](./APP_STACK_ADR.md), [`PHASE-DEPENDENCIES.md`](./PHASE-DEPENDENCIES.md)                                                                                                                               |
| Approved conversation/contact identity | [`FEAT_06_IDENTITY_ADR.md`](./FEAT_06_IDENTITY_ADR.md) — accepted no-merge contract; production hardening tracked separately                                                                                                  |
| App/server routes and events           | [`APP_SERVER_PARITY.md`](./APP_SERVER_PARITY.md)                                                                                                                                                                           |
| Frozen database-write handoff          | [`DB_02A_CURRENT.md`](./DB_02A_CURRENT.md)                                                                                                                                                                                 |
| Session late results and teardown      | [`REL_004_LATE_RESULT_INVENTORY.md`](./REL_004_LATE_RESULT_INVENTORY.md), [`REL_005A_TEARDOWN_INVENTORY.md`](./REL_005A_TEARDOWN_INVENTORY.md), [`SESSION_SCOPED_STATE_INVENTORY.md`](./SESSION_SCOPED_STATE_INVENTORY.md) |
| Push, headless delivery, notifications | [`PUSH_DELIVERY.md`](./PUSH_DELIVERY.md)                                                                                                                                                                                   |
| Attachment cache and downloads         | [`CACHE_ARCHITECTURE.md`](./CACHE_ARCHITECTURE.md)                                                                                                                                                                         |
| Uploads                                | [`UPLOAD_PROGRESS.md`](./UPLOAD_PROGRESS.md)                                                                                                                                                                               |
| Android inbound sharing                | [`SHARE_INTENT_RELIABILITY.md`](./SHARE_INTENT_RELIABILITY.md)                                                                                                                                                             |
| RCS bridge/send behavior               | [`RCS_BRIDGE_PLAN.md`](./RCS_BRIDGE_PLAN.md), [`RCS_SEND_RELIABILITY.md`](./RCS_SEND_RELIABILITY.md), [`RCS_FORWARD_RECONCILE_PLAN.md`](./RCS_FORWARD_RECONCILE_PLAN.md)                                                   |
| UGC/public-track safety                | [`UGC_SAFETY_CONTRACT.md`](./UGC_SAFETY_CONTRACT.md)                                                                                                                                                                       |
| Local chat deletion and un-archive     | [`CHAT_DELETION.md`](./CHAT_DELETION.md), [`CHAT_ARCHIVE.md`](./CHAT_ARCHIVE.md) |
| Message-state (deleted/restored) model | [`MESSAGE_STATE_PROTOCOL.md`](./MESSAGE_STATE_PROTOCOL.md) |
| Deferred file splits, dev DB harness   | [`DEFERRED_FILE_SPLITS.md`](./DEFERRED_FILE_SPLITS.md), [`HARNESS_PROOF_REDESIGN.md`](./HARNESS_PROOF_REDESIGN.md) |
| Device/host runbooks still open        | [`DELETE_SYNC_DEVICE_RUNBOOK.md`](./DELETE_SYNC_DEVICE_RUNBOOK.md), [`TEST_01C_V8_HARNESS.md`](./TEST_01C_V8_HARNESS.md) |

## Workstream implementation specs

These files own stable design and sequencing. Mutable remediation status remains in the remediation
plan; mutable status for the four release-operation tasks remains in the release plan.

| Workstream | Stable implementation spec                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- |
| A          | [`Baseline and immediate containment`](./workstreams/A_BASELINE_AND_CONTAINMENT.md)         |
| B          | [`Network and WebView trust`](./workstreams/B_NETWORK_AND_WEBVIEW.md)                       |
| C          | [`SDK/native foundation and bounded files`](./workstreams/C_NATIVE_FOUNDATION_AND_FILES.md) |
| D          | [`Cold/headless and realtime reliability`](./workstreams/D_HEADLESS_AND_REALTIME.md)        |
| E          | [`Session isolation and notifications`](./workstreams/E_SESSION_AND_NOTIFICATIONS.md)       |
| F          | [`Privacy, policy, and release truth`](./workstreams/F_PRIVACY_POLICY_AND_RELEASE_TRUTH.md) |
| G          | [`Database ownership`](./workstreams/G_DATABASE_OWNERSHIP.md)                               |
| H          | [`UI, theme, and accessibility`](./workstreams/H_UI_THEME_AND_ACCESSIBILITY.md)             |
| I          | [`Recovery, scale, and backup`](./workstreams/I_RECOVERY_SCALE_AND_BACKUP.md)               |
| J          | [`Package ownership and Android fit`](./workstreams/J_PACKAGE_AND_ANDROID_FIT.md)           |
| K          | [`Architecture and documentation`](./workstreams/K_ARCHITECTURE_AND_DOCUMENTATION.md)       |
| L          | [`Product breadth`](./workstreams/L_PRODUCT_BREADTH.md)                                     |
| M          | [`Candidate and release`](./workstreams/M_CANDIDATE_AND_RELEASE.md)                         |

## Focused research and historical verification design

- [`SPIKES.md`](./SPIKES.md) — native/device proof goals and recorded spikes.
- [`COMPONENT_TESTING_PLAN.md`](./COMPONENT_TESTING_PLAN.md) and
  [`UI_COVERAGE_70_PLAN.md`](./UI_COVERAGE_70_PLAN.md) — completed historical UI-test rollout plans. Current
  coverage-hardening status belongs to `TEST-01` in the work plan.
- [`IMESSAGE_ACCOUNT_PLAN.md`](./IMESSAGE_ACCOUNT_PLAN.md) — historical iMessage account contract/design record, superseded by `FP-006` retirement.
- [`FINDMY_DECRYPTION_PLAN.md`](./FINDMY_DECRYPTION_PLAN.md) and
  [`FINDMY_KEY_EXTRACTION.md`](./FINDMY_KEY_EXTRACTION.md) — Find My crypto/key research.
- [`TRANSCRIPT_BACKGROUND_RE.md`](./TRANSCRIPT_BACKGROUND_RE.md) — iOS/macOS 26 synced chat-background reverse-engineering runbook.

## Dated device proofs, audits, and reviews (historical)

Kept for provenance; none of these is a status source. Device proofs after Play v81 are recorded in
[`RELEASE_PLAN.md`](./RELEASE_PLAN.md) and the release notes, not as separate files.

Device and candidate proofs:

- [`ANDROID_02_PREDICTIVE_BACK_PROOF_2026-09-24.md`](./ANDROID_02_PREDICTIVE_BACK_PROOF_2026-09-24.md) — ANDROID-02 predictive Back proof — 2026-09-24, closed 2026-09-27
- [`BACKUP_SLOTS_01_SAMSUNG_PARTIAL_PROOF_2026-09-24.md`](./BACKUP_SLOTS_01_SAMSUNG_PARTIAL_PROOF_2026-09-24.md) — BACKUP-SLOTS-01 Samsung partial device proof — 2026-09-24
- [`DB_03_SAMSUNG_REFRESH_2026-09-29.md`](./DB_03_SAMSUNG_REFRESH_2026-09-29.md) — DB-03 Samsung current-source refresh — 2026-09-29
- [`DEVICE_01_PLAY_V79_DEVICE_PROOF_2026-09-29.md`](./DEVICE_01_PLAY_V79_DEVICE_PROOF_2026-09-29.md) — DEVICE-01 exact Play v79 device proof — 2026-09-29
- [`DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md`](./DEVICE_01_PLAY_V80_DEVICE_PROOF_2026-10-03.md) — DEVICE-01 — Google Play v80 bounded testing round, October 3, 2026
- [`DEVICE_01_PLAY_V81_DEVICE_PROOF_2026-10-04.md`](./DEVICE_01_PLAY_V81_DEVICE_PROOF_2026-10-04.md) — DEVICE-01 — Play v81 device proof, October 4, 2026
- [`DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md`](./DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md) — DL-01 exact Play v67 candidate/device checkpoint — 2026-09-15
- [`DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md`](./DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md) — DL-01 Play v75 device proof — 2026-09-18
- [`DL_01_SUPPORTING_V66_DOWNLOAD_PROOF_2026-09-15.md`](./DL_01_SUPPORTING_V66_DOWNLOAD_PROOF_2026-09-15.md) — DL-01 supporting v66 download evidence — 2026-09-15
- [`IPC_01_PLAY_V68_CANDIDATE_CHECKPOINT_2026-09-15.md`](./IPC_01_PLAY_V68_CANDIDATE_CHECKPOINT_2026-09-15.md) — IPC-01 exact Play v68 candidate checkpoint — 2026-09-15
- [`IPC_01_PLAY_V72_DEVICE_PROOF_2026-09-16.md`](./IPC_01_PLAY_V72_DEVICE_PROOF_2026-09-16.md) — IPC-01 exact Play v72 device proof — 2026-09-16
- [`IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md`](./IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md) — IPC-01 and SHARE-01 Play v75 device proof — 2026-09-18
- [`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md) — NET-01 Google Play device proof — 2026-09-13
- [`PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md`](./PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md) — PKG-01 Play v75 native-boundary proof — 2026-09-18
- [`PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md`](./PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md) — Google Play Internal device proof — 2026-09-09
- [`RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md) — RT-01A Google Play device proof — 2026-09-13
- [`SHARE_02_DEVICE_PROOF_2026-09-28.md`](./SHARE_02_DEVICE_PROOF_2026-09-28.md) — SHARE-02 owned Android share-intake proof — 2026-09-28
- [`TLS_00_DOWNLOAD_DEVICE_PROOF_2026-09-13.md`](./TLS_00_DOWNLOAD_DEVICE_PROOF_2026-09-13.md) — TLS-00 local-release owned-download proof — 2026-09-13
- [`TLS_00_JSON_REDIRECT_DEVICE_PROOF_2026-09-13.md`](./TLS_00_JSON_REDIRECT_DEVICE_PROOF_2026-09-13.md) — TLS-00 local-release JSON redirect proof — 2026-09-13
- [`TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md) — TLS-00 exact Google Play candidate proof — 2026-09-14
- [`TLS_00_UNTRUSTED_CERT_DEVICE_PROOF_2026-09-13.md`](./TLS_00_UNTRUSTED_CERT_DEVICE_PROOF_2026-09-13.md) — TLS-00 local-release untrusted-certificate proof — 2026-09-13
- [`TLS_00_UPLOAD_DEVICE_PROOF_2026-09-13.md`](./TLS_00_UPLOAD_DEVICE_PROOF_2026-09-13.md) — TLS-00 local-release legacy-upload proof — 2026-09-13
- [`TLS_00_WEBSOCKET_DEVICE_PROOF_2026-09-13.md`](./TLS_00_WEBSOCKET_DEVICE_PROOF_2026-09-13.md) — TLS-00 local-release WebSocket redirect proof — 2026-09-13
- [`TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md`](./TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md) — TLS-02 system-CA-only Android proof — 2026-09-15
- [`WEB_01_03_NATIVE_MAP_DEVICE_PROOF_2026-09-14.md`](./WEB_01_03_NATIVE_MAP_DEVICE_PROOF_2026-09-14.md) — WEB-01..03 native Find My map — local device proof
- [`WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md`](./WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md) — WEB-01..03 native Find My map — Play v65/v66 device proof
- [`WEB_02_PLAY_DEVICE_PROOF_2026-09-14.md`](./WEB_02_PLAY_DEVICE_PROOF_2026-09-14.md) — WEB-02 exact Play disabled-path proof — 2026-09-14

Audits, reviews, comparisons, and plans:

- [`ADVERSARIAL_COMPLEXITY_REVIEW_2026-09-09.md`](./ADVERSARIAL_COMPLEXITY_REVIEW_2026-09-09.md) — Adversarial architecture and complexity review — 2026-09-09
- [`BB2_REMEDIATION_PLAN_2026-07-30.md`](./BB2_REMEDIATION_PLAN_2026-07-30.md) — Remediation Plan — BB App 2.0 Gaps & Bugs
- [`BB_APP_2.0_COMPARISON_2026-07-30.md`](./BB_APP_2.0_COMPARISON_2026-07-30.md) — BlueBubbles App 2.0 vs Gator RN — Feature & Architecture Comparison
- [`GITHUB_ISSUES_FEATURE_AUDIT_2026-07-15.md`](./GITHUB_ISSUES_FEATURE_AUDIT_2026-07-15.md) — BlueBubbles GitHub Feature-Request Audit → Gator RN (2026-07-15)
- [`INDEPENDENT_REPO_REVIEW_2026-09-08.md`](./INDEPENDENT_REPO_REVIEW_2026-09-08.md) — Independent repository and original-app review — 2026-09-08
- [`OLD_APP_PARITY_AUDIT.md`](./OLD_APP_PARITY_AUDIT.md) — Old App → RN Parity Audit
- [`OLD_APP_PARITY_AUDIT_2026-07-15.md`](./OLD_APP_PARITY_AUDIT_2026-07-15.md) — Old App → RN Feature-Gap Audit (2026-07-15 refresh)
- [`PHONE_REVIEW_FOLLOWUP_2026-09-09.md`](./PHONE_REVIEW_FOLLOWUP_2026-09-09.md) — Phone follow-up to the architecture and adversarial reviews
- [`RCS_BRIDGE_AUDIT_2026-07-27.md`](./RCS_BRIDGE_AUDIT_2026-07-27.md) — RCS bridge — outage post-mortem + architecture audit (2026-07-27)
- [`REACT_PATTERNS_AUDIT_2026-07-16.md`](./REACT_PATTERNS_AUDIT_2026-07-16.md) — React Patterns Audit — 2026-07-16
- [`RELIABILITY_HARDENING_2026-07-26.md`](./RELIABILITY_HARDENING_2026-07-26.md) — Reliability hardening — historical status, 2026-07-26
- [`REVIEW_REMEDIATION_2026-10-03.md`](./REVIEW_REMEDIATION_2026-10-03.md) — Gator RN — review remediation, October 2–3, 2026
- [`STATE_AUDIT_2026-07-25.md`](./STATE_AUDIT_2026-07-25.md) — State audit & fix plan — 2026-07-25

## Historical evidence policy

Dated plans, audits, comparisons, transcripts, and completed inventories are retained for provenance; they do not
override the applicable remediation or release plan. In particular, [`WORK_PLAN_2026-07-17.md`](./WORK_PLAN_2026-07-17.md),
[`DB_WRITE_SAFETY_AUDIT_2026-07-25.md`](./DB_WRITE_SAFETY_AUDIT_2026-07-25.md), and the former root audit/roadmap files
now under [`history/`](./history/AUDIT_REPORT.md) are historical evidence. Read their retirement/evidence headers before relying on a claim, and confirm mutable facts in
source or the current owning document.

Do not copy task status into this index. Add a stable subsystem reference here only when contributors
must discover it before editing that area; keep transient evidence and detailed history in the owning
remediation or release plan.
