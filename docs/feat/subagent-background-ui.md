# feat/subagent-background-ui — the background sub-agent, made visible (6a-2)

> **Status:** execution (Review pending — mandatory fresh-context, `load-bearing`)
> **Branch:** `feat/subagent-background-ui` — opened off `main` `f1ddfc5`, after 6a-1 `feat/subagent-background` merged (`cf96ef3`)
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** deepseek + Opus fresh review

## Context

*— claude-opus-5-5, 2026-11-09*

6a-1 (`docs/feat/subagent-background.md`) made a background sub-agent work: it launches, runs after its turn ends, wakes the agent with its report, holds a slot of the shared `subagents.maxParallel` cap and rides the shared broker for its asks. What it did **not** do is make it *visible*: a user cannot see that a child is running, the status line says nothing, quitting a session loses children with no warning, a pod relay can go idle while a child still needs the laptop for its model, and nothing (not even the model) can stop a stuck child before the session ends.

This task is **Part 2** of that plan, moved here verbatim (the plan's own instruction: "Move this Part to `docs/feat/subagent-background-ui.md` then"). Every `file:line` below was re-verified against this tree (6a-1 merged) and corrected where it had moved.

**Owner answers (binding):** Q1 → **(a)** build `agent_kill(id)` for the model in 6a-2 (Design 2, T50), wired only where `background` is. Q2 → **(b)** (already built in 6a-1): with `agent_kill` available, `refusal()` in `core/src/agent-jobs.ts` also offers "stop one with agent_kill" **when a background child is running**; the LOW-2 rule stays (no "end your turn" when only foreground holders fill the cap).

**Repro (capability gap, on this tree before the change).** There is no `subagents` update in the protocol, no `agent_kill` tool, and no background count anywhere in the TUI:

```
$ rg -c '"subagents"' packages/protocol/src/updates.ts packages/tui/src       → no matches
$ rg -n 'agent_kill' packages/                                        → no matches
$ rg -n 'backgroundSuffix|backgroundCount' packages/tui/src           → no matches
```

(`.tentacle/tmp/subagent-background-ui/` holds the slice repros; it is gitignored.)

## Implementation

*— claude-opus-5-5, 2026-11-09*

### Load-bearing assumption

A full-state update with coalescing can carry the live list without growing the ring while idle: an idle `recordCut(null)` after each frame brings the ring back under budget (probe F: 8092 → 568), and a child's activity reaches an idle client and a second attacher through the same two channels as `queued` (live frame + snapshot at the cut). Re-prove it with T42 before anything else.

### Preconditions

`queued` is the pattern (every citation re-verified on this tree, 6a-1 merged):

| Fact | Where |
|---|---|
| The update: full state, `display`, not turn-scoped | `packages/protocol/src/updates.ts:220-231` (doc + schema), `:312` (`UPDATE_CLASS`) |
| It rides the snapshot at the cut | `packages/protocol/src/session.ts:412-413` |
| The daemon keeps `lastQueued`, publishes on change, and records it in the cut | `packages/daemon/src/hosted-session.ts:385` (`lastQueued`), `:1124-1135` (`publishQueue`), `:1355-1364` (`recordCut`) |
| … and `snapshotPage` carries it, first page only | `packages/daemon/src/hosted-session.ts:1307,1323` |
| The client keeps it per session and fans it out | `packages/client/src/remote-client.ts:401` (`entry.queued`), `:810-819` (`onSessionQueued`, `queuedOf`), `:1847-1852` (`queuedChanged`), `:2068-2070` (a resync's snapshot), `:2237-2239` (a live frame) |
| `RemoteSession` mirrors it, giving the state at once | `packages/client/src/remote-session.ts:421-439` (`queued`, `onQueued`) |
| The "owned elsewhere" lists skip it | `packages/client/src/remote-session.ts:1293-1298`, `:1385-1392` |
| `mapping.ts` returns null for it | `packages/client/src/mapping.ts:279-281` |
| `maybeWake` already moves the cut while idle | `packages/daemon/src/hosted-session.ts:2023-2062` (`recordCut(null)` at `:2057`) |
| The attach path for unflushed exits does not depend on the replay, so moving the cut idle is safe | `packages/daemon/src/connection.ts:455-462` (`unflushedExits` read beside the replay) |
| Quit: the command step, its text, the TUI's handlers | `packages/tui/src/commands.ts:230-266` (`QuitCommandInput`, `quitCommandStep`, `quitConfirmText`); `packages/tui/src/App.tsx:589-593,1740-1765,2295-2301,2384-2395,2777-2778` |
| Status: a whole-or-dropped suffix, and the bar that renders it | `packages/tui/src/status-line.ts:119-120` (`suffix` in), `:185-190` (whole or `""`), `:274-279`; `packages/tui/src/components/StatusBar.tsx:58-112`; `packages/tui/src/App.tsx:2849-2859` |

### Design

1. Protocol (`updates.ts`, `session.ts`). `SubagentRowSchema = {id, callId, agentType, description, state: z.string(), toolUses, tokens, startedAt, tail: z.array(z.string())}`, strip, no `.max()` (a client bounds what a pod sends). `SubagentsUpdateSchema = {type:"subagents", agents: z.array(row)}`, class `display`. `SnapshotResultSchema.subagents` optional. No version bump.
2. `AgentJobs`: `progress(agentId, event: ToolProgressEvent)` folds `subagent_tool` (tail, last 8, `toolUses`) and `subagent_usage` (tokens); `onChange(listener)`, fired on start, progress, end; `rows()`; `startedAt` passed in by the host (the class stays clock-free). The tool's closure passes `onEvent: (e) => bg.progress(agentId, e)`. **If owner Q1 is (a):** `kill(id): boolean` aborts one child (the exit is `cancelled`), and `tools/src/background.ts` gains `agent_kill` beside `shell_kill`, wired only where `background` is.
3. Daemon. New pure `daemon/src/subagents-view.ts`: `subagentRows(jobs)`, labels through `wireLine(label, 200)`, and `sameRows(a, b)`. `HostedSession`: `lastSubagents` (`Cut.subagents`, set like `queued`), and `kickSubagents()`: a `setTimeout(250)`, one at a time, cleared in `close`. On fire: compare, `emit({type:"subagents", agents})`, then **`if (this.controller === null) this.recordCut(null)`**. A start and an end publish immediately, a burst of progress coalesces to ≤ 4/s. `snapshotPage` adds `subagents` beside `queued`.
4. Client. `SessionEntry.subagents`, `subagentsChanged`, `onSessionSubagents`, `RemoteSession.onSubagents` (mirror `onQueued`, the state at once). Add `subagents` to the two "owned elsewhere" lists (`remote-session.ts:1252-1256,1344-1350`) and to `mapping.ts:279`. Router-style bounding at the client: at most 32 rows, 8 labels, through `progressText`. `local-runtime.ts` passes `onSubagents` through.
5. Relay. `RelayEvent {type:"agents", n}`, `RelayModel.agents`; `relay.ts` subscribes `session.onSubagents`. `wantsAwake`: `(turn running || agents > 0) && asks === 0 && !stopping && handover !== "done"`: a child in a pod needs the laptop for its model.
6. TUI. Pure `tui/src/background-view.ts`: `backgroundCount(rows)` and `backgroundSuffix(count)` → ` · 2 sub-agents`. `StatusBar` gets `background` and puts it in front of `suffix`. `quitCommandStep` gains `agents`: `agents > 0 && !detaches && !confirmed` → `"confirm"`. `quitConfirmText({others, agents, names})`: `2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)`; with others, `1 other terminal attached · 2 sub-agents running — close the session for all? (y/N)`. New pure `ctrlCQuitStep(input)`: idle Ctrl+C with `agents > 0 && !detaches && !confirmed` → `"confirm"`. `App`: `quitConfirm` holds `{others, agents, names}`. SIGHUP cannot ask: the lost note covers it.

### Files (order)

`protocol/src/{updates,session}.ts`, schema · `core/src/agent-jobs.ts` · `tools/src/{task,background}.ts` · `daemon/src/{subagents-view (new),hosted-session}.ts` · `client/src/{remote-client,remote-session,mapping}.ts` · `cli/src/{local-runtime,relay,relay-state}.ts` · `tui/src/{background-view (new),commands,App,components/StatusBar}.tsx|ts` · `CHANGELOG.md` · `docs/feat/session-log.md` untouched.

### CHANGELOG (planned line, `### Added`)

"**See your background sub-agents.** The status line shows how many are running, and quitting a session that would lose them asks first." Plus: `agent_kill`.

### Failure modes

| Case | Converges to |
|---|---|
| A second TUI attaches mid-run | The snapshot carries the list at the cut; the replay and the next frame fix it |
| Older client, same protocol version | `display`: shows `unsupported` once, then nothing |
| A frame burst during a long foreground tool | Coalesced; the ring is pinned only since the last commit (bounded by activity) |
| Hostile pod sends a huge list | No schema bound by design; the client cuts to 32 rows and 8 labels |
| Session closes with a timer pending | Cleared in `close` |
| A row without a `tail` (malformed) | A known type failing its member is a stream error; the schema is lenient so only a type mismatch can do it, the same class as `tool_progress` |
| `connect` | Quitting only detaches: no confirm |
| Detached run's `/quit` | `endsSession`: asks with the count, then closes |

### Tests

| # | File · name | Property | Mutation |
|---|---|---|---|
| T42 | `daemon/subagent-progress` · "an idle child's tool events reach an idle client, and a later turn's stream carries none" (H1) | frames between turns; no `tool_progress` | stamp progress into the turn |
| T43 | · "bursts coalesce to ≤ 1 frame per 250 ms; start and end publish at once" | injected timers | no timer |
| T44 | · "the ring stays under budget while idle" | small `ringBytes`, 1000 progress events | drop the idle `recordCut` |
| T45 | · "a fresh attach gets the list from the snapshot" | | drop it from `snapshotPage` |
| T46 | `client` · "rows are bounded and sanitized" | | |
| T47 | `cli/relay-state` · "keeps awake while a child runs" | | |
| T48 | `tui/commands` · confirm for `/quit` and Ctrl+C; not on `connect`; the combined text | | drop the `detaches` check |
| T49 | `tui/background-view` + `app.test.tsx` frame · the count shows, and at 46 columns it is dropped whole | | |
| T50 | `tools` · `agent_kill` (only if Q1 is (a)) | kills, a second time says not running | |

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

As-built, in the plan's Files order. Scratch: `.tentacle/tmp/subagent-background-ui/` (gitignored; `mutate.ts` = replace once → run → restore → sha1 check). No git state changes, `TODO.md` untouched.

**Step 0 (doc).** `docs/feat/subagent-background-ui.md` created from `docs/TASK-TEMPLATE.md`; Part 2 moved here verbatim and replaced in `docs/feat/subagent-background.md` by a pointer (one line + signature). Every Preconditions `file:line` re-verified against this tree (6a-1 merged) and **corrected** where it had moved — the pre-6a-1 citations pointed at `client/src/connection.ts` (there is no such file: the `unflushedExits` read is `daemon/src/connection.ts:455-462`), at `hosted-session.ts:1119-1143` for `publishQueue` (now `:1124-1135`), at `status-line.ts:36-58` for a `dropWhole` helper (there is none — the suffix is dropped inline at `:185-190`), and at `App.tsx:2845-2855` for the bar (now `:2849-2859`). No step contradicted the code; nothing had to be re-planned.

**Repro (capability gap, before any edit).** `rg -c '"subagents"' packages/protocol/src/updates.ts packages/tui/src` → no matches; `rg -n 'agent_kill' packages/` → no matches; `rg -n 'backgroundSuffix|backgroundCount' packages/tui/src` → no matches. The tests below were then RED on the missing symbols (`Export named 'ctrlCQuitStep' not found`, `Cannot find module '../src/subagents.ts'`, `Cannot find module '../src/subagents-view.ts'`).

1. **Protocol** (`packages/protocol/src/session.ts:406-431,443`, `updates.ts:112,239-251,267,313`): `SubagentRowSchema` (strip, **no `.max()`**: a pod is not trusted, the client bounds), `SubagentsUpdateSchema`, `UPDATE_CLASS.subagents = "display"`, `SnapshotResultSchema.subagents` optional. **No version bump** (`PROTOCOL_VERSION` stays 20 — pinned by the test). `bun run schema:export` → `schema/protocol.json` +79 lines. Test `protocol/test/subagents-update.test.ts` (6; RED on 5 assertion failures + 1 error) — GREEN.
2. **Core — `AgentJobs`** (`core/src/agent-jobs.ts:70-107,120-133,140-216,272-290`): `AgentJobRow`, `AGENT_ROW_TAIL_MAX = 8`, `rows()`, `progress()` (folds `subagent_tool` → tail + `toolUses`, `subagent_usage` → `tokens`; unknown/ended id is a no-op; never throws), `onChange()`, `kill(id)` (aborts the child's own controller; a second call says not running), `AgentJobHost.now?()` (the class keeps **no clock**), and `drive` reporting a killed child as `cancelled` whatever its run said. `refusal()` (owner Q1 a + LOW-2 kept): offers `agent_kill` **only** when `this.running.size > 0`; foreground-only holders keep the "Retry when the running foreground sub-agents return" wording with neither "end your turn" nor `agent_kill`. Test `core/test/agent-jobs-progress.test.ts` (10; RED on 9 — the LOW-2 case passes on the old code by design, it pins preserved behaviour) — GREEN.
3. **Tools** (`tools/src/background.ts:73-100` — `createAgentKillTool` at `:86`): `createAgentKillTool(jobs)` beside `shell_kill`; `tools/src/task.ts:209-212` passes `onEvent` into the child's run so its activity reaches `progress`. Tests `tools/test/agent-kill.test.ts` (5; RED on the missing export) — GREEN.
4. **Daemon** (`daemon/src/subagents-view.ts` (new), `hosted-session.ts:232-233,397-399,572,645-653,1156-1215,1400,1440,2402,2495-2497`): `subagentRows`/`sameRows` (labels through `wireLine(…, 200)`), `Cut.subagents`, `lastSubagents`, `kickSubagents()` (`:1165`; a start or an end publishes **at once** — detected by a structural change of the id list — a progress event coalesces on a 250 ms timer, one at a time), `publishSubagents()` (`:1196`; `emit` then, **idle only**, `recordCut(null)` at `:1209`), `snapshotPage` carries the list on the first page (`:1400`), `close` clears the timer and the new subscription (`:2495-2497`). Test `daemon/test/subagent-progress.test.ts` (8: T42, T43, T44, T45 + the view's sanitizing/comparison; RED on the missing module, then on the missing frames) — GREEN.
5. **Client** (`client/src/subagents.ts:36,41` (new), `remote-client.ts:190-198,359,416,835-844,1886-1893,2110-2116,2280-2282,2438`, `remote-session.ts:426-446,452-472,1300,1392`, `mapping.ts:279-287`): `boundSubagents` (≤ 32 rows, ≤ 8 labels, every string through `progressText` + `trim` — a stripped newline leaves padding otherwise), `SessionEntry.subagents`, `onSessionSubagents`/`subagentsOf`, `subagentsChanged`, the resync snapshot, the live frame, `RemoteSession.subagents`/`onSubagents`, and `subagents` in both "owned elsewhere" lists + `mapping.ts`. Tests `client/test/subagents.test.ts` (7: T46 ×5, T46b ×2) — RED on the missing module, then on the missing members.
6. **CLI** (`cli/src/wiring.ts:64,557-561`, `local-runtime.ts:240-241,484-486`, `relay-state.ts:34-36,63,76,86,145-146,222,239,297-307`, `relay.ts:427-432,589`): `agent_kill` registered **only** where `background` is; `onSubagents` passed through the persisting controller; `RelayEvent {type:"agents"}` + `RelayModel.agents`; `tick`'s `idle` requires `agents === 0`; `relayView`'s `running` detail; `wantsAwake` = `(turn running || agents > 0) && asks === 0 && !stopping && handover !== "done"`; `relay.ts` subscribes `session.onSubagents` and unsubscribes at the end. Tests `cli/test/relay-state.test.ts` (T47 ×2, RED on the missing event), `wiring.test.ts` (the tool list gains `agent_kill`, and it is absent with sub-agents off) — GREEN.
7. **TUI** (`tui/src/background-view.ts:20,25,33` (new), `commands.ts:226-243,250-278,280-326`, `components/StatusBar.tsx:3,62,84,103,120`, `App.tsx:90,282-287,600-610,620-626,1490-1502,1755-1780,2325-2360,2440-2460,2900-2910`): `backgroundCount`/`backgroundSuffix`/`backgroundNames`; `quitCommandStep` gains `agents` (`agents > 0 && !detaches && !confirmed` → `confirm`); `quitConfirmText({others, agents, names})`; new pure `ctrlCQuitStep`; `StatusBar` puts the count **in front of** the scroll hint (both whole-or-dropped by `statusLayout`); `App` holds `{others, agents, names}`, subscribes `onSubagents`, and Ctrl+C goes through `ctrlCQuitStep`. Tests `tui/test/background-view.test.ts` (T49 ×3), `quit-agents.test.ts` (T48 ×9), `components.test.tsx` (T49's frame), `run-quit.test.tsx` (T49/T48 ×3 through the real App) — RED first on the missing exports/members.
8. **Docs**: this doc, `docs/feat/subagent-background.md` (Part 2 → the pointer), `CHANGELOG.md` `[Unreleased]`/`Added` (the planned line, plain language, plus `agent_kill` and the relay's keep-awake).

### Drift from the Implementation (each with the reason)

- **`planned line, plain language` — one entry, expanded.** The CHANGELOG line the plan names is there first ("**See your background sub-agents.** The status line shows how many are running (`· 2 sub-agents`), and quitting a session that would lose them asks first …"), with `agent_kill` and the relay keep-awake in the same bullet: they are the same user-visible addition, and a second bullet would have repeated it. One bracketed example was added (the plan's own text), so the format is "plain language + what the user will see".
- **`Cut.subagents` is `readonly SubagentRow[]` (empty, never absent).** The plan says "set like `queued`"; `queued` has an `EMPTY_QUEUE` constant, so the empty array is its analogue. It also removes the `undefined` branch from `snapshotPage`.
- **`start` and `end` detect themselves; there is no `now` flag.** The plan says "a start and an end publish immediately, a burst of progress coalesces"; rather than special-casing call sites, `kickSubagents()` compares the ids against what clients last saw — a structural change is published at once, anything else coalesces. Same behaviour, one entry point (`onChange` alone), so no caller can forget.
- **`emit`-then-`recordCut` order the plan states is kept exactly** (frame first, cut second, idle only): a client that attaches between the two reads the list in the snapshot AND gets it in the replay — idempotent (a full state), never a gap.
- **`owned elsewhere` — the plan says "two lists at `remote-session.ts:1252-1256,1344-1350`"**: both are `subagents`-aware now (`:1300`, `:1392`); the line numbers moved with 6a-1's edit.
- **A second Ctrl+C while the quit confirmation is up now LEAVES.** Not in the plan; found by the App-level test. The dialog answered every key with "no", so the very key that raised it (`Ctrl+C`) could only ever dismiss it — a trap. `Ctrl+C` is now a quit request there too (`confirmed: true`, `exitPending` set), so the second press exits. `/quit` typed twice behaves as before (typing goes to the input, not the dialog).
- **`background-view.ts` does not import `@tentacle/protocol`.** The TUI has no dependency on it (`send-now.ts` mirrors what it needs, and says so); the row type is a local `BackgroundAgentRow { id }` (the count and the ids are all this module reads). The first draft imported `SubagentRow` and would have added a dependency the package does not have.
- **`progress` is called from `task.ts`'s closure via `onEvent`** — as planned — and `AgentJobs.progress` also counts `toolUses` (the plan says "tail, last 8, `toolUses`"; the count is of `subagent_tool` events, which is what the child's own `subagent_end` reports as its tool uses).
- **`residentUseOf`/`exitPlan` were NOT changed.** The plan's Design 5 names `wantsAwake` only; `summary().jobs` already counts children (6a-1), so the relay's idle exit and `--rm` delete already see them — T47's second half pins the `tick` side of it.

### Mutations (§9): one per load-bearing property, `mutate.ts`, sha1 checked after each

| Property | Mutation | Result |
|---|---|---|
| T50 kills (owner Q1 a) | drop `entry.controller.abort()` from `kill` | **KILLED** |
| T50's exit is `cancelled` | `stopReason = result.stopReason` (no kill override) | **KILLED** |
| T50 says "not running" the second time | drop the `entry.killed` guard | **KILLED** |
| T50's tool reports it | always say `killed …` | **KILLED** (3) |
| `agent_kill` offered only when it helps | `running.size >= 0` (always) | **KILLED** |
| T42 reaches an idle client | drop the `onChange` subscription | **KILLED** (5) |
| T43 coalesces | publish synchronously, no timer | **KILLED** |
| T44 ring bounded while idle | drop the idle `recordCut(null)` | **SURVIVED at first** — the first T44 asserted `ring.bytes <= 3×budget` with a small frame, so eviction under the budget never mattered. Rewritten to push a burst whose single frame is **larger than the whole budget** (30 rows × 300-char labels) and assert `<= 2048`: **KILLED** |
| T45 fresh attach | drop `subagents` from `snapshotPage` | **KILLED** (2) |
| T46 rows bounded | `rows.map(boundRow)` (no slice) | **KILLED** (2) |
| T46 tail bounded | `row.tail.map(clean)` (no slice) | **KILLED** |
| T46 the live frame is applied | drop the `subagents` branch in `deliver` | **KILLED** |
| T47 keeps awake | `model.turn === "running"` only | **KILLED** |
| T47 holds the idle exit | `idle` without `agents === 0` | **KILLED** |
| T48 `detaches` check | `input.agents > 0 && !input.confirmed` | **KILLED** (2) |
| T48 Ctrl+C's `detaches` check | drop it | **KILLED** |
| T49 the bar shows it | `suffix` instead of `withAgents`; `withAgents = suffix` | **KILLED** each |
| T49 the App subscribes | `agentsSubRef.current = null`; `background={0}` | **KILLED** (3 and 1) |

Every mutation was restored and sha-checked (`sha OK` on every line above); `git status` was unchanged afterwards.

### Not done / not verified (explicit)

- **No live check** with a real model, a real pod/TUI, or a real detached relay: nothing was run against a provider or a terminal. The relay's keep-awake is pinned at the pure `wantsAwake`/`tick` level and wired in `relay.ts`, not observed through `caffeinate`.
- **`agent_kill`'s effect on a real child's model call**: the tests kill a scripted run and assert its signal aborts, its exit is `cancelled` and its row disappears. That a provider request in flight is actually torn down is the runner's own abort path (6a-1, T15), not re-tested here.
- **The 250 ms figure is not a wire constant**; it is one exported constant (`SUBAGENTS_COALESCE_MS`) that the tests import, so a change is visible in both places by construction.
- **`session/list`'s `jobs` and the relay's `exitPlan`** were left as they are (see Drift): the count already includes children from 6a-1, so no new test was added for the `--rm` delete with a child (6a-1 declared the same gap: its T39 was dropped).

### Gate

From the worktree root, after the last change:

- `bunx tsc --noEmit` → clean (no output). `bunx tsc -p apps/mobile` → clean.
- `bunx biome check .` → `Checked 791 files … No fixes applied.` (0 errors, 0 warnings: the baseline is kept).
- `bun run schema:export` re-run → `packages/protocol/schema/protocol.json` regenerated (+79 lines); the drift gate inside `bun test packages` is green.
- `bun test packages` → **6066 pass, 3 skip (the opt-in live-k8s / live-docker / slow keepalive), 1 fail** on the first run; the failure was `daemon/test/mapping.test.ts`'s "covers every known type", which requires a sample of every `UPDATE_CLASS` member — the new `subagents` type was missing from its list. Added (17 lines, the sample) → re-run: **6067 pass, 3 skip, 0 fail**, 6070 tests in 416 files, 177 s (exit 0).

## Review

*— claude-opus-5-5, 2026-11-09* (fresh context; a different model family from the executor, deepseek-v4.1-flash)

**Verdict: REQUEST-CHANGES.** 2 HIGH · 2 MEDIUM · 4 LOW · 6 nit. One owner question. The display pipeline itself holds (load-bearing assumption, protocol, client bounding, relay convergence). What fails is who gets `agent_kill` and what the quit dialog does when another terminal is on the session.

### Gate (re-run by me, on HEAD `a6f1126`)

`bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bun run lint`: 791 files, no fixes · `bun test packages`: **6067 pass, 3 skip (the opt-ins), 0 fail**, 6070 tests in 416 files. Tree byte-identical after every mutation (`git status --short` empty).

### Findings

**HIGH-1. `agent_kill` is given to every child, so a sub-agent can kill its siblings with no prompt. Breaks owner Q1 ("wired only where `background` is").**
`packages/cli/src/wiring.ts:557` registers it in the shared registry that `createSubagentRunner` reads, and `packages/agent/src/subagent.ts:248` drops only the spawn tool and `context_reset` (a `tools: "all"` type inherits the rest). `permission: "none"`, and ids are sequential (`sa-1`).
Repro (registry shaped as in `wiring.ts`; `sa-2`'s model calls `agent_kill{agent_id:"sa-1"}`): `{"jobId":"sa-1","status":"killed","agent":{"stopReason":"cancelled"}}`.
*Fix:* in `packages/tools/src/background.ts` add `export const AGENT_KILL_TOOL_NAME = "agent_kill";`, use it for the tool's `name`, and export it the way `CONTEXT_RESET_TOOL_NAME` is. In `subagent.ts:21` import it, and at `:248` add `|| tool.name === AGENT_KILL_TOOL_NAME` (update the comment). *Test* (`packages/agent/test`, or the daemon rig with the shared-registry shape): a `tools: "all"` child's request has no `agent_kill`, even in a registry that holds it. Show it red first.

**HIGH-2. An idle Ctrl+C with another terminal on the session raises a false dialog whose `y` closes the session for that other terminal, unannounced.**
`packages/tui/src/commands.ts:322` (`ctrlCQuitStep` has no `others`), `packages/tui/src/App.tsx:2452` region (`setQuitConfirm({ others: 0, … })`), `App.tsx:2329` (`y` always calls `closeForAll`). A Ctrl+C with others attached only detaches (`ifLast`; `packages/cli/src/attach-run.ts:593-594`: "a Ctrl+C closes nobody else's session"), so nothing is lost and the text is untrue.
Repro through the real `App` (`othersOnSession: () => 1`, one child, Ctrl+C, then `y`): dialog `1 background sub-agent (sa-1) will be lost — quit? (y/N)`, then `runQuit` calls `["closeForAll"]`.
Secondary effect: `y` on an agents-only `/quit` (`others: 0`) now also sets `closeForAll`, which skips the "someone registered meanwhile" re-check at `attach-run.ts:611`.
*Fix:*
1. `CtrlCQuitInput` gains `readonly others: number;`; the guard in `ctrlCQuitStep` becomes `input.agents > 0 && input.others === 0 && !input.detaches && input.confirmed !== true && !input.exitPending`.
2. Both `ctrlCQuitStep` calls in `App.tsx` pass `others: runQuit?.othersOnSession() ?? 0`.
3. `App.tsx:2326-2330`: read `const facts = quitConfirmRef.current;` before `setQuitConfirm(null)`, and on "yes" call `runQuit?.closeForAll()` only `if (facts.others > 0)`.

*Tests:* `quit-agents.test.ts`: `others: 1, agents: 2`, idle → `"exit"`. `run-quit.test.tsx`: `runQuitSpy(1)` + Ctrl+C → exits, no dialog, `spy.calls` empty; `runQuitSpy(0)` + `/quit` + `y` → no `closeForAll`. Red first.

**MEDIUM-1. `startedAt` is always 0 on the wire. Design 2 ("passed in by the host") is not implemented, and Execution does not say so.**
`AgentJobHost.now?` exists, but `agentRuntime?.bind({...})` at `packages/daemon/src/hosted-session.ts:625-637` never provides it. Repro with the host clock returning 1234: first row `startedAt: 0`.
*Fix:* add `now: () => this.now(),` to that object. *Test* in `daemon/subagent-progress`: `rig({ now: () => 1234 })`, the row's `startedAt` is 1234.

**MEDIUM-2. The guard the plan's load-bearing assumption depends on is untested.** Mutation R1 below (`recordCut` also mid-turn) SURVIVED, yet moving the cut mid-turn breaks the cut invariant (`history` must reflect every emit).
*Test to add:* a turn held on a model gate with a child progressing; after a `subagents` frame arrives, `hosted.historyCut.seq` is unchanged and lower than that frame's seq. Must fail under R1.

**LOW-1. A throw escapes the coalescing timer; `publishSubagents`' "Never throws" is false.** `hosted-session.ts:1185-1188` calls it bare, and `recordCut` at `:1209` is outside the `try`. Repro: `log.commit` throwing gives an uncaught error with `at publishSubagents … hosted-session.ts:1209` on stderr. (The process did continue in that script on Bun 1.4.3.)
*Fix:* in the timer body, `try { this.publishSubagents(); } catch (error) { this.reportTurnError(error); }`. *Test:* inject the throw, wait one window; `bun test` fails on an uncaught error.

**LOW-2. The quit dialog is not one row, though the layout reserves one.** `QUIT_CONFIRM_ROWS = 3` (`packages/tui/src/components/QuitConfirm.tsx:6`), and `commands.ts` joins all names unbounded. At 80 columns, 8 normal ids render 4 rows; 32 hostile 200-char ids (they pass the client's bound) render 98 rows.
*Fix:* in `quitConfirmText`, `const shown = names.slice(0, 3).map((n) => n.slice(0, 12));` and append ` +${names.length - 3}` when more; `QuitConfirm.tsx:23`: `<Text color={t.quit} wrap="truncate-end">`. *Test:* 32 long names → the frame has 3 rows.

**LOW-3. Two more survived mutations.** R2 (structural check by length only): add "an end and a start in the same window publish at once" (`cap: 1`; the new id's frame arrives before a window elapses). R3 (no `clearTimeout` in `close`): add "close clears a pending kick" (a progress event, `close()`, `priv.subagentsKick === null`).

**LOW-4. The whole `App` re-renders on every frame (up to 4/s, idle too), though it only reads the count and ids.** `App.tsx:627-630`. *Fix:* add a pure `sameIds(a, b)` to `background-view.ts` (+ a test); `setAgents` always updates the ref but calls `setSubagents` only when the ids differ.

**Nits** (each a one-line edit):
1. `packages/client/src/remote-session.ts:473`: a line break was lost inside the comment (`Each   * row`). Restore the two lines.
2. `hosted-session.ts:639-640`: remove `this.kickSubagents()` and its comment. `drive` has already published the end through `changed()`, so this only arms a timer that sends nothing.
3. `commands.ts:280`: drop the `number |` shim; `commands.test.ts:180-181` pass `{ others, agents: 0, names: [] }`.
4. `commands.ts`: blank line missing before the doc comment after `ctrlCQuitStep`.
5. `CHANGELOG.md:32`: delete "(Seeing them running, and stopping one, come next.)", now shipped in the same `[Unreleased]`.
6. `App.tsx:2333-2336`: the comment says a press "asks again and the one after it leaves"; the code leaves on that press. `QuitConfirm.tsx:9`: the doc still says "with other terminals" only. Update both once the owner question is settled.

### Owner question

**Q. What should Ctrl+C do at the quit dialog?** As built (declared drift) it no longer means "no". Idle, it exits, so Ctrl+C Ctrl+C loses the children with no `y`. Mid-turn, it stops the turn AND schedules the exit, silently (no notice, unlike `requestQuit`). It also applies to the pre-existing others dialog. `quitConfirmKey`'s contract says only `y` closes, and the permission dialog's Ctrl+C means "stop", never "quit". The "trap" the executor cites is not one: any key dismisses and `y` leaves.
- **(a) Ctrl+C = No** (dismiss only, as before 6a-2). The double-tap asks again. Safe, and the text `(y/N)` stays true; a user must press `y` to lose children.
- **(b) Keep as built.** Double Ctrl+C always leaves, the shell convention, at the cost of the protection against exactly that reflex. Should at least push the `requestQuit` notice mid-turn.
- **(c) Hybrid.** A dialog raised by Ctrl+C: a second Ctrl+C leaves. A dialog raised by `/quit`: Ctrl+C = No. Needs one more field in the dialog state.

**Recommendation: (a).** The loss is irreversible, the dialog exists to catch an accidental Ctrl+C, and it is the smallest change (delete `App.tsx:2333-2355`; update the `run-quit.test.tsx:464` test).

**Owner (2026-11-09): (a).** Ctrl+C at the quit dialog is **No** — dismiss only, as before 6a-2. Applied in Fix round 1: the exit-on-second-Ctrl+C path is gone and the test it named now pins dismissal (then re-ask, then `y` to leave).

### Premise table (citations opened on the base `f1ddfc5`)

| Premise | Result |
|---|---|
| Capability gap: no `"subagents"` / `agent_kill` / `backgroundSuffix` on the base | TRUE (re-run, no matches) |
| `updates.ts:220-231,312`; `session.ts:412-413` | TRUE (`:228`, `:312`, `:413`) |
| `hosted-session.ts:385`, `:1124`, `:1323`, `:1355`, `:2057` | TRUE |
| `remote-client.ts:401,810,1847,2069,2237` | TRUE |
| `remote-session.ts:430,1297,1390`; `mapping.ts:281` | TRUE |
| `connection.ts:460` (`unflushedExits` read beside the replay) | TRUE |
| `commands.ts:247,263` | TRUE |
| Design 2: `startedAt` passed in by the host | FALSE as built (MEDIUM-1) |

### Mutations (`mutate.ts`, sha OK every time)

| Mutation | Result |
|---|---|
| m44: drop the idle `recordCut` (T44, first survived) | KILLED (ring 867581 > 2048) |
| m50a: drop `abort` in `kill` | KILLED (2) |
| m46a: no row slice | KILLED (2) |
| m47a: keep awake on `turn` only | KILLED (1) |
| R1 (mine): `recordCut` also mid-turn | **SURVIVED** (MEDIUM-2) |
| R2 (mine): structural check by length only | **SURVIVED** (LOW-3) |
| R3 (mine): no `clearTimeout` in `close` | **SURVIVED** (LOW-3) |
| R4 (mine): snapshot path unbounded | KILLED (1) |

### Attacks tried

1. **Idle cut vs a concurrent turn.** Holds. `prompt` sets `controller` synchronously (`hosted-session.ts:1626-1630`), compaction holds it too (`:2337`), and `finishTurn` clears it and records in one stretch, so a 250 ms timer cannot land in a gap.
2. **Idle cut vs replay.** Holds. A pending background ask is re-offered at every attach before the replay is computed (`:1313`); unflushed exits ride `OpenResult`. `recordCut` idle is O(n) pointer compares; `verifyLog` runs only in tests.
3. **`tool_progress` leak into a later turn.** None. The background branch hands the child only `bg.progress`; T42 pins it.
4. **Coalescing.** One timer, cleared in `close`; an end + a new start in one window is correct by inspection (ids compared by index; ids never repeat), though untested (LOW-3). Throw path: LOW-1.
5. **Hostile pod.** Bounded on the client on both paths (`deliver`, snapshot): 32 rows, 8 labels, `progressText` strips C0/C1 including ESC. Relay and second attacher read the same bounded entry. Only leftover: dialog height (LOW-2).
6. **Relay keep-awake convergence.** A stale count ends with the link: `stopped` sets `exitNow`; a restarted daemon's snapshot gives `[]`; `handover: "done"` and `stopping` release it. A session closed under a live link leaves no `[]` frame, but I found no non-hostile path to that, and a hostile pod can already pin the relay with a `turn_start` that never ends: no new class. `record` dedupes by view, so frames do not write `owner.json`.
7. **`agent_kill`.** Exit `cancelled` exactly once with `status: killed` (repro), a `subagent_end` through `agentEnded` (`:1511-1516`), slot released in `drive`; unknown or finished id → "was not running". Own-children scope fails: HIGH-1.
8. **Quit paths.** `connect` never asks (`detaches`); a detached run's `/quit` asks with the count. Ctrl+C with others: HIGH-2.
9. **Protocol.** `display` is the right class (full state, also in the snapshot, nothing waits on it), so no bump. Both ends and `mapping.ts` are wired, `protocol.json` regenerated, and an older client gets `unsupported` once per kind (`session-reducer.ts:102`).

### Accepted, not findings

A long foreground tool with a chatty child pins `subagents` frames until the next commit: at the worst case (≤ 4 frames/s, ~2 KB per row) a pinned ring can pass its 4 MiB budget in minutes, while realistic child activity is far below that. The plan accepted this ("bounded by activity"); worth watching in 6b. Undeclared minor drift: T43 uses real timers, not the planned injected ones.

### How the executor behaved

Solid and honest on the mechanical parts: it corrected the plan's stale citations, reported T44's first survival and rewrote the test rather than hiding it, listed what it did not verify, and left a green gate. Its blind spots are the ones a pure-function level of testing leaves: it never traced what the registry hands a child, or what `runQuit`'s `closeForAll` means on the Ctrl+C path, and it shipped the `now` seam for `startedAt` without wiring it or having one test observe the value. It tested the mutations it thought of, not the guards the design hangs on (R1), and it took a behaviour decision on the dialog itself, though it did declare it.

### Review round 2

*— claude-opus-5-5, 2026-11-09* (scope: `git diff 536612e..HEAD` only; written here, in the Review section, so it sits before the fix round it judges)

**Verdict: PASS.** Every round-1 finding holds, and owner answer (a) is applied. The fix round introduced no defect: 3 new nits only, none blocking.

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bunx biome check .` 791 files, no fixes · `bun test packages` **6080 pass, 3 skip (the opt-ins), 0 fail**, 6083 tests in 416 files.

| Finding | Result |
|---|---|
| HIGH-1 child gets `agent_kill` | **Holds.** Dropped in the child filter (and in `readOnlyType`), by the shared constant. Mutation (filter removed): KILLED, the child is offered `agent_kill`. |
| HIGH-2 Ctrl+C with others | **Holds.** `others === 0` in the guard, so Ctrl+C with another terminal leaves with no dialog; `closeForAll` only when `facts.others > 0`, read before the dialog is cleared. Mutation (`y` always closes for all): KILLED. |
| MEDIUM-1 `startedAt` | **Holds.** `now` is bound to the host. Mutation (line removed): KILLED (`Received: 0`). |
| MEDIUM-2 guard untested (R1) | **Holds.** Mid-turn test on `historyCut`. R1 re-run: KILLED (`Expected: 5, Received: 6`). |
| LOW-1 throw from the timer | **Holds.** The timer body is guarded and reaches `onTurnError`; the doc comment was left false (new nit 2). |
| LOW-2 dialog height | **Holds.** 3 names, 12 chars each, ` +N`, `truncate-end`; pinned at 3 rows. Below ~60 columns `(y/N)` is cut, as specified. |
| LOW-3 survived mutations | **Holds.** R2 re-run: KILLED. R3 re-run: KILLED. |
| LOW-4 re-render per frame | **Holds.** `sameIds` gates the state, the ref is always updated; a Profiler count pins it. |
| Nits 1-6 | **Hold**, all applied. |
| Owner question: Ctrl+C = No | **Holds.** The exit branch is deleted; the test walks dismiss → re-ask → `y`. Mid-turn it no longer stops the turn. |

All six mutations were run with the executor's rewritten `mutate.ts` (read first: it restores and sha-checks), `sha OK` on each; `git status --short` was empty before this edit.

**New findings (nits, may ride the merge or the next task):**
1. `packages/tui/src/commands.ts:328,344`: `CtrlCQuitInput.confirmed` is dead since the dialog branch was deleted (`App.tsx` never passes it). Delete the field, the `input.confirmed !== true &&` line, the words "and an already-confirmed quit" in the doc comment at `:336`, and the `confirmed: true` case in `quit-agents.test.ts`.
2. `packages/daemon/src/hosted-session.ts:1203-1204`: `publishSubagents` still says "Never throws". Replace with "A sink error is reported, as `emit`'s; a failure of the idle `recordCut` reaches the caller (both callers guard it)."
3. `packages/daemon/test/subagent-progress.test.ts`: blank line missing before `describe("the view: …`; `childStop` in the MEDIUM-2 test is unused (delete it and its `resolve`).

**Note for 6b, not a finding:** with `sameIds` gating the state, `subagents` holds stale non-id fields by design (only the count and ids are read today). A panel that renders `tail` or `tokens` must read fresher state and revisit that gate.

## Execution — Fix round 1

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

All 14 findings (2 HIGH · 2 MEDIUM · 4 LOW · 6 nit) fixed, plus the owner answer. Every finding got a test **red for the stated reason first**, then the fix, green; every HIGH/MEDIUM got one mutation (cp-style backup → mutate a literal → run → restore → sha1 check, `.tentacle/tmp/subagent-background-ui/mutate.ts`) and is **KILLED**. The review's two SURVIVED mutations (R1, R2, R3) each have their missing test and are now KILLED too. No git state change, `TODO.md` untouched.

### Findings

**HIGH-1 — a child can no longer kill its siblings.** Root cause: the shared registry (`wiring.ts:557`) holds `agent_kill`, and `createSubagentRunner` only dropped the spawn tool and `context_reset`, so a `tools: "all"` child inherited a `permission: "none"` kill over sequential ids.
- `packages/tools/src/background.ts:73` — `AGENT_KILL_TOOL_NAME` exported beside `CONTEXT_RESET_TOOL_NAME`; `:90` the tool uses it.
- `packages/agent/src/subagent.ts:21` (import), `:246-258` (the child's filter drops it too; the comment now says why), `:360-370` (`readOnlyType`: never given to a child, so it makes one no less read-only).
- Redevelop no `permission-gate` case needed: `permission: "none"` never asks.
- **RED** (`packages/agent/test/subagent.test.ts:296-328`, registry shaped as `wiring.ts` shapes it — spawn tool + `agent_kill` + `tools: "all"` child):
  `error: expect(received).not.toContain(expected) / Expected to not contain: "agent_kill" / Received: [ "fs_read", "shell", "agent_kill" ]`
- **Mutation** (drop `|| tool.name === AGENT_KILL_TOOL_NAME`): `(fail) … a child is never offered agent_kill` → **KILLED**, `sha OK (efd61bb14157)`.

**HIGH-2 — an idle Ctrl+C with another terminal on the session asked a false question.** Root cause: `ctrlCQuitStep` had no `others`, so it raised the child dialog while Ctrl+C only detaches; and `y` on it unconditionally called `closeForAll`, skipping `attach-run`'s "someone registered meanwhile" re-check.
- `packages/tui/src/commands.ts:317-355` — `CtrlCQuitInput.others` (`:324`), guard `:342` `agents > 0 && others === 0 && !detaches && confirmed !== true && !exitPending`.
- `packages/tui/src/App.tsx:2446-2451` — the live Ctrl+C raises it with `others: runQuit?.othersOnSession() ?? 0`; the `stop` branch keeps the turn's save first.
- `App.tsx:2344-2352` — `const facts = quitConfirmRef.current` read **before** `setQuitConfirm(null)`; `closeForAll()` only `if (facts.others > 0)`. `/quit`'s own dialog (`:1792`) already passes the real count.
- **RED** (`packages/tui/test/quit-agents.test.ts`): `Expected: "exit" / Received: "confirm"`. `run-quit.test.tsx`: `expect(received).not.toContain(…)` received the real frame `1 background sub-agent (sa-1) will be lost — quit? (y/N)`, and the agents-only-`/quit` case `expect(received).toEqual(expected)` on `spy.calls` (it contained `closeForAll`).
- **Mutations**: drop `input.others === 0 &&` → **KILLED** (`sha OK e983d8d05d5c`); drop the `facts.others > 0` gate → **KILLED** (`sha OK 6ba04f6726ea`).

**MEDIUM-1 — `startedAt` reaches the wire.** `packages/daemon/src/hosted-session.ts:626-628` — `now: () => this.now()` added to `agentRuntime?.bind({…})` (Design 2's "passed in by the host").
- **RED** (`daemon/test/subagent-progress.test.ts`, `rig({ now: () => 1234 })`): `Expected: 1234 / Received: 0`. **GREEN.**
- **Mutation** (drop the `now` line) → **KILLED**, `sha OK (5f5519527063)`.

**MEDIUM-2 — the guard the load-bearing assumption rests on is now tested** (review mutation R1).
- Test `daemon/test/subagent-progress.test.ts`: the parent turn is parked at a model gate, a child start/progress frame arrives mid-turn, and `historyCut.seq` must equal the pre-frame value **and** be `<` the frame's `seq`.
- **Mutation R1** (`recordCut(null)` unconditional — the review's exact mutation that SURVIVED): `Expected: 5 / Received: 6` → **KILLED**, `sha OK (5f5519527063)`.

**LOW-1 — a throw can no longer escape the coalescing timer.** `hosted-session.ts:1187-1196` — the timer body wraps `publishSubagents()` in `try { … } catch (error) { this.reportTurnError(error); }`; the false "Never throws" claim on `publishSubagents` is now true for that path too.
- **RED**: the repro's exact stack, `error: commit exploded … at recordCut … at publishSubagents … hosted-session.ts:1212` (uncaught). **GREEN**: the injected `onTurnError` policy receives it.
- **Mutation** (remove the try/catch): the same uncaught error → **KILLED**, `sha OK (3955c386a684)`.

**LOW-2 — the dialog is one row.** `commands.ts:273-311` — `quitConfirmText` takes `QuitConfirmFacts` and bounds its own line (`QUIT_NAMES_SHOWN = 3`, `QUIT_NAME_MAX = 12`, then ` +N`); `components/QuitConfirm.tsx:25` — `wrap="truncate-end"`. `QUIT_CONFIRM_ROWS = 3` is now true whatever a hostile pod sends.
- **RED** (`theme-components.test.tsx`, a 10 000-char id at 80 columns): `Expected: 3 / Received: 128` rows with the wrap removed; the pure test was red on the unbounded string (`10 820` chars). **GREEN**: 3 rows, truncated.

**LOW-3 — the two survived counting/timer mutations now have tests** (`daemon/test/subagent-progress.test.ts`).
- R2 (structural check by **ids**, not length): `an end and a start that collapse into ONE kick publish at once` — same length, different ids ⇒ published at once. **RED/R1-mutated** (`Expected: 2 / Received: 1`) → **KILLED** (`sha OK 3955c386a684`).
- R3 (`clearTimeout` in `close`): `close clears a pending kick` asserts `priv.subagentsKick === null` after `close()`. **Mutated** (drop the block) → `Received: Timeout (#10)` → **KILLED** (`sha OK 3955c386a684`).

**LOW-4 — an unchanged report no longer re-renders the App.** `background-view.ts:37-58` — pure `sameIds(a, b)`; `App.tsx:633-643` — `setAgents` always updates the ref (the key handler and `requestQuit` read it) and calls `setSubagents` only when the ids differ.
- **Test** (`run-quit.test.tsx`, a real `React.Profiler` commit count, not a predicate): two further identical reports add **no** commit; a real change does.
- **Mutation** (`setSubagents(rows)` unconditionally) → `Expected: 3 / Received: 5` commits → **KILLED** (`sha OK 6ba04f6726ea`).

**Nits.** 1 `client/src/remote-session.ts:473-474` — the lost line break restored. 2 `hosted-session.ts:641-644` — `this.kickSubagents()` removed from the exit handler (`drive` already published the end via `changed()`); comment says so. 3 `commands.ts:282` — the `number |` shim gone; `commands.test.ts` passes `{ others, agents: 0, names: [] }`. 4 `commands.ts` — blank line restored before the palette's doc comment. 5 `CHANGELOG.md:32` — "(Seeing them running, and stopping one, come next.)" deleted. 6 `App.tsx:2338-2341` + `QuitConfirm.tsx:9-16` — both comments now say what the code does: Ctrl+C is No, only `y` leaves.

**Owner answer applied.** `App.tsx:2336-2373`: the exit-on-second-Ctrl+C branch and its `exitPending`/`abort` path are deleted; any non-`y` key (Ctrl+C included) just dismisses. `run-quit.test.tsx`'s test now walks dismiss → re-ask → `y` → exit and asserts nothing exits on the Ctrl+C presses.

### Gate (after the last change)

- `bunx tsc --noEmit` → clean. `bunx tsc -p apps/mobile` → clean.
- `bunx biome check .` → `Checked 791 files … No fixes applied.` (0 errors, 0 warnings: the baseline is kept).
- `bun test packages` → **6080 pass, 3 skip (the opt-ins: live-k8s, live-docker, slow keepalive), 0 fail**, 6083 tests in 416 files, 185 s.
- Mutations: every one restored; `sha OK` on each line above; `git status --short` shows only the 15 intended files.

### Not fixed / not verified (explicit)

- **No live check**: nothing ran against a real provider, pod or terminal. HIGH-1 is pinned at the runner's tool filter (the same seam the `context_reset` rule uses), not by observing a real child's model request; HIGH-2 at the pure step + the real `App`'s key handler, not at a real multi-terminal attach.
- **LOW-2's "one row" is proven at Ink's component level and at 80 columns only**; a narrower terminal truncates further (same one row), a wider one shows the same bounded text.
- The review's "Accepted, not findings" item (a pinned `subagents` frame during a long foreground tool) was left accepted, as the review recommended (6b).
