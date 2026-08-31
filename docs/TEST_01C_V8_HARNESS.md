# TEST-01C — intermittent Node/V8 native-crash harness

## Purpose

This runbook owns the host-tooling investigation split from completed primary task `TEST-01`. The application,
functional Jest gate, UI coverage gate, and unsilenced React-warning gate are green. This task must not turn an
intermittent native-runtime crash into an unsupported product-code diagnosis or an evidence-free dependency upgrade.

## Frozen crash signature

The three retained child-process reports are:

- `node-2026-08-26-122252.000.ips`
- `node-2026-08-26-193927.0002.ips`
- `node-2026-08-28-192615.000.ips`

Each report directly records the same exception, instruction bytes, first twelve frames, and relevant binary UUIDs:

- macOS arm64 and Node binary UUID `5cf2f254-9668-37ee-9bae-7b6f0ece16f6`;
- main-thread `EXC_BAD_ACCESS` / `SIGSEGV` at invalid address `0xe`;
- `v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers +100` at the top of a mark-compact root scan;
- loaded-image UUID `9b2d4b32-5ffe-30d3-84ee-4c24167d29b8` for `better_sqlite3.node` plus the same `fsevents.node`
  image in all three processes.

Matching those UUIDs and image paths to the local pinned executable and installed packages identifies:

- Node 24.19.0 / V8 13.6.233.17-node.51;
- `better-sqlite3` 12.11.1;
- `fsevents` 2.3.3.

The plan documents four older August 4–22 incidents with matching top-frame, address, and/or pinned-binary details.
Their reports have been pruned, so their complete signatures cannot now be rechecked. Four other retained `.ips`
files are parent launchers forwarding the child signal through `node::Kill`; they are not separate V8 crashes.

This proves the immediate failure occurs while V8 scans roots. It does not prove which component first corrupted or
retained the invalid pointer. A loaded native addon is a comparison candidate, not a cause finding.

## 2026-08-31 bounded control

The exact pinned Node and installed `better-sqlite3` 12.11.1 ran:

```sh
/Users/munkle/.npm/_npx/eda9577409314edb/node_modules/node-bin-darwin-arm64/bin/node \
  --stress-compaction \
  --trace-gc \
  --trace-gc-ignore-scavenger \
  ./node_modules/jest/bin/jest.js \
  --selectProjects node \
  --runInBand \
  --no-cache
```

Result: **316/316 suites, 3,597/3,597 tests, 0 snapshots**, exit zero in **2,695.494 seconds**. No new Node diagnostic
report appeared. The stress flags are diagnostic only and must not become the normal repository test command.

This result is inconclusive because the known-current control passed. It neither resolves the intermittent crash nor
supports an addon or Node upgrade by itself.

## Bounded comparison order

Change one variable at a time in disposable archived copies with independent `node_modules`:

1. Hold Node at 24.19.0 and compare `better-sqlite3` 12.11.1 with 13.0.3. The
   [`better-sqlite3` 13 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) is relevant because
   it rewrote the addon around Node's stable N-API interface, but the known
   [upstream worker-exit crash](https://github.com/WiseLibs/better-sqlite3/issues/1476) has a different thread and
   stack.
2. Test Node 24.20.x only if the addon comparison reproduces or an exact upstream Node/V8 change matches this frozen
   signature. Do not bypass the repository's install-script guard to obtain a runtime.
3. Do not mass-edit test files merely because many tests create in-memory databases without explicit `close()` calls.
   That resource churn may amplify finalizer pressure, but it has not been shown to cause the invalid pointer.

Each stress cell is bounded to at most three attempted runs, including the current control already recorded above, and
each attempt has a 60-minute wall-clock cap. Stop on the first native crash. An attempt that does not reach complete
Jest totals within that cap is failed/incomplete, consumes one of the three attempts, and keeps its logs; do not retry
it as though it passed. Once the current cell reproduces, require three passing candidate stress runs, then two passing
ordinary Node-project runs. If the current cell passes all three without reproducing the signature, the comparison
remains inconclusive and this task stays open pending a future captured recurrence or exact upstream diagnosis.

Preserve any new `.ips` file and compare its exception address, faulting thread, top frames, Node UUID, and addon UUIDs
with the frozen signature above. Do not run comparison cells concurrently with another Jest, scanner, or build process.

## Acceptance and decision rules

A corrective candidate needs all of the following:

- the current control reproduces the frozen signature, while the one-variable candidate survives the identical
  bounded harness;
- three candidate stress runs and two ordinary candidate Node-project runs finish with identical complete totals and
  no native abort or matching report;
- one ordinary full Jest run, TypeScript, and migration checks pass after the reviewed repository change;
- dependency permissions remain least-privilege. `better-sqlite3` 13 has no install lifecycle script, so an upgrade
  removes the exact 12.11.1 allow-script entry instead of granting a replacement;
- the work plan describes the result as a bounded mitigation unless the exact corruption source is independently
  proven.

If current and candidate cells both pass, the matrix did not distinguish them. If both crash, retain the reports and
move to the Node-only axis. Never mark this task complete merely because an intermittent failure did not occur.
