# fix/release-relay-version — `bun run release` refuses since apps/relay exists

Type: fix · Size: S · Blast: contained · Suited: any

## Context

`bun run release 0.7.0 --dry-run` (2026-11-19) → `bun.lock: found 16 workspace versions at 0.6.0, expected 15`. `apps/relay` (added after v0.6.0, d2eaf93f) carries `"version": "0.6.0"` and bun.lock lists it as a workspace version, but `scripts/release.ts` bumped only `package.json` + `packages/*/package.json`. Owner chose the quick fix.

*— claude-opus-5-5, 2026-11-19*

## Implementation

Release also bumps every `apps/*/package.json` that carries a version (apps/relay); an app without one (apps/mobile, versioned by Expo) is left alone — exactly the set bun.lock gives a workspace version. Test: the `runRelease` fixture gains a versioned `apps/r` (bumped) and an unversioned `apps/m` (untouched).

*— claude-opus-5-5, 2026-11-19*

## Execution

As planned (`scripts/release.ts` file list; `scripts/test/release.test.ts` fixture). Red before the fix: 4 `runRelease` tests failed on the count mismatch; green after (36/0). No changelog fragment (dev tooling).

*— claude-opus-5-5, 2026-11-19*

## Review

In-context (S, contained): the real `bun run release 0.7.0 --dry-run` is the end-to-end check, run after merge.

*— claude-opus-5-5, 2026-11-19*
