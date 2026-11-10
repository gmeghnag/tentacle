# fix/clear-silent-noop — `/clear` on a resumed session did nothing, silently

> **Status:** execution
> **Branch:** `fix/clear-silent-noop`
> **Size:** S–M · **Blast:** load-bearing · **Suited:** DeepSeek triage + exec, one Opus review

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-10*

**The report (owner, daily use; reproduced by the orchestrator in a real terminal).**
On a RESUMED session (`~/trash/new`,
`tentacle --resume fc027317-56ee-4f2e-ade4-aa7b1753345b`), `/clear` + Enter only
empties the input: the chat stays, ctx stays at ~19%, **no notice**, even after
10 s. `/help` works. Same on main (build `3b238a4c0805`) and on the panel branch,
so not task 7. The session ran background sub-agents (the log carries
`subagent_background` ×5 / `subagent_end` ×5, two `replace`s, one `base`).

**Root cause (one line).** `RemoteSession.clear()` returned a hollow
`{before: 0, after: 0}` when the session had not been OPENED daemon-side yet —
`if (!this.id) return { before: 0, after: 0 }`
(`packages/client/src/remote-session.ts:677-683` at `df42111`) — and a resumed
session has no `id` until its first turn. So `/clear` never asked the daemon
anything, nothing was reset, no `history` activity was raised, and the TUI's
`{0,0}` branch (`packages/tui/src/App.tsx:1949-1956`) silently released its
latch.

**Why the resumed session has no daemon-side id.** `--resume` seeds the client
with the saved messages and keeps the open LAZY: `local-runtime.ts:770-778`
builds `client.newSession(record.messages, uid, title, …)` (no `attach`), and
`RemoteSession.openSeeded` / `createOrAttach` (`remote-session.ts:321-360`) is
what the FIRST SEND awaits. The TUI's `watchSession`
(`App.tsx:1635-1650`) calls `session.open?.()`, which for a non-attach session
is `Promise.resolve()` (`remote-session.ts:297-299`: "A no-op for a fresh
session: it stays lazy"). Until a prompt is sent there is NO session daemon-side
under that uid: the conversation is the client's seed only.

**Evidence — the repro.** `packages/cli/test/clear-resume.test.ts` (the real
`createLocalRuntime` → `RemoteClient` ↔ `Connection` → `SessionHost`, a resumed
record, `/clear` before any turn), red on main:

```
(fail) REPRO /clear on a resumed session nothing has opened resets it (no hollow {0,0})
  expect(result).toEqual({ before: 6, after: 1 })
  Received:  { "after": 0, "before": 0 }
  expect(r.host.size).toBe(1)   →  received 0   // nothing was ever opened
  expect(seen…).toEqual(["clear"])  →  received []  // no history activity
```

and `packages/tui/test/clear-resume.test.tsx` — the REAL `App`, frames of
ink-testing-library, over that same stack, seeded like `--resume`:

```
(fail) REPRO (App): /clear on a resumed session nothing has opened replaces the chat
  Expected to contain: "the OLD chat"
  ...received the same old chat ...        // the bug: the chat never went away
```

Repro command:
`bun test packages/cli/test/clear-resume.test.ts packages/tui/test/clear-resume.test.tsx`
— on main, with the 4 product files reverted and the new tests kept, `3 fail /
2 pass` (the 3 failures are on the asserted property, not on an import). With the
fix: `5 pass / 0 fail`. `packages/client/test/clear-attach.test.ts` (the other
shape, below) is red on its own mutation.

**How the regression got in.** `git log -S` puts the whole block in one commit:

```
df42111 feat(clear-keeps-jobs): exec — /clear resets the conversation in the same
        session (session/clear on the compaction barrier), background work stays,
        PROTOCOL_VERSION 21 (sonnet)
```

`git blame -L 677,683 packages/client/src/remote-session.ts` → `df421117`
(2026-11-09 15:27) on every line of the hollow-return `clear()`; the TUI's
`{0,0}` handling is `7aab601` ("review round 1 … (sonnet)", 15:53), which
introduced the branch deliberately for review finding L6b — *"a `{0,0}` answer
decrements and lets go"* — as bookkeeping for `ownClearsRef`, **without a
notice**. Task doc: `docs/feat/clear-keeps-jobs.md` (own `L6 — (b)`, rewritten
by `866d9b2`, planned and executed by Sonnet, merged `66f2cbd`).

**Was `/clear` fine on a resumed session before it?** Yes — verified in a
scratch worktree at the parent commit (`df42111~1` = `866d9b2`,
`.tentacle/tmp/clear-silent-noop/pre-df42111`), driving the real `App` there
with a resumed seed and typing `/clear`: the transcript was GONE
(`createSession` called twice — the old legacy `close()` + `swapSession`). The
old `/clear` closed the (never-opened) session and swapped to a new in-memory
one, which cannot depend on a daemon id. The in-session reset does, and nobody
asked what happens when there is no session daemon-side yet.

**Why its tests and its review did not catch it.** Every `/clear` test of that
branch exercises the session AFTER a turn: `tui/test/clear.test.tsx` (a fake
controller, `T19a`…`T19l`: the rig types `hello` first), `tui`'s `clear-command`
tests (pure), `client/test/clear.e2e.test.ts` + `clear-race.test.ts` (a real
stack, always opened by a `send` first), `cli/test/clear-fork.e2e.test.ts` (a
real stack, `controller.send("the OLD chat")` first), `daemon/test/clear.test.ts`
(the host's `clear()` directly). Not one starts from a RESUMED, still-lazy
session — the shape the owner hits every day, because `--resume` + `/clear` is
the natural "drop this old chat" flow. The plan's own failure-mode table
(`docs/feat/clear-fork-history.md:607`) even lists it — *"14 · **Not opened
yet** (resumed, no prompt) · `clear` is a daemon no-op, `lastRead` null: no
fork, file untouched"* — and treats it as ACCEPTABLE, which is exactly the
judgement that hid the bug. `clear-keeps-jobs.md:377` also records *"(2) No
test drives the real worker thread or the real `App` over the real
`RemoteSession`"*, so the App/stack seam this broke had no test at all.

**Why the failure is SILENT (a §7 drop of its own).** Three layers swallow it:
1. The client turns "there is nothing to clear" into a SUCCESS shape:
   `{before: 0, after: 0}` (`remote-session.ts:679-681`), indistinguishable from
   a real clear in the caller's eyes.
2. The TUI's `{0,0}` branch (`App.tsx:1949-1956`) only *releases the latch* and
   wakes a held-over wake — deliberately bookkeeping (L6b) — with no notice, and
   its comment ("no session open yet: `{0, 0}`, no history coming") shows the
   case was KNOWN and accepted as normal.
3. `persistingController.clear` (`local-runtime.ts:487-512`) then reads back
   nothing new, `flush`es, forks nothing (`lastRead` null) and resolves — so
   even the log store sees a harmless no-op.
Nothing throws, so no `clearErrorNotice` path runs. The user gets one emptied
input box and no fact.

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Load-bearing assumption

**A resumed session's conversation exists only as the client's seed until
something opens it, and `/clear` can open it exactly as the first prompt would.**
Verified: `local-runtime.ts:770-778` (the seeded `newSession`, no `attach`),
`remote-session.ts:321-360` (`createOrAttach`, memoized, awaited by the first
send), `remote-session.ts:297-299` (`open()` is a no-op without `attach`). The
open is `session/open{create, messages}`: atomic daemon-side, an existing live
id is ATTACHED — so opening cannot clobber a session another device already has.

### Preconditions

- `session/open` with the seed and an existing uid attaches-or-creates atomically
  (`remote-session.ts:291-350`; `daemon/src/session-host.ts` open handler).
- Once open, `session/clear` is the ordinary in-session reset of
  `feat/clear-keeps-jobs` (daemon `HostedSession.clear`,
  `hosted-session.ts:2439-2500`) — nothing about it changes here.
- The fork of the dropped chat needs a read-back that describes the PRE-clear
  history: `persistingController.clear` reads back first (`local-runtime.ts:489`,
  `clearSent` guard `:494`), so the open must happen BEFORE that read, or the
  fork is skipped (`clear-fork.e2e` semantics).
- `AGENTS §7` persistence: no format, no wire, no protocol change here — an
  additive client-side open on a path that already has one.

### Design

Three small, additive steps, in dependency order:

1. **`RemoteSession.openForClear()`** (`client/remote-session.ts`): if the
   session has no daemon id yet AND holds a seed, do the first prompt's own open
   (`attach ? open() : openSeeded()`). A separate method (not inlined in
   `clear()`) because the caller must read the pre-clear history back BETWEEN
   the open and the clear.
2. **`RemoteSession.clear()`** awaits it, then does what it always did. A
   session with no seed (a fresh one) never opens: `/clear` must not CREATE a
   session. `{0, 0}` stays the answer there — but now it means what it says.
3. **`persistingController.clear`** (`cli/local-runtime.ts`) awaits
   `inner.openForClear?.()` first (`?.`: unit-test fakes), so the read-back
   below finds the pre-clear history and the fork is kept.
4. **The loud path** (`tui/src/clear-command.ts` + `App.tsx`): a `{0, 0}`
   answer while the transcript holds a conversation (any `user` or `tool` row —
   a fresh session's welcome line is neither) pushes
   `CLEAR_DID_NOTHING_NOTICE`, so even a clear that resets nothing can never be
   silent again. Pure predicate `clearNoopNotice`, per §7 ("logic in pure
   modules").
5. **The attach window** (found by writing the second shape's test, in
   `openForClear` itself): an attach-only session (`connect`, `attach`) whose
   eager dial has not answered also has no id, so `/clear` in that window was
   the same silent `{0,0}`. `openForClear` now waits for that very attach
   (memoized) and clears THAT session; the seed guard applies to the
   create-or-attach path only. 6 lines, same method, same class of bug.

### Files

| File | Change |
|---|---|
| `packages/client/src/remote-session.ts` | `openForClear()`; `clear()` awaits it |
| `packages/cli/src/local-runtime.ts` | `persistingController.clear`: `await inner.openForClear?.()` before the read-back |
| `packages/tui/src/clear-command.ts` | `CLEAR_DID_NOTHING_NOTICE`, `clearNoopNotice` |
| `packages/tui/src/App.tsx` | `runClear`'s `{0,0}` branch: show it |
| `CHANGELOG.md` | `[Unreleased]` → Fixed |
| tests | `packages/cli/test/clear-resume.test.ts`, `packages/tui/test/clear-resume.test.tsx`, `packages/client/test/clear-attach.test.ts`, `packages/tui/test/clear-command.test.ts` |

### Failure modes

| # | Case | Converges to |
|---|---|---|
| 1 | RESUMED, not opened, `/clear` | open (attach-or-create) → clear → `history{clear}` → transcript replaced, fork kept. FIXED. |
| 2 | RESUMED, already opened (a turn ran) | `id` set → `openForClear` returns at once → as today. |
| 3 | Fresh session, nothing to clear | no seed → never opens → `{0,0}`, no notice (nothing was lost). |
| 4 | RESUMED, open FAILS (deleted/archived elsewhere, link down) | `open()`/`openSeeded()` rejects → `clear()` rejects untouched → the existing `clearErrorNotice` ("`/clear failed: … — still in this session`") — loud, chat intact. |
| 4b | ATTACH whose eager dial is still in flight (`connect`, `attach`) | `openForClear` waits for that very attach (`open()` is memoized) and clears THAT session. FIXED (same class, same method). |
| 5 | `/clear` opened the session but the clear is refused (`TurnInProgress`, compaction on another device) | daemon error → rejection → existing failure notice; the session stays open (harmless: it is the same session the next prompt would have made). |
| 6 | Link drops AFTER the open, before the clear's answer | `clearRefused` false → `armFork` + rethrow → the "no answer / not retried" notice (unchanged path). |
| 7 | `/clear` twice | the second has an id: no open, ordinary clear of the already-fresh chat. |
| 8 | Another device already has this uid live | `session/open` ATTACHES (never recreates); the clear then resets the SHARED chat, as any `/clear` on a shared session does — and says "cleared on another device" only to the others. |
| 9 | `--resume` of an ARCHIVED id (`serve`) | `openSeeded` rejects `UnknownSession`/archived → case 4: a clear failure notice, nothing created. |
| 10 | The `{0,0}` notice on a session whose chat really is empty | no `user`/`tool` row → silent (case 3). The welcome line never triggers it. |

### Tests

- `cli/test/clear-resume.test.ts` — real stack, resumed record in the owner's
  shape: `{before: 6, after: 1}`, one `history{clear}` activity, `host.size === 1`,
  a FORK record in the store, and the next prompt's model request has none of the
  old messages (the ctx ~19% symptom). Plus: a fresh session stays `{0,0}` with
  no session created. **Red on main** (3 assertions).
- `tui/test/clear-resume.test.tsx` — the REAL `App`, ink frames, over the same
  stack, seeded like `--resume`: after `/clear` the old chat is gone from the
  frame, no complaint, and the next prompt reaches the model without it.
  Plus the loud path: a `{0,0}` `clear` with a chat on screen shows
  `/clear did nothing`; an empty transcript shows nothing. **Red on main** (2).
- `tui/test/clear-command.test.ts` — `clearNoopNotice` unit: `chatShown` gates it,
  a real clear never complains.
- `client/test/clear-attach.test.ts` — the same silence in its OTHER shape: an
  attach-only session (`connect`, `attach`) whose eager `session/open` is held
  80 ms. `/clear` in that window must wait for the attach and clear THAT
  session (`{before: 3, after: 1}`, a `history{clear}` activity, the writer's
  next read-back without the old chat). **Red on the mutation** (drop the
  `attach` branch → `{0, 0}`).
- Mutations (each restored, `git diff` unchanged after): drop `openForClear`'s
  body → both resume tests red; drop the seed check (`id === null` only) → the
  fresh-session test red; drop the `attach` branch → `clear-attach` red; drop the
  `pushNotice` in `App.tsx` → the loud-path test red; drop
  `inner.openForClear?.()` → the cli resume test red.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

**As built.** Additive, 4 product files (99 changed lines: `client/remote-session.ts`
+41/-3, `cli/local-runtime.ts` +7, `tui/src/clear-command.ts` +20,
`tui/src/App.tsx` +20/-2; **43 added code lines excluding comments** — within the
S–M budget) and 4 test files.

1. Reproduced first, on a scratch worktree of this branch (`bun install` once —
   the worktree had no `node_modules`): `cli/test/clear-resume.test.ts` red on
   `{before: 6, after: 1}` vs a received `{0,0}`, then `tui/test/clear-resume.test.tsx`
   red showing the seeded chat still on screen after `/clear`.
2. Root cause from the repro: the client's hollow return; the daemon had no
   session (no `session/open` had happened).
3. Pre-regression check at `df42111~1` (`pre-df42111` worktree): `/clear` on a
   resumed session worked there (legacy close+swap, `creates: 2`, transcript
   gone). So this is a regression of `df42111`, not a pre-existing gap.
4. Fix in the plan's order. Two drifts from the draft Implementation, both kept
   because the plan's own preconditions demanded them:
   - `openForClear` had to become a SEPARATE public method, not an inlined
     `if` inside `clear()`: `persistingController.clear` reads the pre-clear
     history back **between** the open and the clear, and an inlined open made
     that read post-open-but-pre-clear impossible (`lastRead` stayed null, no
     fork). Found by the fork assertion of the cli test going red — the read-back
     is what `clear-fork-history` depends on.
   - `chatShown` counts `user`/`tool` rows only, not `assistant` rows: the fresh
     session's WELCOME line is an `assistant` item, so the first shape of the
     predicate nagged on a brand-new session (found by the "empty transcript"
     test I wrote for exactly that).
5. Red→green evidence, on the FIXED tree with the product files reverted
   (`git checkout -- <the 4>`, tests kept): `3 fail / 2 pass`; restored
   (`git apply` of the saved diff): `5 pass / 0 fail`.
6. Mutations (§9), all restored, `git diff` verified back to the fixed state:
   - `openForClear` body → `return` immediately: both resume tests red
     (`REPRO (App) … replaces the chat`, `REPRO /clear … resets it`).
   - `openForClear` without the seed guard: "a fresh session … is left alone" red.
   - `openForClear` without the `attach` branch: `clear-attach.test.ts` red
     (`{0, 0}` — the attach-only window of `connect`/`attach`).
   - `App.tsx` without the `pushNotice(noop)`: "a /clear that resets NOTHING …
     says so" red.
   - `local-runtime.ts` without `await inner.openForClear?.()`: the cli resume test
     red (no fork record).
7. The silent path made loud: `CLEAR_DID_NOTHING_NOTICE` + `clearNoopNotice`, shown
   only when a `{0,0}` answer meets a chat on screen. With fix 1 in place the real
   path no longer hits it; it is the guard that makes any FUTURE hollow clear
   say so instead of nothing.
8. CHANGELOG `[Unreleased]` → **Fixed** entry added.
9. `bun run check` (typecheck → lint → test), once at the end: typecheck clean,
   `biome check .` clean (824 files, 0 errors — formatting fixes applied to my
   own edits only), `bun test` **6352 pass / 3 skip / 0 fail** across 448 files
   (the 3 skips are the opt-in ones of §6: live-k8s, live-docker, the real-socket
   keepalive test).

**Not done / left.** (a) No `serve`/pod variant test: the fix is client-side and
transport-agnostic, and `openSeeded`/`open` are the same calls every runtime uses
— unverified against a real remote daemon (verify by `--resume` + `/clear`
against a `serve`, and `/clear` on a `connect` TUI whose link is slow).
(b) The `{0,0}` notice is only reachable through a contrived controller now; it is
deliberate belt-and-braces, not a live path. (c) `/compact` has the same hollow
`{0,0}` return for an unopened resumed session (`remote-session.ts:721-726`) — the
same class of bug, out of this task's scope; worth its own entry in `TODO.md` (not
touched, per instruction). (d) `TODO.md` untouched, nothing committed.
