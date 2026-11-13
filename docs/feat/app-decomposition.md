# feat/app-decomposition — Break up `App.tsx` so TUI features stop colliding

> **Status:** implementation (plan awaiting owner approval)
> **Branch:** `feat/app-decomposition` (parent/plan); one child branch per slice, below
> Type: feat · Size: L (split) · Blast: load-bearing · Suited: Opus plan, DeepSeek exec per slice, fresh Opus review per slice

## Context

*— claude-opus-5-5, 2026-11-13*

**Problem.** `packages/tui/src/App.tsx` is 4602 lines, and almost every TUI
feature edits it, so only 1–2 code tasks can run at once (AGENTS §10). The
owner approved (2026-11-13) a behaviour-preserving decomposition whose goal is
**parallelism**: after it, a typical TUI feature adds files (a command, a key
layer, a panel, a hook) instead of editing App.tsx.

**Evidence — collisions (git, 2026-11-13).**
- Since 2026-10-01, **78 of 119** non-merge commits touching `packages/tui/src`
  touched `App.tsx` (`git log --since=2026-10-01 --no-merges -- packages/tui/src/App.tsx | wc -l`).
- The last 40 subjects (`git log --format=%s -- packages/tui/src/App.tsx | head -40`)
  are nine different tasks, all on App.tsx: `attachments-tui` (exec + 2 rounds),
  `dock-list-type-through` (2), `local-subagent-panel-unwired`,
  `connect-functest-batch`, `connect-model-error` (2 + a main merge),
  `autoaccept-wake-turns`, `clear-connect-unbound`, `shell-jobs-panel` (3),
  `clear-silent-noop` (2) and `subagent-panel` (4) — the last two were merged
  into each other ("Merge main into feat/subagent-panel (clear-silent-noop)"),
  `clear-keeps-jobs` (2), `subagent-background-ui` (2), `tui-light-theme`
  ("Merge branch 'main' into feat/tui-light-theme"), `session-settings-apply` (4).
- 28 test files under `packages/tui/test/` render `App` (`grep -l 'App.tsx"' test/*`),
  plus `cli/test/subagent-panel-controller.test.ts`.
- The TODO entry "App.tsx decomposition (partial)" (TODO.md:305) already
  extracted `useLineEditor`, `usePermissionBroker`, `usePaintScheduler`, paste
  helpers, and named the rest: "the mode-based input router + the mouse-stream
  state machine". AGENTS §7 names "the `App.tsx` key handler" as known debt.
  `eval/parallel-tasks` (TODO.md:490) lists the App.tsx key handler as one of
  four parallelism hotspots (with `TODO.md`, the changelog, `PROTOCOL_VERSION`).

**Evidence — where the 4602 lines are (rg map of `App.tsx`, 2026-11-13).**

| Lines | ≈ size | Concern |
|---|---|---|
| 1–155 | 155 | 60 imports, re-exports |
| 156–687 | 530 | exported types (`SessionController` 283–479 alone ≈200, `SessionDirectory`, `NoticeFeed`, `RunQuit`, `AppProps` 508–612), constants, `StreamOpts`, `PendingSendNow` |
| 688–1300 | 610 | ~150 `useRef`/`useState` + setters (dock 929–1060, attach 835–858, session/turn 860–921, wake 1084–1180) and early effects |
| 1300–1555 | 255 | derived layout / status rows / reply insertion / `useDockClock` |
| 1555–1848 | 290 | dock actions: `killChild`, `killJob`, `toggleAgents`, `submitToTarget`, 3 dock effects |
| 1848–2106 | 260 | panels (`openPanel`/`closePanel`) + attachments (`routeAttach`, `convertToChips`, `sendWithImages`) |
| 2106–3008 | 900 | session/turn driver: `streamTurn` (2299), `run` (2465), `onActivity` (2582), `watchSession` (2698), `swapSession` (2799), `sendNow` (2856), `commitHistory`, `drainHeld`, wake |
| 3008–3161 | 150 | `requestQuit`, `runClear` |
| 3161–3530 | 370 | `handleCommand`: guards + one `switch` with 17 cases (3202–3502) |
| 3540–3719 | 180 | `switchTo`, `submit` |
| 3719–3801 | 80 | selection / mouse-hold / paste timers |
| 3802–4421 | 620 | the single `useInput`: 13 ordered priority layers (shift+tab → quit-confirm → send-now chord → permission → ctrl+c → paste → sessions panel → other panel → dock → esc-upload → esc-abort → ctrl+o → palette → mouse (dispatch 4156–4252, chunk state machine 4254–4307) → line editing 4309–4413) |
| 4422–4602 | 180 | JSX |

**Coverage today** (`bun test --coverage packages/tui`, 2026-11-13: 1674 pass,
0 fail): App.tsx 90.7 % functions / 94.5 % lines. Uncovered clusters that a
mechanical move could silently break: `/help` 3207–3209, `/model` 3406–3408,
`/agents` + `/tokens` 3430–3441, `/copy` 3469–3479, `/retry` parts 3446–3453,
`killChild`/`killJob` 1574–1616, `toggleAgents` 1629–1637 (and its ctrl+t at
4094), attach conversion 2001–2088, permission `select`/`pasteClipboard`
3901–3916, palette down/tab/return/esc 4126–4146, the trailing half mouse
report 4267. These are the characterization tests of slice S0.

**Constraints.** Behaviour-preserving (no visible change, no protocol/persistence
change). AGENTS §7: logic → pure modules, components only render; never write
raw to the terminal; single broker (`usePermissionBroker` stays one instance).
§10: no XL — split into S/M slices, each its own branch + fresh review.

**Repro (capability missing).** The collision itself is the evidence above; the
measurable target is "a new slash command / key binding / panel lands without
editing App.tsx", checked by the final review (`git diff --stat` of a sample
feature touches no App.tsx).

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**Key precedence is a single ordered decision, and it must stay one.** Ink
calls EVERY active `useInput` listener for each chunk
(`ink/build/hooks/use-input.js:89`, `internal_eventEmitter.on('input', …)`; no
stop-propagation), so splitting the handler into several `useInput` hooks would
lose the order that today encodes safety (e.g. quit-confirm before permission so
a `y` never approves a freshly opened ask, App.tsx:3814–3833; dock-owned
`ctrl+x` kept out of the send-now chord, 3841–3853). Therefore the router is ONE
`useInput` in App calling ONE pure `routeKey`, over an explicit ordered layer
list. S0 adds a test that pins this (two layers claiming the same key: only
the first acts).

### Preconditions (verified)

- Existing pure modules already hold most decisions; the App only executes:
  `dockKey`/`dockClaimsCtrlX` (`background-focus.ts:352,343`),
  `stepPermissionKey` (`permission-reply.ts`), `stepPaste` (`paste.ts`),
  `sessionsKey` (`sessions-panel.ts`), `resolveLineInput` (`input-actions.ts`),
  `splitMouseReports`/`isMousePrefix` (`mouse.ts`), `clearCommandStep`
  (`clear-command.ts`), `resolveSlash`/`SLASH_COMMANDS` (`commands.ts:26`).
  The decomposition moves **executors and wiring**, it does not re-decide.
- `AppProps` is the only boundary tests use (28 files render `<App …/>`), and
  `index.ts:23–31` re-exports App's types. Keeping both stable means **no
  existing test changes** in any slice — that is the behaviour-preservation proof.
- Forward refs break cycles today (`handleCommandRef` 1127/3530,
  `streamTurnRef` 2171, `swapRef` 2183, `routeAttachRef` 791,
  `runClearRef` 919, `wakeIfPendingRef` 1140). Extracted hooks keep them as
  late-bound refs; they are not "simplified" away inside a move slice.
- Only one other `useInput` exists in the package (`components/SessionPicker.tsx:85`,
  a separate pre-mount Ink tree) — no second listener inside App's tree.

### Design — target module map

Rule for every module (§7): a **pure** `.ts` decides (unit-tested, React-free);
a **hook** `use*.ts` owns refs/effects and executes decisions; a **component**
renders a precomputed view-model. App becomes the composition root.

| Module (new unless noted) | Kind | Takes from App.tsx | Seam features extend |
|---|---|---|---|
| `app-types.ts` | types | 156–687 types (`SessionController`, `AppProps`, …) | add a controller method here, not in App |
| `commands/registry.ts` + `commands/<name>.ts` (one per command) + `commands/context.ts` | pure decide + executor | the 17 `switch` cases 3202–3502; guards 3184–3201 stay in a `dispatchCommand` | **new command = new file + one registry line**; `SLASH_COMMANDS` derived from the registry |
| `keys/route.ts` (pure `routeKey`) + `keys/layers.ts` (ordered list) + `keys/<layer>.ts` executors | pure decide + executor | the 13 layers of 3802–4421 | **new binding = a layer file + one line in the ordered list** |
| `mouse-stream.ts` (pure `stepMouseChunk(held, char, plainKey)`) + `useMouse.ts` | pure + hook | chunk state machine 4254–4307, `dispatchMouse` 4156–4252, selection/hold 3719–3776 | — |
| `useDock.ts` (+ existing `background-focus.ts`, `background-list.ts`) | hook | dock refs 929–1060, actions 1555–1848 | dock rows/effects |
| `useAttachments.ts` (+ existing `attach-*.ts`) | hook | 835–858, 1881–2106 | — |
| `panels/registry.ts` + `usePanels.ts` (+ existing `panel.ts`) | pure + hook | `openPanel`/`closePanel` 1848–1880, panel key layers | **new panel = file + registry line** |
| `useQuitClear.ts` | hook | `requestQuit`, `runClear` 3008–3160 | — |
| `useTurnDriver.ts` | hook | `streamTurn`, `run`, `commitHistory`, `settleSendNow`, `sendNow`, `submit` (2214–2546, 2856–3007, 3586–3718) | — |
| `useSessionLink.ts` | hook | `onActivity`, `watchSession`, `swapSession`, `switchTo`, `drainHeld`, wake/arm (1140–1222, 2106–2213, 2572–2855, 3540–3585) | — |
| `app-layout.ts` (pure) + `AppView.tsx` (component) | pure + component | derived rows 1300–1555, JSX 4422–4602 | view-model fields |

The shared plumbing is an **`AppCtx` port per concern**, not a global store: each
hook/command receives a narrow typed object (`pushNotice`, `sessionRef`,
`stateRef`, `run`, …) that App builds once. A command file sees only
`CommandContext`, so adding one never touches another's code.

### Slices — order, branch, files, parallel-safety

Each slice: behaviour-preserving, **no existing test edited** (new tests only),
its own branch `feat/app-decomp-<n>-<slug>` off `main`, its own short doc
section (Execution/Review appended under this doc's headings, tagged by slice),
fresh-context Opus review. Order maximises parallelism unlocked early.

| # | Branch | Size · Blast | Files | Parallel-safe with |
|---|---|---|---|---|
| S0 | `feat/app-decomp-0-charnet` | S–M · contained (tests only) | new `test/app-keys-precedence.test.tsx`, `test/app-commands.test.tsx`, `test/app-frames.test.tsx` | anything (no src edit); MUST merge before S1+ |
| S1 | `feat/app-decomp-1-types` | S · cross-module | `app-types.ts`, App.tsx (delete + import), `index.ts` | none on App.tsx head (touches imports block); 1 day, do it alone |
| S2 | `feat/app-decomp-2-commands` | M · cross-module | `commands/*`, `commands.ts` (derive list), App.tsx 3161–3530 | S3, S4 (disjoint hunks) |
| S3 | `feat/app-decomp-3-keyroute` | M · load-bearing | `keys/route.ts`, `keys/layers.ts`, `keys/*.ts`, App.tsx 3802–4421 except the mouse block | S2; NOT S4 (same `useInput`) unless S4 lands first |
| S4 | `feat/app-decomp-4-mouse` | S · contained | `mouse-stream.ts`, `useMouse.ts`, App.tsx 3719–3776 + 4156–4307 | S2, S5, S6 |
| S5 | `feat/app-decomp-5-dock` | M · cross-module | `useDock.ts`, App.tsx 929–1060, 1555–1848 | S2, S4, S6 |
| S6 | `feat/app-decomp-6-attach` | S–M · contained | `useAttachments.ts`, App.tsx 835–858, 1881–2106 | S2, S4, S5 |
| S7 | `feat/app-decomp-7-panels` | S–M · contained | `panels/*`, `usePanels.ts`, `keys/panel*.ts` | after S3 |
| S8 | `feat/app-decomp-8-quitclear` | S · load-bearing (§7 lifecycle: quit/close) | `useQuitClear.ts` | after S2 (commands call it) |
| S9a | `feat/app-decomp-9a-turn` | M · load-bearing | `useTurnDriver.ts` | serial (core) |
| S9b | `feat/app-decomp-9b-session` | M · load-bearing | `useSessionLink.ts` | after S9a, serial |
| S10 | `feat/app-decomp-10-view` | M · contained | `app-layout.ts`, `AppView.tsx` | after S9b (last) |

"Parallel-safe" = disjoint App.tsx hunks AND disjoint new files; it still needs
the owner's §10 allowance (Owner Q1) and a rebase + full gate before each merge.
**S2 + S3 unlock the most**: after them, new commands and key bindings are new
files. S3 is split internally into S3a (pure `routeKey` + table, executors still
inline as one `switch` on the route) and S3b (executors to `keys/*.ts`) if the
diff exceeds ~400 lines.

### Tests — safety net

- **S0 first, green on current `main`**, using the `app.test.tsx` harness
  (ink-testing-library + SGR helpers):
  1. *Key-precedence matrix* — for each overlapping pair, the asserted winner:
     quit-confirm vs pending permission (`y`); send-now chord vs dock-owned
     `ctrl+x` (dropdown focused vs pinned); paste with leading ESC vs Esc-abort;
     sessions panel Esc vs running turn; dock Esc vs Esc-abort; Esc with upload
     in flight; palette arrows vs history; ctrl+t; shift+tab in every state.
  2. *Command smoke* — every registry command (incl. the uncovered `/help`,
     `/model`, `/agents`, `/tokens`, `/copy`, `/retry`, unknown command) shows
     its notice/panel; the mid-turn refusal for each session-mutating command.
  3. *Frame set* — `lastFrame()` for idle, running, permission, palette open,
     each panel, dock list/open/drawer, quit confirm, attach chips.
  4. *Uncovered clusters* from Context (kill child/job, attach conversion,
     permission select/pasteClipboard, trailing half mouse report).
  Non-vacuity (§9): each new test is shown failing under a one-line mutation
  of the code it pins (recorded in S0's Execution), then reverted.
- **Per slice:** S0 set + every existing `packages/tui/test/*` green before and
  after, unchanged; the new pure module gets its own unit test
  (`keys/route.test.ts`, `commands/registry.test.ts`, `mouse-stream.test.ts`);
  coverage of the moved lines must not drop (`bun test --coverage packages/tui`,
  compare the App.tsx + new-files line total). Gate: `bun run check`.

### Failure modes

| Mode | How it shows | Design-out / detection |
|---|---|---|
| Key-order drift | a key reaches a later layer (e.g. `y` approves an ask) | one `useInput`, one ordered list; S0 precedence matrix |
| Stale closure | a moved `useCallback` with a narrower dep array reads old state | move dep arrays verbatim; ref-backed reads stay refs; Biome `useExhaustiveDependencies` (in the `recommended` set, `biome.json:8`; executor confirms it fires on a moved hook) + S0 |
| Effect order | effects run in declaration order; moving one into a hook reorders it | call hooks in the original declaration order; slice doc lists every moved effect and its old index |
| Cycle breakage | `run`↔`handleCommand`↔`swapSession` lose late binding | keep the forward refs; never pass a not-yet-defined callback by value |
| Render perf | hooks returning fresh objects per render → extra renders under the 33 ms stream throttle (`FRAME_MS`, 614) | hook results memoised (`useMemo`/stable refs); S9a checks render count during a streamed turn (spy on `usePaintScheduler`) vs `main` |
| Ink gotchas | empty `<Text>` collapses rows; raw writes corrupt alt-screen | S10 keeps `" "` blank rows; no module imports `process.stdout` (rg check in each review) |
| Single broker | a hook creating its own `usePermissionBroker` | broker stays created in App and passed in; existing single-broker test |
| Silent behaviour change in a "move" | reviewer can't see drift in a 600-line move | moves are `git diff --color-moved` reviewable: no edit inside moved blocks except renames to ctx fields, stated in Execution |

### What stays in App.tsx at the end

Props intake, construction of the per-concern ports, the hook calls in fixed
order (`useLineEditor`, `usePermissionBroker`, `useSessionLink`,
`useTurnDriver`, `useDock`, `useAttachments`, `usePanels`, `useQuitClear`,
`useMouse`), the ONE `useInput(… routeKey …)`, and `<AppView model={…}/>`.
Target ≲ 600 lines, no feature logic.

### Other hotspots (CHANGELOG.md, TODO.md, `PROTOCOL_VERSION`)

They block parallelism independently of App.tsx (447 commits since 2026-10-01
touched `CHANGELOG.md`/`TODO.md`; `PROTOCOL_VERSION = 23`,
`protocol/src/version.ts:27`, is a one-line conflict on every protocol task).
**Do not fold them into this task**: fragments / merge-time bumps change a §10
process rule → `eval/parallel-tasks` → its own `feat` (§10 carve-out (c)).
This task only avoids feeding them: slices add no CHANGELOG line (internal
refactor; one entry when the last slice merges) and update only this task's
TODO line.

### Owner questions

1. **Parallel slices before `eval/parallel-tasks` lands?** Rec: allow 2 at once
   when the table says parallel-safe (disjoint hunks), with rebase + full gate
   before each merge; 3–4 only after that eval.
2. **Key layer order: one explicit ordered list vs per-file priority numbers?**
   Rec: one explicit list in `keys/layers.ts` (precedence is a safety property;
   a one-line conflict is trivial to resolve and readable in review).
3. **Freeze new App.tsx-touching features during S1–S3?** Rec: yes for S1 (~1
   day, rewrites the import/type block); features may resume during S2/S3 if
   they don't touch handleCommand/useInput.
4. **One doc for all slices, or a doc per slice?** Rec: this doc as parent;
   each slice appends a tagged Execution + Review section here (one source of
   truth), branch per slice.
5. **May slices rename/clean while moving?** Rec: no — pure moves (color-moved
   diff) only; cleanups become their own S task after S10.
6. **Commands as one file each, or grouped?** Rec: one file per command
   (maximal parallelism; 17 small files is fine).

## Execution

*(empty until the plan is approved; one tagged sub-section per slice, S0 first)*

## Review

*(empty; one fresh-context Opus review per slice)*
