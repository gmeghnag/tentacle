# feat/remove-tentacle-cwd — the launch folder is the working folder

> **Status:** review (in-context) — awaiting merge OK
> **Branch:** `feat/remove-tentacle-cwd`
> **Size:** S–M · **Blast:** cross-module (config schema + CLI tests) · **Suited:** any model; standard review

## Context

*— claude-opus-5-5, 2026-10-20*

Owner decision (2026-10-20, from `docs/eval/agent-skills.md` point 4): remove
the separate tools cwd. Before this change, AGENTS.md was found from the launch
cwd (`config/src/load.ts:158,218`), while tools ran in
`TENTACLE_CWD ?? config cwd ?? launch` (`config/src/resolve.ts:186`). With an
override set, the model got the rules of one folder and worked in another.
Claude Code, opencode and pi have no such override. The variable has existed
since the initial commit (`HARNESS_CWD`) with no documented use case. Outside
`config` its only users were CLI tests. The owner explicitly skipped an eval
for this task.

**Repro (before):** `resolveConfig({ env: { TENTACLE_CWD: "/env-cwd" }, defaultCwd: "/launch", … }).cwd`
→ `"/env-cwd"` (the old `resolve.test.ts` "env overrides" assertion).

## Implementation

*— claude-opus-5-5, 2026-10-20*

Workspace = launch dir, always: `const cwd = defaultCwd` (`resolve.ts`), and
`sources.cwd` is gone. The `cwd` key is removed from the shared settings
shape (`schema.ts`), so it disappears at the top level **and** in profiles.
The MCP server `cwd` stays. Because the schema is `.strict()`, an old config
with `cwd` fails to load. `load.ts` adds the hint "`cwd` was removed: tentacle
works in the folder it is launched from". Pre-public, so no shim (AGENTS §7).
Docs: scaffold comment (`defaults.ts`), `--help` (`cli/src/main.ts`), `README.md`.

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Tests first. In `config/test/load.test.ts`: "rejects the removed `cwd` key
   with a hint (top level and in a profile)" and "TENTACLE_CWD is ignored".
   In `resolve.test.ts`, the env test now expects `/launch`. **Red: 3 fail**
   on the old code.
2. Source changes as above → config tests 52 pass / 0 fail.
3. CLI tests: 6 of them already passed `loadConfig({ cwd: dir })`, so the env
   line was redundant and is dropped. `main.test.ts` calls `main()`, which uses
   `process.cwd()`, so the e2e test now `chdir`s into its temp dir and restores
   it in `finally`. Without that, the agent wrote `out.txt` into the repo root;
   this was caught, and the file deleted.
4. Gate: `bun run typecheck` clean; `bun run lint` clean (one formatter fix in
   `worker.test.ts`); `bun test` **1307 pass, 2 skip (the opt-in ones), 0 fail**.

No drift from the plan.

## Review

*— claude-opus-5-5, 2026-10-20 (in-context, per §10 for cross-module S–M)*

- Holds: `rg TENTACLE_CWD packages README.md` → only the two new tests that
  prove it is ignored. The owner's `~/.config/tentacle/config.jsonc` has no
  active `cwd` (checked), so their setup does not break.
- Non-vacuity: all three new or changed assertions were red on the old code (step 1).
- Not done: legacy docs (`docs/feat/agents-md-autoload.md`,
  `docs/fix/session-store-per-project.md`, `docs/feat/daemon-side-persistence.md`)
  still mention `TENTACLE_CWD` as history. Left as-is: they are records.
- Merge note: the in-progress TLS work also edits `cli/src/main.ts` and
  `cli/test/args.test.ts`. Expect a trivial conflict, if any.
