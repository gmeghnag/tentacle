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
   still holds an older copy of this session". A copy with another client
   ATTACHED to it is not closed at all — it is refused like a running one (H6
   review fix round 1, finding 2: `attached` is the only field that says a
   plain `tentacle attach` TUI is sitting in an idle-looking session). A fresh
   container or worker cannot hold the uid, so it skips (a).
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
is running, holds jobs, or has a client ATTACHED (`running || jobs > 0 ||
attached > 0`), refuse — closing an idle copy under an attached TUI ends that
client's session just as surely as killing a turn. Otherwise close it, then
seed (D1 step 4(a)). Why: the pod daemon is ONE resident per workload. Joining
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
  `{kind: "close-own"}`. It needs a new input, `own: {running, jobs, attached} |
  null` (whether our uid is live on the target; computed from the same
  `session/list` read, because `ResidentUse` has no "own present" field,
  `relay-state.ts:284-292`). If own is live and idle and nobody is attached →
  `close-own`. If own is running, holds jobs, or has a client attached →
  `refuse` "<name> still holds an older copy of this session". This is checked
  after `detachedRun` and before `others`. New table rows and a mutation (drop
  the `own` branch → the row fails; drop `attached` from the verdict → the
  attached-client row fails).
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

### Round 2

**Verdict: APPROVE** (H2, scope `git diff HEAD~1`).

- **Round 1 finding 1 (HIGH) is fixed.** `session-hop.ts` now freezes whenever `old.holdsSession(uid)`, and reads the seed again *after* the freeze. The round-1 repro (`.tentacle/tmp/session-hop/rev-h2/repro.ts`) now gives `not moved: the session could not be saved` and loses nothing (before: `moved`, and only `system:sys` on disk). A session that is open but empty (no file after the freeze) still opens unseeded (M2).
- **Round 1 finding 2 is fixed.** If `closeOrRefuseOwn` throws, the hop is refused and the target rolled back (repro: `can't tell whether docker:box holds this session — not joining it (link dropped)`). If `afterLeave` throws, the hop still counts as moved, with one notice.
- **Round 1 finding 3 is fixed.** `rejobs()` re-subscribes `onStart`/`onExit` on every swap, and `dispose` detaches them.
- **Round 1 finding 4 is fixed.** A test now pins the commit-time seal.
- **Mutations: 6 of 6 caught**, each by its own test. Dropped `|| holdsIt`; stale `stored.record` used as the seed; the 4(a) catch rethrown; the `afterLeave` catch rethrown; `rejobs()` skipped on commit; `sealSessions()` skipped. All reverted, and `git status --porcelain` is empty.
- **Gate:** 6 test files (session-hop, hop-plan, relay-state, local-runtime, hop-proposal, hop-command): 211 pass, 0 fail. `bun run lint` is clean (1121 files) and `bun run typecheck` passes. Full `bun test` not re-run.
- **Regressions:** none at HIGH or MEDIUM. The new code only adds a guard and catches; the commit order and the single-broker hand-off are unchanged.

*— claude-opus-5-5, 2026-11-14*

### H3 + H4 — the TUI's half and the MVP end to end

*— claude-sonnet-4-5-20250929, 2026-11-14*

**Load-bearing check re-run first** (as instructed, on this branch at `228a3ca`,
worktree `.tentacle/worktrees/session-hop`). Both rigs PASS, unchanged from H2:

```
$ bun .tentacle/tmp/session-hop/hop-repro.ts
B uid: 9751027a-… == A uid: true
B model saw: sys | hello from local | reply-A | hello from container
files: 9751027a-….jsonl

$ bun .tentacle/tmp/session-hop/hop-race.ts
after LATE A save: … | assistant:reply-B   files2: one .jsonl
```

So the assumption H3/H4 stand on is intact and no STOP condition applied.

**As built, in dependency order.**

*H3 — the TUI (D3, D4).*

1. `packages/tui/src/hop-command.ts` — `hopStep` (pure): the TURN BOUNDARY, from
   facts the TUI owns. `available=false` → "not available here" (D8); a malformed
   line → its own line; `/move cancel` is a cancel only when something waits or
   runs; a spec during a running turn or a non-empty daemon queue is `queue` (D4),
   else `start`. Plus `HOP_QUEUED_NOTICE`.
2. `packages/tui/src/hop-status.ts` (new) — the transient row (`hopStatusRow`:
   the orchestrator's own phase, one line, cut to the terminal width), the place
   as one string (`hopPlaceText`), the "moved" notice (`hopMovedNotice`, which
   says auto-accept is off when it was on — D9) and `hopFailureText`.
3. `packages/tui/src/app-types.ts` — `HopFeed`/`HopRun`/`TargetFeed`/`HopTargetView`
   /`HopPlaceView` and the two new `AppProps` (`hop?`, `targetFeed?`). `HopRun` is
   a feed (`onStatus(listener)`) plus `done`, which never rejects; `start` takes
   the uid, because the host cannot guess it without minting a second one (D1
   step 3 seeds the SAME uid).
4. `packages/tui/src/App.tsx` — `startHop` (the ONE place the view moves for a
   hop: `switchingRef` up, the phase row, `swapSession(…, {keepTranscript: true})`,
   auto-accept off with the feed or the local toggle, one notice); `requestHop`
   (`hopStep`, then start / queue / cancel / one line); `hopIfQueued` plus ONE
   effect whose deps are exactly D4's facts (`hopQueued`, `st.running`, the queue
   length); `shownTarget`/`shownInPod` follow `targetFeed` (falling back to the
   static props); the status row paints the hop's line INSTEAD of the bar — the
   same one row, so the frame height never changes.
5. `packages/tui/src/commands/move.ts` + `registry.ts` + `context.ts` — `/move` is
   a built-in whose body is `requestHop` (an App-level driver, like `/clear`).
6. `packages/tui/src/run.tsx` + `index.ts` — the props threaded and exported.

*H4 — the MVP end to end.*

7. `packages/core/src/permission.ts` — `PermissionRequest.kind += "session_hop"`
   (laptop-internal, never on the wire: D10).
8. `packages/tui/src/permission-ui.ts` — `autoApproves` excludes `session_hop`
   (D9/H2), `buildPermissionChoices` gives it its OWN two-way menu (Yes-once / No,
   never `always`), and `permissionShowsCwd`/`permissionDetailLines` treat it like
   the trust prompt (asker-written lines, no cwd row).
9. `packages/cli/src/hop-targets.ts` (new) — `createHopTargets`: the three
   factories, each calling the EXISTING builder. A container is created KEPT
   (`resumeHint` + `recordKept` + `labels`/`annotations` from `keptMetadata`, no
   exit net), provisioned with `logTerm.tty: false` and every line on the hop's
   sinks; its rollback disposes and then `removeVerifiedKept`s ONLY its own entry.
   An attach never creates or deletes. The mount gate's `ask` is one
   `session_hop` request on the SAME broker instance. A pod is refused
   (attach-only, decision 1).
10. `packages/cli/src/hop-feed.ts` (new) — the bridge from the `HopRuntime` facade
    (D2/H2) to the TUI's props: a per-run status feed, a `done` that never
    rejects, and the leave hook run after the commit.
11. `packages/cli/src/main.ts` — the worker TUI now starts on `createHopRuntime`
    over its runtime (D2), with `createHopTargets` as its `build`, the laptop
    store's `load` as its seed reader, and `hopEngineHost`/`hopLeave` as the two
    `run`-shaped aliases (`buildEngineHost`; `readKept` → `removeVerifiedKept`).
    Every other origin (`run`, `attach`, `connect`, in-process) passes no `hop`
    prop — "not available here" (D8).
12. `packages/cli/src/tui-sessions.ts` — `TuiSessions.store`, a READER seam for
    `load(uid)` (the saver stays the only writer).

**Drift from the Implementation, and why (each was a contradiction with the code,
fixed here rather than forced):**

- **`info` goes to the NOTICE sink, not the status feed** (D6 says "`log`/`info` →
  the hop status feed"). `quitReport` — the ONE line a faulted run must not lose
  (M4) — is emitted through `info` at DISPOSE time, when the transient row is
  already gone, so routing it to `status` would silently drop it. The phases land
  in the transcript as a piped `run` prints them; the status row carries the hop's
  own phases (`hopSession`'s sink). Tested: a faulted run's line reaches `notify`,
  and no control sequence reaches either sink.
- **`HopRun.onStatus` is a feed, not a sink.** A `start`-returned sink would be a
  listener set fed while the build is already emitting (it starts on the same
  tick), losing its first phases. As a feed, the App subscribes before it watches
  `done`.
- **`HopFeed.start(spec, sessionId)` takes the uid.** The plan's `start(spec)` left
  the host unable to name the session being moved; the "nothing persisted" branch
  (D1 step 3) must open the SAME uid, so the App passes its controller's
  `sessionId`.
- **`HopFeed.cancel` is optional**, and the facade-backed one is a no-op. A hop's
  build is already bounded and rolled back by its own failure path (D1 step 2),
  and there is no abort seam that would not be a second, disagreeing cancellation
  path. `/move cancel` still clears a QUEUED hop (the App's own state), which is
  the case that matters before anything is built.
- **`main.ts` gets two small helpers (`hopEngineHost`, `hopLeave`) rather than a
  new module.** They are `run`-shaped aliases over existing seams; the delete's
  decision is `hopDelete`'s (H1) and the verified delete is `kept-cmd.ts`'s, so a
  third module would only have moved lines.

**Red first.** The H3 App rows and the H4 target rows were written against the
pre-execution tree (`packages/tui/src/App.tsx` had no `hop` prop at all and
`packages/cli/src/hop-targets.ts` did not exist), so their first runs were RED on
the property, not on an import: the transcript-swap row failed on `hop.started`
being empty (no `/move` existed) and the H4 file could not resolve its module.
The mutations below are the durable proof (§9), not that first run.

**Mutation checks** (each broken in the final tree, the narrow file run, restored,
md5 printed twice by the script — `.tentacle/tmp/session-hop/h3h4/mut-h3.sh`,
`mut-h4.sh`).

| # | mutation | result |
|---|---|---|
| H3-M1 | `swapSession` drops `keepTranscript` | 1 fail — the rows/positions row |
| H3-M2 | the `switchingRef` latch is not raised | 1 fail — "a prompt typed MID-HOP" |
| H3-M3 | `hopStep` starts instead of queueing behind a turn | 3 fail — the D4 rows |
| H3-M4 | the queued-hop effect never starts it | 1 fail — "starts only after its end" |
| H3-M5 | the status row ignores the phase | 2 fail — both `hopStatusRow` rows |
| H3-M6 | the badge does not follow `targetFeed` | 1 fail — the transcript row |
| H3-M7 | a failed hop is not reported | 1 fail — "one notice appears" |

| # | mutation | result |
|---|---|---|
| H4-M1 | the container is built without `resumeHint`/`recordKept` | 1 fail — kept labels + index entry |
| H4-M2 | the rollback skips the verified delete | 1 fail — the entry stays |
| H4-M3 | an attach is served by the CONTAINER factory | 1 fail — "an attach never deletes" |
| H4-M4 | the mount gate is skipped | 2 fail — both gate rows |
| H4-M5 | the mount ask goes to a FRESH broker | 2 fail — the single-broker rows |
| H4-M6 | `logTerm` dropped (the engine paints on a terminal) | 2 fail — both sinks rows |
| H4-M7 | `info` goes back to the transient row (the `quitReport` is lost) | 1 fail — the faulted-run row |
| H4-M8 | `autoApproves` answers a `session_hop` request | 1 fail — "auto-accept NEVER answers it" |

**Two mutations were VACUOUS at first, and the TEST was fixed (§9's non-vacuity
rule) — never the source globbed over:**

- **H3-M4** (the queued hop is never started) passed because there were TWO start
  paths: the effect AND a call in the turn's `finally`. That is a real smell, so
  the `finally` call was REMOVED and the effect's deps are now exactly D4's facts;
  the mutation then fails as it must.
- **H3-M6** (the badge does not follow the feed) passed because the notice says
  "Moved to docker:box", so a `toContain("docker:")` over the whole frame proved
  the NOTICE, not the badge. The assertion now reads the status row alone and
  requires it to start with `docker:box · `.

**Tests.** `packages/tui/test/session-hop.test.tsx` (16 rows: `hopStep`'s table,
the status row, the transcript-rows-identical property with the draft intact, the
mid-hop prompt, D4's deferral, a failed hop, D8's refusal, and the `session_hop`
dialog's menu/auto-accept/detail facts) and
`packages/cli/test/session-hop-targets.test.ts` (7 rows over a fake `EngineHost`
bound to real in-memory daemons: kept labels + index entry, the verified delete, a
create failure, the attach, both mount-gate rows, and nothing raw on stdout /
stderr / the sinks — through a hop's whole life and a faulted run's dispose). Four
existing rows moved because `/move` is a built-in: `app-frames.test.tsx`'s palette
snapshot, the literal name lists in `commands-registry.test.ts` and
`app-commands.test.tsx` (17 → 18), and `/help`'s own row (which now asserts
`/move`, the newest built-in, because the visible window scrolls the first entries
out).

**Not in this slice (deliberately).** No `move_session` tool, no laptop proposal
watcher, no `session_hop` prompt for a proposal (H5): a TYPED `/move` needs no
confirmation (decision 7), which is why H4's prompt is only the mount gate's ask.
No attach flow beyond the factory: D7's `detachedRun`/`residentUse`/own-uid checks
are H6 (`attachTarget` builds; nothing refuses for "someone else is there" yet).
No `/move` from `run`/`attach`/`connect` (D8). No protocol change and no
`protocol.d/` note (D10).

**Gate (final tree):** `bunx tsc --noEmit` → 0 · `bun run typecheck` (incl.
`apps/mobile`) → 0 · `bun run lint` → `Checked 1127 files`, 0 errors/warnings
(the baseline is clean) · `bun test` → **8627 pass, 3 skip (the documented
opt-ins: live-k8s, live-docker, the real-socket keepalive), 0 fail** across 616
files. No protocol schema changed, so `packages/protocol/schema/protocol.json`
was not regenerated and no `protocol.d/` note was written (D10). One row failed
the FIRST full run (`app-types.test.ts`'s "index.ts exports no more than the five
public moved types"): `SettingsNoticeLine` had been added to `index.ts`'s
re-export block, which that test forbids; the extra name was removed (it is not
part of this slice's surface) and the row passes. `changelog.d/session-hop.added.md`
(H1's fragment) already carries the feature's one bullet and states H3/H4's
user-visible behaviour; no second fragment was added (AGENTS §10: curated, not a
commit mirror).

## Review — H3 + H4 (fresh-context adversarial; scope `git diff main...HEAD`, slices H3/H4)

**Verdict: REQUEST-CHANGES.**

1. **HIGH — a plain `/move local` deletes the hop container (D5, decision 5: keep is the default).** `packages/cli/src/hop-feed.ts:70` passes `spec.target !== "local" && spec.keep !== false` as `keep`. For a hop BACK to local this is always `false`, so `--keep`, and the default (`parseHopCommand` resolves `keep: true`, `hop-command.ts:124`), are ignored, and `hopLeave` (`main.ts`) runs `removeVerifiedKept` on the container. Repro (`.tentacle/tmp/session-hop/rev-h34/leave.ts`, fake facade): `/move local (keep:true) -> leave called with [{"b":{"kind":"workload","engine":"docker","name":"box"},"keep":false}]`. The fix is `spec.keep`.
2. **MEDIUM — `hopLeave` decides "ours" from the kept index alone, and skips `hopDelete`'s `createdByHop` (D5: a user-owned workload is never deleted).** `main.ts` `hopLeave` deletes any index entry matching `name`+`engine`. A `tentacle run` container is in that index too (the `run` shape). The attach factory is live in H4: the parser accepts `/move attach`, and `attachTarget` builds it. So `/move attach docker:<run-kept>` followed by `/move local --rm` (or a plain `/move local`, because of finding 1) deletes a workload the user owns. The H1 decision `hopDelete` (`hop-plan.ts:244`) is never called. The match also ignores the endpoint/context.
3. **MEDIUM — two required H4 tests are missing; the mutation shows it.** No test drives the leave path (`createHopFeed` → `hopLeave`): plan Tests H4 asks for "`--rm` on hop back calls `removeVerifiedKept` (spy), and a user-owned target is never deleted". Such a test would have caught 1 and 2. Nor does any test cover D9's auto-accept reset (review H2 of the design). Mutation run: `const wasOn = false && permission.autoApprove` in `App.tsx` `startHop` → `session-hop.test.tsx` + `app.test.tsx` still **132 pass, 0 fail**. Reverted; `git status` is clean.

**Gate:** touched files (tui session-hop, app-commands, app-frames, commands-registry; cli session-hop, session-hop-targets, tui-sessions): 126 pass, 0 fail. `bun run lint`: 1127 files, clean. `bun run typecheck`: 0. Full `bun test` not re-run.
**Attacks with no finding:** the single broker (the mount ask goes on `shared.permissions`, and the facade hands the same pair to every build); no raw terminal write (`HOP_TERM` tty false; `log`/`info` → notices); a failed create leaves no index entry; `/move` is unavailable on non-worker origins (no `hop` prop).
**Same-family note:** this review is by an Anthropic model, as was the H2 review. The executor label is inconsistent: the commit says deepseek, the Execution section is signed sonnet.

*— claude-opus-5-5, 2026-11-14*
### Fix round 1 — the H3+H4 review's HIGH/MEDIUM findings

*— claude-opus-5-5, 2026-11-14*

Scope: the three findings of the `## Review — H3 + H4` round above, and nothing
else. Red before green (§9) for every finding, plus a mutation per fix, each run
on the final tree, restored, md5 printed twice.

**Finding 1 (HIGH) — a plain `/move local` deleted the hop container. FIXED.**
`hop-feed.ts:70` computed `keep` from `spec.target`, which is always `local` on a
hop back, so the parser's default (`keep: true`, `hop-command.ts:124`) and
`--keep` both reached the leave as `false`. It is now `spec.keep` — the parser's
own resolved decision. *Red first:* `packages/cli/test/hop-feed.test.ts` (new, 7
rows: the real `createHopFeed` over a fake facade) — the property row red on the
old expression. *Mutation:* restore
`spec.target !== "local" && spec.keep !== false` → **1 fail**
(`a plain /move local KEEPS the container`); restored, md5 `1d0f08c0…` unchanged.

**Finding 2 (MEDIUM) — the leave deleted a workload the user owns. FIXED, in
three parts.**

(a) **The leave moved out of `main.ts`** into `packages/cli/src/hop-leave.ts`. A
closure inside `main.ts` cannot be tested, which is exactly how the review found
this. `main.ts` now only supplies the two seams — `locators` from `hopEngineHost`,
`hostFor` from `buildEngineHost` + `hostOptionsFor` (the same host builder `rm`
uses, so a hop re-dials the entry's own place).

(b) **The decision is `hopDelete`'s** (H1, `hop-plan.ts:244`), finally called, and
its `createdByHop` comes from the index entry's **new `hop: true` mark**, never
from the spec: `containerTarget` writes it (`hop-targets.ts:400`), a `run` never
does, and an entry an older build wrote carries none. So a `tentacle run`
container, an `attach`ed workload, and a pod-supplied `keep: false` can never
reach a delete.

(c) **The match adds the location** — `name` + `engine` + `locationKey` (endpoint
/ context / server / namespace). A `locators` that throws (no kubeconfig) means
nothing can be confirmed, so no entry is returned, never a name-only fallback.

*Red first:* `packages/cli/test/hop-leave.test.ts` (new, 16 rows) — the
another-endpoint, k8s namespace/context, `not ours` and unresolvable-location rows
all red on the behaviour-preserving stage-1 extraction.
*Mutations:* `createdByHop: true` (ignore the mark) → **3 fail**; drop the
location clause → **2 fail**; fall back to a name match when `locators` throws →
**1 fail**; drop the delete's `try`/`catch` → **1 fail**; drop `hop: true` from the
entry → **1 fail** (`session-hop-targets.test.ts`, kept labels + index entry);
drop the parse clause → **1 fail** (`kept.test.ts`, the mark round-trips). Each
restored, md5 `5b39fff0…` / `95c949d9…` / `b1ced75e…` unchanged.

**Finding 3 (MEDIUM) — the two missing H4/D9 tests. FIXED.**

- **The leave path:** `hop-feed.test.ts` + `hop-leave.test.ts` above. These would
  have caught 1 and 2; finding 1's mutation is the proof.
- **D9's auto-accept reset:** three rows in `session-hop.test.tsx` (ON → flipped
  off and said in the same notice; OFF → no needless write; a FAILED hop leaves it
  exactly as it was). **The review's own mutation**
  (`const wasOn = false && permission.autoApprove`) now gives **1 fail**; before
  these rows it was 132 pass / 0 fail.
- **A real defect the new row found, beyond the review:** the pre-fix reset used
  `autoAccept.set(false)` on a detached-run feed, which only *publishes* a flip for
  other terminals — this TUI's own state came back only through `onChange`, which a
  no-op feed never calls. The status bar therefore still read `auto-accept on`
  while the notice said off, and approvals stayed live: precisely what D9 exists to
  prevent. Fixed as a pure-module seam, not a branch in the component:
  `PermissionController.clearAutoApprove()` (`permission-ui.ts`) applies the flip
  locally (`applyAuto(false)`) *and* writes the feed; `App.startHop` calls it.
  *Mutation:* `clearAutoApprove` reduced to `feedRef.current?.set(false)` (the
  pre-fix shape) → **1 fail**, the same row.

**Drift from the Implementation, and why.** D5's "a workload THIS laptop recorded
as hop-created (D5 entry)" was signalled but never built: the entry carried no such
mark, so "ours" had to be inferred — and the only inference available (name+engine
in the index) *is* the bug. `KeptEntry.hop?: true` (`kept.ts`, parsed in
`parseKeptEntry`) is that mark: laptop-written, absent from every `run` entry, and
absence is the safe direction (an older build refuses to delete). It is an additive
field of an on-disk record, so no `schemaVersion` bump, no `protocol.d/` note, and
the wire is untouched (D10).

**Files:** `cli/src/hop-feed.ts` · `cli/src/hop-leave.ts` (new) ·
`cli/src/hop-targets.ts` · `cli/src/kept.ts` · `cli/src/main.ts` ·
`tui/src/App.tsx` · `tui/src/permission-ui.ts` · `cli/test/hop-feed.test.ts` +
`cli/test/hop-leave.test.ts` (new) · `cli/test/kept.test.ts` ·
`cli/test/session-hop-targets.test.ts` · `tui/test/session-hop.test.tsx`.

**Gate:** `bunx tsc --noEmit` → 0 · `bun run lint` → `Checked 1130 files`, 0
errors / 0 warnings (the baseline is clean) · `bun test` → **8654 pass, 3 skip
(the documented opt-ins: live-k8s, live-docker, the real-socket keepalive), 0 fail**
across 618 files. A first full run had ONE fail
(`packages/daemon/test/serve-log-store.test.ts`'s 200×SIGKILL stress row, a random
5–125 ms kill point): it passes alone and under 8 spinning cores, no `packages/daemon`
file is touched by this round, and the re-run is green — runner contention, not this diff.

*— claude-opus-5-5, 2026-11-14*

### Round 2

**Verdict: PASS.** Scope `git diff HEAD~1` (`ac43458`). Each fix was checked by a mutation: break the fix, run its test, see it FAIL, then revert. `git status` was clean afterwards.

| finding | mutation | result |
|---|---|---|
| 1 HIGH, `keep` on a hop back | `hop-feed.ts:68` set back to `spec.target !== "local" && spec.keep !== false` | `hop-feed.test.ts`: 1 fail ("a plain `/move local` KEEPS the container") |
| 2 MEDIUM, ownership | `hop-leave.ts:102` `createdByHop: found !== undefined` | `hop-leave.test.ts`: 2 fail (a `run` entry, an older entry without `hop`) |
| 2 MEDIUM, location | `hop-leave.ts:66` location key ignored | `hop-leave.test.ts`: 2 fail (another endpoint; k8s namespace/context) |
| 3 MEDIUM, auto-accept reset test | `App.tsx` `permission.clearAutoApprove()` removed | `session-hop.test.tsx`: 1 fail (D9 "ON before the hop…") |

**Regressions on the diff: none at HIGH or MEDIUM.**
- `KeptEntry.hop` survives `recordKept`, which writes the whole entry, and `parseKeptEntry`, which keeps `hop === true`. An older build drops the field, so it refuses to delete (the safe direction).
- `hostFor` now uses `buildEngineHost(entry.engine, hostOptionsFor(entry))`, so it dials where the ENTRY says, as `rm` does (§7: where to dial comes from the index).
- `locators` is taken from `hopEngineHost`, the same `keptLocation` call that writes the entry, so a hop's own entry matches. A locator that throws ⇒ nothing is deleted.
- `clearAutoApprove` also fixes a real bug in the old `autoAccept.set(false)`: it only published the flip to the OTHER terminals, so this TUI still said auto-accept was on.

**Gate:** `bun test packages/cli packages/tui`: 4825 pass, 0 fail. `bun run lint`: 1130 files, clean. `bun run typecheck`: 0. I did not re-run the full `bun test`; the executor reports it green.

*— claude-opus-5-5, 2026-11-14*

## Execution — H5

### H5 — the agent's `move_session` proposal, and the prompt it becomes

*— claude-sonnet-4-5-20250929, 2026-11-14*

**Load-bearing check re-run FIRST** (as instructed, on this branch's tree). The
plan's rig in `.tentacle/tmp/session-hop/hop-repro.ts` points at the OLD worktree
(`../../worktrees/session-hop/...`), so it was re-run from a copy in this tree
(`.tentacle/tmp/session-hop/h5/hop-repro.ts`, imports rewritten to `../../../../`):

```
$ bun .tentacle/tmp/session-hop/h5/hop-repro.ts
B uid == A uid: true
B model saw: sys | hello from local | reply-A
after B: system:sys | user:hello from local | assistant:reply-A | user:hello from container | assistant:reply-B
files: 1 one .jsonl: true
```

PASS: the same uid, the laptop record as the seed on a fresh daemon, one
`<uid>.jsonl`, no aside file. The assumption H5 stands on is intact, so no STOP
condition applied.

**As built, in dependency order.**

1. **`packages/config` — `sessionHop.tool` (the gate, D9/decision 6).**
   `schema.ts` (a `.strict()` section like `contextReset`), `defaults.ts`
   (`DEFAULT_SESSION_HOP_TOOL = true`), `resolve.ts` (`SessionHopConfig`, the
   `sessionHopTool` provenance, `TENTACLE_SESSION_HOP_TOOL`), `load.ts`
   (on `TentacleConfig`), `profile.ts` (per-key merge), `key-docs.ts` (the
   section + leaf entries, whose `profiles.*` mirror `derive()` builds). The
   README table was regenerated with `bun run docs:config`.
2. **`packages/tools/src/move-session.ts` — the tool (D9).** `permission:
   "none"` (there is no daemon-side effect to authorize, and an `ask` here would
   ask the owner twice, the daemon's copy being the one a standing approval can
   wave through), `concurrency: "exclusive"`, a zod schema that is the `HopSpec`
   the typed `/move` produces, and an `execute` that re-validates its own input
   and answers one sentence. `MOVE_SESSION_PROPOSED` says "Do not assume the move
   happened". `reason` is capped at 500; a workload name must match
   `^[A-Za-z0-9][A-Za-z0-9._-]*$` (253 max), the same grammar as the typed path.
3. **`packages/cli/src/wiring.ts` — registration (review M5).**
   `BuildAgentOptions.moveSession?: true` (a boolean because that site has no
   daemon KIND), and the registration at the `contextReset` site:
   `options.moveSession === true && config.sessionHop.tool`. Set by
   `worker.ts` (its one `workerAgentFactory`) and the pod daemon
   (`serve.ts`'s `podSessionHost`, both branches — tunnel and own-model) via
   `tunnelledAgent`'s options. `serve`, in-process, one-shot and child builds
   never set it.
4. **`packages/agent/src/subagent.ts` — a child never gets it.** Added
   `MOVE_SESSION_TOOL_NAME` to BOTH "never a child" lists (`childTools`' filter
   and `readOnlyType`'s). This was a REAL leak, not a theoretical one: `general`
   is `tools: "all"`, so the tool was inherited by every general child, whose
   turn is not the one the laptop watches (`own: false`) — it would have been
   told "Proposed" about a prompt nobody is ever asked.
5. **`packages/cli/src/hop-proposal.ts` — the prompt's text (review M6).**
   `hopPromptTitle`, `HopPromptFacts`, `hopPromptDetail(spec, facts)`: the
   engine, the FULL image (or "the default image"), the host mount path
   read-write, the inject + "your folder is NOT shared" for k8s, the
   keep/DELETED intent for the workload being left, what gets reset — then the
   model's `reason` LAST and labelled, everything daemon-supplied through
   `untrustedText`. D6's mount-gate `ask` MERGES into this same text.
6. **`packages/cli/src/hop-turn.ts` (new) — the turn-end decision (D9).** Pure:
   `hopTurnStep`/`hopTurnEnd` (a per-turn watch on `hopProposalStep`, an
   own-turn-only fold, ended state so a late result cannot re-open it),
   `hopPromptRequest` (a `session_hop` request), `hopProposalOutcome`
   (`allowed` is the only yes; `dismissed` is never one), `hopAskAtTurnEnd`
   (asks through an INJECTED `ask`, so no broker is imported and a test's spy is
   the single-broker proof), `moveGuideLine`/`MOVE_DECLINED_LINE` (review M7).
7. **`packages/cli/src/hop-feed.ts` — the feed's half.** New deps `permissions`
   (the ONE broker) and `promptFacts`; `turn`/`turnEnd`/`takeLine` on `HopFeed`.
   A decline stores the line for the next prompt, a commit stores the moved
   line, `takeLine` CONSUMES it. No broker → nothing can be approved (honest: a
   proposal nobody can be asked about moves nothing).
8. **`packages/cli/src/hop-targets.ts` — `hopPromptFacts`.** The mount the plan
   would really use (`planWorkspace`), the engine a container hop would build,
   the workload being left. Never throws.
9. **`packages/tui` — the App's two facts, no new effect.** `HopFeed.turn/
   turnEnd/takeLine` (`app-types.ts`), `HopTurnPort` (`useTurnDriver.ts`,
   satisfying `useExhaustiveDependencies` by name, not by disabling it),
   `hopWithLine` (the ONE concatenation, exported for its test). The driver
   forwards each event (`own = opts.own !== undefined && !opts.foreign`) inside
   `streamTurn`, asks once at the settle (`hopTurn.end`), and starts an approved
   spec through the App's `startHopRef` — the ONE place the view moves (D3).
   `App` supplies the port, absent exactly where `hop` is absent (D8).
10. **`packages/cli/src/main.ts`** passes `permissions` (the same instance the
    facade and the TUI share) and `promptFacts: hopPromptFacts(...)` to
    `createHopFeed`.

**Drift from the Implementation, and why.**

- **The plan's H5 file list omits the TUI, but D9's prompt needs it.** The
  broker lives with the facade and the turn's events live in the App, so two
  small additive seams were required (`HopFeed.turn/turnEnd/takeLine`,
  `HopTurnPort`). All the DECIDING stays in `hop-turn.ts` (pure), per §7.
- **The declined/moved line is CONSUMED by `takeLine`, not read from a
  `HopNextPromptLine` union.** The cli first had its own `withHopLine`; the
  driver needs the same concatenation, and two implementations of "join one line
  to a prompt" is exactly the duplication §7 forbids. The cli keeps the TEXT, the
  driver keeps the join (`hopWithLine`), and the cli's copy was deleted.
- **`hopPromptFacts` lives in `hop-targets.ts`, not `hop-proposal.ts`.** It
  calls `planWorkspace`, which is a `cli` engine-side decision; `hop-proposal.ts`
  stays IO-free and takes the facts as an argument.
- **`MOVE_GUIDE_LINE` became `moveGuideLine(where)`** — it names the place, and a
  constant could not.
- **The tool duplicates the workload grammar** (`@tentacle/tools` may not depend
  on the TUI). The laptop's `hopSpecOf` remains the authority and re-checks every
  argument through `hopWorkload`, so the two cannot disagree (the stricter one
  refuses first); the duplication is commented at the regex.

**Red first.** Each new module's test file was written against a tree without it:
`move-session.test.ts` failed to resolve `../src/move-session.ts`;
`hop-prompt.test.ts` failed on `MOVE_GUIDE_LINE` not being exported;
`hop-turn.test.ts` failed on the real property (`hopAskAtTurnEnd` dropped the
proposal's `reason`, and `hopPromptDetail` said "DELETED" where the test expected
"delete"). The durable proof is the mutation table (§9), not those first runs.

**Mutation checks** (each broken in the final tree, the narrow file(s) run,
restored; `md5` printed before and after every restore — the script is
`.tentacle/tmp/session-hop/h5/mutate.sh`).

| # | mutation | result |
|---|---|---|
| M1 | `autoApproves` answers `session_hop` (the plan's named mutation) | **1 fail** — "auto-accept can NEVER answer it" |
| M2 | `hopAskAtTurnEnd` never asks (the `!ended` guard → `if (true)`) | **10 fail** across both turn files |
| M3 | a refusal/`dismissed` read as a yes | **1 fail** — the declined-outcome row |
| M4 | `hop-feed` asks about a FOREIGN turn (`!own` guard dropped) | **1 fail** — the guard row |
| M5 | the declined line is never kept | **2 fail** — declined line + consumed-once |
| M6 | `takeLine` never consumes | **2 fail** |
| M7 | `move_session` registered for EVERY build (review M5) | **2 fail** — `serve`/in-process rows |
| M8 | the `sessionHop.tool` gate ignored (decision 6) | **1 fail** — its off row |
| M9 | `move_session` dropped from the child filter | **2 fail** — both child rows |
| M10 | the proposal's `reason` dropped from the prompt | **1 fail** — reason-last row |
| M11 | the mount dropped from the prompt | **1 fail** — read-write row |
| M12 | the delete intent hidden | **1 fail** — keep/delete row |
| M13 | the tool answers "Moved." instead of "Proposed…" | **3 fail** — the propose-only rows |

All 13 reverted; `md5` identical before and after each, no `.mutbak` left.

**M4 was VACUOUS at first, and the TEST was fixed (§9).** `hopTurnStep` already
drops a foreign turn's events, so the `turnEnd` `!own` guard was unreachable from
the "foreign turn" row (on its own: `0 fail`). `own` at the fold and `own` at the
turn's end are two separate facts the driver reports separately, so a new row
folds a proposal as OWN and ends the turn as FOREIGN: the guard is then what
holds, and the mutation fails.

**Tests.** `packages/tools/test/move-session.test.ts` (12) ·
`packages/cli/test/move-session-wiring.test.ts` (4, the real `buildAgent`) ·
`packages/agent/test/subagent-move-session.test.ts` (2, the real
`createSubagentRunner` over a registry that HOLDS the tool) ·
`packages/cli/test/hop-prompt.test.ts` (13) · `packages/cli/test/hop-turn.test.ts`
(13) · `packages/cli/test/hop-feed-turn.test.ts` (12, the real `createHopFeed`
over a spy broker). Existing rows moved: none.

**Not in this slice (deliberately).** No attach flow beyond the factory (H6's D7
checks), no live docker test (H7), no `protocol.d/` note and no schema
regeneration (D10: no method, update kind or field changed — `session_hop` is a
laptop-internal `PermissionRequest.kind` and `move_session` is a tool definition).

**Changelog.** H1's `changelog.d/session-hop.added.md` already carries the
feature's bullet including the tool and its prompt (it was written ahead for this
slice), so H5 adds only what is NEW and user-visible beyond it:
`changelog.d/session-hop.changed.md` for the `sessionHop.tool` setting.

**Gate (final tree).** `bun run typecheck` (`tsc --noEmit && tsc -p apps/mobile`)
→ 0 · `bun run lint` (`biome check .`) → `Checked 1245 files`, 0 errors / 0
warnings (the baseline is clean) · `bun test` → **9192 pass, 3 skip** (the
documented opt-ins: live-k8s, live-docker, the real-socket keepalive), **0 fail**
across 664 files. No protocol file changed, so `packages/protocol/schema/protocol.json`
was NOT regenerated and no `protocol.d/` note was written (D10). Formatting and
import order are the repo's (`bunx biome check --write` on the touched files).

**Not re-verified here:** the App-driven path end to end (a real `move_session`
turn in `ink-testing-library` driving `hop.onApproved` into `startHop`) has no
frame test of its own; its two halves are covered (`hop-feed-turn.test.ts` for
the feed, `session-hop.test.tsx` for `startHop`). To verify: render the App with
a `hop` feed whose `turnEnd` resolves `{kind:"approved"}`, after one
`tool_start`/`tool_result` pair on `move_session`, and assert the status row
starts with `moving to`.

## Review — H5

*— claude-opus-5-5, 2026-11-14* (fresh context; a different model family from the H5 executor, claude-sonnet-4-5)

**Verdict: REQUEST-CHANGES.**

Gate: these 7 test files (tools/move-session, cli/move-session-wiring, agent/subagent-move-session, cli/hop-prompt, cli/hop-turn, cli/hop-feed-turn, tui/session-hop) → 75 pass / 0 fail. `bun run typecheck` → 0. `bun run lint` → 1245 files, clean. Full `bun test` was NOT re-run here.

1. **HIGH — every `run`/`attach` pod is offered a tool that nobody answers.** `serve.ts:754,765` set `moveSession: true` inside `podSessionHost`. Every pod daemon goes through it: `run`, `attach`, detached and resident (`pod-resident.ts:803`). D8, though, gives those TUIs no `hop` prop. So on a plain `tentacle run` (k8s is the default engine), the model calls `move_session` and gets back "Proposed; the user will be asked when this turn ends". No prompt is ever raised. That is a silent drop plus a false statement to the model: the same class as the sub-agent leak this slice fixed. The laptop's TUI needs to be the one that tells the daemon whether a hop is possible (for example a hop target's spawn passes a flag or env, and a plain run does not). Otherwise `run`/`attach` must not register the tool.
2. **MEDIUM — M6 ("ONE prompt even when the mount gate says ask") is not met in production.** `hopPromptFacts` (`hop-targets.ts:322`) never sets `gate`. The build then still raises its own `mountAsk` on the broker (`hop-targets.ts:182`). Scenario: cwd is a sensitive folder → the owner approves the proposal without seeing the gate warning, then gets a second prompt. The `hop-prompt.test.ts:97` row passes in a hand-made `gate` string, so it proves nothing about this path.
3. **MEDIUM — the mount the prompt shows is not the mount the build uses.** `hopPromptFacts` calls `planWorkspace` without `endpoint` and with `noMount: false`. The real build passes `target.endpoint` and `deps.mount === false` (`hop-targets.ts:156-161`). So with a remote `tcp://` engine, or `mount: false`, the prompt claims "mount: <cwd> (read-write)" and that mount never happens. The owner is approving facts that are wrong.
4. **MEDIUM — the production path from proposal to prompt has no test.** Mutation: I deleted `hopTurn?.event(...)` (`useTurnDriver.ts:571`), so no event ever reaches the fold and no proposal can ever be asked. Result: `bun test packages/tui` + `hop-feed-turn` + `hop-turn` → **2011 pass, 0 fail**. Reverted with an exact Edit; `git status` clean afterwards. The executor noted this gap as "not re-verified". §9 requires that the property hold on the real path, so it needs an App-level frame test (tool_start/tool_result → prompt → `moving to`).

**Attacks tried:**
- Could a broker grant auto-answer a `session_hop` request? No. `autoApproves` excludes it (`permission-ui.ts:60`), it has its own `hopChoices`, and `hopProposalOutcome` ignores `scope`.
- Could a foreign turn or a sub-agent raise the prompt? No. Both the fold and `turnEnd` check `own`, and the child filters drop the tool. These hold.
- The single-broker invariant: `main.ts` passes the same `permissions` instance to `createHopFeed` and `startTui`. Holds.
- The turn-end ask runs in `finally`, so it also fires after an abort or an error. When a send-now succeeds, the watch carries over into the successor turn and is asked at that turn's end. That is acceptable.

**How the executor behaved:** a thorough mutation table and an honest "not re-verified" note. But the M6 property was proven only on a pure string, not on the build that actually runs, and the scope of the pod-daemon registration was not checked against D8.

### Fix round 1 — the H5 review's HIGH/MEDIUM findings

*— claude-opus-5-5, 2026-11-14*

Scope: the four findings of `## Review — H5` above, and nothing else. Red before
green (§9) for each, plus a mutation per fix (each broken in this tree, its
narrow file(s) run, restored, `md5` printed before and after — no `.bak` left).

**Finding 1 (HIGH) — every `run`/`attach` pod was offered a tool nobody answers. FIXED.**

`podSessionHost` set `moveSession: true` for every session of a pod daemon, but
D8 gives a `run`/`attach` TUI no `hop` prop: the model was told to propose a move
no prompt could raise, and its `tool_result` said so. The tool is now offered
**per SESSION, to the client that can actually ask** — a new capability, threaded
the whole wire:

- `protocol/src/session.ts`: `ClientCapabilitiesSchema.hop?: boolean` (optional,
  additive: an older daemon drops it, so it fails closed).
- `client/src/remote-client.ts`: `RemoteClientOptions.hop` → `initialize` sends
  `clientCapabilities.hop`; read once per handshake (a reconnect re-declares).
- `daemon/src/connection.ts`: `initialize` stores it per CONNECTION; `open` puts
  it on the `Attachment` that creates the session.
- `daemon/src/hosted-session.ts` / `session-host.ts`: `Attachment.hop`,
  `HostedSession.hop`, and `build` hands it to `createAgent` as
  `AgentContext.hop` — the CREATING client's fact, kept across a settings sync
  (`updateSettings` passes `hosted.hop`).
- `cli/src/serve.ts`: `podSessionHost`'s two branches pass
  `hop ? { moveSession: true } : {}` instead of unconditionally.
- `cli/src/local-runtime.ts` + `engine-runtime.ts` (`EngineRuntimeDeps.hop`,
  `EngineAttachRuntimeDeps.hop`) and `hop-targets.ts`: a HOP target's own runtime
  declares `hop: true` (it has the `/move` feed and the one broker prompt), so a
  moved session keeps proposing; `run`/`attach` never do. The worker's
  unconditional `moveSession` stays: a worker runtime exists only for the local
  TUI, which is hop-capable.

*Red first:* `packages/cli/test/move-session-pod-capability.test.ts` (new) drives
the REAL stack — `podSessionHost` → `Connection` → `RemoteClient` → a turn — and
asserts the tool list on the provider's `ChatRequest`: a client that declares no
`hop` is never offered `move_session`, a hop-capable one is. *Mutation:* the
pre-fix shape (`moveSession: true` in both `podSessionHost` branches) → **1 fail**
("a client that declares NO hop capability (`run`/`attach`) is never offered it"),
with the received list naming `move_session`; restored, md5 `7bd05367…` unchanged.

**Finding 2 (MEDIUM) — M6's "ONE prompt" was not met in production. FIXED, in two halves.**

(a) **The gate's warning now reaches the prompt.** `hopPromptFacts` never set
`gate`, so a dangerous cwd produced the proposal prompt AND a second gate ask at
build time. The facts now carry `gate` (the gate's `ask` text) or
`gateWarnings` (a `proceed` with warnings), merged into the SAME detail by
`hopPromptDetail` — D9's wording, finally true.

(b) **A Yes to that detail answers the gate.** The decision is a pure-module
fact, not a branch in the component: `hopProposalOutcome` gains the `shown` facts
and returns `gateAnswered: true` when the prompt it accepted carried one. It
travels `HopProposalOutcome` → `HopProposalView` → `HopTurnPort.approved` → the
App's `startHop` → `HopFeed.start` → `HopRuntime.hop` → `hopSession` →
`deps.build(…, {gateAnswered})` → `containerTarget`, which skips its own ask. A
typed `/move` never sets it, so D6's ask is unchanged for a typed move.

*Red first:* `packages/cli/test/hop-prompt-facts.test.ts` (new, 6 rows) — the
`/etc` gate row red; `packages/cli/test/session-hop-targets.test.ts` gains "an
APPROVED proposal (`gateAnswered`) is ONE prompt"; `hop-turn.test.ts` gains the
turn-end half (`gateAnswered` present with a gate, absent without).
*Mutations:* `facts.gate` never set → **1 fail**; `hopAskAtTurnEnd` dropping
`shown` → **1 fail**; `containerTarget` ignoring `opts.gateAnswered` → **1 fail**.
Each restored, md5 `7de06973…` / `eacb8002…` unchanged.

**Finding 3 (MEDIUM) — the prompt showed a mount the build would not use. FIXED.**

`hopPromptFacts` built its own plan (`kind: "docker"`, `noMount: false`, no
endpoint) while `containerTarget` passes the real engine, the real endpoint and
`deps.mount === false`. Both now call ONE new helper, `containerPlan` — the same
plan and the same `mountGate`, so the prompt cannot state a mount, an engine or a
warning the build would not act on. `hopPromptFacts`'s inputs are the build's own
deps (`Pick<HopTargetDeps, "config" | "host" | "mount">`), which is what makes the
divergence unrepresentable; `main.ts` passes them.

*Red first:* `hop-prompt-facts.test.ts`'s `mount: false`, remote `tcp://` and
`podman` rows — all three red on the pre-fix function.
*Mutations:* `noMount: false` hard-coded → **1 fail**; `kind: "docker"` hard-coded
→ **1 fail**; `facts.engine = "docker"` → **1 fail**. Restored, md5 unchanged.

**Finding 4 (MEDIUM) — the production proposal→prompt path had no test. FIXED.**

The review's own mutation (deleting `hopTurn?.event(...)` in `useTurnDriver.ts`)
passing 2011 tests is the proof it was needed. `packages/cli/test/hop-proposal-app.test.tsx`
(new) renders the REAL `App` with the REAL `createHopFeed` over a controller that
streams a `move_session` `tool_start`/`tool_result`, and asserts the whole chain at
the frame: ONE `session_hop` request carrying the image, a Yes starting the ONE
move path, and the moved notice — plus a No asking once and moving nothing. The
spy is a `PermissionBroker` SUBCLASS (the App installs its own interactive
requester with `setRequester`, which replaces an initial one).
*Mutation (the review's):* `hopTurn?.event(...)` deleted → **2 fail**. Restored,
md5 `67fb324e…` unchanged.

**Drift from the Implementation, and why.** D9 says the tool is registered "in
worker and pod-bridge daemons" and D8 says a `run`/`attach` TUI gets no `hop`.
Those two cannot both hold with a registration that is daemon-wide: a pod daemon
IS `run`/`attach`. So the registration is per SESSION, keyed on a new optional
`clientCapabilities.hop` — the only fact that distinguishes a hop target's spawn
from a plain run. It is an additive, optional protocol field (an older daemon
drops it and offers no tool, the safe direction), so no `PROTOCOL_VERSION` bump
and no `protocol.d/` note; `packages/protocol/schema/protocol.json` was regenerated
with `bun run schema:export` (the drift gate). No method, update kind or required
field changed (D10). The changelog bullet for `sessionHop.tool` says the new scope.

**Files:** `protocol/src/session.ts` · `protocol/schema/protocol.json` ·
`client/src/remote-client.ts` · `daemon/src/connection.ts` ·
`daemon/src/session-host.ts` · `daemon/src/hosted-session.ts` ·
`cli/src/serve.ts` · `cli/src/local-runtime.ts` · `cli/src/engine-runtime.ts` ·
`cli/src/hop-targets.ts` · `cli/src/hop-proposal.ts` · `cli/src/hop-turn.ts` ·
`cli/src/hop-feed.ts` · `cli/src/hop-runtime.ts` · `cli/src/session-hop.ts` ·
`cli/src/main.ts` · `cli/src/wiring.ts` · `tui/src/app-types.ts` ·
`tui/src/useTurnDriver.ts` · `tui/src/App.tsx` · `changelog.d/session-hop.changed.md`
· tests: `cli/test/move-session-pod-capability.test.ts` +
`cli/test/hop-prompt-facts.test.ts` + `cli/test/hop-proposal-app.test.tsx` (new),
`cli/test/hop-turn.test.ts`, `cli/test/session-hop-targets.test.ts`.

**Gate (final tree).** `bunx tsc --noEmit` → 0 · `bun run typecheck` (`tsc
--noEmit && tsc -p apps/mobile --noEmit`) → 0 · `bun run lint` → `Checked 1248
files`, 0 errors / 0 warnings (the baseline is clean) · `bun test` → **9205 pass,
3 skip (the documented opt-ins: live-k8s, live-docker, the real-socket keepalive),
0 fail** across 667 files.

**Not done here (deliberate).** The `hop` capability is per CONNECTION, so a
session CREATED by a hop-capable client and later re-attached by a `run` TUI keeps
the tool (the session's own fact). That is the right unit — the prompt belongs to
the session's owner, not to whoever re-attached — but it means a second client on
the same session does not change the offer. No test covers the case "created by a
run, re-attached by a hop target" (the tool is then absent for the session's
life), which would need a host-level re-open to change; noted, not fixed.

*— claude-opus-5-5, 2026-11-14*

### Round 2

*— claude-opus-5-5, 2026-11-14* (fresh context; reviewing commit `52995b84`, `git diff HEAD~1`)

**Verdict: REQUEST-CHANGES.**

Gate: `bun run typecheck` → 0. `bun run lint` → 1248 files, clean. `bun test packages/cli/test` → 2355 pass / 0 fail. `bun test` on daemon + client + protocol + tui → 3993 pass / 1 skip / 0 fail. Every mutation was reverted, and `git status` was clean afterwards.

| R1 finding | mutation | result | verdict |
|---|---|---|---|
| 1 pod offers the tool to `run`/`attach` | `serve.ts:757,768` → always `moveSession` | 1 fail (`move-session-pod-capability`) | fixed (daemon side) |
| 1 | `connection.ts:603` `this.hop = false` | 1 fail | fixed |
| 1 | drop `hop: true` from both hop targets (`hop-targets.ts`, container + attach) | **0 fail** (cli 2355 pass) | laptop side not pinned |
| 2 two prompts | `hop-targets.ts:230` re-ask ignoring `gateAnswered` | 1 fail (`session-hop-targets`) | **not fixed in production** (below) |
| 3 prompt mount ≠ build mount | `hopPromptFacts` endpoint dropped | 2 fail (`hop-prompt-facts`) | fixed: one `containerPlan` |
| 4 App path not tested | drop `hopTurn?.event` (`useTurnDriver.ts:571`) | 2 fail (`hop-proposal-app`) | fixed |

1. **MEDIUM: finding 2 is still live in the real binary.** The production `build` in `main.ts:2096-2105` is `(spec, sharedPair, sessionId) => createHopTargets({...})(spec, sessionId)`. It never forwards the new 4th argument `opts`. TypeScript accepts a lambda with fewer parameters, so this compiles silently. As a result `gateAnswered` never reaches `containerTarget`, and an approved proposal with a gate `ask` still raises the second `mountAsk` prompt. The test calls `createHopTargets` directly, so it does not cover this path. Fix: forward `opts`, and pin it through `main`'s wiring, or extract the build lambda so it can be tested.
2. **MEDIUM (test coverage, §9): the laptop half of the hop capability is not pinned.** If the hop targets stop passing `hop: true`, no test fails. The `engine-runtime` → `createLocalRuntime` → `initialize` chain has no test either. The tool would silently disappear on every hop target, so the fix is unprotected against a regression.

**Regressions checked:**
- `clientCapabilities.hop` is an optional field on a strip schema. That is additive, so no `protocol.d/` note is needed (§7: fields are free). An older daemon drops it, which is the safe direction.
- A settings sync keeps `hosted.hop`.
- `gateWarnings` in `HopPromptFacts` is dead (never set). That is a nit.
- One more pass: proceed-warnings also set `gate`, so `gateAnswered` becomes true. That is harmless: a `proceed` gate never asks.

**Unverified:** a session created by a hop TUI (`hop: true`) and later joined by a plain `tentacle attach` TUI keeps the tool, and that TUI has no feed to ask through. This only matters if a hop container's daemon is resident (sessions outliving the exec). To verify: check whether `startEngineRuntime`'s container daemon is the resident one.

**How the executor behaved:** it addressed all four findings with real tests (3 of 4 tests kill their mutation). It missed the one wiring line that carries fix 2 into the real `main`, which is the same "proven on a seam, not on the real path" pattern as round 1.

### Fix round 2 — the H5 review round 2's MEDIUM findings

*— claude-opus-5-5, 2026-11-14*

Scope: the two MEDIUMs of `### Round 2` (H5) above, and nothing else. Both were
"proven on a seam, not on the real path". Red before green (§9), one mutation
per fix, each run on the final tree and restored with md5 printed.

**Finding 1 (MEDIUM) — the production `build` dropped `opts`, so an approved
proposal still re-asked the mount gate. FIXED.**

*Reproduced first, empirically, before any edit* (`.tentacle/tmp/session-hop/rev2-f1.ts`,
the two lambdas side by side over the real `createHopTargets`, a `SpyBroker`, and
a `SYSTEM` cwd `/etc` whose gate asks):

```
main.ts lambda  → asks: 1 | not moved: no such image: nope
opts forwarded  → asks: 0 | not moved: no such image: nope
```

The bug is exactly the review's: a lambda with FEWER parameters type-checks, so
`main.ts`'s `(spec, sharedPair, sessionId) => createHopTargets({…})(spec, sessionId)`
silently discarded the 4th argument, `gateAnswered` never reached
`containerTarget`, and the owner answered the same gate twice.

The fix is the review's "extract the build lambda so it can be tested":
**`hopBuilder(deps)`** (`hop-targets.ts:105`) is the facade's `build`
signature over deps that outlive it, and `main.ts:2099` now passes
`build: hopBuilder({…})` — the forwarding exists in ONE named place instead of
an untestable closure, so a change to it is a change to a tested function.

*Red first:* two rows in `session-hop-targets.test.ts` — through `hopBuilder`,
`gateAnswered: true` gives **0** broker asks, and a typed `/move` (no opts)
still gives its **1** `session_hop` ask. *Mutation* (`hopBuilder` reduced to the
pre-fix three-parameter shape): **1 fail**, `a build made through hopBuilder does
not re-ask a gate the owner answered`; restored, md5 `13fe9b3c…` unchanged.

*And the call site is pinned,* because that is what the review found missing and
a seam test alone cannot see it — `grep-guard: main wires build: hopBuilder(…),
never a lambda` (`session-hop-targets.test.ts`, the pattern
`workspace-mount.test.ts` already uses for `hideList`). *Mutation:* `main.ts`
back to `build: (spec, sharedPair, sessionId) => hopBuilder({` → **1 fail**;
restored, md5 `37150c76…` unchanged.

**Finding 2 (MEDIUM, §9) — the laptop half of the hop capability was not
pinned. FIXED.**

The review's mutation was real: dropping `hop: true` from both hop targets left
`packages/cli` at 2355 pass / 0 fail. So a hop target could stop declaring the
capability and the tool would silently vanish from every hop session — the
inverse of finding 1 of round 1, and just as silent.

Pinned through the **real chain** the review named
(`engine-runtime` → `createLocalRuntime` → `initialize` → daemon): the H4 rig's
fake host already binds `openExec` to an actual `SessionHost` + `Connection`, so
`createAgent`'s `context.hop` is a genuine end-to-end observable. Three rows in
`session-hop-targets.test.ts` (`log.hops` is that recorder):

- a hop **container**'s session reaches its daemon with `hop` declared;
- an **attach** target's does too;
- non-vacuity: the same runtime built WITHOUT `hop` declares nothing (a `run`'s
  shape), so the declaration provably comes from the hop target.

*Red first:* these rows fail on the mutated code, not on a compile error — see
the mutations. *Mutations:* drop both `hop: true` declarations in
`hop-targets.ts` (the review's own) → **2 fail**; drop
`engine-runtime.ts`'s forward → **1 fail**; make
`local-runtime.ts` declare unconditionally (`hop: true`, the shape that would
re-break round 1's finding 1 from the laptop side) → **1 fail**, the
non-vacuity row. Each restored; md5 `13fe9b3c…` / `b94377af…` / `2cd9a046…` unchanged.

**No drift from the Implementation.** Both fixes are additive: `hopBuilder` is a
new export over the existing `createHopTargets`, and no wire, on-disk or
`PROTOCOL_VERSION` surface moved (D10 untouched). No changelog fragment is added
this round — the user-visible behaviour is the one `session-hop.changed.md`
already states, and round 2 changed where the decision is carried, not what it is.

**Nit left, deliberately:** the review's `gateWarnings`-is-dead note
(`HopPromptFacts`) is cosmetic and outside both findings; it stays in Review's
notes/debt for the next task that touches `hop-proposal.ts`.

**Gate:** `bunx tsc --noEmit` → 0 · `bun run lint` → `Checked 1248 files`, 0
errors / 0 warnings · `bun test` → **9211 pass, 3 skip (the documented opt-ins:
live-k8s, live-docker, the real-socket keepalive), 0 fail** across 667 files.

*— claude-opus-5-5, 2026-11-14*

### Round 3

*— claude-opus-5-5, 2026-11-14* (fresh context; reviewing commit `cd8c3acf`, `git diff HEAD~1`)

**Verdict: APPROVE (H5).**

Gate: `bun run typecheck` → 0. `bun run lint` → 1248 files, clean. `bun test packages/cli/test` → 2361 pass / 0 fail (2359 + the 2 killed rows, unmutated). tui + daemon + client → 3663 pass / 1 skip / 0 fail. Every mutation was reverted, and `git status` was clean after each.

| R2 finding | mutation | result |
|---|---|---|
| 1 `main` dropped `opts` | `hopBuilder` passes `{}` instead of `opts` | 1 fail (`session-hop-targets`: "the PRODUCTION build carries `gateAnswered`") |
| 2 laptop half of `hop` not pinned | drop `hop: true` at `hop-targets.ts:283,355` | 2 fail (container + attach rows) |
| 2 (deeper) | drop the `deps.hop` forward at `engine-runtime.ts:695,1109` | 2 fail: the rows reach the real `initialize`, not just a spy on the deps |

**Regressions:** `main.ts` now calls `hopBuilder` with the same deps as before (`config`, `status`, `notify`, `host`, `defaultImage`). `shared` is still injected per call by the facade. No behaviour changed for a typed `/move`.

**Residual (not a blocker, carried from round 2 as unverified):** if a hop container's daemon is resident, a later plain `tentacle attach` TUI can join a session that keeps `move_session` and has no feed to answer it. This is worth checking in H6 (attach flow).

**How the executor behaved:** a small, targeted fix. It turned the wiring lambda into a named, tested seam (`hopBuilder`), and the new tests kill both the surface mutation and the deeper one.

## Execution — H6 + H7

*— claude-sonnet-4-5-20250929, 2026-11-14* (executor, branch `feat/session-hop`, worktree
`.tentacle/worktrees/session-hop`)

**Load-bearing check re-run first, as instructed.** Both rigs PASS, unchanged from H5:
`.tentacle/tmp/session-hop/hop-repro.ts` → `B uid: 19fc157a-… == A uid: true`,
`files: 19fc157a-….jsonl`; `hop-race.ts` → a late A save after B wrote drops nothing,
one `.jsonl`. No STOP condition applied.

### H6 — attach to an existing workload (D7 incl. D7c), and hop out never deletes

1. **The pure move first (review M8).** `packages/cli/src/detached-run-of.ts` (new) is the
   closure `main.ts` had at `:1619`, lifted out: `detachedRunOf(deps, name, engine, at)`
   over an injected `{configDir, dir, procOf, read}`. It returns `DetachedRun` (`elsewhere`
   is a discriminant, not a bolted-on field). `main.ts` keeps a one-line `detachedRun`
   wrapper over this process's config dir and `laptopProc`, and its two call sites now use
   it. *Why:* D7(a) asks the same question `attach` asks, and a closure cannot be tested.
2. **D7(a) in the factory, before anything is dialled.** `HopTargetDeps.detachedRun?`
   (`hop-targets.ts`) → `attachTarget` refuses with `attachVerdict`'s own wording
   (`docker:mine is in use by another session`) and touches no engine. `main.ts` passes
   `detachedRun: (workload) => hopDetachedRun(workload)`.
3. **D7(b) after the handshake, before any open.** `attachTarget` reads
   `runtime.residentUse(sessionId, { ownMayBeAbsent: true })` — the runtime is built but
   nothing is open yet — feeds it to `attachVerdict`, and on a refusal disposes the runtime
   and returns the refusal. `null` (a paged list) is a doubt, and a doubt refuses.
4. **D7(c)/D1 4(a) already existed** (`hopSession`'s `closeOrRefuseOwn`); H6's job was the
   *frame-level* proof, which is the new H6 test block below.
5. **"hop out never deletes"** needed no new code — `hopLeaveEntry` + `hopDelete` already
   gate on the entry's `hop: true` mark — but H6 is the first slice where an `attach`
   target is reachable end to end, so it is now pinned by a row through the real factory +
   the real `createHopLeave`.

**A real defect H6's own wiring exposed, found by H7's live test (drift, fixed):** the hop's
container factory computed the mount plan, gated it, then called `startEngineRuntime`
WITHOUT `workspace` — so `/move container` created a container with no bind mount at all
and the agent worked on the image's filesystem, while the owner had approved exactly that
mount. `run` passes `workspace: wsPlan.mount` (`main.ts:1504`); the hop now passes
`...(plan.kind === "mount" ? { workspace: plan.mount } : {})`. Red before green on a real
engine: with the line removed, the live row's `hop-live.txt` never appears
(`(fail) … 0 pass 1 fail`); restored, green. This is H4's bug, not H6's, and no unit row
could see it — the fake host records `create`'s labels, never the create body.

### H7 — the live docker test, the changelog fragment, the docs line

- `packages/cli/test/session-hop.docker.test.ts` (new): one row, `test.skipIf(!ENABLED)`
  on `TENTACLE_DOCKER_TESTS=1`. Real docker/podman host (`buildEngineHost`), real
  `createHopTargets`, real `hopSession`, real `createHopLeave`; a local OpenAI-compatible
  mock model (the pod reaches it through the laptop), real pod-binary injection. It asserts:
  the container's shell call writes a file that appears on the HOST at the same path (the
  bind mount); the entry is in the laptop index with `hop: true`; ONE `<uid>.jsonl` holding
  both places' turns; on `/move local --rm` the container is gone (`describe` → `null`) and
  the index entry with it.
- `changelog.d/session-hop.fixed.md` (new): one bullet, H6's rules + the mount fix. No
  second `added` fragment: `session-hop.added.md` (H1) is the feature's bullet and
  `session-hop.changed.md` (H5) the setting's; AGENTS §10 — curated, not a commit mirror.
- `README.md`: a `/move` paragraph in *Ways to run*, after `attach`.
- `ARCHITECTURE.md`: ADR-007 — one session path, a second runtime; D7's stricter join rule.

**Drift from the Implementation, and why (each a contradiction with the code/doc):**

- **`attachVerdict`'s `own` input is `null` in the factory's D7(b) call.** The factory
  cannot know our own uid's state before the open without a second `session/list`, and
  `hopSession`'s D1 step 4(a) reads it fresh right after — so the factory answers `own:
  null` ("not live here") and the orchestrator owns that question. Recorded because the
  H2 design note put D7 entirely in the factory and 4(a) in the orchestrator; this is that
  split, made explicit in code.
- **`detachedRunOf` is asked with NO `at`.** D7(a) wants "a run of that name+engine owns
  it", so a run at ANOTHER place is treated as this place's — the strict side (refusing to
  join is safe; joining someone's run is not). `attach`'s `at` behaviour is unchanged.
- **H7's live row uses a fixed scratch dir under the repo** (`.tentacle/tmp/session-hop/`,
  AGENTS §6), not `os.tmpdir()`: on a podman machine only `$HOME` is shared with the VM, so
  a `/var/folders` mount is silently empty in the container (its `create` succeeds and the
  folder does not exist there). Also `realpathSync` first, because macOS `/var` is a
  symlink into `/private/var` and the plan mounts at the SAME path on both sides. And the
  hop BACK to `local` is built with the in-memory origin shape, not `startWorkerRuntime`:
  its `new Worker` does not run under a test runner. Neither is a product change.
- **H7's default image is `debian:stable-slim`, not `busybox`.** The injected pod binary is
  glibc-linked; `attachEngineRuntime`'s preflight refuses a musl image BY NAME (a good
  message). A busybox default would report an engine constraint as a hop bug.

**Red first.** `detached-run-of.test.ts` had no module to import (the extraction is what
creates it) — the rows were written against the behaviour and run after the move; the
mutations below are the durable proof (§9). The H6 rows in `session-hop-targets.test.ts`
were run RED against `HEAD`'s `hop-targets.ts` before the D7 wiring (script
`.tentacle/tmp/session-hop/h6/red.sh`): **4 fail** — both D7(a) rows and both D7(b) rows —
then green. The H7 row was red on the mount regression on a REAL engine (above).

**Mutation checks** (each broken in the final tree, the narrow file run, restored, md5
printed before and after; scripts `.tentacle/tmp/session-hop/h6/run*.sh`).

| # | mutation | result |
|---|---|---|
| M1 | D7(a) branch dropped from `attachTarget` | 2 fail — both D7(a) rows |
| M2 | D7(b)'s `residentUse` check dropped | 2 fail — both D7(b) rows |
| M3 | a `null` resident use read as "nobody there" | 1 fail — the unreadable-use row |
| M4 | D1 step 4(a) skipped (`target.preexisting` never checked) | 2 fail — both D7(c) rows |
| M5 | `ownUidVerdict` ignores `running`/`jobs` | 1 fail — the RUNNING-copy row |
| M6 | `detachedRunOf`'s `at` ignored | 3 fail — the two `at` rows + the record-only row |
| M7 | `elsewhere` never reported | 1 fail — the elsewhere row |
| M8 | `createdByHop` taken as `true` (ignore the entry's mark) | 1 fail here + 3 in `hop-leave.test.ts` |
| M9 | `main` stops passing `detachedRun` | 1 fail — the grep-guard |
| H7 | `workspace` dropped from the container factory (LIVE engine) | 1 fail — the mount row |

Each restored; md5 of every touched source matched its pre-mutation value
(`hop-targets.ts` `fcb09391…`, `session-hop.ts` `f22dabc6…`, `hop-plan.ts` `dcbde8e1…`,
`detached-run-of.ts` `344f9be4…`, `hop-leave.ts` `363d8b81…`, `main.ts` `44111eeb…`).

**Tests.** `packages/cli/test/detached-run-of.test.ts` (new, 8 rows: no evidence, an owner
record, a live lock, another engine, `at` this/other place, record-only elsewhere, no engine
named) · `packages/cli/test/session-hop-targets.test.ts` (+9 rows: D7(a) with a
non-vacuity partner, D7(b) refused + unreadable + non-vacuity, D7(c) idle-close with frame
ORDER and running-refused, the user-owned leave, the production grep-guard) ·
`packages/cli/test/session-hop.docker.test.ts` (new, 1 opt-in live row).

**Not in this slice (deliberately).** No `protocol.d/` note and no schema change: D10 holds,
nothing on the wire moved (the frames the tests read are the EXISTING `session/open`,
`session/close`, `session/list`). No fix for the H5 round-3 residual — investigated below.

**The H5 round-3 residual, investigated (not fixed, and why).** Confirmed empirically
(`.tentacle/tmp/session-hop/h6/residual.ts`): `hosted.hop` is set from the attachment that
CREATED the session, so a hop container's resident daemon keeps offering `move_session` to a
later plain `tentacle attach` TUI that joined the same session (`created: false`,
`hosted.hop: true`). That TUI has no `/move` feed, so the agent's proposal would raise no
prompt: the tool is offered and the owner is never asked. It is a real hole, but fixing it
means deciding whether `hop` follows the CREATING client (today) or the CURRENTLY attached
set (a protocol-shaped change: a blocking/mandatory capability per attachment, and what to
do when the creator leaves mid-turn) — an owner question the plan does not answer, and
outside H6's file list. Recorded here as debt for its own task; it is not a regression from
this slice.

**Gate (final tree):** `bunx tsc --noEmit` → 0 · `bun run typecheck` (incl. `apps/mobile`)
→ 0 · `bun run lint` → `Checked 1251 files`, 0 errors / 0 warnings (the baseline is clean) ·
`bun test` → **9228 pass, 4 skip, 0 fail** across 669 files (the 4 skips are the documented
opt-ins: live-k8s, live-docker's own client test, the real-socket keepalive, and H7's new
live row). The live row was ALSO run green by hand against a real podman engine
(`TENTACLE_DOCKER_TESTS=1 DOCKER_HOST=unix:///var/run/docker.sock bun test
packages/cli/test/session-hop.docker.test.ts` → `1 pass, 0 fail`). No protocol schema
changed, so `packages/protocol/schema/protocol.json` was not regenerated.

*— claude-sonnet-4-5-20250929, 2026-11-14*

## Review — H6 + H7

**Verdict: REQUEST-CHANGES** (2 MEDIUM, no HIGH). Scope: `git diff main...HEAD`, slices H6/H7 only.

**Findings**

1. **MEDIUM: the dispose on a D7(b) refusal is not tested** (`packages/cli/src/hop-targets.ts:418`). The row at
   `packages/cli/test/session-hop-targets.test.ts:761` is titled "the runtime disposed", but it never checks that.
   Mutation: delete `await bounded(runtime.dispose(), …)` → `23 pass, 0 fail`. Failure scenario: every refused
   `/move attach` leaks a live `RemoteClient` and its exec stream into a workload that is "not ours", and no test catches it.
   Fix: assert the dispose (the exec channel is closed, or a dispose spy).
2. **MEDIUM: D7(c) closes our own idle copy even when another client is attached to it.** The path:
   `session-hop.ts:277,288` → `ownUidVerdict` (`hop-plan.ts:168`) → `ownUseOf` (`relay-state.ts:292-295`). `ownUseOf` keeps only
   `running`/`jobs` and drops `attached`. Scenario: this is the H5 round-3 residual, confirmed by the executor. A plain
   `tentacle attach` TUI has joined the session on a hop container's resident. The origin TUI then runs `/move attach` to
   that container again. The copy is idle, so `session/close` is sent under the attached TUI. That breaks the changelog's
   "the workload's current client is never disturbed" and D7's "not ours to share". Fix: an own copy with `attached > 0`
   should be `busy` (refuse), plus a row for that case.

**Gate:** touched files (`session-hop-targets`, `detached-run-of`, `hop-leave`, `session-hop.docker`): 47 pass,
1 skip (the opt-in live row), 0 fail. `bun run lint`: 1251 files, clean. `bun run typecheck`: 0. I did not re-run the full
suite. I did not run the live docker row here (opt-in, needs an engine).

**Attacks tried**
- Dropped the D7(b) dispose → no test failed (finding 1).
- Own uid live, idle, with another client attached → closed (finding 2, read from the code; no row covers it).
- Ordering: D7(a) runs before `deps.host`, and D7(b) runs after the handshake and before any `session/open`. Both hold:
  the runtime opens lazily, and the frame-level rows check it.
- Hop out with `keep:false` on a workload joined by attach: the delete is gated on the index entry's `hop:true`
  (`hop-leave.ts:102`) and matched by location key. Holds.
- `detachedRun` asked with no `at` (the strict side): refuses a same-name run at another place. Acceptable, as documented.
- `residentUse` is not bounded in time (`hop-targets.ts:414`): a hung pod hangs the hop. Same as the existing
  `closeOrRefuseOwn` read, so not raised.

**Process:** the plan asked for a SEPARATE pure-move commit for `detachedRunOf` (M8). It landed in the same commit
`ca16037a`. Not blocking. The Execution section is signed `claude-sonnet-4-5-20250929`, but the commit says "deepseek".
Fix the signature so it names the model that actually ran.

**Executor behaviour:** careful and honest. The live test found a real mount bug, and the residual was investigated and
reported as debt. One mutation claim was overstated (finding 1's test title).

*— claude-opus-5-5, 2026-11-14* (fresh context, not the executor's model family)

### Round 2

**Verdict: PASS.** I checked both findings against `git diff HEAD~1` (`d019f903`), mutated each fix, and reverted each mutation; the tree is clean afterwards.

- **Finding 1 (dispose on a D7(b) refusal): fixed.** `watchedChannel` records whether the exec channel was closed. Mutation: drop `await bounded(runtime.dispose(), …)` at `hop-targets.ts:418` → the "runtime disposed" row FAILS. The same watcher is in the join row, which is not refused, so that row is the counter-check (`closed: false`).
- **Finding 2 (own copy with a client attached): fixed.** `OwnUse.own.attached` is now carried (`relay-state.ts:303-306`), and `ownUidVerdict` treats `attached > 0` as busy (`hop-plan.ts:173`). Mutation A: drop the `attached` clause → 2 FAIL (the `attachVerdict` row, and the frame-level row "an IDLE copy another client is ATTACHED to: refused, never closed under it"). Mutation B: `ownUseOf` drops `attached` → 2 FAIL (the `ownUseOf` row and the same frame-level row).
- **Regressions:** `ownUseOf`/`ownUidVerdict` have one production consumer each, both on the hop path (`local-runtime.ts:1243`, `session-hop.ts:277`). No other path changes meaning. Between the read and the close, a client could still attach. That window remains, and it is accepted (D7: the check is UX, not security).
- **Gate:** the touched files (`session-hop-targets`, `hop-plan`, `relay-state`, `session-hop`, `hop-leave`) give 144 pass, 0 fail. `bun run lint`: 1251 files, clean. `bun run typecheck`: no errors. I did not re-run the full suite.

*— claude-opus-5-5, 2026-11-14*

### Fix round 1 — the H6+H7 review's MEDIUM findings

*— deepseek-v4.1-flash-1017, 2026-11-14*

Scope: the two MEDIUM findings of `## Review — H6 + H7` above, and the process
note. No other behaviour touched. Both findings were reproduced before either
was fixed; every fix carries the mutation that proves it non-vacuous (each
broken in this tree, its narrow file(s) run, restored, `md5` printed before and
after — no `.bak` left, nothing checked out or stashed).

**Finding 1 (MEDIUM) — the dispose on a D7(b) refusal was not tested. FIXED
(production code already right; the ASSERTION was missing, and that was the
bug in the test).**

`hop-targets.ts:415-419` did dispose *and* open nothing; the row
`"refused with the D7 wording, the runtime disposed, and NO `session/open` ever
sent"` asserted only the frames and the list, so its own title's central claim
(the dispose) was unproven — exactly what the reviewer's mutation showed.

- The rig gained the one observable a `dispose` has: `FakeHostLog.closes`
  (`session-hop-targets.test.ts:124-129`) and `watchedChannel`
  (`:150-166`), a client channel that records whether it was **closed** and is
  handed to every `openExec` (`:234`). `dispose` → `client.close()` →
  `Peer.close()` → `channel.close()`, so a leaked `RemoteClient` and its exec
  stream are now distinguishable from a released one.
- The row asserts it (`:813-815`): `log.closes` has the one dialled runtime and
  it is closed.
- Its own non-vacuity is now explicit in the neighbouring row
  (`"non-vacuity: the SAME occupied daemon with an EMPTY list is joined"`,
  `:841-862`): the SAME watcher reads `closed: false` for a build that was NOT
  refused, then `closed: true` after the caller's own `dispose`.

*Red first / mutation:* delete `await bounded(runtime.dispose(),
HOP_ROLLBACK_TIMEOUT_MS)` (`hop-targets.ts:418`, md5 `9a961223…` →
`f4e7fda6…`) → **1 fail**, on the new assertion and nothing else
(`expect(log.closes?.every((c) => c.closed)).toBe(true)` → received `false`),
`22 pass / 1 fail`. Restored → md5 `9a9612237a4e129f0c24ad97bf60aa40`,
`23 pass / 0 fail`. This is the reviewer's mutation, now caught.

**Finding 2 (MEDIUM) — D7(c) closed our own idle copy even with another client
attached to it. FIXED.**

The chain was `session-hop.ts:277` → `ownUidVerdict` (`hop-plan.ts:161`) →
`ownUseOf` (`relay-state.ts:283`), and the loss happened in **two** places, not
one: `ownUseOf` did not carry `attached` at all, and the verdict would not have
looked at it. `attached` is the only field that separates a copy nobody uses
from one a plain `tentacle attach` TUI is sitting in (`running: false, jobs: 0,
attached: 1` — verified on a real `SessionHost` in
`.tentacle/tmp/session-hop/attached.ts`: `after open: [{…,"attached":1,
"running":false}]`, which also proved the pre-existing rows' `open` left the
copy attached — see the drift note below).

- `relay-state.ts:279-286` (+ `ownUseOf`, `:293-309`): `OwnUse.own` is
  `{running, jobs, attached}`, and
  `ownUseOf` carries `own.attached` from the same single `session/list` read
  (no second read, so the two can never disagree).
- `hop-plan.ts:166-176`: `ownUidVerdict` treats `attached > 0` as `busy`
  (`running || jobs > 0 || attached > 0`), with the reason stated:
  `session/close` under an attached TUI ends that client's session just as
  surely as killing a turn. `busy` keeps its existing wording (`<name> still
  holds an older copy of this session`) — one wording site, no new string.
- `AttachVerdictInput.own` (`hop-plan.ts:178-196`) widened to match; the
  `attachTarget` callers already pass `own: null`, so nothing else changed.
- Doc: D1 step 4(a) (`docs/feat/session-hop.md:194-201`), D7(c)
  (`:276-282`) and the H1 design note (`:525-535`) now state the `attached`
  arm, so the plan stays the source of truth (§8).
- Changelog: `changelog.d/session-hop.fixed.md` — the refusal list now says
  "…or has another terminal attached to it", which is what the fragment's
  "the workload's current client is never disturbed" always claimed.

*Red first (three layers, each failing on its own property):*
- `relay-state.test.ts:396-408` (new) `own ATTACHED to by someone: the fact is
  carried, never dropped` → RED: `{"own":{"jobs":0,"running":false}}` vs the
  expected `attached: 2`; and the two neighbouring rows updated for the shape.
- `hop-plan.test.ts:231-249` (new) `our OWN uid with a client ATTACHED is
  refused too` → RED: received `{"kind":"close-own"}` where the refusal was
  required; includes the non-vacuity row (`attached: 0` → still `close-own`).
- `session-hop-targets.test.ts:992-1009` (new) `an IDLE copy another client is
  ATTACHED to: refused, never closed under it` — the whole hop over the real
  factories, the real orchestrator and a REAL `session/list` (the stale copy is
  seeded and its creating attachment left in place, `:904-908`) → RED:
  received `"moved"`, i.e. the hop went through and closed the copy.

*Mutations (each restored; md5s printed):*
1. `hop-plan.ts` verdict drops the `attached` arm (back to
   `running || jobs > 0`, md5 `ef99ee41…` → `23c5c070…`) → **2 fail**: the new
   `hop-plan` row and the new end-to-end row; `47 pass / 2 fail`. Restored →
   `ef99ee413c95349a6787ab761654322b`.
2. `relay-state.ts` `ownUseOf` zeroes `attached` instead of carrying it (md5
   `c8b7a6e0…` → `3dc401ef…`) → **2 fail**: the new `relay-state` row and the
   end-to-end row (the verdict cannot see what the read dropped); `71 pass /
   2 fail`. Restored → `c8b7a6e046b041c2f3438430ea160849`.

**Drift from the Implementation (and why).**

1. **The pre-existing D7(c) rows opened the stale copy and left it ATTACHED.**
   The shared rig `ownUidOnResident` (`session-hop-targets.test.ts:878-920`)
   called `server.open(...)` and never detached the creating attachment, so that
   "idle copy" was really `attached: 1`. Harmless before (nothing read
   `attached`); with the fix, the IDLE row would have been refused like the new
   one and stopped proving the close-then-seed path. It now detaches the
   creating attachment (`:906`) — the honest shape of a stale copy, "the
   client that made it has LEFT" — and only the new row keeps it attached. Found
   because the fix made the fixture's lie visible; `attached.ts` is the repro.
2. **`OwnUse` widened rather than a second field added.** `ResidentUse` has no
   "own present" field by design, and adding `ownAttached` beside `own` would
   let the two halves come from different reads. One struct, one read.
3. **The reviewer's process note (not a finding): the H6+H7 Execution
   signature.** The reviewer reports the commit says "deepseek" while that
   section is signed `claude-sonnet-4-5-20250929`, and asks for the real model.
   I cannot honestly sign another agent's run: I did not execute H6/H7, and I
   found no record of which model did (no tentacle session log names
   `session-hop`; the Claude transcripts I can read are all `claude-opus-5-5`).
   **This is left to the orchestrator**, which launched it and knows the
   profile. My own signature above is my real id, by two independent signals:
   the launcher argv (`ps` → `tentacle --profile deepseek`, and that profile is
   `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`, `~/.config/tentacle/config.jsonc`)
   and this context's 393k window, which is exactly that profile's
   `contextWindow`.

**Gate (full, this tree):** `bunx tsc --noEmit` → 0 ·
`bun run lint` → `Checked 1251 files`, 0 errors/warnings ·
`bun test` → **9231 pass, 4 skip, 0 fail** across 669 files. The 4 skips are the
documented opt-ins (live-k8s, live-docker, the real-socket keepalive) plus the
opt-in live docker row of `session-hop.docker.test.ts`; none is a non-opt-in
skip and none is new. No protocol change (`packages/protocol/schema/protocol.json`
untouched — the fix is laptop-side only).

**What I did not verify:** the live docker row (`session-hop.docker.test.ts`,
opt-in, needs an engine); and the H6+H7 Execution signature, which is the
orchestrator's to correct (drift note 3).

### Post-merge note — the TUI swap is after `old.dispose()` (D1 step 5 drift)

D1 step 5 says "let the TUI swap … and only then run `old.dispose()`". As built,
the App swaps when `HopRun.done` resolves (`App.tsx`, the hop's `done` handler),
i.e. AFTER the whole hop, dispose included — so the TUI still watched the OLD
controller when `dispose` closed it. With the client then reporting that close
as foreign, this lost the conversation on every live hop
(`docs/fix/session-hop-live.md` D1). That fix does not move the swap (owner Q3):
a close this client issued is no longer "closed on another device" (F1), and the
hand-over controller travels in the outcome, so no `createSession` can steal it
(F2). The order is now harmless; it is recorded here so nobody relies on step 5
as written. *— claude-opus-5-5, 2026-11-14*
