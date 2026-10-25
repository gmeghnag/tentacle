# fix/double-version-marker — `bun run compile` carries two version markers

> **Status:** execution
> **Branch:** `fix/double-version-marker`
> **Size:** S · **Blast:** cross-module · **Suited:** weaker model OK; standard in-context Review

## Context

*— claude-sonnet-5-5, 2026-10-25*

`bun run compile` fails at the end of `scripts/build.ts:46-59`:

```
error: dist/tentacle carries version marker(s) [0.1.0, 0.1.0], expected exactly one: 0.1.0
```

Root cause: since 19fa201 (version-mismatch-notice) `packages/cli/src/worker.ts`
imported `APP_VERSION` from `version.ts` (for `identity: { tentacle: APP_VERSION,
kind: "worker" }`). `worker.ts` is a second compile entrypoint
(`pod-binary-build.ts:97-103`), so the `__TENTACLE_VERSION_MARKER__` define is
inlined in both bundles → two markers. The guard ("exactly one", review N1) is
right and must stay.

**Repro** (2026-10-25, `bun run compile` on b9bb0c9):

```
$ bun run scripts/build.ts
ad-hoc signed (codesign)
error: .../dist/tentacle carries version marker(s) [0.1.0, 0.1.0], expected exactly one: 0.1.0
error: script "compile" exited with code 1
```
`grep -a -o 'TENTACLE_VERSION_MARKER:0.1.0:END' dist/tentacle | wc -l` → 2.

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption
Only `version.ts` reads the define (`version.ts` `compiledVersionMarker`), so a
worker bundle that does not reach `version.ts` cannot embed the marker.
Graph check (a Transpiler walk of relative imports, the regression test):
before the fix `worker.ts → daemon-log.ts, version.ts, wiring.ts, hooks-trust.ts,
model-provider.ts`; only `worker.ts:26` pulled `version.ts`.

### Preconditions
- The main thread spawns the worker and posts its bootstrap: `local-runtime.ts:407-411`.
- The worker's first object message is the bootstrap: `worker.ts:45-`.
- `identity` shows in a VersionMismatch error's data (`daemon/connection.ts:262-268`),
  which makes it observable in a test.

### Design
The bootstrap becomes `{ config, version }` (`WorkerBootstrap`, new type-only
module `worker-bootstrap.ts`, so the worker imports no runtime code for it).
The main thread sends `APP_VERSION`; the worker uses it as `identity.tentacle`.
No protocol change (the bootstrap is an in-process object, not wire).

### Files
`packages/cli/src/worker-bootstrap.ts` (new), `worker.ts`, `local-runtime.ts`,
`packages/cli/test/worker-version-marker.test.ts` (new).

### Failure modes
A future import of `version.ts` (direct or transitive) from the worker → the
graph test fails before the build does. A bootstrap in the old shape (bare
config) is not supported: worker and main ship in the same binary.

### Tests
1. Graph: `worker.ts`'s relative-import closure does not contain `version.ts`
   (red before: it did).
2. Identity: a real worker given `{ config, version: "9.8.7" }` names
   `"tentacle":"9.8.7"` in a skewed `initialize` error (red before: the old
   worker read the bootstrap as a bare config and never answered → timeout).

## Execution

*— claude-sonnet-5-5, 2026-10-25*

1. Repro red (above).
2. Wrote the test first: graph test red on `expect(files).not.toContain("version.ts")`
   (received `[worker.ts, daemon-log.ts, version.ts, wiring.ts, ...]`), identity
   test red (timeout).
3. Fix as in Design. Both tests green (2 pass).
4. `bun run compile` → `version marker 0.1.0 ok`; marker grep count = 1;
   `./dist/tentacle --version` → `tentacle 0.1.0`. `dist/` is gitignored.
5. Gate: see the final report.

## Review

*— claude-opus-5-5, 2026-10-25* (fresh context; executor was claude-sonnet-5-5 —
same family, different model)

**Verdict: APPROVE-WITH-NITS.** The root cause is right, the fix is minimal, the
build guard is untouched, and the regression test turns red on every way the
worker could reach `version.ts` again that I tried.

**Gate** (`bun run check`, re-run): typecheck clean · biome 442 files, 0
issues · `bun test` **2376 pass / 2 skip (the opt-in ones) / 0 fail**, 2378
tests, 192 files. `bun run compile` → `version marker 0.1.0 ok`;
`LC_ALL=C grep -a -c -o 'TENTACLE_VERSION_MARKER:0.1.0:END' dist/tentacle` →
**1**. The other `TENTACLE_VERSION_MARKER:` hits in the binary are the
prefix, format and parse code, not markers. `./dist/tentacle --version` →
`tentacle 0.1.0`. The guard files (`scripts/`, `pod-binary-build.ts`,
`version.ts`, `version-marker.ts`) have no diff against `main`.

**Findings**
1. *(low, test gap)* `local-runtime.ts:413`: no test pins that the main
   thread sends `APP_VERSION`. Mutation M4 (`version: "bogus"`) leaves all 436
   cli tests green. The identity test spawns its own worker with `"9.8.7"`, so
   it covers the worker side only. Impact is small: the worker's identity is
   informational ("no skew possible", `worker.ts:97`), and `satisfies
   WorkerBootstrap` forces a `string`. Acceptable as is.
2. *(low)* `worker.ts:55`: the bootstrap is cast, not validated. An old-shape
   bare config or `{}` fails loudly: a `TypeError` on `config.mcpServers` →
   worker `error` event → `workerError` → `[worker] handshake failed (…)`, and
   the TUI falls back to in-process. But `{ config }` with no `version` is
   **silent**: the daemon answers with no `tentacle` in its identity (traced
   below). That shape can't be produced by the only spawn site (typed
   `satisfies`), so this is a nit, not a blocker.
3. *(nit, process)* `TODO.md` has no index line for this task (AGENTS §10).
4. *(nit)* `worker.ts:4-5`: the edited header comment overruns the wrapping
   width.

**Premise table**
| Premise | Verdict |
|---|---|
| Symptom: on the old code, compile emits two markers | TRUE (re-created by mutation M1: `[0.1.0, 0.1.0]`, exit 1) |
| Only `version.ts` reads the define | TRUE (`version.ts:42-46`; grep finds no other reader; no workspace package imports cli) |
| `worker.ts` is a second entrypoint, `pod-binary-build.ts:97-103` | TRUE |
| Guard "exactly one", `scripts/build.ts:46-59` | TRUE, unchanged |
| Spawn + bootstrap, `local-runtime.ts:407-411` | TRUE (now `:408-413` after the edit). It is the **only** spawn site; `worker.test.ts` and `fixtures/worker-exit-net.ts` go through `startWorkerRuntime` |
| Identity appears in the VersionMismatch data, `daemon/connection.ts:262-268` | TRUE (`connection.ts:258-270`; it shows as `daemon.tentacle`) |

**Mutations** (each reverted)
- M1 `worker.ts` imports `version.ts` statically → graph test **red**, and
  `bun run compile` **fails** with the two-marker error, so the guard still
  works.
- M5 `void import("./version.ts")` (dynamic) → graph test **red**
  (`scanImports` sees dynamic imports).
- M2 transitive: `model-provider.ts` (worker → wiring → model-provider) imports
  `version.ts` → graph test **red**.
- M3 identity hard-coded to `"dev"` → identity test **red** (`daemon.tentacle:
  "dev"`).
- M4 `local-runtime` sends `"bogus"` → **survives** (finding 1).

After the reverts, `git status --short` matches the starting status. `shasum`
of `worker.ts` `e1ab66a1…`, `local-runtime.ts` `e414342e…`,
`worker-bootstrap.ts` `b8fe000c…`, `wiring.ts` `b956009c…` and the test
`2b6dc831…` match the pre-mutation values. `model-provider.ts` has no diff. I
rebuilt `dist/` clean: marker count 1.

**Attacks tried**
1. A dynamic or transitive path to `version.ts`: caught by the test (M5, M2).
   A non-relative path is impossible: no package depends on `@tentacle/cli`.
   An extensionless relative import, which the walk would skip silently:
   none in `cli/src` (grep).
2. Malformed bootstrap: the scratch trace
   `.tentacle/tmp/double-version-marker/review-malformed.ts` posts three bad
   shapes to the real `worker.ts`, then sends an `initialize` with a skewed
   protocol. Output:
   ```
   bare config (old shape) → ERROR event: TypeError: undefined is not an object (evaluating 'config.mcpServers')
   {config} no version → reply: {…"daemon":{"protocol":11},…}   ← silent, no tentacle
   {} empty → ERROR event: TypeError: … 'config.mcpServers'
   ```
3. Compiled-binary path: the worker bundle gets its version over
   `postMessage` from main, and main's `APP_VERSION` comes from the single
   marker. I did not drive a real TUI session in the binary end to end; that
   rests on the source-path test plus code reading. To verify: run
   `dist/tentacle` and confirm no `[worker] … using in-process` line appears.
4. §7 invariants: the bootstrap is an in-process structured clone, not wire,
   so `PROTOCOL_VERSION` is correctly unchanged. There is still one session
   path and one broker; the change doesn't touch either.

**What holds:** the root cause is exact, the fix is minimal, the guard is
intact, and the regression test is non-vacuous against every re-import route
I found.

**Executor behaviour:** stayed in scope. Wrote the test first and reported it
red. Reproduced the bug before reading code. Execution's claims (marker count
1, `--version`) re-verify. One process miss: no `TODO.md` entry.
