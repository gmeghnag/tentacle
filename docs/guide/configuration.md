# Configuration

Precedence: **environment variables › `config.jsonc` › built-in defaults**.

`tentacle explain` reads this table's source: no argument lists the top-level
keys, `tentacle explain <section>` its sub-keys, `tentacle explain <key>` the
full card (meaning, type, allowed values, default, env, flag, whether a pod
gets it, scope, example), `--all` every leaf, `--json` for scripts. The table
below is generated from that registry (`bun run docs:config`), so a row and a
card cannot disagree; the long notes a row cannot hold are on the card.

<!-- config-keys:start -->
| Config key (`config.jsonc`) | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | — | — | A JSON-schema pointer for editor completion; accepted and ignored. |
| `apps.domain` | — | "apps.tentacle.so" | The apps host's domain. |
| `apps.enabled` | — | false | Offer the agent `app_publish` / `app_unpublish`. |
| `autoWake` | `TENTACLE_AUTO_WAKE` | true | Start a continuation turn when a background job exits while idle. |
| `beta.compactShell` | — | false | No effect on the TUI any more: a `shell` row has one shape (the phone still honours it). |
| `contextAwareness.enabled` | — | true | Whether the model is told how full its context is. |
| `contextAwareness.stepPercent` | — | 1 | A line per this many percent of the window (1–100). |
| `contextPrune.enabled` | — | false | Whether the model's copy of the history is pruned in batches. |
| `contextPrune.keepRecentRounds` | — | 6 | The last this-many assistant rounds are never pruned. |
| `contextPrune.minGainPercent` | — | 15 | …and only if it saves at least this percent of the window (1–100). |
| `contextPrune.pruneAtPercent` | — | 60 | A batch starts once the request reaches this percent of the window (1–100). |
| `contextPrune.pruneOutputChars` | — | 2000 | A shell output longer than this keeps only its head and tail once pruned. |
| `contextReset.enabled` | `TENTACLE_CONTEXT_RESET` | true | The model's `context_reset` tool renews its own context, asked like any other tool. |
| `contextReset.maxPerMessage` | `TENTACLE_CONTEXT_RESET_MAX` | -1 | Resets allowed per user message (-1 = unlimited). |
| `detach.keepAwake` | — | true | Hold a macOS sleep assertion while a turn of a detached run runs. |
| `engine` | `TENTACLE_ENGINE` | "kubernetes" | Default engine of `run`/`attach`: kubernetes, docker or podman; `--engine` wins, unknown refused. |
| `harnesses.*.adapter` | — | — | Which adapter the instance runs on; defaults to the instance name. |
| `harnesses.*.card` | — | — | An `a2a` agent's card URL (`https:`; `http:` only for localhost). |
| `harnesses.*.command` | — | — | The executable to run (unset: `claude`). |
| `harnesses.*.description` | — | — | Your description of an `a2a` agent, shown to the model first and listed in the system prompt's environment block. |
| `harnesses.*.enabled` | — | — | Offer this harness's sub-agent type (default on). |
| `harnesses.*.idleMinutes` | — | — | Hang guard: a run with no output for this many minutes is stopped (unset: 15; `a2a`: 30). |
| `harnesses.*.inputFrom` | — | — | Who answers an `a2a` agent's questions: `user` (default), `parent` or `both`. |
| `harnesses.*.model` | — | — | The model when an `agent_task` call names none (unset: `opus`). |
| `harnesses.*.tokenCommand` | — | — | A command printing an `a2a` agent's bearer token (never the token itself). |
| `hooks` | — | — | Shell commands run on agent events, with a JSON input on stdin. |
| `liveActivity.enabled` | — | `true` | Whether a `serve` starts a live activity at all. |
| `liveActivity.startAfterSeconds` | — | `20` | How long a turn must run before a phone that is not watching it gets an activity. |
| `loadAgentsMd` | `TENTACLE_NO_AGENTS_MD` (inverted) | true | Auto-load a per-repo `AGENTS.md` into the system prompt. |
| `loadSkills` | `TENTACLE_NO_SKILLS` (inverted) | true | Discover Agent Skills and offer the `skill` tool. |
| `maxIterations` | `TENTACLE_MAX_ITERATIONS` | 16 | Max model/tool iterations per turn. |
| `mcpServers.*.args` | — | — | Arguments passed to `command`. |
| `mcpServers.*.command` | — | — | The executable to spawn (a stdio server). |
| `mcpServers.*.cwd` | — | — | Working directory for the server process. |
| `mcpServers.*.env.*` | — | — | One variable of the server's environment. |
| `mcpServers.*.headers.*` | — | — | One header sent with the server's requests. |
| `mcpServers.*.readOnlyTools` | — | — | Which of its tools count as reads: `hint` (default: those it marks `readOnlyHint`), `none`, or a list. |
| `mcpServers.*.type` | — | — | How the server is reached: `stdio` (spawned) or `http` (Streamable HTTP). |
| `mcpServers.*.url` | — | — | The server's MCP endpoint (an http server). |
| `model.apiKey` | `TENTACLE_MODEL_API_KEY` | — | A literal API key — stored in plaintext (prefer `apiKeyCommand`). |
| `model.apiKeyCommand` | — | — | A shell command whose stdout is the key; never written to disk. |
| `model.autoTitle` | — | false | Ask a model to name each session after its first exchange. |
| `model.baseURL` | `TENTACLE_MODEL_BASE_URL` | `http://localhost:8080/v1` (openai) or `https://api.anthropic.com/v1` (anthropic) | The endpoint, including its API version. |
| `model.contextWindow` | `TENTACLE_CONTEXT_WINDOW` | 128000 | The context window in tokens: the fill meter and the model's context line. |
| `model.imageDetail` | — | — | The detail image_view sends a PDF's picture at: auto, low or high. |
| `model.imageTokens` | — | — | Tokens one image costs the context estimate (prune and the meter). |
| `model.images` | — | — | Whether this model takes images at all (an attached screenshot reaches it). |
| `model.maxImageBytes` | — | — | Raw bytes one image may have on this model's wire (its own limit). |
| `model.maxTokens` | `TENTACLE_MAX_TOKENS` | omitted for openai (the server decides); `64000` for anthropic | Max output tokens per response (`max_tokens` on the wire). |
| `model.model` | `TENTACLE_MODEL` | "default" | The model id sent to the endpoint (`--model <id>` beats it, for that command). |
| `model.provider` | `TENTACLE_PROVIDER` | "openai" | The API flavour: `openai` (chat/completions) or `anthropic` (Messages). |
| `model.titleModel` | — | — | The model id that writes those titles, e.g. a cheaper one. |
| `models.*.apiKey` | — | — | A literal API key for this entry — stored in plaintext (prefer `apiKeyCommand`). |
| `models.*.apiKeyCommand` | — | — | A shell command whose stdout is this entry's key; run at startup. |
| `models.*.autoTitle` | — | — | Accepted for the shape of `model`; has no effect inside an entry. |
| `models.*.baseURL` | — | — | The endpoint; unset with no other connection key: `model`'s. |
| `models.*.contextWindow` | — | — | This model's context window in tokens; unset: `model`'s. |
| `models.*.description` | — | — | When to pick this model — shown to the agent when it is selectable. |
| `models.*.images` | — | — | Whether this model takes images at all; unset: `model`'s. |
| `models.*.maxImageBytes` | — | — | Raw bytes one image may have on this model's wire; unset: `model`'s. |
| `models.*.maxTokens` | — | — | Max output tokens per response; unset: `model`'s. |
| `models.*.model` | — | — | The model id sent to the endpoint; unset: `model`'s. |
| `models.*.provider` | — | — | The API flavour; setting it (or any connection key) inherits no endpoint or key from `model`. |
| `models.*.titleModel` | — | — | Accepted for the shape of `model`; has no effect inside an entry. |
| `mount.hide` | — | — | The paths to hide — this list REPLACES the default one. |
| `mount.hideExtra` | — | — | Extra paths to hide, ADDED to the default list. |
| `network` | `TENTACLE_NETWORK` | — | Network of `run`'s container: a name, or `none` for air-gapped runs; `--network` wins. |
| `packages.*` | — | — | Whether this installed package is enabled. |
| `push.enabled` | — | `true` | Whether this `serve` pushes notifications to its paired phones. |
| `push.graceSeconds` | — | `30` | How long an unanswered permission request waits before a phone is pushed. |
| `relay.enabled` | — | `true` | Whether `serve` dials the mobile relay at all. |
| `relay.url` | — | `wss://relay.tentacle.so` | Which relay `serve` dials. |
| `rm` | — | false | Whether `run` removes its pod/container when the run ends. |
| `schedules.expiryDays` | — | 7 | A recurring wake's life, and its longest interval, in days (1–30). |
| `schedules.maxAheadDays` | — | 7 | How far ahead a one-shot wake may point, in days (1–30). |
| `schedules.maxJobs` | — | 10 | Live scheduled wakes per session (1–100). |
| `schedules.minIntervalMinutes` | — | 1 | The shortest recurring interval, in minutes (1–1440). |
| `schedules.promptMaxChars` | — | 2000 | The longest prompt a scheduled wake may carry (1–20000). |
| `sessionHop.tool` | `TENTACLE_SESSION_HOP_TOOL` | false | Offer the agent `move_session` (OFF by default): it may propose moving this session to another target. |
| `sessions.keepSuperseded` | — | — | Keep the history a compaction or a `context_reset` replaced in the session file. |
| `subagents.agentTaskDescription` | — | — | Replaces the `agent_task` description (max 4096 bytes; the sub-agent types are appended). |
| `subagents.agentTaskDescriptionFile` | — | — | The same description, read once at start from a file (config dir or absolute; not both). |
| `subagents.enabled` | `TENTACLE_SUBAGENTS` | true | Whether the `agent_task` sub-agent tool is offered. |
| `subagents.execution` | `TENTACLE_SUBAGENT_EXECUTION` | "parallel" | `agent_task` overlap: `parallel` (default; they share one workspace), `read-only`, `sequential`. |
| `subagents.maxIterations` | `TENTACLE_SUBAGENT_MAX_ITERATIONS` | 50 | Step limit for a sub-agent's own loop. |
| `subagents.maxParallel` | `TENTACLE_SUBAGENT_MAX_PARALLEL` | 4 | At most this many sub-agents at once — the only limit; match it to your server. |
| `subagents.maxTokens` | `TENTACLE_SUBAGENT_MAX_TOKENS` | 2000000 | Token budget for a sub-agent's whole life. |
| `subagents.selectableModels` | — | — | `models` entries the agent may pick per `agent_task` call; absent or empty: off. |
| `subagents.twoWay` | `TENTACLE_SUBAGENTS_TWO_WAY` | false | Background sub-agents may message the agent (`agent_notify`); a message wakes an idle agent. |
| `subagents.types.*.model` | — | — | The `models` entry this type runs on (beats the type's `agents/*.md` `model`). |
| `systemPromptEnvironment` | — | true | State the working directory and platform at the end of the system prompt. |
| `systemPromptFile` | `TENTACLE_SYSTEM_PROMPT` (inline, not a path) | `PROMPT.md` in the config dir | The system prompt file: relative to the config dir, or absolute. |
| `tools.dedupOutput` | `TENTACLE_DEDUP_OUTPUT` | true | Collapse runs of identical consecutive output lines. |
| `tools.enabled.*` | — | — | Whether this built-in tool or group is offered to the model. |
| `tools.execution` | `TENTACLE_TOOL_EXECUTION` | "read-only" | Tool calls in a round: `read-only` (default; reads together, writes and `shell` alone), `sequential`, `parallel`. |
| `tools.maxInlineOutputChars` | `TENTACLE_MAX_OUTPUT_CHARS` | 16000 | Max characters of a tool result kept inline before it is spilled. |
| `tools.maxParallel` | `TENTACLE_TOOL_MAX_PARALLEL` | 8 | At most this many calls of a round at once (`1` = sequential). |
| `tools.outputRetentionDays` | `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS` | 30 | Days a spilled tool output is kept (swept when the daemon starts). |
| `tools.redactSecrets` | `TENTACLE_REDACT_SECRETS` | false | Mask keys, tokens and credentials in tool output. |
| `tools.summarizeLargeOutput` | `TENTACLE_SUMMARIZE_OUTPUT` | false | Replace large output with a model-written summary (full text still spilled). |
| `tools.tabulateJson` | `TENTACLE_TABULATE_JSON` | false | Render a JSON array-of-objects result as a compact table. |
| `tools.writableDirs` | `TENTACLE_WRITABLE_DIRS` (`:`-separated; empty = `[]`) | the system temp dir (`$TMPDIR`) and `/tmp` | Where `fs_write`/`fs_edit`/`fs_multi_edit` may write besides the project. |
| `tui.chartGlyphs` | — | "braille" | A chart's plot glyphs: `braille` (2×4 dots per cell) or `blocks` for a font with no braille. |
| `tui.theme` | — | "auto" | The palette: `auto` probes the terminal, `dark`/`light` force one; never carried to a pod. |
| `voice.autoStop` | — | false | Finish the dictation on a pause instead of on the key. |
| `voice.autoStopSilenceMs` | — | 500 | The pause that ends a dictation when `voice.autoStop` is on. |
| `voice.enabled` | — | false | Whether the terminal's voice features (Ctrl+R dictation; conversation mode later) are on. Off by default. |
| `voice.engine` | — | "apple" | Which on-device recogniser transcribes the dictation. |
| `voice.helperPath` | — | — | The voice helper binary, when it is not next to `tentacle`. |
| `voice.input` | — | "default" | Which microphone the dictation captures from. |
| `voice.key` | — | "ctrl+r" | The key that starts and finishes a dictation. |
| `voice.language` | — | "auto" | The spoken language. |
| `voice.maxSeconds` | — | 300 | The hard cap on one dictation. |
| `voice.modelsDir` | — | — | Where the Parakeet models live. |
| `voice.voiceProcessing` | — | true | Apple's voice processing (echo cancellation, noise suppression, gain) on the capture. |
| `workloadShell.tool` | `TENTACLE_WORKLOAD_SHELL_TOOL` | false | Offer the agent `workload_shell`: a stateful, non-interactive `sh` on a pod or container. |
<!-- config-keys:end -->

**`--model <id>` and `--profile <name>`** are flags of the commands that start a
session, written **after** the command: `tentacle run --image x --model m`,
`tentacle attach box --model m`, `tentacle serve --model m`, and for the bare
local session right after `tentacle` (`tentacle --model m`, `tentacle -i
--profile p`, `tentacle --resume --model m`, `tentacle --plain …`, a one-shot
`tentacle --model m "prompt"`). `--model` is `TENTACLE_MODEL`'s twin: that model
id on the active profile's endpoint (the context window stays the profile's),
no config change; `--profile` beats `TENTACLE_PROFILE`. `attach` uses the run's
own model unless one is given. `serve --model` is the model its `connect`
clients use: `connect` itself, like `ps`, `rm`, `update`, `hooks` and
`package`, refuses both (`tentacle --model m run …`, before the command, is an
error naming the right form).

Key precedence: `TENTACLE_MODEL_API_KEY` › file `apiKey` › file `apiKeyCommand`.
`TENTACLE_CONFIG_DIR` (or `XDG_CONFIG_HOME`) moves the config directory.

## Editing config from the CLI

`tentacle config` edits `config.jsonc` for you, keeping its comments, layout and
key order — only the key you name changes (`bun run docs:config` still owns the
table above, so nothing here is generated):

```sh
tentacle config subagents.maxParallel=3     # the shorthand: <key>=<value>
tentacle config set model.model qwen3       # the same, as two words
tentacle config set tools.writableDirs '["/tmp","~/scratch"]'
tentacle config --unset subagents.maxParallel
tentacle config get subagents.maxParallel   # the value as stored (--json)
tentacle config list                        # every KNOWN setting: value + its origin
tentacle config list --set                  # only the settings this file holds
tentacle config path                        # which file these edit
```

`config list` walks the key registry, so a setting you never wrote is listed too,
with the value it really has and where that value comes from:
`model.images = false  # default (openai-compatible)`, `maxIterations = 8  # file`,
`model.model = "work-id"  # profile work`, `engine = "docker"  # env TENTACLE_ENGINE`.
A key with no value at all reads `(unset)  # no default`. `config get <key>` answers
for an unset key with the same line (exit 0) instead of failing; a key the registry
does not know is still refused. `--set` keeps the file-only list for scripts.

A value is typed by the key, not guessed: `true`/`false` for a boolean, a number
for a numeric key, one of the listed values for an enum, and JSON for an array or
an object. A string is taken as written, so no quoting is needed for a URL (a
value that starts with `"` and parses as a JSON string is accepted as that
string). Nothing is written unless the whole file still validates, and every
schema issue is printed — a refused edit leaves the file byte for byte as it was.

`--profile <name>` targets `profiles.<name>.` in the same file, so
`tentacle config model.model small --profile work` only changes that profile.
`unset` of a whole section or profile asks first (`--yes` skips the question).

A secret is never accepted on the command line (it would be visible in your
shell history and in `ps`): pipe it in, or let it prompt without echo — and
`get`/`list` print it as `***` (as they do every MCP server's `env`, `headers`
and `args`). The registry's secret set is the only thing masked: a key it does
not know — a typo, or a key in the wrong place (`"model": { "foo": "x" }`) —
prints its value in clear, so the mistake is visible:

```sh
printf '%s\n' "$KEY" | tentacle config model.apiKey -
tentacle config model.apiKey          # prompts with no echo
```

It is still stored in **plaintext** in that file (mode `0600`), which the
command says when it succeeds; `model.apiKeyCommand` — a command whose output is
the key at startup — keeps it out of the file entirely.

A change applies to **sessions started after it**: a running `serve` daemon keeps
its value until restarted, and on `run`/`attach` the laptop's value is carried to
a pod when a session is opened (a few settings, like `tools.writableDirs`, are
the pod's own and are never carried).

