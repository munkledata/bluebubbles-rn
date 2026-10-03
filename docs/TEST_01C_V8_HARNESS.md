# TEST-01C — intermittent Node/V8 native-crash harness

## Purpose

This runbook owns the host-tooling investigation split from completed primary task `TEST-01`. The application,
functional Jest gate, UI coverage gate, and unsilenced React-warning gate were green at that closure. The October 2–3
repair candidate's serialized combined retry passes; the two subsequent test-only warning fixes pass
their 30 focused tests without warnings. This task must not turn an
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

## 2026-10-02 recurrence during review remediation

The ordinary combined coverage run ended with exit 139 after 55 passing suite entries, zero failing suite entries,
and no final Jest totals or coverage report. The child report `node-2026-10-02-232457.000.ips` records main-thread
`EXC_BAD_ACCESS` / `SIGSEGV`, invalid address `0x6`, and the same
`ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers +100` root-scan stack. Node and `better_sqlite3.node` UUIDs
match the frozen binaries above; the fault address differs from the earlier `0xe` cases. The associated parent
launcher signal report is not an additional root crash. A retained local copy is
`/tmp/gator-overnight-node-crash.ips`; the partial test output is `/tmp/gator-overnight-coverage.log`.

This is an incomplete verification run, not a passing aggregate and not an assertion failure that identifies a
product regression. No Node/addon version, heap flag, or test expectation was changed in response. The next ordinary
combined run is to use the pinned Node directly, serialized after heavy build/scanner work, with a 30-minute cap.
If it also crashes, retain its diagnostics and continue through the bounded comparison rules below. A successful
ordinary retry would verify that candidate's tests but would not close this intermittent-runtime investigation.

The October 3 serialized ordinary retry completed with exit zero in **812.131 seconds**:
**534 suites / 6,602 tests passed**, with two suites and two tests skipped. All configured UI coverage
thresholds passed. The runner retained no new Node diagnostic report. Six unsilenced React timing
warnings in two component-test files are tracked separately; they are not native crashes. Evidence:
`/tmp/gator-overnight-coverage-serialized-retry.log` and its `.json` execution receipt. No Node/addon
version or heap flag changed. This passing ordinary run does not close `TEST-01C` or identify the
cause of the earlier captured crashes.

The two timing-fix suites subsequently passed **30 tests with zero warnings**. The coordinated
sync candidate then passed **538 suites / 6,670 tests** with two suites/tests skipped in **425.664
seconds**, all coverage floors met, zero React warnings, and no new Node diagnostic report. That
ordinary run overlapped the full database scanner, with the native VM initially stopped; it was not
a serialized diagnostic comparison cell. The scanner also passed all **115 tests**. The source
was then transferred from checkpoint `35c446212bd57577a39dde568243b978a222b58b` with exact byte
verification. Logs are `rn-jest-coverage-frozen-final.log` and `rn-db-full-frozen-final.log` under
`/Users/munkle/github/BB/bluebubbles-sync-evidence-2026-10-03/logs`. These ordinary passing gates
do not identify the intermittent crash's cause or close this investigation.

After the build-only libsodium architecture patch, the final root run with the native VM stopped
also passed **538 suites / 6,670 tests**, with two suites/tests skipped, in **632.838 seconds**.
All coverage floors passed, there were no React or console warnings/errors, and no new Node
diagnostic report appeared. It used pinned Node 24.19 with unchanged heap flags. Evidence:
`/tmp/gator-post-abi-host-milestone-20261003-7qdc_i4t`, completed at 10:56:35 UTC. This is another
ordinary passing gate; it does not establish a cause or close `TEST-01C`.

A bounded October 3 upstream review found no exact diagnosed match. [Node issue 65446](https://github.com/nodejs/node/issues/65446)
matches Node 24.19/Darwin arm64 but fails an addon-cleanup assertion, not this root-scan SIGSEGV.
[V8 change 40fdd170](https://chromium.googlesource.com/v8/v8/+/40fdd17031f9afbbbf788e85010f41d3d99887c8)
changes the same visitor for parallel Scavenger iteration, rather than the captured mark-compact scan;
the inspected visitor bodies in official Node 24.19.0 and 24.20.0 match. The distinct better-sqlite3
worker-shutdown issues below also do not identify this crash. Public indexing/access limits make this
a bounded negative result, not proof that no fix exists. It does not justify skipping the comparison order.

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
