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

## Review

*— claude-opus-5-5, 2026-11-10* (fresh context; a different model family from the executor)

**Verdict: REQUEST-CHANGES** — the core fix is right and tested at the real
interface, but the open it adds can deliver the attach snapshot into the
`/clear` latch, and the user's own clear is then announced as someone else's.

### Findings

**M1 — your own `/clear` says "the conversation was cleared on another device"
when the open ATTACHES a live session** (Implementation's failure modes 8 and 4b).
`App.tsx:1935-1936` raises `clearingRef` and `ownClearsRef += 1` *before*
`session.clear()`. Then `openForClear` (`remote-session.ts:707-717`) attaches.
The attach's snapshot is a `history{reason: null}`, and at `App.tsx:1539-1544`
it releases the latch and **zeroes `ownClearsRef`**. So when the clear's own
`history{clear}` arrives, `ownClear` is false (`:1527`) and the TUI pushes
`CLEARED_ELSEWHERE_NOTICE` (`:1553`). The latch also lets go before the clear
has landed.
*Scenario (reproduced, real `App` over real RPC,
`.tentacle/tmp/clear-silent-noop/review/attack.ts live-elsewhere`):* a second
client keeps the uid live with one turn, then this TUI is `--resume`d and runs
`/clear`. The frame shows `⏺ the conversation was cleared on another device`.
The chat itself is cleared correctly, and a prompt typed right after still went
out on a clean context (`attack2.ts live-type` → `["sys","next"]`). The same
sequence applies to 4b (`/clear` typed during a `connect`/`attach` eager dial).
Row 8 of the plan ("says 'cleared on another device' only to the others") is
FALSE as built. The new tests miss it because none attaches to a live id from
the App (`clear-attach.test.ts` checks the client only).
*Fix:* in `runClear`, do the open first and arm the bookkeeping after it:
`clearingRef.current = true; await session.openForClear?.();` (it settles after
the snapshot has been applied), then `clearingRef.current = true;
ownClearsRef.current += 1; session.clear()`. Expose `openForClear?` on the TUI
session type and the persisting controller. Add the App test above (session live
on a second client → `/clear` → frame has no "another device"). Show it red
first.

**M2 — `/compact` has the same hole, and the TUI reports a false success**
(executor's (c), confirmed). `remote-session.ts:720-725` returns `{0,0}` without
opening. `App.tsx:2148-2151` takes that as `ok`, and `send-now.ts:108` prints
`Context compacted — 0 → 0 messages.`, so the context is untouched and the user
is told otherwise. `ownCompactionsRef` (`:2116`) stays at +1 because only
`!ok` decrements it (`:2124`). The next FOREIGN compaction is then treated as
this client's, and its "on another device" notice is swallowed.
*Fix (batches into this branch):* rename `openForClear` → `openForReset` and
`await` it at the top of `RemoteSession.compact()`. `persistingController.compact`
needs no change: it flushes after the compact, and no fork is involved. Apply
M1's open-first ordering to the `/compact` handler too: increment
`ownCompactionsRef` after the open. Test: a resumed, unopened session →
`/compact` → `before > 0` and the model's next request is the compacted one.

### Checked and holding

- **Gate:** `bun run check` → typecheck clean; `biome` 824 files with no fixes;
  `bun test` **6352 pass / 3 skip (opt-in) / 0 fail**, 6355 tests across 448
  files.
- **Mutations** (restored by file copy, `git status` clean afterwards): removing
  `await inner.openForClear?.()` from `local-runtime.ts:494` turns
  `cli/test/clear-resume.test.ts` red (1 fail). Removing the `attach` branch of
  `openForClear` turns `clear-attach.test.ts` red (1 fail). Both restored.
- **Tree vs. the commit:** `git status` was clean when the review started and is
  clean now. `git diff main...HEAD` holds all four product files plus the tests,
  and the gate is green on it. Nothing from the executor's `checkout`/`apply`
  round-trip was lost (it is still a process breach of §9).
- **Fork / persistence:** the open happens before the bounded read-back
  (`local-runtime.ts:494` → `:496-497`), so `lastRead` holds the resumed chat and
  `armFork` queues it before the post-clear `flush` (`:519-520`). The cli test
  asserts the fork record. `connect` goes through `RemoteSession.clear()`, which
  awaits the same open and keeps no laptop copy. No `serve` e2e was run
  (executor's (a); still unverified).
- **Open failure:** a rejection from `openForClear` happens before `clearSent`,
  so it never arms a fork. It reaches `runClear`'s reject branch
  (`App.tsx:1976-1990`), which releases the latch and shows `clearErrorNotice`.
  That path is loud.
- **Notice (`clearNoopNotice`):** it fires only on `{0,0}` with a `user`/`tool`
  row on screen, never on an empty or welcome-only transcript (that test was
  run), and only in the success branch, so it cannot mask an error.
- **History account:** `git log -S` places the hollow `clear()` in `df42111` and
  the `{0,0}` TUI branch in `7aab601`, and `clear-fork-history.md:607` row 14
  says exactly what the doc quotes. The account is **correct**.
- **Attacks tried:** (1) a plain resumed `/clear` → cleared, no notice. OK.
  (2) A prompt typed 1 ms after `/clear` → the model gets `["sys","next"]`. OK:
  the send awaits the same memoized open and the latch. (3) A session already
  live elsewhere → **M1**. (4) The same plus a quick prompt → context is right,
  wrong notice (M1). Not tried: a quit right after `/clear` (unverified, low
  prior: the persister flushes on exit as before).

### Executor behaviour

The diagnosis is precise and confirmed against git history. The fix is small,
the tests are at the real interface, and the mutations are honest. Two issues:
it reverted product files with `git checkout` for the red check (forbidden;
nothing was lost), and it asserted failure mode 8's convergence without testing
it, which is exactly where M1 is.

**Verdict: REQUEST-CHANGES (M1, M2).**

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Both Review findings, nothing else. No `git checkout`/`restore`/`stash` was run:
every red check and mutation was an exact inverse edit, reverted by hand.

### M1 — my own `/clear` announced as another device's

**What changed.** `packages/tui/src/App.tsx:1940-2041` (`runClear`): the open
now comes first. `runClear` raises `clearingRef` (the latch also gates the wake a
clear must delay), then `await`s `session.openForReset?.()` and only *after* it
settles arms `ownClearsRef += 1` and calls `session.clear()` (a `send()` closure).
An open rejection releases the latch, says `clearErrorNotice`, and wakes — with
no count armed, since none was raised. A view that left the session while the
open settled calls neither. `packages/tui/src/App.tsx:229-236` exposes
`openForReset?()` on `SessionController`; `packages/cli/src/local-runtime.ts:569-572`
forwards it (`persistingController`), and `:239-240`/`:494-499` declare and rename
it there in its own `clear` (memoized: the same open, so the pre-clear read-back
still finds the history that open applied — the fork is unchanged).

**Test** (`packages/tui/test/clear-resume.test.tsx`, "M1 (App)…"): a second
`LocalRuntime` on the SAME `SessionHost` keeps the uid live with one turn, then a
`--resume`d real `App` types `/clear`. Asserts: the old chat is gone, the frame
has no "cleared on another device", and the other client's own watcher DID see a
`history{clear}` (so the fix does not suppress the real foreign notice).

**Red on the pre-fix code** (the same file, before the App edit — this run is the
first `bun test` of the two new tests):
```
(fail) M1 (App): an own /clear of a session another device keeps live is not announced as theirs
  expect(frame).not.toContain("cleared on another device")
  Received: "⏺ the conversation was cleared on another device\n…"
  3 pass / 2 fail   Ran 5 tests across 1 file
```
**Green after:** `7 pass / 0 fail` for `clear-resume.test.tsx` +
`clear-attach.test.ts`; the reviewer's own repro
(`.tentacle/tmp/clear-silent-noop/review/attack.ts live-elsewhere`) went from the
notice repeated 18× to `grep -c "cleared on another device"` → `0`.

**Mutation M1** — the exact pre-fix ordering (`ownClearsRef.current += 1` moved
back before the open, the `send()` closure's increment removed):
`bun test packages/tui/test/clear-resume.test.tsx -t "M1"` → `1 fail` on
`expect(frame).not.toContain("cleared on another device")`, `0 pass`. Reverted by
the inverse edit; the M2 test stayed green throughout, so the mutation is
specific to M1.

### M2 — `/compact`'s hollow `{0, 0}` and the leaked own-compaction count

**What changed.**
- `packages/client/src/remote-session.ts:678-712,722-735`: `openForClear` → `openForReset`
  (its doc now says "a reset", `/clear` **or** `/compact`), and
  `RemoteSession.compact()` awaits it before reading `this.id` — so a resumed,
  never-opened session compacts the conversation its seed holds instead of
  answering `{0, 0}`. A fresh session (no seed, no attach) stays the plain no-op:
  a compaction never CREATES a session.
- `packages/tui/src/App.tsx:2142-2217` (`/compact` handler): the own-compaction
  count is raised inside the open's `then`, never before it, and an `armed` flag
  makes the settle decrement it only if this handler raised it (an open that
  failed raised none). The `compacting` latch is up meanwhile, so nothing starts
  a turn. `persistingController.compact` untouched, as the Review directed (it
  flushes after the compact; no fork is involved).
- `packages/cli/src/local-runtime.ts:239-240/494-499/569-572`: the rename and the
  forwarded `openForReset`.

**Tests** (red first, both run before the fix):
- `packages/tui/test/clear-resume.test.tsx`, "M2 (App)…": a resumed, never-opened
  real `App` runs `/compact` → the frame holds "Context compacted — 6 → 2
  messages" and not "0 → 0"; the model's next request no longer carries the old
  chat; and a later compaction by another client of the same daemon still shows
  "compacted on another device" (the count did not leak).
- `packages/client/test/clear-attach.test.ts`, "/compact opens a resumed session
  nothing has opened…": at the client alone, `compact()` on a seeded,
  never-opened session returns `{ before: 3, after: 2 }` and the snapshot no
  longer holds the old chat. This is the half the App test cannot hold once the
  App awaits the open itself — the mutation below proved it.

**Red on the pre-fix code:**
```
(fail) M2 (App): /compact on a resumed session nothing has opened really compacts
  expect(frame).toContain("Context compacted — 6 → 2 messages")
  Received: "…⏺ Context compacted — 0 → 0 messages.…"
```
**Green after:** the same runs that turned M1 green (7 pass / 0 fail).

**Mutation M2** — `RemoteSession.compact()` with the `await this.openForReset()`
line removed:
```
error: expect(received).toEqual(expected)
- {"after": 2, "before": 3}
+ {"after": 0, "before": 0}
(fail) /compact opens a resumed session nothing has opened and compacts THAT chat
1 pass / 1 fail
```
Reverted by the inverse edit. A second mutation, on the count itself (dropping
the `ownCompactionsRef.current -= 1` in the `history` handler so the count leaks),
turned the M2 App test red on exactly its foreign-notice assertion
(`Expected to contain: "compacted on another device"` → the notice is swallowed),
which shows that assertion is not vacuous. Recording one thing honestly: a third
attempt — arming `ownCompactionsRef` *before* the open in the App handler — did
**not** fail any test, because the App awaits the open and then the compaction's
own history arrives and decrements either way. The open-first ordering in the
`/compact` handler is kept (it is what makes the count mean "this TUI's
compaction that actually ran"), but it is not pinned by a test; only the client
half is mutated-red.

### Gate

`bun run check` → typecheck clean (`tsc --noEmit && tsc -p apps/mobile --noEmit`);
`biome check .` → 824 files, no fixes; `bun test` → **6355 pass, 3 skip (opt-in),
0 fail**, 6358 tests across 448 files.

### Drift / notes

- `/compact` arms nothing before its open, so the ordering there is not
  dead-reckoned red/green (see above); the client-level mutation is what holds
  M2's fix.
- `openForReset` is optional on `SessionController` and on the `PersistingController`
  interface (`?.` at both call sites), so bare test fakes that carry neither are
  unaffected.
- Cases (a) `serve`/pod e2e and (b) the now-contrived `{0,0}` notice from
  round 0 stand unchanged — neither was in this round's scope.
- `CHANGELOG.md` (Fixed) now names `/compact` alongside `/clear`, and both the
  own-clear notice and the own-compaction count.
- `TODO.md` untouched, nothing committed, all scratch in
  `.tentacle/tmp/clear-silent-noop/r1/` (`red.txt`, `green.txt`,
  `mut2-red.txt`).
