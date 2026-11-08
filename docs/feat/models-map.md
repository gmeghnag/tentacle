# feat/models-map — named `models`, per-type sub-agent models, agent-selectable models

> **Status:** implementation (plan written, awaiting owner approval + answers Q1–Q5)
> **Branch:** `feat/models-map`
> **Size:** M (upper end; see the split proposal, Q1) · **Blast:** cross-module · **Suited:** a cheaper model (DeepSeek) may execute parts **A** and **B** of this plan; Review is **mandatory fresh-context** (a sub-agent or `/code-review`) red-teaming secrets: key routing, masking, the workspace-mount hide list, and "a key never leaves the laptop". Part **C** (slot sizing) is split out: it touches the agent loop, so it is load-bearing and goes to a strong model.

Type: feat · Size: M · Blast: cross-module · Suited: DeepSeek executes A (+B if Q1 = b), fresh-context secret red-team Review; C → `feat/models-map-slots` (S–M, load-bearing, strong model)

Vocabulary (owner): **agent** = the main model the user chats with; **subagent** = the
child started by an `agent_task` call; **entry** = one `models.<name>` block.

## Context

*— claude-opus-5-5, 2026-11-08*

**Why.** Task 3/9 of `docs/eval/subagent-live.md` (point C; owner answers rounds 1–3).
Today every sub-agent runs on the agent's endpoint and key. An `agents/*.md` `model` can
only change the model id **on the same endpoint** (`packages/cli/src/model-provider.ts:13-29`:
`configuredModelProvider(config, model)` keeps `config.baseURL`/`config.apiKey`;
`packages/cli/src/wiring.ts:481`). There is no way to say "`explore` runs on a small local
model, hard work goes to a hosted model with its own key".

**Binding decisions (owner, not reopened here):**
- A NEW top-level `models` map: name → the shape of the top-level `model` block
  (`ModelConfigSchema`, `packages/config/src/schema.ts:10-49`). Unset fields inherit from
  `model`. Not profiles.
- `subagents.types.<type>.model: "<name>"` must name a `models` entry; an unknown name is a
  config error (Q6 = a: `subagents.types.<type>`, a strict schema, no reserved words).
- An `agents/*.md` `model` is looked up as a `models` name first, else read as a model id on
  the main endpoint (today's meaning). Config beats frontmatter (Q4 = a).
- The top-level `model` stays the agent's model and the default of every unconfigured type.
- Owner addition (2026-11-08): opt-in `subagents.selectableModels: ["<name>", …]` (absent or
  empty = off) + an optional `models.<n>.description`. The descriptions are listed in the
  `agent_task` description, `agent_task` gets an optional `model` argument that accepts
  only a listed name (any other → an error result, no child starts). Precedence: the call's
  `model` › `subagents.types.<t>.model` › the `agents/*.md` `model` › the top-level `model`.
- Per-endpoint slot SIZING for foreground rounds belongs to task 3; the session-level limiter
  is task 6c; NO slot reservation for the agent (Opus review M8, owner Q14 = b).
- Local/`serve` only. Pod runs are task 4 (`feat/models-map-pod`, the name on
  `model/stream`, the laptop allowlist, a `PROTOCOL_VERSION` bump).

**Constraints.** The config CLI and registry merged this week: every schema key must be
documented in `packages/config/src/key-docs.ts` (T1 fails otherwise) with its secret flag;
masking in `config list/get` and the argv refusal in `config set` are driven by those flags
(`packages/config/src/config-value.ts:134-151,163-175`). The README config table is
generated (`bun run docs:config`, gate `packages/config/test/readme-config-table.test.ts`).

**Repro** (capability missing). Run from `.tentacle/tmp/models-map/` on current `main`
(the architect's sandbox denied `bun` execution, so the output below is the one the strict
schema must give — `schema.ts:410-418` is `.strict()` with no `models` key; the executor
re-runs it before any edit and pastes the real output here):

```ts
// .tentacle/tmp/models-map/repro.ts
import { FileConfigSchema } from "../../../packages/config/src/schema.ts";
for (const probe of [
  { models: { fast: { model: "qwen3-4b" } } },
  { subagents: { types: { explore: { model: "fast" } } } },
  { subagents: { selectableModels: ["fast"] } },
]) {
  const r = FileConfigSchema.safeParse(probe);
  console.log(JSON.stringify(probe), "→", r.success ? "ok" : r.error.issues[0]?.message);
}
```
Expected on `main` @ `09f63cf`:
```
{"models":{"fast":{"model":"qwen3-4b"}}} → Unrecognized key(s) in object: 'models'
{"subagents":{"types":{"explore":{"model":"fast"}}}} → Unrecognized key(s) in object: 'types'
{"subagents":{"selectableModels":["fast"]}} → Unrecognized key(s) in object: 'selectableModels'
```

## Implementation

*— claude-opus-5-5, 2026-11-08*

Written against `main` @ `09f63cf`. The plan has three parts:
- **A — the `models` map + per-type routing** (config, resolution, keys, wiring, pods, mount hide).
- **B — agent-selectable models** (`selectableModels`, `description`, the `agent_task` `model` arg).
- **C — per-endpoint slot sizing for foreground rounds** — **split out** (outline only below).

Q1 decides whether B ships on this branch (recommended: yes, it is small) or on its own.
Every step is tagged **[A]** or **[B]**. If Q1 = (a), do the [A] steps only, and skip the
`selectableModels`/`description` keys too.

### Load-bearing assumption

**Every sub-agent's model is obtained in exactly ONE place, `deps.modelFor`, which the CLI
builds in exactly ONE place, and over the pod tunnel that place returns the tunnel for every
type.** So routing per-type models and keys is a wiring change, with no change to the agent
loop, and in a pod no `models` key can be used or carried.

Proof:
- The runner picks the child's provider at `packages/agent/src/subagent.ts:228`
  (`type.model && deps.modelFor ? deps.modelFor(type.model) : deps.model`) and nowhere else;
  the child `Agent` gets that `model` at `:235-236`.
- The CLI builds `modelFor` once, in `buildAgent` (`packages/cli/src/wiring.ts:477-481`):
  `(modelId) => options.modelOverride ?? configuredModelProvider(config, modelId)`.
  `configuredModelProvider` is the one constructor (`model-provider.ts:1-7,13-29`).
- In a pod, `buildPodAgent` passes `modelOverride: tunnelFor()` (`packages/cli/src/serve.ts:452-456`),
  so `modelFor` returns the tunnel for every type. The laptop serves `model/stream` with its
  MAIN model (or the title model) only (`docs/eval/subagent-live.md` C4, verified there).
- Nothing in `carried-settings.ts` carries `model.*` connection keys (`model.provider/baseURL/
  apiKey/apiKeyCommand` are `carried: "no"`, `key-docs.ts:150-247`), and the new keys are
  `carried: "no"` too (step A6), so nothing of `models` reaches a pod.

Second assumption (masking): **masking and the argv refusal are path-driven by the registry.**
`secretOf(key)` resolves a concrete path to its registry node (`config-value.ts:127-136`,
`config-keys.ts:134-146`, a map's free segment matches anything), `maskOf` masks a `true`
secret as `***` (`config-value.ts:163-175`), `isArgvRefusedSecret` refuses every secret but
an `…apiKeyCommand` (`:145-151`), and the `profiles.*` mirror is derived from the base entries
(`key-docs.ts:917-944`). So marking `models.*.apiKey` / `models.*.apiKeyCommand` `secret: true`
masks `models.x.apiKey` AND `profiles.p.models.x.apiKey` in `config list/get`, and refuses
them on argv, with no code in the CLI.

### Preconditions

- `ModelConfigSchema` is a strict object (`schema.ts:10-49`); `settingsShape` is shared by the
  file and by each profile (`schema.ts:188-394`, `ProfileSchema` `:401-406`,
  `FileConfigSchema` `:410-418`). Adding a key to `settingsShape` adds it to profiles too.
- `subagents` is a strict object with fixed keys + a `superRefine` (`schema.ts:221-261`).
- The profile merge is pure (`profile.ts:46-114`). `model` merges per key EXCEPT the
  connection group `provider/baseURL/apiKey/apiKeyCommand`, which moves as a unit
  (`profile.ts:18-29`): the rule "a key is never sent to an endpoint it was not configured
  for". `subagents` merges per key (`:86-100`).
- The main model resolves env › file › default, per field (`resolve.ts:353-386`), the key
  env › `apiKey` › `apiKeyCommand` (`resolve.ts:493-506`). `--model` is folded into
  `TENTACLE_MODEL` on a copy of env (`load.ts:546-547`).
- The main `apiKeyCommand` runs in `loadConfig`, before any Ink mount, skipped for a pod
  daemon load (`load.ts:634-640`; `podDaemon`, `load.ts:109-116`). Its failure is a
  `ConfigError` that names the exit code and stderr, never stdout (`load.ts:468-472`).
- `loadConfig` reports the FIRST zod issue as `Invalid <path>: <message>` (`load.ts:78-92`);
  `config set` validates the whole file with `FileConfigSchema.safeParse` before writing
  (`config-edit.ts:182-190`). A `superRefine` on `FileConfigSchema` is therefore seen by both.
- The registry walker unwraps `ZodEffects` (`config-keys.ts:60-83`), so a `superRefine` on
  `FileConfigSchema` does not change the key tree. Nothing reads `FileConfigSchema.shape`
  (grep: no `FileConfigSchema.shape|extend|pick|omit` in `packages/`).
- `key-docs.test.ts` T1 requires every schema path (leaf and section) to be documented, T7
  pins the secret set (`key-docs.test.ts:59-175,410-470`).
- Agent types: built-ins `general`, `explore` (`subagent.ts:57-72`); user types from
  `<configDir>/agents/*.md` + packages (`wiring.ts:71-118`), parsed by `parseAgentDefinition`
  with a string `model` and a numeric `contextWindow` (`agent-defs.ts:91-122`). Their
  diagnostics are printed pre-Ink as `[agents] …` only outside `run`/`attach`
  (`main.ts:800-827`).
- The `agent_task` input is validated by the registry with zod and the parsed (stripped)
  value reaches `execute` (`tools/src/registry.ts:79-96`); a validation failure is an error
  result, not a throw.
- The child's hook runner receives a model id for the `model` field of hook payloads
  (`subagent.ts:264-270`, `hooks.ts:511-516,716`).
- The workspace mount of a docker/podman `run` hides the main key FILE named by
  `apiKeyCommand` (`workspace-mount.ts:71-90`, called at `main.ts:1150-1151`). A k8s pod never
  mounts a laptop folder (`main.ts:1140-1141`).
- `PROTOCOL_VERSION` = 17 (`protocol/src/version.ts:7`). This task changes no wire schema.

### Design

#### A1. Config shape

```jsonc
{
  "model": {
    "baseURL": "http://localhost:8080/v1",
    "model": "qwen3-27b",
    "apiKeyCommand": "cat ~/.cache/llama-key",
    "contextWindow": 131072
  },
  "models": {
    // No connection key: the same endpoint and key as `model`, another model id.
    "fast": {
      "model": "qwen3-4b",
      "contextWindow": 32768,
      "description": "Small and quick: file searches, summaries, simple edits."
    },
    // Its own endpoint: inherits NO provider/baseURL/key from `model`.
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-5-5",
      "apiKeyCommand": "pass show anthropic",
      "contextWindow": 200000,
      "description": "Strong reasoning: hard bugs, design questions, multi-file refactors."
    }
  },
  "subagents": {
    "types": { "explore": { "model": "fast" } },
    "selectableModels": ["fast", "claude"]          // [B]
  },
  "profiles": {
    // Offline: `claude` is replaced WHOLE (Q5): main endpoint + key, no description.
    "offline": { "models": { "claude": { "model": "qwen3-27b" } } }
  }
}
```

Schema (`schema.ts`):
- `MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/`. A name with `.` would make a config path
  ambiguous (`config set models.a.b.model`); it also appears in the tool description.
- `ModelEntrySchema = ModelConfigSchema.omit({ autoTitle: true, titleModel: true })`
  `.extend({ description: z.string().min(1).max(300).optional() })` — **[B]** adds
  `description`; the `omit` is Q3 (recommended). Zod 3.23.8 `omit`/`extend` keep
  `.strict()` (they copy `_def`); the executor proves it first (Tests, step 0).
- `settingsShape.models = z.record(z.string().regex(MODEL_NAME, MODEL_NAME_MESSAGE), ModelEntrySchema).optional()`,
  with `MODEL_NAME_MESSAGE = 'models: a name may hold only letters, digits, "_" and "-" (at most 64 characters)'`.
  Place it right after `model:` (`schema.ts:189`) so `explain` lists it next to `model`.
- In `subagents` (`schema.ts:221-249`), after `agentTaskDescriptionFile`:
  - `types: z.record(z.string().min(1), z.object({ model: z.string().min(1).optional() }).strict()).optional()`
    (the per-type object is strict and open for future per-type keys; `model` optional so an
    empty `{}` type block is legal and means "no override").
  - **[B]** `selectableModels: z.array(z.string().min(1)).optional()`.
- `FileConfigSchema` gets `.superRefine((file, ctx) => { for (const message of modelRefIssues(file)) ctx.addIssue({ code: z.ZodIssueCode.custom, message }); })`.
  `modelRefIssues` lives in the new `models.ts` (import cycle is type-only:
  `schema.ts → models.ts → profile.ts → type-only schema.ts`).

#### A2. Reference check (`modelRefIssues(file: FileConfig): string[]`, pure, `models.ts`)

For the base view `applyProfile(file, undefined)` and for each profile `p` the view
`applyProfile(file, p)` (both `ok` by construction — `p` is a key of `profiles`):
- each `[type, { model }]` of `view.subagents?.types` with `model !== undefined` and not
  `Object.hasOwn(view.models ?? {}, model)` →
  `subagents.types.<type>.model: "<model>" is not a models entry (<defined>)`;
- **[B]** each `name` of `view.subagents?.selectableModels` not in `view.models` →
  `subagents.selectableModels: "<name>" is not a models entry (<defined>)`;
- `<defined>` = `defined: a, b` (the view's names, sorted) or `no models defined`.

The base view's messages are returned as is. A profile view's messages that are NOT in the
base set are returned prefixed `profiles.<p>: `. So the user sees, e.g.:

```
Invalid /home/u/.config/tentacle/config.jsonc: subagents.types.explore.model: "fsat" is not a models entry (defined: claude, fast)
Invalid /home/u/.config/tentacle/config.jsonc: profiles.offline: subagents.types.explore.model: "local" is not a models entry (defined: claude, fast)
Invalid /home/u/.config/tentacle/config.jsonc: subagents.selectableModels: "gpt" is not a models entry (no models defined)
```
A base that references a name only a profile defines is a base error (launching without the
profile would use it). The same check runs in `config set` (whole-file validation), so a
`tentacle config subagents.types.explore.model fsat` is refused before it is written.

#### A3. Profile merge (`profile.ts`)

- `models`: merged by name; a profile's entry REPLACES the base entry whole (Q5). Never a
  per-key merge, so a base entry's key can never pair with a profile's `baseURL`.
- `subagents.types`: merged by type name; a profile's type block replaces the base one whole.
  (`subagents.selectableModels` is an ordinary `subagents` key: the profile's list replaces
  the base list, which the existing per-key `subagents` merge already does.)
- Destructure `models` next to `model` in `applyProfile` (`profile.ts:61-72`); in the
  `subagents` branch (`:86-100`) set `types: { ...base.subagents?.types, ...subagents.types }`
  when either has `types`. Update the header comment (`:6-10`).

#### A4. Resolution (`resolveModelEntry`, pure, `models.ts`; called from `resolve.ts`)

An entry resolves over the main model's **effective** values (after the profile, env and
`--model`; Q2):

```ts
export interface ResolvedModel {
  readonly provider: "openai" | "anthropic";
  readonly baseURL: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens?: number;
  readonly description?: string;            // [B]
  /** Where the key comes from — never the key. `inherited` = the main model's (same endpoint). */
  readonly apiKeySource: "inherited" | "file" | "command" | "none";
  /** The entry's OWN command (never inherited); for the mount hide and load.ts. */
  readonly apiKeyCommand?: string;
  /** The key: own literal, or (after load) the command's output or the inherited main key. */
  readonly apiKey?: string;
}
```
Rules (`CONNECTION_KEYS` exported from `profile.ts:19` and reused — one definition):
1. **The entry sets no connection key** → `provider`, `baseURL` = the main's resolved
   values; `apiKeySource: "inherited"`; `apiKey` = the main's resolved literal key (env or
   file) when it has one. A main key from a command is filled in by `load.ts` (A5).
2. **The entry sets any connection key** → NOTHING of the connection group is inherited:
   `provider = entry.provider ?? DEFAULT_PROVIDER`;
   `baseURL = entry.baseURL ?? (provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL)`;
   key = `entry.apiKey` (`file`) › `entry.apiKeyCommand` (`command`) › none (`none`).
   `TENTACLE_MODEL_API_KEY` never reaches such an entry.
3. `model = entry.model ?? main.model`; `contextWindow = entry.contextWindow ?? main.contextWindow`;
   `maxTokens = entry.maxTokens ?? main.maxTokens`; `description = entry.description`.

`ResolvedConfig` (`resolve.ts:64-185`) gains, beside the `subagent*` fields:
- `models: Readonly<Record<string, ResolvedModel>>` (empty object when unset),
- `subagentModels: Readonly<Record<string, string>>` — type → entry name, from
  `subagents.types.*.model` (types without `model` omitted),
- **[B]** `selectableModels: readonly string[]` — `subagents.selectableModels`, de-duplicated
  in order, `[]` when unset.
No `sources` entries: these keys have no env form (no change to T3).

#### A5. Keys (`load.ts`)

After the main key block (`load.ts:634-640`), and only when `options.podDaemon !== true`:
- Collect the entries with `apiKeySource === "command"`. Run each DISTINCT command string
  once, all in parallel (`Promise.all`), with the same `runCommand`. If the main model's
  command is the same string, reuse its output (no second run).
- A run that throws a `ConfigError` is rethrown as `new ConfigError(\`models.${name}.${error.message}\`)`
  — e.g. `models.claude.apiKeyCommand exited with code 1: gpg: decryption failed` (stderr
  only, never stdout: the runner's existing contract, `load.ts:468-472`). Name the first
  entry (sorted) that uses the failing command.
- An empty trimmed output → `ConfigError(\`models.${name}.apiKeyCommand produced an empty key\`)`.
- `inherited` entries get the main's FINAL key (`apiKey` after `:635-639`).
- With `podDaemon`, no entry command runs and command-keyed entries keep no `apiKey` (they
  are never used over the tunnel).

Why at startup, not lazily (Q4): a key command may prompt (gpg pinentry, a password
manager); at load it runs before Ink owns the terminal, as the main one does (AGENTS §7,
"never write raw to the terminal while Ink owns it"). Lazily, the prompt would land in the
middle of a TUI session.

`TentacleConfig` (`load.ts:119-…`) gains `models`, `subagentModels` and **[B]**
`selectableModels`, copied from `resolved` (with the keys filled in). `TentacleConfig` already
travels to the worker by structured clone, as `apiKey` does today; nothing new is serialized
elsewhere.

#### A6. Registry (`key-docs.ts`) and README

New `FILE_KEYS` entries, in schema order (`models` block right after `model.maxTokens`; the
`subagents.types*` / `selectableModels` entries after `subagents.agentTaskDescriptionFile`).
All `scope: "both"`, `carried: "no"`, no `default`/`env`/`sourceKey`/`resolved`. The
`profiles.*.…` mirror is derived (`key-docs.ts:917-944`); do not hand-write it.

| path | kind/type | secret | summary (exact) |
|---|---|---|---|
| `models` | section, `map` | — | Named models for sub-agents: each has the keys of `model`; unset keys come from `model`. |
| `models.*` | section | — | One named model, referenced by its name. |
| `models.*.provider` | leaf `enum` (`openai`,`anthropic`) | — | The API flavour; setting it (or any connection key) inherits no endpoint or key from `model`. |
| `models.*.baseURL` | leaf `string` | — | The endpoint; unset with no other connection key: `model`'s. |
| `models.*.model` | leaf `string` | — | The model id sent to the endpoint; unset: `model`'s. |
| `models.*.apiKey` | leaf `string` | `true` | A literal API key for this entry — stored in plaintext (prefer `apiKeyCommand`). |
| `models.*.apiKeyCommand` | leaf `string` | `true` | A shell command whose stdout is this entry's key; run at startup. |
| `models.*.contextWindow` | leaf `integer` | — | This model's context window in tokens; unset: `model`'s. |
| `models.*.maxTokens` | leaf `integer` | — | Max output tokens per response; unset: `model`'s. |
| `models.*.description` **[B]** | leaf `string` | — | When to pick this model — shown to the agent when it is selectable. |
| `subagents.types` | section, `map` | — | Per sub-agent type settings, keyed by type name. |
| `subagents.types.*` | section | — | One sub-agent type's settings (`general`, `explore`, or an `agents/*.md` name). |
| `subagents.types.*.model` | leaf `string` | — | The `models` entry this type runs on (beats the type's `agents/*.md` `model`). |
| `subagents.selectableModels` **[B]** | leaf `array` | — | `models` entries the agent may pick per `agent_task` call; absent or empty: off. |

`details` (exact text):
- `models`: "Each entry has the keys of `model`, except `autoTitle`/`titleModel`. An unset key takes the main model's EFFECTIVE value (after the profile, env and `--model`). The connection group moves as a unit, as in a profile: an entry that sets any of provider/baseURL/apiKey/apiKeyCommand inherits none of them, so the main key is never sent to another endpoint — repeat the key (or its command) if the endpoint needs one. Key commands run at startup, before the TUI. In a profile, entries merge by name and a profile's entry replaces the base one whole. On `run`/`attach` they are not applied yet (sub-agents use the laptop's main model) and never carried: the keys stay on the laptop."
- `models.*`: "`models.<name>` — a name holds letters, digits, `_` and `-` (at most 64). Used by `subagents.types.<type>.model`, `subagents.selectableModels` and an `agents/*.md` `model` (a `models` name first, else a model id on the main endpoint)."
- `models.*.apiKey`: "Any copy of this file exposes the key. Not inherited by an entry with its own endpoint; `TENTACLE_MODEL_API_KEY` applies to `model` only."
- `models.*.apiKeyCommand`: "Runs once at startup (an identical command runs once for all entries), its output is trimmed and never written. Treat it as a secret: a command line can embed one."
- `models.*.description` [B]: "Listed in the `agent_task` description when the entry is in `subagents.selectableModels`. Sent to the model: never put a secret here. At most 300 characters."
- `subagents.types.*.model`: "Must name a `models` entry, or the config is refused. Precedence for a sub-agent's model: the `agent_task` call's `model` (when selectable), this key, the type's `agents/*.md` `model`, then `model`. On `run`/`attach` not applied yet: sub-agents use the laptop's main model."
- `subagents.selectableModels` [B]: "Each name must be a `models` entry. When set, `agent_task` takes an optional `model` argument limited to these names and its description lists them with their `description`. On `run`/`attach` not applied yet."

Examples: `models.*.apiKey` → `'"sk-…"'` (a placeholder: T7); `models.*.apiKeyCommand` →
`'"pass show anthropic"'`; `models.*.model` → `'"qwen3-4b"'`; `models.*.baseURL` →
`'"http://localhost:8081/v1"'`; `models.*.provider` → `'"anthropic"'`;
`models.*.contextWindow` → `"32768"`; `models.*.maxTokens` → `"8192"`;
`models.*.description` → `'"Small and quick: file searches, summaries."'`;
`subagents.types.*.model` → `'"fast"'`; `subagents.selectableModels` → `'["fast", "claude"]'`.

Also update the `profiles` `details` (`key-docs.ts:906-907`): after "`mcpServers` merge by
name, …" add "`models` and `subagents.types` merge by name, a profile's entry replacing the
base one whole".

Then run `bun run docs:config` (README table) — never hand-edit the block.

UX that follows with no CLI code:
- `tentacle explain models` → the `models` summary and details, then its direct children
  (`models.*.provider` … `models.*.description`, one line each — the existing renderer,
  `directChildren` makes the `*` transparent). `tentacle explain models.*.apiKey` (or
  `models.claude.apiKey`) → the card with `secret  yes — never printed (masked as ***)`.
- `tentacle config list` →
  ```
  models.fast.model = "qwen3-4b"
  models.claude.provider = "anthropic"
  models.claude.apiKeyCommand = ***
  subagents.types.explore.model = "fast"
  profiles.offline.models.claude.model = "qwen3-27b"
  ```
- `tentacle config models.claude.apiKey sk-x` → refused (argv secret), the prompt/stdin
  hints. One CLI touch (A10): the "better:" hint names the sibling command
  (`models.claude.apiKeyCommand`) instead of `model.apiKeyCommand`.

#### A7. The pick (`pickSubagentModel`, pure, `models.ts`)

```ts
export type ModelChoice =
  | { readonly kind: "default" }
  | { readonly kind: "entry"; readonly name: string; readonly contextWindow: number }
  | { readonly kind: "id"; readonly id: string; readonly contextWindow?: number };

export function pickSubagentModel(
  input: {
    readonly requested?: string;        // [B] the call's `model`
    readonly typeName: string;
    readonly frontmatterModel?: string; // AgentType.model
    readonly frontmatterWindow?: number;// AgentType.contextWindow
  },
  config: {
    readonly models: Readonly<Record<string, ResolvedModel>>;
    readonly subagentModels: Readonly<Record<string, string>>;
    readonly selectableModels: readonly string[]; // [] when part B is not built
  },
): ModelChoice;
```
First match wins (use `Object.hasOwn` for every map lookup):
1. [B] `requested` is in `selectableModels` and in `models` → `entry(requested, window = models[requested].contextWindow)`. (A `requested` that fails this is ignored here; the tool already refused it — B2.)
2. `subagentModels[typeName]` is in `models` → `entry(name, window = entry.contextWindow)`.
   The frontmatter `contextWindow` is NOT used: it describes the frontmatter's model.
3. `frontmatterModel` is in `models` → `entry(name, window = frontmatterWindow ?? entry.contextWindow)`.
4. `frontmatterModel` set → `id(frontmatterModel, contextWindow = frontmatterWindow)` (today's meaning).
5. → `default` (the runner keeps today's behaviour: the parent's model, the type's
   `contextWindow` if any, else the parent's window).

#### A8. Agent + wiring

`packages/agent/src/subagent.ts`:
```ts
/** The child's model, chosen by the wiring; absent → the parent's model. */
export interface SubagentModel {
  readonly provider: ModelProvider;
  /** The window the child counts against; absent → the parent's. */
  readonly contextWindow?: number;
  /** The model id for the child's hooks (`model` in a hook payload). */
  readonly modelId?: string;
}
// SubagentDeps.modelFor becomes:
readonly modelFor?: (type: AgentType, requested: string | undefined) => SubagentModel | undefined;
// SubagentRunOptions gains:
readonly model?: string; // [B] the call's requested `models` name, unchecked here
```
In `run` (`:228-233`): `const chosen = deps.modelFor?.(type, opts.model);`
`const model = chosen?.provider ?? deps.model;`
`const window = chosen !== undefined ? chosen.contextWindow : type.contextWindow;`
`contextAwareness = deps.contextAwareness && window !== undefined ? { ...deps.contextAwareness, window } : deps.contextAwareness;`
hooks (`:266-269`): `deps.hooks.forAgent({…}, chosen?.modelId ?? type.model)`. Update the
`AgentType.model` doc comment (`:36`): "a `models` name or a model id; resolved by `SubagentDeps.modelFor`".

`packages/cli/src/model-provider.ts` (keep `configuredModelProvider` as is for the main and
title models):
```ts
export type ProviderFactory = typeof createModelProvider;
/** The providers of one agent's sub-agents, built lazily and once each. */
export interface ModelProviders {
  forEntry(name: string): ModelProvider;   // throws on an unknown name (cannot happen: validated)
  forId(modelId: string): ModelProvider;   // a model id on the MAIN endpoint with the MAIN key
}
export function createModelProviders(
  config: Pick<TentacleConfig, "provider" | "baseURL" | "apiKey" | "maxTokens" | "configDir" | "models">,
  create: ProviderFactory = createModelProvider,
): ModelProviders;
/** `SubagentDeps.modelFor` for this config: `pickSubagentModel` mapped to providers. */
export function subagentModelResolver(
  config: Pick<TentacleConfig, "models" | "subagentModels" | "selectableModels">,
  providers: ModelProviders,
): (type: AgentType, requested: string | undefined) => SubagentModel | undefined;
```
`forEntry(name)` calls `create({ provider, baseURL, model, ...(apiKey ? { apiKey } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), onRetry: (info) => logModelRetry(config.configDir, info) })`
from the ENTRY's resolved fields only — never `config.apiKey`. Mapping in the resolver:
`default` → `undefined`; `id` → `{ provider: forId(id), modelId: id, ...(window) }`;
`entry` → `{ provider: forEntry(name), contextWindow, modelId: models[name].model }`.

`packages/cli/src/wiring.ts` (`:473-501`):
- `BuildAgentOptions` gains `readonly createProvider?: ProviderFactory` (test seam; doc:
  "Tests inject a spy; default `createModelProvider`").
- Without `modelOverride`: `modelFor: subagentModelResolver(config, createModelProviders(config, options.createProvider))`.
- With `modelOverride` (a pod): `modelFor` is OMITTED (every child = the tunnel, as today;
  a type's frontmatter window still applies, as today), and [B] the task tool gets no
  `models` (B1). If `Object.keys(config.subagentModels).length > 0` [B: `|| config.selectableModels.length > 0`],
  call `options.notice?.("models: per-type sub-agent models are ignored over the model tunnel; sub-agents use the laptop's main model")`
  once per `buildAgent` (the pod daemon's log — the pod's OWN config).

#### A9. Pods (task 3 only) and startup notices (`main.ts`, `models.ts`)

Pure helpers in `models.ts` (pattern: `titleConfigNotice`, `resolve.ts:594-603`):
- `modelsPodNotice(config: { subagentModels; selectableModels }): string | null` →
  `"subagents.types / subagents.selectableModels are not applied on run/attach yet (feat/models-map-pod): every sub-agent uses the laptop's main model"`
  when either is non-empty, else `null`.
- `unknownTypeModelWarnings(subagentModels, knownTypes: readonly string[]): string[]` → for
  each configured type not in `knownTypes`:
  `subagents.types.<type>: no sub-agent type "<type>" (known: <knownTypes joined ", ">) — its model is not used`.

In `main.ts`:
- In the non-pod branch (`main.ts:816-821`), after the `[agents]` diagnostics: for each line of
  `unknownTypeModelWarnings(config.subagentModels, mergeAgentTypes(BUILTIN_AGENT_TYPES, agentTypes.types).map((t) => t.name))`
  → `err(\`[agents] ${line}\n\`)`.
- In the pod branch (`main.ts:822-827`, `mode === "run" || "attach"`): print
  `[models] <modelsPodNotice>` when non-null (pre-Ink, like the `[packages]` line). This is
  the LAPTOP config the user wrote; the pod daemon's own notice (A8) covers the pod's config.

What task 3 does in a pod run, exactly: the laptop loads `models` (runs its key commands on
the laptop, A5), carries NOTHING of it (A6 `carried: "no"`), prints the `[models]` notice,
and serves the pod's `model/stream` with its main model as today. The pod daemon loads its
own config with `podDaemon: true` (no entry key command runs), and its `modelOverride`
makes every sub-agent use the tunnel. No key, `baseURL` or entry name leaves the laptop.

**Workspace mount (docker/podman `run`) — a key-file leak to close in this task.** The mount
hides the main key FILE (`workspace-mount.ts:76-90`); an entry's `apiKeyCommand` file inside
the workspace would otherwise be readable by the untrusted container. Change:
- `hideList(mount, apiKeyCommands: readonly string[])` — every command's key file is hidden
  (`always: true`, label `"the API key file"`), de-duplicated by path.
- `apiKeyFileUnknown(apiKeyCommands: readonly string[])` → `true` when ANY command's file
  cannot be derived.
- `keyCommandsOf(config: Pick<TentacleConfig, "apiKeyCommand" | "models">): string[]` → the
  main command plus every entry's own `apiKeyCommand`, defined ones, de-duplicated.
- Call sites: `main.ts:1150-1151` pass `keyCommandsOf(config)`; fix the doc comments at
  `engine-select.ts:322-324`.

#### A10. `config set` hint (`config-run.ts:229-231`)

`const command = leaf.endsWith(".apiKey") ? \`${leaf}Command\` : "model.apiKeyCommand";` and
use it in the "better:" line (both the `tentacle config <command> "pass show tentacle"` and
the `tentacle explain <command>`). Only for a leaf whose canonical path ends `apiKey`
(`model.apiKey`, `models.*.apiKey`, their `profiles.*` mirrors); others keep today's text.

#### B. Agent-selectable models [B]

B1. `packages/tools/src/task.ts`:
```ts
export interface TaskModelOption { readonly name: string; readonly description?: string }
// TaskToolOptions gains:
/** `subagents.selectableModels` with their descriptions; absent or empty → no `model` argument. */
readonly models?: readonly TaskModelOption[];
// TaskRunner opts gains `model?: string`.
```
- `taskToolDescription(custom, mode, typeList, modelList?: string)`: unchanged output when
  `modelList` is absent or empty (byte-identical to today: a test pins it). Else append:
  ```
  \n\nAvailable models (optional `model` argument; omit it to use the sub-agent type's own model):\n<modelList>
  ```
  `modelList` = one line per option: `- <name>: <description with every run of whitespace collapsed to one space>`,
  or `- <name>` with no description. The custom description (`agentTaskDescription`) replaces
  only the leading text, as for the type list.
- `inputSchema`: when `models` is non-empty, add
  `model: z.string().optional().describe(\`Which model runs the sub-agent: one of ${names.join(", ")}. Omit it for the type's own model.\`)`.
  When empty, the schema is exactly today's (a stray `model` is stripped like any unknown
  argument: the agent was never told the argument exists, and no key is involved).
- `execute`: if `args.model !== undefined` and not in the names → return
  `{ content: \`unknown model ${JSON.stringify(args.model.slice(0, 64))} for agent_task — use one of: ${names.join(", ")}, or omit model\`, isError: true }`
  and do NOT call `run`. Else pass `model: args.model` in the run opts (omit when undefined).

Example description (the config of A1, default text, `parallel` mode):
```
Delegate a self-contained task to a sub-agent … overlap. (unchanged)

Available sub-agent types:
- general: General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.
- explore: Read-only investigator: searches and reads files to answer a question. Cannot modify anything.

Available models (optional `model` argument; omit it to use the sub-agent type's own model):
- fast: Small and quick: file searches, summaries, simple edits.
- claude: Strong reasoning: hard bugs, design questions, multi-file refactors.
```

B2. `wiring.ts`: `createTaskTool(…, { …, models: options.modelOverride ? [] : config.selectableModels.map((name) => { const d = config.models[name]?.description; return d !== undefined ? { name, description: d } : { name }; }) })`.

#### C. Per-endpoint slot sizing — split out to `feat/models-map-slots` (outline, not built here)

Why split: it changes the agent loop's round scheduling (`agent.ts:1246-1251` cap,
`runGroup`'s `nextRunnable` loop `agent.ts:1488-1515`, `round-plan.ts:257-272`) and the core
`Tool` interface — load-bearing by AGENTS §10, so a strong model executes it with a
fresh-context Review; parts A/B do not touch the loop.

Outline (its own doc re-verifies): a spawn's pool = its endpoint (normalized resolved
`baseURL`; the main endpoint is the default pool). The task tool exposes
`spawnPool?(input) → { key, slots?(signal) } | undefined` (undefined = the main pool, whose
slots are today's `subagentExecution.slots`). In a fan-out round, the distinct pools' slots
are read once each (`slotsBounded`, in parallel). One pool → exactly today's cap
`effectiveAgentCap(maxParallel, slots)`. Several → the round's cap is `maxParallel` and
`nextRunnable` gains per-pool caps (an item runs only while fewer than its pool's slots of
the same pool run). The slots notice names the entry, never the URL (a `baseURL` may hold
userinfo). No reservation (owner Q14 = b). Background children are 6c.

**Until C lands (interim, documented in the key docs):** a fan-out's cap is
`min(maxParallel, slots of the MAIN endpoint)` for every spawn, whatever its endpoint. A
child on a smaller llama.cpp server may queue on that server (slow, correct); a child on a
hosted API may be held to the main server's slots (under-used, correct).

### Files

In dependency order (config → agent → tools → cli → docs). [B] = part B only.

1. `packages/config/src/schema.ts` — `MODEL_NAME`, `ModelEntrySchema` (+`description` [B]), `models`, `subagents.types`, `subagents.selectableModels` [B], the `FileConfigSchema.superRefine`.
2. `packages/config/src/profile.ts` — export `CONNECTION_KEYS`; merge `models` and `subagents.types` by name; header comment.
3. `packages/config/src/models.ts` (new) — `ResolvedModel`, `resolveModelEntry`, `modelRefIssues`, `ModelChoice`, `pickSubagentModel`, `modelsPodNotice`, `unknownTypeModelWarnings`.
4. `packages/config/src/index.ts` — `export * from "./models.ts";`.
5. `packages/config/src/resolve.ts` — `ResolvedConfig.models/subagentModels/selectableModels` [B]; build them in `resolveConfig`.
6. `packages/config/src/load.ts` — entry key commands (A5); `TentacleConfig` fields.
7. `packages/config/src/key-docs.ts` — the A6 entries + `profiles` details; then `bun run docs:config` → `README.md` block.
8. `packages/agent/src/subagent.ts` — `SubagentModel`, `modelFor(type, requested)`, `SubagentRunOptions.model` [B], window + hooks.
9. `packages/tools/src/task.ts` [B] — `models` option, description, schema, refusal, pass-through. (Part A alone: no change here.)
10. `packages/cli/src/model-provider.ts` — `ProviderFactory`, `createModelProviders`, `subagentModelResolver`.
11. `packages/cli/src/wiring.ts` — `createProvider` seam, `modelFor`, pod notice, [B] task-tool `models`.
12. `packages/cli/src/workspace-mount.ts` — `hideList`/`apiKeyFileUnknown` take a command list; `keyCommandsOf`.
13. `packages/cli/src/main.ts` — call sites `:1150-1151`; `[agents]` warnings and `[models]` notice `:816-827`.
14. `packages/cli/src/engine-select.ts` — doc comments `:322-324` only.
15. `packages/cli/src/config-run.ts` — the A10 hint.
16. Docs: `docs/feat/config-profiles.md` (merge rules: one line for `models` / `subagents.types`); this doc's Execution.

Callers of a changed signature to update (rg before editing): `hideList(`, `apiKeyFileUnknown(`,
`modelFor:` (agent tests), `taskToolDescription(`, `createTaskTool(` (tests). No other
production caller exists (`rg` verified for `hideList`/`apiKeyFileUnknown`: `main.ts` only).

### Failure modes

| # | Case | What happens / how it converges |
|---|---|---|
| F1 | Unknown name in `subagents.types.<t>.model` / `selectableModels` (base or a profile) | Config refused at load and at `config set` (A2 texts). Nothing starts on a half-valid config. |
| F2 | `subagents.types.<t>` for a type that does not exist | Not an error (agent types load later, from `agents/` and packages): a pre-Ink `[agents]` warning (A9). On `run`/`attach` no warning (the pod's types are not the laptop's). |
| F3 | Frontmatter `model` is a typo of a `models` name | Read as a model id on the main endpoint (owner Q4); the server answers "model not found", the child ends in `error`, its result says so. Documented in `models.*` details. |
| F4 | Agent passes `model` not in the list [B] | Error result, `run` never called (B1). Off (no list): the argument is not advertised and is stripped by zod (`registry.ts:86-96`). |
| F5 | Main key sent to another endpoint | Impossible by rule A4.2 (connection unit); pinned by a test with env `TENTACLE_MODEL_API_KEY`, a file `apiKey` and a main `apiKeyCommand`. An entry re-stating the SAME `baseURL` without a key gets no key (documented: repeat the key or its command). |
| F6 | An entry's key printed | Error texts carry paths and exit codes only; `config list/get` mask by registry; `explain` reads only the registry; the tool description shows names + descriptions; the slots notice (C) names the entry. Tests assert the key string is absent from every error and from `carriedSettings(config)`. |
| F7 | A secret on argv | `config set models.x.apiKey …` refused (registry, `isArgvRefusedSecret`); `apiKeyCommand` on argv stays allowed (the documented safe form). We spawn no child with a key on argv: providers get the key in memory; the key command runs via `/bin/sh -c` exactly as the main one (existing). |
| F8 | Entry key command fails / prints nothing | `ConfigError` naming `models.<name>.apiKeyCommand` (A5), before Ink. Identical commands run once, so one failure is one message. |
| F9 | Entry key command prompts (pinentry) | Runs at load, before Ink (Q4) — never mid-session. |
| F10 | Pod `run`/`attach` with `models` configured | Laptop `[models]` notice; not carried; every child uses the tunnel (main model). Pod daemon: no entry command runs (`podDaemon`), its own types ignored + a daemon-log notice. No key leaves the laptop. |
| F11 | docker/podman workspace mount with an entry key file inside the workspace | Hidden like the main key file (A9); an opaque command (`pass show …`) flips `apiKeyFileUnknown`, so the plan's existing warning shows. |
| F12 | `--profile` | Everything resolves after `applyProfile`: inherited entries follow the PROFILE's main endpoint and key; a profile's entry replaces the base one whole (Q5), so a base key never pairs with a profile URL. Each profile is reference-checked at parse time (A2), so a broken profile is refused even when not selected — the same rule as any invalid key in a profile today. |
| F13 | A `models` entry with its own `apiKey` inside a profile | Valid; masked as `profiles.<p>.models.<n>.apiKey = ***` (mirror, A6); refused on argv; replaces the base entry whole; never carried. |
| F14 | `--model` / `TENTACLE_MODEL` / `TENTACLE_MODEL_BASE_URL` | Change the main model; entries that do not set the field inherit the effective value (Q2). `TENTACLE_MODEL_API_KEY` reaches only inheriting entries (same endpoint). |
| F15 | Version skew | Wire: none (no schema, no update, no method; `PROTOCOL_VERSION` stays 17; the name never travels in task 3). Disk: no persisted format (a choice is not persisted; a resume re-resolves from the current config; an old `agent_task` call with `model` in history is history only). Config: an older build refuses a file with `models` loudly (`Unrecognized key(s) in object: 'models'`) — pre-public, fine. Laptop ↔ pod of different builds: unaffected (nothing carried). |
| F16 | Settings sync rebuilds the agent | `buildAgent` rebuilds providers from the same `TentacleConfig` (lazy, cheap); no state to carry. |
| F17 | Same command string for main and an entry | Run once (A5); both get the output. Entry inherits nothing else. |
| F18 | Empty `models` / `types` / `selectableModels` | Same as unset: no `model` argument, no list, unchanged description (pinned byte-identical). |
| F19 | Name with `.` or longer than 64 | Schema refusal with `MODEL_NAME_MESSAGE`. |
| F20 | `autoTitle`/`titleModel` inside an entry (Q3 = a) | `Unrecognized key(s) in object: 'autoTitle'` — titles stay a `model` setting. |

### Tests

Run narrow files while iterating (AGENTS §4); full gate at the end. Every new test is first
shown RED on the unchanged code (most are red simply because the schema refuses the keys or
the export does not exist — that IS the red for a feature; record the failing line), then
GREEN. Mutation checks are listed where a test could pass vacuously.

0. **Probe first** (`.tentacle/tmp/models-map/probe.ts`, paste output into Execution): run the
   Repro; then confirm `ModelConfigSchema.omit({autoTitle:true,titleModel:true}).extend({description: z.string().optional()})`
   still refuses an unknown key (`_def.unknownKeys === "strict"`) and that a record keyed by
   `z.string().regex(MODEL_NAME)` refuses `"a.b"`. If either fails, STOP and update this plan.
1. `packages/config/test/models.test.ts` (new):
   - `resolveModelEntry`: `{}` → every field = main's, `apiKeySource: "inherited"`, main literal key copied; `{ model: "x" }` → main endpoint + key, id `x`; `{ baseURL }` → provider `openai`, NO key even when main has env/file/command keys (the F5 pin); `{ provider: "anthropic" }` → anthropic default URL, no key; own `apiKey` → `file`; own `apiKeyCommand` → `command`, no `apiKey`; `contextWindow`/`maxTokens`/`model` inheritance; `description` not inherited. **Mutation:** drop the connection-unit branch → the `{ baseURL }` test must fail.
   - `modelRefIssues`: unknown type ref (exact text, `defined:` sorted); `no models defined`; unknown selectable [B]; a profile-only issue prefixed `profiles.<p>: `; a base issue reported ONCE (not per profile); a base ref defined only in a profile → base issue; a type block without `model` → no issue.
   - `pickSubagentModel`: each precedence step beats the next (call › type › frontmatter name › frontmatter id › default) [call = B]; windows per A7 (type entry ignores frontmatter window; frontmatter name uses it); a `requested` not in the list is ignored; `Object.hasOwn` — a type named `constructor` / `__proto__` does not crash or match.
   - `modelsPodNotice`, `unknownTypeModelWarnings`: exact texts, `null`/`[]` when empty.
2. `packages/config/test/subagent-keys.test.ts` (extend) or a new `models-schema.test.ts`: names (`a.b`, `""`, 65 chars refused; `fast_2-x` ok); entry strict (`{ foo: 1 }` refused; `autoTitle` refused per Q3); `description` > 300 refused [B]; `subagents.types.x` strict (`{ model: "a", foo: 1 }` refused); config-level error message through `FileConfigSchema.safeParse` equals the A2 text.
3. `packages/config/test/profile.test.ts`: `models` whole-entry replace (a base entry's `apiKey` absent after a profile entry with only `baseURL`); `subagents.types` merged by name; `selectableModels` replaced [B].
4. `packages/config/test/load.test.ts`: a spy `runCommand` — distinct commands run once each (a command shared by two entries and the main runs ONCE); with `podDaemon: true` no entry command runs; failure text `models.claude.apiKeyCommand exited with code 1: …`; empty → `models.claude.apiKeyCommand produced an empty key`; an inherited entry gets the main command's output; the key string (`"s3cret-entry"`) appears in NO thrown message.
5. `packages/config/test/key-docs.test.ts`: T1 goes red on the schema change alone (proves the registry gate) and green with A6; extend T7's first test with `models.*.apiKey`, `models.*.apiKeyCommand` (`true`). `readme-config-table.test.ts` red until `bun run docs:config`.
6. `packages/config/test/config-value.test.ts`: `renderStored`/`maskStored` mask `models.claude.apiKey` and `profiles.p.models.claude.apiKeyCommand` as `***`; `isArgvRefusedSecret("models.claude.apiKey") === true`, `("models.claude.apiKeyCommand") === false`. **Mutation:** remove `secret: true` from `models.*.apiKey` → must fail.
7. `packages/agent/test/subagent.test.ts`: migrate `:253` to `modelFor(type, requested)`; new: `opts.model` reaches `modelFor` [B]; a returned `contextWindow` is the child's window; `modelFor` returning `undefined` → parent model + the type's own `contextWindow` (today's behaviour, pinned); hooks get `chosen.modelId`.
8. `packages/tools/test/task.test.ts` [B]: no `models` → description and JSON schema byte-identical to today (capture today's string first: this is the red-before-green guard against drift); with models → the exact B1 text, collapsed whitespace, a no-description line; unlisted `model` → `isError`, runner spy NOT called; listed → runner gets `model`; custom description + both lists.
9. `packages/cli/test/model-provider.test.ts`: `createModelProviders` with a spy factory — an entry's own `baseURL`/key reach `create`, the main key never does for an own-endpoint entry; one `create` per name (cache); `forId` = main endpoint + main key + the id; `subagentModelResolver` maps the three choice kinds.
10. `packages/cli/test/wiring.test.ts`: with `createProvider` spy and `subagentModels: { explore: "fast" }`, running an `explore` child streams from the `fast` provider (ScriptedModel per provider); with `modelOverride`, the same config uses the override for every child, the `agent_task` description has no models section [B], and `notice` got the A8 line once. **Mutation:** give `modelFor` to the pod path → this test must fail.
11. `packages/cli/test/workspace-mount.test.ts`: an entry key file inside the workspace is in `hideList` (`always: true`); `apiKeyFileUnknown([main, "pass show x"]) === true`; `keyCommandsOf` de-duplicates.
12. `packages/cli/test/carried-settings.test.ts`: `JSON.stringify(carriedSettings(config))` with a `models` entry holding `apiKey: "s3cret-entry"` and `baseURL: "http://only-laptop:9/v1"` contains neither string.
13. `packages/cli/test/config-run.test.ts` (wherever `secretOnArgv` is tested): the hint for `models.claude.apiKey` names `models.claude.apiKeyCommand`; for `model.apiKey` it is unchanged.

Gate before "done": `bun test` (baseline: all pass except the three opt-in skips),
`bun run typecheck`, `bun run lint` (baseline clean) — AGENTS §6.

### Proposed split and TODO lines

| # | Task | Size | Blast | Executor / Review |
|---|---|---|---|---|
| 3 | `feat/models-map` — part A (+ part B if Q1 = b) | M | cross-module | DeepSeek; fresh-context Review red-teaming secrets (F5–F7, F10–F13) |
| 3b | `feat/models-select` — part B (only if Q1 = a) | S | contained | a weaker model; in-context Review |
| 3c | `feat/models-map-slots` — part C | S–M | load-bearing | strong model; fresh-context Review of the round scheduler |

Order: 3 → (3b) → 3c → 4. 3c needs 3's resolved endpoints; task 4 (pod) needs 3; 6c
(session limiter) needs 3c's pools. Proposed `TODO.md` line for 3c (to add on `main` with the
owner's OK, docs carve-out): `- [ ] **feat/models-map-slots** (task 3c, split from feat/models-map): per-endpoint slot sizing for foreground fan-outs (pools keyed by endpoint; one pool = today's cap). Type: feat · Size: S–M · Blast: load-bearing.`

### Owner questions

**Q1. Split.** (a) Three branches: A here, B as `feat/models-select`, C as
`feat/models-map-slots`; (b) A+B here, C split out; (c) A+B+C here (L, load-bearing — a strong
model must execute it all). **Recommend (b).** B adds one key, one field and ~40 lines in
`task.ts`, all pinned by its own tests; it rides A's resolution, and you assigned it to task 3
"unless it grows past M" — A+B is still M. C is the only load-bearing part, so splitting it
keeps this branch executable by DeepSeek.

**Q2. What an entry inherits from.** (a) The main model's EFFECTIVE values (after the
profile, env and `--model`); (b) only the file's `model` block (env and `--model` affect the
agent only). **Recommend (a).** One rule ("unset = what the agent uses"), and the key always
follows its endpoint: with (b), `TENTACLE_MODEL_BASE_URL` would move the agent but leave
inheriting entries on the file's endpoint, with a key resolved for the other one.

**Q3. `autoTitle` / `titleModel` inside an entry.** (a) Refused (the entry schema omits them;
titles stay a `model` setting); (b) accepted and ignored (literally "the same shape").
**Recommend (a).** The schema is strict so a key that does nothing is an error, not silence.

**Q4. When an entry's `apiKeyCommand` runs.** (a) At startup, every entry, identical
commands once, in parallel, before the TUI (like the main key); (b) lazily, at the entry's
first use. **Recommend (a).** (b) avoids a run for unused entries, but a prompting command
(gpg pinentry, a password manager CLI) would then write into the terminal while Ink owns it
(AGENTS §7), and a failure would surface as a sub-agent error mid-turn instead of a clear
startup error.

**Q5. A profile's `models` entry.** (a) Replaces the base entry whole (like an MCP server);
(b) merges per key with the connection group as a unit (like `model`). **Recommend (a).**
Simplest rule, and no way to pair a base key with a profile endpoint. Cost: a profile that
only wants a different `contextWindow` restates the entry.

## Execution

*— (executor), (date)*

## Review

*— (reviewer), (date)*
