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
- `openSeeded(record)` opens the seeded session eagerly (`:1079-1093`). It
  waits for its first save only with a time limit, and it ignores a failure:
  `written()` throws away `drain()`'s list (`:1017-1019`), and `saveOnOpen`
  says "the open itself never fails on it" (`:446-455`). So the hop itself
  must check that the save landed (D1 step 4, design review M1).
- **It holds only for a target daemon that does not already hold this uid.**
  The daemon's `open` ATTACHES a live session with the same id and ignores the
  seed (`daemon/src/session-host.ts:582-585`). D1 step 4 therefore checks the
  target's `session/list` first (design review H1).
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
   `permissions` and `saver` and `resume: null`, by calling the EXISTING
   builders, never a copy of them (review M4). A new container uses
   `startEngineRuntime` (`engine-runtime.ts:631-699`, which already provisions,
   writes the daemon log, watches for faults and redials), with the kept
   metadata (D5), `deferAnnounce` and `logTerm: {tty: false}`. An attach uses
   `attachEngineRuntime`. Local uses a fresh worker (`startWorkerRuntime`). The
   runtime's `log`/`info`/`notify` go to the hop's status and notice sinks for
   its WHOLE life, not only while it provisions: its `disposeTransport` prints
   `quitReport` (`:664-669`), and that can happen while Ink is mounted after a
   hop back. `announce` (the kept line) is called only after unmount (D2). On
   any failure, dispose what was built and remove what this hop created (D5).
   The old runtime is not touched.
3. **Freeze** the old runtime (new `LocalRuntime.freeze()`, about 20 lines,
   the `quit` shape `:1100-1110` without the close). Run `saveNow()` on every
   controller inside `withTimeout(FLUSH_ON_EXIT_TIMEOUT_MS)`, then
   `saver.drain()`, then require that THIS uid is clean. That needs a new
   `saver.cleanFor(id)` (`session-saver.ts:271`: `clean()` covers the whole
   saver, so a failed save of another uid, such as a `/clear` fork, would
   wrongly refuse the hop; review M1). If THIS uid is not clean, roll back
   step 2 with "not moved: the session could not be saved". **Nothing
   persisted yet** (review M2: the store writes no file for an empty history,
   `session-log-store.ts:707-709`, and the uid is lazy until the first open):
   skip the freeze and the load. The target gets `resume: null`, plus the uid
   if one was already minted.
4. **Open on target.**
   (a) **For a target that existed before this hop (any attach), check for our
   own uid first** (review H1). Read `session/list` after the handshake. If it
   lists this uid, first `session/close` it and read the list again. Then seed.
   If the close is not confirmed, or the uid is still listed, refuse: "<name>
   still holds an older copy of this session". A fresh container or worker
   cannot hold the uid, so it skips (a).
   (b) `store.load(uid)` gives the laptop record, then
   `target.openSeeded(record)`, then require `target.saveConfirmed()` for this
   uid (M1). If any of these fails (VersionMismatch, an open error, a save that
   was not confirmed), roll back step 2. The old runtime is still live and was
   never sealed.
5. **Commit** (review M3). **Once step 4 has succeeded, the hop never rolls
   back.** The order: seal the old controllers, swap the facade (D2), let the
   TUI swap to the target's controller (D3), turn auto-accept OFF (D9, review
   H2), and only then run `old.dispose()` inside `withTimeout`. A dispose
   error or timeout is reported as one notice. Then apply the delete decision
   for the place we left (D5). If the old daemon could not be closed, the
   container stays kept and still holds the uid; step 4(a) handles that the
   next time someone attaches to it.

The order "open new, then close old" keeps a live session on every failure
path. The race "old saves after new wrote" was proven harmless
(hop-race.ts) and is closed anyway by the seal in step 5. On a hop, the
segment is written again from the start (a "restating" write,
`session-log-store.ts:895-899`), so typed facts in the old segment (turn
markers, sub-agent reports) drop out of the log, exactly as they do on
`--resume`. This is accepted (review, unverified item 2).

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
by another session". (c) If our OWN uid is live there (a hop whose close
failed, or a TUI killed while inside the container), it is not joined. If it
is running or holds jobs, refuse. Otherwise close it, then seed (D1 step
4(a)). Why: the pod daemon is ONE resident per workload. Joining
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
`contextReset` registration site (`wiring.ts:608-624`). `BuildAgentOptions`
(`wiring.ts:321`) has no field that says which kind of daemon is building
(review M5). So add `BuildAgentOptions.moveSession?: true`. Only the worker
bootstrap and the pod-bridge daemon set it. `serve`, in-process, one-shot
and child-agent builds never set it. Laptop side, `cli/src/hop-proposal.ts` (pure) watches an OWN
turn's events for `tool_start{name: "move_session"}` followed by a successful
`tool_result`, parses the arguments with a zod schema (invalid → ignored with
a notice), and queues the proposal for the turn end. There it asks a
**laptop-originated** `kind: "session_hop"` broker prompt with exactly two
choices, Yes (`scope: "once"`) / No. The prompt is never answered by
auto-accept (`autoApproves` excludes it, like `hooks_trust`) and never stored.
The proposal is treated as pod-supplied text on every origin (one rule,
stricter than needed for local). A `/move` the owner types needs no prompt
(only D6's `ask`).

- **What the `session_hop` prompt shows** (review M6). The laptop writes the
  lines itself, from the resolved plan:
  - the engine;
  - the FULL image reference, or "the default image";
  - the mount, as the host path, read-write;
  - for an attach, "injects tentacle into <workload>";
  - for a hop back, whether the container will be kept or deleted;
  - for a hop to local, "the agent will run commands on this machine".
  Pod-supplied text appears only through `untrustedText`. `reason` comes last,
  labelled as the agent's words. On a proposal, D6's mount `ask` warnings are
  merged into this SAME prompt, so the owner sees one prompt, not two.
- **Auto-accept is reset by every hop** (review H2). Auto-accept is laptop/TUI
  state (`AutoAcceptFeed`, `permission-ui.ts:224-229`; `app-types.ts:354`), not
  daemon state, so the "Session-scoped approvals" failure row did not cover it. At commit
  (D1 step 5) the hop calls `autoAccept.set(false)`, or resets the App's local
  flag when there is no feed. The "moved" notice says "auto-accept is off".
  This applies to every hop, not only hops to local: one rule, and approval
  for the new place is never inherited.
- **The model is told** (review M7). The first prompt sent after a commit
  starts with one line the laptop writes: `[session moved to docker:X —
  background jobs, MCP tools and approvals were reset]`. After a proposal the
  owner refused, it starts with `[move declined]` instead. The line is part
  of the user message, so it is saved as conversation. **An approved proposal
  does NOT send a turn by itself.** The notice says "moved — send a message to
  continue".

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
| H2 | `LocalRuntime.freeze()`; `saver.cleanFor(id)`; `session-hop.ts` orchestrator (D1 incl. 4(a) own-uid close, the "nothing persisted" branch, commit order); `hop-runtime.ts` facade (D2); `hop-plan.ts` gains the own-uid verdict (see the design review response) | `cli/src/local-runtime.ts`, `cli/src/session-saver.ts`, `cli/src/session-hop.ts`, `cli/src/hop-runtime.ts`, `cli/src/hop-plan.ts` (+ `test/session-hop.test.ts` on in-memory daemons) | M | load-bearing | H1 |
| H3 | TUI wiring: `hop`/`targetFeed` props, queue at turn end, switching latch, status row, swap with `keepTranscript` | `tui/src/app-types.ts`, `tui/src/App.tsx`, `tui/src/run.tsx`, `tui/src/status-view.ts`, `tui/src/commands/move.ts` + registry (+ `tui/test/session-hop.test.tsx` frame diffs) | M | cross-module | H1 |
| H4 | MVP end to end: local worker TUI → new docker/podman container (kept, mount gate as prompt, provisioning routed off-terminal) and back to a fresh worker, verified delete on `--rm`; `main.ts` worker path uses `HopRuntime` | `cli/src/hop-targets.ts` (factories), `cli/src/main.ts`, `core/src/permission.ts` (`kind` += `"session_hop"`), `tui/src/permission-ui.ts` (choices + `autoApproves`) (+ tests with a fake `EngineHost`) | M | load-bearing | H2, H3 |
| H5 | `move_session` tool + registration + laptop proposal → `session_hop` prompt at turn end | `tools/src/move-session.ts`, `tools/src/index.ts`, `cli/src/wiring.ts`, `cli/src/hop-runtime.ts` (+ tests) | M | load-bearing | H4 |
| H6 | Attach-to-existing target (docker/podman/k8s) with the D7 rule (incl. D7c); hop out never deletes. FIRST, a separate pure-move commit extracts `detachedRunOf` from inside `main()` (`main.ts:1505`, a closure over `config`/`laptopProc`) into a module (review M8) | `cli/src/detached-run-of.ts` (new), `cli/src/main.ts`, `cli/src/hop-targets.ts`, `cli/src/hop-plan.ts` (+ tests) | S | load-bearing | H4 |
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
| Crash mid-commit (after open, before old dispose) | The laptop log holds the full conversation (step 4(b) required `saveConfirmed`). On restart, `--resume` reopens it locally. A hop container is in `ps` (kept) and its resident daemon may still hold the uid live. A later `/move attach` to it closes that copy and seeds again (D1 4(a), D7c), and never attaches the stale copy. The worker died with the process. |
| Old dispose fails or hangs (after commit) | It has a time limit, and the result is one notice. The hop is not rolled back (D1 step 5). A kept container still holding the uid → D7c the next time. |
| Nothing saved yet (`/move` as the first action) | No freeze or load. The target opens unseeded with the minted uid, if there is one (D1 step 3). |
| Auto-accept on before a hop | Turned off at commit, with a notice (D9). The first tool ask on the target reaches the prompt. |
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
  PermissionBroker()` → the test fails, then revert. (5) The store fails the
  target's first write → the hop is rolled back and the old session is still
  live (M1). (6) A save failure on ANOTHER uid does not refuse the hop (M1).
  (7) `/move` before anything was saved → the target opens unseeded, with no
  load error (M2). (8) The target daemon already holds our uid live with
  STALE history → it is closed and then seeded, and the target model sees the
  laptop's history (H1). A close that cannot be confirmed → refused. Mutation:
  skip 4(a) → (8) fails. (9) `old.dispose()` throws or hangs after step 4 →
  the TUI is still on the target, one notice, no rollback (M3). (10) The
  reviewer's rollback rig (`.tentacle/tmp/session-hop/review-rollback.ts`)
  as a test: one `.jsonl`, no `.aside`, both runtimes `saveConfirmed`.
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
  `process.stderr`/`stdout` during the hop (spy). The spy stays on through a
  hop BACK, including the target's dispose, and through a faulted run, whose
  `quitReport` must reach the notice sink (M4). **Mutation:** drop `logTerm`
  → the spy fires. Auto-accept on → hop → the next tool ask reaches the
  prompt (H2). **Mutation:** skip the reset → this test fails.
- **H5:** the tool's events → one `session_hop` request at turn end, `once`
  only; No → nothing built. **Mutation:** let `autoApproves` answer
  `session_hop` → the test that auto-accept leaves it pending fails. The
  prompt's detail holds the engine, the full image, the host mount path
  (read-write), the delete intent, and `reason` last and sanitized; it is ONE
  prompt even when the mount gate says `ask` (M6). `serve`, in-process and
  sub-agent registries do not list `move_session`, and the laptop watcher
  ignores a sub-agent's `tool_start` (M5). The next prompt after a commit
  carries the moved line, and after a refusal the `[move declined]` line (M7).
- **H6:** the D7 refusals reach dispose-before-open (no `session/open` frame
  sent, checked on the fake channel). Own uid live and idle on the target →
  a `session/close` frame is sent before the seeded open; own uid running →
  refused (D7c).
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

#### Design review response (Fable REVISE)

Review: `.tentacle/tmp/session-hop/design-review.md` (claude-fable-5-2,
REVISE). Each finding was checked against the code at `24ad40a`. **All 10 are
accepted, and none is rebutted.** The fixes are written into the sections
above. This section only records the evidence and what changes for H1 and H2.
The owner decisions (1–8) are unchanged: none of these fixes needs a new
owner answer.

| # | verified at | resolution (where in the plan) |
|---|---|---|
| H1 | `daemon/src/session-host.ts:582-585`: `open` with a live `sessionId` → `live.attach(...)`, and the seed is ignored. `residentUseOf` leaves our own uid out of `others` (`relay-state.ts:287-291`). So D7(b) passed, and the stale copy was attached. | Load-bearing assumption (new bullet) · D1 step 4(a) · D7(c) · Failure modes (crash row + a new row) · Tests H2(8), H6 |
| H2 | `AutoAcceptFeed` is laptop state (`tui/src/permission-ui.ts:224-229`, `app-types.ts:354`, `main.ts:1186`). `autoApproves` excludes only `hooks_trust` (`permission-ui.ts:56-58`). | D9 "Auto-accept is reset by every hop" · D1 step 5 · Failure modes · Tests H4 |
| M1 | `written()` throws away `drain()`'s list (`local-runtime.ts:1017-1019`). `saveOnOpen` never fails the open (`:446-455`). `saveNow()` has no time limit (`:707-712`). `saveConfirmed` includes the saver-wide `clean()` (`:1134-1135`; `session-saver.ts:271-273`). `drain()` returns text lines, not ids (`:280-284`). | Load-bearing assumption (bullet fixed) · D1 steps 3 and 4(b) · new `saver.cleanFor(id)` · Tests H2(5)(6) |
| M2 | `session-log-store.ts:707-709`: no file for an empty history. | D1 step 3 "nothing persisted" branch · Failure modes · Tests H2(7) |
| M3 | `dispose` awaits `closeSessions()` with no time limit (`local-runtime.ts:1038-1044`). | D1 step 5, new order + "never rolls back" · Failure modes · Tests H2(9) |
| M4 | `startEngineRuntime` (`engine-runtime.ts:631-699`) already does what `hop-targets.ts` would have copied. `disposeTransport` prints after unmount (`:664-669`). | D1 step 2 calls the existing builders, sinks live as long as the runtime · Tests H4 |
| M5 | `BuildAgentOptions` (`wiring.ts:321`) has no daemon kind. The site at `:600-624` is shared by every kind of build. | D9 `moveSession?: true` · Tests H5 |
| M6 | D9 said only "sanitized args". | D9 "What the `session_hop` prompt shows" (one merged prompt) · Tests H5 |
| M7 | The seed is messages only (`local-runtime.ts:918-923`). | D9 "The model is told". An approved proposal does not send a turn by itself. · Tests H5 |
| M8 | `detachedRunOf` is a closure inside `main()` (`main.ts:1505`). | Files H6: pure-move extraction commit first |
| unverified 1 | rollback rig not run (by either side) | It becomes test H2(10). Still unverified until H2 runs it. |
| unverified 2 | `session-log-store.ts:895-899` restates the segment | Accepted, same behaviour as `--resume` (note under D1) |

**What this means for the executed H1 slice.** H1 stays as built. Nothing
it ships is wrong, but two pure modules are now incomplete, and **H2 must
extend them** (red first, §9):

- `hop-plan.ts` `AttachVerdict` (`:139-171`) gains a third outcome,
  `{kind: "close-own"}`. It needs a new input, `own: {running, jobs} | null`
  (whether our uid is live on the target; computed from the same
  `session/list` read, because `ResidentUse` has no "own present" field,
  `relay-state.ts:284-292`). If own is live and idle → `close-own`. If own is
  running or holds jobs → `refuse` "<name> still holds an older copy of this
  session". This is checked after `detachedRun` and before `others`. New
  table rows and a mutation (drop the `own` branch → the row fails).
- `hop-proposal.ts` `proposalNotice` stays the one-line notice. The full
  prompt detail (M6) is a NEW pure builder (`hopPromptDetail(plan,
  mount)`) that H5 adds. The image/delete/sanitize properties that H1 already
  pins are reused, not changed.
- `hopPlan`'s refusals do not change: M2's "nothing persisted" branch is
  handled in the orchestrator (D1 step 3), not in the plan.

*— claude-opus-5-5, 2026-11-14*

## Execution

### H1 — pure modules and their unit tests (`feat/session-hop`, slice H1 only)

*— claude-opus-5-5, 2026-11-14*

**Load-bearing check re-run first (as instructed).** `.tentacle/tmp/session-hop/hop-repro.ts`
on this branch (`9b4ca46`, worktree `.tentacle/worktrees/session-hop`) — PASSES,
unchanged from the plan:

```
after A: system:sys | user:hello from local | assistant:reply-A
B uid: 44b724e0-… == A uid: true
B model saw: sys | hello from local | reply-A | hello from container
after B: system:sys | user:hello from local | assistant:reply-A | user:hello from container | assistant:reply-B
files: 44b724e0-….jsonl
```

The capability is still missing (`rg -n '"/move"|move_session' packages` → no
match before this slice). Proceeded.

**As built, in order.**

1. **`packages/tui/src/hop-command.ts`** (+ its export in `tui/src/index.ts`) —
   `parseHopCommand(raw)` → `HopParse`: `spec` / `cancel` / `error`.
   `HopSpec` is a DISCRIMINATED union (`local` | `container`(+`image?`) |
   `attach`(+`workload`)) rather than the plan's single optional-field shape:
   the parser already knows which target it read, and every consumer (H2's
   orchestrator, H3's feed) then branches on `target` with no impossible state.
   `keep` defaults to true (decision 5) on all three.
2. **`packages/cli/src/hop-plan.ts`** — `hopPlan` (D1 step 1 + D4's queue),
   `hopCancelPlan`, `attachVerdict` (D7), `hopDelete` (D5), plus `workloadText`
   / `placeText` (the `engine:name[/container]` form every notice and the badge
   share). Refusal order: capable (D8) → hopping → link → switching →
   compacting → same place → jobs → sub-agents → queue (`running || queued`).
   A refusal always beats a queue: background work is never deferred behind a
   turn that may run it again.
3. **`packages/cli/src/hop-proposal.ts`** — `hopProposalSchema` (zod),
   `hopSpecOf`, `hopProposalStep` (D9's own-turn watch), `proposalNotice`
   (the owner's line before approving, with pod-supplied name/reason through
   `untrustedText`).

**Red first.** All three test files were run against stubs whose bodies
returned a constant (`parseHopCommand` → an error row, `hopPlan`/`attachVerdict`
/`hopDelete` → their permissive answer, `hopSpecOf` → `null`,
`hopProposalStep` → `none`): **28 of 39 failing**, each on its own property
(e.g. `expected {kind:"delete"}, received {kind:"keep"}`), never on an import or
compile error. Then implemented → green.

**Mutation checks (each broken, narrow test run, reverted).**

| # | mutation | result |
|---|---|---|
| M1 | `/move --rm` never sets `keep=false` | 1 fail — "--rm asks for a delete…" |
| M2 | `capable` checked AFTER the queue rows (D8) | 1 fail — "not hop-capable says so…" |
| M3 | daemon queue ignored (D4) | 1 fail — "queued messages run first" |
| M4 | `detachedRun` branch dropped (D7a) | 2 fail — detached-run + "names the workload" |
| M5 | a `null` `residentUse` allowed to join (D7) | 1 fail — "a doubt does not join" |
| M6 | `createdByHop` ignored (D5) | 1 fail — "--rm deletes ONLY what this hop created" |
| M7 | a failed `move_session` still proposes | 1 fail — "a failed or refused call proposes nothing" |
| M8 | `own` ignored (a foreign turn proposes) | 1 fail — "a FOREIGN turn never proposes here" |
| M9 | `keep` defaults to false | 3 fail — schema + step tests |
| M10 | the delete term dropped from `proposalNotice` | 1 fail — "a delete is said out loud" |
| M11 | `reason` not through `untrustedText` | 1 fail — "sanitized (AGENTS §7)" |

All reverted; the narrow files are green (42 tests).

**Drift from the Implementation, and why.**

- **`packages/cli/package.json` + `bun.lock`: `zod: 3.23.8` added to `cli`'s
  dependencies.** The plan puts the proposal schema in `cli/src/hop-proposal.ts`,
  and `zod` was not resolvable from `packages/cli` (probe: `Cannot find package
  'zod'`); every other schema-owning package already depends on it at the same
  pin. Additive, no version change.
- **`HopSpec` is a discriminated union** (above), not one optional-field object.
- **`HopParse`/`HopCancelPlan` are separate unions** — a `cancel` is not a hop.
- **New pure exports H2/H3 will need** and the plan implies but does not name:
  `workloadText`, `placeText`, `hopCancelPlan`, `proposalNotice`,
  `MOVE_SESSION_TOOL`, `HOP_PROPOSAL_INVALID`, `NO_HOP_PROPOSAL`,
  `HOP_USAGE`, `HOP_ATTACH_USAGE`, `HOP_ENGINES`. All are decisions, so they
  live in the pure modules (§7), not in a component.
- The plan's `/move attach <engine>:<name>[/<container>]` grammar is enforced as
  written, including the two asymmetries it implies: docker/podman REFUSE a
  `/container` part (they have none) instead of ignoring it, and k8s allows at
  most one.
- **`bash`-level scratch only** (`/Users/gmeghnag/tentacle/.tentacle/tmp/session-hop/`:
  the repro, the mutation scripts, backups). Nothing else was touched; no other
  slice started.

**Not in this slice (H2+ owns it):** nothing reads these modules yet, so no
user-visible behaviour changes at H1 — the changelog fragment is written now
because the plan pins `changelog.d/session-hop.added.md` to the task and a
fragment must exist before the MVP lands.

**Gate (on the tree as left):**
`bunx tsc --noEmit` → 0 · `bun run typecheck` (incl. `apps/mobile`) → 0 ·
`bun run lint` → `Checked 1118 files`, 0 errors/warnings ·
`bun test` → **8558 pass, 3 skip (the documented opt-ins), 0 fail** across 613
files. No protocol schema changed (`packages/protocol/schema/protocol.json`
untouched — D10: no wire change, no `protocol.d/` note).

*— deepseek-v4.1-flash-1017, 2026-11-14* (corrected in fix round 1: the H1 block
was signed `claude-opus-5-5`, which was wrong — `night-task.sh` runs the step as
`tentacle --profile deepseek`, whose model is
`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`; Review finding 3.)

### Fix round 1 — the H1 review's HIGH/MEDIUM findings

*— deepseek-v4.1-flash-1017, 2026-11-14*

**Finding 1 (HIGH) — the owner approves an image they never see.** FIXED.
`proposalNotice` now always names the image for a `container` target, through
`untrustedText`: `a container running <image>`, or `a container (the default
image)` when none was given (`cli/src/hop-proposal.ts:180-186`). The reviewer's
own repro (`.tentacle/tmp/session-hop/review/r.ts`) now prints
`… to a container running attacker.io/x:latest — faster builds`.

**Finding 2 (MEDIUM) — the tool path and `/move` accepted different grammars,
and two notices interpolated a pod-supplied name raw.** FIXED.
- ONE validator, `hopWorkload(engine, name, container)`
  (`tui/src/hop-command.ts:38-84`), used by BOTH the typed grammar
  (`parseWorkload`, `:168-196`) and the proposal (`hopSpecOf`,
  `cli/src/hop-proposal.ts:132-146`): docker/podman refuse a container part,
  k8s takes at most one, every part must be non-empty and match
  `^[A-Za-z0-9][A-Za-z0-9._-]*$` (so `:`, `/`, whitespace, control and bidi
  bytes are out) and be ≤ 253 chars. `{engine:"docker", container:"x"}` is now
  `null` here exactly as it is an error there.
- `workloadText` sanitizes both parts (`cli/src/hop-plan.ts:56-59`), so every
  notice built on it — `attachVerdict`'s two refusals and the one `hopPlan`
  prints for "already in …" — is clean; `hopDelete`'s "not ours" notice
  sanitizes too (`:198`). `samePlace` compares a new structural `workloadKey`
  (`:62-67`), not the display text, so sanitizing cannot make two different
  workloads look equal.
- Two new exports for H3's UI (`HOP_NAME_USAGE`, `HOP_WORKLOAD_PART_MAX`), and
  `parseWorkload` no longer names an unknown engine as one that "has no
  container part" (`/move attach aws:box/x` → the attach usage).

**Finding 3 (MEDIUM, process) — the signature.** FIXED: the H1 block's closing
signature is corrected above, with the evidence (finding 3 was right; the H1
executor was the same DeepSeek run as this one, not Opus). The blocks' own
opening signatures and the Review's signatures are left as their authors wrote
them.

**Red before green (§9).** Each fix's test was written first against the
pre-fix code and run: 8 new/changed assertions failing on their own property,
then green. `packages/cli/test/hop-proposal.test.ts` (+2 tests),
`packages/cli/test/hop-plan.test.ts` (+1), `packages/tui/test/hop-command.test.ts`
(+2 +1 row): 42 → 50 tests.

**Mutations (each broken in the FINAL tree, narrow tests, restored, md5
checked).** Script and inputs: `.tentacle/tmp/session-hop/fix1/mut.sh` +
`m_*.{old,new}`.

| # | mutation | result |
|---|---|---|
| F1 | `proposalNotice` back to `"a container"` (image dropped) | 2 fail — "the image is NAMED…" + "it names the target…" |
| F2a | `hopSpecOf` skips `hopWorkload` (old grammar, raw workload) | 1 fail — "a proposed workload obeys the SAME grammar" |
| F2b | `workloadText` interpolates the name/container raw | 1 fail — "a pod-supplied name is sanitized…" |
| F2c | `hopDelete`'s notice interpolates the name raw | 1 fail — same test (its second half) |
| F2d | the shared charset/length guard → `if (false)` | 3 fail — both charset tests + grammar parity |
| F2e | the "docker/podman have no container part" guard dropped | 3 fail — both container-part tests + grammar parity |

All restored byte-identical (`md5` before == after, printed per run); after each
run `git status`/`git diff --stat` were unchanged and the narrow files green.

**Not fixed here (deliberately).** Nothing in the review's HIGH/MEDIUM is left
open. Two notes for H4, not findings: `hopProposalSchema` caps no length on
`image`/`reason` (both are display-capped by `untrustedText` at 1000 chars,
and the daemon-side value is validated where it is finally used), and
`hopSpecOf` does not reject a whitespace-only `image` — the image is resolved
and gated in H4 (D6), where it is consumed.

**Gate (final tree):** `bunx tsc --noEmit` → 0 · `bun run typecheck` (incl.
`apps/mobile`) → 0 · `bun run lint` → `Checked 1118 files`, 0 errors/warnings ·
`bun test` → **8566 pass, 3 skip (the documented opt-ins), 0 fail** across 613
files.

*— deepseek-v4.1-flash-1017, 2026-11-14*

## Review

### H1 — fresh-context adversarial review (scope: `git diff main...HEAD`, slice H1)

**Verdict: REQUEST-CHANGES**

**Findings (HIGH/MEDIUM only)**

1. **HIGH — the owner approves a container whose image they never see.**
   `cli/src/hop-proposal.ts:176-181`: `proposalNotice` turns any `container`
   spec into "a container" and drops `spec.image`. D9 says the prompt "shows
   sanitized args". Scenario: a hostile pod, or a prompt-injected model, calls
   `move_session{target:"container", image:"attacker.io/x:latest", reason:"faster builds"}`.
   The owner reads `_the model proposes moving this session to a container — faster builds_`
   (reproduced in `.tentacle/tmp/session-hop/review/r.ts`) and says Yes. The
   attacker's image then gets the owner's cwd bind-mounted (D6) and runs the
   session's tools. This breaks §7 "pod not trusted": the laptop prompt is the
   only gate, and it hides the one argument that matters. Fix: show the image
   through `untrustedText` (or "the default image"), and add a test plus a
   mutation for it.
2. **MEDIUM — the tool path and `/move` accept different grammars.**
   `hop-proposal.ts:21-25,132-141` accepts `{engine:"docker", container:"x"}`.
   `hop-command.ts:141-143` refuses the same spec as a typed `/move`. That
   contradicts the module's own claim that "a typed `/move` and a proposed
   move are the same thing everywhere downstream" (`hop-command.ts:21-22`). A
   proposed docker spec with a container makes `samePlace`/`workloadText`
   (`hop-plan.ts:51,67`) print `docker:box/x`, and H6 must then guess what it
   means. The zod schema also allows any characters in `name`/`container`
   (`:`, `/`, control bytes). `attachVerdict` and `hopDelete` (`hop-plan.ts:146-156,180`)
   put those names into notices WITHOUT `untrustedText`, though they came
   from a proposal. Fix: one shared workload validator for both paths, and
   sanitize the names in those notices.
3. **MEDIUM (process) — the signature may be wrong.** The commit `a8c2b6a` is
   titled "exec (deepseek)", but the Execution section is signed
   `claude-opus-5-5`. §10 requires the signature of the model that wrote it.
   The orchestrator must confirm which model executed and correct the
   signature.

**Gate:** I ran only the touched files: 42 pass / 0 fail, 97 expects.
`bun run lint` clean (1118 files). `bun run typecheck` 0. I did not re-run
the full `bun test`.
**Mutation:** I dropped `queued > 0` from `hopPlan` (D4). "queued messages run
first" FAILS (18/1). Reverted, and `git status` is clean. The executor's
M1–M11 table looks plausible: the tests name the property they pin.
**Attacks tried:** (a) a hidden image in the proposal → finding 1. (b) The
grammar of the proposal path vs `/move` → finding 2. (c) A refusal must beat a
queue (jobs/sub-agents during a running turn): it holds, and the reason is
documented. (d) A foreign turn, or a failed call, must never propose: it
holds (`hop-proposal.ts:73,92`). (e) Deleting a workload this hop did not
create: refused (`hop-plan.ts:179`). (f) Reverted mutation, tree
byte-identical: it holds.
**What holds:** the modules are pure (no IO, no React). There is no protocol
change (D10). Deletes are only decided, never executed. `keep` defaults to
true on both paths.
**Note:** the reviewer is Claude Opus. If the executor really was DeepSeek,
this is a different model family, which is good for blind spots.

*— claude-opus-5-5, 2026-11-14*

### Round 2

**Verdict: PASS.** Scope: `git diff HEAD~1` (`4c07fc0`).

- **Finding 1 (HIGH) — fixed.** `proposalNotice` names the image, passed through
  `untrustedText` (`hop-proposal.ts:186-188`), or says "the default image". The
  repro now prints `… a container running attacker.io/x:latest — faster builds`.
  Mutations: hiding the image again → "the image is NAMED" FAILS; using the
  image raw → "a pod-supplied image is sanitized" FAILS.
- **Finding 2 (MEDIUM) — fixed.** Both paths share one validator,
  `hopWorkload` (`hop-command.ts:68-95`). The proposal path now refuses
  `docker` with a container part (repro → `null`). `workloadText` and the
  `hopDelete` notice sanitize names. `samePlace` compares raw keys, so the
  comparison is not affected by sanitizing. Mutations: skipping `hopWorkload`
  in `hopSpecOf` → the grammar test FAILS; dropping the charset regex → 2
  tests FAIL; dropping `untrustedText` from `workloadText` → the attachVerdict
  sanitize test FAILS.
- **Finding 3 (process) — fixed.** The H1 Execution signature is corrected to
  `deepseek-v4.1-flash-1017`, and the reason is stated. So the reviewer
  (Claude Opus) and the executor are different model families.
- **Regressions checked:** the charset `[A-Za-z0-9][A-Za-z0-9._-]*` covers
  docker and podman names and IDs. k8s DNS-1123 is a subset of it, so a
  k8s-invalid name such as `a_b` reaches the engine and fails there, loudly.
  An image keeps its free form (no validator), but a bad reference fails at
  the engine, before anything is opened. Nothing new at HIGH/MEDIUM.
- **Gate:** the 3 touched test files pass (50 tests, 0 fail, 132 expects).
  `bun run lint` is clean (1118 files) and `bun run typecheck` passes. All
  mutations were reverted, and `git status --porcelain` is empty.

*— claude-opus-5-5, 2026-11-14*

### H2 — `freeze`/`cleanFor`, the orchestrator (D1), the facade (D2)

*— claude-opus-5-5, 2026-11-14*

**Load-bearing check re-run first (as instructed).** On this branch
(`51753d0`, worktree `.tentacle/worktrees/session-hop`), both rigs PASS:

```
$ bun .tentacle/tmp/session-hop/hop-repro.ts
after A: system:sys | user:hello from local | assistant:reply-A
same uid before open: 3a60c0d9-…
B uid: 3a60c0d9-… == A uid: true
B model saw: sys | hello from local | reply-A | hello from container
after B: … | user:hello from container | assistant:reply-B
files: 3a60c0d9-….jsonl

$ bun .tentacle/tmp/session-hop/hop-race.ts
… after LATE A save: … | user:hello from container | assistant:reply-B
files2: 963d2584-….jsonl
```

The third rig the plan names — `review-rollback.ts` ("unverified 1") — also
passes, and became test H2(10): a rollback AFTER the target's first save leaves
one `.jsonl`, no `.aside`, both runtimes `saveConfirmed`.

**As built, in dependency order.**

1. **`packages/cli/src/session-saver.ts`** — `cleanFor(id)`: one uid's
   pending/failed state, so a failed save of ANOTHER session (a `/clear` fork,
   a second TUI) does not refuse a hop (review M1).
2. **`packages/cli/src/relay-state.ts`** — `OwnUse` + `ownUseOf(list, id)`:
   our own uid's presence/use AND the others from the ONE `session/list` read
   D1 4(a) needs (`ResidentUse` has no "own present" field, so a second read
   could disagree with itself), plus `residentUseFrom` for its `ResidentUse`
   view.
3. **`packages/cli/src/local-runtime.ts`** — five additive members, all on the
   existing seams: `freeze(id)` (the `quit` shape WITHOUT the seal/close, then
   `saver.cleanFor(id)`), `saveConfirmedFor(id)` (that uid's own read-back —
   not the runtime-wide `clean()`), `sealSessions()` (the `quit` seal loop,
   without closing), `ownUse(id)` (one `sessionList` read → `ownUseOf`), and
   `closeOwn(id)` (close, then a FRESH `session/list` must no longer list it).
4. **`packages/cli/src/hop-plan.ts`** — `OwnUidVerdict`/`ownUidVerdict`
   (`absent`/`close`/`busy`/`unknown`) as its OWN pure decision, and
   `attachVerdict` gains the `own` input and the `close-own` outcome, checked
   after `detachedRun` and before `others` (design-review H1).
5. **`packages/cli/src/session-hop.ts`** (new) — `hopSession(old, {spec,
   sessionId}, deps)`: the ordered D1 sequence with every effect injected.
   `not moved: …` is the one failure shape.
6. **`packages/cli/src/hop-runtime.ts`** (new) — `createHopRuntime`: stable
   `createSession`/`jobs`/`link`/`mcpStatus` over a swappable current runtime,
   `current()`/`target()`/`onTarget`, and the only holder of the shared broker
   + saver it hands every factory.

**Drift from the Implementation, and why (each was a contradiction with the
code, fixed in this doc rather than forced):**

- **`onTarget`/`target()` are feeds on the facade, not `HopFeed`/`TargetFeed`
  props.** D2 pins the facade's shape; the TUI's props are H3's slice. Nothing
  in H3's design changes: `hop-runtime.ts` exposes exactly the
  `current()`-plus-listener pair D2 describes.
- **`build` takes the `sessionId` too** (`build(spec, shared, sessionId)` /
  `build(spec, sessionId)` inside `hopSession`). D1 step 3 requires the
  "nothing persisted" branch to open the SAME uid with `resume: null`; passing
  only the spec left the factory unable to know the uid, and the alternative
  (a fabricated empty record) would mint a different one.
- **`openSeeded()` is called with NO argument in the nothing-persisted case.**
  `LocalRuntime.openSeeded(record?)` treats a present-but-`null` argument as
  "replace the seed with nothing" (`local-runtime.ts:1207-1211`), so the
  M2 branch must pass nothing at all.
- **The record is read (`deps.load`) BEFORE the build**, not between the build
  and the freeze. An `unreadable` copy is a refusal that must not create (and
  then have to delete) a container, and it makes M2's branch a measured fact
  rather than a guess. The freeze still runs before any open.
- **D7's "someone else is there" stays the FACTORY's check, not the
  orchestrator's.** It must precede every open, and `hopSession` cannot make a
  check that runs before its own `openSeeded` be the factory's. H6 wires
  `attachVerdict` into the factory; H2's orchestrator does only D1 4(a) (our
  OWN uid), which the plan also puts before the open.
- **`onCommit` is awaited after the seal, and a throw is the NOTICE, not a
  rollback** — the plan's step 5 order (seal → swap → auto-accept off) with M3's
  "never rolls back" made literal.

**Red first.** The pre-execution stage had no `session-hop.ts`/`hop-runtime.ts`
and no `own` input at all, so the first run of `test/session-hop.test.ts` was
RED on the property itself (not on an import): `attachVerdict`'s new rows failed
with `expected {kind:"close-own"}, received {kind:"allowed"}`, and the
orchestrator's first draft failed 6 of 17 rows (record not seeded → the target's
model saw only its own turn; `badge` carrying `kind`). Each was fixed at the
place the failure named, then green.

**Mutation checks (each broken in the final tree, the narrow file run, restored,
md5 verified — script `.tentacle/tmp/session-hop/h2/{mut-plan,mut-orch,mut2}.sh`).**

| # | mutation | result |
|---|---|---|
| P1 | `attachVerdict`'s `own` branch dropped (D1 4(a)) | 2 fail — "our OWN uid live and idle…", "…running or holding jobs…" |
| P2 | `own.running`/`own.jobs` ignored (D7c) | 2 fail — same pair |
| P3 | `ownUseOf` reports no own row | 4 fail — the two above + both `ownUseOf` read rows |
| M1 | `saveConfirmedFor` check skipped (target's save not required) | 1 fail — "the target's first write fails…" |
| M2 | `freeze`'s answer ignored | 1 fail — "step 3 (the old session cannot be saved)…" |
| M3 | seal BEFORE the open (the forbidden order) | 1 fail — "step 4 (the open fails)… still sends + saves" |
| M4 | D1 step 4(a) skipped (review H1) | 2 fail — both stale-copy rows |
| M5 | bare unbounded `old.dispose()` (M3) | 2 fail — dispose throws / hangs |
| M6 | facade hands the factory a FRESH `PermissionBroker` (D2) | 1 fail — "the ask after a hop reaches the TUI's broker…" |
| M7 | the "nothing persisted" case treated as a load error (M2) | 1 fail — "a session with no turn and no file hops…" |
| M8 | `freeze` also seals (the `quit` shape with the seal) | 2 fail — "freeze … leaves the runtime live" + step-4 rollback |
| M9 | `freeze` answers the saver-wide `clean()` (M1) | 1 fail — "a save failure on ANOTHER uid does not refuse the hop" |
| M10 | the unreadable copy checked AFTER the build | 1 fail — "refuses the hop BEFORE anything is built" |

**One mutation was VACUOUS at first and the test was fixed, not the code** (§9's
non-vacuity rule): M3 (seal before the open) passed because my rollback helper
took a FRESH controller (`createSession()`) after the failed hop — a sealed
controller is invisible to a new one. `stillLive` now reuses the SAME controller
the hop met and asserts its own file holds the next turn; M3 then fails as it
must. That is the exact "prove the correlated property" trap §2 names.

**Tests** (17 → 22 in `packages/cli/test/session-hop.test.ts`; +4 rows in
`hop-plan.test.ts`, +4 in `relay-state.test.ts`): the plan's H2 list, all ten
items, plus the two `freeze`/`saveConfirmedFor` facts and the unreadable-copy
and no-uid refusals.

**Not in this slice (deliberately).** Nothing calls the facade yet: `main.ts`
still hands `startTui` the worker runtime's members (H4). No engine is dialled,
no kept entry written, no delete run (H4's factories are the `build`), and
`attachVerdict`'s `detachedRun` input is H6's. No protocol change, no
`protocol.d/` note, no new changelog fragment: H2 is internal plumbing behind
`changelog.d/session-hop.added.md` (H1), which already carries the feature's one
bullet (AGENTS §10 — the changelog is curated, not a commit mirror).

**Gate (final tree):** `bunx tsc --noEmit` → 0 · `bun run typecheck` (incl.
`apps/mobile`) → 0 · `bun run lint` → `Checked 1121 files`, 0 errors/warnings ·
`bun test` → **8596 pass, 3 skip (the documented opt-ins), 0 fail** across 614
files. No protocol schema changed. All mutations reverted (md5 of every touched
source matched its pre-mutation backup).

*— claude-opus-5-5, 2026-11-14*

## Review — H2 (fresh-context adversarial; scope `git diff main...HEAD`, slice H2)

**Verdict: REQUEST-CHANGES.** (Note: H2's as-built notes sit under `## Review`, line ~810, not `## Execution`; move them.)

1. **HIGH — "absent file" read as "nothing to move" loses the conversation** (`packages/cli/src/session-hop.ts:127-154`). The M2 branch is taken on `load → absent` *before* the freeze, so a session that HAS turns but whose writes failed (saver `failing` for this uid: lock held, EACCES, ENOSPC) skips `freeze`, opens the target unseeded, and, once the failure clears, commits. Repro `.tentacle/tmp/session-hop/rev-h2/repro.ts`: `load before hop: absent notices: 1` → `outcome: moved moved to docker:box` → `on disk after hop: system:sys`. The first turn is gone from the live session and the disk, and the hop said "moved". This breaks "a hop never moves a session it could not put on disk" (D1 step 3) and the plan's own M2 condition (the uid was minted *and opened*). Fix direction: freeze first whenever this runtime holds a controller for the uid, then load; take "nothing persisted" only when no controller has that uid.
2. **MEDIUM — a throw in step 4(a) skips the rollback** (`local-runtime.ts` `closeOwn`: `await client.closeSession(id)` is not caught; `session-hop.ts:158` does not catch either). A dropped link or a daemon error makes `hopSession` reject. `target.rollback()` never runs, so the target runtime, and in H4 a container this hop created, leaks, and the caller gets a rejection instead of `not moved: …`. Repro output: `hopSession REJECTED: link dropped rollback calls: 0`. The same applies to `deps.afterLeave` throwing after the commit: the TUI has already swapped, but `hop()` rejects, so `notify` and `status(null)` never run (`hop-runtime.ts:169-170`).
3. **MEDIUM — the facade does not move job listeners** (`hop-runtime.ts:122-123`). `onStart`/`onExit` bind to the runtime that is current when the TUI subscribes, and nothing re-binds them on a swap (only `link` is relinked). After a hop the TUI never hears about the target's job exits. D2 says "Listeners are re-subscribed on swap", and no test covers it.
4. **MEDIUM — the commit-time seal is untested** (`session-hop.ts:197`). Mutation: comment out `old.sealSessions()` → `session-hop.test.ts` **22 pass, 0 fail**. That seal is how step 5 "closes" the old-save-after-new race. M3/M8 in Execution cover sealing *too early*, not sealing *never*. Reverted, `git status --porcelain` empty.

**Gate:** 5 touched/new test files 124 pass, 0 fail, 376 expects; `bun run lint` clean (1121 files); `bun run typecheck` passes. Full `bun test` not re-run (scope: slice H2).
**Attacks with no finding:** single broker (the facade hands `deps.shared` to every build; this matches Execution's M6); 4(a) close needs a fresh `session/list` with no cursor; `saveConfirmedFor` is per uid and false with no controller; dispose is bounded and its notice holds.
**Model note:** the reviewer is the same model as the one Execution is signed by (only the context is fresh), so blind spots they share may survive both passes.

*— claude-opus-5-5, 2026-11-14*
### Fix round 1

*— claude-opus-5-5, 2026-11-14*

Scope: the four findings of `## Review — H2` above (1 HIGH, 3 MEDIUM). Each got a
regression test written first and shown RED on the pre-fix code, then the fix, then
a mutation that breaks the fix again and shows the test FAILING on the property
(not on an import, not on a counter).

**1 (HIGH) — an absent file read as "nothing to move" lost the conversation.
FIXED.** Root cause: `hopSession` took `load → absent` to mean "never opened" and
skipped the freeze, so a session whose writes failed (lock, EACCES, ENOSPC) moved
unseeded and the conversation was gone from the live session AND the disk while the
hop said `moved`.

- `local-runtime.ts:186` — new `holdsSession(id)`: does THIS runtime hold a
  controller for the uid? Synchronous and local (`:1203`), no daemon round trip.
- `session-hop.ts:137` — `holdsIt = old.holdsSession(sessionId)`; `:153` the freeze
  now runs when `stored.status === "ok" || holdsIt`, and `:167` the SEED is read
  again after it. The pre-freeze read keeps exactly one job: refusing an
  `unreadable` copy *before* a container is created.
- That second read also fixes the neighbouring hole the first fix exposed: a
  **stale** file (an earlier save landed, a later one failed) is as wrong a seed
  as an absent one, and only a post-freeze read heals it (test 2 below).

Tests (`session-hop.test.ts`, `describe("fix1 HIGH: …")`) — the store's directory
is `chmod 0o500`d (as `relay.test.ts` does), which is what a lock or a full disk
does: (a) a turn whose save failed is still the hop's history — the target's model
sees `precious first turn`, `loads === ["absent","ok"]`; (b) a **stale** file is
healed, not seeded — the target's model sees both local turns; (c) a runtime that
holds NOTHING of the uid still takes the old "nothing persisted" path with
`frozen === 0` (the guard must not turn a real empty session into a refusal).

Mutations (`.tentacle/tmp/session-hop/fix1/mut-a.sh`, `mut-b.sh`):

| # | mutation | result |
|---|---|---|
| F1a | `const holdsIt = false` (the pre-fix branch) | 1 fail — "a turn whose save failed is still the hop's history" |
| F1b | `const again = stored` (seed from the pre-freeze read) | 2 fail — (a) and "a STALE file … is healed, not seeded" |

**2 (MEDIUM) — a throw in step 4(a) skipped the rollback. FIXED (orchestrator).**
Root cause: `closeOrRefuseOwn` was awaited bare, so a rejection escaped
`hopSession`, `target.rollback()` never ran, and the caller got a rejection instead
of `not moved: …` (in H4: a leaked container). `session-hop.ts:180` now wraps it:
one `notMoved(... "not joining it (<reason>)")` with the target rolled back.

Drift, recorded honestly: I first also wrapped `client.closeSession(id)` inside
`local-runtime.ts`'s `closeOwn` — and **reverted it**. `RemoteClient.closeSession`
is contracted never to reject (`remote-client.ts:1432-1440`: "Resolves when the
daemon answered — or the request failed … never rejects"), so that catch was dead
code no mutation could reach (attempted: a closed transport still resolved). The
reachable failure is the `ownUse` read, which is what the orchestrator guard covers.

Same finding, second half: `deps.afterLeave` throwing after the commit. `hopSession`'s
own `try` (`:240-247`) turns it into a notice, and the facade passes `afterLeave`
through unchanged (`hop-runtime.ts:203`) — I removed the duplicate catch I had first
put in the facade, so there is ONE place that decides it (and `errorText` is no
longer imported there).

Tests — `describe("fix1 MEDIUM: 4(a)'s guard …")`: a target whose `ownUse` rejects
(a dropped link) is refused, `rolledBack === 1`, the notice names the reason; and
`describe("fix1 MEDIUM: a throw before the commit …")`: `afterLeave` rejecting gives
`moved`, the badge on the target, `statuses.at(-1) === null` and the reason in the
notices.

Mutations (`mut-c.sh`, `mut-g.sh`):

| # | mutation | result |
|---|---|---|
| F2a | 4(a)'s guard removed (`own = await closeOrRefuseOwn(…)` bare) | 2 fail — both rows, `hopSession` REJECTS |
| F2b | `hopSession`'s `afterLeave` catch removed | 1 fail — "`afterLeave` throws after the commit" |

**3 (MEDIUM) — the facade did not move job listeners. FIXED.**
Root cause: `onStart`/`onExit` delegated straight to `current.jobs`, so the TUI's
subscription stayed bound to the runtime it subscribed on; after a swap it never
heard a target job exit (D2: "listeners are re-subscribed on swap").
`hop-runtime.ts:114-133` adds the same indirection `link` already had — one set per
feed, `rejobs()` re-binding to the new `current` at the commit (`:196`, after
`relink()`), dropped on `dispose` (`:219-222`).

Test — `describe("fix1 MEDIUM: the facade re-subscribes job listeners on a swap")`,
with `handDriven(runtime)` giving each runtime a feed driven by hand: before the hop
the facade is bound to the initial runtime, after it to the TARGET and no longer to
the old one; a `fireExit`/`fireStart` on the target reaches the listener subscribed
BEFORE the hop, and the old runtime's feed reaches nobody.

Mutation (`mut-d.sh`): `onStart`/`onExit` delegating to `current.jobs` (the pre-fix
shape) → 1 fail, "a job exit on the TARGET reaches the listener subscribed BEFORE
the hop" (`first.bound()` showed `{starts:2}`: two live bindings, one to a dead
runtime).

**4 (MEDIUM) — the commit-time seal was untested. FIXED (test only, no code
change: the seal was correct).** Mutation: comment out `old.sealSessions()`.

Test — `describe("fix1 MEDIUM: the commit-time seal really seals (step 5)")`: the
old runtime is deliberately NOT disposed (`dispose: async () => {}`, its session
still open daemon-side, as a worker whose terminate failed), the hop commits, the
target saves a turn, and then the old runtime is asked to save. Sealed, it starts no
write at all (`saver.observe` counts 0 for the uid), the file keeps the target's
history, and `seals === 1` is asserted LAST so the failure is the behaviour.

This one needed two tries, and the first was vacuous (AGENTS §9): asserting only the
`seals` counter proved the call, not the property; and with the old runtime disposed
(`m.close()` → `client.close()`) its save was already a no-op, so the behavioural
assertions passed on the mutated code too. The fix was the test — keep the runtime
live — not the source.

Mutation (`mut-e.sh`): `old.sealSessions()` commented out → 1 fail on
`expect(writes).toBe(0)` (received 1), i.e. the old runtime DID start a save of the
target's file.

**Test count:** `packages/cli/test/session-hop.test.ts` 22 → 30 rows (+8). No other
test file changed. The four fix-1 `describe`s are grouped at the end of the file
under `// --- fix round 1 (H2 review): the four HIGH/MEDIUM findings, as tests ---`,
each row naming its mutation in a comment above the assertion (the file's existing
convention).

**Gate (final tree):** `bunx tsc --noEmit` → 0 · `bun run lint` → `Checked 1121
files`, 0 errors/warnings (2 formatting errors from my first pass, fixed with
`biome check --write`) · `bun test` → **8604 pass, 3 skip (the documented
opt-ins), 0 fail** across 614 files. One row failed the FIRST full run
(`connect-model-error.test.ts:142`, "Invalid API Key" vs the mock server's
"unauthorized"); it passes in isolation and passed on the re-run — a
load-related flake in a file this task does not touch, not a regression. No protocol change, no
`protocol.d/` note, no new changelog fragment (fix round of an unreleased slice;
`changelog.d/session-hop.added.md` still carries the feature's one bullet).
Every mutation reverted, `md5` of each touched source matched its pre-mutation
value (printed by each script), `git status --porcelain` shows only the four
intended files.
