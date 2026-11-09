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
