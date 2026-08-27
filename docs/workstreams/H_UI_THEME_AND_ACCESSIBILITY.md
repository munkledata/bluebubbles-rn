# Workstream H — UI, theme, accessibility, and coverage

> **Document role:** This file owns stable implementation design and sequencing for Workstream H.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="ui-01"></a>

## `UI-01` — built-in contrast and sent mentions

Run every built-in foreground/background pair through the shared readability policy. Sent mentions,
filled buttons, SMS bubbles, and unread badges must select a readable foreground from the actual
rendered background instead of assuming a fixed color.

<a id="theme-01a"></a>

## `THEME-01A` — truthful dark-only product

Keep the current product explicitly dark-only until a complete light/system axis is selected. Remove
false light/system claims, drive system bars from the selected dark theme rather than OS appearance,
gate first paint on theme hydration, and keep application config and store copy aligned with the
enabled presets.

<a id="theme-01b"></a>

## `THEME-01B` — optional light/system theme axis

If selected, author an audited light preset, define light/dark/system resolution, migrate the stored
preference, and audit every screen, media surface, system bar, cold boot, and transition. Changing a
Theme Studio mode must seed mode-appropriate tokens rather than relabel the existing colors.

<a id="theme-02"></a>

## `THEME-02` — Theme Studio contrast safety

Validate contrast rather than only hexadecimal syntax. Identify each failing role and background,
show the measured ratio, preview the affected role, offer a safe foreground repair, and require a
separate explicit confirmation before saving unresolved combinations. Protect accessibility text,
filled controls, bubbles, and media overlays through the same policy.

<a id="handle-color-01"></a>

## `HANDLE-COLOR-01` — per-handle color ownership

Define whether handle color is server- or device-owned and apply one deterministic precedence rule.
Missing, null, or malformed partial payloads must not erase the last valid value. Keep service
variants distinct, preserve positional alignment through query projections, use readable foregrounds,
and include the value in portable backup only if the approved model makes it device-local.

<a id="a11y-01"></a>

## `A11Y-01` — accessible labels and message actions

Associate rendered field labels with their inputs without overriding an explicit caller-provided
accessible name. Give policy switches a programmatic name and expose long-press message operations as
accessibility actions and hints so TalkBack users do not depend on adjacent text or an undiscoverable
gesture.

<a id="a11y-02"></a>

## `A11Y-02` — Reduce Motion

Resolve and observe the native Reduce Motion preference at a shared boundary. Skip or reduce decorative
bubble/full-screen effects and nonessential transitions while preserving content, state changes,
completion callbacks, navigation, and controls. Preference races, unmounts, recycled rows, and stale
animation callbacks must not restore motion or clear newer state.

<a id="a11y-03"></a>

## `A11Y-03` — real accessibility/layout matrix

Exercise critical journeys with TalkBack, large fonts, display scaling, contrast inspection, touch
targets, keyboard and navigation modes, privacy labels, and every supported orientation. Device
evidence is required wherever host rendering cannot prove native focus, announcements, clipping, or
gesture behavior.

<a id="test-01"></a>

## `TEST-01` — UI regression threshold

The selected UI aggregate must fail CI below 82% statements, 76% branches, 78% functions, or 84% lines.
`AudioAttachment`, `VoiceRecorder`, `ThemeStudio`, and `TextField` each need meaningful behavior coverage
at or above 70% statements/lines and 60% branches/functions, unless the master plan records a stricter
behavior-based exception. Coverage gained only through barrel imports, empty renders, snapshots, or
mock echoes does not satisfy this boundary.
