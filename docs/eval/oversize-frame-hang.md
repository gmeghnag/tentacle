# eval/oversize-frame-hang — an oversize inbound frame leaves the sender's request pending forever

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `fix` · Size: S · Blast: cross-module (`transport/peer.ts` is the RPC seam every runtime rides; the fix is local to `receive()` but every connection inherits it) · Suited: strong model + standard Review (fresh-context recommended because `peer.ts` sits under the §7 "don't serialize the RPC peer" invariant).

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is the claimed hang real, how likely is it to
trigger, and should a frame rejected for size get a *correlated* error (or a
client-side timeout) so the sender's promise settles?

**Mechanism (verified in the source).**
- `packages/transport/src/peer.ts:154-160`: when `data.length > maxFrameBytes`,
  `receive()` sends `sendErrorResponse(null, InvalidRequest, "frame too large")`
  and returns. It never parses the frame, so it never learns the request id.
- `packages/transport/src/peer.ts:255-258`: on the sender, `handleResponse(null, …)`
  only calls `reportError("response with no id cannot be correlated")` and
  returns. The entry in `pending` is never rejected.
- A pending entry settles in exactly three ways: a correlated response, the
  `requestTimeoutMs` timer (`peer.ts:95-100`), or channel close (`handleClose`,
  `peer.ts:133-145`). The client peer (`packages/client/src/remote-client.ts:64`)
  sets no `requestTimeoutMs`, and the connection stays open after the rejection,
  so none of the three ever happens.
- Only one peer in the codebase sets a cap: the ws daemon's `Connection`
  (`packages/daemon/src/connection.ts:73`), fed `DEFAULT_MAX_FRAME_BYTES = 8 MiB`
  by `packages/daemon/src/ws-server.ts:40,185`. The in-process worker and pod
  `run`/`attach` stdio paths set no cap, so they are **not affected**. The hang
  only happens on **client → ws daemon** (`tentacle connect`).
- Upper bound: Bun's server WebSocket has a default `maxPayloadLength` of 16 MiB
  and `ws-server.ts` does not override it. A frame over 16 MiB makes Bun close
  the socket, `handleClose` rejects every pending request, and nothing hangs.
  **The hang window is therefore 8–16 MiB** (shown empirically below).

**Repro 1: two `RpcPeer`s over `createChannelPair`, receiver `maxFrameBytes: 1000`**
(scratch script, nothing in the repo changed):
```
small  : RESOLVED
oversize: STILL PENDING after 2000ms
sender onError: [ "response with no id cannot be correlated" ]
```

**Repro 2: end to end against the real daemon.** `startWsServer` (default caps)
plus `RemoteClient` over `connectWebSocket`, then `initialize`, then
`client.prompt("nope", "x".repeat(N MiB))`, each raced against a 4 s timer:
```
1 MiB prompt:  REJECTED: unknown session: nope   <- control: correlated error
9 MiB prompt:  STILL PENDING after 4000ms         <- the bug
15 MiB prompt: STILL PENDING after 4000ms         <- the bug
17 MiB prompt: REJECTED: connection closed        <- Bun maxPayloadLength closes the socket
```

**The claimed trigger is FALSE.** The report blamed `tentacle connect --resume`
of a long session, saying `session/new` carries the whole history. But `connect`
has no `--resume`: `packages/cli/src/main.ts:149-158` parses only url + token,
and `packages/cli/src/connect.ts:27` calls `client.newSession()` with **no seed
messages**. `openSession` therefore sends no `messages`
(`remote-client.ts:112-116`). `--resume` exists only on the local, `run` and
`attach` paths (`main.ts:51-57,266-278`), and none of them sets a frame cap.
Even if seeding were added later, real sessions are far below the cap: the
largest of the 39 files in `~/.config/tentacle/sessions/` is 588 KB (about 14x
under 8 MiB), because tool output over `DEFAULT_MAX_INLINE_OUTPUT_CHARS = 16000`
is spilled out of band (`packages/config/src/defaults.ts:23`,
`packages/agent/src/result-pipeline.ts:59`).

**The trigger that does exist:** over `connect`, a single client → daemon frame
of 8–16 MiB. In practice that is a prompt pasted into the TUI of about 8 MiB or
more. It can also come from any programmatic `RemoteClient` user that calls
`openSession(cwd, messages)` with a large history (the API allows it). The
result: the TUI turn never ends (`remote-session.ts:56` awaits
`client.prompt`). Esc/abort sends only a `session/cancel` notification for a
prompt the daemon never received, so the turn stays stuck until the user quits.

**Veracity verdict: PARTIALLY CONFIRMED.** The mechanism is real and reproduces
end to end against the real ws daemon. The claimed realistic trigger
(`connect --resume`) does not exist.

**Severity: Low.** It needs an 8–16 MiB single message on the `connect` path
only. That is rare, but when it happens the client hangs silently with no error
shown, which is the failure class AGENTS §8 calls a bug ("a silent drop is a
bug").

## Implementation

*(empty — an eval is not built until promoted to a `fix`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-5-5, 2026-10-17 (recommendation; owner decides)*

**Verdict: fix it, at low priority, with best-effort id recovery in the
receiver.** The change is cheap and contained, and it removes a silent hang. It
is not urgent, because the claimed high-likelihood trigger is false.

**Fix directions, weighed:**
1. **Best-effort id extraction from the oversize frame (recommended).** The
   cap exists to avoid a full `JSON.parse` of an attacker-sized string. The id,
   however, can be recovered cheaply with a bounded scan: look for a
   top-level `"id":"…"` / `"id":<number>` within the first or last few hundred
   chars, since `RpcPeer.sendFrame` serializes `{jsonrpc, id, method, params}`
   in that key order (`peer.ts:102-107`), so the id sits near the start. Then
   reply with that id. The cost stays O(prefix), so the DoS bound holds. If no
   id is found, fall back to `null`, which is today's behaviour. Correctness
   holds because ids are generated by our own peer and are short digit strings.
   A wrong id (from a crafted frame) can only reject a request the attacker
   already owns on its own connection. Weakness: this matches on the shape of
   the serialized text, so a foreign peer with a different key order gets the
   current behaviour. That is acceptable, since it is best-effort.
2. **Client-side request timeouts.** This is a poor fit here. `session/prompt`
   is legitimately unbounded (long agent turns), so a global
   `requestTimeoutMs` on the client would break real turns. Per-method timeouts
   for short methods (`initialize`, `session/new`, `snapshot`) would cover the
   `session/new` case, but not `session/prompt`, which is the one that actually
   triggers here.
3. **Sender-side pre-check.** The client does not know the server's cap
   (no negotiation; adding it means a protocol field in `initialize`, which
   is additive but more surface). It could reject locally above a known
   constant, but that couples client to server defaults.
4. **Close the connection on an oversize frame.** Every pending request settles
   at once (`handleClose`), but this kills the whole session over one bad
   message. That is too blunt.

**Recommended shape if promoted:** (1) in `peer.ts` `receive()`, plus
optionally (3) as a friendly early error in `RemoteClient.prompt` for pastes
over the cap. Also consider setting `maxPayloadLength` explicitly in
`ws-server.ts` at or above `maxFrameBytes`, so the two limits are deliberate
rather than an 8 MiB cap shadowed by an implicit 16 MiB Bun default.
**Tests (red first):** two `RpcPeer`s over `createChannelPair` with a small
`maxFrameBytes`; assert that the oversize `request()` **rejects** with
`InvalidRequest` / "frame too large" within a short timeout. Today this test
times out (shown above), so it starts red. Keep the existing
`peer.test.ts:165` test (receiver never parses, never dispatches) green, and add
a case for a frame with no recoverable id that still produces a `null`-id reply.
