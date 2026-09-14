# TLS-00 local-release untrusted-certificate proof — 2026-09-13

## Scope and boundary

This report records physical-Android evidence that normal app setup rejects a correctly named but
untrusted self-signed HTTPS certificate before an HTTP request or credential reaches the server. It
advances, but does not close,
[`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
The tested app was a locally built, nondebuggable release variant with a local development signer,
not a Play-delivered or production-signed candidate.

- Device: Samsung `SM-S938U1`, Android API 36, `arm64-v8a`.
- App: `0.1.42`, version code `1`, package `com.bluegreengatorapps.messages`.
- Source boundary: the installed release contains ordinary JSON redirect repair `ea92eca` and the
  earlier WebSocket redirect repair `78e7e96`.
- APK: `android/app/build/outputs/apk/release/app-release.apk`, 111,133,630 bytes, SHA-256
  `b31082ce3c3a83a2eca14a0a9a514679fc7d344fa0fba47e9ec2401ff9fe93b6`.
- Local signer certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- Server fixture: isolated `TestBackendHost` from clean server commit
  `ffe8a68f3a774579744b00e649f69fd6c55f4dfb`, with synthetic backup data and one disposable
  credential.
- Transient TLS fixture SHA-256:
  `5cb93f2f9d9f6697769cab9161c6fd5020fa3ce5b07eefbf431627f002e12de3`.
- Transient self-signed certificate PEM file SHA-256:
  `6fa5b38bf7d7951456513d98ae2b7cc9ddbbfbc5e8d5113447ef7b6f4a760153`.

The two-day test leaf used RSA-2048 with SHA-256, exact `IP Address:127.0.0.1` and `DNS:localhost`
subject alternative names, critical `CA:false`, and TLS Web Server Authentication usage. Its UTC
validity window was 2026-09-14 04:26:57 through 2026-09-16 04:26:57. The phone clock was
2026-09-14 04:30:29 UTC, inside that window. The certificate was not installed or trusted on the
phone.

The fixture's emitted evidence contained only aggregate TCP, completed-TLS, HTTP-request,
body-byte, Authorization-presence, and classified TLS-alert counters. It did not print the
Authorization value, HTTP body, phone identifier, or private message data. The disposable
credential necessarily existed in the transient fixture source and process until cleanup.

## Explicitly trusted Mac control

The first control accidentally supplied HTTP Basic auth. TLS and HTTP completed, but the test server
correctly returned HTTP 401 because it accepts a Bearer credential; that attempt receives no
authenticated-control credit. The corrected request used the same certificate, hostname, server
endpoint, and disposable credential in the expected Bearer form. With the one certificate supplied
explicitly as the trust anchor, it returned HTTP 200.

The cumulative pre-reset control counters were:

```text
raw_connections=2
secure_connections=2
http_requests=2
authorization_requests=2
request_body_bytes=0
tls_client_errors=0
```

The fixture was then reset and reported exact zeros in every field. This establishes that the leaf,
its IP hostname, TLS listener, and authenticated server-info endpoint were functional when the leaf
was explicitly trusted.

## Physical-phone rejection

An isolated USB reverse rule mapped phone port `1240` to the fixture. From a clean setup screen, the
release app attempted to connect to `https://127.0.0.1:1240` with the disposable credential. After
three connection attempts, the app remained on Server details and displayed:

```text
Could not reach your server. Check the URL and that it is accessible from this device.
```

The fixture's frozen result was:

```text
raw_connections=3
secure_connections=0
http_requests=0
authorization_requests=0
request_body_bytes=0
tls_client_errors=3
tls_error_kinds=[certificate-unknown-alert, certificate-unknown-alert, certificate-unknown-alert]
```

The three raw connections prove that the phone reached the intended listener. The three
certificate-specific alerts, together with zero completed TLS sessions, prove that Android rejected
the leaf during TLS. Its exact IP SAN, valid time window, and successful explicitly trusted control
isolate the rejection to the deliberately untrusted self-signed certificate. Zero HTTP and
Authorization-bearing requests prove that no credential reached the fixture's HTTP layer; they do
not claim that the app never constructed a header in memory.

## Result, limits, and cleanup

This closes the local-release explicit self-signed rejection check for the normal setup/JSON path.
It does not establish user-installed-CA or revoked-CA policy, separately repeat rejection through
every native transport, or provide exact Play-candidate evidence. Those broader policy and candidate
boundaries remain with `TLS-02`, the release checklist, and the final `TLS-00` candidate pass.

Before the proof, the disposable synthetic account was disconnected, intentionally wiping its local
messages, attachment cache, and saved test credential. The older public-CA tunnel was stopped and
the copied 13,191-byte upload image was removed from Downloads. After the proof, the USB reverse rule
was removed, the TLS fixture and isolated backend were closed, and the temporary private key,
certificate, OpenSSL configuration, fixture script, and phone screenshots were deleted. The app was
left at `Get Started` with no active account.
