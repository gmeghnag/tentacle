# fix/quit-enter-ask — A key typed for the input answers a permission ask that just opened

> **Status:** implementation (awaiting owner answers + approval)
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

## Execution

*— pending*

## Review

*— pending*
