# feat/explore-search — a bounded, read-only `search` tool for the agent tree

> **Status:** **EXECUTED** (2026-11-12) — Implementation + Revision 1 approved with the owner answers committed; Execution below is the as-built, with three drifts (see *Drift*). Review pending in a fresh context. · **Branch:** `feat/explore-search` (off `main`)
> **Type:** feat · **Size:** M (it grew from S–M with revision 1: `glob` + files-with-matches, the dialect table, the probe/demotion path, the confinement rule) · **Blast:** cross-module (a new built-in tool + one array in `subagent.ts`; no wire, persistence or §7-invariant change) · **Suited:** DeepSeek exec, **Review in a fresh context** (the two dialect tables and the confinement rule are the failure-prone parts)

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
note, never silent. *(Revision 1 narrows "identical" to shape/bounds/ordering and
adds the regex-dialect divergence, which this BSD-only table could not see: see
the measured-facts block at the end of this Context and the Load-bearing
assumption.)*

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


**Revision 1 — the fallback measured on GNU and busybox (the gate H4 demanded).**
The design review's central charge was that every fallback claim was measured
only on **BSD** tools (`grep 2.6.0-FreeBSD`, BSD `find`) on macOS. Re-measured
2026-11-11 on a fixture (`fxf/`: `.git`, a `.gitignore` with `node_modules/`,
`dist/`, `coverage`, `*.log`, `pkg/a/`, a hidden file, a NUL file, a leading-dash
file, `app/[id].ts` and `app/[id]/k.ts`, a symlink to `/etc`) mounted read-only:

```
$ podman images | head -3                 # already pulled, nothing new to fetch
docker.io/library/nginx  alpine          76090a34b858   70.5 MB
$ podman pull -q busybox:latest debian:bookworm-slim alpine:3.20
$ podman run --rm -v "$PWD/fxf:/w:ro" -w /w <img> sh <script>
```

Engines under test: **busybox 1.38.0** (`busybox:latest`), **busybox 1.36.1**
(`alpine:3.20`), **GNU grep 3.8** + GNU find (`debian:bookworm-slim`), **rg
14.1.0** (`alpine` + `apk add ripgrep`), and the macOS originals (**BSD grep
2.6.0-FreeBSD**, BSD find, **rg 15.2.0**).

*(a) busybox `grep`: option support — H4's premise is half wrong, and the half
that is right is worse than "rejects the option".*

```
$ grep --help                      # busybox: "-I" is NOT in the usage line
Usage: grep [-HhnlLoqvsrRiwFE] [-m N] [-A|B|C N] { PATTERN | -e PATTERN... | -f FILE... } [FILE]...
	-E	PATTERN is an extended regexp          <- present
	-F / -i / -w / -x / -l / -c / -o / -q / -s / -r   <- all present
                                               no -I, no --include, no --binary-files
$ grep --version            busybox: "unrecognized option '--version'" rc=2 | GNU: "grep (GNU grep) 3.8"
$ grep -I -n needle /w/bin.dat       # busybox: "1:needle"  rc=0   <- -I ACCEPTED, DOES NOTHING
$ grep    -n needle /w/bin.dat       # busybox: "1:needle"  rc=0
$ grep -I -n needle /w/bin.dat       # GNU    : no output      rc=1 (suppressed)
$ grep    -n needle /w/bin.dat       # GNU    : "binary file matches" rc=0
$ grep -n --binary-files=without-match needle /w/bin.dat   # busybox rc=2 (unrecognized) | GNU rc=1
$ grep -r --include='*.ts' needle /w                       # busybox rc=2 (unrecognized) | GNU: 3 files
```

So: busybox **has** `-I`, `-r`, `-E`, `-H`, `-l`, `-c`, `-o`, `-i`, `-F`, `-s`
and `-exec {} +` (all used below); it has **no** `--include`, no
`--binary-files`, no `--version`. `-I` is accepted and ignored — a grep that
"rejects the option" would at least have failed loudly; this one silently
searches binaries, which is the divergence F6 claimed was impossible. The
capability probe is therefore **mandatory** (H4 accepted), and its form is
measured: one process, `printf 'a\000needle\n' | grep -I -q -e needle -`
→ **rc 1 on GNU/BSD (binary filtered)**, **rc 0 on busybox (not filtered)**,
so `-I` is passed only when the probe says it works, and the JS parser filters a
`binary file matches` line / a NUL byte either way.

*(b) The real divergence is the regex dialect — H1, measured on three engines.*

```
$ grep -E -e '<pat>' dg.txt     # L1 A1 / L2 foo_bar / L3 x  y / L4 \D \W / L5 back\1ref
                                # L6 (?:ab) / L7 \x41 hex / L8 aab / L9 abc / L10 arr[0
pat          BSD 2.6.0-FreeBSD        busybox 1.38.0                GNU 3.8
\d+          rc0 ALL 10 lines         rc1  no match, SILENT          rc1  no match, SILENT
\w+          rc0 ALL 10 lines         rc0  ALL 10 lines             rc0  ALL 10 lines
\s           rc0 ALL 10 lines         rc0  ALL 10 lines             rc0  ALL 10 lines
\bfoo\b      rc1  none                rc1  none                    rc1  none
(?i)abc      rc0  L9 (case-folds!)    rc2  "bad regex"             rc1  WARNING on stderr, no match
(?:ab)       rc0  L6,L8,L9            rc2  "bad regex"             rc0  L6 (warning)
\x41         rc0  L1 (hex escape)     rc0  L7 (literal \x41!)      rc0  L7 (literal \x41!)
\p{L}        rc1  none                rc2  "bad regex"             rc1  none
[[:word:]]   rc2  invalid class       rc2  invalid class           rc2  invalid class
a**          rc2  repetition operand  rc0  ALL 10 lines (!)        rc0  ALL 10 lines (!)
a.*?b        rc0  L6,L8,L9            rc0  L6,L8,L9                rc0  L6,L8,L9
rg 15.2      \d+ ALL  \p{L} ALL  (?i)abc L9  \x41 L1  (?:ab) L6,L8,L9  [[:word:]] ALL
```

`\d+` is the killer: **BSD grep matches every line containing a `d`**, GNU and
busybox match **nothing**, rg matches digits — three answers, two of them
silent. Asserted in T-S1 as a table (H1 accepted), with the design below.

*(c) Exit codes are lost by the plan's own `| head -c` — H3, confirmed.*

```
$ { grep -E -e 'foo(' /w/src/a.ts; echo "rc=$?" >&2; } 2>e | head -c 262145 >/dev/null
e: "rc=2"                                    # the brace group carries it
$ grep -E -e 'foo(' /w/src/a.ts 2>/dev/null | head -c 262145 >/dev/null; echo $?
0                                            # the bare pipeline loses it (old shape)
```

Verified with the **final command shape** on busybox, alpine and debian
(`fin2.sh`): plain hit → `outer rc=0, stderr "TENTACLE_RC=0"`; no match →
`TENTACLE_RC=1`; bad regex → busybox `grep: bad regex 'foo(': Unmatched (` +
`TENTACLE_RC=1`, GNU `grep: Unmatched ( or \(` + `TENTACLE_RC=1`; missing path
→ pre-check `[ -f ] || [ -d ] || [ -L ]` exits **3** with `TENTACLE_MISSING`
and no walk; bracket root `/w/app/[id]` and leading-dash root `/w/-dash.ts`
both searched correctly. `find … -exec {} +` returns **1** for both "no match"
and "grep died", so on the fallback a parse error is detected by **stderr**,
not by rc (see Design 3c).

*(d) Two more measured parity facts the old plan got wrong.*

```
$ find /w/etc-link -type f  | wc -l      # 0     (a symlink given as PATH is not entered)
$ find -H /w/etc-link -type f | wc -l    # 55    (POSIX -H: follow only the ARGUMENT)
$ rg   --files -- /w/etc-link            # lists /etc/*  (rg follows an argument symlink)
$ find -dash.ts …      busybox "unrecognized: -dash.ts" | GNU "unknown predicate" | BSD "illegal option"
$ find ./-dash.ts …    all three: ./-dash.ts        <- ./ prefix is the portable fix
$ find '/w/.hid[x]' \( -name '.*' ! -path '/w/.hid[x]' \) -prune -o -type f -print
                       all three: (nothing)         <- guard fails to exempt the root, `-name '.*'` prunes it
$ find '/w/.hid[x]' \( -name '.*' ! -path '/w/.hid\[x\]' \) -prune -o -type f -print
                       all three: /w/.hid[x]/f.ts   <- escaping the operand fixes it (M1)
$ find '/w/app/[id]' …   raw and escaped: both /w/app/[id]/k.ts   (NOT affected — its basename
                       matches no prune `-name`, so nothing prunes it; measured, same on all three)
```

So `-path` is a *pattern* and the guard only matters when the root's **basename
also matches a prune clause** (`-name '.*'` for a hidden directory, or
`node_modules`/`dist`/`.git`). Escaping costs nothing and closes it; the first
draft of this revision over-stated it by claiming `app/[id]` broke too.

*(e) rg's `.gitignore` behaviour without `.git` — M2 confirmed, and it is real.*

```
$ podman run --rm -v fxm:/w:ro alpine:3.20 sh -c 'apk add -q ripgrep; rg --files -- /w; rg --no-require-git --files -- /w'
rg 14.1.0  default     : /w/sub/s.ts /w/src/a.ts /w/src/y.log /w/deep/x/z.ts /w/pkg/a/x.ts   (ignores NOTHING)
rg 14.1.0  --no-require-git: /w/src/a.ts /w/deep/x/z.ts                                     (.gitignore applied)
rg 15.2.0  same fixture, default and --no-require-git both apply it (15.x changed the default)
```

In a workspace copied **without** `.git` the old plan's rg side would ignore
nothing while the fallback (Design 3b) still prunes from `.gitignore` — the
**fallback is the stricter one**, so the note pointed the wrong way. `--no-require-git`
fixes it at no measurable cost (`24 ms vs 25 ms` on `rg --files .`).

*(f) Cost of the two flags M3 asked to reconsider.*

```
rg -e needle -- packages/          39 ms | --sort path   50 ms   (repo-wide: 38 ms vs 50 ms, 14 lines)
rg --max-columns 1200 --max-columns-preview on a 300 KB single-line file: 1234 bytes, other hits intact
rg --max-columns 1200 (no preview)      : "[Omitted long matching line]" — useless, so preview is required
```

`--sort path` costs ~11 ms — nothing next to one model step, and it makes the
`head -c` subset deterministic, so it is taken (M3).

*(g) Fallback vs rg cost and parity, re-measured on this repo's `packages/`
with the final shape (`find -H … -exec grep -n -H -I -s -E`, macOS BSD tools):*

```
fallback 174 / 165 / 273 ms      rg (--no-require-git --sort path) 46 / 50 / 40 ms
same query through both: 36 lines each, identical set (68 lines each on the worktree root)
```

So the fallback is ~4-5× slower on a small tree (and the walk-dominated 7×
figure from the pre-repro still applies to a tree with `node_modules`/`dist` in
it), which is why `engine=grep` is in the header and why the timeout exists.

*— deepseek (tentacle --profile deepseek), 2026-11-11*

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11 (revision 1)*

### Load-bearing assumption

**A tool that spells its whole operation as ONE `sh -c` string built from a
fixed flag list plus single-quoted arguments is safe and portable across every
`ctx.env` (laptop, docker, pod), and the SAME SHAPE, BOUNDS AND ORDERING come
out whether the engine inside is `rg` or POSIX `find`+`grep` — while the result
SET is best-effort and the header names the engine.**

Revision 1 narrows the second half deliberately (review M2/H1): "identical
output" was over-claimed. What is proven:

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
   (or `-F -e`), and the path always follows `--` on `grep`. `find` has no
   portable `--` (review M1), so the path is never bare on the fallback either:
   every relative path is `./`-prefixed in the pure module (measured above:
   `find -dash.ts` is an error on all three, `find ./-dash.ts` works) and an
   absolute path is confined before it is ever built into a command (H7).
   Verified: `rg --version` as a *pattern* matched nothing (`repro-doc.ts`), and
   a `$(touch pwned)` pattern created no file (same run: `a $(touch pwned)
   pattern created a file: false`).

2. **One shape from two engines — shape only.** Both engines emit
   `path:line:text` lines (or bare paths in `files` mode), and **one** JS
   renderer sorts, caps and truncates them, so *shape* cannot depend on the
   engine; that part still holds by construction (`design-final.ts` 7/7,
   `repro-doc.ts` 11/11 on BSD tools, and the `fin2.sh` runs above reproduce the
   same shape on busybox, alpine and debian). What could not be held, and is now
   stated instead of claimed:
   - the **result set** (which files are walked) differs whenever `.gitignore`
     says something `find -name` cannot express — printed as a note, never
     silent (Design 3b, M2);
   - the **regex dialect** differs and cannot be unified — `\d+` matches every
     line with a `d` on BSD grep and nothing on GNU/busybox (measured above), so
     the pattern is normalised or refused in the pure module before it reaches
     either engine (Design 3c, H1/H2).

The whole feature stands or falls on this: if the two paths disagreed on
*shape*, "same output shape and bounds" would be false and the model would see a
different tool depending on the image.

### Preconditions

Each verified against the code on this branch:

1. **Every tool effect goes through `ctx.env`, and `ctx.env.exec` is `sh -c
   <string>`.** `ToolContext.env` is an `ExecutionEnvironment`
   (`packages/core/src/tool.ts:121`), whose members are `exec`, `readFile`,
   `writeFile` and an optional `spawnBackground`
   (`packages/core/src/execution.ts:42-58` — review M7c: revision 0 said "only
   member", which was wrong, and Design 3b needs `readFile`);
   `HostExecution.exec` is `Bun.spawn(["/bin/sh", "-c", command])`
   (`packages/exec/src/host-execution.ts:238,303-323`). So a single command
   string is the portable unit, and `ExecOptions` gives `cwd`, `signal`,
   `timeoutMs` (`execution.ts:15-22`) — cancellation and a wall-clock bound come
   for free, exactly as `shell` uses them (`builtins.ts:300-305`). `exec` also
   returns `stderr` and `exitCode` as first-class fields (`execution.ts:9-13`),
   which is what H3's fix relies on.
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
   hence: no free-form command argument anywhere in the schema (Design, *Input
   schema*). Note
   what `fs_read` precedent does **not** buy (review H7): `fs_read` is unconfined
   but *inert* — it reads a path the caller already names — while a recursive
   search **discovers** paths, so `permission: "none"` on it is a decision the
   owner has to make explicitly (Q6).
6. **The documenting rule for a tool name is `toolLabel`**
   (`packages/core/src/tool-labels.ts:7-17`, display only) and, for a child's
   progress row, `childToolLabel` (`subagent.ts:234-255`). Both need an entry or
   the row reads as a bare `search`.
7. **There is no workspace root on the `ExecutionEnvironment` contract.**
   `HostExecution` keeps one privately (`host-execution.ts:211`, `:232`) and
   confines *writes* by it, but the interface exposes only `id`, `exec`,
   `readFile`, `writeFile` (`execution.ts:42-58`) — so a confinement rule in the
   pure module cannot ask the env for its root; it must derive one from
   `exec`/`pwd` or be lexical against `cwd` (Q6, Design 3c step 0).

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
is what the model reads). Revision 1 adds `glob` (H6), defines it as a basename
glob (H5), and moves `pattern`'s regex dialect into the schema (H1):

| field | type | default | notes |
|---|---|---|---|
| `pattern` | `string` | — (required in `content`; required in `files` only when `glob` is absent) | `content`: a regex (see *dialect* below). `files` **with** `pattern`: files-**with-matches** for that pattern (`rg -l` / `grep -l`, H6) — the "which files contain X" answer. |
| `glob` | `string` | — | **basename glob** (`*.ts`, `a*.ts`, `[[]id[]].ts`): no `/`, no `**`, no leading `!`, no `..` (H5). `content`: restrict the walk (`-g` / `-name`). `files` without `pattern`: the file list (`-g` / `-name`). |
| `path` | `string` | `"."` | File or directory. Relative is `./`-prefixed in the pure module; absolute is allowed only if Q6 says so (H7/M1). The only thing in path position. |
| `output_mode` | `"content" \| "files"` | `"content"` | `files` lists matching paths only. |
| `fixed_strings` | `boolean` | `false` | `content`/`files`-with-pattern: treat `pattern` literally (`-F -e` / `grep -F`). |
| `ignore_case` | `boolean` | `false` | `--ignore-case` / `-i` for content; `--iglob` / `-iname` for a `glob` (H5 — previously unspecified). |
| `max_results` | `int ≥ 1` | `100` | The count bound. Clamped to a hard ceiling (`MAX_RESULTS_CEILING = 1000`). |

**`glob` is a basename glob, and that is enforced, not documented** (H5). Measured:
`rg --files -g 'src/**/a*.ts' -- fxf` → `rc=1`, nothing; `find fxf -name 'src/**/a*.ts'`
→ nothing. So the schema `.refine`s it — `/` present ⇒ reject with "`glob` is a
file-name pattern; put the directory in `path` instead", same for `**`, a
leading `!` (rg negates, `find` takes it literally), and `..`. Allowed metacharacters
stay `*`, `?`, `[...]`; a literal `[` is spelled `[[]` (measured: `find -name
'[[]id[]].ts'` matches `[id].ts` on busybox, alpine, debian and BSD `find`);
`ignore_case` maps to `--iglob` / `-iname` (measured: `find -iname '*-dash*'`
matches `-dash.ts` on all three; `rg --iglob '*.TS'` matches `.ts`).

**`pattern`'s dialect, per engine (H1).** The tool must not hand a model a
dialect it cannot see. On `engine=grep` the pure module classifies `pattern`
against the ERE baseline actually measured on GNU 3.8, busybox 1.38 and BSD
2.6.0 (table in Context (b)), in three classes:

- **translated** — `\d`→`[0-9]`, `\D`→`[^0-9]`, `\w`→`[[:alnum:]_]`, `\W`→`[^[:alnum:]_]`,
  `\s`→`[[:space:]]`, `\S`→`[^[:space:]]`, and `[:word:]`→`[:alnum:]`. Measured
  identical to rg for `\w`, `\s`, `[[:word:]]`; **`\d` differs** (BSD: every `d`;
  GNU/busybox: nothing) — so translating is not a nicety, it is the fix.
- **refused with a message naming the engine** — `(?…` flags/groups (busybox:
  rc 2; GNU: a **warning on stderr and rc 1**, i.e. silently no match), `\p{…}`
  (busybox rc 2; GNU/BSD rc 1 — silently nothing), `(?:` (busybox rc 2; GNU:
  rc 0 but matching only the *literal* `(?:ab)` text — a silent meaning change),
  lazy `*?`/`+?` (**measured, not assumed**: with `-o` on `axxbxxxb`, BSD and rg
  return `axxb` for `a.*?b` and `axxbxxxb` for `a.*b`, while busybox and GNU
  return `axxbxxxb` for **both** — the `?` is a literal quantifier, a silent
  meaning change that the *line* set hides; the tool never passes `-o`, so the
  distinction only shows in the match text, which is exactly the kind of
  difference that is refused on "different meaning", not on a mismatched line
  set), a `{n,m}`
  brace form (`a{2}` matched nothing on GNU, busybox and BSD — rg matches), and
  `\x41`/`\u` (BSD: a hex escape; GNU and busybox: the literal text `\x41` —
  three engines, two meanings, both silent). Each refusal says what to do
  instead: `fixed_strings: true`, or a POSIX class.
- **NOT refused, because measurement says it works (a correction to the review):**
  `\b` / `\B`. Measured `\bfoo\b` → `foo` (and not `xfoo`/`fooX`) on BSD 2.6.0,
  busybox 1.38.0, GNU 3.8 **and** rg 15.2.0, so it is passed through.
- **passed through** — everything else, which is ERE in both dialects.

On `engine=rg` the same classifier still runs, but only to *report* (the tool
description states the dialect; no rewriting happens when rg is present, because
rg accepts the whole Rust-regex set). The refusal is the one place the two
engines differ *by design* rather than by accident: identical on both paths
beats silently-different, and the message tells the model how to proceed.

**A pattern the fallback cannot express is not an error the model cannot act on
(H1/H2 ⇒ Q7).** Whatever Q7 decides (translate + refuse; or retry literally with
a note; or single-engine), the *fallback* path always ends in an actionable
`ToolResult`: either a translated run with a `[note: pattern rewritten for
grep: \d → [0-9]]` line, or a refusal (`isError: true`) whose body names the
offending construct, the engine, and the two ways forward. Never `no matches`.

**Bounds, enforced in this order** (the same on both paths, unless stated):

0. **Confinement, before anything runs** (H7/M1, Q6). In the pure
   module, lexically: reject a NUL/`\n`/`\r` in `pattern`, `path` or `glob`;
   normalise a relative `path` to `./…`; and, per Q6, refuse an absolute `path`
   or one that climbs out of the workspace with `..`. A refusal is a
   `ToolResult` with `isError: true` and a message naming the rule — never a
   silent rewrite.
1. **Existence pre-check, in the shell** (`[ -e ]`, H3):
   `if [ ! -f P ] && [ ! -d P ] && [ ! -L P ]; then printf 'TENTACLE_MISSING\n' >&2; exit 3; fi;`
   — POSIX, one line, measured correct on busybox, alpine, debian and BSD with
   a file, a dir, a symlink and a missing path. It replaces F3's "read find's
   stderr and guess": a missing path is now a **distinct status 3**, so the
   diagnosis never depends on parsing an engine's wording.
2. **Raw cap, in the shell**: `| head -c 262145`. A backstop so a pathological
   walk cannot buffer unbounded output into `exec`'s `Response.text()`
   (`host-execution.ts:259-263` — already named as a debt for `shell`,
   `TODO.md:84-85`). 256 KiB is far above the display bound, so it never
   truncates a legitimate result; hit exactly at 262145 bytes it keeps one byte
   of slack so JS can *detect* that it was hit (`raw.length === CAP`) and say so
   (M3).
3. **Count bound, in JS**: keep the first `max_results` whole lines; if the raw
   stream held more, emit `[search truncated: first N matches — narrow the
   pattern or path]` **plus the per-file hit counts that were cut** (H6):
   `[more matches in: ./pkg/a/x.ts 12, ./README.md 9, …+3 files]`, computed from
   the lines already buffered (one cheap pass, no second run), capped to 5
   entries. That is the "where else do I look" answer, and it is bounded.
4. **Byte bound, in JS**: keep whole lines summing to ≤ `MAX_BYTES = 12000`
   (under `tools.maxInlineOutputChars`'s default 16000,
   `packages/config/src/defaults.ts:49`, so a normal search never reaches the
   spill path at all — see the spill note below); if it cut, emit
   `[search truncated: 12000 bytes — narrow the pattern or path]`.
5. **Per-line cap, in JS**: `MAX_LINE = 300` characters, `…` when cut. A
   minified bundle is one line; without this a single hit eats the whole byte
   budget. On `engine=rg` the same cap is *also* pushed down as
   `--max-columns 1200 --max-columns-preview` (M3): measured, an 300 KB single
   line becomes 1234 bytes and every other hit survives, whereas
   `--max-columns` **without** `--max-columns-preview` prints
   `[Omitted long matching line]` (useless). The fallback has no equivalent and
   relies on this JS step alone.

A line cap in JS, not `cut -c`, because `cut -c` is neither byte- nor
character-safe across BSD and GNU (measured: BSD `cut -c` on CJK cut mid-byte —
the plan's pre-repro rejected it).

**Status and stderr, carried out explicitly (H3).** The `| head -c` pipeline
makes `sh` report *head's* status: measured, `grep -E -e 'foo(' … 2>/dev/null |
head -c …; echo $?` → **0**, while the same grep alone → **2**. POSIX `sh` has
no `pipefail` (debian's `dash`: `set -o pipefail` fails; busybox `sh`: it
happens to support it — do not rely on either). So the command carries the
engine's status out on **stderr**, which `exec` returns as its own field
(`execution.ts:9-13`) and which is *never* `2>/dev/null`'d for the whole
pipeline:

```
{ <walk> ; printf 'TENTACLE_RC=%s\n' "$?" >&2; } | head -c 262145
```

Measured with this exact shape on busybox, alpine and debian: hit →
`TENTACLE_RC=0`; no match → `TENTACLE_RC=1`; bad regex → the engine's own
message plus `TENTACLE_RC=1` (`find -exec {} +` collapses both 1 and 2 to 1 —
so a **parse error is detected from stderr** (`bad regex`/`Unmatched`/`warning:`
/`regex parse error`), not from rc); missing path → status **3** and
`TENTACLE_MISSING`. Per-file `grep` noise is suppressed with `-s` (`-s -e
needle -- /w/nope` → rc 2 on GNU/busybox/BSD, so `-s` is safe and kept), and the
`head`-induced SIGPIPE chatter (`find: 'grep' terminated by signal 13` on debian)
is filtered by the parser, not by discarding stderr.

**Output format** — three header shapes, so a child can tell them apart without
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
```
[files containing "needle" in .]  (engine=rg)
./src/a.ts
./README.md
```

- `path:line:text`, one hit per line, **sorted by path then line number** in JS.
  Revision 1 *also* passes `--sort path` to rg (M3): measured cost **11 ms**
  (38→50 ms repo-wide; the earlier "45 %" figure does not reproduce), and it
  makes the `head -c` subset deterministic instead of a parallel-order sample —
  so "first N matches" is a true statement rather than a lottery. The fallback's
  `find` order is still engine-defined, so **the JS sort remains the source of
  ordering** on both paths; `--sort path` only makes truncation sane.
- **A tab survives** (M7b): the control-character strip keeps `\t` and drops the
  other C0/DEL characters, so indentation in a hit is readable.
- `no matches` alone when the set is empty — an explicit sentence, not an empty
  body, because an empty result is the most common answer and an empty string
  reads like a failure.
- **`engine=…` is in the header on purpose.** The fallback's ignore rules are
  weaker (Design 3), and a child that knows it is on the fallback can widen its
  own query. It is one token on a line that carries the query anyway.
- A note line, when a rule could not be applied —
  `[note: 2 .gitignore rules (*.log, pkg/a/) are not applied on this engine; results may differ]`
  — **fallback only**, and **never silent** (Failure modes). The wording is
  "may **differ**", not "may include ignored files" (M2): measured, the two
  directions both occur — the fallback can include files rg ignored, and (with
  `.git` absent and rg < 15) rg can include files the fallback pruned.
- A truncation that hit the **raw cap** gets its own marker (M3): `[search
  truncated at 256 KiB — results are INCOMPLETE, not the first N]`, because a
  cut byte stream is a nondeterministic subset even with `--sort path` (the cap
  can bite mid-walk). The trailing partial line is dropped before parsing.

**Design 3 — the two engines, and how far they are kept identical.**

*The honest contract (M2).* After revision 1 the claim is exactly this:
**same shape, same bounds, same ordering; the result set is best-effort, and the
header names the engine.** rg honours nested `.gitignore`s, `.ignore`,
`.rgignore`, `.git/info/exclude` and the global excludes file; it applies
`.gitignore` where a repo is detected (`--no-require-git` removes that
condition); the fallback can only prune by *name*. So the two sets can differ in
both directions, and the note says "may differ" rather than "may include ignored
files". What is *not* best-effort: `path:line:text`, the JS sort, the five
bounds (Design, *Bounds*), the truncation markers, `no matches`, and the three
header shapes.

*What the note covers (M2).* Design 3b reads the **workspace root's**
`.gitignore` whatever `path` is — that is deliberate and now said out loud: a
nested `.gitignore` under `path` is not read on either side (rg applies it
itself; the fallback cannot), so the note is about the root file only, and a
nested rule is invisible to the fallback. Q3(a) is amended to match the Design
(fallback only).

*Search commands.* Verbs differ; prune lists, shape and status do not. `PRUNE` is
one constant, applied to rg as negated globs and to `find` as `-prune` clauses,
so the same *names* are excluded on both paths — and **rg keeps its own default
walk** (`.gitignore`, hidden entries) rather than being told to ignore nothing,
because that is what keeps the fast path fast (measured: 45 ms vs 409-453 ms,
pre-repro). Revision 1's shape (H3, H5, H6, M1, M3 all applied):

```
CAP = 262145            # 256 KiB + 1 byte of slack so JS can detect the cap
PRE = [ -f P ] || [ -d P ] || [ -L P ]      # else: TENTACLE_MISSING on stderr, exit 3
EXIT = { <walk> ; printf 'TENTACLE_RC=%s\n' "$?" >&2; } | head -c CAP

rg   (content): rg --no-require-git --sort path --max-columns 1200
                   --max-columns-preview --no-heading --line-number
                   --color=never --with-filename [-i] [--fixed-strings]
                   -g '!**/.git/**' [-g GLOB] -e PATTERN -- PATH
rg   (files):   rg --files --no-require-git --sort path
                   -g GLOB [-g '!**/.git/**'] -- PATH          # glob only
                rg -l --no-require-git --sort path [-i] [--fixed-strings]
                   [-g GLOB] -e PATTERN -- PATH                 # files WITH matches

find (content): find -H PATH \( -name .git ! -path PATH \) -prune -o \
                   \( -name node_modules ! -path PATH \) -prune -o … -o \
                   -type f [-name GLOB] -exec grep -n -H [-I] -s -E -e PATTERN -- {} +
find (files):   find -H PATH \( … -prune \) -o -type f -name GLOB -print
find (fwm):     find -H PATH \( … -prune \) -o -type f [-name GLOB] \
                   -exec grep -l [-I] -s -E -e PATTERN -- {} +
```

Seven points here are load-bearing and were each measured (Context (a)–(g)):

- **`-H` on `find` (new, measured):** a symlink given as `PATH` is not entered
  by plain `find` (0 files vs 55) while **rg follows an argument symlink**. POSIX
  `-H` follows only the argument, never the walk, so it restores parity without
  ever introducing a loop (F7 still holds: no `-L`).
- **`-I` only when the probe says it works (H4).** busybox **accepts** `-I` and
  ignores it (measured), GNU honours it. So the flag is conditional, and the
  parser drops a `binary file matches` line / a NUL-bearing line either way.
- **`-s` instead of `2>/dev/null` (H3).** Per-file read errors are silenced at
  the grep, which is what `-s` is for; stderr stays available for the regex
  diagnosis and the `TENTACLE_RC` line.
- **`--no-require-git` on rg (M2, measured).** Without it, rg < 15 applies
  `.gitignore` only inside a git repo, so in a workspace copied without `.git`
  the *fallback* would be the stricter path and the note would point the wrong
  way. Cost measured at 24 ms vs 25 ms.
- **`--sort path` + `--max-columns`/`--max-columns-preview` on rg (M3).**
  11 ms, and both make the byte-capped subset deterministic and bounded per
  line. Without `--max-columns-preview` rg prints `[Omitted long matching line]`,
  which is useless; with it, a 300 KB line costs 1234 bytes.
- **`! -path ROOT` on every prune clause, with the operand glob-escaped (M1).**
  `find .` matches its own root against `-name '.*'` — without the guard the
  whole walk prunes itself. And `-path` takes a *pattern*: a root like
  `app/[id]` or `.hid[x]` in the root makes the guard unreliable; measured: a
  **hidden** metachar root (`.hid[x]`) prunes itself to zero results unescaped
  and returns its files escaped, on busybox, alpine, debian and BSD — while a
  non-hidden `app/[id]` root is unaffected (its basename matches no prune
  clause), so escaping is cheap insurance rather than a universal fix.
- **A prune name the caller NAMED in `path` is exempt on both sides.** Asking
  for `src/node_modules` must search it; rg's `-g '!**/node_modules/**'` is
  dropped and `find`'s clause is skipped for that name. Measured: parity holds
  for every root once the exemption is in (`.`, `./`, `src`, `./.config`,
  `.hidden.txt`, `node_modules`, `src/node_modules`). Revision 1 scopes the
  exemption to paths **inside** the workspace (Q6), because `path: "~/.ssh"`
  must not lift the hidden-entry prune.

`--no-ignore` was measured and **rejected**: it makes rg walk
`node_modules`/`dist`/`.tentacle/worktrees` and costs 7× (409-453 ms vs
61-64 ms), and adding the same `-g` prunes back does not recover it (453 ms) —
the walk, not the filter, is the cost.

**Design 3a — the capability probe, cached, and never poisoned (M4 + H4).** One
probe process, once per environment, emitting three facts on stdout:

```
if rg --version >/dev/null 2>&1; then printf 'TENTACLE_ENGINE=rg\n'; else printf 'TENTACLE_ENGINE=grep\n'; fi
grep -E -H -e _t_ -- /dev/null >/dev/null 2>&1;              printf 'TENTACLE_GREP_CAPS=%s\n' "$?"
printf 'a\000needle\n' | grep -I -q -e needle - >/dev/null 2>&1; printf 'TENTACLE_BINFILTER=%s\n' "$?"
```

Measured end-to-end inside the container (`podman run … sh probe2.sh`):
`TENTACLE_ENGINE=grep`, `TENTACLE_GREP_CAPS=1`, `TENTACLE_BINFILTER=0` on
busybox (so: `-I` is ignored → do not pass it, filter in JS) and
`…_BINFILTER=1` on debian (so: `-I` works → pass it). Host cost per probe:
30-38 ms (`command -v rg` 30 ms, `rg --version` 38 ms, a `grep` start-up 36 ms).

Four deliberate changes from revision 0:

- **`rg --version`, not `command -v rg`.** `command -v` proves a file exists,
  not that it runs; measured, a broken wrapper would pass `command -v` and fail
  every search. `--version` costs the same and is the only real test.
- **The probe carries NO `ctx.signal` (M4).** A turn cancelled during the first
  search must not cache a failed probe; the probe has its own 5 s `timeoutMs`
  instead.
- **Only a definitive answer is cached.** `TENTACLE_ENGINE` present ⇒ cache it.
  Probe rc ≠ 0, a timeout, an abort or unparseable output ⇒ **cache nothing**
  and use the fallback for *this* call; the next call probes again. The
  `WeakMap<ExecutionEnvironment, Promise<Engine>>` sits next to the
  `pathLocksFor` precedent (`packages/core/src/path-locks.ts:84-92`).
- **F14 demotes the cache (M4).** When rg was chosen but the run fails with a
  parse-free, engine-shaped failure (stderr mentions `rg:` and rc ≥ 2 for a
  reason that is not a regex error), the cached engine is **overwritten with
  `"grep"`** for that env before the single retry, so the next call does not pay
  rg again. One retry per call, one demotion per env — no loop (§0).

**Design 3b — reading `.gitignore`, for prunes and for the note.** The
workspace root's `.gitignore` is read with `ctx.env.readFile` (cheap,
unconfined by design, `host-execution.ts:14-15`) and each rule is classified:

- **a top-level literal name** (`node_modules/`, `dist`, `coverage`) → added to
  the fallback's `PRUNE`. This is what makes the common case agree, and it is
  the *only* rule `find -name` can honour.
- **anything else** — a glob (`*.log`), a nested path (`pkg/a/`), a negation
  (`!.env.example`), a character class → **counted**, and one note line says so:
  `[note: 2 .gitignore rules (*.log, pkg/a/) are not applied on this engine; results may differ]`.

A missing, unreadable or unparseable `.gitignore` is not an error. **The note's
source is `ctx.env.readFile`, never a `shell`.** (Precondition 1, corrected per
M7c: `readFile` *is* on the contract, `execution.ts:46`.)

**Where the note is printed** (settled — M2): on the **fallback only**.
rg applied every rule it knows, so on rg the note would be noise, and the
header's `engine=grep` already tells a child it is on the weaker path. Q3(a)'s
old text said "on both engines"; the Design was always fallback-only, and the
Design wins — Q3(a) is reworded below. Either way the difference is **printed,
never silent**.

**Design 3c — what the pure module does before a command exists (H1, H2, H5,
M1, M3, H7).** Everything that could make the two engines disagree *silently* is
decided here, on strings, with no I/O — which is also why it is unit-testable
without a subprocess (§7 "logic lives in pure modules"):

| step | input | output / refusal |
|---|---|---|
| `validateInput` | raw input | NUL/`\n`/`\r` in `pattern`/`path`/`glob`; `glob` with `/`, `**`, a leading `!` or `..`; empty pattern in `content` mode (F12); `max_results` clamp (F11); `path` confinement per Q6 |
| `normalizePath` | `pattern`-independent | `./`-prefix on a relative path (measured: `find -dash.ts` fails on all three engines, `find ./-dash.ts` works); the `-path` guard operand built from it with `[]*?\` escaped (measured: unescaped `[id]` self-prunes the root to zero results) |
| `classifyPattern` | `pattern`, `fixed_strings`, `ignore_case` | `{ kind: "ere" \| "translated" \| "refused", text?, refusal? }` — the dialect table above; skipped entirely when `fixed_strings` is true (`-F` is literal on every engine, measured) |
| `buildSearchPlan` | the above + engine | the command string *and* the notes it owes (`translated` ⇒ a rewrite note; `engine=grep` ⇒ the ignore note) |
| `parseSearchOutput` | raw stdout, stderr, exitCode | `{ hits, registrationNote, engineStatus, parseError? }` — recognises `TENTACLE_RC=`/`TENTACLE_MISSING`, the three-grammar regex error (`bad regex`/`Unmatched`/`parentheses not balanced`/`warning:`/`regex parse error`), `binary file matches`, the debian `terminated by signal 13` SIGPIPE line, and a trailing partial line at the raw cap (M3) |
| `renderSearchResult` | hits + notes + bounds | the final string: header, sorted lines, the five bounds, the markers |

Two consequences worth naming, because the review asked for them explicitly:

- **A parse error is a first-class outcome (H2), not a `no matches`.** Measured:
  on the fallback `find -exec {} +` returns **1** for both "no match" and
  "grep died", and with `2>/dev/null` grep's message is gone — the old plan would
  have printed `no matches` for `foo(`, `arr[0`, `a{`. Revision 1 keeps stderr,
  matches the three grammars, and returns `isError: true` with the engine's own
  text plus "retry with `fixed_strings: true`" (or Q7's literal retry). **F14
  excludes parse errors** so they never trigger a second slow run.
- **The `head -c` subset is honest (M3).** `raw.length === CAP` ⇒ the
  `INCOMPLETE` marker, not "first N"; the trailing partial line is dropped;
  decoding is non-fatal (`TextDecoder{ fatal: false }` → U+FFFD) rather than a
  throw on a split UTF-8 byte.

**Design 4 — the granted tool-set and the prompt.**

`explore`'s list becomes `["fs_read", "search"]` (`subagent.ts:86`). Because
`search` must declare a read-class `concurrency` for `readOnlyType` to keep
saying yes (precondition 4), it gets `pathConcurrency("read")` — the existing
helper (`packages/tools/src/concurrency.ts:22-38`), which already returns
`"exclusive"` for a non-string `path`. **Correction (M7a):** that does *not*
make a `search .` conflict with an `fs_edit a.ts`. `pathResource` is the
case-folded **basename** (`packages/core/src/path-locks.ts:47-51`), so
`search path:"."` keys `path:.` and `fs_edit path:"a.ts"` keys `path:a.ts` —
different keys, no conflict, they may run in the same round. That is
**acceptable and now stated** instead of claimed away: a search reads whatever
the file was at walk time, exactly as a concurrent `fs_read` would, and
`fs_edit` replaces the file atomically on write (`host-execution.ts:14-20`, temp
+ rename), so a hit's text is never a torn byte sequence — at worst a line
number that shifted. Two searches still run side by side, which is the point of
the key.

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
| `packages/tools/src/search.ts` | **new.** The pure core (Design 3c): `validateInput`, `normalizePath`, `classifyPattern`, `buildSearchPlan(input, engine) → { command, notes }`, `parseSearchOutput(raw, stderr, exitCode, mode)`, `renderSearchResult(...)`. No I/O, no `Tool`. This is the module the "logic lives in pure modules" rule (§7) wants, and the one the two-path tests drive **directly** — no subprocess needed for the shape tests. It is expected to land around 300–350 lines (validation + confinement, the dialect table, the two command builders, the parser, the renderer), which is where `search-dialect.ts` below splits it. |
| `packages/tools/src/search-tool.ts` (or same file, second half) | the `Tool`: schema (with the `glob`/`path`/newline `.refine`s), description (incl. the dialect, H1), `permission: "none"`, `concurrency: pathConcurrency("read")`, `execute` = read gitignore → probe/cache engine → `ctx.env.exec` → parse → render, with F14's single retry + demotion. |
| `packages/tools/src/search-dialect.ts` | **new** (only if `search.ts` exceeds ~350 lines): the three-class ERE table from Context (b), pure and table-driven. |
| `packages/tools/src/index.ts:11` | export it. |
| `packages/tools/src/subagent-tools.ts` | **new** (drift, see Execution): `exploreTools` + `subagentExtraTools(typeName)` — owner Q1 (c) decided in ONE place, because `builtinTools` is registered wholesale into the PARENT's registry (`wiring.ts:407`), so a built-in `search` would be offered to the main agent and `general` too. |
| `packages/cli/src/wiring.ts:547` | `extraTools: (type) => subagentExtraTools(type.name)` on `createSubagentRunner`. |
| `packages/agent/src/subagent.ts:304` | `SubagentDeps.extraTools` — a child-only tool the parent's registry does not hold (and the parent's instance wins on a name clash). |
| `packages/tools/src/builtins.ts:320-328` | ~~`searchTool` into `builtinTools`~~ — **superseded by owner Q1 (c)**: a built-in is offered to every session, so `search` is NOT here (Execution, drift 1). |
| `packages/agent/src/subagent.ts:86` | `tools: ["fs_read", "search"]`. |
| `packages/agent/src/subagent.ts:67-71` | `EXPLORE_PROMPT` as in Design 4. |
| `packages/agent/src/subagent.ts:234-255` | `childToolLabel` `search` case. |
| `packages/core/src/tool-labels.ts:13` | `search: "Search"`. |
| `packages/tui/src/render-lines.ts:568` | `toolSubtitle` `search` case. |
| `packages/tools/test/search.test.ts` | **new.** The pure module, both paths, hostile pattern **and path** tables, dialect table, truncation markers (Tests: T-S1, T-S2, T-S6 pure, T-S8) + the recorded rg fixture `test/fixtures/search-rg.txt` (M6). |
| `packages/tools/test/search-tool.test.ts` | **new.** The `Tool` against a fake `ExecutionEnvironment` (probe/cache/demotion, commands, bounds, refusals) + one real-`sh` fallback run per path (Tests: T-S3, T-S5). |
| `packages/agent/test/subagent.test.ts` | extend: the `explore` child is offered `["fs_read","search"]`; `readOnlyType("explore")` still true; one child **end-to-end through the real agent loop** that searches then reads (Tests). |
| `packages/tui/test/render-lines.test.ts` | one row: `search` renders `Search x in y`. |

### Failure modes

Every one converges to a `ToolResult` the model can act on — never a throw
(`ToolRegistry.execute` catches anything, `registry.ts:73-100`), never a silent
drop.

| # | mode | how it converges |
|---|---|---|
| F1 | **No `rg` in the image** (a UBI/busybox pod) | the probe caches `grep`; the fallback runs; the header says `engine=grep`. Measured live on **busybox 1.38, busybox 1.36 (alpine) and GNU (debian)** — the whole `fin2.sh` run in Context (c) is that case. |
| F2 | **A `grep` without a needed option** (busybox/dash variants) | measured on busybox: `-E`, `-H`, `-n`, `-l`, `-c`, `-i`, `-F`, `-s`, `-r`, `-I` and `-exec {} +` are all present; `--include`, `--binary-files`, `--version` are **not** (`rc=2`, "unrecognized option"). So the command uses only the first group, and the two option-level risks get a probe, not a hope: **`-I` is accepted-and-ignored by busybox** (measured: a NUL file is searched and its line printed as `bin.dat:1:needle`), so `-I` is passed **only when the binary probe says it filters** (`TENTACLE_BINFILTER=1`; GNU 3.8 and BSD 2.6: 1, busybox: 0), and the parser also drops a `binary file matches` line / a NUL-bearing line (F6). The probe is **mandatory**, cached with the engine (Design 3a) — revision 0 called it a nicety, and was wrong. |
| F3 | **A path that does not exist** | a shell pre-check before the walk: `[ -f P ] \|\| [ -d P ] \|\| [ -L P ]` else `TENTACLE_MISSING` on stderr + exit **3** (measured on busybox, alpine, debian, BSD for a file, a dir, a symlink and a missing path). The tool returns `[search "p" in ./nope]` + `path not found: ./nope` + `isError: true`, so the child widens its path instead of reporting "no matches". This **replaces** revision 0's "read find's/rg's stderr and guess": the diagnosis never depends on an engine's wording, and the `2>/dev/null` that made it impossible is gone (only `grep -s` remains, per-file). |
| F4 | **A busybox `find` without `-mindepth`** | `-mindepth` is GNU/BSD, not POSIX — it is **not used**. The root-vs-`-name '.*'` trap is closed by `! -path ROOT` on each prune clause, with the operand's glob metacharacters escaped (M1): measured, a **hidden** metachar root (`.hid[x]`) self-prunes to **zero** results unescaped and returns its files escaped, on busybox, alpine, debian and BSD; a non-hidden `app/[id]` root is unaffected either way. |
| F5 | **A huge repo / a runaway walk** | the 256 KiB raw cap bounds memory; `ctx.signal` is threaded into `env.exec` (`execution.ts:19`, as `shell` does at `builtins.ts:302`) so a cancelled turn kills the walk through the process group (`host-execution.ts:246-256`); a `timeoutMs` (default 20 s, half of `shell`'s 120 s, since a search is not a build) bounds it on the wall clock. `find` keeps walking after `head` exits until each `grep` dies on SIGPIPE (measured on debian: `find: 'grep' terminated by signal 13`) — bounded by the timeout, and that stderr line is filtered by the parser rather than by discarding stderr. **Measured floor**: fallback on this repo 5.0 s vs rg 0.8 s — the fallback is slow, which is why the timeout exists and why `engine=grep` is in the header. A cancel surfaces as `ExecResult.exitCode === 124` with the same note `shell` uses (`builtins.ts:312-315`), reworded for a search. |
| F6 | **Binary files** | rg drops them silently (measured: nothing for a match in a file holding `\0`). GNU/BSD `grep -I` drops them (rc 1); **busybox `grep -I` does not** (measured: `1:needle` printed). So: pass `-I` only when the probe says it works, and **always** filter in JS — drop a line whose text carries a NUL, and count a `binary file matches` line into one note (`binary files matched (N) — not shown`). Identical rendering on all three engines; measured `bin.dat` present in busybox output, absent on GNU, both reduced to absent by the parser. |
| F7 | **Symlink loops** | `find` without `-L` does not follow symlinks — a loop is never entered (measured on `src/loop -> ..`). rg does not follow them either. No `-L` is ever passed. **`-H` IS passed** (new, measured): POSIX `-H` follows only the *argument*, so a symlinked `path` behaves as it does for rg (55 files through `/w/etc-link`, 0 without `-H`) and a loop inside the tree is still never entered. |
| F8 | **A pattern containing a newline** | `rg` **refuses** a literal newline in a regex (*"the literal `\n` is not allowed in a regex"*, rc 2) while `grep -E` accepts it and matches a *line* — a genuine divergence (measured). Not fixable by quoting. So: the schema rejects a `pattern` containing `\n`/`\r` (and a NUL) with a validation message telling the model to search for a single line and use `fs_read` for context. That is the honest shape — the tool never sends a pattern the two engines disagree about. |
| F9 | **A pod's untrusted output (§7)** | the pod owns its daemon, so a match's *text* is pod-supplied bytes. The result is not treated as trusted: the tool strips C0/DEL control characters per line **except `\t`** (M7b — otherwise every indented hit is mangled; the same class `wireLine`/`oneLineText` drop, `mapping.ts:64-66`, `hosted-session.ts:345-368`), caps each line, and prefixes every result with the `[search …]` header so the text is never bare. It is **not** marked as an instruction anywhere, and it carries no path that another tool then trusts. A pod cannot use this to escalate: the tool's effect is a read-only walk inside the pod, with no shell and no writable file. |
| F10 | **Cancel mid-walk** | `ctx.signal` → `exec`'s abort → SIGTERM to the whole process group, SIGKILL after the grace (`host-execution.ts:340-348`); the tool returns `search cancelled` (`isError: true`) rather than a partial list the child would misread as complete. The *probe* deliberately does not take `ctx.signal` (M4), so a cancel cannot poison the cached engine. |
| F11 | **`max_results` absurdly large, or 0** | the zod schema is `int().min(1)` and the value is clamped to `MAX_RESULTS_CEILING` in the pure module — a 10⁹ asks for the ceiling, never for an unbounded buffer. |
| F12 | **An empty `pattern`, or neither `pattern` nor `glob`** | `pattern` is `z.string().min(1)` **conditionally**: in `content` mode it is required; in `files` mode exactly one of `pattern` / `glob` must be present (H6's new surface), enforced by a `.refine` with a message naming both fields — a `files` call with neither would otherwise list the whole tree unbounded. A pattern of only spaces is legal and searches for spaces (harmless, bounded). |
| F13 | **`.gitignore` unreadable, absent, or a symlink out of the workspace** | `readFile` failure is caught and ignored (no note, no error); it is a convenience for a note, never a precondition. |
| F14 | **The probe succeeds but rg then fails** (a wrapper on `PATH`, a broken binary) | the exec's stderr and non-zero exit reach the tool; if rg fails with rc ≥ 2 *and* stderr names the engine (`rg:`) **and it is not a regex parse error** (H2 — a parse error is a user error, reported, never retried), the tool **demotes the cached engine to `grep` for that env (M4)**, re-runs **once** on the fallback, and reports `engine=grep` with the rg error as a note. One retry per call, one demotion per env, never a loop (§0). Tested in T-S3(b). |
| F15 | **A result so large it reaches the spill path** | designed out: the byte bound (12000) sits below the spill threshold (16000), so `search` never spills — which also keeps the TODO `explore`-spills-a-file item unreachable *for this tool* (Design 5). If a user lowers `tools.maxInlineOutputChars` below 12000, the spill machinery handles it exactly as for `shell` — no new code. |

### Tests

The repo rule (§9): **red before green**, prove the exact property, test the
failure modes, use injectable seams.

**How the real-engine half runs in CI, and where it runs without `rg` (M6).**
CI runs no tests today (`.github/workflows/build.yml` only compiles and
smoke-tests binaries; there is no `bun test` job), so the plan must not depend on
an unstated install. Decision: **the suite never needs `rg`, and never skips.**
The default run executes the **fallback for real** and compares it against a
**recorded** rg transcript; the "is the recording still what real rg produces"
check is a **documented validation step**, not a suite member. Two repo facts
drive this over a new opt-in env var:

- a new `TENTACLE_SEARCH_RG` would be **stripped** by the test guard —
  `scripts/test-env-guard.ts` deletes every `TENTACLE_*` except its explicit
  keep-list (k8s, docker, `SLOW_TESTS`), so the opt-in would additionally need a
  guard change plus a `test-env-guard.test.ts` case;
- AGENTS §6 pins the baseline as "all pass except the **three** opt-in skips", so
  a fourth skip is a rule change, not a detail — and this feature does not need
  one.

- **In the default suite** (`bun test`, everywhere): T-S1 runs the **fallback**
  command for real (POSIX `find`/`grep` — measured present on busybox, alpine,
  debian and macOS, so it needs no install) and compares it against the
  **recorded** rg transcript (`packages/tools/test/fixtures/search-rg.txt`,
  produced once on this machine and pasted verbatim, with the rg version in the
  first line). The pure-module tests need no engine at all.
- **The recording is re-verified, not trusted**: the **Execution** section records
  the exact command that regenerates the fixture (the built rg command, run on
  this machine, rg 15.2.0) and its output, and **Review** re-runs it and diffs.
  The generator itself stays in `.tentacle/tmp/explore-search/` (the fixture is
  the artefact; a script for it would be a fourth thing to maintain). If CI ever
  installs rg, that step is promoted to a real test with no plan change.
- **Review gate before merge** (one live run, output pasted in Review): the
  fallback on **busybox** *and* on a **GNU** image, i.e. the commands in
  `fin2.sh` re-run in `podman run --rm busybox:latest` and
  `podman run --rm debian:bookworm-slim`. This revision already contains those
  runs (Context (a)–(g)); the gate is that they are re-run against the *final*
  `buildSearchPlan` output, not a script that mirrors it. Per AGENTS §6 a live
  container run is an opt-in test, so it stays a **documented Review step**, not
  a suite member — and this is the one verification the executor must not fake.

**T-S1 — the pure module, both paths, one table** (`packages/tools/test/search.test.ts`).
*Property*: for the same fixture and the same input, `renderSearchResult(parseSearchOutput(cmd_result))` is **byte-identical** whether the command came from `buildSearchPlan(…, "rg")` or from `buildSearchPlan(…, "grep")` — for every row of the table, *except* the rows the design deliberately makes differ (a refusal, which is engine-specific by design and asserted separately).
Driven as: build both plans, run the fallback command for real through
`Bun.spawnSync(["/bin/sh","-c", …])` with a scrubbed `PATH` (no rg), and the rg
command against the recording (re-verified per the block above, never skipped), then
compare the rendered strings. That is exactly `repro-doc.ts` B, promoted.
Table: a plain hit; a regex hit; a no-match; the hostile **pattern** set (`it's`,
`say "hi"`, `$(echo PWNED)`, `` `id` ``, `a;b|$(id)`, `-n`, `--version`); the
hostile **path** set (M1: a leading `-`, a space, quotes, `$(…)`, `[id]`, a
nested `.hid[x]`, a `\`); a truncation-by-count case; a truncation-by-bytes case;
a 5000-char line; a binary file; a **symlink root** (`-H`); a `files`-mode glob;
a files-with-matches query; the dialect table of Context (b) — `\d+`, `\w+`,
`\s`, `\bfoo\b`, `(?i)abc`, `(?:ab)`, `\p{L}`, `a{2}`, `a**` — each as
translate/refuse/pass, asserted on both paths; a **parse error** (`foo(`,
`arr[0`) asserting `isError` + the retry advice; a **missing path** asserting
status 3 and `path not found`.
*Guards the vacuity risk*: the test asserts the fallback run **actually could
not** use rg (`command -v rg` under the scrubbed `PATH`) — otherwise a machine
with rg would make both sides the rg path and prove nothing.

**T-S2 — quoting and path safety, as a property of the built command, not of a
shell** (`search.test.ts`). *Property*: for each hostile **pattern** and each
hostile **path** (M1), the built command, executed, produces a hit for a file
containing that pattern **literally** / for that directory's files, and creates
no file named `pwned`. The path half is new and has its own red cases: `path:
"-dash.ts"` (measured: `find -dash.ts` → "unrecognized"/"unknown predicate"/
"illegal option" on the three engines, `find ./-dash.ts` works), `path:
"app/[id]"` and `path: ".hid[x]"` (measured: a **hidden** metachar root → zero
results with an unescaped `-path` guard, correct with it), `path: "a b"`,
`path: "it's"`, `path: "$(touch pwned)"`, `path: "back\\slash"`. Mutation check
(§9): replace `shq` with identity and the `$(touch pwned)` / `a;b|$(id)` cases
must go red (measured: without quoting the shell splits the command); drop the
`./`-prefix and the `-dash.ts` row must go red; drop the `-path` escaping and
the `[id]` row must go red.

**T-S3 — the `Tool` against a fake env** (`search-tool.test.ts`).
*Property*: with a scripted `ExecutionEnvironment` (the `recordingEnv` pattern,
`packages/agent/test/subagent.test.ts:47-62`), the tool sends **exactly one**
probe then **exactly one** search, caches the engine across two `execute` calls
(probe count stays 1), passes `ctx.signal` to the **search** and **not** to the
probe (M4), and never puts `input.pattern` or `input.path` outside a quoted
position. Four failure-mode cases the review demanded:
(a) a probe that **rejects/times out** ⇒ the fallback is used **and nothing is
cached** (a second `execute` probes again) — the anti-poison property;
(b) rg present but the search fails engine-shaped ⇒ **one** retry on the
fallback, the cache is demoted, and the *next* call issues **no** probe and **no**
rg run (F14/M4);
(c) a parse error (`foo(`) ⇒ **no** retry, `isError: true`, retry advice (H2);
(d) `TENTACLE_RC=`/`TENTACLE_MISSING` in stderr are honoured even though the
outer `exec` exit code is 0 (H3) — asserted by returning `exitCode: 0` with a
stderr line, which is exactly what the shell produces.
Red-before-green: written against a stub that returns `""`, red on the
engine/command assertions, then wired.

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

**T-S5 — the schema refuses what it says it refuses** (`search-tool.test.ts`).
*Property*, one case each, red before the `.refine`s: `pattern: "a\nb"` (F8);
`pattern` empty in `content` mode (F12); `glob: "src/**/a*.ts"` and `glob:
"!*.ts"` and `glob: "a/b.ts"` with a message pointing at `path` (H5 — measured:
`rg --files -g 'src/**/a*.ts'` → rc 1, nothing; `find -name 'src/**/a*.ts'` →
nothing); `files` mode with **neither** `pattern` nor `glob` (F12); and, per
Q6's answer, `path: "/abs"` / `path: "../x"` refusing or passing.

**T-S6 — bounds** (`search-tool.test.ts`, pure). *Property*: 500 hits with
`max_results: 3` yields exactly 3 lines **and** the count marker **and** the
per-file `[more matches in: …]` digest (H6); a single 40000-char line yields one
line of ≤300 chars **and** a `…`; a result at the byte bound yields only whole
lines and the byte marker — never a split line; a raw stream of exactly `CAP`
bytes yields the **`INCOMPLETE`** marker and drops the trailing partial line
(M3), while a shorter over-`max_results` stream yields `first N` — two different
markers, asserted apart. Mutation: move the byte bound before the count bound and
the whole-lines assertion goes red on the multi-byte fixture.

**T-S7 — display** (`render-lines.test.ts`): the `search` row reads
`Search <pattern> in <path>`; `childToolLabel("search", …)` the same. One case
each — display only, so this is the shallow test, deliberately.

**T-S8 — the dialect classifier is a table** (`search.test.ts`, pure, no shell).
*Property*: for each row of Context (b), `classifyPattern` returns the expected
`kind` and, for `translated`, a text that the **opposite** engine actually
matches on the fixture: `\d+` → `[0-9]+` (measured: BSD `\d+` matched all 10
lines, GNU/busybox none, `[0-9]+` the digits line on all three); `\w+`/`\s` pass
through (measured ALL on all three); `\bfoo\b` passes (measured: `foo` on all
three). The refused rows are refused for three *different* measured reasons, and
each is asserted as such: `(?i)abc` — busybox rc 2, **GNU rc 1 with only a
stderr warning** (the silent case); `(?:ab)` — busybox rc 2, GNU rc 0 but
matching only the *literal* line L6 (a silent **meaning** change); `\p{L}` —
busybox rc 2, GNU/BSD rc 1 (silently nothing); `a{2}` — rc 1 on all three
(silently nothing, so it is a divergence from rg only); `\x41` — BSD matched L1
as a hex escape while GNU and busybox matched L7 as the literal text `\x41`
(three engines, two meanings, both silent); lazy `a.*?b` — with `-o` on
`axxbxxxb`, BSD and rg give `axxb`, busybox and GNU give `axxbxxxb` for both
`a.*?b` **and** `a.*b` (measured; the line sets agree, the meaning does not).
Mutation: delete the `\d` row from the translate map and the `\d+` case goes red
on the fallback run.

**Not tested here, and said out loud**: the docker/pod transport (`env.exec` is
the same contract everywhere, precondition 1, and a pod's `rg` presence is only
knowable in the pod — F1 is the answer and the `engine=` header is its
observable). Verification for that is one live `tentacle run` search in an image
without rg; it is named in Review, not claimed here. Revision 1 *did* run the
fallback inside three images by hand (Context (a)–(g)) — that is evidence, not a
test, and Review re-runs it against the built command.

## Owner questions

Each with 2-3 options; **my recommendation first**, and what the measurement says.
Revision 1 rewrote Q1 (M5), amended Q3 (M2's contradiction), and **added Q6
(path confinement, H7), Q7 (a pattern the fallback cannot express, H1/H2) and
Q8 (the `glob` filter + files-with-matches surface, H6)** — the three the design
review said were missing and needed the owner.

**Q1 — Who gets `search`: `explore` only, or `general` and the main agent too?**
*(rewritten per M5: the permission angle was missing, and it changes the
recommendation.)*
- **(a) Everyone — `explore`, `general` and the main agent — RECOMMENDED,
  conditional on Q6 being settled.** The old argument ("they already have
  `shell`, so `grep -rn` is one call away") ignores what that call *costs*:
  `shell` is `permission: "ask"` (`builtins.ts:286`), so every grep the main
  agent runs is a **prompt** (or a standing allow-rule, which is worse: a
  free-form shell allowlist is a much bigger surface than one read-only tool),
  and its output is **unbounded** — the model must remember `| head`, and the
  result goes straight into context. `search` is `permission: "none"` and
  bounded by construction. That is a UX and safety gain, not "a second way to do
  the same thing", and ~600 chars of definition is a weak counter-argument
  against it: one prompt per grep costs the user more than that, every time.
  Note the pairing: a prompt-free search for the **main** agent makes Q6 sharper,
  not weaker — hence "conditional on Q6".
- **(b) `explore` + `general`, not the main agent.** Middle ground: gives the
  read-only child its primitive and a writer a cheap locate, keeps the main
  agent's prompt-free surface at zero. Costs the same per request for `general`
  and leaves the most-used agent with the prompt-per-grep papercut.
- **(c) `explore` only.** Still defensible on one ground: it is the type with
  the measured disease (183 steps / 18M tokens), it is prompt-free today, and
  the blast stays one array in `subagent.ts`. It leaves the main agent
  unchanged — including the prompt-on-every-grep behaviour, which is the status
  quo the owner has lived with.
- *What the measurement adds:* nothing here is timed; the cost is (i) definition
  bytes per request (~600 per extra always-on tool) and (ii) one permission
  prompt per `shell` grep avoided. The second dominates for any interactive use.

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
  literal names on the fallback + `--no-require-git` — RECOMMENDED, and what the
  measurements support.** Shape, bounds and ordering are identical *by
  construction* (one JS renderer over both engines' `path:line:text` lines); the
  result sets agree on everything a POSIX `find` can express; rg stays at
  45-50 ms. The residual divergence — a `.gitignore` glob, a nested path, a
  nested `.gitignore` — is **printed**, never silent, **on the fallback only**
  (M2: revision 0's text here said "on both engines" while the Design said
  fallback-only; the Design wins, and the note now says "results may **differ**").
  `--no-require-git` is part of (a) (measured: without it, rg < 15 ignores
  nothing where there is no `.git`, making the *fallback* the stricter path).
- **(b) `--no-ignore` on both, ignoring nothing.** Literal, total parity of the
  result set — but measured at **409-453 ms vs 61-64 ms on this repo** for rg,
  and adding the same `-g` prunes back does not recover it (the *walk* is the
  cost). ~7× on the fast path, paid on every search of every session, to close a
  gap that only appears when `rg` is missing. Take this only if the owner values
  "the two paths can never differ" above search latency.
- **(c) Ship rg only; fail with a clear error when it is absent.** Cheapest and
  fastest, but it breaks the owner's binding constraint ("NEVER assume `rg`
  exists … must fall back") — listed only to be rejected explicitly.

**Q4 — the engine probe: cached per `env` (this plan), or per call?**
- **(a) Cached per `env` in a `WeakMap` — RECOMMENDED**, with revision 1's
  qualifications (M4): only a **definitive** answer is cached, the probe carries
  no `ctx.signal`, `rg --version` replaces `command -v rg`, and F14 demotes the
  cached engine. Measured probe cost: 30-38 ms, paid once per env.
- **(b) Per call.** Simpler to reason about, +30-38 ms on every search — on a
  183-step child that is ~6 s of pure probing, which is the disease this task
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

**Q6 — may a `permission: "none"` search name a `path` outside the workspace?
(H7 — this is the one the plan never asked.)**

The issue in one sentence: `fs_read` is unconfined and prompt-free too, but it
reads a path the caller already **knows**; a recursive search **discovers** — so
`search {path: "/Users/x", pattern: "BEGIN OPENSSH|AKIA"}` runs with **no
prompt** and *finds* keys a model could not have named, and naming `~/.ssh` in
`path` today would *lift* the hidden-entry prune (the "named in `path` is
exempt" rule). Nothing on the `ExecutionEnvironment` contract exposes the
workspace root (precondition 7), so this is a rule the pure module applies to
the string, with `cwd` as the reference.
- **(a) Refuse, lexically, in the pure module — RECOMMENDED.** Reject an
  absolute `path`, and any `path` whose normalised form climbs out of `cwd` with
  `..` — **except** when Q6(b)'s escape hatch applies. The message names the
  rule and suggests a workspace-relative path. Two measured facts make this safe
  to specify: neither engine follows a symlink *inside* the walk (no `-L`;
  measured: `find` on a `loop -> ..` never enters it, rg likewise), and the
  only symlink that is followed is the **argument** itself (`-H`, added for
  parity with rg) — so a symlink *out* of the workspace is the one remaining
  hole, closed by `realpath`-ing the argument when the env can (`pwd -P`), or by
  refusing a `path` that is a symlink (`[ -L ]`, already probed in F3's
  pre-check).
- **(b) Refuse absolute, but keep `..` (and an explicit opt-out) for the
  multi-root case — the alternative.** A pod/docker workspace is one root, but a
  laptop session legitimately searches a sibling checkout (`../other-repo`), and
  `attach`/`run` put the root somewhere the pure module cannot see. This option
  keeps `..` but requires the *resolved* path to stay under `cwd` — the same
  rule as (a) in practice, minus the absolute-path part, which is where the
  `~/.ssh` case lives. Weak, unless the owner wants `../` to keep working.
- **(c) Allow anything, and make confinement the *caller's* job (raise the tool
  to `permission: "ask"` when `path` is absolute or escapes)** — the honest
  fallback if the owner wants no new restriction: the tool stays
  `permission: "none"` for relative paths and asks for anything else. Costs a
  prompt the model may hit once per session, and couples the tool's permission
  to its *input*, which the current `Tool` shape does not support
  (`permission` is a constant, `tool.ts:154-181`) — it would need a new seam.
- **My recommendation: (a)**, with the symlink argument resolved where the env
  can and refused where it cannot. If Q1 lands on "everyone", (a) becomes
  mandatory rather than merely recommended.

**Q7 — what does a pattern the fallback cannot express do? (H1/H2 — translate,
refuse, or retry literally?)**

Measured divergence, one table (Context (b)): `\d+` matches *every line with a
`d`* on BSD grep, **nothing** on GNU and busybox, digits on rg; `(?i)abc` works
on BSD and rg, is a **warning + no match** on GNU (rc 1, easy to miss) and a hard
error on busybox; `\p{L}` works only on rg. So "same tool on both paths" cannot
be true for a regex, and a choice has to be made.
- **(a) Translate the safe shorthands, refuse the rest with an actionable
  message — RECOMMENDED.** `\d`/`\w`/`\s`/`\D`/`\W`/`\S` and `[:word:]` become
  POSIX classes (measured identical to rg for `\w`, `\s`; **`\d` is the fix**,
  not a nicety); `(?…`, `\p{…}`, `(?:`, lazy quantifiers, `\x`/`\u`, `{n,m}`
  are refused with the engine named and two ways forward (`fixed_strings: true`,
  or a POSIX class). The refusal is identical on both engines on purpose — a
  tool that behaves differently by image is the bug being fixed. Cost: a pattern
  rg could have matched is refused when rg *is* present; mitigated by the
  message offering `fixed_strings`.
- **(b) Translate, and on refusal retry **once** as a literal string with a
  note — the "never fails" option.** No refusal ever reaches the model;
  `(?i)abc` becomes a literal search for `(?i)abc` (usually 0 hits) plus
  `[note: searched literally; this engine cannot express (?i)]`. Cheaper for the
  model, but it can return a **plausible wrong answer** ("no matches") for a
  pattern that meant something — exactly the failure H2 is about. Only if the
  owner prefers never-erroring to never-lying.
- **(c) Engine-as-is, and put the dialect in the tool description + the
  header.** Smallest diff, no translation table to maintain; leaves the silent
  `\d+` → nothing case in place on GNU/busybox (measured), which is the
  divergence the review opened with. Rejected unless the owner accepts
  "different tool depending on the image" as documented behaviour.
- **My recommendation: (a).** Note it composes with Q1: the more agents get the
  tool, the less acceptable a silently-different result becomes.

**Q8 — the `glob` filter and the files-with-matches surface: add both? (H6)**

The task exists to cut **steps**, so the question is whether two missing
arguments cost more steps than one more field costs definition bytes. Measured:
`rg --files -g '*.ts'` and `find -name '*.ts'` agree exactly; `rg --files -g
'src/**/a*.ts'` matches **nothing** (so the field must be a basename glob, H5);
`grep -l` and `rg -l` are POSIX-clean and agree on the fixture.
- **(a) Add `glob` (basename) valid in **both** modes, and make `files` +
  `pattern` mean files-with-matches — RECOMMENDED.** Covers the two commonest
  queries that currently force extra steps: "`needle` in `*.ts` only" (without
  it, docs/fixtures/lockfiles fill the 100 lines and the child re-searches) and
  "which files contain X" (without it, a symbol with 400 hits shows only the
  alphabetically-first directories and the child re-searches or falls back to
  slices). Cost: one field, one more `shq` argument, one more refine, and a
  third header shape. Context lines (`-C`) stay out — `fs_read path:start:end`
  covers them.
- **(b) Add `glob` only; keep `files` as glob-listing only.** Cheaper to
  describe and test; leaves "which files contain X" answered by a truncated
  content list plus (with revision 1) the per-file digest — which is *close*,
  but a digest of 5 files is not a list of 40.
- **(c) Neither; keep the revision-0 surface.** Smallest blast, and the
  per-file digest added for M3 partially compensates. It keeps the two
  most-common searches as two-step operations, which is the disease.
- **My recommendation: (a).** The measured step cost of *not* having it is the
  whole reason for the task; the extra definition is ~120 characters.


#### Owner answers (2026-11-12)

Q1 **(c) `explore` only** (owner chose against the recommendation: the main agent and `general` keep `shell`) · Q2 (a) MCP read-only + `mcp__<server>__*` are separate tasks · Q3 (a) · Q4 (a) · Q5 (a) 100 results / 12000 bytes · Q6 **(a)** refuse absolute paths and lexically escaping `..`, symlinks resolved-or-refused · Q7 **(a)** translate `\d \w \s`, refuse the rest with an actionable message (decided by the orchestrator on the owner's delegation: "fai tu la scelta migliore in termini di compatibilità multipiattaforma" — the only option that is never silently wrong on any engine) · Q8 (a) `glob` in both modes + files-with-matches. Plan approved for execution.

## Execution

*— claude (tentacle --profile claude), 2026-11-12*

### Repro first (the capability really was missing)

`.tentacle/tmp/explore-search/repro-doc.ts` on this branch before any edit:

```
A1 explore child is offered: ["fs_read"]
A2 built-in tool names: ["fs_read","fs_write","fs_edit","fs_multi_edit","shell","shell_output","shell_kill"]
A3 any search/glob tool: false
```

### As-built, in the plan's order

1. **`packages/tools/src/search-dialect.ts`** (new, 176 lines) — the three-class
   ERE table: `\d \D \w \W \s \S` and `[:word:]` → POSIX classes;
   `(?…` / `\p{…}` / `\x..` / `\u…` / lazy quantifiers / `{n,m}` / a shorthand
   inside `[…]` refused, each with a measured reason and the two ways forward;
   everything else passes (including `\b`/`\B`, measured working on all three
   greps). `fixed_strings` skips the table. `hasGroupSyntax`/`bracketSpans` are
   escape-aware, so `\(?` and `[[:word:]]` are not misread.
2. **`packages/tools/src/search.ts`** (new, ~780 lines) — the pure core:
   `validateSearchInput` (control chars, the two mode requirements, the
   basename-glob rule, Q6 a confinement: absolute refused, `..` refused),
   `classifyGitignore`, `buildSearchPlan(input, engine, facts)`,
   `parseSearchOutput(raw, stderr, mode, filesWithMatches)`,
   `renderSearchResult(parsed, options)`, and `shq`. The command shape is the
   plan's: existence pre-check → walk → `TENTACLE_RC` on stderr →
   `| head -c 262145`; rg keeps `.gitignore` and gets `--no-require-git
   --sort path --max-columns 1200 --max-columns-preview`; `find -H` gets one
   `-prune` clause per name with the root exempted through an **escaped** `-path`
   operand, a hidden-entry prune, `./`-prefixed paths, `-F`/`-E` (never both),
   and `-I` only when the probe says it filters.
3. **`packages/tools/src/search-tool.ts`** (new, 290 lines) — the `Tool`: the
   one-process probe (`rg --version` + `grep -E -H` caps + the NUL
   binary-filter test) cached in a `WeakMap<ExecutionEnvironment, Probed>`;
   **only a definitive answer is cached**; the probe carries no `ctx.signal` and
   its own 5 s timeout; `F14` demotes the cache to `grep` before the single
   retry, and a parse error is never retried. `permission: "none"`,
   `concurrency: pathConcurrency("read")`.
4. **The `explore` grant and the prompt** (`packages/agent/src/subagent.ts`):
   `tools: ["fs_read", "search"]`, the new `EXPLORE_PROMPT` ("SEARCH first, then
   read" …), a `childToolLabel` `search` case, `SubagentDeps.extraTools`.
5. **Display**: `search: "Search"` (`tool-labels.ts`), the TUI `toolSubtitle`
   case (`render-lines.ts`).
6. **Tests** (all new unless named): `packages/tools/test/search-fixture.ts`
   (the shared fixture + `scrubbedPath`), `search.test.ts` (T-S1, T-S2 both
   tables, T-S8, T-S6-pure, the parser table, `classifyGitignore`, the plan's
   shape), `search-tool.test.ts` (T-S3 a/b/c/d, T-S5),
   `packages/agent/test/explore-search.test.ts` (T-S4 through the real loop),
   `packages/tools/test/fixtures/search-rg.txt` (the recorded rg transcript),
   plus one `search` row each in `core/test/tool-labels.test.ts`,
   `tui/test/render-lines.test.ts`, `agent/test/subagent.test.ts`.

### Drift from the Implementation — three items, all forced by the code

**1. `search` is NOT in `builtinTools` (Files row superseded).** The plan puts it
there and adds `"search"` to `explore`'s list. That contradicts binding owner
answer **Q1 (c) — `explore` only**: `builtinTools` is registered wholesale into
the **parent's** registry (`wiring.ts:407`), and a child's tools are filtered
*from* that registry (`subagent.ts:339`). A built-in `search` is therefore
offered to the main agent and to every `general` child — exactly the option Q1
rejected. Shipped instead: a new `packages/tools/src/subagent-tools.ts` with
`exploreTools` and `subagentExtraTools(typeName)` (the ONE place Q1 is decided),
a new `SubagentDeps.extraTools` seam so a child can be offered a tool its parent
does not hold, and `wiring.ts:547` wiring it. The parent already holding a name
wins, so a child never gets two instances of one tool.

**2. A hidden-entry prune was added to the fallback (not in the plan).** The
plan's fallback command has no hidden rule, but rg skips hidden entries by
default, so `.hidx/f.ts` and `.hidden.txt` appeared only on the grep path — a
real shape divergence, caught by the T-S1 table. `find` now carries
`\( -name '.*' ! -path ROOT \) -prune -o` with the **escaped** root, which is
what makes the plan's M1 escaping load-bearing rather than dead code (mutation 4
below).

**3. `-F` replaces `-E` instead of joining it.** Measured: `grep -E -F` is
`rc 2` on GNU, so the plan's `[-I] [-F] -E` shape would have made every
`fixed_strings` search a parse error on GNU/busybox. The fallback passes exactly
one of `-F`/`-E`.

Smaller, recorded rather than argued: `validateSearchInput` takes no `cwd` (Q6 a
refuses *every* absolute path, which is strictly what the owner answered — no
lexical workspace-root comparison was needed); the schema's `.superRefine`
delegates to the same `validateSearchInput` instead of restating the rules in
Zod; `parseSearchOutput` takes `outputMode`+`filesWithMatches` rather than the
whole plan (the plan's `parseSearchOutput(raw, stderr, exitCode, mode)` shape,
minus the unused exit code — the carried status is read from `TENTACLE_RC=`,
which is H3's whole point).

### Tests, per slice, with the names

- **T-S1** `T-S1: the fallback and the recorded rg run render the same SHAPE` —
  14 rows, each `"<name>" renders identically on both engines`, plus
  `vacuity guard: the scrubbed PATH really has no rg`. The real fallback runs
  through `/bin/sh` with a `PATH` of symlinks to `sh find grep head printf cat
  sort env ls` only; the rg side is the recorded transcript
  (`packages/tools/test/fixtures/search-rg.txt`, rg 15.2.0, generated from the
  final `buildSearchPlan(rg)` — see *Regenerating the recording* below).
- **T-S2** `T-S2: hostile PATTERNS never reach the shell` — 8 patterns
  (`it's`, `say "hi"`, `$(echo PWNED)`, `` `id` ``, `a;b|$(id)`, `-n`,
  `--version`, `back\slash`) each matching its own literal line, plus
  `no hostile pattern creates a file, and nothing is expanded`.
  `T-S2: hostile PATHS are confined, prefixed and escaped` — `-dash.ts`,
  `.hid[x]` (the escaped `-path`), `a b`, `it's`, `/etc` + `../x` +
  `a/../../y` refused, `~/.ssh` kept literal, a missing path = status 3,
  `node_modules` exempt.
- **T-S8** `T-S8: the dialect classifier is a table` — 19 rows, one per measured
  construct, plus `fixed_strings skips the table`, `an escaped paren is not
  group syntax`, `a translated pattern really matches what rg matches (the \d
  fix)`, `a refused pattern is a refusal with the engine named`.
- **T-S6 (pure)** `T-S6 (pure): the bounds` — count + per-file digest, the
  40000-char line → `MAX_LINE` + `…`, whole lines at the byte bound, the
  `INCOMPLETE` marker vs `first N` asserted apart, `no matches`, a binary note, a
  NUL line dropped, a tab kept.
- **the parser** `the parser reads the engines' own words` — 8 stderr shapes
  (incl. GNU's `brackets ([ ]) not balanced` and busybox's
  `bad regex 'foo(': Unmatched`, both measured) + the SIGPIPE line as noise.
- **T-S3** `T-S3: the probe is once per env, and its answer is cached` (probe
  count 1 across two calls; the probe has **no** `ctx.signal` and a 5 s timeout
  while the search carries both `signal` and 20 s; nothing unquoted),
  `T-S3(a): a non-definitive probe caches NOTHING` (a timeout, a throw and
  unparseable output each re-probe), `T-S3(b): a broken rg is demoted, retried
  ONCE` (one rg run + one fallback run, the note, and the next call issues no
  probe and no rg) and `a PARSE error is never retried`, `T-S3(d)` (status 3 in
  stderr with outer rc 0; a 124 = timeout, not a partial list), and the
  `grep`-engine rows (`-I` passed only when `BINFILTER=1`).
- **T-S5** `T-S5: the schema refuses what it says it refuses` — newline/CR/NUL,
  empty pattern, `files` with neither, `/`+`**`+`!`+`..` globs (and two legal
  basename globs accepted), `/etc` + `../x` at the tool boundary, and
  `max_results: 10^9` clamped rather than refused.
- **T-S4** `T-S4: an `explore` child is offered search, runs it, and reads a
  hit` (6 cases) — the type's list, the child's first request offering exactly
  `["fs_read","search"]`, a real search-then-read with the hit
  `./src/a.ts:3:needleTwo();`, a `general` child NOT offered it,
  `shell` still absent, and Q1 asserted on both sides of `subagentExtraTools`.
- **T-S7 (display)** one row each: `core/test/tool-labels.test.ts`
  (`search` → `Search`), `tui/test/render-lines.test.ts`
  (`{label:"Search", subtitle:"needle in src"}`, and the glob form),
  `agent/test/subagent.test.ts` (`childToolLabel` → `Search needle in src`).

### The Review gate — the FINAL `buildSearchPlan` output, inside the images

`.tentacle/tmp/explore-search/gate.ts` prints, for each query, the command
`buildSearchPlan` really produced (`ENGINES=grep,rg bun gate.ts > gate.sh`), and
`gate.sh` is fed to the container's `sh` on stdin with the fixture mounted
read-only. Images: `busybox:latest` (busybox 1.38.0), `debian:bookworm-slim`
(GNU grep 3.8), `alpine:3.20` + `apk add ripgrep` (rg 14.1.0). Commands:

```
podman machine start                      # the VM was down; started it
podman pull -q busybox:latest; podman pull -q debian:bookworm-slim
podman run --rm -i -v "$PWD/fxgate:/w:ro" -w /w busybox:latest sh < gate.sh
podman run --rm -i -v "$PWD/fxgate:/w:ro" -w /w debian:bookworm-slim sh < gate.sh
ENGINES=rg bun gate.ts > gate-rg.sh
podman run --rm -i -v "$PWD/fxgate:/w:ro" -w /w alpine:3.20 \
  sh -c 'apk add -q ripgrep 2>/dev/null; exec sh' < gate-rg.sh
```

`diff out-busybox.txt out-debian.txt` — the two fallbacks agree on **every
result line**; the only differences are the two engines' own stderr wording
(`sh: line 6: rg: not found` vs `sh: 6: …`, and busybox's
`bad regex 'foo(': Unmatched` vs GNU's `Unmatched ( or \(`), both of which the
parser reduces to the same `pattern rejected` + `fixed_strings` advice. Extracts
(busybox, then debian where it differs):

```
=== plain-hit [grep]
TENTACLE_RC=0
./-dash.ts:1:needle dash
./its.txt:1:needle
./app/[id].ts:1:needle
./app/[id]/k.ts:1:needle
./app/x/k.ts:1:needle
./deep/z.ts:1:needle
./it's/q.txt:1:needle
./a b/sp ace.ts:1:needle
./pkg/a/x.ts:1:needle
./src/a.ts:1:export const needleOne = 1;
./src/a.ts:3:needleTwo();
./src/debug.log:1:needle log
--- outer rc=0
=== translated-d [grep]
TENTACLE_RC=0
./src/a.ts:1:export const needleOne = 1;
./src/a.ts:2:const x = 2;
=== no-match [grep]
TENTACLE_RC=1
=== hostile-pattern [grep]          # `it's`
TENTACLE_RC=1                       # (a shell split would have errored, rc 2/127)
=== hostile-dollar [grep]           # `$(touch pwned)`
TENTACLE_RC=1
=== hostile-dash-flag [grep]        # `-n` as a PATTERN
TENTACLE_RC=1
=== path-dash-file [grep]
TENTACLE_RC=0
./-dash.ts:1:needle dash
=== path-space [grep]
./a b/sp ace.ts:1:needle
=== path-quote [grep]
./it's/q.txt:1:needle
=== path-hidden-metachar [grep]     # path `.hid[x]`
./.hid[x]/g.ts:1:needle            # the escaped `-path` guard, in the image
=== parse-error [grep]              # `foo(`
grep: bad regex 'foo(': Unmatched ( or \(     # busybox
grep: Unmatched ( or \(                        # debian
TENTACLE_RC=1
=== missing-path [grep]
TENTACLE_MISSING
--- outer rc=3
```

rg in alpine (rg 14.1.0), `gate-rg.sh`:

```
=== plain-hit [rg]
TENTACLE_RC=0
Same 12 lines as the fallback above, same order.
=== translated-d [rg] ./src/a.ts:1 … ; ./src/a.ts:2 …
=== files-with-matches [rg]  (bare paths, `-l`)
=== parse-error [rg]
rg: regex parse error:
    (?:foo()
    ^
error: unclosed group
TENTACLE_RC=2
=== missing-path [rg]
TENTACLE_MISSING
--- outer rc=3
```

So on **busybox**, **GNU** and **rg**: the same shape, the same `TENTACLE_RC`
carried out, status **3** + `TENTACLE_MISSING` for a missing path, no hostile
pattern in flag position, and no `pwned` file created (`ls` after the run shows
only the fixture's own files). `rg: not found` in busybox/debian is the
`rc=127` the probe sees, which is why `TENTACLE_ENGINE` never says `rg` there.

### Non-vacuity (mutation), each reverted and re-greened

Baseline before every mutation: `bun test packages/tools/test/search.test.ts` →
78 pass, `…/search-tool.test.ts` → 18 pass, `…/agent/test/explore-search.test.ts`
→ 6 pass.

| # | mutation | result |
|---|---|---|
| 1 | delete the `d: "[0-9]"` row from the translate map | **RED** `T-S1 > "digits" renders identically` + `T-S8 > "\\d+" is translated` (2 fail, 75 pass) |
| 2 | allow absolute paths and `..` (`if (false && …)`, keep `..`) | **RED** `T-S2 > an absolute path and a climbing .. are REFUSED` (1 fail) |
| 3 | drop the `./` path prefix | **RED** 4: `T-S1 > "path-file"`, `T-S2 > a leading-dash path is usable`, `… > a literal ~ is not a home directory`, `… > a missing path is status 3` |
| 4 | drop the `-path` operand escaping | **RED** `T-S2 > a HIDDEN metachar root is searched, not self-pruned` (first attempt: 0 fail — the hidden prune had exempted hidden roots wholesale, which made the escape dead code; that was a real defect, fixed in drift 2, and after it the mutation is red) |
| 5 | `demoteCache` becomes a no-op | **RED** `T-S3(b) > one retry, the note names the failure, and the next call never runs rg again` |
| 6 | cache a FAILED probe as `grep` (the poison M4 forbids) | **RED** `T-S3(a) > a probe that times out … probes again next time` + `> unparseable probe output caches nothing` |
| 7 | give `search` to every type (`subagentExtraTools`) | **RED** `T-S4 > a general child is NOT offered search` + `> the real search TOOL is the one offered` |

Mutation 7 is why the Q1 decision lives in `subagent-tools.ts` and not inline in
`wiring.ts` (the first attempt at that mutation, against an inline arrow, stayed
**green** — an untestable decision, which is the §7 rule about logic in pure
modules).

### Regenerating the recording

The fixture and the rg transcript are one artefact of the same code path:

```
cd .tentacle/tmp/explore-search && bun record3.ts > recording3.txt
# then: first line replaced by the header, copied over
# packages/tools/test/fixtures/search-rg.txt
```

`record3.ts` makes the fixture in a **non-repo** `mktemp -d` tree (a parent repo's
`.gitignore` would otherwise apply to it — measured: this repo's own
`.tentacle/` rule silently dropped the fixture's `.hidx/`), then runs the final
`buildSearchPlan(rg)` per query. Review re-runs it and diffs.

### Gate

```
$ bunx tsc --noEmit            # clean
$ bun run lint                 # 889 files, 0 errors / 0 warnings (baseline clean)
$ bun test packages            # 6888 pass, 3 skip (the three opt-in), 0 fail
$ bun test                     # 6927 pass, 3 skip, 1 fail + 1 error — apps/mobile ONLY
```

The single `bun test` fail/error is pre-existing and environmental:
`apps/mobile/test/rn-websocket.test.ts` cannot resolve `@tentacle/client`
because `apps/mobile`'s dependencies are **not installed in this worktree**
(`apps/mobile/node_modules` absent, and `bunx tsc -p apps/mobile --noEmit`
fails the same way on untouched files). `git status` shows nothing of mine under
`apps/mobile`. `bun test packages` (every package, including all of mine) is
green with exactly the three baseline skips.

## Review

*— (empty: PLAN ONLY; a fresh context fills this)*

## Revision 1 (response to design review)

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Every finding is applied or argued. "Applied" means the Implementation text was
replaced (not appended) and the change is traceable to a Design/Tests/Failure
section; "argued" means the finding did not reproduce as stated, with the
measurement named. Nothing in this table is a promise — the sections above are
the plan.

| # | finding (short) | change in this revision |
|---|---|---|
| **H1** | regex dialect (Rust vs ERE) unmentioned → silent wrong match | **Applied.** New `classifyPattern` in the pure module (Design 3c) with a measured three-class table (translate / refuse / pass): `\d`→`[0-9]`, `\w`, `\s`→POSIX classes; `(?…)`, `(?:`, `\p{}`, lazy, `\x`, `{n,m}` refused with the engine named + `fixed_strings` advice. Dialect stated in the tool description. Table added to T-S1 and a separate pure T-S8. Concedes the review's point *and* corrects one of its examples: `\bfoo\b` **works on all three** greps (measured), so it is passed through, not refused. Owner decision in **Q7**. |
| **H2** | invalid regex reads as `no matches`; F14 would retry a parse error | **Applied.** F2/F3 rewritten: stderr is kept (`grep -s` replaces the whole-command `2>/dev/null`), the three grammars (`bad regex` / `Unmatched` / `parentheses not balanced` / `warning:` / `regex parse error`) are parsed, a parse error returns `isError: true` with the engine's text + "retry with `fixed_strings: true`", and **F14 explicitly excludes parse errors**. Measured: `find -exec {} +` returns **1** for both "no match" and "grep died", so rc alone cannot tell them apart — stderr is the only signal. Tested in T-S3(c). |
| **H3** | `\| head -c` loses the exit code; `2>/dev/null` hides F3's message | **Applied.** Bounds step 1/2 rewritten: every command is `{ <walk> ; printf 'TENTACLE_RC=%s\n' "$?" >&2; } \| head -c 262145`, plus a POSIX existence pre-check `[ -f ] \|\| [ -d ] \|\| [ -L ]` exiting **3** with `TENTACLE_MISSING`. F3 rewritten around them. Measured on busybox/alpine/debian/BSD with the final shape (Context (c)); re-measurement of the *final* command is an explicit Review gate. Tested in T-S3(d). |
| **H4** | busybox likely rejects `-I` → every search says "no matches"; probe must be mandatory | **Applied, with the premise corrected by measurement.** The capability probe is now **mandatory** and cached with the engine (Design 3a). But busybox does not *reject* `-I` — it **accepts and ignores** it (measured: a NUL file is searched and printed), which is worse than a rejection because there is no error to see. Hence `-I` is conditional on a live probe (`printf 'a\000needle' \| grep -I -q -e needle -` → rc 1 filters / rc 0 does not) and the parser also filters NUL-bearing lines. Live runs in `busybox:latest`, `alpine:3.20`, `debian:bookworm-slim` are in Context (a)–(g) and are the merge gate. |
| **H5** | `files` mode is a different tool per engine (`src/**/a*.ts`, `!`, `ignore_case`) | **Applied.** `glob` is defined and **enforced** as a basename glob: `/`, `**`, a leading `!` and `..` are rejected by the schema with a message pointing at `path`; `ignore_case` maps to `--iglob` / `-iname` (both measured); `[[]id[]]` is the documented literal-`[` spelling (measured on all four engines). Measured `rg -g 'src/**/a*.ts'` → nothing, which is why the field is narrow. Tested in T-S5. |
| **H6** | no `glob` in content mode; no "which files" answer; no per-file counts | **Applied.** `glob` added for both modes (Design, *Input schema*); `files` + `pattern` = files-with-matches (`rg -l` / `grep -l`, both measured POSIX-clean); on a count truncation a bounded `[more matches in: path n, …]` digest is appended from the already-buffered lines. Third header shape added. Tests in T-S1/T-S6. Owner decision in **Q8**. |
| **H7** | `path` unconfined while `permission: "none"` — a discovery tool | **Applied as a question + a design.** Bounds step 0 and precondition 7 added; `permission: "none"` justified only inside the workspace; the "named in `path` is exempt" rule is now scoped **inside** the workspace; symlink argument is `-H`-followed and must be resolved/refused. **Owner decision in Q6**, with the reviewer's recommendation (refuse absolute / `..`) as option (a) and mine. |
| **M1** | path quoting half-designed; `find` has no `--`; `-path` operand is a pattern | **Applied.** `./`-prefix on every relative path (measured: `find -dash.ts` fails on all three engines, `find ./-dash.ts` works); the `-path` guard operand is glob-escaped (measured: a hidden metachar root `.hid[x]` self-prunes to zero unescaped, works escaped, on busybox/alpine/debian/BSD; a non-hidden `app/[id]` root is unaffected — stated honestly rather than over-claimed); NUL/`\n`/`\r` rejected in `pattern` **and** `path`/`glob`; hostile **path** table added to T-S2 with its own mutations. |
| **M2** | "result sets agree" over-claimed; `.gitignore` only inside a git repo; note points wrong way; Q3 vs Design contradiction | **Applied.** Contract restated as "same shape, bounds, ordering; result set best-effort; header names the engine" (Load-bearing assumption + Design 3). `--no-require-git` added (measured: rg 14.1.0 applies nothing without `.git` by default, everything with the flag; measured cost 24 vs 25 ms). Note wording changed to "may **differ**". Q3(a) reworded to fallback-only; Q3.1 removed as a live question (its answer was already the Design's). |
| **M3** | raw-cap subset presented as "first N"; 300 KB line; `--sort path` reconsidered | **Applied.** A distinct `INCOMPLETE` marker when `raw.length === CAP`, trailing partial line dropped, non-fatal decode; rg gets `--max-columns 1200 --max-columns-preview` (measured: 300 KB line → 1234 bytes, other hits intact; without `--preview` → useless `[Omitted long matching line]`); `--sort path` **taken** — measured 11 ms (38→50 ms repo-wide), the earlier "45 %" does not reproduce. Tested in T-S6. |
| **M4** | cache can be poisoned; F14 never demotes | **Applied.** Probe is `rg --version` (not `command -v rg`), carries **no** `ctx.signal` (own 5 s timeout), caches **only** a definitive answer (a rejection/timeout caches nothing), and F14 **overwrites the cache with `grep`** before its single retry. Tested in T-S3(a)(b); Q4 amended. |
| **M5** | Q1 misses the permission angle | **Applied.** Q1 rewritten: `shell` is `permission: "ask"` (`builtins.ts:286`) so every grep is a prompt and unbounded output; recommendation flipped to **(a) everyone**, conditional on Q6. |
| **M6** | T-S1 has no stated behaviour without `rg` | **Applied.** New "How the real-engine half runs in CI" block: the default suite runs the **fallback for real** (measured present on every platform) against a **recorded** rg transcript, so it **never skips** and needs no install; the recording is re-verified as a documented Execution/Review step. A `TENTACLE_SEARCH_RG` opt-in was considered and **rejected**: `scripts/test-env-guard.ts` strips every `TENTACLE_*` outside its keep-list (so it would need a guard change plus a test), and AGENTS §6 pins the baseline at *three* opt-in skips. Live container runs are a documented **Review gate**, not a suite member. |
| **M7** | (a) `search .` vs `fs_edit a.ts` do not conflict; (b) F9 strips `\t`; (c) `exec` is not the env's only member | **Applied, all three.** (a) Design 4 now states the truth — `pathResource` is the basename (`path-locks.ts:47-51`), the keys differ, they may run concurrently, and why that is acceptable (atomic rename, no torn bytes). (b) F9 keeps `\t`. (c) Precondition 1 corrected to `exec`/`readFile`/`writeFile`/`spawnBackground` (`execution.ts:42-58`) with the `readFile` line cited for Design 3b. |

**What this revision does not do** (deliberately, and visible): it does not pick
Q6/Q7/Q8 — they are owner decisions with a recommendation each; it does not
implement the `permission`-depends-on-input seam Q6(c) would need (that would be
a `core` change, recommended against until the owner asks); and it does not add
context lines (`-C`), which stay covered by `fs_read path:start:end`.

**One review claim that did not reproduce, recorded so nobody "fixes" it again:**
`\bfoo\b` is *not* a dialect break — measured on BSD 2.6.0-FreeBSD, busybox
1.38.0, GNU 3.8 **and** rg 15.2.0, it matches `foo` and not `xfoo`/`fooX`. So it
is passed through, not refused. Its cousin `\B` is also accepted by all three.
(This is the kind of thing that only a run settles: the review reasoned from
"ERE has no `\b`", and ERE *does* fix `\b` as a word boundary in practice on all
these implementations.)

*— deepseek (tentacle --profile deepseek), 2026-11-11*

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
