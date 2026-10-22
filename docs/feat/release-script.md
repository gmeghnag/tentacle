# feat/release-script — `bun run release <version>`

> **Status:** review
> **Branch:** `feat/release-script`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** any model; standard Review

## Context

*— claude-opus-5-5, 2026-10-22*

Child 3 of 3 of `docs/eval/tentacle-update.md`, owner decision **D7**: a
release script bumps every `package.json`, turns `[Unreleased]` into
`[<version>] - <date>` in `CHANGELOG.md`, commits and tags. It refuses on a
dirty tree or a red gate. `0.1.0` is the first public tag.

Today a release is done by hand. The only precedent is `635466c
chore(release): v0.1.0-beta.1`, which edited 15 `package.json` files **and
`bun.lock`** by hand, then created the annotated tag `v0.1.0-beta.1` ("tentacle
v0.1.0-beta.1 — first beta"). CI publishes on a `v*` tag only if the tag equals
`v` + `packages/cli/package.json` `version` (`.github/workflows/build.yml`,
"Check tag matches the CLI version"). `tentacle update` then depends on that
tag.

**Repro** (2026-10-22, `main` @ `916a282`): `bun run release 0.1.0` →
`error: Script not found "release"`. There is no `scripts/release.ts`.

## Implementation

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

**The tag the script creates equals what CI checks.** CI compares
`GITHUB_REF_NAME` with `v$(jq -r .version packages/cli/package.json)`
(`build.yml` release job). The script writes `<version>` into that file and
tags `v<version>` on the commit that contains it. After writing, it re-reads
`packages/cli/package.json` and asserts the version.

### Preconditions

- 15 tracked `package.json` files carry the version: the root and
  `packages/*` (14). Each has a 2-space-indented `"version": "…"` on line 3.
  `stubs/react-devtools-core/package.json` (`0.0.0`, a stub) is not ours and
  is not bumped.
- `bun.lock` repeats each **workspace** version: 14 `"version":` keys, all in
  the `"workspaces"` block before `"packages": {`. `bun install
  --frozen-lockfile` passes without the bump, but a plain `bun install`
  rewrites these entries, which would dirty the tree after a release. So the
  lock is bumped too, as `635466c` did by hand. *(This rationale was corrected
  post-review.)*
- `CHANGELOG.md` has `## [Unreleased]` followed by `## [0.1.0-beta.1] -
  2026-10-21`. It has **no** link-reference (compare) lines today. The code
  handles them anyway, in the GitHub `compare` shape, if they are added later.
- Trailer convention: the release commit `635466c` and recent commits end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `compareVersions` (semver precedence) already exists:
  `packages/cli/src/update-plan.ts:33`.
- `scripts/` is not in `tsconfig` `include`. It is added, so the new code is
  typechecked; `scripts/build.ts` typechecks clean.

### Design

- **Pure module `scripts/release-plan.ts`:**
  - `parseReleaseVersion(input, current, tags)`: strict semver
    (semver.org regex), no `v`, ≥ 0.1.0, > current, and no existing tag;
  - `bumpPackageJson(text, to)`: replaces only the value on the top-level
    `"version"` line, exactly once;
  - `bumpBunLock(text, from, to, expected)`: only the `"workspaces"` block,
    and it requires exactly `expected` replacements;
  - `releaseChangelog(text, version, date)`: refuses an empty
    `[Unreleased]`, inserts a fresh empty `[Unreleased]`, and rewrites the
    compare links if any.
- **`scripts/release.ts`**, `runRelease(argv, deps)` with injected `gate`,
  `today` and `write`; `git` is real. Steps:
  1. Parse args.
  2. Refuse a dirty tree, a branch other than `main`, or package versions out
     of sync.
  3. `git fetch --tags origin` (printed), then refuse if `main` is behind
     `origin/main`.
  4. Validate the version.
  5. Compute every new file text.
  6. Run the gate.
  7. With `--dry-run`, print the plan and stop.
  8. Otherwise write the files, assert the CLI version, then `git add` +
     commit `chore(release): v<version>` with the trailer, and create the
     annotated tag `v<version>`. If the commit fails, restore the original
     texts.
  9. Print the two push commands and what CI does. **Never push.**
  The script is a thin shell under `if (import.meta.main)`.
- Root `package.json`: `"release": "bun run scripts/release.ts"`.
- **Docs:** `docs/RELEASING.md`, linked from the README's Development section.
  Release steps are maintainer-only, so they would only clutter the
  user-facing README.

### Files

`scripts/release-plan.ts` (new) · `scripts/release.ts` (new) ·
`scripts/test/release.test.ts` (new) · `package.json` · `tsconfig.json` ·
`docs/RELEASING.md` (new) · `README.md`.

### Failure modes

| Case | Outcome |
|---|---|
| Bad version (not semver, `v…`, < 0.1.0, ≤ current, tag exists) | error before any write or gate |
| Dirty tree / not `main` / behind `origin/main` / no `origin` | error, nothing written |
| `[Unreleased]` empty or missing | error before the gate |
| Gate red | error, nothing written |
| `bun.lock` count ≠ the number of packages | error before any write |
| Commit fails (e.g. a hook) | originals restored, no tag |
| `--dry-run` | every check including the gate; prints the plan; writes nothing (the fetch only updates remote-tracking refs) |

### Tests

`scripts/test/release.test.ts`. Pure-function tests, plus `runRelease`
against a temp git repo with a bare `origin`, a fake gate and a fixed date. It
covers every case in the brief, plus the `bun.lock` bump, compare links, the
behind-origin refusal and the commit-failure rollback.

## Execution

*— claude-opus-5-5, 2026-10-22*

In order:

1. **Repro:** there was no `release` script and no `scripts/release.ts`.
2. **Verified before writing:**
   - CI guard: `build.yml` release job, `jq -r .version
     packages/cli/package.json` must equal the tag without `v`, so it agrees
     with the script.
   - 15 tracked `package.json` files, plus the stub.
   - `bun.lock` has 14 workspace `"version"` keys, all before `"packages": {`.
   - `CHANGELOG.md` has **no** compare links.
   - The trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
     (`635466c` and the last 20 commits). The beta tag is annotated:
     "tentacle v0.1.0-beta.1 — first beta".
3. **Red first:** the tests in `scripts/test/release.test.ts` ran against
   stub modules (signatures only): 29/29 red on their assertions, not on
   imports. One test expectation was wrong: `0.1.0-beta.1` is refused as
   "< 0.1.0", not as "≤ current". I fixed the test and added a dedicated
   "≤ current" case.
4. **Implemented:**
   - `scripts/release-plan.ts`: `ReleaseError`, `MIN_RELEASE_VERSION`,
     `parseReleaseVersion`, `bumpPackageJson`, `bumpBunLock`,
     `releaseChangelog`. It reuses `compareVersions` from
     `packages/cli/src/update-plan.ts`.
   - `scripts/release.ts`: `RELEASE_TRAILER`, `runRelease(argv, deps)`
     (injected `gate`/`today`/`write`, real git), and a thin
     `import.meta.main` shell (real gate = `bun run check`, inheriting stdio).
   - Root `package.json`: `"release": "bun run scripts/release.ts"`.
   - `tsconfig.json` `include` gains `scripts/**/*.ts`, so the new code and
     `build.ts` are now typechecked (clean).
5. **Tests:** 30, all green. Pure functions, plus `runRelease` against a temp
   git repo with a bare `origin` and a fake gate. Coverage:
   - every bad version;
   - an existing tag present **only on origin**, which the fetch finds;
   - a dirty tree, a non-`main` branch, and `main` behind `origin`;
   - an empty `[Unreleased]`;
   - a red gate;
   - a dry run that writes nothing;
   - the happy path: formatting byte-identical, the stub untouched, one
     commit, an annotated tag on HEAD, not pushed;
   - a commit failing on a `pre-commit` hook, with the files restored;
   - usage errors.
6. **Mutations**, each applied and then restored; every one turned at least
   one test red:
   - remove the dirty, branch, behind, gate, dry-run-return, rollback,
     `bun.lock` bump, empty-`[Unreleased]`, existing-tag or ≤ current check;
   - make the tag lightweight;
   - drop the `fetch`;
   - drop the trailer.
7. **Real run in a scratch clone** of `main`
   (`.tentacle/tmp/release-script/clone`, its `origin` = this local repo; stub
   gate):
   - `--dry-run` listed all 15 `package.json` files, 14 `bun.lock` versions,
     the CHANGELOG change, and the commit and tag.
   - The real run made commit `chore(release): v0.1.0` (17 files, +31/−29) and
     an annotated `v0.1.0`.
   - `bun install --frozen-lockfile` then passed, and Biome found the 15
     `package.json` files clean.
   - Nothing was pushed. The real repo has no `v0.1.0` tag.
   - `bun run release 0.1.0 --dry-run` in this (dirty) checkout refuses with
     "the working tree is not clean".
8. **Docs:** `docs/RELEASING.md` (new) holds the maintainer steps,
   dry-run → release → push → what CI does, plus how to undo before the push.
   It is linked from the README's Development section. I chose it over the
   README because the README is user-facing and the release steps are for
   maintainers only.

**Gate:** `bun run check`: typecheck clean · Biome `Checked 384 files … No
fixes applied` · `1962 pass · 2 skip · 0 fail` (the two opt-in skips).

**Drift:**
- `bun.lock` is bumped too (not in the brief). *Corrected post-review:*
  `--frozen-lockfile` passes without the bump. The real reason is that a
  plain `bun install` rewrites the lock and would dirty the tree after a
  release. `635466c` did the same by hand.
- **Biome ignores `scripts/`** (`biome.json` `ignore`, pre-existing), so the
  new script files are not linted; they are typechecked. I left the Biome
  config alone, to keep this task contained.
- The release commit carries the repo's Claude `Co-Authored-By` trailer, as
  the brief asked. If the owner runs the script alone, that attribution may be
  unwanted; it is one constant (`RELEASE_TRAILER`).
- A dry run still runs `git fetch --tags origin` (it updates remote-tracking
  refs only), so that it can see tags and commits that exist only on origin.


### Post-review fixes

*— claude-opus-5-5, 2026-10-22* (the final REQUEST-CHANGES round). The new
tests were red first. Each fix was then mutation-checked: removing it makes
its test fail again.

1. **No trailer (owner):** `RELEASE_TRAILER` was removed, and the commit
   message is just `chore(release): v<version>`. The happy-path test asserts
   the full message (`%B`) is exactly that.
2. **Tag failure after the commit:** `git tag -a` failures are caught, and the
   script prints `committed <sha>, tag failed: run git tag -a vX -m 'tentacle
   vX' — or undo with git reset --hard HEAD~1`, then exits 1. Test: a stale
   `.git/refs/tags/v0.1.0.lock` makes the tag fail after a real commit.
   `docs/RELEASING.md` has a matching paragraph.
3. **Biome now lints `scripts/`:** `scripts` was removed from `biome.json`
   `files.ignore`. `biome check --write scripts` reformatted the three
   release files. It also reordered the two virtual imports in
   `scripts/yoga-auto.ts`; I redid that by hand to keep each
   `@ts-expect-error` with its own import and the doc comment at the top. The
   two modules have no side effects, and `bun run compile` plus `--version`
   still work.
4. **Tree re-checked after the gate:** if `git status --porcelain` is no longer
   clean, the script refuses with "the working tree changed while the gate
   ran" before writing anything. Test: a gate that creates a file.
5. **`bun.lock` rationale corrected:** in `release-plan.ts` (the
   `bumpBunLock` doc comment), `docs/RELEASING.md`, and the Preconditions and
   Drift above. The real reason is that a plain `bun install` rewrites the
   lock and would dirty the tree; `--frozen-lockfile` passes either way.

Gate after these fixes: `bun run check`. Typecheck is clean; Biome `Checked 389 files … No fixes applied` (now including `scripts/`); tests `1964 pass · 2 skip · 0 fail`.

## Review

*— claude-opus-5-5, 2026-10-22* — same model family as the executor, in a
fresh context, so blind spots we share can get past both passes.

**Verdict: REQUEST-CHANGES.** There are two required changes; both are
small. The safety core holds: every refusal before the writes leaves the repo
untouched, `--dry-run` writes nothing, and a real run in a scratch clone
produced a correct commit and annotated tag that pass CI's guard.

**Gate** (re-run, real repo): `bun run check` passes.
- Typecheck is clean (it now includes `scripts/**/*.ts`).
- Biome: `Checked 384 files … No fixes applied`.
- Tests: **1962 pass · 2 skip · 0 fail** (1964 tests, 161 files).

**Mutations.** Each test failed under its mutation, and the tree was
byte-identical afterwards (shasum checked):
- Empty-`[Unreleased]` guard removed: 2 tests fail.
- Behind-origin check removed: 1 test fails.
- Gate ignored: 3 tests fail.
- Dry run writes: 1 test fails.

**E2E** (`.tentacle/tmp/release-script/`: a bare `origin.git` cloned from
this repo, with the branch's files committed onto `main` @ `b01908f`):

Refusals, each with a clear message:
- `v0.1.0` → "without the v";
- `0.0.9` and `0.1.0-alpha` → "0.1.0 or later";
- an untracked file → "not clean";
- branch `other` → "not main";
- a commit pushed from a second clone → "behind origin/main by 1 commit" (it
  really fetches);
- `v0.1.0` pushed to origin only → "tag v0.1.0 already exists" (via
  `fetch --tags`).

Writes and the real run:
- **`--dry-run`**: status, every ref, the `.git/index` hash and the diff are
  identical before and after.
- **Red gate** (`runRelease` with a gate that fails, and once for real when a
  `session-reaper` GC flake hit the real gate): nothing written; refs and
  index unchanged.
- **Real `bun run release 0.1.0`**: 14 `package.json` files and 14 `bun.lock`
  workspace versions bumped with formatting intact (only the version lines
  differ). The CHANGELOG has a new empty `## [Unreleased]` above
  `## [0.1.0] - 2026-10-22`, and the body is kept. `git cat-file -t v0.1.0`
  → `tag` (annotated). Simulating `build.yml`'s guard
  (`v$(jq -r .version packages/cli/package.json)`) gives `v0.1.0`, which
  matches. `bun install --frozen-lockfile` passes and the tree stays clean.

**`bun.lock` drift: keep it, but fix the rationale.** I restored the
un-bumped lock in the clone:
- `bun install --frozen-lockfile` still **passes** (bun does not treat the
  workspace `version` field as drift), so "CI needs it" is not true.
- A plain `bun install` **rewrites** the lock to exactly the bumped content.

Without the bump, the first `bun install` after a release dirties the tree,
and the next release refuses with "not clean". So the bump is right, for a
different reason.

**Merge with `main` (`b01908f`):** no conflict.
`git merge-tree --write-tree HEAD main` is clean, and the branch's
`README.md` patch applies cleanly on `b01908f`'s README. `b01908f` touches
`CHANGELOG.md`; this branch does not.

**Attacks tried**
1. **Partial failure (commit succeeds, tag fails).** I made
   `.git/refs/tags` read-only in a clone. The output is "release: git tag -a
   v0.1.0 … failed: cannot lock ref", exit 1. The `chore(release)` commit
   **stays, with no tag and no recovery hint**. A re-run then refuses, because
   the current version is already 0.1.0, so the user is stuck (F2).
2. **Gate vs. tree drift.** The tree is checked before the gate (~70 s), not
   after. An edit made while the gate runs would be committed by
   `git add -- <planned>` only if it is to a planned file; that file is
   overwritten by the planned text anyway. Other files stay dirty and
   uncommitted. Harmless (nit N2).
3. **Ordering and atomicity.** All texts are computed before the gate. The
   writes happen only after the gate passes. A failed commit restores the
   originals and resets the index. The tag check uses tags fetched from
   origin. A version at or below current, a pre-release below 0.1.0, and
   `+build` equal to current are all refused, through `compareVersions`.

**Rulings**
- **Lint `scripts/`:** yes. Its rules now ship releases, and it is already in
  `tsconfig`. I ran Biome with `scripts` removed from `ignore`: **format-only**
  issues in `release.ts` and `test/release.test.ts`, plus `organizeImports`
  in `yoga-auto.ts`; no lint-rule violations. Remove `"scripts"` from
  `biome.json:28` and run `biome check --write scripts` (N1).
- **`Co-Authored-By` trailer:** the owner decided the release commit carries
  no trailer, so this is a required change (F1).
- **`docs/RELEASING.md`:** accurate (dry-run side effect, checks, writes,
  publish, pre-release vs "latest", undo steps). It is missing two things:
  the half-done state from F2, with its recovery; and the `--frozen-lockfile`
  rationale at `:43`, which is wrong (see `bun.lock` above).

**Findings**

Required:
- **F1** `scripts/release.ts:24-25,117`: remove `RELEASE_TRAILER`. The
  message becomes `chore(release): ${tag}\n`. Update the test that asserts
  the trailer.
- **F2** `scripts/release.ts:151`: when the tag fails after the commit, catch
  the error and print the state plus both ways out. For example: "committed
  <sha> but the tag failed: <err>. Finish with `git tag -a vX -m 'tentacle
  vX'`, or undo with `git reset --hard HEAD~1`". Add a test (for example,
  pre-create the tag after the version check through a seam), and add a
  matching paragraph to `docs/RELEASING.md` "If something goes wrong".

Nits:
- **N1** `biome.json:28`: lint `scripts/` (see the ruling above).
- **N2** `scripts/release.ts:113-116`: re-check `git status --porcelain` is
  empty after the gate.
- **N3** `scripts/release-plan.ts:65-66` and `docs/RELEASING.md:43`: the
  reason for the bump is "a plain `bun install` rewrites the lock (so the
  tree would be dirty after the release)", not `--frozen-lockfile`. Also fix
  the Execution's claim that `--frozen-lockfile` "would fail on the tag".

**Executor behaviour:**
- Clean split: pure rules in one file, a thin shell around them.
- 30 tests against a real temp git repo with a bare origin; they are not
  vacuous (4 mutations).
- Drifts declared openly.
- Its one unverified premise (`--frozen-lockfile` fails without the bump) is
  false. The conclusion still stands, for another reason.
