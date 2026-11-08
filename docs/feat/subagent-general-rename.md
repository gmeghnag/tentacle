# feat/subagent-general-rename — Rename the built-in sub-agent type `general-purpose` → `general`

> **Status:** execution
> **Branch:** `feat/subagent-general-rename`
> **Type: feat · Size: S · Blast: contained · Suited:** a weaker model may execute; standard in-context Review (no §7 invariant, no API/protocol/persistence change; the built-in type name is leaf data in one package, consumed by name through `mergeAgentTypes`).

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

The owner decided the built-in sub-agent type is called `general`. Quoting the
owner (2026-11-07): "'general' (piu bello di general-purpouse)". Recorded as
decision **C** of `docs/eval/subagent-live.md:62-65`: "Built-ins:
`general-purpose` → **renamed `general`**, and `explore`". Task 1 of the eval's
"Proposed split into tasks" (`docs/eval/subagent-live.md:569`) carries it:
"rename + tests + docs (C2). First: C's config keys name types, so rename before
users write configs".

The timing is the point: the config key shape is `subagents.types.<type>`
(owner Q6 = (a), `docs/eval/subagent-live.md:654`), and tasks 3/4
(`feat/models-map`) let a user write `subagents.types.<type>.model`. Renaming
the type *after* users have written those keys would break them, so the rename
lands first, while nothing names a type in a persisted CONFIG. A session log
does hold the old name, in one place that is inert history: an old
`agent_task` call's `subagent_type` argument, inside the persisted
`ChatMessage`s. It is never read back as a type (see the load-bearing
assumption and the failure-modes table), so the rename leaves it alone.

**Eval C2's three facts** (`docs/eval/subagent-live.md:399-413`):

1. The name lives in exactly two source places — the built-in list and the
   `agent_task` fallback — plus tests.
2. An old history holding `subagent_type: "general-purpose"` still runs: an
   unknown name falls back to the default type (`task.ts:82-85`). **There is no
   alias, and none is added** (pre-public, AGENTS §7: no compat shim).
3. A user's `agents/general-purpose.md` used to OVERRIDE the built-in
   (`agent/src/agent-defs.ts:132-147`). After the rename it is just an extra
   type, and `agents/general.md` is what overrides the built-in.

**Repro** (`.tentacle/tmp/subagent-general-rename/repro.ts`, run 2026-11-08 on
`main` @ `604522b`, before any edit — output verbatim):

```
1. builtins: ["general-purpose","explore"]
2. description tail: ["Available sub-agent types:","- general-purpose: General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.","- explore: Read-only investigator: searches and reads files to answer a question. Cannot modify anything."]
   no types -> hardcoded fallback: false | {"description":{…},"prompt":{…},"subagent_type":{…"description":"Which sub-agent to use (default general-purpose)"}}
3. old "general-purpose" against builtins: ran as general-purpose
   old "general-purpose" when the list says "general": ran as general
4. merge(builtins, user general.md): [["general-purpose","General autonomous agent …"],["explore","Read-only investigator: …"],["general","mine"]]
   merge(builtins, user general-purpose.md): [["general-purpose","mine"],["explore","Read-only investigator: …"]]
```

Reading it: the built-in is still `general-purpose` (1, 2); the fallback already
absorbs an unknown name, so an old history is safe *by the mechanism that exists
today*, not because of anything this task adds (3, second line); a user
`general.md` today is only an appended extra type while `general-purpose.md`
overrides — exactly inverted from what the rename wants (4).

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Load-bearing assumption

**No consumer in source keys off the string `general-purpose`, but the string
does survive outside `src` in two places — in inert history, and in user hook
scripts.** In `src` every use is either the definition itself or a doc/test
naming it: `packages/agent/src/subagent.ts:58` (the built-in) and
`packages/tools/src/task.ts:80` (the fallback used only when the caller passes
an EMPTY type list). `grep -rn "general-purpose" packages apps scripts` → 2
source hits, 29 test hits, 0 in `apps/` or `scripts/`; there is no enum, no
branch and no config-schema field naming a type (`subagentsEnabled`,
`subagentExecution`, `subagentMaxParallel`, `subagents.agentTaskDescription` are
booleans/numbers/strings unrelated to a type name; `subagents.types.<type>`
does not exist until `feat/models-map`).

Two facts the "nothing persists it" phrasing got wrong:

- **An old `agent_task` call's arguments ARE persisted**, as part of the
  `ChatMessage`s (AGENTS §7's own list). So a session log written before the
  rename holds `subagent_type: "general-purpose"`. Harmless, and that is eval
  C2's second fact: the value is never read back as a type — the call is not
  re-run (an interrupted one is closed with `SUBAGENT_INTERRUPTED_NOTE`,
  `packages/daemon/src/persisted-session.ts:186-188`), and the type is resolved
  at call time from the then-current list.
- **User hook scripts DO see the type**, as `agent.type` in the stdin JSON
  (`packages/agent/src/hooks.ts:514`, contract in
  `docs/feat/hooks-core.md:296`). A hook matching
  `agent.type == "general-purpose"` silently stops matching after the rename.
  This is outside `src`, so the grep above cannot see it; it is called out in
  `CHANGELOG.md` (F4), and nothing in the code can fix a user's script.

### Preconditions

- Built-in list: `packages/agent/src/subagent.ts:56-71`; the name at `:58`, the
  prompt constant `GENERAL_PROMPT` at `:45` (already `general`-neutral, no
  rename needed).
- `agent_task` default + fallback: `packages/tools/src/task.ts:80`
  (`names[0] ?? "general-purpose"`), resolution at `:82-85` (an unknown name →
  `defaultType`), schema text at `:93` (`default ${defaultType}`), the type list
  at `:81` (built from `types`, so it follows the rename for free).
- The merge that decides override-vs-extra:
  `packages/agent/src/agent-defs.ts:132-147` — same `name` → the user's wins in
  place, a new name is appended. Called at `packages/cli/src/wiring.ts:473-475`
  with `BUILTIN_AGENT_TYPES` and `loadUserAgentTypes(...).types`.
- A package type shadowing a built-in is reported (`wiring.ts:109-111`); that
  compares against `BUILTIN_AGENT_TYPES` by name, so it follows the rename.
- The runner also falls back to `types[0]` for an unknown name
  (`subagent.ts:208`), which is the same behaviour one layer down — unchanged.

### Design

Rename the value in two places; nothing else in source needs to move.

1. `subagent.ts:58` — the built-in's `name`.
2. `task.ts:80` — the empty-list fallback. It is unreachable in the real wiring
   (`createSubagentRunner` always yields at least the built-ins, and `types[0]`
   is passed through `createTaskTool`), but it is the honest default: it must
   name the same type as the built-in.

No alias, no compat path (AGENTS §7). The three behaviours the tests must pin
follow from code that already exists — the rename only changes WHICH name those
existing mechanisms see:

- `subagent_type: "general-purpose"` (an old history) → not in
  `names` → `defaultType` = `names[0]` = `general` → the child runs as
  `general`. (`task.ts:82-85`; the same path an unknown `"bogus"` takes today.)
- A user `agents/general.md` → `mergeAgentTypes` sees the same name as the
  built-in → the user's replaces it in place (`agent-defs.ts:139-144`).
- A user `agents/general-purpose.md` → no built-in of that name → appended as an
  extra type (`agent-defs.ts:141-144`), and (in a *package*) reported as not
  shadowing anything.

### Files

Dependency order (leaf first):

| File | Change |
| --- | --- |
| `packages/agent/src/subagent.ts:58` | `"general-purpose"` → `"general"` |
| `packages/tools/src/task.ts:80` | fallback `"general-purpose"` → `"general"` |
| `packages/agent/test/subagent.test.ts` (×16 sites + the one test name) | `type: "general-purpose"` → `"general"`; the expected label `start:general` |
| `packages/agent/test/parallel-agents.test.ts:589-598` | the built-in list expectation + the read-only assertion |
| `packages/agent/test/agent-defs.test.ts:111-113` | `general-purpose kept` → `general kept` |
| `packages/agent/test/permission-reply.test.ts:153` | the child's type |
| `packages/tools/test/task.test.ts:7,48,74` | the `TYPES` fixture, the default-type expectation, the description check |
| `packages/cli/test/wiring.test.ts:119,627-630` | the attribution's type; the shadowing test's built-in file |
| `packages/cli/test/parallel-agents.test.ts:179` | the test's title only (it passes no type — the default is used) |
| **new** tests (below) | in `packages/tools/test/task.test.ts` and `packages/agent/test/agent-defs.test.ts` |
| `README.md` (Features/built-in mention, if it names the built-in) | none today — README never names `general-purpose` (verified); the `agent_task` description is generated from `types`, so it follows for free |
| `docs/feat/packages.md:355` | the "a package type named like a built-in (e.g. `general-purpose`)" example — the eval names `packages.md`; it describes CURRENT behaviour, so the example becomes `general` |

Not touched, deliberately: `docs/feat/parallel-agents.md`,
`docs/feat/subagent-label-rename.md`, `docs/eval/parallel-execution-plan.md`,
`docs/eval/skills-subagent.md`, `docs/eval/subagent-live.md` — historical
records of what was true then (the task's scope says so explicitly).

### Failure modes

| Case | After the rename | Why it converges |
| --- | --- | --- |
| Old history / a model echoing `subagent_type: "general-purpose"` | Runs as `general` | `task.ts:82-85` unknown→default; no error, no alias needed. **Pinned by a test** — and, over the REAL built-ins, end to end by Implementation test 5. |
| A user has `agents/general-purpose.md` (it used to override) | It is now an EXTRA type, appended after the built-ins, and **the default type changes under them**: it is now the built-in `general` (full tool-set), where `types[0]` used to be their file | `agent-defs.ts:141-144` appends it, but the built-in `general` keeps index 0, so `names[0]` (`task.ts:80`) and `types[0]` (`subagent.ts:208`) are now the built-in — a user who restricted that file (e.g. `tools: [fs_read]`) gets a full-tool default for every call that names no `subagent_type`. Nothing reports it; the child's permission gate still applies. `CHANGELOG.md` states it. In a package it is no longer reported as replacing a built-in. The append is **pinned by a test**; so is the resulting index order, `["general", "explore", "general-purpose"]` (`agent-defs.test.ts:132`), which is what makes the built-in the default. |
| A user has `agents/general.md` | Overrides the built-in in place | `agent-defs.ts:139-144`, same-name branch. **Pinned by a test.** |
| Both files (`general.md` + `general-purpose.md`) | `general` overrides, `general-purpose` appends | Same two branches; order is built-ins first, then user files in file-name order. |
| Config `subagents.types.general-purpose` (not implemented yet; lands with `feat/models-map`) | Would name a type that no longer exists | Not reachable at this commit: the key does not exist (§7 config schema untouched). This is why the rename goes first (eval:569). |
| `task.ts` fallback with an empty type list | Names `general` | The literal; no behaviour change otherwise. |

### Tests

Red first (§9), each on the property it names, not on a compile error:

1. **`packages/agent/test/parallel-agents.test.ts`** — the built-in list is
   exactly `["general", "explore"]` and it does NOT contain `general-purpose`;
   `readOnlyType("general")` is `false`, `readOnlyType("explore")` is `true`.
   (Red today: the list is `["general-purpose","explore"]`.)
2. **`packages/tools/test/task.test.ts`** — an `agent_task` call with
   `subagent_type: "general-purpose"` hands the runner `type: "general"` (the
   default), exactly as `"bogus"` does. **Not red today, and the earlier draft
   of this line was wrong to claim it.** The test runs on the file's own `TYPES`
   fixture (`task.test.ts:6-9`), which the same commit renames, so it never sees
   the built-in list and passes on either source. It is not vacuous: mutation 2
   of the Review (an alias `general-purpose → explore` at `task.ts:84`) makes it
   fail. What it pins is the *mechanism* (`task.ts:82-85`); that the mechanism
   is fed `general` by the real built-ins is pinned separately, by test 1 and by
   test 5 below.
   - The one test in this file that WAS red is "with no types at all, the
     fallback names the built-in type `general`" — it asserts the literal at
     `task.ts:80`, and appears in `red.txt`.
3. **`packages/agent/test/agent-defs.test.ts`** — a user type named `general`
   replaces the built-in (its description wins, the list length stays 2); a user
   type named `general-purpose` is APPENDED as an extra type (list length 3, the
   built-in `general` unchanged). (Red today: `general` appends and
   `general-purpose` replaces — exactly inverted.)
4. **`packages/cli/test/wiring.test.ts`** — a package `agents/general.md` is
   reported as "replaces the built-in one"; a package `agents/general-purpose.md`
   is NOT (it shadows nothing). (Extends the existing shadowing test.)
5. **`packages/agent/test/subagent.test.ts`** (wiring level, added in Round 2)
   — a runner built with NO `types` (so it uses the real
   `BUILTIN_AGENT_TYPES`, as `wiring.ts:473-477` does) driven through a real
   `agent_task` call whose stored arguments say
   `subagent_type: "general-purpose"`: the parent's own `subagent_start` event
   reports the child's RESOLVED type, `general`. This is the end-to-end form of
   what tests 1 and 2 pin separately — the mechanism, fed by the real
   built-ins. On the old code it is red on its first assertion (the built-in
   list is `["general-purpose","explore"]`); under the alias mutation below it is
   red on the resolved type (`explore`, where the test expects `general`).

Mutation check (§9 non-vacuity): put `general-purpose` back in the built-in list
(`subagent.ts:58`), confirm tests 1, 3 and 5 go red, restore from a `cp` backup
and verify by `shasum`. A second mutation — an alias `general-purpose →
explore` at `task.ts:84` — makes tests 2 and 5 fail.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

**Order run:** repro on `main` → tests written first (red) → source rename
(green) → mutation → docs → gate. The Implementation held; no drift except the
three notes under "Drift" below.

**0. Repro, before any edit.** `bun .tentacle/tmp/subagent-general-rename/repro.ts`
on `604522b` — the output pasted in Context. It shows all three eval-C2 facts:
the built-in is `general-purpose`; a user `general.md` is appended as an extra
while `general-purpose.md` overrides (the inverse of what the rename wants); and
an old `subagent_type: "general-purpose"` already resolves via the generic
unknown→default path.

**1. Tests first (red).** The new/updated assertions, run BEFORE the source
change (`.tentacle/tmp/subagent-general-rename/red.txt`):

```
(fail) createTaskTool > with no types at all, the fallback names the built-in type `general` [0.22ms]
(fail) mergeAgentTypes > user types override built-ins by name and append new ones [0.14ms]
(fail) mergeAgentTypes > a user "general" replaces the built-in in place; "general-purpose" is an extra type [0.07ms]
(fail) the read-only type > the built-ins are general and explore; explore is read-only [0.19ms]
(fail) inProcessAgents (single-broker invariant, AGENTS §7) > the main agent and its sub-agents forward the ask's call attribution to the broker [1.32ms]
(fail) loadUserAgentTypes: built-in shadowing (post-review) > a package type replacing a built-in is reported; the user's own is not [0.76ms]
(fail) loadUserAgentTypes: built-in shadowing (post-review) > a package "general-purpose.md" no longer replaces a built-in [0.62ms]
 68 pass
 7 fail
```

Each is red on its ASSERTION (the diff shows `"general"` vs
`"general-purpose"` in the received list, or `Received: false` for the `some()`
check), never on a compile/import error.

**2. The rename (two lines).**
- `packages/agent/src/subagent.ts:58` — `name: "general-purpose"` →
  `name: "general"`.
- `packages/tools/src/task.ts:80` — `names[0] ?? "general-purpose"` →
  `names[0] ?? "general"`.

**3. Green** (same four files, `.tentacle/tmp/subagent-general-rename/green.txt`):

```
75 pass
 0 fail
```

**4. Mutation (§9 non-vacuity).** `cp` backup of `subagent.ts`, then line 58 put
back to `"general-purpose"`; `.tentacle/tmp/subagent-general-rename/mutation.txt`:

```
(fail) mergeAgentTypes > user types override built-ins by name and append new ones [0.20ms]
(fail) mergeAgentTypes > a user "general" replaces the built-in in place; "general-purpose" is an extra type [0.11ms]
(fail) the read-only type > the built-ins are general and explore; explore is read-only [0.23ms]
(fail) inProcessAgents (single-broker invariant, AGENTS §7) > the main agent and its sub-agents forward the ask's call attribution to the broker [1.33ms]
(fail) loadUserAgentTypes: built-in shadowing (post-review) > a package type replacing a built-in is reported; the user's own is not [0.74ms]
(fail) loadUserAgentTypes: built-in shadowing (post-review) > a package "general-purpose.md" no longer replaces a built-in [0.53ms]
 69 pass
 6 fail
```

Restored from the backup; the file's `shasum` is identical before and after
(`45a935f2b1cb39fa5d275543e957fa9c981d2042`) and `diff` is empty. Note the
tools-package fallback test did NOT go red under this mutation, correctly: it
pins `task.ts:80`'s literal, a different line; it was red before the rename
(step 1) precisely on that literal.

**5. Gate.**

- `bunx tsc --noEmit` — clean. (`bunx tsc -p apps/mobile` — clean too, nothing there touched.)
- `bunx biome check .` — `Checked 755 files. No fixes applied.` (0 errors,
  0 warnings; matches the AGENTS §6 clean baseline. One formatting drift I
  introduced in `subagent.test.ts` was fixed with `biome check --write`.)
- `bun test packages` — **5671 pass, 3 skip, 0 fail** (62590 expect() calls,
  387 files, 177.66 s). The 3 skips are the opt-in ones AGENTS §6 names.

**6. Grep guard** — `grep -rn "general-purpose" packages apps scripts README.md`:

```
packages/tools/test/task.test.ts:51:  test('an old history\'s "general-purpose" falls back to the default type (no alias)', async () => {
packages/tools/test/task.test.ts:53:    // log written before that still holds `subagent_type: "general-purpose"`.
packages/tools/test/task.test.ts:59:      { description: "d", prompt: "p", subagent_type: "general-purpose" },
packages/tools/test/task.test.ts:73:    expect(tool.description).not.toContain("general-purpose");
packages/tools/test/task.test.ts:101:    expect(tool.description).not.toContain("general-purpose");
packages/agent/test/agent-defs.test.ts:118:  // `agents/general.md` OVERRIDES it (same name), while `agents/general-purpose.md`
packages/agent/test/agent-defs.test.ts:120:  test('a user "general" replaces the built-in in place; "general-purpose" is an extra type', () => {
packages/agent/test/agent-defs.test.ts:131:    const appended = mergeAgentTypes(BUILTIN_AGENT_TYPES, [mine("general-purpose")]);
packages/agent/test/agent-defs.test.ts:132:    expect(appended.map((t) => t.name)).toEqual(["general", "explore", "general-purpose"]);
packages/agent/test/parallel-agents.test.ts:596:    // feat/subagent-general-rename: the built-in is `general`, never `general-purpose`.
packages/agent/test/parallel-agents.test.ts:598:    expect(BUILTIN_AGENT_TYPES.map((t) => t.name)).not.toContain("general-purpose");
packages/cli/test/wiring.test.ts:634:  // feat/subagent-general-rename, eval C2: `general-purpose` used to shadow the
packages/cli/test/wiring.test.ts:636:  test('a package "general-purpose.md" no longer replaces a built-in', async () => {
packages/cli/test/wiring.test.ts:641:    await writeFile(join(pkg, "general-purpose.md"), "theirs");
packages/cli/test/wiring.test.ts:644:    expect(types.map((t) => t.name)).toEqual(["general-purpose"]);
```

**Zero hits in `packages/*/src`, `apps/`, `scripts/`, `README.md`** (verified
separately: `grep -rn "general-purpose" packages/*/src apps scripts` → 0). All 15
remaining hits are tests that must name the old string to pin the fallback /
the extra-type behaviour — the equivalent of the "fallback test" the task
allows.

**Drift from Implementation (3, all small):**

1. **A test-file typecheck fix.** `expect(appended[0]?.description).toBe(BUILTIN_AGENT_TYPES[0]?.description)`
   failed `tsc` (TS2345: `string | undefined` into `.toBe(string)`), because
   `noUncheckedIndexedAccess` makes the literal index `| undefined`. Replaced
   with a `.find(...)` + `toBeDefined()` + `?? ""` form. No design change.
2. **`docs/feat/packages.md:355` was NOT edited**, though the Implementation's
   Files table listed it. On reading it in place, the line is a *Review finding
   from 2026-10-22* ("A package agent type named like a built-in (e.g.
   `general-purpose`) silently replaces it") — a historical record of that
   task's state, and already stale on its own (it cites `agent-defs.ts:77-95`
   for a function now at `:132-147`, and describes last-wins where the code is
   now first-wins, as the same doc's own finding 6 says). AGENTS §10 and the
   task's scope both say not to rewrite historical docs, so the example stays as
   the day it was written. Current user-facing text never named the built-in, so
   nothing current needed the change.
3. **README needed no change either** (the Implementation hedged with "if it
   names the built-in"): `grep -n "general-purpose" README.md` → 0. README
   describes `agent_task` and custom types generically; the tool's description,
   which does list the types, is generated from `types` (`task.ts:81`) and so
   followed the rename for free — confirmed in the after-repro, line 2.

**One verification note (unverified by me):** the mutation's `69 pass / 6 fail`
run was executed with the *rest* of the tree already green, so it isolates the
built-in-list line; I did not additionally mutate `task.ts:80` (its test was red
in step 1 on that literal, which is the same evidence). Verifying the second
mutation is one command: `sed -i '' '80s/"general"/"general-purpose"/' packages/tools/src/task.ts && bun test packages/tools/test/task.test.ts`.

**Round 2 (review text fixes, 2026-11-08).** F1, F3, F4 and F5 are applied as
text fixes above (failure-modes row 2, test 2's "Red today" claim, the
load-bearing assumption — now about consumers in `src` plus the two surviving
uses — and the `eval:654` / `subagent.ts:56-71` citations); F2 is the
orchestrator's `CHANGELOG.md` edit. F3's optional test was added
(`packages/agent/test/subagent.test.ts`, Implementation test 5): green, and red
under both mutations (built-in list back to `general-purpose` → fails on the list
assertion; an alias `general-purpose → explore` at `task.ts:84` → fails on the
resolved type), with `subagent.ts` / `task.ts` `cp`-backed up and their `shasum`s
re-verified identical (`45a935f2…`, `791f9b31…`). Gate: `bunx tsc --noEmit` clean,
`bunx biome check .` 755 files no fixes, and:

```
$ bun test packages
 5672 pass
 3 skip
 0 fail
 62592 expect() calls
Ran 5675 tests across 387 files. [179.22s]
```

That is one pass more than the pre-Round-2 baseline (5671), the test added here;
the 3 skips are the opt-in ones AGENTS §6 names. `tsc -p apps/mobile` not re-run
(nothing there changed).

## Review

*— claude-opus-5-5, 2026-11-08 (fresh context; a different model family from the executor)*

### Verdict: PASS

The code change is correct and complete. F1 and F2 are text fixes to make before
merge; they change no code and need no new Review. F3–F5 are optional.

### Findings

**MEDIUM**

- **F1. A user's `general-purpose.md` silently stops being the default type, and
  this doc says the opposite.** Failure-modes row 2 (`:144`) says "the DEFAULT type
  does not change under them". It does. On `main` the file replaced index 0
  (`repro-before`: `[["general-purpose","mine"],…]`), so it WAS the default. Now
  index 0 is the built-in `general` (`repro-after` line 7). A user who restricted
  that file (`tools: [fs_read]`) gets a full-tool default for every call with no
  `subagent_type`. Nothing reports it. The child's permission gate still applies.
  **Fix:** correct the row, and add to `CHANGELOG.md:13` that the default type is
  now the built-in `general` until the file is renamed.

**LOW**

- **F2. The CHANGELOG's migration step is incomplete.** "rename it to
  `agents/general.md`" (`CHANGELOG.md:13`) does nothing if the file has a
  `name: general-purpose` line, because frontmatter wins over the file name
  (`packages/agent/src/agent-defs.ts:87`). The type stays an extra one, with no
  diagnostic. **Fix:** "rename it (and its `name:`, if it has one)".
- **F3. The old-history test was never red, and Execution does not say so.**
  Implementation Test 2 (`:158-162`) claims "Red today". The test is absent from
  the seven failures in `red.txt`, and passes on either source: it runs on the
  fixture at `packages/tools/test/task.test.ts:6-9`, so it cannot see the built-in
  list. It is not vacuous (mutation 2 below), and C2 property 1 holds by
  composition with `packages/agent/test/parallel-agents.test.ts:598`. **Fix:**
  correct the doc's claim. Optional: one wiring-level test over the real built-ins.
- **F4. The load-bearing assumption is overstated** (`:62-72`, and Context `:23`).
  "Nothing persists the type name" is false: an old `agent_task` call's arguments
  sit in the persisted `ChatMessage`s, which is C2's own second fact. "No consumer
  keys off the string" misses user hook scripts, which get `agent.type`
  (`packages/agent/src/hooks.ts:514`, `docs/feat/hooks-core.md:296`). A hook that
  matches `"general-purpose"` silently stops matching. No effect on the code.
  **Fix:** correct the text; add the hook case to the CHANGELOG entry.
- **F5. Citations.** `docs/eval/subagent-live.md:650` (`:20`) is Q2; Q6 is `:654`.
  The built-in list (`:76`) ends at `subagent.ts:71`, not `:73`.

### The checks

1. **References.** `rg "general-purpose" packages apps scripts README.md` hits only
   tests (5 in `task.test.ts`, 4 in `wiring.test.ts`, 2 in `parallel-agents.test.ts`,
   4 in `agent-defs.test.ts`), all pinning the fallback or the extra-type behaviour.
   Zero in `src`. On `main`: 2 source and 29 test hits, as claimed. **The text the
   model sees** (`task.ts:70,81,93` with `subagent.ts:58-60`) is "- general: General
   autonomous agent for multi-step tasks and open-ended work. Has the full tool-set."
   and "Which sub-agent to use (default general)". It reads well. The repeated
   word is harmless.
2. **C2.** All three properties hold and are pinned: fallback
   (`task.test.ts:51-64`), override and extra type (`agent-defs.test.ts:120-137`,
   `wiring.test.ts:621-645`). **How the fallback shows:** the TUI and permission row
   show the RESOLVED type, `general` (`subagent.ts:213`, `render-lines.ts:276`,
   `permission-ui.ts:97`). The model gets no signal: the tool_result is the report
   plus only a cancelled/capped note (`task.ts:118-125`). **Judgement: acceptable
   for this rename.** `general-purpose` meant the type it now resolves to, the tool
   description lists `general` every turn, and a past call is never re-run (an
   interrupted one gets `SUBAGENT_INTERRUPTED_NOTE`, `persisted-session.ts:186-188`).
   The general case is weaker: see owner Q1.
3. **Other surfaces.** None is affected.
   - *TUI:* the label is dynamic. `subagent-label-rename` concerns the tool label
     "Agent" (`core/src/tool-labels.ts:15`), not the type. `render-lines.ts:511`
     prefers `description`, which the schema requires.
   - *Resume/log:* the old string stays as inert history, and no code reads it.
   - *Wire and pods:* the name travels only as a free string
     (`protocol/src/updates.ts:138`, `protocol/src/permission.ts:79`), with no enum
     and no `src` branch on it. Types resolve daemon-side against that daemon's own
     list, so an older pod with a newer laptop just shows `general-purpose` and
     works. No `PROTOCOL_VERSION` bump is needed.
4. **Tests.** Non-vacuous, on my own mutations (`cp` backup, narrow test, restore):
   - Mutation 1, `task.ts:80` back to `"general-purpose"` (the one Execution left
     unverified): 1 fail, "with no types at all…".
   - Mutation 2, an alias `general-purpose → explore` at `task.ts:84`: 1 fail,
     "an old history's…".
   - After restore, `shasum`: `subagent.ts` `45a935f2…`, `task.ts` `791f9b31…`,
     identical to before; `git status` clean.
5. **CHANGELOG.** Right section, and what it says is true. Incomplete: F1, F2, and
   the hook case in F4.
6. **Gate.** `bunx tsc --noEmit` clean. `bunx biome check .`: 755 files, no fixes.
   `bun test packages`: **5671 pass, 3 skip, 0 fail** (62590 expects, 387 files).
   The 3 skips are the opt-in ones. Not re-run: `tsc -p apps/mobile` (nothing there
   changed).

### Premises

| Citation | Result |
| --- | --- |
| `subagent.ts:58`, `:45`, `:208` | TRUE |
| `subagent.ts:56-73` | FALSE by two lines (F5) |
| `task.ts:80`, `:81`, `:82-85`, `:93` | TRUE |
| `agent-defs.ts:132-147` | TRUE |
| `wiring.ts:473-475`, `:109-111` | TRUE |
| `eval:62-65`, `:399-413`, `:569` | TRUE |
| `eval:650` | FALSE (F5) |
| "Nothing persists the type name" | FALSE (F4) |
| "The DEFAULT type does not change" | FALSE (F1) |

### Attacks tried

1. A user `general-purpose.md` with restricted tools: found F1.
2. A file renamed but keeping `name:`: found F2.
3. Old name on the wire and in pods: nothing found.
4. An old `agent_task` re-executed at resume: not re-run; nothing found.
5. A consumer keying off the string in `src`: none. Outside `src`, user hooks (F4).
6. `docs/feat/packages.md:355` left unedited: Execution's drift note is right, the
   line is a dated review finding.

**Not executed:** the end-to-end trace, and so the Repro re-run on `main`. Running a
scratch script with `bun` needed an approval this session did not have. F1 rests on
the executor's saved `repro-before`/`repro-after` output plus the code; F2, the
`explorer` case in Q1 and the rendered text rest on reading the code. To verify:
`bun .tentacle/tmp/subagent-general-rename-review/trace.ts` (it stays in the
worktree, gitignored).

### Owner questions

**Owner answers (2026-11-08, after merge):** Q1 YES as a separate small task (`feat/subagent-unknown-type-note` in TODO: a one-line note in the tool_result when `subagent_type` names no known type); Q2 NO startup warning for an old `agents/general-purpose.md` (the CHANGELOG is enough).


- **Q1. Should an unknown `subagent_type` tell the model?** Today a typo like
  `explorer` silently runs the default type, with all tools, when the model expected
  a read-only child (`task.ts:84`). The behaviour predates this task.
  (a) Leave it. (b) Keep running, and add a note to the tool_result:
  `_(unknown sub-agent type "explorer": ran as general)_`. (c) Return an error that
  lists the valid types. **Recommend (b), as a separate small task:** it keeps C2's
  "still runs" and makes the result truthful. (c) is the only option that stops the
  unintended child, but it reverses C2.
- **Q2. Warn when a `general-purpose.md` exists?** **Recommend no:** pre-public, no
  compat shim (AGENTS §7). F1's CHANGELOG line is enough.

### How the executor behaved

Disciplined: repro before any edit, tests before the rename, a mutation restored
and checked by `shasum`, and drift reported, including the mutation it had not run.
Skipping the `packages.md` edit was the right call. Its weak spot was claims it did
not test: the "DEFAULT does not change" row (F1) and "Red today" (F3). Its own
`repro-before` output contradicts F1's claim.

