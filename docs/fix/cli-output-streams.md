# fix/cli-output-streams — stdout carries only a command's data; everything else goes to stderr

> **Status:** execution done, gate green — awaiting fresh-context Review
> **Branch:** `fix/cli-output-streams`
> **Type:** fix · **Size:** L · **Blast:** cross-module · **Suited:** a stronger model executes + fresh-context Review (every CLI command's output path; no protocol, persistence or Ink change)

## Context

*— claude-opus-5-5, 2026-11-04*

The CLI has ONE sink for everything outside Ink: `main()`'s `write`
(`packages/cli/src/main.ts:369`, default `process.stdout.write`). Data (tables,
`ps -q` names, a one-shot's answer) and non-data (errors, `usage:`, warnings,
progress, hints, the y/N prompt, daemon logs) share stdout, so a pipe gets
garbage: `tentacle ps -q --engine bad | xargs tentacle rm` feeds `[error]` words
to `rm`; a one-shot's answer is interleaved with `[tool] …`/`(tokens …)`; `run
… 2>log` still prints its phases on the terminal and `run … >out` loses them.
A read-only audit (`.tentacle/tmp/stdout-audit/report.md`, main d386b87: 30 rows,
~125 sites) classified every site; this fix applies it, re-verified against the
current main (8bf116f).

**Rule (owner, 2026-11-04).** STDOUT = the data a command produces: tables,
`-q` names, `--version`, `--help`, a one-shot's answer, JSON, the result lines
listed below. STDERR = everything else outside Ink: progress/phases/StatusLine,
info notes, warnings, errors, `usage:` after an error, hints, the y/N prompt,
`still running`, `not reachable`, daemon logs.

**Owner decisions (audit §5).**
- **D1** `run --detach`: the workload NAME goes to stdout ONLY when stdout is not
  a TTY (`name=$(tentacle run --detach …)`); on a TTY only the dim `still running`
  line (stderr).
- **D2** `serve`: `daemon listening on <url>` → stderr (a log), audit lines too.
- **D3** `rm`: the removed NAME on stdout (like `docker rm`), every prose line on
  stderr. `package add/rm/update` and `update` result lines stay on stdout; their
  warnings / trust notes / progress → stderr. `hooks trust`: `usage` → stderr;
  `revoked: …` stdout; "no stored …" → stderr.
- **D4** the y/N prompt → stderr; asked when `stdin.isTTY && stderr.isTTY`.
- **D5** one-shot and plain REPL: answer text → stdout ALWAYS; the trace
  (`[tool]`, `[result]`, tokens, `[hook]`, `[diff]`, subagent lines, `[stopped]`,
  `[error]`, prompt/banner/👋) → stderr ALWAYS.
- **D6** every `[error]` / `[config error]` / `usage:` (after an error) → stderr,
  for every command; an explicit `--help` stays stdout.
- **D7** the TUI-adjacent rows (pre-mount / post-unmount notes, `connect`,
  `attach` of a run) move too: one rule.

**Shape (owner).** Two sinks, `out` (data) and `err` (default for everything
else); today's `write` is renamed so a missed site fails typecheck. Colour/dim and
the StatusLine gate/width decide on the stream they write to (`stderr.isTTY &&
!NO_COLOR`, `stderr.columns`) through ONE helper. The test seam `io.write`
becomes `io.out` / `io.err`.

**Repro** (2026-11-04, current main 8bf116f, `.tentacle/tmp/cli-output-streams/repro.ts`,
run as `bun run <it>` from the repo root):

```ts
// Which stream does each CLI line go to? stdout and stderr captured apart.
import { mkdirSync } from "node:fs";
const R = "/Users/gmeghnag/tentacle/.tentacle/tmp/cli-output-streams";
const repo = "/Users/gmeghnag/tentacle/.tentacle/worktrees/cli-output-streams";
mkdirSync(`${R}/home`, { recursive: true });
const env = { ...process.env, HOME: `${R}/home`, TENTACLE_CONFIG_DIR: `${R}/home/cfg`, NO_COLOR: "1" };
for (const c of ["ps --engine bad", "ps -q --engine bad", "hooks trust", "package bogus", "ps --nope"]) {
  const p = Bun.spawnSync(["bun", "packages/cli/src/main.ts", ...c.split(" ")], {
    cwd: repo, env, stdout: "pipe", stderr: "pipe",
  });
  console.log(`== tentacle ${c} (exit ${p.exitCode})`);
  console.log(`-- stdout: ${JSON.stringify(p.stdout.toString())}`);
  console.log(`-- stderr: ${JSON.stringify(p.stderr.toString())}`);
}
```

```
== tentacle ps --engine bad (exit 1)
-- stdout: "[error] unknown engine \"bad\" (--engine): use kubernetes, docker or podman\nusage: tentacle ps [--engine kubernetes|docker|podman] [-a|--all] [-q|--quiet] [-v|--verbose]\n"
-- stderr: ""
== tentacle ps -q --engine bad (exit 1)
-- stdout: "[error] unknown engine \"bad\" (--engine): use kubernetes, docker or podman\nusage: tentacle ps [--engine kubernetes|docker|podman] [-a|--all] [-q|--quiet] [-v|--verbose]\n"
-- stderr: ""
== tentacle hooks trust (exit 1)
-- stdout: "usage: tentacle hooks trust --list | --revoke <folder>\n"
-- stderr: ""
== tentacle package bogus (exit 1)
-- stdout: "usage: tentacle package install <path|git-url>[#ref] | list | remove <name> | update [<name>]\n"
-- stderr: ""
== tentacle ps --nope (exit 1)
-- stdout: "[error] unknown option --nope\nusage: tentacle ps [--engine kubernetes|docker|podman] [-a|--all] [-q|--quiet] [-v|--verbose]\n"
-- stderr: ""
```

## Implementation

*— claude-opus-5-5, 2026-11-04*

### Load-bearing assumption

**Every non-Ink CLI line reaches the terminal through `main()`'s single `write`
(or `process.stdout` directly at a handful of named sites), so routing is decided
in ONE place per line.** Verified: `main.ts:369` defines `write`; it is handed down
as the sink of every helper — `connectTui(…, write)` `main.ts:467`, `runUpdate`
`main.ts:500`, `packagesCommand` `main.ts:533`, `hooksTrustCommand` `main.ts:547`,
`KeptDeps.write` `main.ts:569`, `openTuiSessions(…, write)` `main.ts:766,1351`,
`runSessionTui({write})` `main.ts:831,1565,1614`, workload `log: write, info`
`main.ts:1007-1008,1382-1383,1495-1496`, `launchRelay({write})` `main.ts:1054`,
`joinRun({write, info})` `main.ts:1344-1345`, `startWorkerRuntime(…, write)`
`main.ts:1547`. The only raw stdout writes outside Ink in the CLI are `askLine`
(`main.ts:350,360`), `terminal.ts:15,33,45` and `StatusLine`'s width
(`status-line.ts:89`); the pod-side `--resident-status/--resident-stop`
(`pod-resident.ts:785,789`) are JSON data and stay. (`grep -n "process.stdout"
packages/cli/src/*.ts`.) So removing `write` makes `tsc` list every site.

### Preconditions

- Ink owns stdout during a TUI session (AGENTS §7 "Never write raw to the
  terminal while Ink owns it"): the pre-mount pickers stay gated on
  `stdin.isTTY && stdout.isTTY` (`main.ts:472,767`) and `planAttach`'s `tty`
  (`main.ts:1316`) — they are Ink's terminal, not CLI lines; untouched.
- `writeErr` exists and is already stderr (`main.ts:375`): the skills/hooks/
  packages/agents diagnostics `main.ts:600-621`, the kept-index problems of
  `attach` `main.ts:1276`, the relay (`main.ts:405`), `ps -q` problems
  (`kept-cmd.ts:154`), `ps`'s unreachable notes (`kept-cmd.ts:189-191`).
- `serve --stdio` and the resident pod modes already log to `process.stderr`
  (`main.ts:636,644`, `pod-resident.ts:777`): stdout is their RPC channel.
- Colour today: `info` grey by `stdout.isTTY && !NO_COLOR && !io.write`
  (`main.ts:373`); `ps`/`rm` `dim` by `stdout.isTTY` with no test seam
  (`main.ts:564,573`); `dimErr` by `stderr.isTTY && !io.writeErr`
  (`main.ts:576-579`); StatusLine on by `process.stdout.isTTY`
  (`engine-runtime.ts:399,699`), width `process.stdout.columns`
  (`status-line.ts:89`); `styleInfo` (`run-ui.ts:29`).
- `turn_end` is yielded once per run (`agent.ts:742,754,808,827`): one-shot's
  trailing `\n` (`render.ts:58`) ends the answer.

### Design

1. **`streams.ts` (new, pure): the ONE terminal helper.**
   `termOf(stream: { isTTY?: boolean; columns?: number }, env = process.env)` →
   `{ tty, colour, columns() }` with `colour = isTTY && !NO_COLOR`, and
   `NOT_A_TERMINAL` (an injected sink is never a terminal). Used by `main`
   (`info` grey, `ps`/`rm` dim, the y/N gate, the StatusLine term it hands to the
   engine runtime) and by `StatusLine`'s default width.
2. **`main.ts`: `write` / `writeErr` are gone; `out` (stdout) and `err` (stderr).**
   `CliIO.write`/`writeErr` → `CliIO.out`/`err`; `errTerm = io.err ?
   NOT_A_TERMINAL : termOf(process.stderr)`; `colour = io.colour ??
   errTerm.colour`; `info = err ∘ styleInfo`. New seam `CliIO.outTty` (default
   `!io.out && stdout.isTTY`) for D1. Per site:
   - `out`: `HELP` on `--help`/`-h` (`:409`), `--version` (`:416`), the
     infoRequest (`:432`), D1's name.
   - `err`: every `[error]`/`usage:`/`[config error]`/`[connect error]`/
     `[serve error]` (`:383,435,479,523,559,656,698,733,874,878,890,1238,1267,
     1280,1308,1320,1400`), run/attach pre-flight refusals & warnings
     (`:859,896,930,934,939,948,952,957,1033,1037,1090,1474,1505`), `serve`'s
     audit/notice/error/listening/title (D2, `:674-682`), `HELP` after an empty
     prompt (D6, `:1622`), `[mcp]` lines (`:1578,1581,1633,1636`), every sink
     handed down (connect, tui-sessions, runSessionTui, worker, engine `log`/`info`,
     joinRun, launchRelay, engineHost/`setupFailureLine` `:749,1364`).
   - `askLine` (`:348`): readline `output: process.stderr`, SIGINT newline on
     stderr; both y/N gates (`:565,942`) `stdin.isTTY && errTerm.tty` (D4).
   - D1: `run --detach`: `launchRelay`'s exit 0 → `out(name\n)` iff `!outTty`.
     Both exit-0 outcomes (relay started; relay not yet started — the workload
     exists) print it; a failure (exit 1) prints no name.
3. **One-shot and plain REPL (D5): `render.ts` gets a pure `AnswerSplit`.**
   `push(event) → { out, err }`: `text` deltas → out; `turn_end` `end_turn` → out
   `"\n"` only when stdout is mid-line (an answer-less run writes nothing to
   stdout); every other event → err (`render(event)` unchanged). When out text
   resumes after a trace and stdout is mid-line, it is prefixed with `"\n"` (two
   answer parts never glue). `atLineStart` (the shared terminal cursor) drives
   `errorLine` → err. `main`'s one-shot loop and `repl.ts` use it; `ReplIO.write`
   → `out` + `err`; `terminal.ts`: readline and the `› ` prompt on stderr;
   banner, `/help`, 👋 on err.
4. **`kept-cmd.ts` (D3).** `KeptDeps.write/writeErr/dim/dimErr` → `out`, `err`,
   `dim` (stderr's). Every prose line → `err` (index problems in `ps` too —
   audit row 7). `out`: the `ps` table, `ps -q` names, and the NAME of each
   `rm` that exits 0 (`removed`, `gone`), its prose (`removedLine`, `Removed the
   entry of …`) on err.
5. **`packages-cmd.ts` (D3).** `write` → `out` + `err`. out: `installed …` and
   its `skills/agent types/MCP servers` lines, the `list` rows, `removed x`,
   `x: already up to date`, `x: pinned …, unchanged`, `updated x` + `changed
   files`. err: `packages: …` errors, the trust block (`writeTrusted`), `note:
   disabled`, `list` diagnostics, `no packages installed` (empty list = empty
   stdout, as `hooks trust`), `not installed from git — reinstall…`, `usage`.
6. **`update.ts` (D3).** `write` → `out` + `err`. out: the version report
   (`tentacle a → b`, up to date, newer, `pod binaries (…)` block), `updated: …`.
   err: `[update] … runs from source`, the "left alone … tentacle update
   --version" hint, `[update error] …`, `downloading …`.
7. **`hooks-trust.ts` (D3).** `write` → `out` + `err`: rows and `revoked:` out;
   `usage`, `no stored …` err.
8. **`engine-runtime.ts`.** Both deps get `logTerm?: { tty; columns }` (default
   `termOf(process.stderr)`): StatusLine on iff `logTerm.tty`, width
   `logTerm.columns`. `main` passes `errTerm`. `log`/`info` are already
   non-data only (audit rows 12-17) — main hands them `err`/`info`.
9. **`status-line.ts`.** Default `columns` → `termOf(process.stderr).columns`.
10. Unchanged modules that only ever emit non-data keep their `write`/`log`
    parameter and receive `err` from main: `tui-sessions.ts`, `connect.ts`,
    `attach-run.ts`, `local-runtime.ts` (`startWorkerRuntime`), `relay.ts`
    (`launchRelay`).

### Files

`packages/cli/src/streams.ts` (new) → `render.ts`, `repl.ts`, `terminal.ts` →
`status-line.ts`, `engine-runtime.ts` → `kept-cmd.ts`, `packages-cmd.ts`,
`update.ts`, `hooks-trust.ts` → `main.ts`. Tests: `render.test.ts`,
`repl.test.ts`, `kept-cmd.test.ts`, `packages-cmd.test.ts`, `update.test.ts`,
`hooks-trust.test.ts`, `main.test.ts`, `profile-flag.test.ts`, `args.test.ts`,
`engine-docker.test.ts`, `engine-k8s.test.ts` (their TTY override moves to
stderr), + whichever the rename breaks.

### Failure modes

- **A missed site stays on stdout:** `write` no longer exists in `main`, and each
  mixed module's sink is renamed (`out`/`err`), so `tsc` fails on every unrouted
  call; raw `process.stdout` is grep-guarded (only `pod-resident` JSON,
  `serve.ts` RPC, Ink's `run.tsx`).
- **Colour in a log / lost colour on a terminal:** every styled line is on
  stderr and styled by `errTerm` (`cmd 2>log` → plain; `cmd >out` on a TTY →
  grey). Data on stdout is never styled.
- **`run … >out` on a terminal:** the y/N prompt is still asked (stderr is the
  TTY, D4); `run … 2>log`: no prompt → the dangerous mount is refused, as a
  non-interactive run is today.
- **StatusLine with stderr piped and stdout a TTY:** one plain line per phase on
  stderr (the piped branch), no spinner escapes in the log.
- **One-shot error mid-answer:** stdout keeps the partial answer; `[error]` on
  stderr, on its own line on a shared terminal (`atLineStart`).
- **Empty answer:** nothing on stdout (no lone `\n`).
- **`run --detach` failure:** exit 1 and no name on stdout — `$(…)` is empty.
- **SIGINT at the y/N prompt:** its newline goes to stderr, where the prompt is.

### Tests

Red first (§9): each new assertion is shown failing on main's code, then green.
Pinned per command — stdout holds ONLY data:
- `render.test.ts`: `AnswerSplit` routes text/end_turn to out and every trace
  kind to err; re-join `\n`; no stray `\n` for an empty answer.
- `repl.test.ts`: answer on out; banner, `[tool]`, `[error]`, 👋 on err.
- `main.test.ts`: one-shot (mock model) stdout === the answer exactly, trace on
  err; `ps --engine bad`/`ps -q --engine bad`/unknown option/`--nope`:
  stdout empty, `[error]`+`usage` on err; `--help`/`--version` on out; empty
  prompt HELP on err; `run --detach` piped: stdout === `name\n`, and with
  `outTty: true` stdout empty; `serve` (fake daemon): stdout empty; colour:
  `info` grey follows `colour` (stderr's), never on out.
- `kept-cmd.test.ts`: `ps` table alone on out (index problem + unreachable on
  err), `ps -q` names alone, `rm` stdout === `name\n`, prose on err; failures:
  stdout empty.
- `packages-cmd.test.ts`, `update.test.ts`, `hooks-trust.test.ts`: results out,
  errors/usage/notes/progress err.
- `streams.test.ts`: `termOf` colour = TTY && !NO_COLOR; columns from the stream.
- Mutations (reverted, `shasum` identical): route `AnswerSplit`'s trace to out;
  `termOf` ignoring `NO_COLOR`/isTTY; `rm` name on err; D1 gate inverted.

## Execution

*— claude-opus-5-5, 2026-11-04*

**Repro on main (before any edit):** the Context's output, reproduced verbatim
(errors and `usage:` on stdout, stderr empty). **After:** the same script prints
`stdout: ""` for all five and every line on stderr, exit codes unchanged.

**Red first.** `test/output-streams.test.ts` was written before any source edit
and run on main's code: **17/17 failed on their assertions** (stdout/stderr
contents), not on an import. The `repl.test.ts` rewrite (seams `out`/`err`) was
also run against main's `repl.ts` (restored from `HEAD`, then put back): 5/5
red — but as a `TypeError` (`io.write` no longer passed), i.e. because of the
renamed seam, not the property; the property itself is pinned by the
`AnswerSplit` tests and by the one-shot test above, which were red on it.

**As built, in the Implementation's order:**
1. `src/streams.ts` (new): `termOf(stream, env)` → `{ tty, colour, columns() }`
   (`colour = isTTY && !NO_COLOR`), `NOT_A_TERMINAL`, `dimIf`.
2. `src/render.ts`: `AnswerSplit` (`push(event) → { out, err }`, `error()`);
   `render()` unchanged. `src/repl.ts`: `ReplIO.write` → `out` + `err`, banner,
   `/help`, 👋, trace and `[error]` on `err`. `src/terminal.ts`: readline
   `output: process.stderr`, the `› ` prompt on stderr.
3. `src/status-line.ts`: default width = `termOf(process.stderr).columns`.
   `src/engine-runtime.ts`: `logTerm?` on both deps interfaces, one
   `statusLineFor(deps)` (spinner iff `logTerm.tty`, cut to `logTerm.columns`;
   default `termOf(process.stderr)`) replaces the two `process.stdout.isTTY` gates.
4. `src/kept-cmd.ts`: `KeptDeps.write/writeErr/dim/dimErr` → `out`, `err`,
   `dim` (stderr's). Every prose line on `err` (index problems in `ps` too);
   `out` = table, `-q` names, and `removedName()` on the two exit-0 `rm`
   outcomes (`removed`, `gone`).
5. `src/packages-cmd.ts`, `src/update.ts`, `src/hooks-trust.ts`: `write` →
   `out`/`err` per Design §5–7 (`hooksTrustCommand` takes `{ out, err }`).
6. `src/main.ts`: `CliIO.write/writeErr` → `out`/`err` + `outTty`; `errTerm`,
   `colour = io.colour ?? errTerm.colour`, `info = err ∘ styleInfo`,
   `canAsk = stdin.isTTY && errTerm.tty` (both y/N gates), `askLine` on stderr;
   `--help`/`-h`/`--version`/infoRequest on `out`; every other site on `err`
   (mechanical, then `tsc` listed the shorthand sites that needed `write: err`);
   `logTerm: errTerm` on the three engine runtimes; one-shot through
   `AnswerSplit`; `HELP` after an empty prompt on `err`; D1 after `launchRelay`.

**Drift from the Implementation (and why):**
- `AnswerSplit`'s `[stopped: x]` has no leading `\n` any more: stdout's own
  `\n` (turn end, when mid-line) already puts the screen cursor at a line start.
- The one-shot's `[hook]`/`[context]` lines go through `err` (they were raw
  `process.stderr`): same stream, now capturable by the seam. The plain REPL's
  and `serve --stdio`'s raw `process.stderr` writes were left as they were
  (already stderr; no seam there).
- `packages update`'s `x: pinned to …, unchanged` is a per-package outcome like
  `already up to date`, so it stays on stdout; `not installed from git —
  reinstall …` is a refusal hint → stderr.
- Not in the plan but required by the stream move: `engine-docker.test.ts` /
  `engine-k8s.test.ts` now force `process.stderr.isTTY = false` (was stdout's),
  since the spinner gate moved; `main.test.ts` gained a `strayStdout` buffer
  with an `afterEach` that fails any test whose run/attach/error scenario wrote
  to stdout, and its `run` helper pins `stdout === ""` for `run`/`attach`
  without `--detach`.
- Unchanged by design: the Ink pickers' and `planAttach`'s `tty` gates
  (`main.ts` `connect` picker, `openSessions`, `attach`) still read
  `stdout.isTTY` — Ink renders there.

**Tests added/changed:** `output-streams.test.ts` (new, 19: one-shot, 9 error
commands, empty prompt, `--help`/`--version`, `ps` index note, `serve`, D1
piped/TTY/failed, colour on stderr, spinner gate ×2), `streams.test.ts` (new, 4),
`render.test.ts` (+4 `AnswerSplit`), `repl.test.ts`, `kept-cmd.test.ts`
(`rm` stdout = names, `ps` note on stderr), `packages-cmd.test.ts` (+1: empty
list), `update.test.ts`, `hooks-trust.test.ts`, `main.test.ts`,
`profile-flag.test.ts`, `args.test.ts`, `untrusted-text.test.ts` (seams and
stream assertions).

**Mutations** (each applied, the narrow test run, reverted; final `shasum` of
`render.ts streams.ts kept-cmd.ts main.ts engine-runtime.ts` identical to before):
- M1 `AnswerSplit` trace → `out`: red (one-shot + `AnswerSplit` test).
- M2 `termOf` ignores `NO_COLOR`: red (`streams.test.ts`).
- M3 `rm`'s name on `err`: red (4 `rm` tests).
- M4 D1 gate inverted: red (both D1 tests).
- M5 spinner gated on `process.stdout.isTTY`: red (spinner test).
- M6 `main` stops passing `logTerm`: red (TTY-stderr spinner test).
- M7 index-problem note on `out`: red (`ps` tests in both files).

**Gate** (once, foreground): `bunx tsc --noEmit` → clean; `bunx biome check .`
→ "Checked 624 files … No fixes applied" (0 errors/warnings); `bun test
packages` → **4361 pass, 3 skip (the opt-in live-k8s/docker/slow), 0 fail**.

**Unverified (one line):** the D4 y/N prompt on a real terminal is not under
test (`askLine` reads the real stdin/stderr); verify with `cd ~ && tentacle run
--engine docker --image debian >/tmp/out` → the `[y/N]` question shows on the
terminal and `/tmp/out` stays empty.

## Review

*— claude-opus-5-5, 2026-11-04*

**Verdict: PASS** (LOW findings only, listed below). Fresh context, adversarial.

**Both streams, end to end.** The real CLI (`bun packages/cli/src/main.ts`, stdout and
stderr piped apart, stdin closed, an unreadable `kept/garbage.json` in the index;
`.tentacle/tmp/cli-output-streams-review/repro.ts`):

| command | exit | stdout | stderr |
|---|---|---|---|
| `ps` | 0 | the header row only | `kept index: …garbage.json: not valid JSON — left untouched` |
| `ps -q` | 0 | `""` | the same note |
| `ps --engine bad` / `ps -q --engine bad` / `ps --nope` | 1 | `""` | `[error] …` + `usage:` |
| `rm nope` / `rm` | 1 | `""` | index note + `[error] no kept … named "nope"` / `[error] missing argument` + `usage:` |
| `package list` (empty) / `package bogus` | 0 / 1 | `""` | `no packages installed` / `usage:` |
| `hooks trust --list` (empty) / `hooks trust` | 0 / 1 | `""` | the note / `usage:` |
| `update --check` (dev build) | 1 | `""` | `[update] this tentacle runs from source …` |
| `--version` | 0 | `tentacle dev\n` | `""` |
| `run --detach --prompt x` (no image) | 1 | `""` | `[pod] --image <ref> is required …` |

The one-shot, `run --detach` piped/TTY/failed, `rm` success (stdout === name), `serve`,
`package`/`update` result lines and the `ps` table are pinned by tests that capture
both sinks apart (`output-streams.test.ts`, `kept-cmd.test.ts`,
`packages-cmd.test.ts`, `update.test.ts`, `hooks-trust.test.ts`); read and confirmed
non-vacuous (each asserts `out` exactly and `err` content).

**Decisions D1–D7 against the code** — all hold:
- D1 `main.ts` after `launchRelay`: `out(name)` iff `launched === 0 && !outTty`; the
  "relay has not started yet" exit 0 also prints it, a failure prints none;
  `outTty` defaults to `!io.out && stdout.isTTY` (an injected sink = piped). ✓
- D2 `listening`, `[daemon]` audit/notice/error/title → `err`. ✓
- D3 `rm`: `removedName()` only on the two exit-0 outcomes (`removed`, `gone`), after
  the prose; `foreign`/`other`/`failed`/`unreachable` print no name; `rmCommand`'s
  `Set` keeps one name per argument. `package`/`update` results on `out`, trust
  block/notes/progress/errors on `err`; `hooks trust` `revoked:` out, the rest err. ✓
- D4 `askLine` readline + SIGINT newline on stderr; both gates `stdin.isTTY &&
  errTerm.tty`. ✓ (not under test — the Execution's own "unverified" line stands.)
- D5 `AnswerSplit`: text → out; `turn_end` → out `\n` only mid-line; every other
  event → `render()` on err; the REPL's banner, `/help`, 👋, `› ` prompt and readline
  on stderr. ✓
- D6 every `[error]`/`[config error]`/`[connect error]`/`[serve error]`/`usage:` → err;
  explicit `--help`/`-h`/`--version`/infoRequest → out; the help after an empty
  prompt → err. ✓
- D7 connect, tui-sessions, runSessionTui, worker, attach-run (`joinRun`), relay
  sinks all receive `err`. ✓

**Colour / StatusLine / seams.** `colour = io.colour ?? errTerm.colour`, `errTerm =
io.err ? NOT_A_TERMINAL : termOf(process.stderr)`; `info` and the `ps`/`rm` dim both
use it; data on `out` is never styled. StatusLine gate/width = `logTerm`
(default `termOf(process.stderr)`), `main` passes `errTerm` on all three engine
runtimes; `StatusLine`'s own default width is stderr's; the pod-binary transfer
bar writes to `deps.log` (= err). The only `stdout.isTTY` reads left are the Ink
pickers / `planAttach` `tty` (Ink's terminal — correct) and `outTty`. No stdout
default left in any renamed sink: `grep process.stdout packages/cli/src` → only
main's `out` default, the REPL's `out`, `pod-resident` JSON, `serve --stdio` RPC.
`writeErr`/`dimErr`/`write` are gone from `main`/`KeptDeps`/`PackagesCmdDeps`/
`UpdateDeps`/`ReplIO`. No write lost or duplicated (index problems reported once,
before the `-q` branch; empty `text` deltas skipped as before).

**TTY comparison (main.test.ts).** `script -q /dev/null …` is refused by this
session's permission hook, so a TTY was simulated with a preload setting
`isTTY=true`/`columns=80` on stdin/stdout/stderr (`tty-preload.ts`), on the branch
and on main's `packages/cli` materialised from `HEAD` in
`.tentacle/tmp/cli-output-streams-review/main-repo`: **main 97 pass / 7 fail, branch
99 pass / 5 fail**; the branch's 5 are a strict subset of main's 7 (the
"dangerous source — no TTY" and "attach <name> resolves …" ones now pass). None new.

**Mutation (mine).** `AnswerSplit` `turn_end` → `out = "\n"` unconditionally (an
answer-less run would leak a lone `\n` to stdout): **red** — `AnswerSplit > an
answer-less run writes nothing to stdout` (1 fail, 35 pass); reverted, `shasum
render.ts` `578f300c…` identical before/after.

**Gate** (once, foreground, `bun run check`): `tsc --noEmit` clean; then `tsc -p
apps/mobile` fails (47 errors: `react-native` / expo base not installed in this
worktree — no mobile file is touched by the diff), which short-circuits `check`;
lint and test were then run as its next steps: `biome check .` → 624 files, no
fixes (0/0); `bun test` → **4400 pass, 3 skip (the opt-in live-k8s/docker/slow), 1
fail** = `apps/mobile/test/rn-websocket.test.ts` cannot resolve `@tentacle/client`
(the same missing mobile install). Packages-only: green.

**Findings (all LOW):**
- L1 `engine-runtime.ts:161-174`: `statusLineFor` was inserted between
  `quitReport`'s JSDoc and `quitReport`, so that JSDoc now documents
  `statusLineFor` and `quitReport` has none. Move the helper above the comment.
- L2 plain REPL (`--plain`, `terminal.ts`): readline's `output` is stderr, so with
  `2>log` the prompt AND the echo of typed input go to the log (a TTY stdin with no
  visible echo). Consequence of D5 as decided; worth one line in the docs.
- L3 D4 on a real terminal is untested (`askLine` reads the real stdin/stderr) —
  the Execution's manual check stays the way to verify it.
- L4 the Execution's "gate green" was `bunx tsc --noEmit` + `bun test packages`,
  not `bun run check`; in this worktree `check` is red only for the missing mobile
  install (above). State it as such, or install mobile deps in the worktree.

**How the implementing model behaved.** Plan followed in order; drifts declared
honestly (the `[stopped]` `\n`, `[hook]`/`[context]` through the seam, `pinned`
on stdout); red-first evidence given, including the honest note that the
`repl.test.ts` red was a seam `TypeError`, not the property; seven mutations
recorded. No overclaim found beyond L4.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

Owner, live: `tentacle --profile deepseek "dimmi ciao" > out.txt` printed a blank line and `(tokens ↑8518 ↓15)` on stderr.

- **Tokens line removed** (`render.ts` `case "usage"` → `""`), one-shot and plain REPL alike. No README/docs mention it (grep `tokens ↑` finds none outside this doc).
- **Per-stream cursor.** `AnswerSplit(shared)` tracks stdout's and stderr's cursors apart; a trace starts on a fresh line only when stderr's own cursor is mid-line. `shared` (stdout and stderr one terminal: `outTty && errTerm.tty` in `main`, `io.shared` in the REPL) lets the answer move the cursor the trace starts from, so on one terminal answer and trace never glue. Pin (`render.test.ts`): `> out.txt` → stdout exactly `ciao\n`, stderr exactly `[tool] shell {}\n[result:ok] ok\n` (no leading/trailing blank line); one-terminal test pins no glue / no blank line.
- **L1** closed: `statusLineFor` sits above `quitReport`, whose JSDoc is back on it.
- **L3** closed: `main.test.ts` "D4: stdout redirected, stdin+stderr TTYs → the y/N is asked, on STDERR" (prompt on stderr, not stdout, asked).
- **Mutations** (applied, narrow test, reverted; `shasum` of `render.ts main.ts` identical): M8 restore the tokens line → red (2 `AnswerSplit` tests); M9 ignore stderr's cursor in `freshLine` → red (2); M10 `canAsk` also requires `outTty` → red (D4 test).
- Red-first note: the code and tests of items 1–2 and L1/L3 were already in the worktree when I took over, so red was shown by mutation, not on the pre-change code.

## Review — round 2

*— claude-opus-5-5, 2026-11-05*

**Verdict: PASS** (LOW only). Fresh context, adversarial. Same model family as the
round-1 reviewer and executor (Opus/Sonnet 5.5): shared blind spots possible.

**Checked against the code.**
- Tokens line: `render.ts:32` `case "usage"` → `""`; `freshLine("")` returns `""`, so a
  `usage` never sets `traced` nor moves a cursor. `render()` has no caller outside
  `render.ts` (`AnswerSplit` only) — the TUI is unaffected. ✓
- `> file` byte-exact: non-shared (`outTty && errTerm.tty` false, `main.ts:1675`;
  `io.shared` false, `repl.ts:56`) → `ciao\n` on stdout, `[tool] shell {}\n[result:ok] ok\n`
  on stderr, no leading/trailing blank line (`render.test.ts:137`). ✓
- One terminal: `errCursorAtLineStart` reads the shared cursor, so a trace after a
  mid-line answer gets its `\n`, and none at a line start (`render.test.ts:155`). ✓
- D4 test (`main.test.ts:2361`) is real: no `io.ask`, so the real `askLine` runs
  (readline on `process.stderr`, stdin EOF → `""` → No); asserts the prompt on stderr,
  absent from stdout, and the engine not reached. Execution's M10 covers the gate. ✓
- L1: `statusLineFor` (`engine-runtime.ts:161`) now sits above `quitReport`'s JSDoc. ✓

**Mutation (mine).** `errCursorAtLineStart` → `this.errAtLineStart` (ignore `shared`):
**red** — 2 fail (`error` placement, one-terminal glue `"Let me look.[tool] …"`), 12
pass; reverted, `shasum render.ts` `6cdaedf3…` identical before/after.

**Gate** (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` → 624
files, no fixes; `bun test packages` → **4364 pass, 3 skip (opt-in), 0 fail**.

**Attacks tried.** (1) `usage` between two text parts → no split, no blank line
(`traced` untouched): holds. (2) answer-less run with a trace → stdout `""`: holds
(`turn_end` out only when mid-line). (3) stdout TTY + `2>log` → `shared` false, trace in
the log without a leading `\n`, stdout's own cursor drives its `\n`: holds. (4) a
scratch e2e script in `.tentacle/tmp/cli-output-streams-review2/` was refused by this
session's permission hook — the trace rests on the unit tests above.

**Findings (all LOW):**
- L5 `render.ts:125`: with stdout redirected, answer parts split by a trace still get a
  `\n` between them (`a` + tool + `b` → `a\nb`), although there the trace never touches
  stdout. Decided in round 1 (D5, pinned `render.test.ts:101`); stdout is "the
  answer", not the raw delta concatenation. Say so in the doc, or drop it when not shared.
- L6 `main.ts:1675`, `terminal.ts:49`: `shared` = "both are TTYs", not "the same
  terminal" (`2>/dev/ttys003` counts as shared → one possibly extra `\n` on stderr).
  Harmless heuristic.

**Executor behaviour.** Honest: says red was shown by mutation, not on pre-change
code (round-2 code was already in the tree); three mutations recorded; claims match
the code.
