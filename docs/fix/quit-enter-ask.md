# fix/quit-enter-ask — A key typed for the input answers a permission ask that just opened

> **Status:** implementation APPROVED by the owner (2026-11-14)
> **Branch:** `fix/quit-enter-ask`
> **Size:** S · **Blast:** contained · **Suited:** any model executes; standard in-context Review (safety-relevant: the Review must re-run the repro below)
> **Changelog:** `changelog.d/quit-enter-ask.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-14*

Item (3) of `fix/detach-open-items` (`TODO.md:507`, owner's list from the
detach-live test, `TODO.md:632`): the user types `/quit` + Enter in the main
input; a permission ask opens a moment before the Enter lands; the Enter
**approves the ask**. Safety-relevant, owner-ranked first among the open items.

Cause (source-verified on `0a534648`):

- The dialog owns every key the moment it is in the rendered frame:
  `permissionLayer` (`packages/tui/src/keys/layer-dialog.ts:26-82`) runs before
  the input layers (`keys/layers.ts:45`) and consumes every chunk while
  `snap.permission.pending !== null` (`layer-dialog.ts:29`).
- `stepPermissionKey` (`packages/tui/src/permission-reply.ts:97-139`) maps
  Enter to the highlighted choice (`:118-123`), `y` to allow-once (`:125`), `a`
  to choice 1 = "Always allow" (`:128-130`). Nothing reads how long the dialog
  has been up — there is no age guard.
- Every new request highlights index 0 (`permission-ui.ts:434`, `setSelected(0)`),
  which is "Yes" (`permission-ui.ts:213`).

So the trap is wider than `/quit`: any approving key typed for the input in the
human reaction window after the dialog appears answers it — including `a`
inside an ordinary word, which grants a **session-scope** approval (case E).

**Repro** (`.tentacle/tmp/fix-quit-enter-ask/repro.ts`, 2026-11-14; run with
`bun .tentacle/tmp/fix-quit-enter-ask/repro.ts` from the repo root. Note: it
imports by relative path, so it ran against the main checkout's sources — the
worktree has no `node_modules`; the executor re-runs it on the branch):

```ts
import { createElement as h } from "../../../packages/tui/node_modules/react/index.js";
import { render } from "../../../packages/tui/node_modules/ink-testing-library/build/index.js";
import { App } from "../../../packages/tui/src/App.tsx";
import { PermissionBroker } from "@tentacle/core";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQ: any = { tool: "shell", level: "ask", title: "Run a shell command", detail: "rm -rf build", input: {} };

async function run(label: string, reply: boolean, before: string, after: string, gapMs: number) {
  const permissions = new PermissionBroker();
  const session: any = () => ({
    async *send() { yield { type: "turn_end", reason: "end_turn" }; },
    ownsTurn: () => true,
  });
  const app = render(h(App, { createSession: session, permissions, model: "m", cwd: "/w" }));
  await delay(30);
  for (const c of before) { app.stdin.write(c); await delay(10); }
  const answers: any[] = [];
  const req = reply ? { ...REQ, reply: { maxChars: 2000 } } : REQ;
  void permissions.request(req, { turnId: "t1" }).then((r) => answers.push(r));
  await delay(gapMs);
  for (const c of after) { app.stdin.write(c); await delay(10); }
  await delay(60);
  console.log(`${label}: answer=${JSON.stringify(answers[0] ?? "PENDING")}`);
  app.unmount();
}

await run("A '/quit' typed, ask opens, Enter 30ms later", false, "/quit", "\r", 30);
await run("B same, ask takes a reply", true, "/quit", "\r", 30);
await run("C ask opens after '/qui'; then 't' Enter", false, "/qui", "t\r", 30);
await run("D ask opens after '/qui'; then 't' Enter (reply ask)", true, "/qui", "t\r", 30);
await run("E typing 'say' as the ask opens after 's'", false, "s", "ay", 30);
```

```
A '/quit' typed, ask opens, Enter 30ms later: answer={"allowed":true,"scope":"once"}
B same, ask takes a reply: answer={"allowed":true,"scope":"once"}
C ask opens after '/qui'; then 't' Enter: answer={"allowed":true,"scope":"once"}
D ask opens after '/qui'; then 't' Enter (reply ask): answer={"allowed":false}
E typing 'say' as the ask opens after 's': answer={"allowed":true,"scope":"session"}
```

Every row except D is an approval the user never meant (D is a refusal only
because `t` happened to open the reply field). Expected after the fix: A, B, C,
E → `PENDING` (dialog still up); D unchanged or `PENDING` depending on Q2.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

All dialog keys flow through ONE pure decision, `stepPermissionKey`, reached
only via `permissionLayer` — so one guard there covers Enter, `y`, `a` for
every request kind (tool asks, hooks trust, move asks). Verified:
`stepPermissionKey` is called only at `keys/layer-dialog.ts:53` (`rg
stepPermissionKey packages/tui/src`), and `App` has ONE `useInput`
(`App.tsx:1914`) routing through `routeKey`.

### Preconditions

- The router's snapshot is built at the event (`App.tsx:1914-1960`); the
  permission fields are render values (`App.tsx:1952`, table in
  `keys/snapshot.ts:39`), `mode` a live ref (`snapshot.ts:26`). A key that
  lands before the dialog's first commit sees `pending === null` and goes to
  the input — correct: the user has not seen the dialog.
- Each request goes through the requester (`permission-ui.ts:404-446`), which
  sets `pending` per request — so a per-request stamp also covers a SECOND ask
  opening right after the first was answered (double Enter).
- Ctrl+C in the dialog is "stop" (`permission-reply.ts:103-105`) and must stay
  immediate.

### Design

An **arming window**: for `ARM_MS` after a request's dialog is first on
screen, approving keys are swallowed (consumed, no effect, dialog stays).

1. `permission-reply.ts`: `DialogContext` gains `armed: boolean` (true once
   the window has passed). In `stepPermissionKey`'s menu branch, when
   `!armed`: Enter on a choice whose `response.allowed === true`, `y` and `a`
   return `{ state, action: NONE }`. Everything else unchanged (scope per Q2).
   Export `ARM_MS` (value per Q1) and a pure `isArmed(shownAt: number | null,
   now: number): boolean` (`shownAt === null` ⇒ false).
2. `permission-ui.ts` (`usePermissionBroker`): a `shownAtRef`, reset to `null`
   when a request is set (`:434` area) and stamped `Date.now()` in a
   `useEffect` keyed on `pending` (post-commit = when Ink drew it, not when the
   request arrived — a slow render must not eat the window). Expose
   `shownAt(): number | null` on `PermissionController`.
3. `keys/snapshot.ts`: `KeyPermission` gains `shownAt(): number | null`
   (getter, live ref) + a row in the SOURCES table; `App.tsx:1952` passes
   `permission.shownAt`. `layer-dialog.ts:53` passes
   `armed: isArmed(snap.permission.shownAt(), Date.now())`.
   (Clock: `Date.now()` read in the layer; tests drive it by real small delays
   or by unit-testing `isArmed`/`stepPermissionKey` directly — no clock seam
   needed in the router.)

No protocol, persistence, broker or daemon change; auto-accept untouched (it
answers in the requester before any dialog, `permission-ui.ts:411-413`).

### Files

1. `packages/tui/src/permission-reply.ts` — `ARM_MS`, `isArmed`, `armed` in
   `DialogContext`, the guard in the menu branch.
2. `packages/tui/src/permission-ui.ts` — `shownAtRef`, the stamping effect,
   `shownAt()` on the controller.
3. `packages/tui/src/keys/snapshot.ts` — `KeyPermission.shownAt` + SOURCES row.
4. `packages/tui/src/keys/layer-dialog.ts` — pass `armed`.
5. `packages/tui/src/App.tsx` — one line in the snapshot literal.
6. Test fixtures that build `KeyPermission` (`keys-layers.test.ts`,
   `keys-route.test.ts`, `panels-registry.test.ts`,
   `keys-snapshot-source.test.ts`) — add `shownAt: () => 0` (armed) so
   existing expectations hold.
7. `changelog.d/quit-enter-ask.fixed.md` — one bullet.

### Failure modes

- **Key before first commit** → goes to the input (dialog unseen). Correct.
- **Back-to-back asks** → `shownAt` reset per request; the second is guarded too.
- **Reply field open** (`mode: "reply"`) → the field's Enter sends a refusal or
  a message, never an approval; not guarded (only reachable via `t`/Enter on
  the reply row, both deliberate).
- **Withdrawn ask during the window** → `pending` null, layer passes; nothing
  to guard.
- **Swallowed key is lost** → intended: the user's `/quit` is not run either;
  the text typed before stays in the (hidden) main input. Feedback per Q3.
- **Clock jump** (`Date.now()` backwards) → `isArmed` is `now - shownAt >= ARM_MS`,
  so a backwards jump keeps it disarmed until real time passes `ARM_MS` beyond the stamp — fail
  safe (blocks approval, never grants). Pin it in a unit test.
- **Screen reader / slow typists** → `ARM_MS` is short (Q1); deny keys stay
  immediate (Q2), so nobody is blocked from refusing.

### Tests

Red on `0a534648` first, then green (§9):

- `test/permission-reply.test.ts` (pure): with `armed: false`, Enter on "Yes",
  `y`, `a` → `NONE`; `n`, Esc, arrows, Ctrl+C → unchanged; Enter on "No" →
  refusal. With `armed: true` → today's behaviour. `isArmed(null, …) === false`,
  boundary at exactly `ARM_MS`, backwards clock ⇒ false.
- `test/permission-reply-app.test.tsx` (App, existing `mount()` harness):
  cases A, C, E of the repro → `answers` empty and the dialog still in the
  frame; then after `ARM_MS` + margin, `y` → allow-once (the guard expires).
  Back-to-back: answer one ask, open a second, Enter within the window →
  second still pending.
- Non-vacuity: pass `armed: true` unconditionally in `layer-dialog.ts` and
  confirm the App tests go red; revert.

### Owner questions

1. **Window length.** Fixed `ARM_MS = 500` (not configurable)? *Rec: yes, 500 ms
   — covers a reaction-time keystroke, short enough to be invisible to a
   deliberate answer; no config knob until someone asks.*
2. **Which keys are guarded.** Only approving keys (Enter on an allow row, `y`,
   `a`), or every key except Ctrl+C? *Rec: approving keys only — an accidental
   refusal is recoverable (the agent asks again or the user re-prompts), an
   accidental approval is not; `n`/Esc/arrows/`t` stay immediate.*
3. **Feedback for a swallowed key.** Silent, or a footer hint (e.g. "just
   opened — press again")? *Rec: silent — the dialog staying up is the signal,
   and a hint flashing for 500 ms is noise.*
4. **Default highlight.** Also move the initial highlight from "Yes" to "No"?
   *Rec: no — the window fixes the race; changing the default alters every
   deliberate Enter-to-approve and is a separate UX decision.*

#### Owner decisions (2026-11-14)

All four questions: the recommendation (owner: "Tutte come raccomandato").
*— claude-opus-5-5 (orchestrator), 2026-11-14*

## Execution

*— claude-sonnet-4-5-20250929, 2026-11-14*

**Load-bearing check, re-run first (PASS).** `rg stepPermissionKey packages/tui/src`
returns the definition plus EXACTLY one call site, `keys/layer-dialog.ts:53`
(now `:57`), and `App.tsx` has exactly one `useInput` (`:1914`). `permissionLayer`
is 4th of the 13 pure layers (`keys/layers.ts:45`), before every input layer. So
one guard inside `stepPermissionKey` reaches Enter/`y`/`a` for every request kind
(tool, hooks trust, session hop). No step contradicted the code.

**Repro on the branch, before any edit** (`.tentacle/tmp/fix-quit-enter-ask/repro.ts`,
copied into the worktree so it imports the branch's sources; the doc's copy
imports the main checkout):

```
A '/quit' typed, ask opens, Enter 30ms later: dialog=gone answer={"allowed":true,"scope":"once"}
B same, ask takes a reply: dialog=gone answer={"allowed":true,"scope":"once"}
C ask opens after '/qui'; then 't' Enter: dialog=gone answer={"allowed":true,"scope":"once"}
D ask opens after '/qui'; then 't' Enter (reply ask): dialog=gone answer={"allowed":false}
E typing 'say' as the ask opens after 's': dialog=gone answer={"allowed":true,"scope":"session"}
```

Matches the doc row for row (I added `dialog=up|gone` to each line, from
`lastFrame()`).

**As built, in dependency order.**

1. `packages/tui/src/permission-reply.ts` — `ARM_MS = 500` (`:68`), pure
   `isArmed(shownAt, now)` (`:76`, `shownAt === null` ⇒ false, `>=` boundary, a
   backwards clock ⇒ false), `DialogContext.armed` (`:58`), and ONE local
   `answer()` in `stepPermissionKey`'s menu branch (`:133-142`) that returns
   `{ state, action: NONE }` for an approval while `!ctx.armed`, and today's
   `answer` for a refusal or once armed. Enter-on-a-choice, `y` and `a` all route
   through it (`:154`, `:157`, `:160`); Ctrl+C (`:127`), arrows, `t`, the reply
   row and `n`/Esc are untouched above/below it. This also fixes a latent detail
   the plan did not name: `a` on a hooks-trust ask with no store resolves to
   "Don't trust" (`allowed: false`), so the refusal test is on the RESPONSE, not
   on the key — `a` denies immediately there, and the test pins it.
2. `packages/tui/src/permission-ui.ts` — `shownAtRef` (`:319`), `shownAt()` on
   the controller (`:257`, `:328`), reset to `null` when a request is set
   (`:449`), stamped `Date.now()` in a `useEffect` keyed on `pending` (`:465-476`)
   — post-commit, so the window starts when Ink DREW the dialog.
3. `packages/tui/src/keys/snapshot.ts` — `KeyPermission.shownAt(): number | null`
   (`:67`) + its SOURCES row (`:40`, getter).
4. `packages/tui/src/keys/layer-dialog.ts` — `armed: isArmed(snap.permission.shownAt(), Date.now())`
   (`:60`).
5. `packages/tui/src/App.tsx` — one literal line, `shownAt: () => permission.shownAt()`
   (`:1957`).
6. New test `packages/tui/test/quit-enter-ask.test.tsx` (8 cases: A, C, E,
   window expiry, denial immediate, Ctrl+C, back-to-back asks, silence) and the
   pure cases added to `packages/tui/test/permission-reply.test.ts`.
7. `changelog.d/quit-enter-ask.fixed.md`.

**Drift from the Implementation (and why).** Two, both reconciled here:

- **D1 — the fixture list was incomplete (Files item 6).** Adding a required
  `KeyPermission.shownAt` broke FOUR more App suites the plan did not list:
  `app-keys-precedence.test.tsx`, `app-structural-freshness.test.tsx`,
  `subagent-panel-frames.test.tsx`, `send-now-app.test.tsx`, plus
  `app.test.tsx`'s "runs the shell command when approved". These are not fixture
  edits: each sends an APPROVING key (`y`, or Enter on the highlighted "Yes")
  within milliseconds of the ask appearing, i.e. exactly the gesture the fix
  forbids. They now wait `ARM_MS + margin` (a local `armed()` helper) before
  approving, with a comment saying why. That is the honest change: the old
  expectation *was* the bug. `keys-layers.test.ts`, `keys-route.test.ts` and
  `panels-registry.test.ts` got `shownAt: () => 0` (epoch 0 ⇒ long armed) as the
  plan said, so their expectations hold unchanged. One file the plan listed
  needed NOTHING: `keys-snapshot-source.test.ts` only scans source TEXT (the
  table's value half) and builds no `KeyPermission`, so a new getter there
  changes nothing — it passes untouched.
- **D2 — the guard is classified by the RESPONSE, not by the key.** The plan
  said "Enter on a choice whose `response.allowed === true`, `y` and `a`". Since
  `a` is not always an approval (`hooks_trust` without a store: "Don't trust"),
  the guard tests `response.allowed === true` for all three keys uniformly. That
  is strictly what owner Q2 asked ("deny keys stay immediate") and is simpler
  than keying on the key.

Otherwise as planned: no protocol, persistence, broker or daemon change, and
auto-accept untouched (it answers in the requester, before any dialog).

**Red before green.** The pure test went red on the assertion
(`disarmed: every approving key is swallowed` — 5 received answers against `NONE`)
after I added `ARM_MS`/`isArmed`/`armed` WITHOUT the guard, precisely so the red
was not an import error; then the guard made it green. The App-level test file
was written after the fix (it is the regression net for the repro, and its
red-ness is proven by mutation M1 below, which is the same experiment run
against the buggy decision).

**Mutations (§9 non-vacuity), each applied, run, and reverted:**

| # | Mutation | Result |
|---|---|---|
| M1 | `layer-dialog.ts`: `armed: isArmed(...)` → `armed: true` (the buggy decision) | 5 red: cases A, C, E, back-to-back, silence |
| M2 | `permission-reply.ts`: drop `\|\| response.allowed === false` from `answer()` (guard swallows denials too) | 1 red: `disarmed: refusals, arrows, t and Ctrl+C stay immediate (owner Q2)` |
| M3 | `permission-ui.ts`: remove the stamp (`shownAtRef.current = Date.now()`) | 2 red: `the window expires`, `back-to-back asks` |
| M4 | `permission-ui.ts`: remove the reset (`shownAtRef.current = null`) | **0 red — SURVIVES.** See Review note (R1); it is redundant with M3's stamp, not with anything else: the stamp effect is keyed on `pending`, so a new request always restamps after commit. The reset only prevents a pre-commit read from seeing the PREVIOUS request's stamp — a window that lands between `setPending` and the commit, which no test in this repo can produce deterministically through `ink-testing-library` (the ask helper always awaits ≥30 ms). Kept (it is the fail-safe direction) and recorded as a known-unpinned line rather than claimed as tested. |

**Repro after the fix** (same script, same command):

```
A '/quit' typed, ask opens, Enter 30ms later: dialog=up answer="PENDING"
B same, ask takes a reply: dialog=up answer="PENDING"
C ask opens after '/qui'; then 't' Enter: dialog=up answer="PENDING"
D ask opens after '/qui'; then 't' Enter (reply ask): dialog=gone answer={"allowed":false}
E typing 'say' as the ask opens after 's': dialog=up answer="PENDING"
```

A, B, C, E are the doc's expected `PENDING` with the dialog still up; D is
unchanged (`t` opened the reply field, Enter sent an empty field = a plain No).

**Gate** (in the worktree, after `bun install`; the branch worktree shipped with
no `node_modules`, so the mobile app's deps were installed too — CI excludes the
mobile app, and without it `bun test` reports 34 unrelated
`Cannot find module` errors from `apps/mobile`):

```
bunx tsc --noEmit          → clean
bunx tsc -p apps/mobile    → clean
bun run lint               → clean (0 errors, 0 warnings; baseline §6)
bun test                   → 9349 pass, 3 skip (the three opt-in skips), 0 fail
```

No schema change, so `packages/protocol/schema/protocol.json` is untouched
(`git status` shows only the files above plus the new test and fragment). No
`protocol.d/` note (no wire change). `TODO.md` not touched.

## Review

*— pending*
