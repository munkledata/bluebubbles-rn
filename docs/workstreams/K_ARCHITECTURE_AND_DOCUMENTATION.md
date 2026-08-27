# Workstream K — enforced architecture and usable documentation

> **Document role:** This file owns stable implementation design and sequencing for Workstream K.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="rel-011"></a>

## `REL-011` — dependency boundaries and explicit composition

Implement this boundary in four independently reviewable slices:

1. `REL-011A` enforces platform-free core and restricted layer imports.
2. `REL-011B` removes service-to-UI effects so services return typed outcomes and the mounted UI
   owns presentation.
3. `REL-011C` routes UI commands through services while allowing reactive UI reads.
4. `REL-011D` makes initialization, headless registration, and native composition explicit.

The services barrel must not acquire hidden evaluation effects. Headless registrations remain
explicit in `index.js`, and command ownership must remain visible rather than moving database access
behind an unreviewable facade.

<a id="rel-012"></a>

## `REL-012` — cohesive module boundaries

Split oversized chat, message, outgoing, sync, route, and Composer modules incrementally by use case.
Prefer narrow query modules, command owners, lifecycle hooks, and UI components while preserving the
existing public API and visible transaction ownership. Each extraction is a move, not permission for
a simultaneous behavior rewrite.

Sequence this work after the relevant DB ownership and `REL-011` boundary have settled so a file move
cannot hide an unresolved transaction or introduce a dependency cycle.

<a id="docs-01"></a>

## `DOCS-01` — one maintainable hierarchy

Documentation has four distinct roles:

- The master work plan is the only authority for status, owners, dependencies, blockers, acceptance,
  and completion evidence.
- Root `README.md` and `AGENTS.md` provide the current overview and stable editing rules without
  copying task status.
- Subsystem documents own durable technical contracts, runbooks, and rationale.
- Dated plans, audits, comparisons, and incident narratives remain available as clearly marked
  historical evidence.

Move stable implementation design out of the master plan one workstream at a time. Each extracted
spec must link back to the master tracker and must not copy mutable status or evidence. Archive useful
history instead of silently deleting it, and keep release/device identity claims explicit about the
candidate to which they apply.

<a id="parity-01"></a>

## `PARITY-01` — authoritative mismatch dispositions

Every open app/server mismatch must map to exactly one of:

- an existing primary work-plan task;
- a newly accepted implementation task; or
- an explicit owner-approved `DEFER` or `DROP` decision.

Keep per-address contact lookup and contact-card sending distinct from bulk contacts/handle bootstrap.
Treat macOS permission diagnostics, push-device administration, group-icon behavior, scheduled-message
updates, and low-value admin/webhook/VAPID surfaces as separate product decisions rather than silently
turning protocol discovery into a feature commitment.

<a id="pkg-keep-01"></a>

## `PKG-KEEP-01` — approved stack decisions

The stack ADR must cover op-sqlite/SQLCipher/FTS, Drizzle, FlashList, Zod, TanStack Query, Zustand,
Socket.IO, Firebase, and the Expo media/file family. For each boundary it records the production owner,
why it is retained, the evidence that would justify replacement, and the minimum proof required before
a migration.
