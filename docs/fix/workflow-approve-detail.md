# fix/workflow-approve-detail — the workflow approval must show every `run` command, verbatim

Type: fix · Size: S · Blast: load-bearing (§7: an approval shows the verbatim command; the single broker) · Suited: Opus plan → DeepSeek exec → Opus review (fresh context)

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Found by the workflows-ui planner (23/11 ~08:40), verified by the orchestrator: the hash approval ask of a workflow (`kind: "workflow_approve"`) builds its `detail` from the step list one line each (incl. every `run` command and its `where`, per agent-workflows D2) and CUTS it: `packages/agent/src/workflow-driver.ts:775` `detail: capWorkflowText(steps.join("\n"), 2000)` (same at `:512`; the cap constant `WORKFLOW_MAX_APPROVE_DETAIL = 2000` in `packages/core/src/workflow-spec.ts:46`). A workflow with many/long `run` steps is approved without the owner seeing all the commands it will execute — against the AGENTS §7 rule that an ask shows the verbatim command (shell-intent-line security rule: the model's text never replaces it), and the approval is LASTING (by hash). Owner 23/11 ~09:20: «apri il fix».

Goal: the approval NEVER hides a command. Options for the plan to weigh (with file:line): no cap on the commands part (the wire/protocol bound on `detail`? check `packages/protocol` schemas for a max length and what TUI/iPhone permission views do with long details — scroll, not cut); or refuse to ASK (and say why) when the full list would exceed a bound, rather than ask with a cut list. A cut list must be impossible. Also the `approve:` step detail (`≤ 2000`, templated) — same question. Tests red-first (a workflow whose commands exceed 2000 chars: today the ask's detail lacks the last command). Mac TUI and iPhone parity (the iPhone permission sheet renders the same detail).

## Implementation

## Execution

## Review
