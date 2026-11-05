# eval/project-config — config layering: container > repo `.tentacle/` > global, and which keys may be layered

> **Status:** eval — **REOPENED by the owner (2026-11-05)**; awaiting the owner's answers below. Rejected once on 2026-10-20 (see History).
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat · **Size:** L if promoted, to be split (slices under Recommendation) · **Blast:** load-bearing (§7 "a pod is not trusted", the config loader every runtime uses) · **Suited:** per §10, with a mandatory fresh-context Review

## History

*2026-10-20.* The question was a `.tentacle/config.jsonc` in the launch folder
with precedence over the user config. Analysis: `model.apiKeyCommand` and
`mcpServers.*.command` make an implicit file launch-time code execution, and
`model.baseURL` makes it key exfiltration, all outside the `PermissionBroker`. A
prompt-injected turn could also plant the file for the next launch. The owner
first leaned to a trust gate, then **rejected the whole idea**: "no config file
is ever picked up implicitly from the launch folder". The need was met by named
profiles (`docs/feat/config-profiles.md`, merged `3dcd5fa`; the planned
`--config <path>` flag was never built). That Review said: if implicit per-repo
settings come back, restart from the safe-key subset or from profiles, not from
full override. This refresh does so.

## Context

*— claude-opus-5-5, 2026-11-05*

**The question being decided.** The owner wants layering
**container > repo `.tentacle/` > global `~/.config/tentacle`** for "all"
settings, to be defined. The owner also decided, on 2026-11-05 for task 7
(`feat/parallel-agents`), that **sub-agent settings use the laptop's active
profile value, else global, CARRIED into the pod like `--context-window`**. The
two conflict as stated: the first lets the container win, the second lets the
laptop win. Which settings may come from the container or the repo, which must
stay on the laptop (§7), and how does a repo file behave in each runtime?

The conflict dissolves if "all" means "all settings of the class that describes
the workspace". Each key has one owner, set out in the inventory below.

References: `§7` is AGENTS.md §7; `§3.N` is item N of "Punti da rivedere" in
`docs/container-config-sources.md`.

### How config works today (verified on `main` @ `b02818f`)

- **One user file per side.** `<configDir>/config.jsonc`
  (`packages/config/src/load.ts:374-385`, `:437-451`), parsed `.strict()`
  (`schema.ts:345-353`). An invalid one is fatal (`load.ts:440-447`,
  `packages/cli/src/main.ts:547-549`).
- **Precedence:** env > active profile > file > default (`resolve.ts:165-177`,
  `load.ts:453-460`). `Source` is `env | file | default` (`resolve.ts:40`).
- **The pod daemon runs the same loader**, with the pod's env, `HOME` and cwd,
  once at start (`main.ts:538-546`). So a container layer already exists: it is
  the pod's own `config.jsonc`, usually absent, which means defaults
  (`docs/container-config-sources.md` §3.1).
- **Carried today, two keys only:** `podDaemonCommand` passes `--context-window`
  and `--auto-title` in argv (`packages/cli/src/engine-runtime.ts:76-89`), and
  they replace the pod's values (`packages/cli/src/serve.ts:393-398`). A resident
  already running keeps the flags of the exec that started it
  (`engine-runtime.ts:74`).
- **`--profile` / `--model` stay on the laptop**: the pod gets neither
  (`docs/container-config-sources.md` §2.1).
- **`connect`** sends no provider (`packages/cli/src/connect.ts:129`) and refuses
  `--profile`. The `serve` host's config rules (`docs/feat/config-profiles.md`).

Repo files are **already** read implicitly, since the 2026-10-20 decision:

| File | Read by | Gate | Failure |
|---|---|---|---|
| `AGENTS.md` (`load.ts:178-196`) | the side building the agent | none; a prompt, no code | best-effort |
| `.agents/skills/` (`skills-scan.ts:49-74`) | same | none; each skill is prompt text | diagnostic |
| `.agents/hooks.json` (`hooks-scan.ts:16`) | same | trust prompt on the laptop (`wiring.ts:306-331`), stored only for a local worker (`local-runtime.ts:544-550`) | diagnostic, "never a failed startup" (`hooks-scan.ts:7-8`) |
| `.tentacle/hide` (`workspace-mount.ts:201-207`) | the **laptop**, before a mount (`engine-select.ts:365-379`) | add-only | refuses, loud (fail-closed; it protects secrets) |

So the 2026-10-20 rule has already softened for files that cannot run code or
only tighten. An allowlisted config is the same shape. `AGENTS.md` matters as a
baseline: a repo can already inject instructions into the prompt, a stronger
lever than any key the allowlist below admits.

### Inventory: every key, classified

Classes:

- **L — laptop-only.** Resolved from the user's global file or profile on the
  user's own host. Refused in a repo file. Never carried. Inert in a pod's file.
- **P — pinned, carried.** The laptop decides and carries the value. It beats the
  pod's file and env, and it is refused in a repo file. The task-7 class.
- **W — workspace.** Describes how the agent works on this code. Container and
  repo may override. The laptop's value is carried as the lowest layer.
- **C — container-only.** The pod's own file may set it, for effects in the pod.
  Refused in a repo file. Never carried, because it runs code or reads paths.

On the user's own host (local session, `serve`) P, C and L keys come from the
global file and profile, as today. All lines below are `packages/config/src/schema.ts`
unless noted.

| Key | Line | Class | Repo | Container | Reason |
|---|---|---|---|---|---|
| `$schema` | 348 | — | ok | ok | Ignored by design. |
| `profiles` | 351 | L | no | inert | A profile holds connection keys and commands. The name is not forwarded, because a pod has no such profile. |
| `model.provider` | 16 | L | no | inert | §7: the model stays on the laptop (`wiring.ts:280`). |
| `model.baseURL` | 18 | L | no | inert | A repo value sends the key and conversation to the repo author's endpoint. |
| `model.model` | 20 | L | no (Q5) | inert | The pod never names a model. A repo choice moves code between the user's endpoints or changes cost. |
| `model.autoTitle` | 26 | P | no | overridden | Already carried. The laptop serves the call and gates it (`engine-runtime.ts:98-111`). |
| `model.titleModel` | 32 | L | no | inert | The laptop picks it (`engine-runtime.ts:106-109`). |
| `model.apiKey` | 37 | L | no | inert | A secret; never in a pod or repo. |
| `model.apiKeyCommand` | 43 | L | no | **runs today** | Runs code at load (`load.ts:516-517`). In a pod's file it runs in the pod, and a non-zero exit is a fatal `ConfigError` (`load.ts:393-395`) for a value the tunnel never uses. See Notes. |
| `model.contextWindow` | 45 | P | no | overridden | Already carried. The window is the model's (`serve.ts:366-368`). |
| `model.maxTokens` | 47 | L | no | inert | Applied by the laptop's provider (`packages/cli/src/model-provider.ts:26`). |
| `hooks` | 186 | C | no | ok | Shell commands. The repo route is `.agents/hooks.json` behind trust. |
| `systemPromptFile` | 191 | C | no | ok | Reads any path into the prompt (`load.ts:465-472`). A repo value could read `~/.ssh/id_rsa`. |
| `loadAgentsMd` | 197 | W | `false` only | ok | Tighten-only: a user who disabled repo prompts globally must not be overruled by the repo. |
| `loadSkills` | 205 | W | `false` only | ok | Same. |
| `maxIterations` | 207 | W | ok | ok | Worst case is cost (default 16, `defaults.ts:11`; a repo may say -1). Named in the notice. |
| `subagents.enabled` | 216 | P | no | overridden | Owner decision, task 7. |
| `subagents.maxIterations` | 218 | P | no | overridden | Owner decision, task 7. |
| `subagents.execution` *(`feat/config-carry`; task 7 reads it)* | 228 | P | no | overridden | Owner decision, task 7. |
| `subagents.maxParallel` *(`feat/config-carry`; task 7 reads it)* | 230 | P | no | overridden | Load on the laptop's endpoint. The cap comes from that endpoint's slots (`docs/eval/parallel-execution-plan.md:616`), which a pod cannot probe. |
| `contextAwareness.enabled`, `.stepPercent` | 233, 235 | W | ok | ok | Prompt lines only. The window is P, the switch stays workspace (`serve.ts:368`). |
| `contextReset.enabled`, `.maxPerMessage` | 243, 245 | W | ok | ok | Agent behaviour; no reach beyond the session. |
| `autoWake` | 257 | L *(corrected 2026-11-05, was W)* | no | inert | Its only reader is the laptop's TUI (`packages/tui/src/App.tsx:658`, `packages/cli/src/main.ts:834`): no daemon or agent code reads it, so carrying it would be a dead field. Whether a repo file may set it locally is for `feat/project-config`. |
| `engine` | 262 | L | no | inert | Chooses where code runs, and which credentials the laptop dials with (`main.ts:740`). |
| `keep` | 267 | L | no | inert | A repo's `false` would delete a workload and its state at exit (`main.ts:876`, §7 lifecycle). |
| `detach.keepAwake` | 272 | L | no | inert | The relay's power assertion (`packages/cli/src/relay.ts:178`). |
| `mount.hide` | 283 | L | no | inert | Replaces the default list, so a repo's `[]` would expose `~/.ssh` to the container (`main.ts:945`). |
| `mount.hideExtra` | 284 | L | no | inert | The repo route exists: `.tentacle/hide`, add-only. |
| `mcpServers` | 289 | C | no | not started today | Spawns processes. A pod starts none today (`packages/daemon/src/session-host.ts:126`). See Q9. |
| `packages` | 295 | C | no | ok | A repo could switch off a package carrying the user's own safety hooks. |
| `tools.maxInlineOutputChars` | 303 | W | ok | ok | Worst case is context cost. |
| `tools.redactSecrets` | 305 | W | `true` only | ok | Tighten-only. In a pod the redaction runs in the pod, so a `false` there removes nothing a hostile pod could not skip anyway. |
| `tools.dedupOutput` | 307 | W | ok | ok | Shaping only. |
| `tools.tabulateJson` | 309 | W | ok | ok | Shaping only. |
| `tools.summarizeLargeOutput` | 315 | W | ok | ok | Worst case is cost: one model call per large result. Named in the notice. |
| `tools.execution` | 322 | W | ok | ok | Overlap is limited to commuting calls, and every call still asks. Semantic risk only. |
| `tools.maxParallel` | 324 | W | ok | ok | Same. |

Not in the schema any more: `cwd`, a row of the 2026-10-20 table
(`load.ts:442-445`). Env (`TENTACLE_*`) stays one layer per side: the laptop's
feeds the laptop's resolution, so it reaches a pod only through carrying, which
also answers `docs/container-config-sources.md` §3.8.

### Non-key inputs

| Input | Local / `serve` | Pod `run`/`attach` | Verdict |
|---|---|---|---|
| `--profile` | applied on that host | laptop only | Unchanged. It takes effect in a pod through the carried values, resolved from the profile. Answers §3.3, except for L and C keys, which get the notice. |
| Skills | `.agents/skills` > `<configDir>/skills` > `~/.agents/skills` > packages (`skills-scan.ts:42-47`) | same walk on the pod's FS | Unchanged, including repo before container (Q10). Laptop skills are not carried: their text would be published to an untrusted pod. |
| Sub-agent definitions | `<configDir>/agents/*.md`, packages (`wiring.ts:66-112`) | pod's configDir | Task 7 covers settings, not definitions. Not carried, same reason. No repo path in v1 (Q10). |
| `PROMPT.md` | laptop | pod's configDir | Not carried, same reason. Today a pod runs the default identity unless the image has one. |
| `AGENTS.md` | nearest up to `.git` | pod's FS | Unchanged, no new layer. |
| Project hooks + trust | prompt, stored in `hooks-trust.json` (`hooks-trust.ts:20`) for a local worker | prompt, never stored (`local-runtime.ts:544-550`); cannot `allow` over the tunnel (`wiring.ts:327`) | Unchanged. The trust store is L and no config key can touch it. |
| Laptop's user `hooks` | run locally | **do not apply in a pod** | Unchanged; carrying a command to a pod would run it there, not here. The startup notice must say so (§3.3). |
| Permissions | single laptop broker | single laptop broker | Unchanged. No config layer can pre-approve anything. |

### Options

- **A — the chain, literally, for every key.** Smallest statement, and it brings
  back every row rejected on 2026-10-20. It also breaks task 7 and §7. **Rejected.**
- **B — no repo file: carry to the pod, keep the container layer.** Fixes the
  half-applied config (§3.1, §3.3, §3.8) and implements task 7. No new attack
  surface. Does not give per-repo settings, which is the stated intent.
- **C — three layers with per-key classes (recommended).** B, plus an allowlisted
  repo file holding W keys only. No key in the file can run code, read a chosen
  path, move a secret or change where work runs, so no trust state is needed. The
  worst a hostile file can do is cost and worse ergonomics, both visible in a
  notice. Cost: a new loader path, and a new provenance channel from the pod.
- **D — every key behind a trust gate.** `hooks-trust.ts` now exists, so this is
  cheaper than on 2026-10-20. Still rejected: `apiKeyCommand` and `baseURL` act
  at load, before any session or broker, so a gate means new startup UX; in a pod
  no approval may last (§7), so it would ask every time; and a gate cannot make a
  pod-supplied `baseURL` legitimate. A trust prompt remains the right tool for one
  narrow case later (repo-level MCP, Q9).

### Recommendation

**Option C.** The chain applies to W keys. It is an exception-free rule per
class, and task 7 is simply the P class:

| Runtime | W | P | C | L |
|---|---|---|---|---|
| Local session, `serve` | env > **repo** > profile + global > default | env > profile + global > default | same as P | same as P |
| Pod `run`/`attach` | pod env > **container file** > **repo in the pod's FS** > carried (laptop env > profile + global) > default | carried only | pod env > container file > default | laptop only |
| `connect` | as `serve`, on the `serve` host; the laptop carries nothing | same | same | same |

**Rules:**

1. **A repo file is read only by the process that builds the agent**, the rule
   `AGENTS.md`, skills and project hooks already follow (`main.ts:615-619`). The
   laptop never reads it for `run`/`attach`, including after `attach`'s `moveTo`
   reload (`main.ts:1288-1293`). `loadConfig` gets an explicit option, **off by
   default**, set only by the modes that build an agent locally.
2. **Docker/Podman mount.** The same file is visible on both sides, and a pod can
   write it. The pod daemon reads it in the session. A later local launch from
   that folder reads what the pod wrote, on the laptop. That is pod-supplied input,
   so the laptop's allowlist is what makes it acceptable (§7): it holds no key with
   an effect beyond that session's W behaviour, and creates no approval.
3. **Merge.** The file is one flat fold with `profile.ts`'s rules: a scalar
   replaces, and `tools`, `contextAwareness`, `contextReset` merge per key. Extract
   the fold rather than copy it. W holds no arrays or maps, so "deep vs replace"
   has no other cases. Undefined inherits; there is no `null` reset. C keys in the
   container file behave as today: `hooks` is a whole list, `mcpServers` a map, and
   nothing crosses the laptop boundary, so there is nothing to merge them with.
4. **Discovery.** Walk up from the cwd to the first `.git` (a file or a directory,
   so a worktree stops at its own root), and read `<root>/.tentacle/config.jsonc`:
   one file, no nesting. With no `.git`, read only `<cwd>/.tentacle/config.jsonc`,
   and do not walk: a walk to `/` would pick up a file planted in a shared parent
   such as `/tmp`. Never `HOME` as the root (`hooks-scan.ts:101` has the same guard).
5. **Reading.** Treat the file as attacker-placed, with the `loadHideFile` checks
   (`workspace-mount.ts:240-245`): `lstat`, no FIFO or device, no symlink out of the
   folder, a size cap. `load.ts`'s `pathExists` + `readFile` would block on a FIFO.
6. **Invalid repo file** (syntax, unknown key, refused key, a tighten-only key the
   wrong way): the **whole file is ignored**, with a diagnostic naming the file and
   key, and the session starts (Q7). Never half-applied. Global and container files
   stay fatal, as today.
7. **When.** A pod's resident outlives sessions and reads config once at start, so
   a repo cloned afterwards would never count. The pod reads the repo layer in
   `createAgent`, per session (`serve.ts:439-452`), and `serve` likewise
   (`serve.ts:168`). `session/open` is synchronous (`packages/protocol/src/session.ts:390-392`),
   so the read must be sync; `loadHideFile` and `loadUserAgentTypes` already are.
   No hot reload: a reset re-reads files, not `config.jsonc`, as today (`load.ts:275-283`).
8. **Carrier.** The laptop carries only the enumerated W and P keys, all of them
   booleans, numbers or enums, as a `settings` field on `session/open`. It is
   additive (strip schemas, §7) and fits the existing rule "`sessionId` live →
   `create`/`messages` are ignored" (`session.ts:394`). Honoured only under
   `--model-proxy`; `connect` never sends it. This removes the frozen-flags problem
   (`docs/container-config-sources.md` §3.4), and it gives `attach --profile X` a
   meaning for new sessions. Nothing is persisted: on a recreate the laptop sends
   it again. See Q4 for task 7's order.
9. **A pin is policy, not security** (§7: "a daemon-side check is UX"). A hostile
   pod can ignore a P value and burst `model/stream` already. Pinning serves honest
   pods; if laptop-side enforcement is ever wanted it belongs in the laptop's
   model tunnel, as a separate task.
10. **Provenance is mandatory.** `Source` gains `repo`, `container`, `carried`.
    Local: one pre-mount line through the diagnostics path (`main.ts:619-636`),
    naming the file and the keys it set, with cost keys called out. Pod: its
    diagnostics reach only a log today (`main.ts:615-619`, §3.6), so the laptop
    needs them from `session/open`'s result, rendered with `untrustedText`. Same
    channel: "the pod ignored your hooks / MCP / packages".

**Why this no longer hits the 2026-10-20 objection.** That objection was to
launch-time code execution, exfiltration, and a trust gate's residual holes. No
refused key reaches the merge, so a planted file gives no code execution and no
key movement, and there is no trust store for the agent's fs tools to reach. It
does reverse the sentence "no config file is ever picked up implicitly", so Q1
asks for that explicitly.

### Failure modes

| Case | Outcome |
|---|---|
| Hostile repo with `apiKeyCommand`, `mcpServers`, `baseURL` | Whole file ignored, named diagnostic. Nothing runs. Launch continues. |
| Agent or pod plants the file, local launch next | Allowlist only: bounded, and named in the notice. Same power as editing `AGENTS.md`, or less. |
| FIFO, symlink out, or oversized file | Ignored with a diagnostic. Never blocks. |
| Repo file from a newer build, unknown key | Ignored with a diagnostic naming the key. An older build still starts in that repo. |
| Invalid container file | Fatal, as today; the laptop sees the daemon's routed stderr. |
| Pod file has `apiKeyCommand` | Today it runs, and failure kills the daemon. Under `--model-proxy` it must be skipped (slice 1). |
| Attach to a live session with another profile | Its agent keeps its settings (`session.ts:394`); a new session uses the new values. |
| Two TUIs, different profiles, one pod | Per session, set by whoever creates it. Shared sessions do not change. |
| `run --detach` | The relay and TUIs carry from the run's profile (`main.ts:1247-1250`, `relay.ts:604-608`). |
| k8s with `WORKDIR` `/` | No repo found, no error. The repo layer depends on `--workdir` (§3.5), so a notice should show the workspace root. |
| `connect` | The laptop has no input. The user changes `serve`'s config or repo. |
| Worktree of a repo ignoring `.tentacle/` | The file is absent there (see Notes). No error. |

### Owner questions

**Q1. Reverse the 2026-10-20 rule for an allowlisted repo file?**
Recommendation: **yes, option C.** If not, take option B, which still delivers
task 7 and the carried defaults.

**Q2. Is the task-7 pin absolute, so `subagents.*` ignores container and repo?**
Recommendation: **yes, for all four keys**, as you decided on 2026-11-05. Capacity
is a property of the laptop's endpoint. Accepting this means `subagents.*` is the
stated exception to "container > repo > global". It also supersedes
`docs/eval/parallel-execution-plan.md:416-417,545` for sub-agents, which says
"the pod's config".

**Q3. Carry W keys from the laptop as the lowest layer?**
Recommendation: **yes.** This is what makes your global file count in a pod at
all (§3.1, §3.3). The consequence is a behaviour change: pods stop running with
plain defaults. `tools.execution` then follows the laptop unless overridden, not
"the pod's config" (`parallel-execution-plan.md:416`).

**Q4. Which carrier, and in what order against task 7?**
Recommendation: **task 7 ships with argv flags as you decided and does not wait**;
slice 1 here then moves everything carried, including `--context-window` and
`--auto-title`, to `session/open.settings`, and removes the flags (pre-public, no
compat). If slice 1 is scheduled before task 7, task 7 uses the field directly.

**Q5. Per-repo model?**
Recommendation: **no, not in v1**; `--profile` is the way. `model.model` or a repo
`profile:` hint can move a repo's code from a local endpoint to a cloud one, among
your own, without you choosing it, and a pod could plant that over a mount. This
drops the first example of the 2026-10-20 use case, so it is your call.

**Q6. Where do profiles sit against the repo?**
Recommendation: **repo > profile + global**, your chain, with env above all. The
profile is folded first, so there is one fold and a simple notice. The alternative,
an explicit profile beating the repo, adds a layer; say so if `--profile` should
win for W keys.

**Q7. Invalid repo file: fatal or ignored?**
Recommendation: **ignored whole, with a loud diagnostic.** This changes the
2026-10-20 "loud `ConfigError`": a repo you only cloned must not stop tentacle from
starting, a newer key must not lock out an older build, and in a pod it would die
as "connection closed". Global and container files stay fatal.

**Q8. Discovery?**
Recommendation: **the git root, one file; with no `.git`, only the cwd; never
`HOME`.** It differs from `.tentacle/hide` (cwd only) and from the skills walk (up
to `/` without `.git`), and matches what a monorepo user expects from a subfolder.

**Q9. MCP?**
Recommendation: **repo: never in this file.** Container: yes, the pod starts the
`mcpServers` of its **own** file (§7 names "MCP servers that act on the workspace"
as pod-side), but as its own task under `docs/eval/mcp-daemon-servers.md`, which
today assumes the spec comes from the laptop (`runOn: "daemon"`) and should be
revised for this. Laptop servers stay on the laptop (`docs/eval/mcp-client-tools.md`).
A repo-level MCP, if ever wanted, needs a separate eval and a trust prompt.

**Q10. Skills and sub-agent definitions against the chain?**
Recommendation: **leave skills as they are** (repo before container; a by-name set
where the most specific wins, not a setting), and **no repo sub-agent definitions
in v1**: a definition can name a model per type (`wiring.ts:382-384`), which
reopens Q5 on a local session. Nothing laptop-side is carried for either.

**Q11. Opt-out, and its default?**
Recommendation: **on by default**, with a `loadProjectConfig: false` global-only
key and a `TENTACLE_NO_PROJECT_CONFIG` env, the same pattern as `loadAgentsMd` and
`loadSkills`. If you prefer the 2026-10-20 caution, make it opt-in; then a team's
shared file does nothing until each member enables it.

### If promoted: slices

Each slice is one `feat`, in order. Blast `load-bearing`, so §10's fresh-context
Review applies.

1. `feat/config-carry` (M): `session/open.settings`, the W and P carried set, no
   `apiKeyCommand` run under `--model-proxy`, `Source` additions, pod-to-laptop
   provenance. No repo file yet.
2. `feat/project-config` (M): `ProjectConfigSchema` allowlist, safe read, discovery,
   the fold, the loader option, per-session read in daemons, the opt-out.
3. Pod-own MCP, under `mcp-daemon-servers` (Q9).

**Tests the Implementation must name:** one table test per class and per refused
key; "the file is never read" for `run`/`attach` on the laptop (mutation: default
the option on); a FIFO does not block; a refused key leaves **no** key applied;
`connect` sends no `settings`, and `serve` ignores one; a pod's `subagents.*` loses
to the carried value; a repo's `redactSecrets: false` is refused.

### Notes

- **Found on the way, not part of this question:** `defaults.ts:38-39` comments
  "Secret redaction … is on by default" but the value is `false`, and `schema.ts:304`
  says "Default: enabled". It needs its own `fix` task. It also weakens the
  tighten-only row: with the default off, a repo's `true` is a real change.
- **`.gitignore`:** this repo ignores `.tentacle/` (`.gitignore:26`). Per
  gitignore(5), a file cannot be re-included under an excluded directory, so the
  `!.tentacle/config.jsonc` in the earlier version of this doc does not work; the
  repo needs `.tentacle/*` then the negation. Until then the file is per-checkout,
  and absent from a new worktree. Not verified by running git.
- **`TODO.md:799-802`** still records this eval as rejected, and the task-7 decision
  appears in no repo doc I could find. This task edits only this file; both need
  updating when the owner answers.
- `docs/container-config-sources.md` §3.5 (`--workdir`) and §3.6 (counts of pod
  skills and agents) remain separate items; this eval depends on the first only for
  k8s repo discovery.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-11-05 (author; not a fresh-context review)*

**Verdict: open, awaiting the owner's answers (Q1–Q11).** Recommended: option C.

What was checked: every schema key against its consumer, by reading the code and
`docs/container-config-sources.md` at `b02818f`. What was not: nothing was run, on
a cluster, Docker or otherwise; the pod-side `apiKeyCommand` failure and the
gitignore rule are from reading. The weakest points, for the fresh-context Review
§10 requires before promotion:

- **W is claimed safe by inspection.** Attack it key by key, including in
  combination. `tools.summarizeLargeOutput` + `maxIterations: -1` is the known
  worst pair, and is cost only.
- **Rule 2 accepts a pod-written file read on the laptop.** Check it against §7's
  "every effect on the laptop that the pod requests is gated on the laptop". The
  argument is that the allowlist is that gate.
- **Tighten-only is direction-sensitive.** The refused direction must be enforced
  in the schema, and must hold after the merge.
- **Rule 1 relies on an option default.** Any new mode that builds an agent locally
  must set it, or per-repo settings silently do nothing there. That failure is safe
  but quiet.
