# feat/system-prompt-cwd — State the working directory in the system prompt

> **Status:** implementation (APPROVED — orchestrator, owner delegation 2026-11-26)
> **Branch:** `feat/system-prompt-cwd`
> **Size:** M · **Blast:** cross-module (every session's request; no protocol, persistence or §7 seam change) · **Suited:** Opus plan → Sonnet exec, mandatory fresh-context Opus review
> **Changelog:** `changelog.d/system-prompt-cwd.changed.md`

`Type: feat · Size: M · Blast: cross-module · Suited: Opus plan → Sonnet exec, Opus review`

## Context

*— claude-opus-5-5, 2026-11-26*

The tentacle-vs-pi bench (private harness-compare repo, `EXPERIMENTS.md`
26/11 04:30–07:40, `runall-cwd-confirm-2611.sh`) found the main single cause
of tentacle's turn gap on clean repo tasks: tentacle's system prompt — the
default (`DEFAULT_SYSTEM_PROMPT`, `packages/config/src/defaults.ts:155`) AND
any custom `systemPromptFile` — never states the working directory; pi's ends
with a `<cwd>` block. Adding ONLY that block (the bench's variant ends the
prompt with `<cwd>\n{{CWD}}\n</cwd>`), DeepSeek, median turns, all runs PASS:

| task | pi | default | **default + cwd** | prompt-c | **prompt-c + cwd** |
|---|---|---|---|---|---|
| release-relay-version (RRV) | 16 | 35 | **18** | 24.5 | **15** |
| anthropic-tool-schemas (ATS) | 38 | 97 | **56** | 57.5 | **45** |

The rest of the ATS gap (45 → pi's 38 / transplant 33) is in pi's prompt and
tool rules — out of scope here. Owner 2026-11-26 ~08:00: «subito: aggiungere
un blocco con la cartella di lavoro nel system prompt. ok» (TODO.md item
`feat/system-prompt-cwd`). The owner approved the change and delegated the
details (see *Orchestrator decisions*).

Constraints: right per runtime (laptop worker, `serve` per project, pod
`run`/`attach` = the pod's workspace path, a sub-agent, a session hop
`/move`); the prompt-cache prefix stays byte-stable within a session (so NO
date/time in the block); honest when the workspace really changes (a hop).
Validation after merge: the bench, pinned new binary, default config, no
variant.

**Repro (capability missing, 2026-11-26, current `main` = this branch's base
`0d89f9ed`)** — `.tentacle/tmp/system-prompt-cwd/repro.ts`: the real wiring
(`loadConfig` + `buildAgent` with a recording model, the
`packages/cli/test/agent-task-description.test.ts:25-71` pattern), one turn,
then the system messages of the first request are inspected:

```ts
// feat/system-prompt-cwd repro: does the request the model receives state the working directory?
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { loadConfig } from "../../worktrees/system-prompt-cwd/packages/cli/src/config.ts";
import { buildAgent } from "../../worktrees/system-prompt-cwd/packages/cli/src/wiring.ts";

class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "done" };
  }
}

const dir = await mkdtemp(join(tmpdir(), "spcwd-"));
const configDir = join(dir, "config");
const work = join(dir, "my-project");
await mkdir(configDir, { recursive: true });
await mkdir(work, { recursive: true });
const cases: [string, string | undefined][] = [
  ["default PROMPT.md", undefined],
  ["custom systemPromptFile", "custom.md"],
];
for (const [label, file] of cases) {
  if (file) {
    await writeFile(join(configDir, file), "You are a custom agent.\n");
  }
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(file ? { systemPromptFile: file } : {}));
  const config = await loadConfig({ configDir, cwd: work, env: {} });
  const model = new RecordingModel();
  const { agent } = buildAgent(config, { modelOverride: model });
  for await (const _e of agent.run("s", [{ role: "user", content: "go" }])) {
    // drained
  }
  const msgs = model.requests[0]?.messages ?? [];
  const systems = msgs.filter((m) => m.role === "system").map((m) => String(m.content));
  const system = systems.join("\n");
  console.log(`${label}: config.cwd=${config.cwd}`);
  console.log(`  system messages: ${systems.length}, chars ${system.length}`);
  console.log(`  contains cwd path: ${system.includes(work)}; contains "<cwd>": ${system.includes("<cwd>")}`);
  console.log(`  system tail: ${JSON.stringify(system.slice(-70))}`);
}
await rm(dir, { recursive: true, force: true });
```

Output (`cd .tentacle/tmp/system-prompt-cwd && bun repro.ts`):

```
default PROMPT.md: config.cwd=/var/folders/gf/v81rbpnx5pj5r3h9vm6rbqp00000gn/T/spcwd-KFI2Av/my-project
  system messages: 1, chars 549
  contains cwd path: false; contains "<cwd>": false
  system tail: "port outcomes faithfully: if something failed, say so with the error.\n"
custom systemPromptFile: config.cwd=/var/folders/gf/v81rbpnx5pj5r3h9vm6rbqp00000gn/T/spcwd-KFI2Av/my-project
  system messages: 1, chars 24
  contains cwd path: false; contains "<cwd>": false
  system tail: "You are a custom agent.\n"
```

The agent knows its workspace (`config.cwd`) but the model is never told it.
After the change both cases must end with the environment block.

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, owner-delegated details, 2026-11-26).

### Load-bearing assumption

**Every request the main loop sends to the model passes the system head
through ONE per-request projection that never writes the stored history** —
so a block added there reaches the model on every request, and never reaches
the history, the session log or a persisted file.

Proof:
- `Agent.projectedHistory` (`packages/agent/src/agent.ts:1127-1137`) already
  rewrites the system head per request (the skills-catalog projection,
  `projectSystem`, `capabilities.ts:217`) and returns a COPY when it differs:
  "the stored history is never touched" (doc comment `agent.ts:1121-1125`).
- It is the first step of `requestHistory` (`agent.ts:1146-1155`), which is
  what every model-facing build uses: the round request
  (`agent.ts:1667-1671`), the step-limit final request (`agent.ts:2006`, its
  comment: "the system prompt is: its catalog is projected"), the prune
  estimate (`agent.ts:1190-1191`), the context line (`agent.ts:2132-2133`) and
  the exact context count (`agent.ts:2193`).
- The history the session persists is `Session.messages`
  (`packages/agent/src/session.ts:143-146`, `snapshot` `session.ts:188-189`),
  never the request copy.

The executor re-proves this FIRST with the T2(b) test below (stored head
unchanged after a turn), before writing the rest.

### Preconditions

Verified on `0d89f9ed`:

1. **The system prompt is the history's head message, composed once.**
   `composeSystemPrompt` (`packages/config/src/resolve.ts:574-589`) = identity
   (env `TENTACLE_SYSTEM_PROMPT` | `systemPromptFile`/`PROMPT.md` | default,
   `resolve.ts:641`; same precedence on a refresh, `load.ts:456`) + AGENTS.md +
   skills catalog. It reaches the agent as `config.systemPrompt`
   (`packages/cli/src/wiring.ts:1460`) and the history as
   `startConversation()`'s system message (`agent.ts:1295-1297`). A context
   reset rebuilds the head from `refresh()` (`agent.ts:2835`,
   `context-reset.ts:72`); `/clear` from `startConversation`
   (`session.ts:487`); a compaction keeps the stored head
   (`compact.ts:335-338`). All three feed the same projection, so appending
   at projection time covers default AND custom prompts AND every rebuild
   with no change to `composeSystemPrompt`.
2. **A resumed or hopped session keeps its STORED head.** `new Session(agent,
   id, { messages })` seeds the history as given (`session.ts:143-146`;
   daemon `session-host.ts:1711`). So a block stored in the head would be
   stale after a hop and missing from every old session — the reason the
   block is request-only (Design D1).
3. **The workspace is `config.cwd`, fixed per agent.** `loadConfig` sets it
   to the launch directory (`packages/config/src/load.ts:763`,
   `options.cwd ?? process.cwd()`; `resolve.ts:608-610`). `buildAgent` roots
   the agent's `HostExecution` there (`wiring.ts:883-886`, `cwd` AND `root`),
   so the tools resolve relative paths against exactly this string. Every
   runtime's factory ends in `buildAgent` with the session's `config.cwd`:
   - laptop worker: `worker.ts:217-219` → `worker.ts:103`;
   - `serve` (one project per daemon, debt note `wiring.ts:261-264`):
     `SessionHost.defaultCwd = config.cwd` (`serve.ts:801`), factory
     `{ ...ctx, cwd }` (`serve.ts:808-816`);
   - pod daemon (`serve --stdio`, `run`/`attach`): `buildAgent({ ...config,
     cwd })` / `tunnelledAgent({ ...config, cwd })`
     (`serve.ts:1439-1455`), with the POD process's config — the pod path;
   - `SessionHost.build` passes `this.opts.defaultCwd` to the factory
     (`packages/daemon/src/session-host.ts:1696`).
4. **Only two `new Agent(` sites exist** (rg, non-test): the main agent
   `wiring.ts:1442` and a native sub-agent `subagent.ts:585`. A native child
   shares the parent's execution env (`env: deps.env`, `subagent.ts:588`;
   `SubagentDeps.env` `subagent.ts:325`, wired `wiring.ts:1087-1090`), hence
   the same cwd. A worktree child is a HARNESS run (another agent CLI, `write`
   mode in its own worktree, `subagent.ts:76-84`,
   `harness/worktree.ts:44-46`) with that CLI's own prompt — not a tentacle
   `Agent`, untouched here.
5. **A hop builds a NEW agent on the target runtime** (new daemon session,
   `session-host.ts:1696-1711`); a settings sync swaps the agent and replaces
   the head in place (`hosted-session.ts:4071-4085`, `session.ts:159-167`),
   built from the same `config.cwd`. A `/move` container hop bind-mounts the
   cwd at the SAME path (`docs/feat/session-hop.md:21-22`); attaching to an
   existing workload may land in another path (`attachCwdWarning`,
   `packages/cli/src/workspace-mount.ts:953-957`).
6. **Prune is index-based** (`applyPrune`, `packages/agent/src/prune.ts:696-711`),
   so the projection must stay LENGTH-preserving: modify the head in place
   in the copy, never insert a message.
7. **The Anthropic provider joins every system message into the top-level
   `system` field** (`packages/providers/src/anthropic-provider.ts:549-558,
   639-640`); the OpenAI path sends the head as is. The voice spoken line is a
   second system message inserted AFTER the head
   (`packages/core/src/voice/turn-profile.ts:70-74`) — unaffected.
8. **A file-only config key needs no `sources` entry**
   (`resolve.ts:626-629`, `maxImageBytes`); a boolean key's docs row is the
   `loadAgentsMd` shape (`packages/config/src/key-docs.ts:501-514`) with
   `carried: "no"` (as `systemPromptFile`, `key-docs.ts:484-500`).

To check while executing (not load-bearing): `estimateUsed`'s anchor match
(`ContextAnchor.ref`, `context-awareness.ts:22-26`) never anchors on index 0
— a head that is now always a copy must not invalidate an anchor. The
hidden-skill projection already copies the head, so it is expected to hold;
T2(c) pins it (context line still exact across two rounds).

### Design

**D1 — Request-only, in `projectedHistory`.** The block is appended to the
system head inside `Agent.projectedHistory` (`agent.ts:1127-1137`), after
`projectSystem`:

```ts
const content = withEnvironment(projectSystem(first.content, this.catalogSkills, caps), this.environmentBlock);
```

Never stored: the history, the session log (`<uid>.jsonl`), the daemon
sidecar and the wire are byte-identical to today. Consequences, all wanted:
an old session resumed gets the CURRENT runtime's block; a hop gets the
target's block (new agent); a settings swap or context reset keeps the same
bytes.

**D2 — Content and bytes.** A pure module
`packages/agent/src/environment-prompt.ts`:

```ts
export interface PromptEnvironment {
  /** The workspace the tools resolve relative paths against (HostExecution `cwd`/`root`). */
  readonly cwd: string;
  /** `process.platform` of the process whose tools run (the daemon's host). */
  readonly platform?: string;
}
export function renderEnvironmentBlock(env: PromptEnvironment): string;
export function withEnvironment(content: string, block: string): string;
```

`renderEnvironmentBlock({ cwd: "/repo", platform: "darwin" })` →

```
<cwd>
/repo
</cwd>
<platform>darwin</platform>
```

(the `<cwd>` part is byte-for-byte the bench's measured form; one line per
fact; no trailing newline in the block). `withEnvironment(content, block)` =
`block === "" ? content : \`${content.trimEnd()}\n\n${block}\n\``. Rules:
- `cwd` empty → no `<cwd>` part; `platform` absent/empty → no `<platform>`
  line; both absent → `""` (content unchanged, byte-identical to today).
- a `cwd` containing a control character (`\u0000-\u001f`, `\u007f`) or the
  text `</cwd>` is rendered as `JSON.stringify(cwd)` — the block cannot be
  broken or extended by a directory name; an ordinary path is verbatim.
- NO date, time, git state, shell `cd` or anything that changes within a
  session: the bytes are a pure function of `(cwd, platform)` fixed at agent
  build.

**D3 — Computed once per agent.** `AgentConfig.environment?:
PromptEnvironment` (`agent.ts:647`); the constructor renders the block once
into a private field. `projectedHistory` applies it only when the head is a
system message with string content (today's guard, `agent.ts:1132-1134`); a
history with no system head (an empty system prompt) gets no block — the
length-preserving rule (Precondition 6).

**D4 — Wiring.** `buildAgent` (`wiring.ts:1442-1460`) passes
`environment: { cwd: config.cwd, platform: process.platform }` when
`config.systemPromptEnvironment` is true. The SAME object goes into the
sub-agent runner's deps (`SubagentDeps.environment`, wired next to `env`,
`wiring.ts:1087-1090`), and the child `new Agent({...})` (`subagent.ts:585`)
passes `environment: deps.environment` — a native child works in the
parent's env, so the parent's cwd is the truth.

**D5 — Config key `systemPromptEnvironment`** (boolean, default `true`,
file-only, no env var, `carried: "no"`, scope `both`): `schema.ts` (next to
`loadAgentsMd`, `schema.ts:335`), `key-docs.ts`, resolved in `resolveConfig`
into `ResolvedConfig`/`TentacleConfig` as `systemPromptEnvironment: boolean`,
the `model.autoTitle` shape: `pick(undefined,
fileConfig.systemPromptEnvironment, true)`, a `sources` entry, and a
`sourceKey` + `resolved` accessor on its docs row. Turning it off restores
today's request bytes exactly.

*Corrected during Execution (claude-sonnet-5-5):* the plan had it read straight
off the file with no `sources` entry (Precondition 8, the `maxImageBytes`
shape). That holds only for a key with NO documented default: a row with a
`default` and no `sourceKey` is declared a CLI-side default
(`key-docs.test.ts` "T2b: the defaults `resolveConfig` does not apply are
exactly the CLI's"), and went red.

**Runtime truth table** (all by construction from Precondition 3):

| runtime | `<cwd>` | `<platform>` |
|---|---|---|
| laptop worker | the launch dir | laptop OS |
| `serve` | the daemon's project dir | serve host OS |
| pod `run`/`attach` (incl. `--model-proxy`) | the POD daemon's cwd (the path its tools use) | `linux` |
| native sub-agent | the parent's | the parent's |
| harness/worktree sub-agent | unchanged (its CLI's own prompt) | — |
| hop local ⇄ container | target agent's (same path when bind-mounted) | target's |
| hop → existing workload | that workload daemon's cwd | its OS |

#### Orchestrator decisions

*Owner delegated the details 2026-11-26; each is the recommended option.*

1. **Where:** request-time projection (D1), NOT composed into the stored
   prompt. Why: stored would be stale after a hop and absent from every old
   session, and would change persisted bytes; projection is honest per
   runtime for free.
2. **What:** `<cwd>` (the bench's exact form) + `<platform>`. Platform is
   cheap (`process.platform`) and true by construction for the daemon's own
   tools, and it differs exactly where it matters (laptop `darwin` vs pod
   `linux`: `sed -i`, `stat`, `date` flags). NOT the date (would break the
   cache prefix daily), NOT the shell or git state.
3. **Where in the prompt:** at the END of the system head (after AGENTS.md
   and the skills catalog), as measured. The cache prefix still holds:
   constant within a session.
4. **Off switch:** yes — `systemPromptEnvironment: false`, file-only, default
   on. Why: bench arms whose prompt variant already embeds `<cwd>` would
   double it; a custom prompt author may want exact bytes. No env var (no
   current need; adding one later is free).
5. **Not carried to a pod:** the pod daemon decides by its own config (it
   builds the prompt). A laptop `false` does not reach a pod session —
   accepted for an opt-out key; carrying it would add a protocol
   `SessionSettings` field + a `CARRIED` row. Recorded as debt.
6. **Empty system prompt → no block** (D3). Inserting a head would break
   index-based prune; an empty prompt is a deliberate choice.
7. **Old sessions:** get the block on their next request after resume; one
   prompt-cache miss on that first request, then stable. No migration.

### Files

In dependency order (no protocol, daemon or client change):

1. `packages/agent/src/environment-prompt.ts` — NEW, pure: `PromptEnvironment`,
   `renderEnvironmentBlock`, `withEnvironment`.
2. `packages/agent/src/agent.ts` — `AgentConfig.environment?`; render once in
   the constructor; `projectedHistory` applies it (≈10 lines).
3. `packages/agent/src/subagent.ts` — `SubagentDeps.environment?`; pass to the
   child `new Agent` (2 lines).
4. `packages/agent/src/index.ts` — export `PromptEnvironment` (and the two
   functions if the cli test needs them).
5. `packages/config/src/schema.ts`, `key-docs.ts`, `resolve.ts`, `load.ts` —
   the `systemPromptEnvironment` key (D5); regenerate whatever generated
   reference the key-docs test pins.
6. `packages/cli/src/wiring.ts` — `environment` on the main agent and the
   runner deps (D4).
7. Tests (below); `changelog.d/system-prompt-cwd.changed.md`:
   `- **The model now knows where it works.** Every session's system prompt — the default and a custom \`systemPromptFile\` — ends with the session's working directory and platform (the pod's path in \`run\`/\`attach\`), stable for the session's prompt cache; \`systemPromptEnvironment: false\` turns it off.`

### Failure modes

| case | behaviour / how it converges |
|---|---|
| cwd unknown | `config.cwd` is always a string (`load.ts:763`); an agent built WITHOUT `environment` (tests, a future caller) or with `cwd: ""` sends no `<cwd>` — never a placeholder or a wrong path. |
| pod path vs laptop path | The block is rendered in the process whose tools run (Precondition 3): a pod session states the POD path, never the laptop's. `run` mounts at the same path; an `attach` from another folder (`workspace-mount.ts:953-957`) correctly shows the pod's. The pod-built prompt is pod-side text the laptop already only forwards (`model/stream`); no laptop effect, no §7 gate involved. |
| very long path | Verbatim, never truncated (a truncated path is a false one); bounded by the OS path limit; cached after the first request. |
| hostile/odd directory name | Control chars or `</cwd>` → JSON-quoted (D2): one line, cannot close the tag or inject lines. |
| sub-agent in another dir | Native child: parent's env ⇒ parent's cwd (`subagent.ts:588`), passed explicitly (D4). Harness/worktree child: its CLI's prompt, unchanged. |
| hop `/move` | New agent on the target ⇒ the target's block from its next request; stored head untouched. Same path ⇒ only `<platform>` may change (honest). One cache miss at the hop, as already happens for a new runtime. |
| settings swap / context reset / `/clear` / compaction | Same agent config ⇒ identical bytes; the rebuilt stored head stays block-free; the projection re-adds it. |
| old persisted session, replay | Logs never contain the block ⇒ load unchanged; the first request after resume adds the current block (one cache miss). Nothing to migrate, no `schemaVersion` impact. |
| prompt-cache stability | Pure function of `(cwd, platform)` fixed at build: two requests carry identical system bytes (T2(c)). |
| custom prompt already states cwd / bench variant with `<cwd>` | Duplicate is harmless; `systemPromptEnvironment: false` removes ours. |
| empty system prompt | No head ⇒ no block (Orchestrator decision 6). |
| version skew | None: daemon-local, nothing on the wire. A mixed old laptop + new pod gives the pod's block (the pod builds the prompt). |
| hooks | `model_request` hooks see the request WITH the block (it is what the model gets). |

### Tests

Red before green (§9): T1 fails today (module missing); T2/T3 fail on
`0d89f9ed` (the repro is their observable).

- **T1 — pure** `packages/agent/test/environment-prompt.test.ts`: exact bytes
  for `{cwd, platform}`, cwd only, platform only, neither (`""`, content
  unchanged); `withEnvironment` separator (`trimEnd` + `\n\n` + block + `\n`);
  a path with `\n`, with `</cwd>`, with a tab → JSON-quoted single line; a
  path with spaces/unicode → verbatim; determinism (same input, same bytes).
- **T2 — agent loop** `packages/agent/test/environment-prompt-loop.test.ts`
  (a recording `ModelProvider`, the `agent-task-description.test.ts:25-32`
  shape; a scripted tool call for round 2):
  (a) round 1, round 2 and the `max_iterations` final request each end their
  head with the block;
  (b) the stored head (`session.messages[0]` / the run's `messages[0]`) is
  unchanged after the turn — **the load-bearing property**; mutation: write
  the block into `messages[0]` → red;
  (c) two consecutive requests carry byte-identical system content, and the
  context line/count is still emitted (anchor sanity);
  (d) a `Session` seeded with an old head (no block) sends the block;
  (e) with a hidden skill (`projectSystem` path) the catalog is reduced AND the
  block follows it;
  (f) a native sub-agent's request ends with the PARENT's block; mutation: drop
  `environment: deps.environment` → red;
  (g) `Session.replaceAgent(next)` with `next.environment.cwd` different → the
  next request carries the new block, the stored head still block-free (the
  hop/swap property);
  (h) no `environment` → requests byte-identical to an agent built today.
- **T3 — request-level, real wiring** `packages/cli/test/system-prompt-environment.test.ts`
  (`loadConfig` + `buildAgent` + recording model, as the repro): default
  `PROMPT.md` and a custom `systemPromptFile` both end with
  `<cwd>\n<config.cwd>\n</cwd>\n<platform>${process.platform}</platform>\n`;
  `systemPromptEnvironment: false` → no `<cwd>` and the head equals
  `config.systemPrompt`. Mutation: drop `environment` in `wiring.ts` → red.
- **T4 — config**: `resolve.test.ts` default `true`, file `false` honoured,
  schema rejects a non-boolean; `key-docs.test.ts` covers the new key.

Gate before done: `bun run check` (typecheck → lint → parallel test); lint
baseline clean (AGENTS §6). Post-merge validation (owner's, not this task's
gate): the bench, pinned new binary, default config, no variant.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check: holds.** The main loop's three model-facing builds (round
`model.stream`, the step-limit final `model.stream`, `countTokensBounded`) all
go through `requestHistory` → `projectedHistory`; the only other
`model.stream` in `packages/agent/src` is the compaction summariser
(`compact.ts`), which builds its own request and is not a main-loop request.
T2(b) is green, and red under mutation M1.

**Repro.** The red tests below were the "capability missing" evidence on the
unchanged code; the Context's `repro.ts` was run again only after the change:

```
default PROMPT.md: config.cwd=/var/folders/…/spcwd-AmS3ot/my-project
  system messages: 1, chars 664
  contains cwd path: true; contains "<cwd>": true
  system tail: "p00000gn/T/spcwd-AmS3ot/my-project\n</cwd>\n<platform>darwin</platform>\n"
custom systemPromptFile: config.cwd=/var/folders/…/spcwd-AmS3ot/my-project
  system messages: 1, chars 139
  contains cwd path: true; contains "<cwd>": true
  system tail: "p00000gn/T/spcwd-AmS3ot/my-project\n</cwd>\n<platform>darwin</platform>\n"
```

**As built, in order.**

1. *Agent.* T1/T2 written first. Red: T1 module missing; T2 8 fail on their
   assertions, 3 pass (the three "head sent as stored" cases, true before and
   after). Then `environment-prompt.ts` (new), `agent.ts`
   (`AgentConfig.environment`, the block rendered once in the constructor,
   `projectedHistory`), `subagent.ts` (`SubagentDeps.environment` → child),
   `index.ts` (type export only: the cli test needs neither function).
   26/26 green.
2. *Config.* T4 in `resolve.test.ts` red (3 fail), then `schema.ts`,
   `resolve.ts`, `load.ts`, `key-docs.ts`; `bun run docs:config` added the
   README row.
3. *CLI.* T3 red (3 fail, one of them a mistake in the test's own profile
   setup, fixed), then `wiring.ts`: one `environment` object for the main agent
   and the sub-agent runner. 5/5 green.
4. `changelog.d/system-prompt-cwd.changed.md`. No schema, protocol or
   `protocol.json` change.

**Drift from Implementation.**

- D5 / Precondition 8: the key has a `sources` entry and a `resolved` accessor
  (see the correction under D5).
- T3 has two cases the plan did not list: a native sub-agent spawned through the
  real wiring (without it, dropping the runner's `environment` in `wiring.ts`
  left T3 green) and a profile switching the key off.
- `context-reset-e2e.test.ts` asserted saved head == sent head. They now differ
  by design: it asserts the saved head has no `<cwd>` and the sent head is
  exactly saved + block.
- T4's `key-docs.test.ts` coverage is the existing generic tests; no new case
  there.

**Mutations** (each applied, run, reverted):

| # | mutation | red |
|---|---|---|
| M1 | `projectedHistory` writes the block into `messages[0]` | T2 (b), (d), (e), (g) — 7 pass / 4 fail |
| M2 | child `new Agent` without `environment: deps.environment` | T2 (f) — 10 / 1 |
| M3 | main agent without `environment` in `wiring.ts` | T3 default + custom prompt — 3 / 2 |
| M4 | runner deps without `environment` in `wiring.ts` | T3 sub-agent — 4 / 1 |
| M5 | the projection also copies every other message | T2 (c) anchor — 10 / 1 |

**Checks run.** `packages/agent/test` + `packages/config/test`: 1706 pass, 0
fail (128 files). The 90 test files under cli/daemon/client/agent/tui/config
matching `buildAgent|tunnelledAgent|systemPrompt`: 1105 pass, 0 fail.
`bunx biome check packages/agent packages/config` + the three touched cli files:
no findings. **Not run here:** full `bun run test`, `typecheck`, repo-wide lint
(the orchestrator's gate), and the post-merge bench validation. No real pod,
`serve` or `/move` was exercised: those rows of the truth table rest on
Precondition 3.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; planner was the same model
family — shared blind spots are possible; the executor was Sonnet)

**Verdict: APPROVE.** No HIGH or MEDIUM findings.

**Gate (run by the reviewer):** `bun run test` 20243 pass · 5 skip · 0 fail
(1388 files; the diff adds no skip). `bun run typecheck` clean. `bun run lint`
clean (2635 files, 0 findings). Touched files: 101 pass / 0 fail across 6 files.

**Premises checked:** every model-facing build goes through `requestHistory` →
`projectedHistory` (`agent.ts:1170`; callers `:1210`, `:1686`, `:2025`, `:2152`,
`:2212`) — TRUE. Only two non-test `new Agent(` sites (`wiring.ts:1449`,
`subagent.ts:588`) — TRUE. The pod's `tunnelledAgent` ends in `buildAgent`
(`serve.ts:1355`) — TRUE. The copy keeps the length, and every non-head message
keeps its identity (`agent.ts:1155`) — TRUE.

**Mutations (each applied, run, reverted; the tree was byte-identical after):**
- `renderPath` quotes only on `\n` → T1 red, 5 failures (`</cwd>`, tab, CR, NUL, DEL).
- `wiring.ts` drops `platform` → T3 red, 3 failures (default, custom, sub-agent).
- `projectedHistory` writes the block into the stored `messages[0]` (the
  load-bearing property) → T2 (a)(b)(c)(d)(e)(g) and `context-reset-e2e` red, 7 failures.

**Attacks tried:**
1. Another model path that skips the projection: the only other non-test
   `.stream({` outside providers is the laptop proxy's forwarder
   (`remote-client.ts:4902`), which only forwards. Compaction builds its own
   request. Nothing found.
2. The block reaching the persisted history: mutation 3 shows the suite
   catches it. On the real code the stored head stays block-free (T2(b),
   `context-reset-e2e`). Nothing found.
3. Injection through the directory name: control characters and `</cwd>` are
   JSON-quoted, and `platform` is `process.platform` only. Nothing found.
4. The pod/laptop boundary (§7): the block is built pod-side from the pod's
   config and travels only inside `model/stream`. It has no laptop effect and
   adds no new trust. Nothing found.
5. Prune/anchor identity: the copy keeps the length, and T2(c) pins the
   anchored context line. Nothing found.

**Noted, not findings:** `/context`-style accounting from the stored head
undercounts the block (about 30 tokens). `systemPromptEnvironment: false` on
the laptop does not reach a pod session, which is accepted debt (Orchestrator
decision 5). The `serve`, pod and `/move` rows were not exercised live; they
rest on Precondition 3.

**Executor behaviour:** the executor worked red-first, ran five mutations and
recorded its drift honestly (the D5 `sources` correction, the extra sub-agent
case in T3, the `context-reset-e2e` change). It ran no full gate; this Review
ran it.
