# fix/byte-stream-frame-cap — Cap the byte-stream line buffers (pod → laptop)

> **Status:** review
> **Branch:** `fix/byte-stream-frame-cap`
> **Size:** S–M · **Blast:** cross-module · **Suited:** Opus exec, fresh-context review
> **Changelog:** `changelog.d/byte-stream-frame-cap.security.md`

Type: fix · Size: S–M · Blast: cross-module (transport, k8s, docker, client) · Suited: Opus exec, fresh-context review

## Context

*— claude-opus-5-5, 2026-11-20*

Slice BF1 of `docs/eval/binary-frames.md` (§"5. Byte streams", row BF1 in
§Slices), approved by the owner 2026-11-20.

A byte stream has no message boundaries, so RPC frames ride it
newline-delimited. The three readers append every inbound chunk to a string and
only split on `\n`; nothing bounds the partial line:

- `packages/transport/src/stream-channel.ts:44` — `buffer += …` (stdio / unix
  socket: `serve --stdio`, the resident pod daemon's socket).
- `packages/k8s/src/exec-frame.ts:55` — `this.stdoutBuffer += payload` (k8s
  `exec` stdout, laptop side).
- `packages/docker/src/exec-channel.ts:199` — `line += …` (docker/podman exec
  stdout, laptop side).

And the laptop's `RpcPeer` (`packages/client/src/remote-client.ts:3138`) is
built with no `maxFrameBytes`, while the daemon's are (`ws-server.ts:347`,
`device-accept.ts:187`).

A pod is not trusted (AGENTS §7): any process in it that writes to the daemon's
stdout (or a compromised daemon) can stream bytes with no `\n` and grow the
laptop's memory without limit until it dies. Each append is also an O(n) string
concat and each split an O(n) `slice`, so a long line costs quadratic time.

**Repro** (`.tentacle/tmp/byte-stream-frame-cap/repro.ts`, run on `main`
@ `5014e6b7`, 2026-11-20): push 64 MiB of stdout with no newline into
`ExecDemux` in 1 MiB chunks, and print what it buffered.

```ts
import { ExecDemux } from "../../../packages/k8s/src/exec-frame.ts";
const chunk = new Uint8Array(1024 * 1024 + 1).fill(0x61);
chunk[0] = 1; // CHANNEL_STDOUT
let frames = 0;
const d = new ExecDemux({ onFrame: () => frames++ });
for (let i = 0; i < 64; i++) d.push(chunk);
const buffered = (d as unknown as { stdoutBuffer: string }).stdoutBuffer.length;
console.log(JSON.stringify({ pushedMiB: 64, frames, bufferedChars: buffered, closed: false }));
```

```
{"pushedMiB":64,"frames":0,"bufferedChars":67108864,"closed":false}
```

Everything is held (64 MiB and counting), no error, the channel stays open.

## Implementation

*— claude-opus-5-5, 2026-11-20* — approved by owner 2026-11-20 (fix requested).

### Load-bearing assumption

**`0x0A` never occurs inside a multi-byte UTF-8 sequence** (continuation and
lead bytes are all ≥ `0x80`), so splitting the RAW bytes on `0x0A` and decoding
each whole line on its own gives exactly the text that decode-then-split gives
today — including a character whose bytes straddle two chunks. That is what
lets the framer count bytes as they arrive and cap BEFORE anything is
concatenated or decoded. (UTF-8 definition; pinned by a split-char test.)

### Preconditions

- Every `RpcPeer` frame is single-line JSON (`JSON.stringify` escapes `\n` and
  every control char, NUL included) — `stream-channel.ts:7-11`. So a NUL as the
  first byte of a line is never a valid frame today, and the eval reserves it
  as the future length-frame tag (BF3).
- Blank lines are keepalives and are skipped (`stream-channel.ts:50`,
  `exec-frame.ts:59`, `exec-channel.ts:205`; docker/k8s send `BLANK_LINE` /
  `BLANK_STDIN`).
- A channel close rejects every pending request (`RpcPeer` `onClose`), so
  closing on a violation cannot leave a request hanging.
- The laptop's diagnostics path for an exec channel is `onStderr` → the run's
  daemon log (`cli/src/engine-runtime.ts:837,845`, `pod-stderr-log.ts`), never
  the terminal (AGENTS §7 "never write raw"). The docker channel already
  reports its stream failures there (`exec-channel.ts:243`).
- `RpcPeer.maxFrameBytes` counts UTF-16 units of the decoded line
  (`transport/src/peer.ts:281`); a UTF-8 line of N bytes decodes to ≤ N units,
  so a framer capped at N bytes never hands the peer a frame over an N-unit cap.

### Design

**The cap value (a decision, made from the evidence).** The brief asked for
"the same value as the daemon side (`DEFAULT_MAX_FRAME_BYTES`, 8 MiB)". That
value cannot be used laptop-side: the laptop receives whole-conversation
replies (`session/log`, `session/open` snapshots) that are unbounded — the code
says so at `transport/src/noise-channel.ts:40` ("The client has no frame limit
today and snapshots are unbounded") — so 8 MiB would break the resume of a long
session. The eval (the design source) sets it at **256 MiB laptop-side, "the
Noise initiator's cap"**. So the ONE shared constant is
`MAX_STREAM_LINE_BYTES = INITIATOR_MAX_MESSAGE_BYTES` (256 MiB), exported from
`@tentacle/transport`, used as the default by all three readers AND as the
laptop `RpcPeer.maxFrameBytes`. The bound is what matters for the threat (a
hostile pod's memory growth is capped, not unbounded); the daemon-side value
stays 8 MiB as today. The eval's 32 MiB for `streamChannel` daemon-side is
deferred (`Notes`): the laptop is trusted, and `open{messages}` recovery sends
the whole history laptop → pod over that stream.

**`ByteFramer`** (`packages/transport/src/byte-framer.ts`, pure, no I/O):

```ts
export const MAX_STREAM_LINE_BYTES = INITIATOR_MAX_MESSAGE_BYTES;
export type FramerViolation =
  | { kind: "line-too-long"; limit: number }
  | { kind: "reserved-tag" };
export class ByteFramer {
  constructor(handlers: { onLine(line: string): void; onViolation(v: FramerViolation): void },
              maxLineBytes = MAX_STREAM_LINE_BYTES);
  push(chunk: Uint8Array): void; // no-op once dead
  get dead(): boolean;
}
export function describeViolation(v: FramerViolation, source: string): string;
```

- Holds the partial line as a list of byte chunks + a running byte count.
  For each piece of `chunk` up to the next `0x0A` it checks
  `held + piece.length > max` **before** storing (no newline) or concatenating
  (newline) — a violation never allocates the oversized line.
- A complete line of `≤ max` bytes (the `\n` excluded) is joined once and
  decoded once (`TextDecoder`, non-fatal: invalid UTF-8 → U+FFFD as today);
  an empty line is skipped. Each byte is copied at most twice (held tail +
  the join), so cost is linear — no quadratic `slice`.
- A held tail is COPIED (`slice`), since a producer may reuse its buffer.
- A line whose first byte is `0x00` → `reserved-tag` violation (BF1 reserves
  the tag; BF3 turns it into the length frame).
- On a violation the framer drops what it holds, reports once, and is DEAD:
  every later `push` is ignored, so bytes after the violation (even a valid
  frame) are never parsed as a fragment or a fresh frame.

**Readers** (each keeps its own I/O, swaps its string buffer for a framer, and
gets an optional `maxLineBytes` seam for tests; default the shared constant):

- `streamChannel(input, output, options?)` — `options.maxLineBytes`,
  `options.onError(error)`. A string chunk is UTF-8-encoded first. Violation →
  `onError(new Error(describeViolation(v, "stream")))`, then the channel closes
  (`fireClose`).
- k8s `ExecDemux` — `new ExecDemux(handlers, maxLineBytes?)`, a new handler
  `onViolation(message)`. stdout goes through the framer; stderr/status keep
  their decoder. k8s `execChannel` (`options.maxLineBytes`): violation →
  `onStderr("[k8s] <message>\n")`, `ws.close()`, `fireClose()`.
- docker `execChannel` (`ExecChannelOptions.maxLineBytes`): violation →
  `stderr("[docker] <message>\n")`, `fireClose()` (which ends + closes the
  hijacked stream, as on any stream failure).

The message names what happened and the bound, e.g.
`pod stdout line exceeds 268435456 bytes with no newline (frame cap); channel closed`
/ `pod stdout sent a reserved frame tag (0x00); channel closed`.

**Laptop peer:** `remote-client.ts` `makePeer` passes
`maxFrameBytes: MAX_STREAM_LINE_BYTES` (one option line). And `RpcPeer`'s
oversize branch also calls `reportError` (today it replies with a null-id error
and returns — nothing local learns of it); one line, both sides.

No protocol/wire change: valid frames are unchanged; the NUL tag was never
valid JSON. No `protocol.d/` note.

### Files

1. `packages/transport/src/byte-framer.ts` (new) + `index.ts` export.
2. `packages/transport/src/stream-channel.ts` — use the framer.
3. `packages/transport/src/peer.ts` — `reportError` on an oversized frame.
4. `packages/k8s/src/exec-frame.ts`, `packages/k8s/src/exec-channel.ts`.
5. `packages/docker/src/exec-channel.ts`, `packages/docker/src/types.ts`.
6. `packages/client/src/remote-client.ts` — one option.
7. `changelog.d/byte-stream-frame-cap.security.md`.

### Failure modes

| Case | Converges to |
|---|---|
| line exactly `max` bytes | delivered |
| `max + 1` bytes, no newline yet | violation as the byte arrives; closed |
| one huge chunk with no `\n` | violation on that push; nothing concatenated |
| many small chunks, no `\n` | violation on the chunk that crosses `max` |
| multi-byte UTF-8 char split across chunks (at the cap boundary too) | decoded intact; the byte count (not char count) decides |
| valid frame after an oversized one | never delivered: framer dead, channel closed |
| line starting with `0x00` | `reserved-tag` violation; closed |
| stderr / status channel | unchanged, not counted against stdout |
| several lines in one chunk, then violation | earlier lines delivered, then close |
| channel closed with pending requests | `RpcPeer` rejects them (no hang) |
| a frame over the peer's cap on a WS leg | reply + `onError` (now reported) |

### Tests

- `packages/transport/test/byte-framer.test.ts` — every row of the table at a
  small cap (16 bytes), plus a seeded fuzz: random line lengths around the cap
  and random chunking must give the same lines as a reference split, and
  violate exactly when a line exceeds the cap.
- `stream-channel.test.ts` — over-cap line closes the channel with `onError`;
  a following valid frame is not delivered.
- `k8s/test/exec-frame.test.ts` + `exec-channel.test.ts` (`FakeWS`) — the cap
  closes the channel and writes the `[k8s]` message to `onStderr`; stderr is
  not counted.
- `docker/test/exec-channel.test.ts` (`scriptedDialer`) — same, `[docker]`.
- `transport/test/peer.test.ts` — the oversize branch calls `onError`.
- `client` — a `RemoteClient` peer with the cap: covered by asserting the
  option is set through a fake channel (an oversized inbound frame gets the
  `frame too large` reply).
- Red first on `main`; a mutation per guard (remove the pre-append check,
  remove the dead flag, remove the NUL check).

### Notes / debt

- The eval's daemon-side 32 MiB for `streamChannel` is not applied (see
  Design); revisit with BF3.
- A violation reaches the user as the channel loss (the TUI's existing
  disconnect path) with the reason in the run's daemon log. A dedicated TUI
  line is not added here.

## Execution

*— claude-opus-5-5, 2026-11-20*

**Repro on `main`** (before any edit): as in Context —
`{"pushedMiB":64,"frames":0,"bufferedChars":67108864,"closed":false}`.

**As built, in plan order:**

1. `packages/transport/src/byte-framer.ts` (new): `ByteFramer`,
   `MAX_STREAM_LINE_BYTES`, `FramerViolation`, `describeViolation`; exported
   from `transport/src/index.ts`.
2. `transport/src/stream-channel.ts`: the string buffer is replaced by the
   framer; new `StreamChannelOptions {maxLineBytes, onError}` (3rd arg,
   optional — no caller changes).
3. `transport/src/peer.ts`: the oversized-frame branch also `reportError`s.
4. `k8s/src/exec-frame.ts`: `ExecDemux(handlers, maxLineBytes?)` + handler
   `onViolation`; stdout goes through the framer (stderr/status untouched).
   `k8s/src/exec-channel.ts`: `ExecChannelOptions.maxLineBytes`; on a
   violation `onStderr("[k8s] …")`, `ws.close()`, `fireClose()`.
5. `docker/src/exec-channel.ts` + `types.ts` (`maxLineBytes`): same, with
   `[docker] …`.
6. `client/src/remote-client.ts`: `maxFrameBytes: MAX_STREAM_LINE_BYTES` in
   `makePeer` (+ the import name) — 3 lines, nothing else.
7. `changelog.d/byte-stream-frame-cap.security.md`.

**Drift from Implementation (and why):**

- `MAX_STREAM_LINE_BYTES` is a literal `256 * 1024 * 1024`, pinned equal to
  `INITIATOR_MAX_MESSAGE_BYTES` by a test, not imported from
  `noise-channel.ts`: importing it would load the Noise stack into every k8s /
  docker / stdio reader.
- `streamChannel` and both exec channels no longer deliver a line after the
  channel closed (the `!closed` guard). Before, `streamChannel` kept emitting
  after a local `close()`; a closed `RpcPeer` ignores them anyway.
- The client test asserts the cap through `RemoteClient`'s own `onError` and
  the `frame too large` reply (a real `RemoteClient` over `createChannelPair`,
  one 256 MiB + 1 string — ~60 ms).
- The k8s channel test overrides `FakeWS.close` to NOT emit `close`
  synchronously (a real socket emits it later). With the stock fake, removing
  the channel's own `fireClose()` was not caught (mutation below).

**Red (tests on `main`'s sources, new tests kept):**

```
(fail) execChannel (docker) stdout cap > a line over the cap closes the channel and the stream, naming the cause on onStderr
(fail) streamChannel > a line over the cap closes the channel with an error; a later valid frame is not delivered
(fail) streamChannel > a string chunk is counted in UTF-8 bytes, not characters
(fail) RpcPeer > rejects an inbound frame larger than maxFrameBytes before parsing
(fail) execChannel stdout cap > a line over the cap closes the socket and the channel, naming the cause on onStderr
(fail) ExecDemux > an stdout line over the cap is a violation; the demux then ignores stdout
(fail) RemoteClient frame cap > a frame over MAX_STREAM_LINE_BYTES is refused before parsing and reported
   -   "frame too large"
   +   "parse error"          ← main parses the 256 MiB frame
 71 pass / 7 fail
```

(`byte-framer.test.ts` cannot be red on `main` — the module is new; its
non-vacuity is the mutation table below.) **Green:** the same files, 78 pass /
0 fail, plus `byte-framer.test.ts` 15 pass (628 expects, a 300-round seeded
fuzz).

**Mutations** (each applied alone, then reverted; `cmp` confirmed restore):

| Mutation | Caught by |
|---|---|
| framer: cap checked only when a newline arrives | 5 fails (over-cap-as-it-arrives, huge chunk, small chunks, split-char-at-cap, stream string chunk) |
| framer: no dead flag after a violation | 5 fails (valid-frame-after-violation, NUL, fuzz, ExecDemux, one-byte-over) |
| framer: no NUL-tag check | 1 fail (reserved tag) |
| framer: held tail not copied (`subarray`) | 1 fail (producer reuses its buffer) |
| framer: `>=` instead of `>` (off by one) | 8 fails (exact-cap tests in every reader + fuzz) |
| k8s channel: no `fireClose()` on violation | 1 fail (after the `FakeWS.close` fix; 0 before) |
| k8s channel: no `ws.close()` on violation | 1 fail |
| docker channel: no `fireClose()` on violation | 1 fail |
| `streamChannel`: no `fireClose()` on violation | 2 fails |
| `remote-client.ts`: no `maxFrameBytes` | 1 fail (red above) |

**Gate** (`bun run check`, 2026-11-20): typecheck clean (root, `apps/mobile`,
`apps/relay`); `biome check .` — 2134 files, no fixes, 0 errors/warnings
(baseline clean); `bun test` — **15778 pass, 5 skip, 0 fail** across 1120
files. The skips are the opt-in `skipIf` live tests (k8s / docker / slow), none
in a file this task touched.

No `protocol.d/` note: no wire change (valid frames are byte-identical; a NUL
first byte was never valid JSON).

## Review
