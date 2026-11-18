# eval/deepseek-efficiency — why the DeepSeek executor burns rounds, and what to change

> **Status:** context · review (verdict below) — owner questions open
> **Branch:** none (an `eval`, committed directly to `main`, AGENTS §10)
> **Size:** M · **Blast:** none for the eval itself; when promoted: B1/B2/B5 `contained` (tools / cli), B3/B4 `load-bearing` (the agent loop) · **Suited:** Opus (eval + the B3/B4 plans), DeepSeek may execute B1/B2/B5 under the new brief
> **Changelog:** none (decision record, no code)

`Type: eval · Size: M · Blast: none (eval) · Suited: Opus`

## Context

*— claude-opus-5-5, 2026-11-17*

**The question.** Owner, 17/11: *"deepseek vaneggia e probabilmente va in loop …
voglio poterlo usare ma dopo averne efficientato l'utilizzo."* Why does the
DeepSeek executor (`~/bin/tentacle --profile deepseek`, DeepSeek-V4.1-Flash) spend
so many rounds, and what do we change, in orchestration and in the tentacle
product, so it is cheap enough to run again (it runs ONE task at a time until this is
settled)? This record answers "where do the rounds go?" with counts from every
DeepSeek log, proposes fixes with an expected saving each, and says how to
measure them.

**Cost model (why calls matter).** One tool call is about one model round, and every
round re-sends the whole conversation. Prompt tokens therefore grow with
*rounds × context size*, not with the size of each tool output. The logs carry **no
token counts** (their only tags are `[tool]`, `[result:…]`, `[diff]`, `[error]`),
so rounds (tool calls) are the proxy used here. Whether the endpoint caches
prefixes, which would make extra rounds cheap, is unknown (Q1).

### Repro: the mining script

`.tentacle/tmp/deepseek-eff/mine.ts` (with `agg.ts`) reads every
`*-exec.log`, `*-fix*.log`, `conflict-*.log` and `exec-*.log` under
`.tentacle/tmp/orchestration/runs/` modified on or after 2026-10-30, the date of the
first `--profile deepseek` run in the scorecard. Every such log comes from `ds()`:
Opus runs write `.json`. That makes **228 runs** (123 exec, 101 fix rounds,
4 conflict resolutions). The snapshot was taken 2026-11-17 in the evening, while one
run was still writing, so totals can move by a few calls between invocations.

Column legend: `calls` = tool calls · `minUB` = log birth→mtime in minutes, an **upper
bound only** (`ds()` reuses one log name per slug across slices and retries, e.g.
`n-pdf-read-exec` 840) · `verify` = shell calls running `bun test|tsc|biome|bun run
typecheck/lint/check` · `full` = whole-suite runs (`bun test` with no path/filter, or
`bun run check`) · `killed124` = shell calls killed at their timeout (`exit=124`) ·
`sleeps`/`sleepS` = `sleep N` used as a standalone foreground wait, with the seconds ·
`polls` = `shell_output` calls · `dupCmd` = byte-identical shell commands repeated ·
`dupRead` = the identical file range read again · `reRead` = a read of a file already
read in the run (any range) · `rewrite` = `fs_write` to an already-written path ·
`maxEdit1f` = edits on the most-edited file · `e400/eConn/eOther` = `[error]` lines ·
`badName` = a call to a non-existent tool name · `badArgs` = `invalid (JSON)
arguments` results · `unknownTool` = `unknown tool` results · `editMiss` =
`old_string not found/not unique` · `resets` = `context_reset` calls · `agentsMd` =
AGENTS.md re-reads · `catWhole` = `cat` of a whole `.ts/.tsx/.md` · `afterEdit` =
calls after the first source edit.

Output (`bun mine.ts …/runs`: top 25 by calls + totals):

| run | date | calls | minUB | verify | full | killed124 | sleeps | sleepS | polls | dupCmd | dupRead | reRead | rewrite | maxEdit1f | e400 | eConn | eOther | badName | badArgs | unknownTool | editMiss | resets | agentsMd | catWhole | afterEdit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exec-detached-relay-lifecycle-fix1 | 10-31 | 675 | 65 | 40 | 0 | 0 | 0 | 0 | 0 | 1 | 5 | 65 | 8 | 184 | 0 | 0 | 0 | 1 | 393 | 371 | 0 | 0 | 2 | 1 | 641 |
| n-session-auto-accept-exec | 11-15 | 628 | 140 | 159 | 8 | 1 | 7 | 912 | 8 | 16 | 0 | 81 | 1 | 16 | 0 | 0 | 0 | 0 | 1 | 0 | 11 | 0 | 0 | 0 | 599 |
| n-mobile-session-view-12c-exec | 11-14 | 584 | 235 | 89 | 2 | 44 | 93 | 11999 | 14 | 71 | 0 | 12 | 2 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 463 |
| n-mobile-compose-13d-exec | 11-14 | 568 | 215 | 135 | 2 | 2 | 36 | 8005 | 0 | 10 | 0 | 12 | 5 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 483 |
| n-mobile-live-activity-exec | 11-15 | 559 | 155 | 203 | 5 | 2 | 9 | 1080 | 11 | 6 | 0 | 52 | 0 | 8 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 0 | 0 | 3 | 487 |
| exec-tui-light-theme | 11-06 | 552 | 76 | 184 | 0 | 1 | 3 | 250 | 11 | 11 | 0 | 26 | 5 | 17 | 0 | 0 | 0 | 2 | 0 | 2 | 6 | 0 | 0 | 10 | 411 |
| n-mobile-pairing-core-exec | 11-14 | 536 | 159 | 102 | 2 | 1 | 38 | 3280 | 1 | 3 | 0 | 22 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 465 |
| n-mobile-notifications-exec | 11-15 | 520 | 56 | 176 | 3 | 3 | 4 | 440 | 7 | 6 | 0 | 45 | 4 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 3 | 459 |
| n-pdf-read-exec | 11-17 | 517 | 840 | 73 | 5 | 0 | 0 | 0 | 0 | 5 | 6 | 132 | 0 | 11 | 0 | 0 | 0 | 0 | 2 | 0 | 2 | 2 | 0 | 3 | 381 |
| exec-agent-message-two-way | 11-10 | 511 | 56 | 133 | 6 | 0 | 0 | 0 | 0 | 11 | 0 | 100 | 1 | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 4 | 448 |
| n-session-hop-ux-exec | 11-14 | 504 | 69 | 139 | 4 | 6 | 15 | 2176 | 20 | 10 | 0 | 58 | 0 | 8 | 0 | 0 | 0 | 1 | 0 | 1 | 4 | 0 | 0 | 2 | 448 |
| n-mobile-pairing-camera-exec | 11-14 | 500 | 141 | 63 | 6 | 0 | 39 | 4989 | 21 | 5 | 1 | 35 | 9 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 6 | 373 |
| n-voice-dictation-exec | 11-15 | 487 | 130 | 100 | 5 | 3 | 0 | 0 | 0 | 6 | 0 | 35 | 7 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 404 |
| n-remove-in-process-fix1 | 11-15 | 475 | 123 | 93 | 4 | 1 | 8 | 24 | 0 | 2 | 0 | 64 | 3 | 17 | 0 | 0 | 0 | 1 | 0 | 1 | 4 | 0 | 0 | 1 | 377 |
| n-workload-shell-exec | 11-15 | 466 | 55 | 117 | 2 | 2 | 30 | 2494.2 | 38 | 22 | 0 | 35 | 1 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 404 |
| n-attachments-prompt-exec | 11-12 | 449 | 43 | 98 | 3 | 1 | 4 | 440 | 10 | 8 | 1 | 62 | 3 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 433 |
| n-mobile-hub-exec | 11-16 | 423 | 98 | 61 | 6 | 0 | 3 | 660 | 42 | 1 | 1 | 72 | 1 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | 0 | 2 | 310 |
| n-session-hop-exec | 11-14 | 418 | 594 | 75 | 2 | 3 | 8 | 780 | 20 | 5 | 0 | 40 | 2 | 8 | 0 | 0 | 0 | 0 | 1 | 0 | 5 | 0 | 0 | 1 | 306 |
| exec-autoaccept-wake | 11-10 | 414 | 47 | 61 | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 53 | 21 | 10 | 0 | 0 | 0 | 0 | 19 | 19 | 2 | 0 | 0 | 3 | 328 |
| n-attachments-tui-exec | 11-13 | 413 | 61 | 110 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 64 | 0 | 33 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 342 |
| n-mobile-app-shell-exec | 11-13 | 413 | 96 | 69 | 3 | 0 | 17 | 2086 | 3 | 4 | 3 | 13 | 22 | 7 | 0 | 0 | 0 | 0 | 44 | 0 | 1 | 0 | 0 | 2 | 384 |
| n-mobile-lock-exec | 11-14 | 413 | 47 | 65 | 3 | 0 | 57 | 560 | 28 | 1 | 1 | 16 | 1 | 19 | 0 | 0 | 0 | 1 | 0 | 1 | 2 | 0 | 0 | 2 | 348 |
| n-mobile-push-exec | 11-15 | 409 | 879 | 52 | 2 | 2 | 21 | 1614 | 5 | 5 | 0 | 36 | 5 | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 1 | 260 |
| n-detach-small-fixes-exec | 11-13 | 393 | 93 | 43 | 3 | 3 | 36 | 6967 | 89 | 19 | 0 | 28 | 1 | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 2 | 243 |
| n-mobile-open-at-end-exec | 11-16 | 385 | 61 | 91 | 4 | 1 | 0 | 0 | 0 | 6 | 0 | 66 | 3 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 1 | 0 | 0 | 342 |
| TOTAL (228 runs) |  | 46308 | 27046 | 9221 | 612 | 221 | 908 | 110444.7 | 1510 | 579 | 49 | 5589 | 268 | 2082 | 3 | 0 | 2 | 30 | 819 | 731 | 244 | 8 | 18 | 314 | 32685 |

```
calls median 169 · p90 393 · max 675; runs with >1 full suite: 158; with sleep≥1: 101; with 0 context_reset and >200 calls: 89; share of calls after first source edit: 71%
call mix: read 23313 (50%) · edit 8804 (19%) · verify 9212 (20%) · wait 2298 (5%) · git 1363 (3%) · other 1318 (3%)
```

The 17/11 incidents and the small tasks, taken from `bun mine.ts … --all` (same columns):

| run | date | calls | minUB | verify | full | killed124 | sleeps | sleepS | polls | dupCmd | dupRead | reRead | rewrite | maxEdit1f | e400 | eConn | eOther | badName | badArgs | unknownTool | editMiss | resets | agentsMd | catWhole | afterEdit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| n-main-gate-flakes-exec | 11-17 | 313 | 60 | 51 | 8 | 0 | 5 | 1700 | 43 | 1 | 0 | 52 | 3 | 23 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 1 | 146 |
| n-mobile-step-thought-marker-exec | 11-17 | 171 | 26 | 41 | 3 | 1 | 4 | 800 | 11 | 2 | 1 | 14 | 0 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 120 |
| exec-clear-connect-unbound | 11-10 | 117 | 14 | 15 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 6 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 36 |
| exec-tui-blink-off-width | 10-30 | 103 | 23 | 38 | 3 | 0 | 0 | 0 | 0 | 1 | 0 | 11 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 68 |

(The last two are S tasks graded A− in the scorecard; they serve as baselines.)

Aggregates (`bun agg.ts out-all.txt`):

```
10-30..11-11 : runs 37 · calls 9058 (median 224) · verify cmds 1919 (21%) · full suites 104 (2.8/run) · killed@timeout 20 · sleep 1.3 h in 50 calls · shell_output polls 187 · bad args 747 · unknown tool 706 · edit miss 53 · context_reset 0 · dup cmds 97 · re-reads of an already-read file 1150
11-12..11-17 : runs 191 · calls 37250 (median 163) · verify cmds 7302 (20%) · full suites 508 (2.7/run) · killed@timeout 201 · sleep 29.4 h in 858 calls · shell_output polls 1323 · bad args 72 · unknown tool 25 · edit miss 191 · context_reset 8 · dup cmds 482 · re-reads of an already-read file 4439
exec         : runs 123 · calls 31772 (median 233) · verify cmds 6581 (21%) · full suites 373 (3.0/run) · killed@timeout 173 · sleep 23.2 h in 728 calls · shell_output polls 994 · …
fix rounds   : runs 101 · calls 14159 (median 126) · verify cmds 2598 (18%) · full suites 229 (2.3/run) · killed@timeout 47 · sleep 7.2 h in 173 calls · shell_output polls 490 · bad args 595 · unknown tool 563 · …
conflict     : runs 4 · calls 377 (median 87) · verify cmds 42 (11%) · full suites 10 (2.5/run) · …
cap 150 calls: 137 runs over it · calls above cap 17724 (38% of all)
cap 250 calls: 62 runs over it · calls above cap 8186 (18% of all)
cap 350 calls: 32 runs over it · calls above cap 3594 (8% of all)
top sleepers : n-mobile-session-view-12c-exec 200min/93 sleeps; n-mobile-compose-13d-exec 133min/36 sleeps; n-detach-small-fixes-exec 116min/36 sleeps; n-voice-conversation-exec 88min/22 sleeps; n-mobile-pairing-camera-exec 83min/39 sleeps; n-app-decomposition-exec 58min/18 sleeps
top full     : exec-tui-run-chunked-fix1 17; n-workload-shell-live-exec 12; exec-truncated-reply-2 9; n-session-auto-accept-exec 8; n-main-gate-flakes-exec 8; n-voice-conversation-exec 7
top killed   : n-mobile-session-view-12c-exec 44; n-subagent-error-report-exec 7; n-session-hop-ux-exec 6; n-mobile-compose-13c-exec 6
```

A fact needed below: **the full suite takes 487 s**
(`runs/main-gate-flakes-gate.log`: `Ran 14569 tests across 1039 files. [486.90s]`).
The shell tool's default timeout is **120 s** (`packages/tools/src/builtins.ts:403`).

<details><summary><code>mine.ts</code> (the script; <code>.tentacle/</code> is gitignored, so it is pasted here)</summary>

```ts
// Mine every DeepSeek (tentacle --profile deepseek) run log for token waste.
// usage: bun mine.ts <runs-dir> [--all]   (default: top rows + totals; --all prints every run)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "../orchestration/runs";
const all = process.argv.includes("--all");
const DS_ERA = new Date("2026-10-30T00:00:00").getTime(); // first --profile deepseek run (scorecard)
const KNOWN = new Set(["shell", "shell_output", "shell_kill", "fs_read", "fs_edit", "fs_multi_edit", "fs_write", "context_reset", "agent_task", "agent_control"]);
const isLog = (f: string) => /(-exec\.log|-fix\d*\.log|^conflict-.*\.log|^exec-.*\.log)$/.test(f);
const SCRATCH = /\.tentacle\/tmp|^docs\/|\/docs\/|\.md$|changelog\.d|TODO\.md/;

type Row = Record<string, number | string>;
const rows: Row[] = [];
const ex = { sleeps: [] as string[], repeats: [] as string[], rewrites: [] as string[], fullSuites: [] as string[], bad: [] as string[], errs: [] as string[] };

function fullSuite(cmd: string): boolean {
  // a `bun test` / `bun run test|check` whose argument list has no path/filter = the whole suite
  for (const m of cmd.matchAll(/\bbun (?:run )?(test|check)\b([^|;&)]*)/g)) {
    if (m[1] === "check") return true;
    const args = (m[2] ?? "").replace(/\d?>>?&?\d?\s*\S*/g, "").split(/\s+/).filter((t) => t && !t.startsWith("-") && !/^\d+$/.test(t));
    if (args.length === 0) return true;
  }
  return false;
}

const cat = { read: 0, edit: 0, verify: 0, wait: 0, git: 0, other: 0 };
function categorize(name: string, c: string): keyof typeof cat {
  if (name === "fs_read") return "read";
  if (/^fs_(edit|multi_edit|write)$/.test(name)) return "edit";
  if (name === "shell_output" || /(?:^|;|&&)\s*sleep\s+\d/.test(c)) return "wait";
  if (/\bbun (run )?(test|typecheck|lint|check)\b|\btsc\b|\bbiome\b/.test(c)) return "verify";
  if (/^\s*(cd \S+ && )?git\b/.test(c)) return "git";
  if (/\b(rg|grep|sed -n|cat|head|tail|ls|wc|find)\b/.test(c)) return "read";
  return "other";
}

for (const f of readdirSync(dir).filter(isLog).sort()) {
  const p = join(dir, f);
  const st = statSync(p);
  if (st.mtimeMs < DS_ERA) continue;
  const lines = readFileSync(p, "utf8").split("\n");
  let calls = 0, bad = 0, sleeps = 0, sleepS = 0, polls = 0, full = 0, untailed = 0, resets = 0, agentsMd = 0, catWhole = 0;
  let e400 = 0, eConn = 0, eOther = 0, firstEdit = -1, badArgs = 0, unknownTool = 0, editMiss = 0, killed124 = 0, verify = 0, reRead = 0;
  const filesRead = new Set<string>();
  const cmdSeen = new Map<string, number>(), readSeen = new Map<string, number>(), writes = new Map<string, number>(), edits = new Map<string, number>();
  lines.forEach((ln, i) => {
    const at = `${f}:${i + 1}`;
    if (ln.startsWith("[error]")) {
      if (/status 400|400 Bad request/.test(ln)) e400++;
      else if (/ECONNRESET|connection lost|socket hang up/i.test(ln)) eConn++;
      else eOther++;
      if (ex.errs.length < 40) ex.errs.push(`${at} ${ln.slice(0, 110)}`);
      return;
    }
    if (ln.startsWith("[result:error]")) {
      if (/invalid (JSON )?arguments/.test(ln)) badArgs++;
      else if (/unknown tool/.test(ln)) unknownTool++;
      else if (/old_string (not found|is not unique)/.test(ln)) editMiss++;
      return;
    }
    const m = /^\[tool\] (\S+) ?(.*)$/.exec(ln); // "[tool]  <text>" = a fragment of a multi-line (invalid) argument, not a call
    if (!m) return;
    calls++;
    const name = m[1] ?? "";
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(m[2] ?? "{}"); } catch { /* truncated/corrupt args */ }
    if (!KNOWN.has(name) && !name.startsWith("mcp__")) { bad++; if (ex.bad.length < 30) ex.bad.push(`${at} name=${JSON.stringify(name)} ${String(m[2]).slice(0, 60)}`); }
    if (name === "context_reset") resets++;
    if (name === "shell_output") polls++;
    const path = typeof a.path === "string" ? a.path : "";
    if (/AGENTS\.md$/.test(path)) agentsMd++;
    const fileOf = name === "fs_read" ? path : (/sed -n '?[\d,;p]+'? (\S+)/.exec(String(a.command ?? ""))?.[1] ?? "");
    if (fileOf) { const b = fileOf.replace(/^.*\/worktrees\/[^/]+\//, ""); if (filesRead.has(b)) reRead++; filesRead.add(b); }
    if (name === "fs_read") {
      const k = `${path}@${a.offset ?? 0}+${a.limit ?? "all"}`;
      readSeen.set(k, (readSeen.get(k) ?? 0) + 1);
    }
    if (["fs_write", "fs_edit", "fs_multi_edit"].includes(name)) {
      if (firstEdit < 0 && path && !SCRATCH.test(path)) firstEdit = calls;
      const map = name === "fs_write" ? writes : edits;
      map.set(path, (map.get(path) ?? 0) + 1);
    }
    cat[categorize(name, typeof a.command === "string" ? a.command : "")]++;
    if (name !== "shell" || typeof a.command !== "string") return;
    const c = a.command;
    if (/\bcat\s+AGENTS\.md|AGENTS\.md\b.*\|/.test(c) && !/rg|grep/.test(c)) agentsMd++;
    if (/(^|[;&|]\s*)cat\s+[^|<>]+\.(ts|tsx|md)\s*($|[;&])/.test(c)) catWhole++;
    // a WAIT = `sleep N` as its own foreground statement (not `sleep N &` in a fixture, not `alpine sleep N`)
    for (const s of c.matchAll(/(?:^|;|&&|\n)\s*sleep\s+(\d+(?:\.\d+)?)\s*(?=;|&&|\n|$)/g)) {
      const sec = Number(s[1]);
      sleeps++; sleepS += sec;
      if (sec >= 60) ex.sleeps.push(`${at} sleep ${sec}`);
    }
    if (/\bbun (run )?(test|typecheck|lint|check)\b|\btsc\b|\bbiome\b/.test(c)) verify++;
    if (/^exit=124/.test(lines[i + 1]?.replace(/^\[result:\w+\] /, "") ?? "")) killed124++;
    if (fullSuite(c)) { full++; if (!/\|\s*(tail|head|grep)/.test(c)) untailed++; ex.fullSuites.push(`${at} ${c.slice(0, 90)}`); }
    const sed = /sed -n '?(\d+,\d+)p'? (\S+)/.exec(c);
    if (sed) { const k = `${sed[2]}@${sed[1]}`; readSeen.set(k, (readSeen.get(k) ?? 0) + 1); }
    cmdSeen.set(c, (cmdSeen.get(c) ?? 0) + 1);
  });
  const dupCmd = [...cmdSeen.values()].reduce((s, n) => s + n - 1, 0);
  const dupRead = [...readSeen.values()].reduce((s, n) => s + n - 1, 0);
  const rewrite = [...writes.values()].reduce((s, n) => s + n - 1, 0);
  const [topCmd, topCmdN] = [...cmdSeen.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  const [topEdit, topEditN] = [...edits.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  if (topCmdN >= 4) ex.repeats.push(`${f} ×${topCmdN} ${topCmd.slice(0, 90)}`);
  for (const [w, n] of writes) if (n >= 3) ex.rewrites.push(`${f} fs_write ×${n} ${w}`);
  if (calls === 0) continue;
  rows.push({
    run: f.replace(/\.log$/, "").replace(/^night-/, "n-"), date: new Date(st.mtimeMs).toISOString().slice(5, 10),
    calls, minUB: Math.round((st.mtimeMs - st.birthtimeMs) / 60000), verify, full, untailed, sleeps, sleepS, polls, dupCmd, dupRead, reRead, rewrite,
    killed124, maxEdit1f: topEditN, e400, eConn, eOther, badName: bad, badArgs, unknownTool, editMiss, resets, agentsMd, catWhole, afterEdit: firstEdit < 0 ? 0 : calls - firstEdit,
    _topEdit: topEdit,
  });
}

const cols = ["run", "date", "calls", "minUB", "verify", "full", "killed124", "sleeps", "sleepS", "polls", "dupCmd", "dupRead", "reRead", "rewrite", "maxEdit1f", "e400", "eConn", "eOther", "badName", "badArgs", "unknownTool", "editMiss", "resets", "agentsMd", "catWhole", "afterEdit"];
const md = (r: Row) => `| ${cols.map((c) => r[c]).join(" | ")} |`;
const sorted = [...rows].sort((x, y) => Number(y.calls) - Number(x.calls));
console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`);
for (const r of all ? sorted : sorted.slice(0, 25)) console.log(md(r));
const sum = (c: string) => rows.reduce((s, r) => s + Number(r[c]), 0);
const tot: Row = { run: `TOTAL (${rows.length} runs)`, date: "" };
for (const c of cols.slice(2)) tot[c] = sum(c);
console.log(md(tot));
const q = (c: string, p: number) => { const v = rows.map((r) => Number(r[c])).sort((a, b) => a - b); return v[Math.floor(p * (v.length - 1))]; };
console.log(`\ncalls median ${q("calls", 0.5)} · p90 ${q("calls", 0.9)} · max ${q("calls", 1)}; runs with >1 full suite: ${rows.filter((r) => Number(r.full) > 1).length}; with sleep≥1: ${rows.filter((r) => Number(r.sleeps) > 0).length}; with 0 context_reset and >200 calls: ${rows.filter((r) => Number(r.resets) === 0 && Number(r.calls) > 200).length}; share of calls after first source edit: ${Math.round((100 * sum("afterEdit")) / sum("calls"))}%`);
const nCat = Object.values(cat).reduce((s, n) => s + n, 0);
console.log(`call mix: ${Object.entries(cat).map(([k, n]) => `${k} ${n} (${Math.round((100 * n) / nCat)}%)`).join(" · ")}`);
for (const [k, v] of Object.entries(ex)) {
  const list = k === "sleeps" ? v.sort((a, b) => Number(b.split(" ").pop()) - Number(a.split(" ").pop())) : v;
  console.log(`\n## ${k} (${v.length})\n${list.slice(0, 12).join("\n")}`);
}
```

`agg.ts` parses `out-all.txt` (`mine.ts --all`) and sums the same columns over
date ranges (before and from 11-12), over run kinds (exec / fix / conflict) and over
call caps (150/250/350). It adds no new measurements.

</details>

**Limits of the measurement.** (1) There are no token counts (see the cost model
above). (2) `minUB` overstates wall time. Sleep seconds and `killed124` are the
reliable time figures. (3) A `sleep` inside a `for` loop counts once, so sleep time is
undercounted. (4) `eConn` reads 0 because `ds()` retries an ECONNRESET into the
**same file** (`> $2`, `night-task5.sh:28`), which erases the first attempt. Resets did
happen ("deepseek cut, resuming" appears in the night logs), but the per-run logs
lost them. (5) Scope creep was not mined automatically, because that needs each
plan's file list. It comes from reviews and the scorecard.

### Classification of the waste

The "loop" impression has three sources: long `sleep` + `shell_output` polling
sequences, repeated verify→fix cycles, and long read phases. Tight loops
(identical calls with no state change) are rare **now**. Before 11/11 there was one
real, severe loop: retrying malformed tool calls.

| class | count (228 runs) | share of calls | examples (log:line) |
|---|---|---|---|
| **Over-verification** | 9,221 verify commands (≈40/run); **612 full suites** where the minimum is 228 (1/run), so 384 extra × 487 s ≈ **52 h** of extra suite CPU; 158/228 runs ran >1 full suite | 20% | `exec-tui-run-chunked-fix1` 17 full suites; `n-main-gate-flakes-exec` 8 (TOKEN BUDGET says ≤1); `n-mobile-compose-13d-exec` the same `tsc -p apps/mobile` ×10; `n-attachments-prompt-exec` the same `tsc --noEmit` ×7 |
| **Polling / waiting** | 908 `sleep` waits = **30.7 h** asleep; 1,510 `shell_output` polls; **221 commands killed at the timeout** | 5% of calls; most of the wall time | `night-mobile-step-thought-marker-exec.log:187` full suite in the foreground → `exit=124` at 120 s → `:189` re-run in the background → `:239/:243/:245` `sleep 100/180/240` → `:351` a 2nd full suite → `:371` `sleep 280`. `night-main-gate-flakes-exec.log:341,345,791,793,815` (`sleep 240/200/540/300/420; ps … bun test`). `night-mobile-session-view-12c-exec.log:553–695` iOS e2e build polled with `sleep 110–240` (93 sleeps, 44 kills). The pure-wait idiom `sleep 115; echo ok` ×8 (`night-app-decomp-2-commands`) stays just under the 120 s timeout |
| **Read sprawl** | 23,313 read calls (≈100/run); **5,589** re-reads of a file already read in the run (24% of reads; some are legitimate after an edit); 314 `cat` of whole files | 50% | `n-pdf-read-exec` 132 re-reads; `exec-agent-message-two-way` 100. The brief's "rg first, then `sed -n` line ranges" trades bytes for rounds: it saves result tokens but adds a full-context round per slice |
| **Loop (malformed-call retry)** | 819 `invalid arguments` + 731 `unknown tool` results, **94% of them before 11-12** (747 + 706 in 37 runs; 72 + 25 in 191 runs after) | 3% overall; 58% of one run | `exec-detached-relay-lifecycle-fix1.log:347,360,373…` the same broken `fs_multi_edit` (raw newlines in JSON) retried **393 times** in a 675-call run. Hallucinated tool names: `write_decoy` (`night-app-decomp-0b-structural-exec.log:241`), `kit` (`exec-attachments-core.log:255`), `read`/`write`/`fs_multi_edits` (30 in total). The history-validity / DSML work of 10–11/11 largely cured this |
| **Scope creep** | not mined (see limits); from reviews | — | `night-main-gate-flakes-exec.log:486` `packages/exec/src/host-execution.ts (+45 -3)` (production code in a test-flake task, +143 by the end); the scratch file `measure.ts` rewritten 3× (`:32,:44,:48`); 14 `yes > /dev/null` CPU hogs spawned on the shared machine to reproduce load (`:369`) |
| **Brief ignored / impossible** | 89 runs with >200 calls and **0 `context_reset`**, 8 resets in total despite the brief asking for them; >1 full suite in 158 runs; AGENTS.md re-read 18× (mostly obeyed) | — | Both 17/11 incidents ran **with** the TOKEN BUDGET text: `night-task5.sh` mtime 17/11 11:25 < flakes start 12:13 (`runs/night-main-gate-flakes.log`). Flakes: 8 full suites; step-thought-marker: 3 full suites + 4 sleeps, for a one-line fix. The brief is partly **impossible as written**. `docs/EXECUTOR-BRIEF.md:44` requires `bun run check` (a full suite) and TOKEN BUDGET requires a separate final `bun test`, so obeying both costs ≥2 suites. Nothing in it tells the model that the suite takes 487 s when the default timeout is 120 s, so the first attempt is killed. Nothing forbids sleep-polling. The model also mis-signs its sections: `n-pdf-read-exec` signed "claude-sonnet-4-5-20250929 (tentacle)" (log tail), `exec-attachments-core.log:846` "claude-sonnet-4-5" |
| **Infra errors** | 3× upstream **400** (litellm/vllm, HTML "400 Bad request — Your browser sent an invalid request"), 1× 504, 3× 401 | rare, but each kills a run | `night-mobile-hub-opacity-fix1.log:11` (dead at call 5), `…-fix2.log:47` (dead at call 18), `night-model-artifacts-exec.log:766`; `…-opacity-exec.log:586` 504. `ds()` retries only `ECONNRESET\|model connection lost` (`night-task5.sh:28`), so a 400/5xx ends the round with nothing done. The trigger of the 400 is **unverified**: the request size at the failing round is not logged |

**Where the time and rounds go, in one line:** reads are 50% of calls, verification
20%, edits 19%, waiting 5%. Waiting is cheap in calls but dominant in wall time
(30.7 h asleep plus killed runs). Each extra full suite (≈8 min) also steals CPU from
parallel runs and creates the very flakes that `main-gate-flakes` chased. The sleep
explosion is recent (1.3 h before 11-12, 29.4 h after). It coincides with the suite
outgrowing the 120 s default timeout and with mobile tasks that wait on iOS
simulator builds.

### Proposed fixes

Savings are in rounds (calls) unless stated, and are upper bounds from the counts
above. ★ = cheap; try these first.

**(a) Orchestration (no product change)**

| # | fix | expected saving | cost |
|---|---|---|---|
| A1 ★ | **Brief: no waiting by the model.** "A command that terminates on its own (tests, `tsc`, a build) runs in the **foreground** with `timeout: 900`. `run_in_background` is only for servers/watchers. Never `sleep`; never poll." State the suite time (≈8 min) | ≈2.4k wait rounds (5%) + 221 timeout-kill retries; ≈30 h wall | 3 lines in `ds()`; zero risk |
| A2 ★ | **Gate by script, not by the model.** DeepSeek runs only the *named* test files plus the touched package's typecheck, and **never** runs `bun test` / `bun run check`. After the run, `ds()` runs `bun run check` itself; if red, it starts ONE short fix run with the failing tail (≤40 lines) | the 612 → ≤228 full suites leave the model entirely (≈52 h CPU; ≈1–2k rounds of start/poll/read-tail); fewer cross-run flakes | ≈20 lines in `ds()`; the DS prompt must override `EXECUTOR-BRIEF.md:44` (Q2) |
| A3 ★ | **Watchdog + hard caps.** A tail of the log kills the run on any of: calls > cap (S 150 / M 250), a single `sleep ≥ 60`, a 2nd full suite, the same command ×4, ≥5 `invalid arguments` in a row. A kill leaves partial edits in the worktree, and the existing `RESUME:` prompt continues with a narrower instruction | caps alone bound the tail: a 250-call cap touches 62 runs and 18% of all calls (an upper bound: some of it reappears in the resume) | ≈40-line script next to `ds()`; risk of killing a slice mid-edit (the resume path already exists) |
| A4 | **Read guidance flips to "fewer, bigger reads"** *if* the endpoint does not cache prefixes (Q1): read a file ≤400 lines whole, once; re-read only after editing it | reads are 50% of calls; −20% reads ≈ −10% rounds (a hypothesis, to be measured) | brief text; depends on Q1 |
| A5 ★ | **Infra-error retry.** Treat HTTP 5xx and the proxy's HTML 400 as transient (one retry with the RESUME prompt). Write each attempt to its own log (`$2.try1`) so evidence is kept. Use the right model id: "sign as deepseek-v4.1-flash" | stops 3/228 rounds from dying for nothing; fixes the `eConn = 0` blind spot and the false signatures | ≈5 lines in `ds()` |
| A6 | **Slicing and when NOT to use DeepSeek.** Fix rounds already run at median 126 calls against 233 for execs: give DeepSeek S slices with an explicit file list and acceptance command. **Not** for: flaky-test hunting (needs repeated full suites under load), iOS / simulator e2e (long external waits: the top 5 sleepers are all mobile), live infra, first passes on load-bearing work. Those go to an orchestrator script or Opus | removes the worst tail (the 6 top sleepers alone account for ≈11 h asleep) | routing rule in `model-routing` |

**(b) Tentacle product guardrails (they help every user, not only our orchestration)**

| # | fix | expected saving | cost / blast |
|---|---|---|---|
| B1 ★ | **`shell_output{ wait_s }`**: block until the job exits, new output arrives or `wait_s` passes (capped, e.g. 600). Fix the `shell` description too: today it steers *any* long-running command to the background (`builtins.ts:427`). A terminating command should run in the foreground with a larger `timeout` | the product version of A1: polling becomes one call per job | S · contained (`packages/tools/src/background.ts`, `builtins.ts`) |
| B2 ★ | **Sleep guard in `shell`**: a command whose *first statement* is `sleep N` with N ≥ 30 returns an error with a hint ("use shell_output{wait_s} or a foreground timeout") instead of running | removes the `sleep 115; echo ok` idiom and its kind (908 waits) | S · contained; a false positive costs only one retry |
| B3 | **Repetition / loop detector in the agent loop**: the same normalized tool+args ≥3× in a turn, or ≥3 consecutive invalid-args errors on one tool, injects one harness notice ("you are repeating X — change approach or stop and report"). If it continues, the turn ends with a new stop reason `loop_detected` that forces the final report, like `max_iterations` (`agent.ts:115,1469`) | would have cut the 393-call storm in relay-fix1. Rare today, so it is a safety net | M · **load-bearing** (agent loop) → Opus plan + fresh Review |
| B4 | **Per-run budget with a graceful stop for one-shot runs**: the machinery exists. `maxIterations` (rounds per turn, `agent.ts:1264`, a config key at `config/src/key-docs.ts:510`) and `maxTokens` (whole-conversation token budget that forces the final report, `agent.ts:566–572`, today given **only** to sub-agents). Expose `--max-rounds` / `--max-tokens` for one-shot runs, plus a "budget 75% spent — wrap up" notice | turns A3's kill into a clean final report and handoff | S–M · load-bearing (the budget path is in the loop) |
| B5 ★ | **Usage summary at the end of a one-shot run** (rounds, prompt/completion/cached tokens, wall time, on stderr) | none by itself; **the prerequisite for measuring** A1–A4 in tokens rather than rounds | S · contained (cli) |

Not verified: how the deepseek profile sets `maxIterations`. 675-call runs mean it is
unlimited or very high. Check with `tentacle --profile deepseek config explain
maxIterations` (it needs the user's config, so it was not read here).

### How to measure success

Re-run past small tasks from their base commit with the same plan doc. Use
`mobile-step-thought-marker` (S, one-line fix; baseline 171 calls / 3 full suites /
4 sleeps / 800 s asleep) and `fix/clear-connect-unbound` (S; baseline 117 calls / 2
full suites). Run each **twice** with A1+A2+A5 (and B5 if it has landed), then mine
the logs with the same `mine.ts`. **Pass** means: calls ≤ 60% of baseline, 0 sleeps,
0 model-run full suites, 0 timeout kills, and an Opus diff check that grades it no
worse than the merged version. Only then lift "one DeepSeek task at a time". A3 (caps)
is tuned on the next 5 real runs: count how many were killed and whether the resume
finished them.

### Owner questions

1. **What is the scarce resource with DeepSeek: money per token, an endpoint quota
   or rate limit, or wall time?** Does the endpoint cache prompt prefixes?
   *Recommendation:* tell me what you know. If it bills per token without prefix
   caching, rounds are the cost and A4 (fewer, bigger reads) goes in. If it is quota
   or time, A1/A2/A3 matter most and A4 waits.
2. **Should the gate run by script for DeepSeek runs (A2)?** The DS prompt would
   override `EXECUTOR-BRIEF.md`'s "run `bun run check` before done": the model never
   runs the full suite, the orchestrator does, and it feeds the failures back in one
   fix run. *Recommendation:* yes. It is the largest single lever on wall time and on
   cross-run flakes.
3. **Should a watchdog with hard caps kill runs (A3)?** Proposed caps: S 150 / M 250
   calls; kill on `sleep ≥ 60`, a 2nd full suite, the same command ×4, or 5 invalid
   calls in a row. A killed run is resumed narrower. *Recommendation:* yes, with
   these caps, retuned after 5 runs.
4. **Should DeepSeek be kept off some task kinds (A6)?** Proposed: flake hunting,
   iOS/simulator e2e, live infra, and load-bearing first passes. *Recommendation:*
   yes; those go to scripts or Opus.
5. **Which product guardrails should become tasks now?** *Recommendation:* B1
   (`shell_output` wait + shell description) and B5 (usage summary) now, as two S
   contained tasks. B2 goes with B1. B3/B4 (agent loop, load-bearing) come after the
   measurement in Q6 shows what remains.
6. **Should the measurement run before parallel DeepSeek is lifted?** It means two
   re-runs × two small tasks with the new brief; pass = ≤60% of baseline calls,
   0 sleeps, 0 model-run suites, the same review grade. *Recommendation:* yes, and
   DeepSeek stays one-at-a-time until it passes.

## Implementation

*(empty: an eval; filled only if promoted)*

## Execution

*(empty: an eval)*

## Review

*— claude-opus-5-5, 2026-11-17*

**Verdict: the waste is structural, not a model "going crazy".** Three causes
explain most of it, all with numbers:

1. **Verification run by the model**, at 20% of calls. That includes 612 full suites
   where 228 is the floor. The briefs *require* ≥2 suites, and each suite (487 s)
   exceeds the shell's 120 s default timeout.
2. **Waiting by sleep-polling**: 30.7 h asleep, 2.4k wait rounds, 221 timeout
   kills. It is new since 11-12, as the suite outgrew 120 s and mobile tasks began
   waiting on simulator builds. `shell_output` has no blocking wait, so the model
   sleeps.
3. **Read sprawl**: 50% of calls. 24% of reads re-read a file already read, and
   that is encouraged by the "small `sed -n` slices" rule.

The one real loop, malformed-call retries (393 in one run), was concentrated before
11-12 and is now rare (97 errors in 191 runs). Infra 400s are rare but kill rounds
outright, and `ds()` does not retry them.

**What holds:** the counts come from all 228 DS logs with one script, pasted above.
Every example is cited log:line. **What does not / is unverified:** token cost (no
usage data until B5 lands); real wall time (only an upper bound); the 400's trigger;
the deepseek profile's `maxIterations`; scope creep beyond the reviewed examples.
Recommended order: A1 + A2 + A5 (brief and `ds()` only, same day) → the measurement in
Q6 → B1 + B2 + B5 → A3 tuning → B3/B4 only if the re-runs still show tails.

### Owner answers (2026-11-18)
- **Q1:** DeepSeek costs the owner TIME, not money (free to use) — plus the moral cost of a model looping and wasting energy/resources: efficiency matters for both. Consequence: optimise wall time and wasted calls; prefer one whole read over many slices (fewer round trips) → A4 adopted; A2 (script-run gate) is the top time saver.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-18*
- **Q2–Q6 (owner 2026-11-18 ~11:10): yes to all.** Applied the same day in the orchestration (`night-task5.sh`): A4 reads (≤400 lines whole, once), A1/A2 (DeepSeek never runs the full suite / whole-repo typecheck / lint; the script runs the gate after exec and after each fix round, one DeepSeek gate-fix round on red), A3 watchdog (>250 tool calls, a `sleep` ≥60, ≥2 full `bun test`, the same call ×4 → stop DeepSeek and redo the step with Opus). B1+B2+B5 → `feat/shell-wait-and-usage` (TODO). Q6 measurement before re-opening parallel DeepSeek.
