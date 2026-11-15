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
- **S3a** (M · load-bearing · strong model): `packages/protocol/src/session.ts`
  (request/result, `OpenParams`/`OpenResult` field), `updates.ts` (update +
  `UPDATE_CLASS` display), `skills.ts` (`disabled?`), `methods.ts`;
  `packages/daemon/src/connection.ts` + `hosted-session.ts` (handler, broadcast
  with `by`, apply to the agent); `packages/client/src/remote-client.ts`,
  `remote-session.ts`, `mapping.ts`, `session-reducer.ts`; tests next to the
  `set_auto_accept` ones; `protocol.json` regenerated at merge
  (`bun run protocol:bump`).
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
