# fix/shell-env-scrub — scrub secret-looking env vars from the shell child

> **Status:** done — merged to `main` (b6d6b85) · status synced by audit 2026-10-19
> **Branch:** `fix/shell-env-scrub`
> **Type:** fix · **Size:** S · **Blast:** cross-module (the shell exec path + the shared `scrubSensitiveEnv` seam) · **Suited:** a weaker model may execute, standard Review — the approach is fixed and the helper is pre-tested.
>
> Promoted from `docs/eval/shell-env-scrub.md` on 2026-10-17 (owner OK).

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

*— qwen3.8-27b-ud, 2026-10-17*

### Load-bearing assumption

**The env of the spawned child is exactly the `env:` field of `Bun.spawn`** —
both shell sites hand it `options?.env ? { ...process.env, ...options.env } :
process.env` verbatim (`packages/exec/src/host-execution.ts:80` foreground
`exec`, `:132` `spawnBackground`). So transforming that single expression with
the existing `scrubSensitiveEnv` removes the leak with no other moving part.
Proven by reading both sites; no second spawn path exists in `@tentacle/exec`
(`rg "Bun.spawn" packages/exec/src` → only those two).

### Preconditions

- `scrubSensitiveEnv(env)` is a pure denylist copy that drops
  secret-looking keys and `undefined` values, keeping `PATH`/`HOME`/`LANG`
  (`packages/core/src/env.ts:20`), unit-tested in `packages/core/test/env.test.ts`.
- It is exported from `@tentacle/core` (`packages/core/src/index.ts:9`
  `export * from "./env.ts"`), and `@tentacle/exec` already depends on
  `@tentacle/core` (`packages/exec/package.json`) and already imports types
  from it in `host-execution.ts` — so the import is free.
- The identical pattern is already in production for MCP server subprocesses,
  honouring the caller's explicit env *unscrubbed on top of* the scrubbed base:
  `packages/mcp/src/transport.ts:31-36` (`baseEnv = scrubSensitiveEnv(process.env)`
  then `{ ...baseEnv, ...spec.env }`). We reuse that exact shape — the policy
  for "what a child sees" stays one source of truth across both spawn families.
- No §7 invariant is touched: this is a leaf change inside one package's
  execution implementation; no protocol, persistence, or terminal-IO change.

### Design

At both sites, split the env into **scrubbed ambient base** + **explicit
overlay**, mirroring `mcp/transport.ts`:

```ts
const baseEnv = scrubSensitiveEnv(process.env);
env: options?.env ? { ...baseEnv, ...options.env } : baseEnv,
```

Decision on the eval's one open edge — **option (a)**: scrub only
`process.env`, then overlay `options.env` unscrubbed. Rationale (as in the
eval): the defect is the *inherited ambient* env; a caller that explicitly
passes a `*_TOKEN` opted in, and the MCP path already sets that precedent.
(`ExecOptions.env` is `Readonly<Record<string, string>>`,
`core/src/execution.ts:17`.)

Extract a single private helper on `HostExecution` so the policy lives in one
place:

```ts
/** The child env: host env minus secrets, with the caller's explicit env overlaid. */
private childEnv(options?: ExecOptions): Record<string, string> {
  const base = scrubSensitiveEnv(process.env);
  return options?.env ? { ...base, ...options.env } : base;
}
```

### Files

1. `packages/exec/src/host-execution.ts` — add `scrubSensitiveEnv` to the
   `@tentacle/core` import; add `childEnv()`; replace both `env:` expressions
   (~lines 80, 132).
2. `packages/exec/test/host-execution.test.ts` — red-first regression tests
   (below).
3. `TODO.md` — flip the Block 1 🔵 item to `[x]` with the fix summary.

### Failure modes

- **A command that genuinely needs a secret env var** (e.g. user's own
  `GH_TOKEN` for `gh`): it is dropped, and the command fails with the same
  "command not found / auth error" it would have had without the env — no
  new crash path; the user can pass it explicitly via `options.env` (the
  overlay). This is the accepted, documented trade-off of the denylist, same
  as the MCP path.
- **Explicit `options.env` value is `undefined`**: `scrubSensitiveEnv` drops
  `undefined` from the base only; the overlay copies `options.env` as-is,
  matching today's behaviour exactly (no new failure).
- **`exec` and `spawnBackground` drift**: both call the same `childEnv()`, so
  they cannot diverge; the test covers both.
- **Background job streams**: `spawnBackground` returns live pipes, untouched
  by this change.

### Tests

Red-before-green (`packages/exec/test/host-execution.test.ts`), driving the
real `Bun.spawn` seam — the observable is the *child's* env, so the child
itself prints it:

1. **`exec` does not leak inherited secret-looking vars** — with
   `TENTACLE_MODEL_API_KEY=leak-me` and `MY_ACCESS_TOKEN=leak-me` set on the
   test process env, `exec("env")` (or `printenv`-style) must contain no
   `TENTACLE_MODEL_API_KEY`/`MY_ACCESS_TOKEN` and still contain `PATH`.
   **Red on today's code** (the key is present).
2. **`spawnBackground` does not leak either** — same assertion via the
   background handle's stdout.
3. **Explicit `options.env` overlay is honoured unscrubbed** — `exec` with
   `{ env: { MY_CUSTOM_TOKEN: "explicit" } }` *does* see
   `MY_CUSTOM_TOKEN=explicit` (pins decision (a); prevents over-scrubbing the
   overlay in a future "simplification").

Restore any `process.env` mutation in `afterAll` (or per-test) so the suite
stays hermetic.

## Execution

*— qwen3.8-27b-ud, 2026-10-17*

In order:
1. **Red first** — added the three tests to `packages/exec/test/host-execution.test.ts`
   and ran them on the unfixed code: 2 fail, 1 pass. The failures show the
   exact leak — the child's `printenv` output contains
   `TENTACLE_MODEL_API_KEY=leak-me` in both `exec` and `spawnBackground`.
   (The overlay test passing pre-fix is expected and intended: it pins
   decision (a), not the bug.)
2. **Fix** — `packages/exec/src/host-execution.ts`: added
   `scrubSensitiveEnv` to the `@tentacle/core` import; new private
   `childEnv(options)` (scrubbed ambient base + unscrubbed `options.env`
   overlay); both `Bun.spawn` sites now use `env: this.childEnv(options)`.
3. **Green** — `bun test packages/exec`: 19 pass / 0 fail.
4. **Lint drift (not in plan)** — `bun run check` failed at lint: my test's
   `delete process.env.X` restore tripped `noDelete` (4×, a known baseline
   trip per AGENTS §6). Restructured the restore into a save/restore
   `withEnv` helper (strictly more hermetic than the planned `delete`) with a
   computed-key `delete` for the undefined case. This was the only deviation;
   the fix itself landed exactly as planned.
5. **Gate** — `bun run check` green: typecheck clean, lint 0 errors/0 warnings,
   **649 pass / 1 skip / 0 fail** (88 files; the skip is the opt-in live-k8s
   test). Note: the §6 baseline says 540 pass (2026-10-16) — the suite has grown
   since; the live run is the number of record, not the pinned one.
6. `TODO.md` Block 1 item flipped to `[x]` with the fix summary.

Skipped: nothing.

## Review

*— qwen3.8-27b-ud, 2026-10-17 (fresh-context reviewer)*

Reviewer caveat (per the brief): I am the **same model family as the executor**
with fresh context only — that is weaker than a different-model review.
Nothing found below is load-bearing, but if the owner treats finding 1 as
actionable, it deserves a second, different-model look.

**Verdict: APPROVE-WITH-NITS.** The fix is correct, minimal, and pinned by
non-vacuous red-first tests. One genuine residual (a denylist gap on this
repo's own env surface) plus one reviewer-process incident to disclose;
neither blocks.

### Gate (re-run by the reviewer, not the executor's word)

- `bun run check`: **green** — `tsc --noEmit` clean; `biome check .` over
  251 files, 0 errors / 0 warnings; tests **649 pass / 1 skip / 0 fail**,
  2007 expect() calls, 650 tests across 88 files (the skip is the opt-in
  live-k8s test, `TENTACLE_K8S_SERVER`). Matches the Execution's report
  exactly.
- `bun test packages/exec`: 19 pass / 0 fail (3 files);
  `bun test packages/exec/test/host-execution.test.ts`: 9 pass / 0 fail
  (14 expect() calls) — the three `child env scrubbing` tests all green.
- Acceptance greps: exactly two `Bun.spawn` sites in `packages/exec/src`
  (`host-execution.ts:79,131`), both `env: this.childEnv(options)`
  (`:81,133`); the old `options?.env ? { ...process.env, ...options.env } :
  process.env` expression is gone (0 matches).

### Test non-vacuity by mutation (§9)

Pre-snapshot `git diff > /tmp/pre-mutation.diff`; after every mutation,
revert and confirm the full `git diff` is byte-identical to the pre-snapshot
(all three confirmed).

| # | Mutation | Expected failure | Observed |
|---|---|---|---|
| 1 | `childEnv` base left unscrubbed (`{ ...process.env }`) | leak tests 1+2 fail | **7 pass / 2 fail** — both leak tests fail; the child's `printenv` output literally contains `TENTACLE_MODEL_API_KEY=leak-me`; overlay test passes (as intended) |
| 2 | Scrub the merged result: `scrubSensitiveEnv({ ...process.env, ...options?.env })` | overlay test 3 fails | **8 pass / 1 fail** — overlay fails (`Expected "explicit", received "unset"`); leak tests pass |
| 3 | Revert ONLY the foreground `exec` site to the old expression | exec leak test fails | **8 pass / 1 fail** — exec leak test fails while the `spawnBackground` leak test passes (proves both sites are independently covered, not just one); overlay passes |

Each mutation fails **exactly** the test that pins the property it broke and
nothing else: no new test is green on both old and new code, so the suite is
not vacuous.

**Reviewer incident (disclosed).** The brief's suggested revert command,
`git checkout -- packages/exec/src/host-execution.ts`, is **unsafe for this
task because the fix is uncommitted**: on the mutation-1 revert it restored
the file from HEAD, discarding the fix instead of undoing my mutation. I
detected it immediately (the post-mutation diff no longer matched the
pre-snapshot) and recovered byte-exactly from the pre-mutation snapshot
(re-applied the saved diff hunk to a `git show HEAD:` copy); the restored
blob hashes to `4ba3a8f209e76a8073514e36fae457dd02af6825`, exactly the
`index` hash in the snapshot's header. Mutations 2–3 then used a file-copy
revert with hash verification. The final tree is byte-identical to how it was
found (full `git diff` comparison clean). Process note: for tasks with
uncommitted changes, mutation reverts must restore from the pre-snapshot —
never `git checkout`.

### Findings

1. **Denylist gap on this repo's own env surface (nit; follow-up).**
   `TENTACLE_POD_TLS_KEY` and `TENTACLE_POD_TLS_CERT` carry **PEM data** when
   configured inline — `packages/k8s/src/pod-cleanup.ts:81-84` hands them
   straight to Bun's `tls.{ca,cert,key}`, which accepts PEM strings — but
   `SENSITIVE_KEY` (`packages/core/src/env.ts:11-12`) does not match them;
   verified empirically, both pass the scrub. So an inline-configured pod TLS
   client key still reaches the shell child (and the MCP child). This is a
   property of the *shared, pre-existing* helper (the MCP path has the same
   exposure), not of this task's code — out of scope for an S task, but the
   `TODO.md` flip to `[x]` is slightly ahead of reality for that case.
   Recommend a follow-up TODO (extend the denylist, or document the gap). The
   primary threat — the provider key the TODO names — is fixed.
2. **The overlay is not a model self-injection backdoor (verified — holds).**
   The only model-driven caller, `shellTool.execute`
   (`packages/tools/src/builtins.ts:270-290`), builds `ExecOptions` from
   `cwd`/`timeoutMs`/`signal` only; its input schema (`:247-262`) has no
   `env` field. The unscrubbed `options.env` overlay is therefore reachable
   only by human/API callers — decision (a) is safe against the stated threat
   model.
3. **No missed model-driven spawn site (verified).** All spawn sites in
   `packages/` accounted for: `exec` (both fixed), MCP stdio
   (`mcp/transport.ts:31-36`, already scrubs — the fix matches its shape
   exactly), `config/src/load.ts:124` (`apiKeyCommand` — user-configured, not
   model-driven), `cli/src/flags.ts:50` (`--token-command` — user flag, not
   model-driven), `tui/src/clipboard.ts:34,54` (fixed OS binaries, no model
   input), `k8s/src/pod-cleanup.ts:155` and `k8s/src/kube-auth.ts:63`
   (out of scope per the brief). None is a model-driven shell path; nothing
   missed.
4. **The `withEnv` restructure is correct and hermetic (documented drift
   judged OK).** `packages/exec/test/host-execution.test.ts:62-77`: saves the
   exact prior state per key (including `undefined`), restores in `finally`
   (so it runs even if an assertion throws), and restores the absent case via
   a computed-key `delete` (satisfies `noDelete` — the documented reason for
   the drift). It is strictly more hermetic than the plan's bare `delete`: it
   restores pre-existing values instead of only clearing. Matches what is on
   disk; it is the only deviation and it is justified.
5. **Assertions pin the property, not a correlate (verified).** The leak
   tests assert the exact `KEY=value` line is absent *and* that `PATH=` is
   still present (guards against over-scrubbing); the value `leak-me` is set
   by the test itself, so a value-shifted leak could not slip through. Test 3
   pins decision (a) — mutation 2 proves it would bite.

### What holds / what does not

**Holds:** minimal fix at exactly the right seam (the `Bun.spawn` `env:`
field *is* the child's entire env — the load-bearing assumption confirmed at
both sites); one private policy helper shared by both sites (drift
impossible; mutation 3 corroborates both are covered); policy identical to
the MCP stdio transport, so "what a child sees" stays one source of truth
across spawn families; red-first behaviour corroborated (mutation 1
reproduces the Execution's described leak failure verbatim, in both `exec`
and `spawnBackground`); no §7 invariant touched (leaf change; the
pod-lifecycle "secrets via env, never argv" invariant is reinforced, not
brushed); `ExecOptions.env` is `Readonly<Record<string, string>>`
(`core/src/execution.ts:17`), so the overlay type-checks as written.

**Does not fully hold:** the denylist is open-ended by construction — a
secret-looking name matching no regex fragment still leaks (finding 1 is the
instance on this repo's own surface). Accepted and documented trade-off,
identical to the MCP path; worth a standing TODO rather than a blocker.

### Scope check

Clean. The working-tree diff is exactly this task:
`packages/exec/src/host-execution.ts` (one import line, two `env:`
expressions, one private helper), `packages/exec/test/host-execution.test.ts`
(one new `describe` block, no edits to existing tests), `TODO.md` (Block 1
item flipped with fix summary), `docs/fix/shell-env-scrub.md` (eval→fix
promotion, rename staged per §10, four sections filled). No unrelated
refactors; neighbouring open items (e.g. `BackgroundJobs` reaping) untouched.
No deferred-phase work leaked in.

### Executor behaviour

Clean mechanical apply, no corruption. The fix landed exactly as designed
(`childEnv` body identical to the plan's snippet; both sites replaced; TODO
flipped as specified). One documented drift (`withEnv` for `noDelete`),
assessed in finding 4 as correct and strictly better than planned. The
Execution narrative matches the on-disk state throughout, including the gate
counts (649/1/0 reproduced by the reviewer).

*— qwen3.8-27b-ud, 2026-10-17 (fresh-context reviewer)*
