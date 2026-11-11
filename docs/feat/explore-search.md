# feat/explore-search — a bounded, read-only `search` tool for the agent tree

> **Status:** context + implementation (awaiting owner approval) · **Branch:** `feat/explore-search` (off `main`)
> **Type:** feat · **Size:** S–M · **Blast:** cross-module · **Suited:** DeepSeek exec

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-11*

An `explore` sub-agent has exactly one tool, `fs_read`
(`packages/agent/src/subagent.ts:86` — `tools: ["fs_read"]`), while its own
prompt tells it to "Search and read files to answer the task"
(`subagent.ts:67-71`). It is not a search tool and there is no other: the
built-in registry has no grep/glob/find of any kind. So an `explore` child that
must *locate* a symbol has exactly one move — open files and look, in slices,
with `offset`/`limit` (`packages/tools/src/builtins.ts:70-102`), and every slice
it opens stays in its history for every later step. On a review in another repo
that produced two children at **183 and 97 steps, 18M / 6.3M tokens**
(`TODO.md:483`, with `subagents.maxIterations: -1`). `feat/agent-status` made a
runaway child *visible*; `feat/subagent-token-budget` (next) will *cap* its
spend. Neither removes the cause: an investigator without a search primitive.

**The gap, measured** (repro below): a real `explore` child is offered
`["fs_read"]`; `builtinTools` is `fs_read, fs_write, fs_edit, fs_multi_edit,
shell, shell_output, shell_kill` — no `search`/`grep`/`glob` at all.

**Owner constraints (binding, `TODO.md:483`).** Built on **ripgrep**, not from
scratch; run through **`ctx.env`** (laptop / docker / pod) like the other tools;
**never assume `rg` exists** in the image — a missing `rg` falls back to POSIX
`grep -r`/`find` with the **same output shape and bounds**, tested on both
paths; pattern/path quoting through `env.exec` tested with **hostile patterns**
(quotes, `$(…)`, backticks, newlines, a leading `-`); **bounded output** (count
+ bytes, a clear truncated marker); **read-only** (`explore` gets no shell).

**Repro** — `.tentacle/tmp/explore-search/repro-doc.ts` (the pinned design's
two paths) and `probe-limits.ts` (its limits), run 2026-11-11 on this branch
(`.tentacle/` is gitignored, so both are pasted in full below). Part A drives the
**real** `createSubagentRunner` (`subagent.ts:304`) with a recording
`ModelProvider` and the real `builtinTools` registry; part B runs the pinned
two-path pipeline over one fixture (a `.git` dir, a `.gitignore`, a nested
`dist/`, `node_modules/`, `coverage/`, a hidden file, a binary, a leading-dash
file, a symlink loop) with `PATH` = the real one (rg present) versus a `PATH`
holding only `sh find grep sort head` and friends (no rg), both reduced through
the **same** renderer.

```
A1 explore child is offered: ["fs_read"]
A2 built-in tool names: ["fs_read","fs_write","fs_edit","fs_multi_edit","shell","shell_output","shell_kill"]
A3 any search/glob tool: false

B. .gitignore top-level prunes: ["node_modules","dist","coverage"] · not expressible: []
  "needle"           identical=true  "./-dash.ts:1:needle dash | ./it's.txt:1:it's a needle | ./log.txt:1:needle log | ./src/a.ts:1:export const nee"
  "needle.*Two"      identical=true  "./src/a.ts:3:needleTwo();"
  "it's"             identical=true  "./it's.txt:1:it's a needle"
  "say \"hi\""       identical=true  "no matches"
  "$(echo PWNED)"    identical=true  "no matches"
  "$(touch pwned)"   identical=true  "no matches"
  "`id`"             identical=true  "no matches"
  "a;b|$(id)"        identical=true  "no matches"
  "-n"               identical=true  "no matches"
  "--version"        identical=true  "no matches"
  "zzz"              identical=true  "no matches"
  → 11/11 rendered identically
  a $(touch pwned) pattern created a file: false
```

and its honest **limits** (`probe-limits.ts`, same date) — the one case the
fallback cannot reproduce, which the Design surfaces in a note instead of
dropping:

```
1. .gitignore = *.log, pkg/a/, coverage
   rg      : ["./src/a.ts:1:needle"]
   fallback: ["./coverage/c.txt:1:needle","./pkg/a/x.ts:1:needle","./src/a.ts:1:needle","./src/debug.log:1:needle"]
2. files mode, a gitignored *.log rule does not matter for -name '*.ts' filtering
   rg      : ["./src/a.ts"]
   fallback: ["./pkg/a/x.ts","./src/a.ts"]
```

So: **shape and bounds are identical by construction** (one JS renderer over
both engines' `path:line:text` lines), the result sets agree wherever
`.gitignore` is expressible as a top-level literal name (the common case), and
the residual difference — a `*.log` glob or a nested `pkg/a/` — is printed as a
note, never silent.

**Pre-repro (rejected shapes, measured, so the plan does not re-propose them).**
- *`rg` vs plain `grep -rn`.* Their line format already agrees
  (`path:line:text`), but the *sets* do not: rg skips hidden entries and honours
  `.gitignore`; `grep -rn .` walked `.git/config`, `node_modules/`, `dist/`
  and printed `Binary file ./src/bin.dat matches` for a match rg never reports
  (measured on a fixture with `.git`, `.gitignore`, a binary and a symlink
  loop). Unifying that needs an explicit prune list on both sides — Design 3.
- *`--sort path` on rg for ordering.* Costs 87 ms vs 60 ms on this repo and only
  orders rg's own output; the fallback's order depends on `find`'s walk. Sorting
  happens in JS, once, for both.
- *Byte cap inside the pipeline (`head -c`)* — cut a multi-byte character in
  half on the CJK fixture (`TextDecoder{fatal:true}` throws on the tail). The
  raw stream is capped at 256 KiB for safety, then `MAX_BYTES` is applied in JS
  on whole lines. Also: `cut -c` is not byte- or char-safe across BSD/GNU, so
  per-line truncation is JS too.
- *`rg --no-ignore` + a shared prune list* (ignoring nothing on **either**
  path, the tempting "exact parity" option): measured **409-453 ms vs 61-64 ms**
  on this repo — and adding the same `-g '!**/node_modules/**'` prunes rg would
  otherwise apply does not help (**453 ms**), because the cost is the *walk*
  (`.tentacle/worktrees`, `dist`, `node_modules` are all re-entered), not the
  filtering. That is ~7× on the **fast** path, paid on every search, to make a
  case that only arises when `rg` is absent. Rejected; owner Q3.
- *Reading `.gitignore` and pruning the fallback by it* (the option this plan
  takes): harvest the **top-level literal names** (`node_modules`, `dist`,
  `coverage` — what `find -name` can actually prune), add them to the
  fallback's prune list, and give rg only the same fixed prunes plus its own
  default `.gitignore` behaviour. Measured on a fixture with `.git`,
  `.gitignore`, a hidden dir, a binary, a dash file and a symlink loop:
  **7/7 rendered results identical**, rg still at **45-50 ms**
  (`.tentacle/tmp/explore-search/design-final.ts`). The only remaining
  divergence is a `.gitignore` rule no POSIX `find` can express (`*.log`, a
  nested `pkg/a/`) — printed as a note, never silent (Design 3, F-notes).


## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Load-bearing assumption

**A tool that spells its whole operation as ONE `sh -c` string built from a
fixed flag list plus single-quoted arguments is safe and portable across every
`ctx.env` (laptop, docker, pod), and its output can be made identical whether
the engine inside is `rg` or POSIX `find`+`grep`.**

Proven, both halves, before anything else:

1. **Quoting.** `shq(s) = "'" + s.replaceAll("'", "'\\''") + "'"` — POSIX
   single-quoting, the only form in which the shell interprets nothing. Run
   through a real `sh -c` against a file holding every hostile pattern
   literally (`.tentacle/tmp/explore-search/quote.ts`, 2026-11-11):

   ```
   "needle" → rc=0 "1:needle"          "it's" → rc=0 "2:it's"
   "say \"hi\"" → rc=0 "3:say \"hi\""  "$(echo PWNED)" → rc=0 "4:$(echo PWNED)"
   "`echo PWNED`" → rc=0 "5:`echo PWNED`"  "back\\slash" → rc=0 "6:back\\slash"
   "-n" → rc=0 "9:-n"                  "-e" → rc=0 "10:-e"
   "a b\tc" → rc=0 "11:a b\tc"         "$HOME" → rc=0 "12:$HOME"
   "!x" → rc=0 "13:!x"                 "*" → rc=0 "14:*"
   "a|b" → rc=0 "15:a|b"               "a;b" → rc=0 "16:a;b"
   ```

   Every pattern matched its own line and nothing was expanded: no command
   substitution, no glob, no variable. A **leading `-`** is handled by never
   letting the pattern sit in flag position: the pattern always follows `-e`
   (or `--fixed-strings -e`), and the path always follows `--`
   (`rg … -e PAT -- PATH`, `grep … -e PAT -- {} +`, `find PATH …`). Verified:
   `rg --version` as a *pattern* matched nothing (`repro-doc.ts`), and a
   `$(touch pwned)` pattern created no file (same run: `a $(touch pwned)
   pattern created a file: false`).

2. **One shape from two engines.** With a shared fixed prune list, rg's own
   default walk, and the `.gitignore`'s top-level literal names added to the
   fallback's prunes, the two paths render **identically** — 7/7 on the fixture
   (`design-final.ts`) and 11/11 on the hostile table (`repro-doc.ts`), both
   data sets reduced through the **same** JS renderer, which is the point:
   sorting, bounding and truncation happen once, in JS, so the engine cannot
   influence the shape. On the whole repository the two paths agree line for
   line (`parity3.ts`: `repo-wide: rg=796ms lines=129 fallback=5040ms
   lines=129 parity=true`).

The whole feature stands or falls on this: if the two paths disagreed on shape,
"same output shape and bounds" would be false and the model would see a
different tool depending on the image.

### Preconditions

Each verified against the code on this branch:

1. **Every tool effect goes through `ctx.env`, and `ctx.env.exec` is `sh -c
   <string>`.** `ToolContext.env` is an `ExecutionEnvironment`
   (`packages/core/src/tool.ts:121`), whose only member is
   `exec(command, options)` (`packages/core/src/execution.ts:42-54`);
   `HostExecution.exec` is `Bun.spawn(["/bin/sh", "-c", command])`
   (`packages/exec/src/host-execution.ts:238,303-323`). So a single command
   string is the portable unit, and `ExecOptions` gives `cwd`, `signal`,
   `timeoutMs` (`execution.ts:14-23`) — cancellation and a wall-clock bound come
   for free, exactly as `shell` uses them (`builtins.ts:300-305`).
2. **A tool is a `name` + `description` + zod `inputSchema` + `permission` +
   optional `concurrency` + `execute`**, registered into a `ToolRegistry`
   (`packages/core/src/tool.ts:154-181`, `packages/tools/src/registry.ts:15-22`)
   which converts the schema to JSON Schema for the model
   (`registry.ts:56-67`), and `Agent` sends `this.config.tools.definitions()` as
   the request's `tools` (`packages/agent/src/agent.ts:1136-1142`). The result
   reaches the model as the `tool_result` → `tool` message of the call
   (`agent.ts:1619,2020`), through the result transforms (redaction → hooks →
   large-output spill, `packages/cli/src/wiring.ts:458-464`).
3. **The built-in set is one array**, `builtinTools`
   (`packages/tools/src/builtins.ts:320-328`), registered wholesale by
   `buildAgent` (`wiring.ts:407`) — the single seam a new built-in joins, for
   every runtime (worker, `serve`, pod `run`/`attach`, since a pod's daemon
   builds its agent through the same `buildAgent`, `packages/cli/src/serve.ts:472-493`).
4. **A child's tool-set is a closed allow-list by name**, filtered at child
   start (`subagent.ts:339-362`): `type.tools === "all" || type.tools.includes(tool.name)`.
   So adding a name to `explore`'s list (`subagent.ts:86`) is the whole
   grant — and the *same* array is what `readOnlyType` judges, live, by asking
   `isReadClass(classOf(tool, { path: "_" }))` (`subagent.ts:556-557`), which is
   why a new tool must carry a **read-class `concurrency`** or `explore` stops
   being recognised as read-only (and `agent_task`'s scheduling,
   `packages/tools/src/task.ts:360-363`, changes behaviour).
5. **`permission: "none"` is a real, used level** (`tool.ts:15`) for tools
   that cannot touch anything, and `fs_read` is the precedent (`builtins.ts:83`).
   The permission gate is host-side and unconfined for `exec` (`host-execution.ts:14-16`
   says so out loud), so a search that ran arbitrary commands would be a hole —
   hence: no free-form command argument anywhere in the schema (Design 2).
6. **The documenting rule for a tool name is `toolLabel`**
   (`packages/core/src/tool-labels.ts:7-17`, display only) and, for a child's
   progress row, `childToolLabel` (`subagent.ts:234-255`). Both need an entry or
   the row reads as a bare `search`.

### Design

**One tool, two modes.** Owner question Q1 below is *who* gets it; this is
*what* it is. A single `search` with `output_mode: "content" | "files"` — not a
`grep` plus a `glob` — for three reasons measured or cited above: (a) each extra
tool is ~500-800 characters of tool definition in **every** request of the
session (`feat/agent-status` measured 1653 → 785 chars by merging three into
one, `TODO.md:470`), and a child with no auto-compaction pays that on all 183
steps; (b) both modes are the *same* walk with the same prunes, bounds and
truncation marker — one pipeline, one parser, one pair of tests; (c) one name is
one `toolLabel`, one `childToolLabel` case, one line in the prompt.

(Merging is not free either — `feat/agent-status`'s review found that one tool
with an `action` field reads worse to a model than two narrow ones. The
`output_mode` shape is picked because the *two modes share everything but the
verb*: contrast `agent_control`'s three actions, which share nothing. If the
owner prefers two tools, the split is mechanical — `search` (content) and
`find_files` (paths) — at the definition cost above.)

**Input schema** (zod, `z.object` — all fields described, since the description
is what the model reads):

| field | type | default | notes |
|---|---|---|---|
| `pattern` | `string` | — (required) | In `files` mode: a glob (`*.ts`, `src/**/a*.ts`). In `content` mode: a regex. |
| `path` | `string` | `"."` | File or directory, workspace-relative. The only thing in path position. |
| `output_mode` | `"content" \| "files"` | `"content"` | `files` lists matching paths only. |
| `fixed_strings` | `boolean` | `false` | `content` only: treat `pattern` literally (`--fixed-strings` / `grep -F`). |
| `ignore_case` | `boolean` | `false` | `--ignore-case` / `grep -i`. |
| `max_results` | `int ≥ 1` | `100` | The count bound. Clamped to a hard ceiling (`MAX_RESULTS_CEILING = 1000`). |

Deliberately absent: `command`, `exclude`, `before`/`after` context,
`glob`-and-pattern together, `multiline`. Each is a new quoting surface or a new
definition cost; none is needed to *find* a symbol, which is the whole point.

**Bounds, enforced in this order** (the same on both paths, and the reason the
fixture agrees):

1. **Raw cap, in the shell**: `| head -c 262145`. A backstop so a pathological
   walk cannot buffer unbounded output into `exec`'s `Response.text()`
   (`host-execution.ts:259-263` — already named as a debt for `shell`,
   `TODO.md:84-85`). 256 KiB is far above the display bound, so it never
   truncates a legitimate result.
2. **Count bound, in JS**: keep the first `max_results` whole lines; if the raw
   stream held more, emit `[search truncated: first N matches — narrow the
   pattern or path]`.
3. **Byte bound, in JS**: keep whole lines summing to ≤ `MAX_BYTES = 12000`
   (under `tools.maxInlineOutputChars`'s default 16000,
   `packages/config/src/defaults.ts:49`, so a normal search never reaches the
   spill path at all — see the spill note below); if it cut, emit
   `[search truncated: 12000 bytes — narrow the pattern or path]`.
4. **Per-line cap, in JS**: `MAX_LINE = 300` characters, `…` when cut. A
   minified bundle is one line; without this a single hit eats the whole byte
   budget.

A line cap in JS, not `cut -c`, because `cut -c` is neither byte- nor
character-safe across BSD and GNU (measured: BSD `cut -c` on CJK cut mid-byte —
the plan's pre-repro rejected it).

**Output format** — two header shapes, so a child can tell them apart without
guessing:

```
[search "needle" in .]  (engine=rg)
./src/a.ts:1:export const needleOne = 1;
./src/a.ts:3:needleTwo();
```
```
[files *.ts in .]  (engine=grep)
./-dash.ts
./src/a.ts
./src/deep/z.ts
```

- `path:line:text`, one hit per line, **sorted by path then line number** in JS
  (never by the engine — pre-repro: rg's `--sort path` costs 45 % and does not
  help the fallback).
- `no matches` alone when the set is empty — an explicit sentence, not an empty
  body, because an empty result is the most common answer and an empty string
  reads like a failure.
- **`engine=…` is in the header on purpose.** The fallback's ignore rules are
  weaker (Design 3), and a child that knows it is on the fallback can widen its
  own query. It is one token on a line that carries the query anyway.
- A note line, when a rule could not be applied:
  `[note: 2 .gitignore rules (*.log, pkg/a/) are not applied on this engine; results may include ignored files]`
  — **fallback only** (Q3.1), and **never silent** (Failure modes).

**Design 3 — the two engines, and how they are kept identical.**

*Engine detection, cached per `env`.* One probe, once per environment:

```
command -v rg >/dev/null 2>&1 && echo rg || echo grep
```

`command -v` is POSIX and `sh`-builtin, so it adds no process; measured at
**24-29 ms** (`cost.ts`) — paid once per session per env, then cached by
`WeakMap<ExecutionEnvironment, Promise<Engine>>` next to the existing
`pathLocksFor` precedent (`packages/core/src/path-locks.ts:84-92`). Caching is
correct because an env's `PATH` does not change under it (a pod's is fixed at
exec time; `HostExecution` builds the child env from `process.env` per call,
`host-execution.ts:354-358`, and nothing in the product mutates it). A failed
probe caches `"grep"` — the conservative path.

*Search commands.* Verbs differ; prune lists and shape do not. `PRUNE` is one
constant, applied to rg as negated globs and to `find` as `-prune` clauses, so
the same *names* are excluded on both paths — and **rg keeps its own default
walk** (`.gitignore`, hidden entries) rather than being told to ignore nothing,
because that is what keeps the fast path fast (measured: 45 ms vs 409-453 ms,
pre-repro):

```
PRUNE = [".git", ".hg", ".svn", "node_modules", "dist"]   // + .gitignore's top-level literal names

rg   (content): rg --no-heading --line-number --color=never --with-filename
                  -g '!**/.git/**' … -e PATTERN -- PATH
rg   (files):   rg --files -g GLOB -g '!**/.git/**' … -- PATH
find (content): find PATH \( -name '.*' ! -path PATH \) -prune -o \
                  \( -name '.git' ! -path PATH \) -prune -o … -o \
                  -type f -exec grep -n -H -I -E -e PATTERN -- {} + 2>/dev/null
find (files):   find PATH \( … -prune \) -o -type f -name GLOB -print
```

Four points here are load-bearing and were each measured:

- **rg keeps its defaults; the fallback is pruned to match.** The owner's
  constraint is the same *shape and bounds* on both paths, and that is met
  structurally: both engines emit `path:line:text` lines, and **one** JS
  renderer sorts, caps and truncates them, so shape cannot depend on the engine.
  The *result set* is then made to agree by sharing the prune names, and by
  adding the `.gitignore`'s top-level literal names to the fallback's prunes
  (Design 3b) — measured 7/7 identical on a fixture with `.git`, `.gitignore`, a
  hidden dir, a binary, a dash file and a symlink loop (`design-final.ts`).
  `--no-ignore` was measured and **rejected**: it makes rg walk
  `node_modules`/`dist`/`.tentacle/worktrees` and costs 7× (409-453 ms vs
  61-64 ms), and adding the same `-g` prunes back does not recover it (453 ms) —
  the walk, not the filter, is the cost.
- **`-I` on grep, `2>/dev/null`, `--color=never`.** Without `-I`, grep prints
  `Binary file … matches` for a match rg silently drops (measured). Without
  `--color=never`, rg colours when it thinks it is on a tty.
- **`! -path ROOT` on every prune clause.** `find .` matches its own root
  against `-name '.*'` — without the guard the whole walk prunes itself and
  returns nothing (measured: an early prototype returned `[]` for every query).
- **A prune name the caller NAMED in `path` is exempt on both sides.** Asking
  for `src/node_modules` must search it; rg's `-g '!**/node_modules/**'` is
  dropped and `find`'s clause is skipped for that name. Measured: parity holds
  for every root once the exemption is in (`.`, `./`, `src`, `./.config`,
  `.hidden.txt`, `node_modules`, `src/node_modules`).

**Design 3b — reading `.gitignore`, for prunes and for the note.** The
workspace root's `.gitignore` is read with `ctx.env.readFile` (cheap,
unconfined by design, `host-execution.ts:14-15`) and each rule is classified:

- **a top-level literal name** (`node_modules/`, `dist`, `coverage`) → added to
  the fallback's `PRUNE`. This is what makes the common case agree, and it is
  the *only* rule `find -name` can honour.
- **anything else** — a glob (`*.log`), a nested path (`pkg/a/`), a negation
  (`!.env.example`), a character class → **counted**, and one note line says so:
  `[note: 2 .gitignore rules (*.log, pkg/a/) are not applied on this engine; results may include ignored files]`.

A missing, unreadable or unparseable `.gitignore` is not an error. **The note's
source is `ctx.env.readFile`, never a `shell`.**

**Where the note is printed** (Q3.1): on the **fallback only**, by default —
rg applied every rule, so on rg the note would be noise; and the header's
`engine=grep` already tells a child it is on the weaker path. The stricter
option (print it on both, so no two runs ever look more alike than they are)
costs one line on the common path; the owner can take it. Either way the
difference is **printed, never silent**.

**Design 4 — the granted tool-set and the prompt.**

`explore`'s list becomes `["fs_read", "search"]` (`subagent.ts:86`). Because
`search` must declare a read-class `concurrency` for `readOnlyType` to keep
saying yes (precondition 4), it gets
`concurrency: (input) => isRecord(input) && typeof input.path === "string" ? [{mode:"read", resource: pathResource(input.path)}] : [{mode:"read", resource: "search:*"}]`
— built with the existing `pathConcurrency("read")` helper where the input has
a `path` (`packages/tools/src/concurrency.ts:22-38`), so a `search .` conflicts
with an `fs_edit a.ts` that another call is doing (a coarse basename key,
`packages/core/src/path-locks.ts:47-51`) and two searches run side by side.

The prompt is aligned to the tool that now exists — **and it is the place the
cost is actually saved**, so it names the anti-pattern by name:

```
You are a read-only investigator sub-agent. SEARCH first, then read: use
`search` to locate a symbol, string or file before you open anything, and
`fs_read` with `offset`/`limit` to read only the lines a hit pointed at.
Never open a file end to end "to get the picture" — a whole file, or one
large file read in slices, stays in your context for every later step and is
what makes an investigation expensive. Narrow the search (a file, a glob, a
tighter pattern) instead of reading more files.

You cannot modify anything. Finish with a concise, self-contained report of
your findings, citing concrete file paths and line references — that report is
the only thing the parent receives.
```

**Design 5 — display, and what it costs elsewhere.**

- `toolLabel`: `search: "Search"` (`tool-labels.ts:13`) — used by the TUI row,
  the permission prompt title and the hook log (`render-lines.ts:360`,
  `permission-gate.ts:62`, `cli/src/render.ts:23-25`).
- `childToolLabel` (`subagent.ts:234-255`): a `search` case reading
  `Search <pattern> in <path>` — capped there by the existing label path, since
  a pod's pattern is pod text (§7) and the daemon's `wireLine` cuts the row
  (`packages/daemon/src/mapping.ts:64-66`).
- `toolSubtitle` for the TUI (`render-lines.ts:568`): the same
  `pattern in path`, so a transcript row shows the query.
- Nothing else: no wire field, no protocol change, no persistence change. A
  tool name and its result travel as they already do (`tool_result` →
  `tool_call_update`, `client/mapping.ts` unmodified) — a new **tool**, not a
  new **update kind**, which is why **no `PROTOCOL_VERSION` bump** is needed
  (AGENTS §7: fields and methods are free; this is neither).

**Spill (the TODO item, `TODO.md:130-133`).** `explore` still passes the
parent's `resultTransforms` (`subagent.ts:414`), so *any* result over
`maxInlineOutputChars` spills a file — and a read-only child writing into the
cache dir contradicts "cannot modify anything". The byte bound above (12000 <
16000) makes this **unreachable for `search`** by default: a search that hit the
cap prints a truncation marker instead of overflowing. This task therefore
*removes the reachability* for the new tool but does NOT close the general
hole (`fs_read` on a big file still spills in an `explore` child) — that is
owner Q2(b), a separate decision with a §7-shaped answer (a read-only type has
no `writeSpill`), and it is cheaper and safer as its own fix than as a rider
here.

### Files

In dependency order (no protocol/daemon/client change — this is tools → agent →
display):

| file | change |
|---|---|
| `packages/tools/src/search.ts` | **new.** The pure core: `buildSearchPlan(input, engine) → SearchPlan` (the command string + the note), `parseSearchOutput(raw, mode) → Hit[]`, `renderSearchResult(hits, opts) → string`. No I/O, no `Tool`. This is the module the "logic lives in pure modules" rule (§7) wants, and the one the two-path tests drive **directly** — no subprocess needed for the shape tests. |
| `packages/tools/src/search-tool.ts` (or same file, second half) | the `Tool`: schema, description, `permission: "none"`, read-class `concurrency`, `execute` = read gitignore → probe/cache engine → `ctx.env.exec` → parse → render. |
| `packages/tools/src/index.ts:11` | export it. |
| `packages/tools/src/builtins.ts:320-328` | `searchTool` into `builtinTools`. |
| `packages/agent/src/subagent.ts:86` | `tools: ["fs_read", "search"]`. |
| `packages/agent/src/subagent.ts:67-71` | `EXPLORE_PROMPT` as in Design 4. |
| `packages/agent/src/subagent.ts:234-255` | `childToolLabel` `search` case. |
| `packages/core/src/tool-labels.ts:13` | `search: "Search"`. |
| `packages/tui/src/render-lines.ts:568` | `toolSubtitle` `search` case. |
| `packages/tools/test/search.test.ts` | **new.** The pure module, both paths, hostile table (Tests). |
| `packages/tools/test/search-tool.test.ts` | **new.** The `Tool` against a fake `ExecutionEnvironment` (probe, commands, bounds) + one real-`sh` run per path. |
| `packages/agent/test/subagent.test.ts` | extend: the `explore` child is offered `["fs_read","search"]`; `readOnlyType("explore")` still true; one child **end-to-end through the real agent loop** that searches then reads (Tests). |
| `packages/tui/test/render-lines.test.ts` | one row: `search` renders `Search x in y`. |

### Failure modes

Every one converges to a `ToolResult` the model can act on — never a throw
(`ToolRegistry.execute` catches anything, `registry.ts:73-100`), never a silent
drop.

| # | mode | how it converges |
|---|---|---|
| F1 | **No `rg` in the image** (a UBI/busybox pod) | the probe caches `grep`; the fallback runs; the header says `engine=grep`. Tested on a `PATH` with no `rg` — the whole `repro-doc.ts` B table is that case. |
| F2 | **No `grep -r`, or no `-E`/`-I`/`-H`, or `find` without a needed primary** (busybox/dash variants) | the fallback uses **only** `find PATH … -prune -o -type f -exec grep -n -H -I -E -e PAT -- {} +`. `-r` is deliberately *not* used: `find` does the recursion, so a `grep` that lacks `-r` still works, and `-exec … {} +` is POSIX (`grep -r` is not, in the POSIX spec). `-E` and `-H` are POSIX. `-I` is a GNU/BSD extension — **the one real portability risk**; a `grep` without it prints `Binary file … matches`, which the parser already recognises and turns into a note (`binary files matched (N) — not shown`), so the *shape* holds even then. A capability probe (`grep -E -I -H -e x -- /dev/null`, one process, **measured at 38-47 ms** — a `grep` start-up, not a walk) is cached with the engine; the parser's binary-line handling means a missing `-I` degrades to a note rather than a broken shape, so the probe is a nicety, not a correctness requirement. |
| F3 | **A path that does not exist** | rg exits 2 with `rg: PATH: IO error for operation on PATH: No such file or directory`; find/grep exit non-zero with `find: PATH: No such file or directory`. Both come back on **stderr**, which is *not* discarded — the tool reads `ExecResult.stderr` (measured: `err="rg: ./nope: IO error…"` / `err="find: ./nope: No such file or directory"`). The tool returns `[search "p" in ./nope]` + `path not found: ./nope` + a `note` (`isError: true`), so the child widens its path instead of reporting "no matches". |
| F4 | **A busybox `find` without `-mindepth`** | `-mindepth` is GNU/BSD, not POSIX — it is **not used**. The root-vs-`-name '.*'` trap is closed by `! -path ROOT` on each prune clause, which is POSIX primary syntax and measured to work on BSD `find` (and is what makes `parity3.ts`'s root table all `true`). |
| F5 | **A huge repo / a runaway walk** | the 256 KiB raw cap bounds memory; `ctx.signal` is threaded into `env.exec` (`execution.ts:16`, as `shell` does at `builtins.ts:302`) so a cancelled turn kills the walk through the process group (`host-execution.ts:246-256`); an optional `timeoutMs` (default 20 s, half of `shell`'s 120 s, since a search is not a build) bounds it on the wall clock. **Measured floor**: fallback on this repo 5.0 s vs rg 0.8 s — the fallback is slow, which is why the timeout exists and why `engine=grep` is in the header. A cancel surfaces as `ExecResult.exitCode === 124` with the same note `shell` uses (`builtins.ts:312-315`), reworded for a search. |
| F6 | **Binary files** | `-I` drops them on the fallback; rg drops them silently by default (measured: `rg` prints nothing for `needle` in a file holding `\0`; `grep -rn` without `-I` printed `Binary file ./src/bin.dat matches`). Both paths therefore print nothing for them — identical. The parser still recognises a `binary file matches` line (a `grep` without `-I`, F2) and counts it into one note line. |
| F7 | **Symlink loops** | `find` without `-L` does not follow symlinks — a loop is never entered (measured on `src/loop -> ..`). rg does not follow them either. No `-L` is ever passed. |
| F8 | **A pattern containing a newline** | `rg` **refuses** a literal newline in a regex (*"the literal `\n` is not allowed in a regex"*, rc 2) while `grep -E` accepts it and matches a *line* — a genuine divergence (measured). Not fixable by quoting. So: the schema rejects a `pattern` containing `\n`/`\r` with a validation message telling the model to search for a single line and use `fs_read` for context. That is the honest shape — the tool never sends a pattern the two engines disagree about. |
| F9 | **A pod's untrusted output (§7)** | the pod owns its daemon, so a match's *text* is pod-supplied bytes. The result is not treated as trusted: the tool strips C0/DEL control characters per line (the same class `wireLine`/`oneLineText` drop, `mapping.ts:64-66`, `hosted-session.ts:345-368`), caps each line, and prefixes every result with the `[search …]` header so the text is never bare. It is **not** marked as an instruction anywhere, and it carries no path that another tool then trusts. A pod cannot use this to escalate: the tool's effect is a read-only walk inside the pod, with no shell and no writable file. |
| F10 | **Cancel mid-walk** | `ctx.signal` → `exec`'s abort → SIGTERM to the whole process group, SIGKILL after the grace (`host-execution.ts:340-348`); the tool returns `search cancelled` (`isError: true`) rather than a partial list the child would misread as complete. |
| F11 | **`max_results` absurdly large, or 0** | the zod schema is `int().min(1)` and the value is clamped to `MAX_RESULTS_CEILING` in the pure module — a 10⁹ asks for the ceiling, never for an unbounded buffer. |
| F12 | **An empty or whitespace-only `pattern`** | `z.string().min(1)`; a pattern of only spaces is legal and searches for spaces (harmless, bounded). In `files` mode an empty glob would match everything, so `min(1)` covers it. |
| F13 | **`.gitignore` unreadable, absent, or a symlink out of the workspace** | `readFile` failure is caught and ignored (no note, no error); it is a convenience for a note, never a precondition. |
| F14 | **The probe succeeds but rg then fails** (a wrapper on `PATH`, a broken binary) | the exec's stderr and non-zero exit reach the tool; if rg fails with rc 2 *and* stderr mentions the engine, the tool re-runs **once** on the fallback and reports `engine=grep` (with the rg error as a note). One retry, never a loop (§0). |
| F15 | **A result so large it reaches the spill path** | designed out: the byte bound (12000) sits below the spill threshold (16000), so `search` never spills — which also keeps the TODO `explore`-spills-a-file item unreachable *for this tool* (Design 5). If a user lowers `tools.maxInlineOutputChars` below 12000, the spill machinery handles it exactly as for `shell` — no new code. |

### Tests

The repo rule (§9): **red before green**, prove the exact property, test the
failure modes, use injectable seams.

**T-S1 — the pure module, both paths, one table** (`packages/tools/test/search.test.ts`).
*Property*: for the same fixture and the same input, `renderSearchResult(parseSearchOutput(cmd_result))` is **identical** whether the command came from `buildSearchPlan(…, "rg")` or from `buildSearchPlan(…, "grep")`.
Driven as: build both plans, run **each real command** once through
`Bun.spawnSync(["/bin/sh","-c", …])` against a `.tentacle/tmp` fixture — the rg
one with the real `PATH`, the fallback one with a scrubbed `PATH` — then compare
the rendered strings. That is exactly `repro-doc.ts` B, promoted to a test.
Table: a plain hit, a regex hit, a no-match, a hostile set (`it's`,
`say "hi"`, `$(echo PWNED)`, `` `id` ``, `a;b|$(id)`, `-n`, `--version`), a
truncation-by-count case, a truncation-by-bytes case, a 5000-char line, a binary
file, a symlink loop.
*Guards the vacuity risk*: the test asserts the rg run **actually used rg** and
the fallback run **actually could not** (`command -v rg` in each PATH) — otherwise a
machine without rg would make both sides the fallback and prove nothing.

**T-S2 — quoting, as a property of the built command, not of a shell**
(`search.test.ts`). *Property*: for each hostile pattern, the built command,
executed, produces a hit for a file containing that pattern **literally** and
creates no file named `pwned`. Mutation check (§9): replace `shq` with identity
and the `$(touch pwned)` / `a;b|$(id)` cases must go red — they do (measured:
without quoting the shell splits the command).

**T-S3 — the `Tool` against a fake env** (`search-tool.test.ts`).
*Property*: with a scripted `ExecutionEnvironment` (the `recordingEnv` pattern,
`packages/agent/test/subagent.test.ts:47-62`), the tool sends **exactly one**
probe then **exactly one** search, caches the engine across two `execute` calls
(probe count stays 1), passes `ctx.signal`, and never puts `input.pattern` or
`input.path` outside a quoted position. Red-before-green: written against a
stub that returns `""`, red on the engine/command assertions, then wired.

**T-S4 — the real agent loop, `explore` end to end** (`packages/agent/test/subagent.test.ts`).
*Property*: a child of type `explore` is offered **`["fs_read","search"]`**;
its first turn calls `search`, its second `fs_read` on the hit's path, and its
report comes back to the parent. The existing test at `subagent.test.ts:218-231`
("the `explore` type is read-only: shell is not available") is the template and
stays green — it is also the **regression guard for precondition 4**: if
`search` were declared `exclusive` (no `concurrency`), `readOnlyType("explore")`
goes false, `agent_task`'s `spawnKind` flips to `"writer"`
(`task.ts:360-363`) and a scheduling test goes red. Mutation: drop `concurrency`
from the tool and confirm that test fails.

**T-S5 — the schema refuses a newline pattern** (`search-tool.test.ts`).
*Property*: `pattern: "a\nb"` is a validation error with a message naming
`fs_read` for context. Red on the code before the `.refine`.

**T-S6 — bounds** (`search-tool.test.ts`, pure). *Property*: 500 hits with
`max_results: 3` yields exactly 3 lines **and** the count marker; a single
40000-char line yields one line of ≤300 chars **and** a `…`; a result at the
byte bound yields only whole lines and the byte marker — never a split line.
Mutation: move the byte bound before the count bound and the whole-lines
assertion goes red on the multi-byte fixture.

**T-S7 — display** (`render-lines.test.ts`): the `search` row reads
`Search <pattern> in <path>`; `childToolLabel("search", …)` the same. One case
each — display only, so this is the shallow test, deliberately.

**Not tested here, and said out loud**: the docker/pod transport (`env.exec` is
the same contract everywhere, precondition 1, and a pod's `rg` presence is only
knowable in the pod — F1 is the answer and the `engine=` header is its
observable). Verification for that is one live `tentacle run` search in an image
without rg; it is named in Review, not claimed here.

## Owner questions

Each with 2-3 options; **my recommendation first**, and what the measurement says.

**Q1 — Who gets `search`: `explore` only, or `general` and the main agent too?**
- **(a) `explore` only — RECOMMENDED.** It is the type with the measured
  problem (183 steps / 18M tokens by opening files in slices) and the type with
  no substitute: the main agent and `general` already have `shell`, so `grep -rn`
  is one call away for them, and adding `search` to them buys a second way to do
  what they can already do — at a cost of ~600 chars of tool definition in every
  request of every session, and a *worse* tool for them (bounded, no context
  flags, no `--glob` combinations) than the shell they have. Blast stays at one
  array in `subagent.ts`.
- **(b) `explore` + `general`, not the main agent.** `general` is a writer, so
  a bounded search helps it the least (it can and should use `shell`), and it
  costs the same per request. Only if the owner wants a "read-only by tool set"
  story for `general` too.
- **(c) Everyone.** Cheapest to describe, most expensive per request, and it
  invites the main agent to prefer `search` over `shell` for a query `search`
  deliberately cannot express (multi-line, context, aggregated counts) — a
  papercut per query, forever, to save one tool call.

**Q2 — the owner's note: read-only MCP tools for `explore`, and `mcp__<server>__*`.
This task, or separate?**
- **(a) Separate tasks, and this one ships without either — RECOMMENDED.** Both
  are *different* mechanisms from this one and each needs its own rule decided:
  (i) "read-only MCP" needs a definition of read-only for a tool whose only
  signal is the server's own `readOnlyHint` — which `mcp/src/tool-adapter.ts:44-63`
  already treats as untrusted ("a hint is untrusted, but every call stays
  ask-gated"). Granting `explore` MCP tools on that hint would make a *child's*
  capability depend on a hint from a third-party server, and every such call
  would still be `permission: "ask"` — so an `explore` child would stop being
  prompt-free, which is its whole value. That is a §7-shaped decision, not a
  rider. (ii) The `mcp__<server>__*` wildcard is a 20-line change in
  `agent-defs.ts`'s `tools:` parsing (`agent-defs.ts:103`, `Array.isArray(data.tools)`)
  plus its match in `subagent.ts:360` — contained, and it belongs with the
  `agent-defs` tests, not here.
- **(b) Take the wildcard here.** It *is* small and it makes a custom type able
  to say `tools: [mcp__gh__*]`, which composes with (i). Cost: this task stops
  being about search, and its Blast grows into `agent-defs` (a second seam, a
  second review). Do it here only if the owner wants the pair done together.
- **(c) Take both here.** Rejected as a plan shape: two undeclared rules, one
  new subsystem's worth of decisions, in a task sized S–M. AGENTS §10 says split
  an XL, and this would be one.

**Q3 — the two paths' ignore rules: rg keeps its defaults with a shared prune
list (this plan's Design 3), or `--no-ignore` on both for literal parity?**
- **(a) rg keeps its defaults + a shared prune list + `.gitignore`'s top-level
  literal names on the fallback — RECOMMENDED, and what the measurements
  support.** Shape and bounds are identical *by construction* (one JS renderer
  over both engines' `path:line:text` lines), the result sets agree on everything
  a POSIX `find` can express (measured 7/7, `design-final.ts`), and rg stays at
  45-50 ms. The residual divergence — a `.gitignore` glob or nested path — is
  **printed**, never silent, on both engines.
- **(b) `--no-ignore` on both, ignoring nothing.** Literal, total parity of the
  result set — but measured at **409-453 ms vs 61-64 ms on this repo** for rg,
  and adding the same `-g` prunes back does not recover it (the *walk* is the
  cost). ~7× on the fast path, paid on every search of every session, to close a
  gap that only appears when `rg` is missing. Take this only if the owner values
  "the two paths can never differ" above search latency.
- **(c) Ship rg only; fail with a clear error when it is absent.** Cheapest and
  fastest, but it breaks the owner's binding constraint ("NEVER assume `rg`
  exists … must fall back") — listed only to be rejected explicitly.
- **Sub-question Q3.1 (my default in (a)):** print the "n rules not applied"
  note on **both** engines (honest, one line, tells a child the runs are not
  comparable) or **only on the fallback** (shorter output on the common path,
  but the same query then looks like it always agreed). I would print it only on
  the fallback and put the engine in the header (`engine=grep`) — say if you want
  the stricter version.

**Q4 — the engine probe: cached per `env` (this plan), or per call?**
- **(a) Cached per `env` in a `WeakMap` — RECOMMENDED.** The probe costs 24-29 ms
  and an env's `PATH` does not change under it (Design 3). Matches the existing
  `pathLocksFor` precedent (`path-locks.ts:84-92`).
- **(b) Per call.** Simpler to reason about, +25 ms on every search — on a
  183-step child that is ~4.5 s of pure probing, which is the disease this task
  cures. Rejected.

**Q5 — `max_results` default 100 / byte bound 12000: right size?**
- **(a) 100 / 12000 — RECOMMENDED.** Below the spill threshold (16000) so
  `search` never spills (Design 5), and 100 hits is enough to *locate* — a child
  that needs more should narrow, and the marker tells it so.
- **(b) 200 / 20000.** More room per call, but it reaches the spill path on a
  default config (20000 > 16000) and re-opens the `explore`-writes-a-file hole
  this task narrows.
- **(c) 50 / 8000.** Cheapest per call; risks two searches where one would do,
  which costs more than the bytes saved.

## Execution

*— (empty: PLAN ONLY; the executor fills this)*

## Review

*— (empty: PLAN ONLY; a fresh context fills this)*

## Design review

*— claude-fable-5-2, 2026-11-11*

**Verdict: REVISE.** The shape (one pure module, one JS renderer, `shq`, `-e`
/ `--`, no free-form argument, no protocol change) is right. But the fallback
was only ever measured against **BSD** `find`/`grep` on macOS with a scrubbed
`PATH` — never GNU, never busybox, the images the fallback exists for — and
several contract claims do not hold as written. Source checked only for the
claims cited below.

### HIGH

**H1 — The real engine divergence is the regex dialect, and the plan does not
mention it.** `rg` takes Rust regex, `grep -E` takes POSIX ERE. A model writes
`\d+`, `\bfoo\b`, `\w+`, `\s`, `(?i)`, `.*?` all the time; on `grep -E` these
match something else or nothing, **silently** — a far larger "different tool
depending on the image" than `.gitignore` (which gets a note, a Q3 and a
sub-question). *Change:* in the pure module, on `engine=grep`, classify the
pattern: translate the safe shorthands (`\d`→`[0-9]`, `\w`→`[[:alnum:]_]`,
`\s`→`[[:space:]]`), and **refuse** what ERE cannot express (`\b`, `(?…)`,
lazy quantifiers, look-around) with an error that names the engine and
suggests `fixed_strings`. State the supported dialect in the tool description.
Add these to the T-S1 table.

**H2 — An invalid regex is not a failure mode in the plan, and on the fallback
it reads as `no matches`.** `foo(`, `arr[0`, `a{` are the commonest model
patterns for code. rg exits 2 with a parse error; the fallback's `2>/dev/null`
discards grep's. And F14 ("rc 2 → re-run once on the fallback") would then turn
every bad regex into a second, slow, wrong run. *Change:* add the failure mode;
on a parse error return `isError` with the engine's message and "retry with
`fixed_strings: true`" (or retry literally once, with a note — owner's taste);
F14 must exclude parse errors.

**H3 — Exit codes and stderr are lost by the pipeline the plan itself
specifies.** Bounds step 1 pipes into `head -c`, so the status is `head`'s (no
`pipefail` in POSIX `sh`): rg's 1/2 never reach the tool, yet F3 and F14 branch
on them. And the fallback command ends in `2>/dev/null`, which applies to the
whole `find`, so F3's "`find: ./nope: No such file`, measured on stderr" cannot
be what the designed command produces. *Change:* keep stderr (cap it in JS),
carry the engine's status out explicitly (e.g. `{ cmd; echo "rc=$?" >&2; } |
head -c …`, or a pre-check `[ -e PATH ]`), and re-measure F3/F14 on the final
command string, not on a prototype.

**H4 — busybox, the image F1 names, most likely returns nothing at all.** F2
says a `grep` without `-I` "prints `Binary file … matches`". A grep that does
not know `-I` **rejects the option** and prints usage to stderr — which is
discarded — so every search says `no matches`. (To my knowledge busybox `grep`
has no `-I`; not verified here, which is the point.) The capability probe the
plan calls "a nicety, not a correctness requirement" is therefore required.
*Change:* make the probe mandatory and cached with the engine (`-I`, `-H`,
`find … -exec {} +`), drop `-I` when unsupported and filter binary lines in JS
(a NUL or a `Binary file` line), and make "one live run in an image without
rg" a **gate before approval**, on `alpine`/`busybox` **and** a GNU image
(`debian`/UBI), with the output pasted in the doc.

**H5 — `files` mode is not the same tool on the two paths.** The schema's own
example `src/**/a*.ts` works with `rg -g` and matches nothing with
`find -name` (basename only); a leading `!` negates on rg and is literal on
find; `ignore_case` is unspecified here. *Change:* define the glob as a
**basename glob** (no `/`, no `**`, no leading `!`; rejected by the schema with
a message pointing at `path`), map `ignore_case` to `--iglob` / `-iname`, and
test the rejection.

**H6 — The surface omits the two things that save the most steps.** The
failure being fixed is step count, so the arguments must be judged by steps:
- *No file filter in `content` mode* ("glob-and-pattern together" is listed as
  deliberately absent). `needle` in `*.ts` only is the most common query;
  without it docs, fixtures and lockfiles fill the 100 lines.
- *No "which files" answer for a pattern.* Hits are sorted by path and cut at
  100, so a symbol with 400 hits shows only the alphabetically-first
  directories and the child cannot tell where else to look — it will re-search
  or go back to slices.
  *Change:* add `glob?: string` (the H5 basename glob, valid in both modes; in
  `files` mode it replaces `pattern`, which becomes optional), and make
  `files` + `pattern` mean files-with-matches (`rg -l` / `grep -l`, both
  POSIX-clean). On a count truncation, append the per-file hit counts that
  were cut (cheap in JS, bounded). The "new quoting surface" objection does not
  hold: it is one more `shq` argument. Context lines (`-C`) I would leave out,
  as planned: `fs_read path:start:end` covers it.

**H7 — `path` is unconfined and the tool is `permission: "none"` — an owner
decision the plan never asks.** `fs_read` is already unconfined and
prompt-free (`host-execution.ts:14`, `builtins.ts:83`), but it needs a path it
already knows; a recursive search **discovers**. On the laptop
`search {path:"/Users/x", pattern:"BEGIN OPENSSH|AKIA"}` runs without a prompt,
and naming `~/.ssh` in `path` lifts the hidden-entry prune (the
"named in `path` is exempt" rule). *Change:* add an owner question, with my
recommendation: refuse an absolute path or one escaping the workspace through
`..` (lexical, in the pure module; neither engine follows symlinks), keeping
the exemption only inside the workspace.

### MEDIUM

**M1 — Path quoting is only half designed; the owner asked for pattern AND
path.** `find` has no portable `--`, so "the path always follows `--`" is false
on the fallback: `path: "-delete"` or `-exec…` is parsed as a primary. And
`! -path ROOT` takes a *pattern*, so a root like `app/[id]` (common) or one
holding `*`/`?`/`\` breaks the self-prune guard. *Change:* normalise in the
pure module (prefix `./` to any relative path, on both engines), escape glob
metacharacters in the `-path` operand, reject NUL along with `\n`/`\r` in
`pattern` and `path`, and add a hostile **path** table to T-S2 (leading `-`,
spaces, quotes, `$(…)`, `[id]`, a newline).

**M2 — "Result sets agree" is over-claimed; state the honest contract.** rg
also honours nested `.gitignore`s, `.ignore`/`.rgignore`, `.git/info/exclude`
and the global excludes file, and it applies `.gitignore` **only inside a git
repository** — in an image whose workspace was copied without `.git`, rg
ignores nothing while the fallback (Design 3b) still prunes: the fallback is
then the *stricter* one, and the note points the wrong way. Design 3b also
reads only the workspace root's file whatever `path` is. *Change:* pass
`--no-require-git` to rg; word the contract as "same shape, bounds and
ordering; the result set is best-effort and the header names the engine"; make
the note say "may differ" rather than "may include ignored files". Q3(a)'s
text says the note prints "on both engines" while Design says fallback only —
pick one (fallback only is fine).

**M3 — When the raw cap bites, the result is a nondeterministic subset
presented as "first N".** rg's output order is parallel; `head -c` cuts it,
*then* JS sorts and keeps N. One minified line can consume the whole 256 KiB
and drop every other hit. On the fallback, `find` keeps walking after `head`
exits (each `grep` dies on SIGPIPE) until the timeout. *Change:* a distinct
marker when the raw cap was hit (`results incomplete — not the first N`), drop
the trailing partial line, decode non-fatally; give rg `--max-columns` so one
line cannot eat the cap; and reconsider `--sort path` — its measured cost is
27 ms, nothing next to one model step. Test: a single 300 KB line plus other
hits.

**M4 — The engine cache can be poisoned, and F14 never demotes it.** "A failed
probe caches `grep`" pins a 5 s-per-search path for the whole session after one
transient `exec` failure — or after a turn cancelled during the first search,
if the probe carries `ctx.signal`. And when rg exists but is broken, F14 pays
rg + fallback on **every** call. *Change:* cache only a definitive answer (do
not cache a rejection/abort; probe without the call's signal), probe with
`rg --version` rather than `command -v`, and on F14 demote the cached engine to
`grep` for that env. Test both.

**M5 — Q1's recommendation misses the permission angle.** `shell` is
`permission: "ask"` (`builtins.ts:286`), so for the main agent and `general`
a grep is a prompt (or an allow-rule) and unbounded output; `search` is
prompt-free and bounded. That is a UX gain, not "a second way to do the same
thing", and ~600 characters of definition is a weak counter-argument. *Change:*
put this in Q1 and let the owner choose knowingly; I would recommend (c)
everyone, conditional on H7 being settled (a prompt-free search for the main
agent makes the confinement question sharper, not weaker).

**M6 — T-S1 has no stated behaviour on a machine without `rg`.** It asserts
"the rg run actually used rg"; CI does not install ripgrep (no mention under
`.github`), and the baseline forbids a non-opt-in skip (AGENTS §6). *Change:*
say which: CI installs rg (preferred — the parity test is the feature's proof),
or the real-rg half is an explicit opt-in while the pure-module tests run on
recorded engine output.

**M7 — Two smaller claims to correct in the text.** (a) Design 4 says a
`search .` "conflicts with an `fs_edit a.ts`": it does not — `pathResource` is
the basename (`path-locks.ts:47-51`), so the keys differ; say that a search
does not serialise against writes in the same round (acceptable), rather than
relying on a conflict that never happens. (b) F9 strips all C0 characters:
keep `\t`, or indentation in every hit is mangled. Precondition 1 also says
`exec` is the env's "only member" while Design 3b uses `ctx.env.readFile`
(`execution.ts:46` — it exists; fix the sentence).

### Owner questions

Q2 (MCP separate), Q4 (cache per env, with M4) and Q5 (100 / 12000) are sound.
Q3 is a real question but the smaller one; missing and needing the owner are
**H7** (confinement of `path`), **H1/H2** (what a pattern the fallback cannot
express does: translate, refuse, or retry literally) and **H6** (the `glob`
field and files-with-matches).
