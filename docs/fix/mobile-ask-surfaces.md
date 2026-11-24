# fix/mobile-ask-surfaces — one standard «ask» on the phone: truncated command, small buttons below, origin icon, never blocking

> **Status:** context
> **Branch:** `fix/mobile-ask-surfaces`
> **Size:** M–L (split into S/M slices) · **Blast:** cross-module (mobile ask UI + ask payload on the wire: origin, step N of M) · **Suited:** Opus plan; DeepSeek/Sonnet exec per slice (owner: S/M → deepseek/sonnet); Opus review per group
> **Changelog:** `changelog.d/mobile-ask-surfaces.fixed.md`

## Context

Owner 24/11, two iPhone screenshots (`.tentacle/tmp/mobile-ask-surfaces/owner-1345-ask.png`, `owner-1346-permsheet.png`):
1. Workflow RUN screen: the step ask («Run a shell command» + a long python command hard-clipped through a line + huge Allow once / Deny above the graph) — «bruttissimo»; unclear which step it belongs to.
2. Session PermissionSheet (native sheet): the whole command fills the sheet, Allow/Deny off-screen; unclear whether the ask comes from the agent, a sub-agent or a workflow; the sheet BLOCKS switching session until answered — «non va bene».

### Owner decisions (binding; mockup `.tentacle/mockups/mobile-ask-surfaces/index.inline.html`, variant **A** with changes)
- **ONE standard ask component** in both places (session sheet + workflow run screen).
- **Origin row top-left** with icon + words: main agent = **Polpetto 9×9 silhouette** (filled, eyes as holes, monochrome template from `apps/mobile/src/mascot-scenes.ts:31` rows; see `.tentacle/mockups/mobile-ask-surfaces/polpetto-icon.html`); sub-agent = SF `arrow.triangle.branch` + its name; workflow step = SF `point.topleft.down.to.point.bottomright.curvepath` + «<workflow> · step <id> · N of M».
- **Command truncated** to ~4 lines with an ellipsis + «+N lines · Show all» (expandable; buttons stay reachable when expanded).
- **Deny · Allow once BELOW the command, smaller** (~34 pt capsules), Deny grey not red (colour-blind: words carry it); rare options in a `…` menu.
- **A = native sheet** with detents (thin row / full ask / full screen); from the thin detent the screen behind stays usable (`sheetLargestUndimmedDetentIndex: 0`), swipe-to-dismiss on (`gestureEnabled: true`).
- **Dismissing the sheet (pull down) moves the pending ask into a SLIM BANNER under the header** (tap → sheet again). **No hand badge on the hub** for it.
- **Drawer session list («peek»)**: a session with a pending ask shows ONLY `hand.raised` (no «needs you» text). A session shows the workflow symbol only while a run is **live or waiting on the user**, and `clock` only while it has a **future scheduled wake**.
- On the workflow run screen the ask points at its step (the node shows `hand.raised`, needs-approval marker per fix/workflows-ux).
- «nuovo dato»: the ask needs a structured `origin` (kind main/subagent/workflow-step, name, run id, step id, N of M) instead of parsing `agent.description`; the drawer needs per-session flags (pending ask, live workflow run, next wake) if not already in `session/list`.

### Constraints
- Native sheets: `docs/feat/mobile-native-sheets.md` (detents, lock drain). The «never blocks session switching» rule must hold: the user can always reach the drawer/back with an ask pending.
- Overlaps: `fix/workflows-ux` (WorkflowRun.tsx, workflow markers, protocol run fields, hub), `feat/workflow-editor` (phone screens, protocol). List every shared file and recommend an order.
- `kit.js` `K.permissionSheet` is behind `PermissionSheet.tsx:144-154` — update the kit too (mockups must match the app).
- Pure modules for logic (ask view-model, truncation, origin label, drawer flags); components render only (AGENTS §7). Single-broker invariant untouched; a pod's ask origin is pod-supplied (label, never trust: §7 «a pod is not trusted»).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
