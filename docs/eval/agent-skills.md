# eval/agent-skills — support for Agent Skills (`SKILL.md`, agentskills.io)

> **Status:** promoted (2026-10-20) — sub-task 1 → `docs/feat/skills-core.md` (`feat/skills-core`, done); sub-task 2 → `docs/feat/skills-compaction.md` (`feat/skills-compaction`, done 2026-10-21; owner chose re-reading `SKILL.md` at compaction); sub-task 3 → `docs/feat/skills-slash.md` (`feat/skills-slash`, done 2026-10-21); sub-task 4 still to open. This eval stays the umbrella decision record.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat ×4 · **Size:** L → split into 4 sub-tasks (see "Owner decisions") · **Blast:** load-bearing (compaction, protocol, model-facing tool schemas) · **Suited:** strong model executes each sub-task; mandatory fresh-context Review on 2–4

## Context

*— claude-opus-5-5, 2026-10-20*

**Question being decided:** should tentacle load **Agent Skills** (the open
`SKILL.md` format, <https://agentskills.io/specification>), and if so in what
shape: where it looks for them, how the model loads one, and what happens to
them in pod mode, after compaction and for sub-agents.

The roadmap names skills as the next piece of work (`TODO.md:3`). The original
backlog entry ("packaged procedural guidance the model opts into;
complementary to the result pipeline: skills = *how to do it*, the pipeline =
*the guarantee the context stays clean*", initial commit `eea965d`) was lost in
an edit. Only a fragment of it is still in `TODO.md`. This eval replaces it.

### What the standard is (verified 2026-10-20)

From the spec and the client guide
(<https://agentskills.io/client-implementation/adding-skills-support>):

- A skill is a **directory** holding `SKILL.md`: YAML frontmatter followed by a
  Markdown body, plus optional `scripts/`, `references/`, `assets/`.
- Frontmatter: `name` (required, 1–64 chars, `a-z0-9-`, must match the
  directory name) and `description` (required, 1–1024 chars). Optional fields:
  `license`, `compatibility` (≤500 chars), `metadata` (a string→string **map**)
  and `allowed-tools` (experimental, space-separated pre-approved tools).
- **Progressive disclosure** in three tiers: (1) a catalog of name +
  description, about 50–100 tokens per skill, in context from the start of the
  session; (2) the full body (under 5000 tokens recommended), loaded when the
  skill is *activated*; (3) bundled files, read on demand.
- Discovery is client-defined. The guide recommends scanning a project scope
  and a user scope, each with a client-native directory **and** the
  cross-client `.agents/skills/` path. Many clients also scan `.claude/skills/`
  for compatibility. On a name collision the **project scope wins**, and the
  shadowing is logged.
- Activation is decided by the **model**, either through its file-read tool or
  through a dedicated tool. The user can also activate a skill explicitly
  (`/skill-name`).
- The guide's advice for clients: parse leniently (warn on name problems,
  skip only a skill with no description or unparseable YAML); **hide** filtered
  skills instead of blocking them; emit **nothing** when there are no skills;
  **protect activated skill content from compaction**; deduplicate
  activations; gate project skills on trust.

### State today (verified against `main` @ 8ea7c77)

| Fact | Evidence |
|---|---|
| tentacle has no notion of a skill | `rg -i skill packages` → only unrelated test identifiers (`wasKilled`) |
| The user **already has skills installed** that tentacle ignores | `~/.agents/skills/hf-cli`, `~/.claude/skills/{hf-cli,synced}` |
| The system prompt is built **once, at config load**, from the launch cwd: identity + optional `# Project rules (AGENTS.md)` | `config/src/load.ts:215-232`, `config/src/resolve.ts:202-214` |
| AGENTS.md discovery walks up from the cwd and stops at the `.git` root; this is the precedent for project-scope discovery | `config/src/load.ts:92-116` |
| Every runtime builds its agent from `config.systemPrompt` through one function | `cli/src/wiring.ts:77,144`; callers `serve.ts:121,238-257`, `worker.ts:97`, `main.ts:476,570` |
| A session's cwd is always the daemon's `defaultCwd`, so a catalog built at config load matches the session | `daemon/src/session-host.ts:228` |
| `fs_read` needs **no permission** and reads are **unconfined**, so the model can already read any `SKILL.md` and its files without a prompt (no allowlist needed) | `tools/src/builtins.ts:72-76`; `exec/src/host-execution.ts:9-11,207` ("Reads are intentionally unconfined") |
| Sub-agents use **their definition body as the system prompt**, not the main prompt, so they would not see a catalog placed there | `cli/src/wiring.ts:110-131`, `agent/src/agent-defs.ts:63-70`; same gap as the open TODO "Subagents don't receive AGENTS.md" |
| Compaction rebuilds history as **system prompt + a summary**, so a skill body loaded by a tool call is summarized away and the catalog survives | `agent/src/compact.ts:1-6` |
| User-defined sub-agents already use the "Markdown + frontmatter in a config subdirectory" pattern (`<configDir>/agents/*.md`) | `cli/src/wiring.ts:32-51` |
| **The existing frontmatter parser cannot read real skills.** It is line-based "YAML-ish": folded/block scalars and nested `metadata` break it, and a nested key **leaks to the top level** | repro below |
| `Bun.YAML.parse` exists on the required Bun (≥ 1.4.3) and parses the same frontmatter correctly | repro below |
| The TUI has a static slash-command table; the TUI runs over RPC, so skills (which live daemon-side, possibly in a pod) are invisible to it today | `tui/src/commands.ts:14-30`; AGENTS §7 "TUI always over RPC" |

**Repro (2026-10-20, bun 1.4.3, from the repo root):**

```
$ rg -n -i "skill" packages --glob '!**/node_modules/**'
packages/exec/test/background.test.ts:16:  let wasKilled = false;
packages/exec/test/background.test.ts:40:        wasKilled = true;
packages/exec/test/background.test.ts:56:    killed: () => wasKilled,

$ ls ~/.agents/skills ~/.claude/skills
/Users/gmeghnag/.agents/skills:
hf-cli
/Users/gmeghnag/.claude/skills:
hf-cli
synced

$ bun -e 'console.log(JSON.stringify(Bun.YAML.parse("name: a\ndescription: >-\n  multi\n  line\nmetadata:\n  author: x\n")))'
{"name":"a","description":"multi line","metadata":{"author":"x"}}

$ bun -e 'import {parseFrontmatter} from "./packages/agent/src/agent-defs.ts";
  console.log(JSON.stringify(parseFrontmatter("---\nname: a\ndescription: >-\n  multi\n  line\nmetadata:\n  author: x\n---\nbody").data))'
{"name":"a","description":">-","metadata":"","author":"x"}
```

### Decisions needed (with a recommendation each)

**Q1 — Where to look.** Recommended, in precedence order (first hit for a
name wins; a shadowed skill is reported, not silent):

1. project `.agents/skills/`: walk up from the cwd to the `.git` root, the same
   walk and bounds as AGENTS.md (`load.ts:92-116`);
2. user `<configDir>/skills/` (default `~/.config/tentacle/skills/`), next to
   `<configDir>/agents/`;
3. user `~/.agents/skills/`.

Rejected: a project-native `.tentacle/skills/`. In tentacle's own repo
`.tentacle/` is the gitignored scratch area (AGENTS §6), and `.agents/` is the
cross-client name anyway. **Owner call:** also scan `~/.claude/skills/` and
`.claude/skills/` for compatibility? It is free and picks up the user's
existing `hf-cli` and `synced`, but it loads skills written for another
harness that may name tools tentacle does not have.

**Q2 — How the model activates a skill.** Two options:

- (a) `fs_read` on the `location` given in the catalog. No new tool and it
  works today (`builtins.ts:72-76`). The harness cannot recognise the content
  afterwards (for compaction or deduplication), and a weak model may mistype
  the path.
- (b) a dedicated tool (`skill`, `name` as an **enum** of the discovered
  skills). It returns the body wrapped in `<skill_content name=…>`, the skill
  directory, and a list (not the contents) of its bundled files.

Recommended: **(b)**. The enum stops a weak model (Qwen3 27B) from inventing
names or paths, and the wrapper is what makes Q3 possible. The tool is
registered only when at least one skill exists. The catalog goes in the
**system prompt**, under a `# Skills` header after AGENTS.md, so it survives
compaction for free. Because the tool name is model-facing, it gets the same
weak-model invocation check as the `agent_task` rename.

**Q3 — Compaction.** Today `/compact` drops activated skill bodies
(`compact.ts:1-6`). The model can still see the catalog and re-activate a
skill, but it is not told that it lost one. Recommended for v1: the
compaction brief lists **which skills were active** (cheap: scan the history
for the Q2(b) tool calls) plus a one-line note "re-activate if still
relevant". Re-injecting the bodies automatically touches session/compaction
code (load-bearing) and is left for v2.

**Q4 — Pod mode (`run`/`attach`).** The daemon, and therefore discovery, runs
**in the pod**, on the pod's filesystem. Its cwd is the container's default
working directory (the image `WORKDIR`, or `/` if unset): the exec starts
`serve --stdio` with no cwd and no `TENTACLE_CWD` (`cli/src/pod-runtime.ts:328,522`),
and config falls back to `process.cwd()` (`config/src/load.ts:158`). So
"project skills" in a pod means `<WORKDIR>/.agents/skills/` and its parents up
to the `.git` root, **only if** the repo is actually in the pod at that path.
tentacle copies no code into the pod (only its own binary, `k8s/src/pod.ts:6-9`).
This is the same source as the pod's AGENTS.md today. With `attach` to a pod
that has the repo cloned in its `WORKDIR` this works. With `run` on a generic
image there is usually no repo, so no project skills. The pod's own
`~/.config/tentacle/skills/` is empty in an ephemeral pod. User skills live on
the laptop and are absent in the pod. Recommended for v1: pod sessions see
whatever the pod has (the cases above), and this is documented, not hidden.

> **Owner decision (2026-10-20):** in **`attach`** mode, laptop skills are
> **not** sent: the session uses only the skills already in the container
> (project skills under its `WORKDIR` plus the container user's skill
> directories). Whether `run` should upload laptop user skills is still open
> (see the follow-up sketch below).

*Follow-up sketch (not v1): sending laptop user skills to a `run` pod.* Reuse
the binary-injection seam (`cli/src/pod-binary.ts:1-15,132-172`, a
`head -c N > file` exec; no `tar`, because the image only guarantees `sh` +
`head`, `k8s/src/pod.ts:6-9`). Send one content-hashed bundle of the user
scopes only; the injected tentacle binary unpacks it; its path goes to
`serve --stdio` through an env var and is added as the lowest-precedence user
scope. Data moves laptop → pod only, so nothing new is gated on the laptop.
Rejected alternative: a `skill/read` RPC from the pod to the laptop. It needs
a protocol method, a laptop-side allowlist and path checks (§7), and the
scripts would still have to be copied into the pod. Sending laptop skills to the pod (laptop → pod is
allowed by AGENTS §7, it carries data in the safe direction) is a follow-up:
it needs a transport or protocol path, which makes it load-bearing.

**Q5 — Trust and `allowed-tools`.** A project skill is repo-supplied
instructions, which is exactly the trust level of the AGENTS.md that is
already auto-loaded with no gate (see the open TODO "AGENTS.md auto-load —
folder-trust gate"). Recommended: project skills fall under **that same
future gate**, with no separate mechanism. **`allowed-tools` is ignored in
v1** (warning in the diagnostics). If it were honoured, a cloned repo or a pod
could pre-approve shell commands, which breaks AGENTS §7 ("never let a
pod-originated prompt create a lasting approval for pod-supplied input").
Bundled scripts run through `shell` with the normal prompt.

**Q6 — User activation (`/skill-name`).** The TUI has no catalog (skills are
daemon-side, §7). Recommended for v1: none; the model activates skills.
Adding it means either (i) a slash command that turns into a user message
asking for the skill (no protocol change, but no autocomplete), or (ii) the
catalog on the wire, so the TUI and mobile clients can autocomplete (a new
field or method in `@tentacle/protocol`, load-bearing). Prefer (ii) when it
comes, so mobile gets it as well.

**Q7 — Sub-agents.** The catalog does not reach them (`wiring.ts:110-131`).
Recommended for v1: main session only. This is decided **together with** the
open TODO "Subagents don't receive AGENTS.md", since it is the same channel
question.

**Q8 — Parsing, limits, off switch.**
- Parse with `Bun.YAML` (repro above), not `parseFrontmatter`.
- Follow the guide's lenient rules: warn on name problems and still load;
  skip a skill with no description or with unparseable YAML.
- Bound the scan (depth and directory count), skip `.git`/`node_modules`, and
  cap the catalog size.
- Off switch mirrors AGENTS.md: config `loadSkills: false` / env
  `TENTACLE_NO_SKILLS`.
- Diagnostics (shadowed or skipped skills) go through the startup `StatusLine`,
  never as raw terminal writes (AGENTS §7).
- With no skills found, the prompt is **byte-identical** to today (same
  additive guarantee as AGENTS.md autoload).

### Owner decisions (2026-10-20)

Where a decision here differs from the recommendation above, this list wins.

| # | Decision |
|---|---|
| Q1 | **No** `.claude/skills/` scan. Scopes: project `.agents/skills/`, user `<configDir>/skills/`, user `~/.agents/skills/`. |
| Q2 | As recommended: dedicated `skill` tool, `name` as an enum, catalog in the system prompt. |
| Q3 | **Automatic re-injection in v1** (overrides the "note in the brief" recommendation): after compaction, the bodies of the skills active before it go back into the rebuilt history. |
| Q4 | Pods (`run` **and** `attach`) use only the skills already in the container. No upload of laptop skills (the sketch stays a possible follow-up). |
| Q5 | As recommended: `allowed-tools` ignored; project skills fall under the future AGENTS.md trust gate. |
| Q6 | **`/skill-name` is in scope** (overrides "none in v1"). |
| Q7 | **A sub-agent can be launched carrying a skill** (overrides "main session only"). |
| Q8 | As recommended. |
| 2 | `connect` to a remote `serve`: skills are those on the daemon's host. |
| 3 | The catalog is built at daemon start; a new skill needs a restart. Documented. |
| 4 | Project discovery starts from the **launch cwd**, the same as AGENTS.md (decided 2026-10-20, see below). |
| 5 | Skills with `disable-model-invocation: true` are **hidden from the model's catalog and the `skill` enum** but are activatable via `/skill-name`. |

**Point 4 — which cwd (decided: launch cwd).** Two cwds exist today:

- the **launch cwd**: AGENTS.md is searched from here (`config/src/load.ts:158,218`);
- the **tools cwd**: `TENTACLE_CWD` ?? config `cwd` ?? the launch cwd
  (`config/src/resolve.ts:186`).

They differ only when `TENTACLE_CWD` or a config/profile `cwd` is set. In a
pod they are always equal, because neither is passed to the exec
(`cli/src/pod-runtime.ts:328,522`). Other harnesses (checked 2026-10-20) have
no separate tools cwd, so the question does not come up for them. All three
start from the directory they were launched in and walk up:

- **Claude Code:** `.claude/skills/` "in the directory where you start it and
  in every parent directory up to the repository root". `/cd` adds the new
  directory's skills. Precedence is personal **over** project, the opposite
  of the agentskills.io guide.
- **opencode:** `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`;
  "walks up from your current working directory until it reaches the git
  worktree".
- **pi:** `.pi/skills/` and `.agents/skills/` in the working directory and its
  ancestors up to the git root, and **only after the project is trusted**.

Owner decision: start from the **launch cwd**, consistent with AGENTS.md (one
rule for both). **Follow-up decision (2026-10-20):** remove the separate
tools cwd altogether (env `TENTACLE_CWD` and the config/profile `cwd`), so the
launch folder and the working folder always coincide, as in Claude Code,
opencode and pi. That is its own task (`TODO.md`, "Remove `TENTACLE_CWD` /
config `cwd`"). Once it lands, the mismatch is gone. Until then, the known
limit holds: with `TENTACLE_CWD`/`cwd` set, project skills and AGENTS.md come
from the launch folder.

### Split (dependency order)

The decisions on Q3, Q6 and Q7 take this beyond one M task (compaction,
protocol and a second model-facing schema are all load-bearing), so it is
split per AGENTS §10:

1. **`feat/skills-core`** (M · cross-module): pure discovery, parse
   (`Bun.YAML`) and catalog rendering in a React-free module, unit-tested on a
   temp tree, with I/O in `load.ts`. Catalog in the system prompt
   (`resolve.ts`). The `skill` tool (`@tentacle/tools`, registered in
   `wiring.ts`) returns `<skill_content name=…>` + the skill directory + the
   list of bundled files, and deduplicates an already active skill. Also
   `loadSkills` / `TENTACLE_NO_SKILLS`, diagnostics through `StatusLine`, and
   hiding `disable-model-invocation` skills. No protocol or persistence change.
   Includes the weak-model invocation check on the tool.
2. **`feat/skills-compaction`** (M · load-bearing): which skills are active is
   derived from the history (the `skill` tool calls and results), not kept as
   separate state, so it survives resume and re-attach. After compaction, their
   bodies are appended to the rebuilt history (`agent/src/compact.ts`, the
   session's compact path, the daemon's compaction barrier). Open for
   Implementation: re-inject the copy stored in the history (deterministic) or
   re-read the file (fresh).
3. **`feat/skills-slash`** (M · load-bearing): the catalog goes on the wire
   (names, descriptions, user-invocable flag) so the TUI, and later mobile, can
   autocomplete. `/skill-name [args]` is resolved against that catalog in a
   pure TUI module and sent as a **structured** activation, not as prompt text
   for the daemon to parse (a path like `/tmp/x` must never trigger a skill).
   Breaking change → bump `PROTOCOL_VERSION`.
4. **`feat/skills-subagent`** (S–M · load-bearing): an optional `skill`
   parameter on `agent_task` (an enum of the same names). The sub-agent starts
   with that skill already activated. This changes a model-facing schema, so
   it gets the same weak-model check as the `agent_task` rename.

Order: 1 first; then 2 (correctness of long sessions); 3 and 4 in either order.

## Implementation

*(empty until promoted — AGENTS §10)*

## Execution

*(empty until promoted)*

## Review

*(pending: owner decisions on Q1–Q8, then a fresh-context review of the chosen v1 shape)*
