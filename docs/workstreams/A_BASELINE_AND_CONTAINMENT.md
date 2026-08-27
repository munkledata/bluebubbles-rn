# Workstream A — baseline and immediate containment

> **Document role:** This file owns stable implementation design and sequencing for Workstream A.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

Workstream A establishes trustworthy engineering signals, contains the highest-risk automatic
network behavior, and makes migration allocation deterministic before later work adds schema.
Containment comes before feature restoration: a disabled unsafe path is preferable to a partially
hardened path that still runs automatically.

<a id="base-01"></a>

## `BASE-01` — deterministic automated signal

Implement the baseline in two independently reviewable slices:

1. `BASE-01A` isolates order-dependent reminder behavior and removes unexplained console and React
   update noise. Expected error logging is asserted explicitly, while unexpected console errors fail
   the run.
2. `BASE-01B` resolves or narrowly justifies lint findings and adds a formatting gate that includes
   test TSX files.

This work precedes broad remediation so later failures identify the change under review instead of
ambient flakiness. The baseline should be repeatable across consecutive runs and sensitive enough
that a deliberate source regression still fails its focused check.

<a id="net-00"></a>

## `NET-00` — immediate automatic-preview containment

Received message text must not initiate remote HTML or image traffic merely because a conversation
was opened. Until the bounded pipeline in `NET-01` is deliberately enabled, in-app preview fetching
stays disabled. An explicit user action may hand an allowed public URL to the system browser, and an
already cached preview may be displayed only when doing so causes no new preview request.

Apply this containment before designing the replacement pipeline. It is the safe default if that
larger work is deferred, interrupted, or disabled again.

<a id="mig-00"></a>

## `MIG-00` — one-time migration-head baseline

Before new schema work, reconcile the actual merged migration head against configured remotes and
visible migration branches. Retire speculative number reservations from older plans and record any
real collision in the master tracker. This baseline observes the next available position; it does
not allocate a migration itself.

The purpose is to replace distant planning reservations with the state that actually exists at the
point implementation begins.

<a id="mig-01"></a>

## `MIG-01` — merge-time migration allocation

Keep migration allocation as a standing repository rule:

1. Fetch and inspect the branches visible on configured remotes immediately before merge
   preparation.
2. Allocate the next migration number to the change being prepared, rather than reserving numbers
   for future work.
3. Record the number, name, task, branch or pull request, and preparation or merge state in the
   migration registry.
4. Require each migration to keep its schema mirror, cache-wipe behavior, name-based coverage, and
   released-schema upgrade path aligned.

Duplicate names or numbers on visible branches are merge conflicts to resolve, not something a
local registry can promise never exists on unknown forks. `MIG-00` establishes the starting point;
`MIG-01` governs every later schema change.

## Sequencing contract

1. Establish `BASE-01` before relying on broad automated results for later remediation.
2. Apply `NET-00` before any attempt to restore automatic previews.
3. Complete the one-time `MIG-00` reconciliation before the first subsequent schema change.
4. Apply `MIG-01` at merge preparation for every migration thereafter.
