# feat/context-reset — The model renews its own context (`context_reset({ prompt })`)

> **Status:** done — THIS BRANCH = slice 1 of 3 (`feat/context-reset-refresh`, see *Split*); the plan below covers all three slices and is APPROVED (owner answers below). Slices 2 and 3 get their own docs, copied from this plan when picked.
> **Branch:** `feat/context-reset` (or the three sub-task branches below, see *Split*)
> **Type:** feat · **Size:** L (split into three M slices) · **Blast:** load-bearing (agent loop + its round budget, session history, the session's skill set swapped mid-turn, `history_replaced` barrier mid-turn, protocol bump, permission gate) · **Suited:** strong model executes; mandatory fresh-context Review that red-teams the cut/epoch invariant (`hosted-session.ts` module comment), the single-broker path and the atomic history + skill-set swap *(revised 2026-10-26)*

## Context

*— claude-opus-5-5, 2026-10-25*
*— claude-opus-5-5, 2026-10-26* (revision: decisions 10–14, repro 2)

The decided eval [`docs/eval/context-reset.md`](../eval/context-reset.md) (owner
decisions, binding) asks for a model tool `context_reset({ prompt })` that
replaces the session's history — same session, compaction-like — with a fresh
system prompt + the model-written restart prompt + the running background jobs +
the active skills reloaded, then lets the turn continue on the fresh context.
Approval like any `ask` tool; anti-loop rules; two config keys; a TUI separator.

**Decisions added since the first plan (revised 2026-10-26).** 10: the model's
context-usage line (`docs/eval/context-awareness.md`) is its own task and lands
BEFORE this one. 11: a reset re-reads BOTH the skills catalog AND the `skill`
tool's own list (today fixed at session start, `packages/cli/src/wiring.ts:238-260`),
so a skill added mid-session is usable right after a reset. 12: the two
`contextReset` keys come from the pod's config in `run`/`attach`. 13: a reset
restarts the turn's `maxIterations` count from zero. 14 (default
`maxIterations = -1`) is a separate task, not planned here.

What is missing today: compaction (`Session.compact`, `packages/agent/src/session.ts:157-169`)
replaces the history only **between** turns (it takes the busy slot,
`hosted-session.ts:1481-1521`), and its barrier names no running turn
(`hosted-session.ts:1540` `turnId: null`); the client assumes a
`history_replaced` "cannot arrive inside a turn" (`packages/client/src/mapping.ts:199-202`).
A model tool runs **inside** a turn, so the reset needs a mid-turn replacement.

**Repro 1** (2026-10-25, main `0b1d89f`, `.tentacle/tmp/context-reset/repro.ts`,
run with `bun .tentacle/tmp/context-reset/repro.ts`). A probe tool replaces the
live history in place (compaction's `length = 0; push(...)`) and fires the
daemon's existing barrier (`historyReplaced`) from inside the turn; the probe
keeps its own call so the agent's tool-result push stays paired (the real
feature drops the call — see Design). Still valid on `5e8b538`: between
`0b1d89f` and `5e8b538` only docs changed (`git diff --stat 0b1d89f 5e8b538`:
`TODO.md` and five `docs/eval/*.md`, no source file).

```ts
import { Agent, Session } from "../../worktrees/main-ro/packages/agent/src/index.ts";
import { type ChatMessage, type ChatRequest, PermissionBroker, type StreamEvent, type Tool } from "../../worktrees/main-ro/packages/core/src/index.ts";
import { HostedSession } from "../../worktrees/main-ro/packages/daemon/src/index.ts";
import { initialStream, reduceStream } from "../../worktrees/main-ro/packages/client/src/index.ts";
import { ToolRegistry } from "../../worktrees/main-ro/packages/tools/src/index.ts";
import { z } from "../../worktrees/main-ro/packages/core/node_modules/zod";

const seen: string[][] = [];
let round = 0;
const model = {
  id: "fake",
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    // `req.messages` IS the live history array: copy it at call time.
    seen.push(req.messages.map((m) => `${m.role}:${m.content.slice(0, 24)}${m.toolCalls ? `[${m.toolCalls.map((c) => c.name)}]` : ""}`));
    round++;
    if (round === 1) yield { type: "tool_call", toolCall: { id: "c1", name: "shell_probe", arguments: "{}" } };
    else if (round === 2) yield { type: "tool_call", toolCall: { id: "c2", name: "reset_probe", arguments: "{}" } };
    else yield { type: "text", delta: "continuing on the fresh context" };
    yield { type: "done" };
  },
};
let hosted: HostedSession | undefined;
const midTurn: unknown[] = [];
const probe: Tool<Record<string, never>> = {
  name: "reset_probe", description: "probe", inputSchema: z.object({}), permission: "none",
  async execute(_input, ctx) {
    const live = ctx.history as ChatMessage[];
    const call = live.at(-1)?.toolCalls?.[0];
    const next: ChatMessage[] = [
      { role: "system", content: "FRESH SYSTEM" },
      { role: "user", content: "RESTART PROMPT" },
      { role: "assistant", content: "", toolCalls: call ? [call] : [] },
    ];
    live.length = 0;
    live.push(...next);
    (hosted as unknown as { historyReplaced(): void }).historyReplaced();
    const snap = (hosted as HostedSession).snapshotPage();
    midTurn.push({ since: snap.since, turn: snap.turn ?? null, messages: snap.messages.length });
    return { content: "reset done" };
  },
};
const other: Tool<Record<string, never>> = {
  name: "shell_probe", description: "probe", inputSchema: z.object({}), permission: "none",
  async execute() { return { content: "ok" }; },
};
const agent = new Agent({ model, tools: new ToolRegistry().register(other).register(probe), env: {} as never, systemPrompt: "OLD SYSTEM" });
const session = new Session(agent, "s1");
const captured: { length: number; turn: boolean }[] = [];
const persister = {
  schedule(_id: string, build: () => { messages: unknown[]; turn?: unknown }) {
    const s = build();
    captured.push({ length: s.messages.length, turn: s.turn !== undefined });
  },
  flush: () => Promise.resolve(),
};
const frames: { seq: number; update: { type: string } }[] = [];
hosted = new HostedSession("s1", session, new PermissionBroker(), undefined, {}, undefined, Date.now, { persister: persister as never });
const before = hosted.historyCut;
hosted.attach({ send: (p) => frames.push(p as never) });
hosted.prompt("t1", [{ type: "text", text: "hello" }]);
while (hosted.running) await new Promise((r) => setTimeout(r, 5));

console.log("model requests (round: history it saw):");
seen.forEach((s, i) => console.log(`  ${i + 1}: ${JSON.stringify(s)}`));
console.log("updates:", frames.map((f) => `${f.seq}:${f.update.type}`).join(" "));
console.log("epoch changed:", before.epoch !== hosted.historyCut.epoch);
console.log("snapshot taken INSIDE the turn, right after the barrier:", JSON.stringify(midTurn));
const end = hosted.snapshotPage();
console.log("final snapshot:", JSON.stringify(end.messages.map((m) => `${m.role}:${m.content.slice(0, 20)}`)));
console.log("persist captures (length, turn in record):", JSON.stringify(captured));
let state = { ...initialStream, phase: "live" as const, epoch: before.epoch, applied: 0 };
const outs: string[] = [];
for (const f of frames) {
  const step = reduceStream(state, { kind: "update", params: f as never, now: 0 });
  state = step.state as typeof state;
  outs.push(`${f.seq}:${step.out.map((o) => o.kind).join(",") || "-"}${step.effects.length ? `{${step.effects.map((e) => e.kind)}}` : ""}`);
}
console.log("reducer:", outs.join(" "), "| final phase:", state.phase, "| turn:", state.turn);
const mid = midTurn[0] as { since: { epoch: string; seq: number }; turn: string | null };
const step = reduceStream(state, { kind: "snapshot", messages: [], since: mid.since, turn: mid.turn, now: 0 });
console.log("after snapshot (turn stamp per output):",
  step.out.map((o) => (o.kind === "update" ? `${o.seq}:${o.update.type}@${o.turn}` : `${o.kind}@${"turn" in o ? o.turn : "-"}`)).join(" "));
```

Output:

```
model requests (round: history it saw):
  1: ["system:OLD SYSTEM","user:hello"]
  2: ["system:OLD SYSTEM","user:hello","assistant:[shell_probe]","tool:ok"]
  3: ["system:FRESH SYSTEM","user:RESTART PROMPT","assistant:[reset_probe]","tool:reset done"]
updates: 1:turn_start 2:tool_call 3:tool_call_update 4:tool_call 5:history_replaced 6:tool_call_update 7:agent_message_chunk 8:turn_end
epoch changed: true
snapshot taken INSIDE the turn, right after the barrier: [{"since":{"epoch":"ea3eb218-…","seq":5},"turn":null,"messages":3}]
final snapshot: ["system:FRESH SYSTEM","user:RESTART PROMPT","assistant:","tool:reset done","assistant:continuing on the fr"]
persist captures (length, turn in record): [{"length":1,"turn":false},{"length":2,"turn":true},{"length":3,"turn":true},{"length":4,"turn":true},{"length":5,"turn":true},{"length":4,"turn":true},{"length":5,"turn":false}]
reducer: 1:update 2:update 3:update 4:update 5:update{fetch_snapshot} 6:- 7:- 8:- | final phase: resyncing | turn: t1
after snapshot (turn stamp per output): reset@null 6:tool_call_update@null 7:agent_message_chunk@null 8:turn_end@null
```

Read: (1) the loop's next model round sees the replaced history — **holds**;
(2) the barrier opens a new epoch mid-turn and the client reducer resyncs on it —
**holds**; (3) persistence captures the replaced history at the next commit —
**holds**, but there is no capture *at* the barrier (fixed in Design); (4) the
barrier's cut names **no turn** (`turn: null`), so after the resync every
remaining update of the turn is stamped `@null` and `RemoteSession.route` drops
turn-scoped ones (`remote-session.ts:942-946`) — **defect to fix**: the
mid-turn barrier must name the running turn.

**Repro 2 — the skill set and the round budget (revised 2026-10-26)** (main
`5e8b538`, `.tentacle/tmp/context-reset/repro2.ts`, run with
`bun .tentacle/tmp/context-reset/repro2.ts`). The same mid-turn replacement,
plus the swap decision 11 needs: the probe also replaces the registry's `skill`
tool with one built (`createSkillTool`) over a larger list. The registry has no
replace method today, so the repro writes its private map — the one-method gap
the plan fills (`ToolRegistry.replace`). `maxIterations: 3`. Last line: the
`model_request` hook's delta after a replacement that does not shrink the
history.

```ts
import { Agent, Session, modelRequestDelta } from "../../worktrees/main-ro/packages/agent/src/index.ts";
import { type ChatMessage, type ChatRequest, PermissionBroker, type StreamEvent, type Tool } from "../../worktrees/main-ro/packages/core/src/index.ts";
import { HostedSession } from "../../worktrees/main-ro/packages/daemon/src/index.ts";
import { ToolRegistry, createSkillTool, type SkillToolEntry, type SkillBodyReader } from "../../worktrees/main-ro/packages/tools/src/index.ts";
import { z } from "../../worktrees/main-ro/packages/core/node_modules/zod";

const entry = (name: string): SkillToolEntry => ({ name, location: `/skills/${name}/SKILL.md`, dir: `/skills/${name}`, files: [], filesTruncated: false });
const readBody: SkillBodyReader = async (s) => ({ body: `body of ${s.name}`, bodyLine: 1 });

const rounds: string[] = [];
let round = 0;
const model = {
  id: "fake",
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const skill = req.tools?.find((t) => t.name === "skill");
    const en = (skill?.parameters as { properties?: { name?: { enum?: string[] } } } | undefined)?.properties?.name?.enum;
    rounds.push(`${req.tools ? "tools" : "NO-TOOLS(final)"} skill.enum=${JSON.stringify(en ?? null)} head=${req.messages.slice(0, 2).map((m) => `${m.role}:${m.content.slice(0, 14)}`).join("|")}`);
    round++;
    if (round === 1) yield { type: "tool_call", toolCall: { id: "c1", name: "shell_probe", arguments: "{}" } };
    else if (round === 2) yield { type: "tool_call", toolCall: { id: "c2", name: "reset_probe", arguments: "{}" } };
    else if (round === 3) yield { type: "tool_call", toolCall: { id: "c3", name: "skill", arguments: JSON.stringify({ name: "added-mid-session" }) } };
    else yield { type: "text", delta: "done on the fresh context" };
    yield { type: "done" };
  },
};

const registry = new ToolRegistry();
let hosted: HostedSession | undefined;
const probe: Tool<Record<string, never>> = {
  name: "reset_probe", description: "probe", inputSchema: z.object({}), permission: "none",
  async execute(_input, ctx) {
    const live = ctx.history as ChatMessage[];
    const call = live.at(-1)?.toolCalls?.[0];
    live.length = 0;
    live.push({ role: "system", content: "FRESH SYSTEM" }, { role: "user", content: "RESTART PROMPT" }, { role: "assistant", content: "", toolCalls: call ? [call] : [] });
    // The swap the plan adds as `ToolRegistry.replace` (no such method today: poke the private map).
    (registry as unknown as { tools: Map<string, Tool> }).tools.set("skill", createSkillTool([entry("old-skill"), entry("added-mid-session")], readBody) as Tool);
    (hosted as unknown as { historyReplaced(): void }).historyReplaced();
    return { content: "reset done" };
  },
};
const other: Tool<Record<string, never>> = { name: "shell_probe", description: "probe", inputSchema: z.object({}), permission: "none", async execute() { return { content: "ok" }; } };
registry.register(other).register(probe).register(createSkillTool([entry("old-skill")], readBody) as Tool);

const agent = new Agent({ model, tools: registry, env: {} as never, systemPrompt: "OLD SYSTEM", maxIterations: 3 });
const session = new Session(agent, "s1");
const ends: string[] = [];
const results: string[] = [];
hosted = new HostedSession("s1", session, new PermissionBroker(), undefined, {}, undefined, Date.now, {});
hosted.attach({
  send: (p) => {
    const u = (p as { update: { type: string; reason?: string; toolCallId?: string; content?: unknown } }).update;
    if (u.type === "turn_end") ends.push(JSON.stringify(u));
    if (u.type === "tool_call_update" && u.toolCallId === "c3") results.push(JSON.stringify(u).slice(0, 160));
  },
});
hosted.prompt("t1", [{ type: "text", text: "hello" }]);
while (hosted.running) await new Promise((r) => setTimeout(r, 5));

console.log("model rounds (maxIterations: 3):");
rounds.forEach((r, i) => console.log(`  ${i + 1}: ${r}`));
console.log("skill(added-mid-session) result update:", results.join(" ") || "(none)");
console.log("turn_end reason:", ends.join(","));
const final = hosted.snapshotPage().messages.map((m) => `${m.role}:${m.content.slice(0, 40)}`);
console.log("final history:", JSON.stringify(final));

// model_request hook delta: pre-reset count 5, post-reset history of 6 (2 carried skill rounds).
const post: ChatMessage[] = [
  { role: "system", content: "FRESH" }, { role: "user", content: "RESTART" },
  { role: "assistant", content: "", toolCalls: [] }, { role: "tool", content: "skill a", toolCallId: "x" },
  { role: "assistant", content: "", toolCalls: [] }, { role: "tool", content: "skill b", toolCallId: "y" },
];
console.log("hook new_messages after a reset (lastCount 5, 6 msgs):", JSON.stringify(modelRequestDelta(post, 5).map((m) => m.content)));
```

Output (2026-10-26):

```
model rounds (maxIterations: 3):
  1: tools skill.enum=["old-skill"] head=system:OLD SYSTEM|user:hello
  2: tools skill.enum=["old-skill"] head=system:OLD SYSTEM|user:hello
  3: tools skill.enum=["old-skill","added-mid-session"] head=system:FRESH SYSTEM|user:RESTART PROMPT
  4: NO-TOOLS(final) skill.enum=null head=system:FRESH SYSTEM|user:RESTART PROMPT
skill(added-mid-session) result update: {"type":"tool_call_update","toolCallId":"c3","status":"completed","content":[{"type":"text","text":"<skill_content name=\"added-mid-session\">\nbody of added-mi
turn_end reason: {"type":"turn_end","turnId":"t1","stopReason":"max_iterations"}
final history: ["system:FRESH SYSTEM","user:RESTART PROMPT","assistant:","tool:reset done","assistant:","tool:<skill_content name=\"added-mid-session\">","assistant:done on the fresh context"]
hook new_messages after a reset (lastCount 5, 6 msgs): ["skill b"]
```

Read: (5) the round right after the swap is offered the NEW `skill` list, with
the fresh history, and a call to the skill added mid-session validates and loads
(`<skill_content name="added-mid-session">`) — **holds**: rebuilding the tool is
not invasive (Precondition 8); (6) the turn still ends `max_iterations` after 3
rounds counted across the reset (round 4 is the no-tools final report) — today's
behaviour, **to change** (decision 13); (7) the `model_request` hook's
`new_messages` after a replacement that does not shrink the history is only the
tail (`["skill b"]`), not the fresh head — **defect to fix** (length-based delta,
`hooks.ts:263-270`).

## Implementation

*— claude-opus-5-5, 2026-10-25*
*— claude-opus-5-5, 2026-10-26* (revision: decisions 10, 11, 13; every `file:line` re-checked on main `5e8b538`)

### Load-bearing assumption *(revised 2026-10-26)*

**A reset can swap the session's whole model-facing context — the history (in
place, compaction's seam) AND the skill set (system-prompt catalog, `skill`
tool, activator) — between a tool call and the next model round, in one
synchronous stretch; the next round's request then carries exactly the new
history and the new tool list, without breaking the turn loop, the daemon's
stream barrier, persistence or a re-attach — provided the barrier names the
running turn.**

- The loop holds the caller's array and rebuilds every request from it:
  `request.messages = messages` at each iteration (`packages/agent/src/agent.ts:479-484`);
  tools see the same array (`toolContext.history: messages`, `agent.ts:392-398`);
  `Session.messages` IS that array (`session.ts:43,96`). Repro 1 round 3: proven.
- The tool list is re-read from the registry at every round
  (`tools: this.config.tools.definitions()`, `agent.ts:481`; `definitions()`
  maps the live map, `packages/tools/src/registry.ts:39-48`), and every call is
  validated against the tool held at call time (`registry.ts:56-75`). Repro 2
  round 3: the new list is offered and the new skill loads — proven.
- The daemon's cut is exact only while the history is append-only within an
  epoch (`hosted-session.ts:31-38`); a replacement must open a new epoch —
  `historyReplaced` does (`hosted-session.ts:1528-1549`; repro 1: "epoch changed:
  true") and the reducer resyncs on it (`session-reducer.ts:270-273`; repro 1).
- The one thing that does NOT hold today: `historyReplaced` writes
  `turnId: null` (`hosted-session.ts:1540`), so a mid-turn resync loses the turn
  (repro 1, last line). The fix is one expression: `turnId: this.compacting ? null : this.activeTurnId`.
- Persistence: every `persist()` is a synchronous capture (`hosted-session.ts:608-612`,
  `SessionPersister.schedule`); repro 1 shows the replaced history in the
  records that follow. The barrier adds its own capture (Design §3). The skill
  set is not persisted (it is derived from disk + the history, `skill.ts:8-11`).

### Preconditions

Verified invariants the change relies on (code unchanged `0b1d89f` → `5e8b538`,
see Context):

1. **One turn, one array.** `Session.send` → `agent.runMessages(this.messages, …)`
   (`session.ts:96`); compaction mutates the same array (`session.ts:164-165`).
2. **Tool calls run one at a time, each committed before the next**
   (`agent.ts:732-781`): a reset can be checked against "the only call of its
   message" with the round in hand (`toolCalls`, `agent.ts:487,614`).
3. **The gate runs before argument validation**: `runTool` authorizes
   (`agent.ts:912-916`) and only then `ToolRegistry.execute` validates
   (`packages/tools/src/registry.ts:56-75`). So an empty prompt would be
   *asked* before being refused — the reset's refusals must run before the gate.
4. **One agent and one registry per session in every runtime** (`createAgent`
   per session: `worker.ts:109-127`, `serve.ts:164-169`, `serve.ts:419-428`;
   in-process `inProcessAgents` `wiring.ts:328-362`; `buildAgent` creates the
   registry, `wiring.ts:179`; re-verified 7961bcc): per-session state can live on the `Agent` (as the
   gate's grants do, `permission-gate.ts:93-96`), and swapping the session's
   registry entry touches no other session. *(revised 2026-10-26: registry)*
5. **Single broker.** The gate asks through `config.requestPermission`
   (`wiring.ts:302`, re-verified 7961bcc) → the daemon's `awaitDecision` (`hosted-session.ts:405,463-533`)
   → `permission_request` to every client; no new broker, no new prompt path.
6. **Provider shape.** Compaction's `[system, user, (assistant call, tool result)*]`
   (`compact.ts:228-248`) is already sent to both providers; Anthropic moves the
   system message to `system` and merges consecutive user turns
   (`packages/providers/src/anthropic-provider.ts:294-347`). Dropping the
   reset's own assistant call leaves no orphan `tool_use`.
7. **Who builds the system prompt, per runtime** — always the process that runs
   the agent, from ITS `TentacleConfig.systemPrompt`, built once in `loadConfig`
   (`config/src/load.ts:263-290,323-330`, composed in `resolve.ts:235-252`; re-verified 7961bcc):
   - in-process worker: the main thread's resolved config, posted to the worker
     (`worker.ts:55`); the worker shares the laptop's filesystem;
   - in-process fallback (`--in-process`): `inProcessAgents(config)`, no daemon
     (`cli/src/session-jobs.ts:109-132`);
   - `serve` (phone): `serve`'s own `loadConfig` on its host (`main.ts:277-281`, `serve.ts:164-169`);
   - pod `run`/`attach`: the **pod daemon's own** `loadConfig` in the pod
     (`main.ts:274-281,346-352`); the laptop ships NO prompt to the pod
     (`podDaemonCommand`, `pod-runtime.ts:61-63`) and skills are the pod's
     (`main.ts:311-315`, `serve.ts:412-414`). Today the pod's whole system
     prompt (identity, `AGENTS.md`, catalog) is already pod-supplied.
8. **The skill set: three per-session holders, all fixed at `buildAgent` today
   — and swappable without an invasive change** *(revised 2026-10-26, decision 11)*:
   - the **catalog** in the system prompt: `renderSkillsCatalog(skills)`
     appended last (`resolve.ts:248-252`), from the one discovery at startup
     (`load.ts:297-313`; "Built once: a new skill needs a restart", `load.ts:99-103`; re-verified 7961bcc);
   - the **`skill` tool**: `createSkillTool(offeredSkills(config.skills))`
     (`wiring.ts:245-249`), an enum over the offered names (`skill.ts:220-247`)
     with its own activator (`skill.ts:228-231`); none offered → no tool;
   - the **activator** (user `/name`, compaction re-read): built at
     `wiring.ts:253-260`, held as `AgentConfig.skills` (readonly, `agent.ts:257`),
     read at `agent.ts:328` (`canActivateForUser` → the daemon's `/name` check,
     `session.ts:110-112`, `hosted-session.ts:928`), `:358` (`reloadSkills`),
     `:927` (`runUserSkill`) (re-verified 7961bcc).
   Not invasive because: the tool list is read per round (`agent.ts:536`), each
   call validates against the tool held then (`registry.ts:56-69`), a sub-agent
   copies the parent registry **at each spawn** (`subagent.ts:155-163`), and the
   registry is per session (precondition 4) — repro 2 proves it. The only gaps:
   `ToolRegistry` cannot replace or remove an entry (`register` throws on a
   duplicate, `registry.ts:15-21`), and the activator is readonly config
   (`agent.ts:257`). MCP tools never collide with the name: they are always
   `mcp__<server>__<tool>` (`packages/mcp/src/tool-adapter.ts:7,41`).
   **Host-wide, outside the session:** the user's `/name` catalog and the
   `/skills` listing are computed once per daemon (`skillCatalog` /
   `skillListing`, `wiring.ts:58-88`; `SessionHost`, `session-host.ts:201-211`)
   and sent at `initialize` / `skills/list` (`connection.ts:302,197`) — see Q1.
9. **No record-format change needed**: a reset leaves plain `ChatMessage`s; the
   daemon record stays `DAEMON_RECORD_VERSION = 5` (`persisted-session.ts:30`),
   the laptop's copy is re-read from `snapshot` after each turn
   (`local-runtime.ts:140-189`).
10. **Protocol class of the barrier**: `history_replaced` is `mandatory`
    (`protocol/src/updates.ts:235`) with `reason: z.enum(["compact"])`
    (`updates.ts:141-144`); `PROTOCOL_VERSION = 11` (`protocol/src/version.ts:7`).
11. **The round budget is one per-turn counter** *(revised 2026-10-26, decision 13)*:
    `maxIterations` is read once per turn (`agent.ts:384-385`, negative =
    unlimited), the loop is `for (let iteration = 0; iteration < maxIterations; iteration++)`
    (`agent.ts:466`), and running out gives one final no-tools report then
    `turn_end{max_iterations}` (`agent.ts:617-701`). `iteration` also feeds the
    `model_request` hook (`agent.ts:488`, `hooks.ts:685-711`). Other per-turn
    counters: `emptyRounds` (reset by any progress, `agent.ts:537-540`) and
    `hookContinues` (`turn_end` hook continues, `agent.ts:391,553`).
12. **The `model_request` hook's delta is length-based** *(revised 2026-10-26)*:
    `modelRequestDelta(messages, lastCount)` returns the whole history only when
    it shrank, else `slice(lastCount)` (`hooks.ts:263-270`), with the count per
    session (`hooks.ts:702-703`). A replacement that does not shrink the history
    yields a wrong delta (repro 2, last line). Compaction has the same exposure
    in principle; it shrinks the history in practice.
13. **`context-awareness` is NOT on main yet** *(revised 2026-10-26, decision 10)*:
    no source mentions it (`rg contextAwareness packages` → none); its decided
    contract (`docs/eval/context-awareness.md` decisions 1–3): a line
    `context: 82k / 128k tokens (64%)` once per new percentage value, appended
    to the message that crosses the step (a tool result or the user's message,
    never the system prompt), provider usage when available, the heuristic
    counter as fallback (`core/src/context.ts:10-43`); "after a compaction or a
    context reset the percentage drops and the counting restarts". It lands
    first; the executor of slice 3 re-verifies its seam before any edit.

### Design

**1. What the model sees after a reset** (pure builder `contextResetHistory`,
new `packages/agent/src/context-reset.ts`, next to `compactedHistory`):

```
[0] system     the system prompt REBUILT fresh (§4), its skills catalog from the fresh scan
[1] user       the restart message:
                 [context reset] You renewed your own context with context_reset.
                 Everything before it was discarded. Your restart prompt:
                 <restart_prompt>
                 {prompt}
                 </restart_prompt>
                 Background jobs still running (shell_output / shell_kill):     ← only if any
                 - {id}: `{command}`
                 {skills note, as compaction's skillsNote, worded for a reset}
                 {the context-awareness line for the fresh history}             ← §5c, when enabled
[2..] assistant(call) / tool(result)   one `skill` round per carried skill,
               re-read through the NEW activator (§4)
               (Agent.reloadSkills + carryOverSkills, as compaction:
               session.ts:159, compact.ts:170-188)
then           the queued steers, drained by the loop's NEXT iteration top
               (agent.ts:474-477) — user role, after the barrier, so they are
               in the new epoch and the new context.
```

User role for the restart message: it is the first non-system turn, the shape
compaction already sends; the "written by the model" marking is in the text
(the model knows it wrote it). The reset's own assistant message (with the
`context_reset` call) and everything before are discarded — no orphan call.
Jobs: `config.jobs.list()` filtered to `status === "running"` (`core/src/jobs.ts`);
exits still pending in `Agent.pendingExits` flush at the next turn's top as today
(`agent.ts:431,839-859`).

**2. Where the reset executes — the agent loop, not the tool.** The tool
`context_reset` is registered (so the model is offered it and the gate can ask
for it: `permission: "ask"`), but `runToolCalls` intercepts it by name
(`CONTEXT_RESET_TOOL_NAME`, the same kind of seam as `userSkillCall`,
`agent.ts:793-832`) when the agent has a `contextReset` config. Its `execute`
only returns an error ("handled by the agent loop") and is never reached from
the main loop; sub-agents drop the tool from their registry
(`subagent.ts:124-143`, next to `agent_task`). Order inside `runToolCalls` for
a `context_reset` call *(revised 2026-10-26: steps 4, 6, 7, 8)*:

1. `tool_start` (display row), as for any call.
2. **Refusals, before the gate** (pure `resetRefusal(...)` in `context-reset.ts`),
   each a normal error `tool` result pushed + committed (the history stays
   valid; the other calls of the round run normally):
   - not the only call of its assistant message (decision 5) — checked against
     the assistant message itself (`messages` before the call), not the calls
     still to run, so a resumed round (`agent.ts:417-419`) is judged the same;
   - `prompt` missing / not a string / blank after trim (decision 8);
   - no other tool call since the previous reset (decision 3);
   - the per-user-message cap reached, when `maxPerMessage !== -1` (decision 3).
3. `gate.authorize` (`agent.ts:912`): `tool_call` hooks, remembered grant,
   then the prompt through the single broker. Denied / unavailable / cancelled
   → the existing results (`agent.ts:917-956`). A hook that rewrote the input is
   re-checked for a non-blank `prompt`.
4. **Prepare — all I/O, no effect.** `const fresh = await unlessAborted(contextReset.refresh(), signal)`
   (§4: the rebuilt system prompt AND the freshly scanned skill set, built into
   a ready `SessionSkills { tool?, activator? }`), then
   `reloadSkills(sessionId, messages, signal, fresh.skills.activator)` — the
   active skills re-read through the NEW activator, so a skill removed from
   disk is `unavailable` exactly as compaction treats it (`agent.ts:374-376`, re-verified 7961bcc).
   A refresh that throws → error result "could not rebuild the context: …; the
   context was NOT reset" (history, skill set, counters untouched). Aborted →
   `CANCELLED_TOOL_NOTE` result (untouched); the loop top ends the turn cancelled.
5. `yield tool_result` for the call (display only, NOT pushed: the call is being
   discarded): "Context reset — continuing from the restart prompt." plus the
   skill-set change when there is one ("skills: + added-mid-session, − old-one",
   pure `skillSetDelta(before, after)` in `context-reset.ts`). Scan problems
   (`fresh.skillDiagnostics`) go to the daemon log (`BuildAgentOptions.log`,
   never the terminal — AGENTS §7), as startup prints them only before Ink
   mounts (`main.ts:316`).
6. **Commit — one synchronous stretch, no `await`:**
   `messages.length = 0; messages.push(...next)`; `this.installSkills(fresh.skills)`
   (`ToolRegistry.replace(SKILL_TOOL_NAME, tool | undefined)` + the agent's
   activator); `hooks?.forgetModelRequestBaseline(sessionId)` (precondition 12:
   the next `model_request` reports the whole fresh history as new).
7. Update the guard (§5) and restart the round budget (§5b), then
   `yield { type: "context_reset", messages: [...messages] }` — a new
   `AgentEvent`, the reset's commit point (like `history_commit`, no `await`
   between step 6 and this yield).
8. `runToolCalls` returns `"context_reset"` (its generator return value, today
   `void`) so the loop restarts the budget; the round ends (it was the only
   call); the next iteration drains steering into the new context and calls the
   model — with the new tool list (precondition 8).

**3. Daemon barrier, mid-turn** (`hosted-session.ts`):
- `drive` handles `context_reset` before `eventToUpdate`, in the same
  synchronous stretch: `this.pending = undefined; this.historyReplaced("context_reset"); this.persist(); continue;`
  (mirrors the `history_commit` branch, `hosted-session.ts:1201-1209`).
- `historyReplaced(reason)`: new epoch as today, but
  `turnId: this.compacting ? null : this.activeTurnId` (the repro's defect), and
  emits `history_replaced{ reason }`. It also records the restart message as the
  session's installed head (`compactionSummary`, `hosted-session.ts:290-295,1534`),
  so a cancel right after a reset leaves a history that does not "await an
  answer" (`awaitsAnswer`, `hosted-session.ts:1043-1046`) — same as after a
  compaction, live and after a reload (`hosted-session.ts:366-377`).
- `mapping.ts` `eventToUpdate`: `context_reset` → `null` (the barrier is the update).
- Microtask gap between step 6 and `drive` handling step 7: only microtasks
  (a transport message is a macrotask, the argument of `agent.ts:576-587`), and
  the only microtask emitter possible there is a `background_exit` (display).
  Same exposure as today's push → `history_commit`. A `session/prompt{skill}`
  from another client is a macrotask: it is checked against the activator in
  place (`hosted-session.ts:928`) and refused as busy (`:934`) — never a torn view.

**4. Fresh system prompt AND fresh skill set on every runtime (decisions 6, 7, 11), one code path** *(revised 2026-10-26)*.
- Extract the pure composition of `resolve.ts:240-252` (re-verified 7961bcc) into
  `composeSystemPrompt({ identity, agentsMd, agentsEnabled, skills })`;
  `resolveConfig` calls it (byte-identical output — pinned by the existing
  resolve tests).
- Extract skill discovery from `load.ts:297-313` (re-verified 7961bcc) into
  `discoverSkills({ launchCwd, home, configDir, packageSkillRoots, enabled })`
  → `{ skills, diagnostics }` (scan + `mergeSkills` + cap diagnostics);
  `loadConfig` calls it (same result — pinned by the existing load tests).
- New `refreshSessionContext(config, env = process.env): Promise<{ systemPrompt, skills, skillDiagnostics }>`
  in `config/src/load.ts`, the reset's one entry point:
  - identity = env `TENTACLE_SYSTEM_PROMPT` > a fresh read of
    `config.promptPath` > default (a `systemPromptFile` that is now missing
    throws, as at startup `load.ts:272-277` → the reset is refused, context kept);
  - `AGENTS.md` = a fresh `findAgentsFile(config.cwd)` + read when enabled
    (unreadable = none, as `load.ts:282-290`);
  - skills = `discoverSkills(...)` fresh — the same roots as at startup
    (`skillRoots`, `skills-scan.ts:41-89`: project `.agents/skills` up to the
    repo root, `<configDir>/skills`, `~/.agents/skills`, then each installed
    package's `join(p.dir, "skills")` — derived from `PackageInfo.dir`
    (`packages.ts:60`), not the startup `skillsDir` that exists only if the dir
    existed then, `packages.ts:215-223`), so a new `SKILL.md` and a package's
    newly created `skills/` are both found;
  - catalog = `renderSkillsCatalog(skills)`, composed by `composeSystemPrompt`.
  `TentacleConfig` gains `agentsMdEnabled`, `promptFileRequired` and
  `skillsEnabled`, so the refresh applies the startup's rules without
  re-reading `config.jsonc` (settings stay as at start — Q2).
- **The session's skill set, one builder** (`cli/src/wiring.ts`): move
  `wiring.ts:238-260` into `buildSessionSkills(skills, readSkillBody)` →
  `SessionSkills { tool?: Tool; activator?: SkillActivator }` (the
  `offeredSkills` / `slashSkills` rules unchanged). `buildAgent` uses it at
  start; the reset's `refresh` uses it on the fresh scan — the same function, so
  start and reset can never disagree.
- **Swap seam.** `ToolRegistry.replace(name, tool | undefined)`: sets or removes
  that one entry (a `tool.name !== name` throws). `Agent` keeps its activator
  in a private field initialised from `config.skills` and gains
  `installSkills(s: SessionSkills)` (replace the `skill` entry + the activator;
  synchronous). `reloadSkills` gains an optional `activator` parameter
  (default: the current one), so compaction is unchanged.
- `buildAgent` injects `contextReset: { maxPerMessage, refresh: async () => { const f = await refreshSessionContext(config); return { systemPrompt: f.systemPrompt, skills: buildSessionSkills(f.skills, readSkillBody), skillDiagnostics: f.skillDiagnostics }; } }`.
  Each runtime re-reads where it built the prompt at start: worker → laptop
  files (same filesystem); `serve` → its host; pod → the pod's own config,
  workspace and skill dirs. **No new RPC.**
- **Sub-agents.** A child spawned after the reset copies the new `skill` tool
  (`subagent.ts:155-163`); none runs during a reset (it is the only call of its
  message, and `agent_task` is a call).
- **Pod trust (AGENTS §7).** The re-read in the pod reads pod files — exactly
  what the pod daemon already read at session start (precondition 7), skills
  included (`main.ts:311-315`). The laptop contributes nothing to the pod's
  system prompt or skill set today, so a pod rewriting its `AGENTS.md` or adding
  a `SKILL.md` cannot change any laptop-owned identity: it can only change its
  own prompt, which a pod that controls its daemon can do anyway (it may send
  any `model/stream` request through the tunnel). A skill body is still read
  through the session env (the pod's filesystem, `wiring.ts:241-244`). The
  laptop-side gates are unchanged: the model key stays on the laptop, the
  permission prompt is answered on the laptop through the single broker. A
  "laptop identity prompt in pods" is a separate feature (Notes/debt).

**5. Anti-loop guard (decision 3)** — state on the `Agent` (per session,
precondition 4): `resetsThisMessage = 0`, `otherCallSinceReset = true`.
- Reset to `resetsThisMessage = 0` at each user message: a `send` with text
  (new `RunOptions.newUserMessage`, set by `Session.send` when `text !== ""` —
  covers `prompt` and a send-now successor, `hosted-session.ts:957,1137`) and at
  each drained steer (a steer is a user message). Not on a continuation (wake),
  nor on `resume`.
- Any non-reset model tool call in `runToolCalls` sets `otherCallSinceReset = true`
  (whatever its outcome). The user's `/skill` round and carried skill rounds do not.
- An accepted reset: `resetsThisMessage++`, `otherCallSinceReset = false`.
- Survives a re-attach (same daemon, same `Agent`). A `serve` reload rebuilds the
  agent: the guard restarts permissive (`0`, `true`) — at most one extra reset per
  restart, still behind the approval. Not persisted (no record change, decision 4).

**5b. Round budget restarts at a reset (decision 13)** *(revised 2026-10-26)*.
In `runMessages` (`agent.ts:466`): `let budgetFrom = 0;` and the loop becomes
`for (let iteration = 0; iteration - budgetFrom < maxIterations; iteration++)`;
`const outcome = yield* this.runToolCalls(...)` (`agent.ts:614`) and
`if (outcome === "context_reset") budgetFrom = iteration + 1;` — the next round
is round 1 of a fresh `maxIterations`. Only an **accepted** reset restarts it
(a refused, denied, failed or cancelled one returns nothing). A reset in a
resumed round (`agent.ts:418`) needs nothing: the loop starts at 0 anyway.
- `iteration` stays the turn's monotonic round index for the `model_request`
  hook (`agent.ts:488`): a hook can still tell requests of one turn apart; the
  budget is the separate `iteration - budgetFrom`.
- `emptyRounds` is already 0 (a reset is a tool call, `agent.ts:537-540`);
  `hookContinues` stays per turn (a cap on hook-driven continues, not on the
  context).
- Bound: with an unlimited cap (`maxPerMessage: -1`, the default) and
  auto-accept, a turn ends only by the model, the anti-loop rule (a real call
  between resets) or a cancel — the owner's choice (decision 13: "the anti-loop
  rule and the reset cap guard against empty loops").

**5c. Context awareness after a reset (decision 10)** *(revised 2026-10-26)*.
`context-awareness` merges first (precondition 13); this slice wires to it:
- **The counting restarts.** Whatever "last value told to the model" the
  awareness feature keeps must be forgotten at every history replacement, in
  the commit stretch (step 6). Preferred shape, handed to the
  `context-awareness` plan: derive the last value from the history (the last
  usage line in it) — then compaction, a reset, `--resume` and a `serve` reload
  all restart it with no extra state. If it is state on the `Agent`, step 6
  clears it (and `Session.compact` already must, for its own decision 1).
- **The first post-reset value reaches the model at once.** No provider usage
  exists yet for the fresh history (usage arrives at a round's `done`,
  `agent.ts:502-505`), so the restart message carries the line computed with
  the awareness feature's heuristic fallback (its decision 3) — the model
  starts the fresh context knowing it is e.g. 5 % full. From the first
  post-reset round on, provider usage drives the lines as usual: the next line
  is emitted when the percentage differs from the one in the restart message.
- **Display.** `restartPromptOf` (§9) parses only the `<restart_prompt>…</restart_prompt>`
  block, so an appended usage line never leaks into the "restart prompt" row;
  whether the TUI shows usage lines is the awareness task's decision. The
  status-bar meter drops at the next round's `usage` (§9).
- If the awareness feature is disabled, the restart message carries no line
  and nothing else changes.

**6. Approval (decision 2).** `describeToolCall` (`permission-gate.ts:36-60`)
gets a `context_reset` case: title "Reset the context (the model restarts from
its prompt)", `detail` = the restart prompt → the wire `explanation`
(`permission-map.ts:28-43`): TUI and phone show it. Options unchanged: Allow
once / Allow for the rest of this session / Deny (`permission-map.ts:16-25`).
Auto-accept passes it for an own turn (`permission-ui.ts:41-43`, not a
`hooks_trust`). "Yes, always" = the gate's per-tool grant in the agent's memory
(`permission-gate.ts:155-157,176-184`) — in a pod, pod memory, scoping only the
pod's own conversation: it creates no laptop-side lasting approval and no
allowlist entry, so §7's "no lasting approval for pod-supplied input" holds
(the laptop stores nothing for it).

**7. Protocol (decision 9).** Reuse the barrier, add a reason:
`HistoryReplacedSchema.reason: z.enum(["compact", "context_reset"])`; doc: a
`context_reset` barrier arrives INSIDE a turn and the snapshot's `turn` names
it. Class stays **mandatory** (`UPDATE_CLASS`, `updates.ts:235`): a client that
skipped it would apply the new epoch's updates over the old history (a stale
view); not `blocking` (the daemon waits on nobody); not `display` (skipping it
is not harmless). The new enum value makes an older client fail the frame
(known type, failing member = malformed → it fails and cancels the turn,
`remote-session.ts:746-752`) → **breaking → `PROTOCOL_VERSION` 11 → 12**
(pre-public: no shim, AGENTS §7), so an older TUI or phone build stops with a
clean `VersionMismatch` at `initialize`. No new field: the restart prompt
reaches clients through the snapshot every barrier already forces. Regenerate
`protocol/schema/protocol.json` (`bun run schema:export`). (If another task
bumps the version first, take the next number.)

**8. Client** (`remote-session.ts`): `compactedPending: boolean`
(`:153-154`, `:930-933`) becomes `replacedBy: "compact" | "context_reset" | null`.
In `onReset` (`:872-903`), when `replacedBy === "context_reset"` and the turn at
the cut is tracked and not ended: push a `SessionEvent` `{ type: "context_reset", messages: out.messages }`
(the snapshot) instead of `history_reset`, without setting `turn.reset` (the
screen is kept). No live turn (it ended behind the cut) → the `history`
activity with `reason: "context_reset"` (`SessionActivity` gets
`reason: "compact" | "context_reset" | null` in place of `compacted`). Fix the
stale comment in `client/src/mapping.ts:199-202`. The reducer is unchanged.

**9. TUI (decision 9)** — logic in pure modules, components only render:
- `resume.ts` `messagesToItems` (pure, `:9-53`): a user message that
  `restartPromptOf(content)` recognises (`@tentacle/agent` `context-reset.ts`,
  the same constants that build it) becomes two items: a separator notice
  `↻ context reset by the model` (`NoticeItem.separator: true`) and the prompt
  as `UserItem{ restart: true }` (label "restart prompt"). Used by `--resume`,
  every resync, and the live path below — one code path. The marker is a
  display hint only, never a decision input (the daemon's decisions stay
  structural).
- `state.ts`: `applyEvent` case `context_reset` → keep `items`, append
  `messagesToItems(event.messages)` (the separator comes with it). Serves the
  in-process fallback (AgentEvent) and the RPC path (SessionEvent) alike.
  The context meter (`lastTurnTokens.prompt`, `state.ts:302-314`,
  `App.tsx:2110`) drops at the next round's `usage`, which follows the reset in
  the same turn — no meter state of its own.
- `turn-feed.ts` `historyAction` → `"append"` for `reason: "context_reset"`
  (another device's reset whose turn ended behind a cut); `App.tsx`
  `onActivity` executes it with the same state helper.
- `render-lines.ts` `itemLines` (pure): the separator as a full-width grey rule
  around `↻ context reset by the model`; the restart user row with its
  "restart prompt" label. Components unchanged beyond the item kinds.

**10. Config (decisions 3, 12).** `contextReset: { enabled?: boolean, maxPerMessage?: int (>0 or -1) }`
in `settingsShape` (`schema.ts:154-236`, shaped like `subagents` `:187-199`,
so profiles get it), defaults `true` / `-1` (`defaults.ts` + the commented
template line), env `TENTACLE_CONTEXT_RESET` (bool) and
`TENTACLE_CONTEXT_RESET_MAX` (`parseIterationLimit`), with `sources`.
Disabled → `buildAgent` registers no tool and passes no `contextReset`
(the model is not offered it; the intercept is off). In `run`/`attach` both
keys come from the pod daemon's own config, like `maxIterations` and
`subagents` (decision 12; precondition 7) — UX, not security; the laptop-side
approval is the guard.

### Files *(revised 2026-10-26)*

In dependency order (protocol → config/tools/agent → daemon → client → cli → tui):

1. `packages/protocol/src/updates.ts` (enum + doc), `packages/protocol/src/version.ts` (12), `packages/protocol/schema/protocol.json` (regenerated).
2. `packages/config/src/resolve.ts` (`composeSystemPrompt`, `contextReset` resolution), `load.ts` (`discoverSkills`, `refreshSessionContext`, `TentacleConfig.agentsMdEnabled` / `promptFileRequired` / `skillsEnabled`), `schema.ts`, `defaults.ts`, `index.ts` (exports).
3. `packages/tools/src/registry.ts` (`replace`), `packages/tools/src/context-reset.ts` (new: tool definition + name + description per decision 8), `packages/tools/src/index.ts`.
4. `packages/agent/src/context-reset.ts` (new, pure: `contextResetHistory`, `resetRefusal`, `restartPromptOf`, `skillSetDelta`, constants), `agent.ts` (`AgentConfig.contextReset { maxPerMessage, refresh }`, the private activator + `installSkills`, `reloadSkills(…, activator?)`, `RunOptions.newUserMessage`, the intercept, the guard, `runToolCalls`' return value + the budget restart, the `context_reset` event), `hooks.ts` (`forgetModelRequestBaseline`), `session.ts` (`newUserMessage`; `compact` also forgets the hook baseline after its replacement), `permission-gate.ts` (`describeToolCall` case), `subagent.ts` (exclude the tool), `compact.ts` (parametrise `skillsNote` wording), `index.ts`. Plus the `context-awareness` seam it exposes (§5c; exact file known once it merges).
5. `packages/daemon/src/hosted-session.ts` (`drive` branch, `historyReplaced(reason)`), `mapping.ts` (`eventToUpdate`).
6. `packages/client/src/remote-session.ts`, `mapping.ts` (comment).
7. `packages/cli/src/wiring.ts` (`buildSessionSkills`, register the tool, inject `contextReset.refresh`).
8. `packages/tui/src/state.ts`, `resume.ts`, `render-lines.ts`, `turn-feed.ts`, `App.tsx` (the `history` branch only).
9. Docs: `README.md` config table, `ARCHITECTURE.md` (a barrier may now be mid-turn; the skill set is per session and renewed at a reset), `docs/feat/skills-core.md` ("a new skill needs a restart" → "or a context reset"), this doc.

### Failure modes

| Case | How state converges |
|---|---|
| Not the only call / blank prompt / no other call since the last reset / cap reached | Refused before the gate with the reason as an error `tool` result; history valid, nothing asked, counters and budget unchanged. |
| User denies; nobody can be asked (`blockingUnsupported`) | Existing gate results (`agent.ts:940-955`); history untouched. |
| Cancel while asked | `awaitDecision` settles `cancelled` (`hosted-session.ts:493`); the agent records the cancel (`agent.ts:921-923`). |
| Cancel during the refresh (a hung read in a pod) | `unlessAborted` returns at once; `CANCELLED_TOOL_NOTE`; history AND skill set untouched (nothing is installed before step 6); turn ends cancelled. |
| Refresh throws (required prompt file gone) | Error result "context NOT reset"; history, skill set, budget untouched; the model may carry on. |
| Skill scan problems (unreadable `SKILL.md`, shadowed name) *(revised 2026-10-26)* | Best-effort as at startup (`load.ts:297-299`): the skill is skipped, the rest proceeds; the problems go to the daemon log, never the terminal. |
| A skill added / removed on disk *(revised 2026-10-26)* | Added → in the fresh catalog AND the `skill` enum on the next round (repro 2). Removed but active → carried with its stored copy (`unavailable`, as compaction, `agent.ts:374-376`) and named in the skills note; its old `skill` call stays in the history although the enum no longer has it — providers do not validate past calls (compaction already sends such histories). Removed and inactive → gone from catalog and enum. |
| Skills go from none to some, or to none *(revised 2026-10-26)* | `replace` registers or removes the `skill` entry; with none the prompt is byte-identical to a no-skills start (`resolve.ts:248-252`). |
| User's `/name` list after a reset *(revised 2026-10-26)* | Host-wide, unchanged (precondition 8): a new skill is the model's at once; the user's `/new` waits for a restart; a stale `/removed` is refused by the daemon (`hosted-session.ts:928-933`, InvalidParams "unknown skill") — Q1. |
| Cancel after the replacement, before the next model call | Turn ends cancelled on the fresh history `[system, restart, skills…]`; the restart message is the installed head → `awaitsAnswer` false (no unasked send-now turn); the next user message continues in the fresh context with the fresh skill set. |
| Send-now during a reset | Its abort lands before step 6 (untouched + cancelled note) or after (fresh history and skill set); the successor starts on whichever; the queue mirror is untouched by the reset (`queue` only shifts on `steer`). |
| Steers queued during the reset | Drained after the barrier → new epoch, new context (decision 5). Steers drained EARLIER in the turn are in the discarded history: the model must carry them into its prompt (tool description says so). |
| Live client during a reset | `history_replaced{context_reset}` → resync → snapshot at a cut naming the turn → `context_reset` SessionEvent (transcript kept) → updates past the cut replay on top. |
| Client reattaching later with an old `since` (phone offline) | Other epoch → resync → plain replace with the post-reset history (separator + restart row rendered from the marker). The old transcript is only where it was seen (decision 4). |
| Gap/resync after a reset in the same turn | Ordinary `history_reset` replace with the post-reset history (the daemon's truth). |
| `serve` crash between approval and replacement | Record: turn in flight, reset call unanswered → reload closes it with `INTERRUPTED_NOTE` (`persisted-session.ts:341`); nothing was replaced; the model may call again. |
| `serve` crash after the replacement | The barrier's own capture (§3) holds the fresh history; reload rebuilds the agent from a fresh `loadConfig`, so the skill set is the disk's again — the same set the reset installed, or newer. |
| Crash while the reset waits for approval | "pending ⇒ never started": re-asked on reload (`hosted-session.ts:419-452`); the guard restarts permissive (one extra reset at most, still asked). |
| Older TUI/phone | `VersionMismatch` at `initialize` (protocol 12). |
| `context_reset` called by a sub-agent / tool disabled | Not in its registry → "unknown tool". |
| An MCP tool named like ours *(revised 2026-10-26)* | Impossible: MCP tools are `mcp__<server>__<tool>` (`mcp/src/tool-adapter.ts:41`); `replace("skill")` can only touch the built-in entry. |
| `max_iterations` *(revised 2026-10-26)* | An accepted reset restarts the budget (§5b): the fresh context gets a full `maxIterations`; running out after it gives the final no-tools report on the fresh context, as today. A refused reset does not restart it. |
| `model_request` hook right after a reset *(revised 2026-10-26)* | The baseline is forgotten at the commit: `new_messages` = the whole fresh history (today: only the tail, repro 2). |
| Context-awareness line after a reset *(revised 2026-10-26)* | Restart message carries the heuristic line; counting restarted; the next line comes from provider usage when the percentage changes (§5c). Awareness disabled → no line. |

### Tests *(revised 2026-10-26: skill set, budget, hook baseline, awareness)*

Red-before-green per slice; fakes as in the existing suites (scripted fake
`ModelProvider`, `SpyBroker`, the daemon in-memory channel, `ink-testing-library`).

- `agent/test/context-reset.test.ts` (pure): `contextResetHistory` shape
  (system first, one user restart message with prompt/jobs/skills note, skill
  rounds, no orphan call); `resetRefusal` table (sole call, blank, no other
  call, cap, `-1`); `restartPromptOf` round-trips `contextResetHistory`, ignores
  an appended usage line, returns null for a plain user message;
  `skillSetDelta` (added, removed, none).
- `tools/test/registry.test.ts`: `replace` swaps one entry (others and their
  order kept), removes with `undefined`, registers a new name, throws on a
  name mismatch.
- `agent/test/agent.test.ts`: (a) a scripted reset → the NEXT request's
  messages equal `contextResetHistory(...)` (the exact property, not "shorter");
  the fresh system prompt comes from the injected `refresh()` (a spy that
  returns a different string than the startup one); (b) `[reset, other]` in one
  message → reset refused, `other` ran, history valid; (c) two resets with no
  call in between → second refused; (d) cap 1 → second refused, a steer resets
  the count; (e) denied → history untouched; (f) abort during a hanging
  `refresh()` → turn `cancelled`, history untouched AND `tools.get("skill")` is
  still the old tool; (g) steers queued during the reset appear after the
  restart message; (h) the gate is asked with `detail` = the prompt; blank
  prompt is refused WITHOUT asking (spy broker never called — mutation: move
  the check after the gate → red); (i) **skill set**: `refresh()` returns a set
  with a new skill → the next request's `skill` enum has it and a model call to
  it loads (`<skill_content name=…>`); the enum and the fresh prompt's catalog
  name the same set (mutation: skip `installSkills` → red); a removed active
  skill is carried `unavailable`; (j) **budget** (decision 13): `maxIterations: 2`,
  rounds `[shell] [reset] [shell] [text]` → `turn_end{end_turn}` (red today:
  `max_iterations`, as repro 2); same script with a refused reset →
  `max_iterations`; (k) **hook baseline**: a `model_request` spy sees the whole
  fresh history as `new_messages` after a non-shrinking reset (red today:
  repro 2's `["skill b"]`).
- `daemon/test/history-cut.test.ts`: mid-turn barrier → new epoch, the
  snapshot right after it names the turn (`turn.turnId === t1` — red today, the
  repro's `turn: null`), and an attach with a pre-barrier `since` gets `resync`;
  the persister captured the fresh history at the barrier; `awaitsAnswer` after
  a cancel right after a reset → a send-now with delivered rows is `NoTurnRunning`.
- `daemon/test/permissions*.test.ts`: the reset's ask goes through the session's
  broker (a separate daemon-side broker spy is never called — the single-broker
  pattern).
- `client/test/remote-session*.test.ts`: `history_replaced{context_reset}`
  mid-turn → the turn's stream yields `context_reset{messages}` (not
  `history_reset`) and then the post-cut text; the turn ends normally.
- `protocol/test`: the enum value parses; `x-protocol-version` 12; schema
  export up to date.
- `config/test`: `composeSystemPrompt` keeps `resolveConfig` byte-identical;
  `discoverSkills` keeps `loadConfig`'s skills identical; `refreshSessionContext`
  on unchanged disk returns exactly `config.systemPrompt` (the exact property:
  start and reset build the same prompt), sees an edited `AGENTS.md` /
  `PROMPT.md` and a new `.agents/skills/<x>/SKILL.md` in BOTH `skills` and the
  catalog (temp dir), finds a package `skills/` dir created after the start;
  missing required prompt file throws; `contextReset` defaults/env/file/profile.
- `cli/test` (wiring): `buildSessionSkills` gives `buildAgent` the same tool
  enum and activator as today (pinned by the existing wiring tests).
- Context awareness (once merged, §5c): after a reset the restart message
  carries the heuristic line, and the first provider-driven line reports the
  new lower percentage (mutation: do not forget the last value → no line → red).
- `tui/test`: `messagesToItems` → separator + restart row; `applyEvent(context_reset)`
  keeps earlier items; `app.test.tsx` frame: old transcript, then
  `↻ context reset by the model`, then the restart prompt row (frames diffed, §1).
- E2E (`cli/test` worker or in-memory daemon + `RemoteClient`): a scripted
  reset end to end, with a skill written into a temp `.agents/skills` between
  start and reset and used right after it; then `readBack` → the laptop's saved
  copy starts with the fresh system prompt + restart message (decision 4).
- Gate before done: `bun run check` (typecheck → lint → test), baseline AGENTS §6.

### Split (L → three ordered branches, one at a time, §10) *(revised 2026-10-26)*

1. `feat/context-reset-refresh` (renamed from `-prompt`: it now refreshes the
   prompt AND the skill set) — **M · cross-module**: `composeSystemPrompt`,
   `discoverSkills`, `refreshSessionContext`, the three `TentacleConfig`
   fields, `contextReset` config keys (unused yet); `ToolRegistry.replace`;
   `buildSessionSkills` extracted in `wiring.ts`; `Agent.installSkills` +
   `reloadSkills(…, activator?)` (tested, no caller yet). No user-visible
   behaviour change (start-up output pinned byte-identical). Sonnet may execute
   (cross-module, not load-bearing); Opus reviews.
2. `feat/context-reset-barrier` — **M · load-bearing**: protocol enum + bump +
   schema, daemon mid-turn barrier (`turnId`, capture, installed head), the
   `context_reset` AgentEvent type + daemon/client/TUI handling, driven in tests
   by a fake agent event. Strong model; fresh-context Review on the cut invariant.
3. `feat/context-reset` — **M · load-bearing**: the tool, the loop intercept,
   refusals, prepare/commit with the skill swap, the guard, the budget restart,
   the hook baseline, the awareness interplay, the approval text, wiring,
   sub-agent exclusion, E2E. Strong model; fresh-context Review on the agent
   loop, the atomic swap and the single broker.

Each slice is green on its own; the feature is user-visible only after 3.
Order in the owner queue: after `context-awareness` (decision 10), before the
`maxIterations = -1` default (decision 14, its own task).

### Notes / debt

- In a pod the identity prompt is the pod's `PROMPT.md` (default if none), not
  the laptop's — true today at session start too. Putting the laptop's identity
  into pod sessions is a separate feature (it would need a laptop → pod field,
  and the pod could still override it).
- A new session (`/clear`) still uses the startup copy of the system prompt and
  skill set (`agent.ts:331-334`; `buildAgent` from the startup config); only a
  reset re-reads. Making a new session fresh too is a small follow-up — it can
  reuse `refreshSessionContext` + `buildSessionSkills` as they are.
  *(revised 2026-10-26)*
- An auto title over a reset history shows the restart header (as a
  compaction's "Summary of…" does today, `session-title.ts:43`): same class,
  not fixed here.
- No `tool_result` hooks run for the reset (no result enters the conversation).
- Handoff to the `context-awareness` plan *(revised 2026-10-26)*: keep its
  "last value told" derivable from the history (or clearable in one call), and
  expose the line builder with the heuristic counter (§5c).

### Owner answers (first plan's questions)

*— recorded by the orchestrator, 2026-10-25*

- **Q1: A** — re-read both the skills catalog and the `skill` tool list at reset (eval decision 11). Revise Design/Files/Tests accordingly; if invasive, report with evidence before code. → *Done 2026-10-26: not invasive (Precondition 8, repro 2); Design §2 steps 4–8, §4.*
- **Q2: yes** — `contextReset` keys from the pod config in run/attach (eval decision 12). → *Design §10.*
- **Q3: REJECTED recommendation** — a reset restarts the maxIterations count from zero (eval decision 13). Separately the default maxIterations becomes -1 (decision 14, own task). → *Design §5b; decision 14 not planned here.*

### Questions for the owner *(revised 2026-10-26)*

1. **Your `/name` list and the `/skills` panel after a reset.** After a reset
   the MODEL can use a skill added mid-session (decision 11). But the list of
   skills YOU can type as `/name`, and the `/skills` panel, are built once when
   tentacle starts and are shared by every session of that daemon. So after a
   reset, `/new-skill` does not autocomplete yet, and a deleted skill still
   shows (it fails with "unknown skill" if you pick it). **Recommendation:** a
   separate small task right after this one: "skills without restart for the
   user" — `/skills` and the `/name` list re-read the disk when you open them,
   with or without a reset. It is useful on its own, and it keeps this branch
   readable. The other option is to fold it in here (a protocol change on the
   skill list too).
2. **Settings at a reset.** A reset re-reads the FILES: `PROMPT.md`,
   `AGENTS.md`, every skill folder (yours, the project's, the installed
   packages' `skills/` folders). But it keeps the SETTINGS from the start:
   `config.jsonc` (`systemPromptFile`, `loadAgentsMd`, `loadSkills`) and the
   list of installed packages. A package installed mid-session therefore needs
   a restart, as its MCP servers and hooks do today. **Recommendation:** keep
   it like this. A setting changed in `config.jsonc` acts at the next start,
   for every key — not for a few keys at a reset.

### Owner answers (re-plan questions, 2026-10-26)

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

1. **CR-Q1:** the user's `/name` list and `/skills` panel stay as at startup in
   this task; a SEPARATE task right after context-reset makes skills hot-reload
   for the user too (owner: "si").
2. **CR-Q2:** a reset re-reads the FILES only; `config.jsonc` settings (and the
   installed-package list) stay as at start — a change acts at the next start,
   for every key (owner: "va bene").

## Execution

*— claude-sonnet-5-5, 2026-10-26* (slice 1 of 3: `feat/context-reset-refresh`, branch off `main` `7961bcc`)

**Gate.** Baseline (before any edit): `bun run check` = 2851 pass / 2 skip / 0 fail, typecheck clean, lint clean (484 files). After: **2883 pass / 2 skip / 0 fail** (+32 tests), typecheck clean, lint clean (486 files).

**Step 0 — premises re-verified on `7961bcc`.** All slice-1 premises hold (no STOP). Only line numbers moved (`fix/tool-duration` + `feat/context-awareness`); fixed in place above, marked "(re-verified 7961bcc)". Notable: `reloadSkills` is `agent.ts:358` (plan: 317), `AgentConfig.skills` `:257`, `canActivateForUser` `:327`, `runUserSkill`'s activator read `:927`; `resolve.ts` composition `:240-252`; `load.ts` prompt/AGENTS/skills `:272-313`; `wiring.ts` skills block `:238-260` (unchanged). Precondition 13 is obsolete (context-awareness IS on main now: `AgentConfig.contextAwareness`, `core/src/context.ts`) — slices 2–3 should re-verify its seam. **Stale for slice 3 (not touched here):** the per-round `tools: definitions()` is at `agent.ts:536` (plan: 481, still true: read per round), the iteration loop at `:523` (plan: 466), `maxIterations` read at `:438-439` (plan: 384-385).

**As built, in order.**
1. `ToolRegistry.replace(name, tool | undefined)` (`tools/src/registry.ts`): sets in place (position kept), removes with `undefined` (absent name tolerated), appends a new name, throws `tool name mismatch` when `tool.name !== name`.
2. `config/src/resolve.ts`: `composeSystemPrompt({identity, agentsMd, agentsEnabled, skills}) → {systemPrompt, agentsMdLoaded}` (the old inline block moved verbatim; `resolveConfig` calls it); new exported `agentsMdEnabled(fileConfig, env)` (as `skillsEnabled`); `ResolvedConfig.contextReset {enabled, maxPerMessage}` + `sources.contextResetEnabled/contextResetMaxPerMessage`; env `TENTACLE_CONTEXT_RESET` (bool), `TENTACLE_CONTEXT_RESET_MAX` (`parseIterationLimit`).
3. `config/src/{schema,defaults,profile}.ts`: `contextReset` key (strict; `maxPerMessage` >0 or -1), `DEFAULT_CONTEXT_RESET_ENABLED = true` / `..._MAX_PER_MESSAGE = -1`, per-key profile merge.
4. `config/src/load.ts`: `discoverSkills({launchCwd, home, configDir, packageSkillRoots, enabled})`; private helpers `readPromptFile` / `readAgentsMd` (shared by `loadConfig` and the refresh); `refreshSessionContext(config, env = process.env) → {systemPrompt, skills, skillDiagnostics}`; `TentacleConfig` gains `agentsMdEnabled`, `promptFileRequired`, `skillsEnabled`, `contextReset`. `loadConfig` calls the extracted pieces.
5. `agent/src/agent.ts`: exported `SessionSkills {tool?, activator?}`; private `activator` field (init `config.skills`; the three reads — `canActivateForUser`, `reloadSkills`, `runUserSkill` — now use it); `installSkills(s)` = `tools.replace("skill", s.tool)` + activator, synchronous.
6. `cli/src/wiring.ts`: `buildSessionSkills(skills, readBody) → SessionSkills` (the old block moved), `buildAgent` uses it; `readSkillBody` is now an exported module constant (slice 3's `refresh` needs it).

**Drift from the Implementation (nuances decided).**
- `reloadSkills(…, through?)`: the 4th parameter is `SkillActivator | null | undefined`, not just `activator?`: omitted → the installed activator; **`null` → none**. Reason: a plain default parameter would make an explicit `undefined` (the NEW set has no activator, e.g. skills disabled) silently fall back to the OLD activator. Slice 3 must pass `fresh.skills.activator ?? null`.
- `composeSystemPrompt` returns `{systemPrompt, agentsMdLoaded}` (not a bare string): `resolveConfig` needs `agentsMdLoaded` and the rule lives in one place.
- Sources: two new `sources` keys (`contextResetEnabled`, `contextResetMaxPerMessage`) — the plan said "with `sources`" without names.
- **Template line NOT added** to `DEFAULT_CONFIG_JSONC`: documenting an inert key is user-visible and misleading before slice 3; slice 3 adds the commented line (and README table).
- `buildSessionSkills` returns an activator even with zero skills (as the old code: `createSkillActivator([])`), so `Agent.config.skills` stays always set from `buildAgent` — byte-identical behaviour.
- `refreshSessionContext` takes `Pick<TentacleConfig, …>` (cwd, configDir, promptPath, promptFileRequired, agentsMdEnabled, skillsEnabled, packages) and uses `config.cwd` as the launch dir (= `loadConfig`'s `launchCwd` after `resolvePath`) and `env.HOME ?? homedir()` like `loadConfig`.
- Not added (slice 3): `contextReset` registration/injection in `buildAgent`, template line, README/ARCHITECTURE/skills-core docs.

**Red → green.** New-API tests are red by absence of the API (e.g. registry: `reg.replace is not a function`, 3 of 4 red; the 4th — name mismatch — was *vacuously green* because that TypeError text contains "named(", so I tightened the regex to `/name mismatch/`, red by assertion). The start-up pin (`wiring.test.ts` "start-up output pinned") is a characterization test: its literals were captured from the code BEFORE any edit with `.tentacle/tmp/context-reset-refresh/pin.ts` (below) and it is green before and after the refactor by construction; its non-vacuity is shown by mutation 7/10 below.

**Mutations** (each reverted; `shasum` identical to the clean implementation afterwards: agent.ts `cb9afe3f…`, load.ts `fa4922f6…`, resolve.ts `f974ea45…`, profile.ts `eff30598…`, wiring.ts `458b5dab…`, registry.ts `30718aa7…`):
1. `installSkills` without `tools.replace` → 2 red (new list not offered; empty set keeps the tool).
2. `installSkills` without the activator swap → 2 red (`canActivateForUser`; none/back).
3. `reloadSkills` ignoring `through` → 3 red.
4. refresh package roots from `p.skillsDir` (startup rule) → red "finds a package skills/ dir created after the start".
5. refresh ignoring env `TENTACLE_SYSTEM_PROMPT` → red.
6. refresh with `enabled: true` instead of the kept `skillsEnabled` → red "settings stay as at the start".
7. `buildSessionSkills` tool built from all skills (hidden one leaks into the enum) → 4 red in `wiring.test.ts`, incl. the pin.
8. `replace` = delete+set without mismatch check → 2 red (order kept; mismatch throws).
9. profile merge without `base.contextReset` → red.
10. `composeSystemPrompt` single `\n` before the catalog → 2 red (`composeSystemPrompt`, the pin).

**Tests added.** `tools/test/registry.test.ts` (4: `replace`); `config/test/session-refresh.test.ts` (9: unchanged disk ⇒ `refreshSessionContext` equals `loadConfig` exactly — prompt, skills, diagnostics; edited PROMPT/AGENTS + new skill in skills AND catalog; removed skill; package `skills/` created after start; kept opt-outs; env prompt; missing required prompt throws / defaulted falls back; `discoverSkills` disabled = no I/O, precedence+shadowing); `config/test/resolve.test.ts` (`composeSystemPrompt` ×4, `contextReset` ×3); `config/test/profile.test.ts` (1); `agent/test/install-skills.test.ts` (8: swap offers the new enum and a late skill loads; activator swap; empty set removes/restores; other tools untouched; `reloadSkills` default / explicit / unavailable / `null`); `cli/test/wiring.test.ts` (3: the pin — prompt + tool names/order + the `skill` tool's JSON, and `buildSessionSkills` with a hidden skill / none).

**Repro** (`.tentacle/tmp/context-reset-refresh/pin.ts`, run with `bun run .tentacle/tmp/context-reset-refresh/pin.ts`; output on `7961bcc` before edits = output after the refactor = the literals in the pin test):

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgent } from "../../../packages/cli/src/wiring.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";

const home = await mkdtemp(join(tmpdir(), "pin-"));
const cfgDir = join(home, "cfg");
await mkdir(cfgDir, { recursive: true });
await writeFile(join(cfgDir, "PROMPT.md"), "IDENTITY\n");
await writeFile(join(home, "AGENTS.md"), "RULES\n");
// skills alpha ("first skill") and beta ("second skill") under <home>/.agents/skills/<name>/SKILL.md
const cfg = await loadConfig({ env: { HOME: home }, configDir: cfgDir, cwd: home });
const { agent, tools } = buildAgent({ ...cfg, subagentsEnabled: true });
console.log(JSON.stringify(agent.startConversation()[0]?.content));
console.log(JSON.stringify(tools.definitions().map((d) => d.name)));
console.log(JSON.stringify(tools.definitions().find((d) => d.name === "skill")));
```

Output: `"IDENTITY\n\n# Project rules (AGENTS.md)\n\nRULES\n\n# Skills\n\nSkills are packaged instructions …<available_skills>…alpha…beta…</available_skills>\n"` · `["fs_read","fs_write","fs_edit","fs_multi_edit","shell","shell_output","shell_kill","skill","agent_task"]` · the `skill` tool JSON with `enum:["alpha","beta"]` (full text in the pin test).

**Unverified.** `refreshSessionContext` under a *pod* daemon and `serve` (different `HOME`/cwd) is exercised only through `config`-level tests; slice 3's E2E covers the wired path.

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context; slice 1 only, per *Split* item 1. Different model from the executor, claude-sonnet-5-5: a cross-model review, not just a fresh context.)

**Verdict: APPROVE-WITH-NITS** — mergeable as is. No finding blocks slice 1; findings 1 and 3 are constraints that slices 2–3 inherit, and finding 1 needs an owner decision before slice 3.

**Gate (re-run by me).** `bun run check`: typecheck clean, lint clean (486 files), **2883 pass / 2 skip / 0 fail** (2885 tests, 222 files). These are the same counts the executor reported. The 2 skips are the opt-in ones (AGENTS §6).

**Start-up byte-identical: proven independently, more strongly than the pin.** I did not rely on the pin test's literals. I built a scratch copy of the packages with the 8 changed sources restored from `7961bcc`, plus its own `node_modules/@tentacle` links. A probe confirmed that this copy runs main's code: `installSkills`/`replace` are `undefined` there. I then dumped the start-up output from both trees with `buildAgent(loadConfig(…))`: the system prompt, the FULL `tools.definitions()` JSON (names, order, every schema), `canActivateForUser` over alpha/beta/hidden/`user-invocable:false`/unknown, `skillDiagnostics`, `agentsPath` and the skill names. I ran this over 7 configs × `subagentsEnabled` true/false = 14 cases:
- full
- no skills
- blank AGENTS.md
- env opt-outs
- file opt-outs
- env prompt
- a shadowed skill

Result: `out-main.json` and `out-branch.json` are **byte-identical** (`shasum` 4767582…, 91 888 bytes). Pod / `serve` / worker / sub-agents need nothing extra. Every runtime builds its agent through the same `buildAgent` (`serve.ts:386,442`, `serve.ts:165`, `worker.ts:110`, `main.ts:640,751`), always with `createAgent(this.opts.defaultCwd)` = `config.cwd` (`session-host.ts:750`). A sub-agent copies the parent registry at each spawn (`subagent.ts:162-170`) and gets no activator of its own (`subagent.ts:178`), so both paths are covered by the same comparison. Scripts: `.tentacle/tmp/context-reset-refresh-review/{setup-main,startup}.ts` (gitignored; they are short, and their logic is described here).

**Premise table (slice-1 premises, checked on `7961bcc`).**

| Premise | Verdict |
|---|---|
| `register` throws on a duplicate (`registry.ts:15-21`) | TRUE |
| `AgentConfig.skills` readonly (`agent.ts:257`); read at `:328`, `:370` (in `reloadSkills` `:358`), `:927` | TRUE (on the branch, the only remaining read is the constructor's, `agent.ts:338`) |
| Skills block in `wiring.ts:238-260`; registry built at `:179` | TRUE |
| Composition at `resolve.ts:240-252`; discovery at `load.ts:297-313` | TRUE |
| Tool list read per round (`agent.ts:536` on main, `:570` on the branch) | TRUE |
| Sub-agent copies the registry at spawn | TRUE (`subagent.ts:162-170`) |
| `skillsDir` set only if the dir existed at start (`packages.ts:215-223`) | TRUE |
| `findAgentsFile` / `skillRoots` resolve the cwd (`load.ts:161`, `skills-scan.ts:58`), so `config.cwd` (resolved) ≡ `launchCwd` | TRUE |
| `parseIterationLimit` accepts only `>0` or `-1` (`resolve.ts:170-176`), the same rule as the schema refine | TRUE |

**Mutations (my own sample; each reverted).** Every one turned the targeted tests red:
1. Executor's #10 (one `\n` before the catalog) → 2 red (`composeSystemPrompt`, the pin).
2. Executor's #2 (`installSkills` without the activator swap) → 2 red.
3. Executor's #4 (refresh package roots from `p.skillsDir`) → red "finds a package skills/ dir created after the start".
4. Executor's #8 (`replace` = delete+set, no mismatch check) → 3 red.
5. NEW: `reloadSkills` with `through ?? this.activator` (so `null` falls back to the installed activator) → red "null → no activator at all".
6. NEW: `loadConfig` sets `agentsMdEnabled: true` as a constant → red "settings stay as at the start".
7. NEW: schema `maxPerMessage` accepts `0` → red "the schema accepts only >0 or -1".

Note on #1: the "unchanged disk" refresh test stays green under it, as expected, since start and refresh share the function. That makes the pin the real guard for the composition text. After all mutations, `shasum -c` on all 14 touched files gives **OK** against the pre-review hashes (the same as the executor's), and `git status --short` is unchanged.

**Findings.**
1. **Low — owner decision for slice 3.** `load.ts:289`: the refresh scans `join(p.dir, "skills")` of every start-up package without that package's start-up validation. At start, `loadPackage` rejects a package whole if any symlink under it points outside it (`escapingSymlink`, `packages.ts:132-185`, called at `:182`). The skill scan follows symlinked dirs (`skills-scan.ts:120,163`). So a symlink that appears under a package's `skills/` after start is followed at a reset; the same package at start would be refused. Exposure is low: the package dir is user-owned (`<configDir>/packages`), and installing a package is the trust decision. But it breaks "a reset applies the start-up's rules". **Options:**
   - (a) In `refreshSessionContext`, re-run `escapingSymlink(p.dir)` per package (bounded at 5 000 entries) and skip a failing package with a diagnostic.
   - (b) Accept it and document it.

   **Recommendation: (a)**, folded into slice 3, which already touches the refresh's wiring.
2. **Nit.** `registry.ts:36`: `replace` appends a NEW name last. A session that starts with no skills and gains one at a reset therefore gets `skill` after `agent_task` and any MCP tools, an order a fresh start would not produce. This is harmless: no consumer depends on the order, and the tool list changes anyway. Slice 3's tests should not assert start-order after a none→some reset.
3. **Constraint for slice 3, not a defect.** `agent.ts:1087`: `runTool` authorizes the tool it fetched with `get`, but then executes by NAME (`tools.execute(call.name, …)`, `:1090`, `:1140`, `:1145`), a second lookup. A `replace` between the two would run a tool other than the one approved. This is safe as long as `installSkills` is called only from the session's own loop between rounds. That holds because a reset is the only call of its message, and sub-agent registries are copies. **Slice 3 must never call `installSkills` from an RPC handler**, because peer dispatch is concurrent (AGENTS §7 "Don't serialize the RPC peer").
4. **Nit.** `resolve.ts:68` says "(not consumed yet)". Slice 3 must drop that comment, together with the deferred template line and the README row.
5. **Nit (test).** The pin pins one config. The 14-case comparison above shows the other configs match too, so adding no-skills and opt-out variants to the pin is optional.

**Attacks tried.**
1. Start-up drift on any config or runtime → none (14 cases, byte-identical).
2. Skill dedup and order, hidden and `user-invocable:false` skills → unchanged (part of the comparison).
3. AGENTS.md flags: env vs file, blank file → unchanged. The refresh skips `readAgentsMd` when disabled, while start-up always finds the file but folds it in only when enabled. The output is the same.
4. cwd divergence: is a `serve` or pod session's agent built with another cwd than the one the prompt was built from? → no, it always uses `defaultCwd` = `config.cwd`.
5. Worker: is the config posted whole, so the new booleans survive the clone? → yes (`local-runtime.ts:446`).
6. Raw terminal writes in the new code → none. `discoverSkills` and `refreshSessionContext` return diagnostics and write nothing.
7. An unknown key → still rejected. The schema stays `.strict()` (the new `contextReset` object is `.strict()` too), and `load.test.ts:107` stays green.
8. Env/schema mismatch on `maxPerMessage` → none.
9. Something printing `sources` that would now show 2 new lines (a user-visible change) → no consumer in `cli/src`.
10. A remaining direct `config.skills` read that would bypass the swapped activator → none.
11. A sub-agent sharing state with the parent → none (copies, no activator).
12. Package-dir validation at a refresh → finding 1.

**Drift items (sound for slices 2–3).**
- `reloadSkills(…, null)`: right. A plain default parameter would silently turn an explicit "none" into the OLD activator (mutation 5 proves the test guards this). In practice `buildSessionSkills` always returns an activator, even for zero skills, so `null` is defensive.
- `agentsMdLoaded` returned by `composeSystemPrompt`: keeps the rule in one place.
- Exported `readSkillBody`: needed by slice 3's `refresh`.
- Template line deferred to slice 3 (accepted by the orchestrator): right, because documenting an inert key would be misleading. Slice 3 must not forget it (finding 4).
- Slice 3 still has to prove the load-bearing mid-turn swap itself. The slice-1 tests swap only between two `run` calls; Tests (i) in the plan covers the mid-turn case.

**What holds.** No user-visible change, proven. The registry swap, the activator swap and `reloadSkills(through)` behave as specified, and their tests are non-vacuous. On an unchanged disk the refresh equals `loadConfig` exactly, and it keeps the start-up settings (Q2). The config keys are inert, with correct defaults, env, profile merge, `sources` and strict validation.

**How the executor behaved.** Accurate and honest:
- Its counts and file hashes match mine exactly.
- It caught and fixed its own vacuously-green test (the registry mismatch regex).
- It characterised the pin from the pre-edit code and stated its limits.
- It documented every drift with a reason, and flagged stale line numbers for slices 2–3 instead of silently fixing them.
- It did not run the main-vs-branch comparison over several configs that the review added, but its pin plus its mutations were sound.


### Carried to slice 3 (orchestrator, 2026-10-26)

*— claude-opus-5-5 (orchestrator), 2026-10-26*

From this Review, MANDATORY in `feat/context-reset` (slice 3): (1) a reset
re-reads package `skills/` folders WITH the same out-of-package symlink check
as start-up (`packages.ts:182`) — never a weaker path than start-up;
(3) `installSkills` is called only from the session loop between rounds,
never from an RPC handler; (4) drop the "(not consumed yet)" comment in
`resolve.ts:68`. Nit (2) (`skill` tool appended last after a reset) accepted.
