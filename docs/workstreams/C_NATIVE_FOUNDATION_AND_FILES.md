# Workstream C — SDK/native foundation, permissions, and bounded files

> **Document role:** This file owns stable implementation design, rationale, child-slice structure,
> and sequencing for Workstream C. It never owns task status, dates, assignees, blockers, or
> completion evidence. Status remains only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

## Foundation sequence

Establish one reproducible Expo and Android foundation before changing runtime permission or file
behavior:

1. Align the SDK patch set and remove known high-risk dependency versions.
2. Pin the toolchain, environment model, and native compatibility boundaries.
3. Make native configuration, autolinking, Kotlin compilation, and manifest policy visible in CI.
4. Reduce permissions and make Android system handoffs match the product's actual behavior.
5. Keep every download or file-intake path bounded, crash-recoverable, and consistent with the
   encrypted database.

This order prevents native-behavior work from being evaluated against a moving dependency or build
foundation.

<a id="sdk-01"></a>

## `SDK-01` — one Expo SDK 57 patch family

Align Expo, React Native, testing, and lint packages through the SDK-compatible installer after
reviewing the relevant patch changelogs. Pin Expo Doctor as a development dependency and invoke that
exact version from project scripts; CI must never obtain a future Doctor through `@latest`.

Keep this as a patch-alignment change. A major Expo, React Native, or native-library upgrade is a
separate migration so its behavioral effects remain reviewable. Native code must be regenerated
after alignment because JavaScript package compatibility alone does not prove the prebuild output or
native dependency graph.

<a id="deps-01"></a>

## `DEPS-01` — contained advisory remediation

Move vulnerable `brace-expansion` dependency paths to safe releases without forcing unrelated major
version churn. Classify each advisory path as build-time or shipped runtime, and require any retained
exception to state its reachability and exposure rationale.

Coordinate this lockfile work with `SDK-01` so two independent dependency rewrites do not obscure
which change corrected or introduced a native compatibility problem.

<a id="supply-01"></a>

## `SUPPLY-01` — dependency and workflow governance

Use scheduled dependency updates, dependency review, and audit policy to make a new advisory or
changed transitive tree visible. Document deliberate exceptions instead of silently suppressing
them, and pin every third-party GitHub Action to an immutable commit SHA.

Repository policy and CI enforcement are separate slices: first define what changes are permitted,
then make the required workflow reject dependency or action drift before merge.

<a id="env-01"></a>

## `ENV-01` — one toolchain and environment model

Local development, CI, preview, and production must use the same supported Node line and explicitly
pinned supporting tools. Select build configuration through named EAS environments rather than
overloading `NODE_ENV`, whose library semantics are not an application deployment switch.

Keep non-secret environment probes available in each lane so the resolved toolchain and intended
configuration can be compared without disclosing credentials.

<a id="pkg-01"></a>

## `PKG-01` — explicit native compatibility boundaries

Exact-pin shipped native boundaries such as op-sqlite, notify-kit, WebView, Firebase, and FlashList,
and pin Drizzle where its adapter contract requires it. The lockfile supports reproducibility but is
not the only compatibility statement; record the upgrade steps and native smoke surface for each
critical boundary.

Keep `expo-share-intent` absent unless a future, approved public share-intake design satisfies
`IPC-01`. Routine installation must not silently select a new native bridge implementation.

<a id="build-01"></a>

## `BUILD-01` — native-aware CI

Build verification must cover configuration and native output, not only TypeScript:

1. Evaluate app configuration and perform a clean Android prebuild.
2. Inspect Expo-module autolinking and compile all locally owned Kotlin modules.
3. Enforce required and forbidden manifest permissions, public-share absence, and headless
   registration expectations in merged and packaged artifacts.
4. Compile a debug Android lane suitable for catching bridge and Gradle regressions.

Each guard should have a controlled mutation that demonstrates the workflow fails when its protected
contract is broken. Runtime SQLCipher, FTS, and reactive-query semantics remain a database-runtime
concern rather than being inferred from a successful native compile.

<a id="perm-01"></a>

## `PERM-01` — least-privilege Android permissions

Maintain a permission-to-call-site-to-user-flow inventory. Block `WRITE_CONTACTS`,
`READ_MEDIA_AUDIO`, and other permissions with no approved flow through
`android.blockedPermissions`; configure media access for photo/video-only granular permissions.

Automatic background behavior may check an existing grant but must not surprise the user with a
prompt. Explicit user actions own permission requests, cancellation handling, denial guidance, and a
usable fallback. The source request, generated manifest, packaged artifact, installed declarations,
and visible Android dialog must all describe the same permission model.

<a id="play-01"></a>

## `PLAY-01` — battery-settings handoff without direct exemption

Do not request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` or promise a direct exemption dialog. When the
user asks for battery guidance, open the general Android battery-settings surface and use copy that
accurately describes that handoff.

<a id="play-02"></a>

## `PLAY-02` — truthful incoming-call notification behavior

First decide whether incoming calling is genuinely a core product function eligible for Play's
full-screen-intent declaration. If eligible, check runtime capability, explain the setting, and route
the user to it when needed. If calling is auxiliary, remove automatic reliance on the permission
where feasible.

In either case, retain an actionable heads-up notification fallback so denied or unavailable
full-screen access does not make an incoming call unusable.

The owner selected the removal branch on 2026-08-27. Durable Expo config must explicitly block
`USE_FULL_SCREEN_INTENT`, and neither generic locked nor detailed incoming-call notification may set
`fullScreenAction`. Retain high importance, call category, body tap, Answer, and Decline behavior.
Describe the notification as heads-up-capable because Android or the user can suppress heads-up
presentation through channel policy.

<a id="dl-01"></a>

## `DL-01` — bounded attachment downloads and durable cache ownership

Enforce limits against bytes actually streamed, never only `Content-Length`. Auto-download rejects an
unknown size; a manual override may proceed only within an absolute cap. A native transfer must obey
one whole-call deadline, reject redirects, cancel on byte/time limits, and clean its partial on every
failure. Re-stat before and after promotion, and write `localPath` only after the verified file is in
its final owned location.

Ordinary persistent attachments use three lifecycle slices:

1. A path-keyed encrypted ledger records charged files and retains retirement/retry state without an
   attachment foreign key.
2. Concurrent reservations, deterministic least-recently-used eviction, and an exact-root native
   delete bridge connect admission, recording, reference clearing, and retirement.
3. Coalesced access touches, startup adoption/repair, quota conformance, and user-facing recovery
   complete the lifecycle.

The ordinary cache uses fixed ceilings of 2 GiB and 4,096 files, preserves at least 512 MiB of free
space, and gives recently used files a ten-minute grace period. Active readers, current media,
duplicate references, and outgoing send/retry files are protected. If protected content alone
exceeds a ceiling, reject new downloads instead of deleting user-owned or retry-critical data.

Retirement is deliberately split across the database/native boundary: mark the ledger row retiring
and clear all database references in one short transaction, delete exactly one native-owned file
outside the transaction, and remove the ledger row only after deletion is confirmed. A failed native
delete therefore remains charged and retryable after process death.

Startup inventory must be bounded and validated completely before mutation. Support the legacy and
canonical account-generation directory layouts, reject symlinked or corrupt layouts, cap a scan at
8,192 files and 32,768 nodes, and preflight no more than 1,000 attachment references. Persistent
downloads remain closed when recovery cannot establish a trustworthy cache view, while the offline
inbox may remain usable. The bounded native inventory requires Android API 26 or newer.

Synced wallpapers use their own smaller policy: 10 MiB and 16 million pixels per file, plus a
100 MiB/256-file native quota. Keeping this separate avoids making wallpaper cleanup depend on the
ordinary attachment ledger.

<a id="ipc-01"></a>

## `IPC-01` — bounded file intake above the lock gate

Public `ACTION_SEND` and Direct Share intake remain disabled unless a newly approved design can reject
count before copying, enforce per-file and aggregate actual-byte limits, impose a whole-capture
deadline, cancel native work, and remove partial batches after failure or process death. No database
state may be created until a complete bounded capture exists.

Foreground composer paste is a separate, narrower slice and does not reactivate public sharing. Its
native receive-content boundary:

- accepts only `content://` sources;
- allows one active and one queued batch;
- limits a batch to 10 files, 128 MiB per file, 512 MiB total, and 60 seconds;
- limits its cache to 1 GiB, 32 batches, and 64 root entries;
- streams through a non-written sentinel, fsyncs and re-stats content, and atomically renames one
  `.pending` directory only after the full batch succeeds; and
- retains the provider permission token or original framework payload for the worker's lifetime.

Durable send adoption follows file ownership rather than UI lifetime: reserve an ordinary
attachment-cache destination, move the exact native-owned file, then promote the ledger entry and
insert the outgoing message, attachment, and retry row in one guarded database transaction. Legacy
batch cleanup takes one bounded, all-or-none snapshot of both attachment and outgoing-queue
references so it cannot delete a file still needed by a durable retry.
