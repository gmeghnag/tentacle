# feat/protocol-v10-forward-compat — protocol 10: forward-compatible wire + the reserved `model` hook field

> **Status:** execution
> **Branch:** `feat/protocol-v10-forward-compat`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (protocol) · **Suited:** strong model + mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-22*

`docs/eval/hook-model-access.md` (M3/M5/M6) will let a hook call a named
judge model through a per-hook `model` field, and the trust prompt must show
it. The `hooks/trust` hook item is `.strict()` (`protocol/src/hooks.ts`), so
adding the field later breaks old peers. The owner decided to reserve the wire
slot now, before v0.1.0, with the version bump. The rest of the eval stays
deferred.

**Repro (before the change):** `HooksTrustParamsSchema` rejects a hook item
with `model: "judge"` (unknown key); `PROTOCOL_VERSION` is 9. The new
`protocol/test/hooks.test.ts` was red on 3 of its 4 tests (valid model,
bounds, version), and the strictness test was green.

### Scope extension (owner-approved, 2026-10-22): forward compatibility

*— claude-opus-5-5, 2026-10-22*

**Goal.** After v0.1.0, new update kinds, fields and methods can be added
without breaking older peers, and nothing ever waits on a client that cannot
answer.

**State before (verified against the code):**
- Every application payload schema was `.strict()`. An unknown field was an
  `InvalidParams` / invalid-notification error on the receiving end.
- The peer validates every inbound request, notification and result, and
  hands handlers the *parsed* data (`transport/src/peer.ts` `handleRequest`,
  notification and result paths).
- The client already had event classes (`client/src/mapping.ts`
  `classifyUpdate`, decision E): an unknown *display* update was silently
  ignored, and an unknown *mandatory* one failed the turn loudly.
- `initialize` declared no update support.
- The daemon broadcast `permission_request` to every attached client and
  suspended the tool call until an answer (`daemon/src/hosted-session.ts`
  `awaitDecision`).

**Repro (before):** `OpenParamsSchema.safeParse({create: true, futureField: 1})`
→ failure. A new `forward-compat.test.ts` was red on "unknown field stripped".
The client test "an unknown display event…" saw no `unsupported` event.
A client declaring updates without `permission_request` was still sent one,
and the turn never ended (red after a 1 s wait).

## Implementation

*— claude-opus-5-5, 2026-10-22*

- **Load-bearing assumption:** a new key in a strict schema is breaking (AGENTS
  §7). An old laptop rejects a new daemon's item with `InvalidParams`, so the
  version is bumped and a mixed pair fails cleanly at `initialize`.
- **Design:**
  - `model: line(64).optional()` in the hook item. It uses the same
    bounded / no-control / no-bidi rules as the other strings, and the item
    stays strict.
  - `PROTOCOL_VERSION` 9 → 10, and `schema:export`.
  - `hooksTrustDetail` appends ` (model: <name>)`.
  - The config `HookSpecSchema` is **unchanged**: `model` is still rejected,
    so nothing sends the field yet.
- **Files:**
  - `protocol/src/hooks.ts`, `protocol/src/version.ts`, `protocol/schema/protocol.json`
  - `cli/src/hooks-trust.ts`
  - tests: `protocol/test/hooks.test.ts` (new), `protocol/test/updates.test.ts`
    (the pinned `toBe(9)` → `>= 9`), `cli/test/hooks-trust.test.ts`,
    `config/test/hooks-scan.test.ts`
- **Failure modes:** a mixed 9/10 pair fails with `VersionMismatch` at
  `initialize`. An absent `model` is unchanged.
- **Tests:**
  - accepts a valid model, and absent;
  - rejects oversize (65), empty, control, bidi and non-string values;
  - rejects an unknown extra key;
  - version is 10;
  - the prompt renders the model and only when present;
  - config still rejects `model`.

### Implementation — forward compatibility

*— claude-opus-5-5, 2026-10-22*

- **Load-bearing assumption.** The peer validates every inbound message
  against the shared schemas, and passes the parsed (stripped) data on:
  `peer.ts` hands `parsedParams.data` / `parsed.data` to handlers. So making
  payload schemas strip-mode is enough to drop unknown fields on both ends.
  The mutation "handler gets raw params" fails the pod-strip test.
- **Strip, case by case.** Every application payload in `@tentacle/protocol`
  is an inbound-parse boundary through the peer, both directions:
  `session.ts`, `updates.ts`, `permission.ts`, `model.ts`, `mcp.ts`,
  `skills.ts`, `hooks.ts`. They lose `.strict()`, and known fields keep their
  full validation.
  - **Exception:** the JSON-RPC envelope (`jsonrpc.ts`) stays strict. Its
    members are fixed by JSON-RPC 2.0, and strictness is what tells request,
    notification and response apart in its `z.union`s.
  - Outbound construction stays typed (TS types are unchanged).
- **Tolerant reader.**
  - `classifyUpdate` maps an unknown display update to `{kind:"unsupported", type}`.
  - The pure reducer (`session-reducer.ts`) emits it once per type per
    session; the type is tracked in `StreamState.unsupported`.
  - `RemoteSession` turns it into the event `{type:"unsupported", kind}`.
  - The TUI shows one dim notice: `unsupportedNotice` in `tui/src/state.ts`.
  - Refinement: an unknown **mandatory** update still fails the turn loudly
    (decision E). Skipping it would desync the turn/history state, and failing
    is not waiting. With the blocking gate, a v10+ daemon never sends a
    blocking kind a client did not declare.
  - `--plain` and one-shot run in-process (no wire), so no update can be
    unknown there and no stderr line is needed.
- **`initialize` list.** `ClientCapabilities.updates?: string[]` (bounded,
  `^[a-z][a-z0-9_]*$`, ≤256). `RemoteClient` sends `KNOWN_UPDATE_TYPES`;
  `Connection` stores it and copies it onto each `Attachment.updates`.
- **Blocking set.** `BLOCKING_UPDATE_TYPES` = {`permission_request`} and
  `clientSupportsUpdate` (no list → the v10 base set, i.e. every known type),
  in `protocol/src/updates.ts`, ONE place.
  - `HostedSession.blockingUnsupported`: if clients are attached and none
    declared `permission_request`, `awaitDecision` resolves at once with
    `{allowed:false, reason:"client does not support permission_request; update tentacle"}`.
    Nothing is persisted or emitted.
  - The gate maps a response with `reason` to `by:"unavailable"`, and the
    agent's tool result reads "Permission could not be requested: <reason>.
    \`tool\` was not run."
  - Notice channel: the existing `tool_call_update` (the tool result above).
    Every client understands it, it is in the transcript, the model sees the
    same text, and no new kind is needed.
- **Audit — what the daemon waits on.** Only `permission_request` among the
  updates. `model/stream`, `model/streamChunked` and `hooks/trust` are RPC
  requests, which old peers answer with `MethodNotFound`. `untilAborted` and
  the proxy-model progress wait are bounded by those RPCs. Nothing else
  suspends a turn on a client.
- **Failure modes.**
  - Mixed clients: one supporting client is enough, so it is prompted as
    before.
  - Nobody attached: unchanged, held for a client. Esc/cancel settles it.
  - A non-supporting client attaching later while an ask is pending: it gets
    the replayed request and must fail loudly or cancel.
- **AGENTS.md §7.** The "additive + caveat / once public" sub-bullets are
  replaced by the forward-compatibility rule (a substantive rules change, so
  it rides this branch).

## Execution

*— claude-opus-5-5, 2026-10-22*

1. Tests written first. Red on the original code: 3 protocol tests and the
   prompt-render test.
2. Implemented as designed. `docs/extensions.md` does not document the
   `hooks/trust` wire schema, so it is not touched.
3. Eval M6 row records "wire field + v10 done early (2026-10-22,
   `feat/protocol-v10-forward-compat`); rest pending".
4. Mutations (each red, then reverted):
   - `model: z.string()` unbounded fails the bounds test;
   - item not `.strict()` fails the strictness test;
   - model not rendered fails the prompt test.
5. Drift:
   - The eval draft said `line(32)`; the owner's scope says ≤64, so it is
     `line(64)`.
   - `updates.test.ts` pinned `toBe(9)` inside an unrelated hooks-turn test;
     it is now `>= 9`, and the exact `10` is pinned in `hooks.test.ts`.
6. The config hook spec is not changed: `model` in a hooks config is still
   rejected (pinned in `hooks-scan.test.ts`), so nothing sends the field yet.
7. Gate: `bun run check` green — typecheck clean, lint 0/0, 1838 pass / 2 skip (opt-in) / 0 fail.

**Forward compatibility (*— claude-opus-5-5, 2026-10-22*):**

1. Tests were written first and were red on their assertions:
   - `protocol/test/forward-compat.test.ts`: strip (request params, update
     frame, nested items, `hooks/trust`), bad known fields still rejected,
     `initialize` list round-trip and bounds, the blocking set,
     `clientSupportsUpdate`;
   - `client` mapping, reducer and remote tests (`unsupported` once per kind,
     the turn completes, a known update with an unknown field applies);
   - the `tui` `state.test.ts` notice;
   - the remote "blocking updates are gated" tests: deny + reason with no
     suspend within 1 s, normal and no-list clients prompted, `RemoteClient`
     declares `KNOWN_UPDATE_TYPES`;
   - a pod's unknown `hooks/trust` fields never reach the resolver.
2. Removed `.strict()` from the payload schemas listed above and kept the
   envelope strict. Re-ran `schema:export`.
3. Converted the tests that asserted "extra keys rejected" to "stripped"
   (`methods`, `session`, `permission`, `skills`, `hooks`). Their bad-known-field
   assertions are kept.
4. Implemented the tolerant reader, the `initialize` list, the gate and
   `PermissionResponse.reason`, and updated AGENTS §7.
5. Mutations (each red, then reverted):
   - `.strict()` on `OpenParams`;
   - `.strict()` on the update frame;
   - no once-per-kind;
   - daemon gate off;
   - no list → unsupported;
   - client declares `[]`;
   - TUI drops the notice;
   - gate drops `reason`;
   - handler gets raw params;
   - `.strict()` on `PromptParams` (fails the daemon-end acceptance).
6. Not added: the `notice` reservation (owner decision).
7. Drift: `cli/test/session-resume.test.ts` pinned "the store parser ==
   the wire `ChatMessageSchema`". Two cases with unknown keys now differ: the
   wire strips them, and the on-disk store still rejects them. Stricter is
   safe, because a loaded record still seeds `session/open`. They are split
   out into their own assertions, and the persisted format is unchanged.
8. Gate: `bun run check` green. Typecheck is clean, lint is 0/0, and the
   tests are 1849 pass, 2 skip (opt-in), 0 fail.

**Post-review fixes** (*— claude-opus-5-5, 2026-10-22*; each new test red,
then mutation-checked):

1. **Blocking delivery is per client.**
   - `daemon/mapping.ts` `frameFor`: a blocking update goes `mandatory` only
     to a client that declared it, and without `mandatory` (display, so
     `unsupported`) to the others. `seq` is unchanged, so the stream stays
     contiguous.
   - It is used in `emit` and in the attach replay.
   - Test "mixed attach": the declaring client is prompted, the other gets no
     `mandatory`, the turn survives, and its seqs stay contiguous.
   - Mutation: `frameFor` returns the frame unchanged → red.
2. **The gate is re-checked on attach and detach** (`recheckAsks`). A pending
   ask with ≥1 attached client and no declaring one settles with the
   deny-with-reason fallback. The stream shows `permission_resolved` as
   cancelled, and the gate gets the reason. With nobody attached it stays
   suspended (the owner's exception). Tests:
   - attach non-declaring while pending → denied;
   - attach declaring → prompted, still suspended;
   - the only declaring client detaches → denied.

   Mutations: no recheck on attach / on detach → red.
3. **AGENTS §7** now names the three classes: display (free), mandatory (bump
   unless there is a fallback for clients that did not declare it), blocking
   (declared + fallback, checked on raise/attach/detach).
4. **JSON-RPC envelope.**
   - (a) `parseJsonRpcMessage` (`protocol/jsonrpc.ts`) classifies a frame by
     its ONE classifying member: `method` (request if `id` is present, else a
     notification), `result`, or `error`. None or several → invalid, which is
     unambiguous per JSON-RPC 2.0. Other members are stripped, and the
     envelope schemas are no longer strict.
   - (b) In `peer.ts`, an unparseable response-shaped frame (no `method`)
     whose `id` is pending rejects that request with "invalid response for
     <method>".
   - Tests: extra members on a request, a notification and a response;
     ambiguous / classless frames rejected; an invalid response rejects at
     once.
   - Mutations: strict request envelope; ambiguity allowed; reject removed →
     red.
5. `UpdateClass` gains `"blocking"`. `permission_request` is classified there,
   and `BLOCKING_UPDATE_TYPES` is derived from `UPDATE_CLASS`. Mutation:
   reclassify it mandatory → red.
6. `blockingUnsupported` moved out from between `awaitDecision`'s doc comment
   and its body.
7. An unknown kind that arrives while idle is kept (`RemoteSession.idleNotices`)
   and shown at the start of the next turn, once. Test red; mutation: drop the
   push → red.
8. §7 states that on-disk records are versioned separately from the wire.
   Daemon records use `schemaVersion`; the laptop store parser is strict. A
   newer build's record is rejected loudly by an older one.
9. `TODO.md` index row added.

Gate after the post-review fixes: `bun run check` green. Typecheck is clean,
lint is 0/0, and the tests are 1859 pass, 2 skip (opt-in), 0 fail.

Not fixed: a sink that throws mid-fan-out is detached without a re-check. It
is rare: a programming error, since closed peers no-op. The next attach or
detach re-checks.

## Review

*— claude-opus-5-5, 2026-10-22* (fresh context. The executor is the same
model family, so blind spots we share can survive both passes. A
load-bearing protocol change would be better re-reviewed by a different
model, per AGENTS §10.)

**Verdict: REQUEST-CHANGES.** The strip-schema half is sound. The
blocking-update gate does not do what AGENTS §7 and `updates.ts` say it does.
That is harmless inside v10, but it fails in exactly the post-v0.1.0 case the
task exists for. §7 also omits the `mandatory` class and the frozen envelope.

**Gate (re-run):**
- `bun run check`: typecheck clean, lint 0/0.
- Tests: **1849 pass, 2 skip (opt-in), 0 fail**, out of 1851 across 156 files.

**Findings: must-fix**

1. **"Emitted only to a client that declared it" is false.**
   - Where the claim is made: AGENTS §7, `protocol/src/updates.ts:190-197` and
     Implementation.
   - What the code does: `emit` broadcasts to every attachment
     (`daemon/src/hosted-session.ts:642-645`), and so does the replay on attach
     (`:543`). The gate only decides whether to deny when *nobody* declared the
     type.
   - Trace step 1: client A omits `permission_request` and B lists it. A still
     receives `seq=3 permission_request (mandatory)`.
   - In v10 this is harmless, because A knows the kind. The problem is a future
     blocking kind X. An older client attached beside a newer one gets an
     unknown *mandatory* frame. `RemoteSession` then fails the turn and calls
     `client.cancel` (`client/src/remote-session.ts:240-245`), which cancels the
     shared turn for the client that *could* answer.
   - Fix: in `emit` and in the attach replay, send a BLOCKING type to an
     attachment that did not declare it **without** `mandatory`. That client
     classifies it as `unsupported` (one notice), and `seq` stays contiguous, so
     there is no forced reopen.
2. **The gate runs only when the ask is raised** (`hosted-session.ts:339`).
   Attach and detach while an ask is pending are not checked again.
   - Trace step 3: an ask is raised while detached, then a client that does not
     declare `permission_request` attaches. It gets the replayed request, and no
     `turn_end` arrives within 1 s.
   - Inside v10 this can't happen. Every v10 build knows the kind, and a missing
     list means the base set (`updates.ts:209`). So the executor's "open gap"
     claim holds for v10 only.
   - For a new blocking kind it becomes a wait caused by a peer that does not
     understand, which is what the goal forbids. Today only the loud failure in
     finding 1 ends it, and the fix for finding 1 removes that failure.
   - Fix: on attach and on detach, if a blocking ask is pending, `attachments > 0`
     and no attachment declares the kind, settle it with the fallback (same
     `reason`).
   - Keep zero attachments suspended. That is the owner's exception, pinned by
     T3b.
   - Add tests: mixed attach, and a non-declaring client attaching while an ask
     is pending.
3. **AGENTS §7 wording is incomplete.**
   - It lists "an update kind" as a free addition. Only a *display* kind is
     free. An unknown **mandatory** kind still fails every older client's turn
     (`client/src/mapping.ts:56-66`).
   - The executor's deviation is **right**: skipping a mandatory kind would
     silently desync the turn state, and failing is not waiting. But the rule
     has to be written down. §7 must name the three classes:
     - display: free to add;
     - mandatory: a bump, unless the daemon gives clients that did not declare
       it a fallback such as a resync;
     - blocking: declared, with a fallback.
   - §7 must also say the **JSON-RPC envelope is frozen**. A member added there
     fails the strict union (`transport/src/peer.ts:294-298`), and a response
     that fails to parse leaves its request pending unless `requestTimeoutMs` is
     set. So adding an envelope member is breaking.

**Findings: should-fix / nits**

4. Classes are defined in two structures:
   - `UPDATE_CLASS` (display or mandatory) at `updates.ts:161-184`;
   - `BLOCKING_UPDATE_TYPES` at `updates.ts:199`.

   Fold `"blocking"` into `UpdateClass` so the `Record` forces every new type to
   be classified. Then derive the set from it, and make blocking imply the
   wire `mandatory` flag.
5. Nit: `blockingUnsupported` was inserted between `awaitDecision`'s JSDoc and
   its body (`hosted-session.ts:303-326`), so that doc comment now sits on the
   wrong method.
6. Nit: the notice is lost while idle.
   - The reducer marks a type as reported (`session-reducer.ts:223-225`).
   - `RemoteSession.output` drops outputs when no turn is active
     (`remote-session.ts:217-220`).
   - So an unknown kind that arrives between turns is never shown for that
     session.
7. Nit: the store stays strict (`agent/src/session-store.ts`). This is
   acceptable: the store is owned by the laptop (and by a trusted `serve`), so it
   is not a trust boundary, and it fails loudly. But a record with a new
   `ChatMessage` field, written by a newer build, fails `--resume` on an older
   one. Say in §7 that the persisted format is versioned separately.
8. Nit: `TODO.md` has no index row for this task (§10).

**Premise table**

| Premise | Result |
|---|---|
| Repro: `OpenParams` and others are `.strict()` on HEAD, and `PROTOCOL_VERSION` is 9 (`git show HEAD:…session.ts:278-291`, `version.ts`) | TRUE |
| Handlers get *parsed* data: requests `peer.ts:340`, notifications `:406`, results `:446` | TRUE |
| No plain object unions, so strip mode cannot silently pick the wrong member (`json-schema.ts:198` throws; only discriminated unions are used) | TRUE |
| Before this change, `classifyUpdate` ignored unknown display updates and failed on unknown mandatory ones (HEAD `mapping.ts:62`) | TRUE |
| The daemon broadcast `permission_request` and suspended (`hosted-session.ts:642`, `awaitDecision`) | TRUE |
| `--plain` and one-shot run in-process with no wire (`cli/src/main.ts:557-561`, `:686`) | TRUE |
| "A blocking type is emitted only to a client that declared it" (AGENTS §7) | **FALSE** (finding 1) |

**Mutations** (each red, then reverted; the tree is byte-identical, checked by
comparing a hash of `git diff` and `git status` before and after):
- Gate without the `attachments.size === 0` guard, so a detached session is
  denied: 3 tests fail (T3b, B7, E4). The owner's exception is pinned.
- Agent tool result without `reason`: the remote gate test fails.

**Attacks tried**

1. **Strip trust (§7).**
   - On `resolve_permission` I smuggled `{allowed:true, scope:"session"}` with
     `reject_once`. The keys were stripped, the result was "Permission denied by
     the user", and no rule was remembered.
   - `hooks/trust`: `model` is `line(64)`, so bounded with no control or bidi
     characters, and the executor's pod-strip test covers it.
   - The envelope staying strict is correct, but undocumented (finding 3).
   - Holds.
2. **The `mandatory` deviation.** Correct as fail-loud, not a wait. But it is
   defined in two places and missing from §7 (findings 3 and 4). It also turns
   into a cross-client cancel under multi-attach (finding 1).
3. **Open gap and attachment cases.** Detached still suspends (T3b holds). The
   other cases are covered by findings 1 and 2.
   - Multi-attach: every client gets the ask (finding 1).
   - Attach while pending: it waits (finding 2).
   - Empty list `[]`: means "supports nothing", so it is denied.
   - Missing list: means the base set.
   - Reconnect: a reconnecting client re-runs `initialize` with
     `KNOWN_UPDATE_TYPES`, and `AlreadyInitialized` prevents changing the list
     mid-connection.
4. **`reason`.**
   - Produced only on the daemon side (`hosted-session.ts:341`). It is not a
     wire field.
   - Mapped to `by:"unavailable"` (`permission-gate.ts:161`) and from there into
     the tool result (`agent.ts:925-933`).
   - A pod could spoof it, but a pod already controls its own agent's text. The
     text reaches the laptop only as tool-result text, and since it is a denial
     it creates no lasting approval.
   - Holds.
5. **The `initialize` list.** Bounded to at most 256 entries, each at most 64
   characters matching `^[a-z][a-z0-9_]*$` (`session.ts:48-58`). It round-trips
   (`remote.test.ts:2001`). Holds.

**End-to-end trace:** `.tentacle/tmp/protocol-v10-forward-compat/trace.ts`
uses a real `SessionHost`, `Connection`, an `RpcPeer` pair and a scripted
model. Output (condensed):
```
1) A(no permission_request)+B(all): A <- seq=3 permission_request (mandatory)   # finding 1
2) B reject_once + {allowed:true,scope:"session"} -> "Permission denied by the user"  # strip holds
3) ask raised detached; D(no permission_request) attaches -> D <- seq=3 permission_request;
   turn_end within 1s: false                                                     # finding 2
```

**What holds:**
- Strip on every payload, with known fields still fully validated.
- The envelope stays strict.
- A no-list client and a full-list client are prompted as before.
- Detached sessions suspend (the owner's exception).
- `reason` is wired from daemon to agent and reaches the model.
- `unsupported` is reported once per kind per session.
- The `hooks/trust` `model` field, and v10 itself.

**How the executor behaved:**
- Tests came first and were shown red.
- 10 mutations, all reported honestly.
- The store-strictness drift was recorded.

It over-claimed in two places. It wrote the gate up as per-client delivery,
and it put the mandatory deviation in the design doc but not in the AGENTS
rule.

### Re-review

*— claude-opus-5-5, 2026-10-22* (fresh context, same model family as the
executor; see the caveat above)

**Verdict: APPROVE-WITH-NITS.** Findings 1–8 are fixed, and so is the
coordinator's envelope item. Nothing found here is a wait caused by a
conforming peer not understanding a message.

**Gate:** `bun run check` passes. Typecheck clean, lint 0/0, **1859 pass, 2
skip (opt-in), 0 fail** out of 1861 tests in 156 files.

**Traces** (real `SessionHost`, `Connection` and `RpcPeer`;
`.tentacle/tmp/protocol-v10-forward-compat/trace.ts`):
- Mixed attach. A client that did not declare `permission_request` now gets it
  without `mandatory`, so `seq` stays contiguous. The declaring client is
  prompted and its answer settles the turn for both.
- Ask raised while detached, then a non-declaring client attaches. It gets the
  replay as display, then `permission_resolved`, then the tool result "Permission
  could not be requested: client does not support permission_request; update
  tentacle". `turn_end` arrives within 1 s, where before it never came.
- Detached with nobody attached: the ask stays suspended (T3b still pins it).

**Mutations** (each red, then reverted; the tree is byte-identical, checked by
hashing `git diff` and `git status`):

| Mutation | Tests that failed |
|---|---|
| `frameFor` always returns the frame unchanged | 1 (mixed attach) |
| `recheckAsks` does nothing | 2 (attach while pending; the only declaring client detaches) |
| Peer no longer rejects the pending request on an unreadable reply | 1 |
| `.strict()` put back on the success response | 3 |
| Classifier accepts two classifying members | 2 |

**Envelope attack** (a raw responder answering a real `RpcPeer` request;
`.tentacle/tmp/protocol-v10-forward-compat/envelope.ts`):

| Reply | Result |
|---|---|
| Valid reply plus an unknown member | resolved |
| `result` and `error` together | rejected at once |
| `error: null` | rejected at once |
| `jsonrpc: "3.0"` | rejected at once |
| Numeric id answering a string id | correlated (coerced with `String`, as before) |
| `id` of the wrong type, a batch array, no `id`, or an unreadable reply with an unknown `id` | answered `InvalidRequest`; no reply loop |
| `result` plus `method` with our id | treated as an inbound request, since ids are per direction; correct |

In the last two rows our own request stays pending when there is no request
timeout. That is acceptable: none of those replies comes from a conforming
JSON-RPC 2.0 peer, newer or older, because we never send batches and a
response must echo our string `id`.

**Ruling on the open item.** A sink that throws during the fan-out
(`hosted-session.ts` `emit` catch) is removed without `recheckAsks`.
`reportTurnError` only logs it, so the ask can wait until the next attach or
detach. This is a **nit, not a must-fix**:
- it needs a programming error, since closed peers are no-ops;
- the failure is reported;
- it is not a peer failing to understand a message.

Cheap fix: after the fan-out loop (never inside it, because `settle` emits),
call `recheckAsks()` if any attachment was removed.

**Remaining nits (optional):**
1. The throwing-sink recheck above.
2. A request option `requestTimeoutMs` already exists. Consider defaulting it
   for requests sent to an untrusted pod, so even a non-conforming reply can't
   pin a request.

**What holds:** the AGENTS §7 text now matches the code:
- three classes in one place (`UPDATE_CLASS`);
- a tolerant envelope classified by its one `method`, `result` or `error` member;
- on-disk records versioned separately from the wire.

The executor fixed every item with tests that were shown red by mutation.
