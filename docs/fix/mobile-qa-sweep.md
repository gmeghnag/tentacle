# fix/mobile-qa-sweep — live simulator QA of everything merged 16–17/11, and fix what is broken

> **Status:** context · implementation (executor: sweep FIRST, list every defect with a screenshot, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-qa-sweep`
> **Size:** M–L (split fixes into commits per defect) · **Blast:** cross-module (apps/mobile) · **Suited:** Opus exec + fresh Opus review WITH the screenshots
> **Changelog:** `changelog.d/mobile-qa-sweep.fixed.md`

## Context

Owner 2026-11-17 09:14, on the iOS build of main 32dcf4fb: "sembra che qui i test dall'app emulata non li abbia fatti nessuno". True: the night's slices were reviewed on code + unit tests; most simulator checks were skipped ("pixels unverified"). Already found by the owner:
1. **Artifacts gallery**: the close ✕ sits ON the status-bar clock (top-left, no safe-area inset) — `.tentacle/tmp/mobile-qa-sweep/owner-artifacts.png`.
2. **HTML artifact viewer**: opening "Pagina HTML minimale" (HTML page · 567 B) shows only "Couldn't keep this file" (`apps/mobile/src/screens/artifacts/ArtifactViewerModal.tsx:189`); the viewer also opens as a half sheet under the gallery.
3. Hub long-press dead / no haptics / no glyph / Activity "Scheduled · soon" → being fixed in `fix/mobile-hub-longpress-dead` (do NOT touch hub files; just re-check at the end and note).
4. App crash-loop on a session with a chart → being fixed in `fix/mobile-crash-ibm-chart` (do not touch; re-check at the end).

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor (Opus):
- **Simulator**: use your OWN simulator, `iPhone 17 Pro Max` (UDID 0B43D716-9670-421A-BE51-9162004F2963) — other agents use the booted iPhone 17 Pro. Build the app as the e2e harness does (`apps/mobile/e2e/README.md`, `run.ts`, mock model `mock-model.ts`, Maestro flows in `e2e/flows`) against a local daemon you start on a FREE port (never port 4000: that is the owner's live serve).
- **Sweep FIRST** (before any fix): exercise every user-visible feature merged since 2026-11-16 — tool rows variant C (rows, ∴, expand, error, running, long command), charts inline + full screen + gallery/hub entry, artifacts of every kind (HTML, image, PDF, Markdown) from the row AND from the gallery, open-at-end on open/reopen/foreground + row swipe timestamps, session drawer long-press (rename/delete/pin, pinned first), PDF attach/view, the `diagram` tool's row (D2: generic row today), the composer + header basics. Light AND dark. For each: screenshot to `.tentacle/tmp/mobile-qa-sweep/shots/<nn>-<what>.png` and a row in a table here under `### Sweep results` (feature · expected · seen · OK/BUG · screenshot).
- **Fix** every BUG in this branch's scope (not hub, not the chart crash): root cause in one sentence, red→green regression test (pure test where possible, plus a Maestro flow or real-screen render for UI ones), re-screenshot after. A bug too big for here → a `TODO.md`-ready line in `### Follow-ups` (do not edit TODO.md).
- Gate: `bunx tsc --noEmit`, `bunx tsc -p apps/mobile --noEmit`, `bun run lint`, the mobile tests; full `bun test` once at the end.

## Execution

## Review
