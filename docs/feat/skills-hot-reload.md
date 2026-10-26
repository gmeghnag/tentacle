# feat/skills-hot-reload — the user's skills follow the disk without a restart

> **Status:** implementation
> **Branch:** `feat/skills-hot-reload`
> **Size:** L · **Blast:** load-bearing (a breaking protocol change — `PROTOCOL_VERSION` 12 → 13; the session's skill activator swapped outside a reset; every runtime's TUI wiring: worker, `--in-process`, pod `run`/`attach`, `connect`) · **Suited:** strong model executes; mandatory fresh-context Review on the activator swap's ordering against a context reset (F3), the one-session-path invariant (all runtimes through `SessionController`), and the protocol bump

`Type: feat · Size: L · Blast: load-bearing · Suited: strong model + mandatory fresh-context Review`

## Context

*— claude-opus-5-5, 2026-10-26*

**Why.** Owner decision CR-Q1 (`docs/feat/context-reset.md:885-887`, `TODO.md:1018-1019`):
after context-reset the MODEL sees a skill added mid-session (decision 11), but
the USER does not. The `/name` list and the `/skills` panel are built once per
daemon at start and never change; a SEPARATE task right after context-reset
makes them follow the disk ("si"). The problem as the context-reset plan stated
it (`docs/feat/context-reset.md:860-869`): after a reset `/new-skill` does not
autocomplete, a deleted skill still shows and fails with "unknown skill".

**Evidence (source, on `a27ed93`).** Three facts make the user's view static
and — after a reset — wrong:

1. **The `/name` catalog is per daemon, fixed at start.** `SessionHost` builds
   `skillCatalog` and `skillList` once in its constructor
   (`daemon/src/session-host.ts:200-212`, comment "built once: skills are fixed
   at daemon start") from `skillCatalog(config)` / `skillListing(config)`
   (`cli/src/wiring.ts:62-92`), passed at construction on every daemon
   (`cli/src/worker.ts:99-100`, `cli/src/serve.ts:174-175` and `:428-429`).
   `initialize` returns it (`daemon/src/connection.ts:308-312`); `skills/list`
   returns the same static object (`connection.ts:205-206`). The client caches
   the `initialize` copy, refreshed only by a reconnect
   (`client/src/remote-client.ts:327-328,391-397,1014-1016`). The `--in-process`
   TUI closes over a startup constant (`cli/src/main.ts:722-737`).
2. **What `/name` may actually activate is per SESSION and changes at a reset.**
   `session/prompt{skill}` is accepted only if the session's agent can activate
   it (`daemon/src/hosted-session.ts:930-935` → `agent/src/session.ts:112-114` →
   `agent/src/agent.ts:388-390`, the installed `activator`), and a reset
   replaces that activator from a fresh scan at its commit point
   (`agent.ts:1162-1166`, `installSkills` `:398-400`; the fresh set from
   `refreshSessionContext` + `buildSessionSkills`, `cli/src/wiring.ts:331-345`).
   So after a reset the daemon-wide list and the session's truth DISAGREE: the
   list hides an activatable skill and offers a removed one.
3. **Without a reset nothing re-reads the skill dirs.** Discovery runs at
   `loadConfig` and in a reset's refresh only (`config/src/load.ts:230-247`,
   `:268-…`). A skill's BODY is already live (read from disk at each
   activation, `cli/src/wiring.ts:152-155`), but a new skill, a removed one, or
   an edited frontmatter (`name`, `description`, `user-invocable`,
   `disable-model-invocation`) needs a restart.

**Constraints.**
- One session path (AGENTS §7): every runtime reaches the TUI through
  `SessionController` (`tui/src/App.tsx:142-…`, remote: `cli/src/local-runtime.ts`;
  in-process: `cli/src/session-jobs.ts:109-…`). No second channel for skills.
- CR-Q2 (`docs/feat/context-reset.md:888-890`): a refresh re-reads FILES only;
  `config.jsonc` (`loadSkills`, …) and the installed-package list stay as at start.
- The model's own skill set (system-prompt catalog + `skill` tool enum) changes
  only at a reset (context-reset decision 11 and F2: only at a commit point).
  Changing it at any other moment rewrites `messages[0]` and the tool list
  mid-conversation (prompt cache lost, model told one thing then another).
  This task does NOT change that — see OWNER QUESTION Q1.
- Pre-public protocol (AGENTS §7): a breaking change is allowed when cleaner,
  and MUST bump `PROTOCOL_VERSION` (now 12, `protocol/src/version.ts:7`).
- A pod daemon is not trusted (AGENTS §7): skills listed by a pod are pod data —
  already bounded and control-char-free on both ends
  (`daemon/src/mapping.ts:68-95`, `protocol/src/skills.ts:17-42`,
  `protocol/src/session.ts:128-152`).

**Repro (capability missing).** The executor writes and runs, in
`.tentacle/tmp/skills-hot-reload/`, on current `main` before any edit:
a `SessionHost` built with a `createAgent` from `buildAgent` on a temp config
whose skill root holds `alpha`; open a session over an in-memory channel
(`client/test/skills-list.test.ts` is the pattern); write `beta/SKILL.md` into
the root; call `skills/list` and read `client.skills()`. Expected on `main`:
both list only `alpha`. Paste the script and its output here (it is gitignored,
AGENTS §6).

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**The session's installed skill set is the one truth for "what can `/name`
activate", and it can be replaced by a fresh scan at any idle-or-running moment
WITHOUT touching the model's skill set — as long as only the ACTIVATOR is
swapped.** Proof:
- The model's set and the user's are separate objects already: the `skill` tool
  carries its OWN activator built from the offered skills only
  (`tools/src/skill.ts:220-231`, `userInvocable: false`), while the agent's
  `activator` serves the user's `/name` round and the `/compact` re-read
  (`agent.ts:358-361,388-390,447,1197`). User-only skills (hidden from the
  model) exist today (`cli/src/wiring.ts:165-181`, `userNames` vs
  `offeredNames`), so "the user can activate a skill the model's catalog does
  not list" is an existing, supported state, not a new one.
- A user activation does not need the skill in the model's tool: `runUserSkill`
  pushes a synthetic `skill` call (`tools/src/skill.ts:210-212`) and runs it
  through `this.activator` (`agent.ts:1185-1210`), captured once at the round's
  start (`agent.ts:1197`), so a swap during that round cannot split it.
- The `/compact` re-read uses the activator in force (`agent.ts:447`); a skill
  the fresh activator no longer knows keeps its history copy
  (`agent.ts:431-436,458`) — the documented behaviour for a removed skill.

The executor proves it first with a unit test (Tests T1): a session whose
model tool offers `alpha`, after a user rescan finding `alpha`+`beta`, (a)
accepts `/beta`, (b) still sends the model a `skill` enum of `["alpha"]` and
the same system prompt.

### Preconditions

1. **`SessionController` is the one per-session seam on every runtime**
   (`tui/src/App.tsx:142-…`): remote (`cli/src/local-runtime.ts:360-366`,
   backed by `RemoteClient`), in-process (`cli/src/session-jobs.ts:109-125`).
   `/clear` and `/sessions` replace the controller, so per-session data rides it.
2. **The agent factory runs where the agent runs**: `AgentFactory`
   (`daemon/src/session-host.ts:47-58`) is called per session
   (`session-host.ts:750`) by the worker, `serve` (`serve.ts:164-173`, cwd per
   session) and the pod's stdio daemon (`serve.ts:437-…`). So a scan from the
   factory's closure reads the filesystem the session's skills come from (pod:
   the pod's, Q4 of the pod plan) — the same rule the reset follows
   (`wiring.ts:328-330`).
3. **One builder derives tool, activator and listing rules** from one
   `SkillInfo[]`: `buildSessionSkills` (`wiring.ts:165-181`) and
   `skillListing` (`wiring.ts:75-92`) both use `offeredSkills`/`slashSkills`.
4. **Discovery is reusable and cheap**: `refreshSessionContext` →
   `discoverSkills` (`config/src/load.ts:230-247,268-…`), same roots and rules as
   start, honours `skillsEnabled` (off → no I/O, `load.ts:233-235`) and the
   packages' symlink check (`load.ts:284-…`). It reads `PROMPT.md`/`AGENTS.md`
   too; the rescan needs skills only (Design §2 extracts the skills half).
5. **Session-scoped requests need the connection to have opened the session**
   (`connection.ts:313-318`); `RpcError` + `InvalidParams` is the refusal shape
   (`hosted-session.ts:930-935`).
6. **The wire is sanitised on the daemon** (`toSkillList`, `mapping.ts:68-95`)
   and validated on the client (`SkillSummarySchema`, `session.ts:138-152`;
   `SkillsListResultSchema`, `skills.ts:35-42`; the peer validates results,
   `remote-client.ts:388-397`).
7. **The TUI reads the catalog through a getter at each render and submit**
   (`App.tsx:261-263,629,1415,1475,1616`) and opens `/skills` through an async
   loader (`App.tsx:1592-1599`). No mobile consumer of either
   (`apps/mobile`: no `skills/list`, no `initialize.skills`).
8. **A reset already reports its skill-set delta** in its tool result
   (`agent.ts:1151-1160`, `skillSetDelta`, `agent/src/context-reset.ts:129`) and
   reaches the TUI as a `context_reset` event (`tui/src/state.ts:375`).

### Design

**1. One source of truth: the session's skill set, with its listing.**
`SessionSkills` (`agent.ts:349-352`) gains `listing` — plain data, the
`skills/list` shape before sanitising: `{ skills: {name, description, scope,
user, model, location}[], problems: string[] }` (a structural type in
`@tentacle/agent`; no protocol import). `buildSessionSkills(skills,
diagnostics, readBody)` builds `tool`, `activator` AND `listing` from the same
`SkillInfo[]` (absorbs `skillListing`; `skillCatalog`/`skillListing` and the
`SessionHost` statics are deleted). The Agent keeps the installed
`SessionSkills` (not only the activator) and a `skillsGeneration` counter that
every install increments; `installedSkills()` returns both.

**2. The user rescan (new, one function).** In `cli/src/wiring.ts`,
`buildAgent` returns a `skills: SessionSkillSource` with one method,
`refresh(): Promise<SessionSkillsView>`:
1. `gen = agent.installedSkills().generation`;
2. `fresh = await discoverSkills(...)` (the skills half of
   `refreshSessionContext`, extracted as `rediscoverSkills(config)` so a reset
   and a rescan share it, CR-Q2 rules unchanged);
3. one synchronous stretch: if the generation is still `gen`, install
   `userRescan(current, freshSet)` — a PURE function: `tool` = current (the
   model's untouched), `activator` = fresh, `listing` = fresh entries with
   `model` = "offered to the model in THIS session now" (from `current`), plus
   `modelAfterReset: true` on a skill the disk offers the model but the current
   tool does not, plus one problem line per skill the model still lists but the
   disk no longer has (`"<name>: removed — the model keeps it until a context
   reset"`). If the generation moved (a reset or another rescan committed
   meanwhile), install nothing;
4. return the INSTALLED set's view (so the answer is always what the daemon
   will accept). Concurrent refreshes share one in-flight scan (dedupe).
A reset keeps installing the full fresh set at its commit (`agent.ts:1166`),
now with its listing; nothing else in the reset changes.

**3. Protocol 13 (breaking, cleanest shape).**
- New method `session/skills` `{ sessionId }` → `{ slash: SkillSummary[],
  skills: SkillListEntry[], problems, moreProblems }` (`slash` ≤
  `MAX_SKILL_CATALOG`, the `/name` list; the rest = today's `skills/list`
  result). It RE-SCANS (Design §2) — it is a request, so the client knows when
  the list is fresh. `SkillListEntry` gains optional `modelAfterReset` (a
  field is free, but it rides the bump anyway).
- Removed: `skills/list` and `InitializeResult.skills` (both are daemon-wide,
  hence wrong after a reset; keeping them would be a second, stale truth).
- `PROTOCOL_VERSION` 12 → 13: a 12/13 pair fails at `initialize` with
  `VersionMismatch` (no shim, pre-public rule). `schema/protocol.json`
  regenerated.
- Daemon: `HostedSession.skills()` → `factory.skills.refresh()` →
  `toSkillCatalog` (the `/name` subset: `user` and a spec name) + `toSkillList`
  (`mapping.ts`). `Connection` dispatches it like the other session-scoped
  requests (opened-by-this-connection check), concurrently (§7, no lock).
  `AgentFactory` gains `skills`.

**4. Client and runtimes — one seam.** `SessionController` gains
`skills(): Promise<SessionSkillsView>` (required: every runtime implements it).
Remote: `RemoteSession` → `session/skills`. In-process
(`session-jobs.ts`): the WiredAgent's `skills.refresh()` + the same
sanitising helpers (moved to a shared place both import — today
`main.ts:724` already uses `toSkillList` without a daemon). The global
`skills`/`skillsList` props of `startTui`/`LocalRuntime`/`RemoteClient.skills()`
are deleted.

**5. TUI — when it refreshes, and what the user sees.** A new pure module
`tui/src/skills-sync.ts` (React-free, unit-tested, §7) owns the cached view of
the CURRENT controller and decides when to call `controller.skills()`:
- **session start / switch** (`/clear`, `/sessions`, resume): fetch; until it
  answers the `/name` list is empty (first frame) — same as today before the
  handshake;
- **the `/` popup opens** (the input goes from not-starting-with-`/` to
  starting-with-`/`): fetch; the popup shows the cached list at once and
  re-renders when the fresh one lands (no flicker on equal lists);
- **`/skills` opens** and **`/help`**: fetch (the panel already loads async);
- **submit of an `unknown` `/word`**: if a fetch is in flight or the cache is
  older than the last `/`-open, await one fresh fetch and resolve AGAIN once;
  still unknown → today's unknown-command notice. (So typing `/new-skill⏎`
  faster than the scan never fails wrongly);
- **a turn that carried a `context_reset`** ends: fetch (model flags flip).
In-flight dedupe and a "result for an old controller" drop (a switch during a
fetch) are in the module. A fetch error leaves the cache and, in `/skills`,
shows today's `skillsListError`.
The user sees: a skill created in another window appears in the `/` popup the
next time they type `/`; `/skills` shows it with a dim `model: after a context
reset` mark (`modelAfterReset`) and lists "removed" problems; after a reset
the marks clear. No transcript notices (the list is the feedback).

**6. Pod `run`/`attach` and `connect`.** Nothing runtime-specific: the scan
runs in the daemon that hosts the session (pod: the pod's filesystem; `serve`:
the user's host at that session's cwd). A pod-supplied list only fills a list
and the pod's own activator (no laptop effect to gate, §7 "compute next to the
code"); it is sanitised both ends (Precondition 6). `connect`/`serve`: the
skill set is not persisted (derived from disk + history,
`tools/src/skill.ts:8-11`), so no record-version change; a re-attach asks
`session/skills` like a fresh open.

### Files

Dependency order. (~20 files.)
1. `packages/protocol/src/version.ts` (13), `session.ts` (drop
   `InitializeResult.skills`; comments), `skills.ts` (`SessionSkillsParams/
   Result`, `modelAfterReset`, drop `SkillsList*`), `methods.ts`
   (`session/skills`, drop `skills/list`), `index.ts`, `schema/protocol.json`
   (regenerated), `test/skills.test.ts`.
2. `packages/config/src/load.ts` (`rediscoverSkills` extracted; reset uses it).
3. `packages/agent/src/agent.ts` (`SessionSkills.listing`, installed set +
   `skillsGeneration`, `installedSkills()`), `agent/src/session.ts` (expose),
   new pure `agent/src/session-skills.ts` (`userRescan`).
4. `packages/daemon/src/session-host.ts` (`AgentFactory.skills`; delete the
   statics), `hosted-session.ts` (`skills()`), `connection.ts` (dispatch;
   `initialize` without skills), `mapping.ts` (`toSkillCatalog` home, view).
5. `packages/client/src/remote-client.ts` (drop catalog cache/`skills()`/
   `skillsList()`; session `skills`), the remote session/`client/src/mapping.ts`
   if the view is mapped there.
6. `packages/cli/src/wiring.ts` (`buildSessionSkills` + listing,
   `SessionSkillSource`, delete `skillCatalog`/`skillListing`), `worker.ts`,
   `serve.ts` (both hosts), `local-runtime.ts`, `session-jobs.ts`, `main.ts`
   (in-process + worker `startTui` props).
7. `packages/tui/src/skills-sync.ts` (new), `App.tsx`, `run.tsx`,
   `skills-panel.ts` (`modelAfterReset` mark), `commands.ts` only if
   `resolveSlash` needs the retry hook (prefer keeping it in `skills-sync.ts`).
8. Docs: this doc; `docs/feat/skills-panel.md`/`skills-slash.md` pointers
   ("static" → this doc).

### Failure modes

- **F1 — scan error / unreadable dir.** `discoverSkills` reports problems as
  diagnostics, it does not throw on a bad skill; a thrown error (e.g. EACCES on
  a root) → `session/skills` rejects, NOTHING is installed (the previous set
  stays), the TUI keeps its cache, `/skills` shows its error. Converges on the
  next fetch.
- **F2 — skills disabled** (`loadSkills: false`): `discoverSkills` returns
  empty with no I/O; the view is empty, as today.
- **F3 — race with a context reset** (the load-bearing ordering). A rescan's
  disk snapshot may be older than a reset that committed while it scanned →
  the generation check refuses the install; the reply is the installed
  (reset's) set. A rescan committing just before a reset's commit is then
  overwritten by the reset (newer). Two concurrent rescans share one scan.
  Test it (T3) with a gated fake discovery.
- **F4 — swap during a running turn.** Allowed: the user round captured its
  activator (`agent.ts:1197`); the model's tool is untouched; a `/compact`
  re-read uses the newest activator (a removed skill keeps its history copy).
  `session/prompt{skill}` is refused mid-turn anyway (`assertIdle`).
- **F5 — submit before the fresh list lands.** Covered by the
  resolve-again-once rule (Design §5). The daemon stays the judge: a name
  removed between the fetch and the prompt → today's `unknown skill` refusal
  (no silent drop).
- **F6 — session switch during a fetch.** The late result is for an old
  controller → dropped by `skills-sync.ts`.
- **F7 — disconnect / reconnect.** The request rejects (link down); the TUI
  keeps its cache; on re-attach the session-start fetch runs again.
- **F8 — version skew.** 12 ↔ 13 → `VersionMismatch` at `initialize`, worded by
  the existing path (`remote-client.ts:1017-…`). No partial mode.
- **F9 — hostile pod.** Oversized/control-char entries: cut/dropped by
  `toSkillList`, rejected by the client schema (the whole result → the TUI's
  error path, not a half list). A pod spamming "skills changed" is impossible:
  the client pulls, the daemon cannot push.
- **F10 — a large skill tree per keystroke.** No: fetches are per `/`-open,
  not per key; deduped.

### Tests

Red-before-green: T1–T4 fail on `main` (no rescan / static list).
- **T1 (agent, the load-bearing property):** a model tool offering `alpha`;
  `userRescan` with disk `alpha`+`beta` → `canActivateForUser("beta")` true,
  the next model request's `skill` enum is still `["alpha"]` and
  `messages[0]` unchanged; `listing` marks `beta` `modelAfterReset`.
  Mutation: install the fresh TOOL too → T1 must fail.
- **T2 (agent):** removed skill → problem line; `/compact` re-read keeps the
  history copy.
- **T3 (cli wiring, F3):** gated fake discovery: rescan starts, a reset commits,
  the rescan resolves → installed set is the reset's; and two concurrent
  rescans → one scan.
- **T4 (daemon+client over real objects, the `client/test/skills-list.test.ts`
  pattern):** open a session, add `beta/SKILL.md` to a temp root,
  `session/skills` → `beta` in `slash`; `session/prompt{skill:"beta"}`
  accepted; a non-opened session → refused; F1 (unreadable root) → rejects and
  the old set still accepts `alpha`.
- **T5 (protocol):** schemas; `skills/list` gone (`MethodNotFound`);
  `InitializeResult` without `skills`; version 13.
- **T6 (tui pure, `skills-sync.ts`):** fetch on session start, `/`-open (not
  on every key), `/skills`, after a `context_reset` turn; resolve-again-once
  on an unknown submit; late result after a switch dropped; dedupe.
- **T7 (tui frames, `app.test.tsx` pattern):** a fake controller whose
  `skills()` answers `alpha` then `alpha,beta`: type `/` → popup shows `beta`
  after the answer; `/beta⏎` typed before the answer still activates `beta`;
  `/skills` shows the `model: after a context reset` mark.
- **T8 (in-process path):** `inProcessSessions` controller's `skills()` sees a
  newly written skill (same `SessionSkillSource`).

### OWNER QUESTIONS

- **Q1 — a skill added WITHOUT a reset: can the user use it right away?**
  Recommended **yes, for the user only**: `/new-skill` works at once (its
  content is loaded into the conversation, so the model follows it); the
  MODEL's own list of skills it may pick by itself updates at the next context
  reset or new session (`/skills` says so). Alternative: also update the
  model's list at the next idle moment — but that rewrites the system prompt
  mid-conversation (cost: the prompt cache; the model told two different
  lists), which context-reset limited to a reset on purpose.
- **Q2 — when does the list refresh?** Recommended **when you look at it**:
  each time you type `/`, open `/skills` or `/help`, after a reset, and once
  more if you submit a `/name` not yet known. Alternative: a file watcher
  pushing changes live — the list would update with nothing typed, but it
  needs watchers on every skill dir (also inside pods, dirs created later),
  a new push update and its forward-compat class; I'd keep it as possible
  later work.

## Execution

*— claude-opus-5-5, 2026-10-26*

### Baseline and repro

- Gate baseline FIRST, on `a27ed93` + the untracked doc: `bun run check` →
  typecheck clean, `biome check .` clean (520 files), **3059 pass / 3 skip /
  0 fail** (3062 tests, 236 files).
- Repro (capability missing), run on the pre-edit code as
  `.tentacle/tmp/skills-hot-reload/repro.test.ts` (`bun <script>` needs an
  approval in this sandbox; `bun test <file>` does not — same code, in a
  `test()`): temp HOME with skill `alpha`, `SessionHost` with
  `createAgent: buildAgent`, `skills: skillCatalog(config)`,
  `skillList: skillListing(config)`, real `Connection` + `RemoteClient`;
  `beta/SKILL.md` written after `initialize`.
  ```
  client.skills(): [ "alpha" ]
  skills/list: [ "alpha" ]
  ```
  Both stale, as stated. (Order slip, honest: I had already edited two
  protocol files when I ran it; I put their HEAD text back by hand —
  `git diff --stat` then showed `session.ts` comment-only, `skills.ts`
  identical — ran the repro, then restored my edits from `cp` backups.)

### As built, in plan order

1. **protocol** — `version.ts` 12 → **13**. `skills.ts`: `SessionSkillsParams
   {sessionId?}`, `SessionSkillsResult {slash, skills, problems,
   moreProblems}`, `SkillListEntry.modelAfterReset?`; `SkillsList*` removed.
   `methods.ts`: `session/skills` registered, `skills/list` removed.
   `session.ts`: `InitializeResult.skills` removed (comments re-pointed).
   `schema/protocol.json` regenerated (`bun run schema:export`). No
   `session/update` variant → `UPDATE_CLASS` untouched (the client pulls).
2. **config** — `rediscoverSkills(config, env)` (`load.ts:307`) extracted
   from `refreshSessionContext`, which now calls it (same order, same
   CR-Q2 rules; the pinned start-up test in `cli/test/wiring.test.ts` stays
   byte-identical).
3. **agent** — new pure `session-skills.ts`: `SkillListing`,
   `EMPTY_SKILL_LISTING`, `userRescanListing(fresh, modelNow)` (`:40`).
   `agent.ts`: `SessionSkills.listing`; `AgentConfig.skillListing` (the
   start listing) and `AgentConfig.rescanSkills`; the Agent keeps `listing`
   + `skillsGeneration` (bumped by `installSkills` and by a rescan's install)
   + one in-flight `rescan`; `skillListing()` and `refreshUserSkills()`
   (`:443`): capture the generation, await the scan, then in ONE synchronous
   stretch install activator + listing only if the generation is unchanged
   (the `skill` tool in the registry is never touched); concurrent callers
   share the promise; a throwing scan installs nothing and rejects.
   `Session.refreshSkills()` exposes it.
4. **daemon** — `mapping.ts`: `toSkillList` carries `modelAfterReset`;
   new `toSessionSkills(listing)` (`:108`) = `slash` (the listing's `user`
   entries through `toSkillCatalog`) + `toSkillList`. `session-host.ts`:
   the `skills`/`skillList` options and statics deleted;
   `newSessionSkills` option + `SessionHost.newSessionSkills()` (`:214`).
   `hosted-session.ts`: `skills()` (`:914`). `connection.ts`: dispatch
   `session/skills` → `sessionSkills()` (`:235`): with an id, `lookup()`
   (opened-by-this-connection check, `UnknownSession` otherwise); no id →
   the host. No lock, no await before the dispatch (AGENTS §7 peer rule).
   `initialize` returns no skills.
5. **client** — `RemoteClient`: catalog cache, `skills()`, `skillsList()`
   and the handshake's catalog write deleted; `sessionSkills(sessionId?)`
   (`remote-client.ts:409`, "not connected" fast-fail like `mcpStatus`).
   `RemoteSession.skills()` (`remote-session.ts:468`): its id, or awaits the
   in-flight open, or — no daemon-side session yet — asks with no id.
6. **cli** — `wiring.ts`: `skillCatalog`/`skillListing` deleted;
   `buildSessionSkills(skills, diagnostics, readBody)` also builds
   `listing`; new `SkillScan`/`createSkillScan(config)` (`:188`): `latest()`,
   `scan()` (latest = the scan that STARTED last among those landed),
   `newSession()`; `BuildAgentOptions.skillScan`; `buildAgent` registers the
   MODEL's tool from `config.skills` (unchanged), but starts the user's
   activator + listing from `skillScan.latest()` and wires `rescanSkills`
   through the scan (or `rediscoverSkills` without one). `inProcessAgents`
   shares one scan. `worker.ts`, `serve.ts` (both hosts, `tunnelledAgent`
   included) create one scan per daemon and pass `newSessionSkills`.
   `local-runtime.ts`: `persistingController.skills()` forwards; the
   `skills`/`skillsList` runtime fields deleted. `connect.ts`, `main.ts`:
   the global props deleted (in-process: `toSkillList(skillListing(…))`
   gone). `session-jobs.ts`: the in-process controller's `skills()` =
   `toSessionSkills(await session.refreshSkills())`.
7. **tui** — new pure `skills-sync.ts` (`SkillsSync`: `use` / `slash` /
   `input` / `refresh` / `stale` / `settle`; dedupe, late-answer drop,
   equal-list no re-render). `App.tsx`: `SessionController.skills?()`; the
   `skills`/`skillsList` props deleted; one `SkillsSync` per App, fed by
   `watchSession` (start, `/clear`, `/sessions`, closed-elsewhere), an
   input effect (`/` popup open), `/skills` (panel loader), `/help` (asks,
   then prints), the end of a turn that streamed `context_reset`, and the
   unknown-`/word` branch (`App.tsx:1672`: stale → `settle()` → resolve
   again once via `handleCommandRef`). `run.tsx`: props deleted.
   `skills-panel.ts`: the expanded row says `model: after a context reset`.
8. **docs** — superseded-by notes at the top of `skills-panel.md` and
   `skills-slash.md`; this section.

### Drift from Implementation (and why)

- **D1 — lazy remote sessions (the plan contradicted the code; fixed).**
  `RemoteSession` creates its daemon-side session at the FIRST send
  (`remote-session.ts` `open()` is a no-op for a fresh one; `rename` already
  documents "before the first send there is no daemon-side session"). So
  `session/skills{sessionId}` could not serve the `/` popup of a fresh
  session — as planned, the most common case (`/new-skill` as the first
  thing typed) would have regressed to an EMPTY popup and "Unknown
  command". Fix: `sessionId` is optional; with none the daemon answers the
  skills "a session created now would have". To keep that list and the
  daemon's judgement equal, each daemon has ONE shared `SkillScan`: the
  no-id ask scans through it, and `buildAgent` starts a new session's
  `/name` activator from its `latest()` (the MODEL's tool/system prompt stay
  the start-up's, as before). Proven by T4a + its mutation.
- **D2 — rescan orchestration lives in the Agent, not in `wiring.ts`.** The
  generation check, the dedupe and the install are `Agent.refreshUserSkills`
  fed by `AgentConfig.rescanSkills` (a full fresh `SessionSkills`). Reason:
  the generation is the Agent's private state (no `installedSkills()` +
  outside compare-and-install), and `AgentFactory`/`HostedSession`'s
  positional constructor stay unchanged (`HostedSession.skills()` reaches
  it through `Session.refreshSkills()`). So T3 is an agent test with a gated
  fake rescan, and `AgentFactory` gains nothing. The "pure `userRescan`"
  is `userRescanListing(listing, modelNow)`: only the listing needs
  computing (the tool is simply not replaced).
- **D3 — `SessionController.skills` is optional**, not required: the App's
  own `new Session(agent)` fallback and the many test fakes have none
  (absent → no skills; `/skills` says "No skills on this daemon."). Every
  production runtime implements it (remote via `RemoteSession` +
  `persistingController`; in-process via `session-jobs.ts`).
- **D4 — sanitising helpers' "shared place"** = `@tentacle/daemon`'s
  `mapping.ts` exports (the in-process path already imported `toSkillList`
  from there); nothing moved.
- **D5 — Precondition 7 was wrong about mobile:** `apps/mobile/src/spike.ts:85`
  logged `init.skills.length`. Typecheck caught it; the log field was
  dropped (a spike's diagnostic line, no behaviour).
- **D6 — test fixtures:** 13 test files' fake `initialize` results carried
  `skills: []`; removed (the four `toEqual(INIT_RESULT)` transport tests
  failed on it — the schema now strips it). `app.test.tsx` "loading
  placeholder": the session-start ask is in flight when the panel opens
  and the panel shares it, so its delay went 80 → 200 ms; "without a
  provider" now asserts "No skills on this daemon." (no provider prop any
  more). `daemon/test/version-mismatch.test.ts` pins 13.
- **F1 at the cli level not tested on a real disk:** `discoverSkills` turns
  an unreadable root into a diagnostic, it does not throw, so a real-disk
  "scan throws" is hard to provoke; the throw path is tested with fakes at
  the agent (`skills-hot-reload.test.ts` F1) and over the wire
  (`daemon/test/skills-slash.test.ts`: rejects, the session still accepts
  `deploy-app`).
- **`/help` waits for the fresh list** before printing (plan: "fetch"):
  printing a list known stale seemed wrong; the wait is one scan (a link
  down fails fast).

### Tests (new / rewritten) and red → green

New: `agent/test/skills-hot-reload.test.ts` (T1, T2, T3, pure
`userRescanListing`), `cli/test/skills-hot-reload.test.ts` (T4 over real
files + `createLocalRuntime`; T8 in-process), `tui/test/skills-sync.test.ts`
(T6), T7 in `tui/test/slash-skills.test.tsx`; rewritten:
`protocol/test/skills.test.ts` + `session.test.ts` (T5),
`daemon/test/skills-slash.test.ts` + `skills-list.test.ts`,
`client/test/skills-slash.test.ts` + `skills-list.test.ts`, the
`wiring.test.ts` catalog/listing tests (now through `agent.skillListing()`).

Honest note on "red before green": the tests were written right after
each slice's code, so their red on the old code would have been a missing
symbol, not an assertion. Non-vacuity was proven by **mutation on the
assertion of the property** instead — each mutation applied, run, reverted
from a `cp` backup in `.tentacle/tmp/skills-hot-reload/bak/`, and the file
proven byte-identical with `shasum`:

| Mutation | Test | Red on |
|---|---|---|
| `PROTOCOL_VERSION` 13 → 12; `InitializeResult.skills` back (optional) | protocol T5 | `Expected: 13 Received: 12`; `"skills" in parsed.data` true (3 fails) |
| rescan installs the fresh TOOL too | agent T1/T2 | beta `model: true` instead of `false/modelAfterReset`; "removed" problem missing |
| **drop the generation check (stale rescan vs reset, F3)** | agent T3 | listing `["alpha","beta"]`, expected the reset's `["alpha","gamma"]` |
| no in-flight sharing (agent) | agent T3 | `Expected: 1 Received: 2` scans |
| `session/skills` ignores `sessionId` | daemon | 4 fails (empty `slash`, no `UnknownSession`, F1 resolves) |
| `RemoteSession.skills()` drops its id | client | params `{}` instead of `{sessionId:"S"}` |
| **new session's activator from start-up, not `skillScan.latest()` (D1)** | cli T4a | `RpcError: unknown skill "beta": not invocable in this session` |
| no in-flight sharing (`SkillsSync`) | tui T6 | `Expected: 1 Received: 4` asks (the rest of that run then hung on unanswered promises; stopped, reverted) |
| `SkillsSync` keeps a late answer for an old source (F6) | tui T6 | `["stale"]` instead of `["new"]` |
| no resolve-again on an unknown `/word` | tui T7 | `sent` `[]` instead of `[{"/beta go", skill:"beta"}]` |

Hashes after revert (each equal to its backup): `version.ts ac63ce31…`,
`session.ts bfef82f8…`, `agent.ts 16a429e2…` (corrected in review round 1; was 43880dda…, edited after the mutation record), `connection.ts 9da9c9c2…`,
`remote-session.ts 470078b7…`, `wiring.ts de72f905…`,
`skills-sync.ts 3e81d345…`, `App.tsx 2dcd9118…`.

### Frames (TUI, `.tentacle/tmp/skills-hot-reload/frames.test.ts`)

A controller whose first `skills()` answers `alpha`, every later one waits,
then answers `alpha`+`beta`; `/` typed, then `be`:
```
--- popup '/be', fresh list held:
────────────────────────────────────────────────────────────
❯ /be
────────────────────────────────────────────────────────────
--- popup '/be', fresh list landed:
❯ /beta  the beta skill
────────────────────────────────────────────────────────────
❯ /be
────────────────────────────────────────────────────────────
--- '/beta go⏎' before the list lands: sent=[]
--- after it lands: sent=["/beta go {skill:beta}"]
```

### Invariants checked

- One session path: every runtime reaches skills through
  `SessionController.skills()` (remote `RemoteSession` → `session/skills`;
  in-process `Session.refreshSkills()`); no second channel, no push.
- Pure module: decisions in `skills-sync.ts` (and `userRescanListing`);
  `App.tsx` only feeds events and renders `slash()`.
- Peer not serialized: `Connection.sessionSkills` has no lock; the scan is
  awaited inside the handler only; concurrent asks dedupe in the Agent.
- Persistence: nothing persisted changes (`DAEMON_RECORD_VERSION` stays 7;
  the skill set is derived from disk + history).
- Model's set changes only at a reset: T1 (enum + `messages[0]`) and T4
  (real `buildAgent`: enum `["alpha"]`, system prompt without `beta`).

### Gate at the end

`bun run check` (exit 0): typecheck clean (incl. `apps/mobile`), `biome
check .` clean (520 files, 0 errors / 0 warnings — the lint baseline),
**3092 pass / 3 skip / 0 fail** (3095 tests, 239 files) vs baseline
3059 / 3 / 0: +33 tests, the 3 skips are the opt-in ones. The first end
run had 6 fails (stale `skills: []` fixtures in 4 transport tests, the
version pin, the panel-loading timing) — fixed as listed in D6, then this
green run.

### Open for the owner / Review

- **D1 is a design addition the approved plan did not have** (`sessionId`
  optional + a per-daemon shared `SkillScan` that seeds a new session's
  `/name` activator). It is the load-bearing point to red-team, with the
  F3 ordering (`Agent.refreshUserSkills`).
- A rescan ask that joins a scan already in flight answers that scan's
  disk (a file written after it started is seen at the next ask).
- `/help` now waits for one scan before printing.

## Review

> **Owner decisions (2026-10-26):** Q1 — yes: a skill added without a reset is usable at once via `/name`; the model-facing list changes only at the next reset. Q2 — refresh on open (`/`, `/skills`, `/help`, unknown `/name`); no file watcher (future work).

*— claude-opus-5-5, 2026-10-26* (fresh context; **same model as the executor** —
shared blind spots can survive both passes, and this is load-bearing work, so a
review by a different model would add assurance)

### Verdict: REQUEST-CHANGES (small)

The core holds: the F3 ordering, Q1, the v13 bump and the one-session-path
invariant. One user-visible regression has to be fixed first (finding 1), and
one load-bearing property of the D1 addition has no test (finding 2).

### Findings

1. **Medium — `/help` and the "Unknown command" notice can hang forever.**
   `App.tsx:1500` (`/help`) and `App.tsx:1672-1674` (unknown `/word`) await
   `skillsSync.settle()` with no time limit. `RemoteClient.call`
   (`remote-client.ts:1017`) has no timeout either, and the "not connected"
   fast-fail covers only a link that is down. So a daemon that is up but slow
   or stuck, or a hostile pod that never answers `session/skills`, means
   `/help` never prints and a mistyped `/word` gets no notice at all. Before
   this change, `/help` was local and instant. Repro
   (`.tentacle/tmp/skills-hot-reload-review/hang.test.ts`, a `SkillsSync` with
   a source that never answers): `help/unknown-word path: still waiting after
   500 ms`. This is the executor's declared `/help` drift; the plan said only
   "fetch". Fix: print `/help` from the cached list at once (the plan's shape),
   or bound `settle()` in `skills-sync.ts` (for example ~2 s, then fall back to
   the cache). Add a test with a source that never answers.
2. **Low (test gap) — the shared scan's ordering is untested.**
   `wiring.ts` `createSkillScan` keeps `latest` = "the scan that started last
   among those that landed" (`if (n > landed)`). I mutated it to always
   overwrite: `cli/test/skills-hot-reload.test.ts` + `wiring.test.ts` stayed
   **35 pass / 0 fail**. That rule decides which activator a new session (D1)
   starts with, so it needs a test with two gated overlapping scans.
3. **Low — the popup can lag one scan behind.** `skills-sync.ts:63-68`: if `/`
   is opened again while an ask is in flight, it joins that ask and no new ask
   is made. Repro: `asks: 1 stale after landing: true`. A skill written between
   the two opens appears only at the next open. It is covered for submits
   (`stale()` stays true, so an unknown `/word` asks again), so this is
   acceptable. Name it in the doc or ask again when `freshAt < opens` after
   landing.
4. **Low / latent — D1's scan is tied to the daemon's cwd.** `createSkillScan`
   (`serve.ts:160`, `:431`; `worker.ts:97`) reads `config.cwd`, while a reset
   reads the session's `{...config, cwd}`. Today they are always equal:
   `SessionHost` calls `createAgent(this.opts.defaultCwd)` only
   (`session-host.ts:754`), and `serve` is one project per daemon
   (`projectKey`). So **no cross-project leak today**. If a per-session cwd is
   ever honoured, rescans would read another project's skills. Pin this with a
   comment on `createSkillScan`. Also minor: a reset does not update
   `latest`, but the next ask rescans anyway.
5. **Low — the delayed retry runs on the session that is current when it
   fires.** `App.tsx:1672`: if the user switches session between the submit
   and `settle()`, the retried `/name` resolves against the NEW session's
   list. The running-turn and switching guards are re-checked
   (`App.tsx:1446-1456`), so nothing corrupts. It is an edge case; dropping
   the retry when the source changed would close it.
6. **Nit (doc) — one Execution hash is stale.** It lists `agent.ts 43880dda…`;
   the file on disk is `16a429e2…`. It was edited after the mutation record.
   `wiring.ts de72f905…` matches.

### Owner decision D1 (not approved in the plan) — recommend **accept**

Optional `sessionId` plus one `SkillScan` per daemon is correct, and it is the
smallest fix for a real premise. I checked on `a27ed93`: `remote-session.ts:259`
says "Before the first send there is no daemon-side session". So the plan's
id-only shape would have left a fresh session with an empty popup.

It is **not a second source of truth**:
- With an id, the answer comes from the session's own agent
  (`connection.ts:236-240` → `HostedSession.skills()`).
- Without an id, the answer comes from the same scan that the next session's
  `/name` activator is built from (`wiring.ts` `buildAgent`: `start =
  skillScan.latest()`). T4a pins this, and the executor's mutation of it was
  red.

Nothing leaks that `initialize.skills` did not already expose: one daemon,
one project, finding 4. The alternative, opening the session eagerly so there
is always an id, would change lazy-open semantics across every runtime. That
is more blast for no gain.

### Gate (re-run by me)

`bun run check`, exit 0: typecheck clean (incl. `apps/mobile`); `biome check .`
520 files, clean; **3092 pass / 3 skip / 0 fail** (3095 tests, 239 files). This
matches Execution, and the 3 skips are the opt-in ones.

### Mutations (backed up with `cp` to `.tentacle/tmp/skills-hot-reload-review/bak/`, reverted, `shasum` identical)

| # | Mutation | Result |
|---|---|---|
| M1 | `refreshUserSkills` ignores the generation check (F3) | **red**: T3 "a reset that installs while the scan runs wins" |
| M2 | the rescan also installs the fresh `skill` TOOL (breaks Q1) | **red**: T1, T2, T4 "open session", T8 (4 fails) |
| M3 | `createSkillScan` always overwrites `latest` | **survived**: 35/0, finding 2 |

After revert: `agent.ts 16a429e2…`, `wiring.ts de72f905…`, each equal to its
pre-mutation hash.

### Premise table (on `a27ed93`)

| Premise | Verdict |
|---|---|
| Context symptom: the `/name` list and `skills/list` are static | TRUE: `session-host.ts:200-212` built in the constructor (the executor's repro: `["alpha"]` both) |
| User round captures its activator at the start (`agent.ts:1197`) | TRUE (`const activator = this.activator;` at the round start; line drifted by about 3) |
| `/compact` re-read uses the activator in force (`agent.ts:447`) | TRUE (`reloadSkills`, `through === undefined ? this.activator`) |
| Precondition 7: no mobile consumer | **FALSE**: `apps/mobile/src/spike.ts:85` read `init.skills`. Caught by the executor (D5) and fixed |
| Remote sessions open lazily (the D1 premise) | TRUE: `remote-session.ts:259` |
| Sessions always built at `defaultCwd` | TRUE: `session-host.ts:754` |

### Attacks tried

- **F3, a slow rescan vs a reset:** the generation check plus the install,
  all in one synchronous `.then`. A caller who joins a stale in-flight scan
  gets the reset's listing back. Holds (M1 red).
- **Two clients / dedupe:** shared at the Agent (`rescan` promise) and at
  `SkillsSync`. Holds.
- **Reconnect:** `sessionSkills` fails fast while the link is down; the cache
  is kept. Holds. A link that is UP but never answers is finding 1.
- **Pod `run`/`attach` (§7 "a pod is not trusted"):**
  - Pod data is sanitised by `toSkillList`/`toSkillCatalog` and validated by
    `SessionSkillsResultSchema` (rejected whole).
  - Activating a skill goes back to the pod only, so there is no laptop
    effect, no approval and no write.
  - The pod cannot push.
  - The only lever a pod gets is to stall `/help` (finding 1).
- **Cross-project leak on `serve`:** none today (finding 4).
- **Q1:** `/beta` works at once, while the model's enum stays `["alpha"]` and
  `messages[0]` has no `beta` (`cli/test/skills-hot-reload.test.ts:100-125`).
  M2 confirms the test is not vacuous. Holds.
- **Protocol:**
  - `PROTOCOL_VERSION` 13 (`version.ts:7`).
  - `skills/list` is gone (`isMethodName` false, pinned).
  - `InitializeResult.skills` is removed from the schema, the daemon
    (`connection.ts:321`), the client (the handshake no longer writes it) and
    mobile.
  - The schema is regenerated (the json-schema test pins it).
  - `daemon/test/version-mismatch.test.ts` pins 13.
  - Holds.
- **§7 "Don't serialize the RPC peer":** `Connection.sessionSkills` has no lock
  and no await before the dispatch; the scan runs inside its own handler only.
  Holds.
- **§7 "Never write raw to the terminal":** no new stdout/stderr writes. Holds.
- **§7 one session path:** remote goes `RemoteSession.skills()` →
  `session/skills`; in-process goes `session-jobs.ts` →
  `Session.refreshSkills()`. Both use `toSessionSkills`. No second channel.
  Holds.
- **§7 "Logic lives in pure modules":** the decisions are in `skills-sync.ts`
  and `userRescanListing`. `App.tsx` only feeds them events. The `/help` wait
  and the retry-once branch are thin glue. Holds.
- **Scope (54 files vs ~20 planned):**
  - 13 test fixtures dropping `skills: []`: forced by the schema change (the
    transport `toEqual` tests).
  - `spike.ts`: forced.
  - `/skills` "No skills on this daemon." text and the
    `not invocable in this session` refusal wording: small and justified.
  - No unrelated refactor found.
  - Scope OK.

### How the executor behaved

The executor was honest and thorough. It ran the baseline first. It disclosed
the order slip around the repro and that the tests were not written red-first.
To make up for that, it proved non-vacuity with 10 mutations, and I confirmed
the 2 load-bearing ones. It found and declared the drifts itself, including
the false mobile premise. Two weak spots:
- It turned the plan's "fetch" for `/help` into an unbounded wait (finding 1).
- It left the shared-scan ordering untested (finding 2), even though that
  ordering is what D1 relies on.

### Execution — review fixes

*— claude-sonnet-5-5, 2026-10-26*

- **F1 (medium) — `/help` / unknown `/word` hang.** `SkillsSync.settle(timeoutMs = 2000)`
  (`skills-sync.ts`) races the ask against a timer and then proceeds with the
  cached list; the decision is in the pure module, `App.tsx` unchanged for
  `/help`. Red on the old code: `Expected: not "hung"` (`skills-sync.test.ts`,
  fake source that never answers). Green after.
- **F2 (low) — `createSkillScan` ordering.** New seam: optional second arg
  `rediscover` (default `rediscoverSkills`); new `cli/test/skill-scan.test.ts`
  (two gated overlapping scans). Mutation M3 (`n > landed` → `n > 0`): red,
  `Expected "second" / Received "first"`; restored from `cp` backup, `shasum`
  identical (`wiring.ts e6c326ba…`). Daemon-cwd coupling (F4): documented as debt
  in the `SkillScan` comment, no code.
- **F5 (low) — retry pinned to its session.** `settle()` now resolves `true`
  only if the source is unchanged; `App.tsx` retries the unknown `/word` only
  then. Red: `Expected: true / Received: undefined`.
- **F3 (low) — popup one scan behind: fixed** (cheap): after an answer lands,
  if `freshAt < opens` the sync asks once more. Red: `Expected: 2 / Received: 1`
  asks. Terminates: the re-ask is made with `at = opens`.
- **Nit:** stale `agent.ts` hash corrected above.
- Existing `settle() never rejects` test now asserts `true` (return type changed).

### Review — fix round

*— claude-opus-5-5, 2026-10-26* (fresh context; a different model from this
round's executor (sonnet), but the same family as the first reviewer)

**Verdict: APPROVE-WITH-NITS → MERGE.** All five first-round findings are
closed. None of the nits blocks the merge.

**Findings**

1. **Low (test gap) — `App.tsx:1673` `if (same)` is not pinned at App level.**
   I mutated it to `same || true` and `app.test.tsx` + `skills-sync.test.ts`
   stayed green (83 pass; only M-B's 2 tests failed, see below). The pure half
   is pinned: `settle()` → `false` after `use(b)`. The App only forwards that
   one boolean, so this is thin glue, but an App test that switches session
   inside the window would pin it.
2. **Nit (UX) — a dropped retry is silent.** When `same === false`
   (`App.tsx:1672-1676`), the unknown `/word` gets no notice at all. That is
   acceptable, because the user moved to another session, but it is a silent
   drop.
3. **Note (pre-existing, not this round) — a hung ask is never cleared.**
   After `settle()` times out, `inflight` stays pending forever. Every later
   `refresh()` joins it, `stale()` stays true, so each unknown `/word` costs
   2 s, and the `/skills` panel stays on "loading…". It converges only on
   `use()` (a session switch). A link-level timeout would fix it at the root
   (`RemoteClient.call` has none).

**Gate (re-run by me):** `bun run check` exit 0: typecheck and lint clean;
**3097 pass / 3 skip / 0 fail** (3100 tests, 240 files). This matches the
Execution, and the 3 skips are the opt-in ones.

**Mutations** (backup with `cp` to `.tentacle/tmp/skills-hot-reload-review2/bak/`,
restored; `shasum` identical: `App.tsx f5389e77…`, `skills-sync.ts c2bbd26d…`,
`wiring.ts e6c326ba…`)

| # | Mutation | Result |
|---|---|---|
| M-A | `App.tsx` retry guard `if (same)` → `if (same \|\| true)` | **survived** (finding 1) |
| M-B | `skills-sync.ts` re-ask after landing disabled | **red**: `skills-sync.test.ts` "a / open while an ask is in flight…" (`Expected 2 / Received 1`) and `app.test.tsx` "/skills panel … loading placeholder" |

**Attacks tried** (`.tentacle/tmp/skills-hot-reload-review2/loop.test.ts`, 5/5
as stated)

- **(1) Re-ask loop or hammering.** The source returns a DIFFERENT list on
  every scan.
  - One `/` open joined to an ask in flight → **2 asks**, then it stops.
  - 50 opens during one ask → **2 asks**: they collapse into one re-ask, made
    with `at = opens`.
  - Two `SkillsSync`s on one source → **4 asks** (2 each), with no
    cross-trigger. Each client has its own counters, and the daemon never
    pushes.
  - A failing source → **1 ask**: there is no re-ask on rejection, so no
    retry storm.
  - The list's content never feeds the re-ask decision. Only `freshAt < opens`
    does, and it is bounded by the user's opens. **Holds.**
- **(2) `settle()` timer.** It is cleared in `finally`. `settle(10_000)` on a
  source that answers in 1 ms returned at once, and the bun process exited
  normally, so no timer is left. No late answer overwrites a newer one: there
  is one in-flight ask per source, and a stale source is dropped by
  `this.source !== source` (`skills-sync.ts:99`). The decision lives in the
  pure module; the App only consumes a boolean. **Holds.**
- **(3) Retry pinned to its session.**
  - Session switch → `use(b)` → `false` → no retry. This is pinned by the pure
    test, but not at App level (finding 1).
  - Reset → no `use()` is called (`App.tsx:1037` calls `settle()` only), so
    the retry still runs on the same session. That is correct.
  - `use(a)` → `use(b)` → `use(a)` (`App.tsx:1752`, restoring the old session
    after a failed `/clear`) returns `true`. The retry then runs on `a`, which
    is the session it was typed in. That is correct too.
  - **Holds.**
- **(4) `rediscover` injection.** All four production call sites still pass
  one argument (`worker.ts:97`, `serve.ts:160`, `serve.ts:431`,
  `wiring.ts:488`). The default is `rediscoverSkills`, so production wiring is
  unchanged. The ordering test (`skill-scan.test.ts`) uses gated overlapping
  scans; the executor's M3 was red. **Holds.**
- **(5) Non-vacuity.** M-B was red. M-A survived (finding 1).

**How the executor behaved:** focused and honest. It fixed exactly the five
findings, plus the nit, in the smallest shape. It showed each fix red → green,
and it restored its M3 mutation with a `shasum` check. It left one gap: the
App-level guard (finding 1).

> **Owner decision (2026-10-26 21:00):** D1 ACCEPTED (optional `sessionId` on `session/skills` + one shared `SkillScan` per daemon). Merge approved. Debt carried: App-side test for the `if (same)` retry guard (`App.tsx:1673`, mutation survives); a dropped `/word` retry after a session switch gives no notice; daemon-cwd scan coupling (see `SkillScan` comment).
