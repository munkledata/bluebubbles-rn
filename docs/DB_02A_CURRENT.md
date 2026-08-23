# DB-02A final handoff

`DB-02A` is complete. This short file records the frozen result; the Work Plan and Audit Report remain
the authoritative project documents.

## Frozen result — 2026-08-21

- Inventory: 1,300 exact findings
- Proved: 1,300 (971 coordinated + 329 temporal)
- Unproven: 0
- Structural/membership errors: 0
- Nested coordinators: 0
- Reconciliation: 0 line shifts / 0 rekeys / 0 additions
- Final child: `DB-02A-DRIVER-ADAPTER-PROOF` — DONE, 5 findings
- DB-01B refresh: 13 additional disposable-driver findings, all exact throwaway temporal exclusions
- DB-03A refresh: three obsolete ad-hoc writes retired, one replacement production-schema
  `handles`-fixture metadata carry, and 27 V2 additions; net +24 exact throwaway temporal exclusions
- DB-03B1 refresh: 17 fixed-database writes and 12 exclusive DEV boot/state-machine handoffs; all 29
  are exact throwaway temporal exclusions
- DB-03B2A refresh: 39 fixed-database repository-history writes/calls, all exact throwaway temporal
  exclusions
- DB-03B2B1 refresh: 33 fixed-database active-WAL writes and 13 exclusive DEV boot/state-machine
  handoffs; all 46 are exact throwaway temporal exclusions
- DB-03B2B2 refresh: 34 fixed-database active-migration writes and 15 exclusive DEV boot/state-machine
  handoffs; all 49 are exact throwaway temporal exclusions
- Verification: exact scanner certificate 4/4; hostile matrix 17 cases; fast scanner 84 pass / 10
  skip; full scanner 94/94; focused active-migration tests 3 suites / 70 tests; host harness 36/36;
  Android API-35 active-migration contract 32/32; TypeScript and lint pass; architecture 30/30;
  migrations 5/5 over 38 migrations at head `0038`; pinned Node 24.19.0 full Jest under `caffeinate`
  with `--runInBand --no-cache` passes 407/407 suites / 4,520/4,520 tests / 0 snapshots. Its raw
  2,519.353s duration is host-clock contaminated and is not performance evidence.

## What this closure means

Every detected database write has either a proved coordinator or a proved startup/throwaway temporal
exclusion. The final adapter certificate covers the private `opRunner` methods, their exact production
startup caller and certified disposable migration calls across the V3 and relaunch contracts, plus
the three private Drizzle Proxy methods; it fails closed when a raw database client or method escapes.
DB-01B replaced the earlier tiny
rekey self-test with an exactly certified disposable-driver contract, and DB-03A extends that same fixed
throwaway file through the current production migration registry. DB-03B1 uses a separate fixed file
and an exclusive DEV boot claim for its process boundary. The extra findings do not weaken or broaden
ownership of the production database. DB-03B2A adds a second fixed file for the reviewed repository
heads `0024` and `0027`; its private history helper has one certified caller and no production handle.
DB-03B2B1 adds a third fixed file plus scenario-specific markers inside the same exclusive DEV
dispatcher. Its private key, handles, SQL helpers, and cleanup path do not escape to production code.
DB-03B2B2 adds a fourth fixed file and its own scenario-specific markers inside that dispatcher. Its
private exact-SQL migration wrapper, fixed key, handles, fixture helpers, and cleanup path likewise do
not escape to production code.

This is host proof of write ownership, not proof of native database behavior. Continue with `DB-01`
and Android/device verification. DB-03A now supplies API-35 emulator evidence that the exact current
production runner applies `0001`–`0029`, rolls back a deliberately failed `0030`, then retries
`0030`–`0038` over one audited head-`0029` fixture on a same-process reopened disposable file.
DB-03B1 adds a controlled force-stop/relaunch: process A retains the encrypted handle at READY; after
the no-process gap, distinct process B verifies the preserved head-`0029` state read-only before any
read-write reopen and exact `0030`–`0038` retry. DB-03B2A V3 constructs encrypted logical fixtures at
the reviewed repository heads `0024` and `0027`, closes them, rejects the wrong key, verifies them
read-only, and applies their exact tails through `0038`; its `historicalReadOnly` result covers those
two heads. The existing `0029` upgrade is DB-03A, while `0029` read-only/process continuity remains
DB-03B1. DB-03B2B1 proves a separate controlled ordinary active-WAL crash: A commits a baseline,
checkpoints, leaves a bounded write transaction and encrypted handle open, and emits READY; after the
host observes physical WAL growth and crashes that exact process, distinct B first proves the exact
baseline-only state read-only, then commits and reopens a recovery row and cleans the fixed database,
journal, WAL, SHM, and markers. DB-03B2B2 proves a separate controlled active-migration crash on a
fourth fixed disposable file: A prepares exact head `0037` and an exact 133-row fixture, then pauses
only after the exact production `0038` `UPDATE` resolves inside its still-open transaction while the
ledger remains at `0037` and before the runner can issue its ledger insert or commit. After the host
proves WAL beyond its header before and after crashing exact A, distinct B first proves the exact
head-`0037` original state read-only, then retries exact `[0038]`, verifies the head-`0038` data and
persistence, and cleans all eight fixed paths. This is not statement-in-flight evidence. Parent
DB-03B2B/DB-03B remains open for power-loss/torn-write recovery, actual historical signed/store
artifacts, spontaneous or uncontrolled death, production `gator.db`, scheduled CI, and exact
release-candidate/physical-device behavior.
