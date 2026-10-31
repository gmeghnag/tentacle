# feat/detached-handover — `attach` takes a live detached run over from its relay, and N terminals share it (detached-runs S3)

> **Status:** review — plan approved by the owner 2026-10-31 (Q1–Q7); executed 2026-10-31 (Phase A + Phase B), awaiting the mandatory fresh-context Review
> **Branch:** `feat/detached-handover`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** Opus executes, mandatory fresh-context Review

**Owner decisions (2026-10-31):**
- **Q1:** quit after a hand-over (Ctrl+C or `/quit`) ends the run: a last save, then `session/close{ifLast}`, never `release`. The workload follows the run's `keep` as on a plain `run` quit: keep → stays, `rm` is the user's; keep=false → deleted, the TUI inheriting the relay's ownership of the exit net and of the delete.
- **Q2:** decided by Q1, option (b) for keep=false.
- **Q3 (b):** a second `attach` JOINS the same session as a second client, each laptop process with its own single broker. Only the LAST client closes the session and runs the keep=false delete.
- **Q4 (a):** owner tracking and `attached` on detached-origin runs only.
- **Q5 (a):** `attach <name>` on an ended detached run reopens its session; `/clear` for a fresh one.
- **Q6 (a):** keep=false quit mid-turn (or after a failed/interrupted end) DELETES: a quit is an explicit stop; the attach-time notice says so.
- **Q7 (a):** one branch, Phase A then Phase B, full gate between.
- Plan approved by the owner 2026-10-31.

Umbrella: [`docs/feat/detached-runs.md`](detached-runs.md) (DR-1…DR-9, sub-plan "Hand-over (S3)"). As-built: [`docs/feat/detached-relay.md`](detached-relay.md) (S2), [`docs/feat/detached-relay-lifecycle.md`](detached-relay-lifecycle.md) (S2b + S4, the owner's live checklist).

## Context

*— claude-opus-5-5, 2026-10-31*

**Why.** A detached run can be started and ended, but not joined. While the relay lives, `attach` is refused (S2 Q3), so a held ask can only be cancelled with `kill`, and `--auto-accept` runs cannot be watched. Plain `attach <name>` opens a fresh session even after the relay left (S2 D5). A first-turn `kill -9` leaves the transcript in the pod with no way to reach it (S2 Q5).

**Scope.**
1. Live hand-over relay → `attach`, mid-turn included.
2. `attach <name>` opens the run's session, with or without a relay, stale owner included.
3. N terminals on one detached run: a later `attach` joins as another client.
4. Quit ends the run: last save, `close{ifLast}`, and on keep=false the last client deletes.
5. The DR-8 message.
6. `ps` shows `attached` (deferred from S2b), with N.
7. What the S2/S2b docs tagged for S3:
   - the `exitPlan` row "handed over → leave";
   - TUI owner file;
   - `modelIdle()`;
   - a held ask answerable;
   - the S2 "first turn" row;
   - "After the relay left, a TUI attaches".

**Argued out, not dropped.**
- **`status` and `stop` on the control socket.** `owner.json` + the lock already answer `status`. `rm` stops through SIGTERM, proven live (S2 item 11, S2b D6). A second stop path would be dead code. The socket carries only the two hand-over ops (D4).
- **Q5 of S2 (periodic save in the relay).** Stays "turn end only". The hand-over and the eager open make the pod's copy reachable, which was the gap.
- **`tentacle logs`, `run --detach --resume`.** Not asked here. Unchanged.

**Owner decisions that bind it.**
- **DR-1 (c):** one laptop owner at a time. **Amended by Q3:** the owner is one laptop *role*: the relay, or the set of TUIs. Never a relay and a TUI past `commit`.
- **DR-3 (A):** auto-accept ends with the relay; a TUI owner prompts.
- **DR-5 (B):** keep=false removal is the relay's. **Amended by Q1:** after a hand-over it passes to the last TUI.
- **DR-8:** `attach` hands over and opens the run's session. A gone workload is an explicit message, with no local fallback. "Quit as today's `attach`" is **replaced by Q1**.
- **DR-9 (C):** keep-awake is the relay's only.
- **S2 Q3:** superseded here on purpose: its refusal stays only as the fallback when no hand-over can happen.
- **S2b Q2:** keep the workload on `failed`/`interrupted`. **Bears on a keep=false quit:** see Q6.
- **S2b Q4 (b):** the removal that clears the entry deletes the run dir. Also holds for the last TUI's delete.

**Left to S5.** `/detach` (TUI → relay), relay mode `adopt`. Nothing is built for S5 here.

**Repro** (2026-10-31, `main` 3e842c6, `.tentacle/tmp/detached-handover/repro.test.ts`: a kept `box`, a live lock, `owner.json{waiting-permission}`; run with `bun test ./<path>`):

```
attach exit 1 | [error] box: a detached run owns it (pid 10697, waiting-permission). Wait for it, or `kill 10697` to stop it, then `tentacle attach box --resume 44444444-4444-4444-8444-444444444444` from the folder it ran in
modelIdle: undefined
statusOf kind=tui: null
exitPlan keep=false, nobody but a TUI on the session: {"kind":"remove"}
```

(`statusOf kind=tui` calls it with `{kind: "none"}`, dead holder: no owner state exists for a TUI yet.)

The last line is the danger: `residentUseOf` counts only OTHER sessions (`packages/cli/src/relay-state.ts:194-198`), so today a keep=false relay would delete the workload under a TUI on its own session.

## Implementation

*— claude-opus-5-5, 2026-10-31*

Verified on `feat/detached-handover` = `main` 3e842c6.

### Load-bearing assumption

**The daemon already treats N laptop clients of one session as equals, and nothing in a turn depends on which one started it: a client that attaches mid-turn receives the running turn and any pending ask, new model calls go to the newest, an in-flight model call finishes on its own connection, an ask is decided exactly once and withdrawn on the others, and only the last client's `close{ifLast}` ends the session.**

Hand-over, join and quit all stand on this one property. A hand-over is a join followed by the old client leaving.

**PROVEN in-process, against the real daemon. NOT proven over a real bridge, two real TUIs or a compiled relay:** that is the checklist's job.

From the code:
- Attach replays and joins in one synchronous segment, and moves the client to "most recent" (`packages/daemon/src/hosted-session.ts:807-830`).
- The model link is resolved per call: the newest serving attachment (`hosted-session.ts:838-846`). A call already in flight stays on its connection.
- Detach cancels only when no serving link is left (`packages/daemon/src/connection.ts:139-146`).
- `session/open` with no `create` never builds a session (`packages/daemon/src/session-host.ts:394-395`).
- The eager path exists for `connect`: `attachSession` (`packages/client/src/remote-client.ts:499-519`), `RemoteSession.open` (`packages/client/src/remote-session.ts:221-244`).
- A `permission_request` goes to every attachment. `resolvePermission` takes the ask out synchronously and `settle` emits `permission_resolved` to all, once (`hosted-session.ts:607-637`), so of two answers one wins.
- On each client `permission_resolved` closes the dialog, through an abort of the broker's signal, and sends nothing (`packages/client/src/permission-router.ts:108-122`, `packages/tui/src/permission-ui.ts:191-203`).
- A losing answer is `PermissionNotPending`, silent (`remote-client.ts:1900-1905`).
- `close{ifLast}` with another client attached is exactly a detach (`connection.ts:395-403`). The check and the close are synchronous in the handler, so of two quits one closes.

**Probe 1, hand-over** (`.tentacle/tmp/detached-handover/probe.test.ts`): real `SessionHost` + `Connection{servesModel}` + `ProxyModelProvider` + an ask `shell` tool. OLD and NEW are two `RemoteClient`s, each with its own broker. OLD starts the turn and its requester only holds, like a frozen relay. NEW attaches with `newSession(undefined, UID, undefined, {attach: {}})`.

```
A old model calls before attach: 1
A after attach: {… "running":true,"attached":2,…}
A old events: text turn_end
A new activity: history turn user_message text turn_end
A models old/new: 1 0
A history roles: user,assistant
B asked before attach: old:shell | execs 0
B after attach: old:shell new:shell:turn=yes
B after OLD detach: old:shell new:shell:turn=yes old:withdrawn | execs 0
B list: [{"running":true,"attached":1}]
B execs: 1 models old/new: 1 1
B new activity: turn history_reset tool_result text turn_end
B old events: tool_start
B history roles: user,assistant,tool,assistant
B old events after close: tool_start
C new activity: history turn user_message threw:connection closed
C models old/new: 1 0
D rejected: -32003 RpcError: unknown session: 33333333-3333-4333-8333-333333333333
D sessions: 0
```

- **A, mid model stream:** the call finishes on OLD and NEW sees the turn live.
- **B, pending ask:** replayed to NEW with its `turnId`. OLD's detach only withdraws OLD's prompt. NEW answers, the tool runs once, the next model call goes to NEW.
- **C, no drain:** OLD leaving mid-stream kills the turn. So `modelIdle()` is required, not an optimisation.
- **D:** an unknown id is refused and creates nothing.
- **B's last lines:** OLD's `send` never settles after it leaves. The relay must never wait on `drive()`.

**Probe 2, N clients** (`.tentacle/tmp/detached-handover/multi.test.ts`, same rig, each client an interactive requester whose prompt logs its withdrawal):

```
E asked: A:asked:shell B:asked:shell D:asked:shell
E after B answered: A:asked:shell B:asked:shell D:asked:shell A:withdrawn D:withdrawn | execs 1
E A events: tool_start tool_result text turn_end
F execs 0 | log A:asked:shell B:asked:shell | tool msg: {"role":"tool","content":"Permission denied by the user: `shell` was not run.","toolCallId":"c1"}
G A gone: [{"running":true,"attached":1}]
G execs 1 | B activity turn history_reset tool_result text turn_end
H before: 2
H after A closeSessions: live true 1
H after B closeSessions: live false
I B model calls: 1
I A events: tool_start tool_result threw:connection closed
J live after A's close(): false | B activity history closed
```

- **E, an ask with 3 clients:** asked on all three. B answers: A and D are withdrawn, the tool runs once.
- **F, two answers in one tick:** the first (a deny) wins, the second has no effect, and `onError` is never called.
- **G:** the client that started the turn quits with an ask pending: the turn lives on, the other client answers.
- **H:** `closeSessions` detaches the first, closes on the last.
- **I, new, a defect to design out:** the newest client quitting during its model call kills the OTHER client's turn. So a quit drains too (`modelIdle`).
- **J, new, a defect to design out:** `SessionController.close`, which is `/clear`, sends a plain `session/close` (`remote-session.ts:391-406`). It ends the session for every client (`session-host.ts:407-413`). So one TUI's `/clear` would kill the others' session. Shared sessions use `ifLast`.

**Socket probe** (`.tentacle/tmp/detached-handover/sock.test.ts`, the peer a real child process):

```
mode 600
killed@ 404 data:{"op":"prepare"} | close@411ms
after close, file exists: false
no listener: ENOENT
```

The peer's SIGKILL closes the socket within 7 ms, so "socket closed before `commit`" is a sound abort signal.

### Preconditions (against the AS-BUILT S1 + S2 + S2b)

- **P1 — relay exit.** One loop, `exitPlan`, `release`, `drain`, removal, `leave` (`packages/cli/src/relay.ts:313-374`). `leave` writes `owner.json` and releases the lock (`:194-209`).
- **P2 — stop.** The stop handler always aborts `send`'s signal (`relay.ts:188-191`), which cancels the turn.
- **P3 — net.** Armed under the lock on keep=false (`relay.ts:224-226`). Disarmed first in `leave` (`:195`). `armExitNet` fires unconditionally and returns a disarm (`packages/cli/src/engine-runtime.ts:233-241`).
- **P4 — lock.** `acquireResidentLock(dir, procOf)` works on any dir, and exactly one taker wins (`packages/cli/src/pod-resident.ts:229-283`). `lockHolder` reads it (`:608-611`). `residentStop` stops a holder (`:620-639`).
- **P5 — quit today.** `runEngineTui` tears down with `runtime.dispose()` (`packages/cli/src/main.ts:717`). `dispose` is flush, `session/close{ifLast}`, close (`packages/cli/src/local-runtime.ts:396-402`, `packages/client/src/remote-client.ts:741-756`). It waits only for pending saves: **no last read-back**, and a foreign turn's save comes only at its end. `CloseResult` is `{}` (`packages/protocol/src/session.ts:474`): **the client cannot tell a close from a detach.** A strip schema, so a new optional field is free (AGENTS §7).
- **P6 — lazy sessions.** `createSession` builds a lazy session (`local-runtime.ts:349-362`): nothing opens until the first `send`. `App` watches first, then calls `open()`, and `open()` on an opened session is a no-op (`packages/tui/src/App.tsx:1261-1271`, `remote-session.ts:223`). `connect` pre-opens before Ink and hands that session out first (`packages/cli/src/connect.ts:150-158`, `:249-253`).
- **P7 — held pre-mount.** `holdUntilSet` queues requests until `setRequester` (`packages/core/src/permission.ts:143-165`). A dismissed prompt sends nothing (`permission-router.ts:131-133`).
- **P8 — saves.** A foreign turn is saved at its end, a `history` activity at once (`local-runtime.ts:232-243`). Activities raised before `watch` are delivered at `watch` (`remote-session.ts:193-197`). `App` watches only after it mounts. A save is a whole file, written to a temp and renamed (`packages/agent/src/session-store.ts:9`), with a per-uid queue inside one process only (`:382`, `:416`).
- **P9 — foreign turns.** An ask of a foreign turn is never auto-accepted (`permission-ui.ts:187-189`). `/exit` leaves at once on a foreign turn (`packages/tui/src/commands.ts:204-218`). An own turn stops first, then exits. `App` needs no change: `connect` already drives it with several clients (`docs/feat/tui-foreign-turns.md`).
- **P10 — replace guard.** `reuse` runs no guard (`engine-runtime.ts:623-624`). On a replace, `attached > 0` refuses before any byte moves (`engine-runtime.ts:629-631`, `pod-resident.ts:661-694`).
- **P11 — owner record.** `readOwner` refuses any `kind` but `"relay"` (`packages/cli/src/run-state.ts:160-173`), so an older build reads a TUI record as `unknown` and leaves it.
- **P12 — `ps`.** `relayRow` asks `lockHolder` on the run dir only (`packages/cli/src/kept-cmd.ts:166-183`). `statusCell` shows `text` alone when `pid` is present (`packages/cli/src/kept.ts:252-258`).
- **P13 — resume lines.** A valid uid with no record prints `starting fresh` (`packages/cli/src/session-resume.ts:76-82`).
- **P14 — a socket file.** The resident's listen pattern: unlink, `listen`, `chmod 600` (`pod-resident.ts:302`, `:322-327`).
- **P15 — verified removal.** `removeVerifiedKept` re-reads the labels, deletes and forgets (`kept-cmd.ts`), and `bounded` limits it, as the relay does (`relay.ts:346-356`). `residentUseOf` gives `null` when its own session is not listed (`relay-state.ts:187-190`).

**Where the umbrella sketch no longer matches the code:**

| # | Umbrella says | Code / decision |
|---|---|---|
| D1 | `owner.lock` rewritten to the new pid (temp+rename) | No such file: the lock is `.lock.<n>` (S2 D1). And one owner lock cannot express N TUIs. **Instead:** the relay's lock stays the relay's, and each TUI has a **presence file**. Serialisation of takers comes from the control socket (`busy`). |
| D2 | Open the session "seeded from the laptop store" | A seed is ignored on a live id, and a first-turn run has no record. **Instead:** `session/open` with no `create`, the eager path; a seed only when the pod no longer has it. |
| D3 | "Build today's runtime and open" | Today's runtime is lazy (P6): it would attach only at the first `send`. New `LocalRuntime.attachTo`. |
| D4 | Control socket `status \| handover \| stop` | `prepare` + `commit` only (Context). One `handover` cannot abort if the attacher dies. |
| D5 | Open first, then `handover` | **Wrong order, two deciders.** Probe B shows an ask reaches both clients. An `--auto-accept` relay would answer it under the user's prompt. The relay freezes BEFORE the TUI opens. |
| D6 | "Its open prompts are dismissed" | Not needed, and a dismissal would need a re-raise on abort. They stay held; a `permission_resolved` or the detach withdraws them. |
| D7 | Relay drains, then replies `done` | The TUI would stare at nothing for up to 5 min pre-mount. **Instead:** `commit` is acked at once, the relay drains alone. |
| D8 | "It stops persisting: unsubscribes `watch`" | The relay has no `watch`: its save hangs on `send` (`local-runtime.ts:187-200`). New `stopSaving()`. |
| D9 | DR-8 fallback `--resume` | The owner overrode it. No fallback. |
| D10 | "The new CLI says `tentacle stop <name>`" | No such command. The guard's wording stands (P10). |
| D11 | "Live TUI owner → refused"; "a second TUI that declines is refused" | Reversed by Q3: it joins. |
| D12 | `kept/<name>.sock` (DR-1), `$TMPDIR` fallback | `<runDir>/control.sock`. The fallback path stands, recorded in `owner.json`. |
| D13 | `armExitNet` for the inheritor | Fires unconditionally (P3): one TUI's crash would delete the workload under another. A conditional net (Design). |
| D14 | "One writer per uid" | Not with N TUIs: each saves. See "Saves". The relay → TUI step stays strictly ordered. |
| D15 | Quit: `dispose` | No last save (P5), and no way to learn whether this client closed. New `LocalRuntime.quit()` and `CloseResult.closed`. |

### Design

Two phases, in this order, each with its own narrow gate (see Size and split).

**Run state, added.**
- `<runDir>/attach/<pid>-<start>`: a **presence file**, one per TUI on the run, empty, 0600. `attachers(dir, procOf)` lists the live ones with the lock's own test (pid + start time: `holderAlive`, exported) and sweeps dead ones. No lock: joining is not exclusive.
- `<runDir>/control.sock`, 0600, in the 0700 run dir. Over 103 bytes (macOS `sun_path`): `$TMPDIR/tentacle-<uid>/<stem>.sock`, in a dir checked to be 0700 and ours, else no socket. The relay records it as `owner.control`.
- `OwnerRecord.kind` gains `"tui"`, `OwnerState` gains `"attached"`, and the record gains `cwd?` and `control?`. `keep` is carried over unchanged. No `RUN_STATE_VERSION` bump: an older build refuses a TUI record already (P11).

**`owner.json` with N TUIs.** It holds what a run IS, not who is here: `sessionId`, `keep`, `cwd`, plus `attached` or `idle`. Any TUI that finds no TUI record writes one; the TUI that sees no other presence when it quits writes `idle`. `pid` is whoever wrote last, informational. **Who is attached comes from the presence files alone**, so a lost write cannot lie: `state` is read only when no presence is alive.

**`attach-plan.ts` (new, pure).** `planAttach({owner, relayAlive, resumeUid, cwd, tty})`:

| Condition, first match wins | Plan |
|---|---|
| `owner` none, no relay | `plain`: today's path, no presence (Q4) |
| `owner` unknown, relay alive | `refuse` (S2's message; lock liveness decides) |
| `owner` unknown, no relay | `plain`, file untouched |
| `owner.cwd` is another project | `refuse`: "run it from `<cwd>`" (a saved copy would land in the wrong project; a detached run is usually one first turn, with no record for `resolveResume` to catch) |
| `resumeUid` set, not `owner.sessionId` | relay alive and `owner.kind` relay → `refuse`; else `plain` |
| not a terminal | `refuse`. A TUI that cannot mount would end the run: a hand-over would kill the turn, and on keep=false a quit would delete. |
| relay alive | `run{sessionId, handover: true}` |
| otherwise | `run{sessionId, handover: false}`: a stale owner, an ended run (Q5) or a join (Q3) are one path |

`--continue` and a bare `--resume` count as "no uid": the run's session is the target, no picker. A `plain` attach to another session in the same resident is not a client of the run: it writes no presence, and `residentUse` protects it at the last quit (S2b's `others`).

**Pure `quitPlan({keep, othersAttached, sessionsKept, use})`, same module.** The only place a TUI's removal is decided:

| Condition, first match wins | Plan |
|---|---|
| `keep` | `stay` |
| `othersAttached > 0` | `stay` (not the last) |
| `sessionsKept > 0` | `stay`: a close was only a detach, or unconfirmed |
| `use === null` | `stay`: "could not tell whether it is in use" |
| `use.others > 0` | `stay`: "another client is using it" |
| otherwise | `remove` |

Own `running` and `jobs` do not hold it: the quit is what ends them (Q6).

**`attach-run.ts` (new).** The orchestration, with injected seams, so `main.ts` stays a call.

*Phase A steps, `joinRun`:*
1. `planAttach`; a refusal exits 1, nothing dialled.
2. Write the presence file, THEN read the relay lock. A live holder under `owner.kind: "tui"` is a relay draining (its socket answers `handed_over`: go on, a join) or a TUI deleting (go to the "closing" step below). *(Fix round 1, finding 4: the first version sent both to "closing".)* The order matters against the last quit (see "Last quit").
3. `openTuiSessions` for `sessionId`, with a new `live: true` that silences `starting fresh` (P13).
4. Host built. **DR-8:** `describe(name) === null` → exit 1: "`<name>`: the `<noun>` no longer exists — session `<uid>` cannot be re-attached; its transcript is kept on this laptop". A `describe` that throws goes on: the dial reports it.
5. `attachEngineRuntime` as today, with `shared: true` and the SAME broker as the TUI. A guard refusal or `VersionMismatch` exits here.
6. *(Phase B, `handover` only: `prepare`, see below.)*
7. `runtime.attachTo(sessionId, record)`.
   - `true`: attached.
   - `false` (`UnknownSession`): with `handover`, close the socket, `release()`, exit 1 "still starting: retry". Without, the seeded path: `sessionId` + `resume`, with a notice if there is no record either.
8. *(Phase B, `handover` only: `commit`.)*
9. Write `owner.json` if needed. On keep=false arm the shared net. Mount Ink. Notices through `NoticeHub`, never a raw write: auto-accept ended; on keep=false "quitting removes the `<noun>` once no other terminal is attached".

Any failure before step 9: presence removed, `release()` if a runtime exists. **"Closing":** wait for the lock to clear (≤ 45 s, `RM_STOP_GRACE_MS`), then redo from step 1 once. keep=false now reaches the ordinary "gone" path.

`runSessionTui` gets `resume: null` when attached: the session's `history` activity draws the screen.

**Last quit, `finishRun`, in order.** Run after Ink unmounted, from `runSessionTui`'s teardown.
1. If Ink never ran (`start` threw): disarm, `release()`, remove presence. Nothing ends: the user quit nothing.
2. Remove my presence. Read `others = attachers(...)` — advisory only: it decides whether to try for the lock (so a non-last TUI never stops a draining relay).
3. On keep=false with `others === 0`: stop a draining relay (`residentStop`, 5 s, P4; only a holder that answers `handed_over`, never another TUI, fix round 1), then take the run's lock, THEN read `attachers` again — the authoritative read; `> 0` → release the lock, no delete. It is held through the delete, exactly the relay's rule (S2b), so an `attach` is refused at step 2 of `joinRun` or finds the workload gone. Lost → no delete. *(Fixed in Execution, AGENTS §8: the first version read `others` only before the lock, which leaves the interleaving read-others → attacher writes presence → attacher reads lock (free) → take lock → delete under it.)*
4. On keep=false: `use = residentUse(sessionId)`, bounded 5 s, before the close: afterwards the session is not listed (P15).
5. `{sessionsKept, saved} = await runtime.quit()`: `saved` false (the read-back failed or timed out, or its write did not reach the laptop copy) → the sessions are detached, never closed (fix round 1).
6. With `others === 0` and the lock not lost: `owner.json{state: "idle"}`. On any write after this point the last TUI is the only writer.
7. `saver.drain()`: a line back means a session not on disk, the same as `saved` false.
8. `quitPlan`, which keeps the workload unless the save was confirmed. `remove`: `removeVerifiedKept`, bounded 30 s. A failure is written (after unmount) and kept in `owner.detail`: `not removed: <why> — tentacle rm <name>`.
9. Disarm the net LAST, as §7 asks. The run dir goes with a completed removal (S2b Q4 b), the lock with it. Else release the lock.

Why presence-then-lock (`joinRun`) against lock-then-presence (`finishRun`): whichever runs second sees the other. An attacher that registered first keeps the workload; an attacher that came later sees the lock and waits.

**`LocalRuntime` (`local-runtime.ts`).**
- `shared?: true` (dep): every close of this runtime's sessions is `ifLast`, `/clear` included (probe J).
- `attachTo(id, record): Promise<boolean>`: builds the first controller with `{attach: {}}`, keeping `record`'s `createdAt` and title but no seed, and `open()`s it. `UnknownSession` → `false`, the seed left intact. Anything else rejects. The next `createSession` returns that controller (the `connect` pattern, P6).
- `quit(): Promise<{sessionsKept: number}>`: one last read-back on every controller, `allFlushed`, `closeSessions`, `modelIdle(10 s)` (probe I), `client.close()`, `disposeTransport`.
- *(Phase B)* `stopSaving()`: `persist` becomes a no-op. `flushed()`: `allFlushed`, exposed.

**Protocol.** `CloseResult` gains `closed?: boolean`: true only when this request ended a live session. An optional field: no `PROTOCOL_VERSION` bump (§7). `Connection.closeSession` fills it: `false` on the `ifLast` detach path, else `host.close(id)`'s boolean (`connection.ts:395-407`, `session-host.ts:411`). Absent reads as not closed: the safe side. Regenerate `schema/protocol.json`.

**`RemoteClient`.**
- `closeSession(id, {ifLast?})`; `RemoteSession` gets `closeIfLast` through `newSession`'s options (`remote-session.ts:398-405`).
- `closeSessions` resolves with the count of sessions not confirmed `closed: true`. A timeout or a dropped link counts as kept.
- `modelIdle(timeoutMs)`: a counter around `onModelStream` and `onModelStreamChunked` (titles included). Resolves at 0 or at the bound; never rejects.

**Exit net (`engine-runtime.ts`).** `armSharedExitNet(host, name, othersAlive)`: as `armExitNet`, but `fire` first asks `othersAlive()`, synchronously (the presence files, `ps` through `spawnSync`). Every TUI of a keep=false run arms it, since any may become the last. So a crash of the last one deletes, as a plain `run` does; a crash of another leaves the workload. Armed only after step 8 of `joinRun`: a leftover is the safe side of that gap.

**Saves with N TUIs.** Each TUI saves its session at each turn end, as `persistingController` does, whatever client started the turn (P8). So the record has several writers. Accepted, because each write is an atomic whole-file snapshot of the ONE daemon history (P8). The worst case is an older snapshot landing a moment after a newer one. The next save repairs it, and the last client's read-back precedes the close, so a clean end always leaves the newest. No election: it would be a new protocol for no gain.

**`ps` (`kept-cmd.ts`, `run-state.ts`).** `relayRow` adds `n = attachers(...)`. `statusOf(read, alive, now, n)`:

| `owner` | Result |
|---|---|
| `kind: "relay"`, relay alive | as today |
| `n === 1` | `attached` |
| `n > 1` | `attached (N)` |
| `kind: "tui"`, `n === 0`, `attached` | `tui lost` |
| `kind: "tui"`, `n === 0`, `idle` | `idle`, plus `(<detail>)` |

No `detached ·` prefix, no ` · auto`. `-v` lists the pids. `rm` is unchanged: a live relay is stopped by SIGTERM, TUIs are covered by the existing "a session may be attached" prompt.

**Phase B: the live hand-over.**

**Attacher, step 6 of `joinRun`.** Connect, `prepare{sessionId}`.
- `busy` → another attacher is mid-hand-over. Retry every 500 ms, ≤ 35 s (the lease + a margin). If it commits, the reply becomes `handed_over`. If it aborts, this attacher prepares itself.
- `handed_over` → a plain join: skip steps 6 and 8.
- `leaving` → "closing".
- No socket after 5 s: `owner.kind: "tui"` → "closing"; else S2's refusal.

**Step 8.** `commit`, ack ≤ 15 s.
- No ack and the relay's lock is dead → carry on, it died.
- No ack and it lives → `release()`, presence removed, exit 1.

A joiner never opens before the commit is settled: if it opened while another attacher's hand-over could still abort, the thawed relay and the joiner would both decide (D5).

**`relay-policy.ts`.** `freeze()`: every ask is held, auto-accept included. `thaw()`: asks held by the freeze go back through the same decision, once. Without this, an auto-accept run would stall for good after an aborted hand-over.

**`relay-state.ts` (pure).** Model gains `handover: "none" | "prepared" | "done"`.
- Events: `handover_prepared`, `handover_aborted`, `handed_over`, `drained`.
- `prepared` holds any idle exit: `tick` clears `exitAt`. A `stop` or a stopped link still exits.
- `drained` → `exitNow`.
- `exitPlan`, new first row: `handover === "done"` → `leave`. Second row: `handover === "prepared"` and not stopping → `hold`. So a `prepare` landing during the `readUse` await (`relay.ts:323`) can never meet a removal.
- `wantsAwake` is false once `done`.

**`control-socket.ts` (new).** `parseControl` is pure: newline JSON, 4 KiB cap, `schemaVersion`, strict. Server and client are thin `node:net`.

| Op | Reply |
|---|---|
| `prepare{sessionId}` | `{ok: true, appVersion, autoAccept}` or `{ok: false, reason: "leaving" \| "busy" \| "handed_over" \| "session" \| "version" \| "stopped"}` |
| `commit` | `{ok: true}` |

**Relay (`relay.ts`).** The socket listens from the first `turn_started` until `leave`.
- A `let leaving` is set in the same tick the loop's plan is final (not `hold`). `prepare` after it → `leaving`.
- **`prepare`:** `disarmNet()`, `policy.freeze()`, `handover_prepared`, start a 30 s lease.
- **Abort** (socket closed before `commit`, lease over, or a stop): re-arm the net on keep=false, `policy.thaw()`, `handover_aborted`.
- **`commit`, irrevocable, in this order:**
  1. `await runtime.flushed()`, `stopSaving()`, `saver.drain()`, bounded by 10 s.
  2. `handed_over`: `owner.json` is written no more (`record` returns at once), keep-awake stopped.
  3. Ack.
  4. `runtime.modelIdle(5 min)`, then `drained`.
- After `done`, the stop handler only emits `drained`. It never aborts `send`: that signal would cancel the TUI's turn (P2).
- The loop then leaves through `release`, `drain`, `leave()`, as any exit. `drive()` is never awaited (probe B).

**Who decides (the single-broker argument).** One broker per laptop process, always: TUI A's prompt, TUI B's prompt and the relay's policy are separate clients, like two `connect` devices. The daemon makes it one decision per ask (`hosted-session.ts:607-637`, probes E, F).

| Phase | Owner role | Who can answer an ask |
|---|---|---|
| until `prepare` | relay | relay's policy (auto-accept), else held |
| `prepare` → `commit` ack | relay | nobody: relay frozen, no TUI mounted, joiners wait on `busy`. The ask waits. |
| abort | relay | relay's policy again; frozen asks re-decided |
| ack → first mount | TUI | nobody: queued in the TUI's broker (P7), milliseconds |
| mounted, N ≥ 1 | TUIs | any TUI's prompt. First answer wins, the others are withdrawn. |
| last TUI leaves | none | the turn is cancelled (last serving link) or closed; the ask settles `cancelled` |

Never a relay and a TUI at once. Zero answerers only inside bounded windows, in which the ask stays pending and has a named owner role.

**A turn is served by the newest client (`hosted-session.ts:838-846`).** So TUI B's model and key answer TUI A's turn, and the record's `model` is each saver's. Same laptop, same user. Accepted, and S1 Review's finding 1 named it.

### §7 invariants

| Invariant | How it stays true |
|---|---|
| Single broker | One per process: each TUI's is the same instance for its runtime and its Ink (`main.ts:1028`, H17). Two TUIs are two clients, never two brokers in one process. One decision per ask is the daemon's (probes E, F). The freeze prevents relay + TUI (D5, H34). |
| One session path | `attachSession` over `RemoteClient` ↔ `Connection`, the `connect` path. The control socket never carries the session protocol. |
| Model on the laptop | Every client is a laptop process serving `laptopModels`. The relay's env and argv do not change. |
| Pod not trusted | The control socket and presence files are laptop-only, 0600 in a 0700 dir; no pod input reaches them. `closed` and `use` are pod-supplied: they steer only the removal of that same workload, and every doubt keeps it. A TUI prompts a foreign turn (P9). `owner.tool`/`detail` stay sanitised. |
| Persistence on the laptop | Relay → TUI is strictly ordered: the relay's last write completes before the ack, the TUI's first write follows the mount (P8). Among TUIs: several atomic snapshot writers of one history ("Saves"). Nothing is deleted before `saver.drain()`. |
| Pod daemons store nothing | Unchanged. |
| No raw terminal writes | Attacher lines come before Ink mounts or go through `NoticeHub`. `finishRun` writes after unmount (`tui-sessions.ts:132-145`). The relay has no TTY. |
| Don't serialize the peer | `modelIdle` is a counter outside any handler. `closeSession` stays synchronous. The control socket is not on a `Connection`. |
| Protocol | `CloseResult.closed` is an optional strip-schema field, both ends wired, schema regenerated. `PROTOCOL_VERSION` stays 14. No `UPDATE_CLASS` change. |
| On-disk records | `kind: "tui"` is refused by an older build (P11). An unknown record is left byte-identical. |
| Pod lifecycle | **Exit net across a hand-over:** the relay owns it until `prepare`, disarms it there, re-arms on abort. After `commit` the relay removes nothing (`exitPlan` row 1) and the TUIs own it, through the conditional net. **Delete:** only `quitPlan` + `removeVerifiedKept`, last client only, after the save, under the run's lock, net armed until done. A kept run's `attach` deletes nothing. A user's own pod is never tracked (no `owner.json`, Q4). |

### Files (dependency order)

**Phase A (N clients, the run's session, quit, DR-8, `ps`):**
1. `packages/protocol/src/session.ts`, `packages/protocol/schema/protocol.json` — `CloseResult.closed`.
2. `packages/daemon/src/connection.ts` — fill it.
3. `packages/client/src/remote-client.ts`, `remote-session.ts` — `closeSession{ifLast}`, `closeIfLast`, the `closeSessions` count, `modelIdle`.
4. `packages/cli/src/local-runtime.ts` — `shared`, `attachTo`, `quit`.
5. `packages/cli/src/pod-resident.ts` — export `holderAlive`.
6. `packages/cli/src/run-state.ts` — `kind`, `attached`, `cwd`, presence, `statusOf`.
7. `packages/cli/src/engine-runtime.ts` — `armSharedExitNet`, `shared` passed through.
8. NEW `packages/cli/src/attach-plan.ts` — `planAttach`, `quitPlan`.
9. NEW `packages/cli/src/attach-run.ts` — `joinRun`, `finishRun`.
10. `packages/cli/src/tui-sessions.ts` — `live`.
11. `packages/cli/src/kept-cmd.ts` — `relayRow`.
12. `packages/cli/src/main.ts` — the `attach` branch, `runEngineTui`'s teardown, USAGE/HELP. A live relay still gets S2's refusal at the end of Phase A.

**Phase B (the live hand-over):**

13. `packages/cli/src/local-runtime.ts` — `stopSaving`, `flushed`.
14. `packages/cli/src/relay-policy.ts` — `freeze`, `thaw`.
15. `packages/cli/src/relay-state.ts` — `handover`, the events, two `exitPlan` rows, `wantsAwake`.
16. NEW `packages/cli/src/control-socket.ts`.
17. `packages/cli/src/relay.ts` — the server, the abort, the commit, the stop guard, `cwd` in `record`.
18. `packages/cli/src/attach-run.ts` — steps 6 and 8.

**Docs, last:**

19. `README.md`, `TODO.md`, the umbrella's status line and DR notes, the checklist in `docs/feat/detached-relay-lifecycle.md`.
20. `AGENTS.md` §7 "Pod/container lifecycle" (substantive, so it rides this branch, §10 carve-out (c)). Exact change:

Replace

> A `run --detach --keep=false` is the one other owner of that net and of a delete:

with

> A `run --detach --keep=false` is another owner of that net and of a delete:

Replace

> `attach` is user-owned: never create, start or delete, no exit net (`attach <name>`'s kept-index lookup only picks the engine/location).

with

> `attach` is user-owned: never create, start or delete, no exit net (`attach <name>`'s kept-index lookup only picks the engine/location) — with ONE exception, a TUI attached to a detached run of `keep=false`: it inherits the relay's ownership at the hand-over (the relay disarms at `prepare`, and after `commit` removes nothing). Every TUI of that run arms the net, which fires only if no other TUI of the run is alive; only the LAST client's quit removes the workload, through `quitPlan` (the daemon confirmed the close, nobody else uses the resident) + `removeVerifiedKept`, after the last save, under the run's lock, the net staying ARMED until that delete is done.

### Size and split

**L:** 17 source files plus the schema, across protocol, daemon, client and cli, with two new seams (the control socket, the N-client quit). Q3 and Q1 are what moved it from M.

**The split line is Phase A / Phase B.** Phase A ships alone: `attach` opens the run's session once the relay left, N terminals share it, quit ends it, DR-8, `ps`. A live relay is still refused. Phase B adds only the relay's side. Q7 asks: one branch or two.

### Failure modes

**Hand-over (Phase B).**

| Event | Behaviour | Convergence |
|---|---|---|
| Mid-turn, between model calls (a tool running) | `modelIdle` is 0 at once, the relay leaves. The tool's result streams to the TUI. | The turn goes on as a foreign turn, saved at its end. |
| Mid model stream | The call finishes on the relay (probe A); the next goes to the TUI. | Relay leaves after the drain. |
| Stream outlives the 5 min bound | The relay leaves; that call rejects and the turn errors in the TUI (probe C). | Bounded and loud. Session live, the user re-prompts. |
| Mid permission ask | Replayed to the TUI (probe B), queued in its broker until mount, prompted. The relay's prompt stays held, withdrawn on `permission_resolved` or the detach. | One answer wins. The TUI's auto-accept does not answer a foreign turn (P9). |
| Ask raised between `prepare` and `commit` | Held. | The "Who decides" table. |
| An auto-accept answer in flight at `prepare` | It reached the daemon, or the freeze holds it. | First wins. |
| Attacher dies before `commit` (before or after its `open`) | Socket closes within ms (socket probe). Its `Connection` detaches. Relay aborts. | Relay is owner again, its link newest again, auto-accept back, frozen asks re-decided. Stale presence swept. Turn never noticed. |
| Attacher hangs before `commit` | Lease over at 30 s: abort. A late `commit` finds the socket closed: `release()`, exit 1. | As above. |
| Relay crash before `prepare` | Lock stale; the net fires on keep=false, as S2b. | keep: `run` plan, no hand-over. keep=false: DR-8. |
| Relay crash after `prepare`, before the ack | Net already disarmed: no delete under the TUI. | No ack + lock dead → carries on as owner. |
| Relay crash after the ack, in the drain | In-flight call rejects, the turn errors in the TUI. | Session live, the TUI is owner. |
| keep=false relay at the end of its grace, `prepare` lands | Before the plan is final: `hold`. After: `leaving`. | A delete never meets a `prepared` state (H26). |
| Stop (`kill`, `rm`) during `prepared` | Stop wins: reply `stopped`, abort, normal stop path. | Attacher exits 1. keep=false removes (DR-5): the user asked. |
| Stop after `commit` | Only `drained`; no cancel. | Relay leaves. `rm` goes on and removes under the TUIs, as asked. |
| Stale control socket (relay SIGKILLed) | Lock dead, so the socket is never tried. A next relay unlinks first (P14), under its lock. | Nothing to do. |
| Live relay, no socket yet, or `ENOENT` / `ECONNREFUSED` | Retried 5 s. | S2's refusal. Never a takeover of a live relay. |
| Relay still `starting` | No socket before `turn_started`; after it the open may race: `UnknownSession`. | Exit 1 "still starting: retry", relay unharmed. |
| Control schema skew | `version`, nothing frozen. | S2's refusal. |
| Link down at `commit` | `release` detaches at once (`remote-client.ts:677-680`). | Same end. |

**N clients (Phase A, and the race with B).**

| Event | Behaviour | Convergence |
|---|---|---|
| Two attachers race on a live relay | One gets `prepare`, the other `busy`. | Commit → `handed_over` → it joins. Abort → it prepares. Never a relay and a TUI both deciding. |
| One takes over while another joins, the relay draining | The joiner gets `handed_over` (from step 2 too, under a TUI record). No socket under a TUI record: a TUI is closing it. | A join at once. "Closing" only for that TUI. |
| Two attachers with no relay | Both write presence, both `attachTo`. | Two clients. If the session was gone, both seed the same uid: the daemon's second open attaches to the first's. |
| An ask with N TUIs | On every screen. | First answer wins, the rest withdrawn (probe E). |
| Two answers at once | Allow and deny race. | The first to reach the daemon decides; the loser is silent (probe F). The winner's result is visible in both. |
| A TUI in auto-accept | Answers only its OWN turn's asks (P9). | The other TUI's prompt is withdrawn. |
| The TUI that started the turn quits, others stay | Detach; the turn goes on, foreign to all (probe G). | Own-turn quit is stop-then-exit today, so it cancels first. Accepted: as any client stopping its turn. |
| The newest TUI quits during its model call | `quit()`: the detach routes new calls elsewhere, `modelIdle(10 s)` lets the call finish (probe I). | Past 10 s that call rejects and the others see the turn error: bounded and loud. |
| One TUI `/clear`s | `ifLast`: only a detach while others are attached (probe J fixed); it gets a fresh session in the same resident. | The others go on. At its quit it is not last. |
| `/clear` as the only client | Closes the run's session, as today. | `owner.sessionId` stays; a later `attach` opens it from its record. On keep=false the quit cannot read that session's use (`use === null`): a leftover, "could not tell whether it is in use", `rm`. Q1 did not foresee it; safe side, accepted (fix round 1, finding 8). |
| Two TUIs send at once | `connect`'s rule: the second turn waits or queues (P9). | Unchanged. |
| A non-last TUI crashes | Its `Connection` detaches. Its net fires, sees others alive, does nothing. | Stale presence swept. |
| The last TUI crashes | Turn cancelled, any ask settles. keep=false: the net fires (as a plain `run`). keep: workload stays. | keep: `ps` `tui lost`, `attach` reopens, the pod's copy reachable 30 min. keep=false: the entry stays, `ps` `gone`, `rm`; transcript up to the last save (Q6). |
| Last TUI SIGKILLed or power loss, keep=false | No exit handler (S2b probe B). | Workload stays, `ps` `tui lost`; `attach` then quit, or `rm`. |
| Two last quits in the same instant | Each removes its presence first, so both may see none. The lock lets ONE through; the other finds a holder with no socket, stops nothing, says "another terminal is closing the run". | One delete, its save whole. Never a delete under a client. |
| An attach during the last quit, keep=false | Presence first vs lock first: one sees the other. | The attacher keeps it, or waits and finds it gone. |
| An attacher past `planAttach`, its session closed by the last quit, keep | `attachTo` false, seeded path. | It re-creates the session from the record. Normal. |
| Last quit, link down | `closeSessions` cannot confirm: `sessionsKept > 0`. | `stay`, reason written. keep=false leaves a leftover: safe side, `rm`. |
| Last quit, session never opened (seeded, nothing sent), keep=false | `use === null`. | `stay`, reason written. A second `attach` + quit after a turn, or `rm`. |
| Last quit, delete fails | Written after unmount, `owner.detail` set, net disarmed. | `ps` shows why; `rm`. |
| Last quit, draining relay | Its socket says `handed_over`: `residentStop`, then the lock. | The relay's in-flight call goes: it is quitting anyway. |
| Last quit, last save not confirmed (read-back failed or timed out, or the laptop write failed) | `saved` false: detach, never close; `quitPlan` `stay`, reason written. | The workload and the live session stay; `attach` reopens it, `rm` ends it. |
| Explicit location flags | Compared with each entry (`locationKey`), nothing dialled. Match: the run. No match: today's attach at that place. No match but a live relay of that name: S2's refusal. | Never another place's run, nor its delete. |
| A name reused after a run (`docker rm -f`, plain `run`) | The record's `created` differs from the entry's. | Today's attach, no run identity, no delete. `ps` still shows the old status on that row (a status only, see fix round 1). |
| `plain` attach to another session on keep=false | Not a client of the run. | `use.others > 0` → `stay`, if it is in use. |
| Ink never ran | `finishRun` step 1: `release`, no close, no delete. | The session stays. |
| Saves race | Two snapshots of one history. | The next save, or the last quit's read-back. |
| Different `--profile` in two TUIs | The newest serves the model for all. | Accepted. |
| Disk full at an owner write | A notice; it goes on. | Presence still drives `ps`. |
| Presence dir unwritable | `joinRun` fails: exit 1, nothing dialled. | Without presence the net and the last quit would lie. |

**Attach and version.**

| Event | Behaviour | Convergence |
|---|---|---|
| Version skew, TUI vN+1 vs resident vN, a client attached | Guard refuses a replace (P10), before `prepare`. | "Wait, or attach with vN". The relay never knew. |
| Version skew, protocol | `VersionMismatch` at `initialize`, before `prepare`. | Same. |
| Older daemon, no `closed` | Absent = kept. | `stay`: no delete on a guess. |
| Hostile pod says `closed: true`, `others: 0` | Its own removal, keep=false only. No laptop effect. | Inside "not trusted". |
| Older build reads a TUI record | `unknown` (P11). | `ps`: `unknown owner`. File untouched. |
| Workload gone, owner present | DR-8 message. | Nothing dialled past `describe`. |
| Workload gone after a relay's or last TUI's own removal | Entry and run dir purged: no `owner.json`, so no uid to name. | The ordinary "not found". The launch line gave the `--resume` uid. Accepted. |
| Pod restarted, relay dead | `attachTo` false, seeded path. | As `--resume`. No record → empty session + notice. |
| `attach` not on a terminal, detached-origin run | Refused. | Nothing touched. S2's `< /dev/null` debugging path is gone for these runs. |
| Attach from another folder | Refused, naming the folder. | Record never filed under the wrong project. |
| `--resume <other uid>` with a live relay | Refused. | S2's message. |
| `allow_once` not offered (S2 F7) | The stuck run is now reachable: attach, answer by hand. | Better than S2; no code. |

### Tests (red first; each with its mutation target)

**Phase A.**
- **H1** `remote-client.test.ts`: `modelIdle` resolves only after an open `model/streamChunked` and `model/stream` end; at once with none; at the bound on a hung one. *Mutation:* count only the chunked call.
- **H2** `local-runtime.test.ts`: `attachTo` opens with no `create` and no `messages`; the next `createSession` returns it; a later one is fresh. *Mutation:* `create: true`.
- **H3** `attachTo` on an unknown id: `false`, nothing created, the seeded path still works. *Mutation:* swallow every error.
- **H4** `quit()`: frames show a read-back, then `close{ifLast}`; the read-back's content is on the saver, mid foreign turn. *Mutations:* no last read-back (first-turn transcript lost); plain `dispose`.
- **H5** `integration.test.ts` (daemon): `closed: true` alone, `closed: false` with another attached, two quits in one tick give one `true`; an unknown id gives `false`. *Mutation:* always `true`.
- **H6** `closeSessions` count: `closed: true` → 0; a detach, a timeout, a dropped link, an absent field → counted. *Mutation:* count only `false`.
- **H7** `shared` (probe J): a controller's `close()` with another client attached leaves the session live for it. *Mutation:* drop `closeIfLast`.
- **H8** probe I as a test: the newest client's `quit()` during its model call: the other's turn ends clean. *Mutation:* drop `modelIdle` from `quit`.
- **H9** N clients, real rig: 3 clients, an ask: one answer, the other two withdrawn, tool once; two answers in one tick: no `onError` (probes E, F). Green on today's code: a pin of the load-bearing assumption. *Mutation target, in the daemon:* make `settle` skip `permission_resolved`.
- **H10** `attach-plan.test.ts`: every `planAttach` row in order. *Mutations:* drop the TTY row; let a live relay reach `plain`; add `plain` for a run with TUIs (Q3 lost).
- **H11** every `quitPlan` row in order. *Mutations:* drop `othersAttached`; drop `sessionsKept`; count `running` as a hold.
- **H12** `run-state.test.ts`: presence: dead sweeps, a reused pid (another start) is dead, two listed; `statusOf` cells with `n`; ESC in `detail` stripped. *Mutation:* skip the start-time test.
- **H13** `attach-run.test.ts`: order through one recorded sequence: presence, runtime, `attachTo`, owner, net, mount; quit: presence gone, lock, `residentUse`, `quit`, owner `idle`, `drain`, `remove`, disarm, purge. *Mutations:* delete before `drain`; disarm before the delete; lock released before the delete.
- **H14** the last-quit race, deterministic: an attacher's presence written just before the lock → `stay`; a holder seen by the attacher → it waits, then re-plans. *Mutation:* read the lock before writing presence.
- **H15** keep=false, two clients: the first quits: no delete, net disarmed on it, session live; the second: delete. *Mutation:* delete on any quit.
- **H16** `armSharedExitNet`: fires with no other alive, silent with one, disarm works; a real child as the other. *Mutation:* fire unconditionally (the crash that deletes under another TUI).
- **H17** `main.test.ts`: the broker handed to `attachEngineRuntime` is the one `startTui` gets, on the run path (fake runtime, as the existing single-broker test). *Mutation:* a second broker.
- **H18** DR-8: `describe` null → the exact line, no runtime built; a `describe` that throws goes on. *Mutation:* fall through to the dial.
- **H19** plain `attach box` with a dead relay opens `owner.sessionId`, not a fresh id; bare `--resume` and `--continue` too, no picker; no TTY → refused. *Mutation:* ignore `owner.sessionId`.
- **H20** Ink throws at start: no close, no delete (`finishRun` step 1). *Mutation:* run the quit path.
- **H21** `kept-cmd.test.ts`: `attached (2)`, `tui lost`, `-v` pids. *Mutation:* read only the relay's lock.

**Phase B.**
- **H22** `relay-policy.test.ts`: frozen + auto-accept holds; `thaw` answers it once; `hooks_trust` and a foreign turn stay unanswered after `thaw`. *Mutation:* `freeze` a no-op.
- **H23** `relay-state.test.ts`: every new `exitPlan` row in order; `prepared` clears `exitAt`; a stop still exits; `wantsAwake` false when `done`. *Mutations:* drop the `done` row; drop the `prepared` row.
- **H24** `control-socket.test.ts`: oversize, bad JSON, unknown `schemaVersion` or op → refused, nothing frozen; a path over 103 bytes takes the fallback; a fallback dir of the wrong mode gives no socket. *Mutation:* skip the mode check.
- **H25** `relay.test.ts`, the rig + a second `createLocalRuntime` client on one in-memory resident, mid model stream: `prepare`, TUI open, `commit`, gate open: the turn ends, the call finished on the relay, the next on the TUI, the relay leaves with `session/detach`, no `session/close`. *Mutation:* skip the drain (probe C).
- **H26** keep=false: hand-over at idle: no `remove`, net disarmed, run dir and entry stay; `prepare` during `readUse`: no `remove`. *Mutations:* drop `exitPlan` row 1 or 2 (the repro's line).
- **H27** the relay's net: disarmed at `prepare`, re-armed on abort, never armed after `commit`. Injected `armNet`. *Mutation:* disarm at `commit`.
- **H34** a held ask, hand-over, the TUI answers: the tool runs once; auto-accept relay: nothing answered between `prepare` and the TUI's answer. *Mutation:* freeze after the open (D5).
- **H28** abort: socket closed before `commit`: auto-accept resumes, turn unharmed, saves resume, no `release`. Lease over: same, short lease. *Mutation:* no `thaw`.
- **H29** relay → TUI saves in order: every relay save precedes the ack, none after, with a turn ending during the hand-over. *Mutation:* ack before `stopSaving`.
- **H30** after `commit`: `owner.json` byte-identical through the relay's exit; a stop neither cancels the turn nor writes. *Mutations:* `record` not gated; stop aborts `send`.
- **H31** `prepare` when `leaving`: refused, and the removal completes. *Mutation:* set `leaving` after `release`.
- **H32** two attachers: the second gets `busy`, then `handed_over` and joins; on abort it prepares; it opens only after. *Mutation:* a joiner opens on `busy` (relay + TUI both deciding after an abort).
- **H33** `main.test.ts`: order through one recorded sequence: `prepare`, `attachTo`, `commit`, owner, mount.

Existing tests changing because their contract changes, named here: the `attach` refusal tests in `main.test.ts:802-831` (a live holder reaches the hand-over on a terminal); `CloseResult` expectations of `{}`.

Iterate per file, per phase, then `bun run check` (AGENTS §4). Note: a worktree without `apps/mobile` deps cannot run `tsc -p apps/mobile` (S2b Gate): say so rather than claim it.

### Live test

No separate run. **The single checklist stays where it is: "Live test checklist" in `docs/feat/detached-relay-lifecycle.md`.** Execution appends these items there, numbered on from 26, and fixes two old lines:
- its header sentence ("items that attach wait for the relay's exit") no longer needs to hold;
- item 2's "Quit: the session is still live" becomes: "Quit: the session is closed, the record is on the laptop, `attach <name>` reopens it from the record" (Q1).

The owner runs the combined list once, by hand, after this merges.

27. Held ask, no auto-accept: `attach <name>` from another terminal, no `--resume`: TUI opens the session, the prompt appears, "allow": the tool runs once, the turn ends, the relay is gone, the record is on the laptop.
28. Mid model stream (a long answer): `attach`: the text keeps streaming, no error. `relay.log` shows the drain and `relay exit`.
29. `--auto-accept`, a turn with several tools: `attach` mid-turn: a notice, and the next ask prompts.
30. `kill -9` the `attach` before the TUI appears: the relay goes on and finishes.
31. `attach` from two terminals at once on a live relay: one takes over, the other joins. Both show the session.
32. Two TUIs, an ask: on both screens. Answer on one: gone from the other, tool once. Answer both quickly: one decision.
33. Two TUIs: `ps`: `attached (2)`, `-v` with both pids. Quit one: `attached`, the other goes on.
34. Two TUIs: the newest quits during a long answer: the other's turn ends clean.
35. Two TUIs: `/clear` on one: the other's session goes on.
36. keep, last quit: `ps`: `idle`, container up. `attach <name>`: the same session from the record.
37. keep=false, two TUIs: quit one: container up. Quit the other: container gone, entry gone, run dir gone, record on the laptop.
38. keep=false, `kill -9` the only TUI: container up, `ps` `tui lost`, `rm` clears it.
39. keep=false, two TUIs, `kill -9` one, quit the other: deleted.
40. keep=false, `attach` during the 60 s grace: no removal, or a clean "gone" if it lost the race.
41. Quit mid-turn after a hand-over, keep: the turn stops, what it did is on the laptop, `attach` reopens it.
42. Quit mid-turn after a hand-over, keep=false: per Q6.
43. `attach < /dev/null`: refused, the run unharmed.
44. First turn, `kill -9` the relay: `attach` shows the transcript from the pod.
45. `kill -9` the last TUI: `ps`: `tui lost`; `attach`: same session, up to the last save.
46. `docker rm -f`, then `attach`: the DR-8 line, with the uid; exit 1.
47. `rm` on an attached run: the prompt; "y" removes; the TUIs show the link stopped.
48. A very long `TENTACLE_CONFIG_DIR`: the socket falls back, hand-over works.
49. A second build with another version: `attach` on a live relay is refused before the relay notices: its `relay.log` has no `prepare`.

Kubernetes runs only if a context authenticates.

### Open questions for the owner

- **Q6. keep=false, quit MID-TURN: this conflicts with S2b Q2 ("failed/interrupted keeps the workload"), which reasoned that deleted files are gone.** The same question covers a keep=false run that ended `failed` or `interrupted`, was attached later and is then quit. (a) delete: Q1 as written, the same as a plain `run` quit and the relay's `stop` (DR-5), an explicit act, with the attach-time notice saying so; (b) keep the workload when a turn is running or the run ended badly. **Recommend (a):** a quit is a stop, and S2b Q2 was about ends nobody chose. Its cost: on a foreign turn `/exit` is immediate (P9), so one word deletes.
- **Q7. Size L: one branch or two?** (a) one branch, Phase A then Phase B, a gate between; (b) two branches, Phase A merged first. **Recommend (a):** the same call you made for S2b; the phases touch different code, and the owner's checklist runs once anyway.

## Execution

*— claude-opus-5-5, 2026-10-31*

Worktree `.tentacle/worktrees/detached-handover`, branch `feat/detached-handover` = `main` 3e842c6, nothing committed. **The run was interrupted once** (the executor's 5-hour usage limit) after Phase A and most of Phase B. On resume: `git status`/`git diff --stat` checked; every mutation backup under `.tentacle/tmp/detached-handover/` had already been restored by `cp` right after its own run (each line of the batch reads IDENTICAL), and the current shasums of the Phase-A-only files (`attach-plan.ts` 1eaf16a6…, `kept-cmd.ts` 56fc428c…, `tui-sessions.ts` 0bdfde6e…, `pod-resident.ts` 2cbb9a68…, `connection.ts` 269302a2…, `hosted-session.ts` ea0cf9e1…) equal the post-restore values, and a grep found no mutant left. The backups are OLDER than Phase B's edits, so they were deliberately NOT copied back. Then: `main.ts` routing, the Phase B mutations, the final gate, docs.

**Repro** (`.tentacle/tmp/detached-handover/repro.test.ts`, on 3e842c6; the plan's own scratch scripts were gone, `.tentacle/` is gitignored; `bun test ./…`):
```
modelIdle: undefined
statusOf kind=tui: null
exitPlan keep=false, nobody but a TUI on the session: {"kind":"remove"}
```
plus the existing `main.test` "a live holder" test showing `attach` exit 1 with S2's refusal. Reproduced.

### Phase A, as built (plan order)

1. **Protocol + daemon.** `CloseResult.closed?: boolean` (`protocol/src/session.ts`), schema regenerated (`bun run schema:export`). `Connection.closeSession` answers `{closed:false}` on the `ifLast` detach, else `host.close(id)`'s boolean. `PROTOCOL_VERSION` stays 14. **H5** in `daemon/test/registry.test.ts` (the plan said `integration.test.ts`: the `ifLast` tests T5/T6 live in `registry.test.ts`). Red: `{}` ≠ `{closed:false}`.
2. **Client.** `closeSession(id, {ifLast})`; `RemoteSession` `closeIfLast` via `newSession` opts; `endSession` resolves "confirmed closed"; `closeSessions` → count not confirmed (timeout, drop, absent field, detach all count); `modelIdle(ms)` = a counter wrapped around both `model/stream*` handlers. **Drift:** the counter settles one macrotask after the handler: the peer writes the response only after the handler's promise settles, and a `close()` before that drops it (found by H8: the in-memory pair dropped the result frame and the other client's turn errored "connection closed"). H1 + H6 in `client/test/remote.test.ts` (no `remote-client.test.ts` exists). Red: `modelIdle is not a function` / `undefined ≠ 0`.
3. **`LocalRuntime`.** `shared`, `attachTo`, `quit`, plus `PersistingController.saveNow()` (the last read-back) and `.sessionId` (needed by H2/H3: a controller had no id). H2/H3/H4/H7/H8/H9 in `local-runtime.test.ts` on a real `SessionHost` + `Connection{servesModel}` + proxy model + ask `shell`. Red: `attachTo is not a function`. **Drift (H4):** a snapshot reflects only the COMMITTED history (`HostedSession.recordCut` at `history_commit`), so mid the FIRST model call of a first turn nothing is saveable; H4 holds the relay at its first ask (the S2 "first turn" case), where prompt + call are committed.
4. **`pod-resident.ts`** exports `holderAlive`. **`run-state.ts`**: `kind: "relay"|"tui"`, `attached`, `cwd?`, `control?`; presence `writePresence/removePresence/attachers` (`<runDir>/attach/<pid>-<start>`); `statusOf(read, alive, now, attached)`. **Small addition:** a TUI record with a live lock holder (the last TUI deleting) reads `closing`, not in the plan's table. H12 red: missing export.
5. **`engine-runtime.ts`**: `armSharedExitNet` (a throw of `othersAlive` keeps the workload), `shared` passed through. H16 (`engine-keep.test.ts`, real `sleep` child as the other TUI).
6. **`attach-plan.ts`** (`planAttach`, `quitPlan`): H10/H11. `planAttach` rows as planned; `owner` none + live relay → `refuse relay`; `--resume <other>` under a TUI-run's holder → `plain`.
7. **`attach-run.ts`** (`joinRun` + `finish`). **Drift, honest:** this module was written BEFORE its test file; its tests (H13/H14/H15/H18/H20) were green at first run, so their non-vacuity rests on the mutations below (all killed). **Drift, plan fixed (§8):** finishRun steps 2–3 (see the note in the Design). H14(a) proves the fixed order. Added seam `lockOf`.
8. **`tui-sessions.ts`**: `live` (no "starting fresh"). Red on the assertion.
9. **`kept-cmd.ts`/`kept.ts`**: `relayRow` counts presences, `-v` `attached  pid …`. H21 red on the assertion. Cells: `running · attached (2)`, `running · tui lost` (`statusCell` unchanged: no pid → engine word first).
10. **`main.ts`**: `detachedRunOf` (the kept entry of that name with a record or a live lock), `planAttach`, refusals (`attachRefusal`), `joinRun`, a single retry on `closing`, `runEngineTui(…, finish)` (Ink-ran flag). New `CliIO` seams `attachEngineRuntime`, `startTui`, `tty`. `relayBlocking` is no longer called from `src` (still exported and tested in `run-state.test.ts`): left, small debt. HELP updated. H17/H19 + "another folder" in `main.test.ts`. Contract changes, as the plan named: the "stale holder proceeds" test now passes `tty: true`; three `CloseResult {}` expectations (`registry.test.ts` ×2, `integration.test.ts` ×1) now carry `closed`.

**Mid gate (between phases, Q7):** `bunx tsc --noEmit` clean; `bunx biome check .` 579 files, 0 errors/warnings; `bun test packages` **3825 pass / 3 skip / 0 fail** (3828 tests, 268 files). The first run had 1 fail: `integration.test.ts` "Connection.close() only detaches" expected `{}` — the planned contract change, updated.

### Phase B, as built

11. **`LocalRuntime`**: `stopSaving`, `flushed`, and **`modelIdle(ms)` (drift: the relay's drain needs it; not in the plan's file list).**
12. **`relay-policy.ts`**: `freeze`/`thaw`; a frozen ask is re-decided once on thaw, withdrawn ones never. H22 red: `freeze is not a function`.
13. **`relay-state.ts`**: `handover`, the four events, `exitPlan` rows 1–2 (row 2 also excludes `linkStopped`: a stopped link with `hold` would spin), `tick` clears `exitAt` while `prepared` OR `done` (done: only `drained` ends it), `wantsAwake` false once `done`. H23 red (4 fails).
14. **`control-socket.ts`**: strict newline JSON, 4 KiB, `schemaVersion` 1, reasons + `invalid` (**drift:** an unreadable frame or an out-of-order `commit` needs a reason; not in the plan's table). `controlSocketPath` with the 0700/ours fallback. H24 + a socket round trip; red: missing module.
15. **`relay.ts`**: `controlAt` (seam `controlPath`), `cwd` + `control` in `owner.json`, the server from right after `drive()` starts until `leave`, `prepare` (disarm, freeze, lease), abort (re-arm, thaw), `commit` (flushed, stopSaving, drain, `handed_over`, ack, then `modelIdle` → `drained`), stop guard after commit, `leaving` set with the final plan, no use read once a hand-over began. Seams `leaseMs`, `drainMs`. H25/H26×2/H27/H28/H29/H30/H31/H34 + a busy/session test in `relay.test.ts`: **all 10 red first** (no socket). The relay tests drive the socket by hand (prepare → a second real `createLocalRuntime` client `attachTo` → commit).
16. **`attach-run.ts`** steps 6 and 8 (`prepareHandover`: busy wait, `handed_over` → join, `leaving` → closing, no socket in 5 s → S2's refusal or closing under a TUI record, a dead lock → plain join; `attachTo` false mid hand-over → abort + "still starting"; no ack: lock alive → exit 1, dead → carry on; auto-accept-ended notice). Step 2 now lets a relay-held lock through on a hand-over plan. H32 ×2, **H33 in `attach-run.test.ts` (drift: the plan put it in `main.test.ts`; `main` is a call into `joinRun`, and the mount follows `joinRun` by construction)**, plus no-ack, refusals, no-socket, attachTo-false: 7 red first.
17. **`main.ts`**: a hand-over plan goes to `joinRun` with `relayRefusal` = S2's message. The "live holder" main test changed its contract as the plan said: S2's refusal now for `--resume <other uid>`, and no tty is refused first; a new test shows a live relay on a terminal reaches the hand-over (runtime built, no socket → S2's refusal after the 5 s wait, Ink never mounted).

### Mutations (each: `cp` to the scratch dir + `shasum`, edit, narrow test, `cp` back, `shasum` IDENTICAL)

Phase A (`spec-a.json`, 31): **all KILLED**, after two survivors were fixed in their tests: A03 (H1 count only the chunked call) survived because both calls ended on one gate → H1 now ends them one at a time in both orders; A22 (H14a no authoritative read after the lock) survived because the presence hook fired in the wrong client's join → it now fires inside A's quit. Killed: H5 ×2, H1, H6 ×2 (absent field / dropped link read as closed), H2 (no attach open), H3 (swallow all), H4 (no last read-back), H7 (no `closeIfLast`), H8 (no `modelIdle`), H9 (daemon `settle` emits no `permission_resolved`), H10 ×3, H11 ×3, H12, H13 ×3, H14 ×2, H15, H16, H17 (second broker), H18, H19 (fresh id), H20, H21, `live`. "`quit = plain dispose`" was not run as its own mutant: `dispose` differs from `quit` exactly by the read-back and the drain, both killed separately.

Phase B (`spec-b.json`, 19): killed B01 H22 freeze no-op, B02/B03 H23 rows, B04 H24 mode check, B05 H25 no drain (after H25 was tightened: it first opened the relay's gate before the relay could leave, so it survived), B06b, B07 H26 prepared row, B08 H27 disarm at commit, B09 H34 freeze at commit, B10 H28 no thaw, B11 H29 no `stopSaving`, B12 H30 record not gated, B13 H30 stop aborts `send`, B14 H31 `leaving` after release, B15 H32 open on busy, B16 main refuses the hand-over (Phase A), B17 no-ack carries on, B18 H33 commit skipped. **Surviving, reported:** B06 (drop `exitPlan`'s `done` row, at relay level): a second guard — no use read once a hand-over began → `use === null` → `leave` — also prevents the removal; B06b (both removed) is killed by H26, and B02 kills the row at the `relay-state` level.

### Final gate

`bunx tsc --noEmit` clean; `bunx biome check .` 581 files, 0; `bun test packages` **3855 pass / 3 skip / 0 fail** (3858 tests, 269 files). No `apps/mobile` deps in this worktree, so `tsc -p apps/mobile` (part of `bun run typecheck`) was not run; no stray `apps/mobile/*.js`.

### Docs

AGENTS.md §7 "Pod/container lifecycle": the two sentences replaced exactly as the plan wrote them. `docs/feat/detached-relay-lifecycle.md` checklist: header sentence and item 2 fixed, items 27–49 appended. README (detached runs, `ps`), TODO.md (the S3 line in item 4b), umbrella status line.

### Not verified (the owner's checklist)

Nothing ran over a real bridge, two real TUIs, a compiled relay, a real `kill -9` of a TUI or a relay mid-hand-over, or a real 5-min drain. No Docker, no live test (as instructed). Edge left as is: TUI A `/clear`s (detached), TUI B quits and closes the run's session, A quits last: `residentUse(runSession)` is `null` → `stay` (a leftover, safe side).

## Review

*— claude-opus-5-5, 2026-10-31*

**Verdict: REQUEST-CHANGES (FIX).** The hand-over itself holds. The defects are around it, mainly who `attach` decides is a run. Fresh context, but the SAME model as the executor: shared blind spots survive both passes, and this review did not read every line of the 2 000+ diff.

### Findings

1. **HIGH, `packages/cli/src/main.ts:975` + `:1042`, explicit location flags are ignored (Q4 regression, wrong workload, possible wrong delete).** `detachedRunOf(name, engine)` matches on name and engine only. It runs even when `explicit` is true, and `--namespace`, `--context` and an explicit engine's own endpoint are never compared. The surrounding comment still says "Explicit flags win, so a user's own pod/container still attaches as before". Probe (`.tentacle/tmp/detached-handover/review/flags.test.ts`): a kept docker entry on `kept.sock`, a stale `owner.json{keep:false}`, `DOCKER_HOST=explicit.sock`, `attach --engine docker box`:
   ```
   EXIT 1 runtime built: 1
   [container] resolved box → docker, local
   ```
   The run's location won and `joinRun` ran. Before this branch the check could only refuse; now it redirects. So a user reaching their own `box` in namespace B lands silently on the kept `box` in namespace A, and with keep=false their quit DELETES that one. With two entries of one name, `explicit` also skips the `ambiguous` refusal and the first with a record wins. **Fix:** compare the requested location with the entry's (the printed attach hint carries flags, so "skip when explicit" alone would break it), and pin it in `main.test.ts`.
2. **MEDIUM, `packages/cli/src/attach-plan.ts:51-69`, a stale `owner.json` gives a plain kept workload a run's identity and its delete.** Plain `run` never touches the run dir: the only `runDirFor` uses are the `run --detach` launch and `detachedRunOf` (`main.ts`). The dir's key is engine + location + name, so it survives a name reuse. Sequence: a keep=false run ends `failed`, `docker rm -f box`, `tentacle run --name box` (keep). `attach box` then gets `run{keep:false}` on the old uid, and the quit removes the new workload, which carries the `tentacle.kept` labels `removeVerifiedKept` checks. Q4 says a plain kept workload behaves as before. By reading, plus finding 1's probe, which shows a stale record reaches `joinRun`. **Fix:** tie the record to its entry (`created`, or the session recorded in the spec), or drop the run dir when `run` records the name.
3. **MEDIUM, `packages/cli/src/local-runtime.ts:512-516` + `attach-run.ts:417`, the keep=false delete does not depend on the last save.** `quit()`'s read-back is bounded by a `bounded` that RESOLVES at 3 s, and a `readBack` failure only reaches `onFlushError`. `sessions.saver.drain()`'s returned failure lines are dropped there, and `runSessionTui` prints them after the delete. `quitPlan` has no "saved" input. On a Q6 mid-turn quit of a first turn, the pod held the only copy, so a slow pod or a full disk loses the transcript for good. This contradicts the §7 text this branch adds ("after the last save") and "Nothing is deleted before `saver.drain()`". By reading, not run. **Fix:** a save not confirmed → `stay`, with its reason.
4. **MEDIUM, `packages/cli/src/attach-run.ts:216-229`, a terminal cannot join while the relay drains.** After the first TUI wrote `kind: "tui"`, a later attacher takes the "closing" path: it waits 45 s (`RM_STOP_GRACE_MS`) and exits 1 "still closing". The drain lasts up to 5 min (`HANDOVER_DRAIN_MS`), so the Q3 join fails during any long answer, which is a common moment to attach. The relay's socket still answers `handed_over` then, so the join can happen at once. The failure-mode row says "'Closing', then a plain join". The step-2 comment names this case, so it is a design gap, not a slip. The wording also tells the user the run is closing when it is not.
5. **LOW, `packages/cli/src/relay.ts:253-256` + `:427-431`, the net can be re-armed after `leave`.** A stopped link while `prepared` leaves with `preparer` still set. `control.close()` destroys the socket, `disarmNet()` runs, and only later does `onClose` reach `abortHandover`, which arms the net with the lock released. In the rig, a keep=false relay: `at exit {"armed":1,"disarmed":1}`, 50 ms later `{"armed":2,"disarmed":1,"lockedAtArm":false}`. A real child (`exitorder.ts`) shows `process.exit` firing first, so it does not delete today, but only by event-loop order; if it did, a link blip would delete a workload `exitPlan` chose to keep. **Fix:** clear `preparer` at the start of `leave`, plus a test.
6. **LOW, `packages/cli/src/attach-run.ts:387-389`, the last quit stops ANY lock holder, including another TUI mid-delete.** The table row "At most one sees none and takes the lock" is false. Both quits can remove their presence before either reads. A then holds the lock and B sends SIGTERM to A, whose save and delete are cut. The net converges on the delete, but the transcript may be short. It needs a millisecond interleaving, so low. Stop only a relay, or correct the row.
7. **LOW, tests.** The "Last quit, draining relay" row has no test: `stopHolder` appears in no test file, and my mutant dropping that block died only because H14's hook lives in `lockOf`. `joinRun` was never run against a real relay socket by the suite: `attach-run.test` scripts the dial, `relay.test` drives the socket by hand. Also unpinned: the "still closing" timeout, "Presence dir unwritable", the owner-write notice.
8. **NIT.** `/clear` as the only client on keep=false: the quit leaves a leftover ("could not tell"), which Q1 does not foresee and the table's row does not say. An unmatched socket `busy` wait of up to 35 s prints nothing. After `rm`, a TUI's quit prints "another tentacle holds the run", which is untrue. `relayBlocking` is a dead export (declared). Checklist: see below.

### Gate

`bunx tsc --noEmit` clean. `bunx biome check .` 581 files, 0. `bun test packages` **3855 pass / 3 skip / 0 fail** (3858 tests, 269 files), matching Execution. `tsc -p apps/mobile` not run: no deps in this worktree.

### Mutations

`cp` backups, `shasum -c` OK on all 7 files after restore; tree byte-identical.

| Mutant | Result |
|---|---|
| Executor's B01, `freeze` a no-op | KILLED: H22 ×2, H34, H28 |
| Executor's H16, net fires unconditionally | KILLED: H16 |
| Executor's B13, stop aborts `send` after commit | KILLED: H30 |
| Mine, no `stopHolder` in the last quit | KILLED only incidentally (finding 7) |
| Mine, no `chmod 0600` on the socket | KILLED: control-socket round trip |

**`attach-run.ts` written before its tests.** Red-first was broken and disclosed. The mutations compensate for the rows they reach, and my end-to-end trace adds the real seam; the gap is finding 7. **B06** is an acceptable survivor: a second guard (no use read once a hand-over began) makes it equivalent at relay level, B02 kills the row in `relay-state`, and B06b kills both together.

### Premise table

| Premise | Result |
|---|---|
| Context symptom | Source at HEAD: refusal, no `modelIdle`, `residentUseOf` unchanged. **Repro not re-executed:** it needs a `main` checkout, forbidden here |
| P2 stop aborts `send`, P3 `armExitNet` unconditional, P5 `dispose`, P11 `readOwner` | TRUE (`git show HEAD:`) |
| `resolvePermission`/`settle` one winner, attach replay, `modelLink` newest, `release` cancels only with no link | TRUE (`hosted-session.ts`, `connection.ts`) |
| `session/open` with no `create` never builds | TRUE (`session-host.ts`) |
| P9 `/exit` immediate on foreign turn, no auto-accept of foreign | TRUE (`commands.ts`, `permission-ui.ts`) |
| `permission_resolved` aborts, sends nothing | TRUE (`permission-router.ts`) |
| "Each last quit: at most one sees none" | **FALSE** (finding 6) |
| "Nothing is deleted before `saver.drain()`" as a save guarantee | **FALSE as stated** (finding 3) |

The other `file:line` citations were not each opened.

### Attacks tried

1. **Explicit flags:** finding 1.
2. **Name reuse:** finding 2.
3. **Spin in `exitPlan` `hold`** with a stale `exitNow`: nothing. While `prepared` and not stopping, no event sets it.
4. **Presence identity:** `start` is digits on both `/proc` and `ps` (ms), so the regex never sweeps a live TUI. Nothing.
5. **Single broker over the hand-over:** holds. `prepare` freezes before the open, the attacher's broker holds until mount, `thaw` runs only on abort, so after commit a relay never answers. `--auto-accept` does not carry over: the TUI's broker is new, its record says `autoAccept: false`, and a foreign ask is never auto-accepted.
6. **Control socket:** 0600 in a 0700 dir, fallback checked with `lstat`, uid and mode, `peer !== preparer` refuses a foreign `commit`, oversize closes. A pod has no path to it. Skew gets `version` and nothing frozen. Holds.
7. **Attacher dying inside `commit`:** the relay completes, drains and leaves; a leftover, no delete. Safe side, and not a table row.
8. **Protocol:** `CloseResult.closed` is an optional field in a strip schema, wired on both ends, `protocol.json` regenerated. **No bump needed** (§7 "fields are free"), the meaning of `close` is unchanged, and absence reads as not closed.
9. **End-to-end trace** (temporary test, removed): real `planAttach` + `joinRun` + `runRelay` + `dialControl` + `SessionHost`, keep=false, mid model stream:
   ```
   PLAN {"kind":"run",…,"handover":true,"keep":false}
   RELAY EXIT 0
   OWNER tui:attached
   RELAY CALLS ["describe:box"] RELAY NET {"armed":1,"disarmed":1,"lockedAtArm":true}
   AFTER QUIT ["describe:box","describe:box","remove:box"] tui-armed,tui-disarmed dir: false
   [container] removed box
   ```
   The relay deleted nothing; the last quit did, then the net was disarmed.

### What holds

The load-bearing assumption and the hand-over: freeze before open, the commit order, `exitPlan`'s two rows, keep-awake, no relay write after commit, presence-then-lock against lock-then-presence, `close{ifLast}`, `closed` absent = kept, `/clear` shared, `modelIdle` on quit. **Nothing here was run over a real bridge, two real TUIs or a compiled relay.**

### AGENTS.md §7 edit

Applied as the plan wrote it, and accurate with two exceptions:
- "after the last save" is not what the code guarantees (finding 3).
- "inherits … at the hand-over" omits that a TUI on an ENDED or stale keep=false run (Q5) also arms the net and deletes, with no hand-over at all. Add it.

### Owner checklist (items 27–49)

Complete for the planned behaviour and runnable by hand, with two caveats. Item 30 has a window of moments, so it needs a scripted `kill -9`; item 31's "at once" likewise. Add, once the findings are fixed: `attach --namespace <other>` with a same-named run (finding 1); a second terminal during a long answer (finding 4); a run from another folder; `--resume <other uid>` under a live relay; SIGTERM on the last TUI on keep=false (the net fires, unlike item 38's `kill -9`).

### How the executing model behaved

**Grade: B.** Careful and honest: the usage-limit interruption left no half-finished work or surviving mutant, drift is recorded item by item, the broken red-first and B06 are disclosed, and it fixed a real race in the plan's own quit order (§8). It tightened tests after surviving mutants instead of explaining them away. Against that, it treated "a detached run" as a name lookup without re-checking the old refusal's weaker contract, which produced finding 1, the one that can delete the wrong workload. And some table rows state more than the code guarantees (findings 3, 6).

## Execution — fix round 1

*— claude-opus-5-5, 2026-10-31*

Same worktree, nothing committed. Every finding 1–8 is fixed or decided below; none dropped. All new tests were written first and shown red on the unfixed code (19 fails out of 190, each on the assertion of its property, `.tentacle/tmp/detached-handover/fix1/red.txt`), then green.

### Per finding

1. **HIGH, explicit flags.** `locationKey` (`kept-index.ts:19`) is the one truth of "same place"; `keptFileName` is built on it, byte-identical (pinned in `kept-index.test.ts`). `detachedRunOf` (`main.ts:989`) now takes the place the flags resolve to (`askedAt`: `engineHost` + `keptLocation`, nothing dialled) and compares it with each entry. Match: the run, so the printed hint still works. No match: today's attach at that place. **Decision:** no match but a LIVE relay of that name keeps S2's refusal (`main.ts:1103`): nothing is dialled, so one workload reached by two addresses cannot be told from two workloads, and the existing R13 test (`attach --engine docker … --resume <other>`) stays as it was on `main`. `selectEngine` and the host are resolved once (`asked`, `askedHost`), so a failure prints once and the plain path reuses them. `ambiguous` unchanged. Red: `seen.runtimeBroker` defined (namespace B on A's run); `…551` ≠ `…552` (two entries, the first with a record won). Tests: three `H35` in `main.test.ts`.
2. **MEDIUM, stale `owner.json`.** `OwnerRecord.created` (`run-state.ts:87`) = the kept entry's `created`, written by the relay (`relay.ts:207`) and the TUI (`attach-run.ts:375`). `planAttach` (`attach-plan.ts:54`): a record that does not match, or has no `created`, gives no identity and no delete: `plain`, or `refuse relay` under a live lock, before the `cwd` row. **Decision, a cost:** a run dir from before this field reads as plain (pre-public; a doubt must not delete). **Left:** `ps` still shows the old run's status on a reused name; it is a status, it deletes nothing, checklist item 55 says so. Red: `{kind:"run",…}` for `plain`.
3. **MEDIUM, confirmed last save.** `LocalRuntime.quit` (`local-runtime.ts:519-540`) returns `saved`: the read-back answered within its bound AND `saver.drain()` lists nothing (a failed read-back reaches it through `saver.failed`). `quitPlan` gets `saved` (`attach-plan.ts:106`) and `finish` also counts its own drain's lines (`attach-run.ts:461`). **Beyond the finding, deliberately:** on `saved` false `quit` DETACHES instead of closing (`detachAll`, shared with `release`): keeping the workload but closing the session would still lose the pod's only copy. So `attach` can reopen it. Q1's "quit ends the run" does not hold on that path, on purpose: the run stays, said in one line. Red: `remove` called; `{sessionsKept:0}` for `{sessionsKept:1, saved:false}`.
4. **MEDIUM, join during the drain.** `relayDraining` (`attach-run.ts:131`): one `prepare` on the socket, `handed_over` = a relay draining, no socket = a TUI closing. Step 2 (`:245`) goes on to a join; the "closing" wait stays for the TUI. The TUI's record now keeps `control` (`:377`), else a later terminal could not find a socket off its usual path. Red: `exit` for `joined`; `undefined` for the path.
5. **LOW, net re-arm.** `leave` clears `preparer` first (`relay.ts:254`). Red: H38, `armed: 2`.
6. **LOW, last quit.** The last quit stops a holder only if it answers `handed_over` (`attach-run.ts:421`); another TUI is never signalled, the lock lets one through, the loser says "another terminal is closing the run" and writes no record. The row is corrected. Red: `stop` called.
7. **LOW, tests.** H37 (`stopHolder`, both ways); "still closing" timeout, presence unwritable, owner-write notice in `attach-run.test.ts`; **H39** in `relay.test.ts` runs `planAttach` + `joinRun` over the relay's real socket: A takes over mid model call, B joins during the drain, the relay removes nothing, A's quit removes nothing, B's does; net armed/disarmed 2/2, run dir and entry gone.
8. **NITs.** `/clear` as the only client: behaviour kept (safe side), the table row now says so, checklist item 57. **`busy`:** one line, "another terminal is taking this run over; waiting…". **After `rm`:** nothing untrue: with the run dir gone the quit is silent. **`relayBlocking`:** removed with its two tests; `relayBlockingMessage` stays.

**AGENTS.md §7:** "after the last save" is gone: `quitPlan` now reads "the last save confirmed, read back and written"; the sentence names the attach on an ended or stale run (Q5), and the `created` + explicit-flags condition. The plan's quotation of the old sentence (Implementation, "§7 invariants") is left as history.

**Docs:** `joinRun` steps 2, `finishRun` 3 and 5–8, five failure rows corrected or added. Checklist (`detached-relay-lifecycle.md`): 30, 31, 42, 47 amended, 50–57 added (the review's five, plus name reuse, unconfirmed save, `/clear`).

### Mutations

`cp` to `.tentacle/tmp/detached-handover/fix1/` + `shasum`, `sed -i`, narrow test, `cp` back, `shasum` IDENTICAL after each of the five rounds (`relay.ts` d4aceef4, `attach-run.ts` 635f1387, `attach-plan.ts` 2839ee64, `main.ts` f8ab8247, `local-runtime.ts` 5144bebd then 6894d98e after the simplification below). Several mutants share a round, one per file or per test; each kill below is by name.

| # | Mutant | Killed by |
|---|---|---|
| 1 | `main`: no location comparison | H35 namespace, H35 two entries |
| 2 | `planAttach`: no `created` tie | H35 (plan), H35 (main) |
| 2c | relay writes no `created` | H39 (`refuse`) |
| 3 | `quitPlan` ignores `saved` | H11, H35 not confirmed |
| 3b | `finish` ignores the drain's lines | H35 drain |
| 3c | `finish` ignores `quit.saved` | H35 not confirmed |
| 3e | a timed-out read-back counts as saved | H35 never answers |
| 3f | no saver drain before the close | H35 read-back fails, H35 laptop write |
| 3g | close on an unconfirmed save | H35 ×3 (`local-runtime`) |
| 4 | no drain probe at step 2 | H36 |
| 4b | the TUI's record drops `control` | H36 record |
| 5 | `leave` keeps `preparer` | H38 |
| 6 | stop any lock holder | H37 another TUI |
| 7a | stop no holder | H37 draining relay, H14 |
| 7b | "still closing" timeout returns `closing` | rows test |
| 7c | no return on presence failure | rows test |
| 7d | owner-write notice dropped | rows test |
| 8a | `busy` said on every poll | `busy` test |
| 8b | "another terminal" with the run dir gone | H37 `rm` |

**One survivor, resolved by removing code:** a `lastRead` flag on `saveNow` survived, because a failed read-back already reaches `saver.drain` through `saver.failed`. It was redundant, so `saveNow` stayed `Promise<void>` and `quit` reads the drain; 3f was re-run on that code and killed. **3e and 3g ran before that simplification,** on otherwise identical lines. Not run as mutants: the "live relay elsewhere" refusal (pinned by the existing R13 test) and `main` passing the record's `created`.

The batch runners were not usable here (`python3` and `bun <script>` need an approval this run did not have), so `fix1/edit_tests.py` and `fix1/mutate.ts` are unused; the edits went through the editor and the mutants through `sed`.

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` 581 files, 0; `bun test packages` **3877 pass / 3 skip / 0 fail** (3880 tests, 269 files), no flake on this run. `tsc -p apps/mobile` not run: no deps here. No stray `apps/mobile/*.js`; `bunfig.toml`, `package.json`, `bun.lock` untouched.

### Not verified

No live test (as instructed): H39 is a real socket and a real relay loop, but in-memory channels and a fake engine. The owner's checklist, items 27–57, stays to be run. `--context` is compared by the same `locationKey` but has no test of its own in `main.test.ts`, which needs a real docker context; how to verify: checklist item 50 with `--context`.

## Review — fix round 1

*— claude-opus-5-5, 2026-10-31*

**Verdict: APPROVE-WITH-NITS → READY-FOR-LIVE-TEST.** Findings 1–8 are fixed truthfully; the four new items below are LOW/NIT, none can delete a workload, and none blocks the owner's live checklist (they should be fixed before merge). Fresh context, but the SAME model as the executor and the first reviewer: shared blind spots survive all three passes. Reviewed the exact round diff `db3eb77..ae1b0aa`; the worktree is byte-identical to `ae1b0aa` (tracked diff empty; untracked files' `shasum` equal to the snapshot's).

### Per finding (round 0)

| # | Fixed? | Evidence |
|---|---|---|
| 1 HIGH explicit flags | **Yes** | `main.ts:1011` compares `askedAt` (`keptLocation` of the host the flags build, nothing dialled) with `locationKey(entry)`; a match uses the entry's own `hostOptionsFor`, i.e. the place with the same key. My mutant (comparison always true) → both H35 `main` tests fail (namespace B landed on A's run; `…551` for `…552`) |
| 2 MEDIUM stale `owner.json` | **Yes, for this laptop's index** | `attach-plan.ts:54`; `created` is fresh per `run` (`main.ts:869`) and a reused name re-records the same file → mismatch → `plain`. Mutant (tie skipped) → H35 plan + H35 main fail. Residual: new finding R3 |
| 3 MEDIUM unconfirmed save | **Yes** | `local-runtime.ts:519-540` (`withTimeout` rejects at 3 s → `false`; `saver.drain()` is non-consuming, `session-saver.ts:150`, so `runSessionTui` still prints the lines); `attach-plan.ts:106`. Mutants: `quitPlan` ignores `saved` on keep=false → H11 + H35 ×2 fail; `quit` closes anyway → H35 ×3 (`local-runtime`) fail |
| 4 MEDIUM join during drain | **Yes** | `attach-run.ts:245` `relayDraining`. Mutant (probe removed) → H36 + H39 fail |
| 5 LOW net re-arm | Yes | `relay.ts:254`, H38 (executor's mutant; not re-run, LOW) |
| 6 LOW stop any holder | Yes | `attach-run.ts:421`; a TUI holder is no longer signalled, the loser says so and writes no record. Not re-run (LOW) |
| 7 LOW tests | Yes | H37, H39 over the relay's real socket, rows tests |
| 8 NITs | Yes | `busy` line once, `relayBlocking` removed, `/clear` row documented |

### Mutations (mine)

6 mutants over 4 files, all KILLED (named above). `cp` backup to `.tentacle/tmp/detached-handover/review-fix1/` + `shasum` before, restored after: `main.ts` f8ab8247, `attach-plan.ts` 2839ee64, `local-runtime.ts` 6894d98e, `attach-run.ts` 635f1387, each IDENTICAL to the executor's recorded hash and to `ae1b0aa`.

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` 581 files, 0; `bun test packages` **3877 pass / 3 skip / 0 fail** (3880 tests, 269 files), matching Execution. `tsc -p apps/mobile` not run (no deps).

### The owner's questions

1. **Can explicit flags still reach and delete another location's workload? No.** Every combination resolves to ONE key: `--namespace`, `--context`, `--engine` + `DOCKER_HOST`/endpoint all go through `keptLocation`, the same function `run` records with (`main.ts:878`). Equal key → `joinRun` dials `hostOptionsFor(entry)`, which is that same place. Unequal → never the run: plain attach (user-owned, no net, no delete) or, with a live relay of that name, a refusal. Two addresses of one place (e.g. the docker endpoint without `--context`) fall to plain, the safe side. `--container` alone counts as explicit but names no place: it compares the default location, again safe. `askedAt` null (host does not build) → no match → plain path fails on the same host, printed once. Not new here and out of scope: a key is a NAME (a kube context), so a KUBECONFIG swapped between `run` and `attach` dials another cluster; the no-flag lookup and `rm` share it (S1 design).
2. **Stale `owner.json`:** a plain kept workload recorded by THIS laptop never inherits a run's delete (fresh `created`). Residual R3 below. **`ps` showing the old run on a reused name: acceptable, not blocking** — it deletes nothing, and `rm` on such an entry has no live lock to stop. But it shows the old `keep: false` and session id (`kept-cmd.ts:166-187`), contradicting what `attach` will do; R4.
3. **The two new decisions.**
   - *Explicit non-matching flags + a live relay → S2 refusal:* **safe and the right call.** It is exactly `main`'s name-only refusal, it dials nothing and deletes nothing, and it cannot be told from "one workload, two addresses" without dialling. Its wording is not right: R1.
   - *Unconfirmed last save → detach instead of close:* **safe and the right call**, a deviation from Q1 on a failure path only: closing would end the pod's only copy while keeping nothing on the laptop. The workload stays (keep=false: `stay` with a reason, net disarmed), and the next `attach` reopens the session (Q5 path). Surfacing is partial: R2. The owner should ratify it explicitly (it is recorded in Execution and in failure row 474).
4. **AGENTS.md §7 matches the code.** "the last save confirmed, read back and written" = `answered && drain empty`; the order in `quitPlan` (keep/others → saved → sessionsKept → use) matches the parenthesis; "with no relay left … at the attach itself" and "`created` matches and, under explicit flags, at the place they name" match `planAttach` and `detachedRunOf`.
5. **No single-broker or exit-net regression.** No broker code changed. Net: `leave` clearing `preparer` (H38) only removes a late re-arm; every new `stay` path (`!saved`, lost lock) calls `disarm()` before returning, and a lost lock means another TUI holds it and owns the delete. A stray `relayDraining` `prepare` against a not-yet-handed-over relay freezes and immediately thaws it (socket close → abort), re-arming under the relay's own lock; it is reachable only when `relayHolds` is false while a relay holds, which needs a fresh relay record without `plan.handover` — not found.

### New findings

- **R1 LOW, `main.ts:1103` → `run-state.ts:427-435`, the "elsewhere" refusal tells the user to delete another place's workload.** It reuses S2's text: "box: a detached run owns it (pid N, …). Wait for it, or `kill N` to stop it: stopping it removes the container". The user asked for `--namespace team-b`; the run is in `team-a`. `main` said the same (name-only), so not a regression, but the code now KNOWS the run is elsewhere and does not say where. **Fix:** name `whereOf(run.entry)` and that it is not the place the flags name.
- **R2 LOW, `attach-run.ts:466-470`, the unconfirmed-save detach is half-surfaced.** keep=false: "not removed: the last save was not confirmed — tentacle rm box", with no word that the session is still live and `attach box` reopens it. keep=true: `quitPlan` returns `stay` with no `why` before the `saved` row, so a timed-out read-back (no saver line either) detaches SILENTLY; the user believes the run ended. Harmless (the workload stays by `keep`, Q5 reopens it), but Q1 says a quit ends the run. **Fix:** one line whenever `quit.saved` is false, keep or not.
- **R3 LOW, `kept-cmd.ts:236-257`, the delete does not check the workload's own `created`.** The tie is laptop-index vs `owner.json`. A workload re-created at the same place OUTSIDE this index (another laptop or config dir, `run --keep --name box`) carries the kept labels, and a stale entry + matching stale record here still gets `run{keep:false}` and the quit removes it. Same class already in `rm` and the relay's delete (S1/S2b). **Fix (follow-up, needs plumbing: on k8s `created` is an annotation, `describe` returns labels):** compare `tentacle.created` in `removeVerifiedKept`'s re-read.
- **R4 NIT, `kept-cmd.ts:166`:** apply the same `owner.created === entry.created` tie in `relayRow`, so `ps` and `attach` agree on a reused name.

### Attacks tried

1. Every explicit-flag combination (above): nothing reaches another place.
2. `--container` only / host that fails to build: safe paths.
3. Name reuse via `run --keep` and via plain `run --keep=false` (no labels → `removeVerifiedKept` says `foreign`, no delete): safe. Cross-index reuse: R3.
4. `saver.drain()` twice (quit + finish + `runSessionTui`): non-consuming, failure lines still printed.
5. Zero controllers: `Promise.all([])` → `saved` true, no spurious detach.
6. Draining relay unreachable at the last quit: no stop, lock lost → `stay`, no delete (safe side; the "another terminal" line would then be untrue — tolerable).
7. Mutations: 6/6 killed.

### What holds

Everything the first review listed, plus: explicit flags only ever narrow, never redirect; a record of another workload gives nothing; the delete waits for a confirmed save; a second terminal joins during the drain; the last quit never signals another TUI. **Still unrun:** a real bridge, two real TUIs, a compiled relay, `--context` (checklist 27–57).

### How the executing model behaved

**Grade: A−.** Every finding fixed at the root (one `locationKey` truth instead of a patched comparison; `created` written by both writers), each with a test shown red and a named mutant; it resolved its one surviving mutant by deleting redundant code rather than arguing it away, and kept the R13 test unchanged. It went beyond the brief twice (refusal on a live relay elsewhere; detach on an unconfirmed save), and recorded both as decisions with their cost. The minus: both decisions are surfaced to the user less clearly than to the doc (R1, R2), and the `created` tie stops at the laptop index (R3).

## Execution — fix round 2

*— deepseek-v4.1-flash, 2026-10-31*

Fixes R1, R2, R3 and NIT R4. Each finding: red test first, then the fix, then one
mutation the new test kills (`cp` backup + `shasum` checked identical after the
restore). Nothing outside `packages/cli/{src,test}` touched.

### R1 — the "elsewhere" refusal no longer says `kill`

`main.ts:1110-1118` no longer reuses S2's text. A new pure message,
`elsewhereMessage` (`run-state.ts:426-440`), names BOTH places and the safe next
step; it never mentions `kill` or the removal it causes. `main.ts:1070-1088`
gained `askedWhere` (the flags' place as a locator, `askedAt` now built on it);
`kept.ts:197-204` gained `placeText`, because two local docker sockets both read
`local` and the message must be able to tell them apart (it appends the
endpoint; k8s and endpoint-less entries are unchanged, so `whereOf`'s output is
still what `ps` prints).

Wording: `box: a detached run owns it in 127.0.0.1/team-a (pid N,
waiting-permission), not in 127.0.0.1/team-b, the place your flags name. Nothing
was dialled, and nothing was stopped: drop the location flags (`tentacle attach
box`) to reach the run where it is. Its session is <uid>.`

Red→green: `main.test.ts:1018` (`R1 flags naming ANOTHER place …`) failed on
`Expected to contain "127.0.0.1/team-a"` / `Received "…or \`kill 31503\` to stop
it: stopping it removes the pod…"`, passes after.

The pre-existing R13 test (`main.test.ts:803`) had to change, and honestly: it
asserted `kill <pid>` for the `--engine docker` case, which is exactly the
elsewhere path (the entry's socket vs `DOCKER_HOST`). It now asserts `kill` only
for the no-location-flag case (same place) and the two named places + no `kill`
for the flagged one — the same guarantee, split by what the code knows.

Mutation: `elsewhereMessage` re-worded to offer the pid (mutation on
`run-state.ts:439`) → the R1 test fails on `Expected to not contain "kill"`.
Restored: `run-state.ts` `2345c2cf` identical before and after.

### R2 — an unconfirmed last save is never a silent detach

`attach-run.ts:460-466` says it once, for keep=false AND keep=true, before
`quitPlan`: `box: the last save was not confirmed — the session is still in the
container: \`tentacle attach box\` reopens it`. `attach-run.ts:476-484` also
writes that as the `idle` record's `detail` when `quitPlan` gave no `why`
(keep=true, the silent case), so `ps` agrees with the terminal. `attach-run.ts:54`
holds the one wording (`UNSAVED_NOTE`). keep=false keeps its `not removed: … —
tentacle rm box` line and gains the session line above it.

Red→green: `attach-run.test.ts:561` and `:580` failed on `the last save was not
confirmed` (keep=true: empty output, the exact silent detach) and on `the session
is still in the container` (keep=false: only the `not removed` line), pass after.

Mutation: the `if (!saved)` write removed → both new tests fail (`Expected to
contain "the last save was not confirmed"` / `"the session is still in the
container"`). Restored: `attach-run.ts` `b2e23f4d` identical.

### R3 — the delete checks the workload's own `created`

`kept.ts:88-116` gained `workloadCreated` (k8s annotation, else label) and
`createdVerdict` (`match` / `other` / `unknown`); `kept.ts:243-250` keeps the
facts' `annotations` in `KeptStatus.state`, so `verify` (`kept-cmd.ts:102-110`)
carries them. `removeVerifiedKept` re-reads, and before any `host.remove` asks
`createdVerdict` (`kept-cmd.ts:274-276`): `other` → new `KeptRemoval` kind `other`
(`kept-cmd.ts:216`), nothing deleted, the stale entry dropped. `unknown` (a
workload of an older build that declares no `created`) stays removable exactly
as before — not dating it is not evidence. Callers: `rm` says it and exits 1
(`kept-cmd.ts:417-429`), the relay emits a note (`relay.ts:525-529` — it is the
keep=false removal path), `joinRun`'s quit says `nothing was removed`
(`attach-run.ts:509-514`); `removalFate` gained the `other` wording
(`kept-cmd.ts:225-236`). `joinRun`'s `purge` already covered it (not
`unreachable`/`failed`), so the run dir goes with the stale entry.

Red→green: `kept-cmd.test.ts:447` (labels-only tie → a stranger's container
deleted; failed on `Expected 1`, got 0, with `remove:a` in the calls), `:465`
(k8s annotation; same), `:487` (no `created` declared → still removed, guards the
`unknown` branch). All pass after.

Mutation: `if (createdVerdict(entry, status) === "other")` → `if (false)` →
`:447` and `:465` fail; `:487` stays green, which is the point of its own case.
Restored: `kept-cmd.ts` `d5f499c1` identical.

### NIT R4 — `ps` applies the same tie as `attach`

`kept-cmd.ts:189-201`: `relayRow` shows `sessionId` and `keep` only for a recordwhose `created` is THIS entry's, exactly `planAttach`'s tie. A reused name no
longer promises a session and a delete that `attach`/the quit will not do.

Red→green: `kept-cmd.test.ts:330` failed on `Expected to not contain
"stale-session"`, passes after. The helper `ownerOf` (`kept-cmd.test.ts:142`)
now defaults `created` to the entry's, which is what every other row test meant.

Mutation: `const tied = owner !== undefined && owner.created === entry.created`
→ `owner !== undefined` → `:330` fails. Restored: `kept-cmd.ts` `d5f499c1`.

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` 581 files, 0 errors, 0 warnings;
`bun test packages` **3884 pass / 3 skip / 0 fail** (3887 tests, 269 files) —
before was 3877/3/0, and the 7 new tests are exactly the delta. No flake. No
stray `apps/mobile/*.js`; `bunfig.toml`, `package.json`, `bun.lock` untouched
(no diff). `tsc -p apps/mobile` not run: no deps in this worktree.

### Not verified / left

- No live run (as instructed): R3's tie is proven on a fake engine; on a real
  k8s pod it depends on `describe` returning the annotation, which
  `engine-k8s.ts:206-211` does and `engine-docker.ts:301-304` maps from
  `Config.Labels` (a kept `run` writes `tentacle.created` there via
  `keptMetadata` → `annotations`, `engine-docker.ts:174-175`). Not exercised
  against a real engine; the owner's checklist covers it.
- Two independent tentacles that both declare the same `created` would still tie
  (a clock-identical `run`); not addressed, and not reachable by the review's
  scenario.
- `ps`'s STATUS cell for a reused name still shows the old run's state word
  (`relayRow`'s `text`), which is by design (§ the review's Q2 answer: presence
  wins over any record); only the session and removal columns are tied now.
