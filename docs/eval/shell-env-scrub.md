# eval/shell-env-scrub — should the shell child stop inheriting the full `process.env`?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `fix` · Size: S · Blast: cross-module (the shell exec path + the shared `scrubSensitiveEnv` seam) · Suited: a weaker model may execute, standard Review — the approach is fixed and the helper is pre-tested.

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** should the shell tool stop handing the spawned
child the host's *full* `process.env`, and if so with what scrub policy?

**Evidence (verified).** Both shell spawn sites inherit the entire environment:
- `packages/exec/src/host-execution.ts:80` (foreground `exec`) — `env: options?.env ? { ...process.env, ...options.env } : process.env`.
- `packages/exec/src/host-execution.ts:132` (`spawnBackground`) — identical.

So a model-driven `echo $TENTACLE_MODEL_API_KEY` (or any child it spawns) reads
the user's provider key straight out of the inherited env. Redaction of tool
*output* (`result-pipeline.ts`) does not save us: the model chooses the echoed
string, and exfiltration need not go through rendered output at all (it can be
piped to a network command).

**This is a defect, not an open design question.** The fix already exists in the
codebase and was written *anticipating this exact case*:
`packages/core/src/env.ts:20` `scrubSensitiveEnv` — a denylist
(`API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|…`, `isSensitiveEnvKey`) that keeps
ordinary vars (`PATH`, `HOME`, `LANG`) and drops secret-looking ones. Its
docstring names "a shell command" and the literal `echo $TENTACLE_MODEL_API_KEY`
scenario. It is already used for MCP server subprocesses (Block 7) and is
unit-tested (`packages/core/test/env.test.ts`). The shell exec path simply does
not call it yet.

**Tracked as** `TODO.md:35` (Block 1 🔵).

## Implementation

*(empty — an eval is not built until promoted to a `fix`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: fix it, and promote straight to a `fix` task.** There is no
real decision to hold in `eval` — the approach is settled:

- Scrub both spawn sites with the existing denylist helper:
  `env: scrubSensitiveEnv(options?.env ? { ...process.env, ...options.env } : process.env)`.
  Reusing `scrubSensitiveEnv` (denylist) over a hand-rolled allowlist keeps one
  source of truth and the same policy the MCP path already uses — consistent,
  and already tested.
- **One deliberate edge to decide at implementation:** the user's *explicit*
  `options.env` is merged *before* the scrub, so a user who intentionally sets a
  `*_TOKEN` for a command would have it dropped. Options: (a) scrub only
  `process.env`, then overlay `options.env` unscrubbed (honour explicit intent);
  (b) scrub the merged result (strict). Lean **(a)** — the leak is the inherited
  ambient env, not what the caller explicitly passes; the MCP path already
  honours explicit `spec.env`. Pin this with a red-first test either way.
- **Regression test (§9, red-first):** a fake spawner capturing the child `env`;
  assert `TENTACLE_MODEL_API_KEY` is absent and `PATH` present after the fix
  (fails on today's code — it leaks the key). Cover both `exec` and
  `spawnBackground`.

**Promotion trigger:** on the owner's OK, `git mv` this doc to
`docs/fix/shell-env-scrub.md` and open branch `fix/shell-env-scrub`.

**What would change the recommendation:** nothing short of a reason the shell
*must* see provider secrets (none known — the model/provider creds stay on the
laptop and never need to be visible to a shell child).
