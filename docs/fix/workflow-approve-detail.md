# fix/workflow-approve-detail — the workflow approval must show every `run` command, verbatim

Type: fix · Size: S · Blast: load-bearing (§7: an approval shows the verbatim command; the single broker) · Suited: Opus plan → DeepSeek exec → Opus review (fresh context)

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Found by the workflows-ui planner (23/11 ~08:40), verified by the orchestrator: the hash approval ask of a workflow (`kind: "workflow_approve"`) builds its `detail` from the step list one line each (incl. every `run` command and its `where`, per agent-workflows D2) and CUTS it: `packages/agent/src/workflow-driver.ts:775` `detail: capWorkflowText(steps.join("\n"), 2000)` (same at `:512`; the cap constant `WORKFLOW_MAX_APPROVE_DETAIL = 2000` in `packages/core/src/workflow-spec.ts:46`). A workflow with many/long `run` steps is approved without the owner seeing all the commands it will execute — against the AGENTS §7 rule that an ask shows the verbatim command (shell-intent-line security rule: the model's text never replaces it), and the approval is LASTING (by hash). Owner 23/11 ~09:20: «apri il fix».

Goal: the approval NEVER hides a command. Options for the plan to weigh (with file:line): no cap on the commands part (the wire/protocol bound on `detail`? check `packages/protocol` schemas for a max length and what TUI/iPhone permission views do with long details — scroll, not cut); or refuse to ASK (and say why) when the full list would exceed a bound, rather than ask with a cut list. A cut list must be impossible. Also the `approve:` step detail (`≤ 2000`, templated) — same question. Tests red-first (a workflow whose commands exceed 2000 chars: today the ask's detail lacks the last command). Mac TUI and iPhone parity (the iPhone permission sheet renders the same detail).

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

**Status: NOT approved — two Owner questions below (Q1 is the TUI design, Q2 the lock-screen Approve of an approve step).** The rest is settled. The plan is fully written for the recommended answers, so "ok as recommended" is all it takes to approve it.

**Re-sizing:** the cut is not only daemon-side. Tracing the detail end to end found two more surfaces that approve a `workflow_approve` **without every command shown** (the Mac TUI dialog, and the iPhone lock-screen Approve: notification + Live Activity). That makes this `Size: M` (daemon + TUI + mobile, each a small pure-module change); Blast stays `load-bearing`. The header and the `TODO.md` line should say M (orchestrator: `TODO.md` lives on `main`).

### Load-bearing assumption — what bounds the detail end to end (proved)

**"The step list reaches each surface verbatim, so every cut is ours, and every place a cut or a blind approval can happen is one of the five listed here."** Traced hop by hop:

1. **Driver (cuts, silently).** `stepsSummary` (`packages/agent/src/workflow-driver.ts:247-255`) builds one line per step: `` id: run `cmd` (where) `` (raw `s.command`, the hashed text). Then `capWorkflowText(…, 2000)` (`core/src/workflow-spec.ts:53-55`: `slice(0, max) + "…"`) cuts it at `:512` (schedule `requestApproval`) and `:775` (`approveHash`). Nothing upstream bounds it: `run:` is `z.string()` with no max (`workflow-spec.ts:247`), steps ≤ 64 (`:31`). The YAML itself is effectively unbounded too, because `loadWorkflowSource` falls back to an unbounded `readFileSync` when the file is over `WORKFLOW_FILE_MAX_BYTES` (`cli/src/workflow-files.ts:30,54`). The approve-step detail (`:1245`) is capped too, but that cap is a no-op today: the validator already refuses a detail over 2000 (`workflow-spec.ts:234-240`), and the driver passes `step.detail` raw. It is never templated (`workflow-machine.ts:183-191` renders only the title).
2. **Wire (no bound).** `toPermissionRequestUpdate` maps `detail → explanation` 1:1 (`daemon/src/permission-map.ts:56`). `PermissionRequestUpdateSchema.explanation` is `z.string().optional()` with **no `.max()`** (`protocol/src/permission.ts:69`). The frame limit is 8 MiB (`daemon/src/device-accept.ts:40`), orders of magnitude above anything here. Client: `explanation → detail` 1:1 (`client/src/permission-router.ts:115`). The broker (single-broker invariant) carries the `PermissionRequest` opaquely, so it is not a bound. **No protocol change is needed.**
3. **Mac TUI (cuts, visibly, and per row).** `workflow_approve` is not `kind: tool`, so `permissionView` (`tui/src/permission-ui.ts:184-198`) takes the `permissionDetailLines` branch (`:128-137`). That branch keeps **≤ `MAX_DETAIL_ROWS` = 10 lines** (`:120`; `capRows` `:140-146` → `… N more lines`), and then the `.map(truncateCells(line, width))` at `:195` **cuts each line to one row**. Two consequences:
   - A workflow of 11+ steps is approved with its later commands replaced by `… N more lines`.
   - Any `run` command longer than ~77 cells is cut mid-command, even in a 3-step workflow.
   
   This is worse than the 2000 cap. The `y` / Enter path (`permission-reply.ts:139-157`) approves regardless.
4. **iPhone sheet (shows it all).** The sheet's `request` is the router's `entry.req` (`apps/mobile/src/permission-sheet.ts:283`), i.e. `toPermissionRequest`, so the detail is uncut. `PermissionSheet.tsx:160-165` draws it in one `<Text>` with no `numberOfLines`, inside the sheet's `ScrollView` (`:138`). The options come after it (`:179`), so reaching Approve means scrolling past the whole list. **No sheet change is needed.**
5. **iPhone lock screen (approves blind).** A push ask carries only the title + a one-line `preview` (`protocol/src/push.ts:183-189`). Since a `workflow_approve` offers `allow_once` + `reject_once` (`permission-map.ts:27-32`), it gets `CATEGORY_ASK` with **Approve** (`apps/mobile/src/push-render.ts:117-126`, `notification-categories.ts:92`). `decideAction` sends `allow_once` after Face ID with no sheet (`notification-action.ts:239-245`). The Live Activity does the same: `buttonsOf` gives Approve for any `allow_once` (`la-render.ts:124-140`, called `:212`), and `optionFor` answers it (`live-activity-action.ts:93-103`). So a **lasting** hash approval can be granted with zero commands seen.

Proof plan for the assumption: the red tests below each fail on today's code at exactly the hop they name (driver detail lacks the last command; the TUI view lacks rows / cuts a row; the push category offers Approve; the LA buttons include approve).

### Preconditions (verified)

- A `workflow_approve` is never auto-approved (`core/src/permission.ts:308`), and its options are allow-once / deny only (`permission-map.ts:27-32`, `tui/src/permission-ui.ts:248-256`). Nothing here changes that.
- The client derives `kind: "workflow_approve"` from the wire `tool === WORKFLOW_APPROVE_TOOL` (`permission-router.ts:111`, `core/src/permission.ts:30`). The mobile already imports `@tentacle/core` (e.g. `apps/mobile/src/artifact-viewer.ts:1`), so it can use the same constant.
- Every spec the driver sees went through `validateWorkflow` (`workflow-driver.ts:668-680` `prepare`), including a schedule's `requestApproval` (`:490`). So a validator bound is a bound on every ask.
- Per-request TUI dialog state already lives in `usePermission` (`permission-ui.ts:408-417`, reset per request at `:547/:571`, same lifetime as `shownAt`). The approval gate already exists as a function: `answer()` (`permission-reply.ts:139-142`) drops an approval when `!ctx.armed`, and a refusal always passes. The new gate extends that predicate rather than adding a second path.
- While the dialog is up, the permission layer owns every key (`tui/src/keys/layer-dialog.ts:25-31`), so PgUp/PgDn/Space there do not collide with transcript scrolling (`input-actions.ts:68-72`).

### Design

**A cut list is impossible by construction:** the daemon never cuts, an over-long list is never asked, and no surface can approve before the whole list has been shown.

**D1 — Daemon: one summary, never cut; refuse at validation.**
- Move `whereLabel` + `stepsSummary` from the driver into `core/src/workflow-spec.ts` as the exported `workflowApprovalSummary(steps: readonly WorkflowStep[]): string` (same line format, joined by `\n`). The validator and the driver then read ONE function.
- Add `WORKFLOW_MAX_APPROVE_SUMMARY = 16_000` chars beside `WORKFLOW_MAX_APPROVE_DETAIL` (`:46`). That is ~64 steps × 250 chars, and ~200 rows at 80 columns, still a list a human can read.
- In `validateWorkflow`, after the steps are built (`:745`) and only when the per-step checks passed, check the summary length. Over the bound → error `steps: the step list an approval shows is N characters, over 16000 — move long commands into a script and run that`.
- Result: the file is **invalid**, so it never starts, never asks, never schedules. The same text reaches the model through the validate/start tool result. This is **refuse rather than cut**, decided where every path passes.
- Driver `:512` and `:775` → `detail: workflowApprovalSummary(spec.steps)` with no cap. `:1245` → `detail: step.detail`, raw. The validator's 2000 limit is the bound, so a cut there cannot reappear silently.
- Hash pre-image unchanged (`WORKFLOW_HASH_SEED` untouched): approvals of existing files stay valid. A file over 16 000 that validated before now refuses to load. That is accepted (pre-public), and the error says how to fix it.

**D2 — Mac TUI: the whole list, wrapped, scrolled; Yes only once all of it has been on screen** *(recommended answer to Q1)*.
- In `permissionView`, a `kind === "workflow_approve"` branch:
  - Wrap every detail line with `wrapCells` (`permission-ui.ts:149-165`), like the shell branch, and **never `truncateCells`**.
  - If the rows fit in `MAX_DETAIL_ROWS`, show them all (`seen` is true from the start).
  - Otherwise show a window of `MAX_DETAIL_ROWS − 1` rows at `offset`, plus one status row: `rows a–b of N · space/PgDn more · PgUp back · read to the end to approve`. Once the end has been shown, the hint becomes `· all shown`.
  - Dialog height is unchanged from today's cap (≤ 10 detail rows), so `permissionPromptRows` / `app-layout.ts:366-378` keep working through the same view.
- A new pure module, `tui/src/approval-scroll.ts`, holds `{ offset, seen }` and `stepApprovalScroll(state, char, key, total, window)`:
  - Space / PgDn move one window down; PgUp / `b` move one window up, clamped.
  - `seen` becomes true once `offset + window >= total`, and it is **sticky** for the request (a resize re-wraps, `offset` is re-clamped, `seen` stays).
  - It is React-free and unit-tested (§7 "logic in pure modules").
- `permissionView(req, intent, columns, scroll?)` reads `scroll.offset` and reports `total` / `window`. The layout and `PermissionPrompt` both pass the same scroll, so the row count and the paint never disagree.
- Gate: `DialogContext` gains `reviewed: boolean`, and `answer()`'s predicate becomes `(ctx.armed && ctx.reviewed) || response.allowed === false`. `y`, and Enter on "Yes", do nothing until the whole list was shown; No / Esc / `n` / the reply always go through (owner Q2 of quit-enter-ask: an accidental refusal is recoverable).
  - `layer-dialog.ts:53-61` passes `reviewed` from the snapshot (`permission.reviewed()`, a getter beside `shownAt`).
  - A non-`workflow_approve` ask is always `reviewed: true`, so no behaviour changes for any other ask.
- `usePermission` holds the scroll state next to `shownAtRef`, resets it at the same two places, and exposes `scroll()` / `reviewed()`. The permission layer routes Space/PgUp/PgDn/`b` to `stepApprovalScroll` **before** `stepPermissionKey`, only for `workflow_approve` and only in menu mode. In the reply field those keys stay text.

**D3 — iPhone lock screen: a `workflow_approve` is never approved from it.** The sheet is the one place that shows the list, and it puts the options after it.
- `categoryFor(ask)` (`push-render.ts:117`): `ask.tool === WORKFLOW_APPROVE_TOOL` → `CATEGORY_OPEN` (Open only; no Approve, no Deny button. Deny stays one tap away in the sheet).
- `decideAction` (`notification-action.ts:239`): approve for a `workflow_approve` → `{ do: "refuse", why: "no-option" }`. This is defence in depth, because a notification delivered by an older build keeps its old buttons (`notification-categories.ts:17`).
- `buttonsOf` (`la-render.ts:124`) takes the ask's `tool`: for `workflow_approve`, no approve button (Deny kept: it grants nothing). `optionFor` (`live-activity-action.ts:93-103`) returns `undefined` for approve on a `workflow_approve`, which is the existing "not offered" refusal. `content.ask.tool` is in the sealed state (`protocol/src/live-activity.ts:171-176`).
- The sheet itself (`PermissionSheet.tsx`) needs no change.

**Parity statement.** Mac and iPhone both show every command verbatim, and both make approval reachable only after the whole list was on screen:
- TUI: the `reviewed` gate.
- Sheet: the options sit below the detail in one ScrollView.
- Lock screen: no approve at all.

The daemon refuses to ask a list over 16 000 chars, so neither surface ever receives one it would have to cut.

### Files (dependency order)

1. `packages/core/src/workflow-spec.ts`: `WORKFLOW_MAX_APPROVE_SUMMARY`, `workflowApprovalSummary`, the validator check. Export from `core/src/index.ts` if it is not re-exported by `*`.
2. `packages/agent/src/workflow-driver.ts`: drop `stepsSummary` (`:247-255`). `whereLabel` (`:288-293`) has other callers (`:701`, `:843`, `:1164`), so export it from core as `workflowWhereLabel` and import it here instead of keeping a copy, use `workflowApprovalSummary` at `:512` / `:775`, raw `step.detail` at `:1245`.
3. `packages/tui/src/approval-scroll.ts` (new), `permission-ui.ts` (view branch + hook state), `permission-reply.ts` (`DialogContext.reviewed`, gate), `keys/layer-dialog.ts` + `keys/snapshot.ts` (route keys, pass `reviewed`), `components/PermissionPrompt.tsx` + `app-layout.ts` (pass the scroll to the one view).
4. `apps/mobile/src/push-render.ts`, `notification-action.ts`, `la-render.ts`, `live-activity-action.ts`.
5. `changelog.d/workflow-approve-detail.security.md`: one bullet (user-visible: an approval now shows every command and cannot be granted blind).

No protocol schema change, so no `protocol.d/` note.

### Failure modes

- **Over-long list** → invalid file, never asked (D1). The start/schedule tool and `workflow` listing show the validator error.
- **Exactly 16 000 / 16 001** → boundary test (allowed / refused).
- **One giant command, few steps** → counted in the same summary length. In the TUI it wraps over many rows and scrolls.
- **Multi-line `run: |`** → its newlines stay in the summary. Each line is wrapped and nothing is truncated.
- **Terminal resize mid-review** → re-wrap, `offset` clamped, `seen` sticky (the content is identical, and it was all shown).
- **Narrow terminal** → `width = max(10, columns−3)` as today: more rows, same scroll.
- **Request replaced / queue advances / cancelled** → scroll reset with `shownAt` (`permission-ui.ts:547/571`). A new request is never pre-reviewed.
- **Arming window** → both gates must hold. A refusal is never gated.
- **Reply mode** → Space is text there, never a scroll.
- **Another device answers first** → `permission_resolved` closes the dialog as today.
- **Old notification with Approve buttons** → `decideAction` refuses, so nothing is sent and the sheet opens on tap.
- **Old Live Activity state** → `optionFor` refuses.
- **Hostile daemon (pod)** that sends a huge `explanation` or names an ordinary ask `workflow_approve` → that only asks *more* (`permission-router.ts:108-111`). The TUI wraps and scrolls whatever arrives, never cuts it, and stays bounded in height.
- **Approve-step detail** → ≤ 2000 by validation, shown through the same TUI branch (same gate). It is not templated, so it is shown as written. Rendering `{{…}}` refs in it is a separate debt, noted, not this fix.

### Tests (red first — each must fail on today's code)

- `packages/core/test/workflow-spec*.test.ts`: summary at 16 000 validates, at 16 001 refuses with the `steps:` error. `workflowApprovalSummary` keeps the line format (`` id: run `cmd` (local) ``, `(docker:x)`, `agent <model>`, `approve`).
- `packages/agent/test/workflow-driver.test.ts` (pattern `:180-200`):
  - **Red today:** a valid workflow whose summary is > 2000 chars (e.g. 12 `run` steps × 200-char commands, last one `echo LAST-COMMAND`). The `approveHash` ask's `detail` equals `workflowApprovalSummary(spec.steps)` and contains `LAST-COMMAND`, with no trailing `…`.
  - The same for `requestApproval`.
  - An approve step with a detail of exactly 2000 chars arrives byte-identical.
- `packages/tui/test/workflow-approve-view.test.ts` (new; pure `permissionView` + `stepApprovalScroll`, like `permission-shell-command.test.tsx:57-100`):
  - **Red today:** 3 steps with a 200-char command → every wrapped row is present and concatenating the rows reproduces the command (today it is cut at width).
  - **Red today:** 20 steps → window + status row, and paging to the end shows `step-20`'s command.
  - `seen` false→true only at the end, sticky across a column change.
  - `stepPermissionKey` with `reviewed: false`: `y` / Enter-on-Yes is `none`, while `n` / Esc answer the deny. With `reviewed: true` + armed, `y` answers.
  - A non-workflow ask is unaffected (`reviewed` defaults true).
- `packages/tui/test/app.test.tsx`-style integration (ink-testing-library): a 20-step `workflow_approve` through the real layer. `y` before paging sends nothing; Space×N then `y` sends allow-once. Frame height stays `permissionPromptRows(…)`.
- `apps/mobile/test`: `categoryFor` of a `workflow_approve` ask is `CATEGORY_OPEN` (**red today**: `CATEGORY_ASK_REPLY`). `decideAction(approve)` on it refuses `no-option`. `renderActivity` of an asking `workflow_approve` has no approve button (**red today**). `decideActivityAction(approve)` on it is refused. A shell ask is unchanged in all four.
- Non-vacuity (§9): revert each hop's fix in turn (restore the cap / the `truncateCells` / the gate / the category) and confirm its test goes red.
- Gate: `bun run check` green (lint baseline clean).

### Owner questions

- **Q1 — Mac TUI, for a list taller than the dialog: (A) scroll + "read to the end before Yes" [recommended], or (B) fit or deny-only?**
  - (A) costs one pure module + a gate predicate. A 64-step workflow stays approvable on the Mac, and approval is reachable only after every row has been on screen.
  - (B) is smaller: if the wrapped list doesn't fit in the dialog, offer only No and the line "too long to approve here — enlarge the terminal or answer on the iPhone". But any workflow over ~9 rows becomes unapprovable on the Mac, which defeats a 64-step limit.
  - **Recommendation: A.**
- **Q2 — The lock-screen Approve for an approve STEP** (one-shot, not lasting; its detail is author text, not commands). The wire cannot tell a hash ask from an approve step (same `tool`, `toolCallId` = runId for both, `workflow-driver.ts:778,1249`). So D3 applies to every `workflow_approve`: Open only, Deny in the sheet.
  - **Recommendation: accept the uniform rule.** The alternative needs a wire field to distinguish them (a protocol change), for the convenience of approving a merge from the lock screen without reading its detail.

## Execution

## Review

### Owner answers (2026-11-23 ~10:15)

*— claude-opus-5-5 (orchestrator), recording the owner*

- **Lock screen / Live Activity: KEEP «Approve»** for `workflow_approve` (hash approval AND `approve:` steps) — owner: «Dalle notifiche/activity voglio poter approvare». The push/LA part of the design is DROPPED from this task (owner accepted that the lock screen shows only title + preview).
- Daemon: no cut; a workflow whose approval list exceeds 16 000 chars is invalid (never asked) — explained to the owner, not objected.
- Q1 (TUI: scroll + Yes blocked until the whole list was shown): pending.
