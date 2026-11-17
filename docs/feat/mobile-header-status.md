# feat/mobile-header-status — status as a small dot before the session title (no "Idle/Running" word)

> **Status:** implementation pre-approved (orchestrator 2026-11-17; owner picked the look) — executor writes the short plan, then implements
> **Branch:** `feat/mobile-header-status`
> **Size:** S · **Blast:** contained (apps/mobile header + chat-header view-model) · **Suited:** Opus exec + Opus review WITH simulator screenshots
> **Changelog:** `changelog.d/mobile-header-status.changed.md`

## Context

Owner 2026-11-17: the header's "● Idle · Qwen3.8-27B-UD-Q…" subtitle sits badly. Mockups `.tentacle/mockups/mobile-header-status/index.html`; owner pick: **variant C "Puntino sul titolo", but KEEP the model name under the title** (subtitle = model name only, no status word, no dot there).

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Pre-approved shape:
- A tiny dot (6 pt) BEFORE the title, shown only when the session is NOT idle: running/streaming = accent, pulsing (Animated native driver; Reduce Motion → steady); waiting for an approval (ask) = amber steady; offline / connecting = grey hollow (connecting pulses); not connected / error = amber hollow; ended/archived = no dot, title in secondary colour. Idle = no dot at all.
- Subtitle: the model name only (truncated as today), no "Idle/Running".
- The view-model (`chat-header.ts › chatStatus`) today maps ask and queued to "Running" — add the `ask` state (from the pending permission asks the screen already knows); queued stays running (the queue is in the composer). Logic in the pure module with tests (every state → dot kind), the component only renders (AGENTS §7).
- VoiceOver: the title's accessibilityLabel includes the state ("Test, running"), since the dot is visual only.
- Light + dark; screenshots of every state in the simulator (use your OWN simulator; the e2e harness, never port 4000) in `.tentacle/tmp/mobile-header-status/shots/`.

## Execution

## Review
