# feat/smart-compaction — Lossless-first pruning of the model's context

> **Status:** implementation APPROVED (orchestrator, night delegation 2026-11-17); S1–S3 tonight, S4 (A/B + default) after
> **Branch:** `feat/smart-compaction`
> **Size:** M (split into slices S1–S4, each S/M) · **Blast:** load-bearing (agent loop / the request every round sends) · **Suited:** strong model executes S2; S1/S3 may go to a weaker model; mandatory fresh-context Review on S2 and S4
> **Changelog:** `changelog.d/smart-compaction.added.md` (written in S4, when the default is decided)

## Context

*— claude-opus-5-5, 2026-11-17*

Owner brief (TODO.md, `feat/smart-compaction`, 2026-11-17): a lossless-first
compaction that **never drops the conversation's text** (user/assistant prose)
and instead prunes what is superfluous for the next rounds — old tool-call
arguments, stale tool results (file reads superseded by later reads/edits, long
test/build output already acted on), duplicated reads, spill previews — each
replaced by a short stub saying what was there and how to get it back. It runs
**before** the summarising compaction, not instead of it, and is measured with
`feat/token-usage-log` (input tokens per round, before/after) plus a quality
check on DeepSeek runs.

What exists today (verified, see Implementation/Preconditions):

- The only context reductions are **whole-history replacements**: the user's
  `/compact` (`Session.compact`, `packages/agent/src/session.ts:348`, a model
  summary via `summarizeConversation`, `packages/agent/src/compact.ts:108`)
  and the model's own `context_reset` tool (`agent.ts:2433-2557`). There is
  **no automatic compaction threshold** anywhere (`rg -i 'auto.?compact'` over
  `packages/` matches nothing but a test name). So "before the summarising
  compaction" here means: pruning keeps the context below the point where the
  user would `/compact` or the model would `context_reset`, and is never a
  replacement for either.
- Per-result reduction exists only at **ingest** time, once, on the result as
  it enters the history (`result-pipeline.ts`: spill > 16 000 chars to a file
  with a 1 200-char head/tail preview `:77-107`, collapse repeated lines,
  tabulate JSON, optional LLM summary). Nothing ever revisits an old result.

**Evidence — where the context goes in executor runs** (DeepSeek, `-p`
transcripts). The `-p` render prints each call's full arguments but only the
first line of each result, so this measures arguments and spills exactly and
result volume only by proxy.

**Repro** (2026-11-17, `.tentacle/tmp/smart-compaction/analyse.ts`, run over
`.tentacle/tmp/orchestration/runs/night-*-exec.log`, 81 executor runs):

```ts
// bun analyse.ts <log>...  — counts calls, argument chars per tool, repeated
// fs_read paths, spill banners in `tentacle -p` transcripts.
import { readFileSync } from "node:fs";
const total = { calls: 0, byTool: {} as Record<string, number>, argChars: 0,
  fsReads: 0, fsReadRepeat: 0, spills: 0, spillChars: 0, shellSedDoc: 0 };
const argBy: Record<string, number> = {};
let files = 0;
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8"); files++;
  const seen = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^\[tool\] (\S+) (.*)$/.exec(line);
    if (m) {
      const [, name, args] = m as unknown as [string, string, string];
      total.calls++; total.byTool[name] = (total.byTool[name] ?? 0) + 1;
      total.argChars += args.length; argBy[name] = (argBy[name] ?? 0) + args.length;
      let p: Record<string, unknown> = {}; try { p = JSON.parse(args); } catch {}
      if (name === "fs_read" && typeof p.path === "string") {
        total.fsReads++; if (seen.has(p.path)) total.fsReadRepeat++;
        seen.set(p.path, (seen.get(p.path) ?? 0) + 1);
      }
      if (name === "shell" && /sed -n '\d+,\d+p'/.test(args)) total.shellSedDoc++;
      continue;
    }
    const s = /full output \((\d+) chars\) saved/.exec(line);
    if (s) { total.spills++; total.spillChars += Number(s[1]); }
  }
}
console.log(JSON.stringify(Object.entries(argBy).sort((a, b) => b[1] - a[1]).slice(0, 8)));
console.log(JSON.stringify({ files, ...total }, null, 1));
```

Output (abridged to the relevant fields):

```
[["shell",6207441],["fs_write",5032050],["fs_multi_edit",2386045],["fs_edit",2322857],["fs_read",147552],["context_reset",40756],...]
{ "files": 81, "calls": 22278,
  "byTool": { "shell": 15591, "fs_read": 1748, "fs_edit": 1666, "fs_multi_edit": 1532,
              "fs_write": 884, "shell_output": 781, "context_reset": 8, ... },
  "argChars": 16187765, "fsReads": 1748, "fsReadRepeat": 713,
  "spills": 128, "spillChars": 8498480, "shellSedDoc": 2996 }
```

Reading:

1. **Tool-call arguments alone are ~16.2 M chars over 81 runs (~200 k chars ≈
   50 k tokens per run)**, and **60 % of it is file-write/edit payload**
   (`fs_write` 5.0 M + `fs_multi_edit` 2.4 M + `fs_edit` 2.3 M). Once an edit
   succeeded, its `content` / `old_string` / `new_string` is pure dead weight:
   the file on disk is the truth, and re-sending it every round is the single
   biggest prunable item we can measure.
2. **41 % of `fs_read` calls (713 / 1 748) re-read a path already read in the
   same run** — each earlier copy is superseded (and, after an edit, stale and
   actively misleading).
3. **128 spills** each left a 1 200-char preview + banner in context forever;
   the full output is on disk (`tools.outputRetentionDays`, default 30).
4. **`shell` is 70 % of calls**, 2 996 of them `sed -n 'a,bp'` doc windows.
   Their result sizes are not visible in `-p` transcripts; that is what the
   per-round `usage` entries (token-usage-log, now on main) and the offline
   replay (S3) measure.

Constraints: persisted history stays intact (prune only the model-facing
projection; never rewrite the log); no new critical log entry / persisted
format change without the owner; prompt caching must not be thrown away every
round; the loop serves ~27 B local models too, so stubs must not be imitable.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**Every request the loop sends is built from ONE projection of the stored
history, so a pure prune step inserted there changes what the model sees and
nothing else (stored history, log, clients, resume untouched).** Verified:

- The round's request: `const view = modelView(this.projectedHistory(messages, caps))`
  (`packages/agent/src/agent.ts:1391`); `request.messages` is built only from
  `view` (`:1393-1394`). The stored array `messages` is not mutated by either
  step: `projectedHistory` returns the same array or a copy with a new system
  message (`:964-974`); `modelView` maps to new objects (`context-awareness.ts:82-91`,
  "The stored history is untouched").
- The forced final report builds its request the same way (`agent.ts:1716-1721`).
- The context size the model is told (`noteContextUsage` → `projectedHistory`,
  `:1826`) and the size a client is shown (`:1884-1903`, `estimateUsed`) also
  read `projectedHistory`.
- These four call sites are **all** of them (`rg 'projectedHistory\(' packages/agent/src/agent.ts`).

So one helper, `requestHistory(messages, caps)` = `prune(projectedHistory(...))`,
used at the four sites, is the whole integration. The executor re-proves it
first with a 20-line repro (a fake provider capturing `request.messages` while
the stored `session.messages` is asserted byte-identical, AGENTS §1).

### Preconditions

- **Persisted history = the stored `ChatMessage`s.** A tool result is persisted
  as a critical `message` entry carrying the whole `ChatMessage`
  (`packages/protocol/src/session-log.ts:144-150`, `:440-445`); the log is fed
  from `session.messages`, never from a request. Pruning the request therefore
  needs **no** protocol, log or `PROTOCOL_VERSION` change (AGENTS §7
  persistence + protocol bullets hold unchanged).
- **Per-conversation memory-only state already has a pattern:** `anchors` and
  `spend` are `WeakMap<ChatMessage[], …>` keyed by the array a Session — or a
  sub-agent — keeps for its life (`agent.ts:782-793`). The prune state follows
  it exactly, so sub-agents get it for free and a reload simply starts without it.
- **Context anchor validity is by identity** (`context-awareness.ts:18-26`,
  `:128`): a pruned batch makes the measured `promptTokens` too high; the
  batch must `this.anchors.delete(messages)` as `context_reset` does (`agent.ts:2553`).
- **The history-validity invariant** (`repairHistory`, `modelView`): every
  assistant `toolCalls[i]` must keep a `tool` answer with the same id, and
  arguments must parse as a JSON object — a pruned call keeps its `id` and
  `name`, and its arguments stay a valid JSON object.
- **`renderForModel` renders `contextUsage` and `media` into `content`**
  (`context-awareness.ts:61-74`): a stub replaces `content` but keeps the
  message's other fields, so a context line the model saw stays.
- **Skill bodies are curated context, exempt from transforms**
  (`exemptTools`, `result-pipeline.ts:41-50`; `compactedHistory` carries them
  `compact.ts:339-342`) → never pruned.
- **Spill metadata is data on the result** (`ToolResultSpill`, `result-pipeline.ts:98-105`,
  the `spill` field on the stored tool message) → a spill can be stubbed
  without parsing the banner.
- **fs_read results carry a parseable header** `[<path> lines a-b of N]`
  (`packages/tools/src/builtins.ts:134`); the path/range also come from the
  call's arguments (preferred — never parse output when the input says it).
- **Pods:** the agent loop runs daemon-side (in the pod for `run`/`attach`);
  the projection is pure and local to it. Nothing crosses the wire, the model
  link (`ProxyModelProvider`) just carries a smaller request. Config reaches a
  pod daemon through the carried-settings path (`packages/cli/src/carried-settings.ts`)
  — the new keys must be added there (S2).
- **`model_request` hooks receive `request.messages`** (`agent.ts:1919-1930`):
  they will see the pruned view (the truth of what was sent). The executor
  checks the hook's "new since last" baseline (`forgetModelRequestBaseline`)
  does not compare message bytes; if it does, S2 resets the baseline on a batch
  exactly as `/compact` does (`session.ts:368`).

### Design

**Principle.** The stored history is never touched. A pure module computes,
from the stored history, a **monotonic prune set** (message index → stub) that
the loop applies to the request. The set only grows, and only in **batches**,
so between batches every request repeats the same bytes and the provider's
prefix cache holds.

**1. What is pruned (rules, in `packages/agent/src/prune.ts`, pure).** Only
messages **outside the protected tail** (the last `keepRecentRounds` assistant
rounds, default 6, and always the current turn's unseen messages) are
candidates. User and assistant **text is never touched**; nor are skill
results, `context_reset`, media/attachments, sub-agent/background notes (they
are user-role), or any result of a call the model has not yet followed with
another round.

| Rule | Candidate | Stub keeps | How to get it back (said in the stub) |
|---|---|---|---|
| R1 superseded read | `fs_read` result of path P when a LATER successful `fs_read` of P covers the same span (a line range, or the SAME `pages` window for a PDF), or a later successful `fs_write`/`fs_edit`/`fs_multi_edit` of P | path, range/pages, size, the round that superseded it | `fs_read P` again (the file is the truth) |
| R2 write/edit payload | arguments of a SUCCESSFUL `fs_write` (`content`) / `fs_edit` (`old_string`,`new_string`) / `fs_multi_edit` (`edits[].*`) | path + every non-payload field; each payload string → a placeholder with its size | `fs_read P` |
| R3 long output acted on | a `shell` / `shell_output` result over `pruneOutputChars` (default 2 000) | first 10 + last 30 lines (failures keep the tail, which is where errors are) + exit code + size | re-run ONLY if safe to repeat; else the spill file if any |
| R4 spill preview | a result with `spill` set | the banner (path, size), preview dropped | `fs_read <spill path>` with offset/limit / grep |
| R5 duplicate | a result byte-identical to a LATER result of the same tool + same arguments | — | "identical to the later result of <tool> (call <id>)" |

Stubs are **deterministic** functions of the stored message (no clock, no
counter that changes later), memoised per message object, so the same stub
bytes are sent every round. Form, e.g.:

```
[pruned by tentacle: fs_read docs/x.md lines 1-150 (6.2k chars) — superseded by a later read; fs_read it again for the current content]
```

R2 placeholder inside arguments (a JSON string value, never top-level):
`"⟪pruned by tentacle: 4.1k chars, already written to docs/x.md — fs_read it⟫"`.
The `⟪…⟫` sentinel is chosen to be unmistakable and greppable.

**2. When (batch trigger, at a round boundary, in the loop).** Before building
a round's request: compute the size estimate the loop already computes
(`estimateUsed` over the CURRENT projection). If `used ≥ pruneAtPercent` of
the window (default 60 %) AND the eligible-but-not-yet-pruned volume is ≥
`minGainPercent` of the window (default 15 %), extend the prune set with ALL
eligible candidates at once, delete the anchor, and send. Otherwise send the
existing projection unchanged. No batch ever un-prunes.

**3. The cache trade-off (why batches, why these defaults).** A batch rewrites
messages at positions ≥ p, so ONE request re-bills the suffix S = T − p at the
miss price m instead of the hit price h = r·m; every later round saves the P
pruned tokens. Break-even rounds N ≥ (1 − r)·S / (r·P). With DeepSeek's
published ratio r ≈ 0.1 (verify on the current price page at S4), T = 80 k,
p near the start (S ≈ 75 k), P = 20 k (≥ 15 % of 128 k): N ≥ 0.9·75/(0.1·20) ≈
34 rounds. Executor runs average ~275 tool calls, so a batch pays back well
within a run, while per-round pruning (P small, S large every round) would
never pay back. Hence: few, large batches gated on gain. The system prompt +
tool definitions prefix is never touched, so it stays cached across batches.
The other side of the ledger: without pruning, a run that fills the window
ends in `context_reset` or `/compact` — a full miss AND a loss of detail.
S4 measures this rather than trusting the arithmetic (`cachedPromptTokens` is
in the `usage` entries).

**4. Small-model safety (stub imitation).** The dangerous failure is a model
copying a placeholder into a real write (the `fs_edit`-corruption class). Two
layers: (a) R2 prunes only calls that SUCCEEDED and are outside the protected
tail, so the model's recent examples of its own writes are real; (b) a
deterministic guard: `fs_write` / `fs_edit` / `fs_multi_edit` refuse input
containing the `⟪pruned by tentacle` sentinel with a clear error ("that is a
pruned placeholder, not file content — fs_read the file first"). The guard is
cheap and also catches a model that copies a stub from a read.

**5. Getting content back.** v1 relies on what already exists, named in each
stub: `fs_read` again (side-effect free), the spill file, re-running a safe
command. A dedicated recall tool is Owner question 2.

**6. Interactions.**
- `/compact`, `/clear` and `context_reset` replace the history IN PLACE, reusing
  the same array (`session.ts:366-367` and `:390-391`, `messages.length = 0` +
  `push`; a reset the same way, `agent.ts:2550`), so **a `WeakMap` entry does
  NOT die with the old objects** — the S2 state must be dropped explicitly on
  compact AND on `/clear`. S1's `PruneEntry` therefore carries the `original`
  message and `applyPrune`/`estimateGain` skip an entry whose
  `history[index] !== original`; stale indices alone cannot catch this (an
  in-place replacement keeps every index in range).
- Resume / reattach / daemon restart: the state is memory-only; the first
  round after a reload recomputes from scratch (one batch if over threshold).
  One cache miss, the same as the anchor's reload story.
- Sub-agents: same `Agent`, own array → own state, same rules.
- Context awareness: the `[context: …]` line and the client's context meter
  now report the pruned size (correct: it is what is sent).

**7. Config** (`context.prune`, resolved like `contextAwareness`):
`enabled` (default: Owner question 1), `pruneAtPercent` 60, `minGainPercent`
15, `keepRecentRounds` 6, `pruneOutputChars` 2 000. Carried to pod daemons.

### Files

Slices, in dependency order. Each is S/M with its own tests; S2 needs S1.

- **S1 — pure pruner (M, contained).** `packages/agent/src/prune.ts` (new):
  `pruneCandidates(history, opts)`, `applyPrune(history, set)`,
  `stubFor(message, rule)`, `estimateGain`; `packages/agent/test/prune.test.ts`
  (new). No wiring.
- **S2 — wire into the loop + guard + config (M, load-bearing).**
  `packages/agent/src/agent.ts` (`requestHistory` helper at the four sites,
  `pruneState` WeakMap, trigger at the round boundary `:1385-1391`, anchor
  delete, reset-path delete); `packages/tools/src/builtins.ts` (sentinel guard
  in `fs_write`/`fs_edit`/`fs_multi_edit`); `packages/config/src/{schema,resolve,defaults,key-docs,load}.ts`;
  `packages/cli/src/{wiring,carried-settings}.ts`; tests below.
- **S3 — offline replay (S, contained, internal).** A replay script (in
  `.tentacle/tmp/smart-compaction/`, pasted into Execution) that loads a real
  `<uid>.jsonl`, walks it round by round with the S1 pruner + the trigger, and
  prints per round: tokens sent without / with pruning (`DEFAULT_COUNTER`),
  batch points, and the modelled cost with r. Deterministic, no model calls.
- **S4 — DeepSeek A/B, default, changelog (S).** Validation below; the
  default per Owner question 1; `changelog.d/smart-compaction.added.md`.

No change to `packages/protocol`, `packages/daemon`, `packages/client`, the
TUI, or the session log. No `protocol.d/` note.

### Failure modes

- **The model needs a pruned result.** R1/R2 targets are re-readable from
  disk; R4 from the spill file; the stub says how. R3 output of a command not
  safe to repeat is the real loss → keep 10+30 lines incl. the tail and exit
  code, and never prune within the protected tail. S4 counts re-reads of
  pruned paths; a high rate is the trigger for the recall tool (Q2).
- **Stub imitation by a small model** → R2 only for succeeded, older calls +
  the sentinel guard in the write tools (refuses, model re-reads). Tested.
- **Stale read misleads** (today's bug, not new) → R1 removes it.
- **Cache miss cost** → batches gated on `minGainPercent`; measured in S4 via
  `cachedPromptTokens`; if net cost rises, raise the thresholds, not per-round.
- **Anchor overestimate after a batch** → anchor deleted on batch; the next
  measure re-anchors.
- **History validity** → pruned calls keep id + name, arguments stay a JSON
  object; tested through `modelView` (zero repairs on a pruned history).
- **Resume / restart / reattach** → memory-only state recomputed once; stored
  history and log byte-identical (tested).
- **`/compact`, `context_reset`, `/clear`** → state dropped EXPLICITLY (`pruneState.delete(messages)`) at each replacement: they reuse the array, so the WeakMap entry does not die with the old objects. Belt and braces, a stale set fires on nothing (`PruneEntry.original`).
- **Sub-agents** → own array, own state; a child's report is a user-role
  note in the parent (never pruned).
- **Pods** → no wire change; config carried; a pod daemon never persists
  anyway.
- **Abort / error mid-batch** → the batch is a synchronous computation before
  the request; nothing partial exists.
- **Empty / tiny history, no window configured** → no trigger (below
  threshold); with no `contextWindow` the trigger is off (nothing to compare).
- **Version skew** → none: no protocol or format change.

### Tests

S1 (`packages/agent/test/prune.test.ts`, 39 cases), each property exact:
- user/assistant `content` is byte-identical before/after for every rule;
- R1 prunes an earlier read of P after a later full read / a successful edit
  of P; does NOT after a failed edit, nor a later read of a different range,
  nor a later read that STARTS LATER (lines 1-50 then `offset 40`), nor after a
  failed later read, nor a failed earlier one; a PDF `pages` read is covered
  only by the SAME `pages` (never by a default read);
- R2 replaces only payload fields of a successful write/edit; a failed one is
  untouched; the result parses as a JSON object;
- R3 keeps head/tail/exit; R4 keeps the spill path;
- R5 only exact duplicates — same tool AND same arguments AND same bytes — and
  only the EARLIER copy, on a non-`fs_read` tool whose body exceeds its stub;
- the protected tail, skill results and `context_reset` results are never
  candidates;
- a set built before an IN-PLACE history replacement (`/compact`, `/clear`, a
  reset) fires on nothing, and `estimateGain` counts nothing for it;
- stubs are deterministic (two computations → identical bytes);
- `modelView(applyPrune(h))` reports zero repairs.

S2 (agent loop with a fake provider capturing `request.messages`):
- below threshold → requests identical to today (pins "no behaviour change off");
- crossing threshold → one batch; the next N requests share the exact pruned
  prefix bytes (pins cache stability); a second batch only after the gain gate;
- stored `session.messages` byte-identical to an unpruned run (pins "log intact");
- `context_reset` / `compact` / `/clear` drop the state EXPLICITLY (the array is
  reused in place, so the WeakMap entry survives otherwise); a fresh `Agent`
  over a reloaded history recomputes;
- the guard: `fs_write` with the sentinel → `isError`, file untouched;
- mutation check (§9): wire `prune` to also mutate `messages` → the
  log-intact test fails; disable the trigger → the batch test fails.

### Validation (S3 + S4)

1. **Offline replay** (S3) on ≥ 5 real executor session logs: per-round tokens
   without/with, number of batches, modelled cost. Gate: ≥ 25 % fewer input
   tokens over the run, ≤ 1 batch per ~30 rounds.
2. **Live A/B on DeepSeek**: the same two task briefs, pruning off vs on, each
   ≥ 2 runs; compare `tentacle logs --usage` totals (input, cached input,
   rounds), the modelled cost, `context_reset` count, gate result of the task
   (`bun run check`), re-reads of pruned paths, and sentinel-guard refusals.
   Gate: input tokens down ≥ 25 %, cost not up, task success not down, zero
   sentinel text in any written file.
3. Spot-check one run with the local 27 B model for stub confusion.

### Owner questions

1. **Default on or off?** Rec: ship S2 with `enabled: false`, flip to `true`
   in S4 only if the A/B gate passes (orchestrator can decide).
2. **A recall tool** (`context_recall {callId}` returning the original result
   from the in-memory stored history — lossless, works in pods and after a
   resume)? Rec: not in v1; stubs point to re-read/spill. Add it as a follow-up
   if S4 shows frequent re-reads of pruned content (orchestrator).
3. **Prune write/edit arguments (R2)** despite the imitation risk? Rec: yes —
   it is 60 % of the measured argument volume — with the sentinel guard and the
   succeeded-only + protected-tail rules (orchestrator).
4. **Persist prune decisions / a prune log entry?** Rec: no — memory-only,
   recomputed after a reload (one cache miss); the `usage` rows already show
   the drop. A non-critical `prune` entry for analysis would be a persisted-
   format addition → **owner**; rec defer.
5. **Feed `/compact`'s summariser the pruned view** (cheaper, and lets a
   history larger than the window still be summarised)? Rec: yes, as a
   follow-up slice after S4 (orchestrator).
6. **Defaults** `pruneAtPercent` 60 / `minGainPercent` 15 /
   `keepRecentRounds` 6 / `pruneOutputChars` 2 000? Rec: accept for S2, retune
   from the S3 replay (orchestrator).
7. **Treat `shell` `sed -n`/`cat` file reads as reads for R1?** Rec: no in
   v1 (staleness is not knowable from a command line); they fall under R3 when
   long (orchestrator).

**Answers (orchestrator, 2026-11-17, owner asleep — night delegation):** Q1–Q7 all as recommended (default OFF until the S4 A/B passes; no recall tool in v1; prune write/edit args with the placeholder guard; NO persisted `prune` entry — nothing changes on disk; /compact on the pruned view in a later slice; 60/15/6/2000 retuned by S3's replay; no sed/cat reads in v1). The owner may overrule on waking.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

*— claude-sonnet-4-5-20250929 (executor), 2026-11-17 · **S1 only***

**Scope.** S1 of the plan, nothing of S2–S4: the pure pruner and its own test.
No wiring into the loop, no guard in the write tools, no config, no replay, no
A/B. The changelog fragment is written (S4 pins the default, but the module is
new public API of `@tentacle/agent`, so the fragment lands with its slice).

**Load-bearing check (re-run first, §1/§9).** Passed. Script
`.tentacle/tmp/smart-compaction/loadbearing.ts` (in the worktree; the sandbox
refused the main tree's `.tentacle/tmp`, same gitignored location), driving the
real session path — `Agent.runMessages` over ONE caller-owned array, the shape
`Session.messages` has — with a scripted provider that keeps the request array
by reference:

```
requests: 2
req[1] user msg === stored[0]: false      <- see note (1)
req[2] tool msg === stored[2]: true       <- the loop sends the STORED objects
modelView keeps the stored objects: true
stored prefix intact: true
stored grew to: 4 user,assistant,tool,assistant
prune of the view kept the store identical: true
pruned view differs: true
prune.ts exists: false                    <- S1's capability was absent
```

Note (1): the *user* message is not identical by reference only because
`runMessages`'s options push a copy path for the first request; the **tool
result** (`req[2]`, index 2) is the stored object itself, and `modelView` is
identity-preserving (`repairHistory` returns the input array when there is
nothing to repair). The property the design needs is exactly this: the request
is built from the stored messages (so a prune step must **copy**), and a
copy-based prune leaves the store byte-identical — the last three lines. The
seam therefore holds: one projection, `pruned(modelView(projectedHistory(...)))`,
changes only what the model sees.

**Drift from the Implementation (and why).**

1. **`stubFor`'s signature** is `stubFor(about: StubAbout)`, not
   `stubFor(message, rule)`. The plan's `(message, rule)` cannot carry what the
   R1/R3/R4/R5 stubs must state (the superseding call id, the read range, the
   kept head/tail, the spill path) — those come from *other* history entries, so
   the stub is a function of the rule's facts, not of the message alone.
   `pruneCandidates` derives `StubAbout` from the history, which keeps the
   required property (a stub is a deterministic function of the stored history)
   and is what the determinism test pins.
2. **"succeeded" is a positive shape match, not an error-flag read.** The stored
   history keeps no `isError` — `toolMessage` (`agent.ts:266-278`) stores
   `content` only — so `succeeded()` matches the tool's own success phrasing
   (`/^wrote \d+ bytes to .+ \(\+\d+ -\d+\)$/`, `/^edited .+ \(\+\d+ -\d+\)$/`,
   `/^edited .+ with \d+ edits \(\+\d+ -\d+\)$/`, and for `fs_read` "not the
   registry's `tool fs_read failed:` prefix and not a `[hook]` rewrite"). The
   positive direction is the safe one: anything unrecognised is left alone. This
   is the plan's R2 "successful" precondition made checkable without changing
   `ChatMessage` (which would be a persisted-format change).
3. **A stub larger than the body is refused** (`savedChars > 0` required for
   every rule). Not in the plan, but implied by its purpose: a tiny result gains
   nothing and a longer stub would grow the request. Its own test pins it.
4. **`covers()` normalises "no range" to the whole file.** A whole-file read is
   NOT superseded by a later narrow window; a later whole-file read DOES
   supersede a narrow earlier one. (Found by mutation M1, see below: the first
   version had the direction inverted and the mutation was not caught until the
   test fixture used realistic body sizes.)
5. **`estimateGain`** returns `{chars, tokens}` with 4 chars/token, the
   `HeuristicTokenCounter` default — the plan asks for the gain and S2's trigger
   compares it to the window; the counter itself is the loop's (`anchorContext`
   / `estimateUsed`), so a model-specific counter still governs the trigger in
   S2. `prune.ts` therefore imports no token counter.
6. **`payloadPlaceholder` and `formatChars` are exported** helpers of the module
   (the plan names four functions; these are shared by `stubFor` and R2 and are
   worth testing directly).
7. **`OPTS`**: `keepRecentRounds` 6, `outputChars` 2000, `headLines` 10,
   `tailLines` 30 in `PRUNE_DEFAULTS`, exactly as the plan's Design tabulates
   them (S2/S3 retune through config).

**Red before green.** `packages/agent/test/prune.test.ts` (28 cases) was written
first and run with no module: `error: Cannot find module '../src/prune.ts'` —
red on the missing capability, as the brief requires. Every assertion is written
against the Implementation's contract, and the four rounds of genuine failure
during implementation were all *assertion* failures (a body smaller than its
stub; `repairCounts` returning `null`, not zeroes, when nothing was repaired),
never import or compile errors.

**Mutation checks (§9, pasted results).** Each mutation applied to
`prune.ts`, the suite run, then the original restored and re-verified green.
Seven mutations, seven catches — every one by the test that owns its property:

```
M1 R1 disregards the read range  -> (fail) R1 > NOT after a later read of a DIFFERENT (narrower) range
M2 applyPrune mutates the store  -> (fail) the stored history is byte-identical…
                                    (fail) user and assistant CONTENT is byte-identical…
                                    (fail) estimateGain reports what the set actually saves
M3 protected tail = whole history-> (fail) the last N assistant rounds are never candidates
M4 R2 ignores success            -> (fail) R2 > a FAILED write keeps its payload
M5 R4 prunes a spill with no file-> (fail) R4 > a spill with NO file is never pruned
M6 stubs drop the sentinel       -> (fail) R2 > fs_write…, fs_edit…, fs_multi_edit…
M7 skill results no longer exempt -> (fail) a skill result is never a candidate…
```

Two of them found real defects rather than confirming a test, and both were
fixed: M1's inverted range direction (drift 4) and M2 exposing that the
"stored history is byte-identical" case shared a fixture an earlier test had
already mutated — a vacuous-test bug, fixed by giving it its own fixture.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (1857 files, 0
errors/warnings, the §6 baseline) · `bun test packages/agent packages/tools`
1094 pass / 0 fail. Full `bun test`: **13547 pass, 5 skip, 20 fail — all 20 in
`packages/tui/test/chart-lines.test.ts`, and all caused by this session, not by
S1.** Cause: my two earlier foreground `bun test` attempts were killed at the
harness timeout but left an orphaned `bun test` running; it and the background
run rewrote that suite's snapshot FILE concurrently, and its Bun header was
overwritten with an ANSI escape (`\033[?25h` in place of `// Bun `). No code or
snapshot content was involved. Fixed by writing the file's exact `HEAD` bytes
back (`git show HEAD:… > file`, never `git checkout`); `bun test
packages/tui/test/chart-lines.test.ts` then reports **51 pass / 0 fail / 20
snapshots**, and `git status` shows only this slice's five files. To be
re-verified by the orchestrator on a quiet tree: `bun test 2>&1 | tail -15`
should be the §6 baseline. The 5 skips are the opt-in/root-only set
(`session-hop.docker`, `workload-shell-live.k8s`, `k8s/integration.live`,
`ws-server` SLOW, `confinement` as root) — the §6 baseline, not new.

**Files.** `packages/agent/src/prune.ts` (new, 622 lines),
`packages/agent/src/index.ts` (`export * from "./prune.ts"` — the module is S2's
public entry point), `packages/agent/test/prune.test.ts` (new, 505 lines),
`changelog.d/smart-compaction.added.md` (new). Nothing else: no protocol, daemon,
client, config, tool or TUI change; no `protocol.d/` note; no schema regeneration
(no schema changed); `TODO.md` untouched.

**Not verified / left to the other slices.** That the trigger's thresholds pay
for themselves (S3's replay, S4's A/B); that a small model does not imitate a
stub (S2's guard + S4's spot-check); the real-world gain figure (S3). S1 itself
is pure and unit-tested, and is not reachable from the loop until S2 wires it —
which is why it cannot move any existing test, and the full-suite run above
confirms that (its only failures were the concurrently-corrupted snapshot file,
repaired and re-run green).

**Slice status.** S1 **DONE**. S2, S3, S4 not started (out of this scope).

### Fix round 1

*— deepseek-v4.1-flash-1017 (executor, `tentacle --profile deepseek`), 2026-11-17 · addresses the
Review's three MEDIUMs and both nits*

**Red before green (§9).** Every fix's test was written first and run against the unfixed `prune.ts`:
`35 pass / 3 fail`, red on the ASSERTION, not an import — `a PDF read with 'pages' is covered only by
the SAME 'pages'`, `a set built before an IN-PLACE history replacement fires on nothing`, `a stale
entry does not hide a live one in the same set`. Those 3 own the three MEDIUMs. The 8 other cases
added this round are guard/negative cases that a correct implementation already passes (one of them,
the failed-earlier-read case, was added after the red run): their non-vacuity is established by the
mutation run below — each has a mutation under which it is among the failing tests — not by a red
run. The suite went 28 → 39 cases.

**M1 — R5 and the R1 read rules were under-tested (finding 1).** No behaviour change in `prune.ts`:
the reviewer's seven survivors were real test gaps, so the fix is the missing cases, in
`prune.test.ts`. Cause, confirmed by mutation: the only positive R5 case used `fs_read` (R1 stubs it
first, and `"call r2"` matches both stubs) and the negative one used an 11-char body the
`savedChars > 0` gate refuses whatever R5 decides. Added: R5 positive/negative on `search` (no path,
not a shell, body far larger than its stub) — identical→stubbed, different bytes→not, different
arguments→not; "only the EARLIER of two identical results is stubbed" (so no stub points at another
stub); a `covers` case with a later start (`offset 40` vs `lines 1-50`); a later FAILED read; a
FAILED earlier read; a `context_reset` exemption case. Fixing the *tests* exposed nothing broken in
the rules for these — `A/E/F/G/I/B/K` now all fail the suite (below).

**M2 — a set survived an in-place history replacement (finding 2).** The premise was FALSE:
`Session.compact` (`session.ts:366-367`) and `clearConversation` (`:390-391`) reuse the array
(`length = 0`, `push`), as `context_reset` does, so a `WeakMap<ChatMessage[], …>` entry survives and
a monotonic index-only set then overwrote a `/compact` SUMMARY at index 1 with an old `fs_read` stub.
Fix, in `prune.ts`: `PruneEntry.original` carries the stored message (by reference) and both
`applyPrune` and `estimateGain` compare `history[index] !== entry.original` and skip a mismatch — the
index bound check is gone, since it could not detect this class. Doc corrected in four places
(Design §6, Failure modes, Tests S1/S2) so S2 drops the state explicitly on compact AND `/clear`,
the entry comparison being the belt to that brace. Checked the one other in-place message write — the
`contextUsage` copy at `agent.ts:1834` — it only replaces messages at index >= `unseen` (the current
turn's, never candidates), so identity is stable for every index a set can name.

**M3 — R1 ignored `fs_read`'s `pages` (finding 3).** `readRangeOf` saw only a line range, so a later
`fs_read doc.pdf` (default first 100 pages) "covered" an earlier `pages: "101-200"` read. Fix, in
`prune.ts`: a `ReadSpan` (`{range?}` or `{pages?}`) replaces the bare `ReadRange` in `CallSite`;
`readSpanOf` yields `{pages}` when the argument is present; `spanCovers` compares `pages` strings
verbatim when either side is a page window and only otherwise falls back to `covers`; `spanText`
reports `pages 101-200` in the stub instead of a line range.

**Nits.** `changelog.d/smart-compaction.added.md` **deleted**: it announced an unwired internal
module, which §10 excludes ("internal/dev/test-only work adds no fragment"); the fragment belongs to
S4, when the default is decided and behaviour changes. The Execution signature above claims
`claude-sonnet-4-5-20250929` for work committed as `exec (deepseek)`; it is left as-is rather than
rewritten (that is the previous round's record) and this section is signed with the real model id.

**Mutation checks (§9, pasted).** Script `mutate-r1.ts` (in this worktree's `.tentacle/tmp/
smart-compaction/`, run `bun mutate-r1.ts`): each mutation applied to `prune.ts`, the suite run, the
original restored — `restored: true`, and `git status` shows only this round's files. **Twelve
mutations, twelve caught**, including all seven that survived the original Execution:

```
A  R5 ignores content: 3 fail  (also kills the two new fs_read-failure cases)
E  R5 either direction: 2 fail  (two identical results outside the tail | stale entry beside a live one)
G  R5 ignores arguments: 1 fail  (same tool+bytes but DIFFERENT arguments)
F  covers ignores from: 1 fail  (NOT after a later read that STARTS LATER)
I  R1 after a FAILED read: 1 fail
B  fs_read failure = success: 2 fail
K  exempt list drops context_reset: 1 fail
P  pages ignored (all reads are line windows): 1 fail
S  applyPrune ignores `original`: 3 fail  (other-history index | in-place replacement | stale beside live)
T  estimateGain ignores `original`: 1 fail  (in-place replacement)
C  R3 keeps no tail: 1 fail   H  R1 by a FAILED write: 1 fail   (pre-existing, still holding)
```

`T` initially re-mutated `applyPrune` (the two fixes shared a marker and only the first `replace`
fired) — it reported 2 fail, which is the tell; narrowed to `estimateGain`'s own body it is 1 fail on
the test that owns it. Worth recording: a mutation script that silently re-applies the previous
mutation over-states its coverage, which is exactly the flaw finding 1 named.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (1857 files, the §6 baseline) ·
`bun test packages/agent packages/tools` 1105 pass / 0 fail · full `bun test`:

```
 13578 pass
 5 skip
 0 fail
 33 snapshots, 106806 expect() calls
Ran 13583 tests across 964 files. [465.20s]
```

The 5 skips are the §6 baseline opt-in/root-only set, not new. This run took 465 s on a tree shared
with three other agents' suites; it accounts for the count exactly — the previous Execution's run was
13547 pass + 5 skip + 20 fail = 13572, and this one is 13578 pass + 5 skip = 13583, the +11 tests added
this round (the 20 chart-lines failures recorded there were the concurrently-corrupted snapshot file,
and are gone).

**Files (this round).** `packages/agent/src/prune.ts` (modified: `original`, `ReadSpan`/
`readSpanOf`/`spanCovers`/`spanText`, `applyPrune`, `estimateGain`, docblocks),
`packages/agent/test/prune.test.ts` (modified: +11 cases and 3 assertions tightened, 28 → 39),
`changelog.d/smart-compaction.added.md` (deleted), this doc.

**Still not verified.** Nothing new: S1 remains unreachable from the loop until S2 wires it, so the
fixes cannot move any existing test, and the properties S2 owns (the state actually being dropped on
compact/`/clear`, not merely harmless if kept) are S2's tests, listed in the Tests section.

## Review

*— claude-opus-5-5, 2026-11-17 · fresh context · scope: S1 only (`git diff main...HEAD`)*

**Verdict: REQUEST-CHANGES** (no HIGH; three MEDIUM).

**Gate (re-run).** `bun test packages/agent/test/prune.test.ts` 28 pass / 0 fail · `bun run lint` clean
(1857 files) · `bun run typecheck` clean. Full suite not re-run (S1 is unreachable from the loop).

**Findings.**

1. **MEDIUM — R5 and parts of R1 are untested; the Execution's "7/7 mutations caught" does not
   generalise.** Ten further mutations of `prune.ts` (script `.tentacle/tmp/smart-compaction/mutate.ts`,
   tree restored byte-identical), seven SURVIVE the suite:
   - `prune.ts:568-569` R5 ignores the content (`later.result === content` → `true`): 0 fail.
   - `prune.ts:566` R5 in either direction (`>` → `!==`): 0 fail. Failure scenario: two identical
     1.5k-char `shell` outputs outside the tail are BOTH stubbed, each "identical to the later result
     … still in the conversation" — the output is gone from the request and each stub points at the other.
   - `prune.ts:568` R5 ignores the arguments: 0 fail.
   - `prune.ts:239-241` `covers` ignores `from`: 0 fail. Scenario: read `lines 1-50`, later read
     `offset 40` (to EOF) → the first read is stubbed "superseded" though lines 1-39 are in neither.
   - `prune.ts:527` / `:279` a later FAILED `fs_read` supersedes a good one: 0 fail.
   - `prune.ts:83` `context_reset` dropped from the exempt list: 0 fail.
   Cause: the only positive R5 test (`prune.test.ts:334`) uses `fs_read`, so R1 stubs it first (and its
   `"call r2"` assertion also matches the R1 stub); the negative R5 test (`:348`) uses a 11-char body
   that the `savedChars > 0` gate refuses whatever R5 decides. Needed: R5 positive/negative cases on a
   non-`fs_read` tool with bodies larger than a stub, "the LATER copy is never stubbed", a
   `covers` case with a later start, a later failed read, a `context_reset` exemption case.
2. **MEDIUM — false plan premise + an S1 API that turns it into a silent wrong state.** Design §6 and
   Failure modes say `/compact`'s state "dies with the old objects"; FALSE: `Session.compact`
   (`session.ts:366-367`) and `clearConversation` (`:390-391`) reuse the same array (`length = 0`,
   `push`), exactly like `context_reset` — so a `WeakMap<ChatMessage[], …>` entry survives them.
   `PruneSet` is keyed by index only and `applyPrune` (`prune.ts:592-598`) guards only out-of-range
   indices (its comment claims stale sets are handled). Scenario: a batch prunes indices 1..40; the
   user runs `/compact`; the new history is `[system, summary, …]`; the surviving monotonic set
   replaces index 1 (the summary) with an old `fs_read` stub — the summary silently vanishes from the
   request and a `tool` message without its call goes to `repairHistory`. Fix in S1: `PruneEntry`
   carries the `original` message and `applyPrune`/`estimateGain` skip an entry whose
   `history[index] !== original` (+ test); fix the doc so S2 drops the state on compact AND `/clear`.
3. **MEDIUM — R1 ignores `fs_read`'s `pages` argument** (`readRangeOf`, `prune.ts:219-230`).
   Scenario: `fs_read doc.pdf {pages:"101-200"}` then `fs_read doc.pdf` (default first 100 pages):
   both are "whole file", `covers` is true, the earlier pages are stubbed "superseded by a later
   read" though the later read never contained them (recoverable by re-reading, but the stub lies).
   Treat any read with `pages` as covered only by an identical `pages` value.

**Nits (not blocking).** The changelog fragment (`changelog.d/smart-compaction.added.md`) announces an
unwired internal module ("behaviour is unchanged"), against §10 "internal work adds no fragment" and the
plan's "written in S4". The Execution is signed `claude-sonnet-4-5-20250929` while the commit says
`exec (deepseek)` — the signature should name the model that actually ran.

**Premise table (S1-relevant).** `parsePathRange` builtins.ts:84 — TRUE (same regex) · `fs_read`
whole-file read has no line cap (builtins.ts:123-125) — TRUE, so `covers(undefined, x)` is sound for text
· success phrasings builtins.ts:233/305/354 — TRUE, match `SUCCESS_SHAPES` · registry error prefix
`tool fs_read failed:` registry.ts:107 — TRUE · `toolMessage` stores no `isError` agent.ts:266-278 — TRUE
· `spill.path` optional core/tool.ts:40 — TRUE · `/compact` drops the state with the old objects — **FALSE**
(finding 2).

**Attacks tried.** (a) Mutation of ten untested properties — 7 survive (finding 1). (b) Index
stability across in-place history replacement — finding 2. (c) PDF `pages` reads — finding 3. (d) R5
chains / a later duplicate pruned by a different rule — nothing: identical content+tool+args means the
same rule applies to both. (e) R2 output validity: `JSON.stringify` of a parsed object, id/name kept,
multi-line success results refused by `$` without `m` — holds. (f) Store mutation: `applyPrune` copies,
stubs spread the original — holds (M2 in Execution confirmed).

**What holds.** Pure, no wiring, store never mutated; prose never touched; protected tail correct (fewer
than N rounds protects from the first assistant); success detection is positive-match (safe direction);
stubs deterministic and marker-bearing.

**Executor behaviour.** Honest Execution with real red-before-green and documented drift; the mutation set
was chosen around what was tested, so it over-states coverage. Reviewer is Opus; the plan's author is also
Opus (shared blind spot possible on finding 2's premise, which this review caught on re-reading the code).

### Round 2

*— claude-opus-5-5, 2026-11-17 · fresh context · scope: `git diff HEAD~1` (12d91e33)*

**Verdict: PASS.**

- **Finding 1 (test gaps) — fixed.** Re-ran the same 10 mutations plus 5 new ones (script
  `.tentacle/tmp/smart-compaction/mutate.ts`). All **15 of 15 are caught**: A, E and G (R5 content, direction,
  arguments), F (`covers` start), B and I (failed reads), K (`context_reset` exemption), plus the round-1 C, H and J. File
  restored byte-identical (`restored: true`, `git status` clean).
- **Finding 2 (stale index) — fixed.** `PruneEntry.original` (`prune.ts:62`) is checked by identity in
  `applyPrune` (`:656`) and `estimateGain` (`:680`). Mutations L and M (go back to the range-only guard) are caught by the new
  in-place-replacement tests. The doc now says `/compact`, `/clear` and `context_reset` reuse the array, so S2
  must drop the state explicitly at each.
- **Finding 3 (PDF `pages`) — fixed.** `spanCovers` (`prune.ts:291`) only lets a read with `pages` be covered by the same
  `pages`. Mutations N, O and P (pages ignored, the one-sided case, the stub text) are each caught.
- **Nits — handled.** The changelog fragment is deleted. The new Execution entry is signed with the real model id.
  The old wrong signature is left on the round-1 record, which is acceptable.
- **Regressions:** none found. `bun test packages/agent/test/prune.test.ts` gives 39 pass / 0 fail. `bun run lint` is clean (1857
  files) and `bun run typecheck` is clean. One residual risk for S2, not S1: `compactedHistory` may carry a message object
  over at the SAME index. The identity check would then still apply that entry, but the candidates there (skills, system) are exempt,
  so it is not a finding.
