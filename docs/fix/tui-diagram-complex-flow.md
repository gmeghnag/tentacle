# fix/tui-diagram-complex-flow — a real flowchart falls back to "source only in the terminal"

> **Status:** context · implementation (executor: repro FIRST with the exact source, then plan, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/tui-diagram-complex-flow`
> **Size:** S–M · **Blast:** contained (packages/tui diagram renderer) · **Suited:** DeepSeek exec + Opus review
> **Changelog:** `changelog.d/tui-diagram-complex-flow.fixed.md`

## Context

Owner 2026-11-17 11:35 (screenshot `.tentacle/tmp/tui-diagram-complex-flow/owner.png`): with Qwen3.8, "crea un flow chart di come funziona un token che entra in un modello transformer" → the model called `diagram` correctly (title "Il viaggio di un token in un Transformer", valid flowchart), but the TUI showed only the highlighted source with `· source only in the terminal`. DeepSeek's simpler flowchart drew fine. So the MODEL did nothing wrong: `drawFlow` (`packages/tui/src/diagram-ascii-flow.ts`) returned `undefined` (one of its bail-outs: ranks, gap plan, frames, width, crossing/bent spans…) on a realistic diagram with: a `subgraph … end` with `direction TB`, ~25 nodes, two BACK edges (`ADD2 -->|strati 1 … N−1| LN1` into the subgraph, `OUT -.->|re-iniettato come nuovo token| IN` from the bottom to the top), `<br/>` in labels, `[[ … ]]` subroutine shapes, edge labels, Unicode (`Q·Kᵀ / √dₖ`, `W₁ → GELU → W₂`), terminal ~200 columns.

The source is in the screenshot; transcribe it as a test fixture.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: reproduce FIRST — a test that feeds this exact source at 200 and at 80 columns to `diagramView` and shows which bail-out fires (log the reason in the repro, not in the product). Then make this class of diagram draw: `<br/>` → multi-line box labels, back edges drawn as a return arrow along the side (the mockup's style), subgraph frames with edges crossing in/out, width-aware wrapping of long labels; keep the fallback only for genuinely undrawable cases and make the caption say WHY in a few words (e.g. "too wide for 80 columns — ^X^O to open") instead of a bare "source only". Keep the D3 invariants (no emoji glyphs, pure modules, cell-width-correct). Tests: the fixture draws at 200 cols (frame snapshot), degrades at narrow widths with the reason, plus the existing D3 tests green.

## Execution

## Review
