# Workstream B — network and WebView trust boundaries

> **Document role:** This file owns stable implementation design and sequencing for Workstream B.
> It never owns task status, dates, owners, blockers, or completion evidence. Active remediation
> status remains in [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md); explicitly deferred
> future product status remains in [`POST_REMEDIATION_PLAN.md`](../POST_REMEDIATION_PLAN.md).

Workstream B treats URLs, DNS answers, redirects, embedded documents, server-rotation instructions,
and certificate policy as separate attacker-controlled boundaries. Validation must happen before
network contact, persistence, credential use, navigation, or native permission grants.

<a id="net-01"></a>

## `NET-01` — bounded, private-network-safe previews

`NET-00` removes the client HTML fetch/parser. Server-supplied `payloadData` and exact-key
legacy-cache text may render because neither path contacts the link host; neither is an
implementation of this task. The selected product behavior automatically loads preview text and an
optional preview image exclusively through an authenticated, hardened Gator-server proxy. The app
uses its existing `HttpClient` boundary to contact only its configured Gator server. It never opens
a socket or HTTP connection to the submitted link, redirect, or image host, and it never mounts a
remote preview-image URL.

Implement the selected design as four separate slices rather than one large change:

1. `NET-01A` freezes the authenticated app/server API, threat model, response schema, and ownership
   boundaries. There is no direct-client or native-fetch fallback.
2. `NET-01B` builds the server-side outbound policy: canonicalize the initial URL, reject unsafe
   schemes and credentials, validate every DNS answer, connect to the exact public address that was
   validated, and repeat those checks before every redirect and preview-image request.
3. `NET-01C` streams HTML and image bodies with explicit redirect, content-type, compressed- and
   decompressed-byte, per-hop time, total-time, and image-dimension limits. Bound server-side
   per-source/global concurrency and duplicate work. The selected privacy policy retains no server
   result cache: its positive entries, negative entries, retained bytes, and retained age are all
   bounded at zero. In-flight coalescing retains only a shared promise until settlement;
   cancellation or failure removes temporary state.
4. `NET-01D` adds automatic app loading with bounded per-account/global concurrency, duplicate-request
   coalescing, and bounded positive/negative caches by entry count, total bytes, and age. Image bytes
   arrive through the authenticated proxy, settle into app-private bounded storage, and render only
   from a controlled data URI. Exercise the complete policy on Android against adversarial servers.

The same public-address rules apply to the initial URL, every DNS answer, every redirect, and every
preview image. The server transport must connect to the exact address that passed validation so a
later DNS resolution cannot substitute a private or reserved address. Redirects are inspected before
the next request, decompressed data is capped before whole-body allocation, and neither Gator
credentials nor private response data may be forwarded to a link host. Automatic rendering must not
turn a conversation containing many URLs into unbounded work. React Native fetch behavior that
automatically follows redirects is not a trust boundary and is not used for preview retrieval.

<a id="web-01"></a>

## `WEB-01` — inert Find My data in generated documents

The selected implementation uses native Google Maps markers and creates no generated HTML or script
document. Treat names, punctuation, emoji, and Unicode separators as untrusted native-bridge data:
bound marker count and label length, pass labels only as native text properties, and never introduce
HTML interpolation. The production WebView import guard remains in place.

<a id="web-02"></a>

## `WEB-02` — bundled map code and constrained navigation

The selected implementation is `react-native-maps` backed by the native Google Maps Android SDK. It
contains no generated document, WebView, remote executable JavaScript, top-level navigation, popup,
file/content origin, or app-authenticated network bridge. Disable Google's map toolbar, place
selection, phone-location layer, traffic, and other unused surfaces. Only bounded coordinates and
text labels cross the native marker bridge. Keep the existing production guard that rejects
community WebView and Expo DOM WebView imports.

Configure a dedicated Google Maps API key through build environment only. Restrict it to the Gator
Android package, reviewed debug/upload/Play signing certificates, and Maps SDK for Android. Every
EAS build fails before native generation if the controlled key is absent. A native rebuild is
required; this feature must never ship as an OTA-only JavaScript update to an older binary.

<a id="web-03"></a>

## `WEB-03` — attribution and tile privacy

Keep the Google Maps logo and provider attribution rendered by the native SDK visible and
unobscured. The app performs no tile prefetch, bulk download, scraping, provider-content caching, or
place-data persistence. The location list and explicit system-Maps action remain usable if native
map rendering is unavailable.

Explain in-app and in release/privacy materials that Google Maps can receive the server-provided
precise coordinates, phone IP, requested map region, device/request metadata, a Maps-specific
pseudonymous identifier, crash information, and map interactions such as panning and zooming. Gator
does not request the phone's own location.
Instantiate no map while the route is unfocused, Android is backgrounded, App Lock withholds the
protected tree, no valid marker exists, or the account has been torn down.

<a id="face-01"></a>

## `FACE-01` / `POST-FACE-01` — deferred FaceTime WebView policy

`FACE-01` left the active remediation inventory on 2026-09-14 because the embedded experience never
worked reliably. [`POST-FACE-01`](../POST_REMEDIATION_PLAN.md#post-face-01) is the future status
authority; the validated system-browser handoff remains the current product behavior.

If the owner later selects a new embedded design, reuse the `WEB-02` navigation primitives. Enumerate
exact required Apple HTTPS origins without a broad wildcard, and block or externally open every
other destination. Compare the requesting origin before each camera or microphone grant, and deny
popups and new windows. A prior Android permission grant must never become media access for an
attacker-controlled origin.

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

## `RT-01B` / `POST-RT-01B` — deferred signed server-rotation protocol

`RT-01B` left the active remediation inventory on 2026-09-14. Its future status is owned by
[`POST-RT-01B`](../POST_REMEDIATION_PLAN.md#post-rt-01b); completed `RT-01A` remains the current safe
containment and confirmation path.

If selected later, a cross-repository protocol may version and sign rotation instructions. Bind the
old and new origins, expiry, and account identity; define replay rejection and key rotation; and
migrate client and server without an unsigned downgrade path. Cross-language vectors must define
the wire contract before rollout.

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

## `TLS-01B` / `POST-TLS-01B` — deferred fail-closed pinning

`TLS-01B` left the active remediation inventory on 2026-09-14. Its future status is owned by
[`POST-TLS-01B`](../POST_REMEDIATION_PLAN.md#post-tls-01b); completed `TLS-01A` ordinary Android HTTPS
remains the current product boundary.

If stable origins and operational ownership later justify pinning, implement it only after `TLS-00`.
Initialization failure, missing or malformed state, and pin mismatch must all fail closed across
every authenticated transport. Use exact-host primary and backup pins, support safe certificate
rotation, expose truthful status, and prevent server rotation from escaping the policy.

Future `POST-TLS-01B` may add a complete pinning layer on top of `TLS-01A`'s ordinary Android
certificate and hostname validation; do not retain the appearance of pinning without its fail-closed
transport enforcement.

<a id="tls-02"></a>

## `TLS-02` — deliberate user-installed CA trust

Decide separately whether production supports certificates chaining to Android's user trust store.
If supported, generate a reviewed `src="user"` trust anchor, explain the device-wide interception
trade-off, and apply the policy to every authenticated transport. If unsupported, document the
server constraint and remove contrary claims. Neither branch permits blanket acceptance of an
arbitrary self-signed leaf.

## Sequencing contract

1. Keep `NET-00` containment—including the absence of a client HTML fetch/parser and remote-artwork
   mount—in force while `NET-01A..D` are designed and implemented.
2. For an embedded map, apply `WEB-01`, then `WEB-02`, then `WEB-03`; keep the selected native path
   free of every generated-document/WebView surface and complete provider privacy/device evidence.
   `POST-FACE-01` reuses only WebView-specific navigation primitives if the owner later selects that
   post-remediation path.
3. Keep completed `RT-01A` client containment in force. `POST-RT-01B` may add signed rotation only if
   the app and server owners later select the cross-repository protocol, key lifecycle, and rollout.
4. Keep completed `TLS-00` and the selected `TLS-01A` ordinary-HTTPS branch in force.
   `POST-TLS-01B` may add complete pinning on top only after stable origins and pin operations have
   owners; make the independent `TLS-02` user-CA policy explicit for the same transport set.
