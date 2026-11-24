# fix/workflows-ux — Workflow runs readable on the phone, reachable from the hub, quiet in the TUI

> **Status:** context
> **Branch:** `fix/workflows-ux`
> **Size:** M–L (split into S/M slices) · **Blast:** cross-module (mobile screens + hub, TUI, workflow run data on the wire) · **Suited:** Opus plan; DeepSeek exec per slice (owner: S/M → deepseek/sonnet); Opus review per slice group
> **Changelog:** `changelog.d/workflows-ux.fixed.md` (+ `.changed.md` for the hub entry if the plan prefers)

## Context

Owner 24/11, after running a real workflow (`~/assistant/.tentacle/workflows/demo-note.yaml`, collect → draft(retry 1) → review(on_fail goto fix max 2, next confirm) → fix(next review) → confirm(approve) → archive) on the iPhone and in the TUI. Screenshots: `.tentacle/tmp/workflow-run-view/{162fac2b,9bd2be28,d1b5faaa}-image.png`.

### Defects (evidence)
1. **Run graph is unreadable** (d1b5faaa): a linear chain of pills; no taken/untaken path, no failure, no loop; `fix` (never ran: review passed first time) shows `○ fix · waiting` IN the chain between review and confirm, even after the run ended; the fix→review back edge is not drawn; no run outcome/duration.
2. **Never-run step detail** (162fac2b): `fix` says «This step's detail is no longer available» with State `waiting` — must say it did not run and why.
3. **Step detail header overlaps** the status bar and the back chevron (both detail screenshots).
4. **Hub entry unreachable when no run exists**: `hub-actions.ts:270` dims Workflows with `NO_WORKFLOW_RUNS` (`hub-session.ts:136`), and the Start entry lives only inside that screen (`WorkflowRuns.tsx:121`) → the first workflow can't be started from the phone.
5. **TUI before the first message**: the `/workflow` panel says «this session is not open yet» for the catalogue (`remote-session.ts:1336`) and «not supported by this computer's tentacle» for runs (`workflow-view.ts:516`) — false; the session is just not open.
6. **TUI at-rest catalogue line** `◇ workflows  demo-note v1 ✓ approved   /workflow` above Thinking (`workflow-view.ts:757,794`, `app-layout.ts:123`) reads like a lingering finished run. Owner: «va tolto».

### Owner decisions (binding, mockups in `.tentacle/mockups/workflow-run-view/`)
- **Run view = A + B** (`index.inline.html`): A = graph with the side branch (taken edge solid, possible dashed, not-taken faded dotted; chips `✗ 1/2` on goto, `↻ 1/1` on retry; top strip with outcome, total time, tokens) as the main view; B = rounds timeline («Next», «Not run» groups) behind the top-right list button (replacing the cards toggle).
- **Step detail**: nav bar under the safe area (`‹ demo-note · step 4 of 6`), never-run wording «Not run — review passed on its first try…», approve step shows question, outcome, wait.
- **Markers** (`markers-v2.inline.html`): style **(ii) tinta** — soft tinted circle body, the glyph carries the contrast; tokens `--wr-{ok,fail,run,ask,wait}-{soft,ink}` (+ `--wr-skip-ink`) light/dark as drawn; glyphs bigger (~half the circle). Glyphs are REAL SF Symbols via `apps/mobile/src/ui/Icon.tsx` (expo-symbols), not drawn SVG: succeeded `checkmark`, failed **`multiply`** (owner, `error-icon.html`), running/waiting-on-you/not-run per the mockup mapped to SF Symbols (plan proposes names). **Pending/not-yet = plain soft-grey disc with NO glyph** (owner: no ○ / dots). Owner is colour-blind: every state must stay distinguishable without colour (glyph + edge line style + the state word).
- **Hub** (`hub-workflows.inline.html`, variant B): Workflows takes **Attach's** slot in the fan; **Attach is removed from the hub entirely** (the composer `+` already does it); Commands stays. Workflows icon = SF Symbol `point.topleft.down.to.point.bottomright.curvepath`. The item is not dimmed when the project has workflows to start (fix 4).
- **TUI**: remove the at-rest catalogue line (catalogue stays in the `/workflow` panel); fix the wrong notes before the first message (5) — ideally the catalogue reads without an open session, else an honest «send a message first».
- «nuovo dato» from the mockups: the run view needs the workflow DEFINITION edges (`next`, `on_fail{goto,max}`, `retry`) with the run, so a loop is drawn before it fires; the plan decides where (protocol field on the run/steps read) and wires both ends.

### Constraints
- `feat/workflow-editor` is executing in parallel (slices 3b → 7c: workflow driver/daemon save path, client, phone editor screens + route + entries). List every file both touch; order or rebase so they don't collide (this task may execute after workflow-editor merges).
- Logic in pure modules (graph layout, state projection, hub ordering), components render only (AGENTS §7). Phone/Mac parity statement.

*— orchestrator (claude-opus-5-5), 2026-11-24, owner decisions in this session*

## Implementation

## Execution

## Review
