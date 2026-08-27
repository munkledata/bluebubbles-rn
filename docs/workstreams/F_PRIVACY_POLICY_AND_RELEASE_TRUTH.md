# Workstream F — diagnostics, privacy, policy, and release truthfulness

> **Document role:** This file owns stable implementation design and sequencing for Workstream F.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="log-01"></a>

## `LOG-01` — privacy-safe structured diagnostics

Replace blacklist redaction with finite, allowlisted diagnostic schemas. A production error uses a
literal event name, an event-owned opaque call-site token, and only typed fields approved for that
event. Arbitrary prose, raw stacks, response bodies, causes, paths, addresses, URLs, message content,
and other untrusted metadata must be discarded before console, memory, file, database, export, or
HTTP handling.

Implement the boundary in four slices:

1. `LOG-01A` defines strict ERROR projection, including safe identifier tokenization with a keyed
   per-install/per-report HMAC or a short-lived opaque token.
2. `LOG-01B` contains the narrow set of permitted release non-error events and owns persistence,
   cleanup, export, upload, retention bounds, and account retirement.
3. `LOG-01C` installs React Native renderer containment early, hardens the persistent-file lifecycle,
   and enforces guards against raw console and known-sink bypasses.
4. `LOG-01D` owns remaining opaque crash-site tokens, finite schemas, the app/server contract fixture,
   native and pre-runtime containment decisions, cleanup-issue retirement, guard precision, and native
   proof.

Non-error free-form logging is development-only unless a release event has an explicit finite schema.
Even an approved release informational event must not automatically enter console output or the
diagnostic-report queue. Initialize runtime exception projection and persistent logging before
headless owners register. Generation-fence asynchronous persistence and cleanup so old work cannot
recreate retired data; purge pre-policy queued reports when their safety cannot be proven by shape.

The source guard must reject direct or aliased console/sink/native output and protect its own tightly
owned boundaries. JavaScript runtime containment is not proof for failures that occur before the
runtime or inside native code, so those paths retain an explicit native design and inspection step.

<a id="priv-01"></a>

## `PRIV-01` — one accurate privacy and data map

Publish a single source-backed explanation of what data stays on the device, what goes to the
self-hosted server or another provider, why each transfer occurs, how long artifacts remain, and how
the user can remove them. Cover messages, contacts, FCM, server transport, WebViews/maps, diagnostics,
attachments and ordinary files, backups, local deletion, exported copies, App Lock, and the removal
of configurable Redacted Mode.

The map must distinguish SQLCipher-protected database rows from ordinary app-private files and must
describe conditional behavior such as consent-controlled diagnostics, FCM transit, disabled automatic
previews, and external browser/maps handoff. Link the same disclosure from Settings and store
metadata. Play Data Safety answers must be derived from measured network and storage behavior rather
than from intended architecture alone.

Drafting can proceed early, but final text follows the selected network, web, realtime, TLS,
notification, diagnostics, file, and lock outcomes.

<a id="priv-02"></a>

## `PRIV-02` — user control over diagnostic reports

Use a versioned, plain-language consent value. New, missing, corrupt, legacy, and unrecognized states
fail closed; only an explicit current-version grant may enable capture or upload. Hydrate consent
before any worker can flush reports.

Disabling consent aborts in-flight upload, prevents retry, and offers or defaults to purging queued
reports. Bound the queue by bytes, items, age, and attempts, and clear account-owned reports during
Disconnect. Consent retirement and queue purge should share an atomic owner so an obsolete enabled
value cannot survive a failed migration.

This policy depends on `LOG-01`: consent cannot make an unsafe payload acceptable, and a safe logger
must not bypass consent for diagnostic network traffic.

<a id="priv-03"></a>

## `PRIV-03` — remove configurable Redacted Mode without weakening other boundaries

Remove the setting, persisted value, hydration/coordinator state, and every mode-only render or
callback branch. Execute `PRIV-03A..AC` as small surface-focused removals so each batch deletes only
Redacted Mode behavior while preserving the component's ordinary content, callbacks, accessibility,
account lease, lifecycle, and stale-result contracts.

The removal must not absorb or weaken independent protections: App Lock's generic new-delivery path,
privacy-safe diagnostics, explicit pairing-credential reveal and lifecycle revocation, account
isolation, safe URL/file handling, or generic external and error prompts. Normal notifications remain
detailed and Android owns lock-screen presentation. Historical child identifiers remain useful as
design provenance; they do not become separate long-term policy switches.

<a id="legal-01"></a>

## `LEGAL-01` — accurate project license and third-party notices

Record an explicit project license and copyright decision instead of presenting template ownership as
project ownership. Retain required Expo, React Native, Leaflet, OpenStreetMap, and other dependency
notices in the appropriate notices artifact. Repository and About links consume the same approved
license and notices source.

This decision precedes the final license/notices links in `SUPPORT-01`.

<a id="file-01a"></a>

## `FILE-01A` — truthful plaintext-file boundary

State plainly that SQLCipher protects database rows, not attachments, caches, contact images,
wallpapers, logs, temporary/share copies, exported media, or backup temporaries. For each file class,
describe Android app-private protection, cleanup timing, external-copy retention, and the limits of
best-effort deletion.

Keep product, privacy, App Lock, backup, About, and store wording aligned with an offline inventory of
those file classes. This truthful baseline comes before any optional strict file-encryption mode.

<a id="file-01b"></a>

## `FILE-01B` — optional authenticated per-file encryption

If strict file protection is selected, design authenticated per-file encryption with atomic and
crash-safe migration, temporary-plaintext cleanup, key rotation, and adapters for download, retry,
backup, open, share, and export. Every failure and restart path needs bounded cleanup without making a
partially migrated file unreadable.

Implement this only after `FILE-01A` establishes the current boundary and the product has explicitly
selected the strict mode. Its key design also precedes `LOCK-01B`.

<a id="uisec-01"></a>

## `UISEC-01` — Recents protection and independent screen capture control

When App Lock is enabled, install a generic privacy cover synchronously as the app becomes inactive or
backgrounded, before Android can capture a Recents snapshot and regardless of the lock grace delay.
Persist and apply the policy before JavaScript, reapply it across Activity recreation, cover React
Native modal windows, and do not release the older-Android fallback until the React privacy gate has
committed. Use the platform's Recents-only control where available.

Keep the two user promises independent: App Lock protects Recents while the app is protected; an
optional Secure Screen control blocks screenshots and recordings. Diagnostic consent is unrelated,
and removed Redacted Mode/Hide Preview settings must not be recreated as aliases for either control.

<a id="lock-01a"></a>

## `LOCK-01A` — current App Lock is a UI and policy gate

Describe App Lock as protection against casual foreground and screen access. It does not bind the
SQLCipher key to user authentication and does not encrypt ordinary attachments, logs, or temporary
files. Privacy, lock, store, and support copy must preserve that distinction even when Recents
protection is enabled.

<a id="lock-01b"></a>

## `LOCK-01B` — optional user-auth-bound key custody

If strict key custody is selected, close database handles and make the database key unavailable until
successful user authentication. Define fail-closed locked headless behavior or a separate minimal
ingestion key/store, and cover reboot, biometric cancellation, and key invalidation without weakening
the promise for background delivery.

This branch follows `FILE-01B` because database key custody and encrypted-file key handling must form
one coherent model.

<a id="envfile-01"></a>

## `ENVFILE-01` — prevent accidental environment-file commits

Ignore `.env`, `.env.*`, service-account files, signing material, and generated-secret filenames while
explicitly retaining a safe `.env.example`. Scan the current Git index, relevant history, and EAS
build context for forbidden filenames and high-confidence credentials. A local pre-commit hook may be
convenient, but CI owns enforcement. Do not classify public Firebase configuration as secret without
an explicit policy reason.

<a id="onboard-01"></a>

## `ONBOARD-01` — contextual permission onboarding

Reading notification status must never trigger the Android prompt. On first connection, present an
explicit optional Notifications/Contacts choice and persist completion in the account database before
routing home so a process restart resumes an unfinished choice.

Before a Settings contact sync or chat contact-share request, show Gator-authored rationale before the
system prompt. Preserve whether Android permits asking again, provide an app-settings handoff after
permanent denial, and keep manual phone/email recipient entry fully usable without Contacts access.
Grant, deny, and permanently deny paths should remain understandable without surprise-launching a
system prompt.

<a id="play-03"></a>

## `PLAY-03` — broad-contacts policy decision

Before the next applicable Play broad-contacts restriction or target deadline, reverify the current
policy and choose one truthful path: prepare the declaration explaining why broad contacts access is a
core capability, or replace broad sync with a narrower picker/minimum-scope design. Preserve manual
entry in either branch. The manifest, runtime rationale, privacy policy, store declaration, and actual
behavior must describe the same choice.

<a id="support-01"></a>

## `SUPPORT-01` — accurate About and support information

Show the installed app version and build separately from the connected server version. Link the
privacy disclosure, approved license/notices, support destination, and diagnostic controls without
implying that one version identifies the other. Final license/notices wiring follows `LEGAL-01`.

<a id="store-00"></a>

## `STORE-00` — truthful release copy and store-pack structure

Keep store copy aligned with the implemented dark-mode, SQLCipher/file-storage, App Lock, FCM,
link/map handoff, sharing, and consent-controlled diagnostics boundaries. Maintain a candidate-specific
screenshot shot list, declaration-answer matrix, and release checklist. Unresolved facts remain
explicitly pending rather than being guessed, and truthful metadata does not substitute for a separate
policy or exact-candidate release gate.

Coordinate this draft with `PRIV-01`; final candidate screenshots and console fields remain release
work rather than stable implementation design.

## Workstream sequencing

Contain diagnostic data in `LOG-01` before treating `PRIV-02` consent or `PRIV-01` disclosure as final.
Establish truthful current boundaries in `FILE-01A` and `LOCK-01A` before considering optional strict
branches `FILE-01B` and `LOCK-01B`. Resolve `LEGAL-01` before final About links, and keep the privacy
map, permission onboarding, manifest choices, contact policy, support surfaces, and store copy aligned.
Exact-candidate screenshots and final store fields remain owned by the release workstream.
