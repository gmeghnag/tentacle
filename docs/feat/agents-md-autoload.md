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

*— <executor model-id>, <date>*

<!-- As-built: the walk helper, the composition, the defeat switch, the tests
(red shown first where claimed), and ANY drift from Design (and why). Record the
gate result and exact test counts. Confirm the additive guarantee (no AGENTS.md
→ identical prompt) empirically. -->

## Review

*— <reviewer model-id>, <date> (fresh context — load-bearing: a different/stronger model)*

<!-- MANDATORY fresh-context, load-bearing. Re-run the gate; red-team the
prompt-assembly seam: additive guarantee holds (absent → byte-identical)? walk
bounded against symlink loops? unreadable AGENTS.md cannot crash startup?
override+AGENTS interaction as specified? Confirm test non-vacuity by mutation.
Explicitly restate that the folder-TRUST mitigation is deferred and that v1 loads
a repo's AGENTS.md unconditionally — is that acceptable for how this is used
today, and is the follow-up filed? Sign which model reviewed (different from the
executor for a load-bearing task). -->
