# feat/session-capabilities — turn MCP servers and skills on/off for one session

> **Status:** implementation — **Implementation APPROVED by the owner (2026-11-15) — UI slices wait for the mockups** (S4, S5: `.tentacle/tmp/session-capabilities/mockups/index.html`, UI questions at the end)
> **Branch:** `feat/session-capabilities`
> **Size:** L (6 slices: S1 S · S2 M · S3a M · S3b M · S4 M **UI** · S5 M **UI**) · **Blast:** load-bearing (the agent loop's per-round request, protocol, session log) · **Suited:** Opus plan; S1/S4/S5 a weaker model is fine, S2/S3a/S3b a strong model; Review mandatory, in a fresh context, red-teaming §7 (single session path, persistence, a pod is not trusted)
> **Changelog:** `changelog.d/session-capabilities.added.md`: "**Turn MCP servers and skills off for one session.** `/mcp` and `/skills` (and Session info on the iPhone) can hide a server or a skill from the model for the current session; it takes effect on the next model call and is kept with the session."

## Context

*— claude-opus-5-5, 2026-11-15*

Owner request (2026-11-15, `TODO.md`): "se devo giocarci a dama non mi serve
fargli vedere mcp o skill su k8s". In a session the user wants to turn off
individual **MCP servers** and **skills**, so the model **does not see** them:
they are absent from the tool list and from the skills catalog sent to the
model. They are not just denied at the permission prompt. Reasons:
context/token economy, less distraction, and no stray k8s calls in a checkers
game.

Today the model's capability set is fixed per launch or context:

- **MCP tools** are registered once into the session's `ToolRegistry`, by the
  daemon-wide hub (`packages/cli/src/mcp-hub.ts:96-111`, `onBuilt` `:173-178`).
  Every registered tool goes to the model on every round:
  `this.config.tools.definitions()` is called per round
  (`packages/agent/src/agent.ts:1211`), and every registered tool is listed
  (`packages/tools/src/registry.ts:56-66`).
- **Skills**: the catalog is a **suffix of the system prompt** (history[0]):
  `${withAgents.trimEnd()}\n\n${catalog}\n` (`packages/config/src/resolve.ts:436-438`,
  `renderSkillsCatalog` `packages/config/src/skills.ts:227-246`). The `skill`
  tool's enum is the same set (`offeredSkills`, `skills.ts:218-220`;
  `z.enum` `packages/tools/src/skill.ts:233`). The model's set changes only at a
  context reset (`agent.ts:2316-2345`; `session-skills.ts:5-8`).
- No session-level switch exists anywhere: the Repro below.
- The surfaces that list them already exist: TUI `/mcp` (`packages/tui/src/mcp-panel.ts`),
  `/skills` (`packages/tui/src/skills-panel.ts`), and the iPhone Session info
  (`docs/feat/mobile-session-info.md`: MCP servers via daemon-wide `mcp/status`,
  skills via `session/skills` with a per-skill `model` flag). So by the parity
  rule the toggles go on both.

Constraints: §7 TUI-over-RPC, a single session path (the switch is a session
RPC, and every runtime gets it through `RemoteClient` ↔ `Connection`).
Persistence on the laptop plus the trusted `serve` daemon. A pod is not
trusted. Protocol is pre-public: breaking is allowed, but the change here is
additive. UI is decided by the owner on mockups, in the feat/mobile-chrome
style.

**Repro (2026-11-15, `feat/session-capabilities` = `main` da1958f0):** the
capability is missing. A search of `packages/` for any session-level switch
(`set_capabilit|disabledSkills|disabledMcp|sessionCapabilities`):

```
Found 0 total occurrences across 0 files.
```

The executor re-runs a behavioural repro in `.tentacle/tmp/session-capabilities/`
before S2. It starts `startDaemon` with the stdio fixture
(`packages/cli/test/fixtures/mcp-stdio-server.ts`, as in `docs/feat/serve-mcp.md`
Repro), opens a session with a recorder provider, sends one prompt, and prints
the request's tool names. `mcp__echo__echo` is present and nothing can remove
it. They paste the script and its output here.

## Implementation

*— claude-opus-5-5, 2026-11-15*

**Implementation APPROVED by the owner (2026-11-15) — UI slices (S4, S5) wait for the mockups.** Revised to the owner's answers: panel only (no typed commands), non-critical log entry, disabled-set, `/clear` and hop keep the switches, presets later.

### Load-bearing assumption

**The model request is rebuilt on every round from two seams that the change can
project without touching the stored history:** the tool list
(`this.config.tools.definitions()`, `agent.ts:1211`, and `contextUsage`
`agent.ts:1680`) and the message view (`modelView(messages)`, `agent.ts:1215`,
`packages/agent/src/context-awareness.ts:65-74`). `modelView` already
transforms the stored history into "the model's copy" (repair + render) and
leaves the store untouched. So "hidden" can be a **pure per-round projection**:

- filter the definitions,
- rewrite the `skill` definition's enum,
- swap the catalog suffix of the system message.

The stored `messages`, the session log and the registry are never mutated.
Disabling and re-enabling is lossless. Compaction and `context_reset` keep
working unchanged, because they recompose the full system prompt
(`load.ts:418-449`) and the projection is applied to it again.

Verified: tools (`agent.ts:1211`, per loop iteration) and view (`:1215`). To
verify in S2 before any edit: that no other request builder bypasses these two
(the step-limit final request, the compaction summary request, a sub-agent's
loop). Grep `ChatRequest = {` and `definitions()` in `packages/agent/src`.
Each one found goes through the same projection, or is shown to send no
tools/system prompt.

### Preconditions

- The catalog is the **last** block of the system prompt, rendered
  deterministically from the offered set (`resolve.ts:436-438`,
  `skills.ts:227-246`). `SKILLS_PROMPT_HEADER` starts it (`skills.ts:11`).
- The `skill` tool's enum = `offeredSkills` (`skills.ts:214-220`). The agent
  knows the model's current set (`offeredSkillNames(this.config.tools.definitions())`,
  `agent.ts:882`, `:2316`).
- MCP tools are named `mcp__<server>__<tool>` (`packages/mcp/src/tool-adapter.ts:40-42`).
  But a server name may itself contain `__`, so the server is **tagged** on the
  `Tool`, not parsed from the name (Design).
- Sub-agents get a filtered subset of the parent's registry
  (`packages/agent/src/subagent.ts:284-285`, `:367`). The projection must reach
  them too (S2).
- A per-session state already has the exact shape we need:
  `session/set_auto_accept`. It is whole-state, idempotent, broadcast to every
  attachment with `by`, held by a sharing daemon, an `OpenParams` field for a
  CREATED session, an `OpenResult` snapshot, and the `serve` sidecar
  (`packages/protocol/src/session.ts:976-1000`, `:905-940`; `updates.ts:322-340`
  `auto_accept: "display"` `:513`; `packages/daemon/src/daemon-state-file.ts:96`).
  We copy that pattern, except for the op shape (delta, F4).
- Session-log entries: unknown + non-critical ⇒ skipped, unknown + critical ⇒
  the whole log refused. Adding a **critical** type is an owner decision and
  needs a `PROTOCOL_VERSION` bump (`packages/protocol/src/session-log.ts:12-22`,
  table `:274-288`). The daemon emits typed entries next to `title`
  (`packages/daemon/src/session-log.ts:131`).
- `session/update_settings` rebuilds the agent and is **idle-only**
  (`session.ts:957-965`). That is wrong for this feature: the switch must work
  mid-turn without a rebuild. So the switch is NOT a carried setting.
- Pods today run **no MCP hub** (`createMcpHub` is used only by `startDaemon`
  `serve.ts:384` and the worker; laptop `mcpServers` do not apply in a pod,
  `docs/feat/config-carry.md` Q5). A pod session's MCP list is empty. Its
  skills are the pod's disk.

### Design

**State.** Each session holds `SessionCapabilities = { disabledMcp: string[], disabledSkills: string[] }`:
sorted, de-duplicated server and skill names. It is a **disabled** set, so
anything new (a server added to the config, a skill created on disk) is **on**
by default. A name that no longer exists stays in the set; it is harmless and
comes back off if the thing reappears. MCP granularity is per server.
Per-tool is a later field: fields are free (§7 forward-compat), so nothing is
reserved now.

**Pure module** `packages/agent/src/capabilities.ts` (React-free, §7):

- `applyCapabilityOp(state, op) → state`. `op = { kind: "mcp" | "skill", name, enabled }`.
  It is idempotent and returns the same object when nothing changed.
- `projectTools(defs, serverOf, state) → defs`. It drops every def whose tool
  is tagged with a disabled server. It rewrites the `skill` def's
  `parameters.enum` minus the disabled skills, and drops `skill` entirely when
  that leaves nothing (a `z.enum` cannot be empty, `skill.ts:233`).
- `projectSystem(content, offered, state) → content`. It cuts at the **last**
  `\n\n${SKILLS_PROMPT_HEADER}` and re-renders `renderSkillsCatalog(offered − disabled)`.
  That reuses the one renderer, so the bytes are identical to a composed prompt
  of that set. With nothing left it gives `withAgents.trimEnd()`. With no
  header found, it returns `content` unchanged (no catalog to hide).
- `isHidden(toolName, serverOf, state)` and `isSkillHidden(name, state)`, for
  the execution guard.

**Agent (S2).**

- `Agent` holds `capabilities` (initial value from the builder) and gets
  `setCapabilities(state)`.
- The round at `agent.ts:1211` takes a **snapshot** and sends
  `projectTools(defs)` plus a view whose system message is `projectSystem(...)`.
  `contextUsage` (`:1680`) and `estimateUsed` use the same projection, so the
  status bar counts what is really sent.
- **Execution guard:** a call in a round's response is judged against **that
  round's snapshot**. A call to a tool that was hidden in the snapshot (the
  model hallucinating from older history) gets an error result:
  `"<tool> is turned off for this session"`. It is never executed. The same
  goes for `skill{name}` with a disabled name.
- Sub-agents spawned from this session use the parent's live state.
- On `/compact` and `context_reset`, `carryOverSkills` (`compact.ts:226`) does
  NOT carry the bodies of disabled skills: the new history must not
  re-introduce what the user hid.
- A user's own `/name` of a disabled skill still works (owner, Q4).

**MCP tag.** `Tool` (`packages/core/src/tool.ts:155-179`) gets an optional
`readonly mcpServer?: string`, set by the MCP adapter. `serverOf` reads it.

**Protocol (S3a), additive, no `PROTOCOL_VERSION` bump.**

- Request `session/set_capability {sessionId, kind: "mcp"|"skill", name, enabled}`
  returns `{capabilities}`, the whole state AFTER. A delta, not whole-state:
  two clients toggling *different* items both land (F4).
- Update `capabilities {capabilities, by?}`: class **display** in `UPDATE_CLASS`.
  It goes to every attachment, own echoes included, only on a change. An
  older client shows `unsupported` once. It cannot toggle anyway, and what
  the model sees is daemon-side.
- `OpenResult.capabilities` is the snapshot on every open/attach.
- `OpenParams.capabilities` is honoured only for a session this open CREATES,
  exactly like `autoAccept`. It is how resume-from-laptop-copy, a `/clear`
  fork and a hop carry the state.
- `session/skills` entries get `disabled?: true`. `mcp/status` stays
  daemon-wide, and the per-session state comes from `OpenResult` + the update.
- Wire both ends: schema → `methods.ts` → `Connection` handler → `RemoteClient`/`RemoteSession.setCapability`
  → `client/mapping.ts` reverse mapping → reducer.
- An older daemon answers `MethodNotFound`. The client then hides the
  toggles, and its surface shows "not supported by this computer".

**Persistence (S3b).**

- New log entry `capabilities {capabilities}`: the whole state, the last one
  wins. It is emitted by the daemon on every change, on the session's log
  lineage, so the laptop persists it from its `session/log` reads, already
  validated and re-serialized (§7).
- **Non-critical** (owner, Q2): an older build that skips it loads the
  session with everything on. That fails open on *visibility* only. It is
  never a security loss, because permissions still gate every call. So there is
  no `PROTOCOL_VERSION` bump and no `protocol.d/` note.
- The load fold (laptop `--resume`, `serve` reload) takes the last
  `capabilities` entry, and the session is created with it
  (`OpenParams.capabilities` / the daemon's builder).
- On `context_reset` / compaction (a new `base` segment), the daemon re-emits
  the current state right after the `base`. Then the new segment is
  self-contained, even when superseded segments are dropped
  (`keepSuperseded` off).
- `/clear` fork and hop: carried (owner, Q5). A brand-new session starts with everything on.
- No sidecar field: the log is the record, and the sidecar names the entry it
  pairs with.

**Pods.**

- The request goes to the pod daemon, which applies it to its own agent and
  log. There is nothing to gate on the laptop: the switch only *removes*
  model-visible capabilities and creates no laptop effect or approval (§7).
- A pod that lies (claims "off" but keeps sending) can only waste context. It
  already controls its own loop anyway.
- The laptop stores the validated `capabilities` entry like any other.
- Skills listed are the pod's. MCP has nothing to list until pods run MCP
  servers. The toggle UI then simply shows "no MCP servers in this pod".

**Effective time.** From the **next model call**. A call in flight completes
with the old set. Prompt cache: tools come before system in the provider's
cache prefix, so a change costs **one full-price request** and is cached again
from there. Rapid toggles before the next call coalesce for free (the snapshot
is read once per round). A mid-turn toggle is allowed (owner, Q1).

**Surfaces (S4 TUI, S5 iPhone — the UI slices). Panel only (owner, Q6): no
typed `/mcp off …` / `/skills off …` commands, on the Mac or on the phone. The
look is decided on the mockups; this only says what each surface must offer.**

- **TUI:** the panel opens the way it does today: the existing `/mcp` and
  `/skills` entries of the command palette, with no arguments. Their palette
  descriptions say they now hold the on/off. The panels get one switch per row
  (the mockups compare doing it in each panel vs one combined panel).
  - Each row shows on/off. Space/Enter toggles it and sends
    `session/set_capability`.
  - The row reflects the daemon's echo (not optimistic, or optimistic with
    rollback on error).
  - A footer line says "applies to the next model call · hidden from the
    model, not uninstalled".
  - A skill row distinguishes "off" from the existing "after reset" marker.
  - **Quiet row grammar (owner feedback, 2026-11-15).** The leading switch
    alone means "visible to the model": `[✓]` on, `[ ]` off for this session,
    `[–]` dim and locked for a skill the model can never invoke (its own
    frontmatter, `disable-model-invocation: true` →
    `modelInvocable: false`, `packages/config/src/skills.ts:43,163`). Space
    does nothing on `[–]`. There are no wordy columns.
    - `/skills`: the head becomes `[✓] name  description`. The `who()` column
      (`you + model` / `you only` / `model only` / `hidden`,
      `packages/tui/src/skills-panel.ts:49-57`, used in the head at `:73`) is
      **removed, today's panel included**. Who can invoke it, and why, moves
      into the expanded rows (Enter): `/name · the model sees it too` ·
      `/name · off for the model in this session — you can still run it` ·
      `/name · only you: its SKILL.md sets disable-model-invocation`.
    - `/mcp`: the head becomes `[✓] name  ● 14 tools`. The state word and the
      latency (`mcp-panel.ts` `head()`) move to the first expanded row
      (`connected · 38 ms`), and the error stays there too. A failed server
      keeps `✗ failed` on the head, because that is a state to act on.
  - The view-model and key routing are a pure module next to `mcp-panel.ts` /
    `skills-panel.ts`. The component only renders.
- **iPhone Session info:** the MCP SERVERS and SKILLS sections get a trailing
  switch per full-width row, in the feat/mobile-chrome style (minimal rows, no
  cards).
  - The switch is disabled with a footnote when the daemon does not support
    it, or the session is not open (the F4 `not-open` phase,
    `mobile-session-info.md`).
  - Another device's change arrives as the `capabilities` update and shows
    "changed on <by>" (untrusted text, passed through `untrustedText`).
  - The state logic goes in the app's pure session-info model, not the
    component.

### Files

Dependency order: protocol → agent → daemon → client → cli → tui → mobile.

- **S1** (S · contained · weaker model OK): `packages/agent/src/capabilities.ts`
  (new), `packages/agent/test/capabilities.test.ts` (new),
  `packages/core/src/tool.ts` (`mcpServer?`), `packages/mcp/src/tool-adapter.ts`
  (set it).
  *As built:* `packages/agent/package.json` + `bun.lock` (agent gains a
  `@tentacle/config` workspace dep — `projectSystem` re-renders through
  `renderSkillsCatalog`, and agent had no config dep) and
  `packages/agent/src/index.ts` (export the module). No cycle: `config` imports
  no workspace package.
- **S2** (M · load-bearing · strong model): `packages/agent/src/agent.ts`
  (state, setter, snapshot at `:1211`, `contextUsage` `:1680`, execution guard,
  skill guard), `packages/agent/src/subagent.ts` (live parent state),
  `packages/agent/src/compact.ts` (`carryOverSkills` filter),
  `packages/agent/test/agent-capabilities.test.ts` (new).
  *As built:* also `packages/agent/src/session.ts` (the `/compact` call site of
  `carryOverSkills` passes the disabled set) and `packages/cli/src/wiring.ts`
  (the sub-agent runner gets `capabilities: () => agent.capabilities()` — the
  runner is built before the agent, so the live source is a closure). The
  step-limit final request (`agent.ts` "final") sends the stored history,
  system message included, so its catalog is projected too.
- **S3a** (M · load-bearing · strong model): `packages/protocol/src/session.ts`
  (request/result, `OpenParams`/`OpenResult` field), `updates.ts` (update +
  `UPDATE_CLASS` display), `skills.ts` (`disabled?`), `methods.ts`;
  `packages/daemon/src/connection.ts` + `hosted-session.ts` (handler, broadcast
  with `by`, apply to the agent); `packages/client/src/remote-client.ts`,
  `remote-session.ts`, `mapping.ts`, `session-reducer.ts`; tests next to the
  `set_auto_accept` ones; `protocol.json` regenerated at merge
  (`bun run protocol:bump`).
  *As built:* also `packages/daemon/src/session-host.ts` (the create seed) and
  `daemon/src/mapping.ts` (wire copy + `disabled` mark); `session-reducer.ts`
  unchanged (kind-agnostic); the client's create seed is left to S3b's carry
  sites; `protocol.json` regenerated on the branch (`bun run schema:export`).
- **S3b** (M · load-bearing · strong model): `packages/protocol/src/session-log.ts`
  (entry, `LOG_ENTRY_CRITICAL: false`), `packages/daemon/src/session-log.ts`
  (emit on change and after each `base`), `packages/daemon/src/persisted-session.ts`
  (reload fold), the laptop fold + `open{capabilities}` on resume/fork/hop
  (`packages/cli/src/session-resume.ts`, `session-saver.ts`, `tui-sessions.ts`,
  `session-hop.ts`; the executor confirms each by grep for `autoAccept` carry
  sites), `packages/client/src/session-log-reader.ts`. No `protocol.d/` note
  (non-critical entry, additive request/update).
- **S4 — UI** (M · cross-module · weaker model OK; after S3a **and the owner's
  mockup choice**): `packages/tui/src/mcp-panel.ts`, `skills-panel.ts`,
  `skills-sync.ts`, `tree-panel.ts` (a toggle key + row state), a pure
  `capability-toggles.ts` (new); the two palette descriptions
  (`commands/mcp.ts`, `commands/skills.ts`); tests in the `app.test.tsx` style.
  No new command.
  **Also:** remove `who()` from `skills-panel.ts` (head `:73`) and move the
  who/why into the children (`:74-78`, next to `modelNote`). Update its tests:
  `packages/tui/test/app.test.tsx:2029-2030` pin `you + model` / `model only`
  today, plus any `skills-panel` unit test. In `mcp-panel.ts` `head()` /
  `children()`, the state word and latency move to the first child. The `[–]`
  needs `modelInvocable` on the wire: the executor checks whether
  `session/skills` already carries it (the listing's `model`/`user` flags,
  `packages/agent/src/session-skills.ts:12-23`, may not tell "never" from
  "off"). If it does not, an optional `locked?: true` field on the
  `session/skills` entry is added in S3a. That is additive, so there is no
  bump.
- **S5 — UI** (M · cross-module · weaker model OK; after S3a **and the owner's
  mockup choice**): `apps/mobile` Session info model + sheet + its tests; the
  e2e flow `25-session-info` gets a toggle step.

### Failure modes

| # | Case | Convergence |
|---|------|-------------|
| F1 | Toggle mid-turn while a model call is streaming | That call completes with its snapshot. The next round uses the new state. Nothing is aborted. |
| F2 | A disabled server's call already issued (same round) or awaiting permission | Judged against the round's snapshot, where it was visible: it proceeds through the normal gate (the user can still deny). Later rounds: hidden, and a hallucinated call gets the "turned off" error, never executed. |
| F3 | The model calls a hidden tool from memory of earlier history | Error result, not executed. Past `tool_use` blocks stay in history. **To verify in S2:** both providers (`openai`, `anthropic`) accept history calls to a tool absent from `tools`. A cheap recorder + one real-shape request test. If one refuses, STOP and bring it back to the owner, without improvising. The candidate is to project past calls to hidden tools in `modelView` the way `repairHistory` already rewrites invalid history. |
| F4 | Two clients toggle at once | The delta op serializes in the daemon (synchronous apply, no lock on the peer, §7 "don't serialize the peer"). Different items both land. The same item: the last write wins, and every client converges on the broadcast echo, in total order. |
| F5 | Disconnect / reconnect | `OpenResult.capabilities` is the snapshot on re-attach. Updates missed while away are covered by it. |
| F6 | Daemon restart (`serve`) | The reload fold reads the last `capabilities` entry up to the sidecar's entry. A crash between the toggle and its log write loses that toggle: the state is "everything on" or the previous one. That is honest, and the UI shows what the daemon reports. |
| F7 | Older daemon | `MethodNotFound` → toggles hidden ("not supported"). No silent no-op. |
| F8 | Older client | The update is display: `unsupported` once. The model still sees the session's real set, decided daemon-side. |
| F9 | Older build loads a log with `capabilities` | Non-critical (owner): skipped → everything visible. |
| F10 | Unknown name (a typo, a server removed) | Accepted and stored (the set is names). The UI only offers existing names. A cap (e.g. 256 entries, names ≤128 chars, matching `mcp.ts` caps) rejects a flood with `InvalidParams`. |
| F11 | Everything disabled | `skill` tool dropped and catalog removed. The model has the built-ins only. Valid. |
| F12 | `context_reset` / compaction | The system prompt is recomposed full and still projected. The state is re-emitted after the new `base`. Bodies of disabled skills are not carried. |
| F13 | MCP connect settles after the toggle | The registry gains tools tagged with the server. The projection hides them at the next round. Order does not matter. |
| F14 | Pod lies about state | Wastes context only. No laptop effect, no approval created (§7). |
| F15 | A user's `/name` of a disabled skill | Runs (owner, Q4). The body enters history as the user's explicit act. |

### Tests

Red before green for every slice. Mutation-check each property (§9).

- **S1** (`capabilities.test.ts`):
  - `projectTools` drops exactly the disabled server's tools, tag-based. A
    server named `a__b` is handled (mutation: parse by name → red).
  - The `skill` enum is filtered, and `skill` is dropped when empty.
  - `projectSystem` output **byte-equals** `composeSystemPrompt` of the reduced
    set (the exact property: what the model sees = a prompt composed without
    them). An AGENTS.md containing the header text earlier is still cut at the
    LAST one.
  - Ops are idempotent (same object back).
- **S2** (recorder provider):
  - With `mcp__echo__echo` disabled, the **next request's** `tools` lacks it
    and its system message lacks the skill. The in-flight request is unchanged
    (mutation: snapshot read after the call → red).
  - A hallucinated call to a hidden tool: the fixture's call log stays empty
    and the result says "turned off".
  - A sub-agent's request lacks it.
  - `contextUsage` counts the projected size.
  - After `context_reset` the projection still holds and no disabled body is
    carried.
- **S3a** (`Connection` + `RemoteClient` over the in-memory channel):
  - Two clients: A disables `echo`, B gets `capabilities` with `by`, both
    converge.
  - Concurrent deltas on different items both land.
  - Idempotent set → no update.
  - `OpenResult` snapshot on re-attach.
  - `MethodNotFound` path on the client.
  - `UPDATE_CLASS` has the kind (the existing exhaustiveness test).
- **S3b**:
  - Toggle → `session/log` carries `capabilities`. The laptop file holds it,
    and `--resume` recreates the session with it: the first request lacks the
    tool.
  - `serve` restart reloads it.
  - A context reset segment re-carries it.
  - An older reader skips it (non-critical).
- **S4**: pure toggle view-model + key routing, unit-tested. One
  `ink-testing-library` frame test: Space on a row sends the request, and the
  echo flips the row.
- **S5**: session-info model tests (disabled when unsupported or not-open,
  remote change copy). The e2e toggle step.

### Owner questions (with recommendations)

*Answered — see “Owner answers (2026-11-15)” below; the Implementation above is revised to match (revision: claude-opus-5-5, 2026-11-15).*

1. **When does a toggle apply?** (a) the next model call, even mid-turn;
   (b) the next turn only. **Rec (a)**: that is what was asked, and it is
   simplest. The cache cost is one request either way.
2. **Log entry `capabilities`: critical or not?** **Rec non-critical**. An
   older build shows everything (fail-open on visibility, permissions still
   gate). Critical would make an older build refuse the whole session over a
   preference, and would need a `PROTOCOL_VERSION` bump.
3. **Disabled-set vs enabled-set?** **Rec disabled-set**: new servers/skills
   are on by default, as today.
4. **The user's own `/name` of a disabled skill:** allow, or block? **Rec
   allow**: the switch is about what the *model* sees.
5. **Does a `/clear` fork (and a hop) keep the switches?** **Rec yes**: it is
   the same task context. A brand-new session starts with everything on.
6. **Typed commands too** (`/mcp off k8s`, `/skills off kubernetes`) besides
   the panel toggles? **Rec yes in the TUI** (cheap, scriptable). Panel only on
   the phone.
7. **Named presets** ("game mode": config `capabilityPresets` applied at
   session start)? **Rec later**, a follow-up task, once per-session toggles
   prove useful.

#### Owner answers (2026-11-15)

1. A toggle applies from the **next model call**, even mid-turn.
2. Log entry `capabilities`: **non-critical** (owner decides critical entries — decided: not critical; no PROTOCOL_VERSION bump for it).
3. **Disabled-set**: new servers/skills start enabled.
4. The user's own `/name` of a disabled skill: **allowed**.
5. `/clear` fork and hop **keep** the switches; a brand-new session starts with everything on.
6. **Panel only** — no typed `/mcp off …` / `/skills off …` commands, on the Mac or the phone (overrides the recommendation).
7. Named presets: **later**, a follow-up task.

UI (TUI panel + iPhone Session info toggles): mockups first, in the approved mobile-chrome look, before the UI slices.

#### UI mockups + owner questions (S4, S5)

*— claude-opus-5-5, 2026-11-15*

The page is `.tentacle/tmp/session-capabilities/mockups/index.html`. It is
gitignored, so the S4/S5 executor regenerates its frames from the owner's
choice. It is one self-contained page with a light/dark toggle:

- **TUI frames**: 120 cols, using the helpers from
  `.tentacle/site/mockup-generator/gen-v3.ts` and the tokens from
  `packages/tui/src/theme.ts`.
- **iPhone frames**: the approved mobile-chrome look, with tokens from
  `.tentacle/tmp/mobile-chrome/mockups/index.html`: A1 header, B1 dark
  `#1F1F1E`, E2 full-width bands, each frame in light and in dark.

**How it opens** (no typed commands): the existing `/mcp` and `/skills` palette
entries, with no arguments. Their descriptions gain "— and on/off for this
session".

Keys:
- <kbd>space</kbd> toggles.
- <kbd>enter</kbd> expands (a server's tools).
- <kbd>esc</kbd> closes.
- A click on the switch column toggles.

Variants:
- **T1**: a `[✓]`/`[ ]`/`[–]` column in each existing panel, with the quiet
  grammar (no wordy columns, `who()` gone). Off rows are dimmed with no words.
  The title rule says "this session · applies to the next model call".
- **T2**: ONE panel "Visible to the model · this session", opened by both
  entries. It has a section per kind, `[✓]/[ ]`, a summary in the title rule,
  and a status-line marker `⊘ 1 server · 2 skills off`.
- **P1**: a trailing iOS switch on every Session info row, as Auto-accept
  already is in the same sheet. A tap on the name opens the server's tools.
  "Off · changed on <device>" shows a remote change. With an old daemon the
  switches are disabled, with a footnote.
- **P2**: the rows stay as today (value + chevron, "Off" instead of the count).
  The switch "Visible to the model" sits on the pushed server/skill page.

Owner questions (one per variant row, with a recommendation):

1. **Row T:** T1 or T2? **Rec T1**. It is the minimal change: each panel keeps
   its job, and `/skills` already carries per-skill detail that a merged panel
   would make long.
2. **Row T, status-line marker** (only when something is off), even with T1?
   **Rec yes**. It keeps a hidden k8s from being forgotten, and costs nothing
   when everything is on.
3. **Row P:** P1 or P2? **Rec P1**. It is one tap, matching the Mac's one key
   (parity), and the same pattern as Auto-accept. The tools stay one tap away.
4. **Row P, "changed on <device>"** under a row another device changed (and the
   TUI transcript notice)? **Rec yes**, while the sheet/panel stays open, as
   untrusted text through `untrustedText`.
5. **The `[–]` locked marker for a skill the model can never invoke** (today
   "you only"): yes? **Rec yes**. A dim, immutable row with no words tells at
   a glance "the model does not see it, and it is not this session's choice",
   and the expanded row says why. A `[ ]` there would lie, because it would
   look re-enableable.

**Verification (2026-11-15):** `.tentacle/tmp/session-capabilities/verify.ts`
does the following:
- extracts the page's `<script>`;
- runs it against a stub `document` with `MODE` set to light, then dark;
- checks that every expected `data-frame` is present, that no terminal line
  exceeds 120 cols, and that there is no `undefined` or `NaN` in the output.

```ts
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const run = new Function("document", `${script}\nMODE=${JSON.stringify(mode)};render();return {html: document.getElementById("root").innerHTML, overflows: OVERFLOWS, body: document.body.className};`);
```

```
light body: light frames: 23 / 23 missing: [] overflows: 0 undefined: false NaN: false
dark body: dark frames: 23 / 23 missing: [] overflows: 0 undefined: false NaN: false
```

## Execution

*— claude-sonnet-4-5-20250929, 2026-11-15*

**Slice S1 only** (the pure projection module + the MCP server tag). S2/S3a/S3b/S4/S5 untouched.

### Load-bearing check (re-run first, as instructed)

Passed. Verified against the source, not the plan:

- The per-round tool list is `this.config.tools.definitions()` at
  `packages/agent/src/agent.ts:1274`, inside the loop head
  (`for (let iteration = 0; …)` at `:1250`), so it is rebuilt every round.
- The message view is `modelView(messages)` at `:1276`; `contextUsage` reads the
  same two seams at `:1758`/`:1760`.
- The other request builders do **not** bypass them: the step-limit final
  request (`:1611`) has no `tools` and no `systemPrompt`; compaction
  (`compact.ts:118`, `:160`) sends `tools: []`; the title request
  (`daemon/src/session-title.ts:87`) sends `tools: []`. A sub-agent builds its
  own `Agent` with `systemPrompt: type.prompt` (`subagent.ts:423`), so S2 must
  thread the state there — noted, not done here.
- `modelView` only projects the stored history (`context-awareness.ts:65-74`),
  so "hidden" can be a per-round projection and the store is never mutated.

### Repro (before any edit)

`rg` for `set_capabilit|disabledSkills|disabledMcp|sessionCapabilities` across
`packages/` → 0 occurrences (the Context's grep, re-run: matches).

Behavioural repro `.tentacle/tmp/session-capabilities/s1-repro.ts` — a registry
with `fs_read`, `mcp__a__b__echo` (server `a__b`) and `skill`, plus a composed
prompt offering `k8s` + `damajs`:

```
exports matching capab|project|hidden: ["projectKey","projectVote"]
definitions: ["fs_read","mcp__a__b__echo","skill"]
catalog mentions k8s: true
header occurrences: 1
```

`@tentacle/agent` exports no projection at all, and nothing removes
`mcp__a__b__echo` or `k8s` from what the model is sent. The capability is
missing.

Re-running the same script after S1 (same three lines the doc asks to paste —
only the exports line changes, which is the point):

```
exports matching capab|project|hidden: ["NO_CAPABILITIES","applyCapabilityOp","isHidden","isSkillHidden","projectKey","projectSystem","projectTools","projectVote"]
definitions: ["fs_read","mcp__a__b__echo","skill"]
catalog mentions k8s: true
header occurrences: 1
```

### As built, in order

1. **`packages/core/src/tool.ts`** — `Tool.mcpServer?: string`, documented as a
   tag, never a parse.
2. **`packages/mcp/src/tool-adapter.ts`** — `mcpServer: server`.
3. **`packages/agent/src/capabilities.ts`** (new) — `SessionCapabilities`,
   `NO_CAPABILITIES`, `CapabilityOp`, `applyCapabilityOp`, `projectTools`,
   `projectSystem`, `isHidden`, `isSkillHidden`, plus the `ServerOf` lookup
   type. `projectTools` consumes `ToolDefinition[]` (what `definitions()`
   returns — the tag reaches it through the `ServerOf` lookup S2 builds from the
   registry), and copies the `skill` def rather than mutating it.
4. **`packages/agent/src/index.ts`** — re-export.
5. **`packages/agent/test/capabilities.test.ts`** (new, 18 tests) and one new
   case in `packages/mcp/test/tool-adapter.test.ts`.

### Drift from the Implementation (and why)

- **Two files the Files list omitted.** `capabilities.ts` must re-render the
  catalog through the one renderer (`renderSkillsCatalog`, the Design's exact
  requirement), which lives in `@tentacle/config` — and `@tentacle/agent` had no
  config dependency. Added it to `packages/agent/package.json` (plus `bun.lock`)
  and exported the module from `index.ts`. Checked for a cycle: `config` imports
  no workspace package. Recorded in the doc's Files section.
- **`projectSystem` with everything hidden and an AGENTS.md folded.** The
  Design says the result is `withAgents.trimEnd()`; `composeSystemPrompt` with
  no skill keeps the trailing newline a folded AGENTS.md block ends with. The
  two differ by one byte. I implemented the Design (`trimEnd`'d) and pinned both
  cases in the test — the no-AGENTS.md case is byte-identical, the AGENTS.md one
  is `trimEnd`'d and asserted as such. Flagged for Review: if byte-identity is
  what matters there, the Design sentence needs the newline back.
- **`serverOf` is a lookup, not a read of the def.** The plan tags `Tool`, but
  `projectTools` filters `ToolDefinition`s, which carry no tag. So `ServerOf` is
  `(toolName) => string | undefined`, and S2 supplies it from the registry
  (`tools.get(name)?.mcpServer`). This keeps the module free of a registry
  dependency; not a behaviour change.

### Red before green (§9)

- `capabilities.test.ts` was written first against a non-existent module
  (import error), then `capabilities.ts` was added so RED landed on
  **assertions**, which is where it must be: every mutation below is a real
  assertion failure, not a compile error.
- `tool-adapter.test.ts`'s tag test was RED on the real code first:
  `Expected: "a__b" / Received: undefined`.

### Mutation checks (§9) — each reverted after

| # | Mutation | Result |
|---|----------|--------|
| M1 | `isHidden` parses the server from the name (`toolName.split("__")[1]`) instead of the tag | **RED** — `projectTools > server a__b is not confused with a` + drops-by-tag: 2 fail |
| M2 | `projectSystem` cuts at the FIRST `# Skills` (`indexOf`) instead of the last | **RED** — `AGENTS.md mentioning the header is still cut at the LAST one` |
| M3 | `skill` kept with an empty enum (drop the empty guard) | **RED** — `drops the skill tool entirely when every skill is hidden` |
| M4 | `applyCapabilityOp` always builds a fresh object (no identity on a no-op) | **RED** — `idempotent: the SAME object comes back when nothing changed` |
| M5 | hand-rolled catalog bytes instead of `renderSkillsCatalog` | **RED** — `byte-equals a prompt composed without the hidden skills` + the LAST-header case: 2 fail |

Also mutated M1 as a greedy regex (`/^mcp__(.+)__/`) first: it captured the
whole server, so it was an *equivalent* mutant and stayed green — replaced with
the split version above, which is the mutation the plan names.

### Failure-mode tests covered by S1

F10 (unknown name accepted — the set is names: `applyCapabilityOp` test), F11
(everything disabled → `skill` dropped, catalog removed), F13's projection half
(a server's tools tagged after the toggle are hidden by tag), F1's mechanism
(the snapshot is read per round — the projection is pure, so S2 only has to call
it at the loop head). F2/F3/F12/F14/F15 are S2's (agent loop) to prove.

### Gate

`bunx tsc --noEmit` → clean · `bun run lint` → `Checked 1657 files. No fixes
applied.` (0 errors, 0 warnings) · `bun test` → **11920 pass, 5 skip, 0 fail**
(all 5 skips are the pre-existing opt-in env guards: live-k8s ×2, live-docker,
root-confinement, slow-ws — none in a file I touched). Changelog guards
(`changelog.test.ts`, `changelog-guard.test.ts`, `release.test.ts`) → 57 pass.
No schema changed, so `protocol.json` was not regenerated.

**S1: DONE.** S2–S5: not started (out of scope for this execution).

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context; scope: slice S1 only, `git diff main...HEAD`)

**Verdict: REQUEST-CHANGES** (one MEDIUM).

1. **MEDIUM — `projectSystem` re-renders the catalog from a caller-supplied `offered`, not from the set the prompt was composed with** (`packages/agent/src/capabilities.ts:176-198`). Byte-equality holds only when `offered` equals the compose-time set, and nothing enforces or tests that. The obvious S2 source, `this.listing`, follows the disk after a user rescan while the model's `skill` enum and catalog stay fixed until a reset (`agent.ts:883-911`). Repro (`.tentacle/tmp/session-capabilities/r1.ts`): prompt composed with `[a,b]`, `offered=[a,b,c]`, disable `a` → `catalog offers c (not in skill enum): true`. Turning one skill off would silently advertise a skill the `skill` tool rejects. Fix in S1: limit the re-render to the names in the `skill` def's enum (or take those names as the input), and add a test where `offered` ⊋ the composed set.
- LOW (not blocking): the drift in the everything-hidden case (`head` is trimEnd'ed) also loses bytes when there is no AGENTS.md if the identity (PROMPT.md) ends in a newline, so the "no AGENTS.md → byte-equal" test holds only for an untrimmed identity.

**Gate (touched files):** `capabilities.test.ts` + `tool-adapter.test.ts` 27 pass / 0 fail; `bun run lint` clean (1657 files); `bun run typecheck` clean. I did not re-run the full suite.
**Mutations (copied back from a scratch backup; `git status` clean afterwards):** skill enum left unfiltered → 2 red; `projectTools` hidden ≡ false → 1 red. The executor's M1–M5 are plausible but I did not re-run them.
**Attacks tried:** is the catalog truly LAST (nothing appended after compose; `agent.ts:926` sends the prompt as-is) → holds; the skill def's shape (the test goes through the real `ToolRegistry`/zod path) → holds; tag vs name-parse for `a__b` → holds (the tag is set in `tool-adapter.ts:81`); §7 invariants: pure module, no protocol, persistence or pod surface in S1 → none touched; a stale `offered` → finding 1.
**Executor:** honest drift notes, flagged the trimEnd question itself. The doc is signed `claude-sonnet-4-5-20250929` but commit `3f8f2d0d` says "exec (deepseek)": reconcile the signature.

### Fix round 1

*— claude-opus-5-5, 2026-11-15*

**Scope.** Review round 1's one MEDIUM plus its LOW. `git status --short` →
`M packages/agent/src/capabilities.ts`, `M packages/agent/test/capabilities.test.ts`
(the doc edits that also show as modified in this worktree are the owner's
mockup/revision work, not mine — I only appended this section).

**1 (MEDIUM) — the re-render is now gated on the COMPOSED catalog, not on
`offered`.** `projectSystem` re-renders from `offered` intersected with the
names the prompt's own catalog block holds (`capabilities.ts:183`
`composedSkillNames`, used at `:222-225`). The block is the record of the set
the prompt was composed with, and it is the same set the `skill` enum holds
(both are `offeredSkills(...)` at compose time: `resolve.ts:446`,
`cli/src/wiring.ts:165`), so it cannot go stale against the tool the way
`Agent.listing` does (`agent.ts:883-911`). The comparison is on
`escapeSkillText(name)` because the renderer escapes names in the block — a
raw comparison would drop every skill whose name contains `&`, `<`, `>` or `"`.

Why this shape rather than the review's "limit to the `skill` def's enum": the
enum lives in a *different* input (`defs`), so taking it would add a third
parameter and a second thing to keep in sync; the block is already the exact
byte record of what was advertised. **`offered` keeps its role only as the
description source** — a composed name `offered` cannot describe is dropped from
the catalog (its enum entry stays), so the two cannot disagree in that direction
either (`offered` ⊉ composed). Both directions are now closed.

**2 (LOW) — the one-byte case is pinned, not argued.** `capabilities.test.ts:244`
asserts the exact behaviour with a `PROMPT.md`-style identity ending in `\n`:
the projection gives `"ID"`, `composeSystemPrompt` with no skills gives `"ID\n"`.
It is inherent to the projection's inputs (S2 holds the composed prompt only;
no untrimmed `withAgents` is recoverable) and semantically nil (trailing
whitespace on a system prompt), and it is what the Design says
(`withAgents.trimEnd()`). Pinned so it cannot drift silently; **not changed**.

**Red before green (§9).** The new MEDIUM test was written first and shown red on
the unfixed code, on the assertion (not a compile error):

```
$ bun test packages/agent/test/capabilities.test.ts
error: expect(received).not.toContain(expected)
Expected to not contain: "<name>late</name>"
Received: "ID\n\n# Project rules (AGENTS.md)\n\nRULES\n\n# Skills\n…<name>damajs</name>…<name>late</name>…"
(fail) projectSystem > a stale `offered` cannot advertise a skill the `skill` tool does not offer
 17 pass · 1 fail
```

The reviewer's standalone repro now answers the other way —
`.tentacle/tmp/session-capabilities/r1.ts` → `catalog offers c (not in skill
enum): false` (was `true`).

**Mutation checks (§9) — each shown red on the assertion, then reverted from
`.tentacle/tmp/session-capabilities/cap-fix1.bak`; `git diff` matches the backup
afterwards.**

| # | Mutation | Result |
|---|----------|--------|
| F1a | drop the gate — back to `offered.filter((s) => !isSkillHidden(...))` (the reviewer's bug) | **RED** — `a stale \`offered\` cannot advertise a skill the \`skill\` tool does not offer`: `Expected to not contain "<name>late</name>"`. 19 pass / 1 fail |
| F1b | gate on the raw name, `composed.has(s.name)` instead of the escaped one | **RED** — `a name the renderer escapes is still recognised`: the `a&b` skill vanishes. 19 pass / 1 fail |

F1b is the mutation that matters for non-vacuity: it shows the escaping half of
the fix is load-bearing, not decoration (the F1a mutant alone would still pass
with a raw comparison on ASCII names).

**Gate.** `bunx tsc --noEmit` → exit 0, clean · `bun run lint` →
`Checked 1657 files in 485ms. No fixes applied.` (0 errors, 0 warnings, the §6
baseline) · `bun test` → **11923 pass, 5 skip, 0 fail**, `84892 expect() calls`,
`Ran 11928 tests across 856 files. [419.68s]` — 11923 = the pre-fix 11920 + the
3 new tests; the 5 skips are the pre-existing opt-in guards (live-k8s ×2,
live-docker, root-confinement, slow-ws). Narrow file:
`bun test packages/agent/test/capabilities.test.ts` → 20 pass / 0 fail.

**Verdict per finding.** 1 (MEDIUM) FIXED · 2 (LOW) FIXED (pinned; behaviour kept
deliberately) · the Review's "reconcile the signature" note: the Execution above
is signed `claude-sonnet-4-5-20250929` but commit `3f8f2d0d` says
"exec (deepseek)" — I cannot verify which model wrote it and I will not
overwrite another model's signature. **Open for the orchestrator**: the S1
Execution signature and the commit message disagree, and only the agent that
ran it knows.

### Round 2

*— claude-opus-5-5, 2026-11-15* (fresh context; scope: `git diff HEAD~1`, commit `176e2df9`)

**Verdict: APPROVE.**

- **Finding 1 (MEDIUM): fixed.** `projectSystem` now re-renders only the names the composed catalog holds (`capabilities.ts:183-191`, `:222-225`). The round-1 repro `r1.ts` now prints `catalog offers c (not in skill enum): false`. Mutation: removing the composed-names gate → `a stale offered cannot advertise…` RED. Comparing raw names instead of escaped ones → `a name the renderer escapes…` RED. Reverted, and `git status` was clean.
- **LOW: accepted.** The one-byte loss is documented and pinned by a test (`identity "ID\n"` → `"ID"`), as the Design specifies.
- **Regression attacks:** names are scanned only after the LAST header, so an AGENTS.md block is never read. A description cannot forge a `<name>` tag (it is escaped). Hiding a skill cannot uncover a 101st one (the composed set is already capped). All three hold.
- **Gate:** the two touched test files pass, 30 pass / 0 fail. `bun run lint` is clean (1657 files). `bun run typecheck` is clean.
- **Note:** the doc diff also removes one mockup bullet (T1), outside S1's code. Confirm it was intentional.

## Execution — S2

*— claude-opus-5-5, 2026-11-15*

**Slice S2 only** (the agent loop: projection, execution guard, sub-agents,
carry-over). No protocol, daemon, client, persistence or UI change; S3a–S5
untouched.

### Load-bearing check (re-run first)

Passed, with one correction to S1's note. `rg "definitions\(\)|ChatRequest = \{|modelView\("`
in `packages/agent/src` (before any edit):

- The round: `definitions()` `agent.ts:1274` + `modelView(messages)` `:1279`,
  inside the loop head — rebuilt every round. `contextUsage`: `:1758`/`:1764`.
- The step-limit final request (`:1599`/`:1611`): no `tools`, **but it does
  send the system prompt** — its messages are `modelView(messages)`, history[0]
  included. S1's Execution said "no `systemPrompt`"; that is wrong. It now goes
  through the same system projection.
- Compaction (`compact.ts:118`, `:160`): its own `COMPACT_SYSTEM`, `tools: []`,
  and the transcript drops the system message (`m.role === "system" ? []`). No
  bypass.
- A sub-agent: its own `Agent` (`subagent.ts:422`), whose registry copies the
  parent's tools (MCP and `skill` included). Its prompt is `type.prompt` (no
  catalog), so only its tool list needs the projection — through a live
  capabilities source.
- `refreshUserSkills` (`:907`) and the reset (`:2394`) call `definitions()` to
  read the model's offered set, not to build a request. Unchanged.

### Repro

Behavioural, the Context's shape — `.tentacle/tmp/session-capabilities/s2-repro.ts`:
real `startDaemon`, the stdio fixture `packages/cli/test/fixtures/mcp-stdio-server.ts`
as server `echo`, a recorder `createProvider`, one prompt:

```ts
const config = { ...base, mcpServers: { echo: { type: "stdio" as const, command: process.execPath, args: [fixture] } } };
const handle = await startDaemon(config, { host: "127.0.0.1", port: 0, devices: false, discovery: false,
  relay: { noRelay: true }, onNotice: () => {}, createProvider: () => model });
// … wait for mcp/status to settle, newSession().send("hi")
console.log("tools:", JSON.stringify((requests.at(-1)?.tools ?? []).map((t) => t.name)));
console.log("capability methods:", JSON.stringify(Object.values(Method).filter((m) => /capabilit/.test(m))));
```

```
tools: ["fs_read","fs_write","fs_edit","fs_multi_edit","shell","shell_output","shell_kill","agent_task","agent_control","context_reset","mcp__echo__echo"]
capability methods: []
```

`mcp__echo__echo` reaches the model, and no session RPC can remove it. I ran it
on the S2 tree. S2 adds no wire (that is S3a), so this daemon-level observable
is the same before and after S2. S2's own before/after is the red → green run
below.

### As built, in order

1. **API surface first, no behaviour** (so the tests go red on assertions, not
   on compile errors):
   - `AgentConfig.capabilities?: SessionCapabilities | (() => SessionCapabilities)`
     (`agent.ts:592`). A value is the initial state. A function is a live source.
   - `Agent.capabilities()` / `setCapabilities(state)` (`:922`, `:932`).
   - `SubagentDeps.capabilities?: () => SessionCapabilities` (`subagent.ts:338`),
     passed to the child (`:434`).
   - `carryOverSkills(…, disabled = [])` (`compact.ts`).
2. **The test file** `packages/agent/test/agent-capabilities.test.ts` (11
   tests). Red output below.
3. **Projection** (`agent.ts:937-975`):
   - `serverOf` reads the registry's `mcpServer` tag.
   - `projectedTools(caps)` = `projectTools(definitions(), serverOf, caps)`.
   - `projectedHistory(messages, caps)` replaces only history[0]'s content with
     `projectSystem(…)`. It returns a copy, so the stored array is never touched.
     Every other message keeps its identity, so a context anchor still matches.
   - `catalogSkills` (`:799`) holds the descriptions the catalog is re-rendered
     from. It is set from the listing's `model: true` entries in the
     constructor and in `installSkills`, which are the moments the prompt and
     the `skill` enum are composed. It is not set at a user rescan.
     `catalogOf` (`:3029`) maps them to `SkillInfo`; only name and description
     reach the renderer.
4. **Round snapshot** (`:1372`): `const caps = this.capabilities()` is read
   ONCE per round. The tools, `noteContextUsage` and the view come from it, and
   it rides `RoundHooks.capabilities` into `runToolCalls` (`:1650`).
5. **Execution guard**:
   - `authorizeCall` (`:2879`) checks `hiddenCallRefusal(call, caps)` before the
     gate. A hidden server's tool gives `"<tool> is turned off for this session"`.
     `skill{name}` of a disabled skill gives `skill "<name>" is turned off for
     this session`. Either way `isError`, no prompt, never run.
   - Both call sites pass the snapshot: a call alone `:2036`, a group `:2172`.
   - A resumed round (`:1109`) passes none, on purpose: its calls were issued
     when they were visible (F2).
6. **Final request** (`:1700`) and **`contextUsage`** (`:1861-1882`, both the
   exact count and the estimate) use the same projection.
   `noteContextUsage` estimates over the projected history.
7. **Carry-over**:
   - `carryOverSkills` drops disabled names from both `kept` and `dropped`
     (`compact.ts:233`). A dropped name is told to the model as "loadable
     again", so it must not name a hidden skill either.
   - The callers pass the disabled set: the reset `agent.ts:2489`, `/compact`
     `session.ts:346`.
8. **Wiring**: `cli/src/wiring.ts:610` gives the runner
   `capabilities: () => agent.capabilities()`.

### Drift from the Implementation (and why)

- **Two files not in the Files list**: `session.ts` (the `/compact` call site;
  the plan named only `compact.ts`, but the filter needs the caller's state) and
  `cli/src/wiring.ts` (the only production `createSubagentRunner`, built before
  the agent). Both are recorded in Files *As built*.
- **The final request is projected**: S1's load-bearing note had wrongly
  cleared it (above).
- **The `skill` guard is generic**: it lives in `authorizeCall`, keyed on
  `call.name === SKILL_TOOL_NAME`, not inside the `skill` tool. The tool stays
  pure, and the round's snapshot is only known to the loop. The user's `/name`
  goes through `runUserSkill`, which never reaches `authorizeCall`, so F15
  holds by construction (pinned by a test).
- **Catalog descriptions come from the listing captured at compose time**,
  not from `this.listing`, which a user rescan replaces. This closes the drift
  the S1 Review flagged from the agent's side too.

### F3 — providers and history calls to a tool no longer offered

`.tentacle/tmp/session-capabilities/s2-f3-shape.ts` runs both REAL providers
with an injected `fetch` (nothing leaves the machine). The history holds a
`mcp__echo__echo` call and its result:

```
anthropic projected (echo hidden): tools=["fs_read"] history-call-kept=true
anthropic final (no tools, today): tools=[] history-call-kept=true
openai projected (echo hidden): tools=["fs_read"] history-call-kept=true
openai final (no tools, today): tools=[] history-call-kept=true
```

The projected shape is the history's calls plus a smaller `tools`. Production
already sends a strictly harder shape on every step-limit final request:
history calls with no `tools` at all (`agent.ts` final request). Neither
provider rewrites history by `tools`. **Unverified:** live acceptance by the
real endpoints, which I did not call (no key, and it is an external call).
To verify: one `anthropic` and one `openai` request of the "projected" shape
against the real API. If one returns 400, F3's fallback applies (project past
calls to hidden tools in `modelView`). I did not improvise it.

### Red before green (§9)

All tests were written against the stub surface (step 1), and they failed on
assertions:

```
$ bun test packages/agent/test/agent-capabilities.test.ts
(fail) … F1/F2: a mid-stream toggle leaves the in-flight request and its calls alone; the NEXT request is projected
(fail) … skill{name} of a disabled skill is answered 'turned off', never read
(fail) … F11: everything off → no `skill` tool, no catalog, built-ins only
(fail) … F13: an MCP server's tools registered AFTER the toggle are hidden by their tag
(fail) … the step-limit final request's system prompt is projected too
(fail) sub-agents follow the parent's live switches > a child's request lacks the hidden server's tools
(fail) contextUsage counts what is really sent > the exact count is asked for the projected request
(fail) contextUsage counts what is really sent > the estimate is smaller with things hidden
(fail) F12: … > the restart request is projected and holds no k8s body
(fail) F12: … > carryOverSkills drops a disabled skill from both kept and dropped
 1 pass
 10 fail
```

The one pass is F15 (the user's `/name` of a disabled skill runs). It is a
regression guard: it already held, and it must keep holding. After the
implementation: **11 pass / 0 fail**.

### Mutation checks (§9)

The runner is `.tentacle/tmp/session-capabilities/s2-mut.ts`. Each mutation is
one string replacement, then the S2 test file runs, then the original is
written back. Afterwards `cmp` against `.tentacle/tmp/session-capabilities/s2bak/`
showed agent.ts, compact.ts and subagent.ts byte-identical.

| # | Mutation | Result |
|---|----------|--------|
| M1 | the guard reads the LIVE state instead of the round's snapshot (the plan's "snapshot read after the call") | **RED** 9/2 — F1/F2 (the in-flight call `c1` is refused) + the sub-agent case |
| M2 | round tools unprojected (`definitions()`) | **RED** 6/5 |
| M3 | round system message unprojected | **RED** 8/3 — F1/F2, F11, F12 |
| M4 | step-limit final request unprojected | **RED** 10/1 |
| M5 | execution guard disabled | **RED** 9/2 — F3 echo call executed; `skill{k8s}` read |
| M6 | `carryOverSkills` filter removed | **RED** 9/2 — F12 restart holds `BODY:k8s`; unit |
| M7 | child not given the capabilities source | **RED** 10/1 |
| M8 | `contextUsage` counts the unprojected history | **RED** 10/1 |
| M9 | child given a one-time copy `deps.capabilities()` instead of the live source | first **survived** (the test toggled before spawn) → test tightened to toggle during the child's first stream → **RED** 10/1 |

### Failure modes covered by S2

- **F1**: in-flight request unchanged.
- **F2**: a call visible in its round's snapshot runs.
- **F3**: a hidden call is refused and never executed (the fixture log stays
  `["one"]`). The provider half is above.
- **F11**: everything off.
- **F12**: reset projection plus no carried body. `/compact` uses the same
  `carryOverSkills` path, unit-pinned.
- **F13**: tools registered after the toggle are hidden by tag.
- **F15**: the user's own `/name` runs.
- **Not S2's**: F4–F10 and F14 (wire, persistence, pods: S3a/S3b).

### Notes / debt

- **The daemon does not carry the state yet.** S3a must call `setCapabilities`
  on the session's agent. It must also re-apply it when `update_settings`
  rebuilds the agent: `buildAgent` makes a fresh `Agent` with everything on.
- **`/compact`'s summary transcript still includes a disabled skill's body**,
  in summarised form. Only verbatim carry-over is filtered, which is what the
  Design names. A follow-up could leave such bodies out of `renderMessage`.

### Gate

- `bunx tsc --noEmit` → clean.
- `bun run lint` → `Checked 1658 files in 536ms. No fixes applied.` That is 0
  errors and 0 warnings, the §6 baseline.
- `bun test` → **11934 pass, 5 skip, 0 fail**, `84926 expect() calls`,
  `Ran 11939 tests across 857 files. [437.67s]`.
  - 11934 = the post-fix-1 11923 plus the 11 new tests.
  - The 5 skips are the pre-existing opt-in guards.
  - This run started only after the last mutation pass had restored the
    sources (`cmp` clean). An earlier run overlapped a mutation pass, so I
    discarded it.
- Narrow: `bun test packages/agent/test/agent-capabilities.test.ts` → 11 pass /
  0 fail.
- No schema changed, so `protocol.json` was not regenerated. No `protocol.d/`
  note.
- The changelog fragment `changelog.d/session-capabilities.added.md` already
  exists, its text matching the doc's metadata line, so S2 added none.

**S2: DONE.** S3a/S3b/S4/S5: not started (out of scope).

### Fix round 1

*— claude-opus-5-5, 2026-11-16*

Both S2 Review findings were test gaps. The code was right, so no source
changed. Two tests were added to `packages/agent/test/agent-capabilities.test.ts`.

1. **Grouped guard (finding 1): FIXED.** The test is "a GROUPED round (read-only
   mode) still refuses the hidden server's call".
   - Setup: `toolExecution {mode:"read-only", maxParallel:2}`. Two read-class
     MCP calls in one round: `mcp__echo__echo` (server hidden) and
     `mcp__other__x`.
   - It asserts the round went through `runGroup`: a `tool_phase` for `g2`,
     which only `runGroup` yields.
   - It asserts the hidden call is answered "turned off" and never runs, and
     the visible call runs.
   - **Drift from the Review's scenario.** `skill` beside `fs_read` never
     groups: the `skill` tool declares no `concurrency`, so `classOf` makes it
     `exclusive`. The reachable hidden-in-a-group case is a read-only MCP tool,
     which the adapter tags `concurrency: () => [{read, mcp:<server>}]`
     (`mcp/src/tool-adapter.ts:83`).
2. **`/compact` call site (finding 2): FIXED.** The test is "/compact
   (Session.compact) carries no disabled skill's body into the new history".
   - It loads `k8s` and `damajs`, disables `k8s`, then calls
     `session.compact()`.
   - It asserts the new history holds `SUMMARY` and `BODY:damajs`, and holds no
     `BODY:k8s`.

**Red before green.** Both tests are green on the current code, because the
code was already right. Red is shown by mutating the code each test pins. The
runner is `.tentacle/tmp/session-capabilities/fr1-mut.ts`: one replacement, then
the S2 file runs, then the original is written back. `cmp` against `fr1bak/`
was clean afterwards.

```
== MB (group authorizeCall without the snapshot)
(fail) … a GROUPED round (read-only mode) still refuses the hidden server's call
 12 pass
 1 fail
== ME (/compact passes [] instead of the disabled set)
(fail) F12: … > /compact (Session.compact) carries no disabled skill's body into the new history
 12 pass
 1 fail
RESTORED
```

These are the Review's own MB and ME, which both survived before. Now each
turns exactly its new test red. With the sources restored, the narrow run is
13 pass / 0 fail.

The LOW nit (the estimate reuses the anchor's `promptTokens`) is not addressed.
It is not HIGH or MEDIUM.

**Gate**
- `bunx tsc --noEmit` → clean.
- `bun run lint` → `Checked 1658 files … No fixes applied.` (the §6 baseline).
- `bun test` → **11936 pass, 5 skip, 0 fail** (11941 tests, 857 files, 443s).
  That is the S2 count of 11934 plus the 2 new tests. The 5 skips are the
  opt-in guards.
- **Flake.** The first full run had **2 fails**. One of them was in
  `packages/cli/test/serve-autowake.test.ts` (T3/C5), a file this branch does
  not touch. The pass count was 11934, which means 2 tests that passed before
  had failed. Re-run alone, that file passed 5/5. A second full run was clean
  (above). I did not identify the second failing test: the first run was not
  logged.

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context; same model as the S2 executor, so shared blind spots may survive. Scope: S2, `git diff main...HEAD`)

**Verdict: REQUEST-CHANGES.** Both findings are test gaps on a guard path. The code is right; nothing pins two of its sites.

1. **MEDIUM: the execution guard in `runGroup` is unpinned** (`packages/agent/src/agent.ts:2170-2172`). Mutation MB dropped `capabilities: hooks.capabilities` from the group `authorizeCall`, and all **11/11 tests stayed green**. That path is the production default: `DEFAULT_TOOL_EXECUTION = "read-only"` with `maxParallel 8` (`packages/config/src/defaults.ts:88-90`), so read-class calls in one round are grouped. Scenario: the model sends `skill{name:"k8s"}` (disabled) next to an `fs_read`. If someone drops that line later, the hidden skill's body loads with no red test. Fix: add a test with `toolExecution: {mode:"read-only", maxParallel:2}` and two calls in one round. One is hidden, and it must come back "turned off" and never run.
2. **MEDIUM: the `/compact` call site of the carry-over filter is unpinned** (`packages/agent/src/session.ts:343-347`). Mutation ME passed `[]` instead of `disabledSkills`, and the S2 file plus `session.test.ts` stayed **22/22 green**. Execution says "`/compact` uses the same `carryOverSkills` path, unit-pinned", but only the function is pinned, not the caller. Scenario: a regression there carries a disabled skill's full body verbatim into the compacted history (F12). Fix: drive `Session.compact()` once with `k8s` active and disabled, and assert that `BODY:k8s` is not in the new history.

**Gate (narrow, as scoped):**
- `bun test` on `agent-capabilities` + `capabilities` + `compact`: 62 pass / 0 fail.
- `bun run lint`: 1658 files, no fixes (baseline clean).
- `bun run typecheck`: clean.
- I did not re-run the full suite.

**Mutations, each reverted with the Edit tool** (`cmp` against the backups is identical, `git status` clean):
- MB: survived (finding 1).
- MC (no snapshot on the single-call path): RED 9/2.
- ME: survived (finding 2).
- The executor's M1–M9 are not re-run.

**Attacks tried:**
- Another request builder that bypasses the projection: none. Grep `.stream(`/`definitions()`. The step-limit final request is projected. Compaction sends `tools: []` and no system message. The title request runs daemon-side with no tools.
- Is the catalog drift after a user rescan closed? Yes: `catalogSkills` is set only in the constructor and `installSkills`.
- Is the anchor identity broken by `projectedHistory`? No, only index 0 is copied.
- Do sub-agents follow the parent live? Yes: the wiring passes the closure `agent.capabilities()`.
- Does a resumed round skip the guard? Yes, on purpose (F2), and the plan agrees.

**Nit, not blocking:** `estimateUsed` with a valid anchor reuses its `promptTokens` (`context-awareness.ts:111-113`). The estimate does not drop after a toggle until the next real request reports usage. The exact count path is right.

**Executor behaviour:** it was disciplined. It corrected S1's wrong "no system prompt" note, mutation-tested nine properties and tightened M9 after it survived. It overstated one coverage claim (finding 2).

### Round 2

*— claude-opus-5-5, 2026-11-16* (fresh context, same model as before; scope `git diff HEAD~1`, test-only plus doc)

**Verdict: APPROVE.** Both findings are closed. The diff changes no production code.

1. **Finding 1 (`runGroup` guard): closed.** New test "a GROUPED round (read-only mode) still refuses the hidden server's call". I re-applied MB (drop `capabilities: hooks.capabilities` at `agent.ts:2172`), and that test goes **RED**. The test also checks that `g2` actually ran in the group (`tool_phase` for `g2`), so it truly goes through `runGroup`.
   - Correction to my Round 1 example: the `skill` tool declares no `concurrency`, so `classOf` makes it `"exclusive"` (`round-plan.ts:28-29`, nothing in `tools/src/skill.ts`). It never joins a group.
   - The real grouped case is a read-keyed MCP tool, which is what the new test uses.
2. **Finding 2 (`/compact` call site): closed.** New test "/compact (Session.compact) carries no disabled skill's body". I re-applied ME (`[]` at `session.ts:346`), and that test goes **RED**. It also asserts that `BODY:damajs` is still carried, so the filter cannot pass by dropping everything.

**Gate:**
- `agent-capabilities` + `session` tests: 24 pass / 0 fail.
- `bun run lint`: clean, 1658 files.
- `bun run typecheck`: clean.
- Restore after the mutations: `cmp` identical, `git status` clean.

**Regressions on the diff:** none. The two tests are added, no existing assertion changed, and they use the existing harness and fakes.

## Execution — S3a

*— claude-opus-5-5, 2026-11-16*

**Slice S3a only**: the wire (protocol), the daemon handler and the client
half. Not touched: persistence (S3b), the `OpenParams.capabilities` carry
sites on the laptop (S3b), and the UI (S4/S5).

### Load-bearing check (re-run first)

It passed, before any edit. S3a stands on the `set_auto_accept` shape: a
synchronous apply plus a synchronous fan-out, with no lock on the peer.

- **Concurrent dispatch.** `transport/peer.ts:322` dispatches each request with
  `void this.handleRequest(…)`, with no per-connection mutex.
- **Synchronous fan-out.** `HostedSession.emit` (`hosted-session.ts:2096`)
  pushes to the ring and sends to every attachment in one synchronous loop.
  So two sets applied synchronously are emitted in one total order (F4).
- **The agent is reachable.** It is `session.currentAgent()`
  (`agent/src/session.ts:139`). `Agent.setCapabilities` is synchronous
  (`agent.ts:932`). A settings sync swaps the agent with
  `Session.replaceAgent` in `swapAgent`, with a fresh `Agent` that has
  everything on. So the daemon must hold the state itself and re-apply it
  there (S2's debt note).

### As built, in order (protocol → daemon → client)

1. **Protocol** (additive):
   - `session.ts`: `CapabilityNameSchema` (`line(128)`, exported because the
     JSON-Schema export needs a named `$def` for a reused schema),
     `SessionCapabilitiesSchema` (two arrays, each `.max(MAX_DISABLED_CAPABILITIES = 256)`),
     `OpenParams.capabilities?`, `OpenResult.capabilities?`, and
     `SetCapabilityParams`/`SetCapabilityResult`.
   - `updates.ts`: `CapabilitiesUpdateSchema {type:"capabilities", capabilities, by?}`,
     a union member, and `UPDATE_CLASS.capabilities = "display"`.
   - `skills.ts`: `SkillListEntry.disabled?: true`.
   - `methods.ts`: `Method.SetCapability = "session/set_capability"` plus its
     `RequestSchemas` entry.
   - `protocol.json` regenerated with `bun run schema:export` (+99 lines).
2. **Daemon**:
   - `HostedSession` (`hosted-session.ts`) holds `caps` (`:574`).
     `capabilities()` (`:2623`) is the snapshot. `seedCapabilities` (`:2632`)
     normalizes a client seed (sorted, de-duplicated) and applies it with no
     emit.
   - `setCapability(op, by)` (`:2653`): `assertKnown`, then
     `applyCapabilityOp`. On a change it checks the cap (`InvalidParams`, the
     state untouched), then sets `caps`, calls
     `agent.setCapabilities(next)`, and emits `capabilities` with `by`.
     Idempotent: the same object comes back, so there is no emit.
   - `swapAgent` re-applies the state to the fresh agent (`:2585`).
   - `skills()` marks the disabled skills through
     `toSessionSkills(listing, caps.disabledSkills)`.
   - `mapping.ts`: `toWireCapabilities`. `toSkillList` and `toSessionSkills`
     take `disabledSkills` (default `[]`).
   - `connection.ts`: the `Method.SetCapability` case (`:399`) uses the same
     `by` label as auto-accept. `OpenResult.capabilities` is always present
     (`:920`), read in the same synchronous segment as the attach.
   - `session-host.ts:917`: seeds a session this open CREATES, exactly like
     `autoAccept`.
3. **Client**:
   - `RemoteClient`: `SessionStreamListener` gets `capabilitiesSnapshot?` and
     `capabilitiesChanged?`. `applyOpenResult` calls `noteCapabilities`
     (`:3154`). The update dispatch handles `"capabilities"` (`:3579`).
     `setSessionCapability` (`:3190`) rejects with no call when the session is
     not open.
   - `RemoteSession`: `capabilities()` (`:350`) is `undefined` when unknown
     or unsupported. `onCapabilities` (`:360`) subscribes.
     `setCapability` (`:377`) resolves with the daemon's answer, but the
     held state comes ONLY from the echo. A late answer must never undo
     another client's later change (F4). `MethodNotFound` clears the state
     and notifies `undefined`, so a surface hides its toggles (F7).
   - `client/mapping.ts`: `capabilities` returns `null` in `updateToEvent`.
     It is not a turn event, and its listener is in `RemoteClient`, like
     `auto_accept`.

### Drift from the Implementation (and why)

- **`session-reducer.ts` is unchanged.** It orders updates by `seq` and is
  kind-agnostic, except for the turn markers. A display update needs nothing
  there.
- **No trust gate on the client.** Unlike `auto_accept` (`sharedAutoAccept`),
  a pod's `capabilities` snapshot and updates are taken as display. The Design
  says nothing is gated laptop-side (§7: it only removes what the pod's own
  model sees). `setSessionCapability` is allowed to a pod too.
- **Two daemon files not in the Files list.** `session-host.ts` holds the
  create seed. `mapping.ts` holds the wire copy and the `disabled` mark.
- **The client half of `OpenParams.capabilities` is NOT wired.** There is no
  `seed…OnCreate` in `RemoteClient`. It is the carry (resume, `/clear` fork,
  hop), which the plan puts in S3b ("open{capabilities} on resume/fork/hop").
  S3a delivers the daemon side that honours it, and a test pins it.
- **`locked?` is not added.** S4 owns that check. `model: false` with no
  `modelAfterReset` already reads "never offered" in today's listing. If S4
  finds that is not enough, it is one optional field.
- **No `persist()` in `setCapability`.** The record is the log entry (S3b), not
  the sidecar. Until S3b, a `serve` restart reloads a session with everything
  on (F6 as written for S3b).

### Red before green (§9) — honest note

I wrote the implementation before the tests in this slice, so no run on the
pre-change code exists. Red is shown instead by **mutation of every target**:
each of the 13 mutations below turns at least one test red on its
assertion, not on a compile error. The protocol tests can only go red at
typecheck: dropping the `UPDATE_CLASS` entry is a TS error, because it is a
`Record` over the union.

### Mutation checks (§9)

The runner is `.tentacle/tmp/session-capabilities/s3a-mut.ts`. Each mutation is
one string replacement, then the 3 S3a test files run, then the original is
written back. Afterwards `cmp` against `.tentacle/tmp/session-capabilities/s3abak/`
printed `ALL-IDENTICAL` for all 6 sources.

```
== M1 no emit in setCapability: RED 15/4
== M2 agent not told in setCapability: RED 18/1   (next request still offers mcp__echo__echo)
== M3 swapAgent does not re-apply: RED 18/1       (settings sync)
== M4 create seed dropped: RED 18/1
== M5 OpenResult without snapshot: RED 16/3
== M6 no cap check: RED 18/1                      (F10)
== M7 skills() ignores the switches: RED 18/1
== M8 whole-state op (forgets the rest): RED 16/3 (F4 concurrent deltas)
== M9 emit on every set (not idempotent): RED 18/1
== M10 mapping drops `disabled`: RED 17/2
== M11 client ignores the open snapshot: RED 17/2
== M12 client ignores the update: RED 18/1
== M13 MethodNotFound does not clear: RED 18/1    (F7)
RESTORED
```

### Tests added

- `packages/daemon/test/session-capabilities.test.ts` (9 tests): two
  clients with `by`, and the next request lacks the tool, re-enable lossless ·
  F4 concurrent different items · idempotent · F5 snapshot on create/attach ·
  create seed normalized and ignored on attach · settings sync keeps the
  switches · F10 cap and long name · `session/skills` `disabled` ·
  UnknownSession.
- `packages/client/test/session-capabilities.test.ts` (4 tests):
  snapshot, then A → B with `by`, own echo, re-attach snapshot · F7
  `MethodNotFound` clears · an older `OpenResult` leaves `undefined` · a set
  before open rejects.
- `packages/protocol/test/capabilities.test.ts` (7 tests). Fixtures in
  `json-schema.test.ts` (the zod ⇔ Ajv agreement and the drift gate).
  `skills-list.test.ts` (+1).

### Failure modes covered by S3a

F4, F5, F7 (the client half; the surface is S4/S5), F8 (display class), and F10
(the cap; an unknown name is stored). F14: the pod path is the same handler,
and the client takes it as display. Not S3a: F6, F9, F12's re-emit (S3b);
F1–F3, F11, F13, F15 (S2).

### Gate

- `bunx tsc --noEmit` → clean.
- `bun run lint` → `Checked 1662 files … No fixes applied.` (the §6 baseline,
  0 errors / 0 warnings).
- `bun test` → **12011 pass, 5 skip, 0 fail** (12016 tests, 861 files, 447s).
  The 5 skips are the opt-in guards. The first full run had **1 fail**:
  `daemon/test/mapping.test.ts` "covers every known type". That is an existing
  samples list that must name every `UPDATE_CLASS` kind, and it had no
  `capabilities` sample. I added one (test-only). The re-run above is clean.
- `protocol.json` regenerated (`bun run schema:export`); the drift gate passes.
  No `protocol.d/` note: the method, the display update and the optional
  fields are additive (§7).
- Changelog: `changelog.d/session-capabilities.added.md` already exists (one
  fragment for the whole feature, text matching the doc's metadata line). I
  added no second fragment.

**S3a: DONE.** S3b, S4, S5: not started (out of scope).

## Review

*— claude-opus-5-5, 2026-11-16* (fresh context; the same model family as the
plan's author, so shared blind spots are possible.)

**Verdict: APPROVE (S3a).** No HIGH or MEDIUM findings.

- **Gate.** The 7 touched test files pass (77 pass, 0 fail). `bun run lint` is
  clean (1662 files). `bun run typecheck` is clean (root + mobile + relay).
  The full `bun test`: the first run gave 12009 pass, 5 skip (opt-in), **2
  fail**. A re-run gave no `(fail)` line. So these are flakes under parallel
  load. They are not traced to S3a: its tests are deterministic and green on
  every run.
- **Mutations** (`.tentacle/tmp/session-capabilities/rev-mut.ts`, restored, and
  `git status` stays clean). Each one goes RED:
  - R1 `swapAgent` no re-apply → 1 fail.
  - R2 empty `OpenResult` snapshot → 2 fail.
  - R3 client ignores the update → 1 fail.
  - R4 seed not given to the agent → 1 fail.
  - R5 `by` dropped → 2 fail.
- **Attacks tried:**
  1. **§7 "don't serialize the peer".** `setCapability` is synchronous, and
     the handler adds no lock or await. It holds.
  2. **Inbound bounds.** `peer.ts:152` parses params with `RequestSchemas`, so
     the seed is capped at 256 entries and 128 characters by the schema. A
     delta is capped in `setCapability` before any state change. It holds.
  3. **Settings-sync race.** A toggle that lands while the next agent is being
     built is picked up, because `swapAgent` reads `this.caps` at swap time.
     It holds.
  4. **Re-attach replay after the snapshot.** Every update carries the whole
     state, and the last one in the ring equals the snapshot. So a replay
     converges on the current state. It holds.
  5. **Pod (§7, not trusted).** The update and the snapshot are only shown.
     There is no laptop effect and no approval. It holds.
- **Notes (below MEDIUM):**
  - A skill name longer than 128 characters is listed (`wireLine` 256) but
    cannot be toggled (`InvalidParams`).
  - A re-attach to an older daemon keeps the stale state instead of
    `undefined`.
- **Executor.** The as-built record matches the code, and the drift is
  declared honestly. Red-before-green was replaced by mutation, and the record
  says so openly.

## Execution — S3b

*— claude-opus-5-5, 2026-11-16*

**Slice S3b only**: the `capabilities` log entry, its folds (laptop load and
`serve` reload), and the carry into a session the laptop creates (resume, hop,
`/clear` close-and-replace, a worker recreate). Not touched: S4/S5 (UI).

**Provenance, honestly.** When I started, the worktree already held an
uncommitted S3b implementation and its three test files, from an earlier
executor run that left no Execution record. I did not rewrite it. I reviewed
it against the plan and the code, made one hardening edit, re-ran every check
myself, and wrote this record. The as-built below is the code as it stands now.

### Load-bearing check (re-run first)

It passed. S3b stands on two facts:

1. The laptop stores the daemon's typed entries from `session/log` after it
   validates them. `client/session-log-reader.ts:77` derives KNOWN from
   `LOG_ENTRY_CRITICAL`, so a new entry in that table is known. `:263`
   validates with `KnownLogEntrySchema`.
2. An unknown, non-critical entry is dropped, not refused
   (`session-log-reader.ts:257`). That is F9.

Every new `base` goes through one call site, `replaced(…)` → `logSegmentFacts()`
(`hosted-session.ts:3308-3313`): compaction, `context_reset` and `/clear` alike.
The constructor's first segment calls it at `:864`.

### As built, in order (protocol → agent type → daemon → client → cli)

1. **Protocol.** `session-log.ts` adds `LogCapabilitiesEntrySchema` (`skippable()`,
   the body is `SessionCapabilitiesSchema`, so the S3a caps apply) to the union,
   with `LOG_ENTRY_CRITICAL.capabilities = false`. `protocol.json` was
   regenerated (`bun run schema:export`, +38 lines).
2. **Agent.** `SessionRecord.capabilities?` is in `session-store.ts` (a type only).
3. **Daemon.**
   - `SessionLog.capabilities(state)` (`session-log.ts`).
   - `lastCapabilities(entries)` (`session-log-file.ts`) is the one fold for
     both stores.
   - `HostedSession`:
     - `setCapability` logs the whole state after a change, then calls
       `persist()`.
     - `seedCapabilities` logs it, and persists only when something is off.
       The create's first write was captured before the seed.
     - `logSegmentFacts` re-logs it after every `base`, when something is off
       (F12).
     - The constructor applies `restored.capabilities` to `caps` and to the
       agent.
   - `LogSessionStore.load` folds the current segment.
   - `daemon-state-file.ts` `rebuild` folds `derivedFrom`, the log THROUGH
     the sidecar's `logHead` (F6).
   - `DaemonSessionRecord.capabilities?` is added, and `SessionHost.restore`
     hands it over.
4. **Client.**
   - `SessionEntry.capabilities` tracks the seed, the open snapshot and every
     update.
   - `openSession` sends the record's state, or the one-shot
     `seedCapabilitiesOnCreate`. `openOn` sends the entry's state on a
     (re)create, and so does `recreate` (a worker that lost the session).
   - `newSession(…, {capabilities})` → the `RemoteSession` seed.
   - `RemoteSession.seedCapabilities()`.
5. **CLI.**
   - `session-capabilities.ts` (new): `seedCapabilitiesOf` and
     `wireCapabilities`.
   - `local-runtime.ts` `build` passes `record.capabilities` to `newSession`.
     That covers `--resume`, and a hop too, because a hop IS that seed path
     (`session-hop.ts:14-16,205-223`).
   - `persistingController` flushes on a capabilities change. Without that, a
     toggle made on another device while this session is idle would not reach
     the laptop file until the next turn.
   - `main.ts` and `connect.ts` call `seedCapabilities` on a `/clear`
     close-and-replace, next to `seedAutoAccept`.

**My edit:** `local-runtime.ts` `persistingController` now seeds `capsSeen`
from `inner.capabilities()`. Before, it skipped the first state it saw.
That is only right while the controller subscribes before the open, which is
true today. With this edit, a later subscription still flushes the first real
change. No test pins this: today's call order cannot reach the case.

### Drift from the Implementation (and why)

- **The Files list is wrong in places.** The carry did not land in
  `session-resume.ts`, `session-saver.ts`, `tui-sessions.ts`, `session-hop.ts`
  or `session-log-reader.ts`. A grep of `newSession(`/`openSession(` finds ONE
  laptop create path that holds a record (`local-runtime.ts:1057`). Hop and
  `--resume` both use it. The reader and the saver needed no change, because
  they are driven by the `LOG_ENTRY_CRITICAL` table. The real carry sites are
  `local-runtime.ts`, `main.ts`, `connect.ts`, `remote-client.ts` and
  `remote-session.ts`.
- **Additional daemon files:** `daemon-state-file.ts` (the reload fold),
  `session-log-store.ts` (the laptop fold), `session-log-file.ts` (the shared
  fold), `session-host.ts` (restore hand-over) and `hosted-session.ts`.
- **"Everything on" logs nothing** after a `base` or a seed. It is the fold's
  default. A *change* back to everything on IS logged, so that it supersedes
  the last off-state.
- **A worker recreate carries the switches** (`recreate`, `openOn`). The plan
  did not list it, but without it a lost in-process worker would silently turn
  everything back on.
- `connect` attaches (`connect.ts:341,452`) do not seed. The `serve` daemon's
  state wins on an attach. That is the existing rule.

### Red before green (§9) — honest note

The tests and the implementation came together from the earlier run, so no
run on the pre-change code exists. As in S3a, red is shown by **mutating every
target**. Each mutation below fails on an assertion, not on a compile error.

### Mutation checks (§9)

The runner is `.tentacle/tmp/session-capabilities/s3b-mut.ts`. Each mutation
is one string replacement, then the 5 S3b test files run, then the original is
written back. Afterwards `git diff | cmp` against the saved pre-run diff
printed `ALL-IDENTICAL`.

```
== M1 setCapability does not log: RED 44/5
== M2 seed not logged: RED 47/2
== M3 seed not persisted: RED 48/1
== M4 new segment does not re-log: RED 47/2
== M5 rebuild does not fold: RED 46/3
== M6 rebuild folds past logHead: RED 48/1
== M7 laptop load does not fold: RED 46/3
== M8 fold takes the FIRST entry: RED 48/1
== M9 resume does not seed: RED 48/1
== M10 no flush on a change: RED 47/2
== M11 one-shot seed not cleared: RED 47/2
== M12 create frame lacks caps: RED 46/3
== M13 recreate lacks caps: RED 48/1
== M14 restored caps ignored by HostedSession: RED 48/1
== M15 restore does not hand them over: RED 48/1
== M16 entry marked critical: RED 46/3
== M17 client forgets the update: RED 48/1
RESTORED
ALL-IDENTICAL
```

### Tests

- `packages/daemon/test/session-capabilities-log.test.ts` (9 tests):
  - L1: a change logs the whole state, non-critical; an idempotent set logs
    nothing; going back to everything on is logged.
  - L2: a seed is logged (de-duplicated); an empty seed logs nothing.
  - L3: a new segment re-carries the state (F12).
  - S1/S2: the laptop fold takes the last entry, and only from the current
    segment.
  - R1: a `serve` restore hides the server again, and the first request after
    it lacks the tool.
  - R2: only the log through `logHead` counts (F6).
  - R3: a create with switches is durable with no later change.
- `packages/cli/test/session-capabilities-resume.test.ts` (4 tests):
  - C1: an idle toggle from another device reaches the laptop file.
  - C2: `--resume` recreates the session with the switches, and its first
    request lacks `mcp__echo__echo`.
  - C3: a record with no switches starts with everything on.
  - C4: a `/clear` close-and-replace carries the switches once, and only once.
- `packages/client/test/session-capabilities.test.ts` (+2):
  - R1: a worker recreate carries the switches.
  - R2: a resumed seed, and the one-shot seed consumed once.
- `packages/protocol/test/capabilities.test.ts` (+2): the entry parses, is
  not critical (`critical: true` is malformed) and is bounded (F10).
  `session-log.test.ts` pins the critical table.

**F9 (an older reader skips it):** this is proven by two pieces, not by an
older binary.
- The entry can never be written critical: the schema rejects it, and both L1
  and M16 cover that.
- The reader drops unknown non-critical entries (`session-log-reader.ts:257`,
  existing tests).

### Failure modes covered by S3b

F6, F9 and F12 (the re-emit), plus the persistence half of F5: the laptop file
and a recreate. The Q5 carry is covered for resume, hop and `/clear`.

### Notes / debt

- **Two side copies carry no switches.** The `/clear` archive fork
  (`session-fork.ts:34`) and an aside (`saveAside`) are built from messages
  only (§7). If one is reopened, it shows everything. That fails open on
  visibility only.
- **Hop has no dedicated test.** Its seed is the same `load` → `build` path
  that C2 pins.

### Gate

- `bunx tsc --noEmit` is clean. `bun run typecheck` (root + mobile + relay) is
  clean.
- `bun run lint`: `Checked 1671 files … No fixes applied.` (the baseline, 0/0).
- `bun test`: **12084 pass, 5 skip, 0 fail** (12089 tests, 866 files,
  442.57s). The 5 skips are the opt-in guards.
- `protocol.json` was regenerated, and the drift gate passes.
- There is no `protocol.d/` note: the entry is non-critical (owner Q2).
- Changelog: the feature's one fragment `changelog.d/session-capabilities.added.md`
  already exists and covers "kept with the session". I added none.

**S3b: DONE.** S4, S5: not started (out of scope).

## Review

*— claude-opus-5-5, 2026-11-16*

Fresh-context adversarial review of slice S3b only (`git diff main...HEAD`).
**Verdict: PASS.** No HIGH or MEDIUM findings.

- **Gate:** the 5 touched test files pass (49 pass, 0 fail). `bun run lint` is
  clean and `bun run typecheck` is clean.
- **§7 persistence:** the record is the log. The laptop folds the last
  `capabilities` entry of the CURRENT segment only (`session-log-store.ts`
  `lastCapabilities(segment.entries)`). The `serve` reload folds only the
  entries THROUGH the sidecar's `logHead` (`daemon-state-file.ts` `rebuild`).
  A daemon write is `persist()` → `SessionPersister.schedule`, so it is never
  awaited. Pod and worker daemons have no persister, so nothing is stored there.
- **Pod is not trusted:** a pod-written entry only seeds a later resume with
  *fewer* visible capabilities. It is schema-capped (`MAX_DISABLED_CAPABILITIES`,
  `CapabilityNameSchema`) and creates no laptop effect or approval. That holds.
- **Single path:** the seed rides the existing `openSession` / recreate frames
  of `RemoteClient`. There is no parallel session path.
- **Mutation checks** (all reverted, tree clean):
  - Re-emit after `base` removed → L3 and R1 go red.
  - `persist()` dropped from the toggle → R1 and R2 go red.
  - Laptop flush on change removed → C1 and C2 go red.
- **Survivor (LOW, not blocking):** swapping the precedence to
  `carried ?? capabilities` in `RemoteClient.openSession` stays green. No test
  pins "the resumed record's switches beat a pending `/clear` seed". I found no
  reachable path where both are pending on the same client.
- **Minor (LOW):** the archived `/clear` fork copy is built from messages
  only, so it holds no `capabilities` entry. A paired reload re-logs an
  identical entry, which is harmless because the last entry wins.
- **Executor behaviour:** the Execution section is honest. The mutations it
  claims reproduce.
