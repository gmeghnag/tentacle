# feat/mobile-ui-fluidity-s4 — The transcript list off the stream path

> **Status:** implementation (APPROVED — orchestrator decisions below, owner-delegated)
> **Branch:** `feat/mobile-ui-fluidity-s4`
> Type: feat · Size: M · Blast: cross-module · Suited: Opus plan + fresh Opus review (owner night rule), Sonnet exec
> **Changelog:** `changelog.d/mobile-ui-fluidity-s4.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-28*

Slice 4 of the APPROVED eval `docs/eval/mobile-ui-fluidity.md` (owner 28/11).
Scope is Migration-plan row 4 only: **a stable `renderItem`, a slim `extraData`,
and the streaming row + Thinking tail read from a `tail` slice instead of the
`FlatList` data.** The eval's check: "renders of the list per delta = 0 while
only the tail changes". Row 5 (hub fan timers), row 6 (ingestion budget) and
row 7 (the rest of the class) are NOT in scope.

**Root cause this slice addresses** (eval, Root cause 2). On every streamed
delta the list re-renders every mounted cell. Its cost grows with the
transcript: 7 ms per render on a short session, 49 ms on a long one. s3 took the
header, composer, hub and sheets off the stream path. The shell and its
`FlatList` are still on it: `panes: shell=1207 … hub=1 sheets=1` (s3 Gate 0).
Three things put the list on that path:

1. `data={rows}` is the full row array (`SessionScreen.tsx:829`, `:1979`). A
   delta replaces the last row, so `data` is a new array on every publish.
2. `renderItem` is an inline arrow (`:1982-2029`). `extraData` (`:1162-1191`,
   `:2030`) holds `layout` and `looks`, which are rebuilt from the new `rows` on
   every render (`:845`, `:850`).
3. **Not in the eval, found here:** without `strictMode`, `FlatList` creates a
   NEW `renderItem` wrapper on every one of its renders
   (`react-native/Libraries/Lists/FlatList.js:613-666` builds it;
   `:675-699` uses the memoized one only `strictMode ? …`). That wrapper
   becomes a `CellRenderer` prop (`virtualized-lists/Lists/VirtualizedList.js:841`),
   and `CellRenderer` is a `PureComponent`
   (`VirtualizedListCellRenderer.js:63`). So EVERY `FlatList` render re-runs
   `renderItem` for every mounted cell, even with a stable `renderItem`. This is
   true today for any shell render: copy pill, sheet, hub open, the activity
   sheet's 1 s clock.

**Earlier slices (merged on `main` `d3e98913`), drift that matters here:**

- s0: the gate is flow `90-perf-stream` + `e2e/perf-budget.ts`. Jank lines are
  written only for windows that had a gap, and an unknown `ev` is ignored.
- s1: `thumbnails.ts` `view()` commits only on a real change. The
  `rows`-keyed `controller.window` effect (`SessionScreen.tsx:833-835`) stays.
- s2: the Thinking clock is the native `ClockText`. Its `since` comes from the
  rows (`tool-steps.ts:135-152`), so moving the tail does not reset it.
- s3: `session-store.ts` slices are `rows | header | composer | hub | sheets`
  (`:18-20`). The `ev=panes` line feeds the `coupling` rule, whose denominator
  is the SHELL's renders (`perf-budget.ts:52-56`, `:146-165`). Once this slice
  lands, the shell stops rendering per delta, so that denominator would read
  "no evidence" (decision 4). s3 Gate 0, the bar to hold: **PERF PASS, 1 jank
  line (worst 34 ms), fan settle 1056–1071 ms, 8.9 renders/s.** Flow 90 keeps
  its `known-bug` tag (eval slices 1–7). The 21 wiring tests that s3 retargeted
  pin JSX in `SessionScreen.tsx`. Expect them to break again, and retarget them;
  never delete one.

**Repro** (2026-11-28; `main` `d3e98913` in the main checkout; no source
edited). `.tentacle/tmp/mobile-ui-fluidity-s4/list-inputs.ts` drives the REAL
controller and store. It sends one tool round, then 100 reasoning deltas, then
100 text deltas, 10 ms apart. On each `rows`-slice publish it records the list's
inputs:

```ts
// What the transcript list reads, across consecutive stream publishes (main, real controller + store).
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { noticeLooks } from "../../../apps/mobile/src/notice-group.ts";
import { createSessionController } from "../../../apps/mobile/src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../../../apps/mobile/src/session-screen-controller.ts";
import { sameData } from "../../../apps/mobile/src/session-store.ts";
import { isBlockRow, stepLayout } from "../../../apps/mobile/src/tool-steps.ts";

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let watcher: ((a: SessionActivity) => void) | null = null;
const clock = { at: 1000 };
const timers: { at: number; fn: () => void; live: boolean }[] = [];
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
  sessionId: "s1", archived: false, title: "A", project: "p",
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
const store = screen.sessionStore();
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
const push = async (e: SessionEvent, dt: number) => {
  q.push(e);
  wake?.();
  await settle();
  clock.at += dt;
  for (const t of timers) if (t.live && t.at <= clock.at) { t.live = false; t.fn(); }
  await settle();
};
type Snap = { rows: readonly { key: string }[]; slice: unknown; cells: [string, unknown][]; looks: [string, unknown][]; tail: unknown };
const snaps: { phase: string; s: Snap }[] = [];
let phase = "";
store.subscribe("rows", () => {
  const slice = store.get("rows");
  const rows = slice.view.rows;
  const layout = stepLayout(rows, slice.view.composer.running, isBlockRow);
  snaps.push({ phase, s: { rows, slice, cells: [...layout.cells], looks: [...noticeLooks(rows, layout.cells)], tail: layout.tail } });
});
// A tool round first, so the thinking tail has a node to join.
await push({ type: "tool_start", id: "c1", name: "fs_read", input: { path: "a" } } as unknown as SessionEvent, 200);
await push({ type: "tool_end", id: "c1", ok: true, output: "x" } as unknown as SessionEvent, 200);
phase = "reasoning";
for (let i = 0; i < 100; i++) await push({ type: "reasoning", delta: "tok " } as SessionEvent, 10);
phase = "text";
for (let i = 0; i < 100; i++) await push({ type: "text", delta: "word " } as SessionEvent, 10);
for (const p of ["reasoning", "text"]) {
  const list = snaps.filter((x) => x.phase === p);
  let dataNew = 0, sliceNew = 0, prefixSame = 0, cellsSame = 0, looksSame = 0, tailChanged = 0;
  for (let i = 1; i < list.length; i++) {
    const a = (list[i - 1] as { s: Snap }).s;
    const b = (list[i] as { s: Snap }).s;
    if (a.rows !== b.rows) dataNew++;
    if (a.slice !== b.slice) sliceNew++;
    if (a.rows.length === b.rows.length && a.rows.slice(0, -1).every((r, j) => r === b.rows[j])) prefixSame++;
    if (sameData(a.cells, b.cells)) cellsSame++;
    if (sameData(a.looks, b.looks)) looksSame++;
    if (!sameData(a.tail, b.tail)) tailChanged++;
  }
  const n = list.length - 1;
  const last = (list.at(-1) as { s: Snap }).s;
  console.log(`${p}: ${n} consecutive publishes | FlatList data new ${dataNew}/${n} | rows slice new ${sliceNew}/${n} | all rows but the last same object ${prefixSame}/${n} | cells deep-equal ${cellsSame}/${n} | looks deep-equal ${looksSame}/${n} | thinking tail changed ${tailChanged}/${n} | rows=${last.rows.length} lastKind=${(last.rows.at(-1) as { kind: string }).kind}`);
}
process.exit(0);
```

```
$ bun .tentacle/tmp/mobile-ui-fluidity-s4/list-inputs.ts
reasoning: 10 consecutive publishes | FlatList data new 10/10 | rows slice new 10/10 | all rows but the last same object 10/10 | cells deep-equal 10/10 | looks deep-equal 10/10 | thinking tail changed 10/10 | rows=2 lastKind=reasoning
text: 9 consecutive publishes | FlatList data new 9/9 | rows slice new 9/9 | all rows but the last same object 9/9 | cells deep-equal 9/9 | looks deep-equal 9/9 | thinking tail changed 0/9 | rows=3 lastKind=assistant
```

How to read it. On every stream publish, today's list gets a new `data` and the
shell a new `rows` slice (10/10, 9/9). Yet every row except the last is the
same object, and the per-row derived data (`cells`, `looks`) is deep-equal. The
only thing that changes is the LAST row: the Thinking tail while reasoning, the
live assistant row while writing.

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (owner delegated the details;
orchestrator decisions below; no AGENTS §7 trust rule touched).

### Load-bearing assumption

**Between two publishes caused only by text/reasoning deltas, everything the
list draws except the last row is unchanged: every other row is the same
object, and the per-row derived data (`stepLayout` cells, `noticeLooks` looks)
is structurally equal.** If that holds, a list whose data leaves out the live
row's content, plus a derived-data member that keeps its identity, is never
touched by a delta. If it were false, the list would have to re-render per
delta whatever we do.

Proven:

- **By code.** A `text` delta replaces only the last row:
  `rows: [...state.rows.slice(0, -1), { ...last, text: … }]`
  (`transcript.ts:572-582`). A `reasoning` delta does the same (`:594-605`).
  Only these two event types are `stream` folds (`session-feed.ts:278-281`).
- **By the Repro.** On the real controller: prefix same object 10/10 and 9/9;
  cells and looks deep-equal 10/10 and 9/9.

### Preconditions

- **`FlatList` skips work only when its props are equal, and its cells only
  when the renderer is memoized.** `FlatList` is a `PureComponent`
  (`FlatList.js:308`). Its item renderer is memoized only under `strictMode`
  (`:668`, `:679`). The `CellRenderer` is a `PureComponent` that receives that
  renderer (`VirtualizedList.js:823-846`, `VirtualizedListCellRenderer.js:63`).
  `strictMode` is in the TS types (`types_generated/Libraries/Lists/FlatList.d.ts:133`).
- **Appending an item does not render it in the same commit; replacing one
  does.** `getDerivedStateFromProps` returns the previous state when the item
  COUNT is unchanged (`VirtualizedList.js:724-727`). On a longer list it keeps
  `last` at the old value (`:851-869`), and the new cell appears only after the
  50 ms batch (`:1816-1844`). This decides decision 1.
- **Follow is driven by content size, not by `rows`.** `onContentSize`
  (`SessionScreen.tsx:768-780`) and `onScroll` (`:748-767`) read native sizes.
  So a live cell that grows keeps following without the shell re-rendering.
- **The trailing reasoning row is always hidden while a turn runs.**
  `isThinking` is true whenever the last row is reasoning and `running`
  (`tool-steps.ts:104-111`). The trailing rows then become `HIDDEN` and the tail
  carries their text (`:288-295`). The cells of earlier rows depend only on row
  kinds and on `thinking`/`tailJoins` (`:300-319`), not on the live text.
- **`running` is `turn !== null`** (`session-view.ts:491`). At the publish where
  a turn ends there is no live row, so the list holds every row. The voice
  turn-end read (`SessionScreen.tsx:476-483`) keeps seeing the full transcript.
- **The speaker decision has a streaming-key half** (`voice-view.ts:90-108` →
  `read-aloud.ts:159-165`): a row is not offered while it is the streaming
  assistant row. Today that row is the last of `rows`.
- **The store keeps identity per SLICE only.** `keepSlices`/`sameSlice`
  (`session-store.ts:211-239`) return either the old slice or the whole fresh
  one, and a fresh slice brings fresh member references. Derived members are
  compared with `sameData` (`:233-236`; arrays element-wise, `:180-186`, so an
  array of the same row objects is an O(n) identity walk).
- **The shell reads `rows`-slice facts in these places only:**
  `rowsSlice.view.rows` (`:481`, `:594`, `:829`), `rowsSlice.transcript.link`
  (`:1782`), `rowsSlice.slot`/`view.pending`/`view.state` (footer only,
  `:2037-2066`), `rowsSlice.thumbnails` (`:2023`), plus `status`, `sends`,
  `refreshing`, `view.turn`, `view.composer`. Its derived reads of `rows`:
  `layout`/`looks` (`:845`, `:850`), `outputSteps` (`:961-964`), `showRow`
  (`:1144`), `sessionMenu` (`:1217`), and the empty checks (`:2088`, `:2175`).
- No protocol, persistence or §7 trust surface is touched. This is mobile app
  code only.

### Orchestrator decisions

*(owner-delegated, 28/11; the recommended option is taken in each case)*

1. **The live row keeps its place in the list as a stable STAND-IN; its content
   comes from the `tail` slice.** While a turn runs and the last row is
   `assistant` or `reasoning`, the list's data is the settled rows followed by
   `{ kind: "live", key }` (same key, same index). Deltas do not change that
   object, so `data` keeps its identity. The stand-in's cell (`LiveCell`) reads
   the row from `tail` itself. At the end of the stream the stand-in is
   replaced by the real row, at the same index with the same count, so the cell
   is re-rendered in that commit (`VirtualizedList.js:724-727`). There is no
   hole and no jump. *Rejected:* drawing the live row in `ListFooterComponent`,
   as the eval's wording suggests. At every turn end and every text→tool switch
   the row would leave the footer, and its new cell would arrive one 50 ms batch
   later (`:851-869`, `:1816-1844`): a visible blink, many times per turn. The
   eval's property ("the content does not live in the `FlatList` data") still
   holds.
2. **The derived list facts are computed in the store, from the full rows.**
   `stepLayout` + `noticeLooks` need the FULL rows: `isThinking` and `tailJoins`
   read the live last row. So the shell cannot compute them from the settled
   rows. `deriveSlices` computes them once per publish, with a one-entry memo on
   `(view.rows, running)`. That costs ≤ 0.42 ms at 701 rows in the interpreter
   (eval Repro C), against the 49 ms render it removes. They are carried as
   ENTRIES arrays, like s3's `reports`: `sameData` compares a `Map` by
   reference. The shell rebuilds the `Map` with `useMemo` on the member. *Rejected:*
   a per-cell selector (the eval's "read by the cell through its own
   selector"). That is N subscriptions, all woken on every publish to compare,
   which is more work than one memo.
3. **`keepSlices` keeps identity PER MEMBER too.** When a slice changes, each
   member (and each `view.` member) that is equal under its policy keeps its
   previous reference. Without it, any `rows`-slice change (`status`, `sends`)
   or `hub`-slice change (a catalogue refresh at a fan open) would hand new
   `cells`/`activity` references to the cell environment, and every cell would
   re-run. *Rejected:* comparing in the shell with extra `useMemo`s. That is the
   "more memo here and there" the eval rejects.
4. **The `coupling` rule's denominator becomes `tail`.** After this slice the
   shell no longer renders per delta, so `shell ≥ 50` (`perf-budget.ts:53`)
   would never give a verdict. The `ev=panes` line gains `tail` (renders of
   `TailPane`) and `cells` (`renderItem` calls). The rule becomes: with
   `tail ≥ 50`, each of `shell, cells, header, composer, hub, sheets` must be
   `≤ max(10, 0.1 × tail)`. With no such line the `evidence` rule fires. This
   replaces the eval's "S2 ms/render within 2× of S1" with a stronger and
   directly measured property: the stream path renders neither the shell nor a
   single list cell, so its cost no longer depends on the transcript length.
   *Rejected:* keeping the ms/render ratio. When the shell does not render
   there is no ratio to read, and the jank lines exist only for windows that
   had a gap.
5. **`renderItem` is keyed on ONE memoized cell environment (`cellEnv`), which
   is also the `extraData`.** `cellEnv` holds everything a cell reads besides
   its row: palette, thumbnails, diagram style, chart labels, reduce motion,
   compact shell, voice on, `readAloud`, speaker shown, artifacts on, activity,
   cells, looks, open steps, full steps. The callback is
   `useCallback(…, [cellEnv, store])`. None of these change per delta. The
   `FlatList` gets `strictMode`. *Rejected:* a ref-read `renderItem` with a
   separate `extraData`. Two sources that must agree is a stale-cell trap.
6. **The session menu reads the settled rows.** "Copy last answer" opened in
   the middle of a stream copies the last COMPLETE answer, not half of the one
   being written. Today it copies the partial reply. This is a minor change,
   recorded here. *Rejected:* re-subscribing the shell to the live row only for
   the menu.

### Design

**`src/tool-steps.ts`** (pure). Its only additions:

```ts
/** The row a stream is still writing: the last row while a turn runs, when it is text or reasoning. */
export function liveRow(rows: readonly Row[], running: boolean): Row | null;
/** The list's stand-in for the live row (same key; never changes while that row streams). */
export interface LiveSlot { readonly kind: "live"; readonly key: string }
export type ListItem = Row | LiveSlot;
/** The FlatList data: the settled rows, then the stand-in when a row is live. */
export function listData(settled: readonly Row[], liveKey: string | null): readonly ListItem[];
```

**`src/session-store.ts`**:

- `SliceKey` gains `"tail"`. In `SLICE_FACTS`, `transcript` and `view.rows`
  become `[]`: they reach slices only through derived members.
  `slot`, `view.pending`, `view.state`, `view.composer` and `compose` gain
  `"tail"`. The shell's footer reads move out (`slot`/`view.pending` leave
  `rows` unless the executor finds another shell reader; the types will say so).
- Derived members:
  - `rows`: `link`, `settled` (the rows without the live one; `sameData`
    keeps the old array while its elements are the same objects), `liveKey`,
    `cells`, `looks` (entries).
  - `tail`: `live` (the live `Row` or null), `thinking` (`stepLayout(...).tail`).
- `keepSlices`: member-level identity (decision 3).
- One-entry memo of the list derivation on `(view.rows, running)` (decision 2).

**`src/transcript-cell.ts`** (pure). It adds the `CellEnv` type and
`cellDataOf(row, env, live: boolean): CellData`. This is the ONE place that
turns a row plus its environment into a cell's props: `cell`/`look` by key,
`open`/`full`, `child` (`agentCardTarget`), and `speak`. `speak` is computed as
a list cell (never the streaming row) or as the live cell (its own key is the
streaming key). It reproduces `speakButtonOf` exactly, proven by a table test
against today's call with the full rows. `speakButtonOf`'s first parameter
narrows to `Pick<VoiceState, "readAloud"> | null`, so `cellEnv` does not carry
the whole `VoiceState` (dictation ticks would invalidate it).

**`src/screens/transcript/TranscriptCell.tsx`**: adds
`LiveCell = memo(({ store, env, actions, rowKey }))`, which calls
`useSlice(store, "tail")`. It renders `TranscriptCell` with
`cellDataOf(tail.live, env, true)`, or `null` when `tail.live` is null, is not
`assistant` (a live reasoning row is hidden: the tail draws it), or has a
different key (a torn read; the next commit converges).

**`src/screens/session/TailPane.tsx`** (new, the s3 pane pattern):
`memo`, `useSlice(store, "tail")`, `PERF.pane("tail")`. It renders the compact
slot, `ThinkingNode` (from `tail.thinking`) and `PendingBubbles`. This is the
footer JSX of `SessionScreen.tsx:2040-2082`, moved, not rewritten. It always
mounts and draws nothing when it has nothing. Its props are `store`, `palette`,
`reduceMotion` and `controller`, or a latest-ref `actions`; no inline arrows
(s3 pin B2).

**`src/screens/SessionScreen.tsx`**:

- Reads `rowsSlice.settled` / `liveKey` / `cells` / `looks` / `link`. No
  `stepLayout(` or `noticeLooks(` in the shell. Two memos:
  `data = useMemo(() => listData(settled, liveKey))`, and the `Map`s from the
  entries.
- `cellEnv` memo (decision 5). `renderCell = useCallback` keyed on
  `[cellEnv, store]`: `PERF.pane("cells")`, then a `LiveCell` for a `live`
  item, else the hidden check plus `<TranscriptCell {...cellDataOf(item, cellEnv, false)} actions={cellActions} />`.
- `<FlatList strictMode data={data} renderItem={renderCell} extraData={cellEnv} ListFooterComponent={tailFooter} …>`.
  `tailFooter` is a memoized `<TailPane …/>` element.
- `data` replaces `rows` for `listRows`, the window effect, `hasRows`, the
  empty checks and `showRow`. `settled` replaces it for `outputSteps` and
  `sessionMenu`. The voice turn-end effect keeps reading `settled`, which at
  turn end is every row (precondition; test A8).

**Perf**: `PANES` (`perf-trace.ts:38`) gains `tail` and `cells`. The probe needs
no logic change. In `perf-budget.ts`, `coupling` follows decision 4, and the
report line says `panes: shell=… tail=… cells=…`.

### Files

In dependency order:

1. `apps/mobile/src/tool-steps.ts`: `liveRow`, `LiveSlot`, `ListItem`, `listData`.
2. `apps/mobile/src/voice-view.ts`: the narrowed `speakButtonOf` parameter type.
3. `apps/mobile/src/transcript-cell.ts`: `CellEnv`, `cellDataOf`.
4. `apps/mobile/src/session-store.ts`: the `tail` slice, the derived members,
   member-level `keepSlices`, the memo.
5. `apps/mobile/src/perf-trace.ts` (`PANES`), `apps/mobile/e2e/perf-budget.ts` (`coupling`).
6. `apps/mobile/src/screens/transcript/TranscriptCell.tsx` (`LiveCell`),
   `apps/mobile/src/screens/session/TailPane.tsx` (new).
7. `apps/mobile/src/screens/SessionScreen.tsx`.
8. Tests (below), and `changelog.d/mobile-ui-fluidity-s4.fixed.md`:
   `- **Mobile: a streaming reply no longer redraws the transcript.** The reply being written and the Thinking line update on their own, so long sessions stay smooth while the model streams.`

No protocol, schema, `protocol.d/` note or `protocol.json` change. No new
dependency. No native code, so a JS-only build.

### Failure modes

| Failure | How it converges / is designed out |
|---|---|
| A cell whose derived data changes while its row does not, e.g. text starts after a finished tool and the tool's `thread.down` flips | `cells` and `looks` are store members. They change once at that moment, and so do `cellEnv` and `renderCell`. With `strictMode` every mounted cell re-runs once, and the `TranscriptCell` memo redraws only the one that changed. Test A9. |
| A blink or jump when the live row settles (turn end, text→tool) | Decision 1: the stand-in is replaced at the same index and count, so the cell renders in that commit. The cell remounts once (`LiveCell` → `TranscriptCell`) with identical content and height. Visual check in the flows below. |
| First row of a session is live (no user row yet) | `data` = `[stand-in]`, length 1, so no empty view and no mascot (the empty checks read `data`). |
| The live row changes kind or key within a turn (text → reasoning → text) | A new `liveKey`: the old stand-in becomes the real row and a new one is appended. One list render per transition, never per delta. |
| Resync / `history_reset` mid-stream | `view.rows` is replaced, so `settled` is new: one list render, as today. |
| Torn read between `rows` (`liveKey`) and `tail` (`live`) | Both come from one publish. `LiveCell` renders `null` on a key mismatch, never a wrong row, and the next commit converges. |
| Voice: speaker offered or hidden wrongly | `cellDataOf` reproduces `speakButtonOf` with the full rows. Table test over {list, live} × {streaming, speaking, idle}. |
| Show in chat / thumbnails window off by one | Every index is a `data` index, and the stand-in is last. A report row is never live. |
| Voice auto-read misses the final reply | At turn end `running` is false, so there is no live row and `settled` = every row. Test A8. |
| Derivation cost on every publish (typing in the composer) | One-entry memo on `(view.rows, running)`. A publish that did not change the rows costs only the memo check. |
| The gate goes blind because the shell no longer renders | Decision 4 moves the denominator to `tail`. A log with no qualifying line is `evidence`, never a pass. |
| A pane or shell re-coupled later (an inline prop, a slice subscription) | Flow 90 `coupling` (`shell`/`cells` ≤ 10 % of `tail`) plus the source pins (Tests B). |

### Tests

Red first on the ASSERTION. Add `"tail"` with a stub derivation (`{}`) and leave
`transcript`/`view.rows` in `rows`. Stub `listData` = identity, `cellDataOf`
throwing, and `PANES` without the new names. See the tests below fail, then
implement.

**A. `apps/mobile/test/session-store.test.ts`** (the real controller, with the
existing `harness`/`pushedTurn`/`settle` helpers):

1. **The row-4 check (narrows s3's A1):** after a tool round, 30 reasoning
   deltas. After each publish `get("tail")` is new, and `rows`, `header`,
   `composer`, `hub`, `sheets` are `toBe` the previous ones. Their subscribers
   are called 0 times. Red today: `rows` is new on every publish (Repro).
2. The same with 30 text deltas.
3. `transcript` / `view.rows` are spelled out in the exhaustive table: they
   change `rows` only through `settled`/`cells`/`looks`/`liveKey`/`link`, and
   `tail` through `live`/`thinking`.
4. **A8, turn end:** the publish whose `running` is false has
   `settled` = every row of `view.rows` (the same objects) and `liveKey` null.
5. **A9:** text after a finished tool. Across 30 deltas `rows` changes EXACTLY
   once (the tool's `thread.down` flips and `liveKey` is set).
6. **Member identity:** a catalogue-only change makes `hub` new, while
   `hub.activity` is `toBe` the previous one. A `status`-only change makes
   `rows` new, while `rows.cells` and `rows.settled` are `toBe` the previous.

**B. Pure:** `tool-steps.test.ts`: `liveRow` per last-row kind × running, and
`listData` (the stand-in is last; equal under `sameData` across calls; not
running ⇒ the settled array itself). `transcript-cell.test.ts`: `cellDataOf`
gives the same props the shell builds today, and the speaker table above.
`voice-view.test.ts` stays green with the narrowed type.

**C. Source pins** (`apps/mobile/test/list-stream-wiring.test.ts`, new,
comment-stripped like `fan-jank-wiring.test.ts`):

- The `<FlatList` in `SessionScreen.tsx` has `strictMode`,
  `renderItem={renderCell}`, `extraData={cellEnv}`, `ListFooterComponent={tailFooter}`.
- `SessionScreen.tsx` has no `stepLayout(`, no `noticeLooks(` and no
  `useSlice(store, "tail")`.
- Only `TailPane.tsx` and `TranscriptCell.tsx` call `useSlice(store, "tail")`.
- `TailPane` calls `PERF.pane("tail")`, and `renderCell` calls `PERF.pane("cells")`.
- Retarget the existing pins that break (`fan-jank`, `tool-rows`, `clock`,
  `swipe-time`, `row-guard`, `thought-placeholder`, `notice-*` wiring) to the
  code's new home. Never delete one.

**D. `perf-trace.test.ts`, `perf-budget.test.ts`:** the panes line carries
`tail`/`cells`. `coupling`:
- `shell=1207 tail=1207 cells=0` (s3's real shape) → violation on `shell`.
  This is red against today's rule.
- `shell=4 tail=1200 cells=0 hub=3` → ok.
- `tail=20` → no verdict, plus `evidence` when no other line qualifies.
- A missing `tail` → `evidence`.
- Extend the `perfOutcome` table.

**Mutations** (apply, see red, revert; record them in Execution):
- (a) put `transcript` back into `rows` → A1 red.
- (b) slice-level `keepSlices` → A6 red.
- (c) drop `strictMode` → pin C red.
- (d) `liveRow` ignores `running` → A8 red.
- (e) in the app, the shell calls `useSlice(store, "tail")` → flow 90
  `coupling: shell=…` red. Run it once on the simulator if time allows;
  otherwise say it was not run.

**Gate 0 (simulator), AI-free.** Take
`/Users/gmeghnag/tentacle/.tentacle/tmp/orchestration/sim.lock` (`mkdir`; wait
while it exists), and `rmdir` it after. Run
`bun run e2e:mobile --udid <iPhone 17 Pro> --only 90-perf-stream`. It must give
Maestro PASS and `perf.txt` PERF PASS with 0 violations. Hold s3: jank lines
≤ 1, worst gap ≤ 250 ms, fan settle ≤ 1 500 ms (s3: 1056–1071). Expected
`panes`: `tail` in the hundreds, `shell`/`cells` ≤ a few dozen. Record the line.
**Visual and regression (the handoff of decision 1):** flows `07-prompt`,
`09-foreign-turn`, `11-disconnect-mid-turn`, `12-steer`, `13-send-now`, all
green. Take a `simctl io screenshot` just before and just after a reply settles
in one of them, and attach both in Execution. Do not publish a build, and do not
touch `~/bin` or any running `serve`.

Narrow iteration: `bun test apps/mobile/test/session-store.test.ts` (+ the B, C
and D files). Before done: `bun test apps/mobile/test/`, `tsc -p apps/mobile`,
`biome check apps/mobile`. The full `bun run check` is the orchestrator's.

## Execution

*— claude-sonnet-5-5, 2026-11-28*

**Load-bearing check: holds.** I re-ran the Repro against this worktree's
sources (`.tentacle/tmp/mobile-ui-fluidity-s4/list-inputs-wt.ts`, a trimmed
copy that reads `onPublish`). The worktree first needed
`bun install --frozen-lockfile`.

- **The Repro's tool round was not finished.** It sends `tool_end`, which is not
  an event, so the tool stayed `running`. I re-ran it with the real
  `tool_result`, with the same result both times:

```
reasoning: 10 consecutive publishes | data new 10/10 | prefix same 10/10 | cells deep-equal 10/10 | looks deep-equal 10/10
text: 9 consecutive publishes | data new 9/9 | prefix same 9/9 | cells deep-equal 9/9 | looks deep-equal 9/9
```

**Red first** (tests A–D; stubs: a `tail` slice with no members, `liveRow` →
null, `listData` → identity, `cellDataOf` throwing; old `PANES`):
`137 pass, 58 fail`. The failures were assertions and the planned stub throw.
Two other kinds: the `TailPane` pin failed on ENOENT (the file did not exist),
and two A tests failed on members the stub lacked.

**As built, in the plan's order:** `tool-steps.ts` → `voice-view.ts` →
`transcript-cell.ts` → `session-store.ts` → `perf-trace.ts` /
`perf-budget.ts` → `LiveCell` / `TailPane.tsx` → `SessionScreen.tsx` → tests and
the changelog fragment. No protocol or schema change.

**Drift:**

- `speakButtonOf`'s **settings** parameter is narrowed too
  (`Pick<VoiceSettings, "readAloudButton">`), because `cellEnv` carries only
  `speakShown`.
- Two files were not in the plan's list. `measured-cell.tsx` now types `item` as
  `ListItem`. `perf-probe.ts` gains the two zero counters (no logic change).
- `slot`, `view.pending` and `view.state` left the `rows` slice (the types found
  no other shell reader).
- `deriveSlices(state, list?)` takes the memo as an argument. It is one per
  store, so two mounted screens do not evict each other's entry.
- `view.rows` is skipped in the per-fact loop and spelled out in its own test
  (A3). A `transcript.turn` change now wakes only `hub`.
- Existing pins retargeted, none deleted: `notice-row`, `voice-wiring`,
  `diagram-style`, `clock`, `row-guard`, `swipe-time`, `tool-rows`,
  `hub-scheduled`, `mobile-media-live`, `mascot`, `session-screen-follow`,
  `artifact-gallery`, `chart-labels`.
- In the `perf-budget` probe-log test the tail now renders 640 times. With 64
  shell renders and no tail, that log is now correctly `coupling` or `evidence`.
- A8 first ended the fake turn without `turn_end`. That appends a notice after
  the reply, so mutation (d) **survived**. The test now sends `turn_end` and
  asserts the reply is the last row.

**Mutations** (applied, run, restored; script
`.tentacle/tmp/mobile-ui-fluidity-s4/mutate.mjs`):

```
(a) `transcript` back into `rows`: 53 pass, 5 fail   (both "30 deltas" tests among them)
(b) slice-level keepSlices:        56 pass, 2 fail   (both member-identity tests)
(c) no strictMode:                  6 pass, 1 fail
(d) liveRow ignores `running`:     57 pass, 1 fail   (turn end)
(e-source) shell follows `tail`:    5 pass, 2 fail
(f) cellDataOf ignores `live`:     22 pass, 3 fail
```

(e) **in the app** (flow 90 going red on `coupling: shell=…`) was **not run**.
Only the source pin above covers it. The `shell=1207 tail=1207` budget test
covers the rule.

**Gate 0** (iPhone 17 Pro, iOS 26.5, under `sim.lock`, since released):
`90-perf-stream` Maestro PASS, 0 violations.

```
PERF PASS
jank lines: 0, fan lines: 4 (4 streaming)
worst gap: n/a
fan settle ms: 1068, 1067, 1066, 1059
renders/s (shell only): n/a
panes: shell=3 tail=1218 cells=118 header=1 composer=1 hub=1 sheets=1
```

- **For the reviewer: `cells=118` has little margin.** The limit here is 121.8,
  and the plan expected "a few dozen". My inference, not measured: each of the
  ≤ 3 shell renders can re-run every mounted cell once through a new `cellEnv`,
  and the list also renders newly mounted cells. That would make the figure
  scale with mounted cells and row transitions rather than deltas, so a shorter
  stream or more transitions could trip `coupling`. I left the threshold as
  planned. To verify, count `cells` per `cellEnv` identity in flow 90.
- The runner reports flow 90 as a known bug that now passes. The tag stays, as
  the plan says.

**Visual and regression flows:** `07-prompt`, `09-foreign-turn`,
`11-disconnect-mid-turn`, `12-steer` and `13-send-now`: 5/5 PASS, one try each.
**The two settle screenshots are not attached.** I recorded a passing rerun of
07 (`.tentacle/tmp/mobile-ui-fluidity-s4/flow07.mp4`), but cutting frames with
`ffmpeg` needed an approval this run did not have. Nobody has looked at the
live→settled handoff yet. To check it, view that video where the reply ends and
look for a blink or a jump.

**Gate:** `bun test apps/mobile/test`: 5965 pass, 0 fail. A8 was tightened
after that run, and `session-store.test.ts` was rerun: 58 pass.
`tsc -p apps/mobile` is clean, and so is
`biome check` on `apps/mobile/{src,test,e2e}`. The full `bun run check` is the
orchestrator's and was not run.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-28*

**No code changed.** The latest review (round 2) has no new HIGH/MEDIUM. The one
standing MEDIUM (round 1 #1, the `cells` margin) is **PARTIAL: recorded, not
fixed**. Either remedy the review names changes the approved coupling rule
(decision 4: `cells ≤ max(10, 0.1 × tail)`), and one of them also changes what
`renderCell` counts. Round 2 says to keep it as a follow-up.

The margin, measured with `checkPerf` on synthetic `panes` lines around Gate 0's
figures (`.tentacle/tmp/mobile-ui-fluidity-s4/cells-margin.ts`):

```
tail=1218 cells=118 -> no coupling violation
tail=1218 cells=121 -> no coupling violation
tail=1218 cells=122 -> cells=122 > 121.80000000000001 renders over 1218 tail renders
tail=1179 cells=118 -> cells=118 > 117.9 renders over 1179 tail renders
tail=1170 cells=118 -> cells=118 > 117 renders over 1170 tail renders
```

So 4 more `renderItem` calls, or 39 fewer tail renders (3.2 %), turn flow 90 red.
**Open decision (changes decision 4):** budget `cells` apart from the per-delta
panes, for example by counting only calls made with unchanged `cellEnv` and
`data`. A coupled list must still go red under the new rule.

No fix, so no red test and no mutation. `bun test
apps/mobile/test/perf-budget.test.ts`: 25 pass, 0 fail. The full gate was not
run. The live→settled handoff (round 1 #2, ungraded) is still unverified.

## Review

*— claude-opus-5-5, 2026-11-28* (fresh context; same model as the planner,
different from the executor — planner/reviewer blind spots may be shared).

**Verdict: APPROVE-WITH-NITS** (no HIGH; one MEDIUM to track, one unverified item).

**Gate (re-run here):** `bun test apps/mobile/test/` 5965 pass / 0 fail;
`bun run typecheck` clean (all four `tsc`); `bun run lint` clean (2827 files).
Full parallel `bun run test` not re-run (orchestrator's, at merge).

**Mutations (applied, red, reverted; `git status` clean after each):**
(a) `transcript: ["rows"]` → 5 red in `session-store.test.ts` (A1, A2, A9, the
two table tests). (b) `keepMembers` returns `b` instead of `out` → A6 red (2).
(c) `strictMode` removed → `list-stream-wiring` pin red. (d) `liveRow` ignores
`running` → A8 + 2 `tool-steps` red. (e) not run (simulator).

**Findings**

1. **MEDIUM — the `coupling` gate passes with a 3 % margin on `cells`, and
   `cells` is not delta-coupled.** `e2e/perf-budget.ts:160-166` limits every
   non-tail count to `max(10, 0.1 × tail)`; Gate 0 measured `cells=118` vs a
   limit of 121.8 with `shell=3`. `renderCell` (`SessionScreen.tsx:376-393`) is
   keyed on `cellEnv`, which changes at every tool/text transition (`cells`
   member), and with `strictMode` each change re-runs every MOUNTED cell; new
   rows mount too. So `cells` scales with mounted-window size × transitions, not
   with deltas. Failure: a flow-90 stream with a few more tool rounds, a longer
   preloaded transcript (bigger window) or a slightly shorter stream (smaller
   `tail`) turns flow 90 red with no real coupling — a flaky gate. Fix in a
   follow-up: measure cells per delta (e.g. count `renderItem` calls only when
   `cellEnv`/`data` identity did NOT change since the previous call), or budget
   `cells` against mounted cells × env changes; until then record the margin.
2. **Unverified (plan acceptance) — the live→settled handoff.** Decision 1's
   no-blink claim has no screenshot/frame evidence (Execution says so). The
   handoff remounts the subtree (`LiveCell` → `TranscriptCell` changes element
   type at the same index); code reading finds no mount animation on assistant
   rows, only `DiffView`'s local `open` state (reset on settle — cosmetic). To
   verify: view `.tentacle/tmp/mobile-ui-fluidity-s4/flow07.mp4` at reply end.

**Premises checked:** `liveRow` ≡ `streamingRowKey` on assistant
(`read-aloud.ts:159-165`), so `cellDataOf(row, env, live)` with `[row]`/`[]`
reproduces `speakButtonOf` exactly — TRUE. Only reasoning/tool rows are ever
`HIDDEN` (`tool-steps.ts:280-320`), so the `live` branch skipping the hidden
check is safe — TRUE. `controller.window` reads only `kind`
(`session-screen-controller.ts:597`), so a `LiveSlot` in `data` is harmless —
TRUE. Typecheck enforces that the shell no longer reads `view.rows`/`slot`/
`view.pending` from `rows` — TRUE.

**Attacks tried:** speaker parity list/live × streaming/speaking (holds);
torn read at settle (both slices from one publish; `LiveCell` nulls on key
mismatch — holds); voice turn-end reads `settled` (= all rows when
`running` false, A8 non-vacuous — holds); `keepMembers` view recursion and
missing-key paths (holds); non-running deltas (foreign turn with
`turn === null`) fall back to today's per-delta list render — not worse;
§7: mobile-only, no protocol/persistence/trust surface touched — holds.

**Executor behaviour:** honest — it flagged the `cells` margin and the missing
screenshots itself, and recorded which mutation was not run.

## Review

*— claude-opus-5-5, 2026-11-28* (round 2, fresh context; same model as the
planner and the round-1 reviewer, so blind spots may be shared; the executor was DeepSeek).

**Verdict: APPROVE-WITH-NITS** (PASS: no HIGH; round 1's MEDIUM 1 stands).

**Gate:** touched files 209 pass / 0 fail; `bun test apps/mobile/test/` 5965 / 0;
`bun run typecheck` clean; `bun run lint` clean (2827 files). Full parallel
`bun run test` not run (the orchestrator runs it at merge).

**New mutations (red, then reverted from a scratch copy; tree clean):**
`cellDataOf` with `[]` in place of `live ? [row] : []` → 3 red in `transcript-cell.test.ts`;
`settled: rows` (the live row both settled and a stand-in) → 5 red in
`session-store.test.ts` (A1, A2, A8, A9, table). `renderCell` deps and
`LiveCell`'s key check are pinned in `list-stream-wiring.test.ts:46,89`.

**Findings:** round 1 #1 (`e2e/perf-budget.ts:160-166`: `cells` is budgeted
against `tail`, but it scales with mounted cells × env changes, giving a 3 % margin and a flaky
gate) — confirmed by reading the code; keep it as a follow-up. No new HIGH/MEDIUM.

**Attacks tried:** `keepMembers` key-set and `view` recursion (holds);
per-delta `settled` slice + deep `sameData` of `cells`/`looks` (identity kept,
O(n) — holds); an append at a steer while live (the stand-in index is replaced in
the old window — holds); voice turn-end under a coalesced A-end/B-start publish
(`settled` excludes B's partial, which is better than main); the remount at settle
(`LiveCell`→`TranscriptCell`) resets local state. Assistant rows hold only
`CodeBlock`'s scroll widths and offset there, and diagrams, charts and images
live on tool rows, which are never live. So the only cost is cosmetic: a code
block scrolled sideways mid-stream snaps back (nit). §7: mobile-only, untouched.
