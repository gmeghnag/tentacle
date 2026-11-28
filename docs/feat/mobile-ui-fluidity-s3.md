# feat/mobile-ui-fluidity-s3 — Session store + `useSlice`: a streamed token wakes only the transcript

> **Status:** implementation (APPROVED — orchestrator decisions below, owner-delegated)
> **Branch:** `feat/mobile-ui-fluidity-s3`
> Type: feat · Size: M · Blast: cross-module · Suited: Opus plan + fresh Opus review (owner night rule), Sonnet exec
> **Changelog:** `changelog.d/mobile-ui-fluidity-s3.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-28*

Slice 3 of the APPROVED eval `docs/eval/mobile-ui-fluidity.md` (owner 28/11, Owner
decision 1). Only Migration-plan row 3 is in scope: **session store + `useSlice`**.
It holds slices, publishes them preserving identity, and takes the render
coalescer inside. The session screen subscribes per slice (header, composer, hub,
sheets). Row 4 (the list off the stream path, the `tail` split), row 5 (fan
without JS timers) and row 7 (activity-sheet clock) are NOT in scope.

**Root cause this slice addresses** (eval, Root cause + "Why it is a class"): the
screen holds ONE `SessionScreenState` (`SessionScreen.tsx:354`, set at `:396-403`).
So every notification re-renders the whole screen: header, composer, hub, sheets
and the list. Any new prop, effect or emit couples the stream to everything again
(the regression `06d8d093` re-doubled renders the day after the fan-jank fix).
Today nothing can express "a delta re-renders only what it changed". This slice
makes that property a tested contract.

**Earlier slices (merged on `main`), drift that matters here:**

- s0: flow `90-perf-stream` + `e2e/perf-budget.ts` is the gate. A `ptrace` line
  with an unknown `ev` is ignored, and one with no `ev` is an evidence violation
  (s0 Execution, Drift). Jank lines are written ONLY for windows with a gap
  (`perf-trace.ts:105-107`). So a smooth run carries no `renders`/`renderMs`
  evidence at all.
- s1: `thumbnails.ts` `view()` commits only on a real change. The screen's
  `rows`-keyed `controller.window` effect (`SessionScreen.tsx:854-856`) stays,
  and costs no notification.
- s2: the Thinking clock is the native `ClockText`. Flow 90 on s2 is **PASS, 0
  jank lines, fan settle 1068/1064/1068/1084 ms** (s2 Execution, Fix round 2).
  That is the bar this slice must hold.

**Repro** (2026-11-28, this worktree = `main` `ab3a158c`, no source edited):
`.tentacle/tmp/mobile-ui-fluidity-s3/fields.ts` drives the REAL controller with
30 reasoning deltas, 10 ms apart, after 2 warm-up deltas. It compares each pair
of consecutive notified states field by field: same reference / deep-equal.

```ts
// Which SessionScreenState fields change across consecutive reasoning-delta notifications?
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { createSessionController } from "../../../apps/mobile/src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../../../apps/mobile/src/session-screen-controller.ts";

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
let watcher: ((a: SessionActivity) => void) | null = null;
const clock = { at: 1000 };
const timers: { at: number; fn: () => void; live: boolean }[] = [];
const states: SessionScreenState[] = [];
const handle: SendableHandle = {
  open: () => Promise.resolve(),
  detach: () => Promise.resolve(),
  watch: (fn) => {
    watcher = fn;
    return () => {};
  },
  async *send() {},
};
const screen = createSessionScreen({
  sessionId: "s1",
  archived: false,
  title: "A",
  project: "p",
  controller: createSessionController<SendableHandle>({ newSession: () => handle }),
  broker: new PermissionBroker(undefined, { holdUntilSet: true }),
  now: () => clock.at,
  schedule: (fn, ms) => {
    const t = { at: clock.at + ms, fn, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  },
});
screen.subscribe((s) => states.push(s));
await screen.open();
await settle();
const q: SessionEvent[] = [];
let wake: (() => void) | null = null;
const events = (async function* () {
  for (;;) {
    const n = q.shift();
    if (n) {
      yield n;
      continue;
    }
    await new Promise<void>((r) => {
      wake = r;
    });
  }
})();
watcher?.({ kind: "turn", turnId: "t1", events, cancel: () => {} } as SessionActivity);
await settle();
for (let i = 0; i < 2; i++) {
  q.push({ type: "reasoning", delta: "warm " } as SessionEvent);
  wake?.();
  await settle();
  clock.at += 200;
  for (const t of timers) if (t.live && t.at <= clock.at) { t.live = false; t.fn(); }
  await settle();
}
const from = states.length;
for (let i = 0; i < 30; i++) {
  q.push({ type: "reasoning", delta: "tok " } as SessionEvent);
  wake?.();
  await settle();
  clock.at += 10;
  for (const t of timers) if (t.live && t.at <= clock.at) { t.live = false; t.fn(); }
  await settle();
}
const pairs = states.slice(from - 1);
const sameRef = new Map<string, number>();
const deepSame = new Map<string, number>();
const viewSameRef = new Map<string, number>();
const viewDeep = new Map<string, number>();
for (let i = 1; i < pairs.length; i++) {
  const a = pairs[i - 1] as SessionScreenState;
  const b = pairs[i] as SessionScreenState;
  for (const k of Object.keys(b) as (keyof SessionScreenState)[]) {
    if (a[k] === b[k]) sameRef.set(k, (sameRef.get(k) ?? 0) + 1);
    if (deepEq(a[k], b[k])) deepSame.set(k, (deepSame.get(k) ?? 0) + 1);
  }
  for (const k of Object.keys(b.view) as (keyof SessionScreenState["view"])[]) {
    if (a.view[k] === b.view[k]) viewSameRef.set(k, (viewSameRef.get(k) ?? 0) + 1);
    if (deepEq(a.view[k], b.view[k])) viewDeep.set(k, (viewDeep.get(k) ?? 0) + 1);
  }
}
const n = pairs.length - 1;
console.log(`notifications during 30 deltas: ${n}`);
console.log("top-level field: sameRef/deepEqual of", n);
for (const k of Object.keys(pairs[0] as object)) console.log(`  ${k}: ${sameRef.get(k) ?? 0}/${deepSame.get(k) ?? 0}`);
console.log("view field: sameRef/deepEqual of", n);
for (const k of Object.keys((pairs[0] as SessionScreenState).view)) console.log(`  view.${k}: ${viewSameRef.get(k) ?? 0}/${viewDeep.get(k) ?? 0}`);
process.exit(0);
```

```
$ bun .tentacle/tmp/mobile-ui-fluidity-s3/fields.ts
notifications during 30 deltas: 3
top-level field: sameRef/deepEqual of 3
  slot: 3/3        commands: 0/3     status: 3/3      transcript: 0/0
  draft: 3/3       notice: 3/3       view: 0/0        sheet: 3/3
  thumbnails: 3/3  compose: 0/3      info: 3/3        riskStrip: 3/3
  renaming: 3/3    sends: 3/3        activity: 3/3    schedules: 3/3
  refreshing: 3/3  artifacts: 3/3    catalogue: 3/3
view field: sameRef/deepEqual of 3
  view.title: 3/3        view.project: 3/3     view.headerModel: 3/3
  view.headerFolder: 3/3 view.headerContext: 3/3  view.rows: 0/0
  view.turn: 3/3         view.composer: 0/3    view.queued: 0/3
  view.returnedOthers: 0/3  view.pending: 0/3  view.editing: 3/3
  view.unqueueOff: 3/3   view.outbox: 0/3      view.photos: 0/3
  view.notices: 0/3      view.state: 3/3       view.banner: 3/3
  view.retry: 3/3        view.reopen: 3/3      view.editable: 3/3
```

(Output re-flowed into columns, values unchanged.) Read it like this: across
reasoning deltas only `transcript` and `view.rows` change content (`0/0`). Nine
facts are **fresh objects with equal content** (`0/3`): `commands`, `compose`,
`view.composer`, `queued`, `returnedOthers`, `pending`, `outbox`, `photos`,
`notices`. They are rebuilt by `state()` (`session-screen-controller.ts:1244-1268`),
`composeView()` (`:1055`), `view()` (`:1110`) and `commands()` (`:1220`). Today the
screen gets a new object for all of them on every notification. A slice that
compares them structurally keeps its identity.

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (owner delegated the details;
orchestrator decisions below; no AGENTS §7 trust rule touched).

### Load-bearing assumption

**On a streamed reasoning/text delta, every fact the header, composer, hub and
sheets read is structurally unchanged. Only the transcript's rows change.** If
that is true, identity-preserving slices plus memoized panes take those four
subtrees off the stream path. If it were false, slicing would buy nothing.

Proven by the Repro above, on the real controller: `transcript` and `view.rows`
are the only facts whose content changes. Every other fact is either the same
reference (`3/3`) or deep-equal (`0/3`). The derived hub inputs read
`transcript.link/turn/closed` (`SessionScreen.tsx:1435-1438`), and these do not
change during a turn's deltas: `view.turn` is `3/3`, and `link`/`closed` move only
on a link or end event. `reportsOf(transcript.rows)` (`SessionScreen.tsx:1050`)
changes only when a sub-agent report row lands. It costs ≤ 0.05 ms JIT / 0.42 ms
interpreter at 701 rows (eval, Repro C).

### Preconditions

- **Every screen notification goes through one function.** `notifyListeners`
  (`session-screen-controller.ts:1533-1543`) is reached only through the coalescer
  (`:1505-1517`): `render.soon()` for a stream fold (`:900-904`) and `emit()` →
  `render.now()` for everything else. `render.dispose()` runs at dispose
  (`:2412-2413`). One seam, so the store replaces it without a second path.
- **The coalescer is pure, injectable and already tested**
  (`render-coalesce.ts:44-82`, `test/render-coalesce.test.ts`). The store reuses
  it unchanged.
- **The screen's only state subscription** is `controller.subscribe` →
  `setState(next)` (`SessionScreen.tsx:392-409`). It also runs `composeRowsMoved`
  → `animateNextLayout()` (`:397-399`) and `PERF.notify()` (`:401`).
- **React 19.3.0** (`apps/mobile/package.json:35`). `useSyncExternalStore` is
  already the repo's external-store pattern (`src/use-since.ts:7,32`).
- **The latest-ref pattern for stable callbacks exists**: `cellActions`, ONE
  stable handle refreshed every render (`SessionScreen.tsx:875`, `:952-972`).
- **The native sheets are re-published on every render.** The `SHEET_HOSTS`
  publish `useLayoutEffect` (`SessionScreen.tsx:1569-1688`) has no dependency
  array. Today every delta re-publishes the Commands / Outbox / Tools / Permission
  sheet elements.
- **The hub's props are computed in the shell on every render**
  (`hubCtx`/`hubEntries`, `SessionScreen.tsx:1431-1467`; `<FloatingActivity>`
  `:2340-2369`, with inline closures `solve`, `onMenu`, `onDrop`). Without memoized
  props, the hub re-renders on every delta. That is the eval's table row "Hub
  itself — not memoized".
- **The mobile test suite cannot render React Native** (no renderer in
  `test/`; the `*-wiring.test.ts` files are source pins, e.g.
  `test/fan-jank-wiring.test.ts:29-95`). So "a pane does not re-render" can be
  proven in pure code only up to slice identity. Whether props stay stable can
  only be measured in the app. Hence decision 5.
- **The existing pin on the coalescer's call shape** (`fan-jank-wiring.test.ts:49-55`:
  `render.soon()` / `function emit(): void { render.now(); }` / `render.dispose()`)
  WILL break by design. It is rewritten to the new seam (Tests C), not deleted.
- No protocol, persistence or §7 trust surface is touched. This is mobile app
  code only.

### Orchestrator decisions

*(owner-delegated, 28/11; the recommended option is taken in each case)*

1. **The stream slice is `rows` in this slice. `tail` is s4's.** A delta changes
   the last row inside `view.rows`. Splitting the streaming row out of the
   `FlatList` data is exactly row 4 ("the streaming row + Thinking tail from the
   `tail` slice outside the `FlatList` data"). So the row-3 check "a reasoning
   delta changes ONLY `tail`" reads here as **"changes ONLY `rows`"**, and s4
   narrows it to `tail`. *Rejected:* building `tail` now. It needs the list
   change, which is s4's scope.
2. **Equality is chosen per fact, never deep on big data.** Each fact in the
   slice map says `ref` (`Object.is`: `transcript`, `view.rows`, `thumbnails`,
   `artifacts`, `info`, `sheet`) or `data`: a conservative structural compare over
   plain objects, arrays and primitives. Anything else (functions, class instances,
   `Map`/`Set`, non-plain prototypes) is compared with `Object.is`. `data` may say
   "different" when the values are equal (one extra render), but **never "equal"
   when they differ** (a stale pane). *Rejected:* whole-slice `JSON.stringify` (it
   drops functions and `undefined`, so it can call different values equal).
3. **`controller.subscribe(listener)` stays**, as the store's whole-state
   `onPublish`: every publish, exactly as today, before the slice listeners. 300+
   controller tests and `deps.onChange` (`:442`, `:1539`) keep their contract. The
   SCREEN stops using it (pinned).
4. **Four panes; the route reconciler stays in the shell.** New memoized
   components under `src/screens/session/`: `HeaderPane` (the `<ScreenHeader>`
   block, `SessionScreen.tsx:1943-2089`), `ComposerPane` (QueueRows / OutboxRows
   / Chips / Composer, `:2376-2549`), `HubPane` (`<FloatingActivity>` and its
   `hubCtx`/`hub` derivation, `:1429-1467`, `:2339-2370`) and `SheetsPane` (the
   `SHEET_HOSTS` publish effect `:1569-1688`, now keyed on its inputs, plus the
   inline sheets `:2550-2700`). The navigation reconciler (`:1700-1830`) stays in
   the shell: it is navigation logic over the shell's own state, and it is not
   re-run per delta (its effects have deps). *Rejected:* moving the reconciler too.
   That doubles the diff for no stream-path gain.
5. **Measure the property in the app: an `ev=panes` line and a `coupling` rule.**
   The pure test proves that slices keep identity. Only the app can show that a
   pane's props stay stable (one inline closure undoes the work, and nothing in
   `bun test` would see it). The probe counts renders per pane while a stream runs
   and writes ONE `ptrace ev=panes` line when streaming stops. `perf-budget` adds
   the rule `coupling`, and a flow-90 log without that line is an evidence
   violation. This is additive (an unknown `ev` is already ignored, s0) and
   AI-free. *Rejected:* trusting the pins alone. That would be the "proves a
   correlate" trap of AGENTS §2.
6. **A publish during a publish is queued, not nested.** Today a listener that
   calls `emit()` re-enters `notifyListeners`. The outer loop then hands the
   OLDER `next` to the remaining listeners after the newer one: a latent
   reorder. The store drains a FIFO instead. Every listener sees states in
   publish order.
7. **`PERF.render` stays shell-only** (render start → layout effect, which already
   includes any pane rendered with the shell). A pane that renders alone (a
   composer-only change) is counted in `ev=panes`, not in `renders`. The gate's
   `rate` therefore reads only the shell, and that is stated in the report line.

### Design

**`src/session-store.ts`** (pure, React-free):

```ts
export type SliceKey = "rows" | "header" | "composer" | "hub" | "sheets";
export interface SessionSlices { readonly rows: RowsSlice; readonly header: HeaderSlice;
  readonly composer: ComposerSlice; readonly hub: HubSlice; readonly sheets: SheetsSlice }
export function deriveSlices(s: SessionScreenState): SessionSlices;          // fresh objects
export function keepSlices(prev: SessionSlices | null, next: SessionSlices): SessionSlices; // per-slice identity
export function sameData(a: unknown, b: unknown): boolean;                    // decision 2
export const SLICE_FACTS: { readonly [K in keyof Omit<SessionScreenState, "view">]: readonly SliceKey[] }
  & { readonly [K in keyof SessionView as `view.${K}`]: readonly SliceKey[] };  // TOTAL: a new field won't compile until classified
export interface SessionStore {
  publish(cause: "stream" | "now"): void;       // stream → coalesced (createRenderCoalescer), now → at once
  get<K extends SliceKey>(key: K): SessionSlices[K];  // lazy first derive; stable between publishes
  subscribe(key: SliceKey, fn: () => void): () => void; // fires only when THAT slice's identity changed
  onPublish(fn: (s: SessionScreenState) => void): () => void; // every publish (decision 3)
  dispose(): void;                              // drops a pending publish; later publishes are no-ops
}
export function createSessionStore(deps: { read(): SessionScreenState; clock(): number;
  schedule(fn: () => void, ms: number): () => void; windowMs?: number }): SessionStore;
```

At fire time: `full = read()` → `slices = keepSlices(prev, deriveSlices(full))`.
Then the `onPublish` listeners, then each slice listener whose slice is a new
object. A publish raised while firing is queued and drained after (decision 6).
`keepSlices` returns the previous slice object when every fact of that slice is
equal under its policy.

**Slices: initial membership.** The executor finalizes it by mapping every
`state.X` read in `SessionScreen.tsx` (112 reads) to its consumer, and records
the final map in Execution. A fact may sit in more than one slice.

| Slice | Read by | Facts |
|---|---|---|
| `rows` | the shell (list, scene, follow, voice turn end, sticky output) | `transcript`, `view.rows`, `view.turn`, `thumbnails`, `artifacts`, `status`, `slot`, `view.banner`, `sends`, `view.composer.running` |
| `header` | `HeaderPane` | `view.title/project/headerModel/headerFolder/headerContext/state/banner/retry/reopen`, `status.phase`, `renaming`, `transcript.link` (derived) |
| `composer` | `ComposerPane` | `draft`, `notice`, `sends`, `compose`, `riskStrip`, `view.composer/editable/queued/returnedOthers/outbox/photos/notices/pending/editing/unqueueOff` |
| `hub` | `HubPane` | `transcript.link/turn/closed` (derived), `view.composer.running`, `activity`, `schedules`, `catalogue`, `artifacts.list`, `slot`, `commands`, `reports` (= `reportsOf(transcript.rows)`, `data` policy) |
| `sheets` | `SheetsPane` + the shell's reconciler | `sheet`, `info`, `commands`, `activity`, `renaming`, `compose` (outbox decisions), `refreshing` |

**`src/use-slice.ts`**: `useSlice(store, key)` =
`useSyncExternalStore(useCallback((fn) => store.subscribe(key, fn), [store, key]), () => store.get(key))`.
It is the only way a component reads session state.

**Controller** (`session-screen-controller.ts`): `render` (`:1505-1514`) becomes
`const store = createSessionStore({ read: () => { followBrowserTools(); return state(); }, clock, schedule })`.
`emit()` → `store.publish("now")`. The stream branch (`:900-904`) →
`store.publish("stream")`. `notifyListeners`'s `deps.onChange` and the listener
set move into a store `onPublish` (decision 3). `dispose` → `store.dispose()`. The
interface gains `sessionStore(): SessionStore`. The `disposed` guard stays.

**Screen** (`SessionScreen.tsx`):

- `useState<SessionScreenState>` + `controller.subscribe` (`:354`, `:392-409`) are
  replaced by `const store = controller.sessionStore()` and `useSlice(store,
  "rows")`. Add `useSlice` for any slice whose facts the shell itself still reads.
- The mount effect keeps `void controller.open()` / `leave()`. It adds
  `store.subscribe("composer", …)` for `composeRowsMoved` → `animateNextLayout()`
  (still before React's commit: uSES re-renders are scheduled, not run inside
  the listener). It also adds `store.onPublish(() => PERF.notify())`, so the
  `notifies` count keeps meaning "publishes".
- Each pane is `memo(function XPane(props))`. Its props are ONLY: `store`,
  `palette`, ONE latest-ref `actions` (`useRef`, refreshed every shell render,
  the `cellActions` pattern), and shell locals that are primitives or React
  state / memoized values. Module stores (`ACTIVITY_SETTINGS`, `VOICE_SETTINGS`,
  …) are subscribed by the pane that uses them, where possible. A pane reads
  other slices only through `store.get(key)` inside handlers, never in render (no
  tearing). It never subscribes to `rows`.
- Every pane calls `PERF.pane("<name>")` in its render body (decision 5).

**Perf** (`perf-trace.ts`, `perf-probe.ts`): `PERF.pane(name)` counts renders per
pane while streaming. On the streaming falling edge (`streaming(false)`), it
writes `ptrace ev=panes shell=<renders during the stream> header=… composer=… hub=… sheets=…`
and resets. The meter's `render()` count during the stream is `shell`.

**Budget** (`e2e/perf-budget.ts`): new rule `coupling`. For an `ev=panes` line
with `shell ≥ 50`, every pane count must be `≤ max(10, 0.1 × shell)`. If a log
has no `ev=panes` line with `shell ≥ 50`, the existing `evidence` rule fires. A
pane field that is missing or not a number is also `evidence`. The report prints
the panes figures. In flow 90 (≈ 120 s of stream at ≤ 10/s) the shell renders
hundreds of times. The hub renders only on its 4 opens/closes and the catalogue
refresh (row 5's debt), so the margin is wide on both sides: 100 % before this
slice, a few % after.

### Files

In dependency order:

1. `apps/mobile/src/session-store.ts` (new): slices, `sameData`, `SLICE_FACTS`,
   the store with the coalescer inside.
2. `apps/mobile/src/use-slice.ts` (new).
3. `apps/mobile/src/session-screen-controller.ts`: the store replaces
   `render`/`notifyListeners`; `sessionStore()`; the stream branch and `emit`.
4. `apps/mobile/src/perf-trace.ts` (panes line builder),
   `apps/mobile/src/perf-probe.ts` (`pane()`, written at the streaming falling
   edge).
5. `apps/mobile/src/screens/session/HeaderPane.tsx`, `ComposerPane.tsx`,
   `HubPane.tsx`, `SheetsPane.tsx` (new; JSX moved, not rewritten).
6. `apps/mobile/src/screens/SessionScreen.tsx`: the shell on `useSlice`, the four
   panes mounted, the `SHEET_HOSTS` publish moved into `SheetsPane`.
7. `apps/mobile/e2e/perf-budget.ts`: the `coupling` rule, panes evidence, the
   report line.
8. Tests (below) and `changelog.d/mobile-ui-fluidity-s3.fixed.md`:
   `- **Mobile: a streaming reply no longer re-renders the session's header, composer, hub and sheets.** Each part of the session screen now follows only its own state, so taps and animations keep up with long sessions while the model streams.`

No protocol, schema, `protocol.d/` note or `protocol.json` change. No new
dependency. No native code, so a JS-only build.

### Failure modes

| Failure | How it converges / is designed out |
|---|---|
| A fact in the wrong slice → a pane is stale (frozen UI) | `SLICE_FACTS` is total over `SessionScreenState` and `SessionView` (a new field is a compile error until classified). Test A2 changes each fact and asserts EXACTLY its slices change. `sameData` is conservative (decision 2): an error costs an extra render, never staleness. |
| A pane prop is unstable (an inline closure or object) → the pane re-renders per delta and the slice buys nothing, silently | `ev=panes` + `coupling` (decision 5) fails flow 90. Source pin B2 forbids inline arrow props on the pane elements. |
| Lost or reordered state under coalescing | The publish carries no data, and `read()` at fire time is the latest. `now` absorbs a pending `stream` (unchanged `render-coalesce.ts`). A re-entrant publish is queued FIFO (decision 6, Test A5). |
| Tearing: a pane renders slice A new and slice B old | Render reads only through `useSlice` (uSES keeps snapshots consistent per commit). `store.get` is used in handlers only (pin B3). |
| First render before any publish | `get()` derives lazily from `read()` on first call. The screen's first `useSlice` reads the attach-time state, as `useState(() => controller.state())` did. |
| Dispose with a pending stream publish | `store.dispose()` cancels the timer and drops it; a later publish is a no-op (Test A6). Same as `render.dispose()` + `disposed` today. |
| Controller remount / new controller | `store` comes from the controller. `useSlice`'s subscribe is keyed `[store, key]`, so it re-subscribes. |
| Layout animation of queue/outbox rows lost | The `composer` slice listener calls `animateNextLayout()` synchronously in the publish, before React commits. Same timing as today's `subscribe` callback. Checked in flow 90 / the compose flows' screenshots (no new e2e). |
| `notifies` meaning drifts in the trace | `PERF.notify` hangs on `onPublish`: one per publish, as before. `renders` stays shell-only (decision 7), stated in the report. |
| A smooth run gives no `ev=panes` line (no streaming falling edge before the read-back) | That is an `evidence` violation, never a pass. If flow 90 really ends the stream after the read-back, the executor STOPS and reports. They do not move the read-back or weaken the rule. |

### Tests

Red first on the ASSERTION: create each new module as a stub with the right
exports (`keepSlices = (_, next) => next`, no `ev=panes` line, no `coupling`
rule), see the tests fail, then implement.

**A. `apps/mobile/test/session-store.test.ts`** (pure; the real controller via
the `harness`/`pushedTurn`/`settle` helpers of
`test/session-screen-stream-render.test.ts`):

1. **The row-3 check:** 30 reasoning deltas → after each publish, `get("rows")`
   is a new object, and `header`, `composer`, `hub`, `sheets` are `toBe` the
   previous ones. Their subscribers' call counts stay 0 during the deltas.
2. **Exhaustive facts:** for every `SLICE_FACTS` key, a fixture state with that
   one fact changed (a new, different value) changes EXACTLY the listed slices.
   The remaining slices keep identity.
3. `sameData`: equal plain nested data → true; a differing leaf / a longer array /
   `undefined` vs missing key → false; two different functions, `Map`s or class
   instances with equal content → false (conservative); the same function → true.
4. Coalescing at the store seam: 100 `stream` publishes over 1 s (fake clock) →
   ≤ 10 fires. A `now` absorbs a pending `stream`.
5. Re-entrant: an `onPublish` listener that publishes `now` → every listener sees
   states in publish order. No listener gets an older state after a newer one.
   (Red on a nested-fire stub.)
6. Dispose: a pending `stream` publish never fires; publishes after dispose do
   nothing.
7. `controller.subscribe` / `deps.onChange` still fire on every publish (decision 3).

**B. `apps/mobile/test/session-slices-wiring.test.ts`** (source pins, comment-stripped
like `fan-jank-wiring.test.ts:15-16`):

1. No file under `src/screens/session/` or `src/ui/` names `SessionScreenState`.
   `SessionScreen.tsx` has no `useState<SessionScreenState>` and no
   `controller.subscribe(`.
2. Each pane file exports a `memo(` component and calls
   `useSlice(store, "<its slice>")`. None calls `useSlice(store, "rows")`. The
   four pane elements in `SessionScreen.tsx` take no inline `=> ` prop.
3. Panes call `store.get(` only inside a function body, never at render top level.
   This one is a heuristic pin: the executor documents its regex.
4. The `SHEET_HOSTS` publish is no longer a dependency-less `useLayoutEffect` in
   `SessionScreen.tsx`.
5. Each pane calls `PERF.pane(`.

**C. `apps/mobile/test/fan-jank-wiring.test.ts`:** rewrite the pin at `:49-55` to
the new seam (`store.publish("stream")` in the stream branch, `emit` →
`store.publish("now")`, `store.dispose()`). It pins the same property at its new
home. Not deleted.

**D. `apps/mobile/test/perf-trace.test.ts`, `perf-budget.test.ts`:** the panes
line on the falling edge (counts, reset, nothing while not streaming).
`coupling`: a synthetic log where `hub=400 shell=500` → violation; `hub=8
shell=500` → ok; `shell=20` → no verdict, plus `evidence` when no other panes line
exists; a missing or non-numeric pane field → `evidence`. Extend the
`perfOutcome` table.

**Mutations** (apply, see red, revert; record them in Execution):
(a) `keepSlices` always returns `next` → A1/A2 red.
(b) move `draft` out of `composer` in `SLICE_FACTS` only → A2 red.
(c) nested fire instead of the queue → A5 red.
(d) in the app, ONE inline closure prop on `<ComposerPane>` → flow 90 `coupling`
red. This is the non-vacuity of the runtime rule: run once on the simulator if
time allows, else state it unrun.

**Gate 0 (simulator), AI-free.** Take
`/Users/gmeghnag/tentacle/.tentacle/tmp/orchestration/sim.lock` (`mkdir`; wait
while it exists) and `rmdir` it after. Run
`bun run e2e:mobile --udid <iPhone 17 Pro> --only 90-perf-stream`. It must be
Maestro PASS and `perf.txt` PERF PASS with 0 violations, including `coupling`
(hold: s2 had 0 jank lines and fan settle 1064–1084 ms). Record the `ev=panes`
line (expected: header/composer/sheets ≈ 0 and hub ≤ a few dozen, against shell
in the hundreds). Do not publish a build, and do not touch `~/bin` or any running
`serve`.

Narrow iteration: `bun test apps/mobile/test/session-store.test.ts` (+ the B, C
and D files). Before done: `bun test apps/mobile/test/`, `tsc -p apps/mobile`,
`biome check` on the changed files. The full `bun run check` is run by the
orchestrator's script.

## Execution

*(empty — the executor's)*

## Review

*(empty — fresh-context Opus review, mandatory for this slice per the eval)*
