# fix/mobile-session-open-empty — a session sometimes opens EMPTY on the iPhone

> **Status:** implementation (APPROVED — orchestrator decisions below)
> **Branch:** `fix/mobile-session-open-empty`
> **Type:** fix · **Size:** M · **Blast:** cross-module (mobile session controller + screen controller + App navigation) · **Suited:** Sonnet exec (simulator), Opus fresh-context review
> **Changelog:** `changelog.d/mobile-session-open-empty.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-26*

Owner, 2026-11-26 ~21:10, iPhone: SOMETIMES opening a session shows it empty —
Polpetto's empty-session scene — although it has messages; switching to another
session and back shows them. Wanted in the next iOS build (after the 27/11 demo).

**What "empty" is.** The scene is drawn when `showsScene({ phase, rowCount })`
holds (`apps/mobile/src/screens/SessionScreen.tsx:2300`), i.e. `phase === "open"
&& rowCount === 0` (`apps/mobile/src/mascot-scenes.ts:908-913`). So the screen's
transcript has really received NO rows after a successful attach. That is a state
bug (lost history), not a layout one; the five earlier `mobile-open-*` fixes are
about the scroll landing of a non-empty transcript and cannot produce `rowCount 0`.

**Root cause (one sentence).** The history of an attach is a ONE-SHOT activity
delivered to the session's single watcher, and `createSessionController.open`
hands an already-followed session to a second opener WITHOUT subscribing its
`watch` — so a Session screen that opens a session some other holder already
follows never gets the history (Polpetto), and the other holder's later `leave`
detaches the session from under it.

- `RemoteSession.raise` keeps activities raised with no watcher in `unwatched`
  (a newer `history` replaces an older one) — `packages/client/src/remote-session.ts:1041-1050`;
  `watch()` has ONE listener ("a second replaces the first") and delivers
  `unwatched.splice(0)` ONCE — `remote-session.ts:742-757`. Probe below: the
  attach raises exactly one `history` activity, seen at the first `watch`.
- `open` returns `already.session` with no `watch` for a live id —
  `apps/mobile/src/session-controller.ts:169-171`; same for the queued
  `reused` path — `session-controller.ts:177-180`. Only a fresh attach subscribes
  (`session-controller.ts:196-199`).
- `leave(id)` is per id, not per holder: it deletes the entry and DETACHES,
  whoever opened it — `session-controller.ts:204-225`.
- The screen's attach passes its `watch` only through that `open` —
  `apps/mobile/src/session-screen-controller.ts:1577-1580`; it then sets
  `phase: "open"` with whatever rows arrived — `session-screen-controller.ts:1604`.

**How the app gets a second holder (the device triggers).**
1. **Workflow "Open the session" pushes a DUPLICATE Session screen.** The
   WorkflowRun ask bar's "Open the session" (`apps/mobile/src/screens/WorkflowRun.tsx:108-121`)
   calls `navigation.navigate("Session", …)` (`apps/mobile/App.tsx:3824-3831`).
   The `Session` screen has no `getId` (`App.tsx:3708-3709`; no `getId` in
   `App.tsx`), so React Navigation 7's `StackRouter` matches an existing route
   only if it is the CURRENT one (`node_modules/…/@react-navigation/routers@7.6.5/src/StackRouter.tsx:385-396`)
   and otherwise PUSHES a new route (`StackRouter.tsx:456-466`). From
   Session X → hub → WorkflowRun (borrowed, `App.tsx:2226`) → "Open the
   session", a second Session X mounts while the first is still mounted and
   watching → `already` → empty (repro D). Back on the first screen, it no
   longer follows the session (the top one's leave detached it): stale.
2. **WorkflowRun reached with no Session screen beneath** (`borrowed: false`)
   opens the session itself WITHOUT a watch (`App.tsx:2228`,
   `apps/mobile/src/workflow-run-controller.ts:556-573`); "Open the session" then
   finds a watcher-less live entry → `already` → empty, although the history
   still sits in `unwatched` (repro C).
3. **Overlapping mounts** (a new Session screen's `open` before the previous
   same-session screen's `leave`) → empty and, after the old leave, unfollowed
   (repro B). Not proven to happen through navigation alone (React runs a
   commit's unmount cleanups before its mount effects); kept as a case the
   controller must survive.

The owner was running workflows that evening (`demo-note`, TODO
`fix/mobile-workflow-run-jank` 18:30), which fits trigger 1/2. "Switch to another
session and back fixes it" fits all three: the switch's `leave` deletes the
entry, the return attaches fresh. A plain list → session → back → same session
(repro A) is NEVER empty (0/20).

**Repro** (2026-11-26, in-process: real `SessionHost` + `Connection` + real
`RemoteClient` + the app's own `createSessionController` and
`createSessionScreen`; run from the worktree with
`bun /Users/gmeghnag/tentacle/.tentacle/tmp/mobile-session-open-empty/repro.ts`):

```ts
// Repro: fix/mobile-session-open-empty. Real in-process daemon + real RemoteClient
// + the app's own createSessionController (one per link, as RUNTIMES) +
// createSessionScreen (the pure screen controller SessionScreen.tsx renders).
// Each scenario is one app-level ordering of opens/leaves on ONE session with
// history; "polpetto" is showsScene() — exactly what SessionScreen.tsx:2300 draws.
const W = "/Users/gmeghnag/tentacle/.tentacle/worktrees/mobile-session-open-empty";
const { Agent } = await import(`${W}/packages/agent/src/index.ts`);
const { RemoteClient } = await import(`${W}/packages/client/src/index.ts`);
const { PermissionBroker } = await import(`${W}/packages/core/src/index.ts`);
const { Connection, SessionHost } = await import(`${W}/packages/daemon/src/index.ts`);
const { ToolRegistry } = await import(`${W}/packages/tools/src/index.ts`);
const { createChannelPair } = await import(`${W}/packages/transport/src/index.ts`);
const { createSessionController } = await import(`${W}/apps/mobile/src/session-controller.ts`);
const { createSessionScreen } = await import(`${W}/apps/mobile/src/session-screen-controller.ts`);
const { showsScene } = await import(`${W}/apps/mobile/src/mascot-scenes.ts`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const model = {
  id: "m",
  async *stream(req: { messages: { role: string; content: string }[] }) {
    const p = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    yield { type: "text", delta: `ok:${p}` };
    yield { type: "done" };
  },
};
const env = { id: "e", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
const host = new SessionHost({
  defaultCwd: "/tmp/x",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env,
      requestPermission: (r: unknown, o: unknown) => permissions.request(r, o),
    });
    return { agent, permissions };
  },
});
function dial(broker = new PermissionBroker()) {
  const connect = () => {
    const [server, client] = createChannelPair();
    new Connection(server, host);
    return client;
  };
  return new RemoteClient(connect(), broker, undefined, { channelFactory: async () => connect(), random: () => 0 });
}
const laptop = dial();
await laptop.initialize();
const sid = crypto.randomUUID();
for await (const _ of laptop.newSession(undefined, sid).send("hi")) {
}
const laptopTurn = async (p: string) => {
  for await (const _ of laptop.newSession(undefined, sid).send(p)) {
  }
  await sleep(100);
};

type Kind = "A" | "B" | "C" | "D";
async function scenario(kind: Kind) {
  const broker = new PermissionBroker(undefined, { holdUntilSet: true });
  const phone = dial(broker);
  await phone.initialize();
  // App.tsx newSession shape: attach, never create.
  const controller = createSessionController({
    newSession: (id: string) => phone.newSession(undefined, id, undefined, { attach: {} }),
  });
  const screen = () =>
    createSessionScreen({ sessionId: sid, archived: false, title: "t", project: "p", controller, broker, now: () => 1000 });
  let lower: ReturnType<typeof screen> | null = null;
  const top = screen();
  if (kind === "A") {
    // list → session → back → same session again (old screen unmounted first)
    const one = screen();
    await one.open();
    await one.leave();
    one.dispose();
    await top.open();
  } else if (kind === "B") {
    // new screen's open BEFORE the old one's leave (overlapping mounts)
    const one = screen();
    await one.open();
    await top.open();
    void one.leave().then(() => one.dispose());
  } else if (kind === "C") {
    // WorkflowRun reached with NO Session screen under it (borrowed=false):
    // it opens the session WITHOUT a watch (App.tsx:2228), then "Open the
    // session" pushes Session (App.tsx:3824) → the screen's open hits `already`.
    const wf = await controller.open(sid);
    if (!wf.ok) throw new Error("wf open");
    await top.open();
  } else {
    // Session X → hub → WorkflowRun (borrowed) → "Open the session": navigate
    // pushes a SECOND Session X screen; the first stays mounted below.
    lower = screen();
    await lower.open();
    await top.open();
  }
  await sleep(100);
  const s = top.state();
  const rows = s.transcript.rows.length;
  const empty = showsScene({ phase: s.status.phase, rowCount: rows });
  await laptopTurn("later");
  const live = top.state().transcript.rows.length;
  const followed = controller.follows(sid);
  // D only: back to the lower screen (top unmounts) — does the lower one still follow?
  let lowerAfter = "";
  if (lower !== null) {
    await top.leave();
    top.dispose();
    const before = lower.state().transcript.rows.length;
    await laptopTurn("after-back");
    lowerAfter = ` | lower after back: rows ${before}→${lower.state().transcript.rows.length} followed=${controller.follows(sid)}`;
    await lower.leave();
    lower.dispose();
  } else {
    await top.leave();
    top.dispose();
  }
  phone.close();
  return { rows, empty, live, followed, lowerAfter };
}

for (const kind of ["A", "B", "C", "D"] as Kind[]) {
  let empties = 0;
  let last = { rows: 0, empty: false, live: 0, followed: false, lowerAfter: "" };
  const N = kind === "A" ? 20 : 5;
  for (let i = 0; i < N; i++) {
    last = await scenario(kind);
    if (last.empty) empties++;
  }
  console.log(
    `${kind}: empty ${empties}/${N} | last: rows=${last.rows} polpetto=${last.empty} rowsAfterLaptopTurn=${last.live} followed=${last.followed}${last.lowerAfter}`,
  );
}
laptop.close();
process.exit(0);
```

Output on the branch base (`ff053c22`):

```
A: empty 0/20 | last: rows=40 polpetto=false rowsAfterLaptopTurn=42 followed=true
B: empty 5/5 | last: rows=0 polpetto=true rowsAfterLaptopTurn=0 followed=false
C: empty 5/5 | last: rows=0 polpetto=true rowsAfterLaptopTurn=0 followed=true
D: empty 5/5 | last: rows=0 polpetto=true rowsAfterLaptopTurn=0 followed=true | lower after back: rows 80→80 followed=false
```

(Rows grow across iterations because the seeded session gets a laptop turn per
run; what matters is `rows=0 polpetto=true` and, in D, the lower screen frozen.)

Probe of the one-shot delivery (`probe.ts`, same dir: attach, wait 100 ms, then
`watch`): `activity history 2` — one `history` activity, delivered at the first
`watch`, never again.

**Not measured here — the simulator rate.** This planning session could not
drive the simulator (`xcrun simctl` needs an approval it could not get), so the
device-level empty-open rate is Execution step 0 (below), before and after.

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

**A session's attach history reaches exactly one watcher, once.** Proven:
`remote-session.ts:747-751` (`this.watcher = listener; for (… of
this.unwatched.splice(0)) listener(activity)`) and `remote-session.ts:1041-1050`
(no watcher → buffered; a watcher → delivered and gone). Probe: one `history`
activity per attach. Therefore a second Session screen on the same followed
session can get its transcript ONLY by (a) being the first watcher of a
still-buffered history (the watcher-less entry, trigger 2) or (b) a fresh attach
(the same path a first mount and `resync` use, `session-screen-controller.ts:2276-2283`).
There is no client API to re-raise the history (no public resync on
`RemoteSession`; `grep` of its methods), and adding one would be a client change
this fix does not need.

### Preconditions

- `RemoteSession.watch` is single-listener (`remote-session.ts:743-745`), and a
  foreign turn's events are a single-consumer stream inside a `turn` activity —
  so two screens cannot share one live session; the design keeps ONE watching
  screen per session per link and makes the others impossible (navigation) or
  short-lived (takeover).
- `leave` runs synchronously up to `live.delete` (`session-controller.ts:204-208`)
  and the screen's unmount calls it (`SessionScreen.tsx:405-408`); `resync` is
  leave-then-attach (`session-screen-controller.ts:2278-2283`) — the one path in
  (AGENTS §7 "one session path") that a takeover reuses.
- Per-id serialisation of open/detach (`session-controller.ts:150-166`) and the
  `left` set for a leave during an in-flight open (`session-controller.ts:209-216`)
  stay; they gain the holder identity below.
- Workflow screens open WITHOUT a watch and leave only when not `borrowed`
  (`workflow-run-controller.ts:558-563, 596-598`; same shape in
  `workflow-start-controller.ts:658-661, 731` and `workflow-edit-controller.ts:800-803, 1003`);
  `borrowed` is `runtime.follows(sessionId)` at creation (`App.tsx:2226`, `2370`, `2518`).
  Their contract is unchanged.
- React Navigation 7 `navigate` with a screen `getId` finds an existing route by
  id anywhere in the stack (`StackRouter.tsx:379-384`), and with `pop: true`
  returns to it, dropping what is above (`StackRouter.tsx:425-443`); with no match
  it pushes (`StackRouter.tsx:456-466`).
- No §7 trust rule is touched: no protocol, persistence, broker or pod path.
  The single broker is unaffected: the screen's requester is still mounted after
  ITS attach and withdrawn by identity (`session-screen-controller.ts:1633-1636`,
  `2246-2248`).

### Design

Two layers: navigation stops creating the duplicate screen, and the controller
makes every remaining ordering correct (never a silent empty).

**N — one Session screen per session in the stack.**
- N1. A pure `sessionRouteId(params) = sessionKey(params.computerId, params.sessionId)`
  (reuse `sessionKey`, `apps/mobile/src/artifact-seen-store.ts:58`; put the helper
  in `apps/mobile/src/drawer-nav.ts`, which already owns the `Session` route
  shape, `drawer-nav.ts:35-49`). `App.tsx` `<Stack.Screen name="Session"
  getId={({ params }) => sessionRouteId(params)} …>`.
- N2. WorkflowRun's "Open the session" (`App.tsx:3824-3831`) becomes
  `navigation.navigate({ name: "Session", params: {…}, pop: true })`: back to the
  existing Session X (the run screen above it is popped — it was reached from
  X's hub), or a push when X is not in the stack (trigger 2). The Sessions list's
  `navigate` (`App.tsx:3678`, `3691`) is unchanged in code; with `getId` it can no
  longer push a duplicate either.
- N3 *(added in Execution)*. `navigate` REPLACES a matched route's params unless
  `merge` (`StackRouter.tsx:406-420`), and the screen controller is rebuilt when
  `title`/`cwd`/`archived` change (`App.tsx`, the Session screen's effect deps).
  So going back must pass the params the open screen already has: a pure
  `sessionReturnParams(routes, target)` beside `sessionRouteId` (the stack's
  `Session` route of that id → its params; none → `target`).
- N4 *(added in Execution)*. The push tap (`App.tsx`, `createRouteQueue`) is a
  third `navigate("Session")`. With `getId` and no `pop` it would REORDER a lower
  Session screen to the top (`StackRouter.tsx:444-455`); it uses the same
  `pop: true` + `sessionReturnParams` as N2.

**C — the controller serves every ordering** (`apps/mobile/src/session-controller.ts`).
Entry = `{ session, watcher: Watch | null, unwatch, consumed: boolean, held:
boolean }`, where `held` = the entry was CREATED by an open without a watch (a
non-borrowed workflow screen, which will `leave`) and `consumed` = it has had a
watcher, so its attach history is gone. Pending opens record their `watch`, their
`held` and whether a leave cancelled them.
- C1. `open(id, { watch })` on a live entry that NEVER had a watcher
  (`consumed === false`) → subscribe now (`session.watch(watch)` delivers the
  still-buffered history), set `watcher`. Fixes trigger 2.
- C2. `open(id, { watch: w2 })` on a live entry that is `consumed` and whose
  watcher is not w2 (watched by `w1`, or `null` after a watched leave of a `held`
  entry, including w2's own earlier one: a `resync`) →
  **takeover by re-attach**: unwatch w1, drop the entry, then (serialised)
  detach the old handle and open a fresh one subscribed with w2 — exactly
  `resync`'s leave-then-attach. The newest screen is the visible one. Fixes
  trigger 3 and is the safety net for any duplicate N misses.
- C3. `open(id)` without a watch on a live entry → reuse, as today (borrowed
  workflow screens; never marks `held`).
- C4. `leave(id, watch?)` — identity-aware:
  - with `watch`: if the entry (or the pending open) belongs to ANOTHER watcher
    → no-op (a superseded screen's late leave never tears down its successor);
    if it is the watcher → unwatch; detach only when `held` is false, else keep
    the entry for the workflow screen that created it.
  - without `watch`: if the entry has a watcher → only `held = false` (the
    Session screen keeps it); else today's delete + detach.
  - a pending open: the `left` mark applies only when the identity matches. An
    anonymous leave while a WATCHED open is pending (the holder going away during
    a takeover) only clears that open's `held`.
  - the re-attached entry inherits the old entry's `held`.
- C5. The same rules apply at the queued `reused` check
  (`session-controller.ts:177-180`): one `adopt(entry, options)` helper used by
  both the fast path and the serialised path.
- `SessionController.leave(sessionId: string, watch?: Watch)` — optional, so
  every existing caller and fake compiles unchanged.

**S — the screen passes its identity** (`session-screen-controller.ts`): ONE
`watcher = (activity) => feed.activity(activity)` per screen (today an inline
arrow per attach, `:1579`), passed to `open` (`:1577-1580`) and to both
`deps.controller.leave(deps.sessionId, watcher)` calls (`:2257`, `:2278`).

#### Orchestrator decisions

*(owner delegated the details; recommended option taken, no §7 trust rule weakened → APPROVED)*

- **D1 — fix in BOTH layers (N + C), not navigation alone.** Alternative: only
  `getId` + `pop` — fixes triggers 1 and 2's duplicate but leaves trigger 2's
  watcher-less entry (`already` with a buffered history) and trigger 3 empty.
  Alternative: controller alone — every open non-empty, but trigger 1 would leave
  a lower Session X screen detached under the new one (stale on back). Both
  layers: no empty open and no stale screen on the known paths.
- **D2 — "Open the session" goes BACK to the existing Session X (`pop: true`)**,
  rather than moving X above the run screen (`navigate` with `getId` and no
  `pop`, `StackRouter.tsx:444-454`): a pop is the native stack's plain gesture, and
  the run is one hub tap away from X.
- **D3 — takeover = re-attach (C2)**, not "refuse the second open" (a failed
  screen with Retry for a normal tap) and not a new client re-raise API (client
  change, wider blast). Cost: one detach+attach round-trip, only on an overlap.

### Files

In dependency order (no protocol, daemon or client change):
1. `apps/mobile/src/session-controller.ts` — C1–C5, `leave(id, watch?)`.
2. `apps/mobile/src/session-screen-controller.ts` — S (one `watcher`, passed to
   `open` and both `leave`s).
3. `apps/mobile/src/drawer-nav.ts` — `sessionRouteId`.
4. `apps/mobile/App.tsx` — `getId` on `Session`; `pop: true` at `:3824-3831`.
5. Tests: `apps/mobile/test/session-controller.test.ts`,
   new `apps/mobile/test/session-open-empty.test.ts` (real daemon), a wiring
   assertion (in the style of `apps/mobile/test/workflow-screens-wiring.test.ts:102`),
   `apps/mobile/test/drawer-nav.test.ts` (or the existing nav test file) for `sessionRouteId`.
6. E2E: one new flow `apps/mobile/e2e/flows/48-workflow-open-session.yaml`
   (+ its entry in the `FLOWS` list, `apps/mobile/e2e/run.ts:~1805`).
7. `changelog.d/mobile-session-open-empty.fixed.md` — e.g. `- **A session opened
   from a workflow run no longer shows up empty.** …` (one bullet).

### Failure modes

- **Takeover's detach fails / link down.** `serialise` runs the next step on
  either outcome (`session-controller.ts:154`); the detach is `.catch(() => {})`
  as in `leave`. The fresh open then fails typed → the screen shows `failed` +
  Retry (`session-screen-controller.ts:1585-1592`), never an empty "open".
- **Old screen's leave lands DURING the takeover's attach.** Identity check
  against the pending open's watch → no-op; the new open is not cancelled
  (today's `left` mark would detach it). Test T4.
- **A turn running on the superseded screen.** Its daemon turn continues
  (`detach` never ends a session, `session-controller.ts:222-224`); the fresh
  attach sees it running at the cut and shows it as a foreign turn
  (`remote-session.ts:2542-2545`) — the `resync` behaviour.
- **A `held` entry whose creator never leaves** (a workflow screen whose
  `borrowed` snapshot was stale) — today it leaks the same way; unchanged, noted.
- **A duplicate the router still creates** (`replace`/`reset` paths that do not
  use `getId`, e.g. a drawer `replace` to X while X is lower in the stack): C2
  makes the top screen correct; the lower one is detached and would be stale on
  back. Not reachable through the known flows; listed for the review.
- **Empty session truly empty** (a new session): unchanged — the history has 0
  messages and the scene shows, as designed (`mascot-scenes.ts:912`).
- **Version skew:** none — no wire change.

### Tests

Red on `ff053c22` (shown failing on the property, not on an import), then green.
Mutation for each: revert the named rule → red.
- **T1** (`session-controller.test.ts`, fake handle with a buffered activity):
  `open(s1)` (no watch) then `open(s1, { watch: w })` → `w` receives the buffered
  history; `watched === 1`; one `open:s1` in the log. Red today (`watched 0`).
- **T2**: `open(s1, w1)` then `open(s1, w2)` → log `open:s1, detach:s1, open:s1`,
  the second handle watched by w2; then `leave(s1, w1)` → no further detach,
  `follows("s1") === true`. Red today (log `open:s1` only).
- **T3**: a watched leave of a `held` entry only unsubscribes (no `detach:`);
  an anonymous leave of a watched entry keeps it; the last of the two detaches
  once. Red today (detach on the first leave).
- **T4**: `leave(s1, w1)` while w2's takeover attach is in flight → w2's open
  resolves `ok` and stays followed. Red today's shape (the `left` mark).
- **T5** (`session-open-empty.test.ts`, real `SessionHost` + `Connection` +
  `RemoteClient`, the session-link harness pattern, `apps/mobile/test/session-link.test.ts:96-216`):
  scenarios B, C, D of the repro — the top screen has `rows > 0`, `showsScene`
  false, and a later laptop turn reaches it; in C the workflow handle still
  follows after the screen's leave. Use `until` with a throwing timeout, never a
  fixed sleep (AGENTS §9). Red today (`rows=0`).
- **T6**: `sessionRouteId` differs across computers for the same session id and
  is stable for the same pair; wiring: `App.tsx`'s `Session` screen declares
  `getId` with it, and the WorkflowRun route's `onOpenSession` navigates with
  `pop: true`. Red today.
- **Execution step 0 (simulator, before any edit):** a local serve with seeded
  history (`bun run e2e:mobile` seeds, `apps/mobile/e2e/seed.ts`); measure (i)
  list → session → back → same session ×10 (fast back-then-tap), (ii) Session →
  hub → Workflows → run → "Open the session" ×5, (iii) the same from a run reached
  with no Session screen beneath ×5; record empties per path (screenshot +
  `transcript-empty` visible with the scene). Repeat after the fix: expected
  (i) 0 before and after, (ii)/(iii) empty before, 0 after. Flow 48 pins (ii) in
  the gate: assert a transcript row visible after "Open the session" and back
  lands on the same non-stale screen (a laptop turn shows up).
- Gate: `bun run check` green; `bun run e2e:mobile --only 06-session-open,45-workflow-run-view,48-workflow-open-session`
  green on the simulator.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Before any edit.** Load-bearing check holds (`remote-session.ts:747-751`,
`1041-1050`; probe: one `activity history 2`). `repro.ts` on `c70372e8`:
`A 0/20 · B 5/5 · C 5/5 · D 5/5` empty.

| Slice | State |
|---|---|
| C — controller (C1–C5, `leave(id, watch?)`) | DONE |
| S — one `watcher` per screen | DONE |
| N — `getId`, `pop: true`, N3, N4 | DONE in code; **not seen on a simulator** |
| T1–T6, changelog fragment | DONE |
| Step 0 simulator rate (before/after) | **NOT DONE** |
| E2E flow `48-workflow-open-session` + `--only 06,45,48` | **NOT DONE** |

**Drift from the Implementation (plan edited above).**
1. C1/C2: as written ("`watcher === null` → subscribe") a `held` entry whose
   screen had left would subscribe after the history was delivered: empty again,
   and that screen's `resync` would re-read nothing. Added `consumed`; only a
   never-watched entry is subscribed, otherwise re-attach. Mutating back to the
   planned condition fails 2 tests.
2. Pending opens: an anonymous leave during a takeover releases the hold; the
   new entry inherits `held` (else a hold nobody releases).
3. N3: `navigate` replaces the matched route's params, so `pop: true` alone would
   retitle Session X with the run's name, drop `cwd` and rebuild its controller.
   Added `sessionReturnParams`.
4. N4: the push tap is a third `navigate("Session")` the plan missed; with
   `getId` it would reorder a lower screen. Same `pop` + helper. Consequence: a
   push for session Y while X is on top now PUSHES Y (before: X's route took Y's
   params).
5. Three existing controller tests left a watched open anonymously; they now pass
   the watcher, which is what the screen does.

**Red first.** Controller: 11 of the 12 new tests failed on assertions (the 12th
pins unchanged behaviour). T5, against `HEAD` copies of both controllers: 3/3
fail, `Expected: > 0, Received: 0` rows. Wiring: 3/3 fail. The two
`drawer-nav` unit tests cover new functions: shown by mutation only.

**Mutations** (each applied, run, reverted; failing tests):

| Mutation | Fails |
|---|---|
| live never-watched entry reused without subscribe (C1) | 5 |
| take over only when `watcher !== null` (planned rule) | 2 |
| `held` ignored on a watched leave | 3 |
| watched leave ignores identity | 3 |
| any watched leave cancels pending opens (T4) | 2 |
| queued reuse skips `adopt` (C5) | 1 |
| takeover drops `held` | 1 |
| anonymous leave does not release a pending hold | 1 |
| screen passes a new watcher per attach (S) | 3 |
| no `getId` · run route no `pop` · push tap no `pop` · helper returns target · id ignores computer (applied together, one distinct test each) | 5 |

**Gate (narrow).** `tsc -p apps/mobile` clean; `biome check apps/mobile
changelog.d` clean; `bun test apps/mobile/test` 5779 pass, 0 fail. Full gate: the
orchestrator's script.

**Why no simulator work.** No simulator was booted and no app build was
attempted. Also, flow 48 needs a seed the harness lacks: "Open the session" is
drawn only for a `foreign` ask, or a waiting step with no sheet
(`workflow-run-controller.ts` `askBarFor`); with Session X underneath only
`foreign` applies, so an ended run (flow 45's seed) never shows it. To verify:
seed a session holding an ended run AND a pending main-turn ask, tap "Open the
session", assert a transcript row, then back/forward and a laptop turn; also tap
a push for a session lower in the stack (N4).

**Known limit, for Review.** A re-attach (second "Open the session" after one
reached with no Session beneath, or that screen's resync) detaches the handle the
run screen still holds, so that run view stops updating until reopened. Before
this fix the first leave already detached it.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-26*

**Finding 1 (vacuous `pop` test) — FIXED.** `workflow-screens-wiring.test.ts`
now spans from `name="WorkflowRun"`, and asserts the span holds
`onOpenSession={() =>` and no `createRouteQueue`. No production change.
Red first: with `pop: true` removed from the run route the OLD test passed
19/19; the new one fails (`"pop": true` expected, `false` received).

| Mutation in `App.tsx` (one at a time, reverted) | Red (of 19) |
|---|---|
| run route: no `pop: true` | 1, the run-route test |
| push queue: no `pop: true` | 1, the push-tap test |
| run route: `sessionReturnParams` replaced | 1, the run-route test |
| no `getId` | 1, the `getId` test |

**Finding 2 (acceptance gate) — PARTIAL: flow written, NOT run on a simulator.**
- New `flows/48-workflow-open-session.yaml` (+ `48-laptop-edit.js`,
  `48-file.js`); in `FLOWS` after `46b`; `OPENSESSION_ID`; `run.ts`
  `RUN_SEEDED_FLOWS` gives it flow 45's seed (45 and 48).
- No new seed is needed (corrects "Why no simulator work"): the laptop raises
  the `EDIT` ask while the run screen is on top, so the `foreign` bar appears.
- Drift from Tests: no "back" assertion (the Session screen has no back button).
  The flow pins rows, no `transcript-empty`, and that the laptop's turn ends on
  that screen after the phone's approval. It does not detect a duplicate screen
  lower in the stack; the wiring tests alone cover that.
- Guard tests (`e2e-flows.test.ts`): 3 red before the flow existed (two of them
  only because the file was missing). Mutations: 48 out of `RUN_SEEDED_FLOWS` →
  1 red; the flow's `row-r.*` assertion removed → 1 red.
- NOT done: step-0 simulator rate; `--only 06,45,48`; N4's push tap on a device.
  The app needs a from-scratch Release build in this worktree (no `ios/`, longer
  than a foreground command), with 26 GiB free on the disk. Treat flow 48's UI
  steps as unverified. To run: `bun run e2e:mobile --ios 26 --only
  06-session-open,45-workflow-run-view,48-workflow-open-session`; or the
  orchestrator waives it.

**Gate (narrow).** 8 files, 255 pass / 0 fail; `biome check apps/mobile
changelog.d` clean; `tsc -p apps/mobile` clean. Full gate: the orchestrator's
script.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; same model family as the planner,
different from the DeepSeek executor)

**Verdict: REQUEST-CHANGES** (one vacuous test, one unmet gate; the controller is sound).

**Findings**
1. **MEDIUM — the run route's `pop` test is vacuous.**
   `apps/mobile/test/workflow-screens-wiring.test.ts:97`
   `between(APP, "onOpenSession={", "</Stack.Screen>")` anchors on the FIRST
   `onOpenSession={`, which is `App.tsx:2291` (`WorkflowRunRoute`). Its span runs
   to `App.tsx:3574` and so contains the push queue's `pop: true` +
   `sessionReturnParams(` (`App.tsx:2937-2944`). Mutation: drop `pop: true` at
   `App.tsx:3845` → all 30 tests stay green. Drop it at `:2943` instead → BOTH
   tests go red. So N2, the navigation fix for trigger 1, is not pinned. The
   Execution's mutation table (`:501`, "applied together") hid this. Fix: anchor
   on `onOpenSession={() =>`, or on `name="WorkflowRun"`.
2. **MEDIUM — the plan's acceptance gate is not met.** There is no flow 48, no
   `--only 06,45,48` run and no step-0 simulator rate (Execution `:462-463`,
   stated honestly). The whole N layer (`getId`, the object-form `navigate` with
   `pop`, N3, N4) has never run in React Navigation at runtime. Only static
   wiring tests cover it. Owner rule: "pixels unverified" ≠ done. Run it before
   merge, or have the orchestrator waive it explicitly.

**Gate (narrow, as asked).** Touched files: 56 pass / 0 fail (4 files). `bun run
lint`: clean. `bun run typecheck`: clean. I did not run the full `bun run test`.

**Mutations** (each reverted; `git status` clean afterwards):
- C1 never-subscribe: 5 red.
- Pending cancel ignores identity: 2 red (T4 among them).
- Watched leave ignores identity: 3 red (B, D, T2).
- Run-route `pop` removed: **0 red** (finding 1).
- Push-queue `pop` removed: 2 red.

**Premises:**
- `remote-session.ts:747-751` and `1041-1050` (single delivery): TRUE.
- `StackRouter.tsx:379-384`, `406-420`, `425-443` and `444-455` (v7.6.5): TRUE.

**Attacks tried**
- **R1 — duplicate screens, then a foreground return.** Every mounted screen
  resyncs (`SessionScreen.tsx:461-469`). Run as a scratch test against the real
  daemon: the stale lower screen takes over first and the top screen takes it
  back (serialised in mount order). Top stays alive; cost is 3 detaches. No
  finding.
- **Takeover of a held entry vs the run screen's handle.** `onWorkflows` is
  client-level and filtered by id (`remote-session.ts:1332-1337`), so it survives
  the old handle's detach. The "Known limit" is probably milder than stated.
  Unverified on device.
- **Drawer `replace` duplicate.** Failure mode `:403-406` says "not reachable".
  It is reachable: a push tap for Y over X (now a push, N4), then the drawer picks
  X → `[X, X']`. The top screen is correct (C2); the lower X is stale on back. This
  is LOW: not empty, and it was already the case before the fix.
- **A non-borrowed workflow screen queued behind a watched open.** Its entry
  never gets `held`, so the screen's leave detaches the workflow's handle. This
  was already the case before the fix; LOW.

**What holds.** C1–C5 are correct in every ordering I traced. The `consumed` drift
is right. No §7 invariant is touched: no protocol, persistence, broker or peer
change. Each screen's requester is still withdrawn by identity.

**Executor.** Honest about what it did not do (simulator, e2e). It found real
plan gaps itself (N3, N4, `consumed`). It over-claimed mutation coverage on N2.

### Round 2

*— claude-opus-5-5, 2026-11-26* (fresh context; the fix round was written by
claude-sonnet-5-5)

**Verdict: PASS** for the code. **Condition before merge:** flow 48 has never run
on a simulator. The orchestrator runs `--only 06,45,48`, or waives it explicitly.

- **Finding 1: FIXED, verified.**
  - Mutation: drop `pop: true` from the run route (`App.tsx:3845`) → the
    run-route test goes red (1 of 19). Reverted.
  - The anchor `name="WorkflowRun"` first matches `App.tsx:3822`. It cannot match
    `name="WorkflowRuns"` at `:3803` (the closing quote differs). The span is
    asserted to hold no `createRouteQueue`.
- **Finding 2: PARTIAL, honestly stated.**
  - Flow 48 + `RUN_SEEDED_FLOWS` + the `OPENSESSION_ID` var are present. The hooks
    it calls exist (`e2e/hooks.ts:330,336`).
  - Mutation: drop 48 from `RUN_SEEDED_FLOWS` → 1 red. Reverted.
  - The flow's UI steps are unverified, and so are N4 (push tap) and the step-0
    simulator rate.
- **Regressions in the fix diff.** None found:
  - `run.ts`: 45 is still seeded with runs; the set changes only which flows
    get the run seed.
  - Production code is unchanged in this round.
- **Gate.**
  - Wiring + e2e-flows tests: 94 pass / 0 fail.
  - `bun run lint`: clean (2748 files).
  - `bun run typecheck`: clean.
  - The tree is byte-identical after every mutation.
