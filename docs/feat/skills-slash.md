# feat/skills-slash — `/skill-name [args]`: the user activates a skill

> **Status:** done — merged to `main` 2026-10-21 (owner OK). Review: REQUEST-CHANGES → findings fixed, not re-reviewed (owner allowed one review)
> **Branch:** `feat/skills-slash`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (protocol: `initialize` result + `session/prompt` params, `PROTOCOL_VERSION` 6 → 7; the agent loop gains a pre-model round; the compaction re-read path) · **Suited:** strong model executes; mandatory fresh-context Review (one adversarial pass, Opus 5.5 sub-agent — owner, 2026-10-21)

Sub-task 3 of 4 of `docs/eval/agent-skills.md`. The eval's owner decisions are
the spec: Q6 *"`/skill-name` is in scope"*; decision 5 *"skills with
`disable-model-invocation: true` are hidden from the model's catalog and the
`skill` enum but are activatable via `/skill-name`"*; the split's item 3 *"the
catalog goes on the wire (names, descriptions, user-invocable flag) so the TUI,
and later mobile, can autocomplete. `/skill-name [args]` is resolved against
that catalog in a pure TUI module and sent as a **structured** activation, not
as prompt text for the daemon to parse (a path like `/tmp/x` must never trigger
a skill). Breaking change → bump `PROTOCOL_VERSION`."*

## Context

*— claude-opus-5-5, 2026-10-21*

Skills live daemon-side (discovered by the process that builds the agent, so a
pod's skills in `run`/`attach`, the host's in `connect`), and the TUI always
talks to the daemon over RPC (AGENTS §7). Today the TUI cannot know which skills
exist, and the user has no way to activate one:

- the handshake carries only the version and two capability flags
  (`protocol/src/session.ts` `InitializeResultSchema`);
- `session/prompt` is `{sessionId, turnId, content}`, `.strict()` — no field for
  an activation (`protocol/src/session.ts` `PromptParamsSchema`);
- the TUI's slash vocabulary is a static table (`tui/src/commands.ts:14-24`), and
  any input starting with `/` that is not in it is answered
  `Unknown command` (`tui/src/App.tsx:518,531`);
- a `disable-model-invocation` skill is discovered (`config/src/skills.ts:154`)
  but nothing can ever load it: the model's catalog and the `skill` enum leave
  it out on purpose (`offeredSkills`, `skills.ts:197`).

**Repro (2026-10-21, `main` @ 9b225c5, from the repo root):**

```
$ cat .tentacle/tmp/skills-slash/repro.ts
import { InitializeResultSchema, PROTOCOL_VERSION, PromptParamsSchema } from "@tentacle/protocol";
import { matchCommands } from "../../../packages/tui/src/commands.ts";

console.log("protocol version:", PROTOCOL_VERSION);
console.log("initialize result fields:", Object.keys(InitializeResultSchema.shape).join(","));
const prompt = PromptParamsSchema.safeParse({
  sessionId: "s", turnId: "t", content: [{ type: "text", text: "/deploy-app to staging" }], skill: "deploy-app",
});
console.log("prompt with a structured skill accepted:", prompt.success);
console.log("palette for '/dep':", JSON.stringify(matchCommands("/dep")));

$ bun .tentacle/tmp/skills-slash/repro.ts
protocol version: 6
initialize result fields: protocolVersion,agentCapabilities
prompt with a structured skill accepted: false
palette for '/dep': []
```

Expected after this task: version 7, `skills` in the initialize result, the
prompt accepted, and the palette listing `/deploy-app` when the daemon has it.

## Implementation

*— claude-opus-5-5, 2026-10-21*

### Load-bearing assumption

**A user activation written into the history as an ordinary, fully answered
`skill` tool round, right after the user's message and before the first model
call, is indistinguishable for every consumer from the model activating the
skill itself.** If it holds, dedup, compaction re-injection, persistence,
reload, replay and display all work with no new state and no persisted-format
change. Proof:

- *It is the shape the loop already writes.* A model activation is
  `user → assistant{content, toolCalls:[skill]} → history_commit → tool_start →
  tool_result → tool → history_commit` (`agent/src/agent.ts:408-421`, then
  `runToolCalls` `:583-600`). The new round is the same, with `content: ""` (as
  the compaction rounds, `agent/src/compact.ts`) and an id from
  `crypto.randomUUID()` (what both providers use when the server sends none,
  `providers/src/anthropic-provider.ts:244`, `openai-provider.ts:94`).
- *Derivation.* `skillActivations` counts an assistant `skill` call answered by
  a `tool` result opening with `<skill_content name="…">`
  (`tools/src/skill.ts:83-108`) — true by construction, so dedup and
  `reloadSkills` see it.
- *Providers.* `user, assistant{tool_calls}, tool` followed by the model's turn
  is the standard tool-use shape on both wire formats (no new adjacency: unlike
  the compaction round, it never follows another assistant message).
- *Daemon persistence / reload.* The round goes through `history_commit`, so the
  cut and the persisted record move as for any tool round
  (`daemon/src/hosted-session.ts` `drive`). A crash between the call and its
  result leaves an unanswered call with no pending permission → closed honestly
  by `trailingCalls` (`daemon/src/persisted-session.ts:203,299`).
- *Display.* Live: `tool_start`/`tool_result` → the existing `tool_call` updates
  → `Skill <name>` (`tui/src/render-lines.ts:316`). Replay/resume: the
  assistant's `toolCalls` become tool items (`tui/src/resume.ts:23`).

The one case where it would NOT hold today is a **hidden** skill
(`disable-model-invocation`): it is not in the tool's enum (and with only hidden
skills the tool is not registered at all), so neither the registry
(`tools/src/registry.ts:56-81`) nor `reloadSkills`'s schema check
(`agent/src/agent.ts:258`) would run it — compaction would mark it
"unavailable" and keep a stale copy. The design therefore moves activation
behind a **skill activator** that knows every activatable skill; the model-facing
tool is a façade over it with the narrower enum.

### Preconditions

- **One prompt path for every runtime.** Worker, pod `run`/`attach` and `connect`
  all go `RemoteSession.send` → `RemoteClient.prompt` → `Connection.prompt` →
  `HostedSession.prompt` → `Session.send` → `Agent.runMessages`
  (`client/src/remote-session.ts:127,183`, `client/src/remote-client.ts:407`,
  `daemon/src/connection.ts:288`, `daemon/src/hosted-session.ts:628`,
  `agent/src/session.ts:61`). The TUI is always over RPC (§7).
- **The prompt ack is synchronous up to the ack** (`hosted-session.ts:623-655`):
  a check placed there rejects before anything is recorded, like
  `assertTextOnly` (`daemon/src/mapping.ts:36`).
- **A re-sent prompt carries the same params.** The keyed re-send after a drop
  reuses the request's params (`remote-client.ts` `sessionCall(…, "keyed")`);
  `RemoteSession` re-sends through the same `sendPrompt` (`remote-session.ts:265`).
- **The handshake runs on every (re)connect** through one function
  (`remote-client.ts:546`, called at `:256` and `:722`), so a catalog read there
  is refreshed after a daemon restart.
- **Inbound results are schema-validated on the client** (`transport/src/peer.ts:437`):
  a constraint in `InitializeResultSchema` is enforced on the laptop, the
  security side when the daemon is a pod (§7 "a pod is not trusted").
- **The catalog is per daemon, not per session.** It is built at config load
  (decision 3) and every session uses the daemon's cwd (`session-host.ts:228`);
  each `SessionHost` is built from one config (`cli/src/serve.ts:115,230`,
  `cli/src/worker.ts:87`). So it belongs in `initialize`, not `session/open`.
- **Pre-public protocol rule (§7):** a breaking change bumps `PROTOCOL_VERSION`,
  no compat shim. The pod gets the laptop's own binary (`cli/src/pod-binary.ts`),
  so `run`/`attach` never mix versions; `connect` to an old `serve` fails cleanly
  with `VersionMismatch`.

### Design

1. **Config — who the user can invoke** (`config/src/skills.ts`, pure).
   `SkillInfo` gains `userInvocable: boolean`, parsed from the Claude-Code-compatible
   `user-invocable: false` (default true). A skill with both
   `disable-model-invocation: true` and `user-invocable: false` loads with a
   warning ("reachable by neither the model nor the user"). New
   `slashSkills(skills)`: user-invocable **and** a spec-valid name (the existing
   `nameProblem` rule — lenient parse lets `My Skill` load, but it cannot be
   typed as one token, and the wire name pattern is the spec's), in precedence
   order, capped at `MAX_SLASH_SKILLS` = 200 with a diagnostic (like
   `catalogCapDiagnostic`).

2. **Protocol** (`protocol/src/session.ts`, `version.ts`). `SkillNameSchema` =
   the spec pattern `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64. `SkillSummarySchema` =
   `{ name, description }`, strict; `description` 1–1024 chars with **no control
   characters** (C0, DEL, C1) — enforced on the laptop by the peer's result
   validation, so a pod cannot put a terminal escape into the TUI through it.
   `InitializeResultSchema.skills: SkillSummary[]` (max `MAX_SKILL_CATALOG` =
   200), **required**. Deliberate difference from the eval's sketch ("names,
   descriptions, user-invocable flag"): only the user-invocable skills are
   sent, with no flag — the client has nothing to do with a skill it cannot
   activate, and a model-only list on the wire would be data with no use. `PromptParamsSchema.skill?: SkillName`. `PROTOCOL_VERSION`
   → 7. `schema/protocol.json` regenerated (`bun run schema:export`).

3. **Tools — one activation path** (`tools/src/skill.ts`).
   `createSkillActivator(entries, readBody)` → `SkillActivator`:
   `has(name)`, `userInvocable(name)`, `activate(name, ctx): Promise<ToolResult>`
   (the current `execute` body: dedup from `ctx.history`, read, format, `isError`
   on failure). Entries are `SkillToolEntry & { userInvocable: boolean }`.
   `createSkillTool(skills, readBody)` keeps its signature and delegates to an
   activator over its own (model-offered) list — the enum stays the model's
   gate; existing tests unchanged.

4. **Agent — the user's round** (`agent/src/agent.ts`, `session.ts`).
   - `AgentConfig.skills?: SkillActivator`. `Agent.canActivateForUser(name)` =
     `skills?.userInvocable(name) ?? false`.
   - `RunOptions.skill?: string`. In `runMessages`, after the resume check and
     before the background-exit flush (never inside a round), when `skill` is
     set: push `assistant{content:"", toolCalls:[call]}` → `history_commit` →
     `tool_start` → `activate(name, toolContext)` (wrapped like `reloadSkills`:
     an abort answers the call `CANCELLED_TOOL_NOTE`; a throw becomes an
     `isError` result) → `transformResult` (exempt from shaping, still
     redacted) → `tool_result` → push `tool` → `history_commit`. Then the loop
     as usual: the model's first round sees the content. Already active → the
     activator's dedup note (the round still runs: the user and the model both
     see "already loaded" — one path, never a silent no-op). `skill` with
     `resumeFrom` is a caller bug → rejected before anything runs.
   - `reloadSkills` goes through the activator (`has` → `activate` with
     `history: []`) instead of the registry: a hidden skill activated by the
     user is re-read at `/compact` like any other. "Unavailable" = the activator
     does not know the name (removed, skills disabled).
   - `Session.send(text, signal, opts?: { skill?: string })` passes it on; it
     refuses (`UnknownSkillError`, before pushing anything) a skill the agent
     cannot activate for the user, or a skill with an empty `text`.
     `Session.canActivateSkill(name)` exposes the check synchronously.

5. **Daemon** (`daemon/src/{session-host,connection,hosted-session,mapping}.ts`).
   `SessionHostOptions.skills?: readonly { name; description }[]`; the host
   projects it once through pure `toSkillCatalog` (mapping.ts): drop names not
   matching `SkillNameSchema`, collapse whitespace and strip control chars from
   the description, drop an empty one, cut at 1024, keep the first
   `MAX_SKILL_CATALOG` — so the daemon's own result is always schema-valid.
   `Connection.initialize` returns it. `HostedSession.prompt(turnId, content,
   skill?)`: after the retry-key check and `assertTextOnly`, before the busy
   check, a skill the session cannot activate → `InvalidParams`
   (`unknown skill "x": not invocable on this daemon`), nothing recorded.
   `turn_start.prompt` stays the typed text.

6. **Client** (`client/src/remote-client.ts`, `remote-session.ts`). The handshake
   keeps `result.skills`; `RemoteClient.skills()` returns the latest (empty
   before the first handshake). `prompt(…, skill?)` adds `skill` to the params
   only when set. `RemoteSession.send(prompt, signal, opts?)` stores `skill` on
   the `ActiveTurn`, so the initial send and the re-send carry it.

7. **CLI wiring** (`cli/src/wiring.ts`, `serve.ts`, `worker.ts`,
   `local-runtime.ts`, `session-jobs.ts`, `connect.ts`, `main.ts`).
   `buildAgent` builds one activator over offered ∪ `slashSkills` (flagging
   `userInvocable` from `slashSkills`), passes it as `AgentConfig.skills`, and
   registers the tool over `offeredSkills` as today. `skillCatalog(config)` =
   `slashSkills(config.skills)` → `{name, description}`, passed to all three
   `SessionHost`s. The two `SessionController` wrappers pass `opts` through.
   Both TUI runtimes hand the TUI `skills: () => client.skills()`.

8. **TUI** (`tui/src/commands.ts` pure; `App.tsx`, `CommandPalette.tsx`,
   `run.tsx` render/wire). Pure:
   - `SlashSkill = { name, description }` (structural; the TUI does not depend
     on the protocol package).
   - `slashCatalog(skills)` → `{ commands, shadowed }`: the built-ins, then the
     skills as `/name` entries; a skill whose name is a built-in (`help`,
     `clear`, `compact`, `model`, `retry`, `copy`, `save`, `tokens`, `exit`,
     `quit`) is **shadowed** — the built-in wins, the skill is named in `/help`,
     never silently lost.
   - `resolveSlash(text, skills)` → `{kind:"builtin", command}` |
     `{kind:"skill", name, text}` | `{kind:"unknown", command}`. The leading
     token (up to the first whitespace) must be `/` + an exact catalog name;
     `/tmp/x`, `/deploy-app/x`, `/Deploy-App` are `unknown` (as today).
   - `matchCommands(input, skills)` over the merged catalog; `helpText(skills)`
     adds a **Skills** section (and the shadowed ones).
   - `paletteWindow(count, selected, maxRows)` → the visible slice: with 200
     skills a bare `/` must not push the input off the screen. Max rows:
     `PALETTE_MAX_ROWS` = 8.
   App: `skills` prop (a getter, read at render and at submit — a reconnect's
   refreshed catalog applies at the next keystroke). `handleCommand` resolves
   first; a skill → refused mid-turn like `/retry` (`Can't run /x while a turn
   is running`), else `run(text, { skill })`, and the text is pushed to the input
   history (↑ recalls it). Palette Enter on a skill runs it with no arguments
   (as for a command); Tab completes the name. `lastUserRef` stays the text;
   `/retry` re-resolves it (after resume too, from `lastUserText`), so a retried
   activation is an activation again.

### Files

`packages/config/src/{skills.ts,skills-scan.ts,load.ts}` →
`packages/protocol/src/{session.ts,version.ts}` + `schema/protocol.json` →
`packages/tools/src/skill.ts` → `packages/agent/src/{agent.ts,session.ts}` →
`packages/daemon/src/{mapping.ts,session-host.ts,connection.ts,hosted-session.ts}` →
`packages/client/src/{remote-client.ts,remote-session.ts}` →
`packages/cli/src/{wiring.ts,serve.ts,worker.ts,local-runtime.ts,session-jobs.ts,connect.ts,main.ts}` →
`packages/tui/src/{commands.ts,App.tsx,run.tsx}` →
docs: `README.md`, `docs/architecture/skills.md`, `docs/eval/agent-skills.md`
(status), `TODO.md`.

### Failure modes

- **No skills** → `skills: []` on the wire, the palette and `/help` unchanged,
  no activator round possible (`InvalidParams` for a raw `skill`).
- **Unknown / stale skill** (daemon restarted with other skills; a raw client)
  → `InvalidParams` before the ack; the TUI shows the turn error; nothing is
  recorded. The next reconnect refreshes the catalog.
- **`SKILL.md` deleted / unreadable since start** → an `isError` result in the
  round; the turn continues (the model and the user see why); not active.
- **Already active** → the dedup note in the round; the body is not repeated.
- **Cancel during the read** → the call is answered `CANCELLED_TOOL_NOTE`, the
  loop top ends the turn `cancelled`; the history stays valid.
- **Crash mid-round (`serve`)** → reload closes the unanswered call honestly
  (`trailingCalls`); never re-run.
- **`/compact` after a user activation** (hidden skill included) → re-read
  through the activator, fresh; never "unavailable" while discoverable.
- **Hostile pod catalog** → names pinned to the spec pattern, descriptions
  without control chars, ≤ 200 entries: enforced by the laptop's result
  validation (a violation fails the handshake, it never reaches Ink).
- **Name collides with a built-in** → built-in wins, the skill is listed as
  shadowed in `/help`.
- **Typed text that merely starts with `/`** (`/tmp/x is broken`) → `unknown`,
  as today; it can never select a skill (exact token match).
- **Mid-turn `/skill`** → refused with a notice (not queued as steering: an
  activation is a round, not a message).
- **Version skew** → `connect` to a v6 `serve` → `VersionMismatch` at
  `initialize`; pods never skew (same binary).
- **Huge catalog** → capped at 200 (diagnostic at config load); the palette
  shows a window of 8 around the selection.

### Tests

Red before green: the protocol, agent round, daemon and TUI resolver tests fail
on `main` (missing field / option / function).

- `config/test/skills.test.ts`: `user-invocable: false` parsed; both-off warns;
  `slashSkills` filters non-user-invocable and non-spec names, keeps hidden
  (`disable-model-invocation`) ones, caps with a diagnostic.
- `protocol/test`: `InitializeResult.skills` required; a description with
  `\x1b` / a bad name / 201 entries rejected; `PromptParams.skill` accepted,
  a bad name rejected; version 7.
- `tools/test/skill.test.ts`: the activator activates a hidden skill; dedup
  from history; `userInvocable`; the tool still rejects a hidden name (enum).
- `agent/test`: `runMessages({skill})` → history `[…, user, assistant{skill
  call}, tool{<skill_content…>}, assistant…]` and the model's FIRST request
  already contains the content; events `tool_start`/`tool_result` +
  `history_commit` after each push; already active → dedup note; abort during
  the read → cancelled, round answered; `skill` + `resumeFrom` rejected;
  `Session.send` refuses an unknown skill without pushing; `/compact` after a
  user-activated **hidden** skill → re-read fresh (red today: "unavailable").
- `daemon/test`: `toSkillCatalog` sanitising; `initialize` returns the catalog;
  `prompt{skill}` unknown → `InvalidParams` and no `turn_start`, no turn
  recorded; known → the round streams as `tool_call` updates.
- `client/test`: the handshake stores `skills` (and refreshes on reconnect);
  `prompt` carries `skill`, the keyed re-send too.
- `tui/test/commands.test.ts`: `resolveSlash` table (`/deploy-app`,
  `/deploy-app args`, `/help` shadowing a `help` skill, `/tmp/x`,
  `/Deploy-App`, `/deploy-app/x`); `matchCommands` with skills;
  `paletteWindow` bounds; `helpText` lists skills and shadowed ones.
- `tui/test/app.test.tsx` (ink-testing-library): typing `/dep` shows the skill
  in the palette; submitting `/deploy-app to staging` calls `send` with
  `{ skill: "deploy-app" }` and the typed text; `/unknown` still "Unknown
  command"; mid-turn refused; `/retry` re-sends the skill.
- `cli/test/wiring.test.ts`: `skillCatalog(config)` and the agent's
  `canActivateForUser` agree (one rule); a hidden skill is in the catalog and
  activatable but not in the tool enum.
- Non-vacuity by mutation (§9): resolver without the exact-token rule →
  `/deploy-app/x` test fails; `reloadSkills` back on the registry → the hidden
  re-read test fails; the daemon check removed → the `InvalidParams` test fails;
  the schema's control-char rule removed → the escape test fails.
- Optional weak-model check (local Qwen, if up): after a user round with a
  skill, the model follows it without calling `skill` again.

## Execution

*— claude-opus-5-5, 2026-10-21*

Built in the plan's order on `feat/skills-slash` (off `main` @ 9b225c5); the
repro was run on `main` before any edit (output in Context). After:

```
$ bun .tentacle/tmp/skills-slash/repro.ts      # + one line for a daemon that has the skill
protocol version: 7
initialize result fields: protocolVersion,agentCapabilities,skills
prompt with a structured skill accepted: true
palette for '/dep': []
palette for '/dep' (daemon has deploy-app): [{"name":"/deploy-app","description":"Deploy.","skill":true}]
```

1. **config** — `SkillInfo.userInvocable` (`user-invocable: false`), the
   both-off warning, `isSpecSkillName`, `slashSkills`, `MAX_SLASH_SKILLS` +
   `slashCapDiagnostic` (wired in `load.ts`).
2. **protocol** — `SkillNameSchema`, `SkillSummarySchema`, `MAX_SKILL_CATALOG`,
   `MAX_SKILL_DESCRIPTION`, required `InitializeResult.skills`, optional
   `PromptParams.skill`; `PROTOCOL_VERSION` 7; `schema/protocol.json`
   regenerated.
3. **tools** — `SkillActivator` / `createSkillActivator` (the old `execute`
   body), `userSkillCall`; `createSkillTool` keeps its signature and delegates.
4. **agent** — `AgentConfig.skills`, `canActivateForUser`, `RunOptions.skill`
   → `runUserSkill`; `reloadSkills` on the activator; `UnknownSkillError`;
   `Session.send(…, opts)` + `canActivateSkill`.
5. **daemon** — `toSkillCatalog` (mapping.ts), `SessionHostOptions.skills` →
   `skillCatalog`, returned by `initialize`; `HostedSession.prompt(…, skill)`
   pre-ack check.
6. **client** — `RemoteClient.skills()` (stored by the handshake, current link
   only), `prompt(…, skill)`; `RemoteSession.send(…, opts)` keeps it on the
   `ActiveTurn`.
7. **cli** — `skillCatalog(config)` and the activator in `buildAgent`; the
   catalog to all three `SessionHost`s; `opts` through the two
   `SessionController` wrappers; `skills` to every `startTui` (worker, pod
   `run`/`attach`, `connect`, in-process).
8. **tui** — `slashCatalog`, `resolveSlash`, `retryPlan`, `paletteWindow`,
   `matchCommands(…, skills)`, `helpText(skills)` in `commands.ts`; App wiring
   (`skills` getter prop, skill branch in `handleCommand`, `/retry`, palette
   window); `run.tsx` option.
9. **docs** — `README.md`, `docs/architecture/skills.md` (new "The user's
   `/skill-name`" section, limits, code map), eval status, `TODO.md`.

**Drift from Implementation (and why):**
- `retryPlan` added to `commands.ts`: the `/retry` decision (prompt / skill
  again / skill gone) is branching logic, so it went to the pure module (§7),
  not the component. A retried activation whose skill vanished says so instead
  of sending the text as a plain prompt.
- The TUI also collapses a description to one line (`slashCatalog`): the
  in-process runtime's catalog comes straight from config, not through the
  daemon's `toSkillCatalog`, and a YAML `|` description has newlines.
- `UnknownSkillError` is also thrown for a skill with an empty text (a
  continuation cannot carry an activation); the daemon rejects that case with
  the same `InvalidParams`.
- The test fakes that answer `initialize` (transport, client, cli
  `local-runtime`) now return `skills: []`: the field is required, and the
  client's peer validates results.
- Client test: a daemon *restarted* during an un-acked prompt does not re-send
  it (the session is lost — the existing `turnRecovery` rule), so the re-send
  and the catalog refresh are two tests, not one.

**Tests added:** `config/test/skills.test.ts` (+5), `protocol/test/session.test.ts`
(+4) and two JSON-Schema fixtures, `tools/test/skill.test.ts` (+5),
`agent/test/user-skill.test.ts` (9, new), `daemon/test/skills-slash.test.ts`
(6, new), `client/test/skills-slash.test.ts` (4, new),
`tui/test/commands.test.ts` (+6), `tui/test/slash-skills.test.tsx` (8, new),
`cli/test/wiring.test.ts` (+2). `agent/test/compact.test.ts`'s fixture now
passes the activator, as the wiring does.

**Non-vacuity by mutation (§9)** — `.tentacle/tmp/skills-slash/mutate.sh`
applies one mutation, runs the named test file, restores the file:

```
resolver first token → first two "/" segments        commands.test.ts      17 pass 1 fail
reloadSkills back on the tool's enum                 user-skill.test.ts     8 pass 1 fail
daemon pre-ack skill check removed                   daemon skills-slash    5 pass 1 fail
schema control-char rule removed                     protocol session       13 pass 1 fail
runUserSkill not called                              user-skill.test.ts     3 pass 6 fail
App sends the text without { skill }                 slash-skills.test.tsx  4 pass 4 fail
RemoteSession drops turn.skill                       client skills-slash    2 pass 2 fail
wiring: userInvocable from the offered list          wiring.test.ts         5 pass 2 fail
```

**Weak-model check (optional in the plan): not run.**
`.tentacle/tmp/skills-slash/gate.ts` (the real `loadConfig` + `buildAgent`, a
hidden `deploy-app` activated with `/deploy-app`, then the model's first own
call) got `ETIMEDOUT` from the local Qwen3.8-27B endpoint on all 6 attempts.
To verify: re-run it with the endpoint up; expected first call
`shell {"command":"make build"…}`, never `skill`.

**Gate:** `bun run check` → typecheck clean, lint clean (baseline 0/0),
`1419 pass · 2 skip (the opt-in live-k8s + slow keepalive) · 0 fail`.

## Review

*— claude-opus-5-5, 2026-10-21 (fresh-context reviewer sub-agent; the SAME
model as the executor, so blind spots we share can survive both passes)*

**Verdict: REQUEST-CHANGES.** One must-fix, and it is contained: the palette's
Enter/Tab ignores an exactly typed name, so `/deploy` + Enter can activate
`deploy-prod`, and a skill named `c` runs `/clear` (finding 1). The fix is a
few lines in the pure `commands.ts`/palette selection plus a regression test.
The load-bearing part holds under every attack below: the protocol, the
synthetic `skill` round, persistence/reload, compaction, and the §7
invariants. After finding 1 is fixed (shown red → green), this is an APPROVE.

### Findings

1. **[Medium, must-fix] Palette Enter/Tab overrides an exactly typed skill
   name with the highlighted row.** `App.tsx:794-808`
   (`paletteCommands[commandSel]`) together with `commands.ts` `matchCommands`
   (it closes the palette only when there is exactly ONE match). When one name
   is a prefix of another, the palette stays open with row 0 selected, in
   catalog order. Discovery sorts names within a root (`skills-scan.ts:159`),
   but `mergeSkills` keeps precedence order across roots (`skills.ts:185-201`).
   So with a project `.agents/skills/deploy-prod` and a user
   `~/.agents/skills/deploy`, typing `/deploy` + Enter **activates
   `deploy-prod`**. Repro (`.tentacle/tmp/skills-slash-review/prefix-enter.ts`,
   ink-testing-library):
   ```
   catalog order ["deploy","deploy-prod"] → typed "/deploy" + Enter → sent: [{"prompt":"/deploy","skill":"deploy"}]
   catalog order ["deploy-prod","deploy"] → typed "/deploy" + Enter → sent: [{"prompt":"/deploy-prod","skill":"deploy-prod"}]
   ```
   Built-ins come first, so a skill whose name is a prefix of a built-in can
   never be run bare. `prefix-builtin.ts`:
   `skill "c", typed "/c" → ["/clear","/compact","/copy","/c"] → Enter runs /clear`
   (`co` → `/compact`, `re` → `/retry`). A spec-valid name thus runs a
   destructive built-in. Tab completes to the wrong name for the same reason.
   Before skills, no built-in was a prefix of another, so the plan's "Enter
   runs it as for a command" never had to handle this. The `❯` highlight is
   visible, but the user's exact text is discarded. Fix direction: an exact,
   case-sensitive match of the typed text wins Enter (or is pre-selected),
   decided in the pure module. Pin it with the two cases above.
2. **[Low] The daemon's empty-text guard is not pinned by any test.**
   `hosted-session.ts:644` (`text === "" ||`). Removing it leaves
   `daemon/test/skills-slash.test.ts` at 6 pass / 0 fail. Without it, a raw
   `prompt{skill, content:[text("")]}` is acked, emits `turn_start` and then
   ends in a turn error (`Session.send` throws `UnknownSkillError`), instead
   of `InvalidParams` before anything is recorded, which is what the plan
   promises. Add one daemon test.
3. **[Low] The superseded-handshake guard is not pinned.**
   `remote-client.ts:569` (`if (peer === this.peer)`). Replacing it with `if
   (true)` leaves `client/test/skills-slash.test.ts` at 4/0. Scenario: a late
   `initialize` answer from a replaced link overwrites the catalog of the
   daemon now attached. The race is narrow and the result is only a stale
   palette (the daemon still rejects with `InvalidParams`).
4. **[Nit] Spec deviation not acknowledged.** The eval's split item 3 says the
   catalog carries "names, descriptions, **user-invocable flag**". The
   implementation instead sends only the user-invocable skills, with no flag
   (`protocol/src/session.ts` `SkillSummarySchema`). That is a defensible,
   smaller shape, but neither Design nor Drift says it differs from the spec.
   The Files list also names `components/CommandPalette.tsx` and the three
   `index.ts`, and none of them changed. That is harmless drift, but it is not
   recorded.
5. **[Nit] Pod descriptions: only C0/DEL/C1 are blocked.** Unicode format
   characters (bidi overrides U+202E / U+2066-2069, zero-width) pass the
   laptop's `SkillSummarySchema` regex (`session.ts`) and `oneLine`
   (`commands.ts`). A hostile pod can visually scramble its own description
   column. The name stays pinned, so it cannot spoof a different `/name`.
   `helpText` also inserts the description raw into the Markdown notice, so a
   pod controls emphasis and links in `/help`. Cosmetic; worth a line in the
   doc's threat note.
6. **[Unverified] A hidden-only skill set leaves no `skill` tool in
   `tools`.** The user round then puts a `tool_use` named `skill` in history
   that no tool definition matches. The builtins always keep `tools`
   non-empty, and I believe neither API checks history names against `tools`,
   but no live API call was made. To verify: one Anthropic and one OpenAI
   request with only a `disable-model-invocation` skill activated. A weak
   model may then call `skill` itself and get `unknown tool: skill`. That is
   benign, but it is the "optional weak-model check" the plan left undone.

### Gate (re-run by the reviewer)

`bun run check`: `tsc --noEmit` clean; Biome `Checked 329 files … No fixes
applied` (0 errors, 0 warnings = baseline); **1419 pass · 2 skip · 0 fail**
(1421 tests across 133 files). The 2 skips are the opt-in live-k8s and slow
keepalive tests. This matches Execution's claim.

### Mutation non-vacuity (§9)

My own mutations, each reverted. The tree hash (`git diff | shasum`) was
identical before and after.

| Mutation | Test file | Result |
|---|---|---|
| `InitializeResult.skills` without `.max(200)` | protocol session | 13/1 FAIL ✓ |
| `skills` made `.optional()` | protocol session | 13/1 FAIL ✓ |
| `SkillNameSchema` without the spec regex | protocol session | 12/2 FAIL ✓ |
| `runUserSkill` without the first `history_commit` | user-skill | 8/1 FAIL ✓ |
| `Session.send` without `canActivateSkill` | user-skill | 8/1 FAIL ✓ |
| `Session.send` without `text === ""` | user-skill | 8/1 FAIL ✓ |
| abort mapped to a plain error, not `CANCELLED_TOOL_NOTE` | user-skill | 8/1 FAIL ✓ |
| `reloadSkills`: activator `has` → always unavailable | user-skill | 8/1 FAIL ✓ |
| daemon without `text === ""` | daemon skills-slash | **6/0 survives** (finding 2) |
| `toSkillCatalog` keeps control chars | daemon skills-slash | 5/1 FAIL ✓ |
| handshake ignores `peer === this.peer` | client skills-slash | **4/0 survives** (finding 3) |
| shadowing off (a `help` skill beats `/help`) | tui commands | 15/3 FAIL ✓ |
| `oneLine` is a no-op | tui commands | 16/2 FAIL ✓ |
| `paletteWindow` always starts at 0 | tui commands | 17/1 FAIL ✓ |
| App: mid-turn skill not refused | slash-skills.tsx | 7/1 FAIL ✓ |
| App: palette not windowed | slash-skills.tsx | 7/1 FAIL ✓ |

I also re-ran three of the executor's mutations: `runUserSkill` not called
(3/6), `RemoteSession` drops `turn.skill` (2/2), and the reload unavailable
case. Their numbers reproduce exactly.

### Premise table

Context lines are checked on `main` (`git show main:`) and Implementation
lines on the working tree. "≈" means the content is right but the line is off
by 1-3.

| Premise | Verdict |
|---|---|
| Symptom: v6, no `skills`, `prompt{skill}` rejected, empty palette. Re-run on a `main` worktree, then on the tree. | TRUE / fixed (v7, `skills`, accepted, `/deploy-app` listed) |
| `InitializeResultSchema` = version + capabilities; `PromptParamsSchema` strict, no skill | TRUE |
| `tui/src/commands.ts:14-24` static table | TRUE |
| `App.tsx:518` Unknown command, `:531` `/` routing | TRUE |
| `config/src/skills.ts:154` `disable-model-invocation`; `:197` `offeredSkills` | TRUE |
| `agent.ts:408-421` model round + commit; `runToolCalls :583-600` | TRUE (≈) |
| `anthropic-provider.ts:244`, `openai-provider.ts:94` `crypto.randomUUID()` | TRUE |
| `tools/src/skill.ts:83-108` `skillActivations` | TRUE |
| `persisted-session.ts:203,299` `trailingCalls` closes honestly | TRUE (empirical: `reload.ts` → `INTERRUPTED_NOTE`, `resume: null`) |
| `render-lines.ts:316` `Skill <name>` | TRUE (≈ :318) |
| `resume.ts:23` toolCalls → tool items | TRUE |
| `registry.ts:56-81` unknown tool; `agent.ts:258` enum check in `reloadSkills` | TRUE (≈ :255-259) |
| One prompt path: `remote-session.ts:127,183`, `remote-client.ts:407`, `connection.ts:288`, `hosted-session.ts:628`, `session.ts:61` | TRUE (single `client.prompt` call site, grep) |
| Ack synchronous; `mapping.ts:36` `assertTextOnly` | TRUE |
| Re-send reuses params (`remote-session.ts:265` → `sendPrompt`) | TRUE |
| Handshake on every (re)connect: `remote-client.ts:546`, called at `:256`, `:722` (`this.peer` assigned first) | TRUE |
| `peer.ts:437` inbound result validation | TRUE |
| Catalog per daemon: `session-host.ts:228`, `serve.ts:115,230`, `worker.ts:87` | TRUE |
| Pod gets the laptop's binary (`pod-binary.ts`) | TRUE (file exists; not traced further) |

### Attacks tried

1. **End-to-end trace through the real stack**
   (`.tentacle/tmp/skills-slash-review/e2e.ts`): a temp skill tree,
   `loadConfig`, `buildAgent` (wiring), `SessionHost`, `Connection`,
   `RemoteClient`/`RemoteSession`, and a scripted model. Result: holds.
   - The wire catalog has `deploy-app`, `secret-op` (hidden) and `weird`, and
     not `no-user`. Its ESC is defanged on the wire (`line1 line2 [31mRED`).
   - `/secret-op` gives the model's first request
     `system | user | assistant{skill} | tool<skill_content name="secret-op">`.
     The enum excludes `secret-op`.
   - `no-user`, and `""` with a skill, → `InvalidParams` with no events. A
     second `/secret-op` gets the "already loaded" note.
   - After `SKILL.md` was edited, `/compact` re-read **v2** of the hidden
     skill; v1 is gone.
2. **Provider shape.** `buildPayload` (Anthropic) on that request gives
   `user(text) → assistant[tool_use only, no empty text block] →
   user[tool_result]`, which is valid. OpenAI sends `content: ""` + `tool_calls`,
   as the compaction rounds already do. Holds (see 6 for the unverified part).
3. **Daemon persistence.** The generator runs synchronously to its first
   `yield`, so the record written at the ack (`hosted-session.ts:670`)
   already holds `user + assistant{skill call}` (unanswered). A crash there
   reloads as `INTERRUPTED_NOTE` plus the steering as user messages, and is
   not resumable (no pending permission). It is closed honestly and never
   re-run. Holds.
4. **Reconnect / keyed re-send.** There is one `client.prompt` call site, and
   `ActiveTurn.skill` rides every re-send. The catalog is refreshed by the
   reconnect handshake. Holds, apart from the unpinned guard in finding 3.
5. **§7 red-team.**
   - Single broker: `buildAgent` permissions untouched.
   - One session path: no new loop; the in-process fallback uses the same
     `buildAgent` activator.
   - Pod not trusted: laptop-side schema; names pinned; finding 5 is
     cosmetic.
   - Versioning: v7; the JSON-Schema export is pinned by the
     `json-schema.test.ts` staleness test.
   - Peer not serialized: the check is synchronous, with no new await.
   - Raw terminal writes: none; the cap diagnostic goes through the existing
     `skillDiagnostics`.
   Holds.
6. **Sub-agents.** `subagent.ts:162` gives children no activator and a fresh
   history, and the parent's user round is never shared. This is the same as
   a model activation today, so nothing is newly visible or broken. Holds.
7. **TUI.**
   - `/tmp/x`, `/deploy-app/x` and `/Deploy-App` → unknown.
   - Mid-turn → refused, never enqueued (every `/…` routes to `handleCommand`,
     `App.tsx:581`).
   - `/retry` re-resolves. Its premise ("a `/…` prompt can only have been an
     activation") is true for this TUI. A future client writing `/…` prompts
     would get "no longer available" instead.
   - The 200-row palette is windowed.
   - **Prefix collision → finding 1.**
8. **Pre-existing test weakening.** `compact.test.ts` changed only its
   fixture: it now passes the activator, as the wiring does. Its
   "unavailable" test still exercises a name missing from the activator. No
   assertion was removed.
9. **Prior art.** I grepped `docs/eval`, `docs/fix`, `TODO.md` and
   `docs/library-bugs.md` for the touched paths and symbols. Nothing open
   constrains this change. The `App.tsx` key handler is known debt (§7), and
   finding 1's fix belongs in the pure module, not there.

### What holds

The load-bearing assumption holds empirically: the user round is the model
round's exact shape, so dedup, compaction, persistence, reload and replay
needed no new state and no persisted-format change. The protocol change is
honest: v7, a required field, laptop-side validation, and an export in sync.
Activation decisions live in pure modules (`resolveSlash`, `retryPlan`,
`paletteWindow`, `toSkillCatalog`, `slashSkills`). One rule (`slashSkills`)
feeds both the wire catalog and the daemon's acceptance check.

### How the executor behaved

Disciplined and honest.
- The Repro was real and reproduces on `main`. Every premise I checked was
  true, a few with 1-3 line offsets.
- The drift list is accurate and justified, and moving `retryPlan` into the
  pure module was a good call.
- The mutation table reproduces number for number, and the gate claim is
  exact.
- Misses: the prefix-collision path (a new failure mode the plan's "as for a
  command" hid), two unpinned guards, an unrecorded deviation from the eval's
  "user-invocable flag", and the optional weak-model check skipped without
  saying so.

### Fixes after Review

*— claude-opus-5-5, 2026-10-21 (executor; not re-reviewed: the owner allowed one review)*

1. **Fixed.** `matchCommands` (`tui/src/commands.ts`) moves an exact match of
   the typed name to the front of the palette (the default selection), so
   Enter and Tab act on what was typed: `/deploy` runs `deploy` even when the
   project's `deploy-prod` is listed first, and a skill `c` is no longer
   shadowed by `/clear`. Red first: `commands.test.ts` "an exactly typed name
   comes first…" and `slash-skills.test.tsx` "Enter on an exactly typed name
   runs THAT skill…" both failed before the change. Mutation (`exact > 999`)
   → the App test fails again.
2. **Fixed.** The daemon test now sends a known skill with an empty text and
   expects `InvalidParams` before anything starts. Mutation (drop
   `text === "" ||`) → 5 pass / 1 fail.
3. **Not tested, documented.** The `peer === this.peer` guard is defensive: a
   link is replaced only after its peer closed, and closing rejects every
   pending request (`transport/src/peer.ts` `close`), so a superseded
   `initialize` answer cannot arrive through public behaviour. A comment at the
   guard now says so.
4. **Fixed (doc).** Design states the deliberate "user-invocable only, no flag"
   shape; the Files list matches the diff.
5. **Fixed.** The TUI's `oneLine` also drops bidi overrides/isolates and
   zero-width characters from descriptions (test added). The wire schema still
   rejects only control characters: refusing the handshake over a bidi mark
   would be harsher than the cosmetic risk.
6. **Recorded, not changed.** The weak-model check is now reported as not run
   (endpoint down) in Execution. A `skill` round with no registered `skill`
   tool (only hidden skills) is the same history shape `feat/skills-compaction`
   already produces for an `unavailable` skill; no live API call was made to
   confirm either provider accepts it — to verify, run a `/name` of a hidden
   skill against each provider.

**Gate after the fixes:** `bun run check` → typecheck clean, lint clean,
`1422 pass · 2 skip (opt-in) · 0 fail`.
