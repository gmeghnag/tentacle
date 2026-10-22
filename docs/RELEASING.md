# Releasing tentacle

Releases are cut from `main` by one command. Pushing the tag is the only
step it leaves to you.

## 1. Write the release notes

Put everything user-visible since the last release under `## [Unreleased]` in
`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)), and
merge that to `main`. The script refuses an empty `[Unreleased]`.

## 2. Check the release (changes nothing)

```sh
git checkout main && git pull
bun run release 0.2.0 --dry-run
```

The dry run makes every check of a real run, prints the planned changes, and
writes nothing. The only side effect is that `git fetch` updates the
remote-tracking refs and tags. The checks:

- The version is strict semver **without** the `v` (the tag gets it), at least
  `0.1.0`, greater than the current version, and `v<version>` does not exist
  locally or on `origin`.
- The working tree is clean.
- You are on `main`.
- `main` is not behind `origin/main` (it runs `git fetch` first).
- Every `package.json` is at the same current version.
- `[Unreleased]` is not empty.
- The full gate passes (`bun run check`).

## 3. Release

```sh
bun run release 0.2.0
```

The script makes these changes locally:

- It sets `"version"` to `0.2.0` in every `package.json`: the root and
  `packages/*`, not `stubs/`. It also updates the workspace versions in
  `bun.lock`. Without that, the first plain `bun install` after the release
  would rewrite the lock and dirty the tree.
- In `CHANGELOG.md`, `## [Unreleased]` becomes `## [0.2.0] - <today>`, and a
  new empty `## [Unreleased]` goes above it.
- It commits `chore(release): v0.2.0` and creates the annotated tag `v0.2.0`.

**It never pushes.** If the commit fails (for example because of a hook), the
script restores the files and creates no tag. It also refuses when the gate
changed the working tree.

If the tag fails *after* the commit, the script prints `committed <sha>, tag
failed: …`. The release commit then exists, but there is no tag. Either
finish with `git tag -a vX -m 'tentacle vX'`, or undo the commit with
`git reset --hard HEAD~1`, then fix the cause and run the release again.

## 4. Publish

```sh
git push origin main && git push origin v0.2.0
```

The tag starts `.github/workflows/build.yml`, which then:

1. builds the four binaries (`tentacle-bun-{linux,darwin}-{x64,arm64}`, each
   with its version marker checked by `scripts/build.ts`);
2. checks that the tag equals `v` + `packages/cli/package.json`'s version
   (the script guarantees this);
3. publishes the GitHub release with the binaries and `SHA256SUMS`.

A version with a pre-release suffix (`0.2.0-rc.1`) is published as a GitHub
pre-release, so it never becomes "latest". Otherwise the release becomes
"latest", and `tentacle update` installs it.

## If something goes wrong before the push

Everything is still local. To undo the release:

```sh
git tag -d v0.2.0
git reset --hard HEAD~1
```
