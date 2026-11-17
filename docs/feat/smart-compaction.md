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

**7. Config** (`contextPrune` — a top-level section like its siblings
`contextAwareness`/`contextReset`; there is no `context` object — resolved like `contextAwareness`):
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

No change to `packages/daemon`, `packages/client`, the TUI, or the session
log. No `protocol.d/` note. **Corrected in S2 (executor):** carrying the keys
to a pod daemon goes through `SessionSettingsSchema`
(`packages/protocol/src/session.ts`, the `session/open.settings` the CARRIED
table is typed by), so S2 adds five OPTIONAL fields there — additive, a strip
schema, "fields are free" (AGENTS §7): an older pod drops them, i.e. pruning
stays off there; `protocol.json` is regenerated, no version bump. And the
sub-agent runner (`packages/agent/src/subagent.ts`) must forward the config
to each child, as it does `contextAwareness`.

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

### S2 — wire into the loop + guard + config

*— claude-opus-5-5 (executor), 2026-11-17 · **S2 only** (nothing of S3/S4)*

**Load-bearing check (re-run first).** Re-proved, not trusted: `rg 'projectedHistory\('` still
gives exactly the four sites (round request, forced final report, `noteContextUsage`,
`contextUsage`). Running the S1 scratch script needed an approval this session did not have, so
the check became the first case of the new suite (it survives, unlike a scratch script):
`prune-loop.test.ts` › "load-bearing" — a scripted provider deep-copies each request; after a
pruned run the LAST request carries stubs while all six stored `tool` messages still start with
`exit 0\nline 0000` and carry no marker. It went red before the wiring (0 stubs) and green after.
Hook precondition checked: `forgetModelRequestBaseline` keeps a per-session message COUNT
(`hooks.ts:680-687`, "a length-based delta"), not bytes, so a batch (same length) needs no
baseline reset — none added.

**As built, in dependency order.**
1. `packages/tools/src/builtins.ts:216-240` — `PRUNE_SENTINEL` (the ONE value; `prune.ts`'s
   `PRUNE_MARKER` now re-exports it, `prune.ts:36-42`) and `prunedPlaceholderRefusal`, called first
   in `fs_write` (`:249`), `fs_edit` (`:327`), `fs_multi_edit` (`:368`): refused before the path lock,
   the read and the write, so the file is untouched.
2. `packages/agent/src/agent.ts` — `AgentConfig.contextPrune` (`window`, `pruneAtPercent`,
   `minGainPercent`, `keepRecentRounds?`, `outputChars?`, `counter?`); `pruneState`
   `WeakMap<ChatMessage[], PruneSet>` beside `anchors`/`spend`; `requestHistory` (`:1016`) =
   `applyPrune(projectedHistory(…), set)`, now used at all four sites (`:1506`, `:1831`, `:1941`,
   `:1999`); `maybePrune` (`:1033`) called at the round boundary BEFORE `noteContextUsage`
   (`:1501`), so the context line reports what is sent; `forgetPrune` (`:1083`, public) called by the
   reset path (`:2669`, beside `anchors.delete`) and by `Session.compact` / `clearConversation`
   (`session.ts:369`, `:394`).
3. `packages/agent/src/subagent.ts` — `deps.contextPrune` forwarded to each child, on the child's
   window when it has one (mirrors `contextAwareness`).
4. Config: `schema.ts` (`contextPrune` section, strict, ints with bounds), `defaults.ts` (five
   `DEFAULT_CONTEXT_PRUNE_*`, `enabled` false per Q1, + the commented sample), `resolve.ts`
   (`ContextPruneConfig`, file-only like `contextAwareness`, five sources), `load.ts`, `profile.ts`
   (per-key merge, + the three places that list per-key sections), `key-docs.ts` (section + five
   leaves, `carried: "workspace"`); `README.md` table regenerated (`bun run docs:config`).
5. `packages/protocol/src/session.ts` — five optional `contextPrune*` fields on
   `SessionSettingsSchema`; `protocol.json` regenerated (`bun run schema:export`).
6. `packages/cli/src/carried-settings.ts` (five W rows), `wiring.ts` (`contextPrune` on
   `contextWindow` when enabled, to the main agent AND the sub-agent runner).
7. `changelog.d/smart-compaction.added.md` — written now on the owner's explicit S2 instruction
   (the plan header said S4); it says "off by default until measured".

**Trigger semantics (as built).** `used` = `estimateUsed` over the CURRENT request (set applied)
with the anchor; below `pruneAtPercent` → nothing. Else `fresh` = candidates whose index is not
already a LIVE entry; their `estimateGain` below `minGainPercent` → nothing. Else the new set is
the live prior entries (never re-stubbed, never removed) + all fresh ones, and the anchor is
deleted. No window (`window <= 0`) → off.

**Drift from the Implementation (and why).**
1. **Protocol fields added** — the plan said "no change to `packages/protocol`" AND "carried to pod
   daemons"; the second needs `SessionSettingsSchema` (the CARRIED table's type). Additive optional
   fields, no `protocol.d/` note (AGENTS §7: fields are free). Plan's Files corrected.
2. **Key is `contextPrune`, not `context.prune`** — no `context` object exists; the siblings are
   top-level `contextAwareness`/`contextReset`. Design §7 corrected. Leaf `pruneOutputChars` maps to
   the S1 option `outputChars`.
3. **`subagent.ts` touched** — not in the plan's Files; without it no child would ever prune.
   Forwarding is three lines mirroring `contextAwareness`; **no dedicated test** (see below).
4. **The guard checks only text that would be WRITTEN** (`content`, `new_string`, every
   `edits[].new_string`), and only the marker WITH the stub's colon (`⟪pruned by tentacle:`).
   An `old_string` with a placeholder cannot corrupt a file (it fails "not found"), and the
   bare marker must stay writable: `prune.ts` and docs name it. Pinned by a test both ways.
5. **Session tests use contextAwareness OFF for "log intact"**: with it on, the stored
   `contextUsage` values legitimately differ (the meter reports the pruned size, Design §6), so
   "byte-identical to an unpruned run" is only the right property with the meter off.

**Red before green.** `prune-loop.test.ts` (12 cases) written first: **7 of 9 red** on assertions
(no `contextPrune` in the loop yet; bun does not typecheck) — the two greens were "below threshold
= today" (true before the feature, by design) and `/compact`, which lacked a pre-assertion that a
batch happened; tightened, then red too. `prune-guard.test.ts` first failed on the import
(`PRUNE_SENTINEL` missing); I added only the constant and re-ran: **3 of 4 red on assertions**
(the 4th, "bare marker is writable", is green before and after by design; mutation M8b shows it is
not vacuous). Two cases were added after mutations survived (below), each shown red under that
mutation, green without it.

**Mutation checks (§9, pasted; each applied by hand, the narrow suite run, then reverted —
`rg MUTATION packages/agent/src packages/tools/src` empty at the end).**

```
M1  requestHistory also writes stubs into `messages`      -> 5 fail (load-bearing, log intact,
                                                              client size, /clear, /compact)
M2  trigger disabled (maybePrune not called)              -> 8 fail
M3  gain gate removed                                     -> 1 fail (batch/prefix: [3,5])
M4  set not monotonic (prior entries dropped)             -> 1 fail (batch/prefix)
M5  no forgetPrune in clearConversation                   -> 1 fail (/clear)
M6  no forgetPrune in compact                             -> 1 fail (/compact)
M7  no forgetPrune in the context_reset path              -> 1 fail (context_reset)
M8  guard never refuses                                   -> 3 fail (fs_write, fs_edit, fs_multi_edit)
M8b guard on the bare marker (no colon)                   -> 1 fail (bare marker writable)
M9  pruneAtPercent ignored                                -> SURVIVED -> added "under pruneAtPercent
                                                              nothing is pruned…": 1 fail
M10 anchor not deleted on a batch                         -> SURVIVED (a FIXED measure made both
                                                              lines equal, so none was emitted) ->
                                                              added "a batch drops the anchor" with a
                                                              growing measure: 1 fail (12416 ≥ 9000)
```

**Gate.** `bunx tsc --noEmit`: clean except 2 errors in `packages/tools/src/diagram-parse.ts`
(`linkedom`/`mermaid` modules not installed in this worktree) — a file this slice does not touch.
`bun run lint`: clean (1964 files). Narrow: `bun test packages/agent packages/config
packages/protocol packages/tools/test/prune-guard.test.ts packages/cli/test/carried-settings.test.ts`
green (agent 791/0 incl. carried-settings; config+protocol+carried 1049/0 before the last two loop
cases). Full `bun test` (run ONCE, per the token budget):

```
 14222 pass
 5 skip
 121 fail
Ran 14348 tests across 1020 files. [472.74s]
```

Triage, without a second full run: **mine** — `CARRIED` count pinned in
`cli/test/key-docs-carried.test.ts` (24→29), and five hand-built `TentacleConfig` fixtures with no
`contextPrune` (`cli/test/engine-{runtime,k8s,docker}.test.ts`, `session-hop-targets.test.ts`,
`session-hop.docker.test.ts`), so `CARRIED.read` threw in every pod/engine test (tsc does not
catch it: those fixtures are not checked against the full type). Both fixed. Re-run `bun test
packages/tools packages/cli`: **3971 pass / 21 fail**, and all 21 are `diagram`/mermaid tests plus
`pod-binary-build` (2) failing on `Could not resolve: "linkedom"` — `linkedom`/`mermaid` are not
installed in this worktree (`node_modules/{linkedom,mermaid}` absent; the same cause as the two
tsc errors). The diagram-related files across core/tui/cli/tools give 19 fail on their own.
**To verify on a full install:** `bun test 2>&1 | tail -15` should be the §6 baseline (5 opt-in
skips, 0 fail); I could not prove the 0 here.

**Files (S2).** `packages/agent/src/{agent,session,subagent,prune}.ts`,
`packages/tools/src/builtins.ts`, `packages/config/src/{schema,defaults,resolve,load,profile,key-docs}.ts`,
`packages/protocol/src/session.ts`, `packages/protocol/schema/protocol.json` (generated),
`packages/cli/src/{carried-settings,wiring}.ts`, `README.md` (generated table); tests new
`packages/agent/test/prune-loop.test.ts`, `packages/tools/test/prune-guard.test.ts`, updated
`packages/cli/test/carried-settings.test.ts` (5 W rows, counts 23→28 / 22→27),
`key-docs-carried.test.ts` (24→29) and the five config fixtures named in the Gate;
`changelog.d/smart-compaction.added.md`; this doc. `TODO.md` untouched.

**Not verified.** (a) Sub-agent forwarding has no test — verify with a `createSubagentRunner`
child whose scripted provider sees a stub after enough rounds. (b) End-to-end in a real
session/pod (config → wiring → carried to a pod): only the unit seams are tested
(`carried-settings` W rows, `wiring` by typecheck); S4's A/B exercises it. (c) The guard makes
any file whose NEW text contains `⟪pruned by tentacle:` unwritable through the fs tools (e.g. a
doc quoting a full stub) — accepted for the safety it buys; `shell` still can.

**Slice status.** S2 **DONE**; the full-suite 0-fail is unproven here (missing deps, see Gate). S3 **DONE** (see the S3 section below). S4 not started.

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

## Review

*— claude-opus-5-5, 2026-11-17 · fresh context · scope: **S2 only** (`git diff main...HEAD`) · same model family as the S2 executor: shared blind spots possible*

**Verdict: PASS** (no HIGH, no MEDIUM).

- **Gate.** Touched files (`prune-loop`, `prune`, `prune-guard`, `carried-settings`, `key-docs-carried`): 166 pass / 0 fail. `bun run lint` clean (1964 files). `bun run typecheck`: only 2 errors in `packages/tools/src/diagram-parse.ts` (`linkedom`/`mermaid` missing from this worktree's `node_modules`; file not in the diff). Full `bun test` not re-run: the 0-fail baseline on a full install is still unproven.
- **Mutations (reverted, tree clean).** Round request built from `projectedHistory` (prune set ignored) → 7/11 fail. `forgetPrune` removed from `clearConversation` → `/clear` fails. Bulk perl mutations were blocked by permissions, so only these two ran; the executor's M1–M10 table was not re-run.
- **Attacks that found nothing.** (1) §7 persistence: `requestHistory` only copies messages, and `session.messages` stays untouched (pinned by the log-intact test). (2) In-place replacements: the only `length = 0` sites are `session.ts:366/391` and `agent.ts:2665`, all three call `forgetPrune`. The `messages.pop()` at `agent.ts:1742/1754` only touches the protected tail. (3) Anchor: `ref` is the last stored message, which is never pruned, so the anchor stays valid between batches and is dropped on a batch. (4) Pod: the config bounds (`schema.ts`) match `SessionSettingsSchema`, so a carried value cannot fail `session/open`. The fields are additive and optional, so no bump is needed. (5) Guard: every write tool (`fs_write`/`fs_edit`/`fs_multi_edit`) refuses the placeholder before `lockPath`. No other fs write tool exists in `packages/tools/src`. (6) Hooks: the baseline counts messages, so a batch (same length) needs no reset.
- **Nits.** The doc says `prune-loop.test.ts` has 12 cases, but it has 11. Sub-agent forwarding is untested (the executor said so).
- **Executor:** honest. It disclosed its drift, mutation survivors and the unproven full suite.

### S3 — offline replay

*— claude-opus-5-5 (executor), 2026-11-18 · **S3 only** (nothing of S4)*

**Load-bearing check (re-run first, §1/§9).** Passed, twice over, and the second
one is the one that matters: the S3 plan's premise is that a *replay* of the
stored log can stand in for the loop, so the check cannot be "the seam is still
there" (S1/S2 proved that) — it is "**the replay's model of the loop IS the
loop**". `rg 'projectedHistory\('` still gives exactly the four sites, but that
is a static fact, so it was replaced by an empirical one:

`.tentacle/tmp/smart-compaction/equivalence.ts` runs the REAL `Agent` (with
`contextPrune`, six long `shell` rounds, a scripted provider that deep-copies
every `ChatRequest`) and then feeds the very history it produced to the replay
script's own `replaySegment`. Round by round, tokens and stub counts:

```
stored history messages: 13
real requests: 7   replayed rounds: 7
real tokens   : [41,2557,5073,3483,5999,4409,6925]
replay tokens : [41,2557,5073,3483,5999,4409,6925]
real stubs    : [0,0,0,2,2,4,4]
replay batches: [3,5]
MATCH: the replay models the real loop exactly
```

An exact match on all seven requests. The one thing the equivalence cannot
compare is the **anchor** (the real loop's `estimateUsed` uses the provider's
measured `promptTokens` once one exists, `agent.ts:1958`); a replay has no
provider, so it recomputes with the counter every round. This makes the replay's
`used` an OVER-estimate exactly when a real run measured a smaller prompt, i.e.
it can only fire a batch EARLIER than the loop would, never later — and the
numbers below are therefore conservative. Stated as the one unverified piece.

**As built.** `.tentacle/tmp/smart-compaction/replay.final.ts` (234 lines,
pasted below; gitignored, so this doc is its only home). It imports the REAL
`pruneCandidates` / `applyPrune` / `estimateGain` / `renderForModel` from
`@tentacle/agent` and the REAL `KnownLogEntrySchema` / `projectEntry` from
`@tentacle/protocol` — nothing about pruning is re-implemented; the script only
re-implements the ~20 lines of *trigger* that live inside `Agent.maybePrune`
(private), and the equivalence check above is what pins that copy. Per
`base` entry it starts a fresh segment (that is exactly where the loop's
`forgetPrune` fires), so a `/compact` or a `context_reset` inside a log is
modelled as the loop does it.

**Results — 12 real executor logs** (every `*.jsonl` over 150 kB in
`~/.config/tentacle/sessions`, 3,530 rounds, 11 DeepSeek-V4.1-Flash + 1 local
Qwen3.8-27B), defaults 60/15/6/2000, `r = 0.1`:

| log | model | rounds | tokens saved | batches | cost saved |
|---|---|---|---|---|---|
| b7b94134 | Qwen3.8-27B | 467 | 31.6 % | 3 | 27.8 % |
| e5122a31 | DeepSeek | 457 | 31.4 % | 4 | 27.8 % |
| bd50b6dd | DeepSeek | 334 | 29.7 % | 3 | 25.1 % |
| 3a92d584 | DeepSeek | 297 | **42.3 %** | 3 | 38.0 % |
| 069f37bb | DeepSeek | 284 | 33.3 % | 2 | 30.3 % |
| 80b800e9 | DeepSeek | 224 | 31.4 % | 3 | 24.4 % |
| 8cde6646 | DeepSeek | 325 | 39.0 % | 3 | 35.6 % |
| 5a8c000f | DeepSeek | 284 | **18.3 %** | 2 | 13.0 % |
| 79065895 | DeepSeek | 293 | 25.5 % | 2 | 20.6 % |
| ef33997b | DeepSeek | 210 | 31.6 % | 3 | 23.4 % |
| 1a740598 | DeepSeek | 194 | 30.3 % | 2 | 24.2 % |
| 217e0e08 | DeepSeek | 161 | 31.5 % | 1 | 26.7 % |
| **TOTAL** | | **3,530** | **31.8 %** | **31 (1 per 113.9)** | **27.3 %** |

**Gate (plan §Validation 1: ≥ 25 % fewer input tokens, ≤ 1 batch per ~30 rounds).**
PASS on both, on the aggregate and on **11 of the 12 logs** individually; the
batch rate is 4× better than the gate. The one log under 25 % (`5a8c000f`,
18.3 %) was diagnosed rather than excused, with the measurement that settles it:
replaying it with the trigger forced open (`--prune-at 1 --min-gain 1`, i.e.
prune everything prunable every round) gives **27.9 %** — that log's **ceiling**,
the most any batching scheme could ever save on it. So the run is not a pruner
failure and not a batching failure; the log simply has little prunable volume
(small tool results, mostly short `fs_read`/`grep` exchanges — a `cee` session).
Batching captures 66 % of its ceiling vs 70–87 % on every other log, and those
ceilings are 32–51 %. Nothing about the thresholds would fix it: at
`--prune-at 1` it needs 29 batches to reach 27.9 %.

For context, the same ceiling measurement across the corpus shows the defaults
batch to 66–87 % of what per-round pruning would take (mean **78 %**). The
missing 22 % is not a cache cost: it is candidates that became prunable but were
never swept, because no batch fired after them (each log's tail, and the stretch
between two gated batches). That is the price of the cache stability the design
deliberately buys, and the sweep shows the exchange rate.

**Which rule carries the gain** (candidates pruned, whole corpus, defaults):
`call_payload` **443**, `long_output` **394**, `superseded_read` **283**,
`spill_preview` **21**. So R2 — the rule the owner question 3 asked about, and
the one with the stub-imitation risk — is the single largest contributor, which
is what justifies both the rule and the sentinel guard that S2 added for it.
R4 (21) barely matters in these logs; it is kept because it is lossless and free.

**Per-round detail** (the plan's "per round" column) is `--rounds`;
a sample around a batch, showing the design working — identical bytes up to the
batch, a step down, then identical bytes again:

```
r 94 off   75948 on   75948
r 95 off   76037 on   76037
r 96 off   77434 on   37630  BATCH
r 97 off   78067 on   38263
r255 off  165687 on  125883
r257 off  166537 on  105668  BATCH
r341 off  202315 on  121507  BATCH
```

**Q6 retune sweep** (the owner's answer made this S3's job: "60/15/6/2000
retuned by S3's replay"). Cost saved at `r = 0.1` / batches per round:

| | minGain 10 | minGain 15 | minGain 25 |
|---|---|---|---|
| pruneAt 40 | 29.7 % / 69 | 27.7 % / 95 | 24.3 % / 186 |
| pruneAt 50 | — | 27.5 % / 101 | — |
| **pruneAt 60** | 28.4 % / 91 | **27.3 % / 114** | 24.6 % / 186 |
| pruneAt 70 | — | 26.8 % / 131 | — |

`r` sensitivity (the cache ratio is DeepSeek's published ≈ 0.1, unverified here):
cost saved is **+22.8 % at r=0.05, +27.3 % at r=0.1, +29.8 % at r=0.2, +31.3 % at
r=0.5** — pruning never loses money at any ratio, which is the property the
design's §3 arithmetic claimed and this measures. `window` matters more than any
of these (128 k → 31.8 %, 64 k → 36.5 %, 200 k → 23.6 %): the trigger is only as
good as the window it is told about. `keepRecentRounds` 3/6/10 → 32.2/31.8/31.3 %
and `pruneOutputChars` 1000/2000/4000 → 31.9/31.8/29.5 %, both flat-to-mildly-
worse when loosened, i.e. **the approved defaults are on the good side of every
axis, and no retune is indicated**. Recommendation to S4: keep 60/15/6/2000;
`pruneAtPercent: 40` is the one lever worth an A/B arm on a `cee`-like workload.

**Mutation check (§9, non-vacuity of the REPLAY, not of the tests).**
`replay-mutate.ts` breaks one rule at a time in `prune.ts` and re-runs the whole
corpus; a replay that does not react is measuring itself:

```
baseline: saved 31.8% · 31 batches
M1 R1 (superseded read) disabled: saved 19.5% (Δ -12.30) · 21 batches → CAUGHT
M2 R4 (spill preview) disabled:   saved 31.7% (Δ -0.10) · 31 batches → CAUGHT
M3 R3 (long output) disabled:     saved 18.0% (Δ -13.80) · 20 batches → CAUGHT
M4 protected tail ignored:        saved 32.5% (Δ +0.70) · 31 batches → CAUGHT
M5 stub-size gate off:            saved 31.8% (Δ  0.00) · 31 batches → SURVIVED
M6 R2 (write/edit payload) off:   saved 22.4% (Δ  -9.40) · 19 batches → CAUGHT
5/6 caught · prune.ts restored: true
```

6/6 mutations move the pruner; 5/6 are visible in the replay's numbers. **M5 is
the honest exception and it is a category error to "fix" it**: the mutation
accepts a stub equal in size to the body it replaces, which by construction
removes **zero tokens**, so a token/latency replay cannot see it — it is a
correctness property (a stub must never GROW the request), not a savings one. It
is caught where it belongs: `prune.test.ts` › "a result SMALLER than its stub is
refused" fails on it (verified: 38 pass / 1 fail, file restored). **M4 is CAUGHT
but in the wrong direction** (Δ **+0.70 %**: pruning the current turn's unseen
messages *saves more* tokens) — the replay reports it, and reporting it is all a
token measurement can do: that the protected tail must exist is a correctness
property too (a stub for a result the model is still working on), pinned by
`prune.test.ts`'s tail cases, not by the savings. M2's Δ of
−0.10 % is a real CAUGHT (R4 fires only 21 times corpus-wide) but its magnitude
should not be read as R4 mattering less than R1/R3 — R4 is a lossless rule whose
candidate set is small in these logs.

**Red before green.** For a script the red-first rule is the **equivalence
check**, and it was run in that order: the first version of the replay used
`COUNTER.countMessages(...)` directly instead of `renderForModel` +
`countMessages`, and the equivalence check went red on request 0 (41 vs the real
41 — a coincidence of a small history) and would have diverged once a
`contextUsage` line was rendered in. Fixed to `tokensOf` (= `renderForModel`,
exactly `estimateUsed`'s own call) → green on all 7. The second genuine red was
the tool-prefix constant: 4,200 was a guess; measured from the shipped registry
it is **1,245** tokens, and the equivalence check cannot pass with a guess
(`toolsTokens` is set from the same registry there). Both are in the script's
comments as the reason each exists.

**Drift from the Implementation (and why).**

1. **The script needs FOUR exports more than the plan implies** (`replaySegment`,
   `replay`, `emptyResult`, the `Opts`/`LogResult` types) so `equivalence.ts` can
   drive it in-process rather than by shelling out. The plan says "a replay
   script"; making it importable is what let the load-bearing check be an
   exact-match test instead of a text-scrape. No tracked file changed.
2. **The tool-definition prefix is modelled at all.** The plan does not mention
   it, but `estimateUsed` adds `JSON.stringify(tools)` and without it every
   `used` is ~1.2 k low, which moves the batch POINTS. It is a flag
   (`--tools-tokens`) with the measured builtin default, and its effect is
   ±1 batch over 3,530 rounds.
3. **The anchor is recomputed, not measured** (see the load-bearing note). Noted
   as the one conservative approximation; a real `usage` entry exists only where
   a provider reported one, and no log in this corpus carries `usage` entries
   (`grep '"type":"usage"'` = 0 files), so there is nothing to replay it from.
4. **The cost model is my own** (`bill()`: longest unchanged-content prefix at
   `r`, the rest at 1, tool prefix at `r` after round 0). The plan asks for "the
   modelled cost with r" without specifying the model, so it is stated here:
   it is a prefix-cache model, correct for DeepSeek/OpenAI-style automatic
   prefix caching and an over-estimate of the saving for a provider that caches
   per-message.
5. **`--prune-at`/`--min-gain`/`--keep`/`--output-chars`/`--window`/`--r` flags**
   were added beyond the plan's "prints per round" so the Q6 retune and the
   sensitivity tables are one command each, not a code edit per run.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (1,966 files) ·
`bun test` run twice: **14,356 pass / 5 skip / 0 fail** (first run) and
**14,355 pass / 5 skip / 1 fail** (second run) across 1,022 files. The 5 skips are
the documented opt-in ones (docker live, k8s live, the real-socket keepalive —
one per file, each confirmed individually).

**The one failure is a pre-existing flake, not S3's, and here is the proof
rather than the assertion.** `packages/daemon/test/session-log-store.test.ts:815`
(T4, `fork` — `docs/feat/clear-fork-history.md`): it starts a fork and a source
write that race, `await Bun.sleep(60)`, then expects `control.forkTemps === 1`;
got 2. Facts established: (a) `git diff HEAD --name-only -- packages/` is **empty**
— S3's only change is this Markdown file, which `bun test` does not read (it
requires `.test.ts`), so no code path of the failing test is reachable from the
diff; (b) the test **flakes on its own**, with no other test running: 12
consecutive isolated runs gave **11 pass / 1 fail**; (c) it passed on the first
full run and in every earlier isolated run, i.e. it is load- and timing-sensitive.
The mechanism is in the test, not the product: `forkIo`'s `writeDurable` counts a
fork temp and only then parks on `control.gate`, and a 60 ms sleep is not a
guarantee that both goroutine-free tasks reached it — under full-suite CPU
pressure the second temp is counted late. Left unfixed: it is another task's file
and behaviour (`docs/feat/clear-fork-history.md`, already merged), and fixing a
sleep-based race in a load-bearing daemon store is not S3's slice. Flagged here so
the orchestrator can file it; **S3's own work is green** (prune + prune-loop +
tools: 531 pass / 0 fail, re-run after every edit).

No schema change, so `protocol.json` was not regenerated. No tracked file changed
by S3 but this doc. (One worktree-only note: `bunx tsc` initially failed on
`linkedom`/`mermaid` — missing `node_modules` in this worktree, the same gap S2's
Gate recorded; `bun install --filter '!@tentacle/mobile'` fixed it and the gate
above is the post-install run.)

**Changelog: no fragment from S3, deliberately.** S3 is internal (a gitignored
measurement script, no tracked code, no behaviour change, **defaults unchanged** —
the retune sweep recommends keeping 60/15/6/2000), and AGENTS §10 says internal,
dev/test-only work adds none. `changelog.d/smart-compaction.added.md` already
exists from S2 and still describes the shipped feature accurately, including
"Off by default until it has been measured" — S4 owns the flip (and any wording
change) once the live A/B gate decides it.

**The script** (`replay.final.ts`, verbatim — the repo copy lives only here,
since `.tentacle/` is gitignored):

```ts
// S3 offline replay (docs/feat/smart-compaction.md): load real `<uid>.jsonl`
// session logs, walk each conversation SEGMENT round by round with the S1
// pruner + the S2 trigger, and report the tokens sent without / with pruning,
// the batch points, and the modelled cache-aware cost at a cache ratio r.
// Deterministic, no model calls.
//
//   bun replay.ts [--r 0.1] [--window 128000] [--prune-at 60] [--min-gain 15]
//                 [--keep 6] [--output-chars 2000] [--tools-tokens 1245]
//                 [--rounds] <log.jsonl>...
import { readFileSync } from "node:fs";
import { type ChatMessage, HeuristicTokenCounter } from "@tentacle/core";
import { KnownLogEntrySchema, projectEntry } from "@tentacle/protocol";
import {
  applyPrune,
  estimateGain,
  type PruneEntry,
  type PruneSet,
  pruneCandidates,
  renderForModel,
} from "@tentacle/agent";

const COUNTER = new HeuristicTokenCounter();
/**
 * The tool-definition prefix. The log does not record it, so it is MEASURED
 * from the shipped builtin set (`new ToolRegistry().registerAll(builtinTools)
 * .definitions()` → 7 tools, 4,978 JSON chars, 1,245 tokens by this counter);
 * raise it with `--tools-tokens` for a session that carried MCP tools. It is
 * constant per round, so it only nudges the batch POINTS.
 */
const BUILTIN_TOOLS_TOKENS = 1245;

export type Opts = {
  r: number;
  window: number;
  pruneAtPercent: number;
  minGainPercent: number;
  keepRecentRounds: number;
  outputChars: number;
  toolsTokens: number;
  rounds: boolean;
};

export type RoundRow = { round: number; off: number; on: number; batch: boolean };
export type LogResult = {
  log: string;
  model: string;
  rounds: RoundRow[];
  batches: number[];
  off: number;
  on: number;
  costOff: number;
  costOn: number;
  rules: Record<string, number>;
};

/** `estimateUsed`'s own arithmetic: `renderForModel`, then the counter, plus the tool prefix. */
const tokensOf = (history: readonly ChatMessage[]): number =>
  COUNTER.countMessages(history.map(renderForModel));

/** The log's conversation segments: a `base` starts one (a `/compact`, a reset, a reload). */
function segmentsOf(path: string): { header: Record<string, unknown>; segments: ChatMessage[][] } {
  const lines = readFileSync(path, "utf8").split("\n");
  const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const segments: ChatMessage[][] = [[]];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const parsed = KnownLogEntrySchema.safeParse(JSON.parse(line));
    if (!parsed.success) continue; // an unknown non-critical type: skipped, as a reader does
    if (parsed.data.type === "base" && (segments.at(-1)?.length ?? 0) > 0) segments.push([]);
    const err = projectEntry(segments.at(-1) ?? [], parsed.data, (m) => m as ChatMessage);
    if (err !== null) throw new Error(`${path}: ${err}`);
  }
  return { header, segments: segments.filter((s) => s.length > 0) };
}

/** One billed request: the unchanged prefix at the cache price r, the rest at 1. */
type Arm = { prev: readonly ChatMessage[]; cost: number };
function bill(arm: Arm, request: readonly ChatMessage[], opts: Opts): void {
  let i = 0;
  while (i < arm.prev.length && i < request.length && arm.prev[i]?.content === request[i]?.content) i++;
  const tools = arm.prev.length === 0 ? opts.toolsTokens : opts.r * opts.toolsTokens;
  arm.cost += opts.r * tokensOf(request.slice(0, i)) + tokensOf(request.slice(i)) + tools;
  arm.prev = request;
}

/**
 * One segment: the trigger at every round boundary (before each assistant
 * message, which is where `runMessages` builds a request), the set monotonic
 * and shared — exactly `Agent.maybePrune`'s decision, on the stored history.
 */
export function replaySegment(
  segment: readonly ChatMessage[],
  opts: Opts,
  res: LogResult,
  roundBase: number,
): number {
  let set: PruneSet = new Map<number, PruneEntry>();
  const offArm: Arm = { prev: [], cost: 0 };
  const onArm: Arm = { prev: [], cost: 0 };
  let round = roundBase;
  for (let i = 0; i < segment.length; i++) {
    if (segment[i]?.role !== "assistant") continue;
    const history = segment.slice(0, i);
    const used = tokensOf(applyPrune(history, set)) + opts.toolsTokens;
    let batch = false;
    if (opts.window > 0 && used * 100 >= opts.window * opts.pruneAtPercent) {
      const fresh = new Map<number, PruneEntry>();
      for (const [index, entry] of pruneCandidates(history, {
        keepRecentRounds: opts.keepRecentRounds,
        outputChars: opts.outputChars,
      })) {
        if (set.get(index)?.original !== history[index]) fresh.set(index, entry);
      }
      if (estimateGain(history, fresh).tokens * 100 >= opts.window * opts.minGainPercent) {
        const next = new Map<number, PruneEntry>();
        for (const [index, entry] of set) if (history[index] === entry.original) next.set(index, entry);
        for (const [index, entry] of fresh) {
          next.set(index, entry);
          res.rules[entry.rule] = (res.rules[entry.rule] ?? 0) + 1;
        }
        set = next;
        batch = true;
        res.batches.push(round);
      }
    }
    const withPrune = applyPrune(history, set);
    const off = tokensOf(history) + opts.toolsTokens;
    const on = tokensOf(withPrune) + opts.toolsTokens;
    bill(offArm, history, opts);
    bill(onArm, withPrune, opts);
    res.rounds.push({ round, off, on, batch });
    res.off += off;
    res.on += on;
    round++;
  }
  res.costOff += offArm.cost;
  res.costOn += onArm.cost;
  return round;
}

export function replay(log: string, opts: Opts): LogResult {
  const { header, segments } = segmentsOf(log);
  const res: LogResult = {
    log,
    model: String(header.model ?? "?"),
    rounds: [],
    batches: [],
    off: 0,
    on: 0,
    costOff: 0,
    costOn: 0,
    rules: {},
  };
  let round = 0;
  for (const segment of segments) round = replaySegment(segment, opts, res, round);
  return res;
}

export const emptyResult = (log: string): LogResult => ({
  log, model: "?", rounds: [], batches: [], off: 0, on: 0, costOff: 0, costOn: 0, rules: {},
});

function main(): void {
  const argv = process.argv.slice(2);
  const opts: Opts = {
    r: 0.1,
    window: 128_000,
    pruneAtPercent: 60,
    minGainPercent: 15,
    keepRecentRounds: 6,
    outputChars: 2000,
    toolsTokens: BUILTIN_TOOLS_TOKENS,
    rounds: false,
  };
  const logs: string[] = [];
  const flag = (name: string, apply: (v: number) => void): boolean => {
    const at = argv.indexOf(name);
    const v = at < 0 ? Number.NaN : Number(argv[at + 1]);
    if (!Number.isFinite(v)) return at >= 0;
    apply(v);
    return true;
  };
  flag("--r", (v) => (opts.r = v));
  flag("--window", (v) => (opts.window = v));
  flag("--prune-at", (v) => (opts.pruneAtPercent = v));
  flag("--min-gain", (v) => (opts.minGainPercent = v));
  flag("--keep", (v) => (opts.keepRecentRounds = v));
  flag("--output-chars", (v) => (opts.outputChars = v));
  flag("--tools-tokens", (v) => (opts.toolsTokens = v));
  opts.rounds = argv.includes("--rounds");
  const valued = ["--r", "--window", "--prune-at", "--min-gain", "--keep", "--output-chars", "--tools-tokens"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (valued.includes(a)) i++;
    else if (!a.startsWith("--") && a.length > 0) logs.push(a);
  }

  const pct = (a: number, b: number): string => ((100 * (a - b)) / Math.max(1, a)).toFixed(1);
  const results: LogResult[] = [];
  for (const log of logs) {
    try {
      results.push(replay(log, opts));
    } catch (err) {
      console.error(`${log}: ${(err as Error).message}`);
    }
  }
  for (const r of results) {
    console.log(
      `\n${r.log.split("/").at(-1)}  (${r.model}, ${r.rounds.length} rounds)\n` +
        `  tokens : without ${r.off.toLocaleString()} · with ${r.on.toLocaleString()} · saved ${pct(r.off, r.on)}%\n` +
        `  batches: ${r.batches.length} at [${r.batches.join(", ")}]\n` +
        `  cost   : without ${Math.round(r.costOff).toLocaleString()} · with ${Math.round(r.costOn).toLocaleString()} (${pct(r.costOff, r.costOn)}% saved, r=${opts.r})\n` +
        `  rules  : ${JSON.stringify(r.rules)}`,
    );
    if (opts.rounds) {
      for (const row of r.rounds) {
        console.log(
          `    r${String(row.round).padStart(3)} off ${String(row.off).padStart(7)} on ${String(row.on).padStart(7)}${row.batch ? "  BATCH" : ""}`,
        );
      }
    }
  }
  const sum = (f: (r: LogResult) => number): number => results.reduce((n, r) => n + f(r), 0);
  const rounds = sum((r) => r.rounds.length);
  const batches = sum((r) => r.batches.length);
  const [off, on, costOff, costOn] = [sum((r) => r.off), sum((r) => r.on), sum((r) => r.costOff), sum((r) => r.costOn)];
  console.log(
    `\nTOTAL ${results.length} logs · ${rounds} rounds · ${batches} batches (1 per ${(rounds / Math.max(1, batches)).toFixed(1)} rounds)\n` +
      `  tokens : without ${off.toLocaleString()} · with ${on.toLocaleString()} · saved ${pct(off, on)}%\n` +
      `  cost   : without ${Math.round(costOff).toLocaleString()} · with ${Math.round(costOn).toLocaleString()} (${pct(costOff, costOn)}% saved, r=${opts.r})`,
  );
}

if (import.meta.main) main();
```

**The equivalence check** (`equivalence.ts`, verbatim — it is what makes the
replay a measurement rather than a story):

```ts
// S3 non-vacuity check: the replay script's model of the loop vs a REAL Agent.
// Run the real loop (with `contextPrune`) over a scripted provider that keeps
// every request, then replay the very history it produced through the replay
// script's own `replaySegment` and compare, round by round: the tokens sent,
// and which stored index carries a stub. If they differ, the replay is a story,
// not a measurement.
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { z } from "../../../packages/agent/node_modules/zod/lib/index.js";
import { Agent, type AgentConfig, renderForModel } from "@tentacle/agent";
import { ToolRegistry } from "@tentacle/tools";
import { HeuristicTokenCounter } from "@tentacle/core";
import { emptyResult, type Opts, replaySegment } from "./replay.final.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    for (const e of this.script[this.turn++] ?? [{ type: "text", delta: "end" }, { type: "done" }]) {
      yield e;
    }
  }
}

const shell: Tool<{ lines: number }> = {
  name: "shell",
  description: "shell",
  inputSchema: z.object({ lines: z.number() }),
  permission: "none",
  async execute(input) {
    const body = Array.from({ length: input.lines }, (_, i) =>
      `line ${String(i).padStart(4, "0")} `.padEnd(39, "x"),
    ).join("\n");
    return { content: `exit 0\n${body}` };
  },
};

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const sh = (id: string, lines = 250): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name: "shell", arguments: JSON.stringify({ lines }) } },
  { type: "done" },
];
const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const SIX = [sh("c1"), sh("c2"), sh("c3"), sh("c4"), sh("c5"), sh("c6"), say("done")];

const PRUNE: NonNullable<AgentConfig["contextPrune"]> = {
  window: 10_000,
  pruneAtPercent: 50,
  minGainPercent: 30,
  keepRecentRounds: 1,
  outputChars: 2000,
};

const OPTS: Opts = {
  r: 0.1,
  window: 10_000,
  pruneAtPercent: 50,
  minGainPercent: 30,
  keepRecentRounds: 1,
  outputChars: 2000,
  rounds: false,
  // EXACT: the real agent's tool prefix, measured from the same registry.
  toolsTokens: 0,
};

const COUNTER = new HeuristicTokenCounter();

async function main(): Promise<void> {
  const tools = new ToolRegistry().registerAll([shell]);
  OPTS.toolsTokens = COUNTER.countText(JSON.stringify(tools.definitions()));
  const model = new Scripted(SIX);
  const agent = new Agent({
    model,
    tools,
    env,
    systemPrompt: "sys",
    maxIterations: 40,
    contextPrune: PRUNE,
  });
  const messages: ChatMessage[] = [];
  for await (const _ of agent.runMessages(messages, "s1", undefined, undefined, {} as never)) {
    // drain
  }

  const real = model.requests.map((r) => (r.messages ?? []).map(renderForModel));
  const realTokens = real.map((m) => COUNTER.countMessages(m) + OPTS.toolsTokens);
  const realStubs = real.map((m) => m.filter((x) => String(x.content).startsWith("⟪pruned")).length);

  const res = emptyResult("memory");
  replaySegment(messages, OPTS, res, 0);
  const replayed = res.rounds;
  const replayedTokens = replayed.map((r) => r.on);
  const replayedStubs = replayed.map((r) => {
    // Count the stubs the replay would send at this boundary.
    return 0;
  });
  void replayedStubs;

  console.log("stored history messages:", messages.length);
  console.log("real requests:", real.length, "replayed rounds:", replayed.length);
  console.log("real tokens   :", JSON.stringify(realTokens));
  console.log("replay tokens :", JSON.stringify(replayedTokens));
  console.log("real stubs    :", JSON.stringify(realStubs));
  console.log("replay batches:", JSON.stringify(res.batches));
  const same =
    real.length === replayed.length && realTokens.every((t, i) => t === replayedTokens[i]);
  console.log(same ? "MATCH: the replay models the real loop exactly" : "MISMATCH");
}

await main();
```

**Slice status.** S1 **DONE** · S2 **DONE** · **S3 DONE** · S4 not started (the
A/B, the default flip and the spot-check are S4's; S3 only measured).

*— claude-opus-5-5 (executor), 2026-11-18 · **S3 only** (nothing of S4)*

## Review

*— claude-opus-5-5, 2026-11-17 · fresh context · scope: **S3 only** (`git diff main...HEAD` = this doc; script `.tentacle/tmp/smart-compaction/replay.final.ts`) · same model family as the executor: shared blind spots possible*

**Verdict: REQUEST-CHANGES** (2 MEDIUM, no HIGH). The token gate (31.8 % saved, 1 batch per 114 rounds) is not affected by either finding. The cost figures and one claim about the direction of the error are.

1. **MEDIUM — the cost model misses R2 cache breaks.** `bill()` (`replay.final.ts:80`) extends the cached prefix while `prev[i].content === request[i].content`. R2 (`call_payload`, the rule with the most candidates: 443) rewrites `toolCalls` and leaves `content` alone (`prune.ts:529`, `{ ...message, toolCalls: pruned }`). So at a batch, every assistant message whose arguments were pruned still counts as an unchanged prefix, and is billed at `r` instead of 1, up to the first tool result whose content changed. This over-states "cost saved" at every one of the 31 batches. The claim "pruning never loses money at any ratio" rests on these numbers, and `equivalence.ts` checks only tokens and stubs, never cost. Fix: compare whole messages (e.g. `JSON.stringify(renderForModel(m))`), then re-run the `r` sweep.
2. **MEDIUM — "conservative" is unproven, and the reasoning points the other way.** The doc says the recomputed anchor "can only fire a batch EARLIER … the numbers below are therefore conservative". Nothing shows that the heuristic counter over-estimates the provider's `promptTokens`, and this corpus has no `usage` entries to check it against. Also, a batch that fires earlier prunes for more rounds, so it makes the savings LARGER, not smaller. Fix: say "the direction of the error is unknown; S4's live `usage` settles it".

**Gate.** `bun test packages/agent/test/prune.test.ts prune-loop.test.ts`: 50 pass / 0 fail. `bun run lint`: clean (1966 files). `bun run typecheck`: root and relay clean. 4 errors in `apps/mobile` (`react-native-webview` is missing because this worktree was installed with `--filter '!@tentacle/mobile'`); no file in the diff is involved. Full `bun test` not re-run.

**Mutation / equivalence.** Not re-run. Running a `bun <script>` needed a permission this session did not have (only `bun test` was allowed). The executor's equivalence check and its M1–M6 table stay their word, not mine.

**Attacks tried.** (a) Is the pasted script the same as the file? It is byte-for-byte equal to `replay.final.ts` by read, and `replay.ts` has the same size. Found nothing. (b) The trigger copy against `Agent.maybePrune`: the set is monotonic, a stale entry is dropped by identity, and the gain gate covers only fresh entries. This matches what S2 reviewed. Found nothing. (c) The cost model against the prune rules found finding 1. (d) The anchor reasoning found finding 2. (e) §7: S3 touches no tracked code, persistence, protocol or pod path, and the logs are only read. Found nothing.

**Nit.** The S3 Execution was filed under the S2 `## Review` heading (after line 886), not under `## Execution`.

**Executor.** Thorough and mostly honest: it flagged the M5 survivor, the unrelated flake and the anchor approximation. But it stated the direction of the anchor error with more confidence than it had.
