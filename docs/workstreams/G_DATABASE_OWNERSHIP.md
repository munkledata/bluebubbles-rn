# Workstream G — database ownership and real-driver safety

> **Document role:** This file owns stable implementation design and sequencing for Workstream G.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="db-01"></a>

## `DB-01` — Drizzle/op-sqlite compatibility

Own the adapter contract and upgrade playbook for result-row shapes, raw execution, builders,
`RETURNING`, writes, rollback, and reactive-query flushing. Validate the boundary against both the
Node substitute and the actual Android SQLCipher/op-sqlite driver; package pinning and failed-open
resource cleanup remain separately owned.

<a id="db-02a"></a>

## `DB-02A` — fail-closed runtime-write inventory

Inventory every runtime mutation, name its transaction owner, and reject unapproved writes. A path is
release-safe only when it uses the serialized coordinator or has enforceable proof that it cannot
overlap a runtime transaction; an owner label by itself is not proof. The inventory must detect raw
SQL, query-builder writes, transitive wrappers, callbacks, aliases, dynamic dispatch, native SQLite
markers, and nested-coordinator construction without relying on a permissive allowlist.

<a id="db-02b"></a>

## `DB-02B` — explicit transaction-scoped primitives

Implement in two layers:

1. `DB-02B1` establishes the single serialized writer and opaque transaction-context API.
2. `DB-02B2` converts existing transaction owners and high-risk paths to transaction-only helpers.

An owner opens the transaction and passes an authenticated context to helpers that join that exact
owner. Nested coordinator entry must be structurally unavailable and fail closed at runtime; do not
substitute a module-global `inTransaction` flag, which cannot distinguish legitimate concurrent
Hermes callers.

<a id="db-02c"></a>

## `DB-02C` — writer migration and concurrency

Move unproven writers by subsystem: sync/live events, sends/retries/schedules,
contacts/settings/downloads, then exclusive maintenance and wipe/rekey. Keep two explicit modes:

- short, bounded, DB-only runtime operations; and
- exclusive maintenance that pauses new writers and chunks work where possible without weakening
  rekey atomicity.

Never hold the short-owner queue across unbounded maintenance. Any remaining exception needs an
executable temporal-exclusion contract and a named owner.

<a id="db-03"></a>

## `DB-03` — real Android database lane

Exercise the behaviors for which better-sqlite3 is not representative: encrypted open and reopen,
wrong-key rejection/recovery, additive migrations, FTS5, rollback, write-to-reactive convergence,
rekey, and process death. Keep the lane small, privacy-safe, disposable, and based on the production
migration/driver path rather than a parallel test-only implementation.

<a id="rel-005b"></a>

## `REL-005B` — final account wipe

The owned wipe removes all account database rows, queues, drafts, reminders, schedules, cached and
temporary files, historical plaintext logs, notifications/triggers, shortcuts, and session-derived
native state while preserving only documented device-global preferences. Use exclusive maintenance
and bounded cleanup, quarantine incomplete destructive tails, and do not admit account B until account
A cleanup has conclusively settled and a final sweep has run.
