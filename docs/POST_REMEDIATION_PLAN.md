# Post-remediation plan

> **Status:** DEFERRED — start only after the active remediation plan is complete unless the product
> owner explicitly moves an item back.
>
> **Authority:** This document owns product work deliberately moved outside or explicitly deferred
> [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md). Its items are not included in the 107-task
> remediation count or the four-task release count and do not become release requirements merely by
> being recorded here.

This plan keeps postponed product and security work visible without treating a scope transfer as
finished remediation work.

## Deferred items

- **DEFERRED — 4:** `POST-FACE-01`, `POST-RT-01B`, `POST-TLS-01B`, `POST-TLS-02`.

<a id="post-face-01"></a>

### [ ] `POST-FACE-01` — Reconsider an embedded FaceTime experience

- **Former remediation ID:** `FACE-01`; moved here by the product owner on 2026-09-14 because the
  embedded experience never worked reliably.
- **Current behavior to keep:** Gator creates and validates FaceTime links, presents incoming calls,
  supports Answer/Decline, and hands a validated Apple FaceTime link to a system-owned handler or
  browser. Gator does not mount a FaceTime WebView or own media-permission prompts for that external
  surface.
- **Historical design reference:** [`FACE-01`](./workstreams/B_NETWORK_AND_WEBVIEW.md#face-01).
- **Start condition:** Active remediation is complete and the product owner explicitly chooses to
  design a new embedded experience. Do not restore the deleted implementation by default.
- **Acceptance if selected:** Calling works reliably while only exact required Apple HTTPS origins
  can receive camera or microphone access. Foreign navigation, redirects, links, popups, new
  windows, and media requests fail closed or leave Gator through an explicit safe handoff.
- **Verification if selected:** Add focused navigation and permission tests, then use a physical
  Android device with camera/microphone already granted to exercise normal calls and hostile origins.
  Host mocks alone cannot prove native WebView or media-permission behavior.
- **Non-goal:** Moving the item here does not claim that the old embedded path passed, authorize a
  WebView dependency, or weaken the current external-browser containment.

<a id="post-rt-01b"></a>

### [ ] `POST-RT-01B` — Add authenticated signed server rotation

- **Former remediation ID:** `RT-01B`; moved here by the product owner on 2026-09-14 because it is a
  cross-repository enhancement rather than unfinished client containment.
- **Current behavior to keep:** Completed `RT-01A` rejects malformed and downgrade instructions
  before contact or persistence. An eligible foreign server requires the app to be foregrounded and
  unlocked, a fresh password, explicit cleartext consent when applicable, and successful candidate
  validation before an exclusive session-guarded commit.
- **Historical design reference:** [`RT-01B`](./workstreams/B_NETWORK_AND_WEBVIEW.md#rt-01b).
- **Start condition:** App and server owners jointly select a versioned wire format, initial trust
  binding, signing-key ownership, rotation/revocation procedure, and backward-compatible rollout.
- **Acceptance if selected:** The signed instruction binds the old and new origins, account/server
  identity, issue and expiry times, a replay-resistant identifier, and a key id. The app verifies it
  before any candidate contact or persistence, rejects tampering/replay/expiry, and never falls back
  from signed to unsigned rotation silently.
- **Verification if selected:** Share exact vectors across both repositories; test valid, malformed,
  tampered, replayed, expired, revoked-key, and mixed-version cases; then complete a staged old/new
  app-server rollout without weakening `RT-01A`.
- **Non-goal:** This future automation does not replace local URL validation, foreground consent,
  account/session fencing, or the safe behavior already provided by `RT-01A`.

<a id="post-tls-01b"></a>

### [ ] `POST-TLS-01B` — Reconsider complete fail-closed certificate pinning

- **Former remediation ID:** `TLS-01B`; moved here by the product owner on 2026-09-14 because ordinary
  Android HTTPS is the selected current product boundary.
- **Current behavior to keep:** Completed `TLS-01A` uses Android's normal certificate and hostname
  validation, contains no bad-certificate bypass, and makes no certificate-pinning claim.
- **Historical design reference:** [`TLS-01B`](./workstreams/B_NETWORK_AND_WEBVIEW.md#tls-01b).
- **Start condition:** Supported server origins are stable and named owners can provision, monitor,
  rotate, recover, and revoke both primary and backup pins without stranding users.
- **Acceptance if selected:** Initialization failure, missing/malformed pin state, and pin mismatch
  fail closed across REST, sockets, uploads, downloads, setup, retries, and server rotation. Exact
  host binding and backup-pin certificate rotation work without a bypass.
- **Verification if selected:** Test initialization, primary/backup matching, mismatch, expiration,
  rotation, recovery, and every authenticated transport; then prove ordinary and rotation behavior
  on a physical Android device.
- **Non-goal:** Recording future pinning does not weaken Android HTTPS validation or imply that the
  current app is pinned. It also does not replace `TLS-00` downgrade and cleartext containment.

<a id="post-tls-02"></a>

### [ ] `POST-TLS-02` — Reconsider user-installed certificate authorities

- **Related completed remediation ID:** `TLS-02`; the owner selected system CAs only on 2026-09-15.
  This is a possible future feature, not moved or unfinished remediation work.
- **Current behavior to keep:** HTTPS trusts Android's built-in system certificate authorities.
  Authorities added in Android Settings, arbitrary self-signed leaves, custom trust managers, and
  certificate-validation bypasses are unsupported. Separately consented HTTP remains governed by
  completed `TLS-00`.
- **Start condition:** Active remediation is complete and the product owner explicitly chooses
  private-CA compatibility after accepting the device-wide interception trade-off.
- **Acceptance if selected:** Add only the reviewed Android user trust store as an explicit trust
  anchor and describe the interception consequence in product copy. Apply the same behavior to
  setup, REST, sockets, uploads, downloads, retries, and server rotation without accepting a bare
  self-signed leaf or weakening `TLS-00`.
- **Verification if selected:** On a disposable Android target, prove a system CA and an installed
  user CA across every authenticated transport, prove a bare self-signed leaf still fails before
  HTTP, and exercise CA removal plus the platform's available revocation/blocklist behavior. Repeat
  the selected boundary on the exact release candidate.
- **Non-goal:** Recording this option does not authorize user-CA support now or imply that Android
  provides universal online revocation checking for every accepted certificate.
