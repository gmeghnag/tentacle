# feat/workflows-ui — see workflows: the client data path, the TUI view, the iPhone screens

Type: feat · Size: L (split into S/M slices) · Blast: cross-module (client + TUI + app; protocol only if the existing wire is insufficient) · Suited: Opus plan, DeepSeek exec (one at a time), Opus review, simulator shots

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

`feat/agent-workflows` merged 23/11 04:45 (`4ceba7b3`, protocol 25) with the engine, approvals, docker steps, notifications and scheduled start — but **no UI**: slice 6 (TUI rail + panel + `/workflow`) STOPPED before any edit (`docs/feat/agent-workflows.md:1364`) and slices 7–8 (iPhone list, graph 2C ⇄ cards 2A, approve buttons, node→detail morph + skeleton) shipped only the pure modules `apps/mobile/src/workflow-{graph,list,morph,skeleton}.ts` (`:1836`), because the client has no data path: `RemoteClient.workflowList()`, a public log read for the detail, and the `workflows` update reaching client state were all missing (the slice 7–8 load-bearing check, `:1836-1860`). Owner 23/11 ~07:45: do it, after the native-sheets plan.

Decisions already taken by the owner (keep them): iPhone main view = vertical graph **2C** with a cards toggle; tapping a workflow task/node navigates INTO it with the **morph** transition + **skeleton** (rows at their final positions, no layout shift; Reduce Motion: static grey bars), every inner part grows with the container; this is the ONE place transitions stay — every other sheet in the app becomes a native 3-detent sheet (`feat/mobile-native-sheets`, planned, not built yet — do not depend on it, do not conflict with its `Sheet` route). Mockups: `.tentacle/mockups/agent-workflows-{view,diagram,transition,spec,report}/`. Approval asks always show verbatim `run` commands (§7). Colour-blind owner: meaning never by hue alone. The workflow EDITOR is a separate later task (`feat/workflow-editor`, variant A) — out of scope; read-only views + run/stop/approve here.

## Implementation

## Execution

## Review
