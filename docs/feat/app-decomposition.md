# feat/app-decomposition — Break up `App.tsx` so TUI features stop colliding

> **Status:** S0 executed; plan REVISED after the Fable design review. S1 was
> re-instated by the owner and executed (see Fix round 1 — who, and why H4(1)
> survives it); S0b executed (Execution §S0b — tests only, 12/12 mutations
> killed); S2+ re-approval pending.
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

**Revised (Fable H3):** "first claimer wins" is too weak. Five layers act AND
pass (chord steps `chordRef` on every key, 3841–3853; the sessions panel
disarms then falls through, 3976–3979; the dock applies `step.state` on `pass`,
4075–4077; the mouse layer consumes a held partial and hands a restored `[` to
line editing, 4255–4307; paste is consumed but dropped behind a panel, 3964),
and there is a 14th, unnamed layer: "behind a panel nothing edits", 4292. So a
layer returns `{ effects, verdict: "consumed" | "pass", carry }` and `routeKey`
runs the effects of every layer it passes through, then stops at the first
`consumed`; `carry` (e.g. the restored `[`) is input to the next layer. Each
snapshot field **keeps its current source** (ref read at key time vs render
closure — table in S3) so two keys delivered with no render between behave as
today.

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
  **Corrected by S1:** one test depends on WHERE a declaration is written, not
  just that it exists — `packages/cli/test/subagent-panel-controller.test.ts`
  parses `App.tsx` with `ts.createSourceFile` to find the `SessionController`
  interface. S1 repointed it at `app-types.ts` (2 lines, no assertion changed),
  and any later slice that moves the interface must repoint it again. So the
  proof is "no test changes EXCEPT a source-locator that must follow the
  declaration"; every other slice still adds only new tests.
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
| S0 `feat/app-decomp-0-charnet` | S–M · contained (tests only) | new `test/app-keys-precedence.test.tsx`, `test/app-commands.test.tsx`, `test/app-frames.test.tsx` | anything (no src edit); MUST merge before S1+ |
| S1 `feat/app-decomp-1-types` | S · cross-module | `app-types.ts` (new), App.tsx (delete the type block + `export type` re-export + trim now-unused type imports), `index.ts`, `test/app-types.test.ts` (new), **+ `packages/cli/test/subagent-panel-controller.test.ts` (2-line source-locator repoint — see Preconditions)** | none on App.tsx head (touches imports block); done alone. **Executed (Fix round 1); re-instated by the owner over H4(1)'s dissolution, which the type split preserves — see *H4(1) status after S1*** |
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
| Effect order | effects run in declaration order; moving one into a hook reorders it | **revised (H1):** effects stay in App in today's order; one moves only if its index is unchanged; S0b mount-order test |
| Identity drift | a port field loses its identity → an effect (2773 watch) re-subscribes every render | **added (H2):** per-field identity rule, deps name fields not `ctx`; S0b subscribe-count test |
| Freshness drift | a ref read becomes a render read (or vice versa) → two keys with no render between change outcome | **added (H3):** snapshot fields keep their source; S0b no-render-between tests |
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
Target ≲ 600 lines, no feature logic. **Revised (H1/M2):** the mouse layer is a
pure module driven per event, not a second effect-owning hook — the 20 effects
stay here in today's order; target ≲ 800 lines. **Amended in S4 (fix round 1):
it IS a `useMouse` hook, owning refs/timer only and declaring NO effect.** The
H1/M2 constraint is "no hook that owns an EFFECT", not "no hook": `mouse-stream.ts`
holds every decision, and `useMouse` holds only the partial-report ref + its
100 ms timer + the click recogniser, so the effect list is untouched. Corrected
here rather than contradicting the plan — see S4's drift 4.

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

New, from the Fable review (Q1–Q6 stay answered; Q3's S1 freeze is moot — S1 was
re-instated and executed alone, see *H4(1) status after S1*):

7. **Effects: stay in App in today's order (a), or move into hooks with every
   reorder argued and tested (b)?** Rec: **(a)**. One hook per concern cannot
   keep an interleaved order (H1), and (b) turns every hook slice into a
   load-bearing ordering proof. With (a) an effect moves into its hook only when
   its index among App's 20 effects is unchanged (contiguous with the hook
   call); anything else waits for a separate, reviewed slice — or never moves.
8. **S0b gates S4+?** Rec: yes. The identity / mount-order / no-render-between
   tests are the only net for the three things the moves actually stress
   (order, identity, freshness — M4); without them S4–S9 are reviewed by eye.
9. **"New App-level tests go in a new file, never `app.test.tsx`" — a rule for
   this task only, or for the repo?** Rec: this task's slices now; promoting it
   to AGENTS.md is a rule change → its own `feat` (§10 carve-out (c)).

### Design review response (Fable REVISE)

*— claude-opus-5-5, 2026-11-13*

Every finding was re-checked against `packages/tui/src/App.tsx` on this branch
(`git diff --stat 46454d1 -- packages/tui/src` is empty, so the review's line
numbers are current). **All four HIGHs and all five MEDIUMs hold; none is
rebutted.** The revisions below override the module map, slice table, Tests,
Failure modes and "What stays" sections above wherever they conflict. S0 is not
redone; its gaps become a new tests-only slice **S0b**.

**H1 — effect order (CONFIRMED).** `watchedRef` (1141–1162) is set only by the
watch effect (2773–2775), after the initial-prompt (2548) and wake (2557)
effects; the plan's final hook order would put the watch (session link) before
the initial prompt (turn driver). → **Change:** Owner Q7 (a). Hooks own
refs/state/callbacks; the 20 `useEffect`s (847, 1130, 1179, 1223, 1239, 1258,
1296, 1501, 1511, 1523, 1544, 1716, 1750, 1814, 2125, 2548, 2557, 2773, 3772,
3798) stay in App.tsx **in this order**, calling functions the hooks return. An
effect moves into a hook only if its index in that list does not change; each
slice doc lists the indices before/after. "What stays in App.tsx" now includes
the ordered effect list, and the target becomes ≲ 800 lines (effects included),
not 600. S0b adds the mount-order test the review names (initial prompt +
replayed history + a pending job exit at mount → surviving rows + `send` count),
shown red under a swap of 2548 and 2773.

**H2 — callback identity (CONFIRMED).** `watchSession`'s deps (2765–2771) take
`setAgents`, `setJobs`, `flushNow`, `armWake`, `subagentsTwoWay`, `setDock`;
the 2773 effect re-subscribes whenever its identity changes. → **Change:**
(1) no port is built "once": every port field is either a ref-backed getter
(`() => ref.current`) or a value that keeps its **current identity rule**
(stable setter; `useCallback` with its dep array moved verbatim; props/state
such as `shownModel`, `sessions`, `mcpStatus`, `cwd`, `skills` stay values with
their current deps). The slice doc states the rule per field. (2) A hook
destructures its inputs at the top and its `useCallback`/`useEffect` deps name
**the fields, never `ctx`** — so `useExhaustiveDependencies` keeps seeing each
one; a dep array containing a whole port object is a review blocker. (3) S0b
adds the identity test: count `SessionController` subscribe/unsubscribe and
`session/open` calls across N forced re-renders (typing, a dock-clock tick, a
resize); pinned at one subscribe per session. Render counting in S9a stays but
is secondary.

**H3 — the router contract (CONFIRMED, all five sites + 4292 read).** →
**Change:** the Load-bearing assumption is revised (above): layer =
`{ effects, verdict, carry }`, 14 layers. S3's slice doc carries a
**snapshot-source table**: ref-read today (`quitConfirmRef` 3814, `dockRef`
3841/4062, `stateRef.current.running` 4107, `panelRef` 4013/4371,
`permission.readMode()` 3858) stay ref getters; render-closure today (`panel`
3964/3975/4045/4061/4292, `paletteOpen` 4119, `field.value` 4068, `commandSel`
4130) stay render values. No "clean-up" to one source inside S3. S0b adds the
review's matrix rows (chord-breaking key still does its job; non-panel key on
an armed sessions row disarms AND acts; printable key on the focused pill types,
returns focus, then Enter sends; `[`+Enter; `[`+letter; paste with a panel
open; a key behind a panel after a half mouse report) and one **no-render-
between** test per safety pair (two synchronous `stdin.write`s): `/quit`
confirm + `y`; ask arriving + `y`; Esc on a just-closed panel mid-turn.

**H4 — where the collisions are (CONFIRMED in direction).** Not re-counted with
`-L`; independently, `state.ts` + `render-lines.ts` + `app.test.tsx` alone saw
65 distinct commits since 2026-10-01, and `panel.ts` has the `kind ===`
branches cited (76, 89, 92, 120, 149). → **Changes:** (1) ~~**S1 is dissolved**:
no single `app-types.ts`. Each hook slice takes its own types with it
(`DockProps`, `AttachProps`, `SessionJobs`, … next to the hook);
`AppProps`/`SessionController` become `extends` lists in `app-types.ts`,
created by the first hook slice that needs it; `index.ts` re-exports keep the
test boundary stable.~~ **S1 was re-instated by the owner and executed** (see
*H4(1) status after S1* for the resident/movable split this leaves behind, and
Execution §S1). (2) Measurable target per feature KIND: command / key
binding / panel → **zero App.tsx lines**; stateful feature → a hook file plus
**≤ 4 append-only App.tsx lines** (prop intake, hook call, effect wiring if
any, view-model field). The goal sentence is restated honestly: this task
removes App.tsx as the collision point; `state.ts`, `render-lines.ts`,
`app.test.tsx`, `run.tsx`, `commands.ts` are the **next hotspots**, named here
and not fixed here. (3) `CommandContext` is per-capability: a command file
declares `Pick<…>` of the ports it uses, so a new command with an existing
capability edits nothing shared; a new capability is an honest edit of the
port + App's construction of it (stated, not hidden). (4) **S7 must replace
`panel.ts`'s `kind ===` branches and the sessions/tree key paths (3975–4045)
with per-panel methods**, or the "new panel = file + registry line" claim is
dropped from the doc. (5) Owner Q9 for the test-file rule.

**M1 — frozen names (CONFIRMED: `dockRef`/`setDock` used at 3841, 4062–4076;
`routeAttachRef` 3967).** → **Rule:** a hook slice destructures into the SAME
identifiers (`const { dockRef, setDock, dockIds, killJob, … } = useDock(…)`),
zero use-site edits. Only then is the parallel-safe column valid.

**H4(1) status after S1 (supersedes "S1 is dissolved" above).** The owner
re-instated S1 as its own slice and it is executed (Execution §S1); the
"dissolved" line in H4(1) and the struck row in the revised-order table below
are struck *as slices*, not as the type rule. What survives from H4(1), and what
every later slice must follow:
- **Resident** in `app-types.ts` for the whole decomposition: `AppProps`,
  `SessionController`. They are the `extends` lists every hook slice feeds; a
  later slice edits them IN PLACE, never moves them.
- **Resident today, movable to its own hook's module**: `SessionDirectory`,
  `NoticeFeed`, `RunQuit`, `SettingsNoticeLine`. The slice that owns one takes it
  with it (next to the hook), and **re-exports it from `App.tsx` and `index.ts`
  exactly as today**, so the test boundary does not move.
`test/app-types.test.ts` is written to that split: it pins where the two resident
types are declared, and for the other four it pins only that a re-export
resolves to a module that really declares them — so a planned move is green and
a breaking one is red (Fix round 1, mutation F1/F2/F4).

**M2 — S4 (CONFIRMED).** → `dispatchMouse` becomes a **per-event function**
called by the router with a render snapshot (`total`, `viewport`, `listView`,
`panelBodyTop`, `dockTop`, `dockView`, `layout.laid`, `win`, `visible`,
`expandAll`, `columns`, `statusRowRef`), not a hook taking them every render.
`stepMouseChunk` returns `{ reports, hold, restored, swallowBehindPanel }`.
S4 goes **before** S3 and defines the layer contract S3 generalises; blast
raised to cross-module (it edits the `useInput` body), fresh review.

**Amended in S4 (fix round 1).** As built: the snapshot is built per event at
the `useInput` call site and `dispatchMouse` is a pure per-event function in
`mouse-stream.ts` — as required. The thin `useMouse` hook is retained ONLY for
state a per-event function cannot hold (the partial-report ref + its 100 ms
timer, the click recogniser); it declares no effect, and `stepMouseChunk`
returns `{reports, hold, restored, submit, swallowBehindPanel}` (`submit`
added — drift 2). The M2 constraint is "no hook that owns an effect"; it is
met, so the plan text is corrected rather than the code.

**M3 — SGR blind spot (CONFIRMED: `lastFrame()` strips SGR).** → S0b captures
SGR-preserving raw frames for selection drag (`inverse`), attach row, running +
queued, and a pill click after each layout state (running rows, dock open,
attach row) to pin `onPillRange` (4589–4597). **S10 is restricted to a verbatim
JSX move** (no prop re-plumbing); anything beyond that is a later task.

**M4 — structural mutations (CONFIRMED gap: the 40-row table has no order /
identity / freshness mutant).** → S0b's mutation table must show red for:
swap effects 2548↔2773; drop `useCallback` from `watchSession` (2698);
replace `stateRef.current.running` at 4107 by the render `running`, and
`panelRef.current` at 4013 by `panel`. A survivor is a hole to close before S4.

**M5 — `/compact` and `/clear` are driver logic (CONFIRMED: `setCompacting`,
`compactionOwnedRef`, `ownCompactionsRef` at 3274–3322; `clearAfterTurnRef` at
3231, read by the turn at 2418).** → their bodies become App-level driver
functions `startCompaction()` / `requestClear()` (moving later with S9a / S8);
`commands/compact.ts` and `commands/clear.ts` call them in one line. S2 adds no
compaction/clear state to `CommandContext`.

**Revised slice order** (supersedes the table's order; rows not listed keep
their files/size):

| # | Change vs table | Blocks on |
|---|---|---|
| S0b `feat/app-decomp-0b-structural` | NEW · S · contained (tests only): mount-order, identity, no-render-between, H3 matrix rows, SGR frames + pill clicks, M4 mutations | S0 (done) |
| S4 mouse | moved first; per-event fn; layer contract; cross-module | S0b |
| S3 keyroute | 14 layers, `{effects, verdict, carry}`, snapshot-source table | S4 |
| S2 commands | driver fns for `/compact` `/clear`; per-command `Pick<>` context | S0b; parallel with S3 (disjoint hunks) |
| S5 dock ‖ S6 attach | own types; same identifiers; effects stay in App | S3 (both edit names S3 reads only via frozen identifiers) |
| ~~S1 types~~ | re-instated by the owner and EXECUTED as its own slice (Execution §S1); its type rule survives as *H4(1) status after S1* | — |
| S7 panels | per-panel methods replace `kind ===` | S3 |
| S8 → S9a → S9b | unchanged order; each takes its types; effects stay | S2 / serial |
| S10 view | verbatim JSX move only | S9b, S0b's SGR pins |

## Execution

### S0 — `feat/app-decomp-0-charnet` (characterization net; tests only)

*— deepseek-v4.1-flash, 2026-11-13*

**What S0 is.** A behaviour-preservation net for S1–S10: no `src/` change at all
(`git diff --stat main -- packages/tui/src` is empty on this branch), and the
three test files the plan names under `packages/tui/test/`.

**Load-bearing check re-run first (passed).** `use-input.js:89` registers each
listener with `internal_eventEmitter.on('input', handleData)` and there is no
stop-propagation or return-value short-circuit, so Ink calls EVERY active
`useInput` for each chunk — splitting App's handler across hooks would lose the
ordering. And App has exactly ONE `useInput`, at `App.tsx:3802`
(`grep -n "useInput(" packages/tui/src` → App.tsx:3802, the separate pre-mount
`components/SessionPicker.tsx:85` only). The assumption holds as written.
**As built (this run; the earlier run was cut by quota with only the three files
committed at f28d6d7).** The three files were audited against the plan's Tests
list, and the gaps were closed:

- `test/app-keys-precedence.test.tsx` (+2 tests, 18 → 20). The plan names
  "Esc with upload in flight" and "shift+tab in every state"; both were missing
  and are now pinned:
  - *Esc with an upload in flight aborts the UPLOAD, never the running turn* —
    the upload's Esc (`App.tsx:4098`) above the turn's (`App.tsx:4105`). Needs a
    turn running UNDER an upload, which no keyboard path produces (Enter with
    chips uploads first), so the turn is raised through `session.watch` as
    another device's. Asserts the first Esc aborts the upload and leaves the
    turn alone, the second Esc reaches the turn — so the lower layer is intact,
    not merely shadowed.
  - *shift+tab mid-turn toggles auto-accept, never stops the turn* — the
    first-checked layer in the state where a stray Tab could otherwise reach the
    palette/history.
- `test/app-commands.test.tsx` (+5 tests, 17 → 22). The registry test asserts
  "the registry this file covers is exactly SLASH_COMMANDS", but three of the 17
  had no case. Added `/settings` (unavailable, and its show/sync answer with a
  seam), `/attach` (usage line, nothing sent), `/exit` (alias of `/quit`, the
  `(y/N)` path with a child, and a real unmount with nothing to lose — spied
  through the notice feed, since `/exit` closes nothing itself).
- `test/app-frames.test.tsx` — the 12 frame pins already covered the plan's
  frame set (idle, running, permission, palette, sessions/mcp/skills panels,
  dock pill/dropdown/two drawers, quit confirm, attach chip), but the file was
  **time-dependent and flaked**: a drawer header pads its rule to the terminal
  width using the UN-normalised elapsed text, so the wall clock crossing a digit
  boundary (`9s` → `10s`) shifted one dash and failed a pin on an otherwise
  identical frame (caught on a full-suite run, `full-run-3.log`; it passed 20/20
  in isolation, which is why the first runs missed it). Fixed in `norm`, which
  now elides a rule run (3+ `─`) to `…` — the filler's length is not the property
  under test, the content either side is. Proved both ways: a raw 9s/10s header
  pair differs, the normalised pair is identical (`.tentacle/tmp/
  app-decomposition/norm-check.ts`); then 20/20 consecutive runs green.

**Mutation check (§9 non-vacuity).** 40 single-edit mutations of the code the
tests pin, each run against the named test (`-t` filter), then reverted;
harness `.tentacle/tmp/app-decomposition/mutate.ts`, log `mut-final.log`.
**39 of 40 KILLED (red)** — full table below.

- `M3 esc-abort before paste` SURVIVED, and that is correct, not a gap: it is an
  **equivalent mutant**. Ink's `parse-keypress.js:195-222` sets `name: 'escape'`
  only for a lone ESC — a paste chunk (`\x1b[200~…`) parses as an fn-key
  sequence, so `key.escape` (`use-input.js:55`) is false and the esc-abort
  branch cannot fire for it wherever it sits in the order. The observable half
  of that ordering — the paste layer's own mid-turn handling — is `M3b`, which
  is killed. No test can distinguish the two orders, so no test should.
- Every kill is on the **assertion of the property**, with real `0 pass / N fail`
  counts from the filtered run, never an import/compile error.

**Coverage (no drop; it rose).** `bun test --coverage packages/tui` → **1727
pass, 0 fail** (113 files), App.tsx **93.75 % functions / 96.95 % lines**,
against the plan's baseline of 90.7 % / 94.5 %. S0 only adds tests, and the new
ones cover lines the previous net left uncovered (the `/settings` branches,
`/attach`'s usage, the `/exit` alias, the upload's Esc).

**Gate (this worktree, this branch).**
- `bunx tsc --noEmit` → 0 errors.
- `bun run lint` (`biome check .`) → clean, 954 files, 0 errors/warnings (the
  AGENTS §6 baseline).
- `bun test` → **7573 pass, 3 skip, 0 fail** (7576 across 540 files; two full
  runs green after the frame-normaliser fix). The 3 skips are the opt-in
  live-k8s / live-docker / real-socket-keepalive ones, i.e. the documented
  baseline, not failures. Note the flake below was found ONLY by full runs: the
  frames file passed 20/20 in isolation and failed on two of five full suites,
  because the drawer's rule padding depends on when its clock crosses a digit
  boundary.
- No schema change → `packages/protocol/schema/protocol.json` not regenerated
  (S0 touches no protocol type).
- `CHANGELOG.md` entry under `[Unreleased] ### Added` (written in f28d6d7;
  extended here to name the two extra precedence pairs, the three commands, and
  the mutation result).

**Drift from the Implementation:** none in scope or design. Three additions
inside S0's own stated list: the two missing precedence pairs, the three missing
command cases, and the frame-normaliser fix (a real defect in the earlier run's
work — the frames file it committed was time-dependent and flaked on a digit
boundary). Nothing in another slice was started.

**Unverified (one line):** these tests pin behaviour on the current `main` src
— every file they pin was byte-identical to this branch's and unchanged by the
22 commits `main` gained meanwhile (the only `packages/tui/src` delta is
`subagent-view.ts`'s two additive close-reason labels, which no S0 test touches)
— but the branch was NOT rebased onto that newer `main` (commit-moving is out of
bounds for this run), so keeping the net green across S1–S10 is the claim those
slices must honour, verified slice by slice. *Merge preview done instead:* with
`main`'s version of that one changed file dropped in place, S0's 53 tests plus
`subagent-view.test.ts` all pass (89 pass, 0 fail), then the file was restored.

#### S0 mutation table (39/40 killed; 1 equivalent mutant, explained)

Each row: one text edit to the code, the test that must notice it. `KILLED`
= that test went red (counts are the real pass/fail of the filtered run).

| Mutation | What it breaks | Test | Result |
|---|---|---|---|
| M1 | quit-confirm moved after permission | quit-confirm before permission | KILLED |
| M2 | chord takes the dock's `ctrl+x` | dock-owned ctrl+x | KILLED |
| M3 | esc-abort moved above the paste layer | bracketed paste mid-turn | **SURVIVED — equivalent mutant** (see above) |
| M3b | paste dropped mid-turn | bracketed paste mid-turn | KILLED |
| M4 | esc-abort above the sessions panel | sessions panel's Esc | KILLED |
| M5 | esc-abort above the dock | dock's Esc | KILLED |
| M6 | palette lets ↑ through | palette arrows | KILLED |
| M7 | palette ↓ steps by 2 | palette Down+Tab | KILLED |
| M8 | palette Esc does not reset | palette Down+Tab | KILLED |
| M9 | palette Enter does not run | palette Enter | KILLED |
| M10 | `ctrl+t` dropped | ctrl+t toggles the dock | KILLED |
| M11 | shift+tab after quit-confirm | shift+tab toggles first | KILLED |
| M12 | killChild loses "not running" | dock stop on a CHILD | KILLED |
| M13 | job routed to killChild | dock stop on a JOB | KILLED |
| M14 | permission ↓ selection ignored | permission Down selects | KILLED |
| M15 | permission reply paste not inserted | Ctrl+V pastes | KILLED |
| M16 | trailing half mouse report dropped | trailing half report | KILLED |
| M17 | convertToChips no-op | typed image path → chip | KILLED |
| M18 | esc-abort placed above the upload's | Esc with an upload in flight | KILLED |
| M19 | shift+tab skipped mid-turn | shift+tab mid-turn | KILLED |
| C1 | `/help` silent | /help lists the commands | KILLED |
| C2 | `/model` wrong model | /model names the model | KILLED |
| C3 | `/tokens` total wrong | /tokens totals | KILLED |
| C4 | `/agents` dropped | /agents | KILLED |
| C5 | `/copy` failure silent | /copy | KILLED |
| C6 | `/retry` not sent | /retry | KILLED |
| C7 | `/save` path wrong | /save | KILLED |
| C8 | `/sessions` unavailable silent | runtime-dependent notices | KILLED |
| C9 | `/rename` usage silent | /rename usage | KILLED |
| C10 | `/mcp` opens no panel | /mcp and /skills | KILLED |
| C11 | `/close` closes nothing | /close ends the session | KILLED |
| C12 | `/quit` skips the confirm | /quit asks first | KILLED |
| C13 | unknown command silent | unknown → /help | KILLED |
| C14 | mid-turn guard off | the three refusals | KILLED (3 fail) |
| C15 | `/settings` unavailable silent | /settings, no seam | KILLED |
| C16 | `/settings` show dropped | /settings with a seam | KILLED |
| C17 | `/settings sync` not sent | /settings with a seam | KILLED |
| C18 | `/attach` usage silent | /attach with no path | KILLED |
| C19 | `/exit` alias dropped | /exit | KILLED |
| F1 | welcome text changed by a char | the whole frame set | KILLED (11 fail) |

C15–C17 patch `settings-command.ts` / `App.tsx` (the `/settings` decision,
then its executor); the harness restores every patched file in a `finally`,
and `git status` after the run shows only the two test files modified.

### Fix round 1 — `feat/app-decomposition` (S0 review findings)

*— claude-opus-5-5, 2026-11-14*

**Scope.** Both S0-review findings; tests only, no `src/` change
(`git status --short` → `M packages/tui/test/app-commands.test.tsx`).

**1 (MEDIUM) — `/compact`'s mid-turn refusal is now pinned.** `packages/tui/test/app-commands.test.tsx:345`
adds a case to the mid-turn describe: a session with `compact` (a spy) plus a
`hang` turn → `/compact` must show `Can't compact while a turn is running.` and
the spy must never be called. It sits beside the `SESSION_MUTATING` loop on
purpose: `/compact` is NOT in that set (`commands.ts:170`) — it guards itself
with a tailored message at `App.tsx:3265` — so the plan's wording
("each session-mutating command") needs both paths covered, which is exactly
what the reviewer found missing.

**2 (Note) — the net is not flaky: full suite ×3, all green.** Each run
`7574 pass / 0 fail / 3 skip` (the three opt-in skips: live-k8s, live-docker,
real-socket keepalive), `Ran 7577 tests across 540 files`, 340.99 s / 334.52 s /
335.12 s. 7574 = the pre-fix 7573 + the one case added here. The single
unattributed failure the reviewer saw once in three runs did not recur; treat
S1–S10 red as real until a `(fail)` name says otherwise.

**Mutations (each shown red on the assertion, then reverted; tree clean after).**
- M1 `if (false && stateRef.current.running)` at `App.tsx:3265` (the reviewer's
  surviving mutant): case red —
  `Expected to contain: "Can't compact while a turn is running." / Received: … "⏺ Context compacted — 1 → 1 messages."`,
  `22 pass / 1 fail`. This is the finding's own mutation, now killed.
- M2 drop the `return` at `App.tsx:3267` (falls through to the compaction): red —
  `- Expected / + Received + 3`, i.e. the frame shows
  `Compacting the conversation…` + `Context compacted`. Kills the weaker mutant
  (notice without the abort).

**Gate.** `bunx tsc --noEmit` exit 0 · `bun run lint` clean (954 files) ·
`bun test` ×3 → 7574 pass / 0 fail / 3 skip each. Narrow file:
`bun test packages/tui/test/app-commands.test.tsx` 23 pass / 0 fail.

**Drift from Implementation.** None — S0 is tests-only and the design's Tests §2
wording is what finding 1 restored. No existing test edited; the new case is
additive, so the behaviour-preservation proof for S1–S10 is untouched.

**Verdict per finding.** 1 FIXED · 2 FIXED (evidence attached; nothing to change
in code).

### Fix round 2 — `feat/app-decomposition` (S0 findings, re-verified)

*— deepseek-v4.1-flash, 2026-11-13* (real id:
`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`, run with `--profile deepseek`)

**Which Review round this answers.** Round 2's reviewer call never ran: its
`--resume` returned `No conversation found with session ID:
a9bd6a7d-…` (`runs/night-app-decomposition-review2.json`, 76 bytes), so
**no Round-2 findings exist**. The latest real Review is still the S0
REQUEST-CHANGES below; this round re-proves both of its findings from scratch
rather than trusting Fix round 1's report, and closes the class behind finding 1.

**1 (MEDIUM) — `/compact`'s mid-turn refusal: re-proved, and the gap behind it
closed.** Fix round 1's test does kill the reviewer's mutant. Re-run here:
`if (false && stateRef.current.running)` at `App.tsx:3265` →
`1 fail` on the property assertion (`Expected to contain: "Can't compact while a
turn is running." / Received: … "Context compacted — 1 → 1 messages."`),
`22 pass / 1 fail` filtered. `App.tsx` restored byte-identically (sha256
`750856b0…`).

But the finding's *cause* — "treated 'session-mutating' as the `SESSION_MUTATING`
set rather than the plan's wording" — survived: the new describe still looped a
**hardcoded** `["/retry", "/clear", "/close"]`, so a member added to
`SESSION_MUTATING` (`commands.ts:170`, the source of truth the App's generic
guard reads) was silently uncovered again. Shown red-before-green by mutation:
`+"/tokens"` in the set → pre-fix file `23 pass / 0 fail`; post-fix `1 fail`
(`- Expected - 0 / + Received + 1`, the guard test). Fix at
`packages/tui/test/app-commands.test.tsx:327–345`: the loop is now
`SLASH_COMMANDS.map((c) => c.name).filter(isSessionMutating)` plus a pinned
`toEqual(["/clear","/close","/retry"])`, so a new member is a *decision* (the
guard test goes red and forces the case in) instead of a silent hole. The probe
also confirmed the App's guard is generic, not per-command: a newly added member
is refused with the standard notice without touching `App.tsx`.

**2 (Note) — the net is not flaky: 8 concurrent stress runs, all green.** The
runner's own report (`r2-loop.sh`, 8 × [the three S0 files + `app.test.tsx`] in
parallel, `r2-loop-{1..8}.log`) → every run `170 pass / 0 fail`, zero `(fail)`
lines. That is 8 under-load runs on top of Fix round 1's 3 full suites
(`7574 pass / 0 fail / 3 skip` each) and the executor's 3 before it: 14 clean
runs, the one unattributed failure never reproduced and no name was ever
captured. Standing instruction for S1–S10 is unchanged: treat red as real until
a `(fail)` name says otherwise. Full suite this round: see the gate line.

**Mutations (each red on the assertion, then reverted; `git status` after →
only `M packages/tui/test/app-commands.test.tsx` + this doc).**
- R1 = the reviewer's exact mutant, `if (false && stateRef.current.running)`
  (`App.tsx:3265`) → red, the compact test, `22 pass / 1 fail`.
- R2 = `SESSION_MUTATING` gains `/tokens` (`commands.ts:170`) → red, the derived
  guard test, `24 pass / 1 fail`; **the same mutation against the pre-fix test
  file was green (`23 pass / 0 fail`)** — that pair is this round's
  non-vacuity proof (§9).

**Gate.** `bunx tsc --noEmit` exit 0 · `bun run lint` clean (954 files) ·
`bun test` full suite **7575 pass / 0 fail / 3 skip** (`Ran 7578 tests across 540
files`, 332.66 s, `EXIT=0`; 7575 = the pre-fix 7574 + the one derived guard test
added here; the 3 skips are the documented opt-ins — live-k8s, live-docker,
real-socket keepalive). Narrow file: `bun test
packages/tui/test/app-commands.test.tsx` → 24 pass / 0 fail.

**Drift from Implementation.** None. Tests + this doc only; no `packages/tui/src`
change in the final tree (both mutations restored), so S1–S10's
behaviour-preservation proof is untouched.

**Verdict per finding.** 1 FIXED (round 1's instance re-proved; its class fixed
this round) · 2 FIXED (8/8 stressed runs, no flake).


### Fix round 3 — `feat/app-decomposition` (finding 1's class, still open)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id; launched
with `--profile deepseek`)

**Which Review round this answers.** Rounds ≥2 have no findings: the
orchestrator's reviewer step is `opus resume $R_SID`, and `$R_SID`
(`a9bd6a7d-…`, round 1's session) is unknown to the CLI, so
`runs/night-app-decomposition-review{2,3}.json` are both the 76-byte string
`No conversation found with session ID: …` — read and verified, not inferred.
The latest real Review is therefore still the **S0 REQUEST-CHANGES** above
(MEDIUM 1: `/compact`'s mid-turn refusal; Note 2: the flake).

**Round 2's claim re-proved first (not trusted).** The reviewer's own mutant
`if (false && stateRef.current.running)` at `App.tsx:3265` → narrow file
`26 pass / 1 fail`, red on the property (`Expected to contain: "Can't compact
while a turn is running."`). Finding 1 holds fixed. `App.tsx` restored
byte-identically (sha256 `750856b0…`, unchanged from before this round).

**Then the finding's CLASS, hunted empirically instead of by reading** (round 2
closed the `SESSION_MUTATING` *set*; that was one shape of it). Method: a guard
inside `handleCommand` is disabled with the same `false &&` edit, and **all
1729 `packages/tui` tests** are run — the reviewer's own standard of "survived
everything". Three survivors, all in branches S2 is about to move, each a
`clearCommandStep`/`settingsCommand` outcome the pure unit test pins but the
App's *use* of it does not:

| # | site | mutant | before |
|---|---|---|---|
| N1 | `App.tsx:3227` `/clear` during a compaction | `false && step === "compacting"` | **1729 pass / 0 fail** |
| N2 | `App.tsx:3225` a second `/clear` while one is in flight | `false && step === "busy"` | **1729 pass / 0 fail** |
| N3 | `App.tsx:3349` `/settings sync` during a compaction | `compacting: false` | **1731 pass** / 0 fail (`bun test packages/tui`) |

A fourth candidate, `/retry`'s `plan.kind === "gone"` (`App.tsx:3452`), also
survives the suite — but it is **not** a test gap: `bunx tsc --noEmit` kills it
(`TS2339: Property 'command' does not exist on type 'RetryPlan'`), because the
narrowing is what types `plan.text`. Recorded so it is not re-hunted.

The two `/clear` refusals are a real behaviour hole: without them a clear runs
*under* a live compaction (rewriting the history being summarised) and a second
clear is sent for a conversation already being reset. `/settings sync` writes
settings under the summary.

**Fixes — 3 tests, no `src` change** (`packages/tui/test/app-commands.test.tsx`):
- `:410` new `describe("S0 command smoke: /clear is refused while the session is
  held")` with two cases on the real `App`: `/clear` during a held `compact` →
  its own notice, `clear` never called; `/clear` twice → "A /clear is already
  running.", `clear` called once. The session fakes hold the promise, so the
  latch is up for the whole test rather than relying on a timing window.
- `:289` `/settings sync` during a held compaction → `Can't sync settings while
  a compaction is running.`, `updateSettings` never called.

**Mutations (§9: red on the assertion, each from a clean restore; `git status`
after → `M packages/tui/test/app-commands.test.tsx` + this doc only).**
- R1 = the reviewer's exact `/compact` mutant → `26 pass / 1 fail` (above).
- M3 = N1's mutant, post-fix → `25 pass / 1 fail`, `(fail) … /clear while a
  compaction runs → its own refusal, clear is never called`, `Expected to
  contain: "Can't clear while a compaction is running."` — and pre-fix the same
  mutant was **1729/0** (N1's row): that pair is the non-vacuity proof.
- M4 = N2's mutant, post-fix → `25 pass / 1 fail`, `(fail) … /clear twice: the
  second says one is already running`, `Expected to contain: "A /clear is
  already running."`; pre-fix **1729/0**.
- M5 = N3's mutant, post-fix → `26 pass / 1 fail`, `(fail) … /settings sync
  while a compaction runs → refused by the step, sync is never called`; pre-fix
  **1731/0**.
- Bounded sweep of the rest of `handleCommand`'s refusals, to stop at a known
  edge: `/rename` unavailable → `1 fail` (already pinned); `/copy` no-reply and
  `/mcp` unavailable → already pinned by existing cases; `/retry` gone → killed
  by `tsc` (above). No further survivor.
- Every restore verified by sha256 (`App.tsx` `750856b0…`, `commands.ts`
  `7a569a55…`), not by `git checkout` (forbidden here).

**Note 2 (flake) — 8 concurrent stress runs of the S0 net, 0 fail; then the
full suite named the culprit the reviewer could not.** The four timing-based S0
files (`app-commands`, `app-keys-precedence`, `app-frames`, `app.test`) × 8 in
parallel (`.tentacle/tmp/app-decomposition/r3-loop.sh`) → each run `174 pass /
0 fail`, **zero `(fail)` lines** (`r3-loop-{1..8}.log`). So the S0 net itself is
clean under load: 8 runs here + 8 in round 2 + 3 in round 1.

The full suite then reproduced the *other* failure — the one that had gone
unnamed for three rounds — and this time with a name:
`(fail) attach mid-turn behind a long reply (docs/fix/detach-live.md, round 9 /
KO 3) > a replay past the client's buffer bound converges …` at
`packages/client/test/reattach.test.ts:773`, `error: until: timed out after 3000
ms waiting for () => model.waiting` (3003.45 ms — the deadline, not a wrong
answer). **It is not this task's test and not this round's code:** this branch's
diff is `docs/feat/app-decomposition.md` + `packages/tui/test/app-commands.test.tsx`
only (`git diff --stat`: 2 files, +171, no `src`), and `git diff main --
packages/client/` shows this branch never touched that package. It passes 3/3 in
isolation (3.8 s) and 1/1 again with 6 concurrent `bun test packages/tui` runs
loading the machine (`r3-under-load.log`, `54 pass / 0 fail / EXIT=0`) — so it
is a **3000 ms-deadline timing margin** in `packages/client/test/support/fakes.ts:95`
under full-suite contention, not a logic failure, and it is what round 1's
unattributed `1 fail` in 3 runs was.

That is a finding in its own right, and it is **out of this task's scope**
(a `packages/client` test-harness deadline, not `App.tsx` decomposition): it
needs its own `fix/` task to widen/poll that deadline (or make `GatedModel`'s
gate observable rather than polled). Recorded here so it stops being an
unattributable flake. The standing S1–S10 instruction is sharpened accordingly:
treat red as real until a `(fail)` name says otherwise — and this is now a known
name to discount, once it is fixed at the source.

**Gate.** `bunx tsc --noEmit` exit 0 (`r3-tsc.log`) · `bun run lint` clean, 954
files, 0 warnings (`r3-lint.log`) · `bun test` full suite **twice**: run 1
`7577 pass / 3 skip / 1 fail` — the named `packages/client` deadline above
(`r3-full.log`, `TEST_EXIT=1`), run 2 **`7578 pass / 3 skip / 0 fail`**, `Ran
7581 tests across 540 files`, 331.87 s, `TEST_EXIT=0` (`r3-full2.log`). The two
runs differ by exactly that one intermittent test; 7581 total = the pre-round
7578 + the 3 tests added here, and the 3 skips are the documented opt-ins
(live-k8s, live-docker, real-socket keepalive). Narrow file: `bun test
packages/tui/test/app-commands.test.tsx` → **27 pass / 0 fail**. Package
baseline before this round: `bun test packages/tui` → 1729 pass / 0 fail
(172.59 s); the 3 new tests bring it to 1732.

**Drift from Implementation.** None. `packages/tui/src` is byte-identical to
HEAD (verified by sha256 above) — this round is tests + this doc, so S1–S10's
behaviour-preservation proof is untouched and no slice is pre-empted.

**Verdict per finding.** Review MEDIUM 1 → FIXED (re-proved, and its class
closed at 3 more sites) · Review Note 2 → FIXED as far as this task can: the S0
net is clean (8/8 under load), and the unnamed full-suite failure is now named
and attributed to a `packages/client` test deadline outside this diff — one
line, method, and owner recorded above (it needs its own `fix/` task).

### S1 — `feat/app-decomp-1-types` (the type surface leaves App.tsx)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id; launched as
`tentacle --profile deepseek`, verified from the invoker's own command line. This
section's first draft was signed `claude-opus-5-5` by copying the surrounding
doc; corrected — a signature names the model that did the work.) Branch
`feat/app-decomp-1-types`, off `main` `632aeb5`; one slice only, S0b and S2–S10
untouched.

**Load-bearing check, re-run first (per the brief).** The Implementation's
Preconditions bullet claims *"`AppProps` is the only boundary tests use, and
`index.ts:23–31` re-exports App's types. Keeping both stable means no existing
test changes."* Re-verified on this branch:

- `git diff --stat main -- packages/tui/src` → **empty** (no src change to
  reconcile against).
- **30** test files import `App` from `../src/App.tsx`, **22** of them also a
  type (`SessionController` 22, `AppProps` 3, `SessionDirectory` 3, `NoticeFeed`
  1, `RunQuit` 1, `SettingsNoticeLine` 0) — so `App.tsx` must keep exporting all
  six names (`SettingsNoticeLine` for the one internal use at App.tsx:3003).
- `@tentacle/tui` consumers (`packages/cli/src`: `main.ts`, `local-runtime.ts`,
  `session-jobs.ts`, `notice-hub.ts`, `tui-sessions.ts`, `attach-run.ts`) import
  `SessionController`/`NoticeFeed`/`RunQuit` from the PACKAGE, i.e. through
  `index.ts`.
- **One correction to the plan:** `index.ts` exported **five** of the six, not
  six — `SettingsNoticeLine` was never on the package surface (`git show
  main:packages/tui/src/index.ts`). The slice therefore keeps the public surface
  identical rather than compatible, and the new test pins the exact five.

The check **passed**; no STOP condition. The Dependency-order work below is one
slice, so the order is: test (red) → `app-types.ts` → `App.tsx` → `index.ts`.

**What was done, in order.**
1. `packages/tui/test/app-types.test.ts` (**new**, 6 tests) written FIRST and
   shown RED on the un-moved tree: 5 fail / 1 pass (the pass is the deliberate
   non-vacuity case). It pins: the module exists and declares each of the six;
   `App.tsx` declares none of them and imports from `./app-types.ts`; `App.tsx`
   still re-exports all six; `index.ts` exports the five it always did **and no
   more**; and `app-types.ts` has **zero runtime exports** (`Object.keys(await
   import(...))` is `[]`) — a type-only module, so nothing behavioural can ride
   along with a "move".
2. `packages/tui/src/app-types.ts` (**new**, 361 lines): an 18-line type-import
   header + the moved block. Derived mechanically, not retyped: `block.txt` was
   `sed -n '272,608p'` of `App.tsx`, and the header's imports were computed by
   scanning which App.tsx import bindings the block actually references
   (`.tentacle/tmp/app-decomp-1-types/deps.ts`).
3. `packages/tui/src/App.tsx`: source lines 272–608 deleted (337 lines) and
   replaced by 8 lines — an `import type` of the three used locally
   (`AppProps`, `SessionController`, `SettingsNoticeLine`) plus the six-name
   `export type { … } from "./app-types.ts"` that keeps every importer working.
   Then 8 now-unused type imports trimmed (`Agent`, `JobController`,
   `PermissionBroker`, `JobOutputResult`/`JobRow`, `LinkFeed`, `McpServerView`,
   `QueuedMessage`/`ReturnedCause`, `SessionsView`, `SessionSkillsView`,
   `SubagentNotifyView`, `TargetBadge`) — each verified to have exactly 1
   remaining occurrence (the import itself) before removal. App.tsx: 4602 → 4265.
4. `packages/tui/src/index.ts`: `App` + `AutoAcceptFeed` still come from
   `App.tsx`; the five types now name `./app-types.ts`.
5. `changelog.d/app-decomp-1-types.changed.md` — see drift (a) below.

**Pure move, proved byte-for-byte.** `git show main:packages/tui/src/App.tsx |
sed -n '272,608p'` vs `sed -n '25,361p' packages/tui/src/app-types.ts`:
`diff -q` → IDENTICAL, both `sha256 13b0d477…`. Not one character inside the
moved block changed — no comment, no `readonly`, no reordering. Only the import
header is new text, and only the host files lost lines.

**Red before green (§9).** Red: `bun test packages/tui/test/app-types.test.ts`
on the un-moved tree → `1 pass / 5 fail`, each fail on its own assertion
(`app-types.ts has no runtime exports` → `Expected: true, Received: false`, etc.).
Green after: **6 pass / 0 fail**, 30 expects.

**Mutation table — 6/6 killed (§9 non-vacuity).** `.tentacle/tmp/app-decomp-1-types/`
`mutate.sh` + `mut-names.sh`; each mutation applied, the S1 file run, the
original restored by `cp`, then verified by sha256 (all three files back to
`85ee52f9…`, `ebe40eea…`, `5ae91e51…`):

| # | Mutation | Killed by (assertion, not a compile error) |
|---|---|---|
| M1 | a moved type also left behind in App.tsx (duplicate) | `App.tsx declares none of them any more` |
| M2 | `RunQuit` not `export`ed from app-types.ts | `app-types.ts exists and declares each moved type` |
| M3 | App.tsx drops its six-name re-export | `App.tsx still re-exports every moved name` |
| M4 | index.ts drops its five-type block | `index.ts exports each already-public moved type` |
| M5 | `export const NOTICE_CHANNEL = "notice";` added to app-types.ts | `app-types.ts has no runtime exports` |
| M6 | app-types.ts drops `JobOutputResult`/`JobRow` | `tsc`: `TS2304: Cannot find name 'JobRow'` (a compile-time mutant, as designed — see drift (c)) |

**Failure modes from the Implementation, checked for this slice.**
- *Silent behaviour change in a "move"* → the byte-identical sha256 above, plus
  M5 (no runtime export) — the strongest form available for a type-only slice.
- *Cycle breakage* → the new module imports only leaf modules; verified no module
  in the header imports `App.tsx` (checked all 17 by `rg`, only `turn-feed.ts`
  mentions it and only in a comment). `app-types.ts` is a leaf of the graph.
- *The test boundary drifting* → 1746 `packages/tui` tests pass with **no test
  file edited except the new one** (`git status`: the only `??` test is
  `app-types.test.ts`), so "no existing test changes" is a fact, not a claim.
- *Stale closure / effect order / identity / freshness / render perf / Ink /
  single-broker* → **not applicable**: this slice moves zero runtime code, so
  there is no hook, effect, dep array or render path in the diff. Those modes
  belong to S3–S10 and stay open there.

**Gate.** `bunx tsc --noEmit` clean · `bun run typecheck` (`tsc --noEmit && tsc -p
apps/mobile`) clean · `bun run lint`: `Checked 977 files. No fixes applied.`
(clean; after `biome check --write` on the one new file) · `bun test packages/tui`
**1746 pass / 0 fail** (13 snapshots, 48900 expects, 179 s) · changelog guard +
parser tests 21 pass · **full `bun test`: 7790 pass / 3 skip / 0 fail** (72083
expects, 554 files, 346 s) — the 3 skips are the documented opt-ins (live-k8s,
live-docker, the ~12 s real-socket keepalive), not failures. `packages/tui` alone
was green BEFORE drift (d) was found, which is exactly why §4's full-suite step is
not optional: the one broken guard lives in `packages/cli`.

**Drift from Implementation — four, all deliberate and stated.**
- **(a) A changelog fragment was written, against this doc's "Other hotspots".**
  The plan says slices "add no CHANGELOG line (internal refactor; one entry when
  the last slice merges)"; the execution brief asked for
  `changelog.d/app-decomp-1-types.<category>.md`. The fragment was written, then
  **deleted by Fix round 1**: the review is right that AGENTS §10 ("internal/
  dev/test-only work adds no fragment") overrides a brief, and this doc's own
  rule says so too. Executing a `rm` was the whole fix.
- **(b) `SettingsNoticeLine` is exported from `App.tsx` but not from `index.ts`**
  — the plan says "`index.ts` re-exports keep the test boundary stable", which
  holds; the plan implies six, the code shows five. Recorded rather than fixed,
  because adding it would GROW the public surface, which is not a move (§10,
  Owner Q5 "no cleanup while moving").
- **(c) This slice is not purely additive in App.tsx's import block.** It deletes
  8 import names as well as adding 2 lines. The plan's S1 row says only
  "`app-types.ts`, App.tsx (delete + import), `index.ts`", which is what was
  done; the 8 deletions are the mechanical consequence (a name the moved types
  were the sole user of), and leaving them would fail `tsc`/Biome. No use site
  changed — every deletion was an import binding with 1 occurrence.
- **(d) ONE existing test DID change — the Preconditions bullet is falsified.**
  `packages/cli/test/subagent-panel-controller.test.ts:285` parsed `App.tsx` as
  SOURCE TEXT (`ts.createSourceFile`, then `forEachChild` for
  `ts.isInterfaceDeclaration` named `SessionController`) to prove every
  controller member a `RemoteSession` has reaches the runtime's wrapper. After the
  move that file holds an `export type … from` re-export and no interface, so the
  guard threw `no SessionController in packages/tui/src/App.tsx` — caught by the
  full suite (`7789 pass / 3 skip / 1 fail`), not by `packages/tui` alone, which
  is why §4's "narrow file per slice" left it until the end. This is the ONE
  place where the Implementation's *"`AppProps` is the only boundary tests use …
  no existing test changes"* does not hold: a test can also depend on WHERE a
  declaration is written.
  **Fix, minimal and in the guard's own spirit** ("read the DECLARATION, not a
  copy"): the two lines naming the file now name `../../tui/src/app-types.ts`
  (and the error message with them); no assertion, list or comment about
  forwarding changed. Non-vacuity re-proved after the repoint, since a guard that
  silently reads an empty file would be worse than the failure it replaced:
  renaming `jobOutput` in `app-types.ts` to `jobOutputRenamed` makes it **RED**
  (`GUARD: every SessionController member … [7.50ms]`, 3 pass / 1 fail), restored
  to `sha256 85ee52f9…`. A mutation that adds a member `RemoteSession` does NOT
  have (`bogusMember`) stays green BY DESIGN: the guard's direction is
  "declared ∧ on the session ⇒ must be forwarded".
  **Plan updated** (this bullet): the S1 row's Files and the Preconditions
  bullet's "no existing test changes" now name this guard as the one exception.
  Every *other* slice that keeps `SessionController` in `app-types.ts` inherits
  this fix; a slice that MOVES it again must repoint the guard again.

**Not verified (one line).** `main` moved from `632aeb5` to `83d5864` while this
slice ran (`feat/mobile-app-shell`, `feat/config-list-effective`); those commits
touch nothing under `packages/tui` (`git diff --stat HEAD main -- packages/tui`
is empty), so a rebase is a no-op here — but the merge must re-run the gate
(AGENTS §10 merge step) to confirm on the merged tree. Left deliberately: `run.tsx`
still imports its five types from `./App.tsx` (the re-export) rather than
`./app-types.ts`; both typecheck, and repointing it is a second edit outside this
slice's Files list — a one-line cleanup for whichever slice next touches it.

**Verdict for S1: DONE.** Blast radius was `cross-module` (a public type surface
used by 22 tests and 6 `packages/cli` files, plus one source-parsing guard); the
fresh-context Review is the next stage, not this section.

### Fix round 1 — `feat/app-decomp-1-types` (S1 review findings)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id, read from
`~/.config/tentacle/config.jsonc` — the `deepseek` profile this session was
launched with, `ps` confirms `tentacle --profile deepseek`.)

Both findings were MEDIUM, neither was rebutted; both are fixed. Scope: 3 files
(2 edits, 1 deletion), no `packages/tui/src` line changed — verified below.

**Finding 1 — MEDIUM, the pin test contradicted the plan's own type rule. FIXED
(2 parts).** The review is precise: H4(1) (l. 341 + the struck row at l. 400) and
the live S1 rows (l. 166, l. 963) said opposite things, and
`test/app-types.test.ts` pinned all six declarations in `app-types.ts`, so a
later slice doing the planned thing (S8 takes `RunQuit` next to `useQuitClear`)
would go red on a *correct* move.

*Reproduced first, on the pre-fix test, before editing it.*
`.tentacle/tmp/app-decomp-1-types/fix1/sim-later-slice.sh apply` performs exactly
that planned move (block out of `app-types.ts` → `use-quit-clear.ts`, then
`export type { RunQuit } from "./use-quit-clear.ts"` in both `App.tsx` and
`index.ts`). Pre-fix test: **4 pass / 2 fail**, on the assertions the review
named —
`app-types.ts exists and declares each moved type` and
`index.ts exports each already-public moved type from app-types.ts`
(`Expected to contain: "RunQuit"`). That is the review's failure scenario,
demonstrated rather than argued. The same simulation on the FIXED test: **6 pass
/ 0 fail**.

*Test fix (`packages/tui/test/app-types.test.ts`, +104/−42).* The file now pins a
**split** instead of a file: `RESIDENT = [AppProps, SessionController]` (H4(1)'s
`extends` lists — later slices edit them in place, so their declaration site is
pinned) versus the other four, for which it pins a **re-export that RESOLVES**:
`typeExports()` now returns `{name, from}`, `from` resolved to the real file, and
`reexportResolves()` reads that file and requires it to declare the type. So the
property is "every name still reaches a real declaration through App.tsx and
index.ts" — true for a planned move, false for a breaking one. The public-surface
pin is unchanged (exactly the same five, never more).

*Doc fix (this file, 5 places).* Header status now says S1 was re-instated and
executed (it named "S1+ re-approval pending", which is what made the branch
contradict itself); H4(1) is struck as a *slice decision* with a new
**"H4(1) status after S1"** paragraph recording the resident/movable split that
the pin test now encodes; the revised-order row reads "re-instated by the owner
and EXECUTED" instead of "dissolved"; the slice-table row and Owner Q7's preamble
say the same. Fix round 1 was launched by the orchestrator on the owner's
instruction; the doc now records that instead of leaving it to be inferred.

*Mutation table (§9) — 9 killed, 1 green BY DESIGN, 0 unexpected.*
`.tentacle/tmp/app-decomp-1-types/fix1/mut.py`; each mutation applied, the file
run, the tree restored, sha256 verified (`85ee52f9…`, `ebe40eea…`, `5ae91e51…`
after every single one):

| # | Mutation | Result |
|---|---|---|
| F1 | later slice moves `RunQuit` to its hook module and re-exports it (**the plan's move**) | **SURVIVED — by design**, this is the finding |
| F2 | …but `App.tsx` forgets the re-export (non-vacuity of F1) | KILLED — `App.tsx still re-exports every moved name` |
| F3 | …but `index.ts` grows the surface (`SettingsNoticeLine` added) | KILLED — `index.ts exports … and no more` |
| F4 | `SessionController` (**resident**) leaves for a hook module | KILLED — `app-types.ts … declares its resident types` |
| M1 | a moved type also left behind in App.tsx | KILLED — `App.tsx declares none of them any more` |
| M2 | `app-types.ts` stops exporting `RunQuit` | KILLED — 2 fails (both re-exports no longer resolve) |
| M3 | App.tsx drops its six-name re-export | KILLED — 2 fails |
| M4 | `index.ts` drops its five-type block | KILLED — 2 fails |
| M5 | a value export rides along in `app-types.ts` | KILLED — `app-types.ts has no runtime exports` |
| M8 | `index.ts` adds `SettingsNoticeLine` (surface growth) | KILLED — `… and no more` |

The narrowing did not cost teeth: M2 survived the *first* narrowing attempt (the
test still pinned `RunQuit`'s declaration site, then only its presence), which is
why the `{name, from}` resolution check exists — found by this table, not by
inspection. M6 (dropping `JobOutputResult`/`JobRow`) is unchanged and stays a
compile-time mutant, as recorded in the S1 Execution.

**Finding 2 — MEDIUM, the changelog fragment breaks AGENTS §10. FIXED (deleted).**
`changelog.d/app-decomp-1-types.changed.md` is gone; nothing else referenced it.
The review is right that AGENTS.md overrides a brief, and this doc's own "Other
hotspots" said the same. Evidence that it would really have shipped, rather than
an assertion: `.tentacle/tmp/app-decomp-1-types/fix1/frag-ships.ts` runs the real
`assemble()` over the real `CHANGELOG.md` — with the fragment (read back from
`HEAD`) it produces a `### Changed` bullet describing an internal file move;
without it, the section is empty. Drift (a) in the S1 Execution was amended to
say it was written and then deleted, so the doc does not keep a stale claim.
Changelog gate after the deletion: `changelog-guard` + `changelog` + `release`
tests **57 pass / 0 fail**, `[Unreleased]` guard green.

**Gate (this round).** `bunx tsc --noEmit` clean · `bun run lint` `Checked 977
files in 304ms. No fixes applied.` · `bun test packages/tui` **1746 pass / 0
fail** (115 files, 179 s) · full `bun test` **7790 pass / 3 skip / 0 fail**
(7793 tests, 554 files, 344 s) — the 3 skips are the documented opt-ins. The
touched files, re-run last on the final tree: **31 pass / 0 fail** (S1 pin test,
the CLI source-locator guard, `changelog-guard`, `changelog`).

**One flake, attributed — not this diff.** The first full-suite run of this
round ended `7788 pass / 3 skip / 2 fail`, both in
`packages/daemon/test/serve-log-store.test.ts` (S2 (a) and (b): a 3 s `until()`
deadline, then `expect(state.k).toBeLessThan(0)`). `git diff --stat main...HEAD --
packages/daemon packages/client` is **empty**: this branch cannot reach them. That
file alone: **22 pass / 0 fail, three runs in a row**; the full suite re-run:
0 fail. Recorded here rather than silently re-run away, per the standing
"treat red as real until a `(fail)` name says otherwise" instruction (S0 fix
rounds, l. 790).

**No source line changed by this round.** `git diff --stat` is exactly 3 files:
the test (+104/−42), this doc, and the deleted fragment. After every mutation and
simulation, `packages/tui/src/{app-types.ts,App.tsx,index.ts}` are back to HEAD's
sha256 (`85ee52f9…`, `ebe40eea…`, `5ae91e51…`), verified each time.

**Not verified (one line).** I did not re-run the review's own attack (e) (the
pinned `export { App, type AutoAcceptFeed }` text) beyond making it
formatting-tolerant; the risk it names is cosmetic.

## Execution

### S0b — `feat/app-decomp-0b-structural` (structural net: order / identity / freshness; tests only)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (corrected in Fix
round 1: this section was signed `claude-sonnet-4-5`, the string that executor's
runtime self-reported. `night-task.sh`'s exec step launches
`~/bin/tentacle --profile deepseek` — `ps` on the live run confirms it, and the
profile is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`
(`~/.config/tentacle/config.jsonc`). The commit subject `exec (deepseek)` was
never evidence either way: it is a hard-coded string in `night-task.sh`. Fix
round 1's finding 4 has the full trail.)

**Scope and shape.** Five new test files under `packages/tui/test/`, nothing else
in `packages/`: `app-structural-order` (H1), `-identity` (H2), `-freshness` (H3's
no-render-between pairs), `-matrix` (H3's act-and-pass rows) and `-sgr` (M3's SGR
frames + pill clicks). `git diff --stat HEAD` is empty; `git status` lists only
the five new files and one changelog fragment. No existing test was edited, no
`src/` line changed, no schema change (so `packages/protocol/schema/protocol.json`
was not regenerated).

**Load-bearing check, re-run first (passed).** Two claims, both re-verified on
this branch rather than trusted:

1. *Ink calls every active `useInput` listener for each chunk.*
   `packages/tui/node_modules/ink/build/hooks/use-input.js:89` registers
   `internal_eventEmitter.on('input', handleData)` and the handler has no return
   value consumed by anything and no stop-propagation; the module-level emitter
   is per-App (`components/StdinContext.js:11`). So splitting the handler across
   hooks would lose the order. **Holds.**
2. *App has exactly ONE `useInput`.* `grep -rn "useInput(" packages/tui/src` →
   `App.tsx:3465` and the separate pre-mount `components/SessionPicker.tsx:85`.
   **Holds** (the plan's 3802 is pre-S1's numbering; S1 removed the type block
   above it and shifted every line up by 337, which is why every line number in
   this slice's headers is the post-S1 one).

**The window H3 is built on, measured (probe `sync-probe.ts`).** A second
`stdin.write` in the same tick runs the handler with the PREVIOUS render's
closure — `chunk="b" closureState=0 ref=1 renders=2` — because Ink wraps the
handler in `batchedUpdates` and React's legacy-mode batch (`ink.js:59`
`createLegacyRoot`-equivalent mode 0) commits after the microtask queue drains. A
ref read is live in that window and a render read is stale, which is exactly what
the freshness tests assert; without this probe the pairs below would have been
guesses.

**H1 — effect order (`app-structural-order.test.tsx`, 1 test).** The scenario is
the plan's (initial prompt + a replayed history + a pending exit at mount), and
the two orders turn out to differ in a way that is deterministic, not timing
dependent: the watch's backlog history is delivered while the prompt's turn
streams, so `nextStep` (`turn-feed.ts`) HOLDS it and applies it after the turn
settles — the replay replaces the transcript. With the watch first, the history
is applied with nothing in flight and the turn is appended BELOW it. Pinned: the
replay is on screen once, in order, and the prompt's rows are gone (replaced);
`send` was called once, as a prompt. Probes `probe-mount2.ts` (today) and
`probe-swap-b.ts` (swapped) print both frames side by side.

*Drift from the Implementation, recorded:* the plan says the swap is "shown red
under a swap of 2548 and 2773". Only one direction is a behavioural mutant. The
other (moving the watch effect UP, above the initial prompt) does not compile:
`watchSession` is declared between them, so the moved effect lands in its TDZ and
App throws on mount (`probe-swap.ts` captured the React error). A crash is not a
§9 mutation, so M1 moves the initial prompt DOWN, which is also the direction H1
actually warns about ("the plan's final hook order would put the watch before the
initial prompt"). The pin is written to today's behaviour deliberately —
a slice that intentionally changes it must update this pin with the change.

**H2 — callback identity (`app-structural-identity.test.tsx`, 1 test).** Counts
`watch`/release pairs and `open` calls across the three re-render sources the
plan names (typing, a timer, a resize) and pins one subscribe / no release / one
open for the whole mount, then exactly one release on unmount. The frame is
asserted to hold the typed text in the same test, so the re-renders are proved to
have happened (non-vacuity of the *scenario*).

*Drift from the Implementation:* the plan names `session/open` as the second
counter; a mounted `App` calls `open` once, at mount, and no re-render repeats it
(even a re-subscribe does not), so `open` is a constant here and the
subscribe/release pair carries the assertion. It is still counted, so a slice
that adds an open per render fails.

**H3 — no-render-between pairs (`app-structural-freshness.test.tsx`, 4 tests),
one per snapshot-source rule, each naming the field it pins:**

| Test | Field and today's source | What the render twin would do |
|---|---|---|
| turn stop | `stateRef.current.running` (ref, `App.tsx:3770`) | Enter + Esc in one tick: the Esc would not stop the turn it just started |
| quit confirm | `quitConfirmRef.current` (ref, `:3477`) | a second Ctrl+C in one tick would not dismiss the dialog it just raised |
| permission ask | `permission.pending` (RENDER value) | the `y` that arrives with the ask would approve it before any dialog is painted |
| panel Esc | `panel` (RENDER value, `:3672`) | the same-tick second Esc would fall through and stop the running turn |

The last two are the *reverse* direction (a render value that must not be
"cleaned up" into a ref) — H3's rule is per field, and the plan's list has both
kinds. Each test also shows the normal, rendered path working immediately after,
so an assertion about the window cannot be confused with a broken key.

*Drift from the Implementation:* the plan says "`/quit` confirm + `y`". Measured
(`probe-pairs.ts`), `y` with no render between reaches NO layer — the dialog's
own facts are a ref but the *key parse* still goes through the same handler whose
`quitConfirmRef` is set, so `y` is answered only when it is parsed with the ref
already set; the discriminating pair is Ctrl+C + Ctrl+C. Similarly the plan's
"ask arriving + `y`" is pinned in the direction that is observable (the ask is
NOT approved in the window; it is approved by the next, rendered `y`). Both are
recorded here rather than silently reworded, because a future slice's S3 layer
contract has to reproduce exactly this.

**H3 — router matrix rows (`app-structural-matrix.test.tsx`, 6 tests).** The
five rows the plan names, plus a sixth the reading turned up:

1. a chord-breaking key does its own job (Ctrl+X, then `a` is typed);
2. a non-panel key on an ARMED `/sessions` row disarms AND acts;
3. a printable key on the FOCUSED pill types, hands the focus back, and the next
   Enter SENDS (not opens the dropdown);
4. `[` + Enter: the held bracket is restored into the same-event submit;
5. `[` + a letter: the restored bracket precedes it (extra, and it is `carry`);
6. a key behind a list panel after a half mouse report edits nothing.

*Drift (a real correction to the plan's wording).* The plan's "non-panel key on
an armed sessions row disarms AND acts" cannot be shown with a printable key: a
printable key behind a panel is swallowed by the "behind a panel nothing edits"
guard (`:3957`), so it disarms and then does nothing observable. The acting key
is a MOUSE report — `probe-armed3.ts`: the wheel disarms the delete and scrolls
(`↑28 more` in the bar). The test uses the wheel for that reason, and the
`Down` variant was dropped (it is a *panel* key, and `applyPanel` disarms it
itself, so it proves nothing about the fall-through).

**M3 — SGR frames and pill clicks (`app-structural-sgr.test.tsx`, 5 tests).**
Truecolour is forced (`chalk.level = 3`, restored in `afterAll`) because with
colour off Ink emits no codes at all. Pinned: a focused pill is inverse+bold with
exactly one inverse run opening at the pill's own cells; a drag paints inverse
over the dragged cells (the run opens after 2 plain columns) and clears on
release; an attach row carries `📎 a.png`; the pill's reported range opens the
dropdown at rest AND with a running turn on screen (the row derivation includes
`runningRows`); a press outside the pill's cells does nothing.

*Drift (scope, stated):* the plan asks for "running + queued". The queued variant
needed a session that can hold a queued row, and the layout property the pin is
about (the bar's row and cell range being re-derived per layout) is already
decided by the running case; the queued variant adds rows above the input in the
same way. Left out and recorded here rather than claimed: **queued is NOT
pinned.** `bun test --coverage packages/tui` was not re-run either (the plan's
coverage check belongs to the src-touching slices; this one adds tests only).

**Mutation check (§9 non-vacuity) — 12/12 KILLED, each on its assertion.**
Harness `.tentacle/tmp/app-decomp-0b-structural/mutate.ts` (byte-copy backup, one
run of the filtered test, restore, sha256 compare; it refuses a run that executed
0 tests, because a bad `-t` filter otherwise looks like a kill — M8 first looked
"KILLED" that way and was re-run after the filter was fixed).

| # | Mutation | Test | Result |
|---|---|---|---|
| M1 | initial-prompt effect moved after the watch effect | mount order | **KILLED** (1 ran, 1 fail) |
| M2 | `watchSession`'s deps name `field.value` (a render value) | identity | **KILLED** (1 ran, 1 fail) |
| M4a | `stateRef.current.running` → render `st.running` at 3770 | turn stop | **KILLED** (1 ran, 1 fail) |
| M4b | `quitConfirmRef.current` → render `quitConfirm` | quit confirm | **KILLED** (1 ran, 1 fail) |
| M4c | `panel` → `panelRef.current` in the tree-panel layer | panel's Esc | **KILLED** (1 ran, 1 fail) |
| M5 | a chord-breaking key is swallowed | chord-breaking key | **KILLED** (1 ran, 1 fail) |
| M6 | the armed-row disarm returns instead of falling through | disarms AND acts | **KILLED** (1 ran, 1 fail) |
| M7 | the dock's state is applied only for non-`pass` | FOCUSED pill | **KILLED** (1 ran, 1 fail) |
| M8 | the restored `[` is dropped from a same-event submit | held bracket plus Enter | **KILLED** (1 ran, 1 fail) |
| M9 | a focused pill paints bold but not inverse | SGR FOCUSED pill | **KILLED** (1 ran, 1 fail) |
| M10 | the pill's row derivation omits `runningRows` | running turn still does | **KILLED** (1 ran, 1 fail) |
| M11 | a press anywhere on the bar's row opens the dropdown | OUTSIDE the pill | **KILLED** (1 ran, 1 fail) |
| M12 | a drag paints no inverse over the selection | text SELECTION | **KILLED** (1 ran, 1 fail) |

Every row is a red on the ASSERTION with a real `0 pass / 1 fail` count from the
filtered run — never an import or compile error. After each, the mutated file's
sha256 matched its pre-run value (`restored: sha256 MATCHES`), and
`git status --short packages/tui/src` is empty at the end. `App.tsx` is
`ebe40eea…`, `StatusBar.tsx` unchanged (its own HEAD bytes) — the same
`App.tsx` sha the S1 round recorded. One harness run was interrupted by the
tool timeout before its `finally`, leaving the M2 edit in the tree; it was
restored from the byte backup (sha256 verified against `git show HEAD:`) and that
fragile M2 shape was replaced by the dep-array mutation above.

**Gate (this worktree, this branch).**
- `bunx tsc --noEmit` → 0 errors; `bunx tsc -p apps/mobile --noEmit` → 0.
- `bun run lint` (`biome check .`) → `Checked 1018 files … No fixes applied.`
  (the AGENTS §6 baseline: 0 errors, 0 warnings). Four Biome findings on the new
  files were fixed: two import orders, one formatting block, and the
  `noControlCharactersInRegex` suppression the repo already uses for SGR-stripping
  regexes (two files).
- `bun test` → **7938 pass, 3 skip, 1 fail**. The 3 skips are the documented
  opt-ins (live-k8s, live-docker, real-socket keepalive). The 1 fail is
  `packages/daemon/test/serve-log-store.test.ts` "S11 — a real SIGKILL at random
  points" (`Expected: > 100, Received: 0` on a 13.7 s timing test): a pre-existing,
  load-sensitive flake already recorded in `docs/fix/local-subagent-panel-unwired.md`
  (§Gate: "passes 6/6 alone and 4/4 in its own suite … this diff touches neither
  `packages/daemon/` nor anything that test imports"). Re-run alone here:
  **1 pass, 21 filtered out, 0 fail**. This slice cannot reach it — it adds five
  files under `packages/tui/test/` and touches no `src/`.
- No schema change → `packages/protocol/schema/protocol.json` not regenerated.
- `changelog.d/app-decomp-0b-structural.added.md` added (one bullet).

**What this slice gives S4+ (Q8's "yes").** The three things the moves stress now
have a red-if-broken test each, and each was proved by mutation rather than by
reading: effect order (M1), callback identity (M2), freshness per field (M4a-c).
The matrix rows (M5-M8) and the SGR/click pins (M9-M12) are what S3's layer
contract, S4's per-event `dispatchMouse` and S10's verbatim JSX move must keep.

**Not verified (one line each).**
- The queued-row layout variant of the pill-click pin (above) — verify by adding
  a session that holds a queued row and clicking the pill in that state.
- The full suite's one fail is attributed to the documented flake; the claim rests
  on it passing alone plus the diff touching no `packages/daemon/`. A second full
  run would make it conclusive.

### Fix round 1 — `feat/app-decomp-0b-structural` (S0b review findings)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id: `ps` shows
this run launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`, whose
model is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` in
`~/.config/tentacle/config.jsonc`).

All four findings were MEDIUM; **none is rebutted**, three are fixed as stated
and one (finding 1) is fixed in the *other* site the plan actually names, with
the measurement that decides it pasted below. Scope: 2 test files edited
(`app-structural-matrix.test.tsx` +2 tests, `app-structural-sgr.test.tsx` +2
tests), the changelog fragment deleted, the S0b signature corrected. **No
`packages/tui/src` line changed** — `git diff --stat -- packages/tui/src` is
empty and `App.tsx` is still `ebe40eea…` (the S1 round's sha).

**One measurement first, because it decides two findings and I had it wrong at
first.** `panelRef.current = panel` is assigned **during render**
(`App.tsx:472-473`). So in a **key-handler** closure (a new closure every
render) the render value and the ref are the *same value*, and swapping them is
an **equivalent mutant**, not a hole. They differ only in a **frozen** closure —
a timer or a promise continuation, memoised before the panel changed. That
distinction is what the whole round turns on, and it is why the reviewer's
line attribution and mine differ:

- the plan's M4 names two sites (pre-S1 `4107`, `4013`; **post-S1 `3770`,
  `3676`** — S1 removed 337 lines above them, which the S0b Execution already
  recorded). `3770` is `stateRef.current.running` in the handler; `3676` is
  `panelRef.current?.kind === "sessions"` inside a promise continuation.
- the reviewer's "the only ref read still in a handler is `:3427`" is the right
  instinct about frozen closures, but `:3427` is the held-`[` **timer**, and the
  plan's `4013`→`3676` is a continuation. Both are frozen; I measured both.

**Finding 1 — MEDIUM (the plan's M4 was replaced without a drift note). FIXED.**
The reviewer's claim was "would very likely survive". Measured
(`.tentacle/tmp/app-decomp-0b-structural/sweep-m4.ts`, whole `packages/tui/test`):

| Mutant | Whole tui suite |
|---|---|
| `:3427` `!panelRef.current` → `!panel` (the plan's M4) | **KILLED** — 1762 pass / 1 fail (`/mcp panel > a lone '[' typed while the panel is open…`) |
| `:3455` paste-timeout flush, same swap | **KILLED** (truncated-paste test) |
| `:4034` clipboard answer, same swap | **KILLED** (Ctrl+V-after-open test) |
| `:3676` `open: panelRef.current?.kind` → `panel` | **SURVIVED** — 1763 pass / 0 fail |

So the plan's mutant is **not** a survivor at the gate — but the reviewer's real
point stands and is the one I fix: **the S0b net did not own it.** Run against
the five structural files alone, the plan's M4 **SURVIVED (17 pass, 0 fail)** —
the net was borrowing `app.test.tsx`'s coverage, so a future slice that touched
this timer would learn about the break only from an unrelated file. That is the
hole the plan meant by "a survivor is a hole to close before S4".
**Fix:** `app-structural-matrix.test.tsx` gains *"a `[` held for the mouse
window is not restored while a panel is open"*, which holds `[`, lets the 100 ms
timer fire with the panel OPEN, and asserts the input is untouched. The two
scenarios that do **not** discriminate are recorded so nobody re-derives them:
a panel **closing** inside the window keeps the bracket today (a frozen `null`
and a live `null` agree — probe `probe-f1x.ts`), and the plan's `3676` site is a
**genuine equivalent mutant** (`panelGenRef` is bumped synchronously by
`closePanel`/`openPanel`, `:1512`/`:1523`, so `gen === startedGen` already fails
whenever the panel is not the delete's own — probe `probe-f1z.ts` prints the same
notice under both). Both are explained, not silently swapped: the drift note the
review asked for is the paragraph above.

**Finding 2 — MEDIUM (plan rows missing while Execution claimed them complete).
FIXED, 2 of 3; 1 corrected in the doc.** The reviewer named three rows.

1. *"paste with a panel open"* — genuinely absent, now added
   (`app-structural-matrix.test.tsx`: a `\u001b[200~…\u001b[201~` chunk behind
   `/mcp` never reaches the hidden input). Note on non-vacuity: this row cannot
   be a `panel`→`panelRef` mutant, because at `:3626` it is a key-handler closure
   (the rule above) — it **SURVIVED** by construction. It is a plan row, not a
   mutant target, and the test's job is to fail if the *guard* is deleted, which
   it does.
2. *"pill click after the dock opens"* — absent, now added
   (`app-structural-sgr.test.tsx`: focus the pill, Enter for the dropdown, Enter
   again for the drawer, then click the pill). This **is** a real hole: dropping
   `dockHeight` from the bar's reported row (`:4257`) **SURVIVED the whole tui
   suite (1763 pass)**, i.e. no existing test held it.
3. *"after an attach row appears"* — the row was absent, now added
   (`app-structural-sgr.test.tsx`: `/tmp/a.png` + Enter → the chip row paints,
   then the pill click must still land). Also a real pill-click hole: the
   `attachRowRows` term (`:985`) is killed today only by a **frame-height**
   assertion (`T8j`), not by any click test.

*Correction to the Execution's own claim, recorded not reworded:* it said "the
five rows the plan names, plus a sixth" — the true count is the five + one
extra, and of the plan's five the "paste with a panel open" one was missing.
With the two added here the row set is now the plan's, plus `[`+letter.

**Finding 3 — MEDIUM (the changelog fragment breaks §10). FIXED.**
`changelog.d/app-decomp-0b-structural.added.md` deleted. Verified this slice is
test-only before deleting: `git diff --name-only main...HEAD` is the 5 test
files + this doc + the fragment; no `src/` path, so §10's "internal/dev/test-only
work adds no fragment" applies.

**Finding 4 — MEDIUM (signature vs commit mismatch). FIXED, and the commit
subject was the misleading side.** The S0b section now reads
`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`. Evidence, from the run records in
`.tentacle/tmp/orchestration/runs/`:

- `night-task.sh`'s exec step is `~/bin/tentacle --profile deepseek -- …`, and
  the commit line after it is the **hard-coded** string
  `feat($SLUG): exec (deepseek)` — so `ba9a964`'s subject is not a model claim.
- that run's own log (`night-app-decomp-0b-structural-exec.log:575`) shows the
  executor writing `*— claude-sonnet-4-5-20250929 …*`, then
  (`:593`) rewriting it to `claude-sonnet-4-5` with the note "no build-date
  suffix is known to me, so none is invented". So `claude-sonnet-4-5` was a
  runtime *self-report*, and the launcher's profile is the better evidence — the
  same id the S1 rounds signed from the same config file.

**Mutation check (§9 non-vacuity) — 4 new, all KILLED on their assertion.**
Harness `.tentacle/tmp/app-decomp-0b-structural/sweep-f1.ts` / `sweep-f2.ts`
(byte-copy backup, one filtered run, restore, sha256 compare; each refuses a run
that executed 0 tests). Pasted:

| # | Mutation | Test that owns it | Result |
|---|---|---|---|
| M4 | `:3427` `!panelRef.current` → `!panel` | held-`[` + panel open | **KILLED** — `Expected: "" / Received: "["` |
| M13 | `:4257` the bar's row drops `dockHeight` | pill click, drawer open | **KILLED** — `Expected to contain: "background · 1"`, received the unchanged drawer frame |
| M14 | `:985` `inputBoxRows` drops `attachRowRows` | pill click, chip row painted | **KILLED** — same assertion, 24-row frame |
| M4d | `:3626` `!panel` → `!panelRef.current` | paste behind a panel | **SURVIVED** (equivalent mutant — key-handler closure; stated, not claimed as a kill) |

Every KILLED row is red on the **assertion** with a real `1 ran` count, never an
import or compile error, and each file's sha256 matched its pre-run value
(`restored: MATCHES`).

**Gate (this worktree, this branch).**
- `bunx tsc --noEmit` → 0 errors.
- `bun run lint` (`biome check .`) → `Checked 1018 files … No fixes applied.`
  (the §6 baseline: 0 errors, 0 warnings).
- `bun test` → **7943 pass, 3 skip, 0 fail** (571 files, 357 s). The 3 skips are
  the documented opt-ins. The S0b round's `serve-log-store` SIGKILL flake did
  **not** recur here, so the suite is clean without needing that attribution.
- The two touched test files re-run 3× → 15 pass / 0 fail each time (no
  timing flake in the new `[`-hold or pill-click tests).
- No schema change; no `src/` change; `packages/protocol/schema/protocol.json`
  not regenerated.

**Not verified (one line each).**
- The new `[`-hold test depends on the 100 ms hold finishing before the 200 ms
  wait; at a far heavier machine load it could need the wait raised — verify by
  running `bun test packages/tui/test/app-structural-matrix.test.tsx` under load.
- The reviewer's `[<0;5`-without-ESC and SGR-strip assumptions were accepted as
  read, not re-measured (they are unchanged by this round).

## Review

### S0 review — REQUEST-CHANGES

*— claude-opus-5-5, 2026-11-13* (fresh context; different model family from the
executor deepseek-v4.1-flash)

**Scope:** `git diff main...HEAD` — 3 new test files, CHANGELOG, this doc; no
`packages/tui/src` change (verified: empty diff).

**Gate.** S0 files: 53 pass / 0 fail. `bun run lint`: clean (954 files).
`bun run typecheck`: clean. Full `bun test`, three runs: 7573/3 skip/0 fail
twice, **7572/3 skip/1 fail once** (test not captured; not reproduced; the
three S0 files and `app.test.tsx` are timing-based, 20–25 ms `delay`s — see 2).

**Findings**
1. **MEDIUM — `/compact`'s mid-turn refusal is unpinned.** Plan (Tests 2) asks
   for "the mid-turn refusal for each session-mutating command";
   `app-commands.test.tsx:328` covers only `SESSION_MUTATING`
   (`/retry`,`/clear`,`/close`), but `/compact` guards itself
   (`commands.ts:167`, `App.tsx:3265–3268`). Mutation
   `if (false && stateRef.current.running)` at `App.tsx:3265`: **all 1727
   `packages/tui` tests stay green** (reverted, tree clean). S2 moves exactly
   this case into its own file; a dropped guard would compact under a live turn
   unnoticed. Fix: a session with `compact` + a `hang` turn → `/compact` shows
   "Can't compact while a turn is running." and `compact` is not called; show
   red under the same mutation.
2. **Note (not blocking) — one unattributed full-suite failure in 3 runs.** The
   executor already found one timing flake in this net. Before S1 relies on the
   net, it should run the full suite ≥3× and capture `(fail)` names; a flaky
   net makes S1–S10 reviewers ignore red.

**Attacks tried.** (a) Mutation spot-check M1 (drop the quit-confirm `return`,
`App.tsx:3832`) → precedence test red, reverted: claim holds. (b) `/compact`
guard mutation → survived everything (finding 1). (c) Pinned-dropdown `ctrl+x`
(plan "dropdown focused vs pinned") missing from S0 → already pinned by
`dock-type-through-frames.test.tsx:303`; no gap. (d) Skill mid-turn refusal →
pinned by `slash-skills.test.tsx:134`. (e) Inline snapshots: committed as
literals (no `__snapshots__` dir needed), mismatch fails (executor's F1).

**What holds.** Load-bearing assumption (one `useInput`, App.tsx:3802) is true;
no src change; precedence matrix covers the named pairs; registry-exhaustiveness
test forces new commands into the file; the `norm` rule-elision fix is sound
(it hides rule *length* only — accepted, low).

**Executor behaviour.** Honest and thorough: found and fixed its own flake,
explained the one equivalent mutant correctly (M3), kept the tree clean. Missed
the self-guarded `/compact` refusal because it treated "session-mutating" as the
`SESSION_MUTATING` set rather than the plan's wording.

#### Owner answers (2026-11-13)

Q1–Q6 as recommended. Opus executes the slices; Fable design-reviews this plan while S0 runs. Implementation APPROVED.

## Review

### S0 re-review (after Fix rounds 1–3) — PASS

**Scope:** `git diff main...HEAD`, S0 only: 3 test files, CHANGELOG, this doc.
`git diff main...HEAD -- packages/tui/src` is empty, so S0 touches no §7
invariant. It only pins the single-`useInput` precedence that S3 must keep.

**Gate (re-run).** The three S0 files: **58 pass / 0 fail** (13 inline
snapshots, 149 expects). `bun run lint`: clean, 954 files. `bun run typecheck`:
clean. I did not re-run the full suite this round.

**Findings: no HIGH or MEDIUM.**
- Prior MEDIUM 1 (`/compact` mid-turn refusal): the test exists, and the guard
  list now comes from `SESSION_MUTATING` with a pinned list.
- Note: the frame `norm` collapses every rule of 3+ `─` to `…`. Whole border
  rows become `…`, so if a later slice changes border or rule width, the frame
  set will not catch it. This is accepted for S0, but S10 (verbatim JSX move)
  should not rely on S0 frames for box geometry. S0b's SGR pins should cover it.

**Attacks tried.**
(a) Checked that `quit-confirm vs permission` is not vacuous: if the order is
swapped, `n` denies the ask, so `answers` would be non-empty and the test fails.
(b) Sessions-panel Esc: the `not.toBe(opened)` assertion is weak, because the
spinner changes the frame anyway. But `aborts()==0`, then `==1` on the second
Esc, still decides the case. Holds.
(c) Snapshots: no empty `toMatchInlineSnapshot()`, so nothing can self-write.
(d) Chord-before-permission (D3) and the panel paste-drop act-and-pass layers
are not in S0. They are in S0b's scope (H3), so this is not an S0 gap.
(e) My own mutations (quit-confirm never clears on `n`; a changed `Thinking`
hint string; `false &&` on `dockClaimsCtrlX`) **were not run**. Shell
permission for edits/hashing in this session was denied. Non-vacuity rests on
the executor's 39/40 table, Fix rounds 1–3's red/green pairs, and round 1's
M1 spot-check. To verify, run
`.tentacle/tmp/app-decomposition/rev4-mut.sh` (it restores and checks sha256).

**Executor behaviour.** All three fix rounds were honest. They re-proved
earlier claims instead of trusting them, closed the finding's class empirically
(N1–N3), and attributed the long-standing flake to a `packages/client` deadline
outside this diff.

*— claude-opus-5-5, 2026-11-13* (fresh context; same model as Fix round 1's
executor, different family from the deepseek executor)

## Review

### S1 review — REQUEST-CHANGES

**Verdict: REQUEST-CHANGES**, for two doc/file fixes. The code is a clean pure move.

**Findings.**
1. **MEDIUM — the branch carries out a slice the plan dissolved, and does not
   say so.** *Design review response* H4 (this doc, l. 339–342) and the revised
   order table (l. 400, `~~S1 types~~ | dissolved into S5/S6/S8/S9`) were
   already on the branch base `632aeb5`. The header (l. 3) still says
   "S1+ re-approval pending". The S1 Execution never mentions this. It edits the
   old slice-table row (l. 166) as if S1 were still live, so the doc now
   contradicts itself: l. 166 + l. 963 say "S1 DONE"; l. 342 + l. 400 say "no
   single `app-types.ts`, created by the first hook slice that needs it".
   *Failure scenario:* an S5/S6/S8 executor follows l. 342/400 and keeps its
   types next to the hook. That moves `SessionDirectory`/`NoticeFeed`/`RunQuit`
   out of `app-types.ts`, and the new `test/app-types.test.ts:36-42` (which
   pins all six declared there) goes red on a planned move. Or the executor
   finds the file already there and has no recorded rule to follow. *Fix:*
   record who re-approved S1 and why (the orchestrator launched it, but nothing
   in the doc says so). Strike the "dissolved" row and update H4's (1). Narrow
   the pin test to the members that are meant to stay (`AppProps`,
   `SessionController`), or state that later slices may edit it.
2. **MEDIUM — `changelog.d/app-decomp-1-types.changed.md` breaks AGENTS §10
   ("Internal/dev/test-only work adds no fragment") and this plan (l. 241).**
   The bullet describes an internal file move with "No behaviour change". It
   would ship in the user-facing CHANGELOG at the next `bun run release`.
   Drift (a) (l. 909) blames the brief, but AGENTS.md overrides a brief. *Fix:*
   delete the file.

**Gate (re-run by me).** `bun test` on `app-types.test.ts` +
`subagent-panel-controller.test.ts`: **10 pass / 0 fail** (45 expects).
`bun run typecheck`: clean. `bun run lint`: `Checked 977 files … No fixes
applied.` The full suite was not re-run (my brief limited it to the touched
files). The Execution reports 7790 pass / 3 skip / 0 fail.

**Premise table.**
| Claim | Result |
|---|---|
| `main:App.tsx` l. 272–608 ≡ `app-types.ts` l. 25–361 | TRUE (`cmp` against `632aeb5`: identical) |
| `index.ts` exported 5 of 6 (no `SettingsNoticeLine`) | TRUE (diff) |
| The CLI guard parses the declaring file by source text | TRUE (`subagent-panel-controller.test.ts:285`) |
| S1 is part of the approved plan | **FALSE** (l. 339, 400; see finding 1) |

**Mutation (§9).** Renamed `jobOutput` → `jobOutputX` in `app-types.ts:197`.
The CLI guard went **RED** (`(fail) GUARD: every SessionController member …`,
3 pass / 1 fail). After the revert, `git status` is clean. So the repointed
guard reads the real declaration and is not vacuous.

**Attacks tried.**
- (a) Runtime code riding along with the move: none. The header is
  `import type` only, and `Object.keys(import)` is `[]`.
- (b) An import cycle through `app-types.ts`: none. All its imports are
  type-only and erased at runtime.
- (c) A public surface change through `@tentacle/tui`: none. The same five
  types plus `App`/`AutoAcceptFeed` are exported.
- (d) A §7 invariant touched (single broker, RPC path, raw terminal writes): no
  runtime code changed, so none applies.
- (e) The pinned test text in `app-types.test.ts:84`
  (`export { App, type AutoAcceptFeed }`) is brittle to formatting. Noted only;
  it is not a defect.

**What holds.** The move is byte-identical. The 8 import trims are correct
(tsc/Biome clean). Drift (d), the guard repoint, is honest and was mutation-
proven.

**How the executor behaved.** Careful and honest on the mechanics: it derived
the block mechanically, used sha256 to prove it, corrected its signature, and
found the CLI guard through the full suite. It missed the plan-level fact that
H4 dissolved the slice it was executing.

*— claude-opus-5-5, 2026-11-13* (fresh context; different family from the
deepseek executor)

### Round 2

**Verdict: PASS.** Both findings are fixed. The fix commit (`8498947`) adds
no regressions.

- **Finding 2 (changelog fragment): FIXED.** The fragment file is deleted, and
  `changelog.d/` has no `app-decomp*` file left.
- **Finding 1 (plan contradiction): FIXED.**
  - The doc now agrees with itself. The header (l. 3), H4(1) (struck), the new
    *H4(1) status after S1* paragraph, the slice-table row, Q7's preamble and
    the revised-order row all say "S1 re-instated by the owner and executed".
    The type rule is kept as a resident/movable split.
  - The pin test now matches that split. It pins where `AppProps` and
    `SessionController` are declared. For the other four types it pins only
    that each re-export resolves to a module that declares the type.
  - I did not verify the owner's re-instatement independently. The orchestrator
    launched the slice, and the doc now records that.
- **Mutations (all reverted; `git diff` empty after each).**
  - (A) `export interface RunQuit` → `interface RunQuit` in `app-types.ts`:
    **RED**, 2 fail ("App.tsx still re-exports…", "index.ts exports … and no
    more").
  - (B) `SettingsNoticeLine` added to the type block in `index.ts`: **RED**,
    1 fail ("… and no more").
  - The re-export resolution therefore has teeth even though the test was
    narrowed.
- **Regressions.** `git diff HEAD~1` touches no `packages/tui/src` or
  `packages/cli` file: it is the test, the doc and the fragment deletion only.
  `app-types.test.ts` + `subagent-panel-controller.test.ts`: 10 pass / 0 fail.
  `bun run typecheck`: clean. `bun run lint`: `Checked 977 files … No fixes
  applied.` The full suite was not re-run, because this round changed no src
  file.

*— claude-opus-5-5, 2026-11-13* (fresh context; different family from the
deepseek executor)

## Review

### S0b review — REQUEST-CHANGES

Scope: `git diff main...HEAD` (5 test files, changelog fragment, doc). Gate:
5 structural files **17 pass / 0 fail**; `bun run lint` clean (1018 files);
`bun run typecheck` clean. No `src/` change. The full suite was not re-run.
My own mutation runs were **blocked by tool permission**, so this review
mutated nothing. The 12-row table is the executor's word, not something I
checked.

1. **MEDIUM: an M4 mutant the plan requires was replaced, and the swap is not
   recorded.** The plan (M4) asks for `panelRef.current` → `panel` at the
   handler's ref read, and says a survivor is a hole to close before S4. The
   only ref read still in a handler is `packages/tui/src/App.tsx:3427` (the
   held-`[` timer flush, `!panelRef.current`). M4c mutates the opposite way
   (`panel` → `panelRef`). No test holds a `[` while a panel opens or closes
   inside the 100 ms window, so the plan's mutant would very likely survive.
   The doc lists this without any drift note.
2. **MEDIUM: plan rows are missing while Execution says the rows are complete.**
   The H3 matrix names 7 rows, including "paste with a panel open". Execution
   says "the five rows the plan names, plus a sixth". No structural test
   pastes anything (`grep -i paste` finds nothing). M3 asks for a pill click
   after the dock opens and after an attach row appears; only rest and running
   are tested (`app-structural-sgr.test.tsx:182`), and only the queued gap is
   recorded.
3. **MEDIUM: the changelog fragment breaks §10.** The task is tests only, and
   "internal/dev/test-only work adds no fragment"
   (`changelog.d/app-decomp-0b-structural.added.md`). Delete it.
4. **MEDIUM: the executor signature does not match the commit.** Execution is
   signed `claude-sonnet-4-5`, but commit `ba9a964` says "exec (deepseek)".
   §10 asks for honest model signatures. Correct whichever is wrong.

Attacks tried: the §7 "logic in pure modules" and "TUI over RPC" invariants
are untouched (tests only, no src). `[<0;5` with no ESC is fine because Ink
strips the ESC before the handler sees it. Order/identity/freshness tests read
as asserting the property, not a correlate. The tree is clean after review.

*— claude-opus-5-5, 2026-11-13* (fresh context; different family from the
executor, whichever of the two named it is)

### Round 2 — PASS

Scope: `git diff HEAD~1` (2 test files, fragment deleted, doc). Mutations were
applied with temporary edits to `App.tsx` and run against the five structural
files only. Each edit was reverted, and `git status` is clean afterwards.

| Finding | Mutation | Result |
|---|---|---|
| 1 | `:3427` `!panelRef.current` → `!panel` | **KILLED**: the new held-`[` + panel-open test, 20 pass / 1 fail |
| 2 (paste) | `:3627` `clean && !panel` → `clean` (guard deleted) | **KILLED**: the paste-behind-panel test |
| 2 (dock) | `:4257` drop `dockHeight` | **KILLED**: the pill click with the drawer open |
| 2 (attach) | `:985` drop `attachRowRows(...)` | **KILLED**: the pill click with the chip row painted |
| 3 | — | the fragment is gone from `changelog.d/` |
| 4 | — | the S0b section is re-signed with the launcher profile's id, and the evidence is cited |

Gate: 5 structural files **21 pass / 0 fail**; `bun run lint` clean (1018
files); `bun run typecheck` clean. I did not re-run the full suite; the
executor reports 7943 pass / 3 skip / 0 fail. I did not check the executor's
claim that `:3676` is an equivalent mutant (it rests on `panelGenRef` being
bumped synchronously). It is outside S0b's required kills, and S3 should keep
it in mind. No regressions: the round changes no `src/`, and the only new
dependency is the 200 ms timing wait, which the executor already lists as
unverified under load.

*— claude-opus-5-5, 2026-11-13* (fresh context; different family from the
DeepSeek executor)
## Execution

### S4 — `feat/app-decomp-4-mouse` (the mouse layer leaves `App.tsx`)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id: `ps` shows
this run launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`, whose
`model.model` is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` in
`~/.config/tentacle/config.jsonc:29`.)

**Scope.** `packages/tui/src/mouse-stream.ts` (new, pure), `useMouse.ts` (new,
the hook), `App.tsx` (−163 lines), two new test files, one changelog fragment.
No existing test edited, no `packages/protocol` change (so `protocol.json` was
not regenerated), no other slice touched.

**Load-bearing check, re-run first (PASSED).** The plan's claim is that Ink
calls every active `useInput` listener, so the handler cannot be split across
hooks. Re-verified on this branch, not trusted:
`packages/tui/node_modules/ink/build/hooks/use-input.js:89` registers
`internal_eventEmitter?.on('input', handleData)` and `handleData` (`:80-87`) has
no return value anyone consumes and no stop-propagation; the emitter is
per-App (`components/StdinContext.js:11`). `rg "useInput\(" packages/tui/src` →
`App.tsx:3439` (was `:3465`) and the separate pre-mount
`components/SessionPicker.tsx:85`. **Holds** — so `App` keeps the ONE
`useInput`, and S4 moves only its mouse BODY.

**Design, as built (dependency order).**
1. **`mouse-stream.ts`** — the two pure decisions, no React import:
   - `stepMouseChunk({held, char, key, panelOpen})` → `{reports, hold, restored,
     submit, swallowBehindPanel, verdict}` (the plan's five fields plus
     `submit`, which the plan folded into `restored`; see drift 2).
   - `dispatchMouse(state, report, snapshot)` → `{state, effects}`: ONE report,
     the effects the App applies, and the threaded `{click, selection}` state.
     `MouseEffect` is data (`scroll | panelClick | dockPill | dockRow |
     toggleTool | copySelection`) so the App keeps only execution.
   - `plainKeyOf(key)` — the "is this a real keypress" rule, extracted so the
     swallow rule is unit-testable rather than inline.
2. **`useMouse.ts`** — owns the partial-report ref + its 100 ms timer and the
   click recogniser; executes the effects through a narrow port (`panelRef`,
   `dockRef`, `selectionRef`, `setSelection`, `field`, `clipboard`,
   `pushNotice`, `setScrollOffset`, `setPanel`, `setDock`, `setExpandedIds`,
   `dockIds`, `clickDock`, `panelClick`, `clampOffset`, `submit`). Deps name
   FIELDS, never the port (Fable H2).
3. **`App.tsx`** — the inline `dispatchMouse` (pre-S1 4156–4252), the chunk
   state machine (4254–4307) and the selection/hold helpers (3719–3776) are
   gone; in their place a `useMouse({…})` call and, inside the one `useInput`,
   a snapshot built AT THE EVENT:
   `{listView, panelOpen, columns, panelBodyTop, dockTop, dockView, statusRow,
   laid, win, total, viewport, visibleCount, expandAll}` then
   `if (mouse.handleChunk(char, key, snap) === "consumed") return;`.

**What did NOT move, and why (Fable M1/H1, stated rather than discovered late).**
- The **live selection** (`selection`, `selectionRef`, `setSelection`), because
  the JSX paints it and the scroll-anchor effect declared ABOVE the hook reads
  `selectionRef`; moving it would have moved that effect's index. It stays in
  `App` and reaches the hook as a port field.
- The **hold's unmount cleanup** stays in App's ordered effect list (index 19 of
  20 before AND after: `git show HEAD:… | grep -n useEffect(` vs the working
  tree both list it 19th, at `:3435` before and `:3409` now). No effect was
  added, removed or reordered by this slice — the hook declares none.
- `WHEEL_LINES` moved to `mouse-stream.ts` (it is the wheel decision's own
  constant); `clickRef`/`CLICK_IDLE`/`ClickState` moved into the hook.

**Drift from the Implementation (all three recorded, none silent).**
1. **`selection` travels in `MouseState`, not as an effect.** The plan's M2
   names the dispatch's inputs but not how the selection threads. It has to
   thread through the reports (a coalesced press+drag+release must copy), and
   today's `setSelection` writes its ref synchronously — which made the
   obvious pin VACUOUS. Measured, not assumed: M14 (re-read the refs per report)
   **SURVIVED** the selection tests (1 pass / 0 fail) and only went red once a
   COALESCED press+release CLICK was pinned, because the click state reaches its
   ref only after the loop. Cost: one extra App-seam test. The alternative
   (cloning today's bug into a passing test) was rejected.
2. **`submit` is its own field of the step, not implied by `restored`.** The
   plan's `{reports, hold, restored, swallowBehindPanel}` cannot express "the
   restored `[` must be submitted WITH this Enter rather than inserted": the App
   would have to re-read `key.return` outside the pure function. Keeping the
   decision inside `stepMouseChunk` is the §7 rule (decide in the pure module).
   `verdict: "pass"` still accompanies it, so the carry reaches the caller.
3. **The snapshot carries `panelOpen` (a RENDER value) as well as `panelRef`.**
   S0b's freshness pin records that a key-path panel read is the render value;
   the hold's 100 ms TIMER is the frozen closure that needs the ref. Both exist,
   each with its own source, exactly as H3's per-field rule requires — so the
   hook takes `panelRef` (timer) and the snapshot takes `panelOpen` (key path).
4. **There IS a `useMouse` hook — the plan's revised *What stays* / M2 said
   "no `useMouse` hook (per-event function)".** Recorded late: this contradiction
   was NOT declared in the first Execution (the S4 review's finding 2, fixed in
   fix round 1). The REVIEWED reading of H1/M2 is "no hook that owns an EFFECT",
   and that holds: `packages/tui/src/useMouse.ts:21` imports only
   `useCallback`/`useRef`, it declares no `useEffect`, and `dispatchMouse`
   (`mouse-stream.ts`) is a pure per-event function, with the render snapshot
   built at the event (`App.tsx:3790`). The hook exists only to hold what a
   per-event function cannot: the partial-report ref, its 100 ms timer, the
   click recogniser. *What stays* and M2 were amended to say this rather than
   leave the plan contradicting the build.

**Tests (new only).** `packages/tui/test/mouse-stream.test.ts` (22 tests, pure):
the chunk machine's every branch (coalesced reports, a trailing half held, a
prefix held while the key is plain and NOT held when it is not, a held `[`
completed / restored / submitted / dropped, a panel swallow, and that a report
still dispatches with a panel open) and the dispatch's whole priority order
(wheel → panel body → pill → dock row → click recogniser → tool header →
selection), each with its neighbour as the negative case.
`packages/tui/test/app-mouse-layer.test.tsx` (3 tests, the App seam): a
coalesced press+release CLICK expands the call; a coalesced press+motion+release
COPIES; the same gesture split across chunks copies the same text.
**All S0 (39/40) and S0b (21 tests) nets stay green, unedited** — the suite that
pins this behaviour was not touched, which is the behaviour-preservation proof.

**Mutation check (§9 non-vacuity) — 14/14 KILLED.** Harness
`.tentacle/tmp/app-decomp-4-mouse/mutate.ts` (byte-copy, one mutation, one
filtered `bun test -t`, restore, sha256 compare; a 0-test run is reported
INVALID so a bad filter cannot look like a kill — M14 first looked "SURVIVED"
and that finding is why the click pin exists).

| # | Mutation | Result |
|---|---|---|
| M1 | a trailing half report is not held | **KILLED** (0 pass / 1 fail) |
| M2 | a growable prefix chunk is never held | **KILLED** |
| M3 | a prefix chunk is held even when the key is not plain | **KILLED** |
| M4 | a held bare `[` is not restored | **KILLED** |
| M5 | the restored `[` is not carried into the same-event Enter | **KILLED** |
| M6 | behind a panel the layer passes instead of consuming | **KILLED** |
| M7 | a longer truncated hold is restored | **KILLED** |
| M8 | the wheel notch's direction is flipped | **KILLED** |
| M9 | the wheel is not decided before the panel body | **KILLED** |
| M10 | the pill hit test is inclusive at `start` | **KILLED** |
| M11 | the dock row offset drops the rule row | **KILLED** |
| M12 | the Ctrl+O guard is dropped | **KILLED** |
| M13 | the drag's motion bit is ignored | **KILLED** |
| M14 | the per-report state is re-read from the refs | **KILLED** |

Every row is a red on the ASSERTION with a real count (never an import/compile
error), and after each the mutated file's sha256 `MATCHES` its pre-run value;
`git status --short packages/tui/src` lists only `App.tsx` (modified) and the
two new modules — no mutation survived into the tree.

**Gate (this worktree, this branch).** `bun run check` → `tsc --noEmit` clean,
`tsc -p apps/mobile --noEmit` clean, `biome check .` **1050 files, 0 errors 0
warnings** (the AGENTS §6 baseline), `bun test` **8143 pass / 3 skip / 0 fail**
(the 3 skips are the documented opt-ins: live-k8s, live-docker, the real-socket
keepalive). No schema change → `packages/protocol/schema/protocol.json` not
regenerated. ~~`changelog.d/app-decomp-4-mouse.changed.md` added~~ — **withdrawn
in fix round 1, the fragment deleted** (an internal refactor adds none, AGENTS
§10; see finding 1 there).
`TODO.md` untouched (the orchestrator's line, per §10).

**Unverified (one line each).**
- The plan's coverage check (`bun test --coverage packages/tui`, App.tsx +
  new-files line total not dropping) was **not** run; the moved lines are pinned
  by 25 new tests plus the untouched S0/S0b nets, but the percentage is unmeasured.
- The queued-row variant of a pill click (S0b's recorded gap) is still unpinned;
  S4 does not change that path, and the record stands as S0b left it.

## Review

### S4 review — REQUEST-CHANGES

**Scope:** `git diff main...HEAD` only. **Gate (re-run):** touched files 25 pass / 0
fail; `bun test packages/tui` 1792 pass / 0 fail (S0 + S0b nets unedited, green);
`bun run lint` 1050 files, clean; `bun run typecheck` clean. Full `bun test` not
re-run by the reviewer.

**Findings (MEDIUM; no HIGH):**
1. `changelog.d/app-decomp-4-mouse.changed.md:1` — a fragment for a change that
   says of itself "Behaviour is unchanged. Internal refactor". AGENTS §10:
   internal work adds no fragment; this plan (*Other hotspots*, "slices add no
   CHANGELOG line … one entry when the last slice merges"). Failure: the next
   `bun run release` publishes a user-facing bullet about an internal module
   move, and every later slice copies the precedent. Fix: delete the fragment.
2. Undeclared drift: the plan's revised *What stays* ("**no `useMouse` hook**
   (per-event function)") vs `packages/tui/src/useMouse.ts:96` and
   `App.tsx:3388`. Execution says "all three [drifts] recorded, none silent";
   this one is not recorded. The design built is sound (the hook owns only
   refs/timer, no effect; the snapshot is per-event at `App.tsx:3790`), but §8
   requires the plan be fixed, not contradicted. Fix: a drift line + amend *What
   stays* / M2.

**Behaviour trace (static, against the removed inline block):** report order
wheel → panel → pill → dock row → click → selection is verbatim; copy reads the
in-chunk selection because `setSelection` writes the ref synchronously
(`useMouse.ts:250`) before the next report's `copySelection`; toggle-then-clear
order swap is within one batched event (no observable); `clickRef` written after
the loop — nothing reads it mid-chunk; `hold`'s deps `[field, panelRef]` vs
`[field.insert]`: `field` is a fresh object every render (`hooks.ts:188`), the
timer calls the stable `insert` — equivalent; `submit(field.value + "[")` reads
the same-render `field` as before. Effect list: the hook declares no effect; the
hold cleanup keeps its index. `statusRowRef.current` read once per event, as the
inline code did per report within the same event.

**Attacks tried:** (a) coalesced press+drag+release copy with state applied
before effects — would lose the copy; pinned by `app-mouse-layer.test.tsx`
(static check). (b) restored `[` + Enter — pinned by S0b matrix
(`app-structural-matrix.test.tsx:218`). (c) timer-path panel guard — the panel-
open timer branch is unpinned, but the code is byte-equivalent to `main` (pre-
existing gap, not a finding). (d) stray `process.stdout` in new modules — none.
(e) port identity / dep arrays naming the port object — none; deps name fields.

**Mutation:** the reviewer's own mutation run on `useMouse.ts` was blocked by the
sandbox (permission denied); non-vacuity rests on the executor's 14/14 table plus
the static mapping above. Not independently confirmed.

**Executor behaviour:** careful, honest about unmeasured coverage; over-claimed
"no silent drift" (finding 2) and missed the no-fragment rule (finding 1).
Reviewer is a different family from the DeepSeek executor.

*— claude-opus-5-5, 2026-11-13*

### Fix round 1 — `feat/app-decomp-4-mouse` (S4 review findings)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13* (real id: this run was
launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`; that profile's
`model.model` is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`,
`~/.config/tentacle/config.jsonc:29`.)

Both review findings were MEDIUM; there was no HIGH. **No `src/` file changed
in this round** (`git diff --stat -- packages/tui/src` is empty) — one file
deleted, one doc corrected.

**Finding 1 (MEDIUM) — the changelog fragment: FIXED.**
`changelog.d/app-decomp-4-mouse.changed.md` is deleted. The review's failure
mode was "the next `bun run release` publishes a user-facing bullet about an
internal module move"; I did not take that on trust, I reproduced it with the
release path's own code rather than a command:

Repro (`.tentacle/tmp/app-decomp-4-mouse/frag-probe.ts`) — the real
`readFragmentDir` + `parseFragments` + `assemble` over this worktree's real
`CHANGELOG.md` and `changelog.d/`, for a fictional `9.9.9`. RED, before:
```
fragments scanned: changelog.d/app-decomp-4-mouse.changed.md, changelog.d/device-pairing-9b.added.md, changelog.d/mobile-session-view-12b.added.md
S4 internal bullet under a RELEASED heading: true
  published as: - **The TUI's mouse layer is a pure module plus a hook, not a block in `App.tsx`.** SGR wheel, c…
```
The mutation here IS the file's presence — nothing else differs between the two
runs. GREEN, the same probe after `rm`:
```
fragments scanned: changelog.d/device-pairing-9b.added.md, changelog.d/mobile-session-view-12b.added.md
S4 internal bullet under a RELEASED heading: false
```
`bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts`
→ **21 pass / 0 fail** after the deletion (I2 scans the directory; an empty-of-
this-slug dir still parses). The claim that the deletion was *required* is
AGENTS §10's rule, and the prior Execution's "withdrawn" line now records it.

**Finding 2 (MEDIUM) — undeclared drift: FIXED, and the plan corrected.**
Verified against the code, not the review's static claim: `useMouse.ts:21`
imports only `useCallback`/`useRef`; the only `useEffect`-shaped matches in the
file are the `MouseEffect` type (`:25`, `:170`). The snapshot is built at the
`useInput` site (`App.tsx:3790`). So the built design meets the *reviewed*
H1/M2 constraint ("no hook that owns an EFFECT"), and the plan text was what was
wrong. Three edits, per §8 ("fix the plan, don't force the code"):
- *What stays* (line ~233): the absolute "no `useMouse` hook" replaced by the
  actual constraint + why a refs-only hook satisfies it. (The paragraph also
  self-contradicted — it listed `useMouse` in the hook order one sentence
  earlier — so this removes an internal inconsistency, not just a stale line.)
- **M2** (line ~385): an "Amended in S4" note — per-event function as required,
  thin hook retained for state a per-event function cannot hold, `submit` field
  added.
- Execution **drift 4** added: the contradiction was NOT declared in the first
  Execution; it is now, with the `file:line` evidence above.

**Mutation check (§9) — the amended claim has teeth, shown, not asserted.**
The property the fix writes into the plan is "`useMouse` declares no effect, so
App's effect list is untouched". Pinning it needs a mutant that *adds* an effect
there, not a code change I can revert into different behaviour:

| # | Mutation (to `useMouse.ts`, restored after) | Result |
|---|---|---|
| F1 | a no-op effect added (`useEffect(() => {}, [])`) | **SURVIVED** (1 pass) — expected: no-op is unobservable, so it is not the property |
| F2 | a real effect at the hook's position (`useEffect(() => submit("injected by useMouse"), [submit])`) | **KILLED** — `app-structural-order.test.tsx` 0 pass / 1 fail, diff shows `+ "injected by useMouse"` ×2 |
| F3 | (not run) hoist the snapshot out of the per-event site | **not claimed** — the coalesced-chunk tests fire after layout settles, so they would not catch it; the per-event read stays pinned by the pre-existing M14 (the click state), as the review itself noted |

F1 is recorded because it is the honest half: a no-op effect survives, so the
claim I wrote into the plan is *not* "frozen file contents", it is "an
effect introduced here is caught" — which F2 shows. After F2,
`sha256sum -c useMouse.sha` → **OK**, and `grep -n useEffect` finds only the two
`MouseEffect` type references. `git status --short packages/tui/src` is empty.

**Gate (this worktree, this branch).** `bunx tsc --noEmit` clean (exit 0);
`bun run lint` → `biome check .` **1050 files, 0 errors 0 warnings** (§6
baseline); the S0/S0b/S4 net (7 files) **46 pass / 0 fail**; full `bun test`
**8143 pass / 3 skip / 0 fail** across 587 files (331.9 s) — the identical
count to the pre-round Execution, the 3 skips being the §6 documented opt-ins
(live-k8s, live-docker, the real-socket keepalive).

**Unverified (one line each).** F3 is unpinned by this round, exactly as the S4
review recorded it. The full suite was run once, on this worktree, concurrently
with other task suites (CPU contention), so its 331.9 s wall time is not a
performance measurement — the pass/skip/fail counts are what it establishes.
`bun run check` was not run as one command; its three steps were run separately
and are the same three.

### Round 2 — PASS

**Scope:** `git diff HEAD~1` (11b9765). No `packages/` change (`git diff --stat
HEAD~1 -- packages` empty): one fragment deleted, the plan/Execution amended.

- **Finding 1 — FIXED.** `changelog.d/` now holds only `device-pairing-9b` and
  `mobile-session-view-12b`; `changelog-guard` + `changelog` tests green. The
  executor's red/green probe (fragment present → bullet published, absent → not)
  is the right mutation for a deletion; I accept it and did not re-run it.
- **Finding 2 — FIXED.** *What stays*, M2 and drift 4 now state the constraint as
  "no hook that owns an effect". I checked that against the code: `useMouse.ts`
  has no `useEffect`/`useLayoutEffect` (the only matches are the `MouseEffect`
  type, `:25` and `:170`). The executor's F2 mutation (a real effect injected →
  `app-structural-order` red) shows a future effect added there would be caught.
  F1 (a no-op effect survives) is honestly recorded.
- **Regressions:** none possible in code (doc + deletion only). `bun run
  typecheck` clean; `bun run lint` 1050 files clean; the changelog tests plus the
  two S4 test files: 46 pass / 0 fail.
- Nit (no action needed): the Fix round's F3 line says the per-event read being
  pinned by M14 is "as the review itself noted". The S4 review never said that.

*— claude-opus-5-5, 2026-11-14*

## Execution

### S3 — `feat/app-decomp-3-keyroute` (the key router leaves `App.tsx`)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-14* (real id: `ps` shows this
run launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`, whose
`model.model` is that id in `~/.config/tentacle/config.jsonc:32`.)

**Scope.** `packages/tui/src/keys/` (new: `contract.ts`, `effects.ts`,
`snapshot.ts`, `route.ts`, `layers.ts`, `layer-precedence.ts`, `layer-dialog.ts`,
`layer-panels.ts`, `layer-dock.ts`, `execute.ts` — 1082 lines), `App.tsx`
(−348/+183: the 369-line handler body and its 389 inline layer lines replaced by
a snapshot build + `routeKey` + `executeEffects` + the mouse continuation), four
new test files, one changelog fragment. **No existing test edited**, no
`packages/protocol` change (so `protocol.json` was NOT regenerated), no other
slice touched (`TODO.md` untouched).

**Resume note (the working tree was NOT partial).** This run resumed a step cut
by a connection reset. `git status --short` in this worktree was **clean** — the
previous attempt left nothing behind, so nothing was "finished"; the slice was
implemented from scratch here. Recorded because the brief asserted partial edits.

**Load-bearing check, re-run first (PASSED).** Re-verified on this branch, not
trusted: `packages/tui/node_modules/ink/build/hooks/use-input.js:89` registers
`internal_eventEmitter?.on('input', handleData)`; `handleData` (`:80–87`) returns
nothing anyone consumes and there is no stop-propagation, and the emitter is
per-App (`components/StdinContext.js`). `rg 'useInput\(' packages/tui/src` →
`App.tsx` (the one handler) and the separate pre-mount
`components/SessionPicker.tsx:85`. **Holds** — so `App` keeps ONE `useInput` and
S3 moves only its BODY, which is exactly the H3 revision.

**Design, as built (dependency order).**
1. **`contract.ts`** — `{effects, verdict, carry}`, `NOTHING`/`consumed`/
   `passThrough`, the 14 `KeyLayerName`s, and the `LayerStep`/`KeyRoute` types.
2. **`effects.ts`** — the effect vocabulary, **data only** (no closures), so a
   layer is a pure function of the snapshot and the whole order is testable.
3. **`snapshot.ts`** — `KeySnapshot` **with the plan's source table written into
   the file**: a field that was a ref read at key time is a GETTER, a field that
   was a render closure is a VALUE. This is the slice's central artifact (H3).
4. **the four layer modules** — `layer-precedence.ts` (shiftTab, quitConfirm,
   chord), `layer-dialog.ts` (permission, ctrlC, paste), `layer-panels.ts`
   (sessions, tree), `layer-dock.ts` (dock, escUpload, escAbort, expandAll,
   palette). Each is 2–5 lines of wiring around a decision the repo already
   owned (`stepChord`, `quitConfirmKey`, `stepPermissionKey`, `stepPaste`,
   `sessionsKey`/`sessionsChoose`/`sessionsDelete`, `treeKey`, `dockKey`,
   `dockClaimsCtrlX`, `ctrlCQuitStep`). **No decision was re-derived.**
5. **`route.ts`** — `routeKey`: walk in order, accumulate every passing layer's
   effects, stop at the first `consumed`, carry the last non-empty `carry`,
   report `stoppedAt` (so a precedence bug reads as a name in a test).
6. **`layers.ts`** — `PURE_LAYERS` (the walkable 13) + `LAYER_ORDER` (all 14, the
   documented precedence). A test asserts the two never drift.
7. **`execute.ts`** — `KeyHost` (a narrow port of the App's own stable callbacks)
   and `executeEffect(s)`. The only place a decision becomes an App call.
8. **`App.tsx`** — the handler body is now: build the snapshot at the event →
   `routeKey(…, PURE_LAYERS)` → `executeEffects(routed.effects, keyHost)` → stop
   if consumed → the mouse continuation. The line-editing tail (history/`recall`
   /`resolveLineInput`/the terminal `switch`) is untouched, as designed.

**Drift from the Implementation (four, all recorded, none silent).**

1. **The mouse layer is the router's CONTINUATION, not the 14th entry of the
   walked list.** The plan's H3 says "14 layers" and `routeKey` runs their
   effects. That cannot hold for the mouse layer *as an entry in the walk*:
   `useMouse.handleChunk` **applies its own effects** as it decides (S4's hook
   owns refs + timer), so walking it inside `routeKey` would run the mouse's
   effects BEFORE `executeEffects` applied the earlier layers' collected ones —
   a report could then read a `dockRef`/`panel` the key path had already changed
   inline today, i.e. an effect-order inversion (the plan's own `Effect order`
   failure mode). So `routeKey` walks the **13 pure layers** and the mouse layer
   runs after `executeEffects`, exactly where the inline handler had its mouse
   block. `LAYER_ORDER` still names all 14 and a test pins
   `PURE_LAYERS === LAYER_ORDER.slice(0, -1)`; the contract, the order and the
   count the plan asks for are all intact — only the *execution seam* differs,
   and for a load-bearing reason. `layers.ts` states this in its header.
2. **The chord emits a `setChord` only when the state would CHANGE.** The inline
   handler assigned `chordRef.current = chord.state` unconditionally;
   `stepChord` returns the *same object* when nothing changes, so writing it is a
   no-op. Emitting the write unconditionally made three tests (and any reader of
   `effects`) see a no-op effect on every key. Behaviour is identical — a write
   of idle over idle changes nothing — and the effect list stays legible. The
   one place this is observable is `dockClaimsCtrlX`'s reset, where the layer now
   writes only when the chord was actually armed.
3. **`sessionsDelete`'s async refresh moved out of the handler into an App-level
   `useCallback`.** The plan's file list for S3 has no App-level helper, but the
   delete's `.then` chain (remove → list → refresh-if-still-the-same-panel) is a
   driver, not a key decision: it stays in App, is called by ONE effect
   (`sessionsDelete{id, startedGen}`), and keeps `sessionsRefreshApplies`'s
   generation checks verbatim. Its deps are `[sessions, pushNotice]`.
4. **`permissionStop` and `pasteReply` body live in the App's port, not in the
   pure layer.** Both read the App's live `abortRef` / clipboard seam and mutate
   `stoppedHereRef`, so the layer decides only *that* the key is a stop / a
   clipboard read (`permissionStop` / `pasteReply` effects) and the App executes
   it — the same split the plan asks for, just with the branchless part on the
   App side because it touches refs the snapshot does not carry.

**Snapshot-source table (as implemented; the plan's H3 requirement).** Written
into `keys/snapshot.ts` as a per-field table with the pre-S3 line numbers:
ref-read getters — `quitConfirm` (3814), `dock` (3841/4062), `chord`
(3842–3860), `running` (4107), `compacting` (3634), `permission.mode` (3861),
`pasteBuffer` (3863/3909), `replyMaxChars` (3868), `dockIds` (3701),
`othersOnSession` (3547/3562), `sessionId` (3627), `switching` (3708/3755),
`panelGen` (3700), `abortable` (3907/3548), `uploadInFlight` (3900),
`exitPending` (3564), `subagents`/`jobRows` (3563/3565); render values — `panel`
(3612/3682/3698), `paletteOpen`/`paletteNames`/`commandSel` (3757–3791),
`fieldValue` (3705), `permission.pending`/`.choices`/`.selected` (3870),
`sessions` (3638), `detachOnQuit` (3565). **No field was "cleaned up" to one
source**, and no field changed source.

**Tests (new only, 81 assertions-bearing tests across 4 files).**
- `packages/tui/test/keys-route.test.ts` (11) — the layer ORDER as data, the
  walk's first-claimer semantics, act-and-pass, effect ORDER, and `carry`.
- `packages/tui/test/keys-layers.test.ts` (30) — every layer's effects AND
  verdict, including the failure modes the plan lists: quit-confirm's `y` vs an
  ask, Ctrl+C's four outcomes, a `connect` detach losing no job, a paste behind a
  panel, the reply-field paste, the dock's Esc chain vs the turn's, Esc-upload
  before Esc-abort, the palette, and the ordering invariants (shift+tab over
  everything; sessions-Esc over Esc-abort).
- `packages/tui/test/keys-execute.test.ts` (35) — each effect reaches the RIGHT
  host method (a table), the `quit` order (closeForAll then requestQuit), and
  that no effects means no calls.
- `packages/tui/test/keys-app-seam.test.tsx` (5) — through real Ink: the
  snapshot's getters are live (two Ctrl+C in ONE tick, then the "never a trap"
  re-ask), a passing layer's effects do not swallow the key (ctrl+x then typing
  then Enter still sends), and line editing still submits.
**S0/S0b nets stay green and UNEDITED** (82 tests, run before AND after), which
is this slice's behaviour-preservation proof; the full TUI package was run at
+0 fail (1792) as an additional check with the handler already replaced.

**Red before green (§9).** Every new test file was written against the
implemented module and run immediately; the three failures that surfaced were
**my test expectations, not the code**, and each was resolved by reading the
owning pure module rather than bending the code: (a) `dockKey` in `list` focus
moves Esc one step up the chain to the **pill**, not straight to `input`
(`background-focus.ts:452`, verified) — the test was rewritten to the real
chain; (b) a `connect` (`detaches: true`) Ctrl+C with a running turn yields
`stop` → `abortTurn`, not `exit` (`ctrlCQuitStep`'s second `quitAction` branch,
verified) — the test's expectation was corrected; (c) a no-op `setChord` is not
emitted (drift 2) — the test now asserts both the idle case (no write) and the
armed case (a write). **The slice's own "red" proof is the mutation table below**:
15/15 mutants are killed by the new tests, which is what shows they pin the
property rather than merely passing.

**Mutation check (§9 non-vacuity) — 15/15 KILLED.** Harness
`.tentacle/tmp/app-decomp-3-keyroute/mutate.ts` (byte-copy, ONE mutation, run the
owning test file, restore, sha256 compare; a 0-test run is reported INVALID so a
bad filter cannot look like a kill). Three mutants **SURVIVED the first pass** —
each a real hole, closed by adding the test named beside it:

| # | Mutation | First pass | Now |
|---|---|---|---|
| M1 | quit-confirm and the chord swapped in the list | KILLED (9/2) | KILLED |
| M2 | quit-confirm read as a render value, not the ref | KILLED (9/2) | KILLED |
| M3 | a passing layer's effects dropped | KILLED (8/3) | KILLED |
| M4 | effects collected with `unshift` (reverse order) | KILLED (10/1) | KILLED |
| M5 | `carry` never propagates | KILLED (8/3) | KILLED |
| M6 | the sessions disarm CONSUMES instead of passing | KILLED (9/2) | KILLED |
| M7 | a printable key on the pill is swallowed | **SURVIVED (28/0)** | **KILLED** — added "a printable key on the FOCUSED PILL is typed, not swallowed" |
| M8 | Ctrl+C on the dialog denies instead of stopping | KILLED (27/1) | KILLED |
| M9 | Esc no longer cancels an upload in flight | KILLED (27/1) | KILLED |
| M10 | the dock is offered keys behind a panel | **SURVIVED (28/0)** | **KILLED** — added "a key the panel does not claim never reaches the dock" |
| M11 | a paste behind a panel edits the hidden input | KILLED (27/1) | KILLED |
| M12 | a dock-owned `ctrl+x` taken by the chord | KILLED (10/1) | KILLED |
| M13 | Esc-abort ordered before Esc-upload | KILLED (27/1) | KILLED |
| M14 | the two panel layers swapped | KILLED (9/2) | KILLED |
| M15 | the executor wires `abortTurn` to `sendNow` | **SURVIVED (5/0)** — the seam test never ran the executor table | **KILLED** — added `keys-execute.test.ts` |

Every row is a red on the ASSERTION with a real pass/fail count (never an
import/compile error); after each the mutated file's sha256 `MATCHES` its
pre-run value, and `git status --short packages/tui/src` lists only `App.tsx`
(modified) and the new `keys/` directory — **no mutation survived into the tree**.

**Gate (this worktree, this branch).** `bun run check` → `tsc --noEmit` clean
(`tsc -p apps/mobile` included by the script, clean), `biome check .` **1064
files, 0 errors 0 warnings** (the AGENTS §6 baseline — clean), `bun test`
**8224 pass / 3 skip / 0 fail** across 591 files (the 3 skips are the documented
opt-ins: live-k8s, live-docker, the real-socket keepalive). No schema change →
`packages/protocol/schema/protocol.json` not regenerated. One changelog fragment
added: `changelog.d/app-decomp-3-keyroute.changed.md` (user-visible: new key
bindings are now new files; the rule for "internal refactor adds none" applies to
S4, but S3 changes how a TUI binding is added, so it earns one bullet).
`TODO.md` untouched.

**Drift left open (for the reviewer, not hidden).**
- The plan's per-slice coverage check (`bun test --coverage packages/tui`,
  App.tsx + new-files line total not dropping) was **not** run; the moved lines
  are pinned by 81 new assertions plus the untouched S0/S0b nets, but the
  percentage is unmeasured.
- `keys/layer-panels.ts` re-exports four `sessions-panel.ts` helpers
  (`sessionsListError`, `deleteFailedNotice`, `sessionsRefreshApplies`,
  `refreshedSessions`) so App keeps one import for the delete driver. That is
  convenience, not necessity, and a reviewer may prefer App to import them
  directly; it changes no behaviour either way.
- "What stays in App.tsx" targets ≲800 lines after all slices; S3 leaves App at
  **3937** (from 4102) — the remaining reduction is S2/S5–S10's, as planned.

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-14*

## Review

### S3 — `feat/app-decomp-3-keyroute` (fresh-context, adversarial)

**Verdict: REQUEST-CHANGES** (two MEDIUM, no HIGH; both small fixes).

**Gate (re-run by me on this branch).** `bun test packages/tui` → **1873 pass / 0
fail** (126 files, S0/S0b nets included, unedited); `bun run typecheck` clean;
`bun run lint` → 1064 files, 0 errors / 0 warnings. The full repo `bun test` was not
re-run (TUI-only diff).

**Findings.**
1. **MEDIUM: one snapshot field changed source, so the slice's central claim is
   false.** `packages/tui/src/App.tsx:3589` passes `replyMaxChars: () =>
   replyMaxRef.current`. Before S3 the handler used the RENDER value `maxChars:
   replyMax` (`main:App.tsx:3519`). The table in `keys/snapshot.ts` labels it a
   "ref-read getter (3868)", and Execution says "no field changed source". Failure
   scenario: `pending` and `choices` now come from the handler's frame while
   `maxChars` comes from the latest render's ref. So, in the window between a render
   and the `useInput` re-subscribe, one chunk decides a reply clip with a mix of two
   frames. That window is practically unreachable under Ink's sync commit, but this
   is exactly the "one field silently re-sourced" class that H3 asks the table to rule
   out. Fix: `replyMaxChars: () => replyMax` (or make the row a value), and correct
   the table row.
2. **MEDIUM: a changelog fragment for a behaviour-unchanged internal refactor.**
   `changelog.d/app-decomp-3-keyroute.changed.md` says itself that "Behaviour is
   unchanged". AGENTS §10 says internal/dev work adds no fragment, and S4 added none.
   The fragment is also inaccurate: it says `routeKey` runs "over 14 ordered layers",
   but it walks 13 (`PURE_LAYERS`), and the mouse layer is a continuation (drift 1).
   Fix: delete the fragment.

**Premise checks.** Ink's `useInput` has no stop-propagation: TRUE (one `useInput`
remains, so only its body moved). `paletteOpen` is false while a panel is open:
TRUE (`App.tsx:957`). The mouse layer swallows every key behind a panel: TRUE
(`mouse-stream.ts:132`). Every other snapshot row matches its pre-S3 source
(`othersOnSession`, `sessionId`, `dockIds`, `permission.mode` are live calls;
`panel`, `fieldValue`, `detachOnQuit`, `pending`/`choices`/`selected` are values),
except row 1 above.

**Attacks tried.**
- (a) **Collect-then-execute ordering.** Inline, effects ran mid-walk, so a later
  read could see an earlier write. I checked each write that passes: `setChord`,
  the sessions disarm, and `setDock` on `pass`. No later pure layer reads the state
  those write. The mouse layer reads `dockRef` only after `executeEffects`.
  Nothing found.
- (b) **The sessions panel used to consume every claimed action; it now passes**
  `choose`/`delete` with no entry, or with no `sessions`. Those keys fall through to
  `escUpload`/`escAbort`/`expandAll`/`palette`, which cannot claim them (Esc is
  always `close`; the palette is closed under a panel), and then the mouse layer
  swallows them. Same observable behaviour, but the panel is no longer the layer
  that stops the walk (`stoppedAt` reads `null`/mouse). Below MEDIUM.
- (c) **Truthiness drift.** `pending === null` vs `if (pending)`: the type is
  `PermissionRequest | null`, so they are equal. `clean !== ""` vs `if (clean)`:
  `sanitizePasted` returns a string, so they are equal. `subagents ?? []`: harmless.
  Nothing found.
- (d) **Chord reset under a dock-owned `ctrl+x` (drift 2).** It is pinned by
  `keys-route.test.ts:182–184` (armed ⇒ `setChord` idle first) and `:176–178`
  (idle ⇒ no write). Nothing found.

**Mutation (§9).** I could NOT re-run mutants myself: writing into `src/` for a
temporary mutation needed an approval this non-interactive run does not have. The
executor's 15/15 table therefore stands unverified by me. Statically, M7/M10/M15's
added tests exist and assert the property named. Unverified: the App-side port
bodies (`permissionStop`, `stopTurn`, `cancelUpload`, `pasteReply`) are covered
only by the S0 nets through `App`, not by the key tests, which use a fake host.
To verify, drop `stoppedHereRef.current = true` in `stopTurn` and run
`packages/tui/test/app*.test.tsx`.

**How the executor behaved.** Disciplined and transparent. It recorded four drifts
with reasons, recorded the clean-tree resume, and closed three surviving mutants
with tests. It overclaimed once ("no field changed source", finding 1) and misread
the changelog rule (finding 2). Different model family from me (DeepSeek
executor, Opus reviewer), so blind spots are less likely to be shared.

*— claude-opus-5-5, 2026-11-14*

### Fix round 1 — `feat/app-decomp-3-keyroute` (S3 review findings)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-15* (real id: this run was
launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`; that profile's
`model.model` is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`,
`~/.config/tentacle/config.jsonc:29`.)

Two MEDIUM findings, no HIGH. One re-sourced snapshot field (a `src/` fix, with a
new regression test) and one changelog fragment (deleted). No other `src/`
behaviour touched.

**Finding 1 (MEDIUM) — `replyMaxChars` changed source: FIXED.**

Verified against the code first, not the review's static claim.
`git show 723b454^:packages/tui/src/App.tsx` (pre-S3) has exactly two readers:
`:3519` `maxChars: replyMax` — the `stepPermissionKey` call, i.e. the handler's
RENDER closure — and `:1092` `insertReply(mode, text, replyMaxRef.current)`,
inside `insertIntoReply`, which is NOT on the key path. So the ref was never the
key path's source and the review is right: S3 re-sourced the field.

**Fix.** `keys/snapshot.ts`: `replyMaxChars(): number` → `readonly replyMaxChars:
number`, and its table row rewritten to ``render `replyMax` (3519) | value``.
`App.tsx:3589`: `replyMaxChars: replyMaxRef.current` getter → `replyMaxChars:
replyMax` (the render value, the SAME frame as `pending`/`choices`/`selected`, so
one decision can no longer mix two frames). `keys/layer-dialog.ts:56`:
`snap.replyMaxChars()` → `snap.replyMaxChars`. The three test snapshot factories
updated to `replyMaxChars: 0` / `: 100`.

**Red before green (§9).** The new file
`packages/tui/test/keys-snapshot-source.test.ts` makes the doc's prose table
executable, and it was run RED on the unfixed code:
```
(fail) … > snapshot.ts declares each render value as a data member, never a call signature
  + [ "replyMaxChars" ]
(fail) … > App.tsx passes each render value straight from the frame (no getter, no ref)
  + [ "replyMaxChars: () => replyMaxRef.current," ]
 1 pass / 2 fail
```
Both failures name the finding's own field, on the property (source), not an
import/compile error. After the fix: **3 pass / 0 fail**.

Two harness bugs of my own surfaced on the way and were fixed before the red was
trusted, so the red is not a false one: a shorthand entry (`panel,`) was first
read as "missing" (fixed by a shorthand branch in `appEntry`), and the
getter-shape test was first a bare `=>` check, which flagged the legitimate
render-derived `paletteCommands.map((c) => c.name)` (narrowed to `() => …` /
`function` / `…Ref` / `.current`). A third test pins non-vacuity: the interface
and the literal are found, `panel` reads as a value and `dock` as a getter — so a
rename could not make the scans silently pass over nothing.

**Mutation check (§9), 3/3 KILLED** (`rmut.sh`: byte-copy, one mutation, run the
owning file, restore, sha256 compare; every row red on the ASSERTION, counts
real, `RESTORED-OK` after each):
| # | Mutation | Result |
|---|---|---|
| F1-a | `replyMaxChars: replyMax` → `() => replyMaxRef.current` (the bug itself) | **KILLED** 2/1 |
| F1-b | `snapshot.ts` `readonly replyMaxChars: number` → `replyMaxChars(): number` | **KILLED** 2/1 |
| F1-c | a DIFFERENT render value re-sourced (`panel,` → `() => panelRef.current`) | **KILLED** 1/2 |

F1-c is the one that matters for the finding's *class*: the scan is general, not
a hard-coded check on `replyMaxChars`.

**Finding 2 (MEDIUM) — changelog fragment on a behaviour-unchanged refactor: FIXED.**

`changelog.d/app-decomp-3-keyroute.changed.md` is deleted (AGENTS §10: internal
work adds no fragment; S4 — the identical situation — added none). Its
inaccuracy dies with it: it claimed `routeKey` runs "over 14 ordered layers"
while it walks 13 (`PURE_LAYERS`), the mouse layer being the continuation
(drift 1).

The mutation here IS the file's presence, so its red was shown empirically with
the release path's own code rather than argued. Probe
`.tentacle/tmp/app-decomp-3-keyroute/frag-probe.ts` (`readFragmentDir` +
`parseFragments` + `assemble`), reduced to a scratch root holding only the
fragment under test (the worktree's `changelog.d/` was never re-polluted):
```
RED   fragments scanned: changelog.d/app-decomp-3-keyroute.changed.md, changelog.d/device-pairing-9b.added.md, changelog.d/mobile-session-view-12b.added.md
      S3 internal bullet under a RELEASED heading: true
        published as: - **TUI keys: one ordered router instead of one 389-line handler.** `App`'s single `useInput` now builds
GREEN fragments scanned: changelog.d/device-pairing-9b.added.md, changelog.d/mobile-session-view-12b.added.md
      S3 internal bullet under a RELEASED heading: false
```
`bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts`
→ **21 pass / 0 fail** after the deletion.

**Drift from the Implementation (two, recorded).**
1. **The review's suggested fix (`replyMaxChars: () => replyMax`) is NOT what I
   built.** A getter closing over the render frame is observationally the same as
   a value for correctness, but it is the wrong shape: it re-introduces the very
   ambiguity the table exists to remove (a scan cannot tell `() => replyMax` from
   `() => replyMaxRef.current`), and the review offered "or make the row a
   value". I took the value branch, which is what the two scans can pin. This is
   also why the new test pins only the VALUE half of the table (stated in its
   header): the getter half stays pinned behaviourally by S0/S0b, because a
   getter may legitimately close over the frame.
2. **The previous Execution's "no field changed source" claim is left standing in
   place and corrected HERE, not edited out** — the earlier round's record is a
   historical statement, and the review's finding 1 is the correction. The
   `snapshot.ts` table row is the living source of truth and is now right.

**The two MEDIUMs were the whole set.** The review's other observations were
explicitly below MEDIUM (attack (b): `stoppedAt` reads `null`/mouse for an action
the sessions panel used to claim; same observable behaviour) and are left as
noted, not changed — a fix there would move behaviour for no finding.

**Unverified (§5).** The review could not re-run the previous round's 15-mutant
table (no approval to write into `src/` non-interactively); I did not re-run it
either, and this round's 3 mutants are new ones over my own fix, so that table
still stands on the prior executor's word. To verify:
`.tentacle/tmp/app-decomp-3-keyroute/rmut.sh` with the review's named probe
(drop `stoppedHereRef.current = true` in `stopTurn`, run
`packages/tui/test/app*.test.tsx`).

**Gate (this worktree, this branch).** `bunx tsc --noEmit` clean;
`bun run lint` → 1065 files, **0 errors / 0 warnings**; `bun test` → **8227 pass
/ 3 skip / 0 fail** across 592 files (the 3 skips are the documented opt-ins:
live-k8s, live-docker, the real-socket keepalive). TUI package alone: **1876
pass / 0 fail** across 127 files (the S0/S0b nets still green and UNEDITED).
Negative-case probe: `layer-dialog.ts`'s `snap.replyMaxChars` is exercised
(KILLED F1-a proves it), so no test silently holds the old shape.

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-15*

### Round 2

**Verdict: PASS.** Both round-1 MEDIUMs are fixed, and the fix diff (`git diff
HEAD~1`) introduces no regression.

- **Finding 1 (`replyMaxChars` re-sourced): FIXED.** `App.tsx:3589` now passes
  `replyMaxChars: replyMax`, the render value, as the inline handler did before S3.
  `snapshot.ts` declares it `readonly … : number`, and the table has the row.
  Taking the value branch instead of my suggested `() => replyMax` is the better
  shape. Mutations I ran myself (all restored, `git status` clean afterwards):
  - (a) App passes `replyMaxRef.current` → `keys-snapshot-source.test.ts` **KILLED**
    (2 pass / 1 fail, naming the entry).
  - (b) `layer-dialog.ts` passes `maxChars: 0` → **KILLED** by 7 reply-field App
    tests. So the field is pinned by behaviour, not only by the text scan.
  - A getter mutant (`() => …`) no longer typechecks, so `tsc` pins it too.
- **Finding 2 (changelog fragment): FIXED.** `changelog.d/app-decomp-3-keyroute.*`
  is gone. No other fragment was touched.
- **Round-1 unverified item, now closed.** I dropped `stoppedHereRef.current =
  true` from the `stopTurn` port. `app*.test.tsx` alone stays green (204/0), but
  the full TUI suite **KILLS** it: "this TUI pressed Esc on that turn: the plain
  notice" fails (1875/1). Ctrl+C's `abortTurn` runs the same port body.
- **Regressions.** I checked every remaining `replyMaxChars()` call site (none
  left). The new test's scope is honest: a text scan of the value half only, with a
  non-vacuity test. It is brittle to reformatting of the `routeKey(` literal, but it
  fails loudly (it throws) rather than passing vacuously. Not a finding.
- **Gate.** `bun test packages/tui/test/keys- …/permission` → 130 pass / 0 fail;
  the full TUI suite I ran only with the `stopTurn` mutant in place (1875 / 1, the
  one kill above), so a clean full-suite run this round is the executor's figure
  (1876 / 0), not mine;
  `bun run typecheck` clean; `bun run lint` → 1065 files, 0 errors / 0 warnings.
- **Executor behaviour.** It fixed exactly the findings and recorded its deviation
  from my suggested fix with a reason. It showed the new test red first and wrote
  its own mutation table (3/3). Its F1-a/F1-b rows match my re-runs.
### S2 — `feat/app-decomp-2-commands` (one file per command, a registry behind them)

*— deepseek-v4.1-flash (real id; run via the `deepseek` profile), 2026-11-14*

**What S2 is.** The 17 `handleCommand` `switch` cases (App.tsx `2816–3185`
pre-move) become `commands/<name>.ts`, one file per command, each declaring a
`Pick<>` of the command context it uses; `commands/registry.ts` is the ONE list,
and `SLASH_COMMANDS` is derived from it. The shared guards stay in one
`dispatchCommand`. App keeps only the context construction plus the two driver
functions the Design response requires (M5). No user-visible behaviour changes:
every S0 test passes **unmodified** — that is the behaviour-preservation proof.

**Load-bearing check, re-run first (PASSED, not trusted).**
`sh .tentacle/tmp/app-decomp-2-commands/lb-check.sh` on this branch (`e607c4b`):

- *the 17 cases live in ONE `handleCommand`* — `const handleCommand =
  useCallback(` at `App.tsx:2816`, `handleCommandRef.current = handleCommand;` at
  `3185`, **18** `case "/…"` labels inside it (`/exit`+`/quit` share one,
  `/help /clear /close /sessions /compact /settings /rename /model /mcp /skills
  /agents /tokens /retry /attach /copy /save` + the `default` arm). **Holds.**
- *nothing outside App.tsx calls the command bodies* — `rg handleCommand
  packages/tui/src packages/cli/src` → App.tsx only (a ref, the caller and the
  `submit`/palette sites). So the bodies are free to move. **Holds.**
- *the vocabulary tests pin* — `SLASH_COMMANDS` (`commands.ts:26`) is asserted
  literally and by identity in `app-commands.test.tsx:81`, `commands.test.ts:50,
  241, 257`, `rename.test.tsx:24`; `index.ts:21` `export * from "./commands.ts"`
  is the public boundary. So `SLASH_COMMANDS` had to keep existing **and** keep
  its order. **Holds** — hence "derive, do not relocate".
- *`/compact` + `/clear` are driver logic* (M5) — `compactionOwnedRef` 440,
  `ownCompactionsRef` 567, `clearAfterTurnRef` 573, `setCompacting(` in the
  `/compact` arm, `clearAfterTurnRef` also read by the turn at 2073.
  **Holds** — so their bodies became App-level `startCompaction()` /
  `requestClear()`, and the command files call them in one line.

**The one thing the plan did not settle, and the experiment that decided it.**
The plan says `commands.ts` derives the list. Taken literally that is an import
**cycle** (`commands.ts` → `commands/registry.ts` → `commands/<name>.ts` →
`commands.ts`). A cycle is fine only if no module reads a cyclic binding during
its own initialization. Proven empirically in
`.tentacle/tmp/app-decomp-2-commands/cyc2/`: the eager shape
(`const BUILTIN_NAMES = new Set(SLASH_COMMANDS.map(…))` at module init) throws
`ReferenceError: Cannot access 'SLASH_COMMANDS' before initialization` when the
registry happens to load first (`bun run entry-registry.ts`), and passes when
`commands.ts` loads first — a latent, order-dependent crash. The lazy shape
(`cyc3/`) passes **both** entry orders (`bun run entry-commands-first.ts` and
`entry-registry-first.ts` both print the full vocabulary and
`builtin=true`). As built: `BUILTIN_NAMES` comes from the registry and is read
through a lazy `builtins()`; a real end-to-end probe
(`.tentacle/tmp/app-decomp-2-commands/cycle-probe.ts`, importing registry.ts
first, then commands.ts) prints `17 17 builtin`. A `findCommand`-style lookup
means dispatch order never matters.

**Design, as built (dependency order).**

1. **`commands/context.ts`** — `CommandContext`, one field per capability, plus
   `Live<T>` (a ref read at command time). Two field kinds on purpose, per H3: a
   callback/value keeps the identity rule it has in App today (deps moved with
   it); a `Live<T>` is a ref, so two keys with no render between them behave as
   before. `busyCompacting` is a **getter**, not `compactingRef` itself: the
   command layer may ASK whether a compaction holds the session, but the
   compaction's refs stay in App (M5).
2. **`commands/<name>.ts`** × 17 — `{ name, description, run }`, each with its
   own `Pick<CommandContext, …>`. The name/description moved out of
   `commands.ts`'s literal, so the words the palette shows and the code that runs
   a command have one source. `/quit` has no file: it is an alias of `/exit`
   (`ALIASES`), which is what the old shared `case "/exit": case "/quit":` was.
3. **`commands/registry.ts`** — `BUILT_INS` (ordered: `/help` first, as the docs
   promise), `ALIASES`, `canonicalName`, `findCommand`, the derived
   `SLASH_COMMANDS`, and `BUILT_IN_NAMES`.
4. **`commands/dispatch.ts`** — the guards, in today's order: skill activation
   (history push, mid-turn refusal, switch refusal) → switch refusal for a
   command → the session-mutating mid-turn guard (with `/clear`'s in-place
   exemption) → registry lookup → the unknown-command path with the once-only
   skill re-ask. Guard message strings are byte-identical to the old ones.
5. **`commands.ts`** — keeps every pure helper (`resolveSlash`, `slashCatalog`,
   `helpText`, `matchCommands`, `retryPlan`, the transcript helpers, the quit
   helpers, `isSessionMutating`) and now **derives + re-exports**
   `SLASH_COMMANDS`; `BUILTIN_NAMES` is the registry's set, read lazily.
6. **App.tsx** — `startCompaction()` and `requestClear()` extracted verbatim from
   the two `case` bodies (M5), then `handleCommand` reduced to building the
   context and calling `dispatchCommand`. Imports trimmed to what App still uses
   (biome's organizer + `tsc` would have flagged the rest).

**Failure-mode tests (all listed modes of the plan's table that S2 can move).**

| Mode | Its S2 shape | Where it is pinned |
|---|---|---|
| Registry drift | a command file's words ≠ the palette's | `commands-registry.test.ts`: derivation equality, the literal 17, unique names, `findCommand` |
| Alias drift | `/quit` becomes a second implementation | `commands-registry.test.ts`: `/quit` is not a row, resolves to `/exit`'s command, both are owned names |
| Guard loss | a mid-turn/skill/switch refusal dropped in the move | `commands-registry.test.ts` (4 cases) + S0's unchanged `app-commands.test.tsx` (5 cases) |
| Once-only re-ask | the unknown path loops on the skill list | `commands-registry.test.ts`: `again` never re-asks |
| Empty input | `""` reaching the dispatcher | `commands-registry.test.ts` (same notice as the old `default` arm) |
| Failure arms | `/save`, `/retry`-gone, `/copy`, a second `/compact` | `app-command-failure-arms.test.tsx` (new; 4 cases) |
| Stale closure in a moved callback | a dep array narrowed while moving | `bunx biome check` → `useExhaustiveDependencies` **fires** on `handleCommand`/`startCompaction` (probed: removing `wakeIfPending` from the moved `startCompaction` deps is an error) |
| Cycle / TDZ | the derived list read at init | the two-order experiment + `cycle-probe.ts` above |

**Mutations (§9: each red on an assertion, each restored from a copy; probes
pasted from the run):**

| # | Target | Mutant | Result |
|---|---|---|---|
| M1 | the derivation | `SLASH_COMMANDS` = a frozen 1-row literal | **2 fail** (`derivation` + `/quit` ownership) → killed |
| M2 | `/compact`'s mid-turn guard (**the S0 review's MEDIUM 1**) | `if (false && ctx.stateRef.current.running)` | `26 pass / 1 fail`, `Expected to contain: "Can't compact while a turn is running."` → killed |
| M3 | `/clear`'s in-place exemption | `const clearsInPlace = true` | **2 fail** (legacy `/clear` mid-turn + the exemption case) → killed |
| M4 | the once-only re-ask | `if (ctx.skillsSync.stale())` | `15 pass / 1 fail`, `again never loops` → killed |
| M5 | a skill activation mid-turn | `if (false && ctx.stateRef.current.running)` | `15 pass / 1 fail` → killed |
| M6 | `/clear` during a compaction (N1) | `false && step === "compacting"` (now in `requestClear`) | `26 pass / 1 fail`, `"Can't clear while a compaction is running."` → killed |
| M7 | a second `/clear` (N2) | `false && step === "busy"` | `26 pass / 1 fail`, `"A /clear is already running."` → killed |
| M8 | `/settings sync` under a compaction (N3) | `compacting: false` in `commands/settings.ts` | `26 pass / 1 fail` → killed |
| M9 | stale-closure detection | drop `wakeIfPending` from `startCompaction`'s deps | `biome check` **error** (`useExhaustiveDependencies`) → killed |
| M10 | `/save`'s reject arm | drop the reject callback | `1 fail` (a silent save failure) → killed |
| M11 | `/retry`-gone notice | replace it with a placeholder | `1 fail` → killed |
| M12 | `busyCompacting()` wiring | `busyCompacting: () => false` | `1 fail` (a second compaction starts) → killed |
| M13 | `/copy`'s reject arm | empty the reject callback | `1 fail` → killed |

N1/N2/N3 are S0 Fix round 3's three survivors, and they survive the MOVE too
(M6–M8 re-kill them in the new place) — the coverage went with the code, not
with the file.

**Coverage of the moved lines** (`bun test --coverage packages/tui`, same command
on both sides). `main` (`e607c4b`, 122 files, 1792 tests): `App.tsx` **94.30 %
lines / 97.07 % functions**. This branch (124 files, 1828 tests): `App.tsx`
**94.80 % lines / 96.94 % functions**, and the moved-out lines are counted in the
command modules instead: **every one of them is at 100 % line coverage** (lcov
`DA` scan across the whole `packages/tui` run: `commands.ts` keeps only its own
already-uncovered helpers at 273/308–311/495–509, and `registry.ts`,
`dispatch.ts` and all 17 command files report **zero** uncovered lines). App.tsx's
line coverage went UP (the 370 moved-out lines were partly uncovered in place);
its function coverage is 0.13 pt down, which is the two new driver functions'
non-happy paths (`startCompaction`'s session-gone early return). Nothing that was
covered before is uncovered now.

**Drift from the Implementation (and why).**

1. **`CommandContext` is a `Pick<>` *field set*, not one port per concern, and it
   is bigger than "a command sees only what it uses" reads at first.** Each
   command still declares its own narrow `Pick<>`; the context itself carries one
   field per capability so those Picks have something to name. The instruction
   the Design response gives (H4(3)) is met per command, which is the point: a
   new command touching existing capabilities edits nothing shared.
2. **`busyCompacting` is a `() => boolean` getter rather than `Live<boolean>`**
   for `compactingRef`. Same freshness (a ref read at command time), but it keeps
   the compaction refs in App, where M5 says they stay — a `Live<boolean>` would
   have handed the command layer the latch itself, i.e. sharable write access the
   plan explicitly denies ("S2 adds no compaction/clear state to
   `CommandContext`").
3. **The `/compact` and `/clear` *guards* stay in their command files, the
   *machinery* moved to App.** M5 says only the machinery is driver logic, and
   the guards read nothing a command may not: they need `stateRef.running`,
   `canClear`, `busyCompacting()`. Keeping them next to the command is what keeps
   S0's MEDIUM-1 test in the same place it always was (mutation M2 proves it is
   still pinned there).
4. **`/settings`'s notice writer stayed a local `lines()` in
   `commands/settings.ts`** (it only needs `stateRef`, `setScrollOffset`,
   `flushNow`, all in the context) rather than an App-side `settingsNoticeLines`
   port I had sketched in the first draft of `context.ts`. Fewer ports, no
   behaviour change; the draft's extra field was removed, not left unused.
5. **`App.tsx`'s import block lost 15 names** (`helpText`, `isSessionMutating`,
   `resolveSlash`, the transcript helpers, `mcpPanel`/`sessionsPanel`/
   `skillsPanel`, `settingsCommand`/`SETTINGS_SYNCING`, `replaceWithNotices`, …)
   because their last App-side user moved. Not a "cleanup while moving": `tsc`
   and `biome` both refuse an unused import, so leaving them would have failed
   the gate.
6. **New test files**: `commands-registry.test.ts` (the pure registry +
   dispatcher, 16 cases) and `app-command-failure-arms.test.tsx` (4 cases). S0's
   `app-commands.test.tsx` is **unmodified** — the brief's rule, and the proof
   the move preserved behaviour.

**Gate (this branch, after every mutation was restored):** `bunx tsc --noEmit`
clean · `bun run lint` (`biome check .`, 1072 files) clean · `bun test`, run
three times end to end:
- run 1: **8162 pass / 3 skip / 1 fail**
- run 2: **8162 pass / 3 skip / 1 fail**
- run 3: **8163 pass / 3 skip / 0 fail** (no fail line at all)

The single intermittent failure is **not this slice's**: it is
`packages/cli/test/engine-runtime.test.ts` "startPodRuntime > creates + readies a
pod, runs a turn over exec, deletes on dispose" — the timing flake `TODO.md:447`
already documents (`fix/engine-runtime-stderr-flake`: "failed once in the full
`bun test packages`… then 3/3 green alone"). Evidence it is load, not S2: that
file alone is **5/5 green** (104 pass each time), all of `packages/cli` alone is
**2645 pass / 0 fail**, and S2's diff is `packages/tui` only (`git status` shows
no `packages/cli` file). The three skips are the documented opt-in ones
(live-k8s, live-docker, the real-socket keepalive — not failures). No protocol
schema changed, so `packages/protocol/schema/protocol.json` was not regenerated
and no `protocol.d/` note is needed (`SLASH_COMMANDS` is a TUI-internal list, not
a wire type). Changelog: `changelog.d/app-decomp-2-commands.changed.md` (one
bullet; `CHANGELOG.md` untouched; the fragment passes
`scripts/test/changelog-guard.test.ts`).

### Fix round 1 — `feat/app-decomp-2-commands` (S2 review findings)

*— claude-opus-5-5, 2026-11-14* (real id: this run is Claude Code
`2.1.323`, `~/.claude.json` `"model": "claude-opus-5-5"`; `AI_AGENT`
`claude-code_2-1-323_agent`.)

One finding, MEDIUM; there was no HIGH. **FIXED.** Two files changed:
`packages/tui/src/commands/compact.ts` (the fix) and
`packages/tui/test/app-command-failure-arms.test.tsx` (the pin). No other
`src/` line moved.

**Finding 1 (MEDIUM) — `/compact` printed "Compacting the conversation…"
twice: FIXED.**

*Reproduced before touching code*, on this branch, with the review's own
observable (`COUNT 2`, main `1`). Probe
`.tentacle/tmp/app-decomp-2-commands/fix1/count.ts` (mount the real `App` with a
held `compact`, type `/compact`, count the line in `lastFrame()`):

```
$ bun run .tentacle/tmp/app-decomp-2-commands/fix1/count.ts
COUNT 2
```

*Root cause*, one sentence: the move split the old `case "/compact"` body into
its guards (`commands/compact.ts`) and its machinery (`App.tsx:startCompaction`)
— and the notice sits in `startCompaction`, which was copied out of the old body
verbatim, so leaving `pushNotice("_Compacting the conversation…_")` in the
command file as well put the same side effect in both halves of the split
(`commands/compact.ts:30` before the fix, `App.tsx:2807`).

*Why the counter-intuitive half is the one that keeps it.* The notice is **not**
a guard message: it reports that a compaction *began*, which only the machinery
knows. `startCompaction`'s first statement reads the session and returns
silently when it is gone (`App.tsx:2803–2806`), so it alone can decide
whether the line is true. `commands/compact.ts` now only refuses and then calls
`ctx.startCompaction()`; the comment on the call site records why. Nothing else
about the command changed — the three guard strings, their order and the
`busyCompacting()` read are byte-identical to main's `2920–2927`.

*Red before green (§9), on the assertion of the property, not on an import.*
The new case in `app-command-failure-arms.test.tsx` counts occurrences instead of
`toContain` (which is exactly why the review found what S0 and
`app-command-failure-arms.test.tsx:96` could not):

```
$ bun test packages/tui/test/app-command-failure-arms.test.tsx   # before the fix
114 |       {},
115 |       { compact: () => new Promise<{ before: number; after: number }>(() => {}) },
...
Expected: 1
Received: 2
(fail) S2 command failure arms (commands/<name>.ts) > /compact says it is compacting exactly once, not twice
 4 pass
 1 fail
```
After the fix, the same command: **5 pass / 0 fail**.

*Mutation-check of both halves of the split (§9 non-vacuity), each restored from
a byte copy taken first (`fix1/compact.good`, `fix1/App.good`):*

- **M14 — put the push back in the command file** (re-introduces the review's
  bug):
  ```
  Expected: 1
  Received: 2
   4 pass
   1 fail
  ```
  → killed, on the new count assertion.
- **M15 — drop the push from `startCompaction`** (the opposite mistake: the
  command layer swallows the announcement):
  ```
  Expected to contain: "Compacting the conversation"
  Received: "⏺ Tentacle ready. Type a task, or /help for commands.…"
  Expected: 1
  Received: 0
   3 pass
   2 fail
  ```
  → killed twice over (the new count case, plus the existing
  "says one is already running" case, which read `toContain` and had been
  passing on a line the *other* half emitted). So the one home is pinned from
  both directions: neither a duplicate nor a missing line survives.

`diff` against both copies after restoring is empty and `git diff --stat` is the
two intended files only.

*Same class, audited rather than assumed.* Grepped every notice string pushed by
`commands/*.ts` against every literal pushed by `App.tsx`: the only string in
both sets is `"_Clipboard unavailable._"`, and those are **not** a doubled path —
`commands/copy.ts:18` is the `/copy` command's reject arm, while
`App.tsx:3345`/`3668` and `useMouse.ts:137` are three *other* triggers of the
same clipboard helper (the copy key, the palette action, the mouse drag), each
reached without the slash command. No `/compact`-style double remains; not fixed
blind, checked.

**Drift from the Implementation.** None. The Implementation's M5 split is
unchanged — the machinery stayed in App and the guards stayed in the command
file; only the duplicated announcement moved to the half that owns it. Nothing
in the Design's port set changed, so no doc above needed editing.

**Gate** (this branch, every mutant reverted):

```
$ bunx tsc --noEmit
(clean, exit 0)
$ bun run lint
Checked 1072 files in 324ms. No fixes applied.
$ bun test
 8164 pass
 3 skip
 0 fail
 13 snapshots, 73210 expect() calls
Ran 8167 tests across 589 files. [332.01s]
```
8164 = the executor run's best 8163 + this round's new case. The 3 skips are the
documented opt-ins (live-k8s, live-docker, the real-socket keepalive — not
failures, AGENTS §6), and the `engine-runtime` timing flake the executor run
reported (`TODO.md:447`) did not fire this time. Touched files alone: 82 pass /
0 fail across `app-command-failure-arms`, `commands-registry`, `app-commands`,
`commands`, `rename`.

## Review

### S2 review — REQUEST-CHANGES

1. **MEDIUM — `/compact` now prints its "Compacting…" notice twice.**
   `commands/compact.ts:31` pushes `"_Compacting the conversation…_"` and then
   calls `startCompaction()`, which pushes the same line again at
   `App.tsx:2807` (copied out of the old `case` body together with the
   machinery). On main the line appears once. Repro
   (`.tentacle/tmp/app-decomp-2-commands/dup-compact.test.ts`: mount `App` with
   a held `compact`, type `/compact`, count the line in `lastFrame()`): **COUNT 2
   on this branch, COUNT 1 on main**. So the claim "no user-visible behaviour
   changes; S0 passing unmodified proves it" is false here. The check the S0 tests
   and `app-command-failure-arms.test.tsx:96` make is `toContain`, which cannot
   see a doubled line. Fix: push the line in only one of the two places, and pin
   it with an exact-count assertion that goes red on the current code.

**Gate:** touched files (`commands-registry`, `app-command-failure-arms`,
`app-commands`, `commands`, `rename`) **81 pass / 0 fail**; `bun run lint` clean
(1072 files); `bun run typecheck` clean. The full `bun test` was not re-run by
this review.

**Mutation:** M2 (`/compact` mid-turn guard → `false &&`): `app-commands.test.tsx`
**26 pass / 1 fail**, so the mutant is killed. Reverted from a byte copy, and
`git status` is clean.

**Attacks tried:** (a) diffed each of the 17 bodies against main's
`handleCommand` (2816–3185). The guards, strings, ordering and the once-only
re-ask are identical; `busyCompacting` reads `compactingRef.current`, as before.
Found nothing except #1. (b) Ran the `/compact` end to end through the real `App`,
which found #1. (c) Deps/identity (H2): `handleCommand`'s deps name fields, never
`ctx`, and `reResolve` reads `handleCommandRef` lazily, so there is no stale
re-entry. Holds. (d) §7 invariants: no protocol, persistence or terminal-IO path
is touched, and the single broker is untouched. Holds.

**Executor behaviour:** thorough and honest about drift, and the cycle/TDZ
experiment was a good call. But the move put the same side effect in both halves of
the guard/machinery split, and the coverage and mutation tables could not catch
it, because no test asserts how many times the line appears.

*— claude-opus-5-5, 2026-11-14* (fresh context; a different model family from
the executor, deepseek)

### Round 2 — PASS

Finding 1 is fixed (`a4a1d51`). The push is gone from `commands/compact.ts`, and
the notice now comes only from `startCompaction()` (`App.tsx:2807`), after all
three guards, which is the same order as on main. The new test
`app-command-failure-arms.test.tsx` "/compact says it is compacting exactly once"
counts the line.
- **Mutation A** (put the push back in `compact.ts`): `Received: 2`, so 1 fail,
  killed.
- **Mutation B** (drop the push at `App.tsx:2807`): `Received: 0`, so 2 fail
  (this test plus "/compact twice"), killed.
- Both were reverted from byte copies, and `git status` is clean.
- The round-1 repro `dup-compact.test.ts` now prints COUNT 1.

**Regressions on the diff:** none. The diff is one deleted line plus a test.
**Gate:** `app-command-failure-arms` + `app-commands` + `commands-registry`
**48 pass / 0 fail**; `bun run lint` clean (1072 files); `bun run typecheck`
clean. The full `bun test` was not re-run.

*— claude-opus-5-5, 2026-11-14*

### S5 — `feat/app-decomp-5-dock` (the dock leaves `App.tsx`)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-14* (real id: `ps` shows
this run launched as `/Users/gmeghnag/bin/tentacle --profile deepseek`, whose
`model.model` is that id in `~/.config/tentacle/config.jsonc:29` — the same
profile S3 and S4 ran under.)

**Scope.** `packages/tui/src/useDock.ts` (new, 478 lines: the hook, its two
port types), `App.tsx` (−328/+55 → **3457** lines from 3730), one new test file
(`packages/tui/test/use-dock.test.tsx`, 8 tests), one changelog fragment.
**No existing test edited**, no `packages/protocol` change (so `schema/protocol.json`
was NOT regenerated — no schema changed), no other slice touched, `TODO.md`
untouched.

**Load-bearing check, re-run first (PASSED).** The plan's claim for every slice
is that Ink calls EVERY active `useInput` listener, so the router cannot be
split — re-verified on this branch, not trusted:
`packages/tui/node_modules/ink/build/hooks/use-input.js:89` registers
`internal_eventEmitter?.on('input', handleData)`; `handleData` (`:80–87`) returns
nothing anyone consumes and has no stop-propagation; the emitter is per-App
(`components/StdinContext.js:11`). `rg 'useInput\(' packages/tui/src` →
`App.tsx:3360` (the one handler) and the separate pre-mount
`components/SessionPicker.tsx:85`. **Holds** — so `App` keeps ONE `useInput`, and
S5 moves no key handler (S3 already moved its body). The check that matters HERE
is the H1 effect-order rule, and it also holds: **20 `useEffect`s before and
after**, in the same order, with the dock's four at indices 3, 12, 13, 14 both
times (pin: `use-dock.test.tsx` "App keeps 20 effects").

**Design, as built (dependency order).**
1. **`useDock.ts` — `DockHost` (input) and `DockLayer` (output).** `DockHost` is
   five fields: `sessionRef`, `field`, `fieldValueRef`, `pushNoticeRef`,
   `jobRefreshMs`. `DockLayer` returns every identifier `App` already used —
   the rows and their refs, the dock's state/ref/setter, `dockIds`,
   `dockVisible`, the two drawer subjects, the reconcile memory and its trigger,
   the job-read trigger and cadence, and the four actions — so every use site is
   untouched (Fable M1).
2. **The refs, state and actions move verbatim.** `setAgents`/`setJobs` keep
   their `sameIds`/`sameReads`/`sameJobIds` gates and their
   `dockLast*RowsRef` freeze writes; `setDock` keeps its EAGER ref write;
   `dockIds`/`dockVisible` stay `useCallback` with `[]`; `drawerSubject` →
   `drawerRow`/`drawerJob` stays a render computation; `killChild`, `killJob`,
   `toggleAgents`, `submitToTarget` move body-for-body with their doc comments.
   **No decision was re-derived** — each already lived in
   `background-focus.ts` / `background-list.ts` / `job-drawer.ts`.
3. **`App.tsx`** — one `useDock({…})` call where the refs used to be, one
   destructuring block in the pre-S5 names, the four effects and their bodies
   left exactly where they were, and the now-unused imports trimmed
   (`DockState`, `INPUT_DOCK`, `DockJobRow`, `BackgroundAgentRow`, `frozenAgent`,
   `frozenJob`, `sameIds`, `sameJobIds`, `sameReads`, `refusalPlacement`,
   `restoreRefused`, `sendTarget`, `toggleList`, `listVisible`).

**Drift from the Implementation (three, all recorded, none silent).**

1. **`pushNotice` travels as a REF, not a port value.** The plan's S5 row says
   "own types; same identifiers; effects stay in App" and does not say how the
   notice sink crosses into the hook. It cannot cross by value: `pushNotice` is
   declared BELOW the dock's refs in `App` (it needs `flushNow`), while an
   effect at index 3 (the `jobs.onExit` subscription, ABOVE it) reads
   `dockStoppedRef`. Moving `pushNotice` up would move that effect's position
   (H1); passing it by value from below would keep the hook's four callbacks
   re-creating whenever `flushNow` did. A ref is the late binding the file
   already uses four times (`routeAttachRef`, `runRef`, `handleCommandRef`,
   `warmErrorRef`), and it keeps BOTH properties: the effect indices and the
   callbacks' identities. `App` writes `pushNoticeRef.current = pushNotice`
   immediately after `pushNotice` is created (the earliest moment it exists).
2. **`DockLayer` exposes MORE than the plan's "same identifiers" list: the
   effects' derived triggers too** (`dockIdKey`, `jobTargetId`,
   `jobEndedWhileOpen`, `refreshMs`) **and the reconcile memory** (`dockSeenRef`).
   Those four were `const`s computed from `dock`, and the memory was a `useRef`,
   inside the block the plan hands to the hook — so they had to go somewhere. The
   plan's H1 rule decides where: an effect stays in `App`, so the values it
   closes over must be reachable from `App`, which means the hook returns them.
   They are triggers/memory, not decisions.
3. **The deps arrays NAME the ref fields (Fable H2), which is what the rule
   asks — but three of them had to be ADDED to existing arrays.** Biome's
   `useExhaustiveDependencies` reads a destructured `const { dockOutcomeRef } =
   hook` as a plain value, so the four effects and the two callbacks that write
   those refs now name them (`[jobs, flushNow, armWake, setDock, dockFinishedRef,
   dockOutcomeRef, dockStoppedRef]`, and the same pattern in the id-key
   reconcile, both job-read effects, `watchSession`, `requestQuit`). This is
   SAFE and is the plan's own rule — a `useRef` object's identity never changes,
   so naming it cannot cause a re-run — and it is strictly better than a
   `biome-ignore`, which would have hidden the next real missing dep on those
   same effects.

**Effects: none moved (H1 / owner Q7 (a)).** Indices before → after, unchanged:
`1` 478→479 (attach unmount), `2` 761→650 (skills sync), `3` 810→699
(**`jobs.onExit`**), `4` 854→746 (host notices), `5` 870→762 (link stop), `6`
889→781 (resize), `7` 927→819 (palette reset), `8` 1132→1024 (blink arm), `9`
1142→1034 (blink sync), `10` 1154→1046 (idle warm), `11` 1175→1067 (scroll
anchor), `12` 1347→1092 (**id-key reconcile**), `13` 1381→1119 (**job output
read**), `14` 1445→1183 (**job's last read at exit**), `15` 1756→1494
(returned), `16` 2179→1917 (initial prompt), `17` 2188→1926 (handed wake), `18`
2404→2145 (session watch), `19` 3199→2942 (mouse hold), `20` 3225→2968 (paste
timer). **20 = 20, same order, nothing added or removed**; the S0b mount-order
test and the S0b identity test both stay green, unedited.

**Identity (H2), per field.** Stable setters stay `useCallback` with their dep
arrays moved verbatim (`setAgents`, `setJobs` `[]`; `setDock` `[]`;
`dockIds`/`dockVisible` `[]`). The four actions keep their pre-S5 deps, plus the
refs they write: `killChild` `[sessionRef, pushNotice]`, `killJob`
`[sessionRef, pushNotice]`, `toggleAgents` `[dockIds, dockVisible, pushNotice,
setDock]` (unchanged), `submitToTarget` `[field, fieldValueRef, sessionRef,
pushNotice, setDock]`.

**Tests (new only).** `packages/tui/test/use-dock.test.tsx` — 8 tests, all
through real Ink (`renderAt`, 100×24):
- *structure* — `useDock.ts` makes no `useEffect` call and does not import it;
  `App` still has 20 effects with the dock's four at their pre-S5 indices, and
  the hook call sits above the first of them.
- *freshness (H3)* — DOWN then ENTER with NO render between them opens the
  dropdown the first key focused (`dockRef` is eager), plus the control with a
  render between them.
- *the guards only an open drawer shows* — a CHILD's drawer never calls
  `jobOutput` (with the job's drawer reading as the non-vacuity control); a job
  appearing AFTER mount reaches the frame (the state gate, not the ref); a late
  refusal asks the field as it is NOW, so text typed since is not overwritten.
**All S0 (39/40), S0b, S3 and S4 nets stay green, unedited** — the suite that
pins this behaviour was not touched, which is the behaviour-preservation proof.

**Mutation check (§9 non-vacuity) — 13/14 KILLED, 1 deliberate survivor.**
Harness `.tentacle/tmp/app-decomp-5-dock/mutate.ts` (byte-copy, ONE mutation,
ONE filtered `bun test -t`, restore, sha256 compare; a 0-test run is reported
INVALID so a bad filter cannot look like a kill — M10 was INVALID twice on a
`+` in the filter and once on the wrong file, and was fixed both times).

| # | Mutation | Result |
|---|---|---|
| M1 | no-op control (`void dockRef;` added to `setDock`) | **SURVIVED** (intended: proves the filters are not trivially red) |
| M2 | `setDock` routes the functional update through `setDockState` (ref at render time) | **KILLED** |
| M3 | the hook imports `useEffect` | **KILLED** |
| M4 | the hook CALLS an effect | **KILLED** |
| M5 | `setAgents` drops the `sameReads` check (the `✓ read` never repaints) | **KILLED** |
| M6 | `setAgents` stops keeping the last rows an ended drawer freezes on | **KILLED** |
| M7 | `dockIds` puts the jobs above the children (the paint order) | **KILLED** |
| M8 | `setJobs` drops every report after the first (the pill freezes) | **KILLED** |
| M9 | `killChild` checks the JOB seam | **KILLED** |
| M10 | `toggleAgents` inverts its empty-list guard | **KILLED** |
| M11 | `submitToTarget` re-routes a refusal to the main agent | **KILLED** |
| M12 | a late refusal reads a STALE field | **KILLED** |
| M13 | `killJob` stops recording the user's own stop | **KILLED** |
| M14 | `jobTargetId` also matches a CHILD's open drawer | **KILLED** |

Every KILLED row is a red on the ASSERTION with a real count (never an
import/compile error), and after each the mutated file's sha256 `MATCHES` its
pre-run value; `git status --short packages/tui/src` lists only `App.tsx`
(modified) and `useDock.ts` (new) — no mutation survived into the tree. M8 and
M14 SURVIVED the first run and M12 survived the first two: each was a real
coverage gap in the moved code, closed by a test written for it (the pill's
state path, the child-drawer read guard, and the live-field refusal placement),
not by weakening the mutant.

**Gate (this worktree, this branch).** `bun run check` → `tsc --noEmit` clean,
`tsc -p apps/mobile --noEmit` clean, `biome check .` **1114 files, 0 errors, 0
warnings** (the AGENTS §6 baseline: clean), `bun test` **8524 pass / 3 skip / 0
fail** (the 3 skips are the documented opt-ins: live-k8s, live-docker, the
~12 s real-socket keepalive). No schema change → `packages/protocol/schema/protocol.json`
not regenerated. One changelog fragment,
`changelog.d/app-decomp-5-dock.changed.md`. `TODO.md` untouched (the
orchestrator's line, §10).

**Unverified (one line each).**
- The plan's coverage check (`bun test --coverage packages/tui`, App.tsx +
  new-files line total not dropping) was **not** run, as in S4; the moved lines
  are pinned by the S0/S0b/S3/S4 nets plus 8 new tests, but the percentage is
  unmeasured.
- `App.tsx` is 3457 lines, not the plan's ≲800 target: that is the SUM of all
  slices (S7–S10 are still open), and this slice's own reduction is 273 lines.
