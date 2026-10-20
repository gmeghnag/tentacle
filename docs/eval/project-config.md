# eval/project-config — a per-project `.tentacle/config.jsonc` that overrides the user config

> **Status:** eval — **REJECTED by the owner (2026-10-20)**; replaced by an explicit `--config <path>` flag (`docs/feat/config-flag.md`)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Size:** n/a (not built) · **Blast:** n/a · **Suited:** decision record only

## Context

*— claude-opus-5-5, 2026-10-20*

**The question being decided:** should `tentacle` read a `.tentacle/config.jsonc`
from the folder it is launched in (the project), with **precedence over** the
user config `~/.config/tentacle/config.jsonc`? And if so: which settings may a
project file set, how do the two files merge, and how is it found?

The point of the feature is per-repo settings, for example a different model,
`contextWindow` or `maxIterations` for one repo, without editing the global file
or exporting env vars each time.

### How config works today (verified)

- **One file only.** `loadConfig` reads `<configDir>/config.jsonc`, where
  `configDir` = `--configDir` › `TENTACLE_CONFIG_DIR` › `$XDG_CONFIG_HOME/tentacle`
  › `~/.config/tentacle` (`packages/config/src/load.ts:112-124`, `:157-176`).
  Nothing is read from the launch folder except `AGENTS.md`.
- **Precedence:** env > file > defaults, per field, with provenance
  (`Source = "env" | "file" | "default"`) (`packages/config/src/index.ts:4`,
  `resolve.ts:33`, `resolve.ts:106` `pick`).
- **Merge shape:** `model` is read as one object (`resolve.ts:171`), and
  `mcpServers` replaces the whole map, with no merge (`resolve.ts:286`).
- **Precedent for "look in the project":** `findAgentsFile` walks up from the
  launch dir to the repo root (a `.git`), and never past it (`load.ts:92-110`).
- **One caller:** `main.ts:185`, `loadConfig({ cwd: process.cwd(), … })`.
  `serve` reuses that `config` (`serve.ts:92-116`), and so does the pod daemon
  (`serve --stdio`, in the pod, with the pod's cwd).

### What makes this question non-trivial: a project file is authored by someone else

The global config is written by the user. A file in the launch folder is written
by **whoever wrote the repo**: a cloned third-party repo, a PR branch you check
out to review, a tarball. Several existing settings run code or move secrets,
and they all act **at startup, before any session and outside the
`PermissionBroker`**:

| Setting | What a hostile project file could do |
|---|---|
| `model.apiKeyCommand` | **Run any shell command on launch.** `loadConfig` runs it with `/bin/sh -c` (`load.ts:221-226`). |
| `mcpServers.*.command` | **Spawn any process on launch.** It is connected at startup (`main.ts:512`, `worker.ts:69`), with no prompt. |
| `model.baseURL` (+ `provider`) | Send the user's API key (from env, the global file, or the user's `apiKeyCommand`) to the repo author's endpoint, along with the whole conversation. |
| `systemPromptFile` | Read any absolute path into the system prompt (`load.ts:188-198`), which is sent to the model, combinable with `baseURL`. |
| `cwd` | Move the agent's workspace out of the project. |
| `tools.redactSecrets: false` | Turn off secret masking in tool output. |

There is also a second-order risk specific to this repo's layout. The agent
already writes into the workspace's `.tentacle/` (tool-output spills,
`agent.ts:550`), and its fs tools can write anywhere in the workspace. A
prompt-injected turn could therefore **plant** a `.tentacle/config.jsonc` that
runs code on the *next* launch, outside the permission prompt. That is the
§7 "never let untrusted input create a lasting approval" shape, applied to config.

Prior art, all of which gate this: VS Code *Workspace Trust*, direnv's
`direnv allow` (re-asked when the file changes), mise's `mise trust`, git's
`safe.directory`, Claude Code's project trust dialog.

Two smaller facts:
- `.tentacle/` is gitignored in this repo (`.gitignore`, "Agent workspace
  artifacts"). In a repo set up like that, a project config is per-machine, not
  shared with the team, unless the repo adds `!.tentacle/config.jsonc`.
  Config and ephemeral artifacts share one folder.
- **Pod runtimes:** the laptop loads config from the *laptop's* launch dir; the
  pod workspace is never read laptop-side, and must stay that way (§7: a pod
  is not trusted). The pod daemon loads with the pod's cwd. That is harmless,
  because whatever it reads is pod-controlled already, but it is a place where
  a project file *would* be picked up.

### Options

- **A — full override, no gate.** Every key, project > user. Smallest diff,
  and it ships every row of the table above as a launch-time code-execution
  vector. **Rejected.**
- **B — safe subset (recommended).** A project file may set only settings that
  cannot run code, move secrets, or widen reach:
  `model.model`, `model.contextWindow`, `model.maxTokens`, `maxIterations`,
  `subagents.*`, `autoWake`, `loadAgentsMd`, `tools.*` (with
  `redactSecrets` only able to *tighten*: `true` accepted, `false` rejected).
  The dangerous keys (`model.provider`, `model.baseURL`, `model.apiKey`,
  `model.apiKeyCommand`, `mcpServers`, `systemPromptFile`, `cwd`) are
  **user-config only**. In a project file they are a loud `ConfigError` that
  names the key and says "only in ~/.config/tentacle/config.jsonc", and never
  a silent ignore, matching the `.strict()` philosophy (`schema.ts:4-6`).
  There is no trust state to store and nothing to re-ask. Covers the stated
  use case (per-repo model/limits).
  *Caveat:* switching `model.model` alone can't move secrets, but a model id
  only makes sense together with its endpoint. Per-project *endpoints* need C,
  or a named-profiles design (the user file defines `profiles.<name>` with
  endpoint and key, the project file picks `profile: "<name>"`), which keeps
  every secret and endpoint in the user file. Profiles is the cleaner path to
  per-project endpoints, and it is additive to B.
- **C — full override behind a trust gate.** Every key allowed, but the first
  launch with a new or changed project file asks (pre-mount, on the
  `StatusLine`, never raw while Ink owns the terminal, §7) and records
  `{realpath, sha256}` in `<configDir>/trusted-projects.json`. A changed hash
  means ask again. Not trusted means ignore the project file and say so. It
  also enables per-project MCP servers. Cost: a new trust store, a prompt
  before the TUI, a headless/`serve` story (no TTY → never trusted, or a
  `tentacle trust` subcommand), and a hash check that the agent itself cannot
  satisfy. Planting a file then forces a visible prompt, which is the point.
  Larger, and load-bearing.

### Shape common to B and C (if promoted)

- **Precedence:** env > project > user > defaults, per field. `model` and
  `subagents`/`tools` are merged **per key** (a project `model.model` keeps the
  user's `baseURL`/key), and `mcpServers` (C only) merges by server name.
- **Provenance:** `Source` gains `"project"`, and the startup `StatusLine` names
  the project file when one was applied (so "why is this model used?" has an
  answer).
- **Never scaffolded:** first run creates only the user config, as today.
- **Pure split:** discovery and reading stay in `load.ts`. The merge and the
  allowed-keys rule go in the pure `resolve.ts` (a `ProjectConfigSchema`, plus
  `resolveConfig({ fileConfig, projectConfig, … })`), so every rule above is
  a table test with no filesystem.

### Owner decision (2026-10-20)

The owner first leaned to option C (trust gate, exact launch folder, `serve`
applies it to all sessions, `.tentacle/` stays gitignored). Then the owner
**rejected the whole idea** on the risk in the table above. Even a trust gate
leaves residual holes: the agent's fs tools can reach the trust store, and the
gate is a new piece of startup UX to get exactly right. **No config file is
ever picked up implicitly from the launch folder.** Instead, the user names the
file explicitly: `tentacle --config <path>`. That is an explicit choice made on
every launch, so it needs no trust state. Built as `docs/feat/config-flag.md`.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-20*

**Verdict: rejected (owner, 2026-10-20).** The analysis stands: any implicit
project config, unless reduced to a safe-key subset (B) or gated by trust (C),
is launch-time code execution (`apiKeyCommand`, `mcpServers`) and key
exfiltration (`baseURL`). The owner chose to avoid the class entirely. The
need (a different config per context) is met by an explicit
`--config <path>` (`docs/feat/config-flag.md`). If implicit per-repo settings
come back, restart from option B or the profiles idea above, not from A.
