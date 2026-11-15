# fix/mobile-photo-row — the photo message renders after the reply, and as a placeholder

> **Type:** fix · **Size:** S–M · **Blast:** contained (apps/mobile transcript projection + thumbnail view; no protocol change expected) · **Suited:** DeepSeek executes, Opus review
> **Changelog:** `changelog.d/mobile-photo-row.fixed.md`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-15*

Owner, real iPhone 12 Pro (iOS 18.3.1), build b97ff97b, 11:03 — screenshot `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/owner-shots/photo-row-1103.png`. A photo sent from the app reached `serve` and the model (the serve log has a `media_message` entry with `IMG_4854.jpg`, 1.29 MB, and Qwen3.8 described the picture correctly), but the app shows it wrong:

- **B9 (HIGH, ordering):** the user's row with the photo ("Cosa vedi?") is rendered BELOW the assistant's reply to it. The `media_message` row is placed after the reply instead of in log order (seq). Suspects: `apps/mobile/src/transcript-rows.ts` (projection), how `media_message` entries are merged with `message` entries, a separate list appended at the end.
- **B10 (thumbnail):** the photo shows a grey placeholder "[image: IMG_4854.jpg]" instead of the picture. Show the real thumbnail: for the phone's own just-sent photo use the local copy at once (outbox/cache); for history and other devices fetch it from the daemon by attachment id through the existing attachment read path (size-capped, cached, `apps/mobile/src/thumbnails.ts`), with loading and error states; tap opens full screen. If the daemon has no read path for attachments, STOP and record it as a plan correction (owner decision needed).

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-11-15* — the executor first reproduces each bug with a red-first test (B9 on the pure transcript projection with a recorded log: `media_message` then the reply must render in log order; B10 on the thumbnail state machine), cites the cause with file:line in Execution, fixes it, mutation-checks the B9 test, and keeps `bun test apps/mobile`, `bunx tsc -p apps/mobile`, `bun run lint` green. Screens via `bun run e2e:mobile --ios 26 --only 18-photos` if the flow covers it.

## Execution

*— claude-opus-5-5, 2026-11-15* — **STOPPED before any code change: both of the
Implementation's premises are false as written, and the load-bearing check the
Context names (B10's "if the daemon has no read path for attachments, STOP and
record it as a plan correction") fires.** No source file was modified; the tree
is `main` + this doc. Evidence below; scratch scripts are in
`.tentacle/tmp/mobile-photo-row/` (gitignored; pasted where it matters).

### The load-bearing check: B10 has no transport, and cannot have one in this task

The Context pre-authorises a STOP for exactly this: *"If the daemon has no read
path for attachments, STOP and record it as a plan correction (owner decision
needed)."* The protocol has **one** attachment method:

- `packages/protocol/src/methods.ts:150` — `AttachmentPut: "attachment/put"`, and
  `:248-250` its params/result. Grepping the whole enum for `attachment` returns
  that single entry: there is no `attachment/get`, `attachment/read`,
  `attachment/status`.
- `packages/daemon/src/attachment-store.ts` is write-side only (`put`, probe,
  budget): nothing reads stored bytes back out for a client.
- `apps/mobile/src/thumbnails.ts:20-30` already states this in the code, as a
  deliberate seam: *"The transport does not exist yet … `attachment/put` is
  client → daemon only … So the port stays unimplemented until a task adds one —
  an additive new method, no `PROTOCOL_VERSION` bump."* `docs/feat/attachments-upload.md:175`
  agrees: *"No `attachment/get` / `status` method."*
- `apps/mobile/src/session-screen-controller.ts:266` is the consequence in the
  running app: `deps.thumbnails ?? { fetch: async () => null }`, and `App.tsx:879-895`
  passes **no** `thumbnails` dep at all. So every thumbnail request resolves
  `null` → `failed` → the grey `[image: name]` placeholder. That *is* B10's
  observable, and it is by construction, not a defect in the state machine.

So B10's "from the daemon by attachment id through the existing attachment read
path" describes a path that does not exist. Building it is a **new protocol
method + daemon handler + client method + schema regeneration** — an additive
feature (AGENTS §7), well beyond this doc's *contained / S–M* rating, and one the
Context explicitly routed to the owner instead. **Owner decision needed:** split
B10's history/other-device half into its own `feat` (new `attachment/get`, size-
capped, chunked like `put`), or drop it. The phone's *own* just-sent photo (the
local outbox copy) is deliverable now and is NOT blocked — see *What is
deliverable* below.

### B9 does not reproduce on the projection the Implementation names

The Implementation says: *"red-first test (B9 on the pure transcript projection
with a recorded log: `media_message` then the reply must render in log order)"*.
I ran exactly that, against the owner's real log
(`~/.config/tentacle/daemon/proj-2a4dc70b7988/ba4826fb-….jsonl`, the session the
screenshot came from — `media_message` "Cosa vedi?" at seq 135, its reply at 136),
through the client's own reader and the app's own projection
(`.tentacle/tmp/mobile-photo-row/repro-b9-pure.ts`):

```
entries: 92 | types: base,title,message,media_message,turn_start,turn_end,checkpoint
(b) projected messages: 56
=== (a) historyRows ===
photo row at index 41; neighbours:
  [39] tool :: 
  [40] assistant :: Ok, l'hai bloccato — non lo riavvio.
  [41] user images=1 :: Cosa vedi?
  [42] assistant :: Vedo un **contatore di gas** montato su 
ORDER: photo=41 next=assistant => IN ORDER (photo before reply)
```

The same holds through `applyLogRead` (`read.state.messages`) and through the
fold's `history` input. **The projection is already correct**: `historyRows`
walks `ChatMessage[]` in order (`apps/mobile/src/transcript-history.ts:45-70`),
and a `media_message` lands in the same `messages` array as any other message
(`packages/client/src/session-log-reader.ts:175`,
`packages/protocol/src/session-log.ts:381-384`). There is no sort, no
append-at-the-end, no kind-based reordering anywhere in the path — I grepped for
one. **A red-first test on this projection cannot be written**: it is green on
the current code, so per AGENTS §9 it would prove nothing. B9's diagnosis in the
doc ("the `media_message` row is placed after the reply instead of in log order")
is wrong about the layer.

### What B9 actually is: two real defects, both found by experiment

I reproduced the owner's *shape* — a photo row rendered BELOW its own reply —
twice, from two independent causes. Both are live in the app.

**B9-a (primary, and it is a §7 "one session path" violation).**
`App.tsx:253-266` builds the outbox driver's session port as a **second
`RemoteSession` of the same id**:

```ts
const session = client.newSession(undefined, sessionId, undefined, { attach: {} });
await session.open();
```

`RemoteClient.register` (`packages/client/src/remote-client.ts:2801`) does
`if (listener) existing.listener = listener;` — one listener per session id, and
the newest wins. So as soon as the outbox port opens (which every photo send
does, since a photo prompt goes through `deps.driver.run` —
`apps/mobile/src/compose-controller.ts:654`), the **screen's own handle stops
receiving that session's stream**. The screen's transcript then freezes and any
later `history_reset`/turn it never saw leaves it showing stale rows.

Proved minimally (`.tentacle/tmp/mobile-photo-row/probe-listener.ts`, real
in-process daemon, real `RemoteClient`):

```
activities after the foreign turn (screen's own handle): history,turn
second handle opened (as `outboxOf`'s driver does)
activities after the second foreign turn: (NONE — the screen's listener is gone)
VERDICT: the second handle STOLE the stream listener
```

And end-to-end through the app's own screen controller with App.tsx's exact
wiring (`.tentacle/tmp/mobile-photo-row/repro-b9-second-handle.ts` and
`repro-b9-resync.ts`): after `screen.press()` the daemon's history is correct
(`user att=1 :: Cosa vedi?` then `assistant`), while **the phone renders no photo
row at all** — `rows: user(0),assistant` — because the photo turn streamed to the
outbox's handle, not the screen's. The owner's screenshot shows the row *below*
the reply; a frozen/stale transcript reconciled with a later snapshot is exactly
how that shape arises. This is also the same class of bug the code already warns
about in `apps/mobile/src/compose-handle.ts:10-13` ("a second handle of the same
id would replace the client's stream listener and steal the screen's turn") —
the outbox port is that second handle.

**B9-b (the duplicate prompt, and the literal "below the reply").** The fold
appends a replayed prompt instead of replacing the screen. With a resync
mid-turn, `RemoteSession` emits `history_reset` (the snapshot, which already
holds the prompt AND the round-1 reply — `remote-session.ts:1560`) and then
re-delivers the turn's start, whose handler pushes `user_message` again
(`remote-session.ts:1766`). The app's fold does exactly what it is told:
`withHistory` replaces the rows, then the `user_message` is **pushed at the end**
(`apps/mobile/src/transcript.ts:187-190` → `:249-251`). Pure, daemon-free
(`.tentacle/tmp/mobile-photo-row/probe-fold-resync.ts`):

```
--- before the resync ---
  [0] user images=1 :: Cosa vedi?
  [1] assistant :: Vedo un contatore di gas
--- after `history_reset` + the replayed `turn_start` prompt ---
  [0] user images=1 :: Cosa vedi?
  [1] assistant :: Vedo un contatore di gas
  [2] user images=1 :: Cosa vedi?
  VERDICT: a photo row sits BELOW a reply (B9's shape)
  photo rows: 2 (one prompt, so >1 is a duplicate)
```

That is B9's literal description — a `media_message` row after the reply — and it
is a **fold** defect, not a projection one: the fold has no way to know the
replayed prompt is the same prompt it already shows. It would hit a text prompt
identically; the photo only makes it obvious.

I did not get a *daemon-backed* mid-turn-resync repro to settle (two attempts; the
second stalled on the gated round and was killed — AGENTS §0 two-strike). The
pure probe proves the fold's half exactly, and the mechanism on the client side
is cited at `remote-session.ts:1766`. Unverified: that the owner's specific
screenshot came from B9-b rather than B9-a — both produce the shape, and B9-a is
the one the app hits on every photo send, so it is the first thing to fix either
way.

### What is deliverable, and what needs an owner decision

Deliverable inside this doc's rating (**contained**, no protocol change):
1. **B9-a**: build the outbox port over the screen's own handle (or stop
   `newSession` from stealing an existing listener), so a photo send cannot
   starve the screen's stream. Owning tests + mutation.
2. **B9-b**: make the fold non-duplicating for a replayed prompt (replace the
   last matching user row instead of appending). Owning test above is already red
   on the current code — it is a *valid* red-first test, unlike the projection one.
3. **B10's local half**: the phone's own just-sent photo from the outbox copy,
   which needs no daemon read path. This is a real slice of the owner's ask.

**Not deliverable here (plan correction, owner decision):** B10's
history/other-device thumbnails. There is no attachment read path, so it needs
the new `attachment/get` method — a separate `feat`, and the Context itself
routes that to the owner.

Because the Implementation's premise (B9 = a projection ordering bug) is
contradicted by the code and by the recorded log, and because B10's stated
mechanism does not exist, I stopped per the Executor brief ("If it does not
reproduce, STOP and report — the task may be stale or wrong") and AGENTS §0
("escalate, don't spin"). **Implementation needs rewriting against B9-a/B9-b and
a decision on B10's split before any code is written.**

### Gate (tree unchanged: `bunx tsc --noEmit`, `bun run lint`, `bun test`)
```
bunx tsc --noEmit   → exit 0
bun run lint        → Checked 1497 files. No fixes applied. exit 0
bun test            → 10807 pass, 5 skip, 0 fail (10812 tests, 780 files)
```

The 5 skips are the documented opt-ins (live-k8s, live-docker, real-socket
keepalive) — not failures, per AGENTS §6.

### Repro (paste-ready)

`probe-listener.ts` — the listener theft, the load-bearing mechanism of B9-a:

```ts
const screenSession = phone.newSession(undefined, sid, undefined, { attach: {} });
await screenSession.open();
const seen: string[] = [];
screenSession.watch((activity) => { seen.push(activity.kind); });
// … a foreign turn reaches `seen` (history,turn) …
const portSession = phone.newSession(undefined, sid, undefined, { attach: {} });
await portSession.open();            // App.tsx:261, the outbox port
// … the next foreign turn reaches NOTHING: the listener is gone …
```

Output is quoted verbatim above. `probe-fold-resync.ts` (whole file, 69 lines,
in `.tentacle/tmp/mobile-photo-row/`) is the B9-b red case; its two `apply()`
calls are `{type:"history_reset", messages:[photoMessage, reply]}` followed by
`{type:"user_message", text:"Cosa vedi?", attachments: …}`.

## Review
