# feat/session-hop — Move a live session between local and a container

> **Status:** implementation approved (orchestrator, owner night delegation 2026-11-14)
> **Branch:** `feat/session-hop`
> **Size:** L (split into slices H1–H7, each S/M) · **Blast:** load-bearing (§7: one session path, single broker, pod not trusted, persistence, pod/container lifecycle) · **Suited:** owner-assigned executor; every load-bearing slice (H2, H4, H5, H6) gets a mandatory fresh-context Review before the next starts
> **Changelog:** `changelog.d/session-hop.added.md`

## Context

*— claude-opus-5-5, 2026-11-14*

A tentacle TUI session today is bound for life to the runtime it started on:
the local worker (`main.ts:1959-1988`), a `run` container/pod
(`main.ts:1228-1495`) or an `attach`-ed workload (`main.ts:1553-1930`). The
owner wants the **live conversation to move** — local ⇄ a podman/docker
container with the working folder bind-mounted at the same path — while the
TUI stays the same process and screen.

Owner decisions (2026-11-14, binding):

1. Targets: local ⇄ docker/podman container, cwd bind-mounted at the same
   path. No workspace copy/sync to k8s. The model may also choose to attach
   to an EXISTING docker/podman container or k8s pod (rule: § Design D7).
2. Triggers: a TUI command `/move <target>` (owner) and an agent tool that
   PROPOSES a hop. The tool's hop runs only after the owner's OK through the
   single broker. A hop toward local requested from the container side is
   always confirmed on the laptop and never creates a lasting approval.
3. Only at a turn boundary. A `/move` during a turn is queued until it ends.
4. On hop back, keep or delete the container: the model decides (tool
   argument), within the lifecycle rules: user-owned (`attach`ed) workloads
   are never deleted; only what this hop created is deleted, through the
   verified delete (`removeVerifiedKept`, `kept-cmd.ts:279`).
5. Image: the model may choose it (default: the `run` image from config), or
   an existing workload to attach to.
6. UX: the target label updates on hop; same TUI, no tear, no lost
   scrollback, input draft kept, a transient status line ("moving to
   container …"), and a clean failure path that leaves the session where it
   was.

**Repro (capability missing, 2026-11-14):** `rg -n '"/move"|move_session'
packages` → no match; `TuiOptions.target` is a one-shot prop
(`tui/src/run.tsx:39,152`), and `startTui` gets ONE runtime's `createSession`,
`link`, `jobs`, `mcpStatus` (`main.ts:1970-1983`), so nothing can swap them.

**Repro of the load-bearing assumption (2026-11-14, passes on current
`main`)** — `.tentacle/tmp/session-hop/hop-repro.ts`: two in-memory daemons
(`SessionHost` + `Connection`, the `clear-resume.test.ts` rig), ONE
`SessionSaver`/`LogSessionStore`. Runtime A runs a turn and quits; the laptop
record is loaded and given as `resume` to runtime B on a FRESH daemon; B runs
a turn. Variant `hop-race.ts`: A is NOT quit first and does a LATE `saveNow()`
after B wrote.

```ts
const A = await daemon("reply-A", null);
const ca = A.createSession();
await drain(ca.send("hello from local"));
await ca.flushed(); await saver.drain(); await store.drain();
const uid = ca.sessionId as string;
await A.quit({ ending: true });              // hop-race.ts: removed
const loaded = await store.load(uid);
const B = await daemon("reply-B", loaded.record);
const cb = B.createSession();
await drain(cb.send("hello from container"));
await cb.flushed(); await saver.drain(); await store.drain();
// hop-race.ts: then `await ca.saveNow()` + drains, and reload
```

```
after A: system:sys | user:hello from local | assistant:reply-A
B uid: e3ea1871-… == A uid: true
B model saw: sys | hello from local | reply-A | hello from container
after B: system:sys | user:hello from local | assistant:reply-A | user:hello from container | assistant:reply-B
files: e3ea1871-….jsonl
--- hop-race.ts (late A save after B wrote) ---
after LATE A save: system:sys | user:hello from local | assistant:reply-A | user:hello from container | assistant:reply-B
files2: eda8a278-….jsonl
```

Same uid, B's model got A's whole history, one file, no aside, and a late
save from the old runtime drops nothing.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**A session can be moved by building a second runtime on the SAME broker
and saver, seeded with the laptop's persisted record of the SAME uid, and
the laptop log continues without loss.** This is the existing `--resume`
seed path, not new machinery:

- `createLocalRuntime` seeds the first session from `deps.resume`:
  `createSession` takes `record.id` as the uid (`local-runtime.ts:1001-1005`)
  and `build` opens `client.newSession(record?.messages, uid, title)`
  (`local-runtime.ts:918-923`). The title seeds the open, so a rename survives
  (`:912-921`). Durable images are restored from the record (`:972-990`).
- Every save goes to `deps.saver.write({ id: uid, … })` (`:933-939`). One
  saver means one `<uid>.jsonl`.
- `openSeeded(record)` opens the seeded session eagerly and waits for its
  first save to reach disk (`:1079-1093`, `written()` `:1017-1019`). A hop can
  therefore fail BEFORE the TUI is switched.
- Proven empirically above (repro + race variant).

### Preconditions

- **P1 — one session path.** Every runtime is `createLocalRuntime` over a
  `DuplexChannel`: worker (`local-runtime.ts:1189-1263`), `run`
  (`engine-runtime.ts:631-699`), `attach` (`engine-runtime.ts:762-1108`). A
  hop only picks which one to build next. No new loop, no new channel type.
- **P2 — single broker.** Every runtime takes `deps.permissions`
  (`local-runtime.ts:767,837`). The TUI installs its prompt on the same object
  (`main.ts:1961,1975`). The hop passes the SAME instance to every runtime it
  builds.
- **P3 — the TUI already swaps controllers.** `swapSession(next,
  {keepTranscript})` (`App.tsx:2430-2468`) is "the ONE way the view moves to
  another session". `keepTranscript` keeps the scrollback. Rows queued in the
  TUI go back into the input (`:2461-2464`). `switchingRef` +
  `switchingRefusal` (`App.tsx:2994, 3070-3073, 3101-3104`;
  `sessions-panel.ts:87`) already send a prompt typed mid-switch back to the
  input.
- **P4 — the turn-end deferral pattern exists.** `/clear` during a turn sets
  `clearAfterTurnRef` and runs at turn end (`App.tsx:549, 2049-2050, 2894`).
- **P5 — laptop-originated prompts exist.** `hooks_trust` is a
  laptop-internal `PermissionRequest.kind` (`core/permission.ts:24-30`, "never
  on the wire") asked through the broker (`hooks-trust.ts:183-193`).
  Auto-accept never answers it (`permission-ui.ts:56-58`), and it has its own
  choices (`permission-ui.ts:160-180`).
- **P6 — tool calls are visible laptop-side.** The client maps `tool_call` →
  `tool_start{name, arguments}` and `tool_call_update` → `tool_result{isError}`
  (`client/mapping.ts:254-280`). `persistingController.saved` already wraps
  every turn stream (`local-runtime.ts:478-502`).
- **P7 — the container lifecycle seams exist.** `provisionWorkload` creates,
  waits for and injects into a workload (`engine-runtime.ts:418-622`): a kept
  workload gets labels + `recordKept` (`:497-505`) and is never removed by it.
  `removeVerifiedKept` re-reads the labels and `created` before a delete
  (`kept-cmd.ts:279-304`). The mount plan and its gate come from
  `planWorkspace`/`mountGate` (`main.ts:1296-1342`; `workspace-mount.ts:659,
  776`), and `planWorkspace` mounts at the same path (`workspace-mount.ts:699`).
- **P8 — no raw terminal writes during provisioning when told so.** The
  spinner exists only when `logTerm.tty` (`engine-runtime.ts:207-210`). All
  other output goes to the `log`/`info`/`notify` sinks (`:459-467`).
- **P9 — the attach seams for D7.** `detachedRunOf` (`main.ts:1505-1535`) tells
  whether a laptop detached run owns a workload. `residentUseOf`
  (`relay-state.ts:275-293`) counts other sessions attached, running or with
  jobs on a resident daemon (via `LocalRuntime.residentUse`,
  `local-runtime.ts:1147-1153`). `attachEngineRuntime` never creates or deletes
  (`:749-761`).

### Design

**D1 — Hop = prepare → freeze → open → commit (or roll back).** Orchestrator
`cli/src/session-hop.ts`, with every effect injected (runtime factory, record
reader, verified delete):

1. **Plan** (pure, `hop-plan.ts`): check the request against the current
   state. Refused with one notice, nothing done, when: a turn is running (it
   is queued instead, D4); background sub-agents or shell jobs are running
   (`onSubagents` list, `runtime.sessionJobs(id)`), see Q2; a compaction or
   switch is in flight; the target equals the current one; or the origin is
   not hop-capable (D8).
2. **Prepare** (reversible): build the target runtime with the SAME
   `permissions` and `saver` and `resume: null`. For a new container:
   mount plan + gate (D6), then `provisionWorkload` (kept, D5), then
   handshake (`createLocalRuntime` → `initialize`). For local: a fresh
   worker (`startWorkerRuntime`). Any failure: dispose what was built and
   remove what this hop created (D5). The old runtime is untouched.
3. **Freeze** the old runtime (new `LocalRuntime.freeze()`, about 15 lines):
   `saveNow()` on every controller, then `saver.drain()`, then require
   `saveConfirmed()`. If it is not confirmed: roll back step 2 with "not
   moved: the session could not be saved".
4. **Open on target:** `store.load(uid)` gives the laptop record. Then
   `target.openSeeded(record)`, which awaits the first save on disk. Failure
   (VersionMismatch, open error): roll back step 2; the old runtime is still
   live and was never sealed.
5. **Commit:** seal the old controllers, then `old.dispose()` (which closes
   the old daemon session: worker terminate, or the exec closed). Then apply
   the hop-back delete decision (D5). Then swap the facade (D2), and the TUI
   swaps to the target's controller (D3).

The order "open new, then close old" keeps a live session on every failure
path. The race "old saves after new wrote" was proven harmless
(hop-race.ts) and is closed anyway by the seal in step 5.

**D2 — `HopRuntime` facade** (`cli/src/hop-runtime.ts`). This is what
`startTui` gets instead of one runtime's members. It has stable `link`,
`jobs`, `mcpStatus` and `createSession`, a `target` feed (`current()` +
`onTarget`), and a `daemonInPod` feed. Each delegates to the CURRENT runtime.
Listeners are re-subscribed on swap, and `/clear` after a hop calls
`createSession` on the current runtime. Teardown disposes the current runtime
(and prints a hop-created container's kept line after unmount). It is the
only holder of the broker reference passed into factories.

**D3 — TUI** (logic in pure modules; `App.tsx` only wires):

- `tui/src/hop-command.ts` (pure) parses `/move local [--keep|--rm]`,
  `/move container [<image>]`, `/move attach <engine>:<name>[/<container>]`,
  and `/move cancel`, into a `HopSpec` or an error line.
- New props `hop?: HopFeed` (`start(spec) → {onStatus, done: Promise<{controller,
  target} | {failed: string}>}`, `cancel()`) and `targetFeed?`. `/move` while
  `running` sets a queued spec. At turn end (the `clearAfterTurnRef` spot,
  P4) it starts.
- While a hop runs: `switchingRef = true` (a typed prompt goes back to the
  input, P3), and the transient status row reads `moving to docker:… —
  <phase>` (`status-view.ts`, pure). The draft field is never touched.
- `done` → `swapSession(controller, {keepTranscript: true})`, the badge
  updates from `targetFeed`, and one notice says "moved to …".
  `failed` → one notice; badge, session and transcript are unchanged.
- `TargetBadge` gains no "local" engine: undefined still means local (no
  badge), as today (`target-view.ts:14-19`).

**D4 — Turn boundary.** A hop starts only when the TUI's turn state is idle
and the daemon queue (`onQueued`) is empty. Queued messages run first, and the
hop takes the first true idle. The same rule covers a tool proposal (D9).

**D5 — Ownership of hop-created containers.** They are created KEPT:
`keptMetadata` labels/annotations plus `recordKept` into the laptop index
(the `run` shape, `main.ts:1347-1371`), with `cwd` and `mount` recorded. So
every exit path (crash, SIGKILL, quit) leaves something `tentacle ps` lists
and `tentacle rm` can verify. Nothing is orphaned, and nothing is deleted
blind. No exit net is armed. A delete (hop back with `keep: false`, or a
hop that failed or was cancelled after the create) is ONLY
`removeVerifiedKept(entry, file)`. Its outcome (`gone`/`other`/
`unreachable`) is one notice, and a failed delete leaves the entry listed.
A user-owned (`attach`ed, D7) workload is never deleted: `keep` is ignored
with a notice. TUI quit while inside a hop container: kept (Q1).

**D6 — Mount gate inside Ink.** `planWorkspace` + `mountGate` run as in `run`
(`main.ts:1296-1342`). `refuse` → hop refused. `ask` → a laptop broker prompt
(`kind: "session_hop"`, detail = the warnings, sanitized with `untrustedText`)
instead of the plain y/N line. Provisioning gets `logTerm: {tty: false}`, and
`log`/`info` → the hop status feed, `notify` → notices. Nothing is written
raw while Ink owns the terminal (§7; P8).

**D7 — Attaching to an existing workload (decision).** Allowed only when:
(a) **no laptop detached run** targets it (`detachedRunOf` = null, else that
run's relay/TUIs own the session and lifecycle, `detached-runs.md`); and (b)
after the handshake and BEFORE any open, `residentUse` reports **no other
session attached, running or holding jobs** (`others === 0`, with
`ownMayBeAbsent`). Otherwise: dispose, open nothing, and say "<name> is in use
by another session". Why: the pod daemon is ONE resident per workload. Joining
a busy one shares it with another client's conversation, and that client can
already answer that pod's pod-side asks (`detached-runs.md`, AGENTS §7). A
workload with someone already in it is "not ours to share". Check (b) reads
pod-supplied data, so it is UX, not security. The security still holds
because the model key, approvals and history stay laptop-gated (P2, D9). A
k8s pod is attach-only (no create, decision 1). Its confirmation says "your
folder is NOT shared with this pod" (`attachCwdWarning`,
`engine-runtime.ts:808-817`).

**D8 — Hop-capable origins (v1).** The local worker TUI and a TUI already on a
hop target. `run`, `attach`, detached-run, `connect` and in-process TUIs get
no `hop` prop: `/move` → "not available here" (Q3). This keeps D5's ownership
table to two rows.

**D9 — The agent tool `move_session`** (`tools/src/move-session.ts`). Input:
`{target: "local" | "container" | "attach", image?, workload?: {engine, name,
container?}, keep?: boolean, reason}`. It has NO daemon-side effect and needs
no daemon-side ask. It returns "Proposed; the user will be asked when this
turn ends. Do not assume the move happened." It is registered only in worker
and pod-bridge daemons, behind config `sessionHop.tool` (default on), at the
`contextReset` registration site (`wiring.ts:608-624`). The executor
verifies the daemon-kind discriminator there first; if there is none, STOP and
amend this plan. Laptop side, `cli/src/hop-proposal.ts` (pure) watches an OWN
turn's events for `tool_start{name: "move_session"}` followed by a successful
`tool_result`, parses the arguments with a zod schema (invalid → ignored with
a notice), and queues the proposal for the turn end. There it asks a
**laptop-originated** `kind: "session_hop"` broker prompt with exactly two
choices, Yes (`scope: "once"`) / No. The prompt is never answered by
auto-accept (`autoApproves` excludes it, like `hooks_trust`) and never stored.
The proposal is treated as pod-supplied text on every origin (one rule,
stricter than needed for local). A `/move` the owner types needs no prompt
(only D6's `ask`).

**D10 — Protocol impact: none.** No method, update kind or field changes.
`session_hop` is a laptop-internal `PermissionRequest.kind` (P5). The tool is
a tool definition, not a schema. Version skew in an image: the injected
binary is the laptop's build (`attachEngineRuntime` replace logic,
`engine-runtime.ts:895-1022`). A refused/old daemon fails `initialize` with
`VersionMismatch`, which is step 2 of D1, so the hop is rolled back. No
`protocol.d/` note.

### Files

Dependency order (protocol untouched):

| id | scope | files | Size | Blast | deps |
|---|---|---|---|---|---|
| H1 | Pure modules + their unit tests: `/move` parser; hop plan (refusals, D7 verdict from inputs, D5 delete decision, proposal schema) | `tui/src/hop-command.ts`, `cli/src/hop-plan.ts`, `cli/src/hop-proposal.ts` (+ tests) | S | contained | — |
| H2 | `LocalRuntime.freeze()`; `session-hop.ts` orchestrator (D1); `hop-runtime.ts` facade (D2) | `cli/src/local-runtime.ts`, `cli/src/session-hop.ts`, `cli/src/hop-runtime.ts` (+ `test/session-hop.test.ts` on in-memory daemons) | M | load-bearing | H1 |
| H3 | TUI wiring: `hop`/`targetFeed` props, queue at turn end, switching latch, status row, swap with `keepTranscript` | `tui/src/app-types.ts`, `tui/src/App.tsx`, `tui/src/run.tsx`, `tui/src/status-view.ts`, `tui/src/commands/move.ts` + registry (+ `tui/test/session-hop.test.tsx` frame diffs) | M | cross-module | H1 |
| H4 | MVP end to end: local worker TUI → new docker/podman container (kept, mount gate as prompt, provisioning routed off-terminal) and back to a fresh worker, verified delete on `--rm`; `main.ts` worker path uses `HopRuntime` | `cli/src/hop-targets.ts` (factories), `cli/src/main.ts`, `core/src/permission.ts` (`kind` += `"session_hop"`), `tui/src/permission-ui.ts` (choices + `autoApproves`) (+ tests with a fake `EngineHost`) | M | load-bearing | H2, H3 |
| H5 | `move_session` tool + registration + laptop proposal → `session_hop` prompt at turn end | `tools/src/move-session.ts`, `tools/src/index.ts`, `cli/src/wiring.ts`, `cli/src/hop-runtime.ts` (+ tests) | M | load-bearing | H4 |
| H6 | Attach-to-existing target (docker/podman/k8s) with the D7 rule; hop out never deletes | `cli/src/hop-targets.ts`, `cli/src/hop-plan.ts` (+ tests) | S | load-bearing | H4 |
| H7 | Opt-in live docker test; changelog fragment; README/ARCHITECTURE line | `cli/test/session-hop.docker.test.ts`, `changelog.d/session-hop.added.md`, `README.md`, `ARCHITECTURE.md` | S | contained | H4 |

**Branching: ONE branch `feat/session-hop`, one commit per slice, in table
order. Each commit passes the gate.** Why: the slices are a strict
dependency chain on one doc. Merging after each slice would cost a full
merge + `protocol:bump` + check cycle per slice tonight and buy no isolation
(nothing else touches these files: one code task at a time, §10). One branch
still gives a separately reviewable commit per slice, and the
fresh-context Review runs after H2, H4, H5 and H6 before the next commit.
**H1–H4 is the viable product** (`/move container`, `/move local`). H5–H7 can
stop at any commit boundary and still leave a shippable tree.

### Failure modes

| case | convergence |
|---|---|
| Target fails to start (create, pull, inject, `checkPodBinaries`) | Step 2 fails. The kept entry exists only if the create happened → `removeVerifiedKept`. The old session is untouched, plus one notice naming the daemon log path. |
| Image pull slow | Status row shows the phase (D6 routing). Prompts go back to the input (P3), and the draft stays. `/move cancel` aborts at the next phase boundary, then the same cleanup. The bound is `waitForReady`'s timeout → failure row above. |
| Daemon version mismatch in the image | Injection replaces it, or `initialize` refuses → step 2 failure. A live old resident in an attached workload: `StaleBuildError` refusal (`engine-runtime.ts:906-909`) → D7 refusal. |
| Old session cannot be saved (step 3) | Hop refused before anything opens on the target. The target is disposed and deleted (it is ours). |
| Open on target fails (step 4) | Roll back step 2. The old runtime was never sealed, so it keeps saving. Since the target's first write either never happened or holds the same messages, the file is unchanged in content (race repro). |
| Crash mid-commit (after open, before old dispose) | The laptop log holds the full conversation (step 4 awaited its write). On restart, `--resume` reopens it locally. A hop container is in `ps` (kept). The worker died with the process. |
| Link drops while in a container | The existing reconnect (`execChannelFactory`, `engine-runtime.ts:299-311`) applies. A hop is refused while `link` is not `up` (plan). |
| Pending permission asks | Impossible at a boundary: a turn waiting on an ask is running, so the hop stays queued. |
| Queued messages / steers | Daemon queue non-empty → the hop waits for the next idle (D4). TUI-side queued rows → back to the input by `swapSession` (P3). Steers belong to the running turn. |
| Sub-agents / shell jobs running | Refused with a notice (Q2). Closing the old daemon would kill them silently. |
| MCP servers | Daemon-side, per target. After a hop, `/mcp` probes the new daemon through the facade. Calls in the history to tools that no longer exist fail as unknown tools (honest). Noted in the "moved" notice. |
| Session-scoped approvals, hook trust | Daemon-side approvals do not survive. The new daemon asks again. A pod never gets a lasting approval (D9, §7). Worker hook trust stays stored. A pod asks every session (`local-runtime.ts:830-836`). |
| Tool proposal from a hostile pod (forged events) | It only queues a proposal. The laptop prompt shows sanitized args and only offers Yes/No, never "always". A forged `keep: false` can only delete through `removeVerifiedKept` a workload THIS laptop recorded as hop-created (D5 entry), never a user-owned one. |
| Detached-run records | An origin inside a detached run has no `hop` (D8). An attach target owned by a detached run → refused (D7a). The hop never writes run records. |
| Broker decoupling | One instance, passed by the facade only. Pinned by a spy test plus a mutation (D2/Tests). |
| `/move` to the current target / malformed args | Pure refusal line, nothing built. |

### Tests

Red first, each shown failing before its slice's code (§9):

- **H1:** table tests for the parser and the plan (every refusal and the D7
  verdict matrix: detached run, others>0, others=0), plus the proposal schema
  (valid, invalid, foreign turn ignored).
- **H2** (in-memory daemons, the repro's rig): (1) after a hop, the same uid
  holds all messages and the target model sees the history (the repro as a
  test). (2) A failure injected at each of steps 2/3/4 → old controller still
  `send`s and saves, and the target was disposed. (3) Late old save after the
  target wrote drops nothing (race variant). (4) **Single broker:** a
  daemon-side broker spy on the target sees no ask while the TUI broker gets
  it. **Mutation:** the factory builds the target with `new
  PermissionBroker()` → the test fails, then revert.
- **H3** (ink-testing-library, `app.test.tsx` pattern): frames before and
  after a fake hop. The exact property: **the transcript rows are identical
  and at the same positions**, only the badge/status row differ. The draft
  stays in the input. A prompt typed mid-hop is restored to the input. A
  `/move` during a running turn starts only after its end. On failure the
  badge and transcript are unchanged and one notice appears.
- **H4:** a fake `EngineHost` (create/inspect/openExec over
  `createChannelPair` to an in-memory daemon) checks: kept labels + index
  entry written at create; `--rm` on hop back calls `removeVerifiedKept`
  (spy), and a user-owned target is never deleted; the mount gate's `ask`
  becomes a `session_hop` broker request; and nothing is written to
  `process.stderr`/`stdout` during the hop (spy). **Mutation:** drop `logTerm`
  → the spy fires.
- **H5:** the tool's events → one `session_hop` request at turn end, `once`
  only; No → nothing built. **Mutation:** let `autoApproves` answer
  `session_hop` → the test that auto-accept leaves it pending fails.
- **H6:** the D7 refusals reach dispose-before-open (no `session/open` frame
  sent, checked on the fake channel).
- **H7:** `TENTACLE_DOCKER_TESTS=1` live test: local → container (a file
  written by the agent's shell at `cwd` exists on the host) → local with
  `--rm` → the container is gone, and the conversation is in one `<uid>.jsonl`.
  Skipped otherwise (an opt-in skip, not a failure).

### Owner questions

1. **Quit while inside a hop-created container: keep it or delete it?**
   Recommendation: keep it, listed in `tentacle ps`, with the kept line printed
   after unmount. This matches the `run` default and never deletes on an
   unconfirmed save.
2. **Background sub-agents or shell jobs running at hop time: refuse, or
   confirm and kill them?** Recommendation: refuse with a notice in v1.
3. **v1 origins: only the local-worker TUI and hop targets (`run`, `attach`,
   detached and `connect` TUIs say "not available here")?** Recommendation:
   yes. Extend later as its own task.
4. **Attach rule D7: only a workload with no laptop detached run AND no other
   live session on its resident; k8s attach-only, with a "folder not shared"
   warning.** Recommendation: approve as written.
5. **Default when `keep` is omitted on hop back (`/move local` typed, or a
   tool call without `keep`)?** Recommendation: keep. Deletion is explicit
   (`--rm` / `keep: false`).
6. **`move_session` tool: registered in worker and pod daemons only, default
   on, `sessionHop.tool: false` to disable?** Recommendation: yes.
7. **Should a `/move` the owner types also show a confirmation?**
   Recommendation: no, the owner typed it. The only prompt is the mount
   gate's `ask` (D6).
8. **Session-scoped "always" approvals are lost on a hop (re-asked on the
   new target). Is that acceptable?** Recommendation: accept. Carrying them
   pod→laptop would break the pod-not-trusted invariant.

#### Orchestrator decisions (owner night delegation 2026-11-14)

All eight questions take the planner's recommendation. The owner's own answers
of 2026-11-14 (02:15) are already folded into the design: `/move` plus a
proposing tool gated by an OK, hops at turn end only, docker/podman bind mount,
no k8s workspace sync, model chooses image / existing workload and keep vs delete.
1 keep (listed in `ps`) · 2 refuse with a notice · 3 local-worker origin only in
v1 · 4 D7 as written · 5 keep by default · 6 yes (`sessionHop.tool`) · 7 no
confirmation for a typed `/move` · 8 accept (always-approvals re-asked).
Execution: one branch, H1 → H2 (review) → H3+H4 (review, merge = MVP on main)
→ H5 → H6+H7 (review, merge). *— claude-opus-5-5 (orchestrator), 2026-11-14*

## Execution

*— (pending)*

## Review

*— (pending)*
