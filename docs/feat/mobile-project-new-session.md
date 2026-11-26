# feat/mobile-project-new-session — New session from a project's session list

> **Status:** implementation (APPROVED — owner delegated the details; see «Orchestrator decisions»)
> **Branch:** `feat/mobile-project-new-session`
> **Size:** S · **Blast:** contained (mobile: one screen, its route wiring, one additive method on a mobile module; no protocol, persistence or daemon change) · **Suited:** Sonnet executes, Opus reviews (fresh context)
> **Changelog:** `changelog.d/mobile-project-new-session.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

The owner (2026-11-26 ~08:50, phone screenshot of the session list of the
project «assistant»: back, large title, Search sessions, PINNED, IDLE rows):
«in questa schermata ci deve essere il bottone per creare una nuova sessione».

That screen is `apps/mobile/src/screens/SessionsScreen.tsx` (route `Sessions`,
`App.tsx:3591-3615`). It can open, search, refresh and page sessions, but it
cannot START one: its props (`SessionsScreen.tsx:34-48`) have no create action,
and its empty state even sends the person back to the laptop («Run `tentacle`
in this project on your computer», `SessionsScreen.tsx:206-212`). Today a new
session can be started on the phone only from the drawer's pill
(`SessionsDrawer.tsx:306-315`) or the hub's More → New session
(`App.tsx:1852-1862`), both reachable only from INSIDE an already open session.

A paired computer is one `serve`, and a `serve` is one project: the daemon runs
every session in its own `defaultCwd` and ignores any client cwd
(`packages/daemon/src/session-host.ts:5-7`, the create branch
`session-host.ts:1155-1187`). So "a new session in THIS project" is exactly
"a new session on the computer this list belongs to" — what the drawer's pill
already does, given that computer's id.

Constraints (owner taste, standing): a real BUTTON (not coloured text), minimal,
not crowded, thin icons, never meaning by hue alone (owner is colour-blind), an
unavailable action stays in place DIMMED with an inline reason and a light
haptic on tap — never an empty modal. The owner delegated variant and details
to the orchestrator; they see simulator screenshots before the next build.

**Mockups:** `/Users/gmeghnag/tentacle/.tentacle/mockups/mobile-project-new-session/`
— `index.src.html` (source, composes `tools/mockup-kit`) and
`index.src.inline.html` (self-contained snapshot to open). Four variants, each
in light and dark: **A ★** a bottom bar with the drawer's own New session pill;
**B** a wide button under the search field; **C** a compact capsule in the
navbar; **D** a floating glass capsule. A is drawn in every state (list, busy,
offline, connecting, create refused, empty project). Kit gaps used as «nuovo»
extensions (reported on the page, not patched): large `ScreenHeader`, the search
field, the session row, `PillButton` at 40 pt, and four SF Symbols.
*Not verified:* the headless-Chrome render of the page (the screenshot command
needed an approval this planning session did not have) — open
`index.src.inline.html` in a browser to check before showing it.

**Repro** (2026-11-26, worktree at `f4f5e2a0`, the capability is missing):

```
$ rg -c "New session|onNewSession|newSession" apps/mobile/src/screens/SessionsScreen.tsx
(no output, exit 1)
```

## Implementation

*— claude-opus-5-5, 2026-11-26* — **APPROVED** (owner delegated; decisions below)

#### Orchestrator decisions

- **D1 — Variant A.** A bottom bar under the list, outside the `ScrollView`
  (always visible, under the thumb, the list itself unchanged): a hairline top
  border, the New session pill on the RIGHT — the drawer's exact pill
  (`PillButton` primary, `icon="plus"`, `height={40}`, label «New session»,
  `SessionsDrawer.tsx:306-315`), and the bar's metrics copied from the drawer's
  footer (`SessionsDrawer.tsx:292-296`, `653-659`: paddingTop 6, paddingHorizontal
  10, hairline `sepChat`, paddingBottom `max(insets.bottom, 10)`). One way to
  create a session across the app: same shape, word and place. B/C/D rejected:
  B is heavy at the top and scrolls away; C is far from the thumb with no room
  for the reason; D floats over the last row.
- **D2 — The gate is the list's own state, no extra probe.** Enabled iff the
  list has an answer from the daemon and the link is not down:
  `status === "loaded" && !stale` (`session-list.ts:43-61`). A pull-to-refresh
  of a list with rows keeps `status: "loaded"` (`session-list.ts:120-128`), so
  the button does not flicker; a link drop or a failed refresh sets `stale`
  (`session-list.ts:164-181`) and a later page clears it (`session-list.ts:157`).
- **D3 — Dimmed with an inline reason, always visible while dimmed** (left of
  the pill, `footnote`, `sec`), and a tap on the dimmed pill plays the light
  haptic and sends nothing. Reasons (text, never colour): never answered yet
  (`idle`, or `loading` with no rows) → «Connecting…» (the drawer title's word,
  `drawer-list.ts:234`); `stale` → «Offline — reconnecting» (matches the
  screen's «Reconnecting…» banner); `failed` → «Can't reach this computer».
- **D4 — Success opens the session like a row, composer focused.** Push
  `Session` with `{ computerId, sessionId, title: NEW_SESSION_TITLE, archived:
  false, focus: true }` (no `cwd`: the screen asks `session/list` itself,
  `routes.ts:36-41`). Back returns to this list, whose focus refresh
  (`App.tsx:1516-1520`) then shows the new row.
- **D5 — A refused create** shows the drawer's typed text
  (`drawer-new-session.ts:45-56`; never the daemon's own message — a pod picks
  that text, §7) on a line just above the bar, red text + the words carry it;
  a tap on the line dismisses it, the next New session tap clears it.
- **D6 — Empty project copy:** «No sessions yet» + «Start one with New
  session.» (replacing the «Run tentacle in this project…» body,
  `SessionsScreen.tsx:206-212`), since the phone can now start one.
- **D7 — Leaving mid-create opens nothing.** If the screen unmounts while the
  create is in flight, the finished create does not navigate (the person has
  moved on); the session exists and is listed at the next read — never lost.

### Load-bearing assumption

**Reusing the drawer's create path with this list's `computerId` creates the
session in this project and makes it openable by the Session screen.** Proven:

- The create is `createFreshSession(link.client.newSession(undefined, id))`
  (`App.tsx:1720-1728`, `session-controller.ts:112-133`): `session/open{create}`
  under a phone-minted id, then detach, so the Session screen's attach-only open
  finds it. Pinned end-to-end against a real in-process daemon by
  `apps/mobile/test/new-session-link.test.ts` (created, listed live, attachable,
  a send lands).
- The daemon decides the folder, not the client: every session runs in its
  `defaultCwd` (`session-host.ts:5-7`, `1155-1187`), and a paired computer is
  one `serve` = one project. The Sessions route is bound to that computer
  (`route.params.computerId`, `App.tsx:3596-3599`; `LINKS.get(computerId)`,
  `App.tsx:1486`).
- The Session route honours `focus` (`App.tsx:3655`, `routes.ts:33-34`).

### Preconditions

- `createDrawerNewSession` is computer-agnostic: `start(computerId, canCreate)`
  ignores a tap when `!canCreate` or while `creating`, mints the id, maps a
  failure to a typed text, and calls `opened` only on success
  (`drawer-new-session.ts:66-103`). Reused as-is (plus D7's `dispose`).
- `PillButton` does NOT pass `disabled` to `Pressable`: `onPress` fires on a
  dimmed pill (`PillButton.tsx:68-74`), which is what lets the tap play the
  light haptic (D3). The tap decision therefore lives in the pure module.
- `playHaptic("light")` is the one haptic seam (`haptics.ts:9-14`, `:27-28`).
- `viewModel` already exposes `status` and `stale` to the screen
  (`session-list-controller.ts:135-155`).
- §7 «logic in pure modules»: every branch (gate, reason, tap → create /
  refuse / ignore) goes in `project-new-session.ts`; `SessionsScreen.tsx` maps
  the view to a `PillButton` + two `Text`s.
- §7 «untrusted pod»: only typed failure reasons reach the screen (reused).
- No protocol change: the same `session/open{create}` the drawer sends.

### Design

1. **`apps/mobile/src/project-new-session.ts` (new, pure, React-free):**
   ```ts
   export interface ProjectNewSessionView {
     readonly enabled: boolean;      // the pill looks live
     readonly busy: boolean;         // spinner (a create in flight)
     readonly reason: string | null; // D3, shown left of the pill while dimmed
     readonly error: string | null;  // D5, the line above the bar
     readonly accessibilityLabel: string; // "New session" or "New session, <reason>"
   }
   export function projectNewSessionView(
     list: { readonly status: "idle" | "loading" | "loaded" | "failed"; readonly stale: boolean },
     state: NewSessionState,
   ): ProjectNewSessionView;
   /** What a tap does: create, refuse (light haptic, nothing sent) or ignore (busy). */
   export function projectNewSessionTap(view: ProjectNewSessionView): "create" | "refuse" | "ignore";
   ```
   `canCreate` for `start` is `list.status === "loaded" && !list.stale` (D2);
   `enabled = canCreate && !state.creating`; `busy = state.creating`; `reason`
   is null when `canCreate` or busy (D3 table otherwise); `error = state.error`.
   Export the three reason strings as constants (the tests and the flow read them).
2. **`drawer-new-session.ts` — add `dispose()`** to `DrawerNewSession`: after it,
   a create that settles neither sets state nor calls `opened` (D7). Additive;
   the drawer does not call it.
3. **`SessionsScreen.tsx`** — new props `newSession: ProjectNewSessionView`,
   `onNewSession: () => void`, `onNewSessionDismiss: () => void`. After
   `</ScrollView>` and before `<CompactBar>`: the error line (testID
   `sessions-new-error`, `accessibilityRole="button"`, tap → dismiss) when
   `error !== null`, then the bar (testID `sessions-new-bar`) with the reason
   `Text` (testID `sessions-new-reason`) when non-null, a flex gap, and the
   `PillButton` (testID `sessions-new`, `disabled={!enabled}`, `busy`,
   `accessibilityLabel`). Bottom inset via `useSafeAreaInsets()` (presentation,
   as `ScreenHeader` does). D6 copy in the empty state. Add the new testIDs to
   the header comment's list.
4. **`App.tsx`:**
   - Extract the drawer's `create` body (`App.tsx:1720-1728`) into one
     module-level `createOnComputer(computerId, sessionId)` used by BOTH the
     drawer and `SessionsRoute` (no copied send logic, §7).
   - `SessionsRoute` gets a new prop `onCreated: (sessionId: string) => void`;
     it builds one `createDrawerNewSession({ mint: () => crypto.randomUUID(),
     create: createOnComputer, opened: (_, id) => onCreatedRef.current(id) })`
     per `computerId` (`useMemo`), subscribes to it, and `dispose()`s it in the
     same unmount effect as the list controller (`App.tsx:1501-1512`).
   - Render: `newSession={projectNewSessionView(snapshot, freshState)}`,
     `onNewSession` → `switch (projectNewSessionTap(view))`: `create` →
     `void fresh.start(computerId, true)`; `refuse` → `playHaptic("light")`;
     `ignore` → nothing. `onNewSessionDismiss={() => fresh.dismiss()}`.
   - The `Sessions` stack screen (`App.tsx:3596-3613`) passes
     `onCreated={(sessionId) => navigation.navigate("Session", { computerId:
     route.params.computerId, sessionId, title: NEW_SESSION_TITLE, archived:
     false, focus: true })}` (D4).

### Files

In dependency order:

1. `apps/mobile/src/drawer-new-session.ts` — `dispose()` (D7).
2. `apps/mobile/src/project-new-session.ts` — new pure module.
3. `apps/mobile/src/screens/SessionsScreen.tsx` — the bar, error line, props, D6 copy.
4. `apps/mobile/App.tsx` — `createOnComputer`, `SessionsRoute` wiring, `onCreated` navigation.
5. Tests: `apps/mobile/test/project-new-session.test.ts` (new),
   `apps/mobile/test/drawer-new-session.test.ts` (dispose),
   `apps/mobile/test/band-screens.test.ts` (placement).
6. E2E: `apps/mobile/e2e/flows/47-project-new-session.yaml` + `47-project-new-session.js`,
   registered in the `FLOWS` list of `apps/mobile/e2e/run.ts` (next to
   `"34-hub-new"`, `run.ts:1870`; no `COMPOSE_SESSION_VARS` entry — it needs no
   seeded session). If a test pins the flow list (`rg -n '34-hub-new'
   apps/mobile/test scripts/test`), update it too.
7. `changelog.d/mobile-project-new-session.added.md`:
   `- **New session from a project's session list.** The phone's list of a project's sessions now has a New session button at the bottom — the same one as in the drawer: it starts a session in that project and opens it ready to type; while the computer is offline it stays dimmed and says why.`

### Failure modes

| Case | What happens | Converges how |
|---|---|---|
| Computer offline / link down (`stale`) | Pill dimmed, «Offline — reconnecting»; tap = light haptic, nothing sent | Link up → `link(up)` refreshes (`session-list-controller.ts:111-124`); the page clears `stale` → enabled |
| First read not answered yet | Dimmed, «Connecting…» | First page → enabled |
| First read failed (version mismatch, revoked, …) | Dimmed, «Can't reach this computer»; the screen's error banner + Retry say the detail | Retry succeeds → enabled |
| Link drops between the gate and the create | `createFreshSession` → typed `link`/`timeout` → D5 line; nothing opens | Next tap retries; the gate reflects the drop |
| Daemon at its session cap | `too-many` → «This computer has too many sessions open.» | Person closes one, taps again |
| Double tap | Second tap `ignore` (busy) — one create | — |
| Screen left mid-create (back, drawer reset) | `dispose()` → no navigation, no state write (D7) | Session exists; listed at the next read of any list |
| Create ok, detach fails | Still ok (`session-controller.ts:128-132`); the Session screen's attach re-reaches it | — |
| Search field focused (keyboard up) | Bar sits under the keyboard; reachable after dismissing it | — |
| Untrusted pod daemon | Only typed reasons shown (reused table) | — |
| Version skew | None: no new RPC/field; same `session/open{create}` as the drawer | — |

### Tests

Red before green (§9): write each test first and SHOW it failing on the
pre-change code (missing export / method, or the assertion), then implement.
Then prove non-vacuity by mutation and revert.

1. `apps/mobile/test/project-new-session.test.ts` (new; drive the list side
   through the REAL `reduce` / `initialSessionList` from `session-list.ts`, not
   hand-built objects, so the property pinned is the actual state machine's):
   - initial (`idle`) → disabled, reason «Connecting…»; `refresh` on an empty
     list (`loading`) → still «Connecting…»;
   - a `page` → enabled, reason null, label «New session»;
   - a second `refresh` on a list WITH rows → still enabled (no flicker, D2);
   - `link{up:false}` → disabled, «Offline — reconnecting», label carries the
     reason; `link{up:true}` + `page` → enabled again (convergence);
   - a `fail` with no rows → «Can't reach this computer»; with rows → stale →
     «Offline — reconnecting»;
   - `creating: true` → `busy`, not enabled, reason null; `error` passes through;
   - `projectNewSessionTap`: enabled → `create`; busy → `ignore`; dimmed → `refuse`.
   - **Mutation:** drop `!stale` from the gate → the link-down test must fail.
2. `apps/mobile/test/drawer-new-session.test.ts` — `dispose()`: a create whose
   promise resolves AFTER `dispose` calls `opened` zero times and leaves
   `state()` unchanged; a failing one likewise sets no error. Red: no `dispose`
   method. **Mutation:** remove the guard → `opened` is called → fails.
3. `apps/mobile/test/band-screens.test.ts` (S4 block, the file's source-reading
   pattern): `testID="sessions-new"` appears AFTER `</ScrollView>` (the bar is
   pinned, not scrolled) and the pill is a `<PillButton` with `icon="plus"`.
4. E2E `47-project-new-session.yaml` (pattern: `34-hub-new.yaml`,
   `26-drawer.yaml:86-108`): `_pair.yaml` → tap `computer-${output.computerId}`
   → `sessions-list` visible → `_shot.yaml` (the bar, for the owner's
   simulator QA) → tap `sessions-new` → `session-view` + `transcript-empty`
   visible → wait `turn-idle` → `inputText: "NEWPROJECT flow forty-seven"` with
   NO tap on the field (proves `focus`) → `composer-send` → `turn-idle` → (no
   back step: the Session screen's header has no back testID and Maestro has no
   iOS edge swipe, `26-drawer.yaml:13-15`) →
   `runScript: 47-project-new-session.js`, which reads
   `http://${MAESTRO_HOOKS}/model-prompts` and throws unless one prompt contains
   «NEWPROJECT flow forty-seven» (the `26-drawer.js:21-30` pattern: the create
   happened at the tap on THIS computer and the first send ran).
   The offline refusal is pinned by test 1, not by Maestro (the harness runs
   one `serve`; stopping it is flow 05's territory).

Gate before done (§4): `bun run check` green (lint baseline clean), plus the
mobile e2e gate on the changed flows (`--only 47-project-new-session,26-drawer,34-hub-new`)
and simulator screenshots of the new bar (light + dark, list + offline) for the
owner before the next build.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check** (before any edit): `bun test
apps/mobile/test/new-session-link.test.ts` → 2 pass, 0 fail;
`session-host.ts:1154-1188` creates under the daemon's own build, no client cwd.
**Repro:** `SessionsScreen.tsx` had no match for `New
session|onNewSession|newSession`.

**As built, in order**

1. `drawer-new-session.ts` — `dispose()`; a create settling after it returns
   before any state write or `opened`. Red: 2 fail, `flow.dispose is not a
   function`.
2. `project-new-session.ts` (new) — view + tap + the three reason constants.
   Red against a throwaway stub (so on assertions, not the import): 0 pass,
   10 fail.
3. `SessionsScreen.tsx` — the three props, error line + pinned bar, D6 copy
   (the now-unused `MONO` import dropped). Red: the new `band-screens` test
   (`sessions-new-error` index -1).
4. `App.tsx` — module-level `createOnComputer` (both callers), `SessionsRoute`
   `onCreated` + flow + dispose in the controller's unmount effect, `navigate`
   with `focus: true`.
5. `e2e/flows/47-project-new-session.{yaml,js}`, registered after `34-hub-new`
   in `run.ts`; changelog fragment.

**Mutations** (each applied, run, reverted):

```
dispose guard removed            -> 14 pass, 2 fail
  (fail) D7: a create that succeeds AFTER dispose opens nothing and writes no state
  (fail) D7: a create that fails AFTER dispose opens nothing and writes no state
stale gate dropped for a loaded list
  (`list.stale && list.status !== "loaded"`)  -> 8 pass, 2 fail
  (fail) link down: dimmed «Offline — reconnecting»; link up and a page enables it again
  (fail) a failed refresh of a list with rows is stale: «Offline — reconnecting»
```

**Drift / choices the plan did not spell out**

- `SessionsRoute`'s `create` is `(_, id) => createOnComputer(computerId, id)`,
  not the bare function: `computerId` is then a real `useMemo` dependency
  (Biome rejected it otherwise).
- D3's rows overlap; precedence is `failed` > `stale` > «Connecting…», so a
  link that drops before the first answer reads «Offline — reconnecting».
- Flow 47 also asserts `sessions-new` before the shot and no `transcript-empty`
  after the turn, and calls `hideKeyboard` before send (flow 26's pattern).
- The error line's side padding is 20 pt (`space.rowX`, the drawer's); the
  reason has 10 pt of its own so it starts at the same 20 pt.

**Checks run:** Biome on the 9 changed lintable files: clean. `bunx tsc -p
apps/mobile`: no output. The tests that cover or read the changed files (116
files in one serial process): 2165 pass, 1 fail —
`artifact-card-render.test.ts`, `Export named 'Animated' not found`; alone it
is 5 pass, 0 fail (shared module registry in a serial multi-file run). The full
`bun run check` is the orchestrator's.

**Not verified:** flow 47 and the other e2e flows were not run (no simulator
run), so the bar's pixels, focus on open and the `App.tsx` wiring at runtime are
unseen; run the e2e gate with `--only
47-project-new-session,26-drawer,34-hub-new` and take the light/dark/offline
screenshots. The mockup page was not opened.

**For the Review (seen, deliberately not changed — outside the plan)**

- D7 covers unmount only. A row tapped while a create is in flight leaves the
  Sessions screen mounted underneath, so the finished create would still call
  `navigate("Session", …)` over the opened session (the navigator's exact
  behaviour there was not exercised). A `navigation.isFocused()` guard in
  `onCreated` would close it, if approved.
- A re-read of an EMPTY list is `loading` with no rows
  (`session-list.ts:124`), so the pill dims to «Connecting…» for that round
  trip (pull-to-refresh, or returning to an empty project). This follows D2/D3
  as written.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-26*

**Review 1 (MEDIUM, a late create swaps out an opened row's session): fixed.**

- `project-new-session.ts` — `openCreatedSession(list, open)`: opens only while
  `list.isFocused()`.
- `App.tsx` — the `Sessions` screen's `onCreated` goes through it with that
  screen's `navigation`; import widened.
- `project-new-session.test.ts` — 4 tests: the REAL `StackRouter` (resolved
  through `@react-navigation/native` → `core` → `routers`, no new dependency)
  under the real create flow (list in front → opens; row opened meanwhile →
  stays; back on the list before it settles → opens), plus a source pin of the
  `App.tsx` wiring.

**Drift from D4/D7:** a finished create opens nothing also when the Sessions
screen is mounted but not in front. If the person is back on the list when it
settles, it opens (they tapped it, and the pill was still busy). A create that
FAILS meanwhile keeps its error line for when they return. The drawer's flow is
unchanged.

**Red** (stub `openCreatedSession` that always opens, `App.tsx` untouched):

```
(fail) … > a row opened meanwhile stays: the new session does not replace it
     "Sessions",
  -  "ROW-X",
  +  "NEW",
(fail) … > the Sessions route opens through that guard, with its own navigation
```

**Mutations** (each applied by hand, run, reverted):

```
guard removed (always opens)        -> 13 pass, 1 fail
  (fail) a row opened meanwhile stays
guard inverted (!list.isFocused())  -> 11 pass, 3 fail
  (fail) list still in front / row opened meanwhile / back on the list
App.tsx bypasses openCreatedSession -> 13 pass, 1 fail
  (fail) the Sessions route opens through that guard
```

**Checks run:** the test files that mention `App.tsx`, plus
`drawer-new-session.test.ts`: 779 pass, 0 fail (43 files, `--parallel`). Biome
on the 3 changed code files: clean. `bunx tsc -p apps/mobile`: no output. The
full gate is the orchestrator's.

**Not verified:** no simulator run. That the native stack's
`navigation.isFocused()` reads false under an opened row is React Navigation's
contract, modelled in the test by the router's focused route; check by tapping
New session and then a row on a slow link. Flow 47 still not run.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; planner was the same model, so
shared blind spots are possible — executor was Sonnet)

**Verdict: REQUEST-CHANGES** (one MEDIUM).

**Findings**

1. **MEDIUM — a create that settles while a row's session is open swaps that
   session out from under the person.** `App.tsx:1663-1673` (`onCreated` →
   `navigation.navigate("Session", …)`). D7 guards unmount only; tapping a row
   while the create is in flight keeps `SessionsRoute` mounted (and its flow
   live), and the `Session` stack screen has no `getId`
   (`App.tsx:3682`). React Navigation 7's `StackRouter` NAVIGATE reuses the
   FOCUSED route when its name matches, replacing its params. Repro against the
   real router (`.tentacle/tmp/mobile-project-new-session/nav-race.ts`):
   `Sessions` → navigate `Session{ROW-X}` → navigate `Session{NEW-Y}` ⇒
   `["Computers", "Sessions", "Session:NEW-Y:<same key>"]` — the open
   session ROW-X is silently replaced by NEW-Y, same route key. The executor
   flagged this; it is a real, user-visible wrong state reachable by a
   slow create (session/open + detach round trip) plus one impatient tap.
   Fix: open only when the Sessions screen is still focused (e.g. a
   `navigation.isFocused()` check in `onCreated`, or `dispose()`/a "blur" guard
   via the flow), with a pure-module or wiring test; the session stays listed
   (D7's convergence).

**Gate (this worktree):** touched tests `project-new-session`,
`drawer-new-session`, `band-screens`: 63 pass, 0 fail. `bun run lint`: clean
(2638 files). `bun run typecheck`: clean. Full `bun run test` not re-run
(orchestrator's gate); e2e flow 47 not run (no simulator).

**Mutations** (each applied, run, reverted; `git status --porcelain` empty after):
dispose guard off → 2 D7 tests fail; `stale` branch off → 3 offline tests fail;
pill `icon="plus"` → `"add"` → the band-screens placement test fails. All
non-vacuous.

**Premises:** `PillButton` passes `onPress` while disabled (`PillButton.tsx:72-73`)
TRUE; one create path shared by drawer and list (`createOnComputer`,
`App.tsx:786`) TRUE — no copied send logic (§7 one-session-path holds); only
typed failure texts reach the screen (untrusted pod, §7) TRUE; no protocol
change TRUE.

**Attacks tried:** (a) late navigate over an opened row — FOUND (1). (b) flow
disposed but reused (would leave `creating` stuck and create orphans) — every
memo in `SessionsRoute` keys on `computerId` only and no `StrictMode` wrapper
exists, so dispose and re-create move together: nothing. (c) Gate flicker on
pull-to-refresh of a non-empty list — stays `loaded`, pinned by test: nothing.
(d) Reason by hue alone — reasons are words, error line is red text + words:
nothing.

**Executor behaviour:** followed the plan in order, showed red, ran mutations,
and honestly surfaced the race above as out-of-plan instead of hiding it.
