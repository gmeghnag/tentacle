# feat/workflow-editor — Create and edit a workflow on the iPhone graph view

> **Status:** context
> **Branch:** `feat/workflow-editor`
> **Size:** L · **Blast:** cross-module (app + serve write path + approval) · **Suited:** Opus plan; DeepSeek exec per slice; Opus review per slice group (mandatory fresh-context: L)
> **Changelog:** `changelog.d/workflow-editor.added.md`

## Context

Owner (22/11 ~22:55, queued 23/11 ~12:20 right after feat/workflows-ui, now merged bb67dd2b): workflows can be run, viewed and approved from the iPhone graph view (workflows-ui), but creating or editing one still means writing YAML by hand or asking the model. The owner wants to create and edit a workflow directly on the iPhone graph.

Owner decisions (binding):
- **Variant A — direct manipulation** in edit/create mode: a ＋ on each edge inserts a step; drag the ✗ (failure) port onto the target step; the `✗ ×2` / `↻ ×1` edge labels are tappable to edit retries/loops. Mockup: https://claude.ai/artifact/GKErgFVG5s8Gmf3G7WcAvZ (sources `.tentacle/mockups/workflow-editor/`).
- This REVERSES the agent-workflows plan's «Mai: editor visuale drag-and-drop» (docs/eval/agent-workflows*.md, ~line 1014) — update that doc as part of this task.
- A template creates the YAML AND its prompt files (`workflows/prompts/*.md`), all under the approved hash (22/11 ~23:00).
- Open owner question (recommendation: yes): Save writes the file via `serve`.
- Mockup-kit gaps to fix first: `kit.js:271` permissionSheet options, `:316` row/band controls + filled button, `:278` toast action, `:369` extend wrapper.
- Phone/Mac parity rule applies (memory phone-mac-parity): say what the Mac/TUI side gets (the TUI editor stays a parked eval: eval/tui-workflow-editor).

*— orchestrator (claude-opus-5-5), 2026-11-24, from TODO.md + owner decisions*

## Implementation

## Execution

## Review
