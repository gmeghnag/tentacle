# feat/coverage-badges — coverage + test-count badges in the README, refreshed by every release

Type: feat · Size: S · Blast: contained (a script, the release script's README write, README) · Suited: orchestrator

## Context

*— claude-opus-5-5, 2026-11-26*

Owner 26/11 ~19:45: «sappiamo la codecoverage e test coverage del repo? li mettiamo nel readme come etichette?». Measured with `bun test --parallel --coverage`: 94.4 % of the lines of the files the tests LOAD, but bun's lcov omits files no test imports — 91 React Native screens of `apps/mobile` (covered by the simulator e2e, not by bun) plus 8 small files — so the honest figure over every source file is ~88 %. Owner's choices: badges **"coverage <honest %>" + "tests <n> passing"**, refreshed **at every release** (no external service). Mid-task the owner added: Polpetto in the README should hop and blink («polipetto che fa un salto e sbatte gli occhi»).

## Implementation

*— claude-opus-5-5, 2026-11-26*

- **Load-bearing assumption:** GitHub animates CSS `@keyframes` inside an SVG shown through `<img>` (it strips scripts and README `<style>`, not an image's own CSS); and bun's parallel runner writes ONE merged `lcov.info` with `--coverage-dir` (verified: 980 source records, `LF/LH` per file).
- **Design:** `scripts/coverage-badges.ts` — pure `parseLcov`, `codeLines`, `measureCoverage` (scope = tracked `packages/*/src`, `apps/*/src` `.ts/.tsx`, no `.d.ts`; a file with no lcov record counts its non-blank, non-comment lines as uncovered; percent rounded DOWN), `parseTestCount` (refuses a run with a failure), `renderBadges` (shields static badges, number in text and alt), `withBadges` (block between `<!-- quality-badges:start/end -->`, a missing marker is an error); shell `measureRepo` runs the suite once with coverage. `bun run badges` writes the README; `scripts/release.ts` gets an injected `badges` dep: markers checked before anything runs, measured after the gate, the README written in the release commit and restored with the rest if the commit fails.
- **Failure modes:** a failing test in the coverage run → refused, nothing written; no markers → refused before the gate; a measurement error → refused, tree untouched; a file no test loads → counted as uncovered (never dropped).
- **Polpetto:** `art/polpetto.svg` animated in CSS only: a 4 s loop, a blink (the upper eye row shut, as the app's `body({eyes:"closed"})`, 150 ms), a whole-pixel 2 px hop (step-end), a second blink; none under `prefers-reduced-motion`.
- **Tests:** `scripts/test/coverage-badges.test.ts` (parsers, honest denominator, rounding, refusals, idempotent block, README markers); `scripts/test/release.test.ts` (badges in the release commit, a failed measurement writes nothing, no markers → refused before the gate).

## Execution

*— claude-opus-5-5, 2026-11-26*

As planned. Red: the new test file failed on import before the module existed; the 6 existing release tests failed against the new `ReleaseDeps` until the fixture got a README and the `badges` dep. Mutation: dropping the README write from `release.ts` → 1 release test fails. Animation checked by rendering paused frames in headless Chrome (open / eyes shut at 1.05 s / 2 px up at 2.6 s).

## Review

*— claude-opus-5-5, 2026-11-26*

Gate in the worktree: typecheck 0 errors, `biome check .` clean, `bun run test` green (see the merge commit's gate). First measurement: **coverage 86 %** (138 637 / 160 980 lines, every tracked source file), **20 911 tests passing**. Drift found while measuring: under coverage instrumentation on a loaded machine 8 subprocess-heavy CLI tests passed bun's 5 s default timeout, so the coverage run uses `--timeout=30000`; and a failed run now names its failing tests (one flaky failure seen once, not reproduced). Self-reviewed (contained, S): no fresh-context review.
