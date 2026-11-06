# feat/session-settings-apply — apply the laptop's settings to a live pod session, between turns

> **Status:** context · implementation (approved, extended for the owner answers) · execution done · review: REQUEST-CHANGES (F1, MEDIUM)
> **Branch:** `feat/session-settings-apply` (off `main` @ `c42cb43`)
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review that red-teams the §7 invariants (one session path, pod not trusted, don't serialize the peer, protocol) and the agent-swap seam. TODO.md says M; this plan finds L (see "Size and blast").

Planned on detached `main` @ `7259b4b`; every `file:line` is at that commit. Builds on `docs/feat/config-carry.md` (protocol v16, `session/open.settings`, P keys laptop-decided, W keys carried as the lowest layer, notice `Session settings: { … } (/clear to reset)`).

## Context

*— claude-sonnet-5-5, 2026-11-06*

**Problem.** A pod session keeps the settings it was created with (`session.ts` open rules: "a live id keeps what it was created with", `packages/protocol/src/session.ts:389-428`; `session-host.ts:431-434` passes `params.settings` only on the create branch). When the user attaches from a laptop whose settings differ, the only help is the drift notice (`settingsNotices`, `packages/cli/src/carried-settings.ts:332-359`) with the hint `(/clear to reset)`: the user must throw away the session (and its conversation) to take the new values. Owner 2026-11-05 asked for a way to apply the laptop's settings to the live session, between turns.

**Owner decisions already taken (TODO.md:435).** A TUI command `/settings apply` (not a flag, not automatic, since other attached terminals share the session); an additive protocol method `session/update_settings`; W keys the container sets still win; `loadAgentsMd` / `loadSkills` recompose the context.

**~~Out of scope~~ IN scope since the owner's Q1 = B (slice S3, see "Implementation — extension"):** "bound the plain attach's `session/open`" (the TODO's second clause). It has its own failure analysis (the open goes through `openOn` + `whenLive`, reconnect machinery, `client/src/remote-client.ts:581-600`) and no coupling to this change.

**Repro (feature missing).** On `main` there is no way to change a live pod session's settings:
`rg -n "update_settings|settings apply|/settings" packages` → no match (checked 2026-11-06 in planning; the executor re-runs it before any edit). `SLASH_COMMANDS` (`packages/tui/src/commands.ts:25-40`) has no `/settings`.

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

**Between turns, a hosted session's `Agent` can be replaced by one the same factory builds, without losing anything the session owns, because (a) `Session` reads its agent only through one private field at call time, (b) everything session-owned that lives outside the `Agent` is either held by `HostedSession` (the broker, the jobs registry) or can be handed to the new agent (grants, pending job exits), and (c) the swap can be one synchronous stretch, so no turn can start inside it.**

Proof:

- (a) `Session.agent` is `private readonly` (`packages/agent/src/session.ts:61`), assigned once (`:67`) and read at `:115, :131, :140, :151, :169, :209, :211, :216`; nothing outside `Session` holds the `Agent`. `HostedSession` holds `Session`, not `Agent` (`daemon/src/hosted-session.ts:280`, `:419`). So the field can become mutable with one setter and no other reader goes stale.
- (b) The things `HostedSession` keeps outside the agent: `permissions` (the requester is installed once on the broker, `hosted-session.ts:443`; the agent only closes over `permissions.request`, `wiring.ts:~533`), `jobs` (`hosted-session.ts:420`, exit subscription `:451`). The things that live INSIDE the old `Agent`/wiring and would be lost by a naive rebuild: `SessionGrants` (the session's approvals, built in `buildAgent`, `wiring.ts:~436`; `SessionGrants` is plain state, `agent/src/session-grants.ts:23-48`), the pending job exits (`Agent.pendingExits`, `agent.ts:507`, filled by the subscription at `:535`, drained at `:1821-1825`), and the per-agent counters (`resetsThisMessage`, `otherCallSinceReset`, `agent.ts:520-522`; harmless to restart). The `HookRunner`'s project-trust decision (`hooks.ts:362-364`, `:415-419`) is also per runner (accepted: re-asked once, see Failure modes).
- (c) The factory is synchronous (`AgentFactory` returns the object, `session-host.ts:70-90`; `build` uses it without `await`, `:847`), `skillScan.latest()` is synchronous, and `assertIdle` (`hosted-session.ts:1377`) is a synchronous check of the single busy slot (`controller`, taken by turn and compaction). Check + build + swap with no `await` means nothing can take the slot in between (JS is single-threaded; same reasoning as `open`'s "SYNCHRONOUS on purpose", `session-host.ts:~395`).

**If (b) were false** (state lost silently) the executor's first test T3/T4 below would show a lost approval or a lost job-exit note; they exist to prove exactly this.

### Preconditions

| Fact | Evidence |
|---|---|
| Only the model-proxy branch of `podSessionHost` reads `settings`; `serve` and the worker never do | `cli/src/serve.ts:482-492` (non-proxy → `buildAgent` with no settings); `settingsReport` is set only by `tunnelledAgent` (`serve.ts:~395-415`) |
| The laptop's settings sit on the client already (`RemoteClientOptions.sessionSettings`, kept as `carried`) and are set only where the notifier is | `client/src/remote-client.ts:219-223`, `:389-390`, `:430`; `cli/src/local-runtime.ts:572, :576-578` |
| `applyCarried` is pure and takes `(podConfig, settings)`; calling it again on a fresh factory call is the whole overlay | `cli/src/carried-settings.ts:223-266` |
| The system prompt is `messages[0]` (`startConversation`), and compaction / context reset keep a system head | `agent/src/agent.ts:603-605`; `hosted-session.ts:1753-1762` (comment: `[system?, summary, …]`, `[system, restart message, …]`) |
| A session command goes `App → PersistingController → RemoteSession → RemoteClient.sessionCall → Connection → HostedSession`; `compact` is the precedent, including the post-call `flush()` | `tui/src/App.tsx:196, :1802-1850`; `cli/src/local-runtime.ts:413-417`; `client/src/remote-session.ts:599-604`; `client/src/remote-client.ts:1007-1012`; `daemon/src/connection.ts:233-234` |
| Requests are dispatched concurrently; the new handler must hold no lock | `transport/src/peer.ts` (`void handleRequest`), AGENTS §7 |
| An inbound request is schema-validated, an outbound too, a bad result rejects the request | `peer.ts:337-340`, `:152-155`, `:449` (as in config-carry) |
| An unknown method is `MethodNotFound`, and the client already maps it per method | `client/src/remote-client.ts:540-542, :785, :987` |
| A pod daemon persists nothing, so the swap touches no record | AGENTS §7; `serve.ts:439-462` |
| A busy session refuses with codes the TUI already renders | `hosted-session.ts:1377-1383` (`TurnInProgress` / `CompactInProgress`) |

§7 invariants this touches: **one session path** (a method on the same Connection/HostedSession, no second agent loop), **pod not trusted** (laptop → pod only; no laptop effect created by the pod's answer), **don't serialize the peer** (synchronous handler, no lock), **protocol versioning** (additive method: free, no bump; see Design), **logic in pure modules** (the TUI decision in a pure module), **no raw terminal write** (results through `pushNotice`).

### Design

**Rejected alternatives (one line each).**
- *Client-side recreate* (close the pod session, `open{create, messages, settings}` via the existing `recreate`): reuses everything, but ends the session for every attached terminal, kills its background jobs, drops grants and the replay ring. Contradicts the owner's reason for choosing an explicit command (shared session).
- *Mutate the `Agent`'s config in place*: the config is captured by closures all over `buildAgent` (tool registry, result transforms, sub-agent runner, hooks, `slotsReader`, reset `refresh`); patching them one by one is more code and more risk than rebuilding.

**Chosen: rebuild through the same factory, hand over what the session owns, swap atomically between turns.**

*Protocol (`@tentacle/protocol`).*
- `Method.UpdateSettings = "session/update_settings"` in `methods.ts` (+ `RequestSchemas`).
- `UpdateSettingsParamsSchema = { sessionId, settings: SessionSettingsSchema }` (explicit; the client fills it from `RemoteClientOptions.sessionSettings`).
- `UpdateSettingsResultSchema = { applied: boolean, settings?: SessionSettingsReport }`. `applied: false` (no report) = "this daemon takes its settings from its own config" (`serve`, the worker): nothing changed, not an error.
- Doc block next to the open rules: honoured only by an IDLE live session; refusal `TurnInProgress` / `CompactInProgress`; a W key the container sets still wins and is reported in `overridden`.
- **No `PROTOCOL_VERSION` bump.** A new method is additive (AGENTS §7, "methods are free"; an old daemon answers `MethodNotFound`, which the client turns into a message). `bun run schema:export` regenerates `schema/protocol.json` (pinned by `protocol/test/json-schema.test.ts:48`).

*Agent package (`@tentacle/agent`).*
- `Session.replaceAgent(next: Agent): void`: sets the (now non-readonly) `agent`; replaces `messages[0]` with `next.startConversation()[0]` ONLY when `messages[0]?.role === "system"` and the new prompt is defined and different (in place, same length: no index shifts, no `history_replaced` barrier, `cut.length`/`compactionSummary` stay valid). A history whose head is not a system message is left alone.
- `Agent.retire(): BackgroundJob[]`: unsubscribes the `jobs.onExit` listener (store the unsubscribe returned at `agent.ts:535`) and returns the undrained `pendingExits`. `Agent.adoptExits(jobs)`: pushes them to the new agent's `pendingExits`. Without these, a job that exited while idle would never be told to the model, and the old agent would keep collecting exits for ever.

*Wiring (`@tentacle/cli`).*
- `BuildAgentOptions` gains `jobs?: JobController`-typed `BackgroundJobs` reuse and `grants?: SessionGrants` (default: new, as today); `WiredAgent` also returns `grants`. `permissions` is already an option (`wiring.ts:~296`). Nothing else in `buildAgent` changes.
- `tunnelledAgent` options gain `reuse?: { permissions, jobs, grants }` and pass it to `buildAgent`; `podSessionHost.createAgent` forwards `context.reuse` (`serve.ts:482-492`).

*Daemon.*
- `AgentContext.reuse?: { permissions: PermissionBroker; jobs?: JobController; grants?: SessionGrants }`; the factory's return gains `grants?: SessionGrants` (stored on the `HostedSession` with the report). Opaque, like `settings` (`session-host.ts:60-70`): the daemon never reads a key.
- `SessionHost.updateSettings(hosted, settings)` (sync): 1. `hosted.assertIdle()` (made package-visible); 2. `createAgent(cwd, { modelLink: () => hosted.modelLink(), settings, reuse: hosted.reusable() })`; 3. if the result has no `settingsReport` → `retire()` the throw-away agent (so it leaves the shared jobs' listeners) and answer `{ applied: false }`; 4. else `hosted.swapAgent(next)`: `old = session.agent`, `session.replaceAgent(next.agent)`, `next.agent.adoptExits(old.retire())`, `titleModel = next.titleModel` (`autoTitle` is P and may toggle; `hosted-session.ts:371, :396`), `settingsReport = next.settingsReport`, `persist()` (a no-op on a pod), `lastChangeAt` untouched (not a conversation change). Any throw before step 4 leaves the old agent in place.
- `Connection`: `case Method.UpdateSettings` → `lookup(sessionId)` then `host.updateSettings`; returns `{ applied: true, settings: report }`.

*Client.*
- `RemoteClient.updateSettings(sessionId): Promise<UpdateSettingsResult>`: `sessionCall(..., "once")` like `compact` (`remote-client.ts:1007`). `once` because the result of a dropped call is unknown, but the call is idempotent (same settings in, same state out), so the user simply runs the command again. Rejects locally with a clear error when the client has no `sessionSettings` (connect, worker: nothing to apply). `MethodNotFound` → `RpcError` re-thrown with the text "this daemon predates /settings apply; attach again to replace it" (pattern of `:540-542`). It also calls `noteSettings(entry, result)`-style fan-out so the existing `onSessionSettings` listeners see the new report.
- `RemoteSession.updateSettings()` (as `compact`, `remote-session.ts:599`), absent when the client has no settings.

*CLI.*
- `PersistingController.updateSettings()` (as `compact`, `local-runtime.ts:413-417`): call inner, then `flush()` so the laptop's saved copy takes the new `messages[0]` at once. Present only when `deps.sessionSettings` is set (the same condition as the notifier, `local-runtime.ts:576`); the in-process worker and `connect` therefore expose none.
- The result is turned into lines by the existing pure `settingsNotices(mine, report)`: `Container config: {…}` for what the container kept. A new pure `appliedLine(report)` supplies the confirmation (`Session settings applied.` / `…applied; the container keeps: {…}`), so no text is built in `.tsx`. After an apply the notifier's dedupe set is cleared for that session (a later reattach with a still-different value is news again).

*TUI.* `SLASH_COMMANDS` gains `{ name: "/settings", description: "apply this laptop's settings to the session (/settings apply)" }`. A pure `settingsCommand(args, { running, compacting, available })` in a new `tui/src/settings-command.ts` decides: not `apply` → usage notice; `!available` → "isn't available for this session"; busy → "Can't apply settings while a turn is running" (the daemon check is the truth; this is UX); else `{ kind: "apply" }`. `App.tsx` adds one `case "/settings"` that calls `session.updateSettings()` and `pushNotice`s the lines (pattern `/compact`, `App.tsx:1802-1850`; no `compactingRef` involvement). Daemon refusals (`TurnInProgress`, `CompactInProgress`, `MethodNotFound`, a drop) map to a notice by code.

**What changes for the running session:** every carried key, since the whole agent is rebuilt from `applyCarried(podConfig, settings)`: P keys (laptop wins), W keys where the pod set nothing, the recomposed prompt and skill set when `loadAgentsMd` / `loadSkills` flipped (and a later context reset agrees, since it reads the merged config). **What does not change:** the conversation, background jobs, session approvals, the broker, other terminals' attachments, the replay ring.

**Which settings are applied:** the ones this terminal's runtime carries (`deps.sessionSettings`, built at runtime creation from the config at that moment, `engine-runtime.ts:625, :1019`; the same value the drift notice compares against). Editing `config.jsonc` after the TUI started is not re-read; restart/re-attach picks it up (Owner Q2).

### Files

Dependency order; smallest diff.

1. `packages/protocol/src/session.ts` (params/result schemas + the rule block), `methods.ts` (method + `RequestSchemas`), `schema/protocol.json` (generated). No `version.ts` change.
2. `packages/agent/src/session.ts` (`replaceAgent`), `agent.ts` (`retire`, `adoptExits`, keep the unsubscribe).
3. `packages/daemon/src/session-host.ts` (`AgentContext.reuse`, factory return `grants`, `updateSettings`), `hosted-session.ts` (`assertIdle` visible, `reusable()`, `swapAgent`, mutable `titleModel`), `connection.ts` (dispatch case).
4. `packages/client/src/remote-client.ts` (`updateSettings`), `remote-session.ts` (`updateSettings`).
5. `packages/cli/src/wiring.ts` (`jobs?`/`grants?` options, `WiredAgent.grants`), `serve.ts` (`reuse` through `tunnelledAgent` / `podSessionHost`), `carried-settings.ts` (`appliedLine`, notifier reset), `local-runtime.ts` (`PersistingController.updateSettings`).
6. `packages/tui/src/commands.ts` (entry), `settings-command.ts` (new, pure), `App.tsx` (one `case`, `SessionController.updateSettings?` optional method).
7. `CHANGELOG.md`; `docs/feat/config-carry.md` Notes (the `(/clear to reset)` hint now has the second way out) and the hint text in `settingsNotices` becomes `(/settings apply, or /clear)`; `TODO.md` at merge.

Tests (new): `packages/daemon/test/update-settings.test.ts`, `packages/agent/test/replace-agent.test.ts`, `packages/protocol/test/update-settings.test.ts`, `packages/tui/test/settings-command.test.ts`; extended: `packages/cli/test/model-proxy.test.ts`, `packages/cli/test/carried-settings.test.ts`, `packages/client/test/remote.test.ts`, `packages/tui/test/app.test.tsx`, `packages/protocol/test/json-schema.test.ts` (regenerated schema).

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| **Turn or compaction running** (any terminal's) | `assertIdle` throws `TurnInProgress` / `CompactInProgress` before anything is built. TUI notice | Nothing changed; the user retries when idle |
| **A turn starts on another terminal while the request is in flight** | The handler is one synchronous stretch: whichever reaches the slot first wins. If the turn won → refusal above; if the apply won → the turn starts on the new agent | Atomic either way; never a turn on half a swap |
| **Factory throws** (`buildAgent`, a bad config) | The exception is raised before `swapAgent`; the old agent, its subscriptions and the report are intact. The error reaches the TUI | State unchanged (pinned by T5) |
| **Daemon ignores settings** (`serve`, worker: the factory returns no report) | `{ applied: false }`, throw-away agent retired; TUI says the daemon uses its own config | No change |
| **Version skew: new laptop, kept v16 resident without the method** | `MethodNotFound` → client message "predates /settings apply; attach again to replace it". No `VersionMismatch` (same protocol version) | The existing attach-replace flow |
| **Version skew: old laptop, new daemon** | The laptop never calls the method | Unchanged |
| **Disconnect mid-call** | `sessionCall(…, "once")` rejects; the daemon may or may not have applied. The call is idempotent: running `/settings apply` again lands on the same state, and the re-attach's `OpenResult.settings` report shows the truth through the existing drift notice | Converges by re-run or re-attach |
| **Pending job exits at the swap** | Moved from old to new agent (`retire` → `adoptExits`); the live `background_exit` stream is untouched because `HostedSession` owns that subscription (`hosted-session.ts:451`) | No lost "[background] job … exited" note (T4) |
| **Background jobs still running** | The same `BackgroundJobs` instance is reused; the session list's `jobs` count (`hosted-session.ts:903`) stays right | Kept |
| **Session approvals (`SessionGrants`)** | The same instance is passed to the new agent and its sub-agent runner | No re-prompt for what the user already allowed (T3) |
| **Project hooks trust** | New `HookRunner` → trust state `unknown` again; the next turn may ask the laptop once more (`hooks/trust`, which is gated on the laptop and never stored for a pod) | Accepted, in Notes; carrying the state is a follow-up |
| **`loadAgentsMd`/`loadSkills` flipped** | `messages[0]` replaced in place; skills/tool recomposed by `applyCarried`; a context reset afterwards agrees | T7. If `messages[0]` is not a system message the history is left alone and the new agent still has the new tools/skills (documented limit) |
| **Other attached terminals** | Not notified (no new update). Their next turn runs on the new agent; their drift notice, computed at their open, may be stale until they reattach | Accepted, in Notes. A display-class update would be the follow-up (`UPDATE_CLASS`, AGENTS §7) |
| **Session closed or deleted meanwhile** | `lookup` throws `UnknownSession` | Visible error |
| **Hostile pod** | Cannot start the flow (the method is laptop → daemon). It can ignore the request, or lie in `settings`: at worst a false notice; names are filtered by the laptop's table and text is never printed (`carried-settings.ts:~300-320`). A malformed result rejects that request (`peer.ts:449`). No laptop effect, no approval is created | §7 holds |
| **Pod-originated `session/update_settings` toward the laptop** | `RemoteClient` answers unknown requests `MethodNotFound` (`remote-client.ts:1139`) | No effect |
| **Autotitle toggled** | `titleModel` is swapped with the agent; the laptop's own gate on title calls stays (`remote-client.ts:1955-1967`) | Laptop decides |
| **Invalid value** | Same bounds as `session/open.settings` (`SessionSettingsSchema`); a bad one is `InvalidParams` before the handler | Nothing built |

### Tests

Red first on the unimplemented code, each with one mutation that must turn it red. Fakes: `createChannelPair`, `Connection`, `SessionHost` with a fake `AgentFactory` (as `daemon/test/session-settings.test.ts`), `RemoteClient` over the pair, the `model-proxy.test.ts` pod setup. No new fakes.

| # | Property pinned | Mutation |
|---|---|---|
| T1 | Schema: `update_settings` params keep `settings` with the same bounds as open; `applied`/`report` result round-trips; zod and the JSON Schema agree | Drop a bound / the result field |
| T2 | **Replaces the agent**: after an apply the next turn runs on the agent the factory built from the NEW settings (factory called with `settings` and `reuse`; second agent's model sees the call) | `swapAgent` keeps the old agent |
| T3 | **Grants survive**: a session approval granted before the apply still covers the call after it, with no new ask | Do not pass `grants` in `reuse` |
| T4 | **Pending exits survive**: a job that exits while idle, then apply, then a turn: the model gets the `[background] job … exited` note exactly once; the old agent is unsubscribed (a later exit is not pushed twice) | Skip `retire`/`adoptExits` |
| T5 | **Atomic**: factory throws → old agent still answers the next turn, report unchanged | Swap before building |
| T6 | **Busy**: a running turn and a running compaction each refuse with their code, factory NOT called | Drop `assertIdle` |
| T7 | **Prompt recompose**: carried `loadAgentsMd: false` over an unset pod → the next request has no AGENTS.md text; `messages.length` unchanged; head not a system message → history untouched; a context reset afterwards agrees | Swap agent without replacing `messages[0]` |
| T8 | **Report**: result carries `overridden` for a W key the pod set; `HostedSession.settingsReport` is replaced, so a later attach's `OpenResult.settings` shows the new values | Leave the old report |
| T9 | **No-honour daemon** (`serve`-style factory, no report): `{applied:false}`, old agent kept, throw-away agent retired | Swap anyway |
| T10 | **Race**: an apply and a prompt issued in the same tick on one session end in exactly one of the two orders, never a turn on a half swap (run both orders deterministically) | Insert an `await` between check and swap |
| T11 | **Client**: no `sessionSettings` → rejects locally, nothing on the wire (frame spy); `MethodNotFound` → the "predates" message; call is `once` (not re-sent after a drop) | Send without settings; mark it `keyed` |
| T12 | **Persisting controller**: apply is followed by a snapshot flush (saved copy has the new head); absent when `sessionSettings` is unset (worker, connect) | Skip `flush`; expose it everywhere |
| T13 | **Pure `settingsCommand`**: `apply` / no args / unknown arg / unavailable / busy table | Treat the unknown arg as apply |
| T14 | **TUI frames** (`ink-testing-library`, pattern `app.test.tsx`): `/settings apply` shows the confirmation and the `Container config:` line; while running it shows the busy notice and calls nothing; `/help` lists it | Remove the `case` |
| T15 | **End to end** (`model-proxy.test.ts` setup): a laptop with `maxIterations: 3` attaches to a live session created with other values; before the apply the drift notice is shown, after it the session's agent runs with 3 and a fresh attach shows no drift | Do not forward `reuse`/`settings` in `podSessionHost` |
| T16 | `connect` and the worker expose no `updateSettings`; `serve` given the call answers `applied:false` | Set the option in `connect.ts` |

Gate (§4): the narrow file per slice, then `bun run check`; lint baseline stays clean. Suggested slice order inside the branch: S1 protocol+daemon+agent seam (T1-T10), S2 client+cli+tui (T11-T16).

### Size and blast

**Size: L.** About 17 source files across 7 packages (`protocol`, `agent`, `daemon`, `client`, `cli`, `tui`, plus docs) and a new seam (`Session.replaceAgent`, factory `reuse`). TODO.md's `M` assumed a daemon method plus a command; the agent swap and the state hand-over (grants, exits, jobs, title model) are what push it over. **Blast: load-bearing.** It touches the agent's lifecycle (§10: "the agent loop, or a seam many depend on"), the factory contract, and the protocol. Per §10: a strong model executes, and Review is mandatory fresh-context. If the owner prefers a smaller first step, the natural split is S1 (daemon + protocol + test via RPC only, no TUI) merged first, S2 (client + TUI) next; both on this one branch unless the owner says otherwise.

### Notes / debt (deliberately left)

- Other attached terminals get no live signal and a possibly stale drift notice until they reattach. Follow-up: a `display`-class update `settings_changed` (classified in `UPDATE_CLASS`, `protocol/src/updates.ts:271`).
- Project-hook trust is re-asked after an apply (new `HookRunner`). Follow-up: pass the `ProjectTrustState` through `reuse`.
- The settings applied are the runtime's, not a fresh read of `config.jsonc` (Q2).
- The `(/clear to reset)` hint text changes with this task.

### Implementation — extension for the owner answers (2026-11-06)

*— claude-opus-5-5, 2026-11-06*

Re-verified on `feat/session-settings-apply` @ `c42cb43`; every `file:line` below is at that commit. The plan above stands except where this section says otherwise (it wins on conflict). Repro re-run before any edit: `rg -n "update_settings|settings apply|\"/settings" packages` → no match.

#### Slices (Q3 = A)

- **S1 protocol + daemon + agent seam:** the plan's T1–T10, plus the `session_settings` update emitted by the daemon (below) and the report's `containerKeys`.
- **S2 client + cli + tui:** T11–T16, plus the live notice to other terminals (Q4 = B) and `/settings` alone (item 6).
- **S3 the plain-attach `session/open` bound (Q1 = B).**

#### Corrections to the plan found while verifying

1. **The plan's "No new update" for other terminals is superseded** (Q4 = B): a display-class update, below.
2. **The report cannot tell "container-set" today.** `applyCarried` puts a W key in `overridden` only when the pod's value DIFFERS from the carried one (`carried-settings.ts:242-246`; pinned by `carried-settings.test.ts:332-336` "a pod that sets the SAME value overrides nothing worth saying"). Item 6 wants every container-set key marked `(container)`, and an honest `This terminal differs` must leave such a key out (an apply cannot change it). Example: the container sets `maxIterations: 7`, the session carried 7, this laptop has 3. Without the mark, `/settings` promises a change that the apply does not make. **Fix (additive):** `SessionSettingsReport.containerKeys?: string[]`, the carried W keys whose value comes from the pod's own env or file, whatever that value is (`config.sources[row.source] !== "default"`, the same test as `:237`). The pod sends it, so it is untrusted: `z.array(z.string().min(1).max(64)).max(64)`, never an enum, so a newer daemon's key does not reject the whole report. The laptop keeps only names in `CARRIED` (`Object.hasOwn`), as `settingsNotices` already does. `overridden` keeps its meaning (no change to the test at `:332`). The marked set is `containerKeys ∪ keys(overridden)`, so the mark degrades gracefully against an older daemon that sends no `containerKeys`.
3. **The `/compact` notice path cannot draw the grey hint.** `pushNotice` makes an assistant notice item (`App.tsx:908-915` → `pushNoticeItem`, `state.ts:266`). The blue `theme.notice` text plus the grey hint is the NOTICE item (`appendNotice`, `state.ts:140-152`, drawn by `noticeLines`, `render-lines.ts:587-598`). `/settings` lines therefore go through `appendNotice(…, { hint })`, the same shape as the host notices (`App.tsx:688-701`) but without `host`.
4. **The factory may ignore `reuse`.** The non-proxy branch of `podSessionHost` builds with no reuse (`serve.ts:479-481`). The daemon never adopts an agent whose `permissions`/`jobs` are not the hosted session's own: `HostedSession` installed its requester on THAT broker once (`hosted-session.ts:443`) and streams exits from THAT `jobs` (`:448-456`). With no `settingsReport` → `applied: false` (as planned). With a report but foreign `permissions`/`jobs` → the throw-away agent is retired, foreign jobs are disposed, and `InternalError` "the agent factory did not reuse the session's broker/jobs". This is a programming error, never reached by `tunnelledAgent`.

#### S3 — bound the plain attach's `session/open` (Q1 = B)

**The hang (verified).** Both eager attaches await `runtime.attachTo` BEFORE Ink mounts: the plain path at `main.ts:1573-1575` (`.catch(() => false)`) and the join path at `attach-run.ts:365-369`. `attachTo` (`local-runtime.ts:706-724`) → `controller.open()` → `RemoteSession.open` (`remote-session.ts:269-293`) → `RemoteClient.attachSession` (`remote-client.ts:581-601`) = `openOn` + `whenLive`. No step has a deadline:
- `peer.request` has a timeout only when `requestTimeoutMs` is set (`peer.ts:163-169`), and `RemoteClient` never sets it (session/prompt is long).
- Liveness (`remote-client.ts:1187-1240`) closes the link only when a watched request sees NO inbound frame for `LIVENESS_MS` = 15 s (`link-machine.ts:25`). A pod daemon that is alive but never answers this `open` while it sends anything else (another session's updates, a `model/stream` of another turn) never trips it.
- When it does trip, the drop path redials, and `openOn` returns silently on a drop (`remote-client.ts:1500-1503`, "the next generation opens it again"). `dialFailed` backs off for ever on any non-terminal error (`link-machine.ts:129-147`, cap 30 s), and `whenLive` (`:1795-1823`) rejects only on stop, close or failure.

So a pod that never answers, or a link that never comes back, leaves the terminal on the pre-mount status line for ever.

**Design.** The bound lives in the ONE attach seam, `RemoteClient.attachSession`. It covers every caller (both paths above), adds no second code path, and runs on the injected `clock`, so tests drive it deterministically.
- `ATTACH_TIMEOUT_MS = 30_000` (2 × `LIVENESS_MS`: one dead-link verdict, one redial, one open), exported from `client/src/constants.ts`. It bounds the WHOLE attach: open answered AND live, snapshot paging and any reconnects included. A bound on the open alone would leave "answered, then the link died and never came back" unbounded.
- On expiry, if the attach has not settled: the entry is unregistered when it was never live and is still the registered one (`this.sessions.get(id) === entry`, the same rule as the existing catch at `:594-597`), and its `listener` is cleared. A late `open` result or snapshot is then ignored: `applyOpenResult` checks `this.sessions.get(entry.id) !== entry` (`:1520`). The promise rejects with `AttachTimeoutError`, a new exported class with the message `no answer from the daemon within 30s (session/open)`. A settled attach clears the timer.
- **No close is sent.** A rejected `open()` leaves `RemoteSession.opening`/`id` null (`remote-session.ts:283-287`), so `close()` (`:487-503`) is a no-op. `attachTo`'s catch (`local-runtime.ts:709-711`) is therefore safe: a timeout never ends a shared session.
- **The daemon may still attach this connection later** (the `open` was only slow). That costs a stray connection-scoped attachment (updates for an id this client no longer routes are dropped, `onUpdate`, `:1679-1684`), which ends with the connection. No `session/detach` is sent: it could overtake the slow `open` and prove nothing.

**What the user sees.**
- Plain path (`main.ts`): as for any failure today, the session opens lazily from the record at the first prompt (create-or-attach, atomic daemon-side). It is no longer silent, though: on `AttachTimeoutError` a host notice goes through `sessions.notices.notify`, which buffers until the TUI subscribes (no raw write, AGENTS §7): `Could not attach to the session: no answer from the container within 30s. It opens at your first prompt.`
- Join path (`attach-run.ts`): the existing failure branch, pre-mount and plain text: `[attach] failed: no answer from the daemon within 30s (session/open)`, then exit 1. The relay connection is closed and the runtime released, as for any attach error (`:370-375`).

**Failure modes (S3).**

| Case | Outcome |
|---|---|
| Open answered, live within 30 s | Timer cleared; unchanged behaviour |
| Daemon alive, never answers the open | Rejects at 30 s; plain → lazy + notice; join → exit 1 |
| Link dead, redials fail for ever | Same at 30 s (before: hung for ever) |
| Open answers at 31 s | Ignored (entry unregistered); the lazy open at the first prompt attaches again |
| A huge history whose snapshot takes > 30 s on a slow link | A false timeout. Plain: harmless (lazy + notice; the first prompt attaches). Join: exit 1, retry. Accepted, in Notes |
| `UnknownSession` / `SessionArchived` / `SessionDeleted` before the deadline | Unchanged (they reject first; timer cleared) |
| `close()` of the runtime during the attach | Unchanged (`stopError` rejects `whenLive`); timer cleared |

**Tests (S3).** In `packages/client/test/reattach.test.ts` style, with the existing fake clock:
- T17: an attach whose `open` is never answered rejects with `AttachTimeoutError` exactly at `ATTACH_TIMEOUT_MS` (not before), the entry is gone, and a late answer changes nothing. Mutation: no timer.
- T18: an attach answered in time is not rejected when the clock passes the deadline. Mutation: the timer is not cleared on settle.
- T19: the plain path turns the timeout into the notice (a `main`-level seam test if one exists; else the decision is a small pure function `attachFailureNotice(error)` in cli, unit-tested). Mutation: notice dropped.

#### S2 — live notice to other attached terminals (Q4 = B, Q5 = A)

**Protocol (display class, free: AGENTS §7).** A new `session/update` variant:
`SessionSettingsUpdateSchema = { type: "session_settings", settings: SessionSettingsReportSchema, id?: string(1..128) }`, a union member (`updates.ts:230-250`) with `UPDATE_CLASS.session_settings = "display"` (`:271-295`). Rationale (comment in the schema): a label only. The report is also in every `OpenResult`, and skipping it hangs nothing. `id` is the `session/update_settings` request's client-chosen `id` (new required param, see below). It is the "mine" key, the same pattern as `steer.id`/the queue rows (`session.ts` queue comment): the terminal that applied the change knows it, every other terminal does not.
- **Wire both ends.** The daemon's `HostedSession.swapAgent` emits it (`emit`, `hosted-session.ts:1078`, idle-safe like `session_title`, `:1639`). On the client, `deliver` (`remote-client.ts:1758-1771`) gets a `session_settings` branch beside `session_title`/`queued`. `client/mapping.ts` `updateToEvent` lists it with the non-turn-scoped `null` cases (`:276-287`; the exhaustive switch makes a missing case a compile error).
- **Client state.** `SessionEntry.settings?: SessionSettingsReport` is the newest report: from an open (`noteSettings`, `:1540-1547`), an own apply's result, or this update. The ids of this client's own applies sit in a `Set` (added before the frame leaves; removed when the update arrives, or when the daemon refuses). On a `session_settings` update: `previous = entry.settings`, `entry.settings = update.settings`. If `update.id` is NOT one of mine, `onSessionSettingsChanged` listeners get `{ sessionId, previous, report }`. If it is mine, nothing is told (the applier prints its own confirmation). `settingsOf(sessionId)` exposes the newest report.
- **Text (pure, cli).** `changedNotice(previous, next)` lists the keys whose shown session value changed (value or container mark), with the NEW values, in the one-line format of `valuesLine` (`carried-settings.ts:314-320`) plus the `(container)` mark: `Session settings changed by another terminal: { "maxIterations": 3 }`. `previous` undefined → every key of `next`. Nothing changed (an apply of equal values) → no notice. It goes through `deps.notify` (blue `theme.notice`, no hint), subscribed in `createLocalRuntime` beside the notifier (`local-runtime.ts:573-576`) and under the same condition (`deps.sessionSettings && deps.notify`).
- The drift notifier's dedupe gains `forget(sessionId)` (called after an own apply and after a change by another terminal), so a later re-attach that still differs is news again. `createSettingsNotifier` returns `{ notice, forget }`.

**Failure modes (live notice).**

| Case | Outcome |
|---|---|
| Older client (v16 build without it) | Skips the unknown display update and shows `unsupported` once per kind (`protocol-v10` rule). No hang |
| Older daemon | Never emits it; nothing to show |
| The applier reconnects and the ring replays its own update | Replays deliver only seq > `since` (reducer). Seen before → not re-delivered; not seen → its id is still in the set (only an arrival removes it), so it stays silent |
| A drop before the applier's response | The id stays in the set; if the update arrives later it is silent (own) |
| A hostile pod sends a fake `session_settings` | At worst a false notice, of validated numbers, booleans and enums under the laptop's table names; any text is `(text differs)` (`shown`, `:302-311`). No effect, no approval (AGENTS §7) |
| A hostile pod reuses an applier's id | At worst a missing notice on that terminal. No effect |

**Tests.** T20: the daemon emits exactly one `session_settings{settings, id}` per successful apply to EVERY attachment, the applier's included, classified display (no `mandatory` flag). None on a refusal, a factory throw or `applied: false`. Mutation: no emit. T21: client, two `RemoteClient`s on one session: the applier gets no changed-notice, the other gets `{previous, report}`, and `settingsOf` is updated on both. Mutation: tell the applier too (drop the id check). T22: `changedNotice` table: changed key only; equal → none; previous absent → all; container mark change; text hidden. Mutation: list unchanged keys.

#### S2 — `/settings` alone (item 6)

**View-model (pure, cli):** `settingsShowLines(mine, report)` in a new `packages/cli/src/settings-view.ts`, unit-tested. `changedNotice` and `appliedLines` live there too: the three texts of this task share `shownValuesLine` with `carried-settings.ts`, which exports `valuesLine`/`shown` for it. Its result, in order:
1. `Session settings: { … }`: ALL the session's keys, in `CARRIED` order. Each shows the value that runs: `overridden[key] ?? carried[key]` (keys absent on both sides are left out). A container-set key (`containerKeys ∪ keys(overridden)`, filtered by `CARRIED`) prints `"tools.maxIterations": 7 (container)`, a JSON-like one-liner with the mark after the value. `agentTaskDescription` prints `(text differs)` only when it differs from mine; equal, it prints `(same text)`. The text is never printed (AGENTS §7).
2. Only when this terminal differs: `This terminal differs: { … }` with hint `(/settings apply)`. It shows THIS terminal's values of the keys an apply WOULD change: `mine[key] !== carried[key]` and not container-set. A key mine lacks but the session has prints `(default)`.
3. Else: `This terminal matches.`

**Other states (decided here, no owner question: they follow from the answers):**
- No report and the session is not open yet (a fresh `run` before its first prompt; sessions open lazily) → `The session is not open yet: it starts with this terminal's settings.` The same line answers `/settings apply`.
- Open but no report (a daemon that decides by its own config) → `This session takes its settings from the container's own config.`
- A runtime that carries nothing (worker, `connect`): the command is not offered as available → `/settings isn't available for this session.`

**TUI.** `SessionController.settings?(): SettingsCommandView` returns the lines `{ text, hint? }[]` (sync), and `updateSettings?(): Promise<SettingsLine[]>`. Both come from `PersistingController`, only when `deps.sessionSettings` is set. The pure `settingsCommand(args, { running, compacting, available })` (`tui/src/settings-command.ts`) returns `show | apply | notice(text)`: `""` → show; `apply` → apply unless busy or unavailable; anything else → usage `Usage: /settings (show) · /settings apply`. `App.tsx` adds one `case "/settings"` that maps lines to `appendNotice(…, { hint })`.

**Tests.** T23: `settingsShowLines` table: all keys and their order, the container mark from `overridden` and from `containerKeys`, unknown names filtered, differs vs matches, `(default)`, description hidden. Mutation: drop the container exclusion from "differs". T24: TUI frame: `/settings` prints the lines (blue text, grey hint stripped to text by the harness), and `/help` lists `/settings`. Mutation: remove the case.

#### `session/update_settings` params (refined)

`{ sessionId, id: string(1..128), settings }`. `id` is client-chosen, echoed in the update; the daemon does not dedupe by it (the call is idempotent by value; `once` on the client, as planned). Result `{ applied: boolean, settings?: SessionSettingsReport }`.

#### Texts (Q5 = A)

| Where | Text |
|---|---|
| Drift notice hint (`settingsNotices`) | `(/settings apply, or /clear)` (was `(/clear to reset)`) |
| Own apply, success | `Session settings applied.`, then the existing `Container config: { … }` line when the container keeps a value different from mine |
| Own apply, `applied: false` | `This session takes its settings from the container's own config: nothing to apply.` |
| Other terminals | `Session settings changed by another terminal: { … }` |
| Busy (TUI pre-check, and the daemon's `TurnInProgress`) | `Can't apply settings while a turn is running.` |
| `CompactInProgress` | `Can't apply settings while a compaction is running.` |
| `MethodNotFound` (an older v16 resident) | `This container's tentacle predates /settings apply: quit and attach again to update it.` (a stale pod binary is replaced at attach when idle, `pod-resident.ts:646-660`) |
| A drop before the answer | `The connection dropped before the daemon answered: run /settings apply again.` |

#### `PROTOCOL_VERSION`: stays 16 (no bump), and why

- `session/update_settings` is a new METHOD: "fields and methods are free" (AGENTS §7). An older daemon answers `MethodNotFound`, which the client maps to the text above. An older client never calls it.
- `session_settings` is a new DISPLAY update: "display: free to add" (AGENTS §7, `UPDATE_CLASS`). An older client skips it (`unsupported` once). It is never `mandatory` or `blocking`: nothing waits on it, and the same report rides every `OpenResult`.
- `containerKeys` is a new optional FIELD of the report: free. An older laptop strips it (strip schemas), and an older daemon sends none (the mark falls back to `overridden`).
- No field changes meaning and none is removed (`overridden` is untouched, see correction 2). The hint text is laptop-only. No on-disk format changes (a pod persists nothing; the laptop record is unchanged). Nothing is truly breaking, so a bump would only force a needless `VersionMismatch` on every mixed pair.
- `schema/protocol.json` is regenerated (`bun run schema:export`) for the new method, update and field.

#### Files (additions to the plan's list)

- protocol: `updates.ts` (variant + class), `session.ts` (`containerKeys`, `UpdateSettings*` with `id`), `methods.ts`, `schema/protocol.json`.
- client: `constants.ts` (`ATTACH_TIMEOUT_MS`), `remote-client.ts` (attach bound + `AttachTimeoutError`, `updateSettings`, `settingsOf`, `onSessionSettingsChanged`, own-id set, `deliver` branch), `mapping.ts` (null case), `remote-session.ts` (`updateSettings`, `settingsReport`), `index.ts` (exports).
- cli: `carried-settings.ts` (`containerKeys` in the report, hint text, `forget`, exports), `settings-view.ts` (new, pure), `local-runtime.ts` (controller methods, changed-notice subscription), `main.ts` (timeout notice).
- tui: `commands.ts`, `settings-command.ts` (new, pure), `App.tsx`.

#### Notes / debt (added)

- The attach bound can fire falsely on a > 30 s snapshot over a slow link. Plain path: harmless; join path: exit 1 and retry. Raising the bound or excluding snapshot paging is a follow-up if it is ever seen.
- A slow `open` that lands after the timeout leaves a connection-scoped attachment until the connection ends (no detach sent, on purpose).
- `/settings` shows this terminal's carried values from runtime start (Q2 = A), not a re-read of `config.jsonc`.

## Execution

*— claude-opus-5-5, 2026-11-06*

**As built, in the plan's order.**

- **S1 protocol + agent + daemon.** `session/update_settings` (`methods.ts`, `session.ts`), the display update `session_settings` (`updates.ts`, `UPDATE_CLASS`), the report's `containerKeys`. `Session.replaceAgent` (returns the replaced agent), `Agent.retire` / `adoptExits`. `AgentContext.reuse`, the factory's `grants`, `SessionHost.updateSettings` (synchronous from `assertIdle` to the swap), `HostedSession.reusable` / `swapAgent`, the `Connection` case (no lock).
- **S2 client + cli + tui.** `RemoteClient.updateSettings` / `settingsOf` / `onSessionSettingsChanged`, the own-id set, the `deliver` branch, the `mapping.ts` null case. `buildAgent` options `jobs` / `grants`, `reuse` through `tunnelledAgent` and `podSessionHost`. `carried-settings.ts` (`containerKeys`, `DRIFT_HINT`, `forget`), new pure `settings-view.ts`, `PersistingController.settings` / `updateSettings`, the changed-notice subscription. New pure `tui/src/settings-command.ts`, the `/settings` entry, one `case` in `App.tsx`.
- **S3 attach bound.** `ATTACH_TIMEOUT_MS`, `AttachTimeoutError` and the deadline in `attachSession`; new pure `cli/src/attach-notice.ts`, used by the plain path in `main.ts`. The join path needed no code: its existing failure branch prints the error's message.
- **Docs.** CHANGELOG `[Unreleased]`, README, `config-carry.md` Notes. `TODO.md` is left for the merge.

**Protocol.** `PROTOCOL_VERSION` stays 16 (reasons in the extension above). `session_settings` also joined the sample list of `daemon/test/mapping.test.ts`.

**Drift from Implementation.**

1. `RemoteSession`'s methods are `applySettings()` and `settingsState()`, not `updateSettings` / `settingsReport`. The planned names collided with `SessionController`, and `connect` passes a `RemoteSession` straight to the TUI as a controller. With the new names `connect` exposes no `/settings` by construction.
2. **`schema/protocol.json` was edited by hand.** `bun run schema:export` and the direct script both need an approval this session could not get. The drift gate (`json-schema.test.ts`, `deepEquals` against the generated document) passes and Biome formatted the file, so the content is exact; the orchestrator can run `bun run schema:export` and expect no diff. The new method and update also have zod ⇔ JSON Schema fixtures.
3. T3 is weaker than planned: it proves hand-over by identity (the daemon passes the session's `grants`, `tunnelledAgent` returns the same broker, jobs and grants), not by running a call that a session approval covers. The gate reading `config.grants` is unchanged code.
4. T19 is the pure `attachFailureNotice`; there is no `main`-level seam, so the `main.ts` call site is not exercised by a test. The join path's printed line is not pinned by a test either.
5. T14's busy case is pinned on the pure `settingsCommand`, not in a frame. T16's `connect` case rests on drift 1 and on `connect.ts` passing no `sessionSettings`; the worker case is tested through `createLocalRuntime`.
6. Added beyond the plan: `askContext(session)` after an apply (the open figure may be stale, as after a compaction), and the exported `DROPPED_NOT_RETRIED`, so the drop's line compares this client's own marker rather than a copied text.

**Red first, honestly.** Red was shown before the code for the protocol, agent, daemon, client and attach-bound tests and for `settings-command`. `settings-view.test.ts` was written first but not run red. The `carried-settings` additions, the App frame tests, `attach-notice`, `model-proxy` and `settings-apply-runtime` were written with or after the code: for those the proof is mutation only.

**Mutations (21, all red; each restored, `shasum` identical).**

| Mutation | Red test |
|---|---|
| `containerKeys` unbounded | protocol "bounded" |
| `retire` keeps listening | replace-agent T4-style pair |
| Head not replaced | replace-agent; alone, T7 and T12 |
| No `assertIdle` | T6 (both), T10 |
| No `grants` in `reusable` | T3 |
| No `retire` / `adoptExits` | T4 |
| No `session_settings` emit | T20 |
| Applier told too | T21 |
| No deadline race | T17 (both) |
| No container exclusion in "differs" | `settingsShowLines` |
| `changedNotice` lists unchanged keys | `changedNotice` (3) |
| `containerKeys` only when different | `carried-settings` |
| `forget` forgets nothing | `carried-settings` |
| `apply…` prefix accepted | `settingsCommand` |
| App `case` removed | App frames (2) |
| No `reuse` forwarded in `podSessionHost` | T15 (with T7) |
| No `flush` after an apply | T12 |
| `new SessionGrants()` in `buildAgent` | T3 (`tunnelledAgent`) |
| Attach notice always null | `attachFailureNotice` |
| `carried` set with no `sessionSettings` | "offers no command" |

Some ran in batches of 2 to 6, on files with independent tests; the table's attribution comes from which test failed (the head and `carried` mutations were then rerun as their own batch). A timer not cleared on settle is an equivalent mutant (`forget` is guarded by `everLive`, and the race has settled), so T18 pins "an answered attach stays live", not the clear itself.

**Gate (final run, after the last edit).** `bunx tsc --noEmit`: clean. `bunx biome check .`: `Checked 689 files`, no findings. `bun test packages`: `5060 pass, 3 skip, 0 fail` (the three opt-in skips; no flake appeared). Before that run, the gate had caught a missing `flushNow` hook dependency and the `mapping.test.ts` sample list; both are fixed. No stray generated files.

**Unverified.**

- No live run on a real pod, Docker or k8s: the checklist below.
- `tsc -p apps/mobile` (part of `bun run typecheck`, outside this gate): not run. The mobile app has no `session_title` consumer (`rg` over `apps/mobile`).
- **A terminal away during two or more applies (reasoned from the code, no test):** it reopens with the newest report, then the replay delivers the older `session_settings` updates, so it may print stale `changed by another terminal` lines before ending on the right values. The state converges and only the notices are noisy. A terminal away during one apply gets no `changed` line, only the drift notice if it still differs. The fix would be a revision on the report: a follow-up, for the Review to weigh.
- After an apply the new agent has no context anchor, so its first request counts from the estimate, not the provider's last measure (`anchors`, `agent.ts`). Project-hook trust is asked again, as planned.

**Owner live checklist.**

1. `run` a session, quit, change `maxIterations` in the config, `attach`: the drift notice ends with the grey `(/settings apply, or /clear)`.
2. `/settings`: all the settings on one line, then `This terminal differs: { … } (/settings apply)`, with the hint grey.
3. `/settings apply`: `Session settings applied.`; the next turn obeys the new limit; the conversation is intact; a running background job and a "Yes, always" approval survive.
4. Set the same key in the container's own config: `/settings` marks it `(container)`, it is not listed under "differs", and an apply leaves it.
5. With a second terminal attached, apply from the first: the second shows `Session settings changed by another terminal: { … }` in blue; the first does not.
6. `/settings` with no difference: `This terminal matches.`
7. `/settings apply` during a turn: `Can't apply settings while a turn is running.`
8. A pod that never answers `session/open` (for example, `kill -STOP` the resident daemon): a plain `attach` reaches the TUI after 30 s with `Could not attach to the session: no answer from the container within 30s. It opens at your first prompt.`; attaching to a detached run prints `[attach] failed: no answer from the daemon within 30s (session/open)` and exits 1.

## Review

*— claude-opus-5-5, 2026-11-06*

Fresh context, but the **same model as the executor** (`claude-opus-5-5`): shared blind spots can survive both passes. This is a load-bearing task, so a different model is worth a second look if the owner wants one (AGENTS §10).

**Verdict: REQUEST-CHANGES.** One MEDIUM finding (F1, in S3). The agent swap, the §7 invariants and the protocol hold; everything else is LOW.

### Findings

**F1 — MEDIUM: the attach bound kills a slow but progressing attach, and on two of the three callers a retry cannot succeed.** `packages/client/src/remote-client.ts:656` races one fixed 30 s deadline against the whole attach, snapshot paging included (`ATTACH_TIMEOUT_MS`, `client/src/constants.ts`).
- **Reproduced** (real `RemoteClient`, manual clock, open answered at once, one snapshot page every 10 s):
  ```
  t=10s pages served=1 outcome=pending
  t=20s pages served=2 outcome=pending
  t=30s pages served=3 outcome=AttachTimeoutError
  ```
- **The plan's premise is false.** It says the bound "covers every caller (both paths above)" and analyses `main.ts` and `attach-run.ts`. There is a third caller: `connect.ts:252` (`await session.open()`), which has no lazy fallback and throws `openError`. Neither the failure table nor the CHANGELOG mentions it.
- **"Join: exit 1, retry" does not converge.** The history is the same size on every retry, so the same link times out again. On `main` these attaches were slow but finished. Now a long enough history on a slow enough link (about 4 MB at 1 Mbit/s) cannot be opened on `connect` or a detached-run join, and nothing can raise the bound. The plain `attach` is fine (lazy fallback).
- **Fix (owner question 1):** bound the wait for an answer, not the transfer. Re-arm the deadline whenever this attach makes progress (the open answered, each snapshot page). A daemon that never answers and a link that never returns still fail at 30 s.

**F2 — LOW: an applier's response can overwrite a newer report.** `remote-client.ts:760` writes `entry.settings = result.settings` unconditionally. Two clients on an in-memory channel pair, `Promise.all` of both applies: the session ran `maxIterations: 4`, while A's `settingsOf` stayed at 3, so A's `/settings` would claim the old value until a re-open. **Not reproduced on a real transport:** it needs B's handler to run between A's handler and A's response, which are separated only by microtasks (`peer.ts:351-356`), so separate sockets should keep the order. Fix: skip the write when the own update already arrived (its id has left `ownSettingsIds`).

**F3 — LOW: `NOT_OPEN` can be false.** After a timed-out plain attach the controller has no id, so `/settings` and `/settings apply` say "it starts with this terminal's settings" (`settings-view.ts:32`, `local-runtime.ts:520`). The session may be live with other values, and the first prompt attaches to it and keeps them. The drift notice then corrects this. From reading the code, not run.

**F4 — LOW: `/settings apply` has no pending state and no session check.** `App.tsx:1897` waits unbounded in `whenLive` during an outage with nothing on screen, and its lines land on whichever session is current when it returns. It is never lost: the outcome is told, or the drop line. From reading the code, not run.

**F5 — LOW: a pod's error text is printed with no length bound.** `updateFailureLine` strips control characters, so nothing can drive the terminal (`\u001b[2J` printed as `[2J`), but the words are the pod's and the length is unlimited. Display only. Fix: cap it, as `mcp/src/status.ts:39` does.

**Known and confirmed from Execution (no new finding):** noisy stale `changed` lines for a terminal away during two or more applies; project-hook trust asked again; no context anchor on the first request after an apply.

### Gate

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx biome check .` | `Checked 689 files`, no fixes |
| `bun test packages` | **5060 pass, 3 skip, 0 fail**, 344 files (no flake this run) |
| `tsc -p apps/mobile` | **not run**; `apps/mobile` has no `SessionUpdate`, `session_title`, `UPDATE_CLASS` or `MethodName` reference (`rg`) |
| `protocol.json` regenerated | **not verified byte for byte**: `bun run schema:export` needs an approval this session did not have. The drift test (`json-schema.test.ts`, re-run alone: pass) and Biome pass, so its content matches the generated document. The orchestrator's regeneration claim rests on that. |

### Mutation

`foreign = false` in `SessionHost.updateSettings` (`session-host.ts`). This is the guard that stops an agent on another broker being adopted, which would silently auto-approve (§7 single broker); the executor's table did not mutate it. **Red:** "a factory that ignores the reuse is refused" received `{ applied: true }`; 12 pass, 1 fail. Restored from the backup; `shasum` identical before and after (`cda189eb…`); tree clean.

### Premise table

| Premise | Status |
|---|---|
| Feature absent on `main` (`git grep update_settings main -- packages`: no match) | TRUE |
| `Session` reads its agent at call time, and `HostedSession` holds no `Agent` | TRUE |
| The factory and the swap are synchronous, from `assertIdle` to `swapAgent` | TRUE (`session-host.ts`, no `await`) |
| Requests are dispatched concurrently; the new handler holds no lock | TRUE (`peer.ts`, `connection.ts` case) |
| Only the model-proxy branch honours `settings`; a pod host has no persister | TRUE (`serve.ts:473-501`) |
| `sessionSettings` is set only for `run`/`attach` | TRUE (`engine-runtime.ts:615, :1011` are the only sites) |
| A pod's request toward the laptop → `MethodNotFound` | TRUE (`remote-client.ts:1271`; the plan's line number is older) |
| The attach bound "covers every caller (both paths above)" | **FALSE**: `connect.ts:252` (F1) |
| "Join: exit 1, retry" converges | **FALSE** (F1) |

### Attacks tried

| Attack | Result |
|---|---|
| Apply while a permission is pending (real pod host, from inside the requester) | Refused, `-32004` "a turn is already running" |
| Apply during a turn or a compaction, and the same-tick race | Holds: `TurnInProgress` / `CompactInProgress`, nothing built (T6, T10) |
| "Yes, always" across an apply, **by behaviour** (real `podSessionHost`, same `shell` call after the swap) | 1 ask only. Closes the gap of Execution's drift 3 (T3 was identity only) |
| Two terminals applying at once | Agent and notices right: A told of B's value, B told nothing. A's cached report stale (F2) |
| Apply during a reconnect or a drop | Holds: `once`, never re-sent, the drop line, idempotent re-run (F4 for the wait) |
| `connect` session | Sends nothing: no `sessionSettings`, `RemoteSession` has no `settings` method, and `updateSettings` rejects locally |
| Container W key | Still wins: `applyCarried` always starts from the pod's own config, so a rebuild cannot stack. Marked `(container)`, excluded from "differs" |
| Pod makes the laptop apply | Impossible: the method is laptop → daemon only (`MethodNotFound` the other way) |
| Pod forges `session_settings` (ESC text, unknown key names) | Display only. Output: `{ "subagents.agentTaskDescription": "(text differs)", "maxIterations": 3 }`. Text and unknown names dropped; no approval or effect. It can mislead `/settings`, which §7 accepts for a pod's own values |
| Persistence | **No record-version bump was missed.** A pod stores nothing and `serve` answers `applied: false`, so no record shape changes; the system head is an ordinary message. A live re-attach gets the new report (T8). After a pod daemon restart the session is recreated with the attaching laptop's carried settings: an apply from *another* terminal does not survive that, by design (pod daemons store nothing) |
| Silent state loss in the rebuild (`Agent`, gate, `HostExecution`) | Nothing else lost: the gate's only state is `grants`, the env keeps no state, skills come from the shared scan, the TUI's skill list refreshes on each `/` |
| A summary mistaken for the system head | Safe: the compaction summary has role `user` (`compact.ts:246`), so only a real system head is replaced |
| `PROTOCOL_VERSION` kept at 16 | Honest: new method, display update, optional field; no field changes meaning; a v16 daemon answers `MethodNotFound`, worded |
| Attach that times out: orphaned session? | None: no close sent, entry forgotten, late answer ignored (T17). A late daemon attach is the same connection's and ends with it |
| `/settings` view | `settings-view.ts` is pure and tested; Q5 texts match; one line; blue with grey hint via `appendNotice` |

### How the executor behaved

Honest. It disclosed the hand-edited schema, the weaker T3, the tests with no red run and the unverified paths, and those disclosures check out. Its one miss is F1: the plan's scope of callers was never re-checked with a grep of `attachSession` / `.open()`.

### Owner questions

1. **F1: re-arm the deadline on progress, or accept the fixed 30 s?** Recommendation: **re-arm** (a small change in `attachSession`, plus a test that a progressing attach survives past 30 s and a stalled one still fails). Accepting it would mean sessions that `connect` and detached-run joins can never open on a slow link.
2. **F2–F5: fix now or list as debt?** Recommendation: fix F2 and F5 with F1 (a few lines each), and leave F3 and F4 as debt.

## Owner questions

1. **Q1 — the plain-attach `session/open` timeout (TODO's second clause).** Recommendation: **split it out** as `fix/attach-open-timeout` (S, contained-to-cross-module); it has no code in common with this task and would add a reconnect/`whenLive` analysis to an already load-bearing L.
2. **Q2 — which settings does `/settings apply` send?** Recommendation: **the ones this terminal's runtime already carries** (same value the drift notice compares). Re-reading `config.jsonc` on the command would also make the apply follow edits made after the TUI started, but needs the config reload seam of `attach`'s `moveTo` (`main.ts:1288-1293`) and a second source of truth; do it later if wanted.
3. **Q3 — size and execution.** Recommendation: **accept L / load-bearing** (strong model, mandatory fresh-context Review), with the two slices S1/S2 above on one branch, instead of forcing it into M.
4. **Q4 — other terminals' signal.** Recommendation: **no live notification now** (listed as debt); an extra display-class update is cheap later and not needed for the command to be correct.
5. **Q5 — the confirmation text and the hint.** Recommendation: change the drift hint to `(/settings apply, or /clear)` and confirm with `Session settings applied.`; tell me if you want other wording.

*— claude-sonnet-5-5, 2026-11-06*

### Owner answers (2026-11-06)

1. Q1: **B — keep together.** The plain-attach `session/open` bound stays IN this task (not split): the planner must add its slice (reconnect / `whenLive` analysis, `remote-client.ts:581-600`) to Implementation before execution.
2. Q2: **A** — `/settings apply` sends the settings this terminal's runtime already carries (the ones the drift notice compares); no config re-read.
3. Q3: **A** — accept L / load-bearing, one branch with slices S1 (protocol + daemon), S2 (TUI + command), S3 (plain-attach open bound, from Q1=B); Opus executes, mandatory fresh-context Review.
4. Q4: **B** — other attached terminals get a live notice now (e.g. `Session settings changed by another terminal: { … }`, same one-line JSON format and notice palette); a display-class update per AGENTS §7 (free to add), wired both ends + `client/mapping.ts`. Add it to S2.
5. Q5: **A** — drift hint `(/settings apply, or /clear)`, confirmation `Session settings applied.`, other terminals `Session settings changed by another terminal: { … }`.
6. (new, owner 2026-11-06) **`/settings` alone shows the settings**: always ALL the session's settings (one-line JSON, container-set keys marked `(container)`), then, only when this terminal differs, `This terminal differs: { … } (/settings apply)`; with no difference `This terminal matches.` Pure view-model module + test; add to S2.
