# Workstream B — network and WebView trust boundaries

> **Document role:** This file owns stable implementation design and sequencing for Workstream B.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

Workstream B treats URLs, DNS answers, redirects, embedded documents, server-rotation instructions,
and certificate policy as separate attacker-controlled boundaries. Validation must happen before
network contact, persistence, credential use, navigation, or native permission grants.

<a id="net-01"></a>

## `NET-01` — bounded, private-network-safe previews

Keep automatic preview fetching disabled through `NET-00` unless this pipeline is intentionally
restored. Implement restoration as four separate slices rather than one large change:

1. `NET-01A` decides the transport or proxy boundary and records its threat model.
2. `NET-01B` canonicalizes URLs and enforces DNS, resolved-address, and redirect policy.
3. `NET-01C` streams bounded HTML and images with time, decompressed-byte, and content-type limits.
4. `NET-01D` exercises the complete policy on Android against adversarial servers.

The same public-address rules apply to the initial URL, every DNS answer, every redirect, and every
preview image. The transport must connect to the exact address that passed validation so a later DNS
resolution cannot substitute a private or reserved address. Inspect redirects before requesting
them, cap decompressed data before whole-body allocation, leave no partial state after cancellation,
and never attach Gator credentials. React Native fetch behavior that automatically follows redirects
is not an adequate trust boundary.

<a id="web-01"></a>

## `WEB-01` — inert Find My data in generated documents

When serializing data into generated HTML, escape `<` so a value cannot close its script element.
Construct marker and popup labels with DOM `textContent`, never by interpolating an HTML string.
Treat names, punctuation, emoji, and Unicode separators as untrusted document data.

<a id="web-02"></a>

## `WEB-02` — bundled map code and constrained navigation

After `WEB-01`, bundle a reviewed Leaflet JavaScript and CSS asset and record its version, hash, and
license. Apply a restrictive content security policy; narrow the origin allowlist; deny file and
content access, mixed content, popups, new windows, remote executable subframes, and arbitrary
top-level navigation. Enumerate any tile-image hosts and expose no unnecessary native bridge.

Exact coordinates must never be available to remotely downloaded executable JavaScript. The map
must still load its bundled code when the network is unavailable.

<a id="web-03"></a>

## `WEB-03` — attribution and tile privacy

After `WEB-02`, show visible OpenStreetMap contributor attribution and explain that a tile provider
can observe the device IP and requested map region. Where the selected stack permits it, send stable
app-identifying headers and honor response caching; otherwise establish a bounded cache policy. Do
not bulk-download or prefetch public tiles, and define behavior for provider throttling or outage.
Redacted mode must instantiate neither the map nor a tile request.

If public-tile policy cannot be satisfied reliably, select a managed provider instead of weakening
the privacy or attribution contract.

<a id="face-01"></a>

## `FACE-01` — FaceTime WebView policy

Reuse the `WEB-02` navigation primitives for any embedded FaceTime path. Enumerate exact required
Apple HTTPS origins without a broad wildcard, and block or externally open every other destination.
Compare the requesting origin before each camera or microphone grant, and deny popups and new
windows. A prior Android permission grant must never become media access for an attacker-controlled
origin.

<a id="rt-01a"></a>

## `RT-01A` — client containment for server rotation

Use setup's canonical origin validator for every `new-server` instruction. Accept HTTPS origins by
default; reject credentials, path, query, fragment, downgrade, and silent foreign-host tricks before
the candidate can be contacted, persisted, or receive credentials. Keep proposals ephemeral and
outside SQLite until approval.

A proposal may be presented only for the same foreground, unlocked, connected account on its
expected origin. Foreign-host approval requires freshly entered credentials, and cleartext requires
its own explicit consent. Validate before the exclusive, session-epoch-guarded vault commit and
socket replacement. The existing socket may retry only its already approved origin, and rejected
instructions cause neither network contact nor persistence.

This task owns rotation validation and persistence. Any lifecycle task that applies the rotation
must await that owner rather than duplicating policy.

<a id="rt-01b"></a>

## `RT-01B` — signed server-rotation protocol

After client-side containment, a cross-repository protocol may version and sign rotation
instructions. Bind the old and new origins, expiry, and account identity; define replay rejection and
key rotation; and migrate client and server without an unsigned downgrade path. Cross-language
vectors must define the wire contract before rollout.

This cryptographic protocol strengthens authenticated rotation but does not replace `RT-01A`'s local
validation, consent, or session fencing.

<a id="tls-00"></a>

## `TLS-00` — centralized cleartext policy

Android's static Network Security Config cannot safely express arbitrary user-entered origins.
Choose one explicit product model:

- permit cleartext at the OS layer but enforce one centralized, per-origin runtime consent gate; or
- restrict supported origins or build variants so the static policy is sufficient.

Whichever model is selected must cover REST, sockets, uploads, downloads, retries, setup, and server
rotation. Authenticated or private cleartext content must never load in a WebView.

<a id="tls-01a"></a>

## `TLS-01A` — ordinary OS TLS without dormant pinning

For the removal branch, delete dormant pinning UI, APIs, dependencies, initialization, and claims.
Describe the resulting security boundary accurately as ordinary operating-system TLS; no user-facing
copy may imply that inactive certificate pins provide protection.

<a id="tls-01b"></a>

## `TLS-01B` — optional fail-closed pinning

If stable origins and operational ownership justify pinning, implement it only after `TLS-00`.
Initialization failure, missing or malformed state, and pin mismatch must all fail closed across
every authenticated transport. Use exact-host primary and backup pins, support safe certificate
rotation, expose truthful status, and prevent server rotation from escaping the policy.

`TLS-01A` and `TLS-01B` are alternative product branches; do not retain the appearance of pinning
without its fail-closed transport enforcement.

<a id="tls-02"></a>

## `TLS-02` — deliberate user-installed CA trust

Decide separately whether production supports certificates chaining to Android's user trust store.
If supported, generate a reviewed `src="user"` trust anchor, explain the device-wide interception
trade-off, and apply the policy to every authenticated transport. If unsupported, document the
server constraint and remove contrary claims. Neither branch permits blanket acceptance of an
arbitrary self-signed leaf.

## Sequencing contract

1. Keep `NET-00` containment in force while `NET-01A..D` are designed and implemented.
2. For an embedded map, apply `WEB-01`, then `WEB-02`, then `WEB-03`; do not re-enable the path with
   only part of that chain. `FACE-01` reuses the completed navigation boundary.
3. Complete `RT-01A` client containment before relying on lifecycle application or considering the
   cross-repository `RT-01B` protocol.
4. Decide `TLS-00` before selecting the `TLS-01A` removal branch or the `TLS-01B` fail-closed branch;
   make the independent `TLS-02` user-CA policy explicit for the same transport set.
