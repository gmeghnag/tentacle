# feat/permission-reply — Permission prompt: "No, let's talk about it"

> **Status:** implementation (re-planned 2026-10-26 against main `5e8b538`; awaiting the owner's re-approval — the 2026-10-24 decisions Q1–Q4 stand, see Review)
> **Branch:** `feat/permission-reply`
> **Size:** M (L if owner Q-A is taken as recommended) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (red-team the single-broker invariant, the pod trust rule, forward compat and — with Q-A — the record versions, AGENTS §7)

Type: feat · Size: M→L (Q-A) · Blast: load-bearing · Suited: strong model + fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-24; re-plan claude-opus-5-5, 2026-10-26*

**Why.** The permission dialog offers Yes / Yes, always / No
(`packages/tui/src/permission-ui.ts:110-114`). "No" tells the model only
``Permission denied by the user: `<tool>` was not run.``
(`packages/agent/src/agent.ts:949-955`) — the model learns *that* the user
refused, never *why* or *what to do instead*, so it guesses (often retries
something close). The owner decided (2026-10-24, `TODO.md:957-983`,
`docs/eval/mobile-app.md:559-563`) a fourth answer: **"No, let's talk about
it"** opens a text field; the model receives the rejection TOGETHER with the
user's text as that tool call's result, and the turn CONTINUES (it answers or
changes plan, and asks again if it still needs the tool). Unlike `Ctrl+X
Ctrl+S` (stops the turn, sends the queue), the text answers that one request.
*(re-plan 2026-10-26: line refs re-verified on `5e8b538`.)*

**Constraints.** Additive wire change, no `PROTOCOL_VERSION` bump (it is 11,
`packages/protocol/src/version.ts:7`). A client never guesses what the daemon
knows: whether a daemon can carry the text is *reported by the daemon*. The
text leaves the laptop like every answer, so it holds for every target
(worker, `run`, `attach`, `connect`, and the phone). Owner queue position 5
(`TODO.md:1006-1007`), after task 7 `connect-sessions`; task 13's phone
approvals inherit it. *(re-plan 2026-10-26: queue position from the
2026-10-25 owner queue.)*

**What changed on main since 2026-10-24** *(re-plan 2026-10-26)* — each
re-checked below, none breaks the shape; three add work:
- **v10 forward compat / `UPDATE_CLASS`**: `permission_request` is
  `blocking`, `permission_resolved` `mandatory`, `tool_call_update` `display`
  (`protocol/src/updates.ts:223-243`); a session whose attached clients all
  lack `permission_request` gets an immediate `{allowed:false, reason}`
  (`daemon/src/hosted-session.ts:471-478`, `:540-565`) — no ask, so no reply.
- **Task 6 tui-foreign-turns**: the broker call carries a laptop-internal
  `turnId` (`core/src/permission.ts:64-74`; `client/src/permission-router.ts:83-99`,
  `remote-client.ts:1794-1798`); auto-accept answers only my own turns
  (`permission-ui.ts:41-58`, `:161-176`, `:187-190`). Any device may answer a
  foreign turn's request (first wins). → the reply rules below follow this.
- **tui-spill-note**: a precedent that a tool row shows a *structured fact*,
  never the model-facing banner (`core/src/tool.ts:30-52`,
  `agent/src/agent.ts:106-118`, `render-lines.ts:407-410`), with a record
  bump (`daemon/src/persisted-session.ts:26-30`, v5) and a strict laptop store
  key list (`agent/src/session-store.ts:213-216`). → owner Q-A.
- **2a archive / 3 titles / 5 queued-broadcast**: no permission code touched.
  The returned-rows path gives the TUI a reusable "text back in the input with
  a notice" (`App.tsx:706-715` `restoreInput`, used at `:735`, `:1420`).

**Repro** (2026-10-26, `/Users/gmeghnag/tentacle/.tentacle/tmp/permission-reply-replan/repro.ts`,
run with `bun repro.ts` from that folder; imports main-ro packages by
relative path). Shows (1) a plain No already continues the turn — the model
gets a second round whose `tool` message is the bare denial, no room for the
user's words; (2) what each candidate wire shape does to an older peer's
schema; (3) the update classes. *(re-plan 2026-10-26: re-run on `5e8b538`,
lines 3, 7, 8 added.)*

```ts
// Re-plan repro (2026-10-26, main 5e8b538). (1) Does a plain "No" keep the
// turn going (a second model round sees the denial as the `tool` message)?
// (2) What do older peers' schemas do with each candidate wire shape?
import { Agent } from "../../worktrees/main-ro/packages/agent/src/index.ts";
import type { ChatRequest, ModelProvider, StreamEvent } from "../../worktrees/main-ro/packages/core/src/index.ts";
import {
  ChatMessageSchema,
  PermissionRequestUpdateSchema,
  ResolvePermissionParamsSchema,
  ToolCallUpdateSchema,
  UPDATE_CLASS,
} from "../../worktrees/main-ro/packages/protocol/src/index.ts";
import { ToolRegistry, shellTool } from "../../worktrees/main-ro/packages/tools/src/index.ts";

const seen: ChatRequest[] = [];
const script: StreamEvent[][] = [
  [
    { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: '{"command":"rm -rf build"}' } },
    { type: "done" },
  ],
  [{ type: "text", delta: "ok, trying bun run build" }, { type: "done" }],
];
let i = 0;
const model: ModelProvider = {
  id: "scripted",
  async *stream(req) {
    seen.push(req);
    for (const e of script[i++] ?? [{ type: "done" }]) yield e;
  },
};
const env = {
  id: "f",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async readFile() {
    return "";
  },
  async writeFile() {},
};
let asked = 0;
const agent = new Agent({
  model,
  tools: new ToolRegistry().register(shellTool),
  env: env as never,
  requestPermission: async () => {
    asked++;
    return { allowed: false };
  },
});
const ends: string[] = [];
for await (const e of agent.run("s1", [{ role: "user", content: "go" }])) {
  if (e.type === "turn_end") ends.push(`turn_end:${e.reason}`);
}
console.log("asked:", asked, "model rounds:", seen.length, ends);
console.log("round-2 tool msg:", JSON.stringify(seen[1]?.messages.find((m) => m.role === "tool")));
console.log("UPDATE_CLASS permission_request / tool_call_update:", UPDATE_CLASS.permission_request, "/", UPDATE_CLASS.tool_call_update);
console.log(
  "resolve with extra message (old daemon parse):",
  JSON.stringify(
    ResolvePermissionParamsSchema.parse({ sessionId: "s", requestId: "r", optionId: "reject_once", message: "why?" }),
  ),
);
const upd = {
  type: "permission_request",
  requestId: "r",
  toolCallId: "c",
  tool: "shell",
  title: "t",
  options: [{ optionId: "reject_reply", name: "x", kind: "reject_reply" }],
};
console.log("request with an unknown option kind (old client parse ok?):", PermissionRequestUpdateSchema.safeParse(upd).success);
console.log(
  "request with an unknown extra field (old client parse):",
  JSON.stringify(
    PermissionRequestUpdateSchema.parse({
      ...upd,
      options: [{ optionId: "reject_once", name: "Deny", kind: "reject_once" }],
      reply: { maxChars: 2000 },
    }),
  ),
);
console.log(
  "tool_call_update with an unknown denial field (old client parse):",
  JSON.stringify(
    ToolCallUpdateSchema.parse({ type: "tool_call_update", toolCallId: "c", status: "failed", denial: { reply: "why?" } }),
  ),
);
console.log(
  "wire ChatMessage with an unknown denial field (old peer parse):",
  JSON.stringify(ChatMessageSchema.parse({ role: "tool", content: "x", toolCallId: "c", denial: { reply: "why?" } })),
);
```

Output (2026-10-26):

```
asked: 1 model rounds: 2 [ "turn_end:end_turn" ]
round-2 tool msg: {"role":"tool","content":"Permission denied by the user: `shell` was not run.","toolCallId":"c1"}
UPDATE_CLASS permission_request / tool_call_update: blocking / display
resolve with extra message (old daemon parse): {"sessionId":"s","requestId":"r","optionId":"reject_once"}
request with an unknown option kind (old client parse ok?): false
request with an unknown extra field (old client parse): {"type":"permission_request","requestId":"r","toolCallId":"c","tool":"shell","title":"t","options":[{"optionId":"reject_once","name":"Deny","kind":"reject_once"}]}
tool_call_update with an unknown denial field (old client parse): {"type":"tool_call_update","toolCallId":"c","status":"failed"}
wire ChatMessage with an unknown denial field (old peer parse): {"role":"tool","content":"x","toolCallId":"c"}
```

Reading: lines 1–2 — the continuation already exists (one ask, two rounds,
`end_turn`); only the words are missing. Line 3 — `permission_request` is
`blocking`: anything that makes an older *declaring* client fail to parse it
would be a hang-or-fail, not a skip. Line 4 — an optional text on the answer
sent to an *older daemon* is silently stripped (the user's words vanish while
the UI said they were sent): the client must only send it when the daemon
said it can take it. Line 5 — a new option **kind** makes the whole
`permission_request` unparseable for an older client
(`PermissionOptionKindSchema` is a closed `z.enum`,
`protocol/src/permission.ts:28-33`) — rejected. Line 6 — a new optional field
on the request is dropped cleanly by an older client (strip schema): the
capability report we want. Lines 7–8 *(re-plan 2026-10-26)* — a structured
reply on the tool result (owner Q-A) degrades cleanly too: an older client
shows the `content` text instead.

## Implementation

*— claude-opus-5-5, 2026-10-24; re-plan claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**A refusal does not end the turn: the agent records the denial as that call's
`tool` result and runs another model round** — so carrying the user's text is
a change to the refusal's *content*, not to the loop. Proof: `runTool`
returns the denial as an ordinary `{content, isError: true}` result
(`agent/src/agent.ts:949-955`); `runToolCalls` passes every result through
`transformResult`, yields `tool_result`, pushes it as a `tool` message and
commits (`agent.ts:771-779`) with no special case for denials; the repro
shows 1 ask, 2 model rounds, `turn_end:end_turn`, and the denial as the
`tool` message of round 2. The only other ends are the abort, checked
*before* the answer (`agent.ts:917-923`), and the iteration cap.
**Re-proved by the repro on `5e8b538` (2026-10-26): holds.** *(re-plan
2026-10-26: refs moved, property unchanged.)* *(re-verified 0874c46: the
refusal is built by `gateRefusal` (`agent.ts:1453-1479`), returned by
`runTool` (`:1426-1428`) after the abort check (`:1423-1425`); `runToolCalls`
transforms, yields `tool_result`, pushes and commits (`:1098-1113`). A second
refusal site appeared: `runContextReset` answers a denied reset with
`gateRefusal` WITHOUT `transformResult` (`:1167-1178`). Property holds — the
new agent test shows 2 model rounds and `end_turn` with the reply.)*

Second, equally cited, the **wire-safety** assumption: unknown fields are
dropped on parse, unknown option kinds are not (repro lines 4–8;
`protocol/src/permission.ts:28-41`, strip `z.object`, closed `z.enum`;
`updates.ts:50-57`).

### Preconditions

*(re-plan 2026-10-26: every ref below re-verified on `5e8b538`.)*

- **One session path.** Every runtime drives the TUI through
  `RemoteClient` ↔ `Connection`; the answer goes `PermissionBroker` (laptop,
  `core/src/permission.ts:109-157`) → `PermissionRouter.answered`
  (`client/src/permission-router.ts:119-145`) → `responseToOutcome`
  (`client/src/permission-map.ts:9-17`) → the `send` action's
  `session/resolve_permission`, `keyed` (`remote-client.ts:1812-1834`) →
  `Connection.resolvePermission` (`daemon/src/connection.ts:266-270`) →
  `HostedSession.resolvePermission`/`settle` (`hosted-session.ts:575-605`) →
  the wait in `awaitDecision` (`hosted-session.ts:463-533`, mapped at `:531`
  by `outcomeToResponse`, `daemon/src/permission-map.ts:45-57`) →
  `PermissionGate.authorize` (`agent/src/permission-gate.ts:153-163`) →
  `Agent.runTool` (`agent.ts:949-955`). One chain, extended end to end.
- **Sub-agents share it.** A sub-agent's `Agent` gets the same
  `requestPermission` (`cli/src/wiring.ts:277`, `agent/src/subagent.ts:172`),
  so a reply to a sub-agent's ask reaches the sub-agent's model with no extra
  code. *(re-plan 2026-10-26: new.)*
- **Single broker.** Exactly one laptop `PermissionBroker` per runtime, shared
  by runtime and TUI (`cli/src/main.ts:529,576,625`, `cli/src/connect.ts:89`);
  pinned by `cli/test/pod-runtime.test.ts:327-358` (a `SpyBroker` vs a
  separate daemon-side broker) and `:1534` (same broker across a reconnect).
  This change adds a field to the broker's *response* and one optional
  callback to its *options* (the task 6 pattern: "a field added to
  `PermissionRequestOptions` rides the existing call; held requests keep
  their options", `docs/feat/tui-foreign-turns.md:228-233`,
  `core/src/permission.ts:101-107,123-126`) — never a broker.
- **A refusal creates nothing lasting.** The gate remembers only
  `allowed && scope === "session"` (`permission-gate.ts:155-157`); a
  `reject_once` is never remembered. The router keeps no grant cache and
  treats `permission_resolved` as display-only (`permission-router.ts:11-14`).
- **First-wins, synchronous settle.** `resolvePermission` validates the
  option against `offered` and throws `InvalidParams`, leaving the request
  pending (`hosted-session.ts:575-584`); `settle` emits `permission_resolved`
  before waking the gate (`:591-605`). No await, no lock (AGENTS §7 "don't
  serialize the RPC peer").
- **No ask without a declaring client.** `blockingUnsupported` /
  `recheckAsks` refuse with a `reason` (`hosted-session.ts:471-478,540-565`),
  mapped to `by:"unavailable"` (`permission-gate.ts:161-162`) — a different
  denial text (`agent.ts:940-948`) that this change does not touch.
  *(re-plan 2026-10-26: new, v10.)*
- **Params are schema-validated on the daemon** (method table
  `protocol/src/methods.ts:19,63`); strip schemas (`permission.ts:80-84`).
- **The result reaches every client and both stores as ordinary content.**
  `tool_result` → `tool_call_update{status:"failed", content, spill?}`
  (`daemon/src/mapping.ts:203-210`) → client `tool_result`
  (`client/src/mapping.ts:170-177`) → TUI `resultText`
  (`tui/src/state.ts:287`), drawn in the error colour line by line
  (`render-lines.ts:411-424`); resume from history (`tui/src/resume.ts:40`).
  Both stores persist the `tool` `ChatMessage` (AGENTS §7): the laptop's
  strict key list (`agent/src/session-store.ts:213-216`) and the daemon's
  record (`persisted-session.ts:26-30`, v5). With the text in `content` only,
  **no record-format change**; Q-A adds one field (see Design).
- **Result pipeline.** Every result, denials included, goes through
  `transformResult` (`agent.ts:867-896`): redaction first, then `tool_result`
  hooks, then large-output shaping (`cli/src/wiring.ts:184-199`); shaping
  default 16000 chars (`config/src/defaults.ts:29`).
- **Dialog keys** *(re-plan 2026-10-26)* are routed in `App`'s `useInput`:
  Shift+Tab first (`App.tsx:1694-1697`), then the `Ctrl+X Ctrl+S` chord
  (`:1701-1709`, pure `chord.ts:23`), then the dialog branch (`:1712-1741`:
  Ctrl+C dismiss + abort only with a turn shown, ↑↓, Enter, `y`/`a`, `n`/Esc =
  No). **Bracketed paste is parsed only after that branch** (`stepPaste`
  `:1758-1770`; freeze recovery timer `:1666-1685` inserts into the *main*
  field). The main field's key routing is pure (`resolveLineInput`,
  `input-actions.ts:45`, executed at `App.tsx:1956-2009`) over
  `editor.ts`/`useLineEditor` (`hooks.ts:117-160`). The controller is
  `usePermissionBroker` (`permission-ui.ts:138-224`); a withdrawn ask resolves
  `DISMISSED` and closes the dialog (`:193-201`); Shift+Tab grants an
  on-screen request only if `autoApproves(req, own)` (`:161-176`).
- **Dialog height** is computed in `App` from `permissionPromptRows`
  (`App.tsx:607-614`, `components/PermissionPrompt.tsx:15-18`).
- **hooks_trust** prompts are laptop-local (`permission-ui.ts:85-100`), never
  a daemon `permission_request` — the reply choice never applies to them.

### Design

**Wire (protocol, additive, no bump).** Two optional fields:

1. `permission_request.reply?: { maxChars: int ≥ 1 }` — the daemon's report
   "this request accepts a reply with a refusal, up to `maxChars`". Present ⇔
   the daemon can carry the text. An older client strips it (repro line 6)
   and shows its three options — unchanged. A new client facing an older
   daemon sees no `reply` and does not offer the choice — **no silent drop**
   (repro line 4 is the drop this avoids). Per request, not in `initialize`:
   it rides replay and resync with the request itself.
2. `session/resolve_permission.message?: string` — the user's reply.
   Schema `PermissionReplyTextSchema`: `min(1)`,
   `max(MAX_PERMISSION_REPLY_CHARS)` (new constant, **2000** UTF-16 units), no
   control characters except `\n` and `\t`, not whitespace-only (refine). A
   bad message is a malformed answer ⇒ `InvalidParams`, request stays pending
   (the existing rule, `permission.ts:15-19`).

*Reconciled with AGENTS §7 (re-plan 2026-10-26).* §7 says pre-public "no
capability negotiation for old peers" *and* that the v10 forward-compat rule
"holds once public too". `reply` is not a shim for old peers: it is the shape
that rule requires for any field whose loss on the other side would be a
silent drop, and it stays correct after publication. A bump instead would
turn every skewed pair (phone app vs a laptop `serve`, an older injected pod
binary) into a hard `VersionMismatch` at `initialize` — worse than one
missing option. No `UPDATE_CLASS` change: no new update kind, no new method;
`permission_request` stays `blocking` (its parse by an older declaring client
is unaffected, repro line 6).

Rejected alternatives: a new option **kind** (`reject_with_reply`) breaks
every older client's parse of a *blocking* update (repro line 5); a
capability in `initialize` is connection-level and adds router state; a text
on `permission_resolved` — a second copy for a pod to forge into a dialog.

`permission_resolved` is **unchanged**: `{outcome:"selected",
optionId:"reject_once"}`.

**Daemon.** `toPermissionRequestUpdate` (`daemon/src/permission-map.ts:28-43`)
adds `reply: { maxChars: MAX_PERMISSION_REPLY_CHARS }` to every tool ask.
`PendingAsk` (`hosted-session.ts:120-129`) gains `replyable: boolean` and the
ids of its `reject_once`-kind options; `resolvePermission(requestId,
optionId, message?)` throws `InvalidParams` (pending kept) if a `message`
comes with a non-reject option or for an ask that did not offer `reply`;
otherwise `settle(requestId, outcome, undefined, message)` → `ask.settle`
passes it → `awaitDecision` returns `{ ...outcomeToResponse(outcome), message }`
(only for a `selected` reject; `cancelled` and `reason` paths never carry
one). `Connection.resolvePermission` (`connection.ts:266-270`) forwards
`params.message`. Synchronous end to end; `permission_resolved` emitted
exactly as today. The pending record on disk is unchanged (the text is never
pending state; it lands in the `tool` message).

**Core.** `PermissionRequest.reply?: { readonly maxChars: number }`
(laptop-side mirror of the daemon's report) and
`PermissionResponse.message?: string` ("the person's reply with a refusal;
meaningful only with `allowed: false`"). *(re-plan 2026-10-26)*
`PermissionRequestOptions.onAnswerLost?: (response: PermissionResponse) =>
void` — laptop-internal like `signal`/`turnId`: the runtime calls it when an
answer the requester returned was **not delivered** (see Client). A
requester that sent no `message` may ignore it.

**Agent.** `PermissionGate.authorize` maps a refusal's `response.message`
into the `by: "user"` outcome (`GateOutcome` gains `message?: string`,
`permission-gate.ts:75-84,161-163`); an `allowed: true` response's message is
ignored. `Agent.runTool` (`agent.ts:949-955`) builds the content — plain No
stays **byte-identical**; with a message (owner Q1, approved):

```
Permission denied by the user: `<tool>` was not run. The user replied:
<message>
Answer the user or change your approach; request this tool again only if you still need it.
```

Pinned by a test. *(re-plan 2026-10-26, only with Q-A:)* the result also
carries `denialReply: <message>` (`ToolResult`, `core/src/tool.ts:47-63`), and
`toolMessage` copies it onto the `tool` `ChatMessage` like `spill`
(`agent.ts:111-118`). In `runToolCalls` the field is kept **only if the
transformed `content` is byte-identical to `runTool`'s** (`agent.ts:771-777`):
if redaction or a `tool_result` hook rewrote the denial, the structured copy
is dropped and frontends show the content — the row never shows a reply the
model did not see, nor an unredacted secret.

**Client.** `toPermissionRequest` (`permission-router.ts:56-65`) copies
`reply`. New pure `normalizePermissionReply(text, maxChars): string | null`
in `client/src/permission-map.ts` (shared by TUI and app — `apps/mobile`
depends on `@tentacle/client`): CRLF/CR → LF, drop C0/C1/DEL except
`\n`/`\t`, trim, clamp to `min(maxChars, MAX_PERMISSION_REPLY_CHARS)` (a pod
may advertise anything), empty → `null`. `PermissionRouter.answered`: a
refusal with a message on a request that did not offer `reply` → **not
sent**, a new `unreplyable` action (mirrors `unoffered`,
`permission-router.ts:38-44,132-137`; executed like it at
`remote-client.ts:1803-1808`) — never a bare No behind the user's back. A
valid one → the `send` action carries `message`; `RemoteClient` puts it in
the params (`remote-client.ts:1816-1821`, the `keyed` retry keeps them).
*(re-plan 2026-10-26)* **Undelivered reply:** today a `send` that fails with
`PermissionNotPending` or `SessionLostError` is silent and a real failure
goes to `answerFailed` + `onError` (`remote-client.ts:1822-1833`). When the
answer carried a `message`, all three also call the prompt's
`onAnswerLost(response)` (kept in the `prompts` entry with the controller,
`:1786-1793`), so the TUI puts the text back in the input. Silent stays
silent for the *decision*; only the user's words are handed back (owner rule
"a message is never lost silently", Q4).
*(re-plan 2026-10-26, only with Q-A:)* `client/src/mapping.ts:170-177` copies
`update.denialReply` onto the result, the field only, never parsed from the
banner (as `spill`).

**TUI.** Logic in a new pure module `packages/tui/src/permission-reply.ts`
(AGENTS §7; `App` only dispatches). *(re-plan 2026-10-26: reuse the pure
routing that now exists.)* State `{ mode: "menu" } | { mode: "reply",
editor: EditorState }`; `stepPermissionKey(state, char, key, ctx) → { state,
action }`, where text editing is **`resolveLineInput`** (`input-actions.ts:45`)
over `editor.ts` ops — `history`/`scroll` map to `none`, `submit` to send,
`newline` as in the main field — and actions are `answer(response)` /
`dismiss` / `toggleAuto` / `pasteClipboard` / `none`. A pure
`replyView(state, columns, maxChars)` → rows + cursor via `inputRender`
(`input-view.ts:214`), capped at 4 rows (scrolls), plus the footer.
`buildPermissionChoices` gains a 4th choice **"No, let's talk about it"**
only when `req.reply` is set, marked `{ reply: true }` instead of a response.
All UI strings English. UX:

- Menu: ↑↓ + Enter, `y`/`a`/`n`/Esc as today, **`t`** opens the field
  (Enter on the 4th choice too). Footer `↑↓ choose · enter confirm · y/a/n/t ·
  esc deny`.
- Field open: a prompt row `Tell the agent why, or what to do instead:`, the
  field, the footer `enter send · esc back · empty = No`, counter
  `1640/2000` from 80 %. Input past `maxChars` is clipped. **Enter** submits —
  non-empty → `{allowed:false, message}`, empty/whitespace → plain No (owner
  Q2). **Esc** returns to the menu (draft kept while the same request is up).
  **Ctrl+C** as today (`App.tsx:1715-1726`: dismiss + abort the turn, only if
  one is shown) — the draft goes to the main input (withdrawal, below).
- **Paste** *(re-plan 2026-10-26)*: the dialog branch returns before
  `stepPaste` (`App.tsx:1712-1741` vs `:1758`), so in reply mode `App` runs
  `stepPaste` inside the dialog branch and feeds the sanitized text to the
  reply editor; the freeze-recovery timer (`:1677-1683`) and Ctrl+V
  (`:1967-1979`) target the reply editor when one is open. Never into the
  hidden main field.
- **Shift+Tab while the field is open** (owner Q3, *re-plan 2026-10-26: kept
  consistent with today's toggle and task 6*): exactly today's
  `toggleAutoApprove` — turning ON grants the request **iff**
  `autoApproves(req, own)` (`permission-ui.ts:161-176`). If it grants, the
  non-empty draft moves to the main input with the notice
  `_auto-accept on: the request was approved; your reply is back in the input_`.
  If it does not grant (a **foreign turn's** request, task 6 C5, or turning
  auto-accept OFF), the field stays open with its draft — the user is still
  answering.
- **Send-now (D3) with the field open:** the chord is checked before the
  dialog, so `Ctrl+X Ctrl+S` fires as today. An accepted send-now aborts the
  turn daemon-side → the ask is withdrawn → the dialog closes; the fallback
  paths answer `DISMISSED` (`App.tsx:1171-1180`, `:1264-1267`).
- **Withdrawal** (owner Q4): send-now, cancel, Ctrl+C, answered on another
  device, a resync that drops it (`permission-router.ts:176-190`) — a
  non-empty draft goes to the main input via `restoreInput` (`App.tsx:706-715`,
  appended after any draft by `withRestored`) with the notice
  `_your reply was not sent (the request was withdrawn): it is back in the input_`.
  Mechanism: the controller hands the orphaned draft to an `onOrphanedDraft`
  callback when the request closes without the reply being sent.
- **Lost after Enter** *(re-plan 2026-10-26)*: the requester passes
  `onAnswerLost` → the same `restoreInput` with
  `_your reply did not reach the agent (the request was already settled): it is back in the input_`.
- **Dialog height:** `permissionPromptRows` takes the reply view's row count
  so `App`'s viewport math (`App.tsx:607-614`) stays exact.
- **Foreign turns** *(re-plan 2026-10-26)*: the 4th option is offered for a
  foreign turn's request too (any device may answer; first wins). The reply
  lands in that turn's history like any answer.
- *(only with Q-A)* **Transcript row:** a tool row with `denialReply` shows
  `Denied · you replied:` and the reply (wrapped, subtle colour), not the
  model-facing three lines; Ctrl+O expanded shows the same. `resume.ts:40`
  copies it from history; `/save` (`commands.ts:327-328`) keeps exporting the
  content (what the model saw).

**Hooks.** No new hook event. `tool_call` hooks run before the prompt;
`tool_result` hooks see the denial content *including the reply* (after
redaction, `wiring.ts:197-199`) and may rewrite it like any result (then,
with Q-A, the structured copy is dropped, above); `model_request` hooks see
it in `messages`. One-line note in `docs/feat/hooks-core.md`.

**Pod trust (AGENTS §7).** The text is typed on the laptop (or the phone)
and flows to the daemon exactly like a prompt — in `run`/`attach` it *leaves
the laptop for the pod*, by the user's own act, as every prompt does. It
grants nothing: `reject_once`, never remembered (`permission-gate.ts:155-157`);
the daemon refuses a message on any allow option. A pod controls only whether
`reply` is offered and its `maxChars` (clamped client-side): the worst it
achieves is one more *refusal* option. The client sends a message only from
a human answer in the dialog (auto-accept never produces one,
`permission-ui.ts:187-190`); `permission_resolved` stays display-only and
carries no text. *(only with Q-A)* `denialReply` from a pod is display-only
pod-supplied text, validated by the same `PermissionReplyTextSchema` (no
control characters reach the terminal) — it can claim "you replied X", as it
can already forge any `content`; it never drives a decision.

**Persistence** *(re-plan 2026-10-26)*. The reply is in the `tool` message's
`content`, so both stores keep it with no change (laptop store from
`snapshot`; `serve` daemon record at the committed boundary). A daemon
restart between settle and the commit loses it with that turn — the same
pre-existing window as a plain No (`hosted-session.ts:521-531`). With Q-A,
`denialReply` is a new `ChatMessage` key: `DAEMON_RECORD_VERSION` 5 → 6 (a v5
daemon refuses a v6 record, as v4/v5 did for `spill`,
`persisted-session.ts:26-30`) and `MESSAGE_KEYS` + validator in
`agent/src/session-store.ts:213-276` (an older laptop refuses loudly, never
half-loads). Wire `ChatMessageSchema` and `ToolCallUpdateSchema` gain
`denialReply?` (strip: older peers drop it, repro lines 7–8).

**Task 13 (app) seam** *(re-plan 2026-10-26)*. The app reuses: `reply` on
the request, `message` on `PermissionResponse` through the same
`PermissionRouter`/`RemoteClient`, `onAnswerLost`, `normalizePermissionReply`,
`MAX_PERMISSION_REPLY_CHARS` and (Q-A) `denialReply` for task 12's
transcript. Only its dialog UI is new. Task 17's notification actions are
Q-B.

**Task 7 `connect-sessions` overlap (likely; branch not inspected,
read-only rule)** *(re-plan 2026-10-26)*. `sessions-panel.ts` does not exist
on main (`packages/tui/src/panel.ts` only) and this task does not touch it.
`App.tsx` overlaps likely in: the `useInput` dialog branch and the Ctrl+C /
quit branch right after it (`:1712-1750`; task 7 changes quit to detach),
`activeRows`/`panelHeight` (`:600-614`; a `/sessions` panel), the bottom-area
render around `PermissionPrompt` (`:2042-2051`), the paste paths gated on
`panelRef` (`:1666-1685`, `:1967-1979`), and `restoreInput`/notices. Possibly
`client/src/remote-client.ts` (other regions: session list/resume). Since
task 7 merges first (owner queue), the executor rebases this plan's
`App.tsx` refs on the merged main before Execution.

### Files

Dependency order *(re-plan 2026-10-26: Q-A items marked)*:

1. `packages/protocol/src/permission.ts` — `MAX_PERMISSION_REPLY_CHARS`,
   `PermissionReplyTextSchema`, `PermissionReplySchema`, `reply?` on
   `PermissionRequestUpdateSchema`, `message?` on
   `ResolvePermissionParamsSchema`; module comment. (Wildcard re-export,
   `index.ts:20`.) *(Q-A)* `denialReply?` on `ToolCallUpdateSchema`
   (`updates.ts:50-57`) and `ChatMessageSchema` (`session.ts:37-38`, next to `spill`).
2. `packages/core/src/permission.ts` — `PermissionRequest.reply?`,
   `PermissionResponse.message?`, `PermissionRequestOptions.onAnswerLost?`.
   *(Q-A)* `core/src/tool.ts` `ToolResult.denialReply?`, `core/src/model.ts`
   `ChatMessage.denialReply?`.
3. `packages/agent/src/permission-gate.ts` — `GateOutcome.message`.
   `packages/agent/src/agent.ts` — wording at `:949-955`; *(Q-A)*
   `toolMessage`, the byte-identical keep rule in `runToolCalls`.
   *(Q-A)* `agent/src/session-store.ts` — key + validator.
4. `packages/daemon/src/permission-map.ts` — `reply`.
   `packages/daemon/src/hosted-session.ts` — `PendingAsk`,
   `resolvePermission`, `settle`, `awaitDecision`.
   `packages/daemon/src/connection.ts:266-270` — forward `message`.
   *(Q-A)* `daemon/src/mapping.ts:203-210`, `persisted-session.ts` v6.
5. `packages/client/src/permission-map.ts` — `normalizePermissionReply`.
   `packages/client/src/permission-router.ts` — `reply`, `message` on `send`,
   `unreplyable`. `packages/client/src/remote-client.ts:1781-1836` — params,
   report, `onAnswerLost`. *(Q-A)* `client/src/mapping.ts:170-177`.
6. `packages/tui/src/permission-reply.ts` (new, pure);
   `packages/tui/src/permission-ui.ts` (choice, draft state, orphaned draft,
   `onAnswerLost` pass-through); `components/PermissionPrompt.tsx`
   (renders the view; presentation only); `App.tsx` (dispatch, paste routing,
   restore, rows). *(Q-A)* `tui/src/state.ts`, `resume.ts`,
   `render-lines.ts`.
7. Docs: `docs/feat/permission-events.md` (the reply), `docs/feat/hooks-core.md`
   (one-line note), `TODO.md` entry → link. This doc moves to
   `docs/feat/permission-reply.md` on the branch.

### Failure modes

*(re-plan 2026-10-26: rows marked ★ are new or changed.)*

| Case | Convergence |
|---|---|
| New client, **older daemon** (no `reply`) | Choice not offered; three options as today. Router refuses a message for a non-`reply` request (`unreplyable`, reported), never a bare No in its place. |
| **Older client**, new daemon | `reply` stripped; three options; plain No → unchanged denial text. ★ With Q-A an older client drops `denialReply` and shows the content. |
| ★ No attached client declared `permission_request` | No ask at all: `by:"unavailable"` denial (`hosted-session.ts:471-478`), unchanged; nothing to reply to. |
| Message too long / control chars / whitespace-only on the wire | Daemon `InvalidParams`, request stays pending; the client normalizes first, so only a buggy/foreign client hits it. |
| Message with `allow_*` | `InvalidParams`, pending kept. |
| Two clients answer (phone replies, laptop says Yes) | First-wins (`hosted-session.ts:575-605`); the dialog of a device still open closes on `permission_resolved` → its draft goes to its input (withdrawal). ★ A reply already sent that loses (`PermissionNotPending`) → `onAnswerLost` → the text back in that device's input with a notice. |
| Link down when Enter pressed | `keyed` call holds the params incl. `message`; sent on reconnect. ★ On `PermissionNotPending` / `SessionLostError` / a real failure → `onAnswerLost` restores the text (the real failure still also re-offers the request via `answerFailed`). |
| Turn cancelled / send-now / Ctrl+C while typing | Ask withdrawn → `DISMISSED`, nothing sent; draft restored with a notice. |
| ★ Shift+Tab while typing | Own request: granted, draft restored with a notice. Foreign turn / hooks trust / turning OFF: no grant, field stays. |
| ★ Paste while typing | Into the reply editor (sanitized, clipped), never into the hidden main field nor read as `y`/`n` keys. |
| Unmount while typing | `DISMISSED` (`permission-ui.ts:214-219`); the draft is lost with the TUI (the session view ends; stated, not silent). |
| Daemon restart after settle, before the commit (`serve`) | As a plain No today: the pending clear is durable before the gate continues (`hosted-session.ts:521-531`); the reply is lost with that turn. Pre-existing window, not widened. |
| Large-output shaping with `maxInlineOutputChars` < ~2.2k | The denial could be spilled like any result. Default 16000 ≫ 2000 + prefix; accepted debt. ★ With Q-A the content changed → `denialReply` dropped → the row shows the spill note, consistent. |
| Redaction / a `tool_result` hook rewrites the reply | Intended for the model. ★ With Q-A the structured copy is dropped (byte-identical rule). |
| Pod advertises `maxChars: 10^9` | Client clamps; daemon schema enforces the same constant. |
| ★ Older laptop / daemon reading a Q-A record | Refused loudly (strict laptop keys; record v6), never half-loaded (AGENTS §7 on-disk rule). |

### Tests

Red first for every new behaviour (fails on `main`: field/option/wording do
not exist), then green; plus the mutations below.

- **protocol** (`packages/protocol/test/permission.test.ts`,
  `forward-compat.test.ts`): `message` bounds — 2000 ok, 2001 rejected,
  `\u001b` rejected, `\n\t` accepted, `"  "` rejected; the repro's strip
  assertions (old-peer simulation). *(Q-A)* `denialReply` same bounds on both
  schemas.
- **agent** (`packages/agent/test/permission.test.ts`): refusal with message
  → exact pinned content, a second model round sees it, `end_turn`; plain
  refusal byte-identical; `allowed:true` + message → tool runs, no text
  anywhere; a sub-agent's ask with a reply reaches the sub-agent's model.
  *(Q-A)* `denialReply` on the `tool` message; dropped when a transform
  changes the content. `session-store.test.ts`: the key round-trips; a
  malformed one is refused.
- **daemon** (`packages/daemon/test/permission-events.test.ts`): update
  carries `reply.maxChars`; `reject_once` + message → `permission_resolved`
  `{selected, reject_once}` (no text), the `tool` message and
  `tool_call_update.content` contain the reply, turn continues; message with
  `allow_once` → `InvalidParams`, still pending, a later valid answer wins;
  overlong → `InvalidParams`, pending; two answers same tick → one wins.
  *(Q-A)* `persistence.test.ts`: v6 round-trip, v5 reads as no reply.
- **client** (`permission-router.test.ts`, a `permission-map` test, the
  remote-client fake connection): `send` carries `message` iff `reply`
  offered; `unreplyable` → nothing sent; `normalizePermissionReply` table
  (CRLF, C1, DEL, trim, clamp, empty → null); `PermissionNotPending` /
  `SessionLostError` / failure with a message → `onAnswerLost` called once
  with it; without a message → not called.
- **tui** (`packages/tui/test/permission-reply.test.ts` pure;
  `app.test.tsx` frames via ink-testing-library; `send-now-app.test.tsx` and
  `foreign-turns.test.tsx` patterns): 4th option only with `reply`; `t` opens
  the field; type + Enter → broker resolves `{allowed:false, message}`; empty
  Enter → `{allowed:false}`; Esc → menu, selection intact; bracketed paste
  lands in the reply field (and a pasted `y` does not approve); Shift+Tab on
  an own request → approved + draft in the input + notice; on a foreign
  turn's request → no answer, field still open; `Ctrl+X Ctrl+S` with the field
  open → `sendNow` fires; withdrawal with a draft → draft in the input frame +
  notice; `onAnswerLost` → same. *(Q-A)* the row shows `Denied · you
  replied:` and not the guidance line.
- **e2e over the real seam** (`packages/cli/test/pod-runtime.test.ts`,
  `SpyFakeCluster`/`SpyBroker`): the spy answers `{allowed:false,
  message:"try bun run build"}`; the daemon-side model's second request
  contains it in the `tool` message. The single-broker test `:327-358` stays
  green untouched.
- **Mutations** (each red, then revert): (a) drop `message` from the `send`
  params → e2e + client red; (b) skip the reject-kind check for messages in
  `hosted-session` → "message with `allow_once`" red; (c) router strips the
  message and sends a bare No for a non-`reply` request → `unreplyable` red;
  (d) daemon omits `reply` → TUI 4th-option and e2e red; (e) wire a second
  broker → `:327-358` red; (f) ★ Shift+Tab in reply mode ignores `own` → the
  foreign-turn test red; (g) ★ skip `onAnswerLost` on `PermissionNotPending`
  → client test red; (h) ★ (Q-A) keep `denialReply` when the content changed
  → agent test red.
- Gate before done: `bun run check` (typecheck → lint 0/0 → full suite; only
  the two opt-in skips).

**Open item (decisive test named):** the wording's effect on real models is
unmeasured — one manual run per provider (OpenAI, Anthropic) with a denied
`rm -rf build` and the reply "why? try bun run build first"; the model must
answer/change plan without re-asking identically.

### Questions for the owner

*(re-plan 2026-10-26 — only decisions that are new since the 2026-10-24
approval.)*

- **Q-A. How does the transcript show your reply?** Today the row would show
  the model-facing text in red: the denial, your text, and the line "Answer
  the user or change your approach…" (`render-lines.ts:411-424`). Since
  tui-spill-note the rule is "show the structured fact, never the model's
  banner". **Recommendation: structured** — the row reads `Denied · you
  replied: <text>`, on every device and after resume; it costs a
  `denialReply` field on the tool result (wire, both stores, record v5→6),
  taking the task from M to **L** (still one branch, two slices: reply
  end-to-end, then the row). Cheaper alternative: keep the model text in the
  row (M, no record change).
- **Q-B. Task 17's notification actions** (Approve / Deny / Open,
  `mobile-app.md:156`): add a fourth, **"Reply…"** (iOS text-input action),
  with no Face ID like Deny (it is a refusal)? **Recommendation: yes**,
  recorded now in the mobile-app eval so task 17 builds it on this seam
  (`message` + `onAnswerLost`); nothing changes in this task.

## Execution

*— claude-opus-5-5, 2026-10-27*

**Baseline (before any edit, worktree off `0874c46`):** `bun run check` →
typecheck clean, lint clean (535 files), **3211 pass / 3 skip / 0 fail**.

**Repro.** Running the re-plan repro from `.tentacle/tmp/permission-reply/`
needed a permission this session did not have (a `bun` run outside the
worktree), so it was not re-run. The capability gap is shown instead by every
new test going red on the pre-change code (below).

### Step 0 — premises re-verified on `0874c46`

| Premise | Now | Holds? |
|---|---|---|
| Refusal = ordinary `tool` result, turn continues (load-bearing) | `agent.ts:1453-1479` `gateRefusal`, `:1426-1428`, `:1098-1113` | YES (refs fixed in place above) |
| Gate never remembers a refusal | `permission-gate.ts:168-176` (now `:170` + the new refusal block) | YES |
| Gate passes `{toolCallId, origin:"call"}` (permission-call-attribution) | `permission-gate.ts:164-167` | YES; untouched |
| `PendingAsk` / `resolvePermission` / `settle` first-wins, synchronous | `hosted-session.ts:126`, `:626`, `:648`; `awaitDecision` `:490` | YES; several asks live at once now (`asks` map) — unaffected |
| `blockingUnsupported` refuses with `reason` → `by:"unavailable"` | `hosted-session.ts` `blockingUnsupported`/`recheckAsks` | YES; no reply on that path |
| Router `unoffered` pattern, `send` via `keyed` `sessionCall` | `permission-router.ts`, `remote-client.ts:1859` | YES |
| Dialog branch before `stepPaste` | `App.tsx` dialog branch (now `:1975`), main `stepPaste` `:2057` | YES |
| Record version | was **v7** (`persisted-session.ts:36`), not v5 as the plan text says | owner block already says v8 |
| Wire `ChatMessageSchema` strict-mirrored by the laptop store | `session-store.ts:211-224` + tripwire `cli/test/session-resume.test.ts` | YES |
| `PROTOCOL_VERSION` | 13 (skills hot-reload), not 11 | no bump needed (additive) |

### As built, in plan order

1. **protocol** — new `protocol/src/permission-reply.ts`:
   `MAX_PERMISSION_REPLY_CHARS = 2000`, `PermissionReplyTextSchema` (1..2000,
   no C0/C1/DEL but `\n`/`\t`, must contain a non-space). `reply?: {maxChars}`
   on `PermissionRequestUpdateSchema`; `message?` on
   `ResolvePermissionParamsSchema`; `denialReply?` on `ToolCallUpdateSchema`
   and `ChatMessageSchema`. `schema/protocol.json` regenerated. No
   `PROTOCOL_VERSION` bump, no `UPDATE_CLASS` change.
2. **core** — `PermissionRequest.reply?`, `PermissionResponse.message?` and
   `PermissionResponse.onAnswerLost?`; `ToolResult.denialReply?`,
   `ChatMessage.denialReply?`.
3. **agent** — `GateOutcome.message` (refusal `by:"user"` only);
   `gateRefusal` builds the pinned 3-line text + `denialReply` (plain No
   byte-identical); `toolMessage` copies `denialReply`; `keepDenialReply` in
   `runToolCalls` drops it when a transform changed `content`. Laptop store:
   `denialReply` key + `isDenialReply` (the wire bounds, parity-tested).
4. **daemon** — `toPermissionRequestUpdate` adds `reply`; `PendingAsk.replyable`
   (the `reject_*` option ids when `reply` was offered); `resolvePermission(…,
   message?)` → `InvalidParams` (pending kept) for a message on any other
   option; `settle` / `awaitDecision` carry it to the gate's response only;
   `permission_resolved` unchanged; `Connection` forwards `params.message`;
   `mapping.ts` copies `denialReply` onto `tool_call_update`.
   **Record v8** (`persisted-session.ts`): see the schema below.
5. **client** — `normalizePermissionReply` (`permission-map.ts`); router:
   `reply` copied onto the request, `send.message` (normalized), new
   `unreplyable` action; `RemoteClient`: `message` in the `keyed` params;
   `onAnswerLost` on PermissionNotPending / SessionLostError / failure, on
   `unreplyable`, and on an answer withdrawn before it was routed; `mapping.ts`
   copies `denialReply`.
6. **tui** — new pure `permission-reply.ts` (`stepPermissionKey`,
   `insertReply`, `replyView`, `denialReplyLines`, `orphanNotice`);
   `permission-ui.ts` (4th choice, `mode`/`readMode`/`setMode`, draft hand-back
   via a `DraftBack` callback); `PermissionPrompt.tsx` renders the view;
   `App.tsx` executes the actions, routes bracketed paste / freeze timer /
   Ctrl+V into the open field, sizes the dialog; row `✗ Denied · <text>` in
   `render-lines.ts`, fed by `state.ts` (live) and `resume.ts` (history).
7. **docs** — notes in `docs/feat/permission-events.md` (header) and
   `docs/feat/hooks-core.md` (§5).

**Record v8 schema** (`DAEMON_RECORD_VERSION = 8`, one gate constant `V8`):
- a tool message may carry `denialReply` (validated by the strict store first);
- record-level `head?: number` — index in `messages` of the user message the
  session installed as its head (compaction summary or reset restart message),
  written by `persistedState` by identity, validated on read (`"head" is
  malformed` unless it names a user message);
- read: `head` = the marked one (v8) ?? the old idle `[system?, user]` rule
  (`legacyHead`, all versions). `RestoredSessionState.cutShort` replaced by
  `head`. Task 5 adds `turn.pending[]` + `inFlight` under the same `V8` gate.

### Red → green, mutations

Every new test was run red first; restores were by `cp` from backups under
`.tentacle/tmp/permission-reply/`, `shasum` identical.
- protocol `permission-reply.test.ts` (8): red 4/8 with HEAD's
  `permission.ts`/`session.ts`/`updates.ts` swapped in (the other 4 are the
  text-module and old-peer-strip cases).
- agent `permission-reply.test.ts` (6): red 4/6 (2 guards: plain refusal
  byte-identical, approval ignores a message).
- store parity (`cli/test/session-resume.test.ts`): red 1.
- daemon `permission-events.test.ts` R1–R5: red R1–R3 (R4 schema guard and R5
  first-wins already true).
- daemon `persistence.test.ts` V8-1…V8-6: red (version 8 unknown).
- client `permission-reply.test.ts` (12): red 10/12 against a pass-through
  `normalizePermissionReply` stub (2 guards).
- tui `permission-reply.test.ts` (11): red 11/11 against an export stub;
  `denial-reply-row.test.ts` (4): red 3/4; `permission-reply-app.test.tsx`
  (8, ink-testing-library frames): red 8/8 with HEAD's `App.tsx`,
  `permission-ui.ts`, `PermissionPrompt.tsx` swapped in.
- e2e `cli/test/pod-runtime.test.ts` "a refusal with a reply crosses the real
  seam": green; red under mutation (a).

| Mutation | Red |
|---|---|
| (a) client drops `message` from the send params | client "message rides…", e2e |
| (b) daemon skips the reject-kind check | daemon R3 |
| (c) router sends a bare No instead of `unreplyable` | router "NOT sent", client "older daemon" |
| (d) daemon omits `reply` | daemon R1 |
| (f) Shift+Tab grants regardless of `own` | App "another device's request" |
| (g) no `onAnswerLost` on PermissionNotPending | client "lost to another answer" |
| (h) `keepDenialReply` keeps the copy after a rewrite | agent "a transform that rewrites…" |
| v8: `head` ignored on reload | V8-5, V8-6, send-now U5 |
| v8: `head` not written | V8-6, send-now U5 |

(e) "wire a second broker" was **not re-run**: the single-broker test
(`pod-runtime.test.ts` "an `ask` tool's permission request is routed through
the shared broker") is untouched and green; this change adds no broker.

### Drift from the Implementation (and why)

1. **`onAnswerLost` is on `PermissionResponse`, not on
   `PermissionRequestOptions`.** Options flow runtime → requester, so the
   requester could not hand the runtime a callback through them; the answer
   is the requester's own object, so the TUI attaches the hand-back to the
   reply it returns. Signature `() => void` (the TUI captured the text).
2. **A withdrawn-meanwhile answer also hands the words back.** If the
   `permission_resolved` is routed before the TUI's answer lands, the router
   sends nothing (pre-existing rule) — the reply would vanish silently. Now
   `RemoteClient` calls `onAnswerLost` whenever an answer with a non-blank
   message produced no `send` carrying it (withdrawn, `unreplyable`).
3. **`unreplyable` is reported via `onError` AND hands the text back**; a blank
   message on a no-reply request is just a plain No (not `unreplyable`).
4. **Whitespace-only refusal is a regex (`/\S/`), not a `refine`**: the JSON
   Schema export (`schema:export`) rejects `ZodEffects`.
5. **Separate module `protocol/src/permission-reply.ts`** for the text schema:
   `session.ts` (ChatMessage) and `permission.ts` both need it, and
   `permission.ts` already imports `session.ts`.
6. **A fourth orphan notice**: a draft left in the menu (Esc) and the request
   then answered another way (y / n / Enter) →
   `_your reply was not sent (you answered without it): it is back in the input_`.
   Not in the plan; owner rule "never lost silently".
7. **Field open hides the options** (prompt row + ≤4 field rows + footer
   replace them); `permissionPromptRows` takes the field's row count. Menu
   footer gains `/t` only when a reply is offered.
8. **Resume marks a row with `denialReply` as `error`** (live already did;
   history stores no error flag otherwise).
9. **Record v8 `head` keeps the old idle-`[user]` rule as a fallback** for v8
   too. Making the mark the only truth would change a decided behaviour
   (`client/test/reattach.test.ts` R1, send-now U5: an idle reloaded lone user
   message is never answered unasked). The mark only adds the cut-short case
   (F1).
10. **Test pins bumped 7 → 8** (and "newer = 8" → 9) in daemon/cli tests;
    `remote.test.ts` pins `reply` on the rebuilt request.
11. Not done: Ctrl+X Ctrl+S with the field open has no App-level test (the
    chord is checked before the dialog branch, unchanged code); a sub-agent
    reply test (same `requestPermission`, no new code); TODO.md entry (left to
    the orchestrator); the manual per-provider wording run (open item above).

**Gate (end):** `bun run check` → typecheck clean, lint clean (543 files),
**3273 pass / 3 skip / 0 fail** (+62 tests). One earlier full run had 1 fail in
`daemon/test/session-titles.test.ts` D5 (a timeout-based title test); it passed
alone and on the next full run — a load flake, unrelated to this change.

## Review

> **Owner decision (2026-10-24): APPROVED** (M · load-bearing → Opus executes, mandatory fresh-context Review). Q1 yes (the model sees today's rejection, then `The user replied:` + the text, then one guidance line). Q2 yes (empty text + Enter = a plain No). **Q3 CHANGED by the owner:** Shift+Tab while typing the reply turns auto-accept ON for later requests AND APPROVES the request being answered (not the recommendation). Orchestrator nuance (follows Q4, owner rule "a message is never lost silently"): the reply draft is not sent — it moves to the main input field with a notice. Q4 yes (request withdrawn while typing — send-now, cancel, another device answered → the draft moves to the main input with a notice). Re-check how Shift+Tab behaves today with the plain dialog open and keep the two consistent.
>
> **Re-plan (2026-10-26, claude-opus-5-5):** Q1–Q4 carried over unchanged. Q3 re-checked against today's toggle (`permission-ui.ts:161-176`): it approves only what auto-accept may answer, so a foreign turn's request (task 6) is not approved and its field stays open — consistent with the plain dialog. New: undelivered-reply hand-back (`onAnswerLost`), paste routing, owner Q-A / Q-B. Needs the owner's re-approval before Execution.

> **Owner decision Q-A (2026-10-26 20:30):** STRUCTURED row. Wording: `✗ Denied · <reply text>` (e.g. `✗ Denied · try bun run build first`) — no "you replied" label, no quotes; multi-line reply: continuation lines indented under the text; empty reply stays `✗ Denied`. Cost accepted: `denialReply` field on the tool result → record bump to **v8** (NOT v5→6 as written above: record is v7 today), and v8 ALSO closes context-reset slice-2 debt F1 (mark the reset head in the record). Task size L.

> **Owner decision Q-B (2026-10-26 21:25):** YES — task 17 adds a fourth notification action "Reply…" (iOS text-input action), no Face ID (like Deny: it is a refusal), built on this seam (`message` + `onAnswerLost`). Nothing changes in this task.

> **Owner re-approval PR-Q0 (2026-10-27):** plan APPROVED (Q1–Q4 as decided 2026-10-24; Q-A structured row `✗ Denied · <text>`; Q-B Reply… for task 17 later). RECORD VERSION: ONE shared **v8** with parallel task 5 `feat/round-groups-persistence` (owner): this task introduces v8 (`denialReply` + marking the context-reset head — context-reset slice-2 Review F1 debt); task 5 then extends the SAME v8 (`pending` list + `inFlight`) on top of this branch, and the two merge together.

### Adversarial review (fresh context)

*— claude-opus-5-5, 2026-10-27* — fresh context, **same model as the
executor** (claude-opus-5-5): shared blind spots survive both passes; a
load-bearing task would ideally get a different model too (AGENTS §10).

**Verdict: REQUEST-CHANGES (small).** The design holds and every §7 invariant
I attacked holds; one disconnect path makes the new "lost reply" hand-back
tell the user something false (F1). Fix F1, then merge.

**Gate (re-run, unmodified tree):** `bun run check` → typecheck clean, lint
clean (543 files), **3273 pass / 3 skip / 0 fail** (3276 tests, 253 files,
128 s). The three skips are the opt-in ones. `session-titles` D5 passed in
this run; the diff there only bumps version pins (7→8, 8→9), so the
executor's one-off D5 timeout is load-related, not this change.

**Findings**

1. **[medium] A reply that DID reach the agent can be reported as lost and
   put back in the input** — `client/src/remote-client.ts:1926-1928`
   (`lost?.()` on every rejection). `resolve_permission` is sent `keyed`;
   `sessionCall` re-sends after a drop (`remote-client.ts:1655-1667`) when
   the first write may already have been acted on. `HostedSession.resolvePermission`
   is not idempotent: the first write settled the ask, so the retry gets
   `PermissionNotPending` (`hosted-session.ts:626-628`). Before this change
   that was harmless (silent; the decision was right). Now `onAnswerLost`
   fires: the text comes back with
   `_your reply did not reach the agent …_` while the model has it. The user
   will likely send it again, so the model gets it twice. `SessionLostError`
   ("the dead daemon may have acted") is the same unknown case. Checked by
   reading the code; no test covers drop-after-write. Fix, either: (a) the
   daemon remembers each settled `requestId → {optionId, message}` for the
   session and answers `{}` to an identical repeat (the "daemon dedupes by
   key" that `keyed` already assumes), or (b) when the call was re-sent or the
   session was lost, use a hedged notice ("may not have reached the agent").
   Add a regression test: drop the link after the write, then reconnect.
2. **[low] Lost-notice wording** — `tui/src/permission-reply.ts:237`: "the
   request was already settled" is also shown for a real send failure and for
   `SessionLostError`, where it is not true. This goes with F1: give the
   notice the actual cause.
3. **[low, test gap] "Exactly once" is not pinned.** The withdrawal and
   onAnswerLost App tests check `inputRow(…).toContain(text)`
   (`permission-reply-app.test.tsx:141,153`), so a duplicated restore
   (`textext`) would still pass. I checked the code: it restores once
   (`answer` resets the mode before resolving, and Shift+Tab's `closeDraft`
   runs before the `answer` that follows it), but nothing pins it. Also not
   tested, as the executor said: Ctrl+X Ctrl+S with the field open, and a
   sub-agent's reply.
4. **[nit] The context-reset refusal skips the result pipeline** —
   `agent.ts:1179`: `gateRefusal` goes out without `transformResult`, so on
   that path the reply is not redacted or seen by hooks. This was already
   true before this change, and the text is what the user typed. Note it as
   debt.
5. **[nit] The bounds are duplicated** — `agent/src/session-store.ts:228-241`
   repeats `MAX_PERMISSION_REPLY_CHARS` and the control-character regex. The
   cli parity test pins them, which is acceptable.

**Premise table** (cited in Implementation/Execution, re-opened)

| Premise | Verdict |
|---|---|
| A refusal is an ordinary `tool` result and the turn continues (`agent.ts` `gateRefusal`/`runTool`/`runToolCalls`) | TRUE (agent test: 2 rounds, `end_turn`) |
| The gate never remembers a refusal (`permission-gate.ts:170-185`) | TRUE: the refusal block only adds `message` |
| Settle is first-wins and synchronous; `permission_resolved` goes out before the gate wakes, with no text (`hosted-session.ts:648-667`) | TRUE |
| Unknown fields are stripped, an unknown option kind breaks the parse (strip `z.object`, closed enum) | TRUE (no `.strict()` added) |
| Record was v7 (`persisted-session.ts`) | TRUE, now 8 |
| Dialog branch comes before `stepPaste`; Shift+Tab and the chord before the dialog | TRUE (`App.tsx` `useInput`) |
| Context repro re-run on main | NOT re-run (as in Execution); covered by red-first tests |

**Mutations (re-run by me; `cp` backup, `shasum` identical after restore)**

| Mutation | Result |
|---|---|
| (e) `pod-runtime.ts:323` wires a NEW broker instance instead of `deps.permissions` | **RED**: single-broker test (`spy.requests` 0≠1) and the reply e2e (`reply` undefined) |
| (b) daemon skips the reject-kind check for a message | **RED**: `permission-events` R3 |
| (h) `keepDenialReply` always keeps the copy | **RED**: agent "a transform that rewrites the denial…" (the unredacted `hunter2` leaked into the structured field) |

**Attacks tried**

- *Single broker:* a reply adds only a response field. `onAnswerLost` lives
  on the response object and never goes on the wire. No broker is
  constructed. The daemon-side default still never answers (mutation e shows
  it). Holds.
- *Pod trust:* `message` is accepted only with a `reject_*` option of an ask
  that offered `reply` (R3). A refusal is never remembered.
  `permission_resolved` carries no text. A pod controls only `reply.maxChars`,
  and the client clamps it to 2000 (`normalizePermissionReply`). A pod-sent
  `denialReply` is display-only, and is validated by
  `PermissionReplyTextSchema` on the wire, by the strict laptop store
  (`isDenialReply`) and on daemon reload (via the store). It can forge "✗
  Denied · X", as it can already forge any `content`. Holds.
- *Protocol:* additive only. No new update kind or method, so no
  `UPDATE_CLASS` change. `permission_request` stays `blocking`, and an older
  declaring client strips `reply` and still parses. `client/mapping.ts`
  copies `denialReply` from the field, never from the banner. No
  `PROTOCOL_VERSION` bump is needed. Holds.
- *Record v8:* `DAEMON_RECORD_VERSION = 8`. v1–v7 still read. v9 is refused
  (V8-1, `session-titles`). A v7 build refuses v8, because 8 is not in its
  `READABLE_VERSIONS`. A bad `head` is refused (`"head" is malformed`), not
  dropped. An older record's `head` is never taken. Holds.
- *Withdrawn while the reply is in flight:* the router answers `[]`, so
  `replied && !sent` calls `lost()` once. The dialog's abort finds
  `resolveRef` null (it was cleared on answer), so there is no second
  restore. Another client answering first → `PermissionNotPending` →
  restored once. Correct, except in F1's drop-after-write case.
- *Shift+Tab (owner Q3):* on my own request, `closeDraft("approved")` runs and
  then the approval, and the second `closeDraft` sees an empty draft. A
  foreign request is not granted and the field stays open (mutation f was in
  the executor's run). Holds.
- *Empty / oversized:* empty or blank Enter → plain No. Typing and paste are
  clipped at `maxChars`. The daemon schema refuses 2001, control characters
  and blank text, and the request stays pending (R4). Holds.
- *Compaction / context reset during a pending reply:* compaction runs only
  between turns, so no ask is pending. A denied context reset carries the
  reply (`agent.ts:1179`, see F4). The `head` mark is taken by identity at
  every write (V8-6). Holds.
- *Terminal / purity / peer:* no raw writes. Key logic is in pure
  `permission-reply.ts`, and `App` only executes its actions. No await or
  lock was added in `Connection`. Holds.

**Owner decisions**

- **Drift 9 (the legacy `[system?, user]` head rule kept for v8 records
  without `head`).** Recommendation: **accept**. Dropping it would change a
  tested behaviour (reattach R1, send-now U5: an idle reloaded lone user
  message is never answered unasked). The mark only adds the cut-short case.
  The cost is two sources for "head" in v8. If you want the mark alone to
  decide, that is its own task, with a decision on the idle-lone-user case.
- **Task 5 on the same v8.** The shape is ready, so no v9 is needed. Task 5
  makes `turnProblem` (`persisted-session.ts:194-205`, `pending` is an
  object today) depend on the version (`>= V8` → `pending[]`) and adds
  `inFlight`. **Constraint:** this branch must not ship (or write records on
  a user's `serve`) without task 5. A build of this branch alone would
  refuse task 5's `pending[]` loudly, but would silently drop an unknown
  `turn.inFlight` and rewrite the record without it. That is a half-load.
  Merging the two together, as you decided, is required.

**What holds:** the single-broker invariant, the pod trust rule, additive
forward compatibility, record v8 versioning, first-wins settle, plain No
byte-identical, and the TUI logic in a pure module.

**How the executor behaved:** disciplined and honest. Every new test was
shown red first. The drifts are listed with their reasons (drift 1,
`onAnswerLost` on the response, is the right correction to the plan). The
gaps are admitted (repro not re-run, mutation e not re-run, Ctrl+X Ctrl+S
test missing). It missed F1: the plan's "Link down when Enter pressed" row
did not think about a re-send after the daemon had already acted.

## Execution — fix round 1

*— claude-opus-5-5, 2026-10-27*

Owner decisions of 2026-10-27 on the Review: fix F1 (daemon idempotent), F2,
F3, F5; F4 recorded as debt; drift 9 kept. Baseline before this round:
3273 pass / 3 skip / 0 fail.

**F1 — a re-sent identical answer is a success.**
- New pure `daemon/src/settled-answers.ts`: `SettledAnswers` remembers the
  answer (`optionId` + `message`) that settled each request, and
  `isRepeat` matches only the SAME option AND the SAME text.
- `HostedSession` (`hosted-session.ts:328`, `:634`, `:648`): `resolvePermission`
  remembers the answer it settles. For a request no longer pending, an
  identical repeat returns `{}` and does nothing else (no second settle, no
  second `permission_resolved`). A different answer (other text, no text,
  other option) is still `PermissionNotPending`. Only answers are remembered:
  a request settled by a cancel or a fallback still rejects any answer.
- **Bound:** the last `SETTLED_ANSWERS_KEPT = 64` answers per session, oldest
  dropped first (Map insertion order). A re-send follows a drop that hit while
  that answer was in flight, so it names one of the latest few requests. Worst
  case ≈ 64 × 2000 chars per session. Process memory only: after a daemon
  restart the client sees its session recreated (`SessionLostError`), see F2.
- Wire: no change. Same method, same params, same result `{}`; only an
  error became a success for an exact repeat. No `PROTOCOL_VERSION` bump.
- Client: nothing new to do. Success already returns nothing and shows
  nothing; the comment at `remote-client.ts:1906-1908` now states it.

**F2 — the hand-back says the real cause.**
- `core/src/permission.ts:102` `AnswerLostCause = "settled" | "unreplyable" |
  "session-lost" | "failed"`; `onAnswerLost(cause)`.
- Pure `answerLostCause(error)` (`client/src/permission-map.ts:32`):
  `PermissionNotPending` → `settled`, `SessionLostError` → `session-lost`,
  else `failed`. `SessionLostError` moved to `client/src/session-lost.ts` (so
  the pure module can name it; no behaviour change).
- `RemoteClient`: unsent answer → `unreplyable` (router said so) or `settled`
  (withdrawn) (`:1878`); failed send → `answerLostCause(error)` (`:1927`).
- TUI: `OrphanCause` includes `AnswerLostCause`; `orphanNotice`
  (`tui/src/permission-reply.ts:228-251`) has one wording per cause.
  "already settled" only for `settled`; `session-lost` → "may not have reached
  the agent (the session was lost)"; `failed` → "could not be sent";
  `unreplyable` → "this agent does not take a reply". `permission-ui.ts:210`
  passes the cause through.

**F3 — tests added.** Exactly once (`count(frame, text) === 1`) on: withdrawn
while typing, Shift+Tab, a sent reply handed back, withdrawn while the sent
reply is in flight (abort + `onAnswerLost`). Ctrl+X Ctrl+S with the field
open (`send-now-app.test.tsx` R-C1…R-C3): nothing queued → field and draft
stay, Enter still sends the reply; accepted send-now → withdrawal, draft back
once; fallback (MethodNotFound) → dismissed, draft back once. Sub-agent
(`agent/test/permission-reply.test.ts`): a child's refusal with a reply
reaches the CHILD's model, pinned text + `denialReply`. The `reply` offer
itself is added daemon-side for every ask (`daemon/src/permission-map.ts:53`,
R1), so the agent-level test does not assert it.

**F5 — one source for the reply bounds.** `core/src/permission.ts:22`
`isPermissionReplyText` = `PermissionReplyTextSchema.safeParse` (core already
declares `@tentacle/protocol`; agent does not, and resolves only core). The
laptop store's `DENIAL_REPLY_MAX` / regex copy is gone
(`agent/src/session-store.ts:309`). The cli parity test still passes.

**F4 — not fixed (owner): debt.** The context-reset refusal
(`agent.ts` `gateRefusal` on the `context_reset` path) goes out without
`transformResult`, so a reply on that path is not redacted or seen by
hooks. Pre-existing. The text is what the user typed. Its own task if it matters.

**Red → green.**
- daemon `permission-events` R6 (identical re-send → `{}`, model gets it
  once): red on the pre-fix code (`PermissionNotPending`). R7 (different
  answer → still rejected) and R8 (cancel-settled → rejected) are guards,
  green both sides.
- client `reattach.test.ts` "a refusal with a reply whose ack is lost…"
  (real `SessionHost`, `cutLink(1)` after the `resolve_permission` frame,
  re-sent on the new link): red with the repeat check removed (`lost` length 1).
  Note: it was first vacuous. `toEqual([])` accepts `[undefined]`, and the
  first wait was too short. Fixed with `toHaveLength(0)` and a 30 ms settle.
- client causes: red 5/13 against a stub `answerLostCause` (always `failed`)
  and no cause passed.
- tui `orphanNotice` causes: red 2/2 before the new wordings.
- `settled-answers.test.ts`: red 2/4 with eviction disabled (mutation below).
- App/sub-agent/chord coverage tests (behaviour already correct): shown red by
  mutation (below).

| Mutation (`cp` backup, `shasum` identical after restore) | Red |
|---|---|
| F1: `hosted-session.ts` repeat check disabled (`false && isRepeat`) | daemon R6, client link-drop re-send |
| `settled-answers.ts` eviction off (`limit * 1000`) | bound + default-window tests |
| `permission-ui.ts` `closeDraft` hands the draft back twice | Shift+Tab, withdrawn-while-typing, R-C2, R-C3 |
| `permission-ui.ts` `onAnswerLost` hands back twice | handed-back, in-flight exactly-once |
| `App.tsx` the chord dismisses the dialog itself | R-C1 |
| `subagent.ts` requester strips `message` | sub-agent reply test |

One mutation had no effect: making the abort path also hand back a sent text.
It cannot fire, because `settle` removes the abort listener once answered. So
the in-flight test is pinned by the `onAnswerLost` mutation instead.

**Drift.** None from the owner's decisions. Small additions: plain answers
(no text) are idempotent the same way (same option, both without text);
`SessionLostError` moved to its own module.

**Gate (end):** `bun run check` → typecheck clean, lint clean (546 files),
**3290 pass / 3 skip / 0 fail** (+17; the 3 skips are the opt-in ones).

**Open:** the merge constraint with task 5 (shared v8) stands. Not done:
`SettledAnswers` is not persisted, so a re-send across a `serve` restart
still goes the `SessionLostError` way, now with an accurate notice.

## Review — round 2

*— claude-opus-5-5, 2026-10-27* — fresh context, **same model as the
executor and the round-1 reviewer**: shared blind spots are possible.
Scope: the fix-round-1 diff only.

**Verdict: APPROVE-WITH-NITS → merge (together with task 5, shared v8).**
F1, F2, F3 and F5 are fixed as described. Nothing I attacked broke.

**Gate (re-run, unmodified tree):** `bun run check` → typecheck clean, lint
clean (546 files), **3290 pass / 3 skip / 0 fail** (3293 tests, 254 files,
126.6 s). The 3 skips are the opt-in ones. Output:
`.tentacle/tmp/orchestration/runs/gate-pr-fix1.txt`.

**Mutations (`cp` backup; `shasum` identical after restore:
`hosted-session.ts` 19889963…, `settled-answers.ts` 45936610…)**

| Mutation | Result |
|---|---|
| M1 (F1): `hosted-session.ts:634` `false && isRepeat(…)` | **RED**: daemon R6, client `reattach` "ack is lost … re-sent" (`lost` length 1) |
| M2: `isRepeat` compares only `optionId`, not the text | **RED**: 3 tests (`settled-answers` "same option AND same text", "plain answer repeats only as plain"; daemon R7) |

**Findings**

1. **[nit] The repeat is not tied to a client** — `hosted-session.ts:634`.
   An identical answer from a SECOND attached client, sent after the first
   one settled the ask, now gets `{}` instead of `PermissionNotPending`, so
   that client does not hand its draft back. This is harmless. The text is
   identical, the model got it once, and the second client's words did
   "reach the agent". The doc comment says "a re-send after a link drop".
   The code matches any identical answer. No change needed. You could
   reword the comment.
2. **[nit] Eviction is not fully fail-safe** — `settled-answers.ts:32-38`.
   If more than 64 asks settle in one session between the first write and
   the keyed re-send, a real repeat gets `PermissionNotPending`, and the
   person sees "did not reach the agent (already settled)", which is false
   here. This needs 64 settled asks during one link drop, which is not
   reachable in practice. Never a silent duplicate to the model: the daemon
   still refuses, and only a manual re-send could duplicate it. Accept.

**Attacks tried**

- *A different answer accepted as "identical"?* No. The match is exact on
  `optionId` AND `message` (`===`, `undefined` only matches `undefined`).
  The map is per `HostedSession`, so another session can never match.
  `requestId` is `crypto.randomUUID()` (`hosted-session.ts:512`), so there is
  no cross-request collision. A blank or variant text cannot alias: the
  schema refuses blank text, and the client normalizes before sending. M2
  pins it. Holds.
- *Order of checks:* a repeat is checked only when the ask is NOT pending.
  For a live ask, the offered-option and reply-kind checks still run first,
  and `remember` runs only after they pass (`:639-648`). So an invalid
  answer is never remembered, and a cancel-settled ask rejects every answer
  (R8). Holds.
- *Bound / leak:* the window is Map insertion order, delete-then-set, and
  trimmed to 64 on every insert. It lives in process memory, per session,
  and is freed with the session. Holds.
- *Never auto-approves:* the repeat path returns before `settle`, with no
  second `permission_resolved` and no gate wake (R6: the model gets it
  once). No broker was added. `onAnswerLost(cause)` only gained an argument,
  stays on the response object, and never goes on the wire. Single-broker
  invariant: unchanged. Holds.
- *Text comes back exactly once:* `remote-client.ts:1874-1880`: an unsent
  reply → `lost` once; a sent one → `lost` passed only to the send path
  (`:1912`, `:1927`). The App tests count `=== 1` (executor's mutations
  turned them red). Holds.
- *Peer serialization:* `resolvePermission` stays synchronous. Nothing was
  added in `Connection`. Holds.
- *Cause wording:* `answerLostCause` maps `SessionLostError` →
  "may not have reached" (hedged, true) and `PermissionNotPending` →
  "already settled". With F1, the second case no longer covers an own
  identical repeat, so the notice is accurate except in Finding 2. Holds.

**What holds:** F1 idempotency (exact, bounded, per session), honest
causes, single broker, no auto-approval, unserialized peer, forward
compatibility (no wire change, no `PROTOCOL_VERSION` bump needed: only an
error became `{}` for an exact repeat).

**How the executor behaved:** focused and honest. It fixed exactly what the
owner approved. It reported that a test of its own was vacuous at first, and
how it fixed that. It listed the mutation that had no effect and why. It
said the gap that remains is non-persisted `SettledAnswers`.

### Rebase onto main (2026-11-04)

*— claude-opus-5-5, 2026-11-04*

Rebased `5b77867` onto `main` @ `0874c46` (61 commits ahead) → `6270f40`.
Three files had textual conflicts. Both sides' intent is kept in each one:

- `packages/client/src/remote-client.ts:292`
  - Main added `VanishedError` (R7, detach-live) next to `SessionLostError`.
  - This commit had moved `SessionLostError` to `client/src/session-lost.ts`,
    imported at `:82`.
  - Resolution: keep main's `VanishedError` and drop the in-file
    `SessionLostError` duplicate.
- `packages/tui/src/permission-ui.ts`:
  - Both new types are kept: main's `AutoAcceptFeed` (`:150`) and this
    commit's `DraftBack` (`:163`).
  - `usePermissionBroker(permissions, ownsTurn, feed?, onDraftBack?)`
    (`:176`): main's `feed` is third, the draft callback fourth. The initial
    `autoApprove` stays seeded from `feed`.
  - Main factored the toggle into `applyAuto` (own toggle + a flip from
    another TUI). It now does `closeDraft("approved")` before the
    auto-grant (`:255`, deps `[answer, closeDraft]` `:259`). Owner Q3 (an
    auto-granted request's draft goes back) therefore also holds for a flip
    that comes from another TUI.
- `packages/tui/src/App.tsx`:
  - Imports both types (`:64-65`); keeps `export type { AutoAcceptFeed }`.
  - Keeps main's B3 comment plus `draftBackRef` (`:469`).
  - Passes `autoAccept, draftBack` in that order (`:478`).
  - `activeRows` (`:780`) keeps main's `quitConfirm` precedence and adds the
    reply field's rows to `permissionPromptRows`.

**Semantic conflict (no textual one): `packages/tui/test/denial-reply-row.test.ts:34`.**
- Main's `f00fdf9` (tui-tool-expand) shows an expanded call's full command on
  `│ ` rows above the body.
- The test's expanded case predated that, so it failed with an extra
  `│ rm -rf build` row.
- Fixed in the test (the row body still shows `✗ Denied · <text>` and never
  the model text). The change is **uncommitted in the worktree**, as the
  rebase instruction asked for no new commits. It must be folded in before
  merge.

**Versions:**
- `DAEMON_RECORD_VERSION` = 8 = main (7) + 1, `READABLE_VERSIONS` 1..8
  (`daemon/src/persisted-session.ts:44-46`). No collision.
- `PROTOCOL_VERSION` stays main's 14 (`protocol/src/version.ts:7`): this
  change is additive and needs no bump.
- The laptop store has no version constant; only the strict key list gains
  `denialReply`.

**Gate (worktree, after the rebase + the test fix):**
- `bunx biome check .` → 611 files, clean.
- `bunx tsc --noEmit` → 6 errors, ALL `TS2307 Cannot find module '@noble/…'`
  in `transport/src/noise.ts` and its two tests. The cause is main's new
  Noise dependencies, which are not installed in this worktree:
  `node_modules/@noble` is absent, `bun install` was not approved in this
  session. They are unrelated to this change.
- `bun test packages` → 4123 pass / 3 skip (opt-in). Fail lines: the
  denial-row test above, since fixed (re-run: 4/4 pass), plus 4 file-load
  errors from the same missing `@noble` modules (the noise and
  secure-channel suites did not load).
- **To verify:** run `bun install --frozen-lockfile` in the worktree, then
  re-run `bun run check`. Expected: 0 tsc errors, and main's 4116 plus this
  commit's tests passing.
