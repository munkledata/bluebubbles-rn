# Documentation index

Start with the root [`README.md`](../README.md) for the product and architecture overview and
[`AGENTS.md`](../AGENTS.md) for rules that apply while editing the repository.

## Current status and release operations

- [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) is the **only task-status authority**. It owns task ids,
  priorities, dependencies, blockers, acceptance criteria, and completion evidence.
- [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) is the short candidate operational gate; it currently records no
  conforming frozen candidate. It does not replace the engineering backlog.
- [`DEVICE_VERIFICATION_CHECKLIST.md`](./DEVICE_VERIFICATION_CHECKLIST.md) preserves the retired v56 preparation
  ledger. It is not executable for a replacement candidate; `DEVICE-01` owns the candidate-specific rewrite.
- [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) is the private Internal Testing
  procedure; Play/EAS/server writes still require explicit owner approval.
- [`PUBLIC_RELEASE_LICENSING.md`](./PUBLIC_RELEASE_LICENSING.md) records the private/no-public-license decision and
  the ownership, notice, distribution-terms, and approval gate required before broader distribution.

## Architecture and owned contracts

| Area | Read before changing it |
| --- | --- |
| Approved package boundaries | [`APP_STACK_ADR.md`](./APP_STACK_ADR.md), [`PHASE-DEPENDENCIES.md`](./PHASE-DEPENDENCIES.md) |
| App/server routes and events | [`APP_SERVER_PARITY.md`](./APP_SERVER_PARITY.md) |
| Frozen database-write handoff | [`DB_02A_CURRENT.md`](./DB_02A_CURRENT.md) |
| Session late results and teardown | [`REL_004_LATE_RESULT_INVENTORY.md`](./REL_004_LATE_RESULT_INVENTORY.md), [`REL_005A_TEARDOWN_INVENTORY.md`](./REL_005A_TEARDOWN_INVENTORY.md), [`SESSION_SCOPED_STATE_INVENTORY.md`](./SESSION_SCOPED_STATE_INVENTORY.md) |
| Push, headless delivery, notifications | [`PUSH_DELIVERY.md`](./PUSH_DELIVERY.md) |
| Attachment cache and downloads | [`CACHE_ARCHITECTURE.md`](./CACHE_ARCHITECTURE.md) |
| Uploads | [`UPLOAD_PROGRESS.md`](./UPLOAD_PROGRESS.md) |
| Android inbound sharing | [`SHARE_INTENT_RELIABILITY.md`](./SHARE_INTENT_RELIABILITY.md) |
| RCS bridge/send behavior | [`RCS_BRIDGE_PLAN.md`](./RCS_BRIDGE_PLAN.md), [`RCS_SEND_RELIABILITY.md`](./RCS_SEND_RELIABILITY.md), [`RCS_FORWARD_RECONCILE_PLAN.md`](./RCS_FORWARD_RECONCILE_PLAN.md) |
| UGC/public-track safety | [`UGC_SAFETY_CONTRACT.md`](./UGC_SAFETY_CONTRACT.md) |

## Workstream implementation specs

These files own stable design and sequencing. Mutable task status, dependencies, blockers, acceptance, and evidence
remain only in the master work plan.

| Workstream | Stable implementation spec |
| --- | --- |
| A | [`Baseline and immediate containment`](./workstreams/A_BASELINE_AND_CONTAINMENT.md) |
| B | [`Network and WebView trust`](./workstreams/B_NETWORK_AND_WEBVIEW.md) |
| C | [`SDK/native foundation and bounded files`](./workstreams/C_NATIVE_FOUNDATION_AND_FILES.md) |
| D | [`Cold/headless and realtime reliability`](./workstreams/D_HEADLESS_AND_REALTIME.md) |
| E | [`Session isolation and notifications`](./workstreams/E_SESSION_AND_NOTIFICATIONS.md) |
| F | [`Privacy, policy, and release truth`](./workstreams/F_PRIVACY_POLICY_AND_RELEASE_TRUTH.md) |
| G | [`Database ownership`](./workstreams/G_DATABASE_OWNERSHIP.md) |
| H | [`UI, theme, and accessibility`](./workstreams/H_UI_THEME_AND_ACCESSIBILITY.md) |
| I | [`Recovery, scale, and backup`](./workstreams/I_RECOVERY_SCALE_AND_BACKUP.md) |
| J | [`Package ownership and Android fit`](./workstreams/J_PACKAGE_AND_ANDROID_FIT.md) |
| K | [`Architecture and documentation`](./workstreams/K_ARCHITECTURE_AND_DOCUMENTATION.md) |
| L | [`Product breadth`](./workstreams/L_PRODUCT_BREADTH.md) |
| M | [`Candidate and release`](./workstreams/M_CANDIDATE_AND_RELEASE.md) |

## Focused research and historical verification design

- [`SPIKES.md`](./SPIKES.md) — native/device proof goals and recorded spikes.
- [`COMPONENT_TESTING_PLAN.md`](./COMPONENT_TESTING_PLAN.md) and
  [`UI_COVERAGE_70_PLAN.md`](./UI_COVERAGE_70_PLAN.md) — completed historical UI-test rollout plans. Current
  coverage-hardening status belongs to `TEST-01` in the work plan.
- [`IMESSAGE_ACCOUNT_PLAN.md`](./IMESSAGE_ACCOUNT_PLAN.md) — iMessage account contract/design record.
- [`FINDMY_DECRYPTION_PLAN.md`](./FINDMY_DECRYPTION_PLAN.md) and
  [`FINDMY_KEY_EXTRACTION.md`](./FINDMY_KEY_EXTRACTION.md) — Find My crypto/key research.

## Historical evidence policy

Dated plans, audits, comparisons, transcripts, and completed inventories are retained for provenance; they do not
override the work plan. In particular, [`WORK_PLAN_2026-07-17.md`](./WORK_PLAN_2026-07-17.md),
[`DB_WRITE_SAFETY_AUDIT_2026-07-25.md`](./DB_WRITE_SAFETY_AUDIT_2026-07-25.md), and the root audit/roadmap files are
historical evidence. Read their retirement/evidence headers before relying on a claim, and confirm mutable facts in
source or the current owning document.

Do not copy task status into this index. Add a stable subsystem reference here only when contributors must discover it
before editing that area; keep transient evidence and detailed history in the owning document.
