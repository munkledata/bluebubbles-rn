# Gator RN — Gap & Security Analysis (RETIRED)

> **This document is retired.** It was a point-in-time snapshot (2026-06-20) that the code has
> since outgrown — it described FCM as disabled and the firebase/crypto/native pieces as absent,
> none of which is true anymore. Keeping a large, drifting parallel analysis around does more harm
> than good, so it has been collapsed to this pointer. The previous full text remains in git history
> (`git log -- GAP_ANALYSIS.md`).

## Where to look now

- **[`AUDIT_REPORT.md`](./AUDIT_REPORT.md)** — the current, authoritative gap / security / code-smell
  analysis (76 findings, each adversarially verified), with the P0/P1/P2 prioritization.
- **[`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md)** — the remaining build/credential steps
  (EAS, Sentry DSN, Google Maps key, server-side Firebase).

## What changed since the snapshot

The audit's prioritized recommendations have since been implemented:

- **P0** — compose/new-chat flow; link-preview SSRF guard; Firebase boot guard; app-lock key custody.
- **P1** — audio playback + voice recording + document picker (native batch); group-management UI;
  send-method (`apple-script`) fallback; encrypted-FCM handling; EventRouter logging; bearer-token
  log redaction.
- **P2** — server-side scheduled API (with on-device fallback + double-send guard); server-management
  panel; custom-theme editor; Find My location-refresh wiring; `imessage-aliases-removed` handling;
  shared `isDevServer()` + migration-timestamp fix; ESLint + CI; this retirement.

FCM is wired and compiled into the EAS dev builds; SQLCipher DB encryption, Keystore-backed
credentials, header-auth, and the libsodium AEAD backend are all active. For anything specific,
**trust the code**, then `AUDIT_REPORT.md`.
