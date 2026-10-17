# feat/agents-md-autoload — auto-load AGENTS.md into the system prompt

> **Status:** implementation (ready to execute)
> **Branch:** `feat/agents-md-autoload`
> **Size:** M · **Blast:** load-bearing · **Suited:** Opus executes (it shapes the system prompt of EVERY session — a seam everything depends on, AGENTS §7); **mandatory fresh-context Review** red-teaming the prompt-assembly seam. NOT Qwen.

## Context

*— claude-opus-4-8, 2026-10-17*

Today a tentacle session's system prompt is **only** the ~90-word `PROMPT.md`
(verified: `config/src/resolve.ts:163` — `systemPrompt = env | PROMPT.md |
default`; `config/src/agent.ts:138` seeds it as the lone `{role:"system"}`
message; no project-context loader exists anywhere, grep). The repo's operating
rules (`AGENTS.md` — invariants, test commands, the task workflow) reach the
agent **only** if it happens to `fs_read` them. A weak model that forgets to
runs on 90 generic words — precisely where the loop / `fs_edit`-corruption class
originates.

Claude Code already auto-loads `AGENTS.md` as project instructions. If tentacle
loads the **same file**, then *every* agent — strong or Qwen, any harness — sees
identical repo rules: one source of truth for "the rules of this repo", the same
single-source principle we just applied to the brand colour.

`PROMPT.md` and `AGENTS.md` are **different in kind** and must **compose**, not
replace: `PROMPT.md` is the agent's *identity* (per-user, `~/.config/tentacle/`);
`AGENTS.md` is the repo's *rules* (per-repo, checked-in, versioned). AGENTS.md
presupposes an identity, it does not supply one.

**Decision (owner, 2026-10-17):** auto-load `AGENTS.md` found by walking from the
launch folder up to the repo/filesystem root, **appended to** `PROMPT.md` (never
replacing it). Additive and defeatable (no file → unchanged; a switch to
disable).

**Explicitly OUT of scope for now (owner):** the *folder-trust prompt*. A
checked-in `AGENTS.md` in an untrusted/cloned repo becoming agent instructions
is a real prompt-injection surface for an agent with shell + `fs_edit`. We are
**consciously deferring** the mitigation (a first-run "trust this folder?"
gate), not forgetting it — see Failure modes and the follow-up. v1 loads it
unconditionally when present.

## Implementation

*— claude-opus-4-8, 2026-10-17*

### Load-bearing assumption

The system prompt is assembled at **one** seam, so AGENTS.md can extend it
additively without scattering: `config/src/load.ts` reads the prompt file and
hands `promptFromFile` to `resolveConfig` (`load.ts:163-170`); `resolveConfig`
produces the single `systemPrompt` string (`resolve.ts:163`); `agent.ts:138`
seeds it as the only system message. We extend exactly this path — read one more
file in `load.ts`, compose in `resolve.ts` — and touch nothing else.

### Preconditions (verified)

- `load.ts:122` — `launchCwd = options.cwd ?? process.cwd()`: the walk's
  starting point already exists and is injectable (tests pass `cwd`).
- `load.ts:163-168` — prompt-file read is the model to copy for the AGENTS.md
  read (same `pathExists`/`readFile` pattern, same "absent → undefined").
- `resolve.ts:163` — `systemPrompt = pick(env.TENTACLE_SYSTEM_PROMPT,
  promptFromFile, DEFAULT_SYSTEM_PROMPT)`: the **base** (identity). Composition
  of base + AGENTS block belongs here (pure, unit-testable).
- `packages/config/test/load.test.ts` uses real temp dirs (`mkdtemp(tmpdir())`)
  with injected `configDir`+`cwd`; `resolve.test.ts` tests pure composition with
  injected `promptFromFile`. This dictates the test split below.
- AGENTS §7 "additive, reuse existing seams" (this is additive); §7 "never write
  raw to the terminal" and the persistence invariant are **not** touched (this
  only changes a string handed to the model).

### Design

Split by testability, per AGENTS §7 (logic in pure modules):

1. **I/O walk — `load.ts`.** New helper: from `launchCwd`, walk parents looking
   for `AGENTS.md`; stop at the first hit, at a `.git` directory boundary, or at
   the filesystem root (whichever comes first); bound the walk (≤ ~40 levels) so
   a symlink loop cannot spin. If found and readable, read it into `agentsMd`
   (absent/unreadable → `undefined`, never throw — see Failure modes). Pass
   `agentsMd` into `resolveConfig`.
2. **Pure composition — `resolve.ts`.** `resolveConfig` gains an optional
   `agentsMd`. The base system prompt is unchanged (`pick(env, PROMPT.md,
   default)`); when `agentsMd` is present and loading is enabled, the final
   `systemPrompt` is:
   ```
   <base prompt>

   # Project rules (AGENTS.md)

   <agentsMd contents>
   ```
   A delimited, labelled block **after** the identity. The source map records
   where AGENTS.md came from (add to `sources`).
3. **Defeat switch.** `env.TENTACLE_NO_AGENTS_MD` (truthy → skip) and/or a config
   flag `loadAgentsMd: boolean` (default true). Env wins, per the existing
   precedence. When disabled: behaviour is byte-identical to today.
4. **Interaction with the full override.** When `TENTACLE_SYSTEM_PROMPT` or a
   custom `systemPromptFile` provides the base, AGENTS.md **still appends** (it
   is repo-rules, orthogonal to whichever identity the base came from), unless
   the defeat switch is set. State this rule explicitly in a comment and a test.

Wire both ends: `load.ts` (read + walk), `resolve.ts` (compose + source),
`schema.ts` (the optional flag), `defaults.ts` (`AGENTS_FILENAME = "AGENTS.md"`),
`load.ts`'s `TentacleConfig` / `resolve.ts`'s `sources` (expose where it loaded
from), and `cli/src/main.ts` help text (document the env switch).

### Files

In dependency order:

- `packages/config/src/defaults.ts` — `export const AGENTS_FILENAME = "AGENTS.md"`.
- `packages/config/src/schema.ts` — optional `loadAgentsMd?: boolean`.
- `packages/config/src/resolve.ts` — accept `agentsMd`; compose the final
  `systemPrompt`; honour `TENTACLE_NO_AGENTS_MD` / `loadAgentsMd`; record source.
- `packages/config/src/load.ts` — the parent-walk + read; pass `agentsMd` into
  `resolveConfig`; surface the resolved AGENTS.md path on `TentacleConfig`.
- `packages/cli/src/main.ts` — one help line for `TENTACLE_NO_AGENTS_MD`.
- `packages/config/test/resolve.test.ts` + `test/load.test.ts` — tests below.

### Failure modes

- *No AGENTS.md anywhere* → `agentsMd` undefined → `systemPrompt` byte-identical
  to today. (The additive guarantee; pin it with a test.)
- *AGENTS.md unreadable (permissions) / read error* → warn-and-continue with the
  base prompt; **never crash startup** over an optional file. (Contrast
  `systemPromptFile`, which throws when explicitly set and missing — AGENTS.md is
  implicit, so it must be best-effort.)
- *Symlink / deep tree while walking up* → the ≤N-level bound + `.git`/root stop
  prevents an unbounded or looping walk.
- *Nested AGENTS.md (monorepo sub-package)* → v1 loads the **nearest** one found
  walking up and stops; multi-file merge is explicitly deferred (document it).
- *Full override + AGENTS.md* → defined rule (Design §4): appends unless the
  defeat switch is set; test both.
- *Token cost* → AGENTS.md (~7.4k today) is added to every session. Accepted:
  it is high-signal (the §0 anti-loop rules are exactly what a weak model needs
  always-on), unlike a low-signal codebase tour. This is also why AGENTS.md is
  kept lean (see `feat/agent-briefs`). Noted, not mitigated.
- *TRUST boundary (untrusted repo's AGENTS.md becomes instructions)* →
  **consciously deferred** (owner, this task). v1 loads it unconditionally.
  Follow-up: a first-run folder-trust gate. Flagged here and in Review, not built.

### Tests

Red-before-green where it pins new behaviour; use the existing fakes (real
tempdir in `load.test.ts`, injected values in `resolve.test.ts`).

- **`resolve.test.ts` (pure composition):**
  - `agentsMd` present → `systemPrompt` === base + `\n\n# Project rules
    (AGENTS.md)\n\n` + contents; base (identity) still leads. *(red first: today
    `resolveConfig` has no `agentsMd` param)*
  - `agentsMd` absent → `systemPrompt` === base, unchanged (additive guarantee).
  - `TENTACLE_NO_AGENTS_MD` set (or `loadAgentsMd:false`) + `agentsMd` present →
    base only.
  - `TENTACLE_SYSTEM_PROMPT` base + `agentsMd` present → both composed (override
    is still only the identity).
- **`load.test.ts` (the walk, real tempdir):**
  - AGENTS.md at the temp-repo root, `cwd` a nested subdir → `systemPrompt`
    contains the AGENTS block; resolved AGENTS path points at the root file.
  - no AGENTS.md in the tree → base only; `bun run check`-safe.
- Non-vacuity: mutate the delimiter/header the composition emits → the
  `resolve.test.ts` equality test fails (confirm, then revert).
- Full suite + `bun run check` green before done.

## Execution

*— claude-opus-4-8, 2026-10-17*

Implemented in dependency order:

1. `defaults.ts` — `AGENTS_FILENAME = "AGENTS.md"` with a doc comment.
2. `schema.ts` — optional `loadAgentsMd?: boolean` on the top-level file schema.
3. `resolve.ts` — `ResolveContext.agentsMd?`; `ResolvedConfig.agentsMdLoaded:
   boolean`; a pure `AGENTS_PROMPT_HEADER` const; the enable logic
   (`TENTACLE_NO_AGENTS_MD` truthy wins over `loadAgentsMd`, default on) and the
   compose (`base.trimEnd() + "\n\n# Project rules (AGENTS.md)\n\n" +
   agentsMd.trimEnd() + "\n"`), only when enabled **and** `agentsMd` is
   non-blank. `systemPrompt` source still tracks the identity's provenance.
4. `load.ts` — `findAgentsFile(startDir)`: walk parents from the launch cwd,
   first-hit wins, stop at a `.git` boundary (never escape the repo) or fs root,
   ≤40-step bound (symlink-loop guard); best-effort read (unreadable → undefined,
   never throws); pass `agentsMd` into `resolveConfig`; surface `agentsPath` on
   `TentacleConfig` only when actually folded in.
5. `cli/src/main.ts` — one help line for `TENTACLE_NO_AGENTS_MD`.
6. Tests — `resolve.test.ts` (6: append shape, additive guarantee, blank-as-
   absent, env disable + env-beats-file, file disable, full-override still only
   identity) and `load.test.ts` (4: walk-up append, absent → unchanged, env
   disable, and the **`.git`-boundary red-team** — a parent AGENTS.md must NOT
   be read).

**Verification:**
- Gate: `bun run check` → **green**, typecheck ✓, lint ✓ (after a Biome
  auto-format of two files — whitespace only), **645 pass / 1 skip / 0 fail**
  (was 636; +10 new tests). Narrow: `bun test packages/config/test` → 29 pass.
- Non-vacuity (§9): mutated `AGENTS_PROMPT_HEADER` → **3 tests failed**; reverted
  → 29 pass. The equality tests pin the exact composed string, not a correlate.
- Additive guarantee: the `resolve`/`load` "absent" tests assert the prompt is
  byte-identical to today, and the disabled path returns the base verbatim.
- End-to-end in THIS repo (temp config dir): `agentsPath =
  /Users/gmeghnag/tentacle/AGENTS.md`, prompt starts with the `PROMPT.md`
  identity, header present, AGENTS.md body appended (len ~20.4k); with
  `TENTACLE_NO_AGENTS_MD=1` → no `agentsPath`, base-length prompt.

**Drift from Design (honest):**
- *Provenance surface:* the Design said "record where AGENTS.md came from (add to
  sources)". I exposed it as a top-level `ResolvedConfig.agentsMdLoaded` +
  `TentacleConfig.agentsPath` instead of extending the exhaustive `sources`
  sub-object — deliberately, to avoid rippling the `sources`-exhaustive tests and
  keep the load-bearing blast minimal. Same information, smaller reach.
- *Walk origin:* starts from the **launch cwd** (per the plan's Precondition),
  not the resolved workspace cwd. Coupling discovery to the launch dir matches
  how Claude Code finds AGENTS.md and sidesteps a cwd/compose circular dep. A
  `TENTACLE_CWD` redirect pointing at a different repo's rules is a documented
  **non-goal** for v1.
- *Red-first:* tests and code were written together, so a literal red-run was not
  staged; non-vacuity is instead proven by the mutation above (the stronger §9
  check). The composition test would fail structurally on pre-change code
  (`agentsMdLoaded`/`agentsMd` did not exist).

**Deferred (unchanged from Context):** the folder-**trust** gate. v1 loads a
repo's AGENTS.md unconditionally — a known prompt-injection surface. Filed as a
`TODO.md` backlog item (folder-trust gate, `fix` · load-bearing); NOT built here.

**Post-review closes (nits from the fresh-context Review):**
- *Nit (a) — "follow-up filed" was an over-claim.* True at review time; now
  **made true**: the folder-trust gate is a `TODO.md` entry. Wording above
  corrected.
- *Nit (b) — best-effort read untested.* **Closed**: added
  `load.test.ts` "a present-but-unreadable AGENTS.md degrades to the base prompt
  — never crashes" (AGENTS.md as a directory → `readFile` EISDIR → swallowed →
  base prompt, no throw). Gate now 646 pass.
- *Nit (c) — subagents don't get AGENTS.md.* Acknowledged, **out of scope**;
  filed as a separate `TODO.md` eval (inject into subagent prompts vs document
  the briefs as the channel).

## Review

*— claude-opus-4-8, 2026-10-17 (fresh context)*

**Verdict: APPROVE-WITH-NITS.** The implementation is correct, additive, and
well-tested; the prompt-assembly seam is clean. The two nits below are
backlog/doc hygiene, not code defects — neither blocks merge.

**Reviewer-independence caveat (load-bearing task).** I am `claude-opus-4-8` —
the **same model** as the executor, running only in a **fresh context**. Per
AGENTS §10 routing and the reviewer brief, a load-bearing task wants a
*different or stronger* reviewer: same-model/fresh-context is **weaker**, because
shared blind spots survive both passes. Flagging so the owner can decide whether
a cross-model pass is warranted before relying on this.

### What I verified

1. **Gate (§4), re-run by me:** `bun run check` → typecheck ✓, lint ✓
   (`biome check .`, 251 files, no fixes), `bun test` → **645 pass / 1 skip /
   0 fail** (the skip is the opt-in live-k8s test, not a failure). Matches the
   Execution claim exactly. Narrow `bun test packages/config/test` → 29 pass.

2. **Single compose seam (confirmed).** The I/O walk lives only in
   `load.ts:90` (`findAgentsFile`) + the best-effort read at `load.ts:202-210`;
   the compose/enable decision lives only in `resolve.ts:176-182`
   (`AGENTS_PROMPT_HEADER` at `resolve.ts:97`). `grep` across `packages`
   finds no second site. The composed string flows through the existing path —
   `config.systemPrompt` → `wiring.ts:132` → the lone system message at
   `agent.ts:138`. No scattering; nothing in the agent loop, protocol, or
   persistence changed.

3. **Mutation non-vacuity (§9), run by me.** Mutated `AGENTS_PROMPT_HEADER`
   (`resolve.ts:97`) to `"# MUTATED HEADER"` → `bun test packages/config/test`
   → **3 fail** (`resolve.test.ts:181`, `:229`, `load.test.ts:188` — all pin the
   exact composed string, not a correlate). Reverted → working tree
   **byte-identical** (`git diff --quiet` clean) → **29 pass**. The equality
   tests are non-vacuous.

### Red-team of the plan (not just its checklist)

4. **Additive guarantee — holds.** With no AGENTS.md (or disabled, or blank),
   `agentsMdLoaded` is false and `systemPromptValue = systemPrompt.value`
   verbatim (`resolve.ts:180-182`) — the base is never `trimEnd`-ed on this
   path, so it is truly byte-identical, including its trailing newline. Pinned
   by `resolve.test.ts:189-193` and `load.test.ts:194-199`.

5. **Parent-walk — bounded and repo-scoped.** `findAgentsFile`
   (`load.ts:90-108`) checks `AGENTS.md` **before** the `.git` boundary at each
   level, so a repo-root AGENTS.md IS found, but a parent repo's is never read
   once `.git` is seen (`load.ts:98-100`); the `for i < 40` bound
   (`load.ts:92`) caps a symlink loop; `dirname(dir) === dir` stops at fs root
   (`load.ts:101-104`). `.git` as a *file* (worktrees/submodules) also bounds
   correctly since `pathExists` uses `stat`. The `.git`-boundary test
   (`load.test.ts:212-218`) proves the parent-repo case.

6. **Unreadable AGENTS.md — cannot crash startup.** `pathExists` swallows
   `stat` errors (`load.ts:75-82`); the read is wrapped in try/catch →
   `undefined` on failure (`load.ts:204-209`); `findAgentsFile` itself only
   calls pure path ops + `pathExists`, so it never throws. A permissions error
   degrades to the base prompt, as the plan requires. (Not pinned by a test —
   see nit (b).)

7. **Override interaction — as specified.** `TENTACLE_SYSTEM_PROMPT` and a
   custom `systemPromptFile` set only the *base* (`resolve.ts:175`,
   `load.ts:185-197`); AGENTS.md still appends unless the defeat switch is set.
   Precedence `TENTACLE_NO_AGENTS_MD` (truthy) > file `loadAgentsMd` > default-on
   (`resolve.ts:176-178`) is correct and tested (`resolve.test.ts:201-232`).

8. **§7 invariants — untouched.** The change only extends the string handed to
   the model. No terminal write, no persistence change, no protocol/schema wire
   change (the new `loadAgentsMd` is config-file-only, not protocol). Pure
   logic stayed in `resolve.ts`; I/O stayed in `load.ts` — consistent with the
   §7 "logic in pure modules" split.

9. **Scope — clean.** `git diff main...` touches only the six source/test files
   + this doc; no unrelated refactor. The `sources`-exhaustive sub-object was
   deliberately left alone (provenance surfaced as `agentsMdLoaded` /
   `agentsPath` instead) — a sensible minimization, honestly disclosed as drift.

### Folder-TRUST deferral (restated)

As required: **v1 loads any discovered repo's AGENTS.md unconditionally** —
a real prompt-injection surface for an agent with shell + `fs_edit` in a cloned
/ untrusted repo. The deferral is clearly documented (Context lines 35-40,
Failure modes line 138-140, Execution 219-221). **Acceptable for how tentacle is
used today** (the owner runs it in their own trusted repos; the `.git`-boundary
already prevents silently inheriting a *parent* repo's rules). It must not ship
to any multi-tenant / clone-and-run posture without the trust gate.

### Nits (non-blocking)

- **(a) The trust-gate follow-up is NOT actually filed.** The doc says it is
  "flagged … for Review and a follow-up task", but `TODO.md` (the backlog index
  per §10) has no entry, and there is no `docs/eval|fix` doc for it. The
  deferral is only recorded inside *this* task's doc, which merges and goes
  quiet. Recommend filing a `docs/eval/` (or `fix/`) item + a `TODO.md` line
  before this is relied on in any untrusted context.
- **(b) Best-effort read is unproven by test.** Finding (6) holds by code
  inspection, but no test exercises the unreadable/permission path (e.g. a
  `readFile` that throws → base prompt, no crash). Low risk (the catch is
  trivial), but the plan listed it as a failure mode; a one-line fake-throw test
  would pin it.
- **(c) Subagents do not receive AGENTS.md.** `subagent.ts:166` seeds
  `systemPrompt: type.prompt`, so a delegated child (often the weaker model —
  exactly the loop/`fs_edit`-corruption class the Context cites) does **not**
  get the repo rules. This is a defensible boundary (subagents get their own
  briefs), and out of this task's scope, but it is undocumented here and
  partially undercuts the stated motivation. Worth a one-line "non-goal" note.

### How the executor behaved

Clean, mechanical, honest. The as-built matches the code; the three disclosed
drifts (provenance surface, launch-cwd walk origin, tests-written-together vs a
staged red-run) are all reasonable and clearly labelled. The non-vacuity claim
(3 tests fail on header mutation) reproduced exactly. No corruption, no scope
creep, no over-claiming — the one gap is that the "follow-up filed" wording
overstates what was actually recorded (nit a).
