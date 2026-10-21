# Agent Skills in tentacle

How tentacle finds, offers, loads and keeps [Agent Skills](https://agentskills.io/specification)
(`SKILL.md`). This page is the reference for how the feature behaves today. The
decisions, and the reasons behind them, are in the task docs listed at the end.

Status (2026-10-21): discovery, catalog and the `skill` tool
(`feat/skills-core`), and skills kept across `/compact` (`feat/skills-compaction`)
are built. `/skill-name` and sub-agents launched with a skill are not built yet
(see [Not supported yet](#not-supported-yet)).

## The short version

1. At start, tentacle scans a few folders for `<name>/SKILL.md`.
2. Each skill's **name and description** go into the system prompt, under `# Skills`.
3. When a task matches, the **model** calls the `skill` tool with the name, and
   gets the full instructions back as a tool result.
4. A skill already loaded is not loaded twice.
5. On `/compact`, the active skills are **read again from disk** and put back
   after the summary, so the model keeps following them.

## What a skill is

A folder holding a `SKILL.md`: YAML frontmatter, then a Markdown body. It may
also hold other files (`scripts/`, `references/`, …), which the model reads on
demand with `fs_read`.

```markdown
---
name: deploy-app
description: Deploy this project to staging or production. Use when the user asks to deploy, ship or release.
---
# Deploy
1. Run `make build`.
2. Run `./scripts/deploy.sh <env>`.
```

| Field | Use in tentacle |
|---|---|
| `name` | The skill's name. It should equal the folder name. |
| `description` | Required. Goes into the catalog: it is what the model matches tasks against. |
| `disable-model-invocation: true` | Hidden from the model (catalog and tool). Meant for `/skill-name`, which is not built yet, so for now such a skill is unused. |
| `allowed-tools` | **Ignored**, with a warning. Tools keep their normal permission prompts. |
| `license`, `compatibility`, `metadata` | Parsed, not used. |

## Where tentacle looks

Three scopes, in precedence order. **The first skill found with a given name
wins**; a later one with the same name is *shadowed*, and a startup diagnostic
names both.

1. **Project:** `.agents/skills/` in the launch folder, then in each parent
   folder. The walk stops after the folder that has `.git` (the repo root), at
   the filesystem root, or just before your home folder. The nearest folder wins.
2. **User (tentacle):** `<configDir>/skills/` (by default `~/.config/tentacle/skills/`).
3. **User (cross-client):** `~/.agents/skills/`.

Details:

- The search starts from the **launch folder**, the same rule as AGENTS.md.
- `~/.agents/skills` is only ever the user scope, never a "project" one, even
  when you launch from inside your home folder.
- Only one level is scanned: `<root>/<name>/SKILL.md`. Symlinked skill folders
  are followed.
- `.claude/skills/` is **not** scanned (owner decision: those skills are
  written for another harness and may name tools tentacle does not have).
- A folder reached twice (same real path) is scanned once.

## Parsing: lenient

tentacle parses the frontmatter with `Bun.YAML` and follows the agentskills.io
client guide: problems warn, and only a skill that cannot be used is skipped.

| Case | Result |
|---|---|
| No frontmatter, YAML that does not parse, or not a key/value map | Skipped, with a diagnostic |
| No `description` (or empty) | Skipped, with a diagnostic |
| No `name` | Loaded under the folder name, with a warning |
| `name` ≠ folder name | Loaded, with a warning |
| `name` not lowercase letters, digits and single hyphens, or over 64 chars | Loaded, with a warning |
| `description` over 1024 chars | Loaded, cut to 1024, with a warning |
| `allowed-tools` present | Loaded, field ignored, with a warning |

## The catalog (system prompt)

The offered skills go at the end of the system prompt, after AGENTS.md:

```
# Skills

Skills are packaged instructions for specific tasks. When a task matches a skill's description, call the `skill` tool with its name to load the full instructions BEFORE doing the task, then follow them.

<available_skills>
<skill>
<name>deploy-app</name>
<description>Deploy this project to …</description>
</skill>
</available_skills>
```

- **No skills → nothing is added**: the prompt is byte-identical to a tentacle
  without skills.
- At most **100** skills are offered (in precedence order); a diagnostic says
  how many were left out.
- The system prompt is built **once, at start**. A new or renamed skill needs a
  restart. An edit to an existing skill's body does not (see below).
- The catalog is in the system prompt, so compaction never drops it.

## Loading a skill: the `skill` tool

The tool exists only when at least one skill is offered. Its input is
`{ name }`, and `name` is an **enum** of exactly the offered skills (the same
list as the catalog), so a model cannot invent a name or a path. It needs no
permission (`permission: "none"`), like `fs_read`.

What it returns:

```
<skill_content name="deploy-app">
# Deploy
1. Run `make build`.
…

Skill directory: /repo/.agents/skills/deploy-app
Relative paths in this skill resolve against that directory. Read bundled files with fs_read only when the instructions call for them.
<skill_resources>
<file>scripts/deploy.sh</file>
</skill_resources>
</skill_content>
```

- **The body is read when the skill is activated**, not at start, so an edit
  to `SKILL.md` is picked up without a restart. The bundled-file list comes
  from the scan at start.
- **Body cap: 50 000 characters**, cut at a line boundary. A cut body ends with
  the exact `fs_read <path>:<line>` to read the rest.
- **Already loaded → not loaded again.** The tool answers with a short note
  saying the skill is already in the conversation.
- **Read failure** (file deleted, unreadable) → an error result that names the
  file. The model is told; nothing crashes.

### What counts as "active"

There is **no separate state**. A skill is active when the history contains a
`skill` tool call whose result starts with `<skill_content name="…">`.
Consequences:

- It stays right after resume, re-attach and a daemon restart, because it is
  read from the history every time.
- An error result, a "already loaded" note, the marker typed by the user, or
  the marker inside another tool's output never count.
- A result is paired only with a call of the assistant message just before it.
  This matters for servers that reuse call ids (`call_0` on every response).

Code: `skillActivations` / `activeSkillNames` in `packages/tools/src/skill.ts`.

### The result pipeline: what happens to the skill's text

Every tool result passes through the result transforms before the model sees
it. For the `skill` result:

| Transform | Applied to `skill`? | Why |
|---|---|---|
| Secret redaction | **Yes** | Security: a key in a `SKILL.md` must not reach the model or the session file. |
| Collapse repeated lines (`dedupOutput`) | No | The instructions must arrive verbatim. |
| JSON as a table (`tabulateJson`) | No | Same. |
| Large-output spill / LLM summary (`maxInlineOutputChars`, `summarizeLargeOutput`) | No | A 32 KB skill would otherwise arrive as a head/tail preview, so it would silently not load. The tool bounds itself (50 000 chars). |

**Secret redaction is ON by default** (`tools.redactSecrets`, default `true`).
You only set it to turn it **off**: `"tools": { "redactSecrets": false }` in the
config, or the env `TENTACLE_REDACT_SECRETS=false` (the env wins over the file).
It masks private keys, JWTs, GitHub/Slack/AWS/Google/OpenAI-style keys,
`Bearer` tokens and `KEY=value` secrets (`packages/agent/src/redact.ts`).

## Compaction (`/compact`)

Without special care, compaction would throw away a loaded skill: it rebuilds
the history as the system prompt plus a summary, and the skill lives in a
tool result. tentacle keeps the active skills instead.

### What happens, in order (`Session.compact`)

1. **Re-read.** For each active skill, the original `skill` call is **run
   again**, through the same path as an activation: permission gate, tool,
   result transforms (so redaction too). The empty history it is given means
   the dedup does not stop it. An edit made to `SKILL.md` since activation is
   picked up.
2. **Budget.** At most **100 000 characters** of skill content are kept (two
   bodies at the 50 000 cap, or about 20 typical skills). Going from the most
   recent activation backwards, the first skill that does not fit, and every
   older one, is **dropped**.
3. **Summary.** The model writes the summary. The bodies of the skills being
   kept are **not** sent to it: each is replaced by
   `[skill "<name>" — its instructions are re-loaded after compaction]`.
   Dropped skills are sent in full, so the summary keeps their gist.
4. **Rebuild.** The new history is: the system prompt, the summary, then **one
   `skill` round per kept skill** (the original call, then its content). This
   is exactly the shape an activation leaves, so the skill reads as active and
   the next `/compact` finds it again (no duplicates).
5. Only now is the history replaced, all at once.

The summary ends with a note for the model, only when there is something to say:

- `The skills active before compaction are loaded again below; their instructions still apply: "a", "b".`
- `SKILL.md could not be read again for "b": the earlier copy is loaded instead.`
- `No longer in the Skills list: "c". The earlier copy is loaded instead.`
- `Not loaded again (too much skill content to keep): "z". Load one again with the skill tool if it is still needed.`

### Where the content comes from

| Situation | Content kept | `source` |
|---|---|---|
| `SKILL.md` read again | The fresh body | `fresh` |
| The read fails (file deleted, unreadable), or a transform reshaped the result | The copy already in the history | `unreadable` |
| The skill is no longer offered (removed, renamed, hidden, or skills disabled): nothing is read | The copy already in the history | `unavailable` |

An active skill is **never dropped silently**: it is either kept (fresh or from
the earlier copy) or named as dropped.

**Known consequence:** a skill that is no longer offered keeps being carried
over from its copy at every compaction. Only `/clear` (a new conversation)
removes it.

### Edge cases that are handled

- **No active skill** → compaction is exactly what it was before skills existed.
- **Summary fails, is empty, or is cancelled** → the history is not touched.
- **Cancel during the re-read** → compaction stops at once and the history is
  not touched. A read that hangs (a pod's exec, a stuck mount) cannot keep the
  session busy: the hung read is left behind, and it only reads.
- **Daemon restart after a compaction** → the skill rounds are fully answered,
  so the reload does not treat them as an interrupted turn.
- **Providers** → the rebuilt shape (`user` summary, `assistant` with a
  `skill` call, `tool` result, then the next `user` prompt) is valid for the
  Anthropic and OpenAI-compatible encoders, and was accepted by a local
  llama.cpp server.
- The TUI prints `Context compacted — N → M messages`: M now counts the skill
  rounds (2 messages per kept skill).

## Where it runs

Discovery runs inside the process that **builds the agent**, on that machine's
filesystem:

| Mode | Whose skills |
|---|---|
| TUI, plain, one-shot (in-process worker) | The laptop's |
| `serve` / `connect` | The daemon host's |
| Pod (`run` / `attach`) | The pod's only: `.agents/skills` under the container's working folder (if the repo is there), and the container user's folders. **Laptop skills are never sent to a pod.** |

Reading a body (at activation and at compaction) goes through the session's
execution environment, so in a pod it reads the pod's files.

**Sub-agents:** they do not get the catalog (their system prompt is their own
definition). A sub-agent type allowed `all` tools does get the `skill` tool.
How sub-agents should use skills is the open sub-task `skills-subagent`.

## Configuration and diagnostics

| Setting | Effect |
|---|---|
| `loadSkills: false` (config, also per profile) | No scan, no catalog, no tool. Default: on. |
| `TENTACLE_NO_SKILLS=1` | Same; the env wins over the config. |

Startup diagnostics (skipped or shadowed skills, warnings, caps reached) are
printed as `[skills] …` lines on **stderr**, right after the config loads,
before the TUI takes the screen. In the TUI you therefore see them after you
quit. They are printed for the modes that build the agent locally (TUI, plain,
one-shot, `serve`), not for `run`/`attach`/`connect`.

## All limits

| Limit | Value | Where |
|---|---|---|
| Skills offered (catalog and enum) | 100 | `MAX_CATALOG_SKILLS`, `config/src/skills.ts` |
| Name length | 64 chars (warning) | `config/src/skills.ts` |
| Description length | 1024 chars (cut, warning) | `config/src/skills.ts` |
| Folders scanned per root | 200 | `config/src/skills-scan.ts` |
| Bundled files listed per skill | 50 (then "more files not listed") | `config/src/skills-scan.ts` |
| Bundled-file depth / entries visited | 4 levels / 1000 | `config/src/skills-scan.ts` |
| Parent folders walked (project scope) | 40 | `config/src/skills-scan.ts` |
| Body returned by `skill` | 50 000 chars | `MAX_SKILL_BODY_CHARS`, `tools/src/skill.ts` |
| Skill content kept by `/compact` | 100 000 chars | `MAX_KEPT_SKILL_CHARS`, `agent/src/compact.ts` |

## Not supported yet

- **`/skill-name`** typed by the user (sub-task `skills-slash`: the catalog
  goes on the wire so the TUI can autocomplete).
- **Launching a sub-agent with a skill** (sub-task `skills-subagent`).
- **`allowed-tools`**: ignored on purpose. Honouring it would let a cloned
  repo, or a pod, pre-approve shell commands.
- **Trust gate for project skills**: a project skill is repo-supplied text,
  like AGENTS.md, which is also loaded without a gate today. Both will fall
  under the same future folder-trust gate (open TODO).
- **Picking up a new skill without a restart.**

## Where it is in the code

| Piece | File |
|---|---|
| Parse, precedence, catalog (pure) | `packages/config/src/skills.ts` |
| Folder scan (I/O) | `packages/config/src/skills-scan.ts` |
| Config switch, diagnostics, catalog in the prompt | `packages/config/src/{schema,resolve,load}.ts` |
| `skill` tool, "active" derivation | `packages/tools/src/skill.ts` |
| Tool registration, transform exemption | `packages/cli/src/wiring.ts` |
| Re-read at compaction | `Agent.reloadSkills`, `packages/agent/src/agent.ts` |
| Budget, summary note, rebuilt history | `packages/agent/src/compact.ts` |
| Compaction order | `Session.compact`, `packages/agent/src/session.ts` |
| Startup `[skills]` lines | `packages/cli/src/main.ts` |
| TUI label (`Skill <name>`) | `packages/tui/src/render-lines.ts` |

## Design records

- `docs/eval/agent-skills.md`: the decision record (owner decisions Q1–Q8,
  split into four sub-tasks).
- `docs/feat/skills-core.md`: discovery, catalog, the `skill` tool.
- `docs/feat/skills-compaction.md`: keeping skills across `/compact`.
