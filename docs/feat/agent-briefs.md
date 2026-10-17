# feat/agent-briefs — standard executor & reviewer briefs

> **Status:** implementation (ready to execute)
> **Branch:** `feat/agent-briefs`
> **Size:** S · **Blast:** contained · **Suited:** Opus authors (the briefs encode non-obvious discipline — the executor stop-rules and the review-independence insight); standard in-context Review (docs-only, no §7 invariant touched).

## Context

*— claude-opus-4-8, 2026-10-17*

A fresh tentacle agent starts with **only** the ~90-word `PROMPT.md`
(`config/src/resolve.ts:163` — `systemPrompt = env | PROMPT.md | default`; no
project-context loader exists today, grep-verified). It does **not** have
AGENTS.md, the task doc, or any operating discipline unless explicitly given.
So every time we spawn Qwen to execute or review a task, the quality hinges on
the ad-hoc prompt we hand it.

We saw this play out on `feat/tui-brand-color`: Qwen autonomously generated a
genuinely strong review prompt — but with two **structural** gaps a standard
would have closed:

1. it declared *"fresh context — the executor was a different model"* when it was
   the **same** model spawning its own reviewer (fresh *context* ≠ fresh
   *model*); the independence it claimed did not exist.
2. it was **verification-shaped** ("confirm X holds") rather than
   **attack-shaped** (red-team the plan *itself* — did it miss a site? is the
   invariant actually sufficient?).

The fix is to stop reinventing the spawn prompt each time: two reusable,
copy-at-spawn **briefs** — one for the executor, one for the reviewer — that
carry the discipline AGENTS.md defines but a fresh agent does not yet hold.

**Decision (owner, 2026-10-17):** two **separate files** (`docs/EXECUTOR-BRIEF.md`,
`docs/REVIEWER-BRIEF.md`), pointed to from AGENTS §10 — **not** inlined into
AGENTS.md. Two reasons: a brief is an *instantiable artifact* (a prompt to copy),
the same category as `docs/TASK-TEMPLATE.md`, which §10 already references rather
than inlines; and inlining would tax every always-on context with prompt text
that is only needed at spawn time (the same bloat argument that keeps the
codebase-tour out of a weak model's window). This also deliberately keeps
AGENTS.md **lean** — which matters more once `feat/agents-md-autoload` injects
AGENTS.md into every session.

## Implementation

*— claude-opus-4-8, 2026-10-17*

### Load-bearing assumption

At spawn the agent holds **only** `PROMPT.md` + tool schemas — **not** AGENTS.md
and **not** the task doc. Verified: `config/src/resolve.ts:163` (the single
`systemPrompt` source), `config/src/agent.ts:138` (seeded as the lone
`{role:"system"}` message), and no project-context loader anywhere (grep).
Therefore each brief's **first instruction must be to read AGENTS.md + the task
doc** — it cannot assume they are present. (After `feat/agents-md-autoload`
lands, AGENTS.md *will* be in the system prompt; the "read AGENTS.md" step then
degrades gracefully to a confirmation — still correct, never wrong.)

### Preconditions (verified)

- AGENTS §10 already defines the lifecycle, the Size/Blast axes, and the routing
  rule (who executes, how hard Review is). The briefs **operationalise** §10;
  they must **not restate** its rules (that would create a second source of
  truth that drifts). The brief = a thin wrapper that points at §10 + the task
  doc and adds only the spawn-time choreography.
- `docs/TASK-TEMPLATE.md` is the doc the executor fills (its **Execution**
  section) and the reviewer fills (its **Review** section). The briefs reference
  those sections by name.
- Precedent: AGENTS §10 references `docs/TASK-TEMPLATE.md` as a separate file
  rather than inlining it — the briefs follow the same shape.

### Design

Two short files (each ≲ one screen — brevity is a feature; a bloated brief
re-creates the problem it solves). They share a 3-line preamble, then diverge.

**Shared preamble (both):**
> You are working on exactly ONE task in this repo. Before anything else, read
> `AGENTS.md` (§0 anti-loop, §4 verify, §9 tests, §10 workflow) and the task doc
> `docs/<type>/<slug>.md`. Open only the files the task names. Never invent file
> contents you have not read. If reality contradicts the task doc, STOP and
> report — do not retry with guessed text.

**`docs/EXECUTOR-BRIEF.md` adds:**
- Work only on the task's branch; keep edits minimal and faithful to the
  Implementation's Design; don't reformat unrelated lines.
- For a fix: write the regression test and show it RED first (§9), then green.
- When a site doesn't match the plan: reconcile it with the Design, or STOP and
  report — never invent.
- Before "done": fill the **Execution** section honestly (as-built + any drift
  and why), then run the task's acceptance checks and `bun run check` — it must
  be green.

**`docs/REVIEWER-BRIEF.md` adds (an ADVERSARIAL pass, not a rubber stamp):**
- Do NOT trust the task doc; verify every claim against the code.
- Re-run the gate (`bun run check`); record exact counts.
- Run the task's acceptance checks (grep-guards, etc.).
- Confirm test **non-vacuity by mutation** (§9): break the property, see the
  test fail, revert, confirm byte-identical.
- **Attack the plan itself, not only its checklist** *(correction 1)*: ask what
  would make this wrong that the Implementation did not consider — a missed
  site, an insufficient invariant, another code path reaching the same state.
  The plan's own "Failure modes" list is the *floor*, not the ceiling.
- **Sign honestly which model reviewed** *(correction 2)*: if the reviewer is
  the *same* model that executed (only a fresh context), say so plainly and note
  that same-model/fresh-context is **weaker** than a different/stronger model —
  shared blind spots survive both passes. A load-bearing task wants a different
  model (AGENTS §10 routing).
- Write the task doc's **Review** section: verdict first
  (APPROVE / APPROVE-WITH-NITS / REJECT), then numbered findings with
  `file:line` evidence; state what holds, what does not, and how the executor
  behaved.

**AGENTS §10 pointer:** add one line to the §10 "Index & registries" area —
"a fresh executor/reviewer agent is spawned with `docs/EXECUTOR-BRIEF.md` /
`docs/REVIEWER-BRIEF.md`" — so the brief is discoverable from AGENTS without
being loaded verbatim into every context.

### Files

- `docs/EXECUTOR-BRIEF.md` — **new**, per Design.
- `docs/REVIEWER-BRIEF.md` — **new**, per Design (with corrections 1 & 2).
- `AGENTS.md` §10 — **one** pointer line (no rule restated here).

### Failure modes

- *Brief restates AGENTS rules → two sources drift.* Mitigation: the brief is a
  pointer + spawn-time choreography only; rules stay in AGENTS, referenced by §.
- *Brief assumes AGENTS.md is already present (false today).* Mitigation: step 1
  orders reading it; correct both before and after `agents-md-autoload`.
- *Brief grows into a second manual → same bloat we reject.* Mitigation: the
  ≲ one-screen cap is part of the Design, enforced in Review.

### Tests

Docs-only; no code test. `bun run check` must stay green (Biome skips Markdown,
so this is really just "didn't break anything"). The **real** validation is
dogfooding: the **next** task (`feat/agents-md-autoload`) is executed and
reviewed *using these briefs* — if the briefs were unusable, that run would show
it. Record that in this task's Review.

## Execution

*— claude-opus-4-8, 2026-10-17*

Authored by Opus (knowledge-bearing content), in order:

1. `docs/EXECUTOR-BRIEF.md` — new. Shared preamble (read AGENTS §0/§4/§9/§10 +
   the task doc, open only named files, never invent, STOP-and-report) + the
   executor specifics: minimal faithful edits on the task branch, red-before-green
   for fixes, narrow per-slice tests, fill **Execution** honestly, gate green vs
   the §6 baseline before done, escalate-don't-spin when blocked.
2. `docs/REVIEWER-BRIEF.md` — new. Same preamble, then the adversarial pass:
   don't trust the doc, re-run the gate + acceptance checks, mutation
   non-vacuity, **correction 1** ("attack the plan, not just its checklist — the
   Failure-modes list is the floor") and **correction 2** ("sign which model
   reviewed; same-model/fresh-context is weaker than a different model"), verdict
   first + numbered `file:line` findings + how the executor behaved.
3. `AGENTS.md` §10 — one new "Agent briefs" bullet after "Index & registries"
   pointing at both files and stating they operationalise (not restate) §10, and
   why the brief is the priming channel (a fresh agent has only `PROMPT.md`).

**Drift from Design:** essentially none. Two deliberate refinements, both within
the Design's intent: (a) each brief opens with an HTML comment ("copy the body,
fill `<type>/<slug>`, keep ≲ one screen, cross-link the counterpart") so the
*file* is self-documenting without that text bleeding into the copied prompt;
(b) the §10 pointer is a **new bullet** rather than an edit to the "Index &
registries" bullet — cleaner separation, same one-line-pointer spirit. No rule
from §10 is restated in either brief (verified: each only references sections by
number). Each brief is ≲ one screen.

**Verification:** `bun run check` → green (typecheck ✓, lint ✓; Biome skips
Markdown so the two new docs + the AGENTS.md edit carry no lint surface; full
test suite unchanged). Grep: `EXECUTOR-BRIEF|REVIEWER-BRIEF` resolves to the two
files + the §10 pointer; no other references dangling.

## Review

*— <reviewer model-id>, <date>*

<!-- Adversarial pass: confirm the briefs operationalise §10 without restating it
(no drift source), that each is ≲ one screen, that the reviewer brief carries
corrections 1 & 2, and that the §10 pointer resolves. Gate green. Note whether a
later task was actually run through these briefs (dogfood evidence). -->
