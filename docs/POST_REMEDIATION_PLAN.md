# Post-remediation plan

> **Status:** DEFERRED — start only after the active remediation plan is complete unless the product
> owner explicitly moves an item back.
>
> **Authority:** This document owns product work deliberately moved outside
> [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md). Its items are not included in the 109-task
> remediation count or the four-task release count and do not become release requirements merely by
> being recorded here.

This plan keeps postponed product ideas visible without treating an unreliable removed feature as
finished remediation work.

## Deferred items

- **DEFERRED — 1:** `POST-FACE-01`.

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
