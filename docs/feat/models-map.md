# feat/models-map — named `models`, per-type sub-agent models, agent-selectable models

> **Status:** execution done (A + B + the slots-cap removal, one branch); fresh-context Review pending
> **Branch:** `feat/models-map`
> **Size:** M–L · **Blast:** load-bearing (a protocol method removed + `PROTOCOL_VERSION` 18; the agent loop's fan-out cap; secrets routing) · **Suited:** strong model executes (claude-opus-5-5, owner 2026-11-08); **mandatory fresh-context Review** red-teaming: key routing (a key never reaches another endpoint or a pod), masking, the workspace-mount hide list, the removed `model/slots` on both ends, the cap = `maxParallel`.

Type: feat · Size: M–L · Blast: load-bearing · Suited: strong model + mandatory fresh-context Review

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
- ~~Per-endpoint slot SIZING for foreground rounds belongs to task 3~~ — **superseded by the
  owner on 2026-11-08** (see *Owner answers*): tentacle sizes nothing by server slots; the only
  sub-agent concurrency limit is the user's `subagents.maxParallel`, and the existing slots cap
  is removed in this task. NO slot reservation for the agent (owner Q14 = b) still holds.
- Local/`serve` only. Pod runs are task 4 (`feat/models-map-pod`, the name on
  `model/stream`, the laptop allowlist, a `PROTOCOL_VERSION` bump).

**Constraints.** The config CLI and registry merged this week: every schema key must be
documented in `packages/config/src/key-docs.ts` (T1 fails otherwise) with its secret flag;
masking in `config list/get` and the argv refusal in `config set` are driven by those flags
(`packages/config/src/config-value.ts:134-151,163-175`). The README config table is
generated (`bun run docs:config`, gate `packages/config/test/readme-config-table.test.ts`).

**Repro** (capability missing). Run from `.tentacle/tmp/models-map/` on unchanged
`main` @ `09f63cf` (`bun .tentacle/tmp/models-map/repro.ts`, 2026-11-08, before any edit):

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
Observed (identical to what the strict schema predicted):
```
{"models":{"fast":{"model":"qwen3-4b"}}} → Unrecognized key(s) in object: 'models'
{"subagents":{"types":{"explore":{"model":"fast"}}}} → Unrecognized key(s) in object: 'types'
{"subagents":{"selectableModels":["fast"]}} → Unrecognized key(s) in object: 'selectableModels'
```

## Implementation

*— claude-opus-5-5, 2026-11-08*

Written against `main` @ `09f63cf`. After the owner's answers (end of this section) the
branch carries:
- **A — the `models` map + per-type routing** (config, resolution, keys, wiring, pods, mount hide).
- **B — agent-selectable models** (`selectableModels`, `description`, the `agent_task` `model` arg).
- **C — REMOVAL of the server-slots cap** (owner 2026-11-08; it replaces the per-endpoint slot
  sizing first planned here). See *C. Removal of the slots cap*.

Steps tagged **[A]**/**[B]** are all built (owner Q1 = c: one branch).

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
- `PROTOCOL_VERSION` was 17 at planning (`protocol/src/version.ts:7`). Parts A and B change no
  wire schema; part C removes `model/slots` and bumps it to 18 (owner 2026-11-08, see *C*).

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
- `ModelEntrySchema = ModelConfigSchema.extend({ description: z.string().min(1).max(300).optional() })`
  — **[B]** adds `description`. Owner Q3 = (b): NO `omit`; `autoTitle`/`titleModel` are
  accepted in an entry and IGNORED (the resolver never reads them; the registry and `explain`
  say "has no effect inside an entry"). Zod 3.23.8 `extend` keeps `.strict()` (probe, Execution).
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
  cannot be derived. (Replaced in review round 2 by `keyFileUnknownOwners(config)`, which
  names each `model` / `models.<n>` whose file is unknown: F-5.)
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

#### C. Removal of the slots cap (owner 2026-11-08)

*Replaces the per-endpoint slot sizing first planned here (dropped entirely).* Owner: the
harness cannot know which local server runs or how many slots it has (only llama.cpp
advertises `/props` `total_slots`); scheduling policy is out of the harness's scope. **The
only sub-agent concurrency limit is `subagents.maxParallel`, set by the user.**

Removed (every site from `rg -n "slots|total_slots|/props|effectiveAgentCap|slotsBounded"`;
the remaining hits are unrelated uses of the word — `session-log*.ts` slot arrays,
`render-lines.ts` layout slots):
- core: `ModelProvider.slots` (`core/src/model.ts:102-108`), `slotsBounded` + `SLOTS_CAP_MS`
  (`core/src/context.ts:13-52`).
- providers: `OpenAIProvider.slots()` (`GET <root>/props`), `parseSlots`, `SLOTS_TIMEOUT_MS`,
  `MAX_SLOTS`, `slotsTimeoutMs`, `knownSlots` (`openai-provider.ts:35-36,127-200`);
  `RetryingModelProvider.slots` (`retry.ts:182-185`); `providers/test/slots.test.ts` (deleted).
- agent: `subagentExecution.slots`, the probe in `runToolCalls` (`agent.ts:1246-1249`) — the
  cap is now `agents?.maxParallel ?? 1`; `effectiveAgentCap` and `hasSpawnFanOut` (its only
  user was the probe) in `round-plan.ts`, with their tests.
- protocol: `model/slots` (`Method.ModelSlots`, `ModelSlotsParams/ResultSchema`, its
  `RequestSchemas` row), the JSON schema regenerated (`bun run schema:export`);
  **`PROTOCOL_VERSION` 17 → 18** (a removed method is breaking; pre-public: no shim).
- daemon: `ProxyModelProvider.slots` + `ModelSlotsSender`, `Connection.requestModelSlots`,
  `ModelLink`'s optional member.
- client: `RemoteClient.onModelSlots` and its dispatch.
- cli: `serve.ts`'s slots sender to the tunnel; `wiring.ts`'s `slotsReader` (the "sub-agents
  capped at N" notice) and `BuildAgentOptions.agentsNotice` (only that notice used it) and its
  two `main.ts` callers.
- config/docs: `subagents.maxParallel`'s summary/details, the schema comment, the scaffold
  comment (`defaults.ts:147`), the README row (regenerated), a "superseded" banner on
  `docs/feat/parallel-agents.md` (its Design 6 is the removed feature; the text stays as
  history).

Failure modes: F21–F23 below. Tests: the agent, CLI and pod fan-out tests with a provider
that WOULD report 1 slot (`peak` = `maxParallel`, the probe never called); `no-slots.test.ts`
(method gone, version 18); `version-mismatch.test.ts` 17 ↔ 18.

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
17. Part C (removal): `core/src/{model,context}.ts`, `providers/src/{openai-provider,retry}.ts`, `agent/src/{agent,round-plan}.ts`, `protocol/src/{model,methods,version}.ts` + `schema/protocol.json`, `daemon/src/{proxy-model,connection}.ts`, `client/src/remote-client.ts`, `cli/src/{serve,wiring,main}.ts`, `config/src/{key-docs,schema,defaults}.ts`, `docs/feat/parallel-agents.md`, `CHANGELOG.md`; tests listed in C.

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
| F6 | An entry's key printed | Error texts carry paths and exit codes only; `config list/get` mask by registry; `explain` reads only the registry; the tool description shows names + descriptions. Tests assert the key string is absent from every error and from `carriedSettings(config)`. |
| F7 | A secret on argv | `config set models.x.apiKey …` refused (registry, `isArgvRefusedSecret`); `apiKeyCommand` on argv stays allowed (the documented safe form). We spawn no child with a key on argv: providers get the key in memory; the key command runs via `/bin/sh -c` exactly as the main one (existing). |
| F8 | Entry key command fails / prints nothing | `ConfigError` naming `models.<name>.apiKeyCommand` (A5), before Ink. Identical commands run once, so one failure is one message. |
| F9 | Entry key command prompts (pinentry) | Runs at load, before Ink (Q4) — never mid-session. A detached relay (no terminal) skips the entries' commands and still runs the main one (R-Q1 a, F-2). |
| F10 | Pod `run`/`attach` with `models` configured | Laptop `[models]` notice; not carried; every child uses the tunnel (main model). Pod daemon: no entry command runs (`podDaemon`), its own types ignored + a daemon-log notice. A detached run's relay runs no entry command either (F9). No key leaves the laptop. |
| F11 | docker/podman workspace mount with an entry key file inside the workspace | Hidden like the main key file (A9); an opaque command (`pass show …`) is listed by `keyFileUnknownOwners`, so the plan's warning shows, naming `model` / `models.<n>` (F-5). |
| F12 | `--profile` | Everything resolves after `applyProfile`: inherited entries follow the PROFILE's main endpoint and key; a profile's entry replaces the base one whole (Q5), so a base key never pairs with a profile URL. Each profile is reference-checked at parse time (A2), so a broken profile is refused even when not selected — the same rule as any invalid key in a profile today. |
| F13 | A `models` entry with its own `apiKey` inside a profile | Valid; masked as `profiles.<p>.models.<n>.apiKey = ***` (mirror, A6); refused on argv; replaces the base entry whole; never carried. |
| F14 | `--model` / `TENTACLE_MODEL` / `TENTACLE_MODEL_BASE_URL` | Change the main model; entries that do not set the field inherit the effective value (Q2). `TENTACLE_MODEL_API_KEY` reaches only inheriting entries (same endpoint). |
| F15 | Version skew | Wire: parts A and B add nothing (the name never travels in task 3); part C removes `model/slots`, so `PROTOCOL_VERSION` is 18 and a 17 ↔ 18 pair is refused at `initialize` with the worded `VersionMismatch`. Disk: no persisted format (a choice is not persisted; a resume re-resolves from the current config; an old `agent_task` call with `model` in history is history only). Config: an older build refuses a file with `models` loudly (`Unrecognized key(s) in object: 'models'`) — pre-public, fine. Laptop ↔ pod of different builds: unaffected (nothing carried). |
| F16 | Settings sync rebuilds the agent | `buildAgent` rebuilds providers from the same `TentacleConfig` (lazy, cheap); no state to carry. |
| F17 | Same command string for main and an entry | Run once (A5); both get the output. Entry inherits nothing else. |
| F18 | Empty `models` / `types` / `selectableModels` | Same as unset: no `model` argument, no list, unchanged description (pinned byte-identical). |
| F19 | Name with `.` or longer than 64 | Schema refusal with `MODEL_NAME_MESSAGE`. `__proto__` is refused by name (F-7); `constructor` is an ordinary name (`Object.hasOwn` everywhere). |
| F20 | `autoTitle`/`titleModel` inside an entry (owner Q3 = b) | Accepted, ignored: `resolveModelEntry` never copies them; `explain models.*.autoTitle` says "has no effect inside an entry". |
| F21 | An old pod daemon / `serve` (protocol 17) with a new laptop, or the reverse | `initialize` refuses with `VersionMismatch` (protocol 18), worded "update" — never a mid-turn `MethodNotFound` on `model/slots`. Pinned in `daemon/test/version-mismatch.test.ts` (17 ↔ 18). |
| F22 | A fan-out of N sub-agents on a llama.cpp server with fewer slots than N | Up to `maxParallel` run at once; the server queues the extra requests (slower, correct). Nobody asks `/props`. Pinned: agent + CLI + pod tests with a provider that would report 1 slot (never called). |
| F23 | A user who relied on the automatic cap | One CHANGELOG line (`### Changed`) and the `subagents.maxParallel` docs/scaffold say: set it to your server's parallelism. |

### Tests

Run narrow files while iterating (AGENTS §4); full gate at the end. Every new test is first
shown RED on the unchanged code (most are red simply because the schema refuses the keys or
the export does not exist — that IS the red for a feature; record the failing line), then
GREEN. Mutation checks are listed where a test could pass vacuously.

0. **Probe first** (`.tentacle/tmp/models-map/probe.ts`, paste output into Execution): run the
   Repro; then confirm `ModelConfigSchema.extend({description: z.string().optional()})` (no `omit`: Q3 = b)
   still refuses an unknown key (`_def.unknownKeys === "strict"`) and that a record keyed by
   `z.string().regex(MODEL_NAME)` refuses `"a.b"`. If either fails, STOP and update this plan.
1. `packages/config/test/models.test.ts` (new):
   - `resolveModelEntry`: `{}` → every field = main's, `apiKeySource: "inherited"`, main literal key copied; `{ model: "x" }` → main endpoint + key, id `x`; `{ baseURL }` → provider `openai`, NO key even when main has env/file/command keys (the F5 pin); `{ provider: "anthropic" }` → anthropic default URL, no key; own `apiKey` → `file`; own `apiKeyCommand` → `command`, no `apiKey`; `contextWindow`/`maxTokens`/`model` inheritance; `description` not inherited. **Mutation:** drop the connection-unit branch → the `{ baseURL }` test must fail.
   - `modelRefIssues`: unknown type ref (exact text, `defined:` sorted); `no models defined`; unknown selectable [B]; a profile-only issue prefixed `profiles.<p>: `; a base issue reported ONCE (not per profile); a base ref defined only in a profile → base issue; a type block without `model` → no issue.
   - `pickSubagentModel`: each precedence step beats the next (call › type › frontmatter name › frontmatter id › default) [call = B]; windows per A7 (type entry ignores frontmatter window; frontmatter name uses it); a `requested` not in the list is ignored; `Object.hasOwn` — a type named `constructor` / `__proto__` does not crash or match.
   - `modelsPodNotice`, `unknownTypeModelWarnings`: exact texts, `null`/`[]` when empty.
2. `packages/config/test/subagent-keys.test.ts` (extend) or a new `models-schema.test.ts`: names (`a.b`, `""`, 65 chars refused; `fast_2-x` ok); entry strict (`{ foo: 1 }` refused; `autoTitle`/`titleModel` accepted and ignored per Q3 = b); `description` > 300 refused [B]; `subagents.types.x` strict (`{ model: "a", foo: 1 }` refused); config-level error message through `FileConfigSchema.safeParse` equals the A2 text.
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

### Split (superseded)

The split proposed here (3 / 3b / 3c `feat/models-map-slots`) is void: owner Q1 = (c), one
branch, and the per-endpoint sizing (3c) was dropped altogether — see *Owner answers*. No
`feat/models-map-slots` task exists. Task 6c (`feat/subagent-slots`, a session-level slot
limiter) contradicts the owner's 2026-11-08 rule ("tentacle does not size or limit by server
slots anywhere") and should be re-scoped or dropped in `TODO.md` (not touched here: owner's call).

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

### Owner answers (2026-11-08)

*— claude-opus-5-5 (recording the owner's answers), 2026-11-08*

- **Q1: (c)**, against the recommendation: A + B (+ C) in this ONE branch; it is therefore
  load-bearing and executed by a strong model (claude-opus-5-5). **Then moot for C:** the owner
  dropped part C (per-endpoint slot sizing) and **removed the existing slots cap** — the only
  sub-agent concurrency limit is `subagents.maxParallel`; tentacle sizes nothing by server
  slots anywhere (the harness cannot know which server runs or its slots; scheduling policy is
  out of scope). Removing `model/slots` is breaking → `PROTOCOL_VERSION` 18. Built as part C.
- **Q2: (a)** — an entry inherits the agent's EFFECTIVE values (profile, env, `--model`).
- **Q3: (b)**, against the recommendation — `autoTitle`/`titleModel` inside an entry are
  accepted and IGNORED (the shape of `model`); the docs and `explain` say they have no effect.
- **Q4: (a)** — every entry's `apiKeyCommand` runs at startup, before the TUI, identical
  commands once, in parallel.
- **Q5: (a)** — a profile's `models` entry replaces the base entry whole.
- Unchanged (eval owner Q14 = b): no slot reservation for the agent (now trivially: no slots).

## Execution

*— claude-opus-5-5, 2026-11-08*

**Repro (before any edit), on `main` @ `09f63cf`:** see *Context → Repro* (observed output
pasted there; identical to the prediction). Dependencies were missing in the worktree:
`bun install --frozen-lockfile --filter '!@tentacle/mobile'` first.

**Probe** (`.tentacle/tmp/models-map/probe.ts`): `ModelConfigSchema.extend({description})` →
`_def.unknownKeys: "strict"`, `{foo: 1}` refused, `{autoTitle: true}` accepted. (A record
keyed by a regex looked wrong in the probe — a mixed zod instance imported from the tmp dir;
the real check is `models.test.ts` "a name holds letters…", green.)

**As built, in order** (every behaviour shown RED on the old code first, on an assertion,
then GREEN; "stub" = an export skeleton returning a wrong value, so the red is on the
assertion and not on an import error, as the executor brief requires):
1. **config** — `schema.ts` (`ModelEntrySchema`, `MODEL_NAME`, `models`, `subagents.types`,
   `subagents.selectableModels`, `FileConfigSchema.superRefine(modelRefIssues)`),
   `profile.ts` (`CONNECTION_KEYS` exported; `models` / `subagents.types` merged by name, an
   entry replaced whole), `models.ts` (new: `resolveModelEntry`, `modelRefIssues`,
   `pickSubagentModel`, `modelsPodNotice`, `unknownTypeModelWarnings`), `resolve.ts`
   (`models` over the effective main model, `subagentModels`, `selectableModels`), `load.ts`
   (`resolveModelKeys`: distinct commands once, in parallel, main output reused, skipped for a
   pod daemon, errors `models.<n>.apiKeyCommand …`), `key-docs.ts` (16 new entries incl.
   `models.*.autoTitle/titleModel` "no effect", secret flags; `profiles` details), README
   regenerated. Red: `models.test.ts` 26 fail / 4 pass on the stub; `models-load.test.ts`
   5 fail / 1 pass; registry gate T1 red on the schema alone (16 missing paths), README T4 red
   until `bun run docs:config`. Green: config 390 pass.
2. **slots removal (part C)** — new agent test "a server that would report 1 slot no longer
   lowers the cap": RED on the old loop (only 1 of 3 children started), GREEN after removing
   the probe. Then every site listed in *C* (core, providers, agent, protocol + schema,
   daemon, client, cli serve/wiring/main, config docs). `PROTOCOL_VERSION` 18; the three
   "current version" pins updated 17 → 18; new `no-slots.test.ts`; `version-mismatch` gets
   a 17 ↔ 18 case. Obsolete tests deleted (`providers/test/slots.test.ts`,
   `ProxyModelProvider.slots` tests, `effectiveAgentCap`/`hasSpawnFanOut` tests, the T-S
   probe tests) or rewritten to assert the probe is never called.
3. **agent** — `subagent.ts`: `SubagentModel`, `modelFor(type, requested)`,
   `SubagentRunOptions.model`, window = chosen › type › parent, hooks get the chosen model id.
   Red: 5 fail (old runner passes an id and uses the result as a provider). Green: agent 458.
4. **tools (B)** — `task.ts`: `models` option, the exact description section, `model` only
   when selectable, the refusal `unknown model "<x>" for agent_task — use one of: …, or omit
   model` (no child starts). Red: `task-models.test.ts` 5 fail / 2 pass (the 2 = "off is
   exactly today's" guards). Green: tools 80.
5. **cli** — `model-provider.ts`: `ProviderFactory`, `createModelProviders` (entry's own
   endpoint/key only, cached), `subagentModelResolver`; `configuredModelProvider` takes the
   factory. `wiring.ts`: `createProvider` seam (main, title, entries), `modelFor` only off the
   tunnel, the pod daemon-log notice, `models` to the task tool. Red: `models-providers` 4 fail
   on the stub; `models-wiring` 4 fail (3 on the missing seam — they reached the network —, 1 on
   the notice assertion). Green.
6. **docker/podman key-file leak** — `workspace-mount.ts`: `hideList`/`apiKeyFileUnknown`
   take a command list, `keyCommandsOf(config)`; `main.ts:1150-1151` uses it. Red: the hide
   test (old `hideList` ignored a list → `[]`) and `keyCommandsOf` on the stub. Pinned by a
   grep-guard on the `main.ts` call site (the last mile of the leak).
7. **main.ts** — `[agents]` warning for a configured type no one defines; `[models]` notice on
   `run`/`attach` (pre-Ink, beside the `[packages]` line). **config-run.ts** — the argv-secret
   hint names the key's own `…apiKeyCommand` (red: 1 fail, then green); three
   `models.*.apiKey` argv-refusal cases added to HIGH-1.
8. Docs: `CHANGELOG.md` (`### Added` models with an example config; `### Changed` slots
   removal), `docs/feat/parallel-agents.md` banner, this doc.

**Mutations (cp backup → mutate → run → restore, shasum equal before/after):**
| Mutation | Test that went red |
|---|---|
| `key-docs.ts`: drop `secret: true` from `models.*.apiKey` | `config-value` mask test (key printed in clear) + T7 |
| `models.ts`: connection-unit branch disabled (`&& false`) | 4 `models.test.ts` tests (main key/provider leaked to an own-endpoint entry, env key reached `other`) |
| `wiring.ts`: give `modelFor` to the tunnel path | `models-wiring` pod test (`from fast-id` instead of the tunnel) |
| `methods.ts`: re-add `ModelSlots: "model/slots"` | `no-slots.test.ts` |
Checksums restored: key-docs `ebf3ba76…`, models.ts `d2c033cc…`, wiring `6574327b…`,
methods `f39fd782…`.

**Guards that are green on both by design** (they pin an invariant that already held):
`carried-settings` — `carriedSettings(config)` JSON holds no entry key, URL, model id or name;
`task-models` "off is exactly today's" (description + schema byte-identical, stray `model`
stripped).

**UX evidence** (`.tentacle/tmp/models-map/explain.ts`): `explain` lists `models (10 sub-keys)`
next to `model`, `subagents (8 sub-keys)`; `explain models` lists `models.*.provider` …
`models.*.description` (the two title keys say "Accepted for the shape of `model`; has no
effect inside an entry."); `explain models.claude.apiKey` → `secret  yes — never printed
(masked as ***)`.

**Drift from Implementation (and why):**
- Part C is a REMOVAL, not per-endpoint sizing (owner change mid-task). `agentsNotice` and
  `hasSpawnFanOut` went with it (their only purpose was the slots path: no dead code).
- Q3 = (b): no `omit`; the registry documents the two title keys instead.
- `createProvider` also builds the MAIN and title providers (the plan had it for entries
  only): needed so a wiring test never reaches the network.
- `hideList`/`apiKeyFileUnknown` accept `string | string[] | undefined` (not only a list), so
  the ~10 existing call sites in tests stay as they were.
- Tests live in new files (`config/test/models*.test.ts`, `tools/test/task-models.test.ts`,
  `cli/test/models-{providers,wiring}.test.ts`, `protocol/test/no-slots.test.ts`) rather than
  the files the plan named; `explain.test.ts` counts updated (subagents 6 → 8 sub-keys) and
  its "named once" check made whole-word (`model` matched the new `models` line).
- `docs/feat/config-profiles.md` not edited: the merge rule is in the registry's `profiles`
  details (which `explain` prints) and in `profile.ts`'s header.

**Gate (2026-11-08):** `bunx tsc --noEmit` clean · `bunx biome check .` 763 files, 0 errors,
0 warnings · `bun test packages` **5765 pass, 3 skip (the opt-in live-k8s / live-docker /
slow-socket), 0 fail**. Not run: `tsc -p apps/mobile` (mobile deps not installed in this
worktree; `rg` finds no `slots`/`model/slots` use under `apps/`).

**Left / unverified:** a live run against two real endpoints (verify: a config with a
`models` entry on a second llama.cpp server, `explore` mapped to it, watch both servers'
logs). Task 6c (`feat/subagent-slots`) in `TODO.md` now contradicts the owner's rule — owner
to re-scope; TODO.md not touched.

### Round 2 (review fixes)

*— claude-opus-5-5, 2026-11-08*

Fixes for the Review's F-1…F-8, on `4b6d018`.

**R-Q1 = (a): default, awaiting owner confirmation.** The relay skips the `models` entries' key
commands and still runs the main one. **R-Q2** is moot: task 6c is already dropped on `main`.

| Finding | Change | Red → green |
|---|---|---|
| F-1 | `explain.ts` `renderExplainText`: a section prints `details` between its summary and its children. | `explain.test.ts` "a section prints its details…": red on the old code (`["", details, ""]` not found), green after. `models` added to the 80-column check. |
| F-2 | `load.ts`: `skipModelsKeyCommands` (entries' commands only); `relay.ts` `relayMain` passes it. | `relay.test.ts`, real `relayMain`: red with `[relay] models.claude.apiKeyCommand exited with code 7: pinentry: no tty`, green past the load, and the command's marker file is never created. `models-load.test.ts` pins main-runs/entries-do-not. |
| F-3 | Tests only (code was correct). | Mutations below, killed. |
| F-4 | Call-site test instead of a grep-guard: `main.test.ts` drives the real `main` (`[agents]` on the local path, `[models]` on `run`). | Green on the code; M20, M21 killed. |
| F-5 | `workspace-mount.ts`: `keyFileUnknownOwners(config)` replaces `apiKeyFileUnknown`; the warning starts `model.apiKeyCommand, models.claude.apiKeyCommand: …`. `engine-select.ts`, `main.ts` pass the list. | Red on a stub returning `[]` (assertion) and on the old warning text; green after. The existing `main.test.ts` R2-1 text updated. |
| F-6 | This doc: `:152`, F6, F15, Tests item 2 (`autoTitle` per Q3 = b), the probe's `omit`, A9's `apiKeyFileUnknown`; F9/F10/F11/F19 updated for this round. `TODO.md:456` not touched, as instructed. | n/a |
| F-7 | `schema.ts`: `refuseProtoName`, a `z.preprocess` on `models` (base and profile share `settingsShape`). | `models-load.test.ts` (real JSONC) and `models.test.ts` (`JSON.parse`): red, green after. |
| F-8 | Note only: `tsc -p apps/mobile` not run, mobile deps not installed. | Close with `bun run typecheck` on a full install. |

**F-7 cause, and a case the review did not list.** The JSONC parser assigns `"__proto__"`, which
swaps the map's prototype. The record then read the entry's fields as entries (`Expected object`),
and an empty `{"__proto__":{}}` loaded silently with no entry at all. Both now say
`a model cannot be named "__proto__" (a reserved name): choose another`, at load and at
`config set` (`models: a model cannot…`). `constructor` stays an ordinary name: every lookup uses
`Object.hasOwn`, pinned by a load test.

**Reviewer's mutations, now killed** (`review/mutate.ts`; all `restored=true`):
| Mutation | Test that fails now |
|---|---|
| M19a, M26: entry's model id from the file | "env overrides of the main model…", "--model reaches an inheriting entry…" |
| M16, M25: hooks get `type.model` | "hooks get the CHOSEN model's id…" |
| M17: `has` uses `in` | "a name like __proto__ or constructor…", "a frontmatter `constructor`…" |
| M20, M21: notices off at the call site | "cli main: the models-map notices" |

**This round's guards** (`round2/mutate2.ts`; all killed, `restored=true`): relay skip also skips
the main key (N1) · relay does not pass the option (N2) · `__proto__` own-key check off (N3) ·
prototype-swap check off (N4) · section details not printed (N5) · warning names no owner (N6).
`cp` backups taken before the runs; after them, `shasum` of all 9 mutated source files equals the
backup's.

**Evidence.** `bun review/relay-repro.ts` after the fix:
```
control (no models): exit 1 — [relay] kept entry 0123456789abcdef not found
entry command that needs a terminal: exit 1 — [relay] kept entry 0123456789abcdef not found
```
`tentacle explain models` prints the summary, then the details (EFFECTIVE inheritance, the
connection unit, key commands, the profile rule), then the children. `bun run docs:config`:
"README.md's config table is up to date": the table is built from leaf summaries and never used
`details`, so no regeneration was needed.

**Drift:** F-4 is a real `main` test, not the grep-guard the finding also allowed. Beyond the
findings: the `models` details now say a relay runs no entry command (`key-docs.ts`), and
`CHANGELOG.md` mentions the relay, `explain` and the warning's owner.

**Gate (2026-11-08):** `bunx tsc --noEmit` clean · `bunx biome check .` 763 files, no findings ·
`bun test packages` **5778 pass, 3 skip (the opt-in live-k8s / live-docker / slow-socket), 0 fail**.

**Left / unverified:** the `run --detach` relay path is exercised through the real `relayMain` up
to the config load, not against a live engine (verify: `run --detach` with a failing entry
command on docker). A live pair of llama.cpp servers is still unexercised, as in Round 1.

## Review

*— claude-opus-5-5, 2026-11-08*

**Verdict: REQUEST-CHANGES.** No secret leak, no misrouted key, and the removal is complete,
all confirmed by execution. Two behaviours fall short of what the plan promises (F-1, F-2),
and one of the owner's binding decisions (Q2) has a part no test holds (F-3). The fixes are
small. Reviewed on `e80e337`; no source file was changed (`git status --short` empty after the
mutations).

Same model as the executor (claude-opus-5-5), fresh context only: shared blind spots survive
both passes. For a load-bearing task AGENTS §10 prefers a different model on a later pass.

### Findings

**MEDIUM**

- **F-1. `tentacle explain models` does not print the section's `details`.**
  `packages/cli/src/explain.ts:384-405` renders a section as its summary plus children;
  `details` appears only on a leaf card (`cardLines`, `:315-319`) and in `--json`.
  `scripts/config-docs.ts` does not use `details` either. So the text at
  `packages/config/src/key-docs.ts:287-288` never reaches a terminal or the README: EFFECTIVE
  inheritance, "repeat the key even when it is the same URL", key commands at startup, a
  profile's entry replacing the base one whole. Observed live: `explain models`, `explain
  models.*`, `explain profiles` show no details. This contradicts A6 ("the `models` summary and
  details") and Execution's drift note, which skips `docs/feat/config-profiles.md` because the
  merge rule is in the `profiles` details "(which `explain` prints)". It does not print them.
  **Fix:** print `section.details` under the summary in the section branch of
  `renderExplainText`, pin it in `explain.test.ts`; then `config-profiles.md` can stay as is.
- **F-2. A detached relay runs every entry's key command, uses none of them, and dies if one
  fails.** `packages/cli/src/relay.ts:669` calls `loadConfig` without `podDaemon`, and
  `load.ts:714-718` then runs the entry commands. The relay has no terminal (`relay.ts:701-705`:
  `detached: true`, stdin ignored), and in a pod the entries are never used. So F9's "runs at
  load, before Ink" reasoning does not hold on this path, and F10 omits it. Repro
  (`relay-repro.ts`, real `relayMain`):
  ```
  control (no models): exit 1 — [relay] kept entry 0123456789abcdef not found   (past the config load)
  entry command that needs a terminal: exit 1 — [relay] models.claude.apiKeyCommand exited with code 7: pinentry: no tty
  ```
  A launcher with a terminal succeeds, then its relay exits at startup, because of a setting
  documented as "not applied on run/attach yet". The failure is loud (`relay.log`). The main
  key has the same exposure today, but the relay needs that key. See owner question R-Q1.
- **F-3. Three tests do not hold what they claim (mutations survived).**
  - **Q2, the inherited model id.** With `model: fileConfig.model?.model ?? modelId.value` in
    `resolve.ts:518-525`, an inheriting entry ignores `TENTACLE_MODEL`/`--model`, and all of
    `packages/config/test` stays green (M19a/M26). The base URL half is pinned (M19b killed).
    Behaviour today is correct (live: env → `env-id`, `--model` → `flag-id`). **Fix:** assert
    `model` in "env overrides of the main model reach inheriting entries only", with a
    file-set `model.model`, and one `--model` case in `models-load.test.ts`.
  - **Hooks get the chosen id (plan test 7).** Replacing `chosen?.modelId ?? …` by `type.model`
    at `subagent.ts:289` survives (M16/M25): the fake at `subagent.test.ts:107` sets
    `modelId: type.model`, so old and new agree. A type routed by `subagents.types` would report
    no model to hooks and nothing would notice. **Fix:** a test whose `modelId` differs from
    `type.model`.
  - **"never found by accident".** `models.test.ts:146-153` calls `modelRefIssues` with no
    `models` at all, so `has` is false on `undefined` and the case passes with `key in map`
    (M17). The real risk is a frontmatter or ref of `constructor` with a `models` map present:
    with `in`, `pickSubagentModel` would return an entry from `Object`. Code is correct today.
    **Fix:** run both assertions with a non-empty `models`, and add a frontmatter `constructor`
    case to `pickSubagentModel`.

**LOW**

- **F-4.** `main.ts:826-842`: the `[agents]` warning and the `[models]` notice have no test at
  the call site (M20, M21 survive the whole `packages/cli/test`). The pure helpers are pinned
  and the `[agents]` line was observed live; `[models]` was not (it needs an engine). **Fix:**
  a `main` seam test or a grep-guard as for the hide list.
- **F-5.** `workspace-mount.ts:744-745`: `KEY_FILE_UNKNOWN` says "apiKeyCommand" without saying
  whose. With entries the user cannot tell which command to change. **Fix:** name the
  `models.<n>` (or `model`) in the warning.
- **F-6. Stale plan text** (AGENTS §8, the doc is the source of truth): `:152` "changes no wire
  schema", `:628` F15 "`PROTOCOL_VERSION` stays 17", `:619` F6 "the slots notice", `:654`
  "`autoTitle` refused per Q3". `TODO.md:456` still lists `slots` on the pod task's wire.
- **F-7.** A model named `__proto__` is refused, but with an unhelpful text: `models.model:
  Expected object` (`config set`), `Expected object, received string` (a load). Safe; cosmetic.
- **F-8.** Mobile typecheck was not run by the executor or by this review (deps not installed
  in the worktree). `rg` finds no `slots` use under `apps/`, and the only `protocolVersion` hit
  prints the daemon's value (`apps/mobile/src/spike.ts:85`). `bun run typecheck` on a full
  install closes it.

### Gate (re-run)

`bunx tsc --noEmit` clean · `bunx biome check .` 763 files, no findings · `bun test packages`
**5765 pass, 3 skip, 0 fail** (63096 expects, 393 files), matching Execution.

### Premise table (read at `09f63cf`)

| Premise | Result |
|---|---|
| Context repro re-run on main's schema: the three probes refused with the quoted messages (accepted shape on the branch) | TRUE |
| `model-provider.ts:13-29` same endpoint and key for a model id | TRUE |
| `subagent.ts:228`, `:235-236` the only pick of the child's provider | TRUE |
| `wiring.ts:477-481` one `modelFor`; now one `createSubagentRunner` caller (`wiring.ts:476`) | TRUE |
| `serve.ts:452-456` tunnel for every type | TRUE |
| `profile.ts:18-29` connection unit, `:86-100` per-key `subagents` | TRUE |
| `resolve.ts:493-506` key precedence; `apiKeyCommand` stays unset when env or file wins | TRUE |
| `load.ts:468-472` stderr only; `:546-547` `--model` on a copy; `:634-640` main command; `:78-92` first issue; `:109-116` `podDaemon` | TRUE |
| `config-edit.ts:182-190`, `config-value.ts:145-151`, `config-keys.ts:60-83`, `registry.ts:79-96` | TRUE |
| `workspace-mount.ts:71-90`, `main.ts:1140-1151` only the main key file hidden | TRUE |
| `carried-settings.ts`: no connection key carried (list read at `09f63cf`) | TRUE |
| `version.ts:7` = 17, `agent.ts:1246-1249` the probe | TRUE |

### Mutations (`mutate.ts`: edit, run, restore, sha256 compared; all `restored=true`)

| Property broken | Outcome |
|---|---|
| Command entry gets the main key (M1) · keyless own endpoint gets it (M3) · `forEntry` falls back to it (M4) | killed |
| Pod daemon runs entry commands (M2) · selectable list offered in a pod (M11) | killed |
| `keyCommandsOf` drops entries (M5) · `main.ts` hides the main key only (M6, grep-guard) | killed |
| Cap = min(maxParallel, 2) (M7) · `PROTOCOL_VERSION` 17 (M13) | killed |
| Type beats call (M8) · frontmatter beats type (M9) · unlisted model accepted (M10) | killed |
| Profile entry merged per key (M12) · main output not reused (M14) · empty key accepted (M18) | killed |
| Inherited base URL from the file (M19b) · selectable check dropped (M22) · reference check removed (M23) | killed |
| Child window ignores the chosen one (M15 narrow; M24 on `packages/agent/test`) | killed by `context-awareness-loop` |
| Inherited model id from the file (M19a, M26) · hooks get `type.model` (M16, M25) · `has` uses `in` (M17) | **survived → F-3** |
| `[models]` notice off (M20) · `[agents]` warning off (M21) | **survived → F-4** |

### Attacks tried

1. **Key routing end to end** (`e2e.ts`: real `loadConfig`, `buildAgent` and providers against
   two HTTP servers recording headers; 20 scenarios). Inherited entry → main endpoint, main key.
   Own entry → its endpoint, its key. `TENTACLE_MODEL_API_KEY` reaches inheriting entries only.
   Own endpoint with no key on the SAME URL as main → no auth header at all. Anthropic key on
   `x-api-key` only. Nothing found.
2. **Precedence.** Call › type › frontmatter name › frontmatter id › main, the default type and
   an unknown `subagent_type` included; unlisted name → error result, no child request; `model`
   stripped when off. Nothing found.
3. **Profile and Q2.** A profile's entry replaces the base whole (main endpoint + key after);
   `TENTACLE_MODEL_BASE_URL` moves inheriting entries with their key. Nothing found.
4. **Keys at load.** A command shared by main and two entries runs once; `podDaemon` runs none;
   a failure names the entry and carries stderr, never stdout (`LEAKED-STDOUT` absent).
5. **Printing** (real CLI, fake keys, scratch `TENTACLE_CONFIG_DIR`). `config list [--json]`,
   `config get` on a leaf, an entry, the map and a profile mask every key and command. Argv
   refused for a leaf, a nested JSON value, the map, a profile mirror and the `k=v` form; `-`
   from stdin works; the hint names the entry's own `…apiKeyCommand`. Nothing found.
6. **Config errors.** Unknown ref at `set`, at `unset` of a referenced entry and at load, each
   naming the defined entries; profile-only issue prefixed; dotted name refused. Clear. `explain`
   → F-1.
7. **Pods.** No key reaches a pod: nothing of `models` is in `carried-settings`, a tunnelled
   `buildAgent` builds no provider (M11, `f.made` empty) and offers no `model` argument, and
   `model/stream` serves the main model only. Docker and podman share the one hide-list site
   (`main.ts:1166`), `run --detach` included; k8s, remote engines and `attach` mount nothing new.
   A key file of a profile NOT selected is not hidden, the same shape as the main key today.
   Not exercised against a live engine. Detach → F-2.
8. **Removal.** `rg` over the tree: what remains is the 0.3.0 CHANGELOG entry, the new
   Unreleased note, comments saying no server is asked, `TODO.md` (F-6, R-Q2), unrelated `slots`
   words, and the fake in tests that proves nobody asks. No request to `/props` in any e2e
   scenario. `initialize` refuses 17 ↔ 18 with the worded message; both ends share the constant
   (`connection.ts:360`, `remote-client.ts:1518`, `pod-resident.ts:557`).
9. **Agent loop.** `agentCap` is exactly `maxParallel` (M7 killed); peak 3 at 3, bounded at 2,
   one at a time at 1.
10. **Two real endpoints** ("left unverified" in Execution): covered at the HTTP level by attack
    1, with fake servers; a live llama.cpp pair is still unexercised.

### What holds

The connection group as a unit, masking and argv refusal driven by the registry, the pod
boundary, the `maxParallel` cap, the protocol bump on both ends, and the removal's completeness.

### How the executor behaved

Accurate on the gate and on its four listed mutations. Drift is reported honestly, including
the mixed-zod probe. One Execution claim is false (`explain` printing a section's details,
F-1), the plan's text was not refreshed after the owner's changes (F-6), and three pins were
weaker than described (F-3): the tests were present but did not separate the behaviours.

### Owner questions

- **R-Q1 (F-2). A relay and the entry key commands.** (a) The relay skips them, through a
  `loadConfig` option that still runs the main key; (b) leave it, so a detached run also needs
  every entry command to succeed without a terminal. **Recommend (a):** the relay uses none of
  them until `feat/models-map-pod`, which can then decide for itself. Q4's reason (prompt before
  the TUI) does not apply where there is no terminal.
- **R-Q2. `TODO.md` task 6c (`feat/subagent-slots`)** contradicts the 2026-11-08 rule. (a) Drop
  it; (b) re-scope it to a limit the user sets. **Recommend (a):** `subagents.maxParallel` is
  now the only limit you asked for.

### Round 2

*— claude-opus-5-5, 2026-11-08*

**Verdict: PASS with nits.** No MEDIUM or higher finding remains, on `574e197`. Merge still
needs the owner's confirmation of R-Q1 (a), applied here as a default. R-Q2 is moot. Same model
as the executor, fresh context only, as in round 1.

**Gate (re-run):** `bunx tsc --noEmit` clean · `bunx biome check .` 763 files, no findings ·
`bun test packages` **5778 pass, 3 skip, 0 fail** (63142 expects, 393 files).

| Finding | Status | Evidence |
|---|---|---|
| F-1 section `details` | **fixed** | `explain.ts:403`. Live `explain models` prints summary, details, children. N7 killed. |
| F-2 relay and entry commands | **fixed** (R-Q1 a) | `relay.ts:673`, `load.ts:723`. `relay-repro.ts` now ends `[relay] kept entry 0123456789abcdef not found` for both configs: past the load. N1, N4 killed. |
| F-3 weak tests | **fixed** | M19a, M26, M16, M25, M17: all now fail (table below). |
| F-4 call-site notices | **fixed** | `main.test.ts` drives the real `main`. M20, M21 killed. |
| F-5 warning names the owner | **fixed** | `workspace-mount.ts:96,761`, `main.ts:1167`. Live: `["model","models.b"]`, an entry with a `cat` file not named. N8, N9 killed. |
| F-6 stale plan text | **mostly fixed; nit 3** | `:152-153`, F6, F15 and test item 2 corrected. |
| F-7 `__proto__` text | **fixed; nits 1, 2** | `schema.ts:75,230`. Load says `a model cannot be named "__proto__"…` for object, empty, null, array, beside a real entry and in a profile. |
| F-8 mobile typecheck | **not fixed** (needs a full install; nit 4) | `tsc -p apps/mobile` still not run. |
| Regressions | **none found** | `attack-config.ts` (masking, argv refusal, config errors) and `e2e.ts` (20 routing scenarios) give the same results as round 1, except S19's now clearer text. The `z.preprocess` on `models` did not disturb the key registry. |

**Mutations (now required to fail):** `cp` backup of the 9 source files, then `mutate.ts`. All
16 failed their tests. `shasum -a 256` of the 9 files is identical before and after;
`git status --short` empty.

| Mutation | Test that fails |
|---|---|
| M16, M25 hooks get `type.model` | "hooks get the CHOSEN model's id…" |
| M17 `has` uses `in` | "a name like __proto__ or constructor…", "a frontmatter `constructor`…" |
| M19a, M26 inherited id from the file | "env overrides of the main model…", "--model reaches an inheriting entry…" |
| M20, M21 notices off at the call site | "cli main: the models-map notices" |
| N1 relay omits the option · N4 `load` ignores it | `relay.test.ts`; "skipModelsKeyCommands runs the main command and no entry's" |
| N2 relay loads as a pod daemon (no main key) · N3 option also skips the main key | "the main key command still runs in a relay"; "skipModelsKeyCommands runs the main command…" |
| N5 prototype-swap check off · N6 own-key check off | `models-load.test.ts`; `models.test.ts` |
| N7 details off · N8 owners main only · N9 `main.ts` passes none | `explain.test.ts`; `workspace-mount.test.ts`; `main.test.ts` |

**Red team of the new code:**

- **Can the option skip the MAIN key? No.** It gates only the runner given to `resolveModelKeys`
  (`load.ts:723`); the main block above it tests `podDaemon` alone. Live with the option: main
  command runs once and its key is present; a failing main command throws `apiKeyCommand exited
  with code 4: boom`; an empty one throws; with `TENTACLE_MODEL_API_KEY`, the env key is used and
  no command runs. N2 and N3 pin it.
- **Can an entry key reach the relay's env or argv? No.** Under the option no entry command runs
  and a command-keyed entry holds no key (`own: command:-`). A literal or inherited key stays in
  memory, as with any load, and the relay reads none of them: its only uses of `config` are
  `model`, `configDir`, `cwd`, `detach`, `sessions` and `autoWake`, and `configuredModelProvider`
  takes the main fields. Its one spawn passes `process.env` plus the spec path (`relay.ts:705`);
  `RelaySpec` has no key field. No key appeared in `process.env` after a load.
- **Reserved name.** Refused in every form that could name an entry. `constructor`, `toString`,
  `prototype`, `hasOwnProperty` and `__PROTO__` stay ordinary names and load as own keys.
  `selectableModels: ["__proto__"]` is refused as not an entry. Empty map, array, null and string
  behave as before.
- **`explain` at 80 and 46 columns** (25 sections, by a walk of the tree): no line from any
  `details` exceeds the width. Over-width lines (1 at 80, 4 at 46) are single unbreakable tokens
  in child rows, already there before this change. A section with no details has no stray blank.

**Nits (none blocks):**

1. `config set models.__proto__.model x` prints 7 issues: `refuseProtoName` returns `{}`
   (`schema.ts:75`), so the reference check also reports every name as undefined. The first line
   is the right one, and a load prints only that one.
2. `{"models":{"__proto__":5}}` (or a string) loads as an empty map, because the parser ignores a
   primitive prototype. Harmless: no entry could have been meant.
3. `apiKeyFileUnknown` still appears unannotated in the plan at `:601,608,610,665`, the header
   (`:3`) still says Review pending, and `TODO.md:456` still lists `slots`.
4. F-8: run `bun run typecheck` on a full install before the merge.

**Still unexercised:** a live docker/podman/k8s run and a pair of real llama.cpp servers; the
`[models]` notice is covered by the `main` test, not observed against an engine.

**F-8 closed (orchestrator, 2026-11-08):** `bunx tsc -p apps/mobile` passes on the test build `bd14b5b` (main + this branch at 574e197, full `bun install --frozen-lockfile`). Live check (Sonnet, real deepseek agent + fake OpenAI endpoint): 6/6 PASS — per-type model, key isolation (every fake request carried only the entry key), selectableModels incl. unknown name refused, `maxParallel 2` held with 4 parallel calls, `config list` masks, detached relay starts with a failing entry key command. The startup config-error text was not produced live (`config set` refuses a bad name at write time); unit tests cover it.
