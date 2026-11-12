# fix/dock-list-type-through — typing with the background dropdown open goes to the input

> **Status:** execution
> **Branch:** `fix/dock-list-type-through`
> **Type: fix · Size: S–M · Blast: cross-module · Suited: DeepSeek exec**

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Owner, live: *"con la tendina dei background job alzata (ma il cursore sull'input) non mi fa
scrivere, dovrei poter scrivere al modello"*. With the background dropdown open (`list` focus) the
input's block cursor is still painted — the dock does not take the input away — but every printable
key is swallowed by design (owner P3 (a), 2026-11-10, `docs/feat/subagent-panel.md:343`,
implemented at `packages/tui/src/background-focus.ts:432-435` on `main`). The screen reads as hung:
the only affordance on it says "type here", and typing does nothing.

Why it was swallowed: a bare `x` armed a stop and a bare `y` confirmed it
(`background-focus.ts:410-424`), so a printable key had to be either the dock's or nothing.

**Owner decision 2026-11-11 (binding; supersedes P3 and revises P4):**

1. A printable key at `list` focus moves the keys to the input **and is typed there** (the
   `pill` branch's rule, `background-focus.ts:328-331`, extended to the list).
2. The dropdown **STAYS VISIBLE** while the input has the keys (a new state, in the pure module).
3. **Esc** from that state closes the dropdown (and must NOT reach the App's "Esc stops a running
   turn" branch); **↓** goes back into the list.
4. The stop key becomes **`ctrl+x`** (arm) then **`ctrl+x`** (confirm) — no bare `x`/`y` acts in the
   list any more, for sub-agent AND shell-job rows; every hint/footer/doc string naming `x`/`y`
   updated.
5. Mouse (SGR) reports must still never be read as keys.

**Repro** (`.tentacle/tmp/dock-type-through/`, on `main` at `f403bbd`, 2026-11-11): the new frame
test file, run on the unfixed code. The paste is D3's frame — the sharpest one, since `xyz` is
exactly the string that used to arm and confirm a stop — and all six cases failed on their own
property:

```
$ bun test packages/tui/test/dock-type-through-frames.test.tsx   # before any edit
D3: error: expect(received).toContain(expected)
Expected to contain: "xyz"
Received: "…─ background · 1 ────── enter open · x stop · esc back ─
› ● sa-1  explore  find callers of parseConfig   19 tools · 12k · 1m 12s
──────────────…──────────────
❯  Type a task or /command
─────────…──────────
/tmp/work · ctx –/128k     ⏵⏵ auto-accept off (shift+tab)  ·  1 agent ▴"

D4: Expected to contain: "ctrl+x stop · any other key cancels"   (the armed rule never appears)
D6: - ["bg-3"]  + []                                             (killJob never called)

 0 pass
 6 fail
```

The frame is the bug in one screen: the dropdown is up, the input still paints its
`❯  Type a task or /command` row, and the typed text is not there.

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Load-bearing assumption

**The App applies `dockKey`'s returned STATE for every verdict, `pass` included, and then lets the
input's own line editing run.** Cited and verified: `packages/tui/src/App.tsx:3595-3603` — the state
is applied before the `effect.kind !== "pass"` early return, and that comment records the same bug
class fixed for the pill (Review round 3, H1): applying the state only for a non-`pass` verdict left
the old focus in place, so the next key acted on the stale focus. This is what makes "move focus and
type here" expressible as ONE verdict (`pass` + a new state), which is the whole change.

### Preconditions

- `DockFocus`'s `list` variant is `{ selected, armed }` (`packages/tui/src/background-list.ts:117`);
  it is constructed in exactly three places — `openDropdown`, `clickDock`, `closeToDropdown`
  (`background-focus.ts:154, 175, 220`) — so adding a field is a three-line change there plus tests.
- `downEntersList` only lets DOWN into the dock from `focus.kind === "input"`
  (`background-focus.ts:127`), and it is consulted from the DOWN table in the App
  (`App.tsx:3852-3872`) — so the pinned dropdown needs an explicit entry in that table.
- `stepChord` consumes `ctrl+x` **unconditionally**, before the dock sees any key
  (`chord.ts:29-31`, called at `App.tsx:3369`). Without a guard, `ctrl+x` can never reach the dock.
- Mouse reports are recognised inside `dockKey` before any focus branch
  (`background-focus.ts:259-262`), so no new keyboard state can expose them.
- Esc must never fall through to "stop the running turn": the dock runs before that branch
  (`App.tsx:3585` vs `:3623`) and every dock Esc returns `effect: "none"`.

### Design

**The state: `typing: boolean` on the existing `list` variant** — not a fifth `DockFocus` kind. The
list is still the surface on screen, still owns a selection, and ↓ must land back on the row the
user left; a separate kind would duplicate `selected` and fight `reconcile`. So:

```ts
| { readonly kind: "list"; readonly selected: string; readonly armed: boolean; readonly typing: boolean }
```

`typing: false` = the list has the keys (unchanged). `typing: true` = the same dropdown, pinned on
screen, the keys back in the input.

**Keys, in `dockKey` (all of it here, AGENTS §7):**

| state | key | result |
|---|---|---|
| `list` `typing:false` | printable | state → `typing:true` (selection kept), effect **`pass`** — the key is typed |
| `list` `typing:false` | `ctrl+x` | state → `armed:true`, effect `none` |
| `list` `typing:false` armed | `ctrl+x` | effect `stop{id}`, disarmed |
| `list` `typing:false` armed | any other | disarmed, swallowed (`none`) — unchanged |
| `list` `typing:true` | `ctrl+x` | state → `typing:false, armed:true` (the list takes the keys back armed) |
| `list` `typing:true` | Esc | state → `input` (the dropdown closes), effect `none` |
| `list` `typing:true` | `ctrl+t` | state → `typing:false` (undo the type-through) |
| `list` `typing:true` | everything else | `pass` — the input's |

**↓ is not the dock's:** the App's DOWN table (`resolveLineInput` → `downEntersList`) runs before
`dockKey` and owns the multi-line/history meanings. `downEntersList` now accepts the input **and**
the pinned dropdown; a new pure `downToDock(state, ids)` executes it — pill from the input, list
from the pinned dropdown — while `toggleList` keeps Ctrl+T's `/agents` meaning (an explicit toggle
OUT of the dock).

**The chord guard:** new pure `dockClaimsCtrlX(state)` (true for `list`, either sub-state). The App
asks it before `stepChord`; when the dock owns `ctrl+x`, the chord is reset to idle and the key goes
down the normal path to `dockKey`. So `ctrl+x ctrl+s` (send queued messages now) is unchanged
everywhere the dropdown is not focused.

**Hints** (`background-list.ts` `dockHint`, `agentMeta`): `enter open · ctrl+x stop · esc back`
(focused list), `ctrl+x stop · any other key cancels` (armed), `stop sa-N? ctrl+x` (the armed row's
meta), and `↓ list · esc close` for `typing:true`. The rule paints calm while typing (`focused`
is `list && !typing`) but the selection stays marked.

### Files

1. `packages/tui/src/background-list.ts` — `DockFocus.list` gains `typing`; the three hint/meta
   strings; `focused`.
2. `packages/tui/src/background-focus.ts` — `DockState`'s doc, the three constructors, the whole
   `list` branch of `dockKey` (type-through, `ctrl+x`, the typing sub-state), `downEntersList`,
   `downToDock`, `dockClaimsCtrlX`.
3. `packages/tui/src/App.tsx` — the chord guard, `downToDock` on the DOWN path, comments. **No new
   rule**: every branch it runs is a pure function's verdict.
4. `packages/tui/src/components/BackgroundList.tsx`, `job-drawer.ts`, `daemon/src/hosted-session.ts`
   — the doc-comment strings that named `x`/`y`.
5. Tests: `packages/tui/test/dock-type-through-frames.test.tsx` (new), `background-focus.test.ts`,
   `background-list.test.ts`, `subagent-panel-frames.test.tsx`, `shell-panel-frames.test.tsx`.
6. `docs/feat/subagent-panel.md` (P3/P4 + the keys table + the hint lines), `docs/feat/shell-jobs-panel.md`,
   `CHANGELOG.md`.

### Failure modes

- **A permission prompt owns every key.** `useInput` answers the prompt before the dock
  (`App.tsx:3389`), so `typing` stays harmless there; the dock's state is untouched underneath
  (already pinned by the frame test F10).
- **A quit confirm.** It owns the screen and every key before the dock; the list is not painted
  (`dockListVisible` requires `quitConfirm === null`).
- **The list empties while typing.** `reconcile` returns to `input` on an empty list — the draft and
  the text stay, and the dropdown had nothing left to show. No new branch: `reconcile` only touches
  `list` focus, and `typing` rides along in the spread.
- **`ctrl+x` while the input is focused** — the chord's, as before (`dockClaimsCtrlX` is false).
  A chord armed just before the dropdown opened is reset when a list key is pressed, so a stale arm
  cannot fire `sendNow` afterwards.
- **A mouse report** is matched before every branch (`isMouseReport`), so the wheels and clicks keep
  working in the pinned state.
- **Esc in the pinned state** returns `none`, so the App's "Esc stops a running turn" is never
  reached — the property the owner called out.
- **A `/…` command typed while pinned** submits through the existing `submitTarget`, which routes
  `main` — unchanged.
- **A job's row** takes the same `ctrl+x` twice; the App routes by `dockKindOf(id)` to
  `session/job_kill`, unchanged.

### Tests

Red before green (§9); the exact property each pins:

- **`dock-type-through-frames.test.tsx`** (real `App`, `renderAt`, 100×24):
  - **D1** open the dropdown, type `hello`, Enter → `api.prompts === ["hello"]` and the dropdown
    still paints `background · 2`.
  - **D2** with a held turn running, type and Esc → the dropdown closes, the text survives, and
    `api.aborts()` does not move (the Esc chain stays honest).
  - **D3** typing `xyz` → the text is in the input, no `stop sa-1?` and `api.kills` empty.
  - **D4** `ctrl+x` twice on a sub-agent row → `api.kills === ["sa-1"]`, the armed rule names
    `ctrl+x`.
  - **D5** `↓` returns to the list after typing; and `↓` inside a multi-line draft still moves the
    cursor (the DOWN table wins).
  - **D6** the shell row: `ctrl+x` twice → `api.kills === ["bg-3"]` (`session/job_kill`).
- **`background-focus.test.ts`** (pure): type-through = `pass` + `typing`, the selection kept,
  Esc/`ctrl+t`/`ctrl+x` in the typing sub-state, `downToDock` vs `toggleList`, `dockClaimsCtrlX`,
  and a bare `x`/`y` never arming.

Mutations (non-vacuity, §9): see Execution.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-11*

**Order followed** as in Files (pure modules first, then App, then strings, then tests).

**RED first.** The frame test was written against unmodified `main` and run: **6 fail / 0 pass**
(`0 pass 6 fail`), each on its own property assertion — D1 on `expect(f).toContain("hello")`, D2 on
the text, D3 on `"xyz"`, D4 on the armed rule, D5 on `↓ list · esc close`, D6 on `api.kills`
(received `[]`). Not one of them failed on an import or a compile error. Context's **Repro** pastes
D3's frame plus D4's and D6's assertions from that same run (all six were recorded; the file was
captured as `.tentacle/tmp/dock-type-through/red.txt`-shaped output — the gitignored scratch, so the
paste in Context is the durable record).

**Green:** `bun test packages/tui/test/dock-type-through-frames.test.tsx` → `7 pass 0 fail`.

**Drift from Implementation (and why):**

1. **`↓` in the typing state is NOT handled inside `dockKey`.** The Implementation's key table gave
   `dockKey` the `typing:true` + `↓` row. While wiring it, that would have made a `↓` that
   `resolveLineInput` had already resolved as a *line move* or a *history walk* land in the dock
   first — `dockKey` runs before the DOWN table. The clean shape is the existing one: the DOWN table
   decides, `downEntersList` now accepts the pinned dropdown, and `downToDock` executes. `dockKey`
   returns `pass` for `↓` in the typing state, which is also what a multi-line draft needs. Pinned
   by D5's second test and by the pure test. (Same category as the rule AGENTS §7 asks for: the
   decision stayed pure, it just moved to the function that owns DOWN.)
2. **`ctrl+t` in the typing sub-state** undoes the type-through (`typing: false`) instead of
   closing the dropdown. Ctrl+T is the surfaces' toggle, so from the pinned list it returns to the
   list; Esc is the key that closes the dock — that keeps the Esc chain (drawer → dropdown → pill →
   input) and Ctrl+T's own meaning apart. Pinned in the pure test.
3. **`downToDock` is new** (not in the Implementation): `toggleList` means "an explicit toggle out of
   the dock" for Ctrl+T/`/agents`, and reusing it for DOWN would have made a DOWN from the pinned
   dropdown skip straight to the pill. Small pure function, one caller, tested.

**Gate:** `bunx tsc --noEmit` → clean. `bun run lint` → `Checked 895 files … No fixes applied`
(0 errors, 0 warnings — the repo's baseline). `bun test packages/tui` → **1479 pass / 0 fail** (104
files). Full-repo `bun test` → **6906 pass, 3 skip (the opt-in three), 1 fail, 1 error** (6910
tests, 500 files):

```
apps/mobile/test/rn-websocket.test.ts:
error: Cannot find module '@tentacle/client' from '…/apps/mobile/test/rn-websocket.test.ts'
```

**`apps/mobile`'s dependencies are absent in this worktree** (`apps/mobile/node_modules` does not
exist here; the same test passes `3 pass / 0 fail` in the main checkout at
`/Users/gmeghnag/tentacle`, where they are installed). It is an environment gap, not a regression:
this change touches no file under `apps/` and no file under `packages/client`, and the error is a
module-resolution failure, not an assertion. For the same reason `bun run typecheck`'s second half
(`tsc -p apps/mobile`) cannot run here; the root project's `bunx tsc --noEmit` is what was verified.

**Mutation results (non-vacuity, §9).** Script kept in `.tentacle/tmp/dock-type-through/mutations.sh`
(gitignored); each mutation breaks one property, the named tests run, and the byte-identical file is
restored:

| # | mutation | red tests |
|---|---|---|
| M1 | the type-through reverted: a printable key at `list` focus returns `none` again | **9 fail** — the frame tests D1, D2, D3, D5 and D5b, plus 4 pure cases (type-through, bare `x`/`y`, the ↓/Esc sub-state, "Enter is the input's") |
| M2 | the arm/confirm read a bare `x` again (`const ctrlX = char === "x"`) | **2 fail** — D3 (`xyz` arms) and the pure "bare `x`/`y` is just typing" |
| M3 | the App's `dockClaimsCtrlX` guard dropped (the chord eats `ctrl+x`) | **2 fail** — D4 and D6 (`api.kills` stays `[]`) |
| M4 | Esc in the typing state `pass`es to the App instead of closing | **2 fail** — D2 (the abort count moves) and the pure Esc case |
| M5 | the dropdown hidden while `typing` | **3 fail** — D1, D5, D5b |
| M6 | the pinned dropdown excluded from `downEntersList` | **1 fail** — D5 (↓ can never return) |
| M7 | `isMouseReport` back to `char.startsWith("[") && MOUSE_REPORT.test(char)` | **1 fail** — the pure "an SGR mouse report is NEVER a key": the ESC-prefixed `\u001b[<0;4;9M` reaches the printable branch |

Restored afterwards: `52 pass / 0 fail`. Each mutation is red on the property it breaks, and only
there — no test is green-on-both.

**One latent bug found and fixed on the way (M7).** `isMouseReport` was
`char.startsWith("[") && MOUSE_REPORT.test(char)`, while the regex itself begins `\x1b?` — so a
report delivered with its ESC still attached (`\u001b[<0;4;9M`, the raw terminal bytes; Ink usually
strips it, hence the guard) could never match the `startsWith("[")` half. That was harmless while a
printable key at `list` focus was swallowed, and it is NOT harmless now: the report would have been
typed into the input. The `startsWith` guard is gone (the regex is the whole rule), checked directly
on the pure module in `.tentacle/tmp/dock-type-through/mouse.ts` — the `list press` row printed
`effect=pass stateKept=false BUG` before, and all seven rows print `OK` after:

```
list   press         effect=pass stateKept=true OK
typing press         effect=pass stateKept=true OK
control list "a"  effect=pass typing=true OK
ALL MOUSE REPORTS PASS THROUGH
```

The control line is what keeps that check non-vacuous (everything in that state returns `pass`; only
the printable key also CHANGES the state).

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-11*

*(To be done in a fresh context, per AGENTS §10 for a `cross-module` fix. Not self-approved here.)*
