# feat/protocol-version-at-merge — `PROTOCOL_VERSION` assigned at merge, not on the branch

> **Status:** context · implementation · execution · done
> **Branch:** `feat/protocol-version-at-merge`
> **Size:** S · **Blast:** cross-module (process) · **Suited:** DeepSeek
> **Changelog:** `none` — internal/dev process, no user-visible behaviour (AGENTS §10: the changelog is curated, not a commit mirror).

## Context

*— deepseek-v4-pro, 2026-11-13*

Owner-approved follow-up **Q3** of `docs/feat/changelog-fragments.md:367-375`,
and **Q4**'s `.gitattributes` line (`:376-380`). The problem, with evidence:

`PROTOCOL_VERSION` (`packages/protocol/src/version.ts:32`) is a single shared
line that **every** breaking protocol change edits. Two parallel tasks that each
bump it conflict, and the conflict is in prose (the reason comments), so it is
resolved by hand every time. Measured cost of one bump today — **9 shared
edits**, and each one is a conflict site when two branches bump in parallel:

| # | Site | What it pins |
| --- | --- | --- |
| 1 | `packages/protocol/src/version.ts:32` | `export const PROTOCOL_VERSION = 24 as const;` |
| 2 | `packages/protocol/src/version.ts:7-31` | the reason-comment block, appended to by every bump |
| 3 | `packages/protocol/test/session-log.test.ts:257-258` | `expect(PROTOCOL_VERSION).toBe(24)` (the "newest bump" test) |
| 4 | `packages/protocol/test/dsml-leak-kind.test.ts:60` | `toBe(24)` — "no bump by this task" |
| 5 | `packages/protocol/test/truncated-kind.test.ts:46` | `toBe(24)` — "no bump by this task" |
| 6 | `packages/protocol/test/updates.test.ts:255` | `toBe(24)` — "no bump by this task" |
| 7 | `packages/protocol/test/subagent-panel.test.ts:72` | `toBe(24)` — "no bump by this task" |
| 8 | `packages/protocol/test/wire-stop-reason.test.ts:59` | `toBe(24)` — "no bump by this task" |
| 9 | `packages/daemon/test/version-mismatch.test.ts:274,285,289` | `toBe(24)` + the literal `24` inside the expected message and `data` |
| + | `packages/protocol/schema/protocol.json:4383` | `"x-protocol-version": 24` — generated (`bun run schema:export`, `package.json:19`), never hand-edited |

The *floor* assertions (`toBeGreaterThanOrEqual(19|20|21)` —
`published-models.test.ts:97`, `subagents-update.test.ts:29`,
`subagent-background.test.ts:19`, `clear.test.ts:32`,
`session-archive.test.ts:48`) are **not** pins and never need editing; they are
the shape to keep.

**Repro.** `.tentacle/tmp/protocol-version-at-merge/repro.sh` (gitignored,
pasted in full below; run 2026-11-13 on `main` = `5961917`): two branches, each
bumping `24 → 25` with its own reason line and its own pin-test edit, merged in
sequence into `main`:

```sh
bump() { # $1 branch, $2 reason line
  git checkout -q -b "$1"
  printf '// 24: token budget\n// 25: %s\nexport const PROTOCOL_VERSION = 25 as const;\n' "$2" > packages/protocol/src/version.ts
  printf 'test("pin", () => { expect(PROTOCOL_VERSION).toBe(25); });\n' > packages/protocol/test/pin.test.ts
  git commit -qam "bump to 25: $2"; git checkout -q main
}
bump task-one "cleared sub-agent slots ride the wire"
bump task-two "the ask carries its origin"
```

Output:

```
== merge task-one into main
== merge task-two into main
  UU packages/protocol/src/version.ts
  CONFLICT: packages/protocol/src/version.ts
== the conflict in version.ts:
// 24: token budget
<<<<<<< HEAD
// 25: cleared sub-agent slots ride the wire
=======
// 25: the ask carries its origin
>>>>>>> task-two
export const PROTOCOL_VERSION = 25 as const;
```

Two things this shows. (a) `version.ts` conflicts on the **reason prose**, which
is hand-resolved. (b) The pin test merged *cleanly* — both branches wrote the
same `toBe(25)` — so the merge is silent about the fact that two changes now
share one number: a task cannot state "the number I tested is mine".

**The decision this serves.** A task that needs a breaking protocol change stops
editing the number. It drops a one-file note recording the *reason*
(`protocol.d/<slug>.md`); the orchestrator assigns the numbers once, at merge,
with `bun run protocol:bump`. `protocol.d/` is per-task files, so parallel
tasks never touch a shared line — the same shape `changelog.d/` was adopted for
(`docs/feat/changelog-fragments.md:181-224`), reused rather than invented.

**Why a note file and not the changelog fragment** (the two candidate carriers):

- A fragment exists only for **user-visible** work (`docs/RELEASING.md:9-12`,
  AGENTS §10). Several past bumps are internal or safety-only — v22's
  `wake-` prefix refusal (`version.ts:17-22`) has no user-facing bullet — so a
  breaking change would sometimes have nowhere to record itself, and the number
  would be assigned from Review prose.
- A fragment is **deleted at release** (`scripts/release.ts:210-212`); the
  reason must survive as `version.ts`'s permanent comment block, which is what a
  note is folded into.
- Coupling would make one file carry two unrelated rules (release notes vs wire
  numbering), and the two could drift: a `changed` fragment with no protocol
  meaning, or a protocol break with no user-visible effect.

## Implementation

*— deepseek-v4-pro, 2026-11-13*

### Load-bearing assumption

**The exact number is asserted in exactly one place a bump must edit, and that
one place is not a fixture other tests depend on.** Verified by enumerating
`PROTOCOL_VERSION` across `packages/` (the 9 rows above): 6 protocol tests +
1 daemon test assert the literal, everything else either imports the constant
(`packages/cli/src/pod-resident.ts:557`, `packages/client/**`,
`packages/transport/test/stream-channel.test.ts:78-89`) or uses a `>=` floor.
`packages/protocol/test/json-schema.test.ts:48` compares the generated
`x-protocol-version` to the *constant*, not to a literal, so it follows a bump
for free. **If any of those 7 literal assertions cannot be replaced without
losing a property, the task fails here** — so each replacement is checked in
Tests below.

### Preconditions

- `PROTOCOL_VERSION` is exported from `packages/protocol/src/index.ts` and is
  the only wire version (`AGENTS.md:241-247`); the daemon compares for
  inequality at `initialize` (`packages/daemon/src/version-mismatch.ts`), so a
  bump never needs a code change.
- `packages/protocol/schema/protocol.json:4383` carries the number and is
  **generated**; `packages/protocol/test/json-schema.test.ts:39-44` fails on
  drift. So any bump must regenerate it, which the script does itself.
- `scripts/changelog.ts` is the precedent for a pure rules module + a thin git/
  I/O shell (`scripts/release.ts`), and `scripts/release-plan.ts:5-8`
  (`ReleaseError`) is the shared refusal type. Reused, not reinvented.
- No `docs/` file today describes the *merge* procedure beyond AGENTS §10's
  lifecycle line (`:468`); so that is where "regenerate `protocol.json` after a
  merge" is documented (Q4's requirement), plus §7's protocol bullet for the
  rule itself.

### Design

Three parts.

**1. The note (per task, conflict-free).** `protocol.d/<slug>.md` — one file per
breaking change, named for the task slug, body = one paragraph saying *what
broke and why the number must move* (the text that becomes the `// N:` comment).
Two parallel tasks write two different paths ⇒ no conflict, exactly as
`changelog.d/` proved for release notes.

**2. `scripts/protocol-bump.ts` — pure rules + a thin shell.** Reuses the
release script's split:

- pure: `parseNotes(files)` (validate `<slug>.md`, non-empty, refuse a
  subdirectory/misnamed entry *by name* — the F1 lesson from
  `changelog.ts:38-52`), `applyBump(versionText, notes)` (append one
  `// <N>: …` comment per note in slug order, set the number, refuse when the
  file's current comment block disagrees with the number), `foldNote`
  (multi-line note → `// ` continuation lines).
- shell: `runProtocolBump({root, exportSchema, write})` — read `protocol.d/`,
  compute, write `version.ts`, delete the applied notes, then refresh
  `schema/protocol.json` by calling the existing `bun run schema:export`
  (never hand-edited, never a JSON re-serialize). **Zero notes is not an
  error**: print `no protocol.d notes` and still refresh the schema — that is
  exactly Q4's post-merge step, so the orchestrator has ONE command. Exit 1 on
  a malformed note, with the tree untouched (everything is computed before the
  first write, like `release.ts:126-146`).

**3. One pin.** A new `packages/protocol/test/version.test.ts` holds the *only*
literal in the test suite:

```ts
expect(PROTOCOL_VERSION).toBe(24);
```

plus two guards that make the pin honest rather than ceremonial:

- the newest `// N:` comment in `version.ts` names the same `N` (so a hand-bump
  that skips the reason, or an edit to one and not the other, is red);
- the comment block is **non-empty and its numbers strictly ascending with no
  gaps**, so a fold that mis-numbers a note, or a block edited out of order, is
  red.

The 6 protocol-test literals become `toBeGreaterThanOrEqual(<their n>)` — the
assertion those tests actually need ("this kind/field landed no earlier than
the number that existed when it was added, so an older peer at that floor sees
it") — which never needs editing again; the property each test already proves
with its *other* assertions (display class, optional field, registered method)
is unchanged. `packages/daemon/test/version-mismatch.test.ts:285,289` replace the
literal `24` with `${PROTOCOL_VERSION}` / `PROTOCOL_VERSION`, so the daemon's
expected message is derived, not pinned.

Net: a bump is **2 hunks** — `version.ts` (note + number) and
`version.test.ts` (one line) — plus the regenerated `protocol.json`, produced by
the same command.

### Files

Dependency order (pure rules → script → tests → pins → rule text):

1. `scripts/protocol-bump.ts` (new) — `parseNotes`, `applyBump`, `foldNote`,
   `runProtocolBump`; `ReleaseError` reused from `release-plan.ts`.
2. `scripts/protocol-bump.ts` `import.meta.main` shell + `package.json:19-22`
   script `protocol:bump`.
3. `scripts/test/protocol-bump.test.ts` (new) — pure cases + the repo guard.
4. `packages/protocol/test/version.test.ts` (new) — the ONE pin + the two
   `version.ts` guards.
5. `packages/protocol/test/{session-log,dsml-leak-kind,truncated-kind,updates,subagent-panel,wire-stop-reason}.test.ts` — literal → `>=` floor.
6. `packages/daemon/test/version-mismatch.test.ts` — derive the expected
   message/`data` from `PROTOCOL_VERSION`.
7. `.gitattributes` (new) — `packages/protocol/schema/protocol.json -merge`.
8. `AGENTS.md:241-247` (§7 protocol bullet) + `:468` (§10 merge line) ·
   `docs/EXECUTOR-BRIEF.md` (one line under *Before you declare done*) ·
   `TODO.md` (the item, one line).
9. `protocol.d/` — created on demand; **this task adds no note** (it makes no
   protocol change).

No `packages/` production code changes: the blast is the *process*.

### Failure modes

| Failure | Today | With this task |
| --- | --- | --- |
| Two parallel breaking changes | `version.ts` conflict in prose (repro) | two different `protocol.d/` files, clean merge; one ordered fold at merge assigns 25 and 26 |
| Two branches, same number, same comment | merges clean, silently one number for two changes | impossible: no branch holds a number |
| A branch merged **without** running `bun run protocol:bump` | — | the note file is still in the tree, so the state is visible (`protocol.d/` is non-empty on `main`) and the next bump folds it. No test can detect "someone forgot to run it" — the same honest limit fragments record (`docs/feat/changelog-fragments.md:333-336`); the guard that *can* exist is the one below (a number with no comment) |
| Hand-bump of the number with no note | silent | `version.test.ts` guard red: newest `// N:` ≠ `PROTOCOL_VERSION` |
| Folded note mis-numbered / out of order | silent | guard red: numbers must ascend without gaps |
| A note is a directory / misnamed / empty | — | `parseNotes` refuses **by name**, exit 1, nothing written (F1 pattern, `changelog.ts:78-95`) |
| Script fails partway | — | notes are deleted only after `version.ts` is written; a failed write leaves the note in place, so a re-run converges (the fold is idempotent-when-no-notes) |
| `schema:export` not run after a merge | chimera `protocol.json` on a clean auto-merge | Q4's `.gitattributes -merge` makes the conflict loud, and `bun run protocol:bump` refreshes the file as part of the one merge command; `json-schema.test.ts:39` proves no drift |
| Crash between write and delete | — | the note(s) are still there and `version.ts` already folded them ⇒ a re-run would fold them again. Guarded (fix round 1): a note whose text matches **any** of the last `notes.length` blocks (one fold writes at most one block per note, so that window holds the crashed run's blocks) is skipped, so a re-run after a write with no deletions converges — for one note and for many. Residue: a note whose prose duplicates a block from *before* that window is folded again (a visible duplicate block, never a silently dropped note) |

### Tests

Red-before-green (§9), each asserting the property that fails today:

1. **`scripts/test/protocol-bump.test.ts` — `applyBump`:** given
   `version.ts` at 24 and two notes (`alpha`, `zeta`), the result has
   `// 25: <alpha>` then `// 26: <zeta>` and `= 26 as const`. **RED today** (no
   such export). Mutation: drop the increment, or fold only the first note → red.
2. **`applyBump` idempotence/refusal matrix:** a hand-bumped number with no
   matching comment (refused), a comment/number mismatch (refused), an
   out-of-order or gapped block (refused), a note already folded (skipped, not
   doubled). RED today.
3. **`parseNotes` refusal matrix:** `Task_x.md`, `task-x.added.md`, a
   subdirectory, an empty body, a `#` heading. RED today. Each asserts the
   message, not just a throw.
4. **`runProtocolBump` end-to-end** (injected `exportSchema`/`write`, fixture
   dir — the `release.test.ts:137-181` seam): two notes → `version.ts` folded,
   both notes **deleted**, the export hook called once, `write` printed the
   per-note summary; zero notes → exit 0, no write, export still called.
   Malformed note → exit 1, `version.ts` byte-identical, note still there.
5. **`packages/protocol/test/version.test.ts` — the single pin.** **RED today**
   (the file does not exist). Non-vacuity by **mutation**: change
   `version.ts:32` to 25 and leave the test → red; restore. And the guards:
   renumber a comment line to 99 → red; delete a middle `// N:` line → red.
6. **The 6 replacements keep their property:** each converted test still
   asserts its real claim (`UPDATE_CLASS[x] === "display"`, the optional field
   parses, `RequestSchemas[Method.X]` is registered). Non-vacuity: mutate
   `UPDATE_CLASS.dsml_leak` to `mandatory` → `dsml-leak-kind.test.ts` red
   (already shown by its own assertions, re-checked here).
7. **`version-mismatch.test.ts` derived literals:** the expected message now
   interpolates `PROTOCOL_VERSION`; mutation — make `versionMismatch` report the
   *client's* version as the daemon's → red.

## Execution

*— deepseek-v4-pro, 2026-11-13*

As built, in the Implementation's order.

1. **`scripts/protocol-bump.ts` (new, ~300 lines).** `parseNotes` +
   `readNoteDir` (validate `<slug>.md`, refuse a directory/misnamed/empty note
   **by name**, F1 pattern), `readVersion` / `readBumps` / `pendingNotes` /
   `foldNote` / `applyBump` (pure), and `runProtocolBump` (the shell: compute →
   write `version.ts` → delete the notes → `bun run schema:export`). `ReleaseError`
   reused from `release-plan.ts:12`, as planned.
   **Two drifts, both found by the tests rather than argued:**
   (a) `applyBump` now sorts by slug **itself** instead of trusting
   `parseNotes`'s order (mutation M6 red without it) — the fold's numbering must
   not depend on which caller passed what;
   (b) `readBumps` joins `// ` continuation lines back into the reason text. It
   first read only the `// <n>: ` first line, so a **wrapped** note never matched
   its own text and the idempotence check would have folded it twice on a re-run.
   That was a real bug in my own Design, caught by the long-reason test.
   Also added `deps.writeVersion`, a seam I did not plan: without it the
   delete-after-write ordering (M7) had **no** test and survived mutation.
2. **`package.json:20`** — `"protocol:bump": "bun scripts/protocol-bump.ts"`.
3. **`scripts/test/protocol-bump.test.ts` (new, 19 tests)** — pure cases + the
   four `runProtocolBump` end-to-end cases (2 notes / 0 notes / malformed note /
   failed export / delete-after-write), over a `mkdtemp` fixture with injected
   `exportSchema`/`write`/`writeVersion`.
4. **`packages/protocol/test/version.test.ts` (new)** — the ONE exact pin plus
   the two `version.ts` guards (newest comment's number == the exported number;
   the block's numbers consecutive and reaching the number). It imports the
   fold rules from `scripts/` so the guard and the script cannot disagree.
5. **The 6 conversions** (`dsml-leak-kind:60`, `truncated-kind:46`,
   `updates:255`, `subagent-panel:72`, `wire-stop-reason:59`, `session-log:257`)
   — `toBe(24)` → `toBeGreaterThanOrEqual(<the bump that introduced the thing>)`:
   23 for the display kinds and the log types (v23 introduced the shape they
   extend), 24 for `history_repaired` and the wire `StopReason` field (both landed
   with v24's enum member), 20 for `subagent-panel` (its methods landed at v20).
   Each test's real assertion (class, parse, registration) is untouched; the
   comment naming "24 is the token-budget bump" was the shared line and is gone.
   `session-log.test.ts`'s test name lost "is 24:" (it is a floor now).
6. **`packages/daemon/test/version-mismatch.test.ts:273-292`** — the literal
   `24` in the expected message and in `data` is now `current = PROTOCOL_VERSION`.
   This one is worth stating: it was the only place the *word* "24" appeared in a
   user-facing expected string, so it was the one that would have gone stale
   mid-merge. The `expect(PROTOCOL_VERSION).toBe(24)` assertion is deleted (the
   pin lives in one place now).
7. **`.gitattributes` (new)** — `packages/protocol/schema/protocol.json -merge`,
   with a four-line comment pointing at `bun run protocol:bump`.
8. **Rule text** — `AGENTS.md:241-254` (§7: the breaking-change sentence now
   says "write `protocol.d/<slug>.md`, do not edit the number"; the
   `mandatory` and "truly breaking" bullets point at the note instead of "bump
   it"), `AGENTS.md:476-483` (§10: a new **Merge step** bullet — merge, then
   `bun run protocol:bump`, then the gate, and *why* the schema must be
   regenerated), `docs/EXECUTOR-BRIEF.md:47-53` (the fragment bullet's
   neighbour), `TODO.md:490` (the `eval/parallel-tasks` hotspot line points at
   this doc).

**Evidence.**

- **Repro / load-bearing assumption, re-run first:** the parallel-bump conflict
  is real (Context's `repro.sh`). After the change there is nothing to conflict
  on: no branch holds a number.
- **The 2-hunk claim, proven end to end**, not asserted: with a real note in
  `protocol.d/demo-two-hunk.md`, `bun run protocol:bump` printed
  `1 note folded, PROTOCOL_VERSION is now 25` and produced exactly
  `@@ -32 +32,3 @@` in `version.ts` (the folded `// 25:` lines + the number) and
  `@@ -4383 +4383 @@` in the generated `protocol.json`. The demo note was then
  removed, `version.ts` restored and `schema:export` re-run — `git status` for
  both files is empty.
- **Red before green** (§9): `scripts/test/protocol-bump.test.ts` was red on
  3 cases before the fix-up (two real source bugs, see drift (a)/(b));
  `packages/protocol/test/version.test.ts` is new, so its red is shown by
  mutation instead: M1–M3 below.
- **Mutations run and reverted** (each restored, file byte-identical
  afterwards — `git diff --stat` empty):
  | # | Mutation | Red? |
  | --- | --- | --- |
  | M1 | bump `version.ts:32` to 25 alone (a hand-bump) | 3/3 version tests red |
  | M2 | renumber `// 23:` → `// 22:` (block lies) | consecutiveness red |
  | M3 | delete the middle `// 22:` reason line (gap) | consecutiveness red |
  | M4 | fold only the first note | 2 red |
  | M5 | `assigned = current` (never increment) | 3 red |
  | M6 | drop `applyBump`'s slug sort | ordering red |
  | M7 | delete the notes *before* the write lands | **survived at first** → added the `writeVersion` seam + test → red |
  | M8 | never call `exportSchema` | 3 red |
  | M9 | drop the already-folded skip | idempotence red |
  | M10 | drop the consecutiveness check | gap refusal red |
  | M11 | swallow the empty-note refusal | empty-note refusal red |

**Gate** (`bun run check`, from the worktree): `bunx tsc --noEmit` **0 errors** ·
`bun run lint` **clean** (965 files; my three new files needed only Biome
format + import order, applied to those files alone) · `bun test` — **7636 pass,
3 skip, 0 fail** (7639 tests, 546 files, 300 s; the 3 skips are the documented
opt-in ones: live-k8s, live-docker, the real-socket keepalive). No changelog
fragment (internal process, per the metadata block).

**Deliberately not done** (debt, for Review to weigh): (i) the script does not
run inside a git hook or the merge itself — it is a documented orchestrator step
(§10), because a hook that rewrites `version.ts` mid-merge would surprise a
human resolving a conflict; (ii) nothing fails the gate when `protocol.d/` is
non-empty on `main` — a note is a file in the tree, so it is visible in Review,
but a *test* asserting "no notes on main" would break every in-flight parallel
branch, so I left it out; (iii) `protocol.d/` does not exist in the tree yet (it
is created by the first task that needs it) — `readNoteDir` treats a missing
directory as empty, which the test pins.

### Fix round 1

*— claude-opus-5-5, 2026-11-13*

Fix round 1 addresses the fresh-context Review's two findings
(`docs/feat/protocol-version-at-merge.md`, second Review section): **#1 HIGH**
(a multi-note crash re-run folds a note twice) and **#2 MEDIUM** (`foldNote` can
emit a continuation line that reads back as a block). Nothing else was touched:
no change to the Design, no protocol note (this task still makes no wire change),
no changelog fragment (internal process, per the metadata block).

**(1) HIGH — multi-note crash idempotence** (`scripts/protocol-bump.ts:194-211`,
`pendingNotes`). Root cause: the "already folded" check compared each note to the
**newest block only**, so after a crash between the write and the `rmSync` loop
the re-run skipped the last note and re-folded the others under fresh numbers —
consecutive, so no guard and no `version.test.ts` assertion went red.

- Fix: a note is applied when its text matches **any** block in the last
  `notes.length` blocks. One fold writes at most one block per note, so the
  blocks a crashed run wrote necessarily lie inside that window. A shorter window
  (the previous newest-block-only check) is the bug; a wider one (the whole
  file) would be safe against this bug but could skip a genuine re-break whose
  prose happens to duplicate an old release's, so the window is exactly
  `notes.length`. `notes.length === 0` short-circuits: `slice(-0)` is
  `slice(0)`, which would otherwise make the whole file "already folded".
- Residual, now stated in the failure-mode table instead of implied away: a note
  whose prose exactly duplicates a block from *before* that window is folded
  again — a visible duplicate block, never a silently dropped note.
- Tests: `applyBump` "a crash re-run with TWO notes folded skips both" (the
  Review's exact scenario: `[25 break A, 26 break B]` must come back unchanged)
  and the end-to-end `runProtocolBump` "a crash re-run (notes folded, not yet
  deleted)" — both **red before the fix** (`+ // 27: break A`,
  `= 27 as const` / `PROTOCOL_VERSION is now 27`), green after.

**(2) MEDIUM — a continuation line that reads back as a block**
(`scripts/protocol-bump.ts:38-45`, `:158-184`). Root cause: `foldNote` wrapped on
width alone, so prose containing a word like `7: followed` could start a
continuation line `// 7: followed`, which `readBumps` parses as block 7 — the
next bump then refuses ("the number is 25 but the newest reason comment is 7")
*after* the bad block is already written, and `version.test.ts` goes red at the
merge gate.

- Fix: a word matching `BLOCK_START_WORD` (`/^\d+:(\s|$)/` — tested on the word,
  because the joining space is not in it yet) never **starts** a continuation;
  it stays on the previous line even past the width. Overflowing is cosmetic; a
  mis-read block breaks the merge. Only continuations are affected — the first
  line's `// <n>: ` prefix is `readBumps`' own anchor. The Review offered
  "reject the note in `parseNote`" as the alternative; refusing a legitimate
  reason for its prose was the worse trade, so the fold absorbs it.
- Test: `applyBump` "a wrapped reason never starts a continuation line that
  reads back as a block" — **red before the fix** (4 `// <n>: ` lines where 3
  are expected), green after; it asserts the block count, the round-trip of the
  block's text, and that the *next* bump still folds onto it (i.e. the refusal
  the bug caused is gone).

**Mutations (each applied, run, reverted — file restored byte-identical).**

| # | Mutation | Red? |
| --- | --- | --- |
| M12 | `pendingNotes` window back to the newest block (`.slice(-1)`) | 2 red: "TWO notes folded skips both", the `runProtocolBump` crash re-run |
| M13 | `fold` ignores `wouldMisread` (`if (tooWide)`) | 1 red: "never starts a continuation line that reads back as a block" |
| M14 | `BLOCK_START_WORD` without the space/end lookahead (`/^\d+: /`) — the word is `7:`, so it never matches | 1 red: same test |

M14 is the non-vacuity check that matters for (2): it shows the test fails on a
guard that *looks* right but cannot fire, not merely on a missing one.

M15 (delete `pendingNotes`' `notes.length === 0` short-circuit) **survived** —
and that is the honest result, not a missing test: with no notes the filter runs
over an empty array and returns `[]` regardless, so the guard is defensive (it
keeps `slice(-0)` from meaning "the whole file" if the function is ever reused
with the filter removed) and has no observable behaviour to pin. It stays, with a
comment saying why it cannot be tested rather than a test that proves nothing.

**Gate** (from the worktree): `bunx tsc --noEmit` **0 errors** · `bun run lint`
**clean** (965 files; the one trip was Biome format on the new test, fixed with
`biome check --write` on those two files) · `bun test` — **7639 pass, 3 skip,
0 fail** (7642 tests, 546 files, 305 s; the 3 skips are the documented opt-in
ones: live-k8s, live-docker, the real-socket keepalive).

- Narrow slice (`scripts/test/protocol-bump.test.ts` +
  `packages/protocol/test/version.test.ts`): **24 pass / 0 fail**, then **25
  pass / 0 fail** after the end-to-end test was added (AGENTS §4: narrow per
  slice).
- Full suite, run 4× because of two unrelated flakes in files this branch does
  not touch (`git diff main --name-only` has no `packages/exec` or
  `packages/client` entry): run 1 failed `packages/client/test/reattach.test.ts:773`
  (`until: timed out after 3000 ms`, a timing test that passes **54/54 alone**);
  run 2 failed `packages/exec/test/confinement.test.ts` "F2: a hard link…"
  (`WorkspaceWriteError` on a `/var` vs `/private/var` path — passes **46/46
  alone**, 3 consecutive runs); runs 3 and 4 — the last on the **final tree**
  (326 s) — were **fully green**. Neither flake touches the narrow slices, and
  neither is reachable from `scripts/`.

**Unverified, stated honestly:** finding #1's "the Implementation's failure-mode
row also says *refuses* where the code skips" was true — the row is rewritten to
describe what the code does (skip within a window, plus the residual). I did not
re-run the executor's M1–M11 matrix; this round adds M12–M14 and re-ran the
narrow files only, then the full suite.

## Review

*— deepseek-v4-pro, 2026-11-13*

In-context pass (the plan's `Blast: cross-module (process)` allows a standard
Review; a fresh-context pass is still the better call before merge — see the
last bullet).

**What holds.**

- **The 2-hunk goal, measured, not claimed.** The `demo-two-hunk` run produced
  exactly two hunks: `version.ts` `@@ -32 +32,3 @@` and `protocol.json`
  `@@ -4383 +4383 @@`. And `rg` for an exact pin now returns **one** hit in the
  whole repo (`packages/protocol/test/version.test.ts:30`); before, 7 test
  files held one each.
- **The §7 rule is not weakened.** A breaking change still bumps the number, and
  a mixed pair still fails cleanly at `initialize`; what changed is *when* and
  *by whom* the digit is written. `version.test.ts`'s "newest reason comment ==
  the exported number" guard is what keeps the rule honest: you cannot move the
  number without saying why in the same block, and you cannot edit the block out
  of order. Mutations M1/M2/M3 are each red.
- **No silent loss.** The notes are deleted only after `version.ts` lands (M7
  red), a malformed note refuses with the tree untouched, and a re-run after a
  crash skips an already-folded note (M9 red) instead of doubling it. The one
  loss with no test is "merged but forgot to run the command": the note then
  sits on `main` visibly, and the next bump folds it — a visible state, not a
  silent one. Stated in the failure-mode table rather than papered over.
- **`.gitattributes` proven, not assumed.** `.tentacle/tmp/protocol-version-at-merge/attr2.sh`:
  two branches editing *distant* lines of a 64-line JSON — without the line git
  auto-merges a chimera ("k=300 and k=5500 both present"); with it, a conflict.
  My first two attempts at this test were bad discriminators (adjacent lines
  conflict regardless), which is why the third one is the one cited.
- **The conversions keep their property.** Each of the 6 was `no bump by this
  task`; after conversion it asserts the floor the thing needs and leaves its
  real assertion (display class, parse, registration) untouched. `session-log`'s
  was the one purely ceremonial pin (no other assertion in that test), which is
  why its floor is honestly labelled as the hand-off.

**What does not hold / risks.**

- **`scripts/` is imported by a `packages/` test.** `version.test.ts` imports
  the fold rules from `../../../scripts/protocol-bump.ts` so the guard and the
  script cannot disagree. It works (`tsc` covers it via the root `include`), but
  it is a new cross-tree dependency; the alternative — reimplementing the reader
  in the test — is exactly the drift the guard exists to catch. Flagging it as a
  deliberate trade, not an accident.
- **`foldNote`'s width is a soft bound.** A single word longer than the width
  exceeds it; no note is at risk today, and a >100-char line would be caught by
  Biome on the *repo's* files (not on a note's, since the folded result goes into
  `version.ts`, which Biome does check — so it is self-correcting, but only for
  this call site).
- **Review level.** `cross-module (process)`, so this is an in-context Review.
  The AGENTS §10 blast table does not demand fresh-context for it, but this
  touches a rule other models follow, so a fresh-context `/code-review` before
  merge is the safer call — recommended, and the reason this section does not
  claim to be the final gate.
## Review

*— claude-opus-5-5, 2026-11-13* (fresh context; a different model family from the executor)

**Verdict: REQUEST-CHANGES.**

**Gate.** `bun test scripts/test/protocol-bump.test.ts packages/protocol/test packages/daemon/test/version-mismatch.test.ts`: 328 pass, 0 fail. `bun run lint` clean (965 files). `bun run typecheck` clean. I did not run the full `bun test`.

**Findings.**

1. **HIGH — the crash re-run folds a note twice when 2 or more notes are pending** (`scripts/protocol-bump.ts:192-196`, `pendingNotes`). The "already folded" check compares each note only to the **newest** block. Notes `a`, `b` fold as 25 and 26; a crash before the `rmSync` loop (`:266-268`) leaves both notes on disk; the re-run skips `b` (it matches 26) and folds `a` again as **27**. The numbers stay consecutive, so neither `applyBump`'s guards nor `version.test.ts` catches it: one break silently burns two version numbers and the reason block repeats itself. Repro (`.tentacle/tmp/protocol-version-at-merge/crash.ts`): `rerun: [24…, 25 "break A", 26 "break B", 27 "break A"]`. The test (`scripts/test/protocol-bump.test.ts:120`) uses only one note, so it cannot see this. The Implementation's failure-mode row (`:225`) also says "refuses" where the code skips. Fix: treat a note as applied when its text matches **any** of the last `k` blocks (or the whole trailing run), and add a 2-note crash test that fails on the current code.
2. **MEDIUM — `foldNote` can write a continuation line that `readBumps` reads as a new block** (`scripts/protocol-bump.ts:150-167` vs `:117-131`). If the prose wraps so that a line starts with `<digits>: ` (e.g. "…since 7: …"), the result is `// 7: y`. The next bump then refuses with "the number is 25 but the newest reason comment is 7", and `version.test.ts` goes red at the merge gate. It fails loudly, but only after the bad fold has already been written, and someone has to fix the block by hand. Repro: the same script, its last line. Fix: never start a continuation with a `\d+: ` word (fold it onto the previous line), or reject such a note in `parseNote`.

**Attacks tried.**
- Multi-note crash idempotence: found #1.
- Wrap/re-read round-trip: found #2.
- §7 protocol rule (`AGENTS.md`), "exact number pinned in ONE test": holds. The 7 edited tests now assert floors (or derive the value from `PROTOCOL_VERSION`), and only `version.test.ts:31` pins 24.
- `.gitattributes -merge` on `protocol.json`: present. `schema:export` runs on every bump, including one with zero notes.
- Malformed notes refused before any write (dir, non-slug, empty): I read the code and it holds. I did not re-run the mutation matrix M1–M9 myself.

**Executor behaviour.** Thorough plan and tests. However, its idempotence claim was proven only for the single-note case and was then stated as general.

### Round 2

*— claude-opus-5-5, 2026-11-13* (fresh context, reviewing `git diff HEAD~1`)

**Verdict: PASS.**

- **#1 HIGH (re-run after a crash folds a note twice): fixed.** `pendingNotes` now checks the last `notes.length` blocks, not only the newest (`scripts/protocol-bump.ts`, `pendingNotes`). A crash in the middle of the deletion loop is covered too: the notes still on disk are the last ones in slug order, and their blocks are the last blocks. My round-1 repro now converges at 26 instead of 27.
- **#2 MEDIUM (a continuation line starting with `<n>:`): fixed.** `foldNote` keeps such a word on the previous line (`BLOCK_START_WORD`). The repro now gives `…x 7:` / `// y`, and the next bump goes through.
- **Mutations (reverted afterwards; `git status` clean).** I applied `slice(-notes.length)`→`slice(-1)` and `tooWide && !wouldMisread`→`tooWide` together: 3 tests failed, namely the 2-note applyBump test, the wrap test and the end-to-end re-run test. I applied the two mutations together, not one at a time; each test's name and assertions point at only one of them.
- **Gate.** `bun test scripts/test/protocol-bump.test.ts packages/protocol/test`: 310 pass, 0 fail. `bun run lint` is clean and `bun run typecheck` is clean. I did not run the full suite.
- **Leftover risk (low, not blocking).** A NEW note whose text is identical to one of the last `k` blocks of a previous release is skipped and then deleted, so that break never gets a number. That needs a word-for-word copy of earlier prose. The risk is the same kind as before the fix, only with a wider window. The doc's "residual" comment covers the case of a match *outside* the window but not this one.
