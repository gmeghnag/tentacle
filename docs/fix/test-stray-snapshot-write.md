<!--
Task doc. Type fix · Size S · Blast contained (see AGENTS §10).
-->

# fix/test-stray-snapshot-write — a test's `{"resident":false}` reached the real stdout and landed in a `.snap`

> **Status:** context · implementation · execution · (review)
> **Branch:** `fix/test-stray-snapshot-write`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek exec (this executor: `claude-opus-5-5`)
> **Changelog:** `changelog.d/test-stray-snapshot-write.fixed.md` — dev-visible (the gate stopped corrupting a checked-in snapshot file); no wire, CLI-output or behaviour change for a user.

## Context

*— claude-opus-5-5, 2026-11-21*

`bun test` intermittently corrupted a **checked-in snapshot file**, which then made
an unrelated test file red and blocked a merge gate. Twice seen:

- 2026-11-20, the `caps-before-first-message` gate: 14 `T3 frames` failures; the fix
  was `07729c2b`, deleting one line from the file (only diff in that commit):
  ```
  -{"resident":false}
   // Bun Snapshot v1, https://bun.sh/docs/test/snapshots
  ```
- the same stray first line in `fix/mobile-qa-1119` (`docs/fix/mobile-qa-1119.md:234`).

A sibling corruption of the same file — the header overwritten by a stray
`ESC[?25h` — was seen repeatedly (`docs/fix/tui-line-diff-render.md:394`,
`docs/feat/mobile-hub-opacity.md:243`, `docs/feat/mobile-hub-tap.md:374`,
`docs/fix/inject-bin-dir-probe.md:413`). Those are unhomed bytes of the same class:
**a test writing to the process's real fd 1/2 instead of a seam.**

**Repro (the writer).** A preload that records any `process.stdout.write` containing
`resident`, plus its stack, over `packages/cli/test`:

```ts
// .tentacle/tmp/test-stray-snapshot-write/trace2.ts
const real = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  if (typeof chunk === "string" && chunk.includes("resident")) appendFileSync(LOG, ...);
  return real(chunk as string, ...(rest as []));
}) as typeof process.stdout.write;
```

`bun test --preload ./…/trace2.ts packages/cli/test/main.test.ts` → exactly one hit:

```
chunk="{\"resident\":false}\n"
    at runResidentMode (packages/cli/src/pod-resident.ts:783:22)
```

i.e. the bytes come from `packages/cli/test/main.test.ts:243`, which runs
`main(["bun","cli","serve","--resident-status","--socket", …], { out: () => {}, err })`
— and passes a `out` sink that the resident mode **ignores**.

**Repro (why the bytes land in a `.snap`, not just on the runner's screen).** With
fd 1 unavailable, a `process.stdout.write` is delivered into the file that next
occupies fd 1 — which here is the `.snap` Bun creates while writing a snapshot
(`.tentacle/tmp/test-stray-snapshot-write/e1/a.test.ts`):

```
{"resident":false}
// Bun Snapshot v1, https://bun.sh/docs/test/snapshots

exports[`pollute after closing fd 1 1`] = `"hello"`;
```

Same script **without** the `closeSync(1)` → clean file. So the write must be
prevented at its source; the fd reuse is Bun's behaviour, not ours.

**Constraint (owner, TODO row):** find the writer, make it write only where it
should, and add a guard test that the snapshot dir is untouched after the suite.
No protocol change, no behaviour change for a real user.

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

`main`'s `out` sink is the ONLY channel through which a non-TUI command may put
data on stdout, and the pod-daemon modes bypass it: `packages/cli/src/main.ts:657`
builds `out = io.out ?? ((text) => void process.stdout.write(text))`, but
`packages/cli/src/main.ts:1144` calls `return runResidentMode(config, parsed)` with
no sink, and that function writes `process.stdout` (the process's fd 1) at
`packages/cli/src/pod-resident.ts:783` (`--resident-status`) and `:787`
(`--resident-stop`). **Proved empirically** by the repro above (stack shows `:783`);
`docs/fix/cli-output-streams.md` is the rule this violates.

### Preconditions

- `packages/cli/src/main.ts:657-658` — the two sinks; `io.out` wins when injected
  (a test's sink is never a terminal: `:660`).
- `runResidentMode` has exactly ONE caller: `packages/cli/src/main.ts:1144`
  (`rg -n runResidentMode packages/cli/src` → `main.ts:139` import, `:1144` call).
  No test calls it directly (`rg runResidentMode packages/*/test` → none).
- Its stdout is genuinely DATA (a JSON line), so it belongs on `out`, not `err`:
  `pod-resident.ts:581-587` (`residentStatusReport`), `:619` (`residentStop` → bool).
- The bridge's stdout is **not** data — it is the RPC channel
  (`pod-resident.ts:797-798` passes `process.stdout` into `runBridge`) and MUST stay
  the real fd: `--bridge` is executed inside the pod, driven over the exec channel
  (AGENTS §7 "TUI always over RPC"). Only the two one-shot lines change.
- The daemon log line stays on `process.stderr` (`pod-resident.ts:775`): in a pod
  that IS the daemon log, and it is not this task's defect.

### Design

Thread the CLI's data sink into the pod-daemon mode, mirroring how `main` already
passes `{ out, err }` to other non-TUI commands (`main.ts:900-917`, `packagesCommand`):

1. `packages/cli/src/pod-resident.ts` — a tiny `ResidentIO` seam with a default, so
   production behaviour is byte-identical:
   ```ts
   /** Where a one-shot resident command's DATA line goes (stdout). Default: the process's. */
   export interface ResidentIO { readonly out: (text: string) => void; }
   export const processResidentIO: ResidentIO = { out: (t) => void process.stdout.write(t) };
   ```
   `runResidentMode(config, parsed, io: ResidentIO = processResidentIO)`; `:783` and
   `:787` become `io.out(...)`. `log` (stderr) untouched; `runBridge`'s
   `stdout: process.stdout` untouched.
2. `packages/cli/src/main.ts:1144` — `return runResidentMode(config, parsed, { out });`
   so a test's injected sink receives the bytes and the real fd 1 never does.

Rejected alternative: making the two tests that reach this path stub
`process.stdout.write`. That hides the leak instead of closing it, and the next
test that runs a resident mode re-opens it (`main.test.ts:243` only exists because
`out` was passed and silently ignored).

### Files

1. `packages/cli/src/pod-resident.ts` — the `ResidentIO` seam + two call sites.
2. `packages/cli/src/main.ts` — pass `{ out }` at `:1144`.
3. `packages/cli/test/main.test.ts` — regression test: the resident-status path
   reaches the injected `out` and NEVER `process.stdout` (red on `main`).
4. `packages/tui/test/snapshot-integrity.test.ts` (new) — the guard the TODO asks
   for: every file under `packages/tui/test/__snapshots__/` starts with Bun's header
   (a prepended/overwritten first line fails), plus a unit test of the checker on a
   temp dir so the guard itself is not vacuous.
5. `changelog.d/test-stray-snapshot-write.fixed.md`.
6. `docs/fix/test-stray-snapshot-write.md` (this doc, its Execution).

### Failure modes

- **A user's real `tentacle serve --resident-status`** — unchanged: the default
  `processResidentIO` writes the same bytes to the same fd; the exit code is
  returned untouched (`:784`, `:788`).
- **`--bridge` / `--resident` in the pod** — untouched: they never use `io.out`, and
  the bridge keeps the real stdout (`:797`).
- **A caller that passes no `io`** — default applies (production), so forgetting it
  is not a silent drop.
- **The strays already in the tree** — none: both `.snap` files currently start with
  the header (`head -1` verified). The guard fails loudly if one reappears, instead
  of surfacing as 14 unrelated snapshot failures in someone else's gate.
- **A byte that is not a whole first line** (the `ESC[?25h` case) — same guard: any
  first line that is not exactly the header fails.
- **Race** — a `.snap` is written by the TUI snapshot tests; the guard reads it at
  its own test's time, so it reports the state the file is in when it runs. It
  cannot make the corruption impossible; it makes it attributable and immediate
  (the alternative, an afterAll over the whole run, has no such hook in Bun).

### Tests

- **T1 (red before green, `packages/cli/test/main.test.ts`):** with a
  `spyOn(process.stdout, "write")`, run
  `main(["bun","cli","serve","--resident-status","--socket", <nonexistent>], { out, err })`;
  assert `out.join("")` is the JSON line AND the spy was never called with it.
  Mutation: revert `main.ts:1144` to `runResidentMode(config, parsed)` → red.
- **T2 (guard, `packages/tui/test/snapshot-integrity.test.ts`):** the real
  `__snapshots__` dir has no file whose first line is not the header.
  Non-vacuity: the checker run on a temp dir holding one good + one stray-line file
  reports exactly the stray one (proves the assertion is not always-empty).
- **T3 (source guard):** `pod-resident.ts` contains no `process.stdout.write` — the
  class-level fix (an injected `out` is the only way out), same style as
  `packages/tui/test/app-view-structure.test.ts:244`. Mutation: re-add the direct
  write → red.

## Execution

*— claude-opus-5-5, 2026-11-21*
**Load-bearing check re-run before any edit (brief §"Reproduce first").** The
preload trace over `packages/cli/test/main.test.ts` on this branch reproduced the
writer exactly once, stack `runResidentMode (packages/cli/src/pod-resident.ts:783:22)`
— the assumption holds, so the task is not stale. The amplifier was reproduced in
isolation (`.tentacle/tmp/test-stray-snapshot-write/e1/a.test.ts`: `closeSync(1)` +
a `process.stdout.write` → the line becomes line 1 of the `.snap` Bun creates);
the same script without the close leaves a clean file. Note the full
`packages/cli/test` + `packages/tui/test` run (5603 tests) did **not** corrupt the
file: the symptom is a race, which is why the write must be closed at its source
rather than traced in the full suite.

### As-built, in order

1. **The seam** (`packages/cli/src/pod-resident.ts:770-788`): `ResidentIO` +
   `processResidentIO` (the production default) + the third parameter
   `io: ResidentIO = processResidentIO` on `runResidentMode` (`:787`). The two data
   writes are now `io.out(...)` (`:799` `--resident-status`, `:803`
   `--resident-stop`). Untouched: the daemon `log` (stderr, `:791`) and
   `runBridge`'s `stdout: process.stdout` (`:814`) — the bridge's stdout IS the RPC
   channel.
2. **The wiring** (`packages/cli/src/main.ts:1147`):
   `return runResidentMode(config, parsed, { out })` — the sink `main` already
   built at `:657`, with a comment naming the leak.
3. **T1, red first** (`packages/cli/test/main.test.ts:254-287`): runs
   `serve --resident-status --socket <nonexistent>` with ``out`/`err` sinks while
   `process.stdout.write` is replaced by a recorder; asserts the JSON line reached
   `out`, `err` is empty, exit 0, and the recorder saw **nothing**.
4. **T2/T3, the guard** (`packages/tui/test/snapshot-integrity.test.ts`, new):
   every `*.snap` under `packages/tui/test/__snapshots__` starts with Bun's header;
   the checker is non-vacuous on a temp dir (a prepended stray AND an
   `ESC[?25h`-overwritten header are reported by name); and exactly ONE
   `process.stdout.write` line remains in `pod-resident.ts` (the default seam).
5. **Changelog fragment** `changelog.d/test-stray-snapshot-write.fixed.md`.

### Drift from Implementation

- **T3's assertion is "exactly one, and it is the default seam", not "none".** The
  plan said `pod-resident.ts` contains no `process.stdout.write`; the production
  default `processResidentIO` legitimately has one (`:776`). Written as a line
  match on that exact line — the mutant (a second direct write) is still killed,
  and the false positive (the default seam) is not reported. The first draft of
  this test was red for that reason; the fix is in the test's shape, not the plan's
  design.
- **No `bun run check` here** (the executor brief's `bun run check` is run by the
  orchestrator's gate script, per the owner's token rule). Locally: the two
  touched suites + the guard are green; `bunx biome check` on the 4 changed files
  is clean.
- **`tsc -p packages/cli` was not usable standalone** in this worktree: it reports
  pre-existing `TS2307 Cannot find module '@tentacle/protocol'` errors from
  `packages/tui`'s unbuilt workspace deps (the repo typechecks from the root:
  `bun run typecheck` → `tsc --noEmit` over one project). The change adds one
  exported interface, one const and one optional-parameter default, and the
  suites compile them — the typecheck verdict is the gate's.

### Evidence

**RED on `main`'s code** (the fix reverted, `main.ts:1147` → `runResidentMode(config, parsed)`):

```
(fail) cli main: what config-carry moved > a resident mode's data line goes to the `out` sink,
       never to fd 1 (fix/test-stray-snapshot-write)
Expected: /^\{"resident":false\}\n$/   Received: ""
```

(Red on the assertion the fix hinges on — the bytes went to fd 1 instead of the
sink — not on an import/compile error.)

**GREEN after the fix**: `bun test packages/cli/test/main.test.ts` → `120 pass · 0 fail`;
`bun test packages/cli/test/serve-resident.test.ts` → `41 pass · 0 fail`;
`bun test packages/tui/test/{diagram,chart}-lines.test.ts snapshot-integrity.test.ts`
→ `101 pass · 0 fail · 34 snapshots`; the runner's stdout no longer contains
`{"resident":false}` (it did, once, before — the preload trace hit).

**Mutations (all killed, each reverted after):**

| Mutation | Result |
|---|---|
| `pod-resident.ts:799` back to `process.stdout.write` | T1 **red** (`Received: ""`) + T3 **red** |
| `main.ts:1147` back to `runResidentMode(config, parsed)` | T1 **red** (`Received: ""`) |
| `straySnapshots` → `if (dir) return []` (vacuous) | non-vacuity test **red** |
| the bug itself: `{"resident":false}\n` prepended to `diagram-lines.test.ts.snap` | guard **red**, naming `"file": "diagram-lines.test.ts.snap", "firstLine": "{\"resident\":false}"` |

The snapshot was restored byte-identically after that last mutation (`git status`
shows no `.snap` change).


## Review

*— claude-opus-5-5, 2026-11-21*

**Verdict: PASS** (fresh-context, adversarial; scope `git diff main...HEAD`). This doc was already on the branch, so it was reviewed as written, not rewritten.

- **Gate (narrow + static):** `bun test` over main/serve-resident/snapshot-integrity/diagram-lines → 211 pass · 0 fail; `bun run lint` clean (2164 files); `bun run typecheck` clean (root + mobile + relay). This settles the typecheck that Execution left open.
- **Non-vacuity, re-run by the reviewer:** `main.ts:1147` reverted to `runResidentMode(config, parsed)` → T1 red (`main.test.ts:277`). Reverted afterwards; `git status` clean.
- **§7 invariants:** "never write raw to the terminal" / bridge-stdout-is-RPC holds: `runBridge` keeps `stdout: process.stdout`, and T3 pins it. Production bytes are the same through `processResidentIO`. No protocol, persistence or broker change.
- **Other writers:** no other test reaches `--resident-status/stop` through `main` (`serve-limits.test.ts:605` only tests `isPodDaemonLoad`; the engine-* tests fake the exec). The only direct `process.stdout.write` calls left in `cli/src` are the default sinks (`main.ts:657`, `terminal.ts:47`, `pod-resident.ts:776`).
- **Not HIGH/MEDIUM, noted:** (1) the "fd 1 free → bytes land in the `.snap`" mechanism was only shown in an isolated repro that closes fd 1. The full suite never reproduced it, so the fix closes a real, proven leak, but nothing here proves this was the only route. (2) The `ESC[?25h` sibling is detected by the guard but not homed. (3) The non-vacuity test writes `packages/tui/test/.tmp-snapshot-guard` inside the source tree; `mkdtemp(tmpdir())` would be cleaner. (4) The guard checks only the first line, at its own run time. That is weaker than the owner's "untouched after the suite" and is documented under Failure modes / Race.
