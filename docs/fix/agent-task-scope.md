# fix/agent-task-scope — the sub-agent tools' model-facing texts: scope, "create agents", two-way

> **Status:** done (execution + self-review complete; awaiting the owner's review of the branch)
> **Branch:** `fix/agent-task-scope`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** DeepSeek exec

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-10*

The model-facing text of the sub-agent tools cost the owner time twice in real
use (`TODO.md`, `fix/agent-task-scope`):

1. **No scope, no stop criterion.** The parent launched two open-ended
   "adversarial review" children: their prompts said what to review only in the
   loosest terms, and nothing said when to stop, so both wandered.
   `agent_task`'s description (`packages/tools/src/task.ts:100`) said nothing
   about how to write a prompt.
2. **"Create two agents" in an empty folder → `codex`, `claude -p`, `tentacle`
   through the shell**, instead of `agent_task`. Today's text frames the tool as
   "delegate a task, get a report, prefer it for search": nothing says it is the
   way to create an agent. The owner wants a DEFAULT, not a ban: shelling out is
   legitimate (a `tentacle run` in a container, testing tentacle, orchestration)
   when the user asks for it.
3. **`subagents.twoWay: true` and the parent is still told there is no way
   back.** `packages/tools/src/background.ts:180` (the tool's description) and
   `:189` (its result) say "One-way: no reply comes back … It does not wake
   you", and `agent_task` says nothing: `docs/feat/agent-message-two-way.md`
   wired the child's `agent_notify` and the parent's note but never made the
   PARENT's texts depend on the flag.

**Repro** (2026-11-10, the tools the agent is actually given, through the real
`buildAgent`, for both values of `subagents.twoWay`;
`.tentacle/tmp/agent-task-scope/repro.ts`, re-run on this branch before any
edit):

```
===== subagents.twoWay = false =====
--- agent_task description ---
Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so use it to explore or offload work without filling your own context. Prefer it for open-ended search and read-heavy investigation. Several agent_task calls in one message may run at the same time. They share one workspace: give each its own files, and do not have two of them commit, or run builds or tests that could overlap.

Available sub-agent types:
- general: General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.
- explore: Read-only investigator: searches and reads files to answer a question. Cannot modify anything.
--- agent_message description ---
Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. One-way: no reply comes back, and its report still arrives later as a [background] note. It does not wake you.

===== subagents.twoWay = true =====
--- agent_task description ---
Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so use it to explore or offload work without filling your own context. Prefer it for open-ended search and read-heavy investigation. Several agent_task calls in one message may run at the same time. They share one workspace: give each its own files, and do not have two of them commit, or run builds or tests that could overlap.

Available sub-agent types:
- general: General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.
- explore: Read-only investigator: searches and reads files to answer a question. Cannot modify anything.
--- agent_message description ---
Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. One-way: no reply comes back, and its report still arrives later as a [background] note. It does not wake you.
```

Both runs are byte-identical: `twoWay` changes nothing the parent reads (problem
3), the neutral text says nothing about scope or about creating agents
(problems 1 and 2).

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Load-bearing assumption

`subagents.twoWay` reaches the tool factories through the SAME config field the
child's `notify` already rides: `config.subagentsTwoWay`
(`packages/cli/src/wiring.ts:552`, carried to a pod as class `P`,
`packages/cli/src/carried-settings.ts:92`). Verified: the wiring is the only
place `createTaskTool`/`createAgentMessageTool` are built for a session
(`wiring.ts:564`, `:583`), so one flag passed there decides every text — pod
included, from the laptop's carried value, like `agentTaskDescription`
(`carried-settings.ts:~99`).

### Preconditions

- `twoWay` off is the default (`packages/config/src/defaults.ts:28`,
  `DEFAULT_SUBAGENTS_TWO_WAY = false`), so "off = byte-identical" is also the
  common path, not a corner.
- The note a child's reply leaves in the parent reads
  `[sub-agent sa-1 → you] …` (`packages/agent/src/agent.ts:297`) — the texts
  quote that shape, so they must not invent another.
- `agent_task`'s text is composed in one pure function,
  `taskToolDescription` (`task.ts:115`): neutral-or-custom, then the overlap
  note, then the type list (+ the models list). Nothing else renders it.
- `agent_message`'s ok-result string and its description live in
  `background.ts:180`/`:189`; the ok-result is pinned by
  `packages/tools/test/agent-message.test.ts:44` and
  `packages/cli/test/agent-message.e2e.test.ts:168`.
- A custom `subagents.agentTaskDescription` is "used as is, in every mode"
  (`task.ts:83`, `packages/config/src/key-docs.ts:553`); the type list (and the
  models list) always follow it.

### Design

Three additive changes, one flag threaded, no new seam.

**(1)+(2) The neutral text** (`task.ts:106`) — replaced by, verbatim:

> Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so it offloads read-heavy work without filling your own context. To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it. Scope each prompt: the files, diff or questions it owns, and a stop criterion — what counts as done. Turn-based: one foreground sub-agent at a time, its report the call's result. Long-lived: `background: true`, then `agent_message` to steer it while it works.

- The owner's "create agents" sentence is kept **verbatim** (so a test can pin
  it): "To create agents, use this tool. Start another agent CLI (claude, codex,
  tentacle, …) through the shell only when the user explicitly asks for it."
- "Prefer it for open-ended search and read-heavy investigation." is dropped:
  that framing is what made the agent treat the tool as a search helper; its
  content survives as "so it offloads read-heavy work".

**(3) `twoWay`.** A new `TaskToolOptions.twoWay?: boolean`, and a constant
appended after the neutral text (and after the overlap note) only when it is
true:

> A background sub-agent may reply with `agent_notify`: it arrives as a `[sub-agent sa-N → you]` note, and may wake you.

`agent_message` gets an optional second parameter,
`createAgentMessageTool(jobs, options?: { twoWay?: boolean })`:

- description, on: `Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. It may answer with agent_notify meanwhile: that arrives as a [sub-agent sa-N → you] note and may wake you; its report still arrives later as a [background] note.`
- result, on: `queued for ${id}: it reads it before its next model step. It may answer with agent_notify (a [sub-agent ${id} → you] note that may wake you); its report still arrives as a [background] note.`
- off: both byte-identical to today (the same string constants, chosen by one
  ternary; nothing reflowed).

**A custom `agentTaskDescription` + (3):** the custom text still replaces the
neutral text WHOLE — as today, and as `key-docs.ts:563` promises ("used as is…
the list of sub-agent types is always appended") — so the two-way line is **not**
appended to it; the overlap note is not either. The parent still learns the
fact, from two places it reads anyway: `agent_message`'s own description (which
always carries the two-way line when the flag is on), and the note itself, which
says "To answer, use agent_message({ agent_id: … })"
(`agent.ts:297`). What is appended to a custom text stays exactly what it is
today: the type list, then the models list.

### Files

1. `packages/tools/src/task.ts` — `NEUTRAL_DESCRIPTION` (:100),
   `TWO_WAY_NOTE` (new), `TaskToolOptions.twoWay` (:80),
   `taskToolDescription(..., twoWay)` (:115), the call site (:333).
2. `packages/tools/src/background.ts` — `createAgentMessageTool` (:176): the
   options parameter, the description (:180) and the ok-result (:189) per flag.
3. `packages/cli/src/wiring.ts` — `twoWay: config.subagentsTwoWay` in the
   `createTaskTool` options (:564) and `createAgentMessageTool(agentJobs, { twoWay })`
   (:583).
4. Tests: `packages/tools/test/task.test.ts`,
   `packages/tools/test/task-models.test.ts` (its pinned `NEUTRAL` const),
   `packages/tools/test/agent-message.test.ts`,
   `packages/cli/test/agent-task-description.test.ts` (new: the real wiring,
   both flag values).
5. `packages/config/src/key-docs.ts` — one sentence on `subagents.twoWay`'s
   details (the parent's texts now say it), then `bun run docs:config` rewrites
   README's table.
6. `CHANGELOG.md` — one `[Unreleased] → Fixed` entry.

### Failure modes

- **Flag off reaching a text by accident** (e.g. a defaulted `?? false` on a
  path where `twoWay` is undefined): pinned by byte-identical tests on the
  default construction (`createTaskTool(run, types)`,
  `createAgentMessageTool(jobs)`), not only on the explicit `false`.
- **The text drifts from what actually happens** (claiming a reply is
  guaranteed): the sentence says the child MAY reply, and the note's own wake
  rule stays bounded/`autoWake`-gated — no promise of a reply or of a wake.
- **A pod shows the pod's value**: impossible by construction — the flag is the
  carried `subagentsTwoWay` (class `P`), and a pod's own config never wins.
- **Byte-identical off broken by invisible edits** (whitespace, quote shape,
  a re-wrapped template literal): tests compare full strings with `toBe`, not
  `toContain`.
- **A custom description silently gaining text**: pinned by a test that a custom
  text with `twoWay: true` has no two-way line.

### Tests

Red before green (`AGENTS.md` §9), each shown failing on the code before this
change:

- `packages/tools/test/task.test.ts` — the neutral text contains the scope ask
  ("Scope the prompt", "stop criterion"), the owner's create-agents sentence,
  and both patterns; a custom text replaces it whole.
- `packages/tools/test/agent-message.test.ts` — `twoWay` off: description and
  ok-result are today's exact strings; on: each carries the `agent_notify` reply
  line.
- `packages/cli/test/agent-task-description.test.ts` — through `buildAgent`
  (the tools the agent is really given): `twoWay` off → the pinned `agent_task`
  and `agent_message` texts; on → both carry the reply line, and `agent_task`
  still ends with the type list.
- Mutations (non-vacuity): (a) drop `twoWay` from the `createTaskTool` options
  in `wiring.ts` → the wiring test's "on" case goes red; (b) hard-code
  `twoWay = true` in `background.ts` → the byte-identical test goes red.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Repro re-run on the branch before any edit (`.tentacle/tmp/agent-task-scope/repro.ts`,
through `buildAgent`, both flag values): the two runs were byte-identical —
`agent_task` said nothing of scope or of creating agents, `agent_message` said
"no reply comes back" even with `twoWay: true` (see Context).

As built, in order:

1. `packages/tools/src/task.ts` — `TaskToolOptions.twoWay` (`:103`),
   `NEUTRAL_DESCRIPTION` (`:106`), `TWO_WAY_NOTE` (`:114`),
   `taskToolDescription(..., twoWay = false)` (`:129`, appended after the
   overlap note, never to a custom text), the call site (`:355`).
2. `packages/tools/src/background.ts` — `createAgentMessageTool(jobs, options =
   {})` (`:178`), `const twoWay = options.twoWay === true` (`:182`), a ternary
   over two full string literals for the description (`:184`) and the ok-result
   (`:195`) — the off branch is today's text character for character.
3. `packages/cli/src/wiring.ts` — `twoWay: config.subagentsTwoWay` in the
   `createTaskTool` options (`:572`), `createAgentMessageTool(agentJobs, { twoWay:
   config.subagentsTwoWay })` (`:587`). The same config field the child's
   `notify` already rides (`:552`), so a pod reads the laptop's carried value.
4. Tests: `packages/tools/test/task.test.ts` (scope + create-agents + patterns,
   `twoWay` off/on, custom text either way), `packages/tools/test/task-models.test.ts`
   (the pinned `NEUTRAL`), `packages/tools/test/agent-message.test.ts` (off:
   today's exact strings for absent AND `false`; on: the reply line),
   `packages/cli/test/agent-task-description.test.ts` (new, 3 tests — through
   `buildAgent`, reading the tools off the request the model got).
5. `packages/config/src/key-docs.ts` — `subagents.twoWay`'s `details` now says
   the agent's texts follow it (and that a custom `agentTaskDescription` does
   not). `bun run docs:config` → "README.md's config table is up to date" (the
   `summary` cell, which is what the table renders, is unchanged).
6. `CHANGELOG.md` — one `[Unreleased] → Fixed` entry (the first under Fixed).
7. Owner trim: removed the duplicate 'This is the way…' sentence.

Final texts, verbatim:

`agent_task`, `twoWay` OFF (then the overlap note for the mode, then
`\n\nAvailable sub-agent types:`):

> Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so it offloads read-heavy work without filling your own context. To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it. Scope each prompt: the files, diff or questions it owns, and a stop criterion — what counts as done. Turn-based: one foreground sub-agent at a time, its report the call's result. Long-lived: `background: true`, then `agent_message` to steer it while it works.

`agent_task`, `twoWay` ON — the same, plus, after the overlap note:

> A background sub-agent may reply with `agent_notify`: it arrives as a `[sub-agent sa-N → you]` note and may wake you.

`agent_message`, `twoWay` OFF (description / ok-result):

> Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. One-way: no reply comes back, and its report still arrives later as a [background] note. It does not wake you.

> queued for sa-1: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.

`agent_message`, `twoWay` ON (description / ok-result):

> Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. It may answer with agent_notify meanwhile: that arrives as a [sub-agent sa-N → you] note and may wake you; its report still arrives later as a [background] note.

> queued for sa-1: it reads it before its next model step. It may answer with agent_notify (a [sub-agent sa-1 → you] note that may wake you); its report still arrives as a [background] note.

Red before green (§9): with the three source files put back to their `HEAD`
contents (copied in by script, never `git checkout`), the four test files ran
**21 pass / 9 fail** — every new assertion red (the 9: two pinned
description texts in `task-models`, the three neutral-text tests, the
twoWay-on `agent_task` test, the two `agent_message` twoWay tests, the two
wiring tests), the pass count being the pre-existing tests. Green after.

Mutations (6, `.tentacle/tmp/agent-task-scope/regress.py`, each an exact-string
swap reverted byte-exactly and re-read to prove it):

| # | Mutation | Red |
| - | --- | --- |
| M1 | neutral text back to today's | 4 fail (3 neutral-text + the wiring off case) |
| M2 | `task.ts` never appends `TWO_WAY_NOTE` (`options.twoWay === true` → `false`) | 2 fail (unit + wiring, `twoWay` on) |
| M3 | `background.ts` ignores `twoWay` (`… === true && false`) | 2 fail (unit + wiring) |
| M4 | wiring drops `twoWay` for `agent_task` | 1 fail (wiring, `twoWay` on) |
| M5 | wiring drops `twoWay` for `agent_message` | 1 fail (wiring, `twoWay` on) |
| M6 | the OFF description gains a word (`. It never wakes you.`) | 2 fail (byte-identical test + wiring) |

M4/M5 are the load-bearing seam (the wiring is the only place a session's
tools are built): both are red, so the flag is really passed, not defaulted.

Gate: `bun run check` → typecheck (`tsc --noEmit` + `apps/mobile`) clean,
lint clean (838 files, 0 errors/warnings — the first run flagged formatting in
my three files, fixed with `biome check --write`), tests **6505 pass, 3 skip, 0
fail** (6508 across 456 files) — the 3 skips are the opt-in ones (live k8s,
live docker, real-socket keepalive), as the baseline allows.

Drift from Implementation:

- The neutral text was first written with "…so it is how you offload…", "…agents
  of your own, role/persona agents included" and "Scope the prompt: …"; the
  first repro read showed awkward phrasing, so it settled on "so it offloads
  read-heavy work", "This is the way to create and run agents, role/persona ones
  included" and "Scope each prompt" (same content, fewer words — every word is
  paid per request). The owner's verbatim sentence is untouched.
- Owner trim (item 7, after the gate above): "This is the way to create and run
  agents, role/persona ones included." is gone from the final text — it repeated
  the owner-kept "To create agents, use this tool." The Design quote and the
  drift bullet above still show the pre-trim wording, and the Execution test
  counts predate it; the "Final texts, verbatim" block is the truth.
- `taskToolDescription` takes `twoWay` as a 5th POSITIONAL parameter with a
  default (`= false`), matching the function's existing shape (it already
  takes 4), rather than an options object: callers other than `createTaskTool`
  do not exist (`rg taskToolDescription` → only `task.ts:355`).
- `docs/feat/agent-message.md:165` and `docs/feat/models-map.md:537` quote the
  OLD texts as history (the plan of a merged task, and an elided example). Left
  as they are: a merged task doc records what was built then, and rewriting it
  would be the drift, not the fix.
- `README.md` was untouched by the regeneration because only `details` changed
  and the table renders `summary`; `bun run docs:config` says it is up to date.

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Self-review only — this task is `contained` / `S` (`AGENTS.md` §10 allows
standard in-context Review), not the mandatory fresh-context one.

**Holds:**
- Off is byte-identical for BOTH tools, pinned on the default construction
  (flag absent), not just on `twoWay: false` — so a future caller that forgets
  the option cannot silently change what the parent reads.
- The flag reaches the tools the way §7 requires: the same carried config field
  the child's `notify` rides (`wiring.ts:552`), so a pod reads the laptop's
  value; no second path, no daemon-side text.
- The text promises nothing it cannot deliver: "may reply", "may wake you"
  (wake is `autoWake`- and budget-gated, `agent-jobs.ts:88`).
- The two-way line is appended only to the NEUTRAL text; a custom
  `agentTaskDescription` is untouched, which is what `key-docs.ts:563` promises,
  and `agent_message`'s own description carries the fact anyway.
- The `[sub-agent sa-N → you]` shape quoted in the texts matches the note the
  parent really gets (`agent.ts:297`).

**Does not hold / accepted:**
- The scope/stop-criterion ask is a text, not an enforcement: a child can still
  be launched without one. Nothing in the tool can validate a prompt's content;
  the fix is the default framing (as the owner asked), not a guard.
- The wiring test's `agent_task` "off" assertion pins today's neutral text —
  by design it will need updating if the neutral text changes again; the
  `agent_message` off strings and the byte-identical unit test are the true
  invariants.
- `docs/feat/agent-message.md:165` and `docs/feat/models-map.md:537` still quote
  the old strings as history (deliberate: merged task docs record what was
  built then).

**How the implementing model behaved:** implemented as planned, two drifts
(wording of the neutral text after reading the repro output; positional
`twoWay` parameter), both recorded in Execution. Six mutations, all red; no
`git checkout`/`restore`/`stash` used anywhere (reverts by exact inverse edit,
re-read to prove byte-equality).

