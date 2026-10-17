# Migration: React 18 → 19 (and Ink 5 → 8)

> **Status:** open — still on React 18.3.1 + Ink 5.0.1 (`packages/tui/package.json:14,18`) · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

## Problem (why)

We are pinned to **React 18.3.1 + Ink 5.0.1** (`packages/tui/package.json:14,18`).
Ink 5 carries two defects we have had to work around:

- A reconciler/measurement bug where a nested `<Text inverse>` block cursor
  bleeds onto the box border across re-renders — fixed upstream in **Ink ≥ 6.6**
  (verified: broken on 6.5.0, clean on 6.8.0/8.0.0). See `docs/library-bugs.md`.
  We ship a sibling-`<Text>` workaround in `LineInput.tsx`.
- No Home/End through `useInput` (they arrive as `input=""` with no flag). Native
  `key.home`/`key.end` land in **Ink ≥ 7.1.1** (`build/hooks/use-input.js:48-49`).
  We bind line start/end to Ctrl+A/Ctrl+E (`input-actions.ts`).

Every Ink version that fixes these requires **React ≥ 19** (Ink 6 peer is
`react>=19.0.0`, Ink 8 is `react>=19.3.0`). So React 19 is the gate. This plan
does the coupled **React 18→19 + Ink 5→8** bump, retires the two workarounds'
*need* (we keep the code, it stays correct), and keeps us current.

> This is a want-driven migration, not a forced one. Everything works today. Do
> it when the benefit (upstream fixes, currency, future Ink features) is worth
> the verification cost below — not reflexively.

## Is it worth it? Cost/benefit (verified 2026-10, against the release notes)

**Verdict: not worth it for maintainability/features alone right now.** React 19
gives this project essentially nothing, and Ink 8's gains are nice-to-haves that
are outweighed by a *confirmed* break of our mouse input (below). Do it only if
(a) we deliberately want Ink 8's native scroll primitives to replace the custom
transcript-perf code, or (b) version rot eventually forces it (and forced-under-
pressure is worse than planned).

### React 19 — ~nothing for us

React 19's headline features are DOM/web-oriented: Actions / `useActionState` /
form status, `use()`, `ref`-as-prop (removing `forwardRef`), hydration/SSR,
document metadata, `useOptimistic`. A TUI uses **none** of them. We have no
`forwardRef` to drop, no `react-dom`, and no deprecated APIs (string refs,
`propTypes`, legacy context) to clean up — so even the "removal" wins are zero.
React 19 is purely the **gate** to a newer Ink.
([upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide))

### What Ink 6 / 7 / 8 actually changed (verified)

- **Ink 6.0** ([notes](https://github.com/vadimdemedes/ink/releases/tag/v6.0.0)):
  requires Node 20 + React 19; fixes stale output when output height changes
  (our cursor-bleed bug is in this fix family, landing ~6.6).
- **Ink 7.0/7.1**: requires Node 22 + React 19.2+; uses `useEffectEvent`
  internally so input handlers no longer re-subscribe on every render;
  **Backspace now reports `key.backspace`, not `key.delete`** (we already handle
  both — safe); adds **`useWindowSize()`**; exposes native **`key.home`/`key.end`**
  (7.1.1, `build/hooks/use-input.js:48-49`).
- **Ink 8.0** ([notes](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)):
  requires **React 19.3+**; `stdout`/`stdin`/`stderr` typed as generic streams so
  TTY-only props like `stdout.columns` leave the types; **`useInput` no longer
  receives unrecognized terminal control sequences — mouse reports, focus events
  and cursor-position replies are dropped, and there is NO native mouse API to
  replace them** (#1014); adds `contentOffsetX/Y` + `overflow="hidden"` +
  `incrementalRendering` for scrollable, low-flicker views; adds
  `clientWidth`/`clientHeight` to `measureElement()`/`useBoxMetrics()`;
  `minWidth`/`maxWidth` accept numbers only; Escape no longer sets `key.meta`.

### Gains that actually matter to us

- **`useWindowSize()`** — cleaner resize handling, and effectively *required*
  (Ink 8 removes `stdout.columns` from the types, which we read at
  `App.tsx:130,233`). Small, real.
- **`useEffectEvent` internally** — input handlers stop re-subscribing each
  render. Free perf.
- **`contentOffsetX/Y` + `overflow="hidden"` + `incrementalRendering`** — native
  scrollable views and reduced flicker. This is the one genuinely attractive
  feature: it **overlaps the custom transcript-perf work** (`tentacle-perf`:
  `layoutTranscript`/`sliceLaid`, warm-cache, flicker). It could let us delete
  hand-rolled slice-scroll + layout code.
- Retiring the cursor-bleed workaround (`LineInput` sibling `<Text>`) and the
  Home/End-via-Ctrl+A/E necessity. Minor (we keep Ctrl+A/E regardless).

### The dominant cost — Ink 8 breaks our mouse

**Confirmed, not hypothetical.** Our entire mouse stack (wheel scroll, drag-
select, copy-to-clipboard) depends on Ink delivering SGR 1006 reports as `char`
through `useInput` (`mouse.ts`, `App.tsx` `dispatchMouse`/`splitMouseReports`).
Ink 8 **drops** those reports and offers **no native mouse hook/events** in
return. So on Ink 8 our mouse features go dark unless we rework input to read
`stdin` raw ourselves (bypassing `useInput`) — a non-trivial rewrite that also
cuts against Ink's direction. This cost dominates the gains above.

### The real decision (not maintainability — architecture)

Ink 8's `contentOffsetX/Y` + `incrementalRendering` solve the *same* problem as
our custom perf primitives. So the honest framing is a fork:

- **Stay on Ink 5** + keep investing in the custom perf work (`tentacle-perf`),
  keep mouse-via-`useInput` as-is. Mouse keeps working; perf stays hand-rolled.
- **Go to Ink 8** + adopt native scrolling (possibly deleting custom layout/
  scroll code) **but rewrite mouse on raw stdin**.

Weigh this *together with* the perf branch decision, never in isolation. Today the
scales tip toward staying on Ink 5 until the native-scroll win (or version rot)
clearly outweighs the mouse rewrite.

## Preconditions (verified against the source)

- **Only `packages/tui` depends on React/Ink.** `packages/tui/package.json:14`
  (`ink`), `:18` (`react`), `:23` (`@types/react`), `:24` (`ink-testing-library`).
  The root has just `@types/react` (`package.json:26`) and a `react-devtools-core`
  stub (`package.json:21`). No other workspace imports React. Blast radius = one
  package + two root entries.
- **The app uses no React-18-only / React-19-removed API.** Grepped `packages/tui/src`:
  no `forwardRef`, `defaultProps`, `propTypes`, `React.FC`, string refs, `ReactDOM`,
  `createRoot`, `react-dom`. Only `useRef`/`useState`/`useEffect`/`useCallback` and
  Ink's own `render` (`run.tsx:56`). JSX is the automatic runtime already
  (`"jsx": "react-jsx"`, `tsconfig.json:9`, `packages/tui/tsconfig.json:5`).
- **`ink-testing-library@4.0.0` runs on Ink 8 + React 19.** Verified this session
  in an isolated scratchpad repro (ink@8.0.0 + react@19.2.0 + itl@4.0.0 rendered
  the nested-cursor sequence cleanly). The test harness's `lastFrame()` SGR
  stripping — which ~all TUI tests rely on — behaved identically.
- **React 19.3.1 is published** (`npm view react dist-tags` → `latest: 19.3.1`),
  so Ink 8's `react>=19.3.0` peer is satisfiable with a released version.
- No `react-dom` anywhere: Ink has its own reconciler, so there is **no
  ReactDOM/createRoot migration** (the usual React-19 headline change is N/A).

## The one load-bearing assumption

> **The React 18→19 step is a dependency + types bump, not an app-code change**,
> because the code uses no removed/changed React API (verified above). The real
> work and risk live entirely in the coupled **Ink 5→8 behavioural delta**
> (reconciler, layout/measurement, input, mouse, alt-screen) — not in React.

Everything below optimises for proving *that* assumption: the repo's **194 TUI
tests** plus a manual soak are the oracle for the Ink delta. If React-level type
errors appear beyond the trivial, this assumption is wrong — stop and reassess.

## Target versions

| Package | From | To |
| --- | --- | --- |
| `react` | 18.3.1 | **19.3.1** |
| `@types/react` | 18.3.12 | **19.x** (match react minor) |
| `ink` | 5.0.1 | **8.0.0** |
| `ink-testing-library` | 4.0.0 | 4.0.0 (keep; verified compatible) |
| `react-devtools-core` | stub 0.0.0 | stub (update, see below) |

Rationale for Ink **8** (not the minimal 6.8): we pay the React-19 migration cost
once; take the latest Ink so we also get native Home/End (≥7.1.1) and the current
line. Fallback if 8 misbehaves: Ink **7.1.1** (peer `react>=19.2.0`) still has the
cursor fix and Home/End.

## Design / strategy

1. **Do it in an isolated git worktree**, not the main checkout — a dependency
   swap of the render engine wants a throwaway space to iterate and a one-shot
   revert (mirrors how the perf work is staged in `tentacle-perf`).
2. **Bump all four deps together** (React and Ink are coupled by the peer range;
   a half-bump is never green). Regenerate the lockfile.
3. **Fix the devtools stub** (see Files). Ink 8's `build/devtools.js` calls
   `devtools.initialize()` **and** `devtools.connectToDevTools()` (gated by
   `isDevToolsReachable()`); our stub only exports `connectToDevTools`/
   `connectWithCustomMessagingProtocol`. Add `initialize: noop` so a DEV import
   never throws.
4. **`bun run check` as the gate**, then the risk-surface soak below. Fix Ink
   deltas where the suite or soak flags them.
5. Only once green: land it, then (optionally, additively) wire native
   `key.home`/`key.end` into `resolveLineInput` alongside Ctrl+A/E, and retire the
   `LineInput` sibling-`<Text>` workaround *if* desired (it stays correct either
   way — keeping it is fine).

## Files to change (dependency order)

- `packages/tui/package.json` — `ink` → 8.0.0, `react` → 19.3.1, `@types/react`
  → 19.x, keep `ink-testing-library` 4.0.0.
- `package.json` (root) — `@types/react` → 19.x (keep it in lockstep with tui so
  one React type version resolves).
- `stubs/react-devtools-core/index.js` — add `initialize: noop` to the exported
  object (and keep `connectToDevTools`/`connectWithCustomMessagingProtocol` +
  `default`). Optionally set the stub's `package.json` `version` to `6.1.2` to
  satisfy Ink's `react-devtools-core` peer range cleanly (bun treats the unmet
  peer as a non-fatal warning otherwise).
- `bun.lock` — regenerated by `bun install`.
- `tsconfig*.json` — **no change expected** (`react-jsx` is correct for 19).
- `packages/tui/src/**` — **no change expected from React**, but two **known Ink-8
  required changes** (not optional):
  - **`App.tsx` dimensions**: `stdout.columns`/`stdout.rows` reads (`:130,:233`)
    leave the Ink 8 types → migrate to **`useWindowSize()`** (also re-renders on
    resize, so it may simplify the resize `useEffect`).
  - **Mouse input rework** (`mouse.ts` + `App.tsx` handler): see the CONFIRMED
    BREAK in the risk surface — mouse reports no longer arrive via `useInput`.
  Any other edit here is an Ink-delta fix discovered by the suite/soak, made
  deliberately.

## Risk surface — the Ink 5→8 deltas to verify (this is the real work)

Each item lists what the repo leans on and how to prove it still holds. The 194
TUI tests cover most; the manual soak covers what the SGR-stripped harness can't.

- **`useInput(char, key)` contract** (`input-actions.ts`, `App.tsx` handler). Ink 8's
  `key` is a superset (adds `home`/`end`); our resolver reads a subset, so it still
  works. Verify `input=""`-blanking of non-alphanumerics is unchanged.
  *Proof:* `test/input-actions.test.ts` + the App integration tests.
- **Mouse (SGR 1006) — CONFIRMED BREAK on Ink 8, not just a risk.** We rely on
  Ink delivering mouse reports as `char` through `useInput` (`mouse.ts`, `App.tsx`
  `dispatchMouse`/`splitMouseReports`). Ink 8 drops unrecognized control sequences
  and has no native mouse API, so wheel-scroll, drag-select and copy stop
  receiving input. **Resolution required before Ink 8 lands:** read `stdin` raw
  ourselves (outside `useInput`) and feed the existing `splitMouseReports`/
  `dispatchMouse` pipeline, or drop mouse. This is the migration's biggest work
  item. *Proof it's handled:* the mouse-wheel/drag/selection tests in
  `test/app.test.tsx` pass again + a manual drag-select-copy soak.
- **Text measurement / layout**: the cursor fix *is* a measurement change, and we
  depend on the "empty `<Text>` is 0×0 → render blank rows as `' '`" rule
  (`render-lines.ts`, `LineInput.tsx`; AGENTS.md §6). Re-verify blank rows, the
  transcript layout, and the input box border don't shift.
  *Proof:* `test/render-lines.test.ts`, the cursor-artifact regression test
  ("one clean line") in `test/app.test.tsx`, and a resize soak.
- **Alt-screen / stdout ownership** (AGENTS.md §7 "never write raw while Ink owns
  the terminal"): confirm Ink 8's alt-screen entry/exit and our `StatusLine`/
  stderr-sink sequencing still hold. *Proof:* manual launch + clean exit.
- **`render()` lifecycle** (`run.tsx:56`): the top-level mount/unmount API is
  stable across Ink 5→8, but re-verify unmount restores the terminal.
- **`ink-testing-library` frame format**: tests assume `lastFrame()` strips SGR.
  *Proof:* the whole suite passing is the signal; a single colour-leak would fail
  many assertions.
- **Compiled binary**: `bun run compile` (`scripts/build.ts`, `bun build
  --compile`) must still bundle — the devtools stub exists precisely to keep this
  lean. *Proof:* build the binary and smoke-run it.

## Failure modes (and how they converge)

- **Peer-range warning** (`react-devtools-core` stub vs Ink's `>=6.1.2`): non-fatal
  in bun; silence it by setting the stub version. No functional impact.
- **DEV devtools import throws** (`initialize` missing): only on `DEV=true`, which
  we never set — but the stub fix removes the latent trap.
- **`@types/react` 19 type breaks**: `ReactNode` no longer includes `{}`, the JSX
  global namespace moves under `React.JSX`. Our components return `ReactElement`
  and don't touch the global `JSX` namespace, so expected impact is nil; `tsc`
  catches any. Fix at the type site, don't `any`-cast.
- **Layout/measurement shift** from the new Ink: a test asserting exact rows/frame
  fails → inspect the frame, adjust the component only if the new output is
  genuinely correct; never loosen an assertion to force green.
- **Mouse goes dark** (confirmed): Ink 8 drops the reports — not a leak but a
  total loss of mouse input. Mitigated only by the raw-stdin rework above; until
  then the mouse tests fail. Also: Escape no longer sets `key.meta` on Ink 8 —
  re-check the escape/abort path (`App.tsx` `key.escape`) and the meta-based
  word-jump fallback (`input-actions.ts` `key.meta && char === "b"/"f"`).
- **Compile fails**: a new transitive dep breaks `bun build --compile` → check the
  devtools stub resolution and any new native/ESM-only dep.

## Tests

- `bun run check` (typecheck + lint + full suite) green — the 194 TUI tests are
  the behaviour oracle for the Ink delta; **no assertion is loosened to pass**.
- The cursor-artifact regression test stays (it now passes for two reasons: our
  sibling-`<Text>` render *and* the upstream fix) — keep it as a guard.
- Add (post-migration, additive) resolver cases for native `key.home`/`key.end`
  mapping to `moveLine`, if we wire them.

## Validation

- Run entirely in the worktree first; `bun run check` green against the §6
  baseline.
- **Manual soak** (what the harness can't see): launch the TUI, exercise
  alt-screen enter/exit, mouse drag-select + copy, terminal resize (re-layout),
  bracketed + Cmd+V paste, multi-line prompt + Ctrl+O expand, the permission
  prompt, and Ctrl+C/clean exit. Confirm no raw-write corruption and a clean
  terminal on exit.
- `bun run compile` and smoke-run the standalone binary.

## Rollback

The change is four dep lines + the stub; revert is a single `git revert`/branch
drop. Keep the whole migration on its own branch so main is never half-migrated.

## Notes / debt

- **Keep Ctrl+A/E** as the primary line-start/end binding even with native
  Home/End available — it is the portable readline convention and works on every
  terminal. Native Home/End is an additive nicety.
- After migrating, the `LineInput` sibling-`<Text>` cursor and this plan's
  `docs/library-bugs.md` Ink entry can be simplified/closed (the bug is fixed
  upstream), but only as a deliberate follow-up — the workaround is harmless.
- Not in scope: adopting React 19 features (Actions, `use`, `ref` as prop). This
  migration is version-currency only; feature adoption is separate.
