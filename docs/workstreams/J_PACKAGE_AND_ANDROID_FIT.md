# Workstream J — package ownership and Android fit

> **Document role:** This file owns stable implementation design and sequencing for Workstream J.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="share-01"></a>

## `SHARE-01` — fail-closed inbound-share removal

Remove the third-party share-intent package, native binding/provider, inbound manifest filters, Direct
Share declaration, and account-derived shortcut publication from the shippable graph. Preserve the
historical failure record and retain only one-way cleanup of shortcuts published by older versions.

<a id="share-02"></a>

## `SHARE-02` — optional owned Android share intake

If inbound sharing is selected again, use one owned native ACTION_SEND/Direct Share boundary. Reject
item count before provider reads; enforce per-file, aggregate-byte, and deadline limits while streaming;
cancel on every bound; restat and atomically promote only a complete batch; remove partials on failure
or restart; and preserve lock/root/direct-target routing without restoring third-party parser coupling.

<a id="notify-pkg-01"></a>

## `NOTIFY-PKG-01` — owned notification adapter

Only one native adapter may import notify-kit. Permission, channels, actions, cold/headless routing,
full-screen behavior, scheduling, and cancellation consume that owned surface. Record upstream health
and replacement criteria so a native package change does not spread through UI and services.

<a id="deps-02"></a>

## `DEPS-02` — direct dependency ownership

Trace each apparent direct dependency through source imports, peers, Router behavior, config plugins,
assets/fonts, and native integration. Keep an explicit owner and reason or remove it through an isolated
compatibility change; never delete a package solely because a shallow unused-dependency scan misses its
native or configuration owner.

<a id="ota-01a"></a>

## `OTA-01A` — native-build-only truth

When `expo-updates` is absent, omit EAS update channels and runtime configuration and state clearly that
every release requires a native build. Operators must not infer that an inert channel field provides an
OTA delivery or rollback path.

<a id="ota-01b"></a>

## `OTA-01B` — optional version-safe OTA delivery

If selected, install and configure the update runtime deliberately. Define a native-compatible runtime
version policy, environment/channel ownership, update signing, staged delivery, rollback limitations,
and an operator halt path; incompatible native builds must never receive the update.

<a id="release-01"></a>

## `RELEASE-01` — failure-safe release phases

Separate preflight, isolated version preparation, local build, artifact validation, source/artifact
promotion, and submission. A failed or interrupted phase must not churn the shared checkout or silently
retry a version-consuming operation. Every artifact maps to its source commit, version/code, environment,
hash, certificate, and durable phase receipt; submission remains a separate explicit confirmation.

<a id="android-01"></a>

## `ANDROID-01` — ABI policy

Always retain x86_64 in development and preview for emulator use. Choose production ABIs from Play
device-catalog coverage and an explicit support target, document excluded devices, and reject accidental
ABI expansion or contraction in profile configuration.

<a id="android-02"></a>

## `ANDROID-02` — predictive Back

Adopt the current Android Back contract across stacks, sheets, the Composer, chat selection, and any
reachable WebView. The preview must match its destination; local UI modes unwind in a deterministic
order, and unsaved non-durable work requires an explicit discard while database-backed drafts remain
authoritative.

<a id="android-03a"></a>

## `ANDROID-03A` — truthful phone/portrait scope

Keep configuration, Play device targeting, store copy, and layout claims aligned with the current
phone/portrait product. Record intentional catalog exclusions and remove ambiguous claims of adaptive,
tablet, foldable, landscape, resize, or multiwindow support.

<a id="android-03b"></a>

## `ANDROID-03B` — optional adaptive layouts

If broader form factors are selected, define supported breakpoints, orientations, resizing, and
multiwindow behavior. Composer, lists, dialogs, media, keyboard/insets, and navigation must remain
usable across the selected tablet/foldable/landscape matrix before those devices are advertised.
