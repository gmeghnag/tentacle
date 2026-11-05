# feat/config-carry — the laptop carries its settings into a pod via `session/open.settings`

> **Status:** reviewed (PASS, LOW only); owner live check pending
> **Branch:** `feat/config-carry`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** AGENTS §10's `load-bearing` rule, with a mandatory fresh-context Review; the owner assigns the executor

Planned on `main` @ `4f72d41`; every `file:line` below is at that commit. Slice 1 of
`docs/eval/project-config.md` estimated M; this plan touches about 15 source files
in 5 packages plus a new seam, which is L under §10.

**Owner answers (2026-11-05), which this document already reflects:**

1. Q1: **yes** — the pod → laptop report (`OpenResult.settings` + the two notices) is in this task.
2. Q2: **yes** — `autoWake` stays out of the carried set (TUI-only reader); the eval row is corrected.
3. Q3: **only `carried`** now; `repo` comes with `feat/project-config`.
4. Q4: **B — the task-7 keys are added HERE** (the owner chose B over the plan's recommendation): this task adds the config keys `subagents.execution`, `subagents.maxParallel`, `subagents.agentTaskDescription`, `subagents.agentTaskDescriptionFile` (both description keys in one layer = config error; File relative to the config dir or absolute; resolved text ≤ 4096 B) and their carriage in `settings`, with tests. Task 7 only consumes them. One protocol bump (v16) covers both.
5. Q5: **A** — the "laptop hooks / mcpServers / PROMPT.md / agents/ do not apply in a pod" notice is a separate small task right after this one.

## Context

*— claude-opus-5-5, 2026-11-05*

**Problem.** A pod runs on its own config, which in practice means plain defaults,
so the user's `config.jsonc` applies only by half (`docs/container-config-sources.md`
§3.1, §3.3). Only two values reach a pod, as argv
(`packages/cli/src/engine-runtime.ts:89-102`). A resident keeps the flags of the
exec that started it, whichever laptop attaches later (`engine-runtime.ts:87`,
`packages/cli/src/pod-resident.ts:97-112`; `docs/container-config-sources.md` §3.4).

**Owner decisions (2026-11-05, final).**

| # | Decision |
|---|---|
| Q2 | All `subagents.*`, including the `agentTaskDescription` / `agentTaskDescriptionFile` text (resolved on the laptop, max 4096 B), are always decided by the laptop (active profile, else global) and carried. They ignore container and repo. |
| Q3 | The laptop carries the W keys into the pod as the LOWEST layer. |
| Q4 | This task runs before task 7 and adds its `subagents.*` config keys and their carriage (answer 4 above). Task 7 only reads the merged config: its slice S6 (argv flags) is gone. |
| — | `--context-window` and `--auto-title` move to `settings` and are removed, with no compat. No repo or container config file here. |

The brief says "four keys" while naming the description text too. In the code that
is `enabled`, `maxIterations`, `execution`, `maxParallel`, plus the description
(two config keys, resolved into one value). This plan treats all of them as P.

**Constraint from §7.** A daemon-side check is UX, never security. Settings flow
laptop → pod and create no effect on the laptop, so a pin is policy for honest
pods (`docs/eval/project-config.md`, rule 9).

**Repro.** Script below; it lives at `.tentacle/tmp/config-carry/repro.ts`.
**It has not been run, in planning or in execution:** `bun <script>` and `bun run
<script>` need an approval neither session had (`bun test` is allowed). The expected
column comes from reading the cited code; the same properties are pinned by the
red-first tests (see Execution).

```ts
// bun /Users/gmeghnag/tentacle/.tentacle/tmp/config-carry/repro.ts
const root = "/Users/gmeghnag/tentacle/.tentacle/worktrees/main-docs/packages";
const { OpenParamsSchema, PROTOCOL_VERSION } = await import(`${root}/protocol/src/index.ts`);
const { loadConfig } = await import(`${root}/config/src/load.ts`);
const { podDaemonCommand } = await import(`${root}/cli/src/engine-runtime.ts`);
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "cc-"));
  for (const [name, text] of Object.entries(files)) {
    const p = join(d, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return d;
};

console.log("protocol", PROTOCOL_VERSION);

// 1. What reaches a pod today: two values only.
const laptop = await loadConfig({
  configDir: dir({ "config.jsonc": JSON.stringify({ maxIterations: 99, tools: { dedupOutput: false }, subagents: { enabled: false } }) }),
  cwd: dir({}),
  scaffold: false,
  env: {},
});
console.log("1 laptop maxIterations/dedup/subagents:", laptop.maxIterations, laptop.dedupOutput, laptop.subagentsEnabled);
console.log("1 pod argv:", podDaemonCommand("tentacle", laptop).join(" "));

// 2. A `settings` field does not exist on the wire: stripped on parse.
const parsed = OpenParamsSchema.safeParse({ create: true, settings: { maxIterations: 99 } });
console.log("2 open parsed:", JSON.stringify(parsed.data));

// 3. A pod's defaults vs its explicit value are indistinguishable in TentacleConfig.
const unset = await loadConfig({ configDir: dir({}), cwd: dir({}), scaffold: false, env: {} });
const explicit = await loadConfig({
  configDir: dir({ "config.jsonc": JSON.stringify({ maxIterations: unset.maxIterations, tools: { dedupOutput: unset.dedupOutput }, loadSkills: true, contextAwareness: { enabled: unset.contextAwareness.enabled } }) }),
  cwd: dir({}),
  scaffold: false,
  env: {},
});
console.log("3 sources.maxIterations unset/explicit:", unset.sources.maxIterations, explicit.sources.maxIterations);
console.log("3 values equal:", unset.maxIterations === explicit.maxIterations, unset.dedupOutput === explicit.dedupOutput);
console.log("3 has source for loadSkills/loadAgentsMd/contextAwareness:", "loadSkills" in unset.sources, "loadAgentsMd" in unset.sources, "contextAwareness" in unset.sources);

// 4. loadAgentsMd / loadSkills are decided at load: flipping the flag later changes no prompt.
const cwd = dir({
  "AGENTS.md": "RULE-FROM-AGENTS-MD\n",
  ".git/HEAD": "ref\n",
  ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: a demo skill\n---\nBody\n",
});
const on = await loadConfig({ configDir: dir({}), cwd, scaffold: false, env: { HOME: dir({}) } });
const flipped = { ...on, agentsMdEnabled: false, skillsEnabled: false };
console.log("4 prompt has AGENTS.md / skill after flag flip:", flipped.systemPrompt.includes("RULE-FROM-AGENTS-MD"), flipped.systemPrompt.includes("demo"));
console.log("4 skills still listed after flip:", flipped.skills.length);

// 5. A pod's own apiKeyCommand runs at load, and its failure is fatal.
for (const command of ["touch /dev/null; echo ran-in-pod", "exit 7"]) {
  try {
    const c = await loadConfig({
      configDir: dir({ "config.jsonc": JSON.stringify({ model: { apiKeyCommand: command } }) }),
      cwd: dir({}),
      scaffold: false,
      env: {},
    });
    console.log("5 apiKey from command:", c.apiKey);
  } catch (e) {
    console.log("5 fatal:", (e as Error).name, (e as Error).message);
  }
}
```

| Step | Expected (not observed) | From |
|---|---|---|
| 1 | Laptop `99 false false`; argv `tentacle serve --bridge --model-proxy --context-window <n>` | `engine-runtime.ts:93-101` |
| 2 | `{"create":true}` | `packages/protocol/src/session.ts:430-445`, `packages/protocol/test/forward-compat.test.ts:16` |
| 3 | `default file`; `true true`; `false false false` | `packages/config/src/resolve.ts:118-138`, `:165-177` |
| 4 | `true true`; a skill count of 1 | `packages/config/src/load.ts:506-513`, `:572` |
| 5 | `ran-in-pod`, then `ConfigError … exited with code 7` | `load.ts:392-395`, `:516-517` |

## Implementation

*— claude-opus-5-5, 2026-11-05*

### Load-bearing assumption

**Every agent a pod daemon builds passes through one per-session factory call, and
that call is the only place session behaviour is read from config, so a per-session
overlay can replace process-start flags.**

Proof:

- `AgentFactory` is called from exactly two places: `SessionHost.newSessionContext`
  (`packages/daemon/src/session-host.ts:251`) and `SessionHost.build`
  (`session-host.ts:807`). The cli defines it three times: `serve.ts:168`,
  `serve.ts:448`, `worker.ts:114`.
- A created session reaches `build` only through `open`'s create branch
  (`session-host.ts:433-436`). `restore` also calls `build`, and only a `serve`
  daemon restores, because only it has a persister (`serve.ts:129-137`, `:241`;
  AGENTS §7).
- `buildAgent` reads the carried keys from its `config` argument at call time:
  `wiring.ts:291-296`, `:334-337`, `:345`, `:368-370`, `:375`, `:388`, `:401-403`,
  `:427`, `:437`, `:443`. A context reset closes over that same argument
  (`wiring.ts:405`).

**Three exceptions, all designed for below.** The first two would make a naive
`{...config, ...settings}` wrong, and the third changes the key list.

1. **`loadAgentsMd` and `loadSkills` are decided at load.** `systemPrompt` and
   `skills` are composed once, at resident start (`load.ts:487-513`, `resolve.ts:323-331`).
   Overriding `agentsMdEnabled` / `skillsEnabled` alone changes no prompt until a
   context reset, which would then disagree with the start (`load.ts:302`). The
   parts needed to recompose are not kept on `TentacleConfig`.
2. **A pod cannot tell "unset" from "set to the default" by value.** W needs exactly
   that, or a pod's explicit `tools.dedupOutput: true` would lose to a laptop's
   `false`. `sources` has the answer for most keys and is unused today
   (`load.ts:150`, `:578`; no cli reader), but it has no entry for `loadAgentsMd`,
   `loadSkills` or `contextAwareness.*` (`resolve.ts:118-138`, `:414-417`).
3. **`autoWake` is not a pod setting.** Its only reader is the laptop's TUI
   (`packages/tui/src/App.tsx:658`, fed by `packages/cli/src/main.ts:834`, `:1594`,
   `:1644`). No daemon or agent code reads it. The laptop's value already applies in
   a pod, so the eval's W row (`docs/eval/project-config.md:117`) is wrong in effect.
   It is not carried (Q2).

One more non-session read: `session/context` and `session/skills` with no session
describe "a session created now" (`packages/daemon/src/connection.ts:270-272`,
`:281-283`). A client asks them before its lazy open. They must take the same
settings, or the meter and the `/name` list describe a different session from the
one the first prompt creates.

### Preconditions

| Fact | Evidence |
|---|---|
| An inbound `session/open` is schema-validated before its handler; a bad one is `InvalidParams` | `packages/transport/src/peer.ts:337-340` |
| An outbound request is validated too, and rejects locally | `peer.ts:152-155` |
| An inbound result is validated, and a bad one rejects that request | `peer.ts:449` |
| Unknown fields are stripped, so an older daemon drops `settings` silently | `packages/protocol/test/forward-compat.test.ts:16`, AGENTS §7 |
| `open` is synchronous and a live id ignores `create`/`messages`; two opens never build two agents | `session.ts:390-395`, `session-host.ts:398-402` |
| Pod daemons persist nothing, so nothing here touches a record | `serve.ts:439-462` (no persister), AGENTS §7 |
| A protocol mismatch is refused cleanly at `initialize` and explained on the client | `connection.ts:346-358`, `packages/client/src/remote-client.ts:1137` |
| `run`, `attach` and the relay all reach `createLocalRuntime` through two call sites | `engine-runtime.ts:625`, `:1019`; relay via `attachEngineRuntime` (`relay.ts:331`) |
| `connect` builds its own `RemoteClient` with no provider, outside `createLocalRuntime` | `connect.ts:129` |
| The local worker uses a third `createLocalRuntime` call site | `local-runtime.ts:869` |
| Title calls stay gated on the laptop whatever the pod does | `remote-client.ts:1955-1967`, `engine-runtime.ts:116-118` |
| The serve parser is closed: an unknown flag is an error | `packages/cli/src/flags.ts:24`, `:267` |
| `@tentacle/config` has no workspace dependencies, so the wire type cannot live there or be imported there | `packages/config/package.json` |

§7 invariants this touches: one session path (reused, no second path), model stays
on the laptop (no connection key is carried), pod not trusted (Failure modes),
protocol versioning (bump), no raw terminal write (notices go through `notify`),
logic in pure modules (`carried-settings.ts`).

### Design

**Carried keys.** Wire names are flat and reuse the `sources` names, so one table
drives the overlay.

| Wire key | Config key | Class | Source key | `TentacleConfig` field |
|---|---|---|---|---|
| `contextWindow` | `model.contextWindow` | P | — | `contextWindow` |
| `autoTitle` | `model.autoTitle` | P | — | `autoTitle` |
| `subagentsEnabled` | `subagents.enabled` | P | — | `subagentsEnabled` |
| `subagentMaxIterations` | `subagents.maxIterations` | P | — | `subagentMaxIterations` |
| `loadAgentsMd` | `loadAgentsMd` | W | `loadAgentsMd` (new) | `agentsMdEnabled` + recompose |
| `loadSkills` | `loadSkills` | W | `loadSkills` (new) | `skillsEnabled`, `skills`, `skillDiagnostics` + recompose |
| `maxIterations` | `maxIterations` | W | `maxIterations` | `maxIterations` |
| `contextAwarenessEnabled` | `contextAwareness.enabled` | W | new | `contextAwareness.enabled` |
| `contextAwarenessStepPercent` | `contextAwareness.stepPercent` | W | new | `contextAwareness.stepPercent` |
| `contextResetEnabled` | `contextReset.enabled` | W | `contextResetEnabled` | `contextReset.enabled` |
| `contextResetMaxPerMessage` | `contextReset.maxPerMessage` | W | `contextResetMaxPerMessage` | `contextReset.maxPerMessage` |
| `maxInlineOutputChars` | `tools.maxInlineOutputChars` | W | `maxInlineOutputChars` | `maxInlineOutputChars` |
| `redactSecrets` | `tools.redactSecrets` | W | `redactSecrets` | `redactSecrets` |
| `dedupOutput` | `tools.dedupOutput` | W | `dedupOutput` | `dedupOutput` |
| `tabulateJson` | `tools.tabulateJson` | W | `tabulateJson` | `tabulateJson` |
| `summarizeLargeOutput` | `tools.summarizeLargeOutput` | W | `summarizeLargeOutput` | `summarizeLargeOutput` |
| `toolExecution` | `tools.execution` | W | `toolExecution` | `toolExecution.mode` |
| `toolMaxParallel` | `tools.maxParallel` | W | `toolMaxParallel` | `toolExecution.maxParallel` |
| `subagentExecution` | `subagents.execution` (new) | P | `subagentExecution` (new) | `subagentExecution` (new) |
| `subagentMaxParallel` | `subagents.maxParallel` (new) | P | `subagentMaxParallel` (new) | `subagentMaxParallel` (new) |
| `agentTaskDescription` | `subagents.agentTaskDescription` / `agentTaskDescriptionFile` (new) | P | `agentTaskDescription` (new) | `agentTaskDescription` (new) |

That is 7 P + 14 W = **21 keys**. **Never carried:** every L and C key of the eval's
table, and `autoWake` (Q2).

**The task-7 config keys (Q4 = B).** From the task-7 plan (Design 9–10, owner decisions
1, 2, PE-Q6):

- `subagents.execution`: `sequential` | `read-only` | `parallel`, default `parallel`;
  env `TENTACLE_SUBAGENT_EXECUTION`. `subagents.maxParallel`: a positive int, default 4;
  env `TENTACLE_SUBAGENT_MAX_PARALLEL`. Both resolve by `pick`, into
  `TentacleConfig.subagentExecution` / `subagentMaxParallel`.
- `subagents.agentTaskDescription` (inline) / `agentTaskDescriptionFile` (relative to the
  config dir, or absolute: the `systemPromptFile` helper). Both in ONE layer = a schema
  error; across layers the profile wins (`applyProfile` drops the base's other key). The
  text is read once at load, trimmed, into `TentacleConfig.agentTaskDescription?`.
  Missing, unreadable, empty, or over 4096 bytes → `ConfigError` naming the setting. No
  env twin.
- **No reader in this task:** `buildAgent` does not read the four values yet. Task 7 does,
  from the merged `config`. They are accepted, resolved and carried here, and the template
  comment and CHANGELOG say so.
- **`agentTaskDescription` is the one P key that may be absent on purpose**, when the
  laptop has no custom text. With `settings` present and the key absent, the result is
  `undefined` (the neutral default), never the pod's own text; only a bare open keeps it.
- **On a pod daemon `agentTaskDescriptionFile` is not read** (`podDaemon` load option,
  below), for the reason `apiKeyCommand` is not run: a value the laptop decides must not
  be able to kill the pod's daemon. A bare open there has the pod's inline text only.

**Children inherit `tools.execution`** (task-7 owner decision 4): nothing here. It is
already W, and task 7 passes it to children.

**Wire (`protocol`).** In `session.ts`, next to `OpenParamsSchema`:

- `SessionSettingsSchema`: every key above, each `.optional()`, with the same bounds
  as the config: `maxIterations` / `subagentMaxIterations` / `contextResetMaxPerMessage`
  are `IterationLimitSchema`, the union of `-1` and a positive int (`schema.ts:207-211`,
  `:218-222`, `:245-249`); `contextWindow`, `toolMaxParallel` and `subagentMaxParallel`
  are positive ints; `maxInlineOutputChars` is a non-negative int;
  `contextAwarenessStepPercent` is 1..100; `toolExecution` and `subagentExecution` are
  `ExecutionModeSchema`, the enum of `schema.ts:322`. `agentTaskDescription` is
  `.min(1).max(4096)`, in units: the 4096-BYTE cap lives in the config load, on the
  laptop, and every text within it satisfies this bound. The schema export refuses a
  `.refine` (`packages/protocol/src/json-schema.ts:189`: `ZodEffects` is unrepresentable),
  and a test pins zod and the JSON Schema accepting the same. The two helpers are
  exported because a shared instance must be a named `$def`. A strip schema, never
  `.strict()`.
- `OpenParams.settings`, `SessionContextParams.settings`, `SessionSkillsParams.settings`:
  optional. "Honoured only by a session this open creates; ignored in every other
  case", added to the rule block at `session.ts:389-428`.
- `OpenResult.settings` (Q1), optional:
  `{ carried: SessionSettingsSchema, overridden: z.array(line(64)).max(64) }`, using
  `line` from `packages/protocol/src/text-line.ts:11`. `overridden` is bounded strings
  rather than an enum, so a newer daemon's key cannot reject the whole open.
- `PROTOCOL_VERSION` → **16** (`packages/protocol/src/version.ts:7`). The schema change
  alone is additive, but the meaning is not: a v15 daemon strips `settings`, and the
  new laptop no longer passes the flags, so every P value would be lost with no
  error. §7: a changed meaning is a bump. `bun run schema:export` regenerates
  `packages/protocol/schema/protocol.json` (`package.json:19`, pinned by
  `packages/protocol/test/json-schema.test.ts:48`).

**Daemon: an opaque carrier.** `daemon` never interprets a key.

- `AgentContext` gains `settings?: SessionSettings` (`session-host.ts:55-62`). The
  factory's return gains `settingsReport?: OpenResult["settings"]`.
- `open`'s create branch passes `params.settings` to `build` (`session-host.ts:436`).
  The live and archived branches do not, per the rule above.
- `build` stores the report on the `HostedSession`; `OpenOutcome` carries it for both
  created and attached sessions; `Connection.open` adds it to its result
  (`connection.ts:414-416`).
- `newSessionContext` takes `settings` (`session-host.ts:246-251`, `connection.ts:271`).
  `newSessionSkills` passes `settings` to its option (`session-host.ts:124`, `:235-236`,
  `connection.ts:282`).

**Only the proxy branch honours it.** `serve.ts:168` and `worker.ts:114` already take
`(cwd)` and never see the context. In `podSessionHost` only the `options.modelProxy`
branch reads it (`serve.ts:448-461`). So `serve` ignores a `settings` a client sends
by construction, and the model-proxy rule of the eval holds without a check.

**Client.** `RemoteClientOptions.sessionSettings?: SessionSettings`
(`remote-client.ts:203-213`), sent wherever a session may be CREATED or described as
new:

| Site | Sends? |
|---|---|
| `openSession` (`remote-client.ts:643-648`) | yes |
| `recover`, never-live create (`:1425-1430`) | yes |
| `recreate` (`:1520-1525`) | yes, so a recreate rebuilds with this laptop's values |
| `sessionContext`, no id (`:440`) | yes |
| `sessionSkills`, no id (`:459`) | yes |
| `attachSession` (`:558`), `recover` live (`:1420`) and never-live attach (`:1423`) | no: these never create |

Plus `onSessionSettings(listener)`, shaped like `onHistoryLost` (`:605`), fired from
`applyOpenResult` (`:1478`) and from `recreate`'s created branch (`:1536-1545`), which
does not pass through it.

**CLI: one pure module, `packages/cli/src/carried-settings.ts`** (§7: logic in pure
modules). It is the one place holding the table.

- `CARRIED: Record<keyof SessionSettings, { class: "P" | "W"; configKey: string; … }>`.
  `Record` over the schema's keys means a key added to the wire fails to compile until
  it is classified.
- `carriedSettings(config): SessionSettings`: the laptop's fully resolved values, all
  21 keys (20 when it has no custom description), defaults included. Laptop env > active profile > global is already the
  resolution order (`resolve.ts:165-177`, `load.ts:453-460`).
- `applyCarried(config, settings): { config, report, pinnedOver }`:
  - `settings` absent (a bare open on a proxy daemon): the pod's values, except
    `autoTitle: false`, which is today's rule (`serve.ts:451-453`).
  - **P:** the carried value replaces the pod's. A key present and absent differ only
    for the description, above (and `autoTitle`, which stays off when absent).
  - **W:** the carried value applies only where `config.sources[key] === "default"`,
    and the source is then stamped `"carried"`. Otherwise the pod's value stands and,
    if the two differ, the key goes in `overridden`.
  - **Recompose** when `agentsMdEnabled` or `skillsEnabled` changed: `skills: []` and
    `skillDiagnostics: []` if skills are off, then `composeSystemPrompt` (exported,
    `resolve.ts:265`, re-exported by `packages/config/src/index.ts:12`). Default for
    both is on, so only a carried `false` over an unset pod changes anything. A later
    reset agrees, since it reads the merged flags (`load.ts:302`, `:333`, `:358`).
  - `pinnedOver`: P keys the pod's own env or file set to a different value, logged once
    per session to the daemon log. Not sent to the laptop.
- `settingsNotices(mine, report): string[]`, pure, on the laptop. Key names are matched
  against this laptop's `CARRIED` table and others are dropped. Output:
  - overridden: `This container's own config sets <keys>; its values win over yours for this session.`
  - drift (`report.carried` ≠ `mine`, compared per key): `This session keeps the settings it was created with (<keys> differ); a new session uses yours.`

  Key names only, so no pod-supplied text reaches the terminal.

**CLI wiring.**

- `tunnelledAgent` (`serve.ts:370-415`): options become `{ settings?, log?, skillScan? }`;
  it calls `applyCarried` and builds from the result. It passes `skillScan` only when
  the merged `skillsEnabled` is true: with skills off, `rescanSkills` falls through to
  `rediscoverSkills(config)`, which does no I/O (`wiring.ts:358-362`, `load.ts:353-359`).
  The shared scan stays as it is for other sessions (`serve.ts:438`).
- `podSessionHost`: `createAgent: (cwd, { modelLink, settings })` passes `settings` on
  (`serve.ts:448-460`). `newSessionSkills` answers an empty listing when the merged
  value is off, else `skillScan.newSession()` (`serve.ts:443`).
- `PodDaemonOptions` becomes `{ modelProxy? }` (`serve.ts:418-422`).
- Remove the flags: `podDaemonCommand` (`engine-runtime.ts:89-102`, and its comment
  `:80-88`), `residentCommand` (`pod-resident.ts:97-112`), `runResidentMode`
  (`pod-resident.ts:794-799`), `main.ts:659-665`, `flags.ts:97-98`, `:103`, `:109`,
  `parseContextWindowFlag` (`flags.ts:398-417`).
- `LocalRuntimeDeps.sessionSettings?` (`local-runtime.ts:509-514`), passed to
  `RemoteClient` (`:554-561`). Set at `engine-runtime.ts:625` and `:1019` from the
  config at that moment, so `attach`'s `moveTo` reload (`main.ts:1288-1293`) and the
  relay's profile (`relay.ts:604-608`) are honoured. **Not** set at `local-runtime.ts:869`
  or in `connect.ts:129`.
- `createLocalRuntime` subscribes `onSessionSettings` next to `onHistoryLost`
  (`local-runtime.ts:563`) and sends each `settingsNotices` line through `deps.notify`
  once per session and text, since a reconnect re-opens. Never a raw write (§7). The
  relay's `notify` is its log (`relay.ts:331-343`).

**Config.**

- `Source` gains `"carried"` (`resolve.ts:40`, Q3). `sources` gains `loadAgentsMd`,
  `loadSkills`, `contextAwarenessEnabled`, `contextAwarenessStepPercent`
  (`resolve.ts:118-138`, `:445-465`). Each uses `pick` semantics, with the existing
  parsing of `TENTACLE_NO_AGENTS_MD` / `TENTACLE_NO_SKILLS` (`resolve.ts:233-246`). The
  file source covers the active profile, as elsewhere (`load.ts:453-460`).
- `TentacleConfig` keeps the parts to recompose: `promptIdentity: string` (the value of
  `resolve.ts:322`, via `ResolvedConfig`) and `agentsMdContent?: string` (`load.ts:477`).
- `LoadConfigOptions.podDaemon?: boolean` (`load.ts:47-61`): the load neither runs
  `apiKeyCommand` (applied at `:516`) nor reads `agentTaskDescriptionFile`, the two
  values the laptop decides that could fail a load. `main.ts:545` sets it for `serve` with
  `--model-proxy`, `--resident-status` or `--resident-stop`: those need no key, and the
  status probe runs without `--model-proxy`, so a failing command there would fail attach's
  probe as well. Plain `serve --stdio` without the proxy still runs it, since it calls its
  provider. Nothing under the proxy uses the key (`wiring.ts:280`, `:384`, `:444-445`).
- Correct the comments now false: `load.ts:74`, `:76`, `:88`, `wiring.ts:366`.

### Files

In dependency order. Source first, then tests.

1. `packages/protocol/src/session.ts`, `skills.ts`, `version.ts`, `schema/protocol.json` (generated).
2. `packages/daemon/src/session-host.ts`, `hosted-session.ts` (the stored report), `connection.ts`.
3. `packages/client/src/remote-client.ts`.
4. `packages/config/src/schema.ts` (the four `subagents.*` keys), `defaults.ts`, `profile.ts`, `resolve.ts`, `load.ts`.
5. `packages/cli/src/carried-settings.ts` (new), `serve.ts`, `engine-runtime.ts`, `pod-resident.ts`, `local-runtime.ts`, `flags.ts`, `main.ts`, `wiring.ts` (a comment).
6. `CHANGELOG.md`; `docs/container-config-sources.md` (§1, §2.1, §2.9, and §3.1, §3.3, §3.4 marked done); `docs/eval/project-config.md` (the `autoWake` row, and the task-7 rows no longer "not yet in the schema"); `README.md:271` area, one line on what reaches a pod; `TODO.md` at merge.

Tests:

- New: `packages/cli/test/carried-settings.test.ts`, `packages/protocol/test/session-settings.test.ts`, `packages/config/test/subagent-keys.test.ts`, `packages/daemon/test/session-settings.test.ts`.
- Extended: `packages/cli/test/model-proxy.test.ts`, `connect.test.ts`, `packages/client/test/remote.test.ts`.
- Edited because flags go: `engine-runtime.test.ts` (22 lines), `engine-docker.test.ts` (2), `serve-resident.test.ts:835-845`, `serve-limits.test.ts:587-600` (removed), `model-proxy.test.ts:218-229`, `:286-311`.
- **Heads-up:** `engine-runtime.test.ts:275`, `engine-k8s.test.ts:72` and `engine-docker.test.ts:270` use partial `TentacleConfig` fixtures. `carriedSettings` reads `contextAwareness.enabled` and `contextReset.enabled`, so those throw until the fixtures gain those fields.

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| **Version skew:** new laptop, resident v15 (a kept pod) | `VersionMismatch` at `initialize` (`connection.ts:346-358`), explained by the client (`remote-client.ts:1137`); the attach warning already says so (`pod-resident.ts:742`) | The existing `attach` replace; a live detached run is refused and needs `tentacle rm` (`pod-resident.ts:750-754`) |
| **Version skew:** old laptop, new binary | The laptop injects its own binary, so this needs `TENTACLE_POD_BIN`. The removed flag then fails the closed parser (`flags.ts:267`), seen as "connection closed", with the reason in the routed daemon log | Pre-public, no shim (§7). Accepted, in Notes |
| **Version skew:** same version, a key unknown to the daemon | Stripped. `overridden` from a newer daemon is dropped by the laptop's table | Task 7 bumps for this reason |
| **Resident already up, laptop has other settings** | A new session uses this laptop's values, which fixes §3.4. Other live sessions are untouched | Per session |
| **Attach to a live session with another profile** | Ignored (`session.ts:394`). The drift notice names the differing keys | The user opens a new session for the new values |
| **Two TUIs racing to create one id** | Synchronous open: the first wins; the second attaches and gets the drift notice | One agent |
| **`run --detach`, then `attach --profile X`** | The relay created the session from the run's profile (`relay.ts:604-608`), so the TUI gets drift. A later `/clear` session uses X | As above |
| **Relay reconnects** | Live id → re-attach, no settings. Notice deduplicated | No repeat |
| **Recreate from `messages`** (pod restarted, session gone) | `recreate` resends this laptop's settings. If a different profile attached, the rebuilt agent follows it, and nothing was persisted to compare (§7). The report carries the new values, so no drift line | Honest: the current laptop decides |
| **`connect`** | Never sends (no option at `connect.ts:129`). `serve` would ignore it anyway | `serve`'s config rules |
| **In-process worker** | Never sends; gets the laptop's config by bootstrap (`worker.ts:55`) | Unchanged |
| **Invalid value** | The laptop can't produce one: same bounds, and an invalid file is fatal (`main.ts:551-553`). If a bug did, the outbound check rejects locally (`peer.ts:152-155`) and the open fails visibly. From another client: `InvalidParams` (`peer.ts:340`), nothing built, never half-applied | The error surfaces in the turn |
| **Hostile pod ignores a pin** | Possible and accepted (§7: UX, not security). It could already burst `model/stream`. The laptop gates still hold: titles (`remote-client.ts:1955-1967`), permissions (broker) | No laptop effect |
| **Hostile pod lies in the report** | At worst a false notice. Names are filtered by the laptop's table, values are never printed, and it creates no approval | §7 holds |
| **Hostile pod sends a malformed report** | The peer rejects that open's result (`peer.ts:449`), so the pod breaks its own session only | Visible error |
| **Pod's own `apiKeyCommand`** | Not run under the proxy, including when it would fail | Removes a fatal for a value never used (eval Notes) |
| **Bare open on a proxy daemon** (no `settings`) | The pod's own values, titles off. Only a future or third-party client | Same as today's "no flags" |
| **`session/context` before the open** | Counts with the same settings as the coming open, including tools from `subagentsEnabled` and `contextResetEnabled` | Meter matches the first prompt |
| **Settings contain secrets?** | No: 21 enumerated values; the only free text is the user's own description, which a pod and the model see anyway. An allowlist test pins it | §7 model invariant |
| **Description file missing, unreadable, empty, or over 4096 B** | `ConfigError` on the laptop (or any non-pod host) at load; never in a pod daemon, which does not read it | The user fixes the config |
| **Both description keys in one layer** | Schema error, in the file and in each profile. Across layers the profile wins | Same |
| **A pod's own description text or file** | Beaten by the carried `settings`, including when the laptop has none (neutral default) | Pinned by a test |

### Tests

Red first, each shown failing on the code before its slice. Fakes: `createChannelPair`,
`Connection`, `SessionHost` and `RemoteClient`, as in `model-proxy.test.ts:9-12`,
`:221-229`. No new fakes.

| # | Property pinned | Mutation that must turn it red |
|---|---|---|
| T1 | `OpenParamsSchema` keeps `settings`; each config boundary is accepted (`-1`, `0` for inline chars, `100` for step); each out-of-bound value is refused | Loosen or drop one bound |
| T2 | **A pod's explicit value equal to the default still beats the carried one** (the exact W property, repro 3) | Compare against the default value instead of `sources` |
| T3 | Table test: each W key with the pod unset → carried; with pod file → pod; with pod env → pod | Drop a row from the overlay |
| T4 | P: the pod's file and env both lose, for all 4 keys | Treat one P key as W |
| T5 | Carried `loadAgentsMd: false` over an unset pod: **the built agent's first request has no AGENTS.md text**; same for `loadSkills: false` with the catalog, the `skill` tool and `session/skills`; a context reset afterwards agrees | Override the flags without recomposing (the naive merge) |
| T6 | End to end over a channel pair: a laptop's `maxIterations`, `redactSecrets` and `contextWindow` reach the pod agent's behaviour, not just its config | Don't pass `settings` in `podSessionHost` |
| T7 | Client table: settings are on all 5 sites, absent on the 3 attach sites | Remove them from `recreate`; add them to `attachSession` |
| T8 | **Recreate:** the pod loses the session → reopen → the rebuilt agent has the carried values | Same as T7 |
| T9 | Live id: `settings` ignored, the first agent's values stand, `factory` called once | Pass `settings` in the live branch and rebuild |
| T10 | `connect` sends no `settings` on open, context or skills (spy on frames); `serve` given a `settings` builds from its own config | Set the option in `connect.ts`; read `settings` in `serve.ts:168` |
| T11 | Worker: no `settings` on the wire | Set it at `local-runtime.ts:869` |
| T12 | Two sequential sessions on one host with different settings get different agents (the frozen-flags fix) | Cache the first merge in `podSessionHost` |
| T13 | `session/context` with no id counts the same as the session then opened | Ignore `settings` in `newSessionContext` |
| T14 | `settingsNotices`: unknown keys dropped; no value printed; dedupe across a reconnect; delivered through `notify`, no raw write | Print a report value |
| T15 | Allowlist: `Object.keys(carriedSettings(c))` equals the 21 keys, and a config with `apiKey`, `baseURL`, `hooks`, `mcpServers` leaks none of them into the JSON | Spread `config` into the result |
| T16 | `--context-window` and `--auto-title` are refused by `serve`; `podDaemonCommand` is exactly `serve --bridge --model-proxy`; the dispatch `main` test still passes | Leave one flag in `ARGS.serve` |
| T17 | A pod config with a failing `apiKeyCommand` starts under `--model-proxy` and `--resident-status`, and never spawns it; plain `serve --stdio` still runs it | Default `skipApiKeyCommand` on, or never set it |
| T18 | A v15 client against v16 fails with `VersionMismatch`, not mid-session | Revert the bump |
| T19 | Hostile: a daemon that ignores settings changes nothing on the laptop; a title call with `autoTitle` off is still refused | Remove the laptop gate |
| T20 | `subagents.*` keys: defaults (`parallel`, 4), env wins over file, a bad value refused; both description keys in one layer refused (file and profile); across layers the profile wins; a file relative to the config dir and an absolute one read and trimmed; missing, empty and over-4096-B each a `ConfigError`; a multi-byte text at the byte boundary | Drop the cap, or the profile's drop of the other key |
| T21 | `settings` present with no description → the agent's config has none, even with a pod text; absent `settings` → the pod's text stays; the drift notice never prints the text | Keep the pod's value when the key is absent |
| T22 | `podDaemon` never reads `agentTaskDescriptionFile` (a missing file does not fail the load) | Read it regardless |

Keep the existing title test (`model-proxy.test.ts:261`): "laptop off → no title call,
even when the pod says `autoTitle: true`".

Gate per §4: narrow file per slice, then `bun run check`. Fresh-context Review per §10,
red-teaming the pod-not-trusted and protocol invariants, and whether any `buildAgent`
reader sits outside the factory.

### CHANGELOG

Under `## [Unreleased]`:

```markdown
### Changed

- **Your config now reaches a pod or container.** `run` and `attach` carry your
  `maxIterations`, `tools.*`, `contextAwareness`, `contextReset`, `loadAgentsMd`
  and `loadSkills` (your environment, active profile and global file, resolved on
  your laptop) as the lowest layer. The container's own environment and config
  file still win, and you are told which keys they set. Pods no longer run on
  plain defaults, so a limit such as `maxIterations` now follows you.
- **Sub-agent settings, `model.contextWindow` and `model.autoTitle` are always
  your laptop's** in a pod or container; its own config cannot change them.
- **`attach --profile <name>` now applies to the new sessions it opens.** A
  session already running keeps the settings it was created with, and says which
  ones differ.
- The protocol is now version 16. A daemon left running by an older tentacle is
  refused at connect; attach again to replace it, or `tentacle rm <name>` if a
  detached run still uses it.

### Removed

- `tentacle serve --context-window` and `--auto-title`: the laptop now sends those
  values per session.

### Fixed

- A `model.apiKeyCommand` in a container's own config no longer runs there, and
  can no longer stop the daemon from starting. The container never uses that key.
```

### How task 7 consumes this

For the executor of `feat/parallel-agents`. **Q4 = B: the config keys and their carriage
exist already, so slice S6, Design 9–11 of its plan, P15 and the base64url and `--k=v`
reasoning all go.** No protocol bump, and drop `flags.ts`, `pod-resident.ts`, `schema.ts`
and `load.ts` from its file list unless something else needs them.

1. **Read the merged `config`** in `buildAgent`: `config.subagentExecution`,
   `config.subagentMaxParallel`, `config.agentTaskDescription` (absent = your neutral
   default text). `tunnelledAgent` needs no change; `podSessionHost` already passes
   `settings`, and the context probe and the skill list already carry them.
2. **Don't resolve or read the description again**: it is read once, trimmed and capped,
   at load, on the laptop. A pod never reads `agentTaskDescriptionFile`.
3. **Remove "not read yet"** from `schema.ts`, the template in `defaults.ts`, the README
   table and the CHANGELOG's `### Added` line once they have a reader.
4. **`DEFAULT_SUBAGENT_EXECUTION` and `DEFAULT_SUBAGENT_MAX_PARALLEL` already exist.**

### Notes and debt

- **The TUI's `ctx` meter uses this laptop's `contextWindow`** (`main.ts:829`), so on a
  live session with drift its max is not the agent's window. The drift notice names the
  key. Left as is: fixing it needs `OpenResult` → TUI plumbing.
- **The old-laptop + `TENTACLE_POD_BIN` skew reads as "connection closed".** The reason
  is in the daemon log. Not worth a shim pre-public (§7).
- **`docs/feat/session-titles.md`, `context-awareness.md`, `detached-runs.md` mention the
  flags** (33 occurrences). They are legacy records of what was built, so not rewritten.
- **`DEFAULT_REDACT_SECRETS` says "on by default" but is `false`**
  (`packages/config/src/defaults.ts:38-39`). Carrying now spreads the laptop's effective
  value to pods. The eval already calls for a separate `fix`.
- `docs/eval/project-config.md` stays open: its Q1 and Q5–Q11 belong to slice 2. Its
  `autoWake` row is corrected.

## Owner questions (answered at the top of this document)

**Q1. Should this task include the pod → laptop report (`OpenResult.settings` and two notices)?**
Without it, a W key overridden by the container and a live session keeping older settings
are both silent. **Recommendation: yes.** It is about one schema field, one client event
and one pure function, and it is the only thing that surfaces the "re-attached with
different settings" case. Dropping it lowers the size but leaves those drops silent.

**Q2. Should `autoWake` stay out of the carried set?**
The eval lists it as W, but only the laptop's TUI reads it (`App.tsx:658`, `main.ts:834`).
Carrying it would be a dead field. **Recommendation: yes, leave it out** and correct the
eval's row. A consequence: a container's own `autoWake` has no effect, as it has none today.

**Q3. Should `Source` gain only `carried` for now, rather than `repo`, `container` and `carried`?**
`repo` has no reader until slice 2. On a pod, `file` already means the container's file.
**Recommendation: only `carried`**; slice 2 adds `repo`, and `container` is not needed.

**Q4. Should the 3 task-7 wire keys be added here or in task 7?**
Their config keys do not exist until task 7, so here they would have no reader or test.
**Recommendation: in task 7**, with its own bump to 17, as set out above. Adding them now
saves one bump but ships an unused schema, and pre-public bumps cost nothing.

**Q5. Should the laptop also say that its `hooks`, `mcpServers`, `PROMPT.md` and `agents/` don't apply in a pod?**
Today only packages get that line (`main.ts:641-646`). The eval's rule 10 wants it
(`docs/container-config-sources.md` §3.3), but carrying does not depend on it.
**Recommendation: a separate small task**, right after this one, so this load-bearing diff
stays reviewable. If you want it here, it is a few lines at `main.ts:641`.

*— claude-opus-5-5, 2026-11-05*

## Execution

*— claude-opus-5-5, 2026-11-05*

**As built, in the plan's order:** protocol (`SessionSettingsSchema`, report, v16) →
daemon (opaque `AgentContext.settings`, `HostedSession.settingsReport`) → client
(`sessionSettings`, `onSessionSettings`) → config (four `subagents.*` keys, new `sources`,
`promptIdentity`, `agentsMdContent`, `podDaemon`) → cli (`carried-settings.ts`,
`tunnelledAgent`, `podSessionHost`, both engine call sites, `createLocalRuntime`; the flags
removed) → docs. 21 carried keys: 7 P + 14 W.

**Load-bearing assumption, re-verified first.** By search: `createAgent` is called only at
`session-host.ts:251` and `:807` (at `4f72d41`), and `buildAgent` reads every carried key
from its argument. By execution: the end-to-end tests in `model-proxy.test.ts` show a
carried `maxIterations`, `redactSecrets`, `contextWindow`, `subagentsEnabled`,
`contextResetEnabled`, `loadAgentsMd` and `loadSkills` changing what the laptop's model sees.

**Drift from the plan:**

1. **The description's byte cap is not on the wire.** The plan's `.refine` cannot be
   exported (Design, wire bullet; found running the protocol tests). Wire: 4096 units.
   Bytes: at load, on the laptop. A hand-made frame can carry up to about 12 KB of text; it
   is the sender's own session, so nothing is lost.
2. **`IterationLimitSchema` is a union, not a refine,** for the same reason. The two shared
   schemas are exported, because a shared unnamed instance exports a path `$ref`.
3. **`subagents.maxParallel` is added too.** Answer Q4 lists three keys, but the brief says
   "the task-7 `subagents.*` config keys" and the wire table has it. Default 4 (PE-Q6).
4. **`skipApiKeyCommand` became `podDaemon`**, and also skips reading
   `agentTaskDescriptionFile`. A bare open on a proxy daemon therefore has only the pod's
   inline text. `isPodDaemonLoad` (`flags.ts`) requires `--model-proxy` with a pod mode, so
   a `serve --model-proxy` on a WebSocket, which builds its own provider, still gets its key.
5. **Extra `sources`:** `autoTitle`, `subagentExecution`, `subagentMaxParallel` and
   `agentTaskDescription`, so `pinnedOver` can tell "set" from "default" for every P key.
6. **`pinnedOver` is logged once per distinct line per daemon,** not per session: a
   `session/context` probe builds an agent too.
7. **`createSettingsNotifier` is a pure helper** in `carried-settings.ts`, not inline in
   `createLocalRuntime` (§7: logic in pure modules).
8. **Test files differ:** new `client/test/session-settings.test.ts`,
   `daemon/test/session-settings.test.ts`, `config/test/subagent-keys.test.ts` rather than
   extending `remote.test.ts`, `resolve.test.ts` and the daemon's open tests; `relay.test.ts`
   is not extended (the relay goes through `attachEngineRuntime`, whose call site is pinned).
   `tool-phase.test.ts` and `version-mismatch.test.ts` pinned 15 and are updated.
9. **`schema/protocol.json` was edited by hand**, not by `bun run schema:export`, which
   needed an approval this session did not have. The generator's output was printed from a
   throwaway test and copied in order. `json-schema.test.ts` compares the file with the
   generator by value, and passes. To confirm the bytes: `bun run schema:export`, then
   `git diff packages/protocol/schema/protocol.json` should be empty.

**Red first, honestly.** Protocol, daemon, client, config and `model-proxy.test.ts` were each
shown failing before their slice. `carried-settings.ts` was written in the same step as its
test file, so that file was never red on its own; the mutations below stand in for it.

**Repro:** not run (see Context). The same properties are pinned by tests: step 1 by the
end-to-end tests, step 2 by `session-settings.test.ts`, step 3 by the W table (T2), step 4 by
the recompose tests (T5), step 5 by the `podDaemon` tests (T17, T22).

**Mutations: 28, each seen failing the named test, then restored from a `cp` backup with the
13 files' `shasum` identical to the backups.** W ignores `sources` (T2) · no recompose (T5) ·
`carriedSettings` spreads the config (T15) · the pod's description kept (T21) · unknown names
printed (T14) · a value printed (T14) · a bound loosened (T1) · version back to 15 (T18) ·
context probe ignores settings (T13) · live id rebuilt (T9) · recreate without settings (T7/T8)
· attach with settings (T7) · `connect` sends them (T10) · `serve`'s skills read them (T10) ·
the non-proxy pod host honours them (T10) · settings not passed in `podSessionHost` (T6) ·
first merge cached (T12) · scan kept with skills off (T5) · `run` and `attach` sites drop them
(2, T6) · notifier not subscribed (T14) · title gate removed (T19) · flag left in `ARGS.serve`
(T16) · `podDaemon` never set and always set (2, T17) · description file read under `podDaemon`
(T22) · byte cap counted in units (T20) · profile keeps the other key (T20). A few ran in the
same batch across separate test files; where one masked another (attach, by the live-id
mutation) it was rerun alone.

**Not pinned:** T11 for the worker's own call site. Pinned instead: no option → nothing on
the wire, and the worker's factory takes `(cwd)` only, so a sent value would be ignored. Read
`local-runtime.ts` (`startWorkerRuntime`) in Review: it does not set `sessionSettings`.

**Gate:** `tsc --noEmit` on the root clean; `bunx biome check .` clean; `bun test packages`
4727 pass, 3 skip (the opt-in ones), 0 fail. `tsc -p apps/mobile` **could not be verified
here**: `apps/mobile/node_modules` does not exist in this worktree, so it fails on `expo` and
`react-native` before reaching this code. To verify: install with mobile and run `bun run
typecheck`.

**One flake seen, not fixed:** an earlier full run failed `session-reaper.test.ts` "a connection
forgets a session another client closed", which asserts a `WeakRef` is collected after
`Bun.gc`. It passed in the full runs before and after with the same sources, and 5 of 5 alone
(`--rerun-each 5`). Nothing in this change holds a session; the Review should still look.
The new `main` test also prints `{"resident":false}` to stdout (the status probe writes there
directly), which belongs with `TODO.md`'s `cli-tests-terminal-clean`.

**Unverified: nothing here ran against a real engine.** Owner live checklist, with a
`config.jsonc` holding `maxIterations: 3`, `tools.dedupOutput: false`, a profile `p` with
`maxIterations: 5`, and a daemon log open (`tentacle ps`, the run's log file):

1. **Docker, `run`:** the model stops at 3 rounds; `model.contextWindow` shows in its context
   line. **Podman:** the same, once.
2. **k8s, `run --profile p`:** stops at 5, on a pod with no config of its own.
3. **Container's own config:** in the image or by `exec`, write `maxIterations: 7` to its
   `~/.config/tentacle/config.jsonc`, restart its daemon, open a session: 7 wins, and the TUI
   says `This container's own config sets maxIterations; …`.
4. **Re-attach with different settings:** `attach <name> --profile p` to a live session: the
   notice `This session keeps the settings it was created with (maxIterations differ); …`,
   once, not again after a reconnect. `/clear` there: the new session uses 5, no notice.
5. **Detached resident:** `run --detach`, then `attach` with the same config: no notice. With
   `--profile p`: the drift notice. In the relay's log: nothing raw on any terminal.
6. **Old resident:** `attach` to a kept pod running a v15 daemon: replaced, or a live detached
   run is refused with `tentacle rm <name>`.
7. **`connect`:** to a `serve` with `maxIterations: 9` from a laptop with 3: the turn uses 9, no
   settings notice.
8. **A pod's failing `model.apiKeyCommand`:** the attach and its status probe still work.

## Review

*— claude-opus-5-5, 2026-11-05*

**Verdict: APPROVE-WITH-NITS → PASS** (LOW only). Fresh context, but the **same model
as the executor** (claude-opus-5-5): shared blind spots can survive both passes on a
load-bearing task (§10). The owner's live checklist (Execution) is the different-angle check.

### Findings

1. **LOW: a pod's own invalid *inline* description still kills a pod daemon's load.**
   `packages/config/src/load.ts:446` checks `subagents.agentTaskDescription` (empty after
   trim, over 4096 B) even when `podDaemon` is set. Only the File form is skipped. Scenario
   (run, in `.tentacle/tmp/config-carry/trace.test.ts`): a container's `config.jsonc` has
   `subagents.agentTaskDescription: "x".repeat(5000)` → `loadConfig({ podDaemon: true })`
   throws `ConfigError … over 4096 bytes`, so `serve --bridge --model-proxy` dies, for a
   value the laptop always overrides (P). This contradicts the Design's own rule ("a value
   the laptop decides must not be able to kill the pod's daemon"). It is low because any other
   invalid key in the container's file is fatal too (the strict schema). It is the same class
   as "invalid config", not a new crash path.
2. **LOW (cosmetic, daemon log only):** `packages/config/src/resolve.ts:515` stamps
   `sources.agentTaskDescription` from the *read* text. A pod that sets only
   `agentTaskDescriptionFile` (not read under `podDaemon`) shows `default`, so `pinnedOver`
   never logs that the laptop replaced it. It has no effect on behaviour or on the laptop.

No MEDIUM or HIGH findings.

### Gate (run once, foreground)

`bunx tsc --noEmit`: clean. `bunx biome check .`: 654 files, clean. `bun test packages`:
**4727 pass, 3 skip (the opt-in ones), 0 fail**, 4730 tests across 317 files. The reaper GC
flake did not occur, so no rerun was needed. `schema:export` was not rerun (the orchestrator
ran it with no diff). `tsc -p apps/mobile` was not run (as instructed).

### Mutations (non-vacuity, §9)

The 4 files were backed up to `.tentacle/tmp/config-carry/bak/`. Each mutation was applied
alone and reverted by `cp`. After that, `shasum -c` gave OK for all 4 and `git status` was
clean.

| # | Mutation | Result |
|---|---|---|
| M1 (exec T2) | W rows ignore `sources` (`set = class === "P" && …`) | **28 red** in `carried-settings.test.ts` + `model-proxy.test.ts` (every "pod FILE/ENV wins, even at the default" row, plus the e2e `redactSecrets` and the AGENTS.md-true case) |
| M2 (exec T7/T8) | `recreate` drops `...this.carried` | **2 red** in the client tests: the recreate rebuild test, and `onSessionSettings` fired on a recreate |
| M3 (exec T10) | `connect.ts` passes `sessionSettings` | **1 red**: "connect never sends `settings`" |
| M4 (mine) | `Connection.open` omits `settings` from its result | **4 red**, in the daemon (create + live-id report), the client (`onSessionSettings`) and the e2e re-attach report |

### Red-team (the 8 asked)

1. **v16 honest, both ends wired.** True. `version.ts` is 16, and `version-mismatch.test.ts` and `tool-phase.test.ts` are updated. `OpenParams` / `SessionContextParams` / `SessionSkillsParams.settings` and `OpenResult.settings` are all strip schemas. The daemon forwards them (`connection.ts` → `session-host.ts` → factory), and the client sends them and reads the result. A v15 daemon would silently strip `settings` with the flags gone. That is a changed meaning, so the bump is right.
2. **Removed flags have no reader left.** `rg` finds no `context-window` / `auto-title` / `parseContextWindowFlag` in `packages/*/src`. Only `pod-resident.ts:104` and `engine-runtime.ts:89` spawn `serve`, and neither passes a setting. Old resident (v15): `VersionMismatch` at `initialize`, then attach replaces it, or `tentacle rm` for a live detached run (unchanged path). Old laptop + new pod binary: the closed parser refuses the flag, which reads as "connection closed" (accepted debt). Detached run re-attached with another profile: `attachSession` sends nothing and gets the relay-created report, so you see the drift notice. Recreate from `messages`: resends this laptop's settings (M2 pins it).
3. **`connect` never sends.** True. `connect.ts:129` has no option, so `RemoteClient.carried` is `{}` (M3 pins it). `serve`'s factory takes `(cwd)` only, so a hand-made frame is ignored anyway. The worker (`local-runtime.ts:885`) sets no `sessionSettings` either (read; T11 by reading, as Execution says).
4. **Invalid or hostile values.** Every config bound (schema and env parsers: `parsePositiveInt`, `parseNonNegativeInt`, `parseIterationLimit`, stepPercent 1..100, the enums) is a subset of the wire's. A valid laptop config therefore never makes the outbound check reject (`peer.ts:150-156`). An inbound bad `settings` gets `InvalidParams` (`peer.ts:337-340`) and nothing is built. A hostile pod's bad report fails that open's result parse (`peer.ts:446-450`): its own session only. A well-formed lying report is filtered by `CARRIED`: names only, never a value, and no approval. Titles stay gated on the laptop. Pins are policy, not security (§7), and that is stated in the code and protocol comments.
5. **`subagents.*`.** All 7 are P: they beat the pod's file and env (trace: the pod's `maxParallel: 9` loses to the laptop's default 4, and the laptop profile's `execution: "sequential"` wins). The description is read and trimmed on the laptop and capped at 4096 B (T20 by bytes). The wire allows 4096 units, which are always at least as many as the bytes. One layer with both keys → schema error, and across layers the profile wins. Under `podDaemon` the pod's File is never read (but see finding 1 for the inline form).
6. **W as the LOWEST layer, `autoWake` not carried.** True. `sources !== "default"` decides, never the value (trace: a pod's explicit `dedupOutput: true` and env `TENTACLE_MAX_ITERATIONS=7` win, the unset `redactSecrets` takes the laptop's `true`; M1 turns 28 tests red). `autoWake` is not in `CARRIED`, and the `Record` over the wire keys enforces the table at compile time.
7. **Report and notices, no raw write.** `createLocalRuntime` subscribes `createSettingsNotifier` → `deps.notify`. That is `NoticeHub.notify` in `run`/`attach`, which buffers until the TUI subscribes, so nothing is lost before mount and nothing is written raw, and the relay's log. It is deduped per session and line across reconnects.
8. **Tests non-vacuous.** 4 of 4 mutations went red (above). The e2e trace through real `loadConfig` → `carriedSettings` → `OpenParamsSchema.parse` → `applyCarried` → `settingsNotices` matched the design. The pod's `apiKeyCommand: "exit 7"` did not run under `podDaemon`.

### Premise table (spot-checked)

| Premise | Verdict |
|---|---|
| Outbound params validated, rejected locally (`peer.ts:150-156`) | TRUE |
| Inbound params → `InvalidParams` (`peer.ts:337-340`) | TRUE |
| Inbound result validated (`peer.ts:446-450`) | TRUE |
| Version mismatch refused at `initialize` (`connection.ts:363`) | TRUE |
| `connect` builds its own `RemoteClient` with no settings (`connect.ts:129`) | TRUE |
| A context reset recomposes from the merged flags (`load.ts` `refreshSessionContext`) | TRUE: it reads `config.agentsMdEnabled` / `skillsEnabled` |
| Repro (Context) | **Not run.** `bun <script>` needs an approval this session lacked too. My `bun test` trace (above) covers steps 1–3 and 5 on the branch, not on `main`. |

### Attacks that found nothing

A config bound wider than the wire's (none). A third-party client sending `{}` as `settings`: P keys absent keep the pod's values, except `autoTitle` (off) and the description (neutral); this is intended. A notice flood from a hostile pod: bounded to the names in `CARRIED`, deduped per line. `serve` and the archived reopen honouring `settings`: neither does, since only the create branch passes them and only the proxy factory reads them.

### How the executor behaved

The executor was honest and thorough. It listed every drift with a reason: the units cap instead of a byte cap on the wire, the hand-edited `protocol.json`, the extra `sources`. It flagged unverified parts itself (Repro, mobile typecheck, live engines). It ran 28 mutations, and the 3 I re-ran reproduce as claimed. The "red first" gap (`carried-settings.ts` written with its test) was declared openly.

### Owner questions (all at once)

1. **Finding 1: skip the inline description check under `podDaemon` too?** **Recommendation: no fix round now** (LOW only, beta rule). Note it for `feat/parallel-agents` (task 7), which touches the description anyway: a one-line `readFromFile`-style guard on the inline branch.
2. **Same-model review on a load-bearing task.** Executor and reviewer are both claude-opus-5-5. **Recommendation: accept**, and treat the Execution's live checklist as the independent check: at least items 1 (docker `run`), 3 (container's own config + notice), 4 (drift notice once) and 6 (v15 resident replaced). Run them *before* merge (beta: early live).
