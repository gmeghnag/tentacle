# feat/shell-intent-line — a sentence of what a shell command does

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/shell-intent-line`
> **Type:** feat · **Size:** L · **Blast:** cross-module · **Suited:** Opus (or equivalent) executes in three slices on this one branch; Review fresh-context, red-teaming the permission slice (AGENTS §7 "a pod is not trusted")
> **Changelog:** `changelog.d/shell-intent-line.added.md`

## Context

*— claude-opus-5-5, 2026-11-21*

**Problem.** A running or finished `shell` call shows the raw command
(`● Bash bun run typecheck -p packages/tui`; on the phone `Bash` + the mono
command). The person reads *how*, not *why*. The owner agreed (TODO.md row,
2026-11-20) to show a short sentence of WHAT the command does, written by the
model in the same call, in the user's language, with today's row as the fallback.

**Owner decisions in the brief (binding):**
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

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**The `shell` call's raw input — including a new optional `description` — reaches
BOTH clients at the moment the call starts, before its permission ask, with no
protocol change.** Proven:

- The agent yields `tool_start` with the model's raw `call.arguments` string
  (not the zod-parsed input) — sequential path `packages/agent/src/agent.ts:2170`,
  parallel group `:2309`, context-reset `:2575` — and only THEN authorizes the
  call (`authorizeCall` at `agent.ts:2182` / `:2318`). So the row with its
  arguments exists before any ask.
- The daemon maps it to `tool_call` with `rawInput: safeParseArgs(event.arguments)`
  (`packages/daemon/src/mapping.ts:293-300`, `safeParseArgs` `:239-248` = plain
  `JSON.parse`, no filtering). `ToolCallSchema.rawInput` is `z.unknown()`
  (`packages/protocol/src/updates.ts:49-56`), so nothing strips the field.
- The client maps it back to `tool_start` with `arguments: JSON.stringify(rawInput)`
  (`packages/client/src/mapping.ts:279-290`). TUI keeps it as `ToolItem.args`
  (`packages/tui/src/state.ts:550-558`); the phone as `ToolRow.args`
  (`apps/mobile/src/transcript.ts:546-556`).
- Resume/offline: the arguments are persisted inside the assistant message's
  `toolCalls` and the TUI rebuilds `args: call.arguments` from them
  (`packages/tui/src/resume.ts:133`) — a description survives `--resume` for free.

Repro above shows all four hops on a real value. ⇒ **No protocol change, no
`protocol.d/` note.**

### Preconditions

- **Where «Thinking…» is decided — TUI:** the pure `slotView`
  (`packages/tui/src/spinner-slot.ts:49-65`): `running && reasoning` → `thinking`,
  `running && !reasoning` → `working`. `reasoning` turns false at every
  `tool_start` (`state.ts:558`), so **while a command runs the slot today says
  «Working…»**. Called ONCE from `app-layout.ts:261` (row budget) and painted by
  `AppView.tsx:166-174` from that same view (the S3 single-decision rule —
  the new label MUST ride this view, never be re-decided in `AppView`).
- **Where «Thinking…» is decided — app:** the pure `isThinking` in
  `apps/mobile/src/tool-steps.ts:88-109`: false while a tool row runs. So on the
  phone a running command is already its own step (spinner node, `Bash` + mono
  command, live seconds: `StepNode`, `apps/mobile/src/ui/StepNode.tsx:341`),
  and the Thinking footer (`ThinkingNode`, `StepNode.tsx:524`) is gone during it.
  "The sentence replaces Thinking…" on the phone therefore = the running step's
  NAME becomes the sentence (with the shimmer the Thinking word has).
- **Row titles:** TUI `toolTitle`/`toolSubtitle` (`packages/tui/src/render-lines.ts:617-652`,
  shell = `str("command")`), header assembly `:885-895`. Phone `subtitleOf`
  (`apps/mobile/src/tool-summary.ts:71-91`, the same parity rule), trailing
  `toolMeta` (`:158-169`, which today says "Never an exit code").
- **Exit code is in the result text:** `shell` returns `exit=${code}\n…`
  (`packages/tools/src/builtins.ts:458`). A parser of that prefix is the only
  source of `N` in `✗ exit N` (display only).
- **Validation strips unknown keys:** `tool.inputSchema.safeParse` (`packages/tools/src/registry.ts:96`)
  on a plain `z.object` — adding an optional key is additive; the model sees it
  via `zodToJsonSchema` (`registry.ts:64`), `.describe()` included.
- **Permission request content:** `describeToolCall` builds `detail: command`
  from `command` ONLY (`packages/agent/src/permission-gate.ts:40-48`), the prefix
  suggestion from the command only; the wire carries it as `explanation`
  (`packages/daemon/src/permission-map.ts:36-50`); the client rebuilds the
  request with `input: {}` (`packages/client/src/permission-router.ts:102-112`) —
  so the permission UI has NO access to `description` today, and the core
  `PermissionRequestOptions.toolCallId` (`packages/core/src/permission.ts:158`,
  with `origin` `:160`) is the join key to the client's own tool row.
- **Reasoning text:** the phone keeps the live thought folded into the step
  (`tool-steps.ts:35-42`, "live only"; `StepBody` at `StepNode.tsx:469`). The TUI
  keeps NO reasoning text at all — only a flag (`state.ts:543-548`).
- TUI row-count invariants: the slot is exactly one row (`app-layout.ts:270-273`);
  the permission dialog's height is `permissionPromptRows` (`components/PermissionPrompt.tsx:15`,
  consumed at `app-layout.ts:371`).

### Design

One pure, shared source of truth in `@tentacle/core`, both clients project it.

1. **Tool schema** (`builtins.ts:407`): add
   `description: z.string().optional().describe(…)` — NO `.max()` (an over-long
   sentence must never fail the call and cost a round). Wording (in English,
   the schema's language): *"A short sentence (≤ 8 words) of WHAT this command
   does and why, in the language the user writes in — e.g. 'Run the mobile
   package tests'. Shown to the user instead of the command; the command itself
   is always shown when they are asked for permission."* Also one sentence in
   the tool `description`: "Always give `description`." `execute` ignores it.
2. **`packages/core/src/shell-intent.ts`** (new, pure, exported from the index):
   - `shellIntent(args: string): string | null` — parse JSON; take
     `description` if a string; strip C0/C1 control chars and ANSI escapes (a
     pod-supplied string reaching a terminal), collapse whitespace/newlines to
     one space, trim; `""` → `null`; cut to `INTENT_MAX_GRAPHEMES = 72` with `…`.
     Non-JSON / non-object / wrong type → `null`.
   - `shellOutcome(status, resultText): { ok: boolean; code: number | null }` —
     parse `^exit=(-?\d+)` of the result; `code` null when absent (a denied,
     cancelled or spilled call).
   - `INTENT_MAX_GRAPHEMES`, exported for both clients' tests.
3. **TUI** (variant A, pending Q1):
   - `toolTitle` for `shell`: when `shellIntent(args)` is non-null, the title is
     `{ label: <sentence>, subtitle: "" , command: <command> }` (label in bold as
     today); else today's `Bash <command>`. The header adds the written outcome
     after a settled shell row: `✓` (success) / `✗ exit N` (error), before the
     elapsed — glyph + word, not hue.
   - Expanded (click / Ctrl+O): today's `commandRows` already prints the full
     command under the header (`render-lines.ts:893-895`); with a sentence it
     prints `$ <command>` there, then the captured reasoning (below), then the
     body.
   - Reasoning before the call: a NEW pure reducer step in `state.ts` keeps
     the reasoning text of the current round (`reasoningText`, appended on
     `reasoning`, reset at `tool_start`/`text`) and copies it onto the
     `ToolItem` it precedes (`thought?: string`, capped at 2 000 chars). Live only
     (a resumed session has none — same as the phone).
   - Slot: `SlotFacts` gains `intent: string | null`; `slotView` returns
     `{ kind: "intent", text, since }` when `running && !reasoning && intent`.
     `intent` is computed by a new pure `liveIntent(items)` (latest RUNNING
     `shell` row with a sentence; with >1 running shell rows: the first one +
     ` +N`). `app-layout.ts` passes it; `AppView` paints `<Thinking label={text + "…"}>`
     with the label pre-truncated to `columns − width(spinner + " ") − width(suffix)`
     cells by `fitIntentLabel` (pure, `cells.ts`), so the slot stays ONE row.
4. **App:**
   - `tool-summary.ts`: `stepTitle(row)` → `{ name, mono }`: sentence ⇒
     `name = sentence`, `mono = ""` (sans, weight 500); else today's
     `Bash` + command. `toolMeta` trailing for a settled shell with a sentence:
     `✓ 1.2 s` / `✗ exit 2 · 3.4 s` (still `trailingRed` on error — colour is
     the extra cue, the text is the meaning). The "Never an exit code" comment
     is updated: shell's text carries one.
   - `StepNode`: a running step whose name is a sentence draws it with the
     existing `ThinkingWord` shimmer (base `label`, not `sec`) — no new
     animation code. Its body (`StepBody`) already shows thought, command,
     output; the command block is now shown even when the row's title is a
     sentence (it already is: `bodyCommand`, `tool-summary.ts:414`).
5. **Permission view (security rule):**
   - Client: `PermissionRouter` passes the wire's `toolCallId` and `origin` in
     the requester's options (client-internal; `PermissionRequestOptions`
     already has both fields). No protocol change.
   - TUI `PermissionPrompt` / phone sheet: the subject row stays the verbatim
     `detail` (the command) — FIRST, full colour, never truncated (today it is
     dim in the TUI: raise it to the default fg). Under it, ONLY when
     `origin === "call"` and the joined row is a `shell` with `shellIntent`
     non-null: one dim row `il modello dice: «<sentence>»` — wording in English
     in code (`the model says: “…”`), Italian only in the mockup. The
     prefix suggestion keeps coming from the command only. `permissionPromptRows`
     gains `+1` exactly when that row is drawn (one pure helper decides it for
     both the row count and the paint).

**Mockups → plan mapping:** variant A = items 3–4 as written; B adds the
`$ command` second row; C keeps rows as today and only changes the slot / live node.

### Files

In dependency order (no protocol change):

1. `packages/tools/src/builtins.ts` — schema field + description wording.
2. `packages/core/src/shell-intent.ts` (new) + `packages/core/src/index.ts` export.
3. `packages/client/src/permission-router.ts` — pass `toolCallId`/`origin` to the requester.
4. `packages/tui/src/render-lines.ts` — `toolTitle`/header/expanded rows.
5. `packages/tui/src/state.ts` — `thought` on `ToolItem` (reasoning capture).
6. `packages/tui/src/spinner-slot.ts` — `intent` fact, `intent` kind, `liveIntent`, `fitIntentLabel`.
7. `packages/tui/src/app-layout.ts`, `packages/tui/src/AppView.tsx` — wire the fact / paint the label.
8. `packages/tui/src/components/PermissionPrompt.tsx` (+ `permission-ui.ts` for the join) — subtitle row, row count.
9. `apps/mobile/src/tool-summary.ts`, `apps/mobile/src/ui/StepNode.tsx`, `apps/mobile/src/screens/transcript/TranscriptRow.tsx` (passes the step title to `StepNode`, `:443`) — step title/trailing.
10. `apps/mobile/src/permission-sheet.ts` + its screen — the subtitle row.
11. `changelog.d/shell-intent-line.added.md`.

Slices: **S1** = 1–2 (+ tests); **S2** = 3–8 (TUI); **S3** = 9–10 (app). Each
slice green on its narrow tests before the next.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| `description` missing, `null`, non-string, `""`, whitespace | `shellIntent` → `null` ⇒ today's row exactly (`Bash <command>`), slot «Working…». |
| Too long (a paragraph) | Never rejected by the schema; cut to 72 graphemes + `…`; the TUI slot further cut to its one row (`fitIntentLabel`). |
| Newlines / ANSI / control chars (a pod or a confused model) | Stripped/collapsed in `shellIntent` before any client draws it — a description can never move the cursor or add a row. |
| Wrong language | Shown as written (no detection, Q8). The schema wording asks for the user's language. |
| Sentence lies about the command | Rows: possible and accepted (display only; the command is one tap away). Permission: the command is first, full-colour, untruncated; the sentence is dim and attributed ("the model says"); the "don't ask again" prefix never reads it (test). |
| Parallel `shell` calls | Each row has its own sentence; the slot shows the FIRST running one + ` +N`. Queued rows (`◌`) use the sentence as their title too. |
| Sub-agents | A child's `shell` gets the same schema, so it may fill it; the sub-agent tree rows (`subagent-view.ts`) keep the command in this task (debt). A sub-agent's permission ask (`origin: "subagent"`, `toolCallId` = parent `agent_task`) shows NO sentence — the join would name the wrong call. |
| Pods (`run`/`attach`) | The description is pod-supplied, like the command already is: display only, sanitized, never feeds a decision. Nothing new crosses to the laptop. |
| Old sessions / old daemon | No `description` in their args ⇒ fallback row. No version skew: the field is free in `rawInput`. |
| `--resume` | Sentence survives (in args); the TUI/phone reasoning in the detail does not (live only) — the detail shows command + output. |
| Model never fills it | Fallback; measured (Tests §measurement). If fill-rate < 80 % on a provider, add one line to the system prompt (Q9) — no code path depends on it. |
| `shell` with `run_in_background` | Sentence titles the row; outcome is the job start (no `exit=` ⇒ `code: null` ⇒ `✓` only, no `exit` word). |
| Denied / cancelled / spilled | `shellOutcome` code `null`: denied keeps today's `denied`/`✗ Denied` wording; spilled keeps its spill body; never an invented `exit N`. |
| Narrow terminal / large Dynamic Type | TUI: one row, truncated; phone: `numberOfLines={1}` as today. |

### Tests

Red first on each (shown failing on `main`), with the mutation that must turn it red again.

- `packages/core/test/shell-intent.test.ts` (new): missing/empty/whitespace/non-JSON/non-string → `null`; ANSI `\x1b[2J` and `\n` removed; 200-char input → exactly 72 graphemes ending in `…`, emoji/combining never split; `shellOutcome` for `exit=0`, `exit=2`, `exit=124`, no prefix. *Mutation:* drop the control-char strip → the ANSI case fails.
- `packages/tools/test/…` (builtins): the JSON schema sent to the model contains `description` with the wording; a 5 000-char description still **executes** (no `.max`). *Mutation:* add `.max(80)` → red.
- `packages/tui/test/render-lines.test.ts`: shell row with a sentence → header is the sentence; settled ok → contains `✓`; error with `exit=2` → contains `✗ exit 2` **with colour stripped** (proves the written outcome, not hue); no sentence → byte-identical to today's row. *Mutation:* render the outcome as colour only → red.
- `packages/tui/test/spinner-slot.test.ts`: `running && !reasoning && intent` → `kind: "intent"`; `reasoning` wins over intent (Thinking… while the model thinks again); two running rows → `+1`; label fits `columns` for 40/80/200 (row count unchanged — the exact property: one row). *Mutation:* return the untruncated label → the width test fails.
- `packages/tui/test/app.test.tsx` (ink-testing-library, the existing pattern): frame sequence Thinking… → sentence in slot → done row `✓` → Working…; frame height constant AND the input row's y-position stable across the sequence (the exact property, §2).
- `packages/tui/test/permission-detail.test.ts`: a shell ask whose sentence lies → the command row precedes the sentence row; the command is rendered in full; `permissionPromptRows` = rendered rows (with and without the sentence); `origin: "subagent"` → no sentence; the suggestion prefix equals the command's (description `"git push --force"` does not change it). *Mutation:* derive the prefix from `description` → red.
- `packages/client/test/permission-router…`: requester options carry `toolCallId`/`origin`.
- `apps/mobile/test/tool-summary.test.ts` / `tool-steps.test.ts`: step title = sentence; trailing `✓ 1.2 s` / `✗ exit 2 · 3.4 s`; fallback identical to today. `permission-sheet.test.ts`: command before sentence, sentence only on `origin: "call"`.
- **Measurement (not a gate test; cheap, run once by the executor):** a script in `.tentacle/tmp/shell-intent-line/` sends 20 fixed prompts that need a shell command (10 Italian, 10 English) to DeepSeek and to an Anthropic model with the new schema, and reports: fill rate, median length, language match. Pasted into Execution. Acceptance (Q9): ≥ 80 % fill on both.

### Owner questions

*Not approved. One recommendation each.*

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

*— (empty until the plan is approved)*

## Review

*— (empty)*
