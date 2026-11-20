# feat/caps-before-first-message — `/mcp`, `/skills`, `/tools` switches before the first message

> **Status:** execution done — awaiting the fresh-context Review
> **Branch:** `feat/caps-before-first-message`
> **Size:** M (S1 client M · S2 TUI S) · **Blast:** cross-module (client + cli + tui; no protocol, no daemon, no persisted format) · **Suited:** Opus plan, DeepSeek exec, Opus fresh-context review (Q5)
> **Changelog:** `changelog.d/caps-before-first-message.changed.md`: "**Switches work before the first message.** In a new or resumed session, `/mcp`, `/skills` and `/tools` can switch servers, skills and tools on or off before anything is sent. The switches apply from the first message, so the first model call already runs without them."

Type: feat · Size: M · Blast: cross-module · Suited: Opus plan + DeepSeek exec + Opus fresh-context review

(The TODO row says S–M. It is M here: one new pure module and the first-send path in `client`, a one-line save guard in `cli`, and a phase flag plus one failure branch in `tui`.)

## Context

*— claude-opus-5-5, 2026-11-20*

**Problem.** In a fresh session, or one resumed from the laptop's copy, `/mcp`, `/skills` and `/tools` cannot switch anything until a message has been sent. The panels say "on/off after the first message", and Space answers "send a first message, then try again" (`packages/tui/src/capability-toggles.ts:45-51`, `:69`, `:184-191`, `:212-221`). The reason: the session is opened daemon-side only by its first message (`RemoteSession.createOrAttach`, `packages/client/src/remote-session.ts:583-616`, awaited by `runTurn` at `:1610`). Before that there is nothing on the daemon to switch. So the first model call, the one that matters most on a small local model, always runs with everything on.

**Owner intent** (TODO.md row `feat/caps-before-first-message`; option 2 on 2026-11-19; on 2026-11-20 extended to `/tools`, with ONE mechanism for the three lists):
- Keep the lazy open.
- The client remembers the switches flipped before the open, and shows them as live switches ("applies from the first message").
- At the first message it opens the session, sends the switches through the existing set call, and sends the prompt only after the ack. The first model call then already runs without them.
- No protocol change.
- Failure modes: a pending name that no longer exists at open gets one honest line, never a silent drop. A failed set means the prompt does not go out as if it had been applied.
- Mac, `connect` and pods alike.

**Constraint from feat/tool-toggles** (merged today, `docs/feat/tool-toggles.md`):
- `/tools` uses the same set call (`session/set_capability{kind:"tool"}`) and the same client phase (`capsPhase`) as `/mcp` and `/skills` (tool-toggles Context, "Constraint from the next task"; D7).
- Owner Q4: the config's `tools.enabled` applies to every session CREATED under it (a new session, a laptop-copy resume, a `/clear` fork, a hop), unioned with the session's carried switches. `/tools` can switch a config-off tool back on for that session.
- tool-toggles' review left one note for this task: before the first message, the no-session `session/tools` on a pod ignores the laptop's seed, so the list can show tools as on that the create will turn off (tool-toggles.md, Review "Notes").

**Repro** (2026-11-20, on `feat/caps-before-first-message` = `main` @ `3628eb28`; `.tentacle/tmp/caps-before-first-message/repro.ts`). An in-process `SessionHost` + `Connection` + `RemoteClient`, the harness of `packages/client/test/session-capabilities.test.ts`. A fresh session, no message sent. It prints:
- the TUI phase and wording
- what a set before the open does
- which frames went out

```ts
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../../../packages/client/src/remote-client.ts";
import { capsTitleNote, noSwitchNotice, sessionCapsPhase } from "../../../packages/tui/src/capability-toggles.ts";

const host = new SessionHost({
  defaultCwd: "/tmp/caps-repro",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model: { id: "quiet", async *stream() { yield { type: "done" as const }; } },
      tools: new ToolRegistry(),
      env: {} as ExecutionEnvironment,
      requestPermission: (req, o) => permissions.request(req, o),
    });
    return { agent, permissions };
  },
});
const [d, c] = createChannelPair();
new Connection(d, host);
const sent: string[] = [];
const send = c.send.bind(c);
c.send = (data: string) => { const f = JSON.parse(data); if (f.method) sent.push(f.method); return send(data); };
const rc = new RemoteClient(c, new PermissionBroker(), undefined, { clientInfo: { name: "repro", version: "1" } });
await rc.initialize();
const session = rc.newSession(undefined, crypto.randomUUID());
console.log("opened() before first message:", session.opened());
console.log("capabilities() before first message:", session.capabilities());
const phase = sessionCapsPhase(session, session.capabilities());
console.log("TUI phase:", phase.kind, "| title:", capsTitleNote(phase), "| Space says:", noSwitchNotice(phase));
const err = await session.setCapability("skill", "deploy", false).then(() => "applied", (e: unknown) => `rejected: ${(e as Error).message}`);
console.log("setCapability(skill, deploy, off) before open:", err);
console.log("frames sent so far:", sent.filter((m) => m !== "initialize"));
```

```
opened() before first message: false
capabilities() before first message: undefined
TUI phase: not-open | title: on/off after the first message | Space says: _On/off applies to a started session: send a first message, then try again._
setCapability(skill, deploy, off) before open: rejected: unknown session: fe3f4962-6229-4de5-9082-8257fc6d5b00 (not open on this connection)
frames sent so far: [ "session/set_capability" ]
```

What the output shows:
- Nothing can be switched before the first message. The TUI says so honestly.
- A side finding: a set before the open DOES send a frame. `RemoteClient.setSessionCapability` (`remote-client.ts:3744-3757`) uses `session.sessionId`, which is `id ?? desiredId` (`remote-session.ts:1116-1118`), so the request goes out under the not-yet-created id and the daemon refuses it `UnknownSession`. The existing test "a set before the session is open rejects without a call" (`client/test/session-capabilities.test.ts:163-170`) passes only because the daemon's refusal text also contains "not open". Today this is harmless, because the TUI never calls it before the open (the phase gate). This task replaces that path anyway (D2), and that test is rewritten.

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

**Every runtime's first message goes through ONE memoized open, `RemoteSession.createOrAttach()`. Every switch list the TUI shows before that open comes from a request that needs no session. So the pending switches can live in `RemoteSession` alone, and be applied inside that one open, between `session/open` and `session/prompt`. No runtime gets its own path, and nothing new goes on the wire.**

Proof:

1. **One class, one first-send path.**
   - `RemoteSession` is constructed in exactly one place, `RemoteClient.newSession` (`remote-client.ts:1440-1461`). `rg "new RemoteSession\("` finds only `:1451`.
   - A send runs `runTurn` → `await this.createOrAttach()` (`remote-session.ts:1606-1611`) → `this.sendPrompt(id, turn)` (`:1656`). The prompt frame is written only after `createOrAttach` resolves.
   - Every other path that may open a lazy session awaits the same memoized promise:
     - `attachImage` (`:650`) and `attachDocument` (`:725`)
     - `openSeeded` (`:574-576`) and `openForReset` (`/clear`, `/compact` on a resumed session, `:1250-1262`)
   - `enqueue` (`:1347-1348`), `sendNow` (`:1450`), `skills()` (`:1182-1185`), `tools()` (`:1193-1196`), `rename` and `listArtifacts` await `this.opening`, which `createOrAttach` sets (`:612`). It resolves inside the same `.then` that sets `this.id` (`:600-604`).
2. **Every runtime hands that same object to the TUI.**
   - **In-process worker** and **pods** (`run`/`attach`): `createLocalRuntime` builds `client.newSession(…)` (`cli/src/local-runtime.ts:1291-1305`). Its controller forwards `capabilities`/`onCapabilities`/`setCapability`/`opened` 1:1 (`:1009-1014`). Pods reach `createLocalRuntime` from `engine-runtime.ts:849` and `:1311`.
   - **`connect`**: a new session is `client.newSession(undefined, crypto.randomUUID())` (`cli/src/connect.ts:371`), handed to the TUI as is (`remote-session.ts:1120-1125`, "`connect` hands this session to the TUI … as is").
3. **The lists exist before the open, with no session.**
   - `/mcp`: `RemoteClient.mcpStatus()` takes no session (`remote-client.ts:1178-1185`). MCP servers are daemon-wide.
   - `/skills`: `RemoteSession.skills()` asks `session/skills` with no `sessionId` before the open, meaning "the skills a session created now would have" (`remote-session.ts:1175-1185`, `remote-client.ts:1207-1224`).
   - `/tools`: `RemoteSession.tools()` asks `session/tools` with no `sessionId` (`remote-session.ts:1187-1196`, `remote-client.ts:1226-1241`). Each entry carries its `group`, its `tokens` and `disabled` "for the session a create would build now" (tool-toggles D6).
   - So the TUI already shows every row before the open. Only the switch column is missing: `capsPhase` returns `not-open` (`capability-toggles.ts:58-70`).
4. **Applying a set before the prompt is enough for the first model call.**
   - The daemon's `setCapability` is synchronous. It applies to the live agent (`currentAgent().setCapabilities(next)`) before it answers (`daemon/src/hosted-session.ts:3086-3126`).
   - The agent snapshots the switches at the start of EVERY round (`agent/src/agent.ts:1510-1511`, `const caps = this.capabilities(); const tools = this.projectedTools(caps)`).
   - So a set acked before `session/prompt` is sent is in round 1's request. Sub-agents read the parent's state live (tool-toggles proof 4).
5. **No protocol change** (proof by what is used):
   - `session/open` with its existing `capabilities` seed, built by the unchanged `withBaseTools(seed, baseDisabledTools)` (`remote-client.ts:1865-1866`, `:4735-4747`)
   - `session/set_capability` with `kind` `mcp`/`skill`/`tool` (`protocol/src/session.ts:1273-1289`)
   - `session/tools` and `session/skills` without a session
   - `session/prompt`

   No method, field, update kind, error code or log entry is added. The order (open → set → ack → prompt) is client-side only. A set after the open is logged and broadcast by the daemon exactly like a live Space press (`hosted-session.ts:3112-3124`). → **No `protocol.d/` note, no schema regeneration.**

The executor re-verifies 1 and 2 first (S1, before any edit): `rg "new RemoteSession\("` still finds one site, and `rg "createOrAttach\(\)"` still finds only the call sites above. If a new path opens a lazy session without `createOrAttach`, STOP and bring it to the plan.

### Preconditions

- **The daemon is the truth for the switches; a row follows its echo** (`capability-toggles.ts:9-11`; `RemoteSession.setCapability` docs, `remote-session.ts:403-412`). Before the open there is no daemon state, so the client shows a **preview**. The preview is replaced by the daemon's state the moment the open's sets are done (D3).
- **The daemon's set is idempotent and emits only on a change** (`hosted-session.ts:3080-3085`, `:3110`). So a pending flip equal to the created state costs one round trip and logs and broadcasts nothing.
- **An unknown tool or group name is `InvalidParams`, never stored. An unknown MCP or skill name IS stored** (session-capabilities F10; `protocol/src/session.ts:1276-1280`; `hosted-session.ts:3091-3097`).
- **The create seed is a union. Off wins.** The daemon unions `OpenParams.capabilities` with the host config's tool set (tool-toggles D4, review round 2). A seed can never turn ON a tool the host config turned off. That is why pending ONs need the set call, and why the set call is the one mechanism (Q1).
- **The peer dispatches requests concurrently** (`transport/src/peer.ts:325`, `void this.handleRequest`). `set_capability` takes no lock (`daemon/src/connection.ts:406-413`). The wait for the acks is a client-side `await` inside ONE session's open promise. It holds no lock on the `Connection` or the `RpcPeer`. Other requests keep flowing while it waits: `mcpStatus`, a permission answer, another session's prompt. §7 "Don't serialize the RPC peer" holds.
- **A pod is not trusted** (§7). The pod daemon answers the sets for its own session. A pod that lies ("applied") makes its own model see tools, skills or servers the person switched off. That wastes context and is not a security problem: every call still goes through the single laptop broker, and laptop-effect tools are never registered in a pod (tool-toggles Q6, session-capabilities F14). The ack is a UX ordering signal, never a security check.
- **The phone has no pre-open window.** It creates a session at the "New session" tap (`apps/mobile/src/session-controller.ts:111-131`, `createFreshSession` → `openSeeded`). Its switches are `not-open` only while not attached (`apps/mobile/src/session-info.ts:425-438`). A phone session is open before anyone can type in it.
- **Which sessions are lazy, i.e. have a pre-open window:**
  - a fresh session in the worker, a pod or `connect` (`local-runtime.ts:1293`, `connect.ts:371`)
  - a `--resume` from the laptop's copy in the worker or a pod. It is created at its first message from `record.messages` and `record.capabilities` (`local-runtime.ts:1293-1304`).

  Which sessions are eagerly attached:
  - `connect --resume` / `connect` pick (`connect.ts:512-516`, `session.open()`)
  - a pod `attach` to a live session, and every TUI of a detached run (`local-runtime.ts:1292`, `{attach: {}}`)

  **The brief's premise "`--resume`: the session exists, the panel is live already" is true only for `connect --resume` and live attaches. A worker or pod `--resume` is lazy**, so it gets the pending path. Its preview starts from the record's switches (D3).
- **The laptop saves on a switch change** (`local-runtime.ts:688-697`, `capsSeen` → `flush()`). `flush()` sets `confirmed = false` (`:629-630`), and the detached-run `--rm` net reads that (§7, `saveConfirmed`). A preview change must not reach that save (D5).

### Design

**One rule.** Before the session is open daemon-side, a Space press in `/mcp`, `/skills` or `/tools` records a **pending flip** in the session's client object (`RemoteSession`), not on the daemon. The row shows it at once ("applies from the first message"). The first thing that opens the session (in practice the first message) does this, in order:
1. creates it (`session/open`, the unchanged seed);
2. sends each pending flip as `session/set_capability`, one after another, each awaited;
3. only then sends the prompt.

If any flip is refused, the prompt is held and given back (D4). Nothing changes on the daemon or on the wire.

**D1 — The pure module: `packages/client/src/pending-capabilities.ts`** (React-free, I/O-free, §7 "logic in pure modules"). This is the whole decision logic. `RemoteSession` holds the state and executes.

```ts
export interface CapabilityFlip { readonly kind: "mcp" | "skill" | "tool"; readonly name: string; readonly enabled: boolean }

/** Last wins per (kind, name): an earlier flip of the same key is removed, the new one goes LAST. */
export function noteFlip(pending: readonly CapabilityFlip[], flip: CapabilityFlip): CapabilityFlip[];

/**
 * What the switches will be once the open's sets land: `base` (the create seed the open
 * WILL send, ∪ the host's own tool set when known) with `pending` applied IN ORDER through
 * the agent's own `applyCapabilityOp` (group expansion included). A flip the agent's table
 * refuses (unknown tool/group, `skill`) is returned in `refused`, never applied.
 */
export function previewCapabilities(
  base: SessionCapabilitiesWire,
  pending: readonly CapabilityFlip[],
): { readonly caps: SessionCapabilitiesWire; readonly refused: readonly CapabilityFlip[] };

/** The base: what `openSession` will seed (seed ∪ baseDisabledTools) ∪ the host's `session/tools` `disabled` names. */
export function previewBase(seed: SessionCapabilitiesWire | undefined, hostDisabledTools: readonly string[]): SessionCapabilitiesWire;

/** Skill flips whose name the opened session does not list (D4, Q3): the honest-line candidates. */
export function vanishedSkills(flips: readonly CapabilityFlip[], sessionSkillNames: readonly string[]): CapabilityFlip[];
```

Why these rules hold:
- **Last-wins with move-to-end gives the same final state as the person's whole sequence of presses.** Every flip is an assignment of `enabled` to the names it covers (a group covers its members). A later flip of the same key overwrites all of the earlier one's names. The flips in between are left in order. So dropping the earlier one changes nothing. The order between DIFFERENT keys is kept, and that matters for a group and its member. Example: `visuals` off, then `chart` on, leaves `chart` on with `diagram` and `present` off. The reverse order leaves all three off.
- **The preview reuses `applyCapabilityOp`** (`agent/src/capabilities.ts:91-113`, exported from `@tentacle/agent`, on which `client` already depends: `packages/client/package.json`). The preview and the daemon then apply the SAME semantics. The client needs no second group table. Under version skew (a pod daemon on another build), only the preview can differ, and the daemon's snapshot replaces it at the open.
- A flip refused by the preview (an unknown tool or `skill`) is refused at Space time, not deferred (F7).

**D2 — `RemoteSession` holds the pending flips and applies them inside the one open.** All changes are in `client/src/remote-session.ts` (+ one id-taking helper in `remote-client.ts`).

- **State:**
  - `private preOpen: { flips: CapabilityFlip[]; settle: Map<CapabilityFlip, {resolve, reject}> } | null`
  - `private hostDisabledTools: readonly string[] = []`
  - `preOpen` is created on the first pre-open flip. It exists only on a session this client would CREATE: `!this.attach && this.id === null && this.opening === null && !this.closed`.
- **`setCapability(kind, name, enabled)` before the open** (today it sends a doomed frame, see Repro):
  - When pre-open (the condition above):
    - It records `noteFlip`.
    - It emits the new preview to the `onCapabilities` listeners, with no `by` (so it is never "another device").
    - It returns a promise that **settles when the open applies that flip**: resolved with the daemon's state on its ack, rejected with the daemon's refusal. The TUI's existing `switchCapability` (`tui/src/App.tsx:2016-2038`) needs no change: it already shows `switchFailedNotice` on a rejection and settles its own `capsPendingRef` either way.
    - A flip of the same key that replaces an earlier pending one settles the earlier promise as superseded (resolve with the preview), so no promise is left dangling.
    - A flip the preview refuses (D1 `refused`) rejects at once, with the same `InvalidParams`-style text the daemon would give.
  - When an open is in flight (`this.opening !== null`): await it, then do the live set. That is the same rule as `rename` (`:755-762`). A flip pressed during the open's own sets therefore goes after them, live.
  - When an attach session is not attached yet: unchanged. The TUI still shows `not-open` (Q6).
- **`capabilities()` before the open** returns the preview when `preOpen` exists or the session is a lazy one (an empty pending list previews the base). So the TUI shows switches from the start. After the open it returns the daemon's state, as today.
- **`tools()` before the open** records the answer's `disabled` names in `hostDisabledTools`, then emits the refreshed preview. This closes tool-toggles' review note: a pod's no-session list ignores the laptop seed, but the preview is `seed ∪ baseDisabledTools ∪ host set`, which is exactly what the create will hold. The answer itself is returned unchanged.
- **The open — `createOrAttach`'s `.then`** (`:600-605`). Today it sets `this.id` at once. New: when `preOpen` has flips, it first runs `applyPreOpen(sessionId)`, and only then sets `this.id`, clears `this.opening` and emits. So everything awaiting `this.opening` resumes only after the sets: `enqueue`, `sendNow`, `skills`, `tools`. And `runTurn` resumes first: it subscribed first (`:577-582`).

  `applyPreOpen(sessionId)`:
  1. For each flip in order: `await client.setCapabilityOn(sessionId, kind, name, enabled)` (the id-taking form, D2b), and settle that flip's promise.
     - On a refusal, it records the failure and **continues with the next flip**. Each flip is independent, and the person sees every outcome.
     - A link that drops mid-way rejects the set: a failure like any other.
  2. When any skill flip was applied: one `client.sessionSkills(sessionId)`. A flipped name that the session does not list is settled with a "not in this session any more" rejection (Q3). The switch IS stored (F10), so this is a line, not a hold.
  3. `preOpen = null`.
  4. If any set was refused: `this.heldFailure = new SwitchesNotAppliedError(failed)`.
  5. Then the daemon's current state is emitted ONCE to the listeners, with no `by`.

  While the sets run, the `capabilitiesSnapshot` and `capabilitiesChanged` echoes are stored in `capabilityState` but **not emitted** (`noteCapabilities`, `:452-457`). The rows would otherwise flicker preview → snapshot → echo. And the echoes, which carry `by` (the connection's label, `connection.ts:412`), would read as "another device" in `remoteChangeNotices`.
- **`runTurn`** (`:1584-1616`): right after `await this.createOrAttach()`, if `heldFailure` is set, it takes it (consume once) and **throws it before any turn is installed or any prompt is sent**. `enqueue` and `sendNow` that awaited the same open reject with the same error when they are bound to the held turn. So a fast second message cannot go out as a turn the person did not intend (F5).
- **The failed open itself** (a network error on `session/open`): `createOrAttach` already resets `creating` (`:606-609`). `preOpen` is untouched, so the flips stay pending and the next send applies them. Their promises stay unsettled until then.
- **`seedCapabilities()`** (`:436-440`, a `/clear` close-and-replace): on a session that never opened, it seeds the PREVIEW instead of nothing. Owner Q5 of session-capabilities ("`/clear` keeps the switches") then also holds before the first message. A pending ON of a host-config-off tool cannot ride a seed (union). The new session's preview shows that tool off again: visible, not silent (Q4).
- **`SwitchesNotAppliedError`** (new, `client/src/pending-capabilities.ts`): `name = "SwitchesNotAppliedError"`, `failed: {kind, name, enabled, reason}[]`. It is local only, not a wire error code, so there is no protocol change. The TUI recognises it structurally (`name`), because `tui` does not depend on `client` (`packages/tui/package.json`).

**D2b — `RemoteClient.setCapabilityOn(sessionId, kind, name, enabled)`.** This is today's `setSessionCapability` body (`remote-client.ts:3744-3757`), taking the id explicitly: during `applyPreOpen`, `this.id` is not set yet. `setSessionCapability(session, …)` becomes a 2-line wrapper that refuses a null id locally, sending nothing. That also fixes the Repro's side finding.

**D3 — The preview's base, per runtime** (`previewBase`). It is the create seed `openSession` will send. A new `RemoteClient.peekCreateSeed(capabilities?)` returns `withBaseTools(capabilities ?? this.seedCaps, this.baseDisabledTools)` WITHOUT consuming the one-shot seed. It is the same expression as `remote-client.ts:1865-1866`, factored into one private function both call. Then `∪ hostDisabledTools`.

| runtime | seed | base tools | host set (from `tools()`) |
|---|---|---|---|
| worker, fresh | `/clear` one-shot, else none | laptop `tools.enabled` (`local-runtime.ts:1783`) | the worker's config (the same set) |
| worker / pod, `--resume` | the record's switches (`local-runtime.ts:1300-1302`) | laptop `tools.enabled` | the pod's own `tools.enabled` |
| pod, fresh | `/clear` one-shot, else none | laptop `tools.enabled` (`engine-runtime.ts:692,1117`) | the pod's own `tools.enabled` |
| `connect`, fresh | `/clear` one-shot, else none | none (tool-toggles S2 drift 2) | `serve`'s `tools.enabled` |

The MCP and skill host sets are empty at create (tool-toggles D4: "their part of the state is empty at seed time"). Before `/tools` has been opened once, `hostDisabledTools` is `[]`. The status-line marker can then under-count tools by the host config's part until the panel is opened. That is display only, and replaced at the open.

**D4 — What the person sees** (TUI, S2).

- **Phase** (`capability-toggles.ts`): `CapsPhase`'s `on` gains `firstMessage?: true`. `capsPhase(caps, opened, settable)` returns `{kind: "on", caps, firstMessage: true}` when `caps` is defined and `!opened`. All row functions (`mcpSwitch`, `skillSwitch`, `toolSwitch`, `groupSwitch`, `switchOp`) work unchanged, because they test `kind === "on"`.
- **Title note** (`capsTitleNote`): `on` + `firstMessage` → `"this session · applies from the first message"`. Plain `on` keeps `"this session · applies to the next model call"`.
- `not-open` remains only for an attach whose eager open has not finished (Q6). Its text stays as is.
- **Rows** flip at once on Space (the preview emission). **Status line**: `capsMarker` shows `⊘ 1 skill off` before the first message too (app-layout passes it only for `on`, `app-layout.ts:250`).
- **The first message, all flips applied:** nothing new is shown. The rows now follow the daemon. No "another device" notice (the echoes are suppressed, D2). The first model call runs with the switches.
- **A flip refused at the open:**
  - its own line, through the existing `switchFailedNotice` (`capability-toggles.ts:224-227`): `_Could not turn visuals off: <daemon's reason>_`;
  - then the send's `SwitchesNotAppliedError` takes a new branch in `useTurnDriver`, shaped like `refusedBeforeStart` (`useTurnDriver.ts:712-721`): the user bubble is withdrawn, the text, image chips and documents go back to the input, and one line says `_Message not sent: a switch could not be applied (above). The session has started: the panels now show its real switches. Enter sends it as it is._`;
  - the wording is a pure function `switchesNotAppliedNotice(error)` in `capability-toggles.ts`, and its predicate `switchesNotApplied(error)` checks the `name`, so the TUI holds no client import;
  - what the person can do: press Enter (the session is open, nothing is pending, the prompt goes as the session is), or fix the switch in the now-live panel first.
- **A flipped skill not in the session any more** (Q3): its own line, `_Could not turn deploy off: not in this session any more (kept off; applies if it comes back)_`. The prompt is NOT held.

**D5 — The laptop save ignores the preview** (`cli/src/local-runtime.ts:690-697`): `if (changed && inner.opened()) flush()`. `capsSeen` still advances, so the daemon's post-open state compares against the last preview. If they are equal there is no extra save, and none is needed: the first round's committed save reads the session log, which has the sets' `capabilities` entry. A pre-open flip therefore writes nothing to `<uid>.jsonl` and leaves `saveConfirmed` alone (§7 persistence; `--rm` nets).

**D6 — Phone (parity).** There is nothing to build. A phone session is created at the tap (Preconditions), so its switches are live before the first message. A `connect` session started on the Mac and later opened on the phone is just an open session there. The mechanism lives in `RemoteSession`, which the phone also uses. Its `openSeeded` at the tap has no flips, so the phone takes the unchanged path.

### Files

In dependency order. No protocol, daemon or mobile change.

1. `packages/client/src/pending-capabilities.ts` (**new**): D1 + `SwitchesNotAppliedError`. Export them from `client/src/index.ts`.
2. `packages/client/src/remote-client.ts`: `setCapabilityOn` (D2b); `setSessionCapability` as its wrapper with a local refusal; `peekCreateSeed` and the shared seed expression (D3).
3. `packages/client/src/remote-session.ts`: D2 (`preOpen`, `hostDisabledTools`, `setCapability`, `capabilities`, `tools`, `createOrAttach`'s `.then` + `applyPreOpen`, suppressed emission, `heldFailure` in `runTurn`/`enqueue`/`sendNow`, `seedCapabilities`).
4. `packages/cli/src/local-runtime.ts`: D5, one guard.
5. `packages/tui/src/capability-toggles.ts`: `firstMessage` on `on`, `capsTitleNote`, `switchesNotApplied` + `switchesNotAppliedNotice`. Update the module doc comment (`:42-47`).
6. `packages/tui/src/useTurnDriver.ts`: the `SwitchesNotAppliedError` branch next to `refusedBeforeStart` (`:712-721`).
7. `changelog.d/caps-before-first-message.changed.md`.

`App.tsx`, the panels and `app-types.ts` need no change: the `SessionController` members are already `capabilities`/`onCapabilities`/`setCapability`/`opened` (`app-types.ts:200-235`). The executor confirms this. If one turns out to need a change, that is drift: write it down.

### Failure modes

| # | case | what happens, how it converges |
|---|---|---|
| F1 | **A pending name no longer exists at open**: `tool` | The daemon answers `InvalidParams` (tool-toggles F4). The flip's line is shown and the prompt is held (F4 below). It can happen only if a different daemon build answers the open (a pod image changed under a `--resume`). |
| F1b | the same for a **skill** | The daemon stores it (F10). The post-set `session/skills{sessionId}` read finds it missing, so one line, "not in this session any more (kept off; applies if it comes back)". Prompt NOT held: an absent skill is invisible either way (Q3). |
| F1c | the same for an **MCP server** | MCP names are daemon-wide (`mcpStatus()` has no session, `remote-client.ts:1178`). The `/mcp` list and the open's daemon are the same daemon config, so a server can vanish only if a restarted daemon with an edited config answers the open. Then the set is stored (F10) and is moot. No check (Q3). |
| F2 | **A set refused** (`InvalidParams`, the 128-name cap, `MethodNotFound` from an older daemon, a link drop mid-set) | The remaining flips are still attempted. Each refusal gets its own line. The send rejects `SwitchesNotAppliedError`, so no `session/prompt` frame goes out. The bubble is withdrawn and the text is back in the input. The session IS open, so the panels show the daemon's real state. Enter sends as is. `MethodNotFound` also clears the state (the existing F7 path, `remote-session.ts:425-427`), so the panel then says "not supported". |
| F3 | **The same switch flipped twice or more before the open** | Last wins (`noteFlip`). One set is sent per key, in the order of each key's LAST press. The superseded promise resolves, nothing dangles. Off, then on again: one `enabled: true` set, a daemon no-op when the seed has it on. |
| F4 | **Ctrl+C / quit / `/sessions` switch before the first message** | Nothing was ever created daemon-side (`close()` is a no-op before any send, `remote-session.ts:1086-1104`). The flips are in memory only, so they are gone, like the unsent draft. **Nothing is persisted**: D5 keeps the preview out of the laptop save, and the daemon never saw them. A `/clear` close-and-replace carries them via the preview seed (D2), except a pending ON of a host-config-off tool, which the new session's panel shows off again. |
| F5 | **The person types fast**: a second message while the open and sets are in flight | The TUI sees its first turn running and enqueues. `enqueue` awaits `this.opening`, which resolves only after the sets (D2). The first send resumes first and writes its prompt before the enqueue resumes (`:577-582`). If the sets failed, the first send throws `SwitchesNotAppliedError`, and the enqueue bound to that held turn rejects with the same error. Its text goes back via the existing enqueue-rejection reconcile, never sent. A Space pressed during the sets awaits the open, then does a live set (D2). |
| F6 | **`--resume`** | Worker/pod `--resume` is lazy, so it takes the pending path, with its preview starting from the record's switches (D3). `connect --resume` and live attaches are open before the TUI is usable, so their switches are live (no pending path). During the eager attach's own round trip they stay `not-open` (Q6). |
| F7 | **Config `tools.enabled: {chart: false}` + a pre-open flip of `chart` on** | The preview base shows `chart` off (seed ∪ base ∪ host). Space flips the row on. At the open, the create holds `chart` off (union), then `set chart on` removes it. **The flip wins**, as owner Q4 of tool-toggles allows for a live session. The first model call has `chart`. |
| F8 | **A flip the preview refuses** (`skill`, an unknown tool) | Rejected at Space, with the same text the daemon would give. Today's panels already show `skill` as `locked`, so Space sends nothing: this is a belt. |
| F9 | **Version skew**: an older daemon with no switches at all (no `capabilities` in `OpenResult`) | The preview showed switches (the client cannot know before the open). The first set gets `MethodNotFound` → F2: held, with the line saying not supported. Only when the person flipped something; otherwise the path is unchanged. |
| F10 | **The open itself fails** | `createOrAttach` already resets (`:606-609`). The flips stay pending and their promises unsettled. The next send retries the open and then the sets. |
| F11 | **A shared session** (a detached run's TUI reopened after a close, `openSeeded` attaching a LIVE id, `remote-session.ts:563-575`) | The flips are applied to the live session, as a live Space press would be. The preview base may have differed from that session's state, and the snapshot replaces it at the open. Other clients see the sets as changes with this connection's `by`, which is correct: this person pressed them. |
| F12 | **Nothing flipped** (the common path) | `preOpen` is null, so `createOrAttach` is byte-for-byte today's path: no extra round trip, the same frames. Pinned by a test (T-C6). |

### Tests

Red before green for each new test: show it failing on `main` first (most fail because the pre-open set is refused, see Repro). Iterate on the single file (§4). The full `bun run check` comes before done.

**S1 — client.**
- `packages/client/test/pending-capabilities.test.ts` (**new**, pure):
  - `noteFlip`: last wins, the key moves to the end; a group, then a member, then the group again equals the press sequence.
  - `previewCapabilities`: a group expands to its members; a member after its group gives a partial group; `skill` and an unknown tool end up in `refused`.
  - `previewBase`: seed ∪ base ∪ host, sorted.
  - `vanishedSkills`.
- `packages/client/test/caps-before-first-message.test.ts` (**new**). It uses the in-process `SessionHost` + `Connection` harness of `session-capabilities.test.ts`. A frame recorder wraps the client channel's `send`, as `voice-turn-client.test.ts:90` does. One daemon variant holds the `set_capability` RESPONSE until the test releases it: intercept the daemon end of `createChannelPair`.
  - **T-C1 ordering.** Flip `skill deploy` off before the open, then `send("hi")`. While the set's response is held, **no `session/prompt` frame has been sent**. Release it: `session/prompt` follows, and its frame index is greater than the set's.
  - **T-C2 the exact property.** With a recording model, flip `tool visuals` off, plus `chart` on via a host config whose `buildAgent` seeds `chart` off. Then `send`. The **first** `ChatRequest.tools` has `chart`, and has no `diagram` and no `present` (§2: prove the property itself, not frame order alone).
  - **T-C3 a rejected set blocks the prompt.** Flip a tool name the daemon refuses (a daemon variant that answers `InvalidParams`), then `send`. The send rejects `SwitchesNotAppliedError` with that flip in `failed`. **No `session/prompt` frame ever.** The flip's own promise rejected. A second `send` goes out normally (`session/prompt` present).
  - **T-C4** a racing `enqueue` during the held set rejects with the same error when the set fails. No `session/enqueue` and no prompt is sent.
  - **T-C5** the preview: `capabilities()` before the open reflects seed ∪ base ∪ flips; the listener got the preview without `by`; during the sets the listener got NOTHING; after them, exactly one emission of the daemon's state, without `by`.
  - **T-C6 the common path is unchanged.** No flip → the frames are exactly `session/open`, `session/prompt` (the same list as on `main`).
  - **T-C7** a vanished skill: flip `deploy` off, remove it from the session's skill list before the open (the host's `newSessionSkills` seam). The flip's promise rejects "not in this session any more", and the prompt IS sent.
  - **T-C8** a failed `session/open` keeps the flips; the retry applies them.
  - **T-C9** `seedCapabilities()` on a never-opened session seeds its preview.
- `client/test/session-capabilities.test.ts:163-170`: the test is rewritten to the new contract. A pre-open set on a lazy session is pending and sends no frame. A null-id `setSessionCapability` refuses locally (D2b).
- `packages/cli/test/…`: the test next to the existing `capsSeen` coverage (`rg capsSeen packages/cli/test`; if none, new in `session-capabilities-resume.test.ts`). A pre-open flip writes nothing to the store and `saveConfirmed` stays as it was.

**S2 — TUI.**
- `packages/tui/test/capability-toggles.test.ts`:
  - `capsPhase(caps, false, true)` → `on` + `firstMessage`;
  - the title note says "applies from the first message";
  - `switchesNotApplied` / `switchesNotAppliedNotice` (structural, by `name`).
- `packages/tui/test/caps-before-first-message-app.test.tsx` (**new**, the ink-testing-library pattern of `capability-toggles-app.test.tsx` and `tools-panel-app.test.tsx`). It uses a fake `SessionController` with `opened() → false`, a `capabilities()` preview and a recording `setCapability` that emits the preview.
  - `/skills` before the first message: a `[✓]` column, the title says "applies from the first message"; Space flips the row to `[ ]` and the status line shows `⊘ 1 skill off`.
  - `/tools` the same, on a group, and `/mcp` the same (one mechanism, three panels).
  - The send fails with `SwitchesNotAppliedError`: the bubble is gone, the text is back in the input, the line is shown.
  - The `capability-toggles-app.test.tsx:130-136` assertions on `not-open` are moved to an attach-in-flight fake (`attach` + not opened + `capabilities()` undefined), which keeps that wording (Q6).

**Mutations** (each must turn a named test red; then revert; record the output in Execution):
- **M1, the ordering guard:** in `createOrAttach`, set `this.id` and resolve before `applyPreOpen` finishes (fire the sets without awaiting). T-C1 goes red (a prompt frame while the set is held). This is the mutation that proves the ordering guard.
- **M2:** `runTurn` ignores `heldFailure` → T-C3 red.
- **M3:** `noteFlip` keeps the FIRST flip of a key → the pure last-wins test red.
- **M4:** echoes are emitted during `applyPreOpen` → T-C5 red.
- **M5:** `capsPhase` returns `not-open` when `!opened` regardless of `caps` → the TUI panel test red.
- **M6:** D5 guard removed → the cli store test red.

**Gate:** the full `bun run check` (typecheck → lint → test) before done, against the §6 baselines.

### Owner questions

1. **Set calls only, or offs folded into the open's seed?** The open already carries a `capabilities` seed. Pending OFFs could ride it, which saves the round trips, and only ONs would need a set. **Rec: set calls only, as you described.** It is one path for on and off. The seed is a union (off wins), so ONs need the set call anyway, notably F7, a config-off tool switched on. A seed also does not validate: an unknown tool in a seed is "stored harmlessly" (tool-toggles F4), which would be a silent drop of F1. The cost is one local round trip per flipped switch, only when something was flipped.
2. **A refused set: hold the prompt, or send it with a warning?** **Rec: hold it** (F2). The text goes back to the input with one line, the session is open and the panels are live, and Enter sends it as it is. Sending anyway would run the first call "as if applied", which is what you ruled out.
3. **A flipped skill/MCP name gone at the open.** The daemon stores unknown MCP/skill names (F10), so nothing is refused. **Rec: skills get one line from a `session/skills` read after the sets, and the prompt is NOT held** (an absent skill is invisible to the model either way). **MCP is not checked**: server names are daemon-wide, so one can vanish only if a different daemon answers the open, and the stored switch is then moot. A check would cost an `mcp/status` probe, which can wait out a hung server's timeout, before the first prompt.
4. **A pre-open `/clear` carries the pending flips** (as the preview seed, extending your session-capabilities Q5 "`/clear` keeps the switches"). Ctrl+C, quit and a `/sessions` switch drop them, like the unsent draft, with nothing persisted. **Rec yes to both.** Alternative: a one-line "N switches not applied" on quit. That adds noise for a session that never existed.
5. **Review tier.** The blast is cross-module by the §10 table (no wire, persistence or daemon change), but the edit sits on the first-send path of EVERY runtime (`createOrAttach`). **Rec: DeepSeek executes, then one fresh-context Opus review**, red-teaming the §7 one-session-path and peer-serialization points. F12/T-C6 pins the untouched common path.
6. **Eager attaches (`connect --resume`, pod `attach`, a detached run's TUIs) during their attach round trip.** **Rec: keep `not-open` there.** The session exists, its real state arrives with the attach (milliseconds to a second), and a preview built before it would be a guess about someone else's live session.

**Owner answers (2026-11-20):** Owner questions 1–6 all as recommended. Implementation APPROVED (DeepSeek executes, Opus fresh-context review).

## Execution

*— claude-opus-5-5, 2026-11-20* (resumed DeepSeek's partial working tree after the watchdog stopped it; its edits were kept where right and corrected below)

**Load-bearing check (re-run first): holds.** `rg "new RemoteSession\("` → one production site, `remote-client.ts:1451` (the others are tests). `rg "createOrAttach\(\)"` → `openSeeded`, `attachImage`, `attachDocument`, `runTurn` only. No new path opens a lazy session.

**Repro.** The Context's `repro.ts` (before: the pre-open set is refused `UnknownSession` and a frame goes out). On the new code the same script blocks at `await session.setCapability(...)`. That is the new contract: a pre-open flip is pending until the first message's open applies it. The client tests below pin it (no frame, a preview, settled at the open).

**As built, in plan order:**
1. `client/src/pending-capabilities.ts` (new, DeepSeek, kept): `noteFlip`, `previewCapabilities` (via the agent's `applyCapabilityOp`), `previewBase`, `vanishedSkills`, `flipRefusal`, `flipKey`, `SwitchesNotAppliedError`. Exported from `client/src/index.ts`.
2. `client/src/remote-client.ts` (DeepSeek, kept): `setCapabilityOn(sessionId, …)`. `setSessionCapability` wraps it and refuses locally when `!session.opened()` (the Repro's side finding: no frame under the not-yet-created id). `peekCreateSeed` = `withBaseTools(capabilities ?? seedCaps, baseDisabledTools)`, not consumed.
3. `client/src/remote-session.ts`: `preOpen`, `hostDisabledTools`, `heldFailure`, `isLazy`, `notePreOpenFlip`, `applyPreOpen` (inside `createOrAttach`'s `.then`, before `this.id`/`opening` are set), `heldFor` in `runTurn`/`enqueue`/`sendNow`, `tools()` host set, `seedCapabilities()` preview. **Corrections made to the partial edits:**
   - The echo suppression in `noteCapabilities` was `opening !== null`. That also swallowed an eager ATTACH's snapshot, and changed the timing of the no-flip path. Now it is `opening !== null && preOpen !== null` (only while this open carries flips). The one post-sets emission fires only when there were flips (`hadFlips`), so F12 is unchanged.
   - The preview was written into `capabilityState` (via `noteCapabilities`). After an open against an older daemon (no snapshot), that would have left a stale preview showing switches. The preview is now only emitted (`emitCapabilities`), never stored. `capabilities()` computes it while lazy.
   - `applyPreOpen` clears `capabilityState` on `MethodNotFound` (the F7/F9 path the plan names).
   - `heldFor(undefined)` consumed the refusal from a `sendNow` with no bound turn. `sendNow` now checks only when a turn is bound, and `heldFor` takes a required id.
   - Removed unused `@tentacle/agent` imports.
4. `cli/src/local-runtime.ts`: D5 guard `if (changed && inner.opened())` (DeepSeek, kept).
5. `tui/src/capability-toggles.ts`: `firstMessage` on `on`, `capsTitleNote`, `switchesNotApplied`, `switchesNotAppliedNotice`, doc comment (DeepSeek, kept).
6. `tui/src/useTurnDriver.ts`: the `SwitchesNotAppliedError` branch next to `refusedBeforeStart` (DeepSeek, kept).
7. `changelog.d/caps-before-first-message.changed.md`: the bullet from the doc header.

**Drift from Implementation:**
- **`tui/src/tools-panel.ts` changed (1 line + import).** It is not in the Files list. `toolsTitle` hard-coded "applies to the next model call" instead of calling `capsTitleNote`, so `/tools` would not say "applies from the first message". It now calls `capsTitleNote(p)` for `on`. `App.tsx`, `app-types.ts` and the panels needed no change, as the plan said.
- The `capability-toggles-app.test.tsx` `not-open` test was NOT moved. Its fake is already the attach-in-flight shape (not opened, `capabilities()` undefined), which is exactly Q6's remaining `not-open` case, and it still passes.
- T-C2 seeds `chart` off through the agent's `capabilities` (the host's own state) rather than a `buildAgent` config. The property is the same: the create holds it off, and the pre-open ON set must turn it on before request #1.
- T-C5's scripted daemon sends no echoes, so it could not catch M4 (verified: green under M4). Added **T-C5b** on the real daemon (open snapshot + `by` echo). It is the M4 target.
- **The M6 target is the synchronous `saveConfirmed()` read right after the flip** (cli C4). Under M6 the flush is transient: a read-back of a never-opened session re-confirms at once, so a read after a tick stays green (verified).

**Tests** (all green): `client/test/pending-capabilities.test.ts` (new, 9), `client/test/caps-before-first-message.test.ts` (new: T-C1, T-C2, T-C3, T-C5, T-C5b, T-C6, T-C7, T-C8, T-C9, F5/T-C4 enqueue race), `client/test/session-capabilities.test.ts` (pre-open test rewritten: pending, no frame, client-level local refusal), `cli/test/session-capabilities-resume.test.ts` (C4: pre-open flip saves nothing, then applies to request #1 and lands in the store), `tui/test/capability-toggles.test.ts` (+2), `tui/test/caps-before-first-message-app.test.tsx` (new: `/mcp` live column + Space + `⊘ 1 server off`; `/tools` group; a held-back send withdraws the bubble, restores the text, and shows the line). The `/skills` panel is not separately frame-tested: it uses the same phase and row functions as `/mcp`.

Last narrow run: 10 touched/covering files, **157 pass, 0 fail**. `bunx biome check` on the 14 changed files: clean. `tsc --noEmit -p .` filtered to the changed files: no errors.

**Mutations** (each applied, run, reverted; all red):
| # | mutation | red tests |
|---|---|---|
| M1 | `void this.applyPreOpen(…)` (sets not awaited) | T-C1, T-C2, T-C3, T-C5, F5 (5 fail) |
| M2 | `runTurn` ignores `heldFailure` | T-C3, F5 (2 fail) |
| M3 | `noteFlip` keeps the first flip of a key | both `noteFlip` tests (2 fail) |
| M4 | echoes emitted during `applyPreOpen` | T-C5b (1 fail; `Received +12` lines); T-C5 alone stayed green (see drift) |
| M5 | `capsPhase` → `not-open` whenever `!opened` | unit firstMessage test, App `/mcp`, App `/tools` (3 fail) |
| M6 | D5 guard removed | cli C4 (`Expected: true, Received: false`) |
| M7 (extra) | `useTurnDriver` branch disabled | App held-back test (1 fail) |

**Not run here (per the owner's token budget):** the full `bun run check`. The orchestrator's gate runs it. No protocol change, so no `protocol.d/` note and no schema regeneration.

## Review

*— claude-opus-5-5, 2026-11-20* (fresh context; same model family as the planner and the Execution's finisher, so shared blind spots are possible)

**Verdict: APPROVE.** No HIGH or MEDIUM findings.

**Gate (narrow, as briefed):** 8 touched/covering test files → 66 pass, 0 fail. `bun run lint` clean (2149 files). `bun run typecheck` clean (root + mobile + relay). The full `bun run test` was not run here (it is the orchestrator's merge gate).

**Mutation (re-run by the reviewer):** M1 (`void this.applyPreOpen`) → 6 red in `caps-before-first-message.test.ts` (T-C1, T-C2, T-C3, T-C5, T-C5b, F5). Reverted from a scratch copy, and `git diff` on the file is empty. M2–M7 are taken from Execution's table and were not re-run.

**Attacks tried:**
1. **§7 one session path.** `applyPreOpen` runs inside the one memoized `createOrAttach` `.then` (`remote-session.ts:843-858`). `opening` and `creating` are the same promise, so `runTurn`, `enqueue`, `sendNow`, `skills` and `tools` all resume after the sets. No second open path. **Holds.**
2. **§7 don't serialize the peer.** The awaits are client-side, inside one session's promise. No lock touches `Connection`/`RpcPeer`. **Holds.**
3. **Echo routing during the sets.** `openSession` registers `this` as the listener, so the snapshot and the `by` echoes reach `noteCapabilities`. There they are stored and not emitted while `opening && preOpen` (`:690`). One emission follows, with no `by`. With no flips, the path is unchanged (F12, T-C6). **Holds.**
4. **The held refusal and a racing message.** An enqueue reads `turnId` at call time, which is the first send's id, and joins `held`. The resend gets a new turn id, which clears the refusal and goes out. A `sendNow` with no installed turn falls through to `NoTurnRunning`, so nothing is sent. **Holds.**
5. **D5 / `saveConfirmed`.** The guard `inner.opened()` (`local-runtime.ts:698`) is false for the whole open, including the sets (`id` is set after them). **Holds.**
6. **Version skew (F9).** `MethodNotFound` clears `capabilityState` and holds the prompt. **Holds.**

**Notes (LOW, not blocking):**
- A pre-open `/clear`, quit or `/sessions` switch closes the session with `preOpen` promises that never settle. The TUI's `capsPendingRef` (`App.tsx:2029`) is never reset, so those ops stay in it. A later genuine change of the same (kind, name, enabled) by another device can be matched as "own" by `remoteChangeNotices`, and its notice is swallowed once. This affects display only. A fix would be to settle the `preOpen` waits in `close()`.
- `close()` during the open's sets is still a no-op (`id` is null). This window existed before, but N set round trips now make it longer.

**Executor behaviour:** the plan was followed, and the drift is written down honestly (the `tools-panel.ts` line, T-C5b added once T-C5 was found to be vacuous under M4, the M6 target). The corrections to DeepSeek's partial edits (the echo suppression scope, a stored preview, `heldFor(undefined)`) were real defects, and they were fixed.
