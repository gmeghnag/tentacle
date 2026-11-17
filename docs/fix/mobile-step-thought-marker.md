# fix/mobile-step-thought-marker — no ∴ next to a command's duration

> **Status:** implementation approved (owner 17/11)
> Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + standard review

## Context
*— claude-opus-5-5, 2026-11-17*

Owner (17/11, device screenshot of the tool-step thread): Bash rows show `∴ 22 ms`, `∴ 592 ms`, `Chart … ∴ 0 ms` — the ∴ sits next to the command's duration. Owner: "i tre puntini di thought non devono stare di fianco al tempo impiegato per i comandi, ma solo per il ragionamento".

Today the ∴ after the subtitle means "a thought is folded into this step" (`StepNode.tsx:261-262` prop `marker`, set at `screens/transcript/TranscriptRow.tsx:444` as `marker={view.thought !== null}`). The folded thought itself stays visible when the row is opened (`StepNode.tsx:418-423`).

## Implementation
*— claude-opus-5-5, 2026-11-17*

- Load-bearing assumption: the ∴ marker on a tool step carries no information the open row does not already show (the folded thought renders in the body, `StepNode.tsx:418-423`). Verify by reading those lines.
- Design: a tool step NEVER shows the trailing ∴ marker; the ∴ stays only on Thought rows (the orphan-thought node, `TranscriptRow.tsx:~300-321`, and the live Thinking footer). Remove the `marker` prop from `StepNode` entirely if nothing else sets it to true (it is `false` at `TranscriptRow.tsx:321` and `StepNode.tsx:483`), with its style `styles.marker` (`StepNode.tsx:533`) — dead code otherwise.
- Files: `apps/mobile/src/ui/StepNode.tsx`, `apps/mobile/src/screens/transcript/TranscriptRow.tsx`, the tests that pinned the marker (rg -n "marker" apps/mobile/test).
- Failure modes: a test or e2e flow asserting the marker (`rg -n "thought-mark|marker" apps/mobile/e2e apps/mobile/test`) → update it to assert the ABSENCE on a tool step and the presence on a Thought row.
- Tests: red→green — a test that a tool step with a folded thought renders no ∴ marker on its line (fails on main), and the Thought row still shows its ∴.

## Execution

## Review
