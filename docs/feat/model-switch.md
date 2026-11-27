# feat/model-switch — `/model <name>` and `--model <entry>` for the TUI

> **Status:** implementation (APPROVED — owner delegated the details, 2026-11-27)
> **Branch:** `feat/model-switch`
> **Size:** M (borderline L: six packages, each diff small) · **Blast:** load-bearing (agent-loop model selection, two protocol methods) · **Suited:** Opus plan + mandatory fresh-context Opus review, Sonnet exec
> **Changelog:** `changelog.d/model-switch.added.md`

## Context

*— claude-opus-5-5, 2026-11-27*

Owner, 2026-11-27 ~07:40: «implementiamo subito, sia /model che il flag --model,
solo per la TUI ora, così lo portiamo in demo». DEMO TODAY: small, safe, no owner
questions. The owner's config already has `models.haiku`, `models.sonnet`
(anthropic) and `models.qwen-local`.

Wanted (TODO.md item): (1) `/model` lists the switchable models (the main one +
every `models.<name>`), marking the active one; `/model <name>` moves the LIVE
session's main model to that entry from the next model request — same history,
another provider's reasoning skipped, the entry's window / maxTokens / images
applied, status-bar label + ctx meter updated, a notice `Model: <old> → <new>`.
(2) `--model <x>` accepts a `models` entry NAME as well as a raw id (an entry
name wins), so `tentacle --model haiku` starts on that entry's connection.
Scope: local worker sessions and `connect` → `serve`. Phone and pods out of
scope (a pod session refuses clearly). Keys never leave the host that owns them.

**Repro (feat: the capability is missing), 2026-11-27, on `main` = dc05e5a3:**
```
$ grep -c "set_model\|session/models" packages/protocol/src/methods.ts
0
$ sed -n 6,10p packages/tui/src/commands/model.ts
export const command = {
  name: "/model",
  description: "show the active model",
  run: (ctx: Ctx): void => ctx.pushNotice(`Model: \`${ctx.shownModel}\``),
};
$ grep -n "TENTACLE_MODEL: options.model" packages/config/src/load.ts
778:  const env = options.model !== undefined ? { ...base, TENTACLE_MODEL: options.model } : base;
```
i.e. `/model` only shows; no RPC can change a session's model; `--model haiku`
becomes the model id `haiku` on the main endpoint.

## Implementation

*— claude-opus-5-5, 2026-11-27*

### Load-bearing assumption

**Every consumer of a session's main model reads ONE provider object built once
in `buildAgent`, at call time — so wrapping that object in a delegating
provider switches the agent loop, compaction, default sub-agents and the title
model together, WITHOUT rebuilding the agent (no new broker, jobs, shells or
workflow driver).** Proven:

- `buildAgent` builds the main provider once: `wiring.ts:932-933`
  (`options.modelOverride ?? configuredModelProvider(config, config.model, …)`).
- That same `model` is handed to: summarize (`wiring.ts:981`), the sub-agent
  runner's default (`wiring.ts:1149`), the Agent (`wiring.ts:1542`), the title
  model when no `titleModel` is set (`wiring.ts:1595-1600`).
- The Agent reads `this.config.model` per call: `agent.ts:1338` (compaction),
  `:1727` (round stream), `:2066` (final request), `:2226` (count).
- `ModelProvider` is three members: `id`, `stream`, optional `countTokens`
  (`core/src/model.ts:314-327`) — trivially delegable; `countTokens` returning
  `undefined` means "estimate" by contract (`model.ts:320-325`).
- The windows are read at call time from the config objects:
  `agent.ts:1215` (`this.config.contextPrune` → `.window`), `agent.ts:2144`
  (`contextAwareness`); a default sub-agent gets the SAME object by reference
  (`subagent.ts:594-601`: copied only when the child has its own window). The
  objects are built in `wiring.ts:1055-1068`.

Why not the existing agent-rebuild seam (`SessionHost.updateSettings`,
`session-host.ts:1848-1915` → `swapAgent`, `hosted-session.ts:4136-4162`): the
worker factory ignores `ctx.reuse` (`worker.ts:232-244`, `workerAgentFactory`
`worker.ts:91-150` forwards no broker/jobs), and `buildAgent` has no reuse input
for the workload shells or the workflow driver (`wiring.ts:650-665` vs the
`foreign` check `session-host.ts:1875-1880`). A rebuild there would need new
reuse wiring next to the single-broker invariant (AGENTS §7) — the wrong risk
for a demo-day change. Swapping the provider touches no broker at all.

### Preconditions

- **Single broker untouched**: no agent, broker or `RemoteClient` is created by
  this change; the session keeps the agent it was built with.
- **Another provider's reasoning is skipped already**: a record is echoed only
  when `record.source === this.id` (`anthropic-provider.ts:661`,
  `openai-provider.ts:508`); ids are `anthropic:<model>` (`anthropic-provider.ts:126`)
  — so the wrapper's `id` MUST be the current target's id (a getter).
- **Entry resolution exists and keeps keys per endpoint**: `resolveModelEntry`
  (`config/src/models.ts:66-105`, an entry that owns any connection key inherits
  none — the main key never goes to another endpoint); every entry's key command
  runs at a terminal load (`load.ts:686-755`); `createModelProviders().forEntry`
  builds an entry's provider with ITS endpoint and key only, cached
  (`cli/src/model-provider.ts:44-65`). Reused as is — the same resolution the
  sub-agents use (`subagentModelResolver`, `model-provider.ts:88-129`).
- **Idle guard**: `HostedSession.assertIdle` throws `TurnInProgress` /
  `CompactInProgress` (`hosted-session.ts:4355-4361`), the guard
  `update_settings` uses synchronously before its swap (`session-host.ts:1853`).
- **Trust bit for pods**: `RemoteSession.daemonWakes` is true only for `connect`
  and the local worker (`remote-session.ts:281-287`); `workflow()` already
  refuses locally on it, sending nothing (`remote-session.ts:1419-1424`).
  A tunnelled pod agent is built with `modelOverride` (`serve.ts:1418-1423`), so
  it never gets a switch (below).
- **Pre-open sessions**: a fresh session has no daemon id until its first send;
  `ensureOpen()` opens it through the ONE session path (`remote-session.ts:1455-1458`),
  as `workflow start` does (`:1426-1440`).
- **Protocol additive**: methods are free; an unknown one answers
  `MethodNotFound` (AGENTS §7 forward-compat). Method table: `protocol/src/methods.ts`
  (`Method` enum ~`:163-165`, schema table ~`:375-386`).
- **`--model` today**: `main.ts:823` reads it, `main.ts:1035-1042` passes it to
  `loadConfig`, which injects it as `TENTACLE_MODEL` (`load.ts:776-778`); the
  profile is folded at `load.ts:802-807` (where `fileConfig.models` is known);
  `env`'s other reads before that (`HOME`, config dir, `TENTACLE_PROFILE`) do not
  depend on `TENTACLE_MODEL`.
- **TUI**: `shownModel = modelLabel ?? model` (`App.tsx:274`), `contextWindow`
  is a prop (`App.tsx:232`, from `main.ts:2442-2448`); `/model` is
  `commands/model.ts:6-10`; the optional-capability pattern is `/rename`
  (`commands/rename.ts`, `SessionController.rename?`, `app-types.ts:295`);
  `SessionController.sessionId` (`app-types.ts:505`).

#### Orchestrator decisions

1. **D1 — swap the provider, not the agent** (see the assumption). `buildAgent`,
   when NOT tunnelled, wraps the main provider in a `ModelSwitch`; the
   `contextAwareness` / `contextPrune` objects expose `window` as a getter on the
   switch's current window; the Agent's `modelId` likewise reads the switch.
   No `@tentacle/agent` code changes.
2. **D2 — a switch during a running turn or compaction is REFUSED** (the
   `assertIdle` guard, same synchronous stretch as the select): «a turn is
   running — switch the model after it ends (Esc stops it)». Nothing changes.
3. **D3 — not persisted.** The selection is the live session's, in daemon memory.
   A `--resume` and a `serve` restart's reload (a newly built agent) start on the
   run's START model (config main, or the `--model` entry). The notice says
   «for this session». No new log entry type (no §7 persistence change, no
   `critical` entry to decide).
   *Corrected at execution:* `/clear` resets the conversation IN PLACE (same
   session, same agent — `SessionController.clear`, `app-types.ts`), so the
   selection STAYS (pinned in `daemon/test/set-model.test.ts`). `/sessions`
   starts on the start model only when the daemon builds a new agent: a
   `connect` TUI returning to a session still LIVE on `serve` keeps its
   selection there (label: see D4).
4. **D4 — no new `session/update` kind.** The switching TUI updates from the
   RPC result. Another client attached to the same `serve` session keeps its
   label until it re-attaches (debt, below).
5. **D5 — `default`** = the model this run started on; `/model default` returns
   to it. An entry literally named `default` is not selectable by `/model`
   (documented in the command's usage line).
6. **D6 — `--model <entry>` for the local session modes only** (bare TUI,
   `--plain`, one-shot prompt). `run` / `attach` / `serve` given an entry name
   are REFUSED with a clear message (their kept-run record stores a model ID and
   `withRunModel` re-applies it on the main endpoint, `relay.ts:162`,
   `main.ts:2016` — an entry there would silently hit the wrong endpoint).
   `--help` says it.
7. **D7 — pods**: refused locally (`daemonWakes` false → nothing sent: «model
   switching is not available in a container session») AND daemon-side (a host
   with no catalogue / a session with no switch refuses). The laptop keeps
   serving only what it published.
8. **D8 — a running background sub-agent on the MAIN model follows the switch**
   from its next request (it holds the same provider). A child on its own entry
   is unaffected. Documented, not prevented.
9. **D9 — window shrink**: the switch is allowed; when the TUI's current ctx
   count exceeds the new window, the notice adds «context ~N exceeds <model>'s
   window M: /compact first». No daemon refusal (the count is the TUI's).

### Design

**Config (`@tentacle/config`, pure).**
- `withMainEntry(config, name): TentacleConfig` (`models.ts`): the run's main
  model becomes entry `name` — `provider`, `baseURL`, `model`, `apiKey` (the
  ENTRY's; absent ⇒ the main key is REMOVED, never carried to another
  endpoint), `contextWindow`, `maxTokens`, `maxImageBytes`, `images` replaced;
  `titleModel` dropped when the entry has its own connection (it names an id on
  the old endpoint); `mainEntry: name` recorded. `models` untouched.
- `modelCatalogue(config): ModelCatalogue` — `{ start: { model, contextWindow,
  entry? }, entries: [{ name, model, contextWindow }] }`, names sorted. Names,
  ids and windows only — never a URL or key.
- `loadConfig`: new option `modelEntry?: true`. With it, when `options.model`
  names a key of the profile-folded `fileConfig.models`, do NOT inject
  `TENTACLE_MODEL`; after the entries' keys resolve, return
  `withMainEntry(result, name)`. Otherwise unchanged (an id).

**Protocol (additive, no bump, no `protocol.d/` note).**
- `session/models` — params `{ sessionId?: SessionId }` → `{ start: {model,
  contextWindow, entry?}, entries: [{name, model, contextWindow}], active: string
  | null }` (`active` null = the start model; always null without a sessionId).
- `session/set_model` — params `{ sessionId, name: string | null }` (`name`
  1–64 chars; null = start model) → `{ active: string | null, model: string,
  contextWindow: number }`. Idempotent by value.
- `protocol.json` regenerated on the branch with `bun run schema:export` (the
  drift test); the merge's `protocol:bump` regenerates it again.

**Daemon.**
- `ModelSwitch` interface (daemon-owned, implemented by the cli):
  `current(): string | null`, `select(name: string | null): { model; contextWindow }`
  (throws on an unknown name, state unchanged).
- `AgentFactory`'s result gains `modelSwitch?: ModelSwitch`;
  `SessionHostOptions` gains `models?: () => ModelCatalogue` (worker + `serve`
  only). `SessionHost` keeps `WeakMap<HostedSession, ModelSwitch>` filled in
  `build` (`session-host.ts:1727-1752`); `updateSettings` replaces/deletes it
  with `next.modelSwitch` after a swap (pods only today; keeps it honest).
- `SessionHost.models(hosted?)` and `setModel(hosted, name)`: no catalogue / no
  switch ⇒ RpcError (reuse the existing "unavailable" code the workflow refusal
  uses; `InvalidRequest` if none) «model switching is not available in this
  session»; `hosted.assertIdle()` then `switch.select(name)` in ONE synchronous
  stretch (no await, no lock — AGENTS §7 "don't serialize the peer"); unknown
  name ⇒ `InvalidParams` listing the known names.
- `connection.ts`: dispatch both methods next to `UpdateSettings`
  (`connection.ts:436-439`); `session/models` without a sessionId answers from
  the host catalogue.

**CLI wiring.**
- `createModelSwitch(config, base, providers)` in `model-provider.ts`: holds the
  target (`base` or `providers.forEntry(name)` — the SAME `ModelProviders` the
  sub-agent resolver uses, built once in `buildAgent`), exposes
  `provider` (`get id()`, `stream`, `countTokens` → target's, else
  `Promise.resolve(undefined)`), `contextWindow()`, `modelId()`, and the
  `ModelSwitch` methods. Initial `current()` = `config.mainEntry ?? null`;
  `select(null)` = back to `base`.
- `buildAgent`: not tunnelled ⇒ build the switch, use `switch.provider` wherever
  `model` was used, `window` getters on the two context objects, `modelId`
  getter on the AgentConfig; return `modelSwitch` on `WiredAgent`. Tunnelled
  (`modelOverride`) ⇒ no switch, unchanged.
- `workerSessionBuild` (`wiring.ts:581-592`) and the `serve` session factory
  forward `modelSwitch`; `workerSessionHost` and the `serve` host pass
  `models: () => modelCatalogue(config)`. `podSessionHost` passes nothing.
- `main.ts`: pass `modelEntry: true` for the local session modes; for
  `run`/`attach`/`serve`, if `--model` names a key of `config.models`, print
  «--model <name> is a models entry: entries work for the local TUI only for
  now — pass a model id or --profile» and exit 2; `--help` (`main.ts:420-425`):
  «`--model <id|entry>` — a `models` entry name wins (local session)».
- `local-runtime.ts`: forward `models()` / `setModel()` from the inner
  `RemoteSession` (the `rename`/`setCapability` passthrough pattern, `:1089-1095`).

**Client.** `RemoteClient.models(sessionId?)`, `setModel(sessionId, name)` via
`sessionCall(…, "once")` (not re-sent after a drop; idempotent, the user re-runs);
`MethodNotFound` worded «this daemon's tentacle predates /model switching —
update it». `RemoteSession.models()` / `setModel(name)`: `!daemonWakes` ⇒ reject
locally, nothing sent; `setModel` with no id ⇒ `ensureOpen()` first; `models()`
with no id ⇒ sessionless call.

**TUI.**
- Pure `packages/tui/src/model-switch.ts`: `parseModelArg(raw)` (`""` → list,
  `default` → null, one word → name, more → usage); `modelListLines(result)`
  (rows `name  model-id  (window)`, active marked by TEXT `← active`, never
  hue alone — owner is colour-blind); `switchedNotice(old, next, ctxTokens?)`
  (incl. D9 warning); `modelSwitchFailedNotice(error)` (TurnInProgress /
  CompactInProgress / MethodNotFound / unavailable / unknown name); and
  `viewModel(startup, switched, session)` → `{ label, contextWindow }`, the
  switched values only while `switched.session === session`. *Corrected at
  execution:* keyed on the CONTROLLER, not the session id — a swap back
  (`/sessions`, a hop) is a new controller on the same id with a newly built
  agent, so an id key would show the old switch again.
- `SessionController` (`app-types.ts`) gains optional `models?()`,
  `setModel?(name)`; `commands/model.ts` uses them (absent ⇒ today's one-line
  show + «switching isn't available on this runtime»); description «show or
  switch the model (/model <name>, /model default)».
- `App.tsx`: one state `switched: { session, label, contextWindow } | null`;
  `shownModel` / the `contextWindow` passed down come from `viewModel(…)`.
- Built-in skill text `config/builtin-skills/tentacle/SKILL.md:56` follows the
  new description (regenerate with its generator if its drift test fails).

### Files

1. `packages/config/src/models.ts`, `load.ts` (+ `TentacleConfig.mainEntry?`), `index.ts` exports.
2. `packages/protocol/src/session.ts`, `methods.ts`; `packages/protocol/schema/protocol.json` (generated).
3. `packages/daemon/src/session-host.ts`, `connection.ts`.
4. `packages/cli/src/model-provider.ts`, `wiring.ts`, `worker.ts`, `serve.ts`, `main.ts`, `local-runtime.ts`.
5. `packages/client/src/remote-client.ts`, `remote-session.ts`.
6. `packages/tui/src/model-switch.ts` (new), `commands/model.ts`, `commands/context.ts` (setter in ctx), `app-types.ts`, `App.tsx`.
7. `packages/config/builtin-skills/tentacle/SKILL.md` (if generated/drift-tested).
8. `changelog.d/model-switch.added.md`.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| Unknown name | `InvalidParams` naming the known entries; state unchanged; TUI shows it. |
| Turn or compaction running | Refused (D2); nothing changes; TUI says when to retry. |
| Pod (`run`/`attach`) session | Refused locally, no frame sent; daemon refuses too (no switch). |
| Older `serve` (connect) | `MethodNotFound` → worded «update it»; nothing changes. |
| Drop during `set_model` | Not re-sent (`once`); TUI label NOT updated on error; `/model` re-reads `active` (idempotent by value). |
| Entry without a usable key / wrong endpoint | The next turn fails like any provider error (turn_end error); `/model default` goes back. |
| Window shrink below current context | Allowed; notice warns with `/compact` (D9); prune/awareness thresholds use the new window from the next request. |
| Background child on the main model | Follows from its next request (D8); its foreign reasoning is skipped by `source`. |
| Two clients switch at once | Synchronous select, last wins; the other's label is stale until re-attach (D4, debt). |
| `/clear` | In place: selection and label stay (D3). |
| `/sessions`, `/move`, `--resume` | New controller: the label reverts; a newly built agent is on the start model (D3). A still-live `serve` session keeps its selection, label stale (D4). |
| `serve` restart under a connected TUI | Same controller: daemon on the start model, label stale until `/model <name>`; `/model` lists the truth (debt). |
| `--model <entry>` on run/attach/serve | Refused, exit 2, clear message (D6). |
| Main key leak | `withMainEntry` drops the main `apiKey` for an own-connection entry; `forEntry` never uses the main key (tested). |
| `/model` before the first message | List: sessionless call. Switch: `ensureOpen()` then select. |

### Tests

Red first — each shown failing on its ASSERTION (stub the new export first so
the failure is not an import error, AGENTS §4), then green; mutation-check the
starred ones (§9).

- **T1 config** (`packages/config/test/model-main-entry.test.ts`): ★ own-connection
  entry replaces provider/baseURL/model/window/maxTokens/images and the main
  `apiKey` is ABSENT when the entry has none; `titleModel` dropped across
  endpoints; inherited entry keeps the main connection; `loadConfig({ model:
  "haiku", modelEntry: true })` → entry's id + `mainEntry`, inheriting entries
  NOT re-pointed; a non-entry `--model` keeps id semantics; without
  `modelEntry` an entry name stays an id.
- **T2 cli switch** (`packages/cli/test/model-switch.test.ts`, injected
  `createProvider` spy): ★ after `select("haiku")` the agent loop's NEXT request
  reaches the entry's provider (not the base), `provider.id` is the entry's, the
  `contextPrune`/`contextAwareness` window reads the entry's; a default
  sub-agent's request follows; `select(null)` returns; unknown name throws with
  state unchanged; a tunnelled build has no `modelSwitch`.
- **T3 daemon** (`packages/daemon/test/set-model.test.ts`, fake factory with a
  switch over two fake providers, the existing host/connection harness): ★ a
  `set_model` while a turn runs → `TurnInProgress` and `current()` unchanged;
  success → result model/window and the next prompt's request hits the new
  provider; no switch → refused; unknown → `InvalidParams`; `session/models`
  with and without sessionId; both methods dispatched over a real `Connection`.
- **T4 client** (`packages/client/test/set-model.test.ts`, existing fakes): ★
  `daemonWakes: false` → rejects and NO frame is sent; pre-open `setModel` opens
  first then calls; `MethodNotFound` worded.
- **T5 tui**: pure `packages/tui/test/model-switch.test.ts` (parse, list marks
  active by text, notices, D9 warning, `viewModel` reverts on another
  sessionId); `app.test.tsx` pattern: `/model haiku` with a fake session →
  frame shows the new label in the input rule and the new window in the ctx
  meter + the notice row; refusal leaves the label.
- **T6 main** (existing `io.startTui` seam): `--model haiku` starts the TUI on
  the entry's id and window; `run --model haiku` → exit 2 + message; `--help`
  mentions entries.

## Execution

*— claude-sonnet-5-5, 2026-11-27*

**Repro** (at HEAD `9a70907c`, via `git show HEAD:…`): no `set_model` /
`session/models` in `methods.ts`; `/model` only shows; `load.ts:778` injects
`--model` as `TENTACLE_MODEL`. **Load-bearing check: holds** — one provider
object in `buildAgent`; `Agent` keeps its config by reference
(`agent.ts:977`), so `window` and `modelId` getters are read live;
`subagent.ts:594-601` shares the objects with a default child.

**As built**, in dependency order, each slice's tests red on stubs first:
config → protocol → daemon → CLI + `--model` → client + `local-runtime` → TUI →
skill text (`bun run skills:gen`) → changelog fragment. `protocol.json`
regenerated; no `protocol.d/` note.

**Drift**
- D3 and the `viewModel` key corrected above (the code contradicts them).
- `modelId` is a getter set with `Object.defineProperty` (a spread would copy it
  once); one shared `createModelProviders` for the switch and the sub-agents.
- `select(null)` leaves `current()` at the start value (`mainEntry ?? null`).
- `json-schema.test.ts`: fixtures for the two methods; its null allowlist gained
  `active` (×2) and `SetModelParams.name` (null states «start model»).
- `screenContextTokens` lives in `model-switch.ts` (the S10 structure test
  forbids computing it in `App.tsx`). TUI mirrors two `DomainErrorCode`s (it
  imports protocol types only), pinned by its test.
- Updated: `app-frames.test.tsx` (help line), the controller-forward guard in
  `subagent-panel-controller.test.ts`.

**Mutations** (`.tentacle/tmp/model-switch/mutate.ts`; each restored):
```
KILLED T1 withMainEntry keeps the main apiKey
KILLED T2 the wrapper streams from the base provider
KILLED T2 awareness window frozen at build
KILLED T2 prune window frozen at build
KILLED T2 modelId spread once
KILLED T2 workerSessionBuild drops modelSwitch
KILLED T2 local-runtime setModel not forwarded to the session
KILLED T3 set_model without the idle guard
KILLED T4 setModel without the trust check
KILLED T5 viewModel ignores which session was switched
KILLED T5 App drops the switch
KILLED T6 main never passes modelEntry
```

**Tests:** `packages/tui/test` 3249/0; `packages/cli/test` 3106 pass, 2 skip,
1 fail (the forward guard; updated, its file then 4/0);
daemon+client+protocol+config+2 CLI files 4170 pass, 1 skip, 1 error:
`client/test/chart-args-roundtrip.test.ts` imports `apps/mobile`, which cannot
resolve `@tentacle/core` in this worktree (untouched here). Biome clean on the
six touched packages. Typecheck and the full gate: not run (orchestrator).

**Found, not changed (outside the plan — for Review)**
- A local `--model <entry>` session that `/move`s to a container records the
  entry's model ID (`hop-targets.ts:372`, `:815`); a later `attach` / relay
  applies it on the MAIN endpoint (the D6 hazard, by the hop door).
- `imageTokenEstimate` (`wiring.ts`) stays the start provider's.
- No live run in a real terminal against real providers: verify with
  `tentacle`, `/model`, `/model haiku`, one turn, `tentacle --model haiku`.

## Review

*— claude-opus-5-5, 2026-11-27* (fresh context; same model as the planner,
different from the executor DeepSeek — shared plan blind spots possible)

**Verdict: APPROVE** — no HIGH/MEDIUM findings.

**Gate.** `bun run lint` clean · `bun run typecheck` clean · touched files 97
pass / 0 fail · full `bun run test`: 21399 pass / 0 fail / 5 skip (runs 2–3).
Run 1 had 1 fail + 1 error that did not come back in two re-runs (flaky,
not identified: the parallel runner did not print the name). The diff adds no
skips, so the 5 skips (vs the 3 opt-in skips in §6) are already on main.

**Mutation (all FAIL, all reverted, `git status` clean):** window getter →
static (`wiring.ts` contextPrune) · `assertIdle` removed (`session-host.ts`
setModel) · `daemonWakes` guard removed (`remote-session.ts` setModel) · main
`apiKey` kept (`models.ts` withMainEntry) · `id` getter → `base.id`
(`model-provider.ts`) · switch built when tunnelled (`wiring.ts`).

**Premises checked:** Agent stores its config by reference, no spread
(`agent.ts:977`), so the `modelId`/`window` getters stay live ✔; a sub-agent
copies the window only when it has its own (`subagent.ts:594-601`) ✔; an
inherited entry carries the main resolved key (`load.ts:776-778`), so
`withMainEntry` keeps it ✔; the worker gets the whole config including
`mainEntry` (`worker-bootstrap.ts:10`) ✔; `createServeAgent` returns
`buildAgent`'s `WiredAgent`, so `modelSwitch` reaches serve's host ✔;
`daemonWakes` is off unless set (`remote-client.ts:1203`; only the worker and
`connect` set it) ✔.

**Attacks tried:** (1) a settings sync rebuilding the agent and dropping the
selection → `updateSettings` is only called with `carried` settings
(`engine-runtime.ts`, pods only), where there is no switch: nothing found.
(2) The main key reaching an entry's endpoint through `apiKeyCommand` → it is
only read by the workspace-mount hider: nothing found. (3) `/clear` or
`/sessions` leaving a stale label → `/clear` keeps the same controller and
agent; a swap makes a new controller, and `viewModel` resets: holds. (4) A
switch racing a prompt → the idle check and the select run synchronously
with no await (§7 "don't serialize the peer" respected). (5) Pod: refused on
the client before any frame is sent, and the daemon refuses too (no
catalogue, no switch).

**End-to-end:** `cli/test/model-switch.test.ts:277` drives the real
`createLocalRuntime` → `RemoteClient` → `Connection` → `workerSessionHost`
path (list, switch before the first message, send).

**Accepted debt, below MEDIUM:** a `connect` TUI that comes back to a `serve`
session that is still live with a selection shows the start label and window,
while the daemon runs the entry. This is D4 by design. It is cheap to close
later: on a new controller, read `models().active`.

**Executor behaviour:** the diff follows the plan; the two drifts (`/clear` in
place, `viewModel` keyed on the controller) are recorded, and both are
correct. Tests have assertions that fail under mutation, not just correct
imports.

Debt to red-team (known, deliberate): D3 (not persisted), D4 (no update kind:
other clients' labels stale), hooks keep the start model id
(`wiring.ts:1003`), the host-level image policy is the start model's
(`daemonImagePolicy(config)`, `worker.ts:194`), `serve`'s `agentInfo.model` stays
the start model (`serve.ts:898`), phone/pods out of scope.
