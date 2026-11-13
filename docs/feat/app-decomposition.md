# feat/app-decomposition — Break up `App.tsx` so TUI features stop colliding

> **Status:** S0 executed; plan REVISED after the Fable design review (S0b + S1+ re-approval pending — see *Design review response*)
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
| S0 | `feat/app-decomp-0-charnet` | S–M · contained (tests only) | new `test/app-keys-precedence.test.tsx`, `test/app-commands.test.tsx`, `test/app-frames.test.tsx` | anything (no src edit); MUST merge before S1+ |
| S1 | `feat/app-decomp-1-types` | S · cross-module | `app-types.ts` (new), App.tsx (delete the type block + `export type` re-export + trim now-unused type imports), `index.ts`, `test/app-types.test.ts` (new), **+ `packages/cli/test/subagent-panel-controller.test.ts` (2-line source-locator repoint — see Preconditions)** | none on App.tsx head (touches imports block); done alone |
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
Target ≲ 600 lines, no feature logic. **Revised (H1/M2):** no `useMouse` hook
(per-event function); the 20 effects stay here in today's order; target ≲ 800
lines.

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

New, from the Fable review (Q1–Q6 stay answered; Q3's S1 freeze is moot — S1 is
dissolved below):

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
branches cited (76, 89, 92, 120, 149). → **Changes:** (1) **S1 is dissolved**:
no single `app-types.ts`. Each hook slice takes its own types with it
(`DockProps`, `AttachProps`, `SessionJobs`, … next to the hook);
`AppProps`/`SessionController` become `extends` lists in `app-types.ts`,
created by the first hook slice that needs it; `index.ts` re-exports keep the
test boundary stable. (2) Measurable target per feature KIND: command / key
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

**M2 — S4 (CONFIRMED).** → `dispatchMouse` becomes a **per-event function**
called by the router with a render snapshot (`total`, `viewport`, `listView`,
`panelBodyTop`, `dockTop`, `dockView`, `layout.laid`, `win`, `visible`,
`expandAll`, `columns`, `statusRowRef`), not a hook taking them every render.
`stepMouseChunk` returns `{ reports, hold, restored, swallowBehindPanel }`.
S4 goes **before** S3 and defines the layer contract S3 generalises; blast
raised to cross-module (it edits the `useInput` body), fresh review.

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
| ~~S1 types~~ | dissolved into S5/S6/S8/S9 | — |
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
- **(a) A changelog fragment exists, against this doc's "Other hotspots".** The
  plan says slices "add no CHANGELOG line (internal refactor; one entry when the
  last slice merges)"; my execution brief explicitly requires
  `changelog.d/app-decomp-1-types.<category>.md`. I followed the brief: the
  fragment is `changed`, one bullet, and **deletable** — if the owner prefers the
  plan's rule, drop the file and nothing else changes. It is not a rule change
  either way (`[Unreleased]` stays empty; guard green).
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
