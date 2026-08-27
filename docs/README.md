# Documentation index

Start with the root [`README.md`](../README.md) for the product and architecture overview and
[`AGENTS.md`](../AGENTS.md) for rules that apply while editing the repository.

## Current status and release operations

- [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) is the **only task-status authority**. It owns task ids,
  priorities, dependencies, blockers, acceptance criteria, and completion evidence.
- [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) is the short exact-candidate operational gate. It does not replace
  the engineering backlog.
- [`DEVICE_VERIFICATION_CHECKLIST.md`](./DEVICE_VERIFICATION_CHECKLIST.md) preserves the retired v56 preparation
  ledger. It is not executable for v57; `DEVICE-01` owns the candidate-specific replacement.
- [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) is the private Internal Testing
  procedure; Play/EAS/server writes still require explicit owner approval.

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

- [`Workstream K — architecture and documentation`](./workstreams/K_ARCHITECTURE_AND_DOCUMENTATION.md) owns stable
  design and sequencing for `REL-011`, `REL-012`, `DOCS-01`, `PARITY-01`, and `PKG-KEEP-01`. Mutable task status and
  evidence remain only in the master work plan.

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
