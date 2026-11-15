# feat/serve-mcp — serve sessions: capability parity with the local TUI (MCP first)

> **Status:** context · **implementation (awaiting owner approval)** · execution · review · done
> **Branch:** `feat/serve-mcp`
> **Size:** L overall, split into slices S1 (S) · S2 (M) · S3 (M, Q1) · S4 (M, Q2) · **Blast:** S1/S2/S3 cross-module · S4 load-bearing (hooks trust is a trust prompt, AGENTS §7) · **Suited:** DeepSeek executes S1–S3, Opus reviews every group. S4 is planned and reviewed by Opus in a fresh context.
> **Changelog:** `changelog.d/serve-mcp.added.md`: "**`serve` sessions get your MCP servers.** Sessions you drive from the phone or `connect` now have the MCP tools configured on the serve host, and `/mcp` shows them." S4, if approved, adds `changelog.d/serve-hooks-trust.fixed.md`.

## Context

*— claude-opus-5-5, 2026-11-15*

**Owner principle (2026-11-15, binding):** a session driven from the phone or Mac must have
the SAME capabilities, as far as possible. Phone and `connect` sessions are hosted by
`tentacle serve`. Local TUI sessions are hosted by the worker. So this task starts from a
parity audit of the two hosts. The known gap is MCP: `serve` connects no MCP server, so a
phone session has none of the configured MCP tools.

**One fact shapes the whole plan: a `serve` daemon hosts exactly one project.** Every
session's agent is built on the host's `defaultCwd`, and a client's `cwd` is not honoured
(`packages/daemon/src/session-host.ts:5-7`, and the `createAgent(this.opts.defaultCwd, …)`
calls at `:476`, `:1214`, `:1287`). `serve` sets that cwd to its own `config.cwd`
(`packages/cli/src/serve.ts:489`), which is `process.cwd()` at launch
(`packages/cli/src/main.ts:915-921`). The store and its lock are per `projectKey(cwd)`
(`serve.ts:180-182`, `:368`). "Many projects" therefore means many `serve` processes, one
per project. So a single MCP connection set per daemon is already one set per project. No
per-cwd pool is needed.

### Parity audit: worker (local TUI) vs `serve` (phone / `connect`)

| # | Capability | Worker (local TUI) | `serve` (phone / connect) | Verdict |
|---|---|---|---|---|
| 1 | **MCP servers (tools)** | Connected once, in the background. Tools are registered into every registry, including registries built before the connect settles (`worker.ts:164-200`, `onBuilt` `:211-217`) | **None.** `createServeAgent` has no MCP (`serve.ts:192-216`), and the host gets no `mcpStatus` or `toolsReady` (`serve.ts:488-531`) | **GAP → S1+S2** |
| 2 | `mcp/status` (`/mcp`) | `McpStatusTracker` (`worker.ts:181,209`) | Host default `[]` (`session-host.ts:596-598`). The `connect` TUI already asks (`connect.ts:273`) and gets an empty list | **GAP → S2** (the phone has no `/mcp` UI: follow-up F1) |
| 3 | Context estimate before MCP is ready (`~`) | `toolsReady` (`worker.ts:113,210`) | Absent, so always "complete" (`session-host.ts:481`) | **GAP → S2** |
| 4 | Skills + hot reload | One `createSkillScan` per host (`worker.ts:204`, `newSessionSkills` `:109`). Per agent: `wiring.ts:524-542` | Same (`serve.ts:485,497`), same `buildAgent` | Parity (the phone has no `/skill` picker: F2) |
| 5 | User hooks + project hooks | `buildAgent` `wiring.ts:485-511`. Project hooks may `allow` (`canAllow`, `:506`) | Same code. `canAllow` is true too, because there is no `modelOverride` | Parity in the daemon |
| 6 | **Project hooks trust** | `hooks/trust` is answered by the laptop through THE broker, with a persistent store (`local-runtime.ts:930-944,1484`) | Asked of the prompting client (`connection.ts:918-921`). `connect` asks but never stores (`connect.ts:183-184`). The **phone has no `hooksTrust`** (`apps/mobile/src/connection.ts:320-343`, `APP_CLIENT_OPTIONS` `:51-59`), so `onHooksTrust` returns `{trusted:false}` (`remote-client.ts:2458-2459`) and **project hooks never run in a phone turn**, with no message | **GAP → S4 (Q2)** |
| 7 | Sub-agents, background agents, `agent_control` | `wiring.ts:559-641` (`subagents.*`) | Same `buildAgent` | Parity (the phone has no sub-agent panel: F3) |
| 8 | Background shell jobs | `wiring.ts:460`. The exit net is forwarded to the main thread (`worker.ts:145-149`) | Same. `serve` also wakes an unattended session when a job exits (`autoWake`, `serve.ts:519-522`) | Parity (+ a serve-only extra) |
| 9 | Images / vision (images-off reason) | `daemonImagePolicy(config)` (`worker.ts:100,116`) | Same (`serve.ts:487,525`) | Parity |
| 10 | Auto-accept (shared) | `sharedAutoAccept: true` (`worker.ts:106`) | `sharedAutoAccept: true` (`serve.ts:509`). The phone sets the trust bit (`apps/mobile/src/connection.ts:58`) | Parity |
| 11 | `move_session` (session hop) | `moveSession: true` (`worker.ts:65`), behind `sessionHop.tool` (`wiring.ts:670`) | Never (`serve.ts:857-860`, `docs/feat/session-hop.md:325-329`) | **Cannot**, by design (below) |
| 12 | `workload_shell` | Laptop backend (`worker.ts:69`) behind `workloadShell.tool` (`wiring.ts:680-686`) | Same backend (`serve.ts:213`) | Parity |
| 13 | Built-in tool set, permission gate | `builtinTools` + one broker per session + `PermissionGate` (`wiring.ts:456-457`, `permission-gate.ts:169-237`) | Same | Parity |
| 14 | Context awareness / context reset / compaction / tool-output shaping | Config-driven in `buildAgent` (`wiring.ts:466-518,544-549,647-664`) | Same, from the serve host's config | Parity |
| 15 | Model / profile | Picked per launch: `--profile` / `-m` on the TUI (`main.ts:915-921`). The model runs on the laptop | Fixed at `serve` start. One `serve` per project (lock `serve.ts:368`), so a phone session cannot pick another profile | **GAP, not in this branch → Q3** |
| 16 | Session settings sync (`session/open.settings`) | Not honoured (the worker factory takes none, `worker.ts:124-132`) | Not honoured (`serve.ts:496`). Only the pod's model-proxy uses it (`serve.ts:976-1015`) | Parity (neither does it) |
| 17 | Turn error text to the client | Raw, including internal errors (`worker.ts:120,230`) | Sanitized and bounded (`serve.ts:500-504`) | By design (remote peer) |
| 18 | Hook/daemon failure log | `<configDir>/logs/daemon-errors.log` (`worker.ts:55,122`) | The `serve` process's stderr (`serve.ts:202,499`; `main.ts:1144-1145`) | Operational difference only |
| 19 | Config hot reload (incl. `mcpServers`) | None: config is loaded once per launch | None: loaded once per `serve` start | Parity (restart for both) |
| 20 | Persistence, TTL/limits, push, `modelInfo`, autoWake | The laptop store | Serve-only (`serve.ts:373-390,492-493,511,522,530`) | Serve-only extras, not gaps |

**What cannot reach parity, and why:**
- **`move_session` / hop (row 11).** A hop moves the laptop's own runtime between the laptop and a pod. The laptop TUI that owns that runtime executes it (`session-hop.md:325-329`). A `serve` session belongs to the serve daemon, not to a laptop runtime, so nothing on that side could carry out a proposal. Offering the tool would create a prompt nobody raises, which is the silent drop `session-hop.md:1626` already fixed for pods.
- **Raw internal errors (row 17).** These are deliberately withheld from a remote peer.
- **Per-launch flags (row 15)** can only be matched by a new feature (Q3). It is not a wiring fix.

**Repro (2026-11-15, on this branch = `main` b97ff97b):** `.tentacle/tmp/serve-mcp/repro.ts` starts
`startDaemon` with one stdio MCP server (the repo's `packages/cli/test/fixtures/mcp-stdio-server.ts`),
an isolated `configDir`, `devices:false`, `discovery:false` and `--no-relay`. It attaches a
`RemoteClient`, waits 1.5 s and asks `mcp/status`:

```ts
const base = await loadConfig({ cwd: join(here, "proj"), configDir: join(here, "cfg"), scaffold: false });
const config = { ...base, mcpServers: { echo: { type: "stdio", command: process.execPath, args: [fixture] } } };
const handle = await startDaemon(config, { host: "127.0.0.1", port: 0, devices: false, discovery: false, relay: { noRelay: true } });
const client = new RemoteClient(await webSocketChannelFactory(handle.url)(), new PermissionBroker());
await client.initialize(); await Bun.sleep(1500);
console.log("configured:", Object.keys(config.mcpServers));
console.log("serve mcp/status:", JSON.stringify(await client.mcpStatus()));
```
```
configured: [ "echo" ]
serve mcp/status: []
```
The same server under the worker reports `["echo","connected",["echo"]]` (`packages/cli/test/worker.test.ts:127-163`).

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**A `serve` daemon hosts exactly one project, so one MCP connection set per daemon is
correct.** Every agent is built on `defaultCwd` (`session-host.ts:5-7,476,1214,1287`).
Restored sessions go through the same `build` (`session-host.ts:1040-1051`). `defaultCwd`
is `config.cwd` (`serve.ts:489`), which is the launch `process.cwd()` (`main.ts:916`). A
stdio MCP server is spawned with `cwd: spec.cwd`, or else the process cwd
(`packages/mcp/src/transport.ts:32-38`). That process cwd is the project, so a
filesystem server is rooted where the worker would root it. If a future `serve` honours a
client `cwd`, this plan becomes per-cwd and must be redone. A test pins the assumption
(T9).

**Decisions (made here, not owner questions):**
- **Per daemon, eager, in the background.** The connect starts after `listen` succeeds,
  so a start that fails spawns nothing. It does not block the listener. This matches the
  worker, and restored sessions want their tools anyway. A lazy connect (on the first
  session) would save processes only on an idle daemon, and it would make the first phone
  turn race the handshake.
- **Shutdown:** dispose on `stop()`. A dispose that lands before the connect settles is
  remembered, and the late connections are closed when it settles. A synchronous
  `process.on("exit")` kill covers the second Ctrl+C `process.exit(130)` path
  (`main.ts:1158-1167`).
- **stderr:** piped (already: `transport.ts:37`) and routed to `onNotice` as
  `mcp <name>: <line>`, at most 50 lines per server per daemon run, then one
  `mcp <name>: further stderr suppressed`. `serve` has no Ink (`main.ts:1149`), so its
  stderr is safe. The worker keeps dropping these lines (unchanged; its terminal is Ink's).
- **Connect errors and name clashes** go to `onNotice`, one line each. Today a clash is
  skipped silently (`worker.ts:173-177`), which is a silent drop (§8). The hub reports it
  for both hosts.
- **`mcp/status` per session = per daemon.** The connection set is daemon-wide, so
  `Connection.mcpStatus → host.mcpStatus` (`connection.ts:484-485`) is already the right
  answer for any session. No protocol change.
- **Hot reload:** out of scope. Neither host reloads config (row 19). A change to
  `mcpServers` means restarting `serve`, just as it means relaunching the TUI.

### Preconditions

- **The security story holds with no new code.** MCP tools are always
  `permission: "ask"` (`packages/mcp/src/tool-adapter.ts:79`). `readOnlyTools` changes
  only concurrency (`:80`), so a server that claims `readOnlyHint` cannot skip the ask.
  The gate sends every tool not marked `"none"` that no session grant covers to the
  session's requester (`packages/agent/src/permission-gate.ts:213-237`). Only a `deny`
  hook or a user hook's `allow` is checked first (`:171-211`), the same as on the worker.
  The requester is the session's ONE broker. A remote must authenticate to reach it: a
  non-loopback bind requires a token or the device route (`serve.ts:4`, `:451-454`). With
  no client attached, the ask stays pending and is persisted (§7). Auto-accept is a
  per-session switch the user turns on, shared like `shell`'s (row 10). It is not a new
  bypass. **T6 proves it with a mutation.**
- **Secrets:** the child env is `scrubSensitiveEnv(process.env)` + `spec.env`
  (`transport.ts:31-34`). `TENTACLE_REMOTE_TOKEN` (`flags.ts:606`) matches `TOKEN`
  (`packages/core/src/env.ts:11-12`), so the serve token never reaches an MCP server. The
  argv comes from the user's own config.
- **Partial failure is isolated:** `Promise.allSettled` (`packages/mcp/src/connect.ts:141-156`).
  `dispose` is synchronous (`:165-169`).
- **Late arrival:** every agent build (new, restored, context probe, settings rebuild) calls
  the host's `createAgent` (`session-host.ts:476,1214,1287`). One hook in the factory
  therefore reaches every registry, which is what the worker relies on (`worker.ts:124-129`).
- Peer concurrency is untouched (§7, "Don't serialize the RPC peer"). Persistence is
  untouched: MCP tools are not persisted state, and a history that names a tool missing
  after a restart fails as an unknown tool (`session-hop.md:412`).

### Design

**S1 (S): extract the worker's MCP wiring into one hub. No behaviour change.**
New `packages/cli/src/mcp-hub.ts`:
`createMcpHub(servers, { connect?, onErrors?, onClash?, onStderr? })` →
`{ start(), onBuilt(tools: ToolRegistry), status(): Promise<McpServerStatus[]>, ready(): boolean, dispose() }`.
It holds what `worker.ts:164-200,211-217` hold today: the `pending` set, `register` (with
`onClash`), the `McpStatusTracker`, and settle/fail. It adds `dispose` with
dispose-before-settle semantics. `connect` defaults to `connectMcpServers` and is the test
seam. The worker uses it: `hub.start()`, then `onBuilt: (w) => hub.onBuilt(w.tools)`,
`mcpStatus: hub.status` and `toolsReady: hub.ready`. Its `mcp-errors` post stays in
`onErrors`. Logic lives in a pure module, the components only wire it (§7).

**S2 (M): wire the hub into `serve`.**
- `startDaemon`: create the hub (`createMcpHub(config.mcpServers, { onStderr: capped(onNotice), onErrors: notice, onClash: notice })`)
  and pass it into `reloadedHost`.
- `createServeAgent` (`serve.ts:192`): the `createAgent` closure (`:496`) calls
  `hub.onBuilt(wired.tools)`, the same shape as the worker.
- `SessionHost` options (`:488`): add `mcpStatus: () => hub.status()` and
  `toolsReady: () => hub.ready()`.
- `hub.start()` right after `listen` returns, and `release` (`:411-416`) calls
  `hub.dispose()` first. The `catch` (`:422-426`) also calls `hub.dispose()`. It is a
  no-op when the hub never started.
- Register `process.on("exit", hub.dispose)` at start and remove it in `stop()`, so tests
  that start many daemons in one process do not leak listeners.

**S3 (M, only if Q1 = b): a supervised MCP connection that respawns with backoff.**
In `packages/mcp`, wrap each server in a supervisor that owns the current `McpClient`.
Tools become **stable objects** that call the current client, so live sessions keep
working across a respawn. A closed transport triggers a respawn after 1 s, 2 s, 4 s … up to
60 s. It gives up after 5 consecutive failed spawns, and a spawn that stays up 10 min
resets the counter. While respawning, status shows `connecting` with `error: "restarting
(attempt n)"`. That reuses the existing enum (`packages/protocol/src/mcp.ts:18`): no
protocol change, so no bump. `dispose` cancels any pending respawn. The tool list is the
first connect's: a respawned server's new tools are not added (noted, same rule as today).
The worker benefits too: one supervisor, two hosts.

**S4 (M, load-bearing, only per Q2): project-hooks trust for serve sessions.**
- (a) **Daemon side:** `serve` wraps the connection's `askHooksTrust` with a
  **read-only** precheck of the serve host's own `fileTrustStore(config.configDir)`, the
  file the Mac TUI writes when the serve runs on the Mac (`local-runtime.ts:1484`). If the
  folder and hash are already trusted, return `true` without asking. Otherwise ask the
  prompting client, as today. This puts the decision where the folder is, which is why
  `connect` refuses to store it on its side (`connect.ts:183`). The precheck needs a hook
  on `SessionHost`/`Connection` (`hooksTrustPrecheck?`) because `askHooksTrust` is built
  inside `Connection` (`connection.ts:918`). It only answers "trusted" early; it never
  grants on its own.
- (b) **Phone:** pass `hooksTrust` to the phone's `RemoteClient`
  (`apps/mobile/src/connection.ts:320`). It raises a `kind:"hooks_trust"` request on the
  phone's link broker, which the permission sheet already routes to a person and never
  auto-accepts (`apps/mobile/src/permission-sheet.ts:393-398`). The answer is
  session-scoped and never stored from the phone.
- If no client can answer, the result is a visible notice ("project hooks of X not run:
  not trusted on this host"), never a silent decline.

**Follow-ups (separate tasks, not this branch). Phone UI parity, where the daemon already
has the capability:** F1 a phone `/mcp` panel (`mcp/status` exists), F2 a skills picker on
the phone (`session/prompt.skill`, `connection.ts:907`), F3 sub-agent and jobs panels on
the phone. `rg -il "mcp|subagent|jobs|skills" apps/mobile/src` finds only
`session-list.ts` and `tool-summary.ts`. Q3 (profile choice) is its own feat if approved.

### Files

Dependency order:
1. S1: `packages/cli/src/mcp-hub.ts` (new); `packages/cli/src/worker.ts` (use the hub); `packages/cli/test/mcp-hub.test.ts` (new).
2. S2: `packages/cli/src/serve.ts` (`startDaemon`, `reloadedHost`, `createServeAgent` signature + hub); `packages/cli/test/fixtures/mcp-stdio-server.ts` (opt-in env: `MCP_PID_FILE`, `MCP_CALL_LOG`, `MCP_STDERR_LINES`, `MCP_INIT_DELAY_MS`, plus a `tools/call` answer for `echo`); `packages/cli/test/serve-mcp.test.ts` (new); `changelog.d/serve-mcp.added.md`.
3. S3 (Q1=b): `packages/mcp/src/supervisor.ts` (new), `connect.ts` (connections built from supervisors), `status.ts` (`restarting` shown as `connecting` + error), `packages/mcp/test/supervisor.test.ts`.
4. S4 (Q2): `packages/daemon/src/session-host.ts` + `connection.ts` (precheck option), `packages/cli/src/serve.ts` (pass `fileTrustStore` precheck), `apps/mobile/src/connection.ts` (+ a resolver module that can be tested without RN), tests in `packages/daemon/test` and `apps/mobile/test`.

No `protocol.d/` note: no wire shape changes in S1–S4.

### Failure modes

| Mode | What happens / how state converges |
|---|---|
| Server crashes mid-session | The call rejects (`MCP connection closed: …`) and the model gets a tool error. `/mcp` shows `closed` with the reason (`status.ts:127-129`). With S1/S2 alone it stays closed until `serve` restarts (the worker's behaviour). With S3 it respawns with backoff. |
| Slow start | Background connect. `toolsReady=false`, so the context count shows `~`. Sessions built meanwhile (restored, new, probes) get the tools at settle through `pending`. A turn started before settle lacks the tools in its first request (same as the worker). The connect timeout marks the server `failed`. |
| Missing binary / bad spec | That server is `failed` with the error, and a notice line goes out. The others are unaffected (`allSettled`). |
| Two sessions share one server | One process per daemon, with requests multiplexed by JSON-RPC id. Server-side state (a browser, a cursor) is shared, exactly as between two local TUI sessions on the worker. |
| Two projects | Two `serve` processes (one store lock each), each with its own server processes, spawned in its own project cwd. |
| `stop()` during the connect | `dispose` is remembered and the late connections are closed at settle (T8). No orphan process. |
| `startDaemon` fails (tombstones unreadable, port in use) | The hub has not started, so nothing was spawned. `dispose` is a no-op. |
| Second Ctrl+C (`process.exit(130)`) | A synchronous `exit` handler kills the children. A server that ignores stdin EOF still dies. |
| stderr flood | Capped at 50 lines per server, then one suppressed line. Never inherited. |
| Tool name clash | Skipped, with one notice (it used to be silent). |
| No client attached when an MCP ask fires | The ask stays pending and persisted, and resumes on attach (§7). Nothing auto-approves unless a client turned on auto-accept for that session. |
| Phone prompts a turn in a project with untrusted hooks (S4) | Precheck finds it untrusted, so the phone asks a person. If declined or unanswerable, a notice says why. |
| Version skew | No protocol change. An older `connect` already speaks `mcp/status`, and the phone never calls it. |

### Tests

Red first on the current code, then green. Each test lists the mutation that must turn it red (§9).

- **T1** (S1, `mcp-hub.test.ts`, injected `connect` with a controllable promise): a registry built before settle has the tools after settle. One built after settle has them at once. *Mutation:* drop the `pending` flush.
- **T2** (S1): a name clash is skipped and reported to `onClash`. *Red:* `onClash` never called today.
- **T3** (S1): `connect` rejects → status is all `failed` with the error, `ready()` is true, `pending` is cleared.
- **T4** (S1): `dispose()` before settle → the settled result's `dispose` runs exactly once, at settle. *Red:* the worker has no dispose.
- **T5** (S2, `serve-mcp.test.ts`, real `startDaemon` + the stdio fixture + a missing binary): `mcp/status` returns `echo` `connected` `["echo"]` and `missing` `failed`. *Red:* `[]` (the Repro).
- **T6** (S2, **the security proof**): a recorder provider (`createProvider`) scripts a `mcp__echo__echo` call. With a client broker that **denies**, the fixture's `MCP_CALL_LOG` stays empty and the result is a denial. With **allow**, it holds one call. *Mutation:* `permission: "none"` in `tool-adapter.ts:79` → the deny case writes the log → red.
- **T7** (S2): `handle.stop()` → the fixture pid (`MCP_PID_FILE`) is gone (`process.kill(pid, 0)` throws). *Mutation:* remove `hub.dispose()` from `release`.
- **T8** (S2): stop during a slow init (`MCP_INIT_DELAY_MS`) → after the delay the pid is gone.
- **T9** (S2): a session restored from the store, with a slow server, has `mcp__echo__echo` in its tools once settled (the context probe or a scripted call). It also pins that the restored agent builds on `config.cwd` (the load-bearing assumption).
- **T10** (S2): 80 stderr lines → exactly 50 `mcp echo:` notices + one `suppressed`. *Mutation:* remove the cap.
- **T11** (S2): `TENTACLE_REMOTE_TOKEN` set in the daemon env does not reach the fixture's env (the fixture dumps its env keys to `MCP_CALL_LOG`). If `transport` tests already pin `scrubSensitiveEnv`, cite them instead.
- **T12** (S3, fake transport + injected clock): crash → respawn after the backoff. A call through the SAME tool object succeeds after the respawn. 5 failed spawns → `failed`. `dispose` cancels a pending respawn.
- **T13** (S4): trusted in the host store → no `hooks/trust` reaches the client (spy). Untrusted → it goes to the prompting client only. The phone resolver raises a `hooks_trust` request, auto-accept ON still asks a person, and allow → `trusted: true`. *Mutation:* precheck returns `true` for an unknown hash → red.

Iterate with `bun test packages/cli/test/serve-mcp.test.ts` (and `mcp-hub.test.ts`). Run the full `bun run check` before Review.

### Owner questions

1. **A crashed MCP server on a long-lived `serve`** (and on the Mac): (a) parity with today, where it stays `closed` until restart; or (b) S3, respawn with backoff (1 s→60 s, give up after 5) and stable tools, for both hosts. **Recommendation: (b), as S3 after S2 merges.** A `serve` runs for days, and "restart serve" is not something you can do from the phone.
2. **Project hooks in phone turns** (today they are silently never run): (a) S4: the serve host's own trust file is checked first (trust it once on the Mac and phone turns run the hooks), and otherwise the phone asks a person, once per session, never stored; (b) only the host-file check, and untrusted hooks are skipped with a notice; (c) leave it. **Recommendation: (a).**
3. **Model/profile choice from the phone** (the Mac picks `--profile` per launch; a phone session gets whatever `serve` started with, and one `serve` per project means no second choice): queue a separate feat where `serve` offers its own profile NAMES and a session picks one at open (keys never leave the host; protocol + phone UI)? **Recommendation: yes, as its own feat after this task. Not in this branch.**

## Execution

*(as built — S1, S2, S3, S4)*

*— deepseek-v3.2 (executor), 2026-11-15*

**Load-bearing check (run first, as the brief demands).** The plan's Repro was
re-run on `feat/serve-mcp` BEFORE any edit:
`.tentacle/tmp/serve-mcp/repro.ts` printed `configured: [ "echo" ]` /
`serve mcp/status: []`. The assumption was then verified against the source:
`session-host.ts:476,1214,1287` pass `this.opts.defaultCwd` (never a client cwd),
`serve.ts:489` sets `defaultCwd: config.cwd`, `main.ts:916` sets
`cwd: process.cwd()`, and `transport.ts:32` spawns with `cwd: spec.cwd` (else the
process cwd: the project). It holds, and T9 now pins it.

### S1 — `packages/cli/src/mcp-hub.ts` (DONE)

New pure module: `createMcpHub(servers, { connect?, onErrors?, onClash?, onStderr?,
onRestart? })` → `{ start, onBuilt, status, ready, dispose }`, plus `capStderr`.
It holds the worker's `pending` set + register/clash + `McpStatusTracker` +
settle/fail, and adds dispose-before-settle (a connection that arrives after the
dispose is closed at settle) and an idempotent dispose. `worker.ts` now wires it
(`hub.start()`, `onBuilt: (wired) => hub.onBuilt(wired.tools)`,
`mcpStatus: () => hub.status()`, `toolsReady: () => hub.ready()`); `onErrors`
keeps the `mcp-errors` object post. No behaviour change on the worker
(`worker.test.ts` unchanged and green).

Tests: `packages/cli/test/mcp-hub.test.ts` (T1, T2, T3, T4, T4b, per-server
error forwarding, `connecting` before settle, `capStderr`). Red first: the module
did not exist.

### S2 — the hub in `serve` (DONE)

- `startDaemon`: builds the hub from `config.mcpServers`, routing `onErrors`,
  `onClash`, `onStderr: capStderr(...)` and `onRestart` to `onNotice`; registers a
  synchronous `process.on("exit", dispose)` handler, removed in `release` and in
  the `catch`.
- `reloadedHost(..., mcpHub, push?)`: the host gains `mcpStatus: () => hub.status()`
  and `toolsReady: () => hub.ready()`.
- `createServeAgent(..., mcpHub?)`: `mcpHub?.onBuilt(wired.tools)` on every build
  (new, restored, context probe, settings rebuild) — the worker's shape.
- `listen(..., afterListen?, hooksTrustPrecheck?)`: `afterListen()` runs once the
  listener exists, so `hub.start()` spawns nothing for a start that failed;
  `release` disposes the hub first, the `catch` also disposes it.

Fixture `packages/cli/test/fixtures/mcp-stdio-server.ts` gained opt-in env knobs
(`MCP_PID_FILE`, `MCP_CALL_LOG`, `MCP_STDERR_LINES`, `MCP_INIT_DELAY_MS`,
`MCP_EXIT_AFTER_INIT`, `MCP_EXIT_AFTER_TOOLS`, `MCP_EXIT_AFTER_TOOLS_ONCE`,
`MCP_CRASH_ON_CALL_ONCE`) and a `tools/call` answer for `echo` that appends the
call plus the child's env KEYS to `MCP_CALL_LOG`.

Tests: `packages/cli/test/serve-mcp.test.ts` T5, T5b, T6 (the security proof),
T7, T8, T9, T10, T11, T12 — each shown red by its mutation, below.

### S3 — supervised servers (DONE, per owner Q1=b)

The plan's seam did not exist: a connection exposed neither its client nor a
close signal, so a supervisor could neither see a crash nor keep tools alive
across a respawn. Three minimal seams were added where they belong instead of
copying the connect path:

- `McpClient.onClose(listener)` (`client.ts`): fires from `handleClose`, one
  shot; a listener added after the close is answered at once.
- `McpConnection.client()` / `McpConnection.onClose(listener)` (`connect.ts`):
  the client it was built on, and the one-shot transport-close signal (a
  `close()` and the transport's own close count once).
- `ConnectOptions.toolClient` (`connect.ts`): the client the adapted TOOLS are
  built against, so the supervisor passes a routing proxy that forwards to
  whatever client is current — the tool objects survive a respawn. It is the only
  way to keep `mcpToolToTool` unchanged (one adapter, two hosts).

`packages/mcp/src/supervisor.ts` (new): `respawnDelay` (1 s doubling, capped at
60 s), `shouldRespawn` (budget + dispose) — both pure and clock-injected — and
`superviseServer(name, spec, deps)`: adopt, crash on the transport close (count,
schedule), respawn, fail per attempt, give up after `RESPAWN_MAX_ATTEMPTS`, reset
after `RESPAWN_HEALTHY_MS` up. `connectMcpServers` supervises by default
(`supervise: false` keeps a plain connect for in-memory transports) and its
`dispose` closes the supervisors first. `status.ts` maps a pending respawn to
`state: "connecting"` + `error: "restarting (attempt n)"` — the existing enum, so
no protocol change.

Tests: `packages/mcp/test/supervisor.test.ts` (delay/budget; T12a–T12e: the same
tool object across a respawn, give-up after five failures, dispose cancels a
pending respawn, a healthy stretch resets the budget), and the end-to-end T12.

### S4 — project-hooks trust (DONE, per owner Q2=a)

- `packages/cli/src/serve-hooks-trust.ts` (new): `hooksTrustPrecheck` (pure) and
  `serveHooksTrustPrecheck(configDir)` over the read-only `fileTrustStore`.
- `Connection` / `WsServerOptions` / `AcceptDeviceDeps` gain
  `hooksTrustPrecheck?: (request: Pick<HooksTrustParams, "folder" | "hash">) =>
  boolean`. `Connection.askHooksTrust` checks it FIRST and returns `true` without
  asking — the host's own decision, read-only, never granting.
- `startDaemon` passes `serveHooksTrustPrecheck(config.configDir)` to `listen`.
- `apps/mobile/src/hooks-trust.ts` (new): `phoneHooksTrust(broker)` raises the
  `hooks_trust` ask on the phone's link broker (a person; auto-accept never
  answers a `hooks_trust` — `permission.ts:295`), `storeBacked: false`, and a
  dismissed prompt is not a trust. Wired into the phone's `RemoteClient` options
  in `apps/mobile/src/connection.ts` (per link, because it needs the broker; not
  in `APP_CLIENT_OPTIONS`, which carries only broker-free bits).

Tests: `packages/cli/test/serve-hooks-trust.test.ts` (precheck cases; T13a
trusted-in-host → never asked; T13b untrusted → asked, hook runs, nothing stored;
T13c untrusted → the hook does not run; T13d trusted in the host's store → the
hook runs in a turn with no ask) and `apps/mobile/test/hooks-trust.test.ts` (the
ask, a deny, a dismissed prompt, the detail).

### Drift from the Implementation, and why

1. **S3 needed three seams the plan did not name.** The plan said "wrap each
   server in a supervisor that owns the current `McpClient`" as if a connection
   exposed one. It did not. `client()`, `onClose()` and `ConnectOptions.toolClient`
   are that seam, at the smallest place. The alternative — rebuilding tools on
   every respawn and re-registering them into live registries — is the second
   session path §7 forbids.
2. **`ConnectOptions.supervise` was added.** `connect.test.ts` and
   `http-transport.test.ts` drive `connectMcpServers` with in-memory transports;
   supervising those would test the fake. One option, default on; the tests that
   want the real thing use the default.
3. **S4's precheck takes `Pick<HooksTrustParams, "folder" | "hash">`**, not the
   whole request: that is what `Connection` holds there (the agent's
   `ProjectHooksTrustRequest` has `readonly string[]` for `files`), and the
   precheck needs only these two.
4. **The "no silent decline" notice needed no new code.** A refused trust is
   already logged by the runner (`agent/src/hooks.ts:496`, `project hooks of
   <folder> not run this session (<why>)`), and `serve.ts` routes `buildAgent`'s
   `log` to `options.onError` → the serve process's stderr (`main.ts:1146`).
5. **Two changelog fragments, not one.** `scripts/changelog.ts:125` allows one
   bullet per file: `serve-mcp.added.md` (MCP) and `serve-hooks-trust.fixed.md`
   (hooks), which is what the plan itself named.

### Mutations run (each turned the named test red, then was reverted)

| Mutation | Red |
|---|---|
| S1: drop the `pending` flush at settle | T1, T2, and T9 (the restored session) |
| S1: remove the `onClash` report | T2 |
| S1: drop dispose-before-settle (`if (disposed) closeAll()`) | T4 |
| S2: remove `mcpHub.dispose()` from `release` | T7, T8 |
| S2: `mcpStatus: () => Promise.resolve([])` | T5, T5b |
| S2: drop `mcpHub?.onBuilt(wired.tools)` in `createServeAgent` | T6, T9 |
| S2: `permission: "none"` in `tool-adapter.ts:79` | T6 (the deny case wrote the call log) |
| S1/S2: uncap `capStderr` | T10 (both files) |
| S2: unscrub the child env (`transport.ts:31`) | T11 |
| S3: no supervisor (`supervise` always false) | T12 (end to end) |
| S3: `toolClient` not passed (tools keep the dead client) | T12a, T12 |
| S4: the precheck answers `"trusted"` for any hash | the pure precheck test, T13b, T13c |
| S4: `startDaemon` passes no precheck | T13d |

### Gate

`bun run typecheck` clean · `bun run lint` clean (1506 files, 0 errors/0
warnings, the §6 baseline) · `bun test`: **10841 pass, 0 fail, 5 skip**
(the three opt-in skips — live-k8s, live-docker, the slow keepalive — plus the
two pre-existing ones), 10846 tests / 785 files. One earlier full run showed
`packages/daemon/test/session-log-store.test.ts` T4 failing on its
`Bun.sleep(60)` timing wait; that file is untouched by this branch, the test
passed three times in isolation and in both later full runs, so it is a
pre-existing flake, not this task's. No schema changed, so
`packages/protocol/schema/protocol.json` was NOT regenerated and no `protocol.d/`
note is needed: S1–S4 add no wire shape (`mcp/status` already exists; S3 reuses
its `connecting` state).

**Unverified.** The phone's `hooks_trust` sheet RENDERING is pinned by unit tests
of the resolver only; how RN draws the ask is out of this repo's test reach (the
sheet is unchanged and already routes `hooks_trust` to a person). Verify by
running the app against a `serve` whose project is untrusted.

## Review

**Verdict: REQUEST-CHANGES**

1. **HIGH — S4 precheck is not wired on the relay path.** `packages/daemon/src/relay-link.ts:681-689` builds the phone's `acceptDevice` deps without `hooksTrustPrecheck`. Only `ws-server.ts` (direct WS and `/e2e`) gets it. *Scenario:* the user trusts the project on the Mac and then drives `serve` from the phone over the relay (the usual remote path). `Connection.askHooksTrust` has no precheck, so the phone is asked every session, which is exactly what owner decision Q2(a) ruled out. No test covers the relay route: T13 uses ws-server only. Fix: thread the precheck through the relay-link options (`serve.ts` `listen` → relay link) and add a relay-route test.
2. **MEDIUM — a host `never` decision can be overridden from the phone.** `packages/cli/src/serve-hooks-trust.ts:329` maps `decision:"never"` to `"ask"`. The TUI's own `trustPrecheck` (`hooks-trust.ts:34`) treats `never` as declined for any hash. *Scenario:* on the Mac the user picks "never" for a repo's hooks. A phone turn then asks again, and one tap runs those hooks in that session. The host's explicit refusal stops being the decision "where the folder is". Either honour `never` (return declined without asking) or record why not.

**Gate (run here):** touched files (`mcp-hub`, `serve-mcp`, `serve-hooks-trust`, `packages/mcp/test`, daemon `connection`, mobile `hooks-trust`, `worker`): 157 pass / 0 fail. `bun run typecheck` is clean. `bun run lint`: 1506 files, clean. I did not re-run the full suite.

**Mutations (each reverted; `git status` was clean after):** `permission:"none"` in `tool-adapter.ts:79` → T6 red. `Connection` precheck short-circuits to `true` whenever a precheck is present → T13b and T13c red.

**Attacks tried:** (a) relay versus direct accept paths → finding 1. (b) `never` and `canAllow` in the host store → finding 2. `canAllow` is not part of the hash, but the TUI already behaves the same way, so that is not new. (c) The pod path (`serve.ts:1108`, `pod-resident.ts:303`) gets no precheck. That is correct: a pod is not trusted. (d) The exit handler during an in-flight handshake: the children are not tracked yet, so they rely on stdin EOF. This is narrow and I'm not raising it. (e) The supervisor's crash counting and its dispose during a respawn: these hold. (f) The child env scrub and the token: T11 holds.

**What holds:** one connection set per daemon, built on `config.cwd`. MCP tools still require a permission ask (shown by mutation). The hub's dispose-before-settle. Peer concurrency is untouched. No wire change, so no `protocol.d` note is needed.

**Executor behaviour:** thorough, with honest drift notes and real mutation evidence. It missed the second `acceptDevice` call site.

*— claude-opus-5-5, 2026-11-15* (same model family as the plan's author; only the context is fresh)

#### Owner decisions (2026-11-15 11:10)

1. **(b)** crashed MCP servers respawn with backoff (1 s→60 s, give up after 5), stable tools, on both hosts — as recommended.
2. **(a)** project hooks in phone turns: the serve host's own hooks-trust first; otherwise the phone asks once per session, never stored — as recommended.
3. **Out of scope**: per-session model choice is a TODO entry (`feat/per-session-model`), not part of this task.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
