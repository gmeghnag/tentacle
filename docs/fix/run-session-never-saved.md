# fix/run-session-never-saved — A long `run` turn is never saved on the laptop; a pod lost mid-turn loses the whole conversation

> **Status:** executed + reviewed (PASS, 5 LOW), fix round 1 applied (L1); awaiting merge
> **Branch:** `fix/run-session-never-saved`
> **Size:** M · **Blast:** load-bearing (AGENTS §7 "Persistence lives on the laptop/main thread") · **Suited:** strong model executes + mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-11-07 (round 2)*

### Report (owner, 2026-11-07)

`tentacle run --profile glm --engine docker --image=registry.access.redhat.com/ubi9/ubi`
from `/Users/gmeghnag/gitlab/cee`, 2026-11-06 21:24Z, container `tentacle-b6443d3c`
(kept, no `--rm`, not `--detach`). ~21:24Z → ~22:56Z, auto-accept on,
`↑17M ↓275k · ctx 104k/1M`. Then `docker stop` from outside + reboot. Last TUI lines:

```
⏺ Link stopped: the connection target is gone: container "tentacle-b6443d3c" is exited
⏺ ⚠ RpcError: the connection target is gone: container "tentacle-b6443d3c" is exited
⏺ ⚠ Session 8c2af1d9 not saved — could not read the history back: the connection target is gone: container "tentacle-b6443d3c" is exited. The conversation continues; tentacle retries after the next turn.
```

No `8c2af1d9*` file anywhere under `~/.config/tentacle/sessions/` (orchestrator-verified).

### Root cause

**The laptop saves a session only when a turn ENDS, and in a pod `run` only the laptop
keeps anything. So a turn that runs for a long time is never saved, and if the pod dies
mid-turn the whole conversation is lost.**

- Every trigger of the laptop persister fires *between* turns, never inside one:
  - `saved()` flushes only in its `finally`, when the turn's event stream ends
    (`packages/cli/src/local-runtime.ts:418-434`).
  - `onIdle` flushes only when `turns === 0` (`local-runtime.ts:408-413`).
  - An explicit `/compact` flushes (`local-runtime.ts:444-448`). Auto-compaction
    inside a turn does not.
  - A title change triggers the only other flush (`local-runtime.ts:399`).
- A prompt typed while a turn runs does **not** start a new turn. It is
  `enqueue`d (steering) into the running one (`packages/tui/src/App.tsx:2157-2171`),
  and the model takes it at its next round. With auto-accept on, a session driven by
  queued tasks is therefore ONE turn for as long as the user keeps queueing:
  90 minutes and 17M input tokens of tool rounds, zero save triggers.
- Pod daemons never persist, by design (AGENTS §7). The pod's live copy dies with
  the container.
- When the container stops, the turn fails. Its `finally` then flushes, and the
  read-back goes over a link that is gone. The result is the **single** notice
  (`local-runtime.ts:721`, `session-saver.ts:37-41`) whose "retries after the next
  turn" is false: nothing is left to read.

Forensic fit. The kept record `kept/5bac80262170725c.json` has no `sessionId`, and its
mtime is 21:24Z: no `saver.save` ever ran. `trackKeptSession`
(`packages/cli/src/kept-index.ts:145-168`, wired at `main.ts:1146-1156`, present
since `dabcfb8` 2026-11-04) writes that field on the first save. That the final notice
was shown at all means no earlier read-back had failed: the notice fires only on the
ok→failing transition. Both facts are exactly what "no turn ever ended" predicts.
**Not proven from the owner's own data** whether their 90 minutes were literally one
turn (Q1 below). It is the only mechanism found that produces the full signature, and
it reproduces it exactly.

### Repro A — in-process RED on current `main` (`repro-h6.ts`, 2026-11-07 ~03:10)

Real `SessionHost` + `Connection{servesModel}`, `ProxyModelProvider` (model through the
laptop), `createLocalRuntime` with a pod-like `channelFactory`, the auto-accept broker,
and a model that calls the shell tool for 8 rounds (each 500 ms). Two `enqueue`s go in
mid-turn. The store is printed every second. The `kill` variant closes the link at
3.2 s, after which the factory throws `ChannelError("gone")`, which is how `docker stop`
reaches the client.

Source (scratch, gitignored. The full file is in
`.tentacle/tmp/run-session-never-saved/repro-h6.ts`; the essential lines are below):

```ts
class Looping implements ModelProvider {           // 8 shell rounds, then an answer
  async *stream(r) { const i = ++this.n;
    if (i <= 8) yield { type: "tool_call", toolCall: { id: `c${i}`, name: "shell", arguments: '{"command":"sleep"}' } };
    else yield { type: "text", delta: "done" };
    yield { type: "done" }; } }
// daemon: Agent({ model: ProxyModelProvider(link…), tools: shellTool, env.exec = 500 ms, requestPermission: allowAll broker })
const runtime = await createLocalRuntime({ channel: link(), channelFactory: async () => {
    if (gone) throw new ChannelError("gone", 'the connection target is gone: container "x" is exited');
    return link(); }, saver, modelProvider: new Looping(), daemonKind: "container", … });
const session = runtime.createSession();
setInterval(() => log(`mid-turn: store=${await store()}`), 1000);
setTimeout(() => session.enqueue("also do X", "q1"), 1200);
setTimeout(() => session.enqueue("and Y", "q2"), 2400);
if (kill) setTimeout(() => { gone = true; current.close(); }, 3200);
for await (const _ of session.send("big task")) {}
```

Output, `bun repro-h6.ts` (turn completes):
```
[1.0s] mid-turn: busy=true store=NO FILE
[2.0s] mid-turn: busy=true store=NO FILE
[3.0s] mid-turn: busy=true store=NO FILE
[4.0s] mid-turn: busy=true store=NO FILE
[4.0s] turn ended
[4.8s] final store=messages=20
[4.8s] notices: []
```
Output, `bun repro-h6.ts kill` (pod stopped mid-turn), which **reproduces the owner's case**:
```
[1.0s] mid-turn: busy=true store=NO FILE
[2.0s] mid-turn: busy=true store=NO FILE
[3.0s] mid-turn: busy=true store=NO FILE
[3.2s] docker stop: link gone for good
[3.7s] turn failed: the connection target is gone: the connection target is gone: container "x" is exited
[4.0s] mid-turn: busy=true store=NO FILE
[4.5s] final store=NO FILE
[4.5s] notices: ["⚠ Session dd5d6443 not saved — could not read the history back: the connection target is gone: … The conversation continues; tentacle retries after the next turn."]
```
Fix feasibility, `bun repro-h6.ts savenow` (`saveNow()` at 2 s, mid-turn). A read-back
inside a turn works and writes a partial history:
```
[2.0s] saveNow mid-turn → NO FILE        (saveNow resolves on the read, before the write lands)
[2.0s] mid-turn: busy=true store=messages=9
[4.8s] final store=messages=20
```

### Repro B — LIVE RED, installed `tentacle` 0.3.0, real glm (2026-11-07 02:06Z)

Safety: `TENTACLE_CONFIG_DIR=.tentacle/tmp/run-session-never-saved/cfg` (a copy of
`config.jsonc` + pod binaries), workspace `…/ws6/`. The only container used was my own
`tentacle-7814a855`, removed afterwards (`docker rm -f`). The tmux session was killed.

```
tmux new-session -d -s rsns6 -x 200 -y 50 -c …/ws6 -e TENTACLE_CONFIG_DIR=…/cfg \
  "tentacle run --profile glm --engine docker --image=registry.access.redhat.com/ubi9/ubi; sleep 900"
send-keys BTab                                    # auto-accept on
prompt: run 'sleep 15; echo a' … 'echo d' as SEPARATE tool calls, then reply DONE
mid-turn: "Also, after that, run 'echo queued-one' with the shell tool."   # queued
at ~57 s (3 rounds done, queued message absorbed): docker stop tentacle-7814a855
```
Pane:
```
⏺ Bash sleep 15; echo a 15.0s
⎿ exit=0
  a
› Also, after that, run 'echo queued-one' with the shell tool.
⏺ Bash sleep 15; echo b 15.0s
⏺ Bash sleep 15; echo c 15.0s
⏺ Bash sleep 15; echo d
⎿ running…
⏺ Link stopped: the connection target is gone: container "tentacle-7814a855" is exited
⏺ ⚠ RpcError: the connection target is gone: container "tentacle-7814a855" is exited
⏺ ⚠ Session 0135e52f not saved — could not read the history back: the connection target is gone: container "tentacle-7814a855" is exited. The conversation continues; tentacle retries after the next turn.
```
Store after the stop: `cfg/sessions/` holds **no `ws6-*` folder at all**, and
`cfg/kept/cd83ca8ab944f4a5.json` has **no `sessionId`**. This is identical to the
owner's state.

### Hypotheses falsified (rounds 1–2)

| # | Hypothesis | Test | Result |
|---|---|---|---|
| H1 | any `run` read-back hangs | live 0.3.0, 3 short turns; `repro.ts` both modes | every turn saved (live: 1173 → 6299 B; in-process: messages 2/4/6, `saveConfirmed=true`) |
| H2 | an idle link drop stops saving | live: `kill -9` the pod's `serve --bridge`, client redials | turn after reconnect saved (1176 → 1347 B) |
| H3 | a drop/stall while a snapshot is in flight blocks saves forever | `repro-h3.ts` modes `lose`, `lose-close`, `halfopen`, `reply-lost` (with factory, as `run` always has one: `engine-runtime.ts:617`) | **recovers** in every mode: a closed link redials at once; a lost request/reply/half-open is closed by liveness after 15 s with no inbound frame (`remote-client.ts:1386-1417`, `link-machine.ts:25,192-204`), and the read-back repeats. Side finding below |
| H5 | subagents / jobs / compact / clear make reads empty | not run: H6 explains the full signature and reproduces it | — |

`repro-h3.ts lose` output (side finding: saves are delayed, not lost):
```
[0.0s] gen 1: snapshot request lost
[0.5s] after turn 1: store=NO FILE saveConfirmed=false
[1.0s] after turn 2: store=NO FILE saveConfirmed=false
[16.0s] peer error: no frame from the daemon for 15s: the link is presumed dead
[16.3s] gen 2 dialled
[21.0s] after turn 3: store=3a0f6d80 messages=6 saveConfirmed=true
```
While a read-back is stuck, every later save waits behind it (`local-runtime.ts:375-387`).
Liveness counts *any* inbound frame as life (`remote-client.ts:1273-1282`), so a link
that keeps carrying the pod's `model/stream` traffic delays the recovery until the
first 15 s of inbound quiet. This needs a lost frame on an otherwise healthy stream,
so it is low-likelihood and not this incident. Follow-up only.

### Secondary bug — reproduced, root cause known

`createdAt` is re-stamped at every save of a fresh (non-resumed) session, so
`updatedAt == createdAt` always. This matches the owner's host sessions `85df5f4e…`/`5ccebf4c…`.
`build` takes `createdAt` only from a resumed record (`local-runtime.ts:690,716`), and
`recordFromSnapshot` falls back to `now` for both fields
(`packages/agent/src/session-store.ts:103-109`). Live: 1794016539935 after turn 1,
1794016563103 after turn 2.

### Build note

The mechanism exists in the installed 0.3.0 (live repro) and in current `main`
(in-process repro: `main` == `70ec587` v0.3.0, clean tree). Which exact laptop binary
the owner ran no longer matters.

## Implementation

*— claude-opus-5-5, 2026-11-07 (round 2)*

### Load-bearing assumption

A read-back **inside** a running turn returns the daemon's committed history so far,
and saving it is safe. Proven by `repro-h6.ts savenow` (9 messages at 2 s, 20 at the
end). The daemon answers `snapshot` synchronously from the live session
(`packages/daemon/src/connection.ts:310-313`). Still to verify in Execution: what
that mid-turn snapshot's tail looks like while a call is running (a dangling
`tool_call` with no result).

### Preconditions

- Saves are serialized and coalesced per session (`local-runtime.ts:347-387`), so
  extra flushes cost at most one queued read.
- The store's Q6 guard sets aside only an incoming record that is a strict prefix of
  the held one (`session-store.ts:412-417`, `504-519`).
- `cutHistory` closes a mid-turn history honestly (unanswered calls → "Interrupted" /
  "Not run", plus an `ENDED_TURN_NOTE` tail) (`local-runtime.ts:278-297`). It is
  already used for a session cut under a running turn (`local-runtime.ts:360`).
- `saveConfirmed` stays false while a turn runs (`local-runtime.ts:511`, R9). It must
  not change, because detached-run deletes depend on it.
- AGENTS §7: the laptop is the only durable copy for a pod session. A `serve` daemon
  already writes "at every committed boundary" (`hosted-session.ts:232`, `729-733`).
  This fix gives the laptop the same cadence for pods/worker.

### Design

1. **Save after every committed round inside a turn** *(CHANGED by owner Q2: no
   throttle, no timer)*. In `saved()` (`local-runtime.ts:~418`), on each `tool_result`
   event (the daemon commits a round's results at its `history_commit`, which the client
   never sees) call `flush()`. Parallel results of one round collapse through the
   existing serializer (`running`/`again`: one read in flight, later requests collapse
   into one; `local-runtime.ts:~346-380`). The turn-end flush stays. Loss on a pod crash
   ≤ the round in progress. A text-only turn is one round: nothing to add. No new seam,
   no protocol change. *(Q1: the trigger is any long autonomous turn; no queueing.)*
2. **Close the mid-turn record honestly — ALWAYS cut while `turns > 0`** *(Q6 option
   chosen)*: `persist(turns > 0 || cut ? cutHistory(..) : back.messages)`. Same input →
   same output, so two mid-turn reads never give a strict prefix of each other. Residual
   hazard (a turn-end read shorter than the last mid-turn cut copy, e.g. a cancel) is
   pinned by a test; mitigate there if it asides.
3. ~~Honest notice for a stopped link~~ *(DROPPED: with a save per round the file exists;
   the "retries after the next turn" wording stays as debt — see Notes/debt)*.
4. **`createdAt`** (secondary): `let createdAt = record?.createdAt;` in `build`, set
   from the first saved record, then reused.

### Files

`packages/cli/src/local-runtime.ts` (persister: per-round flush, mid-turn cut,
`createdAt`) → tests in `packages/cli/test/local-runtime.test.ts`; `CHANGELOG.md`.
No protocol/daemon/TUI/session-saver change.

### Failure modes

- **Pod gone mid-turn** (`docker stop`, OOM, node loss): the laptop holds the history
  up to the last round flush (≤ the round in progress; see Review L4), closed with
  `cutHistory`. The notice says so.
- **Reboot / laptop process killed mid-turn**: the same bound. The store writes
  atomically (`writeAtomic`), so there is never a half file.
- **Read-back stuck** (H3 side finding): the boundary flushes coalesce behind it as
  today, and recovery happens when liveness replaces the link. Unchanged; follow-up.
- **Save retry**: a failed mid-turn read → one notice (transition rule); the next
  boundary or turn end retries; "saved again" on success.
- **Q6 / stale writer**: see Design 2. A real shorter writer (another TUI) is still
  set aside.
- **Detached run / handover** (`stopSaving`, `local-runtime.ts:867-869`): boundary
  flushes respect `saving`, like turn-end ones.
- **Cost**: one paged snapshot per committed round (coalesced; no timer). ctx 104k is one or two pages
  (`SNAPSHOT_PAGE = 200`).
- **Version skew**: none (laptop-only change).

### Tests (red first, on current main)

1. A long turn of N tool rounds with a pod-like runtime: the store holds the history
   **before** the turn ends (red on main: `NO FILE` until the end, see Repro A).
2. The pod gone mid-turn (`ChannelError("gone")` from the factory): the store holds
   the rounds completed before the stop, closed (no unanswered call; tail
   `ENDED_TURN_NOTE`). Red on main: `NO FILE`. Non-vacuity: drop the boundary flush →
   red.
3. Enqueued (steered) messages mid-turn are in the mid-turn record.
4. Two boundary flushes with no new message produce no `.aside` file and no notice
   (Q6).
5. `saveConfirmed()` stays false during the turn even after a mid-turn save (R9
   unchanged).
6. `createdAt` is unchanged across two saves of a fresh session (red on main).
7. ~~The notice after a stopped link says what is on disk~~ — NOT implemented (Design 3
   dropped; wording is Notes/debt). Added in Execution instead: Q6 no-growth close, and
   (fix round 1) L1 no spurious `.aside` after a closed turn-end read.

## Execution

*— claude-sonnet-5-5, 2026-11-07*

**As built** (all in `packages/cli`; no protocol, daemon, TUI or `session-saver` change):

1. Plan re-verified on main `65a0f07` (line numbers moved a few lines since `70ec587`). The
   client never sees `history_commit` (daemon-only, `daemon/mapping.ts:286`), so the
   committed-round signal is the `tool_result` event.
2. Red first (10 new tests in `describe("per-round save inside a turn")`, appended to
   `test/local-runtime.test.ts`): on unmodified code 9 fail with "timed out waiting for:
   mid-turn read-back / save" (no read-back or file mid-turn = the owner's bug) and the
   `createdAt` test fails on `Expected 1794045358316, Received 1794045358334`.
3. `local-runtime.ts` `saved()`: `flush()` on every `tool_result` (coalesced by the
   existing `running`/`again` serializer; no timer). `run()`: a read while `turns > 0`
   is persisted through `cutHistory` (always, Design 2). `build()`: `createdAt` is now a
   `let` set from the first saved record (Q3).
4. Docs: Design updated per owner answers (Q2 no throttle, Design 3 dropped).
5. `CHANGELOG.md` `[Unreleased] → Fixed`.

**Drift from Implementation**
- *The Q6 residual hazard was real*, not hypothetical: a turn-end read with no growth over
  the last mid-turn raw read (a turn cancelled right after a result) is a strict prefix of
  the cut copy on disk → `.aside` + false notice (the Q6 test was red with one `.aside`
  file). Fix: remember the last mid-turn message count (`lastMidTurnCount`); an
  equal-length turn-end read is persisted cut as well (identical to the held copy). Not in
  the doc's plan.
- *Design 3 (notice wording) dropped.* After a pod loss the turn-end read still fails and
  shows the one "not saved … retries after the next turn" notice (pinned in the pod-gone
  test: exactly one). The file on disk is the truth; only the "retries" half is inaccurate.
  Left as debt (below).
- `relay.test.ts` H28: its poll waited only for a record to exist, then asserted the final
  "ok" tail; a mid-turn record now exists first (flaky ~1/720; 0/2700 on old code). The poll
  now waits for the final record (3600/3600 green after). Test-only change.

**Mutations** (one per behaviour; backup, restore, `shasum -c` OK each time):
- M1 drop the `tool_result` flush → 9/10 new tests red.
- M2 drop the mid-turn cut (`turns > 0`) → 6/10 red.
- M3 drop the no-growth close (`lastMidTurnCount`) → the Q6 test red.
- M4 drop `createdAt = next.createdAt` → the `createdAt` test red.

**Gate**: `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages`:
5281 pass, 3 skip (opt-in), 0 fail.

**Unverified**: real docker/pod (the orchestrator's live check). The integration tests use
an in-process `SessionHost` with gated exec, not a real pod. Cost on a big history (ctx
104k, 1–2 snapshot pages) is one paged read per round, coalesced; not measured live.

**Owner live checklist**
1. `tentacle run --engine docker …`, ONE long prompt (many tool rounds), auto-accept on.
   While it runs, the session file in `~/.config/tentacle/sessions/<project>/` must exist
   and grow after each finished tool round; `kept/<hash>.json` gets its `sessionId` after
   the first round.
2. `docker stop <container>` mid-turn, then `tentacle attach <name> --resume` (or the
   session list): the conversation is there up to the last finished round, ending with a
   closing note (never a dangling tool call). One "not saved" notice at the stop is expected
   (known wording debt).
3. A turn that finishes: the final record has the real tail (no closing note).
4. Two turns of a fresh session: `createdAt` fixed, `updatedAt` later.

**Notes/debt (follow-ups, not done here)**
- TODO (Q4, out of scope): H3 stuck read-back delaying saves while the link carries
  traffic (see Context, "Side finding"): separate low-priority fix.
- TODO: the "retries after the next turn" wording in `nextSaveState` (`session-saver.ts`)
  is wrong when the link is gone for good.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-07*

- **L1 fixed** (`local-runtime.ts`, the `lastMidTurnCount` assignment): now
  `lastMidTurnCount = closed ? back.messages.length : -1` (was `midTurn ? … : -1`). Every closed
  copy on disk remembers its length, so a later equal-length raw read is closed too instead of
  being a strict prefix of it. Only a growing raw read resets it.
- **Red first**: new unit test "L1: a no-growth round signal, then a turn end with a read in
  flight…" (scenario of the reviewer's `race.ts`, real `JsonSessionStore` + `onAside`, in
  `describe("per-round save inside a turn")`): on the pre-fix code it fails on the assertion
  `asides` equals `[]` (one `.aside` file received). Green after the fix.
- **Mutation** (backup, restore, `shasum -c` OK): restoring `midTurn ? … : -1` → only the L1
  test red (10 pass / 1 fail in the describe).
- L2/L3/L4 → Notes/debt above (no code); L5 doc drift fixed (header, failure modes, Tests
  list); owner answers recorded under the Review; `TODO.md` rows added (this task + two LOW
  follow-ups: H3 stuck read-back; TUI busy after `docker stop`).
- **Gate**: `bunx tsc --noEmit` clean · `bunx biome check .` clean · `bun test packages`
  5282 pass, 3 skip (opt-in), 0 fail.

**Notes/debt (continued, from the Review; no code)**
- Review L2 (debt): `midTurn` is read after the `await`, so a read started mid-turn that
  resolves after the turn's end is persisted raw (may end on an unanswered call) until the
  coalesced `again` read replaces it ms later; only a laptop crash in that window leaves it.
  Fix idea: capture `turns > 0` before the `await`.
- Review L3 (debt): several TUIs of one detached run each save after every round; a cut tail
  is never a prefix of a newer real tail, so Q6 does not catch an older mid-turn copy from a
  slower TUI (overwrites a newer one until the next save; loss ≤ one round). Untested.
- Review L4 (debt): a parallel group yields each `tool_result` before its `history_commit`
  (`agent.ts:~1534-1554`), so the triggered read can return the pre-commit state; the real
  bound is "the round in progress + the next model reply". Not measured live.

## Review

*— claude-opus-5-5, 2026-11-07* (fresh context; a different model family from the Sonnet executor,
but the same family as the author of Context/Implementation, so blind spots shared with the plan can survive)

**Verdict: PASS (APPROVE-WITH-NITS).** Only LOW findings. The bug is fixed: a long turn is saved
after every round, a pod lost mid-turn leaves every committed round on disk, closed honestly, and
only `ChatMessage`s are persisted. No §7 invariant is broken.

**Gate (run once by me on the uncommitted tree):** `bunx tsc --noEmit` clean · `bunx biome check .`
clean (711 files) · `bun test packages` **5281 pass, 3 skip (opt-in), 0 fail**, 5284 tests / 364 files.

**Red on main:** I reverted the three src hunks by hand (tool_result flush, `closed` = `cut` only,
no `createdAt = next.createdAt`) and ran `-t "per-round save"`: **0 pass / 10 fail**. Then I restored
from a backup (`shasum` 6ac4f39f…, byte-identical).

**Mutations** (each restored from the backup, `shasum` identical afterwards):
- Executor M2 re-run (drop `midTurn` from `closed`): **6/10 red**, as Execution reports.
- Mine, on the most load-bearing line (`local-runtime.ts:443`): flush on `tool_start` instead of
  `tool_result`. **6/10 red**: every unit test fails. The 4 integration tests stay green. That is
  expected: round N+1's `tool_start` comes after round N's commit, so they cannot tell the two
  triggers apart. The unit test "a start commits nothing" is the one that pins the trigger.

**Premise table**

| Premise | Verdict |
|---|---|
| Symptom: no file mid-turn, nothing after a pod loss (Repro A) | TRUE. With the flush disabled, `repro-h6 kill` on this tree shows `store=NO FILE` throughout. With the fix it shows `messages=4 → 8 → 13 → 16` |
| Saves are serialized and coalesced (`running`/`again`, `local-runtime.ts:388-400`) | TRUE. `flush` is synchronous and never awaited in `saved()`, so the turn is not delayed and no `Connection` handler is serialized |
| `cutHistory` only appends; the snapshot is never mutated (`local-runtime.ts:278-297`, `persisted-session.ts:497-513`) | TRUE. It works on a copy and pushes to it |
| `saveConfirmed` stays false while a turn runs (`local-runtime.ts:532`, `turns === 0 && …`) | TRUE. A mid-turn read can set `confirmed = true`, but `turns > 0` masks it |
| The client never sees `history_commit`, so `tool_result` is the round signal | TRUE. But see L4: the event comes before the commit |
| `connect` is unaffected | TRUE. `connect.ts` does not use `createLocalRuntime`/`persistingController`. Only `engine-runtime.ts:613,1008` use them (worker, `run`, `attach`, relay) |
| Subagent inner tools do not trigger extra flushes | TRUE. They map to `subagent_tool`, not `tool_result` (`client/mapping.ts:115`) |

**Findings (all LOW)**

- **L1. A turn-end read that was persisted cut resets `lastMidTurnCount`
  (`local-runtime.ts:371`).** The next equal-length raw read is then a strict prefix of the cut
  copy on disk, which gives a spurious `.aside` file and a false "set aside" notice.
  - Scenario (reproduced, `.tentacle/tmp/run-session-never-saved/rev/race.ts`, real
    `JsonSessionStore` with `onAside`):
    1. Read R1, mid-turn, returns 3 messages. It is persisted cut (4 messages).
    2. Another `tool_result` arrives with no committed growth and starts read R2.
    3. The turn ends while R2 is in flight, so `again` is set.
    4. R2 returns 3 messages. It is cut through the equality branch, but `lastMidTurnCount`
       becomes -1.
    5. Read R3 returns the same 3 messages and is persisted raw.
    - Output: `asides [{kept:4, dropped:3}]`.
  - The real trigger is rare: a round signal with no committed growth, then a turn end with no
    growth, with a read in flight.
  - No data is lost. The file keeps the longer copy.
  - Suggested fix (one line): `lastMidTurnCount = closed ? back.messages.length : -1`, or remember
    the length of the last persisted cut copy.
- **L2. `midTurn` is evaluated after the `await` (`local-runtime.ts:369`).**
  - A read that started mid-turn but resolves after the turn's end is persisted raw. It may end on
    a call with no answer.
  - The coalesced `again` read replaces it milliseconds later. Only a laptop crash inside that
    window leaves a dangling call on disk.
  - Fix idea: capture `turns > 0` before the `await`, or treat a read with `again` set as
    intermediate.
- **L3. Several writers.** Several TUIs of a detached run each save after every round. A cut tail
  ("Interrupted" labels, `ENDED_TURN_NOTE`) is never a prefix of a newer real tail, so the Q6
  guard does not catch an older mid-turn copy.
  - A slower TUI can overwrite a newer copy, with no aside, until the next save. The loss is at
    most one round.
  - The cross-writer analogue of L1 (an aside) is possible too.
  - Not tested. Acceptable for this task; worth one line in Notes/debt.
- **L4. The event comes before the commit.** A parallel group yields each `tool_result` before it
  pushes the results and yields `history_commit` (`agent.ts:1534-1554`), and the snapshot is sliced
  to the last commit.
  - So the read a round triggers can return the state before the commit (calls labelled
    "Interrupted").
  - The round's real results are then on disk only at the next round's save or at the turn's end.
  - The bound is really "≤ the round in progress + the next model reply", not "≤ the round in
    progress".
  - Not measured live. In practice the round trip of the snapshot request almost always lands
    after the commit.
- **L5. Doc drift.**
  - The header still says "Status: implementation draft" and "Branch: not created".
  - Failure modes still mention a "throttle interval".
  - Planned Test 7 (notice wording) was not implemented. Execution explains why (Design 3
    dropped), but the Tests list was not updated.

**`relay.test.ts` H28.** The change does not weaken the test.
- The assertion is unchanged (`toMatchObject({role:"assistant", content:"ok"})`).
- The wait is still bounded (200 × 5 ms), and the `expect` still runs after it.
- If the final record never lands, the test still fails. It now waits for the end-of-turn record
  instead of the first one, which per-round saving makes the correct contract.
- What it no longer pins ("the first record on disk is the final one") is now false by design.

**Attacks tried**
1. **Cut tail replaced, not accumulated.** In the integration test "long turn completes", the final
   roles are exactly `user, (assistant, tool)×3, assistant` with no note, and every mid-turn read
   recomputes the cut from the raw snapshot. **Holds.**
2. **Coalescing under a burst.** Unit test plus code reading: one read in flight, at most one more,
   last state wins, no queue. **Holds.**
3. **Save failure.** One notice through `saver.failed`, whose ok→failing transition rule prevents
   per-round spam. The next round retries. **Holds.**
4. **Compaction / `context_reset` / `/clear` mid-turn.** A rewritten history is not a prefix, so no
   aside. A `context_reset` commits at its own `history_commit` after its `tool_result`, so the same
   rule as L4 applies. `/clear` closes through `close` after `flushed`, as before. **Holds.**
5. **Race between the turn's end and a read in flight.** **Found L1 and L2.**
6. **Several writers.** **Found L3** (by reasoning, not executed).
7. **`connect` / subagents / handover (`saving` false → `persist` returns).** **Holds.**

**Optional repro.** `repro-h6.ts kill` (copied to `repro-h6-wt.ts` with imports pointing at this
worktree) shows the file growing to 16 messages before and around the stop. That is green for this
bug.
- *Out-of-scope observation:* on this base (65a0f07) the turn then **never ends** (`busy=true` for
  more than 20 s; I stopped the script). The Context reported "turn failed" at 3.7 s on `70ec587`.
- A/B with the flush disabled shows the same hang, so it is **not caused by this diff**. It may be
  a repro artifact (the in-process daemon keeps running) or a later change on `main`.
- Unverified. One run on clean `main` 65a0f07 would decide it.

**How the executor behaved.**
- Strictly red-first, with honest numbers.
- It found and fixed a real hazard the plan had missed (the Q6 equality case) and recorded the
  drift.
- It explained the relay test change instead of loosening the assertion.
- It ran four targeted mutations.
- It missed the reset in that same fix (L1) and left the doc header stale (L5).
- Scope discipline was good: only `packages/cli`, no protocol, daemon or TUI change.

**Questions for the owner (all at once)**
1. L1: apply the one-line fix in this task before merge (with a red-first unit test based on
   `race.ts`), or a `TODO.md` follow-up? *Recommendation: in this task. It is one line in the code
   this task just added, and its test is ready.*
2. L2/L3/L4: record them as Notes/debt only? *Recommendation: yes, Notes/debt. None of them loses
   more than about one round.*
3. The repro hang after a pod stop on 65a0f07 (not caused by this diff): open a separate
   `fix/`/`eval` once one run on clean `main` confirms it? *Recommendation: yes. A TUI stuck "busy"
   after `docker stop` would be user-visible.*

**Owner answers (fix round 1)** (2026-11-07, recorded by the orchestrator):
- **R1 = YES:** fix L1 in this task (one line, red-first unit test from `race.ts`, one mutation).
- **R2:** L2/L3/L4 → Notes/debt only (no code). L5 (stale doc parts) → updated.
- **R3:** the TUI stuck "busy" after `docker stop` seen on 65a0f07 (not this diff) → a separate
  task; confirm on clean `main` first (TODO row).

*Scratch note: `race.ts` created its store in the OS tmpdir (`mkdtemp(tmpdir())`), not under
`.tentacle/tmp`. It is a throwaway, but it breaks the scratch-path rule.*

## Questions for the owner (all at once)

1. Was the 90 minutes **one turn**? Did the input ever show `Type a task` (idle)
   instead of `Queue a task…` between 21:24Z and the stop, or did you keep queueing
   while the agent worked? (This confirms the root cause on your own data.)
2. Mid-turn save cadence: on every committed round (most durable, one snapshot per
   round), or throttled (e.g. ≤ 1 per 10 s)? Is a loss of ≤ 10 s of work on a pod
   crash acceptable?
3. Fix the `createdAt` re-stamp in this same task (S, contained), or as a separate `fix/`?
4. The H3 side finding (a stuck read-back delays saves while the link carries traffic):
   a separate low-priority follow-up in `TODO.md`?

### Owner answers

- **Q1 (2026-11-07):** confirmed ONE turn — a single initial prompt (full-codebase code review: "make a plan and start"); the owner never typed again. So the trigger is simply a long autonomous turn (no mid-turn queueing needed): no save until the turn ends. *— recorded by the orchestrator (claude-opus-5-5)*
- **Q2 (2026-11-07):** save after EVERY committed round (model reply + its tool results); coalesced — while a save is in flight later ones collapse into one (no timer). Loss on a pod crash ≤ the round in progress. *— orchestrator*
- **Q3 (2026-11-07):** fix the `updatedAt == createdAt` re-stamp (`local-runtime.ts:690`) in THIS task, own red-first test. *— orchestrator*
- **Q4 (2026-11-07):** the stuck read-back (H3) is OUT of this task → a low-priority `TODO.md` follow-up (separate fix later). *— orchestrator*
