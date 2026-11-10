# eval/session-tree — should the session log become a tree (branch, rewind, fork from any message)?

> **Status:** context · review (pending the owner's verdict)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** — · **Blast:** load-bearing (persistence, §7) · **Suited:** — (decision record; the recommended tasks are sized below)

## Context

*— claude-opus-5-5, 2026-11-10*

### 1. The question

Owner, 2026-11-09 (`TODO.md` `eval/session-tree`): should `<uid>.jsonl` become a
TREE — each entry has `id` + `parentId`, a moving "current leaf", branching from
any earlier message, the old branch kept in the same file — as pi does (`/tree`,
`/fork`)? The owner's intuition: *"ho l'impressione che ci potrebbe risolvere un
sacco di cose in maniera pulita, o sbaglio?"* Candidates named: clear-fork-history,
superseded history (compaction / `context_reset`, `sessions.keepSuperseded`),
rewind/retry from a message, an abandoned-branch summary, the §7 rewrite/set-aside
machinery. Costs named: format change, a file that never shrinks, two writers,
`session/log` over the wire, sub-agent markers.

**Today's model, in 10 lines.**

1. The daemon owns the live `messages` array; the log is DERIVED from it by a reference diff at commit points (`packages/daemon/src/session-log.ts:1-23`, `commit` `:100-119`).
2. Every entry already carries an envelope `id` (`"<incarnation>/<seq>"`) and `prev` — *"the parent link — a fork is detected, never spliced"* (`packages/protocol/src/session-log.ts:7-10`, `:85-97`).
3. Entry types: critical `base`/`message`/`replace`/`truncate`; skippable `title`, `checkpoint`, `turn_start`/`turn_end`, `call_started`, `subagent_background`/`subagent_end` (`session-log.ts:12-17`, `:237-250`).
4. Projection = one shared fold (`projectEntry`, `session-log.ts:261-288`): `base` empties, `message` appends, `replace` sets an index, `truncate` shortens. A `base` starts a segment (create, seed, reload, compact, context_reset — `:104`).
5. `truncate` exists in the format and the deriver (`session-log.ts` daemon `:109-111`) but *"A shrink behind a cut — none exists today"* (`daemon/src/session-log.ts:12-13`): nothing rewinds.
6. Laptop file = header `{format, schemaVersion: 1, id, cwd, model, createdAt}` + entries; the projection is the LAST complete segment's fold (`daemon/src/session-log-file.ts:6-13`, `:40-53`).
7. Save: a linear read that continues the file's last entry is APPENDED (`session-log-store.ts:638-670`); anything else REPLACES the file atomically, after setting aside a last segment that is not "contained" (`:7-14`, `settleLast` `:790-835`).
8. A restatement `base` (seed/reload) or a same-lineage one drops the old segment as "contained" by final-projection prefix (`:817-825`); a compaction/reset drops it unless `keepSuperseded` (`:799-814`; key doc `packages/config/src/key-docs.ts:760-769`, laptop and `serve` each read their own host's flag: `cli/src/tui-sessions.ts:76-77`, `cli/src/serve.ts:124-125`).
9. `serve` writes the same format plus a sidecar `<uid>.state.json` (`DAEMON_STATE_VERSION = 1`) written AFTER the log; its `logHead` is the point a reload folds THROUGH (`daemon/src/daemon-state-file.ts:1-21`, `:42`, `:375-379`; `foldThrough`/`entriesThrough` `session-log-file.ts:355-414`).
10. `/clear` forks the old chat into a NEW session (cold write from messages, `store.fork`; binding owner requirement QC(b), `docs/feat/clear-fork-history.md:13`, decisions `:304-317`); a cut turn is closed when LOADED (`closeAtLoad`, `session-log-file.ts:450-467`); pods never persist (AGENTS §7).

There is no rewind today: `/retry` re-sends the last prompt as a new turn
(`packages/tui/src/App.tsx:2243-2257`); it removes nothing.

### 2. pi's model (verified 2026-11-10)

Sources read: `earendil-works/pi` `packages/coding-agent/docs/session-format.md`,
`sessions.md`, `compaction.md` (raw.githubusercontent.com, `main`); `badlogic/pi-mono`
`packages/coding-agent/src/core/session-manager.ts` (the README now points to
`earendil-works/pi`). The first ~40 k of 64.5 k chars of `session-manager.ts` were
read verbatim; the rest only as a summary (marked **[S]**).

- **File:** JSONL, `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`. Header
  `{type:"session", version:3, id, timestamp, cwd, parentSession?}`
  (`CURRENT_SESSION_VERSION = 3`).
- **Entries:** `message`, `thinking_level_change`, `model_change`, `usage`,
  `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit`,
  `label`, `session_info`. EVERY entry has `id` (8 hex chars of a UUID, collision-
  checked), `parentId` (`null` at the root), `timestamp`.
- **Leaf:** in memory only (`leafId`); a new entry's `parentId = leafId`, then the
  leaf moves to it. On load the leaf is **the last entry in file order**. No
  persisted pointer entry was found.
- **Context:** walk leaf → root (`buildSessionPath`); the latest `compaction` on
  that path contributes its `summary`, then entries from its `firstKeptEntryId`,
  then everything after it. Compaction **never deletes** entries.
- **`/tree`:** moves within the same file. Picking a user message puts its text
  back in the editor; picking another entry continues after it. Leaving a branch
  can append an LLM-written `branch_summary` (`parentId` = the branch point,
  `fromId` = the old leaf), budgeted newest-first up to the common ancestor.
- **`/fork`:** a NEW file (new session id) holding the path, `parentSession` =
  the original file's path; the original is untouched. **[S]** it rewrites parent
  links along the copied path.
- **Migration:** v1 → v2 added `id`/`parentId` (and `firstKeptEntryIndex` →
  `firstKeptEntryId`); migrated on load and the file rewritten in place.
- **Concurrency:** `appendFileSync` per entry; the first write uses `"wx"`. No
  file lock found (**[S]** for the unread part). One process writes a file.
- `label` entries (`targetId`, `label`) bookmark points; `session_info` names it.

**What this says.** pi's tree is the SOURCE of truth: the in-memory leaf plus
append-only writes by ONE process, context rebuilt from the path. A "branch
switch" is not recorded as such — it is just that the next appended entry has an
older `parentId` (and the leaf after a reload is the last line).

### 3. A tree for tentacle — the smallest shape that fits our invariants

**The finding that changes the question:** our log is already an *operation log
with parent links*. Every entry has an id and a `prev`; the projection at ANY
entry is a fold through it (`foldThrough`, already used by `serve`'s reload). A
rewind to message *k* is `truncate{length:k}` followed by the new messages — a
critical entry type that exists, is folded by both readers, and on the laptop is
APPENDED in a linear save (`session-log-store.ts:668`), so the abandoned branch's
entries stay physically in the file before it. The tree is therefore **derivable**
from the log we have: each `message` entry is a node; its parent is the message
that preceded it in the projection at that point; a `truncate` is a branch point.
The "current leaf" is the end of the file on the laptop and the sidecar's
`logHead` on `serve` — both already exist.

Two shapes, then:

- **T1 — derived tree over the op-log (no format change).** Keep entries as they
  are; add (a) a daemon rewind that shortens the live array between turns, so
  `commit` emits `truncate`; (b) a store rule that keeps a segment holding an
  abandoned branch instead of dropping it as "contained"; (c) a pure
  `logTree(parsed)` that indexes branch points across segments; (d) UI.
- **T2 — pi's tree as the source of truth.** Add `parentId` to every entry (or
  redefine `prev` as the parent), drop `replace`/`truncate` (a change becomes a
  new child), make compaction an entry whose context starts at a kept id, persist
  a leaf, rebuild context by walking leaf → root. `SESSION_LOG_VERSION` 2,
  `PROTOCOL_VERSION` bump (the critical table changes, `session-log.ts:17-19`).

Under T2 the leaf must be persisted somewhere other than "the last line" if we
ever want to switch branches without appending — on the laptop that is a new
entry (e.g. `leaf{to}`, non-critical); on `serve` the sidecar's `logHead` already
plays that role. Under T1 a branch switch IS an append (`truncate` + messages),
so the leaf stays "the end", exactly as pi treats it after a reload.

### 4. What a tree would subsume

| Candidate | Subsumed? | Why — what goes away vs stays |
|---|---|---|
| **clear-fork-history** (`/clear` keeps the old chat as its own session) | **No — and should not.** | The binding requirement is a SEPARATE session listed in `--resume`/`/sessions` (`clear-fork-history.md:13`). pi agrees: its `/fork` writes a new file too. A tree could make `/clear` a branch instead, but then the old chat leaves the session list — a reversal of QC(b). `store.fork` / `session-fork.ts` stay; they are the natural "fork from here" of a tree view (cold write from a fold-through). |
| **Superseded history** (compaction, `context_reset`, `keepSuperseded`) | **Partly — and it is a setting, not a structure.** | Our `base{compact}` already is "compaction as an entry"; what drops history is `keepSuperseded` off (`session-log-store.ts:652-666`, `:801-814`). pi keeps everything always. Making it "always on" is a default flip available today, with or without a tree; it removes the setting and the `superseding` branch of `settleLast`. The cost is the file size (§5). A tree adds the ability to *show* the superseded part, which T1's `logTree` also gives. |
| **Rewind / retry from a message** | **Yes in capability, but not because of the format.** | This is the real new feature. The disk side is already expressible (`truncate` + append). The hard parts are NOT on disk: a daemon request to shorten the live array at a safe point (no turn running), the TUI's transcript dropping items, sub-agents/jobs started on the abandoned branch (they stay session-level, as with `/clear`), and workspace files that are NOT reverted. T2 makes none of these easier. |
| **Abandoned-branch summary** | **No (orthogonal).** | A model call over the dropped messages, appended as a `message` with a note — expressible today. pi stores it as `branch_summary{fromId}`; we would need no new type unless we want to link it to the old leaf (a skippable field). |
| **§7 rewrite / set-aside machinery** | **Partly; the biggest potential win AND the biggest risk.** | An append-only file removes the compaction `replace` path. In T2, a divergent writer's content could be kept as a SIBLING branch instead of an aside file — cleaner than `.stale-*.aside`. But asides also cover: another daemon incarnation whose `base{seed/reload}` restates messages under NEW ids (a tree would duplicate them as a subtree unless deduplicated by digest), unknown non-critical lines on a rewrite, a cold/rebased read after a failed write. The lock, torn-line tolerance, `schemaVersion` refusal and pod re-serialization stay in every option. This machinery went through many review rounds (`session-archive.md` R1–R3, `clear-fork-history.md` R1–R2); rewriting it is the riskiest change on the table. |
| **Sub-agent markers** | **No — a tree fits them worse.** | Jobs/sub-agents belong to the SESSION, not to a branch (`/clear` keeps them: `clear-fork-history.md` decisions table, "Markers"). On a tree path they would vanish from the context of a sibling branch while still running; `subagentLoadNotes` would have to scan the whole file, not the path. In T1 they stay session-level entries in file order, as today. |
| suspended-turn-resume, `closeAtLoad`, session-archive | **Unaffected (T1) / re-derived per path (T2).** | A rewind is allowed only between turns, so turn markers stay balanced; `closeAtLoad` keeps working on the last segment. The archive stamp lives in the sidecar. |

### 5. Costs and risks (and how each converges)

| Risk | T1 (derived tree) | T2 (pi tree) |
|---|---|---|
| **Format change** | None: same entry types, `SESSION_LOG_VERSION` 1, no `PROTOCOL_VERSION` bump for the log (a new `session/rewind` method is free: unknown → `MethodNotFound`, §7). An old build reading a rewound file folds `truncate` correctly. | `SESSION_LOG_VERSION` 2 + `PROTOCOL_VERSION` bump. Old logs: dual-read (v1 fold, v2 path walk) or migrate-on-load like pi; the owner's precedent is "no conversion" (`session-log-store.ts:23-25`), which would orphan every existing session. Sidecar `DAEMON_STATE_VERSION` 2 (its `k`/`tail` overlay is a prefix of a LINEAR projection, `daemon-state-file.ts:8-14`). An old build refuses a v2 file loudly — converges, but users lose `--resume` across a downgrade. |
| **File never shrinks** | Only abandoned branches are added (user-made, rare); compaction keeps today's behaviour unless the owner flips `keepSuperseded`. Load = parse whole file (already true) + fold the last segment. | Append-only forever: every compaction keeps its history. Load must parse every line to index ids (pi does exactly this). Needs a later "compact the file" (rewrite to the current path) — which brings the rewrite machinery back. Converges only with that extra task. |
| **Two writers** | Note: laptop and `serve` write DIFFERENT files (`<sessions>/…` vs `<configDir>/daemon/<projectKey>/…`); `connect` keeps no laptop copy (§7). The real multi-writer case is two TUIs + a relay on ONE laptop file, under the lock, "append only what the file lacks" by id (`:673-683`). A `truncate` is just another entry of the same daemon lineage: unchanged. | Same lock; but "append what the file lacks" becomes "attach under the right parent", and a writer that lost the race to a sibling must decide which leaf is current. pi never faces this (one process per file). New failure surface. |
| **`session/log` + `open{messages}`** | Unchanged: the reader's cursor `after` stays linear; a `truncate` is folded by `projectEntry` on both ends. A resume seeds `open{messages, logBase}` with the current path (`protocol/src/session.ts:619-630`) — already "the path". | The daemon stays linear (it owns an array), so the wire stays linear too; the tree would exist ONLY on disk, re-linearised at every save and seed. Two models of one history to keep in sync. |
| **Pods** | Unchanged: the pod daemon emits `truncate`, the laptop validates and re-serializes it (F4); the pod writes nothing. A rewind is a laptop-originated request. | Same, but the laptop must also mint `parentId`s for pod-derived entries (pod ids are untrusted). |
| **Crash mid-append** | Unchanged: torn last line ignored (`session-log-file.ts:17-19`); a rewind is one batch of entries in one append. | Same tolerance; a lost `leaf` entry (if one is used) reverts to the last line — benign. |
| **Cut turn closed at LOAD** | Unchanged: rewind is refused while a turn runs, `closeAtLoad` reads the last segment. | `openTurns` / `started` must be computed along the path, not the segment; every loader changes. |
| **Live-path novelty** | `commit`'s shrink branch has never run live (`daemon/src/session-log.ts:12-13`): the rewind task must test it end to end (daemon → reader → both stores → reload). | — |

### 6. Beyond pi — does pi's design fit us, and is there something better?

**What in pi is genuinely good for us.** (1) *Never delete*: compaction is an
entry, not a rewrite. That suits offline viewing and an honest history, and our
`base{compact}` is already that shape; only our default (`keepSuperseded` off)
differs. (2) *Context = the path, leaf = the last line after a reload*: the same
rule as T1's "the end of the file". (3) **`branch_summary`** is the best idea in
pi for an *agent*: the point of keeping a failed path is that the model does not
repeat it. (4) Labels: cheap, and they would be one non-critical entry for us.

**What does not fit, and why.** (1) *The tree as the source of truth, written by
ONE process.* In tentacle the daemon owns the live array. A write inside a turn
is a synchronous capture (`SessionPersister.schedule`, the steering window) of
an O(n) pointer diff. The laptop is a validating replica that cannot trust a
pod's ids (F4, §7). Several laptop writers share one file under a lock, and
`serve` keeps its own file and sidecar. pi's in-memory leaf works because one
process writes; ours would need a leaf protocol between writers. (2) *A branch
is only a position in a file.* What a tentacle branch would have to carry
(running jobs, background sub-agents, the workspace) is live and session-level,
and a conversation branch cannot fork it. The pi docs read show no background
job or sub-agent ledger. (3) *Conversation-only rewind.* In a coding agent the
cost of a failed path is mostly in the WORKSPACE (edited files), and neither pi
(as far as read) nor (B) restores it.

**What users actually do with history here, and the best tool for each:**

| Need | Best tool |
|---|---|
| rewind / retry from a message | rewind (B task 1) |
| try an alternative and compare | a PARALLEL branch: Alt 1 |
| keep a failed path for reference | the model: Alt 2's lesson; the human: the kept branch (B task 2) |
| hand a branch to a sub-agent | Alt 1 |
| resume elsewhere | already solved (`--resume`, `attach`, `connect` + `session/list`); a tree adds nothing |

**Alt 1 — "fork into a sub-agent".** From a message (or the tree view), start a
BACKGROUND sub-agent whose conversation is seeded with the history up to that
point. Today a child starts from an isolated, fresh conversation
(`agent/src/subagent.ts:1-13`). It works on the alternative while the main
session continues, and its report comes back through the existing ledger
(`subagent_end`, persisted, capped) and two-way messages. A branch then becomes
a *live, named, parallel* thing (the `sa-N` id plus a description), which a file
tree cannot give: pi's branches are sequential, one leaf at a time. It fits the
invariants: no format change, daemon-side (one session path), pods unchanged.
Costs: (a) **workspace collision**: the child shares the parent's confined
environment, so two write-capable branches edit the same files. It is honest
only for read-only types (explore/plan) until per-child workspace isolation
exists (e.g. a git worktree through `ctx.env`, not available in every image or
pod; a separate eval). (b) **tokens**: seeding a long history multiplies the
cost; `feat/subagent-token-budget` is the guard. (c) Only the child's report is
kept, not its history. **Beats (B)?** For "try and compare" and "hand off a
branch", yes, because (B) cannot run two branches at once. It does not replace
rewind. **M** read-only, **L** with workspace isolation.

**Alt 2 — "a rewind carries its lesson" (a summary as the default carry-over).**
After the `truncate`, a rewind appends a short note message: "tried …; abandoned
because …". The model writes it from the dropped messages, daemon-side, through
the laptop's model, like `/compact`. A "rewind clean" option skips it. The model
keeps what failed without carrying the whole failed path; the raw path stays in
the file for the human (B task 2). This is better than pi's *optional*
`branch_summary` as a default, because an agent forgetting what failed (and
repeating it) is the common failure after a retry. No format change: note kinds
are constants, and the wire note is fail-soft, so an older build shows the text
and drops only the note (`core/src/model.ts:82-94`,
`protocol/src/session.ts:70-78`). Cost: one model call per rewind. **Beats (B)?**
It is an upgrade INSIDE (B), not a rival: it moves the summary from optional
task 4 into task 1.

**Considered, not proposed: workspace checkpoints on rewind.** This is what
makes a rewind fully safe in a coding agent. But our workspace lives wherever
`ctx.env` is (laptop, docker, pod), shell commands change it as well as edit
tools, git-based snapshots need git in the image plus a policy for untracked
files, and a snapshot held in a pod is pod-supplied state (§7). It deserves its
own eval (Q4).

**Verdict.** pi's file tree does not beat (B) for us. The better idea is to keep
apart two things pi merges into one tree: *history*, which is sequential (B plus
Alt 2's lesson), and *exploration*, which is parallel and best served by a seeded
sub-agent (Alt 1), not by a file format.

**`/clear`, compaction, `context_reset` — first principles.** All three are already
ONE mechanism on disk: a new `base` segment in the SAME session (`/clear` since
`docs/feat/clear-keeps-jobs.md` Context; `base.reason` `compact`/`context_reset`,
`protocol/src/session-log.ts:104`). They differ only in what happens to the old
segment. `/clear` also writes a NEW session holding it (`store.fork`), then drops
it from the live file; the other two drop it. With `keepSuperseded` on, all three
keep it in the file, where nothing can show it yet. The clean model is
**chapters**: a session is a sequence of segments. A boundary changes what the
MODEL sees, never what the DISK keeps. The tree view (task 3) shows chapters and
rewound branches together. What the user wants later decides each case:
- **`/clear` → keep as is (defer any change).** What the user looks for later
  is "that other conversation", in `/sessions` / `--resume`, where the fork is,
  resumable as itself (binding QC(b), just merged). A chapter alone would hide it
  inside the live session. Cost of keeping both once chapters are kept: the old
  chat is stored twice (the live file + the fork). Possible later step, not now:
  a lazy fork (the chapter in the tree view, `store.fork` only on "continue it").
  That reverses QC(b), so it is the owner's call (Q9).
- **`/compact` (user-initiated) → change: keep the detail by default.** The
  user chose a smaller CONTEXT, not to lose the exact outputs and decisions.
  Once task 3 can show them, dropping them saves only disk. Cost: each kept
  chapter is about one context window of text, since compaction runs near the
  window and big tool results are already spilled. `parseLogFile` parses every
  line on load, so the load time grows with the number of chapters. `serve`
  lists sessions from the sidecar and the first line only (§7), and its
  sidecar's `logHead` sits in the last segment: neither is affected. →
  Flip `sessions.keepSuperseded` to default ON in task 2, after measuring a
  load of a synthetic file with many chapters; the key stays as an opt-out.
  AGENTS §7 says "default off", so this edit to AGENTS.md rides the same
  `feat` branch (§10).
- **`context_reset` (model-initiated) → change, more strongly than compaction,
  but it reverses an owner decision.** The model decided to drop its context.
  With auto-accept on, the user may never have seen the prompt. The restart
  prompt is the model's own lossy summary, so if it forgot something, the dropped
  detail is the only way back. The owner decided "non salviamo nessun messaggio
  precedente" (`docs/eval/context-reset.md` decision 4, 2026-10-25), before
  `keepSuperseded` and a tree view existed. Proposal: the same rule as
  compaction (kept on disk, shown as a chapter "reset by the model" with its
  restart prompt). What the MODEL gets stays exactly as decided. Q10.
- **Deferred:** a model-side "recall from an earlier chapter" tool (a pod
  daemon does not hold the laptop's file, so it would be a pod-requested laptop
  read, gated per §7), and search across sessions. Both need their own eval.

### 7. Options

- **(A) Full tree (T2).** pi's model as the source of truth on disk. Gains: one
  conceptual model, siblings instead of asides, superseded history always kept.
  Costs: every persistence module (`session-log-file`, `-store`, `daemon-state-file`,
  the reader), a format + protocol bump, old logs, a second history model beside
  the daemon's array, file growth needing its own compaction. Size: **XL → must
  split** (≥ 4 L tasks, all load-bearing). The capability it buys over (B) is
  mostly "siblings instead of aside files".
- **(B) Derived tree over the op-log (T1) — recommended.** No format change.
  Split:
  1. `feat/session-rewind` — `session/rewind{toMessage}` (new method; between
     turns only), the daemon shortens its array → `truncate`; the TUI drops the
     items after it and puts the chosen user message back in the editor (pi's
     `/tree` behaviour); jobs/sub-agents untouched; a notice that files are NOT
     reverted. **M · load-bearing** (agent loop + persistence).
  2. `feat/keep-history` — "a boundary never deletes": in `settleLast`, a segment
     that holds a `truncate` dropping committed messages is never "contained";
     `sessions.keepSuperseded` defaults to ON (compaction and `context_reset`,
     the latter only if Q10 is (a)), measured first on a many-chapter file; the
     AGENTS §7 wording changes with it. **S–M · load-bearing.**
  3. `feat/session-tree-view` — pure `logTree(parsed)` (chapters and branch
     points across all kept segments, each chapter labelled by its `base.reason`)
     + a read-only `/tree` panel; "fork from here" = the existing `store.fork`
     with a fold-through copy. **M · cross-module.**
  Task 1 includes **Alt 2** (the lesson note, with "rewind clean" to skip it):
  task 1 is still **M**, now with one model call.
  Total ≈ **L**, as 3 legible tasks.
- **(D) Fork into a sub-agent (Alt 1)** — a separate follow-up, not part of this
  tree work: read-only types first (**M · load-bearing**, after
  `feat/subagent-token-budget`); write-capable branches wait for a
  workspace-isolation eval.
- **(C) No — keep linear + targeted features.** Only task 1 (rewind), abandoned
  history dropped at the next `base` as today. Size **M**. Loses the "the old
  branch stays" half of the owner's ask.

### 8. Owner questions

1. **Which shape?** (a) B with Alt 2 — a tree derived from today's log, a rewind
   that carries its lesson, no format change; (b) A — pi's tree on disk;
   (c) C — rewind only. **Recommendation: (a).**
2. **Fork semantics.** (a) `/clear` and "fork from here" stay NEW sessions (QC(b),
   and pi's `/fork` does the same); (b) `/clear` becomes a branch in the same
   file. **Recommendation: (a).**
3. **What is kept in the file.** (a) rewound branches always kept, compaction
   still governed by `keepSuperseded` (default off); (b) also flip `keepSuperseded`
   to default ON (chapters: "a boundary never deletes"), after a load-time
   measurement; (c) nothing extra. **Recommendation: (b)** — changed from (a):
   once the tree view can show superseded chapters, dropping them saves only
   disk (section 6, "`/clear`, compaction, `context_reset`").
4. **Rewind and the workspace.** (a) conversation only, with an explicit notice
   that files are not reverted, plus a separate eval `eval/workspace-checkpoints`;
   (b) conversation only, no eval; (c) block (B) until files can be restored.
   **Recommendation: (a).**
5. **Rewind with background jobs/sub-agents running.** (a) allowed, they stay
   session-level (as `/clear`); (b) refused while any runs. **Recommendation: (a).**
6. **The lesson note on rewind (Alt 2).** (a) the default, with "rewind clean" to
   skip it; (b) opt-in only (pi's behaviour); (c) later, as its own task.
   **Recommendation: (a)** — this answer changed: the summary was optional
   task 4, and the "Beyond pi" analysis makes it the default.
7. **Fork into a sub-agent (Alt 1).** (a) record it as a follow-up `feat`
   (read-only types first) after `feat/subagent-token-budget`; (b) also open the
   workspace-isolation eval now, so write-capable branches can follow; (c) drop it.
   **Recommendation: (a).**
8. **Queue position.** (a) tasks 1–3 after `fix/detach-open-items`; (b) right now.
   **Recommendation: (a)** — the TODO already orders `fix/detach-open-items`
   (3: a safety-relevant permission bug) right after this eval.
9. **`/clear` once chapters are kept.** (a) as today: a NEW session (fork) in
   `/sessions`, the chat also kept as a chapter in the live file (stored twice);
   (b) as today, but the live file drops the cleared chapter (no duplicate; the
   fork is the only copy); (c) a lazy fork: a chapter only, forked into a session
   on "continue it" (reverses QC(b)). **Recommendation: (a)** for now; revisit (c)
   after the tree view is in use.
10. **`context_reset` on disk** (reverses decision 4 of `docs/eval/context-reset.md`).
    (a) kept like compaction (a chapter "reset by the model" with its restart
    prompt; the model's fresh context unchanged); (b) keep decision 4: dropped,
    unless `keepSuperseded` is set. **Recommendation: (a)** — it is the one
    boundary the user may not have chosen, and the dropped detail is the only
    way back if the restart prompt missed something.

## Implementation

— (eval)

## Execution

— (eval)

## Review

*— claude-opus-5-5, 2026-11-10*

**Verdict: pending the owner's verdict.**

**Architect's recommendation (not a decision): Option (B), with Alt 2 (a rewind
carries its lesson) in task 1, and Alt 1 (fork into a sub-agent) as follow-up
(D).** The owner's
intuition is half right. A tree is the right *mental model* for "branch from any
message, keep the old branch" — and our log is already most of one (ids, parent
links, `truncate`, fold-through, an append path). It is not the right *disk format
change*: of the candidates, only rewind gains a capability, and that needs a
daemon operation and UI, not a new format; clear-fork-history should stay a
separate session (pi does the same); sub-agent markers fit a tree worse; superseded
history is a default, not a structure; the rewrite/aside machinery would shrink
only by rebuilding the most-reviewed code in the repo. (B) delivers the
user-visible features of pi's `/tree` with no `schemaVersion` or protocol bump.
Looking past pi ("Beyond pi"), the better design separates sequential *history*
(B plus the lesson) from parallel *exploration* (a seeded sub-agent). The real
open gap, in pi and here alike, is restoring the workspace on a rewind (Q4).
For `/clear`, compaction and `context_reset`, the rule is *chapters*: a boundary
changes the model's context, never the disk. `/clear` keeps its fork as is;
compaction keeps its detail by default (task 2); `context_reset` likewise, if the
owner reverses decision 4 (Q10).

**Unverified (pi):** whether a plain `/tree` navigation without a summary writes
any entry (the leaf seems to be in memory only, so it would revert to the last
line on reopen — inferred, not read); `createBranchedSession` internals (summary
only); whether pi reverts workspace files on `/tree` (not found in the docs read);
locking in the unread part of `session-manager.ts` (summary says none).
