# feat/detached-relay — `run --detach --prompt`: a pod run with no TUI (detached-runs S2)

> **Status:** execution — S2 (this doc) approved by the owner 2026-10-30; S2b follows
> **Branch:** `feat/detached-relay`
> **Type:** feat · **Size:** M (after the split below; the umbrella's S2 as listed is L) · **Blast:** load-bearing · **Suited:** Opus executes, mandatory fresh-context Review

Umbrella: [`docs/feat/detached-runs.md`](detached-runs.md) (Context F1–F9, DR-1…DR-9, Implementation, S1 rounds 1–6).

## Context

*— claude-opus-5-5, 2026-10-30*

**Why.** S1 made the pod daemon resident: a laptop process can leave and the session stays in the pod. Nothing laptop-side can run a turn yet. The model stays on the laptop (AGENTS §7), so a run with no TUI needs a background laptop process that serves `model/stream`, holds the single permission broker and persists. That process is the **relay** (DR-1 (c)).

**S2's scope in the umbrella.** Slice 2: `run --detach --prompt`, the relay entry point (a headless `attachEngineRuntime`, `interactive: false` hooks trust), owner file, log, idle exit, `--keep=false`, `--auto-accept`, caffeinate. Its re-attach is "wait for idle, or `rm`".

**Owner decisions that bind it.**
- **DR-1 (c):** resident pod daemon + one laptop owner at a time.
- **DR-2:** `run --detach --prompt` and `/detach` are both in scope of the deliverable; `/detach` is S5.
- **DR-3 (A):** a detached run waits at the first ask unless `--auto-accept`. Auto-accept is pod asks only, allow-once, logged; laptop gates are never auto-approved.
- **DR-4 (A)+:** the relay exits when the session is idle (no turn, nothing queued, no pending ask, no running job) after 60 s; also on stop or workload gone.
- **DR-5 (B):** `--keep=false` removes the workload when the relay exits normally; a pending ask keeps it alive. *(Moved to S2b, see Split.)*
- **DR-6:** stdio to files only, owner file, capped log.
- **DR-7 (A):** no notification.
- **DR-8:** a gone workload is an explicit message with no local fallback. *(S3.)*
- **DR-9 (C):** caffeinate while a turn runs, on by default on macOS. *(Moved to S2b.)*

**Split (this doc's decision, owner question Q1).** As listed, S2 touches 16 files and a new subsystem, which is `L`; AGENTS §10 says split. Two parts ride one after the other, S2b before S3:

| Slice | Contents | Size |
|---|---|---|
| **S2 (this doc)** | relay, spec + owner state, log, policy, idle exit, stop by SIGTERM, `attach` refusal, `jobs` field | M |
| **S2b `feat/detached-relay-lifecycle`** (own doc) | DR-5 `--keep=false`, DR-9 keep-awake, the two `Detach S2` TODO items | S–M |

Until S2b, `--detach` with an effective `keep: false` is a usage error. The release after S3 includes both.

**Left to later slices.** S3: control socket, live hand-over, `attach` opening the run's session, DR-8 message, stale-owner takeover by a TUI, `modelIdle()`, TUI owner file. S4: `ps` STATUS, `rm` stopping the owner, run-dir cleanup. S5: `/detach`, relay mode `adopt`.

**Repro** (2026-10-30, `.tentacle/tmp/detached-relay/repro.test.ts`: `main(["bun","tentacle","run","--detach","--prompt","hello","--image","node:22"], { write })`, run with `bun test`):

```
exit 1
[error] unknown option --detach
usage: tentacle run --image <ref> [--engine kubernetes|docker|podman] …
```

## Implementation

*— claude-opus-5-5, 2026-10-30*

Verified on `feat/detached-relay` = `main` a4ddda0.

### Load-bearing assumption

**A pod turn depends on nothing in Ink: one `RemoteClient`, one broker and `persistingController`, in a process with no TUI, run a turn to its end, with its asks answered or held, save it on the laptop, and then `session/detach` leaves the session live for a later client.**

**PROVEN in-process; NOT proven with a real exec or a compiled binary.** The live test at the end of Execution covers that gap.

From the code:
- Ink enters only through `startTui` in `runEngineTui` (`cli/src/main.ts:660-676`).
- The client answers `model/stream*` and `hooks/trust` itself (`client/src/remote-client.ts:953-963`).
- A prompt goes to the broker without blocking the peer (`remote-client.ts:1869-1878`).
- Saving hangs on the `send` generator, not on a consumer of that kind (`cli/src/local-runtime.ts:176-189`).
- `session/detach` exists (`remote-client.ts:650`). After it, `release` cancels only an active turn when the last serving link leaves (`daemon/src/connection.ts:139-146`), and at idle nothing runs.
- A reopen of a live id does not recreate it (`daemon/src/session-host.ts:362-365`).

Probe (`.tentacle/tmp/detached-relay/probe.test.ts`, gitignored; `bun test` on the path): real `SessionHost` + `Connection{servesModel}` + `ProxyModelProvider` through `context.modelLink`, `shellTool` (ask), a `RemoteClient` with `PermissionBroker(requester, {holdUntilSet: true})`, `persistingController`, `createChannelPair`.
- **A:** the requester answers `{allowed: true, scope: "once"}`.
- **B:** the requester holds until its signal aborts, and returns `DISMISSED`.

```
A turn events: tool_start tool_result text turn_end
A asked: [ "shell" ] execs: [ "x" ] saved msgs: 4
A after detach: live true { id: "S", attached: 0, busy: false, … }
B text: second msgs: 6 first model calls: 2 second: 1
B after 400ms: raised 1 list [ { running: true, attached: 1 } ] execs []
B events: tool_start tool_result turn_end:cancelled
B saved: user,assistant,tool execs: []
 2 pass, 0 fail
```

Beyond the assumption, this proves two design points: a held ask keeps the turn running with the tool unrun, and aborting the local `send` ends the turn `cancelled`, saves it and leaves the session live. The stop path below rests on that.

### Preconditions (against the AS-BUILT S1)

- **P1 — resident.** One `SessionHost` on a unix socket, one `Connection` per socket, `servesModel` from `--model-proxy` (`cli/src/pod-resident.ts:290-316`, `:792-797`). A closed socket detaches (`:311-315`).
- **P2 — bridge.** Every exec is `serve --bridge` (`engine-runtime.ts:73-86`), which starts the resident on ENOENT/ECONNREFUSED (`pod-resident.ts:457-479`). A redial is a new bridge to the same resident (`engine-runtime.ts:202-214`).
- **P3 — model link per session.** The most recently attached serving client (`hosted-session.ts:837-845`). The last serving client leaving cancels the turn (`connection.ts:143-145`).
- **P4 — `session/close{ifLast}`.** `dispose` → `closeSessions` closes the session unless another client is attached (`local-runtime.ts:376-382`, `remote-client.ts:741-744`, `connection.ts:394-399`). So the relay must never `dispose`: alone, that closes the session.
- **P5 — generation lock.** `acquireResidentLock(stateDir, procOf)` needs no process-specific state and takes a `ProcOf` (`pod-resident.ts:226-280`). Holder content is `<pid> <start>`, split on spaces (`:168-174`).
- **P6 — `residentGuard`.** Any `attached > 0` or `running > 0` refuses a replace (`pod-resident.ts:726-736`). A live relay is `attached`, so the guard already covers it.
- **P7 — idle bounds in the pod.** A detached idle session expires after 30 min, as does the resident (`pod-resident.ts:55`, `:335-337`, `:346-357`). The reaper ignores jobs (`daemon/src/session-reaper.ts:4`).
- **P8 — held asks.** The router sends nothing for a dismissed prompt (`client/src/permission-router.ts:15`, `:131-133`), and `connectionClosed` aborts the prompt (`:199-207`).
- **P9 — hooks trust.** `interactive: false` → declined + notice, with no broker call (`cli/src/hooks-trust.ts:39`, `:175-181`). A pod runtime never gets a trust store (`local-runtime.ts:301`).
- **P10 — link end.** Transient dial failures retry forever, capped at 30 s; `gone`, `unauthorized` and `VersionMismatch` stop (`client/src/link-machine.ts:85-97`, `:129-146`). `dialVerdict` gives `gone` for a deleted container (`engine-docker.ts:312-325`) and uses `podDialError` on k8s (`engine-k8s.ts:213-219`).
- **P11 — kept index.** `readKept` skips anything not a top-level `*.json` (`kept-index.ts:83-86`), so `<configDir>/kept/runs/` is invisible to it. `hostOptionsFor(entry)` redials the same place (`engine-select.ts:290`).
- **P12 — detached children.** `selfCommand()` + `spawn({detached: true, stdio: [...]}).unref()` (`pod-resident.ts:81-88`, `:500-520`). `process.exit(await main(...))` runs exit handlers (`main.ts:1064`).
- **P13 — session store.** `openTuiSessions({root, cwd}, {wanted: false}, write)` gives a `SessionSaver` on `sessions/<projectKey(cwd)>/` (`tui-sessions.ts:48-66`), the path `--resume` reads.

**Where the umbrella plan no longer matches the code:**

| # | Umbrella says | Code / decision |
|---|---|---|
| D1 | `owner.lock`: `wx` create, liveness = `kill(pid,0)` + control-socket `status` | S1 rounds 2–3 showed `wx` plus takeover races. Reuse `acquireResidentLock` (P5). The control socket is S3, so S2 liveness = pid + start time. |
| D2 | Start time is available | `procStat` reads `/proc` (`pod-resident.ts:143-149`), absent on macOS, so a pid reused after a reboot would look alive. A laptop `ProcOf` is needed. Its `start` must be one token (P5), so `Date.parse` of `lstart`, not the raw text. |
| D3 | S2's files do not touch `attach`; the owner check is S3 | Without a check, `attach --resume <uid>` during a relay gives two writers of one uid and a stolen model link (P3). S2 refuses (below). |
| D4 | "`createSession()` with the spec's uid" | No such seam: `uid = record?.id ?? crypto.randomUUID()` (`local-runtime.ts:333`). Add `sessionId` to the deps. |
| D5 | Re-attach "wait for idle" | Plain `attach <name>` opens a FRESH session (`resume` null, `main.ts:908`). The run's session needs `attach <name> --resume <uid>`, from the same cwd (`tui-sessions.ts:58`). The launcher prints that command. |
| D6 | "The session stays in the pod" | Only for 30 min (P7); after that the laptop copy re-seeds it. |
| D7 | `autoApproves` is reusable | It is not exported by `@tentacle/tui` (`tui/src/permission-ui.ts:41`, absent from `index.ts`). Export it and `ownRequest`. |
| D8 | `stop` via control socket | S3. S2 stops on SIGTERM. |
| D9 | Line numbers | All moved; the cites here are current. `main.ts` `run` is at `:693`, `attach` at `:844`. |

**Unverified (first step of Execution):** `LC_ALL=C ps -o stat=,lstart= -p <pid>` on the owner's Mac. It needed an approval this session did not have, and I did not route around it. A different format means `laptopProc` parses differently, nothing more.

### Design

**Run state** (`<configDir>/kept/runs/<stem>/`, dir 0700, files 0600; `<stem>` = `keptFileName(entry)` without `.json`):
- `.lock.<n>`: the generation lock (P5), held by the relay.
- `owner.json`: atomic temp+rename, strict parse. Unknown `schemaVersion` → reported as "unknown owner", never rewritten. Fields: `schemaVersion`, `kind: "relay"`, `pid`, `appVersion`, `sessionId`, `state` (`starting|running|waiting-permission|idle|interrupted|failed`), `tool?`, `detail?`, `lastActivityAt`, `autoAccept`. It survives the relay's exit, as the last state for S3/S4.
- `spec.json`: `schemaVersion`, `mode: "start"`, `stem`, `sessionId`, `prompt`, `autoAccept`, `cwd`, `profile?`. No secrets and no location: the kept entry has it (P11). The relay unlinks it once read. `adopt` is S5, so it does not exist yet.
- `relay.log`: 1 MiB, one rotation, by the relay's own writer. Every line is written through `untrustedText`, because `cat relay.log` is a terminal too.

**Launcher** (`run --detach --prompt <text>`, in `main.ts`'s `run` branch).
- Flags: `--detach`, `--prompt <text|->` (`-` reads stdin when it is not a TTY), `--auto-accept[=true|false]`, parsed like `KEEP` (`flags.ts:55`).
- Usage errors, from a pure `detachFlagProblem`: `--prompt` without `--detach`; `--detach` without a non-empty prompt; `--auto-accept` without `--detach`; `--detach` with `--resume`/`--continue` (Q4); effective `keep: false` (until S2b).
- Same setup as `run` (engine, image, mount gate, `main.ts:694-775`), with `keptMetadata` and `recordKept` always on. A failed `recordKept` is fatal here: the relay needs the entry, and today's warning (`engine-runtime.ts:295-303`) is not enough.
- `provisionWorkload(config, deps)` is `startEngineRuntime`'s create → ready → inject → kept line (`engine-runtime.ts:266-375`), moved unchanged. `startEngineRuntime` calls it. Output stays in the foreground, so transfer progress and errors reach the user directly.
- It mints the uid, writes `spec.json` and spawns `[...selfCommand(), RELAY_SUBCOMMAND]` with `cwd`, `env {...process.env, TENTACLE_RELAY_SPEC: path}`, stdio `ignore`/log/log, `detached`, `unref`.
- It waits for `owner.json.state !== "starting"`, up to 60 s. Child exited or `failed` → sanitised log tail, exit 1. Still starting at 60 s → says so with the log path, exit 0.
- It prints one plain line: the name, `tentacle attach <name> --resume <uid>`, and either "it waits at the first permission" or "auto-accepting pod tool asks (allow once; logged in <log>)".

**Relay** (`RELAY_SUBCOMMAND = "__relay"`, dispatched next to `DELETE_POD_SUBCOMMAND`, `main.ts:292`; the body in `cli/src/relay.ts`):
1. Read and validate the spec, unlink it, `loadConfig({cwd, scaffold: false, profile})`, open the log.
2. Read the kept entry, then `buildEngineHost(entry.engine, hostOptionsFor(entry))`.
3. `acquireResidentLock(runDir, laptopProc)`; a live holder → exit 1. Write `owner.json{starting}`.
4. Build **one** `PermissionBroker(requester, {holdUntilSet: true})`; the requester comes from `relay-policy.ts`.
5. `openTuiSessions(..., {wanted: false}, log)` for the saver (P13).
6. `attachEngineRuntime(config, {host, name, binDir, permissions, saver, resume: null, interactive: false, sessionId, log, notify: log})`.
7. `createSession()`, bind the policy's `ownsTurn`, write `running`, drive `send(prompt, stop.signal)` to its end, and feed every step to `relay-state.ts`.
8. Wait in the reducer's loop: a 1 s tick, plus `sessionJobs(id)` every 30 s once the turn is over (at its end too), whatever the last answer was: a failed read must not leave `jobs = 0` for good.
9. On exit: `release()`, `saver.drain()` (lines go to the log), final `owner.json`, lock release, exit.

**`relay-policy.ts` (pure).** `requester(req, options)`:
- `autoAccept && autoApproves(req, ownRequest(options?.turnId, ownsTurn))` → logs `untrustedText(tool + title + detail)` and returns `{allowed: true, scope: "once"}`.
- Anything else → hold: raises `ask_raised(tool)`, and resolves `DISMISSED` on abort with `ask_gone`.

`ownRequest` excludes a turn another client started (the TUI's rule, `permission-ui.ts:50`). `hooks_trust` never gets here (P9), and `autoApproves` would refuse it anyway.

**`relay-state.ts` (pure).** Events: `turn_started`, `turn_ended{reason}`, `turn_failed{message}`, `ask_raised{tool}`, `ask_gone`, `jobs{n}`, `link{status}`, `stop`, `tick{now}`. Output: `state`, `tool?`, `detail?`, `exitAt?`.
- Idle = turn over, no ask, `jobs === 0`. `exitAt = now + 60 s` once idle, cleared if that stops holding.
- A `cancelled` turn that nobody stopped → `interrupted`.
- Link `stopped` → `failed`, exit now.
- `stop` → abort the turn, exit once it settles, bounded by 5 s.

**Stop (S2's only control).** SIGTERM/SIGINT abort `send`'s signal. The turn ends `cancelled`, it is saved (probe B), then the normal exit runs. This is also the way out of a held ask until S3 (Q2). A second signal exits at once.

**`attach` refusal.** In `attach`, before `openSessions`: a kept entry named `name` (filtered by `--engine` when given) with a live lock holder → exit 1, nothing dialled: "`<name>`: a detached run owns it (pid N, `<state>`). Wait for it, or `kill N` to stop it, then `tentacle attach <name> --resume <uid>`". A stale or absent lock proceeds as today. Pure `relayBlocking(name, entries, holderOf)` in `run-state.ts`; `lockHolder(stateDir, procOf)` is the first lines of `residentStop` (`pod-resident.ts:616-619`), exported.

**Seams added.**
- `LocalRuntimeDeps`: `interactive?: boolean` (default true, `local-runtime.ts:300`) and `sessionId?: string`, used only for the first session, like `seed`.
- `LocalRuntime.release()`: `allFlushed`, then `detachSession` for each `liveSessionIds()` (`remote-client.ts:727`), `drain`, `client.close`, `disposeTransport`. A rejected detach goes to `onPeerError`. It never closes a session (P4).
- `LocalRuntime.sessionJobs(id)`: from `client.sessionList()` (`remote-client.ts:444`), `null` if unreadable.
- `EngineAttachRuntimeDeps` passes `interactive` and `sessionId`.
- `SessionListEntry.jobs` (optional non-negative int): running jobs, from `hosted.summary` (`hosted-session.ts:762`) via `JobController.list()` (`exec/src/background.ts:129`). A new field is free (§7), so there is no `PROTOCOL_VERSION` bump and no `UPDATE_CLASS` change. Regenerate `schema/protocol.json`.

### Files (dependency order)

1. `protocol/src/session.ts`, `schema/protocol.json` — `jobs`.
2. `daemon/src/session-list.ts`, `daemon/src/hosted-session.ts` — `jobs` in the summary.
3. `tui/src/index.ts` — export `autoApproves`, `ownRequest`.
4. `cli/src/local-runtime.ts` — `interactive`, `sessionId`, `release`, `sessionJobs`.
5. `cli/src/pod-resident.ts` — export `lockHolder`.
6. `cli/src/engine-runtime.ts` — `provisionWorkload`, pass `interactive`/`sessionId`.
7. NEW `cli/src/run-state.ts` — paths, spec, owner, `laptopProc`, `relayBlocking`, capped log writer.
8. NEW `cli/src/relay-policy.ts`, `cli/src/relay-state.ts` — pure.
9. NEW `cli/src/relay.ts` — the relay and the launcher's spawn + wait.
10. `cli/src/flags.ts`, `cli/src/main.ts` — flags, USAGE, HELP, dispatch, `run` branch, `attach` refusal.
11. Tests per the list below. `README`/`docs` usage line.

No client package change (D3's refusal lives in the CLI). No `transport` change.

### Failure modes

| Event | Behaviour | Convergence |
|---|---|---|
| Mac sleeps | Link drops; last serving link gone → turn cancelled in the pod. On wake the client redials and re-sends the prompt key, and learns the end (`link-machine.ts:173-179`). | `interrupted`, idle, exit after 60 s. The user runs `attach --resume <uid>` and re-prompts. Never re-run. |
| Link down for a long time | Transient redials never stop (P10). | Decision: no give-up bound. The relay is cheap, and `attach` could not reach that workload either. `kill` ends it. |
| Relay SIGKILL or crash | Bridge closes → turn cancelled. Lock holder dead. | `attach --resume <uid>` proceeds (stale lock). History up to the last save. |
| Laptop reboot | As above; the pid may be reused. | `laptopProc` start time differs → stale (D2). |
| Killed during the FIRST turn | No laptop record: saves happen at turn end. `--resume <uid>` is NOT fatal: a valid uid with no record prints `[resume] no session …; starting fresh`, so a `kill -9` in the first turn gives the user an empty session, with only that line to tell. | Transcript is in the pod until the 30-min expiry, unreachable until S3 opens by id. Stated limit (Q5). SIGTERM is not affected: it saves. |
| Two relays | Second loses the generation lock. | Exit 1, logged. Only reachable by hand: `run` creates a new workload each time. |
| Relay vs a TUI on the same session | `attach`, with or without `--resume`, is refused while the lock is live. | No second writer, no stolen model link. During the 60 s grace the message shows `idle`; retry or `kill`. |
| `attach` in the provisioning window (kept entry exists, relay not locked yet) | It joins the resident with a fresh uid: a different session. | Harmless: separate model link and record. Accepted. |
| `attach` with explicit flags, same name in two locations | The index scan may refuse a same-named workload elsewhere. | Message names the pid; `kill` or wait. Accepted, rare. |
| Permission asked, no auto-accept | Held: `waiting-permission (tool)`. Relay stays, no timeout, turn running. | Answered by no one until S3. `kill <pid>` → `cancelled`, saved, session live. Q2. |
| Permission asked, auto-accept | `allow_once`, logged. | Next ask asks again. |
| `allow_once` not offered | Router reports `unoffered`, nothing sent (`permission-router.ts:138-143`). | Goes to `onPeerError`, the buffered stderr sink, so `relay.log` shows it only at teardown, and `owner.json` says `running`, not held. The turn never moves until a `kill <pid>`. No relay test. |
| Project hooks present | Declined, notice in the log (P9). | Turn runs without them, as DR-3 says. |
| Version skew: laptop updated during a run | The relay runs from memory. New CLI reads the same lock; `owner.json` of an unknown schema = "unknown owner". | `attach` refused while the lock is live. If it got past that, `residentGuard` refuses a replace (P6). |
| Version skew: relay vs pod | `run --detach` is always a new workload, injected by the same version. | `initialize` still gives `VersionMismatch` → link stopped → `failed`. |
| Workload deleted (`tentacle rm`, external) | `gone` → link stopped. | `failed: gone`, flush, exit. Run dir stays until S4. |
| Pod restarted | Resident gone; the client recreates from the seed, `turn_lost` fails the turn. | `failed` with the message, then exit. Laptop history intact. |
| Model error or `apiKeyCommand` needing a TTY | The turn ends in error. | `failed: <detail>`, exit after the grace. |
| Launcher: relay dies at start | Child exit seen. | Sanitised tail, exit 1. The kept workload stays for `attach` or `rm`. |
| Launcher: the run dir, the spec or the spawn fails (EACCES, ENOSPC) | `launchRelay` catches it, after provisioning. | The sanitised error + the same "stays up / `rm`" lines, exit 1. No rejection out of `main`. |
| Launcher: relay slow | 60 s passed. | Says so, exit 0; `relay.log` tells the rest. |
| Save fails | Saver reports it. | Logged. `drain` lists it at exit. |
| `relay.log` cannot be written (disk full) | `createRelayLog` swallows it. | The relay carries on; `owner.json` is written apart and has its own guard. |
| `owner.json` unknown or corrupt, read by `attach` | Refused, left byte-identical. | Lock liveness still decides. |
| `owner.json` unknown or corrupt, found by a starting relay | Refused under the lock, left byte-identical (AGENTS §7): exit 1, nothing dialled, lock released. | The launcher prints the tail, which names the file. The run dir outlives `rm`, so that name at that location stays refused until the user removes the file. |
| Empty prompt / empty stdin | Usage error before anything is created. | Nothing to converge. |
| Job never ends | Relay stays (DR-4). | `kill`. Also reachable by a hostile pod reporting `jobs > 0` forever; costs one idle process, no laptop effect. |
| Unreadable `jobs` | `sessionJobs` → `null`: the tick is skipped, the last value stays. | Next poll. |
| Pod floods stderr or asks | Stderr sink capped at 16 KiB (`engine-runtime.ts:129-147`), log capped at 1 MiB + one rotation. | Disk bounded. The sink's tail is lost on SIGKILL (the resident's own log stays in the pod). |

### §7 invariants

| Invariant | How it stays true |
|---|---|
| One session path | The relay is `attachEngineRuntime` + `RemoteClient` ↔ `Connection`, with no parallel loop. The agent stays in the pod. |
| Single broker | One broker in the relay process, given to the runtime; there is no TUI. Test R11 fails with a second broker. |
| Model on the laptop | `laptopModels(config)` in the relay. The key comes from config or inherited env, never from argv or the spec. |
| Pod not trusted | Auto-accept is `once`, own turns, never `hooks_trust`, and there is no trust store. Every effect is decided on the laptop. Pod text is sanitised before log, `owner.json` and terminal. `jobs` steers only the relay's own lifetime. |
| Persistence on the laptop | The saver writes the laptop store, one writer per uid: `attach` is refused while the relay lives, and a dead relay writes nothing. The pod stores nothing durable. |
| Never write raw to the terminal | The relay has no TTY: stdout is a file, so `StatusLine` is off (`engine-runtime.ts:468`). The launcher writes plain lines and Ink never mounts. |
| Don't serialize the peer | A held ask is a pending promise outside any handler (`remote-client.ts:1869`). No lock or await is added around `Connection`. Polling is an ordinary concurrent request. |
| Protocol | `jobs` is an optional strip-schema field. On-disk `owner.json` and `spec.json` are versioned and strict. |
| Pod lifecycle | `run --detach` keeps its workload (no exit net: `keepHint` is always on until S2b). Secrets go by env. `__relay` is one constant, pinned by a dispatch test. |

### Tests (red first; each with its mutation target)

- **R1** `relay-policy.test.ts`: off → held, `ask_raised`, `DISMISSED` on abort. *Mutation:* answer `allowed: true`.
- **R2** on → `{allowed: true, scope: "once"}` and one sanitised log line. *Mutation:* `scope: "session"`.
- **R3** `hooks_trust` and a foreign turn are never answered. *Mutation:* pass `own = true`.
- **R4** `relay-state.test.ts`: each of running turn, pending ask, `jobs > 0` blocks exit; grace boundary ±1 ms; `cancelled` unstopped → `interrupted`; link stopped → exit now. *Mutation:* drop the `jobs` term.
- **R5** `run-state.test.ts`: `owner.json` round trip; unknown schema refused and byte-identical; `laptopProc` parse gives one token, zombie state read; dead pid and reused start time are stale (injected `ProcOf`); two takers, one winner. *Mutation:* store raw `lstart` → the start time is lost and a reused pid reads alive.
- **R6** `local-runtime.test.ts`: `release()` → session live, `attached: 0`, frames contain `session/detach`, never `session/close`. *Mutation:* `release = dispose`.
- **R7** `interactive: false`: `hooks/trust` declined, broker never called, notice. *Mutation:* hard-code true.
- **R8** `sessionId`: the saved record's id equals it; a second session gets a fresh one. *Mutation:* ignore it.
- **R9** `registry.test.ts` or `session-list` test: `jobs` counts running only; 0 with no controller. *Mutation:* count all.
- **R10** `engine-runtime.test.ts`: the existing `run` exec sequence is unchanged by `provisionWorkload`; provisioning alone opens no exec channel. *Mutation:* call `openExec` inside it.
- **R11** `relay.test.ts` (in-memory resident as in the probe, fake `EngineHost`):
  - `start`: prompt sent, record saved, at idle `session/detach`, never `session/close`.
  - A held ask keeps it alive, with no exit past the grace.
  - SIGTERM seam → `cancelled`, saved, exit.
  - Link stopped → `failed`.
  - *Mutations:* release → dispose; a second broker given to the runtime (the ask never reaches the policy, as the single-broker test).
- **R12** `main.test.ts`: `RELAY_SUBCOMMAND` dispatch pinned; each usage error before anything is created (`io.startEngineRuntime` not called); launcher success line carries `--resume <uid>`; the failure tail is sanitised (ESC in the log). *Mutation:* print the raw tail.
- **R13** `main.test.ts`: `attach` with a live holder → exit 1, no host built; a stale holder proceeds. *Mutation:* drop the guard.
- **R14** log writer: rotation at the cap, ESC never written raw. *Mutation:* skip `untrustedText`.

Iterate per file, then `bun run check` (AGENTS §4).

**Live test at the end of Execution** (Docker Desktop, isolated `TENTACLE_CONFIG_DIR`, compiled binaries, as the S1 rounds):
1. `run --detach --prompt … --auto-accept`: the launcher exits, the turn finishes with the terminal closed, the record is on the laptop, `attach --resume <uid>` shows it.
2. No auto-accept: `waiting-permission`, `attach` refused, `kill` → `cancelled`, saved.
3. `kill -9` the relay mid-turn: `attach --resume` proceeds.

Kubernetes is unverified unless a context authenticates (the umbrella's 401).

### S2b sketch (own doc; these TODO items are argued out of S2)

Neither item blocks the relay. Today both fail closed or loud, and no user sees the interval, since the release follows S3. S2 does make them more reachable, so they stay in the feature, not in the backlog.

- **"Report the resident's REAL version."** `residentStatus` reports its caller's `APP_VERSION` (`pod-resident.ts:536-561`), and `initialize` has no server version (`connection.ts:329-332`), though `host.identity.tentacle` exists (`serve.ts:433`). Fix: an optional `agentInfo.version` field in `InitializeResult` (free field), used by `residentStatus`. An older resident → "of an unknown version", which `busyVerdict` already words (`:730`). Run the status probe on `reuse` too, for the warning (`engine-runtime.ts:643-654`); it costs one exec per attach.
- **"Do not stop an idle resident before an install that cannot land."** S2 raises its cost: an idle resident can now hold a finished detached session. Fix: move the stop AFTER the install, not a writability probe. The install is `mv -f` over the path (`pod-binary.ts:290`), which works under a running binary, so nothing needs the old order, and a failed install then stops nothing. T10 "stopped BEFORE the replace" (`engine-runtime.test.ts:1332`) gets re-pinned to "stopped after a successful install; none after a failed one".
- **DR-5, DR-9.** As in the umbrella: pass `keepHint` regardless, have the relay arm `registerExitCleanup` and remove at normal exit, and the launcher remove on a failed start. The trap to pin: the launcher must never arm the net (`engine-runtime.ts:334`), or its own exit deletes the workload. `keep-awake.ts` per DR-9.

### Open questions for the owner

- **Q1. Split S2 into S2 + S2b?** (a) split, (b) one L branch. **Recommend (a):** two reviewable branches, same release.
- **Q2. A held ask has no answer until S3.** (a) keep DR-3's default, with `kill <pid>` as the way out; (b) refuse `--detach` without `--auto-accept` until S3; (c) pull hand-over into S2. **Recommend (a):** S2 is not released alone, and DR-3 stays intact.
- **Q3. `attach <name>` with no `--resume` during a live relay.** (a) refuse; (b) allow a fresh session beside it. **Recommend (a):** one rule, and it stays safe once `--keep=false` lands.
- **Q4. `run --detach --resume <uid>`.** (a) refuse in v1; (b) seed the relay's session. **Recommend (a):** the smaller surface; add it on demand.
- **Q5. Laptop save during a long turn.** (a) turn end only, like the TUI; (b) a periodic read-back in the relay. **Recommend (a) now:** a reboot in the first turn then loses the laptop copy, and S3 can still reach the pod's for 30 min; revisit after S3.

**Owner decisions (2026-10-30):** plan approved; Q1 (a) split, Q2 (a) hold + `kill`, Q3 (a) refuse, Q4 (a) refuse, Q5 (a) turn end only.

## Execution

*— claude-opus-5-5, 2026-10-30*

**Live test: NOT RUN, so the load-bearing assumption stays proven in-process only.** See "Live test" below. This is the one open gate before merge.

### As built, in order

1. **`ps` format** on this Mac: `LC_ALL=C ps -o stat=,lstart= -p 1` → `Ss   Mon Oct 26 00:15:29 2026`. It matches the plan, so no parsing change. `run-state.test.ts` pins this line, a padded single-digit day, and a real `laptopProc(process.pid)` read.
2. **Repro** (`.tentacle/tmp/detached-relay/repro.test.ts`): `exit 1`, `[error] unknown option --detach`.
3. **`jobs`**: `protocol/src/session.ts`, `schema/protocol.json`, `daemon/src/session-list.ts`, `hosted-session.ts:summary`. Two existing `session-list.test.ts` expectations gained `jobs: 0`.
4. **`tui/src/index.ts`** exports `autoApproves`, `ownRequest`.
5. **`local-runtime.ts`**: `interactive`, `sessionId`, `release()`, `sessionJobs()`.
6. **`pod-resident.ts`**: `lockHolder`; `residentStop` uses it.
7. **`engine-runtime.ts`**: `provisionWorkload`; `attachEngineRuntime` passes `interactive`/`sessionId`.
8. **New** `run-state.ts`, `relay-state.ts`, `relay-policy.ts`, `relay.ts`.
9. **`flags.ts`, `main.ts`**: flags, `detachFlagProblem`, USAGE, HELP, `RELAY_SUBCOMMAND` dispatch, the `run --detach` branch, the `attach` refusal.
10. **README** paragraph and the S2b line in `TODO.md`.

### Drift from the plan

| What | Why |
|---|---|
| R11 uses an `attach` seam (default `attachEngineRuntime`), not a fake `EngineHost` | The test wires `createLocalRuntime` over the real `SessionHost`/`Connection`/proxy model; the host is not what the test exercises. The real `attachEngineRuntime` path is therefore untested in the relay (Live test). |
| Jobs are polled every 30 s once the turn is over, not only while `jobs > 0` | A failed read at turn end would otherwise leave `jobs = 0` for good and let the relay exit with a job running. The poll is never awaited in the loop, so a pod that stops answering cannot pin it. |
| A failed `recordKept` is fatal AFTER provisioning | `recordKept` throwing is a warning inside `provisionWorkload`; the launcher notices no entry was recorded and stops with no relay. No new dep. The workload stays, and the existing warning says to remove it by hand. |
| `relayBlocking` takes `engine`; the text is a separate `relayBlockingMessage` | Pure and tested alone. |
| `lockHolder` returns the holder or `null` | `residentStop` keeps its own `pid === process.pid` check. |
| `laptopProc` tries `/proc` first, then `ps` | A Linux laptop has `/proc`; this reuses `procStat`. |
| `parseArgs`: a lone `-` is a value | `--prompt -` was "needs a value". Same rule positionals already had. |
| `LocalRuntime.createSession` returns `PersistingController` | The relay needs `ownsTurn`. It is the real return type, and the wider type fits every consumer. |
| `provisionWorkload` deps omit `permissions`/`saver`/`resume`/`notify` | It uses none of them. |
| `resolveKeep` moved before the image check, and `--prompt -` reads stdin before it | The usage errors need the effective `keep` and the prompt before anything exists. |
| State detail: a stopped turn ends `idle`; turn over with jobs is `running` + detail; anything still running at exit is written `interrupted` | The plan left these open. |
| **Added, not in the plan:** an unbound `ownsTurn` counts as not own; a stopped link keeps `failed` over a later turn end; the launcher ignores an `owner.json` of another `sessionId`; `attach` failure paths also release the lock | `ownRequest` with no test says "mine", so an ask racing the bind would have been auto-accepted. A name reused after `rm` leaves a stale `owner.json` that would have read as "started". |

**Known limit found:** a pod daemon redacts turn errors, so a model error shows in `owner.json` as `failed: internal error`, not the plan's `<detail>`. The laptop's own text should reach `relay.log` through `onPeerError` and the stderr sink, at teardown; that path is not covered by a test.

**Permissions:** `bun <script>` needs an approval I did not have, so `mutate.ts` (scratch) never ran. The mutations ran by hand with `sed` + `bun test` + `cp`.

### Stray `undefined/` directory (found after the first gate)

`config.jsonc` + `PROMPT.md` at the worktree root. Cause: my `relay.test.ts` restored with `process.env.TENTACLE_CONFIG_DIR = saved`, with `saved` undefined (the preload strips it). Assigning `undefined` stores the string `"undefined"`, so a later test in the same process scaffolded that relative dir. The product code was not at fault.

- Repro: removed it, full `bun test` → it came back (19:44).
- Red: new assertion → `Expected: undefined`, `Received: "undefined"`.
- Fix: delete the variable when `saved` is undefined (the pattern of `model-proxy.test.ts:211`). Directory removed; a full `bun run check` leaves none.

### Red → green

| Tests | Red | Green |
|---|---|---|
| R9 | `Expected: 1, Received: undefined` (and H1, H3 `jobs: 0`) | 19 pass |
| R6, R8 | `runtime.release is not a function`; `sessionJobs` same; R8 `Expected to contain "2222…", Received [random ids]` | 22 pass |
| R7 | `expect(received).toEqual` on `{trusted}` | 27 pass |
| R10 | Compile error only (`provisionWorkload` not exported) | Property shown by mutation |
| R1–R5, R14 | Compile error only (modules missing) | 38 pass; property shown by mutation |
| R11 | Written with the module, no separate red run | 17 pass; property shown by mutation |
| R12, R13 | 13 `(fail)` in `main.test.ts` on the assertions | 54 pass |

### Mutations

`cp` backup in `.tentacle/tmp/detached-relay/backup/`, restored by `cp` only. Every `shasum` after restore equals the one before: `relay-policy c9c36db1`, `relay-state 90564fc2`, `run-state 27f8695b`, `relay fed26950`, `local-runtime d82411c2`, `main d0fc5cfc`, `engine-runtime de3521e2`, `hosted-session ea0cf9e1`.

| Mutation | Failed test(s) |
|---|---|
| R1 answer `allowed: true` | R1 + 2 R3 |
| R2 `scope: "session"` | R2 |
| R3 `autoApproves(req, true)` | R3 foreign turn |
| R3 unbound `owns = true` (added) | R3 foreign turn |
| R3 drop `autoApproves` (added) | R3 hooks trust |
| R4 drop `jobs` term | job blocks the exit |
| R5 raw `lstart` | 4, incl. `laptopProc` lock read-back |
| R6 release closes | R6 |
| R7 hard-code `interactive: true` | R7 |
| R8 ignore `sessionId` | R8 + `sessionJobs` |
| R9 count all | R9 |
| R10 `openExec` inside provisioning | R10 |
| R11 `release` → `dispose` | 2 |
| R11 second broker | 3 |
| R11 stop does not cancel (added) | held ask |
| R12 raw tail | R12 + log tail |
| R12 dispatch dropped | dispatch |
| R13 guard dropped | live holder |
| R14 skip `untrustedText` | sanitised line |
| R14 no rotation (added) | rotation |

20 of 20 killed. The first run of the `hooks_trust` test proved nothing: with no `turnId` it was held as foreign. It now passes `turnId` and is killed by its own mutation.

### Live test

**Not run; nothing was routed around.**
- Launching `dist/tentacle` directly: "This command requires approval".
- `cp ~/.config/tentacle/config.jsonc`: needs approval, outside the session's directories. So no model config either.
- No `tentacle-dr2-*` container was created. `docker ps -a` shows none.

What did work: `TARGET=bun-linux-arm64 bun run compile` and `bun run compile`, both with `version marker 0.2.0 ok`. The Linux binary is at `.tentacle/tmp/detached-relay/tentacle-linux-arm64`, the macOS one at `dist/tentacle` (gitignored). x64 was not built. The isolated config dir was deleted, empty.

**Unverified, and how to verify:** a real exec and a compiled relay, i.e. surviving the launcher, `selfCommand()` + `__relay` in a binary, the real `attachEngineRuntime`, `owner.json`/log on disk, idle exit, the `attach` refusal between processes, `kill`/`kill -9`, multi-process lock contention. Run the three steps of "Live test at the end of Execution" above, with `TENTACLE_POD_BIN` set to the Linux binary and a model config in an isolated `TENTACLE_CONFIG_DIR`. Kubernetes is unverified too.

### Gate

`bun run check`, final tree: typecheck clean, lint 0 (565 files), **3622 pass, 3 skip (the opt-in ones), 0 fail**, 13057 `expect()`, 264 files.

## Review

*— claude-opus-5-5, 2026-10-30* (fresh context; SAME model as the executor: shared blind spots survive both passes)

**Verdict: REQUEST-CHANGES (a small fix round, then the live test).** The relay's design and its §7 behaviour hold up, and no finding is a production-breaking bug. But the two properties this slice can lose silently are not pinned (F1, F2: both mutations survived), and one explicit on-disk rule is broken (F3). The live test stays the merge gate: the load-bearing assumption is still proven in-process only.

### Findings

| # | Severity | Where | What |
|---|---|---|---|
| F1 | **Medium** (test gap on a named §7 trap) | `packages/cli/src/main.ts:878`, test `packages/cli/test/main.test.ts:545` | **Nothing pins "the launcher never arms the exit net".** Mutation: `...workloadDeps, keepHint: undefined` in the detach call. In real code that arms `registerExitCleanup` (`engine-runtime.ts:339`), so the launcher's own exit deletes the workload. `main.test.ts` + `engine-runtime.test.ts`: 122 pass, 0 fail. The stub ignores `deps` and calls `recordKept` by itself. Fix: assert the stub received a `keepHint`, and that `recordKept` fired through it. The code is correct today. |
| F2 | **Medium** (test gap, DR-4) | `packages/cli/src/relay.ts:238-245` | **Nothing pins "a running job keeps the relay alive".** Mutation: `pollJobs()` never called. `relay.test.ts` + `relay-state.test.ts` + `local-runtime.test.ts`: 50 pass, 0 fail. R4 pins the reducer and R6/R9 the read, but not the wire between them, nor drift row 2 (the 30 s re-poll after a failed read). Fix: an R11 case with a running job and a short `jobsPollMs`: no exit past the grace, exit once it ends, and a failed first read recovers. |
| F3 | **Low–Medium** (§7 on-disk rule) | `packages/cli/src/relay.ts:125` | **The relay overwrites an unknown `owner.json`.** Real `__relay` process, file `{"schemaVersion":99,"future":true}`: after the run it is `schemaVersion: 1`. AGENTS §7 and the plan say refused and left untouched; the plan says "never rewritten". `run-state.test.ts:96` pins the read path only. Reach: a name reused after `rm` by an older CLI. Fix: at start, `readOwner` `unknown` → refuse (the launcher already prints the tail), or have the owner relax the rule in the plan. |
| F4 | **Low** (pod not trusted) | `packages/cli/src/relay-state.ts:103` | **`status.reason` reaches `owner.json` unsanitised.** `terminalReason` embeds `error.message` (`link-machine.ts:87-94`), and a `VersionMismatch` frame's text is pod-supplied. Probe: `detail` holds a raw `ESC ]0;…BEL`. Nothing prints `detail` today and JSON escapes it on disk, so no terminal is reached; S3/S4's `ps` would. `turn_failed` is sanitised, this path is not, and the §7 table claims all of it. Fix: `untrustedText` at the emit. |
| F5 | **Low** (failure mode missing) | `packages/cli/src/main.ts:896-897`, `packages/cli/src/relay.ts:341`, `:293` | **A sync failure after provisioning escapes `main`.** `ensureRunDir`, `writeSpec` or `openSync` throwing (EACCES, ENOSPC) comes after the workload exists and sits outside the `try`, so the user gets a rejection, not the "stays up / `rm`" line. Not in the table. |
| F6 | **Low** | `packages/cli/src/run-state.ts:326` | **`appendFileSync` is unguarded,** so `runRelay`'s "Never throws" (`relay.ts:98`) is false on a full disk: a throw inside `emit` from `drive`'s catch, a signal handler or a requester dies uncaught, or leaves the ask unanswered. Same-moment failure as "Save fails". |
| F7 | **Nit** (doc) | Failure modes, row "`allow_once` not offered"; `engine-runtime.ts:742` | "Visible in the log" holds only at teardown: `onPeerError` goes to the buffered sink, and `owner.json` says `running`, not held. The doc's other limit says so for model errors, not here. |
| F8 | **Nit** (UX) | `packages/cli/src/engine-runtime.ts:310` | The launcher first prints `kept <name> — resume with: tentacle attach <name>`, with no `--resume`. Followed literally it is refused now and opens a fresh session later (D5). The second line is right, the first contradicts it. | *(Superseded by feat/run-prompt: the line is now `[<noun>] <name> still running · removed when the run ends · tentacle attach <name>`.)*
| F9 | **Nit** (false premise, doc) | Failure modes, row "Killed during the FIRST turn" | "`--resume <uid>` is fatal (`session-resume.ts:60`)" cites the *invalid id* branch. A valid uid with no record printed `[resume] no session …; starting fresh`. So after a `kill -9` in the first turn the user silently gets an empty session. Correct the row, and word the limit that way. |

### Gate

`bun run check`: typecheck clean, lint 0, **3622 pass, 3 skip (the opt-in ones), 0 fail**, 13057 `expect()`, 264 files. Matches Execution. It ran before the mutations; the three mutated files restored byte-identical (below). No stray `undefined/`.

### Mutations

`cp` backup in `.tentacle/tmp/detached-relay/review-backup/`.

| Mutation | Origin | Outcome |
|---|---|---|
| R2 `scope: "session"` | executor | killed: R2 (1 fail) |
| R11 second broker | executor | killed: 3 fail |
| R13 guard dropped | executor | killed: live holder (1 fail) |
| `keepHint: undefined` to the launcher's `provisionWorkload` | mine | **SURVIVED** → F1 |
| `pollJobs()` never called | mine | **SURVIVED** → F2 |

`shasum` before = after: `relay-policy c9c36db1`, `relay fed26950`, `main d0fc5cfc`. These also equal the hashes in Execution.

### Premise table

Line numbers against `main` a4ddda0 where the diff moved them.

| Premise | Result |
|---|---|
| Symptom: `--detach` unknown on `main` | TRUE by reading: `flags.ts` on `main` has no `detach` option, only 4 unrelated matches. **The repro itself was not re-run on `main`:** this worktree carries the change. |
| Client answers `model/stream*`, `hooks/trust` (`remote-client.ts:953-963`) | TRUE |
| `release` cancels only when the last serving link leaves (`connection.ts:139-146`) | TRUE |
| Reopen of a live id does not recreate it (`session-host.ts:362-365`) | TRUE |
| P4 `dispose` closes (`local-runtime.ts:376-382` on `main`) | TRUE |
| P5 lock + `<pid> <start>` split on spaces (`pod-resident.ts:168-174`, `:226-280`) | TRUE; also fails closed: a `ps` failure reads as alive (`holderAlive`), so `attach` is refused, never let through |
| P8 router (`permission-router.ts:131-133`, `:199-207`) | TRUE |
| P9 `interactive: false` → declined + notice (`hooks-trust.ts:175-181`) | TRUE |
| P10 terminal reasons (`link-machine.ts:85-97`) | TRUE; this is where F4 starts |
| P11 kept index skips non-`*.json` (`kept-index.ts:83-86`) | TRUE |
| P13 `openTuiSessions` (`tui-sessions.ts:48-66`) | TRUE |
| Row "first turn": `--resume <uid>` fatal (`session-resume.ts:60`) | **FALSE** for a valid uid → F9 |
| D5: plain `attach` opens a fresh session | TRUE by reading: `resume` is `sessions.resume` (`main.ts:908` on `main`), null with no flag |

### Failure modes

"Unit" is a pure-module test, "R11" a relay-level one, "by reading" only that.

| Row | Implemented | Tested |
|---|---|---|
| Mac sleeps | yes | unit (`cancelled` → `interrupted`); **live** |
| Link down long | yes (decision) | no test needed |
| SIGKILL / reboot | yes | unit + my real-process run; **live** |
| Killed during first turn | stated limit | see premise table |
| Two relays | yes | R11, injected `procOf`; **live** |
| Relay vs TUI | yes | R13 + my real-process run |
| Provisioning window, two locations | accepted | none needed |
| Held ask | yes | R11 |
| Auto-accept | yes | R1–R3, R11 |
| `allow_once` not offered | yes | **no relay test** (F7) |
| Project hooks | yes | R7 |
| Version skew | yes | unit, generic link-stop |
| Workload deleted | yes | R11 generic link-stop; **live** |
| Pod restarted | by reading | **no relay test** |
| Model error | yes | R11 |
| Launcher: dies, slow | yes | `launchRelay` tests |
| Save fails | by reading | **no relay test** |
| Unknown or corrupt `owner.json` | read yes, write **no** | F3 |
| Empty prompt | yes | R12 |
| Job never ends, unreadable `jobs` | by reading | **no relay test** (F2) |
| Pod floods | yes | R14 |

### Attacks tried

1. **A real zombie on this Mac.** `Z    Fri Oct 30 19:55:13 2026` parses to state `Z`, start one token: the holder is dead. Holds.
2. **`attach` between real processes** (`bun test` scratch spawning `main.ts`; a live `sleep` as holder, its start time taken outside `bun test`). Refused with and without `--resume`, no dial. A wrong start time and a dead pid both proceed. Holds. My first run looked like a failed refusal: `bun test` forces UTC in-process while `ps` prints local time. That was the harness, not the code.
3. **Real `__relay` process** (Docker socket absent): spec read and unlinked, `owner.json` `failed`, sanitised log, lock tombstoned, exit 1. Found F3.
4. **Global flags lost across the process boundary.** Only `--profile` exists, and it is in the spec. Nothing found.
5. **Stem mismatch** launcher ↔ relay: `keptFileName` hashes location + name, and the on-disk entry gives the same stem. Holds.
6. **`--engine` alias bypassing `relayBlocking`:** `parseEngine` accepts exact names only. Holds.
7. **Auto-accept reaching a laptop gate:** the only non-tool `broker.request` is `hooks_trust`, refused by `autoApproves` and unreachable (P9). Holds.
8. **Second writer through another path** (`attach <other> --resume <uid>`, `tentacle --continue`): not refused, but a record exists only after the one turn ended, and the relay then writes only a late title. Negligible, and the §7 row "one writer per uid" is slightly wider than the check.
9. **`jobs` counting across sessions:** the controller comes from `createAgent` per session (`session-host.ts:771`). Holds. `MAX_SESSION_LIST` is 200, and a pod with more sessions only gets `null`, so the relay exits early: no laptop effect.
10. **Unvalidated `session/list` result:** `call` casts it, so a hostile pod can send a non-number `jobs`. It can only steer the relay's lifetime. Accepted.

**Not proven:** `ps`/`Date.parse` staying equal across shells with different `TZ`. By reasoning both use the same zone in one process, so the instant is stable. A difference would read as stale and let `attach` through. `bun <script>` needs an approval I did not have, so it went to the live checklist. Note that my scratch `bun test` files spawned `main.ts` as a child, before I saw that `bun <script>` is gated; they touched only a scratch `TENTACLE_CONFIG_DIR`.

### §7 invariants

| Invariant | Result |
|---|---|
| Single broker | Holds: one instance, second-broker mutation killed. |
| Model on the laptop | Holds: `laptopModels` in the relay; the spec has no secret. |
| Pod not trusted | Holds except F4. `once`, own turns, unbound `ownsTurn` = not own, no trust store. |
| Pod daemons never persist | Unchanged. |
| No raw terminal writes | Holds: no Ink here, launcher plain lines, relay stdout a file. |
| Don't serialize the peer | Holds: the poll is unawaited, a held ask is a pending promise. |
| Pod lifecycle | Code holds, unpinned (F1). `__relay` pinned. |
| Protocol | Holds: `jobs` optional, strip schema, `PROTOCOL_VERSION` stays 14 rightly (§7 "fields are free"), schema regenerated. On-disk: F3. |

**Drift:** Execution's table has **12 rows, not 11**: the last bundles four additions. All are justified. Rows 1 and 2 carry the risk: row 1 is why the real `attachEngineRuntime` is unproven in the relay, and row 2 is F2. The Implementation text still says "every 30 s while `jobs > 0`": the drift row records it, the plan was not edited.

**Prior art:** the two `Detach S2` TODO items are carried to S2b. Neither blocks this slice.

### Live test checklist (orchestrator)

Docker Desktop, compiled `dist/tentacle`, `TENTACLE_POD_BIN` = the Linux binary, isolated `TENTACLE_CONFIG_DIR` with a model config. Kubernetes stays unverified.

1. `run --detach --prompt … --auto-accept` returns exit 0 with its started line: pid, `attach <name> --resume <uid>`. The `kept <name> — resume with:` line before it carries the same `--resume <uid>` (fix round 1, F8). No TUI.
2. **After the launcher exits the container is still running**, with no delete child (F1's property, for real).
3. The relay is its own session (`ps -o pid,ppid,sess`) and survives the launcher's terminal being closed.
4. `selfCommand()` + `__relay` works in the compiled binary; `spec.json` is gone; run dir 0700, files 0600.
5. A turn with two tool calls: two `auto-accepted (once)` lines in `relay.log`, `owner.json` `running` → `idle`.
6. The laptop record exists under `sessions/<projectKey(cwd)>/`. The model key appears neither in the container (`docker exec … env`) nor in the relay's argv.
7. The relay exits about 60 s after idle; the resident stays up.
8. `attach <name> --resume <uid>` from the same folder shows the history in the same live session (detach, not close).
9. No auto-accept: `waiting-permission (<tool>)`, still there past 60 s, tool not run.
10. While it lives, `attach <name>` with and without `--resume` is refused, naming pid and state, with nothing dialled.
11. `kill <pid>`: exits within about 5 s, `cancelled`, saved, session still live; `attach --resume` works.
12. `kill -9` mid-turn: the pod cancels the turn, `attach --resume` proceeds. With no first save, it starts fresh: confirm what the user sees.
13. A prompt that starts a background `sleep 120`: the relay stays past 60 s, then leaves about 60 s after the job ends (F2's property, for real).
14. `docker rm -f` during a turn: `failed`, gone reason, exit 1, no grace; run dir stays.
15. A broken model key: `failed`, exit after the grace. Check whether the laptop's text reaches `relay.log` (the known limit).
16. A relay dying at start: sanitised tail, exit 1, workload up, `rm` works.
17. A second relay started by hand on the same run: exit 1, first `owner.json` untouched.
18. `rm`, then `run --detach` with the same name: the stale `owner.json` is ignored.
19. `attach` from a shell with another `TZ` while the relay lives: still refused.
20. A mounted project with hooks: not run, notice in `relay.log`.

### How the executing model behaved

**Grade: B.** The work is careful. It proved the assumption before building, the plan's premises check out, and every number I re-ran matched (gate, hashes, mutations). It reported honestly: the live test as not run, with no route around the approvals; compile-only reds labelled as such; its own stray `undefined/` traced and fixed. It also added real hardening nobody asked for (unbound `ownsTurn`, another run's `owner.json`). Not an A because its mutations killed what the plan listed, and it did not attack what the plan named as the trap: the exit net and the job hold, its own drift row 2, were left unpinned. And the "never rewritten" and sanitising claims were stated for all paths, while each was checked on one. Same model as this reviewer: treat this grade, and the review, as one family's view.

## Execution — fix round 1

*— claude-opus-5-5, 2026-10-30*

All nine findings are fixed; none is disputed. **The live test was not run (the orchestrator runs it), so the load-bearing assumption stays proven in-process only.**

### Per finding

| # | Change | Test | Red → green |
|---|---|---|---|
| F1 | No code change: the code was right, the pin was missing. `detached`'s stub now applies the real gate (`deps.keepHint` before `recordKept`). | `main.test.ts:641` runs `main` through the REAL `provisionWorkload` over a fake host whose `waitForReady` fails. It asserts no new `exit` listener, nothing removed, and the `kept` line. | A test gap, so green on the correct code. Red by mutation (below). |
| F2 | No code change: same. | `relay.test.ts:364`: `sessionJobs` reads `null`, then 2, then 0. Failed first read recovers, no exit across three grace jumps, exit after the job ends. | Green on the correct code. Red by two mutations (below). |
| F3 | `relay.ts:117-121`: under the lock, `readOwner` `unknown` → log naming the file, lock released, exit 1, nothing written or dialled. | `relay.test.ts:341`: `schemaVersion: 99` and a corrupt file stay byte-identical, then a clean run starts. | Red: `Expected: false, Received: true` (it dialled). Green. |
| F4 | `relay-state.ts:104`: `untrustedText` on the reason, in the reducer: one site, and the pure test reaches it. The review said "at the emit"; the property is the same. | `relay-state.test.ts:36` | Red: `Received: "skew \u001B]0;pwned\u0007 x"`. Green. |
| F5 | `relay.ts:359-368`: `launchRelay` makes the run dir itself, and catches the dir, spec and spawn failures: the sanitised error, then the same `failed()` lines, exit 1. `main.ts` passes `runDirFor(…)`, and `ensureRunDir` left its imports. | `relay.test.ts:545` (the spawn throws), `:564` (the run dir cannot be made: no spawn). | Red: both rejected out of `launchRelay`. Green. |
| F6 | `run-state.ts:326-331`: the append is guarded. `relay.ts:99`'s "Never throws" now says what is true: a run dir it cannot make still throws, and `relayMain` catches that. | `run-state.test.ts:250` | **The first red was a `ReferenceError`** (`rmSync` not imported), so it proved nothing. Import fixed, red on the property by mutation (below). |
| F7 | Failure modes row corrected. | Doc only. | n/a |
| F8 | `main.ts:880`: the detach call gives `provisionWorkload` a `keepHint` with `--resume <uid>`, so `sessionId` now exists before provisioning. No change to `engine-runtime.ts`. | `main.test.ts:635` | Red: `Expected: "…c1 --resume aa49…", Received: "…c1"`. Green. |
| F9 | Failure modes row corrected: no fatal, `session-resume.ts:79` prints `starting fresh`. | Doc only. | n/a |

**Also done from the review:** the plan's "every 30 s while `jobs > 0`" (Design step 8) now says what was built. New failure-mode rows: launcher sync failure, log write failure, unknown `owner.json` at relay start. Checklist item 1 updated for F8, because the `kept` line changed.

### Consequences of these fixes

- **F3:** the run dir outlives `rm`, so an unreadable `owner.json` keeps that name at that location refused until the user removes the file. The launcher's tail names the file. The rule asked for this; S4's cleanup should cover it.
- **F8:** a provisioning that fails also prints `--resume <uid>` for a session that never started. Following it gives `starting fresh`, which is what a plain `attach` would do anyway.
- **F5:** a spawn that fails leaves `spec.json` (0600, no secret) in the run dir. The next run overwrites it. Left as is.
- **F7:** the limit is only worded, there is still no relay test for `unoffered`.

### Mutations

`cp` backup in `.tentacle/tmp/detached-relay/fix1-post/`, restored by `cp`. **9 of 9 killed**, including both review survivors.

| Mutation | Failed test(s) |
|---|---|
| **F1** `keepHint: undefined` in the detach call (review survivor) | 3 of `main.test.ts`, incl. the exit-net test: `removed` = `["remove:box", "besteffort:box"]`, the real net fired |
| **F2** `pollJobs()` never called (review survivor) | the job test (timed out on the first read) |
| F2 no re-poll (`nextPoll` = max) | the job test (the job is never seen) |
| F3 refusal dropped | the `owner.json` test |
| F3 lock not released on refusal | the `owner.json` test (the clean run never starts) |
| F4 raw reason | the sanitised test |
| F5 the catch rethrows | both launcher tests |
| F6 guard dropped | the log test |
| F8 hint with no `--resume` | the started test |

`shasum` before = after every restore, and again after a re-run of F1 to read its message: `main 6b957899`, `relay 7aaaec7e`, `relay-state 6a59437b`, `run-state 04501f40`.

**Tooling:** `bun x biome` and `python3 <script>` need an approval I did not have, so formatting went through `bun run lint` and a hand edit, and the mutations through `sed` + `bun test` + `cp`.

### Gate

`bun run check`, final code: typecheck clean, lint 0 (565 files), **3629 pass, 3 skip (the opt-in ones), 0 fail**, 13086 `expect()`, 264 files. That is the 3622 of before plus 7 new tests. No flake needed a re-run. No stray `undefined/`.

## Review — fix round 1

*— claude-opus-5-5, 2026-10-30* (fresh context; SAME model as the executor and the first review: shared blind spots survive all three passes)

**Verdict: READY-FOR-LIVE-TEST (APPROVE-WITH-NITS).** F1–F9 are fixed and every code fix is pinned. One new Low finding, F10, is a wording fix to bundle before merge; it does not affect the live test. **The live test was not run, so the load-bearing assumption stays proven in-process only, and it remains the merge gate.**

### Findings

| # | Severity | Where | What |
|---|---|---|---|
| F10 | **Low** (UX, F3's side effect) | `packages/cli/src/relay.ts:118`, `:355` | **The F3 refusal names the file but not the fix, and the only way out it offers does not work.** Real launcher + real `__relay` over `{"schemaVersion":99,...}`: `… owner.json is not readable by this version: left untouched`, then `stays up: \`tentacle attach box\`, or \`tentacle rm box\``. `rm` drops only the kept entry (`kept-cmd.ts` never touches the run dir). With that entry forgotten and recorded again, as `rm` then the same name would leave it, the next start is refused with the same lines. Fix: end the log line with `remove it, or use another name`. No code path changes. Pin it with a `toContain` in `relay.test.ts:355`. |

### F1–F9

| # | Result |
|---|---|
| F1 | Fixed: pinned through the real `provisionWorkload`, `main.test.ts:641`. Mutation killed. |
| F2 | Fixed: `relay.test.ts:364` covers the hold, the failed first read and the job's end. Mutation killed. |
| F3 | Fixed: real process, file byte-identical, `spec.json` consumed, nothing dialled, exit 1. Mutation killed. Side effect: below. |
| F4 | Fixed: `relay-state.ts:104`, the only site. Mutation killed. |
| F5 | Fixed: `launchRelay` catches the three failures. My mutation on the moved `ensureRunDir` was killed. |
| F6 | Fixed: `run-state.ts:326-331`. Not re-mutated. |
| F7, F9 | Doc rows corrected and match the code (`session-resume.ts:79` is the `absent` branch). |
| F8 | Fixed: `main.ts:880`, pinned at `main.test.ts:636`. Not re-mutated. |

### F3's side effect: judgement

- **Does it break "refused and left untouched"? No.** It IS that rule. The file stays byte-identical, and a human removes it. Renaming it aside or overwriting it would be the violation.
- **Acceptable for S2? Yes.** The block needs an explicit name reused at the same location over a file this build cannot read. Writes are atomic, so a crash cannot produce one; the realistic trigger is a later `RUN_STATE_VERSION` bump or a downgrade. Other names are unaffected, `attach` is unaffected, and the cost is one idle workload, which the launcher says stays up.
- **Clear message? Half.** It names the file, not the fix, and points at an `rm` that does not help (F10). The Execution note "the launcher's tail names the file" is true but not sufficient.
- **Recommendation to the owner: keep the refusal, fix the wording (F10), leave the cleanup to S4.** Do not relax the rule for this file, and do not add a pre-provisioning check: it would add a code path for a rare case.

### Gate

`bun run check`: typecheck clean, lint 0 (565 files), **3629 pass, 3 skip (the opt-in ones), 0 fail**, 13086 `expect()`, 264 files. Matches Execution. It ran before the mutations, and the tree after them is hash-identical. No stray `undefined/`.

### Mutations

`cp` backup in `.tentacle/tmp/detached-relay/fix1-review/`. **5 of 5 killed.**

| Mutation | Origin | Outcome |
|---|---|---|
| F1 `keepHint: undefined` in the detach call | executor | killed: 3 fail, incl. the exit-net test |
| F2 `pollJobs()` never called | executor | killed: the job test timed out on the first read |
| F3 refusal dropped | executor | killed: it dialled |
| F4 raw reason | executor | killed: the sanitised test |
| `writeSpec(dir, spec)`, the launcher no longer makes the run dir | mine | killed: 2 fail in `main.test.ts` |

`shasum` before = after: `main 6b957899`, `relay 7aaaec7e`, `relay-state 6a59437b`, `run-state 04501f40`, `relay-policy c9c36db1`. The first four equal the hashes in Execution.

### Attacks tried

1. **Real launcher + real `__relay` over an unknown `owner.json`.** Refused, untouched, clean exit 1, and refused again on the same name. Found F10.
2. **`--detach --keep=false`:** the F8 wrapper always defines `keepHint`, so it would disarm the net and print `undefined --resume …`. Unreachable: `detachFlagProblem` refuses it (`flags.ts:170`). Holds.
3. **A rejecting `sessionJobs`:** `polling` would stay true for good. The method catches and returns `null` (`local-runtime.ts:414-421`). Holds.
4. **F3 refusal leaking the lock:** `release` is guarded, and the test's clean run after the refusal proves it free. Holds.
5. **"Only a run dir it cannot make throws" (`relay.ts:99`):** the lock is inside the `try`, `record` and `log` are guarded, `release` is guarded. Holds by reading.

**Execution claims:** the cited lines, the test counts and the 7 new tests check out. F6 and F8 mutations and the four others were not re-run; this was a short review by request. The failure-mode rows and Design step 8 were updated as stated. The first review's premise table was not redone: the fix round moved no premise.

### How the executing model behaved (fix round)

**Grade: A.** All nine findings were fixed with the smallest change, and two test gaps were closed with no code change, which was the right call. Every number I re-ran matched: gate, hashes, mutations. It reported honestly: it called its own `ReferenceError` red worthless and redid it, said the live test was not run, and did not route around the approvals it lacked. It also listed the consequences of its own fixes unprompted, which is how F10 surfaced. The one miss is that it noted the F3 block and still left the user without the way out. Same model as this reviewer: treat this grade as one family's view.

## Execution — F10 + live test

*— claude-opus-5-5, 2026-10-30*

F10 is fixed. **The live test is incomplete: 13 of 20 PASS, 2 partial, 5 not run, 0 FAIL.** The load-bearing assumption is proven live up to a running turn. A turn that completes, with tool calls, was never seen, because the model endpoint was unreachable. The merge gate stays open on items 3, 5, 7, 8, 9, 13 and 17.

### F10

| Where | Change |
|---|---|
| `packages/cli/src/relay.ts:119` | The refusal ends with `left untouched, delete that file to run under this name`. It already named the file. |
| `packages/cli/src/relay.ts:359` | `launchRelay`'s `failed()`: on an `unknown` `owner.json`, `, or delete <path> to run under this name` replaces `tentacle rm`. |
| `packages/cli/src/run-state.ts:148` | **Drift, not in the review's fix.** `readOwner` treats `ENOTDIR` as `none`. See below. |
| `packages/cli/test/relay.test.ts:355-358`, `:610` | The refusal line pinned, and a new launcher test over a future version and a corrupt file. |

**Red → green.** Red on the property: `Expected to contain: "delete that file to run under this name"` and `Expected to contain: "delete …/owner.json to run under this name"`, Received the old `or \`tentacle rm box\`` line. 20 pass, 2 fail. After the fix, `relay.test.ts` + `run-state.test.ts`: 45 pass, 0 fail.

**Drift.** The first gate failed `the run dir cannot be made` (3629 pass, 1 fail): with a file on the run dir's path, `readOwner` answers `unknown` on `ENOTDIR`, so the new branch wrongly hid `rm`. No record can exist there, so `none` is the true answer. That existing test pins it.

**Gate** (`bun run check`, final code): typecheck clean, lint 0 (565 files), **3630 pass, 3 skip (the opt-in ones), 0 fail**, 13098 `expect()`, 264 files. No mutation was run for F10: the red above is on the unfixed code.

### Live test

Docker Desktop (`linux/arm64`, 29.1.3), image `node:22`, `dist/tentacle` 0.2.0 built from this tree. `<T>` = `TENTACLE_CONFIG_DIR=…/cfg …/dist/tentacle`.

**What limited it:**

- **Model unreachable.** A plain one-shot prompt on the laptop, with no pod and no relay, fails: `model connection lost before any event was delivered (ETIMEDOUT), gave up after 3 attempt(s)`. The TUI status bar names a local Qwen model, so its server was probably down. I did not open the config. Every turn therefore stayed `running` for about 3m46s and then failed, with no model reply and no tool call.
- **Approvals.** These were refused here and not routed around: `script` (so no TTY), a second env var before the binary (`TENTACLE_POD_BIN`, `TENTACLE_RELAY_SPEC`), `curl`.
- **Drift from the checklist.** `TENTACLE_POD_BIN` was not used. A release build's preflight then needs both targets, so `tentacle-bun-linux-arm64` and `-x64` went into `cfg/bin/`. The arm64 one was injected.

| # | Command | Result | Verdict |
|---|---|---|---|
| 1 | `<T> run --detach --prompt … --auto-accept --engine docker --no-mount --image node:22 tentacle-dr2-a` | Returns with no TUI. `kept … --resume bf3990fe-…`, then `detached run started (pid 61480) … --resume bf3990fe-…`: same uid. Exit 0. | PASS |
| 2 | `docker ps`; `pgrep -fl tentacle` | `tentacle-dr2-a Up 8 minutes`, long after the launcher left. No delete child. | PASS |
| 3 | `ps -o pid,ppid,sess,pgid,tty,etime,command -p 61480`; `script …` refused | `PPID 1`, `PGID 61480` = its pid, tty `??`. macOS prints `SESS 0`, so the group is the evidence. It outlived its launcher by minutes. **The launcher had no terminal to close.** | PARTIAL |
| 4 | `ps`; `ls -la <run dir>` | `dist/tentacle __relay` ran, compiled. Dir `drwx------`, `owner.json`, `relay.log`, `.lock.1` `-rw-------`. `spec.json` gone. | PASS |
| 5 | Two tool calls | No turn reached a tool. | NOT RUN (model) |
| 6 | `ls -laR cfg/sessions`; `docker exec … env`; `ps` | Record `sessions/detached-relay-2272120fc8be/f67bf49e-….json` 0600, written by the SIGTERM save, not by a finished turn. The env has PATH, HOSTNAME, NODE_VERSION, YARN_VERSION, HOME only. The argv is `tentacle __relay`. | PASS |
| 7 | `relay.log` of run a | The grace ran on a `failed` turn: 22:30:48 → 22:31:49, 61 s, then the resident stayed up. The same tick branch, **but not an `idle` turn**. | PARTIAL |
| 8 | Attach from the same folder, detach | Needs a finished turn and a TTY. Item 11's attach rendered the history up to the TUI's raw-mode error. | NOT RUN (model, TTY) |
| 9 | Held ask past 60 s | No turn reached a tool ask. | NOT RUN (model) |
| 10 | `<T> attach tentacle-dr2-b`, and with `--resume f67bf49e-…` | Both exit 1: `a detached run owns it (pid 61863, running). Wait for it, or \`kill 61863\` to stop it, then …`. Nothing dialled. | PASS |
| 11 | `kill 61863`; `ps`; `<T> attach … --resume … < /dev/null` | Sent 22:36:23, gone 22:36:24. `turn end: cancelled`, `owner.json` `idle` (by design, `relay-state.ts:74-78`), saved, resident pid 120 the same. Attach printed `[resume] f67bf49e-… — Reply OK.` and the history; **then Ink stopped on raw mode, because there was no TTY.** | PASS |
| 12 | `kill -9 61909`; `<T> attach … --resume …` | `owner.json` stays `running`. The dead pid does not refuse the attach. The user sees `[resume] no session "96400a26-…"; starting fresh`. The resident logs `error: connection closed`. | PASS |
| 13 | Background `sleep 120` | Needs a tool call. | NOT RUN (model) |
| 14 | `docker rm -f tentacle-dr2-a` | Sent 22:37:10. `failed`, `the connection target is gone: container "tentacle-dr2-a" no longer exists` at 22:37:11, `relay exit` under a second later, no grace. Run dir stays. The exit code is not visible on a detached process: inferred from `failed` (`relay.ts`, `leave`). | PASS |
| 15 | Run a, on the unreachable model, not a broken key | `failed internal error`, exit 61 s later. **The laptop's text does reach `relay.log`, at teardown:** `[laptop rpc] model connection lost … ETIMEDOUT`. So `owner.json` holds only `internal error`. | PASS |
| 16 | `{"schemaVersion":99,…}` over b's `owner.json`, then `<T> run --detach … tentacle-dr2-b`; `<T> rm -f` | Exit 1, tail, workload `Up 6 seconds`, file byte-identical, `rm` works. F10 live: `left untouched, delete that file to run under this name`, then `` stays up: `tentacle attach …`, or delete …/owner.json to run under this name ``, no `rm`. The tail is mostly the previous run's lines. | PASS |
| 17 | `TENTACLE_RELAY_SPEC=… <T> __relay` | Refused by the approval layer. `relay.test.ts:316` covers it in-process only. | NOT RUN (approval) |
| 18 | `<T> rm -f tentacle-dr2-b`, then `<T> run --detach … tentacle-dr2-b` | `detached run started (pid 61909)` with a new uid, over the old `idle` `owner.json`. | PASS |
| 19 | `TZ=Asia/Tokyo <T> attach tentacle-dr2-b` | Refused, same message. | PASS |
| 20 | `.agents/hooks.json` with `turn_start: touch hook-ran`; `<T> run --detach … --confirm-mount … tentacle-dr2-c` from that folder | `project hooks of …/proj not run: no one to ask (non-interactive)`. Mount present, no `hook-ran`. | PASS |

**To finish:** with the model server up and a TTY, run 3, 5, 7, 8, 9, 13 and 17. Item 17 also needs the second env var approved.

### Cleanup

Relays 61480, 61863, 61909, 61930 and 61969 are gone, the last by `kill`. `pgrep -fl __relay` → `no-relay-left`.

```
$ docker ps -a --filter name=tentacle-dr2
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ ls …/.tentacle/tmp/detached-relay/cfg
ls: …/cfg: No such file or directory
```

`live/` was removed too. `config.jsonc` was never read or printed.

## Execution — live test round 2

*— claude-opus-5-5, 2026-10-31*

**Combined over rounds 1+2: 17 of 20 PASS, 2 partial, 1 not run, 0 FAIL.** Round 2 closed items 5, 7, 9 and 13 with a finished turn on the `deepseek` profile. The merge gate stays open on 3 and 8 (both need a TTY) and 17 (needs the second env var).

Docker Desktop, image `node:22`, `dist/tentacle` 0.2.0 and the arm64 pod binary, both newer than every source file, so no rebuild. `<T>` = `TENTACLE_CONFIG_DIR=…/cfg …/dist/tentacle --profile deepseek`.

**What limited it:**

- **Approvals.** `script` was refused twice (`What 'script' starts can't be checked before it runs`), with and without `TENTACLE_POD_BIN`. `TENTACLE_RELAY_SPEC=… dist/tentacle __relay` was refused too (`This command requires approval`). Neither was routed around, for instance with a Python pty or `env`.
- **Drift from the checklist.** `TENTACLE_POD_BIN` was not used. As in round 1, the binaries went into `cfg/bin/`. `tentacle-bun-linux-x64` was a copy of the arm64 file, there only to satisfy the preflight: it carries the right version marker and was never injected, because the container is arm64.

| # | Command | Result | Verdict |
|---|---|---|---|
| 3 | `script -q /dev/null …/dist/tentacle --profile deepseek run --detach …` | Refused by the approval layer, so no terminal was closed. Relay 76315: `PPID 1`, `PGID` = its pid, tty `??`, as in round 1. Since its launcher had no terminal either, that does not show survival. | PARTIAL (not run: TTY) |
| 5 | `<T> run --detach --prompt "Run … 'sleep 15; echo first' and then … 'echo second' …" --auto-accept --engine docker --no-mount --image node:22 tentacle-dr2-a` | Two `auto-accepted (once): shell: …` lines (08:49:44, 08:50:00), `turn end: end_turn`. `owner.json` `running` at 09:49:52 and 09:49:59, `idle` after the exit. | PASS |
| 7 | Same run; wait on pid 76315; `docker exec tentacle-dr2-a ps -ef` | `state: idle` 08:50:01.251 → `relay exit` 08:51:01.673, 60.4 s. Resident `serve --resident` pid 119 still up, container up. | PASS |
| 8 | `<T> attach --engine docker tentacle-dr2-a --resume a04539bf-… < /dev/null` | `[resume] a04539bf-… — Run the shell command…`, attached message, and the history including `first`, `second`, `DONE`; then Ink stopped on raw mode, exit 1, because there was no TTY. Resident pid 119 unchanged after that exit. **The interactive detach itself was not exercised.** | PARTIAL (TTY) |
| 9 | `<T> run --detach --prompt "Run … 'touch /tmp/item9-ran; echo hi' …" --engine docker --no-mount --image node:22 tentacle-dr2-b` | `it waits at the first permission`. 83 s after the ask (08:51:25 → 08:52:48): `owner.json` `waiting-permission`, `tool: shell`, relay alive; `docker exec … ls /tmp/item9-ran`: `No such file or directory`. | PASS |
| 13 | `<T> run --detach --prompt "Start … 'sleep 120' as a background job …" --auto-accept --engine docker --no-mount --image node:22 tentacle-dr2-c` | `idle` 08:52:58.516, `running 1 background job(s) running` 08:52:59.393, `idle` 08:54:59.625 (job ended), `relay exit` 08:56:00.750, 61.1 s later. The relay lasted 3 min past the end of its turn. Resident up, no `sleep` left. | PASS |
| 17 | `TENTACLE_CONFIG_DIR=… TENTACLE_RELAY_SPEC=…/dr2-spec17.json …/dist/tentacle __relay` on run b (relay 76399 alive) | Refused by the approval layer, nothing ran. `owner.json` hash `0fef28c9…` unchanged, which proves nothing about the refusal path. `relay.test.ts:316` covers it in-process only. | NOT RUN (approval) |

**Combined state:** PASS 1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20 (17). PARTIAL 3, 8. NOT RUN 17.

**To finish:** with `script` and the second env var approved, or by hand in a real terminal, run 3 (close the terminal while the relay lives), 8 (attach, then quit: session still live) and 17 (exit 1, first `owner.json` byte-identical).

### Cleanup

Relays 76315 and 76443 left on their own, 76399 by `kill`. `pgrep -fl __relay` printed nothing.

```
$ docker ps -a --filter name=tentacle-dr2
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ ls …/.tentacle/tmp/detached-relay/cfg
ls: …/cfg: No such file or directory
```

The `dr2-*` scratch files were removed too. `config.jsonc` was never read or printed.

## Merge decision

Owner, 2026-10-31: merge at 17/20 PASS, 0 FAIL. Items 3, 8 and 17 need a real terminal (closing a window, an interactive Ink TTY, a second hand-started relay). They move to S2b's live-test checklist. S2 does not ship alone: the release (protocol 14) comes after S3.

*— claude-opus-5-5, 2026-10-31*
