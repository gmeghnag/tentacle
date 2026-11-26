# feat/readme-minimal — a minimal README that links to the guides, with the Polpetto icon

Type: feat · Size: S · Blast: contained (docs + the config-table generator's target path) · Suited: orchestrator

## Context

*— claude-opus-5-5, 2026-11-26*

Owner 26/11 ~19:20: «aggiorna il README, anche l'icona nel readme ora che è cambiata. il readme deve essere minimale ma completo, non entrare nel tecnico ma rimanda a appositi documenti (tipo INSTALL.md per il dettaglio)». The README was 818 lines (every run mode, the generated config table, hooks, packages, voice, development) under the old purple lockup, while the app icon is now Polpetto (docs/feat/app-icon-polpetto.md, final choice H/I).

## Implementation

*— claude-opus-5-5, 2026-11-26*

- **Load-bearing assumption:** only one thing reads README.md's content: the config-table drift gate (`packages/config/test/readme-config-table.test.ts` + `scripts/config-docs.ts`, markers `<!-- config-keys:start/end -->`). Verified with `git grep README` over `*.ts`/`*.sh`/`*.json`; the only Markdown deep links into the README were `docs/extensions.md` (#hooks, #packages).
- **Design:** move the README text VERBATIM (headings shifted one level, relative links rewritten) into `INSTALL.md` (install + getting started), `CONTRIBUTING.md` (development), and `docs/guide/` — `running.md`, `remote.md` (serve/connect, A2A, MCP server), `configuration.md` (with the generated table), `hooks-and-packages.md`, `features.md`. The README keeps: icon, one-line pitch, badges, five "why" bullets, the install one-liner, a three-line quick start, a documentation table, the license. Icon: `art/polpetto.svg`, generated pixel-exact from `MASCOT_BITMAP` (`packages/tui/src/mascot.ts`) with the cyan tones of `packages/tui/src/theme.ts` (the app icon's), transparent background so it reads on GitHub light and dark. The old `art/tentacle-*.svg` stay (other places may use them).
- **Failure modes:** a stale table gate (the test still reading README would fail: it must follow the table); a broken relative link after the move; a deep link into a README anchor that no longer exists.
- **Tests:** the existing drift gate, re-pointed; shown red when pointed at the new README (7 fail) and green on the guide (8 pass).

## Execution

*— claude-opus-5-5, 2026-11-26*

As planned. `scripts/config-docs.ts` `README_PATH` → `docs/guide/configuration.md` (messages say so); the test reads the same file; stale "README table" comments in `key-docs.ts`, `workspace-mount.ts` and one test title updated; `docs/extensions.md` links → the hooks guide. Changelog fragment `changelog.d/readme-minimal.changed.md`. `bun run docs:config` → "up to date" on the guide.

## Review

*— claude-opus-5-5, 2026-11-26*

Gate in the worktree: typecheck 0 errors, `biome check .` clean, `bun run test` 20894 pass / 5 skip / 0 fail. Mutation: the table test pointed back at README.md → 7 fail. Content check: every README line range went to exactly one guide (43–72 INSTALL, 75–342 + 412 running, 343–411 remote, 415–618 configuration, 619–752 hooks-and-packages, 754–791 features, 793–818 CONTRIBUTING); nothing dropped except the old "Why tentacle" prose, which the new bullets replace. Self-reviewed (contained, docs): no fresh-context review.
