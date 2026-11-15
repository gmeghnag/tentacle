# fix/session-hop-live — Live-test defects of session-hop (the conversation is lost on every hop)

> **Status:** implementation APPROVED by the owner (2026-11-14)
> **Branch:** `fix/session-hop-live`
> **Size:** M · **Blast:** load-bearing (the one session path + the client's close semantics, AGENTS §7) · **Suited:** strong model executes; mandatory fresh-context Review that red-teams "one session path" and the foreign-close rule (`connect` sessions use it)
> **Changelog:** `changelog.d/session-hop-live.fixed.md` — "`/move` keeps the conversation: the model sees the history after a hop, on the same session file"

## Context

*— claude-opus-5-5, 2026-11-14*

The owner ran a LIVE test of session-hop (merged on `main`, `docs/feat/session-hop.md`)
on 2026-11-14: `~/bin/tentacle` 0.6.0 built from `main`, a kind cluster (context
`kind-hop-test`, pod `hop-pod`) and a podman container `hop-ctr` (podman machine,
arm64). Evidence: TUI captures `.tentacle/tmp/hop-live/cap-1-k8s-attach.txt`,
`cap-2-podman.txt`; laptop logs `~/.config/tentacle/sessions/proj-2a4dc70b7988/*.jsonl`.

**D1 (HIGH — the feature's core promise is broken).** After EVERY hop
(`move_session`-approved attach `kubernetes:hop-pod`, `/move local`,
`/move attach podman:hop-ctr`) the conversation is gone. The model sees only
`[session moved to … — background jobs, MCP tools and approvals were reset]` plus
the next message; ctx drops 12k → 3k. Each hop produced a NEW `<uid>.jsonl`:
`396779b4 → b254e638 → 78e205b5 → 711b661b (has ANANAS-42) → 4d7a71d3`.
`b254e638`'s first message entry after the system prompt is the move line itself
(seq 3: `"[session moved to kubernetes:hop-pod …]\n\nvai"`), and the model answers
"tutto ciò che è stato detto prima del passaggio al pod non è nel mio contesto".
Right before every `moved to …` the TUI printed:

```
⏺ this session was closed on another device — what you type next starts a new session
⏺ moved to kubernetes:hop-pod
⏺ Moved to kubernetes:hop-pod — send a message to continue.
```

**D2 (MEDIUM).** Every hop outcome is printed TWICE: the success above
(`moved to …` + `Moved to … — send a message…`) and every `not moved: …`. The
second copy of a failure is wrapped in `_…_`, so container text breaks the
markdown (`_not moved: Docker API GET /ping…` — the `_` of `/_ping` was eaten as
italics).

**D3 (MEDIUM).** `/move container ubuntu:24.04` on the podman arm64 engine
(`podman info` Arch arm64, image arm64) resolved the x64 pod binary
(`tentacle-bun-linux-x64`). The k8s attach picked arm64 correctly.

**D4 (LOW).** After a hop into a workload whose folder is not shared (attach), the
footer and the shell ask still show the laptop cwd (`~/…/hop-live/proj`); the
daemon runs at `/` in the pod/container (cap-1: `pwd` → `/`).

**D5 (LOW, observation).** The Linux pod binaries in `~/.config/tentacle/bin` were
stale (0.3.0) after rebuilding the laptop binary; the hop failed cleanly with
"run tentacle update". To decide: refresh on a dev build, or a better message.

**Verified OK in the live test (not bugs — record only):** the hop proposal UI and
its confirmation; a failed hop leaves the session in place; `/move cancel` and the
engine-timeout path; the label/badge updates (`kubernetes:hop-pod`,
`podman:hop-ctr`, local); commands run inside the pod/container (cap-2:
`hostname` → `7369d48991ea`, Ubuntu 24.04).

**Repro (D1), 2026-11-14** — in-memory daemons, the rig of
`packages/cli/test/session-hop.test.ts`, with the REAL `createHopRuntime` and a
watcher on the old controller that does exactly what the TUI does on a `closed`
activity (`useSessionLink.ts:294-299`: notice, then `swapSession(makeSession())`,
`makeSession` = `facade.createSession`). Then the controller `hop-feed.ts:134`
hands the TUI (`facade.createSession()`). Script
`.tentacle/tmp/fix-session-hop-live/d1-repro.ts` (run from the main checkout's
`packages/`, equal to this branch's base `da254d3c`):

```ts
// D1 repro: a hop whose OLD controller is watched the way the TUI watches it
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createHopRuntime } from "../../../packages/cli/src/hop-runtime.ts";
import { createLocalRuntime } from "../../../packages/cli/src/local-runtime.ts";
import { SessionSaver } from "../../../packages/cli/src/session-saver.ts";

const WATCH = process.argv[2] !== "nowatch";
const dir = await mkdtemp(join(import.meta.dir, "run-"));
const env = { id: "noop", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} };
class Reply implements ModelProvider {
  readonly id = "reply"; seen: string[][] = [];
  constructor(private r: string) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req.messages.map((m) => `${m.role}:${String(m.content)}`));
    yield { type: "text", delta: this.r }; yield { type: "done" };
  }
}
function daemon(model: ModelProvider) {
  const b = new PermissionBroker(async () => ({ allowed: true, scope: "once" }) as never);
  const host = new SessionHost({ defaultCwd: dir, createAgent: () => ({ agent: new Agent({ model, tools: new ToolRegistry(), env: env as never, systemPrompt: "sys", requestPermission: (r, o) => b.request(r, o) }), permissions: b }) });
  const [d, c] = createChannelPair(); const conn = new Connection(d, host);
  return { channel: c, disposeTransport: () => conn.close() };
}
const drain = async (g: AsyncIterable<unknown>) => { for await (const _ of g) { } };
const store = new LogSessionStore(join(dir, "sessions"));
const saver = new SessionSaver(store, (t) => console.log("saver:", t));
const permissions = new PermissionBroker();
const mk = (d: ReturnType<typeof daemon>, resume: never | null, sessionId?: string) =>
  createLocalRuntime({ channel: d.channel, disposeTransport: d.disposeTransport, permissions, saver, cwd: dir, model: "m", resume, ...(sessionId ? { sessionId } : {}) });

const a = await mk(daemon(new Reply("reply-A")), null);
const targetModel = new Reply("reply-B");
const notices: string[] = [];
const facade = createHopRuntime({
  initial: a, startup: { place: { kind: "local" }, daemonInPod: false }, shared: { permissions, saver },
  load: (id: string) => store.load(id), notify: (t: string) => notices.push(`facade.notify: ${t}`),
  build: async (_spec: unknown, _shared: unknown, id: string) => {
    const loaded = await store.load(id);
    return { kind: "built", built: { runtime: await mk(daemon(targetModel), (loaded.status === "ok" ? loaded.record : null) as never, id), place: { kind: "workload", engine: "docker", name: "box" }, daemonInPod: true, preexisting: false, rollback: async () => {} } };
  },
} as never);

let tuiCtl = facade.createSession();
const uid = tuiCtl.sessionId;
await drain(tuiCtl.send("KEYWORD=ANANAS-42"));
await tuiCtl.flushed(); await saver.drain(); await store.drain();
if (WATCH) {
  tuiCtl.watch((act) => {            // the TUI's onActivity for `closed` (useSessionLink.ts:294-299)
    if (act.kind === "closed") {
      notices.push(`TUI: closed on another device (${act.reason}) → swap to makeSession()`);
      tuiCtl = facade.createSession();
      notices.push(`TUI: makeSession() → ${tuiCtl.sessionId === uid ? "the SEEDED uid" : "a NEW uid"}`);
    }
  });
}
const outcome = await facade.hop({ target: "container", keep: true } as never, uid ?? null);
const moved = facade.createSession(); // hop-feed.ts:134 — the controller the TUI swaps to on `done`
notices.push(`hop-feed: moved = createSession() → ${moved.sessionId === uid ? "the SEEDED uid" : "a NEW uid"}`);
await drain(moved.send("what is the keyword?"));
await moved.flushed(); await saver.drain(); await store.drain();
console.log(`watch=${WATCH} outcome=${outcome.kind}`);
for (const n of notices) console.log(" ", n);
console.log("  target model saw:", JSON.stringify(targetModel.seen.at(-1)));
const { readdir } = await import("node:fs/promises");
const files = (await readdir(join(dir, "sessions"), { recursive: true })).map(String).filter((f) => f.endsWith(".jsonl"));
console.log("  files:", files.map((f) => (f.includes(uid ?? "?") ? `${f.split("/").at(-1)?.slice(0, 8)} (orig)` : `${f.split("/").at(-1)?.slice(0, 8)} (NEW)`)).join(", "));
process.exit(0);
```

Output (`bun d1-repro.ts` and the control `bun d1-repro.ts nowatch`):

```
watch=true outcome=moved
  TUI: closed on another device (closed) → swap to makeSession()
  TUI: makeSession() → the SEEDED uid
  facade.notify: moved to docker:box
  hop-feed: moved = createSession() → a NEW uid
  target model saw: ["system:sys","user:what is the keyword?"]
  files: 656f734e (NEW), 41251b25 (orig)
watch=false outcome=moved
  facade.notify: moved to docker:box
  hop-feed: moved = createSession() → the SEEDED uid
  target model saw: ["system:sys","user:KEYWORD=ANANAS-42","assistant:reply-A","user:what is the keyword?"]
  files: 02c4cf52 (orig)
```

The watched run reproduces the live symptom exactly: the same notice order
(closed → moved), a new uid, a model that sees only the new message. The
unwatched control (what every existing test does) passes. The only difference is
the TUI's `closed` handler.

**Repro (D3, partial), 2026-11-14** — the arch probe through the REAL podman host
against the existing `hop-ctr` (`.tentacle/tmp/fix-session-hop-live/d3-probe.ts`:
`buildEngineHost("podman", {})`, then `host.runExec` of the probe script and
`probePod(host, "hop-ctr")`):

```
raw: {"exitCode":0,"stdout":"tentacle-probe\naarch64\nglibc /lib/ld-linux-aarch64.so.1\n","stderr":""}
classified: {"arch":"arm64","status":"ok"}
probePod: {"arch":"arm64","status":"ok"}
```

So the probe, its parser and the podman exec are right on a RUNNING container.
The x64 choice happens on the fresh-container path of `/move container`. The
likely cause is the silent fallback `probePod` → `{arch: "x64", status:
"probe-failed"}` (`pod-binary.ts:151`) when the exec fails. That is not proven yet:
the first step of slice 2 is to prove it.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**A close that THIS client asked for (the hop's `old.dispose()`) reaches the old
controller as a FOREIGN close. The TUI's foreign-close handler then takes the
target runtime's one-shot seeded controller, so the controller the hop hands
over is a fresh, empty session.** Proved by the repro above. Cited chain:

1. Commit: `session-hop.ts:237-262`. `old.sealSessions()`, then
   `deps.onCommit` (facade swap: `current = built.runtime`,
   `hop-runtime.ts:201-214`), then `closesWithin(old, …)` → `old.dispose()`
   (`session-hop.ts:292-305`).
2. `dispose` = `client.closeSessions()` (`local-runtime.ts:1115-1121`). That is
   `session/close{ifLast}` per entry (`remote-client.ts:1623-1648`). The daemon
   ends the session and emits `session_closed` to every attached client, the
   closer included (`hosted-session.ts:3003-3038`).
3. `RemoteSession.onClosed` raises `{kind: "closed"}` unless `this.closed`
   (`remote-session.ts:1632-1639`). `this.closed` is set only by the
   controller's own `close()` (the `/clear` path, test T-B11b), never by
   `RemoteClient.closeSessions`. `seal()` (`local-runtime.ts:761`) is the
   saver's flag, not the session's.
4. The TUI is still watching the OLD controller, because it swaps only when
   `done` resolves, after the whole hop (`App.tsx:1391-1404`). This is a drift
   from design D1 step 5 ("let the TUI swap … and only then run
   `old.dispose()`"). Its handler: `closedNotice` + `swapRef(makeSession())`
   (`useSessionLink.ts:294-299`).
5. `makeSession` → `facade.createSession` → `current.createSession()`
   (`hop-runtime.ts:151`), and by now that is the TARGET runtime.
   `createSession` hands out `attached` (the seeded controller) exactly ONCE
   (`local-runtime.ts:1072-1083`; set by `openSeeded`, `:1156-1167`).
6. `hop-feed.ts:134` `const moved = deps.facade.createSession()` gets the NEXT
   one: a new `crypto.randomUUID()` with no seed. `App.tsx:1404` swaps to it, and
   the first prompt opens a fresh daemon session. That gives the new
   `<uid>.jsonl`, and the model sees only the move line.

**Why the tests and H7 did not catch it.** No test composes the three parts:
(a) a watcher on the old controller, (b) the real facade, (c) the real feed's
hand-over.
- `cli/test/session-hop.test.ts` drives `hopSession` directly and then calls
  `outcome.built.runtime.createSession()` with nobody watching (`:225`). That is
  the repro's `nowatch` control.
- `cli/test/hop-feed*.test.ts` use the real feed over a FAKE facade.
- `tui/test/session-hop.test.tsx` uses a FAKE `HopFeed` whose old controller
  never emits `session_closed`.
- The H7 live docker test (`session-hop.docker.test.ts:268-353`) also calls
  `hopSession` + `built.runtime.createSession()` directly. It asserts the
  ORIGINAL uid's laptop file (`:343-350`), which is indeed complete, because
  the seeded open wrote it. It never asserts what the target MODEL received
  through the TUI-driven path, or that no second file appears after the next
  prompt.
- Every test proved "the record is complete", a weaker correlate (§2), and
  none proved the killing property: "the model, after a hop driven like the TUI
  drives it, receives the pre-hop history on the same uid".

### Preconditions

- **One session path (§7).** The fix changes no transport and adds no loop. It
  changes who treats a close as foreign, and how the hop hands over a
  controller. `createLocalRuntime` stays the only builder.
- **Foreign close stays foreign.** `connect`/shared sessions rely on
  `closed` being raised for ANOTHER client's close (`foreign-turns.test.ts:540`,
  `reattach.test.ts:1880`, `tui/test/foreign-turns.test.tsx:375`). Those tests
  must stay green unchanged.
- **The client knows its own closes.** `closeSessions` skips entries already
  `closing` and goes through `endSession` (`remote-client.ts:1630-1635`). So an
  "own close in flight" fact already exists per entry. It is not yet visible to
  `RemoteSession`.
- **Single broker (§7).** Untouched: the target runtime is still built with
  `deps.shared.permissions` (`hop-runtime.ts:198`).
- **Protocol: none.** No method, field or update kind changes. No
  `protocol.d/` note.

### Design

**Slice 1 — D1 alone (two independent fixes; each is enough to keep the history,
and both ship, because each closes a different hole).**

- **F1 — a close this client asked for is never "closed on another device".**
  In `RemoteSession.onClosed`, do not raise `closed` when the client's entry for
  this id was being closed BY THIS CLIENT (`closeSessions`, `closeSession`,
  `endSession` set `entry.closing`). Expose it read-only (e.g.
  `RemoteClient.closingByMe(id)`, or pass the flag on the update dispatch). The
  turns still fail, `remoteClosed` is still set, and a later send is still
  refused clearly. Only the activity, which means "news from another device",
  is dropped. This is the same rule T-B11b already applies to the controller's
  own `close()`, now also for the runtime-level close used by `dispose`/`quit`.
- **F2 — the hand-over controller is explicit, never a one-shot
  `createSession`.** `LocalRuntime.openSeeded` returns the seeded controller.
  `HopBuilt` (`session-hop.ts`) carries it as `controller` after step 4(b).
  `createHopFeed` returns `outcome.built.controller` instead of
  `facade.createSession()` (`hop-feed.ts:134`). A `createSession` call that
  races in (any caller) gets a fresh session and can no longer steal the seed.
  The `attached` one-shot stays for `attachTo` (`run`'s hand-over), which has no
  facade in front of it. The executor checks whether `openSeeded` can drop
  `attached` entirely once F2 lands. That is a follow-up, not this slice.
- **Not changed (owner Q3):** the TUI swap stays after the hop returns.
  With F1 the old watcher hears nothing, and with F2 nothing can be stolen.
  The drift from D1 step 5 is recorded in `docs/feat/session-hop.md`'s notes.

**Slice 2 — D2 + D3.**

- **D2: one owner of the outcome line, and the line is safe as markdown.**
  `createHopRuntime.hop` stops `deps.notify?.(outcome.notice)`
  (`hop-runtime.ts:221`). The TUI already says both outcomes (`App.tsx:1404-1411`,
  `hopMovedNotice`). The success notice keeps the `— the old session did not
  close` / leave suffixes. They are part of `outcome.notice`, so the feed passes
  them into the view: `{moved, view, note?}`, and `hopMovedNotice` appends `note`.
  The failure line: a pure `noticeText(raw)` in `tui/src/hop-status.ts` escapes
  markdown metacharacters (`\ _ * \` [ ]`) before the `_…_` wrap, so
  container-supplied text renders literally. It is used at `App.tsx:1411` and
  `:1421`.
- **D3: prove first, then fix.**
  - Step 1 (repro, before any edit): in
    `.tentacle/tmp/fix-session-hop-live/`, create an `ubuntu:24.04` container
    through `startEngineRuntime`'s provisioning seam (or the docker client
    directly: create + `waitForReady` + `probePod`), print `probePod`'s result
    and the raw exec result, then remove it.
  - Hypothesis H-D3: the exec fails on the fresh container (not yet running, or
    an exec error), and `pod-binary.ts:151` falls back to x64 SILENTLY. Its
    cheap test is that repro.
  - Fix, whatever step 1 shows: the fallback stops guessing x64. On
    `probe-failed`/`unknown`, ask the ENGINE for its arch: docker/podman
    `GET /info` → `Architecture` (`aarch64`/`arm64` → arm64), k8s → the node's
    `status.nodeInfo.architecture`, through an optional
    `EngineHost.engineArch?()`. Only with neither answer, x64 + the existing
    `--version` check.
  - If step 1 instead shows a wrong probe answer, STOP and fix the plan (§8).

**Slice 3 — D4 + D5.**

- **D4:** `HopTargetView` (`hop-runtime.ts:28-33`) gains `cwd?: string`. That is
  the daemon session's own cwd, read from the target's `session/list` entry for
  our uid after step 4(b) (`SessionListEntrySchema.cwd`,
  `protocol/session.ts:1213`; the attach path already reads the list for
  `ownUse`). The App shows `targetFeed.cwd ?? props.cwd` in the footer and in the
  shell ask. A mounted container (same-path mount, `workspace-mount.ts:699`)
  reports the laptop path, so nothing changes there. `localCwd` (the laptop's,
  for `/attach` paths) is never touched. The executor first confirms which prop
  the shell ask renders (`rg cwd packages/tui/src/permission*`).
- **D5:** the message only (Q4). When `appVersion` carries a local build id
  (`+<id>`), `PodBinaryError` adds the local recipe. `tentacle update` cannot
  fetch an unreleased build. The recipe: "`TARGET=bun-linux-<arch> bun run
  compile`, then put it at `<configDir>/bin/tentacle-bun-linux-<arch>` (or set
  `TENTACLE_POD_BIN`)", the same text as the dev-build error at
  `pod-binary-build.ts:367-369`.
  > **STOPPED at execution (§8), 2026-11-14:** production passes
  > `APP_RELEASE_VERSION` (no `+<id>`) as `appVersion` (`main.ts:772`,
  > `engine-runtime.ts:882`), so this condition never fires. Proposed: key on
  > `APP_VERSION !== APP_RELEASE_VERSION` inside `podBinaryProblem`. Awaiting
  > approval; see Execution. *— claude-opus-5-5*

### Files

Dependency order. Slice 1:
1. `packages/client/src/remote-client.ts`: expose the own-close fact
   (`closingByMe(id)`).
2. `packages/client/src/remote-session.ts`: `onClosed` checks it
   (`:1632-1639`).
3. `packages/cli/src/local-runtime.ts`: `openSeeded` returns the controller
   (+ the `LocalRuntime` type).
4. `packages/cli/src/session-hop.ts`: `HopBuilt`/outcome carries `controller`.
5. `packages/cli/src/hop-feed.ts`: hand over `outcome.built.controller`
   (`:134`).
6. Tests (below). `docs/feat/session-hop.md`: one note under the feat's
   Review on the step-5 drift.

Slice 2: `cli/src/hop-runtime.ts` (drop the outcome notify, pass the note),
`cli/src/hop-feed.ts` (`note`), `tui/src/hop-status.ts` (`noticeText`, `note`),
`tui/src/App.tsx` (two call sites). D3: `cli/src/pod-binary.ts` (fallback),
`docker/src/client.ts` + `k8s` host (`engineArch`), `cli/src/engine-runtime.ts`
(pass it to `probePod`).

Slice 3: `cli/src/hop-runtime.ts`, `cli/src/session-hop.ts` (read the cwd),
`tui/src/app-types.ts` + the footer/ask view-model (pure), `App.tsx` wiring.
`cli/src/pod-binary-build.ts` (message).

### Failure modes

| Case | Convergence |
|---|---|
| Another device closes the session while OUR `closeSessions` is in flight | We were ending it anyway: no notice (F1), the runtime is disposed. Nothing is lost. The close is confirmed by `closedSeen`, as today (`remote-client.ts:1634`). |
| A genuine foreign close while idle (not closing) | Unchanged: `closed` is raised and the TUI swaps to a fresh session. Pinned by the existing T-B11 rows. |
| `quit` (also `closeSessions`) | Ink is unmounted, so nobody watches. F1 removes a notice nobody saw. `sessionsKept` is computed as before. |
| The old dispose hangs or throws (step 5) | Unchanged: one suffix on the moved notice (now carried as `note`, D2). The hand-over controller is already in the outcome (F2), so a slow dispose cannot reorder it. |
| A `createSession` racing in during the hop (TUI `/clear`, a foreign-close path, a future caller) | It gets a fresh uid on the current runtime. The seeded controller is unreachable except through the outcome (F2). |
| A hop fails after the build (rollback) | The seeded controller (if built) is disposed with its runtime, as today. The feed never sees it. |
| D3: the engine `/info` itself fails | x64 fallback + the existing `--version` check (a clean "not moved"). Never worse than today. |
| D4: the list read fails after a successful open | `cwd` absent → the laptop cwd as today. A cosmetic miss, never a failed hop. |
| D2: a notice with no markdown | `noticeText` is the identity for it. Pinned by a test. |

### Tests

Red first on `da254d3c` for every row, then green. Each mutation is listed so
non-vacuity is checked (§9).

Slice 1:
- **T1 — THE end-to-end assertion (cli, in-memory daemons):**
  `packages/cli/test/session-hop-e2e.test.ts`.
  - Setup: the real `createHopRuntime` + the real `createHopFeed` over two
    `SessionHost`s (the `session-hop.test.ts` rig). The old controller is
    watched by a handler that does what `useSessionLink` does on `closed`
    (notice + `facade.createSession()`), or, if `ink-testing-library` resolves
    from `packages/cli`, the real `App` from `@tentacle/tui` is mounted and
    `/move container` is typed.
  - Steps: send "KEYWORD=ANANAS-42", run `feed.start(CONTAINER)`, send through
    the controller `done` hands over.
  - Asserts:
    1. The target model's LAST request equals
       `[sys, user:KEYWORD=ANANAS-42, assistant:reply-A, user:<next>]`.
    2. The handed-over `sessionId` equals the original uid.
    3. The sessions dir holds exactly `[<uid>.jsonl]` after the next prompt.
    4. No `closed` activity and no "closed on another device" notice.
  - Red today: the repro output. Mutation: revert F1 alone → assert 4 fails.
    Revert F2 alone → the watcher (forced to call `createSession` by a direct
    `closed` raise) steals the seed, and asserts 1-3 fail.
- **T2 (client):** in `foreign-turns.test.ts`, beside T-B11b:
  `client.closeSessions()` on a watched session raises NO `closed`, while
  `remoteClosed` still refuses a later send. A second client's close still
  raises `closed` (existing rows untouched). Mutation: drop the
  `closingByMe` check → red.
- **T3 (cli):** in `session-hop.test.ts`: after `openSeeded`, call
  `runtime.createSession()` first; the outcome's `controller` still has the
  seeded uid and history. Mutation: hand over via `createSession` again → red.
- **Opt-in live row:** extend `session-hop.docker.test.ts`
  (`TENTACLE_DOCKER_TESTS=1`) to drive the hop through the facade + feed with
  the watcher of T1. Assert the target model's request carries the pre-hop
  messages (a recording model provider proxy) and that there is one file. Plus
  `/move local` back, with the same asserts. An optional k8s twin under
  `TENTACLE_K8S_SERVER` (Q5).

Slice 2:
- **D2:** `cli/test/hop-feed.test.ts`: the facade's `notify` is called 0 times
  for the outcome on moved AND on failed (the leave notice stays).
  `tui/test/session-hop.test.tsx`: one failed hop with text
  `Docker API GET /_ping failed` → the frame contains that text literally,
  exactly once. One moved hop → exactly one moved line, with the
  `did not close` note when given. Pure `hop-status.test.ts`: `noticeText`
  escapes, and is the identity on plain text. Mutation: restore the facade
  notify → the count assert fails.
- **D3:** `pod-binary.test.ts`: `probePod` with a fake host whose exec throws
  and whose `engineArch()` returns `arm64` → arm64. With neither → x64 (pinned
  fallback). Plus a row derived from slice-2 step 1's real failure shape.
  Mutation: ignore `engineArch` → red.

Slice 3:
- **D4:** a pure view-model test (footer cwd = target cwd when present, else the
  prop). A cli test: after an attach-hop to a daemon whose session cwd is `/`,
  `facade.target().cwd === "/"`.
- **D5:** `pod-binary-build.test.ts`: a `+<id>` version's error names
  `bun run compile` and `TENTACLE_POD_BIN`. A release version's error is
  unchanged.

Gate before done: `bun test`, `bun run typecheck`, `bun run lint` (baseline:
clean, §6).

### Owner questions

1. **Ship F1 AND F2, or only one?** Recommendation: both. F1 removes the false
   "closed on another device" for every runtime-level close. F2 makes the
   hand-over impossible to steal for any future caller. Each is a few lines.
2. **F1 scope: client-wide (`RemoteSession.onClosed` ignores closes this
   client issued) or hop-only (the hop unwatches the old controllers before
   dispose)?** Recommendation: client-wide. It is the same rule T-B11b already
   states for a controller's own close, and `quit`/`release` benefit too.
3. **Realign the TUI swap with design D1 step 5 (swap before dispose via
   `onSwap`)?** Recommendation: no, not in this fix. With F1+F2 the order is
   harmless. Record the drift in the feat doc. Moving it touches the App's hop
   latch for no user-visible gain.
4. **D5: refresh the pod binaries on a dev build, or only improve the
   message?** Recommendation: message only (a local `+<id>` build names the
   compile recipe). An automatic cross-build on hop is slow (90 MB, ×2 arches)
   and hides staleness. The current refusal is already clean.
5. **Opt-in live rows: docker only, or also a k8s twin under
   `TENTACLE_K8S_SERVER`?** Recommendation: docker now (H7's existing row,
   extended). A k8s twin only if D3's engine-arch fallback touches the k8s
   host.
6. **D4 scope: hop targets only, or also a plain `tentacle attach` TUI (same
   footer)?** Recommendation: hop only in this fix (the facade has the view).
   Check `attach` in Review and file it separately if it shows the same.

#### Owner decisions (2026-11-14)

All six questions: the recommendation (owner: "Va bene le raccomandazioni").
Executor: Opus (load-bearing); fresh-context Review. *— claude-opus-5-5
(orchestrator), 2026-11-14*

## Execution

*— claude-opus-5-5, 2026-11-14*

**Load-bearing check, re-run first (worktree code, `d1-wt.ts` = the Context's
script with absolute worktree imports):** reproduced exactly — `watch=true` →
`closed on another device` → `makeSession() → the SEEDED uid`, hand-over `a NEW
uid`, target model saw `["system:sys","user:what is the keyword?"]`, two files;
`nowatch` control green. After slice 1 the same script prints no `closed` line
and no `facade.notify` (its last step still calls `facade.createSession()` as the
OLD feed did, so it still shows a new uid; the real feed path is T1).

### Slice 1 — D1 (F1 + F2): DONE

- **F1.** `packages/client/src/remote-client.ts`: `ownCloses` (id → in-flight
  count), incremented in `endSession` right before the RPC, decremented when the
  tracked end settles; `closingByMe(id)`. `packages/client/src/remote-session.ts`
  `onClosed`: `closedByMe = client.closingByMe(id)`; `closed` raised only when
  `!this.closed && !this.closedByMe`; a later send after an own close is refused
  as `this session was closed` (not "on another device").
  - *Drift (plan said "`entry.closing`"):* the client DELETES the entry on
    `session_closed` before the listener's `output` runs
    (`remote-client.ts`, the `session_closed` branch), so a lookup of
    `entry.closing` from `RemoteSession` would always miss. Hence the separate
    in-flight map, bounded by closes in flight (`session_closed` precedes the
    close's answer, so the id is still in it).
- **F2.** `local-runtime.ts`: `openSeeded(record?, {claim?})` resolves the
  controller; `claim: true` does NOT keep it as the one-shot `attached`.
  `session-hop.ts` step 4(b) calls `openSeeded(seed ?? undefined, {claim: true})`
  and the moved outcome carries `controller`. `hop-feed.ts` hands over
  `outcome.controller`.
  - *Drift:* `claim` is required, not just returning the controller — without
    it the seeded controller stays the target's one-shot, so the first
    `createSession` after the hop (a `/clear`) would get the SAME session. The
    `attached` one-shot stays for `attachTo`/`attach-run` (unchanged).
  - *Drift (tests):* 8 existing `session-hop.test.ts` rows and the opt-in docker
    row took the hand-over from `outcome.built.runtime.createSession()` /
    `target.createSession()` — the very pattern F2 removes. They now take
    `outcome.controller` (helper `handedOver`); the D2-facade row now asserts a
    later `createSession` is a FRESH uid. Fakes typed against `HopOutcome` /
    `openSeeded` got `controller` / a `Promise<unknown>` return.
- `docs/feat/session-hop.md`: post-merge note on the step-5 drift.

### Slice 2 — D2: DONE · D3: PARTIAL

- **D2.** `session-hop.ts` builds the suffixes as `notes[]` → `notice` (all) +
  `note` (suffixes only, absent when clean). `hop-runtime.ts`: the outcome is no
  longer notified, and the facade's `notify` dep is REMOVED (it had no other
  use; `main.ts` stops passing it) — so "the facade notifies the outcome" is now
  impossible by type, and the plan's mutation "restore the facade notify" is
  replaced by the feed row below. `hop-feed.ts` passes `note` in `done`;
  `HopRun.done` (`tui/app-types.ts`) gains `note?`. `tui/hop-status.ts`:
  `noticeText` (escapes `\ _ * \` [ ]`), `hopMovedNotice(place, wasOn, note?)`
  (place and note escaped). `App.tsx`: the moved line carries `outcome.note`;
  both failure lines go through `noticeText` (plan's `:1421` is `:1417`).
- **D3, step 1 BLOCKED (no engine):** `d3-fresh.ts` (create `ubuntu:24.04` →
  `waitForReady` → raw probe exec → `probePod` → remove) could not run: podman
  has no socket (`no Podman socket found … start it with podman machine start`)
  and docker's `GET /_ping` timed out after 60 s. I did not start the user's
  podman VM. **H-D3 is therefore unproven.** The fix the plan prescribes
  "whatever step 1 shows" is in: `EngineHost.engineArch?()`
  (`engine-host.ts`), docker/podman `GET /info` → `Architecture`
  (`engine-docker.ts`), pure `engineArchOf` + `probePod` asking the engine on
  `probe-failed`/`unknown` (`pod-binary.ts`). `engine-runtime.ts` needed no
  change (it already passes the whole host to `probePod`).
  - *Not done:* the k8s host's `engineArch` (node `nodeInfo.architecture`) —
    the k8s attach chose arm64 correctly live, and Q5 limits k8s work; k8s keeps
    today's x64 fallback. *To verify:* `podman machine start`, then
    `bun .tentacle/tmp/fix-session-hop-live/d3-fresh.ts podman` (script below);
    if it prints a POSITIVE but wrong arch, the fix does not cover D3 (§8 STOP).

### Slice 3 — D4: DONE · D5: STOPPED (plan contradicts the code)

- **D4.** `LocalRuntime.sessionCwd(id)` (the `session/list` entry's `cwd`, null
  on a miss). `session-hop.ts` reads it after the save check (step 4(b)) and
  passes `onCommit(built, {cwd?})`; `hop-runtime.ts` announces it in the view
  (`HopTargetView.cwd?`, cli and tui). Pure `hopShownCwd(view, laptopCwd)`
  (`tui/hop-status.ts`); `App.tsx` feeds it as the frame's `cwd` — which
  `AppView` uses for BOTH the status bar and `PermissionPrompt`'s cwd row
  (confirmed: `AppView.tsx` `cwd={cwd}` at both). The commands' `cwd` (relative
  `/attach` paths) is untouched.
- **D5 — STOP (§8).** The plan keys the local recipe on "`appVersion` carries
  `+<id>`", but production never passes that: `main.ts:772` and
  `engine-runtime.ts:882/921` pass `APP_RELEASE_VERSION` (the plain version),
  precisely so a dev build matches plain-marker pod binaries
  (`pod-binary-build.test.ts`, "a COMPILED DEV BUILD finds its own pod
  binaries"). A `podBinaryProblem` test on `"0.6.0+abc"` would pass and fix
  nothing. *Proposed plan fix (needs approval):* decide "local build" from
  `APP_VERSION !== APP_RELEASE_VERSION` (`version.ts`, `devBuildVersion`) inside
  `podBinaryProblem`, not from its `appVersion` argument. Nothing of D5 is
  implemented.

### Tests and red/green evidence (§9)

New: `cli/test/session-hop-e2e.test.ts` (T1, T1b, D4-cli),
`tui/test/hop-status.test.ts` (noticeText, hopMovedNotice, hopShownCwd);
rows in `client/test/foreign-turns.test.ts` (T2), `cli/test/session-hop.test.ts`
(T3), `cli/test/hop-feed.test.ts` (D2 feed), `tui/test/session-hop.test.tsx`
(D2 ×2), `cli/test/pod-binary.test.ts` (D3 ×5 + `engineArchOf`),
`cli/test/engine-docker.test.ts` (D3 host).

| Target | Mutation / red | Result |
|---|---|---|
| T2 | on the unfixed client (written first) | red: `closed` raised on b |
| T1 + T1b | F1 AND F2 reverted (= base) | red: hand-over uid ≠ original (T1); racer took the seed (T1b) |
| T1 assert 4 | F1 reverted only | red: `["this session was closed on another device"]`; T2 red too |
| T1b | F2 reverted (feed `createSession` + `claim:false`) | red; T1 green (F1 alone keeps it) |
| T1b | `claim:false` only | red: racer's uid = original |
| T3 | `claim:false` | red: early `createSession` got the seeded uid |
| D2 pure | `noticeText` stub = identity | red, and the render shows the live bug: `_not moved: Docker API GET /ping failed: boom [x]` |
| D2 TUI | no `noticeText` at failure; no `note` at moved | both red (0 literal matches; note missing) |
| D2 feed | feed drops `note` | red |
| D3 probe | `engineArchOf` stub null, `probePod` ignores engine | 4 red |
| D3 host | host `engineArch` → null | red |
| D4 pure | `hopShownCwd` returns laptop | red |
| D4 cli | `onCommit` gets no `cwd` | red |

Opt-in live row: `session-hop.docker.test.ts` updated to the F2 hand-over
(`out.controller`, + uid assert) but NOT extended with the facade+feed+watcher
drive, and not run (no engine).

`d3-fresh.ts` (the blocked D3 step 1, for whoever has an engine up):

```ts
import { buildEngineHost } from "<worktree>/packages/cli/src/engine-select.ts";
import { probePod } from "<worktree>/packages/cli/src/pod-binary.ts";
const engine = (process.argv[2] ?? "podman") as "podman";
const name = `hop-d3-${Math.random().toString(36).slice(2, 8)}`;
const { host } = buildEngineHost(engine, {});
const SCRIPT = 'echo tentacle-probe; uname -m; for f in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1; do [ -e "$f" ] && echo "glibc $f"; done; true';
try {
  await host.create(name, "ubuntu:24.04", {});
  await host.waitForReady(name);
  console.log("raw:", JSON.stringify(await host.runExec({ name, command: ["sh", "-c", SCRIPT] }).catch((e: unknown) => ({ error: String(e) }))));
  console.log("probePod:", JSON.stringify(await probePod(host, name)));
} finally {
  await host.remove(name).catch(() => {});
}
process.exit(0);
```

Output here: podman `no Podman socket found …`; docker `FAILED: Error: Docker API
GET /_ping timed out after 60000ms`.

Gate (2026-11-14): `bun run typecheck` clean · `bun run lint` clean (1343 files,
after `biome check --write` on 4 of my files + one `biome-ignore` for the SGR
regex, the repo's pattern) · `bun test` **9656 pass, 4 skip, 0 fail** (9660
tests, 702 files). No skip was added by this task (the new tests have none); the
4th opt-in is not identified here. No protocol schema changed → no
`protocol.json` regen, no `protocol.d/` note.

## Review

*— claude-opus-5-5, 2026-11-14* (fresh context; same model family as the planner,
and as the Execution's signature — see note 3)

**Verdict: APPROVE** (no HIGH/MEDIUM finding in `git diff main...HEAD`), with
open items that are scope, not defects (below).

**Gate (re-run here):** the 11 touched test files → 279 pass, 0 fail ·
`bun run typecheck` clean · `bun run lint` clean (1343 files). Full `bun test`
not re-run by this review.

**Premises (TRUE):** `endSession` sets `ownCloses` synchronously before the RPC,
and the existing code already relies on `session_closed` preceding the close's
response (`remote-client.ts:1533`); a claimed controller is still in
`controllers` (`local-runtime.ts:1081`), so `dispose`/`quit`/`release` cover it;
`facade.hop` has exactly one caller (`hop-feed.ts:126`), so dropping the facade
`notify` silences no path; `probePod` is on both injection paths
(`engine-runtime.ts:586,985`); the current session can't be deleted from
`/sessions` (`sessions-panel.ts:256`), so F1 hides no needed `closed` there.

**Mutations (each red, then reverted; `git status` clean, byte-identical):**
F1 guard dropped → T1, T2 red · `claim:false` → T1b, T3, the D2-facade row red
(T1 green: F1 alone suffices there) · feed back to `facade.createSession()` →
T1, T1b, feed-D2 red · `probePod` ignores the engine → 3 D3 rows red · App
failure line without `noticeText` → the TUI D2 row red.

**Attacks tried:**
1. Own close vs. response ordering (F1 relies on it): holds; same contract the
   pre-existing `forget()` uses.
2. F1 suppressing a `closed` the TUI needs (connect delete/`/close` of the
   current session; hop step 4(a) `closeOwn`): none found; `closeOwn` is now
   correctly an own close too.
3. Pod-supplied `cwd` (D4) injecting terminal escapes into the footer / ask row
   (renderers don't `oneLine` it): blocked at the wire —
   `SessionListEntrySchema.cwd` is `line(4096)` (`NO_CONTROL`).
4. D3 override on an emulated image (arm64 engine, amd64 image) when the probe
   fails: the engine arch can now be wrong where x64 was right; still caught by
   the `--version` check, a clean "not moved". Accepted by the plan.
5. New `sessionCwd` read before the commit is unbounded on a stalled target:
   same class as the existing `ownUse` read at step 4(a); not new risk.

**Open items (not defects; for the orchestrator/owner):**
1. **D3 root cause still unproven** (no engine); the fix is the plan's
   "whatever step 1 shows" fallback. k8s `engineArch` not done. Run
   `d3-fresh.ts podman` before calling D3 closed.
2. **D5 not implemented** — a correct §8 STOP; needs the owner's OK on keying
   on `APP_VERSION !== APP_RELEASE_VERSION`.
3. **Signature mismatch:** Execution is signed `claude-opus-5-5`, but the commit
   is `exec (deepseek)`, and the owner routed this load-bearing task to Opus. The
   orchestrator should correct whichever is wrong (§10 routing record).
4. The opt-in docker row was only adapted to F2, not extended with the
   facade+feed+watcher drive the plan listed; it was not run.

**Executor behaviour:** honest. It stopped on D5 instead of shipping a vacuous
test, recorded each drift with a reason (the `ownCloses` map instead of
`entry.closing`, `claim`), and did not claim D3 was proven.
