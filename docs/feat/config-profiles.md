# feat/config-profiles — named profiles in the user config, picked with `--profile <name>`

> **Status:** done — merged to `main` 2026-10-20 (`3dcd5fa`; in-context review) · status synced by audit 2026-10-20
> **Branch:** `feat/config-profiles`
> **Size:** S–M · **Blast:** cross-module (the config loader every runtime uses + the CLI's argument dispatch; no protocol, persistence or terminal change) · **Suited:** any model executes; standard in-context Review

## Context

*— claude-opus-5-5, 2026-10-20*

The owner wants to start `tentacle` with a different configuration per context
(a different model/endpoint, limits, MCP servers). The implicit per-project file
was evaluated and **rejected** (`docs/eval/project-config.md`): a config read
from the launch folder is written by whoever wrote the repo, and
`apiKeyCommand` / `mcpServers` / `baseURL` make that launch-time code execution
or key exfiltration. The decision (owner, 2026-10-20): **named profiles inside
the user's own `config.jsonc`**, selected explicitly with `--profile <name>`
(or `TENTACLE_PROFILE`). Nothing is ever read from the repo; every secret and
command stays in the file the user writes.

```jsonc
{
  "model": { "baseURL": "http://localhost:8080/v1", "model": "qwen3-27b" },
  "mcpServers": { "filesystem": { "command": "mcp-fs" }, "github": { "command": "mcp-github" } },
  "profiles": {
    "work": {
      "model": { "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyCommand": "pass anthropic" },
      "mcpServers": { "jira": { "command": "mcp-jira" }, "filesystem": null }
    }
  }
}
```

**Repro** (the capability is missing, and a global flag is mishandled today).
`.tentacle/tmp/config-flag/probe.ts` wraps `main()` and prints the first chat
request instead of sending it:

```ts
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  console.log(`REQUEST url=${String(input)} model=${body.model} lastUser=${JSON.stringify(body.messages?.at(-1)?.content)}`);
  process.exit(0);
}) as typeof fetch;
void real;
const { main } = await import("../../../packages/cli/src/main.ts");
const code = await main(["bun", "tentacle", ...process.argv.slice(2)]);
console.log(`exit=${code}`);
process.exit(0);
```

On `main` (`9aed85b`), 2026-10-20, `HOME=<tmp> bun probe.ts --config <file> "say hi"`:

```
REQUEST url=http://localhost:8080/v1/chat/completions model=default lastUser="--config /…/explicit.jsonc say hi"
```

A leading option that `main` does not know falls through to the one-shot path,
and **its text is sent to the model as part of the prompt** (`main.ts`
one-shot: `args.join(" ")`), with the user config's model. `--profile` would
do exactly the same. Separately, `tentacle serve --config x` started with the
user config: no subcommand rejects unknown flags (`parseFlags`,
`flags.ts:18-45`, never errors). That general bug is out of scope here (own
`TODO.md` item); this task only ensures `--profile` itself is never silently
dropped or leaked into a prompt.

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**The config is resolved once, in one place, and every runtime consumes that
resolved object.** Proven: the only `loadConfig` call is `main.ts:185`. The
worker gets the resolved `TentacleConfig` by `postMessage` (`worker.ts:51`),
`serve` reuses it (`serve.ts:82-116`), and MCP servers are spawned from
`config.mcpServers` after resolution (`main.ts:512`, `wiring.ts:175`,
`worker.ts:69`). So applying the profile inside `loadConfig`, before
`resolveConfig`, reaches every runtime with no other change.

### Preconditions

- `resolveConfig` is pure and takes a parsed `FileConfig` (`resolve.ts:169-171`),
  so a profile can be folded into the `FileConfig` before it, and env keeps
  winning over everything (`pick`, `resolve.ts:106-118`).
- The API-key precedence is env > `apiKey` > `apiKeyCommand` (`resolve.ts:252-264`).
  A naive per-key merge would let a base `apiKey` beat a profile's
  `apiKeyCommand`, and would carry a base key to a profile's other endpoint.
- The prompt file is resolved after the file config is read (`load.ts:186-198`),
  so a profile's `systemPromptFile` works if the merge happens before that.
- The schema is `.strict()` (`schema.ts:4-6`): unknown keys are loud errors.
- `main` dispatches on `args[0]` (`main.ts:140-463`). The one-shot prompt is
  the remaining argv joined, so a global option must be removed from argv
  **before** dispatch.

### Design

1. **Schema** (`schema.ts`). `ProfileSchema` is the file schema's settings with
   no `$schema` and no `profiles` (no nesting), and with `mcpServers` values
   `McpServer | null` (`null` = remove a base server). `FileConfigSchema`
   gains `profiles: record(name → ProfileSchema)`. `null` is **not** accepted
   in the base `mcpServers`.
2. **Merge**: a new pure module `profile.ts`,
   `applyProfile(file, name) → {ok, config} | {ok:false, reason}`.
   - `name` undefined → the file minus `profiles`, unchanged.
   - Unknown name → reason `unknown profile "x" (defined: a, b)` /
     `(no profiles defined)`.
   - Top-level scalars (`cwd`, `maxIterations`, `autoWake`, `loadAgentsMd`,
     `systemPromptFile`): the profile's value wins.
   - `subagents`, `tools`: merged per key.
   - `model`: per key, **except the connection group**
     `{provider, baseURL, apiKey, apiKeyCommand}`. If the profile sets *any*
     of these, the base's whole group is dropped, so a key is never sent to an
     endpoint it was not configured with, and the key source cannot cross
     over. `model`, `contextWindow` and `maxTokens` still merge per key.
   - `mcpServers`: by name. A new name is added, the same name has its whole
     definition replaced (no field merge), and `null` removes it.
   - The result never carries `profiles`.
3. **Load** (`load.ts`). `LoadConfigOptions.profile?`, else
   `env.TENTACLE_PROFILE` (empty means unset). Apply right after validation,
   before the prompt file. An error becomes a `ConfigError` naming the config
   path. `TentacleConfig.profile?` records the applied name.
4. **CLI** (`flags.ts`, `main.ts`). The pure
   `extractGlobalOptions(args) → {ok, profile?, rest} | {ok:false, error}`:
   - Leading `--profile <name>` / `--profile=<name>` only.
   - Missing or empty value, or a value starting with `-`, is an error.
   - After the leading options: if `rest[0]` is a command or mode
     (`serve`, `run`, `attach`, `connect`, `-i`, `--interactive`, `--resume`,
     `--plain`) and a `--profile` appears later, error
     "`--profile` must come before the command". In one-shot mode the rest is
     prompt text and is left untouched.
   - `--profile` with `connect` is an error: the remote daemon owns its config,
     so the flag would be a silent no-op.

   `main` calls it first, dispatches on `rest`, and passes `profile` to
   `loadConfig`. Help text: the flag, `TENTACLE_PROFILE`, and a commented
   `profiles` example in the scaffolded `config.jsonc`.

### Files

1. `packages/config/src/schema.ts`: `ProfileSchema`, `profiles`.
2. `packages/config/src/profile.ts` (new, pure) + `index.ts` export.
3. `packages/config/src/load.ts`: option/env, apply, `TentacleConfig.profile`.
4. `packages/config/src/defaults.ts`: commented example in the template.
5. `packages/cli/src/flags.ts`: `extractGlobalOptions`.
6. `packages/cli/src/main.ts`: call it first; pass `profile`; usage text.
7. Docs: this file, `TODO.md`.

### Failure modes

| Case | Outcome |
|---|---|
| `--profile x`, x not defined | `[config error] … unknown profile "x" (defined: …)`, exit 1, nothing spawned or run. |
| `--profile` with no value / `--profile --resume` | CLI error, exit 1. |
| `tentacle serve --profile x` (after the command) | CLI error "must come before the command", never a silent ignore. |
| `tentacle --profile x connect …` | CLI error (no effect on a remote daemon). |
| One-shot `tentacle --profile x fix the --profile docs` | Only the leading pair is consumed; the prompt is `fix the --profile docs`. |
| Profile changes the endpoint, base has `apiKey` | Base key dropped (connection group); the profile's own key/command, or env, or none. |
| Profile sets `apiKeyCommand`, base has `apiKey` | The profile's command runs; the base literal is not used. |
| `TENTACLE_MODEL` / `TENTACLE_MODEL_API_KEY` set | Env still wins over the profile (documented precedence). |
| `null` in the base `mcpServers`, or `profiles` inside a profile | Schema error (loud). |
| Pod `run`/`attach` | The profile is applied laptop-side; the pod daemon is unaffected (it is proxied, and has no laptop config). |

### Tests

Red first, since nothing exists yet.
- `packages/config/test/profile.test.ts` (pure): every merge rule above, with
  one mutation each (per-key merge of the connection group → the key test
  fails; field-merge of a replaced MCP server → the env test fails).
- `packages/config/test/load.test.ts`: via option, via env, option > env,
  unknown name → `ConfigError`, the profile's `apiKeyCommand` runs (spy
  runner) and the base's does not, and env model > profile.
- `packages/cli/test/global-options.test.ts`: the `extractGlobalOptions` table.
- `packages/cli/test/profile-flag.test.ts` (end-to-end through `main`, a fake
  server that captures the request): `--profile p "say hi"` sends the
  profile's model, and the user message is exactly `say hi`. This is the repro
  turned into a regression test. Plus unknown profile → exit 1, no request.

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Repro on `main` (Context): a leading unknown option leaks into the one-shot
   prompt.
2. Tests written first: `profile.test.ts`, the `load.test.ts` profile block,
   `global-options.test.ts`, `profile-flag.test.ts`. **10 fail / 15 pass** on
   the unimplemented code (missing modules; `profiles` rejected by the strict
   schema; the e2e prompt still carried `--profile p`).
3. Built in plan order: schema (`settingsShape` shared by the file and
   `ProfileSchema`, `mcpServers` nullable only in a profile) → `profile.ts`
   → `load.ts` (option › `TENTACLE_PROFILE`, applied before the prompt file,
   `TentacleConfig.profile`) → `defaults.ts` (precedence line + a commented
   `profiles` example) → `flags.ts` `extractGlobalOptions` → `main.ts` (first
   thing in `main`; help text and env list). No drift from the plan, with one
   addition: `--profile` given twice is an error (no silent last-wins).
4. Mutations, each reverted:
   - **M1** connection group merged per key → 3 red.
   - **M2** MCP server field-merged → 1 red.
   - **M3** `options.profile` ignored → 6 red.
   - **M4** dispatch on the raw argv → the e2e prompt test red.
   - **M5** no after-command check → 2 red.

   A first mutation run reported "0 fail" for all five. The cause was a broken
   harness (zsh does not word-split `$T`, so `bun test` matched nothing), not
   the tests. Caught by hand-checking M1, then re-run with an array.
5. Gate: `bun run check` → tsc clean (one test typing fix), Biome clean (after
   `--write`), **1233 pass, 2 skip (opt-in), 0 fail**.
6. Repro after the fix: `--profile p "say hi"` →
   `REQUEST … model=profile-model lastUser="say hi"`; `serve --profile p` →
   `[error] --profile must come before the command`, exit 1.

## Review

*— claude-opus-5-5, 2026-10-20*

In-context Review (cross-module, S–M: allowed by AGENTS §10). Adversarial
checks:

- **Nothing read from the repo**: the profile comes only from the user's
  `config.jsonc` (`load.ts`); the launch folder is untouched. Holds.
- **Key never crosses endpoints**: the connection group is pinned by M1 at the
  pure level and end to end (the profile's `apiKeyCommand` runs, the base's
  does not).
- **Never silent**: unknown name, missing value, repeat, after-command, and
  `connect` are all errors, each tested. *Accepted gap:*
  `tentacle --profile x --help`/`--version` ignore the profile, which is
  harmless.
- **Env inheritance**: `TENTACLE_PROFILE` reaches local children. The
  `__delete-pod` child returns before loading config (`main.ts:157`), and the
  pod daemon runs via k8s exec with the pod's own env (`pod-runtime.ts:328`,
  `:522`), so neither can fail on a profile it does not have. Holds.
- **Single load point** (load-bearing assumption): unchanged, one
  `loadConfig` call; the worker, `serve` and the MCP spawn consume its result.

Out of scope, tracked: no subcommand rejects unknown flags (`TODO.md`).
Debt: the applied profile is in `TentacleConfig.profile` but not shown in the
TUI or the one-shot header.
