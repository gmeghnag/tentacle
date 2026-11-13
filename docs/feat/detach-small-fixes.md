# feat/detach-small-fixes — three contained leftovers from the detach-live triage

> **Status:** review (in-context; fresh-context review still owed)
> **Branch:** `feat/detach-small-fixes` (off `main` 5961917)
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** DeepSeek exec · standard Review
> **Changelog:** `changelog.d/detach-small-fixes.fixed.md` — one bullet (all three are user-visible)

## Context

*— deepseek-v4.1-flash (tentacle --profile deepseek), 2026-11-13*

Three items of `TODO.md:489` (`fix/detach-open-items`), triaged read-only in
`.tentacle/tmp/detach-triage/report.md` (`packages/tui/src/App.tsx` is **out of
scope**: `feat/app-decomposition` is splitting it, so item (3) of that entry —
the Enter/`/quit` permission leak — is not taken here, and neither is anything
else from it):

- **(4)** a `fs_multi_edit` permission ask shows `—` instead of a subject.
- **(5)** `[resume] <uid> — (empty)` is left on the screen after a TUI exits.
- **(9d)** `tentacle ps` says `1 background job(s) running` for up to 30 s after
  that job exited.

**Repro** (`repro.ts`, run from `.tentacle/tmp/detach-small-fixes/`; it imports
the worktree's sources and was run on this branch before any edit,
2026-11-13):

```
== (4) fs_multi_edit ask ==
title: "Run MultiEdit"
detail: undefined
dialog rows: ["—"]
one edit, detail: undefined
malformed (no edits array), detail: undefined

== (5) [resume] line ==
--resume aaaaaaaa lines: ["[resume] aaaaaaaa-1111-4111-8111-111111111111 — (empty)\n"]
--resume bbbbbbbb lines: ["[resume] bbbbbbbb-2222-4222-8222-222222222222 — dimmi tre fatti sui polpi\n"]

== (9d) relay `ps` after a job exit ==
after the poll (jobs=1): {"state":"running","detail":"1 background job(s) running"}
after job_exit (the job is gone): {"state":"running","detail":"1 background job(s) running"}
after a `jobs` frame (n=0): {"state":"idle"}
```

The script is pasted in full at the end of this section (`.tentacle/` is
gitignored, AGENTS §6).

**Second repro, item (5)'s scale** (`r5b-empty.ts`): a wake continuation
(`drive("")`) does **not** add an empty user message — `user rows:
[{"content":"dimmi tre fatti sui polpi"}]`, so the `(empty)` of the repro above
comes from a history whose only `user` rows are tentacle-written *notes* (a
`/clear`ed chat, then a wake), not from an empty prompt. That decides the fix
(see Implementation §(5)).

```ts
// .tentacle/tmp/detach-small-fixes/repro.ts — `bun run repro.ts` from that folder
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = "../../../packages";

const { describeToolCall } = await import(`${P}/agent/src/permission-gate.ts`);
const { permissionDetailLines } = await import(`${P}/tui/src/permission-ui.ts`);
const { fsMultiEditTool } = await import(`${P}/tools/src/builtins.ts`);
const { projectKey } = await import(`${P}/agent/src/session-store.ts`);
const { LogSessionStore } = await import(`${P}/daemon/src/index.ts`);
const { openTuiSessions } = await import(`${P}/cli/src/tui-sessions.ts`);
const { initialRelay, relayStep, relayView } = await import(`${P}/cli/src/relay-state.ts`);

const show = (label: string, value: unknown): void =>
  console.log(`${label}: ${JSON.stringify(value)}`);

// ---- item 4: a `fs_multi_edit` permission ask's dialog rows -----------------
{
  console.log("== (4) fs_multi_edit ask ==");
  const req = describeToolCall(fsMultiEditTool as never, {
    path: "src/a.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  show("title", req.title);
  show("detail", req.detail);
  show("dialog rows", permissionDetailLines(req));
  const one = describeToolCall(fsMultiEditTool as never, {
    path: "src/a.ts",
    edits: [{ old_string: "a", new_string: "b" }],
  });
  show("one edit, detail", one.detail);
  show(
    "malformed (no edits array), detail",
    describeToolCall(fsMultiEditTool as never, { path: "src/a.ts" }).detail,
  );
}

// ---- item 5: the `[resume] … — (empty)` line --------------------------------
{
  console.log("\n== (5) [resume] line ==");
  const dir = await mkdtemp(join(tmpdir(), "dsf-"));
  const store = new LogSessionStore(join(dir, projectKey("/w")));
  const base = { cwd: "/w", model: "m", createdAt: 1, updatedAt: 5 };
  // A session whose only user message is a tentacle-written note (a `/clear`
  // head note): it HAS history, but no message a person typed.
  const NOTE_ONLY = "aaaaaaaa-1111-4111-8111-111111111111";
  // A normal session, for contrast.
  const TYPED = "bbbbbbbb-2222-4222-8222-222222222222";
  await store.saveSnapshot({
    ...base,
    id: NOTE_ONLY,
    title: { source: "auto" },
    messages: [
      { role: "user", content: "continue", note: { kind: "background_exit", id: "bg-1" } },
      { role: "assistant", content: "the job printed WAKE-DONE" },
    ],
  } as never);
  await store.saveSnapshot({
    ...base,
    id: TYPED,
    title: { source: "auto" },
    messages: [
      { role: "user", content: "dimmi tre fatti sui polpi" },
      { role: "assistant", content: "1. …" },
    ],
  } as never);
  for (const uid of [NOTE_ONLY, TYPED]) {
    const typed: string[] = [];
    await openTuiSessions({ root: dir, cwd: "/w" }, { wanted: true, uid }, (l) => typed.push(l));
    show(`--resume ${uid.slice(0, 8)} lines`, typed);
  }
  await rm(dir, { recursive: true, force: true });
}

// ---- item 9d: does `job_exit` clear the run's job count? --------------------
{
  console.log("\n== (9d) relay `ps` after a job exit ==");
  // The run's turn is over (a `ps` state that says something), then the 30 s
  // poll leaves one job running.
  const over = relayStep(
    relayStep(initialRelay, { type: "turn_started" }),
    { type: "turn_ended", reason: "end_turn" },
  );
  const polled = relayStep(over, { type: "jobs", n: 1 });
  show("after the poll (jobs=1)", relayView(polled));
  const exited = relayStep(polled, { type: "job_exit" });
  show("after job_exit (the job is gone)", relayView(exited));
  // What a daemon that sends the `jobs` frame does instead (H1: ONE writer).
  const framed = relayStep(polled, { type: "jobs", n: 0 });
  show("after a `jobs` frame (n=0)", relayView(framed));
}
```

## Implementation

*— deepseek-v4.1-flash (tentacle --profile deepseek), 2026-11-13*

### Load-bearing assumption

For (5): a plain `attach` of a kept run re-opens the run's own conversation
through the `--resume <uid>` seam, so it inherits `--resume`'s pre-mount line —
`main.ts:1717-1720` builds `openSessions(... new Map([...attachFlags, ["resume",
reopen]]), attachBools)` and `openSessions` (`main.ts:984-1001`) turns that flag
into `{ wanted: true, uid }`, with no `live`. Verified: that is the only caller
that resumes a uid the user never typed, and the suppression already exists one
branch over (`tui-sessions.ts:120-128`, for `live: true`).

For (9d): the count has exactly two writers, both silenced by the H1 flag — the
30 s poll (`relay.ts:563-573`) and the exit path's fresh read (`relay.ts:601-605`)
— while the daemon's `jobs` frame owns it once seen (`relay.ts:444-449`, set from
`session.onJobs`, whose frames the daemon publishes on a start and on an exit,
`hosted-session.ts:1415-1434`). So a job exit already corrects `ps` **when the
pod sends frames**; only the frame-less (older pod binary) path waits for the
poll. That is the defect left, and it is why the fix is at the *fallback* writer,
not in `relay-state.ts`.

### Preconditions

- `describeToolCall` has dedicated cases for `shell`, `fs_write`, `fs_edit`,
  `context_reset` and a `default:` that sets the label title only
  (`permission-gate.ts:33-64`); `permissionDetailLines` falls back to `"—"` when
  `req.detail` is unset (`tui/src/permission-ui.ts:144-153`). The dialog reads
  both (`App.tsx:1448`, `components/PermissionPrompt.tsx`).
- `fs_multi_edit`'s input is `{path, edits: [{old_string,new_string,replace_all?}]}`
  (`tools/src/builtins.ts:209-242`), `permission: "ask"`, and the transcript row
  already renders `path · N edits` for the same tool (`tui/src/render-lines.ts`,
  `toolSubtitle`'s `fs_multi_edit` case) — the wording this fix mirrors.
- `sessionTitle` names a session after the first user message **not** written by
  tentacle (`agent/src/session-store.ts:88-99`), and `(empty)` is its documented
  "nothing the person wrote yet" sentinel, round-tripped by
  `recordTitleState`/`EMPTY_TITLE` (`:65-74`; pinned by
  `agent/test/session-store.test.ts:24-37` and
  `agent/test/session-title-record.test.ts:64`).
- `ResumeRequest` (`cli/src/tui-sessions.ts:33-48`) is read only by
  `openTuiSessions`; its three callers are `main.ts:984`, `main.ts:1607`
  (`live: true`) and `relay.ts:343` (`{wanted: false}`).
- `relay-state.ts:112-113` (`job_exit` steps only the wake model) and
  `:150-151` (a `jobs` event is the count's only writer); `job_exit` is emitted
  from two places — `runtime.jobs.onExit` (`relay.ts:426-428`) and a waking
  sub-agent notify (`relay.ts:453-459`) — so **it is not one job's death** and
  must not decrement the count.

### Design

**(4) `fs_multi_edit` gains a subject.** Add one case beside `fs_edit` in
`describeToolCall` (`agent/src/permission-gate.ts`): title `Edit a file` (the
same act as `fs_edit`), `detail` = the path, plus ` · N edits` when `edits` is a
non-empty array (singular for one) — the wording the transcript row already
uses. A malformed input (no `path`, `edits` not an array) degrades to whatever
is present, never to `—` when there is a path, and never throws. No wire change:
`detail` is an existing free string on the request. The rule a "session"
approval remembers is the tool, not the detail (`session-grants.ts`), so nothing
else moves.

**(5) a uid nobody typed is not announced.** Generalise the existing rule: the
`[resume] <uid> — <title>` line exists to tell the person *which* session was
resumed, so it is skipped when tentacle chose the uid — a live run's session
(`live`) or a kept run's own conversation re-opened for an `attach`
(`implicit`). The two halves already implemented for `live` stay exactly as they
are (no line at all for a record-less uid; only the queued notices printed for a
recorded one); `implicit` joins the same condition, and `main.ts`'s reopen marks
its request `implicit: true`. What still prints is what the person needs: an
unreadable log (fatal, one line), a refusal, the picker's own failure, and the
`[resume] <warning>` lines of the LIST branch. Only the announcement goes.

`(empty)` itself is **not** changed: it is the honest title of a history the
person never typed into (see Preconditions), and re-deriving from a note would
name sessions `Background jobs still running: bg-1`. Once the announcement is
gone, `(empty)` cannot be reached by an unattended reopen — the only path that
printed it without being asked.

**(9d) a known exit refreshes the fallback count at once.** Keep one writer (H1):
on `job_exit`, if the daemon's `jobs` frame has **not** been seen
(`shellCounted === false`, the older-pod-binary path), poll the count now
instead of waiting up to `RELAY_JOBS_POLL_MS` (`relay.ts:89`). Implemented with
the file's existing late-bound-hook pattern (`let maybeWake = (): void => {}` at
`relay.ts:247`, assigned at `:460`): `let refreshJobs = (): void => {}` declared
beside the other hooks, assigned right after `pollJobs` is defined, called from
the exit handler. Once a frame has been seen the hook is a no-op: the daemon's
own count is already authoritative there, and `relay-state.ts` needs no change
(it already stores an absolute `n`).

> **Plan correction, found while writing the test (see Execution).** The exit
> subscription was itself conditional — `config.autoWake ? runtime.jobs.onExit(…)
> : () => {}` (`relay.ts:426-428`) — so with `autoWake: false` the relay listened
> to no exit at all and no refresh could be called. The subscription must become
> unconditional, with the WAKE alone gated by the setting: the count is not a wake
> decision. The plan as first written (a call inside `offExit`) would not compile
> into a working fix on that path; the design above is superseded by this note.

### Files

1. `packages/agent/src/permission-gate.ts` — the `fs_multi_edit` case.
2. `packages/tui/test/permission-detail.test.ts` (new) — (4)'s red-first test,
   at the boundary the person sees (`permissionDetailLines(describeToolCall(…))`).
3. `packages/cli/src/tui-sessions.ts` — `ResumeRequest.implicit`, the two halves
   of the `quiet` rule generalised.
4. `packages/cli/src/main.ts` — the plain-`attach` reopen passes `implicit: true`.
5. `packages/cli/test/main.test.ts` — (5)'s red-first test: the reopen writes no
   `[resume]` line.
6. `packages/cli/test/tui-sessions.test.ts` — (5)'s unit test (warnings kept,
   announcement gone; a record-less implicit uid says nothing).
7. `packages/cli/src/relay.ts` — `refreshJobs`.
8. `packages/cli/test/relay.test.ts` — (9d)'s red-first test in the
   `9d + H1` describe, on the frame-less path with a large `jobsPollMs`.
9. `changelog.d/detach-small-fixes.fixed.md` — one bullet.

### Failure modes

| Case | Convergence |
|---|---|
| (4) `edits` absent / not an array / empty (a hand-written hook rewrite) | detail is the path alone (`path` also absent → no detail, today's `—`), never a throw: `asRecord`/`str` already guard the shape |
| (4) a path-less multi-edit | title + label only, as `fs_edit` does today |
| (5) an implicit uid with **no** record | nothing written (same as `live`), and `main.ts` only passes `implicit` when `readSessionRecord` returned a record, so this path is unreachable in practice — kept honest by the unit test |
| (5) an implicit uid's log is unreadable, or the picker fails | unchanged: those lines are what the person still needs |
| (5) `--resume <uid>` / `--continue` typed by the person | unchanged: the announcement stays (they asked for that uid, and it names it) |
| (9d) the exit's poll is unanswered (`sessionJobs` → `null`) | the last value stands, the next tick's poll tells — the same rule the loop already uses (`relay.ts:567-571`) |
| (9d) a frame arrives anyway (a current pod) | `shellCounted` is true, the hook is a no-op: no second writer, no flapping (the existing H1 tests hold) |
| (9d) a waking sub-agent notify (also a `job_exit`) | refreshes the polled count, decrements nothing — one quantity, one writer |
| (9d) many exits at once | `polling` is already true → the extra calls set `staleJobs` and return; one re-read serves all of them, so reads never stack (see Fix round 1) |

### Tests

- **(4)** `packages/tui/test/permission-detail.test.ts`: `fs_multi_edit` with two
  edits → `["src/a.ts · 2 edits"]`; one edit → `· 1 edit`; a bare `{path}` → the
  path; `fs_edit` unchanged (`["src/a.ts"]`). Red first on the buggy code: the
  rows are `["—"]`.
- **(5)** `packages/cli/test/main.test.ts` (in
  `"attach-plain-resume: a plain kept container reopens the run's conversation"`):
  an `attach` that reopens a kept entry's record writes **no** `[resume]` line,
  and still resumes that uid (`seen.resume.id`). Red first: today `r.text`
  contains `[resume] 11111111-… — conv 1111`. Plus
  `packages/cli/test/tui-sessions.test.ts`: `implicit: true` with a record →
  `[]`, with a skipped file → only the warning; and the non-implicit call keeps
  the line (the existing test's property, restated against the new flag).
- **(9d)** `packages/cli/test/relay.test.ts`, `jobsPollMs: 600_000`, an injected
  `sessionJobs` answering 1 then 0 and a runtime whose `jobs` reports an exit
  (the frame-less daemon): after the exit, the poll count is re-read within a
  tick and `ps` leaves `running · 1 background job(s) running`. Red first: no
  extra read happens. Mutation: drop the `refreshJobs()` call from `offExit` →
  the test's read count stops advancing.

## Execution

*— deepseek-v4.1-flash (tentacle --profile deepseek), 2026-11-13*

**Repro first.** `repro.ts` (the Context's script) ran on this branch before any
edit — output pasted there. Two of its three sections reproduced exactly as
triaged; the third needed correcting, and that correction changed the fix:

- **(4)** reproduced: `dialog rows: ["—"]`, `detail: undefined`.
- **(5)** reproduced: `[resume] aaaaaaaa-… — (empty)`, and no line for
  `live: true`. `r5b-empty.ts` ruled out the triage's second half — a wake
  continuation (`drive("")`) does **not** add an empty user message (`user
  rows: [{"content":"dimmi tre fatti sui polpi"}]`), so `(empty)` needs a history
  of tentacle-written notes, not an empty prompt. Hence the fix is the *line*,
  not `sessionTitle`; implementation stayed as planned, and the doc says so.
- **(9d)** reproduced in the pure state (`job_exit` leaves
  `running · 1 background job(s) running`), **but the real relay only reaches
  that state on the frame-less (older pod binary) path**: `probe` of the wiring
  showed the current pod publishes a `jobs` frame on every start and exit
  (`hosted-session.ts:1415-1434`), and the existing H1 tests already cover
  "the frame owns the number". So the defect left is the fallback writer, and the
  fix belongs there — as designed (Design §9d), with one drift below.

**As-built, in plan order (each slice red → green on its narrow file):**

1. **(4)** `agent/src/permission-gate.ts:58` (the case) + a private
   `multiEditSubject` helper beside `detail` (`:82`). Test first:
   `tui/test/permission-detail.test.ts` (new, 6 tests) — **red** on 4 of 6
   (`- "src/a.ts · 2 edits" / + "—"`). Green after.
   *Drift:* the old `agent/test/permission.test.ts:276` used `fs_multi_edit` as
   its example of a **caseless** labelled tool — that example died with the fix,
   so it now uses `search` (`:276-281`), and a new test pins the multi-edit title
   (`:283-288`). Not a weakening: the property it pins (a labelled, caseless tool
   reads `Run <Label>`) is unchanged, on a tool that still has no case.
2. **(5)** `cli/src/tui-sessions.ts:50` (`ResumeRequest.implicit`) and
   `:133` (one `silent` for `live || implicit`, the existing `live` rule kept
   verbatim); `cli/src/main.ts:984` (`openSessions`'s new `implicit` argument,
   passed by the reopen at `:1725`). Tests first, in both halves: `main.test.ts` "…reopened from the laptop record…" — **red**
   `Expected to not contain "[resume]" / Received: "[resume] 11111111-… — ciao"`;
   `tui-sessions.test.ts` ×3 (implicit silent, implicit record-less silent,
   explicit still announced) — **red** on 2. Green after.
   *Drift (test, not code):* this slice first pinned "an implicit uid's warnings
   are still printed" via a skipped-file warning — but warnings only exist on the
   LIST branch of `resolveResume`, which an explicit uid never takes, so that
   assertion was vacuous. Replaced by the case that really does print for an
   explicit uid: an **unreadable** log stays fatal and loud (`{ exit: 1 }` +
   one line). The Design's "warnings kept" row is therefore true only of
   `notices`; the printed half is now pinned by the unreadable record.
3. **(9d)** `cli/src/relay.ts:252` (the `refreshJobs` hook, declared beside
   `maybeWake`), `:593` (its body, right after `pollJobs`), and `:435`
   (the exit subscription made unconditional, with the WAKE alone gated on
   `config.autoWake`). Test first:
   `relay.test.ts` "no frames (an older pod binary): a job's exit refreshes the
   polled count at once (9d)" — **red** `Expected: > 1 / Received: 1` (no second
   read). Green after.
   *Drift (code, and the reason):* the plan put `refreshJobs()` inside `offExit`
   as it stands — but `offExit` was **conditional**: `config.autoWake ? runtime
   .jobs.onExit(...) : () => {}`, i.e. with `autoWake: false` the relay listened
   to no exit at all. The count is not a wake decision, so subscribing only for
   the wake was the actual defect's shape; the subscription is now unconditional
   and the wake alone is gated. A second drift: the test needs a job to *exist*
   for `remove` to fire, and `resident()` was given no daemon-side jobs at all —
   the test now injects its registry on the runtime (`jobs: shellJobs`) while
   still giving the daemon none, so no `jobs` frame exists (`shellCounted`
   false) — the older-pod-binary path, exactly.
4. **Changelog:** `changelog.d/detach-small-fixes.fixed.md`, one bullet.
   Validated by the repo's own parser (`readFragmentDir`/`parseFragments`):
   `ours: fixed · 1 line(s)`. `CHANGELOG.md` untouched.

**Mutation checks** (each fix re-broken, the test re-run, then restored):

| # | Mutation | Result |
|---|---|---|
| 4 | the `case "fs_multi_edit"` removed | `2 pass / 4 fail` (the 4 multi-edit tests), restored → 6 pass |
| 5 | `silent` reverted to `resume.live === true` | `tui-sessions.test.ts` `17 pass / 2 fail`; `main.test.ts` `attach-plain-resume` `14 pass / 1 fail`; restored → 19 and 15 pass |
| 9d-a | the `refreshJobs()` call dropped from the exit handler | red (`Expected: > 1 / Received: 1`), restored → green |
| 9d-b | the subscription gated by `autoWake` again | red, same assertion, restored → green |

**Gate:** `bunx tsc --noEmit` clean · `bun run lint` clean (0 errors, matching
the §6 baseline; `biome check --write` applied formatting to two of the new
files) · `bun test`: `7625 pass, 3 skip, 1 fail` — the three opt-in skips are the
documented ones (§6). The one failure is **not this task's**:
`daemon/test/session-log-store.test.ts` "T4 the fork precedes the source's next
write" (`Expected: 1 / Received: 2` on `control.forkTemps`). That file is
untouched here (`git diff --stat` above lists no `daemon/` file), it imports
nothing this task changed, and it passes 3/3 in isolation
(`bun test packages/daemon/test/session-log-store.test.ts` → `45 pass`); its
assertions are `Bun.sleep(60)`-timed, so it is load-sensitive under the parallel
suite. Reported rather than papered over: the honest gate line is "green except
one pre-existing flake, named".

## Review

*— deepseek-v4.1-flash (tentacle --profile deepseek), 2026-11-13*

**A fresh-context pass is NOT done here** — this is the implementing model's own
adversarial re-read, so §10's "ideally a fresh context" is unmet. Stated rather
than implied. What was checked:

- **Gate re-run** (after every mutation was restored): `bunx tsc --noEmit`
  clean, `bun run lint` clean, and the changed/added test files green —
  `125 pass / 0 fail` over `relay.test.ts`, `tui-sessions.test.ts`,
  `permission-detail.test.ts`; `164 pass / 0 fail` with `main.test.ts` and
  `permission.test.ts`. The full-suite line is in Execution, with its one
  named, unrelated flake. A second full run was started and abandoned: four
  other agents were running suite-wide tests on this machine and it never got
  past the contention, so the first run's result stands.
- **Non-vacuity:** four mutations, each red on the assertion (not on an import
  or compile error), then restored green — the table in Execution.
- **§7 invariants:** nothing here touches the session path, the broker, the
  protocol or a persisted format. `describeToolCall`'s `detail` is an existing
  free field of an in-memory request; `implicit` is a CLI-internal option;
  `refreshJobs` reuses the runtime's existing `sessionJobs` read and keeps H1's
  one-writer rule (`shellCounted`/`polling` guards). No `PROTOCOL_VERSION` bump
  is owed.
- **What does NOT hold:** (a) item (5)'s `(empty)` **title** is unchanged —
  `sessionTitle` still answers `(empty)` for a history with no message a person
  typed. Deliberate (re-deriving from a note would name sessions
  `Background jobs still running: bg-1`), but a reader expecting the title to
  change will not find it here. (b) A **current** pod binary's path is
  unchanged: it already published the frame. (c) `ps` still shows a stale count
  for an exit the relay never hears about (a SIGKILLed relay, a dropped link) —
  the hook fires on the runtime's exit notice, which needs the link.
- **Executor behaviour:** two design corrections were needed and are recorded as
  drift rather than silently absorbed — the `autoWake`-gated exit subscription
  (the plan's 9d fix could not have worked without un-gating it) and the
  `live`-only warning half of item 5 (vacuous on the explicit-uid branch). One
  existing test had to change its example tool (item 4 made `fs_multi_edit` no
  longer caseless); the property it pins is unchanged, and a new test pins the
  new title. No `App.tsx` edit; no `git checkout/restore/stash/commit`; scratch
  only in the worktree's own `.tentacle/tmp/detach-small-fixes/`.




## Review

*— claude-opus-5-5, 2026-11-13* (fresh-context adversarial review; a different model family from the executor)

**Verdict: REQUEST-CHANGES** (one MEDIUM, small fix).

1. **MEDIUM — `packages/cli/src/relay.ts:593-598` (`refreshJobs`) drops the refresh when a poll is in flight.** The comment ("a read in flight is already the freshest one") and Implementation's failure-mode row (`polling` already true → return) are false: a `session/list` read issued *before* the exit can answer with the pre-exit count. Scenario (older pod binary, `shellCounted` false): the 30 s loop poll starts at t0 → the job exits at t0+ε, `refreshJobs` sees `polling` and returns → the in-flight read resolves with `jobs: 1` → `ps` says `1 background job(s) running` until the next poll, ~30 s — exactly the symptom item 9d claims to remove ("as soon as the job exits" in the changelog fragment). Fix: on `polling`, set a `stale` flag, and have `pollJobs`' completion re-poll once when it is set; add a test that holds a `sessionJobs` read open across the exit.

**Gate (touched files):** `bun test` of permission, permission-detail, tui-sessions, relay, main tests — 264 pass / 0 fail. `bun run lint` clean (963 files); `bun run typecheck` clean. Full suite not re-run by me.

**Mutation (all applied together, then reverted; `git status` clean after):** drop `refreshJobs()` from the exit hook → the 9d test fails; pass `false` instead of `reopen !== undefined` in `main.ts` → the attach-plain-resume test fails; rename the `fs_multi_edit` case → 5 tests fail (permission + permission-detail); drop `implicit` from `silent` → both `implicit` tui-sessions tests fail. 9 fails total, each on its assertion. Non-vacuous.

**Attacks tried:**
- §7 compute/identity (pod not trusted): `describeToolCall`'s new `detail` is pod-computed but display-only — `title`/`detail` key no decision or lasting approval (grep: only `PermissionPrompt.tsx` and the relay's auto-accept log, already `untrustedText`). Holds.
- `implicit` leaking to a person-chosen uid: `plainResumeUid` (`attach-plan.ts:144`) returns `undefined` whenever `--resume`/`--continue` is passed, so `implicit` is set only for the kept run's own uid; unreadable/fatal paths still print (tested). Holds.
- H1 one-writer: `refreshJobs` is gated on `shellCounted`, and `pollJobs` re-checks it on resolve. Holds.
- Un-gated `onExit` with `autoWake: false`: only the count refresh runs; no wake is emitted. Holds.
- Teardown: `sessionJobs` never rejects (`local-runtime.ts:1138`, catch → null), so there is no unhandled rejection. A late poll landing after `leave()` was already possible before this change. Not a new finding.
- Multi-edit malformed input (`edits` a string, empty, `null` input): no throw, falls back to path or `—`. Holds.

**Executor behaviour:** the drift (un-gating the exit subscription) is recorded honestly, and the mutations claimed are real. The one miss is the in-flight coalescing, asserted as safe without a test.

### Fix round 1

*— claude-opus-5-5, 2026-11-13*

Fixing the one finding of Review round 1 (no HIGH was raised; the review's
single MEDIUM). Scratch: `.tentacle/tmp/detach-small-fixes/` only. No
`git checkout/restore/stash/commit` was run.

**FINDING 1 (MEDIUM) — in-flight coalescing dropped the refresh. FIXED.**

- `packages/cli/src/relay.ts:574-611` — `refreshJobs` no longer returns silently
  on `polling`: it sets `staleJobs = true`, and `pollJobs`' completion re-polls
  once when that flag is set (and only while `shellCounted` is still false, so
  the H1 one-writer rule is untouched). The comment states the real reason:
  a read issued before the exit can answer the pre-exit count.
- `packages/cli/test/relay.test.ts` (`9d + H1` describe, new test "a read in
  flight across the exit is not trusted: the count is re-read once it lands
  (9d)") — holds a `sessionJobs` read open across the exit, resolves it with
  the stale `1`, and asserts exactly one extra read follows (`reads ===
  readsAtExit + 1`, so the coalescing is pinned, not just "some read
  happened"), then that `ps` leaves `1 background job(s) running`.
- **Red first:** with the pre-fix `refreshJobs` (`if (shellCounted || polling)
  return;`) the test fails on its own assertion — `error: timed out waiting for
  the re-read after the stale one` at `relay.test.ts:2916`, 1 fail. Green after
  the fix: 1 pass / 4 expects.
- **Mutations (each applied alone, run, reverted; the restored file is
  byte-identical to the green copy kept in scratch):**

  | Mutation | Result |
  |---|---|
  | `if (polling) { staleJobs = true; ... }` → `if (polling) { return; }` (drop the flag) | `timed out waiting for the re-read after the stale one` — 1 fail |
  | `if (staleJobs) { staleJobs = false; if (!shellCounted) pollJobs(); }` → `staleJobs = false;` (drop the re-poll) | same timeout, 1 fail |
  | `staleJobs = true; return;` → `pollJobs(); return;` (uncoalesced: stack a read) | `expect(received).toBe(expected) / Expected: 1 / Received: 2` — the coalescing half is non-vacuous |
  | restored | `relay.test.ts` 101 pass / 0 fail |

- **Doc drift corrected:** Implementation's failure-mode row "(9d) many exits at
  once" now says the extra calls set `staleJobs` and one re-read serves them,
  which is what the code does; the old "the extra calls return" was the same
  false claim the reviewer caught.

**Not changed:** the Review's "what does NOT hold" items (the `(empty)` title,
the current pod binary's path, a SIGKILLed relay) stand as stated — they are
outside this finding.

**Gate:** `bunx tsc --noEmit` clean · `bun run lint` clean (963 files) ·
`bun test`: **7627 pass, 3 skip, 0 fail** (7630 tests / 545 files, 312 s) — the
three skips are the documented opt-ins (AGENTS §6). The `session-log-store`
flake named in the earlier Execution did not recur.

### Round 2

*— claude-opus-5-5, 2026-11-13*

**Verdict: PASS.** Finding 1 (MEDIUM, a read in flight across the exit) is fixed at `packages/cli/src/relay.ts:575-617`. A job exit during an open read sets `staleJobs`. When that read finishes, the relay re-reads once, and only while the poll still owns the count (`!shellCounted`), so the one-writer rule (H1) holds. The new test holds a read open across the exit.
- **Mutations (reverted, `git status` clean):** removing `staleJobs = true` makes the new test fail (`reads` stops). Re-reading twice, without the guard, also makes it fail (`reads === readsAtExit + 1`), so stacked reads are caught.
- **Regressions:** `relay.test.ts` passes (101 tests, 0 fail). `bun run lint` is clean (963 files) and `bun run typecheck` is clean.
- **Residual, not a finding:** the stale read still writes its `1` for a moment, until the re-read lands. The `!shellCounted` guard on the re-read has no test of its own, but it cannot do harm: `pollJobs` checks `shellCounted` again before it writes.
