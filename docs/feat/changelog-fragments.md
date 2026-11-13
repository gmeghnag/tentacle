# feat/changelog-fragments — per-task changelog fragments, so no task edits `CHANGELOG.md`

> **Status:** context + implementation (owner approval pending — **not approved yet**)
> **Branch:** `feat/changelog-fragments`, cut from local `main` (`e9e7036`, 30 ahead of `origin/main` `5534668`)
> **Type:** feat · **Size:** S–M · **Blast:** cross-module (process) · **Suited:** DeepSeek exec
> **Owner questions:** 6, below — **not approved yet**

## Context

*— claude-opus-5-5, 2026-11-13*

**Why.** Point (2) of `TODO.md:490` (`eval/parallel-tasks`): to run 3–4 code tasks
in parallel, the files *every* task edits must stop being shared. `CHANGELOG.md` is
the worst one — it is a single append point that every user-visible task writes to,
and AGENTS/`docs/RELEASING.md:8-10` tell each executor to do exactly that.

**Evidence, both halves of the reported damage.**

1. **Conflicts.** Every user-visible task edits the same few lines under
   `## [Unreleased]`. Branches in flight today each carry their own
   `CHANGELOG.md` commit (`2f1c946` attachments-tui, `bc77687` attachments-prompt —
   `git log --no-merges -- CHANGELOG.md`), on top of the ones they inherit from the
   stacked branches below them. Five of the last twelve merges landed a
   `CHANGELOG.md` that differs from **both** parents, i.e. had to be hand-resolved:
   `eacac26`, `924186b`, `cbe444c`, `94fcc1f`, `6aaf85c`.
2. **The silent mis-filing.** At `eacac26` (`Merge branch 'feat/attachments-upload'`)
   git merged a branch's new bullet *below* the `## [0.5.0] - 2026-11-12` heading
   that main had gained in the meantime — no conflict, no error — and the repair
   is a separate commit, `c26050e docs(changelog): attachments-upload entry under
   [Unreleased] (merge put it in 0.5.0)`. Replaying the merge reproduces it byte
   for byte (`git merge-tree --write-tree 5534668 0cc4fd7` → tree `6c3aa9e`, the
   real merge's tree).

The second is the more expensive one: a conflict is loud and someone fixes it; a
silently released-into entry ships a wrong release note and empties `[Unreleased]`,
so the next `bun run release` refuses (`scripts/release-plan.ts:107`) for a reason
that looks unrelated.

**Repro** (`.tentacle/tmp/changelog-fragments/`, gitignored — pasted in full;
re-run before editing, `docs/EXECUTOR-BRIEF.md`):

```sh
# repro.sh — case 1: two tasks each add one bullet under [Unreleased]
$ sh repro.sh
=== 1) merge task-a then task-b: the CONFLICT ===
Auto-merging CHANGELOG.md
CONFLICT (content): Merge conflict in CHANGELOG.md
--- conflicted files:
CHANGELOG.md
--- the conflict hunk:
<<<<<<< HEAD
- **Task A's user-visible change.**
=======
- **Task B's user-visible change.**
>>>>>>> task-b

# repro2.sh — case 2: a release lands on main while task-c is open
$ sh repro2.sh
=== merge task-c: no conflict, entry filed under the RELEASED 0.6.0 ===
Auto-merging CHANGELOG.md
Merge made by the 'ort' strategy.
 CHANGELOG.md | 1 +
 1 file changed, 1 insertion(+)
## [Unreleased]

## [0.6.0] - 2026-11-13

### Added

- **The entry on main when the branch was cut.**
- **Task C's user-visible change.**      ← filed under an already-released version

$ bun -e '… releaseChangelog(thatFile, "0.7.0", "2026-11-13")'
REFUSED: CHANGELOG.md: [Unreleased] is empty; write the release notes first
```

**Constraints.** Markdown is not linted (`biome check CHANGELOG.md` →
`No files were processed`; `biome.json` has no `md` parser), so a guard has to be a
**test**, not a lint rule. `CHANGELOG.md` has no compare-link footer to maintain
(`scripts/release-plan.ts:110-114` is a no-op on this file). Releases are cut
by one command from a clean `main` (`scripts/release.ts:64`, `docs/RELEASING.md`),
which already refuses an empty `[Unreleased]`. Changing how executors record
changelog entries is a **substantive §10 rule change** → it rides this `feat`
(AGENTS.md:486-488, carve-out (c)).

**What `[Unreleased]` holds today** (this branch, `CHANGELOG.md:13-16`): four
`### Added` bullets (874–2202 chars each) — the migration input. On `origin/main`
(`5534668`) it is empty, so those bullets exist only on this line of history (local
`main` + the stacked attachment branches). The migration therefore makes a
`CHANGELOG.md` edit that `origin/main` does not: expect one deliberate conflict
when this merges, resolved by keeping this branch's content — **as fragments** —
and emptying `[Unreleased]`. Anyone re-cutting this branch from `origin/main`
later would have nothing to migrate and must drop the migration step rather than
invent entries.

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**That the assembled output is a pure function of `changelog.d/` + the current
`CHANGELOG.md`, and that fragments never share a path between two tasks.**
Proven: two branches adding *different* fragments merge cleanly — `changelog.d/task-b.added.md`
and `changelog.d/task-c.fixed.md` merged with `1 file changed, 1 insertion(+)`,
no conflict (`.tentacle/tmp/changelog-fragments/p3`). Two tasks collide **only** by
using the same slug+category, which is the same filename — so the collision git
sees is a real content conflict, not a silent overwrite.

The second half — that `CHANGELOG.md` itself then needs no per-task edit — follows
from the guard test in *Tests* (1): `[Unreleased]` must stay empty, so any task
that edits it goes red in `bun run test`, which is inside `bun run check`
(`package.json:18`) and therefore inside both the executor gate and the release
gate (`scripts/release.ts:110-114`).

### Preconditions

- `releaseChangelog(text, version, date)` is a pure function of the changelog text
  (`scripts/release-plan.ts:96-116`) — the seam to extend; `release.ts` is the I/O
  shell that computes every new file text **before** writing (`scripts/release.ts:100-107`)
  and restores originals on a failed commit (`:135-140`).
- The release refuses an empty `[Unreleased]` (`scripts/release-plan.ts:106-108`).
  That refusal is replaced by "no fragments in `changelog.d/`", at the same point in
  the flow (before any write, before the gate).
- The release stages its writes with `git add -- <planned keys>`
  (`scripts/release.ts:147`); `planned` is a `Map<string, string>` of *writes only*.
  Verified that deletions need their own staging pass: after `rm changelog.d/x.md`,
  `git add -A -- changelog.d` stages `D  changelog.d/x.md` (`.tentacle/tmp/…/p3`).
- Category order is Keep a Changelog's and already used in this file — `0.3.0`
  runs `### Added` (`CHANGELOG.md:220`) · `Changed` (`:265`) · `Removed` (`:353`) ·
  `Fixed` (`:358`) · `Security` (`:466`).
- `bun run check` = typecheck → lint → test (`package.json:18`); `scripts/**/*.ts`
  is inside `tsconfig.json` `include`, so a new `scripts/changelog.ts` typechecks.
- The gate must not dirty the tree (`scripts/release.ts:116-122`) — so fragment
  deletion happens in the write phase, after the gate, never before it.

### Design

**Fragment = one file, one bullet, on the task's own branch.**

```
changelog.d/<slug>.<category>.md     category ∈ added|changed|deprecated|removed|fixed|security
```

`<slug>` is the task slug (`docs/feat|fix/<slug>.md`'s slug), so the file rides the
task branch and **dies with an abandoned branch** — no orphan cleanup. Content is a
single Keep-a-Changelog bullet, `- **<headline>.**` + prose, one file per entry so
two tasks never share a path.

**Assembly is a pure function** in a new `scripts/changelog.ts` (no I/O, the
`release-plan.ts` pattern, AGENTS §7 "logic lives in pure modules"):

- `parseFragments(files: {path, text}[]) → Fragment[]` — validates the filename
  (`^[a-z0-9][a-z0-9-]*\.(added|…|security)\.md$`), requires a non-empty body that
  is `- `-prefixed and free of `#` headings, then sorts by (category order, slug).
  A violation throws `ReleaseError` — the same message for the test and the script.
- `assemble(changelog, version, date, fragments) → string` — inserts a **new**
  `## [<version>] - <date>` section, grouped by category in Keep-a-Changelog order,
  directly below the (always empty) `## [Unreleased]` heading, and leaves
  `[Unreleased]` empty. **`[Unreleased]` is never written by a task and never holds
  content in `main`** — that invariant is what makes the guard test trivial and
  makes the "entry filed under a released version" failure impossible: there is no
  shared append point left to mis-file into.
- `releaseChangelog` (`scripts/release-plan.ts:96`) is **replaced**: with fragments,
  a non-empty `[Unreleased]` in the tree is itself a refusal (`CHANGELOG.md:
  [Unreleased] has entries; they belong in changelog.d/<slug>.<category>.md`), so
  the old "date the `[Unreleased]` section" path (and its empty-body check at
  `:106-108`) is deleted rather than kept as a second way in.

**Two invariants, and only two.** An earlier draft of this plan also guarded
"`changelog.d/` holds ≥1 fragment" — that is **wrong and would be vacuous or
red-forever**: a release empties the directory, so zero fragments is the normal
state between releases. The two that hold at every commit:

- **I1 — `[Unreleased]` in the tree is empty.** No task can mis-file into it, and
  the release builds the new section from fragments (kills the `repro2.sh` bug at
  the root: there is no shared append point left).
- **I2 — every file under `changelog.d/` is a well-formed fragment** (name, one
  `- ` bullet, no headings).

"A release needs notes" stays a **release-time refusal**, not a test: a test cannot
know whether a release is due.

**Release flow** (`scripts/release.ts`, dependency order):

1. Read `changelog.d/*.md` (a `Bun.Glob`, sorted) **and** `CHANGELOG.md` in step 3
   (`:106`).
2. `fragments.length === 0` → refuse: `changelog.d/ has no fragments; a release
   needs at least one user-visible entry (AGENTS §10)`. This replaces today's
   empty-`[Unreleased]` refusal at the same point — before computed writes and
   before the gate — so a refused release still writes nothing.
3. `planned.set("CHANGELOG.md", assemble(…))`; remember the fragment paths to delete.
4. Gate (unchanged, `:112`), then the *write* phase: write planned files, `rm` the
   fragments, stage with `git add -A -- changelog.d` **plus** the existing
   `git add -- planned.keys()` (`:147`), commit and tag as today. Verified both
   shapes stage the deletion: with the directory present but one file gone
   (`D  changelog.d/task-b.added.md`) and with the directory **removed entirely**
   (`D  changelog.d/only.added.md`, exit 0) — `.tentacle/tmp/changelog-fragments/p3`,
   `/p8`. So a zero-fragment `changelog.d/` is the normal post-release state and a
   fresh clone has no such directory: nothing may assume it exists, and no
   `.gitkeep` is tracked (it would be a shared file every release re-deletes).
5. `--dry-run` prints the assembled section instead of writing it (the human
   preview that replaces reading `[Unreleased]` on `main`).

**The guard is a test** `scripts/test/changelog.test.ts` (pure-function cases) plus
`scripts/test/changelog-guard.test.ts` (repo-level, red on the un-migrated tree —
see *Tests*). It is not a lint rule because Biome does not see Markdown.

**Migration (this branch).** Split `CHANGELOG.md:13-16` (four `### Added` bullets)
into four files `changelog.d/attachments-tui.added.md`,
`attachments-prompt.added.md`, `attachments-upload.added.md`,
`attachments-tui-detect.added.md` (one per real task, from
`git log --no-merges -- CHANGELOG.md`), and leave `## [Unreleased]` empty. Content
is moved verbatim — the fragment body is the bullet, no re-wording.

**Rule wording** (this file's §10 change, §10 carve-out (c)):

- `AGENTS.md` — a new bullet after *Index & registries* (`:471-474`):
  *"**Changelog fragments, not `[Unreleased]`.** A task with user-visible impact
  adds `changelog.d/<slug>.<category>.md` on its own branch (one bullet, Keep a
  Changelog category); it never edits `CHANGELOG.md`, which `bun run release`
  assembles from the fragments and deletes. `[Unreleased]` stays empty in the tree.
  Internal/dev/test-only work adds no fragment — the changelog is curated, not a
  commit mirror (`docs/eval/changelog-discipline.md`)."*
- `docs/EXECUTOR-BRIEF.md` — one line under *Before you declare done* (`:39-47`),
  next to the gate, since a missing fragment is a `bun run check` failure.
- `docs/TASK-TEMPLATE.md` — a comment line in the front-matter block: a
  user-visible task names its fragment file; the executor creates it.
- `docs/RELEASING.md:6-10` — step 1 becomes "the fragments are the release notes";
  the dry run prints the assembled section.

**Also evaluated (recommendation in Owner questions, not built here):**

- **`PROTOCOL_VERSION`** (`packages/protocol/src/version.ts:27`) — two parallel
  bumps **do** conflict, and worse than a changelog. Verified: two branches bumping
  23→24 with different comment text conflict (`<<<<<<< HEAD // 24: task ONE` vs
  `// 24: task TWO`); two branches bumping to *different* numbers also conflict.
  Identical number **and** identical comment merge cleanly, but a mid-merge pair
  then claims one number for two tasks. And the number is pinned exactly in **7
  test files** (`protocol/test/{truncated-kind,session-log,subagent-panel,updates,dsml-leak-kind,wire-stop-reason}.test.ts`,
  `daemon/test/version-mismatch.test.ts`), so every bump is 8 shared edits.
  → Recommend: tasks stop editing `version.ts`; a bump becomes one orchestrator
  merge-time commit, and the exact pin collapses to **one** test so that commit is
  2 hunks. That is a separate task (see Q3).
- **`packages/protocol/schema/protocol.json`** — generated (`bun run schema:export`,
  `package.json:19`), 4374 lines, and touched by **every** task that changes a
  message shape (each of the four attachment branches has it).
  A generated file must never be hand-merged. → Recommend: after every merge the
  queue re-runs `bun run schema:export` and stages it; `packages/protocol/test/json-schema.test.ts:39`
  ("schema/protocol.json equals the document built from the zod schemas") already
  proves drift, so a bad merge cannot survive the gate. Optionally
  `.gitattributes`: `packages/protocol/schema/protocol.json -merge` makes the
  conflict loud instead of an auto-merged chimera (see Q4).
- **`TODO.md`** — **confirmed not a conflict source**: in the last 25 merges, none
  has a `TODO.md` differing from both parents. In-flight branches touch it in
  1-line/1-line edits to *their own* entry (`6cedc80`, `git log --numstat`), and
  distinct-line edits merge cleanly. Note it is not main-only today (the orchestrator
  edits it on branches too, `docs(todo): …` commits), which is fine precisely
  because each edit is one task's own line. → Recommend: leave it a single file;
  state the convention (one task = its own line) rather than splitting it (Q5).

### Files

Dependency order (pure module → script → tests → rule text):

1. `scripts/changelog.ts` (new) — `CATEGORY_ORDER`, `parseFragments`, `assemble`; reuses `ReleaseError` from `release-plan.ts` so the script and the tests share one message.
2. `scripts/release-plan.ts` — `releaseChangelog` (`:96-116`) is replaced by `assemble`; keep only a refusal for a non-empty `[Unreleased]`.
3. `scripts/release.ts` — read `changelog.d/`, refuse when empty, `assemble`, delete + stage fragments after the gate, restore them on a failed commit, dry-run preview, summary lines (`:125`).
4. `scripts/test/changelog.test.ts` (new) — pure cases.
5. `scripts/test/changelog-guard.test.ts` (new) — repo-level guard (`[Unreleased]` empty, every fragment well-formed). It lives beside `release.test.ts` because it guards the same file the release owns; the precedent for a repo-level Markdown guard is `packages/config/test/readme-config-table.test.ts:6-8` (reads `README.md` from `import.meta.dir`).
6. `changelog.d/{attachments-tui,attachments-prompt,attachments-upload,attachments-tui-detect}.added.md` (new) — the migration; `CHANGELOG.md` loses lines 13-16.
7. `AGENTS.md` (§10 bullet) · `docs/EXECUTOR-BRIEF.md` · `docs/TASK-TEMPLATE.md` · `docs/RELEASING.md`.
8. `TODO.md` — the `eval/parallel-tasks` entry: point (2) done for the changelog.

No `packages/` production code, no protocol change: the blast is the *process*.

### Failure modes

| Failure | Today | With fragments |
| --- | --- | --- |
| Two tasks add an entry | conflict (`repro.sh`) | two different files, clean merge (proven, p3) |
| A release lands while a task is open | **silent** mis-filing (`repro2.sh`) | the fragment names only the category; the version section is built at release → impossible |
| Two fragments, same slug+category | — | same path ⇒ a real content conflict (loud). Identical bodies would merge as one file; the guard cannot read intent, so it stays a Review note. Distinct tasks carry distinct slugs (`docs/<type>/<slug>.md`), so this is a mistake, not a normal case |
| Release with no fragments | refuses "`[Unreleased]` is empty" | refuses "`changelog.d/` has no fragments" — same place, before the gate, nothing written |
| Fragment for a task never merged | — | it lives **only** on that branch and disappears with it (no orphan to clean up). A fragment committed straight to `main` under the docs carve-out can outlive its task; the `--dry-run` preview is the human check — no test can see intent |
| Malformed fragment | — | `parseFragments` throws → red in `bun run test`, and `bun run release` refuses before writing |
| A task edits `[Unreleased]` by hand | allowed | guard test red in `bun run test` (inside the gate, `package.json:18`) |
| A task edits an **already-released** section by hand | possible (`eacac26`) | **not** caught by the guard: I1 says nothing about the released sections. Accepted, and honest: what changes is that no workflow step points there any more (a task writes a file, not a section), and `assemble` never touches released sections — so the merge that produced `eacac26` has nothing left to misfile. A test cannot detect intent; the `--dry-run` diff is the backstop |
| The migration conflicts with `main` | — | expected: `origin/main`'s `[Unreleased]` is empty while this branch's has 4 bullets. Resolve by *keeping this branch's content* (as fragments) — the deletion of the bullets is the point |
| A failed commit / tag during release | files restored (`:135-140`) | same restore must include the fragments' **content** (a restore map of writes) and a `git reset` of the staged deletions — the delete is not a write, so it needs its own restore path |
| Gate dirties the tree | refused (`:116`) | unchanged; deletions happen after the gate |

### Tests

Red-before-green (§9), each asserting the property that fails today:

1. **`scripts/test/changelog-guard.test.ts` — "`[Unreleased]` is empty" (I1)**: read
   the repo's `CHANGELOG.md`, assert the text between `## [Unreleased]` and the
   next `/^## /` is blank. **RED today** (4 bullets, `CHANGELOG.md:13-16`); green
   after the migration. **Non-vacuity is the point here** (a guard that passes on a
   hand-edited `[Unreleased]` silently restores this bug): the test must be shown
   red by *mutation* — re-add one bullet under `[Unreleased]`, watch it fail, revert.
   Also assert the negative case directly: a fixture text with an entry under
   `[Unreleased]` is rejected, so the assertion is not "the file happens to be
   short".
2. **"every `changelog.d/*.md` is a well-formed fragment" (I2)**: filename matches
   the slug+category pattern, body is one `- ` bullet, no `#` heading. Passes
   **vacuously** on an empty directory, which is correct (post-release) — so it
   must ALSO be driven over a fixture list (`parseFragments` refusal matrix, test
   4) for the red-first evidence. State that honestly in the Execution: this test's
   red-first demo is `parseFragments`, not the directory scan.
3. **`scripts/test/changelog.test.ts` `assemble`**: given `base` changelog (empty
   `[Unreleased]`) + 3 fragments in a scrambled order → one new
   `## [9.9.9] - 2026-11-13` section, categories in Keep-a-Changelog order, slugs
   alphabetical within a category, `[Unreleased]` still empty, output idempotent.
   **RED today** (no such export). Determinism is the property: same input ⇒ same
   bytes, so a re-run of a release produces no diff.
4. **`parseFragments`** refusal matrix: bad category, uppercase slug, `_` in slug,
   empty body, body not starting with `- `, a `###` heading inside — each with its
   message. RED today (function absent).
5. **`runRelease` end-to-end** (`scripts/test/release.test.ts` fixture repo, the
   existing `deps()`/`snapshot()` seams): with two fragments → committed
   `CHANGELOG.md` holds them under `## [0.1.0] - <date>`, no fragment is left in
   the commit (`git ls-tree -r HEAD --name-only` has no `changelog.d/`), and
   `git status --porcelain` is empty afterwards (the release must not leave the
   deletions half-staged). **RED today** (fragments untouched, `[Unreleased]`
   dated instead).
   Second case: **no fragments** → exit 1, `snapshot()` unchanged, `gateRuns === 0`
   (refusal before the gate, the existing `refused()` helper).
   Third: dry run writes nothing, leaves `changelog.d/` intact, and prints the
   assembled section.

A **known drift** in that file: its fixture changelog is not empty —
`const CHANGELOG` (`scripts/test/release.test.ts:121-122`) puts `### Added` /
`- Everything.` under `## [Unreleased]`, and the happy-path test asserts the old
result (`:205-207`, `"# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-22\n\n### Added\n\n- Everything.\n…"`).
Under this design an entry under `[Unreleased]` is a refusal, so the fixture must
become **empty `[Unreleased]` + `changelog.d/everything.added.md`**, and that
expectation becomes the assembled string (one assertion, `:208-209`, plus the
fixture at `:121-122`). Note the existing empty-`[Unreleased]` refusal has **no**
test today (`scripts/release-plan.ts:107` is unasserted) — so the executor adds
that case too, and reports drift if this count is wrong.

Fakes/seams: none new — the `beforeEach` fixture repo in `scripts/test/release.test.ts`
(`:137-172`, with an injected `gate`/`today`/`write` at `:174-181` and the
`refused()` helper) is exactly the seam the plan needs: two `writeFileSync` calls
into a `changelog.d/` directory it creates.

### Owner questions

*— claude-opus-5-5, 2026-11-13*

**Q1 — Category vocabulary.** Filename suffix from Keep a Changelog's six
(`added|changed|deprecated|removed|fixed|security`), even though this file has only
ever used five? **Rec: yes, all six** — the filename must name the section it lands
in, and a `Deprecated` entry is one file, not a schema change later.

**Q2 — Does `[Unreleased]` stay permanently empty in the tree?** Two shapes:
(a) **empty always** — `bun run release` builds the new version section from
fragments (I1: a non-empty one is a refusal); (b) fragments are assembled into
`[Unreleased]` on each merge and the release only dates it (changesets style, keeps
`release-plan.ts:109` intact, but the shared append point comes back).
**Rec: (a)** — it is the only shape where no shared file is written by any task,
which is the whole point of the task; the `--dry-run` preview replaces reading
`[Unreleased]`.

**Q3 — `PROTOCOL_VERSION` at merge time.** Two parallel bumps conflict (proven:
9 shared edits — `version.ts:27` + 7 exact-pin test files), and a mid-merge pair
can claim the same number for two changes. **Rec: adopt it, but as its own
follow-up task** (`feat/protocol-version-at-merge`, S · cross-module): a task
records the bump's reason in its fragment, an orchestrator merge commit assigns
the number, and the exact pin collapses to one test so the bump is 2 hunks. Doing
it inside this feat would spread this task over 8 protocol files and nothing here
depends on it.

**Q4 — `protocol.json`.** Generated, 4374 lines, touched by every task that
changes a message shape (all four attachment branches have it).
**Rec: never hand-merge; regenerate after every merge** (queue step:
`bun run schema:export` + stage), relying on `json-schema.test.ts:39` to prove no
drift. Optional hardening: `.gitattributes` `packages/protocol/schema/protocol.json
-merge`, so git reports a conflict rather than auto-merging a chimera. Approve the
`.gitattributes` line?

**Q5 — `TODO.md`.** Confirmed not a conflict source (0 of the last 25 merges differ
from both parents), because a task edits only its own line. **Rec: keep one file**
and state that convention in AGENTS ("a task edits only its own `TODO.md` entry; the
orchestrator updates status on `main`") — no per-task files, no split. A split would
cost the grep-ability that makes it the index.

**Q6 — Do the evaluated hotspots ship here?** They are analysed above and
**deliberately not in this task's Files**: this feat is about the changelog, and
bundling `PROTOCOL_VERSION` would put 8 protocol files on a branch whose Review is
about a §10 rule. **Rec: keep them out**; Q3/Q4 become their own S-sized tasks, and
the merge queue in `eval/parallel-tasks` point (1) is what makes them safe
in the meantime. `TODO.md` needs only the convention (Q5), not a task.

## Execution

*(empty — not approved yet.)*

## Review

*(empty — the reviewer fills it in a fresh context; it must red-team the §10 rule
wording and confirm the guard test is non-vacuous by mutation, since a guard that
passes on a hand-edited `[Unreleased]` would silently restore this bug.)*

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED.
