# feat/tui-notice-palette — Notices in one soft blue, hint in grey

> **Status:** review
> **Branch:** `feat/tui-notice-palette`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet executes; standard in-context Review
> Type: feat · Size: S · Blast: contained · Suited: Sonnet. The hint stays laptop-local (no protocol schema crossed), so the rating holds.

## Context

*— claude-sonnet-5-5, 2026-11-06*

Owner decision (2026-11-05): every TUI notice (`noticeLines`, `packages/tui/src/render-lines.ts`) was `⏺` + text, all `theme.subtle` grey. It gets ONE notice colour, soft blue (dark `#8caaee`, light `#3b5bdb`), and its hint is grey. A notice gains a separate optional `hint` field, never parsed out of the text. The TUI has one palette today, so the dark value is in use and the light hex is a named constant for the light-theme task. Separator notices and `Container config: {…}` (no hint) are unchanged.

**Repro (capability missing):** on `main`, `itemLines({kind:"notice", text, hint})` has no `hint` field and the whole line renders `theme.subtle` (`\e[38;2;140;140;140m`); the new test fails on that (3 of 6 assertions red, the rest red on the missing exports).

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

The hint can travel `notify` → hub → feed → display item → render without touching a protocol schema: notices are laptop-local (`NoticeHub` in `cli`, `NoticeFeed` in `tui`), never sent over RPC. Verified: `notice-hub.ts` and `App.tsx` `NoticeFeed` are the only hops; no `@tentacle/protocol` import.

### Preconditions

- chalk bakes its colour level when a styler is created (`chalk.hex()`; `node_modules/chalk/source/index.js:99-101`), so escape codes can only be asserted in a process that starts with colour on.
- AGENTS §7 "never write raw to the terminal": the path stays `NoticeHub.notify`.

### Design

- `theme.ts`: `noticeHex = "#8caaee"` (in use), `noticeHexLight = "#3b5bdb"` (comment: for the light-theme task), `theme.notice = chalk.hex(noticeHex)`.
- `state.ts`: `NoticeItem.hint?: string`; `appendNotice(…, {host?, hint?})`.
- `render-lines.ts`: `noticeLines(text, hint?)` — bullet and text `theme.notice`, hint `theme.subtle` appended to the LAST line after a space.
- `App.tsx`: `NoticeFeed.onNotice(listener: (text, hint?) => void)` passes the hint on.
- `cli/notice-hub.ts`: `notify(text, hint?)`, the buffer keeps `{text, hint}`.
- Senders: `carried-settings.ts` `settingsNotices` returns `{text, hint?}[]` (`Session settings` + `(/clear to reset)`; `Container config` none); `createSettingsNotifier` / `notify` deps in `local-runtime.ts`, `engine-runtime.ts`, `main.ts` widened to `(text, hint?)`; `attach-run.ts` `auto-accept on` + `(Shift+Tab to turn it off)`.
- Plain-text sink: `relay.ts` `notices.onNotice((text, hint) => log(hint ? `${text} ${hint}` : text))`.

### Files

`packages/tui/src/{theme,state,render-lines,App}.ts(x)`, `packages/cli/src/{notice-hub,carried-settings,local-runtime,engine-runtime,main,attach-run,relay}.ts`, tests, `CHANGELOG.md`.

### Failure modes

- Empty hint → treated as absent (no trailing space).
- Notice buffered before the TUI subscribes → the hub buffer keeps the hint (tested).
- Multi-line text → the hint ends the last line (tested).
- Dedupe in `createSettingsNotifier` keys on `text` only (the hint is constant per kind).

### Tests

- `packages/tui/test/notice-palette.test.ts` (+ `notice-palette-probe.ts`, a child process with `FORCE_COLOR=3`): exact SGR of bullet+text blue, hint grey, no-hint, multi-line, separator stays grey; tokens; `appendNotice` keeps `hint` separate.
- `packages/cli/test/notice-hub.test.ts`: hint travels buffered and live.
- `carried-settings.test.ts`: hint is its own field, absent from `Container config`; existing expectations read through a `text hint` join (the `relay.log` view). `attach-run.test.ts` / `model-proxy.test.ts` read the same plain-text view.

## Execution

*— claude-sonnet-5-5, 2026-11-06*

Red first: `notice-hub` hint test failed on the assertion; the palette test failed on missing exports. Implemented in the order above. Drift: (1) the SGR test could not use `chalk.level = 3` in-process (stylers made at import keep the import-time level: observed `\e[97m` / `\e[37m`), so it asserts on a child process with `FORCE_COLOR=3`. (2) `notify` deps in `local-runtime`/`engine-runtime`/`main` had to be widened so the settings hint is not dropped on the way (typed end to end). Mutation: `noticeLines` back to `theme.subtle` → 3 palette tests fail; restored.

Gate: see Review. A stray debug file `packages/tui/test/zz-dbg.test.ts` was written by mistake into the main checkout (`/Users/gmeghnag/tentacle/…`), not the worktree, and could not be removed from here — delete it by hand.

## Review

*— claude-sonnet-5-5, 2026-11-06*

In-context review only (contained, S). Protocol untouched; no wire/persistence change.
