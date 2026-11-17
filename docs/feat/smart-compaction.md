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
| R1 superseded read | `fs_read` result of path P when a LATER successful `fs_read` of P covers the same range, or a later successful `fs_write`/`fs_edit`/`fs_multi_edit` of P | path, range, size, the round that superseded it | `fs_read P` again (the file is the truth) |
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
- `/compact` and `context_reset` replace the history: the WeakMap entry dies
  with the old objects (a reset reuses the array — `messages.length = 0`,
  `agent.ts:2550` — so the reset path also `pruneState.delete(messages)`).
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
- **`/compact`, `context_reset`, `/clear`** → state dropped with the history.
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

S1 (`packages/agent/test/prune.test.ts`), each property exact:
- user/assistant `content` is byte-identical before/after for every rule;
- R1 prunes an earlier read of P after a later full read / a successful edit
  of P; does NOT after a failed edit, nor a later read of a different range;
- R2 replaces only payload fields of a successful write/edit; a failed one is
  untouched; the result parses as a JSON object;
- R3 keeps head/tail/exit; R4 keeps the spill path; R5 only exact duplicates;
- the protected tail and skill results are never candidates;
- stubs are deterministic (two computations → identical bytes);
- `modelView(applyPrune(h))` reports zero repairs.

S2 (agent loop with a fake provider capturing `request.messages`):
- below threshold → requests identical to today (pins "no behaviour change off");
- crossing threshold → one batch; the next N requests share the exact pruned
  prefix bytes (pins cache stability); a second batch only after the gain gate;
- stored `session.messages` byte-identical to an unpruned run (pins "log intact");
- `context_reset` / `compact` drop the state; a fresh `Agent` over a reloaded
  history recomputes;
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

*(empty until Implementation is approved)*

## Review

*(empty)*
